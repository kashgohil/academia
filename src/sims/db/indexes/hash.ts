/**
 * Hash indexes: static hashing with overflow chains, extendible hashing, linear hashing, and the
 * in-memory open-addressing schemes (linear probing, Robin Hood, cuckoo) used for comparison.
 *
 * Keys are non-negative integers. `hashKey` maps them to 32-bit hashes with MurmurHash3, so the
 * low bits are well mixed. All structures count the pages (buckets) they touch, so lessons can
 * quote measured costs.
 */
import { murmur3 } from "../lsm/hash";
import { mulberry32 } from "../../rng";

/** 32-bit hash of an integer key (MurmurHash3 over its decimal string). */
export const hashKey = (k: number): number => murmur3(String(k), 0x2545f491);

/** The low `n` bits of `h` as a binary string ("" for n = 0). */
export const lowBits = (h: number, n: number): string => (n <= 0 ? "" : (h & ((2 ** n - 1) >>> 0)).toString(2).padStart(n, "0"));

// =====================================================================================
// Static hashing with overflow chains
// =====================================================================================

/** A fixed number of primary bucket pages. A full page gets an overflow page chained behind it. */
export class StaticHash {
  /** buckets[b] is the chain of pages; each page holds at most `cap` keys. */
  readonly buckets: number[][][];
  size = 0;
  constructor(readonly nBuckets: number, readonly cap: number) {
    this.buckets = Array.from({ length: nBuckets }, () => [[]]);
  }
  bucketOf(k: number) { return hashKey(k) % this.nBuckets; }
  /** Inserts a key (no duplicate check). Returns the pages written to (1, or 2 when a new overflow page is linked). */
  insert(k: number): number {
    const chain = this.buckets[this.bucketOf(k)]!;
    const last = chain[chain.length - 1]!;
    this.size++;
    if (last.length < this.cap) { last.push(k); return 1; }
    chain.push([k]);
    return 2;
  }
  /** Pages read to find `k`; a miss reads the whole chain. */
  lookup(k: number): { found: boolean; pages: number } {
    const chain = this.buckets[this.bucketOf(k)]!;
    for (let p = 0; p < chain.length; p++) if (chain[p]!.includes(k)) return { found: true, pages: p + 1 };
    return { found: false, pages: chain.length };
  }
  get pages() { return this.buckets.reduce((s, c) => s + c.length, 0); }
  get loadFactor() { return this.size / (this.nBuckets * this.cap); }
}

// =====================================================================================
// Extendible hashing (Fagin, Nievergelt, Pippenger and Strong, 1979)
// =====================================================================================

export interface EBucket { id: number; depth: number; keys: number[] }

export type ExtEvent =
  | { t: "hash"; key: number; h: number }
  | { t: "slot"; slot: number; bucket: number }
  | { t: "put"; bucket: number }
  | { t: "dup"; bucket: number }
  | { t: "full"; bucket: number; local: number; global: number }
  | { t: "double"; global: number }
  | { t: "split"; bucket: number; into: number; depth: number }
  | { t: "overflow"; bucket: number };

export interface ExtSnapshot { global: number; dir: number[]; buckets: EBucket[] }

/**
 * A directory of 2^global slots points to buckets. Slot i holds the bucket for hashes whose
 * low `global` bits equal i. A bucket with local depth d is shared by 2^(global − d) slots.
 * A full bucket splits on bit d; when d = global, the directory doubles first.
 */
