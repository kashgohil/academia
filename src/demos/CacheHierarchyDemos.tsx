import { useMemo } from "react";
import { Demo, Stats, Controls, Plot, Line, Dots, Legend, RuleX, useParams, select, bytes, pct } from "../kit";
import { runWrite, runHier, runPrefetch, type Inclusion, type PrefetchKind } from "../wasm/cachesim";
import { WRITE_PATTERNS, PREFETCH_PATTERNS, randomInSet } from "../sims/memtraces";
import { useCacheSim } from "./cache/useCacheSim";
import { AccessGrid } from "./cache/AccessGrid";

const kib = (b: number) => (b >= 1024 ? `${(b / 1024).toFixed(b % 1024 ? 1 : 0)} KiB` : `${b} B`);

// ---------------- Write policies ----------------

const writeSchema = {
  pattern: select({ label: "Workload", options: WRITE_PATTERNS.map((p) => ({ value: p.id, label: p.label })), default: "memset" }),
};

const COMBOS = [
  { wb: true, wa: true, label: "Write-back + write-allocate", note: "most CPUs' L1/L2" },
  { wb: false, wa: false, label: "Write-through + no-allocate", note: "simple, common for write buffers" },
  { wb: true, wa: false, label: "Write-back + no-allocate", note: "" },
  { wb: false, wa: true, label: "Write-through + write-allocate", note: "" },
];

