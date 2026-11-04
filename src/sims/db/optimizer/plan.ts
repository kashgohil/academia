/**
 * Plan trees with estimates and "actual" execution numbers, rendered like PostgreSQL's
 * EXPLAIN (ANALYZE, BUFFERS) and MySQL's EXPLAIN FORMAT=TREE.
 *
 * Estimates come from cost.ts. Actual numbers come from a small execution model: the true row
 * counts of each scenario, a buffer cache hit fraction per table, and the TIME constants below.
 * PostgreSQL reports actual time and rows per loop (averages), and buffers as totals that include
 * the children; this model does the same, so every number in a rendered plan is consistent with
 * the numbers below and above it.
 */
import {
  PG_DEFAULTS, seqScanCost, indexScanCost, bitmapScanCost, hashJoinCost, hashBatches, nestLoopCost, materializeCost,
  sortCost, hashAggCost, limitCost, heapPages, accessPaths, btreeShape, maxAlign, BLCKSZ, PAGE_HEADER, HEAP_TUPLE_HEADER, LINE_POINTER,
  type CostParams, type TableStats, type IndexStats, type Input, type Term, type SortMethod, type AccessPath,
} from "./cost";

/** Execution time model (milliseconds). */
export const TIME = {
  /** Find a page in shared buffers and pin it. */
  hitMs: 0.0004,
  /** Read a page that is next to the previous one (OS read-ahead, sequential). */
  seqReadMs: 0.012,
  /** Read a page at a random position (OS cache miss on an SSD). */
  randReadMs: 0.1,
  /** Pass one tuple through one plan node. */
  tupleMs: 0.00005,
  /** Evaluate one operator (a comparison, a hash). */
  opMs: 0.00004,
  /** One comparison inside a sort. */
  cmpMs: 0.00001,
  /** Write or read one 8 KiB page of a temporary file. */
  tempPageMs: 0.05,
};

export interface Prop { key: string; value: string; runtime?: boolean }
export interface PNode {
  id: number;
  op: string;
  /** "on orders o", "using orders_pkey on orders o" */
  target: string;
  est: { startup: number; total: number; rows: number; width: number };
  /** Per loop: ms and rows. */
  act: { startup: number; total: number; rows: number; loops: number };
  /** Totals for all loops, children included. */
  buf: { hit: number; read: number; tempRead: number; tempWritten: number };
  props: Prop[];
  children: PNode[];
  /** What the node does, in one or two sentences. */
  note: string;
  /** Terms of this node's own cost. */
  terms: Term[];
  /** MySQL TREE line for this node, if it has one. */
  mysql?: string;
  /** Extra MySQL wrapper line above it (for example a Filter). */
  mysqlWrap?: string;
}

const tuplesPerPage = (width: number) => Math.floor((BLCKSZ - PAGE_HEADER) / (HEAP_TUPLE_HEADER + maxAlign(width) + LINE_POINTER));
/** Expected distinct pages touched by k random tuples in T pages (Cardenas). */
export const distinctPages = (k: number, T: number) => T * (1 - Math.pow(1 - 1 / T, k));

const sumBuf = (own: PNode["buf"], ch: PNode[]) => ({
  hit: own.hit + ch.reduce((a, c) => a + c.buf.hit, 0),
  read: own.read + ch.reduce((a, c) => a + c.buf.read, 0),
  tempRead: own.tempRead + ch.reduce((a, c) => a + c.buf.tempRead, 0),
  tempWritten: own.tempWritten + ch.reduce((a, c) => a + c.buf.tempWritten, 0),
});
const noBuf = { hit: 0, read: 0, tempRead: 0, tempWritten: 0 };
const asInput = (n: PNode): Input => ({ startup: n.est.startup, total: n.est.total, rows: n.est.rows, width: n.est.width });
/** Total ms of all loops of a node. */
const allLoopsMs = (n: PNode) => n.act.total * n.act.loops;

export class PlanBuilder {
  private next = 0;
  constructor(readonly p: CostParams = PG_DEFAULTS) {}

  private node(x: Omit<PNode, "id">): PNode { return { id: this.next++, ...x }; }

  seqScan(o: { table: TableStats; alias: string; filter?: string; nQuals?: number; estSel?: number; trueRows: number; cache: number; width: number; loops?: number }): PNode {
    const nQ = o.nQuals ?? (o.filter ? 1 : 0), loops = o.loops ?? 1;
    const c = seqScanCost(o.table, nQ, o.estSel ?? 1, this.p);
    const pages = o.table.pages;
    const hit = Math.round(pages * o.cache), read = pages - hit;
    const ms = hit * TIME.hitMs + read * TIME.seqReadMs + o.table.rows * (TIME.tupleMs + nQ * TIME.opMs);
    const props: Prop[] = [];
    if (o.filter) {
      props.push({ key: "Filter", value: o.filter });
      props.push({ key: "Rows Removed by Filter", value: String(o.table.rows - o.trueRows), runtime: true });
    }
    return this.node({
      op: "Seq Scan", target: `on ${o.table.name} ${o.alias}`,
      est: { startup: c.startup, total: c.total, rows: c.rows, width: o.width },
      act: { startup: ms / Math.max(1, o.trueRows) + 0.005, total: ms, rows: o.trueRows, loops },
      buf: { hit: hit * loops + 0, read, tempRead: 0, tempWritten: 0 },
      props, children: [], terms: c.terms,
      note: `Reads all ${pages.toLocaleString("en-US")} pages of ${o.table.name} in physical order and checks every row${o.filter ? " against the filter" : ""}.`,
      mysql: `Table scan on ${o.alias}`, mysqlWrap: o.filter ? `Filter: ${o.filter}` : undefined,
    });
  }

