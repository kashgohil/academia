/**
 * Branch traces for the prediction lessons. The workloads are RISC-V programs that run on the shared hart (the golden
 * model), so every outcome is the outcome of a real instruction. A few synthetic patterns of one branch serve the
 * stepper, where the learner follows each prediction.
 */
import { mulberry32 } from "../../rng";
import { dstReg, type DynInst } from "../rv";
import type { BranchEvent } from "./predictors";
import { runSource } from "./run";

const words = (v: number[], per = 16) =>
  Array.from({ length: Math.ceil(v.length / per) }, (_, i) => `        .word ${v.slice(i * per, i * per + per).join(", ")}`).join("\n");

/** 512 values in 0..99 from a seeded PRNG (the same every run). */
export const RANDOM_VALUES: number[] = (() => {
  const r = mulberry32(77);
  return Array.from({ length: 512 }, () => Math.floor(r() * 100));
})();

export interface Workload { id: string; title: string; about: string; source: string }

const countAbove = (vals: number[]) => `# count = number of values > 50
        .data
vals:
${words(vals)}
        .text
_start:
        la   t0, vals
        li   t1, ${vals.length}
        li   t2, 50
        li   a0, 0
loop:
        lw   t3, 0(t0)
        ble  t3, t2, skip   # the data branch
        addi a0, a0, 1
skip:
        addi t0, t0, 4
        addi t1, t1, -1
        bnez t1, loop       # the loop branch
        li   a7, 93
        ecall
`;

export const WORKLOADS: Workload[] = [
  {
    id: "loops",
    title: "Nested loops, inner trip count 4",
    about: "The inner back-edge is taken 3 times, then not taken: a short repeating pattern.",
    source: `# for (i = 0; i < 400; i++) for (j = 0; j < 4; j++) s += j;
        .text
_start:
        li   a0, 0
        li   t0, 400
outer:
        li   t1, 4
inner:
        add  a0, a0, t1
        addi t1, t1, -1
        bnez t1, inner      # taken 3 times, then not taken
        addi t0, t0, -1
        bnez t0, outer
        li   a7, 93
        ecall
`,
  },
  {
    id: "random",
    title: "Random data: count values > 50",
    about: "The data branch is a coin flip; only the loop branch can be learned.",
    source: countAbove(RANDOM_VALUES),
  },
  {
    id: "sorted",
    title: "The same data, sorted",
    about: "The same branch on sorted data changes direction only once.",
    source: countAbove([...RANDOM_VALUES].sort((a, b) => a - b)),
  },
  {
    id: "correlated",
    title: "Two branches that test the same value",
    about: "The second branch repeats the first: its own history is random, but the global history knows the answer.",
    source: `# if (x < 50) a++;  y = x * 3;  if (x < 50) b++;
        .data
vals:
${words(RANDOM_VALUES)}
        .text
_start:
        la   t0, vals
        li   t1, ${RANDOM_VALUES.length}
        li   t2, 50
        li   a0, 0
        li   a1, 0
loop:
        lw   t3, 0(t0)
        bge  t3, t2, skip1  # first test of x
        addi a0, a0, 1
skip1:
        slli t4, t3, 1
        add  t4, t4, t3
        bge  t3, t2, skip2  # the same test again
        addi a1, a1, 1
skip2:
        addi t0, t0, 4
        addi t1, t1, -1
        bnez t1, loop
        li   a7, 93
        ecall
`,
  },
  {
    id: "period",
    title: "A repeating pattern of period 7",
    about: "The branch follows T T N T N N T, again and again: long enough to beat a short history.",
    source: `# the branch reads its outcome from a 7-entry table
        .data
pat:    .word 1, 1, 0, 1, 0, 0, 1
        .text
_start:
        li   t1, 700
        li   t5, 0          # index into pat
        li   a0, 0
loop:
        la   t0, pat
        slli t6, t5, 2
        add  t0, t0, t6
        lw   t3, 0(t0)
        beqz t3, skip       # the pattern branch
        addi a0, a0, 1
skip:
        addi t5, t5, 1
        li   t6, 7
        bne  t5, t6, keep
        li   t5, 0
keep:
        addi t1, t1, -1
        bnez t1, loop
        li   a7, 93
        ecall
`,
  },
  {
    id: "bubble",
    title: "Bubble sort of 64 random values",
    about: "Nested loops and a swap branch whose direction depends on the data and on how sorted it is so far.",
    source: `# bubble sort, ascending
        .data
arr:
${words(RANDOM_VALUES.slice(0, 64))}
        .text
_start:
        la   a0, arr
        li   a1, 63
outer:
        blez a1, done
        mv   t0, a0
        mv   t1, a1
inner:
        lw   t2, 0(t0)
        lw   t3, 4(t0)
        ble  t2, t3, noswap # the swap branch
        sw   t3, 0(t0)
        sw   t2, 4(t0)
noswap:
        addi t0, t0, 4
        addi t1, t1, -1
        bnez t1, inner
        addi a1, a1, -1
        j    outer
done:
        li   a7, 93
        ecall
`,
  },
];

