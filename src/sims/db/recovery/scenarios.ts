/**
 * Scripted histories for the recovery lessons. Each script is a list of named steps that run on
 * a Db. Demos replay a prefix of a script (for example "crash after step k") and tests pin the
 * outcomes that the lessons quote.
 */
import { Db, type Lsn } from "./core";
import { Recovery, pageName } from "./aries";

export interface ScriptStep { label: string; run: (db: Db, tx: Map<string, number>) => void }

const T = (tx: Map<string, number>, name: string, db: Db) => {
  let t = tx.get(name);
  if (t === undefined) {
    t = db.begin();
    tx.set(name, t);
  }
  return t;
};

/** Runs the first `k` steps of a script on a fresh Db. */
export function runScript(make: () => Db, steps: ScriptStep[], k: number): { db: Db; tx: Map<string, number> } {
  const db = make();
  const tx = new Map<string, number>();
  for (const s of steps.slice(0, k)) s.run(db, tx);
  return { db, tx };
}

// ---------------- Lesson 1: the WAL stepper (a transfer) ----------------

/** Pages A, B, C hold one balance each. */
export const transferDb = (enforceWal: boolean) => new Db({ nPages: 3, nSlots: 1, enforceWal, init: [[100], [50], [20]] });

/**
 * T1 moves 30 from A to B. T2 moves 10 from A to C. The total stays 170.
 * Commit forces the log only when the WAL rule is on (`db.enforceWal`).
 */
export const TRANSFER: ScriptStep[] = [
  { label: "T1: A = 100 − 30 = 70", run: (db, tx) => { db.update(T(tx, "T1", db), 0, 0, 70); } },
  { label: "T1: B = 50 + 30 = 80", run: (db, tx) => { db.update(T(tx, "T1", db), 1, 0, 80); } },
  { label: "T2: C = 20 + 10 = 30", run: (db, tx) => { db.update(T(tx, "T2", db), 2, 0, 30); } },
  { label: "T1 commits", run: (db, tx) => { db.commit(T(tx, "T1", db), { flush: db.enforceWal }); } },
  { label: "T2: A = 70 − 10 = 60", run: (db, tx) => { db.update(T(tx, "T2", db), 0, 0, 60); } },
  { label: "T2 commits", run: (db, tx) => { db.commit(T(tx, "T2", db), { flush: db.enforceWal }); } },
];

export type Problem = { page: string; expected: number; actual: number; why: string };

/** Crash, recover, and explain each slot that differs from the committed state. */
export function crashReport(db: Db): { recovered: Db; problems: Problem[]; violations: ReturnType<Db["walViolations"]>; lostTail: number } {
  const crashed = db.crash();
  const violations = crashed.walViolations();
  const lostTail = db.lastLSN - db.flushedLSN;
  new Recovery(crashed).run();
  const problems = crashed.diffFromAcked().map((d) => {
    const v = violations.some((x) => x.page === d.page);
    const why = v
      ? "The page reached disk before its log record. Recovery has no record to check or undo."
      : "The commit was reported, but its commit record was not durable. Recovery treats the transaction as a loser.";
    return { page: pageName(d.page), expected: d.expected, actual: d.actual, why };
  });
  return { recovered: crashed, problems, violations, lostTail };
}

// ---------------- Lesson 4: the ARIES history ----------------

export const ariesDb = () => new Db({ nPages: 4, nSlots: 1 });

