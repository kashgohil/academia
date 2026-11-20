/** Pins every number that the locks lessons quote, and checks the models' basic safety properties. */
import { describe, expect, test } from "vitest";
import { DEFAULT_COSTS, Runtime } from "@/sims/conc";
import {
  lockLoop, goMutexLoop, GoMutex, LOCKED, STARVING, WAITER_SHIFT, STARVATION_NS,
  exploreGoRw, rwLoop, exploreSeqlock, showCount, MAX_READERS,
  barrierRun, timedWaitRun, transfers, abba,
  contendedLoop, lockBound, idealPerMs, saturationThreads, stripedLoop, zipfCdf, pickKey,
} from "@/sims/conc/locks";

const us = (ns: number, d = 1) => Number((ns / 1_000).toFixed(d));
const msr = (ns: number, d = 2) => Number((ns / 1_000_000).toFixed(d));

describe("mutexes: handoff against barging", () => {
  const barge = lockLoop({ record: false });
  const hand = lockLoop({ handoff: true, record: false });
  test("4 threads, 1 µs inside, about 2 µs outside: 466 against 166 acquisitions per ms", () => {
    expect(barge.perMs).toBe(466);
    expect(hand.perMs).toBe(166);
    expect(Math.round(barge.perMs / hand.perMs * 10) / 10).toBe(2.8);
  });
  test("the handoff limit 1 / (cs + wake + acquire) is about 163 per ms", () => {
    const limit = 1e6 / (1_000 + DEFAULT_COSTS.wakeNs + DEFAULT_COSTS.lockNs + DEFAULT_COSTS.transferNs);
    expect(Math.round(limit)).toBe(163);
    expect((DEFAULT_COSTS.lockNs + DEFAULT_COSTS.transferNs) / 1_000).toBe(0.12);
    expect(hand.perMs).toBeGreaterThan(limit);
  });
  test("waits and evenness: barging 55.3 µs and 0.87, handoff 17.4 µs and 0.98", () => {
    expect(us(barge.maxWaitNs)).toBe(55.3);
    expect(us(hand.maxWaitNs)).toBe(17.4);
    expect(barge.evenness.toFixed(2)).toBe("0.87");
    expect(hand.evenness.toFixed(2)).toBe("0.98");
    expect(Math.round(hand.heldFrac * 100)).toBe(100);
  });
  test("8 threads: barging 634, handoff 139 per ms", () => {
    expect(lockLoop({ threads: 8, record: false }).perMs).toBe(634);
    expect(lockLoop({ threads: 8, handoff: true, record: false }).perMs).toBe(139);
  });
});

describe("mutexes: Go's sync.Mutex model", () => {
  test("with no work between locks, starvation mode bounds the wait near 1 ms", () => {
    const on = goMutexLoop({ threads: 4, outsideNs: 0, starvation: true, record: false });
    expect(on.perThread).toEqual([3909, 7, 7, 7]);
    expect(msr(on.maxWaitNs)).toBe(1.03);
    expect(on.longWaits).toBe(21);
    expect((on.starvingFrac * 100).toFixed(1)).toBe("2.4");
    expect(Math.round(on.perMs)).toBe(491);
  });
  test("Go 1.8 behaviour: one goroutine takes all 4,001 locks, the others wait the whole 8 ms", () => {
    const off = goMutexLoop({ threads: 4, outsideNs: 0, starvation: false, record: false });
    expect(off.perThread).toEqual([4001, 0, 0, 0]);
    expect(off.maxWaitNs).toBe(8_000_000);
    expect(Math.round(off.perMs)).toBe(500);
  });
  test("with 500 ns between locks, no wait reaches 1 ms, and both settings give the same run", () => {
    const a = goMutexLoop({ threads: 4, outsideNs: 500, starvation: true, record: false });
    const b = goMutexLoop({ threads: 4, outsideNs: 500, starvation: false, record: false });
    expect(a.longWaits).toBe(0);
    expect(a.starvingFrac).toBe(0);
    expect(a.perThread).toEqual(b.perThread);
    expect(a.maxWaitNs).toBeLessThan(STARVATION_NS);
  });
  test("mutual exclusion and a consistent state word over many seeds", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rt = new Runtime({ cores: 4, seed, record: false });
      const mu = new GoMutex(rt, { starvation: true, cores: 4, spinRoundNs: 500, record: true });
      let inside = 0, bad = 0;
      for (let i = 0; i < 5; i++) {
        const park = rt.semaphore(`p${i}`, 0);
        rt.spawn(`G${i}`, function* (t) {
          for (let k = 0; k < 200; k++) {
            yield* mu.lock(t, park);
            if (inside++ !== 0) bad++;
            yield* t.work(500 + 1_500 * t.rand());
            inside--;
            mu.unlock(t);
            yield* t.work(seed % 3 === 0 ? 0 : 300 * t.rand());
          }
        });
      }
      const r = rt.run();
      expect(r.error).toBeUndefined();
      expect(r.done).toBe(true);
      expect(bad).toBe(0);
      expect(mu.state).toBe(0);
      for (const [, s] of mu.log) expect(s >> WAITER_SHIFT).toBeGreaterThanOrEqual(0);
      // Starving implies a waiter or an owner.
      for (const [, s] of mu.log) if (s & STARVING) expect((s & LOCKED) || s >> WAITER_SHIFT).toBeTruthy();
    }
  });
});

