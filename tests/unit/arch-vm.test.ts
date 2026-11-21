/** Pins every number that the architecture vm lessons quote, and checks the sims against the specs they model. */
import { describe, expect, test } from "vitest";
import {
  ALIAS_SCRIPT, FENCES, LATENCY_MODEL, PAGE_FAULT_CAUSE, PTE, SATP_MODE, Sv39Space, TRAP_COST_MODEL, TlbArray, WALK_MODEL,
  aliasScene, applyFence, cacheGeometry, faultFreeCycles, fenceScene, goldenRun, hitTiming, misalignedStore, ptePpn, repMovsb,
  runTrapPipeline, runWalks, staleTimeline, sv39Scene, tlbMissRate, tlbSetIndex, indexBitRange, trapCost, vaIsValid, walkCycles,
  walkPoint, walkSv39, reachBytes,
} from "@/sims/arch/vm";

const KiB = 1024, MiB = 1024 ** 2, GiB = 1024 ** 3;
const r1 = (x: number) => Math.round(x * 1000) / 10; // percent with one decimal
const r2 = (x: number) => Math.round(x * 100) / 100;

describe("address translation: VIPT geometry", () => {
  test("Zen 3 L1D: 32 KiB 8-way 64 B fills the 12-bit page offset exactly", () => {
    const g = cacheGeometry(32 * KiB, 8, 64, 4096);
    expect([g.sets, g.offsetBits, g.indexBits, g.aliasBits, g.maxAliasFreeBytes]).toEqual([64, 6, 6, 0, 32 * KiB]);
  });
  test("ways × page size limits", () => {
    expect(cacheGeometry(48 * KiB, 12, 64, 4096).aliasBits).toBe(0);
    expect(cacheGeometry(48 * KiB, 12, 64, 4096).maxAliasFreeBytes).toBe(48 * KiB);
    expect(cacheGeometry(128 * KiB, 8, 64, 4096)).toMatchObject({ aliasBits: 2, colors: 4, minWaysAliasFree: 32 });
    expect(cacheGeometry(128 * KiB, 32, 64, 4096).aliasBits).toBe(0);
    expect(cacheGeometry(128 * KiB, 8, 128, 16 * KiB)).toMatchObject({ aliasBits: 0, minWaysAliasFree: 8 });
    expect(cacheGeometry(64 * KiB, 8, 64, 4096)).toMatchObject({ aliasBits: 1, colors: 2 });
  });
  test("hit timing with the model inputs: PIPT 4, VIPT 3, VIVT 3; slow TLB", () => {
    expect([hitTiming("pipt").total, hitTiming("vipt").total, hitTiming("vivt").total]).toEqual([4, 3, 3]);
    expect(hitTiming("vipt", { ...LATENCY_MODEL, tlb: 3 }).total).toBe(4);
    expect(hitTiming("vivt", { ...LATENCY_MODEL, tlb: 3 }).total).toBe(3);
    expect(hitTiming("vipt", { tlb: 3, index: 4, compare: 1 }).total).toBe(5);
    expect(hitTiming("vivt", { tlb: 3, index: 4, compare: 1 }).total).toBe(5);
  });
  test("the synonym demo: sets 1 and 65, a stale load, and the fixes", () => {
    const { cache, vaA, vaB } = aliasScene("vipt", false);
    expect([cache.setOf(vaA), cache.setOf(vaB)]).toEqual([1, 65]);
    const res = ALIAS_SCRIPT(vaA, vaB).map((o) => cache.run(o));
    expect(res[1]).toMatchObject({ value: 0, truth: 1, stale: true, set: 65 });
    expect(res[3]).toMatchObject({ value: 1, truth: 2, stale: true, set: 1 });
    for (const [org, same] of [["vipt", true], ["vipt-probe", false], ["pipt", false]] as const) {
      const s = aliasScene(org, same);
      const out = ALIAS_SCRIPT(s.vaA, s.vaB).map((o) => s.cache.run(o)).filter((x) => x.op.kind === "load");
      expect(out.map((x) => x.value), org).toEqual([1, 2]);
      expect(out.some((x) => x.stale)).toBe(false);
    }
  });
});

