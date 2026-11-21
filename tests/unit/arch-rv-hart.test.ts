import { describe, expect, test } from "vitest";
import { assemble, Hart, mulh, mulhsu, mulhu, type HartOptions } from "../../src/sims/arch/rv";
import { mulberry32 } from "../../src/sims/rng";

/** Assemble, run to the end, return the hart. */
const run = (src: string, opts: HartOptions = {}) => {
  const r = assemble(src);
  expect(r.errors).toEqual([]);
  const h = new Hart(r.program, opts);
  h.run({ maxSteps: 100_000 });
  return h;
};
/** a0 after running `body` and then ebreak. */
const a0 = (body: string) => run(`${body}\nebreak`).regs[10];

describe("ALU", () => {
  test("add, sub and wrap-around", () => {
    expect(a0("li a1, 0x7fffffff\naddi a0, a1, 1")).toBe(-0x80000000);
    expect(a0("li a1, 0x80000000\nli a2, 1\nsub a0, a1, a2")).toBe(0x7fffffff);
    expect(a0("li a1, -1\nli a2, -1\nadd a0, a1, a2")).toBe(-2);
  });

  test("shifts use the low 5 bits of the amount; sra fills with the sign", () => {
    expect(a0("li a1, 1\nli a2, 33\nsll a0, a1, a2")).toBe(2);
    expect(a0("li a1, 0x80000000\nli a2, 31\nsrl a0, a1, a2")).toBe(1);
    expect(a0("li a1, 0x80000000\nli a2, 31\nsra a0, a1, a2")).toBe(-1);
    expect(a0("li a1, 0x80000000\nli a2, 64\nsra a0, a1, a2")).toBe(-0x80000000);
    expect(a0("li a1, -16\nsrai a0, a1, 2")).toBe(-4);
    expect(a0("li a1, -16\nsrli a0, a1, 28")).toBe(15);
    expect(a0("li a1, 3\nslli a0, a1, 31")).toBe(-0x80000000);
  });

  test("slt vs sltu, slti vs sltiu (the immediate is sign-extended, then compared unsigned)", () => {
    expect(a0("li a1, -1\nli a2, 1\nslt a0, a1, a2")).toBe(1);
    expect(a0("li a1, -1\nli a2, 1\nsltu a0, a1, a2")).toBe(0);
    expect(a0("li a1, 5\nsltiu a0, a1, -1")).toBe(1); // 5 < 0xffffffff
    expect(a0("li a1, -5\nslti a0, a1, -4")).toBe(1);
    expect(a0("li a1, 0\nseqz a0, a1")).toBe(1);
    expect(a0("li a1, 7\nsnez a0, a1")).toBe(1);
  });

  test("logic, lui, auipc", () => {
    expect(a0("li a1, 0xf0f0\nandi a0, a1, 0xff")).toBe(0xf0);
    expect(a0("li a1, 0xf0f0\nori a0, a1, -1")).toBe(-1);
    expect(a0("li a1, 0xf0f0\nxori a0, a1, 0x0ff")).toBe(0xf00f);
    expect(a0("lui a0, 0xfffff")).toBe(-4096);
    expect(a0("nop\nnop\nauipc a0, 1")).toBe(0x1008);
  });

  test("x0 ignores writes", () => {
    const h = run("li zero, 5\naddi x0, x0, 1\nmv a0, zero\nebreak");
    expect(h.regs[0]).toBe(0);
    expect(h.regs[10]).toBe(0);
    expect(h.trace[0]!.rd).toBe(0);
  });
});

