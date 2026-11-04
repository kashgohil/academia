/** Property tests for the vm sims: each structure agrees with a simple reference under random operations. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  AddressSpace, FRAMES_PER_BLOCK, FREE, GiB, HUGE, MiB, Mmu, PAGE_SIZE, PF, PTE, PageTable, PhysMem, SIZE_1G, SIZE_2M, TableMem, ThpSim, Tlb, VmKernel, VmaTree,
  canonicalize, entryPfn, has, hexVa, isCanonical, joinVa, parseVa, splitVa, tablesForStride, vmaPerms,
} from "@/sims/os/vm";

const BASE = 0x7f0000000000;

/** Addresses spread across many subtrees, so that tables are created and freed. */
function randomVa(r: () => number, pages: number): number {
  const region = Math.floor(r() * 8);
  return BASE - region * 2 ** 39 + Math.floor(r() * pages) * PAGE_SIZE * (region % 2 ? 1 : 513);
}

describe("page table walker", () => {
  test("agrees with a Map reference across random map and unmap", () => {
    const r = mulberry32(1);
    const pt = new PageTable();
    const ref = new Map<number, { pfn: number; writable: boolean }>();
    for (let i = 0; i < 6000; i++) {
      const va = randomVa(r, 700);
      if (r() < 0.6) {
        if (ref.has(va)) continue;
        const pfn = Math.floor(r() * 2 ** 30);
        const writable = r() < 0.5;
        pt.map(va, pfn, { writable, user: true });
        ref.set(va, { pfn, writable });
      } else {
        const e = pt.unmap(va);
        expect(e !== null).toBe(ref.has(va));
        if (e !== null) expect(entryPfn(e)).toBe(ref.get(va)!.pfn);
        ref.delete(va);
      }
      if (i % 40 === 0) {
        const probe = randomVa(r, 700) + 123;
        const page = probe - 123;
        const w = pt.walk(probe);
        const want = ref.get(page);
        expect(w.ok).toBe(want !== undefined);
        if (want) expect(w.pa).toBe(BigInt(want.pfn) * 4096n + 123n);
      }
    }
    for (const [va, m] of ref) {
      const w = pt.walk(va, { kind: "w" });
      if (m.writable) expect(w.pa).toBe(BigInt(m.pfn) * 4096n);
      else expect(w.fault?.reason).toBe("protection");
    }
  });

  test("table memory counts equal the pages actually allocated", () => {
    const r = mulberry32(2);
    const mem = new TableMem();
    const pt = new PageTable({ mem });
    const mapped = new Set<number>();
    for (let i = 0; i < 4000; i++) {
      const va = randomVa(r, 400);
      if (r() < 0.55) { if (!mapped.has(va)) { pt.map(va, 1); mapped.add(va); } }
      else { pt.unmap(va); mapped.delete(va); }
      expect(mem.count).toBe(pt.tablePages);
      if (i % 200 === 0) expect(pt.nodes().length).toBe(pt.tablePages);
    }
    // Distinct prefixes at each level give the same count as the real tree.
    const prefix = (va: number, l: number) => Math.floor(va / 2 ** (12 + 9 * (4 - l)));
    let want = 1;
    for (let l = 1; l <= 3; l++) want += new Set([...mapped].map((v) => prefix(v, l))).size;
    expect(pt.tablePages).toBe(want);
    for (const va of mapped) pt.unmap(va);
    expect(pt.tablePages).toBe(1);
    expect(mem.count).toBe(1);
  });

  test("tablesForStride equals the real tree", () => {
    for (const [n, stride] of [[1, 4096], [513, 4096], [2000, 4096], [300, SIZE_2M], [40, GiB], [3, 512 * GiB]] as const) {
      const pt = new PageTable();
      for (let i = 0; i < n; i++) pt.map(i * stride, 1);
      expect(tablesForStride(n, stride).tables).toBe(pt.tablePages);
    }
    const pt = new PageTable();
    for (let i = 0; i < 20; i++) pt.map(i * SIZE_2M, 512, { size: SIZE_2M });
    expect(tablesForStride(20, SIZE_2M, { leafSize: SIZE_2M }).tables).toBe(pt.tablePages);
  });

  test("walk event log: one read per level, right field indices, A and D bits", () => {
    const pt = new PageTable();
    const va = joinVa([255, 1, 2, 3], 0x45);
    pt.map(va - 0x45n, 0x1234, { writable: true });
    const w = pt.walk(va, { kind: "w" });
    expect(w.events.map((e) => e.index)).toEqual([255, 1, 2, 3]);
    expect(w.events.map((e) => e.name)).toEqual(["PML4", "PDPT", "PD", "PT"]);
    expect(w.pa).toBe(0x1234045n);
    const leaf = pt.leaf(va)!.entry;
    expect(has(leaf, PTE.A)).toBe(true);
    expect(has(leaf, PTE.D)).toBe(true);
    expect(w.events[0]!.entryPa).toBe((BigInt(pt.root) << 12n) + 255n * 8n);
  });

  test("huge leaves stop the walk early and translate the inner offset", () => {
    const pt = new PageTable();
    pt.map(SIZE_2M * 7, 512 * 3, { size: SIZE_2M, writable: true });
    const w = pt.walk(SIZE_2M * 7 + 0x12345);
    expect(w.events.length).toBe(3);
    expect(w.pageShift).toBe(21);
    expect(w.pa).toBe(BigInt(512 * 3) * 4096n + 0x12345n);
    pt.map(SIZE_1G * 5, 512 * 512, { size: SIZE_1G, writable: true });
    const g = pt.walk(SIZE_1G * 5 + 0x3456789);
    expect(g.events.length).toBe(2);
    expect(g.pa).toBe(BigInt(512 * 512) * 4096n + 0x3456789n);
    expect(() => pt.map(SIZE_2M * 7 + 4096, 9)).toThrow();
  });

  test("rights: AND of RW and US, OR of NX, and the error code", () => {
    const pt = new PageTable();
    pt.map(0x1000, 5, { writable: false, user: true, nx: true });
    pt.map(0x2000, 6, { writable: true, user: false, nx: false });
    expect(pt.walk(0x1000).ok).toBe(true);
    const wf = pt.walk(0x1000, { kind: "w" });
    expect(wf.fault?.code).toBe(PF.P | PF.W | PF.U);
    expect(pt.walk(0x1000, { kind: "x" }).fault?.code).toBe(PF.P | PF.U | PF.I);
    expect(pt.walk(0x2000).fault?.reason).toBe("protection");
    expect(pt.walk(0x2000, { user: false, kind: "w" }).ok).toBe(true);
    expect(pt.walk(0x3000).fault).toEqual({ reason: "not-present", code: PF.U, level: 3 });
    expect(pt.walk(0x0000800000000000n).fault?.reason).toBe("non-canonical");
  });

  test("5-level tables have one more level", () => {
    const pt = new PageTable({ levels: 5 });
    const va = canonicalize(1n << 55n, 5);
    pt.map(va, 42);
    const w = pt.walk(va);
    expect(w.events.length).toBe(5);
    expect(w.events[0]!.name).toBe("PML5");
    expect(pt.tablePages).toBe(5);
  });

  test("address helpers round trip", () => {
    const r = mulberry32(3);
    for (let i = 0; i < 500; i++) {
      const idx = [0, 0, 0, 0].map(() => Math.floor(r() * 512));
      const off = Math.floor(r() * 4096);
      const va = joinVa(idx, off);
      expect(isCanonical(va)).toBe(true);
      const f = splitVa(va);
      expect(f.indices).toEqual(idx);
      expect(f.offset).toBe(off);
      expect(parseVa(hexVa(va))).toBe(va);
    }
    expect(parseVa("xyz")).toBeNull();
    expect(isCanonical(0x00007fffffffffffn)).toBe(true);
    expect(isCanonical(0x0000800000000000n)).toBe(false);
    expect(isCanonical(0xffff800000000000n)).toBe(true);
    expect(isCanonical(0x0000800000000000n, 5)).toBe(true);
  });
});

