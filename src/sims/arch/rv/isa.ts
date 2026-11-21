/**
 * RV32I and RV32M instruction encodings, after the RISC-V Unprivileged ISA manual (RV32I base 2.1, chapter "RV32I Base
 * Integer Instruction Set"; the M extension 2.0; the opcode map in "RV32/64G Instruction Set Listings").
 *
 * - An instruction is a plain record `Inst = { op, rd, rs1, rs2, imm }`. Fields the format does not use are 0.
 * - `imm` is the value the assembly text shows, not the raw bits:
 *   - I, S: the signed 12-bit immediate (-2048..2047). Shifts (slli, srli, srai): the shift amount 0..31.
 *   - B, J: the signed byte offset from the instruction's own pc. It is even (B: -4096..4094, J: ±1 MiB).
 *   - U (lui, auipc): the 20-bit upper value 0..0xFFFFF, as in `lui a0, 0x12345`. The register gets imm << 12.
 *   - fence: the 12-bit field fm|pred|succ. `fence` alone means `fence iorw, iorw` = 0x0ff.
 * - `encode` throws a RangeError when an immediate does not fit or is misaligned (the assembler checks first and
 *   reports a line number). `decode` returns null for a word that is not an RV32IM instruction: the low two bits are
 *   not 11 (a compressed or reserved encoding), an unknown opcode or funct field, a shift with imm[5] set (reserved on
 *   RV32), a SYSTEM word other than ecall and ebreak (no CSRs here), or fence.i (Zifencei is not modelled).
 * - Registers are numbers 0..31. `REG_ABI` gives the psABI names; `parseReg` reads xN, the ABI names and fp (= s0).
 */

export type Format = "R" | "I" | "S" | "B" | "U" | "J";

export const MNEMONICS = [
  "lui", "auipc", "jal", "jalr",
  "beq", "bne", "blt", "bge", "bltu", "bgeu",
  "lb", "lh", "lw", "lbu", "lhu", "sb", "sh", "sw",
  "addi", "slti", "sltiu", "xori", "ori", "andi", "slli", "srli", "srai",
  "add", "sub", "sll", "slt", "sltu", "xor", "srl", "sra", "or", "and",
  "fence", "ecall", "ebreak",
  "mul", "mulh", "mulhsu", "mulhu", "div", "divu", "rem", "remu",
] as const;
export type Mnemonic = (typeof MNEMONICS)[number];

export interface Inst { op: Mnemonic; rd: number; rs1: number; rs2: number; imm: number }

/** Major opcodes (bits 6:0) from the opcode map. */
export const OPCODE = {
  LOAD: 0x03, MISC_MEM: 0x0f, OP_IMM: 0x13, AUIPC: 0x17, STORE: 0x23, OP: 0x33, LUI: 0x37, BRANCH: 0x63, JALR: 0x67,
  JAL: 0x6f, SYSTEM: 0x73,
} as const;

interface OpInfo { fmt: Format; opcode: number; f3: number; f7: number }
const op = (fmt: Format, opcode: number, f3 = 0, f7 = 0): OpInfo => ({ fmt, opcode, f3, f7 });
const O = OPCODE;

