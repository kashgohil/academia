import { loadWasm } from "./load";
/** Typed bindings for crates/cachesim (raw C ABI, no bindgen). */
export type Policy = "lru" | "fifo" | "random";
export const OUTCOME = { hit: 0, compulsory: 1, capacity: 2, conflict: 3 } as const;

export interface CacheConfig { size: number; line: number; ways: number; policy: Policy }

interface Exports {
  memory: WebAssembly.Memory;
  alloc(bytes: number): number;
  dealloc(ptr: number, bytes: number): void;
  cachesim_run(addrs: number, n: number, out: number, size: number, line: number, ways: number, policy: number): number;
}

export async function loadCacheSim(source?: () => Promise<BufferSource>): Promise<Exports> {
  return (await loadWasm("cachesim", source)).exports as unknown as Exports;
}

const POLICY: Record<Policy, number> = { lru: 0, fifo: 1, random: 2 };

/** Runs the simulator. Returns one outcome byte per access (see OUTCOME). */
export function runCache(w: Exports, addrs: Uint32Array, cfg: CacheConfig): Uint8Array {
  const n = addrs.length;
  const aPtr = w.alloc(n * 4);
  const oPtr = w.alloc(n);
  // Views are created after alloc: memory may have grown and detached older buffers.
  new Uint32Array(w.memory.buffer, aPtr, n).set(addrs);
  w.cachesim_run(aPtr, n, oPtr, cfg.size, cfg.line, cfg.ways, POLICY[cfg.policy]);
  const out = new Uint8Array(w.memory.buffer, oPtr, n).slice();
  w.dealloc(aPtr, n * 4);
  w.dealloc(oPtr, n);
  return out;
}

// ---------------- extended models ----------------

interface ExtExports extends Exports {
  cachesim_reuse(addrs: number, n: number, out: number, line: number): void;
  cachesim_write(addrs: number, writes: number, n: number, out: number, lines: number, line: number, ways: number, wb: number, wa: number, stats: number): void;
  cachesim_hier(addrs: number, n: number, out: number, nlevels: number, lines: number, ways: number, line: number, mode: number): void;
  cachesim_prefetch(addrs: number, pcs: number, n: number, out: number, lines: number, line: number, ways: number, kind: number, degree: number, stats: number): void;
}

/** Copies typed arrays into wasm memory, runs `f` with their pointers, frees everything. */
function withBuffers<T>(w: Exports, inputs: (Uint32Array | Uint8Array)[], outBytes: number[], f: (ptrs: number[], outPtrs: number[]) => T): T {
  const ptrs = inputs.map((a) => w.alloc(a.byteLength));
  const outPtrs = outBytes.map((b) => w.alloc(b));
  inputs.forEach((a, i) => (a instanceof Uint32Array ? new Uint32Array(w.memory.buffer, ptrs[i], a.length) : new Uint8Array(w.memory.buffer, ptrs[i], a.length)).set(a));
  try {
    return f(ptrs, outPtrs);
  } finally {
    inputs.forEach((a, i) => w.dealloc(ptrs[i]!, a.byteLength));
    outBytes.forEach((b, i) => w.dealloc(outPtrs[i]!, b));
  }
}

const ext = (w: Exports) => w as ExtExports;
export const COLD = 0xffffffff;

/** LRU stack distance of every access, in lines (COLD for first touch). */
export function runReuse(w: Exports, addrs: Uint32Array, line: number): Uint32Array {
  const n = addrs.length;
  return withBuffers(w, [addrs], [n * 4], ([a], [o]) => {
    ext(w).cachesim_reuse(a!, n, o!, line);
    return new Uint32Array(w.memory.buffer, o!, n).slice();
  });
}

export interface WriteConfig { size: number; line: number; ways: number; writeBack: boolean; writeAllocate: boolean }
export interface WriteStats { hits: number; misses: number; memRead: number; memWrite: number; writebacks: number; dirtyAtEnd: number }

export function runWrite(w: Exports, addrs: Uint32Array, writes: Uint8Array, cfg: WriteConfig): { out: Uint8Array; stats: WriteStats } {
  const n = addrs.length;
  return withBuffers(w, [addrs, writes], [n, 24], ([a, wr], [o, s]) => {
    ext(w).cachesim_write(a!, wr!, n, o!, cfg.size / cfg.line, cfg.line, cfg.ways, +cfg.writeBack, +cfg.writeAllocate, s!);
    const [hits, misses, memRead, memWrite, writebacks, dirtyAtEnd] = new Uint32Array(w.memory.buffer, s!, 6);
    return { out: new Uint8Array(w.memory.buffer, o!, n).slice(), stats: { hits: hits!, misses: misses!, memRead: memRead!, memWrite: memWrite!, writebacks: writebacks!, dirtyAtEnd: dirtyAtEnd! } };
  });
}

export type Inclusion = "nine" | "inclusive" | "exclusive";
export interface LevelConfig { size: number; ways: number }

/** Returns, per access, the index of the level that served it (levels.length = memory). */
export function runHier(w: Exports, addrs: Uint32Array, levels: LevelConfig[], line: number, mode: Inclusion): Uint8Array {
  const n = addrs.length;
  const lines = Uint32Array.from(levels, (l) => l.size / line);
  const ways = Uint32Array.from(levels, (l) => l.ways);
  return withBuffers(w, [addrs, lines, ways], [n], ([a, l, wy], [o]) => {
    ext(w).cachesim_hier(a!, n, o!, levels.length, l!, wy!, line, { nine: 0, inclusive: 1, exclusive: 2 }[mode]);
    return new Uint8Array(w.memory.buffer, o!, n).slice();
  });
}

export type PrefetchKind = "none" | "next-line" | "stride" | "pc-stride";
export interface PrefetchConfig { size: number; line: number; ways: number; kind: PrefetchKind; degree: number }
export interface PrefetchStats { hits: number; covered: number; misses: number; issued: number; useless: number }
export const PF = { hit: 0, covered: 1, miss: 2 } as const;

export function runPrefetch(w: Exports, addrs: Uint32Array, pcs: Uint32Array, cfg: PrefetchConfig): { out: Uint8Array; stats: PrefetchStats } {
  const n = addrs.length;
  const kind = { none: 0, "next-line": 1, stride: 2, "pc-stride": 3 }[cfg.kind];
  return withBuffers(w, [addrs, pcs], [n, 20], ([a, p], [o, s]) => {
    ext(w).cachesim_prefetch(a!, p!, n, o!, cfg.size / cfg.line, cfg.line, cfg.ways, kind, cfg.degree, s!);
    const [hits, covered, misses, issued, useless] = new Uint32Array(w.memory.buffer, s!, 5);
    return { out: new Uint8Array(w.memory.buffer, o!, n).slice(), stats: { hits: hits!, covered: covered!, misses: misses!, issued: issued!, useless: useless! } };
  });
}
