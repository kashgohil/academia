/**
 * Demos of the lesson "single-cycle datapath":
 * - ArchPathStepDemo: run a sample program one clock cycle at a time and see which wires each instruction uses,
 *   with the value on each wire and the control settings.
 * - ArchPathImmDemo: the immediate generator as wiring: where each immediate bit comes from in each format, and how
 *   many multiplexer inputs the RISC-V layout needs compared with an unscrambled layout.
 * - ArchPathTimingDemo: the critical path of each instruction class (MODEL INPUT delays), the clock that fits the
 *   slowest one, and the time that every other instruction wastes.
 */
import { useMemo, useState } from "react";
import {
  Btn, ButtonRow, Chip, Demo, MiniTable, Param, SectionLabel, SmallLabel, Stats, StepCaption, mono, pct, range, seg, select, tint, fixed, int,
} from "../../kit";
import { assemble, disasm, encode, Hart, PROGRAMS, programById, type Inst } from "../../sims/arch/rv";
import {
  classesOf, controlsOf, criticalPath, DEFAULT_DELAYS, IMM_SOURCE, IMM_SOURCE_NAIVE, IMM_SRCS, immGen, immMuxCost, liveEdges, MAIN_TABLE,
  mixOf, SIGNAL_SPEC, SIGNALS, SingleCycle, singleCycleClock, TCLASS_EXAMPLE, waste, type ImmSrc, type Isa, type Node, type OpType, type TClass, type Wires,
} from "../../sims/arch/datapath";
import { AsmListing, BitFields } from "./ArchViews";
import { DatapathSvg, fmtAddr, fmtWord, wiresToView } from "./ArchPathUi";

const PROGRAM = select({ label: "Program", options: PROGRAMS.map((p) => ({ value: p.id, label: p.title })), default: "sum" });
const MAX_CYCLES = 600;

/** Run a sample program on the single-cycle machine and keep the wires of every cycle. */
function runSingle(id: string) {
  const program = assemble(programById(id).source).program;
  const m = new SingleCycle(program);
  const cycles: Wires[] = [];
  for (;;) {
    const ok = m.step();
    if (m.wires) cycles.push(m.wires);
    if (!ok || cycles.length >= MAX_CYCLES) break;
  }
  return { program, cycles, exit: m.exitCode };
}

/** One sentence about what the datapath does for this instruction. */
function explain(w: Wires): string {
  const t = disasm(w.instr, w.pc, { pseudo: true });
  switch (w.type) {
    case "R": return `${t}: the ALU computes ${w.aluCtl}(${fmtWord(w.rd1)}, ${fmtWord(w.rd2)}) = ${fmtWord(w.aluY)}, and the result mux sends it to rd.`;
    case "I-ALU": return `${t}: input B of the ALU is the immediate ${fmtWord(w.imm)}. The ALU gives ${fmtWord(w.aluY)} for rd.`;
    case "Load": return `${t}: the ALU adds rs1 and the immediate to make the address ${fmtAddr(w.aluY)}. The data memory reads ${fmtWord(w.memOut)}, and the result mux picks Mem.`;
    case "Store": return `${t}: the ALU makes the address ${fmtAddr(w.aluY)}, and rs2 (${fmtWord(w.rd2)}) goes to the write port of the data memory. No register changes.`;
    case "Branch": return `${t}: the ALU subtracts ${fmtWord(w.rd1)} - ${fmtWord(w.rd2)}. The branch logic reads the flags: ${w.cond ? `taken, so the PC mux picks the target ${fmtAddr(w.target)}` : "not taken, so the PC mux picks PC + 4"}.`;
    case "JAL": return `${t}: the PC + imm adder makes the target ${fmtAddr(w.target)}. The result mux writes PC + 4 (${fmtAddr(w.pc4)}) into rd. The ALU is not used.`;
    case "JALR": return `${t}: the ALU adds rs1 and the immediate for the target ${fmtAddr(w.target)}, with bit 0 cleared. rd gets PC + 4.`;
    case "LUI": return `${t}: ALU input A is 0, so the ALU passes the U immediate ${fmtWord(w.imm)} to rd.`;
    case "AUIPC": return `${t}: ALU input A is the PC, so rd gets PC + ${fmtWord(w.imm)} = ${fmtAddr(w.aluY)}.`;
    case "System": return `${t}: Sys = 1. The machine hands over to the kernel, which reads a7.`;
    case "Fence": return `${t}: nothing to do on a machine with one hart and no caches.`;
  }
}