/** Format, opcode, funct3 and funct7 of every instruction (funct7 also holds imm[11:5] of srai, and funct12 of ebreak). */
export const OPS: Record<Mnemonic, OpInfo> = {
  lui: op("U", O.LUI), auipc: op("U", O.AUIPC), jal: op("J", O.JAL), jalr: op("I", O.JALR, 0),
  beq: op("B", O.BRANCH, 0), bne: op("B", O.BRANCH, 1), blt: op("B", O.BRANCH, 4), bge: op("B", O.BRANCH, 5),
  bltu: op("B", O.BRANCH, 6), bgeu: op("B", O.BRANCH, 7),
  lb: op("I", O.LOAD, 0), lh: op("I", O.LOAD, 1), lw: op("I", O.LOAD, 2), lbu: op("I", O.LOAD, 4), lhu: op("I", O.LOAD, 5),
  sb: op("S", O.STORE, 0), sh: op("S", O.STORE, 1), sw: op("S", O.STORE, 2),
  addi: op("I", O.OP_IMM, 0), slti: op("I", O.OP_IMM, 2), sltiu: op("I", O.OP_IMM, 3), xori: op("I", O.OP_IMM, 4),
  ori: op("I", O.OP_IMM, 6), andi: op("I", O.OP_IMM, 7),
  slli: op("I", O.OP_IMM, 1, 0x00), srli: op("I", O.OP_IMM, 5, 0x00), srai: op("I", O.OP_IMM, 5, 0x20),
  add: op("R", O.OP, 0, 0x00), sub: op("R", O.OP, 0, 0x20), sll: op("R", O.OP, 1), slt: op("R", O.OP, 2),
  sltu: op("R", O.OP, 3), xor: op("R", O.OP, 4), srl: op("R", O.OP, 5, 0x00), sra: op("R", O.OP, 5, 0x20),
  or: op("R", O.OP, 6), and: op("R", O.OP, 7),
  fence: op("I", O.MISC_MEM, 0), ecall: op("I", O.SYSTEM, 0, 0), ebreak: op("I", O.SYSTEM, 0, 1),
  mul: op("R", O.OP, 0, 0x01), mulh: op("R", O.OP, 1, 0x01), mulhsu: op("R", O.OP, 2, 0x01), mulhu: op("R", O.OP, 3, 0x01),
  div: op("R", O.OP, 4, 0x01), divu: op("R", O.OP, 5, 0x01), rem: op("R", O.OP, 6, 0x01), remu: op("R", O.OP, 7, 0x01),
};

export const formatOf = (m: Mnemonic): Format => OPS[m].fmt;

// ---------------------------------------------------------------- registers

/** ABI names of x0..x31 (RISC-V psABI, "Integer Register Convention"). x8 is s0, also called fp. */
export const REG_ABI = [
  "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7",
  "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6",
] as const;

const REG_BY_NAME: Record<string, number> = { fp: 8 };
REG_ABI.forEach((n, i) => { REG_BY_NAME[n] = i; REG_BY_NAME[`x${i}`] = i; });

/** x0..x31, an ABI name or fp. Returns null for anything else. Case-sensitive, as in GNU as. */
export function parseReg(name: string): number | null {
  return Object.prototype.hasOwnProperty.call(REG_BY_NAME, name) ? REG_BY_NAME[name]! : null;
}

export const regName = (r: number, abi = true) => (abi ? REG_ABI[r] ?? `x${r}` : `x${r}`);

// ---------------------------------------------------------------- immediates

/** Sign-extend the low `bits` bits of v to a signed 32-bit number. */
export const signExtend = (v: number, bits: number) => (bits >= 32 ? v | 0 : (v << (32 - bits)) >> (32 - bits));

/** The legal immediate range of an instruction: [min, max], and the required alignment of the value. */
export function immRange(m: Mnemonic): { min: number; max: number; align: number } {
  if (m === "slli" || m === "srli" || m === "srai") return { min: 0, max: 31, align: 1 };
  if (m === "fence") return { min: 0, max: 0xfff, align: 1 };
  if (m === "ecall" || m === "ebreak") return { min: 0, max: 0, align: 1 };
  switch (OPS[m].fmt) {
    case "I": case "S": return { min: -2048, max: 2047, align: 1 };
    case "B": return { min: -4096, max: 4094, align: 2 };
    case "J": return { min: -(1 << 20), max: (1 << 20) - 2, align: 2 };
    case "U": return { min: 0, max: 0xfffff, align: 1 };
    case "R": return { min: 0, max: 0, align: 1 };
  }
}

export const immFits = (m: Mnemonic, imm: number) => {
  const r = immRange(m);
  return Number.isInteger(imm) && imm >= r.min && imm <= r.max && imm % r.align === 0;
};

