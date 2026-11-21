/**
 * Demos of the lesson "control unit":
 * - ArchPathMainDecoderDemo: the main decoder as an editable truth table. Change any cell, and every sample program
 *   runs on the single-cycle machine in lockstep with the hart; the first wrong instruction is shown on the datapath.
 * - ArchPathAluDecoderDemo: the ALU decoder, with three design mistakes to switch on, and the decoder inputs of an
 *   example instruction.
 */
import { useMemo, useState, type CSSProperties } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, Param, SectionLabel, SmallLabel, Stats, mono, select, tint, toggle, useChunked, int } from "../../kit";
import { assemble, disasm, encode, PROGRAMS, programById, type Inst, type Program } from "../../sims/arch/rv";
import {
  ALU_DECODER_ROWS, aluDecode, aluDecoderInputs, compareWithHart, MAIN_TABLE, OP_TYPES, SIGNAL_SPEC, SIGNALS, SingleCycle, tableDiff, withCell,
  type AluDecoderBugs, type CompareResult, type MainTable, type OpType, type Signal, type Unit,
} from "../../sims/arch/datapath";
import { BitFields } from "./ArchViews";
import { DatapathSvg, wiresToView } from "./ArchPathUi";

const PROGRAM_IDS = PROGRAMS.map((p) => p.id);
const programs = new Map<string, Program>();
const programOf = (id: string) => {
  let p = programs.get(id);
  if (!p) { p = assemble(programById(id).source).program; programs.set(id, p); }
  return p;
};
const MAX_STEPS = 5000;

/** The unit that each control signal steers, to mark it as broken in the drawing. */
const UNIT_OF: Record<Signal, Unit> = {
  RegWrite: "RF", ImmSrc: "Imm", ALUSrcA: "SrcA", ALUSrcB: "SrcB", MemRead: "DMem", MemWrite: "DMem", ResultSrc: "Result",
  Branch: "BrLogic", Jump: "PCMux", TargetSrc: "Target", ALUOp: "ALUDec", Sys: "Ctrl",
};

function verdict(r: CompareResult, steps: number): { tone: "good" | "bad" | "warn"; text: string } {
  if (r.div) {
    const d = r.div;
    const at = `Instruction ${int(d.seq + 1)} (${d.text} at 0x${d.pc.toString(16)})`;
    if (d.what === "status") return { tone: "bad", text: `${at}: the hart gives ${d.expected}, but the datapath gives ${d.got}.` };
    if (d.what === "store") return { tone: "bad", text: `${at}: the hart stores ${d.expected}; the datapath stores ${d.got}.` };
    if (d.what === "next pc") return { tone: "bad", text: `${at}: the next PC should be ${d.expected}, but the datapath goes to ${d.got}.` };
    return { tone: "bad", text: `${at}: ${d.what} should be ${d.expected}, but the datapath wrote ${d.got}.` };
  }
  if (r.end === "timeout") return { tone: "warn", text: `Both machines still run after ${int(steps)} instructions.` };
  return { tone: "good", text: `Same registers, memory and output as the hart for all ${int(r.steps)} instructions. Exit code ${r.exitCode}.` };
}

/** Wires of the cycle that went wrong (the instruction at div.seq). */
function failingWires(id: string, make: (p: Program) => SingleCycle, r: CompareResult) {
  if (!r.div) return null;
  const m = make(programOf(id));
  for (let i = 0; i <= r.div.seq; i++) m.step();
  return m.wires;
}

