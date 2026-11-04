/**
 * ARIES restart recovery as a stepper: analysis, redo, undo.
 *
 *   const db = before.crash();
 *   const r = new Recovery(db);
 *   while (!r.done) r.step();     // or r.run()
 *
 * Each step handles one log record (or one undo action) and returns an event that a demo can show.
 * The recovery writes CLRs and end records through the same Db, so it is safe to crash again in
 * the middle (call db.crash() and start a new Recovery on the result).
 */
import { Db, isRedoable, isTxnRecord, type AttEntry, type Lsn, type PageId, type TxnId } from "./core";

export type Phase = "analysis" | "redo" | "undo" | "done";

export type RecoveryEventKind =
  | "start" // analysis begins (from a checkpoint or from the start of the log)
  | "ckpt" // tables loaded from end_ckpt
  | "scan" // analysis read a record
  | "redo" // redo applied a record to a page
  | "skip" // redo did not apply a record (and why)
  | "winner" // end record for a committed transaction
  | "clr" // undo wrote a CLR
  | "follow" // undo followed a CLR or abort record
  | "end" // undo finished a loser
  | "phase" // a phase ended
  | "done";

export interface RecoveryEvent {
  phase: Phase;
  kind: RecoveryEventKind;
  /** The log record this step looked at. */
  lsn?: Lsn;
  /** A record this step wrote (CLR or end). */
  wrote?: Lsn;
  page?: PageId;
  txn?: TxnId;
  text: string;
}

export interface RecoveryOptions {
  /** Take a checkpoint when recovery ends (real engines do). Default false. */
  checkpointAtEnd?: boolean;
}

export class Recovery {
  readonly db: Db;
  phase: Phase = "analysis";
  /** Transaction table rebuilt by analysis. */
  att = new Map<TxnId, AttEntry>();
  /** Dirty page table rebuilt by analysis: page -> recLSN. */
  dpt = new Map<PageId, Lsn>();
  /** First LSN that analysis reads. */
  readonly analysisStart: Lsn;
  /** First LSN that redo reads (min recLSN), set when analysis ends. 0 = nothing to redo. */
  redoLSN: Lsn = 0;
  /** Last LSN of the log when redo starts. */
  redoEnd: Lsn = 0;
  /** LSNs that undo still has to process (one per loser). */
  toUndo = new Set<Lsn>();
  /** Losers found by analysis. */
  losers: TxnId[] = [];
  /** Counters. */
  counts = { analysed: 0, redone: 0, skipped: 0, clrs: 0 };
  events: RecoveryEvent[] = [];
  private cursor: Lsn;
  private started = false;
  private opts: RecoveryOptions;

  constructor(db: Db, opts: RecoveryOptions = {}) {
    this.db = db;
    this.opts = opts;
    this.analysisStart = db.master || 1;
    this.cursor = this.analysisStart;
  }

  get done(): boolean { return this.phase === "done"; }

  /** Runs to the end and returns all events. */
  run(): RecoveryEvent[] {
    while (!this.done) this.step();
    return this.events;
  }

  /** Runs until the current phase ends. */
  finishPhase(): void {
    const p = this.phase;
    while (!this.done && this.phase === p) this.step();
  }

  step(): RecoveryEvent {
    const e = this.next();
    this.events.push(e);
    return e;
  }

