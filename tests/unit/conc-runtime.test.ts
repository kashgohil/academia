import { describe, expect, test } from "vitest";
import { Runtime, type MutexOptions, type RunResult } from "@/sims/conc";

/** Costs set to zero, so that a test can switch on only the cost it checks. */
const FREE = { switchNs: 0, wakeNs: 0, lockNs: 0, transferNs: 0 };

const ok = (r: RunResult) => {
  expect(r.error).toBeUndefined();
  expect(r.deadlock).toBeUndefined();
  expect(r.done).toBe(true);
};

const thread = (r: RunResult, name: string) => r.threads.find((t) => t.name === name)!;

describe("scheduling and work", () => {
  test("two threads of 1 µs: 2 µs on one core (plus one switch), 1 µs on two cores", () => {
    const run = (cores: number, switchNs: number) => {
      const rt = new Runtime({ cores, ...FREE, switchNs });
      for (const n of ["A", "B"]) rt.spawn(n, function* (t) { yield* t.work(1_000); });
      return rt.run();
    };
    expect(run(1, 0).makespan).toBe(2_000);
    // A runs 0..1000; the core switches to B (2,000 ns); B runs 3000..4000.
    const one = run(1, 2_000);
    expect(one.makespan).toBe(4_000);
    expect(one.cores[0]).toEqual({ core: 0, busyNs: 2_000, spinNs: 0, switchNs: 2_000 });
    expect(one.spans.map((s) => [s.kind, s.start, s.end])).toEqual([["run", 0, 1_000], ["switch", 1_000, 3_000], ["run", 3_000, 4_000]]);
    expect(run(2, 2_000).makespan).toBe(1_000);
  });

  test("more threads than cores: the third waits in the run queue", () => {
    const rt = new Runtime({ cores: 2, ...FREE });
    for (const n of ["A", "B", "C"]) rt.spawn(n, function* (t) { yield* t.work(1_000); });
    const r = rt.run();
    ok(r);
    expect(r.makespan).toBe(2_000);
    expect(thread(r, "C").runnableNs).toBe(1_000);
    expect(r.states.filter((s) => s.tid === 2).map((s) => s.state)).toEqual(["runnable", "running"]);
  });

  test("a quantum preempts long work only when another thread waits", () => {
    const rt = new Runtime({ cores: 1, ...FREE, quantumNs: 1_000 });
    for (const n of ["A", "B"]) rt.spawn(n, function* (t) { yield* t.work(3_000, n); });
    const r = rt.run();
    expect(r.spans.map((s) => s.label).join("")).toBe("ABABAB");
    expect([thread(r, "A").end, thread(r, "B").end]).toEqual([5_000, 6_000]);
    // Alone, the thread keeps its core: the quanta merge into one span.
    const solo = new Runtime({ cores: 1, ...FREE, quantumNs: 1_000 });
    solo.spawn("A", function* (t) { yield* t.work(3_000); });
    expect(solo.run().spans).toHaveLength(1);
  });

  test("sleep leaves the core; yieldNow goes to the back of the queue", () => {
    const rt = new Runtime({ cores: 1, ...FREE });
    const order: string[] = [];
    rt.spawn("A", function* (t) { order.push("A1"); yield* t.yieldNow(); order.push("A2"); yield* t.sleep(5_000); order.push(`A3@${t.now()}`); });
    rt.spawn("B", function* (t) { order.push("B1"); yield* t.work(1_000); order.push("B2"); });
    const r = rt.run();
    expect(order).toEqual(["A1", "B1", "B2", "A2", "A3@6000"]);
    expect(thread(r, "A").sleepNs).toBe(5_000);
  });
});

