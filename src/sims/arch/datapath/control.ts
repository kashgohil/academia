/**
 * The parts of an RV32IM datapath that both the single-cycle and the multi-cycle machine share: the ALU, the
 * immediate generator, the ALU decoder, and the main decoder of the single-cycle machine as an editable truth table.
 *
 * The design follows the single-cycle RISC-V datapath of Patterson & Hennessy (Computer Organization and Design,
 * RISC-V edition, section 4.4) and of Harris & Harris (Digital Design and Computer Architecture, RISC-V edition,
 * section 7.3), extended to all of RV32I and the M extension:
 * - Branches: the ALU subtracts rs1 - rs2 and sets four flags (Z zero, N negative, V signed overflow, C carry out).
 *   Branch logic picks the condition from funct3: beq Z, bne !Z, blt N^V, bge !(N^V), bltu !C, bgeu C.
 * - The data memory takes its access size and its sign extension from funct3 (lb lh lw lbu lhu sb sh sw).
 * - The ALU decoder looks at ALUOp, funct3, op5 (bit 5 of the opcode: 1 for R-type), funct7[5] and funct7[0].
 *   A subtract needs op5 AND funct7[5]; an M operation needs op5 AND funct7[0]. Without op5, the immediate bits of
 *   an I-type instruction (bits 30 and 25) would select sub or mul (see `AluDecoderBugs`).
 * - ecall and ebreak raise `Sys`; the machine then hands over to the emulated kernel, as the hart does.
 *
 * Pure functions and plain data: no React, no state.
 */
import { mulh, mulhsu, mulhu } from "../rv";

// ---------------------------------------------------------------- the ALU

export const ALU_OPS = [
  "add", "sub", "sll", "slt", "sltu", "xor", "srl", "sra", "or", "and",
  "mul", "mulh", "mulhsu", "mulhu", "div", "divu", "rem", "remu",
] as const;
export type AluOp = (typeof ALU_OPS)[number];

export interface AluFlags { z: boolean; n: boolean; v: boolean; c: boolean }
export interface AluOut { y: number; flags: AluFlags }

/** Flags of a - b as a 32-bit subtractor makes them: a + ~b + 1. */
export function subFlags(a: number, b: number): AluFlags {
  const y = (a - b) | 0;
  return {
    z: y === 0,
    n: y < 0,
    v: ((a ^ b) & (a ^ y)) < 0, // operands of different sign, and the sign of the result differs from a
    c: a >>> 0 >= b >>> 0, // carry out of a + ~b + 1: 1 when no borrow
  };
}

/**
 * One ALU operation on signed int32 inputs. Z and N come from the result. V and C come from the adder: for sub they
 * are the flags of a - b, for add the flags of a + b, and for every other operation they are 0. Branch logic reads
 * them, so a branch is right only when the ALU subtracts.
 */
export function alu(op: AluOp, a: number, b: number): AluOut {
  let y: number;
  switch (op) {
    case "add": y = (a + b) | 0; break;
    case "sub": y = (a - b) | 0; break;
    case "sll": y = a << (b & 31); break;
    case "slt": y = a < b ? 1 : 0; break;
    case "sltu": y = a >>> 0 < b >>> 0 ? 1 : 0; break;
    case "xor": y = a ^ b; break;
    case "srl": y = (a >>> (b & 31)) | 0; break;
    case "sra": y = a >> (b & 31); break;
    case "or": y = a | b; break;
    case "and": y = a & b; break;
    case "mul": y = Math.imul(a, b); break;
    case "mulh": y = mulh(a, b); break;
    case "mulhsu": y = mulhsu(a, b); break;
    case "mulhu": y = mulhu(a, b); break;
    case "div": y = b === 0 ? -1 : a === -0x80000000 && b === -1 ? a : (a / b) | 0; break;
    case "divu": y = b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) | 0; break;
    case "rem": y = b === 0 ? a : a === -0x80000000 && b === -1 ? 0 : (a % b) | 0; break;
    case "remu": y = b === 0 ? a : ((a >>> 0) % (b >>> 0)) | 0; break;
  }
  if (op === "sub") return { y, flags: subFlags(a, b) };
  const flags = { z: y === 0, n: y < 0, v: false, c: false };
  if (op === "add") { flags.v = (~(a ^ b) & (a ^ y)) < 0; flags.c = (a >>> 0) + (b >>> 0) > 0xffffffff; }
  return { y, flags };
}

