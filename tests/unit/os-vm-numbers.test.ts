/** Pins every number that the vm lessons quote, and the facts in the sims that those numbers rest on. */
import { describe, expect, test } from "vitest";
import {
  AddressSpace, BRK_RND_BYTES, DEVICE_NS, DRAM_NS, ENTRIES_PER_TABLE, FAULT_COST_NS, FAULT_FACTS, GiB, KiB, LAYOUT_FACTS, MMAP_RND_BITS, MiB, PIE_BASE, PTE, PTE_BIT_INFO, PiB, SHOOTDOWN_MODEL, STACK_RND_BITS, TASK_SIZE, THP_COST, THP_DEFAULTS, THP_FACTS, TLB_FACTS, TLB_MODEL, TRANSLATION_MODEL, ThpSim, TiB,
  addressMap, addressMapFacts, aslrRange, bandBytes, chase, effectiveAccessNs, entrySpan, faultRateForSlowdown, flatTableBytes, fmtBytes, fullTreeBytes, granule, granuleVaBits, holeBytes, nestedWalkReads, overcommitCheck, procMaps, mapsText, reachBytes, reachRow, runThp, runTrace, shootdown, tablesForStride, tlbPattern, touchRun, twoProcesses, userHalfBytes, vaBits, type TlbPatternId,
} from "@/sims/os/vm";

describe("address spaces", () => {
  test("address space sizes", () => {
    expect(vaBits(4)).toBe(48);
    expect(vaBits(5)).toBe(57);
    expect(userHalfBytes(4)).toBe(128 * TiB);
    expect(2 ** 48).toBe(256 * TiB);
    expect(2 ** 57).toBe(128 * PiB);
    expect(fmtBytes(holeBytes(4))).toBe("16 EiB");
    expect(addressMapFacts.usableFraction).toBe(2 ** -16);
  });

  test("the bands cover 2^64 with no gap, and match the kernel layout table", () => {
    const bands = addressMap(3);
    for (const m of [bands, addressMap(4), addressMap(3, false)]) {
      expect(m[0]!.start).toBe(0n);
      expect(m.at(-1)!.end).toBe(1n << 64n);
      for (const b of m) expect(b.end).toBeGreaterThan(b.start);
      for (let i = 1; i < m.length; i++) expect(m[i]!.start).toBe(m[i - 1]!.end);
    }
    const size = (name: string) => bandBytes(bands.find((b) => b.name === name)!);
    expect(size("Direct map")).toBe(64 * TiB);
    expect(size("vmalloc and ioremap")).toBe(32 * TiB);
    expect(size("vmemmap")).toBe(TiB);
    expect(size("Kernel text")).toBe(512 * MiB);
    expect(size("Modules")).toBe(1520 * MiB);
    expect(TASK_SIZE).toBe(0x7ffffffff000n);
  });

  test("the PIE base is two thirds of the user range", () => {
    expect(PIE_BASE).toBe(0x555555554000n);
  });

  test("ASLR ranges", () => {
    expect(MMAP_RND_BITS).toBe(28);
    expect(STACK_RND_BITS).toBe(22);
    expect(aslrRange.mmapBytes).toBe(TiB);
    expect(aslrRange.stackBytes).toBe(16 * GiB);
    expect(BRK_RND_BYTES).toBe(2 ** 13 * 4096);
    expect(aslrRange.brkBytes).toBe(32 * MiB);
    expect(LAYOUT_FACTS.stackLimit).toBe(8 * MiB);
    expect(LAYOUT_FACTS.machoPageZero).toBe(4 * GiB);
  });

  test("procMaps looks like the real file and moves with ASLR", () => {
    const a = procMaps(1), b = procMaps(2), fixed = procMaps(1, false), fixed2 = procMaps(2, false);
    expect(fixed[0]!.start).toBe(PIE_BASE);
    expect(fixed.map(mapsText)).toEqual(fixed2.map(mapsText));
    expect(a[0]!.start).not.toBe(b[0]!.start);
    for (const m of [a, b, fixed]) {
      for (let i = 1; i < m.length; i++) expect(m[i]!.start).toBeGreaterThanOrEqual(m[i - 1]!.end);
    }
    expect(mapsText(fixed[0]!)).toBe("555555554000-555555556000 r--p 00000000 08:01 1835 /usr/bin/cat");
    expect(a.filter((l) => l.path.endsWith("libc.so.6")).length).toBe(5);
    expect(a.find((l) => l.path === "[heap]")!.inode).toBe(0);
    expect(a.find((l) => l.path === "[stack]")!.inode).toBe(0);
    for (const m of [a, b, fixed]) expect(m.some((l) => l.path === "[vdso]")).toBe(true);
    for (let seed = 1; seed < 200; seed++) {
      const m = procMaps(seed);
      for (let i = 1; i < m.length; i++) expect(m[i]!.start).toBeGreaterThanOrEqual(m[i - 1]!.end);
    }
  });

  test("two processes: same virtual address, different frame; shared frames stay shared", () => {
    const t = twoProcesses();
    expect(t.virtualPages).toBe(16);
    expect(t.framesUsed).toBe(11);
    expect(t.framesUnshared - t.framesUsed).toBe(5);
    t.a.forEach((p, i) => {
      const q = t.b[i]!;
      expect(q.va).toBe(p.va);
      expect(t.tablesA.walk(p.va).pfn).toBe(p.pfn);
      expect(t.tablesB.walk(q.va).pfn).toBe(q.pfn);
      if (p.shared) expect(q.pfn).toBe(p.pfn);
      else expect(q.pfn).not.toBe(p.pfn);
    });
    const aslr = twoProcesses({ aslr: true });
    aslr.a.forEach((p, i) => {
      expect(aslr.b[i]!.va).not.toBe(p.va);
      if (p.shared) expect(aslr.b[i]!.pfn).toBe(p.pfn);
    });
  });
});

