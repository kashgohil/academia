/**
 * A structural multi-cycle RV32IM machine. It reuses one memory (for instructions and data), one ALU (also for PC + 4
 * and the branch target) and one register file over several short cycles. A finite state machine (FSM) sets the
 * control signals in each cycle. The design follows the multi-cycle RISC-V processor of Harris & Harris (Digital
 * Design and Computer Architecture, RISC-V edition, section 7.4), extended to all of RV32IM:
 *
 * - Non-architectural registers hold values between cycles: IR (the instruction) and OldPC (its address), written
 *   in Fetch; A and B (the two register reads), ALUOut and Data (the memory read), written in every cycle.
 * - Fetch: IR ← Mem[PC], PC ← PC + 4 (the ALU adds). Decode: A, B ← registers; ALUOut ← OldPC + imm (the
 *   branch target, computed before the FSM knows that it is a branch).
 * - Then one path per instruction type. lw 5 cycles, sw 4, R-type and I-type ALU 4, branches 3, jal 4 (as in
 *   Harris & Harris); jalr 5, lui and auipc 4, ecall and fence 3 (extensions of this model). An M instruction stays
 *   in ExecuteM for `mulCycles` or `divCycles` cycles (model inputs, default 1).
 *
 * The same FSM is also given as a microprogram (`MICROCODE`): one control word per state, plus a sequencing field.
 * Hardwired or microcoded, the machine does the same thing in each cycle.
 */
import { type Program } from "../rv";
import { alu, aluDecode, aluDecoderInputs, branchCond, IMM_SRCS, immGen, MAIN_TABLE, opTypeOf, type AluOp, type OpType } from "./control";
import { MachineState } from "./machine";

export const STATES = [
  "Fetch", "Decode", "MemAdr", "MemRead", "MemWB", "MemWrite", "ExecuteR", "ExecuteM", "ExecuteI", "ALUWB",
  "Branch", "JAL", "JALR", "LUI", "AUIPC", "System",
] as const;
export type State = (typeof STATES)[number];

/** The control word of the multi-cycle datapath. */
export interface MultiControls {
  /** Memory address: 0 = PC, 1 = Result. */
  AdrSrc: number;
  /** Write IR and OldPC. */
  IRWrite: number;
  /** Write PC unconditionally. */
  PCUpdate: number;
  /** Write PC if the branch condition holds. */
  Branch: number;
  /** ALU A: 0 = PC, 1 = OldPC, 2 = A, 3 = zero. */
  ALUSrcA: number;
  /** ALU B: 0 = B, 1 = Imm, 2 = 4. */
  ALUSrcB: number;
  /** 0 = add, 1 = sub, 2 = decode funct3 and funct7. */
  ALUOp: number;
  /** Result: 0 = ALUOut, 1 = Data, 2 = ALU result (this cycle). */
  ResultSrc: number;
  MemWrite: number;
  RegWrite: number;
  /** ecall or ebreak: hand over to the kernel. */
  Sys: number;
}

export const MULTI_SIGNALS = ["AdrSrc", "IRWrite", "PCUpdate", "Branch", "ALUSrcA", "ALUSrcB", "ALUOp", "ResultSrc", "MemWrite", "RegWrite", "Sys"] as const;
export const MULTI_SIGNAL_BITS: Record<keyof MultiControls, number> = {
  AdrSrc: 1, IRWrite: 1, PCUpdate: 1, Branch: 1, ALUSrcA: 2, ALUSrcB: 2, ALUOp: 2, ResultSrc: 2, MemWrite: 1, RegWrite: 1, Sys: 1,
};
export const MULTI_VALUE_NAMES: Partial<Record<keyof MultiControls, string[]>> = {
  AdrSrc: ["PC", "Result"], ALUSrcA: ["PC", "OldPC", "A", "0"], ALUSrcB: ["B", "Imm", "4"], ALUOp: ["add", "sub", "funct"], ResultSrc: ["ALUOut", "Data", "ALU"],
};

const Z: MultiControls = { AdrSrc: 0, IRWrite: 0, PCUpdate: 0, Branch: 0, ALUSrcA: 0, ALUSrcB: 0, ALUOp: 0, ResultSrc: 0, MemWrite: 0, RegWrite: 0, Sys: 0 };
const s = (p: Partial<MultiControls>): MultiControls => ({ ...Z, ...p });