/** Branch logic: is the branch with this funct3 taken, given the flags of rs1 - rs2? Unknown funct3 gives false. */
export function branchCond(funct3: number, f: AluFlags): boolean {
  switch (funct3) {
    case 0: return f.z;
    case 1: return !f.z;
    case 4: return f.n !== f.v;
    case 5: return f.n === f.v;
    case 6: return !f.c;
    case 7: return f.c;
    default: return false;
  }
}

// ---------------------------------------------------------------- the immediate generator

export const IMM_SRCS = ["I", "S", "B", "U", "J"] as const;
export type ImmSrc = (typeof IMM_SRCS)[number];

/**
 * Where each bit of the 32-bit immediate comes from, per format: an instruction bit number, or -1 for a constant 0.
 * Index = immediate bit (0..31). Bit 31 of the instruction is the sign; it fills every bit above the field.
 */
export const IMM_SOURCE: Record<ImmSrc, number[]> = (() => {
  const s = (f: (i: number) => number) => Array.from({ length: 32 }, (_, i) => f(i));
  return {
    I: s((i) => (i <= 10 ? 20 + i : 31)),
    S: s((i) => (i <= 4 ? 7 + i : i <= 10 ? 20 + i : 31)),
    B: s((i) => (i === 0 ? -1 : i <= 4 ? 7 + i : i <= 10 ? 20 + i : i === 11 ? 7 : 31)),
    U: s((i) => (i < 12 ? -1 : i)),
    J: s((i) => (i === 0 ? -1 : i <= 10 ? 20 + i : i === 11 ? 20 : i <= 19 ? i : 31)),
  };
})();

/** The sign-extended immediate of an instruction word, wired as IMM_SOURCE says. */
export function immGen(word: number, src: ImmSrc): number {
  const map = IMM_SOURCE[src];
  let v = 0;
  for (let i = 0; i < 32; i++) {
    const b = map[i]!;
    if (b >= 0 && (word >>> b) & 1) v |= 1 << i;
  }
  return v | 0;
}

/**
 * A layout that a naive designer might pick: every format keeps its immediate bits in order (no scrambling), in the
 * same instruction bits as the real format, and the sign is the top bit of each immediate. B holds imm[12:1] where S
 * holds imm[11:0]; J holds imm[20:1] in bits 31:12, where U holds imm[31:12].
 */
export const IMM_SOURCE_NAIVE: Record<ImmSrc, number[]> = (() => {
  const s = (f: (i: number) => number) => Array.from({ length: 32 }, (_, i) => f(i));
  // the field bits in order, low to high
  const sField = [7, 8, 9, 10, 11, 25, 26, 27, 28, 29, 30, 31];
  const jField = Array.from({ length: 20 }, (_, k) => 12 + k);
  return {
    I: IMM_SOURCE.I,
    S: IMM_SOURCE.S,
    B: s((i) => (i === 0 ? -1 : i <= 12 ? sField[i - 1]! : 31)),
    U: IMM_SOURCE.U,
    J: s((i) => (i === 0 ? -1 : i <= 20 ? jField[i - 1]! : 31)),
  };
})();

/**
 * The cost of an immediate layout as a multiplexer count: for each immediate bit, the number of distinct sources
 * (instruction bits, or the constant 0) over the five formats. A bit with one source needs no multiplexer; a bit with
 * k sources needs a k-input multiplexer. `inputs` is the sum of k over the bits that need one.
 */
export function immMuxCost(layout: Record<ImmSrc, number[]>): { perBit: number[]; muxBits: number; inputs: number } {
  const perBit = Array.from({ length: 32 }, (_, i) => new Set(IMM_SRCS.map((f) => layout[f][i]!)).size);
  return { perBit, muxBits: perBit.filter((k) => k > 1).length, inputs: perBit.reduce((s, k) => s + (k > 1 ? k : 0), 0) };
}

