/** Pins every number that the five Architecture → Pipelining lessons quote, and checks the sims against golden models. */
import { describe, expect, test } from "vitest";
import { makePredictor } from "../../src/sims/perf/cpu";
import { pipeline, programById, type PipelineOptions, type PipelineResult } from "../../src/sims/arch/rv";
import {
  BP_IDS, LOAD_USE_BLOCK, PAIR_BLOCK, bestDepth, bimodal, branchEvents, branchPoint, checkOrder, depthPoint, fibSource, gshare,
  independent, issueModel, issueWorkloadById, local, loopSource, makeBP, patternEvents, perceptronTheta, perceptronWeightBits,
  phExample, returnPredict, runSource, score, speedupLimit, steps, timeSource, workloadTrace, type BPId,
} from "../../src/sims/arch/pipelining";

const pct1 = (x: number) => +(x * 100).toFixed(1);

describe("five-stage pipeline", () => {
  test("8 independent instructions: 12 cycles, CPI 1.50", () => {
    const r = timeSource(independent(8));
    expect([r.retired, r.cycles, r.cpi]).toEqual([8, 12, 1.5]);
  });
  test("the sum program: 46 instructions, 72 cycles, 8 load-use and 14 control cycles", () => {
    const r = timeSource(programById("sum").source);
    expect([r.retired, r.cycles, r.cpi.toFixed(2), r.stalls.loadUse, r.stalls.control]).toEqual([46, 72, "1.57", 8, 14]);
    expect(r.cycles - r.retired - r.stalls.loadUse - r.stalls.control).toBe(4);
  });
  test("P&H's example: 800 ps single-cycle, 200 ps pipelined, speedup 4", () => {
    expect(phExample()).toMatchObject({ single: 800, piped: 200, speedup: 4 });
  });
  test("the depth model at 40 ps register overhead", () => {
    const d5 = depthPoint(5), d20 = depthPoint(20), d1 = depthPoint(1);
    expect([d5.clockPs, +d5.speedup.toFixed(2), d5.latencyPs]).toEqual([200, 4.2, 1000]);
    expect([d20.clockPs, +d20.speedup.toFixed(2), d20.latencyPs]).toEqual([80, 10.5, 1600]);
    expect(d1.latencyPs).toBe(840);
    expect(speedupLimit()).toBe(21);
  });
});

describe("data hazards and forwarding", () => {
  const snip = (prod: string, cons: string, d: number) => [prod, ...Array(d - 1).fill("nop"), cons, "ebreak"].join("\n");
  const ALU = "addi t0, zero, 8", LOAD = "lw t0, -4(sp)", USE = "add t1, t0, t0";
  const stalls = (src: string, o: PipelineOptions) => { const s = timeSource(src, o).stalls; return s.loadUse + s.raw; };
  test("no forwarding: 2, 1, 0 stalls at distance 1, 2, 3 for ALU and load producers", () => {
    for (const p of [ALU, LOAD]) expect([1, 2, 3].map((d) => stalls(snip(p, USE, d), { forwarding: "none" }))).toEqual([2, 1, 0]);
  });
  test("full forwarding: ALU never stalls; a load stalls 1 at distance 1", () => {
    expect([1, 2, 3].map((d) => stalls(snip(ALU, USE, d), {}))).toEqual([0, 0, 0]);
    expect([1, 2, 3].map((d) => stalls(snip(LOAD, USE, d), {}))).toEqual([1, 0, 0]);
  });
  test("store data from a load: 1 stall, 0 with MEM/WB to MEM; a load address from a load still stalls", () => {
    expect(stalls(snip(LOAD, "sw t0, -8(sp)", 1), {})).toBe(1);
    expect(stalls(snip(LOAD, "sw t0, -8(sp)", 1), { memForward: true })).toBe(0);
    expect(stalls(snip(LOAD, "lw t2, 0(t0)", 1), { memForward: true })).toBe(1);
  });
  test("real programs", () => {
    const t = (id: string, o: PipelineOptions) => timeSource(programById(id).source, o);
    const ln = t("list", { forwarding: "none" }), lf = t("list", {});
    expect([lf.retired, ln.cycles, lf.cycles, lf.stalls.loadUse, lf.stalls.raw]).toEqual([37, 90, 71, 16, 0]);
    const mn = t("memcpy", { forwarding: "none" }), mf = t("memcpy", {}), mm = t("memcpy", { memForward: true });
    expect([mn.cycles, mf.cycles, mm.cycles, mm.stalls.loadUse]).toEqual([222, 168, 152, 0]);
  });
  test("be the compiler: 16 cycles, 14 after moving the third load up; a wrong order is caught", () => {
    const id = LOAD_USE_BLOCK.lines.map((_, i) => i);
    const a = checkOrder(LOAD_USE_BLOCK, id, {}), b = checkOrder(LOAD_USE_BLOCK, LOAD_USE_BLOCK.good, {});
    expect([a.correct, a.timing.cycles, a.timing.stalls.loadUse]).toEqual([true, 16, 2]);
    expect([b.correct, b.timing.cycles, b.timing.stalls.loadUse]).toEqual([true, 14, 0]);
    const w = checkOrder(LOAD_USE_BLOCK, [0, 2, 1, 3, 4, 5, 6], {});
    expect(w.correct).toBe(false);
    expect(w.diffs[0]).toMatch(/^t2 = /);
  });
});

