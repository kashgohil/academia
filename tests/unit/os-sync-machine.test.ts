/** The interleaving machine, the explorer and the critical-section lesson. */
import { describe, expect, test } from "vitest";
import {
  BLOCK, allDone, checkPeterson, clone, countSchedules, counterSchedules, delay, drain, exec, explore, initial, machineModel,
  petersonLitmus, petersonMaxBypass, petersonProg, replay, runParallel, type Prog,
} from "../../src/sims/os/sync";

describe("machine", () => {
  const prog: Prog = {
    name: "t",
    mem: { x: 0, gate: 0 },
    threads: [
      [{ text: "x = 1", run(c) { c.store("x", 1); } }, { text: "open", run(c) { c.mem.gate = 1; } }],
      [{ text: "wait", run(c) { if (!c.mem.gate) return BLOCK; return undefined; } }, { text: "read", run(c) { c.r.v = c.load("x"); } }],
    ],
  };

  test("a blocked instruction does not run and changes no state", () => {
    const s = initial(prog);
    const before = JSON.stringify(s);
    expect(exec(prog, s, 1)).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });

  test("an explicit schedule runs in the given order", () => {
    const s = initial(prog);
    exec(prog, s, 0); exec(prog, s, 0); exec(prog, s, 1); exec(prog, s, 1);
    expect(s.th[1]!.r.v).toBe(1);
    expect(allDone(prog, s)).toBe(true);
  });

  test("the store buffer delays a store, and the same thread still sees it", () => {
    const p: Prog = { name: "b", tso: true, mem: { x: 0 }, threads: [[
      { text: "x = 1", run(c) { c.store("x", 1); } },
      { text: "read", run(c) { c.r.v = c.load("x"); } },
    ]] };
    const s = initial(p);
    exec(p, s, 0);
    expect(s.mem.x).toBe(0);
    exec(p, s, 0);
    expect(s.th[0]!.r.v).toBe(1);
    expect(allDone(p, s)).toBe(false);
    drain(s, 0);
    expect(s.mem.x).toBe(1);
    expect(allDone(p, s)).toBe(true);
  });

  test("a sync instruction needs an empty buffer", () => {
    const p: Prog = { name: "f", tso: true, mem: { x: 0 }, threads: [[
      { text: "x = 1", run(c) { c.store("x", 1); } },
      { text: "mfence", sync: true, run() {} },
    ]] };
    const s = initial(p);
    exec(p, s, 0);
    expect(exec(p, clone(s), 0)).toBe(false);
    drain(s, 0);
    expect(exec(p, s, 0)).toBe(true);
  });

  test("the explorer finds a stuck state and its shortest schedule", () => {
    const p: Prog = { name: "d", mem: { a: 0, b: 0 }, threads: [
      [{ text: "a", run(c) { if (c.mem.a) return BLOCK; c.mem.a = 1; return undefined; } }, { text: "b", run(c) { if (c.mem.b) return BLOCK; c.mem.b = 1; return undefined; } }],
      [{ text: "b", run(c) { if (c.mem.b) return BLOCK; c.mem.b = 1; return undefined; } }, { text: "a", run(c) { if (c.mem.a) return BLOCK; c.mem.a = 1; return undefined; } }],
    ] };
    const r = explore(machineModel(p));
    expect(r.stuck?.schedule.length).toBe(2);
  });

  test("the explorer counts a spin loop that can never end as a trap", () => {
    const p: Prog = { name: "s", mem: { x: 0 }, threads: [[{ label: "l", text: "spin", kind: "spin", run(c) { return c.mem.x ? undefined : "l"; } }]] };
    const r = explore(machineModel(p));
    expect(r.stuck).toBeNull();
    expect(r.trapped).toBeGreaterThan(0);
  });

  test("replay applies a schedule", () => {
    const m = machineModel(prog);
    const trail = replay(m, ["T0", "T0", "T1", "T1"]);
    expect(allDone(prog, trail[trail.length - 1]!)).toBe(true);
    // T1 cannot pass the gate before T0 opens it, so only one complete order exists.
    expect(countSchedules(m).get("done")).toBe(1);
  });

  test("a delay takes n ticks", () => {
    const p: Prog = { name: "x", mem: {}, threads: [delay(5, "wait")] };
    expect(runParallel(p, () => 0.5).ticks).toBe(5 + 1);
    expect(delay(0, "none")).toEqual([]);
  });
});

describe("critical sections: quoted numbers", () => {
  test("the unprotected counter: 18 of 20 schedules lose an update", () => {
    expect(counterSchedules("plain")).toMatchObject({ total: 20, correct: 2, lost: 18 });
  });
  test("an atomic add has 2 schedules, and both are correct", () => {
    expect(counterSchedules("atomic")).toMatchObject({ total: 2, correct: 2, lost: 0 });
  });
  test("cli on one CPU: every schedule is correct", () => {
    expect(counterSchedules("cli-one-cpu")).toMatchObject({ total: 2, correct: 2, lost: 0 });
  });
  test("cli on two CPUs: 200 of 252 schedules lose an update", () => {
    expect(counterSchedules("cli-two-cpus")).toMatchObject({ total: 252, correct: 52, lost: 200 });
  });
});

describe("Peterson", () => {
  test("is correct under SC: 48 states, no violation, no stuck state, no trap", () => {
    const r = checkPeterson();
    expect(r).toMatchObject({ states: 48, violation: null, stuck: null, trapped: 0, truncated: false });
  });
  test("two rounds each are also correct under SC", () => {
    const r = checkPeterson({ rounds: [2, 2] });
    expect(r).toMatchObject({ violation: null, stuck: null, trapped: 0, truncated: false });
  });
  test("fails under TSO: 353 states, and a 6-step schedule with no drain", () => {
    const r = checkPeterson({ tso: true });
    expect(r.states).toBe(353);
    expect(r.violation?.schedule.length).toBe(6);
    expect(r.violation?.schedule.every((x) => x.startsWith("T"))).toBe(true);
  });
  test("a fence restores it under TSO: 139 states", () => {
    expect(checkPeterson({ tso: true, fence: true })).toMatchObject({ states: 139, violation: null, stuck: null, trapped: 0 });
  });
  test("bounded waiting: T1 enters at most once after T0 finished its entry writes", () => {
    expect(petersonMaxBypass()).toBe(1);
  });
  test("the stepper program stays in the same shape as the checked one", () => {
    expect(petersonProg().threads.length).toBe(2);
  });
});

describe("Peterson in the memory model explorer", () => {
  test("plain stores: fails under TSO and C++, not under SC", () => {
    const r = petersonLitmus("plain");
    expect([r.failsSc, r.failsTso, r.failsCxx]).toEqual([false, true, true]);
    expect([r.sc.outcomes.length, r.tso.outcomes.length, r.cxx.outcomes.length]).toEqual([8, 16, 16]);
  });
  test("mfence: safe under TSO, but the C++ model still allows the failure with relaxed stores", () => {
    const r = petersonLitmus("fence");
    expect([r.failsSc, r.failsTso, r.failsCxx]).toEqual([false, false, true]);
  });
  test("seq_cst: safe under every model", () => {
    const r = petersonLitmus("seq-cst");
    expect([r.failsSc, r.failsTso, r.failsCxx]).toEqual([false, false, false]);
  });
});
