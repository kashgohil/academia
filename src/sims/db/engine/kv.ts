/**
 * TinyKv: a small but complete embedded key-value engine, composed from the wave-1 pieces.
 *
 *   API        begin / get / put / del / commit / abort, snapshot reads (snapshot isolation)
 *   txn        version chains in the leaves, first-updater-wins write conflicts, commit timestamps
 *   access     a paged B+ tree (preemptive top-down splits, logged as redo-only structure records)
 *   pool       storage/BufferPool (pins, dirty bits, LRU or Clock) with this engine's PageIo
 *   file       pages with CRC-32C checksums (storage/durability crc32c), torn-write model
 *   wal        ARIES-style log: LSNs, prevLSN chains, full-page images, CLRs, fuzzy checkpoints
 *   os         write() and fsync() of the log, page writes into an OS cache, a data-file fsync
 *
 * Durability model
 * - Log records sit in a memory buffer. flushLog() does one write() and one fsync(). Records that
 *   were written but not synced survive a crash only as a random prefix.
 * - A page write goes into the OS cache. Each unsynced page write survives a crash or not, at
 *   random and in any order. dataFsync() (only in checkpoints) makes every page write durable.
 * - With the `torn` fault, a crash during a page write leaves a page with its first half new and
 *   its second half old. The checksum finds it, and a full-page image from the log repairs it.
 *
 * Protocol (what the deliberate bugs in `bugs` switch off)
 * - WAL rule: before a page write, the log is flushed up to the pageLSN.  [pageBeforeLog]
 * - Commit: the commit record is fsynced before the client hears "committed".  [skipLogFsync]
 * - Checksums: every page read checks the CRC-32C.  [noChecksums]
 * - Undo writes compensation log records (CLRs), so redo repeats the undo.  [dropClrs]
 * - The first change to a clean page logs a full image of that page.  [noFpi]
 *
 * Recovery = ARIES: analysis from the master record, redo (repeating history, page images
 * repair torn pages), logical undo of losers with CLRs, then a checkpoint. A crash can hit any
 * I/O point, also during recovery; `crashPlan` decides where.
 *
 * Pure TypeScript, deterministic with a seeded RNG, no React.
 */
import { BufferPool, type PolicyId } from "../storage/bufferpool";
import { crc32c } from "../storage/durability";
import type { Rng } from "../../rng";

// ---------------------------------------------------------------- types

/** One version of a value. `v === null` is a delete (a tombstone). `t` is the writing transaction. */
export interface Version { t: number; v: string | null }

export type PageKind = "meta" | "leaf" | "inner";

/**
 * A page. Leaves hold `keys` and one version chain per key in `cells` (newest first).
 * Inner pages hold separators in `keys` and child page numbers in `kids`.
 * Page 0 is the meta page: `root` and `alloc` (the next free page number).
 */
export interface PageImage {
  no: number;
  lsn: number;
  kind: PageKind;
  keys: string[];
  cells: Version[][];
  kids: number[];
  /** Right sibling of a leaf, or -1. */
  next: number;
  root: number;
  alloc: number;
}

export interface Stored { img: PageImage; crc: number }

interface RecBase { lsn: number }
interface TxnRecBase extends RecBase { txn: number; prev: number }
/** Full image of a page before its first change since it was last clean (torn-page repair). */
export interface FpiRec extends RecBase { kind: "fpi"; page: number; img: PageImage }
/** Set the version chain of `key` on leaf `page`. `before` = undo information (null: the key was absent). */
export interface CellRec extends TxnRecBase { kind: "cell"; page: number; key: string; before: Version[] | null; after: Version[] }
/** Compensation: the redo-only record of one undo step. */
export interface ClrRec extends TxnRecBase { kind: "clr"; page: number; key: string; after: Version[] | null; undoNext: number }
/** Structure modification (a split): after-images of every page it changed. Redo-only, never undone. */
export interface SmoRec extends RecBase { kind: "smo"; pages: PageImage[] }
export interface CommitRec extends TxnRecBase { kind: "commit"; ts: number }
export interface AbortRec extends TxnRecBase { kind: "abort" }
export interface EndRec extends TxnRecBase { kind: "end" }
export interface CkptBeginRec extends RecBase { kind: "ckpt_begin" }
export interface CkptEndRec extends RecBase { kind: "ckpt_end"; begin: number; att: { txn: number; status: TxnStatus; last: number }[]; dpt: { page: number; recLSN: number }[]; nextTxn: number }
export type LogRec = FpiRec | CellRec | ClrRec | SmoRec | CommitRec | AbortRec | EndRec | CkptBeginRec | CkptEndRec;
type NoLsn<R> = R extends LogRec ? Omit<R, "lsn"> : never;

export type TxnStatus = "running" | "aborting" | "committed" | "aborted";

export interface Txn {
  id: number;
  readOnly: boolean;
  status: TxnStatus;
  /** Snapshot: commits with ts <= snap are visible. */
  snap: number;
  ts: number;
  /** Last log record of this transaction (0 = none). */
  last: number;
  writes: Map<string, string | null>;
}

/** Deliberate bugs, for the crash-testing lesson. */
export type BugId = "skipLogFsync" | "pageBeforeLog" | "noChecksums" | "dropClrs" | "noFpi";
export const BUGS: { id: BugId; label: string; what: string }[] = [
  { id: "skipLogFsync", label: "Skip the log fsync", what: "flushLog() calls write() but not fsync(), and commit still says committed" },
  { id: "pageBeforeLog", label: "Write the page before the log", what: "the buffer pool writes a dirty page without flushing the log to its pageLSN" },
  { id: "noChecksums", label: "Disable checksums", what: "page reads do not check the CRC-32C" },
  { id: "dropClrs", label: "Drop CLRs", what: "undo changes the page but writes no compensation record" },
  { id: "noFpi", label: "Skip full-page images", what: "the first change to a clean page logs no page image" },
];

export interface Faults {
  /** A crash during a page write leaves the page half new, half old. */
  torn?: boolean;
  /** Probability that an fsync returns success but makes nothing durable (a lying device). */
  lostFsync?: number;
  /** Probability that a crash also flips a bit in one durable leaf page. */
  bitflip?: number;
}

