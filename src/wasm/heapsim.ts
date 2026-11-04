/** Typed bindings for crates/heapsim. */
import { loadWasm } from "./load";

export const KIND = { bump: 0, arena: 1, pool: 2, freelist: 3, buddy: 4, slab: 5, sizeclass: 6 } as const;
export type Kind = keyof typeof KIND;

export const REGION = { free: 0, meta: 1, pad: 2, live: 3, slack: 4, dead: 5 } as const;

export interface Region { off: number; len: number; kind: number; id: number }
export interface HeapStats {
  live: number; meta: number; pad: number; slack: number; dead: number;
  free: number; largestFree: number; liveCount: number;
}

interface Exports {
  memory: WebAssembly.Memory;
  heap_new(kind: number, cap: number, a: number, b: number): number;
  heap_drop(h: number): void;
  heap_alloc(h: number, size: number, align: number): number;
  heap_free(h: number, addr: number): number;
  heap_reset(h: number): void;
  heap_mark(h: number): number;
  heap_restore(h: number, m: number): void;
  heap_regions(h: number): number;
  heap_links(h: number): number;
  heap_stats(h: number): number;
  heap_buf(h: number): number;
}

export type HeapSim = Exports;

export async function loadHeapSim(source?: () => Promise<BufferSource>): Promise<HeapSim> {
  return (await loadWasm("heapsim", source)).exports as unknown as Exports;
}

const FAIL = 0xffffffff;

export interface HeapConfig { kind: Kind; cap: number; a?: number; b?: number }

/** One simulated heap. Call dispose() when done (React effects do this on cleanup). */
export class Heap {
  readonly h: number;
  constructor(private w: Exports, readonly cfg: HeapConfig) {
    this.h = w.heap_new(KIND[cfg.kind], cfg.cap, cfg.a ?? 0, cfg.b ?? 0);
  }

  private read(n: number): Uint32Array {
    // Copy out immediately: the next call may reallocate the buffer or grow memory.
    return new Uint32Array(this.w.memory.buffer, this.w.heap_buf(this.h), n).slice();
  }

  alloc(size: number, align = 1): number | null {
    const a = this.w.heap_alloc(this.h, size, align) >>> 0;
    return a === FAIL ? null : a;
  }
  free(addr: number): boolean { return this.w.heap_free(this.h, addr) !== 0; }
  reset() { this.w.heap_reset(this.h); }
  mark(): number { return this.w.heap_mark(this.h) >>> 0; }
  restore(m: number) { this.w.heap_restore(this.h, m); }

  regions(): Region[] {
    const n = this.w.heap_regions(this.h);
    const b = this.read(n * 4);
    const out: Region[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { off: b[4 * i]!, len: b[4 * i + 1]!, kind: b[4 * i + 2]!, id: b[4 * i + 3]! };
    return out;
  }

  links(): [number, number][] {
    const n = this.w.heap_links(this.h);
    const b = this.read(n * 2);
    return Array.from({ length: n }, (_, i) => [b[2 * i]!, b[2 * i + 1]!] as [number, number]);
  }

  stats(): HeapStats {
    this.w.heap_stats(this.h);
    const [live, meta, pad, slack, dead, free, largestFree, liveCount] = this.read(8);
    return { live: live!, meta: meta!, pad: pad!, slack: slack!, dead: dead!, free: free!, largestFree: largestFree!, liveCount: liveCount! };
  }

  dispose() { this.w.heap_drop(this.h); }
}

/** Overhead = everything that is neither live payload nor free. */
export const overhead = (s: HeapStats) => s.meta + s.pad + s.slack + s.dead;
/** External fragmentation: how much of the free memory is unusable for one large request. */
export const extFrag = (s: HeapStats) => (s.free === 0 ? 0 : 1 - s.largestFree / s.free);
