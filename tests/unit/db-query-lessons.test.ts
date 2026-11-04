/** Every number that the query-processing lessons quote, computed by src/sims/db/query. */
import { describe, expect, test } from "vitest";
import {
  SAMPLE_DB, scaledDb, cmp, or, evalPlan, planWork, rewriteSteps, REWRITE_QUERY, notInVsExcept, scan, select, natural, join, group,
  Ctx, Scan, Filter, Project, HashJoin, Sort, Limit, HashAgg, runAll, callCounts, type Op, type Db,
  paged, nestedLoopJoin, blockNlj, indexNlj, sortMergeJoin, hashJoin, graceHashJoin, hybridHashJoin, hybridPlan, joinCost, CMU_EXAMPLE, uniformKeys, zipfKeys, sortIO,
  externalSort, sortPasses, sortPassesWithRuns, twoPassBuffer, replacementSelection, sortInput, hashAggregate, sortAggIO, hashAggIO, topN, mergeSortComparisons, loadSortRuns,
  vectorCost, bestVectorSize, fitsIn, VEC_MODEL, selectionSteps, branchSim, BRANCH_MODEL, makeTable, runVectorized, runTupleAtATime,
  generate, scanLoops, CG_PLANS, breakEven, engineTime, NS_PER_ROW, PG_JIT,
} from "@/sims/db/query";

const GiB = 2 ** 30, MiB = 2 ** 20, TiB = 2 ** 40;

describe("relational-algebra", () => {
  const db = SAMPLE_DB;
  const rows = (p: Parameters<typeof evalPlan>[0]) => evalPlan(p, db).result.rows;
  test("sample tables: 8 employees, 4 departments, 5 projects", () => {
    expect([db.emp!.rows.length, db.dept!.rows.length, db.proj!.rows.length]).toEqual([8, 4, 5]);
  });
  test("natural join 2 rows (Ada, Gus); equi-join on did 7 rows", () => {
    expect(rows(natural(scan("emp"), scan("dept"))).map((r) => r[1])).toEqual(["Ada", "Gus"]);
    expect(rows(join(cmp("emp.did", "=", "dept.did"), scan("emp"), scan("dept"))).length).toBe(7);
  });
  test("salary > 55 keeps 4; the tautology keeps 7 of 8; did = 10 keeps 3 and did <> 10 keeps 4", () => {
    expect(rows(select(cmp("salary", ">", 55), scan("emp"))).length).toBe(4);
    expect(rows(select(or(cmp("salary", ">", 55), cmp("salary", "<=", 55)), scan("emp"))).length).toBe(7);
    expect(rows(select(cmp("did", "=", 10), scan("emp"))).length).toBe(3);
    expect(rows(select(cmp("did", "<>", 10), scan("emp"))).length).toBe(4);
  });
  test("NOT IN returns 0 rows; NOT EXISTS and EXCEPT return department 40", () => {
    expect(notInVsExcept(db)).toEqual({ except: [40], notIn: [], notExists: [40] });
  });
  test("COUNT(*) adds up to 8, COUNT(salary) to 7; the NULL department is its own group", () => {
    const g = rows(group(["did"], [{ fn: "count" }, { fn: "count", col: "salary" }], scan("emp")));
    expect(g.reduce((a, r) => a + (r[1] as number), 0)).toBe(8);
    expect(g.reduce((a, r) => a + (r[2] as number), 0)).toBe(7);
    expect(g.find((r) => r[0] === null)).toEqual([null, 1, 1]);
  });
  const work = (n: number) => {
    const sdb = scaledDb(n);
    return rewriteSteps(REWRITE_QUERY, sdb).map((s) => { const r = evalPlan(s.plan, sdb); return { rule: s.rule, rows: r.result.rows.length, ...planWork(s.plan, r) }; });
  };
  test("100 employees: product of 24,000 rows; work 24,894 → 40,494 → 743 → 138 → 117 → 117; result 94 rows (0.47%)", () => {
    const w = work(100);
    expect(100 * 8 * 30).toBe(24000);
    expect(w.map((x) => x.tuples)).toEqual([24894, 40494, 743, 138, 117, 117]);
    expect(w.every((x) => x.rows === 94)).toBe(true);
    expect(((100 * 117) / 24894).toFixed(2)).toBe("0.47");
    expect(w[5]!.values).toBeLessThan(w[4]!.values);
  });
  test("at 50 employees, the reassociated order is better (87 < 98 rows)", () => {
    const w = work(50);
    expect([w[3]!.tuples, w[4]!.tuples]).toEqual([98, 87]);
  });
});

