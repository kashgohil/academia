/**
 * Timing of the single-cycle and the multi-cycle machine, from a delay per unit.
 *
 * MODEL INPUTS: every delay in `DEFAULT_DELAYS` is a round number of picoseconds chosen for teaching, in the range
 * that textbooks use. None of them is a measurement of a real chip. The shape of the results (which instruction is
 * the slowest, how much time the others waste, when the multi-cycle machine wins) is the lesson, not the values.
 *
 * - Single-cycle: `criticalPath` walks the unit graph of single.ts (`inputsOf`) under the control word of one
 *   instruction class, adds the delay of each unit (static timing analysis), and returns the latest arrival at a
 *   state element: the register file (plus its setup time), the data memory, or the PC (plus setup). The clock period
 *   must fit the slowest class that the hardware implements, even if a program never runs it.
 * - Multi-cycle: `stepTime` is the delay of the work in one FSM state; the clock period is the slowest step. A multiply
 *   or divide gets as many cycles as its unit needs: ceil(unit delay / ALU budget of one cycle).
 * - `ironLaw`: time = instructions × CPI × clock period, for a dynamic trace from the hart.
 */
import { type DynInst } from "../rv";
import { controlsOf, MAIN_TABLE, opTypeOf, type Controls } from "./control";
import { inputsOf, type Node } from "./single";
import { statePath, STATES, type State } from "./multi";

export interface Delays {
  /** Clock-to-output delay of a register (the PC, IR, ...). */
  clkQ: number;
  imem: number;
  /** The main decoder. */
  ctrl: number;
  aluDec: number;
  /** Register file read. */
  rf: number;
  imm: number;
  /** A 32-bit adder (PC + 4, PC + imm). */
  adder: number;
  mux: number;
  alu: number;
  /** A combinational 32 × 32 multiplier, in place of the ALU. */
  mul: number;
  /** A combinational 32-bit divider (a chain of 32 subtract-and-select stages), in place of the ALU. */
  div: number;
  dmem: number;
  brLogic: number;
  /** Setup time of the register file write. */
  rfSetup: number;
  /** Setup time of a plain register (PC, IR, ALUOut, ...). */
  setup: number;
}

/** MODEL INPUTS, in picoseconds. */
export const DEFAULT_DELAYS: Delays = {
  clkQ: 30, imem: 200, ctrl: 50, aluDec: 30, rf: 100, imm: 50, adder: 100, mux: 25, alu: 150,
  mul: 600, div: 32 * (100 + 25), dmem: 200, brLogic: 20, rfSetup: 30, setup: 20,
};

// ---------------------------------------------------------------- instruction classes for timing

export const TCLASSES = ["R", "I-ALU", "Load", "Store", "Branch", "JAL", "JALR", "LUI", "AUIPC", "System", "Mul", "Div"] as const;
export type TClass = (typeof TCLASSES)[number];
export const TCLASS_EXAMPLE: Record<TClass, string> = {
  R: "add", "I-ALU": "addi", Load: "lw", Store: "sw", Branch: "beq", JAL: "jal", JALR: "jalr", LUI: "lui", AUIPC: "auipc", System: "ecall", Mul: "mul", Div: "div",
};

/** The timing class of an instruction word. fence counts as System (it does nothing here). */
export function tclassOf(word: number): TClass {
  const t = opTypeOf(word);
  if (!t) return "System";
  if (t === "R" && ((word >>> 25) & 1) === 1) return ((word >>> 12) & 7) >= 4 ? "Div" : "Mul";
  if (t === "Fence") return "System";
  return t;
}

const ctrlOf = (c: TClass): Controls => controlsOf(MAIN_TABLE[c === "Mul" || c === "Div" ? "R" : c]);

// ---------------------------------------------------------------- single-cycle

export interface PathStep { node: Node; start: number; end: number }
export interface CriticalPath { cls: TClass; total: number; path: PathStep[]; arrival: Partial<Record<Node, number>> }

