/** Demos for the relational algebra lesson: a query-tree playground and a rewrite stepper. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, Plot, Label, range, select as selectSpec, BAD, GOOD, MONO, StepButtons, StepCaption, StepSlider, int, useStepper } from "../../kit";
import {
  SAMPLE_DB, scaledDb, displayNames, hasCol, colName, fmtValue, type Db, type Relation,
} from "../../sims/db/query/relation";
import { and, cmp, isNull, or, predCols, predText, type Pred } from "../../sims/db/query/expr";
import {
  children, evalPlan, label, planWork, rewriteSteps, schemaOf, scan, select, project, distinct, rename, natural, join, cross, setop, group,
  REWRITE_QUERY, sqlText, type Plan, type EvalResult,
} from "../../sims/db/query/algebra";
import { ACC, ALT, BaseBars, OpTree, RowTable, WARM, useLater, type TreeNode } from "./QueryUi";

const opColor = (p: Plan) =>
  p.op === "scan" || p.op === "rename" ? "var(--muted)" : p.op === "select" ? ACC : p.op === "project" || p.op === "distinct" ? ALT : p.op === "join" ? WARM : p.op === "group" ? GOOD : BAD;

export function planToTree(p: Plan, r: EvalResult | null, path = "", badge?: (rel: Relation) => string): TreeNode {
  const l = label(p);
  const rel = r?.nodes.get(path);
  if (p.op === "rename" && p.input.op === "scan") {
    // Show ρ over a base table as one node: "emp as e".
    return { id: path, sym: p.input.table, sub: `as ${p.alias}`, color: opColor(p), badge: rel ? (badge ? badge(rel) : String(rel.rows.length)) : undefined, kids: [] };
  }
  return {
    id: path,
    sym: l.sym,
    sub: l.sub && l.sub !== "natural" ? l.sub : p.op === "join" && p.kind === "natural" ? "natural" : undefined,
    color: opColor(p),
    badge: rel ? (badge ? badge(rel) : String(rel.rows.length)) : undefined,
    kids: children(p).map((c, i) => planToTree(c, r, path === "" ? String(i) : `${path}.${i}`, badge)),
  };
}

// ============================================================================ playground

interface Move { label: string; apply: (p: Plan) => Plan }

const PREDS: Pred[] = [
  cmp("salary", ">", 55),
  cmp("city", "=", "'Berlin'"),
  cmp("did", "=", 10),
  cmp("did", "<>", 10),
  isNull("did"),
  or(cmp("salary", ">", 55), cmp("salary", "<=", 55)),
  and(cmp("did", "=", 10), cmp("salary", ">", 50)),
  cmp("budget", ">", 70),
  cmp("dname", "=", "'Query'"),
  cmp("emp.did", "=", "dept.did"),
  cmp("emp.city", "=", "dept.city"),
  cmp("emp.did", "=", "proj.did"),
];

const tablesIn = (p: Plan): string[] => (p.op === "scan" ? [p.table] : p.op === "rename" ? [p.alias] : children(p).flatMap(tablesIn));

function movesFor(p: Plan, db: Db): Move[] {
  const cols = schemaOf(p, db);
  const out: Move[] = [];
  for (const pr of PREDS) {
    if (predCols(pr).every((c) => hasCol(cols, c))) out.push({ label: `σ ${predText(pr)}`, apply: (x) => select(pr, x) });
  }
  out.push({ label: "δ remove duplicates", apply: distinct });
  const used = new Set(tablesIn(p));
  for (const t of ["emp", "dept", "proj"]) {
    const alias = used.has(t) ? `${t}2` : t;
    const right = alias === t ? scan(t) : rename(alias, scan(t));
    const leftDid = cols.filter((c) => c.name === "did");
    if (leftDid.length >= 1 && db[t]!.cols.some((c) => c.name === "did")) {
      const l = colName(leftDid[0]!);
      out.push({ label: `⋈ ${l} = ${alias}.did with ${alias}`, apply: (x) => join(cmp(l, "=", `${alias}.did`), x, right) });
    }
    out.push({ label: `⋈ natural with ${alias}`, apply: (x) => natural(x, right) });
    out.push({ label: `× with ${alias}`, apply: (x) => cross(x, right) });
  }
  const names = cols.map((c) => c.name);
  if (new Set(names).size === names.length) {
    for (const t of ["emp", "dept", "proj"]) {
      if (!names.every((n) => db[t]!.cols.some((c) => c.name === n))) continue;
      const right = project(names, scan(t));
      const rt = `π ${names.join(", ")}(${t})`;
      out.push({ label: `∪ ${rt}`, apply: (x) => setop("union", x, right) });
      out.push({ label: `− ${rt}`, apply: (x) => setop("except", x, right) });
      out.push({ label: `∩ ${rt}`, apply: (x) => setop("intersect", x, right) });
    }
  }
  const keyCands = ["did", "city", "dname", "emp.did", "dept.city", "emp.city"].filter((k) => hasCol(cols, k));
  const num = ["salary", "budget"].find((c) => hasCol(cols, c));
  const aggs = [{ fn: "count" as const }, ...(num ? [{ fn: "count" as const, col: num }, { fn: "sum" as const, col: num }, { fn: "avg" as const, col: num }] : [])];
  for (const k of [...keyCands.slice(0, 2), null]) {
    const keys = k ? [k] : [];
    out.push({ label: `γ ${k ? `${k}; ` : ""}${aggs.map((a) => `${a.fn}(${a.col ?? "*"})`).join(", ")}`, apply: (x) => group(keys, aggs, x) });
  }
  return out;
}

export function AlgebraPlaygroundDemo() {
  const db = SAMPLE_DB;
  const [hist, setHist] = useState<Plan[]>([select(cmp("salary", ">", 55), scan("emp"))]);
  const plan = hist[hist.length - 1]!;
  const [picked, setPicked] = useState("");
  const [move, setMove] = useState(0);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const res = useMemo(() => evalPlan(plan, db), [plan, db]);
  const moves = useMemo(() => movesFor(plan, db), [plan, db]);
  const push = (p: Plan) => { setHist([...hist, p]); setPicked(""); setMove(0); setKeep(new Set()); };
  const rel = res.nodes.get(picked) ?? res.result;
  const pickedPlan = (() => {
    let p: Plan = plan;
    for (const i of picked === "" ? [] : picked.split(".").map(Number)) p = children(p)[i]!;
    return p;
  })();
  const rootCols = res.result.cols;
  const rootNames = displayNames(rootCols);
  const l = label(pickedPlan);
  return (
    <Demo
      title="Build a query tree"
      actions={
        <>
          <button className="btn" disabled={hist.length < 2} onClick={() => { setHist(hist.slice(0, -1)); setPicked(""); setKeep(new Set()); }}>Undo</button>
          <button className="btn ghost" onClick={() => { setHist([scan("emp")]); setPicked(""); setKeep(new Set()); }}>Clear</button>
        </>
      }
      controls={
        <>
          <Param spec={selectSpec({ label: "Start a new tree from", options: [{ value: "emp", label: "emp" }, { value: "dept", label: "dept" }, { value: "proj", label: "proj" }], default: "emp", segmented: true })} value={plan.op === "scan" ? plan.table : ""} onChange={(v) => push(scan(v as string))} />
          <label className="param">
            <span className="param-label">Put an operator on top</span>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <select value={move} onChange={(e) => setMove(Number(e.target.value))} style={{ minWidth: 0, flex: 1, maxWidth: 260 }}>
                {moves.map((m, i) => <option key={i} value={i}>{m.label}</option>)}
              </select>
              <button className="btn primary" onClick={() => moves[move] && push(moves[move]!.apply(plan))}>Add</button>
            </div>
          </label>
          <div className="param" style={{ gridColumn: "1 / -1" }}>
            <span className="param-label">π: click the columns to keep, then press Add π</span>
            <div className="row" style={{ gap: 4 }}>
              {rootNames.map((n, i) => (
                <button key={i} className="btn" style={{ padding: "2px 8px", fontFamily: MONO, fontSize: 12, borderColor: keep.has(i) ? ALT : undefined, color: keep.has(i) ? ALT : undefined, fontWeight: keep.has(i) ? 700 : 400 }}
                  onClick={() => { const k = new Set(keep); if (k.has(i)) k.delete(i); else k.add(i); setKeep(k); }}>{n}</button>
              ))}
              <button className="btn primary" disabled={keep.size === 0} onClick={() => push(project([...keep].sort((a, b) => a - b).map((i) => colName(rootCols[i]!)), plan))}>Add π</button>
            </div>
          </div>
        </>
      }
    >
      <OpTree root={planToTree(plan, res)} picked={picked} onPick={setPicked} />
      <div className="muted" style={{ fontSize: 12, textAlign: "center", margin: "4px 0 10px" }}>The badge is the number of rows each operator outputs. Click a node to see its rows.</div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b style={{ fontFamily: MONO }}>{l.sym}{l.sub ? ` ${l.sub}` : ""}</b> <span className="muted">outputs {rel.rows.length} row{rel.rows.length === 1 ? "" : "s"}</span>
      </div>
      <RowTable head={displayNames(rel.cols)} rows={rel.rows.map((r) => r.map((v) => (v === null ? null : fmtValue(v))))} max={10} />
    </Demo>
  );
}

// ============================================================================ rewrite stepper

const RULE_TEXT: Record<string, string> = {
  canonical: "The direct translation of the SQL block: a product of all FROM tables, one selection with the whole WHERE clause, and a projection on top.",
  cascade: "Cascade of selections: σ with a conjunction becomes a chain of σ, one per conjunct. This alone adds work, but now each conjunct can move on its own.",
  "push-selections": "Push each selection down to the lowest node that has all its columns. The filters on d.city and p.budget now run on the base tables, before any product.",
  "form-joins": "A selection with a predicate on both sides of a product is a join: σ_p(A × B) = A ⋈_p B. A join operator never builds the full product.",
  reassociate: "Join associativity: (E ⋈ D) ⋈ P = E ⋈ (D ⋈ P). The small filtered inputs D and P join first, so the big table E joins with a tiny result.",
  "push-projections": "Push projections down: each scan keeps only the columns that some operator above needs. The rows stay the same, but they get narrower.",
};

const REW_CACHE = new Map<number, ReturnType<typeof computeRewrite>>();
function computeRewrite(n: number) {
  const db = scaledDb(n);
  return rewriteSteps(REWRITE_QUERY, db).map((st) => { const r = evalPlan(st.plan, db); return { ...st, r, work: planWork(st.plan, r) }; });
}
/** Evaluates all rewrite steps for n employees (cached: the slider revisits values). */
function rewriteData(n: number) {
  let d = REW_CACHE.get(n);
  if (!d) { d = computeRewrite(n); REW_CACHE.set(n, d); }
  return d;
}