describe("page tables: Sv39", () => {
  test("satp modes and cause codes from the privileged spec", () => {
    expect(SATP_MODE).toEqual({ Bare: 0, Sv39: 8, Sv48: 9, Sv57: 10 });
    expect(PAGE_FAULT_CAUSE).toEqual({ fetch: 12, load: 13, store: 15 });
  });
  test("sign extension of bit 38", () => {
    expect(vaIsValid(0x0000_003f_ffff_ffffn)).toBe(true);
    expect(vaIsValid(0xffff_ffc0_0000_0000n)).toBe(true);
    expect(vaIsValid(0x0000_0080_0000_0000n)).toBe(false);
  });
  const run = (name: string, access: "load" | "store" | "fetch", o = {}) => {
    const { space, samples } = sv39Scene();
    const s = samples.find((x) => x.name === name)!;
    return { r: walkSv39(space.mem, space.rootPpn, s.va, access, o), space, va: s.va };
  };
  test("reads per walk: 3 for 4 KiB, 2 for a megapage, 0 for a bad VA", () => {
    expect(run("code", "load").r).toMatchObject({ ok: true, reads: 3, level: 0, pa: 0x81000abcn });
    expect(run("2 MiB megapage", "load").r).toMatchObject({ ok: true, reads: 2, level: 1, pa: 0x90012345n });
    expect(run("not sign-extended", "load").r).toMatchObject({ ok: false, reads: 0, cause: 13 });
  });
  test("faults: misaligned superpage, U bit, permission, V = 0", () => {
    expect(run("misaligned megapage", "store").r.steps.at(-2)!.kind).toBe("align");
    expect(run("misaligned megapage", "store").r.cause).toBe(15);
    expect(run("kernel", "load").r.ok).toBe(false);
    expect(run("kernel", "load", { priv: "S" }).r.ok).toBe(true);
    expect(run("kernel", "fetch", { priv: "S" }).r.ok).toBe(true);
    expect(run("code", "fetch", { priv: "S", sum: true }).r.ok).toBe(false); // S-mode never executes U pages
    expect(run("code", "load", { priv: "S", sum: false }).r.ok).toBe(false);
    expect(run("code", "load", { priv: "S", sum: true }).r.ok).toBe(true);
    expect(run("read-only data", "store").r.cause).toBe(15);
    expect(run("unmapped", "fetch").r.cause).toBe(12);
  });
  test("MXR makes execute-only pages readable", () => {
    const s = new Sv39Space();
    s.map(0x1000n, 0x900n, { r: false, x: true });
    expect(walkSv39(s.mem, s.rootPpn, 0x1000n, "load").ok).toBe(false);
    expect(walkSv39(s.mem, s.rootPpn, 0x1000n, "load", { mxr: true }).ok).toBe(true);
  });
  test("W = 1 with R = 0 is reserved", () => {
    const s = new Sv39Space();
    s.map(0x1000n, 0x900n, { r: false, w: true });
    const r = walkSv39(s.mem, s.rootPpn, 0x1000n, "store");
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)!.text).toContain("reserved");
  });
  test("Svade faults on A = 0 and D = 0; Svadu sets them with one write", () => {
    expect(run("heap", "store", { ad: "svade" }).r).toMatchObject({ ok: false, cause: 15 });
    expect(run("heap", "load", { ad: "svade" }).r).toMatchObject({ ok: false, cause: 13 });
    const { r, space, va } = run("heap", "store", { ad: "svadu" });
    expect(r).toMatchObject({ ok: true, writes: 1 });
    const pte = space.mem.peek(space.pteAddr(va, 0)!);
    expect(pte & (PTE.A | PTE.D)).toBe(PTE.A | PTE.D);
    expect(ptePpn(pte)).toBe(0x81203n);
    const again = walkSv39(space.mem, space.rootPpn, va, "store", { ad: "svade" });
    expect(again.ok).toBe(true); // the bits stay set
  });
  test("a PTE line of 64 bytes maps 32 KiB", () => expect((64 / 8) * 4096).toBe(32 * KiB));
});

