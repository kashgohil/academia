/** Numbers quoted in the Transactions lessons, produced by src/sims/db/txn. */
import { describe, expect, test } from "vitest";
import {
  // schedule
  TXN_SETS, countSerializable, interleavings, matchingSerialOrders, runConcrete, parseSchedule, isConflictSerializable, precedenceGraph,
  findCycle, topoOrder, moveLeft, bankCrash, badCrashPoints, bankSteps, totalMoney, BANK_INIT,
  // engine
  SCENARIOS, SSI_SCENARIOS, LEVELS, explore, cellKind, runPath, verdict, committedState, scenarioById, buildPath, dangerousStructures, runSerial,
  type Level,
  // locks
  LockManager, COMPAT, MODES, sup, LOCK_SCRIPTS, runLockScript, scriptSummary, hierLocks,
  // contention
  simulate, MPL_SWEEP, THETA_SWEEP, hottestShare, zipfCdf,
  // occ
  OCC_SCRIPTS, occSummary, runOcc,
  // mvcc
  runMvScript, chainCost, pgVisible,
  // gc
  bloatSim, autovacuumTrigger, XID_SPACE, XID_HALF, xidPrecedes, xidAge, rowLooksPast, daysToWraparound, daysToForcedVacuum,
} from "@/sims/db/txn";

const set = (id: string) => TXN_SETS.find((s) => s.id === id)!;

// ============================================================================ acid
describe("acid: bank transfers with a crash", () => {
  test("9 steps; the total is 300", () => {
    expect(bankSteps().length).toBe(9);
    expect(totalMoney(BANK_INIT)).toBe(300);
  });
  test("without a log, crash points 1, 4 and 7 (3 of 10) break the total; with an undo log none do", () => {
    expect(badCrashPoints(false)).toEqual([1, 4, 7]);
    expect(badCrashPoints(true)).toEqual([]);
  });
  test("crash after step 4: 250 without a log; with the log T2 is undone and B goes from 80 back to 130", () => {
    expect(bankCrash(4, false).total).toBe(250);
    const r = bankCrash(4, true);
    expect(r.atCrash.B).toBe(80);
    expect(r.recovered.B).toBe(130);
    expect(r.undone).toEqual([1]);
    expect(r.committed).toBe(1);
    expect(r.total).toBe(300);
  });
});

describe("acid: schedules and precedence graphs", () => {
  test("two read-modify-writes: 6 interleavings, 2 conflict serializable", () => {
    expect(countSerializable(set("lost").txns)).toEqual({ total: 6, serializable: 2 });
  });
  test("transfer and audit: 10 of 15; ring of three: 42 of 90", () => {
    expect(countSerializable(set("transfer").txns)).toEqual({ total: 15, serializable: 10 });
    expect(countSerializable(set("ring").txns)).toEqual({ total: 90, serializable: 42 });
  });
  test("for these sets, serial-result schedules are exactly the conflict-serializable ones", () => {
    for (const s of TXN_SETS) {
      for (const sch of interleavings(s.txns)) expect(matchingSerialOrders(s, sch).length > 0).toBe(isConflictSerializable(sch));
    }
  });
  test("serial orders of the two updates give x = 220 and x = 210", () => {
    const s = set("lost");
    expect(runConcrete(s, [...s.txns[0]!, ...s.txns[1]!]).state.x).toBe(220);
    expect(runConcrete(s, [...s.txns[1]!, ...s.txns[0]!]).state.x).toBe(210);
  });
  test("audit between the two writes reads A = 90 and B = 100: a total of 190", () => {
    const s = set("transfer");
    const [t1, t2] = s.txns as [typeof s.txns[0], typeof s.txns[0]];
    const sch = [t1[0]!, t1[1]!, t2[0]!, t2[1]!, t1[2]!, t1[3]!];
    expect(runConcrete(s, sch).reads[1]).toEqual(["A=90", "B=100"]);
    expect(isConflictSerializable(sch)).toBe(false);
  });
  test("graph helpers", () => {
    const s = parseSchedule("r1(x) r2(x) w1(x) w2(x)");
    const g = precedenceGraph(s);
    expect(findCycle(g.nodes, g.edges)).toEqual([0, 1, 0]);
    expect(topoOrder(g.nodes, g.edges)).toBeNull();
    expect(topoOrder([0, 1], [{ from: 1, to: 0 }])).toEqual([1, 0]);
    expect(moveLeft(s, 1).map((o) => o.t)).toEqual([1, 0, 0, 1]); // different transactions: swap
    const same = parseSchedule("r1(x) w1(x) r2(x)");
    expect(moveLeft(same, 1)).toBe(same); // same transaction: order is kept
  });
});

