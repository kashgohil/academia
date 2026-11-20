/** Pins every number that the patterns lessons quote (fork-join, work stealing, map-reduce, pipelines, false sharing). */
import { describe, expect, test } from "vitest";
import {
  PIPE_DEFAULTS, algoWorkSpan, bounds, chunkedSum, coherenceRun, grainPoint, grains, greedy, makeValues, pairwiseSum, rangeCost,
  referenceSum, runParallelFor, runPipeline, runReduction, runSharing, shuffleLoad, stageRate, sumDag, workSpan,
  type FsAccess, type GrainPoint, type ShareMode,
} from "@/sims/conc/patterns";

const close = (a: number, b: number, eps = 0.01) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("fork-join: work, span and greedy schedules", () => {
  const C = { elem: 1, spawn: 1, join: 1 };

  test("the DAG demo default: n = 32, grain 4, P = 2", () => {
    const d = sumDag(32, 4, C);
    const ws = workSpan(d);
    // 8 leaves of 4, 7 splits, 7 joins: 32 + 7 + 7 = 46. Span: 3 splits + one leaf of 4 + 3 joins = 10.
    expect(ws.work).toBe(46);
    expect(ws.span).toBe(10);
    close(ws.parallelism, 4.6);
    const s = greedy(d, 2);
    expect(s.makespan).toBe(26);
    expect(bounds(ws, 2)).toEqual({ lower: 23, brent: 33 });
    // With 8 cores the span is the limit: T_P = T∞ = 10.
    expect(greedy(d, 8).makespan).toBe(10);
    // Grain 32: one leaf, no parallelism.
    const one = workSpan(sumDag(32, 32, C));
    expect([one.work, one.span]).toEqual([32, 32]);
  });

  test("every greedy schedule meets Brent's bound and the lower bound", () => {
    for (const g of [1, 2, 4, 8, 16, 32]) for (const P of [1, 2, 3, 5, 8]) for (const spawn of [0, 1, 3]) for (const order of ["lifo", "fifo"] as const) {
      const d = sumDag(32, g, { elem: 1, spawn, join: 1 });
      const ws = workSpan(d);
      const T = greedy(d, P, order).makespan;
      const b = bounds(ws, P);
      expect(T).toBeGreaterThanOrEqual(b.lower - 1e-9);
      expect(T).toBeLessThanOrEqual(b.brent + 1e-9);
      // Graham's sharper form.
      expect(T).toBeLessThanOrEqual((ws.work - ws.span) / P + ws.span + 1e-9);
    }
  });

  test("a schedule respects the DAG edges and uses each core for one node at a time", () => {
    const d = sumDag(32, 2, C);
    const s = greedy(d, 3);
    for (const v of d.nodes) for (const p of v.pred) expect(s.slots[v.id]!.start).toBeGreaterThanOrEqual(s.slots[p]!.end);
    for (let p = 0; p < 3; p++) {
      const mine = s.slots.filter((x) => x.proc === p && x.end > x.start).sort((a, b) => a.start - b.start);
      for (let i = 1; i < mine.length; i++) expect(mine[i]!.start).toBeGreaterThanOrEqual(mine[i - 1]!.end);
    }
  });

  test("grain size against spawn cost: 2^20 elements on 8 cores", () => {
    const sweep = (spawn: number) => grains(1 << 20, 64).map((g) => grainPoint(1 << 20, g, 8, { elem: 1, spawn, join: 0 }));
    const best = (pts: GrainPoint[]) => pts.reduce((a, p) => (p.speedup > a.speedup ? p : a));
    const s200 = sweep(200);
    expect(s200[0]!.grain).toBe(64);
    close(s200[0]!.speedup, 1.94);
    close(s200[4]!.speedup, 6.68); // grain 1,024
    expect(best(s200).grain).toBe(131_072);
    expect(best(s200).tasks).toBe(8);
    close(best(s200).speedup, 7.96);
    expect(s200[s200.length - 1]!.speedup).toBe(1);
    const s1us = sweep(1_000);
    close(s1us[0]!.speedup, 0.48);
    close(s1us[4]!.speedup, 4.02);
    const s20us = sweep(20_000);
    close(s20us[4]!.speedup, 0.38);
  });

  test("parallelism of three algorithms at n = 2^20", () => {
    const sum = algoWorkSpan("sum", 2 ** 20);
    expect(sum.span).toBe(21);
    expect(Math.round(sum.parallelism)).toBe(99_864);
    const serial = algoWorkSpan("mergesort-serial-merge", 2 ** 20);
    close(serial.parallelism, 10.5);
    expect(serial.span).toBe(2 * 2 ** 20 - 1);
    expect(Math.round(algoWorkSpan("mergesort-parallel-merge", 2 ** 20).parallelism)).toBe(6_302);
    close(algoWorkSpan("mergesort-serial-merge", 2 ** 30).parallelism, 15.5);
  });
});

