/**
 * Multilevel feedback queue, with the rule set from OSTEP chapter 8.
 *
 * Rule 1: if Priority(A) > Priority(B), A runs.
 * Rule 2: if Priority(A) = Priority(B), A and B run in round-robin with the quantum of that level.
 * Rule 3: a new job enters at the highest priority.
 * Rule 4: when a job uses up its allotment at a level, it moves down, however many times it gave up the CPU.
 *         ("slice" accounting is the older 4a/4b form: only a full slice counts, and a yield clears the count.)
 * Rule 5: after each period S, every job moves to the highest priority.
 *
 * Level 0 is the highest priority.
 */
import { EPS, pushSlice, type Job, type Slice, type Trace, type TraceEvent } from "./types";

export type Accounting = "allotment" | "slice";

export interface MlfqConfig {
  /** The time slice at each level. Its length is the number of levels. */
  quantum: number[];
  /** CPU time a job may use at each level before it moves down (allotment accounting). */
  allotment: number[];
  /** Rule 5 period. 0 turns the boost off. */
  boost: number;
  accounting: Accounting;
  /** Stop at this time even if jobs remain. */
  horizon?: number;
}

export const MLFQ_DEFAULT: MlfqConfig = { quantum: [10, 20, 40], allotment: [10, 20, 40], boost: 0, accounting: "allotment" };

/** The state of the queues just after a scheduling decision. */
export interface MlfqSnapshot {
  t: number;
  /** Job ids in each ready queue, front first. The running job is not in a queue. */
  queues: number[][];
  running: number | null;
  blocked: number[];
  done: number[];
  /** The level of each job id. */
  level: Map<number, number>;
}

export interface MlfqTrace extends Trace {
  snapshots: MlfqSnapshot[];
  boosts: number[];
  /** Level changes, for labels: t, job, the new level, why. */
  moves: { t: number; job: number; level: number; why: "demote" | "boost" }[];
}

interface St { j: Job; left: number; burstLeft: number; level: number; used: number; sliceLeft: number; blocked: boolean; done: boolean; arrived: boolean }

