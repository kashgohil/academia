/**
 * An N-core scheduler with one tick per millisecond.
 *
 * The workload is closed: a fixed set of tasks alternate between a CPU burst and a sleep, both drawn from
 * exponential distributions by a seeded PRNG. A woken task goes back to the CPU where it last ran.
 *
 * Costs are model inputs, not measurements:
 * - cacheRefill: CPU time lost when a task runs on a different CPU from the last time.
 * - numaPenalty: extra CPU time lost when the new CPU is on a different NUMA node.
 * - lockCost: CPU time for one dispatch per CPU that shares the queue lock.
 *
 * numaRemoteCost derives the NUMA penalty from the memory latencies in src/sims/numa.ts.
 */
import { NUMA_DEFAULTS } from "../../numa";
import { mulberry32, type Rng } from "../../rng";
import { EPS, pushSlice, type Slice, type Trace } from "./types";

export type QueueMode = "per-cpu" | "single";
export type Placement = "spread" | "pile";

export interface McConfig {
  cpus: number;
  /** NUMA nodes. CPUs split evenly between them. */
  nodes: number;
  tasks: number;
  meanRun: number;
  meanSleep: number;
  quantum: number;
  queue: QueueMode;
  placement: Placement;
  /** Balancer period in ms. 0 turns the periodic balancer off. */
  balanceInterval: number;
  /** The balancer moves a task if the load difference is at least this. */
  threshold: number;
  /** An idle CPU pulls work at once (newidle balance, or work stealing). */
  steal: boolean;
  /**
   * The part of wake-ups that go to CPU 0, not to the task's previous CPU. This models a server thread
   * on CPU 0 that wakes its workers, and a wake-affine rule that pulls each worker to the waker's CPU.
   */
  wakeAffine: number;
  /** Scheduling domains: balance inside a node at each interval, across nodes four times less often. */
  domains: boolean;
  cacheRefill: number;
  numaPenalty: number;
  lockCost: number;
  seed: number;
}

export const MC_DEFAULT: McConfig = {
  cpus: 8, nodes: 2, tasks: 16, meanRun: 20, meanSleep: 10, quantum: 10, queue: "per-cpu", placement: "spread",
  balanceInterval: 16, threshold: 2, steal: false, wakeAffine: 0, domains: false, cacheRefill: 0, numaPenalty: 0, lockCost: 0, seed: 7,
};

/** How much slower the domain-level balance runs than the node-level one. */
export const DOMAIN_FACTOR = 4;

/**
 * Time lost if a task runs on a remote node for `remoteMs` before its pages follow. It runs at
 * latLocal / latRemote of its speed in that time, with the two latencies from numa.ts.
 */
export const numaRemoteCost = (remoteMs: number) => remoteMs * (1 - NUMA_DEFAULTS.latLocal / NUMA_DEFAULTS.latRemote);

export interface McTask {
  id: number;
  state: "queued" | "running" | "sleeping";
  cpu: number;
  /** The CPU where the task last ran. -1 before its first run. */
  lastCpu: number;
  runLeft: number;
  wakeAt: number;
  debt: number;
}

export interface McCpu { id: number; node: number; queue: McTask[]; running: McTask | null; quantumLeft: number; busy: number }

export interface McStats {
  time: number;
  useful: number;
  penalty: number;
  idle: number;
  bursts: number;
  migrations: number;
  crossNode: number;
  balancerMoves: number;
  steals: number;
  imbalanceSum: number;
}

export class Multicore {
  readonly cfg: McConfig;
  readonly cpus: McCpu[];
  readonly tasks: McTask[];
  /** The shared queue in "single" mode. */
  readonly global: McTask[] = [];
  readonly stats: McStats = { time: 0, useful: 0, penalty: 0, idle: 0, bursts: 0, migrations: 0, crossNode: 0, balancerMoves: 0, steals: 0, imbalanceSum: 0 };
  /** Useful CPU time per task, for the "work conserved" test. */
  readonly progress: number[];
  /** Recorded slices, if the constructor was asked to record. */
  readonly slices: Slice[] = [];
  private readonly rng: Rng;
  private readonly record: boolean;

