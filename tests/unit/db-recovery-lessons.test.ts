/** Every number that the recovery lessons quote, computed by src/sims/db/recovery. */
import { describe, expect, test } from "vitest";
import {
  ARIES, ARIES_DEFAULT_CRASH, ariesDb, runScript, Recovery, TRANSFER, transferDb, crashReport, FUZZY, fuzzyDb, recoveryPlan, undoUnderCrashes,
  policyCost, DEFAULT_WORKLOAD, gcSteady, rotationMs, DEVICES, pgAsyncRiskWindowMs, pgLsnText, pgWalPlace, PG_WAL_SEGMENT, PG_WAL_PAGE,
} from "@/sims/db/recovery";
import * as LF from "@/sims/db/recovery/logforms";
import { simulateCheckpoints, CKPT_DEFAULTS } from "@/sims/db/recovery/checkpointsim";

const total = (s: number[][]) => s.reduce((a, r) => a + r[0]!, 0);

describe("write-ahead-logging", () => {
  const run = (rule: boolean, script: (string | number)[]) => {
    const db = transferDb(rule);
    const tx = new Map<string, number>();
    let k = 0;
    for (const a of script) {
      if (a === "next") TRANSFER[k++]!.run(db, tx);
      else if (typeof a === "number") db.flushPage(a);
    }
    return { db, rep: crashReport(db) };
  };
  test("following the rule: steal of A forces the log to LSN 1, and recovery undoes A to 100", () => {
    const { db, rep } = run(true, ["next", "next", "next", 0]);
    expect(db.flushedLSN).toBe(1);
    expect(rep.problems).toEqual([]);
    expect(rep.recovered.state()).toEqual([[100], [50], [20]]);
  });
  test("following the rule: all six steps with no page writes recover to a total of 170", () => {
    const { rep } = run(true, ["next", "next", "next", "next", "next", "next"]);
    expect(rep.problems).toEqual([]);
    expect(rep.recovered.state()).toEqual([[60], [80], [30]]);
    expect(total(rep.recovered.state())).toBe(170);
  });
  test("breaking the rule: write A, T1 commits without a flush, crash -> total 140", () => {
    const { db, rep } = run(false, ["next", "next", "next", 0, "next"]);
    expect(total(db.acked)).toBe(170);
    expect(total(rep.recovered.state())).toBe(140);
    expect(rep.problems.map((p) => p.page)).toEqual(["B"]);
  });
  test("breaking the rule: write C of uncommitted T2 -> C keeps 30 with no record to undo it", () => {
    const { rep } = run(false, ["next", "next", "next", 2]);
    expect(rep.violations.map((v) => v.page)).toEqual([2]);
    expect(rep.problems).toEqual([expect.objectContaining({ page: "C", expected: 20, actual: 30 })]);
  });
  test("policy matrix: 4,000 vs about 982 page writes per 1000 commits; 224 vs 124 log bytes", () => {
    const sf = policyCost("steal", "force", DEFAULT_WORKLOAD), snf = policyCost("steal", "no-force", DEFAULT_WORKLOAD);
    expect(sf.pageWritesPer1000).toBe(4000);
    expect(Math.round(snf.pageWritesPer1000)).toBe(982);
    expect(snf.logBytesPerUpdate).toBe(224);
    expect(sf.logBytesPerUpdate).toBe(124);
    expect(policyCost("no-steal", "no-force", { ...DEFAULT_WORKLOAD, pagesPerTxn: 1001 }).fits).toBe(false);
    expect(policyCost("no-steal", "no-force", { ...DEFAULT_WORKLOAD, pagesPerTxn: 1000 }).fits).toBe(true);
  });
  test("PostgreSQL LSN 0/3000060 is at offset 96 of segment file ...03; 2,048 WAL pages per segment", () => {
    const lsn = 48 * 1024 * 1024 + 96;
    expect(pgLsnText(lsn)).toBe("0/3000060");
    expect(pgWalPlace(lsn)).toMatchObject({ file: "000000010000000000000003", offsetInSegment: 96 });
    expect(PG_WAL_SEGMENT / PG_WAL_PAGE).toBe(2048);
    const big = 5 * 2 ** 32 + 7;
    expect(pgLsnText(big)).toBe("5/7");
    expect(pgWalPlace(big).file).toBe("000000010000000500000000");
  });
});

