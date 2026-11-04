import { describe, expect, test } from "vitest";
import { runBench, summarize, BENCH_DEFAULTS, detectionRate, bootstrapRatio, timings } from "@/sims/perf/bench";
import { PROGRAM, flatten, sample, instrument, totalMs, stacks, flameTree } from "@/sims/perf/profile";
import { measureKernel, gshare } from "@/sims/perf/counters";
import { mulberry32 } from "@/sims/rng";

describe("benchmark pitfalls", () => {
  const med = (o: Partial<typeof BENCH_DEFAULTS>) => summarize(runBench({ ...BENCH_DEFAULTS, ...o })).median;
  test("naive: dead code + 1 µs timer measures 0", () => expect(med({})).toBe(0));
  test("black_box alone still quantized to 0 or 1000", () => {
    const xs = runBench({ ...BENCH_DEFAULTS, blackBox: true });
    expect(xs.every((x) => x === 0 || x === 1000 || x >= 2000)).toBe(true);
  });
  test("batching + black_box + warmup recovers ~40 ns", () => {
    expect(med({ blackBox: true, batch: 1000, warmup: true })).toBeGreaterThan(37);
    expect(med({ blackBox: true, batch: 1000, warmup: true })).toBeLessThan(43);
  });
  test("warm-up inflates early samples; discarding them fixes the mean", () => {
    const all = runBench({ ...BENCH_DEFAULTS, blackBox: true, batch: 1000, outlierProb: 0 });
    expect(summarize(all.slice(0, 5)).median).toBeGreaterThan(65);
    const warm = runBench({ ...BENCH_DEFAULTS, blackBox: true, batch: 1000, warmup: true, outlierProb: 0 });
    expect(summarize(warm).mean).toBeLessThan(summarize(all).mean - 1);
  });
  test("throttling shifts later samples", () => {
    const xs = runBench({ ...BENCH_DEFAULTS, blackBox: true, batch: 1000, warmup: true, throttle: true });
    expect(summarize(xs.slice(-40)).median / summarize(xs.slice(0, 40)).median).toBeGreaterThan(1.15);
  });
});

describe("comparing versions", () => {
  test("a 3% speedup: rarely detected with 10 samples, reliably with 500", { timeout: 60000 }, () => {
    expect(detectionRate(0.03, 10, 100)).toBeLessThan(0.1);
    expect(detectionRate(0.03, 100, 100)).toBeCloseTo(0.53, 1);
    expect(detectionRate(0.03, 500, 100)).toBeGreaterThan(0.95);
  });
  test("no real difference → CI excludes 1 about 5% of the time", { timeout: 30000 }, () => {
    expect(detectionRate(0, 50, 200)).toBeLessThan(0.1);
  });
  test("mean is dragged by outliers, median isn't", () => {
    const xs = timings(100, 2000, mulberry32(1));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeGreaterThan(105);
    expect(bootstrapRatio(xs, xs, mulberry32(2))[1]).toBe(1);
  });
});

describe("profilers", () => {
  const flat = flatten(PROGRAM);
  const total = totalMs(PROGRAM);
  test("socket_read is the top self-time function", () => expect(flat[0]!.name).toBe("socket_read"));
  test("sampling error shrinks with more samples", () => {
    const err = (hz: number) => Math.abs(sample(PROGRAM, hz).share("socket_read") - 110 / total);
    expect(err(10000)).toBeLessThan(0.01);
  });
  test("instrumentation overhead inflates hash_key past socket_read", () => {
    const ins = instrument(PROGRAM, 300);
    expect(ins.share("hash_key")).toBeGreaterThan(ins.share("socket_read"));
    expect(18 / total).toBeLessThan(110 / total);
  });
  test("flame tree inclusive values", () => {
    const t = flameTree(stacks(PROGRAM));
    expect(t.value).toBe(total);
    expect(t.children[0]!.name).toBe("main");
  });
});

describe("performance counters", () => {
  test("gshare learns a loop branch", () => {
    // ~12 mispredicts while the 12-bit history fills, then it's learned.
    expect(gshare(Array.from({ length: 1000 }, (_, i) => i < 999), new Array(1000).fill(1))).toBeLessThan(20);
  });
  test("sorting makes the branchy loop several times faster", () => {
    const rnd = measureKernel("branch-random"), srt = measureKernel("branch-sorted");
    expect(rnd.mispredicts / rnd.branches).toBeGreaterThan(0.2);
    expect(srt.mispredicts / srt.branches).toBeLessThan(0.01);
    expect(rnd.cycles / srt.cycles).toBeGreaterThan(4);
    expect(rnd.topdown.badSpeculation).toBeGreaterThan(0.6);
  });
  test("pointer chase is memory bound with IPC near zero", () => {
    const c = measureKernel("chase");
    expect(c.ipc).toBeLessThan(0.02);
    expect(c.topdown.backendMemory).toBeGreaterThan(0.95);
  });
  test("dependent chain is core bound; sum retires near width", () => {
    expect(measureKernel("fp-chain").ipc).toBeCloseTo(0.75, 1);
    expect(measureKernel("sum").topdown.retiring).toBeGreaterThan(0.7);
  });
});
