/**
 * Allocator lessons, group B (buddy, slab, fragmentation, general-purpose allocators).
 * Pure TypeScript models behind the demos in src/demos/AllocExtrasB.tsx.
 * Every number the lessons quote comes from these functions; tests/unit/allocextrasB.test.ts pins them.
 */
import { mulberry32, type Rng } from "./rng";

// ============================================================================
// Buddy allocator with a step log (splits, buddy checks, merges)
// ============================================================================

export interface BuddyEvent {
  kind: "take" | "split" | "merge" | "stop" | "fail";
  /** Offset and size of the block the event is about. */
  off: number;
  size: number;
  /** split: the upper half that goes on a free list. merge/stop: the buddy (off XOR size). */
  other?: number;
}

export interface BuddyBlock { off: number; size: number; order: number; /** null when free */ req: number | null }

export class BuddyHeap {
  readonly maxOrder: number;
  private freeLists: Set<number>[] = [];
  private live = new Map<number, { order: number; req: number }>();

  constructor(readonly total = 1024, readonly min = 16) {
    this.maxOrder = Math.round(Math.log2(total / min));
    this.reset();
  }

  reset() {
    this.freeLists = Array.from({ length: this.maxOrder + 1 }, () => new Set<number>());
    this.freeLists[this.maxOrder]!.add(0);
    this.live.clear();
  }

  sizeOf(order: number) { return this.min * 2 ** order; }

  /** Smallest order whose block holds `req` bytes, or -1 when the request is larger than the heap. */
  orderFor(req: number): number {
    let k = 0;
    while (k <= this.maxOrder && this.sizeOf(k) < req) k++;
    return k > this.maxOrder ? -1 : k;
  }

  alloc(req: number): { off: number | null; events: BuddyEvent[] } {
    const need = this.orderFor(Math.max(1, req));
    const events: BuddyEvent[] = [];
    let j = need < 0 ? -1 : need;
    while (j >= 0 && j <= this.maxOrder && this.freeLists[j]!.size === 0) j++;
    if (need < 0 || j > this.maxOrder) {
      events.push({ kind: "fail", off: 0, size: need < 0 ? req : this.sizeOf(need) });
      return { off: null, events };
    }
    // Lowest address first, so the pictures are stable.
    const off = Math.min(...this.freeLists[j]!);
    this.freeLists[j]!.delete(off);
    events.push({ kind: "take", off, size: this.sizeOf(j) });
    while (j > need) {
      j--;
      const upper = off + this.sizeOf(j);
      this.freeLists[j]!.add(upper);
      events.push({ kind: "split", off, size: this.sizeOf(j + 1), other: upper });
    }
    this.live.set(off, { order: need, req });
    return { off, events };
  }

  free(addr: number): { ok: boolean; events: BuddyEvent[] } {
    const b = this.live.get(addr);
    if (!b) return { ok: false, events: [] };
    this.live.delete(addr);
    const events: BuddyEvent[] = [];
    let off = addr, k = b.order;
    while (k < this.maxOrder) {
      const size = this.sizeOf(k);
      const buddy = off ^ size;
      if (!this.freeLists[k]!.has(buddy)) {
        events.push({ kind: "stop", off, size, other: buddy });
        break;
      }
      this.freeLists[k]!.delete(buddy);
      events.push({ kind: "merge", off, size, other: buddy });
      off = Math.min(off, buddy);
      k++;
    }
    this.freeLists[k]!.add(off);
    return { ok: true, events };
  }

  blocks(): BuddyBlock[] {
    const out: BuddyBlock[] = [];
    this.freeLists.forEach((s, k) => s.forEach((off) => out.push({ off, size: this.sizeOf(k), order: k, req: null })));
    this.live.forEach((v, off) => out.push({ off, size: this.sizeOf(v.order), order: v.order, req: v.req }));
    return out.sort((a, b) => a.off - b.off);
  }

  /** Free blocks per order, like one row of /proc/buddyinfo. */
  freeCounts(): number[] { return this.freeLists.map((s) => s.size); }

