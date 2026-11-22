/**
 * Aliasing models for the aliasing-rules lesson. Each one runs on the shared abstract machine (src/sims/sys/mem), so
 * the bytes on screen are the bytes the program wrote.
 *
 * - runScale: `a[i] = a[i] * *k` over int a[4], with k pointing to its own variable or into a. "As written" reloads
 *   *k in each iteration (what -O0 does, and what -O2 does without restrict: golden scale.O2). "Hoisted" loads *k once
 *   before the loop (what -O2 does when a is restrict: golden scale_r.O2). The two agree unless k points into a.
 * - runTbaa: `*i = 1; *f = 2.0f; return *i;` with i and f at the same address. -O2 returns the constant 1 (strict
 *   aliasing: a float store cannot change an int); memory holds the bits of 2.0f. Golden tbaa.O2 and tbaa.O2.nostrict.
 * - floatBits and PUN_METHODS: four ways to read the bits of a float, and what each language says about them.
 */
import { array, hex, Machine, offset, ptr, T, type Ptr } from "../mem";
import type { GoldenKey } from "./optimizer";

// ---------------------------------------------------------------- the scale loop

export interface ScaleIter {
  i: number;
  /** The value the code used for *k in this iteration. */
  k: number;
  before: number;
  after: number;
  /** a[0..3] after this iteration. */
  a: number[];
}

export interface ScaleRun {
  iters: ScaleIter[];
  final: number[];
  /** The bytes of a[0..3] at the end, little-endian. */
  bytes: number[];
  /** Address of a and of the k target, for display. */
  aAddr: number;
  kAddr: number;
}

/** The initial values of a. */
export const SCALE_A = [1, 2, 3, 4];
/** The value of the separate variable that k points to when k does not point into a. */
export const SCALE_V = 3;

/**
 * Runs the loop on the machine. `target` is -1 for "k points to a separate int v", or 0..3 for "k = &a[target]".
 * `hoist` loads *k once before the loop, as the restrict build does.
 */
export function runScale(target: number, hoist: boolean): ScaleRun {
  const m = new Machine();
  m.call("main", [{ name: "a", type: array(T.int, 4), value: SCALE_A }, { name: "v", type: T.int, value: SCALE_V }]);
  const a = m.addrOf("a");
  const k: Ptr = target < 0 ? m.addrOf("v") : offset(a, 4 * target);
  m.call("scale", [{ name: "a", type: ptr(T.int), value: a }, { name: "k", type: ptr(T.int), value: k }]);
  const read = () => [0, 1, 2, 3].map((j) => m.load(offset(a, 4 * j), T.int) as number);
  const hoisted = hoist ? (m.load(k, T.int) as number) : 0;
  const iters: ScaleIter[] = [];
  for (let i = 0; i < 4; i++) {
    const p = offset(a, 4 * i);
    const before = m.load(p, T.int) as number;
    const kv = hoist ? hoisted : (m.load(k, T.int) as number);
    const after = Math.imul(before, kv);
    m.store(p, T.int, after);
    iters.push({ i, k: kv, before, after, a: read() });
  }
  const final = read();
  const bytes = m.peek(a.addr, 16).bytes;
  return { iters, final, bytes, aAddr: a.addr, kAddr: k.addr };
}

/** Whether -O2 may hoist the load of *k out of the loop. */
export function mayHoist(restrict: boolean): { ok: boolean; why: string } {
  return restrict
    ? { ok: true, why: "a is restrict: no object that a writes may be reached through k in this call, so *k cannot change inside the loop." }
    : { ok: false, why: "a and k are both int pointers. A store through a may change *k, so the compiler must load *k again after each store." };
}

/** The golden assembly for each qualifier. */
export const SCALE_ASM: Record<"plain" | "restrict", GoldenKey> = { plain: "scale.O2", restrict: "scale_r.O2" };

// ---------------------------------------------------------------- strict aliasing: int and float at one address

export interface TbaaStep {
  line: string;
  /** The 4 bytes of x after the line. */
  bytes: number[];
  init: boolean[];
  note: string;
}

