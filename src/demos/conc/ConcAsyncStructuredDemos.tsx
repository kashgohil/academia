/** Demos for "structured concurrency": a task tree with one failure, and in-flight calls after client timeouts. */
import { useMemo } from "react";
import { Chip, Demo, Legend, Line, Param, Plot, RuleY, SmallLabel, Stats, fixed, pct, range, select, seg, tint, useParams } from "../../kit";
import { LEAK_DEFAULTS, REQUEST_TREE, findNode, leakRun, runTree, type Discipline, type NodeRun } from "../../sims/conc/async";
import { Gantt, type GanttMark, type GanttRow } from "../os/SchedulingGantt";

const FAILS = [
  { value: "none", label: "nothing fails", fail: null },
  { value: "cache", label: "orders cache fails at 25 ms", fail: { name: "orders cache", at: 25 } },
  { value: "user", label: "user fails at 20 ms", fail: { name: "user", at: 20 } },
  { value: "ads", label: "ads fails at 60 ms", fail: { name: "ads", at: 60 } },
] as const;

const TREE = {
  t: range({ label: "Time", min: 0, max: 130, step: 1, default: 35, format: (v) => `${v} ms` }),
  discipline: seg<Discipline>("Discipline", [["unstructured", "spawn and forget"], ["structured", "scope cancels siblings"], ["supervisor", "supervisor"]], "unstructured"),
  fail: select({ label: "Failure", options: FAILS.map((f) => ({ value: f.value, label: f.label })), default: "cache" }),
  checkMs: range({ label: "Busy work between checkpoints", min: 0, max: 30, step: 5, default: 0, format: (v) => (v ? `${v} ms` : "none: stops at once") }),
};

const STATUS_COLOR = { ok: "var(--c1)", failed: "var(--c4)", cancelled: "var(--c2)", partial: "var(--c5)" } as const;

function stateAt(n: NodeRun, t: number, rootEnd: number): { text: string; color: string } {
  if (t < n.end) return n.depth > 0 && t >= rootEnd ? { text: "orphan, running", color: "var(--c5)" } : { text: "running", color: "var(--c1)" };
  return { text: n.status === "ok" ? "done" : n.status, color: STATUS_COLOR[n.status] };
}

export function ConcAsyncTreeDemo() {
  const P = useParams("conc-async-tree", TREE);
  const { t, discipline, fail, checkMs } = P.values;
  const f = FAILS.find((x) => x.value === fail)!.fail;
  const r = useMemo(() => runTree(REQUEST_TREE, { discipline, fail: f ? { ...f } : null, checkMs }), [discipline, f, checkMs]);
  const rows: GanttRow[] = r.nodes.map((n) => {
    const own = n.depth === 0 ? n.end : Math.min(n.end, Math.max(n.start, r.rootEnd));
    const scope = !!findNode(REQUEST_TREE, n.name)?.children;
    const color = (st: keyof typeof STATUS_COLOR) => tint(STATUS_COLOR[st], scope ? 45 : 100);
    // A cancelled task ran normally until the cancel request reached it, then drained to its next checkpoint.
    const segs = n.status === "cancelled" && n.cancelAt !== undefined
      ? [{ start: n.start, end: n.cancelAt, color: color("ok") }, { start: n.cancelAt, end: own, color: color("cancelled") }]
      : [{ start: n.start, end: own, color: color(n.status) }];
    if (n.end > own) segs.push({ start: own, end: n.end, color: "var(--c5)" });
    return { label: n.name, segs };
  });
  const marks: GanttMark[] = r.nodes.flatMap((n, i) => [
    ...(n.failAt !== undefined ? [{ t: n.failAt, row: i, kind: "miss" as const }] : []),
    ...(n.cancelAt !== undefined && n.depth > 0 ? [{ t: n.cancelAt, row: i, kind: "deadline" as const }] : []),
  ]);
  return (
    <Demo
      title="A task tree with one failure"
      controls={<>
        <Param spec={TREE.t} value={t} onChange={(v) => P.set("t", v as number)} />
        <Param spec={TREE.discipline} value={discipline} onChange={(v) => P.set("discipline", v as Discipline)} />
        <Param spec={TREE.fail} value={fail} onChange={(v) => P.set("fail", v as never)} />
        <Param spec={TREE.checkMs} value={checkMs} onChange={(v) => P.set("checkMs", v as number)} />
      </>}
    >
      <Gantt rows={rows} end={130} cursor={t} marks={marks} rules={[{ t: r.rootEnd, color: "var(--fg)" }]} labelW={86} unit="ms" />
      <Legend items={[
        { label: "ran, result used", color: "var(--c1)" },
        { label: "failed", color: "var(--c4)" },
        { label: "cancelled: running to its next checkpoint", color: "var(--c2)" },
        { label: "orphan: runs after the handler returned", color: "var(--c5)" },
      ]} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {r.nodes.map((n) => {
          const s = stateAt(n, t, r.rootEnd);
          return <Chip key={n.name} color={s.color} filled={s.text.includes("running")}>{n.name}: {s.text}</Chip>;
        })}
      </div>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "handler returns at", value: `${r.rootEnd} ms (${r.rootStatus === "ok" ? "ok" : r.rootStatus})` },
          { label: "last task stops at", value: `${r.lastEnd} ms` },
          { label: "tasks alive after return", value: r.orphans },
          { label: "orphan work", value: `${r.orphanMs} ms` },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 6 }}>The dashed line is the moment the handler returns. A thin tick marks when a cancel request reaches a task.</SmallLabel>
    </Demo>
  );
}