/** The control word that each state asserts. */
export const STATE_CONTROLS: Record<State, MultiControls> = {
  Fetch: s({ AdrSrc: 0, IRWrite: 1, ALUSrcA: 0, ALUSrcB: 2, ALUOp: 0, ResultSrc: 2, PCUpdate: 1 }),
  Decode: s({ ALUSrcA: 1, ALUSrcB: 1, ALUOp: 0 }),
  MemAdr: s({ ALUSrcA: 2, ALUSrcB: 1, ALUOp: 0 }),
  MemRead: s({ ResultSrc: 0, AdrSrc: 1 }),
  MemWB: s({ ResultSrc: 1, RegWrite: 1 }),
  MemWrite: s({ ResultSrc: 0, AdrSrc: 1, MemWrite: 1 }),
  ExecuteR: s({ ALUSrcA: 2, ALUSrcB: 0, ALUOp: 2 }),
  ExecuteM: s({ ALUSrcA: 2, ALUSrcB: 0, ALUOp: 2 }),
  ExecuteI: s({ ALUSrcA: 2, ALUSrcB: 1, ALUOp: 2 }),
  ALUWB: s({ ResultSrc: 0, RegWrite: 1 }),
  Branch: s({ ALUSrcA: 2, ALUSrcB: 0, ALUOp: 1, ResultSrc: 0, Branch: 1 }),
  JAL: s({ ALUSrcA: 1, ALUSrcB: 2, ALUOp: 0, ResultSrc: 0, PCUpdate: 1 }),
  JALR: s({ ALUSrcA: 2, ALUSrcB: 1, ALUOp: 0 }),
  LUI: s({ ALUSrcA: 3, ALUSrcB: 1, ALUOp: 0 }),
  AUIPC: s({ ALUSrcA: 1, ALUSrcB: 1, ALUOp: 0 }),
  System: s({ Sys: 1 }),
};

/** What each state does, in one line. */
export const STATE_ABOUT: Record<State, string> = {
  Fetch: "IR ← Mem[PC]; OldPC ← PC; PC ← PC + 4 (the ALU adds)",
  Decode: "A ← rs1, B ← rs2; ALUOut ← OldPC + imm (a possible branch target)",
  MemAdr: "ALUOut ← A + imm (the address)",
  MemRead: "Data ← Mem[ALUOut]",
  MemWB: "rd ← Data",
  MemWrite: "Mem[ALUOut] ← B",
  ExecuteR: "ALUOut ← A op B",
  ExecuteM: "ALUOut ← A op B in the multiplier or divider",
  ExecuteI: "ALUOut ← A op imm",
  ALUWB: "rd ← ALUOut",
  Branch: "compare A - B; if the condition holds, PC ← ALUOut (the target)",
  JAL: "PC ← ALUOut (the target); ALUOut ← OldPC + 4 (the link)",
  JALR: "ALUOut ← A + imm (the target)",
  LUI: "ALUOut ← 0 + imm",
  AUIPC: "ALUOut ← OldPC + imm",
  System: "ecall or ebreak: the kernel runs; fence does nothing here",
};

/** The microcode sequencing field: how the next state is chosen. */
export type Seq = { kind: "next"; to: State } | { kind: "dispatch1" } | { kind: "dispatch2" } | { kind: "fetch" } | { kind: "wait"; to: State };

/** Dispatch ROM 1 (after Decode): by instruction type (and funct7[0] for R-type: M instructions). */
export function dispatch1(type: OpType, isM: boolean): State {
  switch (type) {
    case "Load": case "Store": return "MemAdr";
    case "R": return isM ? "ExecuteM" : "ExecuteR";
    case "I-ALU": return "ExecuteI";
    case "Branch": return "Branch";
    case "JAL": return "JAL";
    case "JALR": return "JALR";
    case "LUI": return "LUI";
    case "AUIPC": return "AUIPC";
    case "System": case "Fence": return "System";
  }
}
/** Dispatch ROM 2 (after MemAdr): load or store. */
export const dispatch2 = (type: OpType): State => (type === "Load" ? "MemRead" : "MemWrite");

