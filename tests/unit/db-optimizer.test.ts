/**
 * Optimizer module (databases/optimizer): behaviour of the reference models, and every number that
 * the four lessons quote. Keep the numbers in sync with src/content/lessons/databases/optimizer/*.mdx.
 */
import { describe, expect, test } from "vitest";
import {
  PG_DEFAULTS, TENK1, TENK1_UNIQUE1, EVENTS, EVENTS_TS, seqScanCost, indexScanCost, bitmapScanCost, accessPaths, planFlips, limitedCost,
  indexPagesFetched, joinMethods, joinCrossover, heapPages, btreeShape, CUSTOMERS, ORDERS, sortCost, mergeOrder, hashBatches,
  skewedColumn, valueCounts, trueRange, buildStats, estimateRange, histErrors, dataQueries, qError, equiDepth, equiWidth, sampleRows, mcvList,
  duj1, HyperLogLog, hllStdError, zipfColumn, correlatedReport, addresses, extStats,
  qErrorCurve, worstCaseQ, errorSamples,
  makeGraph, SHAPES, dp, dpBushy, dpLeftDeep, dpWorst, greedy, enumerateTrees, enumerateLeftDeep, leftDeepCount, bushyCount, catalan, factorial,
  ccpCount, countCcp, compareStrategies, bushyExample, isLeftDeep, planString, GraphInfo, popcount,
  shopScenario, shopJoinChoice, exercises, ex3Costs, renderExplain, renderMysqlTree, walkPlan, executionMs, EX3,
  type Shape,
} from "@/sims/db/optimizer";

const f2 = (x: number) => x.toFixed(2);
const r = (x: number, d = 3) => Number(x.toPrecision(d));

// =====================================================================================
// Lesson 1: Cost models
// =====================================================================================

