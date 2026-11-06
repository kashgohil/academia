/**
 * Vector clocks (Fidge 1988; Mattern 1988). Each process keeps one counter per process.
 * Rules: before a local event or a send, V[i] += 1. A message carries V. On a receive, V := max(V, V_msg), then V[i] += 1.
 * Comparison: V(a) ≤ V(b) if every entry is ≤. V(a) < V(b) if ≤ and not equal. Then a → b if and only if V(a) < V(b).
 */
import { eventOrder, type Run } from "./events";

export type VC = number[];

export const vcZero = (n: number): VC => new Array<number>(n).fill(0);
export const vcMerge = (a: VC, b: VC): VC => a.map((x, i) => Math.max(x, b[i] ?? 0));
export const vcTick = (a: VC, i: number): VC => a.map((x, j) => (j === i ? x + 1 : x));
export const vcLeq = (a: VC, b: VC) => a.every((x, i) => x <= (b[i] ?? 0));
export const vcEqual = (a: VC, b: VC) => a.length === b.length && a.every((x, i) => x === b[i]);
export const vcLess = (a: VC, b: VC) => vcLeq(a, b) && !vcEqual(a, b);

export type VcOrder = "before" | "after" | "equal" | "concurrent";

/** before: a < b; after: b < a; equal; concurrent: neither is ≤ the other. */
export function vcCompare(a: VC, b: VC): VcOrder {
  const le = vcLeq(a, b), ge = vcLeq(b, a);
  if (le && ge) return "equal";
  if (le) return "before";
  if (ge) return "after";
  return "concurrent";
}

export const vcText = (v: VC) => `[${v.join(",")}]`;

/** The vector timestamp of every event, indexed by event id. */
export function vectorStamps(run: Run): VC[] {
  const cur: VC[] = Array.from({ length: run.n }, () => vcZero(run.n));
  const V: VC[] = run.events.map(() => vcZero(run.n));
  for (const id of eventOrder(run)) {
    const e = run.events[id]!;
    let v = cur[e.proc]!;
    if (e.kind === "recv") v = vcMerge(v, V[run.msgs[e.msg!]!.send]!);
    v = vcTick(v, e.proc);
    cur[e.proc] = v;
    V[id] = v;
  }
  return V;
}

/**
 * Bytes to send a vector clock with one 8-byte counter and one 8-byte node id per entry, as a model input. The
 * point is the growth: the size is linear in the number of processes that ever wrote.
 */
export const vcBytes = (entries: number, bytesPerEntry = 16) => entries * bytesPerEntry;
