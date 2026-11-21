/**
 * Binary floating point at the bit level, for any IEEE-style format (binary64, binary32, binary16, bfloat16,
 * the two OCP FP8 formats, and small toy formats). Every value is exact: a finite value is sig × 2^exp with a
 * bigint sig, and rounding works on exact rationals. JS doubles serve only as input and as a golden model.
 */

export interface FloatFormat {
  id: string;
  name: string;
  /** Exponent bits. */
  e: number;
  /** Fraction bits (the trailing significand). The precision is m + 1 bits. */
  m: number;
  bias: number;
  /** "ieee": an all-ones exponent means ∞ (fraction 0) or NaN. "fn": E4M3 style, where only S.1111.111 is NaN and there is no ∞. */
  special: "ieee" | "fn";
}

const ieee = (id: string, name: string, e: number, m: number): FloatFormat => ({ id, name, e, m, bias: 2 ** (e - 1) - 1, special: "ieee" });
export const BINARY64 = ieee("binary64", "binary64 (double)", 11, 52);
export const BINARY32 = ieee("binary32", "binary32 (float)", 8, 23);
export const BINARY16 = ieee("binary16", "binary16 (half)", 5, 10);
export const BFLOAT16 = ieee("bfloat16", "bfloat16", 8, 7);
/** OCP 8-bit floating point (OFP8) E4M3: bias 7, no infinities, one NaN pattern per sign. */
export const E4M3: FloatFormat = { id: "e4m3", name: "FP8 E4M3", e: 4, m: 3, bias: 7, special: "fn" };
/** OCP OFP8 E5M2: IEEE-style, bias 15, with infinities and NaNs. */
export const E5M2 = ieee("e5m2", "FP8 E5M2", 5, 2);
export const FORMATS: FloatFormat[] = [BINARY64, BINARY32, BINARY16, BFLOAT16, E4M3, E5M2];
/** A small IEEE-style format, for number lines you can see whole. */
export const toyFormat = (e: number, m: number): FloatFormat => ieee(`toy${e}${m}`, `toy (${e} exponent, ${m} fraction bits)`, e, m);

export const width = (f: FloatFormat): number => 1 + f.e + f.m;

export type Kind = "zero" | "subnormal" | "normal" | "inf" | "nan";
export interface Decoded {
  bits: bigint; sign: 0 | 1; expField: number; frac: bigint; kind: Kind;
  /** For NaN: true if the top fraction bit is 1 (a quiet NaN, as IEEE 754-2008 recommends). */
  quiet: boolean;
  /** The finite value is (−1)^sign × sig × 2^exp. */
  sig: bigint; exp: number;
  /** The unbiased exponent of the binade (emin for subnormals). */
  unbiased: number;
  /** As a JS number (exact for every format here). */
  value: number;
}

const emaxField = (f: FloatFormat) => (1 << f.e) - 1;
export const emin = (f: FloatFormat): number => 1 - f.bias;

export function decode(f: FloatFormat, bits: bigint): Decoded {
  const W = BigInt(width(f));
  bits = BigInt.asUintN(Number(W), bits);
  const sign = Number(bits >> (W - 1n)) as 0 | 1;
  const expField = Number((bits >> BigInt(f.m)) & BigInt(emaxField(f)));
  const frac = bits & ((1n << BigInt(f.m)) - 1n);
  const allOnes = expField === emaxField(f);
  const fracAll = frac === (1n << BigInt(f.m)) - 1n;
  const base = { bits, sign, expField, frac, quiet: false, sig: 0n, exp: 0, unbiased: emin(f) };
  const s = sign ? -1 : 1;
  if (allOnes && f.special === "ieee") {
    if (frac === 0n) return { ...base, kind: "inf", value: s * Infinity };
    return { ...base, kind: "nan", quiet: f.m > 0 && ((frac >> BigInt(f.m - 1)) & 1n) === 1n, value: NaN };
  }
  if (allOnes && f.special === "fn" && fracAll) return { ...base, kind: "nan", quiet: true, value: NaN };
  if (expField === 0) {
    if (frac === 0n) return { ...base, kind: "zero", value: s * 0 };
    const exp = emin(f) - f.m;
    return { ...base, kind: "subnormal", sig: frac, exp, value: s * Number(frac) * 2 ** exp };
  }
  const sig = frac | (1n << BigInt(f.m));
  const unbiased = expField - f.bias;
  const exp = unbiased - f.m;
  return { ...base, kind: "normal", sig, exp, unbiased, value: s * Number(sig) * 2 ** exp };
}

