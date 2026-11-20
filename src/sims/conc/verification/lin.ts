/**
 * Linearizability of concurrent objects in memory: queues and stacks, their histories, and three implementations
 * that run on the step-level machine (src/sims/os/sync/machine.ts).
 *
 * - A history is a list of operations with a call time and a return time (step numbers or abstract time).
 * - `findOrder` searches for a total order that is a legal run of the sequential object. With the rule
 *   "linearizable", the order must respect real time (a returned before b was called, so a comes first). With the
 *   rule "sequential", it must only respect the order inside each thread (Lamport's sequential consistency).
 *   It is the Wing and Gong search with the cache of Lowe: a pair (set of placed operations, object state) that
 *   failed once fails again.
 * - `replayPoints` checks one choice of linearization points: sort by point, then run the sequential object.
 * - Implementations: a queue behind a spinlock, a single-producer single-consumer array queue (correct only with one
 *   producer and one consumer), and the queue of Herlihy and Wing (1990), whose linearization points are not fixed
 *   instructions.
 * - `randomHistory` runs an implementation under a seeded random scheduler and records the history.
 */
import { mulberry32, type Rng } from "../../rng";
import { BLOCK, clone, exec, initial, type Ins, type MState, type Prog } from "../../os/sync/machine";

// ---------------------------------------------------------------- histories and sequential objects

export type OpKind = "enq" | "deq" | "push" | "pop";

export interface HistOp {
  id: number;
  thread: number;
  /** The object, for histories over several objects ("p", "q"). */
  obj: string;
  kind: OpKind;
  /** The argument of enq or push. */
  arg?: number;
  /** The result of deq or pop: a value, or null for "empty". */
  res?: number | null;
  call: number;
  ret: number;
}

/** A sequential specification. `apply` returns the next state, or a reason why the operation is illegal there. */
export interface SeqSpec<S> {
  init: S;
  apply(s: S, op: HistOp): { ok: true; next: S } | { ok: false; why: string };
  key(s: S): string;
  show(s: S): string;
}

const showList = (xs: number[]) => (xs.length ? xs.join(" ") : "empty");

/** A FIFO queue. A deq on an empty queue returns null ("empty"). */
export const queueSpec: SeqSpec<number[]> = {
  init: [],
  apply(s, op) {
    if (op.kind === "enq") return { ok: true, next: [...s, op.arg!] };
    const front = s.length ? s[0]! : null;
    if (op.res === front) return { ok: true, next: s.slice(1) };
    if (front === null) return { ok: false, why: `deq returned ${op.res}, but the queue is empty` };
    if (op.res === null) return { ok: false, why: `deq returned empty, but the queue holds ${showList(s)}` };
    return { ok: false, why: `deq returned ${op.res}, but the front of the queue is ${front}` };
  },
  key: (s) => s.join(","),
  show: (s) => `[${showList(s)}]`,
};

/** A LIFO stack. A pop on an empty stack returns null. */
export const stackSpec: SeqSpec<number[]> = {
  init: [],
  apply(s, op) {
    if (op.kind === "push") return { ok: true, next: [...s, op.arg!] };
    const top = s.length ? s[s.length - 1]! : null;
    if (op.res === top) return { ok: true, next: s.slice(0, -1) };
    if (top === null) return { ok: false, why: `pop returned ${op.res}, but the stack is empty` };
    if (op.res === null) return { ok: false, why: `pop returned empty, but the stack holds ${showList(s)}` };
    return { ok: false, why: `pop returned ${op.res}, but the top of the stack is ${top}` };
  },
  key: (s) => s.join(","),
  show: (s) => `[${showList(s)}]`,
};

/** Several objects, each with its own state. Operations name their object in `obj`. */
export function multiSpec<S>(objs: string[], spec: SeqSpec<S>): SeqSpec<Record<string, S>> {
  return {
    init: Object.fromEntries(objs.map((o) => [o, spec.init])),
    apply(s, op) {
      const r = spec.apply(s[op.obj] ?? spec.init, op);
      return r.ok ? { ok: true, next: { ...s, [op.obj]: r.next } } : { ok: false, why: objs.length > 1 ? `${op.obj}.${r.why}` : r.why };
    },
    key: (s) => objs.map((o) => `${o}:${spec.key(s[o] ?? spec.init)}`).join("|"),
    show: (s) => (objs.length > 1 ? objs.map((o) => `${o} = ${spec.show(s[o] ?? spec.init)}`).join(", ") : spec.show(s[objs[0]!] ?? spec.init)),
  };
}

