/**
 * A small, complete write-ahead-logging storage engine: pages, a buffer pool,
 * a log with LSNs, transactions with strict locks, fuzzy checkpoints and crashes.
 *
 * Model
 * - The database is `nPages` pages. Each page holds `nSlots` integer slots and a pageLSN.
 * - `disk` is the durable copy of each page. `pool` holds cached frames; a frame is dirty
 *   when it has changes that are not on disk yet (STEAL and NO-FORCE: any dirty page can be
 *   written at any time, and commit does not write pages).
 * - `log` is the whole log. Records with lsn <= `flushedLSN` are durable; a crash drops the rest.
 * - LSNs are 1, 2, 3, ... (the index in the log plus 1). 0 means "none". Real engines use byte
 *   offsets (PostgreSQL, InnoDB); only the order matters for recovery.
 * - Each transaction takes an exclusive lock on every slot it writes and keeps it until it ends
 *   (strict two-phase locking), so two live transactions never write the same slot.
 * - `acked` is the oracle: the state that clients were told is committed. Recovery is correct
 *   when the recovered state equals `acked`.
 *
 * Recovery itself (ARIES analysis, redo, undo) is in ./aries.ts.
 */

export type Lsn = number;
export type TxnId = number;
export type PageId = number;

interface Base { lsn: Lsn }
interface TxnRec extends Base { txn: TxnId; prevLSN: Lsn }
/** A change to one slot. `before` is the undo information, `after` is the redo information. */
export interface UpdateRec extends TxnRec { kind: "update"; page: PageId; slot: number; before: number; after: number }
/**
 * Compensation log record: the redo-only record of one undo action. `undoNextLSN` is the next
 * record of this transaction that still needs undo (the prevLSN of the record it undid).
 */
export interface ClrRec extends TxnRec { kind: "clr"; page: PageId; slot: number; after: number; undoNextLSN: Lsn; undoes: Lsn }
export interface CommitRec extends TxnRec { kind: "commit" }
export interface AbortRec extends TxnRec { kind: "abort" }
export interface EndRec extends TxnRec { kind: "end" }
export interface BeginCkptRec extends Base { kind: "begin_ckpt" }
/** Fuzzy checkpoint end: the transaction table and dirty page table as they were at begin_ckpt. */
export interface EndCkptRec extends Base { kind: "end_ckpt"; beginLSN: Lsn; att: AttEntry[]; dpt: DptEntry[] }
export type LogRecord = UpdateRec | ClrRec | CommitRec | AbortRec | EndRec | BeginCkptRec | EndCkptRec;
export type TxnRecord = UpdateRec | ClrRec | CommitRec | AbortRec | EndRec;

export type TxnStatus = "running" | "committed" | "aborting";
/** One row of the active transaction table (ATT). */
export interface AttEntry { txn: TxnId; status: TxnStatus; lastLSN: Lsn }
/** One row of the dirty page table (DPT). recLSN = the first record that dirtied the cached page. */
export interface DptEntry { page: PageId; recLSN: Lsn }

export interface Page { id: PageId; pageLSN: Lsn; slots: number[] }
export interface Frame { page: Page; dirty: boolean; recLSN: Lsn }

export interface DbOptions {
  nPages: number;
  nSlots: number;
  /** Flush the log up to pageLSN before a page is written (the WAL rule). Default true. */
  enforceWal?: boolean;
  /** Initial committed values, [page][slot]. Default all 0. */
  init?: number[][];
}

export const isTxnRecord = (r: LogRecord): r is TxnRecord => "txn" in r;
export const isRedoable = (r: LogRecord): r is UpdateRec | ClrRec => r.kind === "update" || r.kind === "clr";

/** Bytes of one record in a simple binary encoding: a 24-byte header (as in PostgreSQL) plus the body. */
export function recordBytes(r: LogRecord): number {
  const HEADER = 24;
  switch (r.kind) {
    case "update": return HEADER + 4 + 2 + 8 + 8; // page, slot, before, after
    case "clr": return HEADER + 4 + 2 + 8 + 8; // page, slot, after, undoNextLSN
    case "end_ckpt": return HEADER + 8 + r.att.length * 17 + r.dpt.length * 12;
    default: return HEADER;
  }
}

const clonePage = (p: Page): Page => ({ id: p.id, pageLSN: p.pageLSN, slots: p.slots.slice() });

