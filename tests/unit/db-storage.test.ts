/**
 * Storage module (databases/storage): behaviour of the reference implementations, and every number
 * that the six lessons quote. Keep the numbers in sync with the lesson text.
 */
import { describe, expect, test } from "vitest";
import {
  HDDS, rotationMs, avgSeekMs, hddAccess, hddRun, hddIopsAtQd, ssdRead, ssdReadUs, SSD_NVME, SSD_SATA, Ftl, steadyWa, PAGE_VALID, PAGE_INVALID,
  SlottedPage, LP_DEAD, LP_NORMAL, LP_UNUSED, tuplesPerPage, maxHeapTuplesPerPage, toastThreshold, toastChunk, TOAST_POINTER, pgTupleLayout, type PgType,
  FreeSpaceMap, availToCat, needToCat, fsmStep, heapRun, HeapFile, tablePages, rowsPerPage, scanMs, PG_COSTS,
  BufferPool, BufferPoolFullError, makePolicy, mixedTrace, runTrace, type PolicyId,
  crc32c, WriteStack, SCENARIOS, runScenario, lostOnCrash, visible, tornUpdate, crashRecover, pageBytes, checkpointCost,
  btreeAmp, leveledAmp, tieredAmp, logHashAmp, sortedFileAmp, logScanAmp, lsmLevels, bloomFpr, AMP_ENV, designSpace, rumWeights, enginePresets, chain, deviceWa,
} from "@/sims/db/storage";

const r = (x: number, d = 3) => Number(x.toPrecision(d));

// =====================================================================================
// Lesson 1: Disks vs SSDs
// =====================================================================================

