import { describe, expect, test } from "vitest";
import {
  classOf, decode, disasm, dstReg, encode, fields, immRange, MNEMONICS, OPS, parseReg, REG_ABI, srcRegs, type Inst, type Mnemonic,
} from "../../src/sims/arch/rv";
import { mulberry32 } from "../../src/sims/rng";

/**
 * Known words. Source: the LLVM integrated assembler (zig cc 0.17.1, -target riscv32-freestanding -mcpu=generic_rv32+m,
 * .option norvc), checked by hand against the field layouts of the RV32I chapter. addi x1, x0, 1 = 0x00100093,
 * ecall = 0x00000073 and ebreak = 0x00100073 also follow directly from the spec's encoding tables.
 */
const KNOWN: [string, number][] = [
  ["addi ra, zero, 1", 0x00100093],
  ["lw a0, 8(sp)", 0x00812503],
  ["sw a1, -4(s0)", 0xfeb42e23],
  ["beq a0, a1, -8", 0xfeb50ce3],
  ["bne t0, zero, -4096", 0x80029063],
  ["jal ra, 2048", 0x001000ef],
  ["jal zero, -1048576", 0x8000006f],
  ["lui a0, 0x12345", 0x12345537],
  ["auipc t1, 0xfffff", 0xfffff317],
  ["jalr ra, 0(a0)", 0x000500e7],
  ["srai a0, a1, 31", 0x41f5d513],
  ["slli t2, t3, 7", 0x007e1393],
  ["sub s1, s2, s3", 0x413904b3],
  ["mulhsu a0, a1, a2", 0x02c5a533],
  ["divu t0, t1, t2", 0x027352b3],
  ["remu a5, a6, a7", 0x031877b3],
  ["lbu s11, -2048(t6)", 0x800fcd83],
  ["sh t6, 2047(ra)", 0x7ff09fa3],
  ["sltiu a0, a0, -1", 0xfff53513],
  ["ecall", 0x00000073],
  ["ebreak", 0x00100073],
  ["fence iorw, iorw", 0x0ff0000f],
];

describe("encodings", () => {
  test.each(KNOWN)("%s = %#x", (text, word) => {
    const inst = decode(word);
    expect(inst).not.toBeNull();
    expect(disasm(inst!)).toBe(text);
    expect(encode(inst!)).toBe(word);
  });

  test("every mnemonic round-trips with random operands", () => {
    const r = mulberry32(1);
    const ri = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    for (const m of MNEMONICS) {
      for (let n = 0; n < 300; n++) {
        const g = immRange(m);
        let imm = g.max > g.min ? ri(g.min, g.max) : g.min;
        imm -= ((imm % g.align) + g.align) % g.align;
        const sys = m === "ecall" || m === "ebreak";
        const fmt = OPS[m].fmt;
        const inst: Inst = {
          op: m, imm,
          rd: sys || fmt === "S" || fmt === "B" ? 0 : ri(0, 31),
          rs1: sys || fmt === "U" || fmt === "J" ? 0 : ri(0, 31),
          rs2: fmt === "R" || fmt === "S" || fmt === "B" ? ri(0, 31) : 0,
        };
        const w = encode(inst);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(decode(w)).toEqual(inst);
      }
    }
  });

  test("random words: decode then encode gives the word back, or the word is illegal", () => {
    const r = mulberry32(2);
    let legal = 0;
    for (let n = 0; n < 200_000; n++) {
      const w = Math.floor(r() * 2 ** 32) >>> 0;
      const i = decode(w);
      if (i) { legal++; expect(encode(i)).toBe(w); }
    }
    expect(legal).toBeGreaterThan(1000);
  });

  test("illegal words", () => {
    expect(decode(0)).toBeNull(); // low bits 00: a compressed encoding, and the all-zero word is defined illegal
    expect(decode(0xffffffff)).toBeNull();
    expect(decode(0x02051513)).toBeNull(); // slli with shamt[5] = 1: reserved on RV32
    expect(decode(0x0000100f)).toBeNull(); // fence.i (Zifencei): not modelled
    expect(decode(0x30200073)).toBeNull(); // mret: privileged
    expect(decode(0x00003503)).toBeNull(); // ld (funct3 3): RV64 only
    expect(decode(0x0200006f | (1 << 12))).not.toBeNull(); // jal has no funct3
    expect(decode(0x40001033)).toBeNull(); // sll with funct7 0x20
  });

  test("encode rejects immediates that do not fit", () => {
    expect(() => encode({ op: "addi", rd: 1, rs1: 1, rs2: 0, imm: 2048 })).toThrow(RangeError);
    expect(() => encode({ op: "beq", rd: 0, rs1: 1, rs2: 2, imm: 3 })).toThrow(RangeError);
    expect(() => encode({ op: "lui", rd: 1, rs1: 0, rs2: 0, imm: -1 })).toThrow(RangeError);
    expect(() => encode({ op: "slli", rd: 1, rs1: 1, rs2: 0, imm: 32 })).toThrow(RangeError);
    expect(() => encode({ op: "add", rd: 32, rs1: 1, rs2: 0, imm: 0 })).toThrow(RangeError);
  });
});