  private next(): RecoveryEvent {
    const db = this.db;
    if (this.phase === "analysis") {
      if (!this.started) {
        this.started = true;
        if (db.master) {
          const end = db.log.find((r) => r.kind === "end_ckpt" && r.beginLSN === db.master);
          if (end && end.kind === "end_ckpt") {
            for (const a of end.att) this.att.set(a.txn, { ...a });
            for (const d of end.dpt) this.dpt.set(d.page, d.recLSN);
            this.cursor = db.master + 1;
            return { phase: "analysis", kind: "ckpt", lsn: end.lsn, text: `Master record points to begin_ckpt at LSN ${db.master}. Load ATT (${end.att.length}) and DPT (${end.dpt.length}) from end_ckpt at LSN ${end.lsn}.` };
          }
        }
        return { phase: "analysis", kind: "start", text: "No checkpoint. Analysis reads the log from LSN 1 with empty tables." };
      }
      if (this.cursor > db.lastLSN) return this.endAnalysis();
      const r = db.record(this.cursor++);
      this.counts.analysed++;
      if (isTxnRecord(r)) {
        let a = this.att.get(r.txn);
        if (!a) {
          a = { txn: r.txn, status: "running", lastLSN: r.lsn };
          this.att.set(r.txn, a);
        }
        a.lastLSN = r.lsn;
        if (r.kind === "commit") a.status = "committed";
        if (r.kind === "abort") a.status = "aborting";
        if (r.kind === "end") this.att.delete(r.txn);
        let text = `${r.kind} of T${r.txn}: `;
        if (r.kind === "end") text += `remove T${r.txn} from the ATT.`;
        else text += `T${r.txn} lastLSN = ${r.lsn}${r.kind === "commit" ? ", status committed" : r.kind === "abort" ? ", status aborting" : ""}.`;
        if (isRedoable(r) && !this.dpt.has(r.page)) {
          this.dpt.set(r.page, r.lsn);
          text += ` Page ${pageName(r.page)} enters the DPT with recLSN ${r.lsn}.`;
        }
        return { phase: "analysis", kind: "scan", lsn: r.lsn, txn: r.txn, page: isRedoable(r) ? r.page : undefined, text };
      }
      return { phase: "analysis", kind: "scan", lsn: r.lsn, text: r.kind === "end_ckpt" ? "end_ckpt: tables already loaded." : `${r.kind}: nothing to do.` };
    }

    if (this.phase === "redo") {
      if (this.redoLSN === 0 || this.cursor > this.redoEnd) return this.endRedo();
      const r = db.record(this.cursor++);
      if (!isRedoable(r)) return { phase: "redo", kind: "skip", lsn: r.lsn, text: `LSN ${r.lsn} (${r.kind}) changes no page.` };
      const rec = this.dpt.get(r.page);
      const P = pageName(r.page);
      if (rec === undefined) {
        this.counts.skipped++;
        return { phase: "redo", kind: "skip", lsn: r.lsn, page: r.page, text: `Page ${P} is not in the DPT, so its change is on disk. Skip.` };
      }
      if (r.lsn < rec) {
        this.counts.skipped++;
        return { phase: "redo", kind: "skip", lsn: r.lsn, page: r.page, text: `LSN ${r.lsn} < recLSN ${rec} of page ${P}: the change is on disk. Skip without reading the page.` };
      }
      const f = db.fetch(r.page);
      if (f.page.pageLSN >= r.lsn) {
        this.counts.skipped++;
        return { phase: "redo", kind: "skip", lsn: r.lsn, page: r.page, text: `pageLSN ${f.page.pageLSN} of page ${P} ≥ ${r.lsn}: the page already has this change. Skip.` };
      }
      db.applyToPage(r.page, r.slot, r.after, r.lsn);
      this.counts.redone++;
      return { phase: "redo", kind: "redo", lsn: r.lsn, page: r.page, txn: r.txn, text: `Redo LSN ${r.lsn}: page ${P} slot ${r.slot} = ${r.after}, pageLSN = ${r.lsn}.` };
    }

    if (this.phase === "undo") {
      if (this.toUndo.size === 0) return this.endUndo();
      const lsn = Math.max(...this.toUndo);
      this.toUndo.delete(lsn);
      const r = db.record(lsn);
      if (!isTxnRecord(r)) throw new Error("undo reached a non-transaction record");
      const a = db.att.get(r.txn)!;
      let nextLsn: Lsn;
      let ev: RecoveryEvent;
      if (r.kind === "update") {
        const clr = db.writeClr(a, r);
        this.counts.clrs++;
        nextLsn = r.prevLSN;
        ev = { phase: "undo", kind: "clr", lsn, wrote: clr.lsn, page: r.page, txn: r.txn, text: `Undo LSN ${lsn}: page ${pageName(r.page)} slot ${r.slot} = ${r.before}. Write CLR ${clr.lsn} with undoNextLSN ${r.prevLSN}.` };
      } else if (r.kind === "clr") {
        nextLsn = r.undoNextLSN;
        ev = { phase: "undo", kind: "follow", lsn, txn: r.txn, text: `LSN ${lsn} is a CLR: jump to its undoNextLSN ${r.undoNextLSN}. Work that is already undone is not undone again.` };
      } else {
        nextLsn = r.prevLSN;
        ev = { phase: "undo", kind: "follow", lsn, txn: r.txn, text: `LSN ${lsn} is ${r.kind}: follow prevLSN ${r.prevLSN}.` };
      }
      if (nextLsn === 0) {
        const end = db.writeEnd(a);
        ev = { ...ev, kind: ev.kind === "clr" ? "clr" : "end", text: `${ev.text} T${r.txn} is fully undone: write end at LSN ${end.lsn}.` };
      } else this.toUndo.add(nextLsn);
      return ev;
    }
    return { phase: "done", kind: "done", text: "Recovery is complete." };
  }

  private endAnalysis(): RecoveryEvent {
    const db = this.db;
    this.redoLSN = this.dpt.size ? Math.min(...this.dpt.values()) : 0;
    this.redoEnd = db.lastLSN;
    this.phase = "redo";
    this.cursor = this.redoLSN || 1;
    // The engine continues with the rebuilt transaction table.
    db.att = new Map([...this.att].map(([t, a]) => [t, { ...a }]));
    db.pool.clear();
    db.nextTxn = Math.max(db.nextTxn, ...[...this.att.keys()].map((t) => t + 1));
    this.losers = [...this.att.values()].filter((a) => a.status !== "committed").map((a) => a.txn);
    const winners = [...this.att.values()].filter((a) => a.status === "committed").map((a) => `T${a.txn}`);
    return {
      phase: "analysis", kind: "phase",
      text: `Analysis done. Losers: ${this.losers.map((t) => `T${t}`).join(", ") || "none"}. Committed without end: ${winners.join(", ") || "none"}. Redo starts at min recLSN = ${this.redoLSN || "none (DPT is empty)"}.`,
    };
  }

  private endRedo(): RecoveryEvent {
    const db = this.db;
    const winners: string[] = [];
    for (const a of [...db.att.values()]) {
      if (a.status === "committed") {
        db.writeEnd(a);
        winners.push(`T${a.txn}`);
      }
    }
    for (const a of db.att.values()) this.toUndo.add(a.lastLSN);
    this.phase = "undo";
    return { phase: "redo", kind: winners.length ? "winner" : "phase", text: `Redo done: the pages are as they were at the crash.${winners.length ? ` Write end records for ${winners.join(", ")}.` : ""} Undo starts with ${this.toUndo.size} loser(s).` };
  }

  private endUndo(): RecoveryEvent {
    this.db.flushLog();
    if (this.opts.checkpointAtEnd) this.db.checkpoint();
    this.phase = "done";
    return { phase: "undo", kind: "done", text: "Undo done. Every loser is rolled back. The database is open again." };
  }
}

/** Runs full recovery and returns the recovered Db (the same object as `db`). */
export function recover(db: Db, opts?: RecoveryOptions): Db {
  new Recovery(db, opts).run();
  return db;
}

/** Page names for display: 0 -> A, 1 -> B, ... */
export const pageName = (p: PageId): string => String.fromCharCode(65 + p);
