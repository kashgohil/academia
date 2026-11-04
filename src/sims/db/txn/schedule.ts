/**
 * The schedule model of transactions.
 *
 * A schedule is an interleaving of the operations of several transactions. We ignore commit records here and
 * assume that each transaction commits at the end. Two operations conflict when they belong to different
 * transactions, touch the same item, and at least one of them writes. The precedence graph has an edge Ti → Tj
 * when an operation of Ti comes before a conflicting operation of Tj. A schedule is conflict serializable iff
 * this graph has no cycle; a topological order of the graph is an equivalent serial order.
 *
 * Also here: a concrete interpreter (each write computes a value from what the transaction read), so a demo can
 * compare the final state of an interleaving with the final states of the serial orders, and a bank-transfer
 * crash model for atomicity.
 */

export type OpKind = "r" | "w";
export interface Op {
  /** Transaction index (0-based). */
  t: number;
  kind: OpKind;
  item: string;
}
export type Schedule = Op[];

export const txnName = (t: number) => `T${t + 1}`;
export const opLabel = (o: Op) => `${o.kind}${o.t + 1}(${o.item})`;

/** Parses "r1(x) w2(x) ..." (1-based transaction numbers). */
export function parseSchedule(s: string): Schedule {
  return [...s.matchAll(/([rw])(\d+)\((\w+)\)/g)].map((m) => ({ kind: m[1] as OpKind, t: Number(m[2]) - 1, item: m[3]! }));
}

export function conflicts(a: Op, b: Op): boolean {
  return a.t !== b.t && a.item === b.item && (a.kind === "w" || b.kind === "w");
}

export interface PEdge {
  from: number;
  to: number;
  /** Every conflicting pair that causes this edge: indexes into the schedule. */
  reasons: { i: number; j: number; item: string }[];
}

/** Precedence (conflict) graph of the first `upTo` operations. */
export function precedenceGraph(s: Schedule, upTo = s.length): { nodes: number[]; edges: PEdge[] } {
  const nodes = [...new Set(s.map((o) => o.t))].sort((a, b) => a - b);
  const byKey = new Map<string, PEdge>();
  const n = Math.min(upTo, s.length);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < j; i++) {
      const a = s[i]!, b = s[j]!;
      if (!conflicts(a, b)) continue;
      const k = `${a.t}>${b.t}`;
      let e = byKey.get(k);
      if (!e) byKey.set(k, (e = { from: a.t, to: b.t, reasons: [] }));
      e.reasons.push({ i, j, item: a.item });
    }
  }
  return { nodes, edges: [...byKey.values()] };
}

/** Returns one directed cycle as a node list [a, b, ..., a], or null. */
export function findCycle(nodes: number[], edges: { from: number; to: number }[]): number[] | null {
  const adj = new Map<number, number[]>(nodes.map((n) => [n, []]));
  for (const e of edges) adj.get(e.from)?.push(e.to);
  const color = new Map<number, 0 | 1 | 2>(nodes.map((n) => [n, 0]));
  const stack: number[] = [];
  const dfs = (u: number): number[] | null => {
    color.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === 1) return [...stack.slice(stack.indexOf(v)), v];
      if (color.get(v) === 0) {
        const c = dfs(v);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(u, 2);
    return null;
  };
  for (const n of nodes) if (color.get(n) === 0) {
    const c = dfs(n);
    if (c) return c;
  }
  return null;
}

/** A topological order (an equivalent serial order), or null when the graph has a cycle. */
export function topoOrder(nodes: number[], edges: { from: number; to: number }[]): number[] | null {
  const indeg = new Map<number, number>(nodes.map((n) => [n, 0]));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const out: number[] = [];
  const ready = nodes.filter((n) => indeg.get(n) === 0);
  while (ready.length) {
    ready.sort((a, b) => a - b);
    const u = ready.shift()!;
    out.push(u);
    for (const e of edges) if (e.from === u) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) ready.push(e.to);
    }
  }
  return out.length === nodes.length ? out : null;
}

export function isConflictSerializable(s: Schedule): boolean {
  const g = precedenceGraph(s);
  return findCycle(g.nodes, g.edges) === null;
}

