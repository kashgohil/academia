/**
 * Secondary and covering indexes:
 *
 * - A PostgreSQL-style cost model for sequential, index, bitmap and index-only scans. The formulas
 *   follow the shape of PostgreSQL's costsize.c (Mackert–Lohman page estimate, correlation
 *   interpolation, bitmap cost per page) with its default constants. It is a teaching model, not
 *   a copy: it leaves out startup details, parallel plans and per-column statistics.
 * - `CompositeIndex`: a sorted array of composite keys that applies the leftmost-prefix rule, for
 *   the planner toy and its property tests.
 * - `planQuery`: the planner toy. It tags each index column (seek, filter, unused), checks ORDER BY
 *   and covering, costs every access path and picks the cheapest.
 * - `lookupTrace`: page reads of InnoDB (clustered primary key) and PostgreSQL (heap + TIDs) lookups
 *   on real B+ trees from ../btree.
 */
import { PG_COSTS, rowsPerPage } from "../storage/heap";
import { BPlusTree, strCmp, numCmp, levelSizes } from "../btree";

// =====================================================================================
// Cost model
// =====================================================================================

export const PG_MORE = {
  cpu_index_tuple_cost: 0.005,
  /** effective_cache_size = 4 GB, in 8 KiB pages. */
  effective_cache_pages: (4 * 2 ** 30) / 8192,
} as const;

export interface CostParams {
  seqPage: number;
  randomPage: number;
  cpuTuple: number;
  cpuIndexTuple: number;
  cpuOperator: number;
  cachePages: number;
}

export const DEFAULT_COSTS: CostParams = {
  seqPage: PG_COSTS.seq_page_cost,
  randomPage: PG_COSTS.random_page_cost,
  cpuTuple: PG_COSTS.cpu_tuple_cost,
  cpuIndexTuple: PG_MORE.cpu_index_tuple_cost,
  cpuOperator: PG_COSTS.cpu_operator_cost,
  cachePages: PG_MORE.effective_cache_pages,
};

/** A common setting for SSDs: random_page_cost = 1.1. */
export const SSD_COSTS: CostParams = { ...DEFAULT_COSTS, randomPage: 1.1 };

/**
 * Mackert–Lohman estimate of distinct heap pages fetched when `tuples` rows are read in random
 * order from a table of `T` pages with `b` pages of cache (PostgreSQL index_pages_fetched).
 */
export function pagesFetched(tuples: number, T: number, b: number): number {
  if (tuples <= 0 || T <= 0) return 0;
  let p: number;
  if (T <= b) {
    p = Math.min((2 * T * tuples) / (2 * T + tuples), T);
  } else {
    const lim = (2 * T * b) / (2 * T - b);
    p = tuples <= lim ? (2 * T * tuples) / (2 * T + tuples) : b + ((tuples - lim) * (T - b)) / T;
  }
  return Math.ceil(p);
}

export interface TableModel {
  rows: number;
  /** Heap pages. */
  pages: number;
  /** Leaf pages of the index. */
  indexPages: number;
  /** Levels of the index B+ tree. */
  indexHeight: number;
}

/** B-tree leaf entries per 8 KiB page: 8-byte index tuple header + MAXALIGNed key + 4-byte line pointer. */
export function btreeEntriesPerPage(keyBytes: number, fill: number, pageBytes = 8192): number {
  const usable = pageBytes - 24 - 16; // page header and btree special space
  return Math.floor((usable * fill) / (8 + Math.ceil(keyBytes / 8) * 8 + 4));
}

/** A table of `rows` rows of `rowBytes` with one B-tree index on `keyBytes` of key. Leaves 90% full, inner pages 70%. */
export function tableModel(rows: number, rowBytes: number, keyBytes: number): TableModel {
  const pages = Math.ceil(rows / rowsPerPage(rowBytes));
  const leafCap = btreeEntriesPerPage(keyBytes, 0.9);
  const fanout = btreeEntriesPerPage(keyBytes, 0.7);
  const lv = levelSizes(rows, leafCap, fanout);
  return { rows, pages, indexPages: lv[lv.length - 1]!, indexHeight: lv.length };
}

/** The orders table used in the lesson: 1 M rows of 100 bytes, index keys of 16 bytes. */
export const ORDERS_MODEL = tableModel(1_000_000, 100, 16);

