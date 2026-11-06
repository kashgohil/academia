/**
 * State-based replication on the shared Net. Each replica holds one state of a StateCrdt. A local update changes
 * only the local state. Every `period` ms each replica sends its state to a random peer, which merges it.
 * The network may delay, reorder, duplicate and lose these messages, and a partition can cut replicas off.
 *
 * A run is a list of actions, so that a demo can replay it, undo a step, and draw it.
 *
 * Full-state mode: each round, a replica sends its whole state to one random peer.
 * Delta mode (Almeida, Shoker, Baquero 2018): each round, a replica sends the random peer only the part of its state
 * that it has not sent to that peer yet, and nothing if there is no such part. This sim keeps, per peer, the last state
 * sent, and assumes that no message is lost (the paper handles loss with acknowledged delta-intervals).
 */
import { Net, type NetConfig } from "../net";
import { counterStateBytes, type StateCrdt } from "./lattice";

export type ClusterAction =
  | { k: "op"; r: number; d: number }
  | { k: "run"; ms: number }
  /** Cut replica r off from the others. */
  | { k: "cut"; r: number }
  | { k: "heal" };

export interface ClusterConfig {
  seed: number;
  n: number;
  /** Gossip period per replica (ms). */
  period: number;
  latency: NetConfig["latency"];
  dropRate: number;
  dupRate: number;
  /** Send deltas instead of full states. Needs dropRate = 0 in this sim. */
  delta: boolean;
}

export const DEFAULT_CLUSTER: ClusterConfig = { seed: 3, n: 3, period: 40, latency: { min: 4, max: 40 }, dropRate: 0, dupRate: 0, delta: false };

export interface GossipMsg<S> { s: S; entries: number }

export interface ClusterRun<S> {
  cfg: ClusterConfig;
  net: Net<GossipMsg<S>>;
  states: S[];
  values: number[];
  /** Every local update, in order. */
  ops: { r: number; d: number; t: number }[];
  /** The sum of all updates: what a correct counter must show once every replica has seen them all. */
  truth: number;
  /** Replicas cut off now (empty: connected). */
  cut: number[];
  /** Value changes per replica: [time, value]. */
  changes: [number, number][][];
  /** Bytes of state sent (full-state or delta), with 16 bytes per entry (a model input). */
  bytesSent: number;
  messagesSent: number;
}

/**
 * For a counter state: the entries of `now` that are larger than in `before`, with every other entry at 0. Joining
 * this delta into any state that already includes `before` gives the same result as joining `now`.
 */
function counterDelta<S>(now: S, before: S): { d: S; entries: number } {
  if (Array.isArray(now)) {
    const b = before as unknown as number[];
    const d = (now as unknown as number[]).map((x, i) => (x > b[i]! ? x : 0));
    return { d: d as unknown as S, entries: d.filter((x) => x > 0).length };
  }
  const o = now as unknown as { p: number[]; n: number[] }, b = before as unknown as { p: number[]; n: number[] };
  const p = counterDelta(o.p as unknown as S, b.p as unknown as S), n = counterDelta(o.n as unknown as S, b.n as unknown as S);
  return { d: { p: p.d, n: n.d } as unknown as S, entries: p.entries + n.entries };
}

