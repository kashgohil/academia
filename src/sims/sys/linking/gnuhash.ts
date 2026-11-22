/**
 * The GNU hash table (.gnu.hash, DT_GNU_HASH): how ld.so finds a symbol name in a shared library.
 *
 * Layout (glibc elf/dl-lookup.c and ld.lld GnuHashTableSection):
 *   nbuckets, symoffset, bloom_size, bloom_shift (four 32-bit words)
 *   bloom[bloom_size]      64-bit words of a Bloom filter with two bits for each symbol
 *   buckets[nbuckets]      the first .dynsym index in each bucket, or 0 for an empty bucket
 *   chain[nsyms]           the hash of each symbol with bit 0 cleared; bit 0 set marks the last one in a bucket
 *
 * The hash is Bernstein's: h = h * 33 + c, from h = 5381 (glibc dl_new_hash).
 * The builder copies ld.lld's choices: nbuckets = max(n / 4, 1), bloom_size = the next power of two above
 * n * 12 / 64, shift 26, and a stable sort of the symbols by bucket. The test compares the bytes with a .so
 * that ld.lld 22.1.8 wrote.
 */

export const dlNewHash = (name: string): number => {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 33) + name.charCodeAt(i)) >>> 0;
  return h;
};

/** The shift that ld.lld always writes. The table header stores it; GNU ld computes it for each table. */
export const BLOOM_SHIFT = 26;

export interface GnuHashTable {
  /** Symbol names in .dynsym order after the sort (index 0 is the null symbol, not listed). */
  names: string[];
  symoffset: number;
  nbuckets: number;
  bloom: bigint[];
  buckets: number[];
  chain: number[];
}

/** The next power of two strictly above x (llvm::NextPowerOf2). */
const nextPow2Above = (x: number) => { let p = 1; while (p <= x) p *= 2; return p; };

export function buildGnuHash(names: string[], symoffset = 1): GnuHashTable {
  const n = names.length;
  const nbuckets = Math.max(Math.floor(n / 4), 1);
  const maskWords = nextPow2Above(Math.floor((n * 12) / 64));
  const withHash = names.map((name, i) => ({ name, h: dlNewHash(name), i }));
  withHash.sort((a, b) => (a.h % nbuckets) - (b.h % nbuckets) || a.i - b.i);
  const bloom = Array<bigint>(maskWords).fill(0n);
  for (const { h } of withHash) {
    const w = Math.floor(h / 64) % maskWords;
    bloom[w]! |= (1n << BigInt(h % 64)) | (1n << BigInt((h >>> BLOOM_SHIFT) % 64));
  }
  const buckets = Array<number>(nbuckets).fill(0);
  const chain: number[] = [];
  withHash.forEach(({ h }, k) => {
    const b = h % nbuckets;
    if (buckets[b] === 0) buckets[b] = symoffset + k;
    const last = k === n - 1 || withHash[k + 1]!.h % nbuckets !== b;
    chain.push(((h & ~1) | (last ? 1 : 0)) >>> 0);
  });
  return { names: withHash.map((x) => x.name), symoffset, nbuckets, bloom, buckets, chain };
}

/** The section bytes, little-endian, as ld.lld writes them. */
export function gnuHashBytes(t: GnuHashTable): Uint8Array {
  const out = new Uint8Array(16 + t.bloom.length * 8 + t.buckets.length * 4 + t.chain.length * 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, t.nbuckets, true); dv.setUint32(4, t.symoffset, true); dv.setUint32(8, t.bloom.length, true); dv.setUint32(12, BLOOM_SHIFT, true);
  let o = 16;
  for (const w of t.bloom) { dv.setBigUint64(o, w, true); o += 8; }
  for (const b of t.buckets) { dv.setUint32(o, b, true); o += 4; }
  for (const c of t.chain) { dv.setUint32(o, c, true); o += 4; }
  return out;
}

export interface LookupTrace {
  hash: number;
  bloomWord: number;
  bits: [number, number];
  bloomPass: boolean;
  bucket: number;
  /** .dynsym indices visited in the chain, with the result of the hash compare. */
  chain: { index: number; name: string; hashMatch: boolean }[];
  /** strcmp calls: only for entries whose 31-bit hash matched. */
  strcmps: number;
  found: number | null;
}

