/**
 * Deadlock tools: a resource allocation graph with cycle search and reduction, a lockdep-style
 * lock-order checker, and the banker's algorithm.
 */
import { BLOCK, explore, machineModel, type Ins, type Prog } from "./machine";

// ---------------------------------------------------------------- resource allocation graph

export interface Rag {
  threads: string[];
  resources: { id: string; units: number }[];
  /** held[thread][resource] = units held */
  held: Record<string, Record<string, number>>;
  /** The resource each thread waits for, or null. */
  waiting: Record<string, string | null>;
  /** FIFO order of waiters. */
  order: string[];
}

export function ragInit(threads: string[], resources: { id: string; units: number }[]): Rag {
  return {
    threads,
    resources,
    held: Object.fromEntries(threads.map((t) => [t, {}])),
    waiting: Object.fromEntries(threads.map((t) => [t, null])),
    order: [],
  };
}

const ragCopy = (g: Rag): Rag => ({
  ...g,
  held: Object.fromEntries(Object.entries(g.held).map(([k, v]) => [k, { ...v }])),
  waiting: { ...g.waiting },
  order: [...g.order],
});

export const ragFree = (g: Rag, r: string) =>
  g.resources.find((x) => x.id === r)!.units - g.threads.reduce((a, t) => a + (g.held[t]![r] ?? 0), 0);

/** A thread that waits is blocked, so it cannot make another request. */
export function ragRequest(g0: Rag, t: string, r: string): Rag {
  const g = ragCopy(g0);
  if (g.waiting[t]) return g;
  if (ragFree(g, r) > 0) g.held[t]![r] = (g.held[t]![r] ?? 0) + 1;
  else { g.waiting[t] = r; g.order.push(t); }
  return g;
}

/** Releases one unit. The oldest waiter for r gets it at once. */
export function ragRelease(g0: Rag, t: string, r: string): Rag {
  const g = ragCopy(g0);
  if (!g.held[t]![r]) return g;
  g.held[t]![r]!--;
  if (!g.held[t]![r]) delete g.held[t]![r];
  const w = g.order.find((x) => g.waiting[x] === r);
  if (w) {
    g.waiting[w] = null;
    g.order.splice(g.order.indexOf(w), 1);
    g.held[w]![r] = (g.held[w]![r] ?? 0) + 1;
  }
  return g;
}