export class ExtendibleHash {
  global: number;
  dir: EBucket[];
  size = 0;
  nextId = 0;
  stats = { splits: 0, doublings: 0 };
  listener: ((e: ExtEvent) => void) | null = null;
  constructor(readonly cap: number, initialDepth = 1, readonly maxDepth = 24) {
    if (cap < 1) throw new Error("capacity must be at least 1");
    this.global = initialDepth;
    const bs = Array.from({ length: 2 ** initialDepth }, () => this.bucket(initialDepth));
    this.dir = bs;
  }
  private bucket(depth: number): EBucket { return { id: this.nextId++, depth, keys: [] }; }
  private emit(e: ExtEvent) { this.listener?.(e); }
  slotOf(h: number) { return h & ((2 ** this.global - 1) >>> 0); }
  get(k: number): boolean { return this.dir[this.slotOf(hashKey(k))]!.keys.includes(k); }
  /** Inserts `k`; returns false if it was already present. */
  insert(k: number): boolean {
    const h = hashKey(k);
    this.emit({ t: "hash", key: k, h });
    for (;;) {
      const slot = this.slotOf(h);
      const b = this.dir[slot]!;
      this.emit({ t: "slot", slot, bucket: b.id });
      if (b.keys.includes(k)) { this.emit({ t: "dup", bucket: b.id }); return false; }
      if (b.keys.length < this.cap || b.depth >= this.maxDepth) {
        if (b.keys.length >= this.cap) this.emit({ t: "overflow", bucket: b.id });
        b.keys.push(k);
        this.size++;
        this.emit({ t: "put", bucket: b.id });
        return true;
      }
      this.emit({ t: "full", bucket: b.id, local: b.depth, global: this.global });
      if (b.depth === this.global) {
        this.dir = this.dir.concat(this.dir); // slot i + 2^g gets the same bucket as slot i
        this.global++;
        this.stats.doublings++;
        this.emit({ t: "double", global: this.global });
      }
      this.splitBucket(b);
    }
  }
  private splitBucket(b: EBucket) {
    const bit = b.depth; // split on this bit of the hash
    const nb = this.bucket(b.depth + 1);
    b.depth++;
    const keep: number[] = [];
    for (const k of b.keys) ((hashKey(k) >>> bit) & 1 ? nb.keys : keep).push(k);
    b.keys = keep;
    // The slots of b agree on the low `bit` bits; those with bit `bit` set now point to nb.
    const base = (this.dir.indexOf(b) & (2 ** bit - 1)) + 2 ** bit;
    for (let i = base; i < this.dir.length; i += 2 ** (bit + 1)) this.dir[i] = nb;
    this.stats.splits++;
    this.emit({ t: "split", bucket: b.id, into: nb.id, depth: b.depth });
  }
  /** Removes `k` (buckets are not merged, as in most real systems). */
  delete(k: number): boolean {
    const b = this.dir[this.slotOf(hashKey(k))]!;
    const i = b.keys.indexOf(k);
    if (i < 0) return false;
    b.keys.splice(i, 1);
    this.size--;
    return true;
  }
  /** Distinct buckets, in order of first directory slot. */
  buckets(): EBucket[] {
    const seen = new Set<EBucket>();
    for (const b of this.dir) seen.add(b);
    return [...seen];
  }
  /** Fraction of bucket slots in use. */
  utilization() { return this.size / (this.buckets().length * this.cap); }
  snapshot(): ExtSnapshot {
    const bs = this.buckets();
    return { global: this.global, dir: this.dir.map((b) => b.id), buckets: bs.map((b) => ({ ...b, keys: [...b.keys] })) };
  }
  /** Invariants: every bucket with local depth d is referenced by exactly 2^(g − d) slots that agree on the low d bits. */
  check(): string[] {
    const errs: string[] = [];
    for (const b of this.buckets()) {
      const slots = this.dir.map((x, i) => (x === b ? i : -1)).filter((i) => i >= 0);
      if (slots.length !== 2 ** (this.global - b.depth)) errs.push(`bucket ${b.id}: ${slots.length} slots, depth ${b.depth}`);
      const mask = (2 ** b.depth - 1) >>> 0;
      if (new Set(slots.map((s) => s & mask)).size !== 1) errs.push(`bucket ${b.id}: slots disagree on low bits`);
      for (const k of b.keys) if ((hashKey(k) & mask) !== (slots[0]! & mask)) errs.push(`key ${k} in wrong bucket`);
    }
    return errs;
  }
}