describe("reader-writer locks", () => {
  test("Go RWMutex: a recursive read lock deadlocks in 8 steps; without it, no deadlock", () => {
    const rec = exploreGoRw({ recursive: true, policy: "go" });
    expect(rec.states).toBe(1421);
    expect(rec.stuck?.schedule.length).toBe(8);
    const plain = exploreGoRw({ recursive: false, policy: "go" });
    expect(plain.states).toBe(650);
    expect(plain.stuck).toBeNull();
    const glibc = exploreGoRw({ recursive: true, policy: "reader" });
    expect(glibc.states).toBe(426);
    expect(glibc.stuck).toBeNull();
  });
  test("readerCount shows the pending writer as minus 2^30", () => {
    expect(MAX_READERS).toBe(1 << 30);
    expect(showCount(2 - MAX_READERS)).toBe("2 − 2³⁰");
    expect(showCount(3)).toBe("3");
  });
  test("policies on 8 cores: the writer starves under reader preference with 6 readers", () => {
    const reader = rwLoop({ policy: "reader", record: false });
    expect(reader.writes).toBe(0);
    expect(reader.writesWanted).toBe(1);
    expect(us(reader.maxWriteWaitNs)).toBe(190);
    expect(reader.readsPerMs).toBe(1195);
    const writer = rwLoop({ policy: "writer", record: false });
    expect([writer.writes, writer.writesWanted]).toEqual([10, 10]);
    expect(us(writer.maxWriteWaitNs)).toBe(9.1);
    expect(writer.readsPerMs).toBe(570);
    const mutex = rwLoop({ policy: "mutex", record: false });
    expect(mutex.readsPerMs).toBe(190);
    expect(us(mutex.meanReadWaitNs)).toBe(24.4);
    const four = rwLoop({ policy: "reader", readers: 4, record: false });
    expect([four.writes, four.writesWanted]).toEqual([10, 10]);
  });
  test("seqlock: a torn read in 6 steps without the check; with it, only real pairs", () => {
    const no = exploreSeqlock({ check: false });
    expect(no.states).toBe(283);
    expect(no.violation?.schedule.length).toBe(6);
    const yes = exploreSeqlock({ check: true });
    expect(yes.states).toBe(397);
    expect(yes.violation).toBeNull();
    expect(yes.outcomes).toEqual(["(0, 0)", "(1, 1)", "(2, 2)"]);
  });
});

describe("condition variables", () => {
  test("the count barrier hangs at 32.8 µs; the generation barrier finishes at 194.5 µs", () => {
    const bad = barrierRun({ threads: 4, workNs: 10_000, spread: 0.5, design: "count", record: false });
    expect(bad.hung).toBe(true);
    expect(bad.rounds).toBe(0);
    expect(us(bad.hangNs!)).toBe(32.8);
    const good = barrierRun({ threads: 4, workNs: 10_000, spread: 0.5, design: "generation", record: false });
    expect(good.hung).toBe(false);
    expect(good.rounds).toBe(8);
    expect(us(good.result.makespan)).toBe(194.5);
  });
  test("with 20 µs rounds the count barrier gets through, at 285.7 µs like the generation barrier", () => {
    const a = barrierRun({ threads: 4, workNs: 20_000, spread: 0.5, design: "count", record: false });
    const b = barrierRun({ threads: 4, workNs: 20_000, spread: 0.5, design: "generation", record: false });
    expect(a.hung).toBe(false);
    expect(us(a.result.makespan)).toBe(285.7);
    expect(b.result.makespan).toBe(a.result.makespan);
  });
  test("8 threads: the count barrier hangs even with 100 µs rounds; the generation barrier never hangs", () => {
    expect(barrierRun({ threads: 8, workNs: 100_000, spread: 0.5, design: "count", record: false }).hung).toBe(true);
    for (const threads of [2, 4, 8]) for (const workNs of [5_000, 10_000, 100_000]) {
      expect(barrierRun({ threads, workNs, spread: 0.5, design: "generation", record: false }).hung).toBe(false);
    }
  });
  test("timed waits: a loop of wait_for never times out with broadcasts every 4 ms; a deadline does", () => {
    const rel = timedWaitRun({ design: "relative", noiseNs: 4_000_000, record: false });
    expect(rel.outcome).toBe("still waiting");
    expect(rel.wakeups).toBe(14);
    const dl = timedWaitRun({ design: "deadline", noiseNs: 4_000_000, record: false });
    expect(dl.outcome).toBe("timeout");
    expect(msr(dl.returnedNs!, 1)).toBe(10.0);
    for (const design of ["relative", "deadline"] as const) {
      const r = timedWaitRun({ design, noiseNs: 11_000_000, record: false });
      expect(r.outcome).toBe("timeout");
      expect(msr(r.returnedNs!, 1)).toBe(10.0);
    }
  });
});

