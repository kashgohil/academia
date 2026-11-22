/**
 * Sims for the Systems track module "Undefined behavior": what the compiler may assume, and the tools that catch you.
 *
 * - golden.ts: real compiler output. Small C and C++ files, compiled by Apple clang 21 with -O2 for x86-64 Linux, with
 *   the assembler directives removed. `GOLDEN[key].asm` and `.cmd`; `GOLDEN_SOURCES[file]`.
 * - optimizer.ts: a step-by-step model of UB-based rewrites (null check after a dereference, x + 1 > x, a C++ loop
 *   with no side effects, an overflow check after the overflow). `OPT_CASES`, each with steps, builds and `run`.
 *   `CHECK_FORMS` and `runCheck`: four ways to write an add-overflow check and what -O2 keeps.
 * - contracts.ts: the same four edge operations (signed add, index, shift, null) in C, Rust, Zig and Go build modes,
 *   with real messages. `OPS`, `MODES`, `outcome(op, mode, input)`.
 * - aliasing.ts: `runScale` (a load hoisted under restrict), `runTbaa` (an int and a float at one address),
 *   `floatBits`, `PUN_METHODS` (pointer cast, union, memcpy, bit_cast, Rust, Zig).
 * - overflow.ts: `fillWrites` (loop counter widening, int vs unsigned), `planAlloc` and `runAllocFill`
 *   (malloc(n * size) with a 32-bit product, on the shared machine).
 * - asan.ts: `AsanHeap`, a model of ASan's shadow memory, redzones, quarantine and inline check; `shadowAddr`;
 *   the shadow legend; HWASan constants.
 * - tools.ts: which tool catches which bug (`TOOLS`, `BUGS`, `verdict`), `machineReport` (the shared machine's report
 *   for each memory bug), `COSTS`.
 *
 * Memory is always the shared machine of src/sims/sys/mem; this module adds only what that machine lacks: an
 * optimizer model and an ASan shadow model.
 */
export * from "./golden";
export * from "./optimizer";
export * from "./contracts";
export * from "./aliasing";
export * from "./overflow";
export * from "./asan";
export * from "./tools";
