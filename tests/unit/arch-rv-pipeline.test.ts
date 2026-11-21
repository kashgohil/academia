import { describe, expect, test } from "vitest";
import { makePredictor } from "../../src/sims/perf/cpu";
import { assemble, Hart, Pipeline, pipeline, PROGRAMS, type PipelineOptions, type PipelineResult } from "../../src/sims/arch/rv";

/** Assemble, run on the hart, time it. */
function timing(src: string, opts: PipelineOptions = {}) {
  const a = assemble(src);
  expect(a.errors).toEqual([]);
  const h = new Hart(a.program);
  h.run({ maxSteps: 100_000 });
  return { r: pipeline(h.trace, a.program, opts), h, program: a.program };
}
const T = (src: string, opts: PipelineOptions = {}) => timing(src, opts).r;
const row = (r: PipelineResult, seq: number) => r.rows.find((x) => x.seq === seq)!;
const stages = (r: PipelineResult, seq: number) => row(r, seq).cells.map((c) => `${c.cycle}${c.stage}`).join(" ");
const NONE: PipelineOptions = { forwarding: "none" };

describe("five-stage pipeline: data hazards (P&H chapter 4)", () => {
  test("no hazards: n instructions take 5 + n - 1 cycles", () => {
    for (const n of [1, 2, 5, 10]) {
      const r = T(`${"addi a0, zero, 1\n".repeat(n - 1)}ebreak`);
      expect(r.cycles).toBe(5 + n - 1);
      expect(r.retired).toBe(n);
      expect(r.stalls).toEqual({ loadUse: 0, raw: 0, control: 0, structural: 0 });
    }
    const r = T("addi a0, zero, 1\naddi a1, zero, 1\nebreak");
    expect(stages(r, 0)).toBe("1IF 2ID 3EX 4MEM 5WB");
    expect(stages(r, 1)).toBe("2IF 3ID 4EX 5MEM 6WB");
    expect(r.cpi).toBeCloseTo(7 / 3);
  });

  test("ALU to ALU: no stall with forwarding; 2 and 1 stalls at distance 1 and 2 without it; none at distance 3", () => {
    const d1 = "addi t0, zero, 1\nadd t1, t0, t0\nebreak";
    const d2 = "addi t0, zero, 1\nnop\nadd t1, t0, t0\nebreak";
    const d3 = "addi t0, zero, 1\nnop\nnop\nadd t1, t0, t0\nebreak";
    expect(T(d1).stalls.raw).toBe(0);
    expect(T(d1, NONE).stalls.raw).toBe(2);
    expect(T(d2, NONE).stalls.raw).toBe(1);
    expect(T(d3, NONE).stalls.raw).toBe(0);
    expect(T(d1, NONE).cycles).toBe(7 + 2);
    expect(stages(T(d1, NONE), 1)).toBe("2IF 3ID 4stall 5stall 6EX 7MEM 8WB");
    expect(stages(T(d1, NONE), 2)).toBe("3IF 4stall 5stall 6ID 7EX 8MEM 9WB");
  });

  test("load-use: 1 stall with forwarding, 2 without", () => {
    const src = "lw t0, -4(sp)\nadd t1, t0, t0\nebreak";
    const f = T(src), n = T(src, NONE);
    expect(f.stalls).toEqual({ loadUse: 1, raw: 0, control: 0, structural: 0 });
    expect(f.cycles).toBe(8);
    expect(stages(f, 1)).toBe("2IF 3ID 4stall 5EX 6MEM 7WB");
    expect(n.stalls).toEqual({ loadUse: 0, raw: 2, control: 0, structural: 0 });
    expect(n.cycles).toBe(9);
    // one instruction in between hides the load-use stall
    expect(T("lw t0, -4(sp)\nnop\nadd t1, t0, t0\nebreak").stalls.loadUse).toBe(0);
  });

  test("forwarding paths: EX/MEM at distance 1, MEM/WB at distance 2 and after a load", () => {
    const r = T("addi t0, zero, 1\nadd t1, t0, zero\nadd t2, t0, zero\nlw t3, -4(sp)\nadd t4, t3, zero\nebreak");
    expect(r.forwards.map((f) => [f.from, f.to, f.src, f.seq, f.reg])).toEqual([
      ["EX/MEM", "EX", 0, 1, 5], ["MEM/WB", "EX", 0, 2, 5], ["MEM/WB", "EX", 3, 4, 28],
    ]);
    expect(T("addi t0, zero, 1\nadd t1, t0, zero\nebreak", NONE).forwards).toEqual([]);
  });

  test("a store's data from a load: 1 stall, or none with MEM/WB to MEM forwarding", () => {
    const src = "lw t0, -4(sp)\nsw t0, -8(sp)\nebreak";
    expect(T(src).stalls.loadUse).toBe(1);
    const m = T(src, { memForward: true });
    expect(m.stalls.loadUse).toBe(0);
    expect(m.forwards).toEqual([{ from: "MEM/WB", to: "MEM", seq: 1, src: 0, reg: 5, cycle: 5 }]);
    // the address still needs EX forwarding: a load-use on rs1 stalls
    expect(T("lw t0, -4(sp)\nsw a0, 0(t0)\nebreak", { memForward: true }).stalls.loadUse).toBe(1);
  });

  test("x0 never makes a hazard", () => {
    expect(T("addi zero, zero, 1\nadd t1, zero, zero\nebreak", NONE).stalls.raw).toBe(0);
  });

  test("a long divide holds the next instruction in ID (structural); mulLatency and divLatency are inputs", () => {
    const src = "li t0, 7\nli t1, 2\ndiv t2, t0, t1\naddi a0, zero, 1\nebreak";
    const r = T(src);
    expect(r.stalls.structural).toBe(19);
    expect(r.cycles).toBe(9 + 19);
    expect(T(src, { divLatency: 5 }).stalls.structural).toBe(4);
    expect(T("li t0, 7\nmul t2, t0, t0\nnop\nebreak", { mulLatency: 3 }).stalls.structural).toBe(2);
    expect(stages(T(src, { divLatency: 3 }), 2)).toBe("3IF 4ID 5EX 6EX 7EX 8MEM 9WB");
  });
});

