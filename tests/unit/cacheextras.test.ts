/** Numbers quoted in the five Caches lessons. Keep them in sync with the lesson text. */
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";
import { loadCacheSim, runCache, runWrite, runHier, runPrefetch, runReuse, OUTCOME, COLD } from "@/wasm/cachesim";
import { matmul, WRITE_PATTERNS, PREFETCH_PATTERNS, randomInSet } from "@/sims/memtraces";
import { PATTERNS } from "@/sims/patterns";
import {
  splitAddress, hitRate, matrixWalk, columnSets, setsUsed, loopHitRate, amat, amat1, reuseSteps, REUSE_TRACES, hitsAt,
  strideTraffic, innerLines, loopIndex, runTwoLevel, HIER_TRACES, hotMissShare, prefetchTimeline, cyclesPerLine,
  strideSteps, twoStreams, coverage, runWritePolicy, writeTraffic, WRITE_TRACES, SetCache,
} from "@/sims/cacheextras";

type W = Awaited<ReturnType<typeof loadCacheSim>>;
let w: W;
beforeAll(async () => {
  w = await loadCacheSim(() => readFile(new URL("../../public/wasm/cachesim.wasm", import.meta.url)));
});

const gen = (id: string, n = 4096) => PATTERNS.find((p) => p.id === id)!.gen({ n });
const wrate = (o: Uint8Array) => o.filter((b) => b === OUTCOME.hit).length / o.length;
const G4 = { size: 4096, line: 64, ways: 1 };

describe("cache organization", () => {
  test("address split of the default cache: 64 sets, 6 + 6 + 20 bits", () => {
    const s = splitAddress(4 * (64 * 5 + 3), G4);
    expect([s.sets, s.offsetBits, s.indexBits, s.tagBits]).toEqual([64, 6, 6, 20]);
    expect([s.line, s.index, s.offset]).toEqual([20, 20, 12]);
    // The set index moves by 4 per row: a row is 256 B = 4 lines.
    expect(splitAddress(4 * (64 * 6 + 3), G4).index - s.index).toBe(4);
    const full = splitAddress(0, { ...G4, ways: 0 });
    expect([full.sets, full.indexBits]).toEqual([1, 0]);
  });
  test("rows of one column that share a set: 4 of 64 at 4 KiB, 1 at 16 KiB", () => {
    const share = (g: typeof G4) => Array.from({ length: 64 }, (_, r) => r).filter((r) => splitAddress(4 * (64 * r + 3), g).index === splitAddress(4 * (64 * 5 + 3), g).index).length;
    expect(share(G4)).toBe(4);
    expect(share({ ...G4, size: 16384 })).toBe(1);
  });
  test("one column uses 16 of 64 sets; with 1, 2 or 4 ways it can use only 16 lines", () => {
    expect(columnSets(64, 0, G4)).toBe(16);
    for (const ways of [1, 2, 4]) {
      const g = { ...G4, ways };
      expect(columnSets(64, 0, g) * ways).toBe(16);
      expect(hitRate(matrixWalk(64, "col"), g)).toBe(0);
    }
    expect(setsUsed(matrixWalk(64, "col"), G4)).toBe(64); // all sets over the whole walk
  });
  test("TS stepper model agrees with the wasm simulator: 93.8% row-major, full associativity fixes the column walk", () => {
    expect(hitRate(matrixWalk(64, "row"), G4)).toBe(0.9375);
    expect(hitRate(matrixWalk(64, "col"), { ...G4, ways: 0 })).toBe(0.9375);
    expect(wrate(runCache(w, gen("col-major"), { ...G4, ways: 1, policy: "lru" }))).toBe(0);
    expect(wrate(runCache(w, gen("col-major"), { ...G4, ways: 64, policy: "lru" }))).toBe(0.9375);
  });
  test("two arrays 8 KiB apart: all conflicts; 2 ways or 16 KiB give 93.8%", () => {
    const o = runCache(w, gen("ping-pong"), { ...G4, policy: "lru" });
    expect(o.filter((b) => b === OUTCOME.conflict).length).toBe(3840);
    expect(wrate(runCache(w, gen("ping-pong"), { ...G4, ways: 2, policy: "lru" }))).toBe(0.9375);
    expect(wrate(runCache(w, gen("ping-pong"), { ...G4, size: 16384, policy: "lru" }))).toBe(0.9375);
  });
  test("loop over 96 lines in 64: LRU and FIFO 0%, random about 41%, direct-mapped about 33%; 97.7% once it fits", () => {
    const cfg = { size: 4096, line: 64, ways: 64 } as const;
    expect(wrate(runCache(w, gen("loop-lines"), { ...cfg, policy: "lru" }))).toBe(0);
    expect(wrate(runCache(w, gen("loop-lines"), { ...cfg, policy: "fifo" }))).toBe(0);
    expect(wrate(runCache(w, gen("loop-lines"), { ...cfg, policy: "random" }))).toBeCloseTo(0.41, 2);
    expect(wrate(runCache(w, gen("loop-lines"), { ...cfg, ways: 1, policy: "lru" }))).toBeCloseTo(0.33, 2);
    for (const p of ["lru", "fifo", "random"] as const) expect(wrate(runCache(w, gen("loop-lines"), { size: 8192, line: 64, ways: 128, policy: p }))).toBeCloseTo(0.977, 3);
  });
  test("small loop demo: N = 5 in 4 lines gives 0% for LRU and FIFO, about 59% random; N = 4 fits; N = 8 random about 18%", () => {
    expect(loopHitRate(5, 4, "lru")).toBe(0);
    expect(loopHitRate(5, 4, "fifo")).toBe(0);
    expect(loopHitRate(5, 4, "random")).toBeCloseTo(0.59, 2);
    for (const p of ["lru", "fifo", "random"] as const) expect(loopHitRate(4, 4, p)).toBe(1);
    expect(loopHitRate(8, 4, "random")).toBeCloseTo(0.18, 2);
  });
  test("AMAT: 1 ns hit, 80 ns penalty: 6 ns at 93.8%, 81 ns at 0%, 13.5 times slower", () => {
    expect(amat1(1, 1 - 0.9375, 80)).toBe(6);
    expect(amat1(1, 1, 80)).toBe(81);
    expect(amat1(1, 1, 80) / amat1(1, 1 - 0.9375, 80)).toBe(13.5);
  });
  test("SetCache replacement basics", () => {
    const c = new SetCache(2, 0, "lru");
    c.access(1); c.access(2); c.access(1);
    expect(c.access(3).victim).toBe(2);
  });
});

