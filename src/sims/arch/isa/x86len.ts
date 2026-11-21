/**
 * An x86-64 instruction-length decoder for 64-bit mode, after the Intel SDM, Vol. 2, chapter 2 ("Instruction
 * Format") and the opcode maps of appendix A. It finds where each instruction ends and names its parts: legacy
 * prefixes, REX, opcode, ModRM, SIB, displacement and immediate. It does not decode operands into text.
 *
 * Coverage: the whole one-byte opcode map; the two-byte map 0F xx for the common integer and SSE forms; the
 * three-byte maps 0F 38 and 0F 3A. VEX (C4, C5), EVEX (62) and the x87 details beyond ModRM length are out of
 * scope, and so are opcodes that are invalid in 64-bit mode: these give an "unknown" part of one byte, and decoding
 * goes on at the next byte. The golden test compares the lengths with LLVM's disassembler.
 */

export type PartKind = "prefix" | "rex" | "opcode" | "modrm" | "sib" | "disp" | "imm" | "unknown";
export interface Part { kind: PartKind; start: number; len: number }
export interface X86Inst { start: number; len: number; parts: Part[]; name: string; valid: boolean }

const LEGACY = new Set([0xf0, 0xf2, 0xf3, 0x2e, 0x36, 0x3e, 0x26, 0x64, 0x65, 0x66, 0x67]);
// Opcodes that are invalid in 64-bit mode (or prefixes this decoder does not cover: 62 EVEX, C4/C5 VEX).
const INVALID64 = new Set([0x06, 0x07, 0x0e, 0x16, 0x17, 0x1e, 0x1f, 0x27, 0x2f, 0x37, 0x3f, 0x60, 0x61, 0x62, 0x82, 0x9a, 0xc4, 0xc5, 0xce, 0xd4, 0xd5, 0xd6, 0xea]);

type Imm = 0 | 1 | 2 | 4 | "z" | "v" | "m" | 3; // z = 16 or 32 by operand size; v = imm64 with REX.W; m = moffs; 3 = imm16 + imm8

interface Op { modrm: boolean; imm: Imm; name: string }
const O = (modrm: boolean, imm: Imm, name: string): Op => ({ modrm, imm, name });

