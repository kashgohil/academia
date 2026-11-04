/**
 * Heap files: an unordered set of pages, plus the structures that find a page with room for a new row.
 *
 * - `FreeSpaceMap`: PostgreSQL's FSM idea. One byte per heap page holds a category = floor(free / 32)
 *   (256 categories for 8 KiB pages), and a binary max-tree over the categories finds a page in O(log n).
 *   Like the real FSM it is lossy: inserts do not update it. VACUUM and failed probes refresh it.
 * - `HeapFile`: byte accounting per page (not real tuples), with three ways to choose a page for an insert.
 *
 * Space per row = MAXALIGN(row bytes) + 4-byte slot. Usable bytes per page = page size − 24-byte header.
 */
import { mulberry32 } from "../../rng";
import { alignUp, PAGE_HEADER, SLOT_BYTES } from "./page";

export const FSM_CATEGORIES = 256;
/** Bytes per FSM category step for a page size (32 for 8 KiB pages). */
export const fsmStep = (pageBytes = 8192) => pageBytes / FSM_CATEGORIES;
/** Category recorded for `free` bytes: rounds down, so the map never promises more than there is. */
export const availToCat = (free: number, pageBytes = 8192) => Math.min(FSM_CATEGORIES - 1, Math.floor(free / fsmStep(pageBytes)));
/** Category a request of `need` bytes must find: rounds up. */
export const needToCat = (need: number, pageBytes = 8192) => Math.min(FSM_CATEGORIES - 1, Math.ceil(need / fsmStep(pageBytes)));

/** A max-tree over one category byte per heap page. */
export class FreeSpaceMap {
  private leaves = 1;
  private tree: Uint8Array;
  /** Tree nodes read by the last search. */
  lastVisits = 0;
  constructor(readonly pageBytes = 8192, capacity = 64) {
    while (this.leaves < capacity) this.leaves *= 2;
    this.tree = new Uint8Array(2 * this.leaves);
  }
  private grow(n: number) {
    if (n <= this.leaves) return;
    const old = this.tree, oldLeaves = this.leaves;
    while (this.leaves < n) this.leaves *= 2;
    this.tree = new Uint8Array(2 * this.leaves);
    for (let i = 0; i < oldLeaves; i++) this.set(i, old[oldLeaves + i]!);
  }
  /** Records the category for page `p`. */
  set(p: number, cat: number) {
    this.grow(p + 1);
    let i = this.leaves + p;
    this.tree[i] = cat;
    for (i >>= 1; i >= 1; i >>= 1) this.tree[i] = Math.max(this.tree[2 * i]!, this.tree[2 * i + 1]!);
  }
  get(p: number) { return p < this.leaves ? this.tree[this.leaves + p]! : 0; }
  /** Lowest-numbered page whose category is at least `cat`, or -1. */
  search(cat: number): number {
    this.lastVisits = 1;
    if (this.tree[1]! < cat) return -1;
    let i = 1;
    while (i < this.leaves) {
      i = this.tree[2 * i]! >= cat ? 2 * i : 2 * i + 1;
      this.lastVisits++;
    }
    return i - this.leaves;
  }
  /** Tree depth (nodes read per search). */
  get depth() { return Math.log2(this.leaves) + 1; }
}

export type InsertStrategy = "append" | "first-fit" | "fsm";

export interface HeapPage {
  /** Bytes used by live rows and their slots. */
  used: number;
  /** Bytes still held by deleted rows (reclaimed by vacuum). */
  dead: number;
  rows: number;
  deadRows: number;
}

export interface InsertResult { page: number; probed: number[]; fsmVisits: number; extended: boolean; /** bytes used on the page (row + slot) */ cost: number }

export interface HeapOpts {
  pageBytes?: number;
  /** PostgreSQL fillfactor in percent (10..100): inserts leave (100 − ff)% of each page free. */
  fillFactor?: number;
  strategy?: InsertStrategy;
}