export class Db {
  readonly nPages: number;
  readonly nSlots: number;
  enforceWal: boolean;
  /** The whole log; log[i].lsn === i + 1. */
  log: LogRecord[] = [];
  flushedLSN: Lsn = 0;
  /** Durable pages. */
  disk: Page[];
  /** Cached frames. */
  pool = new Map<PageId, Frame>();
  /** Active transaction table. */
  att = new Map<TxnId, AttEntry>();
  /** LSN of the begin_ckpt record of the last complete checkpoint (the "master record"). Durable. */
  master: Lsn = 0;
  /** The snapshot taken at begin_ckpt, waiting for endCheckpoint(). */
  pending: { beginLSN: Lsn; att: AttEntry[]; dpt: DptEntry[] } | null = null;
  /** The oracle: values that clients were told are committed. Survives crashes. */
  acked: number[][];
  /** Slot lock owner, key = page * nSlots + slot. */
  locks = new Map<number, TxnId>();
  /** First LSN of each live transaction (for log truncation). */
  firstLSN = new Map<TxnId, Lsn>();
  private writes = new Map<TxnId, { page: PageId; slot: number; after: number }[]>();
  nextTxn = 1;
  /** Counters for cost readouts. */
  stats = { pageWrites: 0, logFlushes: 0, walViolations: 0 };

  constructor(o: DbOptions) {
    this.nPages = o.nPages;
    this.nSlots = o.nSlots;
    this.enforceWal = o.enforceWal ?? true;
    const v = (p: number, s: number) => o.init?.[p]?.[s] ?? 0;
    this.disk = Array.from({ length: o.nPages }, (_, id) => ({ id, pageLSN: 0, slots: Array.from({ length: o.nSlots }, (_, s) => v(id, s)) }));
    this.acked = Array.from({ length: o.nPages }, (_, p) => Array.from({ length: o.nSlots }, (_, s) => v(p, s)));
  }

  get lastLSN(): Lsn { return this.log.length; }
  record(lsn: Lsn): LogRecord {
    const r = this.log[lsn - 1];
    if (!r) throw new Error(`no record at LSN ${lsn}`);
    return r;
  }

  /** Appends a record (the caller gives everything except the LSN) and returns it. */
  append<R extends LogRecord>(r: Omit<R, "lsn">): R {
    const rec = { ...r, lsn: this.log.length + 1 } as R;
    this.log.push(rec);
    return rec;
  }

  /** Makes the log durable up to `upTo` (default: all of it). */
  flushLog(upTo: Lsn = this.lastLSN): void {
    const to = Math.min(upTo, this.lastLSN);
    if (to > this.flushedLSN) {
      this.flushedLSN = to;
      this.stats.logFlushes++;
    }
  }

  /** Returns the cached frame of a page, reading it from disk on a miss. */
  fetch(page: PageId): Frame {
    let f = this.pool.get(page);
    if (!f) {
      const d = this.disk[page];
      if (!d) throw new Error(`no page ${page}`);
      f = { page: clonePage(d), dirty: false, recLSN: 0 };
      this.pool.set(page, f);
    }
    return f;
  }

  /** Applies a value to a cached page and stamps it with `lsn`. Used by normal work, undo and redo. */
  applyToPage(page: PageId, slot: number, value: number, lsn: Lsn): void {
    const f = this.fetch(page);
    f.page.slots[slot] = value;
    f.page.pageLSN = lsn;
    if (!f.dirty) {
      f.dirty = true;
      f.recLSN = lsn;
    }
  }

  /**
   * Writes a cached page to disk. With the WAL rule on, the log is flushed up to pageLSN first.
   * Returns true when the write broke the WAL rule (page on disk is newer than the durable log).
   */
  flushPage(page: PageId): boolean {
    const f = this.pool.get(page);
    if (!f || !f.dirty) return false;
    if (this.enforceWal) this.flushLog(f.page.pageLSN);
    const broke = f.page.pageLSN > this.flushedLSN;
    if (broke) this.stats.walViolations++;
    this.disk[page] = clonePage(f.page);
    f.dirty = false;
    f.recLSN = 0;
    this.stats.pageWrites++;
    return broke;
  }

  /** Writes the page if dirty and drops it from the pool. */
  evict(page: PageId): void {
    this.flushPage(page);
    this.pool.delete(page);
  }

  begin(): TxnId {
    const t = this.nextTxn++;
    this.att.set(t, { txn: t, status: "running", lastLSN: 0 });
    this.writes.set(t, []);
    return t;
  }

