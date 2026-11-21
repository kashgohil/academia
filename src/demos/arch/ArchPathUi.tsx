/**
 * Views of the datapath module (src/sims/arch/datapath):
 * - DatapathSvg: the single-cycle RV32IM datapath as units and wires. Live wires (the ones whose value reaches a state
 *   element for this instruction) are drawn in color; `hot` wires (a critical path) in a second color. Values and
 *   control settings are small labels next to the wires and units.
 * - fmtWord / fmtAddr: number formats for wire values.
 * The SVG is 760 units wide; on a narrow screen it scrolls inside its own box.
 */
import type { CSSProperties, ReactNode } from "react";
import { MONO, tint, useWidth } from "../../kit";
import { liveEdges, SIGNAL_SPEC, type Unit, type Wires } from "../../sims/arch/datapath";

/** A data value: decimal when short, else hex. */
export const fmtWord = (v: number) => (v > -10000 && v < 100000 ? String(v | 0) : `0x${(v >>> 0).toString(16)}`);
/** An address: always hex. */
export const fmtAddr = (v: number) => `0x${(v >>> 0).toString(16)}`;

type Shape = { kind: "rect"; x: number; y: number; w: number; h: number; label: string[] } | { kind: "mux"; x: number; y: number; w: number; h: number } | { kind: "adder"; x: number; y: number; w: number; h: number; label: string } | { kind: "alu" };

/** Where each unit is drawn. */
const SHAPES: Record<Unit, Shape> = {
  PCMux: { kind: "mux", x: 10, y: 170, w: 20, h: 60 },
  PC: { kind: "rect", x: 42, y: 185, w: 44, h: 30, label: ["PC"] },
  IMem: { kind: "rect", x: 110, y: 160, w: 80, h: 100, label: ["Instruction", "memory"] },
  PC4: { kind: "adder", x: 110, y: 38, w: 50, h: 44, label: "+4" },
  Ctrl: { kind: "rect", x: 232, y: 14, w: 100, h: 48, label: ["Main decoder"] },
  ALUDec: { kind: "rect", x: 470, y: 14, w: 84, h: 40, label: ["ALU decoder"] },
  RF: { kind: "rect", x: 250, y: 150, w: 100, h: 120, label: ["Registers"] },
  Imm: { kind: "rect", x: 250, y: 300, w: 100, h: 42, label: ["Imm gen"] },
  SrcA: { kind: "mux", x: 390, y: 150, w: 16, h: 50 },
  SrcB: { kind: "mux", x: 390, y: 222, w: 16, h: 68 },
  ALU: { kind: "alu" },
  BrLogic: { kind: "rect", x: 545, y: 86, w: 82, h: 36, label: ["Branch logic"] },
  DMem: { kind: "rect", x: 570, y: 170, w: 100, h: 100, label: ["Data", "memory"] },
  Result: { kind: "mux", x: 710, y: 180, w: 16, h: 80 },
  PCImm: { kind: "adder", x: 440, y: 328, w: 60, h: 44, label: "+" },
  Target: { kind: "mux", x: 600, y: 312, w: 16, h: 60 },
};

/** The wire of each drawn edge "from>to". Several M moves make one wire with branches. */
export const EDGE_PATHS: Record<string, string> = {
  "PC>IMem": "M86 200 H110",
  "PC>PC4": "M86 200 H95 V50 H110",
  "PC>SrcA": "M86 200 H95 V142 H380 V175 H390",
  "PC>PCImm": "M86 200 H95 V362 H440",
  "PC4>PCMux": "M160 60 H170 V10 H4 V190 H10",
  "PC4>Result": "M160 60 H200 V128 H700 V245 H710",
  "IMem>Ctrl": "M190 210 H215 V38 H232",
  "IMem>RF": "M190 210 H215 V165 H250 M215 190 H250 M215 215 H250",
  "IMem>Imm": "M190 210 H215 V321 H250",
  "IMem>ALUDec": "M190 210 H215 V75 H455 V44 H470",
  "Ctrl>ALUDec": "M332 26 H470",
  "RF>SrcA": "M350 165 H390",
  "RF>SrcB": "M350 235 H390",
  "RF>DMem": "M350 235 H370 V300 H555 V250 H570",
  "Imm>SrcB": "M350 321 H378 V275 H390",
  "Imm>PCImm": "M350 321 H378 V345 H440",
  "SrcA>ALU": "M406 175 H425 V195 H440",
  "SrcB>ALU": "M406 256 H425 V245 H440",
  "ALUDec>ALU": "M500 54 V192",
  "ALU>BrLogic": "M470 181 V104 H545",
  "ALU>DMem": "M510 220 H540 V195 H570",
  "ALU>Result": "M510 220 H540 V290 H690 V195 H710",
  "ALU>Target": "M510 220 H540 V357 H600",
  "PCImm>Target": "M500 350 H520 V328 H600",
  "DMem>Result": "M670 220 H710",
  "Result>RFw": "M726 220 H750 V382 H232 V255 H250",
  "Target>PCMux": "M616 342 H640 V394 H4 V215 H10",
  "BrLogic>PCMux": "M627 104 H636 V3 H20 V172",
  "PCMux>PCw": "M30 200 H42",
};