export interface KvConfig {
  /** Max keys in a leaf page. */
  leafCap: number;
  /** Max separators in an inner page (children = innerCap + 1). */
  innerCap: number;
  /** Buffer pool frames. */
  frames: number;
  policy: PolicyId;
  /** Commits that share one log flush (1 = fsync each commit). */
  groupCommit: number;
  /** Nominal page size for byte counters. */
  pageBytes: number;
  bugs: Partial<Record<BugId, boolean>>;
  faults: Faults;
  /** Record a per-layer event list (for the architecture demo). */
  events: boolean;
}

export const KV_DEFAULTS: KvConfig = { leafCap: 4, innerCap: 4, frames: 16, policy: "lru", groupCommit: 1, pageBytes: 4096, bugs: {}, faults: {}, events: false };

export type IoKind = "log.write" | "log.fsync" | "page.write" | "data.fsync" | "master.write";
export const IO_KINDS: IoKind[] = ["log.write", "log.fsync", "page.write", "data.fsync", "master.write"];
/** What the engine was doing when an I/O happened. */
export type IoCtx = "write" | "read" | "commit" | "abort" | "checkpoint" | "redo" | "undo" | "restart";
export const IO_CTXS: IoCtx[] = ["write", "read", "commit", "abort", "checkpoint", "redo", "undo", "restart"];

export interface IoEvent { seq: number; kind: IoKind; ctx: IoCtx; page?: number; evict: boolean }

export type Layer = "api" | "txn" | "tree" | "pool" | "file" | "wal" | "os";
export const LAYERS: Layer[] = ["api", "txn", "tree", "pool", "file", "wal", "os"];
export interface LayerEvent { layer: Layer; text: string }

export interface KvStats {
  pageReads: number;
  pageWrites: number;
  checksumChecks: number;
  checksumFails: number;
  logRecords: number;
  logBytes: number;
  logWrites: number;
  logFsyncs: number;
  dataFsyncs: number;
  masterWrites: number;
  splits: number;
  treeVisits: number;
  fpis: number;
  clrs: number;
  commits: number;
  aborts: number;
  conflicts: number;
}
const zeroStats = (): KvStats => ({ pageReads: 0, pageWrites: 0, checksumChecks: 0, checksumFails: 0, logRecords: 0, logBytes: 0, logWrites: 0, logFsyncs: 0, dataFsyncs: 0, masterWrites: 0, splits: 0, treeVisits: 0, fpis: 0, clrs: 0, commits: 0, aborts: 0, conflicts: 0 });

/** The client-side truth that survives a crash: every commit attempt in order, and how many were acknowledged. */
export interface Oracle {
  attempts: { txn: number; lsn: number; writes: Map<string, string | null> }[];
  acked: number;
}

/** Everything a power cut leaves behind. */
export interface DurableImage {
  pages: Map<number, Stored>;
  log: LogRec[];
  master: number;
  oracle: Oracle;
  cfg: KvConfig;
  /** What happened to unsynced writes (for display). */
  lostLogRecords: number;
  lostPageWrites: number;
  tornPages: number[];
  flippedPage: number | null;
}

export class CrashSignal extends Error { constructor(readonly at: IoEvent) { super(`crash at ${at.kind}`); } }
export class ConflictError extends Error { constructor(readonly txn: number, readonly key: string, readonly why: string) { super(`T${txn} aborted: ${why}`); } }
export class CorruptPageError extends Error { constructor(readonly page: number, readonly why: string) { super(`page ${page}: ${why}`); } }

export interface RecoveryReport {
  analysisFrom: number;
  redoFrom: number;
  analysed: number;
  redone: number;
  skipped: number;
  imagesInstalled: number;
  tornFound: number[];
  losers: number[];
  winners: number[];
  clrs: number;
}

// ---------------------------------------------------------------- page helpers

export const clonePage = (p: PageImage): PageImage => ({ ...p, keys: p.keys.slice(), cells: p.cells.map((c) => c.map((v) => ({ ...v }))), kids: p.kids.slice() });
const emptyPage = (no: number, kind: PageKind): PageImage => ({ no, lsn: 0, kind, keys: [], cells: [], kids: [], next: -1, root: 0, alloc: 0 });
const enc = new TextEncoder();
const ser = (p: PageImage) => JSON.stringify([p.no, p.lsn, p.kind, p.keys, p.cells.map((c) => c.map((v) => [v.t, v.v])), p.kids, p.next, p.root, p.alloc]);
/** CRC-32C of a page's canonical bytes. */
export const pageCrc = (p: PageImage) => crc32c(enc.encode(ser(p)));
const store = (p: PageImage): Stored => ({ img: clonePage(p), crc: pageCrc(p) });

/** A torn write: the header and the first half of the entries are new, the rest is old. */
export function tornPage(neu: PageImage, old: PageImage | null): PageImage {
  const o = old ?? emptyPage(neu.no, neu.kind);
  const h = Math.ceil(neu.keys.length / 2);
  const mix = <T,>(a: T[], b: T[], n: number) => [...a.slice(0, n), ...b.slice(n)];
  return { ...clonePage(neu), keys: mix(neu.keys, o.keys, h), cells: neu.kind === "leaf" ? mix(neu.cells, o.cells, h).map((c) => c.map((v) => ({ ...v }))) : [], kids: neu.kind === "inner" ? mix(neu.kids, o.kids, h + 1) : [] };
}

const upper = (keys: string[], k: string) => { let lo = 0, hi = keys.length; while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m]! <= k) lo = m + 1; else hi = m; } return lo; };
const lower = (keys: string[], k: string) => { let lo = 0, hi = keys.length; while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m]! < k) lo = m + 1; else hi = m; } return lo; };

/** Sets (or removes, with null) the chain of `key` in a leaf. */
function setCell(p: PageImage, key: string, chain: Version[] | null) {
  const i = lower(p.keys, key);
  const has = i < p.keys.length && p.keys[i] === key;
  if (chain === null) { if (has) { p.keys.splice(i, 1); p.cells.splice(i, 1); } return; }
  const c = chain.map((v) => ({ ...v }));
  if (has) p.cells[i] = c; else { p.keys.splice(i, 0, key); p.cells.splice(i, 0, c); }
}

