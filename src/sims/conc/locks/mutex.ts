/**
 * Mutex models for the "mutexes" lesson, on the shared Runtime.
 *
 * - lockLoop: N threads loop "lock, critical section, unlock, work outside". The Runtime mutex either hands the lock
 *   to the oldest waiter at unlock (handoff, FIFO) or frees it and lets threads compete (barging).
 * - GoMutex: a reference model of Go's sync.Mutex (src/internal/sync/mutex.go in Go 1.24, src/sync/mutex.go before):
 *   one state word with the bits locked, woken and starving and a waiter count, spinning, a wait queue where a woken
 *   waiter that loses goes to the front, and starvation mode after a waiter has waited more than 1 ms.
 *   The atomic operations are plain code here: thread code between two `yield*` runs atomically in the Runtime, so a
 *   compare-and-swap is a compare and an assignment.
 */
import { Runtime, type RunResult, type Semaphore, type Thread, type Gen } from "../index";

// ---------------------------------------------------------------- handoff against barging

export interface LoopSpec {
  threads: number;
  cores: number;
  /** Critical section length (ns). */
  csNs: number;
  /** Mean work outside the lock (ns). Each pass draws it uniformly from 0.5x to 1.5x. */
  outsideNs: number;
  handoff: boolean;
  wait: "block" | "spin" | "adaptive";
  durationNs: number;
  seed: number;
  record: boolean;
}

export const LOOP_DEFAULTS: LoopSpec = {
  threads: 4, cores: 4, csNs: 1_000, outsideNs: 2_000, handoff: false, wait: "block", durationNs: 1_000_000, seed: 1, record: true,
};

export interface LoopResult {
  result: RunResult;
  /** Acquisitions per thread. */
  perThread: number[];
  /** Acquisitions per ms of simulated time. */
  perMs: number;
  meanWaitNs: number;
  maxWaitNs: number;
  /** Fewest acquisitions of one thread divided by the most. 1 is perfectly even. */
  evenness: number;
  /** Fraction of the time that the lock was held. With handoff this includes the wake-up of the new owner. */
  heldFrac: number;
}

export function lockLoop(spec: Partial<LoopSpec> = {}): LoopResult {
  const s = { ...LOOP_DEFAULTS, ...spec };
  const rt = new Runtime({ cores: s.cores, seed: s.seed, record: s.record });
  const m = rt.mutex("m", { handoff: s.handoff, wait: s.wait });
  const perThread = new Array<number>(s.threads).fill(0);
  for (let i = 0; i < s.threads; i++) {
    rt.spawn(`T${i}`, function* (t) {
      // A random start, so that the threads do not move in step.
      yield* t.work(t.rand() * s.outsideNs, "out");
      for (;;) {
        yield* t.lock(m);
        perThread[i]!++;
        yield* t.work(s.csNs, "cs");
        t.unlock(m);
        yield* t.work(s.outsideNs * (0.5 + t.rand()), "out");
      }
    });
  }
  const result = rt.run({ untilNs: s.durationNs });
  const ms = result.mutexes[0]!;
  const lo = Math.min(...perThread), hi = Math.max(...perThread);
  return {
    result,
    perThread,
    perMs: ms.acquisitions / (s.durationNs / 1e6),
    meanWaitNs: ms.contended ? ms.waitNs / ms.acquisitions : 0,
    maxWaitNs: ms.maxWaitNs,
    evenness: hi > 0 ? lo / hi : 1,
    heldFrac: ms.holdNs / s.durationNs,
  };
}

// ---------------------------------------------------------------- Go's sync.Mutex

export const LOCKED = 1;
export const WOKEN = 2;
export const STARVING = 4;
export const WAITER_SHIFT = 3;
/** Go's starvationThresholdNs: a fact about the Go source, not a model input. */
export const STARVATION_NS = 1_000_000;
/** Go's active_spin: at most 4 spin rounds before a goroutine queues. */
export const ACTIVE_SPIN = 4;
/** MODEL INPUT: the time of one spin round, procyield(30), which is 30 PAUSE instructions. */
export const SPIN_ROUND_NS = 500;

export const waiters = (state: number) => state >> WAITER_SHIFT;

export function describeState(state: number): string {
  const bits = [state & LOCKED ? "locked" : "unlocked"];
  if (state & WOKEN) bits.push("woken");
  if (state & STARVING) bits.push("starving");
  return `${bits.join(", ")}; ${waiters(state)} waiter${waiters(state) === 1 ? "" : "s"}`;
}

