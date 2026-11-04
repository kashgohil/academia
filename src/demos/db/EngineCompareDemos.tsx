/** Demos for "SQLite, LMDB and RocksDB compared": one put() in three designs, and a workload-fit chart. */
import { useMemo, useState } from "react";
import { Demo, Param, range, toggle, useSim, pct } from "../../kit";
import { putSteps, putSummary, fitAll, REAL_LABEL, PUT_DEFAULTS, MIX_DEFAULTS, type RealId, type PutStep, type Mix, type Fit } from "../../sims/db/engine/compare";
import { mono, seg, Note, Label, fmt } from "./EngineShared";

const IDS: RealId[] = ["sqlite", "lmdb", "rocksdb"];
const bytes = (v: number) => `${Math.round(v).toLocaleString("en-US")} B`;
const COLOR: Record<RealId, string> = { sqlite: "var(--c2)", lmdb: "var(--c5)", rocksdb: "var(--c1)" };
/** Ticks that each kind of step takes in the animation (an fsync waits for the device). */
const TICKS: Record<PutStep["action"], number> = { read: 1, mem: 1, write: 1, fsync: 4, unlink: 1, later: 0 };
const ICON: Record<PutStep["action"], string> = { read: "read", mem: "memory", write: "write", fsync: "fsync", unlink: "unlink", later: "later" };

/** Start tick of each step; `later` steps start after the commit returns. */
function schedule(steps: PutStep[]) {
  let t = 0;
  return steps.map((s) => { const start = t; t += TICKS[s.action]; return { start, end: t }; });
}

