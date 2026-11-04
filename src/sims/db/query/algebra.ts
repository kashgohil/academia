/**
 * Relational algebra: plan trees, a bag-semantics evaluator, and equivalence rules for rewriting.
 *
 * Operators: scan, σ select, π project (keeps duplicates, like SQL), δ distinct, ρ rename, × cross,
 * ⋈θ theta join, ⋈ natural join, ∪ ∩ − (set semantics: they remove duplicates, as SQL UNION, INTERSECT and
 * EXCEPT do; `all: true` keeps them), γ group with aggregates.
 *
 * `evalPlan` materializes every node and returns each intermediate result, keyed by node path
 * ("" is the root, "0" its first child, "0.1" the second child of that, ...).
 *
 * Rewrite rules (each returns a new plan, the input is not changed): `cascadeSelections`,
 * `pushSelections`, `selectionsToJoins`, `reassociate`, `pushProjections`. `rewriteSteps` applies them
 * in the order of a textbook heuristic optimizer and records each plan.
 */
import { cmp, compilePred, conj, conjuncts, predCols, predText, type Pred } from "./expr";
import { colName, hasCol, resolve, rowKey, type Col, type Db, type Relation, type Row, type Value } from "./relation";

export type AggFn = "count" | "sum" | "avg" | "min" | "max";
export interface Agg { fn: AggFn; col?: string }

export type Plan =
  | { op: "scan"; table: string }
  | { op: "select"; pred: Pred; input: Plan }
  | { op: "project"; cols: string[]; input: Plan }
  | { op: "distinct"; input: Plan }
  | { op: "rename"; alias: string; input: Plan }
  | { op: "join"; kind: "cross" | "theta" | "natural"; pred?: Pred; left: Plan; right: Plan }
  | { op: "union" | "intersect" | "except"; all?: boolean; left: Plan; right: Plan }
  | { op: "group"; keys: string[]; aggs: Agg[]; input: Plan };

// ------------------------------------------------------------------ builders
export const scan = (table: string): Plan => ({ op: "scan", table });
export const select = (pred: Pred, input: Plan): Plan => ({ op: "select", pred, input });
export const project = (cols: string[], input: Plan): Plan => ({ op: "project", cols, input });
export const distinct = (input: Plan): Plan => ({ op: "distinct", input });
export const rename = (alias: string, input: Plan): Plan => ({ op: "rename", alias, input });
export const cross = (left: Plan, right: Plan): Plan => ({ op: "join", kind: "cross", left, right });
export const join = (pred: Pred, left: Plan, right: Plan): Plan => ({ op: "join", kind: "theta", pred, left, right });
export const natural = (left: Plan, right: Plan): Plan => ({ op: "join", kind: "natural", left, right });
export const setop = (op: "union" | "intersect" | "except", left: Plan, right: Plan, all = false): Plan => ({ op, all, left, right });
export const group = (keys: string[], aggs: Agg[], input: Plan): Plan => ({ op: "group", keys, aggs, input });

export function children(p: Plan): Plan[] {
  return "input" in p ? [p.input] : "left" in p ? [p.left, p.right] : [];
}
function withChildren(p: Plan, kids: Plan[]): Plan {
  if ("input" in p) return { ...p, input: kids[0]! };
  if ("left" in p) return { ...p, left: kids[0]!, right: kids[1]! };
  return p;
}

export const aggName = (a: Agg) => `${a.fn}(${a.col ?? "*"})`;

// ------------------------------------------------------------------ schemas
const naturalCommon = (l: Col[], r: Col[]) => [...new Set(l.map((c) => c.name))].filter((n) => r.some((c) => c.name === n));

export function schemaOf(p: Plan, db: Db): Col[] {
  switch (p.op) {
    case "scan": { const t = db[p.table]; if (!t) throw new Error(`unknown table ${p.table}`); return t.cols; }
    case "select": case "distinct": return schemaOf(p.input, db);
    case "project": { const c = schemaOf(p.input, db); return p.cols.map((r) => c[resolve(c, r)]!); }
    case "rename": return schemaOf(p.input, db).map((c) => ({ rel: p.alias, name: c.name }));
    case "join": {
      const l = schemaOf(p.left, db), r = schemaOf(p.right, db);
      if (p.kind !== "natural") return [...l, ...r];
      const common = naturalCommon(l, r);
      return [...l, ...r.filter((c) => !common.includes(c.name))];
    }
    case "union": case "intersect": case "except": return schemaOf(p.left, db);
    case "group": {
      const c = schemaOf(p.input, db);
      return [...p.keys.map((k) => c[resolve(c, k)]!), ...p.aggs.map((a) => ({ rel: "", name: aggName(a) }))];
    }
  }
}