// =====================================================================================
// Linear hashing (Litwin, 1980)
// =====================================================================================

export type LinEvent =
  | { t: "hash"; key: number; h: number; addr: number; usedNext: boolean }
  | { t: "put"; bucket: number; overflow: boolean }
  | { t: "dup"; bucket: number }
  | { t: "trigger"; load: number }
  | { t: "split"; bucket: number; into: number; moved: number[] }
  | { t: "round"; level: number };

export interface LinSnapshot { level: number; next: number; n0: number; buckets: number[][]; cap: number }

/**
 * Buckets 0..n−1 with no directory. Round `level` uses h mod (n0·2^level); buckets before the
 * split pointer `next` have already split and use h mod (n0·2^(level+1)). When the load factor
 * passes `maxLoad`, the bucket at `next` splits (not the bucket that overflowed), and `next` moves on.
 */
export class LinearHash {
  level = 0;
  next = 0;
  buckets: number[][];
  size = 0;
  stats = { splits: 0 };
  listener: ((e: LinEvent) => void) | null = null;
  constructor(readonly cap: number, readonly maxLoad = 0.8, readonly n0 = 2) {
    if (cap < 1 || n0 < 1 || maxLoad <= 0) throw new Error("bad linear hash parameters");
    this.buckets = Array.from({ length: n0 }, () => []);
  }
  private emit(e: LinEvent) { this.listener?.(e); }
  /** Bucket address of a hash: round function, or the next one for buckets already split. */
  addr(h: number): { addr: number; usedNext: boolean } {
    const a = h % (this.n0 * 2 ** this.level);
    if (a < this.next) return { addr: h % (this.n0 * 2 ** (this.level + 1)), usedNext: true };
    return { addr: a, usedNext: false };
  }
  /** Pages in a bucket: one primary page plus overflow pages. */
  pagesOf(b: number) { return Math.max(1, Math.ceil(this.buckets[b]!.length / this.cap)); }
  get loadFactor() { return this.size / (this.buckets.length * this.cap); }
  get(k: number): boolean { return this.buckets[this.addr(hashKey(k)).addr]!.includes(k); }
  /** Pages read to find `k` (a miss reads the whole bucket chain). */
  lookup(k: number): { found: boolean; pages: number } {
    const b = this.buckets[this.addr(hashKey(k)).addr]!;
    const i = b.indexOf(k);
    return i < 0 ? { found: false, pages: Math.max(1, Math.ceil(b.length / this.cap)) } : { found: true, pages: Math.floor(i / this.cap) + 1 };
  }
  insert(k: number): boolean {
    const h = hashKey(k);
    const { addr, usedNext } = this.addr(h);
    this.emit({ t: "hash", key: k, h, addr, usedNext });
    const b = this.buckets[addr]!;
    if (b.includes(k)) { this.emit({ t: "dup", bucket: addr }); return false; }
    b.push(k);
    this.size++;
    this.emit({ t: "put", bucket: addr, overflow: b.length > this.cap && (b.length - 1) % this.cap === 0 });
    while (this.loadFactor > this.maxLoad) {
      this.emit({ t: "trigger", load: this.loadFactor });
      this.split();
    }
    return true;
  }
  private split() {
    const s = this.next;
    const into = this.buckets.length;
    this.buckets.push([]);
    const m2 = this.n0 * 2 ** (this.level + 1);
    const keep: number[] = [], moved: number[] = [];
    for (const k of this.buckets[s]!) (hashKey(k) % m2 === s ? keep : moved).push(k);
    this.buckets[s] = keep;
    this.buckets[into] = moved;
    this.next++;
    this.stats.splits++;
    this.emit({ t: "split", bucket: s, into, moved });
    if (this.next === this.n0 * 2 ** this.level) {
      this.level++;
      this.next = 0;
      this.emit({ t: "round", level: this.level });
    }
  }
  delete(k: number): boolean {
    const b = this.buckets[this.addr(hashKey(k)).addr]!;
    const i = b.indexOf(k);
    if (i < 0) return false;
    b.splice(i, 1);
    this.size--;
    return true;
  }
  snapshot(): LinSnapshot {
    return { level: this.level, next: this.next, n0: this.n0, cap: this.cap, buckets: this.buckets.map((b) => [...b]) };
  }
}

