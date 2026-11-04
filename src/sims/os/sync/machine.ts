/**
 * A small interleaving machine with an explicit scheduler, and a generic exhaustive explorer.
 *
 * A program is one list of instructions per thread. One instruction is one atomic step. The caller
 * (a learner, a random scheduler, or the explorer) picks which thread runs next.
 *
 * Memory is sequentially consistent by default. With `tso: true`, each thread has a FIFO store buffer:
 * stores enter the buffer, a separate "drain" step moves the oldest store to memory, loads see the
 * newest buffered store of the same thread, and `sync` instructions (fences, locked RMWs) need an
 * empty buffer. This is the x86-TSO abstract machine.
 *
 * The explorer is generic (`Model<S>`), so models that are not instruction lists (RCU) use it too.
 */

export const BLOCK = Symbol("block");
/** Returned by an instruction that took a step but stays on the same line (a spin or a delay). */
export const STAY = Symbol("stay");

export interface Thread { pc: number; r: Record<string, number>; buf: [string, number][] }

export interface MState {
  mem: Record<string, number>;
  /** Wait queues, by name. Each holds thread ids in FIFO order. */
  q: Record<string, number[]>;
  th: Thread[];
  /** A safety property failed. The state is final. */
  err: string | null;
  /** Statistics. They are not part of the state identity, so counting does not grow the search. */
  n: Record<string, number>;
  /** What the last instruction said about itself, for the trace view. */
  say: string;
}

export type InsKind = "user" | "kernel" | "cs" | "sleep" | "spin";

export interface Ctx {
  t: number;
  r: Record<string, number>;
  mem: Record<string, number>;
  load(x: string): number;
  store(x: string, v: number): void;
  q(name: string): number[];
  count(name: string, by?: number): void;
  fail(msg: string): void;
  say(msg: string): void;
}

export interface Ins {
  text: string;
  label?: string;
  kind?: InsKind;
  /** Needs an empty store buffer (a fence or a locked read-modify-write). */
  sync?: boolean;
  /**
   * Returns nothing for "next instruction", a label or number to jump, or BLOCK if it cannot run now.
   * It must not change any state when it returns BLOCK.
   */
  run(c: Ctx): void | string | number | typeof BLOCK | typeof STAY;
}

export interface Prog {
  name: string;
  threads: Ins[][];
  mem: Record<string, number>;
  queues?: string[];
  tso?: boolean;
  /** Scheduler restriction: may thread t run now? (Used for "interrupts off on one CPU".) */
  gate?: (s: MState, t: number) => boolean;
  /** Thread names for display. */
  names?: string[];
}

export function initial(p: Prog): MState {
  return {
    mem: { ...p.mem },
    q: Object.fromEntries((p.queues ?? []).map((k) => [k, []])),
    th: p.threads.map(() => ({ pc: 0, r: {}, buf: [] })),
    err: null,
    n: {},
    say: "",
  };
}

export function clone(s: MState): MState {
  const q: Record<string, number[]> = {};
  for (const k in s.q) q[k] = s.q[k]!.slice();
  return {
    mem: { ...s.mem },
    q,
    th: s.th.map((t) => ({ pc: t.pc, r: { ...t.r }, buf: t.buf.map((b) => [b[0], b[1]]) })),
    err: s.err,
    n: { ...s.n },
    say: s.say,
  };
}

const labels = new WeakMap<Ins[], Map<string, number>>();
function labelMap(code: Ins[]) {
  let m = labels.get(code);
  if (!m) {
    m = new Map();
    code.forEach((ins, i) => ins.label && m!.set(ins.label, i));
    labels.set(code, m);
  }
  return m;
}

function context(p: Prog, s: MState, t: number): Ctx {
  const th = s.th[t]!;
  return {
    t,
    r: th.r,
    mem: s.mem,
    load(x) {
      for (let i = th.buf.length - 1; i >= 0; i--) if (th.buf[i]![0] === x) return th.buf[i]![1];
      return s.mem[x] ?? 0;
    },
    store(x, v) {
      if (p.tso) th.buf.push([x, v]);
      else s.mem[x] = v;
    },
    q(name) { return (s.q[name] ??= []); },
    count(name, by = 1) { s.n[name] = (s.n[name] ?? 0) + by; },
    fail(msg) { s.err = msg; },
    say(msg) { s.say = msg; },
  };
}

