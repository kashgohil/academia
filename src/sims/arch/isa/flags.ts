/**
 * Condition flags against compare-and-branch, on 8-bit values so that overflow is easy to reach.
 *
 * - x86: `cmp a, b` computes a - b and sets ZF (zero), SF (sign), CF (borrow out: a < b unsigned) and OF (signed
 *   overflow). Each jcc reads a formula of flags (Intel SDM Vol. 2, "Jcc"): jl is SF ≠ OF, jb is CF = 1, and so on.
 * - AArch64: `cmp a, b` sets N, Z, C and V. For a subtraction C is NOT borrow: C = 1 when a ≥ b unsigned (Arm ARM,
 *   "Condition flags and related instructions"), so b.hs is C = 1 and b.lo is C = 0.
 * - RISC-V has no flags: blt, bge, bltu and bgeu compare two registers inside the branch. bgt and ble are the same
 *   instructions with the operands swapped.
 */
export interface Flags8 { zf: boolean; sf: boolean; cf: boolean; of: boolean; n: boolean; z: boolean; c: boolean; v: boolean; diff: number }

const u8 = (v: number) => v & 0xff;
const s8 = (v: number) => ((v & 0xff) << 24) >> 24;

/** Flags after cmp a, b with 8-bit operands (a and b given as bit patterns or signed values). */
export function cmp8(a: number, b: number): Flags8 {
  const ua = u8(a), ub = u8(b);
  const diff = u8(ua - ub);
  const zf = diff === 0, sf = (diff & 0x80) !== 0, cf = ua < ub;
  const of = ((ua ^ ub) & (ua ^ diff) & 0x80) !== 0;
  return { zf, sf, cf, of, n: sf, z: zf, c: !cf, v: of, diff };
}

export interface Cond { c: string; x86: string; x86f: string; arm: string; armf: string; rv: string; take: (a: number, b: number) => boolean; read: (f: Flags8) => boolean; armRead: (f: Flags8) => boolean }

/** Conditions for "branch if a OP b". The flag formulas must agree with the direct comparison: the tests check all 65,536 pairs. */
export const CONDS: Cond[] = [
  { c: "a == b", x86: "je", x86f: "ZF = 1", arm: "b.eq", armf: "Z = 1", rv: "beq a, b", take: (a, b) => u8(a) === u8(b), read: (f) => f.zf , armRead: (f) => f.z },
  { c: "a != b", x86: "jne", x86f: "ZF = 0", arm: "b.ne", armf: "Z = 0", rv: "bne a, b", take: (a, b) => u8(a) !== u8(b), read: (f) => !f.zf , armRead: (f) => !f.z },
  { c: "a < b signed", x86: "jl", x86f: "SF ≠ OF", arm: "b.lt", armf: "N ≠ V", rv: "blt a, b", take: (a, b) => s8(a) < s8(b), read: (f) => f.sf !== f.of , armRead: (f) => f.n !== f.v },
  { c: "a >= b signed", x86: "jge", x86f: "SF = OF", arm: "b.ge", armf: "N = V", rv: "bge a, b", take: (a, b) => s8(a) >= s8(b), read: (f) => f.sf === f.of , armRead: (f) => f.n === f.v },
  { c: "a > b signed", x86: "jg", x86f: "ZF = 0 and SF = OF", arm: "b.gt", armf: "Z = 0 and N = V", rv: "blt b, a", take: (a, b) => s8(a) > s8(b), read: (f) => !f.zf && f.sf === f.of , armRead: (f) => !f.z && f.n === f.v },
  { c: "a < b unsigned", x86: "jb", x86f: "CF = 1", arm: "b.lo", armf: "C = 0", rv: "bltu a, b", take: (a, b) => u8(a) < u8(b), read: (f) => f.cf , armRead: (f) => !f.c },
  { c: "a >= b unsigned", x86: "jae", x86f: "CF = 0", arm: "b.hs", armf: "C = 1", rv: "bgeu a, b", take: (a, b) => u8(a) >= u8(b), read: (f) => !f.cf , armRead: (f) => f.c },
  { c: "a > b unsigned", x86: "ja", x86f: "CF = 0 and ZF = 0", arm: "b.hi", armf: "C = 1 and Z = 0", rv: "bltu b, a", take: (a, b) => u8(a) > u8(b), read: (f) => !f.cf && !f.zf , armRead: (f) => f.c && !f.z },
];

export { u8, s8 };
