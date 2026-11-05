/** Demos for "FIFO, SJF and round-robin". */
import { useMemo, useState } from "react";
import { Demo, Stats, Controls, Plot, Line, RuleX, Dots, range, useParams, Note, SmallLabel, seg } from "../../kit";
import {
  CLASSIC_PRESETS, compareClassic, equalJobs, logSpace, meanTurnaroundOfOrder, orderExtremes, preset, quantumPoint, switchOverhead,
  type ClassicPolicy, type Job,
} from "../../sims/os/scheduling";
import { Gantt, NumCell, SmallTable, cpuRow, f1, f2, jobColor } from "./SchedulingGantt";

const POLICIES: ClassicPolicy[] = ["fifo", "sjf", "stcf", "rr"];
const SHORT: Record<ClassicPolicy, string> = { fifo: "FIFO", sjf: "SJF", stcf: "STCF", rr: "RR" };
const POLICY_LONG: Record<ClassicPolicy, string> = { fifo: "first in, first out", sjf: "shortest job first", stcf: "shortest time to completion first", rr: "round-robin" };

// ------------------------------------------------------------------------------------------------
// Job editor with four Gantt charts
// ------------------------------------------------------------------------------------------------

const NAMES = "ABCDEF";

function JobEditor({ jobs, onChange }: { jobs: Job[]; onChange: (j: Job[]) => void }) {
  const patch = (i: number, p: Partial<Job>) => onChange(jobs.map((j, k) => (k === i ? { ...j, ...p } : j)));
  const setIo = (i: number, every: number, wait: number) => {
    const j = jobs[i]!;
    const next: Job = { id: j.id, name: j.name, arrival: j.arrival, burst: j.burst };
    if (every > 0) next.io = { every, wait };
    onChange(jobs.map((x, k) => (k === i ? next : x)));
  };
  return (
    <div style={{ marginTop: 10 }}>
      <SmallLabel>Jobs. Set "I/O after" to 0 for a job that never blocks. Press x to remove a job.</SmallLabel>
      <SmallTable
        head={["Job", "Arrival", "CPU", "I/O after", "I/O wait", ""]}
        rows={jobs.map((j, i) => [
          <b key="n" style={{ color: jobColor(j.id) }}>{j.name}</b>,
          <NumCell key="a" label={`${j.name} arrival`} value={j.arrival} min={0} max={200} onChange={(v) => patch(i, { arrival: v })} />,
          <NumCell key="b" label={`${j.name} CPU time`} value={j.burst} min={1} max={200} onChange={(v) => patch(i, { burst: v })} />,
          <NumCell key="e" label={`${j.name} I/O after`} value={j.io?.every ?? 0} min={0} max={100} onChange={(v) => setIo(i, v, j.io?.wait ?? 10)} />,
          <NumCell key="w" label={`${j.name} I/O wait`} value={j.io?.wait ?? 0} min={0} max={100} onChange={(v) => setIo(i, j.io?.every ?? 0, v)} />,
          <button key="x" className="btn ghost" style={{ padding: "1px 6px" }} aria-label={`Remove ${j.name}`} disabled={jobs.length <= 1} onClick={() => onChange(jobs.filter((_, k) => k !== i))}>x</button>,
        ])}
      />
      <div className="row" style={{ marginTop: 6 }}>
        <button
          className="btn"
          disabled={jobs.length >= NAMES.length}
          onClick={() => {
            const id = Math.max(-1, ...jobs.map((j) => j.id)) + 1;
            onChange([...jobs, { id, name: NAMES[id % NAMES.length]!, arrival: 0, burst: 20 }]);
          }}
        >
          Add a job
        </button>
      </div>
    </div>
  );
}

export function PolicyCompareDemo() {
  const p = useParams("sched-policies", {
    quantum: range({ label: "Round-robin quantum", min: 1, max: 40, step: 1, default: 5, format: (v) => `${v} ms` }),
    cost: range({ label: "Switch cost", min: 0, max: 5, step: 0.5, default: 0, format: (v) => `${v} ms` }),
    preset: seg("Start from", CLASSIC_PRESETS.map((x) => [x.id, x.label] as [string, string]), "convoy"),
  });
  const [edited, setEdited] = useState<{ from: string; jobs: Job[] } | null>(null);
  const jobs = edited && edited.from === p.values.preset ? edited.jobs : preset(p.values.preset);
  const r = useMemo(() => compareClassic(jobs, p.values.quantum, p.values.cost), [jobs, p.values.quantum, p.values.cost]);
  const end = Math.max(...POLICIES.map((x) => r[x].summary.end));
  const bestT = Math.min(...POLICIES.map((x) => r[x].summary.meanTurnaround));
  const bestR = Math.min(...POLICIES.map((x) => r[x].summary.meanResponse));
  const mark = (v: number, best: number) => (Math.abs(v - best) < 1e-9 ? <b>{f1(v)}</b> : f1(v));
  return (
    <Demo title="One workload, four policies" controls={<Controls params={p} />}>
      <Gantt rows={POLICIES.map((x) => cpuRow(r[x].trace, SHORT[x]))} end={end} labelW={40} />
      <SmallTable
        right
        head={["Mean, ms", "Turnaround", "Response", "Ready wait", "Done at"]}
        rows={POLICIES.map((x) => {
          const s = r[x].summary;
          return [SHORT[x], mark(s.meanTurnaround, bestT), mark(s.meanResponse, bestR), f1(s.meanDelay), f1(s.end)];
        })}
      />
      <Note>Bold marks the best value in a column. "Ready wait" is the delay from "the job is ready" to "the job runs", counted at each wake-up. {POLICIES.map((x) => `${SHORT[x]}: ${POLICY_LONG[x]}`).join(". ")}.</Note>
      <JobEditor jobs={jobs} onChange={(j) => setEdited({ from: p.values.preset, jobs: j })} />
    </Demo>
  );
}

