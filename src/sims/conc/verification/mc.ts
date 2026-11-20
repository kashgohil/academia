/**
 * Model checking of small concurrent programs.
 *
 * - Schedule counts: n threads of k steps each have (nk)! / (k!)^n interleavings.
 * - Step programs: each step of a thread reads or writes one variable. Two steps of different threads are
 *   DEPENDENT if they touch the same variable and at least one of them writes. Independent steps commute: both
 *   orders reach the same state.
 * - Explicit-state search with hashing (the generic `explore` of src/sims/os/sync/machine.ts) counts distinct states.
 * - Partial order reduction: a stateless depth-first search with sleep sets (Godefroid 1996). It runs one complete
 *   execution per Mazurkiewicz trace (an equivalence class of schedules under swapping adjacent independent steps),
 *   plus some dead ends ("sleep-set blocked" prefixes).
 * - Bug hunts on a ticket dispenser: n threads each run `t = next; next = t + 1` between steps of local work. The
 *   property under test is "not every thread holds the same ticket". It fails only if every thread loads before any
 *   thread stores, which needs n - 1 preemptions, so the number of threads sets the depth of the bug. Strategies: breadth-first search with hashing, preemption-bounded search (CHESS), uniform random
 *   walks, and PCT (Burckhardt et al. 2010).
 */
import { mulberry32 } from "../../rng";
import { delay, explore, type Ins, type Model, type Prog, type Step } from "../../os/sync/machine";

// ---------------------------------------------------------------- counting schedules

/** (nk)! / (k!)^n, exactly. */
export function schedulesExact(n: number, k: number): bigint {
  // Multiply binomials: C(k, k) * C(2k, k) * ... * C(nk, k).
  let out = 1n;
  for (let t = 1; t <= n; t++) out *= binom(t * k, k);
  return out;
}

export function binom(a: number, b: number): bigint {
  let r = 1n;
  for (let i = 1; i <= b; i++) r = (r * BigInt(a - b + i)) / BigInt(i);
  return r;
}

/** The multinomial (Σ m)! / Π m!, as a bigint. */
export function multinomial(ms: number[]): bigint {
  let out = 1n, sum = 0;
  for (const m of ms) { sum += m; out *= binom(sum, m); }
  return out;
}

export const schedules = (n: number, k: number) => Number(schedulesExact(n, k));

// ---------------------------------------------------------------- step programs

export interface Access { v: string; w: boolean }
export interface StepProg { threads: Access[][] }

export type ExplosionKind = "private" | "shared" | "mixed";

/**
 * n threads of k steps. "private": each step writes the thread's own variable. "shared": each step writes x.
 * "mixed": even steps write x, odd steps write the thread's own variable.
 */
export function explosionProg(kind: ExplosionKind, n: number, k: number): StepProg {
  return {
    threads: Array.from({ length: n }, (_, t) => Array.from({ length: k }, (_, j) => {
      const shared = kind === "shared" || (kind === "mixed" && j % 2 === 0);
      return { v: shared ? "x" : `own${t}`, w: true };
    })),
  };
}

export interface SState { pc: number[]; mem: Record<string, number>; reads: number[] }

const writeValue = (t: number, j: number) => (t + 1) * 10 + j + 1;

export const dependent = (a: Access, b: Access) => a.v === b.v && (a.w || b.w);

/** The program as a model for the generic explorer. A read folds the value it saw into the thread's state. */
export function stepModel(p: StepProg): Model<SState> {
  const n = p.threads.length;
  return {
    init: { pc: new Array(n).fill(0), mem: {}, reads: new Array(n).fill(0) },
    key: (s) => `${s.pc.join(",")}|${Object.keys(s.mem).sort().map((k) => `${k}=${s.mem[k]}`).join(",")}|${s.reads.join(",")}`,
    steps(s) {
      const out: Step<SState>[] = [];
      for (let t = 0; t < n; t++) {
        const j = s.pc[t]!;
        const a = p.threads[t]![j];
        if (!a) continue;
        const next: SState = { pc: s.pc.slice(), mem: { ...s.mem }, reads: s.reads.slice() };
        next.pc[t] = j + 1;
        if (a.w) next.mem[a.v] = writeValue(t, j);
        else next.reads[t] = next.reads[t]! * 97 + (s.mem[a.v] ?? 0) + 1;
        out.push({ actor: t, id: `T${t}`, text: `${a.w ? "write" : "read"} ${a.v}`, next });
      }
      return out;
    },
    done: (s) => s.pc.every((x, t) => x >= p.threads[t]!.length),
    check: () => null,
    outcome: (s) => `${Object.keys(s.mem).sort().map((k) => `${k}=${s.mem[k]}`).join(",")}|${s.reads.join(",")}`,
  };
}

