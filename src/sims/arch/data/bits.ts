/**
 * Words of 8, 16, 32 and 64 bits as the machine holds them. Every value is a bigint that is kept in
 * 0 .. 2^w - 1, so 64-bit words are exact (a JS number is exact only to 2^53).
 */

export type Width = 8 | 16 | 32 | 64;
export const WIDTHS: Width[] = [8, 16, 32, 64];

export const mask = (w: number): bigint => (1n << BigInt(w)) - 1n;
/** The value modulo 2^w: what a w-bit register keeps. */
export const wrap = (x: bigint, w: number): bigint => BigInt.asUintN(w, x);
export const testBit = (x: bigint, i: number): boolean => ((x >> BigInt(i)) & 1n) === 1n;
export const flipBit = (x: bigint, i: number, w: number): bigint => wrap(x ^ (1n << BigInt(i)), w);

/** Digits in a base, padded to the width of the word. Hex: w/4 digits. Octal: ceil(w/3). Binary: w. */
export function digits(x: bigint, base: 2 | 8 | 10 | 16, w: number): string {
  const s = wrap(x, w).toString(base);
  if (base === 10) return s;
  const n = base === 2 ? w : base === 16 ? Math.ceil(w / 4) : Math.ceil(w / 3);
  return s.padStart(n, "0").toUpperCase();
}

/** Thousands separators for a bigint: 4294967296 → "4,294,967,296". */
export const group3 = (x: bigint): string => x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Splits a string into groups of n characters from the right: ("1011010", 4) → ["101", "1010"]. */
export function groups(s: string, n: number): string[] {
  const out: string[] = [];
  for (let end = s.length; end > 0; end -= n) out.unshift(s.slice(Math.max(0, end - n), end));
  return out;
}

/** The number of decimal digits that the largest w-bit value needs: ceil(w · log10 2). */
export const decimalDigits = (w: number): number => (2n ** BigInt(w) - 1n).toString().length;

export function popcount(x: bigint): number {
  let n = 0;
  for (let v = x; v > 0n; v &= v - 1n) n++;
  return n;
}
/** Count of trailing zero bits; w for zero. */
export function ctz(x: bigint, w: number): number {
  if (x === 0n) return w;
  let n = 0;
  while (((x >> BigInt(n)) & 1n) === 0n) n++;
  return n;
}
/** Count of leading zero bits in a w-bit word; w for zero. */
export const clz = (x: bigint, w: number): number => (x === 0n ? w : w - x.toString(2).length);

/** Rounds up to a power of two by smearing the top bit right, as in the classic bit hack. 0 stays 0. */
export function nextPow2(x: bigint, w: number): bigint {
  let v = wrap(x - 1n, w);
  for (let s = 1; s < w; s *= 2) v |= v >> BigInt(s);
  return wrap(v + 1n, w);
}

export type BitOp = "and" | "or" | "xor" | "not" | "shl" | "shr" | "clearLowest" | "lowest" | "field" | "nextPow2";

export interface OpInfo { op: BitOp; label: string; expr: string; uses: "y" | "k" | "field" | "none"; meaning: string }
export const BIT_OPS: OpInfo[] = [
  { op: "and", label: "AND", expr: "x & y", uses: "y", meaning: "Keeps the bits of x where y has a 1. A mask selects bits." },
  { op: "or", label: "OR", expr: "x | y", uses: "y", meaning: "Sets the bits of x where y has a 1." },
  { op: "xor", label: "XOR", expr: "x ^ y", uses: "y", meaning: "Flips the bits of x where y has a 1. Applying it twice restores x." },
  { op: "not", label: "NOT", expr: "~x", uses: "none", meaning: "Flips every bit." },
  { op: "shl", label: "Shift left", expr: "x << k", uses: "k", meaning: "Multiplies by $2^k$. Bits that pass the top are lost." },
  { op: "shr", label: "Shift right", expr: "x >> k", uses: "k", meaning: "Divides by $2^k$ and rounds down (unsigned, logical shift)." },
  { op: "clearLowest", label: "x & (x−1)", expr: "x & (x - 1)", uses: "none", meaning: "Clears the lowest 1 bit. The result is 0 only if x is 0 or a power of two." },
  { op: "lowest", label: "x & −x", expr: "x & -x", uses: "none", meaning: "Keeps only the lowest 1 bit." },
  { op: "field", label: "Extract field", expr: "(x >> k) & ((1 << n) - 1)", uses: "field", meaning: "Moves an n-bit field down to bit 0 and masks off the rest." },
  { op: "nextPow2", label: "Next power of 2", expr: "smear, then + 1", uses: "none", meaning: "Copies the top 1 bit into every lower bit, then adds 1." },
];

