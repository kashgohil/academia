/**
 * Demos of the lesson "multi-cycle execution":
 * - ArchPathFsmDemo: run a sample program on the multi-cycle machine one clock cycle at a time: the FSM state, the
 *   control signals it asserts, and the registers that carry values between cycles.
 * - ArchPathIronLawDemo: time = instructions × CPI × clock period for both machines, from the hart's trace, with the
 *   MODEL INPUT delays as sliders.
 * - ArchPathMicrocodeDemo: the same FSM as a microprogram in a ROM, with the dispatch tables.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Banner, Chip, Demo, IndexButtons, MiniTable, Param, SectionLabel, SmallLabel, Stats, StepCaption, mono, range, select, tint, fixed, int, sig,
} from "../../kit";
import { assemble, disasm, PROGRAMS, programById } from "../../sims/arch/rv";
import {
  criticalPath, DEFAULT_DELAYS, dispatch1, ironLaw, microcodeSize, MICROCODE, MULTI_SIGNAL_BITS, MULTI_SIGNALS, MULTI_VALUE_NAMES, multiCycleClock, multiCycles,
  MultiCycle, OPCODE_OF, STATE_ABOUT, STATE_CONTROLS, statePath, STATES, TCLASS_EXAMPLE, TCLASSES,
  type Cycle, type Isa, type MultiControls, type OpType, type State,
} from "../../sims/arch/datapath";
import { fmtAddr, fmtWord } from "./ArchPathUi";
import { mixOfProgram } from "./ArchPathSingleDemos";

const PROGRAM = select({ label: "Program", options: PROGRAMS.map((p) => ({ value: p.id, label: p.title })), default: "sum" });
const MAX_CYCLES = 2000;

const sigText = (k: keyof MultiControls, v: number) => (MULTI_VALUE_NAMES[k] ? `${k}=${MULTI_VALUE_NAMES[k]![v]}` : `${k}=${v}`);

// ---------------------------------------------------------------- the FSM drawing

const NW = 74, NH = 26;
const POS: Record<State, [number, number]> = {
  Fetch: [381, 20], Decode: [381, 76],
  MemAdr: [45, 140], ExecuteR: [129, 140], ExecuteM: [213, 140], ExecuteI: [297, 140], LUI: [381, 140], AUIPC: [465, 140],
  JALR: [549, 140], Branch: [633, 140], System: [717, 140],
  MemRead: [45, 198], MemWrite: [129, 198], JAL: [549, 198],
  MemWB: [45, 256], ALUWB: [381, 256],
};
const FSM_EDGES: [State, State][] = [
  ["Fetch", "Decode"],
  ...(["MemAdr", "ExecuteR", "ExecuteM", "ExecuteI", "LUI", "AUIPC", "JALR", "Branch", "System"] as State[]).map((s): [State, State] => ["Decode", s]),
  ["MemAdr", "MemRead"], ["MemAdr", "MemWrite"], ["MemRead", "MemWB"], ["JALR", "JAL"],
  ...(["ExecuteR", "ExecuteM", "ExecuteI", "LUI", "AUIPC", "JAL"] as State[]).map((s): [State, State] => [s, "ALUWB"]),
];
const ENDS: State[] = ["MemWB", "MemWrite", "ALUWB", "Branch", "System"];

function FsmSvg({ cur, prev, path }: { cur: State; prev: State | null; path: Set<State> }) {
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <svg viewBox="0 0 780 290" width="100%" style={{ minWidth: 600, display: "block" }} role="img" aria-label="Multi-cycle control FSM">
        <defs>
          <marker id="pathfsm-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--border)" /></marker>
          <marker id="pathfsm-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--c1)" /></marker>
        </defs>
        {FSM_EDGES.map(([a, b]) => {
          const [x1, y1] = POS[a], [x2, y2] = POS[b];
          const on = prev === a && cur === b;
          return <line key={`${a}-${b}`} x1={x1} y1={y1 + NH / 2} x2={x2} y2={y2 - NH / 2 - 1} stroke={on ? "var(--c1)" : "var(--border)"} strokeWidth={on ? 2.2 : 1.1} markerEnd={`url(#pathfsm-${on ? "b" : "a"})`} />;
        })}
        <path d={`M${POS.ExecuteM[0] + NW / 2} ${POS.ExecuteM[1] - 4} c 14 -2 14 10 0 8`} fill="none" stroke={prev === "ExecuteM" && cur === "ExecuteM" ? "var(--c1)" : "var(--border)"} strokeWidth={1.2} />
        {STATES.map((s) => {
          const [x, y] = POS[s], on = s === cur, seen = path.has(s);
          return (
            <g key={s}>
              <rect x={x - NW / 2} y={y - NH / 2} width={NW} height={NH} rx={NH / 2} fill={on ? "var(--c1)" : seen ? tint("var(--c1)", 22) : "var(--bg)"} stroke={on || seen ? "var(--c1)" : "var(--border)"} strokeWidth={on ? 2 : 1} />
              <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={on ? 700 : 500} fill={on ? "var(--bg)" : "var(--fg)"}>{s}</text>
              {ENDS.includes(s) && <text x={x} y={y + NH / 2 + 12} textAnchor="middle" fontSize={9.5} fill="var(--muted)">→ Fetch</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- FSM stepper

function runMulti(id: string) {
  const mc = multiCycleClock();
  const program = assemble(programById(id).source).program;
  const m = new MultiCycle(program, { mulCycles: mc.mulCycles, divCycles: mc.divCycles });
  const cycles: Cycle[] = [];
  /** For each cycle, the number of instructions completed before it. */
  const done: number[] = [];
  let k = 0;
  for (;;) {
    const ok = m.cycle();
    if (m.last && m.last.n === cycles.length) { cycles.push(m.last); done.push(k); if (m.last.last) k++; }
    if (!ok || cycles.length >= MAX_CYCLES) break;
  }
  return { cycles, done, mulCycles: mc.mulCycles };
}

