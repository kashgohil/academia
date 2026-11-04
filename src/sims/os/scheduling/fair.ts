/**
 * Proportional-share scheduling on one CPU: a model of CFS (Linux 2.6.23 to 6.5) and of EEVDF (Linux 6.6 on).
 *
 * The weight table, the vruntime rule and the default tunables are the kernel's. The rest is a model:
 * - time is in milliseconds, and a slice ends at its exact time. A real kernel usually notices at the next tick.
 * - there is one runqueue. The multicore balancer is in multicore.ts.
 * - EEVDF runs a task until its request is used up, like RUN_TO_PARITY. A wake preempts only if the woken
 *   task is eligible and has the earliest deadline.
 *
 * FairSim keeps the kernel's split: the running task is NOT in the tree. CFS removes it at pick time
 * (set_next_entity) and inserts it again when it stops.
 */
import { RbTree } from "./rbtree";
import { EPS, pushSlice, type Job, type Slice, type Trace, type TraceEvent } from "./types";

// ---------------------------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------------------------

/** kernel/sched/core.c: sched_prio_to_weight, for nice -20 to nice 19. */
export const SCHED_PRIO_TO_WEIGHT: readonly number[] = [
  /* -20 */ 88761, 71755, 56483, 46273, 36291,
  /* -15 */ 29154, 23254, 18705, 14949, 11916,
  /* -10 */ 9548, 7620, 6100, 4904, 3906,
  /*  -5 */ 3121, 2501, 1991, 1586, 1277,
  /*   0 */ 1024, 820, 655, 526, 423,
  /*   5 */ 335, 272, 215, 172, 137,
  /*  10 */ 110, 87, 70, 56, 45,
  /*  15 */ 36, 29, 23, 18, 15,
];

export const NICE_0_WEIGHT = 1024;
export const niceToWeight = (nice: number): number => {
  const w = SCHED_PRIO_TO_WEIGHT[Math.round(nice) + 20];
  if (w === undefined) throw new Error(`nice ${nice} is out of range`);
  return w;
};

/** kernel/sched/core.c: sched_prio_to_wmult is 2^32 / weight, so that the kernel can multiply, not divide. */
export const weightToWmult = (w: number) => Math.round(2 ** 32 / w);

/** The CPU share of each weight on one runqueue. */
export const expectedShares = (weights: readonly number[]): number[] => {
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
};

/** calc_delta_fair: real time to virtual time. */
export const vruntimeDelta = (ms: number, weight: number) => (ms * NICE_0_WEIGHT) / weight;

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

/** update_sysctl: tunables scale by 1 + log2(cpus), with cpus capped at 8. */
export const tunableFactor = (cpus: number) => 1 + Math.floor(Math.log2(Math.min(Math.max(1, cpus), 8)));

export interface CfsTunables {
  /** sysctl_sched_latency: the period in which every runnable task should run once. */
  latency: number;
  /** sysctl_sched_min_granularity: the smallest slice when there are many tasks. */
  minGranularity: number;
  /** sysctl_sched_wakeup_granularity: how far behind a woken task must be to preempt. */
  wakeupGranularity: number;
  /** GENTLE_FAIR_SLEEPERS: limit the credit of a sleeper to half a latency period. */
  sleeperClamp: boolean;
}

/** Defaults: 6 ms, 0.75 ms and 1 ms, times the factor. */
export const cfsDefaults = (cpus: number): CfsTunables => {
  const f = tunableFactor(cpus);
  return { latency: 6 * f, minGranularity: 0.75 * f, wakeupGranularity: 1 * f, sleeperClamp: true };
};

/** Linux 6.6 sysctl_sched_base_slice: 0.75 ms times the factor. */
export const eevdfBaseSlice = (cpus: number) => 0.75 * tunableFactor(cpus);

/** Linux 6.12: the range of a slice request through sched_attr::sched_runtime, in ms. */
export const SLICE_REQUEST_RANGE = { min: 0.1, max: 100 };

