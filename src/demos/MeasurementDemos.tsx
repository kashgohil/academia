import { useEffect, useMemo, useState } from "react";
import { Demo, Stats, Controls, Param, Plot, Dots, Line, RuleY, RuleX, Legend, useParams, select, toggle, range, pct } from "../kit";
import { runBench, summarize, BENCH_DEFAULTS, timings, bootstrapRatio, detectionRate } from "../sims/perf/bench";
import { PROGRAM, flatten, sample, instrument, totalMs, stacks, flameTree } from "../sims/perf/profile";
import { KERNELS, measureKernel } from "../sims/perf/counters";
import { mulberry32 } from "../sims/rng";
import { FlameGraph } from "./FlameGraph";

// ---------------- pitfalls ----------------

const pitSchema = {
  blackBox: toggle({ label: "Keep the result alive (black_box)", default: false }),
  batch: select({ label: "Iterations per timing", options: ["1", "10", "100", "1000"].map((v) => ({ value: v, label: v })), default: "1", segmented: true }),
  timer: select({ label: "Clock resolution", options: [{ value: "1000", label: "1 µs" }, { value: "1", label: "1 ns" }], default: "1000", segmented: true }),
  warmup: toggle({ label: "Discard warm-up samples", default: false }),
  throttle: toggle({ label: "Thermal throttling during the run", default: false }),
};

export function BenchPitfallsDemo() {
  const params = useParams("bp", pitSchema);
  const v = params.values;
  const xs = useMemo(
    () => runBench({ ...BENCH_DEFAULTS, blackBox: v.blackBox, batch: Number(v.batch), timerResNs: Number(v.timer), warmup: v.warmup, throttle: v.throttle }),
    [v.blackBox, v.batch, v.timer, v.warmup, v.throttle],
  );
  const s = summarize(xs);
  const top = Math.max(100, Math.min(s.p90 * 2.2, 2200));
  const offset = v.warmup ? Math.floor(BENCH_DEFAULTS.samples * 0.2) : 0;
  const pts = xs.map((x, i) => [i + offset, Math.min(x, top * 0.99)] as [number, number]);
  return (
    <Demo title="Timing a 40 ns function" controls={<Controls params={params} />}>
      <Stats
        items={[
          { label: "true cost", value: "40 ns" },
          { label: "median", value: `${s.median.toFixed(1)} ns` },
          { label: "mean", value: `${s.mean.toFixed(1)} ns` },
          { label: "min", value: `${s.min.toFixed(1)} ns` },
          { label: "samples", value: xs.length },
        ]}
      />
      <div style={{ height: 8 }} />
      <Plot x={[0, BENCH_DEFAULTS.samples]} y={[0, top]} height={220} xLabel="sample (time →)" yLabel="ns per iteration">
        <RuleY at={40} label="true 40 ns" color="var(--c3)" />
        {offset > 0 && <RuleX at={offset} label="kept from here" />}
        <Dots points={pts} r={2.2} />
      </Plot>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Points above the plot are clipped to its top edge (interrupts, context switches).</p>
    </Demo>
  );
}

// ---------------- comparing versions ----------------

const cmpSchema = {
  speedup: range({ label: "True speedup of B", min: 0, max: 0.1, step: 0.005, default: 0.03, format: (x) => pct(x, 1) }),
  n: range({ label: "Samples per version", min: 5, max: 1000, default: 30, log: true, format: (x) => String(Math.round(x)) }),
};

