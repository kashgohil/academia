/**
 * Demos for the superscalar issue lesson: in-order dual issue on the five-stage model (which pairs issue and why the
 * others do not); be the compiler for pairing; and the issue limit of wider in-order and out-of-order cores.
 */
import { useMemo } from "react";
import { Demo, Dots, Legend, Line, MiniTable, Note, Param, Plot, SectionLabel, Stats, fixed, int, range, seg, select, useParams } from "../../kit";
import { makePredictor } from "../../sims/perf/cpu";
import { programById, srcRegs, type DynInst, type PipelineOptions, type PipelineResult } from "../../sims/arch/rv";
import { ISSUE_WORKLOADS, PAIR_BLOCK, issueModel, issueWorkloadById, runSource, timeSource } from "../../sims/arch/pipelining";
import { PipelineDiagram } from "./ArchViews";
import { CycleBar, ReorderBlock } from "./ArchPipeUi";

// ---------------------------------------------------------------- dual issue

const DUAL_PROGS = ["dot", "sum", "memcpy", "fib", "list"];
type Br = "nt" | "dyn";
const optsOf = (w: 1 | 2, br: Br): PipelineOptions => ({
  width: w, branch: br === "dyn" ? { predict: "dynamic", predictor: makePredictor("two-bit"), btb: true } : { predict: "not-taken" },
});

/** Why instruction d did not issue in the same cycle as the one before it (prev), at width 2. */
function pairNote(prev: DynInst, d: DynInst, exPrev: number, ex: number): string {
  if (ex === exPrev) return "pairs with the one above";
  const mem = (c: string) => c === "load" || c === "store";
  if (prev.cls === "branch" || prev.cls === "jump") return "a branch or jump ends the pair";
  if (prev.rd && srcRegs(d.inst).includes(prev.rd)) return `needs ${prev.cls === "load" ? "the load" : "the result"} above`;
  if (mem(prev.cls) && mem(d.cls)) return "one memory port";
  if ((prev.cls === "mul" || prev.cls === "div") && (d.cls === "mul" || d.cls === "div")) return "one multiplier";
  return "waits for an older stall";
}

