/** Demos for "concurrency vs parallelism": the same tasks on one or many cores, and thread-pool sizing. */
import { useMemo } from "react";
import { Demo, Dots, Legend, Line, Param, Plot, RuleX, Stats, Note, fixed, pct, range, seg, useChunked, useParams } from "../../kit";
import { DEFAULT_COSTS } from "../../sims/conc";
import { POOL_THREADS, poolKnee, runMix, runPool, summarizeMix, type MixParams } from "../../sims/conc/foundations";
import { ThreadTimeline } from "./ConcViews";

const ROUND_NS = 1_000_000;

const MIX = {
  tasks: range({ label: "Tasks", min: 1, max: 8, step: 1, default: 4 }),
  io: range({ label: "Time spent waiting for I/O", min: 0, max: 90, step: 10, default: 80, format: (v) => `${v}%` }),
  cores: range({ label: "Cores", min: 1, max: 8, step: 1, default: 1 }),
  mode: seg("Structure", [["sequential", "One after another"], ["threads", "One thread per task"]], "threads"),
  by: seg("Timeline rows", [["thread", "Threads"], ["core", "Cores"]], "core"),
};

export function ConcFoundMixDemo() {
  const P = useParams("conc-found-mix", MIX);
  const { tasks, io, cores, mode, by } = P.values;
  const p: MixParams = useMemo(
    () => ({ tasks, rounds: 5, computeNs: ((100 - io) / 100) * ROUND_NS, ioNs: (io / 100) * ROUND_NS, cores, mode }),
    [tasks, io, cores, mode],
  );
  const res = useMemo(() => runMix(p), [p]);
  const s = summarizeMix(p, res);
  const label = mode === "sequential" ? "concurrent: no. parallel: no" : cores > 1 && tasks > 1 ? "concurrent: yes. parallel: yes" : tasks > 1 ? "concurrent: yes. parallel: no" : "one task: nothing to overlap";
  return (
    <Demo
      title="The same tasks, structured two ways, on 1 to 8 cores"
      controls={<>
        <Param spec={MIX.tasks} value={tasks} onChange={(v) => P.set("tasks", v as number)} />
        <Param spec={MIX.io} value={io} onChange={(v) => P.set("io", v as number)} />
        <Param spec={MIX.cores} value={cores} onChange={(v) => P.set("cores", v as number)} />
        <Param spec={MIX.mode} value={mode} onChange={(v) => P.set("mode", v as never)} />
        <Param spec={MIX.by} value={by} onChange={(v) => P.set("by", v as never)} />
      </>}
    >
      <ThreadTimeline result={res} by={by} labels={false} />
      <Stats items={[
        { label: "finish time", value: `${fixed(s.makespan / 1e6, 2)} ms` },
        { label: "speedup over one after another", value: `${fixed(s.speedup, 2)}×` },
        { label: "cores busy with work", value: pct(s.utilization, 0) },
        { label: "context switches", value: `${fixed(s.switchNs / 1000, 0)} µs` },
      ]} />
      <Note>
        {label}. Each task runs 5 rounds of compute, then an I/O wait, 1 ms per round. A thread that waits leaves its core.
        A context switch costs {DEFAULT_COSTS.switchNs / 1000} µs of core time (a model input). Lower bound for this setup: {fixed(s.bound / 1e6, 2)} ms.
      </Note>
    </Demo>
  );
}

const POOL = {
  cores: range({ label: "Cores", min: 1, max: 8, step: 1, default: 4 }),
  ratio: range({ label: "Wait per job, W / C", min: 0, max: 15, step: 1, default: 4, format: (v) => `${v}` }),
};

const JOBS = 480, COMPUTE = 50_000;

export function ConcFoundPoolDemo() {
  const P = useParams("conc-found-pool", POOL);
  const { cores, ratio } = P.values;
  const jobs = useMemo(
    () => [0, ratio].flatMap((r) => POOL_THREADS.map((n) => () => runPool({ jobs: JOBS, computeNs: COMPUTE, waitNs: r * COMPUTE, cores, threads: n }))),
    [cores, ratio],
  );
  const res = useChunked(`${cores}/${ratio}`, jobs, { keep: true });
  const line = (k: number) => POOL_THREADS.flatMap((n, i) => { const r = res[k * POOL_THREADS.length + i]; return r ? [[n, r.speedup] as [number, number]] : []; });
  const cpu = line(0), mixed = line(1);
  const knee = poolKnee(cores, COMPUTE, ratio * COMPUTE);
  const best = mixed.reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0] as [number, number]);
  const atCores = mixed.find(([n]) => n === cores)?.[1];
  const yMax = Math.max(cores * 1.1, ...mixed.map((q) => q[1] * 1.08), 2);
  return (
    <Demo
      title="How many threads does a pool need?"
      controls={<>
        <Param spec={POOL.cores} value={cores} onChange={(v) => P.set("cores", v as number)} />
        <Param spec={POOL.ratio} value={ratio} onChange={(v) => P.set("ratio", v as number)} />
      </>}
    >
      <Plot x={[1, 64]} y={[0, yMax]} height={240} xLabel="threads in the pool" yLabel="speedup over one thread" xTicks={[1, 8, 16, 24, 32, 40, 48, 56, 64]}>
        <RuleX at={Math.min(knee, 64)} color="var(--c2)" label={knee <= 64 ? `P(1 + W/C) = ${fixed(knee, 0)}` : "knee > 64"} />
        <Line points={cpu} color="var(--muted)" />
        <Dots points={cpu} color="var(--muted)" r={2.5} />
        <Line points={mixed} color="var(--c1)" />
        <Dots points={mixed} color="var(--c1)" r={2.5} />
      </Plot>
      <Legend items={[{ label: `jobs with W = ${ratio} × C`, color: "var(--c1)" }, { label: "CPU-bound jobs (W = 0)", color: "var(--muted)" }]} />
      <Stats items={[
        { label: "predicted knee", value: fixed(knee, 0) },
        { label: `speedup with ${cores} thread${cores > 1 ? "s" : ""}`, value: atCores ? `${fixed(atCores, 2)}×` : "…" },
        { label: "best speedup", value: best[1] ? `${fixed(best[1], 2)}× at ${best[0]}` : "…" },
        { label: "upper limit", value: `${fixed(cores * (1 + ratio), 0)}×` },
      ]} />
      <Note>{JOBS} jobs. Each computes for 50 µs, then waits (a database call, a disk read) without a core. Every point is a Runtime run.</Note>
    </Demo>
  );
}
