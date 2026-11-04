/**
 * A tiny columnar executor with position lists, bitmaps and selection vectors, plus the
 * early vs late materialization plans of one query, step by step, with exact counters.
 *
 * Columns are plain arrays; a row ID is a position. Every function counts its work in a Counters
 * object: values read from a column, values copied into row tuples, and predicate checks.
 */
import { mulberry32 } from "../../rng";

import type { Value } from "./encodings";
export interface Counters { read: number; copied: number; checks: number }
export const newCounters = (): Counters => ({ read: 0, copied: 0, checks: 0 });

/** A sorted list of row positions. */
export type Positions = number[];

/** A bitmap with one bit per row, in 32-bit words. */
export class Bitmap {
  readonly words: Uint32Array;
  constructor(readonly n: number) { this.words = new Uint32Array(Math.ceil(n / 32)); }
  set(i: number) { this.words[i >>> 5]! |= 1 << (i & 31); }
  get(i: number) { return (this.words[i >>> 5]! >>> (i & 31)) & 1; }
  and(o: Bitmap): Bitmap { const r = new Bitmap(this.n); for (let w = 0; w < this.words.length; w++) r.words[w] = this.words[w]! & o.words[w]!; return r; }
  positions(): Positions { const p: Positions = []; for (let i = 0; i < this.n; i++) if (this.get(i)) p.push(i); return p; }
  bits(): boolean[] { return Array.from({ length: this.n }, (_, i) => this.get(i) === 1); }
}

/** Scans a whole column and returns the positions where pred holds. */
export function scanPositions<T extends Value>(col: readonly T[], pred: (v: T) => boolean, c: Counters): Positions {
  const out: Positions = [];
  for (let i = 0; i < col.length; i++) { c.read++; c.checks++; if (pred(col[i]!)) out.push(i); }
  return out;
}
/** Scans a whole column into a bitmap. */
export function scanBitmap<T extends Value>(col: readonly T[], pred: (v: T) => boolean, c: Counters): Bitmap {
  const b = new Bitmap(col.length);
  for (let i = 0; i < col.length; i++) { c.read++; c.checks++; if (pred(col[i]!)) b.set(i); }
  return b;
}
/** Reads the column only at the given positions and keeps those where pred holds. */
export function filterAt<T extends Value>(col: readonly T[], pos: Positions, pred: (v: T) => boolean, c: Counters): Positions {
  const out: Positions = [];
  for (const i of pos) { c.read++; c.checks++; if (pred(col[i]!)) out.push(i); }
  return out;
}
/** Fetches the values of a column at the given positions. */
export function fetchAt<T extends Value>(col: readonly T[], pos: Positions, c: Counters): T[] {
  c.read += pos.length;
  return pos.map((i) => col[i]!);
}
/** Intersection of two sorted position lists (a merge). */
export function intersect(a: Positions, b: Positions): Positions {
  const out: Positions = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]! < b[j]!) i++;
    else if (a[i]! > b[j]!) j++;
    else { out.push(a[i]!); i++; j++; }
  }
  return out;
}
/** Builds row tuples from column vectors of equal length: one copy per value. */
export function stitch(cols: readonly (readonly Value[])[], c: Counters): Value[][] {
  const n = cols[0]?.length ?? 0;
  const rows: Value[][] = [];
  for (let r = 0; r < n; r++) { rows.push(cols.map((col) => col[r]!)); c.copied += cols.length; }
  return rows;
}

/**
 * Selection vector filter, as in DuckDB and Velox: a vector keeps its values, and a list of the
 * indexes that are still active. A filter writes a new, shorter selection; it copies no values.
 */
export function filterSelection<T extends Value>(vec: readonly T[], sel: readonly number[] | null, pred: (v: T) => boolean, c: Counters): number[] {
  const out: number[] = [];
  const n = sel ? sel.length : vec.length;
  for (let k = 0; k < n; k++) { const i = sel ? sel[k]! : k; c.read++; c.checks++; if (pred(vec[i]!)) out.push(i); }
  return out;
}

// ---------------- the stepper query ----------------

export interface SalesColumns { id: number[]; region: string[]; qty: number[]; price: number[]; discount: number[] }
export const STEPPER_ROWS = 16;

export function stepperTable(n = STEPPER_ROWS, seed = 5): SalesColumns {
  const rng = mulberry32(seed);
  const regions = ["EU", "NA", "AP"];
  const t: SalesColumns = { id: [], region: [], qty: [], price: [], discount: [] };
  for (let i = 0; i < n; i++) {
    t.id.push(101 + i);
    t.region.push(regions[Math.floor(rng() * 3)]!);
    t.qty.push(1 + Math.floor(rng() * 50));
    t.price.push(Math.round(rng() * 20000) / 100);
    t.discount.push(Math.floor(rng() * 11));
  }
  return t;
}

