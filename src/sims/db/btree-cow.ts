/**
 * Copy-on-write (shadow-paging) B+ tree, in the style of LMDB, with an append-only mode in the
 * style of CouchDB.
 *
 * - A committed page is never changed. A write transaction copies every page on the path from
 *   the leaf to the root ("path copying"). A page that the transaction already copied is dirty
 *   and is changed in place, so a batch of updates shares the copies of the upper levels.
 * - Commit = write the dirty pages, then write a meta page that names the new root. Two meta
 *   pages (page 0 and page 1) alternate, as in LMDB: the newer valid one wins at startup.
 * - Pages that a transaction replaced go on a free list, tagged with that transaction id.
 *   ("reuse" mode) A freed page is reused only when no reader can still see it: every open
 *   reader started at or after the transaction that freed it, and that transaction is older
 *   than the previous commit (LMDB keeps the last two versions whole).
 * - ("append" mode) Pages are never reused. Every commit appends a header page at the end of
 *   the file. `compact()` copies the live pages into a new file.
 *
 * Keys and values are numbers. Pure TypeScript, no React.
 */
import { type InsertOrder, keyOrder } from "./btree";

export type CowMode = "reuse" | "append";

export interface CowPage {
  no: number;
  leaf: boolean;
  keys: number[];
  vals: number[];
  kids: number[];
  /** Transaction that wrote this page. */
  txn: number;
}

export interface MetaPage {
  slot: 0 | 1;
  txn: number;
  root: number | null;
}

export interface CowStats {
  /** Data pages written (copies and new pages). */
  pagesWritten: number;
  /** Meta pages (reuse mode) or header pages (append mode) written. */
  metaWrites: number;
  pagesReused: number;
  pagesAppended: number;
  commits: number;
  updates: number;
}

export type PageStatus = "meta" | "meta-current" | "live" | "pinned" | "waiting" | "free" | "dead" | "header";

interface Txn {
  id: number;
  root: number | null;
  dirty: Set<number>;
  freed: number[];
  /** Pages written by this transaction, in order. */
  written: number[];
}

export class CowBTree {
  readonly order: number;
  readonly maxKeys: number;
  readonly pageBytes: number;
  readonly mode: CowMode;
  pages = new Map<number, CowPage>();
  meta: [MetaPage, MetaPage] = [{ slot: 0, txn: 0, root: null }, { slot: 1, txn: 0, root: null }];
  /** Root page of every committed version that may still be read. */
  roots = new Map<number, number | null>([[0, null]]);
  lastTxn = 0;
  readers = new Map<number, number>();
  /** Freed pages: freed by transaction `txn`. */
  freed: { txn: number; page: number }[] = [];
  /** Next page number at the end of the file. */
  fileEnd: number;
  /** Append mode: header pages (one per commit). */
  headers: number[] = [];
  stats: CowStats = { pagesWritten: 0, metaWrites: 0, pagesReused: 0, pagesAppended: 0, commits: 0, updates: 0 };
  /** Pages written by the last committed transaction. */
  lastWritten: number[] = [];
  private txn: Txn | null = null;
  private nextReader = 1;

  constructor(opts: { order?: number; pageBytes?: number; mode?: CowMode } = {}) {
    this.order = opts.order ?? 4;
    if (this.order < 3) throw new Error("order must be >= 3");
    this.maxKeys = this.order - 1;
    this.pageBytes = opts.pageBytes ?? 4096;
    this.mode = opts.mode ?? "reuse";
    this.fileEnd = this.mode === "reuse" ? 2 : 0;
  }

  get root(): number | null {
    return this.roots.get(this.lastTxn) ?? null;
  }
  get inTxn(): boolean {
    return this.txn !== null;
  }
  /** The meta page that a restart would use (the newer one). */
  currentMeta(): MetaPage {
    return this.meta[0].txn >= this.meta[1].txn ? this.meta[0] : this.meta[1];
  }

