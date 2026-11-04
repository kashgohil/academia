/**
 * Memory cost model for the Performance track: run an address trace through a three-level
 * cache hierarchy (wasm) and convert where each access was served into time.
 *
 * Two regimes, because that's what dominates real code:
 * - streaming: addresses are predictable, so the prefetcher and out-of-order core overlap
 *   misses; each miss costs roughly its bandwidth share.
 * - random: unpredictable addresses (pointer chasing, hash probes); each miss pays full latency.
 */
import { runHier, type LevelConfig } from "../../wasm/cachesim";
import { mulberry32 } from "../rng";

type Sim = Parameters<typeof runHier>[0];

export const LEVELS: LevelConfig[] = [
  { size: 32 * 1024, ways: 8 }, // L1d
  { size: 1024 * 1024, ways: 16 }, // L2
  { size: 8 * 1024 * 1024, ways: 16 }, // L3 (a per-core share of a larger shared L3)
];
/** ns to serve one access from L1, L2, L3, DRAM: latency when dependent/unpredictable… */
export const LATENCY_NS = [1, 4, 14, 90];
/** …and amortized cost when streaming with prefetch and many misses in flight. */
export const STREAM_NS = [0.25, 1, 2, 4.5];

export interface Cost { nsPerElem: number; servedFrom: number[]; bytesFromDram: number }

/** Runs the trace twice (warm-up, then measured) so data that fits in a cache level is served from it. */
export function evaluate(w: Sim, addrs: Uint32Array, elems: number, random: boolean): Cost {
  const twice = new Uint32Array(addrs.length * 2);
  twice.set(addrs);
  twice.set(addrs, addrs.length);
  const served = runHier(w, twice, LEVELS, 64, "nine").subarray(addrs.length);
  const counts = [0, 0, 0, 0];
  for (const k of served) counts[k]!++;
  const table = random ? LATENCY_NS : STREAM_NS;
  const ns = counts.reduce((s, c, k) => s + c * table[k]!, 0);
  return { nsPerElem: ns / elems, servedFrom: counts.map((c) => c / elems), bytesFromDram: (counts[3]! * 64) / elems };
}

const shuffle = (n: number, seed: number) => {
  const r = mulberry32(seed);
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
};

// ---------------- cache-friendly code ----------------

export interface Pattern { id: string; label: string; code: string; random: boolean; gen: (n: number) => Uint32Array }

const HEAP = 1 << 28; // second region, far from the first

export const PATTERNS: Pattern[] = [
  { id: "array", label: "Array of ints", code: "for x in arr: sum += x", random: false, gen: (n) => Uint32Array.from({ length: n }, (_, i) => i * 4) },
  {
    id: "list-seq", label: "Linked list, nodes allocated in order", code: "for node in list: sum += node.value", random: false,
    gen: (n) => Uint32Array.from({ length: n }, (_, i) => i * 32),
  },
  {
    id: "list-shuffled", label: "Linked list after heavy churn", code: "same loop; nodes scattered across the heap", random: true,
    gen: (n) => { const o = shuffle(n, 1); return Uint32Array.from(o, (k) => k * 32); },
  },
  {
    id: "hash-chain", label: "Hash lookups, separate chaining", code: "bucket = table[h(k)]; node = *bucket; compare", random: true,
    gen: (n) => {
      const r = mulberry32(2);
      const out = new Uint32Array(2 * n);
      for (let i = 0; i < n; i++) { const b = Math.floor(r() * n); out[2 * i] = b * 8; out[2 * i + 1] = HEAP + ((b * 2654435761) % n) * 32; }
      return out;
    },
  },
  {
    id: "hash-open", label: "Hash lookups, open addressing", code: "slot = table[h(k)]: key and value inline", random: true,
    gen: (n) => { const r = mulberry32(2); return Uint32Array.from({ length: n }, () => Math.floor(r() * n) * 16); },
  },
];

// ---------------- data-oriented design ----------------

export interface Layout { id: string; label: string; random: boolean; gen: (n: number) => Uint32Array; note: string }