  indexScan(o: {
    table: TableStats; idx: IndexStats; alias: string; cond: string; estSel: number; estLoops?: number;
    trueRowsPerLoop: number; loops?: number; cacheHeap: number; cacheIdx: number; width: number; totalTablePages?: number; mysqlCond?: string;
  }): PNode {
    const loops = o.loops ?? 1, estLoops = o.estLoops ?? 1;
    const c = indexScanCost(o.table, o.idx, o.estSel, { loopCount: estLoops, totalTablePages: o.totalTablePages }, this.p);
    const k = o.trueRowsPerLoop;
    const sh = btreeShape(o.idx.tuples, 8);
    const perLeaf = Math.max(1, Math.floor(o.idx.tuples / sh.leaves));
    const idxPages = o.idx.height + 1 + Math.max(0, Math.ceil(k / perLeaf) - 1);
    const correlated = Math.abs(o.idx.correlation) > 0.9;
    const heap = k === 0 ? 0 : correlated ? Math.ceil(k / tuplesPerPage(o.table.width)) + 1 : Math.round(distinctPages(k, o.table.pages));
    const acc = loops * (idxPages + heap);
    const idxHit = Math.round(loops * idxPages * o.cacheIdx), heapHit = Math.round(loops * heap * o.cacheHeap);
    const hit = idxHit + heapHit, read = acc - hit;
    const readMs = (loops * idxPages - idxHit) * TIME.randReadMs + (loops * heap - heapHit) * (correlated ? TIME.seqReadMs : TIME.randReadMs);
    const msAll = hit * TIME.hitMs + readMs + loops * k * TIME.tupleMs;
    const ms = msAll / loops;
    return this.node({
      op: "Index Scan", target: `using ${o.idx.name} on ${o.table.name} ${o.alias}`,
      est: { startup: c.startup, total: c.total, rows: c.rows, width: o.width },
      act: { startup: Math.min(ms, (o.idx.height + 1) * (TIME.hitMs + TIME.randReadMs * (1 - o.cacheIdx)) + 0.003), total: ms, rows: k, loops },
      buf: { hit, read, tempRead: 0, tempWritten: 0 },
      props: [{ key: "Index Cond", value: o.cond }], children: [], terms: c.terms,
      note: `Walks ${o.idx.name} from the root to the first match, reads matching index entries in key order, and fetches each row from the heap.${loops > 1 ? ` It runs once for each outer row: ${loops.toLocaleString("en-US")} times.` : ""}`,
      mysql: `Index lookup on ${o.alias} using ${o.idx.name} (${o.mysqlCond ?? o.cond.replace(/^\(|\)$/g, "")})`,
    });
  }

  bitmapScan(o: { table: TableStats; idx: IndexStats; alias: string; cond: string; estSel: number; trueRows: number; cacheHeap: number; cacheIdx: number; width: number; mysqlRange?: string }): PNode {
    const c = bitmapScanCost(o.table, o.idx, o.estSel, {}, this.p);
    const k = o.trueRows;
    const sh = btreeShape(o.idx.tuples, 8);
    const idxPages = o.idx.height + 1 + Math.max(0, Math.ceil(k / Math.max(1, Math.floor(o.idx.tuples / sh.leaves))) - 1);
    const correlated = Math.abs(o.idx.correlation) > 0.9;
    const heap = correlated ? Math.ceil(k / tuplesPerPage(o.table.width)) + 1 : Math.round(distinctPages(k, o.table.pages));
    const ih = Math.round(idxPages * o.cacheIdx), hh = Math.round(heap * o.cacheHeap);
    const idxMs = ih * TIME.hitMs + (idxPages - ih) * TIME.seqReadMs + k * TIME.opMs;
    const child = this.node({
      op: "Bitmap Index Scan", target: `on ${o.idx.name}`,
      est: { startup: 0, total: c.child!.total, rows: c.child!.rows, width: 0 },
      act: { startup: idxMs, total: idxMs, rows: k, loops: 1 },
      buf: { hit: ih, read: idxPages - ih, tempRead: 0, tempWritten: 0 },
      props: [{ key: "Index Cond", value: o.cond }], children: [], terms: c.child!.terms,
      note: `Reads the matching index entries and sets one bit per row (or page) in an in-memory bitmap. It returns the bitmap, not rows, so its width is 0.`,
    });
    const heapMs = hh * TIME.hitMs + (heap - hh) * (correlated ? TIME.seqReadMs : TIME.randReadMs * 0.6) + k * (TIME.tupleMs + TIME.opMs);
    return this.node({
      op: "Bitmap Heap Scan", target: `on ${o.table.name} ${o.alias}`,
      est: { startup: c.startup, total: c.total, rows: c.rows, width: o.width },
      act: { startup: idxMs + 0.01, total: idxMs + heapMs, rows: k, loops: 1 },
      buf: sumBuf({ hit: hh, read: heap - hh, tempRead: 0, tempWritten: 0 }, [child]),
      props: [{ key: "Recheck Cond", value: o.cond }, { key: "Heap Blocks", value: `exact=${heap}`, runtime: true }],
      children: [child], terms: c.terms.slice(1),
      note: `Visits the pages that the bitmap marks, in physical page order, so each page is read once. It checks the condition again on each row ("Recheck Cond").`,
      mysql: `Index range scan on ${o.alias} using ${o.idx.name} over (${o.mysqlRange ?? o.cond})`,
    });
  }

