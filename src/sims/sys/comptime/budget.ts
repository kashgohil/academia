/**
 * The budget of a compile-time evaluator: clang's constexpr step and depth limits, and Zig's eval branch quota.
 *
 * Facts (cited in the lesson): clang's defaults are -fconstexpr-steps=1048576 and -fconstexpr-depth=512
 * (clang/include/clang/Basic/LangOptions.def). Zig's default quota is 1000 (zig 0.17.1 language reference).
 *
 * Model, fitted to measurements: clang charges one step for each statement that it evaluates, a compound
 * statement included. Zig charges one branch for each loop iteration and one for each call. With these rules
 * the model gives the same largest n as the real compilers for all three functions below
 * (pinned in tests/unit/sys-comptime.test.ts):
 *
 *   function           clang 21 (Apple)   zig 0.17.1
 *   sumTo(n), a loop   1048571            999
 *   fibLoop(n)         262142             999
 *   fib(n), recursive  26                 13
 */

export const CLANG_STEPS = 1048576;
export const CLANG_DEPTH = 512;
export const ZIG_QUOTA = 1000;

export type BudgetFn = "sumTo" | "fibLoop" | "fib";
export type Evaluator = "clang" | "zig";

/** Calls that the naive recursive fib(n) makes, the first call included: 2·F(n+1) − 1. */
export function fibCalls(n: number): number {
  let a = 0, b = 1;
  for (let i = 0; i < n + 1; i++) [a, b] = [b, a + b];
  return 2 * a - 1;
}

export interface Cost { work: number; depth: number; limit: number; depthLimit: number; ok: boolean; why?: "work" | "depth"; message?: string }

/**
 * The work that one evaluator spends on fn(n).
 * clang: sumTo = n + 5 (body, 2 declarations, the for statement, return; 1 per iteration);
 *        fibLoop = 4n + 5 (the loop body is a compound statement with 3 statements);
 *        fib = 2 per call (the compound body and its return).
 * zig:   sumTo and fibLoop = n + 1 (n iterations and the call); fib = 1 per call.
 */
export function cost(fn: BudgetFn, n: number, ev: Evaluator): Cost {
  const calls = fn === "fib" ? fibCalls(n) : 1;
  const work = ev === "clang"
    ? fn === "sumTo" ? n + 5 : fn === "fibLoop" ? 4 * n + 5 : 2 * calls
    : fn === "fib" ? calls : n + 1;
  const depth = fn === "fib" ? Math.max(1, n) : 1;
  const limit = ev === "clang" ? CLANG_STEPS : ZIG_QUOTA;
  const depthLimit = ev === "clang" ? CLANG_DEPTH : Infinity;
  if (depth > depthLimit) return { work, depth, limit, depthLimit, ok: false, why: "depth", message: `constexpr evaluation exceeded maximum depth of ${CLANG_DEPTH} calls` };
  if (work > limit) {
    return {
      work, depth, limit, depthLimit, ok: false, why: "work",
      message: ev === "clang" ? "constexpr evaluation hit maximum step limit; possible infinite loop?" : `evaluation exceeded ${ZIG_QUOTA} backwards branches`,
    };
  }
  return { work, depth, limit, depthLimit, ok: true };
}

/** The largest n that fits the budget, by search over the model. */
export function largestBudgetN(fn: BudgetFn, ev: Evaluator): number {
  let lo = 0, hi = 4_000_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (cost(fn, mid, ev).ok) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** The measured largest n (clang 21 with -std=c++20; zig 0.17.1), for the test to compare with the model. */
export const MEASURED_MAX: Record<BudgetFn, Record<Evaluator, number>> = {
  sumTo: { clang: 1048571, zig: 999 },
  fibLoop: { clang: 262142, zig: 999 },
  fib: { clang: 26, zig: 13 },
};

export interface TreeNode { n: number; x: number; y: number; parent: number }
/** The call tree of fib(n) for drawing: leaves get x = 0, 1, 2, ...; a parent sits over its children. */
export function fibTree(n: number): TreeNode[] {
  const nodes: TreeNode[] = [];
  let leaf = 0;
  const walk = (k: number, depth: number, parent: number): number => {
    const id = nodes.length;
    nodes.push({ n: k, x: 0, y: depth, parent });
    if (k < 2) { nodes[id]!.x = leaf++; return id; }
    const a = walk(k - 1, depth + 1, id);
    const b = walk(k - 2, depth + 1, id);
    nodes[id]!.x = (nodes[a]!.x + nodes[b]!.x) / 2;
    return id;
  };
  walk(n, 0, -1);
  return nodes;
}
