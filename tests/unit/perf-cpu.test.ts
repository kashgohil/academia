import { describe, expect, test } from "vitest";
import { mispredictRate, BRANCH_PATTERNS, branchyCost, branchlessCost, schedule, sumOps, vectorize, LOOPS } from "@/sims/perf/cpu";

const pat = (id: string) => BRANCH_PATTERNS.find((p) => p.id === id)!;

describe("branch prediction", () => {
  test("2-bit counters handle loop exits better than 1-bit", () => {
    expect(mispredictRate("one-bit", pat("loop8"))).toBeCloseTo(0.25, 2);
    expect(mispredictRate("two-bit", pat("loop8"))).toBeCloseTo(0.125, 2);
  });
  test("gshare learns the loop exit pattern from history", () => expect(mispredictRate("gshare", pat("loop8"))).toBeLessThan(0.01));
  test("only history-based prediction learns alternation and correlation", () => {
    expect(mispredictRate("two-bit", pat("alternate"))).toBeGreaterThan(0.4);
    expect(mispredictRate("gshare", pat("alternate"))).toBeLessThan(0.01);
    expect(mispredictRate("two-bit", pat("correlated"))).toBeGreaterThan(0.4);
    expect(mispredictRate("gshare", pat("correlated"))).toBeCloseTo(0.25, 1);
  });
  test("random data is unpredictable; sorted data is nearly free", () => {
    expect(mispredictRate("gshare", pat("random"), 0.5)).toBeGreaterThan(0.45);
    expect(mispredictRate("gshare", pat("sorted"))).toBeLessThan(0.01);
  });
  test("branchless wins once mispredicts exceed ~6%", () => {
    expect(branchyCost(0.05)).toBeLessThan(branchlessCost());
    expect(branchyCost(0.07)).toBeGreaterThan(branchlessCost());
  });
});

describe("instruction-level parallelism", () => {
  const cyc = (k: number, lanes = 1) => schedule(sumOps(256, k, lanes)).cycles;
  test("one accumulator is latency bound: ~4 cycles per element", () => expect(cyc(1) / 256).toBeGreaterThan(3.9));
  test("more accumulators help until latency × throughput (4 × 2 = 8)", () => {
    expect(cyc(2) / cyc(1)).toBeCloseTo(0.5, 1);
    expect(cyc(8) / 256).toBeLessThan(0.6);
    expect(cyc(16)).toBeGreaterThan(cyc(8) * 0.95);
  });
  test("SIMD multiplies throughput on top of accumulators", () => {
    const big = (k: number, lanes = 1) => schedule(sumOps(4096, k, lanes)).cycles;
    expect(big(8) / big(8, 8)).toBeGreaterThan(6); // 2068 vs 288 cycles
    expect(big(1) / big(8, 8)).toBeGreaterThan(50);
  });
});

describe("auto-vectorization", () => {
  test("FP reductions need permission to reassociate", () => {
    expect(vectorize("reduce", { noAlias: true, fastMath: false, float: true }).vectorized).toBe("no");
    expect(vectorize("reduce", { noAlias: true, fastMath: true, float: true }).vectorized).toBe("yes");
    expect(vectorize("reduce", { noAlias: true, fastMath: false, float: false }).vectorized).toBe("yes");
  });
  test("every loop has a verdict", () => {
    for (const l of LOOPS) expect(vectorize(l.id, { noAlias: false, fastMath: false, float: true }).reason.length).toBeGreaterThan(10);
  });
});
