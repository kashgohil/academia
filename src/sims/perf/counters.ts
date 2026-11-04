/**
 * Hardware performance counters for a few kernels, from a simple core model:
 * a 4-wide core, a real gshare branch predictor run on the kernel's branch stream,
 * and analytic cache behaviour. Produces counter values and a top-down breakdown.
 */
import { mulberry32 } from "../rng";

/** gshare: global history XOR branch address indexes 2-bit saturating counters. Returns mispredicts. */
export function gshare(outcomes: boolean[], pcs: number[], historyBits = 12): number {
  const size = 1 << historyBits;
  const table = new Uint8Array(size).fill(1); // weakly not-taken
  let hist = 0, miss = 0;
  outcomes.forEach((taken, i) => {
    const idx = ((pcs[i] ?? 0) ^ hist) & (size - 1);
    const predict = table[idx]! >= 2;
    if (predict !== taken) miss++;
    table[idx] = taken ? Math.min(3, table[idx]! + 1) : Math.max(0, table[idx]! - 1);
    hist = ((hist << 1) | +taken) & (size - 1);
  });
  return miss;
}

export interface Kernel { id: string; label: string; code: string; note: string }

export const KERNELS: Kernel[] = [
  { id: "sum", label: "Sequential sum", code: "for i in 0..n: s += a[i]", note: "Streams through memory; the prefetcher keeps up." },
  { id: "branch-random", label: "Branch on random data", code: "for i: if a[i] >= 128 { s += a[i] }", note: "a[] holds random bytes: the branch is a coin flip." },
  { id: "branch-sorted", label: "Same loop, sorted data", code: "sort(a); for i: if a[i] >= 128 { s += a[i] }", note: "Identical instructions; the branch becomes predictable." },
  { id: "chase", label: "Pointer chase", code: "while p { p = p.next }", note: "Linked list scattered over 256 MiB: every node misses to DRAM." },
  { id: "fp-chain", label: "Dependent FP chain", code: "for i: x = x * a + b", note: "Each multiply-add waits for the previous one (4-cycle latency)." },
];

export interface Counters {
  instructions: number; cycles: number; ipc: number;
  branches: number; mispredicts: number; l1Misses: number; llcMisses: number;
  topdown: { retiring: number; badSpeculation: number; frontend: number; backendMemory: number; backendCore: number };
}

const N = 100_000;

export function measureKernel(id: string): Counters {
  const r = mulberry32(3);
  let instr = 0, branches = 0, outcomes: boolean[] = [], pcs: number[] = [], l1 = 0, llc = 0, memStall = 0, coreStall = 0;
  switch (id) {
    case "sum":
      instr = 3 * N; branches = N; outcomes = Array.from({ length: N }, (_, i) => i < N - 1); pcs = new Array(N).fill(1);
      l1 = N / 16; llc = N / 16; memStall = llc * 4; // prefetched: only a small exposed cost
      break;
    case "branch-random":
    case "branch-sorted": {
      const a = Array.from({ length: N }, () => Math.floor(r() * 256));
      if (id === "branch-sorted") a.sort((x, y) => x - y);
      instr = 5 * N; branches = 2 * N;
      for (let i = 0; i < N; i++) { outcomes.push(a[i]! >= 128, i < N - 1); pcs.push(2, 1); }
      l1 = N / 64; llc = N / 64; memStall = llc * 4;
      break;
    }
    case "chase":
      instr = 3 * N; branches = N; outcomes = Array.from({ length: N }, (_, i) => i < N - 1); pcs = new Array(N).fill(1);
      l1 = N; llc = N; memStall = N * 300; // ~100 ns at 3 GHz each, no overlap: the next address depends on this load
      break;
    case "fp-chain":
      instr = 3 * N; branches = N; outcomes = Array.from({ length: N }, (_, i) => i < N - 1); pcs = new Array(N).fill(1);
      coreStall = N * 4 - (3 * N) / 4; // a 4-cycle FMA per iteration vs issue time
      break;
  }
  const mispredicts = gshare(outcomes, pcs);
  const width = 4, penalty = 16;
  const issue = instr / width;
  const frontend = 0.05 * issue;
  const cycles = issue + frontend + mispredicts * penalty + memStall + coreStall;
  return {
    instructions: instr, cycles, ipc: instr / cycles, branches, mispredicts, l1Misses: l1, llcMisses: llc,
    topdown: {
      retiring: issue / cycles,
      badSpeculation: (mispredicts * penalty) / cycles,
      frontend: frontend / cycles,
      backendMemory: memStall / cycles,
      backendCore: coreStall / cycles,
    },
  };
}
