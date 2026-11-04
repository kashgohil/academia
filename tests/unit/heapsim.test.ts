import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";
import { Heap, loadHeapSim, REGION, extFrag, type HeapConfig, type HeapSim } from "@/wasm/heapsim";
import { TRACES } from "@/sims/traces";
import { replay } from "@/sims/replay";

let w: HeapSim;
beforeAll(async () => {
  w = await loadHeapSim(() => readFile(new URL("../../public/wasm/heapsim.wasm", import.meta.url)));
});

const withHeap = <T,>(cfg: HeapConfig, f: (h: Heap) => T): T => {
  const h = new Heap(w, cfg);
  try { return f(h); } finally { h.dispose(); }
};

// Numbers quoted in the allocator lessons. Keep in sync.
describe("allocator lesson claims", () => {
  test("bump: char,double,char,double uses 32 bytes; reordered uses 18", () => {
    withHeap({ kind: "bump", cap: 1024 }, (h) => {
      [[1, 1], [8, 8], [1, 1], [8, 8]].forEach(([s, a]) => h.alloc(s!, a!));
      expect(h.stats()).toMatchObject({ live: 18, pad: 14 });
      h.reset();
      [[8, 8], [8, 8], [1, 1], [1, 1]].forEach(([s, a]) => h.alloc(s!, a!));
      expect(h.stats().pad).toBe(0);
    });
  });

  test("arena: three 100 B allocations in 256 B chunks open a second chunk", () => {
    withHeap({ kind: "arena", cap: 2048, a: 256 }, (h) => {
      for (let i = 0; i < 3; i++) h.alloc(100, 8);
      const s = h.stats();
      expect(s.meta).toBe(32);
      expect(s.slack).toBe(40);
    });
  });

  test("pool: LIFO reuse", () => {
    withHeap({ kind: "pool", cap: 1024, a: 64 }, (h) => {
      const a = h.alloc(64, 8)!;
      h.alloc(64, 8);
      const c = h.alloc(64, 8)!;
      h.free(a);
      h.free(c);
      expect(h.alloc(8, 8)).toBe(c);
    });
  });

  test("free list without coalescing: plenty free, nothing large", () => {
    withHeap({ kind: "freelist", cap: 1024, a: 0, b: 0 }, (h) => {
      const xs = Array.from({ length: 8 }, () => h.alloc(120, 8)!);
      xs.forEach((x) => h.free(x));
      expect(h.alloc(600, 8)).toBeNull();
      expect(h.stats().free).toBeGreaterThan(900);
      expect(extFrag(h.stats())).toBeGreaterThan(0.8);
    });
  });

  test("buddy: 33 B takes a 64 B block; 513 B needs the whole 1 KiB heap", () => {
    withHeap({ kind: "buddy", cap: 1024 }, (h) => {
      h.alloc(33, 1);
      expect(h.stats().slack).toBe(31);
      expect(h.alloc(513, 1)).toBeNull();
    });
  });

  test("regions tile the heap for every kind", () => {
    const cfgs: HeapConfig[] = [
      { kind: "bump", cap: 4096 }, { kind: "arena", cap: 4096, a: 512 }, { kind: "pool", cap: 4096, a: 48 },
      { kind: "freelist", cap: 4096, a: 2, b: 1 }, { kind: "buddy", cap: 4096 },
      { kind: "slab", cap: 4096, a: 512, b: 1 }, { kind: "sizeclass", cap: 16384, a: 1024, b: 1 },
    ];
    for (const cfg of cfgs) withHeap(cfg, (h) => {
      for (let i = 0; i < 20; i++) h.alloc(10 + i * 7, 8);
      let cur = 0;
      for (const r of h.regions()) { expect(r.off).toBe(cur); cur += r.len; }
      expect(cur).toBe(cfg.cap);
      expect(h.regions().filter((r) => r.kind === REGION.live).every((r) => r.id > 0)).toBe(true);
    });
  });
});

describe("fragmentation replay (Wilson-style footprint / peak live)", () => {
  const ratio = (cfg: HeapConfig, trace: string) => {
    const r = replay(w, cfg, TRACES.find((t) => t.id === trace)!.ops);
    expect(r.failed).toBe(0);
    return r.peakFootprint / r.peakLive;
  };
  const fl = (a: number, b = 1): HeapConfig => ({ kind: "freelist", cap: 65536, a, b });

  test("best and first fit stay within 20% of peak live on random sizes", () => {
    expect(ratio(fl(2), "random")).toBeLessThan(1.15);
    expect(ratio(fl(0), "random")).toBeLessThan(1.2);
  });
  test("next fit and worst fit spread across the heap", () => {
    expect(ratio(fl(1), "random")).toBeGreaterThan(2.5);
    expect(ratio(fl(3), "random")).toBeGreaterThan(2.5);
  });
  test("disabling coalescing roughly doubles the footprint", () => {
    expect(ratio(fl(0, 0), "random") / ratio(fl(0), "random")).toBeGreaterThan(1.7);
  });
  test("finer size classes lose to power-of-two classes on random sizes", () => {
    const pow2 = ratio({ kind: "sizeclass", cap: 65536, a: 1024, b: 0 }, "random");
    const fine = ratio({ kind: "sizeclass", cap: 65536, a: 1024, b: 1 }, "random");
    expect(fine).toBeGreaterThan(pow2);
  });
  test("bump never reuses memory", () => {
    expect(ratio({ kind: "bump", cap: 1 << 20 }, "random")).toBeGreaterThan(8);
  });
});
