/**
 * Event loops: a step model of the JavaScript event loop (the HTML model of a browser, and Node's libuv phases), and a
 * server on one loop thread, built on the shared Runtime, that shows what one slow callback does to every request.
 *
 * The step model runs one whole callback per step, as a real loop does: a callback is never interrupted. It keeps the
 * queues that the specifications name: tasks (timers and I/O), the microtask queue (promise jobs and queueMicrotask),
 * and in Node also the nextTick queue and the check queue (setImmediate). Time is in ms and moves only when a
 * callback does synchronous work (`busy`) or when the loop waits for the next timer or I/O completion.
 */
import { Runtime, type Channel, type Thread } from "../runtime";

// ---------------------------------------------------------------- the step model

export type Stmt =
  | { k: "log"; text: string }
  | { k: "timeout"; ms: number; cb: Cb }
  | { k: "micro"; cb: Cb }
  | { k: "tick"; cb: Cb }
  | { k: "immediate"; cb: Cb }
  | { k: "io"; ms: number; cb: Cb }
  | { k: "busy"; ms: number };

/** A callback: a name for the views, and its body. */
export interface Cb { name: string; body: Stmt[] }

export type LoopMode = "browser" | "node";

export interface LoopProgram {
  id: string;
  title: string;
  mode: LoopMode;
  /** The JavaScript source, for display. */
  code: string[];
  main: Cb;
}

/** The queues a callback can wait in. "script" is the main script, "wait" an idle wait. */
export type QueueName = "script" | "tick" | "micro" | "timer" | "io" | "immediate" | "wait";

export interface QItem { id: number; cb: Cb; due: number }

export interface LoopState {
  t: number;
  /** Where the loop is: "script", "microtasks", or a phase ("timers", "poll", "check"; "task" in a browser). */
  phase: string;
  /** The callback on the call stack, or null. */
  running: string | null;
  tick: QItem[];
  micro: QItem[];
  /** Timers, sorted by due time and then by creation. */
  timers: QItem[];
  /** I/O in flight, sorted by completion time. */
  io: QItem[];
  immediate: QItem[];
  out: string[];
}

export interface LoopFrame {
  state: LoopState;
  /** What the loop did to reach this frame. */
  action: string;
  /** The rule that made this the next step. */
  rule: string;
  /** The queue item the loop ran (or "wait" for an idle wait). Undefined for the first frame. */
  pick?: { q: QueueName; id: number };
}

const clone = (s: LoopState): LoopState => ({
  ...s, tick: s.tick.slice(), micro: s.micro.slice(), timers: s.timers.slice(), io: s.io.slice(), immediate: s.immediate.slice(), out: s.out.slice(),
});

const byDue = (a: QItem, b: QItem) => a.due - b.due || a.id - b.id;

/** Node turns a timeout below 1 ms into 1 ms. Browsers allow 0 (and clamp nested timers to 4 ms, which we leave out). */
export const timeoutDelay = (mode: LoopMode, ms: number) => (mode === "node" ? Math.max(1, ms) : Math.max(0, ms));

/**
 * Runs a program and returns one frame per callback run or idle wait. Frame 0 is the state before the main script.
 * `maxFrames` stops a program that never ends (a microtask that queues itself forever).
 */