describe("page tables", () => {
  test("flat table sizes", () => {
    expect(flatTableBytes(48)).toBe(512 * GiB);
    expect(flatTableBytes(48)).toBe(2 ** 39);
    expect(flatTableBytes(32, 12, 4)).toBe(4 * MiB);
  });

  test("fan-out and the span of each level", () => {
    expect(ENTRIES_PER_TABLE).toBe(4096 / 8);
    expect(entrySpan(0)).toBe(4 * KiB);
    expect(entrySpan(1)).toBe(2 * MiB);
    expect(entrySpan(2)).toBe(GiB);
    expect(entrySpan(3)).toBe(512 * GiB);
  });

  test("PTE bit positions", () => {
    const pos = Object.fromEntries(PTE_BIT_INFO.map((b) => [b.bit, b.pos]));
    expect(pos).toEqual({ P: 0, RW: 1, US: 2, A: 5, D: 6, PS: 7, G: 8, NX: 63 });
    for (const b of PTE_BIT_INFO) expect(PTE[b.bit]).toBe(1n << BigInt(b.pos));
  });

  test("table costs quoted in the text", () => {
    const one = tablesForStride(1, 4096);
    expect(one.tables).toBe(4);
    expect(fmtBytes(one.bytes)).toBe("16 KiB");
    const pages = GiB / 4096;
    const dense = tablesForStride(pages, 4096);
    expect(fmtBytes(dense.bytes)).toBe("2.01 MiB");
    expect((dense.overhead * 100).toFixed(2)).toBe("0.20");
    const sparse = tablesForStride(pages, 2 * MiB);
    expect(fmtBytes(sparse.bytes)).toBe("1 GiB");
    expect((sparse.overhead * 100).toFixed(1)).toBe("100.2");
    expect(pages * 2 * MiB).toBe(512 * GiB);
    const very = tablesForStride(pages, GiB);
    expect(fmtBytes(very.bytes)).toBe("2 GiB");
    expect(Math.round(very.overhead * 100)).toBe(200);
    const huge = tablesForStride(512, 2 * MiB, { leafSize: 2 * MiB });
    expect(huge.tables).toBe(3);
    expect(huge.bytes).toBe(12 * KiB);
    expect(fmtBytes(fullTreeBytes(4))).toBe("513 GiB");
    expect(((fullTreeBytes(4) / flatTableBytes(48) - 1) * 100).toFixed(1)).toBe("0.2");
  });

  test("granules", () => {
    expect(granule(4096)).toMatchObject({ bitsPerLevel: 9, entries: 512, blockSize: 2 * MiB });
    expect(granule(16 * KiB)).toMatchObject({ bitsPerLevel: 11, entries: 2048, blockSize: 32 * MiB });
    expect(granule(64 * KiB)).toMatchObject({ bitsPerLevel: 13, entries: 8192, blockSize: 512 * MiB });
    expect(granuleVaBits(16 * KiB, 3)).toBe(47);
    expect(granuleVaBits(4096, 4)).toBe(48);
  });
});