export const fields = (f: FloatFormat, sign: number, expField: number, frac: bigint): bigint =>
  (BigInt(sign) << BigInt(f.e + f.m)) | (BigInt(expField) << BigInt(f.m)) | frac;

/** The largest finite value as bits. */
export const maxFiniteBits = (f: FloatFormat): bigint =>
  f.special === "ieee" ? fields(f, 0, emaxField(f) - 1, (1n << BigInt(f.m)) - 1n) : fields(f, 0, emaxField(f), (1n << BigInt(f.m)) - 2n);
export const infBits = (f: FloatFormat, sign: number): bigint | null => (f.special === "ieee" ? fields(f, sign, emaxField(f), 0n) : null);
export const nanBits = (f: FloatFormat, sign = 0): bigint =>
  f.special === "ieee" ? fields(f, sign, emaxField(f), 1n << BigInt(f.m - 1)) : fields(f, sign, emaxField(f), (1n << BigInt(f.m)) - 1n);

// ---------------------------------------------------------------- rounding exact rationals

export type Mode = "rne" | "rna" | "rtz" | "rup" | "rdn";
export const MODES: { mode: Mode; label: string; ieee: string; riscv: string }[] = [
  { mode: "rne", label: "nearest, ties to even", ieee: "roundTiesToEven", riscv: "RNE (000)" },
  { mode: "rna", label: "nearest, ties away", ieee: "roundTiesToAway", riscv: "RMM (100)" },
  { mode: "rtz", label: "toward zero", ieee: "roundTowardZero", riscv: "RTZ (001)" },
  { mode: "rup", label: "toward +∞", ieee: "roundTowardPositive", riscv: "RUP (011)" },
  { mode: "rdn", label: "toward −∞", ieee: "roundTowardNegative", riscv: "RDN (010)" },
];

/** An exact rational with a sign: (−1)^sign × num / den, den > 0. */
export interface Exact { sign: 0 | 1; num: bigint; den: bigint }

const bitlen = (x: bigint) => (x === 0n ? 0 : x.toString(2).length);
/** floor(log2(num / den)) for num, den > 0. */
function floorLog2(num: bigint, den: bigint): number {
  let k = bitlen(num) - bitlen(den);
  if (k >= 0 ? num < den << BigInt(k) : num << BigInt(-k) < den) k--;
  return k;
}

export interface Rounded { bits: bigint; inexact: boolean; overflow: boolean; underflow: boolean }

/**
 * Rounds an exact value to the format, as IEEE 754 does: first to the precision with an unbounded exponent,
 * then overflow. A format with no ∞ gives NaN on overflow, unless `saturate` is set (then the largest finite value).
 */
export function round(f: FloatFormat, x: Exact, mode: Mode = "rne", saturate = false): Rounded {
  const { sign, num, den } = x;
  if (num === 0n) return { bits: fields(f, sign, 0, 0n), inexact: false, overflow: false, underflow: false };
  const k = Math.max(floorLog2(num, den), emin(f));
  let qe = k - f.m;
  const N = qe <= 0 ? num << BigInt(-qe) : num;
  const D = qe <= 0 ? den : den << BigInt(qe);
  let q = N / D;
  const rem = N % D;
  const inexact = rem !== 0n;
  const twice = 2n * rem;
  let up = false;
  switch (mode) {
    case "rne": up = twice > D || (twice === D && (q & 1n) === 1n); break;
    case "rna": up = twice >= D && inexact; break;
    case "rtz": up = false; break;
    case "rup": up = inexact && sign === 0; break;
    case "rdn": up = inexact && sign === 1; break;
  }
  if (up) q += 1n;
  const hidden = 1n << BigInt(f.m);
  if (q === hidden << 1n) { q = hidden; qe += 1; }
  const max = decode(f, maxFiniteBits(f));
  const tiny = q < hidden;
  // compare q × 2^qe with the largest finite value (both normal here)
  const over = !tiny && (qe > max.exp || (qe === max.exp && q > max.sig));
  if (over) {
    const towardZero = mode === "rtz" || (mode === "rup" && sign === 1) || (mode === "rdn" && sign === 0);
    const inf = infBits(f, sign);
    const bits = towardZero || saturate ? maxFiniteBits(f) | (BigInt(sign) << BigInt(f.e + f.m)) : inf ?? nanBits(f, sign);
    return { bits, inexact: true, overflow: true, underflow: false };
  }
  const bits = tiny ? fields(f, sign, 0, q) : fields(f, sign, qe + f.m + f.bias, q - hidden);
  return { bits, inexact, overflow: false, underflow: tiny && inexact };
}

