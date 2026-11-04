/** Every number quoted in the four OLAP lessons. Keep in sync with src/content/lessons/databases/olap/*.mdx. */
import { describe, expect, test } from "vitest";
import {
  queryFootprint, scanFootprint, pointFootprint, wideSchema, Layout, footprint, cellsOf, allRows, ORDERS, CACHE_LINE,
  dataset, encodeAll, chooseEncoding, bitWidth, salesTable, runCounts, SORT_KEYS, sortRows, SALES_COLUMNS, encode, plainBytes,
  runColumn, runsOf, sumDecodeThenAdd, sumOnRuns, countEqDict, countEqStrings, LAB_ROWS,
  stepperTable, runPlan, earlyCost, lateCost, crossover, COST,
  buildLayouts, prune, rangePred, avgScanned, unsortedSkipChance, brinRanges, DOMAIN, BLOCK_ROWS, ZONE_ROWS, BRIN_PAGES_PER_RANGE,
  type DatasetName, type CostParams,
} from "@/sims/db/olap";

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

describe("column stores", () => {
  test("visualizer, 32 rows of 32 bytes, 128-byte pages: SUM(price)", () => {
    expect(ORDERS.reduce((s, c) => s + c.bytes, 0)).toBe(32);
    expect(CACHE_LINE / 32).toBe(2); // two rows per line
    const nsm = queryFootprint("nsm", "sum", 32, 128), dsm = queryFootprint("dsm", "sum", 32, 128), pax = queryFootprint("pax", "sum", 32, 128);
    expect([nsm.pages, nsm.lines, nsm.usefulBytes, nsm.diskBytes]).toEqual([8, 16, 256, 1024]);
    expect(nsm.usefulBytes / nsm.diskBytes).toBe(0.25);
    expect([dsm.pages, dsm.lines, dsm.usefulBytes / dsm.diskBytes]).toEqual([2, 4, 1]);
    expect([pax.pages, pax.lines]).toEqual([8, 8]);
  });
  test("visualizer: one row and insert cost 1 page in NSM and 7 pages in DSM", () => {
    for (const q of ["point", "insert"] as const) {
      const n = queryFootprint("nsm", q, 32, 128), d = queryFootprint("dsm", q, 32, 128);
      expect([n.pages, n.lines, d.pages]).toEqual([1, 1, 7]);
    }
  });
  test("100 columns × 8 B, 100 M rows, 8 KiB pages: 81.92 GB vs 2.4 GB, about 34×", () => {
    const S = wideSchema(100);
    expect(Math.floor(8192 / 800)).toBe(10);
    const all = Array.from({ length: 100 }, (_, i) => i);
    for (const k of [1, 3, 50, 100]) expect(scanFootprint("nsm", S, 1e8, 8192, all.slice(0, k)).diskBytes / 1e9).toBe(81.92);
    const d3 = scanFootprint("dsm", S, 1e8, 8192, [0, 1, 2]).diskBytes / 1e9;
    expect(r1(d3)).toBe(2.4);
    expect(Math.round(81.92 / d3)).toBe(34);
    expect(r1(scanFootprint("dsm", S, 1e8, 8192, all).diskBytes / 1e9)).toBe(80);
  });
  test("memory traffic for one column: NSM 6.4 GB, DSM 0.8 GB, PAX 1.28 GB", () => {
    const S = wideSchema(100);
    expect(scanFootprint("nsm", S, 1e8, 8192, [0]).memoryBytes / 1e9).toBe(6.4);
    expect(scanFootprint("dsm", S, 1e8, 8192, [0]).memoryBytes / 1e9).toBe(0.8);
    expect(scanFootprint("pax", S, 1e8, 8192, [0]).memoryBytes / 1e9).toBe(1.28);
  });
  test("fetch one 100-column row: NSM 1 page, DSM 100 pages", () => {
    const S = wideSchema(100), all = Array.from({ length: 100 }, (_, i) => i);
    expect(pointFootprint("nsm", S, 1e8, 8192, all, 12_345).pages).toBe(1);
    expect(pointFootprint("dsm", S, 1e8, 8192, all, 12_345).pages).toBe(100);
  });
  test("3D block, 8 × 64 values, 64 per page: SUM(c3) lifts 8 NSM pages or 1 DSM page; row 21 lifts 8 DSM pages or 1 NSM page", () => {
    const S = wideSchema(8), rows = allRows(64), cols = Array.from({ length: 8 }, (_, i) => i);
    const f = (k: "nsm" | "dsm", r: number[], c: number[]) => footprint(new Layout(k, S, 64, 512), cellsOf(r, c)).pages;
    expect([f("nsm", rows, [3]), f("dsm", rows, [3]), f("dsm", [21], cols), f("nsm", [21], cols)]).toEqual([8, 1, 8, 1]);
    expect(new Layout("nsm", S, 64, 512).pageCount).toBe(8);
  });
});