/** Text at a point: [x, y, anchor]. */
export type At = [number, number, "start" | "middle" | "end"];
/** Wire value labels: where each is written, and the edges that make it visible (any one of them live). */
export const VALUE_LABELS: { id: string; at: At; when: string[] }[] = [
  { id: "pc", at: [64, 230, "middle"], when: ["PC>IMem"] },
  { id: "rd1", at: [370, 160, "middle"], when: ["RF>SrcA"] },
  { id: "rd2", at: [370, 230, "middle"], when: ["RF>SrcB", "RF>DMem"] },
  { id: "imm", at: [356, 315, "start"], when: ["Imm>SrcB", "Imm>PCImm"] },
  { id: "srcA", at: [424, 170, "middle"], when: ["SrcA>ALU"] },
  { id: "srcB", at: [424, 266, "middle"], when: ["SrcB>ALU"] },
  { id: "alu", at: [527, 213, "middle"], when: ["ALU>DMem", "ALU>Result", "ALU>Target", "ALU>BrLogic"] },
  { id: "mem", at: [690, 213, "middle"], when: ["DMem>Result"] },
  { id: "result", at: [746, 300, "end"], when: ["Result>RFw"] },
  { id: "pc4", at: [183, 54, "middle"], when: ["PC4>PCMux", "PC4>Result"] },
  { id: "pcImm", at: [568, 322, "middle"], when: ["PCImm>Target"] },
  { id: "target", at: [646, 372, "start"], when: ["Target>PCMux"] },
];
/** Where the control setting of each unit is written. */
const CTRL_AT: Partial<Record<Unit, At>> = {
  PCMux: [20, 244, "middle"], SrcA: [398, 138, "middle"], SrcB: [398, 213, "middle"], Result: [718, 276, "middle"],
  Target: [608, 305, "middle"],
};

const ALU_POINTS = "440,170 510,195 510,245 440,270 440,232 452,220 440,208";
const halo: CSSProperties = { paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3, strokeLinejoin: "round" };

export interface DatapathSvgProps {
  /** Edges "from>to" in use (colored). */
  live: Set<string>;
  /** Edges on a critical path (drawn above live ones, in a second color). */
  hot?: Set<string>;
  /** Values on wires, by VALUE_LABELS id (shown only when one of its edges is live or hot). */
  values?: Record<string, string>;
  /** Control settings shown next to muxes (PCMux, SrcA, SrcB, Result, Target). */
  ctrl?: Partial<Record<Unit, string>>;
  /** A second line of text inside a unit (a value, a control setting). */
  inside?: Partial<Record<Unit, ReactNode>>;
  /** Units drawn as broken (a fault is on their control). */
  broken?: Set<Unit>;
  minWidth?: number;
}