  stats() {
    let requested = 0, allocated = 0, free = 0, largestFree = 0;
    for (const b of this.blocks()) {
      if (b.req === null) { free += b.size; largestFree = Math.max(largestFree, b.size); }
      else { requested += b.req; allocated += b.size; }
    }
    return { requested, allocated, internal: allocated - requested, free, largestFree, liveCount: this.live.size };
  }
}

/** Size of a Linux page block of a given order, with 4 KiB pages. */
export const linuxOrderBytes = (order: number, page = 4096) => page * 2 ** order;

// ============================================================================
// Size-class spacing: rounding waste for k classes per doubling
// ============================================================================

/** Size classes up to `max`: steps of `quantum` at first, then `perDoubling` classes in each doubling. */
export function sizeClasses(perDoubling: number, max = 4096, quantum = 16): number[] {
  const out = [quantum];
  while (out.at(-1)! < max) {
    const c = out.at(-1)!;
    const base = 2 ** Math.floor(Math.log2(c));
    const step = Math.max(quantum, base / perDoubling);
    out.push(c + step);
  }
  return out;
}

export const roundToClass = (classes: readonly number[], n: number) => classes.find((c) => c >= n) ?? n;

/** Wasted fraction of the block for each request size lo..hi, plus the worst case and the average. */
export function spacingStats(perDoubling: number, lo = 129, hi = 2048) {
  const classes = sizeClasses(perDoubling, hi);
  let worst = 0, worstAt = lo, sum = 0;
  const curve: [number, number][] = [];
  for (let n = lo; n <= hi; n++) {
    const c = roundToClass(classes, n);
    const w = (c - n) / c;
    sum += w;
    if (w > worst) { worst = w; worstAt = n; }
    curve.push([n, w]);
  }
  return {
    classes,
    classesInRange: classes.filter((c) => c >= lo && c <= hi).length,
    worst,
    worstAt,
    avg: sum / (hi - lo + 1),
    curve,
  };
}

// ============================================================================
// Slab caches: full, partial and empty slabs; object caching
// ============================================================================

export interface Slab { id: number; live: boolean[] }

export class SlabCache {
  readonly perSlab: number;
  slabs: Slab[] = [];
  pagesTaken = 0;
  pagesReturned = 0;
  allocs = 0;
  /** Constructor calls. Objects are constructed once, when their slab is created (Bonwick's object caching). */
  ctorCalls = 0;
  private nextId = 1;

  constructor(readonly objSize: number, readonly slabBytes = 4096, readonly keepEmpty = 0) {
    this.perSlab = Math.floor(slabBytes / objSize);
  }

  liveCount() { return this.slabs.reduce((n, s) => n + s.live.filter(Boolean).length, 0); }

  lists() {
    const full: Slab[] = [], partial: Slab[] = [], empty: Slab[] = [];
    for (const s of this.slabs) {
      const n = s.live.filter(Boolean).length;
      (n === this.perSlab ? full : n === 0 ? empty : partial).push(s);
    }
    return { full, partial, empty };
  }

  alloc(): { slab: number; idx: number; grew: boolean } {
    this.allocs++;
    const { partial, empty } = this.lists();
    // Partial slabs first, fullest first, so that other slabs can drain to empty.
    partial.sort((a, b) => b.live.filter(Boolean).length - a.live.filter(Boolean).length);
    let s = partial[0] ?? empty[0];
    let grew = false;
    if (!s) {
      s = { id: this.nextId++, live: Array(this.perSlab).fill(false) as boolean[] };
      this.slabs.push(s);
      this.pagesTaken++;
      this.ctorCalls += this.perSlab;
      grew = true;
    }
    const idx = s.live.indexOf(false);
    s.live[idx] = true;
    return { slab: s.id, idx, grew };
  }

  free(slabId: number, idx: number): boolean {
    const s = this.slabs.find((x) => x.id === slabId);
    if (!s || !s.live[idx]) return false;
    s.live[idx] = false;
    if (s.live.every((x) => !x)) {
      const emptyCount = this.lists().empty.length;
      if (emptyCount > this.keepEmpty) {
        this.slabs = this.slabs.filter((x) => x !== s);
        this.pagesReturned++;
      }
    }
    return true;
  }

