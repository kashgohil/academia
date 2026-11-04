/**
 * Data-centric query compilation (Neumann, VLDB 2011): the produce/consume model.
 *
 * Each operator has two functions. produce() asks the operator to generate code that produces all its
 * rows. consume(row, from) is called by a child for each row it makes, and generates the code that
 * handles one row. A scan's produce() opens a loop and calls the parent's consume() inside it, so all
 * operators of one pipeline end up in one loop body, with no calls between them.
 *
 * `generate(plan)` returns the code lines (Rust-like) and the ordered produce/consume/emit events, so a
 * demo can show the code grow step by step.
 *
 * Also here: a documented model of total query time (compile latency + rows × time per row) for an
 * interpreter, a vectorized engine, a compiled engine and adaptive execution (Kohn, Leis, Neumann 2018).
 */

export type CgPlan =
  | { op: "scan"; table: string; v: string }
  | { op: "filter"; cond: string; input: CgPlan }
  | { op: "join"; buildKey: string; probeKey: string; buildVar: string; build: CgPlan; probe: CgPlan }
  | { op: "agg"; groupBy?: string; init: string; update: string; input: CgPlan };

export interface CgLine { text: string; indent: number; op: number }
export type CgEvent =
  | { t: "produce"; op: number }
  | { t: "consume"; op: number; from: number }
  | { t: "emit"; op: number; line: number };

export interface CgNode { id: number; plan: CgPlan; label: string; kids: CgNode[] }

export function cgLabel(p: CgPlan): string {
  switch (p.op) {
    case "scan": return `scan ${p.table}`;
    case "filter": return `σ ${p.cond}`;
    case "join": return `⋈ ${p.buildKey} = ${p.probeKey}`;
    case "agg": return p.groupBy ? `γ ${p.groupBy}` : "γ sum";
  }
}

/** Numbers the operators in preorder and returns the tree. */
export function cgTree(p: CgPlan): CgNode {
  let id = 0;
  const go = (x: CgPlan): CgNode => {
    const me = id++;
    const kids = x.op === "scan" ? [] : x.op === "join" ? [go(x.build), go(x.probe)] : [go(x.input)];
    return { id: me, plan: x, label: cgLabel(x), kids };
  };
  return go(p);
}

/** Runs produce/consume over the tree and returns the generated lines and the event log. */
export function generate(plan: CgPlan): { tree: CgNode; lines: CgLine[]; events: CgEvent[] } {
  const tree = cgTree(plan);
  const lines: CgLine[] = [];
  const events: CgEvent[] = [];
  const parent = new Map<number, CgNode | null>();
  const walk = (n: CgNode, p: CgNode | null) => { parent.set(n.id, p); n.kids.forEach((k) => walk(k, n)); };
  walk(tree, null);
  let indent = 0;
  const emit = (op: number, text: string) => {
    if (text.startsWith("}")) indent--;
    lines.push({ text, indent, op });
    events.push({ t: "emit", op, line: lines.length - 1 });
    if (text.endsWith("{")) indent++;
  };
  const produce = (n: CgNode) => {
    events.push({ t: "produce", op: n.id });
    const p = n.plan;
    switch (p.op) {
      case "scan":
        emit(n.id, `for ${p.v} in ${p.table}.iter() {`);
        consume(parent.get(n.id)!, n);
        emit(n.id, "}");
        break;
      case "filter":
        produce(n.kids[0]!);
        break;
      case "join":
        emit(n.id, `let mut ht${n.id}: HashMap<Key, Vec<&Row>> = HashMap::new();`);
        produce(n.kids[0]!);
        produce(n.kids[1]!);
        break;
      case "agg":
        if (p.groupBy) emit(n.id, `let mut agg${n.id}: HashMap<Key, ${p.init.split(":")[1]?.trim() ?? "i64"}> = HashMap::new();`);
        else emit(n.id, `let mut ${p.init};`);
        produce(n.kids[0]!);
        if (p.groupBy) { emit(n.id, `for (k, v) in &agg${n.id} {`); emit(n.id, "out.push((k, v));"); emit(n.id, "}"); }
        else emit(n.id, `out.push(${p.init.split(/[:=]/)[0]!.trim()});`);
        break;
    }
  };
  const consume = (n: CgNode | null, from: CgNode) => {
    if (!n) { emit(from.id, "out.push(row);"); return; }
    events.push({ t: "consume", op: n.id, from: from.id });
    const p = n.plan;
    switch (p.op) {
      case "scan": throw new Error("a scan has no input");
      case "filter":
        emit(n.id, `if ${p.cond} {`);
        consume(parent.get(n.id)!, n);
        emit(n.id, "}");
        break;
      case "join":
        if (from.id === n.kids[0]!.id) {
          emit(n.id, `ht${n.id}.entry(${p.buildKey}).or_default().push(${p.buildVar});`);
        } else {
          emit(n.id, `if let Some(ms) = ht${n.id}.get(&${p.probeKey}) {`);
          emit(n.id, `for ${p.buildVar} in ms {`);
          consume(parent.get(n.id)!, n);
          emit(n.id, "}");
          emit(n.id, "}");
        }
        break;
      case "agg":
        if (p.groupBy) emit(n.id, `*agg${n.id}.entry(${p.groupBy}).or_insert(0) += ${p.update};`);
        else emit(n.id, `${p.init.split(/[:=]/)[0]!.trim()} += ${p.update};`);
        break;
    }
  };
  produce(tree);
  return { tree, lines, events };
}

