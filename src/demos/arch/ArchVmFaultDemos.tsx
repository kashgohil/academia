/** Demos for the lesson on page faults as precise exceptions: a pipeline with traps, faults across pages, trap cost. */
import { useMemo } from "react";
import { Banner, Demo, MONO, Note, Param, SectionLabel, StackBar, Stats, StepButtons, StepCaption, StepSlider, fixed, int, pct, range, seg, tint, useParams, useStepper } from "../../kit";
import { STAGES, TRAP_COST_MODEL, faultFreeCycles, goldenRun, misalignedStore, repMovsb, runTrapPipeline, trapCost, type TrapPolicy, type TrapScenario } from "../../sims/arch/vm";
import { RegGrid } from "./ArchVmUi";

const hex = (v: number) => `0x${v.toString(16)}`;
const STAGE_COLOR = ["var(--c1)", "var(--c5)", "var(--c3)", "var(--c2)", "var(--fg)"];

export function ArchVmPreciseTrapDemo() {
  const p = useParams("precise", {
    policy: seg<TrapPolicy>("Trap policy", [["precise", "Precise: trap at commit"], ["drain", "Let younger instructions finish"]], "precise"),
    scenario: seg<TrapScenario>("Faults", [["one", "Data page missing"], ["two", "Data page and code page missing"]], "one"),
  });
  const run = useMemo(() => runTrapPipeline(p.values.policy, p.values.scenario), [p.values.policy, p.values.scenario]);
  const s = useStepper(run.cycles.length, 3);
  const c = run.cycles[s.i]!;
  const golden = goldenRun();
  // Rows: one per dynamic instruction, in fetch order.
  const rows = useMemo(() => {
    const m = new Map<number, { text: string; handler: boolean; cells: Map<number, { stage: number; cause?: number; fate?: string }> }>();
    run.cycles.forEach((cv) => cv.stages.forEach((sl, k) => {
      if (!sl) return;
      if (!m.has(sl.seq)) m.set(sl.seq, { text: sl.instr.text, handler: !!sl.instr.handler, cells: new Map() });
      m.get(sl.seq)!.cells.set(cv.cycle, { stage: k, cause: sl.cause, fate: sl.fate });
    }));
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({ ...v, first: Math.min(...v.cells.keys()) }));
  }, [run]);
  const W = 30;
  const end = s.atEnd;
  return (
    <Demo
      title="A page fault in a 5-stage pipeline"
      actions={<StepButtons s={s} />}
      controls={<>
        <StepSlider s={s} label="Cycle" />
        <Param spec={p.schema.policy} value={p.values.policy} onChange={(v) => { p.set("policy", v as TrapPolicy); s.reset(); }} />
        <Param spec={p.schema.scenario} value={p.values.scenario} onChange={(v) => { p.set("scenario", v as TrapScenario); s.reset(); }} />
      </>}
    >
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11, fontFamily: MONO }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "0 8px 2px 0", position: "sticky", left: 0, background: "var(--bg)", minWidth: 132 }}>cycle</th>
              {run.cycles.map((cv) => <th key={cv.cycle} style={{ width: W, minWidth: W, color: cv.cycle === c.cycle ? "var(--fg)" : "var(--muted)", fontWeight: cv.cycle === c.cycle ? 700 : 400 }}>{cv.cycle}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ visibility: r.first <= c.cycle ? "visible" : "hidden" }}>
                <td style={{ padding: "1px 8px 1px 0", whiteSpace: "nowrap", position: "sticky", left: 0, background: "var(--bg)", color: r.handler ? "var(--c5)" : "var(--fg)" }}>{r.text}</td>
                {run.cycles.map((cv) => {
                  const cell = cv.cycle <= c.cycle ? r.cells.get(cv.cycle) : undefined;
                  const bad = cell?.cause !== undefined;
                  const col = cell ? (bad ? "var(--c4)" : STAGE_COLOR[cell.stage]!) : "transparent";
                  return (
                    <td key={cv.cycle} style={{ padding: 1 }}>
                      {cell && <div title={cell.fate ?? ""} style={{ height: 17, display: "grid", placeItems: "center", borderRadius: 3, fontSize: 10, background: cell.fate === "flushed" ? "transparent" : tint(col, 30), border: `1px ${cell.fate === "flushed" ? "dashed" : "solid"} ${col}`, textDecoration: cell.fate === "flushed" ? "line-through" : undefined, fontWeight: cell.fate === "trap" ? 700 : 400 }}>{STAGES[cell.stage]}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <StepCaption label={`cycle ${c.cycle}`} tone={c.events.some((e) => e.startsWith("Trap")) ? "bad" : c.events.length ? "info" : "plain"}>
        {c.events.length ? c.events.join(" ") : "Instructions move one stage."}
      </StepCaption>
      <SectionLabel>Architectural state after this cycle</SectionLabel>
      <RegGrid items={[
        { name: "a0", value: c.regs.a0, bad: end && c.regs.a0 !== golden.regs.a0 },
        { name: "a1", value: c.regs.a1, bad: end && c.regs.a1 !== golden.regs.a1 },
        { name: "a2", value: c.regs.a2, bad: end && c.regs.a2 !== golden.regs.a2 },
        { name: "mem[0x5000]", value: c.mem[0x5000], bad: end && c.mem[0x5000] !== golden.mem[0x5000] },
        { name: "sepc", value: c.csr.sepc === null ? "–" : hex(c.csr.sepc), hot: true },
        { name: "scause", value: c.csr.scause ?? "–", hot: true },
        { name: "stval", value: c.csr.stval === null ? "–" : hex(c.csr.stval), hot: true },
      ]} />
      {end && (
        <Banner ok={run.correct}>
          {run.correct
            ? `Correct: a0 = ${golden.regs.a0}, a2 = ${golden.regs.a2}, as if no fault had happened. ${run.traps.length} trap${run.traps.length > 1 ? "s" : ""}, ${run.cycles.length} cycles against ${faultFreeCycles()} with every page mapped.`
            : `Wrong: the correct result is a0 = ${golden.regs.a0}, a2 = ${golden.regs.a2}. Younger instructions ran before the trap and again after it.`}
        </Banner>
      )}
      <Note>Initial state: a0 = 5, s0 = 0x4000 (the page that is missing), s1 = 0x5000, memory[0x4000] = 37. Handler rows are in another color. A dashed cell is flushed work.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- one instruction, two pages

export function ArchVmMultiPageDemo() {
  const p = useParams("multipage", { which: seg<"rep" | "sd">("Instruction", [["rep", "x86 rep movsb"], ["sd", "RISC-V misaligned sd"]], "rep") });
  const frames = useMemo(() => (p.values.which === "rep" ? repMovsb() : misalignedStore()), [p.values.which]);
  const s = useStepper(frames.length, 1.5);
  const f = frames[s.i]!;
  return (
    <Demo
      title="A fault in the middle of one instruction"
      actions={<StepButtons s={s} />}
      controls={<><StepSlider s={s} /><Param spec={p.schema.which} value={p.values.which} onChange={(v) => { p.set("which", v as "rep"); s.reset(); }} /></>}
    >
      <SectionLabel>Destination bytes</SectionLabel>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <div style={{ display: "flex", gap: 2, minWidth: "min-content", paddingBottom: 2 }}>
          {f.dst.map((b) => {
            const pageStart = (b.addr & 0xfff) === 0;
            return (
              <div key={b.addr} style={{ marginLeft: pageStart ? 10 : 0, borderLeft: pageStart ? "2px solid var(--fg)" : undefined, paddingLeft: pageStart ? 4 : 0 }}>
                <div style={{ fontSize: 9, color: "var(--muted)", fontFamily: MONO, textAlign: "center" }}>{(b.addr & 0xfff).toString(16).padStart(3, "0")}</div>
                <div style={{ width: 26, height: 24, display: "grid", placeItems: "center", fontFamily: MONO, fontSize: 11, borderRadius: 3, border: "1px solid var(--border)", background: b.value === null ? "var(--subtle)" : tint("var(--c1)", 30) }}>{b.value === null ? "" : b.value.toString(16)}</div>
              </div>
            );
          })}
        </div>
      </div>
      <Note>The black rule is a page boundary. Byte addresses show the low 12 bits.</Note>
      <SectionLabel>Registers</SectionLabel>
      <RegGrid items={Object.entries(f.regs).map(([name, value]) => ({ name, value, hot: name === "CR2" || name === "stval" || name === "scause" }))} />
      <StepCaption tone={f.fault ? "bad" : f.handler ? "warn" : "plain"} label={`step ${f.step}`}>{f.text}</StepCaption>
    </Demo>
  );
}

// ---------------------------------------------------------------- what one trap costs

export function ArchVmTrapCostDemo() {
  const p = useParams("trapcost", {
    handler: range({ label: "Handler instructions", min: 100, max: 5000, step: 50, default: TRAP_COST_MODEL.handlerInstructions }),
    refill: range({ label: "Pipeline refill, cycles", min: 5, max: 40, step: 1, default: TRAP_COST_MODEL.pipelineRefill }),
    entry: range({ label: "Trap entry and return, cycles", min: 10, max: 400, step: 10, default: TRAP_COST_MODEL.entryExit }),
  });
  const r = trapCost({ ...TRAP_COST_MODEL, handlerInstructions: p.values.handler, pipelineRefill: p.values.refill, entryExit: p.values.entry });
  return (
    <Demo title="Where the cycles of one minor fault go" controls={<>
      <Param spec={p.schema.handler} value={p.values.handler} onChange={(v) => p.set("handler", v as number)} />
      <Param spec={p.schema.refill} value={p.values.refill} onChange={(v) => p.set("refill", v as number)} />
      <Param spec={p.schema.entry} value={p.values.entry} onChange={(v) => p.set("entry", v as number)} />
    </>}>
      <StackBar parts={[{ value: 2 * p.values.refill, color: "var(--c4)", label: "pipeline refill twice" }, { value: p.values.entry, color: "var(--c2)", label: "trap entry and return" }, { value: r.software, color: "var(--c1)", label: "handler" }]} />
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, marginTop: 6 }}>
        {[["var(--c4)", "pipeline refill, at the trap and at the return"], ["var(--c2)", "trap entry and return"], ["var(--c1)", "kernel handler"]].map(([c, t]) => <span key={t}><span style={{ display: "inline-block", width: 10, height: 10, background: c, borderRadius: 2, marginRight: 4 }} />{t}</span>)}
      </div>
      <Stats items={[
        { label: "cycles, hardware part", value: int(r.hardware) },
        { label: "cycles, handler", value: int(r.software) },
        { label: "hardware share", value: pct(r.hardwareShare) },
        { label: "µs at 3 GHz", value: fixed(r.total / 3000, 2) },
      ]} />
      <Note>All values are model inputs. The handler runs at one instruction per cycle in this model.</Note>
    </Demo>
  );
}
