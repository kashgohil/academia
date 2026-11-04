/** Pins every number that the buddy, slab, fragmentation and general-purpose allocator lessons quote. */
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";
import {
  BuddyHeap, linuxOrderBytes, sizeClasses, spacingStats, SlabCache, slabDemo, slabPingPong, slabFit,
  FragHeap, checkerboard, fillWith, mallocTrace, runMallocModel, TIER_COST, PAGE, LARGE, OS_CHUNK_PAGES,
} from "@/sims/allocextrasB";
import { mulberry32 } from "@/sims/rng";
import { Heap, loadHeapSim, REGION, type HeapConfig, type HeapSim } from "@/wasm/heapsim";
import { TRACES } from "@/sims/traces";
import { replay } from "@/sims/replay";

describe("buddy lesson", () => {
  test("1 KiB heap, 16 B minimum: orders 0..6, at most 6 merge steps", () => {
    const h = new BuddyHeap(1024, 16);
    expect(h.maxOrder).toBe(6);
    expect(Math.log2(1024 / 16)).toBe(6);
  });
  test("alloc(33): 4 splits, a 64 B block, free 512/256/128/64, 31 B wasted", () => {
    const h = new BuddyHeap();
    const r = h.alloc(33);
    expect(r.off).toBe(0);
    expect(r.events.filter((e) => e.kind === "split").length).toBe(4);
    expect(h.freeCounts()).toEqual([0, 0, 1, 1, 1, 1, 0]);
    expect(h.stats().internal).toBe(31);
  });
  test("second alloc(33) takes the buddy at 0x040 with no split; free stops, then 4 merges", () => {
    const h = new BuddyHeap();
    h.alloc(33);
    const b = h.alloc(33);
    expect(b.off).toBe(0x40);
    expect(b.events.map((e) => e.kind)).toEqual(["take"]);
    const f1 = h.free(0x40);
    expect(f1.events).toEqual([{ kind: "stop", off: 0x40, size: 64, other: 0 }]);
    const f2 = h.free(0);
    expect(f2.events.map((e) => e.kind)).toEqual(["merge", "merge", "merge", "merge"]);
    expect(h.freeCounts()[6]).toBe(1);
  });
  test("129 B takes 256 B; 16 B then 513 B fails; four 100 B merge back only at the last free", () => {
    const h = new BuddyHeap();
    expect(h.sizeOf(h.orderFor(129))).toBe(256);
    h.alloc(16);
    expect(h.alloc(513).off).toBeNull();
    h.reset();
    const xs = [0, 1, 2, 3].map(() => h.alloc(100).off!);
    expect(xs).toEqual([0, 128, 256, 384]);
    xs.forEach((x, i) => { h.free(x); expect(h.stats().largestFree === 1024).toBe(i === 3); });
  });
  test("Linux orders 0..10: 4 KiB to 4 MiB", () => {
    expect(linuxOrderBytes(0)).toBe(4096);
    expect(linuxOrderBytes(10)).toBe(4 * 1024 * 1024);
  });
  test("power-of-two rounding: worst case just under 50% (49.95%), average 25%", () => {
    const s = spacingStats(1);
    expect((s.worst * 100).toFixed(2)).toBe("49.95");
    expect(s.worst).toBeLessThan(0.5);
    expect(s.worstAt).toBe(1025);
    expect(Math.round(s.avg * 100)).toBe(25);
  });
});

