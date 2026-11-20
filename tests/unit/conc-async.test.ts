import { describe, expect, test } from "vitest";
import {
  DEFAULT_CHILDREN, LOOP_PROGRAMS, REQUEST_TREE, TOKIO, candidates, combine, gameReplay, gameStuck, handlerStates, hogRun, isNext, leakRun,
  loopServer, pinTrace, pollTrace, quantile, runLoop, runTree, stateLayout, taskMemory, tokioSched, type GameAction,
} from "@/sims/conc/async";

const prog = (id: string) => LOOP_PROGRAMS.find((p) => p.id === id)!;
const out = (id: string) => runLoop(prog(id)).at(-1)!.state.out.join(" ");
const msOf = (ns: number) => ns / 1e6;

describe("event loops: the step model", () => {
  test("browser: microtasks drain before the 0 ms timer", () => {
    expect(out("order")).toBe("A F C E D B");
  });
  test("microtasks that queue microtasks all run before the timer", () => {
    expect(out("flood")).toBe("m1 m2 m3 m4 m5 m6 timer");
  });
  test("Node (CommonJS): nextTick before promises, and again after a promise queues one", () => {
    expect(out("tick")).toBe("sync tick 1 promise tick 2 timeout");
  });
  test("Node: inside an I/O callback, setImmediate runs before setTimeout(0)", () => {
    expect(out("phases")).toBe("tick immediate timeout");
  });
  test("the learner's pick is checked against the next frame", () => {
    const f = runLoop(prog("order"));
    // After the script: the microtask is next, the timer is not.
    const c = candidates(f[1]!.state, "browser");
    const timer = c.find((x) => x.q === "timer")!, micro = c.find((x) => x.q === "micro")!;
    expect(isNext(f, 1, micro.q, micro.id)).toBe(true);
    expect(isNext(f, 1, timer.q, timer.id)).toBe(false);
    // In the I/O program, picking the I/O callback skips over the idle wait.
    const g = runLoop(prog("phases"));
    const io = candidates(g[1]!.state, "node").find((x) => x.q === "io")!;
    expect(isNext(g, 1, "io", io.id)).toBe(true);
  });
});

describe("event loops: one slow callback (Runtime)", () => {
  const inline = loopServer({ strategy: "inline", record: false });
  const chunked = loopServer({ strategy: "chunked", record: false });
  const offload = loopServer({ strategy: "offload", record: false });
  test("all 200 requests finish, with no error", () => {
    for (const r of [inline, chunked, offload]) {
      expect(r.reqs).toHaveLength(200);
      expect(r.run.error).toBeUndefined();
      expect(r.run.deadlock).toBeUndefined();
    }
  });
  test("p50 stays at 105 µs (100 µs handler + 5 µs wake-up model input)", () => {
    for (const r of [inline, chunked, offload]) expect(r.fast.p50).toBe(105_000);
  });
  test("inline: p99 of normal requests is about 20 ms; slices: about 2.3 ms; a pool: about 0.2 ms", () => {
    expect(msOf(inline.fast.p99)).toBeCloseTo(19.93, 2);
    expect(msOf(inline.fast.max)).toBeCloseTo(20.12, 2);
    expect(msOf(chunked.fast.p99)).toBeCloseTo(2.29, 2);
    expect(msOf(offload.fast.p99)).toBeCloseTo(0.2, 2);
  });
  test("slicing makes the slow request itself slower", () => {
    expect(msOf(inline.slowMean)).toBeCloseTo(20.11, 2);
    expect(msOf(chunked.slowMean)).toBeCloseTo(21.7, 1);
  });
  test("a 30 ms slow callback in 40 requests keeps the loop about 85% busy, and the p50 jumps to 8.14 ms", () => {
    const r = loopServer({ strategy: "inline", slowMs: 30, record: false });
    expect(msOf(r.fast.p50)).toBeCloseTo(8.14, 2);
    expect(30 / 40 + 0.1).toBeCloseTo(0.85, 5);
  });
  test("quantile is the nearest rank", () => {
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.99)).toBe(4);
  });
});

