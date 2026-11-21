import { describe, expect, test } from "vitest";
import { assemble, encode, Hart, PROGRAMS, type Program } from "../../src/sims/arch/rv";
import {
  alu, aluDecode, aluDecoderInputs, branchCond, compareWithHart, controlRomSizes, criticalPath, DEFAULT_DELAYS, IMM_SOURCE,
  IMM_SOURCE_NAIVE, immGen, immMuxCost, ironLaw, liveEdges, MAIN_TABLE, mainDecode, microcodeSize, mixOf, MultiCycle,
  multiCycleClock, multiCycles, singleCycleClock, SingleCycle, statePath, TCLASSES, waste, withCell, IMM_SRCS,
} from "../../src/sims/arch/datapath";

const prog = (src: string): Program => {
  const r = assemble(src);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.program;
};
const sample = (id: string) => prog(PROGRAMS.find((p) => p.id === id)!.source);
const trace = (id: string) => { const h = new Hart(sample(id)); h.run(); return h.trace; };

describe("units", () => {
  test("immediate generator matches the encoder for every format", () => {
    const cases = [
      { op: "addi", imm: -1234, f: "I" }, { op: "sw", imm: -2048, f: "S" }, { op: "sw", imm: 2047, f: "S" },
      { op: "beq", imm: -4096, f: "B" }, { op: "beq", imm: 4094, f: "B" }, { op: "beq", imm: 2050, f: "B" },
      { op: "jal", imm: -(1 << 20), f: "J" }, { op: "jal", imm: (1 << 20) - 2, f: "J" }, { op: "jal", imm: 2048 + 6, f: "J" },
      { op: "lui", imm: 0xfffff, f: "U" }, { op: "lui", imm: 0x12345, f: "U" },
    ] as const;
    for (const c of cases) {
      const w = encode({ op: c.op, rd: 5, rs1: 6, rs2: 7, imm: c.imm });
      expect(immGen(w, c.f), `${c.op} ${c.imm}`).toBe(c.f === "U" ? (c.imm << 12) | 0 : c.imm);
    }
  });

  test("ALU flags and branch logic agree with signed and unsigned compares", () => {
    const vals = [0, 1, -1, 5, -5, 0x7fffffff, -0x80000000, 1234567, -7654321];
    for (const a of vals) for (const b of vals) {
      const f = alu("sub", a, b).flags;
      expect(branchCond(0, f)).toBe(a === b);
      expect(branchCond(1, f)).toBe(a !== b);
      expect(branchCond(4, f)).toBe(a < b);
      expect(branchCond(5, f)).toBe(a >= b);
      expect(branchCond(6, f)).toBe(a >>> 0 < b >>> 0);
      expect(branchCond(7, f)).toBe(a >>> 0 >= b >>> 0);
    }
  });

  test("ALU decoder: op5 guards sub and the M operations", () => {
    const addi = encode({ op: "addi", rd: 6, rs1: 6, rs2: 0, imm: -1 });
    expect(aluDecode(aluDecoderInputs(addi, 2))).toBe("add");
    expect(aluDecode(aluDecoderInputs(addi, 2), { mIgnoresOp5: true })).toBe("mul"); // imm bit 5 = instruction bit 25
    expect(aluDecode(aluDecoderInputs(addi, 2), { subIgnoresOp5: true })).toBe("sub"); // imm bit 10 = instruction bit 30
    const addi1024 = encode({ op: "addi", rd: 6, rs1: 6, rs2: 0, imm: -1024 }); // bit 30 set, bit 25 clear
    expect(aluDecode(aluDecoderInputs(addi1024, 2), { subIgnoresOp5: true })).toBe("sub");
    const srai = encode({ op: "srai", rd: 6, rs1: 6, rs2: 0, imm: 3 });
    expect(aluDecode(aluDecoderInputs(srai, 2))).toBe("sra");
    expect(aluDecode(aluDecoderInputs(srai, 2), { shiftIgnoresF7: true })).toBe("srl");
  });
});

