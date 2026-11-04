/**
 * The Volcano iterator model (Graefe 1994): every operator has open(), next() and close().
 * next() returns one row, or null at the end. A parent pulls rows from its children one call at a time.
 *
 * Instrumentation: one `Ctx` per query. `ctx.clock` counts next() calls (the time axis of the demos).
 * Each operator counts the next() calls it receives and the rows it returns. With `ctx.trace` on, every
 * call, return and memory change is logged as an `IterEvent`, so a demo can replay the flow step by step.
 *
 * Blocking operators (pipeline breakers) consume their whole input before they return the first row:
 * the build side of HashJoin, Sort and HashAgg. They report the rows they hold (`held`), so demos can
 * plot memory over time. `pipelines()` cuts a plan into pipelines at these breakers.
 */
import { compare, compilePred, type Pred } from "./expr";
import { hasCol, resolve, rowKey, type Col, type Db, type Row, type Value } from "./relation";
import { aggName, schemaOf, type Agg, type Plan } from "./algebra";

export type IterEvent =
  | { t: "call"; op: number; clock: number }
  | { t: "ret"; op: number; row: Row | null; clock: number }
  | { t: "mem"; op: number; held: number; clock: number };

export class Ctx {
  clock = 0;
  events: IterEvent[] = [];
  ops: Op[] = [];
  constructor(public trace = false) {}
}

export interface OpStats { nexts: number; rows: number; held: number; peak: number; firstRowAt: number | null }

export abstract class Op {
  readonly id: number;
  stats: OpStats = { nexts: 0, rows: 0, held: 0, peak: 0, firstRowAt: null };
  abstract readonly name: string;
  abstract readonly cols: Col[];
  /** True if this operator must read a whole input before its first output row. */
  readonly blocking: boolean = false;
  constructor(public ctx: Ctx, public kids: Op[]) {
    this.id = ctx.ops.length;
    ctx.ops.push(this);
  }
  open(): void { for (const k of this.kids) k.open(); }
  close(): void { for (const k of this.kids) k.close(); }
  /** Instrumented next(): counts the call, logs it, and delegates to the operator logic. */
  next(): Row | null {
    const c = this.ctx;
    c.clock++;
    this.stats.nexts++;
    if (c.trace) c.events.push({ t: "call", op: this.id, clock: c.clock });
    const r = this.produce();
    if (r) { this.stats.rows++; this.stats.firstRowAt ??= c.clock; }
    if (c.trace) c.events.push({ t: "ret", op: this.id, row: r, clock: c.clock });
    return r;
  }
  protected setHeld(n: number) {
    this.stats.held = n;
    this.stats.peak = Math.max(this.stats.peak, n);
    if (this.ctx.trace) this.ctx.events.push({ t: "mem", op: this.id, held: n, clock: this.ctx.clock });
  }
  protected abstract produce(): Row | null;
  /** Short parameter text for display. */
  detail(): string { return ""; }
}

export class Scan extends Op {
  readonly name = "Scan";
  private i = 0;
  constructor(ctx: Ctx, public table: string, public readonly rows: Row[], public readonly cols: Col[]) { super(ctx, []); }
  open() { this.i = 0; }
  protected produce() { return this.i < this.rows.length ? this.rows[this.i++]! : null; }
  detail() { return this.table; }
}

export class Filter extends Op {
  readonly name = "Filter";
  readonly cols: Col[];
  private f: (r: Row) => boolean | null;
  constructor(ctx: Ctx, input: Op, private text: string, pred: Pred | ((r: Row) => boolean | null)) {
    super(ctx, [input]);
    this.cols = input.cols;
    this.f = typeof pred === "function" ? pred : compilePred(pred, input.cols);
  }
  protected produce() {
    for (let r = this.kids[0]!.next(); r; r = this.kids[0]!.next()) if (this.f(r) === true) return r;
    return null;
  }
  detail() { return this.text; }
}

export class Project extends Op {
  readonly name = "Project";
  readonly cols: Col[];
  private idx: number[];
  constructor(ctx: Ctx, input: Op, refs: string[]) {
    super(ctx, [input]);
    this.idx = refs.map((r) => resolve(input.cols, r));
    this.cols = this.idx.map((i) => input.cols[i]!);
  }
  protected produce() { const r = this.kids[0]!.next(); return r ? this.idx.map((i) => r[i]!) : null; }
  detail() { return this.cols.map((c) => c.name).join(", "); }
}

/** Tuple nested-loop join: for each outer row, rescan the inner input (close + open). */
export class NestedLoopJoin extends Op {
  readonly name = "NLJoin";
  readonly cols: Col[];
  private outer: Row | null = null;
  private f: (r: Row) => boolean | null;
  constructor(ctx: Ctx, outer: Op, inner: Op, private text: string, pred: Pred) {
    super(ctx, [outer, inner]);
    this.cols = [...outer.cols, ...inner.cols];
    this.f = compilePred(pred, this.cols);
  }
  open() { super.open(); this.outer = null; }
  protected produce() {
    const [o, i] = this.kids as [Op, Op];
    for (;;) {
      if (!this.outer) { this.outer = o.next(); if (!this.outer) return null; i.close(); i.open(); }
      for (let r = i.next(); r; r = i.next()) { const row = [...this.outer, ...r]; if (this.f(row) === true) return row; }
      this.outer = null;
    }
  }
  detail() { return this.text; }
}