// =====================================================================================
// Experiments: bucket pages per lookup against load factor
// =====================================================================================

/** Distinct random integer keys (deterministic). */
export function randomKeys(n: number, seed = 7): number[] {
  const r = mulberry32(seed);
  const s = new Set<number>();
  while (s.size < n) s.add(Math.floor(r() * 2 ** 31));
  return [...s];
}

export interface PageCost { alpha: number; hit: number; miss: number }

/** Mean pages per successful and unsuccessful lookup in a static hash file at load factor `alpha`. */
export function staticCost(alpha: number, cap: number, nBuckets = 512, seed = 7): PageCost {
  const n = Math.round(alpha * nBuckets * cap);
  const keys = randomKeys(2 * n, seed);
  const t = new StaticHash(nBuckets, cap);
  for (let i = 0; i < n; i++) t.insert(keys[i]!);
  let hit = 0, miss = 0;
  for (let i = 0; i < n; i++) hit += t.lookup(keys[i]!).pages;
  for (let i = n; i < 2 * n; i++) miss += t.lookup(keys[i]!).pages;
  return { alpha: t.loadFactor, hit: hit / n, miss: miss / n };
}

/** Same for linear hashing that splits whenever the load factor passes `maxLoad`. */
export function linearCost(maxLoad: number, cap: number, n = 20000, seed = 7): PageCost {
  const keys = randomKeys(2 * n, seed);
  const t = new LinearHash(cap, maxLoad);
  for (let i = 0; i < n; i++) t.insert(keys[i]!);
  let hit = 0, miss = 0;
  for (let i = 0; i < n; i++) hit += t.lookup(keys[i]!).pages;
  for (let i = n; i < 2 * n; i++) miss += t.lookup(keys[i]!).pages;
  return { alpha: t.loadFactor, hit: hit / n, miss: miss / n };
}

/** Extendible hashing: bucket utilization, directory slots and bucket count after `n` random inserts. */
export function extendibleStats(n: number, cap: number, seed = 7, maxDepth = 20) {
  const t = new ExtendibleHash(cap, 1, maxDepth);
  for (const k of randomKeys(n, seed)) t.insert(k);
  return { utilization: t.utilization(), global: t.global, dirSlots: t.dir.length, buckets: t.buckets().length, capped: t.global >= maxDepth };
}

// =====================================================================================
// In-memory open addressing: linear probing, Robin Hood, cuckoo
// =====================================================================================

export interface ProbeCost { alpha: number; hit: number; miss: number; maxHit: number }

/**
 * Open addressing with `m` slots. Linear probing puts a key in the first free slot. Robin Hood
 * (Celis, 1986) swaps when the incoming key is farther from home than the resident key, so a
 * miss can stop as soon as it meets a key closer to home than itself.
 */
