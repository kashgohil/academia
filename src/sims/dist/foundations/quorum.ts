/**
 * How many nodes do I need to tolerate f faulty nodes? And how large must a quorum be?
 *
 * - Crash-stop with a perfect failure detector (a synchronous system): f + 1 nodes. One copy survives, and every node
 *   learns exactly who crashed, so no quorum is needed.
 * - Crash (or omission) in an asynchronous system: 2f + 1. A quorum must be reachable while f nodes are silent
 *   (q <= n - f), and any two quorums must share a node (2q > n), so that a read sees the last write.
 * - Byzantine: 3f + 1. Two quorums must share f + 1 nodes, so that at least one shared node is correct
 *   (2q - n >= f + 1), and a quorum must still be reachable with f silent nodes (q <= n - f).
 */

export type QModel = "sync-crash" | "crash" | "byzantine";
export const QMODELS: QModel[] = ["sync-crash", "crash", "byzantine"];

export const QMODEL_TEXT: Record<QModel, string> = {
  "sync-crash": "crash-stop, perfect detector",
  crash: "crash or omission, asynchronous",
  byzantine: "Byzantine",
};

/** The smallest number of nodes that tolerates f faults in each model. */
export function nodesNeeded(model: QModel, f: number): number {
  return model === "sync-crash" ? f + 1 : model === "crash" ? 2 * f + 1 : 3 * f + 1;
}

/** The smallest quorum that works for n nodes in each model: a majority for crash, a 2f + 1 of 3f + 1 for Byzantine. */
export function quorumSize(model: QModel, n: number, f: number): number {
  if (model === "sync-crash") return 1;
  if (model === "crash") return Math.floor(n / 2) + 1;
  return Math.ceil((n + f + 1) / 2);
}

/** The fewest nodes that two quorums of size q out of n can share. */
export const minOverlap = (n: number, q: number) => Math.max(0, 2 * q - n);

export interface QuorumCheck {
  /** A quorum can still form when f nodes are silent. */
  live: boolean;
  /** Any two quorums share enough nodes for the model. */
  safe: boolean;
  overlap: number;
  /** The overlap that the model needs: 1 for crash, f + 1 for Byzantine. */
  overlapNeeded: number;
}

export function checkQuorum(model: QModel, n: number, q: number, f: number): QuorumCheck {
  const overlap = minOverlap(n, q);
  const overlapNeeded = model === "byzantine" ? f + 1 : model === "crash" ? 1 : 0;
  return { live: q <= n - f, safe: overlap >= overlapNeeded, overlap, overlapNeeded };
}

/** Every pair of q-subsets of n nodes, by brute force: the smallest intersection. For tests of minOverlap. */
export function bruteMinOverlap(n: number, q: number): number {
  const sets: number[] = [];
  for (let m = 0; m < 1 << n; m++) if (popcount(m) === q) sets.push(m);
  let best = n;
  for (const a of sets) for (const b of sets) best = Math.min(best, popcount(a & b));
  return best;
}

function popcount(x: number) {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}