// ---------------------------------------------------------------- the main decoder (single-cycle)

/** The 11 major opcodes of RV32IM, as rows of the main decoder. */
export const OP_TYPES = ["R", "I-ALU", "Load", "Store", "Branch", "JAL", "JALR", "LUI", "AUIPC", "System", "Fence"] as const;
export type OpType = (typeof OP_TYPES)[number];

export const OPCODE_OF: Record<OpType, number> = {
  R: 0x33, "I-ALU": 0x13, Load: 0x03, Store: 0x23, Branch: 0x63, JAL: 0x6f, JALR: 0x67, LUI: 0x37, AUIPC: 0x17, System: 0x73, Fence: 0x0f,
};
const TYPE_BY_OPCODE = new Map(OP_TYPES.map((t) => [OPCODE_OF[t], t] as const));
export const opTypeOf = (word: number): OpType | null => TYPE_BY_OPCODE.get(word & 0x7f) ?? null;

/** A control signal, its width in bits, and the meaning of each value. */
export interface SignalSpec { name: Signal; bits: number; values: string[]; about: string }

export const SIGNALS = ["RegWrite", "ImmSrc", "ALUSrcA", "ALUSrcB", "MemRead", "MemWrite", "ResultSrc", "Branch", "Jump", "TargetSrc", "ALUOp", "Sys"] as const;
export type Signal = (typeof SIGNALS)[number];

export const SIGNAL_SPEC: Record<Signal, SignalSpec> = {
  RegWrite: { name: "RegWrite", bits: 1, values: ["0", "1"], about: "write Result into register rd at the clock edge" },
  ImmSrc: { name: "ImmSrc", bits: 3, values: ["I", "S", "B", "U", "J"], about: "which format the immediate generator decodes" },
  ALUSrcA: { name: "ALUSrcA", bits: 2, values: ["rs1", "PC", "0"], about: "ALU input A: register rs1, the PC, or zero" },
  ALUSrcB: { name: "ALUSrcB", bits: 1, values: ["rs2", "imm"], about: "ALU input B: register rs2 or the immediate" },
  MemRead: { name: "MemRead", bits: 1, values: ["0", "1"], about: "the data memory drives its read port" },
  MemWrite: { name: "MemWrite", bits: 1, values: ["0", "1"], about: "write rs2 into the data memory at the clock edge" },
  ResultSrc: { name: "ResultSrc", bits: 2, values: ["ALU", "Mem", "PC+4"], about: "what goes to the register write port" },
  Branch: { name: "Branch", bits: 1, values: ["0", "1"], about: "take the target if the branch condition holds" },
  Jump: { name: "Jump", bits: 1, values: ["0", "1"], about: "always take the target" },
  TargetSrc: { name: "TargetSrc", bits: 1, values: ["PC+imm", "ALU"], about: "jump target: the branch adder, or the ALU (jalr)" },
  ALUOp: { name: "ALUOp", bits: 2, values: ["add", "sub", "funct"], about: "add, subtract (compare), or decode funct3 and funct7" },
  Sys: { name: "Sys", bits: 1, values: ["0", "1"], about: "ecall or ebreak: hand over to the kernel" },
};

/** One row of the main decoder: a value index per signal, or null for "don't care" (the hardware gives 0). */
export type ControlRow = Record<Signal, number | null>;
export type MainTable = Record<OpType, ControlRow>;

const row = (v: (number | null)[]): ControlRow => Object.fromEntries(SIGNALS.map((s, i) => [s, v[i]!])) as ControlRow;
const x = null;