describe("group-commit", () => {
  const hdd = rotationMs(7200);
  test("a 7,200 rpm rotation is 8.33 ms, so at most 120 flushes per second", () => {
    expect(hdd).toBeCloseTo(8.333, 3);
    expect(Math.round(1000 / hdd)).toBe(120);
    expect(DEVICES.hdd.fsyncMs).toBe(hdd);
    expect(1000 / DEVICES.ssd.fsyncMs).toBe(1000);
    expect(1000 / DEVICES.plp.fsyncMs).toBe(20000);
  });
  test("fsync per commit: 117/s with 1 client, 120/s with 32, latency 66.5 ms at 8 and 266 ms at 32", () => {
    expect(Math.round(gcSteady({ clients: 1, fsyncMs: hdd, mode: "per-commit" }).throughput)).toBe(117);
    const c32 = gcSteady({ clients: 32, fsyncMs: hdd, mode: "per-commit" });
    expect(Math.round(c32.throughput)).toBe(120);
    expect(Math.round(c32.meanLatencyMs)).toBe(266);
    expect(gcSteady({ clients: 8, fsyncMs: hdd, mode: "per-commit" }).meanLatencyMs.toFixed(1)).toBe("66.5");
  });
  test("group commit, 8 clients: 480/s with 4 per flush; 1 ms commit_delay: 846/s, 8 per flush, 16.5 -> 9.3 ms", () => {
    const g = gcSteady({ clients: 8, fsyncMs: hdd, mode: "group" });
    expect(Math.round(g.throughput)).toBe(480);
    expect(g.meanBatch).toBe(4);
    expect(g.meanLatencyMs.toFixed(1)).toBe("16.5");
    const d = gcSteady({ clients: 8, fsyncMs: hdd, mode: "group", commitDelayMs: 1 });
    expect(Math.round(d.throughput)).toBe(846);
    expect(d.meanBatch).toBe(8);
    expect(d.meanLatencyMs.toFixed(1)).toBe("9.3");
  });
  test("group commit, 32 clients: 1,920/s and 16 per flush (N / 2F); with 1 ms delay 3,384/s at 9.0 ms", () => {
    const g = gcSteady({ clients: 32, fsyncMs: hdd, mode: "group" });
    expect(Math.round(g.throughput)).toBe(1920);
    expect(Math.round(32 / (2 * hdd / 1000))).toBe(1920);
    expect(g.meanBatch).toBe(16);
    const d = gcSteady({ clients: 32, fsyncMs: hdd, mode: "group", commitDelayMs: 1 });
    expect(Math.round(d.throughput)).toBe(3384);
    expect(d.meanLatencyMs.toFixed(1)).toBe("9.0");
  });
  test("commit_delay does nothing at 2 and 4 clients (commit_siblings = 5), and almost doubles from 8 up", () => {
    for (const n of [2, 4]) expect(gcSteady({ clients: n, fsyncMs: hdd, mode: "group", commitDelayMs: 1 }).throughput).toBe(gcSteady({ clients: n, fsyncMs: hdd, mode: "group" }).throughput);
    for (const n of [8, 16, 32]) {
      const r = gcSteady({ clients: n, fsyncMs: hdd, mode: "group", commitDelayMs: 1 }).throughput / gcSteady({ clients: n, fsyncMs: hdd, mode: "group" }).throughput;
      expect(r).toBeGreaterThan(1.7);
      expect(r).toBeLessThan(2);
    }
  });
  test("async commit and SSD with PLP reach the CPU limit of 40,000/s; about 8,000 commits at risk", () => {
    expect(8 / 0.0002).toBe(40000);
    const a = gcSteady({ clients: 8, fsyncMs: hdd, mode: "async" });
    expect(Math.round(a.throughput / 1000)).toBe(40);
    expect(Math.round(a.maxAtRisk / 1000)).toBe(8);
    expect(a.maxRiskAgeMs).toBeLessThanOrEqual(200 + hdd);
    for (const mode of ["group", "async"] as const) expect(Math.round(gcSteady({ clients: 32, fsyncMs: DEVICES.plp.fsyncMs, mode }).throughput / 1000)).toBe(40);
    expect(Math.round(gcSteady({ clients: 32, fsyncMs: DEVICES.plp.fsyncMs, mode: "per-commit" }).throughput)).toBe(20000);
  });
  test("PostgreSQL's asynchronous commit risk window: 3 x 200 ms = 600 ms", () => {
    expect(pgAsyncRiskWindowMs()).toBe(600);
  });
});

