/**
 * Bloom filters for SSTables.
 * - BloomFilter: m bits, k probes by double hashing g_i = h1 + i·h2 (mod m).
 * - BlockedBloomFilter: the first hash picks one 512-bit block (one 64-byte cache line);
 *   all k probes stay inside it. RocksDB's format_version=5 "fast local Bloom" works like this.
 * - Formulas: false positive rate, optimal k, bits per key for a target rate, Monkey allocation.
 */
import { hashPair, type HashPair } from "./hash";

const LN2 = Math.LN2;

/** FPR of a standard Bloom filter: (1 − e^(−k n / m))^k, with m/n = bits per key. */
export const bloomFpr = (bitsPerKey: number, k: number) => (bitsPerKey <= 0 ? 1 : Math.pow(1 - Math.exp(-k / bitsPerKey), k));
/** k that minimizes the FPR: (m/n) ln 2. */
export const optimalK = (bitsPerKey: number) => bitsPerKey * LN2;
/** The best integer k (checks the floor and the ceiling of the real optimum). */
export const bestIntegerK = (bitsPerKey: number) => {
  const a = Math.max(1, Math.floor(optimalK(bitsPerKey))), b = Math.max(1, Math.ceil(optimalK(bitsPerKey)));
  return bloomFpr(bitsPerKey, a) <= bloomFpr(bitsPerKey, b) ? a : b;
};
/** LevelDB's choice: k = floor(bits_per_key × 0.69), clamped to 1..30. */
export const levelDbK = (bitsPerKey: number) => Math.min(30, Math.max(1, Math.floor(bitsPerKey * 0.69)));
/** FPR with the optimal (real-valued) k: 0.6185^(bits per key). */
export const fprAtOptimalK = (bitsPerKey: number) => Math.pow(0.5, bitsPerKey * LN2);
/** Bits per key a Bloom filter needs for a target FPR ε: −ln ε / (ln 2)². */
export const bloomBitsForFpr = (fpr: number) => -Math.log(fpr) / (LN2 * LN2);
/** Information-theoretic minimum for any filter: log2(1/ε) bits per key. */
export const lowerBoundBitsForFpr = (fpr: number) => Math.log2(1 / fpr);

/** Poisson pmf, computed in log space so large means do not underflow early. */
function poisson(j: number, mean: number): number {
  let lg = 0;
  for (let i = 2; i <= j; i++) lg += Math.log(i);
  return Math.exp(j * Math.log(mean) - mean - lg);
}

/**
 * FPR of a blocked Bloom filter (blocks of `blockBits`, k probes inside one block).
 * Keys per block follow a Poisson law with mean blockBits / bitsPerKey; average the
 * per-block FPR (1 − (1 − 1/B)^(j k))^k over that law.
 */
export function blockedBloomFpr(bitsPerKey: number, k: number, blockBits = 512): number {
  const mean = blockBits / bitsPerKey;
  let sum = 0, mass = 0;
  for (let j = 0; j < mean * 6 + 60; j++) {
    const w = poisson(j, mean);
    mass += w;
    sum += w * Math.pow(1 - Math.pow(1 - 1 / blockBits, j * k), k);
  }
  return sum / mass;
}

export interface Filter {
  readonly m: number;
  readonly k: number;
  addHash(h: HashPair): void;
  mayContainHash(h: HashPair): boolean;
  /** Bit positions that the key maps to. */
  positionsHash(h: HashPair): number[];
}

export class BloomFilter implements Filter {
  readonly bits: Uint8Array;
  count = 0;
  constructor(readonly m: number, readonly k: number) {
    this.bits = new Uint8Array(Math.max(1, m));
  }
  /** A filter sized for n keys: m = n × bitsPerKey, k = LevelDB's rule unless given. */
  static forKeys(keys: Iterable<string>, bitsPerKey: number, k = levelDbK(bitsPerKey)): BloomFilter {
    const list = [...keys];
    const f = new BloomFilter(Math.max(64, Math.ceil(list.length * bitsPerKey)), k);
    for (const key of list) f.add(key);
    return f;
  }
  positionsHash([h1, h2]: HashPair): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.k; i++) out.push(((h1 + Math.imul(i, h2)) >>> 0) % this.m);
    return out;
  }
  addHash(h: HashPair) {
    for (const p of this.positionsHash(h)) this.bits[p] = 1;
    this.count++;
  }
  mayContainHash(h: HashPair) {
    const [h1, h2] = h;
    for (let i = 0; i < this.k; i++) if (!this.bits[((h1 + Math.imul(i, h2)) >>> 0) % this.m]) return false;
    return true;
  }
  positions(key: string) { return this.positionsHash(hashPair(key)); }
  add(key: string) { this.addHash(hashPair(key)); }
  mayContain(key: string) { return this.mayContainHash(hashPair(key)); }
  /** Fraction of bits set to 1. */
  fill() { let s = 0; for (const b of this.bits) s += b; return s / this.m; }
  /** Size on disk: one bit per position, plus one byte that stores k (LevelDB format). */
  get bytes() { return Math.ceil(this.m / 8) + 1; }
}

