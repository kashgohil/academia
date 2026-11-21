/** Demos for the lesson on systolic arrays. */
import { useMemo } from "react";
import {
  Banner, Btn, ButtonRow, Controls, Demo, Dots, Line, Plot, RuleX, SectionLabel, SmallLabel, StepButtons, StepCaption, StepSlider, Stats, fixed, int, mono, pct, range, seg, tint, useParams, useStepper,
} from "../../kit";
import { TPU1_PEAK_TOPS, TPU1_TILE_LOAD, runSystolic, tpuLayer, type Dataflow } from "../../sims/arch/parallel";

const TAGS = ["var(--c1)", "var(--c3)", "var(--c5)", "var(--c2)", "var(--c4)"];
const tagColor = (t: number) => TAGS[((t % TAGS.length) + TAGS.length) % TAGS.length]!;

function Matrix({ m, label, state }: { m: (number | null)[][]; label: string; state?: (r: number, c: number) => "done" | "now" | "wait" | "none"; }) {
  return (
    <div style={{ minWidth: 0 }}>
      <SmallLabel>{label}</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${m[0]?.length ?? 1}, 20px)`, gap: 2 }}>
        {m.flatMap((row, r) => row.map((v, c) => {
          const s = state?.(r, c) ?? "none";
          return (
            <div key={`${r}-${c}`} style={{ height: 20, fontSize: 11, display: "grid", placeItems: "center", borderRadius: 3, border: "1px solid var(--border)", background: s === "now" ? tint(tagColor(r), 45) : s === "done" ? "var(--subtle)" : "var(--bg)", color: s === "done" ? "var(--muted)" : "var(--fg)", ...mono }}>
              {v === null ? "" : v}
            </div>
          );
        }))}
      </div>
    </div>
  );
}

export function ArchParSystolicDemo() {
  const p = useParams("parsys", {
    size: range({ label: "Array size (PEs per side)", min: 2, max: 6, step: 1, default: 4 }),
    stream: range({ label: "Stream length (rows of X, or k)", min: 1, max: 12, step: 1, default: 4 }),
    flow: seg<Dataflow>("Dataflow", [["ws", "Weight stationary"], ["os", "Output stationary"]], "ws"),
  });
  const { size, stream, flow } = p.values;
  const run = useMemo(() => runSystolic(flow, size, size, stream), [flow, size, stream]);
  const st = useStepper(run.frames.length, 2);
  const f = run.frames[st.i]!;
  const t = f.t;
  const busy = f.pes.flat().filter((x) => x.mac).length;
  const ws = flow === "ws";
  // Which input cells have entered the array: WS: X[m][r] enters at cycle m + r. OS: A[i][k] at k + i, B[k][j] at k + j.
  const leftState = (r: number, c: number) => { const enter = ws ? r + c : c + r; return enter < t ? "done" : enter === t ? "now" : "wait"; };
  const topState = (r: number, c: number) => { if (ws) return "none" as const; const enter = r + c; return enter < t ? "done" : enter === t ? "now" : "wait"; };
  const cell = size > 4 ? 46 : 56;
  return (
    <Demo title="A systolic array, one clock cycle at a time" actions={<StepButtons s={st} />} controls={<><Controls params={p} /><StepSlider s={st} label="Cycle" /></>}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <SmallLabel>{ws ? "Each PE holds one weight w. Values a move right; partial sums move down." : "Each PE holds one accumulator. A values move right; B values move down."}</SmallLabel>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${size}, ${cell}px)`, gap: 4, width: "max-content" }}>
            {f.pes.flatMap((row, r) => row.map((pe, c) => (
              <div key={`${r}-${c}`} style={{ height: cell, borderRadius: 5, border: `1.5px solid ${pe.mac ? tagColor(pe.aTag) : "var(--border)"}`, background: pe.mac ? tint(tagColor(pe.aTag), 18) : "var(--bg)", padding: "2px 4px", fontSize: 10.5, lineHeight: 1.25, display: "grid", alignContent: "space-between", ...mono }}>
                <span className="muted">{ws ? `w=${pe.held}` : `acc=${pe.held}`}</span>
                <span>{pe.a !== null ? `a=${pe.a}` : " "}</span>
                <span style={{ color: "var(--muted)" }}>{pe.b !== null ? (ws ? `p=${pe.b}` : `b=${pe.b}`) : " "}</span>
              </div>
            )))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Matrix m={run.left} label={ws ? "X (enters from the left)" : "A (enters from the left)"} state={leftState} />
          {!ws && <Matrix m={run.top} label="B (enters from the top)" state={topState} />}
          <Matrix m={f.outputs} label={ws ? "Y = X·W (leaves at the bottom)" : "C = A·B (stays in the PEs)"} />
        </div>
      </div>
      <StepCaption label={`cycle ${t}`}>
        {busy === 0 ? "No PE has data this cycle." : `${busy} of ${size * size} PEs do a multiply-add. ${t < size - 1 ? "The array is still filling: the skew delays each row by one cycle." : st.atEnd ? (run.correct ? "Done. The result equals the plain matrix product." : "The result is wrong.") : ""}`}
      </StepCaption>
      <Stats items={[
        { label: "cycles in total", value: `${run.cycles} = ${stream} + ${size} + ${size} − 2` },
        { label: "multiply-adds so far", value: f.macs },
        { label: "utilization so far", value: pct(f.macs / ((t + 1) * size * size), 0) },
        { label: "utilization of the whole run", value: pct(run.utilization, 0) },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- TPU v1 layer utilization

const MS = Array.from({ length: 49 }, (_, i) => 2 ** (i / 4));
const LAYERS: [string, number, number][] = [["MLP layer 2048 × 2048", 2048, 2048], ["300 × 300", 300, 300], ["256 × 256", 256, 256], ["First conv layer 27 × 64", 27, 64]];

export function ArchParTpuDemo() {
  const p = useParams("partpu", {
    batch: range({ label: "Batch M (rows streamed through each tile)", min: 1, max: 4096, default: 16, log: true, format: (v) => int(v) }),
    k: range({ label: "Weight rows K", min: 1, max: 4096, default: 2048, log: true, format: (v) => int(v) }),
    n: range({ label: "Weight columns N", min: 1, max: 4096, default: 2048, log: true, format: (v) => int(v) }),
  });
  const M = Math.round(p.values.batch), K = Math.round(p.values.k), N = Math.round(p.values.n);
  const l = tpuLayer(M, K, N);
  const curve = MS.map((m) => [m, tpuLayer(m, K, N).utilization] as const);
  const showK = Math.min(l.tk, 12), showN = Math.min(l.tn, 12);
  return (
    <Demo title="TPU v1: one 256 × 256 array, weights from DDR3" controls={<Controls params={p} />}>
      <ButtonRow style={{ marginBottom: 8 }}>
        {LAYERS.map(([name, k, n]) => <Btn key={name} ghost on={K === k && N === n} onClick={() => { p.set("k", k); p.set("n", n); }}>{name}</Btn>)}
      </ButtonRow>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, alignItems: "start" }}>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>Weight tiles of 256 × 256 ({l.tk} × {l.tn})</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${showN}, minmax(0, 1fr))`, gap: 2, maxWidth: 240 }}>
            {Array.from({ length: showK * showN }, (_, q) => {
              const r = Math.floor(q / showN), c = q % showN;
              const fr = Math.min(1, (K - r * 256) / 256), fc = Math.min(1, (N - c * 256) / 256);
              return (
                <div key={q} style={{ aspectRatio: "1", background: "var(--subtle)", border: "1px solid var(--border)", position: "relative" }}>
                  <div style={{ position: "absolute", left: 0, top: 0, width: `${fc * 100}%`, height: `${fr * 100}%`, background: "var(--c1)", opacity: 0.75 }} />
                </div>
              );
            })}
          </div>
          {(l.tk > 12 || l.tn > 12) && <SmallLabel style={{ marginTop: 4 }}>First 12 × 12 tiles shown.</SmallLabel>}
          <SmallLabel style={{ marginTop: 4 }}>Blue: PEs that hold a real weight ({pct(l.spatial, 1)}).</SmallLabel>
        </div>
        <Plot x={[1, 4096]} y={[0, 1]} logX height={200} xLabel="batch M" yLabel="utilization" yFormat={(v) => pct(v, 0)} xTicks={[1, 16, 256, 4096]} xFormat={int}>
          <Line points={curve} color="var(--c1)" />
          <RuleX at={TPU1_TILE_LOAD} />
          <Dots points={[[M, l.utilization]]} color="var(--c4)" r={5} />
        </Plot>
      </div>
      <Stats items={[
        { label: "weight tiles", value: l.tiles },
        { label: "cycles per tile", value: `${int(l.perTile)} (${l.bound === "weights" ? "weight load" : "batch"})` },
        { label: "utilization", value: pct(l.utilization, l.utilization < 0.01 ? 2 : 1) },
        { label: `of ${fixed(TPU1_PEAK_TOPS, 1)} peak TOPS`, value: `${fixed(l.tops, l.tops < 1 ? 2 : 1)} TOPS` },
      ]} />
      <Banner tone={l.bound === "weights" ? "warn" : l.spatial < 0.5 ? "warn" : "good"}>
        {l.bound === "weights" ? `Weight bound: a 64 KiB tile takes ${int(TPU1_TILE_LOAD)} cycles to arrive at 34 GB/s, but only ${M} rows use it. Raise the batch.` : l.spatial < 0.5 ? "The batch is large enough, but most PEs hold padding: the layer is smaller than the array." : "Compute bound: each tile of weights is used by enough rows to hide its load."}
      </Banner>
    </Demo>
  );
}
