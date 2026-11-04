/**
 * Physical memory as frames grouped into 2 MiB blocks, with a fragmentation generator and compaction;
 * then a THP simulator on top: faults try a huge page, fall back to small pages, and khugepaged collapses later.
 * All costs in THP_COST are MODEL INPUTS.
 */
import { mulberry32 } from "../../rng";
import { PAGE_SIZE, SIZE_2M } from "./addr";

export const FRAMES_PER_BLOCK = 512;

/** Owner codes for one frame. A value >= 0 is the id of an application region that uses it as a small page. */
export const FREE = -1;
export const UNMOVABLE = -2;
export const OTHER = -3;
export const HUGE = -4;

export interface CompactResult { ok: boolean; block: number; moved: number; scanned: number }

export class PhysMem {
  readonly blocks: number;
  readonly frameCount: number;
  readonly owner: Int32Array;
  private usedInBlock: Int32Array;
  private pinnedInBlock: Int32Array;
  private hugeBlock: Uint8Array;
  /** Next-fit cursor for small allocations, which is what spreads them around. */
  private cursor = 0;

  constructor(blocks: number) {
    this.blocks = blocks;
    this.frameCount = blocks * FRAMES_PER_BLOCK;
    this.owner = new Int32Array(this.frameCount).fill(FREE);
    this.usedInBlock = new Int32Array(blocks);
    this.pinnedInBlock = new Int32Array(blocks);
    this.hugeBlock = new Uint8Array(blocks);
  }

  blockOf = (frame: number) => Math.floor(frame / FRAMES_PER_BLOCK);
  usedIn = (b: number) => this.usedInBlock[b]!;
  isHugeBlock = (b: number) => this.hugeBlock[b] === 1;
  get freeFrames() { return this.frameCount - this.usedInBlock.reduce((a, b) => a + b, 0); }
  get freeBlocks() { let n = 0; for (let b = 0; b < this.blocks; b++) if (this.usedInBlock[b] === 0) n++; return n; }

  private set(frame: number, owner: number) {
    const b = this.blockOf(frame);
    const old = this.owner[frame]!;
    if (old === owner) return;
    if (old === FREE) this.usedInBlock[b]!++;
    if (owner === FREE) this.usedInBlock[b]!--;
    if (old === UNMOVABLE) this.pinnedInBlock[b]!--;
    if (owner === UNMOVABLE) this.pinnedInBlock[b]!++;
    this.owner[frame] = owner;
  }

