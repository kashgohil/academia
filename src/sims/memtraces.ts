/** Memory access traces (byte addresses) with optional store flags and load-instruction ids. */
import { mulberry32 } from "./rng";

export interface MemTrace { addrs: Uint32Array; writes: Uint8Array; pcs: Uint32Array }

class Builder {
  a: number[] = [];
  w: number[] = [];
  p: number[] = [];
  read(addr: number, pc = 0) { this.a.push(addr); this.w.push(0); this.p.push(pc); }
  write(addr: number, pc = 0) { this.a.push(addr); this.w.push(1); this.p.push(pc); }
  done(): MemTrace { return { addrs: Uint32Array.from(this.a), writes: Uint8Array.from(this.w), pcs: Uint32Array.from(this.p) }; }
}

// ---------------- matrix multiply ----------------

export type LoopOrder = "ijk" | "jki" | "ikj" | "tiled";

/**
 * C += A × B on N×N doubles, row-major, matrices placed back to back.
 * Loop-invariant operands are kept in registers, as a compiler would:
 * ijk keeps C[i][j], jki keeps B[k][j], ikj keeps A[i][k].
 */
export function matmul(n: number, order: LoopOrder, tile = 16): MemTrace {
  const E = 8;
  const A = 0, B = n * n * E, C = 2 * n * n * E;
  const at = (base: number, r: number, c: number) => base + (r * n + c) * E;
  const t = new Builder();
  if (order === "ijk") {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      t.read(at(C, i, j), 3);
      for (let k = 0; k < n; k++) { t.read(at(A, i, k), 1); t.read(at(B, k, j), 2); }
      t.write(at(C, i, j), 3);
    }
  } else if (order === "jki") {
    for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      t.read(at(B, k, j), 2);
      for (let i = 0; i < n; i++) { t.read(at(A, i, k), 1); t.read(at(C, i, j), 3); t.write(at(C, i, j), 3); }
    }
  } else if (order === "ikj") {
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
      t.read(at(A, i, k), 1);
      for (let j = 0; j < n; j++) { t.read(at(B, k, j), 2); t.read(at(C, i, j), 3); t.write(at(C, i, j), 3); }
    }
  } else {
    for (let ii = 0; ii < n; ii += tile) for (let kk = 0; kk < n; kk += tile) for (let jj = 0; jj < n; jj += tile)
      for (let i = ii; i < Math.min(ii + tile, n); i++) for (let k = kk; k < Math.min(kk + tile, n); k++) {
        t.read(at(A, i, k), 1);
        for (let j = jj; j < Math.min(jj + tile, n); j++) { t.read(at(B, k, j), 2); t.read(at(C, i, j), 3); t.write(at(C, i, j), 3); }
      }
  }
  return t.done();
}

// ---------------- write patterns ----------------

export interface WritePattern { id: string; label: string; note: string; gen: () => MemTrace }

const KB = 1024;

export const WRITE_PATTERNS: WritePattern[] = [
  {
    id: "memset",
    label: "memset 16 KiB",
    note: "Store to every 4-byte word once, never read it.",
    gen: () => { const t = new Builder(); for (let i = 0; i < 4 * KB; i++) t.write(i * 4); return t.done(); },
  },
  {
    id: "increment",
    label: "a[i] += 1, 20 passes over 1 KiB",
    note: "Read-modify-write the same small array repeatedly. It fits in the cache.",
    gen: () => { const t = new Builder(); for (let p = 0; p < 20; p++) for (let i = 0; i < 256; i++) { t.read(i * 4); t.write(i * 4); } return t.done(); },
  },
  {
    id: "copy",
    label: "memcpy 8 KiB",
    note: "Read a source array, write a destination array.",
    gen: () => { const t = new Builder(); for (let i = 0; i < 2 * KB; i++) { t.read(i * 4); t.write(64 * KB + i * 4); } return t.done(); },
  },
  {
    id: "transpose",
    label: "Transpose 64×64 ints",
    note: "B[j][i] = A[i][j]: reads are sequential, writes jump a full row.",
    gen: () => {
      const t = new Builder();
      const n = 64;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { t.read((i * n + j) * 4); t.write(64 * KB + (j * n + i) * 4); }
      return t.done();
    },
  },
  {
    id: "scatter",
    label: "Scattered counters",
    note: "Increment random counters in a 64 KiB table (histogram update).",
    gen: () => {
      const t = new Builder();
      const r = mulberry32(5);
      for (let i = 0; i < 4 * KB; i++) { const a = Math.floor(r() * 16 * KB) * 4; t.read(a); t.write(a); }
      return t.done();
    },
  },
];

// ---------------- working-set sweep ----------------

/** Uniformly random line-sized accesses within a working set of `bytes`, `n` accesses. */
export function randomInSet(bytes: number, n: number, seed = 9, line = 64): Uint32Array {
  const r = mulberry32(seed);
  const lines = Math.max(1, Math.floor(bytes / line));
  return Uint32Array.from({ length: n }, () => Math.floor(r() * lines) * line);
}

// ---------------- prefetch patterns ----------------

export interface PrefetchPattern { id: string; label: string; note: string; gen: () => MemTrace }

export const PREFETCH_PATTERNS: PrefetchPattern[] = [
  {
    id: "sequential",
    label: "Sequential scan",
    note: "for i: sum += a[i] over 64 KiB of ints.",
    gen: () => { const t = new Builder(); for (let i = 0; i < 16 * KB; i++) t.read(i * 4, 1); return t.done(); },
  },
  {
    id: "stride",
    label: "Stride of 3 lines",
    note: "Read one field from each 192-byte record (an array of structs).",
    gen: () => { const t = new Builder(); for (let i = 0; i < 4 * KB; i++) t.read(i * 192, 1); return t.done(); },
  },
  {
    id: "two-streams",
    label: "Two interleaved streams",
    note: "a[i] (stride 192 B) and b[i] (stride 320 B) read in the same loop by two different load instructions.",
    gen: () => { const t = new Builder(); for (let i = 0; i < 4 * KB; i++) { t.read(i * 192, 1); t.read((1 << 22) + i * 320, 2); } return t.done(); },
  },
  {
    id: "pointer-chase",
    label: "Linked list (pointer chase)",
    note: "Follow next pointers through 4096 nodes of 64 B placed in random order.",
    gen: () => {
      const n = 4 * KB;
      const order = Array.from({ length: n }, (_, i) => i);
      const r = mulberry32(3);
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
      const t = new Builder();
      for (const node of order) t.read(node * 64, 1);
      return t.done();
    },
  },
  {
    id: "gather",
    label: "Indirect gather a[idx[i]]",
    note: "idx is read sequentially (instruction 1); a is read at random positions (instruction 2).",
    gen: () => {
      const r = mulberry32(4);
      const t = new Builder();
      for (let i = 0; i < 8 * KB; i++) { t.read(i * 4, 1); t.read((1 << 22) + Math.floor(r() * 64 * KB) * 64, 2); }
      return t.done();
    },
  },
];