describe("page tables: walk caches (demo trace length 20,000)", () => {
  const pt = (pattern: "random" | "sparse" | "sequential", bytes: number, pwc: number, levels = 4) =>
    walkPoint(pattern, bytes, { levels, tlbEntries: WALK_MODEL.tlbEntries, pwcEntries: pwc }, 20_000);
  test("random 64 MiB: 4.00 reads without, 1.00 with 32-entry walk caches", () => {
    expect(r2(pt("random", 64 * MiB, 0).readsPerWalk)).toBe(4);
    expect(r2(pt("random", 64 * MiB, 32).readsPerWalk)).toBe(1);
  });
  test("1 GiB: 1.94 reads with 3, 4 or 5 levels; sparse 2.94", () => {
    for (const l of [3, 4, 5]) expect(r2(pt("random", GiB, 32, l).readsPerWalk)).toBe(1.94);
    expect(r2(pt("sparse", GiB, 32).readsPerWalk)).toBe(2.94);
    expect(r1(pt("random", GiB, 0).missRate)).toBe(99.4);
  });
  test("model inputs and cycles", () => {
    expect(WALK_MODEL).toEqual({ tlbEntries: 1536, pwcEntries: 32, pteReadCycles: 20 });
    expect(walkCycles(4)).toBe(80);
  });
  test("a walk-cache hit at the last non-leaf level leaves one read", () => {
    const s = runWalks([0, 1, 2, 3], { levels: 4, tlbEntries: 1, pwcEntries: 4 });
    expect(s.histogram[4]).toBe(1);
    expect(s.histogram[1]).toBe(3);
  });
});

describe("TLBs: arrays", () => {
  const FA = (policy: "lru" | "plru" | "fifo" | "random", coalesce = 1) => ({ entries: 64, ways: 64, policy, coalesce });
  const m = (cfg: Parameters<typeof tlbMissRate>[0], pat: "loop" | "random", n: number, f = 0) => r1(tlbMissRate(cfg, pat, n, f, 20_000));
  test("loop over 64 and 65 pages", () => {
    expect(m(FA("lru"), "loop", 64)).toBe(0);
    expect(m(FA("lru"), "loop", 65)).toBe(100);
    expect(m(FA("random"), "loop", 65)).toBe(3.2);
    expect(m(FA("random"), "loop", 96)).toBe(58.4);
    expect(m(FA("lru"), "loop", 96)).toBe(100);
    expect(m(FA("plru"), "loop", 65)).toBe(93.1);
    expect(m({ entries: 64, ways: 4, policy: "lru" }, "loop", 65)).toBe(7.7);
  });
  test("random accesses: policies agree", () => {
    for (const p of ["lru", "random"] as const) expect(Math.abs(m(FA(p), "random", 128) - 50)).toBeLessThan(0.5);
    expect(m(FA("lru"), "random", 1024)).toBe(93.7);
  });
  test("coalescing", () => {
    expect(m(FA("lru", 4), "random", 256, 1)).toBe(0);
    expect(m(FA("lru", 4), "random", 256, 0.5)).toBe(47.6);
    expect(m(FA("lru", 16), "random", 1024, 0.5)).toBe(57.2);
    expect(reachBytes(64, 4096, 4)).toBe(1 * MiB);
  });
  test("split arrays take their index from different bits", () => {
    expect(indexBitRange(12, 16)).toEqual([12, 15]);
    expect(indexBitRange(21, 8)).toEqual([21, 23]);
    expect(tlbSetIndex(0x5000, 12, 16)).toBe(5);
  });
  test("tree PLRU never evicts the way it just used", () => {
    const t = new TlbArray({ entries: 4, ways: 4, policy: "plru" });
    for (const v of [0, 1, 2, 3]) t.access(v);
    t.access(3);
    t.access(9); // evicts something other than 3
    expect(t.access(3)).toBe(true);
  });
});