const chainBytes = (c: Version[] | null) => (c ? c.reduce((s, v) => s + 8 + (v.v?.length ?? 0), 0) : 0);
/** Log record size: a 24-byte header (as in PostgreSQL) plus the body. Page images count the full page. */
export function recBytes(r: LogRec, pageBytes = 4096): number {
  const H = 24;
  switch (r.kind) {
    case "fpi": return H + 4 + pageBytes;
    case "smo": return H + r.pages.length * (4 + pageBytes);
    case "cell": return H + 4 + 2 + r.key.length + chainBytes(r.before) + chainBytes(r.after);
    case "clr": return H + 4 + 2 + r.key.length + chainBytes(r.after) + 8;
    case "commit": return H + 8;
    case "ckpt_end": return H + 12 + r.att.length * 17 + r.dpt.length * 12;
    default: return H;
  }
}

/** Pages a record changes, with the action redo takes on each. */
export function recPages(r: LogRec): { page: number; image?: PageImage; chain?: Version[] | null; key?: string }[] {
  switch (r.kind) {
    case "fpi": return [{ page: r.page, image: r.img }];
    case "smo": return r.pages.map((p) => ({ page: p.no, image: p }));
    case "cell": return [{ page: r.page, key: r.key, chain: r.after }];
    case "clr": return [{ page: r.page, key: r.key, chain: r.after }];
    default: return [];
  }
}

const isTxnRec = (r: LogRec): r is CellRec | ClrRec | CommitRec | AbortRec | EndRec => "txn" in r;

// ---------------------------------------------------------------- the engine

export class TinyKv {
  readonly cfg: KvConfig;
  readonly bp: BufferPool;
  /** Durable page images (after the last data fsync), and unsynced page writes in the OS cache. */
  synced = new Map<number, Stored>();
  cached = new Map<number, Stored>();
  /** The whole log; log[i].lsn === i + 1. */
  log: LogRec[] = [];
  /** End of the log passed to write(). */
  writtenLSN = 0;
  /** End of the log that is really durable. */
  syncedLSN = 0;
  /** End of the log that the engine believes is durable (after its fsync returned). */
  flushedLSN = 0;
  /** begin LSN of the last complete checkpoint. Durable (written atomically). */
  master = 0;
  oracle: Oracle = { attempts: [], acked: 0 };
  /** In-memory transaction state. A transaction that is not here is committed with ts 0 (it ran before the last restart). */
  txns = new Map<number, Txn>();
  nextTxn = 1;
  /** Commit timestamp counter. */
  ts = 1;
  root = 1;
  stats: KvStats = zeroStats();
  events: LayerEvent[] = [];
  /** First LSN that dirtied each cached page. */
  recLSN = new Map<number, number>();
  /** Called at each I/O point; return true to crash there. */
  crashPlan: ((e: IoEvent) => boolean) | null = null;
  /** Called at each I/O point (coverage). */
  onIo: ((e: IoEvent) => void) | null = null;
  ioSeq = 0;
  /** True after a crash until recover(). */
  needsRecovery = false;
  dead = false;
  lastRecovery: RecoveryReport | null = null;
  rng: Rng;

  private frameImg: (PageImage | null)[];
  private frameValid: boolean[];
  private fresh = new Set<number>();
  private pinned = new Map<number, number>();
  private dirtyNow = new Set<number>();
  private ctx: IoCtx = "write";
  private evicting = false;
  private tolerant = false;
  private pendingFlush = 0;
  /** LSN of the full-page image of each page in this checkpoint cycle. */
  private fpiLsn = new Map<number, number>();

  constructor(cfg: Partial<KvConfig> = {}, image?: DurableImage, rng: Rng = Math.random) {
    this.cfg = { ...KV_DEFAULTS, ...(image?.cfg ?? {}), ...cfg, bugs: { ...(image?.cfg.bugs ?? {}), ...(cfg.bugs ?? {}) }, faults: { ...(image?.cfg.faults ?? {}), ...(cfg.faults ?? {}) } };
    this.rng = rng;
    this.frameImg = new Array(this.cfg.frames).fill(null);
    this.frameValid = new Array(this.cfg.frames).fill(false);
    this.bp = new BufferPool(this.cfg.frames, this.cfg.policy, { read: (p, f) => this.ioRead(p, f), write: (p, f) => this.ioWrite(p, f) });
    if (image) {
      for (const [no, s] of image.pages) this.synced.set(no, { img: clonePage(s.img), crc: s.crc });
      this.log = image.log.slice();
      this.writtenLSN = this.syncedLSN = this.flushedLSN = this.log.length;
      this.master = image.master;
      // Commits that were in flight at the crash can never be acknowledged by the new log.
      this.oracle = { attempts: image.oracle.attempts.map((a, i) => (i < image.oracle.acked ? a : { ...a, lsn: Infinity })), acked: image.oracle.acked };
      this.needsRecovery = true;
    } else {
      // Format: meta page 0 names root leaf 1. Both are durable before the first operation.
      const meta: PageImage = { ...emptyPage(0, "meta"), root: 1, alloc: 2 };
      this.synced.set(0, store(meta));
      this.synced.set(1, store(emptyPage(1, "leaf")));
    }
  }

  // ------------------------------------------------------------ events and I/O points

  private ev(layer: Layer, text: string) { if (this.cfg.events) this.events.push({ layer, text }); }

  private io(kind: IoKind, page?: number, img?: PageImage) {
    const e: IoEvent = { seq: ++this.ioSeq, kind, ctx: this.ctx, page, evict: this.evicting };
    this.onIo?.(e);
    if (this.crashPlan?.(e)) {
      if (kind === "page.write" && this.cfg.faults.torn && img && page !== undefined) {
        const old = this.cached.get(page) ?? this.synced.get(page) ?? null;
        const t = tornPage(img, old?.img ?? null);
        this.synced.set(page, { img: t, crc: pageCrc(img) });
        this.cached.delete(page);
        this.tornAt = page;
      }
      this.dead = true;
      throw new CrashSignal(e);
    }
  }
  private tornAt: number | null = null;

  private fsyncWorks() { const p = this.cfg.faults.lostFsync ?? 0; return p <= 0 || this.rng() >= p; }

  // ------------------------------------------------------------ the file layer (PageIo for the pool)

