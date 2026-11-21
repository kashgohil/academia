/**
 * Sims of the ISA module (architecture/isa): the contract between software and hardware, read from real encodings.
 * Every demo that runs RISC-V code uses the shared toolkit in src/sims/arch/rv (assembler, hart, pipeline).
 *
 * - contract.ts: one binary on three timing models (CORES, model inputs) with the same architectural state
 *   (`runOnCores`, `retiredBy`, `stateAfter`), and the same binary under a changed contract (`runUnderChange`: no M,
 *   RV32E, add and sub swapped).
 * - immediates.ts: where each immediate bit of the I, S, B, U and J formats comes from (`realWiring`, from the shared
 *   decoder) against a naive layout (`naiveWiring`), and the mux inputs per immediate bit (`muxInputs`).
 * - rvc.ts: which RV32I instructions have a 16-bit C-extension form (`compress`), and code size (`density`).
 * - listings.ts: small C functions with clang's x86-64 and AArch64 output (bytes from the object files) and
 *   hand-written RV32 code (`LISTINGS`).
 * - modes.ts: runs the RV32 listings on the hart in a harness (`runListing`), and lowers one x86-style address to
 *   RISC-V (`lowerRv`, `runLowered`), x86-64 (`lowerX86`, with bytes) and AArch64 (`lowerArm`).
 * - callconv.ts: the stack frames of recursive fact(n) (`factRun`, `frameView`), and a generator for a hypothetical
 *   caller/callee-saved split that the hart runs and counts (`splitProgram`, `runSplit`, `splitSweep`).
 * - x86len.ts: an x86-64 instruction-length decoder (`decodeAt`, `decodeStream`, `resyncAt`).
 * - flags.ts: 8-bit cmp flags of x86 and AArch64 against RISC-V compare-and-branch (`cmp8`, `CONDS`).
 */
export * from "./contract";
export * from "./immediates";
export * from "./rvc";
export * from "./listings";
export * from "./modes";
export * from "./callconv";
export * from "./x86len";
export * from "./flags";
