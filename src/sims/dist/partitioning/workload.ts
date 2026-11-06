/**
 * Workloads for the partitioning lessons: uniform keys, sequential timestamps and Zipf popularity, with a seeded
 * random source. Keys are integers in [0, K); `keyName` turns one into a string for the hash functions.
 */
import { mulberry32, type Rng } from "../../rng";
import { murmur3 } from "../../db/lsm/hash";

export const keyName = (k: number) => `key:${k}`;

/** The generalized harmonic number H(K, θ) = Σ 1/rᶿ for r = 1..K. */
export function harmonic(K: number, theta: number): number {
  let h = 0;
  for (let r = 1; r <= K; r++) h += Math.pow(r, -theta);
  return h;
}

/** The share of all requests that go to the key of rank r (1 is the hottest) under Zipf(θ) over K keys. */
export const zipfShare = (r: number, K: number, theta: number, H = harmonic(K, theta)) => Math.pow(r, -theta) / H;

/** The share of the top c keys together. */
export function topShare(c: number, K: number, theta: number): number {
  const H = harmonic(K, theta);
  let s = 0;
  for (let r = 1; r <= Math.min(c, K); r++) s += Math.pow(r, -theta) / H;
  return s;
}

/**
 * A Zipf sampler over ranks 1..K by inverse CDF: a table of cumulative shares and a binary search. It is exact
 * for any θ ≥ 0 (θ = 0 is uniform). YCSB uses θ = 0.99 by default; this sampler is slower to build but simpler.
 */
export class Zipf {
  private cdf: Float64Array;
  constructor(readonly K: number, readonly theta: number) {
    this.cdf = new Float64Array(K);
    let s = 0;
    for (let r = 1; r <= K; r++) { s += Math.pow(r, -theta); this.cdf[r - 1] = s; }
    for (let i = 0; i < K; i++) this.cdf[i]! /= s;
  }
  /** A rank in 1..K. */
  rank(rng: Rng): number {
    const u = rng();
    let lo = 0, hi = this.K - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cdf[mid]! < u) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  }
}

/**
 * Where rank r lives in the key space. Popular keys are spread out, as user ids usually are, so that a hot
 * key and the next one are not neighbours. It is a fixed permutation of [0, K) built from a hash.
 */
export function rankToKey(K: number, seed = 7): Int32Array {
  const ids = Array.from({ length: K }, (_, i) => i);
  ids.sort((a, b) => murmur3(`r${a}`, seed) - murmur3(`r${b}`, seed) || a - b);
  return Int32Array.from(ids);
}

export type WorkloadKind = "uniform" | "sequential" | "zipf";

export interface WorkloadSpec {
  kind: WorkloadKind;
  /** Number of distinct keys in the key space. */
  K: number;
  /** Number of requests. */
  n: number;
  /** Zipf exponent. */
  theta?: number;
  seed?: number;
}

/**
 * A stream of keys. "sequential" models time-stamped writes: the key space holds the last K seconds of time,
 * the existing data is spread over it, and new writes take the next timestamps, which are the largest keys.
 * Here the n new writes are the n largest keys of the space, in order.
 */
export function workload({ kind, K, n, theta = 0.99, seed = 1 }: WorkloadSpec): Int32Array {
  const rng = mulberry32(seed);
  const out = new Int32Array(n);
  if (kind === "uniform") for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * K);
  else if (kind === "sequential") for (let i = 0; i < n; i++) out[i] = K - n + i;
  else {
    const z = new Zipf(K, theta);
    const where = rankToKey(K);
    for (let i = 0; i < n; i++) out[i] = where[z.rank(rng) - 1]!;
  }
  return out;
}
