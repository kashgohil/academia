/**
 * GFP flags: what an allocation may do. The compositions match include/linux/gfp_types.h.
 *
 * Each base flag is a set of permissions: wake kswapd, reclaim directly (sleep), start I/O, enter file system code.
 * The calling context decides which permissions are safe. This module computes the outcome of a choice.
 */

export type GfpBit = "KSWAPD_RECLAIM" | "DIRECT_RECLAIM" | "IO" | "FS" | "HIGH" | "HARDWALL" | "MOVABLE" | "HIGHMEM";

export type GfpBase = "GFP_KERNEL" | "GFP_ATOMIC" | "GFP_NOWAIT" | "GFP_NOIO" | "GFP_NOFS" | "GFP_USER" | "GFP_HIGHUSER_MOVABLE";

const RECLAIM: GfpBit[] = ["KSWAPD_RECLAIM", "DIRECT_RECLAIM"];

export const GFP_BITS: Record<GfpBase, readonly GfpBit[]> = {
  GFP_ATOMIC: ["HIGH", "KSWAPD_RECLAIM"],
  GFP_KERNEL: [...RECLAIM, "IO", "FS"],
  GFP_NOWAIT: ["KSWAPD_RECLAIM"],
  GFP_NOIO: [...RECLAIM],
  GFP_NOFS: [...RECLAIM, "IO"],
  GFP_USER: [...RECLAIM, "IO", "FS", "HARDWALL"],
  GFP_HIGHUSER_MOVABLE: [...RECLAIM, "IO", "FS", "HARDWALL", "HIGHMEM", "MOVABLE"],
};

export type GfpContext = "process" | "spinlock" | "softirq" | "hardirq" | "rcu" | "block-io" | "fs-transaction";

export const CONTEXT_LABEL: Record<GfpContext, string> = {
  process: "Process context, no locks",
  spinlock: "Holding a spinlock",
  rcu: "Inside rcu_read_lock()",
  softirq: "Softirq (network receive)",
  hardirq: "Hard interrupt handler",
  "block-io": "Block driver, in the I/O path",
  "fs-transaction": "File system, in a transaction",
};

/** May code in this context call schedule()? */
export const contextMaySleep = (c: GfpContext) => c === "process" || c === "block-io" || c === "fs-transaction";

export type GfpModifier = "NOFAIL" | "NORETRY" | "RETRY_MAYFAIL" | "NOWARN" | "ZERO";

export type GfpVerdict = "ok" | "bug" | "deadlock" | "warn";

export interface GfpOutcome {
  bits: readonly GfpBit[];
  maySleep: boolean;
  wakesKswapd: boolean;
  directReclaim: boolean;
  mayStartIo: boolean;
  mayEnterFs: boolean;
  /** Fraction of the min watermark that this allocation may use up (0 = stops at min). */
  reserveShare: number;
  /** May the allocation return NULL? */
  mayFail: boolean;
  /** Can this allocation invoke the OOM killer? */
  mayOom: boolean;
  verdict: GfpVerdict;
  why: string;
}

/**
 * __GFP_HIGH callers may use 50% of the min watermark. Those that also cannot sleep, such as GFP_ATOMIC, may use
 * 62.5% (min/2, then a quarter of what is left). Without __GFP_HIGH, as in GFP_NOWAIT, the share is 0.
 * See __zone_watermark_ok and the ALLOC_MIN_RESERVE and ALLOC_NON_BLOCK flags in recent kernels.
 */
export function reserveShare(bits: readonly GfpBit[]): number {
  if (!bits.includes("HIGH")) return 0;
  let floor = 1 / 2;
  if (!bits.includes("DIRECT_RECLAIM")) floor -= floor / 4;
  return 1 - floor;
}

export function gfpOutcome(context: GfpContext, base: GfpBase, mods: readonly GfpModifier[], order: number): GfpOutcome {
  const bits = GFP_BITS[base];
  const direct = bits.includes("DIRECT_RECLAIM");
  const fs = bits.includes("FS"), io = bits.includes("IO");
  const costly = order > 3;
  const nofail = mods.includes("NOFAIL");
  const noretry = mods.includes("NORETRY");
  const mayfail = mods.includes("RETRY_MAYFAIL");
  // Without direct reclaim it can always fail. Small sleeping allocations retry until they succeed ("too small to fail").
  const mayFail = nofail ? false : !direct || costly || noretry || mayfail;
  // out_of_memory() does nothing for allocations without __GFP_FS (outside a cgroup OOM). Costly orders and
  // __GFP_NORETRY and __GFP_RETRY_MAYFAIL never reach it.
  const mayOom = direct && fs && !costly && !noretry && !mayfail;
  let verdict: GfpVerdict = "ok";
  let why: string;
  if (direct && !contextMaySleep(context)) {
    verdict = "bug";
    why = `This flag can sleep in reclaim, and this context must not sleep. With CONFIG_DEBUG_ATOMIC_SLEEP the kernel prints "BUG: sleeping function called from invalid context".`;
  } else if (nofail && !direct) {
    verdict = "bug";
    why = "__GFP_NOFAIL promises success, and without direct reclaim the kernel has no way to keep the promise. The kernel warns about this combination.";
  } else if (context === "block-io" && io) {
    verdict = "deadlock";
    why = "Reclaim may write dirty pages and wait for block I/O. That I/O may need this driver, which is waiting for this allocation. Use GFP_NOIO.";
  } else if (context === "fs-transaction" && fs) {
    verdict = "deadlock";
    why = "Reclaim may call back into the file system to write inodes or pages. The file system may wait for the transaction that you hold. Use GFP_NOFS.";
  } else if (nofail && order > 1) {
    verdict = "warn";
    why = "Through Linux 6.18, the kernel warns about __GFP_NOFAIL above order 1. Such a call can loop for a long time, and fragmentation can block it.";
  } else if (!direct) {
    why = "It cannot sleep, so it only takes what is free now and wakes kswapd" + (bits.includes("KSWAPD_RECLAIM") ? "." : " if it may.") + " The caller must handle NULL.";
  } else if (mayFail) {
    why = costly ? `Order ${order} is above PAGE_ALLOC_COSTLY_ORDER (3). The kernel tries reclaim and compaction, then it gives up and returns NULL. It does not call the OOM killer.`
      : noretry ? "__GFP_NORETRY tries reclaim once, then returns NULL. It does not call the OOM killer."
      : "__GFP_RETRY_MAYFAIL retries hard but returns NULL before it would call the OOM killer.";
  } else if (!fs) {
    why = "It may sleep and reclaim, but it does not call the OOM killer, because it could not try all of reclaim. It keeps retrying.";
  } else {
    why = "It may sleep, reclaim, and start I/O. At this order the kernel retries until it succeeds, and it may call the OOM killer on the way.";
  }
  return {
    bits, maySleep: direct, wakesKswapd: bits.includes("KSWAPD_RECLAIM"), directReclaim: direct, mayStartIo: direct && io, mayEnterFs: direct && fs,
    reserveShare: reserveShare(bits), mayFail, mayOom, verdict, why,
  };
}