describe("slab lesson", () => {
  test("ping-pong: 10 page grabs without an empty slab in reserve, 1 with", () => {
    expect(slabPingPong(10, 0)).toBe(10);
    expect(slabPingPong(10, 1)).toBe(1);
  });
  test("demo caches: 512, 640, 1024 B give 8, 6, 4 objects per 4 KiB slab; 640 B leaves 256 B", () => {
    expect([512, 640, 1024].map((o) => slabFit(o).perSlab)).toEqual([8, 6, 4]);
    expect(slabFit(640).leftover).toBe(256);
  });
  test("12 → 40 → 20 live objects: 22 slabs, all partial, no page goes back", () => {
    const d = slabDemo(false);
    for (const t of [12, 40, 20]) d.forEach((c) => c.cache.setLive(t, c.rng));
    const cs = d.map((c) => c.cache);
    // Moving the slider one step at a time gives the same result.
    const d2 = slabDemo(false);
    for (let t = 12; t <= 40; t++) d2.forEach((c) => c.cache.setLive(t, c.rng));
    for (let t = 39; t >= 20; t--) d2.forEach((c) => c.cache.setLive(t, c.rng));
    expect(d2.map((c) => c.cache.slabs.map((s) => s.live.join()))).toEqual(cs.map((c) => c.slabs.map((s) => s.live.join())));
    const slabs = cs.reduce((n, c) => n + c.slabs.length, 0);
    const partial = cs.reduce((n, c) => n + c.lists().partial.length, 0);
    expect(slabs).toBe(22);
    expect(partial).toBe(22);
    expect(cs.reduce((n, c) => n + c.pagesReturned, 0)).toBe(0);
  });
  test("to 0 frees every page; with keep-one, one empty slab stays per cache; constructors run per slab", () => {
    for (const keep of [0, 1]) {
      const d = slabDemo(keep === 1);
      for (const t of [12, 40, 0]) d.forEach((c) => c.cache.setLive(t, c.rng));
      d.forEach((c) => expect(c.cache.slabs.length).toBe(keep));
    }
    const c = new SlabCache(512, 4096, 1);
    const r = mulberry32(1);
    for (let i = 0; i < 10; i++) { c.setLive(30, r); c.setLive(20, r); }
    expect(c.allocs).toBeGreaterThan(100);
    expect(c.ctorCalls).toBe(c.pagesTaken * 8);
    expect(c.ctorCalls).toBeLessThan(c.allocs / 2);
  });
  test("slab fit: 700 B → 5 per page, 596 B (14.6%); 4 pages → 23, 1.7%; 192 B → 21, 64 B (1.6%), 2 colors", () => {
    const a = slabFit(700, 1), b = slabFit(700, 4), c = slabFit(192, 1);
    expect([a.perSlab, a.leftover, +(a.waste * 100).toFixed(1)]).toEqual([5, 596, 14.6]);
    expect([b.perSlab, +(b.waste * 100).toFixed(1)]).toEqual([23, 1.7]);
    expect([c.perSlab, c.leftover, +(c.waste * 100).toFixed(1), c.colors]).toEqual([21, 64, 1.6, 2]);
  });
});

describe("fragmentation explorer", () => {
  test("checkerboard: 16 × 64 B, free every second: 512 B free, largest 64 B, 87.5% external, in both modes", () => {
    for (const m of ["exact", "buddy"] as const) {
      const h = new FragHeap(m);
      expect(checkerboard(h)).toBe(16);
      const s = h.stats();
      expect([s.free, s.largestFree, s.external]).toEqual([512, 64, 0.875]);
      expect(h.alloc(128)).toBeNull();
    }
  });
  test("freeing a live block between two free blocks merges them into 192 B (exact mode)", () => {
    const h = new FragHeap("exact");
    checkerboard(h);
    h.free(64);
    expect(h.stats().largestFree).toBe(192);
  });
  test("fill with 65 B: exact fits 14 (9.7% internal), buddy fits 8 (49.2% internal)", () => {
    const e = new FragHeap("exact"), b = new FragHeap("buddy");
    expect(fillWith(e, 65)).toBe(14);
    expect(+(e.stats().internalFrac * 100).toFixed(1)).toBe(9.7);
    expect(fillWith(b, 65)).toBe(8);
    expect(+(b.stats().internalFrac * 100).toFixed(1)).toBe(49.2);
  });
});

describe("size-class spacing", () => {
  test("4 per doubling: 19.92% worst, 7.9% average, 16 classes in 129 B–2 KiB; 8 per doubling: 11.02%, 32 classes; pow2: 4", () => {
    const s4 = spacingStats(4), s8 = spacingStats(8), s1 = spacingStats(1);
    expect((s4.worst * 100).toFixed(2)).toBe("19.92");
    expect(s4.worstAt).toBe(1025);
    expect(+(s4.avg * 100).toFixed(1)).toBe(7.9);
    expect(s4.classesInRange).toBe(16);
    expect((s8.worst * 100).toFixed(2)).toBe("11.02");
    expect(s8.classesInRange).toBe(32);
    expect(s1.classesInRange).toBe(4);
  });
  test("jemalloc-like classes start 16, 32, 48, … and then 4 per doubling", () => {
    expect(sizeClasses(4, 512)).toEqual([16, 32, 48, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512]);
  });
});

