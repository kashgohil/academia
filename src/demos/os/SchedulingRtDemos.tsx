/** Demos for "Real-time scheduling". */
import { useEffect, useMemo, useRef, useState } from "react";
import { Demo, Stats, Controls, Plot, Line, RuleX, range, toggle, useParams, useSim, Note, SmallLabel, mono, seg, useChunked } from "../../kit";
import {
  RT_PRESETS, edfSchedulable, hyperperiod, rmAcceptance, rmBound, responseTimes, rtPreset, simulateInversion, simulateRt, utilization,
  type RtResult, type RtTask,
} from "../../sims/os/scheduling";
import { Gantt, NumCell, SmallTable, f1, f2, jobColor, type GanttMark, type GanttRow } from "./SchedulingGantt";

// ------------------------------------------------------------------------------------------------
// Timelines
// ------------------------------------------------------------------------------------------------

function UtilBar({ u, bound }: { u: number; bound: number }) {
  const max = 1.4;
  const at = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <div style={{ position: "relative", height: 44, marginBottom: 4 }}>
      <div style={{ position: "absolute", top: 14, left: 0, right: 0, height: 12, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 2 }}>
        <div style={{ width: at(u), height: "100%", background: u > 1 ? "var(--c4)" : u > bound ? "var(--c2)" : "var(--c3)", transition: "width .2s" }} />
      </div>
      <div style={{ position: "absolute", left: at(bound), top: 8, height: 24, width: 2, background: "var(--fg)" }} />
      <span style={{ position: "absolute", right: `calc(100% - ${at(bound)} + 4px)`, top: 28, fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>RM bound {f2(bound)}</span>
      <div style={{ position: "absolute", left: at(1), top: 8, height: 24, width: 2, background: "var(--fg)" }} />
      <span style={{ position: "absolute", left: `calc(${at(1)} + 4px)`, top: 28, fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>EDF bound 1</span>
      <span style={{ position: "absolute", left: 0, top: -2, fontSize: 11.5, color: "var(--fg)", ...mono }}>U = {f2(u)}</span>
    </div>
  );
}

function timeline(ts: readonly RtTask[], r: RtResult, end: number): { rows: GanttRow[]; marks: GanttMark[] } {
  const rows = ts.map((x) => ({ label: x.name, segs: r.trace.slices.filter((s) => s.job === x.id).map((s) => ({ start: s.start, end: s.end, color: jobColor(x.id) })) }));
  const rowOf = new Map(ts.map((x, i) => [x.id, i]));
  const marks: GanttMark[] = [];
  for (const rel of r.releases) if (rel.t <= end) marks.push({ t: rel.t, row: rowOf.get(rel.task)!, kind: "release" });
  for (const m of r.misses) if (m.deadline <= end) marks.push({ t: m.deadline, row: rowOf.get(m.task)!, kind: "miss" });
  return { rows, marks };
}

const NAMES = ["T1", "T2", "T3", "T4", "T5"];
const SIM_LIMIT = 420;

export function RtTimelineDemo() {
  const p = useParams("sched-rt", {
    window: range({ label: "Time shown", min: 10, max: 120, step: 5, default: 35, format: (v) => `${v} ms` }),
    preset: seg("Start from", RT_PRESETS.map((x) => [x.id, x.label] as [string, string]), "gap"),
  });
  const [edited, setEdited] = useState<{ from: string; tasks: RtTask[] } | null>(null);
  const tasks = edited && edited.from === p.values.preset ? edited.tasks : rtPreset(p.values.preset);
  const setTasks = (t: RtTask[]) => setEdited({ from: p.values.preset, tasks: t });
  const hyper = hyperperiod(tasks);
  const horizon = Math.min(hyper, SIM_LIMIT);
  const rm = useMemo(() => simulateRt(tasks, "rm", horizon), [tasks, horizon]);
  const edf = useMemo(() => simulateRt(tasks, "edf", horizon), [tasks, horizon]);
  const end = Math.min(p.values.window, horizon);
  const u = utilization(tasks);
  const b = rmBound(tasks.length);
  const rta = responseTimes(tasks);
  const rmOk = rta.every((x) => x.r !== Infinity);
  const edfOk = edfSchedulable(tasks);
  const a = timeline(tasks, rm, end), e = timeline(tasks, edf, end);
  const patch = (i: number, q: Partial<RtTask>) => setTasks(tasks.map((t, k) => (k === i ? { ...t, ...q } : t)));
  return (
    <Demo title="A periodic task set under RM and EDF" controls={<Controls params={p} />}>
      <UtilBar u={u} bound={b} />
      <SmallLabel>Rate monotonic: the shorter period always wins. A triangle is a release. A red cross is a missed deadline.</SmallLabel>
      <Gantt rows={a.rows} marks={a.marks} end={end} rowH={18} labelW={28} />
      <SmallLabel>Earliest deadline first: the nearest deadline always wins.</SmallLabel>
      <Gantt rows={e.rows} marks={e.marks} end={end} rowH={18} labelW={28} />
      <Stats items={[
        { label: `RM misses in ${f1(horizon)} ms`, value: rm.misses.length },
        { label: `EDF misses in ${f1(horizon)} ms`, value: edf.misses.length },
        { label: "RM preemptions", value: rm.preemptions },
        { label: "EDF preemptions", value: edf.preemptions },
        { label: "passes the exact RM test", value: rmOk ? "yes" : "no" },
        { label: "passes the exact EDF test", value: edfOk ? "yes" : "no" },
      ]} />
      <div style={{ marginTop: 10 }}>
        <SmallLabel>C is the CPU time per job. T is the period, in ms. R is the response time.</SmallLabel>
        <SmallTable
          head={["Task", "C", "T", "C/T", "Worst R (RM)", ""]}
          rows={tasks.map((t, i) => {
            const r = rta.find((x) => x.task.id === t.id)!.r;
            return [
              <b key="n" style={{ color: jobColor(t.id) }}>{t.name}</b>,
              <NumCell key="c" label={`${t.name} CPU`} value={t.c} min={1} max={t.t} onChange={(v) => patch(i, { c: v })} />,
              <NumCell key="t" label={`${t.name} period`} value={t.t} min={2} max={40} onChange={(v) => patch(i, { t: v, c: Math.min(t.c, v) })} />,
              f2(t.c / t.t),
              r === Infinity ? <b key="r" style={{ color: "var(--c4)" }}>late</b> : `${f1(r)} ms`,
              <button key="x" className="btn ghost" style={{ padding: "1px 6px" }} aria-label={`Remove ${t.name}`} disabled={tasks.length <= 1} onClick={() => setTasks(tasks.filter((_, k) => k !== i))}>x</button>,
            ];
          })}
        />
        <div className="row" style={{ marginTop: 6 }}>
          <button
            className="btn"
            disabled={tasks.length >= NAMES.length}
            onClick={() => {
              const id = Math.max(-1, ...tasks.map((t) => t.id)) + 1;
              setTasks([...tasks, { id, name: NAMES[id % NAMES.length]!, c: 1, t: 10 }]);
            }}
          >
            Add a task
          </button>
          {hyper > SIM_LIMIT && <span className="muted" style={{ fontSize: 12 }}>The hyperperiod is {hyper} ms. The simulation stops at {SIM_LIMIT} ms. The exact tests are not limited.</span>}
        </div>
      </div>
    </Demo>
  );
}

// ------------------------------------------------------------------------------------------------
// RM acceptance
// ------------------------------------------------------------------------------------------------

const US = Array.from({ length: 21 }, (_, i) => 0.6 + i * 0.02);

export function RmAcceptanceDemo() {
  const p = useParams("sched-rmacc", { n: range({ label: "Tasks in each random set", min: 1, max: 10, step: 1, default: 5 }) });
  const n = p.values.n;
  const jobs = useMemo(() => US.map((u) => () => rmAcceptance(n, u, 300, 1)), [n]);
  const res = useChunked(`rm-${n}`, jobs);
  const pts = US.flatMap((u, i) => (res[i] === undefined ? [] : [[u, res[i]! * 100] as [number, number]]));
  return (
    <Demo title="The RM bound is safe, but pessimistic" controls={<Controls params={p} />}>
      <Plot x={[0.6, 1]} y={[0, 118]} height={210} xLabel="total utilization U" yLabel="sets that RM schedules" xTicks={[0.6, 0.7, 0.8, 0.9, 1]} xFormat={(v) => v.toFixed(1)} yFormat={(v) => `${v}%`} yTicks={[0, 25, 50, 75, 100]}>
        <Line points={pts} color="var(--c1)" />
        <RuleX at={Math.min(1, rmBound(n))} color="var(--c4)" label={`bound ${f2(rmBound(n))}`} />
      </Plot>
      <Note>Each point tests 300 random task sets (UUniFast utilizations, periods from 10 to 1,000 ms) with the exact response-time test. Below the bound, every set passes.</Note>
    </Demo>
  );
}

// ------------------------------------------------------------------------------------------------
// Priority inversion stepper
// ------------------------------------------------------------------------------------------------

const STATE_LABEL = { future: "not started", ready: "ready", running: "running", blocked: "blocked on mutex", done: "done" };

export function PriorityInversionDemo() {
  const p = useParams("sched-inversion", {
    medium: range({ label: "Work of the medium task M", min: 1, max: 20, step: 1, default: 8, format: (v) => `${v} ticks` }),
    inherit: toggle({ label: "Priority inheritance", default: false }),
  });
  const { medium, inherit } = p.values;
  const r = useMemo(() => simulateInversion({ inherit, mediumWork: medium }), [inherit, medium]);
  const other = useMemo(() => simulateInversion({ inherit: !inherit, mediumWork: medium }), [inherit, medium]);
  const [k, setK] = useState(0);
  const acc = useRef(0);
  const last = r.frames.length;
  const cur = Math.min(k, last);
  const loop = useSim({
    step: (dt) => {
      acc.current += dt * 3;
      if (acc.current >= 1) { acc.current -= 1; setK((x) => Math.min(last, x + 1)); }
    },
    reset: () => setK(0),
    dt: 1 / 60,
  });
  useEffect(() => { if (loop.running && cur >= last) loop.pause(); }); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = r.frames.slice(0, cur);
  const frame = cur > 0 ? r.frames[cur - 1]! : null;
  const rows: GanttRow[] = r.tasks.map((t, i) => {
    const segs: GanttRow["segs"] = [];
    for (const f of shown) {
      const add = (color: string, faint: boolean) => {
        const p = segs[segs.length - 1];
        if (p && p.color === color && !!p.faint === faint && p.end === f.t) p.end = f.t + 1;
        else segs.push(faint ? { start: f.t, end: f.t + 1, color, faint } : { start: f.t, end: f.t + 1, color });
      };
      if (f.running === i) add(f.owner === i ? "var(--c4)" : jobColor(i), false);
      else if (f.state[i] === "blocked") add("var(--c4)", true);
    }
    return { label: t.name, segs };
  });
  return (
    <Demo
      title="Three tasks and one mutex"
      actions={<><button className="btn" onClick={loop.toggle}>{loop.running ? "Pause" : "Play"}</button><button className="btn" onClick={() => setK(Math.max(0, cur - 1))} disabled={loop.running || cur === 0}>Back</button><button className="btn primary" onClick={() => setK(Math.min(last, cur + 1))} disabled={loop.running || cur >= last}>Step</button><button className="btn ghost" onClick={loop.reset}>Reset</button></>}
      controls={<Controls params={p} />}
    >
      <Gantt rows={rows} end={Math.max(r.frames.length, other.frames.length)} cursor={cur} labelW={22} unit="" />
      <SmallLabel>Red means that the task holds the mutex and runs. A thin red line means that the task is blocked on the mutex.</SmallLabel>
      <p style={{ fontSize: 13, minHeight: 36, margin: "6px 0" }}>{frame ? (frame.note || `${frame.running >= 0 ? r.tasks[frame.running]!.name : "Nothing"} runs.`) : "Press Step. L starts first, then H and M arrive."}</p>
      <SmallTable
        head={["Task", "Base priority", "Effective", "State"]}
        rows={r.tasks.map((t, i) => [
          <b key="n" style={{ color: jobColor(i) }}>{t.name}</b>,
          t.prio,
          frame ? (frame.prio[i]! > t.prio ? <b key="e" style={{ color: "var(--c4)" }}>{frame.prio[i]} (inherited)</b> : frame.prio[i]) : t.prio,
          frame ? STATE_LABEL[frame.state[i]!] : STATE_LABEL.future,
        ])}
      />
      <Stats items={[
        { label: "H blocked on the mutex", value: `${r.blocked} ticks` },
        { label: "H response time", value: `${r.hResponse} ticks` },
        { label: inherit ? "H blocked without inheritance" : "H blocked with inheritance", value: `${other.blocked} ticks` },
      ]} />
    </Demo>
  );
}