export function ArchPipeDualIssueDemo() {
  const p = useParams("dual", {
    prog: select({ label: "Program", options: DUAL_PROGS.map((id) => ({ value: id, label: programById(id).title })), default: "dot" }),
    w: seg<"1" | "2">("Issue width", [["1", "1 (scalar)"], ["2", "2 (dual issue)"]], "2"),
    br: seg<Br>("Branches", [["nt", "Predict not taken"], ["dyn", "2-bit + BTB"]], "dyn"),
  });
  const W = Number(p.values.w) as 1 | 2;
  const run = useMemo(() => runSource(programById(p.values.prog).source), [p.values.prog]);
  const all = useMemo(() => ([1, 2] as const).flatMap((w) => (["nt", "dyn"] as Br[]).map((b) => timeSource(programById(p.values.prog).source, optsOf(w, b)))), [p.values.prog]);
  const r: PipelineResult = all[(W - 1) * 2 + (p.values.br === "dyn" ? 1 : 0)]!;
  const live = r.rows.filter((x) => !x.squashed);
  const exOf = (seq: number) => live.find((x) => x.seq === seq)!.cells.find((c) => c.stage === "EX")!.cycle;
  const notes = W === 2 ? live.slice(1, 13).map((row) => {
    const d = run.trace[row.seq]!, prev = run.trace[row.seq - 1]!;
    return [row.text, String(exOf(row.seq)), pairNote(prev, d, exOf(row.seq - 1), exOf(row.seq))];
  }) : [];
  const paired = W === 2 ? live.slice(1).filter((row) => exOf(row.seq) === exOf(row.seq - 1)).length : 0;
  return (
    <Demo
      title="In-order dual issue on the five-stage pipe"
      controls={<>
        <Param spec={p.schema.w} value={p.values.w} onChange={(v) => p.set("w", v as "2")} />
        <Param spec={p.schema.br} value={p.values.br} onChange={(v) => p.set("br", v as Br)} />
        <Param spec={p.schema.prog} value={p.values.prog} onChange={(v) => p.set("prog", v as string)} />
      </>}
    >
      <Stats items={[
        { label: "cycles", value: String(r.cycles) },
        { label: "IPC = instructions ÷ cycles", value: fixed(1 / r.cpi) },
        { label: "instructions that issued in a pair", value: W === 2 ? `${paired * 2} of ${r.retired}` : "–" },
        { label: "stall cycles (data, structural)", value: String(r.stalls.loadUse + r.stalls.raw + r.stalls.structural) },
      ]} />
      <CycleBar r={r} />
      <MiniTable
        head={["", "width 1", "width 2"]}
        rows={[
          ["IPC, predict not taken", fixed(1 / all[0]!.cpi), fixed(1 / all[2]!.cpi)],
          ["IPC, 2-bit + BTB", fixed(1 / all[1]!.cpi), fixed(1 / all[3]!.cpi)],
        ]}
        highlight={p.values.br === "dyn" ? 1 : 0}
      />
      <SectionLabel>Pipeline diagram (two instructions can share a column)</SectionLabel>
      <PipelineDiagram result={r} maxRows={24} />
      {W === 2 && (
        <>
          <SectionLabel>Does each instruction enter EX with the one before it?</SectionLabel>
          <MiniTable head={["instruction", "EX cycle", "why"]} rows={notes} highlight={(i) => notes[i]![2] === "pairs with the one above"} />
        </>
      )}
      <Note>Pairing rules of the shared model: the two must be independent, not both memory operations, not both mul or div, and the first must not be a branch or jump.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- be the compiler for pairs

const W2: PipelineOptions = { width: 2 };
const W1: PipelineOptions = { width: 1 };

export function ArchPipePairingDemo() {
  const p = useParams("pairing", { w: seg<"1" | "2">("Issue width", [["1", "1"], ["2", "2"]], "2") });
  return (
    <Demo
      title="Be the compiler: mix the instructions so that they pair"
      controls={<Param spec={p.schema.w} value={p.values.w} onChange={(v) => p.set("w", v as "2")} />}
    >
      <Note>Two loads cannot pair (one memory port), two muls cannot pair, and a user cannot pair with its producer. Move lines so that each cycle has one memory operation and one ALU or mul operation. The hart checks every order.</Note>
      <div style={{ marginTop: 8 }}>
        <ReorderBlock key={p.values.w} block={PAIR_BLOCK} opts={p.values.w === "2" ? W2 : W1} extra={(t) => <Note>IPC {fixed(1 / t.cpi)} for {t.retired} instructions, including the setup and the final ebreak.</Note>} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- wider: in-order against a window

const WIDTHS = [1, 2, 3, 4, 6, 8];

export function ArchPipeWidthDemo() {
  const p = useParams("width", {
    miss: range({ label: "Cache miss latency (model input)", min: 2, max: 200, step: 1, default: 40, log: true, format: (v) => `${Math.round(v)} cycles` }),
    win: range({ label: "Out-of-order window", min: 8, max: 256, step: 8, default: 64, format: (v) => `${v} instructions` }),
    wl: select({ label: "Workload", options: ISSUE_WORKLOADS.map((w) => ({ value: w.id, label: w.title })), default: "saxpy" }),
    at: seg<"1" | "2" | "4" | "8">("Width for the numbers", [["1", "1"], ["2", "2"], ["4", "4"], ["8", "8"]], "4"),
  });
  const miss = Math.round(p.values.miss);
  const run = useMemo(() => runSource(issueWorkloadById(p.values.wl).source), [p.values.wl]);
  const curves = useMemo(() => (["in-order", "window"] as const).map((mode) =>
    WIDTHS.map((w) => [w, issueModel(run.trace, { width: w, mode, window: p.values.win, missLatency: miss }).ipc] as const)), [run, p.values.win, miss]);
  const W = Number(p.values.at);
  const io = issueModel(run.trace, { width: W, mode: "in-order", missLatency: miss });
  const oo = issueModel(run.trace, { width: W, mode: "window", window: p.values.win, missLatency: miss });
  const top = Math.max(2, ...curves.flat().map((q) => q[1]));
  return (
    <Demo
      title="Wider issue: in order against an out-of-order window"
      controls={<>
        <Param spec={p.schema.miss} value={p.values.miss} onChange={(v) => p.set("miss", v as number)} />
        <Param spec={p.schema.win} value={p.values.win} onChange={(v) => p.set("win", v as number)} />
        <Param spec={p.schema.wl} value={p.values.wl} onChange={(v) => p.set("wl", v as string)} />
        <Param spec={p.schema.at} value={p.values.at} onChange={(v) => p.set("at", v as "4")} />
      </>}
    >
      <Note>{issueWorkloadById(p.values.wl).about} The hart runs {int(run.trace.length)} instructions.</Note>
      <Plot x={[1, 8]} y={[0, Math.ceil(top)]} height={220} xLabel="issue width" yLabel="IPC" xTicks={WIDTHS}>
        <Line points={[[1, 1], [8, 8]]} color="var(--faint)" dash="5 4" />
        <Line points={curves[0]!} color="var(--c4)" />
        <Line points={curves[1]!} color="var(--c1)" />
        <Dots points={curves[0]!} color="var(--c4)" r={3} />
        <Dots points={curves[1]!} color="var(--c1)" r={3} />
      </Plot>
      <Legend items={[{ label: "in order (stall on use)", color: "var(--c4)" }, { label: "out-of-order window", color: "var(--c1)" }, { label: "IPC = width", color: "var(--faint)" }]} />
      <Stats items={[
        { label: `IPC in order, width ${W}`, value: fixed(io.ipc) },
        { label: `IPC with a window, width ${W}`, value: fixed(oo.ipc) },
        { label: "loads that missed", value: String(io.misses) },
        { label: "cycles in order ÷ with a window", value: `${fixed(io.cycles / oo.cycles, 1)}×` },
      ]} />
      <Note>Model inputs: ALU 1 cycle, mul 3, load hit 2, one memory port, perfect branch prediction. A load misses the first time it touches a 64-byte line.</Note>
    </Demo>
  );
}