/** A short label: "enq(1)", "deq() → 2", "deq() → empty". */
export function opLabel(op: HistOp, withObj = false): string {
  const o = withObj ? `${op.obj}.` : "";
  if (op.kind === "enq" || op.kind === "push") return `${o}${op.kind}(${op.arg})`;
  return `${o}${op.kind}() → ${op.res === null || op.res === undefined ? "empty" : op.res}`;
}

// ---------------------------------------------------------------- the search

export type Rule = "linearizable" | "sequential";

/** Must a come before b in every valid order? */
export function mustPrecede(rule: Rule, a: HistOp, b: HistOp): boolean {
  if (rule === "linearizable") return a.ret < b.call;
  return a.thread === b.thread && a.call < b.call;
}

export interface OrderResult {
  /** true: an order exists; false: none exists; null: the budget ran out. */
  ok: boolean | null;
  /** The ids of a valid order, if ok. */
  order: number[];
  /** Configurations (set of placed operations, object state) visited: the cost of the search. */
  explored: number;
  /** The longest legal prefix found, if not ok. */
  best: number[];
  /** Why each candidate after the best prefix was illegal. */
  why: string[];
}

/** Wing and Gong search with Lowe's cache, for the real-time rule or for program order only. */
export function findOrder<S>(ops: HistOp[], spec: SeqSpec<S>, rule: Rule = "linearizable", budget = 200_000): OrderResult {
  const n = ops.length;
  const pred: number[][] = ops.map((b) => ops.flatMap((a, i) => (a !== b && mustPrecede(rule, a, b) ? [i] : [])));
  const placed = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  const failed = new Set<string>();
  let explored = 0, aborted = false;
  let best: number[] = [], why: string[] = [];
  const dfs = (s: S): boolean => {
    if (order.length === n) return true;
    const k = placed.map((p) => (p ? 1 : 0)).join("") + "|" + spec.key(s);
    if (failed.has(k)) return false;
    if (++explored > budget) { aborted = true; return false; }
    const reasons: string[] = [];
    for (let i = 0; i < n && !aborted; i++) {
      if (placed[i] || pred[i]!.some((j) => !placed[j])) continue;
      const r = spec.apply(s, ops[i]!);
      if (!r.ok) { reasons.push(`${opLabel(ops[i]!)}: ${r.why}`); continue; }
      placed[i] = true; order.push(ops[i]!.id);
      if (dfs(r.next)) return true;
      placed[i] = false; order.pop();
    }
    if (order.length > best.length || (order.length === best.length && best.length === 0)) { best = [...order]; why = reasons; }
    failed.add(k);
    return false;
  };
  const ok = dfs(spec.init);
  return { ok: aborted ? null : ok, order: ok ? [...order] : [], explored, best, why };
}

/** Restricts a history to one object. */
export const subHistory = (ops: HistOp[], obj: string) => ops.filter((o) => o.obj === obj);

export interface PointStep { id: number; ok: boolean; state: string; why?: string }

/** Replays the operations in the order of their points. It stops at the first illegal operation. */
export function replayPoints<S>(ops: HistOp[], points: Record<number, number>, spec: SeqSpec<S>): { steps: PointStep[]; ok: boolean } {
  const sorted = [...ops].sort((a, b) => points[a.id]! - points[b.id]! || a.id - b.id);
  let s = spec.init;
  const steps: PointStep[] = [];
  for (const op of sorted) {
    const r = spec.apply(s, op);
    if (!r.ok) { steps.push({ id: op.id, ok: false, state: spec.show(s), why: r.why }); return { steps, ok: false }; }
    s = r.next;
    steps.push({ id: op.id, ok: true, state: spec.show(s) });
  }
  return { steps, ok: true };
}

/**
 * Points inside the intervals that follow a given order (one that respects real time): each point is just after the
 * previous one and no earlier than its own call. The gap is a small fraction of the time range.
 */
export function pointsForOrder(ops: HistOp[], order: number[], gap = 0.6): Record<number, number> {
  const byId = new Map(ops.map((o) => [o.id, o]));
  const out: Record<number, number> = {};
  let t = -Infinity;
  for (const id of order) {
    const o = byId.get(id)!;
    t = Math.max(t + gap, o.call + gap);
    out[id] = Math.min(t, o.ret - gap / 2);
  }
  return out;
}