/** The correct main decoder. Columns in SIGNALS order. */
export const MAIN_TABLE: MainTable = {
  //          RegW ImmS SrcA SrcB MemR MemW Res Br  J  Tgt ALUOp Sys
  R:       row([1, x, 0, 0, 0, 0, 0, 0, 0, x, 2, 0]),
  "I-ALU": row([1, 0, 0, 1, 0, 0, 0, 0, 0, x, 2, 0]),
  Load:    row([1, 0, 0, 1, 1, 0, 1, 0, 0, x, 0, 0]),
  Store:   row([0, 1, 0, 1, 0, 1, x, 0, 0, x, 0, 0]),
  Branch:  row([0, 2, 0, 0, 0, 0, x, 1, 0, 0, 1, 0]),
  JAL:     row([1, 4, x, x, 0, 0, 2, 0, 1, 0, x, 0]),
  JALR:    row([1, 0, 0, 1, 0, 0, 2, 0, 1, 1, 0, 0]),
  LUI:     row([1, 3, 2, 1, 0, 0, 0, 0, 0, x, 0, 0]),
  AUIPC:   row([1, 3, 1, 1, 0, 0, 0, 0, 0, x, 0, 0]),
  System:  row([0, x, x, x, 0, 0, x, 0, 0, x, x, 1]),
  Fence:   row([0, x, x, x, 0, 0, x, 0, 0, x, x, 0]),
};

/** A copy of a table with one cell changed. */
export function withCell(t: MainTable, type: OpType, s: Signal, v: number | null): MainTable {
  return { ...t, [type]: { ...t[type], [s]: v } };
}

/** The cells where a table differs from the correct one. */
export function tableDiff(t: MainTable): { type: OpType; signal: Signal; value: number | null }[] {
  const out: { type: OpType; signal: Signal; value: number | null }[] = [];
  for (const ty of OP_TYPES) for (const s of SIGNALS) if (t[ty][s] !== MAIN_TABLE[ty][s]) out.push({ type: ty, signal: s, value: t[ty][s] });
  return out;
}

/** The concrete control word for an instruction word: don't-cares become 0. Null for an opcode not in the table. */
export interface Controls {
  RegWrite: number; ImmSrc: number; ALUSrcA: number; ALUSrcB: number; MemRead: number; MemWrite: number;
  ResultSrc: number; Branch: number; Jump: number; TargetSrc: number; ALUOp: number; Sys: number;
}
export function mainDecode(word: number, table: MainTable = MAIN_TABLE): { type: OpType; ctrl: Controls } | null {
  const type = opTypeOf(word);
  if (!type) return null;
  return { type, ctrl: controlsOf(table[type]) };
}

/** A row of the table as a concrete control word: don't-cares become 0. */
export const controlsOf = (r: ControlRow): Controls => Object.fromEntries(SIGNALS.map((s) => [s, r[s] ?? 0])) as unknown as Controls;

// ---------------------------------------------------------------- the ALU decoder

/** Design mistakes a learner can switch on in the ALU decoder. */
export interface AluDecoderBugs {
  /** Subtract when funct7[5] = 1, without checking op5: addi with immediate bit 10 set becomes sub. */
  subIgnoresOp5?: boolean;
  /** Select an M operation when funct7[0] = 1, without checking op5: OP-IMM with immediate bit 5 set becomes mul... */
  mIgnoresOp5?: boolean;
  /** Ignore funct7[5] for right shifts: sra and srai become srl and srli. */
  shiftIgnoresF7?: boolean;
}

export interface AluDecoderIn { aluOp: number; funct3: number; op5: number; f7b5: number; f7b0: number }

export const aluDecoderInputs = (word: number, aluOp: number): AluDecoderIn => ({
  aluOp, funct3: (word >>> 12) & 7, op5: (word >>> 5) & 1, f7b5: (word >>> 30) & 1, f7b0: (word >>> 25) & 1,
});

const M_BY_F3: AluOp[] = ["mul", "mulh", "mulhsu", "mulhu", "div", "divu", "rem", "remu"];
const BASE_BY_F3: AluOp[] = ["add", "sll", "slt", "sltu", "xor", "srl", "or", "and"];

/** ALUOp (0 add, 1 sub, 2 funct) + funct3 + op5 + funct7[5] + funct7[0] → the ALU operation. */
export function aluDecode(i: AluDecoderIn, bugs: AluDecoderBugs = {}): AluOp {
  if (i.aluOp === 0 || i.aluOp === 3) return "add";
  if (i.aluOp === 1) return "sub";
  if (i.f7b0 && (i.op5 || bugs.mIgnoresOp5)) return M_BY_F3[i.funct3]!;
  if (i.funct3 === 0) return i.f7b5 && (i.op5 || bugs.subIgnoresOp5) ? "sub" : "add";
  if (i.funct3 === 5) return i.f7b5 && !bugs.shiftIgnoresF7 ? "sra" : "srl";
  return BASE_BY_F3[i.funct3]!;
}

