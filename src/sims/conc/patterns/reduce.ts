/**
 * Map and reduce.
 *
 * 1. Floating-point sums. `chunkedSum` sums float32 values the way a parallel reduction does: P contiguous chunks,
 *    each summed in order, then the P partial sums combined in a line or in a tree. Every add rounds to float32
 *    (Math.fround), so the result depends on P and on the combine order. `referenceSum` is a compensated float64 sum.
 * 2. Combine strategies on the shared Runtime (`runReduction`): one shared accumulator updated per item (an atomic
 *    add: the accumulator's cache line moves on each update, modelled as a spinning mutex with handoff), per-thread
 *    partials combined one by one under a lock, or per-thread partials combined in a tree of joins.
 * 3. Key skew in the shuffle of a MapReduce job (`shuffleLoad`): records with Zipf-distributed keys, hash-partitioned to
 *    R reducers, with or without a map-side combiner.
 *
 * Costs in ns are MODEL INPUTS (see REDUCE_DEFAULTS).
 */
import { mulberry32 } from "../../rng";
import { Runtime, type RunResult, type ThreadId } from "../runtime";

// ---------------------------------------------------------------- floating-point sums

/** n float32 values, uniform in [0, 1), from a seed. */
export function makeValues(n: number, seed = 1): Float32Array {
  const r = mulberry32(seed);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = r();
  return v;
}

/** A float64 sum with Neumaier compensation: the reference value. */
export function referenceSum(v: ArrayLike<number>): number {
  let s = 0, c = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return s + c;
}

export type Combine = "linear" | "tree";

/** Float32 sum of v[lo, hi) in order, optionally with Kahan compensation (also in float32). */
export function sumRange(v: Float32Array, lo: number, hi: number, kahan = false): number {
  const f = Math.fround;
  let s = 0, c = 0;
  for (let i = lo; i < hi; i++) {
    if (kahan) {
      const y = f(v[i]! - c);
      const t = f(s + y);
      c = f(f(t - s) - y);
      s = t;
    } else s = f(s + v[i]!);
  }
  return s;
}

/** The P partial sums of P contiguous chunks. */
export function partials(v: Float32Array, P: number, kahan = false): number[] {
  const out: number[] = [];
  for (let k = 0; k < P; k++) out.push(sumRange(v, Math.floor((k * v.length) / P), Math.floor(((k + 1) * v.length) / P), kahan));
  return out;
}

/** Combines partial sums in float32: left to right, or pairwise in a tree. */
export function combine(parts: number[], how: Combine): number {
  const f = Math.fround;
  if (how === "linear") return parts.reduce((a, b) => f(a + b), 0);
  let level = parts.slice();
  while (level.length > 1) {
    const next: number[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? f(level[i]! + level[i + 1]!) : level[i]!);
    level = next;
  }
  return level[0] ?? 0;
}

export const chunkedSum = (v: Float32Array, P: number, how: Combine = "tree", kahan = false) => combine(partials(v, P, kahan), how);

/** A fully pairwise float32 sum (P = n with a tree): the most accurate plain order. */
export const pairwiseSum = (v: Float32Array) => combine(Array.from(v), "tree");

// ---------------------------------------------------------------- combine strategies on the Runtime

export type Strategy = "shared" | "linear" | "tree";

export interface ReduceConfig {
  strategy: Strategy;
  threads: number;
  /** Items in total. */
  n: number;
  /** Map work per item (model input). */
  itemNs: number;
  /** Values in one partial result: 1 for a sum, many for a histogram or a map. */
  partialSize: number;
  /** Cost to merge one value of a partial into another (model input). */
  mergeNs: number;
  seed: number;
  record: boolean;
}

export const REDUCE_DEFAULTS: ReduceConfig = { strategy: "tree", threads: 8, n: 65_536, itemNs: 20, partialSize: 1, mergeNs: 2, seed: 1, record: true };

export interface ReduceResult {
  run: RunResult;
  makespan: number;
  /** One thread, no reduction overhead: n × itemNs. */
  serialNs: number;
  speedup: number;
  /** Time from the end of the last map work to the end. */
  combineNs: number;
}