describe("VMA tree", () => {
  test("find agrees with a page map reference across random insert and remove", () => {
    const r = mulberry32(4);
    const t = new VmaTree();
    const ref = new Map<number, string>();
    const P = 4096;
    for (let i = 0; i < 3000; i++) {
      const start = Math.floor(r() * 500) * P;
      const len = (1 + Math.floor(r() * 12)) * P;
      if (r() < 0.5) {
        let free = true;
        for (let a = start; a < start + len; a += P) if (ref.has(a)) free = false;
        if (!free) { expect(() => t.insert({ start, end: start + len, read: true, write: true, exec: false, shared: false })).toThrow(); continue; }
        const write = r() < 0.5;
        t.insert({ start, end: start + len, read: true, write, exec: false, shared: false });
        for (let a = start; a < start + len; a += P) ref.set(a, write ? "rw-p" : "r--p");
      } else if (r() < 0.8) {
        let bytes = 0;
        for (let a = start; a < start + len; a += P) if (ref.delete(a)) bytes += P;
        expect(t.remove(start, start + len)).toBe(bytes);
      } else {
        const write = r() < 0.5;
        t.protect(start, start + len, { read: true, write, exec: false });
        for (let a = start; a < start + len; a += P) if (ref.has(a)) ref.set(a, write ? "rw-p" : "r--p");
      }
      if (i % 60 === 0) {
        for (let a = 0; a < 520 * P; a += P) {
          const v = t.find(a);
          expect(v ? vmaPerms(v) : undefined).toBe(ref.get(a));
        }
      }
      const all = t.all;
      for (let k = 1; k < all.length; k++) expect(all[k - 1]!.end).toBeLessThanOrEqual(all[k]!.start);
    }
    expect(t.mappedBytes).toBe(ref.size * P);
  });

  test("insert merges neighbours; file offsets stay consistent across a split", () => {
    const t = new VmaTree();
    t.insert({ start: 0x1000, end: 0x3000, read: true, write: true, exec: false, shared: false });
    t.insert({ start: 0x3000, end: 0x5000, read: true, write: true, exec: false, shared: false });
    expect(t.count).toBe(1);
    t.insert({ start: 0x10000, end: 0x20000, read: true, write: false, exec: false, shared: false, file: { name: "f", offset: 0x4000 } });
    t.remove(0x12000, 0x13000);
    const hi = t.find(0x13000)!;
    expect(hi.file!.offset).toBe(0x4000 + 0x3000);
    expect(t.findFirstAfter(0x12000)).toBe(hi);
  });
});