/** Trip counts of the 400 small loops of the "many" workload: 2 to 6, from a seeded PRNG. */
export const MANY_TRIPS: number[] = (() => {
  const r = mulberry32(404);
  return Array.from({ length: 400 }, () => 2 + Math.floor(r() * 5));
})();

WORKLOADS.push({
  id: "many",
  title: "400 small loops, run 20 times",
  about: "400 different branch sites, each a short loop: the tables must hold them all, or they collide.",
  source: `# 400 inner loops with trip counts 2..6, the whole thing 20 times
        .text
_start:
        li   a0, 0
        li   t0, 20
again:
${MANY_TRIPS.map((k, j) => `        li   t1, ${k}\nL${j}:\n        addi t1, t1, -1\n        bnez t1, L${j}`).join("\n")}
        addi t0, t0, -1
        beqz t0, out
        j    again
out:
        li   a7, 93
        ecall
`,
});

export const workloadById = (id: string) => WORKLOADS.find((w) => w.id === id)!;

const cache = new Map<string, DynInst[]>();

/** The dynamic trace of a workload (run once on the hart, then cached). */
export function workloadTrace(id: string): DynInst[] {
  let t = cache.get(id);
  if (!t) {
    const r = runSource(workloadById(id).source, 2_000_000);
    if (!r.ok) throw new Error(`workload ${id} failed`);
    t = r.trace;
    cache.set(id, t);
  }
  return t;
}

/** The conditional branches of a trace, in order. */
export const branchEvents = (trace: readonly DynInst[]): BranchEvent[] =>
  trace.filter((d) => d.cls === "branch").map((d) => ({ pc: d.pc, taken: d.taken === true, target: (d.pc + d.inst.imm) >>> 0 }));

// ---------------------------------------------------------------- synthetic patterns of one branch

export interface Pattern { id: string; label: string; bits: string }
/** One branch at pc 0x40 that repeats `bits` (T = taken, N = not taken). */
export const PATTERNS: Pattern[] = [
  { id: "loop4", label: "Loop of 4: T T T N", bits: "TTTN" },
  { id: "alt", label: "Alternating: T N", bits: "TN" },
  { id: "p7", label: "Period 7: T T N T N N T", bits: "TTNTNNT" },
  { id: "always", label: "Always taken", bits: "T" },
];
export const PATTERN_PC = 0x40;

export function patternEvents(bits: string, n: number): BranchEvent[] {
  return Array.from({ length: n }, (_, i) => ({ pc: PATTERN_PC, taken: bits[i % bits.length] === "T", target: PATTERN_PC - 16 }));
}

// ---------------------------------------------------------------- calls, returns and indirect jumps

export type JumpKind = "call" | "return" | "indirect" | "jump";

/** RISC-V's link registers: x1 (ra) and x5 (t0). The ISA manual's return-address-stack hints test for them. */
export const isLink = (r: number) => r === 1 || r === 5;

/** What a jal or jalr does to a return-address stack, by the hint table of the RISC-V unprivileged manual. */
export function jumpKind(d: DynInst): JumpKind | null {
  if (d.cls !== "jump") return null;
  const rd = dstReg(d.inst);
  if (d.inst.op === "jal") return isLink(rd) ? "call" : "jump";
  const rs1 = d.inst.rs1;
  if (isLink(rd)) return "call"; // a push (and a pop first when rs1 is a different link register: a coroutine swap)
  if (isLink(rs1)) return "return";
  return "indirect";
}