  /** True when `txn` may write the slot (no other live transaction holds its lock). */
  canWrite(txn: TxnId, page: PageId, slot: number): boolean {
    const o = this.locks.get(page * this.nSlots + slot);
    return o === undefined || o === txn;
  }

  update(txn: TxnId, page: PageId, slot: number, value: number): UpdateRec {
    const e = this.live(txn);
    if (e.status !== "running") throw new Error(`T${txn} is ${e.status}`);
    if (!this.canWrite(txn, page, slot)) throw new Error(`slot ${page}.${slot} is locked`);
    this.locks.set(page * this.nSlots + slot, txn);
    const f = this.fetch(page);
    const rec = this.append<UpdateRec>({ kind: "update", txn, prevLSN: e.lastLSN, page, slot, before: f.page.slots[slot]!, after: value });
    this.applyToPage(page, slot, value, rec.lsn);
    this.touch(e, rec.lsn);
    this.writes.get(txn)!.push({ page, slot, after: value });
    return rec;
  }

  /**
   * Commits. With `flush` (the default) the log is forced up to the commit record before the
   * call returns, so the commit is durable. The client is told "committed" either way: with
   * flush = false that promise can be broken by a crash (asynchronous commit).
   */
  commit(txn: TxnId, { flush = true }: { flush?: boolean } = {}): CommitRec {
    const e = this.live(txn);
    const rec = this.append<CommitRec>({ kind: "commit", txn, prevLSN: e.lastLSN });
    this.touch(e, rec.lsn);
    e.status = "committed";
    if (flush) this.flushLog(rec.lsn);
    for (const w of this.writes.get(txn)!) this.acked[w.page]![w.slot] = w.after;
    this.finish(txn);
    return rec;
  }

  /**
   * Aborts: writes an abort record, then rolls back with CLRs. `steps` limits how many records
   * are undone now (to leave a rollback half done before a crash); default all.
   */
  abort(txn: TxnId, steps = Infinity): void {
    const e = this.live(txn);
    if (e.status === "running") {
      const rec = this.append<AbortRec>({ kind: "abort", txn, prevLSN: e.lastLSN });
      this.touch(e, rec.lsn);
      e.status = "aborting";
    }
    this.rollback(txn, steps);
  }

  /** Continues the rollback of an aborting transaction. Returns true when it is finished. */
  rollback(txn: TxnId, steps = Infinity): boolean {
    const e = this.live(txn);
    let next = this.undoNext(e.lastLSN);
    for (let n = 0; n < steps && next !== 0; n++) {
      const r = this.record(next);
      if (r.kind !== "update") throw new Error("undoNext must point at an update");
      this.writeClr(e, r);
      next = this.undoNext(r.prevLSN);
    }
    if (next !== 0) return false;
    this.finish(txn);
    return true;
  }

  /** The next record that still needs undo, starting from the record `lsn` (follows CLRs). */
  undoNext(lsn: Lsn): Lsn {
    let l = lsn;
    while (l !== 0) {
      const r = this.record(l);
      if (r.kind === "update") return l;
      if (r.kind === "clr") l = r.undoNextLSN;
      else if (isTxnRecord(r)) l = r.prevLSN;
      else return 0;
    }
    return 0;
  }

  /** Undoes one update: writes its CLR and restores the before value. Also used by recovery. */
  writeClr(e: AttEntry, r: UpdateRec): ClrRec {
    const clr = this.append<ClrRec>({ kind: "clr", txn: r.txn, prevLSN: e.lastLSN, page: r.page, slot: r.slot, after: r.before, undoNextLSN: r.prevLSN, undoes: r.lsn });
    this.applyToPage(r.page, r.slot, r.before, clr.lsn);
    this.touch(e, clr.lsn);
    return clr;
  }

  /** Writes the end record and forgets the transaction. */
  writeEnd(e: AttEntry): EndRec {
    const rec = this.append<EndRec>({ kind: "end", txn: e.txn, prevLSN: e.lastLSN });
    this.att.delete(e.txn);
    this.firstLSN.delete(e.txn);
    return rec;
  }

  /** The dirty page table as it is now. */
  dpt(): DptEntry[] {
    return [...this.pool.values()].filter((f) => f.dirty).map((f) => ({ page: f.page.id, recLSN: f.recLSN })).sort((a, b) => a.page - b.page);
  }