// ============================================================================ isolation levels: the matrix
const M: Record<string, Partial<Record<Level, [number, number, number, number]>>> = {
  // [anomalies, runs, runs that waited, runs with an engine abort]
  "dirty-write": { NONE: [6, 20, 0, 0], RU: [0, 6, 4, 0], RC: [0, 6, 4, 0], "RC-MVCC": [0, 6, 4, 0], RR: [0, 6, 4, 0], SER: [0, 6, 4, 0], SI: [0, 6, 4, 4], SSI: [0, 6, 4, 4] },
  "dirty-read": { NONE: [2, 6, 0, 0], RU: [2, 6, 0, 0], RC: [0, 5, 1, 0], "RC-MVCC": [0, 6, 0, 0], RR: [0, 4, 2, 0], SER: [0, 4, 2, 0], SI: [0, 6, 0, 0], SSI: [0, 6, 0, 0] },
  "non-repeatable": { NONE: [3, 10, 0, 0], RU: [3, 10, 0, 0], RC: [2, 7, 2, 0], "RC-MVCC": [2, 10, 0, 0], RR: [0, 5, 3, 0], SER: [0, 5, 3, 0], SI: [0, 10, 0, 0], SSI: [0, 10, 0, 0] },
  phantom: { NONE: [3, 10, 0, 0], RU: [3, 10, 0, 0], RC: [2, 7, 2, 0], "RC-MVCC": [2, 10, 0, 0], RR: [2, 7, 2, 0], SER: [0, 5, 3, 0], SI: [0, 10, 0, 0], SSI: [0, 10, 0, 0] },
  "lost-update": { NONE: [12, 20, 0, 0], RU: [8, 14, 6, 0], RC: [8, 12, 6, 0], "RC-MVCC": [12, 14, 6, 0], RR: [0, 8, 6, 4], SER: [0, 8, 6, 4], SI: [0, 14, 6, 12], SSI: [0, 14, 6, 12] },
  "read-skew": { NONE: [16, 56, 0, 0], RU: [16, 56, 0, 0], RC: [4, 38, 5, 0], "RC-MVCC": [5, 56, 0, 0], RR: [0, 13, 8, 0], SER: [0, 13, 8, 0], SI: [0, 56, 0, 0], SSI: [0, 56, 0, 0] },
  "write-skew": { NONE: [12, 20, 0, 0], RU: [12, 20, 0, 0], RC: [12, 16, 2, 0], "RC-MVCC": [18, 20, 0, 0], RR: [0, 8, 6, 4], SER: [0, 8, 6, 4], SI: [18, 20, 0, 0], SSI: [0, 20, 0, 18] },
  "insert-skew": { NONE: [12, 20, 0, 0], RU: [12, 20, 0, 0], RC: [12, 16, 2, 0], "RC-MVCC": [18, 20, 0, 0], RR: [12, 16, 2, 0], SER: [0, 8, 6, 4], SI: [18, 20, 0, 0], SSI: [0, 20, 0, 18] },
};

