/** Demos for vectorized execution: the vector-size cost model, selection vectors, and branching vs branch-free selection. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, Plot, Line, Dots, RuleX, Legend, range, select, si, bytes, BAD, GOOD, MONO, Note, StepCaption } from "../../kit";
import { VEC_MODEL, vectorCost, bestVectorSize, fitsIn, DEMO_BATCH, selectionSteps, branchSim, BRANCH_MODEL } from "../../sims/db/query/vector";
import { ACC, WARM } from "./QueryUi";

// ============================================================================ 1. vector size

const VS_SCHEMA = {
  call: range({ label: "Overhead per primitive call (ns)", min: 1, max: 50, step: 1, default: 10 }),
  prims: range({ label: "Primitives in the pipeline", min: 1, max: 8, step: 1, default: 4 }),
};

export function VectorSizeDemo() {
  const [call, setCall] = useState(10);
  const [prims, setPrims] = useState(4);
  const m = { ...VEC_MODEL, callNs: call, prims };
  const xs = useMemo(() => Array.from({ length: 97 }, (_, i) => Math.pow(2, i / 4)), []);
  const pts = xs.map((v) => ({ v, ...vectorCost(v, m) }));
  const best = bestVectorSize(m);
  const one = vectorCost(1, m), full = vectorCost(1 << 24, m), duck = vectorCost(2048, m);
  const ymax = Math.max(...pts.map((p) => p.total)) * 2;
  return (
    <Demo
      title="Time per tuple as a function of vector size"
      controls={<><Param spec={VS_SCHEMA.call} value={call} onChange={(v) => setCall(v as number)} /><Param spec={VS_SCHEMA.prims} value={prims} onChange={(v) => setPrims(v as number)} /></>}
    >
      <Plot x={[1, 1 << 24]} y={[0.05, ymax]} logX logY height={260} xLabel="vector size (values per call)" yLabel="ns per tuple (log)" xTicks={[1, 16, 256, 4096, 65536, 1 << 20, 1 << 24]} xFormat={(x) => si(x).replace(" ", "")} yTicks={[0.1, 1, 10, 100, 1000].filter((t) => t < ymax)}>
        <Line points={pts.map((p) => [p.v, p.call] as const)} color={BAD} width={1.4} dash="4 3" />
        <Line points={pts.map((p) => [p.v, p.memory] as const)} color={WARM} width={1.4} dash="4 3" />
        <Line points={pts.map((p) => [p.v, p.work] as const)} color="var(--muted)" width={1.2} dash="2 3" />
        <Line points={pts.map((p) => [p.v, p.total] as const)} color={ACC} width={2.6} />
        <RuleX at={fitsIn(m.l1, m)} label="L1" />
        <RuleX at={fitsIn(m.l2, m)} label="L2" />
        <RuleX at={fitsIn(m.l3, m)} label="L3" />
        <Dots points={[[best.v, best.ns]]} color={GOOD} r={5} />
        <Dots points={[[1, one.total]]} color={BAD} r={5} />
      </Plot>
      <Legend items={[{ label: "total", color: ACC }, { label: "call overhead / vector size", color: BAD }, { label: "intermediate vectors through the caches", color: WARM }, { label: "useful work", color: "var(--muted)" }]} />
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "tuple at a time (size 1)", value: `${one.total.toFixed(1)} ns` },
        { label: `best size ${si(best.v).replace(" ", "")}`, value: `${best.ns.toFixed(2)} ns` },
        { label: "DuckDB size 2,048", value: `${duck.total.toFixed(2)} ns` },
        { label: "full columns (16 M values)", value: `${full.total.toFixed(2)} ns` },
        { label: "speedup of the best size over size 1", value: `${(one.total / best.ns).toFixed(1)}×` },
      ]} />
      <Note>
        Model (assumed values, not measurements): {prims} primitives, each does {m.workNs} ns of work per value and writes one vector of 8-byte values. The working set of one batch is size × 8 B × {prims}. It fits in L1 ({bytes(m.l1)}) up to size {si(fitsIn(m.l1, m)).replace(" ", "")}. Reading and writing a byte costs {m.nsPerByte.l1}, {m.nsPerByte.l2}, {m.nsPerByte.l3} and {m.nsPerByte.mem} ns in L1, L2 ({bytes(m.l2)}), L3 ({bytes(m.l3)}) and DRAM.
      </Note>
    </Demo>
  );
}

// ============================================================================ 2. selection vectors

type SelStage = "p1" | "p2" | "agg";

export function SelectionVectorDemo() {
  const [x, setX] = useState(40);
  const [y, setY] = useState(50);
  const [stage, setStage] = useState<SelStage>("p2");
  const { a, b } = DEMO_BATCH;
  const st = selectionSteps(x, y);
  const s1 = new Set(st.p1.sel);
  const sum = st.p2.sel.reduce((acc, i) => acc + a[i]! * b[i]!, 0);
  const W = 16;
  const cell = (i: number, which: "a" | "b") => {
    const v = which === "a" ? a[i]! : b[i]!;
    let state: "pass" | "fail" | "skip" | "none" = "none";
    if (which === "a") state = a[i]! > x ? "pass" : "fail";
    if (which === "b" && stage !== "p1") state = !s1.has(i) ? "skip" : b[i]! < y ? "pass" : "fail";
    const col = state === "pass" ? GOOD : state === "fail" ? BAD : "var(--border)";
    return (
      <td key={i} style={{ padding: 0 }}>
        <div style={{ fontFamily: MONO, fontSize: 11.5, textAlign: "center", border: `1.5px solid ${col}`, borderRadius: 3, margin: 1, padding: "1px 0", background: state === "pass" ? "var(--subtle)" : undefined, opacity: state === "skip" ? 0.3 : 1, color: state === "fail" ? BAD : undefined }}>{v}</div>
      </td>
    );
  };
  const vec = (sel: number[], color: string) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
      {sel.map((i) => <span key={i} style={{ fontFamily: MONO, fontSize: 11.5, padding: "0 4px", borderRadius: 3, border: `1.5px solid ${color}`, color }}>{i}</span>)}
      {sel.length === 0 && <span className="muted" style={{ fontSize: 12 }}>(empty)</span>}
    </div>
  );
  return (
    <Demo
      title="A batch of 16 rows through two filters"
      controls={
        <>
          <Param spec={range({ label: "Filter 1: a > x", min: 0, max: 100, step: 1, default: 40 })} value={x} onChange={(v) => setX(v as number)} />
          <Param spec={range({ label: "Filter 2: b < y", min: 0, max: 100, step: 1, default: 50 })} value={y} onChange={(v) => setY(v as number)} />
          <Param spec={select({ label: "Show", options: [{ value: "p1", label: "after filter 1" }, { value: "p2", label: "after filter 2" }, { value: "agg", label: "SUM(a × b)" }], default: "p2", segmented: true })} value={stage} onChange={(v) => setStage(v as SelStage)} />
        </>
      }
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 330, tableLayout: "fixed" }}>
          <tbody>
            <tr>{Array.from({ length: W }, (_, i) => <td key={i} className="muted" style={{ fontSize: 10, textAlign: "center" }}>{i}</td>)}<td style={{ width: 22 }} /></tr>
            <tr>{Array.from({ length: W }, (_, i) => cell(i, "a"))}<td style={{ fontFamily: MONO, fontSize: 11, paddingLeft: 4 }}>a</td></tr>
            <tr>{Array.from({ length: W }, (_, i) => cell(i, "b"))}<td style={{ fontFamily: MONO, fontSize: 11, paddingLeft: 4 }}>b</td></tr>
          </tbody>
        </table>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 10px", alignItems: "center", margin: "10px 0", fontSize: 12.5 }}>
        <span className="muted">sel₁ (a &gt; {x})</span>{vec(st.p1.sel, ACC)}
        {stage !== "p1" && <><span className="muted">sel₂ (b &lt; {y})</span>{vec(st.p2.sel, GOOD)}</>}
      </div>
      <pre style={{ fontFamily: MONO, fontSize: 12, margin: 0, padding: "8px 10px", background: "var(--subtle)", borderRadius: 6, overflowX: "auto", lineHeight: 1.5 }}>
        <span style={{ color: stage === "p1" ? ACC : "var(--muted)" }}>{"// filter 1: all 16 rows, no branch\nlet mut k = 0;\nfor i in 0..n { sel1[k] = i; k += (a[i] > x) as usize; }\n"}</span>
        <span style={{ color: stage === "p2" ? GOOD : "var(--muted)" }}>{"// filter 2: only the rows in sel1\nlet mut k2 = 0;\nfor &i in &sel1[..k] { sel2[k2] = i; k2 += (b[i] < y) as usize; }\n"}</span>
        <span style={{ color: stage === "agg" ? WARM : "var(--muted)" }}>{"// aggregate: no copy, follow sel2\nfor &i in &sel2[..k2] { sum += a[i] * b[i]; }"}</span>
      </pre>
      <StepCaption>
        {stage === "p1" && `Filter 1 tests a > ${x} on all 16 rows and writes the ${st.p1.sel.length} passing positions into a selection vector. No row is copied.`}
        {stage === "p2" && `Filter 2 tests b < ${y} only on the ${st.p1.sel.length} positions in sel₁, and ${st.p2.sel.length} remain. Faded cells were never read.`}
        {stage === "agg" && `The aggregate reads a and b only at the ${st.p2.sel.length} positions of sel₂: SUM(a × b) = ${sum}.`}
      </StepCaption>
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "predicate evaluations", value: st.p1.evaluated + (stage === "p1" ? 0 : st.p2.evaluated) },
        { label: "without a selection vector", value: 32 },
        { label: "rows left", value: (stage === "p1" ? st.p1 : st.p2).sel.length },
        { label: "rows copied", value: 0 },
      ]} />
    </Demo>
  );
}

// ============================================================================ 3. branching vs branch-free

export function BranchDemo() {
  const [sel, setSel] = useState(0.5);
  const [pen, setPen] = useState(15);
  const m = { ...BRANCH_MODEL, penaltyCycles: pen };
  const pts = useMemo(() => Array.from({ length: 41 }, (_, i) => i / 40).map((p) => [p, branchSim(p, 20000, 3, m)] as const), [pen]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = branchSim(sel, 20000, 3, m);
  const cross = pts.filter(([, r]) => r.branching > r.branchFree);
  const lo = cross.length ? cross[0]![0] : null, hi = cross.length ? cross[cross.length - 1]![0] : null;
  return (
    <Demo
      title="Branching against branch-free selection"
      controls={
        <>
          <Param spec={range({ label: "Selectivity (share of rows that pass)", min: 0, max: 1, step: 0.01, default: 0.5, format: (v) => `${Math.round(v * 100)}%` })} value={sel} onChange={(v) => setSel(v as number)} />
          <Param spec={range({ label: "Misprediction penalty (cycles)", min: 5, max: 30, step: 1, default: 15 })} value={pen} onChange={(v) => setPen(v as number)} />
        </>
      }
    >
      <Plot x={[0, 1]} y={[0, 2 + pen * 0.6]} height={230} xLabel="selectivity" yLabel="cycles per tuple" xFormat={(v) => `${Math.round(v * 100)}%`}>
        <Line points={pts.map(([p, r]) => [p, r.branching] as const)} color={BAD} width={2.4} />
        <Line points={pts.map(([p]) => [p, m.branchFreeCycles] as const)} color={GOOD} width={2.4} />
        <RuleX at={sel} />
        <Dots points={[[sel, cur.branching]]} color={BAD} r={5} />
      </Plot>
      <Legend items={[{ label: "if (a[i] > x) sel[k++] = i;  (2-bit predictor, simulated)", color: BAD }, { label: "sel[k] = i; k += (a[i] > x);", color: GOOD }]} />
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "mispredicted branches", value: `${(cur.mispredictRate * 100).toFixed(1)}%` },
        { label: "branching: cycles per tuple", value: cur.branching.toFixed(2) },
        { label: "branch-free: cycles per tuple", value: m.branchFreeCycles.toFixed(2) },
        { label: "branch-free wins between", value: lo !== null ? `${Math.round(lo * 100)}% and ${Math.round(hi! * 100)}%` : "never" },
      ]} />
      <Note>Model: random input, so the outcome of each row is a coin with bias = selectivity. A 2-bit saturating counter predicts each branch. The branching loop costs {m.baseCycles} cycle per row plus {pen} per misprediction; the branch-free loop always costs {m.branchFreeCycles}.</Note>
    </Demo>
  );
}

