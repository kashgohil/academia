/** The numbers that the hw-design lessons quote, and the checks that keep the sims honest. */
import { describe, expect, test } from "vitest";
import {
  adderStats, ALL_TESTS, anneal, BUGS, canonicalCost, CORE_SRC, cosim, COMB_DESIGNS, DETECT_BITS, DETECT_NEXT, DIRECTED, EXAMPLES, evalMapped, evalNet,
  latchSrc, lutTable, mapLuts, minimize, outputValue, placeProblem, RV32I_PROGRAMS, runTest, simulate, sopCost, swapSrc, synthesize, timing, traceCore,
} from "../../src/sims/arch/hw";
import { assemble, PROGRAMS } from "../../src/sims/arch/rv";
import { mulberry32 } from "../../src/sims/rng";

const col = (r: ReturnType<typeof simulate>, name: string) => r.wave!.values[r.wave!.signals.findIndex((s) => s.name === name)]!;
const ex = (id: string) => EXAMPLES.find((e) => e.id === id)!;

describe("lesson: HDLs and Verilog basics", () => {
  test("every example design elaborates with no warning", () => {
    for (const e of EXAMPLES) {
      const r = simulate(e.source, 4, e.stim);
      expect(r.error, e.id).toBe(null);
      expect(r.warnings, e.id).toEqual([]);
    }
  });
  test("the counter counts, holds while en is 0, and wrap is combinational", () => {
    const r = simulate(ex("counter").source, 20, ex("counter").stim);
    expect(col(r, "q").slice(0, 10)).toEqual([0, 0, 1, 2, 3, 4, 5, 5, 5, 5]);
    expect(col(r, "wrap")[19]).toBe(1);
    expect(col(r, "q")[19]).toBe(15);
  });
  test("the LFSR visits all 15 non-zero states", () => {
    const s = col(simulate(ex("lfsr").source, 17, ex("lfsr").stim), "s").slice(1);
    expect(new Set(s.slice(0, 15)).size).toBe(15);
    expect(s[15]).toBe(s[0]);
  });
  test("the swap: nonblocking swaps; blocking copies, in one block and in two", () => {
    const st = (t: number) => ({ rst: t === 0 ? 1 : 0 });
    const nb = simulate(swapSrc("<=", "one"), 3, st);
    expect([col(nb, "a")[2], col(nb, "b")[2]]).toEqual([2, 1]);
    expect(col(simulate(swapSrc("<=", "two"), 3, st), "a")[2]).toBe(2);
    for (const layout of ["one", "two"] as const) {
      const bl = simulate(swapSrc("=", layout), 3, st);
      expect([col(bl, "a")[2], col(bl, "b")[2]]).toEqual([2, 2]);
    }
  });
  test("the detector finds 1011 three times in the 16 default input bits (cycles 5, 8 and 15)", () => {
    const r = simulate(ex("detect").source, 16, ex("detect").stim);
    const found = col(r, "found");
    expect(found.flatMap((v, i) => (v ? [i] : []))).toEqual([5, 8, 15]);
    // the state register follows the table that the demo draws
    const st = col(r, "st");
    for (let t = 1; t < 15; t++) expect(st[t + 1]).toBe(DETECT_NEXT[st[t]!]![DETECT_BITS[t]!]);
  });
});

