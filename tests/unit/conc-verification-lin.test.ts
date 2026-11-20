import { describe, expect, test } from "vitest";
import {
  HW_FAI_WRONG, HW_STORE_WRONG, checkRandomHistories, findOrder, historyOf, hwDemo, hwRuleCheck, hwSchedules,
  multiSpec, pointsForOrder, producersConsumers, queueSpec, randomHistory, replayPoints, stackSpec, subHistory,
  LIN_PRESETS, type HistOp,
} from "@/sims/conc/verification";

const op = (id: number, thread: number, kind: HistOp["kind"], v: number | null, call: number, ret: number, obj = "q"): HistOp =>
  kind === "enq" || kind === "push" ? { id, thread, obj, kind, arg: v!, call, ret } : { id, thread, obj, kind, res: v, call, ret };

describe("the order search", () => {
  test("a queue history with overlap is linearizable, and the midpoints are not a valid choice", () => {
    const h = LIN_PRESETS.overlap.ops;
    const r = findOrder(h, queueSpec);
    expect(r.ok).toBe(true);
    const mid = Object.fromEntries(h.map((o) => [o.id, (o.call + o.ret) / 2]));
    expect(replayPoints(h, mid, queueSpec).ok).toBe(false);
    // The points that the search gives lie inside the intervals and replay legally.
    const pts = pointsForOrder(h, r.order);
    for (const o of h) { expect(pts[o.id]!).toBeGreaterThan(o.call); expect(pts[o.id]!).toBeLessThan(o.ret); }
    expect(replayPoints(h, pts, queueSpec).ok).toBe(true);
  });

  test("the presets: linearizable and sequentially consistent verdicts", () => {
    const v = (k: keyof typeof LIN_PRESETS) => {
      const p = LIN_PRESETS[k];
      const spec = multiSpec(p.objs, queueSpec);
      return [findOrder(p.ops, spec, "linearizable").ok, findOrder(p.ops, spec, "sequential").ok];
    };
    expect(v("overlap")).toEqual([true, true]);
    expect(v("outOfOrder")).toEqual([false, false]);
    expect(v("staleEmpty")).toEqual([false, true]);
    expect(v("twoQueues")).toEqual([false, false]);
  });

  test("locality: linearizability per object agrees with the whole; sequential consistency does not", () => {
    const p = LIN_PRESETS.twoQueues;
    for (const obj of p.objs) {
      expect(findOrder(subHistory(p.ops, obj), queueSpec, "sequential").ok).toBe(true);
    }
    const whole = findOrder(p.ops, multiSpec(p.objs, queueSpec), "linearizable").ok;
    const each = p.objs.every((o) => findOrder(subHistory(p.ops, o), queueSpec, "linearizable").ok);
    expect(whole).toBe(each);
  });

  test("a stack spec: pop returns the last push", () => {
    const h = [op(0, 0, "push", 1, 0, 2), op(1, 0, "push", 2, 3, 4), op(2, 1, "pop", 1, 5, 6)];
    expect(findOrder(h, stackSpec).ok).toBe(false);
    expect(findOrder([h[0]!, { ...h[1]!, call: 0.5, ret: 8 }, h[2]!], stackSpec).ok).toBe(true);
  });
});

describe("the Herlihy-Wing queue", () => {
  const impl = hwDemo();
  test("the two scripted schedules break one fixed rule each, and both histories are linearizable", () => {
    expect(hwRuleCheck(impl, HW_FAI_WRONG, "fai").ok).toBe(false);
    expect(hwRuleCheck(impl, HW_FAI_WRONG, "store").ok).toBe(true);
    expect(hwRuleCheck(impl, HW_STORE_WRONG, "store").ok).toBe(false);
    expect(hwRuleCheck(impl, HW_STORE_WRONG, "fai").ok).toBe(true);
    expect(historyOf(impl, HW_FAI_WRONG).ops.find((o) => o.kind === "deq")!.res).toBe(2);
    expect(historyOf(impl, HW_STORE_WRONG).ops.find((o) => o.kind === "deq")!.res).toBe(1);
    for (const s of [HW_FAI_WRONG, HW_STORE_WRONG]) expect(findOrder(historyOf(impl, s).ops, queueSpec).ok).toBe(true);
  });

  test("every schedule with no rescan is linearizable; each fixed rule fails on some", () => {
    const all = hwSchedules(impl, 0);
    expect(all.length).toBe(HW_COUNTS.schedules);
    let fai = 0, store = 0;
    for (const s of all) {
      expect(findOrder(historyOf(impl, s).ops, queueSpec).ok).toBe(true);
      if (!hwRuleCheck(impl, s, "fai").ok) fai++;
      if (!hwRuleCheck(impl, s, "store").ok) store++;
    }
    expect([fai, store]).toEqual([HW_COUNTS.faiFails, HW_COUNTS.storeFails]);
  });
});

/** Quoted in the lesson. */
const HW_COUNTS = { schedules: 80, faiFails: 20, storeFails: 10 };

describe("random histories of three implementations", () => {
  test("a run records every operation with call before return", () => {
    const r = randomHistory(producersConsumers("lock", 2, 2, 2), 7);
    expect(r.finished).toBe(true);
    expect(r.ops.length).toBe(8);
    for (const o of r.ops) expect(o.call).toBeLessThanOrEqual(o.ret);
  });

  test("the lock queue and the Herlihy-Wing queue pass; the SPSC queue passes with one producer and one consumer", () => {
    expect(checkRandomHistories(producersConsumers("lock", 2, 2, 3), 200).failing).toBe(0);
    expect(checkRandomHistories(producersConsumers("hw", 2, 2, 3), 200).failing).toBe(0);
    expect(checkRandomHistories(producersConsumers("spsc", 1, 1, 3), 200).failing).toBe(0);
  });

  test("the SPSC queue fails with two producers or two consumers", () => {
    const pp = checkRandomHistories(producersConsumers("spsc", 2, 1, 2), 200);
    const cc = checkRandomHistories(producersConsumers("spsc", 1, 2, 2), 200);
    expect([pp.failing, pp.firstFail, cc.failing, cc.firstFail]).toEqual([RANDOM.twoProducers, RANDOM.firstPP, RANDOM.twoConsumers, RANDOM.firstCC]);
  });

  test("one enq each by two producers: the lost element is never observed, so every history passes", () => {
    expect(checkRandomHistories(producersConsumers("spsc", 2, 1, 1), 200).failing).toBe(0);
  });
});

/** Quoted in the lesson: 200 seeded runs, 2 operations per thread. */
const RANDOM = { twoProducers: 52, firstPP: 6, twoConsumers: 88, firstCC: 3 };