describe("the TLB", () => {
  const rate = (id: TlbPatternId, pages: number, entries: number, ways: number) =>
    runTrace(tlbPattern(id, { length: 1200, pages, pageSize: 4096, entries, ways, seed: 9 }), { entries, ways }).hitRate;

  test("simulator hit rates in the lesson", () => {
    expect(rate("stride", 17, 16, 16)).toBe(0);
    expect((rate("stride", 16, 16, 16) * 100).toFixed(1)).toBe("98.7");
    expect((rate("stride", 17, 16, 4) * 100).toFixed(1)).toBe("69.6");
    expect(rate("conflict", 17, 16, 4)).toBe(0);
    expect((rate("conflict", 17, 16, 16) * 100).toFixed(1)).toBe("99.6");
    expect((rate("scan", 17, 16, 16) * 100).toFixed(1)).toBe("98.4");
    expect(4096 / 64).toBe(64);
  });

  test("the conflict pattern leaves 12 entries empty", () => {
    const tr = tlbPattern("conflict", { length: 100, pages: 17, pageSize: 4096, entries: 16, ways: 4 });
    expect(new Set(tr).size).toBe(5);
    const sets = new Set(tr.map((va) => (va / 4096) % 4));
    expect(sets.size).toBe(1);
    expect(16 - 4).toBe(12);
  });

  test("nested walk", () => {
    expect(nestedWalkReads(4, 4)).toBe(24);
    expect(nestedWalkReads(4, 0)).toBe(4);
    expect(nestedWalkReads(5, 5)).toBe(35);
  });

  test("reach table", () => {
    expect(TLB_MODEL["4k"].l1).toEqual({ entries: 64, ways: 4 });
    expect(TLB_MODEL["4k"].l2).toEqual({ entries: 1536, ways: 12 });
    expect(TLB_MODEL["2m"].l1.entries).toBe(32);
    expect(TLB_MODEL["2m"].l2.entries).toBe(1536);
    expect(TLB_MODEL["1g"].l1.entries).toBe(4);
    expect(TLB_MODEL["1g"].l2.entries).toBe(16);
    expect(reachBytes(64, 4096)).toBe(256 * KiB);
    expect(reachBytes(1536, 4096)).toBe(6 * MiB);
    expect(reachBytes(32, 2 * MiB)).toBe(64 * MiB);
    expect(reachBytes(1536, 2 * MiB)).toBe(3 * GiB);
    expect(reachBytes(4, GiB)).toBe(4 * GiB);
    expect(reachBytes(16, GiB)).toBe(16 * GiB);
    expect(reachBytes(1536, 2 * MiB) / reachBytes(1536, 4096)).toBe(512);
  });

  test("chase model: the cycles quoted in the text", () => {
    const c = (ws: number, id: "4k" | "2m") => chase(ws, id).translationCycles.toFixed(1);
    expect(c(MiB, "4k")).toBe("5.2");
    expect(c(16 * MiB, "4k")).toBe("15.0");
    expect(c(GiB, "4k")).toBe("46.6");
    expect(c(64 * GiB, "4k")).toBe("214.7");
    expect(c(GiB, "2m")).toBe("6.6");
    expect(c(64 * GiB, "2m")).toBe("26.8");
    expect((chase(GiB, "4k").walkRate * 100).toFixed(1)).toBe("99.4");
    expect(chase(128 * KiB, "4k").translationCycles).toBe(0);
    expect(TRANSLATION_MODEL.l2HitCycles).toBe(7);
    expect(TRANSLATION_MODEL.walkBaseCycles).toBe(15);
  });

  test("tags", () => {
    expect(TLB_FACTS.pcids).toBe(4096);
    expect(TLB_FACTS.linuxDynAsids).toBe(6);
    expect(TLB_FACTS.arm64AsidBits).toEqual([8, 16]);
  });

  test("shootdown model", () => {
    expect(shootdown({ cores: 32, pages: 1 }).senderWaitNs).toBe(3250);
    expect(shootdown({ cores: 32, pages: 1 }).totalCoreNs).toBe(40450);
    expect(shootdown({ cores: 128, pages: 1 }).senderWaitNs).toBe(8050);
    expect(shootdown({ cores: 128, pages: 1 }).totalCoreNs).toBe(160450);
    expect(shootdown({ cores: 32, pages: 1 }).ipis).toBe(31);
    expect(SHOOTDOWN_MODEL.flushCeiling).toBe(33);
    expect(shootdown({ cores: 4, pages: 33 }).fullFlush).toBe(false);
    expect(shootdown({ cores: 4, pages: 34 }).fullFlush).toBe(true);
    expect(shootdown({ cores: 128, pages: 1, broadcast: true }).ipis).toBe(0);
    // Total time grows with N, far faster than the sender's wait.
    const a = shootdown({ cores: 2, pages: 1 }), b = shootdown({ cores: 128, pages: 1 });
    expect(b.totalCoreNs / a.totalCoreNs).toBeGreaterThan(b.senderWaitNs / a.senderWaitNs);
  });
});

