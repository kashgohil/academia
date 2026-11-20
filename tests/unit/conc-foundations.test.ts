import { describe, expect, test } from "vitest";
import {
  MIX_DEFAULTS, amdahl, chanceToSee, ctaBugSchedule, ctaCounts, ctaProg, fitUsl, gustafson, hbAcquire, hbCounts, hbProg, hbRead, hbRelease,
  hbWrite, karpFlatt, measuredSpeedup, opsToSee, poolKnee, runMix, runPool, runScale, runSnapshot, runUsl, summarizeMix, tornCounts,
  transferCounts, transferViolation, usl, uslPeak, windowEstimate, windowRun, SNAPSHOT_DEFAULTS, USL_DEFAULTS, USL_THREADS,
  type MixParams, type Snapshot,
} from "@/sims/conc/foundations";
import { explore, machineModel } from "@/sims/os/sync/machine";

// ---------------------------------------------------------------- concurrency vs parallelism

describe("concurrency vs parallelism", () => {
  const mix = (o: Partial<MixParams>) => {
    const p = { ...MIX_DEFAULTS, ...o };
    return summarizeMix(p, runMix(p));
  };

  test("4 tasks with 80% I/O: 20 ms one after another, 5.62 ms as threads on one core, 5 ms on 4 cores", () => {
    const seq = mix({ mode: "sequential" });
    expect(seq.makespan).toBe(20_000_000);
    const one = mix({});
    expect(one.makespan).toBe(5_616_000);
    expect(one.speedup).toBeCloseTo(3.56, 2);
    expect(one.utilization).toBeCloseTo(0.71, 2);
    expect(one.switchNs).toBe(46_000);
    const four = mix({ cores: 4 });
    expect(four.makespan).toBe(5_000_000);
    expect(four.speedup).toBe(4);
    expect(four.utilization).toBeCloseTo(0.2, 6);
  });

  test("CPU-bound tasks: threads on one core give no speedup and pay the switches; 4 cores give 4×", () => {
    const one = mix({ computeNs: 1_000_000, ioNs: 0 });
    expect(one.makespan).toBe(20_006_000);
    expect(one.speedup).toBeLessThan(1);
    expect(one.switchNs).toBe(6_000);
    expect(mix({ computeNs: 1_000_000, ioNs: 0, cores: 4 }).speedup).toBe(4);
  });

  test("the last of 4 tasks waits about 0.6 ms for the one core in the first round", () => {
    const r = runMix({ ...MIX_DEFAULTS });
    const first = r.spans.find((x) => x.kind === "run" && x.tid === 3)!;
    expect(first.start).toBeGreaterThanOrEqual(600_000);
    expect(first.start).toBeLessThan(620_000);
  });

  test("8 I/O-bound tasks on one core: 4.5× and 90% busy", () => {
    const r = mix({ tasks: 8 });
    expect(r.speedup).toBeCloseTo(4.5, 1);
    expect(r.utilization).toBeCloseTo(0.9, 2);
  });

  test("pool sizing: the knee is P(1 + W/C) = 20; CPU-bound jobs stop at 4", () => {
    expect(poolKnee(4, 50_000, 200_000)).toBe(20);
    // Little's law: 4 cores finish 4 jobs per 50 µs = 80 per ms; each holds a thread for 0.25 ms.
    const perMs = 4 / 0.05;
    expect(perMs).toBe(80);
    expect(perMs * 0.25).toBe(20);
    expect(poolKnee(1, 50_000, 200_000)).toBe(5);
    expect(poolKnee(4, 50_000, 15 * 50_000)).toBe(64);
    const sp = (threads: number, w: number) => runPool({ jobs: 480, computeNs: 50_000, waitNs: w, cores: 4, threads }).speedup;
    expect(sp(4, 200_000)).toBeCloseTo(4, 2);
    expect(sp(16, 200_000)).toBeCloseTo(15.55, 1);
    expect(sp(20, 200_000)).toBeCloseTo(18.63, 2);
    expect(sp(64, 200_000)).toBeCloseTo(18.63, 2);
    expect(sp(4, 0)).toBeCloseTo(4, 2);
    expect(sp(64, 0)).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------- race conditions

describe("race conditions: check-then-act", () => {
  test("withdraw: 4 of 6 schedules overdraw; one lock and a CAS loop fix it", () => {
    expect(ctaCounts("withdraw")).toEqual({ total: 6, bad: 4 });
    expect(ctaCounts("withdraw-lock")).toEqual({ total: 2, bad: 0 });
    expect(ctaCounts("withdraw-cas")).toEqual({ total: 6, bad: 0 });
    expect(ctaBugSchedule("withdraw")).toEqual(["T0", "T1", "T0", "T1"]);
  });

  test("lazy init: 4 of 6 schedules create two configs; sync.Once creates one", () => {
    expect(ctaCounts("lazy")).toEqual({ total: 6, bad: 4 });
    expect(ctaCounts("lazy-once")).toEqual({ total: 2, bad: 0 });
  });

  test("TOCTOU: 1 of 7 schedules writes /etc/passwd; O_NOFOLLOW + fstat: none", () => {
    expect(ctaCounts("toctou")).toEqual({ total: 7, bad: 1 });
    expect(ctaBugSchedule("toctou")).toEqual(["T0", "T1", "T1", "T0", "T0"]);
    expect(ctaCounts("toctou-nofollow")).toEqual({ total: 8, bad: 0 });
  });

  test("the programs never deadlock", () => {
    for (const p of ["withdraw", "withdraw-lock", "withdraw-cas", "lazy", "lazy-once", "toctou", "toctou-nofollow"] as const) {
      expect(explore(machineModel(ctaProg(p))).stuck).toBeNull();
    }
  });
});

describe("race conditions: the window", () => {
  test("20 ns window, 10 µs apart, 2 cores: 0.2% per op, 18% for a 100-op test, 2,305 ops for 99%", () => {
    const p = windowEstimate(2, 2, 20, 10_000);
    expect(p).toBeCloseTo(0.002, 4);
    expect(Math.round(1 / p)).toBe(501);
    expect(chanceToSee(p, 100)).toBeCloseTo(0.18, 2);
    expect(opsToSee(p)).toBe(2_305);
    expect(1 - chanceToSee(p, 100)).toBeCloseTo(0.82, 2);
    expect(windowEstimate(2, 2, 1_000, 10_000)).toBeCloseTo(0.0909, 4);
  });

  test("one core: 2 in 100,000 per op, 230,257 ops for 99%", () => {
    const p = windowEstimate(2, 1, 20, 10_000);
    expect(p).toBeCloseTo(2e-5, 10);
    expect(opsToSee(p)).toBe(230_257);
  });

  test("the Runtime agrees with the estimate on two cores", () => {
    for (const w of [100, 300, 1000]) {
      const r = windowRun({ threads: 2, cores: 2, windowNs: w, thinkNs: 10_000, ops: 20_000, seed: 7 });
      const e = windowEstimate(2, 2, w, 10_000);
      expect(r.p / e).toBeGreaterThan(0.85);
      expect(r.p / e).toBeLessThan(1.15);
      // On two cores, one firing loses about one update.
      expect(r.lost / r.fired).toBeLessThan(1.1);
    }
  });

  test("one core: firings are rare, but each one loses tens of updates", () => {
    const r = windowRun({ threads: 2, cores: 1, windowNs: 1_000, thinkNs: 10_000, ops: 20_000, seed: 7 });
    const e = windowEstimate(2, 1, 1_000, 10_000);
    expect(r.p / e).toBeGreaterThan(0.6);
    expect(r.p / e).toBeLessThan(1.6);
    expect(r.lost / r.fired).toBeGreaterThan(20);
    expect(r.lost / r.fired).toBeLessThan(150);
  });
});

describe("race conditions: the vector-clock detector", () => {
  test("T1 forgets the lock: 9 of 15 schedules are wrong, and the detector flags all 15", () => {
    expect(hbCounts("one-forgets")).toEqual({ total: 15, wrong: 9, raced: 15 });
    expect(hbCounts("both-lock")).toEqual({ total: 2, wrong: 0, raced: 0 });
  });

  test("a plain flag is a race even though the result is always right; release/acquire is not", () => {
    expect(hbCounts("flag-plain")).toEqual({ total: 1, wrong: 0, raced: 1 });
    expect(hbCounts("flag-release")).toEqual({ total: 1, wrong: 0, raced: 0 });
  });

  test("clock rules: release copies and ticks, acquire joins", () => {
    const m = hbProg("both-lock").mem;
    expect(hbWrite(m, 0, "x")).toBe("");
    hbRelease(m, 0, "m");
    expect([m["Lm.0"], m["Lm.1"], m["C0.0"]]).toEqual([1, 0, 2]);
    // T1 reads without an acquire: a race.
    const m2 = { ...m };
    expect(hbRead(m2, 1, "x")).toMatch(/RACE/);
    hbAcquire(m, 1, "m");
    expect([m["C1.0"], m["C1.1"]]).toEqual([1, 1]);
    expect(hbRead(m, 1, "x")).toBe("");
    expect(hbWrite(m, 1, "x")).toBe("");
  });
});

// ---------------------------------------------------------------- atomicity

describe("atomicity: transfer and audit", () => {
  test("two atomic adds: 2 of 6 schedules show 170 or 230", () => {
    expect(transferCounts("two-adds")).toEqual({ total: 6, bad: 2, totals: { "170": 1, "200": 4, "230": 1 } });
    expect(transferViolation("two-adds")).not.toBeNull();
  });

  test("a lock in the transfer only: 5 of 15 schedules are still wrong", () => {
    expect(transferCounts("lock-writer")).toMatchObject({ total: 15, bad: 5 });
  });

  test("lock in both, packed CAS, seqlock and copy-on-write are always right", () => {
    expect(transferCounts("lock-both")).toMatchObject({ total: 2, bad: 0 });
    expect(transferCounts("packed-cas")).toMatchObject({ total: 3, bad: 0 });
    expect(transferCounts("seqlock")).toMatchObject({ total: 36, bad: 0 });
    expect(transferCounts("cow")).toMatchObject({ total: 20, bad: 0 });
    for (const s of ["lock-both", "packed-cas", "seqlock", "cow"] as const) expect(transferViolation(s)).toBeNull();
  });

  test("torn values: interface 2 of 6, slice header 3 of 10 (2 unsafe), atomic pointer 0 of 2", () => {
    expect(tornCounts("iface")).toEqual({ total: 6, torn: 2, unsafe: 2 });
    expect(tornCounts("slice")).toEqual({ total: 10, torn: 3, unsafe: 2 });
    expect(tornCounts("atomic-ptr")).toEqual({ total: 2, torn: 0, unsafe: 0 });
  });
});

describe("atomicity: the cost of each fix", () => {
  const run = (scheme: Snapshot, o = {}) => runSnapshot({ ...SNAPSHOT_DEFAULTS, scheme, ...o });

  test("only the unprotected record gives mixed reads", () => {
    expect(run("none").inconsistent).toBe(16);
    for (const s of ["mutex", "rwlock", "seqlock", "cow"] as const) expect(run(s).inconsistent).toBe(0);
  });

  test("8 threads, 90% reads, 256 B: a mutex reads at 5.4/µs and 834 ns; copy-on-write at 12.9/µs and 46 ns", () => {
    const m = run("mutex"), c = run("cow"), q = run("seqlock"), rw = run("rwlock");
    expect(m.readsPerUs).toBeCloseTo(5.41, 2);
    expect(m.readLatencyNs).toBeCloseTo(834, 0);
    expect(c.readsPerUs).toBeCloseTo(12.87, 2);
    expect(c.readLatencyNs).toBeCloseTo(46, 0);
    expect(q.readsPerUs).toBeCloseTo(12.64, 2);
    expect(q.retries).toBe(289);
    expect(rw.readsPerUs).toBeCloseTo(0.925, 3);
  });

  test("50% writes of a 4 KiB record: seqlock writes 3.0/µs, copy-on-write 1.6/µs; seqlock reads retry", () => {
    const q = run("seqlock", { readFrac: 0.5, bytes: 4096 }), c = run("cow", { readFrac: 0.5, bytes: 4096 });
    expect(q.writesPerUs).toBeCloseTo(3.0, 1);
    expect(c.writesPerUs).toBeCloseTo(1.62, 2);
    expect(q.retries).toBe(2_798);
    expect(q.readLatencyNs).toBeGreaterThan(3 * c.readLatencyNs);
  });
});

// ---------------------------------------------------------------- Amdahl and Gustafson

describe("scaling laws", () => {
  test("formulas", () => {
    expect(amdahl(0.1, 8)).toBeCloseTo(4.71, 2);
    expect(amdahl(0.1, 64)).toBeCloseTo(8.77, 2);
    expect(amdahl(0.05, 1e9)).toBeCloseTo(20, 3);
    expect(gustafson(0.1, 64)).toBeCloseTo(57.7, 6);
    // Half of the limit: S = P/2 at P = 1 + 1/s.
    expect(amdahl(0.1, 11)).toBeCloseTo(5.5, 10);
    // The serial share of the one-core time for Gustafson's grown problem.
    expect(0.1 / gustafson(0.1, 64)).toBeCloseTo(0.0017, 4);
    // Karp-Flatt recovers s from an Amdahl speedup.
    for (const p of [2, 8, 64]) expect(karpFlatt(amdahl(0.1, p), p)).toBeCloseTo(0.1, 10);
    expect(uslPeak(0.05, 0.002)).toBeCloseTo(Math.sqrt(0.95 / 0.002), 10);
    expect(usl(0.1, 0, 8)).toBeCloseTo(amdahl(0.1, 8), 10);
    const pts = [1, 2, 4, 8, 16, 32, 64].map((n) => [n, usl(0.03, 0.001, n)] as [number, number]);
    const f = fitUsl(pts);
    expect(f.sigma).toBeCloseTo(0.03, 3);
    expect(f.kappa).toBeCloseTo(0.001, 4);
  });

  test("a serial phase reproduces Amdahl from the simulation", () => {
    for (const c of [2, 8, 64]) {
      expect(measuredSpeedup({ cores: c, serial: 0.1, kind: "phase", scaling: "strong", costs: false })).toBeCloseTo(amdahl(0.1, c), 6);
    }
  });

  test("Karp-Flatt: 0.100 for the phase at every core count, 0.090 for the locked part at 64 cores", () => {
    for (const c of [4, 16, 64]) expect(karpFlatt(measuredSpeedup({ cores: c, serial: 0.1, kind: "phase", scaling: "strong", costs: false }), c)).toBeCloseTo(0.1, 3);
    expect(karpFlatt(measuredSpeedup({ cores: 64, serial: 0.1, kind: "lock", scaling: "strong", costs: false }), 64)).toBeCloseTo(0.090, 3);
  });

  test("weak scaling of a serial phase reproduces Gustafson", () => {
    for (const c of [8, 64]) {
      expect(measuredSpeedup({ cores: c, serial: 0.1, kind: "phase", scaling: "weak", costs: false })).toBeCloseTo(gustafson(0.1, c), 6);
    }
  });

  test("a locked serial part overlaps other threads' work: 7.77 on 8 cores, at most 9.55", () => {
    const sp = (c: number, costs = false) => measuredSpeedup({ cores: c, serial: 0.1, kind: "lock", scaling: "strong", costs });
    expect(sp(8)).toBeCloseTo(7.77, 2);
    expect(sp(16)).toBeCloseTo(9.55, 2);
    expect(sp(64)).toBeCloseTo(9.55, 2);
    // With switch and wake-up costs, the 2 µs critical section becomes a convoy.
    expect(sp(8, true)).toBeCloseTo(2.63, 2);
    expect(sp(64, true)).toBeCloseTo(2.84, 2);
  });

  test("runScale finishes with no deadlock", () => {
    const r = runScale({ cores: 8, serial: 0.1, kind: "lock", scaling: "strong", costs: true, record: true });
    expect(r.done).toBe(true);
    expect(r.mutexes[0]!.acquisitions).toBe(192);
  });

  test("USL benchmark: peak 8.88 at 12 threads, then retrograde; Karp-Flatt e rises", () => {
    const x = USL_THREADS.map((n) => runUsl({ ...USL_DEFAULTS, threads: n }));
    const c = x.map((v) => v / x[0]!);
    const at = (n: number) => c[USL_THREADS.indexOf(n)]!;
    expect(at(12)).toBeCloseTo(8.88, 2);
    expect(Math.max(...c)).toBe(at(12));
    expect(at(16)).toBeCloseTo(8.59, 2);
    expect(at(32)).toBeCloseTo(6.78, 2);
    expect(at(64)).toBeCloseTo(4.77, 2);
    expect(karpFlatt(at(8), 8)).toBeCloseTo(0.017, 3);
    expect(karpFlatt(at(64), 64)).toBeCloseTo(0.197, 3);
    const f = fitUsl(USL_THREADS.map((n, i) => [n, c[i]!] as [number, number]));
    expect(f.sigma).toBeCloseTo(0.0011, 4);
    expect(f.kappa).toBeCloseTo(3.4e-3, 4);
    expect(uslPeak(f.sigma, f.kappa)).toBeCloseTo(17.2, 1);
  });

  test("USL benchmark ceilings: 11.45 with no per-peer cost, 6.79 with 200 ns inside the lock", () => {
    const top = (o: object) => Math.max(...USL_THREADS.map((n) => runUsl({ ...USL_DEFAULTS, ...o, threads: n }))) / runUsl({ ...USL_DEFAULTS, ...o, threads: 1 });
    expect(top({ perPeerNs: 0 })).toBeCloseTo(11.45, 2);
    expect(top({ perPeerNs: 0, lockedNs: 200 })).toBeCloseTo(6.79, 2);
  });
});
