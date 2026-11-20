/**
 * Rust async runtimes: a model of Tokio's multi-thread scheduler, and a model of a task that hogs its worker.
 *
 * tokioSched() runs worker threads on the shared Runtime (one core each). The task queues are plain data that the
 * worker threads share, as in Tokio, where they are lock-free:
 * - each worker has a FIFO local queue of fixed capacity (Tokio: LOCAL_QUEUE_CAPACITY = 256). When it is full, half
 *   of it and the new task move to the global inject queue (Tokio: push_overflow);
 * - a LIFO slot holds the task that was woken or spawned last on this worker. It runs next, it cannot be stolen, and
 *   at most 3 LIFO polls run in a row (Tokio: MAX_LIFO_POLLS_PER_TICK = 3);
 * - every `globalInterval` ticks a worker checks the inject queue first, so it is not starved (Tokio tunes this
 *   interval itself; 61 was the old fixed default);
 * - an idle worker steals half of another worker's local queue, and parks when it finds nothing. Pushing work to a
 *   local queue wakes one parked worker.
 * The costs of a steal and of a spawn are MODEL INPUTS (STEAL_NS, SPAWN_NS). Park and unpark use the Runtime's wake
 * cost (also a model input).
 *
 * hogRun() is a current_thread runtime: tasks are Runtime threads on 1 core with no preemption (quantum 0), which is
 * exactly cooperative scheduling: a task gives up the thread only when it awaits something that is not ready or
 * yields. A heartbeat task wants to run every 1 ms; we measure how late it runs.
 */
import { Runtime, type RunResult, type Semaphore, type Thread } from "../runtime";
import { quantile } from "./eventloop";

/** Model inputs, ns. */
export const STEAL_NS = 200;
export const SPAWN_NS = 300;
/** Tokio constants (tokio 1.54: queue.rs, worker.rs, task/coop). */
export const TOKIO = { localQueueCapacity: 256, maxLifoPollsPerTick: 3, oldGlobalQueueInterval: 61, coopBudget: 128, maxBlockingThreads: 512 } as const;

export type Workload = "fanout" | "pingpong";

export interface SchedParams {
  workers: number;
  steal: boolean;
  lifo: boolean;
  capacity: number;
  globalInterval: number;
  workload: Workload;
  /** fanout: children spawned by the root task. pingpong: background tasks. */
  tasks: number;
  /** Poll time of a child or background task, µs. */
  pollUs: number;
  /** pingpong: polls of each background task (it yields after each poll). */
  bgPolls: number;
  /** pingpong: round trips. */
  rounds: number;
  seed: number;
  record: boolean;
}

export const SCHED_DEFAULTS: SchedParams = {
  workers: 4, steal: true, lifo: true, capacity: 256, globalInterval: 61, workload: "fanout", tasks: 64, pollUs: 50,
  bgPolls: 50, rounds: 20, seed: 3, record: true,
};

interface Seg { ns: number; spawn?: Task }
interface StepOut { segs: Seg[]; then: "done" | "yield" | "wait"; wake?: Task[]; onEnd?: (now: number) => void }
interface Task { id: number; name: string; step: (now: number) => StepOut }

export interface SchedResult {
  run: RunResult;
  makespan: number;
  polls: number[];
  steals: number;
  stolen: number;
  lifoPolls: number;
  globalPolls: number;
  overflows: number;
  parks: number;
  /** pingpong: round-trip times, ns. */
  rtt: number[];
}