/** Finds one cycle. Edges: thread → resource it waits for; resource → thread that holds it. */
export function ragCycle(g: Rag): string[] | null {
  const next = (n: string): string[] => {
    if (g.threads.includes(n)) return g.waiting[n] ? [g.waiting[n]!] : [];
    return g.threads.filter((t) => g.held[t]![n]);
  };
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const dfs = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of next(n)) {
      if (state.get(m) === 1) return stack.slice(stack.indexOf(m));
      if (!state.has(m)) {
        const c = dfs(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const t of g.threads) {
    if (!state.has(t)) {
      const c = dfs(t);
      if (c) return c;
    }
  }
  return null;
}

/**
 * The detection algorithm (graph reduction). Repeatedly assume that a thread which can get what it
 * needs runs to the end and releases everything. The threads that remain are deadlocked.
 * With single-unit resources this agrees with the cycle test. With several units, a cycle does not
 * always mean deadlock.
 */
export function ragDeadlocked(g: Rag): string[] {
  const free = new Map(g.resources.map((r) => [r.id, ragFree(g, r.id)]));
  const left = new Set(g.threads);
  for (let changed = true; changed;) {
    changed = false;
    for (const t of [...left]) {
      const w = g.waiting[t];
      if (!w || free.get(w)! > 0) {
        for (const [r, n] of Object.entries(g.held[t]!)) free.set(r, free.get(r)! + n);
        left.delete(t);
        changed = true;
      }
    }
  }
  return [...left];
}

// ---------------------------------------------------------------- lockdep-style checker

export interface LockEvent {
  t: string;
  op: "lock" | "unlock";
  l: string;
  /** "irq": this event runs in a hard interrupt handler. */
  ctx?: "task" | "irq";
  /** For a task-context lock: are interrupts enabled while it holds the lock? Default true. */
  irqsOn?: boolean;
}

export interface LockdepReport {
  kind: "circular" | "recursive" | "irq-inversion";
  at: number;
  message: string;
  cycle: string[];
}

export interface LockdepEdge { from: string; to: string; thread: string; at: number }

/**
 * Follows the rules of Linux lockdep in a small form. It works on lock classes, and it never needs
 * the deadlock to occur. Taking `to` while `from` is on top of the held stack records from → to.
 * A new edge that closes a cycle in that graph is a report, even if the two orders ran hours apart.
 */
export class Lockdep {
  edges: LockdepEdge[] = [];
  reports: LockdepReport[] = [];
  private held = new Map<string, string[]>();
  private usedInIrq = new Set<string>();
  private usedIrqOn = new Set<string>();
  private time = 0;

  private hasEdge(a: string, b: string) { return this.edges.some((e) => e.from === a && e.to === b); }

  /** A path from a to b in the order graph, or null. */
  path(a: string, b: string): string[] | null {
    const seen = new Set([a]);
    const q: string[][] = [[a]];
    while (q.length) {
      const p = q.shift()!;
      const end = p[p.length - 1]!;
      if (end === b) return p;
      for (const e of this.edges) {
        if (e.from === end && !seen.has(e.to)) { seen.add(e.to); q.push([...p, e.to]); }
      }
    }
    return null;
  }

  heldBy(t: string) { return this.held.get(t) ?? []; }

  feed(ev: LockEvent): LockdepReport | null {
    const at = this.time++;
    const stack = this.held.get(ev.t) ?? [];
    this.held.set(ev.t, stack);
    if (ev.op === "unlock") {
      const i = stack.lastIndexOf(ev.l);
      if (i >= 0) stack.splice(i, 1);
      return null;
    }
    let report: LockdepReport | null = null;
    if (stack.includes(ev.l)) {
      report = { kind: "recursive", at, cycle: [ev.l, ev.l], message: `Possible recursive locking: ${ev.t} already holds ${ev.l}.` };
    } else {
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        const back = this.path(ev.l, top);
        if (back) {
          report = { kind: "circular", at, cycle: [top, ...back], message: `Possible circular locking dependency: ${[...back, ev.l].join(" → ")} exists, and ${ev.t} now takes ${ev.l} while it holds ${top}.` };
        }
        if (!this.hasEdge(top, ev.l)) this.edges.push({ from: top, to: ev.l, thread: ev.t, at });
      }
    }
    if (ev.ctx === "irq") this.usedInIrq.add(ev.l);
    else if (ev.irqsOn !== false) this.usedIrqOn.add(ev.l);
    if (!report && this.usedInIrq.has(ev.l) && this.usedIrqOn.has(ev.l)) {
      report = { kind: "irq-inversion", at, cycle: [ev.l], message: `Inconsistent lock state: ${ev.l} is taken in an interrupt handler and also with interrupts on. An interrupt on the same CPU can deadlock with the holder.` };
    }
    stack.push(ev.l);
    if (report) this.reports.push(report);
    return report;
  }
}

export function runLockdep(trace: LockEvent[]) {
  const d = new Lockdep();
  for (const e of trace) d.feed(e);
  return d;
}

/** Each thread's own lock sequence from a trace, as a program for the interleaving machine. */
export function traceToProg(trace: LockEvent[]): Prog {
  const names = [...new Set(trace.map((e) => e.t))];
  const locks = [...new Set(trace.map((e) => e.l))];
  const threads: Ins[][] = names.map((n) =>
    trace.filter((e) => e.t === n).map((e): Ins => e.op === "lock"
      ? { text: `lock(${e.l})`, run(c) { if (c.mem[e.l] !== 0) return BLOCK; c.mem[e.l] = c.t + 1; return undefined; } }
      : { text: `unlock(${e.l})`, run(c) { c.mem[e.l] = 0; } }),
  );
  return { name: "trace", threads, names, mem: Object.fromEntries(locks.map((l) => [l, 0])) };
}

/** Ground truth from exhaustive search: can these per-thread sequences deadlock under some schedule? */
export function realDeadlock(trace: LockEvent[]) {
  return explore(machineModel(traceToProg(trace)));
}

const L = (t: string, l: string): LockEvent => ({ t, op: "lock", l });
const U = (t: string, l: string): LockEvent => ({ t, op: "unlock", l });