function oneByte(b: number): Op | null {
  if (INVALID64.has(b)) return null;
  if (b < 0x40) {
    const lo = b & 7;
    const alu = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"][b >> 3]!;
    if (lo <= 3) return O(true, 0, alu);
    if (lo === 4) return O(false, 1, `${alu} al, imm8`);
    if (lo === 5) return O(false, "z", `${alu} eax, imm32`);
    return null; // 0F escape, segment prefixes and the invalid ones are handled elsewhere
  }
  if (b >= 0x50 && b <= 0x57) return O(false, 0, "push r64");
  if (b >= 0x58 && b <= 0x5f) return O(false, 0, "pop r64");
  if (b >= 0x70 && b <= 0x7f) return O(false, 1, "jcc rel8");
  if (b >= 0x91 && b <= 0x97) return O(false, 0, "xchg");
  if (b >= 0xb0 && b <= 0xb7) return O(false, 1, "mov r8, imm8");
  if (b >= 0xb8 && b <= 0xbf) return O(false, "v", "mov r32, imm");
  if (b >= 0xd8 && b <= 0xdf) return O(true, 0, "x87");
  switch (b) {
    case 0x63: return O(true, 0, "movsxd");
    case 0x68: return O(false, "z", "push imm32");
    case 0x69: return O(true, "z", "imul r, r/m, imm32");
    case 0x6a: return O(false, 1, "push imm8");
    case 0x6b: return O(true, 1, "imul r, r/m, imm8");
    case 0x6c: case 0x6d: case 0x6e: case 0x6f: return O(false, 0, "ins/outs");
    case 0x80: return O(true, 1, "alu r/m8, imm8");
    case 0x81: return O(true, "z", "alu r/m, imm32");
    case 0x83: return O(true, 1, "alu r/m, imm8");
    case 0x84: case 0x85: return O(true, 0, "test");
    case 0x86: case 0x87: return O(true, 0, "xchg");
    case 0x88: case 0x89: case 0x8a: case 0x8b: return O(true, 0, "mov");
    case 0x8c: case 0x8e: return O(true, 0, "mov sreg");
    case 0x8d: return O(true, 0, "lea");
    case 0x8f: return O(true, 0, "pop r/m");
    case 0x90: return O(false, 0, "nop");
    case 0x98: case 0x99: return O(false, 0, "cwde/cdq");
    case 0x9b: return O(false, 0, "fwait");
    case 0x9c: case 0x9d: return O(false, 0, "pushf/popf");
    case 0x9e: case 0x9f: return O(false, 0, "sahf/lahf");
    case 0xa0: case 0xa1: case 0xa2: case 0xa3: return O(false, "m", "mov moffs");
    case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf: return O(false, 0, "string op");
    case 0xa8: return O(false, 1, "test al, imm8");
    case 0xa9: return O(false, "z", "test eax, imm32");
    case 0xc0: case 0xc1: return O(true, 1, "shift r/m, imm8");
    case 0xc2: return O(false, 2, "ret imm16");
    case 0xc3: return O(false, 0, "ret");
    case 0xc6: return O(true, 1, "mov r/m8, imm8");
    case 0xc7: return O(true, "z", "mov r/m, imm32");
    case 0xc8: return O(false, 3, "enter");
    case 0xc9: return O(false, 0, "leave");
    case 0xca: return O(false, 2, "retf imm16");
    case 0xcb: return O(false, 0, "retf");
    case 0xcc: return O(false, 0, "int3");
    case 0xcd: return O(false, 1, "int imm8");
    case 0xcf: return O(false, 0, "iret");
    case 0xd0: case 0xd1: case 0xd2: case 0xd3: return O(true, 0, "shift r/m");
    case 0xd7: return O(false, 0, "xlat");
    case 0xe0: case 0xe1: case 0xe2: case 0xe3: return O(false, 1, "loop/jrcxz rel8");
    case 0xe4: case 0xe5: case 0xe6: case 0xe7: return O(false, 1, "in/out imm8");
    case 0xe8: return O(false, 4, "call rel32");
    case 0xe9: return O(false, 4, "jmp rel32");
    case 0xeb: return O(false, 1, "jmp rel8");
    case 0xec: case 0xed: case 0xee: case 0xef: return O(false, 0, "in/out dx");
    case 0xf1: return O(false, 0, "int1");
    case 0xf4: return O(false, 0, "hlt");
    case 0xf5: return O(false, 0, "cmc");
    case 0xf6: return O(true, 0, "group 3 r/m8"); // + imm8 for test (reg 0 or 1): fixed up below
    case 0xf7: return O(true, 0, "group 3 r/m");
    case 0xf8: case 0xf9: case 0xfa: case 0xfb: case 0xfc: case 0xfd: return O(false, 0, "flag op");
    case 0xfe: return O(true, 0, "inc/dec r/m8");
    case 0xff: return O(true, 0, "inc/dec/call/jmp/push r/m");
  }
  return null;
}

function twoByte(b: number): Op | null {
  if (b >= 0x40 && b <= 0x4f) return O(true, 0, "cmovcc");
  if (b >= 0x80 && b <= 0x8f) return O(false, 4, "jcc rel32");
  if (b >= 0x90 && b <= 0x9f) return O(true, 0, "setcc");
  if (b >= 0xc8 && b <= 0xcf) return O(false, 0, "bswap");
  if ((b >= 0x10 && b <= 0x17) || (b >= 0x28 && b <= 0x2f) || (b >= 0x50 && b <= 0x6f) || (b >= 0x74 && b <= 0x76) || b === 0x7e || b === 0x7f || (b >= 0xd0 && b <= 0xfe)) return O(true, 0, "sse");
  if (b >= 0x18 && b <= 0x1f) return O(true, 0, b === 0x1f ? "nop r/m" : "hint nop");
  if (b >= 0x70 && b <= 0x73) return O(true, 1, "sse, imm8");
  switch (b) {
    case 0x05: return O(false, 0, "syscall");
    case 0x0b: return O(false, 0, "ud2");
    case 0x31: return O(false, 0, "rdtsc");
    case 0x77: return O(false, 0, "emms");
    case 0xa2: return O(false, 0, "cpuid");
    case 0xa3: case 0xab: case 0xb3: case 0xbb: return O(true, 0, "bt*");
    case 0xa4: case 0xac: return O(true, 1, "shld/shrd imm8");
    case 0xa5: case 0xad: return O(true, 0, "shld/shrd cl");
    case 0xaf: return O(true, 0, "imul r, r/m");
    case 0xb0: case 0xb1: return O(true, 0, "cmpxchg");
    case 0xb6: case 0xb7: return O(true, 0, "movzx");
    case 0xbe: case 0xbf: return O(true, 0, "movsx");
    case 0xba: return O(true, 1, "bt* imm8");
    case 0xbc: case 0xbd: return O(true, 0, "bsf/bsr");
    case 0xc0: case 0xc1: return O(true, 0, "xadd");
    case 0xc2: case 0xc4: case 0xc5: case 0xc6: return O(true, 1, "sse, imm8");
  }
  return null;
}

