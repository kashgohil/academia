/**
 * FIFO, SJF, STCF and round-robin on one CPU, as one discrete-event loop.
 *
 * I/O follows OSTEP: each CPU burst between two I/O waits counts as a separate job for SJF and STCF.
 * The oracle knows the length of the current burst. A real kernel does not, which is the point of MLFQ.
 */
import { EPS, job, pushSlice, summarize, type Job, type Slice, type Summary, type Trace, type TraceEvent } from "./types";

export type ClassicPolicy = "fifo" | "sjf" | "stcf" | "rr";

export const POLICY_NAME: Record<ClassicPolicy, string> = { fifo: "FIFO", sjf: "SJF", stcf: "STCF", rr: "Round-robin" };

export interface ClassicOptions {
  policy: ClassicPolicy;
  /** Time slice for round-robin. Ignored by the other policies. */
  quantum?: number;
  /** CPU time lost when the CPU changes to a different job. */
  switchCost?: number;
}

interface St { j: Job; left: number; burstLeft: number }

const nextBurst = (j: Job, left: number) => (j.io ? Math.min(j.io.every, left) : left);

/** Runs a job set to completion and returns the trace. */
export function simulateClassic(jobs: readonly Job[], opts: ClassicOptions): Trace {
  const q = opts.quantum ?? 10;
  const c = opts.switchCost ?? 0;
  if (opts.policy === "rr" && !(q > 0)) throw new Error("quantum must be positive");
  const slices: Slice[] = [];
  const events: TraceEvent[] = [];
  const pending: { at: number; st: St; first: boolean }[] = [];
  const addPending = (at: number, st: St, first: boolean) => {
    let i = pending.length;
    while (i > 0 && pending[i - 1]!.at > at) i--;
    pending.splice(i, 0, { at, st, first });
  };
  [...jobs].sort((a, b) => a.arrival - b.arrival || a.id - b.id).forEach((j) => addPending(j.arrival, { j, left: j.burst, burstLeft: nextBurst(j, j.burst) }, true));
  const ready: St[] = [];
  let t = 0, last = -1, done = 0;
  const admit = (now: number) => {
    while (pending.length && pending[0]!.at <= now + EPS) {
      const p = pending.shift()!;
      if (p.first) events.push({ t: p.at, job: p.st.j.id, kind: "arrive" });
      events.push({ t: p.at, job: p.st.j.id, kind: "ready" });
      ready.push(p.st);
    }
  };
  const pick = (): St => {
    let best = 0;
    if (opts.policy === "sjf" || opts.policy === "stcf") {
      for (let i = 1; i < ready.length; i++) {
        const a = ready[i]!, b = ready[best]!;
        // Ties keep the job that ran last, so a tie never costs a switch.
        if (a.burstLeft < b.burstLeft - EPS || (Math.abs(a.burstLeft - b.burstLeft) <= EPS && a.j.id === last)) best = i;
      }
    }
    return ready.splice(best, 1)[0]!;
  };
  // A preempted job re-enters the queue. If the policy picks it again at once, it never left the CPU.
  let preempted = null as { st: St; t: number } | null;
  while (done < jobs.length) {
    admit(t);
    if (!ready.length) { t = pending[0]!.at; continue; }
    const s = pick();
    const continues = preempted?.st === s;
    if (preempted && !continues) events.push({ t: preempted.t, job: preempted.st.j.id, kind: "ready" });
    preempted = null;
    if (s.j.id !== last && last !== -1 && c > 0) {
      pushSlice(slices, { start: t, end: t + c, job: s.j.id, cpu: 0, kind: "switch" });
      t += c;
      admit(t);
    }
    if (!continues) events.push({ t, job: s.j.id, kind: "dispatch" });
    last = s.j.id;
    let run = s.burstLeft;
    if (opts.policy === "rr") run = Math.min(run, q);
    if (opts.policy === "stcf" && pending.length) run = Math.min(run, pending[0]!.at - t);
    pushSlice(slices, { start: t, end: t + run, job: s.j.id, cpu: 0, kind: "run" });
    t += run;
    s.left -= run;
    s.burstLeft -= run;
    admit(t); // arrivals at the end of a quantum go in front of the preempted job
    if (s.burstLeft > EPS) {
      preempted = { st: s, t };
      ready.push(s);
    } else if (s.left <= EPS) {
      events.push({ t, job: s.j.id, kind: "finish" });
      done++;
    } else {
      const io = s.j.io!;
      events.push({ t, job: s.j.id, kind: "block" });
      pushSlice(slices, { start: t, end: t + io.wait, job: s.j.id, cpu: -1, kind: "io" });
      s.burstLeft = nextBurst(s.j, s.left);
      addPending(t + io.wait, s, false);
    }
  }
  return { jobs, slices, events, end: t, cpus: 1 };
}