/** Applies a bit operation in a w-bit register. `y` is the second operand, `k` a shift or field start, `n` a field width. */
export function applyOp(op: BitOp, x: bigint, w: number, y = 0n, k = 0, n = 4): bigint {
  const K = BigInt(Math.max(0, Math.min(k, w)));
  switch (op) {
    case "and": return wrap(x & y, w);
    case "or": return wrap(x | y, w);
    case "xor": return wrap(x ^ y, w);
    case "not": return wrap(~x, w);
    case "shl": return wrap(x << K, w);
    case "shr": return wrap(x, w) >> K;
    case "clearLowest": return wrap(x & (x - 1n), w);
    case "lowest": return wrap(x & -x, w);
    case "field": return (wrap(x, w) >> K) & mask(n);
    case "nextPow2": return nextPow2(x, w);
  }
}

/** The second operand that the op shows as a row of bits, or null. */
export function opOperand(op: BitOp, x: bigint, w: number, y: bigint, k: number, n: number): bigint | null {
  if (op === "and" || op === "or" || op === "xor") return wrap(y, w);
  if (op === "clearLowest") return wrap(x - 1n, w);
  if (op === "lowest") return wrap(-x, w);
  if (op === "field") return wrap(mask(n) << BigInt(k), w);
  return null;
}

export const isPow2 = (x: bigint): boolean => x !== 0n && (x & (x - 1n)) === 0n;

// ---------------------------------------------------------------- how wide numbers grow

/** Seconds until a w-bit counter wraps, at `perSecond` increments each second. */
export const wrapSeconds = (w: number, perSecond: number): number => 2 ** w / perSecond;

const YEAR = 365.25 * 86400;
/** A duration in the largest unit that keeps the number at least 1: "4.29 s", "49.7 days", "585 years". */
export function humanDuration(s: number): string {
  const units: [number, string][] = [[1e9 * YEAR, "billion years"], [1e6 * YEAR, "million years"], [YEAR, "years"], [86400, "days"], [3600, "hours"], [60, "minutes"], [1, "s"], [1e-3, "ms"], [1e-6, "µs"], [1e-9, "ns"]];
  for (const [f, u] of units) if (s >= f) return `${Number((s / f).toPrecision(3)).toLocaleString("en-US")} ${u}`;
  return `${Number((s / 1e-9).toPrecision(3))} ns`;
}

/** The UTC time at which a signed 32-bit count of seconds since 1970 reaches its maximum. */
export const unix32Max = (): string => new Date((2 ** 31 - 1) * 1000).toISOString().replace(".000", "");

export interface Counter { name: string; perSecond: number; note: string }
/** Example counters. The rates are model inputs, except the definition of each unit. */
export const COUNTERS: Counter[] = [
  { name: "seconds", perSecond: 1, note: "Unix time" },
  { name: "milliseconds", perSecond: 1e3, note: "an uptime tick counter" },
  { name: "microseconds", perSecond: 1e6, note: "a timestamp in µs" },
  { name: "nanoseconds", perSecond: 1e9, note: "a timestamp in ns" },
  { name: "cycles at 3 GHz", perSecond: 3e9, note: "a cycle counter, model input" },
  { name: "packets at 100 Mpps", perSecond: 1e8, note: "a packet counter, model input" },
];

// ---------------------------------------------------------------- hex dumps

/** One line of `xxd` output: offset, 8 groups of 2 bytes, then ASCII with '.' for bytes that do not print. */
export function xxdLine(bytes: ArrayLike<number>, offset: number, cols = 16): string {
  const hex: string[] = [];
  let ascii = "";
  for (let i = 0; i < cols; i++) {
    const b = bytes[offset + i];
    hex.push(b === undefined ? "  " : b.toString(16).padStart(2, "0"));
    if (b !== undefined) ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
  }
  const pairs: string[] = [];
  for (let i = 0; i < cols; i += 2) pairs.push(hex[i]! + hex[i + 1]!);
  return `${offset.toString(16).padStart(8, "0")}: ${pairs.join(" ")}  ${ascii}`;
}
export function xxd(bytes: ArrayLike<number>, cols = 16): string[] {
  const out: string[] = [];
  for (let o = 0; o < bytes.length; o += cols) out.push(xxdLine(bytes, o, cols).trimEnd());
  return out;
}