describe("locality", () => {
  test("reuse stepper: loop over 3 lines hits only with 3 lines; the hot line hits with 2", () => {
    const loop3 = reuseSteps(REUSE_TRACES.find((t) => t.id === "loop3")!.trace);
    expect(loop3.slice(3).every((s) => s.distance === 2)).toBe(true);
    expect([hitsAt(loop3, 2), hitsAt(loop3, 3)]).toEqual([0, 9]);
    const hot = reuseSteps(REUSE_TRACES.find((t) => t.id === "hot")!.trace);
    expect(hot.filter((s) => s.item === "A").slice(1).every((s) => s.distance === 1)).toBe(true);
  });
  test("reuse distances of the full-size patterns (wasm)", () => {
    const col = runReuse(w, gen("col-major"), 64);
    expect(col.filter((x) => x !== COLD).every((x) => x === 63)).toBe(true);
    const loop = runReuse(w, gen("loop-lines"), 64);
    expect(loop.filter((x) => x !== COLD).every((x) => x === 95)).toBe(true);
    expect(loop.filter((x) => x !== COLD && x < 128).length / loop.length).toBeCloseTo(0.977, 3); // 8 KiB
    const cold = (line: number) => { const d = runReuse(w, gen("sequential"), line); return d.filter((x) => x === COLD).length / d.length; };
    expect(cold(4)).toBe(1);
    expect(cold(256)).toBe(1 / 64);
    const colHits = (lines: number) => col.filter((x) => x !== COLD && x < lines).length / col.length;
    expect(colHits(63)).toBe(0);
    expect(colHits(64)).toBe(0.9375); // 4 KiB
  });
  test("stride: 1 miss in 16 at stride 1; doubling; 6.25% useful at stride 16", () => {
    expect(strideTraffic(4096, 1, 4, 64).missPerAccess).toBe(1 / 16);
    expect([2, 4, 8].map((s) => strideTraffic(4096, s, 4, 64).missPerAccess)).toEqual([0.125, 0.25, 0.5]);
    const s16 = strideTraffic(4096, 16, 4, 64);
    expect(s16.missPerAccess).toBe(1);
    expect(s16.used / s16.fetched).toBe(0.0625);
    // Stride larger than a line: larger lines only move more unused bytes.
    const u = (L: number) => { const t = strideTraffic(4096, 32, 4, L); return t.used / t.fetched; };
    expect(u(128)).toBeLessThan(u(64));
  });
  test("inner-loop footprint: ijk 1/8 + 1, jki 2, ikj 1/8 + 1/8", () => {
    expect(innerLines("ijk", 8, 8)).toEqual({ A: 0.125, B: 1, C: 0 });
    expect(innerLines("jki", 8, 8)).toEqual({ A: 1, B: 0, C: 1 });
    expect(innerLines("ikj", 8, 8)).toEqual({ A: 0, B: 0.125, C: 0.125 });
    expect(loopIndex("ikj", 8, 9)).toEqual({ i: 0, k: 1, j: 1 });
  });
  const perInner = (order: Parameters<typeof matmul>[1], size: number, tile = 8) => {
    const t = matmul(64, order, tile);
    return runCache(w, t.addrs, { size, line: 64, ways: 8, policy: "lru" }).filter((o) => o !== OUTCOME.hit).length / 64 ** 3;
  };
  test("matmul at 8 KiB: 1.04, 2.02, 0.13; more than 15 times between jki and ikj", { timeout: 20000 }, () => {
    const ijk = perInner("ijk", 8192), jki = perInner("jki", 8192), ikj = perInner("ikj", 8192);
    expect(ijk).toBeCloseTo(1.04, 2);
    expect(jki).toBeCloseTo(2.02, 2);
    expect(ikj).toBeCloseTo(0.13, 2);
    expect(jki / ikj).toBeGreaterThan(15);
  });
  test("tiling: 8×8 about 0.035 (30 times fewer than ijk); 16×16 fails at 8 KiB, works at 16 KiB", { timeout: 20000 }, () => {
    const t8 = perInner("tiled", 8192, 8);
    expect(t8).toBeCloseTo(0.035, 3);
    expect(Math.round(perInner("ijk", 8192) / t8)).toBe(30);
    expect(perInner("tiled", 8192, 16)).toBeGreaterThan(0.13);
    expect(perInner("tiled", 16384, 16)).toBeLessThan(0.025);
    expect(3 * 8 * 8 * 8).toBe(1536); // 3 × 512 B
    expect(3 * 16 * 16 * 8).toBe(6144); // 6 KiB
  });
});