function unitDelay(n: Node, d: Delays, cls: TClass): number {
  switch (n) {
    case "PC": return d.clkQ;
    case "IMem": return d.imem;
    case "Ctrl": return d.ctrl;
    case "ALUDec": return d.aluDec;
    case "RF": return d.rf;
    case "Imm": return d.imm;
    case "PC4": case "PCImm": return d.adder;
    case "SrcA": case "SrcB": case "Result": case "Target": case "PCMux": return d.mux;
    case "ALU": return cls === "Mul" ? d.mul : cls === "Div" ? d.div : d.alu;
    case "BrLogic": return d.brLogic;
    case "DMem": return d.dmem;
    case "RFw": return d.rfSetup;
    case "DMw": return 0;
    case "PCw": return d.setup;
  }
}

/** The longest path, in ps, through the units that one instruction class uses (both branch outcomes count). */
export function criticalPath(cls: TClass, d: Delays = DEFAULT_DELAYS): CriticalPath {
  const c = ctrlOf(cls);
  const arrival: Partial<Record<Node, number>> = {};
  const from: Partial<Record<Node, Node | null>> = {};
  const at = (n: Node): number => {
    if (arrival[n] !== undefined) return arrival[n]!;
    let best = 0, arg: Node | null = null;
    for (const i of inputsOf(n, c)) { const t = at(i); if (t > best || arg === null) { best = t; arg = i; } }
    from[n] = arg;
    return (arrival[n] = best + unitDelay(n, d, cls));
  };
  const ends = (["RFw", "DMw", "PCw"] as Node[]).filter((s) => inputsOf(s, c).length > 0);
  let end: Node = "PCw";
  for (const s of ends) if (at(s) > at(end)) end = s;
  const path: PathStep[] = [];
  for (let n: Node | null | undefined = end; n; n = from[n]) path.unshift({ node: n, start: arrival[n]! - unitDelay(n, d, cls), end: arrival[n]! });
  return { cls, total: arrival[end]!, path, arrival };
}

export type Isa = "RV32I" | "RV32I+mul" | "RV32IM";
export const classesOf = (isa: Isa): TClass[] => TCLASSES.filter((c) => (c === "Mul" ? isa !== "RV32I" : c === "Div" ? isa === "RV32IM" : true));

/** The single-cycle clock: the slowest class that the hardware implements. */
export function singleCycleClock(d: Delays = DEFAULT_DELAYS, isa: Isa = "RV32I") {
  const paths = classesOf(isa).map((c) => criticalPath(c, d));
  const slowest = paths.reduce((a, b) => (b.total > a.total ? b : a));
  return { tc: slowest.total, slowest: slowest.cls, paths };
}

// ---------------------------------------------------------------- multi-cycle

/** The work in each FSM state and its delay. Several paths in one state run in parallel; the longest counts. */
export function stepPaths(st: State, d: Delays = DEFAULT_DELAYS): { what: string; ps: number }[] {
  const aluIn = Math.max(d.mux, d.aluDec); // ALU inputs: the source muxes and the ALU decoder work in parallel
  const aluStep = { what: "register → mux → ALU → ALUOut", ps: d.clkQ + aluIn + d.alu + d.setup };
  switch (st) {
    case "Fetch": return [
      { what: "PC → address mux → memory → IR", ps: d.clkQ + d.mux + d.imem + d.setup },
      { what: "PC → mux → ALU (+4) → result mux → PC", ps: d.clkQ + d.mux + d.alu + d.mux + d.setup },
    ];
    case "Decode": return [
      { what: "IR → register file → A, B", ps: d.clkQ + d.rf + d.setup },
      { what: "IR → immediate → mux → ALU (OldPC + imm) → ALUOut", ps: d.clkQ + d.imm + d.mux + d.alu + d.setup },
      { what: "IR → decoder → next state", ps: d.clkQ + d.ctrl + d.setup },
    ];
    case "MemAdr": case "ExecuteR": case "ExecuteI": case "JALR": case "LUI": case "AUIPC": return [aluStep];
    case "ExecuteM": return [aluStep];
    case "MemRead": return [{ what: "ALUOut → result mux → address mux → memory → Data", ps: d.clkQ + d.mux + d.mux + d.dmem + d.setup }];
    case "MemWrite": return [{ what: "ALUOut → result mux → address mux → memory write", ps: d.clkQ + d.mux + d.mux + d.dmem }];
    case "MemWB": case "ALUWB": return [{ what: "Data or ALUOut → result mux → register file", ps: d.clkQ + d.mux + d.rfSetup }];
    case "Branch": return [{ what: "A, B → ALU (subtract) → branch logic → PC enable", ps: d.clkQ + aluIn + d.alu + d.brLogic + d.setup }];
    case "JAL": return [
      { what: "ALUOut → result mux → PC", ps: d.clkQ + d.mux + d.setup },
      { what: "OldPC → mux → ALU (+4) → ALUOut", ps: d.clkQ + aluIn + d.alu + d.setup },
    ];
    case "System": return [{ what: "state → kernel hand-over", ps: d.clkQ + d.ctrl + d.setup }];
  }
}
export const stepTime = (st: State, d: Delays = DEFAULT_DELAYS) => Math.max(...stepPaths(st, d).map((p) => p.ps));

