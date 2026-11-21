/**
 * Text as bytes: UTF-8 and UTF-16 encoders that show where each bit goes, a UTF-8 decoder that follows the
 * WHATWG Encoding Standard byte by byte (so it matches TextDecoder, including U+FFFD for each maximal
 * subpart), and the four lengths of a string.
 */

export const MAX_CODE_POINT = 0x10ffff;
export const isSurrogate = (cp: number): boolean => cp >= 0xd800 && cp <= 0xdfff;
export const isScalar = (cp: number): boolean => cp >= 0 && cp <= MAX_CODE_POINT && !isSurrogate(cp);
export const hexCp = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** The number of UTF-8 bytes for a code point: 1 up to U+007F, 2 up to U+07FF, 3 up to U+FFFF, else 4. */
export const utf8Length = (cp: number): number => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

export interface Utf8Slot { byte: number; template: string; /** For each x in the template, from left: the code point bit it holds. */ bits: number[] }
/**
 * Encodes one code point and records where each payload bit goes.
 * 1 byte: 0xxxxxxx (7 bits). 2: 110xxxxx 10xxxxxx (11). 3: 1110xxxx 10xxxxxx 10xxxxxx (16). 4: 11110xxx + 3 × 10xxxxxx (21).
 */
export function encodeUtf8(cp: number): Utf8Slot[] {
  const n = utf8Length(cp);
  const payload = [7, 11, 16, 21][n - 1]!;
  const prefixes = n === 1 ? ["0"] : [("1".repeat(n) + "0"), ...Array(n - 1).fill("10")];
  let bit = payload - 1;
  return prefixes.map((p) => {
    const free = 8 - p.length;
    const bits: number[] = [];
    let byte = parseInt(p.padEnd(8, "0"), 2);
    for (let i = free - 1; i >= 0; i--, bit--) {
      bits.push(bit);
      if ((cp >> bit) & 1) byte |= 1 << i;
    }
    return { byte, template: p + "x".repeat(free), bits };
  });
}
export const utf8Bytes = (cp: number): number[] => encodeUtf8(cp).map((s) => s.byte);

/** UTF-16: one unit up to U+FFFF, else a surrogate pair. v = cp − 0x10000; high = 0xD800 + (v >> 10); low = 0xDC00 + (v & 0x3FF). */
export function encodeUtf16(cp: number): number[] {
  if (cp < 0x10000) return [cp];
  const v = cp - 0x10000;
  return [0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)];
}

// ---------------------------------------------------------------- the decoder

export type ByteRole = "ascii" | "lead" | "cont" | "error";
export interface DecodeStep {
  index: number; byte: number; role: ByteRole;
  /** Bytes still needed after this byte. */
  needed: number;
  /** The allowed range for the next byte, if one is needed. */
  lower: number; upper: number;
  /** The code point bits gathered so far. */
  partial: number;
  emitted: number | null;
  /** True if the decoder must read this byte again as the start of a new sequence. */
  reprocess: boolean;
  note: string;
}
export interface Utf8Decoded { steps: DecodeStep[]; codePoints: number[]; errors: number }
const REPLACEMENT = 0xfffd;
const hx = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");

