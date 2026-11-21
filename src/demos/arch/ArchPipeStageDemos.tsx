/**
 * Demos for the five-stage pipeline lesson: step a program cycle by cycle and see what each stage and pipeline register
 * holds; and cut a fixed amount of logic into n stages to see the clock, the latency and the speedup.
 */
import { useMemo } from "react";
import { Demo, Legend, Line, Note, Param, Plot, RuleX, SectionLabel, Stats, StepCaption, fixed, range, select, tint, useParams, Dots } from "../../kit";
import { programById } from "../../sims/arch/rv";
import { clockPs, depthPoint, independent, PH_STAGES, runSource, speedupLimit, timeSource } from "../../sims/arch/pipelining";
import { PipelineDiagram } from "./ArchViews";
import { CycleBar, StageStrip } from "./ArchPipeUi";

// ---------------------------------------------------------------- cycle by cycle

const STEP_PROGRAMS = [
  { value: "ind", label: "8 independent instructions" },
  { value: "sum", label: "Sum of an array (loop)" },
  { value: "fib", label: "Fibonacci (loop)" },
];
const srcOf = (id: string) => (id === "ind" ? independent(8) : programById(id).source);

export function ArchPipeStepDemo() {
  const p = useParams("pipestep", {
    prog: select({ label: "Program", options: STEP_PROGRAMS, default: "ind" }),
  });
  const run = useMemo(() => runSource(srcOf(p.values.prog)), [p.values.prog]);
  const r = useMemo(() => timeSource(srcOf(p.values.prog)), [p.values.prog]);
  const cyc = useParams("pipestepc", { c: range({ label: "Cycle", min: 1, max: 400, step: 1, default: 1 }) });
  const cycle = Math.min(cyc.values.c, r.cycles);
  const done = r.rows.filter((x) => !x.squashed && x.cells.some((c) => c.stage === "WB" && c.cycle <= cycle)).length;
  // Show the rows around the cycle: from the oldest row that is still in the pipe.
  const active = r.rows.findIndex((x) => x.cells.some((c) => c.cycle >= cycle - 1));
  const first = Math.max(0, Math.min(active < 0 ? 0 : active - 1, r.rows.length - 12));
  const fetched = r.rows.filter((x) => x.cells[0]!.cycle <= cycle).length;
  const cap = cycle <= 4 && done === 0
    ? `Cycle ${cycle}: the pipe is filling. ${fetched} instruction${fetched === 1 ? " is" : "s are"} in flight, and none has finished.`
    : `Cycle ${cycle}: ${done} instruction${done === 1 ? " has" : "s have"} finished. Each pipeline register passes one instruction's state to the next stage at the clock edge.`;
  return (
    <Demo
      title="The pipeline, one cycle at a time"
      controls={<>
        <Param spec={{ ...cyc.schema.c, max: r.cycles, format: (v) => `${v} of ${r.cycles}` }} value={cycle} onChange={(v) => cyc.set("c", v as number)} />
        <Param spec={p.schema.prog} value={p.values.prog} onChange={(v) => { p.set("prog", v as string); cyc.set("c", 1); }} />
      </>}
    >
      <StepCaption tone={cycle === r.cycles ? "good" : "info"} label={`cycle ${cycle}`}>{cap}</StepCaption>
      <SectionLabel>The five stages in cycle {cycle}, and what each one writes into the next pipeline register</SectionLabel>
      <StageStrip result={r} trace={run.trace} cycle={cycle} />
      <SectionLabel>Pipeline diagram</SectionLabel>
      <PipelineDiagram result={r} firstRow={first} maxRows={12} cursor={cycle} />
      <Stats items={[
        { label: "instructions", value: String(r.retired) },
        { label: "cycles in all", value: String(r.cycles) },
        { label: "CPI = cycles ÷ instructions", value: fixed(r.cpi) },
        { label: "finished by this cycle", value: String(done) },
      ]} />
      <CycleBar r={r} />
    </Demo>
  );
}

// ---------------------------------------------------------------- how deep

