import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";
import { loadCacheSim } from "@/wasm/cachesim";
import { evaluate, PATTERNS, ENTITY_LAYOUTS, layoutTrace, LADDER, randomAccessLatency } from "@/sims/perf/memory";

type W = Awaited<ReturnType<typeof loadCacheSim>>;
let w: W;
beforeAll(async () => { w = await loadCacheSim(() => readFile(new URL("../../public/wasm/cachesim.wasm", import.meta.url))); });

const pat = (id: string, n: number) => { const p = PATTERNS.find((x) => x.id === id)!; return evaluate(w, p.gen(n), n, p.random).nsPerElem; };

// Numbers quoted in the memory-hierarchy lessons.
describe("memory hierarchy", { timeout: 60000 }, () => {
  test("random-access latency staircase spans L1 to DRAM", () => {
    const at = (bytes: number) => randomAccessLatency(w, bytes);
    expect(at(16 * 1024)).toBeLessThan(1.5);
    expect(at(512 * 1024)).toBeLessThan(5);
    expect(at(4 << 20)).toBeLessThan(16);
    expect(at(64 << 20)).toBeGreaterThan(70);
  });
  test("linked lists: order matters more than the data structure", () => {
    expect(pat("list-shuffled", 262144) / pat("list-seq", 262144)).toBeGreaterThan(10);
    expect(pat("list-shuffled", 262144) / pat("array", 262144)).toBeGreaterThan(40);
    expect(pat("list-shuffled", 4096)).toBeLessThan(4); // fits in L2: cheap regardless
  });
  test("open addressing beats chaining", () => {
    expect(pat("hash-chain", 262144) / pat("hash-open", 262144)).toBeGreaterThan(3);
  });
  test("data-oriented layout", () => {
    const cost = (id: string, n: number) => { const l = ENTITY_LAYOUTS.find((x) => x.id === id)!; return evaluate(w, l.gen(n), n, l.random).nsPerElem; };
    expect(cost("oop-heap", 100000)).toBeGreaterThan(90);
    expect(cost("oop-array", 100000)).toBeCloseTo(4.75, 1);
    expect(cost("dod", 100000)).toBeLessThan(1.5);
  });
  test("AoS vs SoA vs AoSoA", () => {
    const c = (l: "aos" | "soa" | "aosoa", k: number) => evaluate(w, layoutTrace(l, 262144, 16, k), 262144, false);
    expect(c("aos", 1).bytesFromDram).toBe(64);
    expect(c("soa", 1).nsPerElem).toBeLessThan(c("aos", 1).nsPerElem / 10);
    expect(c("aos", 16).nsPerElem).toBeCloseTo(c("soa", 16).nsPerElem, 1);
    expect(c("aosoa", 2).nsPerElem).toBeLessThan(c("aos", 2).nsPerElem / 3);
  });
  test("latency ladder is ordered", () => {
    const xs = LADDER.map((r) => r.ns);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });
});
