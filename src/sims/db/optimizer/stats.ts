/**
 * Column statistics and selectivity estimation, as ANALYZE and the planner use them.
 *
 * - skewedColumn(): a deterministic, skewed integer column (order amounts with price-point spikes)
 * - sampleRows(): a uniform random sample (PostgreSQL samples 300 × statistics_target rows)
 * - equiWidth() / equiDepth(): histograms, with uniform spread inside each bucket
 * - mcvList(): most-common values; the histogram then covers only the other rows (as in pg_stats)
 * - estimateRange(): rows for `lo <= x AND x <= hi` from a histogram (+ MCV list)
 * - qError(): max(est/true, true/est), the standard error measure for cardinality estimates
 * - duj1(): the Haas–Stokes "Duj1" distinct-count estimator that ANALYZE uses for n_distinct
 * - HyperLogLog: a distinct-count sketch with error about 1.04 / sqrt(m)
 */
import { mulberry32, normal, type Rng } from "../../rng";

export const DOMAIN = 1000;

/** Order amounts 0..999: a log-normal body plus spikes at price points 0, 99, 199 and 499. */
export function skewedColumn(n = 100000, seed = 7, mu = 3.0, sigma = 1.2): Int32Array {
  const rng = mulberry32(seed);
  const out = new Int32Array(n);
  const spikes: [number, number][] = [[0, 0.06], [99, 0.08], [199, 0.05], [499, 0.04]];
  for (let i = 0; i < n; i++) {
    const u = rng();
    let acc = 0, v = -1;
    for (const [val, f] of spikes) { acc += f; if (u < acc) { v = val; break; } }
    if (v < 0) {
      do v = Math.floor(Math.exp(mu + sigma * normal(rng))); while (v < 1 || v >= DOMAIN);
    }
    out[i] = v;
  }
  return out;
}

/** Exact counts per value. */
export function valueCounts(values: ArrayLike<number>, domain = DOMAIN): Float64Array {
  const c = new Float64Array(domain);
  for (let i = 0; i < values.length; i++) c[values[i]!]!++;
  return c;
}

export function trueRange(counts: Float64Array, lo: number, hi: number): number {
  let s = 0;
  for (let v = Math.max(0, lo); v <= Math.min(counts.length - 1, hi); v++) s += counts[v]!;
  return s;
}

/** A uniform sample of `k` values without replacement (partial Fisher–Yates). */
export function sampleRows(values: Int32Array, k: number, seed = 11): Int32Array {
  if (k >= values.length) return values.slice();
  const rng = mulberry32(seed);
  const idx = new Int32Array(values.length);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  const out = new Int32Array(k);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (idx.length - i));
    const t = idx[i]!; idx[i] = idx[j]!; idx[j] = t;
    out[i] = values[idx[i]!]!;
  }
  return out;
}

export interface Mcv { value: number; freq: number }
export interface Histogram {
  kind: "width" | "depth";
  /** Bucket edges: nb + 1 values. For equi-depth these are pg_stats.histogram_bounds. */
  bounds: number[];
  /** Fraction of the histogram's rows in each bucket. */
  frac: number[];
  /** MCV list (empty if not used). */
  mcv: Mcv[];
  /** Fraction of all rows that the histogram describes (1 − sum of MCV frequencies). */
  histFrac: number;
  /** Total rows in the table (estimates scale to this). */
  rows: number;
}

/**
 * Most-common values in a sample: values whose frequency is at least `minRatio` times the
 * average frequency, at most `k` of them, most frequent first.
 */
export function mcvList(sample: ArrayLike<number>, k: number, minRatio = 1.25, domain = DOMAIN): Mcv[] {
  const c = valueCounts(sample, domain);
  let distinct = 0;
  for (const x of c) if (x > 0) distinct++;
  const avg = sample.length / Math.max(1, distinct);
  const vals: Mcv[] = [];
  for (let v = 0; v < c.length; v++) if (c[v]! > 1 && c[v]! >= minRatio * avg) vals.push({ value: v, freq: c[v]! / sample.length });
  vals.sort((a, b) => b.freq - a.freq || a.value - b.value);
  return vals.slice(0, k);
}