  constructor(cfg: McConfig, opts: { record?: boolean } = {}) {
    this.cfg = cfg;
    this.record = opts.record ?? false;
    this.rng = mulberry32(cfg.seed);
    this.cpus = Array.from({ length: cfg.cpus }, (_, id) => ({ id, node: Math.floor((id * cfg.nodes) / cfg.cpus), queue: [], running: null, quantumLeft: 0, busy: 0 }));
    this.tasks = Array.from({ length: cfg.tasks }, (_, id): McTask => ({ id, state: "queued", cpu: 0, lastCpu: -1, runLeft: this.exp(cfg.meanRun), wakeAt: 0, debt: 0 }));
    this.progress = this.tasks.map(() => 0);
    for (const t of this.tasks) {
      const c = cfg.placement === "pile" ? 0 : t.id % cfg.cpus;
      t.cpu = c;
      if (cfg.queue === "single") this.global.push(t);
      else this.cpus[c]!.queue.push(t);
    }
  }

  private exp(mean: number): number {
    return mean <= 0 ? 0 : -mean * Math.log(1 - this.rng());
  }

  /** Runnable tasks on a CPU: the running one plus its queue. */
  load(c: McCpu): number { return c.queue.length + (c.running ? 1 : 0); }

  /** Moves every queued task to CPU 0, to create an imbalance by hand. */
  pile(): void {
    if (this.cfg.queue === "single") return;
    for (const c of this.cpus) {
      if (c.id === 0) continue;
      while (c.queue.length) {
        const t = c.queue.shift()!;
        t.cpu = 0;
        this.cpus[0]!.queue.push(t);
      }
    }
  }

  private moveQueued(from: McCpu, to: McCpu): boolean {
    const t = from.queue.pop();
    if (!t) return false;
    t.cpu = to.id;
    to.queue.push(t);
    this.stats.balancerMoves++;
    return true;
  }

  private balanceSet(set: McCpu[]): void {
    for (let guard = 0; guard < 2 * this.tasks.length; guard++) {
      let hi = set[0]!, lo = set[0]!;
      for (const c of set) {
        if (this.load(c) > this.load(hi)) hi = c;
        if (this.load(c) < this.load(lo)) lo = c;
      }
      if (this.load(hi) - this.load(lo) < this.cfg.threshold) return;
      if (!this.moveQueued(hi, lo)) return;
    }
  }

  private balanceNodes(): void {
    const nodes = Array.from({ length: this.cfg.nodes }, (_, n) => this.cpus.filter((c) => c.node === n));
    const nodeLoad = (s: McCpu[]) => s.reduce((a, c) => a + this.load(c), 0);
    for (let guard = 0; guard < 2 * this.tasks.length; guard++) {
      let hi = nodes[0]!, lo = nodes[0]!;
      for (const s of nodes) {
        if (nodeLoad(s) > nodeLoad(hi)) hi = s;
        if (nodeLoad(s) < nodeLoad(lo)) lo = s;
      }
      if (nodeLoad(hi) - nodeLoad(lo) < this.cfg.threshold * 2) return; // crossing a node must pay for itself
      const from = hi.reduce((a, c) => (this.load(c) > this.load(a) ? c : a));
      const to = lo.reduce((a, c) => (this.load(c) < this.load(a) ? c : a));
      if (!this.moveQueued(from, to)) return;
    }
  }

  private balance(): void {
    const iv = this.cfg.balanceInterval;
    const now = Math.round(this.stats.time);
    if (iv > 0 && this.cfg.queue === "per-cpu") {
      if (!this.cfg.domains) {
        if (now % Math.round(iv) === 0) this.balanceSet(this.cpus);
      } else {
        if (now % Math.round(iv) === 0) {
          for (let n = 0; n < this.cfg.nodes; n++) this.balanceSet(this.cpus.filter((c) => c.node === n));
        }
        if (this.cfg.nodes > 1 && now % Math.round(iv * DOMAIN_FACTOR) === 0) this.balanceNodes();
      }
    }
  }