// ---------------------------------------------------------------------------------------------
// Scenarios that the lesson quotes
// ---------------------------------------------------------------------------------------------

export interface ClassicPreset { id: string; label: string; jobs: Job[] }

export const CLASSIC_PRESETS: ClassicPreset[] = [
  { id: "convoy", label: "Convoy", jobs: [job(0, "A", 0, 100), job(1, "B", 0, 10), job(2, "C", 0, 10)] },
  { id: "late", label: "Short jobs arrive late", jobs: [job(0, "A", 0, 100), job(1, "B", 10, 10), job(2, "C", 10, 10)] },
  { id: "equal", label: "Equal jobs", jobs: [job(0, "A", 0, 5), job(1, "B", 0, 5), job(2, "C", 0, 5)] },
  { id: "io", label: "I/O and CPU", jobs: [job(0, "A", 0, 50, { every: 10, wait: 10 }), job(1, "B", 0, 50)] },
];

export const preset = (id: string): Job[] => CLASSIC_PRESETS.find((p) => p.id === id)!.jobs;

/** All four policies on one job set. */
export function compareClassic(jobs: readonly Job[], quantum: number, switchCost = 0): Record<ClassicPolicy, { trace: Trace; summary: Summary }> {
  const one = (policy: ClassicPolicy) => {
    const trace = simulateClassic(jobs, { policy, quantum, switchCost });
    return { trace, summary: summarize(trace) };
  };
  return { fifo: one("fifo"), sjf: one("sjf"), stcf: one("stcf"), rr: one("rr") };
}

// ---------------------------------------------------------------------------------------------
// SJF optimality
// ---------------------------------------------------------------------------------------------

/** Mean turnaround when jobs arrive together and run in this order, with no preemption. */
export function meanTurnaroundOfOrder(bursts: readonly number[]): number {
  let t = 0, sum = 0;
  for (const b of bursts) { t += b; sum += t; }
  return bursts.length ? sum / bursts.length : 0;
}

/** Every permutation of a small array. */
export function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

/** The best and the worst mean turnaround over all orders, by brute force. */
export function orderExtremes(bursts: readonly number[]): { best: number; worst: number } {
  let best = Infinity, worst = 0;
  for (const p of permutations(bursts)) {
    const m = meanTurnaroundOfOrder(p);
    if (m < best) best = m;
    if (m > worst) worst = m;
  }
  return { best, worst };
}

// ---------------------------------------------------------------------------------------------
// The quantum trade-off
// ---------------------------------------------------------------------------------------------

/** Common CONFIG_HZ values: timer interrupts per second. */
export const LINUX_HZ_CHOICES = [100, 250, 1000];

/** The fraction of CPU time that a switch uses when every quantum ends in a switch. */
export const switchOverhead = (quantum: number, switchCost: number) => switchCost / (quantum + switchCost);

export interface QuantumPoint {
  quantum: number;
  meanResponse: number;
  meanTurnaround: number;
  /** Finished jobs per 1,000 time units (jobs per second when the unit is ms). */
  throughput: number;
  /** Fraction of the CPU time that did useful work. */
  useful: number;
}

/** Equal jobs that all arrive at time 0. Used for the sweep, because the result has a closed form. */
export const equalJobs = (n: number, burst: number): Job[] => Array.from({ length: n }, (_, i) => job(i, `J${i}`, 0, burst));

/** Round-robin on one job set with one quantum. */
export function quantumPoint(jobs: readonly Job[], quantum: number, switchCost: number): QuantumPoint {
  const s = summarize(simulateClassic(jobs, { policy: "rr", quantum, switchCost }));
  return { quantum, meanResponse: s.meanResponse, meanTurnaround: s.meanTurnaround, throughput: s.throughput * 1000, useful: s.utilization };
}

/** Log-spaced quantum values from `lo` to `hi`. */
export function logSpace(lo: number, hi: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => lo * Math.pow(hi / lo, i / (n - 1)));
}