describe("page faults", () => {
  test("model costs", () => {
    expect(DRAM_NS).toBe(100);
    expect(FAULT_COST_NS["minor-zero"]).toBe(500);
    expect(FAULT_COST_NS["minor-anon"]).toBe(1000);
    expect(FAULT_COST_NS["minor-cow"]).toBe(1500);
    expect(DEVICE_NS).toEqual({ nvme: 100_000, sata: 200_000, hdd: 8_000_000 });
    expect(DEVICE_NS.nvme / FAULT_COST_NS["minor-anon"]).toBe(100);
    expect(FAULT_COST_NS["major-file"]).toBe(DEVICE_NS.nvme);
  });

  test("fault rates for a 10% slowdown", () => {
    expect(1 / faultRateForSlowdown(1.1, DEVICE_NS.nvme)).toBeCloseTo(10_000, 3);
    expect(1 / faultRateForSlowdown(1.1, DEVICE_NS.hdd)).toBeCloseTo(800_000, 1);
    expect(effectiveAccessNs(faultRateForSlowdown(1.1, DEVICE_NS.nvme), DEVICE_NS.nvme)).toBeCloseTo(110, 6);
  });

  test("demand paging runs", () => {
    const w = touchRun(16 * MiB, "write", 8).samples.at(-1)!;
    expect(w.minor).toBe(4096);
    expect(w.rssBytes).toBe(16 * MiB);
    expect((w.timeNs / 1e6).toFixed(1)).toBe("4.1");
    expect(w.tableBytes).toBe(44 * KiB);
    const r = touchRun(16 * MiB, "read", 8).samples.at(-1)!;
    expect(r.minor).toBe(4096);
    expect(r.rssBytes).toBe(0);
    expect(r.tableBytes).toBe(44 * KiB);
    const both = touchRun(16 * MiB, "read", 8).as;
    for (let i = 0; i < 4096; i++) both.access(0x7f0000000000 + i * 4096, "w");
    expect(both.minorFaults).toBe(8192);
    expect(both.rssPages).toBe(4096);
    expect(GiB / 4096).toBe(262144);
  });

  test("the fault demo walk-through", () => {
    const as = new AddressSpace();
    as.kernel.warmFile("libc.so.6", 4);
    as.mmap(0x10000, 0x4000, { read: true, write: true });
    as.mmap(0x20000, 0x4000, { read: true, exec: true, file: { name: "libc.so.6" } });
    as.mmap(0x30000, 0x4000, { read: true, exec: true, file: { name: "app" } });
    const first = as.access(0x10000, "r");
    expect(first.outcome).toBe("minor-zero");
    expect(first.pteStateAfter).toBe("zero-page");
    expect(as.rssPages).toBe(0);
    const second = as.access(0x10000, "w");
    expect(second.outcome).toBe("minor-cow");
    expect(second.steps.map((s) => s.id)).toContain("wp");
    for (let i = 0; i < 4; i++) expect(as.access(0x20000 + i * 4096, "r").outcome).toBe("minor-file");
    expect(as.access(0x30000, "r").outcome).toBe("major-file");
    expect(first.errorCode).toBe(4); // not present, read, user
    expect(second.errorCode).toBe(7); // present, write, user
  });

  test("libc facts and overcommit", () => {
    expect(FAULT_FACTS.faultAroundBytes).toBe(64 * KiB);
    expect(FAULT_FACTS.faultAroundPages - 1).toBe(15);
    expect(FAULT_FACTS.glibcMmapThreshold).toBe(128 * KiB);
    expect(FAULT_FACTS.overcommitRatioPct).toBe(50);
    const base = { ramBytes: 16 * GiB, swapBytes: 4 * GiB, committedBytes: 12 * GiB };
    expect(overcommitCheck({ ...base, mode: 0, requestBytes: 24 * GiB }).ok).toBe(false);
    expect(overcommitCheck({ ...base, mode: 0, requestBytes: 20 * GiB }).ok).toBe(true);
    expect(overcommitCheck({ ...base, mode: 1, requestBytes: 128 * GiB }).ok).toBe(true);
    const m2 = overcommitCheck({ ...base, mode: 2, requestBytes: GiB });
    expect(m2.limitBytes).toBe(12 * GiB);
    expect(m2.ok).toBe(false);
    expect(overcommitCheck({ ramBytes: 16 * GiB, swapBytes: 4 * GiB, committedBytes: 0, mode: 2, requestBytes: 12 * GiB }).ok).toBe(true);
  });
});

