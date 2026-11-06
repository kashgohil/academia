/**
 * Integer versions of the four lookups, for a speed comparison in the browser, and a memory and work model.
 * A key arrives as a 32-bit hash, so that the comparison measures the lookup and not the string hashing.
 */
import { jumpHash, maglevTable, SPACE } from "./hashing";
import { murmur3 } from "../../db/lsm/hash";

/** The default Maglev table size in the paper (a prime). */
export const MAGLEV_M = 65537;

/** The finalizer of MurmurHash3: a fast, good mixer of 32 bits. */
export function fmix32(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export type BenchScheme = "ring" | "rendezvous" | "jump" | "maglev";

export interface Lookup {
  scheme: BenchScheme;
  /** Maps a 32-bit key hash to a node index. */
  find(h: number): number;
  /** Bytes of lookup state: model in the comments below. */
  bytes: number;
  /** Work per lookup in the model, as a short text. */
  work: string;
}

/**
 * Builds a lookup for N nodes. Memory model (bytes):
 * - ring: N·v points of a 4-byte position and a 4-byte node index;
 * - rendezvous: one 4-byte seed per node;
 * - jump: nothing but N;
 * - maglev: M 4-byte entries. The Maglev paper uses M = 65537 by default and 655373 as its large size.
 */
export function buildLookup(scheme: BenchScheme, N: number, vnodes = 100, maglevM = MAGLEV_M): Lookup {
  if (scheme === "ring") {
    const pts: [number, number][] = [];
    for (let n = 0; n < N; n++) for (let i = 0; i < vnodes; i++) pts.push([murmur3(`n${n}#${i}`, 0x5eed), n]);
    pts.sort((a, b) => a[0] - b[0]);
    const pos = Uint32Array.from(pts.map((p) => p[0]));
    const own = Int32Array.from(pts.map((p) => p[1]));
    const len = pos.length;
    return {
      scheme, bytes: len * 8, work: `binary search over ${len} points`,
      find(h) {
        let lo = 0, hi = len;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (pos[mid]! < h) lo = mid + 1; else hi = mid; }
        return own[lo === len ? 0 : lo]!;
      },
    };
  }
  if (scheme === "rendezvous") {
    const seeds = Uint32Array.from({ length: N }, (_, n) => murmur3(`n${n}`, 0x41));
    return {
      scheme, bytes: N * 4, work: `${N} hashes`,
      find(h) {
        let best = 0, bestS = -1;
        for (let n = 0; n < N; n++) { const s = fmix32(h ^ seeds[n]!); if (s > bestS) { bestS = s; best = n; } }
        return best;
      },
    };
  }
  if (scheme === "jump") {
    return { scheme, bytes: 0, work: `about ln N + 0.58 = ${(Math.log(N) + 0.5772).toFixed(1)} loop turns`, find: (h) => jumpHash(fmix32(h ^ 0x9e3779b9), h, N) };
  }
  const M = maglevM;
  const table = maglevTable(Array.from({ length: N }, (_, n) => `n${n}`), M);
  return { scheme, bytes: M * 4, work: "one array read", find: (h) => table[h % M]! };
}

/** Expected loop turns of jump hash for n buckets: H(n), because bucket i is a jump target with probability 1/(i + 1). */
export const jumpExpectedIters = (n: number) => { let h = 0; for (let i = 1; i <= n; i++) h += 1 / i; return h; };

/** Mean loop turns of jump hash over `keys` random 64-bit keys, measured. */
export function jumpMeasuredIters(n: number, keys: number): number {
  const stats = { iters: 0 };
  for (let k = 0; k < keys; k++) jumpHash(murmur3(`k${k}`, 1), murmur3(`k${k}`, 2), n, stats);
  return stats.iters / keys;
}

/** Key hashes for a benchmark: deterministic and spread over 2³². */
export const benchKeys = (n: number) => Uint32Array.from({ length: n }, (_, i) => fmix32(i + 1) % SPACE);
