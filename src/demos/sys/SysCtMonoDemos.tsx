/** Demos for "Monomorphization costs": a model of copies per strategy, and a real rustc measurement. */
import { useMemo, useState } from "react";
import { Banner, Controls, Demo, Dots, Legend, Line, Meter, Param, Plot, RuleX, SectionLabel, Stats, bytes, mono, range, tint, useParams } from "../../kit";
import { SORT_RUNS, WRAPPER_BYTES, crossover, monoModel, sortSlopes, sortSource, type Strategy } from "../../sims/sys/comptime";
import { CodeLines } from "./SysCtUi";

const SCHEMA = {
  types: range({ label: "Types T used (K)", min: 1, max: 16, step: 1, default: 4 }),
  depth: range({ label: "Generic functions in the chain (D)", min: 1, max: 6, step: 1, default: 3 }),
  body: range({ label: "Bytes per function body (model input)", min: 50, max: 2000, step: 50, default: 400 }),
  methods: range({ label: "Trait methods each function calls", min: 1, max: 4, step: 1, default: 2 }),
};
const NAMES: Record<Strategy, string> = { generic: "generic: copy per type", outlined: "outlined: thin wrapper + one inner", dyn: "dyn: one copy + vtables" };
const COL = { body: "var(--c1)", wrap: "var(--c2)", vt: "var(--c5)" };

function Blocks({ s, k, d, body }: { s: Strategy; k: number; d: number; body: number }) {
  // One square per copy. Side length grows with the square root of the bytes.
  const side = (b: number) => Math.max(5, Math.round(Math.sqrt(b) * 0.9));
  const sq = (b: number, color: string, key: string, title: string) => (
    <span key={key} title={title} style={{ display: "inline-block", width: side(b), height: side(b), background: tint(color, 55), border: `1px solid ${color}`, borderRadius: 2 }} />
  );
  const fns = Array.from({ length: d }, (_, j) => `f${j + 1}`);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "flex-end", minHeight: 30 }}>
      {s === "generic" && fns.flatMap((f) => Array.from({ length: k }, (_, t) => sq(body, COL.body, `${f}${t}`, `${f}<T${t + 1}>: ${body} B`)))}
      {s === "outlined" && <>
        {fns.map((f) => sq(body, COL.body, f, `${f}_inner: ${body} B`))}
        {fns.flatMap((f) => Array.from({ length: k }, (_, t) => sq(WRAPPER_BYTES, COL.wrap, `${f}w${t}`, `${f}<T${t + 1}> wrapper: ${WRAPPER_BYTES} B`)))}
      </>}
      {s === "dyn" && <>
        {fns.map((f) => sq(body, COL.body, f, `${f}(&dyn Trait): ${body} B`))}
        {Array.from({ length: k }, (_, t) => sq(40, COL.vt, `vt${t}`, `vtable for T${t + 1}`))}
      </>}
    </div>
  );
}

export function MonoModelDemo() {
  const P = useParams("sys-ct-mono", SCHEMA);
  const { types: k, depth: d, body, methods } = P.values;
  const rs = (["generic", "outlined", "dyn"] as Strategy[]).map((s) => monoModel(s, { types: k, depth: d, body, methods }));
  const max = Math.max(...rs.map((r) => r.total));
  const cross = crossover({ depth: d, body, methods });
  return (
    <Demo title="Count the copies: generic, outlined or dyn" controls={<Controls params={P} />}>
      <div style={{ overflowX: "auto", fontSize: 12.5, marginBottom: 6, ...mono, whiteSpace: "pre", color: "var(--muted)" }}>
        {`f1<T>() → f2<T>() → … → f${d}<T>(), used with ${k} type${k > 1 ? "s" : ""}`}
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {rs.map((r) => (
          <div key={r.strategy} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
            <Meter label={NAMES[r.strategy]} value={r.total} max={max} color={r.total === Math.min(...rs.map((x) => x.total)) ? "var(--c3)" : "var(--c1)"} text={`${r.functions} functions, ${bytes(r.total)}`} />
            <Blocks s={r.strategy} k={k} d={d} body={body} />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Bodies the optimizer compiles: {r.bodiesCompiled}. Indirect calls per pass down the chain: {r.indirectCalls}.
            </div>
          </div>
        ))}
      </div>
      <Legend items={[{ label: "full body", color: COL.body }, { label: `wrapper (${WRAPPER_BYTES} B)`, color: COL.wrap }, { label: "vtable", color: COL.vt }]} />
      <Banner tone="info">
        {cross === Infinity ? "With these inputs dyn is never smaller." : cross <= 1 ? "With these inputs dyn is smaller already at one type." : `With these inputs dyn becomes smaller than generic at ${cross} types.`} Outlining keeps static dispatch and still cuts the copies to {d} bodies plus small wrappers.
      </Banner>
    </Demo>
  );
}