export interface TbaaRun {
  steps: TbaaStep[];
  /** What memory holds at the end, read as an int. */
  memory: number;
  /** What the function returns in each build. */
  returns: { O0: number; O2: number; nostrict: number };
}

/** The bits of a float as an unsigned 32-bit integer. */
export function floatBits(f: number): number {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, f, true);
  return dv.getUint32(0, true);
}

/** The little-endian bytes of a 32-bit value. */
export const le32 = (u: number) => [u & 255, (u >>> 8) & 255, (u >>> 16) & 255, (u >>> 24) & 255];

/** Runs f(&x, (float *)&x) on the machine: *i = 1; *f = value; return *i. */
export function runTbaa(value = 2): TbaaRun {
  const m = new Machine();
  m.call("main", [{ name: "x", type: T.int }]);
  const x = m.addrOf("x");
  const snap = (line: string, note: string): TbaaStep => {
    const p = m.peek(x.addr, 4);
    return { line, bytes: p.bytes, init: p.init, note };
  };
  const steps = [snap("int x;", `x is at ${hex(x.addr)}; its 4 bytes are uninitialized.`)];
  m.store(x, T.int, 1);
  steps.push(snap("*i = 1;", "An int store writes 01 00 00 00."));
  m.store(x, T.float, value);
  steps.push(snap(`*f = ${Number.isInteger(value) ? value.toFixed(1) : value}f;`, "A float store writes the IEEE 754 bits of the float over the same 4 bytes."));
  const memory = m.load(x, T.int) as number;
  steps.push(snap("return *i;", `Memory now holds ${memory} as an int. -O2 returns 1 without a load.`));
  return { steps, memory, returns: { O0: memory, O2: 1, nostrict: memory } };
}

// ---------------------------------------------------------------- type punning

export type PunVerdict = "defined" | "ub" | "impl" | "na";

export interface PunMethod {
  id: string;
  label: string;
  code: string;
  lang: string;
  c: PunVerdict;
  cpp: PunVerdict;
  note: string;
  asm?: GoldenKey;
}

export const PUN_METHODS: PunMethod[] = [
  { id: "cast", label: "pointer cast", lang: "C, C++", code: "unsigned u = *(unsigned *)&f;", c: "ub", cpp: "ub", asm: "bits_cast.O2",
    note: "An unsigned lvalue reads an object whose effective type is float. That is not in the list of C11 6.5p7, so it is UB. Today's clang still emits the expected movd, but a later optimization may not." },
  { id: "union", label: "union", lang: "C", code: "union { float f; unsigned u; } x = { .f = f };\nunsigned u = x.u;", c: "defined", cpp: "ub", asm: "bits_union.O2",
    note: "C allows it: a footnote to C11 6.5.2.3 says the bytes are reinterpreted. In C++, only the active member of a union may be read; GCC documents union punning as an extension." },
  { id: "memcpy", label: "memcpy", lang: "C, C++", code: "unsigned u;\nmemcpy(&u, &f, sizeof u);", c: "defined", cpp: "defined", asm: "bits_memcpy.O2",
    note: "memcpy copies bytes, which is always allowed. The compiler knows memcpy and turns a 4-byte copy into one register move: no call, no memory." },
  { id: "bitcast", label: "std::bit_cast", lang: "C++20", code: "auto u = std::bit_cast<unsigned>(f);", c: "na", cpp: "defined",
    note: "C++20 [bit.cast]. The sizes must match and both types must be trivially copyable. It also works in constant expressions. zig c++ gives the same single movd." },
  { id: "rust", label: "f32::to_bits", lang: "Rust", code: "let u: u32 = f.to_bits();", c: "na", cpp: "na",
    note: "Safe Rust. rustc 1.96 compiles it to one fmov w0, s0 on AArch64. mem::transmute::<f32, u32> also works but needs unsafe." },
  { id: "zig", label: "@bitCast", lang: "Zig", code: "const u: u32 = @bitCast(f);", c: "na", cpp: "na",
    note: "Zig checks at compile time that the sizes match. Go has math.Float32bits for the same job." },
];
