/** CPU-level models: branch predictors, an out-of-order scheduler, and a vectorization explainer. */
import { mulberry32 } from "../rng";

// ---------------- branch prediction ----------------

export type PredictorId = "static" | "one-bit" | "two-bit" | "gshare";

export interface Predictor { id: PredictorId; label: string; predict(pc: number): boolean; update(pc: number, taken: boolean): void }

export function makePredictor(id: PredictorId, bits = 12): Predictor {
  const size = 1 << bits, mask = size - 1;
  switch (id) {
    case "static":
      return { id, label: "Static: always taken", predict: () => true, update: () => {} };
    case "one-bit": {
      const t = new Uint8Array(size).fill(1);
      return { id, label: "1-bit: repeat last outcome", predict: (pc) => t[pc & mask] === 1, update: (pc, k) => { t[pc & mask] = +k; } };
    }
    case "two-bit": {
      const t = new Uint8Array(size).fill(2);
      return {
        id, label: "2-bit saturating counters",
        predict: (pc) => t[pc & mask]! >= 2,
        update: (pc, k) => { const i = pc & mask; t[i] = k ? Math.min(3, t[i]! + 1) : Math.max(0, t[i]! - 1); },
      };
    }
    case "gshare": {
      const t = new Uint8Array(size).fill(2);
      let h = 0;
      return {
        id, label: "gshare: counters indexed by PC ⊕ global history",
        predict: (pc) => t[(pc ^ h) & mask]! >= 2,
        update: (pc, k) => { const i = (pc ^ h) & mask; t[i] = k ? Math.min(3, t[i]! + 1) : Math.max(0, t[i]! - 1); h = ((h << 1) | +k) & mask; },
      };
    }
  }
}

export const PREDICTORS: PredictorId[] = ["static", "one-bit", "two-bit", "gshare"];

export interface BranchPattern { id: string; label: string; note: string; gen: (n: number, p: number) => { taken: boolean[]; pc: number[] } }

const single = (taken: boolean[]) => ({ taken, pc: taken.map(() => 7) });

export const BRANCH_PATTERNS: BranchPattern[] = [
  { id: "always", label: "Loop back-edge (always taken)", note: "for (…) { … }: taken every iteration.", gen: (n) => single(Array(n).fill(true)) },
  { id: "loop8", label: "Inner loop of 8 iterations", note: "Taken 7 times, then not taken once, repeated.", gen: (n) => single(Array.from({ length: n }, (_, i) => i % 8 !== 7)) },
  { id: "alternate", label: "Alternating T N T N", note: "if (i % 2 == 0).", gen: (n) => single(Array.from({ length: n }, (_, i) => i % 2 === 0)) },
  {
    id: "random", label: "Random data, taken with probability p", note: "if (x[i] < threshold) on random input.",
    gen: (n, p) => { const r = mulberry32(5); return single(Array.from({ length: n }, () => r() < p)); },
  },
  {
    id: "sorted", label: "Same condition on sorted data", note: "Not taken for the first half, taken for the second.",
    gen: (n) => single(Array.from({ length: n }, (_, i) => i >= n / 2)),
  },
  {
    id: "correlated", label: "Two correlated branches", note: "if (x > 0) {…}  if (x > 0 && y) {…}: the second follows the first.",
    gen: (n) => {
      const r = mulberry32(6), taken: boolean[] = [], pc: number[] = [];
      for (let i = 0; i < n / 2; i++) { const a = r() < 0.5; taken.push(a, a); pc.push(3, 11); }
      return { taken, pc };
    },
  },
];

export function mispredictRate(pred: PredictorId, pattern: BranchPattern, p = 0.5, n = 20000): number {
  const P = makePredictor(pred);
  const { taken, pc } = pattern.gen(n, p);
  let miss = 0;
  taken.forEach((k, i) => { if (P.predict(pc[i]!) !== k) miss++; P.update(pc[i]!, k); });
  return miss / taken.length;
}

/** Cycles per element of `if (x < t) sum += x` vs a branchless select (cmov / mask), given a mispredict rate. */
export const BRANCHY_BASE = 1.0, BRANCHLESS_BASE = 2.0, MISPREDICT_PENALTY = 16;
export const branchyCost = (miss: number) => BRANCHY_BASE + miss * MISPREDICT_PENALTY;
export const branchlessCost = () => BRANCHLESS_BASE;

// ---------------- out-of-order scheduling ----------------

export type Unit = "load" | "fadd" | "fmul" | "alu";
export interface Op { id: number; label: string; unit: Unit; deps: number[]; lat: number }
export interface CoreConfig { width: number; ports: Record<Unit, number> }

export const CORE: CoreConfig = { width: 4, ports: { load: 2, fadd: 2, fmul: 2, alu: 4 } };
export const LAT: Record<Unit, number> = { load: 5, fadd: 4, fmul: 4, alu: 1 };

/** Greedy list scheduling: each cycle, issue ready ops (oldest first) up to the width and per-unit port limits. */
export function schedule(ops: Op[], core: CoreConfig = CORE): { start: number[]; cycles: number } {
  const start = new Array<number>(ops.length).fill(-1);
  const done = (i: number) => start[i]! + ops[i]!.lat;
  let issued = 0, cycle = 0;
  while (issued < ops.length) {
    const used: Record<string, number> = {};
    let slots = core.width;
    for (let i = 0; i < ops.length && slots > 0; i++) {
      if (start[i]! >= 0) continue;
      const op = ops[i]!;
      if (!op.deps.every((d) => start[d]! >= 0 && done(d) <= cycle)) continue;
      if ((used[op.unit] ?? 0) >= core.ports[op.unit]) continue;
      start[i] = cycle;
      used[op.unit] = (used[op.unit] ?? 0) + 1;
      slots--;
      issued++;
    }
    cycle++;
  }
  return { start, cycles: Math.max(...ops.map((_, i) => done(i))) };
}

