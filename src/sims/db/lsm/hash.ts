/** 32-bit MurmurHash3 (x86_32) over the UTF-16 code units of a string (bytes for ASCII keys). */
export function murmur3(key: string, seed = 0): number {
  let h = seed >>> 0;
  const n = key.length;
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    let k = (key.charCodeAt(i) & 0xff) | ((key.charCodeAt(i + 1) & 0xff) << 8) | ((key.charCodeAt(i + 2) & 0xff) << 16) | ((key.charCodeAt(i + 3) & 0xff) << 24);
    k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  switch (n & 3) {
    case 3: k ^= (key.charCodeAt(i + 2) & 0xff) << 16; // falls through
    case 2: k ^= (key.charCodeAt(i + 1) & 0xff) << 8; // falls through
    case 1:
      k ^= key.charCodeAt(i) & 0xff;
      k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2); h ^= k;
  }
  h ^= n;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/** Two independent 32-bit hashes of a key, for double hashing (Kirsch–Mitzenmacher). */
export type HashPair = readonly [number, number];
export const hashPair = (key: string): HashPair => [murmur3(key, 0x9747b28c), murmur3(key, 0x5bd1e995) | 1];