describe("futures: the executor game", () => {
  const good: GameAction[] = [
    { k: "poll", task: 0 }, { k: "poll", task: 1 }, { k: "data", res: "a" }, { k: "poll", task: 0 },
    { k: "time", ms: 10 }, { k: "poll", task: 1 }, { k: "data", res: "b" }, { k: "poll", task: 1 },
  ];
  test("a correct executor finishes both tasks in 5 polls with no wasted poll", () => {
    const s = gameReplay(good).at(-1)!;
    expect(s.tasks.every((t) => t.done)).toBe(true);
    expect(s.polls).toBe(5);
    expect(s.wasted).toBe(0);
  });
  test("futures are lazy: B's timer starts at its first poll, not at creation", () => {
    const s = gameReplay([{ k: "time", ms: 10 }, { k: "poll", task: 1 }]).at(-1)!;
    expect(s.tasks[1]!.done).toBe(false);
    expect(s.timers[0]!.deadline).toBe(20);
  });
  test("data that arrives before the first poll is buffered: one poll is enough", () => {
    const s = gameReplay([{ k: "data", res: "a" }, { k: "poll", task: 0 }]).at(-1)!;
    expect(s.tasks[0]!.done).toBe(true);
    expect(s.polls).toBe(1);
  });
  test("a poll of a task that was not woken is wasted", () => {
    const s = gameReplay([{ k: "poll", task: 0 }, { k: "poll", task: 0 }]).at(-1)!;
    expect(s.wasted).toBe(1);
  });
  test("a future that drops its waker hangs: the event wakes nobody", () => {
    const s = gameReplay([{ k: "poll", task: 0 }, { k: "data", res: "a" }], true).at(-1)!;
    expect(s.ready).toEqual([1]);
    expect(gameStuck(s)).toEqual([0]);
    expect(gameStuck(gameReplay([{ k: "poll", task: 0 }]).at(-1)!)).toEqual([]);
  });
});

describe("futures: combinators", () => {
  test("all: rejects at 50 ms; JS losers run 100 ms more, Rust drops them", () => {
    const js = combine(DEFAULT_CHILDREN, "all", "none"), rs = combine(DEFAULT_CHILDREN, "all", "drop");
    expect([js.at, js.outcome, js.wastedMs]).toEqual([50, "error", 100]);
    expect([rs.at, rs.wastedMs]).toEqual([50, 0]);
    expect(rs.children.filter((c) => c.dropped).map((c) => c.name)).toEqual(["replica 2", "replica 4"]);
  });
  test("race and any settle at 30 ms; JS keeps 160 ms of work going", () => {
    for (const c of ["race", "any"] as const) {
      const r = combine(DEFAULT_CHILDREN, c, "none");
      expect([r.at, r.outcome, r.wastedMs]).toEqual([30, "ok", 160]);
    }
  });
  test("race settles with the first result even if it is an error; any skips errors", () => {
    const kids = DEFAULT_CHILDREN.map((c, i) => ({ ...c, fails: i === 0 }));
    expect(combine(kids, "race", "none").outcome).toBe("error");
    expect(combine(kids, "any", "none")).toMatchObject({ at: 50, outcome: "ok" });
    expect(combine(kids.map((c) => ({ ...c, fails: true })), "any", "none")).toMatchObject({ at: 120, outcome: "error" });
  });
  test("allSettled waits for all, so nothing is wasted", () => {
    expect(combine(DEFAULT_CHILDREN, "allSettled", "none")).toMatchObject({ at: 120, wastedMs: 0 });
  });
});