interface QEntry { tid: number; sem: Semaphore }

/** Go's sync.Mutex as code on the Runtime. Create it before the threads start; give each thread its own `park` semaphore. */
export class GoMutex {
  state = 0;
  /** The runtime semaphore count (Go's m.sema) and its wait queue, front first. */
  sema = 0;
  readonly queue: QEntry[] = [];
  /** [time, state] at each change. */
  readonly log: [number, number][] = [[0, 0]];
  /** [time, tid, queue tids] at each change of the queue. */
  readonly qlog: [number, number[]][] = [[0, []]];
  /** Time spent in starvation mode. */
  starvingNs = 0;
  private starvingSince = -1;
  waits: number[] = [];
  /** Threads inside lock() now, with the time they called it. */
  readonly inLock = new Map<number, number>();
  owner = -1;
  ownerLog: [number, number][] = [[0, -1]];

  constructor(private readonly rt: Runtime, readonly opts: { starvation: boolean; cores: number; spinRoundNs: number; record: boolean }) {}

  private set(v: number) {
    const now = this.rt.now;
    if ((v & STARVING) && !(this.state & STARVING)) this.starvingSince = now;
    if (!(v & STARVING) && (this.state & STARVING)) {
      this.starvingNs += now - this.starvingSince;
      this.starvingSince = -1;
    }
    this.state = v;
    if (this.opts.record) this.log.push([now, v]);
  }

  private setOwner(tid: number) {
    this.owner = tid;
    if (this.opts.record) this.ownerLog.push([this.rt.now, tid]);
  }

  /** Time in starvation mode up to now. */
  starvingUntil(now: number) {
    return this.starvingNs + (this.starvingSince >= 0 ? now - this.starvingSince : 0);
  }

  private logQueue() {
    if (this.opts.record) this.qlog.push([this.rt.now, this.queue.map((q) => q.tid)]);
  }

  /** runtime_SemacquireMutex: take a count, or park. `lifo` puts the waiter at the front of the queue. */
  private *semacquire(t: Thread, park: Semaphore, lifo: boolean): Gen<void> {
    if (this.sema > 0) {
      this.sema--;
      return;
    }
    const e = { tid: t.id, sem: park };
    if (lifo) this.queue.unshift(e);
    else this.queue.push(e);
    this.logQueue();
    yield* t.acquire(park);
  }

  /** runtime_Semrelease: add a count and wake the waiter at the front, which gets the count. */
  private semrelease(t: Thread) {
    this.sema++;
    const w = this.queue.shift();
    if (!w) return;
    this.logQueue();
    this.sema--;
    t.release(w.sem);
  }

  private canSpin(iter: number) {
    return iter < ACTIVE_SPIN && this.opts.cores > 1;
  }

  *lock(t: Thread, park: Semaphore): Gen<void> {
    const from = t.now();
    // Fast path: CAS(0, locked).
    if (this.state === 0) {
      this.set(LOCKED);
      this.setOwner(t.id);
      this.waits.push(0);
      return;
    }
    this.inLock.set(t.id, from);
    let waitStart = -1, starving = false, awoke = false, iter = 0, old = this.state;
    for (;;) {
      // Spin only in normal mode while the lock is held: in starvation mode the lock goes to the queue.
      if ((old & (LOCKED | STARVING)) === LOCKED && this.canSpin(iter)) {
        // Set the woken bit, so that Unlock does not wake another waiter while this one spins.
        if (!awoke && !(old & WOKEN) && waiters(old) !== 0 && this.state === old) {
          this.set(old | WOKEN);
          awoke = true;
        }
        yield* t.work(this.opts.spinRoundNs, "spin");
        iter++;
        old = this.state;
        continue;
      }
      let nw = old;
      if (!(old & STARVING)) nw |= LOCKED; // do not take a starving mutex: new arrivals queue
      if (old & (LOCKED | STARVING)) nw += 1 << WAITER_SHIFT;
      if (starving && (old & LOCKED)) nw |= STARVING;
      if (awoke) nw &= ~WOKEN;
      if (this.state === old) {
        this.set(nw);
        if (!(old & (LOCKED | STARVING))) break; // took the lock with the CAS
        const lifo = waitStart >= 0;
        if (waitStart < 0) waitStart = t.now();
        yield* this.semacquire(t, park, lifo);
        starving = this.opts.starvation && (starving || t.now() - waitStart > STARVATION_NS);
        old = this.state;
        if (old & STARVING) {
          // Handoff: the unlocker left the lock to us. Take it, and leave starvation mode if we are the last waiter
          // or we did not wait long.
          let delta = LOCKED - (1 << WAITER_SHIFT);
          if (!starving || waiters(old) === 1) delta -= STARVING;
          this.set(old + delta);
          break;
        }
        awoke = true;
        iter = 0;
      } else old = this.state;
    }
    this.setOwner(t.id);
    this.inLock.delete(t.id);
    this.waits.push(t.now() - from);
  }