describe("disks vs SSDs", () => {
  const d = HDDS["7200"];
  test("random 4 KiB read on a 7,200 rpm disk: 8.77 + 4.17 + 0.02 = 12.95 ms, 77 reads/s, 0.32 MB/s", () => {
    expect(rotationMs(d)).toBeCloseTo(8.333, 3);
    expect(avgSeekMs(d)).toBeCloseTo(8.767, 3);
    const a = hddAccess(d, 4096, "random");
    expect(a.rotate).toBeCloseTo(4.167, 3);
    expect(a.transfer).toBeCloseTo(0.0205, 4);
    expect(a.total).toBeCloseTo(12.95, 2);
    expect(Math.round(a.iops)).toBe(77);
    expect(a.mbps).toBeCloseTo(0.32, 2);
    // sequential is about 630 times faster
    const s = hddAccess(d, 4096, "sequential");
    expect(s.mbps).toBe(200);
    expect(Math.round(s.mbps / a.mbps / 10) * 10).toBe(630);
  });
  test("average seek = min + (max − min) × 8/15 matches a Monte Carlo of E[sqrt|X − Y|]", () => {
    let a = 1, sum = 0;
    const rnd = () => { a = (a * 1103515245 + 12345) % 2 ** 31; return a / 2 ** 31; };
    for (let i = 0; i < 200000; i++) sum += Math.sqrt(Math.abs(rnd() - rnd()));
    expect(sum / 200000).toBeCloseTo(8 / 15, 2);
  });
  test("1 MiB random reads: 5.2 ms transfer, 58 MB/s", () => {
    const a = hddAccess(d, 2 ** 20, "random");
    expect(a.transfer).toBeCloseTo(5.24, 2);
    expect(Math.round(a.mbps)).toBe(58);
  });
  test("disk table: seeks, half turns and reads per second", () => {
    const row = (id: keyof typeof HDDS) => [r(avgSeekMs(HDDS[id])), r(rotationMs(HDDS[id]) / 2), Math.round(hddAccess(HDDS[id], 4096, "random").iops)];
    expect(row("5400")).toEqual([11.7, 5.56, 58]);
    expect(row("7200")).toEqual([8.77, 4.17, 77]);
    expect(row("10k")).toEqual([4.41, 3, 135]);
    expect(row("15k")).toEqual([3.45, 2, 183]);
  });
  test("SSD at 4 KiB, one at a time: 81 µs, 12,300 reads/s, about 160× the disk, sequential/random about 64×", () => {
    expect(Math.round(ssdReadUs(SSD_NVME, 4096))).toBe(81);
    const s1 = ssdRead(SSD_NVME, 4096, 1);
    expect(Math.round(s1.iops / 100) * 100).toBe(12300);
    expect(Math.round(s1.mbps / hddAccess(d, 4096, "random").mbps / 10) * 10).toBe(160);
    expect(Math.round(SSD_NVME.mbps / s1.mbps)).toBe(64);
  });
  test("3D demo runs: FIFO 78/s (8.6 + 4.1 ms), elevator at 8 queued 123/s (seek 4.2, rotation 3.9), nearby 171/s", () => {
    const run = (pattern: "random" | "nearby" | "sequential", sched: "fifo" | "elevator", qd: number) => hddRun(d, { n: 300, qd, sched, pattern, bytes: 4096, seed: 4 });
    const f = run("random", "fifo", 1);
    expect([Math.round(f.iops), r(f.avg.seek, 2), r(f.avg.rotate, 2)]).toEqual([78, 8.6, 4.1]);
    const e = run("random", "elevator", 8);
    expect([Math.round(e.iops), r(e.avg.seek, 2), r(e.avg.rotate, 2)]).toEqual([123, 4.2, 3.9]);
    expect(Math.round(run("nearby", "fifo", 1).iops)).toBe(171);
    const s = run("sequential", "fifo", 1);
    expect([s.avg.seek, s.avg.rotate]).toEqual([0, 0]);
  });
  test("queue depth: NVMe 251,200 at 32 and 393,600 at 256; SATA stops at 134,300; disk elevator 76 → 152", () => {
    const n = (q: number) => Math.round(ssdRead(SSD_NVME, 4096, q).iops / 100) * 100;
    expect(n(32)).toBe(251200);
    expect(n(256)).toBe(393600);
    expect(Math.round(ssdRead(SSD_SATA, 4096, 32).iops / 100) * 100).toBe(134300);
    expect(Math.round(hddIopsAtQd(d, 1))).toBe(76);
    expect(Math.round(hddIopsAtQd(d, 32))).toBe(152);
    // FIFO gains nothing from a deeper queue
    expect(Math.round(hddIopsAtQd(d, 32, "fifo"))).toBe(76);
  });
  test("steady-state device WA: 7.02 / 7.38 at 7%, 2.40 / 2.73 at 28%, 1.23 / 1.48 at 100%, sequential 1.00", () => {
    const row = (op: number) => [steadyWa(op, "random").toFixed(2), steadyWa(op, "hotcold").toFixed(2), steadyWa(op, "sequential").toFixed(2)];
    expect(row(0.07)).toEqual(["7.02", "7.38", "1.00"]);
    expect(row(0.28)).toEqual(["2.40", "2.73", "1.00"]);
    expect(row(1)).toEqual(["1.23", "1.48", "1.00"]);
    // FIFO victim choice copies more than greedy
    expect(steadyWa(0.07, "random", { gc: "fifo" })).toBeGreaterThan(steadyWa(0.07, "random"));
  });
  test("the FTL demo's plot (shorter warm-up) also shows 7.0 at 7% spare space", () => {
    expect(steadyWa(0.07, "random", { warm: 2, measure: 4 }).toFixed(1)).toBe("7.0");
  });
  test("greedy GC is close to the analytic estimate (1 + ρ) / (2ρ) for uniform random writes", () => {
    for (const op of [0.15, 0.28, 0.5]) expect(Math.abs(steadyWa(op, "random") / ((1 + op) / (2 * op)) - 1)).toBeLessThan(0.12);
  });
  test("FTL invariants: map and owner agree, valid counts add up, every logical page readable", () => {
    const f = new Ftl({ blocks: 32, pagesPerBlock: 16, op: 0.1 });
    let a = 7;
    for (let i = 0; i < 20000; i++) { a = (a * 48271) % 2147483647; f.write(a % f.logical); }
    let valid = 0;
    for (let p = 0; p < f.physical; p++) if (f.state[p] === PAGE_VALID) { valid++; expect(f.map[f.owner[p]!]).toBe(p); }
    expect(valid).toBe(f.logical);
    for (let b = 0; b < f.blocks; b++) {
      let v = 0;
      for (let i = 0; i < f.ppb; i++) if (f.state[b * f.ppb + i] === PAGE_VALID) v++;
      expect(f.valid[b]).toBe(v);
    }
    expect(f.state.some((s) => s === PAGE_INVALID)).toBe(true);
    expect(f.wa).toBeGreaterThan(1);
  });
  test("the 7% spare space comes from GB vs GiB", () => {
    expect(Math.round((2 ** 30 / 1e9 - 1) * 100)).toBe(7);
  });
});

// =====================================================================================
// Lesson 2: Pages and slotted records
// =====================================================================================

const rec = (n: number, c: number) => new Uint8Array(n).fill(c);

