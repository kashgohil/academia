import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";
import { loadCacheSim, runCache, OUTCOME } from "@/wasm/cachesim";
import { PATTERNS } from "@/sims/patterns";

type W = Awaited<ReturnType<typeof loadCacheSim>>;
let w: W;
beforeAll(async () => {
  w = await loadCacheSim(() => readFile(new URL("../../public/wasm/cachesim.wasm", import.meta.url)));
});

const gen = (id: string, n = 4096) => PATTERNS.find((p) => p.id === id)!.gen({ n });
const rate = (o: Uint8Array) => o.filter((b) => b === OUTCOME.hit).length / o.length;
const count = (o: Uint8Array, k: number) => o.filter((b) => b === k).length;

// These numbers are quoted in the cache lesson; keep them in sync.
describe("cachesim (wasm) matches the lesson's claims", () => {
  test("row-major: 1 compulsory miss per 16 accesses", () => {
    const o = runCache(w, gen("row-major"), { size: 4096, line: 64, ways: 1, policy: "lru" });
    expect(count(o, OUTCOME.compulsory)).toBe(256);
    expect(rate(o)).toBeCloseTo(0.9375, 4);
  });
  test("column-major thrashes direct-mapped via conflicts, fine when fully associative", () => {
    const dm = runCache(w, gen("col-major"), { size: 4096, line: 64, ways: 1, policy: "lru" });
    expect(rate(dm)).toBe(0);
    expect(count(dm, OUTCOME.conflict)).toBe(3840);
    const fa = runCache(w, gen("col-major"), { size: 4096, line: 64, ways: 64, policy: "lru" });
    expect(rate(fa)).toBeCloseTo(0.9375, 4);
  });
  test("cyclic loop over 96 lines: LRU 0%, random beats it", () => {
    const cfg = { size: 4096, line: 64, ways: 64 } as const;
    const lru = runCache(w, gen("loop-lines"), { ...cfg, policy: "lru" });
    const rnd = runCache(w, gen("loop-lines"), { ...cfg, policy: "random" });
    const dm = runCache(w, gen("loop-lines"), { ...cfg, ways: 1, policy: "lru" });
    expect(rate(lru)).toBe(0);
    expect(rate(rnd)).toBeGreaterThan(0.3);
    expect(rate(dm)).toBeGreaterThan(0.3);
  });
  test("ping-pong conflicts are fixed by 2 ways", () => {
    const dm = runCache(w, gen("ping-pong"), { size: 4096, line: 64, ways: 1, policy: "lru" });
    const two = runCache(w, gen("ping-pong"), { size: 4096, line: 64, ways: 2, policy: "lru" });
    expect(rate(dm)).toBe(0);
    expect(rate(two)).toBeCloseTo(0.9375, 4);
  });
  test("large inputs survive memory growth", () => {
    const o = runCache(w, gen("random", 200_000), { size: 32768, line: 64, ways: 8, policy: "lru" });
    expect(o.length).toBe(200_000);
  });
});
