/**
 * Real-time scheduling on one CPU.
 * - simulateRt: preemptive rate-monotonic and earliest-deadline-first on periodic task sets.
 * - Exact checks: response-time analysis for fixed priorities, processor demand for EDF.
 * - simulateInversion: three tasks and one mutex, with and without priority inheritance.
 */
import { mulberry32 } from "../../rng";
import { EPS, pushSlice, type Job, type Slice, type Trace } from "./types";

export type RtPolicy = "rm" | "edf";

/** A periodic task. Each `t` time units it releases a job that needs `c` of CPU by release + `d`. */
export interface RtTask { id: number; name: string; c: number; t: number; d?: number }

export const deadlineOf = (x: RtTask) => x.d ?? x.t;
export const utilization = (ts: readonly RtTask[]) => ts.reduce((a, x) => a + x.c / x.t, 0);

/** Liu and Layland 1973: a set of n tasks with U at or below this bound always meets deadlines under RM. */
export const rmBound = (n: number) => n * (Math.pow(2, 1 / n) - 1);
/** The limit of rmBound as n grows. */
export const RM_LIMIT = Math.LN2;
/** Implicit deadlines: EDF meets every deadline if and only if U is at most 1. */
export const EDF_BOUND = 1;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
/** The least common multiple of the periods. Periods must be whole numbers. */
export const hyperperiod = (ts: readonly RtTask[]) => ts.reduce((a, x) => (a * x.t) / gcd(a, x.t), 1);

// ---------------------------------------------------------------------------------------------
// Exact feasibility
// ---------------------------------------------------------------------------------------------

/** Tasks in rate-monotonic priority order: the shortest period is first. */
export const byRate = (ts: readonly RtTask[]) => [...ts].sort((a, b) => a.t - b.t || a.id - b.id);

/**
 * Response-time analysis (Joseph and Pandya 1986). R is the fixed point of
 * R = C + sum over higher-priority tasks of ceil(R / T) * C. All tasks release together at the worst case.
 * Returns the worst-case response time per task in priority order. Infinity means R passed the deadline.
 */
export function responseTimes(ts: readonly RtTask[]): { task: RtTask; r: number }[] {
  const order = byRate(ts);
  return order.map((task, i) => {
    let r = task.c;
    for (;;) {
      let next = task.c;
      for (let j = 0; j < i; j++) next += Math.ceil(r / order[j]!.t - 1e-12) * order[j]!.c;
      if (next > deadlineOf(task) + EPS) return { task, r: Infinity };
      if (Math.abs(next - r) <= EPS) return { task, r };
      r = next;
    }
  });
}

/** The successive values of R for one task, up to the fixed point or `limit`. For the worked example. */
export function responseIterations(ts: readonly RtTask[], id: number, limit = 1000): number[] {
  const order = byRate(ts);
  const i = order.findIndex((x) => x.id === id);
  const task = order[i]!;
  const out = [task.c];
  for (;;) {
    const r = out[out.length - 1]!;
    let next = task.c;
    for (let j = 0; j < i; j++) next += Math.ceil(r / order[j]!.t - 1e-12) * order[j]!.c;
    out.push(next);
    if (Math.abs(next - r) <= EPS || next > limit) return out;
  }
}

/** Exact test for preemptive RM with deadlines at or below periods. */
export const rmSchedulable = (ts: readonly RtTask[]) => responseTimes(ts).every((x) => x.r !== Infinity);

/** dbf: the CPU that jobs with both release and deadline inside [0, L] must get. */
export const demandBound = (ts: readonly RtTask[], L: number) =>
  ts.reduce((a, x) => a + Math.max(0, Math.floor((L - deadlineOf(x)) / x.t + 1e-12) + 1) * x.c, 0);