/** Chips for all sample programs (computed in slices), and the verdict and datapath of the selected one. */
function ProgramsCheck({ keyStr, make, id, setId, broken }: { keyStr: string; make: (p: Program) => SingleCycle; id: string; setId: (v: string) => void; broken: Set<Unit> }) {
  const results = useChunked(keyStr, PROGRAM_IDS.map((pid) => () => compareWithHart(programOf(pid), make(programOf(pid)), MAX_STEPS)));
  const sel = results[PROGRAM_IDS.indexOf(id)];
  const v = sel ? verdict(sel, MAX_STEPS) : null;
  const wires = useMemo(() => (sel ? failingWires(id, make, sel) : null), [sel, id, make]);
  const fails = results.filter((r) => r && !r.ok).length;
  return (
    <>
      <SectionLabel>Sample programs against the hart: {results.every(Boolean) ? `${fails} of ${PROGRAM_IDS.length} fail` : "running…"}</SectionLabel>
      <ButtonRow>
        {PROGRAM_IDS.map((pid, i) => {
          const r = results[i];
          const color = !r ? "var(--muted)" : r.ok ? "var(--c3)" : r.div ? "var(--c4)" : "var(--c2)";
          return <Chip key={pid} color={color} filled={pid === id} bold={pid === id} onClick={() => setId(pid)} title={r ? verdict(r, MAX_STEPS).text : "running"}>{pid}{r ? (r.ok ? " ✓" : " ✗") : ""}</Chip>;
        })}
      </ButtonRow>
      <Banner tone={v?.tone ?? "plain"} label={id} min={42}>{v?.text ?? "Running…"}</Banner>
      {wires && (
        <>
          <SectionLabel>The datapath in the cycle that went wrong</SectionLabel>
          <DatapathSvg {...wiresToView(wires)} broken={broken} />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- main decoder

const PRESETS: { label: string; type: OpType; signal: Signal; value: number }[] = [
  { label: "JAL: RegWrite = 0", type: "JAL", signal: "RegWrite", value: 0 },
  { label: "Load: ResultSrc = ALU", type: "Load", signal: "ResultSrc", value: 0 },
  { label: "Load: MemRead = 0", type: "Load", signal: "MemRead", value: 0 },
  { label: "Store: ImmSrc = I", type: "Store", signal: "ImmSrc", value: 0 },
  { label: "Branch: ALUOp = add", type: "Branch", signal: "ALUOp", value: 0 },
  { label: "JALR: TargetSrc = PC+imm", type: "JALR", signal: "TargetSrc", value: 0 },
  { label: "AUIPC: ALUSrcA = 0", type: "AUIPC", signal: "ALUSrcA", value: 2 },
];

const SHORT: Record<Signal, string> = {
  RegWrite: "RegW", ImmSrc: "ImmSrc", ALUSrcA: "SrcA", ALUSrcB: "SrcB", MemRead: "MemR", MemWrite: "MemW", ResultSrc: "Result",
  Branch: "Br", Jump: "Jump", TargetSrc: "Target", ALUOp: "ALUOp", Sys: "Sys",
};

export function ArchPathMainDecoderDemo() {
  const [table, setTable] = useState<MainTable>(MAIN_TABLE);
  const [id, setId] = useState("fact");
  const diff = tableDiff(table);
  const keyStr = JSON.stringify(diff);
  const make = useMemo(() => (p: Program) => new SingleCycle(p, { table }), [table]);
  const broken = new Set(diff.map((d) => UNIT_OF[d.signal]));
  const cycle = (t: OpType, s: Signal) => {
    const vals: (number | null)[] = [...SIGNAL_SPEC[s].values.map((_, i) => i), null];
    const cur = table[t][s];
    setTable(withCell(table, t, s, vals[(vals.indexOf(cur) + 1) % vals.length]!));
  };
  const th: CSSProperties = { padding: "3px 4px", fontSize: 10.5, color: "var(--muted)", fontWeight: 600, whiteSpace: "nowrap", textAlign: "center" };
  return (
    <Demo
      title="Main decoder: break one control bit"
      actions={<Btn ghost onClick={() => setTable(MAIN_TABLE)} disabled={!diff.length}>Reset table</Btn>}
      controls={<Param spec={select({ label: "Program", options: PROGRAMS.map((p) => ({ value: p.id, label: p.title })), default: "fact" })} value={id} onChange={(v) => setId(v as string)} />}
    >
      <ButtonRow style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Try:</span>
        {PRESETS.map((p) => <Btn key={p.label} ghost onClick={() => setTable(withCell(MAIN_TABLE, p.type, p.signal, p.value))}>{p.label}</Btn>)}
      </ButtonRow>
      <SmallLabel>Click a cell to change it. x = do not care (the hardware gives 0). Changed cells are red.</SmallLabel>
      <div style={{ overflowX: "auto", maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 6 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11.5, ...mono, minWidth: 640, width: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", paddingLeft: 8 }}>opcode</th>
              {SIGNALS.map((s) => <th key={s} style={th} title={SIGNAL_SPEC[s].about}>{SHORT[s]}</th>)}
            </tr>
          </thead>
          <tbody>
            {OP_TYPES.map((t) => (
              <tr key={t} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "2px 8px", whiteSpace: "nowrap" }}>{t}</td>
                {SIGNALS.map((s) => {
                  const v = table[t][s], changed = v !== MAIN_TABLE[t][s];
                  return (
                    <td key={s} style={{ padding: 1, textAlign: "center" }}>
                      <button
                        onClick={() => cycle(t, s)}
                        title={`${t}: ${s} — ${SIGNAL_SPEC[s].about}`}
                        style={{
                          width: "100%", minWidth: 38, padding: "2px 2px", fontSize: 11, ...mono, cursor: "pointer", borderRadius: 3,
                          border: `1px solid ${changed ? "var(--c4)" : "transparent"}`, background: changed ? tint("var(--c4)", 22) : v ? tint("var(--c2)", 14) : "transparent",
                          color: v === null ? "var(--faint)" : "var(--fg)",
                        }}
                      >{v === null ? "x" : SIGNAL_SPEC[s].values[v]}</button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ProgramsCheck keyStr={`main:${keyStr}`} make={make} id={id} setId={setId} broken={broken} />
    </Demo>
  );
}

// ---------------------------------------------------------------- ALU decoder

const EXAMPLES: Inst[] = [
  { op: "addi", rd: 6, rs1: 6, rs2: 0, imm: -1 },
  { op: "addi", rd: 11, rs1: 11, rs2: 0, imm: -1024 },
  { op: "addi", rd: 10, rs1: 10, rs2: 0, imm: 32 },
  { op: "sub", rd: 10, rs1: 11, rs2: 12, imm: 0 },
  { op: "srai", rd: 10, rs1: 10, rs2: 0, imm: 3 },
  { op: "mul", rd: 10, rs1: 8, rs2: 10, imm: 0 },
  { op: "lw", rd: 7, rs1: 5, rs2: 0, imm: 0 },
  { op: "bne", rd: 0, rs1: 6, rs2: 0, imm: -16 },
];
const ALUOP_OF = (i: Inst) => (i.op === "lw" ? 0 : i.op === "bne" ? 1 : 2);
const matches = (pat: string, v: number, bits: number) => pat.replace(/f/g, "-").split("").every((c, k) => c === "-" || Number(c) === ((v >> (bits - 1 - k)) & 1));

export function ArchPathAluDecoderDemo() {
  const [bugs, setBugs] = useState<AluDecoderBugs>({});
  const [ex, setEx] = useState(0);
  const [id, setId] = useState("sum");
  const inst = EXAMPLES[ex]!;
  const word = encode(inst);
  const ins = aluDecoderInputs(word, ALUOP_OF(inst));
  const good = aluDecode(ins), got = aluDecode(ins, bugs);
  const keyStr = JSON.stringify(bugs);
  const make = useMemo(() => (p: Program) => new SingleCycle(p, { bugs }), [bugs]);
  const row = ALU_DECODER_ROWS.findIndex((r) => matches(r.aluOp, ins.aluOp, 2) && matches(r.funct3, ins.funct3, 3) && matches(r.op5, ins.op5, 1) && matches(r.f7b5, ins.f7b5, 1) && matches(r.f7b0, ins.f7b0, 1));
  const set = (k: keyof AluDecoderBugs) => (v: unknown) => setBugs({ ...bugs, [k]: v as boolean });
  const cell: CSSProperties = { padding: "2px 6px", textAlign: "center", whiteSpace: "nowrap" };
  return (
    <Demo
      title="ALU decoder: which bits pick the operation"
      controls={
        <>
          <Param spec={toggle({ label: "Mistake 1: sub checks funct7[5] but not op5", default: false })} value={!!bugs.subIgnoresOp5} onChange={set("subIgnoresOp5")} />
          <Param spec={toggle({ label: "Mistake 2: M check ignores op5", default: false })} value={!!bugs.mIgnoresOp5} onChange={set("mIgnoresOp5")} />
          <Param spec={toggle({ label: "Mistake 3: right shifts ignore funct7[5]", default: false })} value={!!bugs.shiftIgnoresF7} onChange={set("shiftIgnoresF7")} />
          <Param spec={select({ label: "Example", options: EXAMPLES.map((e, j) => ({ value: String(j), label: disasm(e) })), default: "0" })} value={String(ex)} onChange={(v) => setEx(Number(v))} />
        </>
      }
    >
      <div style={{ overflowX: "auto", maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 6 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11.5, ...mono, width: "100%", minWidth: 520 }}>
          <thead>
            <tr className="muted" style={{ fontSize: 10.5 }}>
              {["ALUOp", "funct3", "op5", "funct7[5]", "funct7[0]", "operation", "instructions"].map((h) => <th key={h} style={{ ...cell, fontWeight: 600 }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {ALU_DECODER_ROWS.map((r, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--border)", background: i === row ? tint("var(--c1)", 22) : undefined, fontWeight: i === row ? 700 : 400 }}>
                <td style={cell}>{r.aluOp}</td><td style={cell}>{r.funct3}</td><td style={cell}>{r.op5}</td><td style={cell}>{r.f7b5}</td><td style={cell}>{r.f7b0}</td>
                <td style={{ ...cell, color: "var(--c2)" }}>{r.out}</td>
                <td style={{ ...cell, textAlign: "left", color: "var(--muted)", fontWeight: 400 }}>{r.who}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SmallLabel style={{ marginTop: 4 }}>- = any value. fff = funct3 picks one of the 8 M operations.</SmallLabel>
      <SectionLabel>Decoder inputs of {disasm(inst)}</SectionLabel>
      <BitFields word={word} />
      <Stats items={[
        { label: "ALUOp (main decoder)", value: ["00 add", "01 sub", "10 funct"][ins.aluOp]! },
        { label: "funct3", value: ins.funct3.toString(2).padStart(3, "0") },
        { label: "op5 (bit 5)", value: String(ins.op5) },
        { label: "funct7[5] (bit 30)", value: String(ins.f7b5) },
        { label: "funct7[0] (bit 25)", value: String(ins.f7b0) },
        { label: "operation", value: got === good ? got : `${got} (should be ${good})` },
      ]} />
      <ProgramsCheck keyStr={`alu:${keyStr}`} make={make} id={id} setId={setId} broken={new Set<Unit>(Object.values(bugs).some(Boolean) ? ["ALUDec"] : [])} />
    </Demo>
  );
}