// ---------------------------------------------------------------- implementations on the machine

/** One operation of a thread, as instructions placed at an absolute base pc. */
export interface OpTemplate {
  kind: OpKind;
  arg?: number;
  /** Builds the instructions; `res` is the register for the result, `base` the pc of the first instruction. */
  code(base: number, res: string): Ins[];
}

export interface ImplProgram {
  prog: Prog;
  /** For each thread: [start pc, end pc, op] of each operation. */
  ranges: { start: number; end: number; kind: OpKind; arg?: number; res: string }[][];
}

/** Builds a program: thread t runs its operations one after the other. */
export function buildProgram(name: string, threads: OpTemplate[][], mem: Record<string, number>, names?: string[]): ImplProgram {
  const ranges: ImplProgram["ranges"] = [];
  const code = threads.map((ops, t) => {
    const out: Ins[] = [];
    ranges[t] = [];
    ops.forEach((op, j) => {
      const res = `res${j}`;
      const ins = op.code(out.length, res);
      ranges[t]!.push({ start: out.length, end: out.length + ins.length, kind: op.kind, arg: op.arg, res });
      out.push(...ins);
    });
    return out;
  });
  return { prog: { name, threads: code, mem: { ...mem }, names }, ranges };
}

const EMPTY = -1; // the machine stores numbers; -1 in a result register means "empty"

/** A queue behind a test-and-set spinlock. Every operation is one critical section. */
export const lockQueue = {
  enq: (v: number): OpTemplate => ({
    kind: "enq", arg: v,
    code: () => [
      { text: "lock()", run: (c) => (c.load("lock") ? BLOCK : (c.store("lock", 1), undefined)) },
      { text: `items[tail] = ${v}`, kind: "cs", run: (c) => { c.store(`items${c.load("tail")}`, v); } },
      { text: "tail = tail + 1", kind: "cs", run: (c) => { c.store("tail", c.load("tail") + 1); } },
      { text: "unlock()", run: (c) => { c.store("lock", 0); } },
    ],
  }),
  deq: (): OpTemplate => ({
    kind: "deq",
    code: (b, res) => [
      { text: "lock()", run: (c) => (c.load("lock") ? BLOCK : (c.store("lock", 1), undefined)) },
      { text: "if head == tail: r = empty", kind: "cs", run: (c) => { if (c.load("head") === c.load("tail")) { c.r[res] = EMPTY; return b + 3; } return undefined; } },
      { text: "r = items[head]; head++", kind: "cs", run: (c) => { const h = c.load("head"); c.r[res] = c.load(`items${h}`); c.store("head", h + 1); } },
      { text: "unlock()", run: (c) => { c.store("lock", 0); } },
    ],
  }),
};

/**
 * A single-producer single-consumer array queue (no wrap-around), as in Lamport's 1983 proof example. Each index
 * has one writer, so it needs no lock. Used by two producers or two consumers, it loses or repeats elements.
 */
export const spscQueue = {
  enq: (v: number): OpTemplate => ({
    kind: "enq", arg: v,
    code: () => [
      { text: "t = tail", run: (c) => { c.r.t = c.load("tail"); } },
      { text: `items[t] = ${v}`, run: (c) => { c.store(`items${c.r.t}`, v); } },
      { text: "tail = t + 1", run: (c) => { c.store("tail", c.r.t! + 1); } },
    ],
  }),
  deq: (): OpTemplate => ({
    kind: "deq",
    code: (b, res) => [
      { text: "h = head", run: (c) => { c.r.h = c.load("head"); } },
      { text: "if h == tail: r = empty", run: (c) => { if (c.r.h === c.load("tail")) { c.r[res] = EMPTY; return b + 4; } return undefined; } },
      { text: "r = items[h]", run: (c) => { c.r[res] = c.load(`items${c.r.h}`); } },
      { text: "head = h + 1", run: (c) => { c.store("head", c.r.h! + 1); } },
    ],
  }),
};

/**
 * The queue of Herlihy and Wing (1990). Enq takes a slot with an atomic fetch-and-increment of `back`, then stores
 * its item. Deq reads `back`, then swaps each slot with null in order until it finds an item; if it finds none, it
 * starts again. Slots hold 0 for null.
 */