export function DatapathSvg({ live, hot, values = {}, ctrl = {}, inside = {}, broken, minWidth = 680 }: DatapathSvgProps) {
  const [ref, width] = useWidth<HTMLDivElement>(760);
  const w = Math.max(minWidth, Math.min(width, 900));
  const used = new Set<string>();
  for (const e of [...live, ...(hot ?? [])]) for (const n of e.split(">")) used.add(n);
  const edges = Object.keys(EDGE_PATHS);
  const order = [...edges.filter((e) => !live.has(e) && !hot?.has(e)), ...edges.filter((e) => live.has(e) && !hot?.has(e)), ...edges.filter((e) => hot?.has(e))];
  const unitStroke = (u: Unit) => (broken?.has(u) ? "var(--c4)" : used.has(u) ? "var(--fg)" : "var(--border)");
  const unitFill = (u: Unit) => (broken?.has(u) ? tint("var(--c4)", 14) : used.has(u) ? tint("var(--c1)", 10) : "var(--bg)");
  const textFill = (u: Unit) => (used.has(u) ? "var(--fg)" : "var(--muted)");
  return (
    <div ref={ref} style={{ overflowX: "auto", maxWidth: "100%" }}>
      <svg viewBox="0 0 760 402" width={w} height={(w * 402) / 760} style={{ display: "block", fontFamily: "inherit" }} role="img" aria-label="Single-cycle RISC-V datapath">
        {order.map((e) => {
          const on = live.has(e), h = hot?.has(e);
          return <path key={e} d={EDGE_PATHS[e]} fill="none" stroke={h ? "var(--c4)" : on ? "var(--c1)" : "var(--border)"} strokeWidth={h ? 2.8 : on ? 2 : 1.2} strokeLinejoin="round" />;
        })}
        {(Object.keys(SHAPES) as Unit[]).map((u) => {
          const s = SHAPES[u];
          const common = { stroke: unitStroke(u), fill: unitFill(u), strokeWidth: used.has(u) ? 1.5 : 1 };
          if (s.kind === "alu") return (
            <g key={u}>
              <polygon points={ALU_POINTS} {...common} />
              <text x={478} y={214} textAnchor="middle" fontSize={11} fontWeight={600} fill={textFill(u)}>ALU</text>
              {inside.ALU && <text x={478} y={234} textAnchor="middle" fontSize={10.5} fontFamily={MONO} fill="var(--c2)">{inside.ALU}</text>}
            </g>
          );
          if (s.kind === "mux") return (
            <g key={u}>
              <path d={`M${s.x} ${s.y} L${s.x + s.w} ${s.y + 8} V${s.y + s.h - 8} L${s.x} ${s.y + s.h} Z`} {...common} />
              <text x={s.x + s.w / 2} y={s.y + s.h / 2 + 3} textAnchor="middle" fontSize={8} fill="var(--muted)">mux</text>
            </g>
          );
          if (s.kind === "adder") return (
            <g key={u}>
              <path d={`M${s.x} ${s.y} L${s.x + s.w} ${s.y + 10} V${s.y + s.h - 10} L${s.x} ${s.y + s.h} V${s.y + s.h * 0.62} L${s.x + 8} ${s.y + s.h / 2} L${s.x} ${s.y + s.h * 0.38} Z`} {...common} />
              <text x={s.x + s.w / 2 + 4} y={s.y + s.h / 2 + 4} textAnchor="middle" fontSize={12} fontWeight={600} fill={textFill(u)}>{s.label}</text>
            </g>
          );
          const lines = s.label.length;
          return (
            <g key={u}>
              <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={5} {...common} />
              {s.label.map((l, i) => (
                <text key={i} x={s.x + s.w / 2} y={s.y + (inside[u] !== undefined ? 15 : s.h / 2 - (lines - 1) * 6 + 4) + i * 13} textAnchor="middle" fontSize={11} fontWeight={600} fill={textFill(u)}>{l}</text>
              ))}
              {inside[u] !== undefined && (
                <text x={s.x + s.w / 2} y={s.y + 15 + lines * 13 + 2} textAnchor="middle" fontSize={10} fontFamily={MONO} fill="var(--c2)">{inside[u]}</text>
              )}
            </g>
          );
        })}
        {(Object.keys(CTRL_AT) as Unit[]).map((u) => ctrl[u] && (
          <text key={u} x={CTRL_AT[u]![0]} y={CTRL_AT[u]![1]} textAnchor={CTRL_AT[u]![2]} fontSize={9.5} fill="var(--c2)" style={halo}>{ctrl[u]}</text>
        ))}
        {VALUE_LABELS.map(({ id, at: [x, y, a], when }) => values[id] !== undefined && when.some((e) => live.has(e) || hot?.has(e)) && (
          <text key={id} x={x} y={y} textAnchor={a} fontSize={10} fontFamily={MONO} fill="var(--fg)" style={halo}>{values[id]}</text>
        ))}
        {([["rs1", 162], ["rs2", 187], ["rd", 212], ["write", 252]] as const).map(([t, y]) => (
          <text key={t} x={y === 252 ? 241 : 233} y={y} textAnchor="middle" fontSize={8.5} fill="var(--muted)" style={halo}>{t}</text>
        ))}
      </svg>
    </div>
  );
}

const V = (sig: keyof typeof SIGNAL_SPEC, v: number) => SIGNAL_SPEC[sig].values[v] ?? String(v);

/** The props of DatapathSvg for one cycle of the single-cycle machine. */
export function wiresToView(w: Wires): Pick<DatapathSvgProps, "live" | "values" | "ctrl" | "inside"> {
  const c = w.ctrl;
  const live = liveEdges(c, c.Branch ? w.cond : undefined);
  return {
    live,
    values: {
      pc: fmtAddr(w.pc), rd1: fmtWord(w.rd1), rd2: fmtWord(w.rd2), imm: fmtWord(w.imm), srcA: fmtWord(w.srcA), srcB: fmtWord(w.srcB),
      alu: fmtWord(w.aluY), mem: fmtWord(w.memOut), result: fmtWord(w.result), pc4: fmtAddr(w.pc4), pcImm: fmtAddr(w.pcImm), target: fmtAddr(w.target),
    },
    ctrl: {
      PCMux: `PCSrc=${w.pcSrc}`, SrcA: `A: ${V("ALUSrcA", c.ALUSrcA)}`, SrcB: `B: ${V("ALUSrcB", c.ALUSrcB)}`,
      Result: V("ResultSrc", c.ResultSrc), Target: V("TargetSrc", c.TargetSrc),
    },
    inside: {
      IMem: `0x${(w.instr >>> 0).toString(16).padStart(8, "0")}`, Ctrl: w.type, ALUDec: `ALUOp=${V("ALUOp", c.ALUOp)}`, ALU: w.aluCtl,
      RF: `RegWrite=${c.RegWrite}`, Imm: `ImmSrc=${V("ImmSrc", c.ImmSrc)}`, DMem: c.MemWrite ? "write" : c.MemRead ? "read" : "idle",
      BrLogic: c.Branch ? (w.cond ? "taken" : "not taken") : c.Jump ? "jump" : "off",
    },
  };
}
