import { useEffect, useMemo, useRef, useState } from "react";
import { Demo, Stats, Controls, Plot, Bars, Line, Legend, Dots, RuleX, useParams, useSim, range, select } from "../kit";
import { DISTS, getDist, standardize } from "../sims/clt";
import { histogram, mean, normalPdf, probit, variance } from "../sims/stats";
import { mulberry32 } from "../sims/rng";

const schema = {
  dist: select({ label: "Population", options: DISTS.map((d) => ({ value: d.id, label: d.label })), default: "exponential" }),
  n: range({ label: "Sample size n", min: 1, max: 500, default: 5, log: true, format: (v) => String(Math.round(v)) }),
};

const MAX = 10_000;
const PER_TICK = 25;

export function CltDemo() {
  const params = useParams("clt", schema);
  const d = getDist(params.values.dist);
  const n = Math.max(1, Math.round(params.values.n));

  const rng = useRef(mulberry32(1));
  const means = useRef<number[]>([]);
  const [, setTick] = useState(0);

  const draw = (k: number) => {
    for (let j = 0; j < k && means.current.length < MAX; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += d.sample(rng.current);
      means.current.push(s / n);
    }
  };
  const sim = useSim({
    dt: 1 / 30,
    step: () => {
      draw(PER_TICK);
      if (means.current.length >= MAX) sim.pause();
    },
    reset: () => {
      rng.current = mulberry32(1);
      means.current = [];
    },
  });

  // New population or n: restart and pre-fill so the picture is immediately meaningful.
  useEffect(() => {
    sim.reset();
    draw(2000);
    setTick((x) => x + 1);
  }, [d.id, n]); // eslint-disable-line react-hooks/exhaustive-deps

  const population = useMemo(() => {
    const r = mulberry32(7);
    const xs = Array.from({ length: 20_000 }, () => d.sample(r));
    const bins = histogram(xs, d.view[0], d.view[1], 50);
    const w = (d.view[1] - d.view[0]) / 50;
    return bins.map((b) => ({ x0: b.x0, x1: b.x1, y: b.count / (xs.length * w) }));
  }, [d]);

  const m = Float64Array.from(means.current);
  const z = standardize(m, d, n);
  // Without a finite σ, fall back to robust scaling (median / IQR) so the shape is still comparable.
  const zs = z ?? robust(m);
  const bins = histogram(zs, -4, 4, 48).map((b) => ({ x0: b.x0, x1: b.x1, y: b.count / (Math.max(1, zs.length) * (8 / 48)) }));
  const curve = Array.from({ length: 161 }, (_, i) => {
    const x = -4 + i * 0.05;
    return [x, normalPdf(x)] as [number, number];
  });
  const qq = qqPoints(zs, 200);

  const seTheory = Number.isFinite(d.sigma2) ? Math.sqrt(d.sigma2 / n) : NaN;
  const seObs = m.length > 1 ? Math.sqrt(variance(m)) : NaN;

  return (
    <Demo
      title="Sampling distribution of the mean"
      actions={
        <>
          <button className="btn" onClick={sim.toggle} disabled={means.current.length >= MAX}>{sim.running ? "Pause" : "Draw more"}</button>
          <button className="btn ghost" onClick={() => { sim.reset(); setTick((x) => x + 1); }}>Clear</button>
        </>
      }
      controls={<Controls params={params} />}
    >
      <Stats
        items={[
          { label: "sample means drawn", value: m.length.toLocaleString() },
          { label: "mean of means", value: m.length ? mean(m).toFixed(3) : "–" },
          { label: "population μ", value: Number.isFinite(d.mu) ? d.mu.toFixed(3) : "undefined" },
          { label: "SD of means (observed)", value: Number.isFinite(seObs) ? seObs.toFixed(3) : "–" },
          { label: "σ/√n (theory)", value: Number.isFinite(seTheory) ? seTheory.toFixed(3) : d.sigma2 === Infinity ? "∞" : "undefined" },
        ]}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginTop: 14 }}>
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>Population (one draw)</div>
          <Plot x={d.view} y={[0, Math.max(...population.map((b) => b.y)) * 1.1 || 1]} height={190} ticks={4} yFormat={(v) => v.toFixed(1)}>
            <Bars bins={population} color="var(--faint)" />
            {Number.isFinite(d.mu) && d.mu >= d.view[0] && d.mu <= d.view[1] && <RuleX at={d.mu} label="μ" />}
          </Plot>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {z ? <>Standardized mean, n = {n}</> : <>Mean, robust scale (σ undefined), n = {n}</>}
          </div>
          <Plot x={[-4, 4]} y={[0, 0.6]} height={190} ticks={4} yFormat={(v) => v.toFixed(1)}>
            <Bars bins={bins} />
            <Line points={curve} color="var(--c2)" />
          </Plot>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>Q-Q vs N(0, 1)</div>
          <Plot x={[-3.5, 3.5]} y={[-5, 5]} height={190} xTicks={[-2, 0, 2]} yTicks={[-4, -2, 0, 2, 4]}>
            <Line points={[[-5, -5], [5, 5]]} color="var(--faint)" width={1} dash="4 3" />
            <Dots points={qq} r={2} />
          </Plot>
        </div>
      </div>
      <Legend items={[{ label: "sample means", color: "var(--c1)" }, { label: "N(0, 1) density", color: "var(--c2)" }, { label: "on the diagonal = normal", color: "var(--faint)" }]} />
    </Demo>
  );
}

function robust(m: Float64Array): Float64Array {
  if (m.length < 4) return m;
  const s = Float64Array.from(m).sort();
  const q = (p: number) => s[Math.floor(p * (s.length - 1))]!;
  const med = q(0.5);
  const scale = (q(0.75) - q(0.25)) / 1.349 || 1;
  return m.map((x) => (x - med) / scale);
}

function qqPoints(z: Float64Array, k: number): [number, number][] {
  if (z.length < 10) return [];
  const s = Float64Array.from(z).sort();
  const out: [number, number][] = [];
  for (let i = 0; i < k; i++) {
    const p = (i + 0.5) / k;
    out.push([probit(p), s[Math.floor(p * s.length)]!]);
  }
  return out;
}
