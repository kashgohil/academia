/** Every number quoted in the four LSM lessons. Keep in sync with src/content/lessons/databases/lsm/*.mdx. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  SkipList, expectedSearchCost, BloomFilter, bloomFpr, optimalK, bestIntegerK, levelDbK, fprAtOptimalK, bloomBitsForFpr,
  lowerBoundBitsForFpr, blockedBloomFpr, keySets, measureFpr, leveledRunSizes, missLookupIos, encodeBlock, ENTRY_TRAILER,
  WAL_RECORD_HEADER, FOOTER_BYTES, BLOCK_TRAILER_BYTES, DEFAULT_RESTART_INTERVAL, LsmTree, stepperSeedTree, blockKeys, avgSeekCost,
  sweepRun, finish, raceOptions, nextWrite, SWEEP_T, SWEEP_WRITES, writeAmp, deepWriteAmp, stallTimeline, STALL_DEFAULTS,
  lsmCosts, lsmThroughput, ROCKSDB_DEFAULTS, EXAMPLE_DATA, WORKLOADS, entrySize, dataBytes, compareEngines, crossover, btreeCosts,
  type SweepPoint, type Strategy,
} from "@/sims/db/lsm";

const MiB = 2 ** 20, GiB = 2 ** 30;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct1 = (v: number) => Math.round(v * 1000) / 10; // percent with one decimal

describe("memtables and SSTables", () => {
  test("format constants: 8-byte key trailer, 7-byte WAL header, 48-byte footer, 5-byte block trailer, restart every 16", () => {
    expect([ENTRY_TRAILER, WAL_RECORD_HEADER, FOOTER_BYTES, BLOCK_TRAILER_BYTES, DEFAULT_RESTART_INTERVAL]).toEqual([8, 7, 48, 5, 16]);
  });

  test("skip list: 39.9 comparisons for 1M keys at p = 1/2 and 1/4; 2 and 1.33 pointers per node", () => {
    expect(r1(expectedSearchCost(1e6, 0.5))).toBe(39.9);
    expect(r1(expectedSearchCost(1e6, 0.25))).toBe(39.9);
    expect(r1(2 * Math.log2(1e6))).toBe(39.9);
    expect([r2(1 / (1 - 0.5)), r2(1 / (1 - 0.25))]).toEqual([2, 1.33]);
    // The measured mean height follows 1/(1 − p).
    for (const p of [0.5, 0.25]) {
      const s = new SkipList<number, null>((a, b) => a - b, { p, seed: 3 });
      for (let i = 0; i < 20000; i++) s.insert(i, null);
      const mean = s.nodes().reduce((a, n) => a + n.height, 0) / s.size;
      expect(mean).toBeCloseTo(1 / (1 - p), 1);
    }
  });

  test("stepper: grape is skipped by range and by filter; apple #5 answers from file 2; fig is a tombstone", () => {
    const t = stepperSeedTree();
    const g = t.get("grape");
    expect(g.probes.map((p) => p.result)).toEqual(["miss", "no-file", "bloom-skip"]);
    expect(g.ios).toBe(0);
    const a = t.get("apple");
    expect(a.entry?.seq).toBe(5);
    expect(a.probes.at(-1)).toMatchObject({ level: 0, run: 0, fileId: 2, result: "found" });
    const f = t.get("fig");
    expect(f.probes.map((p) => p.result)).toEqual(["deleted"]);
    expect(f.entry?.seq).toBe(8);
    expect(t.sortedRuns()).toBe(3);
  });

  test("stepper: a snapshot keeps the old apple; flush + compaction drop 2 versions and 1 tombstone", () => {
    const t = stepperSeedTree();
    const s = t.snapshot();
    t.put("apple", "blue"); t.put("apple", "gold");
    expect(t.get("apple", s).value).toBe("green");
    const u = stepperSeedTree();
    u.flush();
    const ev = u.compactLevel(0)!;
    expect([ev.droppedVersions, ev.droppedTombstones]).toEqual([2, 1]);
    expect(u.get("fig").value).toBeUndefined();
  });

  test("block: user keys at interval 16 save 32.0% (1,200 B vs 1,766 B); seek 2.0 + 9.3", () => {
    const kvs = blockKeys("user");
    const b = encodeBlock(kvs, 16), plain = encodeBlock(kvs, 16, false);
    expect([b.bytes.length, plain.bytes.length]).toEqual([1200, 1766]);
    expect(pct1(1 - b.bytes.length / plain.bytes.length)).toBe(32.0);
    const s = avgSeekCost(b.bytes, kvs);
    expect([r1(s.probes), r1(s.scanned)]).toEqual([2.0, 9.3]);
    // Interval 1: 4 bytes of restart array per entry, and a seek scans about two entries
    // (the restart point before the target, then the target).
    const one = encodeBlock(kvs, 1);
    expect(one.trailerBytes).toBe(4 * kvs.length + 4);
    expect(r1(avgSeekCost(one.bytes, kvs).scanned)).toBe(2.0);
    // Random hex keys share almost nothing.
    const hex = blockKeys("hex");
    expect(1 - encodeBlock(hex, 16).bytes.length / encodeBlock(hex, 16, false).bytes.length).toBeLessThan(0.03);
  });
});

describe("Bloom filters", () => {
  test("10 bits per key: k = 7 gives 0.82%, LevelDB's k = 6 gives 0.84%; best k = 6.93", () => {
    expect(bestIntegerK(10)).toBe(7);
    expect(levelDbK(10)).toBe(6);
    expect(r2(optimalK(10))).toBe(6.93);
    expect(r2(bloomFpr(10, 7) * 100)).toBe(0.82);
    expect(r2(bloomFpr(10, 6) * 100)).toBe(0.84);
  });

  test("sizes: 1% needs 9.59 bits (bound 6.64, ratio 1.44); ×0.6185 per bit; 4.79 bits per 10×; Ribbon saves up to 31%", () => {
    expect(r2(bloomBitsForFpr(0.01))).toBe(9.59);
    expect(r2(lowerBoundBitsForFpr(0.01))).toBe(6.64);
    expect(r2(bloomBitsForFpr(0.01) / lowerBoundBitsForFpr(0.01))).toBe(1.44);
    expect(Math.round(fprAtOptimalK(1) * 1e4) / 1e4).toBe(0.6185);
    expect(r2(bloomBitsForFpr(0.01) - bloomBitsForFpr(0.1))).toBe(4.79);
    expect(Math.round(100 * (1 - lowerBoundBitsForFpr(0.01) / bloomBitsForFpr(0.01)))).toBe(31);
  });

  test("table: 5 bits → k 3, 9.18%; 9.59 → k 7, 1%; 14.38 → k 10, 0.1%", () => {
    expect([bestIntegerK(5), r2(bloomFpr(5, 3) * 100)]).toEqual([3, 9.18]);
    expect(bestIntegerK(9.59)).toBe(7);
    expect(bloomFpr(9.59, 7)).toBeCloseTo(0.01, 3);
    expect(r2(bloomBitsForFpr(0.001))).toBe(14.38);
    expect(bestIntegerK(14.38)).toBe(10);
    expect(bloomFpr(14.38, 10)).toBeCloseTo(0.001, 4);
  });

  test("measured 0.80% at 10 bits per key; blocked 0.96% (16 bits: 0.086% vs 0.046%)", () => {
    const sets = keySets(2000, 50000);
    expect(r2(measureFpr((m, k) => new BloomFilter(m, k), 10, 7, sets) * 100)).toBe(0.8);
    expect(r2(blockedBloomFpr(10, 7) * 100)).toBe(0.96);
    expect(bestIntegerK(16)).toBe(11);
    expect(Math.round(blockedBloomFpr(16, 11) * 1e5) / 1e3).toBe(0.086);
    expect(Math.round(bloomFpr(16, 11) * 1e5) / 1e3).toBe(0.046);
  });

  test("play demo: plum is rejected, a false positive exists, the rate falls then rises with k at 12 keys", () => {
    const words = ["apple", "banana", "cherry", "date", "fig"];
    const f = new BloomFilter(32, 3);
    for (const w of words) f.add(w);
    expect(f.mayContain("plum")).toBe(false);
    let found = false;
    for (let i = 0; i < 5000 && !found; i++) found = f.mayContain(`w${i}`);
    expect(found).toBe(true);
    const bpk = 32 / 12;
    expect(bloomFpr(bpk, 2)).toBeLessThan(bloomFpr(bpk, 1));
    expect(bloomFpr(bpk, 6)).toBeGreaterThan(bloomFpr(bpk, 2));
  });

  test("100 million keys at 10 bits per key need 119 MiB; the last level holds 89.9% of the keys", () => {
    expect(Math.round((100e6 * 10) / 8 / MiB)).toBe(119);
    const runs = leveledRunSizes(4, 4, 10);
    const total = runs.reduce((a, r) => a + r.entries, 0);
    expect(pct1(runs.at(-1)!.entries / total)).toBe(89.9);
  });

  test("Monkey: 8 → 0.0655 (uniform) → 0.0118 (Monkey), 81.9% less; last level 9.5 bits and 1.06%; L0 26.7 bits", () => {
    const m = missLookupIos(leveledRunSizes(4, 4, 10).map((r) => r.entries), 10);
    expect(m.none).toBe(8);
    expect(Math.round(m.uniformTotal * 1e4) / 1e4).toBe(0.0655);
    expect(Math.round(m.monkeyTotal * 1e4) / 1e4).toBe(0.0118);
    expect(pct1(1 - m.monkeyTotal / m.uniformTotal)).toBe(81.9);
    expect(r1(m.monkeyBits.at(-1)!)).toBe(9.5);
    expect(r2(m.monkey.at(-1)! * 100)).toBe(1.06);
    expect(r1(m.monkeyBits[0]!)).toBe(26.7);
    // Same memory in both cases.
    const entries = leveledRunSizes(4, 4, 10).map((r) => r.entries);
    const used = (bits: number[]) => bits.reduce((s, b, i) => s + b * entries[i]!, 0);
    expect(used(m.monkeyBits)).toBeCloseTo(used(m.uniformBits), 3);
    // At 2 bits per key Monkey still wins by a large factor.
    const m2 = missLookupIos(entries, 2);
    expect(m2.uniformTotal / m2.monkeyTotal).toBeGreaterThan(5);
  });
});

describe("compaction", () => {
  const sweep = new Map<string, SweepPoint>();
  const pt = (s: Strategy, T: number, stream: "insert" | "update" = "insert") => {
    const key = `${s}${T}${stream}`;
    if (!sweep.has(key)) sweep.set(key, finish(sweepRun(s, T, stream)));
    return sweep.get(key)!;
  };

  test("20,000 inserts: WA 9.67 vs 4.66 at T = 4, 11.37 vs 2.77 at T = 10; leveled 8.71 at T = 2, 12.63 at T = 16", () => {
    expect(SWEEP_WRITES).toBe(20000);
    expect(r2(pt("leveled", 4).wa)).toBe(9.67);
    expect(r2(pt("tiered", 4).wa)).toBe(4.66);
    expect(r2(pt("leveled", 10).wa)).toBe(11.37);
    expect(r2(pt("tiered", 10).wa)).toBe(2.77);
    expect(r2(pt("leveled", 2).wa)).toBe(8.71);
    expect(r2(pt("leveled", 16).wa)).toBe(12.63);
  }, 30000);

  test("sorted runs at T = 10: 5.3 leveled, 11.3 tiered; space amp with updates: 1.13 vs 2.61", () => {
    expect(r1(pt("leveled", 10).runs)).toBe(5.3);
    expect(r1(pt("tiered", 10).runs)).toBe(11.3);
    expect(r2(pt("leveled", 10, "update").sa)).toBe(1.13);
    expect(r2(pt("tiered", 10, "update").sa)).toBe(2.61);
  }, 30000);

  test("the closed-form WA model stays within 30% of the engine for T from 2 to 16", () => {
    for (const T of SWEEP_T) for (const s of ["leveled", "tiered"] as const) {
      const model = writeAmp({ strategy: s, sizeRatio: T, writeBufferBytes: 2048, l0Trigger: 4, baseLevelBytes: 8192 }, SWEEP_WRITES * 40);
      const meas = pt(s, T).wa;
      expect(Math.abs(model / meas - 1), `${s} T=${T}`).toBeLessThan(0.3);
    }
  }, 60000);

  test("race demo: leveled writes about twice as much at T = 4; tiered space amp passes 2 with updates", () => {
    const run = (stream: "insert" | "update") => {
      const rng = mulberry32(7);
      const trees = (["leveled", "tiered"] as const).map((s) => new LsmTree(raceOptions(s, 4)));
      let maxSa = 0;
      for (let i = 1; i <= 20000; i++) {
        const [k, v] = nextWrite(rng, stream);
        for (const t of trees) t.put(k, v);
        if (i % 100 === 0) maxSa = Math.max(maxSa, trees[1]!.spaceAmp());
      }
      return { ratio: trees[0]!.writeAmp() / trees[1]!.writeAmp(), maxSa };
    };
    const ins = run("insert");
    expect(ins.ratio).toBeGreaterThan(1.8);
    expect(ins.ratio).toBeLessThan(2.3);
    expect(run("update").maxSa).toBeGreaterThan(2);
  }, 30000);

  test("RocksDB defaults at 100 GiB: log10(400) = 2.6 levels below L1, 13.0 there, 16.0 in total", () => {
    expect((100 * GiB) / (256 * MiB)).toBe(400);
    expect(r1(Math.log10(400))).toBe(2.6);
    expect(r1(deepWriteAmp(100 * GiB, 256 * MiB, 10))).toBe(13.0);
    expect(r1(writeAmp(ROCKSDB_DEFAULTS, 100 * GiB))).toBe(16.0);
    expect(r2(10 / 9)).toBe(1.11);
  });

  test("time-ordered keys: every compaction is a trivial move, write amp 1", () => {
    const t = new LsmTree({ memtableBytes: 1024, baseLevelBytes: 4096, targetFileBytes: 1024, sizeRatio: 4 });
    for (let i = 0; i < 20000; i++) t.put(`t${String(i).padStart(8, "0")}`, "event-payload");
    t.flush();
    expect(t.stats.trivialMoves).toBeGreaterThan(50);
    expect(t.stats.compactions).toBe(0);
    expect(t.writeAmp()).toBe(1);
  });

  test("stalls: 20 MiB/s needs 520 MiB/s below L1 and never waits; 40 MiB/s is slowed 16% of the time, 36.1 MiB/s average", () => {
    const deep = deepWriteAmp(100 * GiB, 256 * MiB, 10);
    const at = (w: number) => stallTimeline({ ...STALL_DEFAULTS, writeMiBps: w, compactionMiBps: 1000, deepWriteAmp: deep });
    expect(Math.round(20 * deep * 2)).toBe(520);
    const a = at(20);
    expect([a.stallShare, a.stopShare, a.avgIngest]).toEqual([0, 0, 20]);
    const b = at(40);
    expect(Math.round(b.stallShare * 100)).toBe(16);
    expect(r1(b.avgIngest)).toBe(36.1);
    expect(b.stopShare).toBe(0);
    expect([STALL_DEFAULTS.slowdownTrigger, STALL_DEFAULTS.stopTrigger]).toEqual([20, 36]);
  });
});

describe("tuning", () => {
  const d = EXAMPLE_DATA;
  const tp = (c = ROCKSDB_DEFAULTS, w = WORKLOADS.log) => lsmThroughput(c, d, w);
  const big = { ...ROCKSDB_DEFAULTS, writeBufferBytes: 256 * MiB, baseLevelBytes: 1024 * MiB };

  test("data: 124-byte entries, 11.5 GiB", () => {
    expect(entrySize(d)).toBe(124);
    expect(r1(dataBytes(d) / GiB)).toBe(11.5);
  });

  test("log workload: WA 11.3, writes 87% of the time, 286k; bigger memtable + L1: 8.3, +10%, 27% less I/O", () => {
    const c = lsmCosts(ROCKSDB_DEFAULTS, d, WORKLOADS.log);
    expect(r1(c.writeAmp)).toBe(11.3);
    expect(Math.round(tp().share.write * 100)).toBe(87);
    expect(Math.round(tp().opsPerSec / 1000)).toBe(286);
    expect(r1(lsmCosts(big, d, WORKLOADS.log).writeAmp)).toBe(8.3);
    expect(Math.round((tp(big).opsPerSec / tp().opsPerSec - 1) * 100)).toBe(10);
    expect(Math.round((1 - lsmCosts(big, d, WORKLOADS.log).writeAmp / c.writeAmp) * 100)).toBe(27);
    expect(lsmCosts(big, d, WORKLOADS.log).memory.memtables / MiB).toBe(512);
    expect([3 * 256, 2 * 64]).toEqual([768, 128]);
  });

  test("tiered: WA 2.3, 14.5 runs, 366k", () => {
    const t = { ...ROCKSDB_DEFAULTS, strategy: "tiered" as const };
    const c = lsmCosts(t, d, WORKLOADS.log);
    expect([r1(c.writeAmp), c.runs]).toEqual([2.3, 14.5]);
    expect(Math.round(tp(t).opsPerSec / 1000)).toBe(366);
  });

  test("point lookups: a miss costs 0.041 reads; 16 bits give +1.7%, an 8 GiB cache +19%; no filter: 5 reads", () => {
    const P = WORKLOADS.point;
    expect(Math.round(lsmCosts(ROCKSDB_DEFAULTS, d, P).missIos * 1000) / 1000).toBe(0.041);
    const base = tp(ROCKSDB_DEFAULTS, P).opsPerSec;
    const bloom16 = tp({ ...ROCKSDB_DEFAULTS, bloomBitsPerKey: 16 }, P).opsPerSec;
    const cache8 = tp({ ...ROCKSDB_DEFAULTS, blockCacheBytes: 8 * GiB }, P).opsPerSec;
    const mem256 = tp({ ...ROCKSDB_DEFAULTS, writeBufferBytes: 256 * MiB }, P).opsPerSec;
    expect(r1((bloom16 / base - 1) * 100)).toBe(1.7);
    expect(Math.round((cache8 / base - 1) * 100)).toBe(19);
    expect(cache8).toBeGreaterThan(bloom16);
    expect(cache8).toBeGreaterThan(mem256);
    expect(lsmCosts({ ...ROCKSDB_DEFAULTS, bloomBitsPerKey: 0 }, d, P).missIos).toBe(5);
  });

  test("range scans with 16 KiB blocks: 5.8 blocks in place of 8.0, +25%, index 61 → 15 MiB", () => {
    const R = WORKLOADS.range, b16 = { ...ROCKSDB_DEFAULTS, blockBytes: 16384 };
    expect(r1(lsmCosts(b16, d, R).rangeIos)).toBe(5.8);
    expect(r1(lsmCosts(ROCKSDB_DEFAULTS, d, R).rangeIos)).toBe(8.0);
    expect(Math.round((tp(b16, R).opsPerSec / tp(ROCKSDB_DEFAULTS, R).opsPerSec - 1) * 100)).toBe(25);
    expect(Math.round(lsmCosts(ROCKSDB_DEFAULTS, d, R).memory.index / MiB)).toBe(61);
    expect(Math.round(lsmCosts(b16, d, R).memory.index / MiB)).toBe(15);
  });

  test("B+ tree vs LSM: 132 vs 11.3 bytes per byte; 212k vs 198k at 0% writes; 6 runs; crossovers 3.8%, 1.7%, 5.2%, 4.1%", () => {
    const half = compareEngines(4 * GiB, 16384, 0.5);
    expect(Math.round(half.btree.costs.writeAmp)).toBe(132);
    expect(r1(half.lsm.costs.writeAmp)).toBe(11.3);
    const zero = compareEngines(4 * GiB, 16384, 0);
    expect(Math.round(zero.btree.opsPerSec / 1000)).toBe(212);
    expect(Math.round(zero.lsm.tput.opsPerSec / 1000)).toBe(198);
    expect(zero.lsm.costs.runs).toBe(6);
    expect(pct1(crossover(4 * GiB, 16384))).toBe(3.8);
    expect(pct1(crossover(4 * GiB, 4096))).toBe(1.7);
    expect(pct1(crossover(1 * GiB, 16384))).toBe(5.2);
    expect(pct1(crossover(16 * GiB, 16384))).toBe(4.1);
    // 4 KiB pages make the tree taller.
    const w = { scanLength: 100 };
    expect(btreeCosts({ pageBytes: 16384, fill: 0.69, cacheBytes: 4 * GiB }, d, w).height).toBe(4);
    expect(btreeCosts({ pageBytes: 4096, fill: 0.69, cacheBytes: 4 * GiB }, d, w).height).toBe(5);
  });
});
