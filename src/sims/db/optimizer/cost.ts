/**
 * A PostgreSQL-style cost model, written from src/backend/optimizer/path/costsize.c,
 * btcostestimate() / genericcostestimate() in selfuncs.c and index_pages_fetched().
 *
 * The scan formulas (seq scan, B-tree index scan, bitmap heap scan) follow PostgreSQL closely
 * and reproduce the "Using EXPLAIN" examples in the PostgreSQL documentation (tenk1). The join,
 * sort, aggregate and limit formulas keep the structure of costsize.c but simplify details
 * (hash bucket statistics, lossy bitmaps, parallel plans, JIT). Each function returns the
 * startup cost, the total cost and the terms that make them up, so a demo can show the
 * formula with the numbers filled in.
 */

export const BLCKSZ = 8192;
/** Page header (24 B) and the 4-byte line pointer per tuple. */
export const PAGE_HEADER = 24;
export const LINE_POINTER = 4;
/** MAXALIGN(SizeofHeapTupleHeader = 23) on 64-bit platforms. */
export const HEAP_TUPLE_HEADER = 24;
/** btcostestimate charges this many cpu_operator_cost per index page touched in the descent. */
export const DEFAULT_PAGE_CPU_MULTIPLIER = 50;

export interface CostParams {
  seqPageCost: number;
  randomPageCost: number;
  cpuTupleCost: number;
  cpuIndexTupleCost: number;
  cpuOperatorCost: number;
  /** effective_cache_size, in 8 KiB pages. */
  effectiveCacheSize: number;
  /** work_mem in bytes. */
  workMem: number;
  hashMemMultiplier: number;
}

/** PostgreSQL defaults (PostgreSQL 15 and later: hash_mem_multiplier = 2.0). */
export const PG_DEFAULTS: CostParams = {
  seqPageCost: 1.0,
  randomPageCost: 4.0,
  cpuTupleCost: 0.01,
  cpuIndexTupleCost: 0.005,
  cpuOperatorCost: 0.0025,
  effectiveCacheSize: (4 * 2 ** 30) / BLCKSZ, // 4 GB = 524,288 pages
  workMem: 4 * 2 ** 20,
  hashMemMultiplier: 2.0,
};

export interface TableStats { name: string; rows: number; pages: number; width: number }
export interface IndexStats {
  name: string;
  pages: number;
  tuples: number;
  /** Levels above the leaves (0 = the root is a leaf). */
  height: number;
  /** pg_stats.correlation of the leading column: -1..1, physical order vs index order. */
  correlation: number;
  unique?: boolean;
}

/** One part of a cost: a label, the formula with numbers filled in, and its value. */
export interface Term { label: string; expr: string; value: number; phase: "startup" | "run" }
export interface PathCost {
  startup: number;
  total: number;
  /** Estimated output rows (after every qual). */
  rows: number;
  terms: Term[];
  /** Heap pages the path is expected to fetch (scans only). */
  heapPages?: number;
  /** Cost of the Bitmap Index Scan child, for bitmap heap scans. */
  child?: PathCost;
}

const r2 = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
/** Formats a number for a formula string. */
export const fnum = (v: number) => (Number.isInteger(v) ? v.toLocaleString("en-US") : r2(v));

/** clamp_row_est(): round, and never less than one row. */
export const clampRows = (x: number) => (x <= 1 ? 1 : Math.round(x));
export const maxAlign = (n: number) => Math.ceil(n / 8) * 8;

/** Heap pages for `rows` tuples of `width` bytes (fill factor 100). */
export function heapPages(rows: number, width: number): number {
  const perPage = Math.floor((BLCKSZ - PAGE_HEADER) / (HEAP_TUPLE_HEADER + maxAlign(width) + LINE_POINTER));
  return Math.ceil(rows / perPage);
}