export class HeapFile {
  readonly pageBytes: number;
  readonly fillFactor: number;
  readonly strategy: InsertStrategy;
  readonly pages: HeapPage[] = [];
  readonly fsm: FreeSpaceMap;
  /** The page that received the last insert (PostgreSQL keeps this as the relation's target block). */
  target = -1;
  /** Live rows: id → [page, bytes on page]. */
  private rowPage = new Map<number, [number, number]>();
  private nextId = 0;

  constructor(o: HeapOpts = {}) {
    this.pageBytes = o.pageBytes ?? 8192;
    this.fillFactor = o.fillFactor ?? 100;
    this.strategy = o.strategy ?? "fsm";
    this.fsm = new FreeSpaceMap(this.pageBytes);
  }

  get capacity() { return this.pageBytes - PAGE_HEADER; }
  /** Space that inserts must leave free on each page because of the fill factor. */
  get reserve() { return Math.floor((this.pageBytes * (100 - this.fillFactor)) / 100); }
  /** Free bytes on page p right now (dead rows count as used until vacuum). */
  free(p: number) { const pg = this.pages[p]!; return this.capacity - pg.used - pg.dead; }
  private fits(p: number, cost: number) { return this.free(p) >= cost + this.reserve; }

  private extend(): number {
    this.pages.push({ used: 0, dead: 0, rows: 0, deadRows: 0 });
    const p = this.pages.length - 1;
    // New pages are not in the FSM until a probe or vacuum records them. The target block finds them.
    return p;
  }

  /** Inserts a row of `bytes`; returns where it went and which pages were read to decide. */
  insert(bytes: number): InsertResult & { id: number } {
    const cost = alignUp(bytes) + SLOT_BYTES;
    const probed: number[] = [];
    let fsmVisits = 0;
    let page = -1, extended = false;
    const tryPage = (p: number) => { probed.push(p); return this.fits(p, cost); };

    if (this.strategy === "first-fit") {
      for (let p = 0; p < this.pages.length && page < 0; p++) if (tryPage(p)) page = p;
    } else {
      // "append" and "fsm" both try the last target page first.
      if (this.target >= 0 && this.target < this.pages.length && tryPage(this.target)) page = this.target;
      else if (this.target < 0 && this.pages.length > 0 && tryPage(this.pages.length - 1)) page = this.pages.length - 1;
      if (page < 0 && this.strategy === "fsm") {
        if (this.target >= 0) this.fsm.set(this.target, availToCat(Math.max(0, this.free(this.target) - this.reserve), this.pageBytes));
        const want = needToCat(cost, this.pageBytes);
        for (;;) {
          const p = this.fsm.search(want);
          fsmVisits += this.fsm.lastVisits;
          if (p < 0) break;
          if (tryPage(p)) { page = p; break; }
          // The map was out of date: record the truth and search again.
          this.fsm.set(p, availToCat(Math.max(0, this.free(p) - this.reserve), this.pageBytes));
        }
      }
    }
    if (page < 0) { page = this.extend(); extended = true; }
    const pg = this.pages[page]!;
    pg.used += cost;
    pg.rows++;
    this.target = page;
    const id = this.nextId++;
    this.rowPage.set(id, [page, cost]);
    return { id, page, probed, fsmVisits, extended, cost };
  }

  /** Deletes a row. Its space stays used (dead) until vacuum. */
  delete(id: number): boolean {
    const r = this.rowPage.get(id);
    if (!r) return false;
    this.rowPage.delete(id);
    const pg = this.pages[r[0]]!;
    pg.used -= r[1];
    pg.dead += r[1];
    pg.rows--;
    pg.deadRows++;
    return true;
  }

  /** Reclaims dead space on every page and records each page's free space in the FSM. */
  vacuum() {
    this.pages.forEach((pg, p) => {
      pg.dead = 0;
      pg.deadRows = 0;
      this.fsm.set(p, availToCat(Math.max(0, this.free(p) - this.reserve), this.pageBytes));
    });
  }

  get liveIds() { return [...this.rowPage.keys()]; }
  get rowCount() { return this.rowPage.size; }
}