describe("cost models", () => {
  test("PostgreSQL default cost constants", () => {
    const p = PG_DEFAULTS;
    expect([p.seqPageCost, p.randomPageCost, p.cpuTupleCost, p.cpuIndexTupleCost, p.cpuOperatorCost]).toEqual([1, 4, 0.01, 0.005, 0.0025]);
    expect(p.effectiveCacheSize).toBe(524288); // 4 GB of 8 KiB pages
  });

  test("tenk1 reproduces the PostgreSQL docs: 445.00, 470.00, 5.06..224.98 over 0.00..5.04, 0.29..8.30", () => {
    expect([TENK1.pages, TENK1.rows]).toEqual([345, 10000]);
    expect(f2(seqScanCost(TENK1, 0, 1).total)).toBe("445.00");
    const s = seqScanCost(TENK1, 1, 0.7);
    expect([f2(s.total), s.rows]).toEqual(["470.00", 7000]);
    const b = bitmapScanCost(TENK1, TENK1_UNIQUE1, 0.01);
    expect([f2(b.startup), f2(b.total), b.rows]).toEqual(["5.06", "224.98", 100]);
    expect([f2(b.child!.startup), f2(b.child!.total)]).toEqual(["0.00", "5.04"]);
    expect(b.heapPages).toBe(88);
    const i = indexScanCost(TENK1, TENK1_UNIQUE1, 1 / 10000);
    expect([f2(i.startup), f2(i.total), i.rows]).toEqual(["0.29", "8.30", 1]);
  });

  test("unique1 < 100: index scan 358.04, bitmap 224.98, seq 470.00; bitmap wins", () => {
    const a = accessPaths(TENK1, TENK1_UNIQUE1, 0.01);
    expect(a.best).toBe("bitmap");
    expect([f2(a.paths.index.total), f2(a.paths.bitmap.total), f2(a.paths.seq.total)]).toEqual(["358.04", "224.98", "470.00"]);
  });

  test("plan flips on tenk1: bitmap → seq at 37.9% (random_page_cost 4) and 52.9% (1.1); index → bitmap past one row", () => {
    const f = planFlips(TENK1, TENK1_UNIQUE1);
    expect(f.map((x) => x.to)).toEqual(["bitmap", "seq"]);
    expect(f[0]!.sel * TENK1.rows).toBeLessThan(2);
    expect(r(f[1]!.sel * 100)).toBe(37.9);
    const g = planFlips(TENK1, TENK1_UNIQUE1, { ...PG_DEFAULTS, randomPageCost: 1.1 });
    expect(r(g[1]!.sel * 100)).toBe(52.9);
  });

  test("correlation 1: the index scan wins up to 72.8% of the table", () => {
    const f = planFlips(TENK1, { ...TENK1_UNIQUE1, correlation: 1 });
    expect(f.map((x) => `${x.from}>${x.to}`)).toEqual(["index>seq"]);
    expect(r(f[0]!.sel * 100)).toBe(72.8);
  });

  test("tenk1: 29 rows per page; the bitmap pays 2.48 per page at 1%; its startup at 70% is 138.5", () => {
    expect(Math.floor((8192 - 24) / (24 + 248 + 4))).toBe(29);
    expect(bitmapScanCost(TENK1, TENK1_UNIQUE1, 0.01).terms[2]!.expr).toContain("= 88 × 2.48");
    expect(r(bitmapScanCost(TENK1, TENK1_UNIQUE1, 0.7).startup, 4)).toBe(138.5);
  });

  test("LIMIT 1 at 70%: seq 0.07, index 0.51, bitmap 138.60", () => {
    const a = accessPaths(TENK1, TENK1_UNIQUE1, 0.7, PG_DEFAULTS, 1);
    expect(a.best).toBe("seq");
    expect([limitedCost(a.paths.seq, 1), limitedCost(a.paths.index, 1), limitedCost(a.paths.bitmap, 1)].map(f2)).toEqual(["0.07", "0.51", "138.60"]);
  });

  test("Mackert–Lohman: never more pages than the table while it fits in the cache; re-reads when it does not", () => {
    expect(indexPagesFetched(100, 345, 30, PG_DEFAULTS)).toBe(88);
    expect(indexPagesFetched(1e6, 345, 30, PG_DEFAULTS)).toBe(345);
    const small = { ...PG_DEFAULTS, effectiveCacheSize: 1000 };
    expect(indexPagesFetched(1e6, 100000, 0, small)).toBeGreaterThan(900000);
  });

  test("events (100 M rows): a 1% index scan costs 3.99 M, 3.06 M, 2.94 M at effective_cache_size 128 MB, 4 GB, 64 GB", () => {
    expect(EVENTS.pages).toBe(1333334);
    const at = (pages: number) => r(indexScanCost(EVENTS, EVENTS_TS, 0.01, {}, { ...PG_DEFAULTS, effectiveCacheSize: pages }).total);
    expect([at(16384), at(524288), at(8388608)]).toEqual([3990000, 3060000, 2940000]);
    expect(r(bitmapScanCost(EVENTS, EVENTS_TS, 0.01).total)).toBe(1330000);
  });

  test("join: index nested loop beats hash join below 693 outer rows; 16,674 with random_page_cost 1.1", () => {
    expect([CUSTOMERS.pages, ORDERS.pages]).toEqual([1137, 9346]);
    expect(Math.round(joinCrossover())).toBe(693);
    expect(Math.round(joinCrossover({ ...PG_DEFAULTS, randomPageCost: 1.1 }))).toBe(16674);
    const j = joinMethods(100);
    expect(j.best).toBe("indexnl");
    expect([Math.round(j.costs.indexnl.total), Math.round(j.costs.hash.total), Math.round(j.costs.nl.total)]).toEqual([6653, 25494, 3186987]);
    expect(joinMethods(10000).best).toBe("hash");
  });

  test("helpers: heap pages, B-tree shape, merge order, hash batches", () => {
    expect(heapPages(10000, 244)).toBe(345); // the real tenk1: 29 tuples of 244 bytes per page
    expect(btreeShape(10000, 4).pages).toBe(30);
    expect(mergeOrder(4 * 2 ** 20)).toBe(15);
    expect(hashBatches(1e6, 48).batches).toBeGreaterThan(1);
    expect(hashBatches(1e5, 48).batches).toBe(1);
  });
});

// =====================================================================================
// Lesson 2: Cardinality estimation
// =====================================================================================

