/** Page replacement: properties of the policies, and every number in the page-replacement lesson. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  simulate, countFaults, lruFaultCurve, workload, workingSetSeries, phaseString, randomString, nextUses,
  BELADY_STRING, TEXTBOOK_STRING, LOOP_STRING, thrashCurve, thrashPeak, mva, THRASH_DEFAULTS, THRASH_LOCALITY, type ReplPolicy,
} from "@/sims/os/memory";
import { BufferPool } from "@/sims/db/storage";

const lesson = readFileSync(new URL("../../src/content/lessons/os/memory/page-replacement.mdx", import.meta.url), "utf8");
const pc = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Exhaustive search over all eviction choices. */
function optimal(refs: readonly number[], frames: number): number {
  const memo = new Map<string, number>();
  const go = (i: number, mem: number[]): number => {
    if (i === refs.length) return 0;
    const r = refs[i]!;
    if (mem.includes(r)) return go(i + 1, mem);
    const key = `${i}|${[...mem].sort((a, b) => a - b).join(",")}`;
    const m = memo.get(key);
    if (m !== undefined) return m;
    let best = Infinity;
    if (mem.length < frames) best = go(i + 1, [...mem, r]);
    else for (let k = 0; k < mem.length; k++) { const n = [...mem]; n[k] = r; best = Math.min(best, go(i + 1, n)); }
    best += 1;
    memo.set(key, best);
    return best;
  };
  return go(0, []);
}

describe("policies", () => {
  test("MIN equals an exhaustive search of all eviction choices", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = randomString(14, 5, seed);
      for (const f of [1, 2, 3, 4]) expect(countFaults("min", s, f)).toBe(optimal(s, f));
    }
  });

  test("MIN is never beaten on random strings", () => {
    const others: ReplPolicy[] = ["fifo", "lru", "clock", "twolist"];
    for (let seed = 1; seed <= 300; seed++) {
      const s = randomString(60, 3 + (seed % 12), seed);
      for (const f of [1, 2, 3, 5, 8]) {
        const m = countFaults("min", s, f);
        for (const p of others) expect(m).toBeLessThanOrEqual(countFaults(p, s, f));
      }
    }
  });

  test("LRU and MIN never show Belady's anomaly on random strings", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const s = randomString(80, 4 + (seed % 10), seed);
      for (const p of ["lru", "min"] as const) {
        let prev = Infinity;
        for (let f = 1; f <= 14; f++) { const c = countFaults(p, s, f); expect(c).toBeLessThanOrEqual(prev); prev = c; }
      }
    }
  });

  test("the given string shows the anomaly under FIFO and Clock: 9 faults with 3 frames, 10 with 4", () => {
    expect(BELADY_STRING).toEqual([1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5]);
    expect(countFaults("fifo", BELADY_STRING, 3)).toBe(9);
    expect(countFaults("fifo", BELADY_STRING, 4)).toBe(10);
    expect(countFaults("clock", BELADY_STRING, 3)).toBe(9);
    expect(countFaults("clock", BELADY_STRING, 4)).toBe(10);
    expect(countFaults("lru", BELADY_STRING, 3)).toBe(10);
    expect(countFaults("lru", BELADY_STRING, 4)).toBe(8);
    expect(countFaults("min", BELADY_STRING, 3)).toBe(7);
    expect(countFaults("min", BELADY_STRING, 4)).toBe(6);
  });

  test("Mattson's one-pass curve equals an LRU run at every size", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = randomString(200, 20, seed);
      const c = lruFaultCurve(s, 25);
      for (let f = 1; f <= 25; f++) expect(c[f]).toBe(countFaults("lru", s, f));
      expect(c[0]).toBe(s.length);
    }
  });

  test("LRU and Clock agree with the buffer pool's committed policies", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = randomString(300, 16, seed);
      for (const f of [2, 4, 8]) for (const p of ["lru", "clock"] as const) {
        const bp = new BufferPool(f, p);
        for (const r of s) bp.access(r);
        expect(bp.stats.misses).toBe(countFaults(p, s, f));
      }
    }
  });

  test("every trace keeps each page once, holds the referenced page, and counts faults", () => {
    for (const p of ["min", "fifo", "lru", "clock", "twolist"] as const) {
      const s = randomString(100, 9, 5);
      let faults = 0;
      for (const st of simulate(p, s, 4)) {
        const held = st.frames.filter((x) => x !== null);
        expect(new Set(held).size).toBe(held.length);
        expect(held).toContain(st.ref);
        if (!st.hit) faults++;
        expect(st.faults).toBe(faults);
      }
      expect(faults).toBe(countFaults(p, s, 4));
    }
  });

  test("nextUses", () => {
    expect([...nextUses([1, 2, 1, 3])]).toEqual([2, Infinity, Infinity, Infinity]);
  });
});