  // ------------------------------------------------------------ transactions
  begin(): number {
    if (this.txn) throw new Error("a write transaction is already open");
    this.txn = { id: this.lastTxn + 1, root: this.root, dirty: new Set(), freed: [], written: [] };
    return this.txn.id;
  }
  put(k: number, v: number): void {
    const t = this.txn;
    if (!t) throw new Error("call begin() first");
    this.stats.updates++;
    if (t.root === null) {
      const p = this.alloc(true);
      p.keys = [k];
      p.vals = [v];
      t.root = p.no;
      return;
    }
    const r = this.insertRec(t.root, k, v);
    t.root = r.no;
    if (r.split) {
      const nr = this.alloc(false);
      nr.keys = [r.split.sep];
      nr.kids = [r.no, r.split.right];
      t.root = nr.no;
    }
  }
  commit(): number {
    const t = this.txn;
    if (!t) throw new Error("no open transaction");
    this.stats.pagesWritten += t.dirty.size;
    if (this.mode === "reuse") {
      const slot = (t.id % 2) as 0 | 1;
      this.meta[slot] = { slot, txn: t.id, root: t.root };
    } else {
      this.headers.push(this.fileEnd++);
    }
    this.stats.metaWrites++;
    this.stats.commits++;
    if (this.mode === "reuse") for (const page of t.freed) this.freed.push({ txn: t.id, page });
    this.lastTxn = t.id;
    this.roots.set(t.id, t.root);
    this.lastWritten = t.written;
    this.txn = null;
    this.pruneRoots();
    return t.id;
  }
  /** Drops the transaction. Its new pages go back to the free list at once. */
  abort(): void {
    const t = this.txn;
    if (!t) return;
    for (const no of t.dirty) {
      this.pages.delete(no);
      if (this.mode === "reuse") this.freed.push({ txn: 0, page: no });
    }
    this.txn = null;
  }
  /** One update in its own transaction. */
  update(k: number, v: number): number {
    this.begin();
    this.put(k, v);
    return this.commit();
  }

  // ------------------------------------------------------------ readers
  /** Starts a read transaction on the latest committed version. Returns a reader id. */
  openReader(): number {
    const id = this.nextReader++;
    this.readers.set(id, this.lastTxn);
    return id;
  }
  closeReader(id: number): void {
    this.readers.delete(id);
    this.pruneRoots();
  }
  /** Reads k in the version that a reader sees (default: the latest committed version). */
  get(k: number, reader?: number): number | undefined {
    const txn = reader === undefined ? this.lastTxn : this.readers.get(reader);
    if (txn === undefined) throw new Error("unknown reader");
    let no = this.roots.get(txn) ?? null;
    while (no !== null) {
      const p = this.pages.get(no)!;
      if (p.leaf) {
        const i = p.keys.indexOf(k);
        return i < 0 ? undefined : p.vals[i];
      }
      no = p.kids[childIndex(p.keys, k)]!;
    }
    return undefined;
  }
  /** All entries of a version, in key order. */
  entries(txn = this.lastTxn): [number, number][] {
    const out: [number, number][] = [];
    const walk = (no: number) => {
      const p = this.pages.get(no)!;
      if (p.leaf) p.keys.forEach((k, i) => out.push([k, p.vals[i]!]));
      else p.kids.forEach(walk);
    };
    const r = this.roots.get(txn);
    if (r !== undefined && r !== null) walk(r);
    return out;
  }
  /** Pages reachable from a version's root. */
  reachable(txn = this.lastTxn): Set<number> {
    const out = new Set<number>();
    const walk = (no: number) => {
      out.add(no);
      const p = this.pages.get(no)!;
      if (!p.leaf) p.kids.forEach(walk);
    };
    const r = this.roots.get(txn);
    if (r !== undefined && r !== null) walk(r);
    return out;
  }
  height(txn = this.lastTxn): number {
    let h = 0;
    let no = this.roots.get(txn) ?? null;
    while (no !== null) {
      h++;
      const p: CowPage = this.pages.get(no)!;
      no = p.leaf ? null : p.kids[0]!;
    }
    return h;
  }
  /** Oldest version that must stay whole. */
  oldestPinned(): number {
    let o = this.mode === "reuse" ? this.lastTxn - 1 : this.lastTxn;
    for (const s of this.readers.values()) o = Math.min(o, s);
    return o;
  }

  /** Status of every page in the file, for drawing. */
  pageStatus(): PageStatus[] {
    const live = this.reachable();
    const pinned = new Set<number>();
    const keep = new Set<number>(this.readers.values());
    if (this.mode === "reuse") keep.add(this.lastTxn - 1);
    for (const s of keep) if (s !== this.lastTxn) for (const p of this.reachable(s)) pinned.add(p);
    const freed = new Map(this.freed.map((f) => [f.page, f.txn]));
    const headers = new Set(this.headers);
    const cur = this.currentMeta().slot;
    return Array.from({ length: this.fileEnd }, (_, no): PageStatus => {
      if (this.mode === "reuse" && no < 2) return no === cur ? "meta-current" : "meta";
      if (headers.has(no)) return "header";
      if (live.has(no)) return "live";
      if (pinned.has(no)) return "pinned";
      if (this.mode === "append") return "dead";
      const f = freed.get(no);
      if (f !== undefined) return this.reusable(f, this.lastTxn + 1) ? "free" : "waiting";
      return "dead";
    });
  }