describe("cardinality estimation", () => {
  const col = skewedColumn();
  const counts = valueCounts(col);
  const qs = dataQueries(col);

  test("the column: 100,000 rows, spikes 0 → 5,984 and 99 → 8,212 rows", () => {
    expect(col.length).toBe(100000);
    expect([counts[0], counts[99]]).toEqual([5984, 8212]);
    expect(trueRange(counts, 0, 49)).toBeGreaterThan(50000); // most rows lie in the first equi-width bucket
    expect(100000 / 20).toBe(5000);
  });

  test("q-error is symmetric and at least 1", () => {
    expect(qError(10, 100)).toBe(10);
    expect(qError(100, 10)).toBe(10);
    expect(qError(0, 0)).toBe(1);
  });

  test("histograms: equi-depth buckets hold equal counts; equi-width buckets have equal widths", () => {
    const d = equiDepth(sampleRows(col, 30000), 20, col.length);
    expect(d.bounds).toHaveLength(21);
    expect(d.frac.every((x) => x === 0.05)).toBe(true);
    const w = equiWidth(col, 20, col.length);
    expect(w.bounds[1]! - w.bounds[0]!).toBe(50);
    // Full range: both estimate the whole table.
    expect(Math.round(estimateRange(d, 0, 999))).toBe(100000);
    expect(Math.round(estimateRange(w, 0, 999))).toBe(100000);
  });

  test("20 buckets, 30,000-row sample: median q-error 1.63 (width) vs 1.07 (depth); with MCVs 1.14 vs 1.02", () => {
    const e = (kind: "width" | "depth", mcv: boolean) => histErrors(buildStats(col, { kind, buckets: 20, mcv, sample: 30000 }), counts, qs);
    expect(r(e("width", false).median)).toBe(1.63);
    expect(r(e("depth", false).median)).toBe(1.07);
    expect(r(e("width", true).median)).toBe(1.14);
    expect(r(e("depth", true).median)).toBe(1.02);
    expect(Math.round(e("depth", false).max)).toBe(547);
  });

  test("examples at 20 buckets: [500, 999] true 257, width 273, depth 3,601; value 0 true 5,984, depth + MCV 5,977", () => {
    const est = (kind: "width" | "depth", mcv: boolean, lo: number, hi: number) => Math.round(estimateRange(buildStats(col, { kind, buckets: 20, mcv, sample: 30000 }), lo, hi));
    expect(trueRange(counts, 500, 999)).toBe(257);
    expect([est("width", false, 500, 999), est("depth", false, 500, 999)]).toEqual([273, 3601]);
    expect([est("width", false, 0, 0), est("depth", false, 0, 0), est("depth", true, 0, 0)]).toEqual([1311, 6667, 5977]);
  });

  test("MCV list keeps the spikes", () => {
    const m = mcvList(sampleRows(col, 30000), 20).map((x) => x.value);
    expect(m).toEqual(expect.arrayContaining([0, 99, 199, 499]));
  });

  test("city/zip, 20 cities × 5 zips: independence 50 vs true 1,000; dependencies 1,000; a zip of another city: deps 1,000, mcv 0", () => {
    const rep = correlatedReport({ rows: 100000, cities: 20, zipsPerCity: 5, noise: 0 });
    expect(rep.match.truth).toBe(1000);
    expect(Math.round(rep.match.est.indep)).toBe(50);
    expect(Math.round(rep.match.est.deps)).toBe(1000);
    expect(Math.round(rep.match.est.mcv)).toBe(1000);
    expect(rep.mismatch!.truth).toBe(0);
    expect(Math.round(rep.mismatch!.est.deps)).toBe(1000);
    expect(Math.round(Math.max(0, rep.mismatch!.est.mcv))).toBe(0);
    expect(rep.groups).toEqual({ truth: 100, indep: 2000, ndistinct: 100 });
    expect(rep.degree).toBe(1);
  });

  test("50 zips per city: the 100-item MCV list covers 10% of rows, so a pair outside it falls back to 5 (true 100)", () => {
    const rep = correlatedReport({ rows: 100000, cities: 20, zipsPerCity: 50, noise: 0 });
    expect(r(rep.mcvTotal)).toBe(0.1);
    expect([rep.match.truth, Math.round(rep.match.est.mcv), Math.round(rep.match.est.deps)]).toEqual([100, 5, 100]);
  });

  test("10% noise: the dependency degree falls to 0", () => {
    const t = addresses({ rows: 100000, cities: 20, zipsPerCity: 5, noise: 0.1 });
    expect(extStats(t).degree).toBe(0);
  });

  test("n_distinct: Duj1 on a 30,000-row sample says 15,658 for 120,613; HyperLogLog (4,096 registers, 3 KiB) says 120,945", () => {
    const z = zipfColumn(1_000_000, 200_000);
    expect(new Set(z).size).toBe(120613);
    expect(Math.round(duj1(sampleRows(z, 30000), z.length))).toBe(15658);
    const h = new HyperLogLog(12);
    for (const v of z) h.add(v);
    expect(Math.round(h.estimate())).toBe(120945);
    expect(h.bytes).toBe(3072);
    expect(r(h.estimate() / 120613 - 1, 1)).toBe(0.003);
    expect(r(hllStdError(4096))).toBe(0.0163);
  });

  test("HyperLogLog error stays near 1.04/sqrt(m) on unique keys", () => {
    for (const p of [10, 14]) {
      const h = new HyperLogLog(p);
      for (let i = 0; i < 200000; i++) h.add(i);
      expect(Math.abs(h.estimate() / 200000 - 1)).toBeLessThan(4 * hllStdError(1 << p));
    }
  });

  test("q-error through joins (sigma 0.5, bias -0.2): median 1.4 → 9.3 → 64 at 0, 5, 10 joins; p90 1,273 at 10; 97% under-estimates", () => {
    const c = qErrorCurve(10, { sigma: 0.5, bias: -0.2 });
    expect([r(c[0]!.median, 2), r(c[5]!.median, 2), r(c[10]!.median, 2)]).toEqual([1.4, 9.3, 64]);
    expect(Math.round(c[10]!.p90)).toBe(1273);
    expect(Math.round(c[10]!.under * 100)).toBe(97);
    expect(worstCaseQ(2, 3)).toBe(128);
    expect(errorSamples(2, { sigma: 0.5, bias: 0 })).toHaveLength(2000);
  });
});