/** Four transactions, a fuzzy checkpoint, steals, an abort and log flushes. */
export const ARIES: ScriptStep[] = [
  { label: "T1 writes A = 11", run: (db, tx) => { db.update(T(tx, "T1", db), 0, 0, 11); } },
  { label: "T2 writes B = 21", run: (db, tx) => { db.update(T(tx, "T2", db), 1, 0, 21); } },
  { label: "T1 writes C = 12", run: (db, tx) => { db.update(T(tx, "T1", db), 2, 0, 12); } },
  { label: "Buffer pool writes page A (steal)", run: (db) => { db.flushPage(0); } },
  { label: "begin_checkpoint", run: (db) => { db.beginCheckpoint(); } },
  { label: "T2 writes D = 22", run: (db, tx) => { db.update(T(tx, "T2", db), 3, 0, 22); } },
  { label: "end_checkpoint (forces the log)", run: (db) => { db.endCheckpoint(); } },
  { label: "T1 commits (forces the log)", run: (db, tx) => { db.commit(T(tx, "T1", db)); } },
  { label: "T3 writes A = 31", run: (db, tx) => { db.update(T(tx, "T3", db), 0, 0, 31); } },
  { label: "Buffer pool writes page D", run: (db) => { db.flushPage(3); } },
  { label: "T2 aborts and undoes D", run: (db, tx) => { db.abort(T(tx, "T2", db), 1); } },
  { label: "T3 writes C = 32", run: (db, tx) => { db.update(T(tx, "T3", db), 2, 0, 32); } },
  { label: "Log flush", run: (db) => { db.flushLog(); } },
  { label: "T2 undoes B and ends", run: (db, tx) => { db.rollback(T(tx, "T2", db)); } },
  { label: "T4 writes B = 41", run: (db, tx) => { db.update(T(tx, "T4", db), 1, 0, 41); } },
  { label: "T3 writes D = 33", run: (db, tx) => { db.update(T(tx, "T3", db), 3, 0, 33); } },
  { label: "T4 commits (forces the log)", run: (db, tx) => { db.commit(T(tx, "T4", db)); } },
  { label: "Buffer pool writes page C", run: (db) => { db.flushPage(2); } },
  { label: "Buffer pool writes page B", run: (db) => { db.flushPage(1); } },
];
/** The crash point that the ARIES lesson describes (after "Buffer pool writes page C"). */
export const ARIES_DEFAULT_CRASH = 18;

// ---------------- Lesson 4: crashes during undo, with and without CLRs ----------------

export interface ChainRecord { lsn: Lsn; kind: "update" | "clr" | "comp" | "end"; pass: number; undoes?: Lsn; prevLSN: Lsn; undoNextLSN?: Lsn }
export interface UndoChainResult { records: ChainRecord[]; undoActions: number; passes: number }

/**
 * One loser transaction with `n` updates, all on disk. Recovery crashes `crashes` times, each time
 * after it has done half (rounded up) of the undo work it planned. Then a last recovery finishes.
 * - "clr": real ARIES (the engine in ./core and ./aries). A CLR is never undone; undoNextLSN
 *   skips work already done, so the total undo work is n for any number of crashes.
 * - "naive": undo logs ordinary update records (with undo information). After a crash those
 *   records are part of the loser and are undone too, so the work grows with each crash.
 */
export function undoUnderCrashes(n: number, crashes: number, mode: "clr" | "naive"): UndoChainResult {
  if (mode === "clr") {
    let db = new Db({ nPages: n, nSlots: 1 });
    const t = db.begin();
    for (let p = 0; p < n; p++) db.update(t, p, 0, 10 + p);
    for (let p = 0; p < n; p++) db.flushPage(p);
    const passOf = new Map<Lsn, number>();
    let undo = 0;
    for (let pass = 1; pass <= crashes + 1; pass++) {
      db = db.crash();
      const r = new Recovery(db);
      r.finishPhase();
      r.finishPhase();
      const remaining = remainingUndo(db);
      const budget = pass <= crashes ? Math.ceil(remaining / 2) : Infinity;
      let done = 0;
      while (!r.done && done < budget) {
        const e = r.step();
        if (e.kind === "clr") done++;
        if (e.wrote) passOf.set(e.wrote, pass);
        if (e.kind === "clr" && e.text.includes("end at LSN")) passOf.set(db.lastLSN, pass);
      }
      undo += done;
      db.flushLog();
    }
    const records: ChainRecord[] = db.log.filter((x) => x.kind === "update" || x.kind === "clr" || x.kind === "end").map((x) => {
      if (x.kind === "clr") return { lsn: x.lsn, kind: "clr", pass: passOf.get(x.lsn) ?? 0, undoes: x.undoes, prevLSN: x.prevLSN, undoNextLSN: x.undoNextLSN };
      if (x.kind === "end") return { lsn: x.lsn, kind: "end", pass: passOf.get(x.lsn) ?? crashes + 1, prevLSN: x.prevLSN };
      return { lsn: x.lsn, kind: "update", pass: 0, prevLSN: (x as { prevLSN: Lsn }).prevLSN };
    });
    return { records, undoActions: undo, passes: crashes + 1 };
  }
  // Naive model: every record of the loser (originals and earlier compensations) needs undo.
  const records: ChainRecord[] = [];
  for (let i = 1; i <= n; i++) records.push({ lsn: i, kind: "update", pass: 0, prevLSN: i - 1 });
  let undo = 0;
  for (let pass = 1; pass <= crashes + 1; pass++) {
    const todo = records.filter((r) => r.kind !== "end").map((r) => r.lsn).reverse();
    const budget = pass <= crashes ? Math.ceil(todo.length / 2) : todo.length;
    for (const l of todo.slice(0, budget)) {
      const lsn = records.length + 1;
      records.push({ lsn, kind: "comp", pass, undoes: l, prevLSN: lsn - 1 });
      undo++;
    }
    if (pass > crashes) records.push({ lsn: records.length + 1, kind: "end", pass, prevLSN: records.length });
  }
  return { records, undoActions: undo, passes: crashes + 1 };
}

