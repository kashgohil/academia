/**
 * Key-to-node mappings: the consistent hash ring with virtual nodes, rendezvous (highest random weight) hashing,
 * jump consistent hash and the Maglev lookup table. All of them use the 32-bit MurmurHash3 from the LSM module.
 */
import { murmur3 } from "../../db/lsm/hash";

/** 2³², the size of the 32-bit hash space. */
export const SPACE = 4294967296;

/** The 32-bit position of a key on the ring. */
export const keyPos = (key: string) => murmur3(key, 0);

// ---------------------------------------------------------------- the ring

export interface RingPoint {
  pos: number;
  node: string;
}

/**
 * A consistent hash ring (Karger et al. 1997). Each node puts `vnodes × weight` points on a ring of 2³² positions.
 * A key belongs to the first point at or after its own position, wrapping at the end.
 */
export class HashRing {
  readonly points: RingPoint[];
  constructor(readonly nodes: readonly string[], readonly vnodes = 1, readonly weights: Readonly<Record<string, number>> = {}) {
    const pts: RingPoint[] = [];
    for (const node of nodes) {
      const v = Math.max(1, Math.round(vnodes * (weights[node] ?? 1)));
      for (let i = 0; i < v; i++) pts.push({ pos: murmur3(`${node}#${i}`, 0x5eed), node });
    }
    pts.sort((a, b) => a.pos - b.pos || (a.node < b.node ? -1 : 1));
    this.points = pts;
  }