/** Decode one instruction at `at`. Never throws; an unknown or cut-off encoding gives a 1-byte "unknown". */
export function decodeAt(bytes: ArrayLike<number>, at: number): X86Inst {
  const parts: Part[] = [];
  let i = at;
  const n = bytes.length;
  const bad = (): X86Inst => ({ start: at, len: 1, parts: [{ kind: "unknown", start: at, len: 1 }], name: "(bad)", valid: false });
  let opsize16 = false, addr32 = false, rexW = false;
  while (i < n && LEGACY.has(bytes[i]!) && i - at < 14) {
    if (bytes[i] === 0x66) opsize16 = true;
    if (bytes[i] === 0x67) addr32 = true;
    parts.push({ kind: "prefix", start: i, len: 1 }); i++;
  }
  if (i < n && (bytes[i]! & 0xf0) === 0x40) { rexW = (bytes[i]! & 8) !== 0; parts.push({ kind: "rex", start: i, len: 1 }); i++; }
  if (i >= n) return bad();
  let op: Op | null;
  const opStart = i;
  if (bytes[i] === 0x0f) {
    i++;
    if (i >= n) return bad();
    const b2 = bytes[i]!;
    if (b2 === 0x38 || b2 === 0x3a) { i++; if (i >= n) return bad(); op = O(true, b2 === 0x3a ? 1 : 0, b2 === 0x3a ? "sse4, imm8" : "sse4"); }
    else op = twoByte(b2);
  } else op = oneByte(bytes[i]!);
  if (!op) return bad();
  i++;
  parts.push({ kind: "opcode", start: opStart, len: i - opStart });
  let imm: number;
  switch (op.imm) {
    case "z": imm = opsize16 ? 2 : 4; break;
    case "v": imm = rexW ? 8 : opsize16 ? 2 : 4; break;
    case "m": imm = addr32 ? 4 : 8; break;
    default: imm = op.imm;
  }
  if (op.modrm) {
    if (i >= n) return bad();
    const m = bytes[i]!;
    const mod = m >> 6, reg = (m >> 3) & 7, rm = m & 7;
    parts.push({ kind: "modrm", start: i, len: 1 }); i++;
    const opb = bytes[opStart]!;
    if (opStart === i - 2 && (opb === 0xf6 || opb === 0xf7) && reg <= 1) imm = opb === 0xf6 ? 1 : opsize16 ? 2 : 4; // test r/m, imm
    let disp = mod === 1 ? 1 : mod === 2 ? 4 : 0;
    if (mod !== 3 && rm === 4) {
      if (i >= n) return bad();
      const sib = bytes[i]!;
      parts.push({ kind: "sib", start: i, len: 1 }); i++;
      if (mod === 0 && (sib & 7) === 5) disp = 4;
    }
    if (mod === 0 && rm === 5) disp = 4; // RIP-relative in 64-bit mode
    if (disp) { parts.push({ kind: "disp", start: i, len: disp }); i += disp; }
  }
  if (imm) { parts.push({ kind: "imm", start: i, len: imm }); i += imm; }
  if (i > n || i - at > 15) return bad();
  return { start: at, len: i - at, parts, name: op.name, valid: true };
}

/** Decode a stream from byte `from` to the end. */
export function decodeStream(bytes: ArrayLike<number>, from = 0): X86Inst[] {
  const out: X86Inst[] = [];
  for (let i = from; i < bytes.length;) { const d = decodeAt(bytes, i); out.push(d); i += d.len; }
  return out;
}

/** The first byte offset at which a decode from `from` lands on a true boundary of `truth` (or -1). */
export function resyncAt(truth: X86Inst[], from: number, bytes: ArrayLike<number>): number {
  const starts = new Set(truth.map((t) => t.start));
  for (const d of decodeStream(bytes, from)) if (d.start !== from && starts.has(d.start)) return d.start;
  return -1;
}