export function BenchCompareDemo() {
  const params = useParams("bc", cmpSchema);
  const speedup = params.values.speedup;
  const n = Math.round(params.values.n);
  const [seed, setSeed] = useState(1);
  const exp = useMemo(() => {
    const r = mulberry32(seed);
    const a = timings(100, n, r), b = timings(100 * (1 - speedup), n, r);
    return { a, b, ci: bootstrapRatio(a, b, r) };
  }, [n, speedup, seed]);
  const [curve, setCurve] = useState<[number, number][] | null>(null);
  useEffect(() => {
    setCurve(null);
    const t = setTimeout(() => setCurve([10, 30, 100, 300, 1000].map((k) => [k, detectionRate(speedup, k, 60, 7)] as [number, number])), 50);
    return () => clearTimeout(t);
  }, [speedup]);

  const strip = (xs: number[], y: number) => xs.map((x, i) => [Math.min(x, 200), y + ((i * 0.6180339) % 1 - 0.5) * 0.5] as [number, number]);
  const [lo, mid, hi] = exp.ci;
  const verdict = hi < 1 ? "B is faster (95% CI below 1)" : lo > 1 ? "B is slower" : "can't tell: the CI includes 1";
  return (
    <Demo title="Is B really faster than A?" actions={<button className="btn" onClick={() => setSeed((x) => x + 1)}>Run a new experiment</button>} controls={<Controls params={params} />}>
      <Plot x={[80, 200]} y={[0, 3]} height={140} yTicks={[1, 2]} yFormat={(t) => (t === 1 ? "B" : t === 2 ? "A" : "")} xLabel="ns per call" grid={false}>
        <Dots points={strip(exp.a, 2)} color="var(--c4)" r={2} />
        <Dots points={strip(exp.b, 1)} color="var(--c1)" r={2} />
      </Plot>
      <Stats items={[{ label: "median B / median A", value: mid.toFixed(3) }, { label: "95% bootstrap CI", value: `${lo.toFixed(3)} – ${hi.toFixed(3)}` }, { label: "verdict", value: <span style={{ fontSize: 14 }}>{verdict}</span> }]} />
      <div className="muted" style={{ fontSize: 12.5, margin: "16px 0 4px" }}>How often 60 repeated experiments conclude "B is faster", by sample size</div>
      {curve ? (
        <Plot x={[10, 1000]} y={[0, 1]} logX height={170} xTicks={[10, 30, 100, 300, 1000]} xFormat={String} yFormat={(t) => pct(t, 0)} xLabel="samples per version">
          <RuleY at={0.05} label="5%" />
          <Line points={curve} color="var(--c3)" width={1.75} />
          <Dots points={curve} color="var(--c3)" r={3} />
          <RuleX at={n} />
        </Plot>
      ) : (
        <div className="muted" style={{ height: 170, fontSize: 12.5 }}>simulating…</div>
      )}
    </Demo>
  );
}

// ---------------- profilers ----------------

const profSchema = {
  hz: select({ label: "Sampling rate", options: [{ value: "100", label: "100 Hz" }, { value: "1000", label: "1 kHz" }, { value: "10000", label: "10 kHz" }], default: "1000", segmented: true }),
  overhead: select({ label: "Instrumentation cost per call", options: ["30", "100", "300"].map((v) => ({ value: v, label: `${v} ns` })), default: "100", segmented: true }),
};

