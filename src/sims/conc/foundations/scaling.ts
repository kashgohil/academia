/**
 * Lesson "Amdahl's and Gustafson's laws".
 *
 * - The formulas: Amdahl (1967), Gustafson (1988), the Karp-Flatt metric (1990) and Gunther's Universal Scalability
 *   Law (1993), with a least-squares fit of the USL to measured points.
 * - Speedup measured on the shared Runtime, not computed from a formula: a program with a serial phase (fork-join),
 *   a program whose serial part is a lock-protected update, and a throughput benchmark whose critical section grows
 *   with the number of threads (the coherency term of the USL).
 */
import { DEFAULT_COSTS, Runtime, type RunResult, type Thread } from "../runtime";

// ---------------------------------------------------------------- formulas

/** Amdahl: speedup on p cores when a fraction s of the one-core time is serial. */
export const amdahl = (s: number, p: number) => 1 / (s + (1 - s) / p);

/** Gustafson: scaled speedup when a fraction s of the time on the p-core machine is serial. */
export const gustafson = (s: number, p: number) => p - s * (p - 1);

/** Karp-Flatt: the serial fraction that explains a measured speedup on p cores. */
export const karpFlatt = (speedup: number, p: number) => (p <= 1 ? NaN : (1 / speedup - 1 / p) / (1 - 1 / p));

/** The Universal Scalability Law: relative capacity at N with contention σ and coherency κ. */
export const usl = (sigma: number, kappa: number, n: number) => n / (1 + sigma * (n - 1) + kappa * n * (n - 1));

/** The N where the USL peaks. Infinite when κ = 0. */
export const uslPeak = (sigma: number, kappa: number) => (kappa <= 0 ? Infinity : Math.sqrt((1 - sigma) / kappa));

/**
 * Fit of σ and κ to measured points (N, C(N)) with C(1) = 1. It minimizes the squared error of log C, so a point at
 * N = 64 does not outweigh the points near the peak. A coarse grid, then a finer search around the best cell.
 */
export function fitUsl(points: readonly [number, number][]): { sigma: number; kappa: number } {
  const pts = points.filter(([n, c]) => n > 1 && c > 0);
  if (!pts.length) return { sigma: 0, kappa: 0 };
  const err = (sg: number, kp: number) => pts.reduce((a, [n, c]) => a + (Math.log(usl(sg, kp, n)) - Math.log(c)) ** 2, 0);
  let best = { sigma: 0, kappa: 0, e: err(0, 0) };
  const consider = (sigma: number, kappa: number) => {
    if (sigma < 0 || sigma > 1 || kappa < 0) return;
    const e = err(sigma, kappa);
    if (e < best.e) best = { sigma, kappa, e };
  };
  for (let i = 0; i <= 100; i++) for (let j = -1; j <= 60; j++) consider(i * 0.005, j < 0 ? 0 : 1e-6 * Math.pow(10, j / 12));
  let ds = 0.005, dk = Math.max(best.kappa, 1e-6) * 0.5;
  for (let it = 0; it < 60; it++) {
    const { sigma, kappa } = best;
    for (const [a, b] of [[ds, 0], [-ds, 0], [0, dk], [0, -dk]] as const) consider(sigma + a, kappa + b);
    if (best.sigma === sigma && best.kappa === kappa) { ds /= 2; dk /= 2; }
  }
  return { sigma: best.sigma, kappa: best.kappa };
}

// ---------------------------------------------------------------- speedup from the Runtime

export type SerialKind = "phase" | "lock";

export interface ScaleParams {
  cores: number;
  /** Serial fraction of the one-core time. */
  serial: number;
  /** "phase": the main thread runs the serial part alone, then forks workers. "lock": every thread does its share
   *  of the serial part inside one mutex, between parallel chunks. */
  kind: SerialKind;
  /** Problem size: "strong" keeps the total work fixed; "weak" grows the parallel work with the core count. */
  scaling: "strong" | "weak";
  /** Use the Runtime's cost model (switch, wake, lock); off: every cost is 0. */
  costs: boolean;
  record?: boolean;
}

