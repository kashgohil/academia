import { describe, expect, test } from "vitest";
import {
  CGROUP_DEFAULTS, CGROUP_EXAMPLE, BALANCE_SWEEP, COST_INPUTS, COST_WORKLOAD, DEMO_MC, EDF_BOUND, FairSim, HISTORY, MC_DEFAULT, MLFQ_MIX, MLFQ_DEFAULT, Multicore, NICE_0_WEIGHT, RM_LIMIT, RT_LINUX,
  LINUX_HZ_CHOICES, SLICE_REQUEST_RANGE, RbTree, SCHED_PRIO_TO_WEIGHT, schedule, balancePoint, cfsDefaults, cgroupShares, compareClassic, cpuShare, edfSchedulable, eevdfBaseSlice, equalJobs, expectedShares, fairStats, gamingRun, hyperperiod, idleWhileReady,
  job, latencyScenario, meanTurnaroundOfOrder, niceToWeight, numaRemoteCost, orderExtremes, permutations, preset, quantumPoint, randomTaskSet, responseIterations, responseTimes, rmAcceptance,
  rmBound, rmSchedulable, rtPreset, rtThrottleShare, runFair, runMulticore, schedPeriod, simulateClassic, simulateInversion, simulateMlfq, simulateRt, sleeperScenario, snapshotAt, starveShare, summarize,
  switchOverhead, traceProblems, tunableFactor, utilization, vruntimeDelta, weightToWmult,
  type ClassicPolicy, type FairTaskSpec, type Job, type PolicySpec, type RtTask,
} from "@/sims/os/scheduling";
import { mulberry32 } from "@/sims/rng";
import { NUMA_DEFAULTS } from "@/sims/numa";

const POLICIES: ClassicPolicy[] = ["fifo", "sjf", "stcf", "rr"];

function randomJobs(rng: () => number, withIo: boolean): Job[] {
  const n = 1 + Math.floor(rng() * 6);
  return Array.from({ length: n }, (_, i) => {
    const burst = 1 + Math.floor(rng() * 40);
    const useIo = withIo && rng() < 0.5;
    return job(i, `J${i}`, Math.floor(rng() * 30), burst, useIo ? { every: 1 + Math.floor(rng() * 10), wait: 1 + Math.floor(rng() * 10) } : undefined);
  });
}

describe("one API for every job-based policy", () => {
  const SPECS: PolicySpec[] = [
    { policy: "fifo" }, { policy: "sjf" }, { policy: "stcf" }, { policy: "rr", quantum: 3 }, { policy: "rr", quantum: 3, switchCost: 0.5 },
    { policy: "mlfq", ...MLFQ_DEFAULT }, { policy: "mlfq", ...MLFQ_DEFAULT, boost: 50, accounting: "slice" },
    { policy: "cfs" }, { policy: "eevdf" },
  ];
  test("no job lost, work conserved, no idle while a job is ready", () => {
    const rng = mulberry32(77);
    for (let i = 0; i < 150; i++) {
      const jobs = randomJobs(rng, true).map((j) => ({ ...j, nice: Math.floor(rng() * 11) - 5 }));
      for (const spec of SPECS) {
        const tr = schedule(jobs, spec);
        expect(traceProblems(tr), `${spec.policy} ${JSON.stringify(jobs)}`).toEqual([]);
        expect(idleWhileReady(tr), spec.policy).toBeLessThan(1e-6);
        const sum = summarize(tr);
        expect(sum.useful).toBeCloseTo(jobs.reduce((a, j) => a + j.burst, 0), 6);
        for (const st of sum.jobs) expect(Number.isFinite(st.finish), spec.policy).toBe(true);
      }
    }
  });
});

describe("classic policies: properties", () => {
  test("no job lost, work conserved, CPU never idle while a job is ready", () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 300; i++) {
      const jobs = randomJobs(rng, true);
      const q = 1 + Math.floor(rng() * 12);
      const c = rng() < 0.5 ? 0 : 0.5;
      for (const policy of POLICIES) {
        const tr = simulateClassic(jobs, { policy, quantum: q, switchCost: c });
        expect(traceProblems(tr), `${policy} ${JSON.stringify(jobs)}`).toEqual([]);
        expect(idleWhileReady(tr), policy).toBeLessThan(1e-6);
      }
    }
  });

  test("SJF is never worse than any non-preemptive order when all jobs arrive together (brute force)", () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 100; i++) {
      const n = 2 + Math.floor(rng() * 5);
      const bursts = Array.from({ length: n }, () => 1 + Math.floor(rng() * 50));
      const jobs = bursts.map((b, k) => job(k, `J${k}`, 0, b));
      const sjf = summarize(simulateClassic(jobs, { policy: "sjf" })).meanTurnaround;
      for (const order of permutations(jobs)) {
        const ordered = order.map((j, k) => ({ ...j, id: k }));
        const fifo = summarize(simulateClassic(ordered, { policy: "fifo" })).meanTurnaround;
        expect(sjf).toBeLessThanOrEqual(fifo + 1e-9);
      }
      expect(sjf).toBeCloseTo(orderExtremes(bursts).best, 9);
    }
  });

  test("STCF is never worse than FIFO, SJF or RR on mean turnaround without I/O", () => {
    const rng = mulberry32(21);
    for (let i = 0; i < 200; i++) {
      const jobs = randomJobs(rng, false);
      const r = compareClassic(jobs, 1 + Math.floor(rng() * 10));
      for (const p of POLICIES) expect(r.stcf.summary.meanTurnaround).toBeLessThanOrEqual(r[p].summary.meanTurnaround + 1e-9);
    }
  });

  test("round-robin response formula for equal jobs", () => {
    for (const [n, q, c] of [[10, 10, 0.1], [5, 1, 0], [20, 3, 0.5], [10, 0.1, 1]] as const) {
      expect(quantumPoint(equalJobs(n, 100), q, c).meanResponse).toBeCloseTo(((n - 1) * (q + c)) / 2, 6);
    }
  });
});

