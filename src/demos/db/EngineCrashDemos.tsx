/** Demos for "Crash testing the engine": a crash fuzzer with deliberate bugs and a coverage heatmap, and a bug replay. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, range, toggle, pct, Banner, Note, SmallLabel, mono, seg } from "../../kit";
import { BUGS, IO_KINDS, IO_CTXS, type BugId, type KvConfig } from "../../sims/db/engine/kv";
import { Campaign, shrink, replay, cellKey, findAndShrink, FUZZ_CFG, opText, type Trace, type RunResult, type TraceLine } from "../../sims/db/engine/fuzz";

const CTX_LABEL: Record<string, string> = { write: "put", read: "get", commit: "commit", abort: "abort", checkpoint: "checkpoint", redo: "redo", undo: "undo", restart: "restart" };
const KIND_LABEL: Record<string, string> = { "log.write": "log write", "log.fsync": "log fsync", "page.write": "page write", "data.fsync": "data fsync", "master.write": "master" };

export function Heatmap({ cells }: { cells: Map<string, number> }) {
  const max = Math.max(1, ...cells.values());
  return (
    <div style={{ display: "grid", gridTemplateColumns: `64px repeat(${IO_KINDS.length}, minmax(0, 1fr))`, gap: 2, fontSize: 10.5 }}>
      <span />
      {IO_KINDS.map((k) => <span key={k} className="muted" style={{ textAlign: "center", lineHeight: 1.15 }}>{KIND_LABEL[k]}</span>)}
      {IO_CTXS.map((c) => (
        <div key={c} style={{ display: "contents" }}>
          <span className="muted" style={{ whiteSpace: "nowrap", alignSelf: "center" }}>{CTX_LABEL[c]}</span>
          {IO_KINDS.map((k) => {
            const n = cells.get(cellKey(k, c)) ?? 0;
            const a = n ? 0.2 + 0.8 * (Math.log(1 + n) / Math.log(1 + max)) : 0;
            return (
              <div key={k} title={`${KIND_LABEL[k]} during ${CTX_LABEL[c]}: ${n} crash(es)`} style={{ height: 20, borderRadius: 3, border: "1px solid var(--border)", position: "relative", display: "grid", placeItems: "center", ...mono }}>
                <div style={{ position: "absolute", inset: 0, borderRadius: 2, background: "var(--c1)", opacity: a }} />
                <span style={{ position: "relative", color: a > 0.6 ? "#fff" : "var(--muted)" }}>{n || ""}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function TraceView({ lines, max = 260 }: { lines: TraceLine[]; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [lines.length]);
  return (
    <div ref={ref} style={{ border: "1px solid var(--border)", borderRadius: 6, maxHeight: max, overflowY: "auto", fontSize: 12 }}>
      {lines.length === 0 && <div className="muted" style={{ padding: 6 }}>Press Next to run the first operation.</div>}
      {lines.map((l, i) => (
        <div key={i} style={{ display: "flex", gap: 6, padding: "1px 6px", borderBottom: "1px solid var(--border)", color: l.tone === "bad" ? "var(--c4)" : l.tone === "crash" ? "var(--c2)" : l.tone === "ok" ? "var(--c3)" : l.tone === "note" ? "var(--muted)" : "var(--fg)" }}>
          <span style={{ ...mono, width: 22, flex: "none", textAlign: "right", color: "var(--muted)" }}>{l.tone ? "" : l.op + 1}</span>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{l.text}</span>
        </div>
      ))}
    </div>
  );
}

type Phase = "idle" | "fuzz" | "shrink" | "done";

export function CrashFuzzerDemo() {
  const [crashes, setCrashes] = useState(1);
  const [bugs, setBugs] = useState<Partial<Record<BugId, boolean>>>({});
  const [torn, setTorn] = useState(true);
  const [flip, setFlip] = useState(false);
  const [lost, setLost] = useState(false);
  const [guided, setGuided] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [, force] = useState(0);
  const cfg: Partial<KvConfig> = useMemo(() => ({ ...FUZZ_CFG, bugs, faults: { torn, bitflip: flip ? 0.3 : 0, lostFsync: lost ? 0.2 : 0 } }), [bugs, torn, flip, lost]);
  const camp = useRef<Campaign>(new Campaign(cfg, { crashes }, 1, guided));
  const shr = useRef<{ gen: Generator<{ tries: number; ops: number }, Trace>; tries: number; ops: number; result: Trace | null; lines: TraceLine[] } | null>(null);
  const restart = (c = cfg, n = crashes, g = guided) => { camp.current = new Campaign(c, { crashes: n }, 1, g); shr.current = null; setPhase("idle"); force((x) => x + 1); };
  useEffect(() => { restart(cfg, crashes, guided); }, [cfg, crashes, guided]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (phase !== "fuzz" && phase !== "shrink") return;
    let live = true;
    const tick = () => {
      if (!live) return;
      const c = camp.current;
      const t0 = performance.now();
      if (phase === "fuzz") {
        while (performance.now() - t0 < 25 && !c.s.firstFail) c.run(1);
        if (c.s.firstFail) {
          shr.current = { gen: shrink(c.s.firstFail.trace, c.cfg), tries: 0, ops: c.s.firstFail.trace.ops.length, result: null, lines: [] };
          setPhase("shrink");
          return;
        }
      } else {
        const s = shr.current!;
        while (performance.now() - t0 < 25) {
          const r = s.gen.next();
          if (r.done) { s.result = r.value; s.lines = replay(r.value, c.cfg, true).lines; setPhase("done"); force((n) => n + 1); return; }
          s.tries = r.value.tries; s.ops = r.value.ops;
        }
      }
      force((n) => n + 1);
      setTimeout(tick, 16);
    };
    const id = setTimeout(tick, 0);
    return () => { live = false; clearTimeout(id); };
  }, [phase]);
  const s = camp.current.s;
  const recCrashes = ["redo", "undo", "restart"].reduce((a, c) => a + IO_KINDS.reduce((b, k) => b + (s.cells.get(cellKey(k, c as never)) ?? 0), 0), 0);
  const ff = s.firstFail;
  const anyBug = BUGS.some((b) => bugs[b.id]);
  return (
    <Demo
      title="Crash fuzzer"
      actions={
        <>
          <button className="btn primary" onClick={() => setPhase(phase === "fuzz" ? "idle" : ff ? phase : "fuzz")} disabled={phase === "shrink" || phase === "done"}>{phase === "fuzz" ? "Pause" : s.runs ? "Continue" : "Run"}</button>
          <button className="btn ghost" onClick={() => restart()}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Crash points per run", min: 1, max: 3, step: 1, default: 1 })} value={crashes} onChange={(v) => setCrashes(v as number)} />
          {BUGS.map((b) => <Param key={b.id} spec={toggle({ label: `Bug: ${b.label.charAt(0).toLowerCase()}${b.label.slice(1)}`, default: false })} value={!!bugs[b.id]} onChange={(v) => setBugs({ ...bugs, [b.id]: v as boolean })} />)}
          <Param spec={toggle({ label: "Fault: torn page writes", default: true })} value={torn} onChange={(v) => setTorn(v as boolean)} />
          <Param spec={toggle({ label: "Fault: bit flips on disk", default: false })} value={flip} onChange={(v) => setFlip(v as boolean)} />
          <Param spec={toggle({ label: "Fault: fsync that lies", default: false })} value={lost} onChange={(v) => setLost(v as boolean)} />
          <Param spec={toggle({ label: "Coverage-guided crash points", default: true })} value={guided} onChange={(v) => setGuided(v as boolean)} />
        </>
      }
    >
      <p style={{ fontSize: 13, margin: "0 0 8px" }}>
        Each run: a random workload of about 60 operations from up to 3 clients, {crashes} power cut{crashes > 1 ? "s" : ""} at an I/O point (sometimes a second one inside the recovery that follows), a final power cut, then the oracle. {anyBug ? "A bug is switched on." : "The engine is correct."}
      </p>
      <Stats items={[
        { label: "runs", value: s.runs.toLocaleString("en-US") },
        { label: "crashes injected", value: s.crashes.toLocaleString("en-US") },
        { label: "of them in recovery", value: recCrashes.toLocaleString("en-US") },
        { label: "runs passed", value: s.runs ? pct(s.passed / s.runs, 1) : "–" },
        { label: "violations", value: s.violations },
        { label: "detected, stopped", value: s.detected },
      ]} />
      <SmallLabel style={{ marginTop: 10 }}>Crash-point coverage: where each power cut landed ({s.cells.size} of {IO_KINDS.length * IO_CTXS.length} cells)</SmallLabel>
      <Heatmap cells={s.cells} />
      {ff && (
        <>
          <Banner ok={false}>
            <b>Run {ff.run} fails.</b> {ff.result.violations[0]?.text ?? ff.result.detected}
          </Banner>
          {phase === "shrink" && <p style={{ fontSize: 13 }}>Shrinking: {shr.current?.tries ?? 0} replays, the trace is down to {shr.current?.ops ?? 0} operations…</p>}
          {phase === "done" && shr.current?.result && (
            <>
              <SmallLabel>Minimal reproducing trace: {shr.current.result.ops.length} operations (from {ff.trace.ops.length}), {shr.current.tries} replays</SmallLabel>
              <TraceView lines={shr.current.lines} />
            </>
          )}
        </>
      )}
      {!ff && s.runs > 0 && <Note>No failure so far. The oracle checks after every recovery: the state equals the first j commits with acked ≤ j ≤ attempted, no page is newer than the durable log, the tree is valid, and every read saw its snapshot.</Note>}
    </Demo>
  );
}

// ============================================================================
// One bug, one minimal trace, side by side with the correct engine
// ============================================================================

const FIX: Record<BugId, string> = {
  skipLogFsync: "Commit returns only after fsync(log) returns. Group commit makes that cheap; it does not make it optional.",
  pageBeforeLog: "Before a page write, flush the log up to the pageLSN of the page. The buffer pool enforces this, not the caller.",
  noChecksums: "Check the CRC-32C on every page read. A torn page then fails the check, and redo restores it from a full-page image.",
  dropClrs: "Every undo step writes a CLR. Redo repeats history, so it must also repeat the undo.",
  noFpi: "Log a full image of a page at its first change after a checkpoint, so redo can rebuild a torn page.",
};

interface Replayed { trace: Trace; run: number; bad: RunResult; good: RunResult }
const replayCache = new Map<BugId, Replayed>();

export function minimalTrace(bug: BugId): Replayed {
  const hit = replayCache.get(bug);
  if (hit) return hit;
  // For the WAL-rule bug, look for a run where the broken rule also corrupts the data.
  const cfg = { ...FUZZ_CFG, bugs: { [bug]: true } };
  const r = findAndShrink(cfg, 400, bug === "pageBeforeLog" ? ["state", "lost-ack"] : undefined)!;
  const out = { trace: r.minimal, run: r.run, bad: replay(r.minimal, cfg, true), good: replay(r.minimal, FUZZ_CFG, true) };
  replayCache.set(bug, out);
  return out;
}

export function BugReplayDemo() {
  const [bug, setBug] = useState<BugId>("pageBeforeLog");
  const [step, setStep] = useState(0);
  const [m, setM] = useState<Replayed | null>(() => replayCache.get("pageBeforeLog") ?? null);
  useEffect(() => {
    if (m && replayCache.get(bug) === m) return;
    setM(replayCache.get(bug) ?? null);
    const id = setTimeout(() => setM(minimalTrace(bug)), 0); // the search and shrink run outside render
    return () => clearTimeout(id);
  }, [bug]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m || replayCache.get(bug) !== m) return <Demo title="Replay a minimal trace with and without the bug"><p className="muted" style={{ fontSize: 13 }}>The fuzzer is searching and shrinking…</p></Demo>;
  const { bad, good } = m;
  const n = m.trace.ops.length;
  const crashOps = [...new Set(m.trace.crashes.map((c) => c.op + 1))];
  const upTo = (r: RunResult) => r.lines.filter((l) => l.op < step || (step >= n && l.op >= n));
  const info = BUGS.find((b) => b.id === bug)!;
  return (
    <Demo
      title="Replay a minimal trace with and without the bug"
      actions={
        <>
          <button className="btn" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>Back</button>
          <button className="btn primary" onClick={() => setStep(Math.min(n + 1, step + 1))} disabled={step > n}>{step < n ? `Next: ${opText(m.trace.ops[step]!)}` : step === n ? "Next: final crash and oracle" : "Done"}</button>
          <button className="btn ghost" onClick={() => setStep(0)}>Reset</button>
        </>
      }
      controls={<Param spec={seg<BugId>("Bug", BUGS.map((b) => [b.id, b.label] as [BugId, string]), "pageBeforeLog")} value={bug} onChange={(v) => { setBug(v as BugId); setStep(0); }} />}
    >
      <p style={{ fontSize: 13, margin: "0 0 8px" }}>
        <b>The bug:</b> {info.what}. The fuzzer found it in run {m.run} and shrank it to {n} operations{crashOps.length ? ` with ${m.trace.crashes.length > 1 ? `${m.trace.crashes.length} power cuts` : "a power cut"} inside operation ${crashOps.join(" and ")}` : ""}.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <SmallLabel>With the bug</SmallLabel>
          <TraceView lines={upTo(bad)} max={300} />
        </div>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <SmallLabel>The correct engine, same trace</SmallLabel>
          <TraceView lines={upTo(good)} max={300} />
        </div>
      </div>
      {step > n && (
        <Banner ok={false}><b>Fix:</b> {FIX[bug]}</Banner>
      )}
      <Note>Crash points are I/O points: write() or fsync() of the log, a page write, the data-file fsync, the master record. The power cut keeps a random prefix of unsynced log records and each unsynced page write with probability 1/2.</Note>
    </Demo>
  );
}
