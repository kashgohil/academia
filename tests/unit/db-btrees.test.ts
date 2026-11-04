import { describe, expect, test } from "vitest";
import {
  BPlusTree, type BEvent, strCmp, randomOps, keyOrder, fillExperiment, bulkExperiment, fillHistogram, fillFactorSweep, growthCurve,
  pageCapacity, treeHeight, levelSizes, cachedLevels, lookupIOs, bstDepth, binarySearchLines, btreeLookupLines,
  shortestSeparator, commonPrefix, LAB_KEYS, leafShare,
} from "@/sims/db/btree";
import { mulberry32 } from "@/sims/rng";

/** Sorted-array reference model. */
class Ref {
  a: number[] = [];
  insert(k: number) {
    const i = this.lb(k);
    if (this.a[i] === k) return false;
    this.a.splice(i, 0, k);
    return true;
  }
  delete(k: number) {
    const i = this.lb(k);
    if (this.a[i] !== k) return false;
    this.a.splice(i, 1);
    return true;
  }
  lb(k: number) {
    let lo = 0, hi = this.a.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.a[m]! < k) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
}

describe("B+ tree: basic operations", () => {
  test("rejects bad orders", () => {
    expect(() => new BPlusTree({ order: 2 })).toThrow();
    expect(() => new BPlusTree({ order: 3.5 })).toThrow();
  });

  test("insert, get, update, delete on a small tree", () => {
    const t = new BPlusTree<number, string>({ order: 3 });
    for (const k of [10, 20, 30, 40, 50, 60, 70]) expect(t.insert(k, `v${k}`)).toBe(true);
    expect(t.insert(30, "new")).toBe(false);
    expect(t.get(30)).toBe("new");
    expect(t.get(35)).toBeUndefined();
    expect(t.size).toBe(7);
    expect(t.check()).toEqual([]);
    expect(t.height).toBe(3);
    expect(t.delete(35)).toBe(false);
    for (const k of [10, 20, 30, 40, 50, 60, 70]) {
      expect(t.delete(k)).toBe(true);
      expect(t.check()).toEqual([]);
    }
    expect(t.size).toBe(0);
    expect(t.height).toBe(1);
  });

  test("string keys with a custom comparator", () => {
    const t = new BPlusTree<string, number>({ order: 4, compare: strCmp });
    const words = ["pear", "apple", "fig", "kiwi", "date", "plum", "lime", "nut", "yam", "corn"];
    words.forEach((w, i) => t.insert(w, i));
    expect(t.keys()).toEqual([...words].sort());
    expect(t.range("d", "l").map((e) => e[0])).toEqual(["date", "fig", "kiwi"]);
    expect(t.check()).toEqual([]);
  });

  test("range scan follows the leaf chain and emits one scan event per leaf", () => {
    const t = new BPlusTree<number, number>({ order: 4 });
    for (let k = 0; k < 40; k++) t.insert(k, k * 10);
    const scanned: number[] = [];
    t.listener = (e) => e.t === "scan" && scanned.push(e.id);
    const r = t.range(5, 17);
    expect(r.map((e) => e[0])).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(r[0]![1]).toBe(50);
    const leafIds = t.leaves().filter((l) => l.keys.some((k) => k >= 5 && k <= 17) || l.keys[0]! <= 17 && l.keys.at(-1)! >= 5).map((l) => l.id);
    expect(scanned.slice(0, leafIds.length)).toEqual(leafIds);
    expect(t.range(100, 200)).toEqual([]);
    expect(t.range(0, 100, 3).length).toBe(3);
  });

  test("split events propagate to a new root", () => {
    const t = new BPlusTree<number, number>({ order: 3 });
    const events: BEvent<number>[] = [];
    t.listener = (e) => events.push(e);
    t.insert(1, 1);
    t.insert(2, 2);
    expect(events.some((e) => e.t === "split")).toBe(false);
    t.insert(3, 3); // leaf [1,2,3] overflows -> split, new root
    const kinds = events.map((e) => e.t);
    expect(kinds).toContain("overflow");
    expect(kinds).toContain("split");
    expect(kinds.at(-1)).toBe("newRoot");
    expect(t.snapshot()).toMatchObject({ leaf: false, keys: [3], kids: [{ keys: [1, 2] }, { keys: [3] }] });
  });

  test("delete emits borrow, merge and collapse", () => {
    const t = new BPlusTree<number, number>({ order: 4 });
    for (let k = 1; k <= 20; k++) t.insert(k, k);
    const seen = new Set<string>();
    t.listener = (e) => seen.add(e.t);
    for (let k = 1; k <= 20; k++) {
      t.delete(k);
      expect(t.check()).toEqual([]);
    }
    expect(seen.has("borrow")).toBe(true);
    expect(seen.has("merge")).toBe(true);
    expect(seen.has("collapse")).toBe(true);
  });
});

