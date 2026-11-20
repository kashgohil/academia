/**
 * Futures and promises.
 *
 * - PollGame: a pull-based executor that a learner drives. Two tasks await sockets and a timer. Each poll runs a task
 *   until it must wait; a leaf that returns Pending stores the task's waker with the resource. An event (data, time)
 *   calls the waker, which puts the task back in the ready queue. A "buggy future" option drops the waker, so the task
 *   hangs. Futures are lazy: B's timer starts at B's first poll, not when B is created.
 * - combine(): what Promise.all / race / any / allSettled (push, eager, no cancellation) and the Rust combinators
 *   (pull, lazy, cancel by drop) do with the same children: when the result is known, and how much work goes on
 *   after that.
 */

// ---------------------------------------------------------------- the poll game

export type Await = { kind: "socket"; res: "a" | "b" } | { kind: "timer"; ms: number };

export interface TaskDef { name: string; code: string[]; awaits: Await[] }

export const GAME_TASKS: TaskDef[] = [
  { name: "A", code: ["let x = sock_a.read().await;", "x"], awaits: [{ kind: "socket", res: "a" }] },
  { name: "B", code: ["sleep(10 ms).await;", "let y = sock_b.read().await;", "y"], awaits: [{ kind: "timer", ms: 10 }, { kind: "socket", res: "b" }] },
];

export type GameAction = { k: "poll"; task: number } | { k: "data"; res: "a" | "b" } | { k: "time"; ms: number };

export interface TaskState {
  name: string;
  /** Index of the await the task waits at (or will reach next). */
  pc: number;
  polled: boolean;
  done: boolean;
  /** Deadline of the timer, once the first poll that reaches it has armed it. */
  deadline?: number;
}

export interface GameState {
  now: number;
  tasks: TaskState[];
  /** Data waiting in each socket's buffer, and the waker stored there (a task index, or -1). */
  sockets: Record<"a" | "b", { data: boolean; waker: number }>;
  /** Armed timers: deadline and the task to wake (-1: no waker). */
  timers: { deadline: number; task: number; waker: number }[];
  ready: number[];
  log: string[];
  polls: number;
  /** Polls that made no progress: the task was not woken and returned Pending again. */
  wasted: number;
}

export function gameStart(): GameState {
  return {
    now: 0,
    tasks: GAME_TASKS.map((d) => ({ name: d.name, pc: 0, polled: false, done: false })),
    sockets: { a: { data: false, waker: -1 }, b: { data: false, waker: -1 } },
    timers: [],
    ready: [0, 1],
    log: ["spawn(A) and spawn(B) put both tasks in the ready queue. Nothing has run yet."],
    polls: 0,
    wasted: 0,
  };
}

const cloneGame = (s: GameState): GameState => ({
  ...s,
  tasks: s.tasks.map((t) => ({ ...t })),
  sockets: { a: { ...s.sockets.a }, b: { ...s.sockets.b } },
  timers: s.timers.map((t) => ({ ...t })),
  ready: s.ready.slice(),
  log: s.log.slice(),
});

/** Applies one action. `buggy`: the futures return Pending without storing the waker. Invalid actions change nothing. */
export function gameStep(prev: GameState, a: GameAction, buggy = false): GameState {
  const s = cloneGame(prev);
  const wake = (task: number, why: string) => {
    if (task < 0) { s.log.push(`${why}, but no waker is stored, so no task wakes.`); return; }
    if (!s.ready.includes(task)) s.ready.push(task);
    s.log.push(`${why}: wake() puts ${s.tasks[task]!.name} in the ready queue.`);
  };
  if (a.k === "data") {
    const so = s.sockets[a.res];
    if (so.data) return prev;
    so.data = true;
    const w = so.waker;
    so.waker = -1;
    if (w < 0) s.log.push(`Data arrives on socket ${a.res}. The kernel buffers it. No waker is stored.`);
    else wake(w, `Data arrives on socket ${a.res}`);
    return s;
  }
  if (a.k === "time") {
    s.now += a.ms;
    s.log.push(`${a.ms} ms pass. The clock is ${s.now} ms.`);
    const due = s.timers.filter((t) => t.deadline <= s.now);
    s.timers = s.timers.filter((t) => t.deadline > s.now);
    for (const t of due) wake(t.waker, `The timer of ${s.tasks[t.task]!.name} fires`);
    return s;
  }
  const t = s.tasks[a.task]!;
  if (t.done) return prev;
  const woken = s.ready.includes(a.task);
  s.ready = s.ready.filter((x) => x !== a.task);
  s.polls++;
  const first = !t.polled;
  t.polled = true;
  const defs = GAME_TASKS[a.task]!.awaits;
  const pc0 = t.pc;
  const steps: string[] = [];
  for (;;) {
    if (t.pc >= defs.length) {
      t.done = true;
      steps.push("returns Ready");
      break;
    }
    const w = defs[t.pc]!;
    if (w.kind === "socket") {
      const so = s.sockets[w.res];
      if (so.data) { so.data = false; steps.push(`reads socket ${w.res}`); t.pc++; continue; }
      so.waker = buggy ? -1 : a.task;
      steps.push(buggy ? `finds socket ${w.res} empty and returns Pending without storing its waker` : `finds socket ${w.res} empty, stores its waker there, returns Pending`);
      break;
    }
    if (t.deadline === undefined) {
      t.deadline = s.now + w.ms;
      s.timers.push({ deadline: t.deadline, task: a.task, waker: buggy ? -1 : a.task });
      steps.push(`arms a timer for ${t.deadline} ms (now + ${w.ms} ms)`);
    }
    if (s.now >= t.deadline) { steps.push("sees the timer has expired"); t.pc++; t.deadline = undefined; continue; }
    steps.push("returns Pending");
    break;
  }
  if (!t.done && t.pc === pc0 && !woken && !first) s.wasted++;
  s.log.push(`poll(${t.name})${woken ? "" : first ? "" : " (not woken)"}: ${t.name} ${steps.join(", ")}.`);
  return s;
}