describe("malloc path model", () => {
  const run = (w: Parameters<typeof mallocTrace>[0], cap: number) => runMallocModel(mallocTrace(w), cap);
  test("model constants", () => {
    expect([...TIER_COST]).toEqual([1, 10, 100, 1000]);
    expect([PAGE, LARGE, OS_CHUNK_PAGES * PAGE]).toEqual([8192, 32768, 1 << 20]);
  });
  test("steady churn: 99.1% in the thread cache at 32, 84.8% at 4; average cost 1.70 vs 10.62 with no cache", () => {
    const r32 = run("steady", 32), r4 = run("steady", 4), r0 = run("steady", 0);
    expect(r32.steps.length).toBe(3200);
    expect(+(r32.fastShare * 100).toFixed(1)).toBe(99.1);
    expect(+(r4.fastShare * 100).toFixed(1)).toBe(84.8);
    expect(r32.avgCost.toFixed(2)).toBe("1.70");
    expect(r0.avgCost.toFixed(2)).toBe("10.62");
    expect(r0.fastShare).toBe(0);
    expect(r32.counts[1]).toBe(17);
  });
  test("producer/consumer: 94.2% fast, 160 lock trips in 3000 operations", () => {
    const r = run("prodcons", 32);
    expect(r.steps.length).toBe(3000);
    expect(+(r.fastShare * 100).toFixed(1)).toBe(94.2);
    expect(r.counts[1]).toBe(160);
  });
  test("large objects never use the thread cache", () => {
    for (const cap of [0, 32, 64]) {
      const r = run("large", cap);
      expect(r.counts[0] + r.counts[1]).toBe(0);
      expect(r.counts[3]).toBeGreaterThan(0);
    }
  });
});

describe("replay numbers quoted in the fragmentation and general-purpose lessons", () => {
  let w: HeapSim;
  beforeAll(async () => {
    w = await loadHeapSim(() => readFile(new URL("../../public/wasm/heapsim.wasm", import.meta.url)));
  });
  const ratio = (cfg: HeapConfig, trace: string) => {
    const r = replay(w, cfg, TRACES.find((t) => t.id === trace)!.ops);
    expect(r.failed).toBe(0);
    return r.peakFootprint / r.peakLive;
  };
  const fl = (a: number, b = 1): HeapConfig => ({ kind: "freelist", cap: 65536, a, b });
  test("random trace: best 1.09, first 1.16, first without coalescing 2.23, next and worst above 3", () => {
    expect(ratio(fl(2), "random").toFixed(2)).toBe("1.09");
    expect(ratio(fl(0), "random").toFixed(2)).toBe("1.16");
    expect(ratio(fl(0, 0), "random").toFixed(2)).toBe("2.23");
    expect(ratio(fl(1), "random")).toBeGreaterThan(3);
    expect(ratio(fl(3), "random")).toBeGreaterThan(3);
  });
  test("growing buffers: buddy does as well as best fit", () => {
    expect(ratio({ kind: "buddy", cap: 65536 }, "growing")).toBeLessThanOrEqual(ratio(fl(2), "growing"));
  });
  test("size classes on the random trace: fine 1.67, powers of two 1.48", () => {
    expect(ratio({ kind: "sizeclass", cap: 65536, a: 1024, b: 1 }, "random").toFixed(2)).toBe("1.67");
    expect(ratio({ kind: "sizeclass", cap: 65536, a: 1024, b: 0 }, "random").toFixed(2)).toBe("1.48");
  });
  test("size-class demo: 33 B rounds to 64 or 48; 3000 B takes 3 pages of 1 KiB", () => {
    for (const [b, cls] of [[0, 64], [1, 48]] as const) {
      const h = new Heap(w, { kind: "sizeclass", cap: 16384, a: 1024, b });
      try {
        const objSlack = () => {
          const rs = h.regions();
          const i = rs.findIndex((r) => r.kind === REGION.live);
          return rs[i]!.len + (rs[i + 1]?.kind === REGION.slack ? rs[i + 1]!.len : 0);
        };
        h.alloc(33, 8);
        expect(objSlack()).toBe(cls);
        h.reset();
        h.alloc(3000, 8);
        expect(objSlack()).toBe(3 * 1024);
      } finally { h.dispose(); }
    }
  });
});
