/**
 * Demos for the data hazards and forwarding lesson: a hazard lab (producer, distance, forwarding), real programs under
 * each forwarding design, and "be the compiler" on P&H's load-use example.
 */
import { useMemo } from "react";
import { Demo, MiniTable, Note, Param, SectionLabel, Stats, StepCaption, fixed, range, seg, select, useParams } from "../../kit";
import { programById, type PipelineOptions } from "../../sims/arch/rv";
import { LOAD_USE_BLOCK, runSource, timeSource } from "../../sims/arch/pipelining";
import { PipelineDiagram } from "./ArchViews";
import { CycleBar, ReorderBlock } from "./ArchPipeUi";

type Fwd = "none" | "full" | "mem";
const FWD = seg<Fwd>("Forwarding", [["none", "None"], ["full", "EX/MEM and MEM/WB → EX"], ["mem", "Also MEM/WB → MEM"]], "full");
const optsOf = (f: Fwd): PipelineOptions => (f === "none" ? { forwarding: "none" } : { forwarding: "full", memForward: f === "mem" });

const PRODUCER = { alu: "addi t0, zero, 8", load: "lw   t0, -4(sp)" } as const;
const CONSUMER = { alu: "add  t1, t0, t0", store: "sw   t0, -8(sp)", addr: "lw   t2, 0(t0)" } as const;
type Prod = keyof typeof PRODUCER;
type Cons = keyof typeof CONSUMER;

const snippet = (prod: Prod, cons: Cons, dist: number) =>
  [PRODUCER[prod], ...Array.from({ length: dist - 1 }, () => "nop"), CONSUMER[cons], "ebreak"].join("\n") + "\n";

export function ArchPipeHazardLab() {
  const p = useParams("hazlab", {
    dist: range({ label: "Distance: the user is this many instructions after the producer", min: 1, max: 4, step: 1, default: 1 }),
    prod: seg<Prod>("Producer of t0", [["alu", "ALU: addi"], ["load", "Load: lw"]], "load"),
    cons: seg<Cons>("User of t0", [["alu", "ALU input"], ["store", "Store data"], ["addr", "Load address"]], "alu"),
    fwd: FWD,
  });
  const { dist, prod, cons, fwd } = p.values;
  const opts = optsOf(fwd);
  const r = useMemo(() => timeSource(snippet(prod, cons, dist), opts), [prod, cons, dist, fwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const stalls = r.stalls.loadUse + r.stalls.raw;
  const grid = useMemo(() => (["alu", "load"] as Prod[]).map((pr) => [
    pr === "alu" ? "ALU result" : "Load result",
    ...[1, 2, 3].map((d) => {
      const s = timeSource(snippet(pr, cons, d), opts).stalls;
      return String(s.loadUse + s.raw);
    }),
  ]), [cons, fwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const why = stalls === 0
    ? dist === 1 && fwd !== "none" ? "No stall: a forwarding path delivers t0 the cycle it is needed." : "No stall: the value is in the register file (or a pipeline register) in time."
    : fwd === "none"
      ? `${stalls} stall${stalls > 1 ? "s" : ""}: with no forwarding, the user must read t0 from the register file, after the producer's WB.`
      : `${stalls} stall: a load has its value only at the end of MEM, one cycle too late for the user's EX. No path can send data back in time.`;
  return (
    <Demo
      title="Hazard lab: one producer, one user"
      controls={<>
        <Param spec={p.schema.dist} value={dist} onChange={(v) => p.set("dist", v as number)} />
        <Param spec={p.schema.prod} value={prod} onChange={(v) => p.set("prod", v as Prod)} />
        <Param spec={p.schema.cons} value={cons} onChange={(v) => p.set("cons", v as Cons)} />
        <Param spec={p.schema.fwd} value={fwd} onChange={(v) => p.set("fwd", v as Fwd)} />
      </>}
    >
      <StepCaption tone={stalls ? "warn" : "good"} label={`${stalls} stall${stalls === 1 ? "" : "s"}`}>{why}</StepCaption>
      <div style={{ marginTop: 10 }}>
        <PipelineDiagram result={r} />
      </div>
      <SectionLabel>Stall cycles for this user, by producer and distance</SectionLabel>
      <MiniTable head={["", "distance 1", "distance 2", "distance 3"]} rows={grid} highlight={prod === "alu" ? 0 : 1} />
      <Note>Each case runs on the hart and goes through the shared five-stage model. The register file writes in the first half of a cycle and reads in the second half, so WB and ID can share a cycle.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- real programs

const PROGS = ["list", "sum", "memcpy", "dot", "bubble"];

export function ArchPipeForwardProgramsDemo() {
  const p = useParams("fwdprog", {
    prog: select({ label: "Program", options: PROGS.map((id) => ({ value: id, label: programById(id).title })), default: "list" }),
    fwd: FWD,
  });
  const run = useMemo(() => runSource(programById(p.values.prog).source), [p.values.prog]);
  const all = useMemo(() => (["none", "full", "mem"] as Fwd[]).map((f) => timeSource(programById(p.values.prog).source, optsOf(f))), [p.values.prog]);
  const r = all[(["none", "full", "mem"] as Fwd[]).indexOf(p.values.fwd)]!;
  return (
    <Demo
      title="Forwarding on real programs"
      controls={<>
        <Param spec={p.schema.fwd} value={p.values.fwd} onChange={(v) => p.set("fwd", v as Fwd)} />
        <Param spec={p.schema.prog} value={p.values.prog} onChange={(v) => p.set("prog", v as string)} />
      </>}
    >
      <Note>{programById(p.values.prog).about} The hart runs {run.trace.length} instructions.</Note>
      <Stats items={[
        { label: "cycles", value: String(r.cycles) },
        { label: "CPI", value: fixed(r.cpi) },
        { label: "load-use stalls", value: String(r.stalls.loadUse) },
        { label: "other data stalls", value: String(r.stalls.raw) },
        { label: "forwards used", value: String(r.forwards.length) },
      ]} />
      <CycleBar r={r} />
      <SectionLabel>The three designs on this program</SectionLabel>
      <MiniTable
        head={["forwarding", "cycles", "CPI", "data stalls"]}
        rows={all.map((x, i) => [["none", "EX/MEM and MEM/WB → EX", "also MEM/WB → MEM"][i]!, String(x.cycles), fixed(x.cpi), String(x.stalls.loadUse + x.stalls.raw)])}
        highlight={(["none", "full", "mem"] as Fwd[]).indexOf(p.values.fwd)}
      />
      <SectionLabel>The first instructions (arrows: forwarding paths)</SectionLabel>
      <PipelineDiagram result={r} maxRows={16} />
    </Demo>
  );
}

// ---------------------------------------------------------------- be the compiler

const FULL: PipelineOptions = { forwarding: "full" };

export function ArchPipeCompilerDemo() {
  return (
    <Demo title="Be the compiler: schedule around the load-use stalls">
      <Note>Click a line, then move it. The hart runs every order and checks it against the original: same registers, same memory. The pipeline has full forwarding.</Note>
      <div style={{ marginTop: 8 }}>
        <ReorderBlock block={LOAD_USE_BLOCK} opts={FULL} />
      </div>
    </Demo>
  );
}
