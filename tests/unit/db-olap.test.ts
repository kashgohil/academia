/** Correctness of the OLAP reference code: byte streams, every encoding round trip, LZ4, layouts, the executor, pruning. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  ByteWriter, ByteReader, BitWriter, BitReader, bitWidth, lz4Compress, lz4Decompress, encode, decode, encodeAll, applicable,
  ENCODINGS, runsOf, Layout, footprint, cellsOf, allRows, scanFootprint, pointFootprint, wideSchema, ORDERS,
  scanPositions, scanBitmap, filterAt, intersect, Bitmap, filterSelection, newCounters, runPlan, stepperTable, stepperAnswer,
  zoneTable, orderRows, zoneMaps, prune, morton, rangePred, ZLAYOUTS, sumOnRuns, sumDecodeThenAdd, runColumn,
  countEqDict, countEqStrings, dataset, DATASETS, type ColType, type Value, type LayoutKind, type Strategy,
} from "@/sims/db/olap";

describe("byte and bit streams", () => {
  test("varint and zigzag round trip, including values up to 2^53", () => {
    const rng = mulberry32(1);
    const xs = [0, 1, 127, 128, 300, 2 ** 31, 2 ** 40 + 7, Number.MAX_SAFE_INTEGER, ...Array.from({ length: 200 }, () => Math.floor(rng() * 2 ** 50))];
    const w = new ByteWriter();
    const small = (x: number) => x < 2 ** 52; // zigzag doubles the value, so it must stay below 2^53
    for (const x of xs) { w.varint(x); if (small(x)) { w.zigzag(-x); w.zigzag(x); } }
    const r = new ByteReader(w.done());
    for (const x of xs) { expect(r.varint()).toBe(x); if (small(x)) { expect(r.zigzag() + 0).toBe(-x + 0); expect(r.zigzag()).toBe(x); } }
  });
  test("bit width and bit-packing of any width up to 53", () => {
    expect([0, 1, 2, 3, 4, 7, 8, 255, 256].map(bitWidth)).toEqual([0, 1, 2, 2, 3, 3, 4, 8, 9]);
    const rng = mulberry32(2);
    for (let width = 0; width <= 53; width++) {
      const xs = Array.from({ length: 50 }, () => (width === 0 ? 0 : Math.floor(rng() * 2 ** width)));
      const w = new ByteWriter();
      const bw = new BitWriter(w);
      for (const x of xs) bw.write(x, width);
      bw.flush();
      expect(w.length).toBe(Math.ceil((xs.length * width) / 8));
      const br = new BitReader(new ByteReader(w.done()));
      expect(xs.map(() => br.read(width))).toEqual(xs);
    }
  });
});

describe("LZ4 block format", () => {
  test("round trip on random, repetitive and tiny inputs", () => {
    const rng = mulberry32(3);
    const inputs: Uint8Array[] = [new Uint8Array(0), new Uint8Array([1, 2, 3]), new Uint8Array(13).fill(7)];
    for (let t = 0; t < 60; t++) {
      const n = Math.floor(rng() * 5000);
      const alphabet = 1 + Math.floor(rng() * 255);
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = rng() < 0.3 && i > 8 ? b[i - 1 - Math.floor(rng() * 8)]! : Math.floor(rng() * alphabet);
      inputs.push(b);
    }
    inputs.push(new Uint8Array(100_000).fill(42));
    for (const b of inputs) expect(lz4Decompress(lz4Compress(b))).toEqual(b);
  });
  test("a long run compresses to a few bytes; the last 5 bytes are literals", () => {
    const c = lz4Compress(new Uint8Array(100_000).fill(42));
    expect(c.length).toBeLessThan(450);
    expect(lz4Compress(new Uint8Array(12)).length).toBe(13); // too short for a match: 1 token + 12 literals
  });
});

describe("encodings: every encoding round-trips (property test)", () => {
  const rng = mulberry32(4);
  const gens: [ColType, () => Value[]][] = [
    ["int32", () => Array.from({ length: Math.floor(rng() * 700) }, () => Math.floor(rng() * 2 ** 31) - (rng() < 0.3 ? 2 ** 30 : 0))],
    ["int32", () => { let x = Math.floor(rng() * 1000); return Array.from({ length: Math.floor(rng() * 700) }, () => (x += Math.floor(rng() * 5) - 1)); }],
    ["int32", () => Array.from({ length: Math.floor(rng() * 700) }, () => Math.floor(rng() * 4))],
    ["int32", () => { const v = Math.floor(rng() * 9); return Array.from({ length: 70_000 }, () => v); }], // a run longer than 65,535
    ["int64", () => { let t = 1.7e12; return Array.from({ length: Math.floor(rng() * 700) }, () => (t += Math.floor(rng() * 2000))); }],
    ["int64", () => Array.from({ length: Math.floor(rng() * 300) }, () => Math.floor((rng() - 0.5) * 2 ** 52))],
    ["float64", () => Array.from({ length: Math.floor(rng() * 500) }, () => (rng() < 0.2 ? 0.5 : (rng() - 0.5) * 1e6))],
    ["string", () => Array.from({ length: Math.floor(rng() * 500) }, () => ["", "a", "DE", "Zürich", "longer string value"][Math.floor(rng() * 5)]!)],
  ];
  for (let g = 0; g < gens.length; g++) {
    test(`generator ${g} (${gens[g]![0]})`, () => {
      const [type, gen] = gens[g]!;
      for (let t = 0; t < (g === 3 ? 1 : 12); t++) {
        const values = gen();
        for (const e of ENCODINGS) {
          if (!applicable(type, values, e)) continue;
          expect(decode(type, encode(type, values, e)), `${e}`).toEqual(values);
        }
      }
    });
  }
  test("the lab data sets round-trip with every applicable encoding", () => {
    for (const d of DATASETS) {
      const ds = dataset(d);
      const res = encodeAll(ds.type, ds.values);
      for (const r of res) expect(decode(ds.type, encode(ds.type, ds.values, r.encoding))).toEqual(ds.values);
    }
  });
  test("applicability: FOR, delta and bit-packing only for integers; bit-packing only for non-negative ones", () => {
    expect(applicable("float64", [1.5], "for")).toBe(false);
    expect(applicable("string", ["x"], "delta")).toBe(false);
    expect(applicable("int32", [-1, 2], "bitpack")).toBe(false);
    expect(applicable("int32", [1, 2], "bitpack")).toBe(true);
  });
});

describe("operations on compressed data", () => {
  test("SUM on runs equals SUM after decoding, for any run length", () => {
    for (const m of [1, 2, 5, 8, 33, 64]) {
      const col = runColumn(1000, m, m);
      const runs = runsOf(col);
      expect(sumOnRuns(runs).result).toBe(col.reduce((a, b) => a + b, 0));
      expect(sumDecodeThenAdd(runs).result).toBe(sumOnRuns(runs).result);
      expect(sumOnRuns(runs).ops).toBe(2 * runs.length);
    }
  });
  test("dictionary and string predicates count the same rows", () => {
    const c = dataset("countries").values as string[];
    for (const n of ["DE", "US", "FR", "GB", "JP", "IN", "BR", "NL", "XX"]) expect(countEqDict(c, n).count).toBe(countEqStrings(c, n).count);
  });
});

describe("layouts", () => {
  test("every cell has its own bytes inside its page, in every layout", () => {
    for (const kind of ["nsm", "dsm", "pax"] as LayoutKind[]) for (const page of [128, 256, 512]) for (const rows of [1, 7, 32, 33]) {
      const L = new Layout(kind, ORDERS, rows, page);
      const seen = new Set<string>();
      for (let r = 0; r < rows; r++) for (let c = 0; c < ORDERS.length; c++) {
        const p = L.place(r, c);
        expect(p.page).toBeLessThan(L.pageCount);
        expect(p.offset + p.bytes).toBeLessThanOrEqual(page);
        for (let b = 0; b < p.bytes; b++) { const k = `${p.page}:${p.offset + b}`; expect(seen.has(k)).toBe(false); seen.add(k); }
      }
      let cells = 0;
      for (let pg = 0; pg < L.pageCount; pg++) cells += L.cellsOfPage(pg).length;
      expect(cells).toBe(rows * ORDERS.length);
    }
  });
  test("the closed-form scan matches the exact footprint", () => {
    const S = wideSchema(13, 8);
    for (const kind of ["nsm", "dsm", "pax"] as LayoutKind[]) for (const cols of [[0], [2, 3, 7], [...Array(13).keys()]]) {
      const rows = 1000;
      const exact = footprint(new Layout(kind, S, rows, 1024), cellsOf(allRows(rows), cols));
      const fast = scanFootprint(kind, S, rows, 1024, cols);
      expect([fast.pages, fast.lines, fast.usefulBytes]).toEqual([exact.pages, exact.lines, exact.usefulBytes]);
    }
  });
  test("a point fetch reads one page in NSM and PAX, one page per column in DSM", () => {
    const S = wideSchema(10);
    expect(pointFootprint("nsm", S, 1e6, 8192, [...Array(10).keys()]).pages).toBe(1);
    expect(pointFootprint("pax", S, 1e6, 8192, [...Array(10).keys()]).pages).toBe(1);
    expect(pointFootprint("dsm", S, 1e6, 8192, [...Array(10).keys()]).pages).toBe(10);
  });
});

describe("columnar executor", () => {
  test("position lists, bitmaps and selection vectors agree", () => {
    const rng = mulberry32(9);
    const a = Array.from({ length: 300 }, () => Math.floor(rng() * 100));
    const b = Array.from({ length: 300 }, () => Math.floor(rng() * 100));
    const c = newCounters();
    const p1 = scanPositions(a, (v) => v < 40, c);
    const p2 = scanPositions(b, (v) => v > 70, c);
    const viaList = intersect(p1, p2);
    const viaPipe = filterAt(b, p1, (v) => v > 70, c);
    const viaBits = scanBitmap(a, (v) => v < 40, c).and(scanBitmap(b, (v) => v > 70, c)).positions();
    const viaSel = filterSelection(b, filterSelection(a, null, (v) => v < 40, c), (v) => v > 70, c);
    const direct = a.map((_, i) => i).filter((i) => a[i]! < 40 && b[i]! > 70);
    for (const x of [viaList, viaPipe, viaBits, viaSel]) expect(x).toEqual(direct);
    const bm = new Bitmap(70); bm.set(0); bm.set(69); expect(bm.positions()).toEqual([0, 69]);
  });
  test("all three plans return the same rows as the direct answer, for every threshold", () => {
    const t = stepperTable();
    for (let th = 0; th <= 50; th++) {
      const want = stepperAnswer(t, th);
      for (const s of ["early", "late", "bitmap"] as Strategy[]) {
        const steps = runPlan(s, t, th);
        const last = steps.at(-1)!;
        const got = last.positions!.map((r) => [t.id[r]!, t.price[r]!]);
        expect(got, `${s} t=${th}`).toEqual(want);
      }
    }
  });
});

describe("zone maps", () => {
  test("pruning never drops a matching row (random predicates, all layouts, with and without Bloom filters)", () => {
    const rng = mulberry32(12);
    const base = zoneTable(2048, 5);
    for (const l of ZLAYOUTS) {
      const rows = orderRows(base, l);
      for (const blockRows of [16, 64, 100]) {
        const zones = zoneMaps(rows, blockRows, true);
        for (let t = 0; t < 150; t++) {
          const lo = Math.floor(rng() * 1024), w = rng() < 0.3 ? 0 : Math.floor(rng() * 400);
          const on = (["a", "b", "ab"] as const)[t % 3]!;
          const pred = w === 0 ? { b: [lo, lo] as [number, number] } : rangePred(on, lo, w / 1024);
          const r = prune(rows, zones, pred, w === 0);
          expect(r.lost).toBe(0);
          expect(r.scanned).toBeGreaterThanOrEqual(r.needed);
        }
      }
    }
  });
  test("Morton code interleaves bits, and a Z-order sort keeps every row", () => {
    expect(morton(0b11, 0b00, 2)).toBe(0b1010);
    expect(morton(0b00, 0b11, 2)).toBe(0b0101);
    expect(morton(1023, 1023)).toBe(2 ** 20 - 1);
    const base = zoneTable(500, 2);
    const z = orderRows(base, "z");
    expect(z.map((r) => `${r.a},${r.b}`).sort()).toEqual(base.map((r) => `${r.a},${r.b}`).sort());
  });
});