  private ioRead(page: number, frame: number) {
    if (this.fresh.has(page)) {
      this.fresh.delete(page);
      this.frameImg[frame] = emptyPage(page, "leaf");
      this.frameValid[frame] = true;
      return;
    }
    const s = this.cached.get(page) ?? this.synced.get(page);
    this.stats.pageReads++;
    if (!s) {
      this.frameImg[frame] = emptyPage(page, "leaf");
      this.frameValid[frame] = false;
      this.ev("file", `read page ${page}: not on disk`);
      return;
    }
    const img = clonePage(s.img);
    let ok = true;
    if (!this.cfg.bugs.noChecksums) {
      this.stats.checksumChecks++;
      ok = pageCrc(img) === s.crc;
      if (!ok) this.stats.checksumFails++;
    }
    this.frameImg[frame] = img;
    this.frameValid[frame] = ok;
    this.ev("file", `read page ${page} (${this.cfg.pageBytes} B), CRC-32C ${this.cfg.bugs.noChecksums ? "not checked" : ok ? "ok" : "WRONG"}`);
    this.ev("os", `pread(data file, page ${page})`);
  }

  private ioWrite(page: number, frame: number) {
    const img = this.frameImg[frame]!;
    if (!this.cfg.bugs.pageBeforeLog && img.lsn > this.flushedLSN) {
      this.ev("wal", `WAL rule: page ${page} has pageLSN ${img.lsn} > flushed ${this.flushedLSN}, so flush the log first`);
      this.flushLog(img.lsn);
    }
    this.io("page.write", page, img);
    this.cached.set(page, store(img));
    this.recLSN.delete(page);
    this.stats.pageWrites++;
    this.ev("file", `write page ${page} (${this.cfg.pageBytes} B) with a new CRC-32C`);
    this.ev("os", `pwrite(data file, page ${page}) into the OS cache`);
  }

  /** Makes every page write durable (only checkpoints call it). */
  private dataFsync() {
    this.io("data.fsync");
    this.stats.dataFsyncs++;
    if (this.fsyncWorks()) { for (const [no, s] of this.cached) this.synced.set(no, s); this.cached.clear(); }
    this.ev("os", "fsync(data file)");
  }

  private writeMaster(lsn: number) {
    this.io("master.write");
    this.master = lsn;
    this.stats.masterWrites++;
    this.ev("os", `write + fsync(master record) = checkpoint at LSN ${lsn}`);
  }

  // ------------------------------------------------------------ the log

  get lastLSN() { return this.log.length; }
  rec(lsn: number): LogRec { const r = this.log[lsn - 1]; if (!r) throw new Error(`no record at LSN ${lsn}`); return r; }

  private append<R extends LogRec>(r: NoLsn<R>): R {
    const rec = { ...r, lsn: this.log.length + 1 } as R;
    this.log.push(rec);
    const b = recBytes(rec, this.cfg.pageBytes);
    this.stats.logRecords++;
    this.stats.logBytes += b;
    this.ev("wal", `append ${rec.kind} at LSN ${rec.lsn} (${b} B) to the log buffer`);
    return rec;
  }

  /** write() + fsync() of the log up to `upTo`. Then acknowledges the commits it made durable. */
  flushLog(upTo = this.lastLSN) {
    const to = Math.min(upTo, this.lastLSN);
    if (to <= this.flushedLSN) return;
    this.io("log.write");
    const bytes = this.log.slice(this.writtenLSN, to).reduce((s, r) => s + recBytes(r, this.cfg.pageBytes), 0);
    this.writtenLSN = Math.max(this.writtenLSN, to);
    this.stats.logWrites++;
    this.ev("os", `write(log, ${bytes} B: LSN ${this.flushedLSN + 1}..${to})`);
    if (!this.cfg.bugs.skipLogFsync) {
      this.io("log.fsync");
      this.stats.logFsyncs++;
      if (this.fsyncWorks()) this.syncedLSN = this.writtenLSN;
      this.ev("os", "fsync(log)");
    }
    this.flushedLSN = to;
    let acked = this.oracle.acked;
    while (acked < this.oracle.attempts.length && this.oracle.attempts[acked]!.lsn <= this.flushedLSN) acked++;
    if (acked > this.oracle.acked) this.ev("api", `${acked - this.oracle.acked} commit(s) acknowledged to clients`);
    this.oracle.acked = acked;
    this.pendingFlush = this.oracle.attempts.length - acked;
  }

  // ------------------------------------------------------------ the buffer pool, pins

  private pg(no: number): PageImage {
    const f0 = this.pinned.get(no);
    if (f0 !== undefined) return this.check(no, f0);
    this.evicting = true;
    let r;
    try { r = this.bp.fetch(no); } finally { this.evicting = false; }
    if (r.evicted) this.ev("pool", `evict page ${r.evicted.page}${r.evicted.dirty ? " (dirty: written back)" : ""} from frame ${r.frame}`);
    this.ev("pool", `${r.hit ? "hit" : "miss"}: page ${no} in frame ${r.frame}, pinned`);
    this.pinned.set(no, r.frame);
    return this.check(no, r.frame);
  }

  private check(no: number, f: number): PageImage {
    if (!this.frameValid[f] && !this.tolerant) { this.dead = true; throw new CorruptPageError(no, "checksum mismatch: the page is torn or corrupt"); }
    return this.frameImg[f]!;
  }

  private frameOf(no: number) { return this.pinned.get(no) ?? this.bp.table.get(no); }
  private isDirty(no: number) { if (this.dirtyNow.has(no)) return true; const f = this.bp.table.get(no); return f !== undefined && this.bp.frames[f]!.dirty; }
  private markDirty(no: number, lsn: number) { if (!this.isDirty(no)) this.recLSN.set(no, lsn); this.dirtyNow.add(no); }

  private endOp() {
    for (const no of this.pinned.keys()) this.bp.unpin(no, this.dirtyNow.has(no));
    this.pinned.clear();
    this.dirtyNow.clear();
  }

  private alloc(kind: PageKind): PageImage {
    const meta = this.pg(0);
    const no = meta.alloc++;
    this.fresh.add(no);
    const p = this.pg(no);
    Object.assign(p, emptyPage(no, kind));
    return p;
  }

  // ------------------------------------------------------------ transactions

  begin(readOnly = false): number {
    this.alive();
    const id = this.nextTxn++;
    const t: Txn = { id, readOnly, status: "running", snap: this.ts, ts: 0, last: 0, writes: new Map() };
    this.txns.set(id, t);
    this.running.add(t);
    this.ev("api", `begin T${id}${readOnly ? " (read-only)" : ""}`);
    this.ev("txn", `T${id} takes snapshot ts ${this.ts}: it sees commits with ts ≤ ${this.ts}`);
    return id;
  }

  private tx(id: number): Txn {
    const t = this.txns.get(id);
    if (!t || (t.status !== "running")) throw new Error(`T${id} is not running`);
    return t;
  }