/** Cache-line Bloom filter: h1 picks a 512-bit block, then k probes inside that block. */
export class BlockedBloomFilter implements Filter {
  readonly bits: Uint8Array;
  readonly blocks: number;
  constructor(readonly m: number, readonly k: number, readonly blockBits = 512) {
    this.blocks = Math.max(1, Math.round(m / blockBits));
    this.m = this.blocks * blockBits;
    this.bits = new Uint8Array(this.m);
  }
  positionsHash([h1, h2]: HashPair): number[] {
    const base = (h1 % this.blocks) * this.blockBits;
    // Rehash h2 for the in-block probes so they do not depend on the block choice.
    let h = h2;
    const out: number[] = [];
    for (let i = 0; i < this.k; i++) {
      out.push(base + (h >>> 0) % this.blockBits);
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ i;
      h ^= h >>> 12;
    }
    return out;
  }
  addHash(h: HashPair) { for (const p of this.positionsHash(h)) this.bits[p] = 1; }
  mayContainHash(h: HashPair) { return this.positionsHash(h).every((p) => this.bits[p] === 1); }
}

/** Deterministic key sets: `n` member keys and `probes` keys that are surely not members. */
export function keySets(n: number, probes: number) {
  const members = Array.from({ length: n }, (_, i) => `key:${i}`);
  const others = Array.from({ length: probes }, (_, i) => `miss:${i}`);
  return { members: members.map(hashPair), others: others.map(hashPair) };
}

/** Measured FPR: insert the members, query the non-members, count "maybe" answers. */
export function measureFpr(make: (m: number, k: number) => Filter, bitsPerKey: number, k: number, sets: ReturnType<typeof keySets>): number {
  const f = make(Math.max(1, Math.round(sets.members.length * bitsPerKey)), k);
  for (const h of sets.members) f.addHash(h);
  let fp = 0;
  for (const h of sets.others) if (f.mayContainHash(h)) fp++;
  return fp / sets.others.length;
}

/**
 * Monkey (Dayan et al., SIGMOD 2017): give each run its own FPR p_i to minimize Σ p_i
 * (the expected I/Os of a lookup for a missing key) for a fixed total of filter bits.
 * Bits of run i: n_i · (−ln p_i) / (ln 2)². The Lagrange condition gives p_i ∝ n_i (capped at 1).
 * `entries[i]` = keys in run i. Returns the FPR of each run.
 */
export function monkeyFprs(entries: number[], totalBits: number): number[] {
  const c = LN2 * LN2;
  const bitsFor = (lambda: number) =>
    entries.reduce((s, n) => s + (n > 0 ? (n * -Math.log(Math.min(1, lambda * n))) / c : 0), 0);
  // bitsFor falls as lambda grows; bisect in log space.
  let lo = 1e-30, hi = 1e6;
  for (let it = 0; it < 200; it++) {
    const mid = Math.sqrt(lo * hi);
    if (bitsFor(mid) > totalBits) lo = mid; else hi = mid;
  }
  return entries.map((n) => Math.min(1, hi * n));
}

/** The same total bits spread evenly: every run gets the same bits per key. */
export function uniformFprs(entries: number[], totalBits: number): number[] {
  const n = entries.reduce((a, b) => a + b, 0);
  const bpk = totalBits / n;
  return entries.map(() => fprAtOptimalK(bpk));
}

/**
 * Entries per sorted run of a leveled tree, in units of one memtable flush:
 * `l0Files` L0 files of 1 unit each, then levels of base · T^(i−1) units.
 */
export function leveledRunSizes(l0Files: number, levels: number, T: number, base = 4): { name: string; entries: number }[] {
  const out: { name: string; entries: number }[] = [];
  for (let i = 0; i < l0Files; i++) out.push({ name: `L0 file ${i + 1}`, entries: 1 });
  for (let l = 1; l <= levels; l++) out.push({ name: `L${l}`, entries: base * Math.pow(T, l - 1) });
  return out;
}

/**
 * Expected data-block reads for a lookup of a missing key: one per run without filters,
 * Σ FPR with filters (same total bits, spread evenly or by Monkey).
 */
export function missLookupIos(entries: number[], bitsPerKey: number) {
  const total = entries.reduce((a, b) => a + b, 0) * bitsPerKey;
  const uniform = bitsPerKey > 0 ? uniformFprs(entries, total) : entries.map(() => 1);
  const monkey = bitsPerKey > 0 ? monkeyFprs(entries, total) : entries.map(() => 1);
  const c = LN2 * LN2;
  const bits = (p: number) => (p >= 1 ? 0 : -Math.log(p) / c);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  return {
    none: entries.length,
    uniform, monkey,
    uniformBits: uniform.map(bits), monkeyBits: monkey.map(bits),
    uniformTotal: sum(uniform), monkeyTotal: sum(monkey),
  };
}