/** Equi-width histogram over [0, domain): nb buckets of equal value range. */
export function equiWidth(sample: ArrayLike<number>, nb: number, rows: number, mcv: Mcv[] = [], domain = DOMAIN): Histogram {
  const skip = new Set(mcv.map((m) => m.value));
  const w = domain / nb;
  const cnt = new Array<number>(nb).fill(0);
  let n = 0;
  for (let i = 0; i < sample.length; i++) {
    const v = sample[i]!;
    if (skip.has(v)) continue;
    cnt[Math.min(nb - 1, Math.floor(v / w))]!++; n++;
  }
  return { kind: "width", bounds: Array.from({ length: nb + 1 }, (_, i) => i * w), frac: cnt.map((c) => c / Math.max(1, n)), mcv, histFrac: 1 - mcv.reduce((a, m) => a + m.freq, 0), rows };
}

/**
 * Equi-depth histogram: bounds at the quantiles of the sorted sample, so each bucket holds the
 * same number of rows. Bound i is sorted[round(i × (n − 1) / nb)], as in compute_scalar_stats().
 * Values are integers; value v covers the real interval [v, v + 1), so the last bound is max + 1.
 */
export function equiDepth(sample: ArrayLike<number>, nb: number, rows: number, mcv: Mcv[] = []): Histogram {
  const skip = new Set(mcv.map((m) => m.value));
  const s: number[] = [];
  for (let i = 0; i < sample.length; i++) if (!skip.has(sample[i]!)) s.push(sample[i]!);
  s.sort((a, b) => a - b);
  const n = s.length;
  const bounds: number[] = [];
  for (let i = 0; i <= nb; i++) bounds.push(s[Math.round((i * (n - 1)) / nb)]!);
  bounds[nb] = bounds[nb]! + 1;
  return { kind: "depth", bounds, frac: new Array<number>(nb).fill(1 / nb), mcv, histFrac: 1 - mcv.reduce((a, m) => a + m.freq, 0), rows };
}

/** Fraction of the histogram's rows with value < x (x real), spreading each bucket uniformly. */
export function histCdf(h: Histogram, x: number): number {
  const b = h.bounds, nb = h.frac.length;
  if (x <= b[0]!) return 0;
  if (x >= b[nb]!) return 1;
  let acc = 0;
  for (let i = 0; i < nb; i++) {
    const a = b[i]!, z = b[i + 1]!;
    if (x >= z) { acc += h.frac[i]!; continue; }
    if (z > a && x > a) acc += (h.frac[i]! * (x - a)) / (z - a);
    break;
  }
  return acc;
}

/** Estimated rows for `lo <= x AND x <= hi` (integers). */
export function estimateRange(h: Histogram, lo: number, hi: number): number {
  let mcvSel = 0;
  for (const m of h.mcv) if (m.value >= lo && m.value <= hi) mcvSel += m.freq;
  const histSel = Math.max(0, histCdf(h, hi + 1) - histCdf(h, lo));
  return (mcvSel + histSel * h.histFrac) * h.rows;
}

/** Estimated density (rows per value) at value v, for drawing. */
export function histDensity(h: Histogram, v: number): number {
  return estimateRange(h, v, v);
}

/** q-error: max(est/true, true/est), with both sides at least 1 row. */
export const qError = (est: number, truth: number) => {
  const e = Math.max(1, est), t = Math.max(1, truth);
  return Math.max(e / t, t / e);
};

/** A fixed set of range predicates: lo uniform, width log-uniform in [1, maxWidth]. */
export function rangeQueries(n = 300, seed = 5, maxWidth = 500, domain = DOMAIN): [number, number][] {
  const rng = mulberry32(seed);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const w = Math.max(1, Math.round(Math.exp(rng() * Math.log(maxWidth))));
    const lo = Math.floor(rng() * (domain - w));
    out.push([lo, lo + w - 1]);
  }
  return out;
}

/** Range predicates placed where the data is: the centre is the value of a random row, width log-uniform in [1, maxWidth]. */
export function dataQueries(values: Int32Array, n = 300, seed = 5, maxWidth = 200, domain = DOMAIN): [number, number][] {
  const rng = mulberry32(seed);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const w = Math.max(1, Math.round(Math.exp(rng() * Math.log(maxWidth))));
    const c = values[Math.floor(rng() * values.length)]!;
    const lo = Math.max(0, Math.min(domain - w, c - Math.floor(rng() * w)));
    out.push([lo, lo + w - 1]);
  }
  return out;
}

export interface HistSetup { kind: "width" | "depth"; buckets: number; mcv: boolean; sample: number }

/** Builds the histogram a setup describes from the column (sample first, then MCVs, then the histogram). */
export function buildStats(values: Int32Array, s: HistSetup, mcvMax = s.buckets): Histogram {
  const smp = sampleRows(values, s.sample);
  const mcv = s.mcv ? mcvList(smp, mcvMax) : [];
  return s.kind === "width" ? equiWidth(smp, s.buckets, values.length, mcv) : equiDepth(smp, s.buckets, values.length, mcv);
}

