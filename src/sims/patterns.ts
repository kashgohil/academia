/** Memory access pattern generators (byte addresses) for the cache simulator. */
export interface Pattern {
  id: string;
  label: string;
  gen: (opts: { n: number }) => Uint32Array;
  note: string;
}

const W = 4; // element size in bytes (int32 / f32)

export const PATTERNS: Pattern[] = [
  {
    id: "sequential",
    label: "Sequential scan",
    note: "a[i] for i in 0..N. One miss per line, then hits for the rest of it.",
    gen: ({ n }) => Uint32Array.from({ length: n }, (_, i) => i * W),
  },
  {
    id: "stride",
    label: "Strided (every 16th element)",
    note: "a[16·i]. Each access lands on a new 64-byte line: no spatial locality.",
    gen: ({ n }) => Uint32Array.from({ length: n }, (_, i) => i * 16 * W),
  },
  {
    id: "row-major",
    label: "Matrix, row-major walk",
    note: "for i: for j: m[i][j]. Walks memory in order.",
    gen: ({ n }) => {
      const side = Math.floor(Math.sqrt(n));
      const out = new Uint32Array(side * side);
      let k = 0;
      for (let i = 0; i < side; i++) for (let j = 0; j < side; j++) out[k++] = (i * side + j) * W;
      return out;
    },
  },
  {
    id: "col-major",
    label: "Matrix, column-major walk",
    note: "for j: for i: m[i][j]. Same data, jumps a full row per access.",
    gen: ({ n }) => {
      const side = Math.floor(Math.sqrt(n));
      const out = new Uint32Array(side * side);
      let k = 0;
      for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) out[k++] = (i * side + j) * W;
      return out;
    },
  },
  {
    id: "ping-pong",
    label: "Two arrays, 8 KiB apart",
    note: "a[i] then b[i], where b = a + 8 KiB. Same set index on small caches → conflict misses.",
    gen: ({ n }) => {
      const out = new Uint32Array(n);
      for (let i = 0; i < n; i++) out[i] = (i & 1 ? 8192 : 0) + (i >> 1) * W;
      return out;
    },
  },
  {
    id: "reuse",
    label: "Repeated loop over 6 KiB",
    note: "Loop over a 6 KiB buffer repeatedly. Fits or thrashes depending on cache size.",
    gen: ({ n }) => Uint32Array.from({ length: n }, (_, i) => (i % 1536) * W),
  },
  {
    id: "random",
    label: "Random over 64 KiB",
    note: "Uniform random addresses. Locality is gone; hit rate ≈ cache size / working set.",
    gen: ({ n }) => {
      let s = 12345;
      return Uint32Array.from({ length: n }, () => {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        return ((s >>> 0) % 16384) * W;
      });
    },
  },
];