/** Runs the next instruction of thread t on s, in place. Returns false if it cannot run now. */
export function exec(p: Prog, s: MState, t: number): boolean {
  const code = p.threads[t]!;
  const th = s.th[t]!;
  const ins = code[th.pc];
  if (!ins) return false;
  if (p.gate && !p.gate(s, t)) return false;
  if (ins.sync && th.buf.length) return false;
  s.say = "";
  const res = ins.run(context(p, s, t));
  if (res === BLOCK) return false;
  if (res === STAY) return true;
  if (res === undefined) th.pc++;
  else if (typeof res === "number") th.pc = res;
  else if (res === "end") th.pc = code.length;
  else {
    const to = labelMap(code).get(res);
    if (to === undefined) throw new Error(`no label ${res} in ${p.name}`);
    th.pc = to;
  }
  return true;
}

/** Moves the oldest buffered store of thread t to memory, in place. */
export function drain(s: MState, t: number): boolean {
  const th = s.th[t]!;
  const head = th.buf.shift();
  if (!head) return false;
  s.mem[head[0]] = head[1];
  s.say = `store ${head[0]} = ${head[1]} reaches memory`;
  return true;
}

export const threadDone = (p: Prog, s: MState, t: number) => s.th[t]!.pc >= p.threads[t]!.length && s.th[t]!.buf.length === 0;
export const allDone = (p: Prog, s: MState) => s.th.every((_, t) => threadDone(p, s, t));
export const currentIns = (p: Prog, s: MState, t: number): Ins | undefined => p.threads[t]![s.th[t]!.pc];

/** Number of threads now inside a critical section. */
export const inCritical = (p: Prog, s: MState) => s.th.filter((_, t) => currentIns(p, s, t)?.kind === "cs").length;

/** Is thread t able to run its next instruction? It does not change s. */
export function canRun(p: Prog, s: MState, t: number): boolean {
  return exec(p, clone(s), t);
}

// ---------------------------------------------------------------- generic model and explorer

export interface Step<S> { actor: number; id: string; text: string; next: S }

export interface Model<S> {
  init: S;
  key(s: S): string;
  steps(s: S): Step<S>[];
  done(s: S): boolean;
  /** A safety violation in state s, or null. */
  check(s: S): string | null;
  /** A short name for a finished state (for example "count=1"). */
  outcome?(s: S): string;
}

export interface Bug { message: string; schedule: string[]; texts: string[] }

export interface Explored {
  states: number;
  edges: number;
  truncated: boolean;
  /** Shortest schedule to a safety violation. */
  violation: Bug | null;
  /** Shortest schedule to a state where nothing can run and some thread has not finished. */
  stuck: Bug | null;
  /** States from which no finished state can be reached (a superset of stuck: includes spin forever). */
  trapped: number;
  /** Outcomes of the finished states. */
  outcomes: string[];
}

export function explore<S>(m: Model<S>, maxStates = 300_000): Explored {
  const index = new Map<string, number>();
  const parent: number[] = [-1];
  const via: { id: string; text: string }[] = [{ id: "", text: "" }];
  const rev: number[][] = [[]];
  const queue: S[] = [m.init];
  index.set(m.key(m.init), 0);
  const finished: number[] = [];
  const outcomes = new Set<string>();
  let edges = 0;
  let truncated = false;
  let violation: Bug | null = null;
  let stuck: Bug | null = null;

  const path = (i: number, message: string): Bug => {
    const schedule: string[] = [];
    const texts: string[] = [];
    for (let k = i; parent[k]! >= 0; k = parent[k]!) {
      schedule.push(via[k]!.id);
      texts.push(via[k]!.text);
    }
    return { message, schedule: schedule.reverse(), texts: texts.reverse() };
  };

  for (let head = 0; head < queue.length; head++) {
    const s = queue[head]!;
    const bad = m.check(s);
    if (bad) {
      if (!violation) violation = path(head, bad);
      continue;
    }
    const next = m.steps(s);
    if (next.length === 0) {
      if (m.done(s)) {
        finished.push(head);
        if (m.outcome) outcomes.add(m.outcome(s));
      } else if (!stuck) stuck = path(head, "No thread can run, and some threads have not finished.");
      continue;
    }
    for (const st of next) {
      edges++;
      const k = m.key(st.next);
      let j = index.get(k);
      if (j === undefined) {
        if (queue.length >= maxStates) { truncated = true; continue; }
        j = queue.length;
        index.set(k, j);
        queue.push(st.next);
        parent.push(head);
        via.push({ id: st.id, text: st.text });
        rev.push([]);
      }
      rev[j]!.push(head);
    }
  }

  // Backward reachability from finished states finds traps, such as a thread that spins forever.
  const canFinish = new Uint8Array(queue.length);
  const work = [...finished];
  for (const f of finished) canFinish[f] = 1;
  while (work.length) {
    for (const p of rev[work.pop()!]!) if (!canFinish[p]) { canFinish[p] = 1; work.push(p); }
  }
  // A violating state is reported separately, so it is not counted as a trap.
  let trapped = 0;
  for (let i = 0; i < queue.length; i++) if (!canFinish[i] && !m.check(queue[i]!)) trapped++;

  return { states: queue.length, edges, truncated, violation, stuck, trapped, outcomes: [...outcomes].sort() };
}