describe("slotted page", () => {
  test("insert lays out slots from the front and tuples from the back", () => {
    const p = new SlottedPage(512);
    expect(p.insert(rec(40, 1))).toBe(0);
    expect(p.insert(rec(24, 2))).toBe(1);
    expect(p.insert(rec(56, 3))).toBe(2);
    expect([p.lower, p.upper, p.freeContiguous]).toEqual([36, 392, 356]);
    expect(p.slots().map((s) => s.off)).toEqual([472, 448, 392]);
    expect(p.read(1)).toEqual(rec(24, 2));
  });
  test("delete + compact keeps record IDs and bytes; the dead slot is reused", () => {
    const p = new SlottedPage(512);
    for (const [n, c] of [[40, 1], [24, 2], [56, 3], [32, 4], [16, 5]] as const) p.insert(rec(n, c));
    p.delete(1);
    expect(p.slot(1).flags).toBe(LP_DEAD);
    expect(p.garbage).toBe(24);
    const moved = p.compact();
    expect(moved).toBeGreaterThan(0);
    expect(p.garbage).toBe(0);
    expect(p.slot(1).flags).toBe(LP_UNUSED);
    for (const [s, n, c] of [[0, 40, 1], [2, 56, 3], [3, 32, 4], [4, 16, 5]] as const) expect(p.read(s)).toEqual(rec(n, c));
    expect(p.insert(rec(8, 9))).toBe(1);
  });
  test("insert compacts automatically when deleted space makes room, and fails when nothing does", () => {
    const p = new SlottedPage(256);
    const ids: number[] = [];
    for (;;) { const s = p.insert(rec(40, ids.length)); if (s === null) break; ids.push(s); }
    expect(ids.length).toBe(5); // (256 - 24) / (40 + 4) = 5.27
    p.delete(2);
    expect(p.insert(rec(40, 99))).toBe(2);
    expect(p.read(2)).toEqual(rec(40, 99));
    expect(p.insert(rec(40, 100))).toBeNull();
  });
  test("update: in place, moved, compacted, no room — and the slot never changes", () => {
    const p = new SlottedPage(256);
    p.insert(rec(40, 1)); p.insert(rec(40, 2)); p.insert(rec(40, 3));
    expect(p.update(1, rec(36, 7))).toBe("in-place");
    expect(p.update(1, rec(64, 7))).toBe("moved");
    p.insert(rec(40, 4));
    expect(p.update(0, rec(48, 8))).toBe("compacted");
    expect(p.read(0)).toEqual(rec(48, 8));
    expect(p.read(1)).toEqual(rec(64, 7));
    expect(p.update(2, rec(200, 9))).toBe("no-room");
    expect(p.slot(2).flags).toBe(LP_NORMAL);
  });
  test("line pointer encoding: 15-bit offset, 2-bit flags, 15-bit length", () => {
    const p = new SlottedPage(32768);
    const s = p.insert(rec(100, 1))!;
    const w = new DataView(p.bytes.buffer).getUint32(24 + 4 * s, true);
    expect(w & 0x7fff).toBe(32768 - 104);
    expect((w >>> 15) & 3).toBe(LP_NORMAL);
    expect(w >>> 17).toBe(100);
    expect(() => new SlottedPage(65536)).toThrow();
  });
});

