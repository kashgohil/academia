/**
 * Models for the "deadlock, livelock and starvation" lesson.
 *
 * - transfers: two threads move money between accounts A and B in opposite directions, so each needs both locks.
 *   Strategies: a global lock order; try-lock with a fixed back-off (the threads stay in step: livelock); try-lock with
 *   a random back-off; and the std::lock style, which blocks on the lock that was busy and then tries the other one.
 *   It runs on the shared Runtime.
 * - abba: the plain deadlock (lock A then B, against lock B then A) on the Runtime, with an optional background
 *   thread. The Runtime reports a deadlock only when no thread can ever run again, as Go's runtime does.
 */
import { Runtime, type RunResult, type Mutex, type Thread, type Gen } from "../index";

// ---------------------------------------------------------------- livelock

export type Strategy = "order" | "backoff" | "stdlock";

export interface TransferSpec {
  strategy: Strategy;
  /** Back-off jitter, 0 to 1: the back-off is drawn from (1 − jitter) to (1 + jitter) times backoffNs. */
  jitter: number;
  /** Transfers each thread must do. */
  transfers: number;
  /** Work between the first and the second lock (read the first balance), ns. */
  gapNs: number;
  /** Work while both locks are held, ns. */
  csNs: number;
  backoffNs: number;
  /** Work to undo a failed attempt before the release, ns. */
  undoNs: number;
  /** Work between transfers, ns. */
  thinkNs: number;
  limitNs: number;
  seed: number;
  record: boolean;
}

export const TRANSFER_DEFAULTS: TransferSpec = {
  strategy: "backoff", jitter: 0, transfers: 10, gapNs: 1_000, csNs: 1_000, backoffNs: 2_000, undoNs: 200, thinkNs: 1_000, limitNs: 200_000, seed: 1, record: true,
};

export interface TransferResult {
  result: RunResult;
  /** Transfers done, per thread. */
  done: number[];
  /** Failed try-locks. */
  failures: number;
  /** Time when both threads finished, or undefined. */
  finishNs?: number;
}

export function transfers(spec: Partial<TransferSpec> = {}): TransferResult {
  const s = { ...TRANSFER_DEFAULTS, ...spec };
  const rt = new Runtime({ cores: 2, seed: s.seed, record: s.record });
  const A = rt.mutex("A"), B = rt.mutex("B");
  const done = [0, 0];
  let failures = 0;
  const backoff = (t: Thread) => s.backoffNs * (1 - s.jitter + 2 * s.jitter * t.rand());

  function* both(t: Thread, first: Mutex, second: Mutex): Gen<void> {
    if (s.strategy === "order") {
      // A global order: A before B, whatever the direction of the transfer.
      const [x, y] = [A, B];
      yield* t.lock(x);
      yield* t.work(s.gapNs, "read");
      yield* t.lock(y);
      return;
    }
    if (s.strategy === "backoff") {
      for (;;) {
        yield* t.lock(first);
        yield* t.work(s.gapNs, "read");
        if (t.tryLock(second)) return;
        failures++;
        // Undo the partial work, then release and wait.
        yield* t.work(s.undoNs, "undo");
        t.unlock(first);
        yield* t.sleep(backoff(t));
      }
    }
    // std::lock style (libc++): lock one, try the other; on failure, release, and next time block on the busy one.
    let [x, y] = [first, second];
    for (;;) {
      yield* t.lock(x);
      yield* t.work(s.gapNs, "read");
      if (t.tryLock(y)) return;
      failures++;
      yield* t.work(s.undoNs, "undo");
      t.unlock(x);
      [x, y] = [y, x];
    }
  }

  const body = (i: number, first: Mutex, second: Mutex) =>
    function* (t: Thread) {
      for (let k = 0; k < s.transfers; k++) {
        yield* both(t, first, second);
        yield* t.work(s.csNs, "move");
        t.unlock(A);
        t.unlock(B);
        done[i]!++;
        yield* t.work(s.thinkNs, "think");
      }
    };
  rt.spawn("A→B", body(0, A, B));
  rt.spawn("B→A", body(1, B, A));
  const result = rt.run({ untilNs: s.limitNs });
  return { result, done, failures, finishNs: result.done ? result.makespan : undefined };
}

// ---------------------------------------------------------------- the plain deadlock and its detection

export interface AbbaSpec {
  /** When the second thread starts (ns). */
  offsetNs: number;
  /** Work between the two lock calls (ns). */
  gapNs: number;
  /** A background thread that wakes up every 50 µs (a ticker, a server loop). */
  background: boolean;
  limitNs: number;
  record: boolean;
}

export const ABBA_DEFAULTS: AbbaSpec = { offsetNs: 1_000, gapNs: 5_000, background: false, limitNs: 300_000, record: true };

export interface AbbaResult {
  result: RunResult;
  /** The runtime reported a deadlock. */
  reported: boolean;
  /** Both workers are blocked at the end, whether or not the runtime noticed. */
  stuck: boolean;
}

export function abba(spec: Partial<AbbaSpec> = {}): AbbaResult {
  const s = { ...ABBA_DEFAULTS, ...spec };
  const rt = new Runtime({ cores: 2, seed: 1, record: s.record });
  const A = rt.mutex("A"), B = rt.mutex("B");
  const worker = (x: Mutex, y: Mutex, delay: number) =>
    function* (t: Thread) {
      if (delay > 0) yield* t.sleep(delay);
      yield* t.lock(x);
      yield* t.work(s.gapNs, "work");
      yield* t.lock(y);
      yield* t.work(2_000, "both");
      t.unlock(y);
      t.unlock(x);
    };
  rt.spawn("T1", worker(A, B, 0));
  rt.spawn("T2", worker(B, A, s.offsetNs));
  if (s.background) {
    rt.spawn("ticker", function* (t) {
      for (;;) {
        yield* t.sleep(50_000);
        yield* t.work(1_000, "tick");
      }
    });
  }
  const result = rt.run({ untilNs: s.limitNs });
  const w = result.threads.slice(0, 2);
  return { result, reported: !!result.deadlock, stuck: w.every((t) => t.state === "blocked") };
}
