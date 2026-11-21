/**
 * Sims of the Architecture → Pipelining module. They build on the shared RISC-V toolkit (src/sims/arch/rv): every
 * RISC-V program here runs on its hart, and every five-stage timing comes from its `pipeline` model.
 *
 * - run.ts: `runSource`, `timeSource` (assemble + run + time), `stallCpi`, `independent(n)`.
 * - depth.ts: the clock period of an n-stage pipeline (`clockPs`, `depthPoint`, P&H's stage times `PH_STAGES`,
 *   `phExample`, `speedupLimit`) and time per instruction with mispredicts (`branchPoint`, `bestDepth`,
 *   `mispredictPenalty`). All delays are model inputs.
 * - predictors.ts: direction predictors with their storage in bits: bimodal, local two-level, gshare, tournament,
 *   perceptron, TAGE (simplified), and `makeBP(id, log2 bits)`, `score`, `steps`, `tableAfter`.
 * - traces.ts: branch workloads as RISC-V programs (`WORKLOADS`, `workloadTrace`, `branchEvents`), synthetic patterns
 *   of one branch (`PATTERNS`, `patternEvents`), and `jumpKind` (call, return, indirect) by RISC-V's link registers.
 * - ras.ts: return targets from a BTB alone vs a return-address stack (`returnPredict`), and `fibSource(n)`.
 * - issue.ts: an issue-limit model of wide in-order and out-of-order cores (`issueModel`, `ISSUE_WORKLOADS`).
 * - reorder.ts: "be the compiler" blocks, checked on the hart and timed (`checkOrder`, `LOAD_USE_BLOCK`, `PAIR_BLOCK`).
 */
export * from "./run";
export * from "./depth";
export * from "./predictors";
export * from "./traces";
export * from "./ras";
export * from "./issue";
export * from "./reorder";