export function openAddressingCost(kind: "linear" | "robinhood", alpha: number, m = 1 << 14, seed = 7): ProbeCost {
  const n = Math.round(alpha * m);
  const keys = randomKeys(2 * n, seed);
  const slot = new Float64Array(m).fill(-1);
  const home = (k: number) => hashKey(k) % m;
  const dist = (k: number, i: number) => (i - home(k) + m) % m;
  for (let j = 0; j < n; j++) {
    let k = keys[j]!, i = home(k), d = 0;
    for (;;) {
      const cur = slot[i]!;
      if (cur < 0) { slot[i] = k; break; }
      if (kind === "robinhood") {
        const dc = dist(cur, i);
        if (dc < d) { slot[i] = k; k = cur; d = dc; }
      }
      i = (i + 1) % m; d++;
    }
  }
  let hit = 0, maxHit = 0, miss = 0;
  for (let j = 0; j < n; j++) {
    const k = keys[j]!;
    let i = home(k), p = 1;
    while (slot[i] !== k) { i = (i + 1) % m; p++; }
    hit += p; maxHit = Math.max(maxHit, p);
  }
  for (let j = n; j < 2 * n; j++) {
    const k = keys[j]!;
    let i = home(k), p = 1, d = 0;
    for (;;) {
      const cur = slot[i]!;
      if (cur < 0) break;
      if (kind === "robinhood" && dist(cur, i) < d) break;
      i = (i + 1) % m; p++; d++;
    }
    miss += p;
  }
  return { alpha: n / m, hit: hit / n, miss: miss / n, maxHit };
}

/** Knuth's estimates for linear probing: hits ½(1 + 1/(1−α)), misses ½(1 + 1/(1−α)²). */
export const linearProbingHit = (a: number) => 0.5 * (1 + 1 / (1 - a));
export const linearProbingMiss = (a: number) => 0.5 * (1 + 1 / (1 - a) ** 2);
/** Separate chaining: a hit compares 1 + α/2 keys on average; a miss walks α keys. */
export const chainingHit = (a: number) => 1 + a / 2;

/**
 * Cuckoo hashing (Pagh and Rodler, 2001): two tables of m/2 one-key slots, each key has one
 * candidate slot per table. Inserts kick keys between tables; returns the load factor when the
 * first insert fails after `maxKicks` moves.
 */
export function cuckooMaxLoad(m = 1 << 14, seed = 7, maxKicks = 500): number {
  const half = m >> 1;
  const t = [new Float64Array(half).fill(-1), new Float64Array(half).fill(-1)];
  const pos = (k: number, side: number) => murmur3(String(k), side ? 0x5bd1e995 : 0x9747b28c) % half;
  const keys = randomKeys(m, seed);
  let n = 0;
  for (const key of keys) {
    let k = key, side = 0, ok = false;
    for (let kick = 0; kick < maxKicks; kick++) {
      const p = pos(k, side);
      const cur = t[side]![p]!;
      t[side]![p] = k;
      if (cur < 0) { ok = true; break; }
      k = cur; side ^= 1;
    }
    if (!ok) return n / m;
    n++;
  }
  return n / m;
}

// =====================================================================================
// Bitcask: an append-only log plus an in-memory hash table (the keydir)
// =====================================================================================

/** Fixed fields of a keydir entry in our model: file id (4), value size (4), value offset (8), timestamp (4). */
export const KEYDIR_FIELDS = 20;
/** Memory for the keydir: every live key and its fixed fields (hash table overhead not counted). */
export const keydirBytes = (keys: number, keyBytes: number) => keys * (keyBytes + KEYDIR_FIELDS);

// Demo scenarios (shared by the demos and the tests).
/** Keys in the extendible-hashing demo before the learner starts (none: start from two empty buckets). */
export const EXT_START: number[] = [];
/** "Insert next key" order. 7 doubles the directory, 21 doubles it again, 31 splits a bucket without doubling. */
export const EXT_SEQUENCE = [64, 12, 50, 90, 7, 21, 19, 31, 33, 2, 14, 88, 46, 59, 73, 6, 25, 98, 3, 61, 36, 80];
export const LIN_START: number[] = [];
export const LIN_SEQUENCE = [64, 12, 50, 90, 7, 21, 19, 31, 33, 2, 14, 88, 46, 59, 73, 6, 25, 98, 3, 61, 36, 80, 11, 52, 67, 29];