describe("classic policies: quoted numbers", () => {
  test("convoy preset", () => {
    const r = compareClassic(preset("convoy"), 5);
    expect(r.fifo.summary.meanTurnaround).toBeCloseTo(110, 9);
    expect(r.sjf.summary.meanTurnaround).toBeCloseTo(50, 9);
    expect(r.stcf.summary.meanTurnaround).toBeCloseTo(50, 9);
    for (const p of POLICIES) expect(r[p].summary.end).toBe(120);
    // finish times in the explanation
    expect(r.fifo.summary.jobs.map((j) => j.finish)).toEqual([100, 110, 120]);
    expect(r.sjf.summary.jobs.map((j) => j.finish).sort((a, b) => a - b)).toEqual([10, 20, 120]);
  });

  test("late arrivals preset", () => {
    const r = compareClassic(preset("late"), 5);
    expect(r.sjf.summary.meanTurnaround).toBeCloseTo(103.33, 1);
    expect(r.stcf.summary.meanTurnaround).toBeCloseTo(50, 9);
  });

  test("equal jobs preset at quantum 1", () => {
    const r = compareClassic(preset("equal"), 1);
    expect(r.rr.summary.meanResponse).toBeCloseTo(1, 9);
    expect(r.fifo.summary.meanResponse).toBeCloseTo(5, 9);
    expect(r.rr.summary.meanTurnaround).toBeCloseTo(14, 9);
    expect(r.fifo.summary.meanTurnaround).toBeCloseTo(10, 9);
  });

  test("I/O preset", () => {
    const r = compareClassic(preset("io"), 5);
    expect(r.fifo.summary.end).toBe(130);
    expect(r.stcf.summary.end).toBe(100);
    expect(r.stcf.summary.utilization).toBeCloseTo(1, 9);
  });

  test("order demo: 30, 10, 20, 5", () => {
    const e = orderExtremes([30, 10, 20, 5]);
    expect(e.best).toBeCloseTo(30, 9);
    expect(e.worst).toBeCloseTo(51.25, 9);
    expect(permutations([30, 10, 20, 5]).length).toBe(24);
    // A swap changes the mean by the difference in length divided by 4.
    expect(meanTurnaroundOfOrder([30, 10, 20, 5]) - meanTurnaroundOfOrder([10, 30, 20, 5])).toBeCloseTo(20 / 4, 9);
  });

  test("quantum predict: 10 ms to 0.1 ms with a 1 ms switch", () => {
    const jobs = equalJobs(10, 100);
    const a = quantumPoint(jobs, 10, 1), b = quantumPoint(jobs, 0.1, 1);
    expect(a.meanResponse).toBeCloseTo(49.5, 6);
    expect(b.meanResponse).toBeCloseTo(4.95, 6);
    expect(a.throughput).toBeCloseTo(9.1, 1);
    expect(b.throughput).toBeCloseTo(0.91, 2);
    expect(1 - b.useful).toBeCloseTo(0.91, 2);
  });

  test("quantum demo at a 100 us switch", () => {
    const jobs = equalJobs(10, 100);
    const a = quantumPoint(jobs, 10, 0.1);
    expect(a.meanResponse).toBeCloseTo(45.45, 2);
    expect(switchOverhead(10, 0.1)).toBeCloseTo(0.0099, 4);
    expect(quantumPoint(jobs, 1, 0.1).meanTurnaround).toBeCloseTo(1095, 0);
    expect(quantumPoint(jobs, 100, 0.1).meanTurnaround).toBeCloseTo(550, 0);
    // Past the burst length round-robin is FIFO: flat response.
    expect(quantumPoint(jobs, 150, 0.1).meanResponse).toBeCloseTo(quantumPoint(jobs, 100, 0.1).meanResponse, 9);
  });
});

