/**
 * An issue-limit model for wide cores: how many instructions per cycle a trace can reach with a given width, issue
 * ports and latencies, for an in-order core and for an idealised out-of-order window. It is coarser than the shared
 * five-stage model: no pipeline stages, perfect branch prediction, and only true (RAW) dependences, as if a scoreboard
 * or register renaming handles the rest. It shows the two limits of the superscalar lesson: dependences and ports, and
 * how one long-latency load stops an in-order core.
 *
 * Rules, for instruction i in program order:
 * - Fetch: `width` instructions per cycle, in order; a taken branch or jump ends the fetch group.
 * - Ready: every source register's producer has finished (its issue cycle + its latency).
 * - In-order: i cannot issue before i - 1. Window: i enters the window only when instruction i - window has retired
 *   (in order), then it issues in the first cycle with its operands ready and a free slot and port.
 * - Per cycle: at most `width` issues, one memory operation per memory port, one mul/div, one branch or jump.
 *
 * MODEL INPUTS: the latencies (ALU 1, mul 3, div 20, load hit 2), the miss latency, and the cold-miss rule: a load
 * misses the first time it touches a 64-byte line (an infinite cache that starts empty), and hits after that.
 */
import type { DynInst, InstClass } from "../rv";
import { srcRegs } from "../rv";
import { mulberry32 } from "../../rng";

export interface IssueOptions {
  width: number;
  mode: "in-order" | "window";
  window?: number;
  memPorts?: number;
  loadHit?: number;
  missLatency?: number;
  mulLatency?: number;
  divLatency?: number;
}

export const ISSUE_DEFAULTS = { window: 64, memPorts: 1, loadHit: 2, missLatency: 40, mulLatency: 3, divLatency: 20 };
export const LINE_BYTES = 64;

export interface IssueResult { cycles: number; insts: number; ipc: number; misses: number; issue: number[]; issuedPerCycle: number[] }

export function issueModel(trace: readonly DynInst[], o: IssueOptions): IssueResult {
  const opt = { ...ISSUE_DEFAULTS, ...o };
  const W = opt.width, n = trace.length;
  const regReady = new Float64Array(32);
  const slots: number[] = [], mem: number[] = [], md: number[] = [], br: number[] = [];
  const issue = new Array<number>(n), retire = new Array<number>(n);
  const lines = new Map<number, number>(); // line -> the cycle its data arrives
  let fetchCycle = 1, inGroup = 0, lastIssue = 0, end = 0, misses = 0, prevTaken = false;
  /** Latency of d issued at cycle t. A load to a line that is still on its way waits for the fill. */
  const latOf = (d: DynInst, cls: InstClass, t: number) => {
    if (cls === "load") {
      const line = Math.floor((d.memAddr ?? 0) / LINE_BYTES), fill = lines.get(line);
      if (fill !== undefined) return Math.max(opt.loadHit, fill - t);
      lines.set(line, t + opt.missLatency);
      misses++;
      return opt.missLatency;
    }
    return cls === "mul" ? opt.mulLatency : cls === "div" ? opt.divLatency : 1;
  };
  for (let i = 0; i < n; i++) {
    const d = trace[i]!, cls = d.cls;
    // fetch
    if (inGroup === W || prevTaken) { fetchCycle++; inGroup = 0; }
    if (opt.mode === "window" && i >= opt.window) {
      const free = retire[i - opt.window]!; // the window is full until this instruction retires
      if (free > fetchCycle) { fetchCycle = free; inGroup = 0; }
    }
    inGroup++;
    prevTaken = (cls === "branch" || cls === "jump") && d.taken === true;
    // ready
    let t = fetchCycle + 1;
    for (const r of srcRegs(d.inst)) if (r !== 0) t = Math.max(t, regReady[r]!);
    if (opt.mode === "in-order") t = Math.max(t, lastIssue);
    const isMem = cls === "load" || cls === "store", isMD = cls === "mul" || cls === "div", isBr = cls === "branch" || cls === "jump";
    for (;; t++) {
      if ((slots[t] ?? 0) >= W) continue;
      if (isMem && (mem[t] ?? 0) >= opt.memPorts) continue;
      if (isMD && (md[t] ?? 0) >= 1) continue;
      if (isBr && (br[t] ?? 0) >= 1) continue;
      break;
    }
    slots[t] = (slots[t] ?? 0) + 1;
    if (isMem) mem[t] = (mem[t] ?? 0) + 1;
    if (isMD) md[t] = (md[t] ?? 0) + 1;
    if (isBr) br[t] = (br[t] ?? 0) + 1;
    const done = t + latOf(d, cls, t);
    if (d.rd !== 0 && cls !== "store" && cls !== "branch") regReady[d.rd] = done;
    issue[i] = t;
    lastIssue = t;
    retire[i] = Math.max(done, i ? retire[i - 1]! : 0);
    end = Math.max(end, done);
  }
  const first = n ? 2 : 0;
  const cycles = n ? end - first + 1 : 0;
  const issuedPerCycle: number[] = [];
  for (let c = first; c <= end; c++) issuedPerCycle.push(slots[c] ?? 0);
  return { cycles, insts: n, ipc: cycles ? n / cycles : 0, misses, issue, issuedPerCycle };
}