  /** Starts a fuzzy checkpoint: writes begin_ckpt and snapshots the ATT and DPT. Work continues. */
  beginCheckpoint(): Lsn {
    const rec = this.append<BeginCkptRec>({ kind: "begin_ckpt" });
    this.pending = { beginLSN: rec.lsn, att: [...this.att.values()].filter((e) => e.lastLSN > 0).map((e) => ({ ...e })), dpt: this.dpt() };
    return rec.lsn;
  }

  /** Ends the checkpoint: writes end_ckpt with the snapshot, forces the log, updates the master record. */
  endCheckpoint(): Lsn {
    const p = this.pending;
    if (!p) throw new Error("no checkpoint in progress");
    const rec = this.append<EndCkptRec>({ kind: "end_ckpt", beginLSN: p.beginLSN, att: p.att, dpt: p.dpt });
    this.flushLog(rec.lsn);
    this.master = p.beginLSN;
    this.pending = null;
    return rec.lsn;
  }

  checkpoint(): Lsn {
    this.beginCheckpoint();
    return this.endCheckpoint();
  }

  /**
   * The oldest LSN that recovery can still need: the smaller of the oldest recLSN (redo) and
   * the first LSN of the oldest live transaction (undo). The log before it can be recycled.
   */
  truncationPoint(): Lsn {
    let m = this.lastLSN + 1;
    for (const d of this.dpt()) m = Math.min(m, d.recLSN);
    for (const l of this.firstLSN.values()) m = Math.min(m, l);
    return m;
  }

  /**
   * Power loss. Returns the database as it is after a restart, before recovery: the durable
   * pages, the durable prefix of the log, the master record and the oracle. Everything in
   * memory (pool, ATT, locks, the unflushed log tail) is gone.
   */
  crash(): Db {
    const d = new Db({ nPages: this.nPages, nSlots: this.nSlots, enforceWal: this.enforceWal });
    d.disk = this.disk.map(clonePage);
    d.log = this.log.slice(0, this.flushedLSN);
    d.flushedLSN = this.flushedLSN;
    d.master = this.master;
    d.acked = this.acked.map((r) => r.slice());
    d.nextTxn = this.nextTxn;
    d.stats = { ...this.stats };
    return d;
  }

  /** The value a reader sees now (cached page if present, else disk). */
  read(page: PageId, slot: number): number {
    return (this.pool.get(page)?.page ?? this.disk[page]!).slots[slot]!;
  }

  /** The whole current state, [page][slot]. */
  state(): number[][] {
    return Array.from({ length: this.nPages }, (_, p) => Array.from({ length: this.nSlots }, (_, s) => this.read(p, s)));
  }

  /** Slots where the current state differs from what clients were told is committed. */
  diffFromAcked(): { page: PageId; slot: number; expected: number; actual: number }[] {
    const out: { page: PageId; slot: number; expected: number; actual: number }[] = [];
    for (let p = 0; p < this.nPages; p++)
      for (let s = 0; s < this.nSlots; s++) {
        const a = this.read(p, s), e = this.acked[p]![s]!;
        if (a !== e) out.push({ page: p, slot: s, expected: e, actual: a });
      }
    return out;
  }

  /** Disk pages whose pageLSN is newer than the durable log: the WAL rule is broken for them. */
  walViolations(): { page: PageId; pageLSN: Lsn; flushedLSN: Lsn }[] {
    return this.disk.filter((p) => p.pageLSN > this.flushedLSN).map((p) => ({ page: p.id, pageLSN: p.pageLSN, flushedLSN: this.flushedLSN }));
  }

  /** Live transactions (for workload generators). */
  liveTxns(): AttEntry[] { return [...this.att.values()]; }

  private live(txn: TxnId): AttEntry {
    const e = this.att.get(txn);
    if (!e) throw new Error(`T${txn} is not live`);
    return e;
  }

  private touch(e: AttEntry, lsn: Lsn) {
    if (e.lastLSN === 0) this.firstLSN.set(e.txn, lsn);
    e.lastLSN = lsn;
  }

  private finish(txn: TxnId) {
    const e = this.live(txn);
    for (const [k, o] of this.locks) if (o === txn) this.locks.delete(k);
    this.writes.delete(txn);
    if (e.lastLSN === 0) {
      this.att.delete(txn);
      this.firstLSN.delete(txn);
    } else this.writeEnd(e);
  }
}