describe("MLFQ", () => {
  test("properties: no job lost, work conserved, no idle while ready, for both rule sets", () => {
    const rng = mulberry32(31);
    for (let i = 0; i < 200; i++) {
      const jobs = randomJobs(rng, true);
      for (const accounting of ["allotment", "slice"] as const) {
        const boost = rng() < 0.5 ? 0 : 20 + Math.floor(rng() * 80);
        const tr = simulateMlfq(jobs, { quantum: [4, 8, 16], allotment: [8, 16, 32], boost, accounting });
        expect(traceProblems(tr), JSON.stringify(jobs)).toEqual([]);
        expect(idleWhileReady(tr)).toBeLessThan(1e-6);
      }
    }
  });

  test("rule 1 and rule 3: a new job preempts at once", () => {
    const tr = simulateMlfq(MLFQ_MIX, MLFQ_DEFAULT);
    const s = summarize(tr).jobs.find((j) => j.name === "Short")!;
    expect(s.response).toBe(0);
    expect(s.turnaround).toBe(16);
  });

  test("the moves that the lesson quotes", () => {
    const tr = simulateMlfq(MLFQ_MIX, MLFQ_DEFAULT);
    const down = tr.moves.filter((m) => m.why === "demote");
    expect(down.filter((m) => m.job === 0).map((m) => [m.t, m.level])).toEqual([[10, 1], [36, 2]]);
    expect(down.find((m) => m.job === 1)).toMatchObject({ t: 56, level: 1 });
    expect(snapshotAt(tr, 60.5).level.get(0)).toBe(2);
    const boosted = simulateMlfq(MLFQ_MIX, { ...MLFQ_DEFAULT, boost: 50 });
    expect(summarize(boosted).jobs.find((j) => j.name === "Short")!.turnaround).toBe(45);
    expect(boosted.boosts[0]).toBe(50);
  });

  test("snapshots: each job is in one place", () => {
    const tr = simulateMlfq(MLFQ_MIX, { ...MLFQ_DEFAULT, boost: 40 });
    for (const s of tr.snapshots) {
      const all = [...s.queues.flat(), ...s.blocked, ...s.done, ...(s.running !== null ? [s.running] : [])];
      expect(new Set(all).size).toBe(all.length);
    }
  });

  test("gaming numbers", () => {
    const old = gamingRun(0.99, "slice"), fix = gamingRun(0.99, "allotment");
    expect(old.gamerShare).toBeCloseTo(0.98, 2);
    expect(fix.gamerShare).toBeCloseTo(0.495, 2);
    expect(old.gamerLevel).toBe(0);
    expect(fix.gamerLevel).toBe(2);
    expect(gamingRun(0.5, "allotment").gamerShare).toBeCloseTo(0.34, 2);
  });

  test("starvation and the boost", () => {
    expect(starveShare("slice", 0)).toBeCloseTo(0.0111, 3);
    expect(starveShare("slice", 100)).toBeCloseTo(0.1, 6);
    expect(starveShare("slice", 50)).toBeCloseTo(0.2, 6);
    expect(starveShare("allotment", 0)).toBeCloseTo(0.4889, 3);
  });

  test("history constants", () => {
    expect(HISTORY.windowsPriorityLevels).toBe(32);
    expect(HISTORY.solarisTsLevels).toBe(60);
    expect(HISTORY.linuxO1Levels).toBe(140);
    expect(HISTORY.ctssYear).toBe(1962);
  });
});

describe("red-black tree", () => {
  test("keeps its invariants, its order and its height bound under random inserts and removes", () => {
    const rng = mulberry32(99);
    interface V { k: number; id: number }
    const t = new RbTree<V>((a, b) => a.k < b.k || (a.k === b.k && a.id < b.id));
    const live: V[] = [];
    let id = 0;
    for (let i = 0; i < 4000; i++) {
      if (live.length === 0 || rng() < 0.55) {
        const v = { k: Math.floor(rng() * 200), id: id++ };
        t.insert(v);
        live.push(v);
      } else {
        const v = live.splice(Math.floor(rng() * live.length), 1)[0]!;
        expect(t.remove(v)).toBe(true);
      }
      if (i % 37 === 0) {
        expect(t.problems()).toEqual([]);
        expect(t.height()).toBeLessThanOrEqual(2 * Math.log2(t.size + 1) + 1e-9);
        const min = live.reduce<V | null>((a, b) => (!a || b.k < a.k || (b.k === a.k && b.id < a.id) ? b : a), null);
        expect(t.min()).toBe(min);
      }
    }
    expect(t.size).toBe(live.length);
  });

  test("layout has one entry per node with valid parents", () => {
    const t = new RbTree<number>((a, b) => a < b);
    [5, 1, 9, 3, 7].forEach((x) => t.insert(x));
    const l = t.layout();
    expect(l.map((n) => n.value)).toEqual([1, 3, 5, 7, 9]);
    expect(l.filter((n) => n.parentX === null).length).toBe(1);
  });
});