export interface PathCost {
  startup: number;
  total: number;
  /** Heap pages the path reads. */
  heapPages: number;
  /** Index tuples the path reads. */
  indexTuples: number;
}

/** Sequential scan: every page in order, every row checked against `quals` predicates. */
export function seqScanCost(m: TableModel, quals: number, c: CostParams = DEFAULT_COSTS): PathCost {
  return { startup: 0, total: m.pages * c.seqPage + m.rows * (c.cpuTuple + quals * c.cpuOperator), heapPages: m.pages, indexTuples: 0 };
}

export interface IndexScanOpts {
  /** Selectivity of the predicates that bound the scanned index range (leftmost prefix). */
  boundSel: number;
  /** Selectivity of all predicates the index can check (rows fetched from the heap). Defaults to boundSel. */
  indexSel?: number;
  /** Number of predicates checked on index tuples. */
  indexQuals?: number;
  /** Predicates checked on heap rows after the fetch. */
  filterQuals?: number;
  /** Correlation between index order and heap order, −1..1. */
  correlation?: number;
  /** Index-only scan: heap pages are read only for rows not marked all-visible. */
  indexOnly?: boolean;
  /** Fraction of heap pages marked all-visible in the visibility map. */
  allVisible?: number;
}

/** Cost of descending the B-tree and reading the index range (PostgreSQL genericcostestimate + btree descent). */
function indexPart(m: TableModel, o: IndexScanOpts, c: CostParams) {
  const tuples = Math.max(1, Math.round(o.boundSel * m.rows));
  const pages = Math.ceil((tuples * m.indexPages) / m.rows);
  const descent = Math.ceil(Math.log2(m.rows)) * c.cpuOperator + (m.indexHeight + 1) * 50 * c.cpuOperator;
  const quals = o.indexQuals ?? 1;
  return { tuples, startup: descent, total: descent + pages * c.randomPage + tuples * (c.cpuIndexTuple + quals * c.cpuOperator) };
}

/** Index scan (or index-only scan): walk the index range, fetch each matching heap row by TID. */
export function indexScanCost(m: TableModel, o: IndexScanOpts, c: CostParams = DEFAULT_COSTS): PathCost {
  const ix = indexPart(m, o, c);
  const sel = o.indexSel ?? o.boundSel;
  const fetched = Math.max(1, Math.round(sel * m.rows));
  const corr = o.correlation ?? 0;
  let maxPages = pagesFetched(fetched, m.pages, c.cachePages);
  let minPages = Math.ceil(sel * m.pages);
  if (o.indexOnly) {
    const f = 1 - (o.allVisible ?? 1);
    maxPages = Math.ceil(maxPages * f);
    minPages = Math.ceil(minPages * f);
  }
  const maxIo = maxPages * c.randomPage;
  const minIo = minPages > 0 ? c.randomPage + (minPages - 1) * c.seqPage : 0;
  const io = maxIo + corr * corr * (minIo - maxIo);
  const heapPages = Math.round(maxPages + corr * corr * (minPages - maxPages));
  const cpu = fetched * (c.cpuTuple + (o.filterQuals ?? 0) * c.cpuOperator);
  return { startup: ix.startup, total: ix.total + io + cpu, heapPages, indexTuples: ix.tuples };
}

/** Bitmap heap scan: collect TIDs in a bitmap, sort them by page, read each page once in page order. */
export function bitmapScanCost(m: TableModel, o: IndexScanOpts, c: CostParams = DEFAULT_COSTS): PathCost {
  const ix = indexPart(m, o, c);
  const sel = o.indexSel ?? o.boundSel;
  const fetched = Math.max(1, Math.round(sel * m.rows));
  const pages = Math.min(pagesFetched(fetched, m.pages, c.cachePages), m.pages);
  const perPage = pages >= 2 ? c.randomPage - (c.randomPage - c.seqPage) * Math.sqrt(pages / m.pages) : c.randomPage;
  const startup = ix.total + 0.1 * c.cpuOperator * ix.tuples;
  const run = pages * perPage + fetched * (c.cpuTuple + ((o.indexQuals ?? 1) + (o.filterQuals ?? 0)) * c.cpuOperator); // index quals are rechecked
  return { startup, total: startup + run, heapPages: pages, indexTuples: ix.tuples };
}

