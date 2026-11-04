/**
 * A set-associative TLB with LRU, ASIDs (PCIDs) and global entries; an MMU that puts one or two TLB
 * levels in front of a real PageTable walker; the reach model; and the shootdown cost model.
 * Every size and cycle count in TLB_MODEL, TRANSLATION_MODEL and SHOOTDOWN_MODEL is a MODEL INPUT.
 */
import { GiB, KiB, MiB, PAGE_SHIFT, PAGE_SIZE, PTE_BYTES, toU64 } from "./addr";
import { PageTable, type Access, type WalkResult } from "./pagetable";
import { mulberry32 } from "../../rng";

export interface TlbEntry {
  vpn: number;
  pageShift: number;
  pfn: number;
  asid: number;
  global: boolean;
  writable: boolean;
  user: boolean;
  nx: boolean;
  /** Set once a write has gone through the walker, so that the PTE D bit is known to be set. */
  dirty: boolean;
  lastUsed: number;
}

export interface TlbConfig { entries: number; ways: number; /** Page sizes that this TLB can hold. Default: 4 KiB only. */ pageShifts?: number[] }

export interface TlbStats { lookups: number; hits: number; misses: number; evictions: number; invalidations: number }

const LOW48 = (1n << 48n) - 1n;
/** Virtual address as a safe number: the low 48 bits. They are unique for canonical addresses. */
export const vaNumber = (va: bigint | number) => (typeof va === "number" ? va : Number(toU64(va) & LOW48));

export class Tlb {
  readonly entries: number;
  readonly ways: number;
  readonly sets: number;
  readonly pageShifts: number[];
  private slots: (TlbEntry | null)[];
  private clock = 0;
  stats: TlbStats = { lookups: 0, hits: 0, misses: 0, evictions: 0, invalidations: 0 };

  constructor(cfg: TlbConfig) {
    if (cfg.entries % cfg.ways !== 0) throw new Error("entries must be a multiple of ways");
    this.entries = cfg.entries;
    this.ways = cfg.ways;
    this.sets = cfg.entries / cfg.ways;
    this.pageShifts = cfg.pageShifts ?? [PAGE_SHIFT];
    this.slots = new Array(cfg.entries).fill(null);
  }

  setIndex(vpn: number) { return vpn % this.sets; }

  private probe(va: number, asid: number, touch: boolean): TlbEntry | null {
    for (const shift of this.pageShifts) {
      const vpn = Math.floor(va / 2 ** shift);
      const base = this.setIndex(vpn) * this.ways;
      for (let w = 0; w < this.ways; w++) {
        const e = this.slots[base + w];
        if (e && e.vpn === vpn && e.pageShift === shift && (e.global || e.asid === asid)) {
          if (touch) e.lastUsed = ++this.clock;
          return e;
        }
      }
    }
    return null;
  }

  /** Looks up va for this address space id. Counts a hit or a miss and updates LRU. */
  lookup(va: number, asid = 0): TlbEntry | null {
    this.stats.lookups++;
    const e = this.probe(va, asid, true);
    if (e) this.stats.hits++; else this.stats.misses++;
    return e;
  }

  /** Inserts a translation. Returns the entry it evicted, if any. */
  insert(va: number, pfn: number, pageShift: number, asid = 0, flags: { global?: boolean; writable?: boolean; user?: boolean; nx?: boolean; dirty?: boolean } = {}): TlbEntry | null {
    if (!this.pageShifts.includes(pageShift)) throw new Error(`this TLB does not hold pages of shift ${pageShift}`);
    const vpn = Math.floor(va / 2 ** pageShift);
    const base = this.setIndex(vpn) * this.ways;
    let victim = base, oldest = Infinity;
    for (let w = 0; w < this.ways; w++) {
      const e = this.slots[base + w];
      if (!e) { victim = base + w; oldest = -1; break; }
      if (e.vpn === vpn && e.pageShift === pageShift && (e.asid === asid || e.global)) { victim = base + w; oldest = -1; break; }
      if (e.lastUsed < oldest) { oldest = e.lastUsed; victim = base + w; }
    }
    const evicted = oldest === -1 ? null : this.slots[victim]!;
    if (evicted) this.stats.evictions++;
    this.slots[victim] = { vpn, pageShift, pfn, asid, global: flags.global ?? false, writable: flags.writable ?? true, user: flags.user ?? true, nx: flags.nx ?? false, dirty: flags.dirty ?? false, lastUsed: ++this.clock };
    return evicted;
  }