/** True if every column of `pred` resolves in the schema of `p`. */
export const covers = (p: Plan, pred: Pred, db: Db) => {
  const s = schemaOf(p, db);
  return predCols(pred).every((c) => hasCol(s, c));
};

// ------------------------------------------------------------------ evaluation
function dedup(rows: Row[]): Row[] {
  const seen = new Set<string>();
  return rows.filter((r) => { const k = rowKey(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

function aggregate(a: Agg, rows: Row[], cols: Col[]): Value {
  if (a.fn === "count" && !a.col) return rows.length;
  const i = resolve(cols, a.col!);
  const vs = rows.map((r) => r[i]!).filter((v) => v !== null);
  if (a.fn === "count") return vs.length;
  if (vs.length === 0) return null; // SUM, AVG, MIN, MAX of no values is NULL
  if (a.fn === "min") return vs.reduce((x, y) => (y < x ? y : x));
  if (a.fn === "max") return vs.reduce((x, y) => (y > x ? y : x));
  const s = (vs as number[]).reduce((x, y) => x + y, 0);
  return a.fn === "sum" ? s : Math.round((s / vs.length) * 100) / 100;
}

export interface EvalResult { result: Relation; nodes: Map<string, Relation> }

/** Evaluates a plan bottom-up and keeps every intermediate result. */
export function evalPlan(plan: Plan, db: Db): EvalResult {
  const nodes = new Map<string, Relation>();
  const go = (p: Plan, path: string): Relation => {
    const kid = (i: number) => go(children(p)[i]!, path === "" ? String(i) : `${path}.${i}`);
    let out: Relation;
    switch (p.op) {
      case "scan": out = db[p.table]!; break;
      case "select": {
        const x = kid(0), f = compilePred(p.pred, x.cols);
        out = { cols: x.cols, rows: x.rows.filter((r) => f(r) === true) };
        break;
      }
      case "project": {
        const x = kid(0), idx = p.cols.map((c) => resolve(x.cols, c));
        out = { cols: idx.map((i) => x.cols[i]!), rows: x.rows.map((r) => idx.map((i) => r[i]!)) };
        break;
      }
      case "distinct": { const x = kid(0); out = { cols: x.cols, rows: dedup(x.rows) }; break; }
      case "rename": { const x = kid(0); out = { cols: x.cols.map((c) => ({ rel: p.alias, name: c.name })), rows: x.rows }; break; }
      case "join": {
        const l = kid(0), r = kid(1);
        if (p.kind === "natural") {
          const common = naturalCommon(l.cols, r.cols);
          const li = common.map((n) => l.cols.findIndex((c) => c.name === n));
          const ri = common.map((n) => r.cols.findIndex((c) => c.name === n));
          const keep = r.cols.map((_, i) => i).filter((i) => !ri.includes(i));
          const rows: Row[] = [];
          for (const a of l.rows) for (const b of r.rows) {
            // NULL never equals anything, so a NULL in a common column never joins.
            if (li.every((x, k) => a[x] !== null && a[x] === b[ri[k]!])) rows.push([...a, ...keep.map((i) => b[i]!)]);
          }
          out = { cols: [...l.cols, ...keep.map((i) => r.cols[i]!)], rows };
        } else {
          const cols = [...l.cols, ...r.cols];
          const f = p.kind === "theta" && p.pred ? compilePred(p.pred, cols) : null;
          const rows: Row[] = [];
          for (const a of l.rows) for (const b of r.rows) {
            const row = [...a, ...b];
            if (!f || f(row) === true) rows.push(row);
          }
          out = { cols, rows };
        }
        break;
      }
      case "union": case "intersect": case "except": {
        const l = kid(0), r = kid(1);
        if (l.cols.length !== r.cols.length) throw new Error(`${p.op} needs inputs with the same number of columns`);
        if (p.op === "union") out = { cols: l.cols, rows: p.all ? [...l.rows, ...r.rows] : dedup([...l.rows, ...r.rows]) };
        else {
          const counts = new Map<string, number>();
          for (const x of r.rows) counts.set(rowKey(x), (counts.get(rowKey(x)) ?? 0) + 1);
          const rows: Row[] = [];
          for (const x of p.all ? l.rows : dedup(l.rows)) {
            const k = rowKey(x), n = counts.get(k) ?? 0;
            const inRight = n > 0;
            if (p.all && inRight) counts.set(k, n - 1);
            if ((p.op === "intersect") === inRight) rows.push(x);
          }
          out = { cols: l.cols, rows };
        }
        break;
      }
      case "group": {
        const x = kid(0), ki = p.keys.map((k) => resolve(x.cols, k));
        const groups = new Map<string, { key: Value[]; rows: Row[] }>();
        for (const r of x.rows) {
          const key = ki.map((i) => r[i]!), k = JSON.stringify(key); // NULL keys form one group
          let g = groups.get(k);
          if (!g) groups.set(k, (g = { key, rows: [] }));
          g.rows.push(r);
        }
        // With no GROUP BY columns, an empty input still gives one row (COUNT(*) = 0).
        if (ki.length === 0 && groups.size === 0) groups.set("[]", { key: [], rows: [] });
        out = { cols: schemaOf(p, db), rows: [...groups.values()].map((g) => [...g.key, ...p.aggs.map((a) => aggregate(a, g.rows, x.cols))]) };
        break;
      }
    }
    nodes.set(path, out);
    return out;
  };
  return { result: go(plan, ""), nodes };
}

/**
 * Work of a plan: the rows and the values (rows × columns) that its operators produce.
 * Scans and renames do not count, because every plan for the query reads the same tables.
 * A projection does not count either: it never stores rows, it only makes the rows of its input narrower.
 * So pushing a projection down shows up as narrower rows in the operators above the scans.
 */
export function planWork(plan: Plan, r: EvalResult): { tuples: number; values: number } {
  let tuples = 0, values = 0;
  for (const { path, plan: p } of nodesOf(plan)) {
    if (p.op === "scan" || p.op === "rename" || p.op === "project") continue;
    const rel = r.nodes.get(path)!;
    tuples += rel.rows.length;
    values += rel.rows.length * rel.cols.length;
  }
  return { tuples, values };
}

// ------------------------------------------------------------------ display
export interface NodeLabel { sym: string; sub: string }
export function label(p: Plan): NodeLabel {
  switch (p.op) {
    case "scan": return { sym: p.table, sub: "" };
    case "select": return { sym: "σ", sub: predText(p.pred) };
    case "project": return { sym: "π", sub: p.cols.join(", ") };
    case "distinct": return { sym: "δ", sub: "" };
    case "rename": return { sym: "ρ", sub: p.alias };
    case "join": return p.kind === "cross" ? { sym: "×", sub: "" } : p.kind === "natural" ? { sym: "⋈", sub: "natural" } : { sym: "⋈", sub: predText(p.pred!) };
    case "union": return { sym: p.all ? "∪ all" : "∪", sub: "" };
    case "intersect": return { sym: "∩", sub: "" };
    case "except": return { sym: "−", sub: "" };
    case "group": return { sym: "γ", sub: [...p.keys, ...p.aggs.map(aggName)].join(", ") };
  }
}

/** One-line algebra text, e.g. π_{name}(σ_{salary > 55}(emp)). */
export function planText(p: Plan): string {
  const l = label(p), k = children(p).map(planText);
  if (p.op === "scan") return p.table;
  if (k.length === 2) return `(${k[0]} ${l.sym}${l.sub && l.sub !== "natural" ? `[${l.sub}]` : ""} ${k[1]})`;
  return `${l.sym}${l.sub ? `[${l.sub}]` : ""}(${k[0]})`;
}

/** Every node with its path, in preorder. */
export function nodesOf(p: Plan, path = ""): { path: string; plan: Plan }[] {
  return [{ path, plan: p }, ...children(p).flatMap((c, i) => nodesOf(c, path === "" ? String(i) : `${path}.${i}`))];
}

// ------------------------------------------------------------------ SQL -> canonical algebra
/** A SELECT-FROM-WHERE block. `from` lists [table, alias]. */
export interface SqlBlock { select: string[]; from: [string, string][]; where: Pred[]; distinct?: boolean }

/** Canonical translation: π_select(σ_where(T1 × T2 × ... )), each table renamed to its alias. */
export function canonical(q: SqlBlock): Plan {
  const leaves = q.from.map(([t, a]) => (a === t ? scan(t) : rename(a, scan(t))));
  const prod = leaves.reduce((acc, x) => cross(acc, x));
  const body = q.where.length ? select(conj(q.where), prod) : prod;
  const proj = project(q.select, body);
  return q.distinct ? distinct(proj) : proj;
}

export function sqlText(q: SqlBlock): string {
  return [
    `SELECT ${q.distinct ? "DISTINCT " : ""}${q.select.join(", ")}`,
    `FROM ${q.from.map(([t, a]) => (t === a ? t : `${t} ${a}`)).join(", ")}`,
    ...(q.where.length ? [`WHERE ${q.where.map((p) => predText(p, true)).join("\n  AND ")}`] : []),
  ].join("\n");
}

// ------------------------------------------------------------------ equivalence rules
const mapUp = (p: Plan, f: (p: Plan) => Plan): Plan => f(withChildren(p, children(p).map((c) => mapUp(c, f))));

/** σ_{a∧b}(X) ≡ σ_a(σ_b(X)): split every conjunctive selection into a cascade. */
export function cascadeSelections(plan: Plan): Plan {
  return mapUp(plan, (p) => (p.op === "select" ? conjuncts(p.pred).reduceRight<Plan>((acc, c) => select(c, acc), p.input) : p));
}

/** Places one predicate as low as possible in `n`. */
function pushInto(pred: Pred, n: Plan, db: Db): Plan {
  if (n.op === "join" && n.kind !== "natural") {
    if (covers(n.left, pred, db)) return { ...n, left: pushInto(pred, n.left, db) };
    if (covers(n.right, pred, db)) return { ...n, right: pushInto(pred, n.right, db) };
  }
  if (n.op === "select") return select(n.pred, pushInto(pred, n.input, db)); // σ_a(σ_b(X)) ≡ σ_b(σ_a(X))
  return select(pred, n);
}

/**
 * Selection pushdown: σ_p(A × B) ≡ σ_p(A) × B when p uses only columns of A. Each conjunct moves to the
 * lowest node whose schema covers it. Predicates that need both sides stay above the product.
 */
export function pushSelections(plan: Plan, db: Db): Plan {
  const go = (p: Plan): Plan => {
    if (p.op === "select") {
      let x = go(p.input);
      for (const c of conjuncts(p.pred)) x = pushInto(c, x, db);
      return x;
    }
    return withChildren(p, children(p).map(go));
  };
  return go(plan);
}

/** σ_p(A × B) ≡ A ⋈_p B, and σ_p(A ⋈_q B) ≡ A ⋈_{q∧p} B. */
export function selectionsToJoins(plan: Plan): Plan {
  return mapUp(plan, (p) => {
    if (p.op !== "select" || p.input.op !== "join" || p.input.kind === "natural") return p;
    const j = p.input;
    return { ...j, kind: "theta", pred: conj([...(j.pred ? conjuncts(j.pred) : []), p.pred]) };
  });
}

/**
 * Join associativity at the first join found from the root: (A ⋈_p B) ⋈_q C ≡ A ⋈_{p'} (B ⋈_{q'} C).
 * Conjuncts of p and q that use only B and C go to the inner join; the others stay outside.
 */
export function reassociate(plan: Plan, db: Db): Plan {
  if (plan.op === "join" && plan.left.op === "join" && plan.kind !== "natural" && plan.left.kind !== "natural") {
    const { left: ab, right: c } = plan;
    const a = ab.left, b = ab.right;
    const all = [...(ab.pred ? conjuncts(ab.pred) : []), ...(plan.pred ? conjuncts(plan.pred) : [])];
    const bc = cross(b, c);
    const inner = all.filter((x) => covers(bc, x, db)), outer = all.filter((x) => !covers(bc, x, db));
    const mk = (ps: Pred[], l: Plan, r: Plan): Plan => (ps.length ? join(conj(ps), l, r) : cross(l, r));
    return mk(outer, a, mk(inner, b, c));
  }
  const k = children(plan);
  if (k.length === 0) return plan;
  return withChildren(plan, k.map((x) => reassociate(x, db)));
}

/**
 * Projection pushdown: keep only the columns that some operator above still needs.
 * A π goes directly above each base scan (and above a selection on a scan), as a column-pruning pass does.
 */
export function pushProjections(plan: Plan, db: Db): Plan {
  const q = (p: Plan, refs: string[]) => { const s = schemaOf(p, db); return refs.filter((r) => hasCol(s, r)).map((r) => colName(s[resolve(s, r)]!)); };
  const prune = (p: Plan, need: Set<string>): Plan => {
    const wrap = (x: Plan) => {
      const s = schemaOf(x, db).map(colName);
      const keep = s.filter((c) => need.has(c));
      return keep.length < s.length ? project(keep, x) : x;
    };
    switch (p.op) {
      case "scan": case "rename": return wrap(p);
      case "select": {
        if (p.input.op === "scan" || p.input.op === "rename") return wrap(p);
        return select(p.pred, prune(p.input, new Set([...need, ...q(p.input, predCols(p.pred))])));
      }
      case "project": return project(p.cols, prune(p.input, new Set(q(p.input, p.cols))));
      case "join": {
        if (p.kind === "natural") return p;
        const extra = p.pred ? predCols(p.pred) : [];
        const all = new Set([...need, ...q(p, extra)]);
        const side = (x: Plan) => new Set(schemaOf(x, db).map(colName).filter((c) => all.has(c)));
        return { ...p, left: prune(p.left, side(p.left)), right: prune(p.right, side(p.right)) };
      }
      default: return p;
    }
  };
  return prune(plan, new Set(schemaOf(plan, db).map(colName)));
}

export interface RewriteStep { rule: string; plan: Plan }

/** The heuristic rewrite sequence: cascade, push selections, form joins, reassociate, push projections. */
export function rewriteSteps(q: SqlBlock, db: Db): RewriteStep[] {
  const s0 = canonical(q);
  const s1 = cascadeSelections(s0);
  const s2 = pushSelections(s1, db);
  const s3 = selectionsToJoins(s2);
  const s4 = reassociate(s3, db);
  const s5 = pushProjections(s4, db);
  return [
    { rule: "canonical", plan: s0 },
    { rule: "cascade", plan: s1 },
    { rule: "push-selections", plan: s2 },
    { rule: "form-joins", plan: s3 },
    { rule: "reassociate", plan: s4 },
    { rule: "push-projections", plan: s5 },
  ];
}

// ------------------------------------------------------------------ the lesson's queries

/** Names of employees and projects of Berlin departments with project budget over 100. */
export const REWRITE_QUERY: SqlBlock = {
  select: ["e.name", "p.pname"],
  from: [["emp", "e"], ["dept", "d"], ["proj", "p"]],
  where: [cmp("e.did", "=", "d.did"), cmp("p.did", "=", "d.did"), cmp("d.city", "=", "'Berlin'"), cmp("p.budget", ">", 100)],
};

/**
 * NULL gotcha: departments without employees.
 * EXCEPT treats NULLs as equal and finds dept 40. NOT IN compares with =: `40 NOT IN (10, NULL, ...)` is
 * UNKNOWN because 40 = NULL is UNKNOWN, so NOT IN returns no rows at all.
 */
export function notInVsExcept(db: Db): { except: Value[]; notIn: Value[]; notExists: Value[] } {
  const ex = evalPlan(setop("except", project(["did"], scan("dept")), project(["did"], scan("emp"))), db).result.rows.map((r) => r[0]!);
  const empDids = db.emp!.rows.map((r) => r[resolve(db.emp!.cols, "did")]!);
  const deptDids = db.dept!.rows.map((r) => r[resolve(db.dept!.cols, "did")]!);
  // x NOT IN (list) = NOT (x = v1 OR x = v2 OR ...), in three-valued logic.
  const notIn = deptDids.filter((d) => {
    let anyEq: boolean | null = false;
    for (const v of empDids) {
      const eq = d === null || v === null ? null : d === v;
      anyEq = anyEq === true || eq === true ? true : anyEq === null || eq === null ? null : false;
    }
    return anyEq === false; // NOT anyEq is TRUE only when anyEq is FALSE
  });
  const notExists = deptDids.filter((d) => !empDids.some((v) => v !== null && v === d));
  return { except: ex, notIn, notExists };
}