export function gameReplay(actions: GameAction[], buggy = false): GameState[] {
  const out = [gameStart()];
  for (const a of actions) out.push(gameStep(out[out.length - 1]!, a, buggy));
  return out;
}

/** True if no task can ever finish: a task waits, nothing stores its waker, and it is not in the ready queue. */
export function gameStuck(s: GameState): number[] {
  return s.tasks.flatMap((t, i) => {
    if (t.done || !t.polled || s.ready.includes(i)) return [];
    const stored = s.sockets.a.waker === i || s.sockets.b.waker === i || s.timers.some((x) => x.waker === i);
    return stored ? [] : [i];
  });
}

// ---------------------------------------------------------------- combinators and cancellation

export interface ChildSpec { name: string; ms: number; fails: boolean }
export type Combinator = "all" | "race" | "any" | "allSettled";
/** "none": JavaScript promises keep running. "drop": Rust drops the futures that are still pending. */
export type CancelMode = "none" | "drop";

export interface ChildRun { name: string; start: number; end: number; fails: boolean; dropped: boolean; outcome: "ok" | "error" | "dropped" }

export interface CombineResult {
  /** When the combinator settles, in ms. */
  at: number;
  outcome: "ok" | "error";
  /** The children whose results decide it. */
  why: string;
  children: ChildRun[];
  /** Child time after the combinator settled: work whose result nobody will use. */
  wastedMs: number;
}

export const COMBINATOR_NAMES: Record<Combinator, { js: string; rust: string }> = {
  all: { js: "Promise.all", rust: "try_join_all" },
  race: { js: "Promise.race", rust: "select_all" },
  any: { js: "Promise.any", rust: "select_ok" },
  allSettled: { js: "Promise.allSettled", rust: "join_all" },
};

/** Settles a combinator over children that all start at time 0 and finish (or fail) at `ms`. */
export function combine(children: ChildSpec[], comb: Combinator, cancel: CancelMode): CombineResult {
  const order = children.map((c, i) => ({ c, i })).sort((a, b) => a.c.ms - b.c.ms || a.i - b.i);
  let at = 0, outcome: "ok" | "error" = "ok", why = "";
  const firstFail = order.find((x) => x.c.fails), firstOk = order.find((x) => !x.c.fails);
  const last = order[order.length - 1]!;
  if (comb === "all") {
    if (firstFail) { at = firstFail.c.ms; outcome = "error"; why = `${firstFail.c.name} failed first`; }
    else { at = last.c.ms; why = `the slowest child, ${last.c.name}, finished`; }
  } else if (comb === "race") {
    const f = order[0]!;
    at = f.c.ms; outcome = f.c.fails ? "error" : "ok"; why = `${f.c.name} settled first`;
  } else if (comb === "any") {
    if (firstOk) { at = firstOk.c.ms; why = `${firstOk.c.name} succeeded first`; }
    else { at = last.c.ms; outcome = "error"; why = "every child failed"; }
  } else {
    at = last.c.ms; why = "it waits for every child";
  }
  const runs: ChildRun[] = children.map((c) => {
    const dropped = cancel === "drop" && c.ms > at;
    return { name: c.name, start: 0, end: dropped ? at : c.ms, fails: c.fails, dropped, outcome: dropped ? "dropped" : c.fails ? "error" : "ok" };
  });
  const wastedMs = runs.reduce((a, r) => a + Math.max(0, r.end - at), 0);
  return { at, outcome, why, children: runs, wastedMs };
}

export const DEFAULT_CHILDREN: ChildSpec[] = [
  { name: "replica 1", ms: 30, fails: false },
  { name: "replica 2", ms: 80, fails: false },
  { name: "replica 3", ms: 50, fails: true },
  { name: "replica 4", ms: 120, fails: false },
];