describe("B+ tree: property tests against a sorted array", () => {
  for (const order of [3, 4, 5, 8, 16]) {
    for (const split of ["half", "rightmost"] as const) {
      test(`order ${order}, ${split} split: random insert/delete keeps invariants`, () => {
        for (let seed = 1; seed <= 6; seed++) {
          const rng = mulberry32(seed * 97 + order);
          const t = new BPlusTree<number, number>({ order, split, leafFill: 0.9, innerFill: 0.7 });
          const ref = new Ref();
          const space = 40 + Math.floor(rng() * 300);
          for (let i = 0; i < 1500; i++) {
            const k = Math.floor(rng() * space);
            // Phases: grow, then shrink, then mix.
            const p = i < 500 ? 0.8 : i < 1000 ? 0.2 : 0.5;
            if (rng() < p) expect(t.insert(k, k)).toBe(ref.insert(k));
            else expect(t.delete(k)).toBe(ref.delete(k));
            if (i % 50 === 0) expect(t.check()).toEqual([]);
          }
          expect(t.check()).toEqual([]);
          expect(t.keys()).toEqual(ref.a);
          // Lookups agree for present and absent keys.
          for (let k = -1; k <= space; k++) expect(t.get(k) !== undefined).toBe(ref.a.includes(k));
          // Range agrees.
          const lo = Math.floor(space / 4), hi = Math.floor(space / 2);
          expect(t.range(lo, hi).map((e) => e[0])).toEqual(ref.a.filter((k) => k >= lo && k <= hi));
          // Balanced: height is within the bounds that the occupancy rules allow.
          const n = t.size;
          if (n > 0 && split === "half") {
            const minH = Math.ceil(Math.log(n / (order - 1)) / Math.log(order)) + 1;
            expect(t.height).toBeGreaterThanOrEqual(Math.max(1, minH));
            const maxH = n <= 1 ? 1 : 1 + Math.floor(Math.log(n / 2 / Math.floor(order / 2)) / Math.log(Math.ceil(order / 2))) + 1;
            expect(t.height).toBeLessThanOrEqual(maxH);
          }
        }
      });
    }
  }

  test("ascending, descending and random inserts, then delete everything", () => {
    for (const ord of ["ascending", "descending", "random"] as const) {
      const t = new BPlusTree<number, number>({ order: 5 });
      const keys = keyOrder(500, ord, 3);
      keys.forEach((k) => t.insert(k, k));
      expect(t.check()).toEqual([]);
      keyOrder(500, "random", 9).forEach((k, i) => {
        t.delete(k);
        if (i % 25 === 0) expect(t.check()).toEqual([]);
      });
      expect(t.size).toBe(0);
      expect(t.check()).toEqual([]);
    }
  });

  test("randomOps helper keeps the tree valid", () => {
    const t = new BPlusTree<number, number>({ order: 6 });
    randomOps(t, 3000, 400, 0.55, 5);
    expect(t.check()).toEqual([]);
  });
});

