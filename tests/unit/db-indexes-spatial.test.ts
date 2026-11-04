/** R-trees and space-filling curves: property tests against brute force, and every number quoted in the lesson. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import { RTree, demoItems, intersects, minDist, avgVisited, RTREE_QUERY, type Item } from "@/sims/db/indexes/rtree";
import { zEncode, zDecode, hilbertEncode, hilbertDecode, boxRanges, meanRanges, geohash, CURVE_BOX } from "@/sims/db/indexes/sfc";

const randItems = (n: number, seed: number): Item[] => {
  const r = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const x = r() * 100, y = r() * 100, w = r() < 0.4 ? 0 : r() * 8, h = r() < 0.4 ? 0 : r() * 8;
    return { id: i + 1, r: { x0: x, y0: y, x1: x + w, y1: y + h } };
  });
};

describe("R-tree against brute force", () => {
  test("range search, kNN, invariants, with deletes", () => {
    for (const M of [3, 4, 6, 9]) {
      const items = randItems(400, M);
      const t = new RTree(M);
      for (const it of items) t.insert(it);
      expect(t.check()).toEqual([]);
      const live = new Map(items.map((i) => [i.id, i]));
      const rng = mulberry32(100 + M);
      for (let i = 0; i < 120; i++) { const id = 1 + Math.floor(rng() * 400); expect(t.delete(id)).toBe(live.delete(id)); }
      expect(t.check()).toEqual([]);
      expect(t.size).toBe(live.size);
      for (let q = 0; q < 60; q++) {
        const x = rng() * 90, y = rng() * 90, s = rng() * 30;
        const box = { x0: x, y0: y, x1: x + s, y1: y + s };
        const want = [...live.values()].filter((it) => intersects(it.r, box)).map((it) => it.id).sort((a, b) => a - b);
        expect(t.search(box).results.sort((a, b) => a - b)).toEqual(want);
        const px = rng() * 100, py = rng() * 100;
        const nn = t.knn(px, py, 5);
        const bd = [...live.values()].map((it) => minDist(px, py, it.r)).sort((a, b) => a - b).slice(0, 5);
        expect(nn.dists.map((d) => d.toFixed(9))).toEqual(bd.map((d) => d.toFixed(9)));
      }
    }
  });
});

describe("R-tree demo numbers", () => {
  const build = (M: number) => { const t = new RTree(M); for (const it of demoItems()) t.insert(it); return t; };
  test("M = 4: 28 items, 3 levels, 15 nodes; default query visits 5, tests 17, finds 5", () => {
    const t = build(4);
    expect([demoItems().length, t.height, t.nodeCount()]).toEqual([28, 3, 15]);
    const s = t.search(RTREE_QUERY);
    expect([s.visited.length, s.tested, s.results.length]).toEqual([5, 17, 5]);
  });
  test("M = 8: 2 levels, 6 nodes; the query visits 3 and tests 15", () => {
    const t = build(8);
    expect([t.height, t.nodeCount()]).toEqual([2, 6]);
    const s = t.search(RTREE_QUERY);
    expect([s.visited.length, s.tested]).toEqual([3, 15]);
  });
  test("3 nearest to (70, 30): 4, 19, 28 after opening 5 nodes", () => {
    const k = build(4).knn(70, 30, 3);
    expect(new Set(k.ids)).toEqual(new Set([4, 19, 28]));
    expect(k.visited).toHaveLength(5);
  });
  test("2,000 random points: height, nodes and nodes visited for M = 4, 16, 50", () => {
    const rows = [4, 16, 50].map((M) => {
      const t = new RTree(M);
      let s = 1;
      const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      for (let i = 0; i < 2000; i++) { const x = r() * 99, y = r() * 99; t.insert({ id: i, r: { x0: x, y0: y, x1: x + 0.5, y1: y + 0.5 } }); }
      const v = avgVisited(t, 0.05);
      return [t.height, t.nodeCount(), Math.round(v.visited * 10) / 10, Math.round(v.results * 10) / 10];
    });
    expect(rows).toEqual([[7, 1008, 15.7, 6.2], [3, 193, 6.7, 6.2], [3, 62, 4.1, 6.2]]);
  });
});

describe("space-filling curves", () => {
  test("Z-order and Hilbert are bijections; Hilbert steps are unit moves", () => {
    for (const n of [2, 4, 8, 16, 32]) {
      const seenZ = new Set<number>(), seenH = new Set<number>();
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
        const z = zEncode(x, y), h = hilbertEncode(n, x, y);
        expect(zDecode(z)).toEqual([x, y]);
        expect(hilbertDecode(n, h)).toEqual([x, y]);
        seenZ.add(z); seenH.add(h);
      }
      expect(seenH.size).toBe(n * n);
      expect(Math.max(...seenZ)).toBe(n * n - 1);
      for (let d = 1; d < n * n; d++) {
        const [a, b] = hilbertDecode(n, d - 1), [c, e] = hilbertDecode(n, d);
        expect(Math.abs(a - c) + Math.abs(b - e)).toBe(1);
      }
    }
  });
  test("exact ranges cover exactly the box; merged ranges cover a superset", () => {
    const rng = mulberry32(8);
    for (let i = 0; i < 100; i++) {
      const n = 16, x0 = Math.floor(rng() * 12), y0 = Math.floor(rng() * 12), w = 1 + Math.floor(rng() * 4), h = 1 + Math.floor(rng() * 4);
      const box = { x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 };
      for (const c of ["z", "hilbert"] as const) {
        const cov = boxRanges(c, n, box, 3);
        const cells = cov.ranges.reduce((s, [a, z]) => s + z - a + 1, 0);
        expect(cells).toBe(w * h);
        expect(cov.merged.length).toBeLessThanOrEqual(3);
        expect(cov.falsePositives).toBeGreaterThanOrEqual(0);
      }
    }
  });
  test("default 6 × 5 box on 16 × 16: 30 cells; Z 13 ranges, Hilbert 7; false positives with ≤ 4 and ≤ 1 ranges", () => {
    const box = { x0: CURVE_BOX.x0, y0: CURVE_BOX.y0, x1: CURVE_BOX.x0 + CURVE_BOX.w - 1, y1: CURVE_BOX.y0 + CURVE_BOX.h - 1 };
    const z = boxRanges("z", 16, box), h = boxRanges("hilbert", 16, box);
    expect([z.cells, z.ranges.length, h.ranges.length]).toEqual([30, 13, 7]);
    expect([boxRanges("z", 16, box, 4).falsePositives, boxRanges("hilbert", 16, box, 4).falsePositives]).toEqual([26, 7]);
    expect([boxRanges("z", 16, box, 1).falsePositives, boxRanges("hilbert", 16, box, 1).falsePositives]).toEqual([126, 155]);
  });
  test("mean ranges for random 6 × 5 boxes: Z 8.8, Hilbert 5.3", () => {
    expect(Math.round(meanRanges("z", 16, 6, 5, 200) * 10) / 10).toBe(8.8);
    expect(Math.round(meanRanges("hilbert", 16, 6, 5, 200) * 10) / 10).toBe(5.3);
  });
  test("geohash of (57.64911, 10.40744) is u4pruydqqvj", () => {
    expect(geohash(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
  });
});
