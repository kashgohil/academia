import { describe, expect, test } from "vitest";
import { assemble, disasm, type Program } from "../../src/sims/arch/rv";

const ok = (src: string): Program => {
  const r = assemble(src);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  return r.program;
};
const text = (p: Program) => p.insts.map((i, k) => disasm(i, p.textBase + 4 * k));
const errs = (src: string) => assemble(src).errors;

describe("assembler", () => {
  test("labels, sections, comments and the layout", () => {
    const p = ok(`
      # a comment
      .data
      x: .word 7   // another comment
      .text
      _start: la a0, x
      loop: lw a1, 0(a0)
            bnez a1, loop # "#" inside a comment
            ret
    `);
    expect(p.textBase).toBe(0);
    expect(p.dataBase).toBe(0x1000);
    expect(p.labels).toEqual({ x: 0x1000, _start: 0, loop: 8 });
    expect(p.entry).toBe(0);
    expect(p.words).toHaveLength(5);
    expect(p.src).toEqual([6, 6, 7, 8, 9]);
    expect(text(p)).toEqual(["auipc a0, 0x1", "addi a0, a0, 0", "lw a1, 0(a0)", "bne a1, zero, 0x8", "jalr zero, 0(ra)"]);
    expect([...p.data]).toEqual([7, 0, 0, 0]);
  });

  test("li: one addi, lui alone, or lui + addi with the carry fix", () => {
    const p = ok(`
      li a0, 2047
      li a0, -2048
      li a0, 0x12345000
      li a0, 0x12345678
      li a0, 0x7ffff800
      li a0, 0xffffffff
      li a0, -2049
      li a0, 0x800
    `);
    expect(text(p)).toEqual([
      "addi a0, zero, 2047",
      "addi a0, zero, -2048",
      "lui a0, 0x12345",
      "lui a0, 0x12345", "addi a0, a0, 1656",
      "lui a0, 0x80000", "addi a0, a0, -2048", // 0x80000000 - 0x800 = 0x7ffff800: the low part is negative
      "addi a0, zero, -1",
      "lui a0, 0xfffff", "addi a0, a0, 2047",
      "lui a0, 0x1", "addi a0, a0, -2048",
    ]);
  });

  test("every pseudo-instruction expands as the RISC-V assembly manual says", () => {
    const p = ok(`
    f: nop
      mv t1, t2
      not t1, t2
      neg t1, t2
      seqz t1, t2
      snez t1, t2
      sltz t1, t2
      sgtz t1, t2
      beqz a0, f
      bnez a0, f
      blez a0, f
      bgez a0, f
      bltz a0, f
      bgtz a0, f
      bgt a0, a1, f
      ble a0, a1, f
      bgtu a0, a1, f
      bleu a0, a1, f
      j f
      jal f
      jr a0
      jalr a0
      ret
      call f
      tail f
      fence
    `);
    expect(text(p)).toEqual([
      "addi zero, zero, 0", "addi t1, t2, 0", "xori t1, t2, -1", "sub t1, zero, t2", "sltiu t1, t2, 1", "sltu t1, zero, t2",
      "slt t1, t2, zero", "slt t1, zero, t2",
      "beq a0, zero, 0x0", "bne a0, zero, 0x0", "bge zero, a0, 0x0", "bge a0, zero, 0x0", "blt a0, zero, 0x0", "blt zero, a0, 0x0",
      "blt a1, a0, 0x0", "bge a1, a0, 0x0", "bltu a1, a0, 0x0", "bgeu a1, a0, 0x0",
      "jal zero, 0x0", "jal ra, 0x0", "jalr zero, 0(a0)", "jalr ra, 0(a0)", "jalr zero, 0(ra)",
      "auipc ra, 0x0", "jalr ra, -92(ra)", "auipc t1, 0x0", "jalr zero, -100(t1)", "fence iorw, iorw",
    ]);
  });

  test("operand forms: jalr, numeric targets, ., %hi/%lo, %pcrel, .equ, characters", () => {
    const p = ok(`
      .equ N, 40
      jalr ra, 4(a0)
      jalr ra, a0, -4
      beq a0, a1, 8
      beq a0, a1, .+8
      lui a0, %hi(0x12345678)
      addi a0, a0, %lo(0x12345678)
    g: auipc a0, %pcrel_hi(d)
      lw a1, %pcrel_lo(g)(a0)
      li a2, N + 2
      li a3, 'A'
      lw a4, (sp)
      .data
    d: .byte 1, -1, 0xff, '\\n'
    `);
    expect(text(p)).toEqual([
      "jalr ra, 4(a0)", "jalr ra, -4(a0)", "beq a0, a1, 0x10", "beq a0, a1, 0x14",
      "lui a0, 0x12345", "addi a0, a0, 1656", "auipc a0, 0x1", "lw a1, -24(a0)",
      "addi a2, zero, 42", "addi a3, zero, 65", "lw a4, 0(sp)",
    ]);
    expect(0x18 + 0x1000 - 24).toBe(p.labels.d); // auipc at 0x18
    expect([...p.data]).toEqual([1, 255, 255, 10]);
  });

  test("data directives", () => {
    const p = ok(`
      .data
      a: .byte 1
      .align 2
      b: .word 0x11223344, b
      c: .half 0x1234, -1
      s: .asciz "hi\\n"
      t: .ascii "ok"
      .balign 8
      z: .space 3
      e: .string "é"
    `);
    expect(p.labels).toMatchObject({ a: 0x1000, b: 0x1004, c: 0x100c, s: 0x1010, t: 0x1014, z: 0x1018, e: 0x101b });
    expect([...p.data]).toEqual([
      1, 0, 0, 0, 0x44, 0x33, 0x22, 0x11, 0x04, 0x10, 0, 0, 0x34, 0x12, 0xff, 0xff, 104, 105, 10, 0, 111, 107, 0, 0,
      0, 0, 0, 0xc3, 0xa9, 0,
    ]);
  });

  test("a long text pushes the data to the next 4 KiB boundary", () => {
    const p = ok(`${"nop\n".repeat(1100)}.data\nx: .word 1`);
    expect(p.dataBase).toBe(0x2000);
    expect(assemble("nop\n.data\nx: .word 1", { dataBase: 0x400 }).program.labels.x).toBe(0x400);
  });

  test(".align in .text pads with nops", () => {
    const p = ok("nop\n.align 4\nx: nop");
    expect(p.labels.x).toBe(16);
    expect(p.words).toEqual([0x13, 0x13, 0x13, 0x13, 0x13]);
  });

  test("errors carry their line and a clear message; all of them are reported", () => {
    const e = errs(`
      addi a0, a0, 2048
      lw a0, 8(q9)
      beq a0, a1, nowhere
      foo a0
      add a0, a1
      li a0, label
    label:
      j 6
      lui a0, 0x100000
      slli a0, a0, 32
      beq a0, a1, 4096
      .data
      add a0, a0, a0
      .word 1 2
    `);
    expect(e.map((x) => x.line)).toEqual([2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 14, 15]);
    const msg = e.map((x) => x.message).join("\n");
    expect(msg).toMatch(/immediate 2048 out of range for addi \(-2048\.\.2047\)/);
    expect(msg).toMatch(/unknown register 'q9'/);
    expect(msg).toMatch(/unknown label or constant 'nowhere'/);
    expect(msg).toMatch(/unknown instruction 'foo'/);
    expect(msg).toMatch(/add expects 3 operands: rd, rs1, rs2/);
    expect(msg).toMatch(/li needs a constant/);
    expect(msg).toMatch(/misaligned target: offset 6/);
    expect(msg).toMatch(/out of range for lui/);
    expect(msg).toMatch(/out of range for slli \(0\.\.31\)/);
    expect(msg).toMatch(/target out of range for beq/);
    expect(msg).toMatch(/instruction 'add' in \.data/);
    expect(assemble("x: nop\nx: nop").errors[0]).toEqual({ line: 2, message: "label 'x' is defined twice" });
  });

  test("a program with errors still has one word per statement (nop fill), so lines stay in place", () => {
    const r = assemble("nop\nadd a0, a0\nnop");
    expect(r.ok).toBe(false);
    expect(r.program.words).toHaveLength(3);
    expect(r.program.src).toEqual([1, 2, 3]);
  });
});