/** Number of update records that undo still has to undo for the losers in db.att. */
function remainingUndo(db: Db): number {
  let n = 0;
  for (const a of db.att.values()) {
    let l = db.undoNext(a.lastLSN);
    while (l !== 0) {
      n++;
      l = db.undoNext((db.record(l) as { prevLSN: Lsn }).prevLSN);
    }
  }
  return n;
}

// ---------------- Lesson 5: a fuzzy checkpoint ----------------

export const fuzzyDb = () => new Db({ nPages: 4, nSlots: 1 });

export const FUZZY: ScriptStep[] = [
  { label: "T1 writes A = 1", run: (db, tx) => { db.update(T(tx, "T1", db), 0, 0, 1); } },
  { label: "T2 writes B = 2", run: (db, tx) => { db.update(T(tx, "T2", db), 1, 0, 2); } },
  { label: "T1 writes C = 3", run: (db, tx) => { db.update(T(tx, "T1", db), 2, 0, 3); } },
  { label: "T1 commits", run: (db, tx) => { db.commit(T(tx, "T1", db)); } },
  { label: "Background writer writes page A", run: (db) => { db.flushPage(0); } },
  { label: "begin_checkpoint: snapshot the ATT and DPT", run: (db) => { db.beginCheckpoint(); } },
  { label: "T2 writes D = 4", run: (db, tx) => { db.update(T(tx, "T2", db), 3, 0, 4); } },
  { label: "Background writer writes page B", run: (db) => { db.flushPage(1); } },
  { label: "T3 writes A = 5", run: (db, tx) => { db.update(T(tx, "T3", db), 0, 0, 5); } },
  { label: "end_checkpoint: write the snapshot, force the log", run: (db) => { db.endCheckpoint(); } },
  { label: "T2 commits", run: (db, tx) => { db.commit(T(tx, "T2", db)); } },
  { label: "T3 writes C = 6", run: (db, tx) => { db.update(T(tx, "T3", db), 2, 0, 6); } },
  { label: "Background writer writes page C", run: (db) => { db.flushPage(2); } },
];

/** What a crash now would cost: where analysis and redo start, and how much log recovery reads. */
export function recoveryPlan(db: Db): { analysisFrom: Lsn; redoFrom: Lsn; logNeededFrom: Lsn; analysed: number; redone: number; skipped: number; clrs: number; ok: boolean } {
  const c = db.crash();
  const r = new Recovery(c);
  r.run();
  return {
    analysisFrom: r.analysisStart,
    redoFrom: r.redoLSN,
    logNeededFrom: Math.min(r.analysisStart, r.redoLSN || Infinity, ...[...r.events].filter((e) => e.kind === "clr").map((e) => e.lsn ?? Infinity)),
    analysed: r.counts.analysed,
    redone: r.counts.redone,
    skipped: r.counts.skipped,
    clrs: r.counts.clrs,
    ok: c.diffFromAcked().length === 0,
  };
}