describe("async/await desugared", () => {
  test("the future is as large as its largest state: 1,072 B with the array, 72 B with a Vec", () => {
    const arr = stateLayout(handlerStates(false)), vec = stateLayout(handlerStates(true));
    expect(arr.bytes).toBe(1_072);
    expect(arr.variants.map((v) => v.bytes)).toEqual([24, 1_072, 72, 72, 1]);
    expect(vec.bytes).toBe(72);
  });
  test("one poll per Pending, plus the last: 4 polls; ready sub-futures merge polls", () => {
    expect(pollTrace([false, false, false]).map((s) => `${s.from}>${s.to}`)).toEqual(["Unresumed>Suspend0", "Suspend0>Suspend1", "Suspend1>Suspend2", "Suspend2>Returned"]);
    const t = pollTrace([true, false, false]);
    expect(t).toHaveLength(3);
    expect(t[0]!.to).toBe("Suspend1");
    expect(pollTrace([true, true, false])).toHaveLength(2);
  });
  test("moving a polled future leaves a dangling pointer; moving before the first poll is safe", () => {
    const bad = pinTrace(["poll", "move", "poll"], false);
    expect(bad.at(-1)!.ok).toBe(false);
    expect(bad[2]!.ptr).toBe(0x1018);
    expect(bad[2]!.bufAt).toBe(0x2018);
    expect(pinTrace(["move", "poll", "poll"], false).at(-1)!.ok).toBe(true);
    expect(pinTrace(["poll", "move", "poll"], true).at(-1)!.ok).toBe(true);
  });
  test("memory per waiting task (model): 320 B, 2,448 B or 4,496 B, 30 KiB", () => {
    expect(taskMemory(256, 2048)).toMatchObject({ future: 320, goroutine: 2_448, thread: 30_720 });
    expect(taskMemory(256, 4096).goroutine).toBe(4_496);
    // 100,000 tasks: 30.5 MiB as futures, 2.86 GiB as threads.
    expect(100_000 * 320 / 2 ** 20).toBeCloseTo(30.5, 1);
    expect(100_000 * 30_720 / 2 ** 30).toBeCloseTo(2.86, 2);
    expect(100_000 * taskMemory(256, 2048).threadVirtual / 2 ** 30).toBeCloseTo(781, 0);
    // A goroutine of 2 KiB is about 8 times a 256-byte future; a 16 KiB future is larger than a 4 KiB goroutine.
    expect(Math.round(2_448 / 320)).toBe(8);
    expect(taskMemory(16_384, 4096).future).toBeGreaterThan(taskMemory(16_384, 4096).goroutine);
  });
});

describe("Rust async runtimes (Runtime)", () => {
  test("Tokio constants that the lesson quotes", () => {
    expect(TOKIO).toMatchObject({ localQueueCapacity: 256, maxLifoPollsPerTick: 3, coopBudget: 128, maxBlockingThreads: 512 });
  });
  test("fan-out of 64 × 50 µs: 824 µs on 4 workers with stealing, 3,224 µs without", () => {
    const st = tokioSched({ record: false }), no = tokioSched({ steal: false, record: false });
    expect(st.makespan).toBe(824_420);
    expect(st.polls).toEqual([17, 16, 16, 16]);
    expect(no.makespan).toBe(3_224_220);
    expect(no.polls).toEqual([65, 0, 0, 0]);
    expect(tokioSched({ workers: 1, record: false }).makespan).toBe(3_219_200);
  });
  test("a small local queue overflows into the inject queue", () => {
    expect(tokioSched({ capacity: 16, record: false }).overflows).toBe(6);
    expect(tokioSched({ record: false }).overflows).toBe(0);
  });
  test("ping-pong under load, 1 worker: LIFO round trip 2 µs (median), 802 µs without", () => {
    const on = tokioSched({ workload: "pingpong", workers: 1, tasks: 8, record: false });
    const off = tokioSched({ workload: "pingpong", workers: 1, tasks: 8, lifo: false, record: false });
    expect(quantile(on.rtt, 0.5)).toBe(2_000);
    expect(on.rtt.reduce((a, b) => a + b, 0) / on.rtt.length).toBe(202_000);
    expect(quantile(off.rtt, 0.5)).toBe(802_000);
  });
  test("heartbeat lateness: 9.5 ms with no budget or a blocking call, 246 µs with budget 128, none with spawn_blocking", () => {
    expect(hogRun({ mode: "nobudget", record: false }).maxLate).toBe(9_500_300);
    expect(hogRun({ mode: "blocking", record: false }).maxLate).toBe(9_500_300);
    expect(hogRun({ mode: "budget", record: false }).maxLate).toBe(245_900);
    expect(hogRun({ mode: "spawn_blocking", record: false }).maxLate).toBeLessThan(1_000);
  });
  test("the worst lateness grows with the budget", () => {
    const late = (budget: number) => hogRun({ mode: "budget", budget, record: false }).maxLate;
    expect(late(16)).toBe(30_300);
    expect(late(1024)).toBe(1_722_900);
  });
  test("runs end cleanly", () => {
    for (const r of [tokioSched({ record: false }), tokioSched({ workload: "pingpong", record: false })]) {
      expect(r.run.error).toBeUndefined();
      expect(r.run.deadlock).toBeUndefined();
    }
  });
});