describe("physical, logical and physiological logging", () => {
  test("operation 1 changes 9 bytes in two ranges (17 B); operation 3 changes 3 bytes (13 B vs 7 B)", () => {
    const phys = LF.buildLog("physical"), physio = LF.buildLog("physiological");
    expect(phys[0]!.diff!.map((d) => [d.off, d.bytes.length])).toEqual([[0, 5], [60, 4]]);
    expect(phys[0]!.bytes).toBe(17);
    expect(phys[2]!.diff!.reduce((s, d) => s + d.bytes.length, 0)).toBe(3);
    expect(phys[2]!.bytes).toBe(13);
    expect(physio[2]!.bytes).toBe(7);
  });
  test("log bytes after the checkpoint: physical 43, physiological 22, with full-page writes 86, logical 29", () => {
    expect(LF.logBytes("physical")).toBe(43);
    expect(LF.logBytes("physiological")).toBe(22);
    expect(LF.logBytes("fpw")).toBe(86);
    expect(LF.logBytes("logical")).toBe(29);
    expect(LF.buildLog("fpw")[2]!.bytes).toBe(71);
  });
  test("replay verdicts quoted in the lesson", () => {
    const off = LF.verdictTable(false), on = LF.verdictTable(true);
    expect(off.physiological.final).toBe("wrong");
    expect(LF.replay("physiological", LF.diskPage("final"), false).note).toContain("cyd=1, cyd=1");
    expect(on.physiological.final).toBe("correct");
    expect(LF.replay("physiological", LF.diskPage("final"), true).skipped).toBe(3);
    for (const t of [off, on]) {
      expect(t.logical.final).toBe("wrong");
      expect(t.physiological.torn).toBe("refused");
      expect(t.logical.torn).toBe("refused");
      expect(t.fpw.torn).toBe("correct");
      for (const c of ["checkpoint", "after4", "final", "torn"] as const) expect(t.fpw[c]).toBe("correct");
    }
    expect(LF.replay("logical", LF.diskPage("final"), true).note).toContain("bob=9");
    expect(off.physical.torn).toBe("correct");
    expect(on.physical.torn).toBe("wrong");
    expect(LF.diskPage("torn")[0]).toBe(5); // the torn header claims pageLSN 5
    expect(LF.TORN_NEW_SECTORS).toEqual([0]);
    expect(LF.PAGE_BYTES / LF.SECTOR_BYTES).toBe(4);
  });
  test("real scale: physiological update 146 B, full page image 8,236 B, 56 times more; 16 sectors per page", () => {
    const r = LF.realSizes();
    expect(r.physiological).toBe(146);
    expect(r.fullPage).toBe(8236);
    expect(Math.floor(r.fullPage / r.physiological)).toBe(56);
    expect(LF.sectorsPerPage(8192, 512)).toBe(16);
  });
});