describe("single-cycle datapath = hart", () => {
  for (const p of PROGRAMS) {
    test(p.id, () => {
      const program = prog(p.source);
      const r = compareWithHart(program, new SingleCycle(program), 100_000);
      expect(r.div).toBeNull();
      expect(r.ok).toBe(true);
      expect(r.exitCode).toBe(p.expect.exit);
      // and memory at the end
      const m = new SingleCycle(program); m.run();
      const h = new Hart(program); h.run();
      expect(Buffer.from(m.mem).equals(Buffer.from(h.mem))).toBe(true);
      expect(m.output).toBe(h.output);
      expect(m.cycles).toBe(h.instret);
    });
  }
});

describe("multi-cycle machine = hart", () => {
  for (const p of PROGRAMS) {
    test(p.id, () => {
      const program = prog(p.source);
      const r = compareWithHart(program, new MultiCycle(program, { mulCycles: 3, divCycles: 7 }), 100_000);
      expect(r.div).toBeNull();
      expect(r.ok).toBe(true);
      const m = new MultiCycle(program, { mulCycles: 3 }); m.run();
      const h = new Hart(program); h.run();
      expect(Buffer.from(m.mem).equals(Buffer.from(h.mem))).toBe(true);
      // the cycles are the sum of the FSM path lengths
      const mix = mixOf(h.trace);
      expect(m.cycles).toBe(TCLASSES.reduce((s, c) => s + mix[c] * multiCycles(c, 3, 1), 0));
    });
  }
});

describe("control", () => {
  test("cycles per class (Harris & Harris: lw 5, sw 4, R 4, I 4, beq 3, jal 4)", () => {
    expect(statePath("Load").length).toBe(5);
    expect(statePath("Store").length).toBe(4);
    expect(statePath("R").length).toBe(4);
    expect(statePath("I-ALU").length).toBe(4);
    expect(statePath("Branch").length).toBe(3);
    expect(statePath("JAL").length).toBe(4);
    expect(statePath("JALR").length).toBe(5);
    expect(statePath("LUI").length).toBe(4);
    expect(statePath("System").length).toBe(3);
  });

  test("liveness: sw does not use the result mux; jal does not use the ALU", () => {
    const sw = liveEdges(mainDecode(encode({ op: "sw", rd: 0, rs1: 2, rs2: 5, imm: 8 }))!.ctrl);
    expect(sw.has("Result>RFw")).toBe(false);
    expect(sw.has("RF>DMem")).toBe(true);
    const jal = liveEdges(mainDecode(encode({ op: "jal", rd: 1, rs1: 0, rs2: 0, imm: 8 }))!.ctrl);
    expect(jal.has("ALU>Result")).toBe(false);
    expect(jal.has("PC4>Result")).toBe(true);
  });

  test("breaking RegWrite for jal breaks no sample program; the samples use jal only with rd = x0", () => {
    const t = withCell(MAIN_TABLE, "JAL", "RegWrite", 0);
    for (const p of PROGRAMS) expect(compareWithHart(sample(p.id), new SingleCycle(sample(p.id), { table: t })).ok, p.id).toBe(true);
  });

  test("ALU decoder without op5: 8 of 10 samples fail; the first bad instruction is an addi with a negative immediate", () => {
    const fails = (bugs: object) => PROGRAMS.filter((p) => !compareWithHart(sample(p.id), new SingleCycle(sample(p.id), { bugs })).ok).map((p) => p.id);
    expect(fails({ subIgnoresOp5: true })).toEqual(["sum", "fib", "fact", "memcpy", "dot", "bubble", "branchy", "hello"]);
    expect(fails({ mIgnoresOp5: true })).toEqual(["sum", "fib", "fact", "memcpy", "dot", "bubble", "branchy", "hello"]);
    expect(fails({ shiftIgnoresF7: true })).toEqual([]);
    const r = compareWithHart(sample("sum"), new SingleCycle(sample("sum"), { bugs: { subIgnoresOp5: true } }));
    expect(r.div).toMatchObject({ text: "addi t1, t1, -1", what: "t1", expected: "7", got: "9" });
    const m = compareWithHart(sample("sum"), new SingleCycle(sample("sum"), { bugs: { mIgnoresOp5: true } }));
    expect(m.div).toMatchObject({ text: "addi t1, t1, -1", expected: "7", got: "-8" });
  });

  test("control as ROMs", () => {
    const r = controlRomSizes();
    expect(r.flat).toMatchObject({ inputs: 17, rows: 131072, width: 22, bits: 2883584 });
    expect(r.main).toMatchObject({ rows: 128, width: 17, bits: 2176 });
    expect(r.aluDec).toMatchObject({ rows: 256, width: 5, bits: 1280 });
    expect(r.twoLevel).toBe(3456);
    expect(r.main5.bits).toBe(544);
    expect(r.twoLevel5).toBe(1824);
    const mc = microcodeSize();
    expect(mc).toMatchObject({ words: 16, controlBits: 15, width: 22, bits: 352, total: 616 });
  });

  test("immediate layout: the RISC-V wiring needs fewer multiplexer inputs than an unscrambled one", () => {
    const real = immMuxCost(IMM_SOURCE), naive = immMuxCost(IMM_SOURCE_NAIVE);
    expect(real.inputs).toBe(69);
    expect(naive.inputs).toBe(97);
    expect(real.perBit[31]).toBe(1); // the sign bit is always instruction bit 31
    expect(Math.max(...real.perBit)).toBe(4);
    expect(Math.max(...naive.perBit)).toBe(5);
    void IMM_SRCS;
  });
});

