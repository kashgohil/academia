/** Every number that the Partitioning lessons quote, computed by the sims. */
import { describe, expect, test } from "vitest";
import {
  workload, partitioner, shardLoads, maxOverMean, zipfShare, topShare, scanCost, expectedHashScanShards,
  HashRing, keyName, keyPos, harmonicN, ringStatsAvg, cvFormula, moveKeys, jumpMeasuredIters, jumpExpectedIters,
  simulateRebalance, idealMovedGB, simulateSplits, route, makeCars, pAnySlow, gatherQuantile, SERVICE_DEFAULTS, indexRace,
  hotLoad, cmsSize, zipfShardSample, HOT_DEFAULTS,
} from "@/sims/dist/partitioning";

const r2 = (x: number) => Number(x.toFixed(2));

describe("sharding", () => {
  const K = 1_000_000, n = 20_000;
  const load = (kind: "uniform" | "sequential" | "zipf", scheme: "range" | "hash", N = 8) => maxOverMean(shardLoads(partitioner(scheme, K, N), workload({ kind, K, n, theta: 0.99 })));
  test("timestamps on 8 range shards: 8.00; hashed: 1.02", () => {
    expect(load("sequential", "range")).toBe(8);
    expect(r2(load("sequential", "hash"))).toBe(1.02);
  });
  test("Zipf: the hottest key gets 6.5%; the busiest hash shard is 1.66 times the mean", () => {
    expect(zipfShare(1, K, 0.99)).toBeCloseTo(0.065, 3);
    expect(r2(load("zipf", "hash"))).toBe(1.66);
  });
  test("scans", () => {
    const scan = (s: "range" | "hash", N: number, from: number, len: number) => scanCost(partitioner(s, K, N), from, len).shards;
    expect(scan("range", 16, 412000, 1000)).toBe(1);
    expect(scan("hash", 16, 412000, 1000)).toBe(16);
    expect(scan("hash", 16, 412000, 10)).toBe(9);
    expect(expectedHashScanShards(16, 10)).toBeCloseTo(7.6, 1);
    expect(scan("range", 16, 437000, 1000)).toBe(2);
    expect(scan("hash", 64, 412000, 100)).toBe(50);
    expect(expectedHashScanShards(64, 100)).toBeCloseTo(50.7, 1);
  });
});

describe("consistent hashing", () => {
  test("three servers with one point: B owns 86% and gets 262 of 300 keys", () => {
    const ring = new HashRing(["A", "B", "C"], 1);
    expect(Math.round(ring.ownership().get("B")! * 100)).toBe(86);
    let b = 0;
    for (let k = 0; k < 300; k++) if (ring.lookupPos(keyPos(keyName(k))) === "B") b++;
    expect(b).toBe(262);
  });
  test("harmonic numbers: H(3)/3 = 61%, H(10) = 2.93, H(50) = 4.5", () => {
    expect(harmonicN(3)).toBeCloseTo(1.83, 2);
    expect(Math.round((harmonicN(3) / 3) * 100)).toBe(61);
    expect(harmonicN(10)).toBeCloseTo(2.93, 2);
    expect(harmonicN(50)).toBeCloseTo(4.5, 1);
  });
  test("simulated rings: 2.83 at v = 1 (60 rings), 1.14 at v = 128 (23 rings, as the demo)", () => {
    expect(r2(ringStatsAvg(10, 1, 60).maxOverMean)).toBe(2.83);
    expect(r2(ringStatsAvg(10, 128, 23).maxOverMean)).toBe(1.14);
  });
  test("spread formula: 9.5% at v = 100, near 25% at v = 16", () => {
    expect(cvFormula(10, 100)).toBeCloseTo(0.0948, 4);
    expect(cvFormula(100, 16)).toBeCloseTo(0.25, 2);
  });
  test("the simulated spread follows the formula", () => {
    for (const v of [1, 16, 128]) expect(Math.abs(ringStatsAvg(10, v, 40).cv / cvFormula(10, v) - 1)).toBeLessThan(0.15);
  });
});