export function runReduction(cfg: Partial<ReduceConfig> = {}): ReduceResult {
  const c: ReduceConfig = { ...REDUCE_DEFAULTS, ...cfg };
  const P = Math.max(1, Math.floor(c.threads));
  const rt = new Runtime({ cores: P, seed: c.seed, record: c.record });
  const merge = c.partialSize * c.mergeNs;
  const chunk = (k: number) => Math.floor(((k + 1) * c.n) / P) - Math.floor((k * c.n) / P);
  let mapEnd = 0;
  if (c.strategy === "shared") {
    // An atomic add per item: the accumulator's line moves to the core that adds (lockNs + transferNs), one at a time.
    const acc = rt.mutex("acc", { wait: "spin", handoff: true });
    for (let k = 0; k < P; k++) {
      rt.spawn(`T${k}`, function* (t) {
        for (let i = 0; i < chunk(k); i++) {
          yield* t.work(c.itemNs, "map");
          yield* t.lock(acc);
          t.unlock(acc);
        }
        mapEnd = Math.max(mapEnd, t.now());
      });
    }
  } else if (c.strategy === "linear") {
    // A spin lock: the threads that finish together merge one after another.
    const acc = rt.mutex("acc", { wait: "spin" });
    for (let k = 0; k < P; k++) {
      rt.spawn(`T${k}`, function* (t) {
        yield* t.work(chunk(k) * c.itemNs, "map");
        mapEnd = Math.max(mapEnd, t.now());
        yield* t.lock(acc);
        yield* t.work(merge, "merge");
        t.unlock(acc);
      });
    }
  } else {
    const ids: ThreadId[] = [];
    for (let k = 0; k < P; k++) {
      ids.push(rt.spawn(`T${k}`, function* (t) {
        yield* t.work(chunk(k) * c.itemNs, "map");
        mapEnd = Math.max(mapEnd, t.now());
        // Level s: thread k (a multiple of 2s) waits for thread k + s and merges its partial.
        for (let s = 1; s < P; s *= 2) {
          if (k % (2 * s) !== 0) return;
          if (k + s < P) {
            yield* t.join(ids[k + s]!);
            yield* t.work(merge, "merge");
          }
        }
      }));
    }
  }
  const run = rt.run();
  const serialNs = c.n * c.itemNs;
  return { run, makespan: run.makespan, serialNs, speedup: serialNs / run.makespan, combineNs: run.makespan - mapEnd };
}

// ---------------------------------------------------------------- skew in the shuffle

export interface ShuffleConfig {
  records: number;
  keys: number;
  /** Zipf exponent: 0 is uniform; 1 is typical for word counts. */
  zipf: number;
  reducers: number;
  mappers: number;
  combiner: boolean;
  seed: number;
}

export const SHUFFLE_DEFAULTS: ShuffleConfig = { records: 100_000, keys: 1_000, zipf: 1, reducers: 8, mappers: 16, combiner: false, seed: 1 };

export interface ShuffleResult {
  /** Records that each reducer receives. */
  load: number[];
  max: number;
  mean: number;
  /** max / mean: 1 is perfect balance. */
  imbalance: number;
  /** Records with the most frequent key, before any combiner. */
  hottest: number;
  /** Total records received by reducers. */
  total: number;
  /** Speedup of the reduce phase over one reducer that gets every record: total / max. */
  speedup: number;
}

/** A fixed integer hash (a 32-bit mix), so that the key-to-reducer map does not depend on key order. */
export const hashKey = (k: number) => {
  let h = Math.imul(k ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

export function shuffleLoad(cfg: Partial<ShuffleConfig> = {}): ShuffleResult {
  const c: ShuffleConfig = { ...SHUFFLE_DEFAULTS, ...cfg };
  const rng = mulberry32(c.seed);
  const cdf = new Float64Array(c.keys);
  let z = 0;
  for (let k = 0; k < c.keys; k++) cdf[k] = z += 1 / Math.pow(k + 1, c.zipf);
  const counts = new Int32Array(c.keys);
  const load = new Array<number>(c.reducers).fill(0);
  const per = Math.ceil(c.records / c.mappers);
  for (let m = 0; m < c.mappers; m++) {
    const seen = new Set<number>();
    for (let i = m * per; i < Math.min(c.records, (m + 1) * per); i++) {
      const u = rng() * z;
      let lo = 0, hi = c.keys - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid]! < u) lo = mid + 1;
        else hi = mid;
      }
      counts[lo]!++;
      if (c.combiner) seen.add(lo);
      else load[hashKey(lo) % c.reducers]!++;
    }
    // A combiner sends one record per distinct key from each mapper.
    for (const k of seen) load[hashKey(k) % c.reducers]!++;
  }
  const total = load.reduce((a, b) => a + b, 0);
  const max = Math.max(...load);
  const mean = total / c.reducers;
  return { load, max, mean, imbalance: max / mean, hottest: Math.max(...counts), total, speedup: total / max };
}
