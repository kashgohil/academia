/** Tests for src/sims/sys/gc: the collectors are correct on the shared graph model, and every number the gc lessons quote is pinned. */
import { describe, expect, test } from "vitest";
import {
  CHENEY_GRAPH, COST_DEFAULTS, CYCLE_DEFAULTS, GCTRACE, GEN_DEFAULTS, HEAP_SCENARIO, MS_GRAPH, RC_BENCH, RC_PRESETS, STACK_SCENARIO,
  apply, barrierTrials, build, cardFrames, cheney, copyOrder, copyWinsAbove, dangling, freeStats, garbage, genSim, goCycle, heapGoal, idOf, layoutFor,
  list, lruMisses, markSweep, nameOf, parseTrace, rcBench, rcInit, rcLeaked, rcStore, reachable, runSchedule, stackScan, toMachine, tracingCost,
  tree, trialDeletion, trialPreset, verdict, walkUpdates, without, type Barrier,
} from "../../src/sims/sys/gc";

const preset = (id: string) => RC_PRESETS.find((p) => p.id === id)!.g;
const names = (g: Parameters<typeof nameOf>[0], ids: number[]) => ids.map((i) => nameOf(g, i)).sort();

describe("the graph model", () => {
  test("reachability, garbage and dangling pointers", () => {
    const g = build({ A: ["B", null], B: [null, null], C: ["A", null] }, { r: "A" });
    expect([...reachable(g)].sort()).toEqual([1, 2]);
    expect(garbage(g)).toEqual([3]);
    const g2 = apply(apply(g, { op: "new", name: "D", root: "x" }), { op: "write", obj: "D", field: 0, to: "B" });
    expect(reachable(g2).has(idOf(g2, "D"))).toBe(true);
    expect(dangling(without(g2, [2])).map((e) => e.from)).toEqual([1, idOf(g2, "D")]);
  });
  test("the shared machine's LeakSanitizer reports an unreachable cycle", () => {
    const { m } = toMachine(build({ A: ["B", null], B: ["A", null] }, { r: null }), { exit: true });
    expect(m.ub.map((u) => u.kind)).toEqual(["memory-leak", "memory-leak"]);
    const ok = toMachine(build({ A: ["B", null], B: ["A", null] }, { r: "A" }), { exit: true }).m;
    expect(ok.ub).toEqual([]);
  });
});

describe("reference counting", () => {
  test("a list frees in a cascade when its root goes", () => {
    const r = rcStore(rcInit(preset("list")), { root: "r" }, null);
    expect(r.state.freed.length).toBe(3);
    expect(Math.max(...r.events.map((e) => e.depth))).toBe(2);
  });
  test("a shared child reaches zero only when its second parent goes", () => {
    const s = rcInit(preset("dag"));
    expect(s.rc[idOf(preset("dag"), "D")]).toBe(2);
    expect(rcStore(s, { root: "r" }, null).state.freed.length).toBe(4);
  });
  test("a doubly linked list and a ring leak all their nodes", () => {
    for (const id of ["dlist", "ring"]) {
      const r = rcStore(rcInit(preset(id)), { root: "r" }, null);
      expect(r.state.freed.length).toBe(0);
      expect(rcLeaked(r.state).length).toBe(3);
    }
    expect(rcInit(preset("dlist")).rc[1]).toBe(2);
  });
  test("increment before decrement: x = x frees nothing", () => {
    const s = rcInit(preset("list"));
    expect(rcStore(s, { root: "r" }, 1).state.freed).toEqual([]);
  });
  test("trial deletion frees the garbage cycle and keeps the held one", () => {
    const { state } = trialPreset();
    expect(names(state.g, state.purple)).toEqual(["A", "C"]);
    const fr = trialDeletion(state);
    expect(fr.length).toBe(21);
    const last = fr[fr.length - 1]!;
    expect(names(state.g, last.freed)).toEqual(["C", "D", "E"]);
    expect(last.rc).toEqual({ 1: 2, 2: 1 });
    expect(fr.some((f) => f.rc[2] === 0 && f.color[2] === "gray")).toBe(true);
  });
  test("measured count costs (medians of three runs)", () => {
    expect(rcBench(1)).toEqual({ rc: 2.61, shared: 3.82, own: 3.82 });
    expect(rcBench(2).shared).toBe(17.32);
    expect(rcBench(8)).toEqual({ rc: 2.61, shared: 380.07, own: 3.86 });
    expect((rcBench(8).shared / rcBench(8).own).toFixed(1)).toBe("98.5");
    expect(Math.min(...RC_BENCH.arcShared[8]!)).toBe(106.76);
    expect(walkUpdates(1_000_000, true)).toBe(2_000_000);
    expect(walkUpdates(1_000_000, false)).toBe(0);
  });
});

