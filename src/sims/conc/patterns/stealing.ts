/**
 * Three ways to share a loop of n items among P workers, on the shared Runtime (one worker thread per core):
 *
 * - "static": worker k gets the k-th contiguous block of n/P items. No coordination at all.
 * - "central": one shared queue of chunks of `grain` items, protected by one mutex (an adaptive mutex: spin, then
 *   park). Every chunk costs one trip through the lock.
 * - "steal": work stealing. Each worker has a deque. A worker splits its range in half, pushes the right half at the
 *   bottom of its own deque and goes on with the left half, until the range has at most `grain` items. When its deque
 *   is empty, it picks a random victim and steals the task at the top (the oldest, so the largest) of the victim's
 *   deque. The owner pops at the bottom (LIFO) by default; "fifo" makes it pop at the top as well.
 *
 * A deque operation happens at one instant of simulated time, so it is atomic here. A real deque needs the
 * Chase-Lev protocol for that (see the lesson). The costs below are MODEL INPUTS:
 * - itemNs: the work of one item (times its weight in a skewed loop),
 * - spawnNs: one split (create a task and push it),
 * - stealNs: one steal attempt (read the victim's top and bottom, then a CAS on its top: a few cache misses),
 * - queueNs: the time inside the central queue's lock, on top of the Runtime's lockNs and transferNs.
 */
import { Runtime, type RunResult, type RuntimeConfig } from "../runtime";

export type ShareMode = "static" | "central" | "steal";
export type Skew = "uniform" | "triangular";

export interface StealConfig {
  mode: ShareMode;
  workers: number;
  /** Items in the loop. */
  n: number;
  /** Items per leaf task (steal) or per chunk (central). */
  grain: number;
  skew: Skew;
  /** Which end the owner pops in "steal" mode. */
  owner: "lifo" | "fifo";
  itemNs: number;
  spawnNs: number;
  stealNs: number;
  queueNs: number;
  seed: number;
  record: boolean;
  /** Record a deque snapshot at each deque event (for a stepper; keep n / grain small). */
  trace: boolean;
  /** Runtime costs (switchNs, wakeNs, lockNs, transferNs). Defaults: the Runtime's DEFAULT_COSTS. */
  costs?: Partial<Pick<RuntimeConfig, "switchNs" | "wakeNs" | "lockNs" | "transferNs">>;
}

/** Model inputs of the work-stealing lesson. */
export const STEAL_DEFAULTS: StealConfig = {
  mode: "steal", workers: 8, n: 65_536, grain: 256, skew: "uniform", owner: "lifo",
  itemNs: 10, spawnNs: 50, stealNs: 300, queueNs: 50, seed: 1, record: true, trace: false,
};

export interface Range { lo: number; hi: number }

export interface DequeEvent {
  t: number;
  worker: number;
  kind: "push" | "pop" | "steal" | "fail" | "run" | "done";
  task?: Range;
  victim?: number;
  /** All deques after the event, top (oldest) first. */
  deques: Range[][];
  /** The range each worker runs now, or null. */
  running: (Range | null)[];
}

export interface StealResult {
  run: RunResult;
  makespan: number;
  /** Serial time: the sum of all item costs, with no splits or steals. */
  serialNs: number;
  speedup: number;
  /** speedup / workers. */
  efficiency: number;
  leaves: number;
  splits: number;
  steals: number;
  failedSteals: number;
  /** The longest any deque got. */
  maxDeque: number;
  /** Time workers spent in steal attempts that failed, summed. */
  idleStealNs: number;
  /** Lock statistics of the central queue (central mode). */
  lockWaitNs: number;
  events: DequeEvent[];
}

/** The cost of the items [lo, hi). Triangular: item i weighs 2i/n, so the mean weight is 1, as in the uniform loop. */
export function rangeCost(r: Range, n: number, skew: Skew, itemNs: number): number {
  const len = r.hi - r.lo;
  if (skew === "uniform") return len * itemNs;
  // Sum of 2i/n for i in [lo, hi) = (hi - lo)(lo + hi - 1) / n
  return (len * (r.lo + r.hi - 1) * itemNs) / n;
}

