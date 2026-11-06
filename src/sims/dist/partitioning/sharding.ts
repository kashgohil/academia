/**
 * Key-range and hash partitioning of an integer key space [0, K) over N shards, the load that a workload puts on
 * each shard, and the number of shards that a range scan must visit.
 */
import { murmur3 } from "../../db/lsm/hash";
import { SPACE } from "./hashing";
import { keyName } from "./workload";

export type Scheme = "range" | "hash";

export interface Partitioner {
  scheme: Scheme;
  shards: number;
  shardOf(key: number): number;
}

/** Key-range partitioning with equal-width ranges. Shard i holds keys in [i·K/N, (i+1)·K/N). */
export function rangePartitioner(K: number, N: number): Partitioner & { bounds: number[] } {
  const bounds = Array.from({ length: N + 1 }, (_, i) => Math.round((i * K) / N));
  return {
    scheme: "range",
    shards: N,
    bounds,
    shardOf(key) {
      // binary search for the last bound <= key
      let lo = 0, hi = N - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (bounds[mid]! <= key) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

/** Hash partitioning: the 32-bit hash space is cut into N equal ranges, as Cassandra tokens or MongoDB hashed chunks do. */
export function hashPartitioner(N: number): Partitioner {
  return { scheme: "hash", shards: N, shardOf: (key) => Math.floor((murmur3(keyName(key)) * N) / SPACE) };
}

export const partitioner = (scheme: Scheme, K: number, N: number): Partitioner => (scheme === "range" ? rangePartitioner(K, N) : hashPartitioner(N));

/** Requests per shard for a stream of keys. */
export function shardLoads(p: Partitioner, keys: ArrayLike<number>): number[] {
  const load = new Array<number>(p.shards).fill(0);
  for (let i = 0; i < keys.length; i++) load[p.shardOf(keys[i]!)]!++;
  return load;
}

/** The busiest shard divided by the average shard. 1 is perfect balance; N means one shard takes everything. */
export function maxOverMean(load: readonly number[]): number {
  const total = load.reduce((a, b) => a + b, 0);
  if (total === 0) return 1;
  return Math.max(...load) / (total / load.length);
}

export interface ScanCost {
  /** Shards that hold at least one key of the range. */
  shards: number;
  /** The keys that each touched shard returns. */
  perShard: number[];
}

/** The shards that a scan of keys [from, from + len) must visit. */
export function scanCost(p: Partitioner, from: number, len: number): ScanCost {
  const perShard = new Array<number>(p.shards).fill(0);
  for (let k = from; k < from + len; k++) perShard[p.shardOf(k)]!++;
  return { shards: perShard.filter((x) => x > 0).length, perShard };
}

/**
 * The expected number of shards that a scan of `len` keys touches under hash partitioning, if each key falls in a
 * shard independently: N · (1 − (1 − 1/N)^len).
 */
export const expectedHashScanShards = (N: number, len: number) => N * (1 - Math.pow(1 - 1 / N, len));

/** Under range partitioning with ranges of width K/N, a scan of len keys touches at most ⌈len·N/K⌉ + 1 shards. */
export const maxRangeScanShards = (K: number, N: number, len: number) => Math.min(N, Math.ceil((len * N) / K) + 1);
