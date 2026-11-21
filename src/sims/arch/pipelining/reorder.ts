/**
 * "Be the compiler": a block of instructions that the learner puts in another order. Each order is assembled, run on
 * the hart (the golden model) and timed by the shared five-stage model. An order is correct when it leaves the same
 * registers and the same data memory as the original order; a wrong order shows which register or word differs.
 */
import { pipeline, REG_ABI, type PipelineOptions, type PipelineResult } from "../rv";
import { runSource } from "./run";

export interface Block {
  id: string;
  title: string;
  /** Lines before the block (data, setup) and after it; the block itself is `lines`. */
  prologue: string;
  lines: string[];
  epilogue: string;
  /** A known good order (indices into lines), for "Show a good order". */
  good: number[];
}

export const sourceOf = (b: Block, order: readonly number[]) => `${b.prologue}\n${order.map((i) => `        ${b.lines[i]}`).join("\n")}\n${b.epilogue}`;

export interface OrderResult {
  correct: boolean;
  /** Differences from the original order: "t2 = 7, should be 9" or "word at 0x100c = 1, should be 3". */
  diffs: string[];
  timing: PipelineResult;
}

interface Final { regs: Int32Array; mem: Uint8Array; dataBase: number; dataEnd: number }

function finalState(src: string): Final | null {
  const r = runSource(src);
  if (!r.ok || !r.hart) return null;
  const p = r.program;
  return { regs: r.hart.regs.slice(), mem: r.hart.mem.slice(), dataBase: p.dataBase, dataEnd: p.dataBase + p.data.length };
}

const refCache = new Map<string, Final>();

export function checkOrder(b: Block, order: readonly number[], opts: PipelineOptions): OrderResult {
  let ref = refCache.get(b.id);
  if (!ref) { ref = finalState(sourceOf(b, b.lines.map((_, i) => i)))!; refCache.set(b.id, ref); }
  const src = sourceOf(b, order);
  const run = runSource(src);
  const timing = pipeline(run.trace, run.program, opts);
  const diffs: string[] = [];
  if (!run.ok || !run.hart) return { correct: false, diffs: [run.hart?.error?.message ?? "the program did not run"], timing };
  const regs = run.hart.regs, dv = new DataView(run.hart.mem.buffer), rv = new DataView(ref.mem.buffer);
  for (let r = 1; r < 32; r++) if (r !== 2 && regs[r] !== ref.regs[r]) diffs.push(`${REG_ABI[r]} = ${regs[r]}, should be ${ref.regs[r]}`);
  for (let a = ref.dataBase; a + 4 <= ref.dataEnd; a += 4) {
    const v = dv.getInt32(a, true), w = rv.getInt32(a, true);
    if (v !== w) diffs.push(`word at 0x${a.toString(16)} = ${v}, should be ${w}`);
  }
  return { correct: diffs.length === 0, diffs, timing };
}

/** P&H's example (RISC-V edition, chapter 4) in RV32: a = b + e; c = b + f; with the variables in memory. */
export const LOAD_USE_BLOCK: Block = {
  id: "abc",
  title: "a = b + e;  c = b + f;",
  prologue: `        .data
vars:   .word 0, 0          # a, c
        .word 5, 7, 11      # b, e, f
        .text
_start:
        la   a0, vars`,
  lines: [
    "lw   t0, 8(a0)      # t0 = b",
    "lw   t1, 12(a0)     # t1 = e",
    "add  t2, t0, t1     # a = b + e",
    "sw   t2, 0(a0)",
    "lw   t3, 16(a0)     # t3 = f",
    "add  t4, t0, t3     # c = b + f",
    "sw   t4, 4(a0)",
  ],
  epilogue: "        ebreak",
  good: [0, 1, 4, 2, 3, 5, 6],
};

/** Two dot-product steps for the dual-issue lesson: loads, muls and adds that can pair if they are mixed. */
export const PAIR_BLOCK: Block = {
  id: "dot2",
  title: "Two steps of a dot product, unrolled",
  prologue: `        .data
x:      .word 2, 3
y:      .word 5, 7
out:    .word 0
        .text
_start:
        la   a0, x
        la   a1, y
        la   a3, out
        li   a2, 0`,
  lines: [
    "lw   t0, 0(a0)",
    "lw   t1, 0(a1)",
    "mul  t2, t0, t1",
    "add  a2, a2, t2",
    "lw   t3, 4(a0)",
    "lw   t4, 4(a1)",
    "mul  t5, t3, t4",
    "add  a2, a2, t5",
    "addi a0, a0, 8",
    "addi a1, a1, 8",
    "sw   a2, 0(a3)",
  ],
  epilogue: "        ebreak",
  good: [4, 1, 0, 5, 8, 2, 3, 6, 7, 10, 9],
};