describe("volcano-iterator-model", () => {
  const db = SAMPLE_DB;
  const flow = (kind: "filter" | "join" | "sort") => {
    const ctx = new Ctx();
    const sc = (t: string) => new Scan(ctx, t, db[t]!.rows, db[t]!.cols);
    const emp = () => new Filter(ctx, sc("emp"), "", cmp("salary", ">", 55));
    const root = kind === "filter" ? new Project(ctx, emp(), ["name"]) : kind === "join" ? new Project(ctx, new HashJoin(ctx, sc("dept"), emp(), "dept.did", "emp.did"), ["name", "dname"]) : new Limit(ctx, new Sort(ctx, emp(), "salary", true), 2);
    const out = runAll(root);
    return { ctx, out };
  };
  test("scan, filter, project: 9 + 5 + 5 = 19 calls, 4 rows; push model also 19", () => {
    const { ctx, out } = flow("filter");
    expect(out.length).toBe(4);
    expect(ctx.ops.map((o) => o.stats.nexts)).toEqual([9, 5, 5]);
    expect(callCounts(ctx)).toEqual({ pull: 19, push: 19 });
    expect(out[0]).toEqual(["Ada"]);
  });
  test("hash join: the build reads all 4 departments", () => {
    const { ctx } = flow("join");
    expect(ctx.ops[0]!.stats.rows).toBe(4);
  });
  test("sort + limit 2: the limit makes 3 calls, the scan still 9", () => {
    const { ctx } = flow("sort");
    expect(ctx.ops.find((o) => o.name === "Limit")!.stats.nexts).toBe(3);
    expect(ctx.ops.find((o) => o.name === "Scan")!.stats.nexts).toBe(9);
  });
  const breaker = (kind: "join" | "agg" | "sort", n = 1000) => {
    const sdb: Db = scaledDb(n);
    const ctx = new Ctx();
    const sc = (t: string) => new Scan(ctx, t, sdb[t]!.rows, sdb[t]!.cols);
    const j = new HashJoin(ctx, sc("dept"), new Filter(ctx, sc("emp"), "", cmp("salary", ">", 60)), "dept.did", "emp.did");
    const root: Op = kind === "join" ? new Project(ctx, j, ["name", "dname"]) : kind === "agg" ? new HashAgg(ctx, j, ["emp.city"], [{ fn: "count" }, { fn: "sum", col: "salary" }]) : new Sort(ctx, new Project(ctx, j, ["name", "salary"]), "salary", true);
    runAll(root);
    return { ctx, root, j };
  };
  test("ORDER BY: first row at call 2,925 of 3,562 (82.1%); sort holds 637 rows, hash table 8", () => {
    const { ctx, root, j } = breaker("sort");
    expect(ctx.clock).toBe(3562);
    expect(root.stats.firstRowAt).toBe(2925);
    expect(((100 * 2925) / 3562).toFixed(1)).toBe("82.1");
    expect(root.stats.peak).toBe(637);
    expect(j.stats.peak).toBe(8);
  });
  test("project only: first row at call 13; GROUP BY: first row at 2,287 of 2,291 with 4 groups", () => {
    expect(breaker("join").root.stats.firstRowAt).toBe(13);
    const a = breaker("agg");
    expect([a.root.stats.firstRowAt, a.ctx.clock, a.root.stats.peak]).toEqual([2287, 2291, 4]);
  });
  test("with 4,000 employees the hash table on dept still holds 8 rows", () => {
    expect(breaker("sort", 4000).j.stats.peak).toBe(8);
  });
});

