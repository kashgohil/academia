/** Adaptive radix tree: property tests against a sorted Map, key encodings, and every number quoted in the lesson. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  ART, PrefixError, NODE_BYTES, encodeU32, encodeI32, encodeI64, encodeF64, encodeString, concatBytes, compareBytes, hex, artKeys, artMemory,
  btreeBytesPerKey, hashBytesPerKey, ART_WORDS, type NodeType,
} from "@/sims/db/indexes/art";

const hexKey = (b: Uint8Array) => hex(b);

describe("ART matches a reference map", () => {
  for (const kind of ["u32 random", "u32 small", "strings"] as const) {
    test(kind, () => {
      const rng = mulberry32(kind.length);
      const t = new ART<number>();
      const ref = new Map<string, { key: Uint8Array; v: number }>();
      const gen = (): Uint8Array => {
        if (kind === "u32 random") return encodeU32(Math.floor(rng() * 2 ** 32));
        if (kind === "u32 small") return encodeU32(Math.floor(rng() * 3000));
        const len = 1 + Math.floor(rng() * 5);
        return encodeString(Array.from({ length: len }, () => "abcx\u0000"[Math.floor(rng() * 5)]).join(""));
      };
      for (let i = 0; i < 6000; i++) {
        const k = gen();
        const h = hexKey(k);
        if (rng() < 0.65) {
          expect(t.insert(k, i)).toBe(!ref.has(h));
          ref.set(h, { key: k, v: i });
        } else {
          expect(t.delete(k)).toBe(ref.has(h));
          ref.delete(h);
        }
        if (i % 500 === 0) expect(t.check()).toEqual([]);
      }
      expect(t.size).toBe(ref.size);
      for (const { key, v } of ref.values()) expect(t.get(key)).toBe(v);
      expect(t.get(encodeString("zzz-not-there"))).toBeUndefined();
      // An in-order walk is a sorted scan.
      const sorted = [...ref.values()].sort((a, b) => compareBytes(a.key, b.key)).map((x) => hexKey(x.key));
      expect(t.entries().map(([k]) => hexKey(k))).toEqual(sorted);
      expect(t.check()).toEqual([]);
      // Delete everything: the tree empties.
      for (const { key } of ref.values()) t.delete(key);
      expect(t.size).toBe(0);
      expect(t.root).toBeUndefined();
    });
  }
  test("rejects keys that are a prefix of another key", () => {
    const t = new ART<number>();
    t.insert(Uint8Array.of(1, 2, 3), 1);
    expect(() => t.insert(Uint8Array.of(1, 2), 2)).toThrow(PrefixError);
  });
});

describe("node growth with dense 4-byte keys", () => {
  const build = (n: number, d: "dense" | "random" = "dense") => { const t = new ART<number>(); for (const k of artKeys(n, d, 11)) t.insert(encodeU32(k), k); return t; };
  test("node sizes: 52, 160, 656, 2,064 bytes", () => {
    expect([4, 16, 48, 256].map((x) => NODE_BYTES[x as NodeType])).toEqual([52, 160, 656, 2064]);
  });
  test("one node with a 3-byte prefix grows to Node16 at 5, Node48 at 17, Node256 at 49 keys", () => {
    const type = (n: number) => { const ns = build(n).innerNodes(); expect(ns).toHaveLength(1); expect(ns[0]!.node.prefix.length).toBe(3); return ns[0]!.node.type; };
    expect([4, 5, 16, 17, 48, 49].map(type)).toEqual([4, 16, 16, 48, 48, 256]);
  });
  test("20 keys: one Node48, 656 bytes, 32.8 per key; 256 keys: 8.06 per key", () => {
    expect(build(20).stats().bytes).toBe(656);
    expect(Math.round(build(20).stats().bytesPerKey * 10) / 10).toBe(32.8);
    expect(Math.round(build(256).stats().bytesPerKey * 100) / 100).toBe(8.06);
  });
  test("257 keys: a Node4 with a 2-byte prefix appears above the Node256", () => {
    const ns = build(257).innerNodes();
    expect(ns.map((x) => [x.node.type, x.node.prefix.length])).toEqual([[4, 2], [256, 0]]);
  });
  test("300 random keys: Node256 root with 87 Node4 children, mean leaf depth 1.70", () => {
    const s = build(300, "random").stats();
    expect(s.counts).toEqual({ 4: 87, 16: 0, 48: 0, 256: 1 });
    expect(Math.round(s.avgDepth * 100) / 100).toBe(1.7);
    expect(build(300, "random").innerNodes()[0]!.node.type).toBe(256);
  });
  test("46 words: the root is a Node16; the four 'ar' words share a Node4 with prefix 'r'", () => {
    const t = new ART<number>();
    ART_WORDS.forEach((w, i) => t.insert(encodeString(w), i));
    expect(ART_WORDS).toHaveLength(46);
    const ns = t.innerNodes();
    expect(ns[0]!.node.type).toBe(16);
    const ar = ns.find((x) => x.depth === 1 && String.fromCharCode(...x.node.prefix) === "r")!;
    expect(ar.node.type).toBe(4);
    expect(ART_WORDS.filter((w) => w.startsWith("ar"))).toHaveLength(4);
  });
});

describe("binary-comparable encodings keep order", () => {
  const rng = mulberry32(77);
  const check = <T>(gen: () => T, enc: (v: T) => Uint8Array, cmp: (a: T, b: T) => number) => {
    for (let i = 0; i < 3000; i++) {
      const a = gen(), b = gen();
      expect(Math.sign(compareBytes(enc(a), enc(b)))).toBe(Math.sign(cmp(a, b)));
    }
  };
  test("int32, int64, float64, strings and composites", () => {
    check(() => Math.floor(rng() * 2 ** 32) - 2 ** 31, encodeI32, (a, b) => a - b);
    check(() => BigInt(Math.floor(rng() * 2 ** 53)) * (rng() < 0.5 ? -1n : 1n), encodeI64, (a, b) => (a < b ? -1 : a > b ? 1 : 0));
    check(() => (rng() - 0.5) * 10 ** Math.floor(rng() * 12 - 6), encodeF64, (a, b) => a - b);
    const str = () => Array.from({ length: Math.floor(rng() * 4) }, () => "a\u0000béz"[Math.floor(rng() * 5)]).join("");
    const u8 = (s: string) => new TextEncoder().encode(s);
    check(str, encodeString, (a, b) => compareBytes(u8(a), u8(b)));
    check(() => [str(), Math.floor(rng() * 200) - 100] as const, ([s, v]) => concatBytes(encodeString(s), encodeI32(v)), (a, b) => compareBytes(u8(a[0]), u8(b[0])) || a[1] - b[1]);
  });
  test("quoted byte patterns", () => {
    expect(hex(encodeI32(-(2 ** 31)))).toBe("00 00 00 00");
    expect(hex(encodeI32(-1))).toBe("7F FF FF FF");
    expect(hex(encodeI32(0))).toBe("80 00 00 00");
    expect(hex(encodeString("ab"))).toBe("61 62 00 00");
    expect(compareBytes(encodeF64(-0), encodeF64(0))).toBeLessThan(0);
  });
});

describe("memory per key (lesson numbers)", () => {
  const r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100;
  test("4,096 keys: ART dense 8.10, random 24.3; B+ tree 20.9 (69% full), 14.5 (100%); hash table 24.0", () => {
    expect(r2(artMemory(4096, "dense").bytesPerKey)).toBe(8.1);
    expect(r1(artMemory(4096, "random").bytesPerKey)).toBe(24.3);
    expect(r1(btreeBytesPerKey(4))).toBe(20.9);
    expect(r1(btreeBytesPerKey(4, 1))).toBe(14.5);
    expect(r1(hashBytesPerKey(4096, 4))).toBe(24);
  });
});