describe("isolation: anomaly × level matrix over every interleaving", () => {
  for (const sc of SCENARIOS) {
    test(`${sc.code} ${sc.name}`, () => {
      for (const l of LEVELS) {
        const e = explore(sc, l.id);
        expect([e.anomalies, e.runs, e.blocked, e.aborted], `${sc.id} / ${l.id}`).toEqual(M[sc.id]![l.id]);
      }
    });
  }
  test("every scenario is a real anomaly with no control, and 2PL and SSI prevent all of them", () => {
    for (const sc of SCENARIOS) {
      expect(explore(sc, "NONE").anomalies).toBeGreaterThan(0);
      expect(explore(sc, "SER").anomalies).toBe(0);
      expect(explore(sc, "SSI").anomalies).toBe(0);
    }
  });
  test("SI lets through only the two write skews", () => {
    const bad = SCENARIOS.filter((sc) => explore(sc, "SI").anomalies > 0).map((sc) => sc.id);
    expect(bad).toEqual(["write-skew", "insert-skew"]);
  });
  test("both kinds of read committed allow the same anomalies", () => {
    for (const sc of SCENARIOS) expect(explore(sc, "RC").anomalies > 0).toBe(explore(sc, "RC-MVCC").anomalies > 0);
  });
  test("cell kinds", () => {
    expect(cellKind(explore(scenarioById("lost-update"), "RR"))).toBe("aborts");
    expect(cellKind(explore(scenarioById("phantom"), "SER"))).toBe("blocks");
    expect(cellKind(explore(scenarioById("phantom"), "SI"))).toBe("clean");
  });
});

describe("isolation: the classic lost update", () => {
  const sc = scenarioById("lost-update");
  test("read committed with locks: final x = 15, serial orders give 16", () => {
    const st = runPath(sc, "RC", sc.classic);
    expect(committedState(st).x).toBe(15);
    expect(verdict(st, sc).anomaly).toBe(true);
    expect(runSerial(sc, [0, 1]).state.x).toBe(16);
    expect(runSerial(sc, [1, 0]).state.x).toBe(16);
    expect(st.txns[1]!.blockedEver).toBe(true);
  });
  test("repeatable read: deadlock aborts T2, x = 11", () => {
    const st = runPath(sc, "RR", sc.classic);
    expect(st.txns[1]!.abortReason).toContain("deadlock");
    expect(committedState(st).x).toBe(11);
  });
  test("SI: T2 waits, then aborts by first-updater-wins", () => {
    const st = runPath(sc, "SI", sc.classic);
    expect(st.txns[1]!.blockedEver).toBe(true);
    expect(st.txns[1]!.abortReason).toContain("first-updater-wins");
  });
  test("phantom under RR: the second count sees 3 rows", () => {
    const p = scenarioById("phantom");
    const st = runPath(p, "RR", p.classic);
    expect(st.txns[0]!.obs).toEqual(["n=2", "n2=3"]);
  });
});