describe("timing (model inputs)", () => {
  test("single-cycle critical paths", () => {
    const t = Object.fromEntries(TCLASSES.map((c) => [c, criticalPath(c).total]));
    expect(t).toEqual({ R: 560, "I-ALU": 560, Load: 760, Store: 705, Branch: 570, JAL: 500, JALR: 575, LUI: 560, AUIPC: 560, System: 325, Mul: 1010, Div: 4410 });
    expect(singleCycleClock().tc).toBe(760);
    expect(singleCycleClock(DEFAULT_DELAYS, "RV32I+mul").tc).toBe(1010);
    expect(singleCycleClock(DEFAULT_DELAYS, "RV32IM").tc).toBe(4410);
    expect(criticalPath("Load").path.map((s) => s.node)).toEqual(["PC", "IMem", "RF", "SrcA", "ALU", "DMem", "Result", "RFw"]);
  });

  test("waste of the single-cycle clock", () => {
    expect(waste(mixOf(trace("sum"))).fraction).toBeCloseTo(0.2218, 4);
    expect(waste(mixOf(trace("bubble"))).fraction).toBeCloseTo(0.1810, 4);
  });

  test("multi-cycle clock and the iron law", () => {
    const mc = multiCycleClock();
    expect(mc).toMatchObject({ tc: 300, slowest: "MemRead", budget: 220, mulCycles: 3, divCycles: 19 });
    const sum = ironLaw(mixOf(trace("sum")));
    expect(sum.single).toMatchObject({ ic: 46, tc: 760, ps: 34960 });
    expect(sum.multi).toMatchObject({ cycles: 183, tc: 300, ps: 54900 });
    expect(sum.multi.cpi).toBeCloseTo(3.978, 3);
    expect(sum.speedup).toBeCloseTo(0.637, 3);
    expect(ironLaw(mixOf(trace("sum")), DEFAULT_DELAYS, "RV32IM").speedup).toBeCloseTo(3.695, 3);
    const fact = ironLaw(mixOf(trace("fact")), DEFAULT_DELAYS, "RV32I+mul");
    expect(fact.single.ps).toBe(152510);
    expect(fact.multi.ps).toBe(195300);
  });
});