describe("multi-level caches", () => {
  test("24 KiB working set: inclusive 33%, exclusive 9% to memory", () => {
    const two = [{ size: 8192, ways: 8 }, { size: 16384, ways: 8 }];
    const mem = (mode: "inclusive" | "exclusive") => { const s = runHier(w, randomInSet(24576, 24000), two, 64, mode).subarray(8000); return s.filter((k) => k === 2).length / s.length; };
    expect(Math.round(100 * mem("inclusive"))).toBe(33);
    expect(Math.round(100 * mem("exclusive"))).toBe(9);
  });
  test("hot set + stream: inclusive misses 12.6% of hot accesses", () => {
    const levels = [{ size: 8192, ways: 8 }, { size: 16384, ways: 8 }, { size: 131072, ways: 16 }];
    const a = new Uint32Array(60000);
    for (let i = 0; i < 30000; i++) { a[2 * i] = (i % 32) * 64; a[2 * i + 1] = (1 << 24) + i * 64; }
    const s = runHier(w, a, levels, 64, "inclusive");
    let n = 0, miss = 0;
    for (let i = 4000; i < s.length; i += 2) { n++; if (s[i] !== 0) miss++; }
    expect(miss / n).toBeCloseTo(0.126, 3);
  });
  test("AMAT demo: 6.6 cycles, 950 end in L1, 6 reach memory, memory adds 1.2 cycles (18%)", () => {
    const r = amat([4, 12, 40, 200], [0.05, 0.4, 0.3]);
    expect(r.total).toBeCloseTo(6.6, 10);
    expect(Math.round(1000 * (r.reach[0]! - r.reach[1]!))).toBe(950);
    expect(Math.round(1000 * r.reach[3]!)).toBe(6);
    expect(r.parts[3]).toBeCloseTo(1.2, 10);
    expect(Math.round((100 * r.parts[3]!) / r.total)).toBe(18);
    expect(amat([4, 12, 40, 200], [0.01, 0.8, 0.3]).total).toBeCloseTo(4.92, 10);
    expect(amat([4, 12, 40, 200], [0.2, 0.4, 0.3]).total).toBeCloseTo(14.4, 10);
  });
  test("inclusion stepper: back-invalidation costs the hot line 25%; exclusive holds 6 lines", () => {
    const hot = HIER_TRACES.find((t) => t.id === "hot")!.trace;
    expect(hotMissShare(runTwoLevel(hot, 2, 4, "inclusive"))).toBe(0.25);
    expect(hotMissShare(runTwoLevel(hot, 2, 4, "nine"))).toBe(0);
    expect(hotMissShare(runTwoLevel(hot, 2, 4, "exclusive"))).toBe(0);
    expect(runTwoLevel(hot, 2, 4, "inclusive").some((s) => s.backInvalidated === "H")).toBe(true);
    const loop = HIER_TRACES.find((t) => t.id === "loop6")!.trace;
    for (const m of ["inclusive", "nine"] as const) {
      const s = runTwoLevel(loop, 2, 4, m);
      expect(s.every((x) => x.level === 2)).toBe(true);
      expect(new Set([...s.at(-1)!.l1, ...s.at(-1)!.l2]).size).toBe(4);
    }
    const ex = runTwoLevel(loop, 2, 4, "exclusive");
    expect(ex.slice(6).every((x) => x.level === 1)).toBe(true);
    expect(new Set([...ex.at(-1)!.l1, ...ex.at(-1)!.l2]).size).toBe(6);
  });
});