/**
 * Counts complete schedules by outcome, for an acyclic state space (no spin loops).
 * Two schedules that differ in order count as two, even if they reach the same state.
 */
export function countSchedules<S>(m: Model<S>): Map<string, number> {
  const memo = new Map<string, Map<string, number>>();
  const go = (s: S): Map<string, number> => {
    const k = m.key(s);
    const hit = memo.get(k);
    if (hit) return hit;
    const out = new Map<string, number>();
    const next = m.steps(s);
    if (next.length === 0) out.set(m.outcome ? m.outcome(s) : "done", 1);
    for (const st of next) for (const [o, c] of go(st.next)) out.set(o, (out.get(o) ?? 0) + c);
    memo.set(k, out);
    return out;
  };
  return go(m.init);
}

/** Applies a schedule of step ids to a model. Returns every state on the way. Unknown ids are skipped. */
export function replay<S>(m: Model<S>, schedule: readonly string[]): S[] {
  const out = [m.init];
  for (const id of schedule) {
    const st = m.steps(out[out.length - 1]!).find((x) => x.id === id);
    if (st) out.push(st.next);
  }
  return out;
}

// ---------------------------------------------------------------- machine as a model

export const execId = (t: number) => `T${t}`;
export const drainId = (t: number) => `D${t}`;

export function machineSteps(p: Prog, s: MState): Step<MState>[] {
  const out: Step<MState>[] = [];
  if (s.err) return out;
  for (let t = 0; t < s.th.length; t++) {
    const ins = currentIns(p, s, t);
    if (ins) {
      const next = clone(s);
      if (exec(p, next, t)) out.push({ actor: t, id: execId(t), text: ins.text, next });
    }
    if (s.th[t]!.buf.length) {
      const next = clone(s);
      drain(next, t);
      out.push({ actor: t, id: drainId(t), text: "drain", next });
    }
  }
  return out;
}

export function machineModel(
  p: Prog,
  opts: { check?: (s: MState) => string | null; outcome?: (s: MState) => string } = {},
): Model<MState> {
  return {
    init: initial(p),
    key: (s) => JSON.stringify([s.mem, s.q, s.th.map((t) => [t.pc, t.r, t.buf]), s.err]),
    steps: (s) => machineSteps(p, s),
    done: (s) => allDone(p, s),
    check: (s) => s.err ?? opts.check?.(s) ?? null,
    outcome: opts.outcome,
  };
}

/** The standard safety property: at most one thread is inside a critical section. */
export const mutualExclusion = (p: Prog) => (s: MState) =>
  inCritical(p, s) > 1 ? "Two threads are inside the critical section." : null;

/**
 * A delay of `n` ticks, for load simulations. It is an empty list when n is 0.
 * With `rand`, the length of each delay is exponential with mean n, so threads do not fall into step.
 */
export function delay(n: number, text: string, kind: InsKind = "user", reg = "d", rand?: () => number): Ins[] {
  if (n <= 0) return [];
  return [{
    text,
    kind,
    run(c) {
      const left = c.r[reg] ?? (rand ? Math.max(1, Math.round(-Math.log(1 - rand()) * n)) : n);
      if (left > 1) { c.r[reg] = left - 1; return STAY; }
      delete c.r[reg];
      return undefined;
    },
  }];
}

/**
 * Runs threads in parallel ticks with a seeded random order: in each tick, each thread that can run
 * runs one instruction. Returns the final state. It stops after `maxTicks`.
 */
export function runParallel(p: Prog, rng: () => number, maxTicks = 2_000_000): { s: MState; ticks: number } {
  const s = initial(p);
  const n = s.th.length;
  const order = Array.from({ length: n }, (_, i) => i);
  let ticks = 0;
  while (ticks < maxTicks) {
    let live = false;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const x = order[i]!; order[i] = order[j]!; order[j] = x;
    }
    for (const t of order) {
      if (s.th[t]!.pc < p.threads[t]!.length) {
        live = true;
        exec(p, s, t);
      }
    }
    ticks++;
    if (!live || s.err) break;
  }
  return { s, ticks };
}