// ============================================================================ 2PL
describe("2PL: lock manager", () => {
  test("compatibility matrix", () => {
    const yes = MODES.flatMap((a) => MODES.filter((b) => COMPAT[a][b]).map((b) => `${a}-${b}`));
    expect(yes).toEqual(["IS-IS", "IS-IX", "IS-S", "IS-SIX", "IX-IS", "IX-IX", "S-IS", "S-S", "SIX-IS"]);
    expect(sup("IX", "S")).toBe("SIX");
    expect(sup("IS", "X")).toBe("X");
  });
  test("script outcomes for each policy", () => {
    const out = (id: string, p: "detect" | "wait-die" | "wound-wait" | "no-wait") => scriptSummary(LOCK_SCRIPTS.find((s) => s.id === id)!, p).aborted;
    expect(out("two", "detect")).toEqual([1]);
    expect(out("two", "wait-die")).toEqual([1]);
    expect(out("two", "wound-wait")).toEqual([1]);
    expect(out("three", "detect")).toEqual([2]);
    expect(out("three", "wait-die")).toEqual([2]);
    expect(out("three", "wound-wait")).toEqual([1]);
    expect(out("three", "no-wait")).toEqual([0, 1]);
    expect(out("queue", "detect")).toEqual([]);
    expect(out("queue", "wait-die")).toEqual([2]);
  });
  test("two-way deadlock under detection: the cycle appears at line 4, T2 is the victim", () => {
    const f = runLockScript(LOCK_SCRIPTS[0]!, "detect");
    expect(f[4]!.cycle).toEqual([1, 0, 1]);
    expect(f[4]!.aborted).toEqual([1]);
  });
  test("wound-wait: the older requester gets B at once", () => {
    const m = new LockManager("wound-wait");
    m.request(0, "A", "X");
    m.request(1, "B", "X");
    const r = m.request(0, "B", "X");
    expect(r.status).toBe("granted");
    expect(r.aborted).toEqual([1]);
  });
  test("FIFO: T4's S waits behind T3's X although it is compatible with the holders", () => {
    const m = new LockManager("detect");
    m.request(0, "A", "S");
    m.request(1, "A", "S");
    expect(m.request(2, "A", "X").status).toBe("waiting");
    expect(m.request(3, "A", "S").status).toBe("waiting");
  });
  test("hierarchy: a row update needs IX, IX, X; it is compatible with a row reader elsewhere", () => {
    expect(hierLocks("write-row", "r3")).toEqual([["T", "IX"], ["P2", "IX"], ["r3", "X"]]);
    const m = new LockManager("no-wait");
    for (const [r, md] of hierLocks("read-row", "r1")) m.request(0, r, md);
    expect(m.check(1, hierLocks("write-row", "r3"))).toEqual([]);
    expect(m.check(2, hierLocks("scan-table")).length).toBe(0);
    for (const [r, md] of hierLocks("write-row", "r3")) m.request(1, r, md);
    expect(m.check(2, hierLocks("scan-table"))[0]!.blockers).toEqual([1]);
    expect(m.check(2, hierLocks("write-table"))[0]!.blockers).toEqual([0, 1]);
  });
});

describe("2PL: contention sweep (100 items, 8 locks, 50% writes)", () => {
  const run = (p: "detect" | "wait-die" | "wound-wait" | "no-wait", mpl: number, cores = Infinity, items = 100) => simulate({ protocol: p, mpl, items, ops: 8, writeFrac: 0.5, cores });
  const best = (p: "detect" | "wait-die" | "wound-wait" | "no-wait", cores = Infinity, items = 100) =>
    MPL_SWEEP.map((m) => ({ m, t: run(p, m, cores, items).throughput })).reduce((a, x) => (x.t > a.t ? x : a));
  test("detection peaks at 0.38 at 6 transactions, then falls to 0.15 at 32 with 70% aborts", () => {
    const b = best("detect");
    expect(b.m).toBe(6);
    expect(b.t.toFixed(2)).toBe("0.38");
    const r = run("detect", 32);
    expect(r.throughput.toFixed(2)).toBe("0.15");
    expect(Math.round(r.abortRate * 100)).toBe(70);
  });
  test("wait-die 0.44 at 16, wound-wait 0.46 at 32, no-wait 0.39 at 16; aborts 83% to 88% at 32", () => {
    expect(best("wait-die")).toMatchObject({ m: 16 });
    expect(best("wait-die").t.toFixed(2)).toBe("0.44");
    expect(best("wound-wait").m).toBe(32);
    expect(best("wound-wait").t.toFixed(2)).toBe("0.46");
    expect(best("no-wait").m).toBe(16);
    expect(best("no-wait").t.toFixed(2)).toBe("0.39");
    expect(Math.round(run("wait-die", 32).abortRate * 100)).toBe(88);
    expect(Math.round(run("wound-wait", 32).abortRate * 100)).toBe(83);
    for (const p of ["wait-die", "wound-wait"] as const) for (const m of [12, 16, 24, 32]) {
      const t = run(p, m).throughput;
      expect(t).toBeGreaterThanOrEqual(0.41);
      expect(t).toBeLessThanOrEqual(0.46);
    }
  });
  test("with 4 cores every policy peaks at 6, and wait-die falls lowest, to 0.09 at 32", () => {
    for (const p of ["detect", "wait-die", "wound-wait", "no-wait"] as const) expect(best(p, 4).m).toBe(6);
    const at32 = (["detect", "wait-die", "wound-wait", "no-wait"] as const).map((p) => run(p, 32, 4).throughput);
    expect(at32[1]!.toFixed(2)).toBe("0.09");
    expect(Math.min(...at32)).toBe(at32[1]);
  });
  test("with 5,000 items the curves stay within 10%; at 32, no-wait aborts 14% and detection almost none", () => {
    for (const m of MPL_SWEEP) {
      const ts = (["detect", "wait-die", "wound-wait", "no-wait"] as const).map((p) => run(p, m, Infinity, 5000).throughput);
      expect(Math.max(...ts) / Math.min(...ts), `mpl ${m}`).toBeLessThan(1.1);
    }
    expect(Math.round(run("no-wait", 32, Infinity, 5000).abortRate * 100)).toBe(14);
    expect(run("detect", 32, Infinity, 5000).abortRate).toBeLessThan(0.005);
  });
  test("one transaction alone: 8 accesses + commit = 1/9 commits per tick", () => {
    expect(run("detect", 1).throughput).toBeCloseTo(1 / 9, 2);
  });
}, 60_000);

