/** Extra demos for the flagship lessons: gradient descent (3D wrapper), RC transients and the CLT. */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, Plot, Line, Dots, Bars, RuleX, RuleY, Legend, Canvas2D, cssVar, useSim, range, select, pct } from "../kit";
import { charge } from "../sims/rc";
import {
  bucketLevels, squareSteady, squareWave, freqOverCorner,
  DICE, getDie, diceSum, pmfMoments, kolmogorovToNormal, berryEsseen,
  galtonPmf, galtonMean, galtonSd, galtonBall,
} from "../sims/flagshipextras";
import { normalPdf } from "../sims/stats";
import { mulberry32 } from "../sims/rng";

// ---------------- 3D loss surface (lazy) ----------------

const LossSurface = lazy(() => import("./LossSurface3D").then((m) => ({ default: m.LossSurface3DDemo })));

const Loading = ({ h }: { h: number }) => (
  <div className="demo" style={{ height: h, display: "grid", placeItems: "center" }}>
    <span className="muted" style={{ fontSize: 13 }}>Loading 3D view…</span>
  </div>
);

export function LossSurface3DDemo() {
  return <Suspense fallback={<Loading h={640} />}><LossSurface /></Suspense>;
}

// ---------------- RC: the capacitor as a bucket ----------------

const bucketSpecs = {
  rule: select({ label: "Flow rule", options: [{ value: "gap", label: "Flow ∝ gap (resistor)" }, { value: "fixed", label: "Fixed flow" }], default: "gap", segmented: true }),
  h: range({ label: "Step size Δt / τ", min: 0.05, max: 0.5, step: 0.05, default: 0.2, format: (v) => v.toFixed(2) }),
};