/** Mean, median and max q-error of a histogram over a set of range predicates. */
export function histErrors(h: Histogram, counts: Float64Array, queries: [number, number][]) {
  const q = queries.map(([lo, hi]) => qError(estimateRange(h, lo, hi), trueRange(counts, lo, hi))).sort((a, b) => a - b);
  const geo = Math.exp(q.reduce((a, x) => a + Math.log(x), 0) / q.length);
  return { geoMean: geo, median: q[Math.floor(q.length / 2)]!, p90: q[Math.floor(q.length * 0.9)]!, max: q[q.length - 1]! };
}

// ---------------------------------------------------------------------------------------
// Distinct counts
// ---------------------------------------------------------------------------------------

/**
 * Haas–Stokes Duj1 estimator used by ANALYZE: n·d / (n − f1 + f1·n/N), where n is the sample size,
 * d the distinct values in the sample, f1 the values seen exactly once, N the table rows.
 * If every sampled value is distinct, ANALYZE assumes the column is unique.
 */
export function duj1(sample: ArrayLike<number>, N: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < sample.length; i++) m.set(sample[i]!, (m.get(sample[i]!) ?? 0) + 1);
  const n = sample.length, d = m.size;
  let f1 = 0;
  for (const c of m.values()) if (c === 1) f1++;
  if (f1 === n) return N;
  const est = (n * d) / (n - f1 + (f1 * n) / N);
  return Math.min(N, Math.max(d, est));
}

/** 64-bit mix (splitmix64 finalizer) on a 32-bit integer key, returned as two 32-bit halves. */
function hash64(x: number): [number, number] {
  let z = BigInt.asUintN(64, BigInt(x >>> 0) * 0x9e3779b97f4a7c15n + 0x632be59bd9b4e019n);
  z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
  z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
  z = z ^ (z >> 31n);
  return [Number(z >> 32n), Number(z & 0xffffffffn)];
}

/** HyperLogLog with m = 2^p registers (Flajolet et al. 2007), with the small-range correction. */
export class HyperLogLog {
  readonly m: number;
  readonly reg: Uint8Array;
  constructor(readonly p: number) { this.m = 1 << p; this.reg = new Uint8Array(this.m); }
  add(x: number) {
    const [hi, lo] = hash64(x);
    const idx = hi >>> (32 - this.p);
    // Remaining 64 − p bits: rank = position of the first 1 bit.
    const restHi = (hi << this.p) >>> 0;
    let rank: number;
    if (restHi !== 0) rank = Math.clz32(restHi) + 1;
    else rank = 32 - this.p + (lo !== 0 ? Math.clz32(lo) : 32) + 1;
    if (rank > this.reg[idx]!) this.reg[idx] = rank;
  }
  estimate(): number {
    const m = this.m;
    const alpha = m >= 128 ? 0.7213 / (1 + 1.079 / m) : m === 64 ? 0.709 : m === 32 ? 0.697 : 0.673;
    let sum = 0, zeros = 0;
    for (const r of this.reg) { sum += 2 ** -r; if (r === 0) zeros++; }
    const e = (alpha * m * m) / sum;
    if (e <= 2.5 * m && zeros > 0) return m * Math.log(m / zeros);
    return e;
  }
  /** Register bytes with 6-bit registers, as most implementations pack them. */
  get bytes() { return (this.m * 6) / 8; }
}

/** Relative standard error of HyperLogLog. */
export const hllStdError = (m: number) => 1.04 / Math.sqrt(m);

/** A column with `distinct` values, Zipf-skewed (s = 1), `rows` long; deterministic. */
export function zipfColumn(rows: number, distinct: number, seed = 3, s = 1): Int32Array {
  const rng: Rng = mulberry32(seed);
  const w = new Float64Array(distinct);
  let tot = 0;
  for (let i = 0; i < distinct; i++) { w[i] = 1 / Math.pow(i + 1, s); tot += w[i]!; }
  const cdf = new Float64Array(distinct);
  let acc = 0;
  for (let i = 0; i < distinct; i++) { acc += w[i]! / tot; cdf[i] = acc; }
  const out = new Int32Array(rows);
  for (let r = 0; r < rows; r++) {
    const u = rng();
    let a = 0, b = distinct - 1;
    while (a < b) { const mid = (a + b) >> 1; if (cdf[mid]! < u) a = mid + 1; else b = mid; }
    out[r] = a;
  }
  return out;
}