/** A B-tree on a key of `keyWidth` bytes: 90% full leaves (the B-tree default fill factor), plus inner pages and the metapage. */
export function btreeShape(tuples: number, keyWidth = 4): { pages: number; height: number; leaves: number } {
  const item = maxAlign(8 + keyWidth) + LINE_POINTER; // IndexTupleData header + key, plus a line pointer
  const usable = BLCKSZ - PAGE_HEADER - 16; // page header and B-tree special space
  const perLeaf = Math.floor((usable * 0.9) / item);
  const perInner = Math.floor((usable * 0.7) / item);
  const leaves = Math.max(1, Math.ceil(tuples / perLeaf));
  let level = leaves, pages = leaves, height = 0;
  while (level > 1) { level = Math.ceil(level / perInner); pages += level; height++; }
  return { pages: pages + 1, height, leaves };
}

/**
 * index_pages_fetched(): the Mackert–Lohman estimate of distinct pages fetched when
 * `tuplesFetched` tuples are read in random order from a relation of `T` pages, with an LRU
 * cache whose size is this relation's pro-rated share of effective_cache_size.
 */
export function indexPagesFetched(tuplesFetched: number, T: number, indexPages: number, p: CostParams, totalTablePages = T): number {
  T = Math.max(T, 1);
  const totalPages = Math.max(totalTablePages + indexPages, 1);
  let b = (p.effectiveCacheSize * T) / totalPages;
  b = b <= 1 ? 1 : Math.ceil(b);
  const N = tuplesFetched;
  if (T <= b) {
    const pf = (2 * T * N) / (2 * T + N);
    return pf >= T ? T : Math.ceil(pf);
  }
  const lim = (2 * T * b) / (2 * T - b);
  const pf = N <= lim ? (2 * T * N) / (2 * T + N) : b + ((N - lim) * (T - b)) / T;
  return Math.ceil(pf);
}

/** Seq Scan: read every page in order, look at every tuple, evaluate the quals on each. */
export function seqScanCost(t: TableStats, nQuals: number, sel: number, p: CostParams = PG_DEFAULTS): PathCost {
  const io = p.seqPageCost * t.pages;
  const cpu = (p.cpuTupleCost + nQuals * p.cpuOperatorCost) * t.rows;
  const terms: Term[] = [
    { label: "read every page in order", expr: `${fnum(t.pages)} pages × seq_page_cost ${fnum(p.seqPageCost)}`, value: io, phase: "run" },
    { label: "process every tuple", expr: `${fnum(t.rows)} tuples × cpu_tuple_cost ${fnum(p.cpuTupleCost)}`, value: p.cpuTupleCost * t.rows, phase: "run" },
  ];
  if (nQuals > 0) terms.push({ label: "evaluate the filter", expr: `${fnum(t.rows)} tuples × ${nQuals} × cpu_operator_cost ${fnum(p.cpuOperatorCost)}`, value: nQuals * p.cpuOperatorCost * t.rows, phase: "run" });
  return { startup: 0, total: io + cpu, rows: clampRows(sel * t.rows), terms, heapPages: t.pages };
}

/** The index part of an index scan (genericcostestimate + btcostestimate descent costs). */
export function btreeIndexCost(idx: IndexStats, tableRows: number, sel: number, nIndexQuals: number, loopCount: number, p: CostParams = PG_DEFAULTS, totalTablePages = 0) {
  const numIndexTuples = Math.max(1, Math.round(sel * tableRows));
  const numIndexPages = idx.pages > 1 && idx.tuples > 1 ? Math.ceil((numIndexTuples * idx.pages) / idx.tuples) : 1;
  let io: number;
  if (loopCount > 1) {
    const pf = indexPagesFetched(numIndexPages * loopCount, idx.pages, idx.pages, p, totalTablePages);
    io = (pf * p.randomPageCost) / loopCount;
  } else io = numIndexPages * p.randomPageCost;
  const cpu = numIndexTuples * (p.cpuIndexTupleCost + nIndexQuals * p.cpuOperatorCost);
  const descentCmp = idx.tuples > 1 ? Math.ceil(Math.log2(idx.tuples)) * p.cpuOperatorCost : 0;
  const descentPages = (idx.height + 1) * DEFAULT_PAGE_CPU_MULTIPLIER * p.cpuOperatorCost;
  const startup = descentCmp + descentPages;
  const terms: Term[] = [
    { label: "descend the B-tree: comparisons", expr: `⌈log₂ ${fnum(idx.tuples)}⌉ = ${Math.ceil(Math.log2(Math.max(2, idx.tuples)))} × ${fnum(p.cpuOperatorCost)}`, value: descentCmp, phase: "startup" },
    { label: "descend the B-tree: pages", expr: `(height ${idx.height} + 1) × 50 × ${fnum(p.cpuOperatorCost)}`, value: descentPages, phase: "startup" },
    { label: "read leaf pages", expr: loopCount > 1 ? `Mackert–Lohman over ${fnum(loopCount)} loops × random_page_cost ${fnum(p.randomPageCost)}` : `${fnum(numIndexPages)} pages × random_page_cost ${fnum(p.randomPageCost)}`, value: io, phase: "run" },
    { label: "process index entries", expr: `${fnum(numIndexTuples)} entries × (${fnum(p.cpuIndexTupleCost)} + ${nIndexQuals} × ${fnum(p.cpuOperatorCost)})`, value: cpu, phase: "run" },
  ];
  return { startup, total: startup + io + cpu, numIndexTuples, numIndexPages, terms };
}