  /** INVLPG: removes every entry that covers va for this asid, and any global entry that covers it. */
  invalidatePage(va: number, asid = 0): number {
    let n = 0;
    for (const shift of this.pageShifts) {
      const vpn = Math.floor(va / 2 ** shift);
      const base = this.setIndex(vpn) * this.ways;
      for (let w = 0; w < this.ways; w++) {
        const e = this.slots[base + w];
        if (e && e.vpn === vpn && e.pageShift === shift && (e.global || e.asid === asid)) { this.slots[base + w] = null; n++; }
      }
    }
    this.stats.invalidations += n;
    return n;
  }

  /** Removes all non-global entries of one asid (INVPCID single-context). */
  invalidateAsid(asid: number): number {
    let n = 0;
    this.slots.forEach((e, i) => { if (e && !e.global && e.asid === asid) { this.slots[i] = null; n++; } });
    this.stats.invalidations += n;
    return n;
  }

  /** Removes everything. keepGlobal models a CR3 load without PCID: global entries survive. */
  flush(keepGlobal = false): number {
    let n = 0;
    this.slots.forEach((e, i) => { if (e && !(keepGlobal && e.global)) { this.slots[i] = null; n++; } });
    this.stats.invalidations += n;
    return n;
  }

  /** All slots as [set][way], for views. Does not touch LRU. */
  snapshot(): (TlbEntry | null)[][] {
    return Array.from({ length: this.sets }, (_, s) => this.slots.slice(s * this.ways, (s + 1) * this.ways));
  }
  /** Way that LRU would replace next in this set. */
  victimWay(set: number): number {
    let best = 0, oldest = Infinity;
    for (let w = 0; w < this.ways; w++) {
      const e = this.slots[set * this.ways + w];
      if (!e) return w;
      if (e.lastUsed < oldest) { oldest = e.lastUsed; best = w; }
    }
    return best;
  }
  get occupied() { return this.slots.reduce((a, e) => a + (e ? 1 : 0), 0); }
  get hitRate() { return this.stats.lookups ? this.stats.hits / this.stats.lookups : 0; }
}

export type TranslationLevel = "l1" | "l2" | "walk" | "fault";
export interface Translation { ok: boolean; level: TranslationLevel; pa?: number; pfn?: number; pageShift?: number; walk?: WalkResult; reads: number }

/** An MMU: TLB levels in front of a real walker. Change the page table, then call invlpg, as a kernel must. */
export class Mmu {
  pt: PageTable;
  asid: number;
  readonly l1: Tlb;
  readonly l2?: Tlb;
  /** When false, a context switch flushes the TLB, as on a CPU without PCID. */
  pcid: boolean;
  walks = 0;
  walkReads = 0;

  constructor(opts: { pt: PageTable; l1: Tlb; l2?: Tlb; asid?: number; pcid?: boolean }) {
    this.pt = opts.pt; this.l1 = opts.l1; this.l2 = opts.l2; this.asid = opts.asid ?? 0; this.pcid = opts.pcid ?? true;
  }

  private allows(e: TlbEntry, access: Access): boolean {
    const kind = access.kind ?? "r";
    if ((access.user ?? true) && !e.user) return false;
    if (kind === "w" && (!e.writable || !e.dirty)) return false; // a clean entry must walk once, to set the D bit
    if (kind === "x" && e.nx) return false;
    return true;
  }

  private done(e: TlbEntry, va: number, level: TranslationLevel, reads: number, walk?: WalkResult): Translation {
    return { ok: true, level, pa: e.pfn * PAGE_SIZE + (va % 2 ** e.pageShift), pfn: e.pfn, pageShift: e.pageShift, reads, walk };
  }

  /** Translates one access. A TLB hit never reads memory. A miss walks and fills. */
  translate(vaIn: bigint | number, access: Access = {}): Translation {
    const va = vaNumber(vaIn);
    const full = typeof vaIn === "bigint" ? vaIn : BigInt(vaIn);
    const e1 = this.l1.lookup(va, this.asid);
    if (e1 && this.allows(e1, access)) return this.done(e1, va, "l1", 0);
    const e2 = !e1 && this.l2 ? this.l2.lookup(va, this.asid) : null;
    if (e2 && this.allows(e2, access)) {
      this.l1.insert(va, e2.pfn, e2.pageShift, e2.asid, e2);
      return this.done(e2, va, "l2", 0);
    }
    const walk = this.pt.walk(full, access);
    this.walks++;
    this.walkReads += walk.events.length;
    if (!walk.ok) {
      // Hardware drops a stale entry when the walk faults.
      this.l1.invalidatePage(va, this.asid);
      this.l2?.invalidatePage(va, this.asid);
      return { ok: false, level: "fault", reads: walk.events.length, walk };
    }
    const flags = { global: walk.global, writable: walk.writable, user: walk.user, nx: walk.nx, dirty: (access.kind ?? "r") === "w" };
    const shift = walk.pageShift!;
    if (this.l2?.pageShifts.includes(shift)) this.l2.insert(va, walk.pfn!, shift, this.asid, flags);
    if (this.l1.pageShifts.includes(shift)) this.l1.insert(va, walk.pfn!, shift, this.asid, flags);
    return { ok: true, level: "walk", pa: walk.pfn! * PAGE_SIZE + (va % 2 ** shift), pfn: walk.pfn, pageShift: shift, reads: walk.events.length, walk };
  }

