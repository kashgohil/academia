import { useEffect, useMemo, useState } from "react";
import { contours } from "d3-contour";
import { Demo, Stats, Controls, Plot, Line, Dots, Legend, usePlot, useParams, useSim, range, select, toggle } from "../kit";
import { SURFACES, getSurface, run, type OptimizerId, type Surface, type Vec2 } from "../sims/optim";
import { mulberry32, normal } from "../sims/rng";

const schema = {
  surface: select({ label: "Loss surface", options: SURFACES.map((s) => ({ value: s.id, label: s.label })), default: "bowl" }),
  lr: range({ label: "Learning rate (SGD, momentum)", min: 0.001, max: 1, default: 0.05, log: true }),
  adamLr: range({ label: "Learning rate (Adam)", min: 0.001, max: 2, default: 0.1, log: true }),
  beta: range({ label: "Momentum β", min: 0, max: 0.99, step: 0.01, default: 0.9 }),
  noise: range({ label: "Gradient noise σ", min: 0, max: 10, step: 0.1, default: 0 }),
  sgd: toggle({ label: "SGD", default: true }),
  momentum: toggle({ label: "Momentum", default: true }),
  adam: toggle({ label: "Adam", default: true }),
};

const STEPS = 400;
const OPTS: { id: OptimizerId; label: string; color: string }[] = [
  { id: "sgd", label: "SGD", color: "var(--c4)" },
  { id: "momentum", label: "Momentum", color: "var(--c1)" },
  { id: "adam", label: "Adam", color: "var(--c3)" },
];

function noisy(s: Surface, sigma: number, seed: number): Surface {
  if (sigma === 0) return s;
  const r = mulberry32(seed);
  return { ...s, grad: (x, y) => { const g = s.grad(x, y); return [g[0] + sigma * normal(r), g[1] + sigma * normal(r)]; } };
}

