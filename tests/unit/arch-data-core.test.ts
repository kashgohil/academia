/** Golden-model checks for the data module sims: JS typed arrays, Math.fround, TextEncoder and TextDecoder are the references. */
import { describe, expect, test, vi } from "vitest";

// Exhaustive and golden-model loops: allow time on a busy machine.
vi.setConfig({ testTimeout: 60_000 });
import {
  popcount, nextPow2, applyOp, ctz, clz, wrap, digits,
  add, sub, negate, sra, srl, signExtend, zeroExtend, toSigned, rvSignedAddCheck, rvUnsignedAddCheck, walk, divFloor,
  BINARY64, BINARY32, BINARY16, BFLOAT16, E4M3, E5M2, decode, fromNumber, round, parseDecimal, operate, doubleBits, bitsToDouble, exactDecimal, enumerate, toyFormat, neighbours, exactOf,
  toBytes, fromBytes, bswap, swapOp, SWAP_OPS, bitMap, roundTrip, span, layout, HEADER,
  encodeUtf8, encodeUtf16, decodeUtf8, utf8Length, charStart,
} from "@/sims/arch/data";
import { mulberry32 } from "@/sims/rng";

const rng = mulberry32(7);
const rand32 = () => BigInt(Math.floor(rng() * 2 ** 32));

describe("bits", () => {
  test("popcount, ctz, clz and nextPow2 agree with brute force on 8-bit words", () => {
    for (let x = 0; x < 256; x++) {
      const b = BigInt(x);
      expect(popcount(b)).toBe(x.toString(2).split("").filter((c) => c === "1").length);
      expect(clz(b, 8)).toBe(x === 0 ? 8 : 8 - x.toString(2).length);
      if (x) expect(ctz(b, 8)).toBe(Math.log2(x & -x));
      let p = 1; while (p < x) p *= 2;
      expect(nextPow2(b, 8)).toBe(x === 0 ? 0n : BigInt(p % 256));
      expect(applyOp("clearLowest", b, 8)).toBe(BigInt(x & (x - 1)));
      expect(applyOp("lowest", b, 8)).toBe(BigInt(x & -x));
    }
  });
  test("shifts and masks wrap to the register width", () => {
    expect(applyOp("shl", 0x81n, 8, 0n, 1)).toBe(0x02n);
    expect(applyOp("not", 0n, 64)).toBe(2n ** 64n - 1n);
    expect(applyOp("field", 0xabcdn, 16, 0n, 4, 8)).toBe(0xbcn);
    expect(wrap(-1n, 32)).toBe(0xffffffffn);
    expect(digits(255n, 8, 8)).toBe("377");
    expect(digits(0xbeefn, 16, 32)).toBe("0000BEEF");
  });
});

describe("two's complement", () => {
  test("the 8-bit adder flags match their definitions for every pair", () => {
    const bad: string[] = [];
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
      const r = add(BigInt(a), BigInt(b), 8);
      const sa = a >= 128 ? a - 256 : a, sb = b >= 128 ? b - 256 : b;
      const s = sub(BigInt(a), BigInt(b), 8);
      const wk = walk(BigInt(a), BigInt(b), 8);
      const ok = r.cf === a + b > 255 && r.of === (sa + sb > 127 || sa + sb < -128)
        && s.cf === a < b && s.of === (sa - sb > 127 || sa - sb < -128)
        && rvSignedAddCheck(BigInt(sa), BigInt(sb), 8).overflow === r.of
        && rvUnsignedAddCheck(BigInt(a), BigInt(b), 8).overflow === r.cf
        && wk.crossesCarry === r.cf && wk.crossesOverflow === r.of;
      if (!ok) bad.push(`${a} ${b}`);
    }
    expect(bad).toEqual([]);
  }, 60_000);
  test("negation is invert plus one, and only MIN overflows", () => {
    for (let a = 0; a < 256; a++) {
      const n = negate(BigInt(a), 8);
      expect(n.bits).toBe(BigInt((256 - a) % 256));
      expect(n.overflow).toBe(a === 128);
    }
  });
  test("arithmetic shift rounds toward minus infinity; division truncates", () => {
    for (let a = -128; a < 128; a++) for (let k = 0; k < 8; k++) {
      expect(toSigned(sra(BigInt(a), k, 8), 8)).toBe(divFloor(BigInt(a), 2n ** BigInt(k)));
      expect(srl(BigInt(a), k, 8)).toBe(BigInt((a & 0xff) >> k));
    }
    expect(signExtend(0x80n, 8, 32)).toBe(0xffffff80n);
    expect(zeroExtend(0x80n, 8, 32)).toBe(0x80n);
  });
});

