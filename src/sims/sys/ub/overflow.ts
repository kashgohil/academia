/**
 * Integer overflow from the compiler's side, for the integer-overflow lesson.
 *
 * - fillWrites: `for (i = 0; i < n; i++) a[i + k] = 0;` with int or unsigned i, n and k. It gives the element indices
 *   that each build writes. With int, i + k cannot overflow in a defined execution, so clang turns the loop into one
 *   memset of n elements starting at a + k (golden fill.O2). With unsigned, i + k wraps modulo 2³², the indices may
 *   jump back to 0, and clang keeps a loop that zero-extends i + k on every iteration (golden fillu.O2).
 * - allocArray: the size computation `n * size` in 32-bit unsigned arithmetic, in size_t, and with a checked multiply;
 *   then the first writes of the fill loop on the shared machine, so a too-small block overflows into its neighbour.
 */
import { Machine, offset, T, type UbReport } from "../mem";

export const INT_MAX = 2147483647;
export const UINT_MAX = 4294967295;
export const TWO32 = 4294967296;

/** A run of element indices [from, to) that a loop writes, in exact integer index space. */
export interface Run { from: number; to: number }

/** Merge consecutive indices into runs. */
function runs(ix: number[]): Run[] {
  const out: Run[] = [];
  for (const x of ix) {
    const last = out[out.length - 1];
    if (last && last.to === x) last.to = x + 1;
    else out.push({ from: x, to: x + 1 });
  }
  return out;
}

export interface FillResult {
  /** Indices that the loop as written writes (32-bit arithmetic for i + k, then the index is extended to 64 bits). */
  written: Run[];
  /** Indices that the -O2 code writes. */
  optimized: Run[];
  /** The source has UB for these inputs (int only: i + k overflows). */
  ub: boolean;
  /** The -O2 code is one memset (int) or a loop (unsigned). */
  memset: boolean;
}

/** `signed` selects int i, n, k; otherwise unsigned. n is small (it is the trip count). */
export function fillWrites(n: number, k: number, signed: boolean): FillResult {
  const asWritten: number[] = [];
  for (let i = 0; i < n; i++) asWritten.push(signed ? (i + k) | 0 : (i + k) >>> 0);
  if (!signed) {
    // fillu.O2: mov ecx, edx (zero-extends the 32-bit i + k) ... inc edx: the same indices as written
    return { written: runs(asWritten), optimized: runs(asWritten), ub: false, memset: false };
  }
  const exact = Array.from({ length: n }, (_, i) => k + i); // memset(a + k, 0, 4n): sign-extend k once, then contiguous
  const ub = n > 0 && k + n - 1 > INT_MAX;
  return { written: runs(asWritten), optimized: runs(exact), ub, memset: true };
}

// ---------------------------------------------------------------- malloc(n * size)

export type SizeMode = "u32" | "size_t" | "checked";

export interface AllocPlan {
  /** The true product n · size. */
  exact: number;
  /** The value passed to malloc, or null if the code refuses (checked multiply). */
  requested: number | null;
  wrapped: boolean;
}

/** The size computation of `malloc(n * size)` in each mode. 64-bit products here stay far below 2⁵³. */
export function planAlloc(n: number, size: number, mode: SizeMode): AllocPlan {
  const exact = n * size;
  if (mode === "u32") {
    const r = Number(BigInt(exact) % BigInt(TWO32));
    return { exact, requested: r, wrapped: r !== exact };
  }
  if (mode === "checked") return { exact, requested: exact > UINT_MAX ? null : exact, wrapped: false };
  return { exact, requested: exact, wrapped: false };
}

export interface FillRun {
  plan: AllocPlan;
  /** Bytes the block can hold. */
  cap: number;
  /** Elements written before the model stops (it stops at the first UB or after `limit` elements). */
  written: number;
  ub: UbReport | null;
  /** Heap snapshot after the writes. */
  snap: ReturnType<Machine["snapshot"]>;
  /** The neighbour's value after the writes, in hex: it started as 0x600d. */
  neighbour: string;
}

export const NEIGHBOUR_VALUE = 0x600d;
const PATTERN = 0x4141414141414141n;

/**
 * Allocate the array and a neighbour object (a 16-byte "session" with a value), then write elements of `size` bytes
 * (8-byte stores of 0x4141414141414141) for `limit` elements. The machine records the first UB and still does the
 * store, as the hardware would, so the neighbour gets overwritten. A real program would write all n elements, far past
 * the heap, and crash; the model stops after `limit`. The 32-bit product is computed for a 32-bit unsigned type
 * on the LP64 machine, like `uint32_t bytes = n * size`.
 */
export function runAllocFill(n: number, size: number, mode: SizeMode, limit = 4): FillRun {
  const plan = planAlloc(n, size, mode);
  const m = new Machine();
  m.call("main", []);
  if (plan.requested === null || plan.requested > 1 << 20) {
    // refused, or a big allocation the model does not make: no overflow
    return { plan, cap: plan.requested ?? 0, written: 0, ub: null, snap: m.snapshot(), neighbour: NEIGHBOUR_VALUE.toString(16) };
  }
  const arr = m.malloc(plan.requested, 16, `malloc(${plan.requested})`);
  const sess = m.malloc(16, 16, "session");
  m.store(sess, T.long, NEIGHBOUR_VALUE);
  const cap = m.snapshot().heap.find((b) => b.id === arr.alloc)!.cap;
  let written = 0;
  for (let e = 0; e < Math.min(n, limit); e++) {
    for (let b = 0; b < size; b += 8) m.store(offset(arr, e * size + b), T.long, PATTERN);
    written = e + 1;
  }
  const ub = m.ub[0] ?? null;
  const neighbour = BigInt.asUintN(64, BigInt(m.rawLoad(sess, T.long) as number | bigint)).toString(16);
  return { plan, cap, written, ub, snap: m.snapshot(), neighbour };
}