export function runLoop(p: LoopProgram, maxFrames = 200): LoopFrame[] {
  let seq = 0;
  const s: LoopState = { t: 0, phase: "script", running: null, tick: [], micro: [], timers: [], io: [], immediate: [], out: [] };
  const frames: LoopFrame[] = [{ state: clone(s), action: "The main script is about to run.", rule: "The main script is the first task." }];
  const push = (action: string, rule: string, pick: LoopFrame["pick"]) => {
    frames.push({ state: clone(s), action, rule, pick });
    return frames.length < maxFrames;
  };
  const exec = (cb: Cb) => {
    s.running = cb.name;
    for (const st of cb.body) {
      if (st.k === "log") s.out.push(st.text);
      else if (st.k === "busy") s.t += st.ms;
      else if (st.k === "timeout") { s.timers.push({ id: seq++, cb: st.cb, due: s.t + timeoutDelay(p.mode, st.ms) }); s.timers.sort(byDue); }
      else if (st.k === "io") { s.io.push({ id: seq++, cb: st.cb, due: s.t + st.ms }); s.io.sort(byDue); }
      else if (st.k === "micro") s.micro.push({ id: seq++, cb: st.cb, due: s.t });
      else if (st.k === "tick") s.tick.push({ id: seq++, cb: st.cb, due: s.t });
      else s.immediate.push({ id: seq++, cb: st.cb, due: s.t });
    }
  };
  const run = (q: QueueName, it: QItem, action: string, rule: string) => {
    exec(it.cb);
    const ok = push(action, rule, { q, id: it.id });
    s.running = null;
    return ok;
  };
  /**
   * The microtask checkpoint. In Node the nextTick queue drains first, then the whole promise job queue (V8 runs
   * every job, also jobs queued meanwhile, before Node looks at nextTick again), and this repeats until both are empty.
   */
  const drain = (): boolean => {
    const back = s.phase;
    let inPromiseJobs = false;
    for (;;) {
      if (p.mode === "node" && s.tick.length && !(inPromiseJobs && s.micro.length)) {
        inPromiseJobs = false;
        s.phase = "microtasks";
        const it = s.tick.shift()!;
        if (!run("tick", it, `Run the nextTick callback "${it.cb.name}".`, "Node empties the nextTick queue before it runs any promise job.")) return false;
        continue;
      }
      if (s.micro.length) {
        inPromiseJobs = true;
        s.phase = "microtasks";
        const it = s.micro.shift()!;
        if (!run("micro", it, `Run the microtask "${it.cb.name}".`, p.mode === "node" ? "Node runs all nextTick callbacks, then all promise jobs, and repeats until both queues are empty." : "After each task, the loop runs microtasks until the microtask queue is empty.")) return false;
        continue;
      }
      s.phase = back;
      return true;
    }
  };
  const wait = (to: number, why: string) => {
    s.t = to;
    return push(why, "Nothing is ready, so the loop sleeps until the next timer or I/O completion.", { q: "wait", id: -1 });
  };

  if (!run("script", { id: -1, cb: p.main, due: 0 }, "Run the main script.", "The main script is the first task.")) return frames;
  if (!drain()) return frames;

  if (p.mode === "browser") {
    for (;;) {
      s.phase = "task";
      const tasks = [...s.timers.map((x) => ({ q: "timer" as const, x })), ...s.io.map((x) => ({ q: "io" as const, x }))].sort((a, b) => byDue(a.x, b.x));
      const next = tasks[0];
      if (!next) break;
      if (next.x.due > s.t) { if (!wait(next.x.due, `Idle until ${next.x.due} ms.`)) return frames; continue; }
      (next.q === "timer" ? s.timers : s.io).shift();
      if (!run(next.q, next.x, `Take the oldest ready task: "${next.x.cb.name}".`, "With the microtask queue empty, the loop takes one task: the ready one that has waited longest.")) return frames;
      if (!drain()) return frames;
    }
    s.phase = "done";
    frames.push({ state: clone(s), action: "All queues are empty. The loop has nothing to do.", rule: "" });
    return frames;
  }

  // Node: the libuv phases timers → (pending, idle, prepare) → poll → check → close.
  while (s.timers.length || s.io.length || s.immediate.length) {
    s.phase = "timers";
    const due = s.timers.filter((x) => x.due <= s.t);
    for (const it of due) {
      s.timers.splice(s.timers.indexOf(it), 1);
      if (!run("timer", it, `Timers phase: run the due timer "${it.cb.name}".`, "The timers phase runs every timer that is due when the phase starts.")) return frames;
      if (!drain()) return frames;
    }
    s.phase = "poll";
    // Poll blocks only if no setImmediate callback waits; it wakes for I/O or for the next timer.
    if (!s.immediate.length && !s.io.some((x) => x.due <= s.t)) {
      const nextT = s.timers[0]?.due ?? Infinity, nextIo = s.io[0]?.due ?? Infinity;
      const to = Math.min(nextT, nextIo);
      if (to === Infinity) break;
      if (to > s.t && !wait(to, `Poll phase: block in epoll_wait until ${to} ms.`)) return frames;
    }
    const ready = s.io.filter((x) => x.due <= s.t);
    for (const it of ready) {
      s.io.splice(s.io.indexOf(it), 1);
      if (!run("io", it, `Poll phase: run the I/O callback "${it.cb.name}".`, "The poll phase runs the callbacks of I/O that has completed.")) return frames;
      if (!drain()) return frames;
    }
    s.phase = "check";
    const imm = s.immediate.splice(0);
    for (const it of imm) {
      if (!run("immediate", it, `Check phase: run the setImmediate callback "${it.cb.name}".`, "The check phase comes right after poll. It runs the setImmediate callbacks.")) return frames;
      if (!drain()) return frames;
    }
  }
  s.phase = "done";
  frames.push({ state: clone(s), action: "No timers, I/O or immediates are left, so the loop exits and the process ends.", rule: "" });
  return frames;
}

