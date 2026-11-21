/**
 * Two's complement: one adder for signed and unsigned values, the x86 flags it sets, extension, shifts,
 * division edge cases, and what each language does on overflow. Values are bigints.
 */
import { wrap } from "./bits";

export const toSigned = (x: bigint, w: number): bigint => BigInt.asIntN(w, x);
export const toUnsigned = (x: bigint, w: number): bigint => BigInt.asUintN(w, x);
export const minSigned = (w: number): bigint => -(1n << BigInt(w - 1));
export const maxSigned = (w: number): bigint => (1n << BigInt(w - 1)) - 1n;
export const maxUnsigned = (w: number): bigint => (1n << BigInt(w)) - 1n;

export interface Flags { cf: boolean; of: boolean; sf: boolean; zf: boolean }
export interface AluResult extends Flags { bits: bigint; unsigned: bigint; signed: bigint; trueUnsigned: bigint; trueSigned: bigint }

function flags(bits: bigint, w: number, cf: boolean, of: boolean): Flags {
  return { cf, of, sf: ((bits >> BigInt(w - 1)) & 1n) === 1n, zf: bits === 0n };
}

/**
 * The w-bit adder, as x86 ADD sees it. CF is the carry out of the top bit: the unsigned result is wrong.
 * OF is set when both inputs have the same sign and the result has the other sign: the signed result is wrong.
 */
export function add(a: bigint, b: bigint, w: number): AluResult {
  const ua = toUnsigned(a, w), ub = toUnsigned(b, w);
  const bits = wrap(ua + ub, w);
  const sa = toSigned(a, w), sb = toSigned(b, w);
  const of = (sa < 0n) === (sb < 0n) && (toSigned(bits, w) < 0n) !== (sa < 0n);
  return { bits, unsigned: bits, signed: toSigned(bits, w), trueUnsigned: ua + ub, trueSigned: sa + sb, ...flags(bits, w, ua + ub > maxUnsigned(w), of) };
}

/** x86 SUB (and CMP): CF is the borrow, set when a < b as unsigned values. */
export function sub(a: bigint, b: bigint, w: number): AluResult {
  const ua = toUnsigned(a, w), ub = toUnsigned(b, w);
  const bits = wrap(ua - ub, w);
  const sa = toSigned(a, w), sb = toSigned(b, w);
  const of = (sa < 0n) !== (sb < 0n) && (toSigned(bits, w) < 0n) !== (sa < 0n);
  return { bits, unsigned: bits, signed: toSigned(bits, w), trueUnsigned: ua - ub, trueSigned: sa - sb, ...flags(bits, w, ua < ub, of) };
}

/** Negation as the hardware does it: invert every bit, then add 1. */
export function negate(x: bigint, w: number): { inverted: bigint; bits: bigint; overflow: boolean } {
  const inverted = wrap(~x, w);
  const bits = wrap(inverted + 1n, w);
  return { inverted, bits, overflow: toSigned(x, w) === minSigned(w) };
}

export const signExtend = (x: bigint, from: number, to: number): bigint => toUnsigned(toSigned(x, from), to);
export const zeroExtend = (x: bigint, from: number, to: number): bigint => toUnsigned(toUnsigned(x, from), to);

/** Arithmetic right shift (RISC-V sra, x86 sar): copies of the sign bit fill the top. Rounds toward −∞. */
export const sra = (x: bigint, k: number, w: number): bigint => toUnsigned(toSigned(x, w) >> BigInt(k), w);
/** Logical right shift (RISC-V srl, x86 shr): zeros fill the top. */
export const srl = (x: bigint, k: number, w: number): bigint => toUnsigned(x, w) >> BigInt(k);

/** Integer division that truncates toward zero, as C, Rust, Go, Zig's @divTrunc and every hardware divider do. */
export const divTrunc = (a: bigint, b: bigint): bigint => a / b; // BigInt division truncates
export const divFloor = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
};

// ---------------------------------------------------------------- signed division edge cases

export type DivPlatform = "x86" | "riscv" | "arm64" | "c" | "rust" | "go" | "zig";
export interface DivOutcome { platform: DivPlatform; kind: "value" | "trap" | "ub" | "panic"; q?: bigint; r?: bigint; text: string }

/**
 * Signed a / b in w bits on each platform. The two edge cases are b = 0, and a = MIN with b = −1, where the true
 * quotient 2^(w−1) does not fit.
 */
export function divide(a: bigint, b: bigint, w: number, platform: DivPlatform): DivOutcome {
  const A = toSigned(a, w), B = toSigned(b, w);
  const zero = B === 0n, ovf = A === minSigned(w) && B === -1n;
  const ok = (q: bigint, r: bigint, text = "normal result"): DivOutcome => ({ platform, kind: "value", q, r, text });
  if (!zero && !ovf) return ok(A / B, A % B);
  switch (platform) {
    case "x86": return { platform, kind: "trap", text: zero ? "#DE divide error: divisor is 0" : "#DE divide error: the quotient does not fit" };
    case "riscv": return zero ? ok(-1n, A, "quotient has all bits set, remainder = dividend") : ok(A, 0n, "quotient = dividend, remainder 0");
    case "arm64": return zero ? ok(0n, A, "SDIV writes 0") : ok(A, 0n, "SDIV writes the dividend (MIN)");
    case "c": return { platform, kind: "ub", text: "undefined behavior" };
    case "rust": return { platform, kind: "panic", text: zero ? "panic: attempt to divide by zero" : "panic: attempt to divide with overflow (in every build mode)" };
    case "go": return zero ? { platform, kind: "panic", text: "run-time panic: integer divide by zero" } : ok(A, 0n, "q = x, r = 0, as the Go spec defines");
    case "zig": return { platform, kind: "panic", text: "illegal behavior: a panic in Debug and ReleaseSafe, undefined in ReleaseFast" };
  }
}