  /** Allocate or free (random live objects) until `target` objects are live. */
  setLive(target: number, rng: Rng) {
    while (this.liveCount() < target) this.alloc();
    while (this.liveCount() > target) {
      const all: [number, number][] = [];
      for (const s of this.slabs) s.live.forEach((l, i) => l && all.push([s.id, i]));
      const [id, i] = all[Math.floor(rng() * all.length)]!;
      this.free(id, i);
    }
  }
}

/** The three caches of the slab-lists demo. Each cache has its own random source, so the order of slider moves across caches does not matter. */
export const SLAB_DEMO_SIZES = [512, 640, 1024] as const;
export function slabDemo(keep: boolean) {
  return SLAB_DEMO_SIZES.map((o, i) => ({ cache: new SlabCache(o, 4096, keep ? 1 : 0), rng: mulberry32(5 + i) }));
}

/** Alloc and free one object, n times, in an empty cache. Returns the pages taken from the page allocator. */
export function slabPingPong(n: number, keepEmpty: number, objSize = 40) {
  const c = new SlabCache(objSize, 4096, keepEmpty);
  for (let i = 0; i < n; i++) {
    const a = c.alloc();
    c.free(a.slab, a.idx);
  }
  return c.pagesTaken;
}

/** How well objects of one size fill a slab of `pages` pages. */
export function slabFit(objSize: number, pages = 1, pageBytes = 4096, colorStep = 64) {
  const bytes = pages * pageBytes;
  const perSlab = Math.floor(bytes / objSize);
  const leftover = bytes - perSlab * objSize;
  return {
    bytes,
    perSlab,
    leftover,
    waste: leftover / bytes,
    /** Different start offsets (cache colors) that fit in the leftover space. */
    colors: Math.floor(leftover / colorStep) + 1,
  };
}

// ============================================================================
// Fragmentation explorer: exact-size first fit vs power-of-two (buddy) blocks
// ============================================================================

export type FragMode = "exact" | "buddy";

export interface FragBlock { off: number; size: number; req: number | null }

export interface FragStats {
  requested: number;
  allocated: number;
  internal: number;
  /** internal / allocated */
  internalFrac: number;
  free: number;
  largestFree: number;
  /** 1 - largestFree / free: the share of free memory that one request cannot use. */
  external: number;
  liveCount: number;
}

/** A 1 KiB heap. "exact": first fit with coalescing, 8-byte granules. "buddy": power-of-two blocks, 16 B minimum. */
export class FragHeap {
  static readonly GRANULE = 8;
  private list: FragBlock[] = [];
  private buddy: BuddyHeap;

  constructor(readonly mode: FragMode, readonly total = 1024) {
    this.buddy = new BuddyHeap(total, 16);
    this.reset();
  }

  reset() {
    this.list = [{ off: 0, size: this.total, req: null }];
    this.buddy.reset();
  }

  /** Block size that a request of `req` bytes takes. */
  blockFor(req: number): number {
    if (this.mode === "buddy") {
      const k = this.buddy.orderFor(req);
      return k < 0 ? Infinity : this.buddy.sizeOf(k);
    }
    return Math.ceil(Math.max(1, req) / FragHeap.GRANULE) * FragHeap.GRANULE;
  }

  alloc(req: number): number | null {
    if (this.mode === "buddy") return this.buddy.alloc(req).off;
    const size = this.blockFor(req);
    const i = this.list.findIndex((b) => b.req === null && b.size >= size);
    if (i < 0) return null;
    const b = this.list[i]!;
    const rest = b.size - size;
    const parts: FragBlock[] = [{ off: b.off, size, req }];
    if (rest > 0) parts.push({ off: b.off + size, size: rest, req: null });
    this.list.splice(i, 1, ...parts);
    return b.off;
  }

  free(off: number): boolean {
    if (this.mode === "buddy") return this.buddy.free(off).ok;
    const i = this.list.findIndex((b) => b.off === off && b.req !== null);
    if (i < 0) return false;
    this.list[i]!.req = null;
    // Coalesce with the next and the previous block.
    if (this.list[i + 1]?.req === null) this.list.splice(i, 2, { off, size: this.list[i]!.size + this.list[i + 1]!.size, req: null });
    if (i > 0 && this.list[i - 1]!.req === null) {
      const p = this.list[i - 1]!;
      this.list.splice(i - 1, 2, { off: p.off, size: p.size + this.list[i]!.size, req: null });
    }
    return true;
  }