describe("mark and sweep", () => {
  const fr = markSweep(MS_GRAPH);
  const last = fr[fr.length - 1]!;
  test("frees exactly the garbage, cycles included", () => {
    expect(names(MS_GRAPH, last.freed)).toEqual(names(MS_GRAPH, garbage(MS_GRAPH)));
    expect(names(MS_GRAPH, last.freed)).toEqual(["G1", "G2", "G3", "G4", "G5"]);
  });
  test("work and fragmentation", () => {
    expect(last.work).toEqual({ scanned: 5, fields: 10, swept: 10 });
    const s = freeStats(last.free);
    expect(s).toMatchObject({ total: 208, largest: 96, runs: 3 });
    expect(s.frag.toFixed(2)).toBe("0.54");
    expect(fr.length).toBe(20);
  });
  test("precise vs conservative root finding on the shared machine", () => {
    const p = stackScan("base", "precise");
    expect(p.freed).toEqual(["D", "E"]);
    expect(p.wordsScanned).toBe(3);
    const c = stackScan("base", "conservative");
    expect(c.falseRetained).toEqual(["D", "E"]);
    expect(c.wordsScanned).toBe(16);
    expect(c.snap.heap.filter((b) => b.state === "freed")).toEqual([]);
    expect(stackScan("small", "conservative").falseRetained).toEqual([]);
    // as in bdwgc, a stack word that points inside a block always counts; the heap rule does not change that
    expect(stackScan("interior", "conservative", true).falseRetained).toEqual(["D", "E"]);
    expect(stackScan("interior", "conservative", false).falseRetained).toEqual(["D", "E"]);
    expect(stackScan("interior", "precise").falseRetained).toEqual([]);
  });
  test("the cost model (model inputs: 1 ns mark, 0.1 ns sweep)", () => {
    const c = tracingCost(COST_DEFAULTS);
    expect(c.ms.perByte).toBeCloseTo(0.65, 10);
    expect(c.ms.gcsPerGiB).toBeCloseTo(5.12, 10);
    expect(Math.round(c.ms.pauseMs)).toBe(136);
    expect(Math.round(c.ms.markOnlyMs)).toBe(105);
    expect(tracingCost({ ...COST_DEFAULTS, heap: 110 }).ms.perByte).toBeCloseTo(11.1, 10);
    expect(tracingCost({ ...COST_DEFAULTS, heap: 200 }).ms.perByte).toBeCloseTo(1.2, 10);
    expect(Math.round(tracingCost({ ...COST_DEFAULTS, live: 200, heap: 600 }).ms.pauseMs)).toBe(273);
    expect(freeStats(last.free).runs).toBe(3);
    expect(last.free.map((r) => r.size)).toEqual([32, 80, 96]);
  });
});