/** The multi-cycle clock (the slowest step) and the cycles an M operation needs at that clock. */
export function multiCycleClock(d: Delays = DEFAULT_DELAYS) {
  const steps = STATES.map((s) => ({ state: s, ps: stepTime(s, d) }));
  const slowest = steps.reduce((a, b) => (b.ps > a.ps ? b : a));
  const tc = slowest.ps;
  const budget = tc - d.clkQ - Math.max(d.mux, d.aluDec) - d.setup; // time left for the unit inside one cycle
  return { tc, slowest: slowest.state, steps, budget, mulCycles: Math.max(1, Math.ceil(d.mul / budget)), divCycles: Math.max(1, Math.ceil(d.div / budget)) };
}

/** Cycles of one class in the multi-cycle machine. */
export function multiCycles(cls: TClass, mulCycles = 1, divCycles = 1): number {
  if (cls === "Mul") return statePath("R", true, mulCycles).length;
  if (cls === "Div") return statePath("R", true, divCycles).length;
  return statePath(cls, false).length;
}

// ---------------------------------------------------------------- the iron law

export type Mix = Record<TClass, number>;
export const emptyMix = (): Mix => Object.fromEntries(TCLASSES.map((c) => [c, 0])) as Mix;
export function mixOf(trace: readonly DynInst[]): Mix {
  const m = emptyMix();
  for (const t of trace) m[tclassOf(t.word)]++;
  return m;
}

export interface MachineTime { ic: number; cycles: number; cpi: number; tc: number; ps: number }
export interface IronLaw { single: MachineTime; multi: MachineTime; speedup: number; needsMul: boolean; needsDiv: boolean }

/**
 * Execution time of one instruction mix on both machines. The single-cycle clock fits every class of `isa`; the
 * multi-cycle clock is its slowest step, and M operations take extra cycles.
 */
export function ironLaw(mix: Mix, d: Delays = DEFAULT_DELAYS, isa: Isa = "RV32I"): IronLaw {
  const ic = TCLASSES.reduce((s, c) => s + mix[c], 0);
  const sc = singleCycleClock(d, isa);
  const mc = multiCycleClock(d);
  const cycles = TCLASSES.reduce((s, c) => s + mix[c] * multiCycles(c, mc.mulCycles, mc.divCycles), 0);
  const single: MachineTime = { ic, cycles: ic, cpi: 1, tc: sc.tc, ps: ic * sc.tc };
  const multi: MachineTime = { ic, cycles, cpi: ic ? cycles / ic : 0, tc: mc.tc, ps: cycles * mc.tc };
  return { single, multi, speedup: multi.ps ? single.ps / multi.ps : 0, needsMul: mix.Mul > 0, needsDiv: mix.Div > 0 };
}

/** Time the single-cycle machine wastes: per class (clock - need) and as a fraction of all time for a mix. */
export function waste(mix: Mix, d: Delays = DEFAULT_DELAYS, isa: Isa = "RV32I") {
  const sc = singleCycleClock(d, isa);
  const need = Object.fromEntries(sc.paths.map((p) => [p.cls, p.total])) as Partial<Record<TClass, number>>;
  let used = 0, total = 0;
  for (const c of TCLASSES) if (mix[c] && need[c] !== undefined) { used += mix[c] * need[c]!; total += mix[c] * sc.tc; }
  return { tc: sc.tc, need, fraction: total ? 1 - used / total : 0 };
}

