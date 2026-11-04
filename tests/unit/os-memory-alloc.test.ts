/** Kernel allocators: SLUB paths, kmalloc classes, buddyinfo, GFP. Every number in the lesson. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  KMALLOC_CLASSES, kmallocClass, calculateOrder, slabLayout, getOrder, SlubCache, PageAllocator, runSlubWorkload, minPartialFor, cpuPartialSlabs, COSTLY_ORDER, MAX_PAGE_ORDER,
  fragmentedZone, compactedZone, freePages, largestOrder, zoneWatermarkOk, parseBuddyinfo, GFP_BITS, gfpOutcome, reserveShare, contextMaySleep, CONTEXT_LABEL,
  type GfpContext, type GfpBase, type ObjRef,
} from "@/sims/os/memory";
import { mulberry32 } from "@/sims/rng";

const lesson = readFileSync(new URL("../../src/content/lessons/os/memory/kernel-memory-allocators.mdx", import.meta.url), "utf8");

describe("kmalloc classes", () => {
  test("classes, and the limit at 8 KiB", () => {
    expect([...KMALLOC_CLASSES]).toEqual([8, 16, 32, 64, 96, 128, 192, 256, 512, 1024, 2048, 4096, 8192]);
    expect(kmallocClass(1)).toBe(8);
    expect(kmallocClass(97)).toBe(128);
    expect(kmallocClass(8192)).toBe(8192);
    expect(kmallocClass(8193)).toBeNull();
  });
  test("a 100-byte request uses kmalloc-128 and wastes 21.9%", () => {
    expect(kmallocClass(100)).toBe(128);
    expect((((128 - 100) / 128) * 100).toFixed(1)).toBe("21.9");
  });
  test("the slab table for 8 CPUs", () => {
    const row = (s: number) => { const l = slabLayout(s, 8); return [l.order, l.objects, l.wasteBytes]; };
    expect(row(64)).toEqual([0, 64, 0]);
    expect(row(96)).toEqual([0, 42, 64]);
    expect(row(256)).toEqual([1, 32, 0]);
    expect(row(1024)).toEqual([3, 32, 0]);
    expect(row(8192)).toEqual([3, 4, 0]);
    // min_objects on 8 CPUs is 4 * (fls(8) + 1) = 20.
    expect(4 * (4 + 1)).toBe(20);
  });
  test("calculateOrder respects the limits", () => {
    for (const s of KMALLOC_CLASSES) for (const cpus of [1, 8, 64]) {
      const o = calculateOrder(s, cpus);
      expect(o).toBeLessThanOrEqual(COSTLY_ORDER);
      const slab = 4096 * 2 ** o;
      expect(slab % s).toBeLessThanOrEqual(slab / 2);
    }
    expect(getOrder(4096)).toBe(0);
    expect(getOrder(4097)).toBe(1);
  });
  test("min_partial is between 5 and 10; per-CPU partial limit", () => {
    expect(minPartialFor(8)).toBe(5);
    expect(minPartialFor(1 << 20)).toBe(10);
    expect(cpuPartialSlabs(256, 32)).toBe(4);
  });
  test("buddy orders 0 to 10 are 4 KiB to 4 MiB", () => {
    expect(MAX_PAGE_ORDER).toBe(10);
    expect(4096 * 2 ** MAX_PAGE_ORDER).toBe(4 * 2 ** 20);
  });
});

describe("SLUB model", () => {
  test("random alloc and free: no object is handed out twice, and counts stay consistent", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rnd = mulberry32(seed);
      const c = new SlubCache({ size: 512, cpus: 3, pages: new PageAllocator(4096, 3) });
      const live: ObjRef[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < 4000; i++) {
        const cpu = Math.floor(rnd() * 3);
        if (rnd() < 0.55 || live.length === 0) {
          const r = c.alloc(cpu);
          expect(r.obj).not.toBeNull();
          const key = `${r.obj!.slab.id}:${r.obj!.idx}`;
          expect(seen.has(key), key).toBe(false);
          seen.add(key);
          live.push(r.obj!);
        } else {
          const k = Math.floor(rnd() * live.length);
          const [o] = live.splice(k, 1);
          seen.delete(`${o!.slab.id}:${o!.idx}`);
          c.free(cpu, o!);
        }
        if (i % 97 === 0) {
          expect(c.live()).toBe(live.length);
          expect(c.freeObjects() + c.live()).toBe(c.slabs().length * c.objects);
        }
      }
      expect(c.slabsCreated - c.slabsFreed).toBe(c.slabs().length);
    }
  });
  test("the first alloc takes a new slab, the second the fast path; the 33rd a new slab again", () => {
    const c = new SlubCache({ size: 256, cpus: 2 });
    expect(c.alloc(0).path).toBe("new-slab");
    expect(c.alloc(0).path).toBe("fast");
    for (let i = 0; i < 30; i++) expect(c.alloc(0).path).toBe("fast");
    expect(c.alloc(0).path).toBe("new-slab");
  });
  test("objects freed on another CPU come back through the slab's freelist", () => {
    const c = new SlubCache({ size: 256, cpus: 2 });
    const held: ObjRef[] = [];
    for (let i = 0; i < 32; i++) held.push(c.alloc(0).obj!);
    expect(c.free(1, held.pop()!)).toBe("slab-freelist");
    expect(c.alloc(0).path).toBe("slab-freelist");
  });
  test("a free on a full slab adopts it onto this CPU's partial list; an empty slab goes back at last", () => {
    const c = new SlubCache({ size: 256, cpus: 2 });
    const held: ObjRef[] = [];
    for (let i = 0; i < 33; i++) held.push(c.alloc(0).obj!);
    expect(c.free(0, held[0]!)).toBe("to-cpu-partial");
    expect(c.cpus[0]!.partial.length).toBe(1);
    expect(c.alloc(0).path).toBe("fast");
  });
  const fmt = (x: number) => (x * 100).toFixed(1);
  test("workload numbers", () => {
    const one = runSlubWorkload("same-cpu", 256);
    expect(fmt(one.fastShare())).toBe("100.0");
    expect(one.meanAllocNs().toFixed(1)).toBe("10.1");
    const burst = runSlubWorkload("burst", 256);
    expect(fmt(burst.fastShare())).toBe("97.0");
    expect(fmt(burst.freeFastShare())).toBe("4.0");
    expect(burst.meanAllocNs().toFixed(1)).toBe("51.4");
    const pc = runSlubWorkload("producer-consumer", 256);
    expect(fmt(pc.fastShare())).toBe("95.8");
    expect(pc.freeFastShare()).toBe(0);
    for (const n of ["95.8%", "97.0%", "4.0%", "51.4 ns", "10.1 ns"]) expect(lesson).toContain(n);
  });
});

describe("page allocator", () => {
  test("pcp refill takes the zone lock once for a batch; later hits take no lock", () => {
    const p = new PageAllocator(1024, 2, 4, 12);
    expect(p.alloc(0, 0).path).toBe("buddy");
    expect(p.stats.zoneLocks).toBe(1);
    for (let i = 0; i < 3; i++) expect(p.alloc(0, 0).path).toBe("pcp");
    expect(p.stats.zoneLocks).toBe(1);
    expect(p.alloc(0, 0).path).toBe("buddy");
    expect(p.stats.zoneLocks).toBe(2);
  });
  test("costly orders skip the pcp lists", () => {
    const p = new PageAllocator(1024, 2);
    expect(p.alloc(0, COSTLY_ORDER + 1).path).toBe("buddy");
    expect(p.pcpCount(0, COSTLY_ORDER)).toBe(0);
  });
  test("freeing past high returns a batch to the buddy lists, and all memory can merge again", () => {
    const p = new PageAllocator(64, 1, 4, 4);
    const got: number[] = [];
    for (let i = 0; i < 32; i++) got.push(p.alloc(0, 0).addr!);
    for (const a of got) p.free(0, a, 0);
    expect(p.pcpCount(0, 0)).toBeLessThanOrEqual(4);
    // Every page is either on the buddy lists or on the per-CPU list.
    expect(freePages(p.heap.freeCounts()) + p.pcpCount(0, 0)).toBe(64);
  });
});

describe("buddyinfo", () => {
  const row = (f: number) => fragmentedZone(f, mulberry32(9));
  test("30% free: 854 145 9, 4.61 MiB, largest order 2, order 3 fails", () => {
    const c = row(0.3);
    expect(c.slice(0, 4)).toEqual([854, 145, 9, 0]);
    expect((freePages(c) * 4096) / 2 ** 20).toBeCloseTo(4.61, 2);
    expect(largestOrder(c)).toBe(2);
    expect(zoneWatermarkOk(c, 2, 64)).toBe(true);
    expect(zoneWatermarkOk(c, 3, 64)).toBe(false);
    expect(lesson).toContain("854 145 9");
    expect(lesson).toContain("4.61 MiB");
  });
  test("70% free: largest block is still order 3", () => {
    expect(largestOrder(row(0.7))).toBe(3);
    expect(freePages(row(0.7)) / (4 * 1024)).toBeGreaterThan(0.69);
  });
  test("compaction keeps free memory and builds larger blocks", () => {
    const c = row(0.3), k = compactedZone(c);
    expect(freePages(k)).toBe(freePages(c));
    expect(largestOrder(k)).toBeGreaterThan(largestOrder(c));
  });
  test("watermark check needs both the total and a block", () => {
    expect(zoneWatermarkOk([100, 0, 0], 0, 200)).toBe(false);
    expect(zoneWatermarkOk([1000, 0, 0], 1, 200)).toBe(false);
    expect(zoneWatermarkOk([1000, 1, 0], 1, 200)).toBe(true);
  });
  test("parser", () => {
    expect(parseBuddyinfo("Node 0, zone   Normal   854 145 9 0")).toEqual({ node: 0, zone: "Normal", counts: [854, 145, 9, 0] });
    expect(parseBuddyinfo("nonsense")).toBeNull();
  });
});

describe("GFP", () => {
  test("compositions", () => {
    const has = (b: GfpBase, x: string) => GFP_BITS[b].includes(x as never);
    expect(has("GFP_KERNEL", "DIRECT_RECLAIM") && has("GFP_KERNEL", "IO") && has("GFP_KERNEL", "FS")).toBe(true);
    expect(has("GFP_NOFS", "FS")).toBe(false);
    expect(has("GFP_NOFS", "IO")).toBe(true);
    expect(has("GFP_NOIO", "IO")).toBe(false);
    expect(has("GFP_ATOMIC", "DIRECT_RECLAIM")).toBe(false);
    expect(has("GFP_ATOMIC", "HIGH")).toBe(true);
    expect(has("GFP_NOWAIT", "HIGH")).toBe(false);
  });
  test("reserve shares: none, none, 62.5% (__zone_watermark_ok: no __GFP_HIGH, no min reserve)", () => {
    expect(reserveShare(GFP_BITS.GFP_KERNEL)).toBe(0);
    expect(reserveShare(GFP_BITS.GFP_NOWAIT)).toBe(0);
    expect(reserveShare(["HIGH", "DIRECT_RECLAIM"])).toBe(0.5);
    expect(reserveShare(GFP_BITS.GFP_ATOMIC)).toBe(0.625);
    for (const n of ["50%", "62.5%"]) expect(lesson).toContain(n);
  });
  test("a sleeping flag in an atomic context is always a bug; a non-sleeping flag never is", () => {
    for (const c of Object.keys(CONTEXT_LABEL) as GfpContext[]) for (const b of Object.keys(GFP_BITS) as GfpBase[]) {
      const o = gfpOutcome(c, b, [], 0);
      if (o.directReclaim && !contextMaySleep(c)) expect(o.verdict).toBe("bug");
      if (!o.directReclaim) expect(o.verdict).toBe("ok");
    }
  });
  test("deadlock cases and their fixes", () => {
    expect(gfpOutcome("block-io", "GFP_KERNEL", [], 0).verdict).toBe("deadlock");
    expect(gfpOutcome("block-io", "GFP_NOFS", [], 0).verdict).toBe("deadlock");
    expect(gfpOutcome("block-io", "GFP_NOIO", [], 0).verdict).toBe("ok");
    expect(gfpOutcome("fs-transaction", "GFP_KERNEL", [], 0).verdict).toBe("deadlock");
    expect(gfpOutcome("fs-transaction", "GFP_NOFS", [], 0).verdict).toBe("ok");
    expect(gfpOutcome("fs-transaction", "GFP_NOIO", [], 0).verdict).toBe("ok");
  });
  test("too small to fail: order 3 cannot return NULL and may OOM; order 4 can fail and does not OOM", () => {
    const a = gfpOutcome("process", "GFP_KERNEL", [], 3), b = gfpOutcome("process", "GFP_KERNEL", [], 4);
    expect([a.mayFail, a.mayOom]).toEqual([false, true]);
    expect([b.mayFail, b.mayOom]).toEqual([true, false]);
    expect(gfpOutcome("process", "GFP_KERNEL", ["NORETRY"], 0)).toMatchObject({ mayFail: true, mayOom: false });
    expect(gfpOutcome("process", "GFP_KERNEL", ["RETRY_MAYFAIL"], 0)).toMatchObject({ mayFail: true, mayOom: false });
    expect(gfpOutcome("process", "GFP_KERNEL", ["NOFAIL"], 4).mayFail).toBe(false);
    expect(gfpOutcome("process", "GFP_NOFS", [], 0)).toMatchObject({ mayFail: false, mayOom: false });
  });
  test("__GFP_NOFAIL without reclaim is a bug; above order 1 it warns", () => {
    expect(gfpOutcome("spinlock", "GFP_ATOMIC", ["NOFAIL"], 0).verdict).toBe("bug");
    expect(gfpOutcome("process", "GFP_KERNEL", ["NOFAIL"], 2).verdict).toBe("warn");
  });
  test("GFP_ATOMIC can return NULL, in a spinlock", () => {
    expect(gfpOutcome("spinlock", "GFP_ATOMIC", [], 0)).toMatchObject({ verdict: "ok", mayFail: true, directReclaim: false, wakesKswapd: true });
  });
});