export function simulateMlfq(jobs: readonly Job[], cfg: MlfqConfig): MlfqTrace {
  const levels = cfg.quantum.length;
  // The lowest level has nowhere to go, so only its quantum applies there.
  const allot = (l: number) => (l === levels - 1 ? Infinity : cfg.accounting === "allotment" ? cfg.allotment[l]! : cfg.quantum[l]!);
  const burstOf = (j: Job, left: number) => (j.io ? Math.min(j.io.every, left) : left);
  const sts = jobs.map<St>((j) => ({ j, left: j.burst, burstLeft: burstOf(j, j.burst), level: 0, used: 0, sliceLeft: 0, blocked: false, done: false, arrived: false }));
  const queues: St[][] = Array.from({ length: levels }, () => []);
  const slices: Slice[] = [];
  const events: TraceEvent[] = [];
  const snapshots: MlfqSnapshot[] = [];
  const boosts: number[] = [];
  const moves: MlfqTrace["moves"] = [];
  const pending: { at: number; st: St }[] = sts.map((st) => ({ at: st.j.arrival, st })).sort((a, b) => a.at - b.at || a.st.j.id - b.st.j.id);
  const addPending = (at: number, st: St) => {
    let i = pending.length;
    while (i > 0 && pending[i - 1]!.at > at) i--;
    pending.splice(i, 0, { at, st });
  };
  let t = 0, finished = 0;
  let cur: St | null = null;
  let nextBoost = cfg.boost > 0 ? cfg.boost : Infinity;
  const horizon = cfg.horizon ?? Infinity;

  const snap = () => {
    snapshots.push({
      t,
      queues: queues.map((q) => q.map((s) => s.j.id)),
      running: cur ? cur.j.id : null,
      blocked: sts.filter((s) => s.blocked).map((s) => s.j.id),
      done: sts.filter((s) => s.done).map((s) => s.j.id),
      level: new Map(sts.map((s) => [s.j.id, s.level])),
    });
  };
  const admit = () => {
    while (pending.length && pending[0]!.at <= t + EPS) {
      const { st } = pending.shift()!;
      if (!st.arrived) { st.arrived = true; events.push({ t, job: st.j.id, kind: "arrive" }); }
      st.blocked = false;
      events.push({ t, job: st.j.id, kind: "ready" });
      queues[st.level]!.push(st);
    }
  };
  const boost = () => {
    while (nextBoost <= t + EPS) {
      boosts.push(nextBoost);
      nextBoost += cfg.boost;
      const order = queues.flat();
      for (const q of queues) q.length = 0;
      if (cur) { events.push({ t, job: cur.j.id, kind: "ready" }); order.unshift(cur); cur = null; }
      for (const s of order) queues[0]!.push(s);
      for (const s of sts) {
        if (s.done || !s.arrived) continue;
        if (s.level !== 0) { moves.push({ t, job: s.j.id, level: 0, why: "boost" }); events.push({ t, job: s.j.id, kind: "boost", detail: 0 }); }
        s.level = 0;
        s.used = 0;
        s.sliceLeft = 0;
      }
    }
  };
  const nextEvent = () => Math.min(pending[0]?.at ?? Infinity, nextBoost, horizon);

  while (finished < jobs.length && t < horizon - EPS) {
    admit();
    boost();
    if (cur) {
      const c: St = cur;
      if (queues.slice(0, c.level).some((q) => q.length)) {
        // Rule 1: a higher level has work. The job goes to the front of its level and keeps its slice.
        queues[c.level]!.unshift(c);
        events.push({ t, job: c.j.id, kind: "ready" });
        cur = null;
      }
    }
    if (!cur) {
      const q = queues.find((x) => x.length);
      if (!q) {
        const at = nextEvent();
        if (at === Infinity) break;
        snap();
        t = at;
        continue;
      }
      const s = q.shift()!;
      if (s.sliceLeft <= EPS) s.sliceLeft = cfg.quantum[s.level]!;
      events.push({ t, job: s.j.id, kind: "dispatch" });
      cur = s;
      snap();
    }
    const c: St = cur!;
    const run = Math.min(c.burstLeft, c.sliceLeft, allot(c.level) - c.used, nextEvent() - t);
    if (run > EPS) {
      pushSlice(slices, { start: t, end: t + run, job: c.j.id, cpu: 0, kind: "run" });
      t += run;
      c.left -= run;
      c.burstLeft -= run;
      c.sliceLeft -= run;
      c.used += run;
    }
    if (c.burstLeft <= EPS) {
      cur = null;
      c.sliceLeft = 0;
      if (cfg.accounting === "slice") c.used = 0; // old rule 4b: giving up the CPU clears the count
      if (c.left <= EPS) {
        c.done = true;
        finished++;
        events.push({ t, job: c.j.id, kind: "finish" });
      } else {
        const io = c.j.io!;
        c.blocked = true;
        c.burstLeft = burstOf(c.j, c.left);
        events.push({ t, job: c.j.id, kind: "block" });
        pushSlice(slices, { start: t, end: t + io.wait, job: c.j.id, cpu: -1, kind: "io" });
        addPending(t + io.wait, c);
      }
      snap();
    } else if (c.used >= allot(c.level) - EPS) {
      cur = null;
      c.sliceLeft = 0;
      c.used = 0;
      c.level++;
      moves.push({ t, job: c.j.id, level: c.level, why: "demote" });
      events.push({ t, job: c.j.id, kind: "demote", detail: c.level });
      events.push({ t, job: c.j.id, kind: "ready" });
      queues[c.level]!.push(c);
      snap();
    } else if (c.sliceLeft <= EPS) {
      cur = null;
      c.used = c.level === levels - 1 ? 0 : c.used;
      events.push({ t, job: c.j.id, kind: "ready" });
      queues[c.level]!.push(c);
      snap();
    }
  }
  snap();
  return { jobs, slices, events, end: t, cpus: 1, snapshots, boosts, moves };
}

