import { describe, expect, test } from "vitest";
import { CowBTree, cowDemoTree, buildCow, expectedDirtyPages, cowBytesPerUpdate, modelLevels, fileGrowth } from "@/sims/db/btree-cow";
import { mulberry32 } from "@/sims/rng";

describe("copy-on-write B+ tree", () => {
  test("an update copies exactly the path and writes one meta page", () => {
    const t = buildCow(200, { order: 8 });
    const h = t.height();
    expect(h).toBe(3);
    const before = { ...t.stats };
    const oldRoot = t.root;
    t.update(17, 99);
    expect(t.stats.pagesWritten - before.pagesWritten).toBe(h);
    expect(t.stats.metaWrites - before.metaWrites).toBe(1);
    expect(t.root).not.toBe(oldRoot);
    expect(t.lastWritten.length).toBe(h);
    expect(t.get(17)).toBe(99);
  });

  test("meta pages alternate and the newer one wins", () => {
    const t = new CowBTree({ order: 4 });
    t.update(1, 1);
    t.update(2, 2);
    t.update(3, 3);
    expect(t.meta.map((m) => m.txn).sort()).toEqual([2, 3]);
    expect(t.currentMeta().txn).toBe(3);
    expect(t.currentMeta().slot).toBe(1);
    expect(t.currentMeta().root).toBe(t.root);
  });

  test("a batch shares the copies of the upper levels", () => {
    const t = buildCow(2000, { order: 16 });
    const h = t.height();
    const w0 = t.stats.pagesWritten;
    t.begin();
    for (let k = 0; k < 50; k++) t.put(k * 37, 1);
    t.commit();
    const pages = t.stats.pagesWritten - w0;
    expect(pages).toBeLessThan(50 * h);
    expect(pages).toBeGreaterThan(h);
  });

  test("property: readers always see their snapshot, pages are never overwritten while visible", () => {
    for (const mode of ["reuse", "append"] as const) {
      for (let seed = 1; seed <= 5; seed++) {
        const rng = mulberry32(seed);
        const t = new CowBTree({ order: 3 + (seed % 4), mode });
        const committed = new Map<number, Map<number, number>>(); // txn -> content
        let state = new Map<number, number>();
        committed.set(0, new Map());
        const readers: { id: number; txn: number }[] = [];
        for (let step = 0; step < 300; step++) {
          const r = rng();
          if (r < 0.1 && readers.length < 4) readers.push({ id: t.openReader(), txn: t.lastTxn });
          else if (r < 0.18 && readers.length) t.closeReader(readers.splice(Math.floor(rng() * readers.length), 1)[0]!.id);
          else {
            const batch = 1 + Math.floor(rng() * 4);
            t.begin();
            const next = new Map(state);
            for (let b = 0; b < batch; b++) {
              const k = Math.floor(rng() * 150), v = step * 10 + b;
              t.put(k, v);
              next.set(k, v);
            }
            if (rng() < 0.1) t.abort();
            else {
              const id = t.commit();
              state = next;
              committed.set(id, new Map(state));
            }
          }
          // Latest version and every reader's version are intact.
          if (step % 3) continue;
          expect(t.entries()).toEqual([...state.entries()].sort((a, b) => a[0] - b[0]));
          for (const rd of readers) {
            const want = committed.get(rd.txn)!;
            expect(t.entries(rd.txn)).toEqual([...want.entries()].sort((a, b) => a[0] - b[0]));
            for (const [k, v] of want) expect(t.get(k, rd.id)).toBe(v);
            for (const p of t.reachable(rd.txn)) expect(t.pages.get(p)!.txn).toBeLessThanOrEqual(rd.txn);
          }
        }
        if (mode === "reuse") expect(t.stats.pagesReused).toBeGreaterThan(0);
        else expect(t.stats.pagesReused).toBe(0);
      }
    }
  });

  test("page status covers every page of the file", () => {
    const t = buildCow(100, { order: 4 });
    const r = t.openReader();
    for (let k = 0; k < 10; k++) t.update(k, 1);
    const st = t.pageStatus();
    expect(st.length).toBe(t.fileEnd);
    expect(st.filter((s) => s === "meta-current").length).toBe(1);
    expect(st.filter((s) => s === "live").length).toBe(t.reachable().size);
    expect(st.filter((s) => s === "pinned").length).toBeGreaterThan(0);
    expect(st.filter((s) => s === "free").length).toBe(0); // the reader blocks reuse
    t.closeReader(r);
    t.update(50, 2);
    t.update(51, 2);
    expect(t.pageStatus().filter((s) => s === "free").length).toBeGreaterThan(0);
  });

  test("append mode grows the file; compaction shrinks it to the live pages", () => {
    const t = buildCow(500, { order: 8, mode: "append" });
    for (let k = 0; k < 100; k++) t.update(k, 1);
    const live = t.reachable().size;
    const { before, after } = t.compact();
    expect(before).toBeGreaterThan(after);
    expect(after).toBe(live + 1);
    expect(t.get(5)).toBe(1);
    expect(t.entries().length).toBe(500);
  });
});