  private steal(c: McCpu): void {
    let victim: McCpu | null = null;
    for (const o of this.cpus) {
      if (o === c || o.queue.length === 0) continue;
      if (!victim) { victim = o; continue; }
      const better = this.cfg.domains
        ? (o.node === c.node ? 1 : 0) - (victim.node === c.node ? 1 : 0) || o.queue.length - victim.queue.length
        : o.queue.length - victim.queue.length;
      if (better > 0) victim = o;
    }
    if (victim && this.moveQueued(victim, c)) { this.stats.steals++; this.stats.balancerMoves--; }
  }

  private dispatch(c: McCpu): McTask | null {
    const single = this.cfg.queue === "single";
    if (!single && c.queue.length === 0 && this.cfg.steal) this.steal(c);
    const q = single ? this.global : c.queue;
    const t = q.shift();
    if (!t) return null;
    t.state = "running";
    t.cpu = c.id;
    let debt = this.cfg.lockCost * (single ? this.cfg.cpus : 1);
    if (t.lastCpu !== -1 && t.lastCpu !== c.id) {
      this.stats.migrations++;
      debt += this.cfg.cacheRefill;
      if (this.cpus[t.lastCpu]!.node !== c.node) {
        this.stats.crossNode++;
        debt += this.cfg.numaPenalty;
      }
    }
    t.lastCpu = c.id;
    t.debt = debt;
    c.running = t;
    c.quantumLeft = this.cfg.quantum;
    return t;
  }

  /** Advances the machine by 1 ms. */
  tick(): void {
    const s = this.stats;
    for (const t of this.tasks) {
      if (t.state === "sleeping" && t.wakeAt <= s.time + EPS) {
        t.state = "queued";
        t.runLeft = this.exp(this.cfg.meanRun);
        if (this.cfg.queue === "single") this.global.push(t);
        else {
          if (this.cfg.wakeAffine > 0 && this.rng() < this.cfg.wakeAffine) t.cpu = 0;
          this.cpus[t.cpu]!.queue.push(t);
        }
      }
    }
    this.balance();
    for (const c of this.cpus) {
      let cap = 1;
      while (cap > EPS) {
        if (!c.running && !this.dispatch(c)) { s.idle += cap; cap = 0; break; }
        const t = c.running!;
        if (t.debt > EPS) {
          const d = Math.min(t.debt, cap);
          if (this.record) pushSlice(this.slices, { start: s.time + 1 - cap, end: s.time + 1 - cap + d, job: t.id, cpu: c.id, kind: "switch" });
          t.debt -= d;
          cap -= d;
          s.penalty += d;
          c.busy += d;
          c.quantumLeft -= d;
          if (cap <= EPS) break;
        }
        const d = Math.min(t.runLeft, cap, Math.max(c.quantumLeft, EPS * 2));
        if (this.record) pushSlice(this.slices, { start: s.time + 1 - cap, end: s.time + 1 - cap + d, job: t.id, cpu: c.id, kind: "run" });
        t.runLeft -= d;
        cap -= d;
        s.useful += d;
        this.progress[t.id]! += d;
        c.busy += d;
        c.quantumLeft -= d;
        if (t.runLeft <= EPS) {
          t.state = "sleeping";
          t.wakeAt = s.time + 1 - cap + this.exp(this.cfg.meanSleep);
          c.running = null;
          s.bursts++;
        } else if (c.quantumLeft <= EPS) {
          const single = this.cfg.queue === "single";
          const q = single ? this.global : c.queue;
          if (q.length > 0) {
            t.state = "queued";
            q.push(t);
            c.running = null;
          } else {
            c.quantumLeft = this.cfg.quantum;
          }
        }
      }
    }
    let hi = 0, lo = Infinity;
    for (const c of this.cpus) {
      const l = this.load(c);
      if (l > hi) hi = l;
      if (l < lo) lo = l;
    }
    s.imbalanceSum += hi - lo;
    s.time += 1;
  }