describe("mutex", () => {
  const modes: Partial<MutexOptions>[] = [];
  for (const wait of ["block", "spin", "adaptive"] as const) for (const handoff of [false, true]) modes.push({ wait, handoff });

  test.each(modes)("mutual exclusion holds: %o", (opts) => {
    for (const quantumNs of [0, 3_000]) {
      for (const seed of [1, 2, 3]) {
        const rt = new Runtime({ cores: 2, seed, quantumNs, sched: "random" });
        const m = rt.mutex("m", opts);
        let inside = 0;
        for (let i = 0; i < 4; i++) {
          rt.spawn(`T${i}`, function* (t) {
            for (let k = 0; k < 20; k++) {
              yield* t.lock(m);
              if (++inside > 1) throw new Error("two threads in the critical section");
              yield* t.work(200 + t.rand() * 1_000, "cs");
              inside--;
              t.unlock(m);
              yield* t.work(t.rand() * 500);
            }
          });
        }
        const r = rt.run();
        ok(r);
        expect(r.mutexes[0]!.acquisitions).toBe(80);
        expect(r.mutexes[0]!.contended).toBeGreaterThan(0);
      }
    }
  });

  test("the invariant check catches a missing lock", () => {
    const rt = new Runtime({ cores: 2 });
    let inside = 0;
    for (let i = 0; i < 2; i++) {
      rt.spawn(`T${i}`, function* (t) {
        if (++inside > 1) throw new Error("two threads in the critical section");
        yield* t.work(1_000);
        inside--;
      });
    }
    const r = rt.run();
    expect(r.error).toMatchObject({ message: "two threads in the critical section", name: "T1" });
  });

  // A re-locks at once in a loop. B asks once, at 100 ns.
  const order = (handoff: boolean) => {
    const rt = new Runtime({ cores: 2 });
    const m = rt.mutex("m", { handoff });
    const got: string[] = [];
    rt.spawn("A", function* (t) {
      for (let i = 0; i < 5; i++) { yield* t.lock(m); got.push("A"); yield* t.work(1_000); t.unlock(m); }
    });
    rt.spawn("B", function* (t) { yield* t.work(100); yield* t.lock(m); got.push("B"); t.unlock(m); });
    const r = rt.run();
    ok(r);
    return { got: got.join(""), r };
  };

  test("handoff serves B next (FIFO); barging lets the running thread win while B wakes", () => {
    const h = order(true), b = order(false);
    expect(h.got).toBe("ABAAAA");
    expect(b.got).toBe("AAAAAB");
    expect(h.r.mutexes[0]!.handoffs).toBe(2);
    expect(b.r.mutexes[0]!.handoffs).toBe(0);
    // With handoff A waits for B (1,020 to 6,140); with barging B wakes at 6,020 and finds the lock free.
    expect(h.r.mutexes[0]!.maxWaitNs).toBe(5_120);
    expect(b.r.mutexes[0]!.maxWaitNs).toBe(5_920);
    // Each handoff waits for a wake-up while the lock is held: a convoy.
    expect(h.r.makespan).toBeGreaterThan(2 * b.r.makespan);
  });

  test("handoff wait and hold: B owns the lock from 1,020 ns while it still wakes up", () => {
    const { r } = order(true);
    const owners = r.mutexes[0]!.owners;
    expect(owners.slice(0, 3)).toEqual([[0, 0], [1_020, 1], [6_140, 0]]);
  });

  test("spin holds a core and shows as spin time; block parks; adaptive spins then parks", () => {
    const run = (wait: MutexOptions["wait"]) => {
      const rt = new Runtime({ cores: 2 });
      const m = rt.mutex("m", { wait, spinNs: 2_000 });
      rt.spawn("A", function* (t) { yield* t.lock(m); yield* t.work(10_000); t.unlock(m); });
      rt.spawn("B", function* (t) { yield* t.work(100); yield* t.lock(m); yield* t.work(100); t.unlock(m); });
      const r = rt.run();
      ok(r);
      return r;
    };
    // A owns 20..10,020. A spinner sees the free lock at once: 20 ns acquire + 100 ns line transfer, then 100 ns work.
    const spin = run("spin");
    expect(spin.makespan).toBe(10_240);
    expect(spin.cores[1]!.spinNs).toBe(9_920);
    expect(thread(spin, "B").spinNs).toBe(9_920);
    expect(spin.spans.some((s) => s.kind === "spin" && s.core === 1 && s.start === 100 && s.end === 10_020)).toBe(true);
    // Blocked: B wakes 5,000 ns after the unlock.
    const block = run("block");
    expect(block.makespan).toBe(15_240);
    expect(block.cores[1]!.spinNs).toBe(0);
    expect(thread(block, "B").blockedNs).toBe(14_920);
    const adaptive = run("adaptive");
    expect(adaptive.cores[1]!.spinNs).toBe(2_000);
    expect(adaptive.makespan).toBe(15_240);
    expect(adaptive.states.filter((s) => s.tid === 1).map((s) => s.state)).toEqual(["running", "spinning", "blocked", "running"]);
  });

  test("switch, wake and transfer costs, computed by hand", () => {
    // One core. A: acquire 20, work 1,000, exit at 1,020. Switch to B: 2,000. B: acquire 20 (same core), work 1,000.
    const one = new Runtime({ cores: 1 });
    const m1 = one.mutex("m");
    for (const n of ["A", "B"]) one.spawn(n, function* (t) { yield* t.lock(m1); yield* t.work(1_000); t.unlock(m1); });
    expect(one.run().makespan).toBe(1_020 + 2_000 + 20 + 1_000);

    // Two cores. B blocks at 10. A unlocks at 1,020; B is runnable at 6,020 on its own core (no switch), pays
    // 20 + 100 (the lock last ran on core 0) and works 1,000.
    const two = new Runtime({ cores: 2 });
    const m2 = two.mutex("m");
    two.spawn("A", function* (t) { yield* t.lock(m2); yield* t.work(1_000); t.unlock(m2); });
    two.spawn("B", function* (t) { yield* t.work(10); yield* t.lock(m2); yield* t.work(1_000); t.unlock(m2); });
    const r = two.run();
    expect(r.makespan).toBe(1_020 + 5_000 + 120 + 1_000);
    expect(r.mutexes[0]).toMatchObject({ acquisitions: 2, contended: 1, waitNs: 6_010, holdNs: 1_020 + 1_120 });
    expect(r.cores[1]!.switchNs).toBe(0);
  });

  test("tryLock, and unlock by a non-owner is a panic", () => {
    const rt = new Runtime({ cores: 2 });
    const m = rt.mutex("m");
    const seen: boolean[] = [];
    rt.spawn("A", function* (t) { seen.push(t.tryLock(m)); yield* t.work(1_000); t.unlock(m); });
    rt.spawn("B", function* (t) { yield* t.work(10); seen.push(t.tryLock(m)); t.unlock(m); });
    const r = rt.run();
    expect(seen).toEqual([true, false]);
    expect(r.error).toMatchObject({ name: "B", t: 10 });
    expect(r.error!.message).toMatch(/unlock of mutex m by B/);
  });

  test("spinners on one core with no preemption make no progress; a quantum fixes it", () => {
    const run = (quantumNs: number) => {
      const rt = new Runtime({ cores: 1, quantumNs });
      const m = rt.mutex("m", { wait: "spin" });
      rt.spawn("A", function* (t) { yield* t.lock(m); yield* t.yieldNow(); t.unlock(m); });
      rt.spawn("B", function* (t) { yield* t.lock(m); t.unlock(m); });
      return rt.run();
    };
    const stuck = run(0);
    expect(stuck.deadlock?.detail).toMatch(/spinning/);
    expect(stuck.deadlock?.blocked.map((b) => b.on)).toEqual(["runnable", "mutex m"]);
    ok(run(10_000));
  });
});

