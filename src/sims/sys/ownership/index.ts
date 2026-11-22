/**
 * Sims for the Systems track's ownership module: who frees memory, and how the language proves it.
 *
 * - borrowck.ts: a borrow checker and interpreter for a toy subset of Rust (moves, borrows, NLL liveness, two-phase
 *   borrows, lifetimes in signatures, drop order) with rustc's error codes and messages.
 * - lifetimes.ts: signature parsing and the three lifetime elision rules, step by step (E0106, E0261).
 * - programs.ts: the example programs, each with what rustc 1.96.1 really reported and printed.
 * - cpp.ts: C++ models: implicit special members (rule of zero, three, five), std::vector growth with
 *   move_if_noexcept, copy elision cases, and stack unwinding with manual cleanup or RAII.
 * - memory.ts: scripted programs on the shared memory machine (src/sims/sys/mem): move versus copy versus shallow
 *   copy, iterator invalidation, C++ move versus Rust move, and unwinding that leaks.
 * - rc.ts: Rc and Weak counts on the memory machine (cycles leak), the RefCell borrow flag, smart pointer sizes.
 */
export * from "./borrowck";
export * from "./lifetimes";
export * from "./programs";
export * from "./cpp";
export * from "./memory";
export * from "./rc";
