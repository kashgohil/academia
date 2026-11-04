/** Condition variables: `if` fails under some schedule, and `while` never does. */
import { describe, expect, test } from "vitest";
import { allDone, checkCondvar, checkFutexCondvar, condvarProg, exec, initial, simulateHerd, type Notify } from "../../src/sims/os/sync";

const NOTIFY: Notify[] = ["signal", "broadcast"];

describe("if or while", () => {
  for (const notify of NOTIFY) {
    test(`if with ${notify} underflows in some schedule`, () => {
      expect(checkCondvar({ guard: "if", notify }).violation?.message).toContain("Underflow");
      expect(checkCondvar({ guard: "if", notify, scenario: "bounded" }).violation).not.toBeNull();
    });
    test(`while with ${notify} never underflows, in either program`, () => {
      expect(checkCondvar({ guard: "while", notify }).violation).toBeNull();
      expect(checkCondvar({ guard: "while", notify, scenario: "bounded" }).violation).toBeNull();
    });
    test(`while with ${notify} is fully correct with 2 consumers and 2 producers`, () => {
      expect(checkCondvar({ guard: "while", notify })).toMatchObject({ stuck: null, trapped: 0, truncated: false });
    });
    test(`while with ${notify} and 3 consumers is also correct`, () => {
      expect(checkCondvar({ guard: "while", notify, consumers: 3, producers: 3 })).toMatchObject({ violation: null, stuck: null, trapped: 0, truncated: false });
    });
  }
  test("the shortest bug schedule for if takes 14 steps", () => {
    expect(checkCondvar({ guard: "if", notify: "signal" }).violation?.schedule.length).toBe(14);
  });
});

describe("one condvar for two conditions", () => {
  test("while with signal gets stuck in 26 steps", () => {
    expect(checkCondvar({ guard: "while", notify: "signal", scenario: "bounded" }).stuck?.schedule.length).toBe(26);
  });
  test("while with broadcast is correct", () => {
    expect(checkCondvar({ guard: "while", notify: "broadcast", scenario: "bounded" })).toMatchObject({ violation: null, stuck: null, trapped: 0 });
  });
});

describe("variations", () => {
  test("Hoare handoff makes if correct", () => {
    expect(checkCondvar({ guard: "if", notify: "signal", hoare: true })).toMatchObject({ violation: null, stuck: null, trapped: 0 });
  });
  test("spurious wakeups break if with one consumer, and while holds", () => {
    const o = { notify: "signal" as const, spurious: true, consumers: 1 };
    expect(checkCondvar({ ...o, guard: "if" }).violation?.schedule.length).toBe(6);
    expect(checkCondvar({ ...o, guard: "while" })).toMatchObject({ violation: null, stuck: null, trapped: 0 });
  });
  test("spurious wakeups with 2 consumers: while still holds", () => {
    expect(checkCondvar({ guard: "while", notify: "signal", spurious: true })).toMatchObject({ violation: null, stuck: null });
  });
  test("a non-atomic wait loses a wakeup in 16 steps, even with while", () => {
    expect(checkCondvar({ guard: "while", notify: "signal", nonAtomicWait: true }).stuck?.schedule.length).toBe(16);
  });
});

describe("a condvar on a futex word", () => {
  test("with the value check, it never loses a wakeup", () => {
    expect(checkFutexCondvar(true)).toMatchObject({ violation: null, stuck: null, trapped: 0 });
  });
  test("without the check, it loses one in 10 steps", () => {
    expect(checkFutexCondvar(false).stuck?.schedule.length).toBe(10);
  });
});

describe("the thundering herd", () => {
  test("64 waiters", () => {
    expect(simulateHerd(64, "signal")).toMatchObject({ wakeups: 64, resleeps: 0, contextSwitches: 64, cpuNs: 128_000 });
    expect(simulateHerd(64, "broadcast")).toMatchObject({ wakeups: 2080, resleeps: 2016, contextSwitches: 4096, cpuNs: 8_192_000 });
  });
  test("wakeups follow W(W + 1)/2", () => {
    for (const w of [1, 2, 7, 16, 64]) expect(simulateHerd(w, "broadcast").wakeups).toBe((w * (w + 1)) / 2);
  });
  test("the machine gives the same counts as the formula", () => {
    for (const w of [2, 3, 4]) for (const notify of NOTIFY) {
      const p = condvarProg({ guard: "while", notify, consumers: w, producers: w });
      const s = initial(p);
      // All consumers go to sleep first.
      for (let t = 0; t < w; t++) for (let i = 0; i < 3; i++) exec(p, s, t);
      const settle = () => {
        for (let again = true; again;) {
          again = false;
          for (let t = 0; t < w; t++) while (exec(p, s, t)) again = true;
        }
      };
      for (let t = w; t < 2 * w; t++) {
        while (exec(p, s, t));
        settle();
      }
      expect(allDone(p, s)).toBe(true);
      const herd = simulateHerd(w, notify);
      expect(s.n.wakeups).toBe(herd.wakeups);
      expect(s.n.resleeps ?? 0).toBe(herd.resleeps);
    }
  });
});