/** Hash join. Child 0 is the build side (read fully on the first next()), child 1 the probe side. */
export class HashJoin extends Op {
  readonly name = "HashJoin";
  readonly blocking = true;
  readonly cols: Col[];
  private ht: Map<Value, Row[]> | null = null;
  private probe: Row | null = null;
  private matches: Row[] = [];
  private mi = 0;
  private bk: number;
  private pk: number;
  constructor(ctx: Ctx, build: Op, probe: Op, buildKey: string, probeKey: string) {
    super(ctx, [build, probe]);
    this.bk = resolve(build.cols, buildKey);
    this.pk = resolve(probe.cols, probeKey);
    this.cols = [...build.cols, ...probe.cols];
  }
  open() { super.open(); this.ht = null; this.probe = null; this.matches = []; this.mi = 0; }
  protected produce() {
    const [b, p] = this.kids as [Op, Op];
    if (!this.ht) {
      this.ht = new Map();
      let n = 0;
      for (let r = b.next(); r; r = b.next()) {
        const k = r[this.bk]!;
        if (k === null) continue; // NULL keys never match
        const l = this.ht.get(k);
        if (l) l.push(r); else this.ht.set(k, [r]);
        this.setHeld(++n);
      }
    }
    for (;;) {
      if (this.probe && this.mi < this.matches.length) return [...this.matches[this.mi++]!, ...this.probe];
      this.probe = p.next();
      if (!this.probe) return null;
      const k = this.probe[this.pk]!;
      this.matches = k === null ? [] : this.ht.get(k) ?? [];
      this.mi = 0;
    }
  }
  close() { super.close(); this.ht = null; this.setHeld(0); }
  detail() { return `${this.kids[0]!.cols[this.bk]!.name} = ${this.kids[1]!.cols[this.pk]!.name}`; }
}

export class Sort extends Op {
  readonly name = "Sort";
  readonly blocking = true;
  readonly cols: Col[];
  private buf: Row[] | null = null;
  private i = 0;
  private k: number;
  constructor(ctx: Ctx, input: Op, key: string, private desc = false) {
    super(ctx, [input]);
    this.cols = input.cols;
    this.k = resolve(input.cols, key);
  }
  open() { super.open(); this.buf = null; this.i = 0; }
  protected produce() {
    if (!this.buf) {
      this.buf = [];
      for (let r = this.kids[0]!.next(); r; r = this.kids[0]!.next()) { this.buf.push(r); this.setHeld(this.buf.length); }
      const k = this.k, s = this.desc ? -1 : 1;
      // NULLs sort last (PostgreSQL default for ASC).
      this.buf.sort((a, b) => (a[k] === null ? 1 : b[k] === null ? -1 : compare("<", a[k]!, b[k]!) ? -s : compare(">", a[k]!, b[k]!) ? s : 0));
    }
    return this.i < this.buf.length ? this.buf[this.i++]! : null;
  }
  close() { super.close(); this.buf = null; this.setHeld(0); }
  detail() { return `${this.cols[this.k]!.name}${this.desc ? " desc" : ""}`; }
}

export class Limit extends Op {
  readonly name = "Limit";
  readonly cols: Col[];
  private n = 0;
  constructor(ctx: Ctx, input: Op, private limit: number) { super(ctx, [input]); this.cols = input.cols; }
  open() { super.open(); this.n = 0; }
  protected produce() { if (this.n >= this.limit) return null; const r = this.kids[0]!.next(); if (r) this.n++; return r; }
  detail() { return String(this.limit); }
}

