/**
 * The kernel's object allocator, as a path model: kmalloc size classes, SLUB's layers, and the page allocator below.
 *
 * Classic SLUB layout, per cache:
 *   per CPU: c->freelist (lockless), c->slab (the slab that owns that freelist), c->partial (a short list)
 *   per NUMA node: n->partial, protected by n->list_lock
 *   below: the page allocator: per-CPU page lists (pcp), then the zone's buddy lists under zone->lock.
 *
 * alloc() tries each layer in order and reports which one served the request. free() is fast only if the
 * object belongs to this CPU's current slab. Otherwise it pushes onto the slab's own freelist.
 *
 * Linux 6.18 added a per-CPU layer called "sheaves" for some caches, and Linux 7.0 made it the main path. This model shows the classic path.
 *
 * Path costs are model inputs, for scale only.
 */
import { BuddyHeap } from "../../allocextrasB";

export const PAGE_BYTES = 4096;
/** PAGE_ALLOC_COSTLY_ORDER: larger orders are "costly", and SLUB's default slub_max_order. */
export const COSTLY_ORDER = 3;
/** Linux lists free blocks in orders 0..10 (4 KiB to 4 MiB). */
export const MAX_PAGE_ORDER = 10;
/** The largest size that kmalloc serves from a slab cache: two pages. */
export const KMALLOC_MAX_CACHE = 2 * PAGE_BYTES;

/** The general kmalloc caches on x86-64 with 4 KiB pages, as listed in /proc/slabinfo. */
export const KMALLOC_CLASSES = [8, 16, 32, 64, 96, 128, 192, 256, 512, 1024, 2048, 4096, 8192] as const;

export const classLabel = (c: number) => (c >= 1024 ? `kmalloc-${c / 1024}k` : `kmalloc-${c}`);

/** The class that serves a request, or null if the request goes straight to the page allocator. */
export function kmallocClass(size: number): number | null {
  if (size > KMALLOC_MAX_CACHE) return null;
  return KMALLOC_CLASSES.find((c) => c >= size) ?? null;
}

export const getOrder = (bytes: number) => {
  let o = 0;
  while (PAGE_BYTES * 2 ** o < bytes) o++;
  return o;
};

const fls = (x: number) => (x === 0 ? 0 : 32 - Math.clz32(x));

/**
 * calculate_order() in mm/slub.c: the smallest order that holds enough objects and wastes at most 1/16 of the slab.
 * If nothing fits, it relaxes the waste limit to 1/8, then 1/4, and it lowers the object count.
 */
export function calculateOrder(size: number, cpus = 8, maxOrder = COSTLY_ORDER): number {
  let minObjects = 4 * (fls(cpus) + 1);
  const objsAtMax = Math.floor((PAGE_BYTES * 2 ** maxOrder) / size);
  minObjects = Math.min(minObjects, objsAtMax);
  while (minObjects >= 1) {
    for (let fraction = 16; fraction > 1; fraction /= 2) {
      for (let order = getOrder(minObjects * size); order <= maxOrder; order++) {
        const slab = PAGE_BYTES * 2 ** order;
        if (slab % size <= slab / fraction) return order;
      }
    }
    minObjects--;
  }
  return Math.min(getOrder(size), MAX_PAGE_ORDER);
}

export function slabLayout(size: number, cpus = 8) {
  const order = calculateOrder(size, cpus);
  const bytes = PAGE_BYTES * 2 ** order;
  const objects = Math.floor(bytes / size);
  return { order, pages: 2 ** order, objects, wasteBytes: bytes - objects * size, waste: (bytes - objects * size) / bytes };
}

// ---------------- Page allocator: pcp lists above the buddy lists ----------------

export type PagePath = "pcp" | "buddy" | "fail";

export interface PageStats { pcpHits: number; buddyAllocs: number; zoneLocks: number; frees: number; fails: number }

/** A zone: a buddy allocator of `pages` with per-CPU lists for orders up to COSTLY_ORDER. */
export class PageAllocator {
  readonly heap: BuddyHeap;
  private pcp: number[][][];
  stats: PageStats = { pcpHits: 0, buddyAllocs: 0, zoneLocks: 0, frees: 0, fails: 0 };

  /** `batch` blocks move at a time; a list over `high` blocks returns a batch. Model inputs. */
  constructor(pages = 1024, cpus = 2, readonly batch = 4, readonly high = 12) {
    this.heap = new BuddyHeap(pages, 1);
    this.pcp = Array.from({ length: cpus }, () => Array.from({ length: COSTLY_ORDER + 1 }, () => []));
  }