describe("pages and slotted records: quoted numbers", () => {
  const cols = (t: PgType[]) => t.map((type, i) => ({ name: `c${i}`, type }));
  test("MaxHeapTuplesPerPage = 291; two int4 columns: 32 B tuple, 36 B on the page, 226 per page", () => {
    expect(maxHeapTuplesPerPage()).toBe(291);
    const l = pgTupleLayout(cols(["int4", "int4"]));
    expect([l.len, l.onPage]).toEqual([32, 36]);
    expect(tuplesPerPage(32)).toBe(226);
    expect(pgTupleLayout([]).len).toBe(24); // t_hoff is MAXALIGNed even with no data
  });
  test("column order: 72 B / 76 B / 21 B padding / 107 per page vs 52 / 60 / 1 / 136, saving 16 B (21%)", () => {
    const bad = pgTupleLayout(cols(["bool", "int8", "bool", "int8", "int2", "timestamptz"]));
    const good = pgTupleLayout(cols(["int8", "int8", "timestamptz", "int2", "bool", "bool"]));
    expect([bad.len, bad.onPage, bad.padding, Math.floor(8168 / bad.onPage)]).toEqual([72, 76, 21, 107]);
    expect([good.len, good.onPage, good.padding, Math.floor(8168 / good.onPage)]).toEqual([52, 60, 1, 136]);
    expect(bad.onPage - good.onPage).toBe(16);
    expect(Math.round(((bad.onPage - good.onPage) / bad.onPage) * 100)).toBe(21);
  });
  test("null bitmap: data starts at 24 with ≤ 8 columns, at 32 with 9 columns and a NULL", () => {
    const n = (k: number) => pgTupleLayout(Array.from({ length: k }, (_, i) => ({ name: `c${i}`, type: "int4" as PgType, isNull: i === 1 }))).hoff;
    expect(n(8)).toBe(24);
    expect(n(9)).toBe(32);
    const bad = pgTupleLayout(cols(["bool", "int8"]).map((c, i) => ({ ...c, isNull: i === 1 })));
    expect(bad.hoff).toBe(24);
  });
  test("short text (≤ 126 B) has a 1-byte header and no alignment; longer text a 4-byte header", () => {
    const l = (n: number) => pgTupleLayout([{ name: "a", type: "int8" }, { name: "b", type: "text", textLen: n }, { name: "c", type: "int4" }]);
    const s = l(20).segments.find((x) => x.kind === "varhdr")!;
    expect([s.start, s.len]).toEqual([32, 1]);
    expect(l(126).segments.find((x) => x.kind === "varhdr")!.len).toBe(1);
    expect(l(127).segments.find((x) => x.kind === "varhdr")!.len).toBe(4);
  });
  test("TOAST: threshold 2,032, chunks of 1,996, 18-byte pointer; text of 2,000 is toasted, 1,990 is not", () => {
    expect(toastThreshold()).toBe(2032);
    expect(toastChunk()).toBe(1996);
    expect(TOAST_POINTER).toBe(18);
    const l = (n: number) => pgTupleLayout([{ name: "a", type: "int8" }, { name: "b", type: "text", textLen: n }, { name: "c", type: "int4" }]);
    expect(l(1990).toasted).toEqual([]);
    expect(l(2000).toasted).toEqual([{ col: 1, chunks: 2 }]);
    expect(l(3000).segments.some((s) => s.kind === "toast" && s.len === 18)).toBe(true);
    // 4 rows at the threshold fit one page: 24 + 4 × (2032 + 4) ≤ 8192
    expect(24 + 4 * (toastThreshold() + 4)).toBeLessThanOrEqual(8192);
  });
});

// =====================================================================================
// Lesson 3: Heap files and free-space maps
// =====================================================================================

describe("heap files", () => {
  const run = (strategy: "append" | "first-fit" | "fsm", vacuum: boolean) =>
    heapRun({ strategy, initial: 3000, deleteFrac: 0.3, vacuum, inserts: 900, rowBytes: [60, 200] });
  test("load fills 51 pages; first-fit after VACUUM reads 24.9 pages per insert, worst 51", () => {
    const f = run("first-fit", true);
    expect(f.pagesAfterLoad).toBe(51);
    expect(f.avgProbes.toFixed(1)).toBe("24.9");
    expect(f.maxProbes).toBe(51);
    expect(f.pagesAfter).toBe(51);
  });
  test("FSM after VACUUM: 1.07 pages per insert, no growth; append only grows to 66", () => {
    const f = run("fsm", true);
    expect(f.avgProbes.toFixed(2)).toBe("1.07");
    expect(f.pagesAfter).toBe(51);
    const a = run("append", true);
    expect(a.avgProbes).toBe(1);
    expect(a.pagesAfter).toBe(66);
  });
  test("without VACUUM, dead space is not free: FSM grows to 66, first-fit reads 58 pages per insert", () => {
    expect(run("fsm", false).pagesAfter).toBe(66);
    const f = run("first-fit", false);
    expect(Math.round(f.avgProbes)).toBe(58);
    expect(f.pagesAfter).toBe(66);
  });
  test("FSM categories: 32 bytes each, 8,160 free → 255, 2,400 needed → 75, 8,000 → 250", () => {
    expect(fsmStep()).toBe(32);
    expect(availToCat(8160)).toBe(255);
    expect(needToCat(2400)).toBe(75);
    expect(needToCat(8000)).toBe(250);
    // conservative: a page offered for a request always fits it
    for (let free = 0; free < 8192; free += 7) for (const need of [33, 100, 2400]) if (availToCat(free) >= needToCat(need)) expect(free).toBeGreaterThanOrEqual(need);
  });
  test("FSM max-tree search returns the leftmost page with room, reading one node per level", () => {
    const fsm = new FreeSpaceMap(8192, 16);
    [180, 40, 0, 230, 90, 12, 64, 0, 150, 255, 30, 0, 75, 120, 5, 200].forEach((c, i) => fsm.set(i, c));
    expect(fsm.search(75)).toBe(0);
    expect(fsm.lastVisits).toBe(5);
    expect(fsm.search(200)).toBe(3);
    expect(fsm.search(250)).toBe(9);
    expect(fsm.search(256)).toBe(-1);
    fsm.set(40, 255); // grows
    expect(fsm.search(255)).toBe(9);
  });
  test("fill factor reserves space for updates", () => {
    const h = new HeapFile({ fillFactor: 70 });
    for (let i = 0; i < 1000; i++) h.insert(100);
    for (let p = 0; p < h.pages.length - 1; p++) expect(h.free(p)).toBeGreaterThanOrEqual(h.reserve);
  });
  test("scan of 1M rows of 100 B: 75 rows/page, 13,334 pages, 104 MiB, 546 ms at 200 MB/s, 34 ms at 3,200 MB/s, cost 23,334", () => {
    const t = tablePages({ liveRows: 1e6, rowBytes: 100, deadFrac: 0, fillFactor: 100 });
    expect([t.rowsPerPage, t.pages, Math.round(t.cost)]).toEqual([75, 13334, 23334]);
    expect(Math.round(t.bytes / 2 ** 20)).toBe(104);
    expect(Math.round(scanMs(t.bytes, 200))).toBe(546);
    expect(Math.round(scanMs(t.bytes, 3200))).toBe(34);
    expect(PG_COSTS).toEqual({ seq_page_cost: 1, random_page_cost: 4, cpu_tuple_cost: 0.01, cpu_operator_cost: 0.0025 });
  });
  test("50% dead versions double pages and cost; fill factor 70% gives 52 rows/page and 19,231 pages (+44%)", () => {
    const base = tablePages({ liveRows: 1e6, rowBytes: 100, deadFrac: 0, fillFactor: 100 });
    const dead = tablePages({ liveRows: 1e6, rowBytes: 100, deadFrac: 0.5, fillFactor: 100 });
    expect(dead.pages / base.pages).toBeCloseTo(2, 3);
    expect(dead.cost / base.cost).toBeCloseTo(2, 3);
    const ff = tablePages({ liveRows: 1e6, rowBytes: 100, deadFrac: 0, fillFactor: 70 });
    expect([rowsPerPage(100, 70), ff.pages]).toEqual([52, 19231]);
    expect(Math.round((ff.pages / base.pages - 1) * 100)).toBe(44);
  });
  test("40-byte rows: 185 per page, 5,406 pages; the row part of the cost (10,000) is larger than the page part", () => {
    const t = tablePages({ liveRows: 1e6, rowBytes: 40, deadFrac: 0, fillFactor: 100 });
    expect([t.rowsPerPage, t.pages]).toEqual([185, 5406]);
    expect(1e6 * PG_COSTS.cpu_tuple_cost).toBe(10000);
  });
});

