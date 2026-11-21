/**
 * Where the out-of-order model gets its instructions and values from: the shared hart (src/sims/arch/rv/hart.ts).
 *
 * - The correct path comes from one hart (the oracle), stepped lazily as fetch needs more instructions. Its DynInsts
 *   carry the register values, results, memory addresses and branch outcomes.
 * - A wrong path (after a mispredicted branch, or after an instruction that faults) comes from a fork: a new hart with
 *   the oracle's registers and memory at that point in program order, started at the wrong pc. So wrong-path loads use
 *   real addresses and read real (speculative) values, which is what leaves a cache footprint.
 * - A faulting instruction does not retire on the hart. The oracle stops with an error; this module turns it into a
 *   DynInst with a `fault`, so the core can fetch it, execute it, and raise the trap when it reaches the ROB head.
 */
import { classOf, decode, Hart, type DynInst, type HartError, type HartStatus, type Program } from "../rv";

export interface FetchInst {
  d: DynInst;
  /** The architectural register written: the DynInst's rd, plus a0 for an ecall that is not exit. */
  rd: number;
  fault: HartError | null;
  /** The instruction ended the program (exit or ebreak). */
  last: boolean;
}

const NOP = { op: "addi" as const, rd: 0, rs1: 0, rs2: 0, imm: 0 };

/** A DynInst for an instruction that traps, from the hart state just before it. */
function faultInst(h: Hart, seq: number): DynInst {
  const err = h.error!;
  const pc = err.pc;
  const word = pc + 4 <= h.memBytes ? h.peek(pc) : 0;
  const inst = decode(word);
  const i = inst ?? NOP;
  const cls = inst ? classOf(i.op) : "system";
  const d: DynInst = {
    seq, pc, word, inst: i, cls, rd: 0, rs1: inst ? i.rs1 : 0, rs2: 0,
    rs1Val: inst ? h.regs[i.rs1]! : 0, rs2Val: 0, result: 0, nextPc: (pc + 4) >>> 0,
  };
  if (inst && (cls === "load" || cls === "store")) {
    d.memAddr = (h.regs[i.rs1]! + i.imm) >>> 0;
    d.memSize = /w$/.test(i.op) ? 4 : /h|hu$/.test(i.op) ? 2 : 1;
    if (cls === "store") { d.rs2 = i.rs2; d.rs2Val = h.regs[i.rs2]!; }
  }
  return d;
}

/** Step a hart once and describe what it did, or null if it had stopped. */
function stepOne(h: Hart, seq: number): FetchInst | null {
  if (h.status !== "running") return null;
  h.step();
  const status = h.status as HartStatus;
  if (status === "error") return { d: faultInst(h, seq), rd: 0, fault: h.error, last: true };
  const d = h.snapshot().last!;
  const exitNow = status === "exited" || status === "ebreak";
  const rd = d.inst.op === "ecall" && !exitNow ? 10 : d.rd;
  return { d: { ...d, seq }, rd, fault: null, last: exitNow };
}

export class Oracle {
  readonly program: Program;
  readonly memBytes: number;
  readonly hart: Hart;
  readonly list: FetchInst[] = [];
  /** The initial memory image (text and data), before any instruction ran. */
  readonly initialMem: Uint8Array;

  constructor(program: Program, memBytes: number) {
    this.program = program;
    this.memBytes = memBytes;
    this.hart = new Hart(program, { memBytes, trace: false, onInst: () => {} });
    this.initialMem = this.hart.mem.slice();
  }

  /** The correct-path instruction with index `seq`, or null past the end of the program. */
  at(seq: number): FetchInst | null {
    while (this.list.length <= seq) {
      const f = stepOne(this.hart, this.list.length);
      if (!f) return null;
      this.list.push(f);
    }
    return this.list[seq]!;
  }

  /**
   * A wrong path that starts at `pc`, from the architectural state after the first `count` correct-path instructions.
   * A fault there ends the wrong path (the fork stops).
   */
  fork(pc: number, count: number): WrongPath {
    let base = this.hart;
    if (this.hart.instret !== count) {
      base = new Hart(this.program, { memBytes: this.memBytes, trace: false });
      base.run({ maxSteps: count });
    }
    const h = new Hart(this.program, { memBytes: this.memBytes, trace: false, onInst: () => {} });
    h.mem.set(base.mem);
    h.regs.set(base.regs);
    h.pc = pc >>> 0;
    return new WrongPath(h);
  }
}

export class WrongPath {
  constructor(private readonly h: Hart) {}
  next(): FetchInst | null {
    const f = stepOne(this.h, -1);
    if (!f || f.fault) return null;
    return f;
  }
}
