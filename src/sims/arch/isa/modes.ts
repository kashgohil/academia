/**
 * Addressing modes. Part 1 runs the RISC-V listings of listings.ts on the shared hart, inside a small harness that
 * sets up the arguments and data, and checks the result against the C meaning. Part 2 lowers one x86-style address,
 * base + index × scale + displacement, to RISC-V (which has only base + 12-bit offset) and to AArch64, by rule.
 *
 * The x86-64 and AArch64 sequences of part 2 are written by the rules below, not by a compiler. The x86 byte length
 * follows the ModRM/SIB rules of the Intel SDM, Vol. 2, chapter 2 ("Instruction Format"); the AArch64 forms follow
 * the Arm ARM (LDR immediate unsigned offset, LDUR, LDR register).
 */
import { assemble, Hart, type DynInst, type Program } from "../rv";
import { listingById } from "./listings";

// ---------------------------------------------------------------- part 1: run a listing

export const ARR = Array.from({ length: 64 }, (_, k) => 3 * k + 1);
export const STRUCTS = Array.from({ length: 8 }, (_, k) => [100 + k, 200 + k, 300 + k]);
export const G = 4242;

/** Arguments and the expected result of each pattern, as the C code defines it. */
export const CALLS: Record<string, { setup: string[]; post?: string[]; expect: number; about: string }> = {
  idx: { setup: ["la a0, arr", "li a1, 5"], expect: ARR[5]!, about: "idx(arr, 5)" },
  fld: { setup: ["la a0, st"], expect: STRUCTS[0]![2]!, about: "fld(&st[0])" },
  sidx: { setup: ["la a0, st", "li a1, 3"], expect: STRUCTS[3]![1]!, about: "sidx(st, 3)" },
  glob: { setup: [], expect: G, about: "glob()" },
  row: { setup: ["la a0, arr", "li a1, 2", "li a2, 5"], expect: ARR[2 * 16 + 5]!, about: "row(arr, 2, 5)" },
  bump: { setup: ["la a0, arr", "li a1, 7"], post: ["la a0, arr", "lw a0, 28(a0)"], expect: ARR[7]! + 1, about: "bump(arr, 7), then a[7]" },
  sum: { setup: ["la a0, arr", "li a1, 8"], expect: ARR.slice(0, 8).reduce((s, v) => s + v, 0), about: "sum(arr, 8)" },
  max2: { setup: ["li a0, -3", "li a1, 9"], expect: 9, about: "max2(-3, 9)" },
  addf: { setup: ["la a0, st", "li a1, 5"], post: ["la a0, st", "lw a0, 8(a0)"], expect: STRUCTS[0]![2]! + 5, about: "addf(&st[0], 5), then st[0].c" },
  slen: { setup: ["la a0, msg"], expect: 13, about: 'slen("Hello, world!")' },
};

/** The harness program around a listing's RISC-V function. */
export function harness(id: string): string {
  const call = CALLS[id]!;
  return `        .data
arr:    .word ${ARR.join(", ")}
st:     .word ${STRUCTS.flat().join(", ")}
g:      .word ${G}
msg:    .asciz "Hello, world!"
        .text
_start:
${call.setup.map((l) => `        ${l}`).join("\n")}
        call fn
${(call.post ?? []).map((l) => `        ${l}`).join("\n")}
        li   a7, 93
        ecall
${listingById(id).rv}
`;
}

export interface RvRun {
  program: Program;
  /** The words of the function (from label fn to the end of the text). */
  fnWords: number;
  /** Instructions in the function without ret. */
  count: number;
  result: number | null;
  expect: number;
  ok: boolean;
  /** Retired instructions inside fn (from the first instruction of fn to its ret, inclusive). */
  dynamic: number;
  trace: DynInst[];
}

/** Assemble and run a listing's RISC-V code on the hart; check its result. */
export function runListing(id: string): RvRun {
  const asm = assemble(harness(id));
  if (!asm.ok) throw new Error(`${id}: ${asm.errors.map((e) => `${e.line}: ${e.message}`).join("; ")}`);
  const p = asm.program;
  const fn = p.labels["fn"]!;
  const fnWords = p.words.length - (fn - p.textBase) / 4;
  const hart = new Hart(p);
  hart.run({ maxSteps: 10_000 });
  const dynamic = hart.trace.filter((d) => d.pc >= fn).length;
  return {
    program: p, fnWords, count: fnWords - 1, result: hart.exitCode, expect: CALLS[id]!.expect,
    ok: hart.exitCode === CALLS[id]!.expect, dynamic, trace: hart.trace,
  };
}

// ---------------------------------------------------------------- part 2: lower one address

export interface Addr { scale: 1 | 2 | 4 | 8; index: boolean; disp: number }

/** Displacements to step through: each step crosses a limit of one ISA. */
export const DISPS = [-70000, -4096, -2049, -2048, -257, -256, -129, -128, -4, 0, 4, 8, 127, 128, 255, 256, 2044, 2047, 2048, 4092, 16380, 16384, 65532, 70000];

