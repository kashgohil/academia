/** Demos for "Stream processing": event-time windows with a watermark, and checkpoint barriers with a recovery. */
import { useMemo } from "react";
import {
  Banner, Chip, Demo, Dots, Legend, Line, MiniTable, Param, Plot, RuleY, SmallLabel, StepButtons, StepCaption, StepSlider,
  Stats, fixed, range, seg, useParams, useStepper, MONO,
} from "../../kit";
import { STREAM_DEFAULTS, runStream, streamEvents, winKey, type WindowKind } from "../../sims/dist/data-systems/stream";
import { CK_DEFAULTS, runCheckpoint } from "../../sims/dist/data-systems/checkpoint";

// ============================================================================ 1. Event time, watermarks and late data

const WM = {
  delay: range({ label: "Watermark delay (bounded out-of-orderness)", min: 0, max: 2500, step: 50, default: 200, format: (v) => `${v} ms` }),
  lateness: range({ label: "Allowed lateness", min: 0, max: 2000, step: 100, default: 0, format: (v) => `${v} ms` }),
  kind: seg<WindowKind>("Windows", [["tumbling", "tumbling 1 s"], ["sliding", "sliding 1 s / 0.5 s"], ["session", "session, gap 300 ms"]], "tumbling"),
};

export function WatermarkDemo() {
  const P = useParams("dist-ds-wm", WM);
  const { delay, lateness, kind } = P.values;
  const events = useMemo(() => streamEvents(), []);
  const run = useMemo(() => runStream({ delay, allowedLateness: lateness, kind }, events), [events, delay, lateness, kind]);
  const dropped = new Set(run.dropped.map((e) => e.id));
  const updated = new Set(run.updatedLate.map((e) => e.id));
  const tMax = Math.max(...events.map((e) => e.arrival)) + 100;
  const yMax = STREAM_DEFAULTS.duration + 200;
  const onTime = events.filter((e) => !dropped.has(e.id) && !updated.has(e.id));
  // The watermark as a step line, clipped to the plot.
  const wmPts: [number, number][] = [];
  for (const [t, w] of run.watermarks) {
    if (!Number.isFinite(w)) continue;
    if (wmPts.length) wmPts.push([t, wmPts[wmPts.length - 1]![1]]);
    wmPts.push([t, Math.max(0, w)]);
  }
  const rows = [...run.batch.values()].sort((a, b) => a.win.start - b.win.start || a.win.key - b.win.key);
  const show = kind === "session" ? rows : rows.filter((r) => r.win.start >= 0);
  return (
    <Demo
      title="Event time, processing time and the watermark"
      controls={<>
        <Param spec={WM.delay} value={delay} onChange={(v) => P.set("delay", v as number)} />
        <Param spec={WM.lateness} value={lateness} onChange={(v) => P.set("lateness", v as number)} />
        <Param spec={WM.kind} value={kind} onChange={(v) => P.set("kind", v as WindowKind)} />
      </>}
    >
      <SmallLabel>{events.length} events from 3 sensors. Most take 20 to 80 ms; one in ten is a straggler that waits about 600 ms more (model inputs).</SmallLabel>
      <Plot x={[0, tMax]} y={[0, yMax]} height={260} xLabel="processing time: when it arrives (ms)" yLabel="event time: when it happened (ms)">
        {kind === "tumbling" && Array.from({ length: 9 }, (_, i) => <RuleY key={i} at={i * 1000} color="var(--border)" dash="2 3" />)}
        <Line points={[[0, 0], [yMax, yMax]]} color="var(--faint)" dash="3 3" width={1} />
        <Line points={wmPts} color="var(--c2)" width={1.6} />
        <Dots points={onTime.map((e) => [e.arrival, e.et] as [number, number])} color="var(--c1)" r={2.6} />
        <Dots points={run.updatedLate.map((e) => [e.arrival, e.et] as [number, number])} color="var(--c3)" r={4} />
        <Dots points={run.dropped.map((e) => [e.arrival, e.et] as [number, number])} color="var(--c4)" r={4.5} />
      </Plot>
      <Legend items={[{ label: "on time", color: "var(--c1)" }, { label: "late, result updated", color: "var(--c3)" }, { label: "late, dropped", color: "var(--c4)" }, { label: "watermark", color: "var(--c2)" }]} />
      <div style={{ marginTop: 8 }}>
        <MiniTable
          head={["window (event time)", "batch", "stream", ""]}
          rows={show.slice(0, 14).map((r) => {
            const k = winKey(r.win);
            const sv = run.stream.get(k)?.count ?? 0;
            return [`${kind === "session" ? `sensor ${r.win.key}: ` : ""}${fixed(r.win.start / 1000, 1)}–${fixed(r.win.end / 1000, 1)} s`, r.count, sv, sv === r.count ? "" : "wrong"];
          })}
          highlight={(i) => { const r = show[i]!; return (run.stream.get(winKey(r.win))?.count ?? 0) !== r.count; }}
        />
        {show.length > 14 && <SmallLabel style={{ marginTop: 4 }}>{show.length - 14} more windows not shown.</SmallLabel>}
      </div>
      <Stats items={[
        { label: "events dropped as late", value: run.dropped.length },
        { label: "windows that differ from the batch answer", value: `${run.wrong.length} of ${run.batch.size}` },
        { label: "mean wait after a window ends", value: `${fixed(run.meanLatency, 0)} ms` },
        { label: "largest disorder in this input", value: `${fixed(run.maxDisorder, 0)} ms` },
      ]} />
      <Banner tone={run.wrong.length ? "bad" : "good"}>
        {run.wrong.length
          ? `The watermark promised that no older event would come, and ${run.dropped.length || run.wrong.length} broke the promise. Raise the delay, or allow lateness so that late events update the result.`
          : delay >= run.maxDisorder
            ? `The delay covers the worst disorder (${fixed(run.maxDisorder, 0)} ms), so every result equals the batch answer. The price is a wait of ${fixed(run.meanLatency, 0)} ms after each window.`
            : `Every result equals the batch answer: ${run.updatedLate.length} late events came within the allowed lateness and updated their windows.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Barrier checkpoints

const CKP = {
  crashAt: range({ label: "C crashes at", min: 60, max: 300, step: 5, default: 100, format: (v) => `${v} ms` }),
  aligned: seg<"yes" | "no">("Barrier alignment", [["yes", "aligned (exactly-once state)"], ["no", "not aligned (at-least-once)"]], "yes"),
};

export function CheckpointBarrierDemo() {
  const P = useParams("dist-ds-ck", CKP);
  const { crashAt, aligned } = P.values;
  const run = useMemo(() => runCheckpoint({ crashAt, aligned: aligned === "yes" }), [crashAt, aligned]);
  const s = useStepper(run.frames.length, 3);
  const f = run.frames[s.i]!;
  const W = 340, H = 196;
  const node = (x: number, y: number, label: string, sub: string, color = "var(--fg)", dim = false) => (
    <g opacity={dim ? 0.35 : 1}>
      <rect x={x - 38} y={y - 20} width={76} height={40} rx={6} fill="var(--bg)" stroke={color} strokeWidth={1.5} />
      <text x={x} y={y - 3} textAnchor="middle" fontSize="12" fill="var(--fg)" fontWeight={600}>{label}</text>
      <text x={x} y={y + 12} textAnchor="middle" fontSize="10.5" fill="var(--muted)" style={{ fontFamily: MONO }}>{sub}</text>
    </g>
  );
  const chips = (items: string[], x1: number, y1: number, x2: number, y2: number) =>
    items.slice(-4).map((it, i, arr) => {
      const t = (i + 1) / (arr.length + 1);
      // oldest first: the oldest item is closest to the receiver
      const tt = 1 - t;
      const x = x1 + (x2 - x1) * tt, y = y1 + (y2 - y1) * tt;
      const bar = it.startsWith("|");
      return (
        <g key={i}>
          <rect x={x - 13} y={y - 8} width={26} height={16} rx={3} fill={bar ? "var(--c2)" : "var(--bg)"} stroke={bar ? "var(--c2)" : "var(--c1)"} />
          <text x={x} y={y + 4} textAnchor="middle" fontSize="10" fill={bar ? "var(--bg)" : "var(--fg)"} style={{ fontFamily: MONO }}>{it}</text>
        </g>
      );
    });
  const expA = CK_DEFAULTS.nA, expB = CK_DEFAULTS.nB;
  const atEnd = s.atEnd;
  return (
    <Demo
      title="Checkpoint barriers and recovery"
      controls={<>
        <Param spec={CKP.crashAt} value={crashAt} onChange={(v) => P.set("crashAt", v as number)} />
        <Param spec={CKP.aligned} value={aligned} onChange={(v) => P.set("aligned", v as "yes" | "no")} />
      </>}
    >
      <SmallLabel>Source A has {expA} records (one every 10 ms); B has {expB} (one every 28 ms). C counts the records from each and passes them to the sink.</SmallLabel>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxWidth: 520 }} role="img" aria-label="operator graph with barriers">
        <line x1={78} y1={40} x2={170} y2={98} stroke="var(--border)" strokeWidth={2} />
        <line x1={78} y1={156} x2={170} y2={98} stroke="var(--border)" strokeWidth={2} />
        <line x1={210} y1={98} x2={290} y2={98} stroke="var(--border)" strokeWidth={2} />
        {chips(f.edges.AC, 78, 40, 160, 92)}
        {chips(f.edges.BC, 78, 156, 160, 104)}
        {chips(f.edges.CK, 220, 98, 284, 98)}
        {node(40, 40, "A", `read ${f.offA}/${expA}`)}
        {node(40, 156, "B", `read ${f.offB}/${expB}`)}
        {node(170, 98, "C", `A ${f.cA}  B ${f.cB}`, f.blocked.length ? "var(--c2)" : "var(--fg)", !f.up)}
        {node(300, 98, "sink", `got ${f.sinkGot}`)}
        {f.blocked.map((b) => <text key={b} x={b === "a" ? 118 : 118} y={b === "a" ? 58 : 146} fontSize="10.5" fill="var(--c2)">blocked</text>)}
        {f.buffered > 0 && <text x={170} y={136} textAnchor="middle" fontSize="10.5" fill="var(--c2)">{f.buffered} buffered</text>}
        {!f.up && <text x={170} y={136} textAnchor="middle" fontSize="11" fill="var(--c4)">crashed</text>}
      </svg>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>complete checkpoints:</span>
        {f.completed.length ? f.completed.map((c) => <Chip key={c.id} color="var(--c3)">{`#${c.id}: A@${c.offA} B@${c.offB} C=${c.cA}/${c.cB}`}</Chip>) : <span className="muted" style={{ fontSize: 12 }}>none yet</span>}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: "wrap" }}><StepButtons s={s} /></div>
      <StepSlider s={s} />
      <StepCaption label={`${Math.round(f.t)} ms`}>{f.caption}</StepCaption>
      <Stats items={[
        { label: "final counts in C (should be 16 and 6)", value: `${run.final.cA} and ${run.final.cB}` },
        { label: "restored from", value: run.restoredFrom ? `checkpoint ${run.restoredFrom.id}` : run.cfg.crashAt === null ? "no crash" : "the start" },
        { label: "records the sink got twice", value: run.final.sinkDup },
      ]} />
      {atEnd && (
        <Banner tone={run.final.cA === expA && run.final.cB === expB ? (run.final.sinkDup ? "warn" : "good") : "bad"}>
          {run.final.cA !== expA || run.final.cB !== expB
            ? `C counted ${run.final.cA - expA + run.final.cB - expB} record more than once. Its snapshot included a record that came after the barrier, and the source replayed that record.`
            : run.final.sinkDup
              ? `C's state is exact. But the sink saw ${run.final.sinkDup} records twice: replayed output reached an outside system. That needs a transactional or idempotent sink.`
              : "C's state is exact and the sink saw each record once."}
        </Banner>
      )}
    </Demo>
  );
}
