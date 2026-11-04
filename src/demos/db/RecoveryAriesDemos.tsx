/** Demos for the ARIES and checkpoint lessons. */
import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, Plot, Line, Area, Dots, RuleX, Legend, range, select, useWidth, si } from "../../kit";
import type { Db, LogRecord, Lsn } from "../../sims/db/recovery/core";
import { Recovery, pageName, type RecoveryEvent } from "../../sims/db/recovery/aries";
import { ARIES, ARIES_DEFAULT_CRASH, ariesDb, runScript, undoUnderCrashes, FUZZY, fuzzyDb, recoveryPlan } from "../../sims/db/recovery/scenarios";
import { simulateCheckpoints, PAGE_BYTES } from "../../sims/db/recovery/checkpointsim";
import { LogView, PageBox, MiniTable, Label, Note, Verdict, attRows, dptRows, mono } from "./RecoveryUi";

const seg = <T extends string>(label: string, options: [T, string][], def: T) =>
  select<T>({ label, options: options.map(([value, l]) => ({ value, label: l })), default: def, segmented: true });

// ============================================================================
// ARIES simulator
// ============================================================================

interface AriesRun { db: Db; rec: Recovery; lost: LogRecord[]; attempt: number; last: RecoveryEvent | null }

function startRun(k: number): AriesRun {
  const pre = runScript(ariesDb, ARIES, k).db;
  const db = pre.crash();
  return { db, rec: new Recovery(db), lost: pre.log.slice(pre.flushedLSN), attempt: 1, last: null };
}

const PHASES = ["analysis", "redo", "undo", "done"] as const;

