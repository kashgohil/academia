import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, select, range, useSim, useWidth } from "../kit";
import { mulberry32 } from "../sims/rng";

// ---------------- 2-bit counter stepper ----------------

const STATES = ["strongly not taken", "weakly not taken", "weakly taken", "strongly taken"];

export function TwoBitStepperDemo() {
  const [pattern, setPattern] = useState("loop8");
  const outcomes = useMemo(() => {
    const r = mulberry32(3);
    return Array.from({ length: 64 }, (_, i) =>
      pattern === "loop8" ? i % 8 !== 7 : pattern === "alternate" ? i % 2 === 0 : pattern === "random" ? r() < 0.5 : r() < 0.95,
    );
  }, [pattern]);
  const step = useRef(0);
  const [, force] = useState(0);
  const sim = useSim({ dt: 1 / 2.5, autoplay: true, step: () => { step.current = (step.current + 1) % outcomes.length; force((x) => x + 1); }, reset: () => { step.current = 0; } });
  // Replay the counter up to the current step.
  let state = 2;
  const history: { taken: boolean; hit: boolean }[] = [];
  for (let i = 0; i <= step.current; i++) {
    const predict = state >= 2, taken = outcomes[i]!;
    history.push({ taken, hit: predict === taken });
    if (i < step.current) state = taken ? Math.min(3, state + 1) : Math.max(0, state - 1);
  }
  const misses = history.slice(0, -1).filter((h) => !h.hit).length;
  const cur = history.at(-1)!;
  const xs = [60, 190, 320, 450];
  return (
    <Demo
      title="A 2-bit counter, one branch at a time"
      actions={<><button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn" onClick={() => { step.current = (step.current + 1) % outcomes.length; force((x) => x + 1); }} disabled={sim.running}>Step</button><button className="btn ghost" onClick={sim.reset}>Reset</button></>}
      controls={<Param spec={select({ label: "Branch pattern", options: [{ value: "loop8", label: "Loop of 8" }, { value: "alternate", label: "Alternating" }, { value: "biased", label: "95% taken" }, { value: "random", label: "Random" }], default: "loop8", segmented: true })} value={pattern} onChange={(v) => { setPattern(v as string); sim.reset(); }} />}
    >
      <svg viewBox="0 0 520 120" style={{ width: "100%", maxWidth: 560, display: "block", margin: "0 auto" }}>
        {xs.map((x, i) => (
          <g key={i}>
            <circle cx={x} cy={52} r={30} fill={i === state ? (i >= 2 ? "var(--c3)" : "var(--c2)") : "var(--bg)"} stroke={i >= 2 ? "var(--c3)" : "var(--c2)"} strokeWidth={2} opacity={i === state ? 0.9 : 1} />
            <text x={x} y={49} textAnchor="middle" fontSize={11} fontWeight={600} fill={i === state ? "#fff" : "var(--fg)"}>{i >= 2 ? "predict T" : "predict N"}</text>
            <text x={x} y={63} textAnchor="middle" fontSize={9.5} fill={i === state ? "#fff" : "var(--muted)"}>{i}</text>
            <text x={x} y={104} textAnchor="middle" fontSize={10} fill="var(--muted)">{STATES[i]}</text>
            {i < 3 && <text x={x + 65} y={26} textAnchor="middle" fontSize={9.5} fill="var(--muted)">taken →</text>}
            {i < 3 && <text x={x + 65} y={84} textAnchor="middle" fontSize={9.5} fill="var(--muted)">← not taken</text>}
          </g>
        ))}
      </svg>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", margin: "10px 0" }}>
        {history.slice(-32).map((h, i, arr) => (
          <div key={i} title={h.hit ? "predicted correctly" : "mispredicted"} style={{ width: 18, height: 24, borderRadius: 3, display: "grid", placeItems: "center", fontSize: 11, color: "#fff", background: h.hit ? "var(--c3)" : "var(--c4)", outline: i === arr.length - 1 ? "2px solid var(--fg)" : undefined }}>{h.taken ? "T" : "N"}</div>
        ))}
      </div>
      <Stats items={[{ label: "this branch", value: cur.taken ? "taken" : "not taken" }, { label: "prediction", value: cur.hit ? "correct" : "wrong" }, { label: "mispredictions so far", value: `${misses} of ${step.current}` }]} />
    </Demo>
  );
}

// ---------------- dependency graph ----------------

export function DependencyGraphDemo() {
  const [k, setK] = useState(1);
  const N = 16, LAT = 4;
  const [ref, w] = useWidth<HTMLDivElement>();
  // Adds per chain, then a combine tree.
  const perChain = Math.ceil(N / k);
  const combineDepth = Math.ceil(Math.log2(k));
  const critical = (perChain + combineDepth) * LAT;
  const cols = perChain + combineDepth;
  const cw = (w - 20) / Math.max(cols, 6), rh = Math.min(26, 180 / k);
  const height = Math.max(k * rh + 30, 90);
  return (
    <Demo title="Sum of 16 numbers: the dependency graph" controls={<Param spec={select({ label: "Accumulators", options: ["1", "2", "4", "8"].map((v) => ({ value: v, label: v })), default: "1", segmented: true })} value={String(k)} onChange={(v) => setK(Number(v))} />}>
      <div ref={ref}>
        <svg width={w} height={height} style={{ display: "block" }}>
          {Array.from({ length: k }, (_, c) => Array.from({ length: perChain }, (_, s) => {
            const x = 10 + s * cw + cw / 2, y = 15 + c * rh + rh / 2;
            return (
              <g key={`${c}-${s}`}>
                {s > 0 && <line x1={x - cw + 9} y1={y} x2={x - 9} y2={y} stroke="var(--c4)" strokeWidth={1.5} />}
                <circle cx={x} cy={y} r={Math.min(8, rh / 2.4)} fill="var(--c1)" />
              </g>
            );
          }))}
          {Array.from({ length: combineDepth }, (_, d) => {
            const x = 10 + (perChain + d) * cw + cw / 2;
            const n = Math.ceil(k / 2 ** (d + 1));
            return Array.from({ length: n }, (_, j) => <circle key={`c${d}-${j}`} cx={x} cy={15 + (j + 0.5) * (k * rh) / n} r={6} fill="var(--c2)" />);
          })}
          <text x={10} y={height - 4} fontSize={10.5} fill="var(--muted)">left to right: order of dependence · red lines: each add waits for the one before it</text>
        </svg>
      </div>
      <Stats items={[{ label: "longest chain (adds)", value: perChain + combineDepth }, { label: "time of the longest chain", value: `${critical} cycles` }, { label: "speedup vs one accumulator", value: `${((N * LAT) / critical).toFixed(1)}×` }]} />
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Each add takes 4 cycles. Blue: adds into one accumulator. Orange: adds that combine the accumulators at the end. The core can run adds from different chains at the same time.</p>
    </Demo>
  );
}

// ---------------- scalar vs SIMD race ----------------

export function LaneRaceDemo() {
  const [lanes, setLanes] = useState(8);
  const N = 32;
  const t = useRef(0);
  const [, force] = useState(0);
  const sim = useSim({ dt: 1 / 3, autoplay: true, step: () => { t.current = t.current >= N + 6 ? 0 : t.current + 1; force((x) => x + 1); }, reset: () => { t.current = 0; } });
  const scalarDone = Math.min(N, t.current);
  const simdDone = Math.min(N, t.current * lanes);
  const row = (done: number, color: string) => (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${N}, 1fr)`, gap: 2 }}>
      {Array.from({ length: N }, (_, i) => <div key={i} style={{ height: 18, borderRadius: 2, background: i < done ? color : "var(--subtle)", border: "1px solid var(--border)", transition: "background 0.2s" }} />)}
    </div>
  );
  // Reduction tree for the SIMD lanes.
  const levels: number[] = [];
  for (let n = lanes; n >= 1; n /= 2) levels.push(n);
  return (
    <Demo
      title="Add 32 pairs of numbers: one at a time, or a vector at a time"
      actions={<><button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn ghost" onClick={sim.reset}>Restart</button></>}
      controls={<Param spec={select({ label: "Vector lanes", options: ["4", "8", "16"].map((v) => ({ value: v, label: v })), default: "8", segmented: true })} value={String(lanes)} onChange={(v) => { setLanes(Number(v)); sim.reset(); }} />}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>Scalar: one add per step ({scalarDone}/{N})</div>
      {row(scalarDone, "var(--c2)")}
      <div className="muted" style={{ fontSize: 12.5, margin: "12px 0 4px" }}>SIMD: {lanes} adds per step ({simdDone}/{N})</div>
      {row(simdDone, "var(--c1)")}
      <div className="muted" style={{ fontSize: 12.5, margin: "16px 0 6px" }}>To sum the lanes of one vector at the end: {Math.log2(lanes)} steps</div>
      <div style={{ display: "grid", gap: 4 }}>
        {levels.map((n, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: `repeat(${lanes}, 1fr)`, gap: 3 }}>
            {Array.from({ length: lanes }, (_, j) => <div key={j} style={{ height: 12, borderRadius: 2, background: j < n ? "var(--c3)" : "transparent", opacity: 0.4 + 0.6 * (i / Math.max(1, levels.length - 1)) }} />)}
          </div>
        ))}
      </div>
      <Stats items={[{ label: "steps, scalar", value: N }, { label: "steps, SIMD (plus the final sum)", value: `${N / lanes} + ${Math.log2(lanes)}` }]} />
    </Demo>
  );
}

// ---------------- loop dependencies ----------------

const LOOPS = {
  independent: { label: "c[i] = a[i] + b[i]", deps: (_i: number) => [] as number[] },
  recurrence: { label: "a[i] = a[i-1] * k", deps: (i: number) => (i > 0 ? [i - 1] : []) },
  overlap: { label: "a[i+2] = a[i] + 1  (arrays overlap)", deps: (i: number) => (i >= 2 ? [i - 2] : []) },
  far: { label: "a[i+8] = a[i] + 1", deps: (i: number) => (i >= 8 ? [i - 8] : []) },
} as const;

export function LoopDependencyDemo() {
  const [which, setWhich] = useState<keyof typeof LOOPS>("independent");
  const [lanes, setLanes] = useState(4);
  const N = 16;
  const [ref, w] = useWidth<HTMLDivElement>();
  const cw = (w - 20) / N;
  const x = (i: number) => 10 + i * cw + cw / 2;
  const deps = Array.from({ length: N }, (_, i) => LOOPS[which].deps(i).map((d) => [d, i] as const)).flat();
  const conflict = deps.filter(([d, i]) => Math.floor(d / lanes) === Math.floor(i / lanes));
  const ok = conflict.length === 0;
  return (
    <Demo
      title="Can these iterations run in the same vector?"
      controls={
        <>
          <Param spec={select({ label: "Loop body", options: Object.entries(LOOPS).map(([k, v]) => ({ value: k, label: v.label })), default: "independent" })} value={which} onChange={(v) => setWhich(v as keyof typeof LOOPS)} />
          <Param spec={range({ label: "Vector lanes", min: 2, max: 8, step: 2, default: 4 })} value={lanes} onChange={(v) => setLanes(v as number)} />
        </>
      }
    >
      <div ref={ref}>
        <svg width={w} height={120} style={{ display: "block" }}>
          {Array.from({ length: N / lanes }, (_, g) => <rect key={g} x={10 + g * lanes * cw + 2} y={50} width={lanes * cw - 4} height={40} rx={6} fill="var(--subtle)" stroke="var(--border)" />)}
          {deps.map(([d, i], n) => {
            const bad = Math.floor(d / lanes) === Math.floor(i / lanes);
            return <path key={n} d={`M${x(d)} 58 Q ${(x(d) + x(i)) / 2} ${10 - (i - d) * 1.5} ${x(i)} 58`} fill="none" stroke={bad ? "var(--c4)" : "var(--faint)"} strokeWidth={bad ? 1.75 : 1.25} />;
          })}
          {Array.from({ length: N }, (_, i) => (
            <g key={i}>
              <circle cx={x(i)} cy={70} r={Math.min(10, cw / 2.6)} fill="var(--c1)" />
              <text x={x(i)} y={74} textAnchor="middle" fontSize={10} fill="#fff">{i}</text>
            </g>
          ))}
          <text x={10} y={112} fontSize={10.5} fill="var(--muted)">boxes: iterations that one vector instruction runs together · arcs: iteration j needs the result of iteration i</text>
        </svg>
      </div>
      <p style={{ fontSize: 13.5, marginBottom: 0, color: ok ? "var(--c3)" : "var(--c4)" }}>
        {ok ? (deps.length ? "Safe: every dependency goes from one vector group to a later group." : "Safe: the iterations are independent.") : `Not safe: ${conflict.length} dependencies (red) are inside one vector group. Those lanes would read values that are not written yet.`}
      </p>
    </Demo>
  );
}