describe("work stealing on the Runtime", () => {
  test("every mode runs every item exactly once and ends cleanly", () => {
    for (const mode of ["static", "central", "steal"] as ShareMode[]) for (const skew of ["uniform", "triangular"] as const) {
      const r = runSharing({ mode, skew, workers: 5, n: 4_096, grain: 64, record: false });
      expect(r.run.error).toBeUndefined();
      expect(r.run.deadlock).toBeUndefined();
      expect(r.run.done).toBe(true);
      const busy = r.run.threads.reduce((a, t) => a + t.runNs, 0);
      expect(busy).toBeGreaterThanOrEqual(r.serialNs - 1e-6);
    }
    // The triangular weights keep the mean at 1.
    expect(rangeCost({ lo: 0, hi: 1_000 }, 1_000, "triangular", 10)).toBeCloseTo(rangeCost({ lo: 0, hi: 1_000 }, 1_000, "uniform", 10) - 10, 6);
  });

  test("the deque stepper default: 3 workers, 128 items, grain 8", () => {
    const r = runSharing({ mode: "steal", workers: 3, owner: "lifo", n: 128, grain: 8, itemNs: 100, spawnNs: 50, stealNs: 300, trace: true, seed: 3 });
    expect([r.leaves, r.steals, r.failedSteals, r.maxDeque]).toEqual([16, 4, 6, 4]);
    close(r.speedup, 2.27);
    // The first steal takes the oldest task of W0: the right half of the whole loop.
    const first = r.events.find((e) => e.kind === "steal")!;
    expect(first.task).toEqual({ lo: 64, hi: 128 });
    expect(first.victim).toBe(0);
  });

  test("static against central queue against stealing, 8 workers", () => {
    const sp = (mode: ShareMode, grain: number, skew: "uniform" | "triangular", workers = 8) => runSharing({ mode, workers, grain, skew, record: false }).speedup;
    close(sp("static", 256, "triangular"), 4.27);
    close(sp("central", 256, "triangular"), 6.91);
    close(sp("steal", 256, "triangular"), 7.28);
    expect(sp("static", 256, "uniform")).toBe(8);
    close(sp("central", 16, "uniform"), 0.94);
    close(sp("steal", 16, "uniform"), 5.84);
    close(sp("central", 16, "uniform", 16), 0.92);
    close(sp("steal", 16, "uniform", 16), 10.97);
    close(sp("steal", 4_096, "triangular"), 5.26);
  });

  test("the owner's end decides the deque length", () => {
    const lifo = runSharing({ owner: "lifo", record: false });
    const fifo = runSharing({ owner: "fifo", record: false });
    expect(lifo.maxDeque).toBe(7);
    expect(fifo.maxDeque).toBe(23);
    // LIFO: at most one pending task per level of the split tree, log2(65536 / 256) = 8 levels.
    expect(lifo.maxDeque).toBeLessThanOrEqual(8);
    expect(lifo.steals).toBe(36);
    close(lifo.speedup, 7.48);
  });
});