describe("control hazards", () => {
  // The branch is taken; two filler instructions sit on the fall-through path.
  const taken = "li t0, 1\nnop\nnop\nbnez t0, x\naddi a0, zero, 1\naddi a1, zero, 2\nx: ebreak";
  const notTaken = "li t0, 0\nnop\nnop\nbnez t0, x\naddi a0, zero, 1\nx: ebreak";

  test("predict not-taken: a taken branch squashes 2 when resolved in EX, 1 when resolved in ID", () => {
    const ex = T(taken, { branch: { resolve: "EX", predict: "not-taken" } });
    expect(ex.flushes).toBe(2);
    expect(ex.stalls.control).toBe(2);
    expect(ex.cycles).toBe(5 + 5 - 1 + 2);
    const sq = ex.rows.filter((r) => r.squashed);
    expect(sq.map((r) => r.text)).toEqual(["li a0, 1", "li a1, 2"]); // the real fall-through instructions
    expect(sq.map((r) => r.cells.map((c) => `${c.cycle}${c.stage}`).join(" "))).toEqual(["5IF 6ID", "6IF"]);
    expect(stages(ex, 4)).toBe("7IF 8ID 9EX 10MEM 11WB");
    expect(ex.rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, -1, -1, 4]); // in fetch order

    const id = T(taken, { branch: { resolve: "ID", predict: "not-taken" } });
    expect(id.flushes).toBe(1);
    expect(id.stalls.control).toBe(1);
  });

  test("predict not-taken: a not-taken branch costs nothing", () => {
    const r = T(notTaken);
    expect(r.flushes).toBe(0);
    expect(r.stalls.control).toBe(0);
    expect(r.mispredicts).toBe(0);
    expect(r.branches).toBe(1);
  });

  test("stall on every branch: 2 cycles (EX) or 1 (ID), taken or not, with no squashed rows", () => {
    for (const src of [taken, notTaken]) {
      expect(T(src, { branch: { resolve: "EX", predict: "stall" } }).stalls.control).toBe(2);
      const id = T(src, { branch: { resolve: "ID", predict: "stall" } });
      expect(id.stalls.control).toBe(1);
      expect(id.flushes).toBe(0);
      expect(id.rows.some((r) => r.squashed)).toBe(false);
    }
  });

  test("predict taken: the target is known in ID, so a taken branch costs 1; a not-taken one costs 2 (EX) or 1 (ID)", () => {
    expect(T(taken, { branch: { predict: "taken", resolve: "EX" } }).stalls.control).toBe(1);
    expect(T(notTaken, { branch: { predict: "taken", resolve: "EX" } }).stalls.control).toBe(2);
    expect(T(notTaken, { branch: { predict: "taken", resolve: "ID" } }).stalls.control).toBe(1);
    const r = T(notTaken, { branch: { predict: "taken", resolve: "EX" } });
    expect(r.rows.filter((x) => x.squashed).map((x) => x.text)).toEqual(["li a0, 1", "ebreak"]); // fall-through, then target
    expect(r.mispredicts).toBe(1);
  });

  test("branch resolved in ID needs its operands in ID: 1 stall after an ALU op, 2 after a load", () => {
    const alu = T("li t0, 1\nbnez t0, x\nnop\nx: ebreak", { branch: { resolve: "ID" } });
    expect(alu.stalls.raw).toBe(1);
    expect(alu.forwards.map((f) => [f.from, f.to])).toEqual([["EX/MEM", "ID"]]);
    const ld = T("lw t0, -4(sp)\nbnez t0, x\nnop\nx: ebreak", { branch: { resolve: "ID" } });
    expect(ld.stalls.loadUse).toBe(2);
    expect(T("li t0, 1\nnop\nbnez t0, x\nnop\nx: ebreak", { branch: { resolve: "ID" } }).stalls.raw).toBe(0);
    expect(T("li t0, 1\nbnez t0, x\nnop\nx: ebreak", { branch: { resolve: "EX" } }).stalls.raw).toBe(0);
  });

  test("jal is known in ID (1 squashed); jalr resolves in EX (2 squashed)", () => {
    const j = T("j x\nnop\nnop\nx: ebreak");
    expect(j.flushes).toBe(1);
    expect(j.stalls.control).toBe(1);
    const jr = T("la t0, x\nnop\nnop\njr t0\nnop\nnop\nx: ebreak");
    expect(jr.flushes).toBe(2);
    expect(jr.stalls.control).toBe(2);
    expect(T("j x\nnop\nx: ebreak", { branch: { resolve: "ID" } }).flushes).toBe(1);
  });

  test("dynamic prediction with a BTB: a loop branch costs nothing once trained; without a BTB a taken one still costs 1", () => {
    const loop = "li t0, 50\nl: addi t0, t0, -1\nnop\nnop\nbnez t0, l\nebreak";
    const nt = T(loop);
    expect(nt.mispredicts).toBe(49);
    expect(nt.stalls.control).toBe(98);
    const dyn = T(loop, { branch: { predict: "dynamic", predictor: makePredictor("two-bit"), btb: true } });
    // The 2-bit counters start weakly taken, so only the last (exit) iteration mispredicts.
    // The BTB misses once (cold), so the first taken branch gets its target in ID: 1 cycle.
    expect(dyn.mispredicts).toBe(1);
    expect(dyn.stalls.control).toBe(1 + 2);
    const noBtb = T(loop, { branch: { predict: "dynamic", btb: false } });
    expect(noBtb.stalls.control).toBe(49 * 1 + 2);
  });

  test("a BTB predicts the return of a function called from one place", () => {
    const src = "li s0, 10\nl: call f\naddi s0, s0, -1\nbnez s0, l\nebreak\nf: ret";
    const base = T(src, { branch: { predict: "dynamic", btb: false } });
    const btb = T(src, { branch: { predict: "dynamic", btb: true } });
    expect(btb.stalls.control).toBeLessThan(base.stalls.control);
    expect(btb.flushes).toBeLessThan(base.flushes);
  });
});