/** The last snapshot at or before time t. */
export function snapshotAt(tr: MlfqTrace, t: number): MlfqSnapshot {
  let lo = 0, hi = tr.snapshots.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (tr.snapshots[m]!.t <= t + EPS) lo = m; else hi = m - 1;
  }
  return tr.snapshots[lo]!;
}

/** The fraction of CPU time in [from, to] that went to a job. */
export function cpuShare(tr: Trace, id: number, from: number, to: number): number {
  let mine = 0, all = 0;
  for (const s of tr.slices) {
    if (s.kind !== "run") continue;
    const len = Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));
    all += len;
    if (s.job === id) mine += len;
  }
  return all > 0 ? mine / all : 0;
}

/** CPU time of a job in [from, to]. */
export function cpuTime(tr: Trace, id: number, from: number, to: number): number {
  let mine = 0;
  for (const s of tr.slices) if (s.kind === "run" && s.job === id) mine += Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));
  return mine;
}

// ---------------------------------------------------------------------------------------------
// Scenarios that the lesson quotes
// ---------------------------------------------------------------------------------------------

/** A long CPU job, an interactive job, and a short job that arrives late. */
export const MLFQ_MIX: Job[] = [
  { id: 0, name: "Long", arrival: 0, burst: 180 },
  { id: 1, name: "Chat", arrival: 0, burst: 30, io: { every: 3, wait: 12 } },
  { id: 2, name: "Short", arrival: 60, burst: 16 },
];

/** Two interactive jobs that between them keep level 0 busy, and one long job. Old rules starve the long job. */
export const MLFQ_STARVE: Job[] = [
  { id: 0, name: "Long", arrival: 0, burst: 1000 },
  { id: 1, name: "I/O-1", arrival: 0, burst: 1000, io: { every: 5, wait: 4 } },
  { id: 2, name: "I/O-2", arrival: 0, burst: 1000, io: { every: 5, wait: 4 } },
];

/** The gaming demo: a hog and a job that yields at `fraction` of the quantum for `sleep` time units. */
export function gamingJobs(fraction: number, quantum: number, sleep: number, horizon: number): Job[] {
  return [
    { id: 0, name: "Hog", arrival: 0, burst: horizon * 2 },
    { id: 1, name: "Gamer", arrival: 0, burst: horizon * 2, io: { every: fraction * quantum, wait: sleep } },
  ];
}

export interface GamingResult { trace: MlfqTrace; gamerShare: number; hogShare: number; gamerLevel: number }

/** Runs the gaming scenario under one accounting rule. */
export function gamingRun(fraction: number, accounting: Accounting, opts: { quantum?: number; sleep?: number; horizon?: number; boost?: number } = {}): GamingResult {
  const q = opts.quantum ?? 10, sleep = opts.sleep ?? 0.1, horizon = opts.horizon ?? 1000;
  const trace = simulateMlfq(gamingJobs(fraction, q, sleep, horizon), {
    quantum: [q, q, q], allotment: [q, q, q], boost: opts.boost ?? 0, accounting, horizon,
  });
  const last = trace.snapshots[trace.snapshots.length - 1]!;
  return {
    trace,
    gamerShare: cpuShare(trace, 1, 0, horizon),
    hogShare: cpuShare(trace, 0, 0, horizon),
    gamerLevel: last.level.get(1)!,
  };
}

/** The long job's CPU share in the starvation scenario, over the first `horizon` time units. */
export function starveShare(accounting: Accounting, boost: number, horizon = 900): number {
  const tr = simulateMlfq(MLFQ_STARVE, { quantum: [10, 10, 10], allotment: [10, 10, 10], accounting, boost, horizon });
  return cpuShare(tr, 0, 0, horizon);
}

/** Facts about real systems that the lesson quotes. */
export const HISTORY = {
  /** Windows NT thread priorities: 0 to 31. */
  windowsPriorityLevels: 32,
  /** Solaris time-sharing class: 0 to 59. */
  solarisTsLevels: 60,
  /** CTSS, Corbato and others, the first multilevel feedback scheduler. */
  ctssYear: 1962,
  /** The Linux O(1) scheduler (2.6.0 to 2.6.22): MAX_PRIO. */
  linuxO1Levels: 140,
};
