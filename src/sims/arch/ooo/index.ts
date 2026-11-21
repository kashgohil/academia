/**
 * The out-of-order core of the architecture track's ooo module: register renaming (rename table and free list),
 * an issue queue or distributed reservation stations, functional units with latencies, a result bus (the common data
 * bus), a reorder buffer with in-order commit, load and store queues with store-to-load forwarding and three memory
 * dependence policies, and branch misprediction recovery. All sizes and latencies are MODEL INPUTS (config.ts).
 *
 * It is driven by the shared hart (src/sims/arch/rv): the hart gives each instruction its values, and forked harts give
 * the wrong paths real values. The core decides timing, and reads load values itself, so a load that runs ahead of an
 * aliasing store reads a stale value until the violation squashes it. tests/unit/arch-ooo-core.test.ts checks that the
 * committed registers and memory equal the hart's for every sample program and many configurations.
 *
 * ```ts
 * import { runOoo, OooCore } from "../../sims/arch/ooo";
 * const r = runOoo(program, { robSize: 32, physRegs: 64, memDep: "store-sets", record: true });
 * r.cycles; r.ipc; r.stats; r.uops; r.frames;   // frames: one snapshot per cycle, for steppers
 * ```
 *
 * - config.ts: `OooConfig`, `DEFAULT_CONFIG`, `resolveConfig`, the `Uop`, `UopView`, `Frame` and `OooResult` types.
 * - oracle.ts: `Oracle` (the correct path, from the hart) and `WrongPath` (a forked hart).
 * - core.ts: `OooCore` (`step`, `run`, `view`, `result`) and `runOoo`.
 * - programs.ts: the lesson programs, as RISC-V source generators.
 * - lessons.ts: the numbers the lessons quote, computed from the core.
 */
export * from "./config";
export * from "./oracle";
export * from "./core";
export * from "./programs";
export * from "./lessons";