// =====================================================================================
// Lesson 4: Buffer pools
// =====================================================================================

describe("buffer pool", () => {
  test("pins protect frames; a dirty victim is written back; all pinned → error", () => {
    const writes: number[] = [];
    const bp = new BufferPool(4, "lru", { read: () => {}, write: (p) => writes.push(p) });
    bp.fetch(1); bp.fetch(2); bp.fetch(3); // pinned
    bp.fetch(4); bp.unpin(4, true); // dirty, unpinned
    const r = bp.fetch(5);
    expect(r.hit).toBe(false);
    expect(r.evicted).toEqual({ page: 4, dirty: true });
    expect(writes).toEqual([4]);
    expect(() => bp.fetch(6)).toThrow(BufferPoolFullError);
    bp.unpin(1);
    expect(bp.fetch(6).evicted?.page).toBe(1);
  });
  test("LRU evicts the page used longest ago (stepper, steps 1–2)", () => {
    const bp = new BufferPool(4, "lru");
    for (const p of [1, 2, 3, 4, 2]) bp.access(p);
    expect(bp.access(5).evicted?.page).toBe(1);
  });
  test("Clock gives a second chance and clears bits when the hand wraps", () => {
    const bp = new BufferPool(3, "clock");
    for (const p of [1, 2, 3]) bp.access(p);
    expect(bp.access(4).evicted?.page).toBe(1); // all bits set: full sweep, then frame 0
    bp.access(2); // set the bit of page 2 again
    expect(bp.access(5).evicted?.page).toBe(3); // hand at frame 1 (page 2, bit 1): skip, take page 3
  });
  test("a scan of 8 pages flushes LRU's 4 hot pages; midpoint keeps them", () => {
    for (const [pol, kept] of [["lru", 0], ["midpoint", 3]] as const) {
      const bp = new BufferPool(4, pol);
      for (let k = 0; k < 3; k++) for (const p of [1, 2, 3, 4]) bp.access(p);
      for (let p = 10; p <= 17; p++) bp.access(p, { scan: true });
      expect([1, 2, 3, 4].filter((p) => bp.table.has(p)).length, pol).toBe(kept);
    }
  });
  test("every policy: victims are never pinned, and the page table stays consistent", () => {
    for (const pol of ["lru", "clock", "lru2", "2q", "midpoint", "pg"] as PolicyId[]) {
      const bp = new BufferPool(8, pol);
      let a = 3;
      for (let i = 0; i < 3000; i++) {
        a = (a * 48271) % 2147483647;
        const page = a % 40;
        const pinned = bp.frames.filter((f) => f.pins > 0).map((f) => f.page);
        const res = bp.fetch(page, { scan: a % 7 === 0 });
        if (res.evicted) expect(pinned, pol).not.toContain(res.evicted.page);
        if (a % 5 === 0 && pinned.length < 4) continue; // keep a few pinned
        bp.unpin(page, a % 3 === 0);
        for (const f of bp.frames) if (f.pins > 0 && a % 11 === 0) bp.unpin(f.page);
      }
      for (const [p, f] of bp.table) expect(bp.frames[f]!.page, pol).toBe(p);
      expect(makePolicy(pol, 8).id).toBe(pol);
    }
  });
  /** Same workload as the PolicyRaceDemo. */
  const race = (touches: number, window: boolean, scan = 400) => {
    const tr = mixedTrace({ hot: 100, hotAccesses: 20000, scanPages: scan, scanEvery: 1000, touches, coldFrac: 0.1, coldPages: 5000 });
    return (pol: PolicyId, frames: number) => runTrace(tr, frames, pol, window ? { oldTime: 50, crp: 50 } : { oldTime: 0, crp: 0 }).hotHitRate;
  };
  test("policy race at 150 frames, 4 rows per scanned page: LRU 88.5%, Clock 86.5%, LRU-2 78.0%, 2Q 100%, Midpoint 83.7%, PG 100%", () => {
    const at = race(4, false);
    expect((at("lru", 150) * 100).toFixed(1)).toBe("88.5");
    expect((at("clock", 150) * 100).toFixed(1)).toBe("86.5");
    expect((at("lru2", 150) * 100).toFixed(1)).toBe("78.0");
    expect((at("2q", 150) * 100).toFixed(1)).toBe("100.0");
    expect((at("midpoint", 150) * 100).toFixed(1)).toBe("83.7");
    expect((at("pg", 150) * 100).toFixed(1)).toBe("100.0");
  });
  test("with the repeat window: Midpoint 99.3%, LRU-2 100%; with 1 row per page and no window they also recover", () => {
    const w = race(4, true);
    expect((w("midpoint", 150) * 100).toFixed(1)).toBe("99.3");
    expect((w("lru2", 150) * 100).toFixed(1)).toBe("100.0");
    const one = race(1, false);
    expect(one("lru2", 150)).toBeGreaterThan(0.99);
    expect(one("midpoint", 150)).toBeGreaterThan(0.99);
  });
  test("2Q falls to 89.7% at 200 frames; without scans LRU gets 98.9% at 150", () => {
    expect((race(4, false)("2q", 200) * 100).toFixed(1)).toBe("89.7");
    expect((race(1, false, 0)("lru", 150) * 100).toFixed(1)).toBe("98.9");
  });
});