// =====================================================================================
// Lesson 3: Join ordering
// =====================================================================================

describe("join ordering", () => {
  test("Catalan numbers and factorials", () => {
    expect([0, 1, 2, 3, 4, 5, 9, 11].map(catalan)).toEqual([1, 1, 2, 5, 14, 42, 4862, 58786]);
    expect(factorial(10)).toBe(3628800);
  });

  test("search space: n = 4: 24 / 120; 6: 720 / 30,240; 10: 3,628,800 / 17,643,225,600; 12: 479,001,600 left-deep", () => {
    expect([leftDeepCount(4), bushyCount(4)]).toEqual([24, 120]);
    expect([leftDeepCount(6), bushyCount(6)]).toEqual([720, 30240]);
    expect([leftDeepCount(10), bushyCount(10)]).toEqual([3628800, 17643225600]);
    expect(leftDeepCount(12)).toBe(479001600);
    expect(r(bushyCount(12), 2)).toBe(2.8e13);
    expect(r(bushyCount(10))).toBe(1.76e10);
    expect(2 ** 10).toBe(1024);
    expect(2 ** 12).toBe(4096);
  });

  test("enumeration matches the formulas: ordered bushy trees = unordered × 2^(n−1), left-deep = n!", () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const g = makeGraph("clique", n, 1);
      expect(enumerateTrees(g).length * 2 ** (n - 1)).toBe(bushyCount(n));
      expect(enumerateLeftDeep(g).length).toBe(leftDeepCount(n));
    }
  });

  test("csg-cmp pairs: formulas match brute force; at n = 10, chain 165, star 2,304, clique 28,501", () => {
    for (const n of [2, 3, 4, 5, 6, 7]) {
      expect(countCcp(makeGraph("chain", n, 1))).toBe(ccpCount("chain", n));
      expect(countCcp(makeGraph("star", n, 1))).toBe(ccpCount("star", n));
      expect(countCcp(makeGraph("clique", n, 1))).toBe(ccpCount("clique", n));
    }
    expect([ccpCount("chain", 10), ccpCount("star", 10), ccpCount("clique", 10)]).toEqual([165, 2304, 28501]);
    // The DP without cross products considers exactly the csg-cmp pairs.
    const g = makeGraph("clique", 7, 1);
    expect(dpBushy(g).pairsConsidered).toBe(966);
    expect(enumerateTrees(g).length).toBe(10395);
  });

  test("DP finds the true optimum (and the worst plan) against brute force, on every shape, n = 3..6, 8 seeds", () => {
    for (const shape of SHAPES as Shape[]) for (let n = 3; n <= 6; n++) for (let seed = 1; seed <= 8; seed++) {
      const g = makeGraph(shape, n, seed);
      for (const cp of [false, true]) {
        const all = enumerateTrees(g, cp);
        const min = Math.min(...all.map((t) => t.cost)), max = Math.max(...all.map((t) => t.cost));
        expect(dpBushy(g, cp).best.cost).toBeCloseTo(min, 6);
        expect(dpWorst(g, cp).best.cost).toBeCloseTo(max, 6);
        const ld = enumerateLeftDeep(g, cp);
        expect(dpLeftDeep(g, cp).best.cost).toBeCloseTo(Math.min(...ld.map((t) => t.cost)), 6);
        expect(isLeftDeep(dpLeftDeep(g, cp).best)).toBe(true);
      }
      expect(greedy(g).cost).toBeGreaterThanOrEqual(dpBushy(g).best.cost - 1e-9);
    }
  });

  test("cross products: the DP without them only builds connected subsets", () => {
    const g = makeGraph("chain", 6, 2), gi = new GraphInfo(g);
    for (const [m] of dpBushy(g).table) expect(gi.connected(m)).toBe(true);
    expect([...dp(g, { crossProducts: true }).table.keys()].length).toBe(2 ** 6 - 1);
    expect(popcount(0b101101)).toBe(4);
  });

  test("bushy example: C_out 21 vs best left-deep 1,011 (48.1×); greedy finds the bushy plan", () => {
    const g = bushyExample();
    const s = compareStrategies(g);
    expect(s.bushy.cost).toBe(21);
    expect(s.leftdeep.cost).toBe(1011);
    expect(r(s.leftdeep.cost / s.bushy.cost)).toBe(48.1);
    expect(s.greedy.cost).toBe(21);
    expect(isLeftDeep(s.bushy)).toBe(false);
  });

  test("demo default (chain of 6, seed 1): random search 5.58×, worst plan 142×; seed 15: greedy 2.35×", () => {
    const g = makeGraph("chain", 6, 1);
    const s = compareStrategies(g);
    expect(r(s.leftdeep.cost / s.bushy.cost)).toBe(1);
    expect(r(s.random.cost / s.bushy.cost)).toBe(5.58);
    expect(r(s.worst.cost / s.bushy.cost)).toBe(142);
    const s15 = compareStrategies(makeGraph("chain", 6, 15));
    expect(r(s15.greedy.cost / s15.bushy.cost)).toBe(2.35);
    expect(planString(g, s.bushy)).toMatch(/⋈/);
  });

  test("worst/best reaches millions on some 7-table graphs; a 7-clique DP fills 120 joined subsets", () => {
    let worst = 0;
    for (const shape of SHAPES as Shape[]) for (let seed = 1; seed <= 12; seed++) {
      const s = compareStrategies(makeGraph(shape, 7, seed));
      worst = Math.max(worst, s.worst.cost / s.bushy.cost);
    }
    expect(worst).toBeGreaterThan(1e6);
    expect(dpBushy(makeGraph("clique", 7, 1)).trace.length).toBe(120);
  });

  test("left-deep is optimal on stars (without cross products every plan is left-deep)", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const g = makeGraph("star", 6, seed);
      for (const t of enumerateTrees(g, false)) expect(isLeftDeep(t)).toBe(true);
    }
  });
});

