/** Copy-on-write: the refcount invariant, isolation, and every number in the lesson. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CowMemory, snapshotExtra, snapshotOnCow, firstWriteNs, forkPteBytes, distinctTouched, SNAPSHOT_DEFAULTS, COW_COSTS, type CowProc } from "@/sims/os/memory";
import { mulberry32 } from "@/sims/rng";

const lesson = readFileSync(new URL("../../src/content/lessons/os/memory/copy-on-write.mdx", import.meta.url), "utf8");

function check(m: CowMemory) {
  const mappers = m.mappers();
  for (const [id, f] of m.frames) expect(f.refs, `frame ${id}`).toBe(mappers.get(id) ?? 0);
  for (const [id] of mappers) expect(m.frames.has(id)).toBe(true);
}

describe("COW model", () => {
  test("random fork, write, exit and KSM: refcounts match mappers, and no write is visible to another process", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = mulberry32(seed);
      const m = new CowMemory();
      const first = m.spawn("p0", ["a", "b", "c", "d", "e"]);
      // What each process must see, kept independently of the model.
      const shadow = new Map<CowProc, string[]>([[first, ["a", "b", "c", "d", "e"]]]);
      let tag = 0;
      for (let i = 0; i < 300; i++) {
        const live = [...shadow.keys()];
        const p = live[Math.floor(rnd() * live.length)]!;
        const u = rnd();
        if (u < 0.1 && live.length < 6) {
          const c = m.fork(p);
          shadow.set(c, [...shadow.get(p)!]);
        } else if (u < 0.15 && live.length > 1) {
          m.exit(p);
          shadow.delete(p);
        } else if (u < 0.2) {
          m.ksmMerge();
        } else {
          const vpn = Math.floor(rnd() * 5);
          // Equal bytes on purpose sometimes, so that KSM has work to do.
          const v = rnd() < 0.5 ? "same" : `v${tag++}`;
          m.write(p, vpn, v);
          shadow.get(p)![vpn] = v;
        }
        check(m);
        for (const [q, vals] of shadow) vals.forEach((v, vpn) => expect(m.read(q, vpn)).toBe(v));
      }
    }
  });

  test("fork copies PTEs and no frames, and marks both sides read-only", () => {
    const m = new CowMemory();
    const p = m.spawn("parent", ["A", "B", "C", "D"]);
    expect(m.usedFrames()).toBe(4);
    const c = m.fork(p);
    expect(m.usedFrames()).toBe(4);
    expect(m.stats.ptesCopied).toBe(4);
    for (const f of m.frames.values()) expect(f.refs).toBe(2);
    for (const q of [p, c]) for (const e of q.ptes.values()) expect(e.writable).toBe(false);
  });

  test("the predict question: child writes, then parent writes: one copy, one reuse", () => {
    const m = new CowMemory();
    const p = m.spawn("parent", ["A", "B", "C", "D"]);
    const c = m.fork(p);
    expect(m.write(c, 0, "x").kind).toBe("copy");
    expect(m.write(p, 0, "y").kind).toBe("reuse");
    expect(m.stats).toMatchObject({ copies: 1, reuses: 1, faults: 2 });
    // A second write has no fault at all.
    expect(m.write(c, 0, "z").kind).toBe("in-place");
    expect(m.stats.faults).toBe(2);
  });

  test("after the child exits, the parent's next write faults and reuses", () => {
    const m = new CowMemory();
    const p = m.spawn("parent", ["A"]);
    const c = m.fork(p);
    m.exit(c);
    expect(p.ptes.get(0)!.writable).toBe(false);
    expect(m.write(p, 0, "x").kind).toBe("reuse");
    expect(m.stats.copies).toBe(0);
  });

  test("KSM merges equal frames into one read-only frame, and a later write splits it", () => {
    const m = new CowMemory();
    const p = m.spawn("parent", ["A", "B"]);
    const c = m.fork(p);
    m.write(c, 0, "x");
    m.write(p, 1, "x");
    const before = m.usedFrames();
    expect(m.ksmMerge()).toBe(1);
    expect(m.usedFrames()).toBe(before - 1);
    check(m);
    expect(c.ptes.get(0)!.frame).toBe(p.ptes.get(1)!.frame);
    expect(c.ptes.get(0)!.writable).toBe(false);
    expect(m.write(c, 0, "y").kind).toBe("copy");
    expect(m.read(p, 1)).toBe("x");
  });
});

describe("numbers in the lesson", () => {
  const S = SNAPSHOT_DEFAULTS;
  const G = 2 ** 30;
  test("16 GiB at 200 MiB/s takes 81.9 s; 10,000 writes/s copy 744,164 pages = 2.84 GiB = 17.7%", () => {
    const r = snapshotExtra(S);
    expect(r.seconds.toFixed(1)).toBe("81.9");
    expect(r.writes).toBeCloseTo(819200, 3);
    expect(Math.round(r.copiedPages)).toBe(744164);
    expect((r.extraBytes / G).toFixed(2)).toBe("2.84");
    expect((r.extraShare * 100).toFixed(1)).toBe("17.7");
    expect(lesson).toContain("744,164");
  });
  test("100,000 writes/s: 85.8%, 13.7 GiB", () => {
    const r = snapshotExtra({ ...S, writesPerSec: 1e5 });
    expect((r.extraShare * 100).toFixed(1)).toBe("85.8");
    expect((r.extraBytes / G).toFixed(1)).toBe("13.7");
  });
  test("skew at 10,000 writes/s: 10.2%", () => {
    expect((snapshotExtra({ ...S, hotWrites: 0.9, hotPages: 0.1 }).extraShare * 100).toFixed(1)).toBe("10.2");
  });
  test("1,000 writes/s: 2 MiB pages copy everything, 4 KiB pages copy 1.9%", () => {
    expect(snapshotExtra({ ...S, writesPerSec: 1000, pageBytes: 2 ** 21 }).extraShare).toBeGreaterThan(0.9999);
    expect((snapshotExtra({ ...S, writesPerSec: 1000 }).extraShare * 100).toFixed(1)).toBe("1.9");
  });
  test("first-write costs: 1,381 ns, 196 µs, 512 times larger, from labelled model inputs", () => {
    expect(COW_COSTS.faultNs).toBe(1000);
    expect(COW_COSTS.copyGiBps).toBe(10);
    expect(COW_COSTS.storeNs).toBe(1);
    expect(Math.round(firstWriteNs(4096))).toBe(1381);
    expect(Math.round(firstWriteNs(2 ** 21) / 1000)).toBe(196);
    expect(2 ** 21 / 4096).toBe(512);
  });
  test("fork copies 2 MiB of PTEs per GiB, 32 MiB for 16 GiB", () => {
    expect(forkPteBytes(G)).toBe(2 * 2 ** 20);
    expect(forkPteBytes(16 * G)).toBe(32 * 2 ** 20);
  });
  test("the formula agrees with a run on the real COW model", () => {
    const d = 2000, w = 1500;
    let sum = 0;
    for (let s = 1; s <= 20; s++) sum += snapshotOnCow(d, w, mulberry32(s));
    expect(sum / 20 / distinctTouched(d, w)).toBeCloseTo(1, 1);
  });
});
