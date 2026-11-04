/** mmap: page cache semantics, signals, and every number in the lesson. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MappedFile, classifyAccess, readCost, mmapCost, shootdownNs, MMAP_COSTS, type AccessResult } from "@/sims/os/memory";
import { mulberry32 } from "@/sims/rng";

const lesson = readFileSync(new URL("../../src/content/lessons/os/memory/mmap.mdx", import.meta.url), "utf8");
const val = (r: AccessResult) => (r.ok ? r.value : r.signal);

describe("mapping semantics", () => {
  const mk = () => new MappedFile(["d0", "d1", "d2", "d3"]);
  test("MAP_SHARED: a store is visible to other mappers and read() at once, and reaches the disk only at writeback", () => {
    const f = mk();
    const a = f.map("A", "shared"), b = f.map("B", "shared");
    f.store(a, 1, "x");
    expect(val(f.load(b, 1))).toBe("x");
    expect(f.sysRead(1)).toBe("x");
    expect(f.disk[1]).toBe("d1");
    expect(f.cache.get(1)!.dirty).toBe(true);
    expect(f.writeback()).toBe(1);
    expect(f.disk[1]).toBe("x");
    expect(f.cache.get(1)!.dirty).toBe(false);
  });
  test("MAP_PRIVATE: a store never reaches the file, the cache, or another process", () => {
    const f = mk();
    const a = f.map("A", "private"), b = f.map("B", "private");
    const r = f.store(a, 2, "x");
    expect(r.ok && r.fault).toBe("cow");
    expect(val(f.load(b, 2))).toBe("d2");
    expect(f.sysRead(2)).toBe("d2");
    expect(f.writeback()).toBe(0);
    expect(f.disk[2]).toBe("d2");
  });
  test("MAP_PRIVATE is not a snapshot: it sees later changes until its first store", () => {
    const f = mk();
    const a = f.map("A", "private"), b = f.map("B", "shared");
    expect(val(f.load(a, 0))).toBe("d0");
    f.store(b, 0, "B1");
    expect(val(f.load(a, 0))).toBe("B1");
    f.store(a, 0, "A1");
    f.store(b, 0, "B2");
    expect(val(f.load(a, 0))).toBe("A1");
    expect(val(f.load(b, 0))).toBe("B2");
  });
  test("faults: major on a miss, minor on a hit, none when mapped", () => {
    const f = mk();
    const a = f.map("A", "shared"), b = f.map("B", "shared");
    const x = f.load(a, 3), y = f.load(b, 3), z = f.load(b, 3);
    expect(x.ok && x.fault).toBe("major");
    expect(y.ok && y.fault).toBe("minor");
    expect(z.ok && z.fault).toBe("none");
  });
  test("eviction writes a dirty page, unmaps every mapper, and the next load is a major fault", () => {
    const f = mk();
    const a = f.map("A", "shared"), b = f.map("B", "shared");
    f.store(a, 0, "A1");
    f.load(b, 0);
    expect(f.evict(0)).toBe(true);
    expect(f.disk[0]).toBe("A1");
    expect(f.stats.shootdowns).toBe(2);
    const r = f.load(b, 0);
    expect(r.ok && r.fault).toBe("major");
    expect(val(r)).toBe("A1");
  });
  test("truncate: SIGBUS after it, for shared and private mappers", () => {
    const f = mk();
    const a = f.map("A", "shared"), b = f.map("B", "private");
    f.load(a, 3);
    f.store(b, 3, "copy");
    f.truncate(2);
    expect(val(f.load(a, 3))).toBe("SIGBUS");
    expect(val(f.load(b, 3))).toBe("SIGBUS");
    expect(val(f.store(a, 2, "x"))).toBe("SIGBUS");
    expect(val(f.load(a, 1))).toBe("d1");
    expect(f.pages).toBe(2);
  });
  test("random operations: shared mappers and read() always agree, the disk never holds a private value", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry32(seed);
      const f = mk();
      const s1 = f.map("S1", "shared"), s2 = f.map("S2", "shared"), p = f.map("P", "private");
      const privateVals = new Set<string>();
      let tag = 0;
      for (let i = 0; i < 300; i++) {
        const pg = Math.floor(rnd() * 4), u = rnd();
        if (u < 0.2) f.store(s1, pg, `s${tag++}`);
        else if (u < 0.3) f.sysWrite(pg, `w${tag++}`);
        else if (u < 0.45) { const v = `p${tag++}`; privateVals.add(v); f.store(p, pg, v); }
        else if (u < 0.55) f.writeback();
        else if (u < 0.65) f.evict(pg);
        else f.load(p, pg);
        const check = Math.floor(rnd() * 4);
        expect(val(f.load(s1, check))).toBe(val(f.load(s2, check)));
        expect(val(f.load(s1, check))).toBe(f.sysRead(check));
        for (const d of f.disk) expect(privateVals.has(d!)).toBe(false);
      }
    }
  });
});

describe("signals", () => {
  test("the predict case and the things to try", () => {
    expect(classifyAccess(8960, 5120, 3 * 4096)).toBe("sigbus");
    expect(classifyAccess(6000, 5120, 3 * 4096)).toBe("tail-zero");
    expect(classifyAccess(8191, 5120, 3 * 4096)).toBe("tail-zero");
    expect(classifyAccess(8192, 5120, 3 * 4096)).toBe("sigbus");
    expect(classifyAccess(12288, 5120, 3 * 4096)).toBe("sigsegv");
    expect(classifyAccess(500, 5120, 3 * 4096)).toBe("data");
    expect(classifyAccess(500, 0, 3 * 4096)).toBe("sigbus");
  });
});

describe("cost model numbers", () => {
  const r = (i: Parameters<typeof readCost>[0]) => Math.round(readCost(i).total);
  const m = (i: Parameters<typeof readCost>[0]) => Math.round(mmapCost(i).total);
  test("inputs are the labelled values", () => {
    expect(MMAP_COSTS).toMatchObject({ syscallNs: 150, copy4kNs: 400, minorFaultNs: 600, faultAroundPages: 16, faultAroundPerPageNs: 40, tlbMissNs: 30, deviceReadNs: 80000, readaheadPages: 32, shootdownBaseNs: 1000, shootdownPerCoreNs: 800 });
  });
  test("random, cached: 550 vs 630, then 330 at 2 touches, then 90 at 10 touches", () => {
    const b = { pattern: "rand" as const, cachedShare: 1, cores: 1 };
    expect(r({ ...b, touches: 1 })).toBe(550);
    expect(m({ ...b, touches: 1 })).toBe(630);
    expect(m({ ...b, touches: 2 })).toBe(330);
    expect(m({ ...b, touches: 10 })).toBe(90);
    expect(r({ ...b, touches: 10 })).toBe(550);
  });
  test("sequential, cached: 550 vs 78", () => {
    expect(r({ pattern: "seq", cachedShare: 1, touches: 1, cores: 1 })).toBe(550);
    expect(m({ pattern: "seq", cachedShare: 1, touches: 1, cores: 1 })).toBe(78);
  });
  test("eviction at 64 cores: 8,550 vs 13,770 random at 90%; 1,800 vs 27,028 sequential at 50%", () => {
    expect(r({ pattern: "rand", cachedShare: 0.9, touches: 1, cores: 64 })).toBe(8550);
    expect(m({ pattern: "rand", cachedShare: 0.9, touches: 1, cores: 64 })).toBe(13770);
    expect(r({ pattern: "seq", cachedShare: 0.5, touches: 1, cores: 64 })).toBe(1800);
    expect(m({ pattern: "seq", cachedShare: 0.5, touches: 1, cores: 64 })).toBe(27028);
    expect(lesson).toContain("27,028");
  });
  test("one shootdown at 64 cores is 51.4 µs", () => {
    expect(shootdownNs(64)).toBe(51400);
    expect(lesson).toContain("51.4 µs");
  });
  test("read() pays no shootdowns at any core count", () => {
    expect(readCost({ pattern: "rand", cachedShare: 0.1, touches: 1, cores: 128 }).shootdown).toBe(0);
  });
});