  /** INVLPG on this core. */
  invlpg(va: bigint | number) {
    const v = vaNumber(va);
    this.l1.invalidatePage(v, this.asid);
    this.l2?.invalidatePage(v, this.asid);
  }

  /** A CR3 load. With PCID, entries of the old address space stay valid under their tag. */
  switchTo(pt: PageTable, asid: number) {
    this.pt = pt;
    this.asid = asid;
    if (!this.pcid) { this.l1.flush(true); this.l2?.flush(true); }
  }
}

// ---------------- access patterns ----------------

export type TlbPatternId = "scan" | "stride" | "hot" | "conflict" | "random";
export const TLB_PATTERN_LABEL: Record<TlbPatternId, string> = {
  scan: "Array scan, 64-byte steps",
  stride: "One access per page, in a loop",
  hot: "Small hot set, in a loop",
  conflict: "Pages that share one set",
  random: "Pointer chase, random pages",
};

/** Builds a page-aligned trace. Length is about `length` accesses. Deterministic for a seed. */
export function tlbPattern(id: TlbPatternId, opts: { length: number; pages: number; pageSize: number; entries: number; ways: number; seed?: number; base?: number }): number[] {
  const base = opts.base ?? 0x7f0000000000;
  const { length, pages, pageSize, entries, ways } = opts;
  const out: number[] = [];
  switch (id) {
    case "scan": {
      const total = pages * pageSize;
      for (let i = 0; out.length < length; i++) out.push(base + ((i * 64) % total));
      break;
    }
    case "stride":
      for (let i = 0; out.length < length; i++) out.push(base + (i % pages) * pageSize);
      break;
    case "hot": {
      const n = Math.max(1, Math.floor(entries / 2));
      for (let i = 0; out.length < length; i++) out.push(base + (i % n) * pageSize);
      break;
    }
    case "conflict": {
      // Five pages (or ways + 1, if more) with equal page numbers modulo the set count. A set of fewer ways
      // can never hold them all, although the rest of the TLB is empty. A fully associative TLB holds them.
      const sets = entries / ways;
      const n = ways === entries ? 5 : Math.max(5, ways + 1);
      for (let i = 0; out.length < length; i++) out.push(base + (i % n) * sets * pageSize);
      break;
    }
    case "random": {
      const r = mulberry32(opts.seed ?? 7);
      for (; out.length < length; ) out.push(base + Math.floor(r() * pages) * pageSize);
      break;
    }
  }
  return out;
}

/** Runs a trace through one TLB level with no page table: a hit rate only. */
export function runTrace(trace: readonly number[], cfg: TlbConfig, pageShift = PAGE_SHIFT): { hitRate: number; hits: number; misses: number } {
  const t = new Tlb({ ...cfg, pageShifts: [pageShift] });
  for (const va of trace) if (!t.lookup(va)) t.insert(va, Math.floor(va / 2 ** pageShift), pageShift);
  return { hitRate: t.hitRate, hits: t.stats.hits, misses: t.stats.misses };
}

// ---------------- reach ----------------

export const reachBytes = (entries: number, pageSize: number) => entries * pageSize;

/** Architectural and Linux constants that the lessons quote. */
export const TLB_FACTS = {
  /** CR3 bits 11:0 hold the PCID. */
  pcidBits: 12,
  pcids: 2 ** 12,
  /** TLB_NR_DYN_ASIDS: recent address spaces that Linux keeps per CPU. */
  linuxDynAsids: 6,
  /** arm64 ASID widths. */
  arm64AsidBits: [8, 16],
};

export type PageSizeId = "4k" | "16k" | "2m" | "1g";
export const PAGE_SIZES: Record<PageSizeId, number> = { "4k": 4 * KiB, "16k": 16 * KiB, "2m": 2 * MiB, "1g": GiB };
export const PAGE_SIZE_LABEL: Record<PageSizeId, string> = { "4k": "4 KiB", "16k": "16 KiB", "2m": "2 MiB", "1g": "1 GiB" };