describe("TLBs: fences", () => {
  const ctx = { va: 0x10000, asid: 2, current: 1 };
  const run = (text: string, c = ctx) => applyFence(fenceScene(), FENCES.find((f) => f.text === text)!, 0, c).removed.map((x) => x.length);
  test("RISC-V forms are local and follow rs1/rs2", () => {
    expect(run("sfence.vma x0, x0")).toEqual([5, 0]);
    expect(run("sfence.vma x0, a1")).toEqual([2, 0]);
    expect(run("sfence.vma a0, x0")).toEqual([2, 0]);
    expect(run("sfence.vma a0, a1")).toEqual([1, 0]);
    expect(run("sfence.vma a0, x0", { ...ctx, va: 0xfff00000 })).toEqual([1, 0]); // the global page
    expect(run("sfence.vma a0, a1", { ...ctx, va: 0xfff00000 })).toEqual([0, 0]);
  });
  test("x86 and Arm", () => {
    expect(run("invlpg [va]")).toEqual([1, 0]);
    expect(run("invpcid type 3")).toEqual([4, 0]);
    expect(run("mov cr3 (bit 63 = 1)")).toEqual([0, 0]);
    expect(run("tlbi vae1is", { ...ctx, asid: 1 })).toEqual([1, 1]);
    expect(run("tlbi vmalle1is")).toEqual([5, 4]);
  });
  test("the stale translation", () => {
    expect(staleTimeline(false).at(-1)!.danger).toBe(true);
    expect(staleTimeline(true).at(-1)!.danger).toBe(false);
  });
});

describe("page faults", () => {
  test("precise trap: correct result, 22 cycles against 8", () => {
    const r = runTrapPipeline("precise", "one");
    expect(r.correct).toBe(true);
    expect(r.cycles.length).toBe(22);
    expect(faultFreeCycles()).toBe(8);
    expect(r.traps).toEqual([{ cycle: 5, pc: 0xff8, cause: 13, tval: 0x4000 }]);
    expect(goldenRun().regs).toMatchObject({ a0: 6, a1: 37, a2: 43 });
  });
  test("the load is marked in MEM at cycle 4", () => {
    const r = runTrapPipeline("precise", "one");
    expect(r.cycles[3]!.events.join(" ")).toContain("Load page fault");
    expect(r.cycles[4]!.flushed.length).toBe(3);
  });
  test("draining runs younger instructions twice", () => {
    const r = runTrapPipeline("drain", "one");
    expect(r.correct).toBe(false);
    expect(r.regs).toMatchObject({ a0: 7, a2: 44 });
    expect(r.cycles.some((c) => c.mem[0x5000] === 6)).toBe(true);
  });
  test("two faults: the older load is reported first", () => {
    const r = runTrapPipeline("precise", "two");
    expect(r.correct).toBe(true);
    expect(r.cycles[2]!.events.join(" ")).toContain("Instruction page fault");
    expect(r.traps.map((t) => t.cause)).toEqual([13, 12]);
    const d = runTrapPipeline("drain", "two");
    expect(d.traps.slice(0, 2).map((t) => [t.cycle, t.cause])).toEqual([[3, 12], [4, 13]]);
  });
  test("rep movsb and the misaligned store", () => {
    const f = repMovsb();
    expect(f[3]!.fault).toBe(true);
    expect(f[3]!.regs).toMatchObject({ RCX: "8", RSI: "0x2000", RDI: "0x6000", CR2: "0x6000" });
    expect(f.at(-1)!.dst.every((b) => b.value !== null)).toBe(true);
    const s = misalignedStore();
    expect(s[2]!.regs.stval).toBe("0x2000");
    expect(s[2]!.dst.filter((b) => b.value !== null).length).toBe(4);
  });
  test("trap cost with the model inputs", () => {
    const c = trapCost();
    expect([c.hardware, c.software, c.total]).toEqual([100, 1500, 1600]);
    expect(r1(c.hardwareShare)).toBe(6.3);
    expect(trapCost({ ...TRAP_COST_MODEL, handlerInstructions: 100 }).hardwareShare).toBe(0.5);
  });
});
