import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";
import { Heap, loadHeapSim, extFrag, type HeapConfig, type HeapSim } from "@/wasm/heapsim";
import {
  alignUp, bumpRun, structLayout, fieldsOf, ArenaSim, frameLoop, chunkWaste, poolGeometry, PoolSim,
  protectPtr, revealPtr, passesAlignCheck, forgedPassRate, FreeListSim, presetHeap, blockNeed,
  headerWord, headerSize, headerAllocated,
} from "@/sims/allocextrasA";

let w: HeapSim;
beforeAll(async () => {
  w = await loadHeapSim(() => readFile(new URL("../../public/wasm/heapsim.wasm", import.meta.url)));
});
const withHeap = <T,>(cfg: HeapConfig, f: (h: Heap) => T): T => {
  const h = new Heap(w, cfg);
  try { return f(h); } finally { h.dispose(); }
};

// Numbers quoted in systems/allocators/{bump-allocators,arena-allocators,pool-allocators,free-lists}.mdx.

describe("bump allocators", () => {
  test("align_up", () => {
    expect(alignUp(17, 8)).toBe(24);
    expect(alignUp(24, 8)).toBe(24);
    for (let x = 0; x < 64; x++) for (const a of [1, 2, 4, 8, 16]) {
      const p = alignUp(x, a) - x;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(a - 1);
    }
  });
  test("top at 1, alloc(8, align 8): 7 bytes of padding, block at 8", () => {
    const r = bumpRun([{ size: 8, align: 8 }], 1);
    expect(r.blocks[0]).toMatchObject({ addr: 8, pad: 7 });
    expect(r.top).toBe(16);
  });
  test("char,double,char,double: 32 bytes, 14 padding; sorted: 18 data + 6 tail = 24", () => {
    const f = fieldsOf(["char", "double", "char", "double"]);
    const c = structLayout(f);
    expect(c).toMatchObject({ size: 32, data: 18, pad: 14, tail: 0 });
    const r = structLayout(f, true);
    expect(r).toMatchObject({ size: 24, data: 18, pad: 0, tail: 6 });
  });
  test("{double; char} is 16 bytes", () => {
    expect(structLayout(fieldsOf(["double", "char"])).size).toBe(16);
  });
  test("char,int,char,short,ptr: 24 bytes, sorted 16", () => {
    const f = fieldsOf(["char", "int", "char", "short", "ptr"]);
    expect(structLayout(f)).toMatchObject({ size: 24, pad: 8 });
    expect(structLayout(f, true).size).toBe(16);
  });
  test("heapsim bump agrees: 14 padding, then 0", () => {
    withHeap({ kind: "bump", cap: 1024 }, (h) => {
      [[1, 1], [8, 8], [1, 1], [8, 8]].forEach(([s, a]) => h.alloc(s!, a!));
      expect(h.stats()).toMatchObject({ live: 18, pad: 14 });
      h.reset();
      [[8, 8], [8, 8], [1, 1], [1, 1]].forEach(([s, a]) => h.alloc(s!, a!));
      expect(h.stats().pad).toBe(0);
    });
  });
});