export interface HeapRunOpts {
  strategy: InsertStrategy;
  /** Rows loaded first. */
  initial: number;
  /** Fraction of rows deleted after the load. */
  deleteFrac: number;
  vacuum: boolean;
  /** Rows inserted after the deletes. */
  inserts: number;
  /** Row size range in bytes [min, max]. */
  rowBytes: [number, number];
  fillFactor?: number;
  seed?: number;
}

export interface HeapRun {
  heap: HeapFile;
  pagesAfterLoad: number;
  /** Page states after the deletes (and vacuum), before the last phase. */
  before: HeapPage[];
  /** One entry per insert of the last phase. */
  results: InsertResult[];
  avgProbes: number;
  maxProbes: number;
  avgFsmVisits: number;
  pagesAfter: number;
}

/** Load, delete, optionally vacuum, then insert again. Measures how each strategy finds space. */
export function heapRun(o: HeapRunOpts): HeapRun {
  const rng = mulberry32(o.seed ?? 5);
  const size = () => o.rowBytes[0] + Math.floor(rng() * (o.rowBytes[1] - o.rowBytes[0] + 1));
  const heap = new HeapFile({ strategy: o.strategy, fillFactor: o.fillFactor });
  for (let i = 0; i < o.initial; i++) heap.insert(size());
  const pagesAfterLoad = heap.pages.length;
  for (const id of heap.liveIds) if (rng() < o.deleteFrac) heap.delete(id);
  if (o.vacuum) heap.vacuum();
  const before = heap.pages.map((p) => ({ ...p }));
  const results: InsertResult[] = [];
  for (let i = 0; i < o.inserts; i++) results.push(heap.insert(size()));
  const n = Math.max(1, results.length);
  return {
    heap,
    pagesAfterLoad,
    before,
    results,
    avgProbes: results.reduce((a, r) => a + r.probed.length, 0) / n,
    maxProbes: results.reduce((a, r) => Math.max(a, r.probed.length), 0),
    avgFsmVisits: results.reduce((a, r) => a + r.fsmVisits, 0) / n,
    pagesAfter: heap.pages.length,
  };
}

// =====================================================================================
// Sequential scans
// =====================================================================================

/** PostgreSQL planner defaults. */
export const PG_COSTS = { seq_page_cost: 1.0, random_page_cost: 4.0, cpu_tuple_cost: 0.01, cpu_operator_cost: 0.0025 } as const;

/** PostgreSQL's estimate for a sequential scan: pages × seq_page_cost + rows × (cpu_tuple_cost + quals × cpu_operator_cost). */
export const seqScanCost = (pages: number, rows: number, quals = 0) =>
  pages * PG_COSTS.seq_page_cost + rows * (PG_COSTS.cpu_tuple_cost + quals * PG_COSTS.cpu_operator_cost);

export interface TableShape {
  liveRows: number;
  rowBytes: number;
  /** Fraction of row versions on the pages that are dead (not yet vacuumed). */
  deadFrac: number;
  fillFactor: number;
  pageBytes?: number;
}

/** Rows per page when inserts respect the fill factor (at least 1). */
export function rowsPerPage(rowBytes: number, fillFactor = 100, pageBytes = 8192): number {
  const usable = pageBytes - PAGE_HEADER - Math.floor((pageBytes * (100 - fillFactor)) / 100);
  return Math.max(1, Math.floor(usable / (alignUp(rowBytes) + SLOT_BYTES)));
}

/** How many pages a sequential scan reads, and how many row versions it must look at. */
export function tablePages(t: TableShape) {
  const pageBytes = t.pageBytes ?? 8192;
  const versions = Math.round(t.liveRows / (1 - t.deadFrac));
  const rpp = rowsPerPage(t.rowBytes, t.fillFactor, pageBytes);
  const pages = Math.ceil(versions / rpp);
  return { pages, versions, rowsPerPage: rpp, bytes: pages * pageBytes, cost: seqScanCost(pages, versions) };
}

/** Time to read `bytes` at `mbps` (MB/s), in milliseconds. */
export const scanMs = (bytes: number, mbps: number) => (bytes / (mbps * 1e6)) * 1000;
