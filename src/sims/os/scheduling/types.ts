/**
 * The shared vocabulary of every scheduler in this folder.
 *
 * A Job is what the workload asks for. A Trace is what the scheduler did: a list of time slices on
 * CPUs, plus events. Metrics and invariant checks read only the Trace, so they work for any policy.
 * Times have no fixed unit. The lessons use milliseconds.
 */

/** After every `every` units of CPU, the job blocks for `wait` units (a disk or network wait). */
export interface IoPattern { every: number; wait: number }

export interface Job {
  id: number;
  name: string;
  arrival: number;
  /** Total CPU time the job needs. */
  burst: number;
  io?: IoPattern;
  /** Fair schedulers only: the nice value. */
  nice?: number;
  /** EEVDF only: the slice request. */
  slice?: number;
}

export type SliceKind = "run" | "switch" | "io";

/** One stretch of time. `run` and `switch` slices use a CPU. `io` slices have cpu = -1. */
export interface Slice { start: number; end: number; job: number; cpu: number; kind: SliceKind }

export type EventKind = "arrive" | "ready" | "dispatch" | "block" | "finish" | "demote" | "boost" | "migrate";

export interface TraceEvent { t: number; job: number; kind: EventKind; detail?: number }

export interface Trace {
  jobs: readonly Job[];
  slices: Slice[];
  events: TraceEvent[];
  end: number;
  cpus: number;
}

export const EPS = 1e-9;

/** Builds a Job. `io` is optional. */
export const job = (id: number, name: string, arrival: number, burst: number, io?: IoPattern): Job =>
  io ? { id, name, arrival, burst, io } : { id, name, arrival, burst };

/** Appends a slice. It joins the slice to the previous one if they are contiguous. */
export function pushSlice(list: Slice[], s: Slice): void {
  if (s.end - s.start <= EPS) return;
  for (let i = list.length - 1; i >= 0 && i >= list.length - 4; i--) {
    const p = list[i]!;
    if (p.job === s.job && p.cpu === s.cpu && p.kind === s.kind && Math.abs(p.end - s.start) <= EPS) { p.end = s.end; return; }
    if (p.cpu === s.cpu) break;
  }
  list.push({ ...s });
}

export interface JobStats {
  id: number;
  name: string;
  arrival: number;
  first: number;
  finish: number;
  /** finish - arrival. */
  turnaround: number;
  /** first - arrival. */
  response: number;
  cpu: number;
  io: number;
  /** turnaround - cpu - io: time spent ready but not running, including switch time. */
  wait: number;
  /** Number of times the job started to run. */
  dispatches: number;
  /** For each time the job became ready: the delay to the next dispatch. */
  delays: number[];
}