// ---------------------------------------------------------------- encode

const reg = (r: number, what: string) => {
  if (!Number.isInteger(r) || r < 0 || r > 31) throw new RangeError(`${what} must be a register 0..31, got ${r}`);
  return r;
};

/** The 32-bit machine word (unsigned) of an instruction. Throws a RangeError for a bad register or immediate. */
export function encode(inst: Inst): number {
  const info = OPS[inst.op];
  if (!info) throw new RangeError(`unknown instruction ${String(inst.op)}`);
  const { fmt, opcode, f3, f7 } = info;
  if (!immFits(inst.op, inst.imm)) {
    const r = immRange(inst.op);
    throw new RangeError(`${inst.op}: immediate ${inst.imm} is outside ${r.min}..${r.max}${r.align > 1 ? " or not even" : ""}`);
  }
  const rd = reg(inst.rd, "rd"), rs1 = reg(inst.rs1, "rs1"), rs2 = reg(inst.rs2, "rs2"), imm = inst.imm;
  let w: number;
  switch (fmt) {
    case "R":
      w = (f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opcode;
      break;
    case "I":
      if (inst.op === "ecall" || inst.op === "ebreak") w = (f7 << 20) | opcode; // funct12 = 0 or 1, all else 0
      else if (inst.op === "slli" || inst.op === "srli" || inst.op === "srai") w = (f7 << 25) | (imm << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opcode;
      else w = ((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opcode;
      break;
    case "S":
      w = (((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1f) << 7) | opcode;
      break;
    case "B":
      w = (((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12)
        | (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | opcode;
      break;
    case "U":
      w = (imm << 12) | (rd << 7) | opcode;
      break;
    case "J":
      w = (((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20) | (((imm >> 12) & 0xff) << 12)
        | (rd << 7) | opcode;
      break;
  }
  return w >>> 0;
}

// ---------------------------------------------------------------- decode

/** The immediate of a word, by format, as `Inst.imm` holds it. */
export function immOf(word: number, fmt: Format): number {
  const w = word | 0;
  switch (fmt) {
    case "I": return w >> 20;
    case "S": return ((w >> 25) << 5) | ((w >>> 7) & 0x1f);
    case "B": return ((w >> 31) << 12) | (((w >>> 7) & 1) << 11) | (((w >>> 25) & 0x3f) << 5) | (((w >>> 8) & 0xf) << 1);
    case "U": return (w >>> 12) & 0xfffff;
    case "J": return ((w >> 31) << 20) | (((w >>> 12) & 0xff) << 12) | (((w >>> 20) & 1) << 11) | (((w >>> 21) & 0x3ff) << 1);
    case "R": return 0;
  }
}

const BY_KEY = new Map<string, Mnemonic>();
for (const m of MNEMONICS) {
  const { fmt, opcode, f3, f7 } = OPS[m];
  if (m === "ecall" || m === "ebreak") continue;
  const key = fmt === "R" || m === "slli" || m === "srli" || m === "srai" ? `${opcode}.${f3}.${f7}` : fmt === "U" || fmt === "J" ? `${opcode}` : `${opcode}.${f3}`;
  BY_KEY.set(key, m);
}

const mk = (o: Mnemonic, rd = 0, rs1 = 0, rs2 = 0, imm = 0): Inst => ({ op: o, rd, rs1, rs2, imm });

/** The instruction of a 32-bit word, or null if the word is not a legal RV32IM instruction (see the header). */
export function decode(word: number): Inst | null {
  const w = word >>> 0;
  const opcode = w & 0x7f, rd = (w >>> 7) & 31, f3 = (w >>> 12) & 7, rs1 = (w >>> 15) & 31, rs2 = (w >>> 20) & 31, f7 = w >>> 25;
  if ((opcode & 3) !== 3) return null;
  switch (opcode) {
    case O.LUI: case O.AUIPC: case O.JAL: {
      const m = BY_KEY.get(`${opcode}`)!;
      return mk(m, rd, 0, 0, immOf(w, OPS[m].fmt));
    }
    case O.OP: {
      const m = BY_KEY.get(`${opcode}.${f3}.${f7}`);
      return m ? mk(m, rd, rs1, rs2) : null;
    }
    case O.OP_IMM:
      if (f3 === 1 || f3 === 5) {
        const m = BY_KEY.get(`${opcode}.${f3}.${f7}`);
        return m ? mk(m, rd, rs1, 0, rs2) : null; // rs2 field = shamt; imm[5] set gives f7 = 1, 0x21: reserved on RV32
      }
      return mk(BY_KEY.get(`${opcode}.${f3}`)!, rd, rs1, 0, immOf(w, "I"));
    case O.LOAD: case O.JALR: {
      const m = BY_KEY.get(`${opcode}.${f3}`);
      return m ? mk(m, rd, rs1, 0, immOf(w, "I")) : null;
    }
    case O.STORE: case O.BRANCH: {
      const m = BY_KEY.get(`${opcode}.${f3}`);
      return m ? mk(m, 0, rs1, rs2, immOf(w, OPS[m].fmt)) : null;
    }
    case O.MISC_MEM:
      // FENCE: fm, pred and succ in imm[11:0]. rd and rs1 are reserved for future use; we accept any value, as the
      // spec asks of base implementations, and keep them so that encode(decode(w)) === w.
      return f3 === 0 ? mk("fence", rd, rs1, 0, (w >>> 20) & 0xfff) : null;
    case O.SYSTEM:
      if (w === 0x00000073) return mk("ecall");
      if (w === 0x00100073) return mk("ebreak");
      return null;
  }
  return null;
}

// ---------------------------------------------------------------- bit fields

export type FieldKind = "opcode" | "reg" | "funct" | "imm";
export interface Field { name: string; hi: number; lo: number; value: number; kind: FieldKind }

const F = (word: number, name: string, hi: number, lo: number, kind: FieldKind): Field =>
  ({ name, hi, lo, value: (word >>> lo) & (hi - lo === 31 ? 0xffffffff : (1 << (hi - lo + 1)) - 1), kind });

/** The format a word's opcode implies, or null for an unknown opcode. */
export function formatOfWord(word: number): Format | null {
  switch (word & 0x7f) {
    case O.OP: return "R";
    case O.OP_IMM: case O.LOAD: case O.JALR: case O.MISC_MEM: case O.SYSTEM: return "I";
    case O.STORE: return "S";
    case O.BRANCH: return "B";
    case O.LUI: case O.AUIPC: return "U";
    case O.JAL: return "J";
  }
  return null;
}

/**
 * The bit fields of a word for display, from bit 31 down to bit 0, with the names the spec's format diagrams use.
 * The scrambled immediates of S, B and J keep their real names: imm[11:5] and imm[4:0], imm[12|10:5] and imm[4:1|11],
 * imm[20|10:1|11|19:12]. Shifts show funct7 and shamt; ecall and ebreak show funct12; fence shows fm, pred and succ.
 * An unknown opcode gives one "?" field over bits 31:7 and the opcode.
 */
export function fields(word: number): Field[] {
  const w = word >>> 0;
  const opc = F(w, "opcode", 6, 0, "opcode");
  const rd = F(w, "rd", 11, 7, "reg"), f3 = F(w, "funct3", 14, 12, "funct"), rs1 = F(w, "rs1", 19, 15, "reg"), rs2 = F(w, "rs2", 24, 20, "reg");
  const opcode = w & 0x7f;
  switch (formatOfWord(w)) {
    case "R": return [F(w, "funct7", 31, 25, "funct"), rs2, rs1, f3, rd, opc];
    case "I":
      if (opcode === O.SYSTEM) return [F(w, "funct12", 31, 20, "funct"), rs1, f3, rd, opc];
      if (opcode === O.MISC_MEM) return [F(w, "fm", 31, 28, "imm"), F(w, "pred", 27, 24, "imm"), F(w, "succ", 23, 20, "imm"), rs1, f3, rd, opc];
      if (opcode === O.OP_IMM && (f3.value === 1 || f3.value === 5)) return [F(w, "funct7", 31, 25, "funct"), F(w, "shamt", 24, 20, "imm"), rs1, f3, rd, opc];
      return [F(w, "imm[11:0]", 31, 20, "imm"), rs1, f3, rd, opc];
    case "S": return [F(w, "imm[11:5]", 31, 25, "imm"), rs2, rs1, f3, F(w, "imm[4:0]", 11, 7, "imm"), opc];
    case "B": return [F(w, "imm[12|10:5]", 31, 25, "imm"), rs2, rs1, f3, F(w, "imm[4:1|11]", 11, 7, "imm"), opc];
    case "U": return [F(w, "imm[31:12]", 31, 12, "imm"), rd, opc];
    case "J": return [F(w, "imm[20|10:1|11|19:12]", 31, 12, "imm"), rd, opc];
    default: return [F(w, "?", 31, 7, "imm"), opc];
  }
}

// ---------------------------------------------------------------- classes and registers

export type InstClass = "alu" | "mul" | "div" | "load" | "store" | "branch" | "jump" | "system";
export const CLASSES: InstClass[] = ["alu", "mul", "div", "load", "store", "branch", "jump", "system"];

/** The class of an instruction, for statistics and timing. lui and auipc are "alu"; fence, ecall, ebreak are "system". */
export function classOf(m: Mnemonic): InstClass {
  switch (m) {
    case "lb": case "lh": case "lw": case "lbu": case "lhu": return "load";
    case "sb": case "sh": case "sw": return "store";
    case "beq": case "bne": case "blt": case "bge": case "bltu": case "bgeu": return "branch";
    case "jal": case "jalr": return "jump";
    case "fence": case "ecall": case "ebreak": return "system";
    case "mul": case "mulh": case "mulhsu": case "mulhu": return "mul";
    case "div": case "divu": case "rem": case "remu": return "div";
    default: return "alu";
  }
}

/**
 * The registers an instruction reads: [rs1, rs2] for R, S and B; [rs1] for I (loads, jalr, ALU immediates); none for
 * U, J, fence, ecall and ebreak. x0 can appear; it is always 0, so it never makes a hazard.
 */
export function srcRegs(inst: Inst): number[] {
  const { fmt } = OPS[inst.op];
  if (fmt === "R" || fmt === "S" || fmt === "B") return [inst.rs1, inst.rs2];
  if (fmt === "I" && inst.op !== "fence" && inst.op !== "ecall" && inst.op !== "ebreak") return [inst.rs1];
  return [];
}

/** The register an instruction writes, or 0 for none (S, B, fence, ecall, ebreak, or rd = x0). */
export function dstReg(inst: Inst): number {
  const { fmt } = OPS[inst.op];
  if (fmt === "S" || fmt === "B" || inst.op === "fence" || inst.op === "ecall" || inst.op === "ebreak") return 0;
  return inst.rd;
}

// ---------------------------------------------------------------- disassembler

export interface DisasmOptions {
  /** Show common pseudo-instructions: nop, li, mv, not, neg, seqz, snez, sltz, sgtz, beqz, bnez, blez, bgez, bltz, bgtz, j, jal, jr, jalr, ret, fence. */
  pseudo?: boolean;
  /** ABI register names (default) or x0..x31. */
  abi?: boolean;
  /** A name for an address (a label), used for branch and jump targets when pc is given. */
  symbol?: (addr: number) => string | undefined;
}

const hex = (v: number) => `0x${(v >>> 0).toString(16)}`;
const FENCE_SET = (bits: number) => ["i", "o", "r", "w"].filter((_, i) => bits & (8 >> i)).join("") || "0";

/**
 * Assembly text of an instruction (or of a word; an illegal word gives "unknown 0x…"). Branch and jump targets are the
 * signed offset, or the absolute address (or `opts.symbol`'s name) when `pc` is given. lui and auipc show the 20-bit
 * value in hex. Text follows GNU objdump with ABI names: `lw a0, 8(sp)`, `beq a0, a1, 0x10`, `jalr ra, 0(a0)`.
 */
export function disasm(x: Inst | number, pc?: number, opts: DisasmOptions = {}): string {
  const inst = typeof x === "number" ? decode(x) : x;
  if (!inst) return `unknown ${hex(x as number)}`;
  const R = (r: number) => regName(r, opts.abi ?? true);
  const { op: m, rd, rs1, rs2, imm } = inst;
  const target = () => {
    if (pc === undefined) return String(imm);
    const t = (pc + imm) >>> 0;
    return opts.symbol?.(t) ?? hex(t);
  };
  if (opts.pseudo) {
    const p = pseudo(inst, R, target);
    if (p) return p;
  }
  switch (OPS[m].fmt) {
    case "R": return `${m} ${R(rd)}, ${R(rs1)}, ${R(rs2)}`;
    case "S": return `${m} ${R(rs2)}, ${imm}(${R(rs1)})`;
    case "B": return `${m} ${R(rs1)}, ${R(rs2)}, ${target()}`;
    case "U": return `${m} ${R(rd)}, ${hex(imm)}`;
    case "J": return `${m} ${R(rd)}, ${target()}`;
    case "I":
      if (m === "ecall" || m === "ebreak") return m;
      if (m === "fence") return `fence ${FENCE_SET((imm >> 4) & 15)}, ${FENCE_SET(imm & 15)}`;
      if (classOf(m) === "load" || m === "jalr") return `${m} ${R(rd)}, ${imm}(${R(rs1)})`;
      return `${m} ${R(rd)}, ${R(rs1)}, ${imm}`;
  }
}

function pseudo(i: Inst, R: (r: number) => string, target: () => string): string | null {
  const { op: m, rd, rs1, rs2, imm } = i;
  switch (m) {
    case "addi":
      if (rd === 0 && rs1 === 0 && imm === 0) return "nop";
      if (rs1 === 0) return `li ${R(rd)}, ${imm}`;
      if (imm === 0) return `mv ${R(rd)}, ${R(rs1)}`;
      return null;
    case "xori": return imm === -1 ? `not ${R(rd)}, ${R(rs1)}` : null;
    case "sub": return rs1 === 0 ? `neg ${R(rd)}, ${R(rs2)}` : null;
    case "sltiu": return imm === 1 ? `seqz ${R(rd)}, ${R(rs1)}` : null;
    case "sltu": return rs1 === 0 ? `snez ${R(rd)}, ${R(rs2)}` : null;
    case "slt": return rs2 === 0 ? `sltz ${R(rd)}, ${R(rs1)}` : rs1 === 0 ? `sgtz ${R(rd)}, ${R(rs2)}` : null;
    case "beq": return rs2 === 0 ? `beqz ${R(rs1)}, ${target()}` : null;
    case "bne": return rs2 === 0 ? `bnez ${R(rs1)}, ${target()}` : null;
    case "bge": return rs1 === 0 ? `blez ${R(rs2)}, ${target()}` : rs2 === 0 ? `bgez ${R(rs1)}, ${target()}` : null;
    case "blt": return rs2 === 0 ? `bltz ${R(rs1)}, ${target()}` : rs1 === 0 ? `bgtz ${R(rs2)}, ${target()}` : null;
    case "jal": return rd === 0 ? `j ${target()}` : rd === 1 ? `jal ${target()}` : null;
    case "jalr":
      if (imm !== 0) return null;
      if (rd === 0) return rs1 === 1 ? "ret" : `jr ${R(rs1)}`;
      return rd === 1 ? `jalr ${R(rs1)}` : null;
    case "fence": return imm === 0x0ff ? "fence" : null;
    default: return null;
  }
}