export const hwQueue = {
  enq: (v: number): OpTemplate => ({
    kind: "enq", arg: v,
    code: () => [
      { text: "i = back++   (fetch-and-add)", run: (c) => { c.r.i = c.load("back"); c.store("back", c.r.i + 1); c.say(`takes slot ${c.r.i}`); } },
      { text: `items[i] = ${v}`, run: (c) => { c.store(`items${c.r.i}`, v); c.say(`stores ${v} in slot ${c.r.i}`); } },
    ],
  }),
  deq: (): OpTemplate => ({
    kind: "deq",
    code: (b, res) => [
      { text: "n = back; k = 0", run: (c) => { c.r.n = c.load("back"); c.r.k = 0; c.say(`reads back = ${c.r.n}`); } },
      {
        text: "x = swap(items[k++], null)",
        run: (c) => {
          if (c.r.k! >= c.r.n!) { c.say("scanned every slot: start again"); return b; }
          const k = c.r.k!;
          const x = c.load(`items${k}`);
          c.store(`items${k}`, 0);
          c.r.k = k + 1;
          if (x !== 0) { c.r[res] = x; c.say(`swaps slot ${k}: gets ${x}`); return b + 2; }
          c.say(`swaps slot ${k}: null`);
          return b + 1; // stay on this line and try the next slot
        },
      },
      { text: "return x", run: () => undefined },
    ],
  }),
};

export type ImplName = "lock" | "spsc" | "hw";
export const IMPLS: Record<ImplName, { enq: (v: number) => OpTemplate; deq: () => OpTemplate; mem: Record<string, number> }> = {
  lock: { ...lockQueue, mem: { lock: 0, head: 0, tail: 0 } },
  spsc: { ...spscQueue, mem: { head: 0, tail: 0 } },
  hw: { ...hwQueue, mem: { back: 0 } },
};

/** P producer threads and C consumer threads, each with `m` operations. Values are 1, 2, 3, ... */
export function producersConsumers(impl: ImplName, P: number, C: number, m: number): ImplProgram {
  const I = IMPLS[impl];
  let v = 1;
  const threads: OpTemplate[][] = [];
  const names: string[] = [];
  for (let p = 0; p < P; p++) { threads.push(Array.from({ length: m }, () => I.enq(v++))); names.push(`P${p}`); }
  for (let c = 0; c < C; c++) { threads.push(Array.from({ length: m }, () => I.deq())); names.push(`C${c}`); }
  return buildProgram(`${impl} ${P}P ${C}C`, threads, I.mem, names);
}

// ---------------------------------------------------------------- recording histories

export interface Recorder {
  ops: HistOp[];
  /** The op id that thread t is inside now, or -1. */
  open: number[];
  /** Next op index per thread. */
  nextOp: number[];
  step: number;
}

export const newRecorder = (impl: ImplProgram): Recorder => ({ ops: [], open: impl.ranges.map(() => -1), nextOp: impl.ranges.map(() => 0), step: 0 });

/**
 * Notes one step of thread t (pc before, state after). The call time of an operation is the step of its first
 * instruction, and its return time is the step of its last instruction.
 */
export function record(rec: Recorder, impl: ImplProgram, t: number, pcBefore: number, after: MState): void {
  const ranges = impl.ranges[t]!;
  if (rec.open[t] === -1) {
    const j = rec.nextOp[t]!;
    const r = ranges[j];
    if (r && pcBefore >= r.start && pcBefore < r.end) {
      const id = rec.ops.length;
      rec.ops.push({ id, thread: t, obj: "q", kind: r.kind, arg: r.arg, call: rec.step, ret: Infinity });
      rec.open[t] = id;
    }
  }
  const id = rec.open[t]!;
  if (id >= 0) {
    const j = rec.nextOp[t]!;
    const r = ranges[j]!;
    const pc = after.th[t]!.pc;
    if (pc < r.start || pc >= r.end) {
      const op = rec.ops[id]!;
      op.ret = rec.step;
      if (r.kind === "deq" || r.kind === "pop") {
        const v = after.th[t]!.r[r.res];
        op.res = v === undefined || v === EMPTY ? null : v;
      }
      rec.open[t] = -1;
      rec.nextOp[t] = j + 1;
    }
  }
  rec.step++;
}

export interface RandomRun { ops: HistOp[]; steps: number; finished: boolean; schedule: number[] }

