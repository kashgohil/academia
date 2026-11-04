import { useMemo, useState } from "react";
import { Demo, Stats, Controls, Plot, Line, Dots, Legend, RuleX, RuleY, useParams, select, range, toggle, pct, useWidth } from "../kit";
import { PREDICTORS, BRANCH_PATTERNS, makePredictor, mispredictRate, branchyCost, branchlessCost, MISPREDICT_PENALTY, schedule, sumOps, LOOPS, vectorize, type Op } from "../sims/perf/cpu";
import { mulberry32 } from "../sims/rng";

// ---------------- branch prediction ----------------

const brSchema = {
  pattern: select({ label: "Branch pattern", options: BRANCH_PATTERNS.map((p) => ({ value: p.id, label: p.label })), default: "loop8" }),
  p: range({ label: "Probability taken (random data)", min: 0.5, max: 1, step: 0.01, default: 0.5, format: (v) => pct(v, 0) }),
};

const PS = Array.from({ length: 26 }, (_, i) => 0.5 + i * 0.02);

export function BranchDemo() {
  const params = useParams("br", brSchema);
  const pattern = BRANCH_PATTERNS.find((x) => x.id === params.values.pattern)!;
  const p = params.values.p;
  const rates = useMemo(() => PREDICTORS.map((id) => ({ id, label: makePredictor(id).label, r: mispredictRate(id, pattern, p) })), [pattern, p]);
  const curve = useMemo(() => PS.map((q) => [q, branchyCost(mispredictRate("gshare", BRANCH_PATTERNS[3]!, q, 8000))] as [number, number]), []);
  return (
    <Demo title="Four branch predictors on the same branch" controls={<Controls params={params} />}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{pattern.note}</p>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(170px, 300px) 1fr 60px", gap: "6px 12px", alignItems: "center", fontSize: 13 }}>
        {rates.map((x) => (
          <div key={x.id} style={{ display: "contents" }}>
            <span>{x.label}</span>
            <div style={{ height: 10, background: "var(--subtle)", borderRadius: 2 }}><div style={{ height: "100%", width: `${100 * x.r}%`, background: x.r > 0.1 ? "var(--c4)" : "var(--c3)", borderRadius: 2 }} /></div>
            <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{pct(x.r, 1)}</span>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Mispredict rate over 20,000 executions.</p>
      <div className="muted" style={{ fontSize: 12.5, margin: "14px 0 4px" }}>if (x[i] &lt; t) sum += x[i] on random data: cycles per element</div>
      <Plot x={[0.5, 1]} y={[0, 10]} height={200} xFormat={(t) => pct(t, 0)} xLabel="probability the branch is taken">
        <RuleY at={branchlessCost()} label="branchless (cmov / mask)" color="var(--c1)" />
        <Line points={curve} color="var(--c4)" width={1.75} />
        <Dots points={curve} color="var(--c4)" r={2} />
        {pattern.id === "random" && <RuleX at={p} />}
      </Plot>
      <Legend items={[{ label: `branchy: 1 cycle + mispredicts × ${MISPREDICT_PENALTY}`, color: "var(--c4)" }, { label: "branchless: 2 cycles, always", color: "var(--c1)" }]} />
    </Demo>
  );
}

// ---------------- ILP ----------------

const ilpSchema = { k: select({ label: "Independent accumulators", options: ["1", "2", "4", "8", "16"].map((v) => ({ value: v, label: v })), default: "1", segmented: true }) };
const KS = [1, 2, 4, 8, 16];

export function IlpDemo() {
  const params = useParams("ilp", ilpSchema);
  const k = Number(params.values.k);
  const small = useMemo(() => { const ops = sumOps(48, k); return { ops, s: schedule(ops) }; }, [k]);
  const big = useMemo(() => KS.map((kk) => [kk, schedule(sumOps(4096, kk)).cycles / 4096] as [number, number]), []);
  const cur = big.find((b) => b[0] === k)![1];
  return (
    <Demo title="float sum: one dependency chain vs several" controls={<Controls params={params} />}>
      <code style={{ fontSize: 12 }}>{k === 1 ? "for i: s += a[i]" : `for i in (0..n).step_by(${k}): ${Array.from({ length: Math.min(k, 3) }, (_, j) => `s${j} += a[i+${j}]`).join("; ")}${k > 3 ? "; …" : ""}`}</code>
      <Stats items={[{ label: "cycles per element (n = 4096)", value: cur.toFixed(2) }, { label: "speedup vs one accumulator", value: `${(big[0]![1] / cur).toFixed(1)}×` }, { label: "FP add", value: "latency 4, 2 per cycle" }]} />
      <div className="muted" style={{ fontSize: 12.5, margin: "12px 0 4px" }}>Schedule of the first 48 elements: one row per accumulator chain, plus loads</div>
      <Gantt ops={small.ops} start={small.s.start} k={k} />
      <div className="muted" style={{ fontSize: 12.5, margin: "14px 0 4px" }}>Cycles per element for 4096 elements</div>
      <Plot x={[1, 16]} y={[0, 4.4]} logX height={170} xTicks={KS} xFormat={String} xLabel="accumulators">
        <RuleY at={0.5} label="throughput limit: 2 adds/cycle" color="var(--c3)" />
        <Line points={big} width={1.75} />
        <Dots points={big} r={3} />
        <RuleX at={k} />
      </Plot>
    </Demo>
  );
}

function Gantt({ ops, start, k }: { ops: Op[]; start: number[]; k: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const rows = Math.min(k, 8) + 1;
  const end = Math.max(...ops.map((o, i) => start[i]! + o.lat));
  const maxC = Math.min(end, 80);
  const cw = (w - 40) / maxC, rh = 16;
  const rowOf = (o: Op, i: number) => (o.unit === "load" ? 0 : o.label.startsWith("acc") ? 1 + (Number(o.label.slice(3).split(" ")[0]) % 8) : Math.min(rows - 1, 1 + (i % Math.max(1, rows - 1))));
  return (
    <div ref={ref}>
      <svg width={w} height={rows * rh + 18} style={{ display: "block" }}>
        <text x={0} y={rh - 4} fontSize={10} fill="var(--muted)">loads</text>
        {Array.from({ length: rows - 1 }, (_, r) => <text key={r} x={0} y={(r + 2) * rh - 4} fontSize={10} fill="var(--muted)">acc{r}</text>)}
        {ops.map((o, i) => {
          const s = start[i]!;
          if (s >= maxC) return null;
          const y = rowOf(o, i) * rh;
          return <rect key={i} x={40 + s * cw} y={y + 2} width={Math.max(1, Math.min(o.lat, maxC - s) * cw - 1)} height={rh - 4} rx={2} fill={o.unit === "load" ? "var(--faint)" : o.label === "combine" ? "var(--c2)" : "var(--c1)"} opacity={0.9} />;
        })}
        <text x={w} y={rows * rh + 14} fontSize={10} textAnchor="end" fill="var(--muted)">cycles 0–{maxC}{end > maxC ? ` (of ${end})` : ""}</text>
      </svg>
    </div>
  );
}

// ---------------- SIMD ----------------

const simdSchema = {
  lanes: select({ label: "Lanes (32-bit floats)", options: [{ value: "1", label: "scalar" }, { value: "4", label: "4 (SSE / NEON)" }, { value: "8", label: "8 (AVX2)" }, { value: "16", label: "16 (AVX-512)" }], default: "8", segmented: true }),
  k: select({ label: "Vector accumulators", options: ["1", "4", "8"].map((v) => ({ value: v, label: v })), default: "1", segmented: true }),
};

export function SimdDemo() {
  const params = useParams("simd", simdSchema);
  const lanes = Number(params.values.lanes), k = Number(params.values.k);
  const base = useMemo(() => schedule(sumOps(4096, 1)).cycles, []);
  const cyc = useMemo(() => schedule(sumOps(4096, k, lanes)).cycles, [k, lanes]);
  const [seed, setSeed] = useState(1);
  const vals = useMemo(() => { const r = mulberry32(seed); return Array.from({ length: Math.max(lanes, 4) }, () => Math.round((r() - 0.4) * 20)); }, [seed, lanes]);
  const L = Math.min(lanes, 16);
  return (
    <Demo title="Summing 4096 floats with SIMD" actions={<button className="btn" onClick={() => setSeed((s) => s + 1)}>New values</button>} controls={<Controls params={params} />}>
      <Stats items={[{ label: "cycles", value: cyc.toLocaleString() }, { label: "speedup vs scalar, 1 accumulator", value: `${(base / cyc).toFixed(1)}×` }, { label: "elements per add", value: lanes }]} />
      <div className="muted" style={{ fontSize: 12.5, margin: "14px 0 6px" }}>One step of <code>sum(x where x &gt; 0)</code>, branch-free: compare makes a mask, the add uses only selected lanes</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>
          <tbody>
            {[
              { label: "x", cells: vals.slice(0, L).map(String) },
              { label: "x > 0", cells: vals.slice(0, L).map((v) => (v > 0 ? "1…1" : "0")) },
              { label: "x & mask", cells: vals.slice(0, L).map((v) => String(v > 0 ? v : 0)) },
            ].map((row) => (
              <tr key={row.label}>
                <td style={{ padding: "3px 8px 3px 0", color: "var(--muted)", whiteSpace: "nowrap" }}>{row.label}</td>
                {row.cells.map((c, i) => <td key={i} style={{ border: "1px solid var(--border)", padding: "3px 6px", textAlign: "center", minWidth: 30, color: row.label === "x > 0" ? (c === "0" ? "var(--faint)" : "var(--c3)") : undefined }}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
        {lanes === 1 ? "Scalar: one element per instruction." : `Each instruction processes ${lanes} lanes. At the end, a horizontal reduction adds the lanes together in log₂(${lanes}) = ${Math.log2(lanes)} shuffle-and-add steps.`}
      </p>
    </Demo>
  );
}

// ---------------- auto-vectorization ----------------

const vecSchema = {
  loop: select({ label: "Loop", options: LOOPS.map((l) => ({ value: l.id, label: l.code.replace(/^for \(i = \d; i < n; i\+\+\) /, "") })), default: "reduce" }),
  float: select({ label: "Element type", options: [{ value: "f", label: "float" }, { value: "i", label: "int" }], default: "f", segmented: true }),
  noAlias: toggle({ label: "Arrays can't overlap (restrict, Rust &mut)", default: false }),
  fastMath: toggle({ label: "Allow FP reassociation (-ffast-math)", default: false }),
};

const VCOLOR = { yes: "var(--c3)", "with-checks": "var(--c2)", no: "var(--c4)" } as const;
const VLABEL = { yes: "Vectorized", "with-checks": "Vectorized, with caveats", no: "Not vectorized" } as const;

export function VectorizeDemo() {
  const params = useParams("vec", vecSchema);
  const v = params.values;
  const loop = LOOPS.find((l) => l.id === v.loop)!;
  const res = vectorize(v.loop, { noAlias: v.noAlias, fastMath: v.fastMath, float: v.float === "f" });
  return (
    <Demo title="Will the compiler vectorize this loop? (-O3, AVX2)" controls={<Controls params={params} />}>
      <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5, lineHeight: 1.7 }}>
        <div><span className="muted">C:    </span>{loop.code}</div>
        <div><span className="muted">Rust: </span>{loop.rust}</div>
      </div>
      <div style={{ border: `1px solid ${VCOLOR[res.vectorized]}`, borderLeft: `4px solid ${VCOLOR[res.vectorized]}`, borderRadius: 6, padding: "10px 14px", marginTop: 12 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <b style={{ color: VCOLOR[res.vectorized] }}>{VLABEL[res.vectorized]}</b>
          <span className="muted" style={{ fontSize: 12.5 }}>estimated speedup ≈ {res.speedup.toFixed(1)}×</span>
        </div>
        <div style={{ fontSize: 13.5, marginTop: 4 }}>{res.reason}</div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>A simplified model of what GCC and Clang do. Check your real compiler with <code>-Rpass=loop-vectorize -Rpass-missed=loop-vectorize</code> (Clang, also via <code>RUSTFLAGS</code>) or <code>-fopt-info-vec-missed</code> (GCC).</p>
    </Demo>
  );
}
