/**
 * Epidemic dissemination of one rumor on the shared Net (Demers et al., PODC 1987).
 *
 * Rounds are synchronous: every node acts at t = r * period, and the latency (5 to 15 ms) is much shorter than the
 * period (100 ms), so a node that learns the rumor in round r first passes it on in round r + 1. Node 0 starts with
 * the rumor at round 0. In each round every node contacts `fanout` distinct peers, chosen uniformly at random.
 *
 * - push: an informed node sends the rumor to its peers.
 * - pull: every node asks its peers; an informed peer replies with the rumor.
 * - push-pull: every node sends an exchange that carries its state, and the peer replies with its own state.
 *
 * `stopAfter` turns push into rumor mongering with feedback and a counter (Demers et al.): the receiver tells the
 * sender whether it already knew, and the sender stops after `stopAfter` such useless contacts. 0 means never stop,
 * which is how anti-entropy behaves for one rumor. A stopped rumor can leave a residue of nodes that never learn it.
 *
 * The mean-field recurrences give the expected fraction of uninformed nodes per round, for the explanation.
 */
import { Net } from "../net";

export type SpreadMode = "push" | "pull" | "push-pull";

export interface SpreadConfig {
  n: number;
  mode: SpreadMode;
  fanout: number;
  dropRate: number;
  seed: number;
  /** 0: never stop pushing. k > 0: stop after k contacts that already knew (push only). */
  stopAfter: number;
  /** Give up after this many rounds. */
  maxRounds: number;
}

export const SPREAD_DEFAULTS: SpreadConfig = { n: 64, mode: "push-pull", fanout: 1, dropRate: 0, seed: 1, stopAfter: 0, maxRounds: 80 };
export const GOSSIP_PERIOD = 100;
export const GOSSIP_LATENCY = { min: 5, max: 15 };

type GMsg = { k: "push" } | { k: "pull" } | { k: "reply"; has: boolean } | { k: "x"; has: boolean } | { k: "fb"; knew: boolean };

export interface SpreadRun {
  cfg: SpreadConfig;
  net: Net<GMsg>;
  /** The round in which each node learned the rumor (0 for the origin), or null. */
  informedAt: (number | null)[];
  /** Number of informed nodes after each round; counts[0] = 1. */
  counts: number[];
  /** First round after which every node is informed, or null. */
  roundsToAll: number | null;
  /** Rounds run (the rumor may die out before maxRounds under rumor mongering). */
  rounds: number;
  /** Fraction of nodes that never learned the rumor. */
  residue: number;
  messages: number;
  /** For each node, the node it first learned the rumor from (-1: origin or never). */
  from: number[];
}

/** k distinct peers of node i, uniform, from the run's random source. */
export function peers(rnd: () => number, i: number, n: number, k: number): number[] {
  const out: number[] = [];
  const kk = Math.min(k, n - 1);
  while (out.length < kk) {
    let j = Math.floor(rnd() * (n - 1));
    if (j >= i) j++;
    if (!out.includes(j)) out.push(j);
  }
  return out;
}