export interface ScanOpts {
  /** Quals the index can use (Index Cond). Default 1. */
  nIndexQuals?: number;
  /** Other quals, checked on each heap tuple (Filter). Default 0. */
  nFilterQuals?: number;
  /** Selectivity of the Filter quals. Default 1. */
  filterSel?: number;
  /** Number of times the scan runs (the inner side of a nested loop). Default 1. */
  loopCount?: number;
  /** Pages of all tables in the query (PostgreSQL's root->total_table_pages). Default: this table. */
  totalTablePages?: number;
}

/** Index Scan: walk the index for the matching entries, fetch each heap tuple. */
export function indexScanCost(t: TableStats, idx: IndexStats, sel: number, o: ScanOpts = {}, p: CostParams = PG_DEFAULTS): PathCost {
  const nIdx = o.nIndexQuals ?? 1, nF = o.nFilterQuals ?? 0, fs = o.filterSel ?? 1, loops = o.loopCount ?? 1, ttp = o.totalTablePages ?? t.pages;
  const ic = btreeIndexCost(idx, t.rows, sel, nIdx, loops, p, ttp);
  const tuplesFetched = clampRows(sel * t.rows);
  let maxIO: number, minIO: number, pfMax: number;
  const pfMin0 = Math.ceil(sel * t.pages);
  if (loops > 1) {
    pfMax = indexPagesFetched(tuplesFetched * loops, t.pages, idx.pages, p, ttp);
    maxIO = (pfMax * p.randomPageCost) / loops;
    const pfMin = indexPagesFetched(pfMin0 * loops, t.pages, idx.pages, p, ttp);
    minIO = (pfMin * p.randomPageCost) / loops;
    pfMax /= loops;
  } else {
    pfMax = indexPagesFetched(tuplesFetched, t.pages, idx.pages, p, ttp);
    maxIO = pfMax * p.randomPageCost;
    minIO = pfMin0 > 0 ? p.randomPageCost + (pfMin0 - 1) * p.seqPageCost : 0;
  }
  const c2 = idx.correlation * idx.correlation;
  const io = maxIO + c2 * (minIO - maxIO);
  const cpu = (p.cpuTupleCost + nF * p.cpuOperatorCost) * tuplesFetched;
  const terms: Term[] = [
    ...ic.terms,
    { label: "fetch heap pages", expr: `${fnum(maxIO)} (random) + corr² ${fnum(c2)} × (${fnum(minIO)} − ${fnum(maxIO)})`, value: io, phase: "run" },
    { label: "process heap tuples", expr: `${fnum(tuplesFetched)} tuples × (${fnum(p.cpuTupleCost)}${nF ? ` + ${nF} × ${fnum(p.cpuOperatorCost)}` : ""})`, value: cpu, phase: "run" },
  ];
  return { startup: ic.startup, total: ic.total + io + cpu, rows: clampRows(sel * fs * t.rows), terms, heapPages: pfMax + c2 * (pfMin0 - pfMax) };
}

