/**
 * Eventual consistency by anti-entropy, on the shared Net.
 *
 * Each replica holds one last-writer-wins register: a value with a timestamp (time, origin). A write goes to one
 * replica, which sends it once to every other replica (best effort: the network may lose it), unless `direct` is off. Then anti-entropy
 * repairs what was lost: every `interval` ms each replica picks a random peer and exchanges state.
 * - push: send my state; the peer merges it.
 * - pull: ask the peer for its state, and merge the reply.
 * - push-pull: both in one exchange.
 * - off: no anti-entropy. A lost message is then never repaired, and the replicas may never converge.
 * Merging keeps the larger timestamp, so the order of delivery does not matter: the replicas converge once each has
 * seen every write.
 */
import { Net } from "../net";

export type GossipMode = "off" | "push" | "pull" | "push-pull";

export interface GossipConfig {
  seed: number;
  replicas: number;
  writes: number;
  /** Writes happen at random times in [0, writeWindow] ms. */
  writeWindow: number;
  /** Anti-entropy period per replica (ms). */
  interval: number;
  mode: GossipMode;
  dropRate: number;
  /** The replica that takes a write sends it to all others at once (true), or only anti-entropy spreads it. */
  direct: boolean;
  /** Stop the run here (ms). */
  tEnd: number;
}

export const DEFAULT_GOSSIP: GossipConfig = { seed: 1, replicas: 5, writes: 6, writeWindow: 100, interval: 60, mode: "push-pull", dropRate: 0.2, direct: true, tEnd: 1200 };

interface Stamp { t: number; origin: number; value: number }
type GMsg = { k: "write" | "push" | "pull" | "reply"; s: Stamp | null };

const newer = (a: Stamp | null, b: Stamp | null) => !!a && (!b || a.t > b.t || (a.t === b.t && a.origin > b.origin));

export interface GossipRun {
  cfg: GossipConfig;
  net: Net<GMsg>;
  /** Value changes per replica: [time, value]. Value 0 is the initial value. */
  changes: [number, number][][];
  writeTimes: number[];
  lastWrite: number;
  /** The value that wins (the largest timestamp). */
  final: number;
  /** When every replica first held the final value, or null if they never did before tEnd. */
  convergedAt: number | null;
  /** Anti-entropy messages sent after the last write. */
  messagesAfter: number;
}

export function runGossip(partial: Partial<GossipConfig> = {}): GossipRun {
  const cfg = { ...DEFAULT_GOSSIP, ...partial };
  const N = cfg.replicas;
  const state: (Stamp | null)[] = new Array(N).fill(null);
  const changes: [number, number][][] = Array.from({ length: N }, () => [[0, 0]]);
  const writeTimes: number[] = [];
  let best: Stamp | null = null;
  let convergedAt: number | null = null;

  const merge = (i: number, s: Stamp | null, now: number) => {
    if (!newer(s, state[i]!)) return;
    state[i] = s;
    changes[i]!.push([now, s!.value]);
  };
  const peer = (net: Net<GMsg>, i: number) => {
    const j = Math.floor(net.random() * (N - 1));
    return j >= i ? j + 1 : j;
  };

  const net = new Net<GMsg>(N, { seed: cfg.seed, latency: { min: 4, max: 12 }, dropRate: cfg.dropRate }, {
    onMessage(i, m, net) {
      const p = m.payload;
      if (p.k === "pull") net.send(i, m.from, { k: "reply", s: state[i]! });
      else {
        merge(i, p.s, net.now);
        if (p.k === "push" && cfg.mode === "push-pull") net.send(i, m.from, { k: "reply", s: state[i]! });
      }
    },
    onTimer(i, tag, net) {
      if (tag.startsWith("w")) {
        const s: Stamp = { t: net.now, origin: i, value: Number(tag.slice(1)) };
        if (newer(s, best)) best = s;
        merge(i, s, net.now);
        if (cfg.direct) for (let j = 0; j < N; j++) if (j !== i) net.send(i, j, { k: "write", s });
        return;
      }
      if (tag !== "ae" || cfg.mode === "off" || net.now > cfg.tEnd) return;
      const j = peer(net, i);
      net.send(i, j, cfg.mode === "pull" ? { k: "pull", s: null } : { k: "push", s: state[i]! });
      net.setTimer(i, cfg.interval, "ae");
    },
  });

  for (let w = 1; w <= cfg.writes; w++) {
    const t = net.random() * cfg.writeWindow;
    writeTimes.push(t);
    net.setTimer(Math.floor(net.random() * N), t, `w${w}`);
  }
  for (let i = 0; i < N; i++) net.setTimer(i, net.random() * cfg.interval, "ae");
  const lastWrite = Math.max(...writeTimes);
  // Step through the run and note the first moment when every replica holds the winner.
  while (net.step()) {
    if (net.now > cfg.tEnd) break;
    if (convergedAt === null && net.now >= lastWrite && best && state.every((s) => s === best)) convergedAt = net.now;
  }
  const messagesAfter = net.messages.filter((m) => m.sentAt > lastWrite && m.payload.k !== "write").length;
  return { cfg, net, changes, writeTimes, lastWrite, final: best ? (best as Stamp).value : 0, convergedAt, messagesAfter };
}

/** Mean time from the last write to convergence over seeds, and how many runs never converged. */
export function convergenceStats(cfg: Partial<GossipConfig>, seeds: number): { mean: number; p90: number; never: number } {
  const xs: number[] = [];
  let never = 0;
  for (let s = 1; s <= seeds; s++) {
    const r = runGossip({ ...cfg, seed: s });
    if (r.convergedAt === null) never++;
    else xs.push(r.convergedAt - r.lastWrite);
  }
  xs.sort((a, b) => a - b);
  return { mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN, p90: xs.length ? xs[Math.floor(0.9 * (xs.length - 1))]! : NaN, never };
}