export function runStateCluster<S>(crdt: StateCrdt<S, number, number>, actions: ClusterAction[], partial: Partial<ClusterConfig> = {}): ClusterRun<S> {
  const cfg = { ...DEFAULT_CLUSTER, ...partial };
  const N = cfg.n;
  const states: S[] = Array.from({ length: N }, () => crdt.init(N));
  const lastSent: S[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => crdt.init(N)));
  const changes: [number, number][][] = Array.from({ length: N }, () => [[0, 0]]);
  const ops: ClusterRun<S>["ops"] = [];
  let bytesSent = 0, messagesSent = 0;
  let cut: number[] = [];

  const set = (i: number, s: S, t: number) => {
    const before = crdt.value(states[i]!);
    states[i] = s;
    const v = crdt.value(s);
    if (v !== before) changes[i]!.push([t, v]);
  };

  const net = new Net<GossipMsg<S>>(N, { seed: cfg.seed, latency: cfg.latency, dropRate: cfg.dropRate, dupRate: cfg.dupRate }, {
    onMessage(i, m, net) {
      set(i, crdt.merge(states[i]!, m.payload.s), net.now);
    },
    onTimer(i, _tag, net) {
      const s = states[i]!;
      const send = (j: number, payload: GossipMsg<S>) => {
        net.send(i, j, payload);
        bytesSent += counterStateBytes(payload.entries);
        messagesSent++;
      };
      let j = Math.floor(net.random() * (N - 1));
      if (j >= i) j++;
      if (cfg.delta) {
        // Send only what this peer has not been sent yet, and nothing if all of it was sent before.
        const { d, entries } = counterDelta(s, lastSent[i]![j]!);
        lastSent[i]![j] = s;
        if (entries > 0) send(j, { s: d, entries });
      } else send(j, { s, entries: crdt.entries(s) });
      net.setTimer(i, cfg.period, "gossip");
    },
  });
  // Stagger the first rounds, so that replicas do not all gossip at once.
  for (let i = 0; i < N; i++) net.setTimer(i, (cfg.period * (i + 1)) / N, "gossip");

  for (const a of actions) {
    if (a.k === "op") {
      set(a.r, crdt.update(states[a.r]!, a.r, a.d, net.clock(a.r)), net.now);
      ops.push({ r: a.r, d: a.d, t: net.now });
      net.note(a.r, a.d >= 0 ? `+${a.d}` : String(a.d));
    } else if (a.k === "run") net.runUntil(net.now + a.ms);
    else if (a.k === "cut") {
      cut = [...new Set([...cut, a.r])].sort();
      const rest = Array.from({ length: N }, (_, i) => i).filter((i) => !cut.includes(i));
      net.partition([rest, ...cut.map((c) => [c])]);
    } else {
      cut = [];
      net.heal();
    }
  }
  return {
    cfg, net, states, values: states.map((s) => crdt.value(s)), ops, truth: ops.reduce((a, o) => a + o.d, 0), cut, changes, bytesSent, messagesSent,
  };
}

/** True if every replica shows the same value. */
export const agree = (run: { values: number[] }) => run.values.every((v) => v === run.values[0]);

/** The preset of the lesson: concurrent increments, a partition, updates on both sides, and a heal. */
export const PRESET_ACTIONS: ClusterAction[] = [
  { k: "op", r: 0, d: 1 }, { k: "op", r: 1, d: 1 }, { k: "op", r: 2, d: 1 }, { k: "run", ms: 120 },
  { k: "cut", r: 2 }, { k: "op", r: 0, d: 2 }, { k: "run", ms: 10 }, { k: "op", r: 2, d: 3 }, { k: "run", ms: 10 }, { k: "op", r: 1, d: -1 }, { k: "run", ms: 120 },
  { k: "heal" }, { k: "run", ms: 200 },
];

/**
 * A random workload for the size table: `opsPerReplica` increments at random times in [0, window] ms on each of
 * n replicas, then gossip until quiet. Returns the mean bytes per message.
 */
export function gossipBytes<S>(crdt: StateCrdt<S, number, number>, n: number, delta: boolean, seed = 1, opsPerReplica = 4, window = 400): { perMessage: number; total: number; messages: number; converged: boolean } {
  const actions: ClusterAction[] = [];
  // Increments at random times; the times come from a fixed generator so that full and delta see the same workload.
  let x = seed * 2654435761 >>> 0;
  const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
  const times = Array.from({ length: n * opsPerReplica }, (_, k) => ({ r: k % n, t: rnd() * window })).sort((a, b) => a.t - b.t);
  let now = 0;
  for (const { r, t } of times) {
    actions.push({ k: "run", ms: t - now }, { k: "op", r, d: 1 });
    now = t;
  }
  actions.push({ k: "run", ms: 600 });
  const run = runStateCluster(crdt, actions, { seed, n, delta, period: 40, latency: { min: 4, max: 20 } });
  return { perMessage: run.bytesSent / Math.max(1, run.messagesSent), total: run.bytesSent, messages: run.messagesSent, converged: agree(run) && run.values[0] === run.truth };
}