/** Bitmap Heap Scan over a Bitmap Index Scan: collect matching TIDs, sort them by page, fetch each page once. */
export function bitmapScanCost(t: TableStats, idx: IndexStats, sel: number, o: ScanOpts = {}, p: CostParams = PG_DEFAULTS): PathCost {
  const nIdx = o.nIndexQuals ?? 1, nF = o.nFilterQuals ?? 0, fs = o.filterSel ?? 1;
  const ic = btreeIndexCost(idx, t.rows, sel, nIdx, 1, p, o.totalTablePages ?? t.pages);
  const rows = clampRows(sel * fs * t.rows);
  const child: PathCost = { startup: 0, total: ic.total, rows: clampRows(sel * t.rows), terms: ic.terms };
  const bitmapCpu = 0.1 * p.cpuOperatorCost * rows;
  const startup = ic.total + bitmapCpu;
  const tf = clampRows(sel * t.rows);
  const T = t.pages;
  let pf = (2 * T * tf) / (2 * T + tf);
  pf = pf >= T ? T : Math.ceil(pf);
  const cpp = pf >= 2 ? p.randomPageCost - (p.randomPageCost - p.seqPageCost) * Math.sqrt(pf / T) : p.randomPageCost;
  const io = pf * cpp;
  const cpu = (p.cpuTupleCost + (nIdx + nF) * p.cpuOperatorCost) * tf;
  const terms: Term[] = [
    { label: "Bitmap Index Scan (whole index part)", expr: `${fnum(ic.total)}`, value: ic.total, phase: "startup" },
    { label: "build the bitmap", expr: `0.1 × ${fnum(p.cpuOperatorCost)} × ${fnum(rows)} rows`, value: bitmapCpu, phase: "startup" },
    { label: "fetch heap pages in page order", expr: `${fnum(pf)} pages × (${fnum(p.randomPageCost)} − ${fnum(p.randomPageCost - p.seqPageCost)} × √(${fnum(pf)}/${fnum(T)})) = ${fnum(pf)} × ${fnum(cpp)}`, value: io, phase: "run" },
    { label: "recheck and process tuples", expr: `${fnum(tf)} tuples × (${fnum(p.cpuTupleCost)} + ${nIdx + nF} × ${fnum(p.cpuOperatorCost)})`, value: cpu, phase: "run" },
  ];
  return { startup, total: startup + io + cpu, rows, terms, heapPages: pf, child };
}

export type AccessPath = "seq" | "index" | "bitmap";
export const PATH_LABEL: Record<AccessPath, string> = { seq: "Seq Scan", index: "Index Scan", bitmap: "Bitmap Heap Scan" };

/** Cost of fetching only the first `limit` rows: startup + (total − startup) × limit / rows (cost_limit). */
export function limitedCost(c: { startup: number; total: number; rows: number }, limit?: number): number {
  if (limit === undefined || limit >= c.rows) return c.total;
  return c.startup + ((c.total - c.startup) * limit) / c.rows;
}

/** All three access paths for `WHERE col < const` on one table with a B-tree on col; the cheapest wins. */
export function accessPaths(t: TableStats, idx: IndexStats, sel: number, p: CostParams = PG_DEFAULTS, limit?: number) {
  const paths: Record<AccessPath, PathCost> = {
    seq: seqScanCost(t, 1, sel, p),
    index: indexScanCost(t, idx, sel, {}, p),
    bitmap: bitmapScanCost(t, idx, sel, {}, p),
  };
  const order: AccessPath[] = ["index", "bitmap", "seq"];
  let best: AccessPath = "seq";
  for (const k of order) if (limitedCost(paths[k], limit) < limitedCost(paths[best], limit) - 1e-9) best = k;
  return { paths, best };
}

export function cheapestPath(t: TableStats, idx: IndexStats, sel: number, p: CostParams = PG_DEFAULTS): AccessPath {
  return accessPaths(t, idx, sel, p).best;
}

/** Selectivities (log scale, 1e-6..1) at which the cheapest path changes. */
export function planFlips(t: TableStats, idx: IndexStats, p: CostParams = PG_DEFAULTS, lo = 1e-6, hi = 1, steps = 400) {
  const flips: { sel: number; from: AccessPath; to: AccessPath }[] = [];
  let prevSel = lo, prev = cheapestPath(t, idx, lo, p);
  for (let i = 1; i <= steps; i++) {
    const s = lo * Math.pow(hi / lo, i / steps);
    const c = cheapestPath(t, idx, s, p);
    if (c !== prev) {
      let a = prevSel, b = s;
      for (let k = 0; k < 50; k++) { const m = Math.sqrt(a * b); if (cheapestPath(t, idx, m, p) === prev) a = m; else b = m; }
      flips.push({ sel: b, from: prev, to: c });
    }
    prev = c; prevSel = s;
  }
  return flips;
}