const RSPEC = { i: range({ label: "Closures N (index into the runs)", min: 0, max: SORT_RUNS.length - 1, step: 1, default: 3, format: (v) => String(SORT_RUNS[v]!.n) }) };

export function SortMeasureDemo() {
  const P = useParams("sys-ct-sort", RSPEC);
  const run = SORT_RUNS[P.values.i]!;
  const [mode, setMode] = useState<"generic" | "dyn">("generic");
  const src = useMemo(() => sortSource(Math.min(run.n, 4), mode).split("\n"), [run.n, mode]);
  const s = sortSlopes();
  const lg = (n: number) => Math.log2(n);
  return (
    <Demo title="Measured: one sort_by per closure, rustc 1.96.1 -O" controls={<>
      <Controls params={P} />
      <Param spec={{ kind: "select", label: "Show the source of", options: [{ value: "generic", label: "generic" }, { value: "dyn", label: "dyn" }], default: "generic", segmented: true }} value={mode} onChange={(v) => setMode(v as "generic" | "dyn")} />
    </>}>
      <Stats items={[
        { label: "N closures", value: run.n },
        { label: ".text, generic", value: bytes(run.genericText) },
        { label: ".text, dyn", value: bytes(run.dynText) },
        { label: "rustc time, generic / dyn", value: `${run.genericSec.toFixed(2)} s / ${run.dynSec.toFixed(2)} s` },
      ]} />
      <SectionLabel>Code size of the object file (__text), KiB</SectionLabel>
      <Plot x={[0, 5]} y={[0, 175]} height={200} xLabel="closures N" yLabel="KiB" xTicks={[0, 1, 2, 3, 4, 5]} xFormat={(v) => String(2 ** v)}>
        <RuleX at={lg(run.n)} />
        <Line points={SORT_RUNS.map((r) => [lg(r.n), r.genericText / 1024])} color="var(--c4)" />
        <Line points={SORT_RUNS.map((r) => [lg(r.n), r.dynText / 1024])} color="var(--c1)" />
        <Dots points={[[lg(run.n), run.genericText / 1024]]} color="var(--c4)" r={5} />
        <Dots points={[[lg(run.n), run.dynText / 1024]]} color="var(--c1)" r={5} />
      </Plot>
      <SectionLabel>Compile time, best of 3, seconds (one machine)</SectionLabel>
      <Plot x={[0, 5]} y={[0, 2]} height={160} xLabel="closures N" yLabel="s" xTicks={[0, 1, 2, 3, 4, 5]} xFormat={(v) => String(2 ** v)}>
        <RuleX at={lg(run.n)} />
        <Line points={SORT_RUNS.map((r) => [lg(r.n), r.genericSec])} color="var(--c4)" />
        <Line points={SORT_RUNS.map((r) => [lg(r.n), r.dynSec])} color="var(--c1)" />
        <Dots points={[[lg(run.n), run.genericSec], [lg(run.n), run.dynSec]]} color="var(--fg)" r={4} />
      </Plot>
      <Legend items={[{ label: "generic: sort_by(closure)", color: "var(--c4)" }, { label: "dyn: sort_by(|a, b| f(a, b)) with f: &dyn Fn", color: "var(--c1)" }]} />
      <Banner tone="info">
        Each new closure adds {bytes(s.genericPer)} of sort code when it is generic, and {s.dynPer} B when it goes through <span style={mono}>&dyn Fn</span>. The x axis doubles at each tick, so the straight lines in bytes look curved here.
      </Banner>
      <SectionLabel>The measured crate, first {Math.min(run.n, 4)} of {run.n} functions</SectionLabel>
      <CodeLines lines={src.map((t) => ({ text: t }))} maxHeight={170} />
    </Demo>
  );
}
