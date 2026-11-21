/**
 * Sims for the "parallel" module of the architecture track: the hardware that runs data-parallel code.
 * Typical-hardware figures that are not facts about a named product are MODEL INPUTS and are labelled where they
 * are defined.
 *
 * - simd.ts: `stripMine` (a loop of n elements as fixed-width vectors with a scalar or masked tail, as SVE predicated
 *   trips, or as RVV vsetvli trips), `vsetvl` (the RVV 1.0 vl rule), `vlmax`, `regGroups` and `elementPlace` (RVV
 *   LMUL register groups), and the roofline (`peakGflops`, `roofline`, `ridge`, `KERNELS`, `intensity`).
 * - gpu.ts: `occupancy` (resident blocks and warps per SM from the A100 and H100 per-SM limits), `issueSim` (one warp
 *   scheduler hiding memory latency by switching warps, with `issueUtilization` and `warpsNeeded`, Little's law),
 *   `warpAddresses` and `coalesce` (32-byte sectors per warp access), `bankWords` and `bankConflicts` (32 banks).
 * - simt.ts: `runWarp` runs a small program on one warp with the pre-Volta reconvergence stack (IPDOM) or a model
 *   of independent thread scheduling; `ipdoms` computes immediate post-dominators; `ifElse` and `divergenceCost`
 *   give the cost of one if/else for any set of branch outcomes; `PROGRAMS` holds the stepper's programs.
 * - tensor.ts: `reuse` and `fmaReuse` (register reads per multiply-add), `FORMATS` and `roundTo` (FP32, TF32,
 *   FP16, BF16, FP8), `dotAccumulate` (error of a long dot product by accumulator format), `GPUS` and `peakTflops`,
 *   `gemmPoint` and `batchToRidge` (a GEMM on the roofline), `tileGemm` (padding waste of MMA tiles).
 * - systolic.ts: `runSystolic` (weight-stationary and output-stationary arrays, cycle by cycle, checked against a
 *   plain matrix product), `sysCycles`, and `tpuLayer` (a model of one layer on the TPU v1 matrix unit).
 */
export * from "./simd";
export * from "./gpu";
export * from "./simt";
export * from "./tensor";
export * from "./systolic";