  /** The longest wait so far, with the waits that have not ended yet. */
  maxWait(now: number) {
    let m = 0;
    for (const w of this.waits) m = Math.max(m, w);
    for (const from of this.inLock.values()) m = Math.max(m, now - from);
    return m;
  }

  unlock(t: Thread) {
    this.setOwner(-1);
    const nw = this.state - LOCKED;
    this.set(nw);
    if (nw === 0) return;
    if (!(nw & STARVING)) {
      let old = nw;
      for (;;) {
        // No waiters, or someone already took or will take the lock: nothing to wake.
        if (waiters(old) === 0 || (old & (LOCKED | WOKEN | STARVING))) return;
        const n2 = (old - (1 << WAITER_SHIFT)) | WOKEN;
        if (this.state === old) {
          this.set(n2);
          this.semrelease(t);
          return;
        }
        old = this.state;
      }
    } else this.semrelease(t); // starvation mode: hand the lock to the first waiter
  }
}

export interface GoSpec {
  threads: number;
  cores: number;
  csNs: number;
  outsideNs: number;
  /** false: Go 1.8 and earlier, with no starvation mode. */
  starvation: boolean;
  durationNs: number;
  seed: number;
  record: boolean;
}

export const GO_DEFAULTS: GoSpec = { threads: 6, cores: 4, csNs: 2_000, outsideNs: 500, starvation: true, durationNs: 8_000_000, seed: 3, record: true };

export interface GoResult {
  result: RunResult;
  mutex: GoMutex;
  perThread: number[];
  perMs: number;
  maxWaitNs: number;
  /** Acquisitions that waited more than 1 ms. */
  longWaits: number;
  /** Fraction of the run in starvation mode. */
  starvingFrac: number;
  evenness: number;
}

export function goMutexLoop(spec: Partial<GoSpec> = {}): GoResult {
  const s = { ...GO_DEFAULTS, ...spec };
  const rt = new Runtime({ cores: s.cores, seed: s.seed, record: s.record });
  // The mutex keeps its own logs (state, owner, queue) even when the Runtime does not record.
  const mu = new GoMutex(rt, { starvation: s.starvation, cores: s.cores, spinRoundNs: SPIN_ROUND_NS, record: true });
  const perThread = new Array<number>(s.threads).fill(0);
  for (let i = 0; i < s.threads; i++) {
    const park = rt.semaphore(`park${i}`, 0);
    rt.spawn(`G${i}`, function* (t) {
      yield* t.work(t.rand() * s.outsideNs, "out");
      for (;;) {
        yield* mu.lock(t, park);
        perThread[i]!++;
        yield* t.work(s.csNs, "cs");
        mu.unlock(t);
        yield* t.work(s.outsideNs * (0.5 + t.rand()), "out");
      }
    });
  }
  const result = rt.run({ untilNs: s.durationNs });
  const total = perThread.reduce((a, b) => a + b, 0);
  const lo = Math.min(...perThread), hi = Math.max(...perThread);
  return {
    result,
    mutex: mu,
    perThread,
    perMs: total / (s.durationNs / 1e6),
    maxWaitNs: mu.maxWait(result.now),
    longWaits: mu.waits.filter((w) => w > STARVATION_NS).length,
    starvingFrac: mu.starvingUntil(result.now) / s.durationNs,
    evenness: hi > 0 ? lo / hi : 1,
  };
}

/** The state word at time t, from a GoMutex log. */
export function stateAt(log: readonly [number, number][], t: number): number {
  let v = 0;
  for (const [at, s] of log) {
    if (at > t) break;
    v = s;
  }
  return v;
}