// =====================================================================================
// Lesson 5: Durability
// =====================================================================================

describe("durability", () => {
  test("CRC-32C test vector: 0xE3069283", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });
  test("a torn page fails its checksum; a whole page passes", () => {
    const torn = pageBytes([2, 1], 4096), whole = pageBytes([2, 2], 4096), old = pageBytes([1, 1], 4096);
    expect(torn.stored).not.toBe(torn.computed);
    expect(whole.stored).toBe(whole.computed);
    expect(old.stored).toBe(old.computed);
  });
  const sc = (id: string) => SCENARIOS.find((s) => s.id === id)!;
  test("write + fsync: durable after fsync with an honest drive, lost with a lying drive, fine with PLP", () => {
    const f = runScenario(sc("fsync"), "flush");
    expect(visible(f.frames[2]!.media).get("a.db#0")).toBe("v1");
    expect(visible(f.frames[3]!.media).get("a.db#0")).toBe("v2");
    expect(lostOnCrash(f.frames[3]!)).toEqual([]);
    expect(lostOnCrash(runScenario(sc("fsync"), "lies").frames[3]!)).toEqual(["a.db#0", "a.db#1"]);
    expect(lostOnCrash(runScenario(sc("fsync"), "plp").frames[3]!)).toEqual([]);
  });
  test("new file without directory fsync: the data is on media, but the file is missing", () => {
    const f = runScenario(sc("newfile"), "flush").frames[3]!;
    expect(f.media.get("b.log#0")).toBe("v1");
    expect(visible(f.media).size).toBe(0);
    expect(lostOnCrash(f)).toEqual(["b.log#0"]);
  });
  test("atomic replace: every crash point shows the old or the new config", () => {
    const r = runScenario(sc("replace"), "flush");
    const seen = r.frames.map((f) => visible(f.media).get("cfg#0"));
    expect(seen).toEqual(["v1", "v1", "v1", "v1", "v1", "v2"]);
    expect(lostOnCrash(r.frames.at(-1)!)).toEqual([]);
  });
  test("fsyncgate: EIO once, then ok, and block 1 is lost; PANIC loses nothing the program trusted", () => {
    const r = runScenario(sc("fsyncgate"), "flush");
    expect(r.frames.map((f) => f.result?.ret ?? "")).toEqual(["", "", "", "", "", "EIO", "ok"]);
    expect(lostOnCrash(r.frames[5]!)).toEqual([]);
    expect(lostOnCrash(r.frames[6]!)).toEqual(["a.db#1"]);
    // the page cache still shows v2: reads look fine
    expect(r.frames[6]!.cache.get("a.db#1")).toBe("v2");
    const p = runScenario(sc("panic"), "flush");
    expect(p.frames.at(-1)!.result!.ret).toBe("PANIC");
    expect(lostOnCrash(p.frames.at(-1)!)).toEqual([]);
  });
  test("WriteStack: write() alone puts nothing on media; writeback without a flush leaves data in the drive cache", () => {
    const s = new WriteStack("flush", { "dir:x": "entry", "x#0": "v1" });
    s.apply({ kind: "write", key: "x#0", value: "v2" });
    expect(s.media.get("x#0")).toBe("v1");
    s.apply({ kind: "writeback" });
    expect(s.device.get("x#0")).toBe("v2");
    expect(s.crash().get("x#0")).toBe("v1");
  });
  test("torn page outcomes (8 KiB / 4 KiB, in order): none → silent, checksum → detected, doublewrite and FPW always recover", () => {
    const out = (p: "none" | "checksum" | "doublewrite" | "fpw") => { const st = tornUpdate(p, 2); return Array.from({ length: st.length + 1 }, (_, k) => crashRecover(p, st, k, 2).outcome); };
    expect(out("none")).toEqual(["ok-old", "ok-new", "silent", "ok-new", "ok-new"]);
    expect(out("checksum")).toEqual(["ok-old", "ok-new", "detected", "ok-new", "ok-new"]);
    expect(out("doublewrite").every((o) => o.startsWith("ok"))).toBe(true);
    expect(out("fpw").every((o) => o.startsWith("ok"))).toBe(true);
    // doublewrite step 5 = first in-place sector: the page is torn, and the doublewrite copy is complete
    const st = tornUpdate("doublewrite", 2);
    const r = crashRecover("doublewrite", st, 5, 2);
    expect([r.torn, r.state.dw, r.state.dwSynced, r.outcome]).toEqual([true, 2, true, "ok-new"]);
  });
  test("with 512-byte sectors, only full-page images and doublewrite repair every torn state", () => {
    for (const order of ["in-order", "reverse", "shuffled"] as const) {
      for (const p of ["doublewrite", "fpw"] as const) { const st = tornUpdate(p, 16, order); for (let k = 0; k <= st.length; k++) expect(crashRecover(p, st, k, 16).outcome.startsWith("ok")).toBe(true); }
      const st = tornUpdate("checksum", 16, order);
      expect(Array.from({ length: st.length + 1 }, (_, k) => crashRecover("checksum", st, k, 16).outcome).filter((o) => o === "detected").length).toBe(15);
    }
  });
  test("checkpoint cost: 63,212 pages; WAL 9.54 MiB → 503 MiB (52.8×); 5,278 → 10,457 B per update", () => {
    const c = checkpointCost({ tablePages: 1e5, updates: 1e5, recordBytes: 100, pageBytes: 8192 });
    expect(Math.round(c.distinct)).toBe(63212);
    expect((c.walPlain / 2 ** 20).toFixed(2)).toBe("9.54");
    expect(Math.round(c.walFpw / 2 ** 20)).toBe(503);
    expect((c.walFpw / c.walPlain).toFixed(1)).toBe("52.8");
    expect([Math.round(c.perUpdate.plain), Math.round(c.perUpdate.fpw), Math.round(c.perUpdate.doublewrite)]).toEqual([5278, 10457, 10457]);
    const many = checkpointCost({ tablePages: 1e5, updates: 1e7, recordBytes: 100, pageBytes: 8192 });
    expect([Math.round(many.perUpdate.plain), Math.round(many.perUpdate.fpw)]).toEqual([182, 264]);
  });
});