describe("compression", () => {
  const res = (name: DatasetName) => { const d = dataset(name); return Object.fromEntries(encodeAll(d.type, d.values).map((r) => [r.encoding, r])); };
  test("bit widths: 8 codes need 3 bits, offsets up to 400 need 9 bits, deltas 1..4 after the minimum need 2 bits", () => {
    expect([bitWidth(7), bitWidth(400), bitWidth(3)]).toEqual([3, 9, 2]);
  });
  test("sorted IDs: delta 1,093 B of 16,386 (15.0×), FOR 3.46× with 9 bits, RLE and dictionary larger than plain", () => {
    expect(LAB_ROWS).toBe(4096);
    const r = res("ids");
    expect([r.plain!.bytes, r.delta!.bytes]).toEqual([16386, 1093]);
    expect(r1(r.delta!.ratio)).toBe(15);
    expect(r2(r.for!.ratio)).toBe(3.46);
    expect(r.for!.preview).toContain("9 bits");
    expect(r.delta!.preview).toContain("min 1, 2 bits");
    expect(r.rle!.ratio).toBeLessThan(1);
    expect(r.dict!.ratio).toBeLessThan(1);
    expect(chooseEncoding("int32", dataset("ids").values).encoding).toBe("delta");
  });
  test("timestamps: delta 7.80×", () => {
    const r = res("timestamps");
    expect(r2(r.delta!.ratio)).toBe(7.8);
    expect(chooseEncoding("int64", dataset("timestamps").values).encoding).toBe("delta");
  });
  test("sorted dates: 30 runs, RLE 90.0×, LZ4 64.3×", () => {
    const r = res("days");
    expect(runsOf(dataset("days").values).length).toBe(30);
    expect(r1(r.rle!.ratio)).toBe(90);
    expect(r1(r.lz4!.ratio)).toBe(64.3);
    expect(chooseEncoding("int32", dataset("days").values).encoding).toBe("rle");
  });
  test("countries: 3-bit codes, dictionary 15.5×, LZ4 2.45×", () => {
    const r = res("countries");
    expect(r.dict!.preview).toContain("3-bit codes");
    expect(r1(r.dict!.ratio)).toBe(15.5);
    expect(r2(r.lz4!.ratio)).toBe(2.45);
    expect(chooseEncoding("string", dataset("countries").values).encoding).toBe("dict");
  });
  test("random floats: LZ4 1.14×, every lightweight encoding is plain size or larger, the analyzer keeps plain", () => {
    const r = res("prices");
    expect(r2(r.lz4!.ratio)).toBe(1.14);
    for (const e of ["rle", "dict"]) expect(r[e]!.ratio).toBeLessThanOrEqual(1);
    expect(chooseEncoding("float64", dataset("prices").values).encoding).toBe("plain");
  });
  test("sort order: status 1,363 runs unsorted; region, country → 4 and 17; low-cardinality key → 24%; unsorted RLE saves 6%", () => {
    const t = salesTable();
    const key = (id: string) => SORT_KEYS.find((k) => k.id === id)!.key;
    expect(runCounts(t, []).status).toBe(1363);
    const rc = runCounts(t, key("region"));
    expect([rc.region, rc.country]).toEqual([4, 17]);
    const size = (k: string[]) => {
      const s = sortRows(t, k as never);
      let rle = 0, plain = 0;
      for (const c of SALES_COLUMNS) {
        const v = s.map((r) => r[c]);
        const type = typeof v[0] === "number" ? "int32" : "string";
        rle += encode(type, v, "rle").bytes.length;
        plain += plainBytes(type, v).length;
      }
      return rle / plain;
    };
    expect(Math.round(100 * (1 - size([])))).toBe(6);
    expect(Math.round(100 * size(key("low")))).toBe(24);
    expect(new Set(t.map((r) => r.customer)).size).toBeLessThanOrEqual(1000);
    expect(new Set(t.map((r) => r.country)).size).toBe(17);
  });
  test("SUM on runs: mean run 8 → 29 runs, 58 vs 512 operations (about 9×); mean 1 → 512; mean 64 → 7 runs, 14 operations", () => {
    const runs8 = runsOf(runColumn(256, 8));
    expect(runs8.length).toBe(29);
    expect([sumOnRuns(runs8).ops, sumDecodeThenAdd(runs8).ops]).toEqual([58, 512]);
    expect(Math.round(512 / 58)).toBe(9);
    expect(sumOnRuns(runsOf(runColumn(256, 1))).ops).toBe(512);
    const runs64 = runsOf(runColumn(256, 64));
    expect([runs64.length, sumOnRuns(runs64).ops]).toEqual([7, 14]);
  });
  test("country = 'FR': 4,632 byte comparisons vs 5 dictionary comparisons, code 4, then 4,096 code comparisons; 'XX' reads no codes", () => {
    const c = dataset("countries").values as string[];
    expect(countEqStrings(c, "FR").byteCompares).toBe(4632);
    const d = countEqDict(c, "FR");
    expect([d.dictCompares, d.code, d.codeCompares]).toEqual([5, 4, 4096]);
    const x = countEqDict(c, "XX");
    expect([x.count, x.codeCompares]).toEqual([0, 0]);
  });
});

