/**
 * Small step-by-step cache models for the explainer demos of the Caches lessons.
 * Every number that the lesson text quotes from these demos comes from here
 * and is pinned in tests/unit/cacheextras.test.ts.
 */
import { mulberry32, type Rng } from "./rng";

const log2 = (x: number) => Math.round(Math.log2(x));

// ---------------- address split ----------------

export interface Geometry { size: number; line: number; ways: number } // ways 0 = fully associative

export interface Split { sets: number; ways: number; offsetBits: number; indexBits: number; tagBits: number; offset: number; index: number; tag: number; line: number }

/** Splits a byte address into tag, set index and offset for a cache geometry. */
export function splitAddress(addr: number, g: Geometry, addrBits = 32): Split {
  const lines = g.size / g.line;
  const ways = g.ways === 0 ? lines : Math.min(g.ways, lines);
  const sets = lines / ways;
  const offsetBits = log2(g.line), indexBits = log2(sets);
  const line = Math.floor(addr / g.line);
  return { sets, ways, offsetBits, indexBits, tagBits: addrBits - offsetBits - indexBits, offset: addr % g.line, index: line % sets, tag: Math.floor(line / sets), line };
}

// ---------------- set-associative cache ----------------

export type Policy = "lru" | "fifo" | "random";

export interface Access { hit: boolean; set: number; way: number; victim: number }

/** A set-associative cache of line numbers. `slots[set * ways + way]` is a line number or -1. */
export class SetCache {
  readonly sets: number;
  readonly ways: number;
  readonly slots: Int32Array;
  private stamp: Float64Array;
  private t = 0;
  private rng: Rng;
  constructor(lines: number, ways: number, readonly policy: Policy = "lru", seed = 1) {
    this.ways = ways === 0 ? lines : Math.min(ways, lines);
    this.sets = lines / this.ways;
    this.slots = new Int32Array(lines).fill(-1);
    this.stamp = new Float64Array(lines);
    this.rng = mulberry32(seed);
  }
  access(line: number): Access {
    const set = line % this.sets, base = set * this.ways;
    this.t++;
    for (let w = 0; w < this.ways; w++) {
      if (this.slots[base + w] === line) {
        if (this.policy === "lru") this.stamp[base + w] = this.t;
        return { hit: true, set, way: w, victim: -1 };
      }
    }
    let way = -1;
    for (let w = 0; w < this.ways && way < 0; w++) if (this.slots[base + w] === -1) way = w;
    if (way < 0) {
      if (this.policy === "random") way = Math.floor(this.rng() * this.ways);
      else {
        way = 0;
        for (let w = 1; w < this.ways; w++) if (this.stamp[base + w]! < this.stamp[base + way]!) way = w;
      }
    }
    const victim = this.slots[base + way]!;
    this.slots[base + way] = line;
    this.stamp[base + way] = this.t;
    return { hit: false, set, way, victim };
  }
}

/** Hit rate of a byte-address trace on a cache. */
export function hitRate(addrs: ArrayLike<number>, g: Geometry, policy: Policy = "lru"): number {
  const c = new SetCache(g.size / g.line, g.ways, policy);
  let hits = 0;
  for (let i = 0; i < addrs.length; i++) if (c.access(Math.floor(addrs[i]! / g.line)).hit) hits++;
  return hits / addrs.length;
}

/** Number of distinct sets that a trace touches. */
export function setsUsed(addrs: ArrayLike<number>, g: Geometry): number {
  const s = new Set<number>();
  for (let i = 0; i < addrs.length; i++) s.add(splitAddress(addrs[i]!, g).index);
  return s.size;
}

/** Number of distinct sets that one column of a side×side int matrix touches. */
export const columnSets = (side: number, col: number, g: Geometry) =>
  setsUsed(Array.from({ length: side }, (_, r) => (r * side + col) * 4), g);

/** Byte addresses of a side×side matrix of 4-byte ints, walked by rows or by columns. */
export function matrixWalk(side: number, order: "row" | "col"): Uint32Array {
  const out = new Uint32Array(side * side);
  let k = 0;
  for (let a = 0; a < side; a++) for (let b = 0; b < side; b++) out[k++] = (order === "row" ? a * side + b : b * side + a) * 4;
  return out;
}

/** Long-run hit rate when a loop touches `n` lines in order, again and again, on a fully associative cache of `c` lines. */
export function loopHitRate(n: number, c: number, policy: Policy, passes = 200, seed = 1): number {
  const cache = new SetCache(c, 0, policy, seed);
  let hits = 0, count = 0;
  for (let p = 0; p < passes; p++) for (let i = 0; i < n; i++) {
    const h = cache.access(i).hit;
    if (p > 0) { count++; if (h) hits++; }
  }
  return hits / count;
}