describe("lesson: synthesis", () => {
  test("Quine-McCluskey on the example: 10 minterms become 3 terms", () => {
    const on = [0, 1, 2, 5, 6, 7, 8, 9, 10, 14];
    const m = minimize(4, on);
    expect(m.text).toBe("A'BD + CD' + B'C'");
    expect(m.primes.length).toBe(6);
    expect(sopCost(m.cover, 4)).toMatchObject({ terms: 3, literals: 7, gates2: 6, depth: 4 });
    expect(canonicalCost(4, on)).toMatchObject({ terms: 10, literals: 40, gates2: 39, depth: 6 });
  });
  test("majority of 3 and 4-input parity", () => {
    expect(minimize(3, [3, 5, 6, 7]).text).toBe("AB + AC + BC");
    const par = minimize(4, [1, 2, 4, 7, 8, 11, 13, 14]);
    expect(par.cover.length).toBe(8); // no two minterms of parity are neighbours
    expect(sopCost(par.cover, 4).gates2).toBe(31);
  });
  test("every cover covers exactly the ones (random tables)", () => {
    const r = mulberry32(3);
    for (let k = 0; k < 200; k++) {
      const on: number[] = [], dc: number[] = [];
      for (let m = 0; m < 16; m++) { const x = r(); if (x < 0.4) on.push(m); else if (x < 0.5) dc.push(m); }
      const q = minimize(4, on, dc);
      for (let m = 0; m < 16; m++) {
        const hit = q.cover.some((p) => (m & ~p.dash) === (p.value & ~p.dash));
        if (on.includes(m)) expect(hit).toBe(true);
        else if (!dc.includes(m)) expect(hit).toBe(false);
      }
    }
  });
  test("adder gate counts, levels and delays (MODEL INPUT gate delays)", () => {
    expect(adderStats(8, "ripple")).toEqual({ gates: 34, depth: 14, delay: 15 });
    expect(adderStats(8, "prefix")).toEqual({ gates: 58, depth: 7, delay: 8 });
    expect(adderStats(32, "ripple")).toEqual({ gates: 154, depth: 62, delay: 63 });
    expect(adderStats(32, "prefix")).toEqual({ gates: 436, depth: 11, delay: 12 });
    expect(adderStats(16, "ripple").delay).toBe(31);
    expect(adderStats(16, "prefix").delay).toBe(10);
    // the closed forms that the lesson states: 2w - 1 for ripple, 2 log2 w + 2 for Kogge-Stone
    for (let w = 2; w <= 32; w += 2) expect(adderStats(w, "ripple").delay).toBe(2 * w - 1);
    for (const w of [4, 8, 16, 32]) expect(adderStats(w, "prefix").delay).toBe(2 * Math.log2(w) + 2);
  });
  test("4-input parity as an XOR tree: 3 gates", () => {
    const s = synthesize("module p(input [3:0] d, output y);\n  assign y = ^d;\nendmodule");
    expect(timing(s.net!).gates).toBe(3);
  });
  test("the netlist and the LUT mapping compute what the RTL simulator computes", () => {
    const r = mulberry32(7);
    const designs = [
      ...COMB_DESIGNS.map((d) => d.source),
      `module m(input [7:0] a, input [7:0] b, input [2:0] n, output lt, output slt, output [7:0] d, output [7:0] z, output [7:0] w);
  assign lt = a < b;
  assign slt = $signed(a) < $signed(b);
  assign d = a - b;
  assign z = $signed(a) >>> n;
  assign w = n[0] ? a << n : -a ^ {a[3:0], a[7:4]};
endmodule`,
    ];
    for (const src of designs) for (const adder of ["ripple", "prefix"] as const) {
      const syn = synthesize(src, { adder });
      expect(syn.error).toBe(null);
      const net = syn.net!;
      const ins = syn.design!.signals.filter((s) => s.kind === "input");
      const outs = syn.design!.signals.filter((s) => s.kind === "output").map((s) => s.name);
      for (const k of [3, 4, 6]) {
        const m = mapLuts(net, k);
        const tables = m.luts.map((l) => lutTable(net, l));
        expect(m.luts.every((l) => l.leaves.length <= k)).toBe(true);
        for (let trial = 0; trial < 40; trial++) {
          const inp: Record<string, number> = {};
          for (const s of ins) inp[s.name] = Math.floor(r() * 2 ** s.width);
          const bit = (name: string) => { const mm = /^(.*)\[(\d+)\]$/.exec(name); return mm ? (inp[mm[1]!]! >>> Number(mm[2])) & 1 : inp[name]! & 1; };
          const sim = simulate(src, 1, () => inp);
          const v = evalNet(net, bit), mv = evalMapped(net, m, tables, bit);
          for (const o of outs) {
            expect(outputValue(net, v, o)).toBe(col(sim, o)[0]);
            let got = 0;
            for (const ob of net.outputs) {
              const mm = /^(.*)\[(\d+)\]$/.exec(ob.name);
              if ((mm ? mm[1] : ob.name) === o) got += (mv.get(ob.node) ?? 0) * 2 ** (mm ? Number(mm[2]) : 0);
            }
            expect(got).toBe(col(sim, o)[0]);
          }
        }
      }
    }
  });
  test("the latch: inferred without a default, gone with one", () => {
    expect(synthesize(latchSrc(false)).latches).toEqual(["y"]);
    expect(synthesize(latchSrc(true)).latches).toEqual([]);
    expect(simulate(latchSrc(false), 1).warnings[0]!.message).toMatch(/latch inferred for y/);
  });
});