describe("late materialization", () => {
  const t = stepperTable();
  const last = (s: "early" | "late" | "bitmap", th: number) => runPlan(s, t, th).at(-1)!;
  test("16 rows, 5 in EU; at t = 25 late reads 25 values, early reads and copies 64", () => {
    expect(t.id.length).toBe(16);
    expect(t.region.filter((r) => r === "EU").length).toBe(5);
    expect(last("late", 25).counters.read).toBe(25);
    expect([last("early", 25).counters.read, last("early", 25).counters.copied]).toEqual([64, 64]);
  });
  test("late plan: 5 steps, positions shrink from 5 to 2 (rows 1 and 9); early throws away 14 tuples; bitmaps read 36 in one AND word", () => {
    const steps = runPlan("late", t, 25);
    expect(steps.length).toBe(5);
    expect(steps[0]!.positions!.length).toBe(5);
    expect(steps[1]!.positions).toEqual([1, 9]);
    const e = last("early", 25);
    expect(16 - e.positions!.length).toBe(14);
    expect(last("bitmap", 25).counters.read).toBe(36);
    expect(runPlan("bitmap", t, 25)[2]!.detail).toContain("1 word operation");
  });
  test("t = 0: all 5 EU rows pass and late copies 10 values; early always reads 64 and copies 64", () => {
    const l = last("late", 0);
    expect([l.positions!.length, l.counters.copied]).toEqual([5, 10]);
    for (let th = 0; th <= 50; th += 5) expect([last("early", th).counters.read, last("early", th).counters.copied]).toEqual([64, 64]);
  });
  test("cost model: 4 outputs at 1% → late 1.78, early 13.5, 7.6×; crossover 76.9%; re-access 57.7%; 1 output none; RLE 84.6%", () => {
    expect([COST.LINE, COST.GATHER, COST.COPY, COST.RUN]).toEqual([4, 2, 1, 16]);
    const p: CostParams = { outputs: 4, reaccess: false, compressed: false };
    expect(r2(lateCost(p, 0.01))).toBe(1.78);
    expect(earlyCost(p)).toBe(13.5);
    expect(r1(earlyCost(p) / lateCost(p, 0.01))).toBe(7.6);
    expect(r1(crossover(p)! * 100)).toBe(76.9);
    expect(r1(crossover({ ...p, reaccess: true })! * 100)).toBe(57.7);
    expect(crossover({ ...p, outputs: 1 })).toBeNull();
    expect(r1(crossover({ ...p, compressed: true })! * 100)).toBe(84.6);
  });
});