export function AriesDemo() {
  const [k, setK] = useState(ARIES_DEFAULT_CRASH);
  const run = useRef<AriesRun>(startRun(ARIES_DEFAULT_CRASH));
  const [, force] = useState(0);
  const redraw = () => force((x) => x + 1);
  const r = run.current;
  const { db, rec } = r;
  const restart = (kk = k) => { run.current = startRun(kk); redraw(); };
  const step = () => { if (!rec.done) { r.last = rec.step(); redraw(); } };
  const phase = () => { if (!rec.done) { rec.finishPhase(); r.last = rec.events[rec.events.length - 1] ?? null; redraw(); } };
  const flush = () => { db.flushLog(); r.last = { phase: rec.phase, kind: "phase", text: `Log flushed: durable to LSN ${db.flushedLSN}. The CLRs written so far will survive a crash.` }; redraw(); };
  const crashAgain = () => {
    const lost = db.log.slice(db.flushedLSN);
    const d2 = db.crash();
    run.current = { db: d2, rec: new Recovery(d2), lost, attempt: r.attempt + 1, last: { phase: "analysis", kind: "start", text: `Crash during ${rec.phase}. ${lost.length} log record(s) in memory are lost. Recovery starts again from the beginning.` } };
    redraw();
  };
  const marks = new Map<Lsn, RecoveryEvent["kind"]>();
  for (const e of rec.events) if (e.phase === "redo" && e.lsn && (e.kind === "redo" || (e.kind === "skip" && e.page !== undefined))) marks.set(e.lsn, e.kind);
  const att = rec.phase === "analysis" ? rec.att.values() : db.att.values();
  const pages = Array.from({ length: db.nPages }, (_, p) => db.pool.get(p)?.page ?? db.disk[p]!);
  const diff = rec.done ? db.diffFromAcked() : [];
  const cursor = r.last?.wrote ?? r.last?.lsn;
  return (
    <Demo
      title="ARIES: crash anywhere, then step through recovery"
      actions={<button className="btn ghost" onClick={() => restart()}>Restart</button>}
      controls={<Param spec={range({ label: "Crash after history step", min: 1, max: ARIES.length, step: 1, default: ARIES_DEFAULT_CRASH })} value={k} onChange={(v) => { setK(v as number); restart(v as number); }} />}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        History: {ARIES.slice(0, k).map((s, i) => <span key={i}>{i ? " · " : ""}<span style={{ color: i === k - 1 ? "var(--fg)" : undefined }}>{s.label}</span></span>)}. <b style={{ color: "var(--c4)" }}>Crash.</b>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn primary" onClick={step} disabled={rec.done}>Step</button>
        <button className="btn" onClick={phase} disabled={rec.done}>Finish {rec.phase === "done" ? "phase" : rec.phase}</button>
        <button className="btn" onClick={flush} disabled={rec.done}>Flush log</button>
        <button className="btn" onClick={crashAgain} disabled={rec.done || rec.events.length === 0} style={{ color: "var(--c4)", borderColor: "var(--c4)" }}>Crash now</button>
        <span className="muted" style={{ fontSize: 12 }}>Recovery attempt {r.attempt}</span>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {PHASES.map((p) => (
          <div key={p} style={{ flex: 1, textAlign: "center", fontSize: 12, padding: "3px 0", borderRadius: 4, border: "1px solid var(--border)", background: rec.phase === p ? "var(--fg)" : "var(--bg)", color: rec.phase === p ? "var(--bg)" : PHASES.indexOf(p) < PHASES.indexOf(rec.phase) ? "var(--muted)" : "var(--fg)" }}>{p}</div>
        ))}
      </div>
      <p style={{ fontSize: 13, margin: "0 0 10px", minHeight: 38 }}>{r.last?.text ?? `The log has ${db.lastLSN} durable records; ${r.lost.length} record(s) were only in memory and are lost. Press Step.`}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <Label>Log. Lines join each transaction's prevLSN chain; dashed arcs are undoNextLSN.</Label>
          <LogView log={db.log} lost={r.lost} flushedLSN={db.flushedLSN} cursor={cursor} lanes
            mark={(l) => marks.has(l) ? <span style={{ fontSize: 10.5, color: marks.get(l) === "redo" ? "var(--c3)" : "var(--muted)" }}>{marks.get(l) === "redo" ? "redo" : "skip"}</span> : null} />
        </div>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
            <MiniTable title="Transaction table (ATT)" head={["txn", "status", "lastLSN"]} rows={attRows(att)} />
            <MiniTable title="Dirty page table (DPT)" head={["page", "recLSN"]} rows={dptRows([...rec.dpt].map(([page, recLSN]) => ({ page, recLSN })))} />
          </div>
          {rec.phase !== "analysis" && (
            <div style={{ fontSize: 12.5, marginBottom: 8 }}>
              <span className="muted">Redo starts at </span><b style={mono}>{rec.redoLSN || "–"}</b>
              {rec.phase === "undo" && <><span className="muted"> · ToUndo: </span><b style={mono}>{[...rec.toUndo].sort((a, b) => b - a).join(", ") || "–"}</b></>}
            </div>
          )}
          <Label>Pages now (buffer pool, else disk)</Label>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {pages.map((p) => <PageBox key={p.id} page={p} dirty={db.pool.get(p.id)?.dirty} tone={r.last?.page === p.id ? "hot" : undefined} />)}
          </div>
          <Label>Disk</Label>
          <div style={{ display: "flex", gap: 6 }}>
            {db.disk.map((p) => <PageBox key={p.id} page={p} />)}
          </div>
        </div>
      </div>
      <Stats items={[
        { label: "records read by analysis", value: rec.counts.analysed },
        { label: "redone", value: rec.counts.redone },
        { label: "redo skipped", value: rec.counts.skipped },
        { label: "CLRs written", value: rec.counts.clrs },
      ]} />
      {rec.done && (
        <Verdict ok={diff.length === 0}>
          {diff.length === 0
            ? <>The pages match the committed state: {db.acked.map((v, p) => `${pageName(p)} = ${v[0]}`).join(", ")}.</>
            : <>Mismatch: {diff.map((d) => `${pageName(d.page)} is ${d.actual}, should be ${d.expected}`).join("; ")}.</>}
        </Verdict>
      )}
    </Demo>
  );
}

// ============================================================================
// Crashes during undo: CLRs against undo logged as normal updates
// ============================================================================

