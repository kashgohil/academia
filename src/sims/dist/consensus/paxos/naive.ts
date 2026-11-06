/**
 * A naive "the leader decides" protocol, to break on purpose. Node 0 is the leader. It decides its own input and
 * sends DECIDE to the others, and a follower decides the first value it gets.
 *
 * With failover on, node i that has not decided by i × timeout assumes that every lower node is dead. It decides its
 * own input and sends it. A crash, a partition or one slow message then gives two decisions. With failover off, the
 * protocol never disagrees, but a dead leader leaves everyone waiting forever. Consensus needs both properties.
 */
import { Net, type Message } from "../../net";

export type NaiveFault = "none" | "crash" | "partition" | "slow";

export interface NaiveConfig {
  n: number;
  /** One input per node. */
  inputs: string[];
  failover: boolean;
  /** Timeout step in ms: node i takes over at i × timeout. */
  timeout: number;
  fault: NaiveFault;
  /** For "slow": the extra delay of the leader's message to the last node. */
  slowBy: number;
  /** How long the run lasts, in ms. */
  horizon: number;
  seed: number;
}

export const NAIVE_DEFAULTS: NaiveConfig = { n: 3, inputs: ["A", "B", "C"], failover: true, timeout: 40, fault: "partition", slowBy: 120, horizon: 200, seed: 3 };

export interface NaiveMsg {
  k: "decide";
  v: string;
}

export interface NaiveResult {
  net: Net<NaiveMsg>;
  /** The value each node decided, or null. */
  decided: (string | null)[];
  /** When each node decided. */
  at: (number | null)[];
  /** Nodes that crashed. */
  crashed: number[];
  agreement: boolean;
  /** Every node that did not crash decided. */
  termination: boolean;
  /** Every decided value was someone's input. */
  validity: boolean;
}

export function runNaive(cfg: Partial<NaiveConfig> = {}): NaiveResult {
  const c = { ...NAIVE_DEFAULTS, ...cfg };
  const decided: (string | null)[] = Array(c.n).fill(null);
  const at: (number | null)[] = Array(c.n).fill(null);
  const decide = (net: Net<NaiveMsg>, i: number, v: string) => {
    if (decided[i] !== null) return false;
    decided[i] = v;
    at[i] = net.now;
    net.note(i, `decide ${v}`);
    return true;
  };
  const net = new Net<NaiveMsg>(c.n, { seed: c.seed, latency: { min: 8, max: 14 } }, {
    onMessage: (node, m, x) => void decide(x, node, m.payload.v),
    onTimer: (node, tag, x) => {
      if (tag === "takeover" && decided[node] === null) {
        decide(x, node, c.inputs[node]!);
        x.broadcast(node, { k: "decide", v: c.inputs[node]! });
      }
      if (tag === "slow-send") x.send(0, c.n - 1, { k: "decide", v: c.inputs[0]! });
    },
  });
  if (c.fault === "partition") net.partition([[0], Array.from({ length: c.n - 1 }, (_, i) => i + 1)]);
  // The leader decides at once and sends DECIDE to everyone.
  decide(net, 0, c.inputs[0]!);
  for (let to = 1; to < c.n; to++) {
    if (c.fault === "slow" && to === c.n - 1) net.setTimer(0, c.slowBy, "slow-send");
    else if (c.fault !== "crash") net.send(0, to, { k: "decide", v: c.inputs[0]! });
  }
  if (c.fault === "crash") net.crash(0);
  if (c.failover) for (let i = 1; i < c.n; i++) net.setTimer(i, i * c.timeout, "takeover");
  net.runUntil(c.horizon);
  const crashed = c.fault === "crash" ? [0] : [];
  const vals = new Set(decided.filter((d): d is string => d !== null));
  return {
    net, decided, at, crashed,
    agreement: vals.size <= 1,
    termination: decided.every((d, i) => d !== null || crashed.includes(i)),
    validity: [...vals].every((v) => c.inputs.includes(v)),
  };
}

export const naiveLabel = (m: Message<NaiveMsg>) => m.payload.v;