// =====================================================================================
// Lesson 6: Amplification
// =====================================================================================

describe("amplification", () => {
  test("B+ tree: WA 1 + 4096/100 = 41.96 ≈ 42; 6.12 with 8 updates per write; SA 1.45; WA 2 at 4 KiB records", () => {
    const b = btreeAmp();
    expect(b.wa).toBeCloseTo(41.96, 2);
    expect([b.ra, b.raRange, r(b.sa)]).toEqual([1, 4, 1.45]);
    expect(btreeAmp(AMP_ENV, { absorbed: 8 }).wa).toBeCloseTo(6.12, 2);
    expect(btreeAmp({ ...AMP_ENV, recordBytes: 4100 }).wa.toFixed(0)).toBe("2");
    expect(Math.round(Math.LN2 * 100)).toBe(69);
  });
  test("leveled T = 10: 4 levels, WA 24, SA 1.12, point 1.03 I/Os (Bloom 0.82%), range 7", () => {
    expect(lsmLevels(10)).toBe(4);
    expect((bloomFpr(10) * 100).toFixed(2)).toBe("0.82");
    const l = leveledAmp(10);
    expect([l.wa, r(l.sa), r(l.ra), l.raRange]).toEqual([24, 1.12, 1.03, 7]);
  });
  test("tiered T = 10: WA 6, SA 5.01, point 1.29, range 39; log + hash at 80%: WA 5, SA 1.43, range 100", () => {
    const t = tieredAmp(10);
    expect([t.wa, r(t.sa), r(t.ra), t.raRange]).toEqual([6, 5.01, 1.29, 39]);
    const h = logHashAmp(0.8);
    expect([r(h.wa), r(h.sa), h.ra, h.raRange]).toEqual([5, 1.43, 1, 100]);
  });
  test("extremes: sorted file (25, 28, 5e8, 1) and log without index (16,276,042, 32,552,083, 2, 1.33)", () => {
    const s = sortedFileAmp();
    expect([s.ra, s.raRange, s.wa, s.sa]).toEqual([25, 28, 5e8, 1]);
    const l = logScanAmp(0.5);
    expect([Math.round(l.ra), Math.round(l.raRange), l.wa, r(l.sa)]).toEqual([16276042, 32552083, 2, 1.33]);
  });
  test("RUM placement: weights sum to 1; leveled leans to space, tiered away from it", () => {
    for (const d of designSpace()) { const w = rumWeights(d.amp); expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 9); }
    const lv = rumWeights(leveledAmp(10)), tr = rumWeights(tieredAmp(10));
    expect(lv[2]).toBeGreaterThan(lv[0]);
    expect(tr[2]).toBeLessThan(0.05);
  });
  test("engine presets: 41.96, 24, 6, 5", () => {
    expect(enginePresets().map((e) => r(e.appWa, 4))).toEqual([41.96, 24, 6, 5]);
  });
  test("chain: B+ tree on 7% spare = 324×, 107 days, 28 TB/day; 28% spare: 2.40 and 0.86 years", () => {
    const dev = deviceWa(0.07, "random");
    expect(dev.toFixed(2)).toBe("7.02");
    const c = chain({ appWa: btreeAmp().wa, fsWa: 1.1, deviceWa: dev, userMBps: 1, capacityGB: 1000, peCycles: 3000 });
    expect(Math.round(c.total)).toBe(324);
    expect(Math.round(c.years * 365)).toBe(107);
    expect(Math.round(c.nandTBPerDay)).toBe(28);
    expect(Math.round((1 * 86400) / 1e3)).toBe(86); // 1 MB/s = 86 GB/day
    const c28 = chain({ appWa: btreeAmp().wa, fsWa: 1.1, deviceWa: deviceWa(0.28, "random"), userMBps: 1, capacityGB: 1000, peCycles: 3000 });
    expect(deviceWa(0.28, "random").toFixed(2)).toBe("2.40");
    expect(c28.years.toFixed(2)).toBe("0.86");
  });
  test("chain: leveled 26.4× and 3.6 years, tiered 6.6× and 14.4 years; life ∝ 1 / rate", () => {
    const seq = deviceWa(0.07, "sequential");
    expect(seq).toBe(1);
    const lv = chain({ appWa: 24, fsWa: 1.1, deviceWa: seq, userMBps: 1, capacityGB: 1000, peCycles: 3000 });
    expect([r(lv.total), r(lv.years, 2)]).toEqual([26.4, 3.6]);
    const tr = chain({ appWa: 6, fsWa: 1.1, deviceWa: seq, userMBps: 1, capacityGB: 1000, peCycles: 3000 });
    expect([r(tr.total), r(tr.years)]).toEqual([6.6, 14.4]);
    expect(chain({ appWa: 6, fsWa: 1.1, deviceWa: 1, userMBps: 10, capacityGB: 1000, peCycles: 3000 }).years).toBeCloseTo(tr.years / 10, 9);
  });
});