  hash(child: PNode, trueRows: number): PNode {
    const hb = hashBatches(trueRows, child.est.width, this.p);
    const memKb = Math.ceil(hb.hashBytes / 1024);
    const ms = allLoopsMs(child) + trueRows * (TIME.opMs + TIME.tupleMs);
    return this.node({
      op: "Hash", target: "",
      est: { startup: child.est.total, total: child.est.total, rows: child.est.rows, width: child.est.width },
      act: { startup: ms, total: ms, rows: trueRows, loops: 1 },
      buf: sumBuf(noBuf, [child]),
      props: [{ key: "Buckets", value: `${hb.buckets}  Batches: ${hb.batches}  Memory Usage: ${memKb}kB`, runtime: true }],
      children: [child], terms: [],
      note: `Reads its whole input and builds an in-memory hash table on the join key. Its startup cost equals its total cost: no row leaves before the table is complete.`,
      mysql: "Hash",
    });
  }

  hashJoin(outer: PNode, hash: PNode, o: { cond: string; estRows: number; trueRows: number; innerNd: number; width: number }): PNode {
    const inner = hash.children[0]!;
    const c = hashJoinCost(asInput(outer), asInput(inner), o.estRows, o.innerNd, this.p);
    const probe = outer.act.rows * outer.act.loops * (2 * TIME.opMs) + o.trueRows * TIME.tupleMs;
    return this.node({
      op: "Hash Join", target: "",
      est: { startup: c.startup, total: c.total, rows: o.estRows, width: o.width },
      act: { startup: hash.act.total + outer.act.startup, total: hash.act.total + allLoopsMs(outer) + probe, rows: o.trueRows, loops: 1 },
      buf: sumBuf(noBuf, [outer, hash]),
      props: [{ key: "Hash Cond", value: o.cond }],
      children: [outer, hash], terms: c.terms,
      note: `Builds the hash table from the second child (the Hash node), then reads the first child and looks up each row in it. Only equality conditions can use a hash join.`,
      mysql: `Inner hash join ${o.cond}`,
    });
  }

  nestLoop(outer: PNode, inner: PNode, o: { joinFilter?: string; nFilterOps?: number; estRows: number; trueRows: number; width: number; innerRescan?: number }): PNode {
    const nF = o.nFilterOps ?? (o.joinFilter ? 1 : 0);
    const innerIn = asInput(inner);
    if (o.innerRescan !== undefined) { innerIn.total = innerIn.startup + o.innerRescan; }
    const c = nestLoopCost(asInput(outer), innerIn, o.estRows, this.p, nF);
    if (o.innerRescan !== undefined) {
      // first run of the inner side at full cost, the rest at rescan cost
      const extra = inner.est.total - innerIn.total;
      c.total += extra;
    }
    const pairs = outer.act.rows * outer.act.loops * inner.act.rows;
    const ms = allLoopsMs(outer) + allLoopsMs(inner) + pairs * nF * TIME.opMs + o.trueRows * TIME.tupleMs;
    const props: Prop[] = [];
    if (o.joinFilter) {
      props.push({ key: "Join Filter", value: o.joinFilter });
      props.push({ key: "Rows Removed by Join Filter", value: String(Math.round(pairs - o.trueRows)), runtime: true });
    }
    return this.node({
      op: "Nested Loop", target: "",
      est: { startup: c.startup, total: c.total, rows: o.estRows, width: o.width },
      act: { startup: outer.act.startup + inner.act.startup, total: ms, rows: o.trueRows, loops: 1 },
      buf: sumBuf(noBuf, [outer, inner]),
      props, children: [outer, inner], terms: c.terms,
      note: `For each row of the first child, runs the second child again and keeps the matching pairs. It is fast when the outer side is small and the inner side is an index lookup.`,
      mysql: "Nested loop inner join",
      mysqlWrap: o.joinFilter ? `Filter: ${o.joinFilter}` : undefined,
    });
  }