/** The queue items a learner can pick at a state: the head of each queue that is not empty, and "wait". */
export function candidates(s: LoopState, mode: LoopMode): { q: QueueName; id: number; name: string }[] {
  const c: { q: QueueName; id: number; name: string }[] = [];
  const head = (q: QueueName, a: QItem[]) => { if (a[0]) c.push({ q, id: a[0].id, name: a[0].cb.name }); };
  if (mode === "node") head("tick", s.tick);
  head("micro", s.micro);
  head("timer", s.timers);
  head("io", s.io);
  if (mode === "node") head("immediate", s.immediate);
  return c;
}

/** True if picking queue item (q, id) at frame k is what a conforming loop does next. */
export function isNext(frames: LoopFrame[], k: number, q: QueueName, id: number) {
  const n = frames[k + 1];
  if (!n?.pick) return false;
  if (n.pick.q === "wait") {
    // After an idle wait, the loop runs the item it waited for.
    const m = frames[k + 2];
    return !!m?.pick && m.pick.q === q && m.pick.id === id;
  }
  return n.pick.q === q && n.pick.id === id;
}

// ---------------------------------------------------------------- example programs

const log = (text: string): Stmt => ({ k: "log", text });
const cb = (name: string, ...body: Stmt[]): Cb => ({ name, body });

/** A microtask that queues another one, `n` times. */
const microChain = (n: number, i = 1): Cb => cb(`m${i}`, log(`m${i}`), ...(i < n ? [{ k: "micro" as const, cb: microChain(n, i + 1) }] : []));

