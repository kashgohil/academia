/**
 * Hot keys: finding them with a count-min sketch or Space-Saving, and the load per shard before and after a
 * mitigation (key splitting, a cache, request coalescing, replicas of the hot shard).
 */
import { murmur3 } from "../../db/lsm/hash";
import { mulberry32 } from "../../rng";
import { Zipf, harmonic } from "./workload";

// ---------------------------------------------------------------- count-min sketch

/**
 * A count-min sketch (Cormode and Muthukrishnan 2005): d rows of w counters. An item adds to one counter per
 * row; its estimate is the smallest of its d counters. Every counter of an item holds at least its true count,
 * so the estimate never undercounts. With w = ⌈e/ε⌉ and d = ⌈ln(1/δ)⌉, the excess is at most ε·N with
 * probability 1 − δ, where N is the total count.
 */
export class CountMin {
  readonly rows: Uint32Array[];
  total = 0;
  constructor(readonly w: number, readonly d: number) {
    this.rows = Array.from({ length: d }, () => new Uint32Array(w));
  }
  private col(key: string, row: number) {
    return murmur3(key, 0x9e37 + row * 0x7f4a7c15) % this.w;
  }
  add(key: string, c = 1) {
    this.total += c;
    for (let r = 0; r < this.d; r++) this.rows[r]![this.col(key, r)]! += c;
  }
  estimate(key: string): number {
    let m = Infinity;
    for (let r = 0; r < this.d; r++) m = Math.min(m, this.rows[r]![this.col(key, r)]!);
    return m;
  }
  /** Bytes of counters (4 bytes each). */
  get bytes() {
    return this.w * this.d * 4;
  }
}

/** The sketch size for an error ε·N with probability 1 − δ. */
export const cmsSize = (eps: number, delta: number) => ({ w: Math.ceil(Math.E / eps), d: Math.ceil(Math.log(1 / delta)) });

/**
 * Top-k with a count-min sketch: after each add, the key joins the candidate set if its estimate beats the
 * smallest candidate. The set holds k keys.
 */
export class CmsTopK {
  readonly cms: CountMin;
  readonly top = new Map<string, number>();
  constructor(readonly k: number, w: number, d: number) {
    this.cms = new CountMin(w, d);
  }
  add(key: string) {
    this.cms.add(key);
    const est = this.cms.estimate(key);
    if (this.top.has(key) || this.top.size < this.k) { this.top.set(key, est); return; }
    let minKey = "", minVal = Infinity;
    for (const [k2, v] of this.top) if (v < minVal) { minVal = v; minKey = k2; }
    if (est > minVal) { this.top.delete(minKey); this.top.set(key, est); }
  }
  list(): [string, number][] {
    return [...this.top].sort((a, b) => b[1] - a[1]);
  }
}

/**
 * Space-Saving (Metwally, Agrawal and El Abbadi 2005): k counters. A new key, when all counters are taken,
 * replaces the key with the smallest count and inherits that count plus one. A monitored key's count never
 * falls below its true count, and exceeds it by at most its `err`.
 */
export class SpaceSaving {
  readonly counts = new Map<string, { n: number; err: number }>();
  constructor(readonly k: number) {}
  add(key: string) {
    const c = this.counts.get(key);
    if (c) { c.n++; return; }
    if (this.counts.size < this.k) { this.counts.set(key, { n: 1, err: 0 }); return; }
    let minKey = "", min = Infinity;
    for (const [k2, v] of this.counts) if (v.n < min) { min = v.n; minKey = k2; }
    this.counts.delete(minKey);
    this.counts.set(key, { n: min + 1, err: min });
  }
  list(): [string, number][] {
    return [...this.counts].map(([k, v]) => [k, v.n] as [string, number]).sort((a, b) => b[1] - a[1]);
  }
}

// ---------------------------------------------------------------- mitigations

export type Mitigation = "none" | "split" | "cache" | "coalesce" | "replicate";

export interface HotCfg {
  /** Distinct keys. */
  K: number;
  theta: number;
  shards: number;
  /** Requests per second for the whole table (model input). */
  rate: number;
  /** Share of requests that are reads. */
  readFrac: number;
  mitigation: Mitigation;
  /** split: sub-keys per hot key. */
  splits: number;
  /** split and cache: how many of the hottest keys it applies to. */
  hotKeys: number;
  /** coalesce: how long one backend read is in flight, in ms (model input). */
  flightMs: number;
  /** replicate: copies of the hottest shard that serve reads. */
  replicas: number;
}

export const HOT_DEFAULTS: HotCfg = { K: 10000, theta: 0.99, shards: 8, rate: 100000, readFrac: 0.9, mitigation: "none", splits: 8, hotKeys: 1, flightMs: 2, replicas: 3 };