/** Runs a program under a seeded uniform random scheduler and records the history. */
export function randomHistory(impl: ImplProgram, seed: number, maxSteps = 4_000): RandomRun {
  const rng: Rng = mulberry32(seed);
  const p = impl.prog;
  let s = initial(p);
  const rec = newRecorder(impl);
  const schedule: number[] = [];
  const n = p.threads.length;
  for (let k = 0; k < maxSteps; k++) {
    const ready: { t: number; next: MState }[] = [];
    for (let t = 0; t < n; t++) {
      if (s.th[t]!.pc >= p.threads[t]!.length) continue;
      const next = clone(s);
      if (exec(p, next, t)) ready.push({ t, next });
    }
    if (!ready.length) break;
    const pick = ready[Math.floor(rng() * ready.length)]!;
    record(rec, impl, pick.t, s.th[pick.t]!.pc, pick.next);
    schedule.push(pick.t);
    s = pick.next;
  }
  const finished = s.th.every((th, t) => th.pc >= p.threads[t]!.length);
  return { ops: rec.ops, steps: rec.step, finished, schedule };
}

/** Replays a schedule (a list of thread numbers) and records the history. */
export function historyOf(impl: ImplProgram, schedule: readonly number[]): { ops: HistOp[]; s: MState } {
  const p = impl.prog;
  const s = initial(p);
  const rec = newRecorder(impl);
  for (const t of schedule) {
    const pc = s.th[t]!.pc;
    if (!exec(p, s, t)) continue;
    record(rec, impl, t, pc, s);
  }
  return { ops: rec.ops, s };
}

export interface BatchResult { runs: number; failing: number; firstFail: number; explored: number; maxExplored: number; results: { seed: number; ok: boolean | null; explored: number }[] }

/** Checks `runs` random histories (seeds base, base+1, ...). Unfinished runs count as passing and are rare. */
export function checkRandomHistories(impl: ImplProgram, runs: number, base = 1): BatchResult {
  const results: BatchResult["results"] = [];
  let failing = 0, firstFail = -1, explored = 0, maxExplored = 0;
  for (let i = 0; i < runs; i++) {
    const seed = base + i;
    const r = randomHistory(impl, seed);
    const done = r.ops.filter((o) => o.ret !== Infinity);
    const c = findOrder(done, queueSpec);
    results.push({ seed, ok: c.ok, explored: c.explored });
    explored += c.explored;
    maxExplored = Math.max(maxExplored, c.explored);
    if (c.ok === false) { failing++; if (firstFail < 0) firstFail = seed; }
  }
  return { runs, failing, firstFail, explored, maxExplored, results };
}

// ---------------------------------------------------------------- the Herlihy-Wing queue, step by step

/** Two enqueuers and one dequeuer on the Herlihy-Wing queue. */
export const hwDemo = (): ImplProgram => buildProgram("Herlihy-Wing queue", [[hwQueue.enq(1)], [hwQueue.enq(2)], [hwQueue.deq()]], { back: 0, items0: 0, items1: 0 }, ["T0", "T1", "T2"]);

/** The fetch-and-add of T0 comes first, but the dequeuer finds the item of T1 first. Thread numbers per step. */
export const HW_FAI_WRONG = [0, 1, 1, 2, 2, 2, 2, 0] as const;
/** T1 stores before T0, but the dequeuer scans slot 0 first and finds the item of T0. */
export const HW_STORE_WRONG = [0, 1, 1, 0, 2, 2, 2] as const;

export type LpRule = "fai" | "store";

/** The step of each candidate linearization point in a schedule of the Herlihy-Wing demo program, by op id. */
export interface HwEvents { ops: HistOp[]; fai: Record<number, number>; store: Record<number, number>; take: Record<number, number> }

export function hwEvents(impl: ImplProgram, schedule: readonly number[]): HwEvents {
  const p = impl.prog;
  const s = initial(p);
  const rec = newRecorder(impl);
  const ev: HwEvents = { ops: rec.ops, fai: {}, store: {}, take: {} };
  let step = 0;
  for (const t of schedule) {
    const pc = s.th[t]!.pc;
    if (!exec(p, s, t)) continue;
    record(rec, impl, t, pc, s);
    const op = rec.ops.find((o) => o.thread === t)!;
    if (op.kind === "enq" && pc === 0) ev.fai[op.id] = step;
    if (op.kind === "enq" && pc === 1) ev.store[op.id] = step;
    if (op.kind === "deq" && pc === 1 && s.th[t]!.pc === 2) ev.take[op.id] = step;
    step++;
  }
  return ev;
}