describe("M extension", () => {
  const big = (v: number) => BigInt.asIntN(32, BigInt(v));
  const ubig = (v: number) => BigInt.asUintN(32, BigInt(v));
  const hi = (p: bigint) => Number(BigInt.asIntN(32, p >> 32n));

  test("mulh, mulhsu, mulhu match a BigInt reference", () => {
    const r = mulberry32(9);
    const edge = [0, 1, -1, 2, -2, 0x7fffffff, -0x80000000, 0xffff, 0x10000, -0x10000];
    const vals = [...edge, ...Array.from({ length: 400 }, () => (Math.floor(r() * 2 ** 32) | 0))];
    for (const a of vals) for (const b of vals.slice(0, 60)) {
      expect(mulh(a, b)).toBe(hi(big(a) * big(b)));
      expect(mulhsu(a, b)).toBe(hi(big(a) * ubig(b)));
      expect(mulhu(a, b)).toBe(hi(ubig(a) * ubig(b)));
    }
  });

  test("mul keeps the low 32 bits", () => {
    expect(a0("li a1, 0x10000\nli a2, 0x10001\nmul a0, a1, a2")).toBe(0x10000);
    expect(a0("li a1, -3\nli a2, 7\nmul a0, a1, a2")).toBe(-21);
    expect(a0("li a1, -1\nli a2, -1\nmulhu a0, a1, a2")).toBe(-2); // 0xfffffffe
    expect(a0("li a1, -1\nli a2, -1\nmulh a0, a1, a2")).toBe(0);
  });

  test("division rounds toward zero; division by zero and overflow follow the spec table", () => {
    expect(a0("li a1, -7\nli a2, 2\ndiv a0, a1, a2")).toBe(-3);
    expect(a0("li a1, -7\nli a2, 2\nrem a0, a1, a2")).toBe(-1);
    expect(a0("li a1, 7\nli a2, -2\nrem a0, a1, a2")).toBe(1);
    expect(a0("li a1, -7\nli a2, 2\ndivu a0, a1, a2")).toBe(0x7ffffffc);
    expect(a0("li a1, -7\nli a2, 2\nremu a0, a1, a2")).toBe(1);
    // x / 0 = all ones, x % 0 = x
    expect(a0("li a1, 42\ndiv a0, a1, zero")).toBe(-1);
    expect(a0("li a1, 42\ndivu a0, a1, zero")).toBe(-1);
    expect(a0("li a1, -42\nrem a0, a1, zero")).toBe(-42);
    expect(a0("li a1, -42\nremu a0, a1, zero")).toBe(-42);
    // INT_MIN / -1 overflows: quotient INT_MIN, remainder 0
    expect(a0("li a1, 0x80000000\nli a2, -1\ndiv a0, a1, a2")).toBe(-0x80000000);
    expect(a0("li a1, 0x80000000\nli a2, -1\nrem a0, a1, a2")).toBe(0);
    expect(a0("li a1, 0x80000000\nli a2, -1\ndivu a0, a1, a2")).toBe(0);
  });

  test("div, divu, rem, remu match a BigInt reference", () => {
    const r = mulberry32(10);
    const vals = [0, 1, -1, 7, -7, 0x7fffffff, -0x80000000, ...Array.from({ length: 40 }, () => Math.floor(r() * 2 ** 32) | 0)];
    for (const a of vals) for (const b of vals) {
      if (b === 0 || (a === -0x80000000 && b === -1)) continue;
      const h = run(`li a1, ${a}\nli a2, ${b}\ndiv s1, a1, a2\nrem s2, a1, a2\ndivu s3, a1, a2\nremu s4, a1, a2\nebreak`);
      expect(h.regs[9]).toBe(Number(BigInt.asIntN(32, big(a) / big(b))));
      expect(h.regs[18]).toBe(Number(BigInt.asIntN(32, big(a) % big(b))));
      expect(h.regs[19]).toBe(Number(BigInt.asIntN(32, ubig(a) / ubig(b))));
      expect(h.regs[20]).toBe(Number(BigInt.asIntN(32, ubig(a) % ubig(b))));
    }
  });
});