export const MICROCODE: Record<State, Seq> = {
  Fetch: { kind: "next", to: "Decode" },
  Decode: { kind: "dispatch1" },
  MemAdr: { kind: "dispatch2" },
  MemRead: { kind: "next", to: "MemWB" },
  MemWB: { kind: "fetch" },
  MemWrite: { kind: "fetch" },
  ExecuteR: { kind: "next", to: "ALUWB" },
  ExecuteM: { kind: "wait", to: "ALUWB" },
  ExecuteI: { kind: "next", to: "ALUWB" },
  ALUWB: { kind: "fetch" },
  Branch: { kind: "fetch" },
  JAL: { kind: "next", to: "ALUWB" },
  JALR: { kind: "next", to: "JAL" },
  LUI: { kind: "next", to: "ALUWB" },
  AUIPC: { kind: "next", to: "ALUWB" },
  System: { kind: "fetch" },
};

/** Size of the microprogram as ROMs. Sequencing kinds: next, dispatch1, dispatch2, fetch, wait. */
export function microcodeSize() {
  const stateBits = Math.ceil(Math.log2(STATES.length));
  const controlBits = MULTI_SIGNALS.reduce((a, k) => a + MULTI_SIGNAL_BITS[k], 0);
  const seqKindBits = Math.ceil(Math.log2(5));
  const width = controlBits + seqKindBits + stateBits;
  const words = STATES.length;
  // dispatch 1 is addressed by opcode bits 6:2 and funct7[0]; dispatch 2 by opcode bit 5
  const d1 = { rows: 2 ** 6, width: stateBits };
  const d2 = { rows: 2, width: stateBits };
  return { stateBits, controlBits, seqKindBits, width, words, bits: words * width, d1, d2, total: words * width + d1.rows * d1.width + d2.rows * d2.width };
}

/** The states one instruction type walks through (an M instruction with k cycles repeats ExecuteM k times). */
export function statePath(type: OpType, isM = false, mCycles = 1): State[] {
  const out: State[] = ["Fetch", "Decode"];
  let st = dispatch1(type, isM);
  for (;;) {
    out.push(st);
    const q = MICROCODE[st];
    if (q.kind === "fetch") return out;
    if (q.kind === "wait") { for (let i = 1; i < mCycles; i++) out.push(st); st = q.to; continue; }
    st = q.kind === "next" ? q.to : q.kind === "dispatch2" ? dispatch2(type) : dispatch1(type, isM);
  }
}

// ---------------------------------------------------------------- the machine

/** Everything one cycle shows. Register values are the values at the start of the cycle. */
export interface Cycle {
  n: number;
  state: State;
  ctrl: MultiControls;
  pc: number; oldPc: number; ir: number; a: number; b: number; aluOut: number; data: number;
  srcA: number; srcB: number; aluCtl: AluOp; aluY: number;
  adr: number; memOut: number; result: number;
  /** The PC is written at the end of this cycle. */
  pcWrite: boolean;
  /** The register written at the end of this cycle (0 = none). */
  regWrite: number;
  /** The instruction ends with this cycle. */
  last: boolean;
}

export interface MultiOptions { mulCycles?: number; divCycles?: number; memBytes?: number }

export class MultiCycle extends MachineState {
  state: State = "Fetch";
  oldPc = 0;
  ir = 0;
  a = 0;
  b = 0;
  aluOut = 0;
  data = 0;
  cycles = 0;
  /** Cycles spent so far in the current ExecuteM. */
  private mDone = 0;
  readonly mulCycles: number;
  readonly divCycles: number;
  /** The last cycle (null before the first). */
  last: Cycle | null = null;
  lastRd = 0;

  constructor(program: Program, opts: MultiOptions = {}) {
    super(program, opts.memBytes);
    this.mulCycles = Math.max(1, opts.mulCycles ?? 1);
    this.divCycles = Math.max(1, opts.divCycles ?? 1);
  }