// ---------------------------------------------------------------------------------------
// Example tables
// ---------------------------------------------------------------------------------------

/** tenk1 from the PostgreSQL regression database, as used in the "Using EXPLAIN" chapter. */
export const TENK1: TableStats = { name: "tenk1", rows: 10000, pages: 345, width: 244 };
export const TENK1_UNIQUE1: IndexStats = { name: "tenk1_unique1", pages: 30, tuples: 10000, height: 1, correlation: 0, unique: true };

/** A larger table, for the effect of effective_cache_size: 100 million rows of 80 bytes. */
export const EVENTS: TableStats = { name: "events", rows: 1e8, pages: heapPages(1e8, 80), width: 80 };
export const EVENTS_TS: IndexStats = (() => { const s = btreeShape(1e8, 8); return { name: "events_ts_idx", pages: s.pages, tuples: 1e8, height: s.height, correlation: 0 }; })();

// ---------------------------------------------------------------------------------------
// Joins, sorts, aggregates
// ---------------------------------------------------------------------------------------

export interface Input { startup: number; total: number; rows: number; width: number }

/** Hash join: build a hash table on the inner input, then probe it with each outer row. */
export function hashJoinCost(outer: Input, inner: Input, outRows: number, innerNdistinct: number, p: CostParams = PG_DEFAULTS, nClauses = 1) {
  const build = (p.cpuOperatorCost * nClauses + p.cpuTupleCost) * inner.rows;
  const hashOuter = p.cpuOperatorCost * nClauses * outer.rows;
  const perBucket = Math.max(1, inner.rows / Math.max(1, innerNdistinct));
  const probe = p.cpuOperatorCost * nClauses * outer.rows * perBucket * 0.5;
  const out = p.cpuTupleCost * outRows;
  const hb = hashBatches(inner.rows, inner.width, p);
  let spillStart = 0, spillRun = 0;
  if (hb.batches > 1) {
    const ip = Math.ceil((inner.rows * (maxAlign(inner.width) + HEAP_TUPLE_HEADER)) / BLCKSZ);
    const op = Math.ceil((outer.rows * (maxAlign(outer.width) + HEAP_TUPLE_HEADER)) / BLCKSZ);
    spillStart = p.seqPageCost * ip;
    spillRun = p.seqPageCost * (ip + 2 * op);
  }
  const startup = outer.startup + inner.total + build + spillStart;
  const total = startup + (outer.total - outer.startup) + hashOuter + probe + out + spillRun;
  const terms: Term[] = [
    { label: "build the hash table", expr: `${fnum(inner.rows)} inner rows × (${fnum(p.cpuOperatorCost)} + ${fnum(p.cpuTupleCost)})`, value: build, phase: "startup" },
    { label: "hash each outer row", expr: `${fnum(outer.rows)} × ${fnum(p.cpuOperatorCost)}`, value: hashOuter, phase: "run" },
    { label: "compare in the bucket", expr: `${fnum(outer.rows)} × ${fnum(perBucket)} × 0.5 × ${fnum(p.cpuOperatorCost)}`, value: probe, phase: "run" },
    { label: "emit joined rows", expr: `${fnum(outRows)} × ${fnum(p.cpuTupleCost)}`, value: out, phase: "run" },
  ];
  if (hb.batches > 1) terms.push({ label: `spill to ${hb.batches} batches`, expr: `write and read both inputs once`, value: spillStart + spillRun, phase: "run" });
  return { startup, total, rows: outRows, terms, ...hb };
}

/** Hash table memory and batch count (ExecChooseHashTableSize, simplified). */
export function hashBatches(rows: number, width: number, p: CostParams = PG_DEFAULTS) {
  const tupBytes = 16 + 16 + maxAlign(width); // HJTUPLE_OVERHEAD + MinimalTuple header + data
  const bytes = rows * tupBytes;
  const hashMem = p.workMem * p.hashMemMultiplier;
  let batches = 1;
  while (bytes / batches > hashMem) batches *= 2;
  let buckets = 1024;
  while (buckets < rows / batches && buckets < 1 << 30) buckets *= 2;
  return { batches, buckets, hashBytes: bytes / batches + buckets * 8 };
}