describe("memory", () => {
  const data = ".data\nd: .byte 0x80, 0x7f, 0xff, 0xff, 0x11, 0x22, 0x33, 0x44\n.text\n_start: la t0, d\n";

  test("loads sign- and zero-extend; memory is little-endian", () => {
    const h = run(`${data}lb s1, 0(t0)\nlbu s2, 0(t0)\nlh s3, 2(t0)\nlhu s4, 2(t0)\nlw s5, 4(t0)\nlb s6, 1(t0)\nebreak`);
    expect(h.regs[9]).toBe(-128);
    expect(h.regs[18]).toBe(128);
    expect(h.regs[19]).toBe(-1);
    expect(h.regs[20]).toBe(0xffff);
    expect(h.regs[21]).toBe(0x44332211);
    expect(h.regs[22]).toBe(127);
  });

  test("stores of byte, half, word", () => {
    const h = run(`${data}li t1, 0x12345678\nsw t1, 0(t0)\nsb zero, 1(t0)\nsh t1, 4(t0)\nlw s1, 0(t0)\nlw s2, 4(t0)\nebreak`);
    expect(h.regs[9]).toBe(0x12340078);
    expect(h.regs[18]).toBe(0x44335678);
    const s = h.trace.find((d) => d.inst.op === "sb")!;
    expect(s).toMatchObject({ memAddr: 0x1001, memSize: 1, result: 0 });
  });

  test("misaligned access traps by default and works when allowed", () => {
    const h = run(`${data}lw s1, 1(t0)\nebreak`);
    expect(h.status).toBe("error");
    expect(h.error).toMatchObject({ kind: "load-address-misaligned", pc: 8 });
    expect(h.error!.message).toMatch(/^load address misaligned/);
    const ok = run(`${data}lw s1, 1(t0)\nsh s1, 3(t0)\nlhu s2, 3(t0)\nebreak`, { allowMisaligned: true });
    expect(ok.status).toBe("ebreak");
    expect(ok.regs[9]).toBe(0x11ffff7f);
    expect(ok.regs[18]).toBe(0xff7f);
    expect(run(`${data}sh t0, 1(t0)\nebreak`).error!.kind).toBe("store-address-misaligned");
  });

  test("access faults outside memory", () => {
    expect(run("li t0, 0x10000\nlw a0, 0(t0)").error).toMatchObject({ kind: "load-access-fault", pc: 4 });
    expect(run("li t0, -4\nsw a0, 0(t0)").error!.kind).toBe("store-access-fault");
    expect(run("li t0, 0x20000\njr t0").error!.kind).toBe("instruction-access-fault");
  });

  test("sp starts at the 16-byte-aligned top of memory; options set registers", () => {
    expect(run("ebreak").regs[2]).toBe(65536);
    expect(run("ebreak", { memBytes: 1000 }).regs[2]).toBe(992);
    expect(run("ebreak", { stackTop: 0x8007, regs: { 10: 5 } }).regs.slice(0, 11)).toEqual(new Int32Array([0, 0, 0x8000, 0, 0, 0, 0, 0, 0, 0, 5]));
  });

  test("a store into the text changes the code that runs (self-modifying code)", () => {
    // Overwrite the instruction at `patch` (addi a0, zero, 1) with addi a0, zero, 2.
    const h = run(`la t0, patch\nli t1, 0x00200513\nsw t1, 0(t0)\npatch: addi a0, zero, 1\nebreak`);
    expect(h.regs[10]).toBe(2);
  });
});

describe("control flow and traps", () => {
  test("branches, jal and jalr link and land", () => {
    const h = run(`
      li a0, 0
      li t0, 5
    loop: addi a0, a0, 2
      addi t0, t0, -1
      bgtz t0, loop
      jal ra, f
      ebreak
    f: addi a0, a0, 100
      ret
    `);
    expect(h.regs[10]).toBe(110);
    expect(h.regs[1]).toBe(24);
    const b = h.trace.filter((d) => d.inst.op === "blt");
    expect(b.map((d) => d.taken)).toEqual([true, true, true, true, false]);
  });

  test("jalr clears bit 0 of the target; a target not 4-byte aligned traps on the jump", () => {
    expect(run("la t0, x\naddi t0, t0, 1\njr t0\nebreak\nx: li a0, 9\nebreak").regs[10]).toBe(9);
    const h = run("la t0, x\naddi t0, t0, 2\njr t0\nebreak\nx: ebreak");
    expect(h.error).toMatchObject({ kind: "instruction-address-misaligned", pc: 12 });
  });

  test("illegal instruction: jumping into data", () => {
    const h = run(".data\nd: .word 0xffffffff\n.text\nla t0, d\njr t0");
    expect(h.error).toMatchObject({ kind: "illegal-instruction", pc: 0x1000 });
    expect(h.instret).toBe(3);
  });

  test("ecall exit, write and an unknown call", () => {
    const h = run(`.data\nm: .ascii "hi!"\n.text\nli a0, 1\nla a1, m\nli a2, 3\nli a7, 64\necall\nmv s1, a0\nli a7, 999\necall\nmv s2, a0\nli a0, 7\nli a7, 93\necall\nli a0, 8`);
    expect(h.status).toBe("exited");
    expect(h.exitCode).toBe(7);
    expect(h.output).toBe("hi!");
    expect(h.regs[9]).toBe(3);
    expect(h.regs[18]).toBe(-38);
    expect(h.pc).toBe(h.trace.at(-1)!.pc + 4);
    expect(h.step()).toBe(false); // stopped
  });

  test("ebreak stops", () => {
    const h = run("li a0, 1\nebreak\nli a0, 2");
    expect(h.status).toBe("ebreak");
    expect(h.regs[10]).toBe(1);
  });
});