// ============================================================================ OCC
describe("OCC: stepper", () => {
  const s = (id: string) => OCC_SCRIPTS.find((x) => x.id === id)!;
  test("stale read: backward aborts T1 after 3 operations; forward aborts it after 1", () => {
    expect(occSummary(s("stale"), "backward")).toEqual({ committed: [1], aborted: [0], wasted: 3 });
    expect(occSummary(s("stale"), "forward")).toEqual({ committed: [1], aborted: [0], wasted: 1 });
    const f = runOcc(s("stale"), "backward");
    expect(f.find((x) => x.check && x.check.t === 1)!.txns[1]!.tn).toBe(1);
  });
  test("disjoint sets, a late start and blind writes all commit", () => {
    for (const id of ["disjoint", "late", "blind"]) for (const m of ["backward", "forward"] as const) expect(occSummary(s(id), m).aborted).toEqual([]);
    const late = runOcc(s("late"), "backward");
    expect(late.at(-1)!.txns[2]!.start).toBe(1);
    const blind = runOcc(s("blind"), "backward").at(-1)!;
    expect(blind.committed.map((c) => c.t)).toEqual([1, 0]);
  });
});

describe("OCC vs 2PL under Zipf skew (16 transactions, 4 cores, 1,000 items, 25% writes)", () => {
  const run = (p: "detect" | "occ", theta: number, cores = 4) => simulate({ protocol: p, theta, mpl: 16, cores, items: 1000, ops: 8, writeFrac: 0.25 });
  test("θ = 0: 2PL 0.43 commits per tick, OCC 0.39 with 12% aborts", () => {
    expect(run("detect", 0).throughput.toFixed(2)).toBe("0.43");
    const o = run("occ", 0);
    expect(o.throughput.toFixed(2)).toBe("0.39");
    expect(Math.round(o.abortRate * 100)).toBe(12);
  });
  test("θ = 0.8: 2PL wastes 11% of its work, OCC 47%; θ = 1.2: 49% and 71%", () => {
    expect(Math.round(run("detect", 0.8).wasted * 100)).toBe(11);
    expect(Math.round(run("occ", 0.8).wasted * 100)).toBe(47);
    expect(Math.round(run("detect", 1.2).wasted * 100)).toBe(49);
    expect(Math.round(run("occ", 1.2).wasted * 100)).toBe(71);
  });
  test("OCC: abort rate equals wasted share (within 1 point)", () => {
    for (const th of THETA_SWEEP) { const r = run("occ", th); expect(Math.abs(r.abortRate - r.wasted)).toBeLessThan(0.01); }
  });
  test("without the CPU limit, OCC wins at θ = 1.4: 0.29 vs 0.10", () => {
    expect(run("occ", 1.4, Infinity).throughput.toFixed(2)).toBe("0.29");
    expect(run("detect", 1.4, Infinity).throughput.toFixed(2)).toBe("0.10");
  });
  test("hottest item: 6.5% of accesses at θ = 0.8, 23% at 1.2", () => {
    expect((hottestShare(1000, 0.8) * 100).toFixed(1)).toBe("6.5");
    expect((hottestShare(1000, 1.2) * 100).toFixed(1)).toBe("23.1");
    expect(zipfCdf(1000, 0)[0]).toBeCloseTo(0.001, 6);
  });
}, 60_000);