/** The exact value of a finite decoded number. */
export function exactOf(d: Decoded): Exact {
  if (d.kind === "zero") return { sign: d.sign, num: 0n, den: 1n };
  return d.exp >= 0 ? { sign: d.sign, num: d.sig << BigInt(d.exp), den: 1n } : { sign: d.sign, num: d.sig, den: 1n << BigInt(-d.exp) };
}

/** The bits of a JS number (binary64). */
export function doubleBits(x: number): bigint {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  return dv.getBigUint64(0);
}
export function bitsToDouble(b: bigint): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt.asUintN(64, b));
  return dv.getFloat64(0);
}

/** Rounds a JS number into the format. NaN and ∞ map to the format's NaN and ∞ (or NaN, for a format with no ∞). */
export function fromNumber(f: FloatFormat, x: number, mode: Mode = "rne", saturate = false): Rounded {
  if (Number.isNaN(x)) return { bits: nanBits(f), inexact: false, overflow: false, underflow: false };
  if (!Number.isFinite(x)) {
    const s = x < 0 ? 1 : 0;
    return { bits: infBits(f, s) ?? (saturate ? maxFiniteBits(f) | (BigInt(s) << BigInt(f.e + f.m)) : nanBits(f, s)), inexact: false, overflow: false, underflow: false };
  }
  return round(f, exactOf(decode(BINARY64, doubleBits(x))), mode, saturate);
}

