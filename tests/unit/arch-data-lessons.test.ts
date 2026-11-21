/** Pins every number that the five Architecture → Data lessons quote. */
import { describe, expect, test, vi } from "vitest";

// Exhaustive and golden-model loops: allow time on a busy machine.
vi.setConfig({ testTimeout: 60_000 });
import {
  mask, decimalDigits, applyOp, flipBit, wrapSeconds, humanDuration, unix32Max, intArrayBytes, elfHeaderBytes, xxdLine,
  add, minSigned, maxSigned, signExtend, zeroExtend, toSigned, sra, divTrunc, negate, divide, walk, langAdd,
  BINARY64, BINARY32, BINARY16, BFLOAT16, E4M3, E5M2, decode, fromNumber, doubleBits, bitsToDouble, operate, neighbours, decimalOf, round, parseDecimal,
  stats, toyFormat, enumerate, relError, sumData, sum32, exactSum32, ulpsOff32, harmonicStall32, maxFiniteBits,
  toBytes, layout, HEADER, structSize, roundTrip, swapOp, span, splitFraction, pdp11Bytes, fieldBits,
  utf8Bytes, encodeUtf16, lengths, decodeUtf8, compareEncodings, charStart, MAX_CODE_POINT,
} from "@/sims/arch/data";

describe("binary and hexadecimal", () => {
  test("the size table", () => {
    expect([8, 16, 32, 64].map((w) => mask(w).toString())).toEqual(["255", "65535", "4294967295", "18446744073709551615"]);
    expect([8, 16, 32, 64].map(decimalDigits)).toEqual([3, 5, 10, 20]);
    expect(Math.log2(10).toFixed(2)).toBe("3.32");
  });
  test("demo values", () => {
    expect(flipBit(1n, 31, 32)).toBe(2147483649n);
    expect(flipBit(0n, 15, 16)).toBe(32768n);
    expect(applyOp("clearLowest", 104n, 16)).toBe(96n);
    expect(applyOp("clearLowest", 64n, 16)).toBe(0n);
    expect(2 ** 32).toBe(4294967296);
  });
  test("wrap times", () => {
    expect(humanDuration(wrapSeconds(32, 1e3))).toBe("49.7 days");
    expect(humanDuration(wrapSeconds(32, 1e9))).toBe("4.29 s");
    expect(humanDuration(wrapSeconds(64, 1e9))).toBe("585 years");
    expect(humanDuration(wrapSeconds(64, 3e9))).toBe("195 years");
    expect(unix32Max()).toBe("2038-01-19T03:14:07Z");
  });
  test("hex dump", () => {
    const b = intArrayBytes();
    expect(b.slice(8, 12)).toEqual([0, 1, 0, 0]);
    expect(b.slice(12, 16)).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(xxdLine(b, 16)).toContain("ABCD");
    const e = elfHeaderBytes();
    expect(e.slice(0, 4)).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    expect(e[18]).toBe(0x3e);
  });
});

describe("two's complement", () => {
  test("ranges", () => {
    expect([minSigned(8), maxSigned(8)]).toEqual([-128n, 127n]);
  });
  test("the wheel examples", () => {
    const r = add(6n, 3n, 4);
    expect([r.bits, r.signed, r.cf, r.of, r.sf]).toEqual([0b1001n, -7n, false, true, true]);
    const m = add(6n, -3n, 4);
    expect([walk(6n, -3n, 4).unsignedSteps, m.cf, m.of, m.signed]).toEqual([13n, true, false, 3n]);
    const n = add(8n, -1n, 4);
    expect([n.signed, n.of]).toEqual([7n, true]);
    expect(negate(0x80n, 8)).toEqual({ inverted: 0x7fn, bits: 0x80n, overflow: true });
  });
  test("extension and shifts", () => {
    expect(signExtend(0xf6n, 8, 32)).toBe(0xfffffff6n);
    expect(toSigned(signExtend(0xf6n, 8, 32), 32)).toBe(-10n);
    expect(zeroExtend(0xf6n, 8, 32)).toBe(246n);
    expect(toSigned(sra(-7n, 1, 8), 8)).toBe(-4n);
    expect(divTrunc(-7n, 2n)).toBe(-3n);
    expect(toSigned(sra(-8n, 1, 8), 8)).toBe(-4n);
  });
  test("edge cases", () => {
    expect(add(maxSigned(32), 1n, 32).signed).toBe(minSigned(32));
    expect(langAdd(maxSigned(32), 1n, 32, "c").kind).toBe("ub");
    expect(langAdd(maxSigned(32), 1n, 32, "rustDebug").kind).toBe("panic");
    expect(langAdd(maxSigned(32), 1n, 32, "go").value).toBe(minSigned(32));
    expect(divide(minSigned(32), -1n, 32, "x86").kind).toBe("trap");
    expect(divide(minSigned(32), -1n, 32, "riscv")).toMatchObject({ q: minSigned(32), r: 0n });
    expect(divide(minSigned(32), -1n, 32, "arm64").q).toBe(minSigned(32));
    expect(divide(7n, 0n, 32, "riscv").q).toBe(-1n);
    expect(divide(7n, 0n, 32, "arm64").q).toBe(0n);
    expect(divide(minSigned(32), -1n, 32, "rust").kind).toBe("panic");
  });
});