describe("prefetching", () => {
  const per = (work: number, d: number) => cyclesPerLine(prefetchTimeline(200, work, 200, d));
  test("timeline: 220 cycles without prefetch, 110 at distance 1, 20 at distance 10 (11 times faster)", () => {
    expect(per(20, 0)).toBe(220);
    expect(per(20, 1)).toBe(110);
    expect(per(20, 10)).toBe(20);
    expect(per(20, 9)).toBeGreaterThan(20);
    expect(per(20, 0) / per(20, 10)).toBe(11);
  });
  test("with 50 cycles of work, distance 4 is enough", () => {
    expect(Math.ceil(200 / 50)).toBe(4);
    expect(per(50, 4)).toBe(50);
    expect(per(50, 3)).toBeGreaterThan(50);
  });
  test("stride stepper: per-PC covers every load from the fourth of each instruction; global covers nothing", () => {
    const pc = strideSteps(twoStreams(10), true);
    expect(pc.slice(0, 6).some((s) => s.covered)).toBe(false);
    expect(pc.slice(6).every((s) => s.covered)).toBe(true);
    const g = strideSteps(twoStreams(10), false);
    expect(coverage(g)).toBe(0);
    expect(g.slice(1, 5).map((s) => s.delta)).toEqual([1000, -997, 1002, -999]);
  });
  const cov = (id: string, kind: "next-line" | "stride" | "pc-stride", degree: number) => {
    const t = PREFETCH_PATTERNS.find((p) => p.id === id)!.gen();
    const s = runPrefetch(w, t.addrs, t.pcs, { size: 8192, line: 64, ways: 8, kind, degree }).stats;
    return { coverage: s.covered / (s.covered + s.misses), accuracy: s.issued ? s.covered / s.issued : 0 };
  };
  test("next-line on a 3-line stride: 0% at degree 2; 100% coverage, 33% accuracy at degree 4; stride 100%", () => {
    expect(cov("stride", "next-line", 2).coverage).toBe(0);
    expect(cov("stride", "next-line", 4).coverage).toBeGreaterThan(0.995);
    expect(Math.round(100 * cov("stride", "next-line", 4).accuracy)).toBe(33);
    expect(cov("stride", "stride", 2).accuracy).toBeGreaterThan(0.995);
  });
  test("two streams at degree 2: global 0%, per PC 100%", () => {
    expect(cov("two-streams", "stride", 2).coverage).toBe(0);
    expect(cov("two-streams", "pc-stride", 2).coverage).toBeGreaterThan(0.995);
  });
});