export function RcBucketDemo() {
  const [rule, setRule] = useState<"gap" | "fixed">("gap");
  const [h, setH] = useState(0.2);
  const maxSteps = Math.round(5 / h);
  const levels = useMemo(() => bucketLevels(h, maxSteps, rule), [h, maxSteps, rule]);
  const k = useRef(0);
  const [, force] = useState(0);
  const sim = useSim({
    dt: 0.45,
    step: () => {
      if (k.current < maxSteps) k.current++;
      else sim.pause();
      force((x) => x + 1);
    },
    reset: () => { k.current = 0; },
  });
  useEffect(() => { k.current = 0; force((x) => x + 1); }, [h, rule]);
  const n = Math.min(k.current, maxSteps);
  const v = levels[n]!;
  const gap = 1 - v;
  const inflow = rule === "gap" ? h * gap : Math.min(h, gap);
  const t = n * h;
  const exact = Array.from({ length: 101 }, (_, i) => [(i / 100) * 5, charge({ R: 1, C: 1, Vs: 1 }, (i / 100) * 5).v] as [number, number]);
  const shown = levels.slice(0, n + 1).map((y, i) => [i * h, y] as [number, number]);

  // Tank geometry (SVG units): level 0 at y = 120, level Vs at y = 24.
  const Y = (lv: number) => 120 - 96 * lv;
  const muted = { fill: "var(--muted)", fontSize: 10.5 };
  return (
    <Demo
      title="The capacitor as a bucket"
      actions={
        <>
          <button className="btn" onClick={sim.toggle} disabled={n >= maxSteps}>{sim.running ? "Pause" : "Play"}</button>
          <button className="btn" onClick={() => { if (k.current < maxSteps) k.current++; force((x) => x + 1); }} disabled={sim.running || n >= maxSteps}>Step</button>
          <button className="btn ghost" onClick={() => { sim.pause(); sim.reset(); }}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={bucketSpecs.h} value={h} onChange={(x) => setH(x as number)} />
          <Param spec={bucketSpecs.rule} value={rule} onChange={(x) => setRule(x as "gap" | "fixed")} />
        </>
      }
    >
      <svg viewBox="0 0 360 150" style={{ width: "100%", maxWidth: 440, display: "block", margin: "0 auto" }}>
        {/* source tank, always at Vs */}
        <rect x={24} y={Y(1)} width={56} height={96} fill="var(--c1)" opacity={0.35} />
        <rect x={24} y={Y(1) - 8} width={56} height={104} fill="none" stroke="var(--fg)" strokeWidth={1.5} />
        <text x={52} y={140} textAnchor="middle" {...muted}>source (Vs)</text>
        {/* narrow pipe = resistor */}
        <rect x={80} y={108} width={128} height={8} fill="var(--c1)" opacity={0.35} stroke="var(--fg)" strokeWidth={1} />
        <text x={144} y={102} textAnchor="middle" {...muted}>narrow pipe (R)</text>
        <g opacity={inflow > 1e-4 ? 1 : 0.15}>
          <line x1={110} y1={112} x2={176} y2={112} stroke="var(--c2)" strokeWidth={1 + 14 * inflow} strokeLinecap="round" opacity={0.8} />
          <polyline points="172,106 180,112 172,118" fill="none" stroke="var(--c2)" strokeWidth={1.5} />
        </g>
        {/* capacitor tank */}
        <rect x={208} y={Y(v)} width={64} height={96 * v} fill="var(--c1)" opacity={0.7} />
        {inflow > 1e-4 && n < maxSteps && <rect x={208} y={Y(v + inflow)} width={64} height={96 * inflow} fill="var(--c3)" opacity={0.45} stroke="var(--c3)" strokeDasharray="3 2" />}
        <rect x={208} y={Y(1) - 8} width={64} height={104} fill="none" stroke="var(--fg)" strokeWidth={1.5} />
        <line x1={204} y1={Y(1)} x2={276} y2={Y(1)} stroke="var(--faint)" strokeDasharray="4 3" />
        <text x={240} y={140} textAnchor="middle" {...muted}>capacitor (v)</text>
        {/* gap bracket */}
        {gap > 0.01 && (
          <g stroke="var(--c2)" strokeWidth={1.5}>
            <line x1={284} y1={Y(1)} x2={284} y2={Y(v)} />
            <line x1={280} y1={Y(1)} x2={288} y2={Y(1)} />
            <line x1={280} y1={Y(v)} x2={288} y2={Y(v)} />
          </g>
        )}
        <text x={293} y={(Y(1) + Y(v)) / 2 + 4} style={{ fill: "var(--c2)", fontSize: 10.5 }}>gap {gap.toFixed(3)}</text>
      </svg>
      <p style={{ fontSize: 13, margin: "6px 0 10px", textAlign: "center" }}>
        {n >= maxSteps
          ? <>Step {n}: the level is {v.toFixed(3)}. Press Reset to start again.</>
          : rule === "gap"
            ? <>Step {n}: the next step adds {h.toFixed(2)} × {gap.toFixed(3)} = <b style={{ color: "var(--c3)" }}>{inflow.toFixed(3)}</b> (green).</>
            : <>Step {n}: the next step adds a fixed <b style={{ color: "var(--c3)" }}>{inflow.toFixed(3)}</b> (green).</>}
      </p>
      <Stats
        items={[
          { label: "step", value: `${n} / ${maxSteps}` },
          { label: "time t", value: `${t.toFixed(2)} τ` },
          { label: "level v (bucket rule)", value: v.toFixed(3) },
          { label: "exact 1 − e^(−t/τ)", value: (1 - Math.exp(-t)).toFixed(3) },
        ]}
      />
      <div style={{ height: 8 }} />
      <Plot x={[0, 5]} y={[0, 1.08]} height={180} xLabel="t / τ" yLabel="v / Vs">
        <Line points={exact} color="var(--faint)" />
        <Line points={shown} color="var(--c1)" width={1.5} />
        <Dots points={shown} color="var(--c1)" r={2.5} />
        <RuleY at={1} />
        <RuleX at={1} label="τ" />
      </Plot>
      <Legend items={[{ label: "bucket rule, one dot per step", color: "var(--c1)" }, { label: "exact exponential", color: "var(--faint)" }]} />
    </Demo>
  );
}

// ---------------- RC: square-wave input ----------------