describe("join-algorithms", () => {
  const c = (B: number, o: Partial<typeof CMU_EXAMPLE> = {}) => ({ ...CMU_EXAMPLE, ...o, B, indexCost: 2 });
  test("CMU example: 50,001,000 (83.3 min), 501,000, 6,500, 201,000, 7,500, 4,500, 4,234", () => {
    expect(joinCost("nlj", c(100))).toBe(50_001_000);
    expect(((50_001_000 * 0.1) / 60_000).toFixed(1)).toBe("83.3");
    expect(joinCost("pnlj", c(100))).toBe(501_000);
    expect(joinCost("bnlj", c(100))).toBe(6_500);
    expect(joinCost("inlj", c(100))).toBe(201_000);
    expect(joinCost("smj", c(100))).toBe(7_500);
    expect([sortIO(1000, 100), sortIO(500, 100)]).toEqual([4000, 2000]);
    expect([sortPasses(1000, 100), sortPasses(500, 100)]).toEqual([2, 2]);
    expect(joinCost("ghj", c(100))).toBe(4_500);
    expect(3 * (1000 + 500)).toBe(4_500);
    expect(joinCost("hhj", c(100))).toBe(4_234);
    expect(hybridPlan(1000, 100)).toEqual({ k: 10, memPages: 89 });
    expect(4234 * 0.1).toBeLessThan(500);
  });
  test("B = 102: R outside 6,000, S outside 5,500; small outer of 10 rows: 21", () => {
    expect(joinCost("bnlj", c(102))).toBe(6_000);
    expect(joinCost("bnlj", { M: 500, N: 1000, m: 40_000, n: 100_000, B: 102, indexCost: 2 })).toBe(5_500);
    expect(joinCost("inlj", { M: 1, N: 500, m: 10, n: 40_000, B: 100, indexCost: 2 })).toBe(21);
  });
  test("Grace jumps from 4,500 to 7,500 below B = 34; B = 500: block NL 2,500; B = 1,002: 1,500", () => {
    expect(joinCost("ghj", c(34))).toBe(4_500);
    expect(joinCost("ghj", c(33))).toBe(7_500);
    expect(joinCost("bnlj", c(500))).toBe(2_500);
    expect(joinCost("ghj", c(500))).toBe(4_500);
    for (const a of ["bnlj", "ghj", "hhj"] as const) expect(joinCost(a, c(1002))).toBe(1_500);
  });
  const R = paged("R", [3, 7, 1, 5, 7, 2], 2), S = paged("S", [5, 1, 7, 4, 3, 7, 6, 1], 2);
  test("stepper: NL 27 I/Os, 48 comparisons, 8 pairs; block NL 11 (B = 4) and 7 (B = 5)", () => {
    const n = nestedLoopJoin(R, S);
    expect([n.reads, n.comparisons, n.pairs.length]).toEqual([27, 48, 8]);
    expect(blockNlj(R, S, 4).reads).toBe(11);
    expect(blockNlj(R, S, 5).reads).toBe(7);
  });
  test("stepper: index NL 6 probes and 17 I/Os; hash 8 probes and 7 I/Os; sort-merge 21 I/Os", () => {
    const i = indexNlj(R, S);
    expect([i.probes, i.reads]).toEqual([6, 17]);
    const h = hashJoin(R, S, 100);
    expect([h.probes, h.reads + h.writes]).toEqual([8, 7]);
    const m = sortMergeJoin(R, S, 4);
    expect(m.reads + m.writes).toBe(21);
  });
  const part = (B: number, skew: boolean, hybrid: boolean) => {
    const rk = skew ? zipfKeys(48, 40, 1.4, 11) : uniformKeys(48, 40, 11);
    const sk = skew ? zipfKeys(64, 40, 1.4, 12) : uniformKeys(64, 40, 12);
    const r = paged("R", rk, 4), s = paged("S", sk, 4);
    return hybrid ? hybridHashJoin(r, s, B) : graceHashJoin(r, s, B);
  };
  test("Grace demo: B = 6 → 90 I/Os against 3(M + N) = 84; B = 4 → 167", () => {
    const g = part(6, false, false);
    expect(g.reads + g.writes).toBe(90);
    expect(3 * (12 + 16)).toBe(84);
    expect(g.partitions!.every((p) => p.fits && p.depth === 1)).toBe(true);
    expect(part(4, false, false).reads + part(4, false, false).writes).toBe(167);
    expect(part(4, false, false).partitions!.some((p) => p.depth > 1)).toBe(true);
  });
  test("hybrid: 82 at B = 6; 56 against Grace 98 at B = 8", () => {
    const io = (r: ReturnType<typeof part>) => r.reads + r.writes;
    expect(io(part(6, false, true))).toBe(82);
    expect(io(part(8, false, true))).toBe(56);
    expect(io(part(8, false, false))).toBe(98);
  });
  test("skew: B = 6 → 9 partition joins and 120 I/Os; B = 4 → nested-loop fallbacks", () => {
    const s = part(6, true, false);
    expect([s.partitions!.length, s.reads + s.writes]).toEqual([9, 120]);
    expect(part(4, true, false).fallbacks).toBeGreaterThan(0);
  });
});