/**
 * Nested loop: for each outer row, run the inner plan again. `inner` is the cost of ONE run of the
 * inner side (for an index scan, computed with loopCount = outer rows). Each candidate pair costs
 * cpu_tuple_cost plus the join filter.
 */
export function nestLoopCost(outer: Input, inner: Input, outRows: number, p: CostParams = PG_DEFAULTS, nJoinFilter = 0) {
  const startup = outer.startup + inner.startup;
  const rescans = outer.rows * (inner.total - inner.startup) + Math.max(0, outer.rows - 1) * inner.startup;
  const pairs = outer.rows * inner.rows;
  const cpu = (p.cpuTupleCost + nJoinFilter * p.cpuOperatorCost) * pairs;
  const total = startup + (outer.total - outer.startup) + rescans + cpu;
  const terms: Term[] = [
    { label: "run the inner side once per outer row", expr: `${fnum(outer.rows)} × ${fnum(inner.total)}`, value: rescans, phase: "run" },
    { label: "check each pair", expr: `${fnum(pairs)} pairs × (${fnum(p.cpuTupleCost)}${nJoinFilter ? ` + ${nJoinFilter} × ${fnum(p.cpuOperatorCost)}` : ""})`, value: cpu, phase: "run" },
  ];
  return { startup, total, rows: outRows, terms };
}

/** Materialize: store the inner rows once, then re-read them from memory on each rescan. */
export function materializeCost(inner: Input, p: CostParams = PG_DEFAULTS) {
  return { startup: inner.startup, total: inner.total + 2 * p.cpuOperatorCost * inner.rows, rescan: p.cpuOperatorCost * inner.rows };
}

/** tuplesort_merge_order(): how many runs one merge pass can combine with this much memory. */
export function mergeOrder(memBytes: number): number {
  const MERGE_BUFFER_SIZE = BLCKSZ * 32, TAPE_BUFFER_OVERHEAD = BLCKSZ;
  return Math.max(6, Math.min(500, Math.floor((memBytes - TAPE_BUFFER_OVERHEAD) / (MERGE_BUFFER_SIZE + TAPE_BUFFER_OVERHEAD))));
}

export type SortMethod = "quicksort" | "top-N heapsort" | "external merge";

/** Sort (cost_sort): N log2 N comparisons at 2 × cpu_operator_cost; extra page I/O when the input does not fit in work_mem. */
export function sortCost(input: Input, p: CostParams = PG_DEFAULTS, bound?: number) {
  const N = Math.max(2, input.rows);
  const cmp = 2 * p.cpuOperatorCost;
  const bytes = N * (maxAlign(input.width) + HEAP_TUPLE_HEADER);
  let method: SortMethod, startupOwn: number, diskKb = 0, memKb = 0, passes = 0;
  if (bound !== undefined && bound * 2 * (maxAlign(input.width) + HEAP_TUPLE_HEADER) <= p.workMem && bound < N / 2) {
    method = "top-N heapsort";
    startupOwn = cmp * N * Math.log2(2 * bound);
    memKb = Math.max(25, Math.ceil((bound * (maxAlign(input.width) + 64)) / 1024));
  } else if (bytes > p.workMem) {
    method = "external merge";
    const npages = Math.ceil(bytes / BLCKSZ);
    const nruns = bytes / p.workMem;
    const mo = mergeOrder(p.workMem);
    passes = nruns <= mo ? 1 : Math.ceil(Math.log(nruns) / Math.log(mo));
    const npa = 2 * npages * passes;
    startupOwn = cmp * N * Math.log2(N) + npa * (p.seqPageCost * 0.75 + p.randomPageCost * 0.25);
    diskKb = Math.ceil((N * (maxAlign(input.width) + 8)) / 1024);
  } else {
    method = "quicksort";
    startupOwn = cmp * N * Math.log2(N);
    memKb = Math.ceil((N * (maxAlign(input.width) + 40)) / 1024);
  }
  const outRows = bound !== undefined ? Math.min(bound, input.rows) : input.rows;
  const startup = input.total + startupOwn;
  return { startup, total: startup + p.cpuOperatorCost * outRows, rows: outRows, method, diskKb, memKb, passes, bytes };
}

