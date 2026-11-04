/**
 * Page replacement on a reference string.
 *
 * A reference string lists the pages that a program touches, in order. A policy holds at most `frames`
 * pages. A reference to a page that is not resident is a fault; if every frame is in use, the policy
 * chooses a victim.
 *
 * Policies:
 * - min: Belady's MIN. Evicts the resident page whose next use is furthest in the future. It reads the future,
 *   so no kernel can run it. It is the exact optimum for demand paging (tests check this by exhaustive search).
 * - fifo: evicts the page that was loaded first.
 * - lru: evicts the page that was used longest ago.
 * - clock: one accessed bit per frame. The hand clears set bits and evicts the first frame whose bit is clear.
 * - twolist: a model of the classic Linux lists. New pages enter the inactive list; a second touch moves a page to
 *   the active list. Shadow entries record the eviction clock, so that a page which refaults within the size
 *   of the active list goes straight to the active list (mm/workingset.c).
 */
import { mulberry32 } from "../../rng";

export type ReplPolicy = "min" | "fifo" | "lru" | "clock" | "twolist";

export const REPL_LABEL: Record<ReplPolicy, string> = { min: "MIN", fifo: "FIFO", lru: "LRU", clock: "Clock", twolist: "Two lists" };

export interface ReplStep {
  ref: number;
  hit: boolean;
  /** Frame contents after this reference (null = empty). */
  frames: (number | null)[];
  /** The slot that received or served the page. */
  slot: number;
  evicted: number | null;
  faults: number;
  /** Clock only: accessed bits and hand position after this reference. */
  bits?: number[];
  hand?: number;
}

/** For each position, the index of the next reference to the same page (Infinity if none). */
export function nextUses(refs: readonly number[]): Float64Array {
  const out = new Float64Array(refs.length);
  const last = new Map<number, number>();
  for (let i = refs.length - 1; i >= 0; i--) {
    out[i] = last.get(refs[i]!) ?? Infinity;
    last.set(refs[i]!, i);
  }
  return out;
}

interface Run { faults: number; steps: ReplStep[] }

function runSlots(policy: Exclude<ReplPolicy, "twolist">, refs: readonly number[], n: number, trace: boolean): Run {
  const page = new Array<number | null>(n).fill(null);
  const where = new Map<number, number>();
  const stamp = new Float64Array(n);    // lru: last use; min: next use
  const bits = new Uint8Array(n);
  const next = policy === "min" ? nextUses(refs) : null;
  let fifo = 0, hand = 0, used = 0, faults = 0;
  const steps: ReplStep[] = [];
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i]!;
    let slot = where.get(r);
    const hit = slot !== undefined;
    let evicted: number | null = null;
    if (slot === undefined) {
      faults++;
      if (used < n) slot = used++;
      else {
        switch (policy) {
          case "fifo": slot = fifo; fifo = (fifo + 1) % n; break;
          case "lru": { let b = 0; for (let f = 1; f < n; f++) if (stamp[f]! < stamp[b]!) b = f; slot = b; break; }
          case "min": { let b = 0; for (let f = 1; f < n; f++) if (stamp[f]! > stamp[b]!) b = f; slot = b; break; }
          case "clock": {
            while (bits[hand]) { bits[hand] = 0; hand = (hand + 1) % n; }
            slot = hand; hand = (hand + 1) % n;
            break;
          }
        }
        evicted = page[slot]!;
        where.delete(evicted);
      }
      page[slot] = r;
      where.set(r, slot);
    }
    bits[slot] = 1;
    stamp[slot] = policy === "min" ? next![i]! : i;
    if (trace) {
      steps.push({ ref: r, hit, frames: page.slice(), slot, evicted, faults, ...(policy === "clock" ? { bits: Array.from(bits), hand } : {}) });
    }
  }
  return { faults, steps };
}

function runTwoList(refs: readonly number[], n: number, trace: boolean): Run {
  // Arrays of pages. Index 0 = head (newest), end = tail (next to leave).
  const active: number[] = [];
  const inactive: number[] = [];
  const referenced = new Set<number>();
  const shadow = new Map<number, number>();
  const slotOf = new Map<number, number>();
  const page = new Array<number | null>(n).fill(null);
  const maxActive = Math.max(1, n >> 1);
  let evictions = 0, faults = 0, used = 0;
  const steps: ReplStep[] = [];
  const rebalance = () => {
    while (active.length > maxActive) {
      const p = active.pop()!;
      referenced.delete(p);
      inactive.unshift(p);
    }
  };
  for (const r of refs) {
    let slot = slotOf.get(r);
    const hit = slot !== undefined;
    let evicted: number | null = null;
    if (hit) {
      const ai = active.indexOf(r);
      if (ai >= 0) { active.splice(ai, 1); active.unshift(r); }
      else if (referenced.has(r)) {
        inactive.splice(inactive.indexOf(r), 1);
        referenced.delete(r);
        active.unshift(r);
        rebalance();
      } else referenced.add(r);
    } else {
      faults++;
      if (used < n) slot = used++;
      else {
        if (inactive.length === 0) { active.length && inactive.unshift(active.pop()!); }
        evicted = inactive.pop()!;
        referenced.delete(evicted);
        slot = slotOf.get(evicted)!;
        slotOf.delete(evicted);
        shadow.set(evicted, evictions++);
      }
      page[slot!] = r;
      slotOf.set(r, slot!);
      const s = shadow.get(r);
      if (s !== undefined && evictions - s <= active.length) { active.unshift(r); rebalance(); }
      else inactive.unshift(r);
      shadow.delete(r);
    }
    if (trace) steps.push({ ref: r, hit, frames: page.slice(), slot: slot!, evicted, faults });
  }
  return { faults, steps };
}