describe("external-sorting-and-aggregation", () => {
  const keys = uniformKeys(36, 99, 21).map((k) => k + 1);
  const pages = Array.from({ length: 12 }, (_, i) => keys.slice(3 * i, 3 * i + 3));
  test("12 pages, B = 3: 4 runs, 3 passes, 36 + 36 = 72 I/Os; B = 4: 3 runs, 2 passes, 48", () => {
    const a = externalSort(pages, 3, (x) => x);
    expect([a.runsAfterPass0, a.passes, a.reads, a.writes]).toEqual([4, 3, 36, 36]);
    const b = externalSort(pages, 4, (x) => x);
    expect([b.runsAfterPass0, b.passes, b.reads + b.writes]).toEqual([3, 2, 48]);
  });
  test("1 M pages (7.63 GiB), 512 frames (4 MiB): 1,954 runs, then 4, then 1: 3 passes, 6 M I/Os", () => {
    expect((1e6 * 8192 / GiB).toFixed(2)).toBe("7.63");
    expect(512 * 8192).toBe(4 * MiB);
    expect(Math.ceil(1e6 / 512)).toBe(1954);
    expect(Math.ceil(1954 / 511)).toBe(4);
    expect(sortPasses(1e6, 512)).toBe(3);
    expect(sortIO(1e6, 512)).toBe(6e6);
  });
  test("two passes from 1,001 frames (7.82 MiB); a third fewer I/Os; still 2 at 100,000 frames; 20 at B = 3", () => {
    expect(twoPassBuffer(1e6)).toBe(1001);
    expect((1001 * 8192 / MiB).toFixed(2)).toBe("7.82");
    expect([sortPasses(1e6, 1000), sortPasses(1e6, 1001)]).toEqual([3, 2]);
    expect(sortIO(1e6, 1001) / sortIO(1e6, 512)).toBeCloseTo(2 / 3, 10);
    expect(sortPasses(1e6, 1e5)).toBe(2);
    expect(sortPasses(1e6, 3)).toBe(20);
  });
  test("1 G pages (7.45 TiB): 4 passes at 512 frames; 31,624 frames (247 MiB) for 2 passes", () => {
    expect((1e9 * 8192 / TiB).toFixed(2)).toBe("7.45");
    expect(sortPasses(1e9, 512)).toBe(4);
    expect(twoPassBuffer(1e9)).toBe(31624);
    expect(Math.round(31624 * 8192 / MiB)).toBe(247);
    expect(sortPassesWithRuns(1e6, 512, 1024)).toBe(3);
  });
  test("a heap over 511 runs has 9 levels", () => {
    expect(Math.floor(Math.log2(511)) + 1).toBe(9);
  });
  test("replacement selection: 51 runs, mean 1,961 on random input; 1 run sorted; 1,000 reverse", () => {
    const r = replacementSelection(sortInput(100_000, "random", 9), 1000).runs;
    expect(r.length).toBe(51);
    expect(Math.round(100_000 / r.length)).toBe(1961);
    expect(replacementSelection(sortInput(100_000, "sorted", 9), 1000).runs.length).toBe(1);
    expect(100_000 / replacementSelection(sortInput(100_000, "reverse", 9), 1000).runs.length).toBe(1000);
  });
  test("48 random keys with M = 6: 5 runs against 8", () => {
    expect(replacementSelection(sortInput(48, "random", 4).map((x) => x + 1), 6).runs.length).toBe(5);
    expect(loadSortRuns(48, 6)).toBe(8);
  });
  test("aggregation: G = 20,000 → 33,104 rows spilled, 2,358 I/Os; sort 3,000; G ≤ 5,000 → 1,000", () => {
    const h = hashAggregate(uniformKeys(50_000, 20_000, 5), 5_000, 50, 32);
    expect(h.spilledRows).toBe(33_104);
    expect(1000 + h.spillWrites + h.spillReads).toBe(2_358);
    expect(sortAggIO(1000, 100)).toBe(3_000);
    expect(hashAggIO(1000, 5000, 5000)).toBe(1000);
    const small = hashAggregate(uniformKeys(50_000, 4_000, 5), 5_000, 50, 32);
    expect(small.spillWrites + small.spillReads).toBe(0);
    expect(hashAggIO(1000, 20_000, 5000)).toBe(2500);
  });
  test("top-N of 100,000 keys with k = 10: 100,411 comparisons; merge sort 1,536,789", () => {
    const keys = sortInput(100_000, "random");
    expect(topN(keys, 10).comparisons).toBe(100_411);
    expect(mergeSortComparisons(keys)).toBe(1_536_789);
  });
});