/** Decodes bytes with the WHATWG UTF-8 decoder. Each error emits U+FFFD. */
export function decodeUtf8(bytes: number[]): Utf8Decoded {
  const steps: DecodeStep[] = [];
  const out: number[] = [];
  let needed = 0, seen = 0, cp = 0, lower = 0x80, upper = 0xbf, errors = 0;
  const push = (s: Omit<DecodeStep, "needed" | "lower" | "upper" | "partial">) => steps.push({ ...s, needed: needed - seen, lower, upper, partial: cp });
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (needed === 0) {
      if (b <= 0x7f) { out.push(b); push({ index: i, byte: b, role: "ascii", emitted: b, reprocess: false, note: "0xxxxxxx: one byte, ASCII" }); continue; }
      if (b >= 0xc2 && b <= 0xdf) { needed = 1; cp = b & 0x1f; push({ index: i, byte: b, role: "lead", emitted: null, reprocess: false, note: "110xxxxx: lead of 2 bytes, keep 5 bits" }); continue; }
      if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        needed = 2; cp = b & 0xf;
        push({ index: i, byte: b, role: "lead", emitted: null, reprocess: false, note: `1110xxxx: lead of 3 bytes, keep 4 bits${b === 0xe0 ? ". Next must be A0–BF, or it is overlong" : b === 0xed ? ". Next must be 80–9F, or it is a surrogate" : ""}` });
        continue;
      }
      if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        needed = 3; cp = b & 0x7;
        push({ index: i, byte: b, role: "lead", emitted: null, reprocess: false, note: `11110xxx: lead of 4 bytes, keep 3 bits${b === 0xf0 ? ". Next must be 90–BF, or it is overlong" : b === 0xf4 ? ". Next must be 80–8F, or it is above U+10FFFF" : ""}` });
        continue;
      }
      errors++; out.push(REPLACEMENT);
      const why = b >= 0x80 && b <= 0xbf ? "a continuation byte with no lead byte" : b === 0xc0 || b === 0xc1 ? "C0 and C1 can only start an overlong 2-byte form" : "F5–FF never occur in UTF-8";
      push({ index: i, byte: b, role: "error", emitted: REPLACEMENT, reprocess: false, note: `${hx(b)}: ${why}. Emit U+FFFD` });
      continue;
    }
    if (b < lower || b > upper) {
      const lo = lower, up = upper;
      needed = 0; seen = 0; cp = 0; lower = 0x80; upper = 0xbf; errors++; out.push(REPLACEMENT);
      push({ index: i, byte: b, role: "error", emitted: REPLACEMENT, reprocess: true, note: `${hx(b)} is not in ${hx(lo)}–${hx(up)}. The sequence is broken: emit U+FFFD, then read ${hx(b)} again as a new start` });
      i--; // read this byte again
      continue;
    }
    lower = 0x80; upper = 0xbf;
    cp = (cp << 6) | (b & 0x3f);
    seen++;
    if (seen === needed) {
      const done = cp;
      needed = 0; seen = 0; cp = 0;
      out.push(done);
      steps.push({ index: i, byte: b, role: "cont", needed: 0, lower, upper, partial: done, emitted: done, reprocess: false, note: `10xxxxxx: last continuation byte, add 6 bits. Emit ${hexCp(done)}` });
      continue;
    }
    push({ index: i, byte: b, role: "cont", emitted: null, reprocess: false, note: "10xxxxxx: continuation byte, add 6 bits" });
  }
  if (needed !== 0) {
    errors++; out.push(REPLACEMENT);
    steps.push({ index: bytes.length, byte: -1, role: "error", needed: 0, lower: 0x80, upper: 0xbf, partial: 0, emitted: REPLACEMENT, reprocess: false, note: "The input ends inside a sequence (truncated). Emit U+FFFD" });
  }
  return { steps, codePoints: out, errors };
}

/** Walks back from byte i to the start of its character: skip at most 3 continuation bytes (10xxxxxx). */
export function charStart(bytes: number[], i: number): number {
  let j = i;
  while (j > 0 && i - j < 3 && ((bytes[j] ?? 0) & 0xc0) === 0x80) j--;
  return j;
}

/** Parses "E2 82 AC" or "e282ac" into bytes; null if malformed. */
export function parseHexBytes(s: string): number[] | null {
  const t = s.replace(/0x/gi, "").replace(/[\s,]+/g, "");
  if (t.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(t)) return null;
  const out: number[] = [];
  for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16));
  return out;
}
export const hexBytes = (b: number[]): string => b.map(hx).join(" ");

// ---------------------------------------------------------------- the four lengths of a string

export interface Lengths { utf8Bytes: number; utf16Units: number; codePoints: number; graphemes: number }
export function codePointsOf(s: string): number[] { return [...s].map((c) => c.codePointAt(0)!); }
export function graphemesOf(s: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (!Seg) return [...s];
  return [...new Seg(undefined, { granularity: "grapheme" }).segment(s)].map((x) => x.segment);
}
export function lengths(s: string): Lengths {
  const cps = codePointsOf(s);
  return { utf8Bytes: cps.reduce((n, c) => n + utf8Length(c), 0), utf16Units: s.length, codePoints: cps.length, graphemes: graphemesOf(s).length };
}

/** Which "length" each language gives by default. */
export const LENGTH_APIS: { api: string; counts: keyof Lengths }[] = [
  { api: "Rust s.len(), Go len(s), C strlen", counts: "utf8Bytes" },
  { api: "JS s.length, Java s.length(), C# s.Length", counts: "utf16Units" },
  { api: "Python len(s), Rust s.chars().count(), JS [...s].length", counts: "codePoints" },
  { api: "Swift s.count", counts: "graphemes" },
];

// ---------------------------------------------------------------- order

/** Compares two code point sequences by their UTF-8 bytes, their UTF-16 units, and by code point. */
export function compareEncodings(a: number, b: number): { utf8: number; utf16: number; codePoint: number } {
  const cmp = (x: number[], y: number[]) => {
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return Math.sign(x[i]! - y[i]!);
    return Math.sign(x.length - y.length);
  };
  return { utf8: cmp(utf8Bytes(a), utf8Bytes(b)), utf16: cmp(encodeUtf16(a), encodeUtf16(b)), codePoint: Math.sign(a - b) };
}
