/**
 * ArchRvPlayground: edit a sample program, step it on the hart, and see the listing, the registers and the bit fields
 * of the next instruction. It is the reference for how a demo uses src/sims/arch/rv and ArchViews.
 */
import { useMemo, useState } from "react";
import { Btn, ButtonRow, Demo, IndexButtons, Param, SectionLabel, StepCaption, mono, range, seg, select } from "../../kit";
import { assemble, disasm, Hart, PROGRAMS, programById, REG_ABI, type Program, type Snapshot } from "../../sims/arch/rv";
import { AsmEditor, AsmListing, BitFields, RegFile } from "./ArchViews";

/** Steps a learner can walk through; a longer run is cut here. */
const MAX_STEPS = 5000;

const PROGRAM = select({ label: "Program", options: PROGRAMS.map((p) => ({ value: p.id, label: p.title })), default: "sum" });
const SHOW = seg("Registers", [["used", "Used"], ["all", "All 32"]], "used");

/** The hart after k steps from the start. The hart is deterministic, so Back is a replay. */
function hartAt(program: Program, k: number): { hart: Hart; snap: Snapshot } {
  const hart = new Hart(program); // keep the trace on: snapshot().last needs it
  for (let i = 0; i < k && hart.step(); i++);
  return { hart, snap: hart.snapshot() };
}

function caption(s: Snapshot, h: Hart): string {
  const d = s.last;
  if (!d) return s.error ? s.error.message : "Not started. Step runs the instruction at the highlighted pc.";
  let t = `Ran ${disasm(d.inst, d.pc, { pseudo: true })} at 0x${d.pc.toString(16)}.`;
  if (s.changed.length) t += ` ${REG_ABI[s.changed[0]!]} = ${s.regs[s.changed[0]!]}.`;
  if (s.reads.length) t += ` Read ${s.reads[0]!.size} byte(s) at 0x${s.reads[0]!.addr.toString(16)}.`;
  if (s.writes.length) t += ` Wrote ${s.writes[0]!.size} byte(s) at 0x${s.writes[0]!.addr.toString(16)}.`;
  if (d.taken !== undefined && d.cls === "branch") t += d.taken ? " Branch taken." : " Branch not taken.";
  if (s.status === "exited") t += ` The program exited with code ${h.exitCode}.`;
  if (s.status === "ebreak") t += " ebreak: stopped.";
  if (s.error) t += ` ${s.error.message}.`;
  return t;
}

export function ArchRvPlayground() {
  const [id, setId] = useState("sum");
  const [source, setSource] = useState(programById("sum").source);
  const [k, setK] = useState(0);
  const [show, setShow] = useState<"used" | "all">("used");
  const asm = useMemo(() => assemble(source), [source]);
  // How many steps the program runs (capped), for the slider.
  const total = useMemo(() => {
    if (!asm.ok) return 0;
    const h = new Hart(asm.program, { trace: false });
    h.run({ maxSteps: MAX_STEPS });
    return h.instret + (h.status === "error" ? 1 : 0);
  }, [asm]);
  const step = Math.min(k, total);
  const { hart, snap } = useMemo(() => hartAt(asm.program, asm.ok ? step : 0), [asm, step]);
  const word = hart.pc + 4 <= hart.memBytes ? hart.peek(hart.pc) : 0;
  const pick = (v: string) => { setId(v); setSource(programById(v).source); setK(0); };
  const edit = (v: string) => { setSource(v); setK(0); };
  const done = snap.status !== "running";

  return (
    <Demo
      title="RISC-V playground: assemble, step, inspect"
      actions={
        <ButtonRow>
          <IndexButtons k={step} n={total + 1} set={setK} />
          <Btn onClick={() => setK(total)} disabled={step >= total}>Run to end</Btn>
          <Btn ghost onClick={() => setK(0)} disabled={step === 0}>Reset</Btn>
        </ButtonRow>
      }
      controls={
        <>
          <Param spec={range({ label: "Instructions run", min: 0, max: Math.max(1, total), step: 1, default: 0, format: (v) => `${v} of ${total}` })} value={step} onChange={(v) => setK(v as number)} />
          <Param spec={PROGRAM} value={id} onChange={(v) => pick(v as string)} />
          <Param spec={SHOW} value={show} onChange={(v) => setShow(v as "used" | "all")} />
        </>
      }
    >
      <StepCaption tone={snap.error ? "bad" : done ? "good" : "info"} label={`${snap.instret} run`}>{asm.ok ? caption(snap, hart) : "Fix the errors to run the program."}</StepCaption>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 12, marginTop: 10 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Program in memory</SectionLabel>
          <AsmListing program={asm.program} pc={asm.ok && !done ? hart.pc : undefined} maxHeight={300} />
          {hart.output && (
            <div style={{ marginTop: 8, fontSize: 12.5 }}>
              <span className="muted">stdout: </span><span style={{ ...mono, whiteSpace: "pre-wrap" }}>{hart.output}</span>
            </div>
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Hart state</SectionLabel>
          <div style={{ fontSize: 12.5, marginBottom: 6, ...mono }}><span className="muted">pc </span>0x{hart.pc.toString(16).padStart(8, "0")}</div>
          <RegFile regs={snap.regs} changed={snap.changed} show={show} />
        </div>
      </div>
      <SectionLabel>{done ? "Last instruction word" : "Next instruction: its 32 bits"}</SectionLabel>
      <BitFields word={done && snap.last ? snap.last.word : word} />
      <SectionLabel>Source</SectionLabel>
      <AsmEditor value={source} onChange={edit} errors={asm.errors} rows={10} />
    </Demo>
  );
}