describe("condition variable", () => {
  test("signal wakes one waiter; each waiter re-checks its predicate", () => {
    const rt = new Runtime({ cores: 3 });
    const m = rt.mutex("m"), cv = rt.cond("cv");
    let items = 0;
    const got: string[] = [];
    for (const n of ["C1", "C2"]) {
      rt.spawn(n, function* (t) {
        yield* t.lock(m);
        while (items === 0) yield* t.wait(cv, m);
        items--;
        got.push(`${n}@${t.now()}`);
        t.unlock(m);
      });
    }
    rt.spawn("P", function* (t) {
      for (let i = 0; i < 2; i++) {
        yield* t.work(20_000);
        yield* t.lock(m);
        items++;
        t.signal(cv);
        t.unlock(m);
      }
    });
    const r = rt.run();
    ok(r);
    expect(got.map((g) => g.split("@")[0])).toEqual(["C1", "C2"]);
    expect(r.conds[0]).toMatchObject({ waits: 2, signals: 2, wakeups: 2, lostSignals: 0 });
  });

  test("broadcast wakes every waiter; one signal for two waiters leaves one asleep", () => {
    const run = (all: boolean) => {
      const rt = new Runtime({ cores: 4 });
      const m = rt.mutex("m"), cv = rt.cond("cv");
      let go = false;
      for (const n of ["W1", "W2", "W3"]) {
        rt.spawn(n, function* (t) { yield* t.lock(m); while (!go) yield* t.wait(cv, m); t.unlock(m); });
      }
      rt.spawn("main", function* (t) {
        yield* t.work(50_000);
        yield* t.lock(m);
        go = true;
        if (all) t.broadcast(cv);
        else t.signal(cv);
        t.unlock(m);
      });
      return rt.run();
    };
    const b = run(true);
    ok(b);
    expect(b.conds[0]!.wakeups).toBe(3);
    const s = run(false);
    expect(s.deadlock?.blocked.map((x) => `${x.name} ${x.on}`)).toEqual(["W2 cond cv", "W3 cond cv"]);
  });

  test("lost wake-up: a signal before the wait is lost, and the waiter sleeps forever", () => {
    const run = (checkFlag: boolean) => {
      const rt = new Runtime({ cores: 2 });
      const m = rt.mutex("m"), cv = rt.cond("cv");
      let done = false;
      rt.spawn("waiter", function* (t) {
        yield* t.work(5_000);
        yield* t.lock(m);
        if (checkFlag) while (!done) yield* t.wait(cv, m);
        else yield* t.wait(cv, m);
        t.unlock(m);
      });
      rt.spawn("signaler", function* (t) { yield* t.lock(m); done = true; t.signal(cv); t.unlock(m); });
      return rt.run();
    };
    const bad = run(false);
    expect(bad.conds[0]!.lostSignals).toBe(1);
    expect(bad.deadlock?.blocked).toEqual([{ tid: 0, name: "waiter", on: "cond cv" }]);
    expect(bad.deadlock?.detail).toMatch(/all goroutines are asleep/);
    ok(run(true));
  });

  test("spurious wake-ups: `while` survives them, `if` does not", () => {
    const run = (loop: boolean) => {
      const rt = new Runtime({ cores: 2, seed: 7 });
      const m = rt.mutex("m"), cv = rt.cond("cv", { spuriousRate: 0.5 });
      let ready = false;
      rt.spawn("waiter", function* (t) {
        yield* t.lock(m);
        if (loop) while (!ready) yield* t.wait(cv, m);
        else if (!ready) yield* t.wait(cv, m);
        if (!ready) throw new Error("woke up with no data");
        t.unlock(m);
      });
      rt.spawn("setter", function* (t) { yield* t.work(50_000); yield* t.lock(m); ready = true; t.signal(cv); t.unlock(m); });
      return rt.run();
    };
    const good = run(true);
    ok(good);
    expect(good.conds[0]!.spurious).toBeGreaterThan(0);
    expect(run(false).error?.message).toBe("woke up with no data");
  });

  test("wait without holding the mutex is a panic", () => {
    const rt = new Runtime();
    const m = rt.mutex("m"), cv = rt.cond("cv");
    rt.spawn("A", function* (t) { yield* t.wait(cv, m); });
    expect(rt.run().error?.message).toMatch(/without holding mutex m/);
  });
});