export function PutRaceDemo() {
  const [height, setHeight] = useState(PUT_DEFAULTS.height);
  const [value, setValue] = useState(PUT_DEFAULTS.valueBytes);
  const [mode, setMode] = useState<"wal" | "rollback">("wal");
  const [sync, setSync] = useState(false);
  const [tick, setTick] = useState(0);
  const o = { ...PUT_DEFAULTS, height, valueBytes: value, sqliteMode: mode, rocksSync: sync };
  const all = IDS.map((id) => { const steps = putSteps(id, o); return { id, steps, sched: schedule(steps), sum: putSummary(id, o) }; });
  const maxT = Math.max(...all.map((a) => a.sched[a.sched.length - 1]!.end)) + 1;
  const sim = useSim({ dt: 0.45, autoplay: true, step: () => setTick((t) => { if (t + 1 >= maxT) sim.pause(); return Math.min(maxT, t + 1); }), reset: () => setTick(0) });
  const again = () => { setTick(0); sim.play(); };
  return (
    <Demo
      title="One put() in three engines"
      actions={<><button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn ghost" onClick={again}>Replay</button></>}
      controls={
        <>
          <Param spec={range({ label: "Tree height", min: 2, max: 5, step: 1, default: 3 })} value={height} onChange={(v) => { setHeight(v as number); again(); }} />
          <Param spec={range({ label: "Value bytes", min: 10, max: 1000, step: 10, default: 100 })} value={value} onChange={(v) => { setValue(v as number); again(); }} />
          <Param spec={seg("SQLite journal", [["wal", "WAL mode"], ["rollback", "Rollback journal"]], "wal")} value={mode} onChange={(v) => { setMode(v as "wal" | "rollback"); again(); }} />
          <Param spec={toggle({ label: "RocksDB WriteOptions.sync = true", default: false })} value={sync} onChange={(v) => { setSync(v as boolean); again(); }} />
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {all.map(({ id, steps, sched, sum }) => {
          const cp = steps.findIndex((s) => s.commitPoint);
          const returned = tick >= sched[cp]!.end;
          return (
            <div key={id} style={{ flex: "1 1 180px", minWidth: 0, border: "1px solid var(--border)", borderTop: `3px solid ${COLOR[id]}`, borderRadius: 6, padding: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                <b>{REAL_LABEL[id]}{id === "sqlite" ? (mode === "wal" ? " (WAL)" : " (rollback)") : ""}</b>
                <span style={{ fontSize: 11.5, color: returned ? "var(--c3)" : "var(--muted)" }}>{returned ? "commit returned" : "waiting"}</span>
              </div>
              {steps.map((s, i) => {
                const { start, end } = sched[i]!;
                const later = s.action === "later";
                const active = !later && tick >= start && tick < end;
                const done = !later && tick >= end;
                return (
                  <div key={i} style={{ display: "flex", gap: 6, fontSize: 11.5, padding: "2px 4px", borderRadius: 4, marginBottom: 2, background: active ? "var(--subtle)" : undefined, outline: active ? `1.5px solid ${COLOR[id]}` : undefined, opacity: later ? (returned ? 0.75 : 0.35) : done || active ? 1 : 0.35 }}>
                    <span style={{ ...mono, flex: "none", width: 44, fontSize: 10.5, color: s.action === "fsync" ? "var(--c4)" : s.action === "write" ? COLOR[id] : "var(--muted)" }}>{ICON[s.action]}</span>
                    <span style={{ minWidth: 0 }}>
                      {s.text}
                      <span className="muted"> · {s.file}{s.bytes ? `, ${bytes(s.bytes)}` : ""}</span>
                      {s.commitPoint && <b style={{ color: "var(--c3)", fontWeight: 600 }}> ← commit point</b>}
                    </span>
                  </div>
                );
              })}
              <div style={{ ...mono, fontSize: 11.5, marginTop: 6, borderTop: "1px solid var(--border)", paddingTop: 4 }}>
                <div>before commit returns: {bytes(sum.commitBytes)}, {sum.commitFsyncs} fsync{sum.commitFsyncs === 1 ? "" : "s"}</div>
                <div className="muted">written later: {bytes(Math.round(sum.laterBytes))}</div>
                {!sum.durableAtCommit && <div style={{ color: "var(--c4)" }}>a power cut can lose this commit</div>}
              </div>
            </div>
          );
        })}
      </div>
      <Note>An fsync takes 4 animation ticks, every other step 1. SQLite uses synchronous = FULL and 4 KiB pages; LMDB its default sync flags. RocksDB's later bytes are its flush and compaction writes per entry, from the leveled cost model of the tuning lesson.</Note>
    </Demo>
  );
}

// ============================================================================
// Workload fit
// ============================================================================

const METRICS: { key: keyof Fit; label: string; better: "high" | "low"; f: (v: number) => string; log?: boolean }[] = [
  { key: "opsPerSec", label: "operations per second (model)", better: "high", f: (v) => fmt(v, 0), log: true },
  { key: "writeUs", label: "µs per write", better: "low", f: (v) => fmt(v, 1), log: true },
  { key: "pointIos", label: "device reads per point read", better: "low", f: (v) => fmt(v, 2) },
  { key: "rangeIos", label: "device reads per 100-row scan", better: "low", f: (v) => fmt(v, 2) },
  { key: "writeAmp", label: "bytes written per byte updated", better: "low", f: (v) => v.toFixed(1), log: true },
  { key: "spaceAmp", label: "space amplification", better: "low", f: (v) => fmt(v, 2) },
  { key: "fsyncsPerUpdate", label: "fsyncs per update", better: "low", f: (v) => fmt(v, 3) },
];

const MEM: [string, string][] = [["1", "1 GiB"], ["4", "4 GiB"], ["16", "16 GiB"]];

export function WorkloadFitDemo() {
  const [wf, setWf] = useState(MIX_DEFAULTS.writeFrac);
  const [rf, setRf] = useState(0);
  const [clients, setClients] = useState(8);
  const [batch, setBatch] = useState(1);
  const [mem, setMem] = useState("4");
  const [fsync, setFsync] = useState<Mix["fsync"]>("ssd");
  const [durable, setDurable] = useState(true);
  const m: Mix = { writeFrac: wf, rangeFrac: rf, clients, batch, memory: Number(mem) * 2 ** 30, fsync, durable };
  const fits = useMemo(() => fitAll(m), [wf, rf, clients, batch, mem, fsync, durable]); // eslint-disable-line react-hooks/exhaustive-deps
  const best = [...fits].sort((a, b) => b.opsPerSec - a.opsPerSec)[0]!;
  return (
    <Demo
      title="Which engine fits this workload?"
      controls={
        <>
          <Param spec={range({ label: "Share of writes", min: 0, max: 1, step: 0.02, default: 0.2, format: (v) => pct(v, 0) })} value={wf} onChange={(v) => setWf(v as number)} />
          <Param spec={range({ label: "Reads that are range scans", min: 0, max: 1, step: 0.05, default: 0, format: (v) => pct(v, 0) })} value={rf} onChange={(v) => setRf(v as number)} />
          <Param spec={range({ label: "Client threads", min: 1, max: 64, step: 1, default: 8 })} value={clients} onChange={(v) => setClients(v as number)} />
          <Param spec={range({ label: "Updates per transaction", min: 1, max: 100, step: 1, default: 1 })} value={batch} onChange={(v) => setBatch(v as number)} />
          <Param spec={seg("Memory", MEM, "4")} value={mem} onChange={(v) => setMem(v as string)} />
          <Param spec={seg<Mix["fsync"]>("fsync", [["ssd", "1 ms"], ["plp", "0.05 ms (PLP)"], ["hdd", "8.3 ms (HDD)"]], "ssd")} value={fsync} onChange={(v) => setFsync(v as Mix["fsync"])} />
          <Param spec={toggle({ label: "Every commit durable (fsync)", default: true })} value={durable} onChange={(v) => setDurable(v as boolean)} />
        </>
      }
    >
      <p style={{ fontSize: 13, margin: "0 0 10px" }}>
        100 million keys of 16 bytes with 100-byte values. Highest score for this mix: <b style={{ color: COLOR[best.id] }}>{REAL_LABEL[best.id]}</b>, {fmt(best.opsPerSec, 0)} operations per second.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {METRICS.map((mt) => {
          const vals = fits.map((f) => f[mt.key] as number);
          const top = mt.better === "high" ? Math.max(...vals) : Math.min(...vals);
          const max = Math.max(...vals, 1e-9);
          const w = (v: number) => (mt.log ? Math.max(2, (Math.log10(Math.max(1, v)) / Math.log10(Math.max(10, max))) * 100) : Math.max(2, (v / max) * 100));
          return (
            <div key={mt.key}>
              <Label>{mt.label} <span style={{ color: "var(--faint)" }}>({mt.better === "high" ? "higher" : "lower"} is better{mt.log ? ", log scale" : ""})</span></Label>
              {fits.map((f) => {
                const v = f[mt.key] as number;
                return (
                  <div key={f.id} style={{ display: "grid", gridTemplateColumns: "62px minmax(0, 1fr) 72px", gap: 6, alignItems: "center", fontSize: 11.5, marginBottom: 1 }}>
                    <span className="muted">{REAL_LABEL[f.id]}</span>
                    <div style={{ background: "var(--subtle)", height: 10, borderRadius: 2 }}>
                      <div style={{ width: `${w(v)}%`, height: 10, borderRadius: 2, background: COLOR[f.id], opacity: v === top ? 1 : 0.45 }} />
                    </div>
                    <span style={{ ...mono, textAlign: "right", fontWeight: v === top ? 600 : 400 }}>{mt.f(v)}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <Note>Device-time model on an NVMe SSD (400,000 random reads/s, 200,000 random writes/s, 2,000 MiB/s). B+ tree reads use the B+ tree model of the tuning lesson; LMDB writes use the copy-on-write model; RocksDB uses its default leveled shape with the same memory. SQLite and LMDB allow one writer, so each commit pays its own fsync; RocksDB groups the commits of all clients into one fsync.</Note>
    </Demo>
  );
}