export type Strategy = "early" | "late" | "bitmap";
export type ColName = keyof SalesColumns;
export interface Step {
  title: string;
  detail: string;
  /** Rows read from each column in this step. */
  touched: Partial<Record<ColName, number[]>>;
  /** The current position list (late plans) or the surviving rows (early plan). */
  positions: number[] | null;
  /** Bitmaps built so far (bitmap plan). */
  bitmaps: { name: string; bits: boolean[] }[];
  /** Row tuples built so far. */
  tuples: { row: number; values: Value[]; alive: boolean }[];
  tupleCols: ColName[];
  counters: Counters;
}

/** SELECT id, price FROM sales WHERE region = 'EU' AND qty > threshold, as a list of steps. */
export function runPlan(strategy: Strategy, t: SalesColumns, threshold: number): Step[] {
  const c = newCounters();
  const snap = () => ({ ...c });
  const steps: Step[] = [];
  const n = t.id.length;
  const all = Array.from({ length: n }, (_, i) => i);
  const isEu = (v: string) => v === "EU";
  const big = (v: number) => v > threshold;
  const base = { bitmaps: [] as Step["bitmaps"], tuples: [] as Step["tuples"], tupleCols: [] as ColName[] };

  if (strategy === "early") {
    const cols: ColName[] = ["region", "qty", "id", "price"];
    c.read += cols.length * n;
    const rows = stitch(cols.map((k) => t[k] as Value[]), c);
    const tuples = rows.map((values, row) => ({ row, values, alive: true }));
    const copy = () => tuples.map((x) => ({ ...x }));
    steps.push({ ...base, title: "Read 4 columns, build 16 tuples", detail: `Read region, qty, id and price for all ${n} rows, and copy them into ${n} row tuples.`, touched: { region: all, qty: all, id: all, price: all }, positions: all, tuples: copy(), tupleCols: cols, counters: snap() });
    for (const x of tuples) { c.checks++; if (!isEu(x.values[0] as string)) x.alive = false; }
    steps.push({ ...base, title: "Filter: region = 'EU'", detail: "Check the region of every tuple. The other tuples are thrown away, with the values that were copied into them.", touched: {}, positions: tuples.filter((x) => x.alive).map((x) => x.row), tuples: copy(), tupleCols: cols, counters: snap() });
    for (const x of tuples) if (x.alive) { c.checks++; if (!big(x.values[1] as number)) x.alive = false; }
    const live = tuples.filter((x) => x.alive).map((x) => x.row);
    steps.push({ ...base, title: `Filter: qty > ${threshold}`, detail: "Check qty on the tuples that are still alive.", touched: {}, positions: live, tuples: copy(), tupleCols: cols, counters: snap() });
    steps.push({ ...base, title: "Project id, price", detail: `Output id and price of the ${live.length} surviving tuples. Each one already holds them.`, touched: {}, positions: live, tuples: copy(), tupleCols: cols, counters: snap() });
    return steps;
  }

  if (strategy === "late") {
    const p1 = scanPositions(t.region, isEu, c);
    steps.push({ ...base, title: "Scan region → position list", detail: `Read the whole region column. Write the ${p1.length} positions where region = 'EU'.`, touched: { region: all }, positions: p1, counters: snap() });
    const p2 = filterAt(t.qty, p1, big, c);
    steps.push({ ...base, title: `Read qty at those positions`, detail: `Read qty only at the ${p1.length} positions. Keep the ${p2.length} where qty > ${threshold}.`, touched: { qty: p1 }, positions: p2, counters: snap() });
    const ids = fetchAt(t.id, p2, c);
    steps.push({ ...base, title: "Fetch id", detail: `Read id at the ${p2.length} final positions.`, touched: { id: p2 }, positions: p2, counters: snap() });
    const prices = fetchAt(t.price, p2, c);
    steps.push({ ...base, title: "Fetch price", detail: `Read price at the same ${p2.length} positions.`, touched: { price: p2 }, positions: p2, counters: snap() });
    const rows = stitch([ids, prices], c);
    steps.push({ ...base, title: "Build output tuples", detail: `Only now copy values into tuples: ${p2.length} tuples of 2 values.`, touched: {}, positions: p2, tuples: rows.map((values, i) => ({ row: p2[i]!, values, alive: true })), tupleCols: ["id", "price"], counters: snap() });
    return steps;
  }

  const b1 = scanBitmap(t.region, isEu, c);
  steps.push({ ...base, title: "Scan region → bitmap", detail: "Read the whole region column and set one bit per row where region = 'EU'.", touched: { region: all }, positions: null, bitmaps: [{ name: "region = 'EU'", bits: b1.bits() }], counters: snap() });
  const b2 = scanBitmap(t.qty, big, c);
  steps.push({ ...base, title: "Scan qty → bitmap", detail: `Read the whole qty column too. The two scans do not depend on each other, so they can run in parallel.`, touched: { qty: all }, positions: null, bitmaps: [{ name: "region = 'EU'", bits: b1.bits() }, { name: `qty > ${threshold}`, bits: b2.bits() }], counters: snap() });
  const b = b1.and(b2);
  const p = b.positions();
  const bm = [{ name: "region = 'EU'", bits: b1.bits() }, { name: `qty > ${threshold}`, bits: b2.bits() }, { name: "AND", bits: b.bits() }];
  steps.push({ ...base, title: "AND the bitmaps", detail: `One AND per 32-bit word: ${b.words.length} word operation${b.words.length > 1 ? "s" : ""} for ${n} rows. ${p.length} bits stay set.`, touched: {}, positions: p, bitmaps: bm, counters: snap() });
  const ids = fetchAt(t.id, p, c);
  const prices = fetchAt(t.price, p, c);
  steps.push({ ...base, title: "Fetch id and price", detail: `Read id and price at the ${p.length} set bits.`, touched: { id: p, price: p }, positions: p, bitmaps: bm, counters: snap() });
  const rows = stitch([ids, prices], c);
  steps.push({ ...base, title: "Build output tuples", detail: `Copy ${p.length} × 2 values into output tuples.`, touched: {}, positions: p, bitmaps: bm, tuples: rows.map((values, i) => ({ row: p[i]!, values, alive: true })), tupleCols: ["id", "price"], counters: snap() });
  return steps;
}