export function ArchPathStepDemo() {
  const [id, setId] = useState("sum");
  const [k, setK] = useState(0);
  const run = useMemo(() => runSingle(id), [id]);
  const n = run.cycles.length;
  const i = Math.min(k, n - 1);
  const w = run.cycles[i]!;
  const view = wiresToView(w);
  const types = [...new Set(run.cycles.map((c) => c.type))];
  const next = (t: OpType) => {
    for (let j = 1; j <= n; j++) { const q = (i + j) % n; if (run.cycles[q]!.type === t) { setK(q); return; } }
  };
  return (
    <Demo
      title="Single-cycle datapath: one instruction per clock"
      actions={
        <ButtonRow>
          <Btn onClick={() => setK(Math.max(0, i - 1))} disabled={i === 0}>Back</Btn>
          <Btn onClick={() => setK(Math.min(n - 1, i + 1))} disabled={i >= n - 1}>Next cycle</Btn>
        </ButtonRow>
      }
      controls={
        <>
          <Param spec={range({ label: "Cycle", min: 1, max: n, step: 1, default: 1, format: (v) => `${v} of ${n}` })} value={i + 1} onChange={(v) => setK((v as number) - 1)} />
          <Param spec={PROGRAM} value={id} onChange={(v) => { setId(v as string); setK(0); }} />
        </>
      }
    >
      <ButtonRow style={{ marginBottom: 6 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Next:</span>
        {types.map((t) => <Chip key={t} color={t === w.type ? "var(--c1)" : "var(--muted)"} filled={t === w.type} onClick={() => next(t)}>{t}</Chip>)}
      </ButtonRow>
      <DatapathSvg {...view} />
      <StepCaption tone="info" label={`cycle ${i + 1}`}>{explain(w)}</StepCaption>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 12, marginTop: 10 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Program</SectionLabel>
          <AsmListing program={run.program} pc={w.pc} maxHeight={210} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Control word from the main decoder</SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {SIGNALS.map((s) => {
              const v = MAIN_TABLE[w.type][s];
              return <Chip key={s} faint={v === null} color={v ? "var(--c2)" : "var(--muted)"} title={SIGNAL_SPEC[s].about}>{s}={v === null ? "x" : SIGNAL_SPEC[s].values[v]}</Chip>;
            })}
          </div>
          <SmallLabel style={{ marginTop: 8 }}>x = do not care: no state element uses that value for this instruction.</SmallLabel>
        </div>
      </div>
      <SectionLabel>The instruction word: each field drives its own wires</SectionLabel>
      <BitFields word={w.instr} />
    </Demo>
  );
}

// ---------------------------------------------------------------- immediate generator

const EXAMPLES: { f: ImmSrc; inst: Inst }[] = [
  { f: "I", inst: { op: "addi", rd: 10, rs1: 10, rs2: 0, imm: -3 } },
  { f: "S", inst: { op: "sw", rd: 0, rs1: 2, rs2: 11, imm: -12 } },
  { f: "B", inst: { op: "beq", rd: 0, rs1: 10, rs2: 11, imm: -8 } },
  { f: "U", inst: { op: "lui", rd: 10, rs1: 0, rs2: 0, imm: 0x12345 } },
  { f: "J", inst: { op: "jal", rd: 1, rs1: 0, rs2: 0, imm: 2056 } },
];
const SRC_COLOR = (b: number) => (b < 0 ? "transparent" : b === 31 ? "var(--c4)" : b >= 25 ? "var(--c1)" : b >= 21 ? "var(--c3)" : b === 20 ? "var(--c5)" : b >= 12 ? "var(--c2)" : b >= 8 ? "var(--c3)" : "var(--c5)");
const CW = 19;

export function ArchPathImmDemo() {
  const [naive, setNaive] = useState(false);
  const [ex, setEx] = useState(2);
  const layout = naive ? IMM_SOURCE_NAIVE : IMM_SOURCE;
  const cost = immMuxCost(layout);
  const real = immMuxCost(IMM_SOURCE), alt = immMuxCost(IMM_SOURCE_NAIVE);
  const e = EXAMPLES[ex]!;
  const word = encode(e.inst);
  const imm = immGen(word, e.f);
  const bits = Array.from({ length: 32 }, (_, k) => 31 - k);
  const cell = { width: CW, minWidth: CW, textAlign: "center" as const, fontSize: 10, lineHeight: "18px", ...mono };
  return (
    <Demo
      title="Immediate generator: where each bit comes from"
      controls={
        <>
          <Param spec={seg("Layout", [["real", "RISC-V"], ["naive", "Unscrambled"]], "real")} value={naive ? "naive" : "real"} onChange={(v) => setNaive(v === "naive")} />
          <Param spec={select({ label: "Example", options: EXAMPLES.map((x, j) => ({ value: String(j), label: `${x.f}: ${disasm(x.inst)}` })), default: "2" })} value={String(ex)} onChange={(v) => setEx(Number(v))} />
        </>
      }
    >
      <SmallLabel>Each cell is the instruction bit that feeds that immediate bit (blank = constant 0). The last row counts the different sources of each column: a column with 2 or more needs a multiplexer.</SmallLabel>
      <div style={{ overflowX: "auto", maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 0" }}>
        <div style={{ width: 52 + 32 * CW }}>
          <div style={{ display: "flex" }}>
            <div className="muted" style={{ width: 52, fontSize: 10.5, paddingLeft: 6 }}>imm bit</div>
            {bits.map((b) => <div key={b} className="muted" style={cell}>{b}</div>)}
          </div>
          {IMM_SRCS.map((f) => (
            <div key={f} style={{ display: "flex", background: f === e.f ? "var(--subtle)" : undefined }}>
              <div style={{ width: 52, fontSize: 11.5, paddingLeft: 6, lineHeight: "18px", fontWeight: f === e.f ? 700 : 400 }}>{f}</div>
              {bits.map((b) => {
                const src = layout[f][b]!;
                return (
                  <div key={b} title={src < 0 ? "0" : `instruction bit ${src}`} style={{ ...cell, background: src < 0 ? undefined : tint(SRC_COLOR(src), 30), borderLeft: "1px solid var(--bg)" }}>
                    {src < 0 ? "" : src}
                  </div>
                );
              })}
            </div>
          ))}
          <div style={{ display: "flex", borderTop: "1px solid var(--border)" }}>
            <div className="muted" style={{ width: 52, fontSize: 10.5, paddingLeft: 6, lineHeight: "18px" }}>sources</div>
            {bits.map((b) => {
              const k = cost.perBit[b]!;
              return <div key={b} style={{ ...cell, fontWeight: k > 1 ? 700 : 400, color: k >= 4 ? "var(--c4)" : k > 1 ? "var(--fg)" : "var(--muted)" }}>{k}</div>;
            })}
          </div>
          {!naive && (
            <div style={{ display: "flex", borderTop: "1px solid var(--border)" }}>
              <div className="muted" style={{ width: 52, fontSize: 10.5, paddingLeft: 6, lineHeight: "18px" }}>{e.f} value</div>
              {bits.map((b) => <div key={b} style={cell}>{(imm >>> b) & 1}</div>)}
            </div>
          )}
        </div>
      </div>
      <Stats items={[
        { label: "multiplexer inputs, this layout", value: int(cost.inputs) },
        { label: "RISC-V layout", value: int(real.inputs) },
        { label: "unscrambled layout", value: int(alt.inputs) },
        { label: "largest fan-in", value: `${Math.max(...cost.perBit)} sources` },
      ]} />
      {!naive && (
        <>
          <SectionLabel>The example word</SectionLabel>
          <BitFields word={word} caption={<>{disasm(e.inst)}{"  "}<span className="muted">immediate = {imm}</span></>} />
        </>
      )}
    </Demo>
  );
}

// ---------------------------------------------------------------- timing

const ISA = select<Isa>({ label: "Hardware implements", options: [{ value: "RV32I", label: "RV32I" }, { value: "RV32I+mul", label: "RV32I + multiplier" }, { value: "RV32IM", label: "RV32IM (with divider)" }], default: "RV32I" });
const KIND_COLOR: Partial<Record<Node, string>> = { IMem: "var(--c4)", DMem: "var(--c4)", ALU: "var(--c1)", RF: "var(--c3)", PC4: "var(--c2)", PCImm: "var(--c2)", Ctrl: "var(--c5)", Imm: "var(--c5)" };
const typeOf = (c: TClass): OpType => (c === "Mul" || c === "Div" ? "R" : c);

/** The instruction mix of a sample program, from the hart's trace. */
export function mixOfProgram(id: string) {
  const h = new Hart(assemble(programById(id).source).program);
  h.run();
  return mixOf(h.trace);
}

export function ArchPathTimingDemo() {
  const [mem, setMem] = useState(DEFAULT_DELAYS.imem);
  const [aluD, setAlu] = useState(DEFAULT_DELAYS.alu);
  const [rf, setRf] = useState(DEFAULT_DELAYS.rf);
  const [isa, setIsa] = useState<Isa>("RV32I");
  const [id, setId] = useState("sum");
  const [sel, setSel] = useState<TClass>("Load");
  const d = { ...DEFAULT_DELAYS, imem: mem, dmem: mem, alu: aluD, rf };
  const clock = singleCycleClock(d, isa);
  const mix = useMemo(() => mixOfProgram(id), [id]);
  const ws = waste(mix, d, isa);
  const needsM = (mix.Mul > 0 && isa === "RV32I") || (mix.Div > 0 && isa !== "RV32IM");
  const classes = classesOf(isa);
  const shown = classes.includes(sel) ? sel : "Load";
  const cp = criticalPath(shown, d);
  const hot = new Set(cp.path.slice(1).map((s, j) => `${cp.path[j]!.node}>${s.node}`));
  const tc = clock.tc;
  return (
    <Demo
      title="Critical paths: the clock must fit the slowest instruction"
      controls={
        <>
          <Param spec={range({ label: "Memory read (ps)", min: 50, max: 500, step: 10, default: DEFAULT_DELAYS.imem })} value={mem} onChange={(v) => setMem(v as number)} />
          <Param spec={range({ label: "ALU (ps)", min: 50, max: 500, step: 10, default: DEFAULT_DELAYS.alu })} value={aluD} onChange={(v) => setAlu(v as number)} />
          <Param spec={range({ label: "Register read (ps)", min: 30, max: 300, step: 10, default: DEFAULT_DELAYS.rf })} value={rf} onChange={(v) => setRf(v as number)} />
          <Param spec={ISA} value={isa} onChange={(v) => setIsa(v as Isa)} />
          <Param spec={PROGRAM} value={id} onChange={(v) => setId(v as string)} />
        </>
      }
    >
      <SmallLabel>Each bar is the longest chain of units that one instruction class uses. Click a row to draw its path. The dashed part is time that the instruction waits for the clock edge.</SmallLabel>
      <div style={{ display: "grid", gap: 3 }}>
        {clock.paths.map((p) => {
          const on = p.cls === shown;
          return (
            <div key={p.cls} onClick={() => setSel(p.cls)} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", background: on ? "var(--subtle)" : undefined, borderRadius: 4, padding: "1px 4px" }}>
              <div style={{ width: 92, minWidth: 92, fontSize: 12, ...mono, fontWeight: on ? 700 : 400 }}>{TCLASS_EXAMPLE[p.cls]} <span className="muted">{p.total} ps</span></div>
              <div style={{ position: "relative", flex: 1, height: 16 }}>
                {p.path.map((s, j) => s.end > s.start && (
                  <div key={j} title={`${s.node}: ${s.end - s.start} ps`} style={{ position: "absolute", left: `${(s.start / tc) * 100}%`, width: `${((s.end - s.start) / tc) * 100}%`, top: 1, bottom: 1, background: tint(KIND_COLOR[s.node] ?? "var(--muted)", 55), borderRight: "1px solid var(--bg)" }} />
                ))}
                {p.total < tc && <div style={{ position: "absolute", left: `${(p.total / tc) * 100}%`, right: 0, top: 1, bottom: 1, border: "1.5px dashed var(--muted)", borderLeft: "none", borderRadius: "0 3px 3px 0" }} />}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11.5, marginTop: 6 }} className="muted">
        {[["memory", "var(--c4)"], ["ALU", "var(--c1)"], ["register file", "var(--c3)"], ["adder", "var(--c2)"], ["decoder, imm gen", "var(--c5)"], ["mux, setup, other", "var(--muted)"]].map(([l, c]) => (
          <span key={l}><span style={{ display: "inline-block", width: 10, height: 10, background: tint(c!, 55), marginRight: 4, verticalAlign: -1 }} />{l}</span>
        ))}
      </div>
      <Stats items={[
        { label: "clock period", value: `${tc} ps` },
        { label: "clock rate", value: `${fixed(1000 / tc, 2)} GHz` },
        { label: "slowest class", value: TCLASS_EXAMPLE[clock.slowest] },
        { label: `time wasted on ${id}`, value: needsM ? "cannot run" : pct(ws.fraction) },
      ]} />
      {needsM && <StepCaption tone="bad">This program uses mul, and this hardware has no multiplier. Pick a machine with one.</StepCaption>}
      <SectionLabel>Critical path of {TCLASS_EXAMPLE[shown]}: {cp.path.map((s) => s.node).join(" → ")}</SectionLabel>
      <DatapathSvg live={liveEdges(controlsOf(MAIN_TABLE[typeOf(shown)]))} hot={hot} />
      <MiniTable head={["unit", "starts", "ends"]} rows={cp.path.filter((s) => s.end > s.start).map((s) => [s.node, `${s.start} ps`, `${s.end} ps`])} />
    </Demo>
  );
}