describe("CFS weights and tunables", () => {
  test("the weight table", () => {
    expect(SCHED_PRIO_TO_WEIGHT.length).toBe(40);
    expect(niceToWeight(-20)).toBe(88761);
    expect(niceToWeight(0)).toBe(NICE_0_WEIGHT);
    expect(niceToWeight(0)).toBe(1024);
    expect(niceToWeight(1)).toBe(820);
    expect(niceToWeight(5)).toBe(335);
    expect(niceToWeight(19)).toBe(15);
    for (let i = 1; i < 40; i++) {
      const ratio = SCHED_PRIO_TO_WEIGHT[i - 1]! / SCHED_PRIO_TO_WEIGHT[i]!;
      expect(ratio).toBeGreaterThan(1.19);
      expect(ratio).toBeLessThan(1.3);
    }
    expect(Math.pow(88761 / 15, 1 / 39)).toBeCloseTo(1.25, 2);
  });

  test("nice numbers in the text", () => {
    const [a, b] = expectedShares([niceToWeight(0), niceToWeight(1)]) as [number, number];
    expect(a).toBeCloseTo(0.555, 3);
    expect(b).toBeCloseTo(0.445, 3);
    const [c, d] = expectedShares([niceToWeight(0), niceToWeight(5)]) as [number, number];
    expect(c).toBeCloseTo(0.753, 3);
    expect(d).toBeCloseTo(0.247, 3);
    expect(niceToWeight(0) / niceToWeight(5)).toBeCloseTo(3.06, 2);
    expect(niceToWeight(10) / niceToWeight(15)).toBeCloseTo(3.06, 2);
    expect(niceToWeight(-20) / niceToWeight(19)).toBeCloseTo(5917.4, 1);
    expect(weightToWmult(1024)).toBe(4194304);
    expect(vruntimeDelta(1, niceToWeight(5))).toBeCloseTo(3.06, 2);
    const s = expectedShares([1024, 1024, 335]);
    expect(s[0]).toBeCloseTo(0.43, 2);
    expect(s[2]).toBeCloseTo(0.141, 3);
  });

  test("tunables", () => {
    expect(tunableFactor(1)).toBe(1);
    expect(tunableFactor(2)).toBe(2);
    expect(tunableFactor(8)).toBe(4);
    expect(tunableFactor(128)).toBe(4);
    expect(cfsDefaults(1)).toMatchObject({ latency: 6, minGranularity: 0.75, wakeupGranularity: 1 });
    expect(cfsDefaults(8)).toMatchObject({ latency: 24, minGranularity: 3, wakeupGranularity: 4 });
    expect(eevdfBaseSlice(1)).toBe(0.75);
    expect(eevdfBaseSlice(8)).toBe(3);
    const t = cfsDefaults(8);
    expect(LINUX_HZ_CHOICES).toEqual([100, 250, 1000]);
    expect(SLICE_REQUEST_RANGE).toEqual({ min: 0.1, max: 100 });
    expect(schedPeriod(t, 8)).toBe(24);
    expect(schedPeriod(t, 9)).toBe(27);
    expect(schedPeriod(t, 16)).toBe(48);
    expect(t.latency / t.minGranularity).toBe(8);
  });
});

const randomFair = (rng: () => number): FairTaskSpec[] => {
  const n = 2 + Math.floor(rng() * 6);
  return Array.from({ length: n }, (_, i) => ({ name: `T${i}`, nice: Math.floor(rng() * 21) - 10 }));
};