  /** Scatters other programs' pages. `used` is the fraction of all frames; `scatter` is the fraction of blocks they touch; `unmovable` is the fraction of blocks that also hold one pinned kernel page. */
  fragment(opts: { used: number; scatter: number; unmovable: number; seed: number }) {
    const r = mulberry32(opts.seed);
    const order = Array.from({ length: this.blocks }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
    const touched = order.slice(0, Math.round(this.blocks * opts.scatter));
    const wanted = Math.round(this.frameCount * opts.used);
    const perBlock = touched.length ? Math.min(FRAMES_PER_BLOCK, Math.round(wanted / touched.length)) : 0;
    for (const b of touched) {
      let left = perBlock;
      while (left > 0) {
        const f = b * FRAMES_PER_BLOCK + Math.floor(r() * FRAMES_PER_BLOCK);
        if (this.owner[f] === FREE) { this.set(f, OTHER); left--; }
      }
    }
    const pinned = touched.slice(0, Math.round(this.blocks * opts.unmovable));
    for (const b of pinned) this.set(b * FRAMES_PER_BLOCK + Math.floor(r() * FRAMES_PER_BLOCK), UNMOVABLE);
  }

  /** One free frame, next-fit. Returns -1 when memory is full. */
  allocSmall(owner: number): number {
    for (let i = 0; i < this.frameCount; i++) {
      const f = (this.cursor + i) % this.frameCount;
      if (this.owner[f] === FREE && !this.hugeBlock[this.blockOf(f)]) {
        this.set(f, owner);
        this.cursor = f + 1;
        return f;
      }
    }
    return -1;
  }

  freeSmall(frame: number) { this.set(frame, FREE); }

  /** A whole free block for a huge page, or -1. */
  allocBlock(): number {
    for (let b = 0; b < this.blocks; b++) {
      if (this.usedInBlock[b] !== 0) continue;
      for (let f = b * FRAMES_PER_BLOCK; f < (b + 1) * FRAMES_PER_BLOCK; f++) this.set(f, HUGE);
      this.hugeBlock[b] = 1;
      return b;
    }
    return -1;
  }

  freeBlock(b: number) {
    if (!this.hugeBlock[b]) throw new Error("not a huge block");
    this.hugeBlock[b] = 0;
    for (let f = b * FRAMES_PER_BLOCK; f < (b + 1) * FRAMES_PER_BLOCK; f++) this.set(f, FREE);
  }

  /**
   * Frees one block by moving its pages out. A block with a pinned page cannot be emptied: this is why
   * one unmovable kernel page ruins a whole 2 MiB block. Picks the movable block with the fewest pages.
   */
  compactOne(): CompactResult {
    let block = -1, least = Infinity, scanned = 0;
    for (let b = 0; b < this.blocks; b++) {
      scanned += FRAMES_PER_BLOCK;
      const u = this.usedInBlock[b]!;
      if (u === 0 || this.hugeBlock[b] || this.pinnedInBlock[b]! > 0) continue;
      if (u < least) { least = u; block = b; }
    }
    if (block < 0) return { ok: false, block: -1, moved: 0, scanned };
    if (this.freeFrames - (FRAMES_PER_BLOCK - least) < least) return { ok: false, block, moved: 0, scanned };
    let moved = 0;
    let dst = 0;
    const blockRange = [block * FRAMES_PER_BLOCK, (block + 1) * FRAMES_PER_BLOCK] as const;
    for (let f = blockRange[0]; f < blockRange[1]; f++) {
      const o = this.owner[f]!;
      if (o === FREE) continue;
      // The free scanner runs from low addresses here, and fills the fullest blocks only by chance.
      while (this.owner[dst] !== FREE || this.blockOf(dst) === block || this.hugeBlock[this.blockOf(dst)] || this.usedInBlock[this.blockOf(dst)] === 0) {
        dst++;
        scanned++;
        if (dst >= this.frameCount) return { ok: moved === least, block, moved, scanned };
      }
      this.set(dst, o);
      this.set(f, FREE);
      moved++;
    }
    return { ok: true, block, moved, scanned };
  }
}

// ---------------- THP ----------------

/** MODEL INPUTS, in ns. */
export const THP_COST = {
  /** One 4 KiB minor fault, including the kernel entry. */
  smallFaultNs: 1_000,
  /** A huge page fault: mostly the time to clear 2 MiB. */
  hugeFaultNs: 100_000,
  /** Migrate one page: unmap, TLB shootdown, copy, remap. */
  migratePageNs: 5_000,
  /** khugepaged copies one page into the huge page. */
  collapseCopyPageNs: 500,
};

export type ThpEnabled = "always" | "never";
/** Maps to /sys/kernel/mm/transparent_hugepage/defrag: never, defer (wake kcompactd), always (direct compaction). */
export type ThpDefrag = "never" | "defer" | "direct";

export interface ThpConfig {
  blocks: number;
  used: number;
  scatter: number;
  unmovable: number;
  seed: number;
  enabled: ThpEnabled;
  defrag: ThpDefrag;
  /** How many small pages the program touches in each 2 MiB region (1 to 512). */
  touchedPerRegion: number;
  /** khugepaged/max_ptes_none: empty PTEs allowed in a collapse. The default is 511. */
  maxPtesNone: number;
}

export const THP_DEFAULTS: ThpConfig = { blocks: 48, used: 0.4, scatter: 0.7, unmovable: 0.15, seed: 5, enabled: "always", defrag: "never", touchedPerRegion: 512, maxPtesNone: 511 };

export type RegionState = "huge" | "small";
export interface ThpRegion { id: number; state: RegionState; block: number; touched: number }

export type ThpEventKind = "fault-huge" | "fault-huge-compact" | "fault-small" | "oom" | "collapse" | "collapse-skip" | "kcompactd" | "compact-fail";
export interface ThpEvent { kind: ThpEventKind; region: number; latencyNs: number; moved: number; copied: number; text: string }

export interface ThpStats {
  regions: number;
  hugeRegions: number;
  smallRegions: number;
  smallPages: number;
  rssBytes: number;
  usefulBytes: number;
  bloat: number;
  tlbEntries: number;
  compactionMoved: number;
  compactionScanned: number;
  collapseCopied: number;
  collapses: number;
  fallbacks: number;
  /** Time the program stalled in faults. */
  faultNs: number;
  worstFaultNs: number;
  /** Background work by khugepaged and kcompactd. */
  backgroundNs: number;
}

export class ThpSim {
  readonly mem: PhysMem;
  readonly cfg: ThpConfig;
  regions: ThpRegion[] = [];
  events: ThpEvent[] = [];
  private scanCursor = 0;
  private counts = { compactionMoved: 0, compactionScanned: 0, collapseCopied: 0, collapses: 0, fallbacks: 0, faultNs: 0, worstFaultNs: 0, backgroundNs: 0 };