describe("trace, snapshot and stats", () => {
  test("DynInst fields", () => {
    const h = run(".data\nd: .word 5\n.text\nla t0, d\nlw t1, 0(t0)\nadd t2, t1, t1\nbeq t2, t1, x\nx: ebreak");
    const [, , lw, add, beq] = h.trace;
    expect(lw).toMatchObject({ seq: 2, pc: 8, cls: "load", rd: 6, rs1: 5, rs2: 0, rs1Val: 0x1000, result: 5, memAddr: 0x1000, memSize: 4, nextPc: 12 });
    expect(add).toMatchObject({ cls: "alu", rd: 7, rs1: 6, rs2: 6, rs1Val: 5, rs2Val: 5, result: 10 });
    expect(beq).toMatchObject({ cls: "branch", rd: 0, rs1: 7, rs2: 6, taken: false, nextPc: 20 });
    expect(lw!.word).toBe(h.program.words[2]);
    expect(h.counts).toEqual({ alu: 3, mul: 0, div: 0, load: 1, store: 0, branch: 1, jump: 0, system: 1 });
    expect(h.instret).toBe(6);
  });

  test("snapshot after each step", () => {
    const r = assemble(".data\nd: .word 5\n.text\nla t0, d\nsw t0, 0(t0)\nlw a0, 0(t0)\nebreak");
    const h = new Hart(r.program);
    h.step(); h.step();
    expect(h.snapshot()).toMatchObject({ pc: 8, changed: [5], reads: [], writes: [] });
    h.step();
    expect(h.snapshot()).toMatchObject({ changed: [], writes: [{ addr: 0x1000, size: 4, value: 0x1000 }] });
    h.step();
    const s = h.snapshot();
    expect(s).toMatchObject({ changed: [10], reads: [{ addr: 0x1000, size: 4, value: 0x1000 }], instret: 4 });
    expect(s.regs[10]).toBe(0x1000);
    expect(s.last!.inst.op).toBe("lw");
  });

  test("trace: false keeps no trace, and onInst still sees every instruction", () => {
    let n = 0;
    const h = run("li t0, 100\nl: addi t0, t0, -1\nbnez t0, l\nebreak", { trace: false, onInst: () => n++ });
    expect(h.trace).toEqual([]);
    expect(n).toBe(h.instret);
    expect(h.instret).toBe(202);
  });

  test("deterministic: two runs give the same trace", () => {
    const src = "li t0, 50\nli a0, 1\nl: mul a0, a0, t0\naddi t0, t0, -1\nbnez t0, l\nebreak";
    expect(run(src).trace).toEqual(run(src).trace);
  });

  test("performance: 1,000,000 instructions with trace: false in well under a second", () => {
    const r = assemble("li t0, 250000\nli a0, 0\nl: add a0, a0, t0\naddi t0, t0, -1\nlw t1, -4(sp)\nbnez t0, l\nebreak");
    const h = new Hart(r.program, { trace: false });
    const t0 = performance.now();
    h.run();
    const ms = performance.now() - t0;
    expect(h.instret).toBe(1_000_004); // li 250000 is lui + addi
    expect(ms).toBeLessThan(1000);
  });
});
