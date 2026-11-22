/**
 * What monomorphization costs: a counting model, and one real measurement.
 *
 * Model (`monoModel`): a chain of D generic functions, f1<T> calls f2<T> ... calls fD<T>, used with K types.
 * Model inputs, not measurements: each function body is `body` bytes of machine code; a thin wrapper is
 * `WRAPPER_BYTES`; a vtable has 3 header words plus one word per method (8-byte words). Three strategies:
 * - generic: every function is copied for every type: K·D copies.
 * - outlined: each function is a thin generic wrapper around one non-generic inner function
 *   (the pattern of `std::fs::read`): K·D wrappers and D inner bodies.
 * - dyn: one copy of each function, which takes `&dyn Trait`, plus one vtable per type.
 *
 * Measurement (`SORT_RUNS`): rustc 1.96.1, aarch64-apple-darwin, `rustc --edition 2024 -C opt-level=3
 * --crate-type=lib --emit=obj`. The crate has N functions; function k calls `v.sort_by(closure_k)` with a
 * different closure. "generic" passes the closure, so each closure type gets its own copy of the sort.
 * "dyn" passes it on as `&dyn Fn(&Rec, &Rec) -> Ordering` to one `sort_dyn` function. Size is the __text
 * section of the object file (`size -m`). Time is the best of 3 runs of rustc on an Apple M4 Pro (it varies by
 * machine and load; the size does not).
 */

export const WRAPPER_BYTES = 24;
export const WORD = 8;

export type Strategy = "generic" | "outlined" | "dyn";
export interface MonoParams { types: number; depth: number; body: number; methods: number }
export interface MonoResult {
  strategy: Strategy;
  /** Function copies in the binary. */
  functions: number;
  /** Bytes of code (model). */
  codeBytes: number;
  /** Bytes of vtables (model). */
  dataBytes: number;
  total: number;
  /** Bodies that the backend must optimize: the main cost in compile time. */
  bodiesCompiled: number;
  /** Calls through a pointer on one pass down the chain. */
  indirectCalls: number;
}

export function monoModel(s: Strategy, { types: k, depth: d, body, methods }: MonoParams): MonoResult {
  if (s === "generic") return { strategy: s, functions: k * d, codeBytes: k * d * body, dataBytes: 0, total: k * d * body, bodiesCompiled: k * d, indirectCalls: 0 };
  if (s === "outlined") {
    const code = k * d * WRAPPER_BYTES + d * body;
    return { strategy: s, functions: k * d + d, codeBytes: code, dataBytes: 0, total: code, bodiesCompiled: d, indirectCalls: 0 };
  }
  const data = k * (3 + methods) * WORD;
  return { strategy: s, functions: d, codeBytes: d * body, dataBytes: data, total: d * body + data, bodiesCompiled: d, indirectCalls: d * methods };
}

/** The number of types at which dyn becomes smaller than generic, for the given chain. */
export function crossover(p: Omit<MonoParams, "types">): number {
  for (let k = 1; k < 10_000; k++) if (monoModel("dyn", { ...p, types: k }).total < monoModel("generic", { ...p, types: k }).total) return k;
  return Infinity;
}

export interface SortRun { n: number; genericText: number; dynText: number; genericSec: number; dynSec: number }
export const SORT_RUNS: SortRun[] = [
  { n: 1, genericText: 5292, dynText: 6560, genericSec: 0.1, dynSec: 0.1 },
  { n: 2, genericText: 10668, dynText: 6656, genericSec: 0.15, dynSec: 0.1 },
  { n: 4, genericText: 21420, dynText: 6848, genericSec: 0.27, dynSec: 0.11 },
  { n: 8, genericText: 42924, dynText: 7232, genericSec: 0.51, dynSec: 0.11 },
  { n: 16, genericText: 85932, dynText: 8000, genericSec: 0.97, dynSec: 0.12 },
  { n: 32, genericText: 171948, dynText: 9536, genericSec: 1.91, dynSec: 0.13 },
];

/** A straight line through the first and last runs: bytes for each extra closure, and the base. */
export function sortSlopes() {
  const a = SORT_RUNS[0]!, b = SORT_RUNS[SORT_RUNS.length - 1]!;
  const dn = b.n - a.n;
  return {
    genericPer: (b.genericText - a.genericText) / dn,
    dynPer: (b.dynText - a.dynText) / dn,
    genericBase: a.genericText - (b.genericText - a.genericText) / dn * a.n,
    dynBase: a.dynText - (b.dynText - a.dynText) / dn * a.n,
    sizeRatio32: b.genericText / b.dynText,
    timeRatio32: b.genericSec / b.dynSec,
  };
}

/** The largest error of the straight line over all runs, as a fraction. */
export function sortLineError(): number {
  const s = sortSlopes();
  return Math.max(...SORT_RUNS.flatMap((r) => [
    Math.abs(s.genericBase + s.genericPer * r.n - r.genericText) / r.genericText,
    Math.abs(s.dynBase + s.dynPer * r.n - r.dynText) / r.dynText,
  ]));
}

/** The Rust source that the measurement compiles, for N closures. */
export function sortSource(n: number, mode: "generic" | "dyn"): string {
  const lines = ["use std::cmp::Ordering;", "#[derive(Clone, Copy)] pub struct Rec { pub a: u32, pub b: u32, pub c: u64 }"];
  if (mode === "dyn") lines.push("#[inline(never)]", "pub fn sort_dyn(v: &mut [Rec], f: &dyn Fn(&Rec, &Rec) -> Ordering) {", "    v.sort_by(|x, y| f(x, y))", "}");
  for (let k = 0; k < n; k++) {
    const key = (s: string) => `(${s}.a.rotate_left(${k + 1}) ^ ${(k * 2654435761) % 2 ** 32}u32)`;
    const cmp = `|x: &Rec, y: &Rec| ${key("x")}.cmp(&${key("y")})`;
    lines.push(mode === "generic" ? `pub fn sort_k${k}(v: &mut [Rec]) { v.sort_by(${cmp}) }` : `pub fn sort_k${k}(v: &mut [Rec]) { sort_dyn(v, &${cmp}) }`);
  }
  return lines.join("\n");
}