// ---------------- average memory access time ----------------

/** AMAT for one level: hit time + miss rate × miss penalty. */
export const amat1 = (hit: number, missRate: number, penalty: number) => hit + missRate * penalty;

/**
 * AMAT of a hierarchy. `lat` has one entry per level plus memory; `local` has one local miss rate per cache level.
 * Returns the total and the part of it that each level adds.
 */
export function amat(lat: number[], local: number[]): { total: number; parts: number[]; reach: number[] } {
  const reach = [1];
  for (const m of local) reach.push(reach[reach.length - 1]! * m);
  const parts = lat.map((t, i) => reach[i]! * t);
  return { total: parts.reduce((a, b) => a + b, 0), parts, reach };
}

// ---------------- reuse distance ----------------

export interface ReuseStep { item: string; distance: number; stack: string[] } // distance Infinity for a first touch

/** LRU stack distance of each access. `stack` is the stack after the access, most recent first. */
export function reuseSteps(trace: string[]): ReuseStep[] {
  const stack: string[] = [];
  return trace.map((item) => {
    const d = stack.indexOf(item);
    if (d >= 0) stack.splice(d, 1);
    stack.unshift(item);
    return { item, distance: d >= 0 ? d : Infinity, stack: [...stack] };
  });
}

export const REUSE_TRACES: { id: string; label: string; trace: string[] }[] = [
  { id: "loop3", label: "Loop over 3 lines", trace: "ABCABCABCABC".split("") },
  { id: "loop5", label: "Loop over 5 lines", trace: "ABCDEABCDEABCDE".split("") },
  { id: "hot", label: "One hot line", trace: "ABACADAEAFAGABAC".split("") },
  { id: "phases", label: "Two phases", trace: "ABABABCDCDCDABAB".split("") },
];

/** Hits of a fully associative LRU cache of `c` lines: the accesses with distance < c. */
export const hitsAt = (steps: ReuseStep[], c: number) => steps.filter((s) => s.distance < c).length;

// ---------------- spatial locality ----------------

/** Traffic of one pass over `n` elements with a stride, when no line is reused after it leaves the stream. */
export function strideTraffic(n: number, stride: number, elem: number, line: number) {
  const lines = new Set<number>();
  let accesses = 0;
  for (let i = 0; i < n; i += stride) { accesses++; lines.add(Math.floor((i * elem) / line)); }
  return { accesses, lines: lines.size, fetched: lines.size * line, used: accesses * elem, missPerAccess: lines.size / accesses };
}

// ---------------- matrix multiply footprint ----------------

export type Order3 = "ijk" | "jki" | "ikj";

/** The (row, col) of A, B and C that iteration (i, j, k) touches. */
export const touches = (i: number, j: number, k: number) => ({ A: [i, k] as const, B: [k, j] as const, C: [i, j] as const });

/** Loop indices of iteration t (0..n³-1) in a loop order: the last letter is the innermost loop. */
export function loopIndex(order: Order3, n: number, t: number) {
  const inner = t % n, mid = Math.floor(t / n) % n, outer = Math.floor(t / (n * n));
  const v: Record<string, number> = { [order[0]!]: outer, [order[1]!]: mid, [order[2]!]: inner };
  return { i: v.i!, j: v.j!, k: v.k! };
}

/**
 * Distinct cache lines per inner-loop iteration, for each matrix, when lines are not reused between inner loops.
 * Row-major storage: a line holds `perLine` consecutive elements of one row. Operands that do not change in the inner loop count 0.
 */
export function innerLines(order: Order3, n: number, perLine: number) {
  const out = { A: 0, B: 0, C: 0 };
  for (const m of ["A", "B", "C"] as const) {
    const lines = new Set<string>();
    let varies = false;
    for (let t = 0; t < n; t++) {
      const { i, j, k } = loopIndex(order, n, t);
      const [r, c] = touches(i, j, k)[m];
      lines.add(`${r}:${Math.floor(c / perLine)}`);
      if (t > 0) { const p = loopIndex(order, n, t - 1); const [r0, c0] = touches(p.i, p.j, p.k)[m]; if (r0 !== r || c0 !== c) varies = true; }
    }
    out[m] = varies ? lines.size / n : 0;
  }
  return out;
}

// ---------------- two-level hierarchy ----------------

export type Inclusion = "inclusive" | "nine" | "exclusive";

