/**
 * What an ISA is: one binary, many cores. The hart (the golden model in src/sims/arch/rv) fixes the architectural
 * state after each instruction. The timing model then says WHEN each instruction retires on a given core. So the cores
 * differ in time, never in the sequence of states. The second part changes the contract itself (drop an extension,
 * shrink the register file, re-encode two instructions) and runs the same binary again.
 *
 * MODEL INPUTS: the three cores below are timing configurations of the shared pipeline model, not real products.
 */
import { assemble, Hart, pipeline, OPCODE, decode, type Inst, type PipelineOptions, type Program } from "../rv";
import { makePredictor } from "../../perf/cpu";

export interface CoreModel { id: string; name: string; about: string; opts: () => PipelineOptions }

/** Three timing models of the same ISA. All numbers here are model inputs. */
export const CORES: CoreModel[] = [
  {
    id: "tiny", name: "Tiny in-order core",
    about: "One instruction at a time, no forwarding, fetch stalls at every branch, 32-cycle multiply and divide (model inputs).",
    opts: () => ({ width: 1, forwarding: "none", branch: { resolve: "EX", predict: "stall" }, mulLatency: 32, divLatency: 32 }),
  },
  {
    id: "classic", name: "Classic five-stage core",
    about: "Full forwarding, predict not taken, 3-cycle multiply, 20-cycle divide (model inputs).",
    opts: () => ({ width: 1, forwarding: "full", branch: { resolve: "EX", predict: "not-taken" }, mulLatency: 3, divLatency: 20 }),
  },
  {
    id: "wide", name: "Dual-issue core",
    about: "Two instructions per cycle, a 2-bit predictor with a BTB, 1-cycle multiply (model inputs).",
    opts: () => ({ width: 2, forwarding: "full", memForward: true, branch: { resolve: "EX", predict: "dynamic", predictor: makePredictor("two-bit"), btb: true }, mulLatency: 1, divLatency: 20 }),
  },
];

export interface CoreRun {
  core: CoreModel;
  cycles: number;
  cpi: number;
  /** wb[k] = the cycle in which instruction k (0-based, in program order) writes back: it retires then. */
  wb: number[];
}

export interface ArchRun {
  program: Program;
  /** Instructions the hart retired (the same on every core). */
  retired: number;
  exitCode: number | null;
  /** The retired instructions in program order (dyn[k] is instruction number k). */
  dyn: Inst[];
  runs: CoreRun[];
}

/** Run a program once on the hart, then time the same trace on each core. */
export function runOnCores(source: string, cores: CoreModel[] = CORES): ArchRun {
  const asm = assemble(source);
  if (!asm.ok) throw new Error(`assembly failed: ${asm.errors.map((e) => `${e.line}: ${e.message}`).join("; ")}`);
  const hart = new Hart(asm.program);
  hart.run({ maxSteps: 100_000 });
  const runs = cores.map((core) => {
    const r = pipeline(hart.trace, asm.program, core.opts());
    const wb = new Array<number>(hart.trace.length).fill(0);
    for (const row of r.rows) {
      if (row.squashed || row.seq < 0) continue;
      const c = row.cells.find((x) => x.stage === "WB");
      if (c) wb[row.seq] = c.cycle;
    }
    return { core, cycles: r.cycles, cpi: r.cpi, wb };
  });
  return { program: asm.program, retired: hart.trace.length, exitCode: hart.exitCode, dyn: hart.trace.map((d) => d.inst), runs };
}

/** How many instructions a core has retired by the end of cycle c (write-back is in order). */
export function retiredBy(run: CoreRun, c: number): number {
  let lo = 0, hi = run.wb.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (run.wb[m]! <= c) lo = m + 1; else hi = m; }
  return lo;
}

/** The architectural state after k instructions: pc and the 32 registers. The same for every core, by construction. */
export function stateAfter(program: Program, k: number): { pc: number; regs: number[]; status: string } {
  const h = new Hart(program, { trace: false });
  for (let i = 0; i < k && h.step(); i++);
  return { pc: h.pc, regs: Array.from(h.regs), status: h.status };
}

// ---------------------------------------------------------------- changing the contract

export type Change = "none" | "no-m" | "rv32e" | "swap-sub";

export const CHANGES: { id: Change; name: string; about: string }[] = [
  { id: "none", name: "Same ISA (RV32IM)", about: "The binary runs on a core that implements the contract." },
  { id: "no-m", name: "No M extension (RV32I core)", about: "mul, div and rem are not in the ISA. Their encodings are illegal." },
  { id: "rv32e", name: "16 registers (RV32E)", about: "Only x0 to x15 exist. An encoding that names x16 to x31 is illegal." },
  { id: "swap-sub", name: "add and sub swap encodings", about: "A different ISA that gives bit 30 the opposite meaning: add decodes as sub, sub as add." },
];

const ILLEGAL = 0x00000000; // the all-zeros word is defined as illegal in RISC-V

/** The machine word as a core with a changed contract sees it. */
export function underChange(word: number, change: Change): number {
  const inst = decode(word);
  if (!inst) return word;
  switch (change) {
    case "none": return word;
    case "no-m": return ["mul", "mulh", "mulhsu", "mulhu", "div", "divu", "rem", "remu"].includes(inst.op) ? ILLEGAL : word;
    case "rv32e": {
      const fmtRegs = [inst.rd, inst.rs1, inst.rs2];
      return fmtRegs.some((r) => r >= 16) ? ILLEGAL : word;
    }
    case "swap-sub":
      return (word & 0x7f) === OPCODE.OP && ((word >>> 12) & 7) === 0 && ((word >>> 25) & 0x5f) === 0 ? (word ^ (1 << 30)) >>> 0 : word;
  }
}

export interface ChangeResult { change: Change; exitCode: number | null; output: string; error: string | null; retired: number; changedWords: number }

/** Run the same binary under a changed contract (the words are reinterpreted; the bits in memory do not change). */
export function runUnderChange(source: string, change: Change): ChangeResult {
  const asm = assemble(source);
  if (!asm.ok) throw new Error("assembly failed");
  const p = asm.program;
  const words = p.words.map((w) => underChange(w, change));
  const changedWords = words.filter((w, i) => w !== p.words[i]).length;
  const prog: Program = { ...p, words };
  const h = new Hart(prog, { trace: false });
  h.run({ maxSteps: 100_000 });
  return { change, exitCode: h.exitCode, output: h.output, error: h.error ? h.error.message : null, retired: h.instret, changedWords };
}
