import { useEffect, useMemo, useState } from "react";
import { Demo, Controls, Plot, Line, Legend, useParams, select } from "../kit";
import { loadHeapSim, type HeapConfig, type HeapSim } from "../wasm/heapsim";
import { TRACES } from "../sims/traces";
import { replay, type ReplayResult } from "../sims/replay";

const CAP = 65536;
const ALLOCATORS: { id: string; label: string; cfg: HeapConfig; color: string }[] = [
  { id: "best", label: "Free list, best fit", cfg: { kind: "freelist", cap: CAP, a: 2, b: 1 }, color: "var(--c3)" },
  { id: "first", label: "Free list, first fit", cfg: { kind: "freelist", cap: CAP, a: 0, b: 1 }, color: "var(--c1)" },
  { id: "next", label: "Free list, next fit", cfg: { kind: "freelist", cap: CAP, a: 1, b: 1 }, color: "var(--c2)" },
  { id: "worst", label: "Free list, worst fit", cfg: { kind: "freelist", cap: CAP, a: 3, b: 1 }, color: "var(--c4)" },
  { id: "nocoal", label: "First fit, no coalescing", cfg: { kind: "freelist", cap: CAP, a: 0, b: 0 }, color: "var(--faint)" },
  { id: "buddy", label: "Buddy", cfg: { kind: "buddy", cap: CAP }, color: "var(--c5)" },
  { id: "pow2", label: "Size classes, powers of two", cfg: { kind: "sizeclass", cap: CAP, a: 1024, b: 0 }, color: "var(--muted)" },
  { id: "fine", label: "Size classes, fine", cfg: { kind: "sizeclass", cap: CAP, a: 1024, b: 1 }, color: "var(--fg)" },
];

const schema = {
  trace: select({ label: "Workload", options: TRACES.map((t) => ({ value: t.id, label: t.label })), default: "random" }),
};

export function FragmentationDemo() {
  const params = useParams("frag", schema);
  const trace = TRACES.find((t) => t.id === params.values.trace)!;
  const [w, setW] = useState<HeapSim | null>(null);
  const [focus, setFocus] = useState<Set<string>>(new Set(["best", "next", "buddy"]));
  useEffect(() => { void loadHeapSim().then(setW); }, []);

  const results = useMemo(() => {
    if (!w) return null;
    return ALLOCATORS.map((a) => ({ ...a, r: replay(w, a.cfg, trace.ops) }));
  }, [w, trace]);

  if (!results) return <div className="demo" style={{ height: 300 }} />;
  const peakLive = results[0]!.r.peakLive;
  const maxRatio = Math.max(...results.map((x) => x.r.peakFootprint / peakLive));
  const sorted = [...results].sort((a, b) => a.r.peakFootprint - b.r.peakFootprint);
  const series = (r: ReplayResult) => r.series.map((p) => [p.step, p.footprint / 1024] as [number, number]);

  return (
    <Demo title="Same trace, eight allocators" controls={<Controls params={params} />}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {trace.note} {trace.ops.length} operations, peak live data {(peakLive / 1024).toFixed(1)} KiB, 64 KiB heap.
      </p>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Memory needed ÷ peak live data (lower is better; 1.0 is perfect)</div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 200px) 1fr 48px", gap: "5px 10px", alignItems: "center", fontSize: 13 }}>
        {sorted.map((x) => {
          const ratio = x.r.peakFootprint / peakLive;
          const capped = x.r.peakFootprint > CAP * 0.9;
          return (
            <div key={x.id} style={{ display: "contents" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={focus.has(x.id)} onChange={() => setFocus((s) => { const n = new Set(s); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n; })} />
                {x.label}
              </label>
              <div style={{ height: 10, background: "var(--subtle)", borderRadius: 2 }}>
                <div style={{ height: "100%", width: `${(100 * ratio) / maxRatio}%`, background: x.color, borderRadius: 2 }} />
              </div>
              <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }} title={capped ? "Touched nearly the whole heap" : undefined}>
                {ratio.toFixed(2)}{capped ? "+" : ""}
              </span>
            </div>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 12.5, margin: "22px 0 4px" }}>Highest address in use over time (KiB), against live data</div>
      <Plot x={[0, trace.ops.length]} y={[0, 64]} height={220} xLabel="operation" yLabel="KiB">
        <Line points={results[0]!.r.series.map((p) => [p.step, p.live / 1024])} color="var(--faint)" dash="4 3" width={1.5} />
        {results.filter((x) => focus.has(x.id)).map((x) => <Line key={x.id} points={series(x.r)} color={x.color} width={1.75} />)}
      </Plot>
      <Legend items={[{ label: "live data", color: "var(--faint)" }, ...results.filter((x) => focus.has(x.id)).map((x) => ({ label: x.label, color: x.color }))]} />
    </Demo>
  );
}