  /** One clock cycle. Returns false once the machine has stopped. */
  cycle(): boolean {
    if (this.status !== "running") return false;
    const st = this.state, c = STATE_CONTROLS[st];
    if (st === "Fetch") { this.lastRd = 0; this.lastStore = null; }
    const r = this.regs;
    // combinational logic of this cycle
    const type = opTypeOf(this.ir);
    const immSrc = type ? MAIN_TABLE[type].ImmSrc ?? 0 : 0;
    const imm = immGen(this.ir, IMM_SRCS[immSrc]!);
    const srcA = [this.pc | 0, this.oldPc | 0, this.a, 0][c.ALUSrcA]!;
    const srcB = [this.b, imm, 4][c.ALUSrcB]!;
    const aluCtl = aluDecode(aluDecoderInputs(this.ir, c.ALUOp));
    const { y: aluY, flags } = alu(aluCtl, srcA, srcB);
    const result = [this.aluOut, this.data, aluY][c.ResultSrc]!;
    const adr = c.AdrSrc ? result >>> 0 : this.pc;
    let memOut = 0;
    let newIr = this.ir;
    if (st === "Fetch") {
      const w = this.fetch(this.pc);
      if (w === null) return false;
      memOut = newIr = w;
    } else if (st === "MemRead") {
      const f3 = (this.ir >>> 12) & 7;
      const v = this.load(this.oldPc, adr, [1, 2, 4, 4][f3 & 3]!, (f3 & 4) === 0);
      if (v === null) return false;
      memOut = v;
    }
    const taken = c.Branch === 1 && branchCond((this.ir >>> 12) & 7, flags);
    const pcWrite = c.PCUpdate === 1 || taken;
    const pcNew = st === "Fetch" ? result : result & ~1;
    if (pcWrite && st !== "Fetch" && pcNew & 3) return this.trap("instruction-address-misaligned", this.oldPc, `target 0x${(pcNew >>> 0).toString(16)} is not 4-byte aligned`);
    const rd = (this.ir >>> 7) & 31;
    // the next state
    const isM = type === "R" && ((this.ir >>> 25) & 1) === 1;
    let next: State;
    const q = MICROCODE[st];
    if (st === "Fetch") next = "Decode";
    else if (q.kind === "next") next = q.to;
    else if (q.kind === "fetch") next = "Fetch";
    else if (q.kind === "dispatch1") next = dispatch1(type!, isM);
    else if (q.kind === "dispatch2") next = dispatch2(type!);
    else {
      const need = ((this.ir >>> 12) & 7) >= 4 ? this.divCycles : this.mulCycles;
      this.mDone++;
      next = this.mDone >= need ? q.to : st;
      if (next !== st) this.mDone = 0;
    }
    const regWrite = c.RegWrite && rd !== 0 ? rd : 0;
    this.last = {
      n: this.cycles, state: st, ctrl: c, pc: this.pc, oldPc: this.oldPc, ir: this.ir, a: this.a, b: this.b, aluOut: this.aluOut, data: this.data,
      srcA, srcB, aluCtl, aluY, adr, memOut, result, pcWrite, regWrite, last: next === "Fetch",
    };
    const readA = r[(this.ir >>> 15) & 31]!, readB = r[(this.ir >>> 20) & 31]!;
    // the clock edge
    if (c.MemWrite) {
      const f3 = (this.ir >>> 12) & 7;
      if (!this.store(this.oldPc, adr, [1, 2, 4, 4][f3 & 3]!, this.b)) return false;
    }
    if (regWrite) { r[regWrite] = result; this.lastRd = regWrite; }
    if (c.Sys) { const k = this.system(this.oldPc, this.ir); if (k) this.lastRd = k; if ((this.status as string) === "error") return false; }
    if (c.IRWrite) { this.ir = newIr; this.oldPc = this.pc; }
    if (pcWrite) this.pc = pcNew >>> 0;
    this.a = readA; // A and B load in every cycle: what the register file read during this cycle
    this.b = readB;
    this.aluOut = aluY;
    this.data = memOut;
    this.state = next;
    this.cycles++;
    if (next === "Fetch") this.instret++;
    return this.status === "running";
  }

  /** Run the cycles of one whole instruction. */
  step(): boolean {
    if (this.status !== "running") return false;
    do { if (!this.cycle()) return false; } while (this.state !== "Fetch");
    return this.status === "running";
  }

  run(maxCycles = 5_000_000): void {
    for (let i = 0; i < maxCycles && this.cycle(); i++);
  }
}