describe("IEEE 754", () => {
  const b64 = (x: number) => decode(BINARY64, doubleBits(x));
  test("0.1", () => {
    const d = decode(BINARY32, fromNumber(BINARY32, 0.1).bits);
    expect(decimalOf(d)).toBe("0.100000001490116119384765625");
    expect(d.expField).toBe(123);
    expect(d.unbiased).toBe(-4);
    const s = decimalOf(b64(0.1));
    expect(s).toBe("0.1000000000000000055511151231257827021181583404541015625");
    expect(s.length - 2).toBe(55);
  });
  test("0.1 + 0.2 is a tie, and ties to even picks the upper neighbour", () => {
    const r = operate(BINARY64, "add", doubleBits(0.1), doubleBits(0.2));
    const [lo, hi] = neighbours(BINARY64, r.exact!);
    expect(r.bits).toBe(hi);
    expect(hi & 1n).toBe(0n);
    expect(bitsToDouble(hi)).toBe(0.30000000000000004);
    expect(bitsToDouble(lo)).toBe(0.3);
    // the exact sum is the midpoint
    const L = decode(BINARY64, lo), H = decode(BINARY64, hi);
    expect(H.sig - L.sig).toBe(1n);
    expect(bitsToDouble(operate(BINARY64, "add", doubleBits(0.1), doubleBits(0.2), 0n, "rtz").bits)).toBe(0.3);
  });
  test("large integers", () => {
    const r = operate(BINARY64, "add", doubleBits(1e16), doubleBits(1));
    const [lo, hi] = neighbours(BINARY64, r.exact!);
    expect(bitsToDouble(hi) - bitsToDouble(lo)).toBe(2);
    expect(bitsToDouble(r.bits)).toBe(1e16);
    expect(bitsToDouble(round(BINARY64, parseDecimal("9007199254740993")!).bits)).toBe(9007199254740992);
  });
  test("density", () => {
    const t = toyFormat(3, 2);
    expect(stats(t).maxFinite).toBe(14);
    const vs = enumerate(t).map((v) => v.value);
    expect(vs.filter((v) => v >= 1 && v < 2).length).toBe(4);
    expect(vs.filter((v) => v >= 4 && v < 8).length).toBe(4);
    expect(enumerate(t).filter((v) => v.kind === "subnormal").length).toBe(3);
    // binary32: every binade has 2^23 values
    const count = (a: number, b: number) => Number(decode(BINARY32, fromNumber(BINARY32, b).bits).bits - decode(BINARY32, fromNumber(BINARY32, a).bits).bits);
    expect(count(1, 2)).toBe(8388608);
    expect(count(1024, 2048)).toBe(8388608);
  });
  test("sum order (n = 10,000)", () => {
    const off = (k: Parameters<typeof sumData>[0], o: Parameters<typeof sum32>[1]) => { const xs = sumData(k, 10000); return Math.round(ulpsOff32(sum32(xs, o), exactSum32(xs))); };
    expect(off("bigSmall", "forward")).toBe(839);
    expect(off("bigSmall", "ascending")).toBe(0);
    expect(off("mixed", "forward")).toBe(822);
    expect(off("mixed", "pairwise")).toBe(2);
    expect(off("harmonic", "kahan")).toBe(0);
    expect(harmonicStall32()).toEqual({ n: 2097152, sum: Math.fround(15.403683) });
  });
  test("narrow formats", () => {
    expect(relError(BINARY16, 70000).kind).toBe("inf");
    const bf = relError(BFLOAT16, 70000);
    expect(bf.stored).toBe(70144);
    expect((bf.rel * 100).toFixed(2)).toBe("0.21");
    expect((relError(BINARY16, 0.1).rel * 100).toFixed(3)).toBe("0.024");
    expect(relError(E4M3, 500).kind).toBe("nan");
    expect(relError(E4M3, 500, true).stored).toBe(448);
    expect([BINARY16, E4M3, E5M2].map((f) => stats(f).maxFinite)).toEqual([65504, 448, 57344]);
    expect(stats(BFLOAT16).maxFinite.toPrecision(3)).toBe("3.39e+38");
    expect(stats(BINARY32).maxFinite.toPrecision(2)).toBe("3.4e+38");
    expect(stats(BINARY64).maxFinite.toPrecision(2)).toBe("1.8e+308");
    // an IEEE-style E4M3 would reserve the top exponent and stop at 240
    expect(decode(toyFormat(4, 3), maxFiniteBits(toyFormat(4, 3))).value).toBe(240);
    expect([BINARY64, BINARY32, BINARY16, BFLOAT16, E4M3, E5M2].map((f) => -Math.log2(stats(f).epsilon))).toEqual([52, 23, 10, 7, 3, 2]);
  });
});