describe("zone maps and data skipping", () => {
  const L = buildLayouts(21, true);
  test("table shape: 4,096 rows, 64-row blocks, 64 blocks", () => {
    expect([ZONE_ROWS, BLOCK_ROWS, L.a.zones.length]).toEqual([4096, 64, 64]);
  });
  test("BRIN on 100 GiB with 128 pages per range: 1 MiB per range, 102,400 entries", () => {
    expect(BRIN_PAGES_PER_RANGE * 8192).toBe(2 ** 20);
    expect(brinRanges(100 * 2 ** 30)).toBe(102_400);
  });
  test("demo default (start 400, 10%): sorted by A scans 7 of 64, all 7 needed; B scans 64; unsorted 64; Z-order 12, 15 and 4", () => {
    const at = (l: "unsorted" | "a" | "z", on: "a" | "b" | "ab") => prune(L[l].rows, L[l].zones, rangePred(on, 400, 0.1));
    expect([at("a", "a").scanned, at("a", "a").needed]).toEqual([7, 7]);
    expect(at("a", "b").scanned).toBe(64);
    expect([at("unsorted", "a").scanned, at("unsorted", "b").scanned]).toEqual([64, 64]);
    expect([at("z", "a").scanned, at("z", "b").scanned, at("z", "ab").scanned]).toEqual([12, 15, 4]);
  });
  test("unsorted skip chance for a 10% range in the middle, 64 rows: below 1e-18", () => {
    expect(unsortedSkipChance(400 / DOMAIN, 502 / DOMAIN)).toBeLessThan(1e-18);
    expect(unsortedSkipChance(0.45, 0.55)).toBeLessThan(1e-18);
  });
  test("sweep at 10%: A → 7.3 / 16.1 / 64.0; B → 64.0 / 19.7; A and B → Z 5.2 < sorted 7.3; at 1% on A: 1.6 vs 10.3", () => {
    const s = (l: "unsorted" | "a" | "z", on: "a" | "b" | "ab", w: number) => r1(avgScanned(L[l].zones, on, w));
    expect([s("a", "a", 0.1), s("z", "a", 0.1), s("unsorted", "a", 0.1)]).toEqual([7.3, 16.1, 64]);
    expect([s("a", "b", 0.1), s("z", "b", 0.1)]).toEqual([64, 19.7]);
    expect([s("z", "ab", 0.1), s("a", "ab", 0.1)]).toEqual([5.2, 7.3]);
    expect([s("a", "a", 0.01), s("z", "a", 0.01)]).toEqual([1.6, 10.3]);
  });
  test("B = value on unsorted rows: 61.8 blocks with min/max, 4.3 with Bloom filters, 3.8 hold a match", () => {
    let s = 0, sb = 0, nd = 0, k = 0;
    for (let v = 0; v < DOMAIN; v += 8, k++) {
      s += prune(L.unsorted.rows, L.unsorted.zones, { b: [v, v] }).scanned;
      const r = prune(L.unsorted.rows, L.unsorted.zones, { b: [v, v] }, true);
      sb += r.scanned; nd += r.needed;
      expect(r.lost).toBe(0);
    }
    expect(k).toBe(128);
    expect([r1(s / k), r1(sb / k), r1(nd / k)]).toEqual([61.8, 4.3, 3.8]);
  });
});
