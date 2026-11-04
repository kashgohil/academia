/** Demos for the Volcano iterator model: next() calls flowing through a tree, and pipeline breakers over time. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, Plot, Line, RuleX, Legend, range, select } from "../../kit";
import { SAMPLE_DB, scaledDb, type Db, type Row } from "../../sims/db/query/relation";
import { cmp } from "../../sims/db/query/expr";
import { Ctx, Filter, HashAgg, HashJoin, Limit, Project, Scan, Sort, pipelines, runAll, callCounts, type Op } from "../../sims/db/query/iterator";
import { ACC, ALT, BAD, Caption, GOOD, MONO, Note, OpTree, StepButtons, StepSlider, WARM, int, useStepper, type TreeNode } from "./QueryUi";

const scanOf = (ctx: Ctx, db: Db, t: string) => new Scan(ctx, t, db[t]!.rows, db[t]!.cols);

type FlowPlan = "filter" | "join" | "sort";
function buildFlow(kind: FlowPlan, ctx: Ctx, db: Db): Op {
  const emp = () => new Filter(ctx, scanOf(ctx, db, "emp"), "salary > 55", cmp("salary", ">", 55));
  if (kind === "filter") return new Project(ctx, emp(), ["name"]);
  if (kind === "join") return new Project(ctx, new HashJoin(ctx, scanOf(ctx, db, "dept"), emp(), "dept.did", "emp.did"), ["name", "dname"]);
  return new Limit(ctx, new Sort(ctx, emp(), "salary", true), 2);
}

const rowText = (op: Op, r: Row) => {
  const i = op.cols.findIndex((c) => c.name === "name");
  const j = op.cols.findIndex((c) => c.name === "dname");
  if (i >= 0) return j >= 0 ? `${r[i]}, ${r[j]}` : String(r[i]);
  return String(r[j >= 0 ? j : 0]);
};

function opTree(root: Op, f: (op: Op) => Partial<TreeNode>): TreeNode {
  const go = (o: Op): TreeNode => ({ id: String(o.id), sym: o.name, sub: o.detail() || undefined, kids: o.kids.map(go), ...f(o) });
  return go(root);
}

export function IteratorFlowDemo() {
  const [kind, setKind] = useState<FlowPlan>("filter");
  const run = useMemo(() => {
    const ctx = new Ctx(true);
    const root = buildFlow(kind, ctx, SAMPLE_DB);
    const out = runAll(root);
    const ev = ctx.events.filter((e) => e.t !== "mem");
    return { ctx, root, out, ev };
  }, [kind]);
  const s = useStepper(run.ev.length + 1, 3);
  // Replay events 0..i-1.
  const st = useMemo(() => {
    const n = run.ctx.ops.length;
    const calls = new Array<number>(n).fill(0), rows = new Array<number>(n).fill(0);
    const stack: number[] = [];
    const lastRow = new Map<number, string>();
    const out: string[] = [];
    let text = "Press Play or Step. The root asks for one row at a time by calling next().";
    let hot: number | null = null;
    for (let k = 0; k < s.i; k++) {
      const e = run.ev[k]!;
      const op = run.ctx.ops[e.op]!;
      hot = null;
      if (e.t === "call") {
        calls[e.op]!++;
        const caller = stack.length ? run.ctx.ops[stack[stack.length - 1]!]! : null;
        stack.push(e.op);
        text = caller ? `${caller.name} calls next() on ${op.name}.` : `The client calls next() on the root, ${op.name}.`;
      } else if (e.t === "ret") {
        stack.pop();
        const to = stack.length ? run.ctx.ops[stack[stack.length - 1]!]!.name : "the client";
        if (e.row) {
          rows[e.op]!++;
          lastRow.set(e.op, rowText(op, e.row));
          hot = e.op;
          if (!stack.length) out.push(rowText(op, e.row));
          text = `${op.name} returns the row (${rowText(op, e.row)}) to ${to}.`;
        } else {
          lastRow.set(e.op, "EOF");
          hot = e.op;
          text = `${op.name} has no more rows: it returns EOF (null) to ${to}.`;
        }
      }
    }
    return { calls, rows, stack, lastRow, out, text, hot };
  }, [run, s.i]);
  const top = st.stack[st.stack.length - 1];
  const tree = opTree(run.root, (o) => ({
    badge: `${st.calls[o.id]} call${st.calls[o.id] === 1 ? "" : "s"}`,
    color: o.blocking ? WARM : o instanceof Scan ? "var(--muted)" : ACC,
    active: o.id === top,
    edge: st.lastRow.get(o.id),
    edgeColor: st.hot === o.id ? GOOD : st.stack.includes(o.id) ? ACC : undefined,
    edgeWidth: st.hot === o.id ? 3 : 1.3,
  }));
  const totalCalls = run.ctx.ops.reduce((a, o) => a + o.stats.nexts, 0);
  const cc = callCounts(run.ctx);
  return (
    <Demo
      title="Rows flow up, one next() call at a time"
      actions={<StepButtons s={s} />}
      controls={
        <>
          <StepSlider s={s} label="Event" />
          <Param spec={select({ label: "Plan", options: [{ value: "filter", label: "scan, filter, project" }, { value: "join", label: "hash join" }, { value: "sort", label: "sort + limit 2" }], default: "filter", segmented: true })} value={kind} onChange={(v) => { setKind(v as FlowPlan); s.reset(); }} />
        </>
      }
    >
      <OpTree root={tree} slot={170} />
      <div style={{ fontSize: 12.5, margin: "8px 0 0", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span className="muted">Call stack (bottom first):</span>
        {st.stack.length === 0 && <span className="muted">empty</span>}
        {st.stack.map((id, k) => <span key={k} style={{ fontFamily: MONO, fontSize: 12, padding: "0 6px", border: `1.5px solid ${k === st.stack.length - 1 ? ACC : "var(--border)"}`, borderRadius: 4 }}>{run.ctx.ops[id]!.name}.next()</span>)}
      </div>
      <div style={{ fontSize: 12.5, margin: "6px 0 0" }}>
        <span className="muted">Rows at the client: </span>
        <span style={{ fontFamily: MONO }}>{st.out.length ? st.out.join(" · ") : "none yet"}</span>
      </div>
      <Caption label={`${s.i}/${run.ev.length}`}>{st.text}</Caption>
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "next() calls so far", value: st.calls.reduce((a, b) => a + b, 0) },
        { label: "next() calls in the whole query", value: totalCalls },
        { label: "rows to the client", value: run.out.length },
        { label: "calls in a push model (consume + produce)", value: cc.push },
      ]} />
      <Legend items={[{ label: "streaming operator", color: ACC }, { label: "blocking operator", color: WARM }, { label: "row just returned", color: GOOD }]} />
    </Demo>
  );
}

// ============================================================================ pipeline breakers

type BreakPlan = "join" | "agg" | "sort";

function buildBreak(kind: BreakPlan, ctx: Ctx, db: Db): Op {
  const probe = new Filter(ctx, scanOf(ctx, db, "emp"), "salary > 60", cmp("salary", ">", 60));
  const j = new HashJoin(ctx, scanOf(ctx, db, "dept"), probe, "dept.did", "emp.did");
  if (kind === "join") return new Project(ctx, j, ["name", "dname"]);
  if (kind === "agg") return new HashAgg(ctx, j, ["emp.city"], [{ fn: "count" }, { fn: "sum", col: "salary" }]);
  return new Sort(ctx, new Project(ctx, j, ["name", "salary"]), "salary", true);
}

const PIPE_COLORS = [ALT, ACC, GOOD, WARM, BAD];

const BREAK_SCHEMA = { n: range({ label: "Rows in emp", min: 100, max: 4000, step: 100, default: 1000 }) };

export function PipelineBreakerDemo() {
  const [n, setN] = useState(BREAK_SCHEMA.n.default);
  const [kind, setKind] = useState<BreakPlan>("sort");
  const run = useMemo(() => {
    const db = scaledDb(n);
    const ctx = new Ctx(true);
    const root = buildBreak(kind, ctx, db);
    const out = runAll(root);
    const pipes = pipelines(root);
    const mem = ctx.events.filter((e) => e.t === "mem");
    const end = ctx.clock;
    const series = ctx.ops.filter((o) => o.blocking).map((o) => {
      const pts: [number, number][] = [[0, 0]];
      let last = 0;
      for (const e of mem) if (e.op === o.id) { pts.push([e.clock, last], [e.clock, e.held]); last = e.held; }
      pts.push([end, last]);
      return { op: o, pts };
    });
    return { ctx, root, out, pipes, series, end };
  }, [n, kind]);
  const pipeOf = new Map<number, number>();
  run.pipes.forEach((p, i) => p.ops.forEach((id) => { if (!pipeOf.has(id)) pipeOf.set(id, i); }));
  const tree = opTree(run.root, (o) => ({
    color: PIPE_COLORS[(pipeOf.get(o.id) ?? 0) % PIPE_COLORS.length],
    badge: o.blocking ? `peak ${int(o.stats.peak)}` : `${int(o.stats.rows)} rows`,
  }));
  const first = run.root.stats.firstRowAt ?? run.end;
  const ymax = Math.max(10, ...run.series.map((s) => s.op.stats.peak)) * 1.15;
  const peakSum = run.series.reduce((a, s) => a + s.op.stats.peak, 0);
  return (
    <Demo
      title="Pipelines, breakers and the memory they hold"
      controls={
        <>
          <Param spec={BREAK_SCHEMA.n} value={n} onChange={(v) => setN(v as number)} />
          <Param spec={select({ label: "Plan on top of the join", options: [{ value: "join", label: "project only" }, { value: "agg", label: "GROUP BY city" }, { value: "sort", label: "ORDER BY salary" }], default: "sort", segmented: true })} value={kind} onChange={(v) => setKind(v as BreakPlan)} />
        </>
      }
    >
      <OpTree root={tree} slot={170} />
      <div style={{ display: "flex", flexDirection: "column", gap: 3, margin: "8px 0", fontSize: 12.5 }}>
        {run.pipes.map((p, i) => (
          <div key={i}>
            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: PIPE_COLORS[i % PIPE_COLORS.length], marginRight: 6 }} />
            <b>Pipeline {i + 1}:</b>{" "}
            <span style={{ fontFamily: MONO, fontSize: 12 }}>{p.ops.map((id) => run.ctx.ops[id]!.name).join(" → ")}{p.breaker !== null ? ` → (${run.ctx.ops[p.breaker]!.name} ${run.ctx.ops[p.breaker]! instanceof HashJoin ? "build" : "input"})` : " → client"}</span>
          </div>
        ))}
      </div>
      <Plot x={[0, run.end]} y={[0, ymax]} height={200} xLabel="time (next() calls)" yLabel="rows held in memory" xFormat={(v) => (v >= 1000 ? `${v / 1000}k` : String(v))}>
        {run.series.map((s) => <Line key={s.op.id} points={s.pts} color={PIPE_COLORS[(run.pipes.findIndex((p) => p.breaker === s.op.id) + PIPE_COLORS.length) % PIPE_COLORS.length]} width={2} />)}
        <RuleX at={first} color={BAD} label="first row out" />
      </Plot>
      <Legend items={run.series.map((s) => ({ label: `${s.op.name} (${s.op instanceof HashJoin ? "hash table" : s.op instanceof Sort ? "sort buffer" : "groups"})`, color: PIPE_COLORS[(run.pipes.findIndex((p) => p.breaker === s.op.id) + PIPE_COLORS.length) % PIPE_COLORS.length]! }))} />
      <div style={{ height: 8 }} />
      <Stats items={[
        { label: "next() calls in total", value: int(run.end) },
        { label: "first row reaches the client at call", value: int(first) },
        { label: "share of the work done before the first row", value: `${((100 * first) / run.end).toFixed(1)}%` },
        { label: "peak rows held by all breakers", value: int(peakSum) },
      ]} />
      <Note>A blocking operator reads its whole input before it returns its first row. The hash join blocks only on its build side (dept, 8 rows). The probe side streams through it.</Note>
    </Demo>
  );
}