/** __sched_period: at most latency / min_granularity tasks fit, then the period grows. */
export const schedPeriod = (t: CfsTunables, nr: number) => (nr * t.minGranularity > t.latency ? nr * t.minGranularity : t.latency);

// ---------------------------------------------------------------------------------------------
// The simulator
// ---------------------------------------------------------------------------------------------

export type FairPolicy = "cfs" | "eevdf";

export interface FairTaskSpec {
  name: string;
  nice?: number;
  /** EEVDF: the slice this task requests. Default: the base slice. CFS ignores it. */
  slice?: number;
  /** Run this much CPU, then sleep. Without it, the task is always runnable. */
  run?: number;
  sleep?: number;
  /** Sleep only once. */
  once?: boolean;
  arrival?: number;
  /** Total CPU that the task needs. Then it exits. Without it, the task runs for ever. */
  total?: number;
}

export interface FairEntity {
  id: number;
  name: string;
  nice: number;
  weight: number;
  /** The EEVDF request, in ms. */
  slice: number;
  vruntime: number;
  deadline: number;
  /** Lag saved at sleep (EEVDF): V - v, in virtual time. */
  vlag: number;
  /** CPU time used. */
  sumExec: number;
  state: "new" | "queued" | "running" | "sleeping" | "gone";
  /** CPU time left before the next sleep. */
  burstLeft: number;
  wakeAt: number;
  ranThisDispatch: number;
  waitingSince: number;
  /** Wait statistics: from "wants the CPU" to "runs". */
  waits: number;
  waitTotal: number;
  waitMax: number;
  spec: FairTaskSpec;
}

export interface FairOptions {
  policy: FairPolicy;
  cfs?: CfsTunables;
  baseSlice?: number;
  /** Keep slices only for this many ms behind now. Default: keep all. */
  keep?: number;
  /** Record samples of the virtual clocks for plots. */
  sampleVruntime?: boolean;
  /** Stop recording samples after this time. */
  sampleUntil?: number;
  /**
   * EEVDF: model Linux 6.12 DELAY_DEQUEUE. A sleeping task with negative lag keeps its vruntime, so that V
   * can catch up with it while it sleeps. If V passes it, the task wakes with zero lag and not with a debt.
   */
  delayedDequeue?: boolean;
  /** Record dispatch, ready and finish events, and I/O slices, for the shared metric code. */
  record?: boolean;
}

/** The virtual clocks at one moment. `running` is the task id on the CPU, or -1. */
export interface VruntimeSample { t: number; v: number[]; deadline: number[]; V: number; running: number; state: FairEntity["state"][] }

export class FairSim {
  readonly policy: FairPolicy;
  readonly cfs: CfsTunables;
  readonly baseSlice: number;
  entities: FairEntity[] = [];
  /** CFS only: the waiting tasks, by vruntime. The running task is not here. */
  tree = new RbTree<FairEntity>((a, b) => a.vruntime < b.vruntime || (a.vruntime === b.vruntime && a.id < b.id));
  curr: FairEntity | null = null;
  now = 0;
  minVruntime = 0;
  /** EEVDF: V from the last time that the queue had a task. */
  private lastV = 0;
  slices: Slice[] = [];
  events: TraceEvent[] = [];
  samples: VruntimeSample[] = [];
  switches = 0;
  private lastRan = -1;
  private readonly keep: number;
  private readonly sampling: boolean;
  private readonly sampleUntil: number;
  private readonly delayed: boolean;
  private readonly record: boolean;

  constructor(opts: FairOptions) {
    this.policy = opts.policy;
    this.cfs = opts.cfs ?? cfsDefaults(8);
    this.baseSlice = opts.baseSlice ?? eevdfBaseSlice(8);
    this.keep = opts.keep ?? Infinity;
    this.sampling = opts.sampleVruntime ?? false;
    this.sampleUntil = opts.sampleUntil ?? Infinity;
    this.delayed = opts.delayedDequeue ?? false;
    this.record = opts.record ?? false;
  }

  /** Tasks that want the CPU now. */
  runnable(): FairEntity[] { return this.entities.filter((e) => e.state === "queued" || e.state === "running"); }

