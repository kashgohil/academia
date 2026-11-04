import { useEffect, useMemo, useState } from "react";
import { Demo, Stats, Controls, Canvas2D, cssVar, Plot, Line, Dots, Legend, RuleX, useParams, range, select, bytes, pct } from "../kit";
import { loadCacheSim, runCache, OUTCOME, type Policy } from "../wasm/cachesim";
import { PATTERNS } from "../sims/patterns";

const SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768];

const schema = {
  pattern: select({ label: "Access pattern", options: PATTERNS.map((p) => ({ value: p.id, label: p.label })), default: "row-major" }),
  size: select({ label: "Cache size", options: SIZES.map((s) => ({ value: String(s), label: bytes(s) })), default: "4096" }),
  line: select({ label: "Line size", options: [16, 32, 64, 128].map((s) => ({ value: String(s), label: `${s} B` })), default: "64", segmented: true }),
  ways: select({ label: "Associativity", options: [["1", "Direct"], ["2", "2-way"], ["4", "4-way"], ["8", "8-way"], ["0", "Full"]].map(([value, label]) => ({ value: value!, label: label! })), default: "1", segmented: true }),
  policy: select<Policy>({ label: "Replacement", options: [{ value: "lru", label: "LRU" }, { value: "fifo", label: "FIFO" }, { value: "random", label: "Random" }], default: "lru", segmented: true }),
  n: range({ label: "Accesses", min: 256, max: 16384, default: 4096, log: true, format: (v) => String(Math.round(v)) }),
};

const COLORS = ["--c3", "--faint", "--c2", "--c4"] as const; // hit, compulsory, capacity, conflict
const NAMES = ["hit", "compulsory miss", "capacity miss", "conflict miss"];

type Sim = Awaited<ReturnType<typeof loadCacheSim>>;

export function CacheDemo() {
  const params = useParams("cache", schema);
  const v = params.values;
  const [wasm, setWasm] = useState<Sim | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { loadCacheSim().then(setWasm, (e) => setErr(String(e))); }, []);

  const size = Number(v.size), line = Number(v.line);
  const ways = Math.min(Number(v.ways) || size / line, size / line);
  const sets = size / line / ways;
  const pattern = PATTERNS.find((p) => p.id === v.pattern)!;
  const addrs = useMemo(() => pattern.gen({ n: Math.round(v.n) }), [pattern, v.n]);

  const out = useMemo(() => (wasm ? runCache(wasm, addrs, { size, line, ways, policy: v.policy }) : null), [wasm, addrs, size, line, ways, v.policy]);

  // Sweep: hit rate vs cache size, for each associativity, holding line size and policy fixed.
  const sweep = useMemo(() => {
    if (!wasm) return null;
    return [1, 2, 4, 0].map((w) => ({
      ways: w,
      pts: SIZES.map((s) => {
        const o = runCache(wasm, addrs, { size: s, line, ways: w || s / line, policy: v.policy });
        let hits = 0;
        for (const b of o) if (b === OUTCOME.hit) hits++;
        return [s, hits / o.length] as [number, number];
      }),
    }));
  }, [wasm, addrs, line, v.policy]);

  if (err) return <div className="empty">Couldn't load the WebAssembly simulator: {err}</div>;

  const counts = [0, 0, 0, 0];
  if (out) for (const b of out) counts[b]!++;
  const total = out?.length ?? 1;

  return (
    <Demo title="Set-associative cache (Rust → WebAssembly)" controls={<Controls params={params} />}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{pattern.note}</p>
      <Stats
        items={[
          { label: "hit rate", value: out ? pct(counts[0]! / total) : "…" },
          { label: "compulsory", value: counts[1] },
          { label: "capacity", value: counts[2] },
          { label: "conflict", value: counts[3] },
          { label: "geometry", value: `${sets} sets × ${ways} ways` },
        ]}
      />
      <div style={{ height: 12 }} />
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>Every access in program order, left to right, top to bottom</div>
      <Canvas2D
        height={(w) => {
          const cols = Math.max(32, Math.floor(w / 6));
          return Math.ceil(total / cols) * 6;
        }}
        deps={[out]}
        draw={(ctx, w) => {
          if (!out) return;
          const cell = 6;
          const cols = Math.max(32, Math.floor(w / cell));
          const palette = COLORS.map((c) => cssVar(c));
          for (let i = 0; i < out.length; i++) {
            ctx.fillStyle = palette[out[i]!]!;
            ctx.fillRect((i % cols) * cell, Math.floor(i / cols) * cell, cell - 1, cell - 1);
          }
        }}
      />
      <div style={{ marginTop: 8 }}>
        <Legend box items={NAMES.map((n, i) => ({ label: n, color: `var(${COLORS[i]})` }))} />
      </div>
      {sweep && (
        <>
          <div className="muted" style={{ fontSize: 12.5, margin: "20px 0 4px" }}>Hit rate vs cache size for this pattern</div>
          <Plot x={[SIZES[0]!, SIZES[SIZES.length - 1]!]} y={[0, 1]} logX height={200} xFormat={(t) => (SIZES.includes(t) ? bytes(t) : "")} yFormat={(t) => pct(t, 0)}>
            {sweep.map((s, i) => (
              <g key={s.ways}>
                <Line points={s.pts} color={`var(--c${i + 1})`} width={1.5} />
                <Dots points={s.pts} color={`var(--c${i + 1})`} r={2.5} />
              </g>
            ))}
            <RuleX at={size} />
          </Plot>
          <Legend items={sweep.map((s, i) => ({ label: s.ways ? (s.ways === 1 ? "direct-mapped" : `${s.ways}-way`) : "fully associative", color: `var(--c${i + 1})` }))} />
        </>
      )}
    </Demo>
  );
}
