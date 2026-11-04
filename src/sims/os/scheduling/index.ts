/**
 * Discrete-event schedulers behind one Job and Trace API.
 *
 * A Job (types.ts) says what the workload wants: arrival, CPU burst, optional I/O pattern.
 * A Trace says what the scheduler did: slices on CPUs and events. `summarize` and `traceProblems`
 * read any Trace.
 *
 * - classic.ts: simulateClassic for FIFO, SJF, STCF, round-robin.
 * - mlfq.ts: simulateMlfq with the OSTEP rules, boost and both accounting forms.
 * - fair.ts: FairSim for CFS (real weights, vruntime, red-black tree) and EEVDF (lag, eligibility,
 *   virtual deadlines, slice requests).
 * - realtime.ts: simulateRt for RM and EDF, responseTimes and edfSchedulable as exact checks,
 *   simulateInversion for priority inversion.
 * - multicore.ts: Multicore for per-CPU or single queues, a load balancer and migration costs.
 * - rbtree.ts: a red-black tree with a cached leftmost node.
 *
 * `schedule(jobs, spec)` is one entry point for every job-based policy (FIFO to EEVDF).
 * Periodic tasks and the closed multicore workload have their own inputs, and both can give a Trace.
 */
import { simulateClassic, type ClassicOptions } from "./classic";
import { simulateFair, type FairOptions, type FairPolicy } from "./fair";
import { simulateMlfq, type MlfqConfig } from "./mlfq";
import type { Job, Trace } from "./types";

export * from "./types";
export * from "./classic";
export * from "./mlfq";
export * from "./rbtree";
export * from "./fair";
export * from "./realtime";
export * from "./multicore";

export type PolicySpec = ClassicOptions | ({ policy: "mlfq" } & MlfqConfig) | ({ policy: FairPolicy } & Partial<FairOptions>);

/** One entry point: any job-based policy, the same Job input and the same Trace output. */
export function schedule(jobs: readonly Job[], spec: PolicySpec): Trace {
  switch (spec.policy) {
    case "mlfq": return simulateMlfq(jobs, spec);
    case "cfs":
    case "eevdf": return simulateFair(jobs, spec.policy, spec);
    default: return simulateClassic(jobs, spec);
  }
}