/** Fully associative LRU list, most recent first. */
class Lru {
  items: string[] = [];
  constructor(readonly cap: number) {}
  has(x: string) { return this.items.includes(x); }
  touch(x: string) { this.remove(x); this.items.unshift(x); }
  remove(x: string) { const i = this.items.indexOf(x); if (i >= 0) this.items.splice(i, 1); return i >= 0; }
  /** Inserts as most recent; returns the evicted item, if any. */
  insert(x: string): string | null { this.items.unshift(x); return this.items.length > this.cap ? this.items.pop()! : null; }
}

export interface HierStep { item: string; level: 0 | 1 | 2; backInvalidated: string | null; l1: string[]; l2: string[] }

/** L1 and L2, both fully associative LRU. Level 2 in a step means memory. */
export class TwoLevel {
  l1: Lru;
  l2: Lru;
  constructor(l1: number, l2: number, readonly mode: Inclusion) { this.l1 = new Lru(l1); this.l2 = new Lru(l2); }
  access(x: string): HierStep {
    let level: 0 | 1 | 2;
    let back: string | null = null;
    if (this.l1.has(x)) {
      level = 0;
      this.l1.touch(x); // L1 hits do not reach L2, so L2's recency is not updated.
    } else if (this.mode === "exclusive") {
      level = this.l2.remove(x) ? 1 : 2;
      const v = this.l1.insert(x);
      if (v) this.l2.insert(v); // the L1 victim moves down; the L2 victim goes to memory
    } else {
      level = this.l2.has(x) ? 1 : 2;
      if (level === 1) this.l2.touch(x);
      else {
        const v = this.l2.insert(x);
        if (v && this.mode === "inclusive" && this.l1.remove(v)) back = v;
      }
      this.l1.insert(x);
    }
    return { item: x, level, backInvalidated: back, l1: [...this.l1.items], l2: [...this.l2.items] };
  }
}

export const HIER_TRACES: { id: string; label: string; trace: string[] }[] = [
  { id: "hot", label: "Hot line H + a stream", trace: Array.from({ length: 34 }, (_, i) => (i % 2 === 0 ? "H" : String.fromCharCode(97 + ((i >> 1) % 26)))) },
  { id: "loop6", label: "Loop over 6 lines", trace: Array.from({ length: 36 }, (_, i) => "ABCDEF"[i % 6]!) },
];

/** Share of the hot line's accesses after its first one that miss L1. */
export function hotMissShare(steps: HierStep[], hot = "H"): number {
  const h = steps.filter((s) => s.item === hot).slice(1);
  return h.filter((s) => s.level !== 0).length / h.length;
}

export function runTwoLevel(trace: string[], l1: number, l2: number, mode: Inclusion): HierStep[] {
  const h = new TwoLevel(l1, l2, mode);
  return trace.map((x) => h.access(x));
}

// ---------------- prefetch timeliness ----------------

export interface TimelineRow { issue: number; ready: number; start: number; stall: number; end: number }

/**
 * A loop that does `work` cycles of compute on each line of data. A miss takes `latency` cycles.
 * At the start of iteration i, the loop prefetches line i + distance (distance 0 = no prefetch).
 * The model allows any number of misses at the same time.
 */
export function prefetchTimeline(n: number, work: number, latency: number, distance: number): TimelineRow[] {
  const issue = new Array<number>(n + distance + 1).fill(-1);
  const rows: TimelineRow[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    if (issue[i]! < 0) issue[i] = t; // demand miss
    if (distance > 0) for (let j = i + 1; j <= Math.min(n - 1, i + distance); j++) if (issue[j]! < 0) issue[j] = t;
    const ready = issue[i]! + latency;
    const start = Math.max(t, ready);
    rows.push({ issue: issue[i]!, ready, start, stall: start - t, end: start + work });
    t = start + work;
  }
  return rows;
}

/** Average cycles per line over the second half of the loop (the steady state). */
export function cyclesPerLine(rows: TimelineRow[]): number {
  const n = rows.length, h = Math.floor(n / 2);
  return (rows[n - 1]!.end - rows[h - 1]!.end) / (n - h);
}

// ---------------- stride detector ----------------

export interface StrideStep { pc: number; addr: number; delta: number; confident: boolean; target: number | null; covered: boolean }

/**
 * A stride detector with degree 1, as in crates/cachesim/src/prefetch.rs:
 * it is confident when the same nonzero delta occurs twice in a row, and then it prefetches addr + delta.
 * `perPc` keeps one detector per load instruction. Addresses are line numbers. No line is evicted.
 */