describe("bulk loading", () => {
  test("bulk-loaded trees are valid for all orders, sizes and fills", () => {
    for (const order of [3, 4, 5, 7, 8, 32]) {
      for (const n of [0, 1, 2, 3, 7, 10, 33, 100, 257, 1000]) {
        for (const fill of [0.5, 0.7, 0.9, 1]) {
          const t = BPlusTree.bulkLoad(Array.from({ length: n }, (_, i) => [i, i] as const), { order, fill });
          expect(t.check(), `order ${order} n ${n} fill ${fill}`).toEqual([]);
          expect(t.size).toBe(n);
          // The loaded tree accepts later updates.
          for (let k = 0; k < 20; k++) t.insert(n + k * 3, 0);
          for (let k = 0; k < n; k += 3) t.delete(k);
          expect(t.check()).toEqual([]);
        }
      }
    }
  });

  test("rejects unsorted input", () => {
    expect(() => BPlusTree.bulkLoad([[2, 2], [1, 1]], { order: 4 })).toThrow();
  });

  test("steps report every node, level by level", () => {
    const steps: number[] = [];
    const t = BPlusTree.bulkLoad(Array.from({ length: 30 }, (_, i) => [i, i] as const), { order: 4, fill: 1 }, (s) => steps.push(s.level));
    expect(steps.length).toBe(t.nodeCount());
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  test("bulk load writes each node once; repeated inserts write far more (lesson 2 numbers)", () => {
    const bulk = bulkExperiment({ order: 64, n: 100_000, fill: 1 });
    const seq = fillExperiment({ order: 64, n: 100_000, insertOrder: "ascending" });
    expect(bulk.splits).toBe(0);
    expect(bulk.avgFill).toBeGreaterThan(0.999);
    // Each insert writes its leaf at least once.
    expect(seq.nodeWrites).toBeGreaterThan(100_000);
    expect(bulk.leaves).toBe(1588);
    expect(bulk.nodeWrites).toBe(1614); // 1588 leaves + 25 internal nodes + 1 root, each written once
    expect(seq.nodeWrites).toBe(109654);
    expect(seq.splits).toBe(3218);
  });
});

describe("leaf fill after inserts (lesson 2 numbers)", () => {
  const common = { order: 101, n: 200_000 };
  const random = fillExperiment({ ...common, insertOrder: "random" });
  const asc = fillExperiment({ ...common, insertOrder: "ascending" });
  const desc = fillExperiment({ ...common, insertOrder: "descending" });
  const ascRight = fillExperiment({ ...common, insertOrder: "ascending", split: "rightmost", leafFill: 1 });
  const ascPg = fillExperiment({ ...common, insertOrder: "ascending", split: "rightmost", leafFill: 0.9 });

  test("random inserts approach ln 2 = 69%", () => {
    expect(Math.log(2)).toBeCloseTo(0.693, 3);
    expect(random.avgFill).toBeGreaterThan(0.67);
    expect(random.avgFill).toBeLessThan(0.71);
    expect(Math.round(random.avgFill * 100)).toBe(69);
  });
  test("ascending and descending inserts with half splits leave half-full leaves", () => {
    expect(Math.round(asc.avgFill * 100)).toBe(51);
    expect(Math.round(desc.avgFill * 100)).toBe(50);
  });
  test("rightmost split fills leaves completely; fill 0.9 gives 90%", () => {
    expect(Math.round(ascRight.avgFill * 100)).toBe(100);
    expect(Math.round(ascPg.avgFill * 100)).toBe(90);
    expect(asc.leaves / ascRight.leaves).toBeCloseTo(2, 1);
  });
  test("histogram counts every leaf", () => {
    const h = fillHistogram(random.fills, 10);
    expect(h.reduce((a, b) => a + b, 0)).toBe(random.leaves);
    expect(h.slice(0, 4).reduce((a, b) => a + b, 0)).toBe(0); // no leaf below 40% (min = 50 of 100)
  });

  test("fill factor sweep: lower fill means more pages first, fewer splits later", () => {
    const pts = fillFactorSweep({ order: 101, n: 50_000, extra: 5_000, fills: [0.5, 0.7, 0.8, 0.9, 1] });
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.leavesBefore).toBeLessThan(pts[i - 1]!.leavesBefore);
      expect(pts[i]!.splits).toBeGreaterThanOrEqual(pts[i - 1]!.splits);
    }
    expect(pts.map((p) => p.leavesBefore)).toEqual([1000, 714, 625, 556, 500]);
    expect(pts.map((p) => p.splits)).toEqual([0, 0, 0, 155, 509]);
  });

  test("growth curve: a full tree doubles its leaves after 10% growth", () => {
    const g = (fill: number) => growthCurve({ order: 101, n: 20_000, fill, maxExtra: 20_000, steps: 10 }).map((p) => p.leaves);
    expect(g(1)).toEqual([200, 400, 400, 400, 400, 400, 400, 400, 400, 403, 513]);
    expect(g(0.9)).toEqual([223, 279, 441, 444, 444, 444, 444, 444, 444, 446, 446]);
    expect(g(0.7)).toEqual([286, 286, 286, 291, 363, 532, 569, 571, 571, 571, 571]);
  });
});

