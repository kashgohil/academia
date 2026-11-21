/**
 * The configurations of the ooo lessons and the numbers their text quotes, all computed by the core (core.ts).
 * tests/unit/arch-ooo-lessons.test.ts pins every number. All sizes and latencies are MODEL INPUTS.
 */
import { assemble, BRANCHY_THRESHOLD, BRANCHY_VALUES, type Program } from "../rv";
import type { BranchMode, MemDep, OooOptions, OooResult } from "./config";
import { runOoo } from "./core";
import {
  aliasLoopSource, aliasSource, branchMissSource, FAULT_SOURCE, independentSource, missSource, spectreSource, squaresSource, TOMASULO_SOURCE,
  LINE, PROBE_LINES, type Mitigation,
} from "./programs";

const cache = new Map<string, Program>();
/** Assemble a lesson program (they are all valid; this throws if one is not). */
export function asmOf(src: string): Program {
  let p = cache.get(src);
  if (!p) {
    const a = assemble(src);
    if (!a.ok) throw new Error(`ooo lesson program: ${a.errors.map((e) => `line ${e.line}: ${e.message}`).join("; ")}`);
    p = a.program;
    if (cache.size > 200) cache.clear();
    cache.set(src, p);
  }
  return p;
}

// ---------------------------------------------------------------- register renaming

/** The squares loop on the default core (width 4, ROB 64), with or without renaming and a given register count. */
export function squaresRun(physRegs: number | "none", opts: OooOptions = {}): OooResult {
  return runOoo(asmOf(squaresSource()), physRegs === "none" ? { rename: false, ...opts } : { physRegs, ...opts });
}
export const PHYS_SWEEP = [33, 34, 36, 40, 44, 48, 56, 64, 80, 96, 128];

// ---------------------------------------------------------------- Tomasulo

/** The Tomasulo sequence on a one-wide core with reservation stations per unit, as in the 360/91. */
export const TOMASULO_CONFIG: OooOptions = {
  width: 1, frontDepth: 1, rs: { alu: 3, mul: 2, div: 2, mem: 3 }, units: { alu: 1, mul: 1, div: 1, mem: 1 }, cdb: 1,
  lat: { mul: 6, div: 12, hit: 2 }, record: true, physRegs: 64,
};
export const tomasuloRun = (opts: OooOptions = {}) => runOoo(asmOf(TOMASULO_SOURCE), { ...TOMASULO_CONFIG, ...opts, lat: { ...TOMASULO_CONFIG.lat, ...opts.lat } });

/** 64 independent adds on 4 ALUs and width 4, with 1, 2 or 4 result buses. */
export const cdbRun = (buses: number) => runOoo(asmOf(independentSource()), { cdb: buses, units: { alu: 4 } });

// ---------------------------------------------------------------- reorder buffer

export const MISS_LINES = 24, MISS_WORK = 6;
/** One miss per iteration (independent misses, or a pointer chase) on a real cache; the ROB bounds the window. */
export function missRun(robSize: number, miss = 100, chase = false, opts: OooOptions = {}): OooResult {
  return runOoo(asmOf(missSource(MISS_LINES, MISS_WORK, chase)), {
    robSize, iqSize: robSize, physRegs: robSize + 40, lqSize: robSize, sqSize: robSize,
    cache: { perfect: false }, lat: { miss }, ...opts,
  });
}
export const ROB_SWEEP = [8, 16, 24, 32, 48, 64, 96, 128, 192, 256];

/**
 * The faulting program. `found` is the cycle the fault is known (the load executes). In this core, results wait in the
 * ROB; in Tomasulo's original design they go straight to the registers, so the register file at `found` would hold
 * the results of `younger` (they come after the fault) and miss those of `pending` (older, not done yet).
 */
export function faultRun(opts: OooOptions = {}) {
  const r = runOoo(asmOf(FAULT_SOURCE), { record: true, ...opts });
  const f = r.uops.find((u) => u.fault && !u.wrong)!;
  const found = f.ready;
  const doneBy = (u: (typeof r.uops)[number]) => u.ready >= 0 && u.ready <= found && (u.squash < 0 || u.squash > found);
  const older = r.uops.filter((u) => !u.wrong && u.id < f.id);
  return {
    r, fault: f, found,
    pending: older.filter((u) => !doneBy(u)),
    younger: r.uops.filter((u) => u.id > f.id && u.rd > 0 && doneBy(u)),
  };
}

// ---------------------------------------------------------------- memory disambiguation

export const aliasRun = (storeSlot: number, loadSlot: number, slow: boolean, memDep: MemDep, opts: OooOptions = {}) =>
  runOoo(asmOf(aliasSource(storeSlot, loadSlot, slow)), { memDep, record: true, ...opts });

export const ALIAS_N = 24;
export const aliasLoopRun = (every: number, memDep: MemDep) => runOoo(asmOf(aliasLoopSource(ALIAS_N, every)), { memDep });

// ---------------------------------------------------------------- speculative execution

export const SIZE_LINE: [number, number] = [0x1000, 0x1040];
export const PROBE_BASE = 0x1080;
export function spectreRun(secret: number, mitigation: Mitigation, opts: OooOptions = {}): OooResult {
  return runOoo(asmOf(spectreSource(secret, mitigation)), { cache: { perfect: false, flushed: [SIZE_LINE] }, lat: { miss: 100 }, record: true, ...opts });
}
/** Which probe lines (0..15) are in the cache. */
export const probeLines = (lines: number[]) => lines.filter((l) => l >= PROBE_BASE && l < PROBE_BASE + PROBE_LINES * LINE).map((l) => (l - PROBE_BASE) / LINE);

/** A short version of the miss loop (8 lines, a 40-cycle miss) with frames, for the ROB ring stepper. */
export const RING_MISS = 40;
export const missRingRun = (robSize: number) =>
  runOoo(asmOf(missSource(8, MISS_WORK)), {
    robSize, iqSize: robSize, physRegs: robSize + 40, lqSize: robSize, sqSize: robSize,
    cache: { perfect: false }, lat: { miss: RING_MISS }, record: true,
  });

/**
 * The branchy count (the shared sample's 32 random values) with one value per cache line: every load misses and every
 * branch depends on a miss. A predictor and a window size.
 */
export const WINDOW_SWEEP = [16, 32, 64, 128, 256];
export const WINDOW_MISS = 100;
export const windowRun = (branch: BranchMode, robSize: number, opts: OooOptions = {}) =>
  runOoo(asmOf(branchMissSource(BRANCHY_VALUES, BRANCHY_THRESHOLD)), {
    branch, robSize, iqSize: robSize, physRegs: robSize + 64, lqSize: robSize, sqSize: robSize,
    cache: { perfect: false }, lat: { miss: WINDOW_MISS }, ...opts,
  });

/** Little's law for the window: entries needed to keep `width` instructions per cycle flowing past a `latency` stall. */
export const windowNeeded = (latency: number, width: number) => latency * width;

/** The chance that every branch in a full window is predicted right: accuracy ^ (entries / instructions per branch). */
export const windowAllRight = (accuracy: number, entries: number, perBranch: number) => accuracy ** (entries / perBranch);