/** Exact test for preemptive EDF: U <= 1, and demand <= L at every deadline in one hyperperiod. */
export function edfSchedulable(ts: readonly RtTask[]): boolean {
  if (utilization(ts) > EDF_BOUND + EPS) return false;
  if (ts.every((x) => deadlineOf(x) >= x.t)) return true;
  const h = hyperperiod(ts);
  for (const x of ts) {
    for (let L = deadlineOf(x); L <= h; L += x.t) if (demandBound(ts, L) > L + EPS) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Timeline simulator
// ---------------------------------------------------------------------------------------------

export interface RtJob { task: number; index: number; release: number; deadline: number; left: number; finish: number | null; missed: boolean }
export interface RtMiss { task: number; index: number; deadline: number }

export interface RtResult {
  trace: Trace;
  jobs: RtJob[];
  misses: RtMiss[];
  preemptions: number;
  /** Releases per task, for drawing. */
  releases: { task: number; t: number; deadline: number }[];
}

/**
 * Preemptive scheduling on one CPU for `horizon` time units. A late job keeps running: this shows how each
 * policy fails under overload. Ties: RM takes the lower id; EDF keeps the running job, then the lower id.
 */
export function simulateRt(ts: readonly RtTask[], policy: RtPolicy, horizon: number): RtResult {
  const active: RtJob[] = [];
  const jobs: RtJob[] = [];
  const misses: RtMiss[] = [];
  const releases: RtResult["releases"] = [];
  const slices: Slice[] = [];
  const next = ts.map(() => 0);
  const counts = ts.map(() => 0);
  const rate = new Map(byRate(ts).map((x, i) => [x.id, i]));
  let t = 0, running: RtJob | null = null, preemptions = 0;
  const better = (a: RtJob, b: RtJob) => {
    if (policy === "rm") return rate.get(a.task)! < rate.get(b.task)!;
    if (a.deadline !== b.deadline) return a.deadline < b.deadline;
    if (b === running) return false;
    if (a === running) return true;
    return a.task < b.task;
  };
  while (t < horizon - EPS) {
    ts.forEach((x, i) => {
      while (next[i]! <= t + EPS && next[i]! < horizon) {
        const release = next[i]!;
        const j: RtJob = { task: x.id, index: counts[i]!++, release, deadline: release + deadlineOf(x), left: x.c, finish: null, missed: false };
        active.push(j);
        jobs.push(j);
        releases.push({ task: x.id, t: release, deadline: j.deadline });
        next[i] = release + x.t;
      }
    });
    for (const j of active) {
      if (!j.missed && j.deadline <= t + EPS && j.left > EPS) {
        j.missed = true;
        misses.push({ task: j.task, index: j.index, deadline: j.deadline });
      }
    }
    let best: RtJob | null = null;
    for (const j of active) if (!best || better(j, best)) best = j;
    if (running && best !== running && running.left > EPS) preemptions++;
    running = best;
    let stop = horizon;
    for (const n of next) stop = Math.min(stop, n);
    for (const j of active) if (!j.missed && j.deadline > t + EPS) stop = Math.min(stop, j.deadline);
    if (!best) { t = stop; continue; }
    const run = Math.min(best.left, stop - t);
    pushSlice(slices, { start: t, end: t + run, job: best.task, cpu: 0, kind: "run" });
    t += run;
    best.left -= run;
    if (best.left <= EPS) {
      best.finish = t;
      if (t > best.deadline + EPS && !best.missed) {
        best.missed = true;
        misses.push({ task: best.task, index: best.index, deadline: best.deadline });
      }
      active.splice(active.indexOf(best), 1);
      running = null;
    }
  }
  for (const j of active) {
    if (!j.missed && j.deadline <= horizon + EPS && j.left > EPS) {
      j.missed = true;
      misses.push({ task: j.task, index: j.index, deadline: j.deadline });
    }
  }
  const tasksAsJobs: Job[] = ts.map((x) => ({ id: x.id, name: x.name, arrival: 0, burst: 0 }));
  return { trace: { jobs: tasksAsJobs, slices, events: [], end: horizon, cpus: 1 }, jobs, misses, preemptions, releases };
}

const task = (id: number, name: string, c: number, t: number): RtTask => ({ id, name, c, t });

export interface RtPreset { id: string; label: string; tasks: RtTask[] }

export const RT_PRESETS: RtPreset[] = [
  { id: "gap", label: "RM fails, EDF works", tasks: [task(0, "T1", 2, 5), task(1, "T2", 4, 7)] },
  { id: "under", label: "Under the RM bound", tasks: [task(0, "T1", 1, 4), task(1, "T2", 2, 6), task(2, "T3", 1, 8)] },
  { id: "harmonic", label: "Harmonic, U = 1", tasks: [task(0, "T1", 2, 4), task(1, "T2", 4, 8)] },
  { id: "over", label: "Overload", tasks: [task(0, "T1", 3, 5), task(1, "T2", 3, 7), task(2, "T3", 2, 9)] },
];
export const rtPreset = (id: string) => RT_PRESETS.find((p) => p.id === id)!.tasks;

/** Random task set by UUniFast (Bini and Buttazzo 2005), with log-uniform periods. */
export function randomTaskSet(n: number, u: number, rng: () => number, tMin = 10, tMax = 1000): RtTask[] {
  let left = u;
  const out: RtTask[] = [];
  for (let i = 0; i < n; i++) {
    const nextLeft = i === n - 1 ? 0 : left * Math.pow(rng(), 1 / (n - i - 1));
    const ui = left - nextLeft;
    left = nextLeft;
    const t = tMin * Math.pow(tMax / tMin, rng());
    out.push({ id: i, name: `T${i + 1}`, c: ui * t, t });
  }
  return out;
}

/** The fraction of random task sets at utilization `u` that the exact RM test accepts. */
export function rmAcceptance(n: number, u: number, samples: number, seed = 1): number {
  const rng = mulberry32(seed);
  let ok = 0;
  for (let i = 0; i < samples; i++) if (rmSchedulable(randomTaskSet(n, u, rng))) ok++;
  return ok / samples;
}

/** Kernel defaults that the lesson quotes. */
export const RT_LINUX = {
  /** /proc/sys/kernel/sched_rt_period_us */
  rtPeriodUs: 1_000_000,
  /** /proc/sys/kernel/sched_rt_runtime_us */
  rtRuntimeUs: 950_000,
  /** /proc/sys/kernel/sched_rr_timeslice_ms */
  rrTimesliceMs: 100,
  /** SCHED_FIFO and SCHED_RR priorities are 1 to this. */
  maxRtPrio: 99,
};
export const rtThrottleShare = () => RT_LINUX.rtRuntimeUs / RT_LINUX.rtPeriodUs;

// ---------------------------------------------------------------------------------------------
// Priority inversion
// ---------------------------------------------------------------------------------------------

export type InvOp = { op: "run"; ticks: number } | { op: "lock" } | { op: "unlock" };

export interface InvTask { name: string; prio: number; arrival: number; script: InvOp[] }

export interface InvConfig { inherit: boolean; mediumWork: number; /** Length of L's critical section. */ section?: number }

export interface InvFrame {
  t: number;
  /** The task index that ran during tick [t, t + 1), or -1. */
  running: number;
  owner: number;
  waiting: number;
  /** Effective priority per task. */
  prio: number[];
  state: ("future" | "ready" | "running" | "blocked" | "done")[];
  note: string;
}

export interface InvResult {
  tasks: InvTask[];
  frames: InvFrame[];
  /** Ticks that H waited for the mutex. */
  blocked: number;
  /** H's finish time. */
  finish: number[];
  /** H's response: finish - arrival. */
  hResponse: number;
}

export const inversionTasks = (mediumWork: number, section = 4): InvTask[] => [
  { name: "H", prio: 3, arrival: 3, script: [{ op: "run", ticks: 1 }, { op: "lock" }, { op: "run", ticks: 1 }, { op: "unlock" }, { op: "run", ticks: 1 }] },
  { name: "M", prio: 2, arrival: 5, script: [{ op: "run", ticks: mediumWork }] },
  { name: "L", prio: 1, arrival: 0, script: [{ op: "run", ticks: 1 }, { op: "lock" }, { op: "run", ticks: section }, { op: "unlock" }, { op: "run", ticks: 1 }] },
];

/** One tick at a time, with strict priorities and one mutex. */
export function simulateInversion(cfg: InvConfig): InvResult {
  const tasks = inversionTasks(cfg.mediumWork, cfg.section ?? 4);
  const n = tasks.length;
  const pc = tasks.map(() => 0);
  const left = tasks.map((x) => (x.script[0]?.op === "run" ? x.script[0].ticks : 0));
  const finish = tasks.map(() => -1);
  const blockedOn = tasks.map(() => false);
  let owner = -1;
  let waiter = -1;
  let blocked = 0;
  const frames: InvFrame[] = [];
  const eff = (i: number) => (cfg.inherit && i === owner && waiter >= 0 ? Math.max(tasks[i]!.prio, tasks[waiter]!.prio) : tasks[i]!.prio);
  const totalBudget = 200;
  for (let t = 0; t < totalBudget && finish.some((f) => f < 0); t++) {
    const notes: string[] = [];
    for (let i = 0; i < n; i++) if (tasks[i]!.arrival === t) notes.push(`${tasks[i]!.name} arrives.`);
    // Zero-time operations happen when a task reaches them, while it holds the CPU. Loop until a task will run for a tick.
    let run = -1;
    for (let guard = 0; guard < 16; guard++) {
      run = -1;
      for (let i = 0; i < n; i++) {
        if (tasks[i]!.arrival > t || finish[i]! >= 0 || blockedOn[i]) continue;
        if (run < 0 || eff(i) > eff(run)) run = i;
      }
      if (run < 0) break;
      const op = tasks[run]!.script[pc[run]!];
      if (!op) { finish[run] = t; continue; }
      if (op.op === "run" && left[run]! > 0) break;
      if (op.op === "lock") {
        if (owner < 0) {
          owner = run;
          notes.push(`${tasks[run]!.name} takes the mutex.`);
          advance(run);
        } else {
          blockedOn[run] = true;
          waiter = run;
          notes.push(`${tasks[run]!.name} blocks: ${tasks[owner]!.name} holds the mutex.${cfg.inherit ? ` ${tasks[owner]!.name} inherits priority ${tasks[run]!.prio}.` : ""}`);
        }
      } else if (op.op === "unlock") {
        notes.push(`${tasks[run]!.name} releases the mutex.`);
        owner = -1;
        advance(run);
        if (waiter >= 0) {
          const w = waiter;
          waiter = -1;
          blockedOn[w] = false;
          owner = w;
          notes.push(`${tasks[w]!.name} gets the mutex and wakes.`);
          advance(w);
        }
      } else {
        advance(run);
      }
    }
    if (finish.every((f) => f >= 0)) break;
    if (run >= 0) left[run]!--;
    if (waiter === 0) blocked++;
    frames.push({
      t, running: run, owner, waiting: waiter,
      prio: tasks.map((_, i) => eff(i)),
      state: tasks.map((x, i) => (x.arrival > t ? "future" : finish[i]! >= 0 ? "done" : i === run ? "running" : blockedOn[i] ? "blocked" : "ready")),
      note: notes.join(" "),
    });
  }
  function advance(i: number) {
    pc[i]!++;
    const op = tasks[i]!.script[pc[i]!];
    left[i] = op?.op === "run" ? op.ticks : 0;
  }
  return { tasks, frames, blocked, finish, hResponse: finish[0]! - tasks[0]!.arrival };
}