describe("floating point", () => {
  test("binary32 rounding matches Math.fround, and binary64 decoding matches the number", () => {
    for (let i = 0; i < 20000; i++) {
      const x = (rng() - 0.5) * 2 ** Math.floor(rng() * 300 - 150);
      const d = decode(BINARY32, fromNumber(BINARY32, x).bits);
      expect(Object.is(d.value, Math.fround(x)), `${x}`).toBe(true);
      const b = decode(BINARY64, doubleBits(x));
      expect(b.value).toBe(x);
    }
    for (const x of [0, -0, 1e-45, 1.4e-45, 3.4028235e38, 3.4028236e38, 1e39, -1e-46, 2 ** -149 * 1.5, 2 ** -149 * 2.5])
      expect(Object.is(decode(BINARY32, fromNumber(BINARY32, x).bits).value, Math.fround(x)), `${x}`).toBe(true);
  });
  test("decimal strings round exactly like Number()", () => {
    for (let i = 0; i < 3000; i++) {
      const s = `${Math.floor(rng() * 1e6)}.${Math.floor(rng() * 1e9)}e${Math.floor(rng() * 80 - 40)}`;
      const r = round(BINARY64, parseDecimal(s)!);
      expect(bitsToDouble(r.bits), s).toBe(Number(s));
    }
    expect(bitsToDouble(round(BINARY64, parseDecimal("1e400")!).bits)).toBe(Infinity);
    expect(bitsToDouble(round(BINARY64, parseDecimal("2.4703282292062328e-324")!).bits)).toBe(5e-324);
  });
  test("add and mul round once, like JS arithmetic; fma is exact before its one rounding", () => {
    for (let i = 0; i < 5000; i++) {
      const a = (rng() - 0.5) * 10 ** Math.floor(rng() * 20 - 10), b = (rng() - 0.5) * 10 ** Math.floor(rng() * 20 - 10);
      expect(bitsToDouble(operate(BINARY64, "add", doubleBits(a), doubleBits(b)).bits)).toBe(a + b);
      expect(bitsToDouble(operate(BINARY64, "mul", doubleBits(a), doubleBits(b)).bits)).toBe(a * b);
      const fa = Math.fround(a), fb = Math.fround(b);
      expect(decode(BINARY32, operate(BINARY32, "add", fromNumber(BINARY32, fa).bits, fromNumber(BINARY32, fb).bits).bits).value).toBe(Math.fround(fa + fb));
    }
    const x = 1 + 2 ** -30;
    const r = operate(BINARY64, "fma", doubleBits(x), doubleBits(x), doubleBits(-(1 + 2 ** -29)));
    expect(bitsToDouble(r.bits)).toBe(2 ** -60);
    expect(x * x - (1 + 2 ** -29)).toBe(0);
  });
  test("the five rounding modes bracket the exact value", () => {
    const third = { sign: 0 as const, num: 1n, den: 3n };
    const v = (m: Parameters<typeof round>[2]) => decode(BINARY32, round(BINARY32, third, m).bits).value;
    expect(v("rdn")).toBeLessThan(1 / 3);
    expect(v("rup")).toBeGreaterThan(1 / 3);
    expect(v("rtz")).toBe(v("rdn"));
    expect(v("rne")).toBe(Math.fround(1 / 3));
    const neg = { ...third, sign: 1 as const };
    expect(decode(BINARY32, round(BINARY32, neg, "rtz").bits).value).toBe(-v("rdn"));
    // ties: 2.5 in a format with 1 fraction bit → 2 (even) or 3 (away)
    const t = toyFormat(3, 1);
    expect(decode(t, round(t, { sign: 0, num: 5n, den: 2n }, "rne").bits).value).toBe(2);
    expect(decode(t, round(t, { sign: 0, num: 5n, den: 2n }, "rna").bits).value).toBe(3);
  });
  test("narrow formats: known values and every bit pattern round-trips", () => {
    expect(decode(BINARY16, 0x7bffn).value).toBe(65504);
    expect(decode(BINARY16, 0x0001n).value).toBe(2 ** -24);
    expect(decode(BFLOAT16, 0x3f80n).value).toBe(1);
    expect(decode(E4M3, 0x7en).value).toBe(448);
    expect(decode(E4M3, 0x7fn).kind).toBe("nan");
    expect(decode(E4M3, 0x78n).value).toBe(256);
    expect(decode(E5M2, 0x7bn).value).toBe(57344);
    expect(decode(E5M2, 0x7cn).kind).toBe("inf");
    for (const f of [BINARY16, BFLOAT16, E4M3, E5M2, toyFormat(3, 2)])
      expect(enumerate(f).filter((v) => fromNumber(f, v.value).bits !== v.bits).map((v) => v.value), f.id).toEqual([]);
    // bfloat16 is the top half of binary32
    for (let i = 0; i < 2000; i++) {
      const bits = rand32() & 0xffff0000n;
      const d32 = decode(BINARY32, bits), d16 = decode(BFLOAT16, bits >> 16n);
      if (d32.kind !== "nan") expect(d16.value).toBe(d32.value);
    }
  });
  test("exact decimals and neighbours", () => {
    expect(exactDecimal(1n, -1)).toBe("0.5");
    expect(exactDecimal(3n, 4)).toBe("48");
    const e = exactOf(decode(BINARY64, doubleBits(0.1)));
    const [lo, hi] = neighbours(BINARY64, e);
    expect(lo).toBe(hi);
  });
});