describe("rendezvous and jump hashing", () => {
  const K = 10000;
  test("adding an 11th server", () => {
    const m = (s: "modulo" | "ring" | "rendezvous" | "jump" | "maglev") => moveKeys(s, 10, "add", K, { vnodes: 100 });
    expect(m("modulo").moved).toBe(9095); // 91%
    expect(m("modulo").needless).toBe(8170);
    expect([m("ring").moved, m("rendezvous").moved, m("jump").moved]).toEqual([932, 851, 883]); // about 9%
    expect(m("maglev").moved).toBe(968);
    expect(m("maglev").needless).toBe(27);
  });
  test("removing a middle server: jump moves about twice the minimum", () => {
    const j = moveKeys("jump", 10, "removeMiddle", K);
    expect(j.moved / j.minimum).toBeGreaterThan(1.7);
    expect(j.moved / j.minimum).toBeLessThan(2.3);
  });
  test("jump hash loop turns for 1,000 buckets: 7.48 measured, H(1000) = 7.49", () => {
    expect(jumpMeasuredIters(1000, 20000)).toBeCloseTo(7.48, 2);
    expect(jumpExpectedIters(1000)).toBeCloseTo(7.49, 2);
    expect(jumpExpectedIters(1000)).toBeLessThan(Math.log(1000) + 1);
  });
});

describe("rebalancing", () => {
  test("GB copied: modulo 851, fixed 208, perfect balance 217", () => {
    expect(Math.round(simulateRebalance({ strategy: "modulo" }).movedGB)).toBe(851);
    expect(Math.round(simulateRebalance({ strategy: "fixed" }).movedGB)).toBe(208);
    expect(Math.round(idealMovedGB())).toBe(217);
  });
  test("throttle: fixed partitions are out of balance 69 minutes at 40 MB/s, 27 at 100 MB/s", () => {
    expect(simulateRebalance({ strategy: "fixed" }).unbalancedMin).toBe(69);
    expect(simulateRebalance({ strategy: "fixed", rateMBs: 100 }).unbalancedMin).toBe(27);
    expect(Math.round(simulateRebalance({ strategy: "fixed", rateMBs: 100 }).movedGB)).toBe(208);
  });
  test("granularity: 16 partitions end at 1.125; tokens 1, 16, 256 end at 2.29, 1.70, 1.08", () => {
    expect(simulateRebalance({ strategy: "fixed", partitions: 16 }).finalMaxOverMean).toBeCloseTo(1.125, 3);
    expect(r2(simulateRebalance({ strategy: "proportional", tokens: 1 }).finalMaxOverMean)).toBe(2.29);
    expect(r2(simulateRebalance({ strategy: "proportional", tokens: 16 }).finalMaxOverMean)).toBe(1.7);
    expect(r2(simulateRebalance({ strategy: "proportional", tokens: 256 }).finalMaxOverMean)).toBe(1.08);
  });
  test("16 random tokens over 20 seeds: mean 1.41", () => {
    let s = 0;
    for (let seed = 1; seed <= 20; seed++) s += simulateRebalance({ strategy: "proportional", seed }).finalMaxOverMean;
    expect(r2(s / 20)).toBe(1.41);
  });
  test("rising keys: six splits, and one node takes all writes during the burst", () => {
    const f = simulateSplits({ burst: "sequential" });
    expect(f.filter((x) => x.kind === "split").length).toBe(6);
    for (const x of f.filter((x) => x.tick >= 1 && x.tick <= 22)) expect(Math.max(...x.nodeQps)).toBe(x.nodeQps.reduce((a, b) => a + b, 0));
  });
  test("a hot range with load splitting spreads its pieces over all three nodes", () => {
    const f = simulateSplits({ burst: "hot-range", loadSplitQps: 400 });
    const t = f[20]!;
    expect(t.nodeQps.every((q) => q > 0)).toBe(true);
    expect(f[f.length - 1]!.ranges.length).toBe(1);
  });
});

