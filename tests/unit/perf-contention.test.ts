import { describe, expect, test } from "vitest";
import { falseSharing, simulateLock, LOCK_DEFAULTS, type Span } from "@/sims/perf/contention";

const run = (kind: Parameters<typeof simulateLock>[0]["kind"], threads: number, extra: Partial<typeof LOCK_DEFAULTS> = {}) => simulateLock({ ...LOCK_DEFAULTS, ...extra, kind, threads });

// Numbers quoted in the concurrency-performance lessons.
describe("false sharing", () => {
  test("packed counters do not scale; padded counters scale linearly", () => {
    expect(falseSharing(8, false).opsPerUs).toBeCloseTo(falseSharing(2, false).opsPerUs, 0);
    expect(falseSharing(8, true).opsPerUs / falseSharing(1, true).opsPerUs).toBeCloseTo(8, 0);
    expect(falseSharing(8, true).opsPerUs / falseSharing(8, false).opsPerUs).toBeGreaterThan(60);
  });
});

describe("contention", () => {
  test("one shared cache line caps throughput; sharding scales", () => {
    expect(run("atomic", 8)).toBeCloseTo(25, 0);
    expect(run("sharded", 8)).toBeGreaterThan(30);
    expect(run("sharded", 8) / run("sharded", 1)).toBeCloseTo(8, 0);
  });
  test("test-and-set degrades past 4 threads; TTAS degrades less", () => {
    expect(run("tas", 8)).toBeLessThan(run("tas", 4) * 0.6);
    expect(run("ttas", 8)).toBeGreaterThan(run("tas", 8) * 1.5);
  });
});

describe("preemption", () => {
  test("a descheduled holder stalls lock users; lock-free is unaffected", () => {
    expect(run("mutex", 8, { preempt: 0.01 })).toBeLessThan(run("mutex", 8) / 5);
    expect(run("lockfree-queue", 8, { preempt: 0.01 })).toBe(run("lockfree-queue", 8));
  });
  test("traces record waits during a forced preemption", () => {
    const trace: Span[] = [];
    simulateLock({ ...LOCK_DEFAULTS, kind: "mutex", threads: 4, opsPerThread: 20, forcePreemptAt: 10 }, 1, trace);
    expect(trace.some((s) => s.kind === "preempted")).toBe(true);
    expect(trace.filter((s) => s.kind === "wait").some((s) => s.to - s.from > 10_000)).toBe(true);
  });
});