/** Distinct states that a search with hashing visits. */
export const countStates = (p: StepProg) => explore(stepModel(p), 2_000_000).states;

/** Mazurkiewicz traces of the explosion programs: every shared step writes x, so only their order matters. */
export function tracesFormula(kind: ExplosionKind, n: number, k: number): bigint {
  const m = kind === "private" ? 0 : kind === "shared" ? k : Math.ceil(k / 2);
  return multinomial(new Array(n).fill(m));
}

export interface SleepResult { complete: number; blocked: number; transitions: number; truncated: boolean }

/**
 * Stateless depth-first search with sleep sets. After the search explores thread t's step from a state, t goes to
 * sleep for the later siblings. A sleeping thread stays asleep until a step dependent with its next step runs.
 */
export function sleepSetSearch(p: StepProg, budget = 1_000_000): SleepResult {
  const m = stepModel(p);
  const res: SleepResult = { complete: 0, blocked: 0, transitions: 0, truncated: false };
  const next = (s: SState, t: number) => p.threads[t]![s.pc[t]!]!;
  const go = (s: SState, sleep: Set<number>) => {
    if (res.transitions > budget) { res.truncated = true; return; }
    const steps = m.steps(s);
    if (!steps.length) { res.complete++; return; }
    const asleep = new Set(sleep);
    let any = false;
    for (const st of steps) {
      if (asleep.has(st.actor)) continue;
      any = true;
      res.transitions++;
      const a = next(s, st.actor);
      const child = new Set([...asleep].filter((u) => !dependent(next(s, u), a)));
      go(st.next, child);
      asleep.add(st.actor);
    }
    if (!any) res.blocked++;
  };
  go(m.init, new Set());
  return res;
}

/** Every schedule of a step program, as a list of thread numbers. Use only for small programs. */
export function allSchedules(p: StepProg): number[][] {
  const out: number[][] = [];
  const pc = p.threads.map(() => 0);
  const cur: number[] = [];
  const go = () => {
    let any = false;
    for (let t = 0; t < p.threads.length; t++) {
      if (pc[t]! >= p.threads[t]!.length) continue;
      any = true;
      pc[t]!++; cur.push(t);
      go();
      pc[t]!--; cur.pop();
    }
    if (!any) out.push([...cur]);
  };
  go();
  return out;
}

/**
 * A canonical name for the trace of a schedule: for each pair of dependent steps of different threads, which one
 * ran first. Two schedules have the same name exactly when one becomes the other by swapping independent steps.
 */
export function traceKey(p: StepProg, sched: readonly number[]): string {
  const pc = p.threads.map(() => 0);
  const seen: [number, number][] = [];
  const pairs: string[] = [];
  for (const t of sched) {
    const j = pc[t]!++;
    const a = p.threads[t]![j]!;
    for (const [u, i] of seen) if (u !== t && dependent(p.threads[u]![i]!, a)) pairs.push(`${u}.${i}<${t}.${j}`);
    seen.push([t, j]);
  }
  return pairs.sort().join(" ");
}

export interface TraceSummary { schedules: number; traces: number; outcomes: number; byTrace: Map<string, number[][]> }

/** Groups every schedule by trace. */
export function traceSummary(p: StepProg): TraceSummary {
  const all = allSchedules(p);
  const byTrace = new Map<string, number[][]>();
  const m = stepModel(p);
  const outcomes = new Set<string>();
  for (const s of all) {
    const k = traceKey(p, s);
    const list = byTrace.get(k);
    if (list) list.push(s); else byTrace.set(k, [s]);
  }
  for (const list of byTrace.values()) {
    let st = m.init;
    for (const t of list[0]!) st = m.steps(st).find((x) => x.actor === t)!.next;
    outcomes.add(m.outcome!(st));
  }
  return { schedules: all.length, traces: byTrace.size, outcomes: outcomes.size, byTrace };
}

