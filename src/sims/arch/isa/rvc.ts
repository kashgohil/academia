/**
 * Which RV32I instructions have a 16-bit form in the C extension ("C" Extension for Compressed Instructions, RISC-V
 * Unprivileged ISA manual). Each 16-bit instruction expands to exactly one 32-bit instruction, so the check is a
 * list of rules on the 32-bit instruction: the opcode, which registers (many forms reach only x8-x15, the registers
 * that a 3-bit field can name), and the size and alignment of the immediate.
 *
 * Simplifications:
 * - Branch and jump offsets are checked as they are in the 32-bit program. Compression only makes the code smaller,
 *   so a real offset is the same or shorter: the check can miss a branch that would fit, but never accepts one
 *   that does not.
 * - `addi rd, rs, 0` (the `mv` pseudo-instruction) counts as c.mv, which expands to `add rd, x0, rs` with the same
 *   effect. Assemblers do this substitution.
 * - add, and, or and xor are commutative, so either source may equal rd.
 * - RV32C only: c.jal exists (RV32 only); the floating-point forms are out of scope. The later Zcb extension (c.mul,
 *   c.lbu and others) is not included.
 */
import type { Inst, Program } from "../rv";

export interface CForm { ok: boolean; form: string; why: string }

const prime = (r: number) => r >= 8 && r <= 15; // x8..x15: s0, s1, a0..a5
const inRange = (v: number, lo: number, hi: number, mult = 1) => v >= lo && v <= hi && v % mult === 0;
const yes = (form: string, why: string): CForm => ({ ok: true, form, why });
const no = (why: string): CForm => ({ ok: false, form: "", why });

