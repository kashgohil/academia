/**
 * Condition variable models for the "condition-variables" lesson, on the shared Runtime.
 *
 * - barrierRun: N threads do rounds of work and meet at a barrier that is built from a mutex and a condition
 *   variable. The "count" design waits `while (arrived != 0)` and is reset by the last thread: a fast thread can
 *   arrive in the next round before the sleepers check, and they sleep again forever. The "generation" design waits
 *   for a round number to change, as Java's CyclicBarrier (its Generation object) and C++20 std::barrier do.
 * - timedWaitRun: a waiter wants "ready" with a 10 ms timeout. Another thread notifies the same condition variable
 *   for other reasons every `noiseNs`. A loop around a relative wait_for restarts the timeout at each wake-up; a wait
 *   until a fixed deadline does not. A timed wait is a wait plus a timer thread that notifies at the timeout.
 */
import { Runtime, type RunResult } from "../index";

export type BarrierDesign = "count" | "generation";

export interface BarrierSpec {
  threads: number;
  cores: number;
  rounds: number;
  /** Mean work per round (ns). */
  workNs: number;
  /** Spread of the work: each round draws work from (1 − spread) to (1 + spread) times workNs. */
  spread: number;
  design: BarrierDesign;
  seed: number;
  record: boolean;
}

export const BARRIER_DEFAULTS: BarrierSpec = { threads: 4, cores: 4, rounds: 8, workNs: 10_000, spread: 0.9, design: "count", seed: 2, record: true };

export interface BarrierResult {
  result: RunResult;
  /** Rounds that every thread finished. */
  rounds: number;
  /** Wake-ups after which the waiter found that it must sleep again. */
  resleeps: number;
  hung: boolean;
  /** The time of the hang, if any. */
  hangNs?: number;
}

export function barrierRun(spec: Partial<BarrierSpec> = {}): BarrierResult {
  const s = { ...BARRIER_DEFAULTS, ...spec };
  const rt = new Runtime({ cores: s.cores, seed: s.seed, record: s.record });
  const m = rt.mutex("m");
  const cv = rt.cond("cv");
  let arrived = 0, generation = 0, resleeps = 0;
  const done = new Array<number>(s.threads).fill(0);
  for (let i = 0; i < s.threads; i++) {
    rt.spawn(`T${i}`, function* (t) {
      for (let r = 0; r < s.rounds; r++) {
        yield* t.work(s.workNs * (1 - s.spread + 2 * s.spread * t.rand()), `r${r + 1}`);
        yield* t.lock(m);
        if (s.design === "count") {
          arrived++;
          if (arrived === s.threads) {
            arrived = 0;
            t.broadcast(cv);
          } else {
            yield* t.wait(cv, m);
            // The buggy check: "the last thread resets the count to 0".
            while (arrived !== 0) {
              resleeps++;
              yield* t.wait(cv, m);
            }
          }
        } else {
          const gen = generation;
          arrived++;
          if (arrived === s.threads) {
            arrived = 0;
            generation++;
            t.broadcast(cv);
          } else {
            yield* t.wait(cv, m);
            while (generation === gen) {
              resleeps++;
              yield* t.wait(cv, m);
            }
          }
        }
        t.unlock(m);
        done[i] = r + 1;
      }
    });
  }
  const result = rt.run();
  return { result, rounds: Math.min(...done), resleeps, hung: !!result.deadlock, hangNs: result.deadlock?.t };
}

export type TimedDesign = "relative" | "deadline";

export interface TimedSpec {
  /** The timeout the caller asked for (ns). */
  timeoutNs: number;
  /** Another thread notifies the condition variable every noiseNs, for a condition that this waiter does not need. */
  noiseNs: number;
  /** "ready" becomes true at readyNs. Infinity: never. */
  readyNs: number;
  design: TimedDesign;
  /** Stop the run here. */
  limitNs: number;
  record: boolean;
}

export const TIMED_DEFAULTS: TimedSpec = { timeoutNs: 10_000_000, noiseNs: 4_000_000, readyNs: Infinity, design: "relative", limitNs: 60_000_000, record: true };

export interface TimedResult {
  result: RunResult;
  /** When the waiter returned, or undefined if it still waits at the limit. */
  returnedNs?: number;
  /** "ready", "timeout", or "still waiting". */
  outcome: "ready" | "timeout" | "still waiting";
  wakeups: number;
}

/**
 * A waiter with a timeout. The timer is a thread that sleeps until the timeout and then notifies, which is what the
 * kernel timer of a real timed wait does. Each relative wait arms a new timer; a deadline wait arms one.
 */
export function timedWaitRun(spec: Partial<TimedSpec> = {}): TimedResult {
  const s = { ...TIMED_DEFAULTS, ...spec };
  const rt = new Runtime({ cores: 2, seed: 1, record: s.record });
  const m = rt.mutex("m");
  const cv = rt.cond("cv");
  let ready = false, wakeups = 0, returned: number | undefined, outcome: TimedResult["outcome"] = "still waiting";
  // The armed timers: a timer fires only if its wait is still the current one.
  let current = 0;
  const timedOut = new Set<number>();
  const arm = (id: number, at: number) => {
    rt.at(at, () => {
      if (current !== id || returned !== undefined) return;
      timedOut.add(id);
    });
  };
  rt.spawn("waiter", function* (t) {
    yield* t.lock(m);
    const deadline = t.now() + s.timeoutNs;
    let id = 0;
    if (s.design === "deadline") arm((current = ++id), deadline);
    while (!ready) {
      // wait_for(timeout) in a loop: every pass starts a new timeout.
      if (s.design === "relative") arm((current = ++id), t.now() + s.timeoutNs);
      yield* t.wait(cv, m);
      wakeups++;
      if (timedOut.has(current)) {
        outcome = ready ? "ready" : "timeout";
        break;
      }
      if (s.design === "deadline" && t.now() >= deadline) {
        outcome = ready ? "ready" : "timeout";
        break;
      }
    }
    if (ready) outcome = "ready";
    returned = t.now();
    t.unlock(m);
  });
  rt.spawn("notifier", function* (t) {
    for (;;) {
      yield* t.sleep(s.noiseNs);
      if (returned !== undefined) return;
      yield* t.lock(m);
      if (t.now() >= s.readyNs) ready = true;
      t.broadcast(cv);
      t.unlock(m);
    }
  });
  // The timer: at each armed time, the kernel wakes the waiter. Modeled as a thread that checks every timer.
  rt.spawn("timer", function* (t) {
    for (;;) {
      yield* t.sleep(100_000);
      if (returned !== undefined) return;
      if (timedOut.has(current)) {
        yield* t.lock(m);
        t.broadcast(cv);
        t.unlock(m);
        yield* t.sleep(s.limitNs);
      }
    }
  });
  const result = rt.run({ untilNs: s.limitNs });
  return { result, returnedNs: returned, outcome, wakeups };
}