  blocks(): FragBlock[] {
    return this.mode === "buddy" ? this.buddy.blocks().map((b) => ({ off: b.off, size: b.size, req: b.req })) : this.list.map((b) => ({ ...b }));
  }

  /** Largest request that fits right now. */
  largestRequest(): number {
    const lf = this.stats().largestFree;
    return lf;
  }

  stats(): FragStats {
    let requested = 0, allocated = 0, free = 0, largestFree = 0, liveCount = 0;
    for (const b of this.blocks()) {
      if (b.req === null) { free += b.size; largestFree = Math.max(largestFree, b.size); }
      else { requested += b.req; allocated += b.size; liveCount++; }
    }
    return {
      requested, allocated, internal: allocated - requested,
      internalFrac: allocated ? (allocated - requested) / allocated : 0,
      free, largestFree,
      external: free ? 1 - largestFree / free : 0,
      liveCount,
    };
  }
}

/** Fill the heap with 64 B objects, then free every second one. */
export function checkerboard(h: FragHeap) {
  h.reset();
  const xs: number[] = [];
  for (;;) {
    const a = h.alloc(64);
    if (a === null) break;
    xs.push(a);
  }
  xs.forEach((a, i) => i % 2 === 0 && h.free(a));
  return xs.length;
}

/** Allocate `req`-byte objects until the heap is full. Returns how many fit. */
export function fillWith(h: FragHeap, req: number) {
  h.reset();
  let n = 0;
  while (h.alloc(req) !== null) n++;
  return n;
}

// ============================================================================
// General-purpose allocator path model (tcmalloc-like)
// ============================================================================

/** 0 thread cache, 1 central free list (lock), 2 page heap, 3 operating system. */
export type Tier = 0 | 1 | 2 | 3;
export const TIER_NAMES = ["Thread cache", "Central free list", "Page heap", "Operating system"] as const;
/** Model cost per level. Each level is about ten times slower than the one above it. */
export const TIER_COST = [1, 10, 100, 1000] as const;

export const PAGE = 8192;
export const LARGE = 32 * 1024;
/** Pages the page heap asks the OS for when it is empty (1 MiB). */
export const OS_CHUNK_PAGES = 128;

export interface MOp { kind: "a" | "f"; thread: number; id: number; size: number }
export interface MStep { kind: "a" | "f"; thread: number; size: number; tier: Tier }

export type MWorkload = "steady" | "burst" | "prodcons" | "large";
export const M_WORKLOADS: { id: MWorkload; label: string; note: string }[] = [
  { id: "steady", label: "Steady churn", note: "One thread keeps about 200 small objects alive and replaces them at random." },
  { id: "burst", label: "Burst, then free all", note: "One thread allocates 500 small objects, then frees all of them. This repeats 4 times." },
  { id: "prodcons", label: "Producer and consumer", note: "Thread 1 allocates messages. Thread 2 frees them. Every free is a free from another thread." },
  { id: "large", label: "Large objects", note: "One thread allocates and frees objects of 40 to 256 KiB. They skip the size classes." },
];

const MCLASSES = sizeClasses(4, LARGE);

export function mallocTrace(w: MWorkload, seed = 11): MOp[] {
  const r = mulberry32(seed);
  const ops: MOp[] = [];
  let next = 0;
  const small = () => Math.round(16 * Math.exp(r() * Math.log(16))); // 16..256 B, log-uniform
  const alloc = (thread: number, size: number) => { ops.push({ kind: "a", thread, id: next, size }); return next++; };
  const free = (thread: number, id: number) => ops.push({ kind: "f", thread, id, size: 0 });
  if (w === "steady") {
    const live: number[] = [];
    for (let i = 0; i < 200; i++) live.push(alloc(0, small()));
    for (let i = 0; i < 3000; i++) {
      if (r() < 0.5) live.push(alloc(0, small()));
      else if (live.length) free(0, live.splice(Math.floor(r() * live.length), 1)[0]!);
    }
  } else if (w === "burst") {
    for (let round = 0; round < 4; round++) {
      const xs = Array.from({ length: 500 }, () => alloc(0, small()));
      xs.forEach((x) => free(0, x));
    }
  } else if (w === "prodcons") {
    const queue: number[] = [];
    for (let i = 0; i < 3000; i++) {
      if (queue.length < 20 || (queue.length < 100 && r() < 0.5)) queue.push(alloc(0, small()));
      else free(1, queue.shift()!);
    }
  } else {
    const live: number[] = [];
    for (let i = 0; i < 600; i++) {
      if (live.length < 8 && (live.length < 2 || r() < 0.5)) live.push(alloc(0, Math.round(40960 + r() * (262144 - 40960))));
      else free(0, live.splice(Math.floor(r() * live.length), 1)[0]!);
    }
  }
  return ops;
}