describe("width 2 (in-order dual issue)", () => {
  test("independent instructions pair; a dependent chain does not", () => {
    const ind = T(`${"addi a0, zero, 1\naddi a1, zero, 2\n".repeat(4)}ebreak`, { width: 2 });
    expect(ind.cycles).toBe(4 + 1 + 4); // 4 pairs, then ebreak alone, plus 4 to drain
    expect(ind.cpi).toBeLessThan(1.1);
    const chain = T(`${"addi a0, a0, 1\n".repeat(8)}ebreak`, { width: 2 });
    const one = T(`${"addi a0, a0, 1\n".repeat(8)}ebreak`, { width: 1 });
    expect(chain.cycles).toBe(one.cycles);
  });

  test("two memory operations never pair, and a branch ends the pair", () => {
    const r = T("lw a0, -4(sp)\nlw a1, -8(sp)\nebreak", { width: 2 });
    expect(row(r, 1).cells.find((c) => c.stage === "EX")!.cycle).toBe(row(r, 0).cells.find((c) => c.stage === "EX")!.cycle + 1);
    const b = T("li t0, 0\nnop\nbnez t0, x\naddi a0, zero, 1\nx: ebreak", { width: 2 });
    const ex = (s: number) => row(b, s).cells.find((c) => c.stage === "EX")!.cycle;
    expect(ex(3)).toBeGreaterThan(ex(2));
  });

  test("width 2 is never slower than width 1 on the sample programs", () => {
    for (const p of PROGRAMS) {
      const a = assemble(p.source);
      const h = new Hart(a.program);
      h.run();
      const w1 = pipeline(h.trace, a.program, { width: 1 }).cycles, w2 = pipeline(h.trace, a.program, { width: 2 }).cycles;
      expect(w2, p.id).toBeLessThanOrEqual(w1);
    }
  });
});