/** Work units (iterations). 192 divides evenly by 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48 and 64. */
export const ITERS = 192;
/** One iteration on one core, in ns. The whole one-core job is ITERS × UNIT_NS = 3.84 ms. */
export const UNIT_NS = 20_000;
/** Rounds of the phase program: serial part, then a parallel part, this many times. */
export const ROUNDS = 4;
export const SCALE_CORES = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64];

const ZERO = { switchNs: 0, wakeNs: 0, lockNs: 0, transferNs: 0 };

/**
 * Runs the program on the Runtime and returns its makespan. For "weak", the parallel work is multiplied by the core
 * count, and the serial work stays the same.
 */
export function runScale(p: ScaleParams): RunResult {
  const rt = new Runtime({ cores: p.cores, record: p.record ?? false, ...(p.costs ? DEFAULT_COSTS : ZERO) });
  const grow = p.scaling === "weak" ? p.cores : 1;
  const serialNs = p.serial * ITERS * UNIT_NS;
  const parallelNs = (1 - p.serial) * ITERS * UNIT_NS * grow;
  if (p.kind === "phase") {
    rt.spawn("main", function* (t) {
      for (let r = 0; r < ROUNDS; r++) {
        yield* t.work(serialNs / ROUNDS, "serial");
        const share = parallelNs / ROUNDS / p.cores;
        const ids = [];
        for (let i = 1; i < p.cores; i++) ids.push(t.spawn(`w${r}.${i}`, function* (w: Thread) { yield* w.work(share, "parallel"); }));
        yield* t.work(share, "parallel");
        for (const id of ids) yield* t.join(id);
      }
    });
  } else {
    const m = rt.mutex("m");
    const iters = ITERS / p.cores;
    const par = parallelNs / p.cores / iters, ser = serialNs / ITERS;
    for (let i = 0; i < p.cores; i++) {
      rt.spawn(`T${i}`, function* (t) {
        for (let k = 0; k < iters; k++) {
          yield* t.work(par, "parallel");
          yield* t.lock(m);
          yield* t.work(ser, "serial");
          t.unlock(m);
        }
      });
    }
  }
  return rt.run();
}

/**
 * Speedup from the simulation. Strong scaling: one-core time of the same job / makespan. Weak scaling: the time one
 * core would need for the grown job / makespan (Gustafson's scaled speedup).
 */
export function measuredSpeedup(p: ScaleParams): number {
  const r = runScale(p);
  const grow = p.scaling === "weak" ? p.cores : 1;
  const oneCore = ITERS * UNIT_NS * (p.serial + (1 - p.serial) * grow);
  return oneCore / r.makespan;
}

// ---------------------------------------------------------------- a throughput benchmark for the USL

export interface UslParams {
  threads: number;
  /** Work outside the lock per operation, in ns. */
  parallelNs: number;
  /** Work inside the lock per operation, in ns: the contention (σ) source. */
  lockedNs: number;
  /** Extra time inside the lock for each other thread, in ns: invalidating the copies of the other cores (κ). */
  perPeerNs: number;
  durationNs: number;
}

export const USL_DEFAULTS: Omit<UslParams, "threads"> = { parallelNs: 2_000, lockedNs: 60, perPeerNs: 4, durationNs: 600_000 };
export const USL_THREADS = [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64];

/**
 * N threads on N cores loop: parallel work of random length, then a spin lock around an update whose length grows with the number of
 * other threads. Returns operations per µs.
 */
export function runUsl(p: UslParams): number {
  const rt = new Runtime({ cores: p.threads, record: false });
  const m = rt.mutex("m", { wait: "spin" });
  let ops = 0;
  const cs = p.lockedNs + p.perPeerNs * (p.threads - 1);
  for (let i = 0; i < p.threads; i++) {
    rt.spawn(`T${i}`, function* (t) {
      // The parallel work varies (exponential, mean parallelNs), as requests do in a real service.
      for (;;) {
        yield* t.work(-Math.log(1 - t.rand()) * p.parallelNs);
        yield* t.lock(m);
        yield* t.work(cs);
        t.unlock(m);
        ops++;
      }
    });
  }
  rt.run({ untilNs: p.durationNs });
  return ops / (p.durationNs / 1000);
}
