/**
 * A structural single-cycle RV32IM datapath. Each call to `step` is one clock cycle: it evaluates every unit in
 * order (PC, instruction memory, main decoder, register file, immediate generator, ALU input multiplexers, ALU,
 * branch logic, data memory, result multiplexer, target multiplexer, PC multiplexer), records the value on every
 * wire, and then does what the clock edge does: write rd, write the data memory, load the next PC.
 *
 * The control comes from the main decoder table (`MainTable` in control.ts) and the ALU decoder, so a demo can break
 * one control bit and run the machine. With the correct tables it must give the same registers, memory, output and
 * exit code as the hart (tests/unit/arch-datapath.test.ts checks this on every sample program, step by step).
 *
 * The same unit graph gives two more things:
 * - `liveEdges`: the wires whose values reach a state element (register file, data memory, PC) for one instruction,
 *   for the "light up the active paths" view;
 * - `criticalPath` (timing.ts): the longest delay through the units that one instruction class uses.
 *
 * Modelling choices (not facts about one chip): a memory read with MemRead = 0 gives 0 (the memory does not drive its
 * output); a don't-care control value acts as 0.
 */
import { decode, type Program } from "../rv";
import {
  alu, aluDecode, aluDecoderInputs, branchCond, IMM_SRCS, immGen, MAIN_TABLE, mainDecode,
  type AluDecoderBugs, type AluFlags, type AluOp, type Controls, type MainTable, type OpType,
} from "./control";
import { MachineState } from "./machine";

// ---------------------------------------------------------------- the unit graph

export const UNITS = ["PC", "IMem", "Ctrl", "ALUDec", "RF", "Imm", "PC4", "PCImm", "SrcA", "SrcB", "ALU", "BrLogic", "DMem", "Result", "Target", "PCMux"] as const;
export type Unit = (typeof UNITS)[number];
/** The three state elements that a clock edge writes. */
export const SINKS = ["RFw", "DMw", "PCw"] as const;
export type Sink = (typeof SINKS)[number];
export type Node = Unit | Sink;

export const UNIT_NAME: Record<Node, string> = {
  PC: "PC register", IMem: "instruction memory", Ctrl: "main decoder", ALUDec: "ALU decoder", RF: "register file read",
  Imm: "immediate generator", PC4: "PC + 4 adder", PCImm: "PC + imm adder", SrcA: "ALU input A mux", SrcB: "ALU input B mux",
  ALU: "ALU", BrLogic: "branch logic", DMem: "data memory", Result: "result mux", Target: "target mux", PCMux: "PC mux",
  RFw: "register write (setup)", DMw: "memory write", PCw: "PC setup",
};

/**
 * The inputs of a node that matter under a control word. `taken` is the branch outcome; undefined means "not known"
 * (for timing: the clock must fit both outcomes). Control (`Ctrl`) is an input of every multiplexer, because its
 * select must arrive too.
 */
export function inputsOf(n: Node, c: Controls, taken?: boolean): Node[] {
  switch (n) {
    case "PC": return [];
    case "IMem": return ["PC"];
    case "Ctrl": return ["IMem"];
    case "ALUDec": return ["Ctrl", "IMem"];
    case "RF": return ["IMem"];
    case "Imm": return ["IMem", "Ctrl"];
    case "PC4": return ["PC"];
    case "PCImm": return ["PC", "Imm"];
    case "SrcA": return c.ALUSrcA === 0 ? ["Ctrl", "RF"] : c.ALUSrcA === 1 ? ["Ctrl", "PC"] : ["Ctrl"];
    case "SrcB": return c.ALUSrcB === 1 ? ["Ctrl", "Imm"] : ["Ctrl", "RF"];
    case "ALU": return ["SrcA", "SrcB", "ALUDec"];
    case "BrLogic": return ["ALU", "Ctrl"];
    case "DMem": return c.MemWrite ? ["ALU", "Ctrl", "RF"] : ["ALU", "Ctrl"];
    case "Result": return ["Ctrl", c.ResultSrc === 1 ? "DMem" : c.ResultSrc === 2 ? "PC4" : "ALU"];
    case "Target": return ["Ctrl", c.TargetSrc === 1 ? "ALU" : "PCImm"];
    case "PCMux": {
      const sel: Node[] = c.Branch ? ["Ctrl", "BrLogic"] : ["Ctrl"];
      if (c.Jump) return [...sel, "Target"];
      if (!c.Branch) return [...sel, "PC4"];
      return taken === undefined ? [...sel, "PC4", "Target"] : [...sel, taken ? "Target" : "PC4"];
    }
    case "RFw": return c.RegWrite ? ["Result"] : [];
    case "DMw": return c.MemWrite ? ["DMem"] : [];
    case "PCw": return ["PCMux"];
  }
}

/** The edges (from → to) on a path to a state element that this instruction writes. */
export function liveEdges(c: Controls, taken?: boolean): Set<string> {
  const out = new Set<string>();
  const seen = new Set<Node>();
  const visit = (n: Node) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const i of inputsOf(n, c, taken)) { out.add(`${i}>${n}`); visit(i); }
  };
  for (const s of SINKS) visit(s);
  return out;
}

// ---------------------------------------------------------------- the machine