export const LOOP_PROGRAMS: LoopProgram[] = [
  {
    id: "order", title: "Promises and a 0 ms timer", mode: "browser",
    code: [
      'console.log("A");',
      'setTimeout(() => console.log("B"), 0);',
      "Promise.resolve()",
      '  .then(() => console.log("C"))',
      '  .then(() => console.log("D"));',
      'queueMicrotask(() => console.log("E"));',
      'console.log("F");',
    ],
    main: cb("script", log("A"), { k: "timeout", ms: 0, cb: cb("timeout B", log("B")) }, { k: "micro", cb: cb("then C", log("C"), { k: "micro", cb: cb("then D", log("D")) }) }, { k: "micro", cb: cb("micro E", log("E")) }, log("F")),
  },
  {
    id: "flood", title: "Microtasks that queue microtasks", mode: "browser",
    code: [
      'setTimeout(() => console.log("timer"), 0);',
      "let i = 0;",
      "function again() {",
      '  console.log("m" + ++i);',
      "  if (i < 6) queueMicrotask(again);",
      "}",
      "queueMicrotask(again);",
    ],
    main: cb("script", { k: "timeout", ms: 0, cb: cb("timer", log("timer")) }, { k: "micro", cb: microChain(6) }),
  },
  {
    id: "tick", title: "Node: nextTick, promises, timers", mode: "node",
    code: [
      'setTimeout(() => console.log("timeout"), 0);',
      "Promise.resolve().then(() => {",
      '  console.log("promise");',
      '  process.nextTick(() => console.log("tick 2"));',
      "});",
      'process.nextTick(() => console.log("tick 1"));',
      'console.log("sync");',
    ],
    main: cb("script", { k: "timeout", ms: 0, cb: cb("timeout", log("timeout")) }, { k: "micro", cb: cb("then", log("promise"), { k: "tick", cb: cb("tick 2", log("tick 2")) }) }, { k: "tick", cb: cb("tick 1", log("tick 1")) }, log("sync")),
  },
  {
    id: "phases", title: "Node: setImmediate in an I/O callback", mode: "node",
    code: [
      "fs.readFile(path, () => { // 3 ms",
      '  setTimeout(() => console.log("timeout"), 0);',
      '  setImmediate(() => console.log("immediate"));',
      '  process.nextTick(() => console.log("tick"));',
      "});",
    ],
    main: cb("script", { k: "io", ms: 3, cb: cb("readFile cb", { k: "timeout", ms: 0, cb: cb("timeout", log("timeout")) }, { k: "immediate", cb: cb("immediate", log("immediate")) }, { k: "tick", cb: cb("tick", log("tick")) }) }),
  },
];

// ---------------------------------------------------------------- a server on one loop thread

export type LoopStrategy = "inline" | "chunked" | "offload";

export interface LoopServerParams {
  /** Requests per ms (Poisson arrivals). */
  rate: number;
  /** CPU time of a normal handler, in µs. */
  handlerUs: number;
  /** CPU time of the slow part of a slow request, in ms. 0: no slow requests. */
  slowMs: number;
  /** Every n-th request is slow. */
  slowEvery: number;
  strategy: LoopStrategy;
  /** Slice length for "chunked", in ms. */
  sliceMs: number;
  /** Worker threads for "offload". */
  workers: number;
  /** Requests to send. */
  requests: number;
  seed: number;
  record: boolean;
}

export const LOOP_SERVER_DEFAULTS: LoopServerParams = {
  rate: 1, handlerUs: 100, slowMs: 20, slowEvery: 40, strategy: "inline", sliceMs: 1, workers: 2, requests: 200, seed: 7, record: true,
};

export interface ReqRecord { id: number; arrive: number; done: number; slow: boolean }

export interface LoopServerResult {
  reqs: ReqRecord[];
  run: ReturnType<Runtime["run"]>;
  /** Latency percentiles of the fast requests, in ns. */
  fast: { p50: number; p99: number; max: number };
  /** Mean latency of the slow requests, in ns. */
  slowMean: number;
}

/** The q-quantile of a list (nearest rank). */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const a = xs.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))]!;
}

interface Req { id: number; arrive: number; slow: boolean }
type LoopTask = { req: Req; kind: "handle" | "slice" | "finish"; left: number };

/**
 * One event-loop thread serves requests. A client thread sends them over a channel (the socket), and a slow request
 * needs `slowMs` of CPU. "inline" runs it in the callback, "chunked" runs it in slices and puts the rest at the back of
 * the loop's queue, and "offload" sends it to a pool of worker threads (as Node's libuv pool or a worker_thread does).
 * The Runtime's costs (switch, wake-up) are its labelled model inputs.
 */
