import { describe, expect, test } from "vitest";
import { explore, initial, exec, type MState } from "@/sims/os/sync/machine";
import {
  GRID_PRESETS, allSchedules, countStates, explosionProg, huntBfs, huntPct, huntPreemption, huntRandom, multinomial,
  pctBound, schedulesExact, sleepSetSearch, ticketModel, ticketProg, ticketTotalSteps, traceSummary, tracesFormula,
  type ExplosionKind,
} from "@/sims/conc/verification";

describe("the state explosion", () => {
  test("(nk)!/(k!)^n schedules, checked against enumeration", () => {
    expect(schedulesExact(2, 3)).toBe(20n);
    expect(schedulesExact(3, 4)).toBe(34_650n);
    expect(schedulesExact(4, 6)).toBe(2_308_743_493_056n);
    for (const [n, k] of [[2, 2], [2, 4], [3, 2], [3, 3]] as const) {
      expect(BigInt(allSchedules(explosionProg("private", n, k)).length)).toBe(schedulesExact(n, k));
    }
  });

  test("distinct states with hashing (quoted: 3 threads of 4 steps, and 4 of 6)", () => {
    expect(countStates(explosionProg("private", 3, 4))).toBe(125);
    expect(countStates(explosionProg("shared", 3, 4))).toBe(301);
    expect(countStates(explosionProg("private", 4, 6))).toBe(2401);
    expect(countStates(explosionProg("shared", 4, 6))).toBe(8233);
    // Private steps: every combination of program counters, (k+1)^n.
    expect(countStates(explosionProg("private", 3, 3))).toBe(4 ** 3);
  });

  test("traces: the formula, the enumeration and the sleep-set search agree", () => {
    for (const kind of ["private", "shared", "mixed"] as ExplosionKind[]) {
      for (const [n, k] of [[2, 2], [2, 3], [3, 2], [3, 3], [2, 4]] as const) {
        const p = explosionProg(kind, n, k);
        const f = tracesFormula(kind, n, k);
        expect(BigInt(traceSummary(p).traces)).toBe(f);
        expect(BigInt(sleepSetSearch(p).complete)).toBe(f);
      }
    }
    expect(multinomial([2, 2, 2])).toBe(90n);
  });

  test("quoted: mixed steps, 3 threads of 4 steps: 90 traces; sleep sets alone hit 595 dead ends", () => {
    expect(tracesFormula("mixed", 3, 4)).toBe(90n);
    const r = sleepSetSearch(explosionProg("mixed", 3, 4));
    expect([r.complete, r.blocked]).toEqual([90, 595]);
    expect(sleepSetSearch(explosionProg("private", 3, 4)).complete).toBe(1);
  });
});

describe("the interleaving grid", () => {
  test("quoted: 70 schedules; traces and outcomes per preset", () => {
    const got = Object.fromEntries(Object.entries(GRID_PRESETS).map(([k, g]) => {
      const s = traceSummary(g.prog);
      return [k, [s.schedules, s.traces, s.outcomes, sleepSetSearch(g.prog).complete]];
    }));
    expect(got).toEqual({ private: [70, 1, 1, 1], message: [70, 3, 3, 3], counter: [70, 4, 4, 4], all: [70, 70, 2, 70] });
  });
});

describe("the bug hunt on the ticket dispenser", () => {
  test("the fast model and the machine program agree on the counterexample", () => {
    for (const [n, pad] of [[2, 2], [3, 4]] as const) {
      const b = huntBfs(n, pad);
      const p = ticketProg(n, pad);
      const s: MState = initial(p);
      for (const id of b.counterexample!) expect(exec(p, s, Number(id.slice(1)))).toBe(true);
      expect(s.th.every((th) => th.r.t === 0)).toBe(true);
      // The machine program has as many states as the fast model is not required, but both find the bug.
      expect(explore({ ...ticketModel(n, pad) }).violation).not.toBeNull();
    }
  });

  test("the bug needs n - 1 preemptions", () => {
    for (const n of [2, 3, 4]) {
      expect(huntPreemption(n, 0, n - 2).firstBug).toBe(-1);
      expect(huntPreemption(n, 0, n - 1).firstBug).toBeGreaterThan(0);
    }
  });

  test("quoted: 3 threads, stagger 4", () => {
    const b = huntBfs(3, 4);
    expect([b.tried, b.counterexample!.length]).toEqual([336, 18]);
    const pb = [0, 1, 2].map((c) => huntPreemption(3, 4, c));
    expect(pb.map((r) => [r.tried, r.firstBug])).toEqual([[6, -1], [96, -1], [896, 128]]);
    expect(huntRandom(3, 4, 1000).failures).toBe(4);
    expect(huntPct(3, 4, 3, 1000).failures).toBe(11);
    expect(ticketTotalSteps(3, 4)).toBe(18);
    expect(pctBound(3, 18, 3)).toBeCloseTo(1 / 972, 12);
  });

  test("quoted: 3 threads, stagger 0 and 6", () => {
    expect(huntRandom(3, 0, 1000).failures).toBe(220);
    expect(huntRandom(3, 6, 1000).failures).toBe(0);
    expect(huntPct(3, 6, 3, 1000).failures).toBe(4);
    expect(huntPreemption(3, 6, 2).firstBug).toBeGreaterThan(0);
  });

  test("quoted: mixed steps with 4 threads of 6 steps", () => {
    expect(countStates(explosionProg("mixed", 4, 6))).toBe(8233);
    expect(tracesFormula("mixed", 4, 6)).toBe(369_600n);
  });

  test("random walks fade with the stagger; PCT stays above its bound", () => {
    const rand = [0, 4, 8].map((pad) => huntRandom(2, pad, 1000).failures!);
    expect(rand).toEqual([498, 98, 14]);
    for (const pad of [0, 4, 8]) {
      const k = ticketTotalSteps(2, pad);
      expect(huntPct(2, pad, 2, 1000).failures! / 1000).toBeGreaterThan(pctBound(2, k, 2));
    }
  });
});