describe("secondary indexes", () => {
  test("local query asks all 6 partitions", () => {
    expect(route("local", { kind: "query", color: "red" }, makeCars(48), 6).readFanOut).toBe(6);
  });
  test("tail: 63.4% at q = 1%, P = 100; 9.6% at P = 10", () => {
    expect(pAnySlow(100, 0.01)).toBeCloseTo(0.634, 3);
    expect(pAnySlow(10, 0.01)).toBeCloseTo(0.096, 3);
  });
  test("quantiles: 3.5 ms for one partition, about 14 ms at 10, 1,000 ms at 100, tens of ms at q = 0.1%", () => {
    expect(gatherQuantile(1, 0.5, SERVICE_DEFAULTS)).toBeCloseTo(3.5, 1);
    expect(gatherQuantile(1, 0.99, SERVICE_DEFAULTS)).toBe(1000);
    expect(Math.round(gatherQuantile(10, 0.5, SERVICE_DEFAULTS))).toBe(14);
    expect(gatherQuantile(100, 0.5, SERVICE_DEFAULTS)).toBe(1000);
    const q01 = gatherQuantile(100, 0.5, { ...SERVICE_DEFAULTS, slowProb: 0.001 });
    expect(q01).toBeGreaterThan(10);
    expect(q01).toBeLessThan(100);
    expect(gatherQuantile(100, 0.99, { ...SERVICE_DEFAULTS, slowProb: 0.001 })).toBe(1000);
  });
  test("stale read race: ack at 20 ms, index at 60 ms, read served at 40 ms; with no delay the entry lands at 20 ms", () => {
    const r = indexRace("async", 30, 40);
    expect([r.ackAt, r.indexAt, r.readServedAt, r.stale]).toEqual([20, 60, 40, true]);
    expect(indexRace("async", 60, 40).sawWrite).toBe(true);
    expect(indexRace("async", 30, 0).indexAt).toBe(20);
  });
});

describe("hot keys", () => {
  test("Zipf shares for 10,000 keys: 9.8% top, 28.9% top 10; 38.6% at θ = 1.5", () => {
    expect(zipfShare(1, 10000, 0.99)).toBeCloseTo(0.098, 3);
    expect(topShare(10, 10000, 0.99)).toBeCloseTo(0.289, 3);
    expect(zipfShare(1, 10000, 1.5)).toBeCloseTo(0.386, 3);
  });
  test("the Zipf demo: shard s1 takes 10,800 of 40,000 (27%), 2.15 times the mean", () => {
    const s = zipfShardSample(10000, 0.99, 8, 40000, 128, 4);
    const max = Math.max(...s.load);
    expect(s.load.indexOf(max)).toBe(1);
    expect(Math.round(max / 100) * 100).toBe(10800);
    expect(Math.round((max / 40000) * 100)).toBe(27);
    expect(r2(max / 5000)).toBe(2.15);
  });
  test("count-min size for 0.1% and 1%: 2,719 by 5, about 54 KB", () => {
    expect(cmsSize(0.001, 0.01)).toEqual({ w: 2719, d: 5 });
    expect(Math.round((2719 * 5 * 4) / 1000)).toBe(54);
  });
  test("mitigations", () => {
    const mean = HOT_DEFAULTS.rate / HOT_DEFAULTS.shards;
    const busy = (r: { perShard: number[] }) => r2(Math.max(...r.perShard) / mean);
    expect(busy(hotLoad({ mitigation: "none" }))).toBe(2.14);
    const split = hotLoad({ mitigation: "split", splits: 8 });
    expect(busy(split)).toBe(2.68);
    expect(r2(split.amplification)).toBe(1.62);
    expect(busy(hotLoad({ mitigation: "split", splits: 8, readFrac: 0.1 }))).toBe(1.4);
    expect(busy(hotLoad({ mitigation: "cache", hotKeys: 8 }))).toBe(0.96);
    const lam = HOT_DEFAULTS.rate * 0.9 * zipfShare(1, 10000, 0.99);
    expect(Math.round(lam)).toBe(8803);
    expect(Math.round(lam / (1 + lam * 0.002))).toBe(473);
  });
});