  add(spec: FairTaskSpec): FairEntity {
    const nice = spec.nice ?? 0;
    const e: FairEntity = {
      id: this.entities.length, name: spec.name, nice, weight: niceToWeight(nice), slice: spec.slice ?? this.baseSlice,
      vruntime: 0, deadline: 0, vlag: 0, sumExec: 0, state: "new", burstLeft: spec.run ?? Infinity, wakeAt: spec.arrival ?? this.now,
      ranThisDispatch: 0, waitingSince: this.now, waits: 0, waitTotal: 0, waitMax: 0, spec,
    };
    this.entities.push(e);
    if (e.wakeAt <= this.now + EPS) this.placeNew(e);
    return e;
  }

  remove(id: number): void {
    const e = this.entities[id];
    if (!e || e.state === "gone") return;
    if (e === this.curr) this.curr = null;
    if (e.state === "queued" && this.policy === "cfs") this.tree.remove(e);
    e.state = "gone";
  }

  /** Changes the nice value of a task, like setpriority(2). */
  reweight(id: number, nice: number): void {
    const e = this.entities[id];
    if (!e) return;
    e.nice = nice;
    e.weight = niceToWeight(nice);
  }

  // ---- policy: placement ----

  private placeNew(e: FairEntity): void {
    if (this.policy === "cfs") {
      // place_entity with START_DEBIT: a new task starts one virtual slice ahead, so a fork cannot steal time.
      const nr = this.runnable().length + 1;
      const load = this.runnable().reduce((a, x) => a + x.weight, 0) + e.weight;
      const vslice = vruntimeDelta((schedPeriod(this.cfs, nr) * e.weight) / load, e.weight);
      e.vruntime = nr > 1 ? this.minVruntime + vslice : this.minVruntime;
    } else {
      e.vruntime = this.avgVruntime();
      e.deadline = e.vruntime + vruntimeDelta(e.slice, e.weight);
    }
    this.enqueue(e);
  }

  private placeWake(e: FairEntity): void {
    if (this.policy === "cfs") {
      if (this.cfs.sleeperClamp) e.vruntime = Math.max(e.vruntime, this.minVruntime - this.cfs.latency / 2);
    } else {
      // place_entity: inflate the lag, so that the task still has this lag after it joins the average.
      const others = this.runnable();
      const W = others.reduce((a, x) => a + x.weight, 0);
      const V = this.avgVruntime();
      const saved = this.delayed && e.vlag < 0 ? Math.min(0, V - e.vruntime) : e.vlag;
      const lag = W > 0 ? (saved * (W + e.weight)) / W : 0;
      e.vruntime = V - lag;
      e.deadline = e.vruntime + vruntimeDelta(e.slice, e.weight);
    }
    this.enqueue(e);
  }

  private enqueue(e: FairEntity): void {
    e.state = "queued";
    e.waitingSince = this.now;
    if (this.record) this.events.push({ t: this.now, job: e.id, kind: "ready" });
    if (this.policy === "cfs") this.tree.insert(e);
  }

  // ---- policy: EEVDF math ----

  /** V: the weighted average vruntime of all runnable tasks. */
  avgVruntime(): number {
    let sum = 0, w = 0;
    for (const e of this.entities) {
      if (e.state === "queued" || e.state === "running") { sum += e.weight * e.vruntime; w += e.weight; }
    }
    if (w === 0) return this.lastV;
    this.lastV = sum / w;
    return this.lastV;
  }

  /** lag in virtual time, V - v. Positive: the task is owed CPU time. */
  lag(e: FairEntity): number { return this.avgVruntime() - e.vruntime; }

  eligible(e: FairEntity): boolean { return e.vruntime <= this.avgVruntime() + 1e-7; }

  // ---- policy: picking ----

  private pick(): FairEntity | null {
    if (this.policy === "cfs") return this.tree.min();
    let best: FairEntity | null = null;
    const V = this.avgVruntime();
    for (const e of this.entities) {
      if (e.state !== "queued" && e.state !== "running") continue;
      if (e.vruntime > V + 1e-7) continue;
      if (!best || e.deadline < best.deadline - 1e-9 || (Math.abs(e.deadline - best.deadline) <= 1e-9 && e.id < best.id)) best = e;
    }
    return best;
  }

