import { describe, expect, test } from "vitest";
import { stress, makeWorld, stallExperiment, type Scenario } from "@/sims/lockfree/scenario";
import type { Options, Scheme } from "@/sims/lockfree/machine";

const opts = (scheme: Scheme, tags = false): Options => ({ scheme, tags, threshold: 2, pool: 16 });
const STACK: Scenario = { kind: "stack", initial: [1, 2, 3], threads: [[{ kind: "pop" }, { kind: "push", v: 10 }, { kind: "pop" }], [{ kind: "pop" }, { kind: "pop" }, { kind: "push", v: 20 }, { kind: "push", v: 21 }], [{ kind: "push", v: 30 }, { kind: "pop" }]] };
const QUEUE: Scenario = { kind: "queue", initial: [1, 2], threads: [[{ kind: "deq" }, { kind: "enq", v: 10 }, { kind: "deq" }], [{ kind: "enq", v: 20 }, { kind: "deq" }, { kind: "enq", v: 21 }], [{ kind: "deq" }, { kind: "enq", v: 30 }]] };

// Claims quoted in the lock-free lessons.
describe("stress", { timeout: 60000 }, () => {
  test("leaking, hazard pointers and EBR are always correct", () => {
    for (const sc of [STACK, QUEUE]) for (const s of ["leak", "hazard", "epoch"] as Scheme[]) expect(stress(sc, opts(s), 500).anyViolation, `${sc.kind} ${s}`).toBe(0);
  });
  test("immediate free breaks the stack; tags remove corruption but not use-after-free", () => {
    const raw = stress(STACK, opts("immediate"), 1000);
    expect(raw.byKind["lost-or-duplicated"]).toBeGreaterThan(50);
    const tagged = stress(STACK, opts("immediate", true), 1000);
    expect(tagged.byKind["use-after-free"]).toBeGreaterThan(500);
    expect(tagged.byKind["lost-or-duplicated"] ?? 0).toBe(0);
    expect(tagged.byKind.corruption ?? 0).toBe(0);
  });
  test("queue with immediate free reads freed nodes", () => {
    expect(stress(QUEUE, opts("immediate"), 500).byKind["use-after-free"]).toBeGreaterThan(50);
  });
});

describe("ABA schedule", () => {
  const run = (tags: boolean) => {
    const w = makeWorld({ kind: "stack", initial: [1, 2, 3], threads: [[{ kind: "pop" }], [{ kind: "pop" }, { kind: "pop" }, { kind: "push", v: 7 }, { kind: "push", v: 8 }]] }, opts("immediate", tags));
    while (!w.threads[0]!.next!.startsWith("CAS")) w.step(0);
    while (w.threads[1]!.next) w.step(1);
    while (w.threads[0]!.next) w.step(0);
    w.finalize();
    return w;
  };
  test("without tags: T0 returns 1 again and 8 is lost", () => {
    const w = run(false);
    expect(w.threads[0]!.results).toEqual([1]);
    expect(w.violations.map((v) => v.kind)).toContain("lost-or-duplicated");
  });
  test("with tags: T0's CAS fails, it retries and pops 8", () => {
    const w = run(true);
    expect(w.threads[0]!.results).toEqual([8]);
    expect(w.violations).toEqual([]);
  });
});

describe("stalled thread", () => {
  const last = (s: Scheme) => stallExperiment({ scheme: s, tags: true, threshold: 4, pool: 600 }).at(-1)![1];
  test("EBR holds memory like a leak; hazard pointers stay bounded", () => {
    expect(last("epoch")).toBeGreaterThan(100);
    expect(last("leak")).toBeGreaterThan(100);
    const hp = stallExperiment({ scheme: "hazard", tags: true, threshold: 4, pool: 600 });
    expect(Math.max(...hp.map((p) => p[1]))).toBeLessThanOrEqual(8);
  });
});
