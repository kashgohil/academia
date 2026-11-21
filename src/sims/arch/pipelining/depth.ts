/**
 * How deep to pipeline: a clock-period model and a time-per-instruction model.
 *
 * MODEL INPUTS (not facts about any one core):
 * - The logic of one instruction takes `logicPs` picoseconds in total (default 800 ps, the single-cycle example of
 *   Patterson and Hennessy, RISC-V edition, chapter 4).
 * - Each pipeline register adds `latchPs` of overhead: its setup time, its clock-to-output delay and clock skew
 *   (default 40 ps).
 * - `imbalance` (≥ 1) is how much longer the slowest stage is than an equal share of the logic (default 1).
 * - A share `branchFrac` of instructions are branches (default 0.2), a share `missRate` of those are predicted wrong
 *   (default 0.05), and the branch is resolved at a fixed fraction `resolveAt` of the depth (default 0.6: stage 3 of 5,
 *   the EX stage). A mispredict costs the stages before that point: 0.6·n - 1 cycles (2 at n = 5, 11 at n = 20).
 * - A share `loadUseFrac` of instructions (default 0.1) use the result of the load just before them. Data access is a
 *   quarter of the logic in P&H's example, so it spans n/4 stages, and the user waits (n - 1)/4 cycles: 1 at n = 5.
 *   This follows the form of Hartstein and Puzak's model (ISCA 2002): each hazard drains a fixed share of the pipe.
 */

/** The stage delays of P&H's example, in ps: the work of each stage of a load. MODEL INPUT. */
export const PH_STAGES = [
  { name: "IF", what: "instruction fetch", ps: 200 },
  { name: "ID", what: "register read", ps: 100 },
  { name: "EX", what: "ALU operation", ps: 200 },
  { name: "MEM", what: "data access", ps: 200 },
  { name: "WB", what: "register write", ps: 100 },
] as const;

export interface DepthModel { logicPs: number; latchPs: number; imbalance: number }
export const DEPTH_DEFAULTS: DepthModel = { logicPs: 800, latchPs: 40, imbalance: 1 };

/** The clock period of an n-stage pipeline: the slowest stage plus one pipeline register. n = 1 is single-cycle. */
export function clockPs(n: number, m: Partial<DepthModel> = {}): number {
  const { logicPs, latchPs, imbalance } = { ...DEPTH_DEFAULTS, ...m };
  const slowest = n === 1 ? logicPs : Math.min(logicPs, (logicPs / n) * imbalance);
  return slowest + latchPs;
}

export interface DepthPoint {
  n: number;
  clockPs: number;
  ghz: number;
  /** Time from fetch to write-back of one instruction. */
  latencyPs: number;
  /** Throughput gain over the single-cycle design (same latch), with no stalls. */
  speedup: number;
}

export function depthPoint(n: number, m: Partial<DepthModel> = {}): DepthPoint {
  const c = clockPs(n, m), c1 = clockPs(1, m);
  return { n, clockPs: c, ghz: 1000 / c, latencyPs: n * c, speedup: c1 / c };
}

/** The P&H example: single-cycle period, pipelined period (slowest stage, no latch overhead), and the speedup. */
export function phExample(latchPs = 0) {
  const single = PH_STAGES.reduce((s, x) => s + x.ps, 0) + latchPs;
  const piped = Math.max(...PH_STAGES.map((x) => x.ps)) + latchPs;
  return { single, piped, speedup: single / piped, latency: PH_STAGES.length * piped };
}

/** The largest speedup that any depth can give: logic / latch + 1 as n grows without limit (equal stages). */
export const speedupLimit = (m: Partial<DepthModel> = {}) => {
  const { logicPs, latchPs } = { ...DEPTH_DEFAULTS, ...m };
  return (logicPs + latchPs) / latchPs;
};

// ---------------------------------------------------------------- depth with branches

export interface BranchModel extends DepthModel { branchFrac: number; missRate: number; resolveAt: number; loadUseFrac: number }
export const BRANCH_DEFAULTS: BranchModel = { ...DEPTH_DEFAULTS, branchFrac: 0.2, missRate: 0.05, resolveAt: 0.6, loadUseFrac: 0.1 };

/** The cycles a mispredict loses in an n-stage pipe: the stages before the resolve point (an average, not rounded). */
export const mispredictPenalty = (n: number, resolveAt = BRANCH_DEFAULTS.resolveAt) => Math.max(0, resolveAt * n - 1);

/** The cycles a load's user waits in an n-stage pipe with full forwarding: (n - 1)/4. */
export const loadUsePenalty = (n: number) => (n - 1) / 4;

export interface BranchPoint extends DepthPoint { penalty: number; loadUse: number; cpi: number; psPerInst: number; mips: number }

export function branchPoint(n: number, m: Partial<BranchModel> = {}): BranchPoint {
  const b = { ...BRANCH_DEFAULTS, ...m };
  const d = depthPoint(n, b);
  const penalty = mispredictPenalty(n, b.resolveAt), loadUse = loadUsePenalty(n);
  const cpi = 1 + b.branchFrac * b.missRate * penalty + b.loadUseFrac * loadUse;
  const psPerInst = cpi * d.clockPs;
  return { ...d, penalty, loadUse, cpi, psPerInst, mips: 1e6 / psPerInst };
}

/** The depth in 1..maxN with the least time per instruction. */
export function bestDepth(m: Partial<BranchModel> = {}, maxN = 60): BranchPoint {
  let best = branchPoint(1, m);
  for (let n = 2; n <= maxN; n++) {
    const p = branchPoint(n, m);
    if (p.psPerInst < best.psPerInst - 1e-9) best = p;
  }
  return best;
}