  /** CFS: sched_slice, the fair part of the period. */
  idealSlice(e: FairEntity): number {
    const run = this.runnable();
    const load = run.reduce((a, x) => a + x.weight, 0);
    return load > 0 ? (schedPeriod(this.cfs, run.length) * e.weight) / load : schedPeriod(this.cfs, 1);
  }

  private sliceLeft(e: FairEntity): number {
    if (this.policy === "cfs") return Math.max(0, this.idealSlice(e) - e.ranThisDispatch);
    return Math.max(0, ((e.deadline - e.vruntime) * e.weight) / NICE_0_WEIGHT);
  }

  private dispatch(e: FairEntity): void {
    if (this.policy === "cfs") this.tree.remove(e);
    e.state = "running";
    e.ranThisDispatch = 0;
    const w = this.now - e.waitingSince;
    if (w > EPS) { e.waits++; e.waitTotal += w; if (w > e.waitMax) e.waitMax = w; }
    if (this.lastRan !== e.id) { this.switches++; this.lastRan = e.id; }
    if (this.record) this.events.push({ t: this.now, job: e.id, kind: "dispatch" });
    this.curr = e;
  }

  private requeueCurr(): void {
    const e = this.curr!;
    this.curr = null;
    this.enqueue(e);
  }

  private updateMinVruntime(): void {
    let v = this.curr ? this.curr.vruntime : Infinity;
    const left = this.tree.min();
    if (left) v = Math.min(v, left.vruntime);
    if (v !== Infinity) this.minVruntime = Math.max(this.minVruntime, v);
  }

  private wakeDue(): void {
    for (const e of this.entities) {
      if ((e.state === "sleeping" || e.state === "new") && e.wakeAt <= this.now + EPS) {
        if (e.state === "new") this.placeNew(e);
        else {
          e.burstLeft = e.spec.once ? Infinity : (e.spec.run ?? Infinity);
          this.placeWake(e);
        }
        const c = this.curr;
        if (!c) continue;
        if (this.policy === "cfs") {
          // wakeup_preempt_entity: the woken task must be behind by more than the (weighted) granularity.
          if (c.vruntime - e.vruntime > vruntimeDelta(this.cfs.wakeupGranularity, e.weight)) this.requeueCurr();
        } else if (this.pick() === e) {
          this.requeueCurr();
        }
      }
    }
  }

  private nextWake(): number {
    let at = Infinity;
    for (const e of this.entities) if ((e.state === "sleeping" || e.state === "new") && e.wakeAt < at) at = e.wakeAt;
    return at;
  }

  private sample(): void {
    if (!this.sampling || this.now > this.sampleUntil) return;
    this.samples.push({
      t: this.now,
      v: this.entities.map((e) => e.vruntime),
      deadline: this.entities.map((e) => e.deadline),
      V: this.policy === "cfs" ? this.minVruntime : this.avgVruntime(),
      running: this.curr ? this.curr.id : -1,
      state: this.entities.map((e) => e.state),
    });
  }