/** Number of top-level-or-nested loops over base tables (= pipelines that start at a scan). */
export const scanLoops = (lines: CgLine[]) => lines.filter((l) => /^for \w+ in \w+\.iter\(\) \{$/.test(l.text)).length;

export const CG_PLANS: { id: string; label: string; sql: string; plan: CgPlan }[] = [
  {
    id: "q1",
    label: "filter + sum",
    sql: "SELECT SUM(l.price * l.qty) FROM lineitem l WHERE l.shipdate < '1998-09-01'",
    plan: { op: "agg", init: "sum: f64 = 0.0", update: "l.price * l.qty", input: { op: "filter", cond: "l.shipdate < D1998_09_01", input: { op: "scan", table: "lineitem", v: "l" } } },
  },
  {
    id: "join",
    label: "join + group by",
    sql: "SELECT c.city, SUM(o.amount) FROM customer c JOIN orders o ON o.cid = c.id WHERE c.age > 30 GROUP BY c.city",
    plan: {
      op: "agg", groupBy: "c.city", init: "agg: i64", update: "o.amount",
      input: {
        op: "join", buildKey: "c.id", probeKey: "o.cid", buildVar: "c",
        build: { op: "filter", cond: "c.age > 30", input: { op: "scan", table: "customer", v: "c" } },
        probe: { op: "scan", table: "orders", v: "o" },
      },
    },
  },
  {
    id: "two",
    label: "two joins",
    sql: "SELECT n.name, SUM(o.amount) FROM nation n JOIN customer c ON c.nid = n.id JOIN orders o ON o.cid = c.id WHERE o.year = 2024 GROUP BY n.name",
    plan: {
      op: "agg", groupBy: "n.name", init: "agg: i64", update: "o.amount",
      input: {
        op: "join", buildKey: "c.id", probeKey: "o.cid", buildVar: "c",
        build: {
          op: "join", buildKey: "n.id", probeKey: "c.nid", buildVar: "n",
          build: { op: "scan", table: "nation", v: "n" },
          probe: { op: "scan", table: "customer", v: "c" },
        },
        probe: { op: "filter", cond: "o.year == 2024", input: { op: "scan", table: "orders", v: "o" } },
      },
    },
  },
];

// ------------------------------------------------------------------ break-even model

export type Engine = "volcano" | "vector" | "compiled" | "adaptive";
export type Workload = "compute" | "memory";

/**
 * Time per row (ns) of one pipeline with a few operators. Assumptions, not measurements. They follow the
 * shape of published results: a tuple-at-a-time interpreter is about ten times slower than both modern
 * designs; compiled code wins on computation-heavy queries (TPC-H Q1), and vectorized code wins slightly on
 * memory-bound hash joins (TPC-H Q3, Q9), as Kersten et al. (VLDB 2018) found. `bytecode` is the fast-start
 * interpreter of adaptive execution.
 */
export const NS_PER_ROW: Record<Workload, { volcano: number; vector: number; compiled: number; bytecode: number }> = {
  compute: { volcano: 50, vector: 5, compiled: 3, bytecode: 15 },
  memory: { volcano: 60, vector: 10, compiled: 12, bytecode: 25 },
};

/**
 * Total time in ms for `rows` rows. The compiled engine pays `compileMs` before the first row. Adaptive
 * execution starts at once in the bytecode interpreter, compiles in the background, and switches to
 * machine code when the compiler is done (if the query is still running).
 */
export function engineTime(e: Engine, rows: number, compileMs: number, w: Workload): number {
  const c = NS_PER_ROW[w];
  switch (e) {
    case "volcano": return (rows * c.volcano) / 1e6;
    case "vector": return (rows * c.vector) / 1e6;
    case "compiled": return compileMs + (rows * c.compiled) / 1e6;
    case "adaptive": {
      const slow = (rows * c.bytecode) / 1e6;
      if (slow <= compileMs) return slow;
      const done = compileMs * 1e6 / c.bytecode; // rows finished before the machine code is ready
      return compileMs + ((rows - done) * c.compiled) / 1e6;
    }
  }
}

/** Rows at which engine a and engine b take the same time (null if a never catches up). */
export function breakEven(a: Engine, b: Engine, compileMs: number, w: Workload): number | null {
  if (a !== "compiled") throw new Error("breakEven: a must be the compiled engine");
  const c = NS_PER_ROW[w];
  const slope = c[b as "volcano" | "vector"] - c.compiled;
  if (slope <= 0) return null;
  return (compileMs * 1e6) / slope;
}

/** PostgreSQL JIT thresholds (planner cost units), defaults since PostgreSQL 11. */
export const PG_JIT = { jit_above_cost: 100_000, jit_inline_above_cost: 500_000, jit_optimize_above_cost: 500_000 };