// ---------------------------------------------------------------- leaks under timeouts

const LEAK = {
  timeout: range({ label: "Client timeout", min: 10, max: 400, step: 10, default: LEAK_DEFAULTS.timeoutMs, format: (v) => `${v} ms` }),
  p99: range({ label: "Backend p99 (median 20 ms)", min: 40, max: 2000, step: 20, default: LEAK_DEFAULTS.p99Ms, format: (v) => `${v} ms` }),
};

export function ConcAsyncLeakDemo() {
  const P = useParams("conc-async-leak", LEAK);
  const { timeout, p99 } = P.values;
  const r = useMemo(() => leakRun({ timeoutMs: timeout, p99Ms: p99 }), [timeout, p99]);
  const step = 10;
  const u = r.series.filter((_, i) => i % step === 0).map((p) => [p[0], p[1]] as [number, number]);
  const s = r.series.filter((_, i) => i % step === 0).map((p) => [p[0], p[2]] as [number, number]);
  const top = Math.max(50, r.peak.unstructured * 1.1);
  return (
    <Demo title="Backend calls in flight" controls={<><Param spec={LEAK.timeout} value={timeout} onChange={(v) => P.set("timeout", v as number)} /><Param spec={LEAK.p99} value={p99} onChange={(v) => P.set("p99", v as number)} /></>}>
      <Plot x={[0, LEAK_DEFAULTS.durationMs]} y={[0, top]} height={220} xLabel="time (ms)" yLabel="backend calls in flight">
        <RuleY at={r.mean.structured} />
        <Line points={u} color="var(--c4)" />
        <Line points={s} color="var(--c3)" />
      </Plot>
      <Legend items={[{ label: "spawn and forget: calls outlive the request", color: "var(--c4)" }, { label: "structured: cancelled at the timeout", color: "var(--c3)" }]} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "in flight, spawn and forget", value: fixed(r.mean.unstructured, 0) },
          { label: "in flight, structured", value: fixed(r.mean.structured, 0) },
          { label: "calls slower than the timeout", value: pct(r.pastTimeout) },
          { label: "peak, spawn and forget", value: r.peak.unstructured },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 6 }}>1 request per ms, 3 backend calls each, lognormal latency with a median of 20 ms. Means are over the second half of the run.</SmallLabel>
    </Demo>
  );
}