/** The ALU decoder as rows with don't-cares, for display. "-" is a don't-care. */
export const ALU_DECODER_ROWS: { aluOp: string; funct3: string; op5: string; f7b5: string; f7b0: string; out: AluOp; who: string }[] = [
  { aluOp: "00", funct3: "---", op5: "-", f7b5: "-", f7b0: "-", out: "add", who: "lw sw jalr lui auipc" },
  { aluOp: "01", funct3: "---", op5: "-", f7b5: "-", f7b0: "-", out: "sub", who: "beq bne blt bge bltu bgeu" },
  { aluOp: "10", funct3: "000", op5: "0", f7b5: "-", f7b0: "-", out: "add", who: "addi" },
  { aluOp: "10", funct3: "000", op5: "1", f7b5: "0", f7b0: "0", out: "add", who: "add" },
  { aluOp: "10", funct3: "000", op5: "1", f7b5: "1", f7b0: "0", out: "sub", who: "sub" },
  { aluOp: "10", funct3: "001", op5: "-", f7b5: "-", f7b0: "0", out: "sll", who: "sll slli" },
  { aluOp: "10", funct3: "010", op5: "-", f7b5: "-", f7b0: "0", out: "slt", who: "slt slti" },
  { aluOp: "10", funct3: "011", op5: "-", f7b5: "-", f7b0: "0", out: "sltu", who: "sltu sltiu" },
  { aluOp: "10", funct3: "100", op5: "-", f7b5: "-", f7b0: "0", out: "xor", who: "xor xori" },
  { aluOp: "10", funct3: "101", op5: "-", f7b5: "0", f7b0: "0", out: "srl", who: "srl srli" },
  { aluOp: "10", funct3: "101", op5: "-", f7b5: "1", f7b0: "0", out: "sra", who: "sra srai" },
  { aluOp: "10", funct3: "110", op5: "-", f7b5: "-", f7b0: "0", out: "or", who: "or ori" },
  { aluOp: "10", funct3: "111", op5: "-", f7b5: "-", f7b0: "0", out: "and", who: "and andi" },
  { aluOp: "10", funct3: "fff", op5: "1", f7b5: "0", f7b0: "1", out: "mul", who: "mul mulh mulhsu mulhu div divu rem remu (by funct3)" },
];

// ---------------------------------------------------------------- the size of the control as a ROM

/** Bits of one control word of the main decoder. */
export const CONTROL_WORD_BITS = SIGNALS.reduce((s, k) => s + SIGNAL_SPEC[k].bits, 0);
/** Bits to name one of the 18 ALU operations. */
export const ALU_CONTROL_BITS = Math.ceil(Math.log2(ALU_OPS.length));

export interface RomSize { inputs: number; rows: number; width: number; bits: number }
const rom = (inputs: number, width: number): RomSize => ({ inputs, rows: 2 ** inputs, width, bits: 2 ** inputs * width });

/**
 * The control as lookup tables (ROMs), three ways:
 * - flat: one ROM addressed by opcode, funct3 and funct7 (7 + 3 + 7 = 17 bits) that gives the control word and the
 *   ALU operation;
 * - two-level: a main decoder on the 7 opcode bits, plus an ALU decoder on ALUOp, funct3, op5, funct7[5], funct7[0];
 * - the opcode's low 2 bits are always 11 for 32-bit instructions, so the main decoder needs only bits 6:2.
 */
export function controlRomSizes() {
  const flat = rom(17, CONTROL_WORD_BITS + ALU_CONTROL_BITS);
  const main = rom(7, CONTROL_WORD_BITS);
  const main5 = rom(5, CONTROL_WORD_BITS);
  const aluDec = rom(2 + 3 + 3, ALU_CONTROL_BITS);
  return { flat, main, main5, aluDec, twoLevel: main.bits + aluDec.bits, twoLevel5: main5.bits + aluDec.bits };
}