describe("byte order", () => {
  test("toBytes and fromBytes match DataView", () => {
    for (let i = 0; i < 500; i++) {
      const x = rand32();
      const dv = new DataView(new ArrayBuffer(4));
      dv.setUint32(0, Number(x), true);
      expect(toBytes(x, 4, "le")).toEqual([...new Uint8Array(dv.buffer)]);
      dv.setUint32(0, Number(x), false);
      expect(toBytes(x, 4, "be")).toEqual([...new Uint8Array(dv.buffer)]);
      expect(fromBytes(toBytes(x, 4, "be"), 0, 4, "be")).toBe(x);
      expect(bswap(bswap(x, 4), 4)).toBe(x);
    }
  });
  test("every swap op is a permutation, and every one but rev32 on 64 bits is its own inverse", () => {
    for (const { op } of SWAP_OPS) for (const w of [16, 32, 64]) {
      const m = bitMap(op, w);
      expect(new Set(m).size).toBe(w);
      const x = rand32() | (rand32() << 32n);
      const v = BigInt.asUintN(w, x);
      expect(swapOp(op, swapOp(op, v, w), w)).toBe(v);
    }
  });
  test("a raw copy breaks only when the two hosts differ; explicit big-endian never breaks", () => {
    for (const w of ["le", "be"] as const) for (const r of ["le", "be"] as const) {
      expect(roundTrip(0x0a000001n, w, "raw", r, "raw").ok).toBe(w === r);
      expect(roundTrip(0x0a000001n, w, "explicit", r, "explicit").ok).toBe(true);
    }
  });
  test("struct layout and spans", () => {
    const b = layout(HEADER, { magic: 0x7f454c46, version: 2 }, "le");
    expect(b.slice(0, 4).map((c) => c.value)).toEqual([0x46, 0x4c, 0x45, 0x7f]);
    expect(span(60, 8).splitsLine).toBe(true);
    expect(span(56, 8).splitsLine).toBe(false);
    expect(span(4092, 8).splitsPage).toBe(true);
  });
});

describe("text", () => {
  test("the UTF-8 and UTF-16 encoders match TextEncoder and JS strings for every scalar value", () => {
    const enc = new TextEncoder();
    for (let cp = 0; cp <= 0x10ffff; cp += cp < 0x3000 ? 1 : 37) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const s = String.fromCodePoint(cp);
      expect(encodeUtf8(cp).map((x) => x.byte), `U+${cp.toString(16)}`).toEqual([...enc.encode(s)]);
      expect(encodeUtf16(cp)).toEqual([...s].flatMap((c) => Array.from({ length: c.length }, (_, i) => c.charCodeAt(i))));
      expect(utf8Length(cp)).toBe(enc.encode(s).length);
    }
  }, 60_000);
  test("the decoder matches TextDecoder (U+FFFD for each maximal subpart) on random bytes", () => {
    const dec = new TextDecoder();
    const pool = [0x41, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe2, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff, 0x82, 0xac];
    for (let i = 0; i < 20000; i++) {
      const bytes = Array.from({ length: 1 + Math.floor(rng() * 7) }, () => pool[Math.floor(rng() * pool.length)]!);
      const want = [...dec.decode(new Uint8Array(bytes))].map((c) => c.codePointAt(0));
      expect(decodeUtf8(bytes).codePoints, bytes.map((b) => b.toString(16)).join(" ")).toEqual(want);
    }
  }, 60_000);
  test("a character start is at most 3 bytes back", () => {
    const b = [...new TextEncoder().encode("a€😀")];
    expect(charStart(b, 3)).toBe(1);
    expect(charStart(b, 7)).toBe(4);
    expect(charStart(b, 0)).toBe(0);
  });
});