describe("lesson: FPGAs", () => {
  const map = (id: string, k: number) => {
    const s = synthesize(COMB_DESIGNS.find((d) => d.id === id)!.source);
    const m = mapLuts(s.net!, k), t = timing(s.net!);
    return { gates: t.gates, levels: t.depth, luts: m.luts.length, lutLevels: m.depth };
  };
  test("mapping the 4-bit adder and the 4-to-1 mux", () => {
    expect(map("add4", 4)).toEqual({ gates: 17, levels: 7, luts: 7, lutLevels: 3 });
    expect(map("add4", 6)).toMatchObject({ luts: 6, lutLevels: 2 });
    expect(map("add4", 3)).toMatchObject({ lutLevels: 4 });
    expect(map("mux4", 4)).toMatchObject({ gates: 11, luts: 6, lutLevels: 3 });
    expect(map("mux4", 6)).toMatchObject({ luts: 2, lutLevels: 1 });
    expect(map("parity8", 4)).toMatchObject({ luts: 3, lutLevels: 3 });
  });
  test("depth-first mapping of the 8-bit adder: fewer levels can cost more LUTs", () => {
    expect(map("add8", 3)).toMatchObject({ gates: 37, luts: 17, lutLevels: 8 });
    expect(map("add8", 4)).toMatchObject({ luts: 21, lutLevels: 5 });
    expect(map("add8", 6)).toMatchObject({ luts: 15, lutLevels: 3 });
  });
  test("annealing the 8-bit adder (seed 1): wire length and delay drop, wires stay the larger part", () => {
    const s = synthesize(COMB_DESIGNS.find((d) => d.id === "add8")!.source);
    const p = placeProblem(s.net!, mapLuts(s.net!, 4));
    expect(p.grid).toBe(6);
    const f = anneal(p, { seed: 1, rounds: 30 });
    const a = f[0]!, b = f[30]!;
    expect(a.sta.delay).toBeCloseTo(14.05, 2);
    expect(b.sta.delay).toBeCloseTo(10.71, 2);
    expect(a.sta.wire / a.sta.delay).toBeCloseTo(0.644, 3);
    expect(b.sta.wire / b.sta.delay).toBeCloseTo(0.533, 3);
    expect(b.cost).toBeLessThan(a.cost * 0.6);
  });
  test("across random starts, the annealed delay varies less than the start", () => {
    const s = synthesize(COMB_DESIGNS.find((d) => d.id === "add8")!.source);
    const p = placeProblem(s.net!, mapLuts(s.net!, 4));
    const runs = [1, 2, 3, 4, 5, 6].map((seed) => anneal(p, { seed, rounds: 30 }));
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    const start = spread(runs.map((f) => f[0]!.sta.delay)), end = spread(runs.map((f) => f[30]!.sta.delay));
    expect(end).toBeLessThan(start);
    for (const f of runs) expect(f[30]!.sta.delay).toBeLessThan(f[0]!.sta.delay);
  });
});

describe("lesson: building a RISC-V core", () => {
  test("the sizes the lesson quotes", () => {
    expect(CORE_SRC.trimEnd().split("\n").length).toBeLessThan(150);
    expect(RV32I_PROGRAMS.length).toBe(8);
    expect(PROGRAMS.length).toBe(10);
    expect(DIRECTED.length).toBe(8);
    expect(ALL_TESTS.length).toBe(16);
  });
  test("every bug's find text occurs exactly once in the core", () => {
    for (const b of BUGS) expect(CORE_SRC.split(b.find).length - 1, b.id).toBe(1);
  });
  test("the RV32I sample programs are the ones without mul or div", () => {
    expect(RV32I_PROGRAMS.map((p) => p.id)).toEqual(PROGRAMS.map((p) => p.id).filter((id) => id !== "fact" && id !== "dot"));
  });
  test("the clean core agrees with the hart on every test, one instruction per cycle", () => {
    for (const id of ALL_TESTS) {
      const r = runTest(id, null);
      expect(r.status, id).toBe("pass");
      expect(r.result.cycles).toBe(r.retired + 1); // + the reset cycle
    }
    const sum = runTest("sum", null).result;
    expect([sum.retired, sum.exitCode]).toEqual([46, 31]);
    expect(runTest("memcpy", null).result.output).toBe("RISC-V memcpy!!\n");
    for (const t of DIRECTED) expect(runTest(t.id, null).result.exitCode, t.id).toBe(0);
  });
  test("the bug matrix: which tests catch which bug, and where", () => {
    const failing = (bug: string) => ALL_TESTS.filter((id) => runTest(id, bug).status !== "pass");
    expect(failing("imm-i-zero").length).toBe(14);
    expect(failing("blt-unsigned")).toEqual(["t-branch"]);
    expect(failing("lb-zero")).toEqual(["t-load"]);
    expect(failing("sra-mixed")).toEqual(["t-shift"]);
    expect(failing("sb-word")).toEqual(["memcpy", "t-store"]);
    expect(failing("x0-written")).toEqual(["fib", "strlen", "memcpy", "bubble", "t-jump"]);
    const first = runTest("sum", "imm-i-zero").mismatch!;
    expect(first).toMatchObject({ seq: 7, text: "addi t1, t1, -1", expected: "t1 = 7", got: "t1 = 4103" });
    expect(runTest("fib", "x0-written").mismatch).toMatchObject({ seq: 8, got: "zero = 36 (a write to x0)" });
    expect(runTest("sum", "imm-b-half").mismatch).toMatchObject({ seq: 8, what: "next pc", expected: "0x10", got: "0x18" });
    expect(runTest("t-shift", "sra-mixed").mismatch).toMatchObject({ expected: "t1 = -4", got: "t1 = 1073741820" });
    // every bug is caught by at least one test
    for (const b of BUGS) expect(failing(b.id).length, b.id).toBeGreaterThan(0);
  });
  test("traceCore: one record per cycle", () => {
    const r = traceCore(assemble(RV32I_PROGRAMS.find((p) => p.id === "sum")!.source).program);
    expect(r.cycles.length).toBe(46);
    expect(r.cycles[0]!.sig.next_pc).toBe(4);
  });
  test("a core with a syntax error reports its line", () => {
    const r = cosim(CORE_SRC.replace("wire [31:0] a = regs[rs1];", "wire [31:0] a = regs[rs1]"), assemble(RV32I_PROGRAMS[0]!.source).program);
    expect(r.error!.line).toBe(CORE_SRC.split("\n").findIndex((l) => l.includes("wire [31:0] a = regs[rs1];")) + 2);
  });
});