  constructor(cfg: Partial<ThpConfig> = {}) {
    this.cfg = { ...THP_DEFAULTS, ...cfg };
    this.mem = new PhysMem(this.cfg.blocks);
    this.mem.fragment(this.cfg);
  }

  private log(e: ThpEvent) { this.events.push(e); return e; }

  private tryCompact(): CompactResult | null {
    const r = this.mem.compactOne();
    this.counts.compactionScanned += r.scanned;
    this.counts.compactionMoved += r.moved;
    return r.ok ? r : null;
  }

  /** The program touches one more 2 MiB region. */
  touchRegion(): ThpEvent {
    const id = this.regions.length;
    const n = this.cfg.touchedPerRegion;
    if (this.cfg.enabled === "always") {
      let block = this.mem.allocBlock();
      let moved = 0;
      if (block >= 0) {
        this.regions.push({ id, state: "huge", block, touched: n });
        this.counts.faultNs += THP_COST.hugeFaultNs;
        this.counts.worstFaultNs = Math.max(this.counts.worstFaultNs, THP_COST.hugeFaultNs);
        return this.log({ kind: "fault-huge", region: id, latencyNs: THP_COST.hugeFaultNs, moved: 0, copied: 0, text: `Region ${id}: a free block exists, so one fault maps a 2 MiB page. The kernel clears all of it.` });
      }
      if (this.cfg.defrag === "direct") {
        const c = this.tryCompact();
        if (c) {
          moved = c.moved;
          block = this.mem.allocBlock();
          const latency = moved * THP_COST.migratePageNs + THP_COST.hugeFaultNs;
          this.regions.push({ id, state: "huge", block, touched: n });
          this.counts.faultNs += latency;
          this.counts.worstFaultNs = Math.max(this.counts.worstFaultNs, latency);
          return this.log({ kind: "fault-huge-compact", region: id, latencyNs: latency, moved, copied: 0, text: `Region ${id}: no free block. Direct compaction moves ${moved} pages while the program waits, then maps a 2 MiB page.` });
        }
      }
      if (this.cfg.defrag === "defer") {
        const c = this.tryCompact();
        if (c) {
          this.counts.backgroundNs += c.moved * THP_COST.migratePageNs;
          this.log({ kind: "kcompactd", region: id, latencyNs: 0, moved: c.moved, copied: 0, text: `kcompactd moves ${c.moved} pages in the background and frees one block for later.` });
        }
      }
      this.counts.fallbacks++;
    }
    const frames: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = this.mem.allocSmall(id);
      if (f < 0) {
        for (const g of frames) this.mem.freeSmall(g);
        return this.log({ kind: "oom", region: id, latencyNs: 0, moved: 0, copied: 0, text: `Region ${id}: memory is full. A real kernel would reclaim pages or start the OOM killer.` });
      }
      frames.push(f);
    }
    this.regions.push({ id, state: "small", block: -1, touched: n });
    const total = n * THP_COST.smallFaultNs;
    this.counts.faultNs += total;
    this.counts.worstFaultNs = Math.max(this.counts.worstFaultNs, THP_COST.smallFaultNs);
    return this.log({ kind: "fault-small", region: id, latencyNs: THP_COST.smallFaultNs, moved: 0, copied: 0, text: this.cfg.enabled === "always" ? `Region ${id}: no free block, so the fault falls back to small pages. ${n} faults, one per page, on scattered frames.` : `Region ${id}: THP is off. ${n} faults, one per page, on scattered frames.` });
  }

