/**
 * Balance and movement of the key-to-node mappings: how evenly a ring with virtual nodes splits the key space,
 * and how many keys move when the node set changes, under each scheme.
 */
import { HashRing, jumpHash, key64, keyPos, maglevTable, rendezvous } from "./hashing";

/** The Maglev table size: the paper's default, a prime. It must stay the same when backends change. */
export const MAGLEV_TABLE = 65537;
import { keyName } from "./workload";

export const nodeName = (i: number) => `n${i}`;
export const nodeNames = (n: number, from = 0) => Array.from({ length: n }, (_, i) => nodeName(from + i));

/** The n-th harmonic number 1 + 1/2 + … + 1/n. */
export const harmonicN = (n: number) => { let h = 0; for (let i = 1; i <= n; i++) h += 1 / i; return h; };

/**
 * The standard deviation of one server's share, divided by the mean share, for N servers with v random points each.
 * The N·v points cut the ring into N·v arcs whose lengths are exchangeable, so the v arcs of one server sum to a
 * Beta(v, Nv − v) share. Its variance over its squared mean is (N − 1) / (N·v + 1), which is close to 1/v.
 */
export const cvFormula = (N: number, v: number) => Math.sqrt((N - 1) / (N * v + 1));

/**
 * The expected share of the busiest server with one point each, divided by the fair share 1/N. The longest of N
 * arcs of a random circle has expected length H(N)/N, so the ratio is H(N) ≈ ln N + 0.577.
 */
export const expectedMaxOverMeanOnePoint = (N: number) => harmonicN(N);

export interface RingStats {
  /** Busiest server's share × N. */
  maxOverMean: number;
  /** Standard deviation of the shares × N. */
  cv: number;
  shares: number[];
}

/** The exact shares of a ring with N servers and v virtual nodes each. `trial` changes the server names. */
export function ringStats(N: number, v: number, trial = 0): RingStats {
  const nodes = Array.from({ length: N }, (_, i) => `t${trial}-n${i}`);
  const own = new HashRing(nodes, v).ownership();
  const shares = nodes.map((n) => own.get(n)!);
  const mean = 1 / N;
  const sd = Math.sqrt(shares.reduce((a, s) => a + (s - mean) ** 2, 0) / N);
  return { maxOverMean: Math.max(...shares) * N, cv: sd * N, shares };
}

/** Averages of ringStats over several trials. */
export function ringStatsAvg(N: number, v: number, trials: number): { maxOverMean: number; cv: number } {
  let m = 0, c = 0;
  for (let t = 0; t < trials; t++) {
    const s = ringStats(N, v, t);
    m += s.maxOverMean;
    c += s.cv * s.cv;
  }
  return { maxOverMean: m / trials, cv: Math.sqrt(c / trials) };
}

// ---------------------------------------------------------------- movement under a change of the node set

export type SchemeName = "modulo" | "ring" | "rendezvous" | "jump" | "maglev";
export type Change = "add" | "removeLast" | "removeMiddle";

/** Maps keys to node names for a list of nodes. Jump hash maps to bucket numbers; `slots` names each bucket. */
export function mapper(scheme: SchemeName, nodes: readonly string[], opts: { vnodes?: number; maglevM?: number; slots?: readonly string[] } = {}) {
  if (scheme === "modulo") return (key: string) => nodes[keyPos(key) % nodes.length]!;
  if (scheme === "ring") {
    const ring = new HashRing(nodes, opts.vnodes ?? 100);
    return (key: string) => ring.lookup(key);
  }
  if (scheme === "rendezvous") return (key: string) => rendezvous(key, nodes);
  if (scheme === "jump") {
    const slots = opts.slots ?? nodes;
    return (key: string) => { const [hi, lo] = key64(key); return slots[jumpHash(hi, lo, slots.length)]!; };
  }
  const M = opts.maglevM ?? MAGLEV_TABLE;
  const table = maglevTable(nodes, M);
  return (key: string) => nodes[table[keyPos(key) % M]!]!;
}

export interface MoveResult {
  before: Map<string, number>;
  after: Map<string, number>;
  moved: number;
  /** Keys that moved although neither their old node left nor their new node joined. */
  needless: number;
  /** The least number of keys that had to move: those of the removed node, or the new node's share. */
  minimum: number;
  keys: number;
  maxOverMeanAfter: number;
}

/**
 * Maps K keys before and after a change of an N-node cluster. "removeMiddle" removes node N/2. Jump hash can only
 * add or remove the last bucket, so to remove another node it gives that node's bucket number to the last node,
 * which is how real deployments use it.
 */
export function moveKeys(scheme: SchemeName, N: number, change: Change, K: number, opts: { vnodes?: number; maglevM?: number } = {}): MoveResult {
  const before = nodeNames(N);
  let after: string[];
  let slotsAfter: string[] | undefined;
  let removed: string | undefined, added: string | undefined;
  if (change === "add") { after = [...before, nodeName(N)]; added = nodeName(N); }
  else if (change === "removeLast") { after = before.slice(0, -1); removed = before[N - 1]; }
  else {
    const mid = Math.floor(N / 2);
    removed = before[mid];
    after = before.filter((_, i) => i !== mid);
    slotsAfter = before.slice(0, -1).map((n, i) => (i === mid ? before[N - 1]! : n));
  }
  const fB = mapper(scheme, before, opts);
  const fA = mapper(scheme, after, { ...opts, slots: slotsAfter });
  const cB = new Map<string, number>(before.map((n) => [n, 0]));
  const cA = new Map<string, number>(after.map((n) => [n, 0]));
  let moved = 0, needless = 0;
  for (let k = 0; k < K; k++) {
    const key = keyName(k);
    const a = fB(key), b = fA(key);
    cB.set(a, cB.get(a)! + 1);
    cA.set(b, cA.get(b)! + 1);
    if (a !== b) {
      moved++;
      if (a !== removed && b !== added) needless++;
    }
  }
  const minimum = added ? cA.get(added)! : cB.get(removed!)!;
  const counts = [...cA.values()];
  const maxOverMeanAfter = Math.max(...counts) / (K / counts.length);
  return { before: cB, after: cA, moved, needless, minimum, keys: K, maxOverMeanAfter };
}
