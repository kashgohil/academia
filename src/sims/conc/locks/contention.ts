/**
 * Models for the "lock contention" lesson, on the shared Runtime.
 *
 * - contendedLoop: T threads on P cores loop "lock, critical section, unlock, work outside" on one mutex, with a
 *   waiting policy (block, spin, adaptive) and a preemption quantum. It measures throughput, the wait and hold
 *   times, and where the core time went.
 * - lockBound: the throughput limit of one lock, 1 / (hold time per acquisition), with the hold time that a handoff
 *   adds (the wake-up of the next owner).
 * - stripedLoop: a map protected by k stripe locks. Each operation picks a key from a Zipf-like distribution and
 *   locks stripe (key mod k). Striping helps when keys spread, and it cannot help one hot key.
 */
import { Runtime, DEFAULT_COSTS, type RunResult } from "../index";

export type WaitPolicy = "block" | "spin" | "adaptive";

export interface LoopSpec {
  threads: number;
  cores: number;
  csNs: number;
  outsideNs: number;
  wait: WaitPolicy;
  handoff: boolean;
  /** MODEL INPUT: the scheduler's time slice. A spinner or a long work gives up its core at the end of one. */
  quantumNs: number;
  durationNs: number;
  seed: number;
  record: boolean;
}

export const LOOP_DEFAULTS: LoopSpec = {
  threads: 8, cores: 8, csNs: 1_000, outsideNs: 9_000, wait: "block", handoff: false, quantumNs: 100_000, durationNs: 2_000_000, seed: 1, record: false,
};

export interface LoopStats {
  result: RunResult;
  /** Lock acquisitions per ms. */
  perMs: number;
  /** Mean time from the lock call to ownership. */
  meanWaitNs: number;
  meanHoldNs: number;
  /** Share of all core time: useful work, spinning, context switches, idle. */
  shares: { work: number; spin: number; switch: number; idle: number };
  contendedFrac: number;
}

export function contendedLoop(spec: Partial<LoopSpec> = {}): LoopStats {
  const s = { ...LOOP_DEFAULTS, ...spec };
  const rt = new Runtime({ cores: s.cores, seed: s.seed, record: s.record, quantumNs: s.quantumNs });
  const m = rt.mutex("m", { wait: s.wait, handoff: s.handoff });
  for (let i = 0; i < s.threads; i++) {
    rt.spawn(`T${i}`, function* (t) {
      yield* t.work(t.rand() * s.outsideNs, "out");
      for (;;) {
        yield* t.lock(m);
        yield* t.work(s.csNs, "cs");
        t.unlock(m);
        yield* t.work(s.outsideNs * (0.5 + t.rand()), "out");
      }
    });
  }
  const result = rt.run({ untilNs: s.durationNs });
  const ms = result.mutexes[0]!;
  const total = s.cores * s.durationNs;
  const busy = result.cores.reduce((a, c) => a + c.busyNs, 0);
  const spin = result.cores.reduce((a, c) => a + c.spinNs, 0);
  const sw = result.cores.reduce((a, c) => a + c.switchNs, 0);
  return {
    result,
    perMs: ms.acquisitions / (s.durationNs / 1e6),
    meanWaitNs: ms.acquisitions ? ms.waitNs / ms.acquisitions : 0,
    meanHoldNs: ms.acquisitions ? ms.holdNs / ms.acquisitions : 0,
    shares: { work: busy / total, spin: spin / total, switch: sw / total, idle: Math.max(0, 1 - (busy + spin + sw) / total) },
    contendedFrac: ms.acquisitions ? ms.contended / ms.acquisitions : 0,
  };
}

/** The ideal throughput with no lock (per ms): every thread that has a core does one pass per (cs + outside). */
export function idealPerMs(threads: number, cores: number, csNs: number, outsideNs: number) {
  return (Math.min(threads, cores) * 1e6) / (csNs + outsideNs);
}

/**
 * The limit of one lock (acquisitions per ms): one critical section at a time. A barging lock that is always busy
 * passes from hand to hand with an acquire cost; a handoff lock also waits for the next owner to wake up.
 */
export function lockBound(csNs: number, handoff: boolean, costs = DEFAULT_COSTS) {
  const per = csNs + costs.lockNs + costs.transferNs + (handoff ? costs.wakeNs : 0);
  return 1e6 / per;
}

/** The thread count where demand meets the lock limit: N × 1 / (cs + outside) = lockBound. */
export function saturationThreads(csNs: number, outsideNs: number) {
  return (lockBound(csNs, false) * (csNs + outsideNs)) / 1e6;
}

export const SWEEP_THREADS = [1, 2, 4, 6, 8, 12, 16, 24, 32];

// ---------------------------------------------------------------- striping

export interface StripeSpec {
  threads: number;
  cores: number;
  stripes: number;
  /** Zipf exponent of the key popularity: 0 is uniform; near 1 a few keys get most operations. */
  skew: number;
  keys: number;
  csNs: number;
  outsideNs: number;
  durationNs: number;
  seed: number;
}

export const STRIPE_DEFAULTS: StripeSpec = { threads: 8, cores: 8, stripes: 1, skew: 0, keys: 1024, csNs: 1_000, outsideNs: 3_000, durationNs: 1_000_000, seed: 1 };

/** Cumulative Zipf weights for keys 0..n−1 with exponent s. */
export function zipfCdf(n: number, s: number): number[] {
  const w = Array.from({ length: n }, (_, i) => 1 / (i + 1) ** s);
  const sum = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  return w.map((x) => (acc += x / sum));
}

export function pickKey(cdf: number[], u: number): number {
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid]! >= u) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export interface StripeStats {
  perMs: number;
  /** Operations per stripe, and wait and hold time per stripe (ns), as a mutex profile would show them. */
  stripes: { ops: number; waitNs: number; holdNs: number; contended: number }[];
  meanWaitNs: number;
  /** Share of operations that hit the busiest stripe. */
  hottest: number;
}

export function stripedLoop(spec: Partial<StripeSpec> = {}): StripeStats {
  const s = { ...STRIPE_DEFAULTS, ...spec };
  const rt = new Runtime({ cores: s.cores, seed: s.seed, record: false });
  const locks = Array.from({ length: s.stripes }, (_, i) => rt.mutex(`stripe${i}`));
  const cdf = zipfCdf(s.keys, s.skew);
  for (let i = 0; i < s.threads; i++) {
    rt.spawn(`T${i}`, function* (t) {
      yield* t.work(t.rand() * s.outsideNs, "out");
      for (;;) {
        const key = pickKey(cdf, t.rand());
        const m = locks[key % s.stripes]!;
        yield* t.lock(m);
        yield* t.work(s.csNs, "cs");
        t.unlock(m);
        yield* t.work(s.outsideNs * (0.5 + t.rand()), "out");
      }
    });
  }
  const r = rt.run({ untilNs: s.durationNs });
  const stripes = r.mutexes.map((m) => ({ ops: m.acquisitions, waitNs: m.waitNs, holdNs: m.holdNs, contended: m.contended }));
  const ops = stripes.reduce((a, x) => a + x.ops, 0);
  return {
    perMs: ops / (s.durationNs / 1e6),
    stripes,
    meanWaitNs: ops ? stripes.reduce((a, x) => a + x.waitNs, 0) / ops : 0,
    hottest: ops ? Math.max(...stripes.map((x) => x.ops)) / ops : 0,
  };
}