  /** The recorded history as a Trace. A closed workload has no finish events. */
  trace(): Trace {
    const jobs = this.tasks.map((t) => ({ id: t.id, name: `T${t.id}`, arrival: 0, burst: this.progress[t.id]! }));
    return { jobs, slices: this.slices, events: [], end: this.stats.time, cpus: this.cfg.cpus };
  }

  /** Every task must be in exactly one place. Returns problems; empty means sound. */
  problems(): string[] {
    const out: string[] = [];
    const seen = new Map<number, number>();
    const see = (t: McTask) => seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
    for (const c of this.cpus) { c.queue.forEach(see); if (c.running) see(c.running); }
    this.global.forEach(see);
    for (const t of this.tasks) {
      const n = seen.get(t.id) ?? 0;
      if (t.state === "sleeping" && n !== 0) out.push(`sleeping task ${t.id} is in a queue`);
      if (t.state !== "sleeping" && n !== 1) out.push(`task ${t.id} is in ${n} places`);
    }
    const s = this.stats;
    if (Math.abs(s.useful + s.penalty + s.idle - s.time * this.cfg.cpus) > 1e-6) out.push("CPU time does not add up");
    if (Math.abs(this.progress.reduce((a, b) => a + b, 0) - s.useful) > 1e-6) out.push("work done does not add up");
    return out;
  }
}

export interface McResult {
  /** Useful CPU time as a fraction of all CPU time. */
  useful: number;
  penalty: number;
  idle: number;
  /** CPU bursts finished per second. */
  throughput: number;
  migrationsPerSec: number;
  crossNodePerSec: number;
  meanImbalance: number;
}

export function resultOf(m: Multicore): McResult {
  const s = m.stats, cap = s.time * m.cfg.cpus;
  return {
    useful: s.useful / cap,
    penalty: s.penalty / cap,
    idle: s.idle / cap,
    throughput: (s.bursts / s.time) * 1000,
    migrationsPerSec: (s.migrations / s.time) * 1000,
    crossNodePerSec: (s.crossNode / s.time) * 1000,
    meanImbalance: s.imbalanceSum / s.time,
  };
}

/** Runs one configuration for `horizon` ms. */
export function runMulticore(cfg: McConfig, horizon = 4000): McResult {
  const m = new Multicore(cfg);
  for (let i = 0; i < horizon; i++) m.tick();
  return resultOf(m);
}

/** Balance periods for the cost plot, in ms. */
export const BALANCE_SWEEP = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];

/**
 * The workload of the cost plot. Tasks sleep often, so small imbalances come and go by themselves.
 * Some wake-ups pull a task to CPU 0, so a large imbalance slowly builds up and needs a balancer.
 */
export const COST_WORKLOAD: McConfig = { ...MC_DEFAULT, tasks: 20, meanRun: 4, meanSleep: 4, wakeAffine: 0.05 };

/** The model inputs of the cost plot's default state. */
export const COST_INPUTS = { refill: 1, remoteMs: 10 };

/** The configuration of the live demo, before the learner changes it. */
export const DEMO_MC: McConfig = { ...MC_DEFAULT, placement: "pile", balanceInterval: 0, cacheRefill: 0.5, lockCost: 0.02 };

/** One point of the cost plot, averaged over `seeds` seeds, so that noise does not hide the shape. */
export function balancePoint(cfg: McConfig, interval: number, seeds = 3, horizon = 4000): McResult {
  const rs = Array.from({ length: seeds }, (_, i) => runMulticore({ ...cfg, balanceInterval: interval, seed: cfg.seed + i }, horizon));
  const avg = (f: (r: McResult) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  return {
    useful: avg((r) => r.useful), penalty: avg((r) => r.penalty), idle: avg((r) => r.idle), throughput: avg((r) => r.throughput),
    migrationsPerSec: avg((r) => r.migrationsPerSec), crossNodePerSec: avg((r) => r.crossNodePerSec), meanImbalance: avg((r) => r.meanImbalance),
  };
}
