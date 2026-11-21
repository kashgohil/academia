/** Demos for the lesson on tensor cores. */
import { lazy, Suspense, useMemo } from "react";
import {
  Banner, Btn, ButtonRow, Controls, Demo, Dots, Legend, Line, MiniTable, Plot, RuleX, RuleY, SectionLabel, SmallLabel, Stats, fixed, int, mono, pct, range, seg, sig, tint, useParams,
} from "../../kit";
import { DOT_KS, FORMATS, GPUS, dotSweep, fmaReuse, gemmPoint, gpuRidge, peakTflops, reuse, roundTo } from "../../sims/arch/parallel";

// ---------------------------------------------------------------- operand reuse

const SHAPES: [string, number, number, number][] = [["m8n8k4", 8, 8, 4], ["m16n8k8", 16, 8, 8], ["m16n8k16", 16, 8, 16], ["m64n256k16", 64, 256, 16]];

function Grid({ x, y, w, h, rows, cols, color, label }: { x: number; y: number; w: number; h: number; rows: number; cols: number; color: string; label: string }) {
  const lines = rows <= 32 && cols <= 32;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={tint(color, 30)} stroke={color} strokeWidth={1.2} />
      {lines && Array.from({ length: rows - 1 }, (_, r) => <line key={`r${r}`} x1={x} x2={x + w} y1={y + ((r + 1) * h) / rows} y2={y + ((r + 1) * h) / rows} stroke={color} strokeOpacity={0.35} strokeWidth={0.5} />)}
      {lines && Array.from({ length: cols - 1 }, (_, c) => <line key={`c${c}`} y1={y} y2={y + h} x1={x + ((c + 1) * w) / cols} x2={x + ((c + 1) * w) / cols} stroke={color} strokeOpacity={0.35} strokeWidth={0.5} />)}
      <text x={x + w / 2} y={y + h / 2} dy="0.35em" textAnchor="middle" style={{ fill: "var(--fg)", fontSize: 11 }}>{label}</text>
    </g>
  );
}