  materialize(child: PNode, loops: number): PNode {
    const m = materializeCost(asInput(child), this.p);
    const rows = child.act.rows;
    const all = allLoopsMs(child) + rows * TIME.tupleMs + (loops - 1) * rows * TIME.tupleMs * 0.5;
    return this.node({
      op: "Materialize", target: "",
      est: { startup: m.startup, total: m.total, rows: child.est.rows, width: child.est.width },
      act: { startup: 0.001, total: all / loops, rows, loops },
      buf: sumBuf(noBuf, [child]),
      props: [{ key: "Storage", value: `Memory  Maximum Storage: ${Math.ceil((rows * (maxAlign(child.est.width) + 16)) / 1024)}kB`, runtime: true }],
      children: [child], terms: [{ label: "each rescan reads the stored rows", expr: `${rows} × ${this.p.cpuOperatorCost}`, value: m.rescan, phase: "run" }],
      note: `Stores the rows of its child the first time, then replays them from memory on every rescan, so the child runs only once.`,
      mysql: "Materialize",
    });
  }

  sort(child: PNode, key: string, o: { bound?: number; mysqlKey?: string } = {}): PNode {
    const c = sortCost(asInput(child), this.p, o.bound);
    const N = child.act.rows;
    const real = sortCost({ startup: 0, total: 0, rows: N, width: child.est.width }, this.p, o.bound);
    const cmps = real.method === "top-N heapsort" ? N * Math.log2(2 * o.bound!) : N * Math.log2(Math.max(2, N));
    const tempPages = real.method === "external merge" ? Math.ceil(real.diskKb / 8) : 0;
    const runs = Math.max(1, real.bytes / this.p.workMem);
    const mergeCmps = real.method === "external merge" ? N * Math.log2(runs) : 0;
    const own = (cmps + mergeCmps) * TIME.cmpMs + N * TIME.tupleMs + tempPages * 2 * real.passes * TIME.tempPageMs;
    const outRows = o.bound !== undefined ? Math.min(o.bound, N) : N;
    const start = allLoopsMs(child) + own;
    const method = real.method as SortMethod;
    return this.node({
      op: "Sort", target: "",
      est: { startup: c.startup, total: c.total, rows: c.rows, width: child.est.width },
      act: { startup: start, total: start + outRows * TIME.tupleMs * 0.5, rows: outRows, loops: 1 },
      buf: sumBuf({ hit: 0, read: 0, tempRead: tempPages * real.passes, tempWritten: tempPages * real.passes }, [child]),
      props: [
        { key: "Sort Key", value: key },
        { key: "Sort Method", value: method === "external merge" ? `external merge  Disk: ${real.diskKb}kB` : `${method}  Memory: ${real.memKb}kB`, runtime: true },
      ],
      children: [child],
      terms: [{ label: "compare", expr: `2 × ${this.p.cpuOperatorCost} × N log₂ N`, value: c.startup - child.est.total, phase: "startup" }],
      note: `Reads all of its input before it returns the first row. If the rows do not fit in work_mem (${this.p.workMem / 1024} kB), it writes sorted runs to temporary files and merges them.`,
      mysql: `Sort: ${o.mysqlKey ?? key}${o.bound !== undefined ? `, limit input to ${o.bound} row(s) per chunk` : ""}`,
    });
  }

  hashAgg(child: PNode, key: string, o: { estGroups: number; trueGroups: number; nAggs: number; width: number }): PNode {
    const c = hashAggCost(asInput(child), o.estGroups, 1, o.nAggs, this.p);
    const N = child.act.rows * child.act.loops;
    const start = allLoopsMs(child) + N * (1 + o.nAggs) * TIME.opMs * 2;
    return this.node({
      op: "HashAggregate", target: "",
      est: { startup: c.startup, total: c.total, rows: o.estGroups, width: o.width },
      act: { startup: start, total: start + o.trueGroups * TIME.tupleMs, rows: o.trueGroups, loops: 1 },
      buf: sumBuf(noBuf, [child]),
      props: [{ key: "Group Key", value: key }, { key: "Batches", value: `1  Memory Usage: ${Math.max(24, Math.ceil((o.trueGroups * 120) / 1024) + 16)}kB`, runtime: true }],
      children: [child], terms: [],
      note: `Puts each input row into a hash table keyed on the GROUP BY columns and updates the aggregates. It returns rows only after it has read all of its input.`,
      mysql: "Aggregate using temporary table", mysqlWrap: "Table scan on <temporary>",
    });
  }