describe("control hazards", () => {
  const loop = (predict: "stall" | "not-taken" | "taken" | "dyn", resolve: "EX" | "ID" = "EX") =>
    timeSource(loopSource(4), { branch: predict === "dyn" ? { resolve, predict: "dynamic", predictor: makePredictor("two-bit"), btb: true } : { resolve, predict } });
  test("a loop of 4 under each policy", () => {
    const s = loop("stall"), n = loop("not-taken"), t = loop("taken"), d = loop("dyn");
    expect([s.cycles, s.stalls.control, s.flushes]).toEqual([28, 8, 0]);
    expect([n.cycles, n.stalls.control, n.flushes, n.mispredicts, n.branches]).toEqual([26, 6, 6, 3, 4]);
    expect([t.cycles, t.stalls.control]).toEqual([25, 5]);
    expect([d.cycles, d.stalls.control]).toEqual([23, 3]);
    const i = loop("not-taken", "ID");
    expect([i.cycles, i.stalls.control, i.stalls.raw]).toEqual([27, 3, 4]);
  });
  test("the depth model: penalties, CPI and the best depth", () => {
    const p5 = branchPoint(5), p20 = branchPoint(20);
    expect([p5.penalty, +p5.cpi.toFixed(2), Math.round(p5.psPerInst)]).toEqual([2, 1.12, 224]);
    expect([p20.penalty, p20.clockPs]).toEqual([11, 80]);
    const b = bestDepth({}, 40);
    expect([b.n, Math.round(b.psPerInst)]).toEqual([25, 125]);
    expect([0, 0.2].map((m) => bestDepth({ missRate: m }, 40).n)).toEqual([28, 20]);
  });
});

describe("branch prediction", () => {
  test("bimodal matches the 2-bit predictor of src/sims/perf/cpu.ts on every workload", () => {
    for (const id of ["loops", "random", "bubble", "many"]) {
      const ev = branchEvents(workloadTrace(id));
      const ref = makePredictor("two-bit", 12);
      let m = 0;
      for (const e of ev) { if (ref.predict(e.pc >>> 2) !== e.taken) m++; ref.update(e.pc >>> 2, e.taken); }
      expect(score(bimodal(12), ev).misses).toBe(m);
    }
  });
  test("the stepper: loop of 4 and alternating", () => {
    const run = (make: () => ReturnType<typeof bimodal>, bits: string) => {
      const st = steps(make, patternEvents(bits, 48));
      return [st.filter((s) => s.pred !== s.taken).length, st.slice(32).filter((s) => s.pred !== s.taken).length];
    };
    expect(run(() => bimodal(4), "TTTN")[1]).toBe(4);
    expect(run(() => local(16, 4), "TTTN")[1]).toBe(0);
    expect(run(() => bimodal(4), "TN")).toEqual([24, 8]);
    expect(run(() => local(16, 4), "TN")[0]).toBe(2);
    expect(run(() => gshare(4, 4), "TN")[0]).toBe(2);
  });
  const rate = (w: string, id: BPId, k: number) => pct1(score(makeBP(id, k), branchEvents(workloadTrace(w))).rate);
  test("400 small loops at 2^13 and 2^17 bits", () => {
    expect([rate("many", "bimodal", 13), rate("many", "local", 13), rate("many", "gshare", 13), rate("many", "tage", 13)]).toEqual([24.4, 1.1, 10.7, 23.8]);
    expect([rate("many", "gshare", 17), rate("many", "tournament", 17), rate("many", "tage", 17)]).toEqual([3.5, 1.4, 3.6]);
  });
  test("correlated branches at 2^13 bits, and random data", () => {
    expect([rate("correlated", "bimodal", 13), rate("correlated", "local", 13), rate("correlated", "tage", 13), rate("correlated", "gshare", 13)]).toEqual([32.9, 20.5, 17.2, 18.6]);
    for (const id of ["static", ...BP_IDS] as BPId[]) { const r = rate("random", id, 13); expect(r).toBeGreaterThan(23); expect(r).toBeLessThan(28); }
  });
  test("the tournament predictor at 2^15 bits has the Alpha 21264's tables", () => {
    const t = makeBP("tournament", 15);
    expect(t.bits).toBe(1024 * 10 + 1024 * 3 + 4096 * 2 + 4096 * 2 + 12);
    expect(1024 * 10 + 1024 * 3 + 4096 * 2 + 4096 * 2).toBe(29696);
  });
  test("perceptron threshold and weight width (Jiménez and Lin)", () => {
    expect([12, 62].map(perceptronTheta)).toEqual([37, 133]);
    expect([12, 62].map(perceptronWeightBits)).toEqual([7, 9]);
  });
  test("return-address stack on fib(8)", () => {
    const run = runSource(fibSource(8));
    expect(run.hart!.exitCode).toBe(21);
    const r4 = returnPredict(run.trace, 4, false);
    expect([r4.returns, r4.rasMisses, r4.btbMisses, r4.maxDepth]).toEqual([67, 7, 43, 8]);
    expect([0, 8].map((d) => returnPredict(run.trace, d, false).rasMisses)).toEqual([67, 0]);
  });
});