export interface HotResult {
  /** Requests per second that reach each shard (or the busiest replica of a replicated shard). */
  perShard: number[];
  /** Backend requests per second in all, including fan-out and replica writes. */
  backend: number;
  /** Backend requests per client request. */
  amplification: number;
  /** Requests per second served without reaching a shard (cache hits and coalesced reads). */
  absorbed: number;
  /** Requests a read of a split key makes. */
  readCost: number;
}

const shardOfKey = (key: string, S: number) => murmur3(key) % S;
/** The shard of the key with popularity rank r (1 = hottest). */
export const shardOfRank = (r: number, S: number) => shardOfKey(`key:${r}`, S);

/**
 * Expected load per shard for a Zipf workload, before or after one mitigation. Keys are named by rank.
 * - split: each of the `hotKeys` hottest keys becomes `splits` sub-keys. A write goes to one random sub-key; a
 *   read must read all of them and merge.
 * - cache: reads of the `hotKeys` hottest keys hit a cache; writes still go to the shard.
 * - coalesce: concurrent reads of one key share one backend read. With Poisson arrivals at rate λ and a read in
 *   flight for T, the backend sees λ / (1 + λT): each backend read covers itself and the λT reads that arrive
 *   while it is in flight.
 * - replicate: the hottest shard gets `replicas` copies. Reads spread over them; every write goes to all.
 */
export function hotLoad(partial: Partial<HotCfg> = {}): HotResult {
  const c: HotCfg = { ...HOT_DEFAULTS, ...partial };
  const S = c.shards;
  const H = harmonic(c.K, c.theta);
  const per = new Array<number>(S).fill(0);
  let backend = 0, absorbed = 0;
  const reads = (r: number) => (c.rate * c.readFrac * Math.pow(r, -c.theta)) / H;
  const writes = (r: number) => (c.rate * (1 - c.readFrac) * Math.pow(r, -c.theta)) / H;
  // which shard is hottest before any change (for "replicate")
  const base = new Array<number>(S).fill(0);
  for (let r = 1; r <= c.K; r++) base[shardOfRank(r, S)]! += reads(r) + writes(r);
  const hottest = base.indexOf(Math.max(...base));
  for (let r = 1; r <= c.K; r++) {
    const R = reads(r), W = writes(r), s = shardOfRank(r, S);
    const hot = r <= c.hotKeys;
    if (c.mitigation === "split" && hot) {
      for (let j = 0; j < c.splits; j++) {
        const sj = shardOfKey(`key:${r}#${j}`, S);
        per[sj]! += R + W / c.splits;
        backend += R + W / c.splits;
      }
    } else if (c.mitigation === "cache" && hot) {
      per[s]! += W; backend += W; absorbed += R;
    } else if (c.mitigation === "coalesce") {
      const lam = R, T = c.flightMs / 1000;
      const sent = lam / (1 + lam * T);
      per[s]! += sent + W; backend += sent + W; absorbed += R - sent;
    } else if (c.mitigation === "replicate" && s === hottest) {
      per[s]! += R / c.replicas + W; backend += R + W * c.replicas;
    } else {
      per[s]! += R + W; backend += R + W;
    }
  }
  return { perShard: per, backend, amplification: backend / c.rate, absorbed, readCost: c.mitigation === "split" ? c.splits : 1 };
}

/** The share of all requests that go to the hottest key: 1 / H(K, θ). */
export function hottestKeyShare(K: number, theta: number) {
  return 1 / harmonic(K, theta);
}

export interface ZipfSample {
  /** Requests per shard. */
  load: number[];
  /** True count per rank. */
  truth: Map<number, number>;
  /** The sketch's top list, as [rank, estimate], highest first. */
  top: [number, number][];
  sketchBytes: number;
}

/**
 * `req` requests drawn from Zipf(θ) over K keys (named by rank), hash-partitioned over `shards`, with a
 * count-min sketch of width w and depth d that tracks the top 5.
 */
export function zipfShardSample(K: number, theta: number, shards: number, req: number, w: number, d: number, seed = 3): ZipfSample {
  const z = new Zipf(K, theta), rng = mulberry32(seed);
  const top = new CmsTopK(5, w, d);
  const truth = new Map<number, number>();
  const load = new Array<number>(shards).fill(0);
  for (let i = 0; i < req; i++) {
    const r = z.rank(rng);
    truth.set(r, (truth.get(r) ?? 0) + 1);
    load[shardOfRank(r, shards)]!++;
    top.add(`key:${r}`);
  }
  return { load, truth, top: top.list().map(([k, e]) => [Number(k.slice(4)), e]), sketchBytes: top.cms.bytes };
}