export function tokioSched(over: Partial<SchedParams> = {}): SchedResult {
  const P = { ...SCHED_DEFAULTS, ...over };
  const W = P.workers;
  const rt = new Runtime({ cores: W, seed: P.seed, record: P.record });
  const local: Task[][] = Array.from({ length: W }, () => []);
  const lifo: (Task | null)[] = Array(W).fill(null);
  const inject: Task[] = [];
  const parked: boolean[] = Array(W).fill(false);
  const sems: Semaphore[] = Array.from({ length: W }, (_, i) => rt.semaphore(`park ${i}`, 0));
  const res = { polls: Array(W).fill(0) as number[], steals: 0, stolen: 0, lifoPolls: 0, globalPolls: 0, overflows: 0, parks: 0, rtt: [] as number[] };
  let nextId = 0, total = 0, finished = 0;
  const task = (name: string, step: Task["step"]): Task => ({ id: nextId++, name, step });

  // ---- the workload
  const poll = P.pollUs * 1_000;
  if (P.workload === "fanout") {
    const segs: Seg[] = [];
    for (let i = 0; i < P.tasks; i++) segs.push({ ns: SPAWN_NS, spawn: task(`child ${i}`, () => ({ segs: [{ ns: poll }], then: "done" })) });
    inject.push(task("root", () => ({ segs, then: "done" })));
    total = P.tasks + 1;
  } else {
    for (let i = 0; i < P.tasks; i++) {
      let left = P.bgPolls;
      inject.push(task(`bg ${i}`, () => ({ segs: [{ ns: poll }], then: --left > 0 ? "yield" : "done" })));
    }
    let round = 0, got = 0, sentAt = 0;
    const pong: Task = task("pong", () => ({ segs: [{ ns: 2_000 }], wake: [ping], then: ++got >= P.rounds ? "done" : "wait" }));
    const ping: Task = task("ping", (now) => {
      if (round > 0) res.rtt.push(now - sentAt);
      if (round >= P.rounds) return { segs: [{ ns: 2_000 }], then: "done" };
      round++;
      return { segs: [{ ns: 2_000 }], wake: [pong], then: "wait", onEnd: (t) => { sentAt = t; } };
    });
    inject.unshift(ping);
    total = P.tasks + 2;
  }

  // ---- scheduling
  const notify = (t: Thread) => {
    const w = parked.indexOf(true);
    if (w < 0) return;
    parked[w] = false;
    t.release(sems[w]!);
  };
  const pushLocal = (w: number, x: Task) => {
    const q = local[w]!;
    if (q.length >= P.capacity) {
      // Tokio's push_overflow: half the queue and the new task go to the inject queue.
      inject.push(...q.splice(0, Math.floor(P.capacity / 2)), x);
      res.overflows++;
    } else q.push(x);
  };
  /** schedule_local: a spawned or woken task goes to the LIFO slot; the old occupant goes to the local queue. */
  const schedule = (t: Thread, w: number, x: Task, isYield: boolean) => {
    let notifyNeeded = true;
    if (!isYield && P.lifo) {
      const prev = lifo[w];
      lifo[w] = x;
      notifyNeeded = !!prev;
      if (prev) pushLocal(w, prev);
    } else pushLocal(w, x);
    if (notifyNeeded) notify(t);
  };

  for (let w = 0; w < W; w++) {
    rt.spawn(`worker ${w}`, function* (t) {
      let tick = 0, lifoRun = 0;
      while (finished < total) {
        tick++;
        let x: Task | undefined;
        let from: "lifo" | "local" | "global" | "steal" = "local";
        if (tick % P.globalInterval === 0 && inject.length) { x = inject.shift(); from = "global"; }
        if (!x && lifo[w]) {
          if (lifoRun < TOKIO.maxLifoPollsPerTick) { x = lifo[w]!; lifo[w] = null; from = "lifo"; }
          else { pushLocal(w, lifo[w]!); lifo[w] = null; }
        }
        if (!x && local[w]!.length) x = local[w]!.shift();
        if (!x && inject.length) {
          // Take a batch from the inject queue: about a fair share, at most half a local queue.
          const n = Math.min(inject.length, Math.floor(inject.length / W) + 1, Math.max(1, Math.floor(P.capacity / 2)));
          const batch = inject.splice(0, n);
          x = batch.shift();
          for (const b of batch) pushLocal(w, b);
          from = "global";
        }
        if (!x && P.steal) {
          const start = Math.floor(t.rand() * W);
          for (let k = 0; k < W && !x; k++) {
            const v = (start + k) % W;
            if (v === w || local[v]!.length === 0) continue;
            yield* t.work(STEAL_NS, "steal");
            const q = local[v]!;
            if (!q.length) continue;
            const n = q.length - Math.floor(q.length / 2);
            const got = q.splice(0, n);
            res.steals++;
            res.stolen += n;
            x = got.shift();
            local[w]!.push(...got);
            from = "steal";
            if (local[w]!.length) notify(t);
          }
        }
        if (!x) {
          if (finished >= total) break;
          parked[w] = true;
          res.parks++;
          yield* t.acquire(sems[w]!);
          continue;
        }
        lifoRun = from === "lifo" ? lifoRun + 1 : 0;
        if (from === "lifo") res.lifoPolls++;
        if (from === "global") res.globalPolls++;
        res.polls[w]!++;
        const out = x.step(t.now());
        for (const s of out.segs) {
          yield* t.work(s.ns, x.name);
          if (s.spawn) schedule(t, w, s.spawn, false);
        }
        out.onEnd?.(t.now());
        for (const y of out.wake ?? []) schedule(t, w, y, false);
        if (out.then === "yield") { pushLocal(w, x); notify(t); }
        else if (out.then === "done") finished++;
      }
      // Wake the others so that they can see that all work is done.
      for (let k = 0; k < W; k++) if (parked[k]) { parked[k] = false; t.release(sems[k]!); }
    });
  }
  const run = rt.run();
  return { run, makespan: run.makespan, ...res };
}