describe("address space and fault path", () => {
  test("each outcome class", () => {
    const k = new VmKernel();
    const as = new AddressSpace(k);
    as.mmap(0x10000, 0x4000, { read: true, write: true, name: "anon" });
    as.mmap(0x20000, 0x4000, { read: true, file: { name: "a.so" } });
    as.mmap(0x30000, 0x2000, { read: false, write: false, name: "guard" });
    as.mmap(0x40000, 0x1000, { read: true, write: true, growsDown: true, name: "[stack]" });
    expect(as.access(0x9000, "r").outcome).toBe("segv-maperr");
    expect(as.access(0x30000, "r").outcome).toBe("segv-accerr");
    expect(as.access(0x20000, "w").outcome).toBe("segv-accerr");
    expect(as.access(0x10000, "x").outcome).toBe("segv-accerr");
    const rd = as.access(0x10000, "r");
    expect(rd.outcome).toBe("minor-zero");
    expect(rd.pfn).toBe(k.zeroPfn);
    expect(as.rssPages).toBe(0);
    expect(as.access(0x10000, "r").outcome).toBe("hit");
    expect(as.access(0x10000, "w").outcome).toBe("minor-cow");
    expect(as.rssPages).toBe(1);
    expect(as.access(0x11000, "w").outcome).toBe("minor-anon");
    expect(as.rssPages).toBe(2);
    expect(as.access(0x20000, "r").outcome).toBe("major-file");
    expect(as.access(0x20000, "r").outcome).toBe("hit");
    k.warmFile("a.so", 4);
    expect(as.access(0x21000, "r").outcome).toBe("minor-file");
    expect(as.access(0x3f000, "w").outcome).toBe("minor-anon"); // stack growth inside the limit
    expect(as.vmas.find(0x3f000)?.name).toBe("[stack]");
    expect(as.swapOut(0x11000)).toBe(true);
    expect(as.pteState(0x11000)).toBe("swap");
    const sw = as.access(0x11000, "r");
    expect(sw.outcome).toBe("major-swap");
    expect(k.swapUsed.size).toBe(0);
    expect(as.access(0x11000, "w").outcome).toBe("minor-cow"); // sole owner: reuses the frame
    expect(as.minorFaults).toBeGreaterThan(0);
    expect(as.majorFaults).toBe(2);
  });

  test("stack limit: a fault too far below the stack is SEGV_MAPERR", () => {
    const as = new AddressSpace();
    as.mmap(0x40000000, 0x1000, { read: true, write: true, growsDown: true });
    expect(as.access(0x40000000 - 9 * MiB, "w").outcome).toBe("segv-maperr");
    expect(as.access(0x40000000 - 7 * MiB, "w").outcome).toBe("minor-anon");
  });

  test("private file write copies, shared file write maps writable", () => {
    const k = new VmKernel();
    const as = new AddressSpace(k);
    as.mmap(0x10000, 0x2000, { read: true, write: true, file: { name: "f" } });
    as.mmap(0x20000, 0x2000, { read: true, write: true, shared: true, file: { name: "f" } });
    expect(as.access(0x10000, "w").outcome).toBe("major-file");
    const [cachePfn] = k.filePage("f", 0);
    expect(as.pt.walk(0x10000).pfn).not.toBe(cachePfn);
    expect(as.access(0x20000, "w").outcome).toBe("minor-file");
    expect(as.pt.walk(0x20000).pfn).toBe(cachePfn);
    expect(as.access(0x11000, "r").outcome).toBe("major-file");
    expect(as.access(0x11000, "w").outcome).toBe("minor-cow");
  });

  test("fork shares frames until a write, and the sole survivor reuses its frame", () => {
    const k = new VmKernel();
    const p = new AddressSpace(k);
    p.mmap(0x10000, 0x1000, { read: true, write: true });
    p.access(0x10000, "w");
    const pfn = p.pt.walk(0x10000).pfn!;
    const c = p.fork();
    expect(c.pt.walk(0x10000).pfn).toBe(pfn);
    expect(c.rssPages).toBe(1);
    expect(c.access(0x10000, "w").outcome).toBe("minor-cow");
    expect(c.pt.walk(0x10000).pfn).not.toBe(pfn);
    const pw = p.access(0x10000, "w");
    expect(pw.outcome).toBe("minor-cow");
    expect(p.pt.walk(0x10000).pfn).toBe(pfn); // no copy: it is now the only user
    expect(k.usedFrames).toBe(2);
  });

  test("random access: frames, RSS and reference agree; munmap returns everything", () => {
    const r = mulberry32(5);
    const k = new VmKernel();
    const as = new AddressSpace(k);
    const base = 0x100000, pages = 200;
    as.mmap(base, pages * PAGE_SIZE, { read: true, write: true });
    const written = new Set<number>(), read = new Set<number>();
    for (let i = 0; i < 3000; i++) {
      const pg = Math.floor(r() * pages);
      const va = base + pg * PAGE_SIZE;
      const write = r() < 0.4;
      const o = as.access(va, write ? "w" : "r").outcome;
      if (write) { expect(written.has(pg) ? "hit" : read.has(pg) ? "minor-cow" : "minor-anon").toBe(o); written.add(pg); }
      else { expect(written.has(pg) || read.has(pg) ? "hit" : "minor-zero").toBe(o); read.add(pg); }
      expect(as.rssPages).toBe(written.size);
      expect(k.usedFrames).toBe(written.size);
    }
    as.munmap(base, pages * PAGE_SIZE);
    expect(as.rssPages).toBe(0);
    expect(k.usedFrames).toBe(0);
    expect(as.pt.tablePages).toBe(1);
  });

  test("mprotect read-only makes writes SEGV_ACCERR; writable again reuses the frame", () => {
    const as = new AddressSpace();
    as.mmap(0x10000, 0x1000, { read: true, write: true });
    as.access(0x10000, "w");
    as.mprotect(0x10000, 0x1000, { write: false, exec: false });
    expect(as.access(0x10000, "w").outcome).toBe("segv-accerr");
    as.mprotect(0x10000, 0x1000, { write: true, exec: false });
    expect(as.access(0x10000, "w").outcome).toBe("minor-cow");
    expect(as.rssPages).toBe(1);
  });
});