// =====================================================================================
// Lesson 4: Reading query plans
// =====================================================================================

describe("reading query plans", () => {
  test("text format: indentation and fields", () => {
    const sc = shopScenario();
    const lines = renderExplain(sc.root, { analyze: true, buffers: true }).map((l) => l.text);
    expect(lines[0]).toMatch(/^Limit {2}\(cost=\d+\.\d\d\.\.\d+\.\d\d rows=10 width=\d+\) \(actual time=[\d.]+\.\.[\d.]+ rows=10 loops=1\)$/);
    expect(lines[1]).toMatch(/^ {2}Buffers: shared hit=\d+/);
    expect(lines[2]).toMatch(/^ {2}-> {2}Sort/);
    expect(lines[3]).toMatch(/^ {8}Sort Key:/);
    expect(lines.at(-1)).toMatch(/^Execution Time: [\d.]+ ms$/);
    const plain = renderExplain(sc.root).map((l) => l.text);
    expect(plain.some((l) => l.includes("actual"))).toBe(false);
    expect(renderMysqlTree(sc.root)[0]!.text).toBe("-> Limit: 10 row(s) (rows=10)");
  });

  test("buffers add up: each node's totals include its children", () => {
    for (const sc of [shopScenario(), ...exercises()]) walkPlan(sc.root, (n) => {
      const ch = n.children.reduce((a, c) => a + c.buf.hit + c.buf.read, 0);
      expect(n.buf.hit + n.buf.read).toBeGreaterThanOrEqual(ch);
    });
  });

  test("the reader plan: the model hashes the 42,466 filtered orders, not the 100,000 customers", () => {
    const c = shopJoinChoice();
    expect(c.hashOrders).toBeLessThan(c.hashCustomers);
    expect(shopScenario().path).toBe("index");
    let hj = 0;
    walkPlan(shopScenario().root, (n) => { if (n.op === "Hash Join") hj = n.est.rows; });
    expect(hj).toBe(42466);
  });

  test("exercise 1: Seq Scan 21,846.00 reads 9,346 pages and removes 999,988 rows; the index scan costs 44.60", () => {
    const e = exercises().find((x) => x.id === "lookup")!;
    expect(f2(e.root.est.total)).toBe("21846.00");
    expect(e.root.buf.hit + e.root.buf.read).toBe(9346);
    expect(e.root.props.find((p) => p.key === "Rows Removed by Filter")!.value).toBe("999988");
    expect(f2(e.fix.root.est.total)).toBe("44.60");
  });

  test("exercise 2: external merge, Disk: 31250kB; quicksort with work_mem 256MB, about 2× faster", () => {
    const e = exercises().find((x) => x.id === "export")!;
    expect(e.root.props.find((p) => p.key === "Sort Method")!.value).toBe("external merge  Disk: 31250kB");
    expect(e.fix.root.props.find((p) => p.key === "Sort Method")!.value).toMatch(/^quicksort/);
    expect(r(executionMs(e.root) / executionMs(e.fix.root), 2)).toBe(2.1);
  });

  test("exercise 3: estimate 80 vs 8,000; nested loop cheaper at 80, hash join cheaper at 8,000; 6.3 s vs 2.2 s", () => {
    const c = ex3Costs();
    expect([c.estIndep, c.trueRows]).toEqual([80, 8000]);
    expect(EX3.pCity * 1e6).toBe(8000);
    expect(c.atEst.nl).toBeLessThan(c.atEst.hj);
    expect(c.atTrue.hj).toBeLessThan(c.atTrue.nl);
    expect([r(c.msNl / 1000, 2), r(c.msHj / 1000, 2)]).toEqual([6.3, 2.2]);
  });

  test("exercise 4: 100 million pairs, 10.5 s; the UNION ALL of two hash joins takes 7.1 ms", () => {
    const e = exercises().find((x) => x.id === "payments")!;
    expect(e.root.props.find((p) => p.key === "Rows Removed by Join Filter")!.value).toBe(String(100_000_000 - 5040));
    expect(r(executionMs(e.root) / 1000)).toBe(10.5);
    expect(r(executionMs(e.fix.root), 2)).toBe(7.1);
  });

  test("quoted plan lines: the reader's Hash Join, and the Auckland plan's inner index scan (6.1 s over 8,000 loops)", () => {
    const lines = renderExplain(shopScenario().root, { analyze: true, buffers: true }).map((l) => l.text.trim());
    expect(lines).toContain("->  Hash Join  (cost=3606.97..6543.63 rows=42466 width=13) (actual time=9.524..25.182 rows=44164 loops=1)");
    const ex = exercises().find((x) => x.id === "auckland")!;
    const t = renderExplain(ex.root, { analyze: true, buffers: true }).map((l) => l.text.trim());
    expect(t).toContain("->  Index Scan using events_user_id_idx on events e  (cost=0.43..44.45 rows=10 width=40) (actual time=0.064..0.763 rows=10 loops=8000)");
    expect(t).toContain("Buffers: shared hit=5682 read=5682");
    expect(r(0.763 * 8000 / 1000, 2)).toBe(6.1);
    expect(0.6 * 8000).toBe(4800);
    expect(10 * 8000).toBe(80000);
  });

  test("reader: the build side switches to customers at 74 days; the seq scan takes over at 397 days", () => {
    let build = 0, seq = 0;
    for (let d = 1; d <= 730; d++) {
      const s = shopScenario(PG_DEFAULTS, d);
      if (!build && !s.hashOrders) build = d;
      if (!seq && s.path === "seq") seq = d;
    }
    expect([build, seq]).toEqual([74, 397]);
  });

  test("each exercise has a distinct cause", () => {
    expect(new Set(exercises().map((e) => e.cause)).size).toBe(4);
  });
});

describe("sort cost", () => {
  test("in-memory sizes pick quicksort; bounded sorts use top-N heapsort", () => {
    expect(sortCost({ startup: 0, total: 0, rows: 1000, width: 20 }).method).toBe("quicksort");
    expect(sortCost({ startup: 0, total: 0, rows: 1e6, width: 20 }, PG_DEFAULTS, 10).method).toBe("top-N heapsort");
    expect(sortCost({ startup: 0, total: 0, rows: 1e6, width: 20 }).method).toBe("external merge");
  });
});