describe("sizing math (lesson 1 numbers)", () => {
  const innodb = { pageBytes: 16384, keyBytes: 8 };
  test("16 KiB pages and 8-byte keys: fanout in the hundreds", () => {
    const { fanout, leafCap } = pageCapacity(innodb);
    expect(fanout).toBe(903);
    expect(leafCap).toBe(903);
  });
  test("a billion keys fit in 4 levels, also at 69% fill", () => {
    const { fanout, leafCap } = pageCapacity(innodb);
    expect(treeHeight(1e9, leafCap, fanout)).toBe(4);
    const sizes = levelSizes(1e9, leafCap, fanout);
    expect(sizes[0]).toBe(1);
    expect(sizes[3]).toBe(1107420);
    const f69 = pageCapacity({ ...innodb, fill: 0.69 });
    expect(f69.fanout).toBe(623);
    expect(treeHeight(1e9, f69.leafCap, f69.fanout)).toBe(4);
  });
  test("top levels are small: the upper three levels of the billion-key tree", () => {
    const { fanout, leafCap } = pageCapacity(innodb);
    const sizes = levelSizes(1e9, leafCap, fanout);
    expect(sizes).toEqual([1, 2, 1227, 1107420]);
    // 1 + 2 + 1227 pages = 1230 pages of 16 KiB = about 19 MiB
    expect(((1 + 2 + 1227) * 16384) / 2 ** 20).toBeCloseTo(19.2, 1);
    expect(cachedLevels(1e9, innodb, 64 * 2 ** 20)).toBe(3);
    expect(lookupIOs(1e9, innodb, 64 * 2 ** 20)).toBe(1);
    expect(lookupIOs(1e9, innodb, 0)).toBe(4);
  });
  test("4 KiB pages: more levels", () => {
    const c = pageCapacity({ pageBytes: 4096, keyBytes: 8 });
    expect(c.fanout).toBe(220);
    expect(treeHeight(1e9, c.leafCap, c.fanout)).toBe(4);
    const c2 = pageCapacity({ pageBytes: 4096, keyBytes: 64 });
    expect(c2.fanout).toBe(53);
    expect(treeHeight(1e9, c2.leafCap, c2.fanout)).toBe(6);
  });
  test("binary search tree vs B+ tree, in cache lines", () => {
    expect(bstDepth(1e9)).toBe(30);
    expect(binarySearchLines(3, 8)).toBe(1); // 3 keys fit in one line
    const small = btreeLookupLines(1e9, 64);
    const page = btreeLookupLines(1e9, 4096);
    expect(small.fanout).toBe(4);
    expect(small.levels).toBe(15);
    expect(small.linesPerNode).toBe(1);
    expect(Math.round(small.lines)).toBe(15);
    const mid = btreeLookupLines(1e9, 256);
    expect(mid.fanout).toBe(16);
    expect(mid.levels).toBe(8);
    expect(Math.round(mid.lines)).toBe(20);
    expect(page.fanout).toBe(256);
    expect(page.levels).toBe(4);
    expect(Math.round(page.linesPerNode)).toBe(6);
    expect(Math.round(page.lines)).toBe(24);
  });
});

describe("3D view and key size (lesson 1 numbers)", () => {
  test("10 M keys: binary tree 24 levels, fanout-256 B+ tree 3 levels, 99.6% leaves", () => {
    expect(bstDepth(1e7)).toBe(24);
    expect(levelSizes(1e7, 256, 256)).toEqual([1, 153, 39063]);
    expect((leafShare(1e7, 256, 256) * 100).toFixed(1)).toBe("99.6");
    expect(levelSizes(1e7, 16, 16).length).toBeLessThan(24);
  });
  test("with 32-byte keys, no node size beats the binary tree's 30 lines", () => {
    for (const s of [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384]) expect(btreeLookupLines(1e9, s, 32).lines).toBeGreaterThanOrEqual(30);
    expect(btreeLookupLines(1e9, 64, 32).lines).toBe(30);
  });
});

describe("key compression", () => {
  test("suffix truncation keeps the shortest separator", () => {
    expect(shortestSeparator("database", "datum")).toBe("datu");
    expect(shortestSeparator("smith, alice", "smyth, bob")).toBe("smy");
    expect(shortestSeparator("abc", "abd")).toBe("abd");
    expect(() => shortestSeparator("b", "a")).toThrow();
  });
  test("prefix compression", () => {
    expect(commonPrefix(["user:1001", "user:1002", "user:1093"])).toBe("user:10");
    expect(commonPrefix([])).toBe("");
  });
});