describe("numbers in the lesson", () => {
  test("textbook string with 3 frames: MIN 9, LRU 12, Clock 14, FIFO 15", () => {
    expect(countFaults("min", TEXTBOOK_STRING, 3)).toBe(9);
    expect(countFaults("lru", TEXTBOOK_STRING, 3)).toBe(12);
    expect(countFaults("clock", TEXTBOOK_STRING, 3)).toBe(14);
    expect(countFaults("fifo", TEXTBOOK_STRING, 3)).toBe(15);
  });
  test("loop string with 3 frames: LRU and FIFO 12 of 12, MIN 6", () => {
    expect(LOOP_STRING.length).toBe(12);
    expect(countFaults("lru", LOOP_STRING, 3)).toBe(12);
    expect(countFaults("fifo", LOOP_STRING, 3)).toBe(12);
    expect(countFaults("min", LOOP_STRING, 3)).toBe(6);
  });
  const rate = (p: ReplPolicy, w: Parameters<typeof workload>[0], f: number) => { const r = workload(w); return countFaults(p, r, f) / r.length; };
  test("fault curves", () => {
    expect(pc(rate("min", "loop", 40))).toBe("17.6%");
    for (const p of ["lru", "fifo", "clock", "twolist"] as const) expect(rate(p, "loop", 40)).toBe(1);
    expect(pc(rate("min", "uniform", 32))).toBe("21.7%");
    for (const p of ["lru", "fifo", "clock"] as const) expect(Math.abs(rate(p, "uniform", 32) - 0.5)).toBeLessThan(0.01);
    expect(pc(rate("lru", "phases", 24))).toBe("1.6%");
    expect(rate("lru", "phases", 96)).toBe(rate("lru", "phases", 24));
    expect(pc(rate("fifo", "hotscan", 32))).toBe("48.1%");
    expect(pc(rate("clock", "hotscan", 32))).toBe("43.0%");
    expect(pc(rate("lru", "hotscan", 32))).toBe("39.0%");
    expect(pc(rate("twolist", "hotscan", 32))).toBe("32.9%");
    expect(pc(rate("min", "hotscan", 32))).toBe("24.5%");
    for (const n of ["17.6%", "21.7%", "1.6%", "48.1%", "43.0%", "39.0%", "32.9%", "24.5%"]) expect(lesson).toContain(n);
  });
  test("working set means: 8.3 pages at τ = 10, 53.5 at τ = 3000, near 24 at τ = 200", () => {
    const w = phaseString(6000, 24, 1500, 7);
    const mean = (t: number) => { const s = workingSetSeries(w, t); return s.reduce((a, b) => a + b, 0) / s.length; };
    expect(mean(10).toFixed(1)).toBe("8.3");
    expect(mean(3000).toFixed(1)).toBe("53.5");
    expect(Math.abs(mean(200) - 24)).toBeLessThan(2);
  });
  test("thrashing curve", () => {
    const p = thrashCurve();
    const at = (n: number) => p[n - 1]!;
    expect(THRASH_DEFAULTS.faultUs).toBe(2000);
    expect(THRASH_DEFAULTS.totalFrames).toBe(256);
    expect(THRASH_LOCALITY).toBe(24);
    expect(pc(at(1).cpu)).toBe("23.6%");
    expect(pc(at(10).cpu)).toBe("99.8%");
    expect(pc(at(11).cpu)).toBe("55.3%");
    expect(pc(at(12).cpu)).toBe("19.4%");
    expect(pc(at(13).cpu)).toBe("11.8%");
    expect(at(12).framesEach).toBe(21);
    expect(pc(at(10).faultRate)).toBe("0.6%");
    expect(pc(at(12).faultRate)).toBe("12.9%");
    expect(at(12).paging).toBeGreaterThan(0.995);
    expect(thrashPeak(p).n).toBe(10);
    expect(at(40).loadControlled).toBeCloseTo(at(10).cpu, 6);
    const fast = thrashCurve({ ...THRASH_DEFAULTS, faultUs: 100 });
    expect(pc(fast[39]!.cpu)).toBe("66.4%");
    for (const n of ["23.6%", "99.8%", "55.3%", "19.4%", "11.8%", "12.9%", "66.4%"]) expect(lesson).toContain(n);
  });
  test("MVA matches closed forms", () => {
    // One customer: no queueing.
    const a = mva(1, 2, 3, 1);
    expect(a.throughput).toBeCloseTo(1 / 6, 10);
    // Many customers: the bottleneck saturates.
    expect(mva(1, 2, 0, 200).paging).toBeCloseTo(1, 3);
    expect(mva(1, 2, 0, 200).cpu).toBeCloseTo(0.5, 3);
    // Utilization law.
    const b = mva(1, 0.5, 2, 7);
    expect(b.cpu / b.paging).toBeCloseTo(2, 10);
  });
});
