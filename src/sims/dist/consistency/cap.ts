/**
 * The proof of Gilbert and Lynch (2002), on two replicas of one register, on the shared Net.
 *
 * Replica A and replica B hold x = 0. At time `partitionAt` the network between them fails. Client c1 writes x = 1 at
 * A, and later client c2 reads x at B. Each replica must choose:
 * - answer now from what it has (available), or
 * - wait until it hears from the other replica (consistent), which cannot happen during the partition.
 * If both answer, the read returns 0 after the write returned: not linearizable. Any other choice leaves a request
 * with no answer while the partition lasts: not available.
 */
import { Net } from "../net";
import type { HOp } from "./history";
import { checkRegister } from "./linearizability";

export type CapChoice = "answer" | "wait";

export interface CapConfig {
  write: CapChoice;
  read: CapChoice;
  /** When the partition heals (ms), or null: never in this run. */
  healAt: number | null;
  partitionAt: number;
  writeAt: number;
  readAt: number;
  tEnd: number;
  seed: number;
}

export const DEFAULT_CAP: CapConfig = { write: "answer", read: "answer", healAt: null, partitionAt: 5, writeAt: 15, readAt: 60, tEnd: 160, seed: 4 };

type CMsg =
  | { k: "w"; v: number }
  | { k: "r" }
  | { k: "ok"; v?: number }
  | { k: "sync"; v: number } // A → B: replicate
  | { k: "synced" } // B → A
  | { k: "ask" } // B → A: what is the latest value?
  | { k: "tell"; v: number };

export const A = 0, B = 1, C1 = 2, C2 = 3;
export const CAP_NODES = ["A", "B", "c1", "c2"];

export interface CapRun {
  cfg: CapConfig;
  net: Net<CMsg>;
  history: HOp[];
  /** The register check of the history (pending operations may happen or not). */
  linearizable: boolean;
  /** Every request got an answer while the partition lasted. */
  available: boolean;
  /** Time spans in which a replica held a request it could not answer. */
  waits: { node: number; from: number; until: number }[];
}

export function runCap(partial: Partial<CapConfig> = {}): CapRun {
  const cfg = { ...DEFAULT_CAP, ...partial };
  const val = [0, 0];
  const history: HOp[] = [
    { id: 0, client: 0, key: "x", f: "w", value: 1, call: cfg.writeAt, ret: Infinity },
    { id: 1, client: 1, key: "x", f: "r", call: cfg.readAt, ret: Infinity },
  ];
  const waits: CapRun["waits"] = [];
  let writeHeld = false, readHeld = false;
  const RETRY = 15;

  const net = new Net<CMsg>(4, { seed: cfg.seed, latency: { min: 4, max: 8 } }, {
    onMessage(node, msg, net) {
      const p = msg.payload;
      if (node === A && p.k === "w") {
        val[A] = p.v;
        if (cfg.write === "answer") { net.send(A, C1, { k: "ok" }); net.send(A, B, { k: "sync", v: p.v }); }
        else { writeHeld = true; waits.push({ node: A, from: net.now, until: Infinity }); net.send(A, B, { k: "sync", v: p.v }); net.setTimer(A, RETRY, "resync"); }
      } else if (node === B && p.k === "sync") {
        val[B] = p.v;
        net.send(B, A, { k: "synced" });
      } else if (node === A && p.k === "synced" && writeHeld) {
        writeHeld = false;
        waits.find((w) => w.node === A && w.until === Infinity)!.until = net.now;
        net.send(A, C1, { k: "ok" });
      } else if (node === B && p.k === "r") {
        if (cfg.read === "answer") net.send(B, C2, { k: "ok", v: val[B] });
        else { readHeld = true; waits.push({ node: B, from: net.now, until: Infinity }); net.send(B, A, { k: "ask" }); net.setTimer(B, RETRY, "reask"); }
      } else if (node === A && p.k === "ask") {
        net.send(A, B, { k: "tell", v: val[A]! });
      } else if (node === B && p.k === "tell" && readHeld) {
        readHeld = false;
        val[B] = Math.max(val[B]!, p.v);
        waits.find((w) => w.node === B && w.until === Infinity)!.until = net.now;
        net.send(B, C2, { k: "ok", v: val[B] });
      } else if (p.k === "ok") {
        const op = history[node === C1 ? 0 : 1]!;
        op.ret = net.now;
        if (op.f === "r") op.value = p.v;
      }
    },
    onTimer(_node, tag, net) {
      if (net.now > cfg.tEnd) return;
      if (tag === "resync" && writeHeld) { net.send(A, B, { k: "sync", v: val[A]! }); net.setTimer(A, RETRY, "resync"); }
      if (tag === "reask" && readHeld) { net.send(B, A, { k: "ask" }); net.setTimer(B, RETRY, "reask"); }
      if (tag === "write") net.send(C1, A, { k: "w", v: 1 });
      if (tag === "read") net.send(C2, B, { k: "r" });
    },
  });
  net.runUntil(cfg.partitionAt);
  net.partition([[A, C1, C2], [B, C1, C2]]);
  net.setTimer(C1, cfg.writeAt - cfg.partitionAt, "write");
  net.setTimer(C2, cfg.readAt - cfg.partitionAt, "read");
  if (cfg.healAt !== null) { net.runUntil(cfg.healAt); net.heal(); }
  net.runUntil(cfg.tEnd);
  const end = cfg.healAt ?? cfg.tEnd;
  return {
    cfg, net, history, waits,
    linearizable: checkRegister(history).ok === true,
    available: history.every((o) => o.ret <= end),
  };
}
