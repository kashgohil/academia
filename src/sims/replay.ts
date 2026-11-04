import { Heap, REGION, type HeapConfig, type HeapSim } from "../wasm/heapsim";
import type { Op } from "./traces";

export interface ReplayPoint { step: number; live: number; footprint: number }
export interface ReplayResult {
  failed: number;
  peakLive: number;
  /** Highest address in use at any point: the memory this allocator needed for the trace. */
  peakFootprint: number;
  series: ReplayPoint[];
}

/** Highest byte not free. */
export function footprint(h: Heap): number {
  let hi = 0;
  for (const r of h.regions()) if (r.kind !== REGION.free) hi = Math.max(hi, r.off + r.len);
  return hi;
}

export function replay(w: HeapSim, cfg: HeapConfig, ops: Op[], samples = 120): ReplayResult {
  const h = new Heap(w, cfg);
  try {
    const addr = new Map<number, number>();
    const res: ReplayResult = { failed: 0, peakLive: 0, peakFootprint: 0, series: [] };
    let live = 0;
    const sizes = new Map<number, number>();
    const every = Math.max(1, Math.floor(ops.length / samples));
    ops.forEach((op, i) => {
      if (op.t === "a") {
        const a = h.alloc(op.size, 8);
        if (a === null) res.failed++;
        else {
          addr.set(op.id, a);
          sizes.set(op.id, op.size);
          live += op.size;
        }
      } else {
        const a = addr.get(op.id);
        if (a !== undefined) {
          h.free(a);
          addr.delete(op.id);
          live -= sizes.get(op.id)!;
        }
      }
      res.peakLive = Math.max(res.peakLive, live);
      if (op.t === "a") res.peakFootprint = Math.max(res.peakFootprint, footprint(h));
      if (i % every === 0) res.series.push({ step: i, live, footprint: footprint(h) });
    });
    return res;
  } finally {
    h.dispose();
  }
}