describe("TLB", () => {
  test("a hit never returns a stale translation after invalidation", () => {
    const r = mulberry32(6);
    const pt = new PageTable();
    const mmu = new Mmu({ pt, l1: new Tlb({ entries: 16, ways: 4 }), l2: new Tlb({ entries: 64, ways: 8 }) });
    const ref = new Map<number, number>();
    let pfnNext = 100;
    for (let i = 0; i < 20000; i++) {
      const page = Math.floor(r() * 80);
      const va = BASE + page * PAGE_SIZE;
      const x = r();
      if (x < 0.2) {
        const old = ref.get(va);
        if (old !== undefined) pt.unmap(va);
        const pfn = pfnNext++;
        pt.map(va, pfn, { writable: true });
        mmu.invlpg(va);
        ref.set(va, pfn);
      } else if (x < 0.3) {
        pt.unmap(va);
        mmu.invlpg(va);
        ref.delete(va);
      } else {
        const t = mmu.translate(va + 8);
        const want = ref.get(va);
        expect(t.ok).toBe(want !== undefined);
        if (want !== undefined) expect(t.pa).toBe(want * PAGE_SIZE + 8);
      }
    }
    expect(mmu.l1.stats.hits).toBeGreaterThan(1000);
  });

  test("without invalidation the TLB does return a stale translation", () => {
    const pt = new PageTable();
    const mmu = new Mmu({ pt, l1: new Tlb({ entries: 16, ways: 4 }) });
    pt.map(BASE, 1, {});
    mmu.translate(BASE);
    pt.unmap(BASE);
    pt.map(BASE, 2, {});
    expect(mmu.translate(BASE).pfn).toBe(1); // stale: this is the bug that a shootdown prevents
    mmu.invlpg(BASE);
    expect(mmu.translate(BASE).pfn).toBe(2);
  });

  test("ASIDs: no translation leaks between address spaces; PCID keeps entries across a switch", () => {
    const a = new PageTable(), b = new PageTable();
    a.map(BASE, 10, {});
    b.map(BASE, 20, {});
    const mmu = new Mmu({ pt: a, asid: 1, l1: new Tlb({ entries: 16, ways: 4 }), pcid: true });
    expect(mmu.translate(BASE).pfn).toBe(10);
    mmu.switchTo(b, 2);
    expect(mmu.translate(BASE).pfn).toBe(20);
    mmu.switchTo(a, 1);
    const again = mmu.translate(BASE);
    expect(again.pfn).toBe(10);
    expect(again.level).toBe("l1");
    const noPcid = new Mmu({ pt: a, asid: 1, l1: new Tlb({ entries: 16, ways: 4 }), pcid: false });
    noPcid.translate(BASE);
    noPcid.switchTo(b, 1);
    const flushed = noPcid.translate(BASE);
    expect(flushed.pfn).toBe(20);
    expect(flushed.level).toBe("walk");
  });

  test("global entries survive a CR3 flush and match any ASID", () => {
    const t = new Tlb({ entries: 8, ways: 2 });
    t.insert(0x5000, 1, 12, 1, { global: true });
    t.insert(0x6000, 2, 12, 1);
    t.flush(true);
    expect(t.lookup(0x5000, 9)?.pfn).toBe(1);
    expect(t.lookup(0x6000, 1)).toBeNull();
    expect(t.invalidateAsid(9)).toBe(0);
    expect(t.lookup(0x5000, 9)?.pfn).toBe(1);
  });

  test("set associativity against a reference LRU per set", () => {
    const r = mulberry32(7);
    const entries = 32, ways = 4, sets = entries / ways;
    const t = new Tlb({ entries, ways });
    const ref: number[][] = Array.from({ length: sets }, () => []);
    for (let i = 0; i < 20000; i++) {
      const vpn = Math.floor(r() * 80);
      const va = vpn * 4096;
      const set = ref[vpn % sets]!;
      const at = set.indexOf(vpn);
      const hit = t.lookup(va) !== null;
      expect(hit).toBe(at >= 0);
      if (at >= 0) set.splice(at, 1);
      else { t.insert(va, vpn, 12); if (set.length === ways) set.shift(); }
      set.push(vpn);
    }
    expect(t.occupied).toBeLessThanOrEqual(entries);
  });

  test("the TLB holds pages of several sizes", () => {
    const pt = new PageTable();
    pt.map(SIZE_2M * 3, 512 * 2, { size: SIZE_2M, writable: true });
    pt.map(0x1000, 7, { writable: true });
    const mmu = new Mmu({ pt, l1: new Tlb({ entries: 16, ways: 4, pageShifts: [12, 21] }) });
    mmu.translate(SIZE_2M * 3 + 0x5000);
    const t = mmu.translate(SIZE_2M * 3 + 0x9008);
    expect(t.level).toBe("l1");
    expect(t.pa).toBe(512 * 2 * 4096 + 0x9008);
    expect(mmu.translate(0x1000).pageShift).toBe(12);
    mmu.invlpg(SIZE_2M * 3 + 0x100);
    expect(mmu.translate(SIZE_2M * 3).level).toBe("walk");
  });

  test("a write on a clean TLB entry walks once to set the D bit", () => {
    const pt = new PageTable();
    pt.map(BASE, 3, { writable: true });
    const mmu = new Mmu({ pt, l1: new Tlb({ entries: 16, ways: 4 }) });
    mmu.translate(BASE);
    expect(has(pt.leaf(BASE)!.entry, PTE.D)).toBe(false);
    expect(mmu.translate(BASE, { kind: "w" }).level).toBe("walk");
    expect(has(pt.leaf(BASE)!.entry, PTE.D)).toBe(true);
    expect(mmu.translate(BASE, { kind: "w" }).level).toBe("l1");
  });
});

