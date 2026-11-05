/** Demos for query compilation: produce/consume code generation step by step, and compile latency against run time. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, Plot, Line, Dots, RuleX, Legend, range, select, si, BAD, GOOD, MONO, StepButtons, StepCaption, StepSlider, int, useStepper } from "../../kit";
import { CG_PLANS, NS_PER_ROW, generate, scanLoops, engineTime, breakEven, type CgNode, type Engine, type Workload } from "../../sims/db/query/codegen";
import { ACC, ALT, OpTree, WARM, type TreeNode } from "./QueryUi";

const OP_COLORS = [GOOD, WARM, ACC, ALT, BAD, "var(--muted)"];

export function ProduceConsumeDemo() {
  const [pid, setPid] = useState("join");
  const g = useMemo(() => generate(CG_PLANS.find((p) => p.id === pid)!.plan), [pid]);
  const s = useStepper(g.events.length + 1, 2.5);
  const shown = g.events.slice(0, s.i);
  const lineCount = shown.filter((e) => e.t === "emit").length;
  const ev = s.i > 0 ? g.events[s.i - 1]! : null;
  const nodes = new Map<number, CgNode>();
  const walk = (n: CgNode) => { nodes.set(n.id, n); n.kids.forEach(walk); };
  walk(g.tree);
  const name = (id: number) => nodes.get(id)!.label;
  const toTree = (n: CgNode): TreeNode => {
    const [sym, ...rest] = n.label.split(" ");
    return { id: String(n.id), sym: sym!, sub: rest.join(" ") || undefined, color: OP_COLORS[n.id % OP_COLORS.length], active: ev?.op === n.id, kids: n.kids.map(toTree), badge: ev?.op === n.id ? (ev.t === "emit" ? "emit" : ev.t) : undefined };
  };
  const text = !ev
    ? "Press Play. Code generation starts with produce() on the root."
    : ev.t === "produce"
      ? `produce() on ${name(ev.op)}: ${nodes.get(ev.op)!.kids.length ? "it asks its input to produce rows" : "a scan opens a loop over its table"}.`
      : ev.t === "consume"
        ? `consume() on ${name(ev.op)}, called by ${name(ev.from)} for one row: it adds the code that handles that row, inside the loop that is open now.`
        : `${name(ev.op)} emits: ${g.lines[ev.line]!.text}`;
  const sql = CG_PLANS.find((p) => p.id === pid)!.sql;
  return (
    <Demo
      title="Produce / consume: from operator tree to loops"
      actions={<StepButtons s={s} />}
      controls={
        <>
          <StepSlider s={s} label="Event" />
          <Param spec={select({ label: "Query", options: CG_PLANS.map((p) => ({ value: p.id, label: p.label })), default: "join", segmented: true })} value={pid} onChange={(v) => { setPid(v as string); s.reset(); }} />
        </>
      }
    >
      <pre style={{ fontFamily: MONO, fontSize: 11.5, margin: "0 0 8px", padding: "6px 10px", background: "var(--subtle)", borderRadius: 6, whiteSpace: "pre-wrap" }}>{sql}</pre>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}>
        <OpTree root={toTree(g.tree)} slot={150} />
        <pre style={{ fontFamily: MONO, fontSize: 11.5, margin: 0, padding: "8px 6px", border: "1px solid var(--border)", borderRadius: 6, overflowX: "auto", minHeight: 200, lineHeight: 1.55 }}>
          {g.lines.slice(0, lineCount).map((l, i) => (
            <div key={i} style={{ borderLeft: `3px solid ${OP_COLORS[l.op % OP_COLORS.length]}`, paddingLeft: 6 + l.indent * 14, background: ev?.t === "emit" && ev.line === i ? "var(--subtle)" : undefined, fontWeight: ev?.t === "emit" && ev.line === i ? 700 : 400, whiteSpace: "pre" }}>{l.text}</div>
          ))}
          {lineCount === 0 && <span className="muted">fn query(out: &mut Vec&lt;Row&gt;) {"{ … }"}</span>}
        </pre>
      </div>
      <StepCaption label={`${s.i}/${g.events.length}`}>{text}</StepCaption>
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "lines so far", value: `${lineCount} of ${g.lines.length}` },
        { label: "loops over base tables (pipelines)", value: scanLoops(g.lines) },
        { label: "operators", value: nodes.size },
        { label: "function calls per row at run time", value: 0 },
      ]} />
    </Demo>
  );
}

// ============================================================================ break-even

const ENGINES: { id: Engine; label: string; color: string }[] = [
  { id: "volcano", label: "interpreted, tuple at a time", color: BAD },
  { id: "vector", label: "vectorized", color: ACC },
  { id: "compiled", label: "compiled (LLVM -O2)", color: WARM },
  { id: "adaptive", label: "adaptive: bytecode, then machine code", color: GOOD },
];

export function BreakEvenDemo() {
  const [cms, setCms] = useState(40);
  const [w, setW] = useState<Workload>("compute");
  const [rows, setRows] = useState(1e7);
  const xs = useMemo(() => Array.from({ length: 141 }, (_, i) => Math.pow(10, 3 + i / 20)), []);
  const be = { volcano: breakEven("compiled", "volcano", cms, w), vector: breakEven("compiled", "vector", cms, w) };
  const at = ENGINES.map((e) => ({ ...e, ms: engineTime(e.id, rows, cms, w) }));
  const best = at.reduce((a, b) => (b.ms < a.ms ? b : a));
  return (
    <Demo
      title="Compile latency against run time"
      controls={
        <>
          <Param spec={range({ label: "Compile latency (ms)", min: 1, max: 1000, log: true, default: 40, format: (v) => `${Math.round(v)} ms` })} value={cms} onChange={(v) => setCms(v as number)} />
          <Param spec={range({ label: "Rows the query processes", min: 1e3, max: 1e10, log: true, default: 1e7, format: (v) => si(v) })} value={rows} onChange={(v) => setRows(v as number)} />
          <Param spec={select({ label: "Query type", options: [{ value: "compute", label: "computation-heavy (like TPC-H Q1)" }, { value: "memory", label: "memory-bound joins (like Q9)" }], default: "compute", segmented: true })} value={w} onChange={(v) => setW(v as Workload)} />
        </>
      }
    >
      <Plot x={[1e3, 1e10]} y={[1e-3, 1e6]} logX logY height={260} xLabel="rows processed" yLabel="total time, ms (log)" xTicks={[1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10]} xFormat={(x) => si(x).replace(" ", "")} yTicks={[1e-3, 1e-1, 10, 1e3, 1e5]} yFormat={(y) => si(y).replace(" ", "")}>
        {ENGINES.map((e) => <Line key={e.id} points={xs.map((x) => [x, engineTime(e.id, x, cms, w)] as const)} color={e.color} width={e.id === "adaptive" ? 2.6 : 1.8} dash={e.id === "adaptive" ? "6 3" : undefined} />)}
        {be.volcano && <Dots points={[[be.volcano, engineTime("volcano", be.volcano, cms, w)]]} color={BAD} r={4.5} />}
        {be.vector && <Dots points={[[be.vector, engineTime("vector", be.vector, cms, w)]]} color={ACC} r={4.5} />}
        <RuleX at={rows} />
      </Plot>
      <Legend items={ENGINES.map((e) => ({ label: e.label, color: e.color }))} />
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ fontSize: 12.5, borderCollapse: "collapse", width: "100%", fontVariantNumeric: "tabular-nums" }}>
          <thead><tr className="muted"><th style={{ textAlign: "left", fontWeight: 500 }}>{si(rows)} rows</th><th style={{ textAlign: "right", fontWeight: 500 }}>total time</th></tr></thead>
          <tbody>{at.map((e) => <tr key={e.id} style={{ borderTop: "1px solid var(--border)", color: e.id === best.id ? GOOD : undefined, fontWeight: e.id === best.id ? 650 : 400 }}><td>{e.label}</td><td style={{ textAlign: "right" }}>{e.ms < 1 ? `${(e.ms * 1000).toFixed(0)} µs` : e.ms < 10000 ? `${e.ms.toFixed(1)} ms` : `${(e.ms / 1000).toFixed(1)} s`}</td></tr>)}</tbody>
        </table>
      </div>
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "compiled beats the interpreter after", value: be.volcano ? `${int(be.volcano)} rows` : "never" },
        { label: "compiled beats vectorized after", value: be.vector ? `${int(be.vector)} rows` : "never" },
      ]} />
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>Model (assumed): per row, the interpreter takes {NS_PER_ROW[w].volcano} ns, vectorized {NS_PER_ROW[w].vector} ns, compiled {NS_PER_ROW[w].compiled} ns and the bytecode interpreter {NS_PER_ROW[w].bytecode} ns. Adaptive execution compiles on another thread and switches when the code is ready.</p>
    </Demo>
  );
}
