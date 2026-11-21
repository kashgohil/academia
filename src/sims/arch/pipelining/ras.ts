/**
 * Predicting the targets of returns: a branch target buffer (BTB) alone, which predicts the last target seen at that
 * pc, against a return-address stack (RAS) of a given depth. A call (jal or jalr that writes a link register, x1 or
 * x5) pushes pc + 4; a return (jalr that reads a link register and does not write one) pops. When the stack is full,
 * a push drops the oldest entry, so deep recursion loses the oldest return addresses. The RAS depth and the BTB size
 * are MODEL INPUTS.
 */
import type { DynInst } from "../rv";
import { jumpKind } from "./traces";

export interface RetStep {
  seq: number;
  pc: number;
  kind: "call" | "return";
  /** For a call: the address pushed. For a return: the real target. */
  addr: number;
  /** For a return: what each scheme predicted (null: no prediction). */
  ras: number | null;
  btb: number | null;
  /** The stack after this event, oldest first, and whether a push dropped an entry. */
  stack: number[];
  dropped: boolean;
}

export interface RetResult { calls: number; returns: number; rasMisses: number; btbMisses: number; maxDepth: number; steps: RetStep[] }

export function returnPredict(trace: readonly DynInst[], rasDepth: number, keepSteps = true): RetResult {
  const stack: number[] = [], btb = new Map<number, number>(), steps: RetStep[] = [];
  let calls = 0, returns = 0, rasMisses = 0, btbMisses = 0, depth = 0, maxDepth = 0;
  for (const d of trace) {
    const k = jumpKind(d);
    if (k === "call") {
      calls++;
      depth++; maxDepth = Math.max(maxDepth, depth);
      let dropped = false;
      if (rasDepth > 0) {
        if (stack.length === rasDepth) { stack.shift(); dropped = true; }
        stack.push((d.pc + 4) >>> 0);
      }
      if (keepSteps) steps.push({ seq: d.seq, pc: d.pc, kind: "call", addr: (d.pc + 4) >>> 0, ras: null, btb: null, stack: stack.slice(), dropped });
    } else if (k === "return") {
      returns++;
      depth--;
      const ras = stack.length ? stack.pop()! : null;
      const b = btb.get(d.pc) ?? null;
      if (ras !== d.nextPc) rasMisses++;
      if (b !== d.nextPc) btbMisses++;
      btb.set(d.pc, d.nextPc);
      if (keepSteps) steps.push({ seq: d.seq, pc: d.pc, kind: "return", addr: d.nextPc, ras, btb: b, stack: stack.slice(), dropped: false });
    }
  }
  return { calls, returns, rasMisses, btbMisses, maxDepth, steps };
}

/** Recursive Fibonacci: two call sites, so a return goes to one of two places. */
export const fibSource = (n: number) => `# fib(n) = n < 2 ? n : fib(n - 1) + fib(n - 2)
        .text
_start:
        li   a0, ${n}
        call fib
        li   a7, 93         # exit(fib(${n}))
        ecall
fib:
        li   t0, 2
        blt  a0, t0, base
        addi sp, sp, -16
        sw   ra, 12(sp)
        sw   s0, 8(sp)
        sw   s1, 4(sp)
        mv   s0, a0
        addi a0, s0, -1
        call fib            # call site A
        mv   s1, a0
        addi a0, s0, -2
        call fib            # call site B
        add  a0, s1, a0
        lw   s1, 4(sp)
        lw   s0, 8(sp)
        lw   ra, 12(sp)
        addi sp, sp, 16
base:
        ret
`;