/**
 * Sum of n elements with k independent accumulators, processing `lanes` elements per op (SIMD width).
 * Loads feed adds; each accumulator's adds form a dependency chain; at the end the k accumulators
 * are combined in a tree (plus a horizontal reduction across lanes for SIMD).
 */
export function sumOps(n: number, k: number, lanes = 1): Op[] {
  const ops: Op[] = [];
  const add = (label: string, unit: Unit, deps: number[]) => { ops.push({ id: ops.length, label, unit, deps, lat: LAT[unit] }); return ops.length - 1; };
  const vecs = Math.ceil(n / lanes);
  const last: (number | null)[] = Array(k).fill(null);
  for (let i = 0; i < vecs; i++) {
    const ld = add(lanes > 1 ? `vload ${i}` : `load a[${i}]`, "load", []);
    const j = i % k;
    last[j] = add(`acc${j} += ${lanes > 1 ? `v${i}` : `a[${i}]`}`, "fadd", last[j] === null ? [ld] : [last[j]!, ld]);
  }
  let level = last.filter((x): x is number => x !== null);
  while (level.length > 1) {
    const next: number[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? add("combine", "fadd", [level[i]!, level[i + 1]!]) : level[i]!);
    level = next;
  }
  // Horizontal reduction across SIMD lanes: log2(lanes) shuffle+add steps.
  let tail = level[0]!;
  for (let s = lanes; s > 1; s /= 2) tail = add("horizontal add", "fadd", [tail]);
  void tail;
  return ops;
}

// ---------------- auto-vectorization ----------------

export interface LoopCase { id: string; code: string; rust: string }
export interface VecOptions { noAlias: boolean; fastMath: boolean; float: boolean }
export interface Verdict { vectorized: "yes" | "with-checks" | "no"; reason: string; speedup: number }

export const LOOPS: LoopCase[] = [
  { id: "add", code: "for (i = 0; i < n; i++) c[i] = a[i] + b[i];", rust: "for i in 0..n { c[i] = a[i] + b[i]; }" },
  { id: "reduce", code: "for (i = 0; i < n; i++) s += a[i];", rust: "let s: T = a.iter().sum();" },
  { id: "cond-reduce", code: "for (i = 0; i < n; i++) if (a[i] > 0) s += a[i];", rust: "a.iter().filter(|&&x| x > 0).sum()" },
  { id: "recurrence", code: "for (i = 1; i < n; i++) a[i] = a[i-1] * k + b[i];", rust: "for i in 1..n { a[i] = a[i-1] * k + b[i]; }" },
  { id: "gather", code: "for (i = 0; i < n; i++) s += a[idx[i]];", rust: "idx.iter().map(|&j| a[j]).sum()" },
  { id: "early-exit", code: "for (i = 0; i < n; i++) if (a[i] == key) return i;", rust: "a.iter().position(|&x| x == key)" },
  { id: "call", code: "for (i = 0; i < n; i++) c[i] = expensive(a[i]);", rust: "for i in 0..n { c[i] = expensive(a[i]); }" },
];

/** A simplified model of what LLVM and GCC do at -O3 for a 256-bit target (8 × 32-bit lanes). */
export function vectorize(id: string, o: VecOptions): Verdict {
  const W = 8;
  const reassoc = !o.float || o.fastMath; // integer add is associative; FP add only with permission
  switch (id) {
    case "add":
      return o.noAlias
        ? { vectorized: "yes", reason: "Independent iterations, contiguous access, no possible overlap.", speedup: W }
        : { vectorized: "with-checks", reason: "c might overlap a or b, so the compiler emits a runtime overlap check and keeps a scalar fallback loop.", speedup: W * 0.9 };
    case "reduce":
      return reassoc
        ? { vectorized: "yes", reason: o.float ? "Allowed to reassociate: W partial sums, combined at the end." : "Integer addition is associative: W partial sums, combined at the end.", speedup: W }
        : { vectorized: "no", reason: "Floating-point addition isn't associative; splitting the sum would change the rounding, so the compiler must keep one sequential chain.", speedup: 1 };
    case "cond-reduce":
      return reassoc
        ? { vectorized: "yes", reason: "If-conversion: compare to make a mask, then add only the selected lanes. No branch remains.", speedup: W * 0.8 }
        : { vectorized: "no", reason: "Same FP reassociation problem as the plain sum.", speedup: 1 };
    case "recurrence":
      return { vectorized: "no", reason: "Each iteration needs the previous iteration's result (a loop-carried dependency). Only an algorithmic change, such as a parallel prefix scan, can help.", speedup: 1 };
    case "gather":
      return reassoc
        ? { vectorized: "with-checks", reason: "Needs gather instructions for a[idx[i]]. AVX2/AVX-512 have them, but they load lane by lane internally, so compilers often judge them unprofitable; the gain is small.", speedup: 1.3 }
        : { vectorized: "no", reason: "FP reassociation not allowed, and the access is a gather.", speedup: 1 };
    case "early-exit":
      return { vectorized: "with-checks", reason: "Loops that can exit early were traditionally not vectorized. GCC 14 and recent LLVM handle simple search loops like this one; libraries (memchr, Rust's position on bytes) use hand-written SIMD.", speedup: W * 0.6 };
    case "call":
      return { vectorized: "no", reason: "An opaque function call per element blocks vectorization unless it's inlined, or a vector version exists (e.g. vector math libraries via -fveclib).", speedup: 1 };
  }
  return { vectorized: "no", reason: "", speedup: 1 };
}