  /** Commit timestamp of a version's transaction, or -1 if it is not committed. */
  private tsOf(txn: number): number {
    const t = this.txns.get(txn);
    if (!t) return 0;
    return t.status === "committed" ? t.ts : -1;
  }

  /** The value of a chain that a reader sees. */
  private visible(chain: Version[], reader: Txn | null): string | null {
    for (const v of chain) {
      if (reader && v.t === reader.id) return v.v;
      const ts = this.tsOf(v.t);
      if (ts >= 0 && ts <= (reader ? reader.snap : this.ts)) return v.v;
    }
    return null;
  }

  private running = new Set<Txn>();
  private oldestSnap(): number {
    let m = this.ts;
    for (const t of this.running) if (t.snap < m) m = t.snap;
    return m;
  }

  /** Drops committed versions that no snapshot can see. Keeps the head. */
  private prune(chain: Version[]): Version[] {
    const old = this.oldestSnap();
    const out = [chain[0]!];
    for (let i = 1; i < chain.length; i++) {
      const v = chain[i]!;
      out.push(v);
      const ts = this.tsOf(v.t);
      if (ts >= 0 && ts <= old) break;
    }
    return out;
  }

  private findLeaf(key: string): number {
    let no = this.root, depth = 0;
    for (;;) {
      const p = this.pg(no);
      this.stats.treeVisits++;
      this.ev("tree", `visit ${p.kind} page ${no} at depth ${depth}${p.kind === "inner" ? ` (separators ${p.keys.join(", ") || "none"})` : ""}`);
      if (p.kind !== "inner") return no;
      no = p.kids[upper(p.keys, key)]!;
      depth++;
    }
  }

  get(txn: number | null, key: string): string | undefined {
    this.alive();
    this.ctx = "read";
    const t = txn === null ? null : this.txns.get(txn) ?? null;
    if (txn !== null && (!t || t.status !== "running")) throw new Error(`T${txn} is not running`);
    this.ev("api", `get(${key})${t ? ` in T${t.id}` : ""}`);
    try {
      const leaf = this.pg(this.findLeaf(key));
      const i = lower(leaf.keys, key);
      const chain = i < leaf.keys.length && leaf.keys[i] === key ? leaf.cells[i]! : [];
      const v = this.visible(chain, t);
      this.ev("txn", chain.length ? `chain of ${key} has ${chain.length} version(s); the snapshot sees ${v === null ? "none (absent or deleted)" : `"${v}"`}` : `${key} is not in the leaf`);
      return v ?? undefined;
    } finally { this.endOp(); }
  }

  put(txn: number, key: string, value: string) { this.write(txn, key, value); }
  del(txn: number, key: string) { this.write(txn, key, null); }

  private write(txn: number, key: string, value: string | null) {
    this.alive();
    this.ctx = "write";
    const t = this.tx(txn);
    if (t.readOnly) throw new Error(`T${txn} is read-only`);
    this.ev("api", value === null ? `delete(${key}) in T${txn}` : `put(${key}, ${value}) in T${txn}`);
    let conflict: string | null = null;
    try {
      let leafNo = this.findLeaf(key);
      let leaf = this.pg(leafNo);
      let i = lower(leaf.keys, key);
      const has = i < leaf.keys.length && leaf.keys[i] === key;
      const chain = has ? leaf.cells[i]! : [];
      const head = chain[0];
      if (head && head.t !== txn) {
        const ts = this.tsOf(head.t);
        if (ts < 0) conflict = `T${head.t} has an uncommitted version of ${key}`;
        else if (ts > t.snap) conflict = `${key} was committed at ts ${ts}, after the snapshot ts ${t.snap}`;
      }
      if (!conflict) {
        if (value === null && !has) { this.ev("txn", `${key} does not exist: nothing to delete`); return; }
        this.ev("txn", head && head.t !== txn ? `no conflict: the newest version of ${key} is committed at ts ${this.tsOf(head.t)} ≤ ${t.snap}` : `T${txn} may write ${key}`);
        if (!has && leaf.keys.length >= this.cfg.leafCap) {
          leafNo = this.splitDescend(key);
          leaf = this.pg(leafNo);
          i = lower(leaf.keys, key);
        }
        const rest = head && head.t === txn ? chain.slice(1) : chain;
        const after = this.prune([{ t: txn, v: value }, ...rest.map((v) => ({ ...v }))]);
        this.logCell(t, leafNo, key, has ? chain.map((v) => ({ ...v })) : null, after);
        t.writes.set(key, value);
      }
    } finally { this.endOp(); }
    if (conflict) {
      this.stats.conflicts++;
      this.ev("txn", `write-write conflict: ${conflict}. First updater wins, so T${txn} aborts`);
      this.abort(txn);
      throw new ConflictError(txn, key, conflict);
    }
  }

  /**
   * Full-page images, as PostgreSQL's full_page_writes: the first change to a page after a
   * checkpoint logs an image of the page. A page that becomes dirty again later in the same
   * checkpoint cycle gets that image's LSN as its recLSN, so redo always starts at an image.
   */
  private logFpi(no: number) {
    if (this.cfg.bugs.noFpi || this.isDirty(no)) return;
    const had = this.fpiLsn.get(no);
    if (had !== undefined) { this.markDirty(no, had); return; }
    const r = this.append<FpiRec>({ kind: "fpi", page: no, img: clonePage(this.pg(no)) });
    this.fpiLsn.set(no, r.lsn);
    this.stats.fpis++;
    this.markDirty(no, r.lsn);
  }

  private logCell(t: Txn, leafNo: number, key: string, before: Version[] | null, after: Version[]) {
    this.logFpi(leafNo);
    const r = this.append<CellRec>({ kind: "cell", txn: t.id, prev: t.last, page: leafNo, key, before, after });
    const leaf = this.pg(leafNo);
    setCell(leaf, key, after);
    leaf.lsn = r.lsn;
    this.markDirty(leafNo, r.lsn);
    t.last = r.lsn;
    this.ev("tree", `leaf ${leafNo}: ${key} now has ${after.length} version(s); pageLSN = ${r.lsn}, page dirty`);
  }