describe("vectorized-execution", () => {
  test("size 1: 42.6 ns; best 1,024: 2.68 ns (32 KiB working set); 2,048: 2.82; full columns 8.15 (3×); 15.9× speedup", () => {
    expect(vectorCost(1).total.toFixed(1)).toBe("42.6");
    const b = bestVectorSize();
    expect(b.v).toBe(1024);
    expect(b.ns.toFixed(2)).toBe("2.68");
    expect(vectorCost(1024).workingSet).toBe(32 * 1024);
    expect(vectorCost(2048).total.toFixed(2)).toBe("2.82");
    expect(vectorCost(1 << 24).total.toFixed(2)).toBe("8.15");
    expect(Math.round(vectorCost(1 << 24).total / b.ns)).toBe(3);
    expect((vectorCost(1).total / b.ns).toFixed(1)).toBe("15.9");
    expect(fitsIn(VEC_MODEL.l1)).toBe(1536);
  });
  test("overhead 50 ns: size 1 costs 202.6 ns and the best stays 1,024; 8 primitives: L1 up to 768, best 512", () => {
    const m50 = { ...VEC_MODEL, callNs: 50 };
    expect(vectorCost(1, m50).total.toFixed(1)).toBe("202.6");
    expect(bestVectorSize(m50).v).toBe(1024);
    const m8 = { ...VEC_MODEL, prims: 8 };
    expect(fitsIn(m8.l1, m8)).toBe(768);
    expect(bestVectorSize(m8).v).toBe(512);
  });
  test("selection vectors: 10 then 8 rows, 26 evaluations against 32; a > 90 keeps 2", () => {
    const s = selectionSteps(40, 50);
    expect([s.p1.sel.length, s.p2.sel.length, s.p1.evaluated + s.p2.evaluated]).toEqual([10, 8, 26]);
    expect(selectionSteps(90, 50).p1.sel.length).toBe(2);
    expect(selectionSteps(0, 50).p1.sel.length).toBe(16);
  });
  test("branches at 50%: 50.4% mispredicted, 8.57 cycles against 2; at 5%: 1.79; branch-free wins from 8% to 93%", () => {
    const h = branchSim(0.5);
    expect((h.mispredictRate * 100).toFixed(1)).toBe("50.4");
    expect(h.branching.toFixed(2)).toBe("8.57");
    expect(h.branchFree).toBe(2);
    expect(branchSim(0.05).branching.toFixed(2)).toBe("1.79");
    const grid = Array.from({ length: 41 }, (_, i) => i / 40);
    const wins = (pen: number) => grid.filter((p) => { const r = branchSim(p, 20000, 3, { ...BRANCH_MODEL, penaltyCycles: pen }); return r.branching > r.branchFree; });
    const w15 = wins(15);
    expect([Math.round(w15[0]! * 100), Math.round(w15.at(-1)! * 100)]).toEqual([8, 93]);
    expect(wins(30).length).toBeGreaterThan(w15.length);
  });
  test("10,000 rows: 40 primitive calls with vectors of 1,024, 31,032 steps row by row", () => {
    const t = makeTable(10_000);
    expect(runVectorized(t, 1024, 30, 60).primitiveCalls).toBe(40);
    expect(runTupleAtATime(t, 30, 60).primitiveCalls).toBe(31_032);
  });
});