/** All interleavings of the given programs that keep the order inside each program. */
export function interleavings<T>(progs: T[][]): T[][] {
  const out: T[][] = [];
  const pos = progs.map(() => 0);
  const cur: T[] = [];
  const total = progs.reduce((s, p) => s + p.length, 0);
  const rec = () => {
    if (cur.length === total) { out.push([...cur]); return; }
    for (let t = 0; t < progs.length; t++) {
      if (pos[t]! >= progs[t]!.length) continue;
      cur.push(progs[t]![pos[t]!]!);
      pos[t]!++;
      rec();
      pos[t]!--;
      cur.pop();
    }
  };
  rec();
  return out;
}

export function countSerializable(progs: Op[][]): { total: number; serializable: number } {
  const all = interleavings(progs);
  return { total: all.length, serializable: all.filter(isConflictSerializable).length };
}

// ---------------------------------------------------------------- concrete programs

/** An operation with meaning: a read stores the value in a local; a write computes from the locals. */
export interface COp extends Op {
  /** For writes: the new value from this transaction's locals (keyed by item). */
  f?: (locals: Record<string, number>) => number;
  /** For writes: how the demo prints the expression, e.g. "x + 100". */
  expr?: string;
}
export interface TxnSet {
  id: string;
  name: string;
  init: Record<string, number>;
  txns: COp[][];
}

export interface Outcome {
  /** Final value of each item. */
  state: Record<string, number>;
  /** What each transaction read, in order: "x=100". */
  reads: string[][];
}

/** Runs a schedule of concrete operations on one shared copy of the data (no isolation at all). */
export function runConcrete(set: TxnSet, s: COp[]): Outcome {
  const state = { ...set.init };
  const locals: Record<string, number>[] = set.txns.map(() => ({}));
  const reads: string[][] = set.txns.map(() => []);
  for (const o of s) {
    if (o.kind === "r") {
      const v = state[o.item]!;
      locals[o.t]![o.item] = v;
      reads[o.t]!.push(`${o.item}=${v}`);
    } else {
      state[o.item] = o.f ? o.f(locals[o.t]!) : 0;
    }
  }
  return { state, reads };
}

const sameOutcome = (a: Outcome, b: Outcome) => JSON.stringify(a) === JSON.stringify(b);

export function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  return permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)]));
}

/** Serial orders whose outcome (final state and every read) equals the outcome of this schedule. */
export function matchingSerialOrders(set: TxnSet, s: COp[]): number[][] {
  const got = runConcrete(set, s);
  return permutations(set.txns.length)
    .sort((a, b) => a.join().localeCompare(b.join()))
    .filter((order) => sameOutcome(got, runConcrete(set, order.flatMap((t) => set.txns[t]!))));
}

const W = (t: number, item: string, expr: string, f: (l: Record<string, number>) => number): COp => ({ t, kind: "w", item, expr, f });
const R = (t: number, item: string): COp => ({ t, kind: "r", item });

/** Transaction sets for the schedule builder. */
export const TXN_SETS: TxnSet[] = [
  {
    id: "transfer",
    name: "Transfer and audit",
    init: { A: 100, B: 100 },
    txns: [
      [R(0, "A"), W(0, "A", "A − 10", (l) => l.A! - 10), R(0, "B"), W(0, "B", "B + 10", (l) => l.B! + 10)],
      [R(1, "A"), R(1, "B")],
    ],
  },
  {
    id: "lost",
    name: "Two updates of x",
    init: { x: 100 },
    txns: [
      [R(0, "x"), W(0, "x", "x + 10", (l) => l.x! + 10)],
      [R(1, "x"), W(1, "x", "x × 2", (l) => l.x! * 2)],
    ],
  },
  {
    id: "ring",
    name: "Three transactions in a ring",
    init: { x: 1, y: 2, z: 3 },
    txns: [
      [R(0, "x"), W(0, "y", "x + 10", (l) => l.x! + 10)],
      [R(1, "y"), W(1, "z", "y + 10", (l) => l.y! + 10)],
      [R(2, "z"), W(2, "x", "z + 10", (l) => l.z! + 10)],
    ],
  },
];