describe("reader-writer lock", () => {
  // Three readers, staggered by 300 ns, re-enter after 50 ns: some reader always holds the lock.
  const writerWait = (prefer: "reader" | "writer" | "fair") => {
    const rt = new Runtime({ cores: 4 });
    const rw = rt.rwlock("rw", { prefer });
    let readers = 0, writer = false;
    for (let i = 0; i < 3; i++) {
      rt.spawn(`R${i}`, function* (t) {
        yield* t.work(1 + i * 300);
        for (let k = 0; k < 10; k++) {
          yield* t.rlock(rw);
          if (writer) throw new Error("reader inside with a writer");
          readers++;
          yield* t.work(1_000);
          readers--;
          t.runlock(rw);
          yield* t.work(50);
        }
      });
    }
    rt.spawn("W", function* (t) {
      yield* t.work(500);
      yield* t.wlock(rw);
      if (readers) throw new Error("writer inside with readers");
      writer = true;
      yield* t.work(100);
      writer = false;
      t.wunlock(rw);
    });
    const r = rt.run();
    ok(r);
    return r.rwlocks[0]!;
  };

  test("reader preference starves the writer; writer preference and fair do not", () => {
    const reader = writerWait("reader"), writer = writerWait("writer"), fair = writerWait("fair");
    expect(reader.reads).toBe(30);
    expect(reader.maxWriteWaitNs).toBeGreaterThan(10_000);
    expect(writer.maxWriteWaitNs).toBeLessThan(2_000);
    expect(fair.maxWriteWaitNs).toBeLessThan(2_000);
    // Under writer preference the readers that came after the writer waited.
    expect(writer.readWaitNs).toBeGreaterThan(0);
  });

  test("readers share the lock", () => {
    const rt = new Runtime({ cores: 3, ...FREE });
    const rw = rt.rwlock("rw");
    for (const n of ["A", "B", "C"]) rt.spawn(n, function* (t) { yield* t.rlock(rw); yield* t.work(1_000); t.runlock(rw); });
    expect(rt.run().makespan).toBe(1_000);
  });
});

