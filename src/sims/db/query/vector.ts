/**
 * Vectorized execution (MonetDB/X100, DuckDB, Velox): operators pass batches of V values per column.
 *
 * - `Batch`: columnar data (one typed array per column) plus an optional selection vector, the list of
 *   row positions that are still alive. A filter does not copy rows; it writes a new selection vector.
 * - Primitives: `selGtBranching`, `selGtBranchFree` (the same result, with or without a data-dependent
 *   branch), `mulCol`, `sumCol`. `runVectorized` executes SELECT SUM(a * b) WHERE a > x AND b < y over a
 *   table in batches and counts primitive calls; `runTupleAtATime` is the reference row-by-row version.
 * - `vectorCostModel`: a documented cost model of time per tuple as a function of the vector size.
 * - `branchSim`: a 2-bit saturating-counter branch predictor run on real predicate outcomes, to price
 *   branching against branch-free selection.
 */
import { mulberry32 } from "../../rng";

export interface Batch { n: number; cols: Record<string, Float64Array>; sel: Int32Array | null; selN: number }

/** Selection with a branch: positions where col[i] > c. */
export function selGtBranching(col: Float64Array, c: number, inSel: Int32Array | null, n: number, out: Int32Array): number {
  let k = 0;
  if (inSel) { for (let j = 0; j < n; j++) { const i = inSel[j]!; if (col[i]! > c) out[k++] = i; } }
  else for (let i = 0; i < n; i++) if (col[i]! > c) out[k++] = i;
  return k;
}

/** Branch-free selection: always write the position, advance the cursor by the 0/1 outcome. */
export function selGtBranchFree(col: Float64Array, c: number, inSel: Int32Array | null, n: number, out: Int32Array): number {
  let k = 0;
  if (inSel) { for (let j = 0; j < n; j++) { const i = inSel[j]!; out[k] = i; k += +(col[i]! > c); } }
  else for (let i = 0; i < n; i++) { out[k] = i; k += +(col[i]! > c); }
  return k;
}

/** Same as selGtBranchFree for col[i] < c. */
export function selLtBranchFree(col: Float64Array, c: number, inSel: Int32Array | null, n: number, out: Int32Array): number {
  let k = 0;
  if (inSel) { for (let j = 0; j < n; j++) { const i = inSel[j]!; out[k] = i; k += +(col[i]! < c); } }
  else for (let i = 0; i < n; i++) { out[k] = i; k += +(col[i]! < c); }
  return k;
}

/** out[i] = a[i] * b[i] for the selected positions only. */
export function mulCol(a: Float64Array, b: Float64Array, sel: Int32Array | null, n: number, out: Float64Array) {
  if (sel) for (let j = 0; j < n; j++) { const i = sel[j]!; out[i] = a[i]! * b[i]!; }
  else for (let i = 0; i < n; i++) out[i] = a[i]! * b[i]!;
}

export function sumCol(x: Float64Array, sel: Int32Array | null, n: number): number {
  let s = 0;
  if (sel) for (let j = 0; j < n; j++) s += x[sel[j]!]!;
  else for (let i = 0; i < n; i++) s += x[i]!;
  return s;
}

export interface ColTable { n: number; a: Float64Array; b: Float64Array }

export function makeTable(n: number, seed = 1): ColTable {
  const rnd = mulberry32(seed);
  const a = new Float64Array(n), b = new Float64Array(n);
  for (let i = 0; i < n; i++) { a[i] = Math.floor(rnd() * 100); b[i] = Math.floor(rnd() * 100); }
  return { n, a, b };
}

export interface VecRun { sum: number; selected: number; primitiveCalls: number; batches: number }

/** SELECT SUM(a * b) WHERE a > x AND b < y, in batches of `v` rows. 4 primitive calls per batch. */
export function runVectorized(t: ColTable, v: number, x: number, y: number): VecRun {
  const s1 = new Int32Array(v), s2 = new Int32Array(v), prod = new Float64Array(v);
  let sum = 0, selected = 0, calls = 0, batches = 0;
  for (let off = 0; off < t.n; off += v) {
    const n = Math.min(v, t.n - off);
    const a = t.a.subarray(off, off + n), b = t.b.subarray(off, off + n);
    const k1 = selGtBranchFree(a, x, null, n, s1);
    const k2 = selLtBranchFree(b, y, s1, k1, s2);
    mulCol(a, b, s2, k2, prod);
    sum += sumCol(prod, s2, k2);
    selected += k2;
    calls += 4;
    batches++;
  }
  return { sum, selected, primitiveCalls: calls, batches };
}

/** The same query row by row, as a Volcano plan would run it: one interpretation step per operator per row. */
export function runTupleAtATime(t: ColTable, x: number, y: number): VecRun {
  let sum = 0, selected = 0, calls = 0;
  for (let i = 0; i < t.n; i++) {
    calls++; // scan.next
    calls++; // filter a > x
    if (!(t.a[i]! > x)) continue;
    calls++; // filter b < y
    if (!(t.b[i]! < y)) continue;
    calls++; // project a * b, then aggregate
    sum += t.a[i]! * t.b[i]!;
    selected++;
  }
  return { sum, selected, primitiveCalls: calls, batches: t.n };
}

// ------------------------------------------------------------------ the batch shown in the selection-vector demo

/** A 16-row batch for the selection-vector demo (fixed values, so the lesson can quote them). */
export const DEMO_BATCH = { a: [12, 87, 45, 63, 5, 91, 38, 70, 24, 56, 99, 17, 81, 42, 66, 30], b: [40, 15, 72, 8, 55, 33, 90, 21, 64, 47, 12, 78, 50, 29, 6, 83] };