export function strideSteps(trace: { pc: number; addr: number }[], perPc: boolean): StrideStep[] {
  const table = new Map<number, { last: number; delta: number }>();
  const prefetched = new Set<number>();
  return trace.map(({ pc, addr }) => {
    const key = perPc ? pc : 0;
    const e = table.get(key) ?? { last: perPc ? addr : 0, delta: 0 };
    const delta = addr - e.last;
    const confident = delta !== 0 && delta === e.delta;
    table.set(key, { last: addr, delta });
    const covered = prefetched.has(addr);
    const target = confident ? addr + delta : null;
    if (target !== null) prefetched.add(target);
    return { pc, addr, delta, confident, target, covered };
  });
}

/** Two loads in one loop: a[i] every 3 lines (instruction 1) and b[i] every 5 lines from line 1000 (instruction 2). */
export const twoStreams = (n: number) => Array.from({ length: 2 * n }, (_, k) => (k % 2 === 0 ? { pc: 1, addr: 3 * (k >> 1) } : { pc: 2, addr: 1000 + 5 * (k >> 1) }));

export const coverage = (steps: StrideStep[]) => steps.filter((s) => s.covered).length / steps.length;

// ---------------- write policies ----------------

export interface WriteOp { addr: number; write: boolean }
export interface BusOp { kind: "read line" | "write line" | "write word"; line: number; bytes: number }
export interface WriteState { lines: { line: number; dirty: boolean; words: number[] }[]; read: number; written: number; ops: number }
export interface WriteStep { op: WriteOp; hit: boolean; bus: BusOp[]; state: WriteState }

export const W_LINE = 64, W_WORD = 8;

/**
 * A small fully associative LRU cache with a write policy. Words are 8 bytes, lines are 64 bytes.
 * `words` marks the words of a line that the program wrote while the line was in the cache.
 */
export function runWritePolicy(ops: WriteOp[], lines: number, writeBack: boolean, writeAllocate: boolean): WriteStep[] {
  let cache: { line: number; dirty: boolean; words: number[] }[] = []; // most recent first
  let read = 0, written = 0, count = 0;
  return ops.map((op) => {
    const bus: BusOp[] = [];
    const line = Math.floor(op.addr / W_LINE), word = Math.floor((op.addr % W_LINE) / W_WORD);
    const i = cache.findIndex((c) => c.line === line);
    const hit = i >= 0;
    let entry = hit ? cache.splice(i, 1)[0]! : null;
    if (!entry && (!op.write || writeAllocate)) {
      bus.push({ kind: "read line", line, bytes: W_LINE });
      entry = { line, dirty: false, words: [] };
      if (cache.length >= lines) {
        const v = cache.pop()!;
        if (v.dirty) bus.push({ kind: "write line", line: v.line, bytes: W_LINE });
      }
    }
    if (op.write) {
      if (entry) {
        if (!entry.words.includes(word)) entry.words = [...entry.words, word];
        if (writeBack) entry.dirty = true;
      }
      if (!writeBack || !entry) bus.push({ kind: "write word", line, bytes: W_WORD });
    }
    if (entry) cache = [entry, ...cache];
    for (const b of bus) { if (b.kind === "read line") read += b.bytes; else written += b.bytes; count++; }
    return { op, hit, bus, state: { lines: cache.map((c) => ({ ...c, words: [...c.words] })), read, written, ops: count } };
  });
}

export const WRITE_TRACES: { id: string; label: string; ops: WriteOp[] }[] = [
  { id: "memset", label: "memset 6 lines", ops: Array.from({ length: 48 }, (_, i) => ({ addr: i * 8, write: true })) },
  { id: "increment", label: "x[i] += 1, 2 lines, 3 passes", ops: Array.from({ length: 3 * 16 }, (_, i) => i % 16).flatMap((w) => [{ addr: w * 8, write: false }, { addr: w * 8, write: true }]) },
  { id: "column", label: "Column writes, 6 lines", ops: Array.from({ length: 48 }, (_, i) => ({ addr: (i % 6) * W_LINE + Math.floor(i / 6) * 8, write: true })) },
];

/** Final traffic of a write trace, with dirty lines still in the cache counted as owed writes. */
export function writeTraffic(ops: WriteOp[], lines: number, writeBack: boolean, writeAllocate: boolean) {
  const steps = runWritePolicy(ops, lines, writeBack, writeAllocate);
  const s = steps[steps.length - 1]!.state;
  const owed = s.lines.filter((l) => l.dirty).length * W_LINE;
  return { read: s.read, written: s.written + owed, ops: s.ops + owed / W_LINE };
}