export function ArchPipeDepthDemo() {
  const p = useParams("pipedepth", {
    n: range({ label: "Stages", min: 1, max: 30, step: 1, default: 5 }),
    latch: range({ label: "Pipeline register overhead (model input)", min: 0, max: 100, step: 5, default: 40, format: (v) => `${v} ps` }),
    imb: range({ label: "Slowest stage ÷ average stage (model input)", min: 1, max: 1.6, step: 0.05, default: 1, format: (v) => `${fixed(v)}×` }),
  });
  const m = { latchPs: p.values.latch, imbalance: p.values.imb };
  const n = p.values.n;
  const d = depthPoint(n, m);
  const lim = speedupLimit(m);
  const curve = useMemo(() => Array.from({ length: 30 }, (_, i) => [i + 1, depthPoint(i + 1, m).speedup] as const), [p.values.latch, p.values.imb]); // eslint-disable-line react-hooks/exhaustive-deps
  const ideal = [[1, 1], [30, 30]] as const;
  // the logic as n slices (the slowest drawn longer when imbalanced), each followed by a register
  const slowest = clockPs(n, m) - m.latchPs;
  const restPs = n === 1 ? 0 : (800 - slowest) / (n - 1);
  return (
    <Demo
      title="Cut 800 ps of logic into stages"
      controls={<>
        <Param spec={p.schema.n} value={n} onChange={(v) => p.set("n", v as number)} />
        <Param spec={p.schema.latch} value={p.values.latch} onChange={(v) => p.set("latch", v as number)} />
        <Param spec={p.schema.imb} value={p.values.imb} onChange={(v) => p.set("imb", v as number)} />
      </>}
    >
      <SectionLabel>One instruction's path: logic (colored) and pipeline registers (gray)</SectionLabel>
      <div style={{ display: "flex", height: 26, border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
        {Array.from({ length: n }, (_, i) => {
          const w = i === 0 ? slowest : restPs;
          return (
            <div key={i} style={{ display: "flex", flex: `${w + m.latchPs} 0 0`, minWidth: 0 }}>
              <div title={`stage ${i + 1}`} style={{ flex: `${w} 0 0`, background: tint(`var(--c${(i % 5) + 1})`, 45) }} />
              <div style={{ flex: `${m.latchPs} 0 0`, background: "var(--muted)" }} />
            </div>
          );
        })}
      </div>
      <Note>
        The clock must fit the slowest stage plus one register: {fixed(slowest, 0)} + {m.latchPs} = {fixed(d.clockPs, 0)} ps.
        {n > 1 && p.values.imb > 1 ? " Stage 1 is the slow one here: every other stage waits for it." : ""} One instruction now takes {fixed(d.latencyPs, 0)} ps from fetch to write-back, against {fixed(clockPs(1, m), 0)} ps in one stage.
      </Note>
      <Stats items={[
        { label: "clock period", value: `${fixed(d.clockPs, 0)} ps` },
        { label: "clock rate", value: `${fixed(d.ghz, 2)} GHz` },
        { label: "latency of one instruction", value: `${fixed(d.latencyPs, 0)} ps` },
        { label: "speedup over 1 stage", value: `${fixed(d.speedup)}×` },
        { label: "limit as stages → ∞", value: `${fixed(lim, 1)}×` },
      ]} />
      <Plot x={[1, 30]} y={[0, 30]} height={220} xLabel="stages" yLabel="speedup (no stalls)">
        <Line points={ideal} color="var(--faint)" dash="5 4" />
        <Line points={curve} color="var(--c1)" />
        <Dots points={[[n, d.speedup]]} color="var(--c1)" r={4} />
        <RuleX at={n} color="var(--muted)" />
      </Plot>
      <Legend items={[{ label: "this model", color: "var(--c1)" }, { label: "ideal: n stages, n times faster", color: "var(--faint)" }]} />
      <Note>
        Model inputs: 800 ps of logic, as in the P&amp;H example ({PH_STAGES.map((s) => `${s.name} ${s.ps}`).join(", ")} ps), and the register overhead and imbalance on the sliders. Stalls are not counted here.
      </Note>
    </Demo>
  );
}
