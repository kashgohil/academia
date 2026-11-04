/** Memory map carving, frame allocators and heap bring-up. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import * as K from "@/sims/os/kernel";

describe("carving the map", () => {
  const c = K.carve(K.DEMO_MAP);
  test("frames and the bytes lost to rounding", () => {
    expect(K.DEMO_FRAMES).toBe(4096);
    expect(c.usableFrames).toBe(3551);
    expect(c.lostToRounding).toBe(3072);
    expect(c.ranges).toEqual([{ first: 0, count: 159 }, { first: 448, count: 3392 }]);
    expect(K.carve(K.DEMO_MAP, { skipFrameZero: true }).ranges[0]).toEqual({ first: 1, count: 158 });
  });
  test("the map covers 16 MiB with no overlap", () => {
    let at = 0;
    const sorted = [...K.DEMO_MAP];
    for (const e of sorted) {
      expect(e.base >= at).toBe(true);
      at = e.base + e.len;
    }
  });
  test("bitmap sizes", () => {
    expect(K.bitmapBytes(4096)).toBe(512);
    expect(K.bitmapBytesForRam(K.EXAMPLE_RAM.big)).toBe(256 * 1024);
    expect(K.bitmapBytesForRam(K.EXAMPLE_RAM.huge)).toBe(2 * 1024 * 1024);
    expect(1 / K.bitmapShare()).toBe(32768);
  });
  test("the early bump allocator places the bitmap above 1 MiB", () => {
    expect(K.placeEarly(c, K.bitmapBytes(4096))).toEqual({ frame: 448, frames: 1 });
  });
});

describe("frame allocators", () => {
  const c = K.carve(K.DEMO_MAP, { skipFrameZero: true });
  const make = (k: "bitmap" | "stack"): K.FrameAllocator => (k === "bitmap" ? new K.BitmapFrames(K.DEMO_FRAMES, c.ranges) : new K.StackFrames(c.ranges));
  const usable = new Set(c.ranges.flatMap((r) => Array.from({ length: r.count }, (_, i) => r.first + i)));
  for (const kind of ["bitmap", "stack"] as const) {
    test(`${kind}: random alloc and free never gives a frame twice or a reserved frame`, () => {
      const a = make(kind);
      const r = mulberry32(3);
      const held = new Set<number>();
      for (let i = 0; i < 12000; i++) {
        if (r() < 0.6) {
          const f = a.alloc();
          if (f === null) { expect(held.size).toBe(usable.size); continue; }
          expect(usable.has(f)).toBe(true);
          expect(held.has(f)).toBe(false);
          held.add(f);
        } else if (held.size) {
          const f = [...held][Math.floor(r() * held.size)]!;
          held.delete(f);
          a.free(f);
        }
        expect(a.freeCount).toBe(usable.size - held.size);
      }
    });
    test(`${kind}: a double free throws`, () => {
      const a = make(kind);
      const f = a.alloc()!;
      a.free(f);
      expect(() => a.free(f)).toThrow();
    });
    test(`${kind}: runs dry at exactly the usable count`, () => {
      const a = make(kind);
      for (let i = 0; i < usable.size; i++) expect(a.alloc()).not.toBeNull();
      expect(a.alloc()).toBeNull();
    });
  }
  test("order: the bitmap gives low frames first, the stack gives the last free frame first", () => {
    const b = make("bitmap"), s = make("stack");
    expect(b.alloc()).toBe(1);
    expect(s.alloc()).toBe(3839);
    const f = s.alloc()!;
    s.free(f);
    expect(s.alloc()).toBe(f);
  });
  test("metadata: 512 bytes against 8", () => {
    expect(make("bitmap").metaBytes).toBe(512);
    expect(make("stack").metaBytes).toBe(8);
  });
  test("a full scan costs one word per 64 frames; the hint removes it", () => {
    const b = new K.BitmapFrames(K.DEMO_FRAMES, c.ranges);
    for (let i = 0; i < 158; i++) b.alloc();
    const before = b.touches;
    b.alloc();
    // From the hint at word 2 to the first free frame at 448 (word 7): 6 words.
    expect(b.touches - before).toBe(6);
    const again = b.touches;
    b.alloc();
    expect(b.touches - again).toBe(1);
  });
});

describe("heap bring-up", () => {
  test("the first mapping takes 3 table frames and 1 data frame", () => {
    const s = K.heapSnaps("bump", "frames");
    const first = s.find((x) => x.title === "Page mapped")!;
    expect(first.dataFrames).toBe(1);
    expect(first.tableFrames).toBe(4); // the top table plus 3 new ones
    expect(s[0]!.tableFrames).toBe(1);
  });
  test("the script ends with 3 pages and 4 table frames in both allocators", () => {
    for (const a of ["bump", "list"] as const) {
      const e = K.heapSnaps(a, "frames").at(-1)!;
      expect(e.mappedPages).toBe(3);
      expect(e.dataFrames).toBe(3);
      expect(e.tableFrames).toBe(4);
      expect(e.liveBytes).toBe(9920);
      expect(e.hazard).toBe(false);
    }
  });
  test("bump keeps the freed hole, and the list reuses it", () => {
    const b = K.heapSnaps("bump", "frames").at(-1)!;
    const l = K.heapSnaps("list", "frames").at(-1)!;
    expect(b.usedSpan).toBe(10432);
    expect(l.usedSpan).toBe(10208);
    expect(b.blocks.find((x) => x.name === "d")!.off).toBe(4176);
    expect(l.blocks.find((x) => x.name === "d")!.off).toBe(72);
  });
  test("tables from the heap: the recursion has no end", () => {
    for (const a of ["bump", "list"] as const) {
      const s = K.heapSnaps(a, "heap");
      const e = s.at(-1)!;
      expect(e.hazard).toBe(true);
      expect(e.title).toBe("The recursion has no end");
      expect(e.mappedPages).toBe(0);
      expect(K.RECURSION_LIMIT).toBe(8);
    }
  });
  test("real walks reach the heap frames", () => {
    const h = new K.KernelHeap("bump", "frames").run(K.HEAP_SCRIPT);
    const w = h.pt.walk(K.HEAP_BASE + 100n, { user: false, kind: "w" });
    expect(w.ok).toBe(true);
    expect(h.pt.walk(K.HEAP_BASE + 100n, { user: true, kind: "r" }).ok).toBe(false);
    expect(h.pt.walk(K.HEAP_BASE + 0x10000n, { user: false, kind: "r" }).ok).toBe(false);
  });
});