  /** Advances the simulation by `dt` ms. */
  advance(dt: number): void {
    const until = this.now + dt;
    let guard = 0;
    while (this.now < until - EPS && guard++ < 1_000_000) {
      this.wakeDue();
      if (!this.curr) {
        const next = this.pick();
        if (!next) {
          this.now = Math.min(until, Math.max(this.now, this.nextWake()));
          continue;
        }
        this.dispatch(next);
        this.sample();
      }
      const c = this.curr!;
      const totalLeft = (c.spec.total ?? Infinity) - c.sumExec;
      const run = Math.min(this.sliceLeft(c), until - this.now, c.burstLeft, totalLeft, this.nextWake() - this.now);
      if (run > EPS) {
        pushSlice(this.slices, { start: this.now, end: this.now + run, job: c.id, cpu: 0, kind: "run" });
        this.now += run;
        c.vruntime += vruntimeDelta(run, c.weight);
        c.sumExec += run;
        c.burstLeft -= run;
        c.ranThisDispatch += run;
        if (this.policy === "cfs") this.updateMinVruntime();
        this.sample();
      }
      if (this.keep !== Infinity && this.slices.length > 4096) {
        const cut = this.now - this.keep;
        this.slices = this.slices.filter((s) => s.end > cut);
      }
      if (totalLeft - run <= EPS) {
        c.state = "gone";
        this.curr = null;
        if (this.record) this.events.push({ t: this.now, job: c.id, kind: "finish" });
        continue;
      }
      if (c.burstLeft <= EPS) {
        // The task sleeps. EEVDF saves its lag, clamped like update_entity_lag.
        if (this.policy === "eevdf") {
          const limit = vruntimeDelta(2 * c.slice, c.weight);
          c.vlag = Math.max(-limit, Math.min(limit, this.avgVruntime() - c.vruntime));
        }
        c.state = "sleeping";
        c.wakeAt = this.now + (c.spec.sleep ?? 0);
        this.curr = null;
        if (this.record) {
          this.events.push({ t: this.now, job: c.id, kind: "block" });
          pushSlice(this.slices, { start: this.now, end: c.wakeAt, job: c.id, cpu: -1, kind: "io" });
        }
        continue;
      }
      if (this.policy === "eevdf" && c.vruntime >= c.deadline - 1e-9) {
        // update_deadline: the request is used up, so the task makes a new one.
        c.deadline = c.vruntime + vruntimeDelta(c.slice, c.weight);
        this.requeueCurr();
      } else if (this.policy === "cfs" && c.ranThisDispatch >= this.idealSlice(c) - EPS) {
        this.requeueCurr();
      }
    }
  }

  /** CPU share of each live task since time 0. */
  shares(): number[] {
    const total = this.entities.reduce((a, e) => a + e.sumExec, 0);
    return this.entities.map((e) => (total > 0 ? e.sumExec / total : 0));
  }

  /** The result as a Trace, for the shared Gantt and the metric code. */
  trace(): Trace {
    const jobs: Job[] = this.entities.map((e) => ({ id: e.id, name: e.name, arrival: e.spec.arrival ?? 0, burst: e.spec.total ?? e.sumExec }));
    return { jobs, slices: this.slices, events: this.events, end: this.now, cpus: 1 };
  }
}

/**
 * Runs a Job set to completion under CFS or EEVDF. Job ids must be 0, 1, 2, ... in order.
 * This is the same contract as simulateClassic and simulateMlfq.
 */
