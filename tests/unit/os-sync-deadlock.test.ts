/** Resource allocation graph, lockdep-style checker and banker's algorithm. */
import { describe, expect, test } from "vitest";
import {
  BANK_EXAMPLE, LOCKDEP_TRACES, Lockdep, bankerRequest, bankerSafety, bankerWorstCase, ragCycle, ragDeadlocked, ragFree, ragInit, ragRelease, ragRequest, realDeadlock, runLockdep, type Bank,
} from "../../src/sims/os/sync";

const T = ["T1", "T2", "T3"];

describe("resource allocation graph", () => {
  const one = () => ragInit(T, [{ id: "R1", units: 1 }, { id: "R2", units: 1 }, { id: "R3", units: 1 }]);
  test("AB-BA gives a cycle and a deadlock", () => {
    let g = one();
    g = ragRequest(g, "T1", "R1");
    g = ragRequest(g, "T2", "R2");
    expect(ragCycle(g)).toBeNull();
    g = ragRequest(g, "T1", "R2");
    expect(ragCycle(g)).toBeNull();
    g = ragRequest(g, "T2", "R1");
    expect(new Set(ragCycle(g))).toEqual(new Set(["T1", "R2", "T2", "R1"]));
    expect(ragDeadlocked(g).sort()).toEqual(["T1", "T2"]);
  });
  test("a release grants the oldest waiter", () => {
    let g = one();
    g = ragRequest(g, "T1", "R1");
    g = ragRequest(g, "T2", "R1");
    g = ragRequest(g, "T3", "R1");
    g = ragRelease(g, "T1", "R1");
    expect(g.held.T2!.R1).toBe(1);
    expect(g.waiting.T2).toBeNull();
    expect(g.waiting.T3).toBe("R1");
    expect(ragFree(g, "R1")).toBe(0);
  });
  test("a cycle with several units is not always a deadlock", () => {
    let g = ragInit(T, [{ id: "R1", units: 1 }, { id: "R2", units: 2 }, { id: "R3", units: 1 }]);
    g = ragRequest(g, "T1", "R1");
    g = ragRequest(g, "T2", "R2");
    g = ragRequest(g, "T3", "R2");
    g = ragRequest(g, "T1", "R2");
    g = ragRequest(g, "T2", "R1");
    expect(ragCycle(g)).not.toBeNull();
    expect(ragDeadlocked(g)).toEqual([]);
    g = ragRelease(g, "T3", "R2");
    expect(g.waiting.T1).toBeNull();
    expect(ragCycle(g)).toBeNull();
  });
});

describe("lockdep-style checker", () => {
  test("flags AB-BA although the run did not deadlock, and a schedule can deadlock in 2 steps", () => {
    const { trace } = LOCKDEP_TRACES.abba!;
    const d = runLockdep(trace);
    expect(d.reports.map((r) => r.kind)).toEqual(["circular"]);
    expect(trace[d.reports[0]!.at]).toMatchObject({ t: "T2", op: "lock", l: "A" });
    expect(realDeadlock(trace).stuck?.schedule.length).toBe(2);
  });
  test("finds a three-thread ring", () => {
    const d = runLockdep(LOCKDEP_TRACES.chain!.trace);
    expect(d.reports[0]?.kind).toBe("circular");
    expect(realDeadlock(LOCKDEP_TRACES.chain!.trace).stuck).not.toBeNull();
  });
  test("is silent on one global order, and the search agrees", () => {
    const { trace } = LOCKDEP_TRACES.ordered!;
    expect(runLockdep(trace).reports).toEqual([]);
    expect(realDeadlock(trace).stuck).toBeNull();
  });
  test("a gate lock is a false positive: a report with no reachable deadlock", () => {
    const { trace } = LOCKDEP_TRACES.gate!;
    expect(runLockdep(trace).reports.length).toBe(1);
    expect(realDeadlock(trace).stuck).toBeNull();
  });
  test("recursive locking and interrupt inversion", () => {
    const d = new Lockdep();
    d.feed({ t: "T", op: "lock", l: "A" });
    expect(d.feed({ t: "T", op: "lock", l: "A" })?.kind).toBe("recursive");
    expect(runLockdep(LOCKDEP_TRACES.irq!.trace).reports.map((r) => r.kind)).toEqual(["irq-inversion"]);
  });
  test("interrupts off in the task removes the interrupt report", () => {
    const d = runLockdep([
      { t: "T", op: "lock", l: "Q", irqsOn: false },
      { t: "T", op: "unlock", l: "Q" },
      { t: "irq", op: "lock", l: "Q", ctx: "irq" },
      { t: "irq", op: "unlock", l: "Q", ctx: "irq" },
    ]);
    expect(d.reports).toEqual([]);
  });
});

describe("banker's algorithm", () => {
  test("the example is safe with order P1, P3, P4, P0, P2, after 17 comparisons", () => {
    const c = bankerSafety(BANK_EXAMPLE);
    expect(c.safe).toBe(true);
    expect(c.sequence).toEqual([1, 3, 4, 0, 2]);
    expect(c.comparisons).toBe(17);
  });
  test("request outcomes", () => {
    expect(bankerRequest(BANK_EXAMPLE, 1, [1, 0, 2]).granted).toBe(true);
    expect(bankerRequest(BANK_EXAMPLE, 4, [3, 3, 0])).toMatchObject({ granted: false, reason: "unsafe" });
    expect(bankerRequest(BANK_EXAMPLE, 0, [8, 0, 0])).toMatchObject({ granted: false, reason: "exceeds-claim" });
    expect(bankerRequest(BANK_EXAMPLE, 2, [0, 0, 0]).granted).toBe(true);
    const after = bankerRequest(BANK_EXAMPLE, 1, [1, 0, 2]);
    if (!after.granted) throw new Error("expected a grant");
    expect(bankerRequest(after.bank, 4, [3, 3, 0])).toMatchObject({ granted: false, reason: "must-wait" });
  });
  test("the worst-case bound is 5,005,000 comparisons for 1000 processes and 10 resources", () => {
    expect(bankerWorstCase(1000, 10)).toBe(5_005_000);
  });
  test("the bound holds on an adversarial chain, where only the last process can finish first", () => {
    const n = 12;
    const b: Bank = {
      available: [1, 0, 0],
      alloc: Array.from({ length: n }, () => [1, 0, 0]),
      max: Array.from({ length: n }, (_, i) => [n - i + 1, 0, 0]),
    };
    const c = bankerSafety(b);
    expect(c.safe).toBe(true);
    expect(c.sequence).toEqual(Array.from({ length: n }, (_, i) => n - 1 - i));
    expect(c.comparisons).toBeLessThanOrEqual(bankerWorstCase(n, 3));
  });
});