  /** One khugepaged scan: pages_to_scan defaults to 4096 PTEs, which is 8 regions. Returns the events of this pass. */
  khugepagedPass(maxRegions = 8): ThpEvent[] {
    const out: ThpEvent[] = [];
    let scanned = 0;
    for (; this.scanCursor < this.regions.length && scanned < maxRegions; this.scanCursor++) {
      const r = this.regions[this.scanCursor]!;
      if (r.state !== "small") continue;
      scanned++;
      const none = FRAMES_PER_BLOCK - r.touched;
      if (none > this.cfg.maxPtesNone) { out.push(this.log({ kind: "collapse-skip", region: r.id, latencyNs: 0, moved: 0, copied: 0, text: `Region ${r.id}: ${none} empty PTEs is more than max_ptes_none, so khugepaged leaves it.` })); continue; }
      let block = this.mem.allocBlock();
      let moved = 0;
      if (block < 0) {
        const c = this.tryCompact();
        if (!c) { out.push(this.log({ kind: "compact-fail", region: r.id, latencyNs: 0, moved: 0, copied: 0, text: `Region ${r.id}: no free block, and compaction cannot make one. Pinned pages block the rest.` })); continue; }
        moved = c.moved;
        block = this.mem.allocBlock();
      }
      for (let f = 0; f < this.mem.frameCount; f++) if (this.mem.owner[f] === r.id) this.mem.freeSmall(f);
      r.state = "huge";
      r.block = block;
      this.counts.collapses++;
      this.counts.collapseCopied += r.touched;
      this.counts.backgroundNs += r.touched * THP_COST.collapseCopyPageNs + moved * THP_COST.migratePageNs;
      out.push(this.log({ kind: "collapse", region: r.id, latencyNs: 0, moved, copied: r.touched, text: `Region ${r.id}: khugepaged copies ${r.touched} pages into one 2 MiB page${moved ? `, after compaction moved ${moved} pages` : ""}.` }));
    }
    if (this.scanCursor >= this.regions.length) this.scanCursor = 0;
    return out;
  }

  /** Background compaction without a pending fault. */
  compactOnce(): ThpEvent {
    const c = this.tryCompact();
    if (!c) return this.log({ kind: "compact-fail", region: -1, latencyNs: 0, moved: 0, copied: 0, text: "Compaction cannot free another block. The remaining blocks hold pinned pages." });
    this.counts.backgroundNs += c.moved * THP_COST.migratePageNs;
    return this.log({ kind: "kcompactd", region: -1, latencyNs: 0, moved: c.moved, copied: 0, text: `Compaction moved ${c.moved} pages and freed block ${c.block}.` });
  }

  get stats(): ThpStats {
    const huge = this.regions.filter((r) => r.state === "huge");
    const small = this.regions.filter((r) => r.state === "small");
    const smallPages = small.reduce((a, r) => a + r.touched, 0);
    const rssBytes = huge.length * SIZE_2M + smallPages * PAGE_SIZE;
    const usefulBytes = this.regions.reduce((a, r) => a + r.touched, 0) * PAGE_SIZE;
    return { regions: this.regions.length, hugeRegions: huge.length, smallRegions: small.length, smallPages, rssBytes, usefulBytes, bloat: usefulBytes ? rssBytes / usefulBytes : 1, tlbEntries: huge.length + smallPages, ...this.counts };
  }
}

/** Runs a THP scenario to completion and returns its statistics. */
export function runThp(cfg: Partial<ThpConfig>, regions: number, khugepagedPasses = 0): ThpStats {
  const s = new ThpSim(cfg);
  for (let i = 0; i < regions; i++) s.touchRegion();
  for (let i = 0; i < khugepagedPasses; i++) s.khugepagedPass();
  return s.stats;
}

/** Linux defaults and sizes that the lessons quote. */
export const THP_FACTS = {
  hugeBytes: SIZE_2M,
  framesPerBlock: FRAMES_PER_BLOCK,
  /** khugepaged/pages_to_scan, and the regions that this many PTEs cover. */
  pagesToScan: 4096,
  regionsPerScan: 4096 / FRAMES_PER_BLOCK,
  /** khugepaged/scan_sleep_millisecs. */
  scanSleepMs: 10_000,
  /** khugepaged/max_ptes_none. */
  maxPtesNone: FRAMES_PER_BLOCK - 1,
  /** arm64 contiguous hint with a 4 KiB granule: 16 PTEs share one TLB entry. */
  contPtes: 16,
  contBytes: 16 * PAGE_SIZE,
  /** Time to clear 2 MiB is THP_COST.hugeFaultNs; 512 small faults take this long instead. */
  smallFaultsPerHuge: FRAMES_PER_BLOCK,
};