export function ArchPathFsmDemo() {
  const [id, setId] = useState("sum");
  const [k, setK] = useState(0);
  const run = useMemo(() => runMulti(id), [id]);
  const n = run.cycles.length;
  const i = Math.min(k, n - 1);
  const c = run.cycles[i]!;
  // the states of the current instruction so far: walk back to its Fetch
  let s0 = i;
  while (s0 > 0 && c.state !== "Fetch" && run.cycles[s0]!.state !== "Fetch") s0--;
  const states = run.cycles.slice(s0, i + 1).map((x) => x.state);
  const prev = i > 0 && c.state !== "Fetch" ? run.cycles[i - 1]!.state : i > 0 ? run.cycles[i - 1]!.state : null;
  const instWord = c.state === "Fetch" ? c.memOut : c.ir;
  const instPc = c.state === "Fetch" ? c.pc : c.oldPc;
  const ctl = c.ctrl;
  const instDone = run.done[i]! + (c.last ? 1 : 0);
  const reg = (name: string, v: string, written: boolean, note?: string): ReactNode[] => [
    name, <span key="v" style={mono}>{v}</span>, written ? <span key="w" style={{ color: "var(--c2)" }}>{note ?? "written at the edge"}</span> : "",
  ];
  return (
    <Demo
      title="Multi-cycle machine: the FSM steps one state per clock"
      actions={<IndexButtons k={i} n={n} set={setK} />}
      controls={
        <>
          <Param spec={range({ label: "Cycle", min: 1, max: n, step: 1, default: 1, format: (v) => `${v} of ${n}` })} value={i + 1} onChange={(v) => setK((v as number) - 1)} />
          <Param spec={PROGRAM} value={id} onChange={(v) => { setId(v as string); setK(0); }} />
        </>
      }
    >
      <FsmSvg cur={c.state} prev={prev} path={new Set(states)} />
      <StepCaption tone="info" label={`cycle ${i + 1}`}>
        <b>{c.state}</b> for <span style={mono}>{disasm(instWord, instPc, { pseudo: true })}</span>: {STATE_ABOUT[c.state]}.
      </StepCaption>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
        {states.map((s, j) => <Chip key={j} color="var(--c1)" filled={j === states.length - 1}>{s}</Chip>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 6 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>Control signals of this state</SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {MULTI_SIGNALS.map((k2) => <Chip key={k2} color={ctl[k2] ? "var(--c2)" : "var(--muted)"} faint={!ctl[k2] && !MULTI_VALUE_NAMES[k2]}>{sigText(k2, ctl[k2])}</Chip>)}
          </div>
          <SectionLabel>This cycle</SectionLabel>
          <div style={{ fontSize: 12.5, ...mono, lineHeight: 1.6 }}>
            <div>ALU: {fmtWord(c.srcA)} {c.aluCtl} {fmtWord(c.srcB)} = {fmtWord(c.aluY)}</div>
            {(c.state === "Fetch" || c.state === "MemRead") && <div>memory read at {fmtAddr(c.adr)}: {c.state === "Fetch" ? `0x${(c.memOut >>> 0).toString(16).padStart(8, "0")}` : fmtWord(c.memOut)}</div>}
            {c.state === "MemWrite" && <div>memory write at {fmtAddr(c.adr)}: {fmtWord(c.b)}</div>}
            {c.regWrite > 0 && <div>register x{c.regWrite} ← {fmtWord(c.result)}</div>}
            {c.pcWrite && <div>PC ← {fmtAddr(c.state === "Fetch" ? c.result : c.result & ~1)}</div>}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>Registers between cycles (values at the start of the cycle)</SectionLabel>
          <MiniTable head={["register", "value", ""]} rows={[
            reg("PC", fmtAddr(c.pc), c.pcWrite),
            reg("OldPC", fmtAddr(c.oldPc), !!ctl.IRWrite),
            reg("IR", c.state === "Fetch" ? "(old)" : disasm(c.ir, c.oldPc, { pseudo: true }), !!ctl.IRWrite),
            reg("A", fmtWord(c.a), true, "every cycle"),
            reg("B", fmtWord(c.b), true, "every cycle"),
            reg("ALUOut", fmtWord(c.aluOut), true, "every cycle"),
            reg("Data", fmtWord(c.data), true, "every cycle"),
          ]} />
        </div>
      </div>
      <Stats items={[
        { label: "cycles so far", value: int(i + 1) },
        { label: "instructions done", value: int(instDone) },
        { label: "CPI so far", value: instDone ? fixed((i + 1) / instDone, 2) : "–" },
        { label: "cycles of the whole run", value: int(n) },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- iron law

const ISA = select<Isa>({ label: "Hardware implements", options: [{ value: "RV32I", label: "RV32I" }, { value: "RV32I+mul", label: "RV32I + multiplier" }, { value: "RV32IM", label: "RV32IM (with divider)" }], default: "RV32I" });

export function ArchPathIronLawDemo() {
  const [id, setId] = useState("sum");
  const [isa, setIsa] = useState<Isa>("RV32I");
  const [mem, setMem] = useState(DEFAULT_DELAYS.imem);
  const [aluD, setAlu] = useState(DEFAULT_DELAYS.alu);
  const [ovh, setOvh] = useState(DEFAULT_DELAYS.clkQ + DEFAULT_DELAYS.setup);
  const d = { ...DEFAULT_DELAYS, imem: mem, dmem: mem, alu: aluD, clkQ: Math.round(ovh * 0.6), setup: ovh - Math.round(ovh * 0.6) };
  const mix = useMemo(() => mixOfProgram(id), [id]);
  const law = ironLaw(mix, d, isa);
  const mc = multiCycleClock(d);
  const cannot = (law.needsMul && isa === "RV32I") || (law.needsDiv && isa !== "RV32IM");
  const max = Math.max(law.single.ps, law.multi.ps);
  const bar = (label: string, t: { ic: number; cpi: number; tc: number; ps: number }, color: string) => (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, gap: 8 }}>
        <span>{label}</span>
        <span style={mono}>{int(t.ic)} × {fixed(t.cpi, 2)} × {t.tc} ps = <b>{sig(t.ps / 1000, 4)} ns</b></span>
      </div>
      <div style={{ height: 14, background: "var(--subtle)", borderRadius: 3, border: "1px solid var(--border)", overflow: "hidden" }}>
        <div style={{ width: `${(t.ps / max) * 100}%`, height: "100%", background: color, transition: "width 0.25s" }} />
      </div>
    </div>
  );
  const present = TCLASSES.filter((c) => mix[c] > 0);
  const stepMax = Math.max(...mc.steps.map((s) => s.ps));
  return (
    <Demo
      title="Iron law: instructions × CPI × clock period"
      controls={
        <>
          <Param spec={range({ label: "Memory access (ps)", min: 50, max: 500, step: 10, default: DEFAULT_DELAYS.imem })} value={mem} onChange={(v) => setMem(v as number)} />
          <Param spec={range({ label: "ALU (ps)", min: 50, max: 500, step: 10, default: DEFAULT_DELAYS.alu })} value={aluD} onChange={(v) => setAlu(v as number)} />
          <Param spec={range({ label: "Register overhead: clock-to-Q + setup (ps)", min: 0, max: 200, step: 10, default: 50 })} value={ovh} onChange={(v) => setOvh(v as number)} />
          <Param spec={ISA} value={isa} onChange={(v) => setIsa(v as Isa)} />
          <Param spec={PROGRAM} value={id} onChange={(v) => setId(v as string)} />
        </>
      }
    >
      {bar("Single-cycle", law.single, "var(--c3)")}
      {bar("Multi-cycle", law.multi, "var(--c1)")}
      {cannot
        ? <Banner tone="bad">This program uses mul, so it needs hardware with a multiplier. Pick another machine.</Banner>
        : <Banner tone={law.speedup > 1 ? "good" : "warn"}>{law.speedup > 1 ? `Multi-cycle is ${fixed(law.speedup, 2)} times faster.` : `Single-cycle is ${fixed(1 / law.speedup, 2)} times faster.`} The single-cycle clock fits {TCLASS_EXAMPLE[criticalPathSlowest(d, isa)]}; the multi-cycle clock fits its slowest step, {mc.slowest}.</Banner>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>Instruction mix of {id}</SectionLabel>
          <MiniTable head={["class", "count", "multi cycles", "single path"]} rows={present.map((c) => [
            TCLASS_EXAMPLE[c], int(mix[c]), String(multiCycles(c, mc.mulCycles, mc.divCycles)), `${criticalPath(c, d).total} ps`,
          ])} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>Multi-cycle step times (the clock is the longest)</SectionLabel>
          <div style={{ display: "grid", gap: 2 }}>
            {mc.steps.map((s) => (
              <div key={s.state} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                <span style={{ width: 70, minWidth: 70, ...mono, fontWeight: s.state === mc.slowest ? 700 : 400 }}>{s.state}</span>
                <div style={{ flex: 1, height: 9, background: "var(--subtle)", borderRadius: 2 }}>
                  <div style={{ width: `${(s.ps / stepMax) * 100}%`, height: "100%", borderRadius: 2, background: s.state === mc.slowest ? "var(--c4)" : tint("var(--c1)", 60) }} />
                </div>
                <span style={{ width: 48, textAlign: "right", ...mono }} className="muted">{s.ps} ps</span>
              </div>
            ))}
          </div>
          <SmallLabel style={{ marginTop: 6 }}>mul takes {mc.mulCycles} cycles and div {mc.divCycles}: a unit gets ⌈delay / {mc.budget} ps⌉ cycles.</SmallLabel>
        </div>
      </div>
    </Demo>
  );
}

function criticalPathSlowest(d: typeof DEFAULT_DELAYS, isa: Isa) {
  const cls = TCLASSES.filter((c) => (c === "Mul" ? isa !== "RV32I" : c === "Div" ? isa === "RV32IM" : true));
  return cls.reduce((a, b) => (criticalPath(b, d).total > criticalPath(a, d).total ? b : a));
}

// ---------------------------------------------------------------- microcode

const TYPES: { label: string; type: OpType; m?: boolean }[] = [
  { label: "lw", type: "Load" }, { label: "sw", type: "Store" }, { label: "add", type: "R" }, { label: "addi", type: "I-ALU" },
  { label: "beq", type: "Branch" }, { label: "jal", type: "JAL" }, { label: "jalr", type: "JALR" }, { label: "lui", type: "LUI" },
  { label: "auipc", type: "AUIPC" }, { label: "ecall", type: "System" }, { label: "mul", type: "R", m: true },
];
const seqText = (s: State) => {
  const q = MICROCODE[s];
  return q.kind === "next" ? `next ${q.to}` : q.kind === "wait" ? `wait, then ${q.to}` : q.kind === "fetch" ? "fetch" : q.kind === "dispatch1" ? "dispatch 1" : "dispatch 2";
};
const FIELD_SHORT: Record<keyof MultiControls, string> = { AdrSrc: "Adr", IRWrite: "IRW", PCUpdate: "PCU", Branch: "Br", ALUSrcA: "SrcA", ALUSrcB: "SrcB", ALUOp: "ALUOp", ResultSrc: "Res", MemWrite: "MemW", RegWrite: "RegW", Sys: "Sys" };

export function ArchPathMicrocodeDemo() {
  const [t, setT] = useState(0);
  const [k, setK] = useState(0);
  const ty = TYPES[t]!;
  const mc = multiCycleClock();
  const path = statePath(ty.type, !!ty.m, ty.m ? mc.mulCycles : 1);
  const i = Math.min(k, path.length - 1);
  const cur = path[i]!;
  const size = microcodeSize();
  const cell: CSSProperties = { padding: "1px 5px", textAlign: "center", whiteSpace: "nowrap" };
  const bits = (v: number, b: number) => v.toString(2).padStart(b, "0");
  const word = MULTI_SIGNALS.map((f) => bits(STATE_CONTROLS[cur][f], MULTI_SIGNAL_BITS[f])).join(" ");
  return (
    <Demo
      title="The same control as a microprogram"
      actions={<IndexButtons k={i} n={path.length} set={setK} />}
      controls={<Param spec={select({ label: "Instruction", options: TYPES.map((x, j) => ({ value: String(j), label: x.label })), default: "0" })} value={String(t)} onChange={(v) => { setT(Number(v)); setK(0); }} />}
    >
      <SmallLabel>One row per micro-address: the control word, then how to pick the next row. The rows {ty.label} visits are tinted; the current one is bold.</SmallLabel>
      <div style={{ overflowX: "auto", maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 6 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11, ...mono, width: "100%", minWidth: 640 }}>
          <thead>
            <tr className="muted" style={{ fontSize: 10.5 }}>
              <th style={{ ...cell, textAlign: "left" }}>addr</th>
              <th style={{ ...cell, textAlign: "left" }}>state</th>
              {MULTI_SIGNALS.map((f) => <th key={f} style={cell} title={f}>{FIELD_SHORT[f]}</th>)}
              <th style={{ ...cell, textAlign: "left" }}>sequencing</th>
            </tr>
          </thead>
          <tbody>
            {STATES.map((s, a) => {
              const on = s === cur, seen = path.includes(s);
              return (
                <tr key={s} style={{ borderTop: "1px solid var(--border)", background: on ? tint("var(--c1)", 32) : seen ? tint("var(--c1)", 12) : undefined, fontWeight: on ? 700 : 400 }}>
                  <td style={{ ...cell, textAlign: "left" }} className="muted">{bits(a, size.stateBits)}</td>
                  <td style={{ ...cell, textAlign: "left" }}>{s}</td>
                  {MULTI_SIGNALS.map((f) => <td key={f} style={{ ...cell, color: STATE_CONTROLS[s][f] ? "var(--fg)" : "var(--faint)" }}>{STATE_CONTROLS[s][f]}</td>)}
                  <td style={{ ...cell, textAlign: "left", color: "var(--c2)" }}>{seqText(s)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <StepCaption tone="info" label={`μstep ${i + 1} of ${path.length}`}>
        <b>{cur}</b>: {STATE_ABOUT[cur]}. Control word: <span style={mono}>{word}</span>. {MICROCODE[cur].kind === "dispatch1"
          ? `Dispatch ROM 1 maps opcode 0b${(OPCODE_OF[ty.type] >> 2).toString(2).padStart(5, "0")}11${ty.type === "R" ? ` with funct7[0] = ${ty.m ? 1 : 0}` : ""} to ${dispatch1(ty.type, !!ty.m)}.`
          : MICROCODE[cur].kind === "dispatch2" ? `Dispatch ROM 2 picks ${ty.type === "Load" ? "MemRead" : "MemWrite"} from opcode bit 5.` : ""}
      </StepCaption>
      <Stats items={[
        { label: "microinstruction width", value: `${size.width} bits` },
        { label: "control store", value: `${size.words} × ${size.width} = ${size.bits} bits` },
        { label: "dispatch ROMs", value: `${size.d1.rows * size.d1.width + size.d2.rows * size.d2.width} bits` },
        { label: `cycles for ${ty.label}`, value: String(path.length) },
      ]} />
    </Demo>
  );
}

