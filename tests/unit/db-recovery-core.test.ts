/** The WAL engine and ARIES recovery: unit tests and the crash property test. */
import { describe, expect, test } from "vitest";
import { Db } from "@/sims/db/recovery/core";
import { Recovery, recover } from "@/sims/db/recovery/aries";
import { tortureRun } from "@/sims/db/recovery/workload";

describe("WAL engine basics", () => {
  test("LSNs are 1, 2, 3 and prevLSN chains each transaction", () => {
    const db = new Db({ nPages: 2, nSlots: 2 });
    const t1 = db.begin(), t2 = db.begin();
    const a = db.update(t1, 0, 0, 5);
    const b = db.update(t2, 1, 0, 6);
    const c = db.update(t1, 1, 1, 7);
    expect([a.lsn, b.lsn, c.lsn]).toEqual([1, 2, 3]);
    expect([a.prevLSN, b.prevLSN, c.prevLSN]).toEqual([0, 0, 1]);
    expect(db.dpt()).toEqual([{ page: 0, recLSN: 1 }, { page: 1, recLSN: 2 }]);
  });
  test("with the WAL rule, flushing a page first flushes the log up to its pageLSN", () => {
    const db = new Db({ nPages: 2, nSlots: 1 });
    const t = db.begin();
    db.update(t, 0, 0, 5);
    db.update(t, 1, 0, 6);
    expect(db.flushPage(0)).toBe(false);
    expect(db.flushedLSN).toBe(1);
    expect(db.walViolations()).toEqual([]);
  });
  test("without the WAL rule, a stolen page survives a crash with no log record to undo it", () => {
    const db = new Db({ nPages: 1, nSlots: 1, enforceWal: false });
    const t = db.begin();
    db.update(t, 0, 0, 5);
    expect(db.flushPage(0)).toBe(true);
    const after = recover(db.crash());
    expect(after.diffFromAcked()).toEqual([{ page: 0, slot: 0, expected: 0, actual: 5 }]);
  });
  test("a commit that does not force the log is lost in a crash", () => {
    const db = new Db({ nPages: 1, nSlots: 1 });
    const t = db.begin();
    db.update(t, 0, 0, 5);
    db.commit(t, { flush: false });
    expect(recover(db.crash()).diffFromAcked()).toEqual([{ page: 0, slot: 0, expected: 5, actual: 0 }]);
  });
  test("abort writes CLRs with undoNextLSN and an end record", () => {
    const db = new Db({ nPages: 1, nSlots: 2 });
    const t = db.begin();
    db.update(t, 0, 0, 5);
    db.update(t, 0, 1, 6);
    db.abort(t);
    expect(db.log.map((r) => r.kind)).toEqual(["update", "update", "abort", "clr", "clr", "end"]);
    const clr = db.log[3]!;
    expect(clr.kind === "clr" && clr.undoNextLSN).toBe(1);
    expect(db.state()).toEqual([[0, 0]]);
  });
});

describe("ARIES recovery", () => {
  test("redo repeats history, then undo rolls back losers", () => {
    const db = new Db({ nPages: 3, nSlots: 1 });
    const t1 = db.begin(), t2 = db.begin();
    db.update(t1, 0, 0, 11);
    db.update(t2, 1, 0, 21);
    db.flushPage(1); // steal: T2's uncommitted value is on disk
    db.commit(t1);
    db.update(t2, 2, 0, 22);
    db.flushLog();
    const r = new Recovery(db.crash());
    r.run();
    expect(r.losers).toEqual([t2]);
    expect(r.counts.clrs).toBe(2);
    expect(r.db.state()).toEqual([[11], [0], [0]]);
    expect(r.db.diffFromAcked()).toEqual([]);
  });
  test("recovery is idempotent: a crash during undo, then recovery again, gives the same state", () => {
    const db = new Db({ nPages: 3, nSlots: 1 });
    const t1 = db.begin();
    db.update(t1, 0, 0, 1);
    db.update(t1, 1, 0, 2);
    db.update(t1, 2, 0, 3);
    db.flushPage(0); db.flushPage(1); db.flushPage(2);
    const d1 = db.crash();
    const r1 = new Recovery(d1);
    r1.finishPhase(); r1.finishPhase();
    r1.step(); // one CLR
    d1.flushLog(); d1.flushPage(2);
    const d2 = d1.crash();
    const r2 = new Recovery(d2);
    r2.run();
    expect(r2.counts.clrs).toBe(2); // the CLR from the first attempt is not undone again
    expect(d2.state()).toEqual([[0], [0], [0]]);
  });
});

describe("property: recovery after random crashes gives exactly the committed state", () => {
  test("1000 random histories with crashes during recovery", () => {
    let during = 0, clrs = 0, inUndo = 0, jumps = 0;
    for (let seed = 1; seed <= 1000; seed++) {
      const r = tortureRun(seed, { epochs: 3 });
      expect(r.diff, `seed ${seed}`).toEqual([]);
      expect(r.live).toBe(0);
      during += r.crashesDuringRecovery;
      clrs += r.clrs;
      inUndo += r.crashesInUndo;
      jumps += r.clrJumps;
    }
    // The run really exercises crashes during recovery, during undo, and CLR jumps.
    expect(during).toBeGreaterThan(500);
    expect(inUndo).toBeGreaterThan(100);
    expect(jumps).toBeGreaterThan(50);
    expect(clrs).toBeGreaterThan(1000);
  });
  test("breaking the WAL rule or committing asynchronously breaks the property", () => {
    let badWal = 0, badAsync = 0;
    for (let seed = 1; seed <= 200; seed++) {
      if (tortureRun(seed, { enforceWal: false, pCrashInRecovery: 0 }).diff.length) badWal++;
      if (tortureRun(seed, { asyncCommit: true, pCrashInRecovery: 0 }).diff.length) badAsync++;
    }
    expect(badWal).toBeGreaterThan(10);
    expect(badAsync).toBeGreaterThan(10);
  });
});