export interface Summary {
  jobs: JobStats[];
  meanTurnaround: number;
  meanResponse: number;
  /** Mean delay from "became ready" to "runs". This shows how an I/O-bound job feels. */
  meanDelay: number;
  /** CPU time that did useful work. */
  useful: number;
  switchTime: number;
  switches: number;
  end: number;
  /** useful / (cpus * end). */
  utilization: number;
  /** Finished jobs per unit of time. */
  throughput: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Computes per-job and average metrics from a trace. */
export function summarize(tr: Trace): Summary {
  const perJob = new Map<number, JobStats>();
  for (const j of tr.jobs) perJob.set(j.id, { id: j.id, name: j.name, arrival: j.arrival, first: NaN, finish: NaN, turnaround: NaN, response: NaN, cpu: 0, io: 0, wait: NaN, dispatches: 0, delays: [] });
  let useful = 0, switchTime = 0, switches = 0;
  for (const s of tr.slices) {
    const len = s.end - s.start;
    if (s.kind === "switch") { switchTime += len; switches++; continue; }
    const st = perJob.get(s.job);
    if (!st) continue;
    if (s.kind === "io") { st.io += len; continue; }
    st.cpu += len;
    useful += len;
    if (Number.isNaN(st.first) || s.start < st.first) st.first = s.start;
  }
  const readySince = new Map<number, number>();
  for (const e of tr.events) {
    const st = perJob.get(e.job);
    if (!st) continue;
    if (e.kind === "ready") readySince.set(e.job, e.t);
    if (e.kind === "dispatch") {
      st.dispatches++;
      const r = readySince.get(e.job);
      if (r !== undefined) { st.delays.push(e.t - r); readySince.delete(e.job); }
    }
    if (e.kind === "finish") st.finish = e.t;
  }
  const jobs = [...perJob.values()];
  for (const st of jobs) {
    st.turnaround = st.finish - st.arrival;
    st.response = st.first - st.arrival;
    st.wait = st.turnaround - st.cpu - st.io;
  }
  const done = jobs.filter((x) => Number.isFinite(x.finish));
  return {
    jobs,
    meanTurnaround: mean(done.map((x) => x.turnaround)),
    meanResponse: mean(jobs.filter((x) => Number.isFinite(x.first)).map((x) => x.response)),
    meanDelay: mean(jobs.flatMap((x) => x.delays)),
    useful,
    switchTime,
    switches,
    end: tr.end,
    utilization: tr.end > 0 ? useful / (tr.cpus * tr.end) : 0,
    throughput: tr.end > 0 ? done.length / tr.end : 0,
  };
}

/**
 * Checks the invariants of a finished trace. An empty result means that the trace is sound:
 * no job lost, no work lost or invented, no CPU that runs two things at once, and no job on two CPUs.
 */
export function traceProblems(tr: Trace): string[] {
  const out: string[] = [];
  const s = summarize(tr);
  for (const j of tr.jobs) {
    const st = s.jobs.find((x) => x.id === j.id)!;
    if (!Number.isFinite(st.finish)) out.push(`job ${j.name} did not finish`);
    if (Math.abs(st.cpu - j.burst) > 1e-6) out.push(`job ${j.name} ran ${st.cpu}, needs ${j.burst}`);
    if (st.first < j.arrival - EPS) out.push(`job ${j.name} ran before it arrived`);
  }
  for (let c = 0; c < tr.cpus; c++) {
    const row = tr.slices.filter((x) => x.cpu === c).sort((a, b) => a.start - b.start);
    for (let i = 1; i < row.length; i++) if (row[i]!.start < row[i - 1]!.end - 1e-6) out.push(`cpu ${c} overlaps at ${row[i]!.start}`);
  }
  for (const j of tr.jobs) {
    const row = tr.slices.filter((x) => x.job === j.id && x.kind !== "switch").sort((a, b) => a.start - b.start);
    for (let i = 1; i < row.length; i++) if (row[i]!.start < row[i - 1]!.end - 1e-6) out.push(`job ${j.name} overlaps itself at ${row[i]!.start}`);
  }
  return out;
}

/** Total time that a CPU sat idle while some job was ready. A work-conserving policy gives 0. */
export function idleWhileReady(tr: Trace): number {
  if (tr.cpus !== 1) throw new Error("idleWhileReady is for one CPU");
  const busy = tr.slices.filter((x) => x.kind !== "io").sort((a, b) => a.start - b.start);
  const gaps: [number, number][] = [];
  let at = 0;
  for (const b of busy) { if (b.start > at + EPS) gaps.push([at, b.start]); at = Math.max(at, b.end); }
  let total = 0;
  const since = new Map<number, number>();
  for (const e of tr.events) {
    if (e.kind === "ready") since.set(e.job, e.t);
    if (e.kind === "dispatch" && since.has(e.job)) {
      const a = since.get(e.job)!;
      for (const [g0, g1] of gaps) total += Math.max(0, Math.min(g1, e.t) - Math.max(g0, a));
      since.delete(e.job);
    }
  }
  return total;
}