describe("semaphore", () => {
  test("at most n holders; waiters get permits in FIFO order", () => {
    const rt = new Runtime({ cores: 5, ...FREE });
    const s = rt.semaphore("s", 2);
    let inUse = 0, most = 0;
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      rt.spawn(`T${i}`, function* (t) {
        yield* t.work(i);
        yield* t.acquire(s);
        order.push(t.name);
        most = Math.max(most, ++inUse);
        yield* t.work(1_000);
        inUse--;
        t.release(s);
      });
    }
    const r = rt.run();
    ok(r);
    expect(most).toBe(2);
    expect(order).toEqual(["T0", "T1", "T2", "T3", "T4"]);
    expect(r.semaphores[0]).toMatchObject({ acquires: 5, contended: 3 });
    expect(r.makespan).toBe(3_000);
  });
});

describe("channels", () => {
  test("capacity 0 is a rendezvous: the first side waits, the second goes on at once", () => {
    const rt = new Runtime({ cores: 2 });
    const ch = rt.channel<number>("c", 0);
    const at: Record<string, number> = {};
    rt.spawn("S", function* (t) { yield* t.send(ch, 42); at.sent = t.now(); });
    rt.spawn("R", function* (t) {
      yield* t.work(1_000);
      const r = yield* t.recv(ch);
      at.got = t.now();
      at.value = r.ok ? r.value : -1;
    });
    const r = rt.run();
    ok(r);
    // The receiver arrives at 1,000 and takes the value. The sender wakes 5,000 ns later.
    expect(at).toEqual({ got: 1_000, value: 42, sent: 6_000 });
    expect(r.channels[0]).toMatchObject({ sends: 1, recvs: 1, maxLen: 0, sendBlockedNs: 1_000, recvBlockedNs: 0 });
    expect(r.states.find((s) => s.tid === 0 && s.state === "blocked")?.on).toBe("chan c (send)");
  });

  test("a buffered channel holds `capacity` values; the next send blocks", () => {
    const rt = new Runtime({ cores: 2 });
    const ch = rt.channel<number>("c", 3);
    const sentAt: number[] = [];
    const got: number[] = [];
    rt.spawn("P", function* (t) { for (let i = 0; i < 5; i++) { yield* t.send(ch, i); sentAt.push(t.now()); } });
    rt.spawn("C", function* (t) {
      yield* t.sleep(10_000);
      for (let i = 0; i < 5; i++) { const r = yield* t.recv(ch); if (r.ok) got.push(r.value); }
    });
    const r = rt.run();
    ok(r);
    expect(sentAt.slice(0, 3)).toEqual([0, 0, 0]);
    expect(sentAt[3]).toBe(15_000);
    expect(got).toEqual([0, 1, 2, 3, 4]);
    expect(r.channels[0]!.maxLen).toBe(3);
  });

  test("close: receivers drain the buffer, then get ok: false; a blocked receiver wakes with ok: false", () => {
    const rt = new Runtime({ cores: 2 });
    const ch = rt.channel<string>("c", 2), done = rt.channel<number>("done", 0);
    const got: string[] = [];
    rt.spawn("P", function* (t) { yield* t.send(ch, "a"); yield* t.send(ch, "b"); t.close(ch); yield* t.work(1_000); t.close(done); });
    rt.spawn("C", function* (t) {
      yield* t.sleep(5_000);
      for (let i = 0; i < 4; i++) { const r = yield* t.recv(ch); got.push(r.ok ? r.value : "closed"); }
    });
    rt.spawn("D", function* (t) { const r = yield* t.recv(done); got.push(`done ${r.ok}`); });
    ok(rt.run());
    expect(got).toEqual(["done false", "a", "b", "closed", "closed"]);
  });

  test("send on a closed channel and a second close are panics", () => {
    const panic = (body: (rt: Runtime) => void) => {
      const rt = new Runtime();
      body(rt);
      return rt.run().error?.message;
    };
    expect(panic((rt) => {
      const ch = rt.channel<number>("c", 1);
      rt.spawn("A", function* (t) { t.close(ch); yield* t.send(ch, 1); });
    })).toBe("send on closed channel c");
    expect(panic((rt) => {
      const ch = rt.channel<number>("c", 1);
      rt.spawn("A", function* (t) { t.close(ch); t.close(ch); });
    })).toBe("close of closed channel c");
    // A sender blocked when the channel closes panics when it wakes.
    expect(panic((rt) => {
      const ch = rt.channel<number>("c", 0);
      rt.spawn("S", function* (t) { yield* t.send(ch, 1); });
      rt.spawn("X", function* (t) { yield* t.work(100); t.close(ch); });
    })).toBe("send on closed channel c");
  });

  test("select picks among ready cases at random with the seed, about evenly", () => {
    const run = (seed: number) => {
      const rt = new Runtime({ seed });
      const a = rt.channel<number>("a", 500), b = rt.channel<string>("b", 500);
      const picks: number[] = [];
      rt.spawn("main", function* (t) {
        for (let i = 0; i < 500; i++) { t.trySend(a, i); t.trySend(b, `${i}`); }
        for (let i = 0; i < 500; i++) {
          const r = yield* t.select([{ recv: a }, { recv: b }]);
          picks.push(r.index);
          // value is typed number | string | undefined.
          if (r.index === 0 && typeof r.value !== "number") throw new Error("wrong value");
        }
      });
      ok(rt.run());
      return picks;
    };
    const p = run(1);
    const zeros = p.filter((i) => i === 0).length;
    expect(zeros).toBeGreaterThan(200);
    expect(zeros).toBeLessThan(300);
    expect(run(1)).toEqual(p);
    expect(run(2)).not.toEqual(p);
  });

  test("select: the default case when nothing is ready; a blocked select takes the first case that becomes ready", () => {
    const rt = new Runtime({ cores: 2 });
    const a = rt.channel<number>("a"), b = rt.channel<number>("b");
    const out: string[] = [];
    rt.spawn("main", function* (t) {
      const d = yield* t.select([{ recv: a }, { send: b, value: 1 }], { default: true });
      out.push(`default ${d.index}`);
      const r = yield* t.select([{ recv: a }, { recv: b }]);
      out.push(`case ${r.index} value ${r.value} at ${t.now()}`);
      // The select no longer waits on a: a send to a finds no receiver.
      out.push(`trySend a ${t.trySend(a, 3)}`);
    });
    rt.spawn("other", function* (t) { yield* t.work(1_000); yield* t.send(b, 7); });
    ok(rt.run());
    expect(out).toEqual(["default -1", "case 1 value 7 at 6000", "trySend a false"]);
  });

  test("tryRecv returns null when it would block", () => {
    const rt = new Runtime();
    const ch = rt.channel<number>("c", 1);
    const out: unknown[] = [];
    rt.spawn("A", function* (t) { out.push(t.tryRecv(ch)); t.trySend(ch, 5); out.push(t.tryRecv(ch)); t.close(ch); out.push(t.tryRecv(ch)); });
    ok(rt.run());
    expect(out).toEqual([null, { ok: true, value: 5 }, { ok: false, value: undefined }]);
  });
});