describe("invariants over the sample programs", () => {
  const configs: PipelineOptions[] = [];
  for (const forwarding of ["none", "full"] as const)
    for (const resolve of ["EX", "ID"] as const)
      for (const predict of ["stall", "not-taken", "taken", "dynamic"] as const)
        for (const btb of [false, true]) configs.push({ forwarding, branch: { resolve, predict, btb }, divLatency: 7, mulLatency: 3 });

  test("width 1: cycles = retired + 4 + stalls + (last latency - 1); rows follow the trace; stages are in order", () => {
    for (const p of PROGRAMS) {
      const a = assemble(p.source);
      const h = new Hart(a.program);
      h.run();
      for (const o of configs) {
        const r = pipeline(h.trace, a.program, { ...o, branch: { ...o.branch, predictor: makePredictor("gshare", 8) } });
        const s = r.stalls;
        expect(r.cycles, `${p.id} ${JSON.stringify(o)}`).toBe(r.retired + 4 + s.loadUse + s.raw + s.control + s.structural);
        expect(r.retired).toBe(h.trace.length);
        const real = r.rows.filter((x) => !x.squashed);
        expect(real.map((x) => x.seq)).toEqual(h.trace.map((d) => d.seq));
        expect(real.map((x) => x.pc)).toEqual(h.trace.map((d) => d.pc));
        expect(r.rows.filter((x) => x.squashed)).toHaveLength(r.flushes);
        // each stage once, in order; one instruction per stage per cycle (width 1)
        const order = ["IF", "ID", "EX", "MEM", "WB"];
        const busy = new Set<string>();
        for (const x of real) {
          const st = x.cells.filter((c) => c.stage !== "stall").map((c) => c.stage);
          expect([...new Set(st)]).toEqual(order);
          for (const c of x.cells) {
            const key = `${c.cycle}:${c.stage === "stall" ? "?" : c.stage}`;
            if (c.stage === "EX" || c.stage === "MEM" || c.stage === "WB") { expect(busy.has(key)).toBe(false); busy.add(key); }
          }
        }
      }
    }
  });

  test("the streaming Pipeline fed by onInst, and rows: false, give the same statistics", () => {
    for (const p of PROGRAMS) {
      const a = assemble(p.source);
      const h1 = new Hart(a.program);
      h1.run();
      const full = pipeline(h1.trace, a.program, { branch: { predict: "dynamic", btb: true } });
      const stream = new Pipeline(a.program, { rows: false, branch: { predict: "dynamic", btb: true } });
      const h2 = new Hart(a.program, { trace: false, onInst: (d) => stream.push(d) });
      h2.run();
      const s = stream.finish();
      expect(s.rows).toEqual([]);
      expect(s.forwards).toEqual([]);
      expect({ ...s, rows: [], forwards: [] }).toEqual({ ...full, rows: [], forwards: [] });
    }
  });

  test("deterministic", () => {
    const a = assemble(PROGRAMS.find((p) => p.id === "branchy")!.source);
    const h = new Hart(a.program);
    h.run();
    const o: PipelineOptions = { branch: { predict: "dynamic", btb: true } };
    expect(pipeline(h.trace, a.program, o)).toEqual(pipeline(h.trace, a.program, o));
  });

  test("pinned cycles, load-use stalls and flushes of the sample programs (default: full forwarding, resolve in EX, predict not-taken)", () => {
    const cpi = Object.fromEntries(PROGRAMS.map((p) => {
      const a = assemble(p.source);
      const h = new Hart(a.program);
      h.run();
      const r = pipeline(h.trace, a.program);
      return [p.id, [r.cycles, r.stalls.loadUse, r.flushes]];
    }));
    // sum by hand: 46 instructions + 4, a load-use stall in each of 8 iterations, 7 taken back-edges × 2 squashed = 72.
    // list: 37 + 4, two load-use stalls per node (add after lw, bnez after lw) = 16, 7 × 2 squashed = 71.
    expect(cpi).toEqual({
      sum: [72, 8, 14], fib: [153, 0, 22], fact: [206, 0, 51], strlen: [93, 14, 15], memcpy: [168, 16, 34],
      dot: [98, 8, 14], bubble: [357, 28, 85], list: [71, 16, 14], branchy: [312, 32, 92], hello: [13, 0, 0],
    });
  });

  test("a long run in stats-only mode is fast", () => {
    const a = assemble("li t0, 100000\nl: lw t1, -4(sp)\nadd a0, a0, t1\naddi t0, t0, -1\nbnez t0, l\nebreak");
    const p = new Pipeline(a.program, { rows: false });
    const h = new Hart(a.program, { trace: false, onInst: (d) => p.push(d) });
    const t0 = performance.now();
    h.run();
    const r = p.finish();
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.retired).toBe(400_003);
    expect(r.stalls.loadUse).toBe(100_000);
    expect(r.flushes).toBe(2 * 99_999);
  });
});