/** HashAggregate: hash every input row on the group key, update the aggregates, emit one row per group. */
export function hashAggCost(input: Input, groups: number, nGroupCols: number, nAggs: number, p: CostParams = PG_DEFAULTS) {
  const startup = input.total + p.cpuOperatorCost * (nGroupCols + nAggs) * input.rows;
  return { startup, total: startup + p.cpuTupleCost * groups + p.cpuOperatorCost * nAggs * groups, rows: groups };
}

/** Plain Aggregate (no GROUP BY): one output row. */
export function aggCost(input: Input, nAggs: number, p: CostParams = PG_DEFAULTS) {
  const t = input.total + p.cpuOperatorCost * nAggs * input.rows;
  return { startup: t, total: t + p.cpuTupleCost, rows: 1 };
}

/** Limit: the cost of the first `n` rows of the input. */
export function limitCost(input: Input, n: number) {
  return { startup: input.startup, total: limitedCost(input, n), rows: Math.min(n, input.rows) };
}

// ---------------------------------------------------------------------------------------
// Join demo for lesson 1: customers (filtered to k rows) joined to orders
// ---------------------------------------------------------------------------------------

export const CUSTOMERS: TableStats = { name: "customers", rows: 100000, pages: heapPages(100000, 64), width: 64 };
export const ORDERS: TableStats = { name: "orders", rows: 1000000, pages: heapPages(1000000, 48), width: 48 };
export const ORDERS_CUSTOMER_IDX: IndexStats = (() => { const s = btreeShape(1e6, 4); return { name: "orders_customer_id_idx", pages: s.pages, tuples: 1e6, height: s.height, correlation: 0 }; })();

export type JoinMethod = "hash" | "indexnl" | "nl";
export const JOIN_LABEL: Record<JoinMethod, string> = { hash: "Hash Join", indexnl: "Nested Loop + Index Scan", nl: "Nested Loop + Seq Scan" };

/** `customers c JOIN orders o ON o.customer_id = c.id WHERE <filter on c giving k rows>`: the three join methods. */
export function joinMethods(k: number, p: CostParams = PG_DEFAULTS) {
  const c = CUSTOMERS, o = ORDERS;
  const outer0 = seqScanCost(c, 1, k / c.rows, p);
  const outer: Input = { startup: outer0.startup, total: outer0.total, rows: k, width: c.width };
  const perCustomer = o.rows / c.rows;
  const outRows = k * perCustomer;
  const ttp = c.pages + o.pages;
  const oScan = seqScanCost(o, 0, 1, p);
  const oIn: Input = { startup: 0, total: oScan.total, rows: o.rows, width: o.width };
  // Hash join: build on the filtered customers, probe with all orders.
  const hash = hashJoinCost(oIn, outer, outRows, k, p);
  const idx = indexScanCost(o, ORDERS_CUSTOMER_IDX, 1 / c.rows, { loopCount: k, totalTablePages: ttp }, p);
  const indexnl = nestLoopCost(outer, { startup: idx.startup, total: idx.total, rows: perCustomer, width: o.width }, outRows, p);
  const nl = nestLoopCost(outer, oIn, outRows, p, 1);
  const costs: Record<JoinMethod, { startup: number; total: number }> = { hash, indexnl, nl };
  let best: JoinMethod = "hash";
  for (const m of ["indexnl", "nl"] as JoinMethod[]) if (costs[m].total < costs[best].total) best = m;
  return { costs, best, outRows, perLoop: idx };
}

/** Outer row count where the index nested loop stops being cheaper than the hash join. */
export function joinCrossover(p: CostParams = PG_DEFAULTS): number {
  let a = 1, b = CUSTOMERS.rows;
  if (joinMethods(b, p).costs.indexnl.total < joinMethods(b, p).costs.hash.total) return Infinity;
  for (let i = 0; i < 60; i++) { const m = Math.sqrt(a * b); const r = joinMethods(m, p).costs; if (r.indexnl.total < r.hash.total) a = m; else b = m; }
  return b;
}
