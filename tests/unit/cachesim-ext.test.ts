import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";
import { loadCacheSim, runCache, runWrite, runHier, runPrefetch, runReuse, OUTCOME, COLD } from "@/wasm/cachesim";
import { matmul, WRITE_PATTERNS, PREFETCH_PATTERNS, randomInSet } from "@/sims/memtraces";
import { PATTERNS } from "@/sims/patterns";

type W = Awaited<ReturnType<typeof loadCacheSim>>;
let w: W;
beforeAll(async () => {
  w = await loadCacheSim(() => readFile(new URL("../../public/wasm/cachesim.wasm", import.meta.url)));
});

// Numbers quoted in the Caches lessons. Keep in sync.
describe("locality", () => {
  test("stack distances predict a fully associative LRU cache exactly", () => {
    const addrs = PATTERNS.find((p) => p.id === "random")!.gen({ n: 4096 });
    const d = runReuse(w, addrs, 64);
    for (const lines of [8, 64]) {
      const predicted = d.filter((x) => x !== COLD && x < lines).length;
      const sim = runCache(w, addrs, { size: lines * 64, line: 64, ways: lines, policy: "lru" }).filter((o) => o === OUTCOME.hit).length;
      expect(predicted).toBe(sim);
    }
  });

  const perInner = (order: Parameters<typeof matmul>[1], size: number, tile = 8) => {
    const t = matmul(64, order, tile);
    return runCache(w, t.addrs, { size, line: 64, ways: 8, policy: "lru" }).filter((o) => o !== OUTCOME.hit).length / 64 ** 3;
  };
  test("matmul loop orders at 8 KiB", { timeout: 20000 }, () => {
    expect(perInner("ijk", 8192)).toBeCloseTo(1.04, 1);
    expect(perInner("jki", 8192)).toBeCloseTo(2.02, 1);
    expect(perInner("ikj", 8192)).toBeCloseTo(0.13, 1);
    expect(perInner("tiled", 8192, 8)).toBeLessThan(0.04);
    expect(perInner("tiled", 8192, 16)).toBeGreaterThan(0.12); // tiles too big for the cache
  });
});

describe("write policies (4 KiB, 4-way, 64 B lines)", () => {
  const run = (id: string, wb: boolean, wa: boolean) => {
    const t = WRITE_PATTERNS.find((p) => p.id === id)!.gen();
    const s = runWrite(w, t.addrs, t.writes, { size: 4096, line: 64, ways: 4, writeBack: wb, writeAllocate: wa }).stats;
    return { read: s.memRead, write: s.memWrite + s.dirtyAtEnd * 64 };
  };
  test("memset: write-allocate reads every line first", () => {
    expect(run("memset", true, true)).toEqual({ read: 16384, write: 16384 });
    expect(run("memset", false, false)).toEqual({ read: 0, write: 16384 });
  });
  test("increment: write-back absorbs repeated stores", () => {
    expect(run("increment", true, true)).toEqual({ read: 1024, write: 1024 });
    expect(run("increment", false, true)).toEqual({ read: 1024, write: 20480 });
  });
  test("transpose: write-allocate thrashes", () => {
    const wbwa = run("transpose", true, true);
    expect(wbwa.read).toBeGreaterThan(250_000);
    expect(run("transpose", true, false)).toEqual({ read: 16384, write: 16384 });
  });
});

describe("hierarchy", () => {
  const lat = [4, 12, 200];
  const two = [{ size: 8192, ways: 8 }, { size: 16384, ways: 8 }];
  const memShare = (ws: number, mode: "nine" | "inclusive" | "exclusive", levels = two) => {
    const s = runHier(w, randomInSet(ws, 24000), levels, 64, mode).subarray(8000);
    return s.filter((k) => k === levels.length).length / s.length;
  };
  test("24 KiB working set: exclusive fits in 8 + 16 KiB, inclusive does not", () => {
    expect(memShare(24576, "exclusive")).toBeLessThan(0.12); // set conflicts (8-way) only
    expect(memShare(24576, "inclusive")).toBeGreaterThan(0.25);
    expect(memShare(24576, "nine")).toBeGreaterThan(0.25);
    void lat;
  });
  test("hot set + stream: inclusive back-invalidates hot lines", () => {
    const levels = [{ size: 8192, ways: 8 }, { size: 16384, ways: 8 }, { size: 131072, ways: 16 }];
    const a = new Uint32Array(60000);
    for (let i = 0; i < 30000; i++) { a[2 * i] = (i % 32) * 64; a[2 * i + 1] = (1 << 24) + i * 64; }
    const hotMem = (mode: "nine" | "inclusive" | "exclusive") => {
      const s = runHier(w, a, levels, 64, mode);
      let n = 0, miss = 0;
      for (let i = 4000; i < s.length; i += 2) { n++; if (s[i] !== 0) miss++; }
      return miss / n; // hot accesses that miss L1
    };
    expect(hotMem("inclusive")).toBeGreaterThan(0.05);
    expect(hotMem("nine")).toBe(0);
    expect(hotMem("exclusive")).toBe(0);
  });
});

describe("prefetching (8 KiB, degree 4)", () => {
  const cov = (id: string, kind: "none" | "next-line" | "stride" | "pc-stride", degree = 4) => {
    const t = PREFETCH_PATTERNS.find((p) => p.id === id)!.gen();
    const s = runPrefetch(w, t.addrs, t.pcs, { size: 8192, line: 64, ways: 8, kind, degree }).stats;
    return { coverage: s.covered / (s.covered + s.misses), accuracy: s.issued ? s.covered / s.issued : 0 };
  };
  test("sequential: next-line covers everything", () => expect(cov("sequential", "next-line").coverage).toBeGreaterThan(0.99));
  test("stride: next-line covers it but wastes two thirds; stride is exact", () => {
    expect(cov("stride", "next-line").accuracy).toBeCloseTo(0.33, 1);
    expect(cov("stride", "stride").accuracy).toBeGreaterThan(0.99);
  });
  test("two streams: global stride fails, per-PC stride succeeds", () => {
    expect(cov("two-streams", "stride").coverage).toBe(0);
    expect(cov("two-streams", "pc-stride").coverage).toBeGreaterThan(0.99);
  });
  test("pointer chase defeats every prefetcher", () => {
    for (const k of ["next-line", "stride", "pc-stride"] as const) expect(cov("pointer-chase", k).coverage).toBeLessThan(0.05);
  });
});
