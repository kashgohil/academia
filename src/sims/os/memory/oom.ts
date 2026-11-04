/**
 * The OOM killer's arithmetic, overcommit accounting, and the Kubernetes oom_score_adj rules.
 * Page counts are in pages (4 KiB unless stated).
 */

export interface OomProc {
  name: string;
  rssPages: number;
  swapPages: number;
  pgtablePages: number;
  /** /proc/pid/oom_score_adj, -1000..1000. */
  adj: number;
  /** Kernel threads and init are never chosen. */
  unkillable?: boolean;
}

export const OOM_ADJ_MIN = -1000;
export const OOM_ADJ_MAX = 1000;

/**
 * oom_badness() in mm/oom_kill.c: rss + swap entries + page tables, plus adj * (totalpages / 1000), with integer division.
 * Returns null where the kernel returns LONG_MIN (never kill).
 */
export function oomBadness(p: OomProc, totalPages: number): number | null {
  if (p.unkillable || p.adj === OOM_ADJ_MIN) return null;
  const points = p.rssPages + p.swapPages + p.pgtablePages;
  return points + p.adj * Math.trunc(totalPages / 1000);
}

/** /proc/pid/oom_score: 1000 + badness * 1000 / totalpages (0 for a task that is never chosen). */
export function oomScore(p: OomProc, totalPages: number): number {
  const b = oomBadness(p, totalPages);
  if (b === null) return 0;
  return Math.max(0, 1000 + Math.trunc((b * 1000) / totalPages));
}

/** The index of the victim: the highest badness (a later task wins a tie, as in oom_evaluate_task). -1 if nothing can be killed. */
export function pickVictim(procs: readonly OomProc[], totalPages: number): number {
  let best = -1, bp = -Infinity;
  procs.forEach((p, i) => {
    const b = oomBadness(p, totalPages);
    if (b !== null && b >= bp) { bp = b; best = i; }
  });
  return best;
}

/** totalpages for a global OOM: RAM + swap. For a cgroup OOM: the cgroup's limit. */
export const globalTotalPages = (ramPages: number, swapPages: number) => ramPages + swapPages;

export type K8sQos = "guaranteed" | "burstable" | "besteffort";

/** The oom_score_adj that the kubelet sets, from the Kubernetes node-pressure eviction documentation. */
export function k8sOomScoreAdj(qos: K8sQos, requestBytes = 0, capacityBytes = 1): number {
  switch (qos) {
    case "guaranteed": return -997;
    case "besteffort": return 1000;
    case "burstable": return Math.min(Math.max(3, 1000 - Math.floor((1000 * requestBytes) / capacityBytes)), 999);
  }
}

// ---------------- overcommit ----------------

export type OvercommitMode = 0 | 1 | 2;

/** CommitLimit in /proc/meminfo: swap + RAM * overcommit_ratio / 100. */
export const commitLimit = (ram: number, swap: number, ratio = 50) => swap + (ram * ratio) / 100;

export interface OvercommitResult { ok: boolean; why: string }

/**
 * __vm_enough_memory() in mm/util.c, without the small admin and user reserves.
 * Mode 0 refuses only a single request larger than RAM + swap. Mode 1 never refuses. Mode 2 refuses when
 * Committed_AS would pass CommitLimit.
 */
export function overcommitCheck(mode: OvercommitMode, request: number, committed: number, ram: number, swap: number, ratio = 50): OvercommitResult {
  if (mode === 1) return { ok: true, why: "Mode 1 never refuses." };
  if (mode === 0) {
    return request > ram + swap
      ? { ok: false, why: "Mode 0 refuses one request that is larger than RAM + swap." }
      : { ok: true, why: "Mode 0 accepts it: this one request fits in RAM + swap." };
  }
  const limit = commitLimit(ram, swap, ratio);
  return committed + request > limit
    ? { ok: false, why: "Mode 2 refuses it: Committed_AS would pass CommitLimit." }
    : { ok: true, why: "Mode 2 accepts it: Committed_AS stays under CommitLimit." };
}

/** What happens when the program then touches `touched` of the memory it holds. */
export function touchOutcome(touched: number, ram: number, swap: number) {
  return touched > ram + swap ? "oom" as const : touched > ram ? "swap" as const : "ok" as const;
}