const squareSpec = range({ label: "τ / period", min: 0.01, max: 100, default: 0.1, log: true, format: (v) => (v >= 10 ? v.toFixed(0) : v.toPrecision(2)) });

export function RcSquareWaveDemo() {
  const [r, setR] = useState(0.1);
  const pts = useMemo(() => squareWave(r, 3), [r]);
  const st = squareSteady(r);
  const ratio = freqOverCorner(r);
  return (
    <Demo title="A square wave into the RC circuit" controls={<Param spec={squareSpec} value={r} onChange={(x) => setR(x as number)} />}>
      <Stats
        items={[
          { label: "output swing (peak to peak)", value: pct(st.ripple) },
          { label: "output average", value: pct(st.average, 0) },
          { label: "f / f_c", value: ratio.toPrecision(3) },
          { label: "behavior", value: ratio < 0.5 ? "follows the input" : ratio < 5 ? "rounds the edges" : "averages (low-pass)" },
        ]}
      />
      <div style={{ height: 8 }} />
      <Plot x={[0, 3]} y={[-0.05, 1.12]} height={220} xLabel="t / period" yLabel="v / Vs">
        <Line points={pts.map((p) => [p.t, p.vin])} color="var(--faint)" width={1.25} />
        <Line points={pts.map((p) => [p.t, p.vout])} color="var(--c1)" width={2} />
        <RuleY at={0.5} label="average" />
      </Plot>
      <Legend items={[{ label: "input (square wave)", color: "var(--faint)" }, { label: "capacitor voltage", color: "var(--c1)" }]} />
    </Demo>
  );
}

// ---------------- CLT: sum of n dice ----------------

