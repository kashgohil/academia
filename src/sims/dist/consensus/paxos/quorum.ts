/**
 * Quorum arithmetic. A quorum is a set of nodes whose answer the protocol trusts. Consensus needs any two quorums
 * that can act in sequence to share at least one node, so that the second one learns what the first one did.
 */

/** The smallest majority of n nodes. */
export const majority = (n: number) => Math.floor(n / 2) + 1;

/** Crash faults that n nodes survive with majority quorums: they need n ≥ 2f + 1. */
export const crashTolerance = (n: number) => Math.floor((n - 1) / 2);

/** Byzantine faults that n nodes survive: they need n ≥ 3f + 1. */
export const byzTolerance = (n: number) => Math.floor((n - 1) / 3);

/** The smallest overlap of a set of size a and a set of size b, both taken from n nodes. */
export const minOverlap = (a: number, b: number, n: number) => Math.max(0, a + b - n);

export function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - i + 1)) / i;
  return Math.round(r);
}

/** All subsets of {0..n-1} with exactly k members, as bit masks. */
export function subsetsOfSize(n: number, k: number): number[] {
  const out: number[] = [];
  for (let m = 0; m < 1 << n; m++) if (popcount(m) === k) out.push(m);
  return out;
}

export function popcount(m: number): number {
  let c = 0;
  for (; m; m &= m - 1) c++;
  return c;
}

/** Brute force over every pair of k-subsets: how many pairs share no node, out of how many pairs. */
export function disjointPairs(n: number, k: number): { disjoint: number; pairs: number; minShared: number } {
  const s = subsetsOfSize(n, k);
  let disjoint = 0, minShared = Infinity;
  for (const a of s) for (const b of s) {
    const c = popcount(a & b);
    if (c === 0) disjoint++;
    if (c < minShared) minShared = c;
  }
  return { disjoint, pairs: s.length * s.length, minShared: s.length ? minShared : 0 };
}

/** The table of the lesson: for n nodes, the majority, the crash faults it survives, and the BFT figures. */
export function quorumTable(ns: number[]) {
  return ns.map((n) => ({ n, majority: majority(n), crash: crashTolerance(n), byz: byzTolerance(n), byzQuorum: n - byzTolerance(n) }));
}

/** Flexible Paxos (Howard, Malkhi and Spiegelman, 2016): only phase-1 and phase-2 quorums must intersect, q1 + q2 > n. */
export const flexibleQ1 = (n: number, q2: number) => n - q2 + 1;