describe("main decoder faults (the presets of the control-unit demo)", () => {
  const failing = (t: string, sg: string, v: number) => {
    const tab = withCell(MAIN_TABLE, t as never, sg as never, v);
    return Object.fromEntries(PROGRAMS.map((p) => [p.id, compareWithHart(sample(p.id), new SingleCycle(sample(p.id), { table: tab }))] as const));
  };
  const ids = (r: Record<string, { ok: boolean }>) => Object.keys(r).filter((k) => !r[k]!.ok);
  test("Load ResultSrc = ALU: every program with a load fails at its first load", () => {
    const r = failing("Load", "ResultSrc", 0);
    expect(ids(r)).toEqual(["sum", "fact", "strlen", "memcpy", "dot", "bubble", "list", "branchy"]);
    expect(r.sum!.div).toMatchObject({ text: "lw t2, 0(t0)", expected: "3", got: "4096" });
  });
  test("Store ImmSrc = I: sw ra, 12(sp) in fact uses offset 1 and traps", () => {
    const r = failing("Store", "ImmSrc", 0);
    expect(r.fact!.div).toMatchObject({ text: "sw ra, 12(sp)", what: "status" });
    expect(r.fact!.div!.got).toContain("misaligned");
  });
  test("Branch ALUOp = add: branches against x0 survive; 3 programs fail", () => {
    expect(ids(failing("Branch", "ALUOp", 0))).toEqual(["fact", "bubble", "branchy"]);
  });
  test("AUIPC ALUSrcA = 0: an auipc at address 0 hides the fault", () => {
    expect(ids(failing("AUIPC", "ALUSrcA", 2))).toEqual(["fact", "memcpy", "dot", "bubble", "hello"]);
  });
});

describe("numbers quoted in the lessons", () => {
  test("clock rate, ratios and step times", () => {
    expect((1000 / singleCycleClock().tc).toFixed(2)).toBe("1.32");
    expect((760 / 560 - 1).toFixed(2)).toBe("0.36"); // a load is about one third slower than an add
    const sum = ironLaw(mixOf(trace("sum")));
    expect((1 / sum.speedup).toFixed(2)).toBe("1.57");
    expect((sum.single.tc / sum.multi.tc).toFixed(2)).toBe("2.53");
    expect(sum.multi.cpi.toFixed(2)).toBe("3.98");
    const mc = multiCycleClock();
    const at = Object.fromEntries(mc.steps.map((s) => [s.state, s.ps]));
    expect(at).toMatchObject({ Fetch: 275, Decode: 275, MemAdr: 230, ExecuteR: 230, MemRead: 300, MemWrite: 280, MemWB: 85, ALUWB: 85, Branch: 250 });
    expect(singleCycleClock(DEFAULT_DELAYS, "RV32I+mul").tc / 1).toBe(1010);
  });

  test("the textbook mix gives CPI 4.12 with this FSM", () => {
    const cpi = 0.13 * multiCycles("Branch") + 0.52 * multiCycles("R") + 0.10 * multiCycles("Store") + 0.25 * multiCycles("Load");
    expect(cpi).toBeCloseTo(4.12, 10);
  });

  test("the div10 sequence equals x / 10 for unsigned x", () => {
    const xs = [0, 1, 9, 10, 11, 99, 100, 12345, 0x7fffffff, 0x80000000, 0xfffffff6, 0xffffffff, 4294967290, 1000000007];
    for (const x of xs) {
      const h = new Hart(prog(`_start:\n li a0, ${x | 0}\n li t0, 0xcccccccd\n mulhu a0, a0, t0\n srli a0, a0, 3\n li a7, 93\n ecall\n`));
      h.run();
      expect(h.exitCode! >>> 0, String(x)).toBe(Math.floor((x >>> 0) / 10));
    }
    expect(0xcccccccd / 2 ** 35).toBeCloseTo(0.1, 9);
  });

  test("main decoder has one row (one PLA product term) per opcode", () => {
    expect(Object.keys(MAIN_TABLE).length).toBe(11);
  });
});
