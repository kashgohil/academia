/**
 * Sims for the "ABI" module of the Systems Programming track: the contract between separately compiled code.
 * - callconv.ts: how five calling conventions (System V x86-64, AAPCS64, Microsoft x64, RISC-V LP64D, Go ABIInternal)
 *   pass and return a C struct by value; golden-checked against clang's LLVM IR.
 */
export * from "./callconv";
export * from "./bigstruct";
export * from "./mangle";
export * from "./demangle";
export * from "./abicompat";
export * from "./ffi";
