/**
 * Read your writes with a token, on the shared Net: one primary, asynchronous replicas, and one client.
 *
 * Each write on the primary gets a log sequence number (LSN). The primary streams each record to the replicas, and a
 * replica applies it after a replay delay. The client writes, keeps the LSN of its write as a token, and then reads
 * from a random replica. Modes:
 * - none: the replica answers from what it has applied. The read can miss the client's own write.
 * - wait: the replica holds the read until it has applied the token's LSN (PostgreSQL: compare the token with
 *   pg_last_wal_replay_lsn() on the standby).
 * - redirect: a replica that is behind says so, and the client reads from the primary instead.
 */
import { Net } from "../net";

export type TokenMode = "none" | "wait" | "redirect";

export interface TokenConfig {
  seed: number;
  replicas: number;
  rounds: number;
  mode: TokenMode;
  /** Mean replay delay on a replica (ms): a model input. */
  replay: number;
  /** Pause between a write and the read that follows it (ms). */
  pause: number;
}

export const DEFAULT_TOKENS: TokenConfig = { seed: 3, replicas: 2, rounds: 6, mode: "none", replay: 25, pause: 5 };

type TMsg =
  | { k: "write" }
  | { k: "lsn"; lsn: number }
  | { k: "wal"; lsn: number }
  | { k: "read"; token: number; round: number }
  | { k: "val"; lsn: number; round: number }
  | { k: "behind"; round: number };

export interface TokenRead { round: number; start: number; end: number; server: number; got: number; token: number; stale: boolean; redirected: boolean }

export interface TokenRun { cfg: TokenConfig; net: Net<TMsg>; reads: TokenRead[]; nodes: string[]; tEnd: number }

export function runTokens(partial: Partial<TokenConfig> = {}): TokenRun {
  const cfg = { ...DEFAULT_TOKENS, ...partial };
  const R = cfg.replicas, CLIENT = R + 1;
  const applied = new Array<number>(R + 1).fill(0);
  const waiting: { from: number; m: Extract<TMsg, { k: "read" }> }[][] = Array.from({ length: R + 1 }, () => []);
  let lsn = 0, round = 0, token = 0;
  const reads: TokenRead[] = [];

  const answer = (net: Net<TMsg>, s: number, from: number, m: Extract<TMsg, { k: "read" }>) => net.send(s, from, { k: "val", lsn: applied[s]!, round: m.round });
  const net = new Net<TMsg>(R + 2, { seed: cfg.seed, latency: { min: 3, max: 8 } }, {
    onMessage(node, msg, net) {
      const p = msg.payload;
      if (node === 0 && p.k === "write") {
        applied[0] = ++lsn;
        for (let r = 1; r <= R; r++) net.send(0, r, { k: "wal", lsn });
        net.send(0, msg.from, { k: "lsn", lsn });
      } else if (p.k === "wal") {
        net.setTimer(node, -Math.log(1 - net.random()) * cfg.replay, `apply${p.lsn}`);
      } else if (p.k === "read") {
        if (node === 0 || cfg.mode === "none" || applied[node]! >= p.token) answer(net, node, msg.from, p);
        else if (cfg.mode === "wait") waiting[node]!.push({ from: msg.from, m: p });
        else net.send(node, msg.from, { k: "behind", round: p.round });
      } else if (node === CLIENT) {
        const rd = reads[reads.length - 1]!;
        if (p.k === "lsn") {
          token = p.lsn;
          net.setTimer(CLIENT, cfg.pause, "read");
        } else if (p.k === "behind") {
          rd.redirected = true;
          rd.server = 0;
          net.send(CLIENT, 0, { k: "read", token, round: p.round });
        } else if (p.k === "val") {
          Object.assign(rd, { end: net.now, got: p.lsn, stale: p.lsn < rd.token });
          net.setTimer(CLIENT, 15, "write");
        }
      }
    },
    onTimer(node, tag, net) {
      if (tag.startsWith("apply")) {
        applied[node] = Math.max(applied[node]!, Number(tag.slice(5)));
        const q = waiting[node]!;
        for (let i = 0; i < q.length; ) if (applied[node]! >= q[i]!.m.token) { const w = q.splice(i, 1)[0]!; answer(net, node, w.from, w.m); } else i++;
      } else if (node === CLIENT && tag === "write") {
        if (round++ < cfg.rounds) net.send(CLIENT, 0, { k: "write" });
      } else if (node === CLIENT && tag === "read") {
        const server = 1 + Math.floor(net.random() * R);
        reads.push({ round, start: net.now, end: NaN, server, got: NaN, token, stale: false, redirected: false });
        net.send(CLIENT, server, { k: "read", token, round });
      }
    },
  });
  net.setTimer(CLIENT, 2, "write");
  net.runAll(1e5);
  const nodes = ["primary", ...Array.from({ length: R }, (_, i) => `replica ${i + 1}`), "client"];
  return { cfg, net, reads, nodes, tEnd: net.now };
}

export function tokenStats(run: TokenRun) {
  const lat = run.reads.map((r) => r.end - r.start);
  return {
    reads: run.reads.length,
    stale: run.reads.filter((r) => r.stale).length,
    redirected: run.reads.filter((r) => r.redirected).length,
    meanLatency: lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length),
    maxLatency: Math.max(0, ...lat),
  };
}