/**
 * Checks a fixed rule for linearization points on a finished schedule of the Herlihy-Wing demo program: enq takes
 * effect at its fetch-and-add ("fai") or at its store ("store"); deq takes effect at its successful swap.
 * Returns the order that the rule gives and whether it is a legal queue run.
 */
export function hwRuleCheck(impl: ImplProgram, schedule: readonly number[], rule: LpRule): { ok: boolean; order: number[]; why?: string } {
  const ev = hwEvents(impl, schedule);
  const at: Record<number, number> = {};
  for (const o of ev.ops) {
    const v = o.kind === "enq" ? (rule === "fai" ? ev.fai : ev.store)[o.id] : ev.take[o.id];
    if (v === undefined || o.ret === Infinity) return { ok: false, order: [], why: "not finished" };
    at[o.id] = v;
  }
  const r = replayPoints(ev.ops, at, queueSpec);
  return { ok: r.ok, order: r.steps.map((x) => x.id), why: r.steps.find((x) => !x.ok)?.why };
}

/**
 * Every schedule of the demo program in which the dequeuer rescans at most `rescans` times. Returns the finished
 * schedules (as thread lists).
 */
export function hwSchedules(impl: ImplProgram, rescans = 1): number[][] {
  const p = impl.prog;
  const out: number[][] = [];
  const go = (s: MState, sched: number[], scans: number) => {
    let any = false;
    for (let t = 0; t < p.threads.length; t++) {
      if (s.th[t]!.pc >= p.threads[t]!.length) continue;
      const next = clone(s);
      if (!exec(p, next, t)) continue;
      // A jump back to the read of back is a rescan.
      const rescan = t === 2 && s.th[t]!.pc === 1 && next.th[t]!.pc === 0;
      if (rescan && scans >= rescans) continue;
      any = true;
      sched.push(t);
      go(next, sched, scans + (rescan ? 1 : 0));
      sched.pop();
    }
    if (!any && s.th.every((th, t) => th.pc >= p.threads[t]!.length)) out.push([...sched]);
  };
  go(initial(p), [], 0);
  return out;
}

// ---------------------------------------------------------------- hand-made histories for the point-dragging demo

const E = (id: number, thread: number, v: number, call: number, ret: number, obj = "q"): HistOp => ({ id, thread, obj, kind: "enq", arg: v, call, ret });
const D = (id: number, thread: number, v: number | null, call: number, ret: number, obj = "q"): HistOp => ({ id, thread, obj, kind: "deq", res: v, call, ret });

export interface LinPreset { label: string; objs: string[]; threads: number; ops: HistOp[] }

/** Histories on a time axis of 0 to 100. */
export const LIN_PRESETS = {
  /** Linearizable, but only if deq() → 1 of T1 goes before deq() → 2 of T0, which the midpoints do not do. */
  overlap: { label: "Overlap", objs: ["q"], threads: 2, ops: [E(0, 0, 1, 4, 40), D(1, 0, 2, 50, 86), E(2, 1, 2, 18, 62), D(3, 1, 1, 70, 96)] },
  /** Not even sequentially consistent: T0 enqueues 1 then 2, and T1 dequeues 2 first. */
  outOfOrder: { label: "Out of order", objs: ["q"], threads: 2, ops: [E(0, 0, 1, 4, 26), E(1, 0, 2, 32, 52), D(2, 1, 2, 58, 76), D(3, 1, 1, 80, 96)] },
  /** Sequentially consistent, not linearizable: the deq starts after enq(1) returned, and it sees an empty queue. */
  staleEmpty: { label: "Stale empty", objs: ["q"], threads: 2, ops: [E(0, 0, 1, 4, 30), D(1, 1, null, 44, 66), D(2, 1, 1, 72, 94)] },
  /** Each queue alone is sequentially consistent; the two together are not (Herlihy and Shavit). */
  twoQueues: {
    label: "Two queues", objs: ["p", "q"], threads: 2,
    ops: [E(0, 0, 1, 4, 22, "p"), E(1, 0, 1, 30, 48, "q"), D(2, 0, 2, 64, 94, "p"), E(3, 1, 2, 8, 26, "q"), E(4, 1, 2, 34, 54, "p"), D(5, 1, 1, 62, 90, "q")],
  },
} satisfies Record<string, LinPreset>;