/** The answer of the stepper query, computed directly, for tests. */
export function stepperAnswer(t: SalesColumns, threshold: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < t.id.length; i++) if (t.region[i] === "EU" && t.qty[i]! > threshold) out.push([t.id[i]!, t.price[i]!]);
  return out;
}

// ---------------- the cost model: early vs late as selectivity changes ----------------

/**
 * Cost per input row, in abstract units: one value operation = 1, one cache-line miss = LINE.
 * The query has one predicate column and `outputs` output columns of 8-byte values.
 *
 * early: scan every referenced column (k of them), copy all k values of every row into a tuple,
 *        check the predicate on every tuple. The cost does not depend on the selectivity s.
 * late:  scan the predicate column, write s positions, then for each output column gather s values
 *        (GATHER each) and miss the cache lines that hold them, then copy s × outputs values.
 * reaccess: the predicate column is also an output, so late reads it twice.
 * compressed: the predicate column is run-length encoded with runs of RUN; late checks one run at
 *             a time, early must decode every value before it can build tuples.
 */
export interface CostParams { outputs: number; reaccess: boolean; compressed: boolean }
export const COST = { LINE: 4, VALUES_PER_LINE: 8, GATHER: 2, COPY: 1, RUN: 16 } as const;

const scanCost = () => 1 + COST.LINE / COST.VALUES_PER_LINE;
/** Cache-line cost of reading a fraction s of the rows of one column, spread evenly. */
export const gatherLines = (s: number) => (COST.LINE / COST.VALUES_PER_LINE) * (1 - Math.pow(1 - s, COST.VALUES_PER_LINE));

export function earlyCost(p: CostParams): number {
  const k = p.reaccess ? p.outputs : p.outputs + 1;
  const predScan = p.compressed ? 1 + scanCost() / COST.RUN : scanCost(); // decode every value
  return predScan + (k - 1) * scanCost() + k * COST.COPY + 1;
}
export function lateCost(p: CostParams, s: number): number {
  const predScan = p.compressed ? scanCost() / COST.RUN : scanCost();
  return predScan + s + p.outputs * (s * COST.GATHER + gatherLines(s)) + s * p.outputs * COST.COPY;
}
/** Selectivity where late stops being cheaper (null if late wins everywhere in (0, 1]). */
export function crossover(p: CostParams): number | null {
  const e = earlyCost(p);
  if (lateCost(p, 1) <= e) return null;
  let lo = 1e-6, hi = 1;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (lateCost(p, m) < e) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