/** The serial schedule T1, T2, ... for a set. */
export const serialSchedule = (set: TxnSet): COp[] => set.txns.flat();

/**
 * Moves the operation at index i one place to the left, if the left neighbour belongs to another transaction
 * (so the order inside each transaction stays the same). Returns a new schedule, or the same one if not possible.
 */
export function moveLeft<T extends Op>(s: T[], i: number): T[] {
  if (i <= 0 || i >= s.length || s[i - 1]!.t === s[i]!.t) return s;
  const out = [...s];
  [out[i - 1], out[i]] = [out[i]!, out[i - 1]!];
  return out;
}

// ---------------------------------------------------------------- atomicity: bank transfers with a crash

export interface Transfer { from: string; to: string; amount: number }
export const TRANSFERS: Transfer[] = [
  { from: "A", to: "B", amount: 30 },
  { from: "B", to: "C", amount: 50 },
  { from: "C", to: "A", amount: 20 },
];
export const BANK_INIT: Record<string, number> = { A: 100, B: 100, C: 100 };

export type BankStep =
  | { kind: "debit" | "credit"; txn: number; acct: string; amount: number }
  | { kind: "commit"; txn: number };

/** Each transfer is: debit, credit, commit. */
export function bankSteps(transfers = TRANSFERS): BankStep[] {
  return transfers.flatMap((t, i): BankStep[] => [
    { kind: "debit", txn: i, acct: t.from, amount: t.amount },
    { kind: "credit", txn: i, acct: t.to, amount: t.amount },
    { kind: "commit", txn: i },
  ]);
}

export interface LogRec { txn: number; kind: "update" | "commit"; acct?: string; before?: number; after?: number }

export interface CrashResult {
  /** Disk state at the moment of the crash. */
  atCrash: Record<string, number>;
  /** Undo log on disk at the crash (empty when there is no log). */
  log: LogRec[];
  /** Disk state after restart and recovery. */
  recovered: Record<string, number>;
  /** Transfers that recovery rolled back. */
  undone: number[];
  total: number;
  committed: number;
}

export const totalMoney = (s: Record<string, number>) => Object.values(s).reduce((a, b) => a + b, 0);

/**
 * Runs the first `k` steps, then the machine crashes. Writes go to the disk in place.
 * With `atomic`, each update first appends an undo record (the old value) to a log that is forced to disk,
 * and recovery restores the old values of every transfer that has no commit record.
 */
export function bankCrash(k: number, atomic: boolean, transfers = TRANSFERS, init = BANK_INIT): CrashResult {
  const steps = bankSteps(transfers).slice(0, k);
  const disk = { ...init };
  const log: LogRec[] = [];
  let committed = 0;
  for (const s of steps) {
    if (s.kind === "commit") {
      committed++;
      if (atomic) log.push({ txn: s.txn, kind: "commit" });
      continue;
    }
    const before = disk[s.acct]!;
    const after = s.kind === "debit" ? before - s.amount : before + s.amount;
    if (atomic) log.push({ txn: s.txn, kind: "update", acct: s.acct, before, after });
    disk[s.acct] = after;
  }
  const atCrash = { ...disk };
  const recovered = { ...disk };
  const undone: number[] = [];
  if (atomic) {
    const done = new Set(log.filter((r) => r.kind === "commit").map((r) => r.txn));
    for (let i = log.length - 1; i >= 0; i--) {
      const r = log[i]!;
      if (r.kind === "update" && !done.has(r.txn)) {
        recovered[r.acct!] = r.before!;
        if (!undone.includes(r.txn)) undone.push(r.txn);
      }
    }
  }
  return { atCrash, log, recovered, undone, total: totalMoney(recovered), committed };
}

/** Crash points 0..n where the total money after recovery is wrong. */
export function badCrashPoints(atomic: boolean, transfers = TRANSFERS, init = BANK_INIT): number[] {
  const n = bankSteps(transfers).length;
  const want = totalMoney(init);
  return Array.from({ length: n + 1 }, (_, k) => k).filter((k) => bankCrash(k, atomic, transfers, init).total !== want);
}