  /** Append mode: copy the live pages of the latest version into a new, dense file. Closes readers. */
  compact(): { before: number; after: number } {
    if (this.txn) throw new Error("commit first");
    const before = this.fileEnd;
    const old = this.pages;
    const map = new Map<number, number>();
    const fresh = new Map<number, CowPage>();
    let next = this.mode === "reuse" ? 2 : 0;
    const copy = (no: number): number => {
      const p = old.get(no)!;
      const kids = p.leaf ? [] : p.kids.map(copy);
      const n: CowPage = { ...p, kids, keys: [...p.keys], vals: [...p.vals], no: next++ };
      fresh.set(n.no, n);
      map.set(no, n.no);
      return n.no;
    };
    const r = this.root;
    const nr = r === null ? null : copy(r);
    this.stats.pagesWritten += fresh.size;
    this.pages = fresh;
    this.readers.clear();
    this.freed = [];
    this.roots = new Map([[this.lastTxn, nr]]);
    this.headers = [];
    if (this.mode === "append") {
      this.headers.push(next++);
      this.stats.metaWrites++;
    } else {
      this.meta = [{ slot: 0, txn: this.lastTxn, root: nr }, { slot: 1, txn: this.lastTxn - 1, root: nr }];
    }
    this.fileEnd = next;
    this.lastWritten = [];
    return { before, after: this.fileEnd };
  }

  // ------------------------------------------------------------ internals
  private reusable(freedBy: number, writer: number): boolean {
    if (this.mode !== "reuse") return false;
    if (freedBy > writer - 2) return false;
    for (const s of this.readers.values()) if (freedBy > s) return false;
    return true;
  }
  private alloc(leaf: boolean): CowPage {
    const t = this.txn!;
    let no = -1;
    if (this.mode === "reuse") {
      let best = -1;
      for (let i = 0; i < this.freed.length; i++) {
        const f = this.freed[i]!;
        if (this.reusable(f.txn, t.id) && (best < 0 || f.page < this.freed[best]!.page)) best = i;
      }
      if (best >= 0) {
        no = this.freed[best]!.page;
        this.freed.splice(best, 1);
        this.stats.pagesReused++;
      }
    }
    if (no < 0) {
      no = this.fileEnd++;
      this.stats.pagesAppended++;
    }
    const p: CowPage = { no, leaf, keys: [], vals: [], kids: [], txn: t.id };
    this.pages.set(no, p);
    t.dirty.add(no);
    t.written.push(no);
    return p;
  }
  /** Returns a writable copy of page `no` (the page itself if this transaction wrote it). */
  private shadow(no: number): CowPage {
    const t = this.txn!;
    if (t.dirty.has(no)) return this.pages.get(no)!;
    const old = this.pages.get(no)!;
    const p = this.alloc(old.leaf);
    p.keys = [...old.keys];
    p.vals = [...old.vals];
    p.kids = [...old.kids];
    t.freed.push(no);
    return p;
  }
  private insertRec(no: number, k: number, v: number): { no: number; split?: { sep: number; right: number } } {
    const p = this.shadow(no);
    if (p.leaf) {
      const i = lowerBound(p.keys, k);
      if (p.keys[i] === k) p.vals[i] = v;
      else {
        p.keys.splice(i, 0, k);
        p.vals.splice(i, 0, v);
      }
    } else {
      const i = childIndex(p.keys, k);
      const r = this.insertRec(p.kids[i]!, k, v);
      p.kids[i] = r.no;
      if (r.split) {
        p.keys.splice(i, 0, r.split.sep);
        p.kids.splice(i + 1, 0, r.split.right);
      }
    }
    if (p.keys.length <= this.maxKeys) return { no: p.no };
    const right = this.alloc(p.leaf);
    if (p.leaf) {
      const keep = Math.ceil(p.keys.length / 2);
      right.keys = p.keys.splice(keep);
      right.vals = p.vals.splice(keep);
      return { no: p.no, split: { sep: right.keys[0]!, right: right.no } };
    }
    const kids = Math.ceil(p.kids.length / 2);
    const sep = p.keys[kids - 1]!;
    right.keys = p.keys.splice(kids);
    p.keys.pop();
    right.kids = p.kids.splice(kids);
    return { no: p.no, split: { sep, right: right.no } };
  }
  private pruneRoots() {
    const keep = new Set<number>([this.lastTxn, this.lastTxn - 1, ...this.readers.values()]);
    for (const k of [...this.roots.keys()]) if (!keep.has(k)) this.roots.delete(k);
  }
}