/** Parses a decimal string exactly ("0.1", "-1.5e-3", "1e400") into a rational, so that rounding is exact. */
export function parseDecimal(s: string): Exact | null {
  const m = /^\s*([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  const intPart = m[2] ?? "", fracPart = m[3] ?? "";
  const e = Number(m[4] ?? 0) - fracPart.length;
  if (Math.abs(e) > 5000) return null;
  const digits = BigInt((intPart + fracPart) || "0");
  const sign = m[1] === "-" ? 1 : 0;
  return e >= 0 ? { sign, num: digits * 10n ** BigInt(e), den: 1n } : { sign, num: digits, den: 10n ** BigInt(-e) };
}

/** The exact decimal expansion of sig × 2^exp. Every binary fraction has a finite decimal expansion. */
export function exactDecimal(sig: bigint, exp: number): string {
  if (sig === 0n) return "0";
  if (exp >= 0) return (sig << BigInt(exp)).toString();
  const n = -exp;
  const s = (sig * 5n ** BigInt(n)).toString().padStart(n + 1, "0");
  const out = `${s.slice(0, s.length - n)}.${s.slice(s.length - n)}`.replace(/0+$/, "").replace(/\.$/, "");
  return out;
}
/** The exact decimal of a decoded value, with its sign; "inf", "NaN" for specials. */
export function decimalOf(d: Decoded): string {
  if (d.kind === "nan") return "NaN";
  if (d.kind === "inf") return d.sign ? "−∞" : "+∞";
  if (d.kind === "zero") return d.sign ? "−0" : "0";
  return (d.sign ? "−" : "") + exactDecimal(d.sig, d.exp);
}
/** The exact decimal of a rational whose denominator is a power of two. */
export function decimalOfExact(x: Exact): string {
  const k = bitlen(x.den) - 1;
  if (x.den !== 1n << BigInt(k)) throw new Error("denominator is not a power of two");
  return (x.sign && x.num !== 0n ? "−" : "") + exactDecimal(x.num, -k);
}

/** The distance from this value to the next larger value of the same sign: one unit in the last place. */
export function ulp(f: FloatFormat, d: Decoded): number {
  const k = d.kind === "normal" ? d.unbiased : emin(f);
  return 2 ** (k - f.m);
}

/** The two neighbours of an exact value in the format: rounded down and rounded up. */
export function neighbours(f: FloatFormat, x: Exact): [bigint, bigint] {
  const a = round(f, x, x.sign ? "rup" : "rdn").bits; // toward zero in magnitude
  const b = round(f, x, x.sign ? "rdn" : "rup").bits;
  return [a, b];
}

// ---------------------------------------------------------------- arithmetic with one rounding

const pow2 = (e: number): Exact => (e >= 0 ? { sign: 0, num: 1n << BigInt(e), den: 1n } : { sign: 0, num: 1n, den: 1n << BigInt(-e) });
function sigExp(d: Decoded): [bigint, number] { return [d.sign ? -d.sig : d.sig, d.exp]; }
function fromSigned(v: bigint, exp: number): Exact {
  const sign = v < 0n ? 1 : 0;
  const a = v < 0n ? -v : v;
  const p = pow2(exp);
  return { sign, num: a * p.num, den: p.den };
}
export function exactSum(ds: Decoded[]): Exact {
  const e = Math.min(...ds.map((d) => d.exp));
  let v = 0n;
  for (const d of ds) { const [s, x] = sigExp(d); v += s << BigInt(x - e); }
  return fromSigned(v, e);
}
export function exactProduct(a: Decoded, b: Decoded): Exact {
  const [sa, ea] = sigExp(a), [sb, eb] = sigExp(b);
  const r = fromSigned(sa * sb, ea + eb);
  return r.num === 0n ? { ...r, sign: (a.sign ^ b.sign) as 0 | 1 } : r;
}

export type Op = "add" | "mul" | "fma";
/**
 * One IEEE operation on finite inputs: the exact result, rounded once. fma computes a × b + c with one rounding.
 * Specials follow the usual rules (NaN in → NaN out; ∞ − ∞ and 0 × ∞ → NaN).
 */
export function operate(f: FloatFormat, op: Op, a: bigint, b: bigint, c = 0n, mode: Mode = "rne"): Rounded & { exact: Exact | null } {
  const A = decode(f, a), B = decode(f, b), C = decode(f, c);
  const used = op === "fma" ? [A, B, C] : [A, B];
  const nan = { bits: nanBits(f), inexact: false, overflow: false, underflow: false, exact: null };
  if (used.some((d) => d.kind === "nan")) return nan;
  const isInf = (d: Decoded) => d.kind === "inf";
  if (used.some(isInf)) {
    // a small, sufficient set of rules for the demos
    if (op === "add") {
      if (isInf(A) && isInf(B) && A.sign !== B.sign) return nan;
      const s = isInf(A) ? A.sign : B.sign;
      return { bits: infBits(f, s)!, inexact: false, overflow: false, underflow: false, exact: null };
    }
    if ((isInf(A) && B.kind === "zero") || (isInf(B) && A.kind === "zero")) return nan;
    const s = (A.sign ^ B.sign) as 0 | 1;
    if (op === "mul" || !isInf(C)) return { bits: infBits(f, s)!, inexact: false, overflow: false, underflow: false, exact: null };
    if (isInf(A) || isInf(B)) return C.sign === s ? { bits: infBits(f, s)!, inexact: false, overflow: false, underflow: false, exact: null } : nan;
    return { bits: infBits(f, C.sign)!, inexact: false, overflow: false, underflow: false, exact: null };
  }
  let x: Exact;
  if (op === "add") {
    x = exactSum([A, B]);
    if (x.num === 0n) x = { ...x, sign: A.kind === "zero" && B.kind === "zero" && A.sign && B.sign ? 1 : mode === "rdn" ? 1 : 0 };
  } else if (op === "mul") {
    x = exactProduct(A, B);
  } else {
    const p = exactProduct(A, B);
    const pd: Decoded = { ...A, kind: p.num === 0n ? "zero" : "normal", sign: p.sign, sig: p.num, exp: -(bitlen(p.den) - 1) };
    x = exactSum([pd, C]);
    if (x.num === 0n) x = { ...x, sign: mode === "rdn" ? 1 : 0 };
  }
  return { ...round(f, x, mode), exact: x };
}

// ---------------------------------------------------------------- a whole format at a glance

export interface FormatStats { maxFinite: number; minNormal: number; minSubnormal: number; epsilon: number; decimalDigits: number; finiteCount: number; hasInf: boolean; nanCount: number }
export function stats(f: FloatFormat): FormatStats {
  const nonFinitePerSign = f.special === "ieee" ? 2 ** f.m : 1; // ∞ and NaNs, or one NaN
  const perSign = 2 ** (f.e + f.m);
  return {
    maxFinite: decode(f, maxFiniteBits(f)).value,
    minNormal: 2 ** emin(f),
    minSubnormal: 2 ** (emin(f) - f.m),
    epsilon: 2 ** -f.m,
    decimalDigits: (f.m + 1) * Math.log10(2),
    finiteCount: 2 * (perSign - nonFinitePerSign) - 1, // −0 and +0 are one value
    hasInf: f.special === "ieee",
    nanCount: f.special === "ieee" ? 2 * (2 ** f.m - 1) : 2,
  };
}

/** Every finite value ≥ 0 of a small format, in order, with its kind. */
export function enumerate(f: FloatFormat): { value: number; kind: Kind; bits: bigint }[] {
  if (width(f) > 16) throw new Error("format too wide to enumerate");
  const out: { value: number; kind: Kind; bits: bigint }[] = [];
  const half = 1 << (f.e + f.m);
  for (let i = 0; i < half; i++) {
    const d = decode(f, BigInt(i));
    if (d.kind === "nan" || d.kind === "inf") continue;
    out.push({ value: d.value, kind: d.kind, bits: d.bits });
  }
  return out;
}

/** Relative error of storing x in the format (round to nearest even). */
export function relError(f: FloatFormat, x: number, saturate = false): { stored: number; rel: number; kind: Kind } {
  const d = decode(f, fromNumber(f, x, "rne", saturate).bits);
  return { stored: d.value, rel: x === 0 ? 0 : Math.abs(d.value - x) / Math.abs(x), kind: d.kind };
}

// ---------------------------------------------------------------- summation order (binary32)

export type SumOrder = "forward" | "ascending" | "descending" | "pairwise" | "kahan";
export const SUM_ORDERS: { order: SumOrder; label: string }[] = [
  { order: "forward", label: "left to right" },
  { order: "descending", label: "largest first" },
  { order: "ascending", label: "smallest first" },
  { order: "pairwise", label: "pairwise (tree)" },
  { order: "kahan", label: "Kahan" },
];
const fr = Math.fround;

/** Sums binary32 values with every operation rounded to binary32. */
export function sum32(xs: number[], order: SumOrder): number {
  const v = xs.map(fr);
  switch (order) {
    case "forward": return v.reduce((s, x) => fr(s + x), 0);
    case "ascending": return [...v].sort((a, b) => Math.abs(a) - Math.abs(b)).reduce((s, x) => fr(s + x), 0);
    case "descending": return [...v].sort((a, b) => Math.abs(b) - Math.abs(a)).reduce((s, x) => fr(s + x), 0);
    case "pairwise": {
      const rec = (lo: number, hi: number): number => (hi - lo === 1 ? v[lo]! : hi === lo ? 0 : fr(rec(lo, (lo + hi) >> 1) + rec((lo + hi) >> 1, hi)));
      return rec(0, v.length);
    }
    case "kahan": {
      let s = 0, c = 0;
      for (const x of v) { const y = fr(x - c); const t = fr(s + y); c = fr(fr(t - s) - y); s = t; }
      return s;
    }
  }
}

/** The exact sum of binary32 values, correctly rounded to binary32: the best any order can do. */
export function exactSum32(xs: number[]): number {
  const ds = xs.map((x) => decode(BINARY32, fromNumber(BINARY32, x).bits)).filter((d) => d.kind !== "zero");
  if (ds.length === 0) return 0;
  return decode(BINARY32, round(BINARY32, exactSum(ds)).bits).value;
}

/** Distance between two binary32 values, in units in the last place of the correct result. */
export function ulpsOff32(got: number, want: number): number {
  const u = ulp(BINARY32, decode(BINARY32, fromNumber(BINARY32, want).bits));
  return Math.abs(got - want) / u;
}

/** Test data sets for summation. */
export type SumData = "bigSmall" | "mixed" | "harmonic";
export function sumData(kind: SumData, n: number, seed = 1): number[] {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  switch (kind) {
    case "bigSmall": return [fr(1), ...Array.from({ length: n - 1 }, () => fr(1e-8))];
    case "harmonic": return Array.from({ length: n }, (_, i) => fr(1 / (i + 1)));
    case "mixed": return Array.from({ length: n }, () => fr((rnd() < 0.5 ? -1 : 1) * 10 ** (rnd() * 8 - 4)));
  }
}

/** The binary32 harmonic sum 1 + 1/2 + … computed left to right, up to the first term that no longer changes it. */
export function harmonicStall32(limit = 1 << 23): { n: number; sum: number } {
  let s = 0;
  for (let i = 1; i <= limit; i++) {
    const t = fr(s + fr(1 / i));
    if (t === s) return { n: i, sum: s };
    s = t;
  }
  return { n: -1, sum: s };
}