describe("lesson 1 demo walkthrough (order 4, LAB_KEYS)", () => {
  const mk = (order = 4) => {
    const t = new BPlusTree<number, number>({ order });
    LAB_KEYS.forEach((k) => t.insert(k, k));
    t.resetStats();
    return t;
  };
  const opEvents = (t: BPlusTree<number, number>, f: () => void) => {
    const ev: string[] = [];
    t.listener = (e) => e.t !== "visit" && ev.push(e.t + ("side" in e ? `:${e.side}` : ""));
    f();
    t.listener = null;
    return ev;
  };
  test("find reads one node per level", () => {
    const t = mk();
    expect(t.height).toBe(3);
    t.get(65);
    expect(t.stats.reads).toBe(3);
  });
  test("insert 40 splits the leaf, its parent and the root; the tree grows at the top", () => {
    const t = mk();
    expect(opEvents(t, () => t.insert(40, 40))).toEqual(["insert", "overflow", "split", "overflow", "split", "overflow", "split", "newRoot"]);
    expect(t.height).toBe(4);
    expect(t.check()).toEqual([]);
  });
  test("delete 50 borrows, delete 60 merges, delete 33 merges and then borrows one level up", () => {
    let t = mk();
    expect(opEvents(t, () => t.delete(50))).toEqual(["remove", "underflow", "borrow:left"]);
    t = mk();
    expect(opEvents(t, () => t.delete(60))).toEqual(["remove", "underflow", "merge"]);
    t = mk();
    expect(opEvents(t, () => t.delete(33))).toEqual(["remove", "underflow", "merge", "underflow", "borrow:left"]);
  });
  test("scan 40 to 60 descends once and then walks the leaf chain", () => {
    const t = mk();
    expect(t.range(40, 60).map((e) => e[0])).toEqual([45, 47, 50, 55, 60]);
    expect(t.stats.reads).toBe(5);
  });
  test("the same keys at other orders", () => {
    expect([3, 4, 5, 6, 7, 8].map((o) => mk(o).height)).toEqual([4, 3, 3, 2, 2, 2]);
  });
});

describe("lesson 2 demo numbers", () => {
  test("bulk-load stepper defaults: 30 keys, order 4, fill 100%", () => {
    const t = BPlusTree.bulkLoad(Array.from({ length: 30 }, (_, i) => [i + 1, i + 1] as const), { order: 4, fill: 1 });
    expect(t.stats.writes).toBe(14);
    expect(t.leaves().length).toBe(10);
    const asc = fillExperiment({ order: 4, n: 30, insertOrder: "ascending" });
    expect([asc.nodeWrites, asc.splits]).toEqual([87, 19]);
    const odd = BPlusTree.bulkLoad(Array.from({ length: 31 }, (_, i) => [i + 1, i + 1] as const), { order: 4, fill: 1 });
    expect(odd.leaves().slice(-2).map((l) => l.keys.length)).toEqual([2, 2]);
    const rnd = fillExperiment({ order: 4, n: 30, insertOrder: "random" });
    expect([rnd.nodeWrites, rnd.splits]).toEqual([78, 16]);
  });
  test("bulk load of 100,000 keys does about 68 times fewer node writes", () => {
    const bulk = bulkExperiment({ order: 64, n: 100_000, fill: 1 });
    const seq = fillExperiment({ order: 64, n: 100_000, insertOrder: "ascending" });
    expect(Math.round(seq.nodeWrites / bulk.nodeWrites)).toBe(68);
  });
  test("fill-factor demo curves (10,000 keys, 100 per leaf)", () => {
    const g = (fill: number) => growthCurve({ order: 101, n: 10_000, fill, maxExtra: 10_000, steps: 20 }).map((p) => p.leaves);
    expect(g(1).slice(0, 4)).toEqual([100, 198, 200, 200]);
    expect(g(0.9).slice(0, 5)).toEqual([111, 112, 141, 207, 220]);
    expect(g(0.7).slice(0, 8)).toEqual([143, 143, 143, 143, 143, 143, 144, 152]);
    expect(g(0.5).every((x) => x === 200)).toBe(true);
  });
});
