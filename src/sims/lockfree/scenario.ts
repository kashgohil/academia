import { mulberry32 } from "../rng";
import { World, type Op, type Options, type Violation } from "./machine";
import { treiber, checkStack, stackContents } from "./stack";
import { msQueue, checkQueue, queueContents } from "./queue";

export interface Scenario { kind: "stack" | "queue"; initial: number[]; threads: Op[][] }

export function makeWorld(sc: Scenario, opts: Options): World {
  const w = new World(opts, sc.threads, sc.kind === "stack" ? treiber : msQueue);
  if (sc.kind === "stack") {
    const ps = sc.initial.map((v) => w.alloc(v));
    ps.forEach((p, i) => { w.nodes[p]!.state = "live"; w.nodes[p]!.next = { ptr: ps[i + 1] ?? 0, tag: 0 }; });
    w.roots.head = { ptr: ps[0] ?? 0, tag: 0 };
    w.checker = checkStack;
    w.contents = stackContents;
  } else {
    const ps = [w.alloc(0), ...sc.initial.map((v) => w.alloc(v))]; // dummy first
    ps.forEach((p, i) => { w.nodes[p]!.state = "live"; w.nodes[p]!.next = { ptr: ps[i + 1] ?? 0, tag: 0 }; });
    w.roots.head = { ptr: ps[0]!, tag: 0 };
    w.roots.tail = { ptr: ps[ps.length - 1]!, tag: 0 };
    w.checker = checkQueue;
    w.contents = queueContents;
  }
  w.pushed.push(...sc.initial);
  w.start();
  return w;
}

/** Re-runs a schedule from scratch (used for undo and for sharing a schedule). */
export function replay(sc: Scenario, opts: Options, schedule: number[]): World {
  const w = makeWorld(sc, opts);
  for (const t of schedule) w.step(t);
  return w;
}

export interface StressResult {
  runs: number;
  /** Runs in which each kind of violation occurred at least once. */
  byKind: Partial<Record<Violation["kind"], number>>;
  anyViolation: number;
  avgSteps: number;
  example: { schedule: number[]; violation: Violation } | null;
}

export function stress(sc: Scenario, opts: Options, runs: number, seed = 1, maxSteps = 4000): StressResult {
  const r = mulberry32(seed);
  const res: StressResult = { runs, byKind: {}, anyViolation: 0, avgSteps: 0, example: null };
  let steps = 0;
  for (let k = 0; k < runs; k++) {
    const w = makeWorld(sc, opts);
    const schedule: number[] = [];
    while (!w.done() && w.steps < maxSteps) {
      const ids = w.runnable();
      const t = ids[Math.floor(r() * ids.length)]!;
      schedule.push(t);
      w.step(t);
    }
    if (!w.done()) w.violate("timeout", `no completion after ${maxSteps} steps`);
    else w.finalize();
    steps += w.steps;
    const kinds = new Set(w.violations.map((v) => v.kind));
    kinds.forEach((kd) => (res.byKind[kd] = (res.byKind[kd] ?? 0) + 1));
    if (kinds.size) {
      res.anyViolation++;
      if (!res.example || schedule.length < res.example.schedule.length) {
        const first = w.violations[0]!;
        res.example = { schedule: schedule.slice(0, first.step), violation: first };
      }
    }
  }
  res.avgSteps = steps / runs;
  return res;
}

/**
 * Memory held by a reclamation scheme while one thread is stalled inside an operation.
 * T0 starts a pop and is never scheduled again after `stallAfter` steps; T1 and T2 churn.
 */
export function stallExperiment(opts: Options, churnOps = 120, stallAfter = 3, seed = 2): [number, number][] {
  const churn: Scenario["threads"][number] = Array.from({ length: churnOps }, (_, i) => (i % 2 ? { kind: "pop" } : { kind: "push", v: 100 + i }));
  const sc: Scenario = { kind: "stack", initial: [1, 2, 3, 4], threads: [[{ kind: "pop" }], churn, churn.map((o) => (o.kind === "push" ? { ...o, v: o.v + 1000 } : o))] };
  const w = makeWorld(sc, opts);
  const r = mulberry32(seed);
  for (let i = 0; i < stallAfter; i++) w.step(0);
  const series: [number, number][] = [];
  while (w.threads[1]!.next !== null || w.threads[2]!.next !== null) {
    const ids = w.runnable().filter((t) => t !== 0);
    w.step(ids[Math.floor(r() * ids.length)]!);
    if (w.steps % 10 === 0) series.push([w.steps, w.unreclaimed()]);
  }
  return series;
}