describe("CFS and EEVDF: properties", () => {
  test("CFS shares converge to weights: within 1 percentage point after 20 s", () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 40; i++) {
      const tasks = randomFair(rng);
      const sim = runFair("cfs", tasks, 20000);
      const want = expectedShares(tasks.map((t) => niceToWeight(t.nice!)));
      sim.shares().forEach((s, k) => expect(Math.abs(s - want[k]!), JSON.stringify(tasks)).toBeLessThan(0.01));
    }
  });

  test("EEVDF shares converge to weights: within 1 percentage point after 20 s, for any slice", () => {
    const rng = mulberry32(4);
    for (let i = 0; i < 40; i++) {
      const tasks = randomFair(rng).map((t) => ({ ...t, slice: 0.5 + Math.floor(rng() * 10) * 0.5 }));
      const sim = runFair("eevdf", tasks, 20000);
      const want = expectedShares(tasks.map((t) => niceToWeight(t.nice!)));
      sim.shares().forEach((s, k) => expect(Math.abs(s - want[k]!), JSON.stringify(tasks)).toBeLessThan(0.01));
    }
  });

  test("the tree holds exactly the waiting tasks, and the CPU is never idle while tasks wait", () => {
    const sim = new FairSim({ policy: "cfs" });
    for (const nice of [0, 0, 5, -3]) sim.add({ name: `n${nice}`, nice, run: 10, sleep: 5 });
    for (let i = 0; i < 2000; i++) {
      sim.advance(0.37);
      const queued = sim.entities.filter((e) => e.state === "queued");
      expect(sim.tree.size).toBe(queued.length);
      expect(sim.tree.problems()).toEqual([]);
      if (sim.curr) expect(sim.tree.inorder()).not.toContain(sim.curr);
    }
    const run = sim.slices.reduce((a, s) => a + s.end - s.start, 0);
    expect(run).toBeCloseTo(sim.entities.reduce((a, e) => a + e.sumExec, 0), 6);
  });

  test("EEVDF: the weighted lags sum to zero, and an eligible task always exists", () => {
    const sim = new FairSim({ policy: "eevdf" });
    sim.add({ name: "a", slice: 1 });
    sim.add({ name: "b", slice: 3 });
    sim.add({ name: "c", slice: 3, nice: 5 });
    sim.add({ name: "d", slice: 6, nice: -3 });
    for (let i = 0; i < 4000; i++) {
      sim.advance(0.5);
      const run = sim.runnable();
      const lag = run.reduce((a, e) => a + e.weight * sim.lag(e), 0);
      expect(Math.abs(lag)).toBeLessThan(1e-3);
      expect(run.some((e) => sim.eligible(e))).toBe(true);
    }
  });

  test("work is conserved: CPU time equals elapsed time while a task is always runnable", () => {
    for (const policy of ["cfs", "eevdf"] as const) {
      const sim = runFair(policy, [{ name: "a" }, { name: "b", nice: 3 }], 1000);
      expect(sim.entities.reduce((a, e) => a + e.sumExec, 0)).toBeCloseTo(1000, 6);
    }
  });

  test("a removed task leaves no trace in the queue", () => {
    const sim = runFair("cfs", [{ name: "a" }, { name: "b" }, { name: "c" }], 100);
    sim.remove(1);
    sim.advance(100);
    expect(sim.runnable().length).toBe(2);
    expect(sim.tree.size + (sim.curr ? 1 : 0)).toBe(2);
  });
});