describe("map-reduce", () => {
  const v = makeValues(1 << 20);
  const ref = referenceSum(v);

  test("a float32 sum depends on the number of chunks", () => {
    close(chunkedSum(v, 1) - ref, -11.532, 0.001);
    close(chunkedSum(v, 2) - ref, 0.062, 0.001);
    close(chunkedSum(v, 8) - ref, -0.032, 0.001);
    expect(chunkedSum(v, 1)).not.toBe(chunkedSum(v, 2));
    expect(new Set([1, 2, 4, 8, 16, 32, 64].map((p) => chunkedSum(v, p))).size).toBe(7);
    // Kahan inside the chunks makes the error tiny and almost independent of P.
    expect(Math.abs(chunkedSum(v, 1, "tree", true) - ref)).toBeLessThan(0.001);
    expect(Math.abs(pairwiseSum(v) - ref)).toBeLessThan(0.05);
  });

  test("combine strategies on the Runtime: 65,536 items of 20 ns", () => {
    const run = (strategy: "shared" | "linear" | "tree", partialSize: number, threads: number) => runReduction({ strategy, partialSize, threads, record: false });
    close(run("shared", 1, 1).speedup, 0.5);
    close(run("shared", 1, 16).speedup, 0.17);
    // 65,536 updates × (20 ns lock + 100 ns line transfer), one at a time.
    close(run("shared", 1, 16).makespan, 65_536 * 120, 100);
    close(run("linear", 1, 32).speedup, 29.28);
    close(run("tree", 1, 32).speedup, 19.87);
    const lin = run("linear", 4_096, 32), tree = run("tree", 4_096, 32);
    close(lin.makespan / 1_000, 306.8, 0.1);
    close(tree.makespan / 1_000, 106.9, 0.1);
    close(lin.speedup, 4.27);
    close(tree.speedup, 12.26);
  });

  test("key skew in the shuffle", () => {
    const hot = shuffleLoad({ zipf: 1, reducers: 16 });
    expect(hot.hottest).toBe(13_460);
    close(hot.imbalance, 2.94);
    close(hot.speedup, 5.44);
    const many = shuffleLoad({ zipf: 1, reducers: 64 });
    close(many.speedup, 6.94);
    // The hottest key alone bounds the busiest reducer.
    expect(many.max).toBeGreaterThanOrEqual(many.hottest);
    const comb = shuffleLoad({ zipf: 1, reducers: 16, combiner: true });
    expect(comb.total).toBe(12_936);
    close(comb.speedup, 12.61);
    close(shuffleLoad({ zipf: 0, reducers: 16 }).imbalance, 1.21);
  });
});

describe("pipelines", () => {
  const stages = (reps: number[]) => PIPE_DEFAULTS.stages.map((s, i) => ({ ...s, replicas: reps[i]! }));

  test("throughput is the slowest stage; replicas move the bottleneck", () => {
    const a = runPipeline({ stages: stages([1, 1, 1, 1]) });
    expect(a.run.done).toBe(true);
    close(a.throughput, 16_667, 1);
    close(a.predicted, 16_667, 1);
    expect(a.bottleneck).toBe(1);
    expect(a.minLatency).toBe(120_000);
    close(a.meanLatency / 1_000, 436.1, 0.1);
    const b = runPipeline({ stages: stages([1, 2, 1, 1]) });
    close(b.throughput, 33_333, 1);
    const c = runPipeline({ stages: stages([1, 3, 1, 1]) });
    expect(c.bottleneck).toBe(2); // encode, 30 µs
    close(c.throughput, 33_333, 1);
    const d = runPipeline({ stages: stages([1, 3, 2, 1]) });
    close(d.throughput, 50_000, 1);
    expect(stageRate({ name: "x", costNs: 60_000, replicas: 3 }, 1, 0)).toBe(50_000);
  });

  test("bigger queues add latency, not throughput, when the source floods", () => {
    const lat = [0, 2, 8].map((capacity) => runPipeline({ capacity }));
    for (const r of lat) close(r.throughput, 16_667, 1);
    expect(lat.map((r) => Math.round(r.meanLatency / 100) / 10)).toEqual([222.4, 436.1, 916.1]);
  });

  test("ordered output, jitter and live tokens", () => {
    const st = [{ name: "decode", costNs: 10_000, replicas: 1 }, { name: "transform", costNs: 60_000, replicas: 4, jitter: 1 }, { name: "write", costNs: 10_000, replicas: 1 }];
    const run = (ordered: boolean, tokens: number) => runPipeline({ stages: st, ordered, tokens, items: 400, sourceNs: 20_000, capacity: 4, record: false });
    const un = run(false, 0), ord = run(true, 0), ordTok = run(true, 8);
    close(un.meanLatency / 1_000, 109.2, 0.1);
    close(ord.meanLatency / 1_000, 167.6, 0.1);
    close(un.p99Latency / 1_000, 332.9, 0.1);
    close(ord.p99Latency / 1_000, 384.0, 0.1);
    expect(ord.reorderMax).toBe(18);
    expect(un.outOfOrder).toBe(269);
    close(ordTok.throughput, 38_183, 1);
    close(un.throughput, 49_428, 1);
    // Ordered output leaves in sequence.
    expect(ord.reorderMax).toBeGreaterThan(0);
  });

  test("batching: fewer handoffs, longer waits", () => {
    const run = (batch: number) => runPipeline({ stages: [{ name: "a", costNs: 2_000, replicas: 1 }, { name: "b", costNs: 2_000, replicas: 1 }], batch, handoffNs: 3_000, items: 512, capacity: 2, record: false });
    const b1 = run(1), b128 = run(128);
    close(b1.throughput, 200_392, 1);
    close(b128.throughput, 494_208, 1);
    close(b1.meanLatency / 1_000, 29.5, 0.1);
    close(b128.meanLatency / 1_000, 920, 0.1);
    // The model: 2 µs + 3 µs / batch per item.
    expect(b1.predicted).toBe(200_000);
  });
});