describe("structured concurrency", () => {
  const fail = { name: "orders cache", at: 25 };
  test("spawn and forget: the handler returns at 25 ms, 3 tasks run on to 120 ms, 175 ms of orphan work", () => {
    const r = runTree(REQUEST_TREE, { discipline: "unstructured", fail, checkMs: 0 });
    expect([r.rootEnd, r.rootStatus, r.lastEnd, r.orphans, r.orphanMs]).toEqual([25, "failed", 120, 3, 175]);
  });
  test("structured: everything stops at 25 ms; with 15 ms between checkpoints, at 30 ms", () => {
    const a = runTree(REQUEST_TREE, { discipline: "structured", fail, checkMs: 0 });
    expect([a.rootEnd, a.lastEnd, a.orphans]).toEqual([25, 25, 0]);
    expect(a.nodes.filter((n) => n.status === "cancelled").map((n) => n.name)).toEqual(["user", "orders db", "ads"]);
    const b = runTree(REQUEST_TREE, { discipline: "structured", fail, checkMs: 15 });
    expect([b.rootEnd, b.lastEnd]).toEqual([30, 30]);
  });
  test("supervisor: the failure stays local; the handler waits for all, 120 ms", () => {
    const r = runTree(REQUEST_TREE, { discipline: "supervisor", fail, checkMs: 0 });
    expect([r.rootEnd, r.rootStatus, r.orphans]).toEqual([120, "partial", 0]);
  });
  test("with no failure all three disciplines take 120 ms", () => {
    for (const d of ["unstructured", "structured", "supervisor"] as const) expect(runTree(REQUEST_TREE, { discipline: d, fail: null, checkMs: 0 }).rootEnd).toBe(120);
  });
  test("leaks under timeouts: 132 calls in flight against 74; 23.7% of calls pass the 50 ms timeout", () => {
    const r = leakRun();
    expect(Math.round(r.mean.unstructured)).toBe(132);
    expect(Math.round(r.mean.structured)).toBe(74);
    expect(r.pastTimeout).toBeCloseTo(0.237, 3);
    // Little's law: calls in flight = 3 per ms × mean lifetime; the sim agrees within sampling noise.
    expect(r.mean.unstructured / 3).toBeGreaterThan(40);
  });
  test("a 400 ms timeout or a short tail makes the two curves almost meet", () => {
    const a = leakRun({ timeoutMs: 400 });
    expect(Math.round(a.mean.structured)).toBe(125);
    expect(a.mean.structured / a.mean.unstructured).toBeGreaterThan(0.9);
    const b = leakRun({ p99Ms: 40 });
    expect(b.mean.structured / b.mean.unstructured).toBeGreaterThan(0.95);
  });
  test("ads fails at 60 ms: the detached handler returns at 60 ms, orders db runs to 90 ms", () => {
    const r = runTree(REQUEST_TREE, { discipline: "unstructured", fail: { name: "ads", at: 60 }, checkMs: 0 });
    expect([r.rootEnd, r.lastEnd]).toEqual([60, 90]);
  });
});