describe("write policies", () => {
  const run = (id: string, wb: boolean, wa: boolean) => {
    const t = WRITE_PATTERNS.find((p) => p.id === id)!.gen();
    const s = runWrite(w, t.addrs, t.writes, { size: 4096, line: 64, ways: 4, writeBack: wb, writeAllocate: wa }).stats;
    const wordWrites = (s.memWrite - s.writebacks * 64) / 4;
    return { read: s.memRead, write: s.memWrite + s.dirtyAtEnd * 64, transactions: s.memRead / 64 + s.writebacks + s.dirtyAtEnd + wordWrites, stores: t.writes.reduce((a, b) => a + b, 0) };
  };
  test("memset 16 KiB and a[i] += 1 (5,120 stores, 20 KiB)", () => {
    expect(run("memset", true, true)).toMatchObject({ read: 16384, write: 16384 });
    expect(run("memset", false, false)).toMatchObject({ read: 0, write: 16384 });
    expect(run("increment", false, true)).toMatchObject({ write: 20480, stores: 5120 });
    expect(run("increment", true, true).write).toBe(1024);
  });
  test("transpose: 272 KiB read and 256 KiB written with write-allocate; 16 KiB each way without", () => {
    expect(run("transpose", true, true)).toMatchObject({ read: 272 * 1024, write: 256 * 1024 });
    expect(run("transpose", true, false)).toMatchObject({ read: 16384, write: 16384 });
    expect(run("transpose", false, false)).toMatchObject({ read: 16384, write: 16384 });
  });
  test("scattered counters: write-through writes 16 KiB vs 241 KiB, but 7,955 vs 7,718 transactions", () => {
    const wb = run("scatter", true, true), wt = run("scatter", false, false);
    expect(wt.write).toBe(16384);
    expect(Math.round(wb.write / 1024)).toBe(241);
    expect(Math.round(wt.transactions)).toBe(7955);
    expect(Math.round(wb.transactions)).toBe(7718);
  });
  const trace = (id: string) => WRITE_TRACES.find((t) => t.id === id)!.ops;
  test("write stepper, memset 6 lines: 384 B read, 128 B written, 256 B owed; 12 vs 48 transfers", () => {
    const end = runWritePolicy(trace("memset"), 4, true, true).at(-1)!.state;
    expect([end.read, end.written, end.lines.filter((l) => l.dirty).length * 64]).toEqual([384, 128, 256]);
    expect(writeTraffic(trace("memset"), 4, true, true).ops).toBe(12);
    expect(writeTraffic(trace("memset"), 4, false, false)).toEqual({ read: 0, written: 384, ops: 48 });
    // The first store to each line misses, the next 7 hit.
    const steps = runWritePolicy(trace("memset"), 4, true, true);
    expect(steps.filter((s) => !s.hit).length).toBe(6);
  });
  test("write stepper, column writes: 3,072 B each way for 384 B of data", () => {
    expect(writeTraffic(trace("column"), 4, true, true)).toMatchObject({ read: 3072, written: 3072 });
    expect(writeTraffic(trace("column"), 4, true, false)).toMatchObject({ read: 0, written: 384 });
  });
  test("write stepper, x[i] += 1: write-back writes each line once, write-through every store", () => {
    expect(writeTraffic(trace("increment"), 4, true, true).written).toBe(128);
    expect(writeTraffic(trace("increment"), 4, false, true).written).toBe(48 * 8);
  });
});