/**
 * MODEL INPUT: TLB sizes of an Intel Skylake core. L1 data TLB: 64 entries for 4 KiB, 32 for 2 MiB, 4 for 1 GiB.
 * L2: 1536 entries for 4 KiB and 2 MiB, 16 for 1 GiB. A 16 KiB page does not exist on x86-64;
 * that row is a what-if with the 4 KiB entry counts.
 */
export const TLB_MODEL: Record<PageSizeId, { l1: TlbConfig; l2: TlbConfig }> = {
  "4k": { l1: { entries: 64, ways: 4 }, l2: { entries: 1536, ways: 12 } },
  "16k": { l1: { entries: 64, ways: 4 }, l2: { entries: 1536, ways: 12 } },
  "2m": { l1: { entries: 32, ways: 4 }, l2: { entries: 1536, ways: 12 } },
  "1g": { l1: { entries: 4, ways: 4 }, l2: { entries: 16, ways: 4 } },
};

/** MODEL INPUT: cycle costs for the reach plot. Cache sizes and latencies are typical for a server core. */
export const TRANSLATION_MODEL = {
  l2HitCycles: 7,
  walkBaseCycles: 15,
  cacheBytes: [32 * KiB, MiB, 32 * MiB],
  cacheCycles: [5, 14, 50, 250],
};

/** Expected cycles for one random read in a region of this size, given the cache sizes in the model. */
export function expectedReadCycles(bytes: number, m = TRANSLATION_MODEL): number {
  let covered = 0, total = 0;
  m.cacheBytes.forEach((c, i) => {
    const p = Math.min(1, c / bytes);
    total += (p - covered) * m.cacheCycles[i]!;
    covered = p;
  });
  return total + (1 - covered) * m.cacheCycles[m.cacheBytes.length]!;
}

/** One walk: the base cost plus a read of the PTE. The upper levels are served from paging-structure caches. */
export const walkCycles = (wsBytes: number, pageSize: number, m = TRANSLATION_MODEL) => m.walkBaseCycles + expectedReadCycles((Math.max(1, wsBytes / pageSize)) * PTE_BYTES, m);

export interface ChaseResult { wsBytes: number; pageSize: number; l1Hit: number; l2Hit: number; walkRate: number; translationCycles: number; dataCycles: number; totalCycles: number }

/** Random pointer chase over a working set, through real TLB levels. Warmed up first, then measured. */
export function chase(wsBytes: number, id: PageSizeId, opts: { accesses?: number; seed?: number; m?: typeof TRANSLATION_MODEL } = {}): ChaseResult {
  const pageSize = PAGE_SIZES[id];
  const shift = Math.log2(pageSize);
  const cfg = TLB_MODEL[id];
  const accesses = opts.accesses ?? 20000;
  const m = opts.m ?? TRANSLATION_MODEL;
  const pages = Math.max(1, Math.ceil(wsBytes / pageSize));
  const l1 = new Tlb({ ...cfg.l1, pageShifts: [shift] });
  const l2 = new Tlb({ ...cfg.l2, pageShifts: [shift] });
  const r = mulberry32(opts.seed ?? 42);
  const warm = Math.min(cfg.l2.entries * 4, 8000);
  let hit1 = 0, hit2 = 0, walks = 0;
  for (let i = 0; i < warm + accesses; i++) {
    const va = Math.floor(r() * pages) * pageSize;
    const measured = i >= warm;
    if (l1.lookup(va)) { if (measured) hit1++; continue; }
    if (l2.lookup(va)) { if (measured) hit2++; }
    else { if (measured) walks++; l2.insert(va, 0, shift); }
    l1.insert(va, 0, shift);
  }
  const l2Hit = hit2 / accesses, walkRate = walks / accesses;
  const translationCycles = l2Hit * m.l2HitCycles + walkRate * walkCycles(wsBytes, pageSize, m);
  const dataCycles = expectedReadCycles(wsBytes, m);
  return { wsBytes, pageSize, l1Hit: hit1 / accesses, l2Hit, walkRate, translationCycles, dataCycles, totalCycles: translationCycles + dataCycles };
}