export const BASE = 0x20000;
export const INDEX = 3;

export const effAddr = (m: Addr) => BASE + (m.index ? INDEX * m.scale : 0) + m.disp;

/** RV32 sequence for `lw a0, [a0 + a1*scale + disp]`. a0 holds the base, a1 the index. */
export function lowerRv(m: Addr): string[] {
  const out: string[] = [];
  let base = "a0";
  if (m.index) {
    const k = Math.log2(m.scale);
    if (k === 0) out.push("add  t0, a0, a1");
    else out.push(`slli t0, a1, ${k}`, "add  t0, a0, t0");
    base = "t0";
  }
  if (m.disp >= -2048 && m.disp <= 2047) out.push(`lw   a0, ${m.disp}(${base})`);
  else {
    const hi = (m.disp + 0x800) >> 12, lo = m.disp - hi * 4096;
    out.push(`lui  t1, 0x${(hi & 0xfffff).toString(16)}`, `add  t1, ${base}, t1`, `lw   a0, ${lo}(t1)`);
  }
  return out;
}

/** Run the RISC-V sequence on the hart and return the address that its lw used. */
export function runLowered(m: Addr): { addr: number; steps: number } {
  const src = `        .text\n_start:\n${lowerRv(m).map((l) => `        ${l}`).join("\n")}\n        li a7, 93\n        ecall\n`;
  const asm = assemble(src);
  if (!asm.ok) throw new Error(asm.errors.map((e) => e.message).join("; "));
  const hart = new Hart(asm.program, { memBytes: 0x40000, regs: { 10: BASE, 11: INDEX }, allowMisaligned: true });
  hart.run({ maxSteps: 100 });
  const load = hart.trace.find((d) => d.cls === "load");
  return { addr: load?.memAddr ?? -1, steps: lowerRv(m).length };
}

const fits8 = (d: number) => d >= -128 && d <= 127;

/** x86-64: `mov eax, dword ptr [rdi + rsi*scale + disp]`, always one instruction. Bytes by the ModRM/SIB rules. */
export function lowerX86(m: Addr): { text: string; bytes: number[] } {
  const d = m.disp;
  const mod = d === 0 ? 0 : fits8(d) ? 1 : 2;
  const rm = m.index ? 4 : 7; // 100 = SIB follows; 111 = rdi
  const bytes = [0x8b, (mod << 6) | (0 << 3) | rm];
  if (m.index) bytes.push((Math.log2(m.scale) << 6) | (6 << 3) | 7); // index rsi, base rdi
  if (mod === 1) bytes.push(d & 0xff);
  if (mod === 2) for (let i = 0; i < 4; i++) bytes.push((d >>> (8 * i)) & 0xff);
  const idx = m.index ? ` + ${m.scale === 1 ? "" : `${m.scale}*`}rsi` : "";
  const disp = d === 0 ? "" : d > 0 ? ` + ${d}` : ` - ${-d}`;
  return { text: `mov eax, dword ptr [rdi${idx}${disp}]`, bytes };
}

/** A constant into x9 with MOVZ, MOVN and MOVK: one instruction when one 16-bit chunk is enough. */
function movConst(v: number): string[] {
  const h = (n: number) => `#0x${n.toString(16)}`;
  if (v >= 0 && v <= 0xffff) return [`mov  x9, ${h(v)}`];
  if (v < 0 && v >= -0x10000) return [`movn x9, ${h(~v & 0xffff)}`];
  if (v > 0) return [`mov  x9, ${h(v & 0xffff)}`, `movk x9, ${h(v >>> 16)}, lsl #16`];
  return [`movn x9, ${h(~v & 0xffff)}`, `movk x9, ${h((v >>> 16) & 0xffff)}, lsl #16`]; // -2^31 <= v < -65536
}

/** AArch64: `ldr w0, [x0 + x1*scale + disp]` by the rules of its addressing modes. */
export function lowerArm(m: Addr): string[] {
  const out: string[] = [];
  let base = "x0";
  const d = m.disp;
  if (m.index) {
    const k = Math.log2(m.scale);
    if (d === 0 && (k === 0 || k === 2)) return [k === 0 ? "ldr  w0, [x0, x1]" : "ldr  w0, [x0, x1, lsl #2]"];
    out.push(k === 0 ? "add  x8, x0, x1" : `add  x8, x0, x1, lsl #${k}`);
    base = "x8";
  }
  if (d >= 0 && d <= 16380 && d % 4 === 0) out.push(d === 0 ? `ldr  w0, [${base}]` : `ldr  w0, [${base}, #${d}]`);
  else if (d >= -256 && d <= 255) out.push(`ldur w0, [${base}, #${d}]`);
  else out.push(...movConst(d), `ldr  w0, [${base}, x9]`);
  return out;
}