describe("arena allocators", () => {
  test("256 B chunks, 3 x 100 B: 240 usable, 40 B abandoned, 32 B headers", () => {
    const a = new ArenaSim(256);
    expect([a.alloc(100), a.alloc(100), a.alloc(100)]).toEqual([0, 0, 1]);
    expect(a.slack).toBe(40);
    expect(a.headers).toBe(32);
    withHeap({ kind: "arena", cap: 2048, a: 256 }, (h) => {
      for (let i = 0; i < 3; i++) h.alloc(100, 1);
      expect(h.stats()).toMatchObject({ meta: 32, slack: 40 });
    });
  });
  test("500 B with 256 B chunks gets a dedicated 768 B chunk", () => {
    const a = new ArenaSim(256);
    a.alloc(500);
    expect(a.chunks).toEqual([{ len: 768, used: 516 }]);
    withHeap({ kind: "arena", cap: 2048, a: 256 }, (h) => {
      h.alloc(500, 1);
      expect(h.stats().meta + h.stats().live + h.stats().free).toBe(2048);
    });
  });
  test("frame loop, 20 objects per frame, 16 frames", () => {
    const base = { frames: 16, perFrame: 20, chunk: 1024 };
    const every = frameLoop({ ...base, resetEvery: 1 });
    const never = frameLoop({ ...base, resetEvery: 0 });
    const dropped = frameLoop({ ...base, resetEvery: 1, keepChunks: false });
    // Reset every frame: two chunks, and no backing call after frame 2.
    expect(every.at(-1)!.reserved).toBe(2048);
    expect(every.at(-1)!.backingCalls).toBe(2);
    expect(every[1]!.backingCalls).toBe(2);
    // Never reset: memory grows every frame.
    expect(never.at(-1)!.reserved).toBe(18432);
    for (let i = 1; i < never.length; i++) expect(never[i]!.reserved).toBeGreaterThan(never[i - 1]!.reserved - 1);
    // Reset every 4 frames: 5 KiB held, a higher high-water mark.
    expect(frameLoop({ ...base, resetEvery: 4 }).at(-1)!.reserved).toBe(5120);
    // Give the chunks back on reset: new backing calls in every frame.
    expect(dropped.at(-1)!.backingCalls).toBe(26);
    // 320 free() calls with malloc, 16 resets with the arena.
    expect(every.at(-1)!.mallocFrees).toBe(320);
  });
  test("tail waste follows (h + s/2) / C when chunks are large", () => {
    const x = chunkWaste(4096, 64);
    expect(x.wasteFrac).toBeCloseTo(0.014, 3);
    expect(x.estimate).toBeCloseTo(0.012, 3);
    expect(chunkWaste(256, 64).wasteFrac).toBeCloseTo(0.22, 2);
  });
});

describe("pool allocators", () => {
  test("LIFO: alloc A, B, C, free A, free C, next alloc returns C's slot", () => {
    const p = new PoolSim(8);
    const a = p.alloc()!, b = p.alloc()!, c = p.alloc()!;
    expect([a.index, b.index, c.index]).toEqual([0, 1, 2]);
    p.free(a.index);
    p.free(c.index);
    expect(p.freeOrder().slice(0, 3)).toEqual([2, 0, 3]);
    expect(p.alloc()!.index).toBe(2);
  });
  test("demo walk: C (2, 0) is rejected after D takes slot 2 at generation 1", () => {
    const p = new PoolSim(8);
    const a = p.alloc()!; p.alloc(); const c = p.alloc()!;
    expect(p.head).toBe(3);
    p.free(a.index); p.free(c.index);
    const d = p.alloc()!;
    expect(d).toEqual({ index: 2, gen: 1, name: "D" });
    expect(p.valid(c)).toBe(false);
    expect(p.owner[2]).toBe("D");
  });
  test("generational handle is rejected after reuse", () => {
    const p = new PoolSim(4);
    const a = p.alloc()!;
    p.free(a.index);
    const b = p.alloc()!;
    expect(b.index).toBe(a.index);
    expect(p.valid(a)).toBe(false);
    expect(p.valid(b)).toBe(true);
    expect(b.gen).toBe(1);
  });
  test("48 B slots in 1 KiB: 21 slots, 16 B left over, 16-byte alignment", () => {
    expect(poolGeometry(1024, 48)).toEqual({ slots: 21, leftover: 16, align: 16 });
    expect(poolGeometry(1024, 64)).toEqual({ slots: 16, leftover: 0, align: 64 });
    withHeap({ kind: "pool", cap: 1024, a: 48 }, (h) => {
      expect(h.alloc(8, 32)).toBeNull();
      expect(h.alloc(8, 16)).toBe(0);
    });
  });
  test("10 B from a 64 B slot leaves 54 B of slack", () => {
    withHeap({ kind: "pool", cap: 1024, a: 64 }, (h) => {
      h.alloc(10, 8);
      expect(h.stats().slack).toBe(54);
    });
  });
  test("safe-linking round trip; a raw forged pointer passes about 1 time in 16", () => {
    const pos = 0x55555555a2c0n, next = 0x55555555a300n;
    expect(revealPtr(pos, protectPtr(pos, next))).toBe(next);
    expect(passesAlignCheck(revealPtr(pos, 0x7ffff7dd1b20n))).toBe(false);
    const r = forgedPassRate(0x7ffff7dd1b20n);
    expect(r).toBeGreaterThan(0.05);
    expect(r).toBeLessThan(0.075);
  });
});

