/** Kernel threads at stack level, and the run queue against an interrupt. */
import { describe, expect, test } from "vitest";
import { equalJobs, simulateClassic } from "@/sims/os/scheduling";
import * as K from "@/sims/os/kernel";

const P: K.SchedOpts = { mode: "preemptive", sti: true };

describe("fabricated frames", () => {
  test("seven words: the six registers and a return address", () => {
    expect(K.FAKE_FRAME_BYTES).toBe(56);
    const s = new K.KernelSim(P);
    s.boot();
    const snap = s.snaps[1]!;
    const a = snap.threads[0]!;
    expect(a.stack.map((r) => r.label)).toEqual(["ret", "rbp", "rbx", "r12", "r13", "r14", "r15"]);
    expect(a.stack[0]!.value).toBe("thread_trampoline");
    expect(a.savedRsp).toBe(a.top - 56n);
  });
  test("after the pops and ret, rsp is at the top and is 16-byte aligned", () => {
    const s = K.schedSnaps(P);
    const start = s.find((x) => x.title === "ret into the trampoline")!;
    const t = start.threads.find((x) => x.name === start.cur)!;
    expect(start.rsp).toBe(t.top);
    expect(start.rsp % 16n).toBe(0n);
    expect(t.stack.length).toBe(0);
  });
});

describe("the scheduler", () => {
  test("registers survive every switch", () => {
    const s = new K.KernelSim(P).run();
    expect(s.regCheck.length).toBeGreaterThan(5);
    expect(s.regCheck.every((r) => r.ok)).toBe(true);
  });
  test("the default run", () => {
    const s = new K.KernelSim(P).run();
    expect(s.dispatches.join("")).toBe("ABCABABABCAB");
    expect(s.console).toBe("bcbbbc");
  });
  test("every snapshot keeps the lists sound", () => {
    for (const o of [P, { ...P, mode: "cooperative" as const }, { ...P, sti: false }]) {
      for (const s of K.schedSnaps({ ...o, maxSnaps: 400 })) {
        // During schedule() the old thread is on the queue, and it still runs until rsp changes.
        if (s.phase !== "sched" && s.phase !== "save") expect(s.runq).not.toContain(s.cur);
        expect(new Set(s.runq).size).toBe(s.runq.length);
        for (const z of s.sleepers) expect(s.runq).not.toContain(z.name);
      }
    }
  });
  test("preempted thread: the stack and registers come back after iretq", () => {
    const s = K.schedSnaps({ ...P, threads: [{ name: "A", prog: "hog" }, { name: "B", prog: "hog" }], maxSnaps: 200 });
    const backs = s.filter((x) => x.title === "iretq");
    expect(backs.length).toBeGreaterThan(3);
    for (const b of backs) {
      const t = b.threads.find((x) => x.name === b.cur)!;
      expect(b.rsp).toBe(t.top);
      expect(t.stack.length).toBe(0);
      expect(b.ifFlag).toBe(true);
      expect(b.regs.rbx.startsWith(`${b.cur}.`)).toBe(true);
    }
  });
  test("cooperative: a thread that never yields keeps the CPU, and the ticks still count", () => {
    const s = new K.KernelSim({ ...P, mode: "cooperative" }).run();
    expect(s.dispatches).toEqual(["A"]);
    expect(s.tick).toBe(14);
  });
  test("cooperative threads that all yield do share", () => {
    const s = new K.KernelSim({ ...P, mode: "cooperative", threads: [{ name: "A", prog: "yielder" }, { name: "B", prog: "yielder" }] }).run();
    expect(s.dispatches.slice(0, 4)).toEqual(["A", "B", "A", "B"]);
  });
  test("a trampoline with no sti stops the clock", () => {
    const s = new K.KernelSim({ ...P, sti: false }).run();
    expect(s.dispatches).toEqual(["A"]);
    expect(s.tick).toBe(0);
  });
  test("the sleeper is away until its wake tick", () => {
    const snaps = K.schedSnaps({ ...P, maxSnaps: 300 });
    const sl = snaps.find((s) => s.sleepers.length > 0)!;
    expect(sl.sleepers[0]!.name).toBe("C");
    const wake = sl.sleepers[0]!.wakeAt;
    for (const s of snaps) if (s.tick < wake && snaps.indexOf(s) > snaps.indexOf(sl)) expect(s.runq).not.toContain("C");
  });
  test("three hogs match the round-robin order of the scheduling module", () => {
    const threads = ["A", "B", "C"].map((name) => ({ name, prog: "hog" as const }));
    const s = new K.KernelSim({ ...P, threads, maxSnaps: 400 }).run();
    const tr = simulateClassic(equalJobs(3, 300), { policy: "rr", quantum: 3 });
    const order = tr.events.filter((e) => e.kind === "dispatch").map((e) => "ABC"[e.job]!);
    const n = Math.min(order.length, s.dispatches.length);
    expect(n).toBeGreaterThan(9);
    expect(s.dispatches.slice(0, n)).toEqual(order.slice(0, n));
  });
});

describe("the run queue against an interrupt", () => {
  test("one CPU, no protection: 2 of 4 schedules corrupt the queue", () => {
    const r = K.raceReport("none");
    expect([r.total, r.good, r.corrupt, r.deadlock]).toEqual([4, 2, 2, 0]);
    expect(r.violation).not.toBeNull();
    expect(r.violation!.schedule).toEqual(["T0", "T0", "T1", "T1", "T1", "T1", "T0"]);
  });
  test("one CPU, cli: all 2 schedules are correct", () => {
    const r = K.raceReport("cli");
    expect([r.total, r.good, r.corrupt, r.deadlock]).toEqual([2, 2, 0, 0]);
    expect(r.violation).toBeNull();
    expect(r.stuck).toBeNull();
    expect(r.explored.truncated).toBe(false);
  });
  test("one CPU, spinlock only: 4 of 6 schedules deadlock", () => {
    const r = K.raceReport("lock-only");
    expect([r.total, r.good, r.corrupt, r.deadlock]).toEqual([6, 2, 0, 4]);
    expect(r.stuck!.schedule).toEqual(["T0", "T1"]);
    expect(r.violation).toBeNull();
  });
  test("two CPUs, cli only: 100 of 126 corrupt the queue", () => {
    const r = K.raceReport("cli-two-cpus");
    expect([r.total, r.good, r.corrupt, r.deadlock]).toEqual([126, 26, 100, 0]);
  });
  test("two CPUs, cli and a spinlock: all 50 are correct", () => {
    const r = K.raceReport("irqsave-two-cpus");
    expect([r.total, r.good, r.corrupt, r.deadlock]).toEqual([50, 50, 0, 0]);
    expect(r.violation).toBeNull();
    expect(r.stuck).toBeNull();
  });
  test("queueProblem", () => {
    expect(K.queueProblem({ head: 3, tail: 2, next3: 1, next1: 2, next2: 0 })).toBeNull();
    expect(K.queueProblem({ head: 3, tail: 1, next3: 2, next1: 0, next2: 0 })).toContain("lost");
  });
});
