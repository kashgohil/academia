import { useMemo } from "react";
import { Demo, Stats, Controls, Plot, Line, Bars, Dots, Legend, RuleX, useParams, select, bytes, pct } from "../kit";
import { runReuse, runCache, OUTCOME, COLD } from "../wasm/cachesim";
import { PATTERNS } from "../sims/patterns";
import { matmul, type LoopOrder } from "../sims/memtraces";
import { useCacheSim } from "./cache/useCacheSim";

// ---------------- Reuse distance ----------------

const reuseSchema = {
  pattern: select({ label: "Access pattern", options: PATTERNS.map((p) => ({ value: p.id, label: p.label })), default: "row-major" }),
  line: select({ label: "Line size", options: [4, 16, 64, 256].map((s) => ({ value: String(s), label: `${s} B` })), default: "64", segmented: true }),
};

const CAPS = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

export function ReuseDemo() {
  const params = useParams("reuse", reuseSchema);
  const line = Number(params.values.line);
  const pattern = PATTERNS.find((p) => p.id === params.values.pattern)!;
  const { w, err } = useCacheSim();

  const data = useMemo(() => {
    if (!w) return null;
    const addrs = pattern.gen({ n: 4096 });
    const d = runReuse(w, addrs, line);
    // Histogram over log2 buckets: 0, 1, 2–3, 4–7, …, plus cold.
    const buckets = new Array(16).fill(0) as number[];
    let cold = 0;
    for (const x of d) {
      if (x === COLD) cold++;
      else buckets[x === 0 ? 0 : Math.min(15, 32 - Math.clz32(x))]!++;
    }
    const curve = CAPS.map((cap) => {
      const lines = Math.max(1, cap / line);
      let hits = 0;
      for (const x of d) if (x !== COLD && x < lines) hits++;
      return [cap, hits / d.length] as [number, number];
    });
    return { n: d.length, buckets, cold, curve };
  }, [w, pattern, line]);

  if (err) return <div className="empty">Couldn't load the simulator: {err}</div>;
  if (!data) return <div className="demo" style={{ height: 300 }} />;
  const maxB = Math.max(...data.buckets, data.cold);
  const bars = data.buckets.map((c, i) => ({ x0: i, x1: i + 1, y: c / data.n }));

  return (
    <Demo title="Reuse distance: one pass predicts every cache size" controls={<Controls params={params} />}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{pattern.note}</p>
      <Stats
        items={[
          { label: "accesses", value: data.n },
          { label: "first touches (cold)", value: pct(data.cold / data.n) },
          { label: "distinct lines touched", value: data.cold },
          { label: "footprint", value: bytes(data.cold * line) },
        ]}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18, marginTop: 14 }}>
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>Reuse distance (distinct lines since last use)</div>
          <Plot x={[0, 16]} y={[0, Math.max(0.05, maxB / data.n) * 1.1]} height={200} xTicks={[0, 1, 3, 5, 7, 9, 11, 13, 15]} xFormat={(t) => (t === 0 ? "0" : `${2 ** (t - 1)}`)} yFormat={(t) => pct(t, 0)}>
            <Bars bins={bars} />
          </Plot>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>Hit rate of a fully associative LRU cache</div>
          <Plot x={[CAPS[0]!, CAPS[CAPS.length - 1]!]} y={[0, 1]} logX height={200} xTicks={[64, 256, 1024, 4096, 16384, 65536]} xFormat={bytes} yFormat={(t) => pct(t, 0)}>
            <Line points={data.curve} />
            <Dots points={data.curve} r={2.5} />
            <RuleX at={Math.max(64, data.cold * line)} label="footprint" />
          </Plot>
        </div>
      </div>
    </Demo>
  );
}

// ---------------- Matrix multiply loop order ----------------

const ORDERS: { id: LoopOrder; label: string; color: string }[] = [
  { id: "ijk", label: "ijk", color: "var(--c4)" },
  { id: "jki", label: "jki", color: "var(--c2)" },
  { id: "ikj", label: "ikj", color: "var(--c1)" },
  { id: "tiled", label: "tiled ikj", color: "var(--c3)" },
];

const mmSchema = {
  cache: select({ label: "Cache (8-way, 64 B lines)", options: [4096, 8192, 16384, 32768].map((s) => ({ value: String(s), label: bytes(s) })), default: "8192", segmented: true }),
  tile: select({ label: "Tile", options: ["4", "8", "16", "32"].map((v) => ({ value: v, label: `${v}×${v}` })), default: "8", segmented: true }),
};

const N = 64;

export function MatmulDemo() {
  const params = useParams("mm", mmSchema);
  const size = Number(params.values.cache);
  const tile = Number(params.values.tile);
  const { w } = useCacheSim();

  const res = useMemo(() => {
    if (!w) return null;
    return ORDERS.map((o) => {
      const t = matmul(N, o.id, tile);
      const out = runCache(w, t.addrs, { size, line: 64, ways: 8, policy: "lru" });
      const per = [0, 0, 0, 0];
      for (let i = 0; i < out.length; i++) if (out[i] !== OUTCOME.hit) per[t.pcs[i]!]!++;
      return { ...o, total: per[1]! + per[2]! + per[3]!, a: per[1]!, b: per[2]!, c: per[3]! };
    });
  }, [w, size, tile]);

  if (!res) return <div className="demo" style={{ height: 260 }} />;
  const inner = N ** 3;
  const max = Math.max(...res.map((r) => r.total / inner));

  return (
    <Demo title={`C += A × B, ${N}×${N} doubles (3 × 32 KiB)`} controls={<Controls params={params} />}>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Cache misses per inner-loop iteration, split by matrix</div>
      <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 56px", gap: "8px 12px", alignItems: "center", fontSize: 13 }}>
        {res.map((r) => (
          <div key={r.id} style={{ display: "contents" }}>
            <code>{r.label}</code>
            <div style={{ display: "flex", height: 14, background: "var(--subtle)", borderRadius: 2, overflow: "hidden" }}>
              {(["a", "b", "c"] as const).map((k, i) => (
                <div key={k} title={`${k.toUpperCase()}: ${(r[k] / inner).toFixed(3)}`} style={{ width: `${(100 * r[k]) / inner / max}%`, background: `var(--c${[5, 2, 1][i]})` }} />
              ))}
            </div>
            <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{(r.total / inner).toFixed(3)}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Legend box items={[{ label: "A", color: "var(--c5)" }, { label: "B", color: "var(--c2)" }, { label: "C", color: "var(--c1)" }]} />
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
        Tiled: three {tile}×{tile} tiles of doubles = {bytes(3 * tile * tile * 8)}, against a {bytes(size)} cache.
      </p>
    </Demo>
  );
}