export interface SelStep { sel: number[]; evaluated: number }
/** Evaluates a > x on all rows, then b < y only on the survivors. */
export function selectionSteps(x: number, y: number): { p1: SelStep; p2: SelStep } {
  const { a, b } = DEMO_BATCH;
  const s1 = a.map((v, i) => (v > x ? i : -1)).filter((i) => i >= 0);
  const s2 = s1.filter((i) => b[i]! < y);
  return { p1: { sel: s1, evaluated: a.length }, p2: { sel: s2, evaluated: s1.length } };
}

// ------------------------------------------------------------------ cost model

export interface VecModel {
  /** Interpretation overhead per primitive call (function call, type dispatch, loop setup), ns. */
  callNs: number;
  /** Useful work per value per primitive, ns, when its data is in L1. */
  workNs: number;
  /** Primitives in the pipeline; each writes one intermediate vector of 8-byte values. */
  prims: number;
  /** Bytes per value. */
  bytes: number;
  /** Cache sizes in bytes (per core: L1d, L2; L3 share). */
  l1: number;
  l2: number;
  l3: number;
  /** Cost to write and read back one byte of an intermediate vector, served from each level, ns/B. */
  nsPerByte: { l1: number; l2: number; l3: number; mem: number };
}

/**
 * Default model. Values are typical of a recent x86 server core and are assumptions, not measurements:
 * a primitive call costs about 10 ns (30–40 cycles at 3.5 GHz) and one simple operation on one value in L1
 * costs about 0.5 ns. Streaming bandwidth per core is about 100 GB/s from L1, 50 GB/s from L2, 25 GB/s from
 * L3 and 10 GB/s from DRAM, so a byte costs 0.01, 0.02, 0.04 and 0.1 ns.
 */
export const VEC_MODEL: VecModel = {
  callNs: 10, workNs: 0.5, prims: 4, bytes: 8,
  l1: 48 * 1024, l2: 2 * 1024 * 1024, l3: 32 * 1024 * 1024,
  nsPerByte: { l1: 0.01, l2: 0.02, l3: 0.04, mem: 0.1 },
};

/**
 * Time per tuple (ns) at vector size v:
 *   call   = prims · callNs / v                 (overhead paid once per vector)
 *   work   = prims · workNs
 *   memory = prims · 2 · bytes · c(W),  W = v · bytes · prims  (all intermediate vectors of one batch)
 * c(W) blends the per-byte costs by the share of W that fits in each level: share(L1) = min(1, L1 / W), and so on.
 * v = 1 is tuple-at-a-time; v = all rows is column-at-a-time full materialization (MonetDB).
 */
export function vectorCost(v: number, m: VecModel = VEC_MODEL): { call: number; work: number; memory: number; total: number; workingSet: number } {
  const W = v * m.bytes * m.prims;
  const f1 = Math.min(1, m.l1 / W), f2 = Math.min(1, m.l2 / W), f3 = Math.min(1, m.l3 / W);
  const c = f1 * m.nsPerByte.l1 + (f2 - f1) * m.nsPerByte.l2 + (f3 - f2) * m.nsPerByte.l3 + (1 - f3) * m.nsPerByte.mem;
  const call = (m.prims * m.callNs) / v;
  const work = m.prims * m.workNs;
  const memory = m.prims * 2 * m.bytes * c;
  return { call, work, memory, total: call + work + memory, workingSet: W };
}

/** Vector size (power of 2 between 1 and maxV) with the lowest modeled time per tuple. */
export function bestVectorSize(m: VecModel = VEC_MODEL, maxV = 1 << 24): { v: number; ns: number } {
  let best = { v: 1, ns: vectorCost(1, m).total };
  for (let v = 2; v <= maxV; v *= 2) { const ns = vectorCost(v, m).total; if (ns < best.ns) best = { v, ns }; }
  return best;
}

/** Largest vector size whose working set still fits in `bytes` of cache. */
export const fitsIn = (bytes: number, m: VecModel = VEC_MODEL) => Math.floor(bytes / (m.bytes * m.prims));

// ------------------------------------------------------------------ branches

export interface BranchModel { baseCycles: number; penaltyCycles: number; branchFreeCycles: number }
/**
 * Cycles per tuple of a selection loop. Branching: 1 cycle of work plus 15 cycles per misprediction
 * (a typical pipeline flush on recent x86 cores). Branch-free: always 2 cycles (an extra store and add).
 */
export const BRANCH_MODEL: BranchModel = { baseCycles: 1, penaltyCycles: 15, branchFreeCycles: 2 };

/**
 * Runs a 2-bit saturating-counter predictor over the outcomes of `x < t` on n uniform random values, where
 * t is chosen so that a share `sel` of rows pass. Returns the misprediction rate and the cycles per tuple.
 */
export function branchSim(sel: number, n = 20000, seed = 3, m: BranchModel = BRANCH_MODEL): { mispredictRate: number; branching: number; branchFree: number } {
  const rnd = mulberry32(seed);
  let state = 2; // 0,1 predict not taken; 2,3 predict taken
  let miss = 0;
  for (let i = 0; i < n; i++) {
    const taken = rnd() < sel;
    if ((state >= 2) !== taken) miss++;
    state = taken ? Math.min(3, state + 1) : Math.max(0, state - 1);
  }
  const rate = miss / n;
  return { mispredictRate: rate, branching: m.baseCycles + rate * m.penaltyCycles, branchFree: m.branchFreeCycles };
}
