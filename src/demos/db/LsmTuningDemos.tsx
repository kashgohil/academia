/** Demos for "Tuning an LSM tree": a tuning panel on the cost model, and B+ tree vs LSM. */
import { useMemo, useState } from "react";
import { Demo, Stats, Param, Legend, range, Plot, Line, RuleX, Dots, bytes, pct, si, Note, SectionLabel, StackBar, fixed, mono, seg } from "../../kit";
import {
  lsmCosts, lsmThroughput, compareEngines, crossover, EXAMPLE_DATA, WORKLOADS, ROCKSDB_DEFAULTS, dataBytes,
  type LsmConfig, type WorkloadName, type Strategy,
} from "../../sims/db/lsm";

const MiB = 2 ** 20, GiB = 2 ** 30, KiB = 1024;

const WL_LABEL: [WorkloadName, string][] = [["log", "write-heavy log"], ["point", "point lookups"], ["range", "range scans"], ["mixed", "mixed"]];

export function TuningPanelDemo() {
  const [wl, setWl] = useState<WorkloadName>("log");
  const [style, setStyle] = useState<Strategy>("leveled");
  const [wbuf, setWbuf] = useState(64);
  const [T, setT] = useState(10);
  const [trig, setTrig] = useState(4);
  const [base, setBase] = useState(256);
  const [bloom, setBloom] = useState(10);
  const [block, setBlock] = useState(4);
  const [cache, setCache] = useState(1024);
  const [comp, setComp] = useState(100);
  const cfg: LsmConfig = {
    strategy: style, writeBufferBytes: Math.round(wbuf) * MiB, maxWriteBuffers: 2, l0Trigger: trig, baseLevelBytes: Math.round(base) * MiB,
    sizeRatio: T, blockBytes: Math.round(block) * KiB, bloomBitsPerKey: bloom, blockCacheBytes: Math.round(cache) * MiB, lastLevelCompression: comp / 100,
  };
  const w = WORKLOADS[wl];
  const k = lsmCosts(cfg, EXAMPLE_DATA, w);
  const tp = lsmThroughput(cfg, EXAMPLE_DATA, w);
  const ref = useMemo(() => lsmThroughput(ROCKSDB_DEFAULTS, EXAMPLE_DATA, w).opsPerSec, [w]);
  const opts = [
    `options.compaction_style = ${style === "leveled" ? "kCompactionStyleLevel" : "kCompactionStyleUniversal"};`,
    `options.write_buffer_size = ${Math.round(wbuf)} << 20;`,
    `options.max_write_buffer_number = 2;`,
    style === "leveled" ? `options.level0_file_num_compaction_trigger = ${trig};` : `options.compaction_options_universal.min_merge_width = ${T};`,
    style === "leveled" ? `options.max_bytes_for_level_base = ${Math.round(base)}ull << 20;` : null,
    style === "leveled" ? `options.max_bytes_for_level_multiplier = ${T};` : null,
    `table.block_size = ${Math.round(block)} << 10;`,
    bloom > 0 ? `table.filter_policy.reset(NewBloomFilterPolicy(${bloom}));` : `// no filter_policy`,
    `table.block_cache = NewLRUCache(${Math.round(cache)}ull << 20);`,
    comp < 100 ? `options.bottommost_compression = kZSTD;  // ${comp}% size assumed` : null,
  ].filter(Boolean);
  return (
    <Demo
      title="Tune the tree: 100 million keys, 16-byte keys, 100-byte values"
      controls={
        <>
          <Param spec={range({ label: "write_buffer_size (MiB)", min: 4, max: 1024, default: 64, log: true, format: (v) => `${Math.round(v)}` })} value={wbuf} onChange={(v) => setWbuf(v as number)} />
          <Param spec={seg<WorkloadName>("Workload", WL_LABEL, "log")} value={wl} onChange={(v) => setWl(v as WorkloadName)} />
          <Param spec={seg<Strategy>("Compaction", [["leveled", "leveled"], ["tiered", "tiered"]], "leveled")} value={style} onChange={(v) => setStyle(v as Strategy)} />
          <Param spec={range({ label: "Size ratio T", min: 2, max: 20, step: 1, default: 10 })} value={T} onChange={(v) => setT(v as number)} />
          <Param spec={range({ label: "level0_file_num_compaction_trigger", min: 1, max: 16, step: 1, default: 4 })} value={trig} onChange={(v) => setTrig(v as number)} />
          <Param spec={range({ label: "max_bytes_for_level_base (MiB)", min: 64, max: 4096, default: 256, log: true, format: (v) => `${Math.round(v)}` })} value={base} onChange={(v) => setBase(v as number)} />
          <Param spec={range({ label: "Bloom bits per key", min: 0, max: 20, step: 1, default: 10 })} value={bloom} onChange={(v) => setBloom(v as number)} />
          <Param spec={range({ label: "block_size (KiB)", min: 1, max: 64, default: 4, log: true, format: (v) => `${Math.round(v)}` })} value={block} onChange={(v) => setBlock(v as number)} />
          <Param spec={range({ label: "Block cache (MiB)", min: 64, max: 65536, default: 1024, log: true, format: (v) => bytes(Math.round(v) * MiB) })} value={cache} onChange={(v) => setCache(v as number)} />
          <Param spec={range({ label: "Last level compressed to (%)", min: 25, max: 100, step: 5, default: 100 })} value={comp} onChange={(v) => setComp(v as number)} />
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 14px" }}>
        <span style={{ fontSize: 28, fontWeight: 700, ...mono }}>{si(tp.opsPerSec, "", 3)}</span>
        <span className="muted" style={{ fontSize: 13 }}>operations/s (model score) · RocksDB defaults: {si(ref, "", 3)} · {tp.opsPerSec >= ref ? "+" : ""}{pct(tp.opsPerSec / ref - 1, 0)}</span>
      </div>
      <SectionLabel>Where the time goes</SectionLabel>
      <StackBar parts={[{ value: tp.share.write, color: "var(--c1)", label: "writes" }, { value: tp.share.point, color: "var(--c3)", label: "point reads" }, { value: tp.share.range, color: "var(--c2)", label: "range scans" }]} />
      <div style={{ marginTop: 4 }}><Legend box items={[{ label: `writes ${pct(tp.share.write, 0)}`, color: "var(--c1)" }, { label: `point reads ${pct(tp.share.point, 0)}`, color: "var(--c3)" }, { label: `range scans ${pct(tp.share.range, 0)}`, color: "var(--c2)" }]} /></div>
      <Stats
        items={[
          { label: "write amp", value: fixed(k.writeAmp, 1) },
          { label: `${style === "leveled" ? "levels below L0" : "tiers"} · sorted runs`, value: `${k.levels} · ${fixed(k.runs, 1)}` },
          { label: "block reads: hit · miss key", value: `${fixed(k.pointIos, 3)} · ${fixed(k.missIos, 3)}` },
          { label: `block reads per ${w.scanLength}-row scan`, value: fixed(k.rangeIos, 1) },
          { label: "space amp (this workload)", value: fixed(k.spaceAmp, 2) },
          { label: "block cache hit rate", value: pct(k.cacheHit, 1) },
          { label: "memory: total", value: bytes(k.memory.total) },
          { label: "filters · index", value: `${bytes(k.memory.filters)} · ${bytes(k.memory.index)}` },
        ]}
      />
      <SectionLabel>The same choices as RocksDB options (C++)</SectionLabel>
      <pre style={{ ...mono, fontSize: 11.5, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", margin: 0, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{opts.join("\n")}</pre>
      <Note>Data: {bytes(dataBytes(EXAMPLE_DATA))} raw. The score is a model: NVMe-class disk (400k random reads/s, 2 GiB/s sequential), compaction reads and writes at sequential speed, uniform key access.</Note>
    </Demo>
  );
}

// ================= B+ tree vs LSM =================

const CACHES: [string, string][] = [["1", "1 GiB"], ["4", "4 GiB"], ["16", "16 GiB"]];

export function BtreeVsLsmDemo() {
  const [wf, setWf] = useState(0.5);
  const [page, setPage] = useState<"4" | "16">("16");
  const [mem, setMem] = useState("4");
  const budget = Number(mem) * GiB, pageBytes = Number(page) * KiB;
  const r = compareEngines(budget, pageBytes, wf);
  const curve = useMemo(() => {
    const xs = Array.from({ length: 41 }, (_, i) => i / 40);
    const rows = xs.map((x) => compareEngines(budget, pageBytes, x));
    return { lsm: rows.map((x, i) => [xs[i]!, x.lsm.tput.opsPerSec / 1000] as const), bt: rows.map((x, i) => [xs[i]!, x.btree.opsPerSec / 1000] as const) };
  }, [budget, pageBytes]);
  const cross = useMemo(() => crossover(budget, pageBytes), [budget, pageBytes]);
  const yMax = Math.max(...curve.lsm.map((p) => p[1]), ...curve.bt.map((p) => p[1])) * 1.1;
  const rows: [string, string, string][] = [
    ["bytes written per user byte", fixed(r.btree.costs.writeAmp, 0), fixed(r.lsm.costs.writeAmp, 1)],
    ["block reads per point lookup", fixed(r.btree.costs.pointIos, 2), fixed(r.lsm.costs.pointIos * (1 - r.lsm.costs.cacheHit), 2)],
    ["space amplification", fixed(r.btree.costs.spaceAmp, 2), fixed(r.lsm.costs.spaceAmp, 2)],
    ["cache for data pages", bytes(budget), bytes(r.lsm.cfg.blockCacheBytes)],
    ["throughput score (k ops/s)", fixed(r.btree.opsPerSec / 1000, 0), fixed(r.lsm.tput.opsPerSec / 1000, 0)],
  ];
  return (
    <Demo
      title="B+ tree or LSM tree: the same data, memory and workload"
      controls={
        <>
          <Param spec={range({ label: "Share of writes", min: 0, max: 1, step: 0.05, default: 0.5, format: (v) => pct(v, 0) })} value={wf} onChange={(v) => setWf(v as number)} />
          <Param spec={seg<"4" | "16">("B+ tree page", [["4", "4 KiB (SQLite)"], ["16", "16 KiB (InnoDB)"]], "16")} value={page} onChange={(v) => setPage(v as "4" | "16")} />
          <Param spec={seg("Memory budget", CACHES, "4")} value={mem} onChange={(v) => setMem(v as string)} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr)", gap: "4px 10px", fontSize: 13, alignItems: "baseline" }}>
        <span />
        <b style={{ color: "var(--c2)" }}>B+ tree</b>
        <b style={{ color: "var(--c1)" }}>LSM (leveled)</b>
        {rows.map(([a, b, c]) => (
          <div key={a} style={{ display: "contents" }}>
            <span className="muted">{a}</span>
            <span style={mono}>{b}</span>
            <span style={mono}>{c}</span>
          </div>
        ))}
      </div>
      <SectionLabel style={{ marginTop: 14 }}>Throughput score against the share of writes</SectionLabel>
      <Plot x={[0, 1]} y={[0, yMax]} height={220} xLabel="share of writes" yLabel="k ops/s" xFormat={(v) => pct(v, 0)}>
        <Line points={curve.bt} color="var(--c2)" />
        <Line points={curve.lsm} color="var(--c1)" />
        <RuleX at={wf} />
        <Dots points={[[wf, r.btree.opsPerSec / 1000], [wf, r.lsm.tput.opsPerSec / 1000]]} color="var(--fg)" r={3.5} />
      </Plot>
      <Legend items={[{ label: "B+ tree", color: "var(--c2)" }, { label: "LSM tree", color: "var(--c1)" }]} />
      <Note>The LSM tree has the higher score when more than {pct(cross, 1)} of operations are writes. Both trees get the same memory; the LSM tree first pays for its memtables, filters and index.</Note>
    </Demo>
  );
}