/** The value on every wire in one cycle. */
export interface Wires {
  pc: number;
  instr: number;
  type: OpType;
  ctrl: Controls;
  funct3: number;
  rs1: number; rs2: number; rd: number;
  /** Register file read ports. */
  rd1: number; rd2: number;
  imm: number;
  srcA: number; srcB: number;
  aluCtl: AluOp;
  aluY: number;
  flags: AluFlags;
  /** Branch logic: the condition of funct3 holds (only meaningful when Branch = 1). */
  cond: boolean;
  /** The PC mux select: 1 = take the target. */
  pcSrc: number;
  pc4: number; pcImm: number; target: number;
  /** Data memory: the value on the read port (after size and sign extension), 0 when MemRead = 0. */
  memOut: number;
  memSize: number;
  result: number;
  pcNext: number;
}

export interface SingleOptions { table?: MainTable; bugs?: AluDecoderBugs; memBytes?: number }

export class SingleCycle extends MachineState {
  readonly table: MainTable;
  readonly bugs: AluDecoderBugs;
  /** Wires of the last cycle (null before the first, and after a fetch trap). */
  wires: Wires | null = null;
  /** The register the last cycle wrote (0 = none). */
  lastRd = 0;
  /** Cycles run. Equal to `instret` here, but the multi-cycle machine differs. */
  cycles = 0;

  constructor(program: Program, opts: SingleOptions = {}) {
    super(program, opts.memBytes);
    this.table = opts.table ?? MAIN_TABLE;
    this.bugs = opts.bugs ?? {};
  }

  /** The wires the next cycle would show, without changing state (null if the fetch would trap). */
  evaluate(): Wires | null {
    const pc = this.pc;
    if (pc + 4 > this.mem.length || pc & 3) return null;
    const instr = this.peek(pc);
    const dec = decode(instr) ? mainDecode(instr, this.table) : null;
    if (!dec) return null;
    return this.combinational(pc, instr, dec.type, dec.ctrl, false);
  }

  /** All the combinational logic of one cycle. With `doLoad`, the data memory read can trap. */
  private combinational(pc: number, instr: number, type: OpType, c: Controls, doLoad: boolean): Wires | null {
    const r = this.regs;
    const rs1 = (instr >>> 15) & 31, rs2 = (instr >>> 20) & 31, rd = (instr >>> 7) & 31, funct3 = (instr >>> 12) & 7;
    const rd1 = r[rs1]!, rd2 = r[rs2]!;
    const imm = immGen(instr, IMM_SRCS[c.ImmSrc] ?? "I");
    const srcA = c.ALUSrcA === 0 ? rd1 : c.ALUSrcA === 1 ? pc | 0 : 0;
    const srcB = c.ALUSrcB === 1 ? imm : rd2;
    const aluCtl = aluDecode(aluDecoderInputs(instr, c.ALUOp), this.bugs);
    const { y: aluY, flags } = alu(aluCtl, srcA, srcB);
    const cond = branchCond(funct3, flags);
    const pc4 = (pc + 4) | 0, pcImm = (pc + imm) | 0;
    const target = c.TargetSrc === 1 ? aluY & ~1 : pcImm;
    const pcSrc = c.Jump || (c.Branch && cond) ? 1 : 0;
    const memSize = [1, 2, 4, 4][funct3 & 3]!;
    let memOut = 0;
    if (c.MemRead) {
      if (doLoad) {
        const v = this.load(pc, aluY, memSize, (funct3 & 4) === 0);
        if (v === null) return null;
        memOut = v;
      } else memOut = this.peek(aluY >>> 0, memSize as 1 | 2 | 4, (funct3 & 4) === 0) | 0;
    }
    const result = c.ResultSrc === 1 ? memOut : c.ResultSrc === 2 ? pc4 : aluY;
    const pcNext = pcSrc ? target : pc4;
    return { pc, instr, type, ctrl: c, funct3, rs1, rs2, rd, rd1, rd2, imm, srcA, srcB, aluCtl, aluY, flags, cond, pcSrc, pc4, pcImm, target, memOut, memSize, result, pcNext };
  }

  /** One clock cycle. Returns false once the machine has stopped (exit, ebreak, trap). */
  step(): boolean {
    if (this.status !== "running") return false;
    this.lastRd = 0; this.lastStore = null; this.wires = null;
    const pc = this.pc;
    const instr = this.fetch(pc);
    if (instr === null) return false;
    const dec = mainDecode(instr, this.table);
    if (!dec) return this.trap("illegal-instruction", pc, `opcode 0x${(instr & 0x7f).toString(16)} is not in the main decoder`);
    const w = this.combinational(pc, instr, dec.type, dec.ctrl, true);
    if (!w) return false;
    this.wires = w;
    const c = w.ctrl;
    if (w.pcSrc && w.pcNext & 3) return this.trap("instruction-address-misaligned", pc, `target 0x${(w.pcNext >>> 0).toString(16)} is not 4-byte aligned`);
    // the clock edge
    if (c.MemWrite && !this.store(pc, w.aluY, w.memSize, w.rd2)) return false;
    if (c.RegWrite && w.rd !== 0) { this.regs[w.rd] = w.result; this.lastRd = w.rd; }
    if (c.Sys) { const k = this.system(pc, instr); if (k) this.lastRd = k; if ((this.status as string) === "error") return false; }
    this.pc = w.pcNext >>> 0;
    this.instret++;
    this.cycles++;
    return this.status === "running";
  }

  run(maxSteps = 1_000_000): void {
    for (let i = 0; i < maxSteps && this.step(); i++);
  }
}