  limit(child: PNode, n: number): PNode {
    const c = limitCost(asInput(child), n);
    return this.node({
      op: "Limit", target: "",
      est: { startup: c.startup, total: c.total, rows: c.rows, width: child.est.width },
      act: { startup: child.act.startup, total: child.act.total, rows: Math.min(n, child.act.rows), loops: 1 },
      buf: sumBuf(noBuf, [child]),
      props: [], children: [child], terms: [],
      note: `Stops after ${n} rows. Its cost is the child's startup cost plus the fraction ${n} / rows of the child's run cost.`,
      mysql: `Limit: ${n} row(s)`,
    });
  }
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

export interface Line { text: string; node: number; head: boolean; key?: string }
export interface RenderOpts { analyze?: boolean; buffers?: boolean; planningMs?: number }

const fmt2 = (v: number) => v.toFixed(2);
const fmt3 = (v: number) => v.toFixed(3);

export function bufferText(b: PNode["buf"]): string | null {
  const parts: string[] = [];
  const sh: string[] = [];
  if (b.hit) sh.push(`hit=${b.hit}`);
  if (b.read) sh.push(`read=${b.read}`);
  if (sh.length) parts.push(`shared ${sh.join(" ")}`);
  const tp: string[] = [];
  if (b.tempRead) tp.push(`read=${b.tempRead}`);
  if (b.tempWritten) tp.push(`written=${b.tempWritten}`);
  if (tp.length) parts.push(`temp ${tp.join(" ")}`);
  return parts.length ? parts.join(", ") : null;
}

export function headText(n: PNode, analyze: boolean): string {
  const name = n.target ? `${n.op} ${n.target}` : n.op;
  let s = `${name}  (cost=${fmt2(n.est.startup)}..${fmt2(n.est.total)} rows=${n.est.rows} width=${n.est.width})`;
  if (analyze) s += ` (actual time=${fmt3(n.act.startup)}..${fmt3(n.act.total)} rows=${Math.round(n.act.rows)} loops=${n.act.loops})`;
  return s;
}

/** PostgreSQL text format: the root at column 0, a child's "->" at 6·depth − 4, its details at 6·depth + 2. */
export function renderExplain(root: PNode, o: RenderOpts = {}): Line[] {
  const out: Line[] = [];
  const walk = (n: PNode, depth: number) => {
    const pad = depth === 0 ? "" : " ".repeat(6 * depth - 4) + "->  ";
    const dpad = " ".repeat(depth === 0 ? 2 : 6 * depth + 2);
    out.push({ text: pad + headText(n, !!o.analyze), node: n.id, head: true });
    for (const p of n.props) if (!p.runtime || o.analyze) out.push({ text: `${dpad}${p.key}: ${p.value}`, node: n.id, head: false, key: p.key });
    if (o.analyze && o.buffers) { const b = bufferText(n.buf); if (b) out.push({ text: `${dpad}Buffers: ${b}`, node: n.id, head: false, key: "Buffers" }); }
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  if (o.analyze) {
    out.push({ text: `Planning Time: ${fmt3(o.planningMs ?? planningMs(root))} ms`, node: -1, head: false, key: "Planning Time" });
    out.push({ text: `Execution Time: ${fmt3(executionMs(root))} ms`, node: -1, head: false, key: "Execution Time" });
  }
  return out;
}

/** MySQL EXPLAIN FORMAT=TREE (or EXPLAIN ANALYZE) shape of the same plan. MySQL costs use other units, so only rows are shown. */
export function renderMysqlTree(root: PNode, analyze = false): Line[] {
  const out: Line[] = [];
  const tail = (n: PNode) => ` (rows=${n.est.rows})` + (analyze ? ` (actual time=${fmt3(n.act.startup)}..${fmt3(n.act.total)} rows=${Math.round(n.act.rows)} loops=${n.act.loops})` : "");
  const walk = (n: PNode, depth: number) => {
    if (n.op === "Bitmap Index Scan") return;
    let d = depth;
    if (n.mysqlWrap) { out.push({ text: `${"    ".repeat(d)}-> ${n.mysqlWrap}${tail(n)}`, node: n.id, head: true }); d++; }
    if (n.mysql) out.push({ text: `${"    ".repeat(d)}-> ${n.mysql}${n.mysqlWrap ? "" : tail(n)}`, node: n.id, head: true });
    for (const c of n.children) walk(c, d + 1);
  };
  walk(root, 0);
  return out;
}

export function walkPlan(root: PNode, f: (n: PNode, depth: number, parent?: PNode) => void) {
  const go = (n: PNode, d: number, parent?: PNode) => { f(n, d, parent); for (const c of n.children) go(c, d + 1, n); };
  go(root, 0);
}
export function findNode(root: PNode, id: number): PNode | undefined { let r: PNode | undefined; walkPlan(root, (n) => { if (n.id === id) r = n; }); return r; }
export function nodeCount(root: PNode) { let k = 0; walkPlan(root, () => k++); return k; }
export const planningMs = (root: PNode) => 0.08 + 0.035 * nodeCount(root);
export const executionMs = (root: PNode) => root.act.total * root.act.loops + 0.02;
/** Time spent in a node itself: its total minus its children's totals (all loops). */
export const selfMs = (n: PNode) => Math.max(0, allLoopsMs(n) - n.children.reduce((a, c) => a + allLoopsMs(c), 0));
/** Estimated / actual rows, per loop, as a q-error with direction. */
export function rowError(n: PNode) {
  const e = Math.max(1, n.est.rows), a = Math.max(1, n.act.rows);
  return { q: Math.max(e / a, a / e), under: a > e };
}

// ---------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------

export const SHOP = {
  customers: { name: "customers", rows: 100000, pages: heapPages(100000, 64), width: 64 } as TableStats,
  orders: { name: "orders", rows: 1000000, pages: heapPages(1000000, 48), width: 48 } as TableStats,
};
const ordersCreated: IndexStats = (() => { const s = btreeShape(1e6, 8); return { name: "orders_created_at_idx", pages: s.pages, tuples: 1e6, height: s.height, correlation: 0.98 }; })();
const ordersCustomer: IndexStats = (() => { const s = btreeShape(1e6, 4); return { name: "orders_customer_id_idx", pages: s.pages, tuples: 1e6, height: s.height, correlation: 0.01 }; })();

export interface Scenario { title: string; sql: string; context: string; root: PNode }

/** The date `days` before 2026-11-01, as YYYY-MM-DD. */
export function sinceDate(days: number): string {
  const d = new Date(Date.UTC(2026, 10, 1) - days * 86400000);
  return d.toISOString().slice(0, 10);
}

function shopPlan(p: CostParams, days: number, hashOrders: boolean) {
  const b = new PlanBuilder(p);
  const { customers, orders } = SHOP;
  const estSel = Math.min(1, days / 730), trueRows = Math.min(orders.rows, Math.round(estSel * orders.rows * 1.04));
  const date = sinceDate(days);
  const cond = `(created_at >= '${date}'::date)`;
  const path = accessPaths(orders, ordersCreated, estSel, p).best;
  const opts = { table: orders, idx: ordersCreated, alias: "o", cond, estSel, cacheHeap: 0.6, cacheIdx: 0.9, width: 14 };
  const ord = path === "index" ? b.indexScan({ ...opts, trueRowsPerLoop: trueRows })
    : path === "bitmap" ? b.bitmapScan({ ...opts, trueRows, mysqlRange: `'${date}' <= created_at` })
    : b.seqScan({ table: orders, alias: "o", filter: cond, estSel, trueRows, cache: 0.6, width: 14 });
  if (path === "index") ord.mysql = `Index range scan on o using orders_created_at_idx over ('${date}' <= created_at)`;
  const cust = b.seqScan({ table: customers, alias: "c", trueRows: customers.rows, cache: 1, width: 7 });
  const j = hashOrders
    ? b.hashJoin(cust, b.hash(ord, trueRows), { cond: "(c.id = o.customer_id)", estRows: ord.est.rows, trueRows, innerNd: Math.min(ord.est.rows, customers.rows), width: 13 })
    : b.hashJoin(ord, b.hash(cust, customers.rows), { cond: "(o.customer_id = c.id)", estRows: ord.est.rows, trueRows, innerNd: customers.rows, width: 13 });
  const agg = b.hashAgg(j, "c.country", { estGroups: 50, trueGroups: 48, nAggs: 1, width: 35 });
  const s = b.sort(agg, "(sum(o.total)) DESC", { bound: 10, mysqlKey: "`sum(o.total)` DESC" });
  return { root: b.limit(s, 10), join: j, path };
}

/**
 * The plan for the EXPLAIN reader: revenue per country since a date, top 10. The model picks the
 * scan on orders (index, bitmap or seq) and the hash join's build side by estimated cost.
 */
export function shopScenario(p: CostParams = PG_DEFAULTS, days = 31): Scenario & { path: AccessPath; hashOrders: boolean } {
  const { customers, orders } = SHOP;
  const a = shopPlan(p, days, true), c = shopPlan(p, days, false);
  const hashOrders = a.join.est.total <= c.join.est.total;
  const chosen = hashOrders ? a : c;
  return {
    title: "Revenue per country",
    sql: `SET max_parallel_workers_per_gather = 0;\nEXPLAIN (ANALYZE, BUFFERS)\nSELECT c.country, sum(o.total)\nFROM orders o JOIN customers c ON c.id = o.customer_id\nWHERE o.created_at >= DATE '${sinceDate(days)}'\nGROUP BY c.country\nORDER BY sum(o.total) DESC\nLIMIT 10;`,
    context: `orders: ${orders.rows.toLocaleString("en-US")} rows, ${orders.pages.toLocaleString("en-US")} pages, two years of data, index on created_at (correlation ${ordersCreated.correlation}). customers: ${customers.rows.toLocaleString("en-US")} rows, ${customers.pages.toLocaleString("en-US")} pages.`,
    root: chosen.root, path: chosen.path, hashOrders,
  };
}

/** Both build sides for the shop query, so tests can check the model picked the cheaper one. */
export function shopJoinChoice(p: CostParams = PG_DEFAULTS, days = 31) {
  const a = shopPlan(p, days, true), c = shopPlan(p, days, false);
  return { hashOrders: a.join.est.total, hashCustomers: c.join.est.total };
}


export type Cause = "estimate" | "index" | "spill" | "nestloop";
export const CAUSE_LABEL: Record<Cause, string> = {
  estimate: "A bad row estimate",
  index: "A missing index",
  spill: "A sort or hash that spills to disk",
  nestloop: "A nested loop over large inputs",
};

export interface Exercise extends Scenario { id: string; cause: Cause; clue: string; fix: { sql: string; root: PNode; settings?: string }; why: string }

const USERS: TableStats = { name: "users", rows: 1000000, pages: heapPages(1000000, 60), width: 60 };
const EVENTS: TableStats = { name: "events", rows: 10000000, pages: heapPages(10000000, 40), width: 40 };
const eventsUser: IndexStats = (() => { const s = btreeShape(1e7, 4); return { name: "events_user_id_idx", pages: s.pages, tuples: 1e7, height: s.height, correlation: 0.02 }; })();
const PAYMENTS: TableStats = { name: "payments", rows: 5000, pages: heapPages(5000, 40), width: 40 };
const INVOICES: TableStats = { name: "invoices", rows: 20000, pages: heapPages(20000, 56), width: 56 };

/** Exercise 3 numbers: country 'NZ' has 1% of users, city 'Auckland' 0.8%, and every Auckland user is in NZ. */
export const EX3 = { pCountry: 0.01, pCity: 0.008, eventsPerUser: 10 };

function ex3Plans(p: CostParams, estOuter: number) {
  const trueOuter = USERS.rows * EX3.pCity;
  const estSel = estOuter / USERS.rows;
  const ttp = USERS.pages + EVENTS.pages;
  // Nested loop with an inner index scan on events.user_id.
  const b1 = new PlanBuilder(p);
  const u1 = b1.seqScan({ table: USERS, alias: "u", filter: "((country = 'NZ'::text) AND (city = 'Auckland'::text))", nQuals: 2, estSel, trueRows: trueOuter, cache: 0.5, width: 4 });
  const e1 = b1.indexScan({ table: EVENTS, idx: eventsUser, alias: "e", cond: "(user_id = u.id)", estSel: 1 / USERS.rows, estLoops: u1.est.rows, trueRowsPerLoop: EX3.eventsPerUser, loops: trueOuter, cacheHeap: 0.3, cacheIdx: 0.8, width: 40, totalTablePages: ttp });
  const nl = b1.nestLoop(u1, e1, { estRows: u1.est.rows * EX3.eventsPerUser, trueRows: trueOuter * EX3.eventsPerUser, width: 40 });
  // Hash join: hash the users, probe with all events.
  const b2 = new PlanBuilder(p);
  const u2 = b2.seqScan({ table: USERS, alias: "u", filter: "((country = 'NZ'::text) AND (city = 'Auckland'::text))", nQuals: 2, estSel, trueRows: trueOuter, cache: 0.5, width: 4 });
  const ev = b2.seqScan({ table: EVENTS, alias: "e", trueRows: EVENTS.rows, cache: 0.3, width: 40 });
  const hj = b2.hashJoin(ev, b2.hash(u2, trueOuter), { cond: "(e.user_id = u.id)", estRows: u2.est.rows * EX3.eventsPerUser, trueRows: trueOuter * EX3.eventsPerUser, innerNd: u2.est.rows, width: 40 });
  return { nl, hj };
}

/** Planner cost of both join methods for exercise 3, at the independence estimate and at the true row count. */
export function ex3Costs(p: CostParams = PG_DEFAULTS) {
  const estIndep = Math.round(USERS.rows * EX3.pCountry * EX3.pCity);
  const atEst = ex3Plans(p, estIndep), atTrue = ex3Plans(p, USERS.rows * EX3.pCity);
  return { estIndep, trueRows: USERS.rows * EX3.pCity, atEst: { nl: atEst.nl.est.total, hj: atEst.hj.est.total }, atTrue: { nl: atTrue.nl.est.total, hj: atTrue.hj.est.total }, msNl: executionMs(atEst.nl), msHj: executionMs(atTrue.hj) };
}

/** Plans for the "find the problem" exercise. */
export function exercises(p: CostParams = PG_DEFAULTS): Exercise[] {
  const out: Exercise[] = [];
  const { orders } = SHOP;

  // 1. Missing index: a point lookup by a column with no index.
  {
    const b = new PlanBuilder(p);
    const root = b.seqScan({ table: orders, alias: "", filter: "(customer_id = 4242)", estSel: 10 / orders.rows, trueRows: 12, cache: 0.4, width: 48 });
    root.target = "on orders";
    const f = new PlanBuilder(p);
    const fixed = f.indexScan({ table: orders, idx: ordersCustomer, alias: "", cond: "(customer_id = 4242)", estSel: 10 / orders.rows, trueRowsPerLoop: 12, cacheHeap: 0.4, cacheIdx: 0.9, width: 48 });
    fixed.target = "using orders_customer_id_idx on orders";
    out.push({
      id: "lookup", cause: "index", title: "Orders of one customer",
      sql: "EXPLAIN (ANALYZE, BUFFERS)\nSELECT * FROM orders WHERE customer_id = 4242;",
      context: "orders has an index on id and on created_at only.", root,
      clue: "The estimate (10 rows) is close to the actual 12, but the scan reads every page and removes almost every row.",
      fix: { sql: "CREATE INDEX orders_customer_id_idx ON orders (customer_id);", root: fixed },
      why: "The estimate is good, there is no join and no sort. The plan reads the whole table to find 12 rows because no index exists on customer_id.",
    });
  }

  // 2. Spill: a large sort with the default work_mem.
  {
    const b = new PlanBuilder(p);
    const scan = b.seqScan({ table: orders, alias: "", trueRows: orders.rows, cache: 0.4, width: 18 });
    scan.target = "on orders";
    const root = b.sort(scan, "total DESC");
    const big = { ...p, workMem: 256 * 2 ** 20 };
    const f = new PlanBuilder(big);
    const s2 = f.seqScan({ table: orders, alias: "", trueRows: orders.rows, cache: 0.4, width: 18 });
    s2.target = "on orders";
    const fixed = f.sort(s2, "total DESC");
    out.push({
      id: "export", cause: "spill", title: "Export orders by amount",
      sql: "EXPLAIN (ANALYZE, BUFFERS)\nSELECT id, customer_id, total FROM orders ORDER BY total DESC;",
      context: "work_mem is the default 4 MB.", root,
      clue: "Look at Sort Method and at the temp buffers: the sort wrote its rows to disk and read them back.",
      fix: { sql: "SET work_mem = '256MB';  -- for this session or this query only", root: fixed, settings: "work_mem = 256MB" },
      why: "The estimates are exact and the scan must read every row anyway. The sort does not fit in work_mem, so it becomes an external merge sort with temporary files.",
    });
  }

  // 3. Bad estimate from correlated columns leads to a nested loop.
  {
    const c = ex3Costs(p);
    const plans = ex3Plans(p, c.estIndep);
    const fixed = ex3Plans(p, c.trueRows).hj;
    out.push({
      id: "auckland", cause: "estimate", title: "Events of users in Auckland",
      sql: "EXPLAIN (ANALYZE, BUFFERS)\nSELECT e.* FROM users u JOIN events e ON e.user_id = u.id\nWHERE u.country = 'NZ' AND u.city = 'Auckland';",
      context: "users has 1,000,000 rows; events has 10,000,000 rows and an index on user_id.", root: plans.nl,
      clue: `The scan on users expects ${c.estIndep} rows and gets ${c.trueRows.toLocaleString("en-US")}. Every Auckland user is in NZ, but the planner multiplies the two selectivities.`,
      fix: { sql: "CREATE STATISTICS users_geo (dependencies) ON country, city FROM users;\nANALYZE users;", root: fixed },
      why: "The nested loop is a symptom. With the correct estimate the planner picks a hash join by itself. The cause is the under-estimate on users.",
    });
  }

  // 4. Non-equality join condition: only a nested loop can run it.
  {
    const b = new PlanBuilder(p);
    const pay = b.seqScan({ table: PAYMENTS, alias: "p", trueRows: PAYMENTS.rows, cache: 1, width: 20 });
    const inv = b.seqScan({ table: INVOICES, alias: "i", trueRows: INVOICES.rows, cache: 1, width: 20 });
    const mat = b.materialize(inv, PAYMENTS.rows);
    const trueRows = 5040;
    const root = b.nestLoop(pay, mat, { joinFilter: "((p.invoice_id = i.id) OR (p.reference = i.number))", nFilterOps: 2, estRows: 5000, trueRows, width: 8, innerRescan: materializeCost(asInput(inv), p).rescan });
    const f = new PlanBuilder(p);
    const mk = (cond: string, rows: number) => {
      const a = f.seqScan({ table: PAYMENTS, alias: "p", trueRows: PAYMENTS.rows, cache: 1, width: 20 });
      const i = f.seqScan({ table: INVOICES, alias: "i", trueRows: INVOICES.rows, cache: 1, width: 20 });
      return f.hashJoin(i, f.hash(a, PAYMENTS.rows), { cond, estRows: rows, trueRows: rows, innerNd: PAYMENTS.rows, width: 8 });
    };
    const j1 = mk("(i.id = p.invoice_id)", 4980), j2 = mk("(i.number = p.reference)", 60);
    const fixedRoot: PNode = {
      id: 999, op: "Append", target: "",
      est: { startup: j1.est.startup, total: j1.est.total + j2.est.total, rows: j1.est.rows + j2.est.rows, width: 8 },
      act: { startup: j1.act.startup, total: j1.act.total + j2.act.total, rows: j1.act.rows + j2.act.rows, loops: 1 },
      buf: sumBuf(noBuf, [j1, j2]), props: [], children: [j1, j2], terms: [],
      note: "Returns the rows of each child in turn (UNION ALL).", mysql: "Append",
    };
    out.push({
      id: "payments", cause: "nestloop", title: "Match payments to invoices",
      sql: "EXPLAIN (ANALYZE, BUFFERS)\nSELECT p.id, i.id FROM payments p JOIN invoices i\n  ON p.invoice_id = i.id OR p.reference = i.number;",
      context: "payments: 5,000 rows. invoices: 20,000 rows. Both fit in memory.", root,
      clue: "The estimates are right (5,000 rows expected, 5,040 found). The join compares every payment with every invoice: 100 million pairs.",
      fix: { sql: "SELECT p.id, i.id FROM payments p JOIN invoices i ON p.invoice_id = i.id\nUNION ALL\nSELECT p.id, i.id FROM payments p JOIN invoices i ON p.reference = i.number\n  AND p.invoice_id IS DISTINCT FROM i.id;", root: fixedRoot },
      why: "A hash join and a merge join need an equality condition. The OR makes the condition unusable for both, so PostgreSQL must test all pairs. Rewrite the query as two equi-joins.",
    });
  }
  return out;
}