describe("aries", () => {
  const full = () => {
    const { db } = runScript(ariesDb, ARIES, ARIES_DEFAULT_CRASH);
    const c = db.crash();
    return { db, c, r: new Recovery(c) };
  };
  test("analysis starts at begin_checkpoint LSN 4 and reads 13 records; T3 loses; T4's end at LSN 18 is lost", () => {
    const { db, r } = full();
    expect(ARIES_DEFAULT_CRASH).toBe(18);
    expect(ARIES.length).toBe(19); // one more step, so the slider can move right from the default
    r.finishPhase();
    expect(r.analysisStart).toBe(4);
    expect(r.counts.analysed).toBe(13);
    expect(r.losers).toEqual([3]);
    expect(db.log[17]!.kind).toBe("end");
    expect(db.flushedLSN).toBe(17);
    expect(r.redoLSN).toBe(2);
  });
  test("the checkpoint snapshot holds T1, T2 and pages B:2, C:3", () => {
    const { db } = runScript(ariesDb, ARIES, 7);
    const e = db.log.find((x) => x.kind === "end_ckpt");
    expect(e?.kind === "end_ckpt" && e.att.map((a) => a.txn)).toEqual([1, 2]);
    expect(e?.kind === "end_ckpt" && e.dpt).toEqual([{ page: 1, recLSN: 2 }, { page: 2, recLSN: 3 }]);
  });
  test("redo applies 6 records and skips 3 (LSN 3 because page C has pageLSN 12); undo writes 3 CLRs for 16, 12, 9", () => {
    const { c, r } = full();
    r.run();
    expect(r.counts.redone).toBe(6);
    expect(r.counts.skipped).toBe(3);
    expect(r.events.find((e) => e.phase === "redo" && e.lsn === 3)!.text).toContain("pageLSN 12");
    const redone = r.events.filter((e) => e.kind === "redo").map((e) => e.lsn);
    expect(redone).toEqual([2, 9, 11, 13, 15, 16]);
    expect(r.events.filter((e) => e.kind === "clr").map((e) => e.lsn)).toEqual([16, 12, 9]);
    expect(c.state()).toEqual([[11], [41], [12], [0]]);
    expect(c.diffFromAcked()).toEqual([]);
  });
  test("crash after the first CLR is flushed: attempt 2 jumps from CLR 19 to its undoNextLSN 12", () => {
    const { c, r } = full();
    r.finishPhase(); r.finishPhase();
    r.step(); // CLR 19
    c.flushLog();
    r.step(); // CLR 20, lost
    const c2 = c.crash();
    expect(c2.lastLSN).toBe(19);
    const r2 = new Recovery(c2);
    r2.run();
    const jump = r2.events.find((e) => e.kind === "follow" && e.lsn === 19)!;
    expect(jump.text).toContain("undoNextLSN 12");
    expect(r2.events.filter((e) => e.kind === "clr").map((e) => e.lsn)).toEqual([12, 9]);
    expect(c2.diffFromAcked()).toEqual([]);
  });
  test("crash after step 13: T2 is a loser and continues its rollback from the CLR at LSN 11", () => {
    const { db } = runScript(ariesDb, ARIES, 13);
    const c = db.crash();
    const r = new Recovery(c);
    r.run();
    expect(r.losers).toEqual([2, 3]);
    expect(r.events.some((e) => e.kind === "follow" && e.lsn === 11)).toBe(true);
    expect(r.counts.clrs).toBe(3);
    expect(c.diffFromAcked()).toEqual([]);
  });
  test("undo work with crashes: CLRs always 6; normal update records 12, 22, 36, 58", () => {
    for (let k = 0; k <= 4; k++) expect(undoUnderCrashes(6, k, "clr").undoActions).toBe(6);
    expect([1, 2, 3, 4].map((k) => undoUnderCrashes(6, k, "naive").undoActions)).toEqual([12, 22, 36, 58]);
    // each CLR undoes an original update, never another CLR
    const r = undoUnderCrashes(6, 3, "clr");
    const updates = new Set(r.records.filter((x) => x.kind === "update").map((x) => x.lsn));
    for (const x of r.records.filter((x) => x.kind === "clr")) expect(updates.has(x.undoes!)).toBe(true);
  });
});

