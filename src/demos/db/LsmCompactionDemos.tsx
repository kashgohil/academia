/** Demos for "Compaction: leveled vs tiered": a side-by-side race, a WA-vs-T sweep, and write stalls. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, Legend, SimButtons, useSim, range, Plot, Line, Dots, RuleY, bytes, pct } from "../../kit";
import { mulberry32 } from "../../sims/rng";
import {
  LsmTree, writeAmp, levelCount, stallTimeline, deepWriteAmp, STALL_DEFAULTS, raceOptions, nextWrite, sweepRun, RACE_MEMTABLE, SWEEP_T, SWEEP_WRITES,
  type Strategy, type CompactionEvent, type Stream, type SweepPoint,
} from "../../sims/db/lsm";
import { seg, mono, Note, fx } from "./LsmShared";

// ================= the race =================

const SPEED: Record<string, number> = { slow: 4, medium: 24, fast: 120 };
const MAX_WRITES = 60000;

interface Racer { tree: LsmTree; last: CompactionEvent | null; lastAt: number }

function LevelView({ r, T, now }: { r: Racer; T: number; now: number }) {
  const t = r.tree;
  const leveled = t.opts.strategy === "leveled";
  let deepest = 0;
  t.levels.forEach((l, i) => { if (l.runs.length) deepest = i; });
  const rows = Math.max(3, deepest + 1);
  const recent = r.last && now - r.lastAt < 12 ? r.last : null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "26px minmax(0, 1fr) 84px", gap: "4px 6px", alignItems: "center" }}>
      {Array.from({ length: rows }, (_, i) => {
        const lvl = t.levels[i]!;
        const lb = t.levelBytes(i);
        // Capacity of the row: leveled L0 = trigger × memtable, Li = its byte budget;
        // tiered level i = T runs of about memtable × T^i bytes.
        const cap = leveled ? (i === 0 ? t.opts.l0Trigger * RACE_MEMTABLE : t.maxBytes(i)) : T * RACE_MEMTABLE * Math.pow(T, i);
        const isLast = leveled && i === t.opts.maxLevels - 1;
        const over = !isLast && lb > cap;
        const hl = recent && (recent.toLevel === i || recent.fromLevel === i);
        return (
          <div key={i} style={{ display: "contents" }}>
            <span style={{ ...mono, fontSize: 11, fontWeight: 600, color: hl ? "var(--c2)" : "var(--muted)" }}>L{i}</span>
            <div style={{ position: "relative", height: 16, borderRadius: 3, background: "var(--subtle)", outline: hl ? "2px solid var(--c2)" : "1px solid var(--border)", display: "flex", gap: 2, overflow: "hidden" }}>
              {lvl.runs.map((run) => {
                const rb = run.files.reduce((s, f) => s + f.bytes, 0);
                const w = Math.min(100, (100 * rb) / cap);
                return (
                  <div key={run.id} style={{ width: `${w}%`, minWidth: 3, display: "flex", gap: run.files.length > 40 ? 0 : 1, transition: "width 0.2s" }}>
                    {run.files.map((f) => (
                      <div key={f.id} style={{ flex: f.bytes, background: leveled && i > 0 ? "var(--c1)" : "var(--c5)", opacity: recent?.outputs.includes(f.id) ? 1 : 0.7 }} />
                    ))}
                  </div>
                );
              })}
            </div>
            <span style={{ ...mono, fontSize: 10.5, textAlign: "right", whiteSpace: "nowrap", color: over ? "var(--c4)" : "var(--muted)" }}>
              {lvl.runs.length > 1 || !leveled || i === 0 ? `${lvl.runs.length}r ` : ""}{bytes(lb)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function describe(e: CompactionEvent | null) {
  if (!e) return "No compaction yet.";
  if (e.kind === "flush") return `Flush: a memtable became a new L0 run (${bytes(e.bytesWritten)}).`;
  if (e.kind === "move") return `L${e.fromLevel} → L${e.toLevel}: trivial move, no bytes written.`;
  return `L${e.fromLevel} → L${e.toLevel}: merged ${e.inputs.length} file${e.inputs.length > 1 ? "s" : ""}, read ${bytes(e.bytesRead)}, wrote ${bytes(e.bytesWritten)}.`;
}

export function CompactionRaceDemo() {
  const [T, setT] = useState(4);
  const [stream, setStream] = useState<Stream>("insert");
  const [speed, setSpeed] = useState("medium");
  const make = (Tv = T) => ({
    rng: mulberry32(7),
    n: 0,
    racers: (["leveled", "tiered"] as const).map((s): Racer => ({ tree: new LsmTree(raceOptions(s, Tv)), last: null, lastAt: 0 })),
  });
  const st = useRef<ReturnType<typeof make> | null>(null);
  if (!st.current) st.current = make();
  const [tick, setTick] = useState(0);
  const step = () => {
    const s = st.current!;
    if (s.n >= MAX_WRITES) { sim.pause(); return; }
    for (let i = 0; i < SPEED[speed]!; i++) {
      const [k, v] = nextWrite(s.rng, stream);
      for (const r of s.racers) {
        const before = r.tree.events.length ? r.tree.events[r.tree.events.length - 1] : null;
        r.tree.put(k, v);
        const after = r.tree.events[r.tree.events.length - 1] ?? null;
        if (after && after !== before && after.kind !== "flush") { r.last = after; r.lastAt = s.n; }
      }
      s.n++;
    }
    setTick((x) => x + 1);
  };
  const sim = useSim({ dt: 1 / 20, autoplay: true, step, reset: () => { st.current = make(); setTick(0); } });
  const restart = (Tv: number) => { st.current = make(Tv); setTick(0); sim.play(); };
  const s = st.current;
  void tick;
  return (
    <Demo
      title="The same writes into a leveled and a tiered tree"
      actions={<SimButtons sim={sim} />}
      controls={
        <>
          <Param spec={range({ label: "Size ratio T", min: 2, max: 10, step: 1, default: 4 })} value={T} onChange={(v) => { setT(v as number); restart(v as number); }} />
          <Param spec={seg<Stream>("Writes", [["insert", "new keys"], ["update", "updates to 2,000 keys"]], "insert")} value={stream} onChange={(v) => { setStream(v as Stream); st.current = make(); setTick(0); sim.play(); }} />
          <Param spec={seg("Speed", [["slow", "slow"], ["medium", "medium"], ["fast", "fast"]], "medium")} value={speed} onChange={(v) => setSpeed(v as string)} />
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        {s.n.toLocaleString()} writes of 40 bytes ({bytes(s.n * 40)}). Each bar is a level, filled to its budget; each block is a file. Purple: runs that may overlap. Blue: one sorted run.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
        {s.racers.map((r) => {
          const t = r.tree;
          return (
            <div key={t.opts.strategy} style={{ flex: "1 1 290px", minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>{t.opts.strategy === "leveled" ? "Leveled (RocksDB default)" : "Tiered (size-tiered / universal)"}</div>
              <LevelView r={r} T={T} now={s.n} />
              <p className="muted" style={{ fontSize: 12, margin: "6px 0 0", minHeight: 34 }}>{describe(r.last)}</p>
              <Stats
                items={[
                  { label: "write amp", value: fx(t.writeAmp(), 2) },
                  { label: "sorted runs", value: t.sortedRuns() },
                  { label: "space amp", value: fx(t.spaceAmp(), 2) },
                  { label: "bytes written", value: bytes(t.stats.flushBytes + t.stats.compactWriteBytes) },
                ]}
              />
            </div>
          );
        })}
      </div>
      <Note>Write amp counts flush and compaction bytes per user byte (not the WAL). Sorted runs = places a point lookup may check. Space amp = stored bytes per live byte.</Note>
    </Demo>
  );
}

// ================= WA vs T =================

type Metric = "wa" | "runs" | "sa";

export function WaVsTDemo() {
  const [metric, setMetric] = useState<Metric>("wa");
  const [stream, setStream] = useState<Stream>("insert");
  const [pts, setPts] = useState<SweepPoint[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    setPts([]);
    const jobs = SWEEP_T.flatMap((T) => (["leveled", "tiered"] as const).map((s) => [s, T] as const));
    let j = 0, gen: Generator<undefined, SweepPoint> | null = null, alive = true, id = 0;
    const tick = () => {
      if (!alive) return;
      if (!gen) {
        if (j >= jobs.length) { setBusy(null); return; }
        const [s, T] = jobs[j++]!;
        setBusy(`measuring ${s}, T = ${T}`);
        gen = sweepRun(s, T, stream);
      }
      const t0 = performance.now();
      while (gen && performance.now() - t0 < 25) {
        const r = gen.next();
        if (r.done) { const p = r.value; setPts((x) => [...x, p]); gen = null; }
      }
      id = window.setTimeout(tick, 0);
    };
    id = window.setTimeout(tick, 50);
    return () => { alive = false; clearTimeout(id); };
  }, [stream]);
  const D = SWEEP_WRITES * 40;
  const cfg = (s: Strategy, T: number) => ({ strategy: s, sizeRatio: T, writeBufferBytes: RACE_MEMTABLE, l0Trigger: 4, baseLevelBytes: 4 * RACE_MEMTABLE });
  const Ts = Array.from({ length: 141 }, (_, i) => 2 + i * 0.1);
  const model = (s: Strategy) => Ts.map((T) => {
    if (metric === "wa") return [T, writeAmp(cfg(s, T), D)] as const;
    if (metric === "runs") { const L = levelCount(cfg(s, T), D); return [T, s === "leveled" ? 1 + 2 + L : 1 + (L * (T - 1)) / 2] as const; }
    return [T, s === "leveled" ? T / (T - 1) : T] as const;
  });
  const val = (p: SweepPoint) => (metric === "wa" ? p.wa : metric === "runs" ? p.runs : p.sa);
  const yMax = metric === "wa" ? 24 : metric === "runs" ? 40 : 16;
  const showModel = metric !== "sa" || stream === "update";
  const get = (s: Strategy, T: number) => pts.find((p) => p.strategy === s && p.T === T);
  return (
    <Demo
      title="Write amplification, runs and space against the size ratio"
      controls={
        <>
          <Param spec={seg<Metric>("Show", [["wa", "write amp"], ["runs", "sorted runs"], ["sa", "space amp"]], "wa")} value={metric} onChange={(v) => setMetric(v as Metric)} />
          <Param spec={seg<Stream>("Writes", [["insert", "20,000 new keys"], ["update", "20,000 updates to 2,000 keys"]], "insert")} value={stream} onChange={(v) => setStream(v as Stream)} />
        </>
      }
    >
      <Plot x={[2, 16]} y={[0, yMax]} height={270} xLabel="size ratio T" yLabel={metric === "wa" ? "bytes written per user byte" : metric === "runs" ? "sorted runs (average)" : "stored / live bytes"} xTicks={[2, 4, 6, 8, 10, 12, 14, 16]}>
        {metric === "sa" && <RuleY at={1} />}
        {showModel && <Line points={model("leveled")} color="var(--c1)" dash={metric === "sa" ? "5 4" : undefined} />}
        {showModel && <Line points={model("tiered")} color="var(--c5)" dash={metric === "sa" ? "5 4" : undefined} />}
        <Dots points={pts.filter((p) => p.strategy === "leveled").map((p) => [p.T, Math.min(yMax, val(p))] as const)} color="var(--c1)" r={4} />
        <Dots points={pts.filter((p) => p.strategy === "tiered").map((p) => [p.T, Math.min(yMax, val(p))] as const)} color="var(--c5)" r={4} />
      </Plot>
      <Legend items={[{ label: "leveled: measured (dots), model (line)", color: "var(--c1)" }, { label: "tiered: measured, model", color: "var(--c5)" }]} />
      <Stats
        items={[4, 10].flatMap((T) => (["leveled", "tiered"] as const).map((s) => ({ label: `${s}, T = ${T}`, value: get(s, T) ? fx(val(get(s, T)!), metric === "runs" ? 1 : 2) : "…" })))}
      />
      <Note>{busy ? `Running the real engine: ${busy}…` : "Each dot is the real LsmTree after 20,000 writes. "}{metric === "sa" ? " Dashed lines: worst case for updates, T/(T−1) for leveled and T for tiered." : " Lines: the closed-form model from the text."}</Note>
    </Demo>
  );
}

// ================= write stalls =================

const GiB = 2 ** 30, MiB = 2 ** 20;
export const STALL_DB = 100 * GiB;

export function StallDemo() {
  const [w, setW] = useState(20);
  const [c, setC] = useState(1000);
  const [trig, setTrig] = useState(4);
  const [buf, setBuf] = useState<"64" | "256">("64");
  const deep = deepWriteAmp(STALL_DB, 256 * MiB, 10);
  const r = useMemo(() => stallTimeline({ ...STALL_DEFAULTS, writeMiBps: w, compactionMiBps: c, l0Trigger: trig, writeBufferMiB: Number(buf), deepWriteAmp: deep }), [w, c, trig, buf, deep]);
  const l0 = r.points.map((p) => [p.t, p.l0] as const);
  const ing = r.points.map((p) => [p.t, p.ingestMiBps] as const);
  return (
    <Demo
      title="L0 files and write stalls under a steady write load"
      controls={
        <>
          <Param spec={range({ label: "Application writes (MiB/s)", min: 5, max: 80, step: 1, default: 20 })} value={w} onChange={(v) => setW(v as number)} />
          <Param spec={range({ label: "Compaction bandwidth (MiB/s)", min: 200, max: 2000, step: 50, default: 1000 })} value={c} onChange={(v) => setC(v as number)} />
          <Param spec={range({ label: "level0_file_num_compaction_trigger", min: 2, max: 12, step: 1, default: 4 })} value={trig} onChange={(v) => setTrig(v as number)} />
          <Param spec={seg<"64" | "256">("write_buffer_size", [["64", "64 MiB"], ["256", "256 MiB"]], "64")} value={buf} onChange={(v) => setBuf(v as "64" | "256")} />
        </>
      }
    >
      <Plot x={[0, 600]} y={[0, 40]} height={200} xLabel="seconds" yLabel="files in L0">
        <RuleY at={STALL_DEFAULTS.slowdownTrigger} color="var(--c2)" label="slowdown (20)" />
        <RuleY at={STALL_DEFAULTS.stopTrigger} color="var(--c4)" label="stop (36)" />
        <RuleY at={trig} label="trigger" />
        <Line points={l0} color="var(--c1)" />
      </Plot>
      <Plot x={[0, 600]} y={[0, Math.max(20, w * 1.15)]} height={140} xLabel="seconds" yLabel="accepted writes (MiB/s)">
        <Line points={ing} color="var(--c3)" />
      </Plot>
      <Stats
        items={[
          { label: "average accepted writes", value: `${fx(r.avgIngest, 1)} MiB/s` },
          { label: "time slowed down", value: pct(r.stallShare, 0) },
          { label: "time stopped", value: pct(r.stopShare, 0) },
          { label: "compaction needed below L1", value: `${fx(w * deep * 2, 0)} MiB/s` },
        ]}
      />
      <Note>A 100 GiB tree, T = 10, L1 = 256 MiB: each byte that leaves L1 is rewritten about {fx(deep, 1)} times further down. That work takes compaction bandwidth first; the rest drains L0.</Note>
    </Demo>
  );
}