export interface ReachRow {
  id: PageSizeId;
  pageSize: number;
  l1Reach: number;
  l2Reach: number;
  /** Fraction of the working set that the L2 TLB can cover. */
  coverage: number;
  /** Miss rate for uniform random access: 1 - coverage, when the set is larger than the reach. */
  missRate: number;
  /** TLB entries that the whole working set would need. */
  entriesNeeded: number;
  /** Bytes of last-level page table for the set. */
  leafTableBytes: number;
  /** Bytes wasted when the last page is only partly used. */
  roundUpBytes: number;
  cyclesPerAccess: number;
}

export function reachRow(id: PageSizeId, wsBytes: number): ReachRow {
  const pageSize = PAGE_SIZES[id];
  const c = TLB_MODEL[id];
  const l2Reach = reachBytes(c.l2.entries, pageSize);
  const coverage = Math.min(1, l2Reach / wsBytes);
  const entriesNeeded = Math.ceil(wsBytes / pageSize);
  return {
    id, pageSize,
    l1Reach: reachBytes(c.l1.entries, pageSize), l2Reach, coverage, missRate: 1 - coverage, entriesNeeded,
    leafTableBytes: entriesNeeded * PTE_BYTES, roundUpBytes: entriesNeeded * pageSize - wsBytes,
    cyclesPerAccess: (1 - coverage) * walkCycles(wsBytes, pageSize),
  };
}

// ---------------- shootdown ----------------

/** MODEL INPUTS, in ns. The order of magnitude is what matters; the shape in N does not depend on them. */
export const SHOOTDOWN_MODEL = {
  /** The sender writes one interrupt command per target. */
  sendPerTargetNs: 50,
  /** Time for an IPI to reach a core. */
  deliverNs: 500,
  /** Interrupt entry and exit on the target. */
  interruptNs: 1000,
  /** One INVLPG. */
  invlpgNs: 100,
  /** A full non-global TLB flush. */
  fullFlushNs: 300,
  /** The target's write that the sender is spinning on. */
  ackNs: 100,
  /** The cost of one TLB refill after a flush. */
  refillNs: 30,
  /** Hardware broadcast (arm64 TLBI ... IS): cost per page on the sender, including the wait for completion. */
  broadcastPerPageNs: 300,
  /** Default of tlb_single_page_flush_ceiling: above this many pages Linux flushes the whole TLB. */
  flushCeiling: 33,
};

export interface ShootdownInput { cores: number; pages: number; broadcast?: boolean; tlbEntriesLost?: number; m?: typeof SHOOTDOWN_MODEL }
export interface CoreTimeline { core: number; sentAt: number; arriveAt: number; handlerDoneAt: number; ackAt: number }
export interface ShootdownResult {
  /** Core 0 runs munmap. Others run the same process. */
  cores: number;
  pages: number;
  fullFlush: boolean;
  /** Each target: IPI handled, invalidated, acknowledged. */
  timeline: CoreTimeline[];
  /** Time the munmap caller waits. */
  senderWaitNs: number;
  /** Time stolen on one target core. */
  perTargetNs: number;
  /** Sum over all cores, including the sender's wait and later refills. */
  totalCoreNs: number;
  ipis: number;
}

export function shootdown(i: ShootdownInput): ShootdownResult {
  const m = i.m ?? SHOOTDOWN_MODEL;
  const fullFlush = i.pages > m.flushCeiling;
  const invalidate = fullFlush ? m.fullFlushNs : i.pages * m.invlpgNs;
  const lost = fullFlush ? (i.tlbEntriesLost ?? 512) : 0;
  const refill = lost * m.refillNs;
  if (i.broadcast) {
    const senderWaitNs = i.pages * m.broadcastPerPageNs;
    return { cores: i.cores, pages: i.pages, fullFlush: false, timeline: [], senderWaitNs, perTargetNs: 0, totalCoreNs: senderWaitNs, ipis: 0 };
  }
  const targets = i.cores - 1;
  const timeline: CoreTimeline[] = [];
  let senderWaitNs = invalidate; // the sender flushes locally too
  for (let k = 1; k <= targets; k++) {
    const sentAt = k * m.sendPerTargetNs;
    const arriveAt = sentAt + m.deliverNs;
    const handlerDoneAt = arriveAt + m.interruptNs + invalidate;
    const ackAt = handlerDoneAt + m.ackNs;
    timeline.push({ core: k, sentAt, arriveAt, handlerDoneAt, ackAt });
    senderWaitNs = Math.max(senderWaitNs, ackAt);
  }
  const perTargetNs = targets > 0 ? m.interruptNs + invalidate + m.ackNs + refill : 0;
  return { cores: i.cores, pages: i.pages, fullFlush, timeline, senderWaitNs, perTargetNs, totalCoreNs: senderWaitNs + refill + targets * perTargetNs, ipis: targets };
}
