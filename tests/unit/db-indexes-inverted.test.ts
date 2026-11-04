/** Inverted indexes: queries and codecs against brute force, and every number quoted in inverted-indexes.mdx. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  buildIndex, tokenize, postings, intersectMerge, intersectGallop, union, phrase, randomPostings, burstyPostings, deltas, undelta, varintEncode,
  varintDecode, varintLen, forEncode, forDecode, pforEncode, pforDecode, compressionSizes, bm25Rank, idf, CORPUS,
} from "@/sims/db/indexes/inverted";

const ix = buildIndex(CORPUS);
const docs = (t: string) => postings(ix, t).map((p) => p.doc);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

describe("index and queries against brute force", () => {
  test("postings equal a scan of the tokenized documents", () => {
    for (const [term, list] of ix.terms) {
      const want = CORPUS.flatMap((d, i) => { const ps = tokenize(d).filter((t) => t.term === term).map((t) => t.pos); return ps.length ? [{ doc: i, tf: ps.length, pos: ps }] : []; });
      expect(list).toEqual(want);
    }
  });
  test("merge, gallop and union equal set operations on random lists", () => {
    const rng = mulberry32(4);
    for (let i = 0; i < 300; i++) {
      const a = randomPostings(1 + Math.floor(rng() * 50), 400, i), b = randomPostings(1 + Math.floor(rng() * 400), 400, i + 1000);
      const sb = new Set(b);
      const inter = a.filter((x) => sb.has(x));
      expect(intersectMerge(a, b).out).toEqual(inter);
      expect(intersectGallop(a, b).out).toEqual(inter);
      expect(union(a, b)).toEqual([...new Set([...a, ...b])].sort((x, y) => x - y));
    }
  });
  test("phrase = documents whose token sequence contains the phrase", () => {
    for (const ph of [["sorted", "runs"], ["inverted", "index"], ["lsm", "tree"], ["runs", "sorted"]]) {
      const want = CORPUS.map((d, i) => [i, tokenize(d)] as const).filter(([, ts]) => ts.some((t, j) => t.term === ph[0] && ts.find((u) => u.pos === t.pos + 1)?.term === ph[1] && j >= 0)).map(([i]) => i);
      expect(phrase(ix, ph).docs).toEqual(want);
    }
  });
});

describe("codecs round-trip", () => {
  test("varint, FOR and PForDelta decode to the input", () => {
    for (const ids of [randomPostings(1000, 1e6, 1), randomPostings(300, 2e9, 2), burstyPostings(1000, 4), [5], []]) {
      const g = deltas(ids);
      expect(undelta(g)).toEqual(ids);
      expect(varintDecode(varintEncode(g))).toEqual(g);
      expect(forDecode(forEncode(g), g.length)).toEqual(g);
      expect(pforDecode(pforEncode(g), g.length)).toEqual(g);
    }
  });
  test("varint lengths: 100 → 1 byte, 300 → 2 bytes (AC 02)", () => {
    expect([varintLen(100), varintLen(300)]).toEqual([1, 2]);
    expect([...varintEncode([300])]).toEqual([0xac, 0x02]);
  });
});

describe("lesson numbers", () => {
  test("corpus: 6 docs, doc 4 has 8 terms, doc 5 has 21, average 11.5", () => {
    expect(CORPUS).toHaveLength(6);
    expect([ix.docLen[4], ix.docLen[5], ix.avgdl]).toEqual([8, 21, 11.5]);
  });
  test("sorted AND runs: 5 comparisons, docs 1, 2, 5; phrase keeps 1 and 2; doc 5 has sorted at 22, runs at 11", () => {
    const r = intersectMerge(docs("sorted"), docs("runs"));
    expect(r).toEqual({ out: [1, 2, 5], comparisons: 5 });
    expect(phrase(ix, ["sorted", "runs"]).docs).toEqual([1, 2]);
    expect(postings(ix, "sorted").find((p) => p.doc === 5)!.pos).toEqual([22]);
    expect(postings(ix, "runs").find((p) => p.doc === 5)!.pos).toEqual([11]);
  });
  test("hash OR lsm: 1, 3, 5", () => {
    expect(union(docs("hash"), docs("lsm"))).toEqual([1, 3, 5]);
  });
  test("10 × 10,000 ids: merge 9,961 comparisons, gallop 180", () => {
    const s = randomPostings(10, 1e6, 1), l = randomPostings(10000, 1e6, 2);
    expect([intersectMerge(s, l).comparisons, intersectGallop(s, l).comparisons]).toEqual([9961, 180]);
  });
  test("compression of 10,000 of 1 M: 40,000 B raw, varint 12,798 B (10.2), FOR 9.6, PFor 9.2 bits/id", () => {
    const c = compressionSizes(randomPostings(10000, 1e6, 4));
    expect([c.raw, c.varint]).toEqual([40000, 12798]);
    expect([r1(c.bitsPerId.varint), r1(c.bitsPerId.for), r1(c.bitsPerId.pfor)]).toEqual([10.2, 9.6, 9.2]);
  });
  test("100,000 of 1 M: varint 8, FOR 6.2, PFor 5.7 bits/id; bursty 10,000: FOR 14.0, PFor 4.3", () => {
    const c = compressionSizes(randomPostings(100000, 1e6, 4));
    expect([r1(c.bitsPerId.varint), r1(c.bitsPerId.for), r1(c.bitsPerId.pfor)]).toEqual([8, 6.2, 5.7]);
    const b = compressionSizes(burstyPostings(10000, 4));
    expect([r1(b.bitsPerId.for), r1(b.bitsPerId.pfor)]).toEqual([14, 4.3]);
  });
  test("idf: 1 of 6 docs → 1.54, 5 of 6 → 0.24", () => {
    expect([r2(idf(6, 1)), r2(idf(6, 5))]).toEqual([1.54, 0.24]);
  });
  test("BM25 'inverted index': doc 4 beats doc 5; b = 0 flips it (1.983 vs 1.723); k1 = 0 ties at 1.723", () => {
    const def = bm25Rank(ix, "inverted index");
    expect(def.map((r) => r.doc)).toEqual([4, 5, 3]);
    expect(postings(ix, "index").find((p) => p.doc === 5)!.tf).toBe(2);
    const b0 = bm25Rank(ix, "inverted index", { k1: 1.2, b: 0 });
    expect(b0.slice(0, 2).map((r) => [r.doc, r3(r.score)])).toEqual([[5, 1.983], [4, 1.723]]);
    const k0 = bm25Rank(ix, "inverted index", { k1: 0, b: 0.75 });
    expect([r3(k0[0]!.score), r3(k0[1]!.score)]).toEqual([1.723, 1.723]);
  });
  test("BM25 'sorted runs': docs 1 and 2 lead; runs has tf 2 there and a higher idf than sorted", () => {
    expect(bm25Rank(ix, "sorted runs").slice(0, 2).map((r) => r.doc)).toEqual([1, 2]);
    expect([1, 2].map((d) => postings(ix, "runs").find((p) => p.doc === d)!.tf)).toEqual([2, 2]);
    expect(idf(6, docs("runs").length)).toBeGreaterThan(idf(6, docs("sorted").length));
  });
});