describe("physical memory", () => {
  test("frame accounting holds across random alloc, free and compaction", () => {
    const r = mulberry32(8);
    const m = new PhysMem(16);
    m.fragment({ used: 0.3, scatter: 0.8, unmovable: 0.2, seed: 3 });
    const count = () => { let u = 0; for (const o of m.owner) if (o !== FREE) u++; return u; };
    const mine = new Set<number>();
    const big: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const x = r();
      if (x < 0.5) { const f = m.allocSmall(1); if (f >= 0) mine.add(f); }
      else if (x < 0.8 && mine.size) { const f = [...mine][Math.floor(r() * mine.size)]!; if (m.owner[f] === 1) { m.freeSmall(f); mine.delete(f); } }
      else if (x < 0.82) { const b = m.allocBlock(); if (b >= 0) big.push(b); }
      else if (x < 0.83 && big.length) m.freeBlock(big.pop()!);
      else if (x < 0.84) {
        const before = count();
        m.compactOne();
        expect(count()).toBe(before);
        mine.clear();
        m.owner.forEach((o, f) => { if (o === 1) mine.add(f); });
      }
      if (i % 100 === 0) expect(m.freeFrames).toBe(m.frameCount - count());
    }
    for (const b of big) for (let f = b * FRAMES_PER_BLOCK; f < (b + 1) * FRAMES_PER_BLOCK; f++) expect(m.owner[f]).toBe(HUGE);
  });

  test("compaction empties a block but never moves a pinned page", () => {
    const m = new PhysMem(4);
    m.fragment({ used: 0.1, scatter: 1, unmovable: 0.5, seed: 9 });
    const pinned = () => { const s: number[] = []; m.owner.forEach((o, f) => { if (o === -2) s.push(f); }); return s; };
    const before = pinned();
    expect(m.freeBlocks).toBe(0);
    const c = m.compactOne();
    expect(c.ok).toBe(true);
    expect(m.usedIn(c.block)).toBe(0);
    expect(pinned()).toEqual(before);
    expect(m.compactOne().ok).toBe(true);
    expect(m.compactOne().ok).toBe(false); // only blocks with pinned pages remain
  });

  test("THP: RSS and frames agree after a random run", () => {
    const s = new ThpSim({ blocks: 24, touchedPerRegion: 300, defrag: "direct" });
    for (let i = 0; i < 8; i++) s.touchRegion();
    s.khugepagedPass();
    const st = s.stats;
    let smallFrames = 0, hugeFrames = 0;
    s.mem.owner.forEach((o) => { if (o >= 0) smallFrames++; if (o === HUGE) hugeFrames++; });
    expect(smallFrames).toBe(st.smallPages);
    expect(hugeFrames).toBe(st.hugeRegions * FRAMES_PER_BLOCK);
    expect(st.rssBytes).toBe(smallFrames * PAGE_SIZE + hugeFrames * PAGE_SIZE);
  });
});