// ---------------------------------------------------------------- workloads

/** 256 random values in 0..999 for the array kernels. */
const VALS = (() => { const r = mulberry32(31); return Array.from({ length: 256 }, () => Math.floor(r() * 1000)); })();
const words = (v: (number | string)[], per = 16) =>
  Array.from({ length: Math.ceil(v.length / per) }, (_, i) => `        .word ${v.slice(i * per, i * per + per).join(", ")}`).join("\n");

export interface IssueWorkload { id: string; title: string; about: string; source: string }

export const ISSUE_WORKLOADS: IssueWorkload[] = [
  {
    id: "saxpy",
    title: "y[i] = 3·x[i] + y[i], 256 ints",
    about: "Independent iterations: each one loads, multiplies, adds and stores.",
    source: `        .data
x:
${words(VALS)}
y:
${words(VALS.map((v) => 1000 - v))}
        .text
_start:
        la   a0, x
        la   a1, y
        li   a2, 256
        li   a3, 3
loop:
        lw   t0, 0(a0)
        lw   t1, 0(a1)
        mul  t0, t0, a3
        add  t1, t1, t0
        sw   t1, 0(a1)
        addi a0, a0, 4
        addi a1, a1, 4
        addi a2, a2, -1
        bnez a2, loop
        li   a7, 93
        ecall
`,
  },
  {
    id: "sum4",
    title: "Sum of 256 ints, 4 accumulators",
    about: "Unrolled by 4 with 4 independent sums: much independent work.",
    source: `        .data
x:
${words(VALS)}
        .text
_start:
        la   a0, x
        li   a2, 64
        li   s0, 0
        li   s1, 0
        li   s2, 0
        li   s3, 0
loop:
        lw   t0, 0(a0)
        lw   t1, 4(a0)
        lw   t2, 8(a0)
        lw   t3, 12(a0)
        add  s0, s0, t0
        add  s1, s1, t1
        add  s2, s2, t2
        add  s3, s3, t3
        addi a0, a0, 16
        addi a2, a2, -1
        bnez a2, loop
        add  a0, s0, s1
        add  a1, s2, s3
        add  a0, a0, a1
        li   a7, 93
        ecall
`,
  },
  {
    id: "chase",
    title: "Linked list of 256 nodes, random order",
    about: "Each load needs the address from the previous load: no window can overlap them.",
    source: (() => {
      const r = mulberry32(9), order = Array.from({ length: 256 }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
      // Node k is 64 bytes (one line): { value, next, padding }. The walk visits nodes in `order`.
      const next = new Array<number | string>(256).fill(0);
      for (let i = 0; i + 1 < order.length; i++) next[order[i]!] = `n${order[i + 1]}`;
      const nodes = Array.from({ length: 256 }, (_, k) => `n${k}:     .word ${VALS[k]}, ${next[k]}\n        .space 56`).join("\n");
      return `        .data
${nodes}
        .text
_start:
        la   t0, n${order[0]}
        li   a0, 0
loop:
        lw   t1, 0(t0)      # value
        add  a0, a0, t1
        lw   t0, 4(t0)      # next: the address of the next load
        bnez t0, loop
        li   a7, 93
        ecall
`;
    })(),
  },
];

export const issueWorkloadById = (id: string) => ISSUE_WORKLOADS.find((w) => w.id === id)!;