  alloc(cpu: number, order: number): { addr: number | null; path: PagePath } {
    if (order <= COSTLY_ORDER) {
      const list = this.pcp[cpu]![order]!;
      if (list.length > 0) { this.stats.pcpHits++; return { addr: list.pop()!, path: "pcp" }; }
      // rmqueue_bulk: one lock round trip fills the list.
      this.stats.zoneLocks++;
      for (let i = 0; i < this.batch; i++) {
        const r = this.heap.alloc(2 ** order);
        if (r.off === null) break;
        list.push(r.off);
      }
      if (list.length === 0) { this.stats.fails++; return { addr: null, path: "fail" }; }
      this.stats.buddyAllocs++;
      return { addr: list.pop()!, path: "buddy" };
    }
    this.stats.zoneLocks++;
    const r = this.heap.alloc(2 ** order);
    if (r.off === null) { this.stats.fails++; return { addr: null, path: "fail" }; }
    this.stats.buddyAllocs++;
    return { addr: r.off, path: "buddy" };
  }

  free(cpu: number, addr: number, order: number) {
    this.stats.frees++;
    if (order > COSTLY_ORDER) { this.stats.zoneLocks++; this.heap.free(addr); return; }
    const list = this.pcp[cpu]![order]!;
    list.push(addr);
    if (list.length > this.high) {
      this.stats.zoneLocks++;
      for (let i = 0; i < this.batch; i++) this.heap.free(list.shift()!);
    }
  }

  pcpCount(cpu: number, order: number) { return this.pcp[cpu]![order]!.length; }
}

// ---------------- SLUB ----------------

export type AllocPath = "fast" | "slab-freelist" | "cpu-partial" | "node-partial" | "new-slab" | "fail";
export type FreePath = "fast" | "slab-freelist" | "to-cpu-partial" | "release-slab";

export const ALLOC_PATHS: AllocPath[] = ["fast", "slab-freelist", "cpu-partial", "node-partial", "new-slab"];

export const PATH_LABEL: Record<AllocPath, string> = {
  fast: "c->freelist",
  "slab-freelist": "c->slab freelist",
  "cpu-partial": "c->partial",
  "node-partial": "n->partial",
  "new-slab": "new slab (page allocator)",
  fail: "failed",
};

/** Model inputs: nanoseconds per path. Scale only. */
export const PATH_COST_NS: Record<AllocPath, number> = {
  fast: 10, "slab-freelist": 40, "cpu-partial": 60, "node-partial": 200, "new-slab": 2000, fail: 0,
};

export interface SlubSlab { id: number; addr: number; objects: number; freelist: number[]; inUse: number; owner: number | null; list: "cpu" | "cpu-partial" | "node-partial" | "full" }

export interface ObjRef { slab: SlubSlab; idx: number }

export interface SlubOptions { size: number; cpus?: number; cpuPartial?: number; minPartial?: number; layoutCpus?: number; pages?: PageAllocator }

/** set_min_partial(): how many partial slabs a node keeps before it frees empty ones. ilog2(size)/2, clamped to 5..10. */
export const minPartialFor = (size: number) => Math.max(5, Math.min(10, Math.floor(Math.floor(Math.log2(size)) / 2)));

/**
 * set_cpu_partial(): the limit of the per-CPU partial list. The kernel picks an object count by size, then
 * converts it to slabs, assuming each slab on the list is half full.
 */
export function cpuPartialSlabs(size: number, objects: number) {
  const nrObjects = size >= PAGE_BYTES ? 6 : size >= 1024 ? 24 : size >= 256 ? 52 : 120;
  return Math.ceil((nrObjects * 2) / objects);
}

export class SlubCache {
  readonly size: number;
  readonly order: number;
  readonly objects: number;
  readonly cpuPartial: number;
  readonly minPartial: number;
  readonly pages: PageAllocator;
  cpus: { freelist: number[]; slab: SlubSlab | null; partial: SlubSlab[] }[];
  node: SlubSlab[] = [];
  allocPaths: Record<AllocPath, number> = { fast: 0, "slab-freelist": 0, "cpu-partial": 0, "node-partial": 0, "new-slab": 0, fail: 0 };
  freePaths: Record<FreePath, number> = { fast: 0, "slab-freelist": 0, "to-cpu-partial": 0, "release-slab": 0 };
  listLocks = 0;
  slabsCreated = 0;
  slabsFreed = 0;
  private nextId = 0;
  private all = new Set<SlubSlab>();

