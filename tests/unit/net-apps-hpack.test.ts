import { describe, expect, test } from "vitest";
import { hex } from "../../src/sims/net";
import {
  HPACK_STATIC, HUFFMAN, QPACK_STATIC, HpackDecoder, HpackEncoder, QpackDecoder, QpackEncoder, decodeInt, encodeInt, huffmanDecode, huffmanEncode,
  type Header,
} from "../../src/sims/net/apps";

const h = (lines: string[]): Header[] => lines.map((l) => {
  const i = l.indexOf(": ", 1);
  return [l.slice(0, i), l.slice(i + 2)] as const;
});
const flat = (b: Uint8Array) => hex(b).replace(/ /g, "");

describe("HPACK tables (RFC 7541)", () => {
  test("sizes and anchors", () => {
    expect(HPACK_STATIC.length).toBe(61);
    expect(HPACK_STATIC[0]).toEqual([":authority", ""]);
    expect(HPACK_STATIC[60]).toEqual(["www-authenticate", ""]);
    expect(HUFFMAN.length).toBe(257);
    expect(HUFFMAN[256]).toEqual([0x3fffffff, 30]);
    expect(QPACK_STATIC.length).toBe(99);
    expect(QPACK_STATIC[98]).toEqual(["x-frame-options", "sameorigin"]);
  });
  test("the Huffman code is prefix-free and complete (Kraft sum 1)", () => {
    const kraft = HUFFMAN.reduce((a, [, len]) => a + 2 ** -len, 0);
    expect(kraft).toBeCloseTo(1, 12);
  });
});

describe("HPACK integers (RFC 7541 C.1)", () => {
  test("10 in a 5-bit prefix, 1337 in a 5-bit prefix, 42 in 8 bits", () => {
    const a: number[] = [];
    encodeInt(10, 5, 0, a);
    expect(a).toEqual([10]);
    const b: number[] = [];
    encodeInt(1337, 5, 0, b);
    expect(b).toEqual([31, 154, 10]);
    expect(decodeInt(new Uint8Array(b), 0, 5)).toEqual([1337, 3]);
    const c: number[] = [];
    encodeInt(42, 8, 0, c);
    expect(c).toEqual([42]);
  });
});

describe("HPACK request examples (RFC 7541 C.3 and C.4)", () => {
  const reqs = [
    h([":method: GET", ":scheme: http", ":path: /", ":authority: www.example.com"]),
    h([":method: GET", ":scheme: http", ":path: /", ":authority: www.example.com", "cache-control: no-cache"]),
    h([":method: GET", ":scheme: https", ":path: /index.html", ":authority: www.example.com", "custom-key: custom-value"]),
  ];
  test("without Huffman", () => {
    const e = new HpackEncoder(4096, { huffman: false });
    const d = new HpackDecoder();
    const want = ["828684410f7777772e6578616d706c652e636f6d", "828684be58086e6f2d6361636865", "828785bf400a637573746f6d2d6b65790c637573746f6d2d76616c7565"];
    reqs.forEach((r, i) => {
      const out = e.encode(r);
      expect(flat(out.bytes)).toBe(want[i]);
      expect(d.decode(out.bytes)).toEqual(r);
    });
    expect(e.table.size).toBe(164);
    expect(d.table.entries).toEqual(e.table.entries);
  });
  test("with Huffman", () => {
    const e = new HpackEncoder(4096, { huffman: true });
    const d = new HpackDecoder();
    const want = ["828684418cf1e3c2e5f23a6ba0ab90f4ff", "828684be5886a8eb10649cbf", "828785bf408825a849e95ba97d7f8925a849e95bb8e8b4bf"];
    reqs.forEach((r, i) => {
      const out = e.encode(r);
      expect(flat(out.bytes)).toBe(want[i]);
      expect(d.decode(out.bytes)).toEqual(r);
    });
  });
});

describe("HPACK response examples with eviction (RFC 7541 C.6, table size 256)", () => {
  test("three responses", () => {
    const e = new HpackEncoder(256, { huffman: true });
    const d = new HpackDecoder(256);
    const rs = [
      h([":status: 302", "cache-control: private", "date: Mon, 21 Oct 2013 20:13:21 GMT", "location: https://www.example.com"]),
      h([":status: 307", "cache-control: private", "date: Mon, 21 Oct 2013 20:13:21 GMT", "location: https://www.example.com"]),
      h([":status: 200", "cache-control: private", "date: Mon, 21 Oct 2013 20:13:22 GMT", "location: https://www.example.com", "content-encoding: gzip", "set-cookie: foo=ASDJKHQKBZXOQWEOPIUAXQWEOIU; max-age=3600; version=1"]),
    ];
    const want = [
      "488264025885aec3771a4b6196d07abe941054d444a8200595040b8166e082a62d1bff6e919d29ad171863c78f0b97c8e9ae82ae43d3",
      "4883640effc1c0bf",
      "88c16196d07abe941054d444a8200595040b8166e084a62d1bffc05a839bd9ab77ad94e7821dd7f2e6c7b335dfdfcd5b3960d5af27087f3672c1ab270fb5291f9587316065c003ed4ee5b1063d5007",
    ];
    rs.forEach((r, i) => {
      const out = e.encode(r);
      expect(flat(out.bytes)).toBe(want[i]);
      expect(d.decode(out.bytes)).toEqual(r);
    });
    expect(e.table.size).toBe(215);
    expect(e.table.entries.length).toBe(3);
  });
  test("Huffman round trip of every byte", () => {
    const s = String.fromCharCode(...Array.from({ length: 128 }, (_, i) => i));
    expect(huffmanDecode(huffmanEncode(s))).toBe(s);
  });
});

describe("QPACK (RFC 9204 appendix B)", () => {
  test("B.1: literal with a static name reference", () => {
    const e = new QpackEncoder(0);
    const s = e.encodeSection([[":path", "/index.html"]], { allowBlocking: true });
    expect(flat(s.bytes)).toBe("0000510b2f696e6465782e68746d6c");
    expect(s.instructions).toEqual([]);
  });
  test("B.2: inserts on the encoder stream, post-base references", () => {
    const e = new QpackEncoder(220);
    const s = e.encodeSection([[":authority", "www.example.com"], [":path", "/sample/path"]], { allowBlocking: true });
    expect(s.instructions.map((i) => flat(i.bytes))).toEqual(["3fbd01", "c00f7777772e6578616d706c652e636f6d", "c10c2f73616d706c652f70617468"]);
    expect(flat(s.bytes)).toBe("03811011");
    expect(e.table.size).toBe(106);
    const d = new QpackDecoder(220);
    expect(d.decodeSection(s.bytes)).toBe("blocked");
    for (const i of s.instructions) d.onEncoderStream(i.bytes);
    expect(d.decodeSection(s.bytes)).toEqual([[":authority", "www.example.com"], [":path", "/sample/path"]]);
  });
  test("an encoder that never blocks sends literals until the decoder acknowledges", () => {
    const e = new QpackEncoder(220);
    const first = e.encodeSection([[":authority", "www.example.com"]], { allowBlocking: false });
    expect(first.requiredInsertCount).toBe(0);
    expect(first.lines[0]!.kind).toBe("literal-static-name");
    e.acknowledge(1);
    const second = e.encodeSection([[":authority", "www.example.com"]], { allowBlocking: false });
    expect(second.lines[0]!.kind).toBe("dynamic");
    expect(second.bytes.length).toBe(3);
  });
});
