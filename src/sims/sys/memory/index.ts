/**
 * Sims for the Systems "memory" module (stack and heap, static data, pointers, struct layout). They build on the
 * shared program-memory toolkit in src/sims/sys/mem and never re-implement it.
 *
 * - script.ts: `runScript(script)` runs a line-by-line program on the shared Machine and keeps a snapshot per step.
 * - stack.ts: RETURN_LOCAL (one program in C, Rust, Zig and Go), ESCAPE_CASES (Go escape analysis verdicts), stack
 *   sizes (STACK_KINDS, budgets, goStackGrowth, goLargestStack), Go's stack-allocation limits, and the
 *   HEAP_ALLOC_NS model input with allocTimeShare.
 * - statics.ts: GLOBALS (declaration → section, checked with objdump), fileAndMemory, initOrder (C++, Go, Rust
 *   LazyLock, Zig) and lifetimeScript (static, automatic and literal storage on the Machine).
 * - pointers.ts: arith (pointer arithmetic on the Machine), FAT_POINTERS and sliceOf, growth policies of Go append
 *   (goGrow, with the size classes), Rust Vec (rustGrow) and libc++ vector (cppGrow), pushAll, and HOLD (keep a
 *   pointer, then grow, in Go, C++ and Rust).
 * - structs.ts: GALLERY of checked structs, packedAccess (three ways to read a packed field), counterLayout (cache
 *   lines of per-thread counters).
 */
export * from "./script";
export * from "./stack";
export * from "./statics";
export * from "./pointers";
export * from "./structs";
