/**
 * Random workloads and crash torture for the WAL engine.
 * `tortureRun` is the property that the tests check many times: run random transactions with
 * random page and log flushes, crash at a random point, recover with more random crashes in the
 * middle of recovery, and compare the result with what clients were told is committed.
 */
import type { Rng } from "../../rng";
import { mulberry32 } from "../../rng";
import { Db, type TxnId } from "./core";
import { Recovery } from "./aries";

export interface WorkloadOptions {
  ops: number;
  maxLive?: number;
  /** Probability weights of each kind of step. */
  pFlushPage?: number;
  pFlushLog?: number;
  pCheckpoint?: number;
  pAbort?: number;
  /** Commit without forcing the log (asynchronous commit). */
  asyncCommit?: boolean;
}

/** One random step of normal work. Returns a short description. */
export function randomStep(db: Db, rng: Rng, o: WorkloadOptions): string {
  const live = db.liveTxns().filter((a) => a.status === "running");
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const r = rng();
  const pPage = o.pFlushPage ?? 0.12, pLog = o.pFlushLog ?? 0.06, pCk = o.pCheckpoint ?? 0.03, pAbort = o.pAbort ?? 0.06;
  if (r < pPage) {
    const dirty = db.dpt();
    if (dirty.length) {
      const p = pick(dirty).page;
      if (rng() < 0.5) db.flushPage(p); else db.evict(p);
      return `flush page ${p}`;
    }
  } else if (r < pPage + pLog) {
    db.flushLog(db.flushedLSN + 1 + Math.floor(rng() * (db.lastLSN - db.flushedLSN)));
    return "flush log";
  } else if (r < pPage + pLog + pCk) {
    if (db.pending) db.endCheckpoint(); else db.beginCheckpoint();
    return "checkpoint";
  } else if (r < pPage + pLog + pCk + pAbort && live.length) {
    const t = pick(live).txn;
    db.abort(t, rng() < 0.3 ? 1 : Infinity);
    return `abort T${t}`;
  }
  // Finish half-done rollbacks sometimes.
  const aborting = db.liveTxns().filter((a) => a.status === "aborting");
  if (aborting.length && rng() < 0.3) {
    db.rollback(pick(aborting).txn);
    return "rollback";
  }
  if (live.length < (o.maxLive ?? 3) && (live.length === 0 || rng() < 0.25)) {
    return `begin T${db.begin()}`;
  }
  if (!live.length) return "idle";
  const t: TxnId = pick(live).txn;
  if (rng() < 0.2) {
    db.commit(t, { flush: !o.asyncCommit });
    return `commit T${t}`;
  }
  for (let tries = 0; tries < 8; tries++) {
    const p = Math.floor(rng() * db.nPages), s = Math.floor(rng() * db.nSlots);
    if (db.canWrite(t, p, s)) {
      db.update(t, p, s, 1 + Math.floor(rng() * 99));
      return `T${t} writes ${p}.${s}`;
    }
  }
  return "blocked";
}

export interface TortureResult {
  /** Slots that differ from the acknowledged committed state after the final recovery. */
  diff: ReturnType<Db["diffFromAcked"]>;
  crashes: number;
  crashesDuringRecovery: number;
  /** Crashes that hit the undo phase (CLRs were being written). */
  crashesInUndo: number;
  /** Undo steps that jumped over work already undone, using a CLR's undoNextLSN. */
  clrJumps: number;
  clrs: number;
  logLength: number;
  live: number;
}

/**
 * One torture run: `epochs` rounds of (random work, crash, recovery with possible crashes
 * during recovery). Page and log flushes also happen at random between recovery steps.
 */
export function tortureRun(seed: number, o: { nPages?: number; nSlots?: number; ops?: number; epochs?: number; /** Chance of a crash in each recovery attempt (at most 3 in a row). */ pCrashInRecovery?: number; enforceWal?: boolean; asyncCommit?: boolean } = {}): TortureResult {
  const rng = mulberry32(seed);
  let db = new Db({ nPages: o.nPages ?? 4, nSlots: o.nSlots ?? 3, enforceWal: o.enforceWal ?? true });
  let crashes = 0, during = 0, clrs = 0, inUndo = 0, jumps = 0;
  for (let epoch = 0; epoch < (o.epochs ?? 2); epoch++) {
    const n = Math.floor(rng() * (o.ops ?? 60));
    for (let i = 0; i < n; i++) randomStep(db, rng, { ops: n, asyncCommit: o.asyncCommit });
    db = db.crash();
    crashes++;
    // Up to 3 more crashes during recovery, each at a random step (often during undo).
    for (let k = 0; ; k++) {
      const rec = new Recovery(db);
      const crashAt = k < 3 && rng() < (o.pCrashInRecovery ?? 0.6) ? Math.floor(rng() * 2.5 * (db.lastLSN + 2)) : -1;
      let crashed = false;
      for (let step = 0; !rec.done; step++) {
        rec.step();
        if (rec.done) break;
        const x = rng();
        if (x < 0.15) {
          const dirty = db.dpt();
          if (dirty.length) db.flushPage(dirty[Math.floor(rng() * dirty.length)]!.page);
        } else if (x < 0.25) db.flushLog(db.flushedLSN + Math.floor(rng() * (db.lastLSN - db.flushedLSN + 1)));
        if (step === crashAt) {
          crashed = true;
          break;
        }
      }
      clrs += rec.counts.clrs;
      jumps += rec.events.filter((e) => e.kind === "follow" && e.text.includes("CLR")).length;
      if (crashed && rec.phase === "undo") inUndo++;
      if (!crashed) break;
      db = db.crash();
      crashes++;
      during++;
    }
  }
  return { diff: db.diffFromAcked(), crashes, crashesDuringRecovery: during, crashesInUndo: inUndo, clrJumps: jumps, clrs, logLength: db.lastLSN, live: db.att.size };
}
