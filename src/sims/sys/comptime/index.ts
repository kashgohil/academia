/**
 * Sims of the comptime module (systems/comptime): code that runs in the compiler, and what it costs.
 *
 * - zigeval.ts: a partial evaluator for a small Zig subset (`ZIG_FNS`, `specialize`, `largestN`,
 *   `instancesFor`). It runs comptime code, counts branches against the quota of 1000, and emits residual code.
 * - zigfmt.ts: the comptime walk of `std.Io.Writer.print` in zig 0.17.1 (`checkFormat`, `emittedCalls`), with
 *   a table of what each specifier does for each type (`SPEC_TABLE`, measured).
 * - cppinst.ts: template instantiation in two C++ translation units, COMDAT copies, `extern template` and the
 *   link (`CALL_SITES`, `SYMS`, `instantiate`). Symbol names and sizes are from ELF objects of clang 22.1.8 (inside zig 0.17.1).
 * - budget.ts: the step and depth limits of clang's constant evaluator and Zig's branch quota (`cost`,
 *   `largestBudgetN`, `MEASURED_MAX`, `fibTree`).
 * - dispatch.ts: a replay of rustc's x86-64 code for a generic call and a `dyn` call (`frames`, listings,
 *   `perElement`).
 * - orphan.ts: Rust's orphan rule and std overlap for one impl (`checkImpl`), checked against rustc
 *   (`RUSTC_TABLE`, `rustcMessage`).
 * - mono.ts: a model of copies and bytes for generic, outlined and dyn code (`monoModel`, `crossover`), and a
 *   real measurement of N sort_by closures in rustc (`SORT_RUNS`, `sortSlopes`, `sortSource`).
 */
export * from "./zigeval";
export * from "./zigfmt";
export * from "./cppinst";
export * from "./budget";
export * from "./dispatch";
export * from "./orphan";
export * from "./mono";
