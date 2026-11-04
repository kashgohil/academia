import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, Plot, Dots, Bars, RuleX, RuleY, Legend, select, range, toggle, useSim, useWidth, pct } from "../kit";
import { mulberry32, normal } from "../sims/rng";
import { histogram } from "../sims/stats";
import { PROGRAM, stacks, flameTree, totalMs } from "../sims/perf/profile";
import { KERNELS, measureKernel } from "../sims/perf/counters";
import { FlameGraph } from "./FlameGraph";

const TC = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c4)"];

// ---------------- clock quantization ----------------

export function QuantizationDemo() {
  const [dur, setDur] = useState(300);
  const [res, setRes] = useState("1000");
  const [batch, setBatch] = useState("1");
  const tick = Number(res), b = Number(batch);
  const readings = useMemo(() => {
    const r = mulberry32(4);
    return Array.from({ length: 40 }, () => { const phase = r() * tick; return (Math.floor((phase + dur * b) / tick) * tick) / b; });
  }, [dur, tick, b]);
  const [ref, w] = useWidth<HTMLDivElement>();
  const span = Math.max(dur * b, tick) * 3.2;
  const px = (w - 20) / span;
  const start = tick * 0.6;
  return (
    <Demo
      title="What a coarse clock sees"
      controls={
        <>
          <Param spec={range({ label: "True time of the code", min: 10, max: 5000, default: 300, log: true, format: (v) => `${Math.round(v)} ns` })} value={dur} onChange={(v) => setDur(v as number)} />
          <Param spec={select({ label: "Clock tick", options: [{ value: "1", label: "1 ns" }, { value: "100", label: "100 ns" }, { value: "1000", label: "1 µs" }], default: "1000", segmented: true })} value={res} onChange={(v) => setRes(v as string)} />
          <Param spec={select({ label: "Runs per measurement", options: ["1", "100", "10000"].map((v) => ({ value: v, label: v })), default: "1", segmented: true })} value={batch} onChange={(v) => setBatch(v as string)} />
        </>
      }
    >
      <div ref={ref}>
        <svg width={w} height={60} style={{ display: "block" }}>
          {Array.from({ length: Math.floor(span / tick) + 1 }, (_, i) => i * tick).filter((t) => t * px < w - 10).slice(0, 400).map((t) => <line key={t} x1={10 + t * px} x2={10 + t * px} y1={8} y2={52} stroke="var(--border)" />)}
          <rect x={10 + start * px} y={20} width={Math.max(1, dur * b * px)} height={20} rx={3} fill="var(--c1)" opacity={0.8} />
          <text x={10} y={58} fontSize={10} fill="var(--muted)">grey lines: clock ticks · blue bar: the code that runs</text>
        </svg>
      </div>
      <Stats items={[{ label: "true time per run", value: `${Math.round(dur)} ns` }, { label: "median reading", value: `${[...readings].sort((x, y) => x - y)[20]!.toFixed(1)} ns` }, { label: "readings that show 0", value: pct(readings.filter((x) => x === 0).length / readings.length, 0) }]} />
      <div style={{ height: 6 }} />
      <Plot x={[0, 40]} y={[0, Math.max(...readings, dur) * 1.2]} height={140} yLabel="reading (ns)" xLabel="measurement">
        <RuleY at={dur} label="true" color="var(--c3)" />
        <Dots points={readings.map((r, i) => [i + 0.5, r])} r={3} />
      </Plot>
    </Demo>
  );
}

// ---------------- mean vs median ----------------

export function MeanMedianDemo() {
  const [frac, setFrac] = useState(0.03);
  const [size, setSize] = useState(10);
  const xs = useMemo(() => { const r = mulberry32(9); return Array.from({ length: 400 }, () => 100 * Math.exp(0.05 * normal(r)) * (r() < frac ? size : 1)); }, [frac, size]);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const median = [...xs].sort((a, b) => a - b)[200]!;
  const bins = histogram(xs.map((x) => Math.min(x, 299)), 60, 300, 48).map((b) => ({ x0: b.x0, x1: b.x1, y: b.count }));
  return (
    <Demo
      title="400 timings of the same code"
      controls={
        <>
          <Param spec={range({ label: "Share of timings hit by an interrupt", min: 0, max: 0.2, step: 0.01, default: 0.03, format: (v) => pct(v, 0) })} value={frac} onChange={(v) => setFrac(v as number)} />
          <Param spec={range({ label: "How much slower those timings are", min: 2, max: 50, step: 1, default: 10, format: (v) => `${v}×` })} value={size} onChange={(v) => setSize(v as number)} />
        </>
      }
    >
      <Stats items={[{ label: "true time", value: "100 ns" }, { label: "median", value: `${median.toFixed(1)} ns` }, { label: "mean", value: `${mean.toFixed(1)} ns` }]} />
      <div style={{ height: 6 }} />
      <Plot x={[60, 300]} y={[0, Math.max(...bins.map((b) => b.y)) * 1.1]} height={180} xLabel="ns (slower timings are drawn at the right edge)">
        <Bars bins={bins} color="var(--faint)" />
        <RuleX at={median} label="median" color="var(--c3)" />
        <RuleX at={Math.min(mean, 298)} label="mean" color="var(--c4)" />
      </Plot>
    </Demo>
  );
}