// ============================================================================ MVCC
describe("MVCC: the scripted timeline", () => {
  const f = runMvScript();
  const sees = (i: number) => Object.fromEntries(f[i]!.readers.map((r) => [r.name, r.sees === null ? null : f[i]!.tuples.find((t) => t.lp === r.sees)!.value]));
  test("R1 snapshot at event 4: xmin 101, xmax 102, xip [101]; it sees 10 before and after the commit", () => {
    expect(f[3]!.readers[0]!.snap).toEqual({ xmin: 101, xmax: 102, xip: [101] });
    expect(sees(3)).toEqual({ R1: 10 });
    expect(sees(4)).toEqual({ R1: 10 });
    expect(sees(5)).toEqual({ R1: 10, R2: 20 });
  });
  test("the aborted update leaves a = 30 that nobody sees; R3 sees 20 while the delete runs; R4 sees no row", () => {
    expect(f[7]!.tuples.find((t) => t.value === 30)!.xmin).toBe(102);
    expect(sees(11)).toEqual({ R1: 10, R2: 20, R3: 20, R4: null });
  });
  test("rule trace: an xmin in xip is invisible", () => {
    const fr = f[4]!;
    const v = pgVisible(fr.tuples[1]!, fr.readers[0]!.snap, fr.clog);
    expect(v.visible).toBe(false);
    expect(v.steps.at(-1)!.a).toContain("in xip");
  });
  test("layouts for 5 updates: HOT reader of v1 checks 2, newest 6; non-HOT 6 entries; InnoDB 5 and 1", () => {
    expect(chainCost("pg-hot", 5, 1).visits).toBe(2);
    expect(chainCost("pg-hot", 5, 5).visits).toBe(6);
    expect(chainCost("pg", 5, 1)).toMatchObject({ indexEntries: 6, visits: 6 });
    expect(chainCost("innodb", 5, 1).visits).toBe(5);
    expect(chainCost("innodb", 5, 5).visits).toBe(1);
  });
});

