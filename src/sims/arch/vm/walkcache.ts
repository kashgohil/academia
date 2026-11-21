/**
 * What a TLB miss costs in memory reads, with and without page-walk caches (Intel: paging-structure caches;
 * AMD: the page directory cache). A walk-cache entry holds a non-leaf entry, keyed by the virtual address
 * bits above it. On a TLB miss the walker starts from the deepest walk-cache hit, so it skips the reads above.
 *
 * The page tables are radix trees with 9 bits per level and 4 KiB pages (Sv39, Sv48 and Sv57 on RISC-V;
 * 4-level and 5-level paging on x86-64). All sizes in WALK_MODEL are MODEL INPUTS.
 */
import { mulberry32 } from "../../rng";

/** Least recently used set of keys with a fixed capacity, fully associative. */
export class LruSet {
  private m = new Map<number, true>();
  hits = 0;
  misses = 0;
  constructor(readonly capacity: number) {}
  has(k: number): boolean {
    if (!this.m.has(k)) { this.misses++; return false; }
    this.m.delete(k); this.m.set(k, true); this.hits++;
    return true;
  }
  add(k: number) {
    if (this.capacity <= 0) return;
    this.m.delete(k);
    this.m.set(k, true);
    if (this.m.size > this.capacity) this.m.delete(this.m.keys().next().value!);
  }
  get size() { return this.m.size; }
}

export interface WalkCacheConfig {
  /** Levels of the radix tree: 3 (Sv39), 4 (Sv48, x86-64) or 5 (Sv57, LA57). */
  levels: number;
  /** Entries of the last-level TLB (fully associative LRU in this model). */
  tlbEntries: number;
  /** Entries of each walk cache. There is one walk cache per non-leaf level. 0 means no walk caches. */
  pwcEntries: number;
}

/** MODEL INPUTS. A PTE read is assumed to hit in the data cache hierarchy at this cost. */
export const WALK_MODEL = { tlbEntries: 1536, pwcEntries: 32, pteReadCycles: 20 };

export interface WalkStats {
  accesses: number;
  tlbMisses: number;
  /** Memory reads that walks did, in total. */
  walkReads: number;
  /** histogram[k] = walks that needed k reads, for k = 1..levels. */
  histogram: number[];
  missRate: number;
  readsPerWalk: number;
}

/**
 * Runs a trace of virtual page numbers through a TLB and the walk caches. Walk cache level k (k = 1 for the
 * table just above the leaf) is keyed by vpn >> (9 k): one entry covers 512^k pages.
 */
export function runWalks(vpns: Iterable<number>, cfg: WalkCacheConfig): WalkStats {
  const tlb = new LruSet(cfg.tlbEntries);
  const pwc = Array.from({ length: cfg.levels - 1 }, () => new LruSet(cfg.pwcEntries));
  const histogram = new Array(cfg.levels + 1).fill(0);
  let accesses = 0, misses = 0, reads = 0;
  for (const v of vpns) {
    accesses++;
    if (tlb.has(v)) continue;
    misses++;
    // Find the deepest walk-cache hit: k = 1 skips all but the leaf read.
    let n = cfg.levels;
    for (let k = 1; k < cfg.levels; k++) {
      if (cfg.pwcEntries > 0 && pwc[k - 1]!.has(Math.floor(v / 512 ** k))) { n = k; break; }
    }
    reads += n;
    histogram[n]++;
    for (let k = 1; k < cfg.levels; k++) pwc[k - 1]!.add(Math.floor(v / 512 ** k));
    tlb.add(v);
  }
  return { accesses, tlbMisses: misses, walkReads: reads, histogram, missRate: accesses ? misses / accesses : 0, readsPerWalk: misses ? reads / misses : 0 };
}

export type TracePattern = "random" | "sequential" | "sparse";

/**
 * Page traces. random: uniform over the working set. sequential: a loop over it, page by page.
 * sparse: the same number of pages, but one page in each 2 MiB region, so no two pages share a leaf table.
 */
export function pageTrace(pattern: TracePattern, pages: number, length: number, seed = 1): number[] {
  const rnd = mulberry32(seed);
  const base = 0x7f000 * 512; // a high, 2 MiB-aligned starting page, so traces do not start at vpn 0
  const out = new Array<number>(length);
  for (let i = 0; i < length; i++) {
    const k = pattern === "sequential" ? i % pages : Math.floor(rnd() * pages);
    out[i] = base + (pattern === "sparse" ? k * 512 : k);
  }
  return out;
}

/** Average cycles per TLB miss for the walker: reads times the model cost of one read. */
export const walkCycles = (readsPerWalk: number, pteReadCycles = WALK_MODEL.pteReadCycles) => readsPerWalk * pteReadCycles;

export interface CurvePoint { bytes: number; readsPerWalk: number; missRate: number }

/** One point of the demo's sweep: working set in bytes, 4 KiB pages. */
export function walkPoint(pattern: TracePattern, bytes: number, cfg: WalkCacheConfig, length = 40_000): CurvePoint {
  const pages = Math.max(1, Math.round(bytes / 4096));
  const warm = runWalks(pageTrace(pattern, pages, length, 7), cfg);
  return { bytes, readsPerWalk: warm.readsPerWalk, missRate: warm.missRate };
}