const diceSpecs = {
  die: select({ label: "Die", options: DICE.map((d) => ({ value: d.id, label: d.label })), default: "fair", segmented: true }),
  n: range({ label: "Number of dice n", min: 1, max: 30, step: 1, default: 1 }),
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export function DiceSumDemo() {
  const [dieId, setDie] = useState("fair");
  const [n, setN] = useState(1);
  const die = getDie(dieId);
  const sim = useSim({ dt: 0.7, step: () => setN((x) => (x >= 30 ? x : x + 1)) });
  useEffect(() => { if (n >= 30) sim.pause(); }, [n]); // eslint-disable-line react-hooks/exhaustive-deps

  const { pmf, offset } = useMemo(() => diceSum(die.probs, n), [die, n]);
  const m = pmfMoments(pmf, offset);
  const ks = kolmogorovToNormal(pmf, offset);
  const bound = berryEsseen(die.probs, n);
  // Faces that can occur sit on a lattice of this spacing (5 for a die with only 1 and 6).
  const span = die.probs.reduce((g, p, i) => (p > 0 ? gcd(g, i) : g), 0) || 1;
  const bins = pmf.flatMap((p, k) => (p > 0 ? [{ x0: k + offset - span / 2, x1: k + offset + span / 2, y: p / span }] : []));
  const lo = offset - 0.5, hi = offset + pmf.length - 0.5;
  const curve = Array.from({ length: 161 }, (_, i) => {
    const x = lo + (i / 160) * (hi - lo);
    return [x, normalPdf(x, m.mean, m.sd)] as [number, number];
  });
  const yMax = Math.max(...bins.map((b) => b.y), normalPdf(m.mean, m.mean, m.sd)) * 1.12;

  return (
    <Demo
      title="The exact distribution of a sum of dice"
      actions={
        <>
          <button className="btn" onClick={() => setN((x) => Math.min(30, x + 1))} disabled={n >= 30}>Add a die</button>
          <button className="btn" onClick={() => (n >= 30 ? (setN(1), sim.play()) : sim.toggle())}>{sim.running ? "Pause" : "Play"}</button>
          <button className="btn ghost" onClick={() => { sim.pause(); setN(1); }}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={diceSpecs.n} value={n} onChange={(x) => setN(Math.round(x as number))} />
          <Param spec={diceSpecs.die} value={dieId} onChange={(x) => setDie(x as string)} />
        </>
      }
    >
      <Stats
        items={[
          { label: "dice", value: n },
          { label: "mean of the sum", value: m.mean.toFixed(2) },
          { label: "SD of the sum", value: m.sd.toFixed(2) },
          { label: "skewness", value: Math.abs(m.skew) < 5e-4 ? "0" : m.skew.toFixed(3) },
          { label: "largest CDF gap to the normal", value: ks.toFixed(3) },
          { label: "Berry–Esseen limit", value: bound.toFixed(3) },
        ]}
      />
      <div style={{ height: 8 }} />
      <Plot x={[lo, hi]} y={[0, yMax]} height={220} xLabel="sum of the dice" yFormat={(v) => v.toFixed(2)} ticks={5}>
        <Bars bins={bins} opacity={0.7} />
        <Line points={curve} color="var(--c2)" />
      </Plot>
      <Legend items={[{ label: "exact probability (convolution)", color: "var(--c1)" }, { label: "normal with the same mean and SD", color: "var(--c2)" }]} />
    </Demo>
  );
}

// ---------------- CLT: Galton board ----------------

const galtonSpecs = {
  rows: range({ label: "Rows of pegs", min: 4, max: 16, step: 1, default: 10 }),
  p: range({ label: "Chance to bounce right", min: 0.1, max: 0.9, step: 0.05, default: 0.5, format: (v) => v.toFixed(2) }),
};

interface Ball { bits: boolean[]; t0: number }
const ROW_TIME = 0.12; // seconds for a ball to fall one row
const MAX_BALLS = 3000;

export function GaltonBoardDemo() {
  const [rows, setRows] = useState(10);
  const [p, setP] = useState(0.5);
  const rng = useRef(mulberry32(5));
  const balls = useRef<Ball[]>([]);
  const counts = useRef<number[]>(new Array(11).fill(0));
  const landed = useRef(0);
  const clock = useRef(0);
  const ticks = useRef(0);
  const [, force] = useState(0);

  const clear = () => {
    rng.current = mulberry32(5);
    balls.current = [];
    counts.current = new Array(rows + 1).fill(0);
    landed.current = 0;
    clock.current = 0;
    ticks.current = 0;
  };
  const land = (b: boolean[]) => {
    counts.current[b.filter(Boolean).length]!++;
    landed.current++;
  };
  const sim = useSim({
    dt: 1 / 60,
    autoplay: true,
    step: (dt) => {
      clock.current += dt;
      const t = clock.current;
      // One new ball every 3 ticks until the board has dropped MAX_BALLS.
      if (landed.current + balls.current.length < MAX_BALLS && ticks.current++ % 3 === 0) balls.current.push({ bits: galtonBall(rows, p, rng.current), t0: t });
      const still: Ball[] = [];
      for (const b of balls.current) {
        if (t - b.t0 >= (rows + 1) * ROW_TIME) land(b.bits);
        else still.push(b);
      }
      balls.current = still;
      if (landed.current >= MAX_BALLS) sim.pause();
    },
    reset: clear,
  });
  useEffect(() => { clear(); force((x) => x + 1); }, [rows, p]); // eslint-disable-line react-hooks/exhaustive-deps

  const drop = (k: number) => {
    for (let i = 0; i < k && landed.current < MAX_BALLS; i++) land(galtonBall(rows, p, rng.current));
    force((x) => x + 1);
  };

  const exact = galtonPmf(rows, p);
  const mu = galtonMean(rows, p), sd = galtonSd(rows, p);
  const c = counts.current;
  const total = landed.current;
  const obsMean = total ? c.reduce((s, x, k) => s + x * k, 0) / total : NaN;
  const obsSd = total > 1 ? Math.sqrt(c.reduce((s, x, k) => s + x * (k - obsMean) ** 2, 0) / (total - 1)) : NaN;

  const draw = (ctx: CanvasRenderingContext2D, w: number, H: number) => {
    const fg = cssVar("--fg") || "#16181d", faint = cssVar("--faint") || "#a2a7b0", c1 = cssVar("--c1") || "#2a5bd7", c2 = cssVar("--c2") || "#e07b14";
    const dx = Math.min(36, (w - 16) / (rows + 1));
    const top = 16, rowH = Math.min(16, 150 / rows);
    const cx = w / 2;
    const binTop = top + rows * rowH + 10, binBottom = H - 4;
    const px = (r: number, j: number) => cx + (j - r / 2) * dx;
    // pegs
    ctx.fillStyle = faint;
    for (let r = 0; r < rows; r++) for (let j = 0; j <= r; j++) { ctx.beginPath(); ctx.arc(px(r, j), top + r * rowH, 2, 0, 2 * Math.PI); ctx.fill(); }
    // bins
    const peakExpected = Math.max(...exact) * total;
    const scale = (binBottom - binTop - 6) / Math.max(1, ...c, peakExpected);
    ctx.fillStyle = c1;
    ctx.globalAlpha = 0.75;
    for (let k = 0; k <= rows; k++) {
      const hgt = c[k]! * scale;
      ctx.fillRect(px(rows, k) - dx / 2 + 1, binBottom - hgt, dx - 2, hgt);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = faint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px(rows, 0) - dx / 2, binBottom + 0.5);
    ctx.lineTo(px(rows, rows) + dx / 2, binBottom + 0.5);
    ctx.stroke();
    // normal curve with the same mean and SD, in expected counts per bin
    if (total > 0) {
      ctx.strokeStyle = c2;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 200; i++) {
        const k = -0.5 + (i / 200) * (rows + 1);
        const y = binBottom - normalPdf(k, mu, sd) * total * scale;
        if (i === 0) ctx.moveTo(px(rows, k), y); else ctx.lineTo(px(rows, k), y);
      }
      ctx.stroke();
    }
    // falling balls
    ctx.fillStyle = fg;
    const t = clock.current;
    for (const b of balls.current) {
      const u = (t - b.t0) / ROW_TIME; // rows fallen
      const r = Math.min(rows, Math.floor(u));
      const f = Math.min(1, u - r);
      let right = 0;
      for (let i = 0; i < r; i++) if (b.bits[i]) right++;
      const x0 = px(r, right);
      const x1 = r < rows ? px(r + 1, right + (b.bits[r] ? 1 : 0)) : x0;
      const x = x0 + (x1 - x0) * f;
      const y = top + (r + f) * rowH - 5 - 4 * Math.sin(Math.PI * f);
      ctx.beginPath();
      ctx.arc(x, Math.min(y, binBottom - 4), 3, 0, 2 * Math.PI);
      ctx.fill();
    }
  };

  return (
    <Demo
      title="Galton board"
      actions={
        <>
          <button className="btn" onClick={sim.toggle} disabled={total >= MAX_BALLS}>{sim.running ? "Pause" : "Play"}</button>
          <button className="btn" onClick={() => drop(500)} disabled={total >= MAX_BALLS}>Drop 500</button>
          <button className="btn ghost" onClick={() => { sim.reset(); }}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={galtonSpecs.rows} value={rows} onChange={(x) => setRows(Math.round(x as number))} />
          <Param spec={galtonSpecs.p} value={p} onChange={(x) => setP(x as number)} />
        </>
      }
    >
      <Canvas2D height={(w) => Math.min(380, Math.max(300, w * 0.6))} draw={draw} deps={[clock.current, total, rows, p]} />
      <Stats
        items={[
          { label: "balls landed", value: total.toLocaleString() },
          { label: "mean bin (observed)", value: Number.isFinite(obsMean) ? obsMean.toFixed(2) : "–" },
          { label: "rows × p (theory)", value: mu.toFixed(2) },
          { label: "SD (observed)", value: Number.isFinite(obsSd) ? obsSd.toFixed(2) : "–" },
          { label: "√(rows·p·(1 − p))", value: sd.toFixed(2) },
        ]}
      />
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
        Each peg sends a ball right with the chosen chance. A ball's bin is its number of right bounces, a sum of independent 0/1 steps. Orange: the normal curve with the same mean and SD.
      </p>
    </Demo>
  );
}