describe("superscalar issue", () => {
  const dot = (w: 1 | 2, dyn: boolean): PipelineResult => {
    const r = runSource(programById("dot").source);
    return pipeline(r.trace, r.program, { width: w, branch: dyn ? { predict: "dynamic", predictor: makePredictor("two-bit"), btb: true } : { predict: "not-taken" } });
  };
  test("dot product: IPC at width 1 and 2", () => {
    const ipc = (x: PipelineResult) => (1 / x.cpi).toFixed(2);
    expect([ipc(dot(1, false)), ipc(dot(1, true)), ipc(dot(2, false)), ipc(dot(2, true))]).toEqual(["0.73", "0.83", "0.91", "1.06"]);
    const r = dot(2, true), live = r.rows.filter((x) => !x.squashed);
    const ex = (seq: number) => live.find((x) => x.seq === seq)!.cells.find((c) => c.stage === "EX")!.cycle;
    const pairs = live.slice(1).filter((x) => ex(x.seq) === ex(x.seq - 1)).length;
    expect([pairs * 2, r.retired]).toEqual([38, 72]);
  });
  test("be the compiler for pairs: 19 to 17 cycles at width 2, 25 to 23 at width 1", () => {
    const id = PAIR_BLOCK.lines.map((_, i) => i);
    const c = (o: number[], w: 1 | 2) => checkOrder(PAIR_BLOCK, o, { width: w });
    expect([c(id, 2).timing.cycles, c(PAIR_BLOCK.good, 2).timing.cycles, c(PAIR_BLOCK.good, 2).correct]).toEqual([19, 17, true]);
    expect([c(id, 1).timing.cycles, c(PAIR_BLOCK.good, 1).timing.cycles]).toEqual([25, 23]);
    // addi a0 above the load at 4(a0): a wrong result
    expect(c([0, 1, 2, 3, 8, 4, 5, 6, 7, 9, 10], 2).correct).toBe(false);
  });
  test("the issue model: in order against a window", () => {
    const t = runSource(issueWorkloadById("saxpy").source).trace;
    const ipc = (mode: "in-order" | "window", miss: number) => issueModel(t, { width: 4, mode, window: 64, missLatency: miss }).ipc.toFixed(2);
    expect([ipc("in-order", 40), ipc("window", 40)]).toEqual(["0.96", "1.92"]);
    expect([ipc("in-order", 2), ipc("window", 2)]).toEqual(["1.29", "2.98"]);
    const c = runSource(issueWorkloadById("chase").source).trace;
    for (const mode of ["in-order", "window"] as const) expect(issueModel(c, { width: 4, mode, missLatency: 40 }).ipc.toFixed(1)).toBe("0.1");
  });
  test("the issue model never beats its width, and every workload exits correctly", () => {
    for (const id of ["saxpy", "sum4", "chase"]) {
      const r = runSource(issueWorkloadById(id).source);
      expect(r.ok && r.hart!.status).toBe("exited");
      for (const w of [1, 2, 4, 8]) for (const mode of ["in-order", "window"] as const) expect(issueModel(r.trace, { width: w, mode }).ipc).toBeLessThanOrEqual(w);
    }
  });
});