export const LOCKDEP_TRACES: Record<string, { label: string; note: string; trace: LockEvent[] }> = {
  abba: {
    label: "A then B, later B then A",
    note: "The two threads run one after the other. The run has no deadlock, but the lock order has a cycle.",
    trace: [L("T1", "A"), L("T1", "B"), U("T1", "B"), U("T1", "A"), L("T2", "B"), L("T2", "A"), U("T2", "A"), U("T2", "B")],
  },
  chain: {
    label: "Three locks in a ring",
    note: "No single pair of threads disagrees. The cycle goes through three threads: A → B → C → A.",
    trace: [L("T1", "A"), L("T1", "B"), U("T1", "B"), U("T1", "A"), L("T2", "B"), L("T2", "C"), U("T2", "C"), U("T2", "B"), L("T3", "C"), L("T3", "A"), U("T3", "A"), U("T3", "C")],
  },
  ordered: {
    label: "One global order",
    note: "Every thread takes A before B before C. The order graph has no cycle.",
    trace: [L("T1", "A"), L("T1", "B"), U("T1", "B"), U("T1", "A"), L("T2", "A"), L("T2", "C"), U("T2", "C"), U("T2", "A"), L("T3", "B"), L("T3", "C"), U("T3", "C"), U("T3", "B")],
  },
  gate: {
    label: "A gate lock G (false positive)",
    note: "Both threads take G first, so they can never hold A and B in opposite order at the same time. Lockdep still reports the A and B cycle.",
    trace: [L("T1", "G"), L("T1", "A"), L("T1", "B"), U("T1", "B"), U("T1", "A"), U("T1", "G"), L("T2", "G"), L("T2", "B"), L("T2", "A"), U("T2", "A"), U("T2", "B"), U("T2", "G")],
  },
  irq: {
    label: "Lock used in an interrupt handler",
    note: "A task takes Q with interrupts on, and a handler also takes Q. If the interrupt arrives on the holder's CPU, the handler spins forever.",
    trace: [L("T1", "Q"), U("T1", "Q"), { t: "irq", op: "lock", l: "Q", ctx: "irq" }, { t: "irq", op: "unlock", l: "Q", ctx: "irq" }],
  },
};

// ---------------------------------------------------------------- banker's algorithm

export interface Bank {
  available: number[];
  max: number[][];
  alloc: number[][];
}

export const BANK_EXAMPLE: Bank = {
  available: [3, 3, 2],
  alloc: [[0, 1, 0], [2, 0, 0], [3, 0, 2], [2, 1, 1], [0, 0, 2]],
  max: [[7, 5, 3], [3, 2, 2], [9, 0, 2], [2, 2, 2], [4, 3, 3]],
};

export const need = (b: Bank) => b.max.map((m, i) => m.map((x, j) => x - b.alloc[i]![j]!));

export interface BankFrame {
  /** The process being tested, or -1 at the end. */
  p: number;
  need: number[];
  work: number[];
  finish: boolean[];
  fits: boolean;
  sequence: number[];
  /** Vector element comparisons so far. */
  comparisons: number;
}

export interface BankCheck { safe: boolean; sequence: number[]; frames: BankFrame[]; comparisons: number }

/** The safety algorithm. It records each test, so a stepper can replay it. */
export function bankerSafety(b: Bank): BankCheck {
  const n = b.max.length;
  const nd = need(b);
  const work = [...b.available];
  const finish = new Array<boolean>(n).fill(false);
  const sequence: number[] = [];
  const frames: BankFrame[] = [];
  let comparisons = 0;
  for (let progress = true; progress;) {
    progress = false;
    for (let p = 0; p < n; p++) {
      if (finish[p]) continue;
      let fits = true;
      for (let j = 0; j < work.length; j++) {
        comparisons++;
        if (nd[p]![j]! > work[j]!) { fits = false; break; }
      }
      if (fits) {
        for (let j = 0; j < work.length; j++) work[j]! += b.alloc[p]![j]!;
        finish[p] = true;
        sequence.push(p);
        progress = true;
      }
      frames.push({ p, need: nd[p]!, work: [...work], finish: [...finish], fits, sequence: [...sequence], comparisons });
    }
  }
  return { safe: finish.every(Boolean), sequence, frames, comparisons };
}

/** Upper bound on vector element comparisons in one safety check: m × n(n + 1)/2. */
export const bankerWorstCase = (processes: number, resources: number) => (resources * processes * (processes + 1)) / 2;

export type BankRequest =
  | { granted: true; bank: Bank; check: BankCheck }
  | { granted: false; reason: "exceeds-claim" | "must-wait" | "unsafe"; check: BankCheck | null };

/** Tries a request: it grants only if the new state stays safe. */
export function bankerRequest(b: Bank, p: number, req: number[]): BankRequest {
  const nd = need(b);
  if (req.some((x, j) => x > nd[p]![j]!)) return { granted: false, reason: "exceeds-claim", check: null };
  if (req.some((x, j) => x > b.available[j]!)) return { granted: false, reason: "must-wait", check: null };
  const next: Bank = {
    available: b.available.map((x, j) => x - req[j]!),
    max: b.max,
    alloc: b.alloc.map((a, i) => (i === p ? a.map((x, j) => x + req[j]!) : a)),
  };
  const check = bankerSafety(next);
  return check.safe ? { granted: true, bank: next, check } : { granted: false, reason: "unsafe", check };
}