  constructor(o: SlubOptions) {
    const cpus = o.cpus ?? 2;
    this.size = o.size;
    const lay = slabLayout(o.size, o.layoutCpus ?? 8);
    this.order = lay.order;
    this.objects = lay.objects;
    this.cpuPartial = o.cpuPartial ?? cpuPartialSlabs(o.size, lay.objects);
    this.minPartial = o.minPartial ?? minPartialFor(o.size);
    this.pages = o.pages ?? new PageAllocator(1024, cpus);
    this.cpus = Array.from({ length: cpus }, () => ({ freelist: [], slab: null, partial: [] }));
  }

  slabs() { return [...this.all]; }

  live() { return [...this.all].reduce((n, s) => n + s.inUse, 0); }

  alloc(cpu: number): { path: AllocPath; obj: ObjRef | null } {
    const c = this.cpus[cpu]!;
    const take = (path: AllocPath) => {
      const idx = c.freelist.pop()!;
      c.slab!.inUse++;
      this.allocPaths[path]++;
      return { path, obj: { slab: c.slab!, idx } };
    };
    if (c.freelist.length > 0) return take("fast");
    // Objects that other CPUs freed sit on the slab's own freelist.
    if (c.slab && c.slab.freelist.length > 0) {
      c.freelist = c.slab.freelist;
      c.slab.freelist = [];
      return take("slab-freelist");
    }
    // The current slab is used up. SLUB keeps no list of full slabs.
    if (c.slab) { c.slab.owner = null; c.slab.list = "full"; c.slab = null; }
    const adopt = (s: SlubSlab) => {
      s.owner = cpu; s.list = "cpu";
      c.slab = s;
      c.freelist = s.freelist;
      s.freelist = [];
    };
    const fromCpu = c.partial.pop();
    if (fromCpu) { adopt(fromCpu); return take("cpu-partial"); }
    if (this.node.length > 0) {
      this.listLocks++;
      adopt(this.node.shift()!);
      // get_partial_node() also moves more slabs to the per-CPU list.
      while (this.node.length > 0 && c.partial.length < Math.floor(this.cpuPartial / 2)) {
        const s = this.node.shift()!;
        s.list = "cpu-partial"; s.owner = cpu;
        c.partial.push(s);
      }
      return take("node-partial");
    }
    const r = this.pages.alloc(cpu, this.order);
    if (r.addr === null) { this.allocPaths.fail++; return { path: "fail", obj: null }; }
    const s: SlubSlab = { id: this.nextId++, addr: r.addr, objects: this.objects, freelist: Array.from({ length: this.objects }, (_, i) => this.objects - 1 - i), inUse: 0, owner: cpu, list: "cpu" };
    this.all.add(s);
    this.slabsCreated++;
    adopt(s);
    return take("new-slab");
  }

  free(cpu: number, obj: ObjRef): FreePath {
    const c = this.cpus[cpu]!;
    const s = obj.slab;
    if (c.slab === s) {
      c.freelist.push(obj.idx);
      s.inUse--;
      this.freePaths.fast++;
      return "fast";
    }
    const wasFull = s.list === "full";
    s.freelist.push(obj.idx);
    s.inUse--;
    if (wasFull) {
      // put_cpu_partial: the freeing CPU adopts a slab that was full.
      s.list = "cpu-partial"; s.owner = cpu;
      c.partial.push(s);
      if (c.partial.length > this.cpuPartial) {
        // The per-CPU list is over its limit: move all of it to the node list.
        this.listLocks++;
        for (const x of c.partial) { x.list = "node-partial"; x.owner = null; this.node.push(x); }
        c.partial = [];
        this.releaseEmpty();
      }
      this.freePaths["to-cpu-partial"]++;
      return "to-cpu-partial";
    }
    if (s.list === "node-partial" && s.inUse === 0 && this.node.length > this.minPartial) {
      this.listLocks++;
      this.node.splice(this.node.indexOf(s), 1);
      this.release(s, cpu);
      this.freePaths["release-slab"]++;
      return "release-slab";
    }
    this.freePaths["slab-freelist"]++;
    return "slab-freelist";
  }

  private releaseEmpty() {
    for (const s of [...this.node]) {
      if (s.inUse === 0 && this.node.length > this.minPartial) {
        this.node.splice(this.node.indexOf(s), 1);
        this.release(s, 0);
      }
    }
  }

  private release(s: SlubSlab, cpu: number) {
    this.all.delete(s);
    this.slabsFreed++;
    this.pages.free(cpu, s.addr, this.order);
  }

  /** Sum over all layers of the objects that are free. For invariant checks. */
  freeObjects() {
    let n = 0;
    for (const c of this.cpus) n += c.freelist.length;
    for (const s of this.all) n += s.freelist.length;
    return n;
  }