describe("fields", () => {
  test("names and bit ranges of each format", () => {
    expect(fields(0x413904b3).map((f) => f.name)).toEqual(["funct7", "rs2", "rs1", "funct3", "rd", "opcode"]);
    expect(fields(0x00812503).map((f) => f.name)).toEqual(["imm[11:0]", "rs1", "funct3", "rd", "opcode"]);
    expect(fields(0xfeb42e23).map((f) => f.name)).toEqual(["imm[11:5]", "rs2", "rs1", "funct3", "imm[4:0]", "opcode"]);
    expect(fields(0xfeb50ce3).map((f) => f.name)).toEqual(["imm[12|10:5]", "rs2", "rs1", "funct3", "imm[4:1|11]", "opcode"]);
    expect(fields(0x12345537).map((f) => f.name)).toEqual(["imm[31:12]", "rd", "opcode"]);
    expect(fields(0x001000ef).map((f) => f.name)).toEqual(["imm[20|10:1|11|19:12]", "rd", "opcode"]);
    expect(fields(0x41f5d513).map((f) => f.name)).toEqual(["funct7", "shamt", "rs1", "funct3", "rd", "opcode"]);
    expect(fields(0x00100073).map((f) => f.name)).toEqual(["funct12", "rs1", "funct3", "rd", "opcode"]);
    expect(fields(0).map((f) => f.name)).toEqual(["?", "opcode"]);
  });

  test("fields cover bits 31..0 with no gap, and their values rebuild the word", () => {
    const r = mulberry32(3);
    for (let n = 0; n < 2000; n++) {
      const w = Math.floor(r() * 2 ** 32) >>> 0;
      const fs = fields(w);
      let bit = 31, back = 0;
      for (const f of fs) {
        expect(f.hi).toBe(bit);
        back = back * 2 ** (f.hi - f.lo + 1) + f.value;
        bit = f.lo - 1;
      }
      expect(bit).toBe(-1);
      expect(back).toBe(w);
    }
  });

  test("lw a0, 8(sp): the values of the fields", () => {
    const f = Object.fromEntries(fields(0x00812503).map((x) => [x.name, x.value]));
    expect(f).toEqual({ "imm[11:0]": 8, rs1: 2, funct3: 2, rd: 10, opcode: 0x03 });
  });
});

