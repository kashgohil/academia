/**
 * Buffer-pool policies and what each one makes recovery do.
 * STEAL: the pool may write a page that has uncommitted changes. NO-STEAL: it may not.
 * FORCE: commit writes every page the transaction changed. NO-FORCE: commit writes only the log.
 */

export type StealPolicy = "steal" | "no-steal";
export type ForcePolicy = "force" | "no-force";

export interface PolicyWorkload {
  /** Distinct pages each transaction changes. */
  pagesPerTxn: number;
  /** Pages that the workload updates (uniformly). */
  hotPages: number;
  /** Commits between two checkpoints (NO-FORCE writes dirty pages only at checkpoints). */
  commitsPerCheckpoint: number;
  /** Bytes changed in each update (the row). */
  rowBytes: number;
  /** Pages in the buffer pool. */
  poolPages: number;
}

export const LOG_HEADER_BYTES = 24;

export interface PolicyCost {
  undo: boolean;
  redo: boolean;
  /** Bytes of one update record: header + before image (undo) + after image (redo). */
  logBytesPerUpdate: number;
  /** Writes in the commit path: random page writes plus sequential log flushes. */
  commitPageWrites: number;
  commitLogFlushes: number;
  /** Page writes for every 1000 commits. */
  pageWritesPer1000: number;
  /** Largest transaction (pages) that can run; Infinity when the pool does not limit it. */
  maxTxnPages: number;
  /** True when this workload's transactions fit. */
  fits: boolean;
  /** Short notes on what recovery must do. */
  recovery: string;
}

/** Expected distinct pages touched by `m` transactions of `k` uniform pages each, over `h` pages. */
export function distinctPages(h: number, k: number, m: number): number {
  return h * (1 - Math.pow(1 - k / h, m));
}

export function policyCost(steal: StealPolicy, force: ForcePolicy, w: PolicyWorkload): PolicyCost {
  const undo = steal === "steal";
  const redo = force === "no-force";
  const logBytesPerUpdate = undo || redo ? LOG_HEADER_BYTES + (undo ? w.rowBytes : 0) + (redo ? w.rowBytes : 0) : 0;
  const commitPageWrites = force === "force" ? w.pagesPerTxn : 0;
  // NO-STEAL + FORCE needs no log at all, but must install all pages atomically (shadow paging):
  // one extra write of the root pointer stands in for the log flush.
  const commitLogFlushes = 1;
  const pageWritesPer1000 = force === "force"
    ? 1000 * w.pagesPerTxn
    : (distinctPages(w.hotPages, w.pagesPerTxn, w.commitsPerCheckpoint) * 1000) / w.commitsPerCheckpoint;
  const maxTxnPages = steal === "no-steal" ? w.poolPages : Infinity;
  const recovery = undo && redo
    ? "Undo losers and redo winners (ARIES)."
    : undo ? "Undo losers only. Committed pages are already on disk."
    : redo ? "Redo winners only. Uncommitted changes never reach disk."
    : "Nothing to do, if commit installs all pages in one atomic step.";
  return { undo, redo, logBytesPerUpdate, commitPageWrites, commitLogFlushes, pageWritesPer1000, maxTxnPages, fits: w.pagesPerTxn <= maxTxnPages, recovery };
}

export const DEFAULT_WORKLOAD: PolicyWorkload = { pagesPerTxn: 4, hotPages: 10_000, commitsPerCheckpoint: 10_000, rowBytes: 100, poolPages: 1000 };