export function WritePolicyDemo() {
  const params = useParams("wp", writeSchema);
  const pattern = WRITE_PATTERNS.find((p) => p.id === params.values.pattern)!;
  const { w } = useCacheSim();
  const LINE = 64;

  const res = useMemo(() => {
    if (!w) return null;
    const t = pattern.gen();
    const stores = t.writes.reduce((s, x) => s + x, 0);
    return {
      n: t.addrs.length,
      stores,
      rows: COMBOS.map((c) => {
        const { stats: s } = runWrite(w, t.addrs, t.writes, { size: 4096, line: LINE, ways: 4, writeBack: c.wb, writeAllocate: c.wa });
        // Dirty lines still in the cache must be written eventually: count them as owed traffic.
        const write = s.memWrite + s.dirtyAtEnd * LINE;
        const wordWrites = (s.memWrite - s.writebacks * LINE) / 4;
        const transactions = s.memRead / LINE + s.writebacks + s.dirtyAtEnd + wordWrites;
        return { ...c, read: s.memRead, write, transactions, misses: s.misses };
      }),
    };
  }, [w, pattern]);

  if (!res) return <div className="demo" style={{ height: 260 }} />;
  const max = Math.max(...res.rows.map((r) => r.read + r.write), 1);
  const data = res.stores * 4;

  return (
    <Demo title="Memory traffic by write policy · 4 KiB cache, 64 B lines" controls={<Controls params={params} />}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {pattern.note} {res.n.toLocaleString()} accesses, {res.stores.toLocaleString()} stores ({kib(data)} of stored data).
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(170px, 230px) 1fr 150px", gap: "10px 12px", alignItems: "center", fontSize: 13 }}>
        {res.rows.map((r) => (
          <div key={r.label} style={{ display: "contents" }}>
            <div>
              {r.label}
              {r.note && <div className="muted" style={{ fontSize: 11.5 }}>{r.note}</div>}
            </div>
            <div style={{ display: "flex", height: 14, background: "var(--subtle)", borderRadius: 2, overflow: "hidden" }}>
              <div title={`read ${kib(r.read)}`} style={{ width: `${(100 * r.read) / max}%`, background: "var(--c1)" }} />
              <div title={`written ${kib(r.write)}`} style={{ width: `${(100 * r.write) / max}%`, background: "var(--c2)" }} />
            </div>
            <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12.5 }}>
              {kib(r.read)} / {kib(r.write)}
              <div className="muted" style={{ fontSize: 11.5 }}>{Math.round(r.transactions).toLocaleString()} transactions</div>
            </span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Legend box items={[{ label: "read from memory", color: "var(--c1)" }, { label: "written to memory (incl. dirty lines still owed)", color: "var(--c2)" }]} />
      </div>
    </Demo>
  );
}

// ---------------- Hierarchy ----------------

const LAT = [4, 12, 40, 200];

const hierSchema = {
  l1: select({ label: "L1", options: [4096, 8192, 16384].map((s) => ({ value: String(s), label: bytes(s) })), default: "8192", segmented: true }),
  l2: select({ label: "L2", options: [16384, 32768, 65536].map((s) => ({ value: String(s), label: bytes(s) })), default: "16384", segmented: true }),
  l3: select({ label: "L3", options: [0, 131072, 262144].map((s) => ({ value: String(s), label: s ? bytes(s) : "none" })), default: "131072", segmented: true }),
};

const MODES: { id: Inclusion; label: string; color: string; dash?: string }[] = [
  { id: "inclusive", label: "Inclusive", color: "var(--c4)" },
  { id: "nine", label: "Non-inclusive", color: "var(--c1)", dash: "5 4" },
  { id: "exclusive", label: "Exclusive", color: "var(--c3)" },
];

const WS = Array.from({ length: 19 }, (_, i) => Math.round(2048 * 2 ** (i / 2)));

export function HierarchyDemo() {
  const params = useParams("hier", hierSchema);
  const l1 = Number(params.values.l1), l2 = Number(params.values.l2), l3 = Number(params.values.l3);
  const levels = [{ size: l1, ways: 8 }, { size: l2, ways: 8 }, ...(l3 ? [{ size: l3, ways: 16 }] : [])];
  const lat = l3 ? LAT : [LAT[0]!, LAT[1]!, LAT[3]!];
  const { w } = useCacheSim();

  const curves = useMemo(() => {
    if (!w) return null;
    return MODES.map((m) => ({
      ...m,
      pts: WS.map((ws) => {
        const s = runHier(w, randomInSet(ws, 24000), levels, 64, m.id).subarray(8000);
        let t = 0;
        for (const k of s) t += lat[k]!;
        return [ws, t / s.length] as [number, number];
      }),
    }));
  }, [w, l1, l2, l3]); // eslint-disable-line react-hooks/exhaustive-deps

  const hot = useMemo(() => {
    if (!w) return null;
    // 2 KiB hot set touched between reads of a long streaming scan.
    const a = new Uint32Array(60000);
    for (let i = 0; i < 30000; i++) { a[2 * i] = (i % 32) * 64; a[2 * i + 1] = (1 << 24) + i * 64; }
    return MODES.map((m) => {
      const s = runHier(w, a, levels, 64, m.id);
      let n = 0, miss = 0;
      for (let i = 4000; i < s.length; i += 2) { n++; if (s[i] !== 0) miss++; }
      return { ...m, mem: miss / n };
    });
  }, [w, l1, l2, l3]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!curves || !hot) return <div className="demo" style={{ height: 360 }} />;
  const total = l1 + l2 + l3;

  return (
    <Demo title={`Average access time vs working set · latencies ${lat.join(" / ")} cycles`} controls={<Controls params={params} />}>
      <Plot x={[WS[0]!, WS[WS.length - 1]!]} y={[0, 210]} logX height={260} xTicks={WS.filter((_, i) => i % 2 === 0)} xFormat={bytes} xLabel="working set (random accesses)" yLabel="cycles">
        <RuleX at={l1} label="L1" />
        <RuleX at={l2} label="L2" />
        {l3 > 0 && <RuleX at={l3} label="L3" />}
        <RuleX at={total} label="sum" color="var(--c3)" />
        {curves.map((c) => (
          <g key={c.id}>
            <Line points={c.pts} color={c.color} width={1.75} dash={c.dash} />
            <Dots points={c.pts} color={c.color} r={2} />
          </g>
        ))}
      </Plot>
      <Legend items={curves.map((c) => ({ label: c.label, color: c.color }))} />
      <div className="muted" style={{ fontSize: 12.5, margin: "18px 0 6px" }}>A 2 KiB hot set used between reads of a streaming scan: how often the hot data misses L1</div>
      <Stats items={hot.map((h) => ({ label: h.label, value: pct(h.mem, 1) }))} />
    </Demo>
  );
}

// ---------------- Prefetching ----------------

const KINDS: { id: PrefetchKind; label: string }[] = [
  { id: "none", label: "None" },
  { id: "next-line", label: "Next-line" },
  { id: "stride", label: "Stride" },
  { id: "pc-stride", label: "Stride per PC" },
];

const pfSchema = {
  pattern: select({ label: "Access pattern", options: PREFETCH_PATTERNS.map((p) => ({ value: p.id, label: p.label })), default: "sequential" }),
  kind: select({ label: "Prefetcher", options: KINDS.map((k) => ({ value: k.id, label: k.label })), default: "next-line" }),
  degree: select({ label: "Degree (lines ahead)", options: ["1", "2", "4", "8"].map((v) => ({ value: v, label: v })), default: "2", segmented: true }),
};

export function PrefetchDemo() {
  const params = useParams("pf", pfSchema);
  const pattern = PREFETCH_PATTERNS.find((p) => p.id === params.values.pattern)!;
  const degree = Number(params.values.degree);
  const { w } = useCacheSim();

  const res = useMemo(() => {
    if (!w) return null;
    const t = pattern.gen();
    return KINDS.map((k) => ({ ...k, ...runPrefetch(w, t.addrs, t.pcs, { size: 8192, line: 64, ways: 8, kind: k.id, degree }) }));
  }, [w, pattern, degree]);

  if (!res) return <div className="demo" style={{ height: 300 }} />;
  const cur = res.find((r) => r.id === params.values.kind)!;
  const s = cur.stats;
  const coverage = (x: typeof s) => (x.covered + x.misses ? x.covered / (x.covered + x.misses) : 0);

  return (
    <Demo title="Prefetchers · 8 KiB cache, 64 B lines" controls={<Controls params={params} />}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{pattern.note}</p>
      <Stats
        items={[
          { label: "misses left", value: s.misses.toLocaleString() },
          { label: "coverage", value: pct(coverage(s), 0) },
          { label: "accuracy", value: s.issued ? pct(s.covered / s.issued, 0) : "–" },
          { label: "prefetches issued", value: s.issued.toLocaleString() },
          { label: "evicted unused", value: s.useless.toLocaleString() },
        ]}
      />
      <div style={{ height: 12 }} />
      <AccessGrid out={cur.out} colors={["--c3", "--c1", "--c4"]} labels={["hit", "hit thanks to a prefetch", "miss"]} />
      <div className="muted" style={{ fontSize: 12.5, margin: "18px 0 6px" }}>All prefetchers on this pattern (coverage · accuracy)</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
        {res.map((r) => (
          <div key={r.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", fontSize: 13, background: r.id === cur.id ? "var(--subtle)" : undefined }}>
            <div style={{ fontWeight: 550 }}>{r.label}</div>
            <div className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
              {pct(coverage(r.stats), 0)} · {r.stats.issued ? pct(r.stats.covered / r.stats.issued, 0) : "–"}
            </div>
          </div>
        ))}
      </div>
    </Demo>
  );
}