  /** The index of the first point at or after `pos` (binary search), wrapping to 0. */
  index(pos: number): number {
    const p = this.points;
    let lo = 0, hi = p.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (p[mid]!.pos < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo === p.length ? 0 : lo;
  }

  lookupPos(pos: number): string {
    return this.points[this.index(pos)]!.node;
  }

  lookup(key: string): string {
    return this.lookupPos(keyPos(key));
  }

  /** The exact fraction of the ring that each node owns: the arcs that end at its points. */
  ownership(): Map<string, number> {
    const own = new Map<string, number>(this.nodes.map((n) => [n, 0]));
    const p = this.points;
    for (let i = 0; i < p.length; i++) {
      const prev = i === 0 ? p[p.length - 1]!.pos - SPACE : p[i - 1]!.pos;
      own.set(p[i]!.node, own.get(p[i]!.node)! + (p[i]!.pos - prev) / SPACE);
    }
    return own;
  }
}

// ---------------------------------------------------------------- rendezvous

/** A node's score for a key: a hash of the pair, in (0, 1). */
export const hrwScore = (key: string, node: string) => (murmur3(`${node}|${key}`, 0x41) + 0.5) / SPACE;

/**
 * Rendezvous or highest random weight hashing (Thaler and Ravishankar). Every node scores the key; the highest
 * score wins. With weights, the score is −w / ln(u): the winner is then node i with probability wᵢ / Σw,
 * because −ln(u)/w is exponential with rate w and the smallest of independent exponentials picks i that often.
 */
export function rendezvous(key: string, nodes: readonly string[], weights: Readonly<Record<string, number>> = {}): string {
  let best = nodes[0]!, bestScore = -Infinity;
  for (const node of nodes) {
    const u = hrwScore(key, node);
    const w = weights[node];
    const s = w === undefined ? u : -w / Math.log(u);
    if (s > bestScore) { bestScore = s; best = node; }
  }
  return best;
}

/** The nodes in score order, for a replica set of size r: the first r are the replicas. */
export function rendezvousTop(key: string, nodes: readonly string[], r: number): string[] {
  return [...nodes].sort((a, b) => hrwScore(key, b) - hrwScore(key, a)).slice(0, r);
}

// ---------------------------------------------------------------- jump consistent hash

/** The full 64-bit product of two unsigned 32-bit numbers, as [hi, lo]. */
function mul32(a: number, b: number): [number, number] {
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  const lo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
  const hi = (p11 + (p01 >>> 16) + (p10 >>> 16) + Math.floor(mid / 65536)) >>> 0;
  return [hi, lo];
}

/** The multiplier of the 64-bit linear congruential generator in the paper: 2862933555777941757. */
const LCG_HI = 0x27bb2ee6, LCG_LO = 0x87b0b0fd;

/**
 * Jump consistent hash (Lamping and Veach 2014), bit-exact with the C++ in the paper. The 64-bit key is given
 * as two unsigned 32-bit halves, so that no BigInt is needed. Returns a bucket in [0, n).
 * `stats.iters` counts loop iterations, for the cost model.
 */
export function jumpHash(hi: number, lo: number, n: number, stats?: { iters: number }): number {
  let b = -1, j = 0;
  let kh = hi >>> 0, kl = lo >>> 0;
  while (j < n) {
    b = j;
    // key = key * 2862933555777941757 + 1 (mod 2⁶⁴)
    const [ph, pl] = mul32(kl, LCG_LO);
    kh = (ph + Math.imul(kh, LCG_LO) + Math.imul(kl, LCG_HI)) >>> 0;
    kl = (pl + 1) >>> 0;
    if (kl === 0) kh = (kh + 1) >>> 0;
    // j = (b + 1) * (2³¹ / ((key >> 33) + 1)), in double precision, truncated
    j = Math.floor((b + 1) * (2147483648 / ((kh >>> 1) + 1)));
    if (stats) stats.iters++;
  }
  return b;
}

/** The same algorithm with BigInt, line for line as in the paper. Slow; tests use it as a second reference. */
export function jumpHashBig(key: bigint, n: number): number {
  let b = -1n, j = 0n;
  const N = BigInt(n);
  const M = (1n << 64n) - 1n;
  while (j < N) {
    b = j;
    key = (key * 2862933555777941757n + 1n) & M;
    j = BigInt(Math.floor(Number(b + 1n) * (2147483648 / Number((key >> 33n) + 1n))));
  }
  return Number(b);
}

/** A 64-bit key for jump hash from a string: two murmur3 hashes with different seeds. */
export const key64 = (key: string): [number, number] => [murmur3(key, 0x9747b28c), murmur3(key, 0x5bd1e995)];

export const jumpKey = (key: string, n: number) => {
  const [hi, lo] = key64(key);
  return jumpHash(hi, lo, n);
};

// ---------------------------------------------------------------- Maglev

/** The smallest prime at or above n, for a Maglev table size. */
export function primeAtLeast(n: number): number {
  const isPrime = (x: number) => {
    if (x < 2) return false;
    for (let d = 2; d * d <= x; d++) if (x % d === 0) return false;
    return true;
  };
  let x = Math.max(2, Math.ceil(n));
  while (!isPrime(x)) x++;
  return x;
}

/**
 * The Maglev lookup table (Eisenbud et al. 2016). Each backend has a permutation of the M slots:
 * offset = h1(name) mod M, skip = h2(name) mod (M − 1) + 1, slot j = (offset + j·skip) mod M.
 * The backends take turns: each claims its next free slot until the table is full. M must be prime.
 * Returns, for each slot, the index of a backend in `backends`.
 */
export function maglevTable(backends: readonly string[], M: number): Int32Array {
  const n = backends.length;
  const entry = new Int32Array(M).fill(-1);
  if (n === 0) return entry;
  const offset = backends.map((b) => murmur3(b, 0xa1) % M);
  const skip = backends.map((b) => (murmur3(b, 0xb2) % (M - 1)) + 1);
  const next = new Array<number>(n).fill(0);
  let filled = 0;
  for (;;) {
    for (let i = 0; i < n; i++) {
      let c = (offset[i]! + next[i]! * skip[i]!) % M;
      while (entry[c]! >= 0) {
        next[i]!++;
        c = (offset[i]! + next[i]! * skip[i]!) % M;
      }
      entry[c] = i;
      next[i]!++;
      if (++filled === M) return entry;
    }
  }
}

export const maglevLookup = (table: Int32Array, key: string) => table[keyPos(key) % table.length]!;