/** Two-thread programs for the grid demo. Each thread has 4 steps. Thread 0's local variable is "a", thread 1's is "b". */
export const GRID_PRESETS: Record<string, { label: string; prog: StepProg }> = {
  private: { label: "No sharing", prog: { threads: [[0, 1, 2, 3].map(() => ({ v: "a", w: true })), [0, 1, 2, 3].map(() => ({ v: "b", w: true }))] } },
  message: {
    label: "Message passing", // x is the data, y the flag
    prog: { threads: [[{ v: "a", w: true }, { v: "x", w: true }, { v: "y", w: true }, { v: "a", w: true }], [{ v: "b", w: true }, { v: "y", w: false }, { v: "x", w: false }, { v: "b", w: true }]] },
  },
  counter: {
    label: "Shared counter",
    prog: { threads: [[{ v: "a", w: true }, { v: "x", w: false }, { v: "x", w: true }, { v: "a", w: true }], [{ v: "b", w: true }, { v: "x", w: false }, { v: "x", w: true }, { v: "b", w: true }]] },
  },
  all: { label: "All on x", prog: { threads: [[0, 1, 2, 3].map(() => ({ v: "x", w: true })), [0, 1, 2, 3].map(() => ({ v: "x", w: true }))] } },
};

// ---------------------------------------------------------------- the ticket dispenser

export interface CState { pc: number[]; r: number[]; next: number }

/** Local work of thread t before it takes a ticket: t × pad steps, so the threads reach the race at staggered times. */
export const ticketWork = (t: number, pad: number) => t * pad;

/** Total steps of one run: the work of every thread, plus a load and a store each. */
export const ticketTotalSteps = (n: number, pad: number) => Array.from({ length: n }, (_, t) => ticketWork(t, pad) + 2).reduce((a, b) => a + b, 0);

/** The ticket dispenser as a fast model. Step ids are "T0", "T1", ... as in the machine, so schedules replay there. */
export function ticketModel(n: number, pad: number): Model<CState> {
  const len = (t: number) => ticketWork(t, pad) + 2;
  const done = (s: CState) => s.pc.every((x, t) => x >= len(t));
  return {
    init: { pc: new Array(n).fill(0), r: new Array(n).fill(0), next: 0 },
    key: (s) => `${s.pc.join(",")}|${s.r.join(",")}|${s.next}`,
    steps(s) {
      const out: Step<CState>[] = [];
      for (let t = 0; t < n; t++) {
        const pc = s.pc[t]!;
        const w = ticketWork(t, pad);
        if (pc >= w + 2) continue;
        const nx: CState = { pc: s.pc.slice(), r: s.r.slice(), next: s.next };
        nx.pc[t] = pc + 1;
        let text = "local work";
        if (pc === w) { nx.r[t] = s.next; text = "t = next"; }
        if (pc === w + 1) { nx.next = s.r[t]! + 1; text = "next = t + 1"; }
        out.push({ actor: t, id: `T${t}`, text, next: nx });
      }
      return out;
    },
    done,
    check: (s) => (n > 1 && done(s) && s.r.every((x) => x === s.r[0]) ? `All ${n} threads hold ticket ${s.r[0]}.` : null),
    outcome: (s) => `tickets=${s.r.join(",")}`,
  };
}

/** The same program on the step machine, for the stepper. The local work is one line that takes t × pad steps. */
export function ticketProg(n: number, pad: number): Prog {
  const code = (t: number): Ins[] => [
    ...delay(ticketWork(t, pad), `work(${ticketWork(t, pad)})`, "user", "d"),
    { text: "t = next", run: (c) => { c.r.t = c.load("next"); } },
    { text: "next = t + 1", run: (c) => { c.store("next", c.r.t! + 1); } },
  ];
  return { name: "ticket dispenser", threads: Array.from({ length: n }, (_, t) => code(t)), mem: { next: 0 }, names: Array.from({ length: n }, (_, t) => `T${t}`) };
}

export interface HuntResult {
  /** States (BFS) or complete schedules (the others) tried. */
  tried: number;
  /** For bounded search: complete schedules within the bound (capped by the budget). */
  total?: number;
  /** The index (1-based) of the first failing run or schedule, or -1. */
  firstBug: number;
  /** For random strategies: failing runs. */
  failures?: number;
  /** A failing schedule (step ids), if found. */
  counterexample: string[] | null;
  truncated?: boolean;
}