// ------------------------------------------------------------------------------------------------
// Order of jobs: why shortest first is optimal
// ------------------------------------------------------------------------------------------------

const ORDER_JOBS: { name: string; b: number; id: number }[] = [
  { id: 0, name: "A", b: 30 }, { id: 1, name: "B", b: 10 }, { id: 2, name: "C", b: 20 }, { id: 3, name: "D", b: 5 },
];

export function SjfOrderDemo() {
  const [order, setOrder] = useState(ORDER_JOBS);
  const bursts = order.map((o) => o.b);
  const ext = useMemo(() => orderExtremes(bursts), []); // eslint-disable-line react-hooks/exhaustive-deps
  const mean = meanTurnaroundOfOrder(bursts);
  const swap = (i: number) => setOrder((o) => o.map((x, k) => (k === i ? o[i + 1]! : k === i + 1 ? o[i]! : x)));
  let t = 0;
  const segs = order.map((o) => { const s = { start: t, end: t + o.b, color: jobColor(o.id), label: o.name }; t += o.b; return s; });
  return (
    <Demo
      title="Swap two neighbors and watch the mean"
      actions={<><button className="btn" onClick={() => setOrder([...order].sort((a, b) => a.b - b.b))}>Shortest first</button><button className="btn" onClick={() => setOrder([...order].sort((a, b) => b.b - a.b))}>Longest first</button></>}
    >
      <Gantt rows={[{ label: "CPU", segs }]} end={t} rowH={30} labelW={34} />
      <div className="row" style={{ marginBottom: 8 }}>
        {order.slice(0, -1).map((o, i) => (
          <button key={i} className="btn" onClick={() => swap(i)}>Swap {o.name} and {order[i + 1]!.name}</button>
        ))}
      </div>
      <Stats items={[
        { label: "mean turnaround, this order", value: `${f1(mean)} ms` },
        { label: "best of all 24 orders", value: `${f1(ext.best)} ms` },
        { label: "worst of all 24 orders", value: `${f1(ext.worst)} ms` },
      ]} />
      <Note>Each job adds its length to the finish time of every job at or after its place. So the first job counts four times and the last job counts once.</Note>
    </Demo>
  );
}

// ------------------------------------------------------------------------------------------------
// Quantum sweep
// ------------------------------------------------------------------------------------------------

const QS = logSpace(0.1, 200, 18);
const BURST = 100;

export function QuantumSweepDemo() {
  const p = useParams("sched-quantum", {
    cost: range({ label: "Switch cost (model input)", min: 0.01, max: 5, default: 0.1, log: true, format: (v) => (v < 1 ? `${Math.round(v * 1000)} µs` : `${v} ms`) }),
    n: range({ label: "Jobs", min: 2, max: 20, step: 1, default: 10 }),
    q: range({ label: "Quantum marker", min: 0.1, max: 200, default: 10, log: true, format: (v) => `${v} ms` }),
  });
  const { cost, n, q } = p.values;
  const jobs = useMemo(() => equalJobs(n, BURST), [n]);
  const points = useMemo(() => QS.map((x) => quantumPoint(jobs, x, cost)), [jobs, cost]);
  const here = useMemo(() => quantumPoint(jobs, q, cost), [jobs, q, cost]);
  const maxR = Math.max(...points.map((x) => x.meanResponse));
  const minR = Math.max(0.05, Math.min(...points.map((x) => x.meanResponse)) * 0.7);
  const maxTh = 1000 * n / (n * BURST);
  const xTicks = [0.1, 1, 10, 100];
  return (
    <Demo title="Round-robin: response and throughput against the quantum" controls={<Controls params={p} />}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <SmallLabel>Mean response time (ms, log scale). Lower is better.</SmallLabel>
          <Plot x={[0.1, 200]} y={[minR, maxR * 1.4]} logX logY height={200} xLabel="quantum (ms)" xTicks={xTicks} xFormat={(v) => String(v)} yFormat={(v) => String(v)} yTicks={[0.1, 1, 10, 100, 1000].filter((t) => t >= minR && t <= maxR * 1.4)}>
            <Line points={points.map((x) => [x.quantum, x.meanResponse] as [number, number])} color="var(--c1)" />
            <RuleX at={q} color="var(--c4)" dash="none" />
            <Dots points={[[q, here.meanResponse]]} color="var(--c4)" r={4} />
          </Plot>
        </div>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <SmallLabel>Throughput (jobs finished per second). Higher is better.</SmallLabel>
          <Plot x={[0.1, 200]} y={[0, maxTh * 1.08]} logX height={200} xLabel="quantum (ms)" xTicks={xTicks} xFormat={(v) => String(v)}>
            <Line points={points.map((x) => [x.quantum, x.throughput] as [number, number])} color="var(--c3)" />
            <RuleX at={q} color="var(--c4)" dash="none" />
            <Dots points={[[q, here.throughput]]} color="var(--c4)" r={4} />
          </Plot>
        </div>
      </div>
      <Stats items={[
        { label: "mean response", value: `${f2(here.meanResponse)} ms` },
        { label: "throughput", value: `${f2(here.throughput)} jobs/s` },
        { label: "CPU lost to switches", value: `${f1(100 * (1 - here.useful))}%` },
        { label: "c / (q + c)", value: `${f1(100 * switchOverhead(q, cost))}%` },
        { label: "mean turnaround", value: `${Math.round(here.meanTurnaround)} ms` },
      ]} />
      <Note>Each job needs {BURST} ms of CPU, and all jobs arrive at time 0. When the quantum passes {BURST} ms, round-robin is FIFO.</Note>
    </Demo>
  );
}