export function ProfilerDemo() {
  const params = useParams("prof", profSchema);
  const hz = Number(params.values.hz), oh = Number(params.values.overhead);
  const [seed, setSeed] = useState(1);
  const flat = flatten(PROGRAM).filter((x) => x.selfMs >= 6);
  const total = totalMs(PROGRAM);
  const s = useMemo(() => sample(PROGRAM, hz, seed), [hz, seed]);
  const ins = useMemo(() => instrument(PROGRAM, oh), [oh]);
  const max = 0.32;
  const bar = (v: number, color: string) => <div style={{ height: 7, width: `${(100 * v) / max}%`, background: color, borderRadius: 2 }} />;
  return (
    <Demo title={`Where does the time go? (${total} ms of work, ${s.n} samples)`} actions={<button className="btn" onClick={() => setSeed((x) => x + 1)}>Resample</button>} controls={<Controls params={params} />}>
      <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 150px", gap: "6px 12px", alignItems: "center", fontSize: 12.5 }}>
        <span className="muted">function</span><span /><span className="muted">true · sampled · instrumented</span>
        {flat.map((x) => {
          const t = x.selfMs / total, sp = s.share(x.name), ip = ins.share(x.name);
          const ci = 1.96 * Math.sqrt((sp * (1 - sp)) / s.n);
          return (
            <div key={x.name} style={{ display: "contents" }}>
              <code style={{ fontSize: 12 }}>{x.name}</code>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {bar(t, "var(--faint)")}
                {bar(sp, "var(--c1)")}
                {bar(ip, "var(--c2)")}
              </div>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{pct(t, 0)} · {pct(sp, 0)}<span className="muted">±{(ci * 100).toFixed(0)}</span> · {pct(ip, 0)}</span>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10 }}>
        <Legend box items={[{ label: "true self time", color: "var(--faint)" }, { label: "sampling profiler", color: "var(--c1)" }, { label: "instrumenting profiler", color: "var(--c2)" }]} />
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Instrumented run: {ins.totalMs.toFixed(0)} ms instead of {total} ms. Call counts: hash_key 600,000, alloc_string 140,000, socket_read 6,000.</p>
    </Demo>
  );
}

export function FlameGraphDemo() {
  const [q, setQ] = useState("");
  const root = useMemo(() => flameTree(stacks(PROGRAM)), []);
  return (
    <Demo title="Flame graph of the request handler" controls={<label className="param"><span className="param-label">Highlight frames containing</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. alloc" style={{ font: "inherit", padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--fg)" }} /></label>}>
      <FlameGraph root={root} highlight={q} />
    </Demo>
  );
}

// ---------------- counters ----------------

const TD = [
  { k: "retiring", label: "retiring (useful work)", color: "var(--c3)" },
  { k: "badSpeculation", label: "bad speculation", color: "var(--c4)" },
  { k: "frontend", label: "frontend bound", color: "var(--c5)" },
  { k: "backendMemory", label: "backend: memory", color: "var(--c2)" },
  { k: "backendCore", label: "backend: core", color: "var(--c1)" },
] as const;

export function CountersDemo() {
  const [id, setId] = useState("branch-random");
  const all = useMemo(() => KERNELS.map((k) => ({ k, c: measureKernel(k.id) })), []);
  const cur = all.find((x) => x.k.id === id)!;
  const c = cur.c;
  return (
    <Demo title="perf stat for five loops (100,000 iterations each)" controls={<Param spec={select({ label: "Kernel", options: KERNELS.map((k) => ({ value: k.id, label: k.label })), default: "branch-random" })} value={id} onChange={(v) => setId(v as string)} />}>
      <code style={{ fontSize: 12.5 }}>{cur.k.code}</code>
      <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 10px" }}>{cur.k.note}</p>
      <Stats
        items={[
          { label: "instructions", value: c.instructions.toLocaleString() },
          { label: "cycles", value: Math.round(c.cycles).toLocaleString() },
          { label: "IPC", value: c.ipc.toFixed(2) },
          { label: "branch misses", value: pct(c.mispredicts / c.branches, 1) },
          { label: "LLC misses", value: Math.round(c.llcMisses).toLocaleString() },
        ]}
      />
      <div className="muted" style={{ fontSize: 12.5, margin: "16px 0 6px" }}>Top-down: where the pipeline slots went</div>
      <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 70px", gap: "6px 10px", alignItems: "center", fontSize: 12.5 }}>
        {all.map(({ k, c: x }) => (
          <div key={k.id} style={{ display: "contents" }}>
            <span style={{ fontWeight: k.id === id ? 600 : 400 }}>{k.label}</span>
            <div style={{ display: "flex", height: 12, borderRadius: 2, overflow: "hidden", outline: k.id === id ? "1.5px solid var(--fg)" : undefined }}>
              {TD.map((t) => <div key={t.k} title={`${t.label}: ${pct(x.topdown[t.k], 0)}`} style={{ width: `${100 * x.topdown[t.k]}%`, background: t.color }} />)}
            </div>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>IPC {x.ipc.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Legend box items={TD.map((t) => ({ label: t.label, color: t.color }))} />
      </div>
    </Demo>
  );
}