// ---------------- sampling animation ----------------

const FUNCS = (() => {
  const total = totalMs(PROGRAM);
  const flat = new Map<string, number>();
  for (const s of stacks(PROGRAM)) flat.set(s.stack.at(-1)!, (flat.get(s.stack.at(-1)!) ?? 0) + s.ms);
  return [...flat].sort((a, b) => b[1] - a[1]).map(([name, ms]) => ({ name, share: ms / total }));
})();

export function SamplingAnimationDemo() {
  const [hz, setHz] = useState(4);
  const counts = useRef(new Map<string, number>());
  const t = useRef(0);
  const nextSample = useRef(0);
  const [, force] = useState(0);
  const r = useRef(mulberry32(3));
  // The program's timeline: a repeating sequence of function segments in random order, sized by share.
  const timeline = useMemo(() => {
    const rr = mulberry32(8);
    const segs: { name: string; len: number; color: string }[] = [];
    for (let rep = 0; rep < 6; rep++)
      for (const f of [...FUNCS].sort(() => rr() - 0.5)) segs.push({ name: f.name, len: f.share * 100, color: TC[FUNCS.indexOf(f) % 5]! });
    return segs;
  }, []);
  const total = timeline.reduce((s, x) => s + x.len, 0);
  const at = (pos: number) => { let p = pos % total; for (const s of timeline) { if (p < s.len) return s; p -= s.len; } return timeline[0]!; };
  const sim = useSim({
    dt: 1 / 60,
    autoplay: true,
    step: (dt) => {
      t.current += dt * 40;
      if (t.current >= nextSample.current) {
        const s = at(t.current);
        counts.current.set(s.name, (counts.current.get(s.name) ?? 0) + 1);
        nextSample.current = t.current + (40 / hz) * (0.8 + 0.4 * r.current());
      }
      force((x) => x + 1);
    },
    reset: () => { counts.current = new Map(); t.current = 0; nextSample.current = 0; },
  });
  const n = [...counts.current.values()].reduce((a, b) => a + b, 0);
  const [ref, w] = useWidth<HTMLDivElement>();
  const view = 100, offset = t.current - view * 0.7;
  const px = w / view;
  const segs: { x: number; w: number; color: string; name: string }[] = [];
  { let pos = Math.floor(offset / total) * total; for (let k = 0; k < 3; k++) for (const s of timeline) { if (pos + s.len > offset && pos < offset + view) segs.push({ x: (pos - offset) * px, w: s.len * px, color: s.color, name: s.name }); pos += s.len; } }
  return (
    <Demo
      title="A sampling profiler, slowed down"
      actions={<><button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn ghost" onClick={sim.reset}>Reset</button></>}
      controls={<Param spec={range({ label: "Samples per time unit", min: 1, max: 20, step: 1, default: 4 })} value={hz} onChange={(v) => setHz(v as number)} />}
    >
      <div ref={ref}>
        <svg width={w} height={56} style={{ display: "block" }}>
          {segs.map((s, i) => <rect key={i} x={s.x} y={14} width={Math.max(0, s.w - 1)} height={24} fill={s.color} opacity={0.75} />)}
          <line x1={view * 0.7 * px} x2={view * 0.7 * px} y1={4} y2={48} stroke="var(--fg)" strokeWidth={2} />
          <text x={view * 0.7 * px + 6} y={10} fontSize={10.5} fill="var(--fg)">now: {at(t.current).name}</text>
          <text x={0} y={52} fontSize={10} fill="var(--muted)">the program runs left to right; each color is a function</text>
        </svg>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 100px", gap: "4px 10px", alignItems: "center", fontSize: 12.5, marginTop: 8 }}>
        {FUNCS.slice(0, 8).map((f, i) => {
          const c = counts.current.get(f.name) ?? 0;
          return (
            <div key={f.name} style={{ display: "contents" }}>
              <code style={{ fontSize: 11.5 }}>{f.name}</code>
              <div style={{ position: "relative", height: 10, background: "var(--subtle)", borderRadius: 2 }}>
                <div style={{ height: "100%", width: `${n ? (100 * c) / n / 0.3 : 0}%`, maxWidth: "100%", background: TC[i % 5], borderRadius: 2 }} />
                <div style={{ position: "absolute", left: `${(100 * f.share) / 0.3}%`, top: -2, height: 14, width: 2, background: "var(--fg)" }} />
              </div>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{n ? pct(c / n, 0) : "–"} <span className="muted">/ {pct(f.share, 0)}</span></span>
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{n} samples. Bars: share of samples. Black marks and grey numbers: true share of time. More samples make the bars closer to the marks.</p>
    </Demo>
  );
}

// ---------------- stacks to flame graph ----------------

const STACKS = stacks(PROGRAM);
const STACK_TOTAL = STACKS.reduce((s, x) => s + x.ms, 0);

export function StacksToFlameDemo() {
  const [samples, setSamples] = useState<string[][]>([]);
  const r = useRef(mulberry32(5));
  const add = (k: number) => setSamples((s) => {
    const out = [...s];
    for (let i = 0; i < k; i++) { let u = r.current() * STACK_TOTAL; const st = STACKS.find((x) => (u -= x.ms) < 0) ?? STACKS[0]!; out.push(st.stack); }
    return out;
  });
  const tree = useMemo(() => flameTree(samples.map((stack) => ({ stack, ms: 1 }))), [samples]);
  return (
    <Demo
      title="From stack samples to a flame graph"
      actions={<><button className="btn" onClick={() => add(1)}>Take 1 sample</button><button className="btn" onClick={() => add(25)}>Take 25</button><button className="btn" onClick={() => add(500)}>Take 500</button><button className="btn ghost" onClick={() => { setSamples([]); r.current = mulberry32(5); }}>Reset</button></>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>Last samples (root first):</div>
      <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11.5, minHeight: 60, marginBottom: 10 }}>
        {samples.slice(-3).reverse().map((s, i) => <div key={i} style={{ opacity: 1 - i * 0.3 }}>{s.join(" → ")}</div>)}
        {!samples.length && <span className="muted">No samples yet. Take one.</span>}
      </div>
      {samples.length > 0 ? <FlameGraph root={tree} unit="samples" /> : <div className="empty" style={{ padding: 16, fontSize: 13 }}>The flame graph appears here. Each sample adds 1 to the width of every frame on its stack.</div>}
    </Demo>
  );
}

// ---------------- pipeline slots ----------------

const CATS = [
  { k: "retiring", label: "retiring (useful work)", color: "var(--c3)" },
  { k: "badSpeculation", label: "bad speculation", color: "var(--c4)" },
  { k: "frontend", label: "frontend bound", color: "var(--c5)" },
  { k: "backendMemory", label: "backend: memory", color: "var(--c2)" },
  { k: "backendCore", label: "backend: core", color: "var(--c1)" },
] as const;

export function PipelineSlotsDemo() {
  const [id, setId] = useState("branch-random");
  const td = measureKernel(id).topdown;
  // Illustration: 4 slots × 60 cycles, filled in runs whose lengths match each category's typical stall.
  const cells = useMemo(() => {
    // Deterministic fill: always extend the category that is furthest below its target share,
    // in runs as long as that category's typical stall. Runs interleave as they do in real execution.
    const RUN = { retiring: 2, badSpeculation: 16, frontend: 2, backendMemory: 60, backendCore: 3 } as const;
    const emitted: Record<string, number> = {};
    const cols: string[] = [];
    while (cols.length < 60) {
      let best: (typeof CATS)[number]["k"] = "retiring", gap = -Infinity;
      for (const c of CATS) {
        const g = td[c.k] * (cols.length + 1) - (emitted[c.k] ?? 0);
        if (td[c.k] > 0.005 && g > gap) { gap = g; best = c.k; }
      }
      for (let i = 0; i < RUN[best] && cols.length < 60; i++) { cols.push(best); emitted[best] = (emitted[best] ?? 0) + 1; }
    }
    return cols;
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const color = (k: string) => CATS.find((c) => c.k === k)!.color;
  return (
    <Demo title="Pipeline slots: 4 per cycle, 60 cycles" controls={<Param spec={select({ label: "Loop", options: KERNELS.map((k) => ({ value: k.id, label: k.label })), default: "branch-random" })} value={id} onChange={(v) => setId(v as string)} />}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(60, 1fr)", gridTemplateRows: "repeat(4, 12px)", gap: 1, gridAutoFlow: "column" }}>
        {cells.flatMap((c, i) => [0, 1, 2, 3].map((s) => <div key={`${i}-${s}`} style={{ background: color(c), opacity: c === "retiring" && s > 2 ? 0.55 : 0.9, borderRadius: 1 }} />))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Legend box items={CATS.map((c) => ({ label: `${c.label}: ${pct(td[c.k], 0)}`, color: c.color }))} />
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Each column is one cycle; each row is one of 4 issue slots. The colors follow the measured fractions. Stalls come in runs: a mispredict wastes about 16 cycles, a DRAM miss hundreds.</p>
    </Demo>
  );
}

// ---------------- pointer walk ----------------

export function PointerWalkDemo() {
  const [shuffled, setShuffled] = useState(true);
  const NODES = 32, PER_LINE = 4, CAP = 3;
  const order = useMemo(() => { const a = Array.from({ length: NODES }, (_, i) => i); if (shuffled) { const r = mulberry32(6); for (let i = NODES - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } } return a; }, [shuffled]);
  const step = useRef(0);
  const cache = useRef<number[]>([]);
  const misses = useRef(0);
  const [, force] = useState(0);
  const sim = useSim({
    dt: 1 / 3,
    autoplay: true,
    step: () => {
      const node = order[step.current % NODES]!;
      const line = Math.floor(node / PER_LINE);
      const at = cache.current.indexOf(line);
      if (at >= 0) cache.current.splice(at, 1); else { misses.current++; if (cache.current.length >= CAP) cache.current.shift(); }
      cache.current.push(line);
      step.current++;
      if (step.current % NODES === 0) { /* next lap continues with a warm cache */ }
      force((x) => x + 1);
    },
    reset: () => { step.current = 0; cache.current = []; misses.current = 0; },
  });
  const cur = order[(step.current - 1 + NODES) % NODES]!;
  const prev = order[(step.current - 2 + NODES) % NODES]!;
  const [ref, w] = useWidth<HTMLDivElement>();
  const cw = (w - 10) / NODES;
  const x = (n: number) => 5 + n * cw + cw / 2;
  return (
    <Demo
      title="Walking a linked list through memory"
      actions={<><button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn ghost" onClick={sim.reset}>Reset</button></>}
      controls={<Param spec={toggle({ label: "Nodes scattered in memory", default: true })} value={shuffled} onChange={(v) => { setShuffled(v as boolean); sim.reset(); }} />}
    >
      <div ref={ref}>
        <svg width={w} height={110} style={{ display: "block" }}>
          {Array.from({ length: NODES / PER_LINE }, (_, l) => (
            <rect key={l} x={5 + l * PER_LINE * cw} y={40} width={PER_LINE * cw - 2} height={34} rx={4} fill={cache.current.includes(l) ? "var(--c3)" : "var(--subtle)"} opacity={cache.current.includes(l) ? 0.25 : 1} stroke="var(--border)" />
          ))}
          {Array.from({ length: NODES }, (_, n) => <circle key={n} cx={x(n)} cy={57} r={Math.min(7, cw / 3)} fill={n === cur ? "var(--c4)" : "var(--fg)"} opacity={n === cur ? 1 : 0.35} />)}
          {step.current > 1 && <path d={`M${x(prev)} 40 Q ${(x(prev) + x(cur)) / 2} ${8} ${x(cur)} 40`} fill="none" stroke="var(--c4)" strokeWidth={1.5} markerEnd="url(#pw)" />}
          <defs><marker id="pw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--c4)" /></marker></defs>
          <text x={5} y={96} fontSize={10.5} fill="var(--muted)">memory addresses →   boxes: 64-byte cache lines (4 nodes each); green boxes are in the cache ({CAP} lines)</text>
        </svg>
      </div>
      <Stats items={[{ label: "nodes visited", value: step.current }, { label: "cache misses", value: misses.current }, { label: "misses per node", value: step.current ? (misses.current / step.current).toFixed(2) : "–" }]} />
    </Demo>
  );
}

// ---------------- hot / cold bytes ----------------

export function HotColdDemo() {
  const [layout, setLayout] = useState<"object" | "split">("object");
  const ENT = 8;
  const [ref, w] = useWidth<HTMLDivElement>();
  const lineW = (w - 80) / 2; // two 64-byte lines per row
  const byte = lineW / 64;
  const rows = layout === "object"
    ? Array.from({ length: ENT }, (_, e) => ({ label: `entity ${e}`, spans: [{ from: 0, to: 24, hot: true }, { from: 24, to: 128, hot: false }], lines: [true, false] }))
    : [
      { label: "positions", spans: [{ from: 0, to: 96, hot: true }, { from: 96, to: 128, hot: false }], lines: [true, true] },
      { label: "velocities", spans: [{ from: 0, to: 96, hot: true }, { from: 96, to: 128, hot: false }], lines: [true, true] },
    ];
  const loaded = rows.reduce((s, r) => s + r.lines.filter(Boolean).length, 0) * 64;
  const used = ENT * 24;
  return (
    <Demo title="Bytes the update loop loads, for 8 entities" controls={<Param spec={select({ label: "Layout", options: [{ value: "object", label: "Objects" }, { value: "split", label: "Hot arrays" }], default: "object", segmented: true })} value={layout} onChange={(v) => setLayout(v as "object" | "split")} />}>
      <div ref={ref}>
        <svg width={w} height={rows.length * 26 + 8} style={{ display: "block" }}>
          {rows.map((r, i) => (
            <g key={i} transform={`translate(0, ${i * 26})`}>
              <text x={0} y={16} fontSize={11} fill="var(--muted)">{r.label}</text>
              {[0, 1].map((l) => <rect key={l} x={80 + l * lineW} y={2} width={lineW - 3} height={20} rx={3} fill="none" stroke={r.lines[l] ? "var(--c2)" : "var(--border)"} strokeWidth={r.lines[l] ? 1.75 : 1} />)}
              {r.spans.map((s, k) => <rect key={k} x={80 + s.from * byte + Math.floor(s.from / 64) * 0} y={5} width={(s.to - s.from) * byte - 3} height={14} rx={2} fill={s.hot ? "var(--c1)" : "var(--subtle)"} />)}
            </g>
          ))}
        </svg>
      </div>
      <Legend box items={[{ label: "hot bytes (position, velocity)", color: "var(--c1)" }, { label: "cold bytes", color: "var(--border)" }, { label: "cache line the loop loads", color: "var(--c2)" }]} />
      <Stats items={[{ label: "bytes loaded", value: loaded }, { label: "bytes used", value: used }, { label: "useful", value: pct(used / loaded, 0) }]} />
    </Demo>
  );
}

// ---------------- AoS / SoA picture ----------------

export function LayoutPictureDemo() {
  const [layout, setLayout] = useState<"aos" | "soa" | "aosoa">("aos");
  const [read, setRead] = useState(1);
  const E = 16, F = 4; // 16 entities × 4 fields of 4 bytes = 4 lines
  const FIELDS = ["x", "y", "z", "w"];
  const cells = Array.from({ length: E * F }, (_, n) => {
    if (layout === "aos") return { e: Math.floor(n / F), f: n % F };
    if (layout === "soa") return { e: n % E, f: Math.floor(n / E) };
    const block = Math.floor(n / (F * 4)), inBlock = n % (F * 4);
    return { e: block * 4 + (inBlock % 4), f: Math.floor(inBlock / 4) };
  });
  const lineTouched = Array.from({ length: 4 }, (_, l) => cells.slice(l * 16, l * 16 + 16).some((c) => c.f < read));
  const loaded = lineTouched.filter(Boolean).length;
  return (
    <Demo
      title="Where each field lives (16 entities, 4 fields)"
      controls={
        <>
          <Param spec={select({ label: "Layout (AoSoA uses blocks of 4)", options: [{ value: "aos", label: "AoS" }, { value: "soa", label: "SoA" }, { value: "aosoa", label: "AoSoA" }], default: "aos", segmented: true })} value={layout} onChange={(v) => setLayout(v as "aos" | "soa" | "aosoa")} />
          <Param spec={range({ label: "Fields the loop reads", min: 1, max: 4, step: 1, default: 1 })} value={read} onChange={(v) => setRead(v as number)} />
        </>
      }
    >
      <div style={{ display: "grid", gap: 6 }}>
        {[0, 1, 2, 3].map((l) => (
          <div key={l} style={{ display: "grid", gridTemplateColumns: "60px repeat(16, 1fr)", gap: 2, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: lineTouched[l] ? "var(--c2)" : "var(--muted)" }}>line {l}{lineTouched[l] ? " ✓" : ""}</span>
            {cells.slice(l * 16, l * 16 + 16).map((c, i) => (
              <div key={i} style={{ height: 26, borderRadius: 3, background: TC[c.f], opacity: c.f < read ? 0.95 : 0.22, color: "#fff", fontSize: 10, display: "grid", placeItems: "center" }}>{FIELDS[c.f]}{c.e}</div>
            ))}
          </div>
        ))}
      </div>
      <Stats items={[{ label: "cache lines loaded", value: `${loaded} of 4` }, { label: "bytes used / loaded", value: pct((read * 16 * 4) / (loaded * 64), 0) }]} />
    </Demo>
  );
}