// ---------------------------------------------------------------- a task that hogs the worker

export type HogMode = "nobudget" | "budget" | "blocking" | "spawn_blocking";

export interface HogParams {
  mode: HogMode;
  /** Operations per budget (Tokio: 128). */
  budget: number;
  /** Ready messages the busy task processes. */
  msgs: number;
  /** CPU per message, µs. */
  perMsgUs: number;
  /** The blocking call, ms. */
  blockMs: number;
  /** The heartbeat period and the run length, ms. */
  tickMs: number;
  durationMs: number;
  /** When the busy task starts, ms. */
  startMs: number;
  record: boolean;
}

export const HOG_DEFAULTS: HogParams = { mode: "nobudget", budget: 128, msgs: 5_000, perMsgUs: 2, blockMs: 10, tickMs: 1, durationMs: 20, startMs: 3.5, record: true };

/** Model input: a task switch inside one runtime thread (no kernel involved), ns. */
export const TASK_SWITCH_NS = 100;

export interface HogResult { run: RunResult; lateness: [number, number][]; maxLate: number; p50Late: number; busyDone: number }

export function hogRun(over: Partial<HogParams> = {}): HogResult {
  const P = { ...HOG_DEFAULTS, ...over };
  const pool = P.mode === "spawn_blocking";
  const rt = new Runtime({ cores: pool ? 2 : 1, quantumNs: 0, switchNs: TASK_SWITCH_NS, wakeNs: pool ? 5_000 : 0, seed: 1, record: P.record });
  const ms = 1_000_000;
  const lateness: [number, number][] = [];
  let busyDone = 0;
  const jobs = rt.channel<number>("blocking jobs", 1);
  const results = rt.channel<number>("results", 1);
  rt.spawn("heartbeat", function* (t) {
    for (let k = 1; k * P.tickMs <= P.durationMs; k++) {
      const due = k * P.tickMs * ms;
      if (t.now() < due) yield* t.sleep(due - t.now());
      lateness.push([due, t.now() - due]);
      yield* t.work(5_000, "tick");
    }
  });
  rt.spawn("busy task", function* (t) {
    yield* t.sleep(P.startMs * ms);
    if (P.mode === "blocking") yield* t.work(P.blockMs * ms, "blocking call");
    else if (pool) {
      yield* t.send(jobs, 1);
      yield* t.recv(results);
      yield* t.work(5_000, "use result");
    } else {
      for (let i = 0; i < P.msgs; i++) {
        // With a budget, the 129th recv returns Pending: the task goes to the back of the queue.
        if (P.mode === "budget" && i > 0 && i % P.budget === 0) yield* t.yieldNow();
        yield* t.work(P.perMsgUs * 1_000, "recv + handle");
      }
    }
    busyDone = t.now();
    if (pool) t.close(jobs);
  });
  if (pool) {
    rt.spawn("blocking pool", function* (t) {
      for (;;) {
        const r = yield* t.recv(jobs);
        if (!r.ok) break;
        yield* t.work(P.blockMs * ms, "blocking call");
        yield* t.send(results, 1);
      }
    });
  }
  const run = rt.run();
  const late = lateness.map((l) => l[1]);
  return { run, lateness, maxLate: Math.max(0, ...late), p50Late: quantile(late, 0.5), busyDone };
}