export function GradientDescentDemo() {
  const params = useParams("gd", schema);
  const v = params.values;
  const surf = getSurface(v.surface);
  const [start, setStart] = useState<Vec2>(surf.start);
  const [k, setK] = useState(0);
  useEffect(() => setStart(surf.start), [surf]);

  const sim = useSim({ dt: 1 / 40, step: () => setK((x) => (x >= STEPS ? x : x + 1)) });
  useEffect(() => { if (k >= STEPS) sim.pause(); }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  const restart = () => { setK(0); sim.play(); };
  useEffect(restart, [v.surface, v.lr, v.adamLr, v.beta, v.noise, start]); // eslint-disable-line react-hooks/exhaustive-deps

  const paths = useMemo(() => {
    const out: Partial<Record<OptimizerId, Vec2[]>> = {};
    for (const o of OPTS) {
      if (!v[o.id]) continue;
      const lr = o.id === "adam" ? v.adamLr : v.lr;
      out[o.id] = run(noisy(surf, v.noise, 42), o.id, { lr, beta: o.id === "momentum" ? v.beta : 0.9 }, STEPS, start);
    }
    return out;
  }, [surf, v.lr, v.adamLr, v.beta, v.noise, v.sgd, v.momentum, v.adam, start]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmin = Math.min(...surf.minima.map(([x, y]) => surf.f(x, y)));
  const gap = (p: Vec2) => Math.max(1e-8, surf.f(p[0], p[1]) - fmin);

  return (
    <Demo
      title="Optimizers on a 2D loss surface"
      actions={
        <>
          <button className="btn" onClick={k >= STEPS ? restart : sim.toggle}>{sim.running ? "Pause" : k >= STEPS ? "Replay" : "Play"}</button>
          <button className="btn ghost" onClick={() => setStart(surf.start)}>Reset start</button>
        </>
      }
      controls={<Controls params={params} />}
    >
      <Stats
        items={[
          { label: "step", value: `${Math.min(k, STEPS)} / ${STEPS}` },
          ...OPTS.filter((o) => paths[o.id]).map((o) => {
            const path = paths[o.id]!;
            const diverged = path.length < STEPS + 1 && k >= path.length - 1;
            const p = path[Math.min(k, path.length - 1)]!;
            return { label: `${o.label} loss gap`, value: diverged ? "diverged" : gap(p).toExponential(1) };
          }),
        ]}
      />
      <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 4px" }}>Click anywhere on the surface to start from there.</p>
      <Plot x={surf.domain.x} y={surf.domain.y} height={380} grid={false}>
        <Contours surface={surf} />
        <ClickLayer onPick={setStart} />
        {OPTS.map((o) => {
          const path = paths[o.id];
          if (!path) return null;
          const shown = path.slice(0, k + 1);
          return (
            <g key={o.id}>
              <Line points={shown} color={o.color} width={1.75} />
              <Dots points={shown.slice(-1)} color={o.color} r={4} />
            </g>
          );
        })}
        <Dots points={surf.minima} color="var(--fg)" r={2.5} />
        <Dots points={[start]} color="var(--fg)" r={4} />
      </Plot>
      <Legend items={OPTS.filter((o) => paths[o.id]).map((o) => ({ label: o.label, color: o.color }))} />
      <div style={{ height: 12 }} />
      <Plot x={[0, STEPS]} y={[1e-8, 1e4]} logY height={170} xLabel="step" yLabel="f(θ) − f*" yFormat={(t) => (Math.log10(t) % 2 === 0 ? `1e${Math.log10(t)}` : "")}>
        {OPTS.map((o) => {
          const path = paths[o.id];
          if (!path) return null;
          return <Line key={o.id} points={path.slice(0, k + 1).map((p, i) => [i, Math.min(1e4, gap(p))] as [number, number])} color={o.color} width={1.5} />;
        })}
      </Plot>
    </Demo>
  );
}

/** Filled contour bands of log(f − f*) computed on a grid with d3-contour. */
function Contours({ surface }: { surface: Surface }) {
  const { x, y } = usePlot();
  const bands = useMemo(() => {
    const nx = 140, ny = 110;
    const { x: [x0, x1], y: [y0, y1] } = surface.domain;
    const raw = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) raw[j * nx + i] = surface.f(x0 + ((i + 0.5) / nx) * (x1 - x0), y0 + ((j + 0.5) / ny) * (y1 - y0));
    let lo = Infinity;
    for (const r of raw) lo = Math.min(lo, r);
    const vals = Array.from(raw, (r) => Math.log(r - lo + 1e-2));
    const vmin = Math.min(...vals), vmax = Math.max(...vals);
    const levels = Array.from({ length: 16 }, (_, i) => vmin + ((i + 1) / 17) * (vmax - vmin));
    return { gens: contours().size([nx, ny]).thresholds(levels)(vals), nx, ny };
  }, [surface]);

  const { x: [x0, x1], y: [y0, y1] } = surface.domain;
  const toPath = (rings: number[][][][]) =>
    rings
      .flatMap((poly) => poly.map((ring) => "M" + ring.map(([gx, gy]) => `${x(x0 + (gx! / bands.nx) * (x1 - x0)).toFixed(1)},${y(y0 + (gy! / bands.ny) * (y1 - y0)).toFixed(1)}`).join("L") + "Z"))
      .join("");

  return (
    <g>
      {bands.gens.map((c, i) => (
        <path key={i} d={toPath(c.coordinates as number[][][][])} fill="var(--c1)" fillOpacity={0.045} stroke="var(--faint)" strokeOpacity={0.5} strokeWidth={0.75} />
      ))}
    </g>
  );
}

function ClickLayer({ onPick }: { onPick: (p: Vec2) => void }) {
  const { x, y, w, h } = usePlot();
  return (
    <rect
      width={w}
      height={h}
      fill="transparent"
      style={{ cursor: "crosshair" }}
      onClick={(e) => {
        const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
        onPick([x.invert(e.clientX - r.left), y.invert(e.clientY - r.top)]);
      }}
    />
  );
}