export function UndoCrashDemo() {
  const [n, setN] = useState(6);
  const [crashes, setCrashes] = useState(2);
  const [mode, setMode] = useState<"clr" | "naive">("clr");
  const res = useMemo(() => undoUnderCrashes(Math.round(n), Math.round(crashes), mode), [n, crashes, mode]);
  const other = useMemo(() => undoUnderCrashes(Math.round(n), Math.round(crashes), mode === "clr" ? "naive" : "clr"), [n, crashes, mode]);
  const [ref, w] = useWidth<HTMLDivElement>();
  const rows = Array.from({ length: res.passes + 1 }, (_, p) => res.records.filter((x) => x.pass === p));
  const perRow = Math.max(...rows.map((x) => x.length), 1);
  const labelW = 54;
  const bw = Math.min(30, Math.max(6, (w - labelW - 8) / perRow - 2));
  const RH = 40;
  const pos = new Map<Lsn, { x: number; y: number }>();
  rows.forEach((rr, ri) => rr.forEach((x, i) => pos.set(x.lsn, { x: labelW + i * (bw + 2) + bw / 2, y: ri * RH + 18 })));
  const passColor = (p: number) => (p === 0 ? "var(--c1)" : ["var(--c2)", "var(--c5)", "var(--c3)", "var(--c4)", "var(--c2)"][(p - 1) % 5]!);
  return (
    <Demo
      title="Crash again and again during undo"
      controls={
        <>
          <Param spec={range({ label: "Crashes during undo", min: 0, max: 4, step: 1, default: 2 })} value={crashes} onChange={(v) => setCrashes(v as number)} />
          <Param spec={range({ label: "Updates of the loser", min: 2, max: 8, step: 1, default: 6 })} value={n} onChange={(v) => setN(v as number)} />
          <Param spec={seg("Undo writes", [["clr", "CLRs (ARIES)"], ["naive", "Normal update records"]], "clr")} value={mode} onChange={(v) => setMode(v as "clr" | "naive")} />
        </>
      }
    >
      <div ref={ref}>
        <svg width={w} height={rows.length * RH + 6} style={{ display: "block" }}>
          {rows.map((_, ri) => <text key={ri} x={0} y={ri * RH + 22} style={{ fill: "var(--muted)", fontSize: 11 }}>{ri === 0 ? "work" : ri === res.passes ? "last pass" : `pass ${ri}`}</text>)}
          {res.records.map((x) => {
            const a = pos.get(x.lsn), b = x.undoes ? pos.get(x.undoes) : undefined;
            if (!a || !b) return null;
            return <path key={`u${x.lsn}`} d={`M${a.x},${a.y - 9} C${a.x},${a.y - 22} ${b.x},${b.y + 22} ${b.x},${b.y + 9}`} fill="none" stroke={passColor(x.pass)} strokeWidth={1} opacity={0.55} />;
          })}
          {res.records.map((x) => {
            const a = pos.get(x.lsn)!;
            const fill = x.kind === "update" ? "var(--c1)" : x.kind === "end" ? "var(--fg)" : "var(--bg)";
            return (
              <g key={x.lsn}>
                <rect x={a.x - bw / 2} y={a.y - 9} width={bw} height={18} rx={3} fill={fill} stroke={x.kind === "end" ? "var(--fg)" : passColor(x.pass)} strokeWidth={1.5} />
                {bw >= 16 && <text x={a.x} y={a.y + 4} textAnchor="middle" style={{ fontSize: 9.5, fill: x.kind === "update" || x.kind === "end" ? "var(--bg)" : "var(--fg)" }}>{x.kind === "end" ? "end" : x.lsn}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      <Stats items={[
        { label: "undo actions in total", value: res.undoActions },
        { label: "log records written by recovery", value: res.records.filter((x) => x.pass > 0).length },
        { label: mode === "clr" ? "same run with normal update records" : "same run with CLRs", value: `${other.undoActions} undo actions` },
      ]} />
      <Note>Filled boxes are the loser's updates. Each outlined box is a record that undo wrote, with a line to the record that it undoes. {mode === "clr" ? "A CLR is redo-only: a later pass never undoes it. It jumps over finished work with undoNextLSN." : "A normal update record is part of the loser too, so the next pass must undo it as well."}</Note>
    </Demo>
  );
}

// ============================================================================
// Checkpoint timeline
// ============================================================================

const MiB = 1024 * 1024;

function binMax(xs: number[], bin: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < xs.length; i += bin) {
    let m = 0;
    for (let j = i; j < Math.min(xs.length, i + bin); j++) m = Math.max(m, xs[j]!);
    out.push([i, m], [Math.min(xs.length, i + bin), m]);
  }
  return out;
}

export function CheckpointTimelineDemo() {
  const [timeout, setTimeout_] = useState(300);
  const [target, setTarget] = useState(0.9);
  const [maxWal, setMaxWal] = useState(1024);
  const [crashAt, setCrashAt] = useState(1500);
  const r = useMemo(() => simulateCheckpoints({ timeoutSec: Math.round(timeout), completion: target, maxWalMiB: maxWal }), [timeout, target, maxWal]);
  const T = r.writes.length;
  const writesMB = useMemo(() => binMax(r.writes.map((x) => (x * PAGE_BYTES) / MiB), 4), [r]);
  const walMB = useMemo(() => binMax(r.wal.map((x) => x / MiB), 4), [r]);
  const rec = useMemo(() => r.recovery.filter((_, i) => i % 4 === 0).map((v, i) => [i * 4, v] as [number, number]), [r]);
  const yMax = Math.max(4, ...writesMB.map((p) => p[1]), ...walMB.map((p) => p[1])) * 1.1;
  const recMax = Math.max(1, r.maxRecoverySec) * 1.15;
  const t = Math.min(T - 1, Math.round(crashAt));
  const byTime = r.checkpoints.filter((c) => c.trigger === "time").length;
  const fpiShare = (r.totalFpi * PAGE_BYTES) / r.totalWalBytes;
  return (
    <Demo
      title="One hour of checkpoints: write I/O and recovery time"
      controls={
        <>
          <Param spec={range({ label: "checkpoint_timeout", min: 30, max: 1800, default: 300, log: true, format: (v) => `${Math.round(v)} s` })} value={timeout} onChange={(v) => setTimeout_(v as number)} />
          <Param spec={range({ label: "checkpoint_completion_target", min: 0, max: 1, step: 0.05, default: 0.9 })} value={target} onChange={(v) => setTarget(v as number)} />
          <Param spec={range({ label: "max_wal_size", min: 64, max: 16384, default: 1024, log: true, format: (v) => (v >= 1024 ? `${(v / 1024).toPrecision(3)} GiB` : `${Math.round(v)} MiB`) })} value={maxWal} onChange={(v) => setMaxWal(v as number)} />
          <Param spec={range({ label: "Crash at", min: 0, max: 3599, step: 1, default: 1500, format: (v) => `${Math.floor(v / 60)} min ${Math.round(v % 60)} s` })} value={crashAt} onChange={(v) => setCrashAt(v as number)} />
        </>
      }
    >
      <Label>Write rate (MiB/s). Vertical lines are checkpoint starts: grey by time, orange by WAL size.</Label>
      <Plot x={[0, T]} y={[0, yMax]} height={180} xLabel="time (s)" xTicks={[0, 600, 1200, 1800, 2400, 3000, 3600]}>
        <Area points={writesMB} color="var(--c1)" opacity={0.35} />
        <Line points={writesMB} color="var(--c1)" width={1.2} />
        <Line points={walMB} color="var(--c2)" width={1.2} />
        {r.checkpoints.length <= 80 && r.checkpoints.map((c, i) => <RuleX key={i} at={c.start} color={c.trigger === "time" ? "var(--faint)" : "var(--c2)"} />)}
        <RuleX at={t} color="var(--c4)" dash="none" />
      </Plot>
      <Legend items={[{ label: "data page writes by the checkpointer", color: "var(--c1)" }, { label: "WAL writes (records + full page images)", color: "var(--c2)" }]} />
      <div style={{ marginTop: 10 }}>
        <Label>Recovery time if the crash happens at time t (replay from the redo point of the last complete checkpoint)</Label>
        <Plot x={[0, T]} y={[0, recMax]} height={150} xLabel="crash time (s)" yLabel="recovery (s)" xTicks={[0, 600, 1200, 1800, 2400, 3000, 3600]}>
          <Line points={rec} color="var(--c3)" />
          <RuleX at={t} color="var(--c4)" dash="none" />
          <Dots points={[[t, r.recovery[t]!]]} color="var(--c4)" r={4} />
        </Plot>
      </div>
      <Stats items={[
        { label: "recovery after this crash", value: `${r.recovery[t]!.toFixed(1)} s` },
        { label: "worst recovery", value: `${r.maxRecoverySec.toFixed(1)} s` },
        { label: "checkpoints (time / size)", value: `${byTime} / ${r.checkpoints.length - byTime}` },
        { label: "peak page writes", value: `${si((r.peakWritePagesPerSec * PAGE_BYTES) / MiB)} MiB/s` },
        { label: "data pages written", value: `${((r.totalPageWrites * PAGE_BYTES) / 2 ** 30).toFixed(1)} GiB` },
        { label: "WAL written (full page images)", value: `${(r.totalWalBytes / 2 ** 30).toFixed(1)} GiB (${Math.round(fpiShare * 100)}%)` },
      ]} />
    </Demo>
  );
}

// ============================================================================
// Fuzzy checkpoint stepper
// ============================================================================

export function FuzzyCheckpointDemo() {
  const [k, setK] = useState(10);
  const db = useMemo(() => runScript(fuzzyDb, FUZZY, Math.round(k)).db, [k]);
  const plan = useMemo(() => recoveryPlan(db), [db]);
  const snap = db.pending ?? (() => {
    const e = [...db.log].reverse().find((r) => r.kind === "end_ckpt");
    return e && e.kind === "end_ckpt" ? { beginLSN: e.beginLSN, att: e.att, dpt: e.dpt } : null;
  })();
  const live = db.dpt();
  const oldest = live.length ? Math.min(...live.map((d) => d.recLSN)) : db.lastLSN;
  const kk = Math.round(k);
  return (
    <Demo
      title="A fuzzy checkpoint: what the snapshot captures"
      actions={
        <>
          <button className="btn" onClick={() => setK(Math.max(0, kk - 1))} disabled={kk === 0}>Back</button>
          <button className="btn primary" onClick={() => setK(Math.min(FUZZY.length, kk + 1))} disabled={kk === FUZZY.length}>Next</button>
        </>
      }
      controls={<Param spec={range({ label: "After step", min: 0, max: FUZZY.length, step: 1, default: 10 })} value={k} onChange={(v) => setK(v as number)} />}
    >
      <p style={{ fontSize: 13, margin: "0 0 10px", minHeight: 20 }}>{kk === 0 ? "Nothing has happened yet." : <>Step {kk}: <b style={{ fontWeight: 600 }}>{FUZZY[kk - 1]!.label}</b>.</>}{kk < FUZZY.length && <span className="muted"> Next: {FUZZY[kk]!.label}.</span>}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <Label>Log</Label>
          <LogView log={db.log} flushedLSN={db.flushedLSN} lanes before={false} />
        </div>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
            <MiniTable title="Live DPT (in memory)" head={["page", "recLSN"]} rows={dptRows(live)} />
            <MiniTable title={snap ? `Snapshot at begin (LSN ${snap.beginLSN})${db.pending ? ", not written yet" : ""}` : "Snapshot"} head={["page", "recLSN"]} rows={snap ? dptRows(snap.dpt) : []} empty="no checkpoint yet" />
          </div>
          <MiniTable title="Snapshot ATT" head={["txn", "status", "lastLSN"]} rows={snap ? attRows(snap.att) : []} empty="–" />
          <div style={{ display: "flex", gap: 6, margin: "10px 0 0" }}>
            {Array.from({ length: db.nPages }, (_, p) => {
              const inSnap = snap?.dpt.some((d) => d.page === p);
              const f = db.pool.get(p);
              return <PageBox key={p} page={f?.page ?? db.disk[p]!} dirty={f?.dirty} tone={inSnap ? "hot" : undefined} note={inSnap ? "in snapshot" : undefined} />;
            })}
          </div>
        </div>
      </div>
      <Label>If the power fails now</Label>
      <Stats items={[
        { label: "analysis starts at", value: <span style={mono}>LSN {plan.analysisFrom}</span> },
        { label: "redo starts at", value: <span style={mono}>{plan.redoFrom ? `LSN ${plan.redoFrom}` : "no redo"}</span> },
        { label: "records redone / skipped", value: `${plan.redone} / ${plan.skipped}` },
        { label: "checkpoint age (last LSN − oldest recLSN)", value: live.length ? db.lastLSN - oldest : 0 },
      ]} />
      <Note>The snapshot is taken at begin_checkpoint, and work continues while the checkpoint runs. Redo starts at the oldest recLSN in the snapshot, which can be before the checkpoint itself. {plan.ok ? "" : "Recovery would be wrong!"}</Note>
    </Demo>
  );
}