describe("free lists", () => {
  test("14 x 120 B in 2 KiB, free all, no coalescing: about 1.9 KiB free, largest 248 B, 1 KiB fails", () => {
    const f = new FreeListSim(2048, "first", false);
    const xs = Array.from({ length: 14 }, () => f.alloc(120)!);
    xs.forEach((x) => f.freeAddr(x));
    expect(f.stats()).toMatchObject({ freeBytes: 1928, largest: 248 });
    expect(f.alloc(1024)).toBeNull();
    withHeap({ kind: "freelist", cap: 2048, a: 0, b: 0 }, (h) => {
      const ys = Array.from({ length: 14 }, () => h.alloc(120, 8)!);
      ys.forEach((y) => h.free(y));
      expect(h.stats()).toMatchObject({ free: 1928, largestFree: 248 });
      expect(h.alloc(1024, 8)).toBeNull();
    });
    // With coalescing, the same frees give one block again.
    const g = new FreeListSim(2048, "first", true);
    Array.from({ length: 14 }, () => g.alloc(120)!).forEach((x) => g.freeAddr(x));
    expect(g.stats().freeBlocks).toBe(1);
    expect(g.alloc(1024)).not.toBeNull();
  });
  test("swiss cheese: fragmentation above 50%, 200 B fails", () => {
    withHeap({ kind: "freelist", cap: 2048, a: 0, b: 1 }, (h) => {
      const big: number[] = [];
      for (let i = 0; i < 200; i++) {
        const x = h.alloc(i % 2 ? 40 : 100, 8);
        if (x === null) break;
        if (i % 2 === 0) big.push(x);
      }
      big.forEach((x) => h.free(x));
      const s = h.stats();
      expect(extFrag(s)).toBeGreaterThan(0.5);
      expect(s.free).toBeGreaterThan(200);
      expect(h.alloc(200, 8)).toBeNull();
    });
  });
  test("1 B costs a 16 B block", () => {
    expect(blockNeed(1)).toBe(16);
    expect(blockNeed(120)).toBe(128);
    withHeap({ kind: "freelist", cap: 1024, a: 0, b: 1 }, (h) => {
      h.alloc(1, 8);
      // The first region is the 8 B header; the block ends where the free remainder's header starts.
      const r = h.regions();
      expect(r[0]).toMatchObject({ off: 0, len: 8 });
      expect(r.find((x) => x.off >= 8 && x.len === 8 && x.kind === 1)!.off).toBe(16);
    });
  });
  test("preset heap, 40 B request: first fit walks 2 blocks, best fit walks 10", () => {
    const h = presetHeap();
    expect(h.blocks.filter((b) => b.free).map((b) => b.size)).toEqual([104, 168, 80, 120, 304]);
    const first = h.search(40, "first"), best = h.search(40, "best"), worst = h.search(40, "worst");
    expect(first).toMatchObject({ examined: 2, freeExamined: 1 });
    expect(h.blocks[first.chosen]!.size).toBe(104);
    expect(best).toMatchObject({ examined: 10, freeExamined: 5 });
    expect(h.blocks[best.chosen]!.size).toBe(80);
    expect(h.blocks[worst.chosen]!.size).toBe(304);
  });
  test("next fit starts at the rover", () => {
    const h = presetHeap("next");
    h.alloc(40); // takes the 104 B block, rover moves past it
    const t = h.search(40);
    expect(h.blocks[t.chosen]!.size).toBe(56);
    expect(h.search(40, "first").chosen).toBe(t.chosen);
    h.alloc(40);
    expect(h.blocks[h.search(40).chosen]!.size).toBe(168);
  });
  test("header word packs the flag into bit 0", () => {
    expect(headerWord(48, true)).toBe(49);
    expect(headerSize(49)).toBe(48);
    expect(headerAllocated(49)).toBe(true);
    expect(headerAllocated(headerWord(48, false))).toBe(false);
  });
});