  /** Descends again for an insert into a full leaf, splitting every full page on the way (top-down). */
  private splitDescend(key: string): number {
    let parent = -1, no = this.root;
    for (;;) {
      let p = this.pg(no);
      const full = p.kind === "leaf" ? p.keys.length >= this.cfg.leafCap : p.keys.length >= this.cfg.innerCap;
      if (full) {
        const [l, r, sep] = this.split(no, parent);
        no = key < sep ? l : r;
        p = this.pg(no);
      }
      if (p.kind === "leaf") return no;
      parent = no;
      no = p.kids[upper(p.keys, key)]!;
    }
  }

  /** Splits page `no` (parent has room). Logs one redo-only structure record. */
  private split(no: number, parentNo: number): [number, number, string] {
    const n = this.pg(no);
    const right = this.alloc(n.kind);
    let sep: string;
    if (n.kind === "leaf") {
      const h = Math.ceil(n.keys.length / 2);
      right.keys = n.keys.splice(h);
      right.cells = n.cells.splice(h);
      right.next = n.next;
      n.next = right.no;
      sep = right.keys[0]!;
    } else {
      const mid = Math.floor(n.keys.length / 2);
      sep = n.keys[mid]!;
      right.keys = n.keys.splice(mid + 1);
      n.keys.pop();
      right.kids = n.kids.splice(mid + 1);
    }
    const meta = this.pg(0);
    let parent: PageImage;
    if (parentNo < 0) {
      parent = this.alloc("inner");
      parent.keys = [sep];
      parent.kids = [no, right.no];
      meta.root = parent.no;
      this.root = parent.no;
    } else {
      parent = this.pg(parentNo);
      const i = parent.kids.indexOf(no);
      parent.keys.splice(i, 0, sep);
      parent.kids.splice(i + 1, 0, right.no);
    }
    const lsn = this.lastLSN + 1;
    const touched = [n, right, parent, meta];
    for (const p of touched) p.lsn = lsn;
    this.append<SmoRec>({ kind: "smo", pages: touched.map(clonePage) });
    for (const p of touched) { this.markDirty(p.no, lsn); if (!this.fpiLsn.has(p.no)) this.fpiLsn.set(p.no, lsn); }
    this.stats.splits++;
    this.ev("tree", `split ${n.kind} page ${no}: new page ${right.no}, separator ${sep} goes to page ${parent.no}${parentNo < 0 ? " (new root)" : ""}`);
    return [no, right.no, sep];
  }

  commit(txn: number): { durable: boolean; ts: number } {
    this.alive();
    this.ctx = "commit";
    const t = this.tx(txn);
    this.running.delete(t);
    this.ev("api", `commit T${txn}`);
    if (t.readOnly || t.last === 0) {
      t.status = "committed";
      t.ts = 0;
      this.txns.delete(txn);
      this.ev("txn", `T${txn} wrote nothing: no log record, no fsync`);
      return { durable: true, ts: 0 };
    }
    const ts = ++this.ts;
    const r = this.append<CommitRec>({ kind: "commit", txn, prev: t.last, ts });
    t.last = r.lsn;
    t.status = "committed";
    t.ts = ts;
    this.append<EndRec>({ kind: "end", txn, prev: r.lsn });
    this.oracle.attempts.push({ txn, lsn: r.lsn, writes: new Map(t.writes) });
    this.stats.commits++;
    this.pendingFlush++;
    this.ev("txn", `T${txn} gets commit ts ${ts}; its versions are visible to snapshots ≥ ${ts}`);
    if (this.pendingFlush >= this.cfg.groupCommit) this.flushLog();
    else this.ev("wal", `group commit: ${this.pendingFlush} of ${this.cfg.groupCommit} commits wait for one shared flush`);
    return { durable: r.lsn <= this.flushedLSN, ts };
  }

  /** Forces the log (group commit timeout, or the user asks). */
  sync() { this.alive(); this.ctx = "commit"; this.flushLog(); }

  abort(txn: number) {
    this.alive();
    this.ctx = "abort";
    const t = this.txns.get(txn);
    if (!t || t.status !== "running") throw new Error(`T${txn} is not running`);
    this.running.delete(t);
    this.ev("api", `abort T${txn}`);
    if (t.readOnly || t.last === 0) { t.status = "aborted"; this.txns.delete(txn); return; }
    const r = this.append<AbortRec>({ kind: "abort", txn, prev: t.last });
    t.last = r.lsn;
    t.status = "aborting";
    this.rollback(t);
    this.stats.aborts++;
  }

  private undoNext(lsn: number): number {
    let l = lsn;
    while (l !== 0) {
      const r = this.rec(l);
      if (r.kind === "cell") return l;
      if (r.kind === "clr") l = r.undoNext;
      else if (isTxnRec(r)) l = r.prev;
      else return 0;
    }
    return 0;
  }

  private rollback(t: Txn) {
    let next = this.undoNext(t.last);
    while (next !== 0) {
      const r = this.rec(next) as CellRec;
      this.undoOne(t, r);
      next = this.undoNext(r.prev);
    }
    this.finish(t);
  }

  /** Logical undo: find the key again (a split may have moved it), restore its chain, log a CLR. */
  private undoOne(t: Txn, r: CellRec) {
    try {
      const leafNo = this.findLeaf(r.key);
      const leaf = this.pg(leafNo);
      if (this.cfg.bugs.dropClrs) {
        setCell(leaf, r.key, r.before);
        this.markDirty(leafNo, this.lastLSN + 1);
        this.ev("tree", `undo LSN ${r.lsn} on leaf ${leafNo} with no CLR`);
        return;
      }
      this.logFpi(leafNo);
      const clr = this.append<ClrRec>({ kind: "clr", txn: t.id, prev: t.last, page: leafNo, key: r.key, after: r.before, undoNext: r.prev });
      setCell(leaf, r.key, r.before);
      leaf.lsn = clr.lsn;
      this.markDirty(leafNo, clr.lsn);
      t.last = clr.lsn;
      this.stats.clrs++;
      this.ev("tree", `undo LSN ${r.lsn}: leaf ${leafNo} gets the old chain of ${r.key}; CLR ${clr.lsn} points to ${r.prev}`);
    } finally { this.endOp(); }
  }

  private finish(t: Txn) {
    this.append<EndRec>({ kind: "end", txn: t.id, prev: t.last });
    t.status = "aborted";
  }

  // ------------------------------------------------------------ checkpoints