describe("endianness", () => {
  test("struct and values", () => {
    expect(structSize(HEADER)).toBe(24);
    expect(toBytes(0x0a000001n, 4, "le")).toEqual([0x01, 0, 0, 0x0a]);
    expect(toBytes(0x0a000001n, 4, "be")).toEqual([0x0a, 0, 0, 0x01]);
    const v = { delta: -2 };
    expect(layout(HEADER, v, "le").slice(20).map((c) => c.value)).toEqual([0xfe, 0xff, 0xff, 0xff]);
    expect(layout(HEADER, v, "be").slice(20).map((c) => c.value)).toEqual([0xff, 0xff, 0xff, 0xfe]);
    expect(fieldBits("f32", 1.5)).toBe(0x3fc00000n);
  });
  test("boundary, swaps, PDP-11", () => {
    const t = roundTrip(0x0a000001n, "le", "raw", "be", "raw");
    expect(t.read).toBe(0x0100000an);
    expect(Number(t.read)).toBe(16777226);
    expect(swapOp("rev", 0x89abcdefn, 32)).toBe(0xefcdab89n);
    expect(pdp11Bytes(0x0a0b0c0dn)).toEqual([0x0b, 0x0a, 0x0d, 0x0c]);
  });
  test("alignment", () => {
    expect(span(60, 8).splitsLine).toBe(true);
    expect(span(56, 8).splitsLine).toBe(false);
    expect([2, 4, 8, 16, 32, 64].map((z) => (splitFraction(z) * 100).toFixed(1))).toEqual(["1.6", "4.7", "10.9", "23.4", "48.4", "98.4"]);
  });
});

describe("UTF-8", () => {
  test("code space and encodings", () => {
    expect(MAX_CODE_POINT + 1).toBe(1114112);
    expect(0xdfff - 0xd800 + 1).toBe(2048);
    expect(utf8Bytes(0x20ac)).toEqual([0xe2, 0x82, 0xac]);
    expect(0x20ac.toString(2).length).toBe(14);
    expect(encodeUtf16(0x1f600)).toEqual([0xd83d, 0xde00]);
    expect(compareEncodings(0xff61, 0x1f600)).toEqual({ utf8: -1, utf16: 1, codePoint: -1 });
  });
  test("lengths", () => {
    expect(lengths("👨‍👩‍👧")).toEqual({ utf8Bytes: 18, utf16Units: 8, codePoints: 5, graphemes: 1 });
    expect(lengths("naïve 👨‍👩‍👧")).toEqual({ utf8Bytes: 25, utf16Units: 14, codePoints: 11, graphemes: 7 });
    expect(lengths("👍🏽")).toMatchObject({ codePoints: 2, graphemes: 1 });
    expect(lengths("🇯🇵")).toMatchObject({ codePoints: 2, graphemes: 1 });
    expect(lengths("naïve".normalize("NFC")).utf8Bytes).toBe(6);
    expect(lengths("naïve".normalize("NFD")).utf8Bytes).toBe(7);
  });
  test("invalid sequences", () => {
    expect(decodeUtf8([0xc0, 0xaf, 0x41]).codePoints).toEqual([0xfffd, 0xfffd, 0x41]);
    expect(decodeUtf8([0xed, 0xa0, 0x80, 0x41]).codePoints).toEqual([0xfffd, 0xfffd, 0xfffd, 0x41]);
    expect(decodeUtf8([0xe2, 0x82, 0x41]).codePoints).toEqual([0xfffd, 0x41]);
    expect(decodeUtf8([0xf4, 0x90, 0x80, 0x80]).errors).toBeGreaterThan(0);
    const b = utf8Bytes(0x1f600);
    expect(charStart(b, 3)).toBe(0);
  });
});
