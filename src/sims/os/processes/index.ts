/**
 * Reference models for the "Processes and threads" module.
 *
 * - proctable: states, the parent tree, one CPU, exit, wait, zombies and re-parenting.
 * - privilege: what each instruction does in each CPU mode, and a timeline of mode changes.
 * - syscall: the write(1, "hi", 2) path as register snapshots, errno rules and a cost model.
 * - forkexec: fork, exec, dup2 and pipes with real sharing rules; the `ls | wc` script; fork cost against memory.
 * - elf: a real ELF64 file built byte by byte, a parser with spec offsets, the loader and the initial stack.
 * - plt: lazy binding, run by decoding the real bytes of the PLT and .text.
 * - clone: what each clone flag shares; stack memory for threads, goroutines and async tasks.
 * - gmp: a Go-style M:N scheduler with hand-off and work stealing.
 * - ctx: a context switch at register level, and a cost model with cache refill.
 *
 * Every typical-hardware figure is a named MODEL INPUT in the file that uses it.
 */
export * from "./proctable";
export * from "./privilege";
export * from "./syscall";
export * from "./forkexec";
export * from "./elf";
export * from "./plt";
export * from "./clone";
export * from "./gmp";
export * from "./ctx";