  /** Begin record, write every dirty page, fsync the data file, end record, flush, master record. */
  checkpoint(): number {
    this.alive();
    if (this.ctx !== "restart") this.ctx = "checkpoint";
    this.ev("api", "checkpoint");
    const b = this.append<CkptBeginRec>({ kind: "ckpt_begin" });
    this.fpiLsn.clear();
    let n = 0;
    for (const [no, f] of [...this.bp.table]) if (this.bp.frames[f]!.dirty) { this.bp.flush(no); n++; }
    this.ev("pool", `checkpoint wrote ${n} dirty page(s)`);
    this.dataFsync();
    const att = [...this.txns.values()].filter((t) => !t.readOnly && t.last > 0 && (t.status === "running" || t.status === "aborting")).map((t) => ({ txn: t.id, status: t.status, last: t.last }));
    const dpt = [...this.recLSN].map(([page, recLSN]) => ({ page, recLSN }));
    const e = this.append<CkptEndRec>({ kind: "ckpt_end", begin: b.lsn, att, dpt, nextTxn: this.nextTxn });
    this.flushLog(e.lsn);
    this.writeMaster(b.lsn);
    return b.lsn;
  }

  // ------------------------------------------------------------ crash

  /**
   * Power loss now. Returns what stays on disk: synced pages, plus each unsynced page write with
   * probability 1/2; the synced log, plus a random prefix of the written but unsynced records.
   */
  crash(rng: Rng = this.rng): DurableImage {
    const pages = new Map<number, Stored>();
    for (const [no, s] of this.synced) pages.set(no, s);
    let lostPages = 0;
    for (const [no, s] of this.cached) { if (rng() < 0.5) pages.set(no, s); else lostPages++; }
    const keep = this.syncedLSN + Math.floor(rng() * (this.writtenLSN - this.syncedLSN + 1));
    let flipped: number | null = null;
    if ((this.cfg.faults.bitflip ?? 0) > 0 && rng() < this.cfg.faults.bitflip!) {
      const leaves = [...pages.values()].filter((s) => s.img.kind === "leaf" && s.img.cells.some((c) => c.some((v) => v.v)));
      if (leaves.length) {
        const s = leaves[Math.floor(rng() * leaves.length)]!;
        const img = clonePage(s.img);
        const v = img.cells.flat().find((x) => x.v)!;
        v.v = v.v!.slice(0, -1) + String.fromCharCode(v.v!.charCodeAt(v.v!.length - 1) ^ 1);
        pages.set(img.no, { img, crc: s.crc });
        flipped = img.no;
      }
    }
    this.dead = true;
    return {
      pages, log: this.log.slice(0, keep), master: this.master,
      oracle: { attempts: this.oracle.attempts.map((a) => ({ ...a, writes: new Map(a.writes) })), acked: this.oracle.acked },
      cfg: this.cfg, lostLogRecords: this.lastLSN - keep, lostPageWrites: lostPages, tornPages: this.tornAt === null ? [] : [this.tornAt], flippedPage: flipped,
    };
  }

  // ------------------------------------------------------------ recovery

  /** ARIES restart: analysis, redo, undo, checkpoint. Throws CorruptPageError if a page cannot be repaired. */
  recover(): RecoveryReport {
    if (!this.needsRecovery) throw new Error("the engine is not crashed");
    const rep: RecoveryReport = { analysisFrom: this.master || 1, redoFrom: 0, analysed: 0, redone: 0, skipped: 0, imagesInstalled: 0, tornFound: [], losers: [], winners: [], clrs: 0 };
    // ---- analysis
    const att = new Map<number, { status: TxnStatus; last: number; ts: number }>();
    const dpt = new Map<number, number>();
    let start = 1, maxTxn = 0;
    if (this.master) {
      const end = this.log.find((r): r is CkptEndRec => r.kind === "ckpt_end" && r.begin === this.master);
      if (end) {
        for (const a of end.att) att.set(a.txn, { status: a.status, last: a.last, ts: 0 });
        for (const d of end.dpt) dpt.set(d.page, d.recLSN);
        maxTxn = end.nextTxn - 1;
      }
      start = this.master + 1;
    }
    for (let l = start; l <= this.lastLSN; l++) {
      const r = this.rec(l);
      rep.analysed++;
      if (isTxnRec(r)) {
        maxTxn = Math.max(maxTxn, r.txn);
        const a = att.get(r.txn) ?? { status: "running" as TxnStatus, last: 0, ts: 0 };
        a.last = r.lsn;
        if (r.kind === "commit") { a.status = "committed"; a.ts = r.ts; }
        if (r.kind === "abort") a.status = "aborting";
        att.set(r.txn, a);
        if (r.kind === "end") att.delete(r.txn);
      }
      for (const x of recPages(r)) if (!dpt.has(x.page)) dpt.set(x.page, r.lsn);
    }
    this.nextTxn = Math.max(this.nextTxn, maxTxn + 1);
    // ---- redo: repeat history
    this.ctx = "redo";
    this.tolerant = true;
    const redoFrom = dpt.size ? Math.min(...dpt.values()) : 0;
    rep.redoFrom = redoFrom;
    if (redoFrom) {
      for (let l = redoFrom; l <= this.lastLSN; l++) {
        const r = this.rec(l);
        for (const x of recPages(r)) {
          const recl = dpt.get(x.page);
          if (recl === undefined || l < recl) { rep.skipped++; continue; }
          const p = this.pg(x.page);
          const f = this.frameOf(x.page)!;
          if (!this.frameValid[f] && !rep.tornFound.includes(x.page) && this.synced.has(x.page)) rep.tornFound.push(x.page);
          if (x.image) {
            if (!this.frameValid[f] || p.lsn < l) {
              Object.assign(p, clonePage(x.image));
              p.lsn = l;
              this.frameValid[f] = true;
              this.markDirty(x.page, l);
              rep.imagesInstalled++;
              rep.redone++;
            } else rep.skipped++;
          } else if (this.frameValid[f] && p.lsn < l) {
            setCell(p, x.key!, x.chain ?? null);
            p.lsn = l;
            this.markDirty(x.page, l);
            rep.redone++;
          } else rep.skipped++;
        }
        this.endOp();
      }
    }
    for (const no of dpt.keys()) {
      const f = (this.pg(no), this.frameOf(no)!);
      const ok = this.frameValid[f];
      this.endOp();
      if (!ok) { this.dead = true; this.tolerant = false; throw new CorruptPageError(no, "torn or corrupt, and the log has no full image of it"); }
    }
    this.tolerant = false;
    const meta = this.pg(0);
    this.root = meta.root;
    this.endOp();
    // ---- undo losers (logical undo with CLRs)
    this.ctx = "undo";
    this.txns = new Map();
    this.ts = 1;
    this.needsRecovery = false;
    const losers: Txn[] = [];
    for (const [id, a] of att) {
      if (a.status === "committed") {
        rep.winners.push(id);
        this.append<EndRec>({ kind: "end", txn: id, prev: a.last });
        continue;
      }
      const t: Txn = { id, readOnly: false, status: "aborting", snap: 0, ts: 0, last: a.last, writes: new Map() };
      this.txns.set(id, t);
      losers.push(t);
      rep.losers.push(id);
    }
    const todo = new Map<number, Txn>();
    for (const t of losers) { const n = this.undoNext(t.last); if (n) todo.set(n, t); else this.finish(t); }
    while (todo.size) {
      const lsn = Math.max(...todo.keys());
      const t = todo.get(lsn)!;
      todo.delete(lsn);
      const r = this.rec(lsn) as CellRec;
      this.undoOne(t, r);
      rep.clrs++;
      const n = this.undoNext(r.prev);
      if (n) todo.set(n, t); else this.finish(t);
    }
    for (const t of losers) this.txns.delete(t.id);
    // ---- restart: make everything durable and take a checkpoint
    this.ctx = "restart";
    this.checkpoint();
    this.dead = false;
    this.lastRecovery = rep;
    return rep;
  }