/** The lookup of glibc's do_lookup_x for one object, step by step. */
export function gnuLookup(t: GnuHashTable, name: string): LookupTrace {
  const h = dlNewHash(name);
  const bloomWord = Math.floor(h / 64) % t.bloom.length;
  const bits: [number, number] = [h % 64, (h >>> BLOOM_SHIFT) % 64];
  const mask = (1n << BigInt(bits[0])) | (1n << BigInt(bits[1]));
  const bloomPass = (t.bloom[bloomWord]! & mask) === mask;
  const bucket = h % t.nbuckets;
  const tr: LookupTrace = { hash: h, bloomWord, bits, bloomPass, bucket, chain: [], strcmps: 0, found: null };
  if (!bloomPass) return tr;
  let i = t.buckets[bucket]!;
  if (i === 0) return tr;
  for (;;) {
    const c = t.chain[i - t.symoffset]!;
    const sym = t.names[i - t.symoffset]!;
    const hashMatch = ((c ^ h) >>> 1) === 0;
    tr.chain.push({ index: i, name: sym, hashMatch });
    if (hashMatch) {
      tr.strcmps++;
      if (sym === name) { tr.found = i; break; }
    }
    if (c & 1) break;
    i++;
  }
  return tr;
}

// ---------------------------------------------------------------- a scope of many libraries

/** A deterministic pseudo-random generator (mulberry32), so that the demo shows the same libraries each time. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL = ["ab", "cd", "ef", "gi", "lo", "mu", "na", "pe", "ri", "so", "tu", "va", "xe", "zo", "qua", "fly"];

/** Symbol names of a made-up library: a prefix and random syllables. */
export function fakeLibrary(index: number, count: number): string[] {
  const r = rng(1000 + index);
  const pre = `l${index}_`;
  const out = new Set<string>();
  while (out.size < count) {
    let s = pre;
    const k = 2 + Math.floor(r() * 3);
    for (let i = 0; i < k; i++) s += SYL[Math.floor(r() * SYL.length)];
    out.add(s);
  }
  return [...out];
}

export interface ScopeLookup {
  /** One entry for each library that the search visited, in scope order. */
  visits: { lib: number; trace: LookupTrace }[];
  foundIn: number | null;
  bloomRejects: number;
  /** Bloom filter said "maybe", but the symbol was not there. */
  falsePositives: number;
  strcmps: number;
}

/** Search libraries in scope order and stop at the first one that defines the name, as ld.so does. */
export function scopeLookup(tables: GnuHashTable[], name: string): ScopeLookup {
  const visits: ScopeLookup["visits"] = [];
  let bloomRejects = 0, falsePositives = 0, strcmps = 0;
  for (let i = 0; i < tables.length; i++) {
    const trace = gnuLookup(tables[i]!, name);
    visits.push({ lib: i, trace });
    strcmps += trace.strcmps;
    if (!trace.bloomPass) bloomRejects++;
    else if (trace.found === null) falsePositives++;
    if (trace.found !== null) return { visits, foundIn: i, bloomRejects, falsePositives, strcmps };
  }
  return { visits, foundIn: null, bloomRejects, falsePositives, strcmps };
}

/**
 * The cost of binding `symbols` names at startup when each name lives in a random library of the scope.
 * Counts operations; it does not time them.
 */
export function bindAllCost(tables: GnuHashTable[], perLib: string[][], symbols: number, seed = 7) {
  const r = rng(seed);
  let visits = 0, bloomRejects = 0, falsePositives = 0, strcmps = 0;
  for (let k = 0; k < symbols; k++) {
    const lib = Math.floor(r() * tables.length);
    const names = perLib[lib]!;
    const name = names[Math.floor(r() * names.length)]!;
    const s = scopeLookup(tables, name);
    visits += s.visits.length;
    bloomRejects += s.bloomRejects;
    falsePositives += s.falsePositives;
    strcmps += s.strcmps;
  }
  return { visits, bloomRejects, falsePositives, strcmps };
}
