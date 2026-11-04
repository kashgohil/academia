import { useEffect, useMemo, useState } from "react";
import { Demo, Stats, Controls, Param, Plot, Line, Dots, Legend, RuleX, useParams, select, range, toggle, bytes } from "../kit";
import { loadCacheSim } from "../wasm/cachesim";
import { evaluate, randomAccessLatency, PATTERNS, ENTITY_LAYOUTS, LADDER, layoutTrace, usefulFraction, LEVELS, type Soa } from "../sims/perf/memory";

type Sim = Awaited<ReturnType<typeof loadCacheSim>>;
function useSim() {
  const [w, setW] = useState<Sim | null>(null);
  useEffect(() => { void loadCacheSim().then(setW); }, []);
  return w;
}

const fmtNs = (ns: number) => (ns < 1000 ? `${ns.toFixed(ns < 10 ? 1 : 0)} ns` : ns < 1e6 ? `${+(ns / 1000).toPrecision(3)} µs` : `${+(ns / 1e6).toPrecision(3)} ms`);
function human(ns: number) {
  // 1 ns → 1 second
  const s = ns;
  if (s < 60) return `${s.toFixed(0)} s`;
  if (s < 3600) return `${(s / 60).toFixed(0)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  if (s < 86400 * 365) return `${(s / 86400).toFixed(0)} days`;
  return `${(s / (86400 * 365)).toFixed(1)} years`;
}

export function LatencyLadderDemo() {
  const [scaled, setScaled] = useState(false);
  const max = Math.log10(LADDER[LADDER.length - 1]!.ns);
  return (
    <Demo title="Latency numbers, on a log scale" controls={<Param spec={toggle({ label: "Human scale: if 1 ns took 1 second", default: false })} value={scaled} onChange={(v) => setScaled(v as boolean)} />}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, 230px) 1fr 90px", gap: "6px 12px", alignItems: "center", fontSize: 13 }}>
        {LADDER.map((r) => (
          <div key={r.label} style={{ display: "contents" }}>
            <span title={r.note}>{r.label}</span>
            <div style={{ height: 10, background: "var(--subtle)", borderRadius: 2 }}>
              <div style={{ height: "100%", width: `${Math.max(1.5, (100 * Math.log10(r.ns * 10)) / (max + 1))}%`, background: r.ns < 100 ? "var(--c3)" : r.ns < 1e5 ? "var(--c2)" : "var(--c4)", borderRadius: 2 }} />
            </div>
            <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{scaled ? human(r.ns) : fmtNs(r.ns)}</span>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Order-of-magnitude figures for current commodity hardware; any real machine differs by 2–3×. Hover a row for the range.</p>
    </Demo>
  );
}

const WS = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144].map((k) => k * 1024);

export function LatencyStaircaseDemo() {
  const w = useSim();
  const [pts, setPts] = useState<[number, number][] | null>(null);
  useEffect(() => { if (w) setTimeout(() => setPts(WS.map((b) => [b, randomAccessLatency(w, b)])), 20); }, [w]);
  return (
    <Demo title="Random-access latency vs working-set size">
      {pts ? (
        <Plot x={[WS[0]!, WS[WS.length - 1]!]} y={[0, 100]} logX height={240} xTicks={WS.filter((_, i) => i % 3 === 0)} xFormat={bytes} xLabel="working set" yLabel="ns per access">
          {LEVELS.map((l, i) => <RuleX key={i} at={l.size} label={["L1", "L2", "L3"][i]} />)}
          <Line points={pts} width={2} />
          <Dots points={pts} r={2.5} />
        </Plot>
      ) : <div className="muted" style={{ height: 240 }}>simulating…</div>}
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Simulated: 32 KiB L1, 1 MiB L2, 8 MiB L3; latencies 1 / 4 / 14 / 90 ns. Each access depends on the previous one, as in a pointer chase.</p>
    </Demo>
  );
}

const sizeSchema = {
  pattern: select({ label: "Code", options: PATTERNS.map((p) => ({ value: p.id, label: p.label })), default: "list-shuffled" }),
  n: select({ label: "Elements", options: [4096, 32768, 262144].map((n) => ({ value: String(n), label: n.toLocaleString() })), default: "262144", segmented: true }),
};

export function CacheFriendlyDemo() {
  const w = useSim();
  const params = useParams("cf", sizeSchema);
  const n = Number(params.values.n);
  const res = useMemo(() => (w ? PATTERNS.map((p) => ({ p, c: evaluate(w, p.gen(n), n, p.random) })) : null), [w, n]);
  if (!res) return <div className="demo" style={{ height: 300 }} />;
  const cur = res.find((x) => x.p.id === params.values.pattern)!;
  const max = Math.max(...res.map((x) => x.c.nsPerElem));
  return (
    <Demo title="Same work, different memory layouts" controls={<Controls params={params} />}>
      <code style={{ fontSize: 12.5 }}>{cur.p.code}</code>
      <Stats items={[{ label: "ns per element", value: cur.c.nsPerElem.toFixed(2) }, ...["L1", "L2", "L3", "DRAM"].map((l, i) => ({ label: `from ${l} (per elem)`, value: cur.c.servedFrom[i]!.toFixed(2) }))]} />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(170px, 260px) 1fr 70px", gap: "6px 12px", alignItems: "center", fontSize: 13, marginTop: 14 }}>
        {res.map(({ p, c }) => (
          <div key={p.id} style={{ display: "contents" }}>
            <span style={{ fontWeight: p.id === cur.p.id ? 600 : 400 }}>{p.label}</span>
            <div style={{ height: 10, background: "var(--subtle)", borderRadius: 2 }}><div style={{ height: "100%", width: `${(100 * c.nsPerElem) / max}%`, background: p.random ? "var(--c4)" : "var(--c3)", borderRadius: 2 }} /></div>
            <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{c.nsPerElem.toFixed(2)} ns</span>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Green: predictable addresses (prefetched, misses overlap). Red: unpredictable dependent accesses (each miss pays full latency). Second pass shown, after a warm-up pass.</p>
    </Demo>
  );
}

const dodSchema = { n: select({ label: "Entities", options: [5000, 20000, 100000].map((n) => ({ value: String(n), label: n.toLocaleString() })), default: "100000", segmented: true }) };

export function DodDemo() {
  const w = useSim();
  const params = useParams("dod", dodSchema);
  const n = Number(params.values.n);
  const res = useMemo(() => (w ? ENTITY_LAYOUTS.map((l) => ({ l, c: evaluate(w, l.gen(n), n, l.random) })) : null), [w, n]);
  if (!res) return <div className="demo" style={{ height: 260 }} />;
  const max = Math.max(...res.map((x) => x.c.nsPerElem));
  return (
    <Demo title="position += velocity for every entity" controls={<Controls params={params} />}>
      <div style={{ display: "grid", gap: 12 }}>
        {res.map(({ l, c }) => (
          <div key={l.id} style={{ fontSize: 13 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>{l.label}</b>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{c.nsPerElem.toFixed(2)} ns/entity · {c.bytesFromDram.toFixed(0)} B from DRAM</span>
            </div>
            <div style={{ height: 10, background: "var(--subtle)", borderRadius: 2, margin: "4px 0" }}><div style={{ height: "100%", width: `${(100 * c.nsPerElem) / max}%`, background: l.random ? "var(--c4)" : "var(--c1)", borderRadius: 2 }} /></div>
            <div className="muted" style={{ fontSize: 12 }}>{l.note}</div>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Each entity is 128 bytes; the update reads and writes 24 of them. Working set: {bytes(n * 128)} as objects, {bytes(n * 24)} as hot arrays.</p>
    </Demo>
  );
}

const soaSchema = {
  fields: select({ label: "Fields per entity (4 B each)", options: ["4", "8", "16", "32"].map((v) => ({ value: v, label: v })), default: "16", segmented: true }),
  touched: range({ label: "Fields the loop reads", min: 1, max: 32, step: 1, default: 2 }),
};

/** Linear interpolation between computed points (fields read is an integer slider). */
function interp(pts: [number, number][], k: number) {
  const hi = pts.findIndex((p) => p[0] >= k);
  if (hi <= 0) return pts[Math.max(0, hi)]![1];
  const [x0, y0] = pts[hi - 1]!, [x1, y1] = pts[hi]!;
  return y0 + ((y1 - y0) * (k - x0)) / (x1 - x0);
}

const LAYOUTS: { id: Soa; label: string; color: string }[] = [
  { id: "aos", label: "Array of structs", color: "var(--c4)" },
  { id: "soa", label: "Struct of arrays", color: "var(--c1)" },
  { id: "aosoa", label: "AoSoA (blocks of 8)", color: "var(--c3)" },
];

export function SoaDemo() {
  const w = useSim();
  const params = useParams("soa", soaSchema);
  const fields = Number(params.values.fields);
  const touched = Math.min(params.values.touched, fields);
  const N = 262144;
  // Heavy: compute off the critical path, one layout per tick, so the page stays responsive.
  const [curves, setCurves] = useState<{ id: Soa; label: string; color: string; pts: [number, number][] }[] | null>(null);
  useEffect(() => {
    if (!w) return;
    setCurves(null);
    const ks = [...new Set([1, 2, 4, 8, Math.round(fields * 0.75), fields])].filter((k) => k <= fields).sort((a, b) => a - b);
    const acc: { id: Soa; label: string; color: string; pts: [number, number][] }[] = [];
    const timers = LAYOUTS.map((l, i) =>
      setTimeout(() => {
        acc.push({ ...l, pts: ks.map((k) => [k, evaluate(w, layoutTrace(l.id, N, fields, k), N, false).nsPerElem] as [number, number]) });
        if (acc.length === LAYOUTS.length) setCurves([...acc]);
      }, 30 * (i + 1)),
    );
    return () => timers.forEach(clearTimeout);
  }, [w, fields]);
  const now = useMemo(() => (curves ? curves.map((c) => ({ ...c, ns: interp(c.pts, touched) })) : null), [curves, touched]);
  if (!curves || !now) return <Demo title={`Reading ${touched} of ${fields} fields from ${N.toLocaleString()} entities`} controls={<Controls params={params} />}><div className="muted" style={{ height: 260 }}>simulating {N.toLocaleString()} entities in three layouts…</div></Demo>;
  return (
    <Demo title={`Reading ${touched} of ${fields} fields from ${N.toLocaleString()} entities`} controls={<Controls params={params} />}>
      <Stats items={now.map((x) => ({ label: `${x.label}: ns/entity · useful bytes`, value: <span>{x.ns.toFixed(2)} <span className="muted" style={{ fontSize: 13 }}>· {Math.round(100 * usefulFraction(x.id, fields, touched))}%</span></span> }))} />
      <div style={{ height: 10 }} />
      <Plot x={[1, fields]} y={[0, Math.max(...curves.flatMap((c) => c.pts.map((p) => p[1]))) * 1.1]} height={220} xLabel="fields read per entity" yLabel="ns per entity">
        <RuleX at={touched} />
        {curves.map((c) => <g key={c.id}><Line points={c.pts} color={c.color} width={1.75} /><Dots points={c.pts} color={c.color} r={2.5} /></g>)}
      </Plot>
      <Legend items={LAYOUTS.map((l) => ({ label: l.label, color: l.color }))} />
    </Demo>
  );
}
