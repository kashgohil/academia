import { describe, expect, test } from "vitest";
import { blockingQueue, dieHard, dieHardExplain, dieHardSolvable, tlc, waitNames, type BQOptions } from "@/sims/conc/verification";

describe("DieHard", () => {
  test("quoted: 16 reachable states, and a shortest counterexample of 6 steps", () => {
    const full = tlc(dieHard(), { stopOnError: false });
    expect([full.distinct, full.generated, full.depth]).toEqual([16, 97, 7]);
    // The goal row first appears at BFS level 6.
    expect(Math.min(...full.nodes.filter((n) => n.state.big === 4).map((n) => n.depth))).toBe(6);
    // Jugs of 4 and 6 cannot measure 3: TLC visits 10 states and finds no error.
    const even = tlc(dieHard({ smallCap: 4, bigCap: 6, goal: 3 }));
    expect([even.distinct, even.violation]).toEqual([10, null]);
    const r = tlc(dieHard());
    expect(r.violation!.invariant).toBe("NotSolved");
    expect(r.violation!.trace.map((s) => s.action)).toEqual(["Init", "FillBigJug", "BigToSmall", "EmptySmallJug", "BigToSmall", "FillBigJug", "BigToSmall"]);
    expect(r.violation!.trace.at(-1)!.state).toEqual({ small: 3, big: 4 });
    expect(r.distinct).toBe(14);
  });

  test("every reachable state has one jug empty or full", () => {
    for (const n of tlc(dieHard(), { stopOnError: false }).nodes) {
      const { small, big } = n.state;
      expect(small === 0 || small === 3 || big === 0 || big === 5).toBe(true);
    }
  });

  test("quoted: the buggy pour breaks TypeOK after 3 steps", () => {
    const r = tlc(dieHard({ bug: true }));
    expect(r.violation!.invariant).toBe("TypeOK");
    expect(r.violation!.trace.length - 1).toBe(3);
    expect(r.violation!.trace.at(-1)!.state).toEqual({ small: 0, big: 8 });
  });

  test("solvable exactly when the goal is a multiple of the gcd", () => {
    for (let s = 1; s <= 5; s++) for (let b = s + 1; b <= 9; b++) for (let g = 1; g <= b; g++) {
      const r = tlc(dieHard({ smallCap: s, bigCap: b, goal: g }));
      expect(r.violation?.invariant === "NotSolved", `${s} ${b} ${g}`).toBe(dieHardSolvable(s, b, g));
    }
  });

  test("the formula view evaluates the primed variables", () => {
    expect(dieHardExplain("SmallToBig", { small: 3, big: 4 })).toEqual(["big' = Min(big + small, 5) = 5", "small' = small - (big' - big) = 2"]);
  });
});

describe("BlockingQueue", () => {
  const configs: BQOptions[] = [];
  for (const notify of ["one", "all"] as const) for (let P = 1; P <= 3; P++) for (let C = 1; C <= 3; C++) for (let K = 1; K <= 3; K++) configs.push({ producers: P, consumers: C, capacity: K, notify });

  test("quoted: 1 producer, 2 consumers, 1 slot, notify: deadlock after 7 steps", () => {
    const o: BQOptions = { producers: 1, consumers: 2, capacity: 1, notify: "one" };
    const r = tlc(blockingQueue(o));
    expect(r.deadlock!.trace.length - 1).toBe(7);
    const last = r.deadlock!.trace.at(-1)!.state;
    expect(waitNames(o, last.wait)).toEqual(["p1", "c1", "c2"]);
    expect(tlc(blockingQueue(o), { stopOnError: false }).distinct).toBe(14);
  });

  test("quoted: notify deadlocks in 11 of 27 configurations, exactly when P + C > 2K; notifyAll never", () => {
    let dl = 0;
    for (const o of configs) {
      const r = tlc(blockingQueue(o), { stopOnError: false });
      if (o.notify === "all") expect(r.deadlock).toBeNull();
      else {
        expect(!!r.deadlock, JSON.stringify(o)).toBe(o.producers + o.consumers > 2 * o.capacity);
        if (r.deadlock) dl++;
      }
      expect(r.violation).toBeNull();
    }
    expect(dl).toBe(11);
  });
});