export function runSharing(cfg: Partial<StealConfig> = {}): StealResult {
  const c: StealConfig = { ...STEAL_DEFAULTS, ...cfg };
  const P = Math.max(1, Math.floor(c.workers));
  const rt = new Runtime({ cores: P, seed: c.seed, record: c.record, ...c.costs });
  const cost = (r: Range) => rangeCost(r, c.n, c.skew, c.itemNs);
  const serialNs = cost({ lo: 0, hi: c.n });
  const label = (r: Range) => `${r.lo}–${r.hi}`;
  let leaves = 0, splits = 0, steals = 0, failed = 0, maxDeque = 0, idleSteal = 0;
  const events: DequeEvent[] = [];
  const deques: Range[][] = Array.from({ length: P }, () => []);
  const running: (Range | null)[] = new Array(P).fill(null);
  const snap = (t: number, worker: number, kind: DequeEvent["kind"], task?: Range, victim?: number) => {
    if (c.trace) events.push({ t, worker, kind, task, victim, deques: deques.map((d) => d.map((r) => ({ ...r }))), running: running.map((r) => (r ? { ...r } : null)) });
  };
  let lockWaitNs = 0;

  if (c.mode === "static") {
    for (let k = 0; k < P; k++) {
      const r = { lo: Math.floor((k * c.n) / P), hi: Math.floor(((k + 1) * c.n) / P) };
      rt.spawn(`W${k}`, function* (t) {
        if (r.hi > r.lo) {
          leaves++;
          yield* t.work(cost(r), label(r));
        }
      });
    }
  } else if (c.mode === "central") {
    const q = rt.mutex("queue", { wait: "adaptive" });
    let next = 0;
    for (let k = 0; k < P; k++) {
      rt.spawn(`W${k}`, function* (t) {
        for (;;) {
          yield* t.lock(q);
          yield* t.work(c.queueNs, "queue");
          const lo = next;
          next = Math.min(c.n, next + c.grain);
          t.unlock(q);
          if (lo >= c.n) return;
          const r = { lo, hi: next };
          leaves++;
          yield* t.work(cost(r), label(r));
        }
      });
    }
  } else {
    let remaining = c.n;
    deques[0]!.push({ lo: 0, hi: c.n });
    maxDeque = 1;
    for (let k = 0; k < P; k++) {
      rt.spawn(`W${k}`, function* (t) {
        const mine = deques[k]!;
        for (;;) {
          let task: Range | undefined = c.owner === "lifo" ? mine.pop() : mine.shift();
          if (task) snap(t.now(), k, "pop", task);
          if (!task) {
            if (remaining === 0) return;
            if (P === 1) return;
            let v = Math.floor(t.rand() * (P - 1));
            if (v >= k) v++;
            yield* t.work(c.stealNs, "steal");
            task = deques[v]!.shift();
            if (!task) {
              failed++;
              idleSteal += c.stealNs;
              snap(t.now(), k, "fail", undefined, v);
              continue;
            }
            steals++;
            snap(t.now(), k, "steal", task, v);
          }
          while (task.hi - task.lo > c.grain) {
            const mid: number = task.lo + Math.floor((task.hi - task.lo) / 2);
            running[k] = task;
            yield* t.work(c.spawnNs, "split");
            splits++;
            const right = { lo: mid, hi: task.hi };
            mine.push(right);
            maxDeque = Math.max(maxDeque, mine.length);
            task = { lo: task.lo, hi: mid };
            snap(t.now(), k, "push", right);
          }
          running[k] = task;
          snap(t.now(), k, "run", task);
          leaves++;
          yield* t.work(cost(task), label(task));
          remaining -= task.hi - task.lo;
          running[k] = null;
          snap(t.now(), k, "done", task);
        }
      });
    }
  }
  const run = rt.run();
  if (c.mode === "central") lockWaitNs = run.mutexes[0]?.waitNs ?? 0;
  const makespan = run.makespan;
  const speedup = serialNs / makespan;
  return {
    run, makespan, serialNs, speedup, efficiency: speedup / P, leaves, splits, steals, failedSteals: failed, maxDeque,
    idleStealNs: idleSteal, lockWaitNs, events,
  };
}