export function simulateFair(jobs: readonly Job[], policy: FairPolicy, opts: Partial<FairOptions> = {}): Trace {
  const sim = new FairSim({ ...opts, policy, record: true });
  for (const j of jobs) {
    const spec: FairTaskSpec = { name: j.name, nice: j.nice ?? 0, arrival: j.arrival, total: j.burst };
    if (j.slice !== undefined) spec.slice = j.slice;
    if (j.io) { spec.run = j.io.every; spec.sleep = j.io.wait; }
    sim.add(spec);
  }
  for (let guard = 0; guard < 1_000_000 && sim.entities.some((e) => e.state !== "gone"); guard++) {
    // Stop exactly at the last finish, so that `end` is the makespan.
    sim.advance(1);
  }
  const tr = sim.trace();
  const lastFinish = Math.max(0, ...tr.events.filter((e) => e.kind === "finish").map((e) => e.t));
  return { ...tr, end: lastFinish };
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

export interface FairRunStats { name: string; share: number; meanWait: number; maxWait: number; waits: number }

export const fairStats = (s: FairSim): FairRunStats[] => {
  const sh = s.shares();
  return s.entities.map((e, i) => ({ name: e.name, share: sh[i]!, meanWait: e.waits ? e.waitTotal / e.waits : 0, maxWait: e.waitMax, waits: e.waits }));
};

/** Runs a task set for `horizon` ms. */
export function runFair(policy: FairPolicy, tasks: readonly FairTaskSpec[], horizon: number, opts: Partial<FairOptions> = {}): FairSim {
  const s = new FairSim({ policy, ...opts });
  for (const t of tasks) s.add(t);
  s.advance(horizon);
  return s;
}

export interface LatencyScenario {
  hogs: number;
  latencySlice: number;
  mode: "steady" | "periodic";
  run?: number;
  sleep?: number;
  horizon?: number;
  delayedDequeue?: boolean;
  sampleUntil?: number;
}

/**
 * The CFS and EEVDF comparison. One latency-sensitive task L, and hogs that use the base slice.
 * "steady": L is always runnable. "periodic": L runs for `run` ms, then sleeps for `sleep` ms.
 * On 8 or more CPUs the tunables are 24 ms latency and 3 ms minimum, and the base slice is 3 ms.
 */
export function latencyScenario(sc: LatencyScenario): { cfs: FairSim; eevdf: FairSim; tasks: FairTaskSpec[] } {
  const horizon = sc.horizon ?? 1000;
  const tasks: FairTaskSpec[] = [
    sc.mode === "steady"
      ? { name: "L", slice: sc.latencySlice }
      : { name: "L", slice: sc.latencySlice, run: sc.run ?? 1, sleep: sc.sleep ?? 7 },
    ...Array.from({ length: sc.hogs }, (_, i): FairTaskSpec => ({ name: `H${i + 1}` })),
  ];
  return {
    cfs: runFair("cfs", tasks, horizon),
    eevdf: runFair("eevdf", tasks, horizon, { delayedDequeue: sc.delayedDequeue ?? false, sampleVruntime: sc.sampleUntil !== undefined, sampleUntil: sc.sampleUntil ?? 0 }),
    tasks,
  };
}

export interface SleeperResult { sim: FairSim; wokeAt: number; longestRun: number }

/**
 * The sleeper scenario: A and B share the CPU. B has run 25 ms, sleeps 200 ms, then wakes.
 * Without the clamp, B wakes far behind A and keeps the CPU until it catches up.
 */
export function sleeperScenario(clamp: boolean, sleepMs = 200, horizon = 500): SleeperResult {
  const sim = new FairSim({ policy: "cfs", cfs: { ...cfsDefaults(1), sleeperClamp: clamp }, sampleVruntime: true });
  sim.add({ name: "A" });
  sim.add({ name: "B", run: 25, sleep: sleepMs, once: true });
  sim.advance(horizon);
  let wokeAt = 0;
  // B's first slice after its long gap.
  const bs = sim.slices.filter((x) => x.job === 1);
  for (let i = 1; i < bs.length; i++) if (bs[i]!.start - bs[i - 1]!.end >= sleepMs - 1e-6) wokeAt = bs[i]!.start;
  const longestRun = Math.max(0, ...bs.filter((x) => x.start >= wokeAt - 1e-6).map((x) => x.end - x.start));
  return { sim, wokeAt, longestRun };
}

// ---------------------------------------------------------------------------------------------
// cgroups
// ---------------------------------------------------------------------------------------------

export interface CgroupNode { name: string; weight: number; children?: CgroupNode[] }

/** cpu.weight: at each level, a child gets its weight divided by the sum of its siblings' weights. */
export function cgroupShares(root: CgroupNode): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (n: CgroupNode, share: number) => {
    if (!n.children?.length) { out.set(n.name, share); return; }
    const total = n.children.reduce((a, c) => a + c.weight, 0);
    for (const c of n.children) walk(c, (share * c.weight) / total);
  };
  walk(root, 1);
  return out;
}

/** Defaults of the two cgroup interfaces. */
export const CGROUP_DEFAULTS = { cpuWeight: 100, cpuShares: 1024 };

/** Two groups with equal cpu.weight: one task in A, `n` tasks in B. */
export const CGROUP_EXAMPLE = (n: number): CgroupNode => ({
  name: "root", weight: 100,
  children: [
    { name: "A", weight: 100, children: [{ name: "a0", weight: 100 }] },
    { name: "B", weight: 100, children: Array.from({ length: n }, (_, i) => ({ name: `b${i}`, weight: 100 })) },
  ],
});
