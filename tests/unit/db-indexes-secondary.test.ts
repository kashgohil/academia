/** Secondary and covering indexes: leftmost-prefix property tests, and every number quoted in the lesson. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  CompositeIndex, columnUse, providesOrder, planQuery, pathCosts, crossover, ORDERS_MODEL, SSD_COSTS, DEFAULT_COSTS, buildWorld, lookupTrace,
  scaleReads, VM_HEAP_PAGES_PER_PAGE, pagesFetched, btreeEntriesPerPage, type Pred, type Row, type Col, type PredCol, type SweepPoint,
} from "@/sims/db/indexes/secondary";
import { PG_COSTS } from "@/sims/db/storage/heap";

describe("composite index: leftmost-prefix rule against brute force", () => {
  const rng = mulberry32(3);
  const rows: Row[] = Array.from({ length: 600 }, (_, id) => ({ id, a: Math.floor(rng() * 5), b: Math.floor(rng() * 8), c: Math.floor(rng() * 20) }));
  const keys = [["a", "b", "c"], ["b", "a"], ["c"], ["c", "a", "b"]];
  const randPred = (col: string): Pred | null => {
    const r = rng();
    if (r < 0.35) return null;
    const lo = Math.floor(rng() * 6);
    return r < 0.7 ? { col, lo, hi: lo } : { col, lo, hi: lo + Math.floor(rng() * 6) };
  };
  test("matches = brute force; scanned = rows matching the seek prefix only", () => {
    for (let trial = 0; trial < 400; trial++) {
      const key = keys[trial % keys.length]!;
      const ix = new CompositeIndex(key, rows);
      const preds = ["a", "b", "c"].map(randPred).filter((p): p is Pred => !!p);
      const ok = (r: Row, ps: Pred[]) => ps.every((p) => r[p.col]! >= p.lo && r[p.col]! <= p.hi);
      const got = ix.scan(preds);
      const keyPreds = preds.filter((p) => key.includes(p.col));
      expect(new Set(got.ids)).toEqual(new Set(rows.filter((r) => ok(r, keyPreds)).map((r) => r.id!)));
      const use = columnUse(key, preds);
      const seek = preds.filter((p) => { const i = key.indexOf(p.col); return i >= 0 && (use[i] === "seek =" || use[i] === "seek range"); });
      expect(got.scanned).toBe(rows.filter((r) => ok(r, seek)).length);
      for (const ord of key) {
        if (!providesOrder(key, preds, ord)) continue;
        const vals = got.ids.map((id) => rows[id]![ord]!);
        expect(vals).toEqual([...vals].sort((x, y) => x - y));
      }
    }
  });
  test("column use: equality continues, the first range or gap stops the walk", () => {
    const p = (col: string, eq: boolean): Pred => ({ col, lo: 1, hi: eq ? 1 : 2 });
    expect(columnUse(["a", "b", "c"], [p("a", true), p("b", false), p("c", true)])).toEqual(["seek =", "seek range", "index filter"]);
    expect(columnUse(["a", "b"], [p("b", true)])).toEqual(["unused", "index filter"]);
    expect(providesOrder(["a", "b"], [p("a", true)], "b")).toBe(true);
    expect(providesOrder(["a", "b"], [p("a", false)], "b")).toBe(false);
  });
});

describe("cost model", () => {
  const m = ORDERS_MODEL;
  test("orders table: 1 M rows, 13,334 heap pages, 3,817 index leaves, height 3", () => {
    expect(m).toEqual({ rows: 1_000_000, pages: 13334, indexPages: 3817, indexHeight: 3 });
    expect(btreeEntriesPerPage(16, 0.9)).toBe(262);
    expect([PG_COSTS.seq_page_cost, PG_COSTS.random_page_cost, SSD_COSTS.randomPage]).toEqual([1, 4, 1.1]);
  });
  test("Mackert–Lohman never fetches more pages than the table has (when it fits the cache)", () => {
    for (const n of [1, 100, 1e4, 1e6, 1e7]) expect(pagesFetched(n, m.pages, DEFAULT_COSTS.cachePages)).toBeLessThanOrEqual(m.pages);
    expect(pagesFetched(100, m.pages, DEFAULT_COSTS.cachePages)).toBe(100);
  });
  const cross = (a: keyof SweepPoint, o: { correlation?: number; allVisible?: number }, c = DEFAULT_COSTS) =>
    crossover((s) => pathCosts(m, s, o, c)[a], (s) => pathCosts(m, s, o, c).seq)!;
  const p2 = (v: number) => Math.round(v * 10000) / 100; // percent, two decimals
  const p1 = (v: number) => Math.round(v * 1000) / 10;
  test("crossovers: index 0.84%, bitmap 35.2%; correlated index 56.0%; SSD index 51.5%", () => {
    expect(p2(cross("index", {}))).toBe(0.84);
    expect(p1(cross("bitmap", {}))).toBe(35.2);
    expect(p1(cross("index", { correlation: 1 }))).toBe(56.0);
    expect(p1(cross("index", {}, SSD_COSTS))).toBe(51.5);
  });
  test("index-only scan: wins until 78.8% when all-visible, 2.4% when half the pages are", () => {
    expect(p1(cross("indexOnly", { allVisible: 1 }))).toBe(78.8);
    expect(p1(cross("indexOnly", { allVisible: 0.5 }))).toBe(2.4);
  });
  test("at 1%: seq 25,834, index 29,424, bitmap 13,337", () => {
    const c = pathCosts(m, 0.01);
    expect([Math.round(c.seq), Math.round(c.index), Math.round(c.bitmap)]).toEqual([25834, 29424, 13337]);
  });
});

describe("planner toy", () => {
  const plan = (key: Col[], where: PredCol[], orderBy: Col | null, select: "*" | Col[], o: { limit?: number; include?: Col[] } = {}) =>
    planQuery({ key, include: o.include ?? [] }, { where, orderBy, select, limit: o.limit ?? null });
  test("default: (customer_id, created_at) with only the created_at range → Seq Scan", () => {
    const p = plan(["customer_id", "created_at"], ["created_at"], "created_at", "*");
    expect(p.use).toEqual(["unused", "index filter"]);
    expect(p.best.name).toBe("Seq Scan");
  });
  test("both predicates seek and return about 2 rows; swapping the columns costs 13 → 493", () => {
    const a = plan(["customer_id", "created_at"], ["customer_id", "created_at"], "created_at", "*");
    expect(a.use).toEqual(["seek =", "seek range"]);
    expect(a.rows).toBe(2);
    const b = plan(["created_at", "customer_id"], ["customer_id", "created_at"], "created_at", "*");
    expect(b.use).toEqual(["seek range", "index filter"]);
    expect(Math.round(a.best.cost)).toBe(13);
    expect(Math.round(b.best.cost)).toBe(493);
    expect(Math.round(b.boundSel * 1000) / 10).toBe(1.9);
  });
  test("INCLUDE (amount) turns the plan into an Index Only Scan", () => {
    const sel: Col[] = ["customer_id", "created_at", "amount"];
    expect(plan(["customer_id", "created_at"], ["customer_id", "created_at"], "created_at", sel).best.name).not.toBe("Index Only Scan");
    expect(plan(["customer_id", "created_at"], ["customer_id", "created_at"], "created_at", sel, { include: ["amount"] }).best.name).toBe("Index Only Scan");
  });
  test("(created_at), ORDER BY created_at: index scan with no sort; LIMIT 10 costs about 1", () => {
    const a = plan(["created_at"], [], "created_at", "*");
    expect([a.best.name, a.best.sorted]).toEqual(["Index Scan", true]);
    const b = plan(["created_at"], [], "created_at", "*", { limit: 10 });
    expect(b.best.name).toBe("Index Scan");
    expect(Math.round(b.best.cost)).toBe(1);
  });
});

describe("clustered vs heap lookups", () => {
  const reads = (e: "innodb" | "postgres", kind: Parameters<typeof lookupTrace>[1], allVisible = true) =>
    lookupTrace(buildWorld(e), kind, { id: 17, email: "max@x.io", lo: "a", hi: "f" }, allVisible);
  test("trees have 3 levels", () => {
    const w = buildWorld("innodb");
    expect([w.primary.height, w.secondary.height]).toEqual([3, 3]);
  });
  test("InnoDB: email lookup 3 + 3 = 6, covered 3; PostgreSQL: 3 + 1 = 4, index-only 4 or 5", () => {
    const by = (r: ReturnType<typeof reads>, s: string) => r.filter((x) => x.s === s).length;
    const a = reads("innodb", "email");
    expect([by(a, "secondary"), by(a, "primary")]).toEqual([3, 3]);
    expect(reads("innodb", "email-id")).toHaveLength(3);
    const b = reads("postgres", "email");
    expect([by(b, "secondary"), by(b, "heap")]).toEqual([3, 1]);
    expect(reads("postgres", "email-id")).toHaveLength(4);
    expect(reads("postgres", "email-id", false)).toHaveLength(5);
    expect(reads("postgres", "pk")).toHaveLength(4);
    expect(reads("innodb", "pk")).toHaveLength(3);
  });
  test("email range a–f: 6 rows; InnoDB 5 + 6 × 3 = 23 reads, PostgreSQL 5 + 6 = 11", () => {
    const a = reads("innodb", "email-range"), b = reads("postgres", "email-range");
    expect(a.filter((x) => x.s === "secondary")).toHaveLength(5);
    expect(a).toHaveLength(23);
    expect(b.filter((x) => x.s === "heap")).toHaveLength(6);
    expect(b).toHaveLength(11);
  });
  test("100 M rows: InnoDB 4 + 4 = 8 (16 KiB), PostgreSQL 4 + 1 = 5 (8 KiB)", () => {
    const i = scaleReads(1e8, { pkBytes: 8, secKeyBytes: 32, rowBytes: 200, pageBytes: 16384 });
    const p = scaleReads(1e8, { pkBytes: 8, secKeyBytes: 32, rowBytes: 200, pageBytes: 8192 });
    expect([i.hSec, i.hPk, i.innodb]).toEqual([4, 4, 8]);
    expect([p.hSecPg, p.postgres]).toEqual([4, 5]);
  });
  test("one visibility-map page covers 32,672 heap pages", () => {
    expect(VM_HEAP_PAGES_PER_PAGE).toBe(32672);
  });
});