describe("threads", () => {
  test("spawn and join return typed values", () => {
    const rt = new Runtime({ cores: 4 });
    const main = rt.spawn("main", function* (t) {
      const ids = [1, 2, 3].map((i) => t.spawn(`child${i}`, function* (c) { yield* c.work(i * 1_000); return i * i; }));
      let sum = 0;
      for (const id of ids) {
        const v: number = yield* t.join(id);
        sum += v;
      }
      return sum;
    });
    const r = rt.run();
    ok(r);
    expect(r.threads[main]!.value).toBe(14);
    expect(r.events.filter((e) => e.kind === "spawn").map((e) => e.tid)).toEqual([-1, 0, 0, 0]);
  });

  test("rt.at runs scripted events", () => {
    const rt = new Runtime({ cores: 2, ...FREE });
    rt.at(5_000, (r) => r.spawn("late", function* (t) { yield* t.work(1_000); }));
    rt.spawn("early", function* (t) { yield* t.work(1_000); });
    const r = rt.run();
    ok(r);
    expect(thread(r, "late")).toMatchObject({ start: 5_000, end: 6_000 });
  });
});

describe("deadlock", () => {
  test("two mutexes taken in opposite orders", () => {
    const rt = new Runtime({ cores: 2 });
    const a = rt.mutex("a"), b = rt.mutex("b");
    rt.spawn("T1", function* (t) { yield* t.lock(a); yield* t.work(100); yield* t.lock(b); });
    rt.spawn("T2", function* (t) { yield* t.lock(b); yield* t.work(100); yield* t.lock(a); });
    const r = rt.run();
    expect(r.done).toBe(false);
    expect(r.deadlock).toEqual({
      t: 120,
      blocked: [{ tid: 0, name: "T1", on: "mutex b" }, { tid: 1, name: "T2", on: "mutex a" }],
      detail: "fatal error: all goroutines are asleep - deadlock!",
    });
  });

  test("a send with no receiver", () => {
    const rt = new Runtime();
    const ch = rt.channel<number>("c");
    rt.spawn("main", function* (t) { yield* t.send(ch, 1); });
    expect(rt.run().deadlock?.blocked).toEqual([{ tid: 0, name: "main", on: "chan c (send)" }]);
  });
});