  private alive() {
    if (this.needsRecovery) throw new Error("the engine crashed: call recover() first");
    if (this.dead) throw new Error("the engine is dead");
  }

  // ------------------------------------------------------------ inspection

  /** Every key and the value that a new snapshot sees (reads pages through the pool). */
  scanAll(): Map<string, string> {
    this.alive();
    this.ctx = "read";
    const out = new Map<string, string>();
    try {
      let no = this.root;
      for (;;) { const p = this.pg(no); if (p.kind !== "inner") break; no = p.kids[0]!; }
      let guard = 0;
      while (no >= 0 && guard++ < 100000) {
        const p = this.pg(no);
        p.keys.forEach((k, i) => { const v = this.visible(p.cells[i]!, null); if (v !== null) out.set(k, v); });
        this.endOp();
        no = p.next;
      }
    } finally { this.endOp(); }
    return out;
  }

  /** Reads a page without pinning it for long (for display): cached frame, else disk. */
  peek(no: number): PageImage | null {
    const f = this.bp.table.get(no);
    if (f !== undefined && this.frameImg[f]) return this.frameImg[f]!;
    return (this.cached.get(no) ?? this.synced.get(no))?.img ?? null;
  }

  /** Pages reachable from the root, by level (for display). */
  levels(): PageImage[][] {
    const out: PageImage[][] = [];
    let level = [this.root];
    for (let d = 0; d < 12 && level.length; d++) {
      const pages = level.map((n) => this.peek(n)).filter((p): p is PageImage => !!p);
      out.push(pages);
      level = pages.flatMap((p) => (p.kind === "inner" ? p.kids : []));
    }
    return out;
  }

  /** B+ tree invariants: sorted keys, separators bound their children, capacity, leaf chain order. */
  checkTree(): string[] {
    const errs: string[] = [];
    const walk = (no: number, lo: string | null, hi: string | null, depth: number, leafDepth: { d: number }) => {
      const p = this.peek(no);
      if (!p) { errs.push(`page ${no} is missing`); return; }
      for (let i = 1; i < p.keys.length; i++) if (!(p.keys[i - 1]! < p.keys[i]!)) errs.push(`page ${no}: keys out of order`);
      for (const k of p.keys) if ((lo !== null && k < lo) || (hi !== null && k >= hi)) errs.push(`page ${no}: key ${k} outside [${lo}, ${hi})`);
      if (p.kind === "leaf") {
        if (p.cells.length !== p.keys.length) errs.push(`page ${no}: ${p.keys.length} keys but ${p.cells.length} cells`);
        if (leafDepth.d < 0) leafDepth.d = depth; else if (leafDepth.d !== depth) errs.push(`page ${no}: leaf at depth ${depth}, others at ${leafDepth.d}`);
        return;
      }
      if (p.kind !== "inner") { errs.push(`page ${no}: unexpected ${p.kind} page in the tree`); return; }
      if (p.kids.length !== p.keys.length + 1) errs.push(`page ${no}: ${p.keys.length} separators but ${p.kids.length} children`);
      p.kids.forEach((c, i) => walk(c, i === 0 ? lo : p.keys[i - 1]!, i === p.keys.length ? hi : p.keys[i]!, depth + 1, leafDepth));
    };
    walk(this.root, null, null, 0, { d: -1 });
    return errs;
  }

  /** Disk pages whose pageLSN is past the durable log (the WAL rule is broken on disk). */
  walViolations(img: DurableImage): number[] {
    return [...img.pages.values()].filter((s) => s.img.lsn > img.log.length).map((s) => s.img.no);
  }

  /** Live transactions (for the transaction table). */
  liveTxns(): Txn[] { return [...this.txns.values()].filter((t) => t.status === "running" || t.status === "aborting"); }

  /** Frames of the buffer pool (for display). */
  frames(): { frame: number; page: number; dirty: boolean; pins: number; recLSN: number | null; lsn: number | null }[] {
    return this.bp.frames.map((f, i) => ({ frame: i, page: f.page, dirty: f.dirty, pins: f.pins, recLSN: f.page >= 0 ? this.recLSN.get(f.page) ?? null : null, lsn: f.page >= 0 ? this.frameImg[i]?.lsn ?? null : null }));
  }

  /** Counters of every layer (the pool's own counters included). */
  counters() {
    return { ...this.stats, poolHits: this.bp.stats.hits, poolMisses: this.bp.stats.misses, evictions: this.bp.stats.evictions, ioSeq: this.ioSeq };
  }
}

/** A crashed engine, ready for recover(). */
export const reopen = (img: DurableImage, rng?: Rng, cfg: Partial<KvConfig> = {}) => new TinyKv(cfg, img, rng);

/** The committed state after the first `j` commit attempts. */
export function oracleState(o: Oracle, j: number, base: Map<string, string> = new Map()): Map<string, string> {
  const s = new Map(base);
  for (let i = 0; i < j; i++) for (const [k, v] of o.attempts[i]!.writes) { if (v === null) s.delete(k); else s.set(k, v); }
  return s;
}

export const sameMap = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
