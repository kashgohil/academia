/**
 * Demos for the control hazards lesson: a loop under each branch policy (stall, predict not taken, predict taken, a
 * 2-bit predictor with a BTB) and resolve stage; and the cost of a mispredict as the pipeline gets deeper.
 */
import { useMemo } from "react";
import { Demo, Dots, Legend, Line, MiniTable, Note, Param, Plot, RuleX, Stats, StepCaption, fixed, pct, range, seg, useParams } from "../../kit";
import { makePredictor } from "../../sims/perf/cpu";
import type { BranchOptions } from "../../sims/arch/rv";
import { BRANCH_DEFAULTS, bestDepth, branchPoint, loopSource, timeSource } from "../../sims/arch/pipelining";
import { PipelineDiagram } from "./ArchViews";
import { CycleBar } from "./ArchPipeUi";

type Pol = "stall" | "not-taken" | "taken" | "dynamic";
const POLICIES: [Pol, string][] = [["stall", "Stall"], ["not-taken", "Predict not taken"], ["taken", "Predict taken"], ["dynamic", "2-bit + BTB"]];
const branchOf = (pol: Pol, resolve: "EX" | "ID"): BranchOptions =>
  pol === "dynamic" ? { resolve, predict: "dynamic", predictor: makePredictor("two-bit"), btb: true } : { resolve, predict: pol };

export function ArchPipeBranchDemo() {
  const p = useParams("ctlbranch", {
    n: range({ label: "Loop iterations", min: 1, max: 10, step: 1, default: 4 }),
    pol: seg<Pol>("Branch policy", POLICIES, "not-taken"),
    resolve: seg<"EX" | "ID">("Branch resolved in", [["EX", "EX (stage 3)"], ["ID", "ID (stage 2)"]], "EX"),
  });
  const { n, pol, resolve } = p.values;
  const r = useMemo(() => timeSource(loopSource(n), { branch: branchOf(pol, resolve) }), [n, pol, resolve]);
  const table = useMemo(() => POLICIES.map(([q, label]) => {
    const x = timeSource(loopSource(n), { branch: branchOf(q, resolve) });
    return [label, String(x.cycles), String(x.stalls.control), String(x.flushes), String(x.stalls.raw)];
  }), [n, resolve]);
  const lost = r.stalls.control;
  const cap = pol === "stall"
    ? `Fetch waits after every branch until it is resolved: ${lost} cycles lost, and nothing is squashed.`
    : `${r.mispredicts} of ${r.branches} branches went the wrong way and squashed ${r.flushes} instruction${r.flushes === 1 ? "" : "s"} (struck through).`;
  return (
    <Demo
      title="A loop branch under four policies"
      controls={<>
        <Param spec={p.schema.n} value={n} onChange={(v) => p.set("n", v as number)} />
        <Param spec={p.schema.pol} value={pol} onChange={(v) => p.set("pol", v as Pol)} />
        <Param spec={p.schema.resolve} value={resolve} onChange={(v) => p.set("resolve", v as "EX" | "ID")} />
      </>}
    >
      <StepCaption tone={lost ? "warn" : "good"} label={`${lost} lost`}>{cap}</StepCaption>
      <div style={{ marginTop: 10 }}>
        <PipelineDiagram result={r} maxRows={40} />
      </div>
      <Stats items={[
        { label: "cycles", value: String(r.cycles) },
        { label: "CPI", value: fixed(r.cpi) },
        { label: "control cycles lost", value: String(lost) },
        { label: "data stalls (branch compare)", value: String(r.stalls.raw) },
      ]} />
      <CycleBar r={r} />
      <MiniTable head={["policy", "cycles", "control lost", "squashed", "data stalls"]} rows={table} highlight={POLICIES.findIndex(([q]) => q === pol)} />
      <Note>The 2-bit predictor starts at "weakly taken" and the BTB starts empty. With the branch resolved in ID, the compare needs t1 one cycle earlier, so the addi just before it now costs a data stall.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- depth and mispredicts

export function ArchPipeDepthCostDemo() {
  const p = useParams("ctldepth", {
    miss: range({ label: "Mispredicted branches", min: 0, max: 0.2, step: 0.01, default: BRANCH_DEFAULTS.missRate, format: (v) => pct(v, 0) }),
    br: range({ label: "Branches per instruction", min: 0.05, max: 0.3, step: 0.01, default: BRANCH_DEFAULTS.branchFrac, format: (v) => pct(v, 0) }),
    lu: range({ label: "Instructions that use a load just before them", min: 0, max: 0.3, step: 0.01, default: BRANCH_DEFAULTS.loadUseFrac, format: (v) => pct(v, 0) }),
    n: range({ label: "Stages", min: 2, max: 40, step: 1, default: 5 }),
  });
  const m = { missRate: p.values.miss, branchFrac: p.values.br, loadUseFrac: p.values.lu };
  const N = 40;
  const curve = useMemo(() => Array.from({ length: N - 1 }, (_, i) => [i + 2, branchPoint(i + 2, m).psPerInst] as const), [p.values.miss, p.values.br, p.values.lu]); // eslint-disable-line react-hooks/exhaustive-deps
  const perfect = useMemo(() => Array.from({ length: N - 1 }, (_, i) => [i + 2, branchPoint(i + 2, { ...m, missRate: 0 }).psPerInst] as const), [p.values.br, p.values.lu]); // eslint-disable-line react-hooks/exhaustive-deps
  const best = bestDepth(m, N);
  const here = branchPoint(p.values.n, m);
  return (
    <Demo
      title="Deeper pipe, faster clock, dearer mispredicts"
      controls={<>
        <Param spec={p.schema.n} value={p.values.n} onChange={(v) => p.set("n", v as number)} />
        <Param spec={p.schema.miss} value={p.values.miss} onChange={(v) => p.set("miss", v as number)} />
        <Param spec={p.schema.br} value={p.values.br} onChange={(v) => p.set("br", v as number)} />
        <Param spec={p.schema.lu} value={p.values.lu} onChange={(v) => p.set("lu", v as number)} />
      </>}
    >
      <Plot x={[2, N]} y={[0, 300]} height={240} xLabel="stages" yLabel="time per instruction, ps">
        <Line points={perfect} color="var(--faint)" dash="5 4" />
        <Line points={curve} color="var(--c1)" />
        <RuleX at={best.n} label={`best: ${best.n}`} />
        <Dots points={[[here.n, here.psPerInst]]} color="var(--c4)" r={4} />
      </Plot>
      <Legend items={[{ label: "with these mispredicts", color: "var(--c1)" }, { label: "perfect prediction", color: "var(--faint)" }, { label: "the stage count on the slider", color: "var(--c4)" }]} />
      <Stats items={[
        { label: `clock at ${here.n} stages`, value: `${fixed(here.clockPs, 0)} ps` },
        { label: "mispredict penalty", value: `${fixed(here.penalty, 1)} cycles` },
        { label: "CPI", value: fixed(here.cpi) },
        { label: "time per instruction", value: `${fixed(here.psPerInst, 0)} ps` },
        { label: "best depth here", value: `${best.n} stages, ${fixed(best.psPerInst, 0)} ps` },
      ]} />
      <Note>
        Model inputs: 800 ps of logic, 40 ps per pipeline register, the branch resolved 60% of the way down the pipe, and a load-use wait of (n − 1)/4 cycles. Time per instruction = CPI × clock period.
      </Note>
    </Demo>
  );
}
