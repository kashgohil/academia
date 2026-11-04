/** Futexes: the exhaustive checks and the quoted numbers. */
import { describe, expect, test } from "vitest";
import {
  FUTEX_FAST_SCHEDULE, FUTEX_SLOW_SCHEDULE, FutexTable, allDone, checkFutexMutex, futexLoad, futexMutexProg, machineModel, replay,
  type MutexVariant,
} from "../../src/sims/os/sync";

const VARIANTS: MutexVariant[] = ["two-state", "three-state"];

describe("the correct futex mutex never loses a wakeup", () => {
  for (const variant of VARIANTS) {
    for (const [threads, rounds] of [[2, 1], [2, 2], [3, 1]] as const) {
      test(`${variant}, ${threads} threads, ${rounds} round(s)`, () => {
        const r = checkFutexMutex({ variant, check: true, threads, rounds });
        expect(r).toMatchObject({ violation: null, stuck: null, trapped: 0, truncated: false });
      });
    }
  }
});

describe("without the value check, a wakeup can be lost", () => {
  for (const variant of VARIANTS) {
    test(variant, () => {
      const r = checkFutexMutex({ variant, check: false });
      expect(r.stuck).not.toBeNull();
      // The bug is a lost wakeup, not a failure of mutual exclusion.
      expect(r.violation).toBeNull();
    });
  }
  test("the reported schedule leaves a thread asleep with the lock free", () => {
    const o = { variant: "three-state" as const, check: false };
    const r = checkFutexMutex(o);
    const p = futexMutexProg(o);
    const trail = replay(machineModel(p), r.stuck!.schedule);
    const end = trail[trail.length - 1]!;
    expect(end.mem.val).toBe(0);
    expect(end.q.val!.length).toBe(1);
    expect(allDone(p, end)).toBe(false);
  });
});

describe("futex lesson: quoted numbers", () => {
  test("search sizes", () => {
    expect(checkFutexMutex({ variant: "three-state", check: true }).states).toBe(72);
    expect(checkFutexMutex({ variant: "three-state", check: true, rounds: 2 }).states).toBe(1050);
    expect(checkFutexMutex({ variant: "three-state", check: true, threads: 3 }).states).toBe(2138);
  });
  test("the lost wakeup takes 8 steps in 3-state, and 6 steps in 2-state", () => {
    expect(checkFutexMutex({ variant: "three-state", check: false }).stuck?.schedule.length).toBe(8);
    expect(checkFutexMutex({ variant: "two-state", check: false }).stuck?.schedule.length).toBe(6);
  });
  test("the fast path makes no syscall", () => {
    const p = futexMutexProg({ variant: "three-state", check: true });
    const end = replay(machineModel(p), FUTEX_FAST_SCHEDULE).at(-1)!;
    expect(allDone(p, end)).toBe(true);
    expect(end.n.syscalls ?? 0).toBe(0);
  });
  test("the slow path makes 3 syscalls, and one wake finds nobody", () => {
    const p = futexMutexProg({ variant: "three-state", check: true });
    const end = replay(machineModel(p), FUTEX_SLOW_SCHEDULE).at(-1)!;
    expect(allDone(p, end)).toBe(true);
    expect(end.n).toMatchObject({ syscalls: 3, waitCalls: 1, wakeCalls: 2, wakeups: 1, emptyWakes: 1 });
  });
  test("syscalls per pair against contention", () => {
    const f = (v: MutexVariant, n: number) => futexLoad(v, n).perPair.toFixed(2);
    expect(f("two-state", 1)).toBe("1.00");
    expect(f("three-state", 1)).toBe("0.00");
    expect(f("two-state", 4)).toBe("1.36");
    expect(f("three-state", 4)).toBe("0.83");
    expect(f("two-state", 16)).toBe("2.17");
    expect(f("three-state", 16)).toBe("2.20");
    expect(Math.round(futexLoad("three-state", 16).contended * 100)).toBe(88);
  });
  test("a longer critical section raises contention sooner", () => {
    expect(futexLoad("three-state", 4, { cs: 40 }).contended).toBeGreaterThan(futexLoad("three-state", 4).contended);
  });
});

describe("the futex table", () => {
  const mk = () => {
    const mem = new Map<number, number>();
    const t = new FutexTable(4, (a) => mem.get(a) ?? 0);
    return { t, mem };
  };
  test("wait compares the word first", () => {
    const { t, mem } = mk();
    mem.set(0x10, 5);
    expect(t.wait(0x10, 4, 1)).toBe("EAGAIN");
    expect(t.waiters(0x10)).toEqual([]);
    expect(t.wait(0x10, 5, 1)).toBe("sleeping");
    expect(t.waiters(0x10)).toEqual([1]);
  });
  test("wake is FIFO, respects n, and skips other addresses", () => {
    const { t } = mk();
    // Find two addresses in one bucket.
    const a = 0x1000;
    let b = a + 4;
    while (t.bucketOf(b) !== t.bucketOf(a)) b += 4;
    t.wait(a, 0, 1); t.wait(b, 0, 2); t.wait(a, 0, 3);
    expect(t.wake(a, 1)).toEqual([1]);
    expect(t.waiters(b)).toEqual([2]);
    expect(t.wake(a, 10)).toEqual([3]);
    expect(t.wake(a, 10)).toEqual([]);
  });
  test("requeue moves waiters with no wakeup, in the same and in different buckets", () => {
    const { t } = mk();
    const a = 0x1000;
    let same = a + 4;
    while (t.bucketOf(same) !== t.bucketOf(a)) same += 4;
    let diff = a + 4;
    while (t.bucketOf(diff) === t.bucketOf(a)) diff += 4;
    for (const to of [same, diff]) {
      for (const x of [1, 2, 3]) t.wait(a, 0, x);
      expect(t.cmpRequeue(a, to, 1, 10, 0)).toEqual({ woken: [1], moved: 2 });
      expect(t.waiters(to)).toEqual([2, 3]);
      expect(t.waiters(a)).toEqual([]);
      t.wake(to, 10);
    }
  });
  test("the hash spreads the demo addresses, and two of them share a bucket", () => {
    const t = new FutexTable(4);
    const buckets = [0x1000, 0x1040, 0x2000, 0x2040].map((a) => t.bucketOf(a));
    expect(new Set(buckets).size).toBeGreaterThan(1);
    expect(new Set(buckets).size).toBeLessThan(4);
    expect(t.bucketOf(0x1000)).toBe(t.bucketOf(0x1040));
  });
  test("waking 0x1040 behind two 0x1000 waiters walks 3 entries, and wakes one thread", () => {
    const t = new FutexTable(4);
    t.wait(0x1000, 0, 0); t.wait(0x1000, 0, 1); t.wait(0x1040, 0, 2);
    expect(t.wake(0x1040, 1)).toEqual([2]);
    expect(t.scanned).toBe(3);
  });
});