const REW_SCHEMA = {
  n: range({ label: "Rows in emp", min: 50, max: 200, step: 10, default: 100 }),
};

export function RewriteDemo() {
  const [n, setN] = useState(REW_SCHEMA.n.default);
  const s = useStepper(6, 0.8);
  const data = useLater(() => rewriteData(n), [n]);
  if (!data) return <Demo title="Rewrite with equivalence rules"><div className="muted" style={{ height: 420, display: "grid", placeItems: "center", fontSize: 13 }}>Evaluating the plans…</div></Demo>;
  const cur = data[s.i]!;
  const base = data[0]!.work;
  return (
    <Demo
      title="Rewrite with equivalence rules"
      actions={<StepButtons s={s} />}
      controls={<><Param spec={REW_SCHEMA.n} value={n} onChange={(v) => setN(v as number)} /><StepSlider s={s} label="Rewrite step" /></>}
    >
      <pre style={{ fontFamily: MONO, fontSize: 12, margin: "0 0 10px", padding: "6px 10px", background: "var(--subtle)", borderRadius: 6, overflowX: "auto" }}>{sqlText(REWRITE_QUERY)}</pre>
      <div style={{ fontSize: 12.5, marginBottom: 6 }} className="muted">emp {n} rows · dept 8 rows · proj 30 rows. The badge is the number of rows each operator outputs.</div>
      <OpTree root={planToTree(cur.plan, cur.r)} slot={150} />
      <StepCaption label={`${s.i + 1}/6`}>{RULE_TEXT[cur.rule]}</StepCaption>
      <div style={{ height: 10 }} />
      <Plot x={[-0.5, 5.5]} y={[1, Math.max(...data.map((d) => d.work.tuples)) * 3]} logY height={170} xTicks={[0, 1, 2, 3, 4, 5]} xFormat={(v) => String(v + 1)} yLabel="rows produced by all operators (log)" xLabel="rewrite step" yFormat={(v) => (v >= 1000 ? `${v / 1000}k` : String(v))}>
        <BaseBars base={1} bins={data.map((d, i) => ({ x0: i - 0.35, x1: i + 0.35, y: d.work.tuples, color: i === s.i ? ACC : "var(--faint)" }))} />
        {data.map((d, i) => <Label key={i} at={[i, d.work.tuples * 1.35]} anchor="middle">{int(d.work.tuples)}</Label>)}
      </Plot>
      <div style={{ height: 8 }} />
      <Stats items={[
        { label: "result rows (same at every step)", value: cur.r.result.rows.length },
        { label: "rows produced by operators", value: int(cur.work.tuples) },
        { label: "values produced (rows × columns)", value: int(cur.work.values) },
        { label: "rows produced, as a share of step 1", value: `${((100 * cur.work.tuples) / base.tuples).toFixed(1)}%` },
      ]} />
    </Demo>
  );
}