describe("registers and text", () => {
  test("ABI names", () => {
    expect(REG_ABI).toHaveLength(32);
    expect(REG_ABI.slice(0, 11)).toEqual(["zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0"]);
    expect(REG_ABI[17]).toBe("a7");
    expect(REG_ABI[18]).toBe("s2");
    expect(REG_ABI[27]).toBe("s11");
    expect(REG_ABI[31]).toBe("t6");
    expect(parseReg("fp")).toBe(8);
    expect(parseReg("x31")).toBe(31);
    expect(parseReg("x32")).toBeNull();
    expect(parseReg("A0")).toBeNull();
  });

  test("disasm with pc, labels and pseudo-instructions", () => {
    const beq = decode(0xfeb50ce3)!;
    expect(disasm(beq, 0x100)).toBe("beq a0, a1, 0xf8");
    expect(disasm(beq, 0x100, { symbol: (a) => (a === 0xf8 ? "loop" : undefined) })).toBe("beq a0, a1, loop");
    expect(disasm(0x00100093, undefined, { abi: false })).toBe("addi x1, x0, 1");
    const P = (i: Partial<Inst> & { op: Mnemonic }) => disasm({ rd: 0, rs1: 0, rs2: 0, imm: 0, ...i }, 0x10, { pseudo: true });
    expect(P({ op: "addi" })).toBe("nop");
    expect(P({ op: "addi", rd: 10, imm: -5 })).toBe("li a0, -5");
    expect(P({ op: "addi", rd: 10, rs1: 11 })).toBe("mv a0, a1");
    expect(P({ op: "xori", rd: 10, rs1: 11, imm: -1 })).toBe("not a0, a1");
    expect(P({ op: "sub", rd: 10, rs2: 11 })).toBe("neg a0, a1");
    expect(P({ op: "sltiu", rd: 10, rs1: 11, imm: 1 })).toBe("seqz a0, a1");
    expect(P({ op: "sltu", rd: 10, rs2: 11 })).toBe("snez a0, a1");
    expect(P({ op: "bne", rs1: 5, imm: -4 })).toBe("bnez t0, 0xc");
    expect(P({ op: "bge", rs2: 5, imm: 8 })).toBe("blez t0, 0x18");
    expect(P({ op: "blt", rs2: 5, imm: 8 })).toBe("bgtz t0, 0x18");
    expect(P({ op: "jal", imm: 8 })).toBe("j 0x18");
    expect(P({ op: "jal", rd: 1, imm: 8 })).toBe("jal 0x18");
    expect(P({ op: "jalr", rs1: 1 })).toBe("ret");
    expect(P({ op: "jalr", rs1: 5 })).toBe("jr t0");
    expect(P({ op: "jalr", rd: 1, rs1: 5 })).toBe("jalr t0");
    expect(P({ op: "fence", imm: 0xff })).toBe("fence");
    expect(P({ op: "add", rd: 1, rs1: 2, rs2: 3 })).toBe("add ra, sp, gp");
    expect(disasm(0xffffffff)).toBe("unknown 0xffffffff");
  });

  test("classes, sources and destinations", () => {
    const d = (w: number) => decode(w)!;
    expect(classOf("lw")).toBe("load");
    expect(classOf("sh")).toBe("store");
    expect(classOf("bgeu")).toBe("branch");
    expect(classOf("jalr")).toBe("jump");
    expect(classOf("mulhu")).toBe("mul");
    expect(classOf("rem")).toBe("div");
    expect(classOf("lui")).toBe("alu");
    expect(classOf("ecall")).toBe("system");
    expect(srcRegs(d(0x413904b3))).toEqual([18, 19]);
    expect(dstReg(d(0x413904b3))).toBe(9);
    expect(srcRegs(d(0xfeb42e23))).toEqual([8, 11]);
    expect(dstReg(d(0xfeb42e23))).toBe(0);
    expect(srcRegs(d(0x00812503))).toEqual([2]);
    expect(srcRegs(d(0x12345537))).toEqual([]);
    expect(srcRegs(d(0x00000073))).toEqual([]);
    expect(dstReg(d(0x8000006f))).toBe(0); // j: rd = x0
    expect(dstReg(d(0x001000ef))).toBe(1);
  });
});