/** The 16-bit form of a 32-bit instruction, or why it has none. */
export function compress(i: Inst): CForm {
  const { op, rd, rs1, rs2, imm } = i;
  const SP = 2;
  switch (op) {
    case "lw":
      if (rs1 === SP && rd !== 0 && inRange(imm, 0, 252, 4)) return yes("c.lwsp", "lw from sp, offset 0..252 in steps of 4");
      if (prime(rd) && prime(rs1) && inRange(imm, 0, 124, 4)) return yes("c.lw", "rd and rs1 in x8..x15, offset 0..124 in steps of 4");
      return no(prime(rd) && prime(rs1) ? "offset not in 0..124 or not a multiple of 4" : "c.lw needs rd and rs1 in x8..x15 (or rs1 = sp)");
    case "sw":
      if (rs1 === SP && inRange(imm, 0, 252, 4)) return yes("c.swsp", "sw to sp, offset 0..252 in steps of 4");
      if (prime(rs2) && prime(rs1) && inRange(imm, 0, 124, 4)) return yes("c.sw", "rs1 and rs2 in x8..x15, offset 0..124 in steps of 4");
      return no(prime(rs2) && prime(rs1) ? "offset not in 0..124 or not a multiple of 4" : "c.sw needs rs1 and rs2 in x8..x15 (or rs1 = sp)");
    case "jal":
      if (!inRange(imm, -2048, 2046, 2)) return no("offset outside ±2 KiB");
      if (rd === 0) return yes("c.j", "jump, offset within ±2 KiB");
      if (rd === 1) return yes("c.jal", "call with ra, offset within ±2 KiB (RV32 only)");
      return no("c.j and c.jal write only x0 or ra");
    case "jalr":
      if (imm !== 0 || rs1 === 0) return no("c.jr and c.jalr need offset 0 and rs1 ≠ x0");
      if (rd === 0) return yes("c.jr", "jump to register");
      if (rd === 1) return yes("c.jalr", "call through register, link in ra");
      return no("c.jalr links only in ra");
    case "beq": case "bne":
      if (rs2 !== 0) return no("c.beqz and c.bnez compare with zero only");
      if (!prime(rs1)) return no("c.beqz and c.bnez need rs1 in x8..x15");
      if (!inRange(imm, -256, 254, 2)) return no("offset outside ±256 B");
      return yes(op === "beq" ? "c.beqz" : "c.bnez", "compare rs1 in x8..x15 with zero, offset within ±256 B");
    case "addi":
      if (rd === 0 && rs1 === 0 && imm === 0) return yes("c.nop", "nop");
      if (rd !== 0 && rs1 === 0 && inRange(imm, -32, 31)) return yes("c.li", "load a 6-bit signed constant");
      if (rd !== 0 && rs1 !== 0 && imm === 0) return yes("c.mv", "register copy (mv)");
      if (rd === SP && rs1 === SP && imm !== 0 && inRange(imm, -512, 496, 16)) return yes("c.addi16sp", "adjust sp by a multiple of 16 in -512..496");
      if (prime(rd) && rs1 === SP && inRange(imm, 4, 1020, 4)) return yes("c.addi4spn", "rd' = sp + 4..1020 in steps of 4");
      if (rd !== 0 && rd === rs1 && imm !== 0 && inRange(imm, -32, 31)) return yes("c.addi", "rd = rd + 6-bit signed constant");
      if (rs1 === 0) return no("c.li takes a constant in -32..31 only");
      if (rs1 === SP || rd === SP) return no("sp forms need a multiple of 16 (c.addi16sp) or of 4 (c.addi4spn)");
      return no(rd !== rs1 ? "c.addi needs rd = rs1 (two-operand form)" : "constant outside -32..31");
    case "lui":
      if (rd === 0 || rd === SP) return no("c.lui cannot write x0 or sp");
      if ((imm >= 1 && imm <= 31) || (imm >= 0xfffe0 && imm <= 0xfffff)) return yes("c.lui", "upper constant that is a 6-bit signed value");
      return no("upper constant is not a 6-bit signed value");
    case "slli":
      if (rd !== 0 && rd === rs1 && imm !== 0) return yes("c.slli", "rd = rd << shamt");
      return no("c.slli needs rd = rs1 and a shift amount of 1..31");
    case "srli": case "srai":
      if (prime(rd) && rd === rs1 && imm !== 0) return yes(`c.${op}`, "rd' = rd' >> shamt, rd' in x8..x15");
      return no(`c.${op} needs rd = rs1 in x8..x15`);
    case "andi":
      if (prime(rd) && rd === rs1 && inRange(imm, -32, 31)) return yes("c.andi", "rd' = rd' & 6-bit signed constant");
      return no("c.andi needs rd = rs1 in x8..x15 and a constant in -32..31");
    case "add":
      if (rd !== 0 && rs1 === 0 && rs2 !== 0) return yes("c.mv", "register copy");
      if (rd !== 0 && ((rd === rs1 && rs2 !== 0) || (rd === rs2 && rs1 !== 0))) return yes("c.add", "rd = rd + rs2 (two-operand form)");
      return no("c.add needs rd to equal one source (two-operand form)");
    case "sub": case "and": case "or": case "xor": {
      const comm = op !== "sub";
      const other = rd === rs1 ? rs2 : comm && rd === rs2 ? rs1 : -1;
      if (prime(rd) && other >= 0 && prime(other)) return yes(`c.${op}`, "two-operand form, both registers in x8..x15");
      return no(`c.${op} needs rd = rs1 and both registers in x8..x15`);
    }
    case "ebreak": return yes("c.ebreak", "breakpoint");
    case "ecall": return no("ecall has no 16-bit form");
    case "mul": case "mulh": case "mulhsu": case "mulhu": case "div": case "divu": case "rem": case "remu":
      return no("the C extension has no M instructions (Zcb later added c.mul)");
    case "lb": case "lbu": case "lh": case "lhu": case "sb": case "sh":
      return no("no byte or halfword loads and stores in C (Zcb later added some)");
    default:
      return no(`${op} has no 16-bit form in RV32C`);
  }
}

export interface Density { insts: number; compressible: number; bytes32: number; bytesC: number; forms: CForm[] }

/** Static code size of a program's text without and with the C extension. */
export function density(p: Program): Density {
  const forms = p.insts.map(compress);
  const compressible = forms.filter((f) => f.ok).length;
  return { insts: forms.length, compressible, bytes32: 4 * forms.length, bytesC: 4 * forms.length - 2 * compressible, forms };
}
