/**
 * Shared views for the concurrency track. ThreadTimeline draws a Runtime result (src/sims/conc) on the shared
 * scheduling Gantt chart: one row per thread, or one row per core.
 */
import { useId } from "react";
import { Legend, tint } from "../../kit";
import type { RunResult } from "../../sims/conc";
import { Gantt, jobColor, type GanttMark, type GanttRow } from "../os/SchedulingGantt";

/** The color of a thread: the scheduling track's job colors, by thread id. */
export const threadColor = (tid: number) => jobColor(tid);

/** A readable time unit for a span of ns: the factor to divide by, and its name. */
export function timeUnit(spanNs: number): { div: number; unit: string } {
  if (spanNs < 10_000) return { div: 1, unit: "ns" };
  if (spanNs < 10_000_000) return { div: 1_000, unit: "µs" };
  return { div: 1_000_000, unit: "ms" };
}

export interface TimelineOptions {
  /** Divide times by this (1_000 for µs). */
  div?: number;
  /** Write span labels (work labels by thread, thread names by core) where they fit. */
  labels?: boolean;
  /** The fill of spin time for a thread. Default: a lighter tint of its color. */
  spinFill?: (tid: number) => string;
}

/**
 * Gantt rows for a Runtime result. By thread: running is solid in the thread's color, spinning is a lighter fill,
 * runnable is a faint tint, blocked is a thin line, sleeping a fainter thin line. By core: the running thread's
 * color, spin time in the lighter fill, switch time grey. Threads stuck in a deadlock stay blocked to the chart's end.
 * It needs `record: true`.
 */
export function timelineRows(result: RunResult, by: "thread" | "core", opts: TimelineOptions = {}): GanttRow[] {
  const div = opts.div ?? 1, labels = opts.labels ?? true;
  const spinFill = opts.spinFill ?? ((tid: number) => tint(threadColor(tid), 50));
  const name = (tid: number) => result.threads[tid]?.name ?? `T${tid}`;
  const t = (ns: number) => ns / div;
  if (by === "core") {
    return result.cores.map((c) => {
      // Back-to-back run spans of one thread (work with different labels) become one segment.
      const spans: { start: number; end: number; tid: number; kind: string }[] = [];
      for (const s of result.spans) {
        if (s.core !== c.core) continue;
        const last = spans[spans.length - 1];
        if (last && s.kind === "run" && last.kind === "run" && last.tid === s.tid && last.end === s.start) last.end = s.end;
        else spans.push({ start: s.start, end: s.end, tid: s.tid, kind: s.kind });
      }
      return {
        label: `core ${c.core}`,
        segs: spans.map((s) => ({
          start: t(s.start),
          end: t(s.end),
          color: s.kind === "switch" ? "var(--faint)" : s.kind === "spin" ? spinFill(s.tid) : threadColor(s.tid),
          label: labels && s.kind === "run" ? name(s.tid) : undefined,
        })),
      };
    });
  }
  const stuck = new Set(result.deadlock?.blocked.map((b) => b.tid));
  return result.threads.map((th) => {
    const color = threadColor(th.tid);
    const waits = result.states.filter((s) => s.tid === th.tid && s.state !== "running").map((s) => {
      const seg = { start: t(s.start), end: t(s.end) };
      if (s.state === "spinning") return { ...seg, color: spinFill(th.tid) };
      if (s.state === "runnable") return { ...seg, color: tint(color, 22) };
      return { ...seg, color: s.state === "blocked" ? "var(--muted)" : "var(--faint)", faint: true };
    });
    const runs = result.spans.filter((s) => s.tid === th.tid && s.kind === "run").map((s) => ({
      start: t(s.start), end: t(s.end), color, label: labels && s.label !== "lock" ? s.label : undefined,
    }));
    // A deadlocked thread stays blocked forever: the line runs to the end of the chart.
    if (stuck.has(th.tid)) waits.push({ start: t(result.deadlock!.t), end: Infinity, color: "var(--muted)", faint: true });
    return { label: th.name, segs: [...waits, ...runs] };
  });
}

/** Marks for a deadlock (every stuck thread) and a panic (the thread that panicked), on thread rows. */
function failMarks(result: RunResult, div: number): GanttMark[] {
  const marks: GanttMark[] = [];
  if (result.deadlock) for (const b of result.deadlock.blocked) marks.push({ t: result.deadlock.t / div, row: b.tid, kind: "miss" });
  if (result.error && result.error.tid >= 0) marks.push({ t: result.error.t / div, row: result.error.tid, kind: "miss" });
  return marks;
}

const HATCH = 5;

/**
 * A Gantt chart of a Runtime result, by thread or by core, with a legend. Spin time is hatched in the thread's color.
 * `end` and `cursor` are in ns. `labels` (default true) writes span labels where they fit.
 */
export function ThreadTimeline({ result, by, end, cursor, labels = true }: { result: RunResult; by: "thread" | "core"; end?: number; cursor?: number; labels?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const endNs = end ?? Math.max(result.now, result.makespan, 1);
  const { div, unit } = timeUnit(endNs);
  const colors = [0, 1, 2, 3, 4].map(threadColor);
  const hatch = (tid: number) => `url(#${id}h${((tid % 5) + 5) % 5})`;
  const rows = timelineRows(result, by, { div, labels, spinFill: hatch });
  const names = by === "thread" ? result.threads.map((t) => t.name) : result.cores.map((c) => `core ${c.core}`);
  const labelW = Math.min(96, Math.max(40, 10 + 6.6 * Math.max(...names.map((n) => n.length), 0)));
  const items = [
    { label: "running", color: "var(--c1)" },
    { label: "spinning (hatched)", color: tint("var(--c1)", 50) },
    ...(by === "thread"
      ? [{ label: "runnable", color: tint("var(--c1)", 22) }, { label: "blocked", color: "var(--muted)" }, { label: "sleeping", color: "var(--faint)" }]
      : [{ label: "context switch", color: "var(--faint)" }]),
  ];
  return (
    <div>
      <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
        <defs>
          {colors.map((c, i) => (
            <pattern key={i} id={`${id}h${i}`} width={HATCH} height={HATCH} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={HATCH} height={HATCH} fill={tint(c, 30)} />
              <rect width={2} height={HATCH} fill={c} />
            </pattern>
          ))}
        </defs>
      </svg>
      <Gantt
        rows={rows}
        end={endNs / div}
        cursor={cursor === undefined ? undefined : cursor / div}
        marks={by === "thread" ? failMarks(result, div) : undefined}
        labelW={labelW}
        unit={unit}
      />
      <Legend items={items} />
    </div>
  );
}