/** Hash aggregation: reads all input on the first next(), then returns one row per group. */
export class HashAgg extends Op {
  readonly name = "HashAgg";
  readonly blocking = true;
  readonly cols: Col[];
  private out: Row[] | null = null;
  private i = 0;
  private ki: number[];
  private ai: (number | null)[];
  constructor(ctx: Ctx, input: Op, keys: string[], private aggs: Agg[]) {
    super(ctx, [input]);
    this.ki = keys.map((k) => resolve(input.cols, k));
    this.ai = aggs.map((a) => (a.col ? resolve(input.cols, a.col) : null));
    this.cols = [...this.ki.map((i) => input.cols[i]!), ...aggs.map((a) => ({ rel: "", name: aggName(a) }))];
  }
  open() { super.open(); this.out = null; this.i = 0; }
  protected produce() {
    if (!this.out) {
      const g = new Map<string, { key: Value[]; acc: { n: number; s: number; m: Value }[] }>();
      for (let r = this.kids[0]!.next(); r; r = this.kids[0]!.next()) {
        const key = this.ki.map((i) => r[i]!), ks = rowKey(key);
        let e = g.get(ks);
        if (!e) { g.set(ks, (e = { key, acc: this.aggs.map(() => ({ n: 0, s: 0, m: null })) })); this.setHeld(g.size); }
        this.aggs.forEach((a, j) => {
          const v = this.ai[j] === null ? 1 : r[this.ai[j]!]!;
          if (v === null) return;
          const s = e!.acc[j]!;
          s.n++;
          if (typeof v === "number") s.s += v;
          if (s.m === null || (a.fn === "min" ? v < s.m : v > s.m)) s.m = v;
        });
      }
      this.out = [...g.values()].map((e) => [...e.key, ...this.aggs.map((a, j) => {
        const s = e.acc[j]!;
        return a.fn === "count" ? s.n : s.n === 0 ? null : a.fn === "sum" ? s.s : a.fn === "avg" ? Math.round((s.s / s.n) * 100) / 100 : s.m;
      })]);
    }
    return this.i < this.out.length ? this.out[this.i++]! : null;
  }
  close() { super.close(); this.out = null; this.setHeld(0); }
  detail() { return this.cols.map((c) => c.name).join(", "); }
}

/** Runs a plan to completion: open, next() until null, close. Returns all rows. */
export function runAll(root: Op): Row[] {
  const out: Row[] = [];
  root.open();
  for (let r = root.next(); r; r = root.next()) out.push(r);
  root.close();
  return out;
}

/**
 * Builds iterators from an algebra plan. A theta join with an equality conjunct becomes a HashJoin
 * (left input = build side), any other join a NestedLoopJoin. γ becomes HashAgg, δ a HashAgg with no aggregates.
 */
export function fromPlan(plan: Plan, db: Db, ctx: Ctx): Op {
  const go = (p: Plan): Op => {
    switch (p.op) {
      case "scan": return new Scan(ctx, p.table, db[p.table]!.rows, db[p.table]!.cols);
      case "rename": {
        if (p.input.op !== "scan") throw new Error("fromPlan: rename only over a scan");
        return new Scan(ctx, p.alias, db[p.input.table]!.rows, schemaOf(p, db));
      }
      case "select": return new Filter(ctx, go(p.input), "", p.pred);
      case "project": return new Project(ctx, go(p.input), p.cols);
      case "group": return new HashAgg(ctx, go(p.input), p.keys, p.aggs);
      case "distinct": { const x = go(p.input); return new HashAgg(ctx, x, x.cols.map((c) => `${c.rel}.${c.name}`), []); }
      case "join": {
        const l = go(p.left), r = go(p.right);
        const eq = p.pred && p.pred.k === "cmp" && p.pred.op === "=" && "col" in p.pred.l && "col" in p.pred.r ? p.pred : null;
        if (eq && "col" in eq.l && "col" in eq.r) {
          const [a, b] = [eq.l.col, eq.r.col];
          return hasCol(l.cols, a) ? new HashJoin(ctx, l, r, a, b) : new HashJoin(ctx, l, r, b, a);
        }
        return new NestedLoopJoin(ctx, l, r, "", p.pred ?? { k: "true" });
      }
      default: throw new Error(`fromPlan: ${p.op} is not supported`);
    }
  };
  return go(plan);
}

// ------------------------------------------------------------------ pipelines

export interface Pipeline { ops: number[]; breaker: number | null }

/**
 * Cuts the operator tree into pipelines. A pipeline starts at a leaf or at the output of a blocking
 * operator and ends at the next blocking input (a hash build, a sort, an aggregation) or at the root.
 * Pipelines are listed in execution order: a pipeline runs after all pipelines that feed its breakers.
 */
export function pipelines(root: Op): Pipeline[] {
  const out: Pipeline[] = [];
  // Returns the pipeline (list of op ids) that is still open at `op` (flowing up to its parent).
  const go = (op: Op): number[] => {
    if (op.kids.length === 0) return [op.id];
    if (op instanceof HashJoin) {
      const build = go(op.kids[0]!);
      out.push({ ops: build, breaker: op.id });
      const probe = go(op.kids[1]!);
      return [...probe, op.id];
    }
    if (op.blocking) {
      const inp = go(op.kids[0]!);
      out.push({ ops: inp, breaker: op.id });
      return [op.id];
    }
    if (op instanceof NestedLoopJoin) {
      const outer = go(op.kids[0]!);
      const inner = go(op.kids[1]!);
      out.push({ ops: inner, breaker: op.id });
      return [...outer, op.id];
    }
    return [...go(op.kids[0]!), op.id];
  };
  out.push({ ops: go(root), breaker: null });
  return out;
}

/** Function calls of a run under the pull model and under a push model (one consume() per row passed up). */
export function callCounts(ctx: Ctx): { pull: number; push: number } {
  const pull = ctx.ops.reduce((a, o) => a + o.stats.nexts, 0);
  const push = ctx.ops.reduce((a, o) => a + o.stats.rows, 0) + ctx.ops.length; // + one produce() per operator
  return { pull, push };
}
