/**
 * Lesson "concurrency vs parallelism": the same tasks run one after another, as threads on one core, and as threads
 * on P cores. Each task alternates compute (it holds a core) and I/O waits (it sleeps and leaves the core). All timing
 * comes from the shared Runtime, so the context-switch cost is its model input `switchNs` (DEFAULT_COSTS).
 */
import { DEFAULT_COSTS, Runtime, type RunResult, type Thread } from "../runtime";

export interface MixParams {
  /** Number of independent tasks (requests, files, clients). */
  tasks: number;
  /** Compute then wait, this many times per task. */
  rounds: number;
  /** Compute per round in ns: the task holds a core. */
  computeNs: number;
  /** I/O wait per round in ns: the task sleeps and leaves its core. */
  ioNs: number;
  cores: number;
  /** "sequential": one thread runs the tasks one after another. "threads": one thread per task. */
  mode: "sequential" | "threads";
  record?: boolean;
  /** Model input: core time of one context switch. */
  switchNs?: number;
}

export const MIX_DEFAULTS: MixParams = { tasks: 4, rounds: 5, computeNs: 200_000, ioNs: 800_000, cores: 1, mode: "threads" };

/** Runs the task mix on the Runtime. */
export function runMix(p: MixParams): RunResult {
  const rt = new Runtime({ cores: p.cores, record: p.record ?? true, switchNs: p.switchNs ?? DEFAULT_COSTS.switchNs });
  const task = function* (t: Thread, k: number) {
    for (let r = 0; r < p.rounds; r++) {
      yield* t.work(p.computeNs, `task ${k}`);
      yield* t.sleep(p.ioNs);
    }
  };
  if (p.mode === "sequential") {
    rt.spawn("main", function* (t) {
      for (let k = 0; k < p.tasks; k++) yield* task(t, k);
    });
  } else {
    for (let k = 0; k < p.tasks; k++) rt.spawn(`task ${k}`, function* (t) { yield* task(t, k); });
  }
  return rt.run();
}

export interface MixSummary {
  makespan: number;
  /** Time of the sequential version of the same tasks. */
  sequential: number;
  speedup: number;
  /** Fraction of core time spent on task compute. */
  utilization: number;
  /** Core time spent on context switches. */
  switchNs: number;
  /** The best possible makespan: the larger of (all compute / cores) and (one task's length). */
  bound: number;
}

export function summarizeMix(p: MixParams, r: RunResult): MixSummary {
  const sequential = p.tasks * p.rounds * (p.computeNs + p.ioNs);
  const busy = r.cores.reduce((a, c) => a + c.busyNs, 0);
  const switchNs = r.cores.reduce((a, c) => a + c.switchNs, 0);
  const bound = p.mode === "sequential"
    ? sequential
    : Math.max((p.tasks * p.rounds * p.computeNs) / Math.min(p.cores, p.tasks), p.rounds * (p.computeNs + p.ioNs));
  return { makespan: r.makespan, sequential, speedup: sequential / r.makespan, utilization: busy / (p.cores * r.makespan), switchNs, bound };
}

// ---------------------------------------------------------------- thread-pool sizing

export interface PoolParams {
  /** Jobs in the queue. */
  jobs: number;
  /** Compute per job (ns): C. */
  computeNs: number;
  /** Wait per job (ns): W, for example a database call. */
  waitNs: number;
  cores: number;
  /** Worker threads in the pool. */
  threads: number;
  switchNs?: number;
}

/**
 * A pool of `threads` workers takes jobs from a shared queue. Each job computes, then waits. Returns the makespan and
 * the speedup over one worker that runs every job by itself (jobs × (C + W)).
 */
export function runPool(p: PoolParams): { makespan: number; speedup: number; utilization: number } {
  const rt = new Runtime({ cores: p.cores, record: false, switchNs: p.switchNs ?? DEFAULT_COSTS.switchNs });
  let next = 0;
  for (let i = 0; i < p.threads; i++) {
    rt.spawn(`w${i}`, function* (t) {
      while (next < p.jobs) {
        next++;
        yield* t.work(p.computeNs);
        if (p.waitNs > 0) yield* t.sleep(p.waitNs);
      }
    });
  }
  const r = rt.run();
  const busy = r.cores.reduce((a, c) => a + c.busyNs, 0);
  return { makespan: r.makespan, speedup: (p.jobs * (p.computeNs + p.waitNs)) / r.makespan, utilization: busy / (p.cores * r.makespan) };
}

/**
 * The pool size where the cores become the limit: P × (1 + W/C). Below it, adding threads adds throughput.
 * Above it, extra threads only wait for a core. Little's law gives the same number: the cores finish P / C jobs per
 * unit of time, and each job holds a thread for C + W.
 */
export const poolKnee = (cores: number, computeNs: number, waitNs: number) => cores * (1 + waitNs / computeNs);

/** The thread counts that the pool sweep plots. */
export const POOL_THREADS = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];