export function loopServer(over: Partial<LoopServerParams> = {}): LoopServerResult {
  const P = { ...LOOP_SERVER_DEFAULTS, ...over };
  const rt = new Runtime({ cores: 1 + (P.strategy === "offload" ? P.workers : 0) + 1, seed: P.seed, record: P.record });
  const reqCh = rt.channel<Req>("socket", 1_000_000);
  const jobCh = rt.channel<Req>("jobs", 1_000_000);
  const doneCh = rt.channel<Req>("done", 1_000_000);
  const reqs: ReqRecord[] = [];
  const handler = P.handlerUs * 1_000, slow = P.slowMs * 1_000_000, slice = Math.max(1, P.sliceMs) * 1_000_000;

  rt.spawn("clients", function* (t) {
    for (let i = 0; i < P.requests; i++) {
      const gap = -Math.log(1 - t.rand()) / P.rate * 1_000_000;
      yield* t.sleep(gap);
      yield* t.send(reqCh, { id: i, arrive: t.now(), slow: P.slowMs > 0 && i % P.slowEvery === P.slowEvery - 1 });
    }
    t.close(reqCh);
  });

  rt.spawn("event loop", function* (t: Thread) {
    const q: LoopTask[] = [];
    let open = true, out = 0;
    const take = <T>(ch: Channel<T>, f: (v: T) => void) => {
      for (let r = t.tryRecv(ch); r && r.ok; r = t.tryRecv(ch)) f(r.value);
      return ch;
    };
    const finish = (r: Req) => reqs.push({ id: r.id, arrive: r.arrive, done: t.now(), slow: r.slow });
    for (;;) {
      take(reqCh, (r) => q.push({ req: r, kind: "handle", left: 0 }));
      if (open && reqCh.closed && reqCh.buf.length === 0) open = false;
      take(doneCh, (r) => { out--; q.push({ req: r, kind: "finish", left: 0 }); });
      const task = q.shift();
      if (!task) {
        if (!open && out === 0) break;
        // Block until a request or a finished job arrives: the epoll_wait of a real loop.
        const cases = open ? [{ recv: reqCh }, { recv: doneCh }] as const : [{ recv: doneCh }] as const;
        const s = yield* t.select(cases);
        const v = s.value as Req | undefined;
        if (s.ok && v) {
          if (open && s.index === 0) q.push({ req: v, kind: "handle", left: 0 });
          else { out--; q.push({ req: v, kind: "finish", left: 0 }); }
        } else if (open && s.index === 0) open = false;
        continue;
      }
      if (task.kind === "finish") { yield* t.work(handler / 2, "reply"); finish(task.req); continue; }
      if (task.kind === "handle") {
        yield* t.work(handler, "handler");
        if (!task.req.slow) { finish(task.req); continue; }
        if (P.strategy === "inline") { yield* t.work(slow, "slow"); finish(task.req); continue; }
        if (P.strategy === "offload") { out++; yield* t.send(jobCh, task.req); continue; }
        task.kind = "slice";
        task.left = slow;
      }
      // A slice of a chunked slow job; the rest goes to the back of the queue.
      const d = Math.min(slice, task.left);
      yield* t.work(d, "slice");
      task.left -= d;
      if (task.left > 0) q.push(task);
      else finish(task.req);
    }
    t.close(jobCh);
  });

  if (P.strategy === "offload") {
    for (let w = 0; w < P.workers; w++) {
      rt.spawn(`worker ${w}`, function* (t) {
        for (;;) {
          const r = yield* t.recv(jobCh);
          if (!r.ok) break;
          yield* t.work(slow, "slow");
          yield* t.send(doneCh, r.value);
        }
      });
    }
  }

  const run = rt.run();
  reqs.sort((a, b) => a.id - b.id);
  const lat = (f: (r: ReqRecord) => boolean) => reqs.filter(f).map((r) => r.done - r.arrive);
  const fastLat = lat((r) => !r.slow), slowLat = lat((r) => r.slow);
  return {
    reqs, run,
    fast: { p50: quantile(fastLat, 0.5), p99: quantile(fastLat, 0.99), max: Math.max(0, ...fastLat) },
    slowMean: slowLat.length ? slowLat.reduce((a, b) => a + b, 0) / slowLat.length : 0,
  };
}