describe("write amplification (lesson 4 numbers)", () => {
  test("expected dirty pages: batch 1 = one page per level", () => {
    expect(expectedDirtyPages([1, 10, 500], 1)).toBeCloseTo(3, 10);
    expect(expectedDirtyPages([1, 10, 500], 1000)).toBeGreaterThan(400);
  });

  test("the formula matches the real tree", () => {
    const t = buildCow(5000, { order: 16 });
    const levels = [...Array(t.height())].map(() => 0);
    const walk = (no: number, d: number) => { levels[d]!++; const p = t.pages.get(no)!; if (!p.leaf) p.kids.forEach((c) => walk(c, d + 1)); };
    walk(t.root!, 0);
    const rng = mulberry32(4);
    let pages = 0;
    const txns = 300, batch = 20;
    for (let i = 0; i < txns; i++) {
      const w0 = t.stats.pagesWritten;
      t.begin();
      for (let b = 0; b < batch; b++) t.put(Math.floor(rng() * 5000), i);
      t.commit();
      pages += t.stats.pagesWritten - w0;
    }
    expect(pages / txns).toBeCloseTo(expectedDirtyPages(levels, batch), 0);
  });

  test("model numbers quoted in the lesson", () => {
    const m = (pageBytes: number, batch: number, n = 1e6) => cowBytesPerUpdate({ n, pageBytes, recordBytes: 32, batch });
    expect(modelLevels({ n: 1e6, pageBytes: 4096, recordBytes: 32 })).toEqual([1, 81, 12346]);
    const a = m(4096, 1);
    expect(a.height).toBe(3);
    expect(a.bytesPerUpdate).toBeCloseTo(16384, 6);
    expect(Math.round(a.amplification)).toBe(512);
    const b = m(16384, 1);
    expect(b.height).toBe(3);
    expect(b.bytesPerUpdate).toBeCloseTo(65536, 6);
    const c = m(4096, 100);
    expect(Math.round(c.bytesPerUpdate)).toBe(6521);
  });

  test("a long reader makes the file grow; without it, the file stays flat", () => {
    const base = { n: 2000, order: 16, updates: 400 };
    const free = fileGrowth({ ...base, readerFrom: 1, readerTo: 0, mode: "reuse" });
    const held = fileGrowth({ ...base, readerFrom: 0, readerTo: 399, mode: "reuse" });
    const app = fileGrowth({ ...base, readerFrom: 1, readerTo: 0, mode: "append" });
    expect(free.at(-1)! - free[0]!).toBeLessThan(20);
    expect(held.at(-1)! - held[0]!).toBe(400 * 3);
    expect(app.at(-1)! - app[0]!).toBe(400 * 4);
  });
});

describe("lesson 4 demo numbers", () => {
  test("demo tree: 3 levels; one write copies 3 pages; a reader pins the old path", () => {
    const t = cowDemoTree();
    expect(t.height()).toBe(3);
    const r = t.openReader();
    t.update(22, 1);
    expect(t.lastWritten.length).toBe(3);
    expect(t.stats.metaWrites).toBe(2);
    const old = [...t.reachable(t.readers.get(r)!)].filter((p) => !t.reachable().has(p));
    expect(old.length).toBe(3);
    expect(t.get(22, r)).toBeUndefined();
    expect(t.get(22)).toBe(1);
  });
  test("long reader demo defaults: reader from update 50 to 250", () => {
    const base = { n: 2000, order: 16, updates: 400 };
    const held = fileGrowth({ ...base, readerFrom: 50, readerTo: 250, mode: "reuse" });
    const none = fileGrowth({ ...base, readerFrom: 1, readerTo: 0, mode: "reuse" });
    const app = fileGrowth({ ...base, readerFrom: 1, readerTo: 0, mode: "append" });
    expect(held[0]).toBe(215);
    expect(none.at(-1)).toBe(221);
    expect(held.at(-1)).toBe(818);
    expect(app.at(-1)).toBe(1814);
    // While the reader is open, each update adds its 3 copied pages to the file.
    expect(held[150]! - held[100]!).toBe(150);
    // After it ends, the file stops growing: freed pages are reused.
    expect(held[400]! - held[300]!).toBe(0);
  });
  test("1 KiB records: taller tree, lower ratio", () => {
    const small = cowBytesPerUpdate({ n: 1e6, pageBytes: 4096, recordBytes: 32, batch: 1 });
    const big = cowBytesPerUpdate({ n: 1e6, pageBytes: 4096, recordBytes: 1024, batch: 1 });
    expect(big.height).toBeGreaterThan(small.height);
    expect(big.amplification).toBeLessThan(small.amplification);
  });
  test("16 KiB pages: 2,048 times the record size", () => {
    expect(Math.round(cowBytesPerUpdate({ n: 1e6, pageBytes: 16384, recordBytes: 32, batch: 1 }).amplification)).toBe(2048);
  });
});