describe("deadlock, livelock and starvation", () => {
  test("fixed back-off livelocks: no transfer and 124 failures in 200 µs", () => {
    const r = transfers({ strategy: "backoff", jitter: 0, record: false });
    expect(r.done).toEqual([0, 0]);
    expect(r.failures).toBe(124);
    expect(r.finishNs).toBeUndefined();
  });
  test("jitter ±5%: 7 of 20; ±50%: done at 72.6 µs with 15 failures", () => {
    const a = transfers({ strategy: "backoff", jitter: 0.05, record: false });
    expect(a.done[0]! + a.done[1]!).toBe(7);
    const b = transfers({ strategy: "backoff", jitter: 0.5, record: false });
    expect(us(b.finishNs!)).toBe(72.6);
    expect(b.failures).toBe(15);
  });
  test("std::lock style: 65.8 µs with 2 failures; lock order: 62.0 µs with none", () => {
    const s = transfers({ strategy: "stdlock", record: false });
    expect(us(s.finishNs!)).toBe(65.8);
    expect(s.failures).toBe(2);
    const o = transfers({ strategy: "order", record: false });
    expect(us(o.finishNs!)).toBe(62.0);
    expect(o.failures).toBe(0);
  });
  test("the runtime reports the deadlock at 6.02 µs, not with a ticker; no deadlock if T2 starts at 5.5 µs", () => {
    const a = abba({ offsetNs: 1_000, record: false });
    expect(a.reported).toBe(true);
    expect(us(a.result.deadlock!.t, 2)).toBe(6.02);
    const b = abba({ offsetNs: 1_000, background: true, record: false });
    expect(b.reported).toBe(false);
    expect(b.stuck).toBe(true);
    const c = abba({ offsetNs: 5_500, record: false });
    expect(c.reported).toBe(false);
    expect(c.stuck).toBe(false);
    expect(c.result.done).toBe(true);
  });
});

describe("lock contention", () => {
  test("the limit of one lock and the saturation point at 20% inside", () => {
    expect(Math.round(lockBound(2_000, false))).toBe(472);
    expect(saturationThreads(2_000, 8_000).toFixed(1)).toBe("4.7");
    expect(idealPerMs(8, 8, 2_000, 8_000)).toBe(800);
    expect(Math.round(lockBound(1_000, false))).toBe(893);
  });
  test("20% inside: spin stays at 472, adaptive near 390, block falls from 408 to 314", () => {
    const run = (threads: number, wait: "spin" | "adaptive" | "block") => contendedLoop({ threads, wait, csNs: 2_000, outsideNs: 8_000 });
    expect(run(8, "spin").perMs).toBe(472);
    const spin32 = run(32, "spin");
    expect(spin32.perMs).toBe(472);
    expect(Math.round(spin32.shares.spin * 100)).toBe(41);
    expect(Math.round(run(8, "adaptive").perMs)).toBe(387);
    expect(Math.round(run(32, "adaptive").perMs)).toBe(394);
    expect(run(8, "block").perMs).toBe(408);
    const block32 = run(32, "block");
    expect(Math.round(block32.perMs)).toBe(314);
    expect(Math.round(block32.shares.idle * 100)).toBe(53);
  });
  test("10% inside: spin reaches 733, block about 563; 30% inside: block peaks at 252", () => {
    expect(contendedLoop({ threads: 32, wait: "spin", csNs: 1_000, outsideNs: 9_000 }).perMs).toBe(733);
    expect(Math.round(contendedLoop({ threads: 32, wait: "block", csNs: 1_000, outsideNs: 9_000 }).perMs)).toBe(563);
    const peak = Math.max(...[1, 2, 4, 6, 8, 12, 16, 24, 32].map((threads) => contendedLoop({ threads, wait: "block", csNs: 3_000, outsideNs: 7_000 }).perMs));
    expect(Math.round(peak)).toBe(252);
  });
  test("striping: 665, 1,494 and 1,891 operations per ms; a hot key caps 64 stripes at 972", () => {
    expect(stripedLoop({ stripes: 1 }).perMs).toBe(665);
    expect(stripedLoop({ stripes: 8 }).perMs).toBe(1494);
    expect(stripedLoop({ stripes: 64 }).perMs).toBe(1891);
    expect((8 * 1e6) / 4_000).toBe(2000);
    const hot = stripedLoop({ stripes: 64, skew: 2 });
    expect(hot.perMs).toBe(972);
    expect(Math.round(hot.hottest * 100)).toBe(60);
  });
  test("Zipf sampling: uniform with skew 0, key 0 near 61% with skew 2", () => {
    const cdf0 = zipfCdf(1024, 0);
    expect(cdf0[511]).toBeCloseTo(0.5, 9);
    const cdf2 = zipfCdf(1024, 2);
    expect(Math.round(cdf2[0]! * 100)).toBe(61);
    expect(pickKey(cdf2, 0.3)).toBe(0);
    expect(pickKey(cdf0, 0.9999)).toBe(1023);
  });
});