export interface DumpField { name: string; offset: number; size: number; meaning: string }

/**
 * The 64-byte header of an example x86-64 ELF executable (a position-independent executable).
 * The layout is from the System V ABI. The entry point, section counts and offsets are example values.
 */
export const ELF_FIELDS: DumpField[] = [
  { name: "magic", offset: 0, size: 4, meaning: "7F 45 4C 46: the byte 0x7F, then the ASCII letters E, L, F" },
  { name: "EI_CLASS", offset: 4, size: 1, meaning: "2 = 64-bit file (1 = 32-bit)" },
  { name: "EI_DATA", offset: 5, size: 1, meaning: "1 = little-endian (2 = big-endian). Every later field uses this byte order" },
  { name: "EI_VERSION", offset: 6, size: 1, meaning: "1 = the current ELF version" },
  { name: "EI_OSABI", offset: 7, size: 1, meaning: "0 = System V" },
  { name: "padding", offset: 8, size: 8, meaning: "unused bytes, zero" },
  { name: "e_type", offset: 16, size: 2, meaning: "3 = ET_DYN, a position-independent executable or a shared library" },
  { name: "e_machine", offset: 18, size: 2, meaning: "0x3E = 62 = EM_X86_64 (183 = AArch64, 243 = RISC-V)" },
  { name: "e_version", offset: 20, size: 4, meaning: "1" },
  { name: "e_entry", offset: 24, size: 8, meaning: "the address of the first instruction" },
  { name: "e_phoff", offset: 32, size: 8, meaning: "the program headers start at byte 64" },
  { name: "e_shoff", offset: 40, size: 8, meaning: "the file offset of the section headers" },
  { name: "e_flags", offset: 48, size: 4, meaning: "0: no flags for x86-64" },
  { name: "e_ehsize", offset: 52, size: 2, meaning: "64: the size of this header" },
  { name: "e_phentsize", offset: 54, size: 2, meaning: "56: the size of one program header" },
  { name: "e_phnum", offset: 56, size: 2, meaning: "the number of program headers" },
  { name: "e_shentsize", offset: 58, size: 2, meaning: "64: the size of one section header" },
  { name: "e_shnum", offset: 60, size: 2, meaning: "the number of section headers" },
  { name: "e_shstrndx", offset: 62, size: 2, meaning: "the index of the section that holds the section names" },
];

/** Writes `value` as `size` little-endian bytes at `offset`. */
function putLe(out: number[], offset: number, size: number, value: bigint) {
  for (let i = 0; i < size; i++) out[offset + i] = Number((value >> BigInt(8 * i)) & 0xffn);
}

export function elfHeaderBytes(): number[] {
  const b = new Array<number>(64).fill(0);
  [0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0].forEach((v, i) => (b[i] = v));
  const set: [number, number, bigint][] = [
    [16, 2, 3n], [18, 2, 62n], [20, 4, 1n], [24, 8, 0x1060n], [32, 8, 64n], [40, 8, 0x3698n],
    [48, 4, 0n], [52, 2, 64n], [54, 2, 56n], [56, 2, 13n], [58, 2, 64n], [60, 2, 31n], [62, 2, 30n],
  ];
  for (const [o, s, v] of set) putLe(b, o, s, v);
  return b;
}

/** Reads `size` little-endian bytes at `offset` as an unsigned value. */
export function readLe(bytes: ArrayLike<number>, offset: number, size: number): bigint {
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i] ?? 0);
  return v;
}

/** The bytes of a string in UTF-8, for a hex dump of text. */
export const textBytes = (s: string): number[] => [...new TextEncoder().encode(s)];

/** An example int32_t array, stored little-endian. The last value spells "ABCD" in the ASCII column. */
export const INT_ARRAY = [1, 255, 256, -1, 1000000, 0x44434241];
export function intArrayBytes(xs: number[] = INT_ARRAY): number[] {
  const out: number[] = [];
  for (const x of xs) putLe(out, out.length, 4, BigInt.asUintN(32, BigInt(x)));
  return out;
}
export const intArrayFields = (xs: number[] = INT_ARRAY): DumpField[] =>
  xs.map((x, i) => ({ name: `a[${i}]`, offset: 4 * i, size: 4, meaning: `int32_t ${x}: the least significant byte comes first` }));