describe("false sharing", () => {
  const counters = (spacing: number, lineBytes = 64) =>
    coherenceRun({
      fields: [0, 1, 2, 3].map((i) => ({ name: `c${i}`, offset: spacing * i, bytes: 8 })),
      threads: [0, 1, 2, 3].map((i): FsAccess[] => [{ field: `c${i}`, write: true }]),
      lineBytes,
    });

  test("per-thread counters: adjacent, padded to 64, and 128-byte pairs", () => {
    const adj = counters(8), pad = counters(64), pair = counters(64, 128);
    close(adj.total, 10, 0.05);
    close(adj.ideal, 1_333.3, 0.1);
    expect(adj.missRate).toBe(1);
    close(pad.total, 1_311.7, 0.1);
    close(pair.total, 20, 0.05);
  });

  test("padding does not fix true sharing (queue indices); it fixes a read-mostly field", () => {
    const spsc = (off: number) => coherenceRun({
      fields: [{ name: "head", offset: 0, bytes: 8 }, { name: "tail", offset: off, bytes: 8 }],
      threads: [[{ field: "tail", write: true }, { field: "head", write: false }], [{ field: "head", write: true }, { field: "tail", write: false }]],
    });
    close(spsc(8).total, 13.3, 0.05);
    close(spsc(64).total, 19.6, 0.05);
    expect(spsc(64).missRate).toBe(1);
    const stats = (lay: number[]) => coherenceRun({
      fields: [{ name: "config", offset: lay[0]!, bytes: 8 }, { name: "requests", offset: lay[1]!, bytes: 8 }, { name: "errors", offset: lay[2]!, bytes: 8 }],
      threads: [[{ field: "config", write: false }, { field: "requests", write: true }], [{ field: "config", write: false }, { field: "errors", write: true }], [{ field: "config", write: false }]],
    });
    close(stats([0, 8, 16]).total, 13.3, 0.05);
    close(stats([0, 64, 128]).total, 952.5, 0.1);
  });

  test("a parallel loop: chunks smaller than a line share every line", () => {
    const r1 = runParallelFor({ chunk: 1, threads: 4, n: 8_192, record: false });
    close(r1.speedup, 0.16);
    expect(r1.sharedLines).toBe(1_024);
    const r4 = runParallelFor({ chunk: 4, threads: 4, n: 8_192, record: false });
    close(r4.speedup, 0.77);
    const r8 = runParallelFor({ chunk: 8, threads: 4, n: 8_192, record: false });
    expect(r8.speedup).toBe(4);
    expect(r8.transfers).toBe(0);
    expect(r8.sharedLines).toBe(0);
    expect(runParallelFor({ chunk: 8, threads: 8, n: 8_192, record: false }).speedup).toBe(8);
  });
});