describe("CFS and EEVDF: quoted numbers", () => {
  test("CFS simulator default: 5 s error below 0.2 percentage points", () => {
    const tasks = [{ name: "A", nice: 0 }, { name: "B", nice: 0 }, { name: "C", nice: 5 }];
    const sim = runFair("cfs", tasks, 5000);
    const want = expectedShares([1024, 1024, 335]);
    sim.shares().forEach((s, i) => expect(Math.abs(s - want[i]!)).toBeLessThan(0.002));
  });

  test("sleeper: 204 ms without the limit, 3 ms with it", () => {
    expect(sleeperScenario(false).longestRun).toBeCloseTo(204, 0);
    expect(sleeperScenario(true).longestRun).toBeCloseTo(3, 6);
    // The credit has a fixed limit: the sleep time does not change it.
    expect(sleeperScenario(true, 100).longestRun).toBeCloseTo(3, 6);
    expect(sleeperScenario(true, 300).longestRun).toBeCloseTo(3, 6);
  });

  test("L with a 1 ms slice: same share, wait 18 ms against 3 ms", () => {
    const r = latencyScenario({ hogs: 3, latencySlice: 1, mode: "steady" });
    const c = fairStats(r.cfs)[0]!, e = fairStats(r.eevdf)[0]!;
    expect(c.maxWait).toBeCloseTo(18, 6);
    expect(e.maxWait).toBeCloseTo(3, 6);
    expect(Math.abs(c.share - 0.25)).toBeLessThan(0.01);
    expect(Math.abs(e.share - 0.25)).toBeLessThan(0.01);
  });

  test("L with a 3 ms slice is like a hog: 9 ms", () => {
    const e = fairStats(latencyScenario({ hogs: 3, latencySlice: 3, mode: "steady" }).eevdf)[0]!;
    expect(e.maxWait).toBeCloseTo(9, 6);
  });

  test("periodic L: CFS wakes it at once, EEVDF has a mean wait of 3 ms, delayed dequeue 2 ms", () => {
    const a = latencyScenario({ hogs: 3, latencySlice: 1, mode: "periodic" });
    expect(fairStats(a.cfs)[0]!.meanWait).toBe(0);
    expect(fairStats(a.eevdf)[0]!.meanWait).toBeCloseTo(3, 1);
    const b = latencyScenario({ hogs: 3, latencySlice: 1, mode: "periodic", delayedDequeue: true });
    expect(fairStats(b.eevdf)[0]!.meanWait).toBeCloseTo(2, 1);
  });

  test("cgroup example: 50% and 5.6%", () => {
    const s = cgroupShares(CGROUP_EXAMPLE(9));
    expect(s.get("a0")).toBeCloseTo(0.5, 9);
    expect(s.get("b0")).toBeCloseTo(1 / 18, 9);
    expect(1 / 18).toBeCloseTo(0.056, 3);
    expect([...s.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(CGROUP_DEFAULTS).toEqual({ cpuWeight: 100, cpuShares: 1024 });
  });
});

const integerSet = (rng: () => number): RtTask[] => {
  const periods = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20];
  const n = 1 + Math.floor(rng() * 4);
  return Array.from({ length: n }, (_, i) => {
    const t = periods[Math.floor(rng() * periods.length)]!;
    return { id: i, name: `T${i}`, c: 1 + Math.floor(rng() * Math.max(1, t / 2)), t };
  });
};

describe("real-time: properties", () => {
  test("EDF meets all deadlines when U <= 1 on implicit deadlines", () => {
    const rng = mulberry32(8);
    let checked = 0;
    for (let i = 0; i < 2000; i++) {
      const ts = integerSet(rng);
      if (utilization(ts) > 1) continue;
      checked++;
      expect(simulateRt(ts, "edf", hyperperiod(ts)).misses, JSON.stringify(ts)).toEqual([]);
    }
    expect(checked).toBeGreaterThan(200);
  });

  test("EDF misses a deadline in the first hyperperiods when U > 1", () => {
    const rng = mulberry32(9);
    let checked = 0;
    for (let i = 0; i < 1000 && checked < 100; i++) {
      const ts = integerSet(rng);
      if (utilization(ts) <= 1 + 1e-9) continue;
      checked++;
      expect(simulateRt(ts, "edf", hyperperiod(ts) * 2).misses.length).toBeGreaterThan(0);
      expect(edfSchedulable(ts)).toBe(false);
    }
  });

  test("the exact RM test agrees with simulation over one hyperperiod", () => {
    const rng = mulberry32(13);
    let yes = 0, no = 0;
    for (let i = 0; i < 1500; i++) {
      const ts = integerSet(rng);
      const ok = rmSchedulable(ts);
      const misses = simulateRt(ts, "rm", hyperperiod(ts)).misses.length;
      expect(misses === 0, JSON.stringify(ts)).toBe(ok);
      if (ok) yes++; else no++;
    }
    expect(yes).toBeGreaterThan(100);
    expect(no).toBeGreaterThan(100);
  });

  test("the RM utilization bound is sufficient", () => {
    const rng = mulberry32(17);
    for (let i = 0; i < 1000; i++) {
      const n = 1 + Math.floor(rng() * 8);
      const ts = randomTaskSet(n, rmBound(n) * (0.5 + 0.5 * rng()), rng);
      expect(rmSchedulable(ts), JSON.stringify(ts)).toBe(true);
    }
  });

  test("work: each job gets exactly C, and no two tasks run at once", () => {
    const rng = mulberry32(19);
    for (let i = 0; i < 200; i++) {
      const ts = integerSet(rng);
      if (utilization(ts) > 1) continue;
      for (const policy of ["rm", "edf"] as const) {
        const h = hyperperiod(ts);
        const r = simulateRt(ts, policy, h);
        const slices = [...r.trace.slices].sort((a, b) => a.start - b.start);
        for (let k = 1; k < slices.length; k++) expect(slices[k]!.start).toBeGreaterThanOrEqual(slices[k - 1]!.end - 1e-9);
        for (const x of ts) {
          const ran = r.trace.slices.filter((s) => s.job === x.id).reduce((a, s) => a + s.end - s.start, 0);
          if (r.misses.length === 0) expect(ran).toBeCloseTo((x.c * h) / x.t, 6);
        }
      }
    }
  });
});

describe("real-time: quoted numbers", () => {
  test("RM bound table", () => {
    const want: [number, number][] = [[1, 1], [2, 0.828], [3, 0.78], [4, 0.757], [5, 0.743], [10, 0.718]];
    for (const [n, b] of want) expect(rmBound(n)).toBeCloseTo(b, 3);
    expect(RM_LIMIT).toBeCloseTo(0.693, 3);
    expect(rmBound(100000)).toBeCloseTo(RM_LIMIT, 4);
    expect(EDF_BOUND).toBe(1);
  });

  test("default set: (2,5) and (4,7)", () => {
    const ts = rtPreset("gap");
    expect(utilization(ts)).toBeCloseTo(0.97, 2);
    expect(hyperperiod(ts)).toBe(35);
    const rm = simulateRt(ts, "rm", 35), edf = simulateRt(ts, "edf", 35);
    expect(rm.misses.length).toBe(1);
    expect(rm.misses[0]).toMatchObject({ task: 1, deadline: 7 });
    expect(rm.preemptions).toBe(5);
    expect(edf.misses.length).toBe(0);
    expect(edf.preemptions).toBe(1);
    expect(responseIterations(ts, 1)).toEqual([4, 6, 8, 8]);
    expect(responseTimes(ts).map((x) => x.r)).toEqual([2, Infinity]);
    expect(rmSchedulable(ts)).toBe(false);
    expect(edfSchedulable(ts)).toBe(true);
  });

  test("under the bound", () => {
    const ts = rtPreset("under");
    expect(utilization(ts)).toBeCloseTo(0.71, 2);
    expect(rmBound(3)).toBeCloseTo(0.78, 2);
    expect(simulateRt(ts, "rm", hyperperiod(ts)).misses.length).toBe(0);
    expect(simulateRt(ts, "edf", hyperperiod(ts)).misses.length).toBe(0);
  });

  test("harmonic at U = 1", () => {
    const ts = rtPreset("harmonic");
    expect(utilization(ts)).toBeCloseTo(1, 9);
    expect(simulateRt(ts, "rm", hyperperiod(ts)).misses.length).toBe(0);
  });

  test("overload: RM keeps T1 safe, EDF misses in all tasks", () => {
    const ts = rtPreset("over");
    expect(utilization(ts)).toBeCloseTo(1.25, 2);
    const h = hyperperiod(ts);
    const rm = simulateRt(ts, "rm", h), edf = simulateRt(ts, "edf", h);
    expect(rm.misses.length).toBe(80);
    expect(edf.misses.length).toBe(139);
    expect(new Set(rm.misses.map((m) => m.task))).toEqual(new Set([1, 2]));
    expect(new Set(edf.misses.map((m) => m.task))).toEqual(new Set([0, 1, 2]));
  });

  test("RM acceptance for 5 tasks, as in the demo", () => {
    expect(rmAcceptance(5, 0.8, 300, 1)).toBe(1);
    expect(rmAcceptance(5, 0.9, 300, 1)).toBeCloseTo(0.91, 2);
    expect(rmAcceptance(5, 0.96, 300, 1)).toBeCloseTo(0.48, 2);
    expect(rmAcceptance(5, 1, 300, 1)).toBe(0);
    expect(rmBound(5)).toBeLessThan(0.8);
  });

  test("Linux constants", () => {
    expect(rtThrottleShare()).toBeCloseTo(0.95, 9);
    expect(RT_LINUX.rtRuntimeUs).toBe(950000);
    expect(RT_LINUX.rtPeriodUs).toBe(1000000);
    expect(RT_LINUX.rrTimesliceMs).toBe(100);
    expect(RT_LINUX.maxRtPrio).toBe(99);
  });

  test("priority inversion: blocked time grows with M unless inheritance is on", () => {
    for (const m of [1, 4, 8, 20]) {
      expect(simulateInversion({ inherit: false, mediumWork: m }).blocked).toBe(2 + m);
      expect(simulateInversion({ inherit: true, mediumWork: m }).blocked).toBe(2);
    }
    const on = simulateInversion({ inherit: true, mediumWork: 8 });
    expect(on.frames.some((f) => f.prio[2] === 3)).toBe(true);
    const off = simulateInversion({ inherit: false, mediumWork: 8 });
    expect(off.frames.every((f) => f.prio[2] === 1)).toBe(true);
    // Every task finishes in both cases, and H only runs its own work.
    expect(on.finish.every((f) => f > 0)).toBe(true);
    expect(off.finish.every((f) => f > 0)).toBe(true);
    expect(on.frames.filter((f) => f.running === 0).length).toBe(3);
  });
});

describe("multicore", () => {
  test("no task lost and CPU time adds up, for every mode", () => {
    const rng = mulberry32(23);
    for (let i = 0; i < 40; i++) {
      const cfg = {
        ...MC_DEFAULT, cpus: 2 + Math.floor(rng() * 8), nodes: rng() < 0.5 ? 1 : 2, tasks: 1 + Math.floor(rng() * 30),
        queue: (rng() < 0.3 ? "single" : "per-cpu") as "single" | "per-cpu", placement: (rng() < 0.5 ? "pile" : "spread") as "pile" | "spread",
        balanceInterval: rng() < 0.3 ? 0 : 1 + Math.floor(rng() * 50), threshold: 1 + Math.floor(rng() * 3), steal: rng() < 0.5, domains: rng() < 0.5,
        wakeAffine: rng() < 0.3 ? 0.1 : 0, cacheRefill: rng(), numaPenalty: rng() * 2, lockCost: 0.01, seed: i,
      };
      const m = new Multicore(cfg);
      for (let t = 0; t < 400; t++) {
        m.tick();
        if (t % 50 === 0 && rng() < 0.3) m.pile();
        expect(m.problems(), JSON.stringify(cfg)).toEqual([]);
      }
    }
  });

  test("recorded trace: no CPU runs two things, no task runs on two CPUs", () => {
    const m = new Multicore({ ...COST_WORKLOAD, cacheRefill: 1, numaPenalty: 2 }, { record: true });
    for (let t = 0; t < 1000; t++) m.tick();
    const tr = m.trace();
    for (let c = 0; c < tr.cpus; c++) {
      const row = tr.slices.filter((x) => x.cpu === c).sort((a, b) => a.start - b.start);
      for (let i = 1; i < row.length; i++) expect(row[i]!.start).toBeGreaterThanOrEqual(row[i - 1]!.end - 1e-6);
    }
    for (const j of tr.jobs) {
      const row = tr.slices.filter((x) => x.job === j.id).sort((a, b) => a.start - b.start);
      for (let i = 1; i < row.length; i++) expect(row[i]!.start).toBeGreaterThanOrEqual(row[i - 1]!.end - 1e-6);
    }
    const useful = tr.slices.filter((x) => x.kind === "run").reduce((a, x) => a + x.end - x.start, 0);
    expect(useful).toBeCloseTo(m.stats.useful, 6);
  });

  test("the numbers of the demo: 8 CPUs, 16 tasks", () => {
    const base = DEMO_MC;
    const off = runMulticore(base);
    expect(off.useful).toBeCloseTo(0.125, 3);
    expect(off.idle).toBeCloseTo(0.875, 3);
    expect(off.migrationsPerSec).toBe(0);
    const bal = runMulticore({ ...base, balanceInterval: 16 });
    expect(bal.useful).toBeCloseTo(0.918, 3);
    const steal = runMulticore({ ...base, steal: true });
    expect(steal.useful).toBeCloseTo(0.983, 3);
    expect(steal.penalty).toBeCloseTo(0.015, 3);
    expect(Math.round(steal.migrationsPerSec)).toBe(208);
    const single = runMulticore({ ...base, queue: "single" });
    expect(single.penalty).toBeCloseTo(0.075, 3);
    expect(Math.round(single.migrationsPerSec)).toBe(892);
    expect(single.meanImbalance).toBeLessThan(0.1);
  });

  test("NUMA input comes from numa.ts: 60% speed, so 10 ms costs 4 ms", () => {
    expect(NUMA_DEFAULTS.latLocal).toBe(90);
    expect(NUMA_DEFAULTS.latRemote).toBe(150);
    expect(NUMA_DEFAULTS.latLocal / NUMA_DEFAULTS.latRemote).toBeCloseTo(0.6, 9);
    expect(numaRemoteCost(COST_INPUTS.remoteMs)).toBeCloseTo(4, 9);
    expect(COST_INPUTS.refill).toBe(1);
    expect(COST_WORKLOAD.wakeAffine).toBe(0.05);
  });

  test("the cost plot: free moves favor short periods, costly moves have a peak at 16 ms", () => {
    const free = { ...COST_WORKLOAD };
    const red = { ...COST_WORKLOAD, cacheRefill: COST_INPUTS.refill, numaPenalty: numaRemoteCost(COST_INPUTS.remoteMs) };
    const freeCurve = BALANCE_SWEEP.map((iv) => balancePoint(free, iv).useful);
    const redCurve = BALANCE_SWEEP.map((iv) => balancePoint(red, iv).useful);
    expect(freeCurve.indexOf(Math.max(...freeCurve))).toBe(0);
    const bestAt = BALANCE_SWEEP[redCurve.indexOf(Math.max(...redCurve))];
    expect(bestAt).toBe(16);
    expect(redCurve[0]!).toBeCloseTo(0.7, 2);
    expect(Math.max(...redCurve)).toBeCloseTo(0.78, 2);
    expect(redCurve[BALANCE_SWEEP.length - 1]!).toBeCloseTo(0.29, 2);
    expect(redCurve[0]!).toBeLessThan(Math.max(...redCurve) - 0.05);
  });

  test("domains: few cross-node moves, and the red curve moves up at short periods", () => {
    const red = { ...COST_WORKLOAD, cacheRefill: COST_INPUTS.refill, numaPenalty: numaRemoteCost(COST_INPUTS.remoteMs) };
    const flat = balancePoint(red, 1), dom = balancePoint({ ...red, domains: true }, 1);
    expect(flat.crossNodePerSec / dom.crossNodePerSec).toBeGreaterThan(3);
    expect(flat.crossNodePerSec / dom.crossNodePerSec).toBeLessThan(5);
    expect(dom.useful).toBeGreaterThan(flat.useful + 0.05);
    const orange = balancePoint({ ...red, numaPenalty: 0 }, 1);
    expect(Math.abs(dom.useful - orange.useful)).toBeLessThan(0.05);
  });

  test("domains still spread a pile across nodes", () => {
    const r = runMulticore({ ...DEMO_MC, balanceInterval: 16, domains: true });
    expect(r.useful).toBeGreaterThan(0.7);
  });

  test("zero costs: the three curves are the same", () => {
    const a = balancePoint({ ...COST_WORKLOAD, cacheRefill: 0, numaPenalty: 0 }, 8);
    const b = balancePoint({ ...COST_WORKLOAD, cacheRefill: 0, numaPenalty: numaRemoteCost(0) }, 8);
    expect(a.useful).toBe(b.useful);
  });

  test("cpuShare helper", () => {
    const tr = simulateClassic(equalJobs(2, 10), { policy: "rr", quantum: 1 });
    expect(cpuShare(tr, 0, 0, 20)).toBeCloseTo(0.5, 9);
  });
});