export function runSpread(partial: Partial<SpreadConfig> = {}): SpreadRun {
  const cfg = { ...SPREAD_DEFAULTS, ...partial };
  const { n, mode, fanout, stopAfter } = cfg;
  const informedAt: (number | null)[] = new Array(n).fill(null);
  const from = new Array<number>(n).fill(-1);
  const useless = new Array<number>(n).fill(0);
  const stopped = new Array<boolean>(n).fill(false);
  informedAt[0] = 0;
  let round = 0;
  let informed = 1;

  const learn = (i: number, src: number) => {
    if (informedAt[i] !== null) return false;
    informedAt[i] = round;
    from[i] = src;
    informed++;
    return true;
  };

  const net = new Net<GMsg>(n, { seed: cfg.seed, latency: GOSSIP_LATENCY, dropRate: cfg.dropRate }, {
    onMessage(i, m, nt) {
      const p = m.payload;
      const had = informedAt[i] !== null;
      if (p.k === "push") {
        learn(i, m.from);
        if (stopAfter > 0) nt.send(i, m.from, { k: "fb", knew: had });
      } else if (p.k === "pull") {
        if (had) nt.send(i, m.from, { k: "reply", has: true });
      } else if (p.k === "reply") {
        if (p.has) learn(i, m.from);
      } else if (p.k === "x") {
        if (p.has) learn(i, m.from);
        else if (had) nt.send(i, m.from, { k: "reply", has: true });
      } else if (p.k === "fb") {
        if (p.knew && ++useless[i]! >= stopAfter) stopped[i] = true;
      }
    },
  });

  const rnd = () => net.random();
  const counts = [1];
  let roundsToAll: number | null = n === 1 ? 0 : null;
  for (round = 1; round <= cfg.maxRounds && roundsToAll === null; round++) {
    net.runUntil((round - 1) * GOSSIP_PERIOD);
    // Each node acts on what it knew at the start of the round.
    const knew = informedAt.map((x) => x !== null);
    let active = 0;
    for (let i = 0; i < n; i++) {
      if (mode === "push") {
        if (!knew[i] || stopped[i]) continue;
        active++;
        for (const j of peers(rnd, i, n, fanout)) net.send(i, j, { k: "push" });
      } else if (mode === "pull") {
        active++;
        for (const j of peers(rnd, i, n, fanout)) net.send(i, j, { k: "pull" });
      } else {
        active++;
        for (const j of peers(rnd, i, n, fanout)) net.send(i, j, { k: "x", has: knew[i]! });
      }
    }
    net.runUntil(round * GOSSIP_PERIOD - 1);
    counts.push(informed);
    if (informed === n) roundsToAll = round;
    if (active === 0) break; // the rumor died out
  }
  return {
    cfg, net, informedAt, counts, roundsToAll, rounds: counts.length - 1,
    residue: (n - informed) / n, messages: net.messages.length, from,
  };
}

/**
 * Expected fraction of uninformed nodes after each round, in the mean-field limit (large n), with fanout f and
 * loss p. With q = f(1 - p) useful contacts per contact attempt:
 *   push:      s' = s * exp(-q * (1 - s))           (each informed node pushes to q peers)
 *   pull:      s' = s * (1 - (1 - s)(1 - p))^f       (all f pulls hit uninformed peers or are lost)
 *   push-pull: s' = push(s) * pull(s)                (both halves must miss)
 * With f = 1 and p = 0, pull gives s' = s², the quadratic end game.
 */
export function meanField(mode: SpreadMode, n: number, f: number, p: number, rounds: number): number[] {
  let s = 1 - 1 / n;
  const out = [s];
  for (let r = 0; r < rounds; r++) {
    const pushPart = Math.exp(-f * (1 - p) * (1 - s));
    const pullPart = (1 - (1 - s) * (1 - p)) ** f;
    s = mode === "push" ? s * pushPart : mode === "pull" ? s * pullPart : s * pushPart * pullPart;
    out.push(s);
  }
  return out;
}

/** Pittel (1987): push with fanout 1 needs log₂ n + ln n + O(1) rounds. */
export const pushRounds = (n: number) => Math.log2(n) + Math.log(n);
/** Karp et al. (2000): push-pull needs log₃ n + O(log log n) rounds. */
export const pushPullRounds = (n: number) => Math.log(n) / Math.log(3);

/** Rounds to reach all nodes, over `seeds` runs: mean, max and the fraction of runs that finished. */
export function spreadStats(cfg: Partial<SpreadConfig>, seeds: number, seed0 = 1) {
  const rs: number[] = [];
  let msgs = 0;
  let fail = 0;
  let residue = 0;
  for (let s = 0; s < seeds; s++) {
    const r = runSpread({ ...cfg, seed: seed0 + s });
    msgs += r.messages;
    residue += r.residue;
    if (r.roundsToAll === null) fail++;
    else rs.push(r.roundsToAll);
  }
  rs.sort((a, b) => a - b);
  return {
    mean: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN,
    max: rs.length ? rs[rs.length - 1]! : NaN,
    p99: rs.length ? rs[Math.min(rs.length - 1, Math.floor(0.99 * rs.length))]! : NaN,
    done: (seeds - fail) / seeds,
    msgsPerNode: msgs / seeds / (cfg.n ?? SPREAD_DEFAULTS.n),
    residue: residue / seeds,
  };
}