describe("copying", () => {
  const fr = cheney(CHENEY_GRAPH);
  test("Cheney copies breadth first and never touches garbage", () => {
    const last = fr[fr.length - 1]!;
    expect(last.copied.map((c) => nameOf(CHENEY_GRAPH, c.id))).toEqual(["A", "E", "B", "C", "D"]);
    expect(last.bytesCopied).toBe(176);
    expect(last.copied.map((c) => c.id)).toEqual(copyOrder(CHENEY_GRAPH, "bfs"));
    expect(Object.values(last.updated).every((u) => u.every(Boolean))).toBe(true);
    expect(fr.length).toBe(14);
  });
  test("locality of copy orders (misses in a 4-line LRU cache)", () => {
    const t = tree(31), l = list(32);
    const miss = (g: ReturnType<typeof tree>, walk: "dfs" | "bfs") => (["scattered", "bfs", "dfs"] as const).map((k) => lruMisses(copyOrder(g, walk), layoutFor(g, k)));
    expect(miss(t, "dfs")).toEqual([30, 21, 16]);
    expect(miss(t, "bfs")).toEqual([29, 16, 24]);
    expect(miss(l, "dfs")).toEqual([31, 16, 16]);
  });
  test("space-time: copying needs H > 2L and wins only with much room", () => {
    const c = tracingCost(COST_DEFAULTS);
    expect(c.copy.perByte).toBeCloseTo(4, 10);
    expect(tracingCost({ ...COST_DEFAULTS, heap: 200 }).copy.perByte).toBe(Infinity);
    expect(copyWinsAbove({ live: 100, markNs: 1, sweepNs: 0.1, copyNs: 2 }).toFixed(1)).toBe("31.4");
    expect(copyWinsAbove({ live: 100, markNs: 1, sweepNs: 0.5, copyNs: 2 }).toFixed(1)).toBe("7.5");
    expect(copyWinsAbove({ live: 100, markNs: 1, sweepNs: 0.1, copyNs: 1 }).toFixed(1)).toBe("12.0");
  });
});

describe("generational", () => {
  test("the default lifetime model", () => {
    const r = genSim(GEN_DEFAULTS);
    expect(r.minors).toBe(64);
    expect((r.survival * 100).toFixed(1)).toBe("7.9");
    expect(r.majors).toBe(6);
    expect((r.genWork / 2 ** 20).toFixed(2)).toBe("4.55");
    expect((r.full.work / 2 ** 20).toFixed(2)).toBe("11.04");
    expect(r.full.gcs).toBe(34);
    expect(Math.round(r.maxMinor / 1024)).toBe(45);
    expect(Math.round(r.maxMajor / 1024)).toBe(410);
    expect(Math.round(r.full.maxPause / 1024)).toBe(414);
  });
  test("when half the objects live long, generational does more work", () => {
    const r = genSim({ ...GEN_DEFAULTS, young: 0.5 });
    expect((r.genWork / 2 ** 20).toFixed(1)).toBe("33.9");
    expect((r.full.work / 2 ** 20).toFixed(1)).toBe("20.9");
    expect((r.survival * 100).toFixed(0)).toBe("50");
  });
  test("card marking keeps the young object alive; no barrier loses it", () => {
    const bad = cardFrames(false), good = cardFrames(true);
    const b = bad[bad.length - 1]!, g = good[good.length - 1]!;
    expect(b.freed).toEqual(["Y3"]);
    expect(b.dangling).toEqual(["O5"]);
    expect(g.freed).toEqual([]);
    expect(g.scanned).toEqual(["O4", "O5"]);
    expect(good.find((f) => f.phase === "barrier")!.dirty).toEqual([2]);
  });
});

describe("concurrent marking and barriers", () => {
  const barriers: Barrier[] = ["none", "dijkstra", "yuasa", "hybrid"];
  test("the heap scenario loses C with no barrier only", () => {
    for (const b of barriers) expect(verdict(runSchedule(HEAP_SCENARIO, b, "ccmm")).lost).toEqual(b === "none" ? ["C"] : []);
  });
  test("the stack scenario: Dijkstra needs the stack rescan", () => {
    expect(verdict(runSchedule(STACK_SCENARIO, "none", "cmm")).lost).toEqual(["C"]);
    expect(verdict(runSchedule(STACK_SCENARIO, "dijkstra", "cmm", false)).lost).toEqual(["C"]);
    expect(verdict(runSchedule(STACK_SCENARIO, "dijkstra", "cmm", true)).lost).toEqual([]);
    expect(verdict(runSchedule(STACK_SCENARIO, "yuasa", "cmm")).lost).toEqual([]);
    expect(verdict(runSchedule(STACK_SCENARIO, "hybrid", "cmm")).lost).toEqual([]);
  });
  test("a schedule with marking first loses nothing", () => {
    expect(verdict(runSchedule(HEAP_SCENARIO, "none", "cccccmm")).lost).toEqual([]);
  });
  test("1000 random runs per barrier (mutator share 70%)", () => {
    const r = (b: Barrier, rescan = false) => barrierTrials(b, 1000, 1, rescan, { pm: 0.7 });
    const none = r("none"), d0 = r("dijkstra"), d1 = r("dijkstra", true), y = r("yuasa"), h = r("hybrid");
    expect([none.lostRuns, d0.lostRuns, d1.lostRuns, y.lostRuns, h.lostRuns]).toEqual([10, 7, 0, 0, 0]);
    expect([none, d1, y].map((x) => (x.floating / 1000).toFixed(2))).toEqual(["1.15", "1.24", "1.77"]);
    expect([d1, y].map((x) => (x.shades / 1000).toFixed(2))).toEqual(["0.43", "0.80"]);
    expect(h.floating).toBe(y.floating);
  }, 60_000);
});