describe("huge pages", () => {
  test("reach calculator at 32 GiB", () => {
    const r = (id: "4k" | "16k" | "2m" | "1g") => reachRow(id, 32 * GiB);
    expect(r("4k").cyclesPerAccess.toFixed(1)).toBe("164.4");
    expect(r("16k").cyclesPerAccess.toFixed(1)).toBe("62.7");
    expect(r("2m").cyclesPerAccess.toFixed(1)).toBe("24.2");
    expect(r("1g").cyclesPerAccess.toFixed(1)).toBe("10.0");
    expect((r("2m").coverage * 100).toFixed(1)).toBe("9.4");
    expect((r("4k").coverage * 100).toFixed(2)).toBe("0.02");
    expect(r("1g").l2Reach).toBe(16 * GiB);
    expect(r("4k").entriesNeeded).toBe(8388608);
    expect(r("4k").leafTableBytes).toBe(64 * MiB);
    expect(r("2m").entriesNeeded).toBe(16384);
    expect(r("2m").leafTableBytes).toBe(128 * KiB);
    expect(r("16k").l2Reach / r("4k").l2Reach).toBe(4);
    expect(reachRow("1g", 16 * GiB).coverage).toBe(1);
  });

  test("Linux defaults", () => {
    expect(THP_FACTS.pagesToScan).toBe(4096);
    expect(THP_FACTS.regionsPerScan).toBe(8);
    expect(THP_FACTS.scanSleepMs).toBe(10000);
    expect(THP_FACTS.maxPtesNone).toBe(511);
    expect(THP_DEFAULTS.maxPtesNone).toBe(511);
    expect(THP_FACTS.framesPerBlock).toBe(512);
    expect(THP_FACTS.contBytes).toBe(64 * KiB);
    expect(THP_COST.smallFaultNs).toBe(1000);
    expect(THP_COST.hugeFaultNs).toBe(100_000);
    expect(THP_COST.migratePageNs).toBe(5000);
  });

  test("the three cases in the table: 24 regions", () => {
    const off = runThp({ enabled: "never" }, 24);
    expect(off.worstFaultNs).toBe(1000);
    expect((off.faultNs / 1e6).toFixed(1)).toBe("12.3");
    expect(off.tlbEntries).toBe(12288);
    const fall = runThp({ defrag: "never" }, 24);
    expect(fall.hugeRegions).toBe(14);
    expect(fall.smallRegions).toBe(10);
    expect(fall.worstFaultNs).toBe(100_000);
    expect((fall.faultNs / 1e6).toFixed(1)).toBe("6.5");
    expect(fall.tlbEntries).toBe(5134);
    const direct = runThp({ defrag: "direct" }, 24);
    expect(direct.hugeRegions).toBe(24);
    expect(direct.worstFaultNs).toBe(1_545_000);
    expect((direct.faultNs / 1e6).toFixed(1)).toBe("16.9");
    expect(direct.tlbEntries).toBe(24);
  });

  test("khugepaged work counters", () => {
    const s = runThp({ defrag: "never" }, 24, 3);
    expect(s.hugeRegions).toBe(24);
    expect(s.compactionMoved).toBe(2890);
    expect(s.collapseCopied).toBe(5120);
  });

  test("bloat", () => {
    const b = runThp({ touchedPerRegion: 8 }, 14);
    expect(b.rssBytes).toBe(28 * MiB);
    expect(b.usefulBytes).toBe(448 * KiB);
    expect(b.bloat).toBe(64);
    const off = runThp({ touchedPerRegion: 8, enabled: "never" }, 14);
    expect(off.rssBytes).toBe(448 * KiB);
    // The default max_ptes_none lets khugepaged cause the same bloat later.
    const collapsed = runThp({ touchedPerRegion: 8, enabled: "never" }, 14, 2);
    expect(collapsed.hugeRegions).toBe(14);
    expect(collapsed.bloat).toBe(64);
    // A low limit leaves the sparse regions alone.
    const strict = runThp({ touchedPerRegion: 8, enabled: "never", maxPtesNone: 64 }, 14, 2);
    expect(strict.hugeRegions).toBe(0);
    expect(strict.bloat).toBe(1);
  });

  test("pinned pages stop compaction", () => {
    const s = new ThpSim({ unmovable: 1, defrag: "direct" });
    const free = s.mem.freeBlocks;
    for (let i = 0; i < 24; i++) s.touchRegion();
    expect(s.stats.hugeRegions).toBe(free);
    expect(s.stats.compactionMoved).toBe(0);
  });
});