describe("determinism, recording and speed", () => {
  const program = (seed: number, record = true) => {
    const rt = new Runtime({ cores: 2, seed, sched: "random", quantumNs: 1_500, record });
    const m = rt.mutex("m", { wait: "adaptive" });
    const ch = rt.channel<number>("jobs", 2);
    rt.spawn("producer", function* (t) {
      for (let i = 0; i < 30; i++) { yield* t.work(300 + t.rand() * 700, "make"); yield* t.send(ch, i); }
      t.close(ch);
    });
    for (let w = 0; w < 3; w++) {
      rt.spawn(`worker${w}`, function* (t) {
        for (;;) {
          const r = yield* t.recv(ch);
          if (!r.ok) break;
          yield* t.lock(m);
          yield* t.work(200 + t.rand() * 2_000, "cs");
          t.unlock(m);
        }
      });
    }
    return rt.run();
  };

  test("the same seed gives the same run; another seed gives another", () => {
    const a = program(7);
    ok(a);
    expect(program(7)).toEqual(a);
    expect(program(8).events).not.toEqual(a.events);
  });

  test("record: false keeps the statistics and drops the traces", () => {
    const a = program(3), b = program(3, false);
    expect(b.spans).toEqual([]);
    expect(b.states).toEqual([]);
    expect(b.events).toEqual([]);
    expect(b.threads).toEqual(a.threads);
    expect(b.cores).toEqual(a.cores);
    expect(b.makespan).toBe(a.makespan);
    expect(b.mutexes[0]).toEqual({ ...a.mutexes[0], owners: [] });
    expect(b.channels[0]).toEqual({ ...a.channels[0], lens: [] });
    // The spans account for every busy core nanosecond.
    const busy = a.spans.filter((s) => s.kind === "run").reduce((x, s) => x + s.end - s.start, 0);
    expect(busy).toBeCloseTo(a.cores.reduce((x, c) => x + c.busyNs, 0), 6);
  });

  test("100,000 lock/unlock pairs and 100,000 channel operations run fast", () => {
    const t0 = performance.now();
    const rt = new Runtime({ cores: 4, record: false });
    const m = rt.mutex("m");
    for (let i = 0; i < 4; i++) rt.spawn(`T${i}`, function* (t) { for (let k = 0; k < 25_000; k++) { yield* t.lock(m); yield* t.work(10); t.unlock(m); } });
    const r = rt.run();
    ok(r);
    expect(r.mutexes[0]!.acquisitions).toBe(100_000);

    const rc = new Runtime({ cores: 2, record: false });
    const ch = rc.channel<number>("c", 16);
    rc.spawn("P", function* (t) { for (let k = 0; k < 50_000; k++) yield* t.send(ch, k); t.close(ch); });
    rc.spawn("C", function* (t) { for (;;) { const x = yield* t.recv(ch); if (!x.ok) break; yield* t.work(1); } });
    const rr = rc.run();
    ok(rr);
    expect(rr.channels[0]!.recvs).toBe(50_000);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1_500);
  });
});