describe("Go", () => {
  test("heap goal (gc guide formula, 4 MiB minimum scaled by GOGC)", () => {
    expect(heapGoal({ live: 100, roots: 2, gogc: 100, limit: null, nonHeap: 0 })).toEqual({ goal: 202, by: "gogc" });
    expect(heapGoal({ live: 1, roots: 0, gogc: 100, limit: null, nonHeap: 0 })).toEqual({ goal: 4, by: "minimum" });
    expect(heapGoal({ live: 0.5, roots: 0, gogc: 50, limit: null, nonHeap: 0 })).toEqual({ goal: 2, by: "minimum" });
    expect(heapGoal({ live: 100, roots: 2, gogc: null, limit: null, nonHeap: 0 }).goal).toBe(Infinity);
    expect(heapGoal({ live: 100, roots: 2, gogc: null, limit: 150, nonHeap: 20 })).toEqual({ goal: 130, by: "limit" });
  });
  test("steady-state pacing model (model inputs)", () => {
    const c = goCycle(CYCLE_DEFAULTS);
    expect(c.cyclesPerSec.toFixed(1)).toBe("4.9");
    expect((c.share * 100).toFixed(1)).toBe("6.3");
    expect(c.total).toBe(222);
    const c2 = goCycle({ ...CYCLE_DEFAULTS, gogc: 200 });
    expect(c2.cyclesPerSec.toFixed(2)).toBe("2.45");
    expect((c2.share * 100).toFixed(1)).toBe("3.1");
    expect(c2.total).toBe(324);
    const lim = goCycle({ ...CYCLE_DEFAULTS, gogc: null, limit: 130 });
    expect(lim.capped).toBe(true);
    expect((lim.wanted * 100).toFixed(1)).toBe("63.8");
    expect(lim.overLimit).toBe(true);
  });
  test("real gctrace lines", () => {
    const t = parseTrace(GCTRACE.gogc100[6]!);
    expect(t).toMatchObject({ n: 7, heap: [18, 20, 11], goal: 21, procs: 14 });
    expect(parseTrace(GCTRACE.gogc100[5]!).heap[2]).toBe(10);
    expect(t.clock).toEqual([0.002, 0.93, 0.013]);
    expect(t.cpu).toEqual({ stw1: 0.036, assist: 0.014, background: 2.4, idle: 3.2, stw2: 0.18 });
    expect(GCTRACE.cycles).toEqual({ gogc50: 43, gogc100: 23, gogc400: 5, offLimit40: 11 });
    expect(parseTrace(GCTRACE.gogc400[1]!)).toMatchObject({ heap: [54, 56, 11], goal: 57 });
    expect(parseTrace(GCTRACE.offLimit40[0]!)).toMatchObject({ heap: [31, 32, 9], goal: 31 });
    expect(parseTrace(GCTRACE.gogc50first).goal).toBe(2);
    expect(parseTrace(GCTRACE.offLimit40[1]!).goal).toBe(30);
    expect((((t.clock[0] + t.clock[2]) / (t.clock[0] + t.clock[1] + t.clock[2])) * 100).toFixed(1)).toBe("1.6");
    expect(parseTrace(GCTRACE.gogc100[0]!).goal).toBe(4);
  });
});