export function ArchParReuseDemo() {
  const p = useParams("parreuse", {
    m: range({ label: "m (rows of A and D)", min: 1, max: 64, step: 1, default: 16 }),
    n: range({ label: "n (columns of B and D)", min: 1, max: 256, step: 1, default: 8 }),
    k: range({ label: "k (the shared dimension)", min: 1, max: 64, step: 1, default: 16 }),
  });
  const { m, n, k } = p.values;
  const r = reuse({ m, n, k });
  const f = fmaReuse(8);
  // Layout: B on top right (k × n), A bottom left (m × k), D bottom right (m × n). Scale to fit 300 × 220.
  const s = Math.min(150 / Math.max(k + n, 1), 120 / Math.max(k + m, 1), 6);
  const sw = (v: number) => Math.max(3, v * s);
  const ax = 10, ay = 14 + sw(k) + 6, bx = ax + sw(k) + 6, by = 14;
  const W = bx + sw(n) + 10, H = ay + sw(m) + 8;
  return (
    <Demo title="Operand reuse: multiply-adds per value read" controls={<Controls params={p} />}>
      <ButtonRow style={{ marginBottom: 8 }}>
        {SHAPES.map(([name, a, b, c]) => <Btn key={name} ghost on={m === a && n === b && k === c} onClick={() => { p.set("m", a); p.set("n", b); p.set("k", c); }}>{name}</Btn>)}
      </ButtonRow>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, alignItems: "center" }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxHeight: 260, display: "block" }}>
          <Grid x={bx} y={by} w={sw(n)} h={sw(k)} rows={k} cols={n} color="var(--c3)" label="B" />
          <Grid x={ax} y={ay} w={sw(k)} h={sw(m)} rows={m} cols={k} color="var(--c1)" label="A" />
          <Grid x={bx} y={ay} w={sw(n)} h={sw(m)} rows={m} cols={n} color="var(--c2)" label="C, D" />
        </svg>
        <div>
          <MiniTable
            head={["", "vector FMA (8 lanes)", `m${m}n${n}k${k}`]}
            rows={[
              ["multiply-adds", f.macs, int(r.macs)],
              ["values read", f.reads, int(r.reads)],
              ["reads per multiply-add", fixed(f.readsPerMac, 2), fixed(r.readsPerMac, 3)],
              ["multiply-adds per read", fixed(f.macsPerRead, 2), fixed(r.macsPerRead, 2)],
            ]}
            highlight={3}
          />
          <SmallLabel style={{ marginTop: 8 }}>Each value of A is used n times, each value of B m times: work grows as m·n·k, inputs as m·k + k·n.</SmallLabel>
        </div>
      </div>
      <Stats items={[
        { label: "register traffic vs vector FMA", value: `${fixed(f.readsPerMac / r.readsPerMac, 1)}× less` },
        { label: "multiply-adds in one instruction", value: int(r.macs) },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- formats and accumulation

const FMT_ORDER = ["fp32", "tf32", "fp16", "bf16", "e4m3", "e5m2"] as const;
const ACCS = [
  { id: "fp16", color: "var(--c4)" },
  { id: "bf16", color: "var(--c2)" },
  { id: "fp32", color: "var(--c3)" },
] as const;

export function ArchParAccumDemo() {
  const p = useParams("paracc", {
    k: range({ label: "Products summed (K)", min: 16, max: 16384, default: 4096, log: true, format: (v) => int(v) }),
  });
  const sweeps = useMemo(() => ACCS.map((a) => ({ ...a, pts: dotSweep(DOT_KS, FORMATS[a.id]!) })), []);
  const K = Math.round(p.values.k);
  const now = useMemo(() => ACCS.map((a) => ({ ...a, r: dotSweep([K], FORMATS[a.id]!)[0]! })), [K]);
  return (
    <Demo title="FP16 inputs, three accumulators" controls={<Controls params={p} />}>
      <SectionLabel style={{ marginTop: 0 }}>The formats: sign, exponent, fraction bits</SectionLabel>
      <div style={{ display: "grid", gap: 3, marginBottom: 10 }}>
        {FMT_ORDER.map((id) => {
          const f = FORMATS[id]!;
          const bits = [{ n: 1, c: "var(--c4)" }, { n: f.exp, c: "var(--c1)" }, { n: f.man, c: "var(--c3)" }];
          return (
            <div key={id} style={{ display: "grid", gridTemplateColumns: "74px minmax(0, 1fr) 92px", gap: 8, alignItems: "center", fontSize: 11.5 }}>
              <span style={mono}>{f.label}</span>
              <div style={{ display: "flex", gap: 1, height: 11 }}>
                {bits.flatMap((b, j) => Array.from({ length: b.n }, (_, q) => <div key={`${j}-${q}`} style={{ flex: "0 1 9px", minWidth: 2, background: b.c, opacity: 0.8, borderRadius: 1 }} />))}
              </div>
              <span className="muted" style={{ textAlign: "right", ...mono }}>1/3 ≈ {sig(roundTo(1 / 3, f), 4)}</span>
            </div>
          );
        })}
      </div>
      <Legend items={[{ label: "sign", color: "var(--c4)" }, { label: "exponent: range", color: "var(--c1)" }, { label: "fraction: precision", color: "var(--c3)" }]} />
      <SectionLabel>A dot product of K random pairs in [0, 1)</SectionLabel>
      <Plot x={[16, 16384]} y={[1e-9, 1]} logX logY height={230} xLabel="K (products summed)" yLabel="relative error" xTicks={[16, 64, 256, 1024, 4096, 16384]} xFormat={int} yTicks={[1e-8, 1e-6, 1e-4, 1e-2, 1]} yFormat={(v) => `1e${Math.round(Math.log10(v))}`}>
        {sweeps.map((s) => <Line key={s.id} points={DOT_KS.map((k, i) => [k, Math.max(1e-9, s.pts[i]!.relErr)] as const)} color={s.color} />)}
        <RuleX at={K} />
        <RuleY at={0.01} label="1%" />
        {now.map((s) => <Dots key={s.id} points={[[K, Math.max(1e-9, s.r.relErr)]]} color={s.color} r={4} />)}
      </Plot>
      <Legend items={ACCS.map((a) => ({ label: `${FORMATS[a.id]!.label} accumulator`, color: a.color }))} />
      <Stats items={[
        { label: "exact sum", value: fixed(now[0]!.r.exact, 1) },
        ...now.map((s) => ({ label: `${FORMATS[s.id]!.label} sum`, value: `${sig(s.r.got, 5)} (${pct(s.r.relErr, s.r.relErr < 0.001 ? 4 : 1)} off)` })),
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- GEMM roofline against batch

const NS = Array.from({ length: 49 }, (_, i) => 2 ** (i / 4));

export function ArchParBatchDemo() {
  const p = useParams("parbatch", {
    n: range({ label: "Batch N (columns of the input)", min: 1, max: 4096, default: 1, log: true, format: (v) => int(v) }),
    size: seg<"1024" | "4096" | "8192">("Weight matrix (M = K)", [["1024", "1024"], ["4096", "4096"], ["8192", "8192"]], "4096"),
    gpu: seg<"0" | "1">("GPU", [["0", GPUS[0]!.name], ["1", GPUS[1]!.name]], "1"),
  });
  const g = GPUS[Number(p.values.gpu)]!;
  const M = Number(p.values.size), N = Math.round(p.values.n);
  const pt = gemmPoint(g, M, N, M);
  const peak = peakTflops(g);
  const curve = NS.map((x) => [x, gemmPoint(g, M, x, M).tflops] as const);
  return (
    <Demo title="Peak is a product of units; reaching it needs reuse" controls={<Controls params={p} />}>
      <div style={{ fontSize: 12.5, marginBottom: 8, overflowWrap: "anywhere", ...mono }}>
        {g.sms} SMs × {g.tcPerSm} tensor cores × {g.fmaPerTc} FMA × 2 FLOP × {g.clock} GHz = {fixed(peak, 1)} TFLOP/s (dense FP16)
      </div>
      <Plot x={[1, 4096]} y={[0, peak * 1.1]} logX height={230} xLabel="batch N" yLabel="TFLOP/s" xTicks={[1, 4, 16, 64, 256, 1024, 4096]} xFormat={int}>
        <Line points={curve} color="var(--c1)" />
        <RuleY at={peak} label="peak" />
        <Dots points={[[N, pt.tflops]]} color="var(--c4)" r={5} />
      </Plot>
      <Stats items={[
        { label: "FLOP per byte", value: fixed(pt.ai, 1) },
        { label: "ridge point", value: `${fixed(gpuRidge(g), 0)} FLOP/B` },
        { label: "attainable", value: `${sig(pt.tflops, 3)} TFLOP/s` },
        { label: "share of peak", value: pct(pt.frac, pt.frac < 0.1 ? 1 : 0) },
        { label: "time for this GEMM", value: `${sig(pt.seconds * 1e6, 3)} µs` },
      ]} />
      <Banner tone={pt.bound === "memory" ? "warn" : "good"}>{pt.bound === "memory" ? `Memory bound: the ${int(M * M * 2 / 1024 / 1024)} MiB of FP16 weights must stream from DRAM for only ${N} column${N > 1 ? "s" : ""} of work. The tensor cores wait.` : "Compute bound: each weight is used often enough that the tensor cores are the limit."}</Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- 3D wrapper

const Tiles3D = lazy(() => import("./ArchParTensor3D").then((m) => ({ default: m.ArchParTiles3D })));
const Loading = ({ h }: { h: number }) => <div className="demo" style={{ height: h, display: "grid", placeItems: "center" }}><span className="muted" style={{ fontSize: 13 }}>Loading 3D view…</span></div>;
export function ArchParTiles3DDemo() {
  return <Suspense fallback={<Loading h={520} />}><Tiles3D /></Suspense>;
}