/** Breadth-first search with hashing: the shortest counterexample. */
export function huntBfs(n: number, pad: number): HuntResult {
  const r = explore(ticketModel(n, pad), 2_000_000);
  return { tried: r.states, firstBug: r.violation ? r.violation.schedule.length : -1, counterexample: r.violation?.schedule ?? null };
}

/**
 * Stateless depth-first search over schedules with at most `bound` preemptions. A preemption is a switch away from a
 * thread that could still run. It counts every complete schedule within the bound, up to `budget`.
 */
export function huntPreemption(n: number, pad: number, bound: number, budget = 200_000): HuntResult {
  const m = ticketModel(n, pad);
  let tried = 0, firstBug = -1, counterexample: string[] | null = null, truncated = false;
  const path: string[] = [];
  const go = (s: CState, last: number, pre: number) => {
    if (tried >= budget) { truncated = true; return; }
    const steps = m.steps(s);
    if (!steps.length) {
      tried++;
      if (firstBug < 0 && m.check(s)) { firstBug = tried; counterexample = [...path]; }
      return;
    }
    const lastCanRun = steps.some((x) => x.actor === last);
    for (const st of steps) {
      const cost = lastCanRun && st.actor !== last ? 1 : 0;
      if (pre + cost > bound) continue;
      path.push(st.id);
      go(st.next, st.actor, pre + cost);
      path.pop();
    }
  };
  go(m.init, -1, 0);
  return { tried, total: tried, firstBug, counterexample, truncated };
}

/** Uniform random walks: at each step, any thread that can run is picked with equal chance. */
export function huntRandom(n: number, pad: number, runs: number, seed = 1): HuntResult {
  const m = ticketModel(n, pad);
  const rng = mulberry32(seed);
  let failures = 0, firstBug = -1, counterexample: string[] | null = null;
  for (let i = 0; i < runs; i++) {
    let s = m.init;
    const path: string[] = [];
    for (;;) {
      const steps = m.steps(s);
      if (!steps.length) break;
      const st = steps[Math.floor(rng() * steps.length)]!;
      path.push(st.id);
      s = st.next;
    }
    if (m.check(s)) { failures++; if (firstBug < 0) { firstBug = i + 1; counterexample = path; } }
  }
  return { tried: runs, firstBug, failures, counterexample };
}

/**
 * PCT with bug depth d: random distinct priorities d..d+n-1 for the threads, and d - 1 change points drawn from
 * 1..k (k = total steps). The highest-priority thread that can run takes the next step. After step number k_i, the
 * thread that took it drops to priority i, below every initial priority.
 */
export function huntPct(n: number, pad: number, d: number, runs: number, seed = 1): HuntResult {
  const m = ticketModel(n, pad);
  const k = ticketTotalSteps(n, pad);
  const rng = mulberry32(seed);
  let failures = 0, firstBug = -1, counterexample: string[] | null = null;
  for (let i = 0; i < runs; i++) {
    const prio = Array.from({ length: n }, (_, t) => d + t);
    for (let a = n - 1; a > 0; a--) { const b = Math.floor(rng() * (a + 1)); [prio[a], prio[b]] = [prio[b]!, prio[a]!]; }
    const change = new Map<number, number>();
    for (let j = 1; j < d; j++) {
      let at = 1 + Math.floor(rng() * k);
      while (change.has(at) && change.size < k) at = 1 + Math.floor(rng() * k);
      change.set(at, j);
    }
    let s = m.init;
    const path: string[] = [];
    for (let step = 1; ; step++) {
      const steps = m.steps(s);
      if (!steps.length) break;
      let st = steps[0]!;
      for (const x of steps) if (prio[x.actor]! > prio[st.actor]!) st = x;
      path.push(st.id);
      s = st.next;
      const c = change.get(step);
      if (c !== undefined) prio[st.actor] = c;
    }
    if (m.check(s)) { failures++; if (firstBug < 0) { firstBug = i + 1; counterexample = path; } }
  }
  return { tried: runs, firstBug, failures, counterexample };
}

/** The PCT guarantee for one run: probability at least 1 / (n k^(d-1)). */
export const pctBound = (n: number, k: number, d: number) => 1 / (n * Math.pow(k, d - 1));