export interface SweepPoint { sel: number; seq: number; index: number; bitmap: number; indexOnly: number }

/** Costs of the four paths for a single-column predicate of selectivity `sel`. */
export function pathCosts(m: TableModel, sel: number, o: { correlation?: number; allVisible?: number } = {}, c: CostParams = DEFAULT_COSTS): SweepPoint {
  const base = { boundSel: sel, correlation: o.correlation ?? 0 };
  return {
    sel,
    seq: seqScanCost(m, 1, c).total,
    index: indexScanCost(m, base, c).total,
    bitmap: bitmapScanCost(m, base, c).total,
    indexOnly: indexScanCost(m, { ...base, indexOnly: true, allVisible: o.allVisible ?? 1 }, c).total,
  };
}

/** Selectivity where path `a` stops being cheaper than path `b` (geometric bisection on 1e-7..1); null if no crossing. */
export function crossover(f: (sel: number) => number, g: (sel: number) => number): number | null {
  let lo = 1e-7, hi = 1;
  const d = (s: number) => f(s) - g(s);
  if (Math.sign(d(lo)) === Math.sign(d(hi))) return null;
  for (let i = 0; i < 80; i++) {
    const mid = Math.sqrt(lo * hi);
    if (Math.sign(d(mid)) === Math.sign(d(lo))) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

// =====================================================================================
// Composite index with the leftmost-prefix rule
// =====================================================================================

export type Row = Record<string, number>;
/** A predicate lo ≤ col ≤ hi (lo = hi for equality). */
export interface Pred { col: string; lo: number; hi: number }

export type ColUse = "seek =" | "seek range" | "index filter" | "unused";

/** How each key column of a composite index can serve a set of predicates. */
export function columnUse(key: string[], preds: Pred[]): ColUse[] {
  const byCol = new Map(preds.map((p) => [p.col, p]));
  const out: ColUse[] = [];
  let seeking = true;
  for (const col of key) {
    const p = byCol.get(col);
    if (seeking && p && p.lo === p.hi) out.push("seek =");
    else if (seeking && p) { out.push("seek range"); seeking = false; }
    else { seeking = false; out.push(p ? "index filter" : "unused"); }
  }
  return out;
}

/** True when an index scan returns rows already sorted by `orderBy` (ascending). */
export function providesOrder(key: string[], preds: Pred[], orderBy: string): boolean {
  const use = columnUse(key, preds);
  for (let i = 0; i < key.length; i++) {
    if (key[i] === orderBy) return true;
    if (use[i] !== "seek =") return false;
  }
  return false;
}

/** A B+ tree leaf level as a sorted array of composite keys (ties broken by row id). */
export class CompositeIndex {
  readonly entries: { key: number[]; id: number }[];
  constructor(readonly key: string[], rows: Row[]) {
    this.entries = rows.map((r) => ({ key: key.map((c) => r[c]!), id: r.id! }));
    this.entries.sort((a, b) => cmpKeys(a.key, b.key) || a.id - b.id);
  }
  /**
   * Seeks the range bounded by the leftmost seekable prefix, then walks it and checks the other
   * key-column predicates on each entry. Returns the scanned range and the matching row ids.
   */
  scan(preds: Pred[]): { lo: number; hi: number; scanned: number; ids: number[] } {
    const use = columnUse(this.key, preds);
    const byCol = new Map(preds.map((p) => [p.col, p]));
    const lower: number[] = [], upper: number[] = [];
    for (let i = 0; i < this.key.length; i++) {
      if (use[i] !== "seek =" && use[i] !== "seek range") break;
      const p = byCol.get(this.key[i]!)!;
      lower.push(p.lo);
      upper.push(p.hi);
    }
    const lo = this.bound(lower, false), hi = this.bound(upper, true);
    const ids: number[] = [];
    for (let i = lo; i < hi; i++) {
      const e = this.entries[i]!;
      if (this.key.every((c, j) => { const p = byCol.get(c); return !p || (e.key[j]! >= p.lo && e.key[j]! <= p.hi); })) ids.push(e.id);
    }
    return { lo, hi, scanned: hi - lo, ids };
  }
  /** First entry whose prefix is ≥ `prefix` (or > when `after`). */
  private bound(prefix: number[], after: boolean): number {
    let lo = 0, hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const c = cmpKeys(this.entries[mid]!.key.slice(0, prefix.length), prefix);
      if (c < 0 || (after && c === 0)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

function cmpKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

// =====================================================================================
// The planner toy: orders(id, customer_id, status, created_at, amount, note)
// =====================================================================================

export type Col = "id" | "customer_id" | "status" | "created_at" | "amount" | "note";
export const ALL_COLS: Col[] = ["id", "customer_id", "status", "created_at", "amount", "note"];

/** The predicates the toy offers, with their selectivity on the 1 M-row orders table. */
export const TOY_PREDS: Record<"customer_id" | "status" | "created_at" | "amount", { sql: string; sel: number; eq: boolean }> = {
  customer_id: { sql: "customer_id = 42", sel: 1 / 10000, eq: true },
  status: { sql: "status = 'open'", sel: 0.2, eq: true },
  created_at: { sql: "created_at >= now() - '7 days'", sel: 7 / 365, eq: false },
  amount: { sql: "amount > 500", sel: 0.1, eq: false },
};
export type PredCol = keyof typeof TOY_PREDS;

/**
 * Correlation between each column's order and the physical row order (PostgreSQL's pg_stats.correlation).
 * Rows are appended in time order, so id and created_at follow the heap; the others are random.
 */
export const TOY_CORR: Record<Col, number> = { id: 1, created_at: 0.95, customer_id: 0, status: 0, amount: 0, note: 0 };

export interface ToyQuery {
  where: PredCol[];
  orderBy: Col | null;
  select: "*" | Col[];
  limit: number | null;
}

export interface ToyIndex { key: Col[]; include: Col[] }

export type PathName = "Seq Scan" | "Index Scan" | "Bitmap Heap Scan" | "Index Only Scan";

export interface ToyPath { name: PathName; cost: number; sorted: boolean; sortCost: number; rowsRead: number; heapPages: number; available: boolean; why?: string }

export interface ToyPlan {
  use: ColUse[];
  covered: boolean;
  /** Columns the query needs that the index does not hold. */
  missing: Col[];
  orderByIndex: boolean;
  boundSel: number;
  indexSel: number;
  rows: number;
  paths: ToyPath[];
  best: ToyPath;
  indexCond: string[];
  indexFilter: string[];
  heapFilter: string[];
}

const toyPred = (c: PredCol): Pred => (TOY_PREDS[c].eq ? { col: c, lo: 1, hi: 1 } : { col: c, lo: 1, hi: 2 });

/** Cost of sorting `n` rows (all of them, or the top `limit` with a bounded heap), as in PostgreSQL's cost_sort. */
export function sortCost(n: number, limit: number | null, c: CostParams = DEFAULT_COSTS): number {
  if (n < 2) return 0;
  const cmp = 2 * c.cpuOperator;
  return limit !== null && limit < n / 2 ? cmp * n * Math.log2(2 * limit) : cmp * n * Math.log2(n);
}

/** Plans `q` on the orders table with one index `ix` (or none). */
export function planQuery(ix: ToyIndex | null, q: ToyQuery, m: TableModel = ORDERS_MODEL, c: CostParams = DEFAULT_COSTS): ToyPlan {
  const preds = q.where.map(toyPred);
  const key = ix?.key ?? [];
  const use = columnUse(key, preds);
  const sel = (cs: PredCol[]) => cs.reduce((s, col) => s * TOY_PREDS[col].sel, 1);
  const seekCols = key.filter((_, i) => use[i] === "seek =" || use[i] === "seek range") as PredCol[];
  const idxCols = key.filter((_, i) => use[i] !== "unused") as PredCol[];
  const heapCols = q.where.filter((w) => !idxCols.includes(w));
  const boundSel = seekCols.length ? sel(seekCols) : 1;
  const indexSel = sel(idxCols);
  const rows = Math.max(1, Math.round(m.rows * sel(q.where)));
  const need = new Set<Col>([...(q.select === "*" ? ALL_COLS : q.select), ...q.where, ...(q.orderBy ? [q.orderBy] : [])]);
  const has = new Set<Col>([...key, ...(ix?.include ?? [])]);
  const missing = [...need].filter((x) => !has.has(x));
  const covered = !!ix && missing.length === 0;
  const orderByIndex = !!ix && !!q.orderBy && providesOrder(key, preds, q.orderBy);
  const limit = q.limit;
  const finish = (name: PathName, p: PathCost, sorted: boolean, available: boolean, why?: string): ToyPath => {
    const needSort = !!q.orderBy && !sorted;
    const sCost = needSort ? sortCost(rows, limit, c) : 0;
    let cost: number;
    if (needSort) cost = p.total + sCost; // a sort must read all its input first
    else if (limit !== null) cost = p.startup + (p.total - p.startup) * Math.min(1, limit / rows);
    else cost = p.total;
    return { name, cost, sorted: !needSort, sortCost: sCost, rowsRead: p.indexTuples || m.rows, heapPages: p.heapPages, available, why };
  };
  const paths: ToyPath[] = [finish("Seq Scan", seqScanCost(m, q.where.length, c), false, true)];
  const correlation = key.length ? TOY_CORR[key[0]!] : 0;
  const o: IndexScanOpts = { boundSel, indexSel, indexQuals: Math.max(1, idxCols.length), filterQuals: heapCols.length, correlation };
  // Without a seek column the scan reads the whole index; that is still a valid path.
  const useful = !!ix && (idxCols.length > 0 || orderByIndex || covered);
  const noIx = ix ? "the index has no column that the query uses" : "no index";
  paths.push(finish("Index Scan", indexScanCost(m, o, c), orderByIndex, useful, useful ? undefined : noIx));
  paths.push(finish("Bitmap Heap Scan", bitmapScanCost(m, o, c), false, !!ix && idxCols.length > 0, idxCols.length ? undefined : "a bitmap scan needs a predicate on an index column"));
  paths.push(finish("Index Only Scan", indexScanCost(m, { ...o, indexOnly: true, allVisible: 1 }, c), orderByIndex, covered, covered ? undefined : ix ? `the index lacks ${missing.join(", ")}` : "no index"));
  const best = paths.filter((p) => p.available).reduce((a, b) => (b.cost < a.cost ? b : a));
  return {
    use, covered, missing, orderByIndex, boundSel, indexSel, rows, paths, best,
    indexCond: seekCols.map((x) => TOY_PREDS[x].sql),
    indexFilter: idxCols.filter((x) => !seekCols.includes(x)).map((x) => TOY_PREDS[x].sql),
    heapFilter: heapCols.map((x) => TOY_PREDS[x].sql),
  };
}

// =====================================================================================
// Clustered (InnoDB) vs heap + TID (PostgreSQL) lookups on real B+ trees
// =====================================================================================

export const USERS = [
  "kim", "ada", "raj", "zoe", "bob", "eve", "lin", "max", "ann", "sam", "joe", "ivy",
  "tom", "uma", "pat", "dan", "fay", "ned", "gus", "cal", "hal", "ola", "vic", "wes",
];

export interface UserRow { id: number; email: string }
export const USER_ROWS: UserRow[] = USERS.map((n, i) => ({ id: i + 1, email: `${n}@x.io` }));
/** Rows per heap page in the small PostgreSQL model. */
export const HEAP_ROWS_PER_PAGE = 4;

export type Structure = "secondary" | "primary" | "heap" | "vm";
export interface PageRead { s: Structure; node: number; note: string }
export type Engine = "innodb" | "postgres";
export type LookupKind = "pk" | "email" | "email-id" | "email-range";

export interface LookupWorld {
  /** InnoDB clustered index: id → row. PostgreSQL index on id: id → TID. */
  primary: BPlusTree<number, number>;
  /** Index on email: → id (InnoDB) or → TID as page·100 + slot (PostgreSQL). */
  secondary: BPlusTree<string, number>;
  engine: Engine;
}

export function buildWorld(engine: Engine, order = 4): LookupWorld {
  const primary = new BPlusTree<number, number>({ order, compare: numCmp });
  const secondary = new BPlusTree<string, number>({ order, compare: strCmp });
  USER_ROWS.forEach((r, i) => {
    const tid = Math.floor(i / HEAP_ROWS_PER_PAGE) * 100 + (i % HEAP_ROWS_PER_PAGE) + 1;
    primary.insert(r.id, engine === "innodb" ? r.id : tid);
    secondary.insert(r.email, engine === "innodb" ? r.id : tid);
  });
  return { primary, secondary, engine };
}

/** Node ids visited by a point lookup, root first. */
function descend<K>(t: BPlusTree<K, number>, k: K): { path: number[]; value: number | undefined } {
  const path: number[] = [];
  t.listener = (e) => { if (e.t === "visit") path.push(e.id); };
  const value = t.get(k);
  t.listener = null;
  return { path, value };
}

/** Node ids visited by a range scan (descent, then the leaf chain). */
function rangeVisit<K>(t: BPlusTree<K, number>, lo: K, hi: K): { path: number[]; values: number[] } {
  const path: number[] = [];
  t.listener = (e) => { if (e.t === "visit" || e.t === "scan") if (!path.includes(e.id)) path.push(e.id); };
  const values = t.range(lo, hi).map(([, v]) => v);
  t.listener = null;
  return { path, values };
}

/**
 * Every page read of one lookup, in order. `allVisible` says whether the visibility map marks the
 * heap page all-visible (PostgreSQL index-only scans skip the heap then).
 */
export function lookupTrace(w: LookupWorld, kind: LookupKind, arg: { id?: number; email?: string; lo?: string; hi?: string }, allVisible = true): PageRead[] {
  const out: PageRead[] = [];
  const pk = (id: number) => {
    const d = descend(w.primary, id);
    d.path.forEach((n, i) => out.push({ s: "primary", node: n, note: i === d.path.length - 1 ? (w.engine === "innodb" ? `leaf holds the row for id ${id}` : `leaf holds id ${id} → TID`) : "inner node" }));
    return d.value;
  };
  const heap = (tid: number) => out.push({ s: "heap", node: Math.floor(tid / 100), note: `heap page ${Math.floor(tid / 100)}, slot ${tid % 100}` });
  if (kind === "pk") {
    const v = pk(arg.id!);
    if (w.engine === "postgres" && v !== undefined) heap(v);
    return out;
  }
  if (kind === "email" || kind === "email-id") {
    const d = descend(w.secondary, arg.email!);
    d.path.forEach((n, i) => out.push({ s: "secondary", node: n, note: i === d.path.length - 1 ? (w.engine === "innodb" ? `leaf: ${arg.email} → id ${d.value}` : `leaf: ${arg.email} → TID (${Math.floor(d.value! / 100)},${d.value! % 100})`) : "inner node" }));
    if (d.value === undefined) return out;
    if (w.engine === "innodb") {
      if (kind === "email") pk(d.value);
    } else if (kind === "email") heap(d.value);
    else {
      out.push({ s: "vm", node: 0, note: "visibility map: is the heap page all-visible?" });
      if (!allVisible) heap(d.value);
    }
    return out;
  }
  const r = rangeVisit(w.secondary, arg.lo!, arg.hi!);
  r.path.forEach((n) => out.push({ s: "secondary", node: n, note: "secondary index" }));
  for (const v of r.values) (w.engine === "innodb" ? pk(v) : heap(v));
  return out;
}

/** Point-lookup page reads at scale: secondary-index height plus clustered height (InnoDB) or plus one heap page (PostgreSQL). */
export function scaleReads(rows: number, o: { pkBytes: number; secKeyBytes: number; rowBytes: number; pageBytes: number }) {
  const head = 128, slot = 2, ptr = 8;
  const usable = o.pageBytes - head;
  const fanPk = Math.floor(usable / (o.pkBytes + ptr + slot));
  const leafRows = Math.floor(usable / (o.rowBytes + slot));
  const fanSec = Math.floor(usable / (o.secKeyBytes + ptr + slot));
  // InnoDB secondary leaves hold the key and the primary key; PostgreSQL leaves hold the key and a 6-byte TID.
  const hSec = levelSizes(rows, Math.floor(usable / (o.secKeyBytes + o.pkBytes + slot)), fanSec).length;
  const hPk = levelSizes(rows, leafRows, fanPk).length;
  const hSecPg = levelSizes(rows, Math.floor(usable / (o.secKeyBytes + 6 + slot)), fanSec).length;
  return { hPk, hSec, hSecPg, innodb: hSec + hPk, postgres: hSecPg + 1 };
}

/** Heap pages that one 8 KiB visibility-map page covers: 2 bits per heap page. */
export const VM_HEAP_PAGES_PER_PAGE = ((8192 - 24) * 8) / 2;