describe("checkpoints", () => {
  const sim = (timeoutSec: number, completion = 0.9, maxWalMiB = 1024) => simulateCheckpoints({ timeoutSec, completion, maxWalMiB });
  const GiB = 2 ** 30, MiB = 2 ** 20;
  test("model inputs: 500 updates/s, 8 GiB of 8 KiB pages, 64 MiB/s replay", () => {
    expect(CKPT_DEFAULTS.updatesPerSec).toBe(500);
    expect(CKPT_DEFAULTS.pages * 8192).toBe(8 * GiB);
    expect(CKPT_DEFAULTS.replayBytesPerSec).toBe(64 * MiB);
  });
  test("defaults: 11 checkpoints by time, flat 1.52 MiB/s, worst recovery 12.7 s, 6.7 s at 25 min, 97% FPI", () => {
    const r = sim(300);
    expect(r.checkpoints.length).toBe(11);
    expect(r.checkpoints.every((c) => c.trigger === "time")).toBe(true);
    expect(((r.peakWritePagesPerSec * 8192) / MiB).toFixed(2)).toBe("1.52");
    expect(r.maxRecoverySec.toFixed(1)).toBe("12.7");
    expect(r.recovery[1500]!.toFixed(1)).toBe("6.7");
    expect(Math.round((100 * r.totalFpi * 8192) / r.totalWalBytes)).toBe(97);
    expect(r.checkpoints[0]!.end - r.checkpoints[0]!.start).toBe(270);
  });
  test("target 0: spikes of 195 MiB/s that last 3 s; worst recovery 6.7 s", () => {
    const r = sim(300, 0);
    expect(Math.round((r.peakWritePagesPerSec * 8192) / MiB)).toBe(195);
    expect(r.checkpoints[0]!.end - r.checkpoints[0]!.start).toBe(3);
    expect(r.maxRecoverySec.toFixed(1)).toBe("6.7");
  });
  test("the trade-off table", () => {
    const rows = [60, 300, 900, 1800].map((t) => {
      const r = sim(t);
      return [r.checkpoints.length, r.checkpoints.filter((c) => c.trigger === "time").length, Math.round(r.maxRecoverySec * 10) / 10, +((r.totalPageWrites * 8192) / GiB).toFixed(1), +(r.totalWalBytes / GiB).toFixed(1)];
    });
    expect(rows).toEqual([
      [59, 59, 3.3, 6.2, 6.5],
      [11, 11, 12.7, 4.4, 5.0],
      [4, 0, 29.0, 3.1, 4.1],
      [2, 0, 48.2, 1.9, 3.5],
    ]);
  });
  test("PostgreSQL size trigger with the defaults: 1024 MiB / 1.9 = 539 MiB", () => {
    expect(Math.round(1024 / (1 + 0.9))).toBe(539);
  });
  test("fuzzy checkpoint stepper", () => {
    const at = (k: number) => runScript(fuzzyDb, FUZZY, k).db;
    const s6 = at(6);
    expect(s6.pending!.dpt).toEqual([{ page: 1, recLSN: 2 }, { page: 2, recLSN: 3 }]);
    expect(s6.pending!.att.map((a) => a.txn)).toEqual([2]);
    expect(at(9).dpt().map((d) => d.page)).toEqual([0, 2, 3]);
    const p10 = recoveryPlan(at(10));
    expect([p10.analysisFrom, p10.redoFrom, p10.ok]).toEqual([6, 2, true]);
    const age = (k: number) => { const d = at(k); return d.lastLSN - Math.min(...d.dpt().map((x) => x.recLSN)); };
    expect(age(10)).toBe(6);
    expect(age(13)).toBeLessThan(age(12));
    expect(recoveryPlan(at(13)).redoFrom).toBe(2);
  });
});