/** Runs a policy and returns one step per reference. */
export function simulate(policy: ReplPolicy, refs: readonly number[], frames: number): ReplStep[] {
  return policy === "twolist" ? runTwoList(refs, frames, true).steps : runSlots(policy, refs, frames, true).steps;
}

/** Fault count only (no trace). */
export function countFaults(policy: ReplPolicy, refs: readonly number[], frames: number): number {
  return policy === "twolist" ? runTwoList(refs, frames, false).faults : runSlots(policy, refs, frames, false).faults;
}

/**
 * Mattson's stack algorithm: one pass gives the LRU fault count for every memory size at once.
 * Returns f where f[m] = LRU faults with m frames, for m = 0..maxFrames. LRU has the inclusion property (the m
 * most recently used pages are a subset of the m + 1 most recently used pages), so f never rises with m.
 */
export function lruFaultCurve(refs: readonly number[], maxFrames: number): number[] {
  const stack: number[] = []; // index 0 = most recent
  const dist = new Float64Array(maxFrames + 2);
  for (const r of refs) {
    const d = stack.indexOf(r);
    if (d >= 0) { stack.splice(d, 1); if (d < maxFrames) dist[d]!++; }
    stack.unshift(r);
  }
  const out = new Array<number>(maxFrames + 1);
  let hits = 0;
  out[0] = refs.length;
  for (let m = 1; m <= maxFrames; m++) { hits += dist[m - 1]!; out[m] = refs.length - hits; }
  return out;
}

/** Denning's working set: the distinct pages in the last tau references, sampled at each position. */
export function workingSetSeries(refs: readonly number[], tau: number): number[] {
  const count = new Map<number, number>();
  const out = new Array<number>(refs.length);
  for (let i = 0; i < refs.length; i++) {
    count.set(refs[i]!, (count.get(refs[i]!) ?? 0) + 1);
    if (i >= tau) {
      const o = refs[i - tau]!;
      const c = count.get(o)! - 1;
      if (c === 0) count.delete(o); else count.set(o, c);
    }
    out[i] = count.size;
  }
  return out;
}

// ---------------- Reference strings ----------------

/** The classic anomaly string (Belady, Nelson, Shedler 1969). FIFO and Clock: 9 faults with 3 frames, 10 with 4. */
export const BELADY_STRING: readonly number[] = [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5];
/** The textbook string from Silberschatz et al. */
export const TEXTBOOK_STRING: readonly number[] = [7, 0, 1, 2, 0, 3, 0, 4, 2, 3, 0, 3, 2, 1, 2, 0, 1, 7, 0, 1];
/** A loop one page larger than a 3-frame memory: LRU's worst case. */
export const LOOP_STRING: readonly number[] = [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4];

export function randomString(len: number, pages: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: len }, () => Math.floor(rnd() * pages));
}

// ---------------- Workloads for the fault curves ----------------

export type WorkloadId = "loop" | "uniform" | "zipf" | "phases" | "hotscan";

export const WORKLOAD_LABEL: Record<WorkloadId, string> = { loop: "Loop", uniform: "Uniform", zipf: "Zipf", phases: "Phases", hotscan: "Hot + scan" };
export const WORKLOAD_NOTE: Record<WorkloadId, string> = {
  loop: "A loop over 48 pages, in order.",
  uniform: "64 pages, each reference chosen at random.",
  zipf: "256 pages. A few pages take most of the references (Zipf, s = 1).",
  phases: "Locality: 24 pages at a time, and the program moves to a new set every 1,500 references.",
  hotscan: "24 hot pages take 75% of the references. The other 25% scan new pages that nobody reads again.",
};

export const WORKLOAD_LEN = 6000;

function zipfSampler(pages: number, s: number, rnd: () => number) {
  const cdf = new Float64Array(pages);
  let sum = 0;
  for (let i = 0; i < pages; i++) { sum += 1 / Math.pow(i + 1, s); cdf[i] = sum; }
  return () => {
    const u = rnd() * sum;
    let lo = 0, hi = pages - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m]! < u) lo = m + 1; else hi = m; }
    return lo;
  };
}

/** A program that works on `locality` pages at a time and moves to a fresh set every `phaseLen` references. */
export function phaseString(len: number, locality: number, phaseLen: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  let base = 0;
  for (let i = 0; i < len; i++) {
    if (i > 0 && i % phaseLen === 0) base += locality;
    out.push(base + Math.floor(rnd() * locality));
  }
  return out;
}

export function workload(id: WorkloadId, len = WORKLOAD_LEN, seed = 7): number[] {
  const rnd = mulberry32(seed);
  switch (id) {
    case "loop": return Array.from({ length: len }, (_, i) => i % 48);
    case "uniform": return Array.from({ length: len }, () => Math.floor(rnd() * 64));
    case "zipf": { const z = zipfSampler(256, 1, rnd); return Array.from({ length: len }, () => z()); }
    case "phases": return phaseString(len, 24, 1500, seed);
    case "hotscan": {
      let scan = 1000;
      return Array.from({ length: len }, () => (rnd() < 0.75 ? Math.floor(rnd() * 24) : scan++));
    }
  }
}

export const CURVE_FRAMES = [2, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96];

/** Fault rate per reference for one policy at several memory sizes. */
export function faultCurve(policy: ReplPolicy, refs: readonly number[], frames: readonly number[] = CURVE_FRAMES): [number, number][] {
  return frames.map((m) => [m, countFaults(policy, refs, m) / refs.length]);
}