function lowerBound(keys: number[], k: number): number {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (keys[m]! < k) lo = m + 1;
    else hi = m;
  }
  return lo;
}
const childIndex = (keys: number[], k: number) => {
  let i = 0;
  while (i < keys.length && keys[i]! <= k) i++;
  return i;
};

// ============================================================================
// Write amplification
// ============================================================================

/**
 * Expected number of distinct pages that `batch` updates of random existing keys dirty in one
 * transaction, for a tree with the given number of nodes per level (root first):
 * sum over levels of m * (1 - (1 - 1/m)^batch).
 */
export function expectedDirtyPages(levelNodes: number[], batch: number): number {
  return levelNodes.reduce((a, m) => a + m * (1 - Math.pow(1 - 1 / m, batch)), 0);
}

export interface WriteAmpModel {
  n: number;
  pageBytes: number;
  /** Key + value bytes of one record. */
  recordBytes: number;
  /** Updates per transaction. */
  batch: number;
  /** Average page fill (default 0.69: random inserts). */
  fill?: number;
}

/** Nodes per level (root first) for the model. Fanout and leaf capacity come from page size. */
export function modelLevels(m: Pick<WriteAmpModel, "n" | "pageBytes" | "recordBytes" | "fill">): number[] {
  const fill = m.fill ?? 0.69;
  const usable = m.pageBytes - 64; // page header
  const leafCap = Math.max(1, Math.floor((usable * fill) / (m.recordBytes + 2)));
  const fanout = Math.max(2, Math.floor((usable * fill) / (16 + 2))); // 8-byte separator + 8-byte page number + slot
  const levels: number[] = [];
  let nodes = Math.max(1, Math.ceil(m.n / leafCap));
  levels.push(nodes);
  while (nodes > 1) levels.push((nodes = Math.ceil(nodes / fanout)));
  return levels.reverse();
}

/** Bytes written per update by a copy-on-write tree: dirty pages + one meta page per commit. */
export function cowBytesPerUpdate(m: WriteAmpModel): { height: number; pagesPerTxn: number; bytesPerUpdate: number; amplification: number } {
  const levels = modelLevels(m);
  const pagesPerTxn = expectedDirtyPages(levels, m.batch) + 1;
  const bytesPerUpdate = (pagesPerTxn * m.pageBytes) / m.batch;
  return { height: levels.length, pagesPerTxn, bytesPerUpdate, amplification: bytesPerUpdate / m.recordBytes };
}

// ============================================================================
// Experiments
// ============================================================================

/** Keys of the lesson demo tree (order 4, height 3). */
export const COW_DEMO_KEYS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

/** The lesson demo tree: COW_DEMO_KEYS inserted in one transaction. */
export function cowDemoTree(mode: CowMode = "reuse"): CowBTree {
  const t = new CowBTree({ order: 4, mode });
  t.begin();
  for (const k of COW_DEMO_KEYS) t.put(k, 0);
  t.commit();
  return t;
}

/** Builds a COW tree with keys 0..n-1 (values 0) inserted in the given order, in one transaction. */
export function buildCow(n: number, opts: { order?: number; pageBytes?: number; mode?: CowMode; insertOrder?: InsertOrder; seed?: number } = {}): CowBTree {
  const t = new CowBTree(opts);
  t.begin();
  for (const k of keyOrder(n, opts.insertOrder ?? "random", opts.seed ?? 3)) t.put(k, 0);
  t.commit();
  return t;
}

/**
 * File size (pages) after each of `updates` single-update transactions on random existing keys.
 * A reader opens before update `readerFrom` and closes after update `readerTo` (no reader if
 * readerFrom > readerTo).
 */
export function fileGrowth(opts: { n: number; order: number; updates: number; readerFrom: number; readerTo: number; mode: CowMode; seed?: number }): number[] {
  const t = buildCow(opts.n, { order: opts.order, mode: opts.mode, seed: 5 });
  const keys = keyOrder(opts.n, "random", opts.seed ?? 9);
  const out: number[] = [t.fileEnd];
  let reader = -1;
  for (let u = 0; u < opts.updates; u++) {
    if (u === opts.readerFrom && opts.readerFrom <= opts.readerTo) reader = t.openReader();
    t.update(keys[u % keys.length]!, u + 1);
    if (u === opts.readerTo && reader >= 0) {
      t.closeReader(reader);
      reader = -1;
    }
    out.push(t.fileEnd);
  }
  return out;
}

/** Height of the model tree (helper for labels). */
export function modelHeight(m: Pick<WriteAmpModel, "n" | "pageBytes" | "recordBytes" | "fill">): number {
  return modelLevels(m).length;
}