// ---------------------------------------------------------------- language behavior on overflow

export type Lang = "c" | "rustDebug" | "rustRelease" | "rustChecked" | "go" | "zigSafe" | "zigWrap" | "java";
export interface LangOutcome { lang: Lang; label: string; code: string; kind: "value" | "panic" | "ub" | "none"; value?: bigint; text: string }

export const LANGS: { lang: Lang; label: string; code: string }[] = [
  { lang: "c", label: "C (signed int)", code: "a + b" },
  { lang: "rustDebug", label: "Rust, debug build", code: "a + b" },
  { lang: "rustRelease", label: "Rust, release build", code: "a + b" },
  { lang: "rustChecked", label: "Rust", code: "a.checked_add(b)" },
  { lang: "go", label: "Go", code: "a + b" },
  { lang: "zigSafe", label: "Zig, Debug or ReleaseSafe", code: "a + b" },
  { lang: "zigWrap", label: "Zig", code: "a +% b" },
  { lang: "java", label: "Java", code: "a + b" },
];

/** What a + b on signed w-bit integers does in each language when it overflows (and when it does not). */
export function langAdd(a: bigint, b: bigint, w: number, lang: Lang): LangOutcome {
  const info = LANGS.find((l) => l.lang === lang)!;
  const r = add(a, b, w);
  const base = { lang, label: info.label, code: info.code };
  if (!r.of) return { ...base, kind: "value", value: r.signed, text: lang === "rustChecked" ? `Some(${r.signed})` : String(r.signed) };
  switch (lang) {
    case "c": return { ...base, kind: "ub", text: "undefined behavior: the compiler may assume it never happens" };
    case "rustDebug": return { ...base, kind: "panic", text: "panic: attempt to add with overflow" };
    case "rustRelease": return { ...base, kind: "value", value: r.signed, text: `${r.signed} (wraps)` };
    case "rustChecked": return { ...base, kind: "none", text: "None" };
    case "go": return { ...base, kind: "value", value: r.signed, text: `${r.signed} (wraps, defined by the spec)` };
    case "zigSafe": return { ...base, kind: "panic", text: "panic: integer overflow" };
    case "zigWrap": return { ...base, kind: "value", value: r.signed, text: `${r.signed} (wraps)` };
    case "java": return { ...base, kind: "value", value: r.signed, text: `${r.signed} (wraps, defined by the JLS)` };
  }
}

// ---------------------------------------------------------------- RISC-V overflow checks with no flags

/**
 * The general signed-add check from the RISC-V unprivileged spec:
 *   add t0, t1, t2 ; slti t3, t2, 0 ; slt t4, t0, t1 ; bne t3, t4, overflow
 * The sum is less than t1 exactly when t2 is negative, unless the add overflowed.
 */
export function rvSignedAddCheck(t1: bigint, t2: bigint, w: number): { t0: bigint; t3: number; t4: number; overflow: boolean } {
  const t0 = toSigned(t1 + t2, w);
  const t3 = toSigned(t2, w) < 0n ? 1 : 0;
  const t4 = t0 < toSigned(t1, w) ? 1 : 0;
  return { t0, t3, t4, overflow: t3 !== t4 };
}
/** The unsigned check: add t0, t1, t2 ; bltu t0, t1, overflow. */
export function rvUnsignedAddCheck(t1: bigint, t2: bigint, w: number): { t0: bigint; overflow: boolean } {
  const t0 = wrap(t1 + t2, w);
  return { t0, overflow: t0 < toUnsigned(t1, w) };
}

// ---------------------------------------------------------------- the number wheel

export interface WheelPoint { bits: bigint; unsigned: bigint; signed: bigint; angle: number }
/** The 2^w patterns around a circle, 0 at the top, increasing clockwise. */
export function wheel(w: number): WheelPoint[] {
  const n = 1 << w;
  return Array.from({ length: n }, (_, i) => ({ bits: BigInt(i), unsigned: BigInt(i), signed: toSigned(BigInt(i), w), angle: (2 * Math.PI * i) / n }));
}

/**
 * Two views of one addition on the wheel. The adder always walks clockwise by the unsigned value of b.
 * The signed view walks |b| steps, clockwise for b ≥ 0 and counterclockwise for b < 0.
 * CF = the unsigned walk crosses the seam between 2^w − 1 and 0.
 * OF = the signed walk crosses the seam between MAX and MIN.
 */
export function walk(a: bigint, b: bigint, w: number): { from: bigint; to: bigint; unsignedSteps: bigint; signedSteps: bigint; crossesCarry: boolean; crossesOverflow: boolean } {
  const from = toUnsigned(a, w), to = wrap(a + b, w);
  const unsignedSteps = toUnsigned(b, w);
  const signedSteps = toSigned(b, w);
  const crossesCarry = from + unsignedSteps > maxUnsigned(w);
  const sa = toSigned(a, w);
  const crossesOverflow = sa + signedSteps > maxSigned(w) || sa + signedSteps < minSigned(w);
  return { from, to, unsignedSteps, signedSteps, crossesCarry, crossesOverflow };
}
