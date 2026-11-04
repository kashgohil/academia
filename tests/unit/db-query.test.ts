/** Correctness of the query-processing sims in src/sims/db/query. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  SAMPLE_DB, scaledDb, sameBag,
  and3, or3, not3, compare, cmp, and, or, not, isNull, compilePred,
  evalPlan, rewriteSteps, REWRITE_QUERY, scan, select, project, join, natural, cross, group, distinct, setop, rename, canonical, cascadeSelections, pushSelections, selectionsToJoins, pushProjections,
  Ctx, runAll, fromPlan, pipelines, Scan, Filter, HashJoin, Sort, Limit, HashAgg, NestedLoopJoin,
  paged, nestedLoopJoin, blockNlj, indexNlj, sortMergeJoin, hashJoin, graceHashJoin, hybridHashJoin, pairKey, uniformKeys, zipfKeys, joinCost, sortIO, graceCost, hybridCost, hybridPlan, tuplesOf,
  externalSort, sortPasses, sortPassesFormula, sortPassesWithRuns, replacementSelection, sortInput, hashAggregate, sortAggregate, topN, twoPassBuffer,
  makeTable, runVectorized, runTupleAtATime, selGtBranching, selGtBranchFree,
  generate, CG_PLANS, engineTime,
} from "@/sims/db/query";

// ------------------------------------------------------------------ three-valued logic and algebra

describe("three-valued logic", () => {
  const T = [true, false, null] as const;
  test("Kleene tables", () => {
    for (const a of T) for (const b of T) {
      expect(and3(a, b)).toBe(a === false || b === false ? false : a === null || b === null ? null : true);
      expect(or3(a, b)).toBe(a === true || b === true ? true : a === null || b === null ? null : false);
    }
    expect(not3(null)).toBe(null);
    expect(compare("=", null, null)).toBe(null);
    expect(compare("<>", 1, null)).toBe(null);
  });
  test("compiled predicates follow the tables", () => {
    const cols = SAMPLE_DB.emp!.cols;
    const gus = SAMPLE_DB.emp!.rows[6]!; // salary NULL
    expect(compilePred(or(cmp("salary", ">", 55), cmp("salary", "<=", 55)), cols)(gus)).toBe(null);
    expect(compilePred(and(cmp("salary", ">", 55), cmp("did", "=", 99)), cols)(gus)).toBe(false);
    expect(compilePred(not(isNull("salary")), cols)(gus)).toBe(false);
  });
});

describe("algebra evaluator", () => {
  const db = SAMPLE_DB;
  test("set operations remove duplicates, ALL keeps them", () => {
    const a = project(["city"], scan("emp")), b = project(["city"], scan("dept"));
    expect(evalPlan(setop("union", a, b, true), db).result.rows.length).toBe(12);
    expect(evalPlan(setop("union", a, b), db).result.rows.length).toBe(4);
    expect(evalPlan(setop("intersect", a, b), db).result.rows.map((r) => r[0]).sort()).toEqual(["Berlin", "Paris", "Rome"]);
    expect(evalPlan(distinct(a), db).result.rows.length).toBe(3);
  });
  test("natural join matches on every common column and never on NULL", () => {
    const nj = evalPlan(natural(scan("emp"), scan("dept")), db).result;
    expect(nj.cols.map((c) => c.name)).toEqual(["eid", "name", "did", "salary", "city", "dname"]);
    expect(nj.rows.map((r) => r[1])).toEqual(["Ada", "Gus"]);
  });
  test("theta join equals selection over the product", () => {
    const p = cmp("emp.did", "=", "dept.did");
    expect(sameBag(evalPlan(join(p, scan("emp"), scan("dept")), db).result.rows, evalPlan(select(p, cross(scan("emp"), scan("dept"))), db).result.rows)).toBe(true);
  });
  test("grouping: empty input with no keys gives one row; NULL keys form one group", () => {
    const empty = select(cmp("salary", ">", 1000), scan("emp"));
    expect(evalPlan(group([], [{ fn: "count" }, { fn: "sum", col: "salary" }], empty), db).result.rows).toEqual([[0, null]]);
    const g = evalPlan(group(["did"], [{ fn: "count" }], scan("emp")), db).result.rows;
    expect(g.find((r) => r[0] === null)).toEqual([null, 1]);
  });
  test("every rewrite step returns the same bag of rows", () => {
    for (const n of [20, 50, 120, 200]) {
      const sdb = scaledDb(n);
      const steps = rewriteSteps(REWRITE_QUERY, sdb);
      const base = evalPlan(steps[0]!.plan, sdb).result.rows;
      for (const s of steps) expect(sameBag(evalPlan(s.plan, sdb).result.rows, base), `${n} ${s.rule}`).toBe(true);
    }
  });
  test("pushdown rules preserve results on random predicates", () => {
    const rnd = mulberry32(5);
    const preds = [cmp("e.salary", ">", 60), cmp("d.city", "=", "'Rome'"), cmp("p.budget", "<", 90), cmp("e.did", "=", "d.did"), cmp("p.did", "=", "d.did"), cmp("e.city", "=", "d.city")];
    const sdb = scaledDb(40);
    for (let t = 0; t < 20; t++) {
      const where = preds.filter(() => rnd() < 0.5);
      const q = { select: ["e.name", "d.dname", "p.pname"], from: [["emp", "e"], ["dept", "d"], ["proj", "p"]] as [string, string][], where };
      const c = canonical(q);
      const r = evalPlan(c, sdb).result.rows;
      const opt = pushProjections(selectionsToJoins(pushSelections(cascadeSelections(c), sdb)), sdb);
      expect(sameBag(evalPlan(opt, sdb).result.rows, r)).toBe(true);
    }
  });
});

// ------------------------------------------------------------------ iterators

describe("iterators", () => {
  const db = SAMPLE_DB;
  test("fromPlan gives the same bag as the materializing evaluator", () => {
    const plans = [
      project(["name"], select(cmp("salary", ">", 55), scan("emp"))),
      project(["name", "dname"], join(cmp("dept.did", "=", "emp.did"), scan("dept"), scan("emp"))),
      join(cmp("emp.salary", "<", "proj.budget"), scan("emp"), scan("proj")),
      group(["did"], [{ fn: "count" }, { fn: "sum", col: "salary" }, { fn: "avg", col: "salary" }, { fn: "min", col: "salary" }, { fn: "max", col: "salary" }], scan("emp")),
      distinct(project(["city"], scan("emp"))),
      project(["e.name"], select(cmp("e.salary", ">", 50), rename("e", scan("emp")))),
    ];
    for (const p of plans) expect(sameBag(runAll(fromPlan(p, db, new Ctx())), evalPlan(p, db).result.rows)).toBe(true);
  });
  test("each operator receives one call per row plus one EOF call", () => {
    const ctx = new Ctx();
    const sc = new Scan(ctx, "emp", db.emp!.rows, db.emp!.cols);
    const f = new Filter(ctx, sc, "", cmp("salary", ">", 55));
    runAll(f);
    for (const o of ctx.ops) expect(o.stats.nexts).toBe(o.stats.rows + 1);
  });
  test("sort, limit and nested-loop join", () => {
    const ctx = new Ctx();
    const sc = () => new Scan(ctx, "emp", db.emp!.rows, db.emp!.cols);
    const top = runAll(new Limit(ctx, new Sort(ctx, sc(), "salary", true), 3));
    expect(top.map((r) => r[3])).toEqual([85, 70, 61]);
    const nl = runAll(new NestedLoopJoin(ctx, new Scan(ctx, "dept", db.dept!.rows, db.dept!.cols), sc(), "", cmp("dept.did", "=", "emp.did")));
    expect(nl.length).toBe(7);
  });
  test("pipelines: a hash join splits build and probe; sort and aggregation end a pipeline", () => {
    const ctx = new Ctx();
    const j = new HashJoin(ctx, new Scan(ctx, "dept", db.dept!.rows, db.dept!.cols), new Scan(ctx, "emp", db.emp!.rows, db.emp!.cols), "dept.did", "emp.did");
    const root = new Sort(ctx, new HashAgg(ctx, j, ["dname"], [{ fn: "count" }]), "dname");
    const ps = pipelines(root);
    expect(ps.map((p) => p.breaker)).toEqual([j.id, 3, 4, null]);
    expect(ps[1]!.ops).toEqual([1, 2]);
  });
});

// ------------------------------------------------------------------ joins

describe("join algorithms", () => {
  const algos = (B: number) => [
    ["block NL", (R: ReturnType<typeof paged>, S: ReturnType<typeof paged>) => blockNlj(R, S, B)],
    ["index NL", (R: ReturnType<typeof paged>, S: ReturnType<typeof paged>) => indexNlj(R, S)],
    ["index NL clustered", (R: ReturnType<typeof paged>, S: ReturnType<typeof paged>) => indexNlj(R, S, { clustered: true })],
    ["sort-merge", (R: ReturnType<typeof paged>, S: ReturnType<typeof paged>) => sortMergeJoin(R, S, B)],
    ["hash", (R: ReturnType<typeof paged>, S: ReturnType<typeof paged>) => hashJoin(R, S, B)],
    ["grace", (R: ReturnType<typeof paged>, S: ReturnType<typeof paged>) => graceHashJoin(R, S, B)],
    ["hybrid", (R: ReturnType<typeof paged>, S: ReturnType<typeof paged>) => hybridHashJoin(R, S, B)],
  ] as const;
  test("every algorithm returns the same multiset as nested loop on random tables", () => {
    const rnd = mulberry32(99);
    for (let t = 0; t < 40; t++) {
      const m = 1 + Math.floor(rnd() * 80), n = 1 + Math.floor(rnd() * 80), d = 1 + Math.floor(rnd() * 30);
      const tpp = 1 + Math.floor(rnd() * 5), B = 3 + Math.floor(rnd() * 8);
      const skew = rnd() < 0.3;
      const R = paged("R", skew ? zipfKeys(m, d, 1.5, t) : uniformKeys(m, d, t), tpp);
      const S = paged("S", skew ? zipfKeys(n, d, 1.5, t + 1000) : uniformKeys(n, d, t + 1000), tpp);
      const ref = pairKey(nestedLoopJoin(R, S).pairs);
      for (const [name, f] of algos(B)) expect(pairKey(f(R, S).pairs), `${name} t=${t} B=${B}`).toEqual(ref);
    }
  });
  test("one hot key forces the nested-loop fallback, and the result is still right", () => {
    const R = paged("R", Array(40).fill(7), 4), S = paged("S", [...Array(10).fill(7), 1, 2, 3], 4);
    const g = graceHashJoin(R, S, 4);
    expect(g.fallbacks).toBeGreaterThan(0);
    expect(g.pairs.length).toBe(400);
  });
  test("executed I/O counts match the formulas", () => {
    for (const [m, n, tpp, B] of [[60, 80, 4, 5], [100, 30, 5, 7], [12, 200, 3, 4]] as const) {
      const R = paged("R", uniformKeys(m, 20, 1), tpp), S = paged("S", uniformKeys(n, 20, 2), tpp);
      const M = R.pages.length, N = S.pages.length;
      const c = { M, N, B, m, n, indexCost: 0 };
      expect(nestedLoopJoin(R, S).reads).toBe(joinCost("nlj", c));
      expect(blockNlj(R, S, B).reads).toBe(joinCost("bnlj", c));
      expect(blockNlj(R, S, 3).reads).toBe(joinCost("pnlj", c));
      const smj = sortMergeJoin(R, S, B);
      expect(smj.reads + smj.writes).toBe(joinCost("smj", c));
      const matches = tuplesOf(R).reduce((a, r) => a + tuplesOf(S).filter((s) => s.k === r.k).length, 0);
      expect(indexNlj(R, S).reads).toBe(M + m + matches);
      expect(hashJoin(R, S, M + 2).reads).toBe(M + N);
      // Grace: partition reads M + N, writes at least M + N; join reads what was written.
      const g = graceHashJoin(R, S, Math.max(B, Math.ceil(Math.sqrt(M)) + 2));
      if ((g.partitions ?? []).every((p) => p.depth <= 1)) {
        expect(g.writes).toBeGreaterThanOrEqual(M + N);
        expect(g.reads).toBeLessThanOrEqual(M + N + g.writes);
      }
    }
  });
  test("formula helpers: sort cost, Grace levels, hybrid plan", () => {
    expect(sortIO(1000, 100)).toBe(4000);
    expect(graceCost(1000, 500, 34)).toBe(4500);
    expect(graceCost(1000, 500, 33)).toBe(7500);
    expect(hybridCost(10, 10, 20)).toBe(20);
    const p = hybridPlan(1000, 100)!;
    expect(Math.ceil((1000 - p.memPages) / p.k)).toBeLessThanOrEqual(98);
    expect(hybridPlan(12, 5)).toBe(null);
  });
});

// ------------------------------------------------------------------ sorting and aggregation

describe("external sort", () => {
  test("output is sorted and complete; I/O = 2N × passes; passes match the formula", () => {
    const rnd = mulberry32(3);
    for (let t = 0; t < 60; t++) {
      const n = Math.floor(rnd() * 400), tpp = 1 + Math.floor(rnd() * 6), B = 3 + Math.floor(rnd() * 8);
      const keys = uniformKeys(n, 50, t);
      const pages: number[][] = [];
      for (let i = 0; i < n; i += tpp) pages.push(keys.slice(i, i + tpp));
      const r = externalSort(pages, B, (x) => x, t < 5);
      const flat = r.pages.flat();
      expect(flat).toEqual([...keys].sort((a, b) => a - b));
      if (pages.length) {
        expect(r.passes).toBe(sortPasses(pages.length, B));
        expect(r.passes).toBe(sortPassesFormula(pages.length, B));
        expect(r.reads).toBe(pages.length * r.passes);
        expect(r.writes).toBe(pages.length * r.passes);
      }
    }
  });
  test("passes formula agrees with run counting over a wide range", () => {
    for (const n of [1, 2, 9, 10, 99, 100, 101, 1e3, 12345, 1e6, 1e9]) for (const b of [3, 4, 5, 10, 64, 512, 1001, 1e5]) {
      expect(sortPassesFormula(n, b), `${n} ${b}`).toBe(sortPasses(n, b));
    }
    expect(sortPassesWithRuns(1000, 10, 10)).toBe(sortPasses(1000, 10));
    for (const n of [10, 1e6, 1e9]) { const b = twoPassBuffer(n); expect(sortPasses(n, b)).toBeLessThanOrEqual(2); expect(sortPasses(n, b - 1)).toBeGreaterThan(2 - (n <= (b - 1) ? 1 : 0)); }
  });
  test("replacement selection: every run sorted, all keys kept", () => {
    for (const o of ["random", "sorted", "reverse", "nearly"] as const) {
      const keys = sortInput(5000, o, 2);
      const { runs } = replacementSelection(keys, 64);
      for (const r of runs) for (let i = 1; i < r.length; i++) expect(r[i]!).toBeGreaterThanOrEqual(r[i - 1]!);
      expect(runs.flat().sort((a, b) => a - b)).toEqual([...keys].sort((a, b) => a - b));
    }
  });
  test("spilling hash aggregation equals sort aggregation", () => {
    for (const [n, g, cap] of [[5000, 50, 100], [5000, 3000, 100], [20000, 20000, 500], [100, 1, 1]] as const) {
      const keys = uniformKeys(n, g, 4);
      const h = hashAggregate(keys, cap, 10, 8);
      expect([...h.groups.entries()].sort((a, b) => a[0] - b[0])).toEqual([...sortAggregate(keys).entries()].sort((a, b) => a[0] - b[0]));
      expect(h.maxGroupsHeld).toBeLessThanOrEqual(cap);
    }
  });
  test("top-N returns the k smallest keys", () => {
    const keys = uniformKeys(3000, 100000, 8);
    expect(topN(keys, 25).top).toEqual([...keys].sort((a, b) => a - b).slice(0, 25));
  });
});

// ------------------------------------------------------------------ vectors and codegen

describe("vectorized executor", () => {
  test("vectorized result equals the row-by-row result for any vector size", () => {
    const t = makeTable(5000, 2);
    const ref = runTupleAtATime(t, 30, 60);
    for (const v of [1, 7, 64, 1000, 1024, 4096, 10000]) {
      const r = runVectorized(t, v, 30, 60);
      expect(r.sum).toBe(ref.sum);
      expect(r.selected).toBe(ref.selected);
      expect(r.primitiveCalls).toBe(4 * Math.ceil(5000 / v));
    }
  });
  test("branching and branch-free selection give the same selection vector", () => {
    const t = makeTable(777, 9);
    const o1 = new Int32Array(777), o2 = new Int32Array(777);
    for (const c of [-1, 0, 30, 50, 99, 100]) {
      const k1 = selGtBranching(t.a, c, null, 777, o1), k2 = selGtBranchFree(t.a, c, null, 777, o2);
      expect(k2).toBe(k1);
      expect([...o2.slice(0, k2)]).toEqual([...o1.slice(0, k1)]);
    }
  });
});

describe("code generation", () => {
  test("braces balance, and each operator emits code", () => {
    for (const p of CG_PLANS) {
      const g = generate(p.plan);
      const opens = g.lines.filter((l) => l.text.endsWith("{")).length, closes = g.lines.filter((l) => l.text.startsWith("}")).length;
      expect(opens, p.id).toBe(closes);
      expect(g.lines.at(-1)!.indent).toBe(0);
      const emitted = new Set(g.lines.map((l) => l.op));
      let ops = 0;
      const count = (x: typeof p.plan): void => { ops++; if (x.op === "join") { count(x.build); count(x.probe); } else if (x.op !== "scan") count(x.input); };
      count(p.plan);
      expect(emitted.size).toBe(ops);
    }
  });
  test("adaptive execution is never slower than the bytecode interpreter alone", () => {
    for (const rows of [1e3, 1e5, 1e7, 1e9]) for (const w of ["compute", "memory"] as const) {
      expect(engineTime("adaptive", rows, 40, w)).toBeLessThanOrEqual(rows * (w === "compute" ? 15 : 25) / 1e6 + 1e-9);
      expect(engineTime("adaptive", rows, 40, w)).toBeLessThanOrEqual(engineTime("compiled", rows, 40, w) + 40);
    }
  });
});