export interface MResult {
  steps: MStep[];
  /** Operations that reached each level as their deepest level. */
  counts: [number, number, number, number];
  avgCost: number;
  /** Share of operations that finished in the thread cache, with no lock. */
  fastShare: number;
}

/**
 * Runs a trace through a tcmalloc-like model.
 * Thread cache: up to `cacheCap` free objects per size class per thread; it refills and drains in batches of cacheCap/2.
 * Central free list: free objects per class, shared, behind a lock. It carves new spans from the page heap.
 * Page heap: free pages. When it is empty, it asks the OS for 1 MiB. Large objects go here directly.
 */
export function runMallocModel(ops: MOp[], cacheCap: number): MResult {
  const cap = Math.max(0, Math.round(cacheCap));
  const batch = Math.max(1, Math.floor(cap / 2));
  const tcache = new Map<string, number>();
  const central = new Map<number, number>();
  let pageHeap = 0;
  const sizes = new Map<number, number>();
  const steps: MStep[] = [];
  const counts: [number, number, number, number] = [0, 0, 0, 0];

  const takePages = (n: number): Tier => {
    let tier: Tier = 2;
    while (pageHeap < n) { pageHeap += Math.max(OS_CHUNK_PAGES, n); tier = 3; }
    pageHeap -= n;
    return tier;
  };
  const spanFor = (cls: number) => {
    const pages = Math.max(1, Math.ceil((8 * cls) / PAGE));
    return { pages, objs: Math.floor((pages * PAGE) / cls) };
  };
  /** Move `n` objects of class c from the central list to a thread. */
  const fromCentral = (c: number, n: number): Tier => {
    let tier: Tier = 1;
    let have = central.get(c) ?? 0;
    while (have < n) {
      const s = spanFor(MCLASSES[c]!);
      const t = takePages(s.pages);
      if (t > tier) tier = t;
      have += s.objs;
    }
    central.set(c, have - n);
    return tier;
  };

  for (const op of ops) {
    let tier: Tier = 0;
    const size = op.kind === "a" ? op.size : sizes.get(op.id)!;
    if (size > LARGE) {
      const pages = Math.ceil(size / PAGE);
      if (op.kind === "a") tier = takePages(pages);
      else { pageHeap += pages; tier = 2; }
    } else {
      const c = MCLASSES.findIndex((x) => x >= size);
      const key = `${op.thread}:${c}`;
      const have = tcache.get(key) ?? 0;
      if (op.kind === "a") {
        if (cap === 0) tier = fromCentral(c, 1);
        else if (have > 0) tcache.set(key, have - 1);
        else { tier = fromCentral(c, batch); tcache.set(key, batch - 1); }
      } else if (cap === 0) {
        central.set(c, (central.get(c) ?? 0) + 1);
        tier = 1;
      } else if (have + 1 > cap) {
        tcache.set(key, have + 1 - batch);
        central.set(c, (central.get(c) ?? 0) + batch);
        tier = 1;
      } else tcache.set(key, have + 1);
    }
    if (op.kind === "a") sizes.set(op.id, op.size);
    else sizes.delete(op.id);
    counts[tier]++;
    steps.push({ kind: op.kind, thread: op.thread, size, tier });
  }
  const n = steps.length || 1;
  return {
    steps,
    counts,
    avgCost: counts.reduce((s, c, i) => s + c * TIER_COST[i]!, 0) / n,
    fastShare: counts[0] / n,
  };
}