  totalAllocs() { return ALLOC_PATHS.reduce((a, p) => a + this.allocPaths[p], 0); }

  /** Mean cost per allocation, from PATH_COST_NS. */
  meanAllocNs() {
    const t = this.totalAllocs();
    return t === 0 ? 0 : ALLOC_PATHS.reduce((a, p) => a + this.allocPaths[p] * PATH_COST_NS[p], 0) / t;
  }

  fastShare() { const t = this.totalAllocs(); return t === 0 ? 0 : this.allocPaths.fast / t; }

  freeFastShare() {
    const t = this.freePaths.fast + this.freePaths["slab-freelist"] + this.freePaths["to-cpu-partial"] + this.freePaths["release-slab"];
    return t === 0 ? 0 : this.freePaths.fast / t;
  }
}

// ---------------- Workloads ----------------

export type SlubWorkload = "same-cpu" | "burst" | "producer-consumer";

export const SLUB_WORKLOAD_LABEL: Record<SlubWorkload, string> = {
  "same-cpu": "Alloc and free on one CPU",
  burst: "Bursts of 500",
  "producer-consumer": "Alloc on CPU 0, free on CPU 1",
};

/** Runs a fixed workload of `n` allocations and returns the cache. Deterministic. */
export function runSlubWorkload(w: SlubWorkload, size: number, n = 20000): SlubCache {
  const cache = new SlubCache({ size, cpus: 2, pages: new PageAllocator(1 << 16, 2) });
  if (w === "same-cpu") {
    const held: ObjRef[] = [];
    for (let i = 0; i < n; i++) {
      const a = cache.alloc(0);
      if (a.obj) held.push(a.obj);
      if (held.length > 8) cache.free(0, held.shift()!);
    }
  } else if (w === "burst") {
    const held: ObjRef[] = [];
    for (let i = 0; i < n; i++) {
      const a = cache.alloc(0);
      if (a.obj) held.push(a.obj);
      if (held.length === 500) { while (held.length) cache.free(0, held.pop()!); }
    }
  } else {
    const q: ObjRef[] = [];
    for (let i = 0; i < n; i++) {
      const a = cache.alloc(0);
      if (a.obj) q.push(a.obj);
      if (q.length > 8) cache.free(1, q.shift()!);
    }
  }
  return cache;
}

// ---------------- /proc/buddyinfo ----------------

/** Free blocks per order, like one row of /proc/buddyinfo, after allocating every page and freeing a random share. */
export function fragmentedZone(freeShare: number, rnd: () => number, heaps = 4, order = MAX_PAGE_ORDER): number[] {
  const counts = new Array<number>(order + 1).fill(0);
  const pages = 2 ** order;
  for (let h = 0; h < heaps; h++) {
    const z = new BuddyHeap(pages, 1);
    const addrs: number[] = [];
    for (let i = 0; i < pages; i++) addrs.push(z.alloc(1).off!);
    for (const a of addrs) if (rnd() < freeShare) z.free(a);
    z.freeCounts().forEach((c, k) => { counts[k]! += c; });
  }
  return counts;
}

/** The same free memory after compaction: every free page moved together, in blocks as large as possible. */
export function compactedZone(counts: readonly number[]): number[] {
  let free = freePages(counts);
  const out = new Array<number>(counts.length).fill(0);
  for (let k = counts.length - 1; k >= 0; k--) { out[k] = Math.floor(free / 2 ** k); free -= out[k]! * 2 ** k; }
  return out;
}

export const freePages = (counts: readonly number[]) => counts.reduce((a, c, k) => a + c * 2 ** k, 0);

export const largestOrder = (counts: readonly number[]) => { for (let k = counts.length - 1; k >= 0; k--) if (counts[k]! > 0) return k; return -1; };

/** __zone_watermark_ok in outline: free pages (minus the request) must exceed the mark, and a block of the right order must exist. */
export function zoneWatermarkOk(counts: readonly number[], order: number, markPages: number): boolean {
  if (freePages(counts) - (2 ** order - 1) <= markPages) return false;
  if (order === 0) return true;
  for (let k = order; k < counts.length; k++) if (counts[k]! > 0) return true;
  return false;
}

export function parseBuddyinfo(line: string): { node: number; zone: string; counts: number[] } | null {
  const m = /^Node\s+(\d+),\s+zone\s+(\S+)\s+([\d\s]+)$/.exec(line.trim());
  if (!m) return null;
  return { node: Number(m[1]), zone: m[2]!, counts: m[3]!.trim().split(/\s+/).map(Number) };
}
