/**
 * A TLB as an array of sets and ways, with the choices that architects make: associativity, replacement
 * policy (LRU, tree pseudo-LRU, FIFO, random), and coalescing of contiguous pages into one entry (AMD Zen
 * merges four 4 KiB pages; RISC-V Svnapot marks 64 KiB ranges, which is sixteen 4 KiB pages).
 *
 * Also: the bit fields that index split arrays for 4 KiB and 2 MiB pages, and the reach formula.
 * The trace lengths and sizes in the sweeps are MODEL INPUTS.
 */
import { mulberry32 } from "../../rng";

export type Policy = "lru" | "plru" | "fifo" | "random";
export const POLICY_NAMES: Record<Policy, string> = { lru: "LRU", plru: "Tree pseudo-LRU", fifo: "FIFO", random: "Random" };

export interface TlbArrayConfig {
  entries: number;
  /** Ways per set. entries = ways gives a fully associative TLB. */
  ways: number;
  policy: Policy;
  /** Pages per coalesced entry: 1 (none), 4 (AMD-style) or 16 (Svnapot 64 KiB). */
  coalesce?: number;
  seed?: number;
}

interface Way { valid: boolean; tag: number; size: number }

export class TlbArray {
  readonly sets: number;
  readonly ways: number;
  readonly policy: Policy;
  readonly coalesce: number;
  private slots: Way[][];
  /** Per set: key (tag and size) to way, so that a probe is O(1) even when the TLB is fully associative. */
  private where: Map<number, number>[];
  /** LRU and FIFO: ways of each set in order, oldest first (a Map keeps insertion order). */
  private order: Map<number, true>[];
  /** Tree pseudo-LRU bits per set: ways - 1 bits, heap order. */
  private plru: Uint8Array[];
  private rnd: () => number;
  hits = 0;
  misses = 0;

  constructor(cfg: TlbArrayConfig) {
    if (cfg.entries % cfg.ways) throw new Error("entries must be a multiple of ways");
    this.ways = cfg.ways;
    this.sets = cfg.entries / cfg.ways;
    this.policy = cfg.policy;
    this.coalesce = cfg.coalesce ?? 1;
    if (cfg.policy === "plru" && (cfg.ways & (cfg.ways - 1))) throw new Error("tree PLRU needs a power-of-two way count");
    this.slots = Array.from({ length: this.sets }, () => Array.from({ length: cfg.ways }, () => ({ valid: false, tag: 0, size: 1 })));
    this.where = Array.from({ length: this.sets }, () => new Map());
    this.order = Array.from({ length: this.sets }, () => new Map());
    this.plru = Array.from({ length: this.sets }, () => new Uint8Array(Math.max(1, cfg.ways - 1)));
    this.rnd = mulberry32(cfg.seed ?? 3);
  }

  /** Points the tree bits away from way w. */
  private touchPlru(set: number, w: number) {
    const bits = this.plru[set]!;
    let node = 0, lo = 0, hi = this.ways;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const right = w >= mid;
      bits[node] = right ? 0 : 1; // 1 = the victim is on the right
      node = 2 * node + (right ? 2 : 1);
      if (right) lo = mid; else hi = mid;
    }
  }
  private plruVictim(set: number): number {
    const bits = this.plru[set]!;
    let node = 0, lo = 0, hi = this.ways;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const right = bits[node] === 1;
      node = 2 * node + (right ? 2 : 1);
      if (right) lo = mid; else hi = mid;
    }
    return lo;
  }

  private key(tag: number, size: number) { return tag * 32 + size; }
  private probe(set: number, tag: number, size: number): number {
    return this.where[set]!.get(this.key(tag, size)) ?? -1;
  }

  private victim(set: number): number {
    const s = this.slots[set]!;
    if (this.where[set]!.size < this.ways) return s.findIndex((x) => !x.valid);
    switch (this.policy) {
      case "random": return Math.floor(this.rnd() * this.ways);
      case "plru": return this.plruVictim(set);
      default: return this.order[set]!.keys().next().value!; // lru and fifo: the oldest in the order
    }
  }

  private use(set: number, w: number, fill: boolean) {
    if (this.policy === "lru" || (this.policy === "fifo" && fill)) { const o = this.order[set]!; o.delete(w); o.set(w, true); }
    if (this.policy === "plru") this.touchPlru(set, w);
  }

  /**
   * One translation of a 4 KiB virtual page number. contiguous(group) says whether the group of `coalesce`
   * pages around it is backed by contiguous, aligned frames, so that one entry can map it.
   */
  access(vpn: number, contiguous: (group: number) => boolean = () => false): boolean {
    const c = this.coalesce;
    const group = Math.floor(vpn / c);
    const big = c > 1 && contiguous(group);
    const tag = big ? group : vpn;
    const size = big ? c : 1;
    const set = tag % this.sets;
    const w = this.probe(set, tag, size);
    if (w >= 0) { this.hits++; this.use(set, w, false); return true; }
    this.misses++;
    const v = this.victim(set);
    const old = this.slots[set]![v]!;
    if (old.valid) this.where[set]!.delete(this.key(old.tag, old.size));
    this.slots[set]![v] = { valid: true, tag, size };
    this.where[set]!.set(this.key(tag, size), v);
    this.use(set, v, true);
    return false;
  }

  get missRate() { const n = this.hits + this.misses; return n ? this.misses / n : 0; }
}

/** Deterministic test of whether a group of pages is physically contiguous, for a given fraction. */
export function contiguity(fraction: number, seed = 11) {
  return (group: number) => {
    const r = mulberry32((group * 2654435761) ^ seed)();
    return r < fraction;
  };
}

export type AccessPattern = "random" | "loop";

/** Miss rate of one configuration for a working set of `pages` 4 KiB pages. */
export function tlbMissRate(cfg: TlbArrayConfig, pattern: AccessPattern, pages: number, contiguousFraction = 0, length = 30_000): number {
  const t = new TlbArray(cfg);
  const cont = contiguity(contiguousFraction);
  const rnd = mulberry32(5);
  const warm = Math.min(length, pages * 2);
  for (let i = 0; i < warm + length; i++) {
    if (i === warm) { t.hits = 0; t.misses = 0; }
    const v = pattern === "loop" ? i % pages : Math.floor(rnd() * pages);
    t.access(0x10000 + v, cont);
  }
  return t.missRate;
}

/** Reach: entries times the bytes each entry maps. */
export const reachBytes = (entries: number, pageBytes = 4096, coalesce = 1) => entries * pageBytes * coalesce;

/** Set index of a virtual address in an array of `sets` sets that holds pages of 2^pageShift bytes. */
export const tlbSetIndex = (va: number, pageShift: number, sets: number) => Math.floor(va / 2 ** pageShift) % sets;

/** Bit positions [low, high] of the set index field in the virtual address. */
export const indexBitRange = (pageShift: number, sets: number): [number, number] => [pageShift, pageShift + Math.log2(sets) - 1];