describe("query-compilation", () => {
  const g = (id: string) => generate(CG_PLANS.find((p) => p.id === id)!.plan);
  test("join + group by: 5 operators, 17 lines, 2 loops over tables; filter + sum: 7 lines, 1 loop; two joins: 25 lines, 3 loops", () => {
    const j = g("join");
    expect(new Set(j.lines.map((l) => l.op)).size).toBe(5);
    expect([j.lines.length, scanLoops(j.lines)]).toEqual([17, 2]);
    expect([g("q1").lines.length, scanLoops(g("q1").lines)]).toEqual([7, 1]);
    expect([g("two").lines.length, scanLoops(g("two").lines)]).toEqual([25, 3]);
  });
  test("break-even at 40 ms: 20 M rows against vectorized, about 851,000 against the interpreter; 500,000 at 1 ms", () => {
    expect(breakEven("compiled", "vector", 40, "compute")).toBe(20_000_000);
    expect(Math.round(breakEven("compiled", "volcano", 40, "compute")! / 1000)).toBe(851);
    expect(breakEven("compiled", "vector", 1, "compute")).toBe(500_000);
    expect(NS_PER_ROW.compute).toMatchObject({ volcano: 50, vector: 5, compiled: 3 });
  });
  test("memory-bound: vectorized 10 ns, compiled 12 ns, so compilation never pays off against it", () => {
    expect([NS_PER_ROW.memory.vector, NS_PER_ROW.memory.compiled]).toEqual([10, 12]);
    expect(breakEven("compiled", "vector", 40, "memory")).toBe(null);
  });
  test("10 M rows: adaptive 62 ms, vectorized 50 ms, compiled 70 ms; 10 k rows: adaptive never compiles", () => {
    expect(engineTime("adaptive", 1e7, 40, "compute")).toBeCloseTo(62, 9);
    expect(engineTime("vector", 1e7, 40, "compute")).toBeCloseTo(50, 9);
    expect(engineTime("compiled", 1e7, 40, "compute")).toBeCloseTo(70, 9);
    expect(engineTime("adaptive", 1e4, 40, "compute")).toBeCloseTo((1e4 * NS_PER_ROW.compute.bytecode) / 1e6, 12);
    expect(engineTime("adaptive", 1e4, 40, "compute")).toBeLessThan(40);
  });
  test("PostgreSQL JIT defaults", () => {
    expect(PG_JIT).toEqual({ jit_above_cost: 100_000, jit_inline_above_cost: 500_000, jit_optimize_above_cost: 500_000 });
  });
});