/** position += velocity for n particles. OOP objects are 128 bytes; position and velocity are 24 of them. */
export const ENTITY_LAYOUTS: Layout[] = [
  {
    id: "oop-heap", label: "Objects on the heap, via pointers", random: true,
    note: "Vec<Box<dyn Entity>>: an array of pointers, each object allocated separately (scattered).",
    gen: (n) => {
      const o = shuffle(n, 3);
      const out = new Uint32Array(3 * n);
      for (let i = 0; i < n; i++) { out[3 * i] = i * 8; const base = HEAP + o[i]! * 128; out[3 * i + 1] = base; out[3 * i + 2] = base + 12; }
      return out;
    },
  },
  {
    id: "oop-array", label: "Objects stored inline in an array", random: false,
    note: "Vec<Entity>: 128-byte structs back to back. Each update still drags whole lines of cold fields through the cache.",
    gen: (n) => { const out = new Uint32Array(2 * n); for (let i = 0; i < n; i++) { out[2 * i] = i * 128; out[2 * i + 1] = i * 128 + 12; } return out; },
  },
  {
    id: "dod", label: "Hot fields in their own arrays", random: false,
    note: "positions: Vec<Vec3>, velocities: Vec<Vec3>: only the bytes the loop needs.",
    gen: (n) => { const out = new Uint32Array(2 * n); for (let i = 0; i < n; i++) { out[2 * i] = i * 12; out[2 * i + 1] = HEAP + i * 12; } return out; },
  },
];

// ---------------- AoS vs SoA ----------------

export type Soa = "aos" | "soa" | "aosoa";

/** Addresses touched when a loop reads `touched` of `fields` 4-byte fields for each of n entities. */
export function layoutTrace(layout: Soa, n: number, fields: number, touched: number, block = 8): Uint32Array {
  const out = new Uint32Array(n * touched);
  let k = 0;
  for (let e = 0; e < n; e++)
    for (let f = 0; f < touched; f++)
      out[k++] =
        layout === "aos" ? (e * fields + f) * 4
        : layout === "soa" ? f * (n * 4 + 64) + e * 4 // arrays staggered by a line: no set aliasing
        : Math.floor(e / block) * fields * block * 4 + f * block * 4 + (e % block) * 4;
  return out;
}

/** Fraction of bytes brought into the cache that the loop actually uses. */
export function usefulFraction(layout: Soa, fields: number, touched: number): number {
  return layout === "aos" ? Math.min(1, touched / fields) : 1;
}

// ---------------- latency ladder ----------------

export interface Rung { label: string; ns: number; note: string }

/** Order-of-magnitude figures for 2020s commodity hardware; real values vary by 2–3×. */
export const LADDER: Rung[] = [
  { label: "L1 cache hit", ns: 1, note: "~4–5 cycles" },
  { label: "Branch mispredict", ns: 4, note: "~15–20 cycles of discarded work" },
  { label: "L2 cache hit", ns: 4, note: "~12–14 cycles" },
  { label: "L3 cache hit", ns: 14, note: "~40–70 cycles" },
  { label: "Uncontended mutex lock/unlock", ns: 20, note: "an atomic RMW pair" },
  { label: "Main memory (DRAM)", ns: 90, note: "~80–120 ns" },
  { label: "Remote NUMA memory", ns: 150, note: "one socket hop" },
  { label: "System call (minimal)", ns: 200, note: "plus mitigations; higher on some kernels" },
  { label: "Context switch", ns: 3000, note: "direct cost; cache refill costs more" },
  { label: "Read 4 KiB from NVMe SSD", ns: 20_000, note: "~10–100 µs" },
  { label: "Round trip in a datacenter", ns: 500_000, note: "~0.1–0.5 ms" },
  { label: "Disk (HDD) seek", ns: 5_000_000, note: "~4–10 ms" },
  { label: "Round trip US ↔ Europe", ns: 80_000_000, note: "~70–150 ms" },
];

/** Average latency of dependent random accesses within a working set (pointer-chase style). */
export function randomAccessLatency(w: Sim, bytes: number, n = 30000, seed = 4): number {
  const r = mulberry32(seed);
  const lines = Math.max(1, Math.floor(bytes / 64));
  // Warm up with fresh random addresses, enough to fill the caches (about 3 touches per line,
  // capped at what L3 can hold), then measure n further accesses.
  const l3Lines = LEVELS[2]!.size / 64;
  const warm = Math.max(n, 3 * Math.min(lines, l3Lines));
  const addrs = Uint32Array.from({ length: warm + n }, () => Math.floor(r() * lines) * 64);
  const served = runHier(w, addrs, LEVELS, 64, "nine").subarray(warm);
  let ns = 0;
  for (const k of served) ns += LATENCY_NS[k]!;
  return ns / n;
}