// ============================================================================ SSI
describe("SSI: counts over every interleaving", () => {
  const sc = (id: string) => SSI_SCENARIOS.find((s) => s.id === id)!;
  test("write skew: SI 18 of 20 bad; SSI aborts in 18 of 20; without the commit-order rule 12 of 14", () => {
    expect(explore(sc("write-skew"), "SI")).toMatchObject({ anomalies: 18, runs: 20 });
    expect(explore(sc("write-skew"), "SSI")).toMatchObject({ anomalies: 0, runs: 20, aborted: 18 });
    expect(explore(sc("write-skew"), "SSI-BASIC")).toMatchObject({ anomalies: 0, runs: 14, aborted: 12 });
  });
  test("read-only anomaly: SI 141 of 4,200; SSI 102 aborts of 4,161; basic 2,413 of 3,064", () => {
    expect(explore(sc("read-only"), "SI")).toMatchObject({ anomalies: 141, runs: 4200, aborted: 0 });
    expect(explore(sc("read-only"), "SSI")).toMatchObject({ anomalies: 0, runs: 4161, aborted: 102 });
    expect(explore(sc("read-only"), "SSI-BASIC")).toMatchObject({ anomalies: 0, runs: 3064, aborted: 2413 });
  });
  test("false positive: SI never bad in 560 runs; SSI aborts 159 of 524; basic 261 of 407", () => {
    expect(explore(sc("false-positive"), "SI")).toMatchObject({ anomalies: 0, runs: 560 });
    expect(explore(sc("false-positive"), "SSI")).toMatchObject({ anomalies: 0, runs: 524, aborted: 159 });
    expect(explore(sc("false-positive"), "SSI-BASIC")).toMatchObject({ anomalies: 0, runs: 407, aborted: 261 });
  });
  test("classic doctors: two rw edges under SI; under SSI T2 is doomed when T1 commits", () => {
    const d = sc("write-skew");
    const si = runPath(d, "SI", d.classic);
    expect(si.edges.filter((e) => e.kind === "rw").map((e) => [e.from, e.to])).toEqual([[1, 0], [0, 1]]);
    expect(verdict(si, d).anomaly).toBe(true);
    const ssi = runPath(d, "SSI", d.classic);
    expect(ssi.txns[1]!.abortReason).toContain("SSI victim");
    expect(ssi.txns[0]!.status).toBe("committed");
  });
  test("classic read-only anomaly and false positive: the pivot T2 aborts", () => {
    const ro = sc("read-only");
    expect(verdict(runPath(ro, "SI", ro.classic), ro).anomaly).toBe(true);
    expect(runPath(ro, "SSI", ro.classic).txns[1]!.status).toBe("aborted");
    const fp = sc("false-positive");
    const p = buildPath(fp, "SSI", fp.classic);
    const st = p.states.at(-1)!;
    expect(st.txns[1]!.status).toBe("aborted");
    expect(dangerousStructures(p.states[5]!, fp)).toEqual([{ tin: 0, pivot: 1, tout: 2 }]);
  });
});

// ============================================================================ GC
describe("MVCC garbage collection", () => {
  test("autovacuum trigger: 250 dead tuples for 1,000 rows, 200,050 for 1,000,000", () => {
    expect(autovacuumTrigger(1000)).toBe(250);
    expect(autovacuumTrigger(1_000_000)).toBe(200_050);
  });
  test("no long transaction: peak 400 dead, 28 pages, 30 vacuums", () => {
    const r = bloatSim({ readerLength: 0 });
    expect([r.peakDead, r.pages, r.vacuums, r.uselessVacuums]).toEqual([400, 28, 30, 0]);
  });
  test("a 300-tick snapshot: peak 6,000 dead, 140 pages, 44 vacuums of which 28 remove nothing", () => {
    const r = bloatSim({ readerLength: 300 });
    expect([r.peakDead, r.pages, r.vacuums, r.uselessVacuums]).toEqual([6000, 140, 44, 28]);
    const after = r.points.find((p) => p.t >= 400 && p.vacuum !== null)!;
    expect(after.vacuum).toBeGreaterThanOrEqual(6000);
  });
  test("XID ring: 2^32 = 4,294,967,296 ids, 2^31 = 2,147,483,648 in the past", () => {
    expect(XID_SPACE).toBe(4_294_967_296);
    expect(XID_HALF).toBe(2_147_483_648);
    expect(xidPrecedes(4_000_000_000, 100)).toBe(true); // wrapped: 4e9 is older than 100
    expect(xidPrecedes(100, 2_147_483_749)).toBe(false); // more than 2^31 ahead: wraps to the past
    expect(xidAge(5, 4_294_967_290)).toBe(11);
  });
  test("a row 2.2 billion ids old looks in the future unless frozen", () => {
    expect(rowLooksPast(2.2e9, false)).toBe(false);
    expect(rowLooksPast(2.2e9, true)).toBe(true);
    expect(rowLooksPast(1e9, false)).toBe(true);
  });
  test("days: 24.9 to half the ring at 1,000 per second, 2.5 at 10,000; forced freeze every 2.3 days at 1,000", () => {
    expect(daysToWraparound(1000).toFixed(1)).toBe("24.9");
    expect(daysToWraparound(10_000).toFixed(1)).toBe("2.5");
    expect(daysToForcedVacuum(1000).toFixed(1)).toBe("2.3");
  });
});
