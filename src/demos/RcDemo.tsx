import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Controls, Plot, Line, Area, RuleX, RuleY, Dots, Legend, useParams, useSim, range, select, toggle, si } from "../kit";
import { charge, discharge, eulerCharge, tau, energy } from "../sims/rc";

const schema = {
  R: range({ label: "Resistance R", min: 100, max: 1e6, default: 10_000, log: true, format: (v) => si(v, "Ω") }),
  C: range({ label: "Capacitance C", min: 1e-6, max: 1e-3, default: 100e-6, log: true, format: (v) => si(v, "F") }),
  Vs: range({ label: "Source Vs", min: 1, max: 12, step: 0.5, default: 5, format: (v) => `${v} V` }),
  mode: select({ label: "Switch", options: [{ value: "charge", label: "Charge" }, { value: "discharge", label: "Discharge" }], default: "charge", segmented: true }),
  units: toggle({ label: "Time axis in units of τ", default: false }),
};

const WINDOW = 5; // seconds shown on a fixed axis

export function RcDemo() {
  const params = useParams("rc", schema);
  const { R, C, Vs, mode, units } = params.values;
  const p = { R, C, Vs };
  const T = tau(p);
  const tEnd = units ? 5 * T : WINDOW;
  const at = (t: number) => (mode === "charge" ? charge(p, t) : discharge(p, t, Vs));

  const tRef = useRef(tEnd);
  const [, setTick] = useState(0);
  const sim = useSim({
    dt: 1 / 240,
    step: (dt) => {
      tRef.current = Math.min(tEnd, tRef.current + dt * (tEnd / WINDOW));
      if (tRef.current >= tEnd) sim.pause();
    },
    reset: () => {
      tRef.current = 0;
      setTick((x) => x + 1);
    },
  });
  const now = Math.min(tRef.current, tEnd);

  const curve = useMemo(() => {
    const pts: { t: number; v: number; i: number }[] = [];
    for (let k = 0; k <= 400; k++) {
      const t = (k / 400) * tEnd;
      pts.push({ t, ...at(t) });
    }
    return pts;
  }, [R, C, Vs, mode, tEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = curve.filter((q) => q.t <= now + 1e-12);
  const x = (t: number) => (units ? t / T : t);
  const iMax = Vs / R;
  const cur = at(now);
  const target = mode === "charge" ? Vs * (1 - Math.exp(-1)) : Vs * Math.exp(-1);

  return (
    <Demo
      title="Series RC circuit"
      actions={
        <>
          <button className="btn primary" onClick={() => { sim.reset(); sim.play(); }}>Flip switch</button>
          <button className="btn" onClick={sim.toggle} disabled={now >= tEnd}>{sim.running ? "Pause" : "Resume"}</button>
        </>
      }
      controls={<Controls params={params} />}
    >
      <Schematic charge={mode === "charge"} fill={cur.v / Vs} current={Math.abs(cur.i) / iMax} />
      <Stats
        items={[
          { label: "τ = RC", value: si(T, "s") },
          { label: "t", value: units ? `${(now / T).toFixed(2)} τ` : si(now, "s") },
          { label: "v_C(t)", value: si(cur.v, "V") },
          { label: "i(t)", value: si(cur.i, "A") },
          { label: "Energy in C", value: si(energy(C, cur.v), "J") },
        ]}
      />
      <div style={{ height: 12 }} />
      <Plot x={[0, x(tEnd)]} y={[0, Vs * 1.05]} height={200} xLabel={units ? "t / τ" : "t (s)"} yLabel="v_C (V)">
        <Line points={curve.map((q) => [x(q.t), q.v])} color="var(--border)" width={1.5} />
        <Area points={visible.map((q) => [x(q.t), q.v])} />
        <Line points={visible.map((q) => [x(q.t), q.v])} />
        {T <= tEnd && <RuleX at={x(T)} label="τ" />}
        <RuleY at={target} label={mode === "charge" ? "63.2%" : "36.8%"} />
        <Dots points={[[x(now), cur.v]]} r={4} />
      </Plot>
      <Plot x={[0, x(tEnd)]} y={mode === "charge" ? [0, iMax * 1.05] : [-iMax * 1.05, 0]} height={150} xLabel={units ? "t / τ" : "t (s)"} yLabel="i (A)" yFormat={(v) => si(v, "A", 2)}>
        <Line points={curve.map((q) => [x(q.t), q.i])} color="var(--border)" width={1.5} />
        <Line points={visible.map((q) => [x(q.t), q.i])} color="var(--c2)" />
        {T <= tEnd && <RuleX at={x(T)} />}
      </Plot>
      <Legend items={[{ label: "capacitor voltage", color: "var(--c1)" }, { label: "current", color: "var(--c2)" }]} />
    </Demo>
  );
}

/** Minimal schematic: SPDT switch selects source (charge) or ground (discharge). */
function Schematic({ charge, fill, current }: { charge: boolean; fill: number; current: number }) {
  const muted = { fill: "var(--muted)", stroke: "none", fontSize: 11 };
  return (
    <svg viewBox="0 0 360 116" style={{ width: "100%", maxWidth: 380, display: "block", margin: "0 auto 12px" }} fill="none" stroke="var(--fg)" strokeWidth={1.5}>
      {/* source */}
      <line x1={40} y1={20} x2={40} y2={50} />
      <line x1={28} y1={50} x2={52} y2={50} />
      <line x1={33} y1={58} x2={47} y2={58} />
      <line x1={40} y1={58} x2={40} y2={100} />
      <text x={6} y={58} {...muted}>Vs</text>
      {/* switch: contacts A (source) and B (ground), pivot on the right */}
      <line x1={40} y1={20} x2={98} y2={20} />
      <circle cx={101} cy={20} r={2.5} />
      <circle cx={101} cy={52} r={2.5} />
      <line x1={101} y1={55} x2={101} y2={100} />
      <circle cx={140} cy={20} r={2.5} />
      <line x1={138} y1={21} x2={104} y2={charge ? 20 : 50} />
      <text x={108} y={74} {...muted}>{charge ? "to Vs" : "to ground"}</text>
      {/* resistor */}
      <polyline points="143,20 152,20 160,10 172,30 184,10 196,30 208,10 216,20 230,20" />
      <text x={180} y={48} {...muted}>R</text>
      <line x1={230} y1={20} x2={300} y2={20} />
      {/* capacitor */}
      <line x1={300} y1={20} x2={300} y2={54} />
      <line x1={282} y1={54} x2={318} y2={54} />
      <line x1={282} y1={64} x2={318} y2={64} />
      <line x1={300} y1={64} x2={300} y2={100} />
      <text x={266} y={63} {...muted}>C</text>
      <rect x={330} y={40} width={8} height={36} stroke="var(--border)" />
      <rect x={330} y={40 + 36 * (1 - fill)} width={8} height={36 * fill} fill="var(--c1)" stroke="none" />
      <line x1={40} y1={100} x2={300} y2={100} />
      {/* current arrow, opacity ∝ |i| */}
      <g opacity={Math.max(0.1, current)} stroke="var(--c2)">
        <line x1={246} y1={10} x2={276} y2={10} />
        <polyline points={charge ? "270,6 276,10 270,14" : "252,6 246,10 252,14"} />
      </g>
    </svg>
  );
}

// ---------------- Euler vs exact ----------------

const eulerSchema = {
  ratio: range({ label: "Step size Δt / τ", min: 0.05, max: 2.5, step: 0.05, default: 0.5, format: (v) => v.toFixed(2) }),
};

export function RcEulerDemo() {
  const params = useParams("rce", eulerSchema);
  const { ratio } = params.values;
  const p = { R: 1, C: 1, Vs: 1 };
  const tEnd = 8;
  const exact = Array.from({ length: 201 }, (_, k) => {
    const t = (k / 200) * tEnd;
    return [t, charge(p, t).v] as [number, number];
  });
  const euler: [number, number][] = [];
  for (let t = 0; t <= tEnd + 1e-9; t += ratio) euler.push([t, eulerCharge(p, t, ratio)]);
  const err = Math.max(...euler.map(([t, v]) => Math.abs(v - charge(p, t).v)));

  return (
    <Demo title="Simulating the same circuit with explicit Euler" controls={<Controls params={params} />}>
      <Stats items={[{ label: "max error", value: err.toFixed(3) + " V" }, { label: "steps", value: euler.length - 1 }, { label: "regime", value: ratio < 1 ? "monotone" : ratio < 2 ? "oscillating" : "unstable" }]} />
      <div style={{ height: 8 }} />
      <Plot x={[0, tEnd]} y={[-0.5, 2]} height={220} xLabel="t / τ" yLabel="v / Vs">
        <Line points={exact} color="var(--faint)" />
        <Line points={euler} color="var(--c4)" width={1.5} />
        <Dots points={euler} color="var(--c4)" r={2.5} />
        <RuleY at={1} />
      </Plot>
      <Legend items={[{ label: "exact", color: "var(--faint)" }, { label: "Euler", color: "var(--c4)" }]} />
    </Demo>
  );
}
