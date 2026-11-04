/** Property tests for the file system sims: each sim against a simple reference, over random operations. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "../../src/sims/rng";
import { MemFs, MAX_SYMLINKS, OpenTables } from "../../src/sims/os/fs/inodefs";
import { BlockBitmap, EXT2_SPEC, ExtentMap, IndirectMap, AllocSim, ALLOC_DEFAULTS, extentsOf, indirectMeta, type AllocPolicy } from "../../src/sims/os/fs/alloc";
import { Dcache, ROOT_CRED, USER_CRED, demoNamespace, walkPath } from "../../src/sims/os/fs/vfs";
import { atomic, classify, dataOk, diskOrder, enumerateCrashStates, exploreCrashes, isCrashState, metadataOk, orderMask, recover, writePlan, type CommitPolicy, type JWorkload, type JournalMode } from "../../src/sims/os/fs/journal";
import { Lfs, lfsStream, runLfs } from "../../src/sims/os/fs/lfs";
import { CowTree, commitCrashStates } from "../../src/sims/os/fs/cowtree";
import { PageCache, Readahead, burstRun, dirtyLimits, posRatio, writebackRun, BURST_DEFAULTS } from "../../src/sims/os/fs/pagecache";

describe("MemFs against a Map model", () => {
  // The reference: a path to an identity, an identity to a size and a link count. It knows nothing of blocks.
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`random create, link, unlink, rename, write (seed ${seed})`, () => {
      const rng = mulberry32(seed);
      const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)]!;
      const fs = new MemFs({ blocks: 400, inodes: 60 });
      fs.mkdir("/a");
      fs.mkdir("/b");
      const names = ["/x", "/y", "/z", "/a/x", "/a/y", "/b/x", "/b/w"];
      const model = new Map<string, number>();
      const blocks = new Map<number, number>(); // identity -> blocks
      let nextId = 1;
      const links = (id: number) => [...model.values()].filter((v) => v === id).length;

      for (let i = 0; i < 1500; i++) {
        const p = pick(names), q = pick(names);
        const op = Math.floor(rng() * 5);
        if (op === 0) {
          const r = fs.create(p);
          if (model.has(p)) expect(r).toBe("EEXIST");
          else { expect(r).toBeNull(); model.set(p, nextId); blocks.set(nextId, 0); nextId++; }
        } else if (op === 1) {
          const r = fs.link(p, q);
          if (!model.has(p)) expect(r).toBe("ENOENT");
          else if (model.has(q)) expect(r).toBe("EEXIST");
          else { expect(r).toBeNull(); model.set(q, model.get(p)!); }
        } else if (op === 2) {
          const r = fs.unlink(p);
          if (!model.has(p)) expect(r).toBe("ENOENT");
          else {
            expect(r).toBeNull();
            const id = model.get(p)!;
            model.delete(p);
            if (links(id) === 0) blocks.delete(id);
          }
        } else if (op === 3) {
          const r = fs.rename(p, q);
          if (!model.has(p)) expect(r).toBe("ENOENT");
          else {
            expect(r).toBeNull();
            const id = model.get(p)!;
            const old = model.get(q);
            if (old !== id) {
              model.delete(p);
              model.set(q, id);
              if (old !== undefined && links(old) === 0) blocks.delete(old);
            }
          }
        } else if (model.has(p)) {
          // Append one block.
          const st = fs.stat(p);
          if (typeof st !== "string" && fs.freeBlocks > 0 && st.size < 40960) {
            const size = st.size;
            expect(fs.write(p, size, 4096)).toBeNull();
            const id = model.get(p)!;
            blocks.set(id, blocks.get(id)! + 1);
          }
        }
        if (i % 25 === 0 || i === 1499) {
          expect(fs.check()).toEqual([]);
          // Every name gives the right link count and block count, and names with one identity share one inode.
          const inoOf = new Map<number, number>();
          for (const [path, id] of model) {
            const st = fs.stat(path);
            expect(typeof st).not.toBe("string");
            if (typeof st === "string") continue;
            expect(st.nlink).toBe(links(id));
            expect(st.blocks512).toBe(blocks.get(id)! * 8);
            if (inoOf.has(id)) expect(st.ino).toBe(inoOf.get(id));
            inoOf.set(id, st.ino);
          }
          // Free space: the root and the 2 directories hold one block each, and files hold what the model says.
          const data = [...new Set(model.values())].reduce((a, id) => a + blocks.get(id)!, 0);
          expect(fs.totalBlocks - fs.freeBlocks).toBe(3 + data);
          expect(fs.inodes.size).toBe(3 + new Set(model.values()).size);
        }
      }
    });
  }

  test("an open file keeps its blocks until the last close, in any order", () => {
    const rng = mulberry32(9);
    for (let t = 0; t < 200; t++) {
      const fs = new MemFs({ blocks: 64, inodes: 8 });
      fs.create("/f");
      fs.write("/f", 0, 8192);
      const ino = fs.resolve("/f") as number;
      const free = fs.freeBlocks;
      let opens = 0, names = 1;
      fs.link("/f", "/g");
      names++;
      for (let k = 0; k < 8; k++) {
        const r = rng();
        const name = fs.resolve("/g") === ino ? "/g" : "/f";
        if (r < 0.4 && names > 0) { fs.open(name); opens++; }
        else if (r < 0.7 && opens > 0) { fs.close(ino); opens--; }
        else if (names > 0 && fs.unlink(name) === null) names--;
        const alive = names > 0 || opens > 0;
        expect(fs.inodes.has(ino)).toBe(alive);
        expect(fs.freeBlocks).toBe(alive ? free : free + 2);
        expect(fs.check()).toEqual([]);
        if (!alive) break;
      }
    }
  });

  test("rename: edge cases that keep the tree a tree", () => {
    const fs = new MemFs({ blocks: 64, inodes: 16 });
    fs.mkdir("/d");
    fs.mkdir("/d/e");
    fs.create("/f");
    fs.create("/d/g");
    expect(fs.rename("/d", "/d/e/x")).toBe("EINVAL");
    expect(fs.rename("/f", "/d")).toBe("EISDIR");
    expect(fs.rename("/d", "/f")).toBe("ENOTDIR");
    fs.mkdir("/h");
    expect(fs.rename("/h", "/d")).toBe("ENOTEMPTY");
    expect(fs.rename("/h", "/d/e")).toBeNull();
    expect(fs.check()).toEqual([]);
    expect(fs.rmdir("/d")).toBe("ENOTEMPTY");
    expect(fs.link("/d", "/dd")).toBe("EPERM");
    fs.link("/f", "/f2");
    const before = fs.inodes.size;
    expect(fs.rename("/f", "/f2")).toBeNull();
    expect(fs.inodes.size).toBe(before);
    expect(fs.check()).toEqual([]);
  });

  test("symlinks: a dangling link, and the limit", () => {
    const fs = new MemFs({ blocks: 128, inodes: 64 });
    fs.create("/t");
    fs.symlink("/t", "/s");
    expect(fs.stat("/s")).toMatchObject({ kind: "file" });
    expect(fs.stat("/s", false)).toMatchObject({ kind: "symlink", nlink: 1 });
    expect(fs.statIno(fs.resolve("/t") as number).nlink).toBe(1);
    fs.unlink("/t");
    expect(fs.stat("/s")).toBe("ENOENT");
    fs.symlink("/b", "/a");
    fs.symlink("/a", "/b");
    expect(fs.stat("/a")).toBe("ELOOP");
    // A chain of exactly MAX_SYMLINKS works, and one more fails.
    fs.create("/end");
    let prev = "/end";
    for (let i = 0; i < MAX_SYMLINKS; i++) { fs.symlink(prev, `/l${i}`); prev = `/l${i}`; }
    expect(typeof fs.stat(prev)).toBe("object");
    fs.symlink(prev, "/over");
    expect(fs.stat("/over")).toBe("ELOOP");
    expect(fs.check()).toEqual([]);
  });

  test("sparse writes allocate only what they touch, and truncate frees the rest", () => {
    const fs = new MemFs({ blocks: 64, inodes: 8 });
    fs.create("/f");
    fs.write("/f", 4096 * 1000, 1);
    expect(fs.stat("/f")).toMatchObject({ size: 4096 * 1000 + 1, blocks512: 8 });
    fs.write("/f", 0, 1);
    expect(fs.stat("/f")).toMatchObject({ blocks512: 16 });
    fs.truncate("/f", 10);
    expect(fs.stat("/f")).toMatchObject({ size: 10, blocks512: 8 });
    expect(fs.check()).toEqual([]);
    expect(fs.write("/f", 4096, 4096 * 100)).toBe("ENOSPC");
    expect(fs.stat("/f")).toMatchObject({ blocks512: 8 });
  });
});

describe("OpenTables", () => {
  test("reference counts hold, and shared offsets stay shared, under random operations", () => {
    const rng = mulberry32(3);
    for (let run = 0; run < 40; run++) {
      const t = new OpenTables({ a: { ino: 1, size: 0 }, b: { ino: 2, size: 0 } });
      for (let i = 0; i < 150; i++) {
        const pids = [...t.procs.keys()];
        const pid = pids[Math.floor(rng() * pids.length)]!;
        const fds = [...t.procs.get(pid)!.fds.keys()];
        const fd = fds[Math.floor(rng() * fds.length)];
        const r = rng();
        if (r < 0.25) t.open(pid, rng() < 0.5 ? "a" : "b");
        else if (r < 0.4 && fd !== undefined) t.dup(pid, fd);
        else if (r < 0.5 && pids.length < 5) t.fork(pid);
        else if (r < 0.8 && fd !== undefined) {
          const id = t.procs.get(pid)!.fds.get(fd)!;
          const before = t.files.get(id)!.offset;
          expect(t.write(pid, fd, 10)).toBe(before);
          // All fds on one description see the new offset.
          for (const p of t.procs.values()) for (const f of p.fds.values()) if (f === id) expect(t.files.get(f)!.offset).toBe(before + 10);
        } else if (fd !== undefined) t.close(pid, fd);
        expect(t.check()).toEqual([]);
      }
    }
  });
});

describe("mapping structures against a plain array", () => {
  test("IndirectMap and ExtentMap agree with a reference", () => {
    const rng = mulberry32(21);
    const ind = new IndirectMap();
    const ext = new ExtentMap();
    const ref = new Map<number, number>();
    let phys = 5000;
    for (let i = 0; i < 4000; i++) {
      const logical = rng() < 0.5 ? Math.floor(rng() * 1200) : Math.floor(rng() * 2_000_000);
      if (ref.has(logical)) continue;
      phys += rng() < 0.7 ? 1 : Math.floor(rng() * 50) + 2;
      ref.set(logical, phys);
      expect(ind.set(logical, phys)).toBe(true);
      ext.set(logical, phys);
    }
    for (const [l, p] of ref) {
      expect(ind.get(l).physical).toBe(p);
      expect(ext.get(l)).toBe(p);
    }
    for (let i = 0; i < 2000; i++) {
      const l = Math.floor(rng() * 3_000_000);
      if (!ref.has(l)) { expect(ind.get(l).physical).toBeUndefined(); expect(ext.get(l)).toBeUndefined(); }
    }
    for (let k = 1; k < ext.extents.length; k++) {
      const a = ext.extents[k - 1]!, b = ext.extents[k]!;
      expect(a.logical + a.len).toBeLessThanOrEqual(b.logical);
    }
  });

  test("the real tree allocates exactly what indirectMeta predicts", () => {
    for (const n of [1, 12, 13, 1036, 1037, 2060, 2061, 5000, 1048576 + 12 + 1024 + 1]) {
      const m = new IndirectMap();
      for (let i = 0; i < Math.min(n, 3000); i++) m.set(i, i);
      if (n <= 3000) expect(m.metaBlocks).toBe(indirectMeta(n, EXT2_SPEC).metaBlocks);
    }
  });

  test("extentsOf equals the merged ExtentMap for runs under the limit", () => {
    const rng = mulberry32(4);
    for (let t = 0; t < 50; t++) {
      const blocks: number[] = [];
      let p = 100;
      for (let i = 0; i < 300; i++) { p += rng() < 0.8 ? 1 : 3 + Math.floor(rng() * 9); blocks.push(p); }
      const e = new ExtentMap();
      blocks.forEach((b, i) => e.set(i, b));
      expect(e.extents.length).toBe(extentsOf(blocks));
    }
  });

  test("a run longer than the limit needs more than one extent", () => {
    expect(extentsOf(Array.from({ length: 10 }, (_, i) => i), 4)).toBe(3);
  });

  test("the bitmap: allocRuns covers the request with distinct free blocks", () => {
    const b = new BlockBitmap(256);
    for (let i = 0; i < 100; i++) b.set(Math.floor(i * 2.5));
    const free = b.free;
    const runs = b.allocRuns(0, 60);
    expect(runs.reduce((a, r) => a + r.len, 0)).toBe(60);
    expect(b.free).toBe(free - 60);
    for (const r of runs) for (let i = 0; i < r.len; i++) { b.clear(r.start + i); }
    expect(b.free).toBe(free);
  });

  test("AllocSim never double-allocates or leaks", () => {
    for (const policy of ["immediate", "delayed", "prealloc"] as AllocPolicy[]) {
      for (const writers of [1, 3, 6]) {
        const s = new AllocSim({ ...ALLOC_DEFAULTS, policy, writers, chunk: 3, seed: writers });
        for (let i = 0; i < 300; i++) { s.step(); expect(s.check()).toEqual([]); }
      }
    }
  });
});

describe("the path walk", () => {
  test("a walk makes one permission check per component, and a second walk asks no file system", () => {
    const ns = demoNamespace();
    const dc = new Dcache();
    const first = walkPath(ns, "/usr/bin/ls", { dcache: dc });
    expect(first).toMatchObject({ error: null, checks: 3, misses: 3, hits: 0, endMode: "ref" });
    const second = walkPath(ns, "/usr/bin/ls", { dcache: dc });
    expect(second).toMatchObject({ error: null, checks: 3, misses: 0, hits: 3, endMode: "rcu" });
    expect(second.steps.some((s) => s.kind === "dirread")).toBe(false);
  });

  test("an LRU dcache and no dcache give the same answers as a large dcache", () => {
    const paths = ["/etc/passwd", "/bin/ls", "/mnt/data/logs/app.log", "/home/kash/latest", "/home/kash/data/etc/passwd", "/nope", "/root/secret", "/etc/passwd/x", "/loop/a", "/tmp/sock", "/mnt/data/hidden-by-mount"];
    const rng = mulberry32(13);
    const nsA = demoNamespace(), nsB = demoNamespace(), nsC = demoNamespace();
    const big = new Dcache(10000), small = new Dcache(3);
    for (let i = 0; i < 400; i++) {
      const p = paths[Math.floor(rng() * paths.length)]!;
      const cred = rng() < 0.5 ? USER_CRED : ROOT_CRED;
      const a = walkPath(nsA, p, { dcache: big, cred }), b = walkPath(nsB, p, { dcache: small, cred }), c = walkPath(nsC, p, { dcache: null, cred });
      expect(b.error).toBe(a.error);
      expect(c.error).toBe(a.error);
      expect(b.node?.name).toBe(a.node?.name);
      expect(c.node?.name).toBe(a.node?.name);
      expect(small.size).toBeLessThanOrEqual(3);
    }
  });

  test("a mount hides the directory below it", () => {
    const ns = demoNamespace();
    expect(walkPath(ns, "/mnt/data/hidden-by-mount").error).toBe("ENOENT");
    expect(walkPath(ns, "/mnt/data/logs/app.log").node?.fs).toBe("xfs");
  });

  test("the owner class wins even when other has the bit", () => {
    const ns = demoNamespace();
    ns.rootMount.root.children!.get("home")!.children!.get("kash")!.mode = 0o077;
    expect(walkPath(ns, "/home/kash/notes.txt").error).toBe("EACCES");
    expect(walkPath(ns, "/home/kash/notes.txt", { cred: ROOT_CRED }).error).toBeNull();
  });
});

describe("the journal: exhaustive crash states", () => {
  const modes: JournalMode[] = ["none", "writeback", "ordered", "data"];
  const works: JWorkload[] = ["append", "overwrite"];
  const commits: CommitPolicy[] = ["barrier", "nobarrier", "checksum"];

  test("every disk order's prefixes are crash states, and the enumeration is complete", () => {
    for (const m of modes) for (const w of works) for (const c of commits) {
      const p = writePlan(m, w, c);
      const all = new Set(enumerateCrashStates(p));
      const seen = new Set<number>();
      for (let seed = 0; seed < 400; seed++) {
        const o = diskOrder(p, seed);
        expect([...o].sort((a, b) => a - b)).toEqual(p.writes.map((_, i) => i));
        for (let k = 0; k <= o.length; k++) {
          const mask = orderMask(o, k);
          expect(isCrashState(p, mask)).toBe(true);
          seen.add(mask);
        }
      }
      // Every state that random orders reach is enumerated, and they reach nearly all of them.
      for (const s of seen) expect(all.has(s)).toBe(true);
      expect(seen.size / all.size).toBeGreaterThan(0.75);
    }
  });

  test("data and ordered modes: replay gives a consistent state at every crash point", () => {
    for (const w of works) for (const m of ["data", "ordered"] as JournalMode[]) {
      for (const c of exploreCrashes(writePlan(m, w))) {
        expect(metadataOk(c.outcome), `${m} ${w} ${c.durable}`).toBe(true);
        expect(dataOk(c.outcome), `${m} ${w} ${c.durable}`).toBe(true);
        if (m === "data" || w === "append") expect(atomic(c.outcome), `${m} ${w} ${c.durable}`).toBe(true);
      }
    }
  });

  test("writeback mode: metadata is always consistent, and only data can be wrong", () => {
    for (const w of works) for (const c of exploreCrashes(writePlan("writeback", w))) expect(metadataOk(c.outcome)).toBe(true);
  });

  test("replay is idempotent: a crash during replay leaves what the replay would leave", () => {
    for (const m of ["writeback", "ordered", "data"] as JournalMode[]) for (const w of works) {
      const p = writePlan(m, w);
      for (const c of exploreCrashes(p)) {
        const r = c.recovery;
        if (!r.replayed) continue;
        // Any subset of home blocks already copied: another replay gives the same home blocks.
        let mask = c.mask;
        p.writes.forEach((x, i) => { if (x.area === "home" && r.home[x.id] === "new" && x.id[0] !== "J") mask |= 1 << i; });
        expect(recover(p, mask).home).toEqual(r.home);
      }
    }
  });

  test("once commit is durable under a barrier, the transaction survives; without it, it is discarded", () => {
    for (const m of ["ordered", "data"] as JournalMode[]) {
      const p = writePlan(m, "append");
      const txe = p.writes.findIndex((w) => w.id === "TxE");
      for (const c of exploreCrashes(p)) expect(c.outcome).toBe(c.mask & (1 << txe) ? "new" : "old");
    }
  });

  test("a checksum removes corruption from a missing flush", () => {
    for (const m of ["writeback", "ordered", "data"] as JournalMode[]) for (const w of works) {
      expect(exploreCrashes(writePlan(m, w, "nobarrier")).some((c) => c.outcome === "corrupt")).toBe(true);
      expect(exploreCrashes(writePlan(m, w, "checksum")).some((c) => c.outcome === "corrupt")).toBe(false);
    }
  });

  test("classify agrees with a direct reading of the home blocks", () => {
    const p = writePlan("none", "append");
    for (const m of enumerateCrashStates(p)) {
      const r = recover(p, m);
      const o = classify(p, r);
      if (r.home.I === "new" && r.home.B === "old") expect(o).toBe("dangling");
      if (r.home.I === "old" && r.home.B === "new") expect(o).toBe("leak");
    }
  });
});

describe("the log", () => {
  for (const policy of ["greedy", "cost-benefit"] as const) {
    test(`the cleaner never loses a block: reads match a Map model (${policy})`, () => {
      for (const util of [0.3, 0.6, 0.8]) {
        const segs = 24, bps = 32;
        const logical = Math.floor(util * segs * bps);
        const fs = new Lfs({ segments: segs, blocksPerSegment: bps, logical, policy, lowWater: 2, highWater: 3, ageSort: true });
        const model = new Map<number, number>();
        const next = lfsStream({ logical, workload: "hotcold", seed: 3 });
        for (let i = 0; i < logical * 12; i++) {
          const l = i < logical ? i : next();
          fs.write(l, i);
          model.set(l, i);
          if (i % 97 === 0) expect(fs.check()).toEqual([]);
        }
        expect(fs.check()).toEqual([]);
        for (const [l, v] of model) expect(fs.read(l)).toBe(v);
        expect(fs.stats.cleaned).toBeGreaterThan(0);
      }
    });
  }

  test("the demo geometry works at each slider value", () => {
    for (let u = 0.2; u <= 0.8001; u += 0.05) {
      for (const workload of ["uniform", "hotcold"] as const) {
        const logical = Math.floor(u * 24 * 32);
        const fs = new Lfs({ segments: 24, blocksPerSegment: 32, logical, policy: "greedy", lowWater: 2, highWater: 3, ageSort: true });
        const next = lfsStream({ logical, workload, seed: 5 });
        for (let i = 0; i < logical; i++) fs.write(i);
        for (let i = 0; i < logical * 6; i++) fs.write(next());
        expect(fs.check()).toEqual([]);
      }
    }
  });

  test("write cost grows with utilization", () => {
    let prev = 0;
    for (const u of [0.3, 0.5, 0.7, 0.85]) {
      const c = runLfs({ util: u, workload: "uniform", policy: "greedy" }).writeCost;
      expect(c).toBeGreaterThan(prev);
      prev = c;
    }
  });

  test("measured cost matches the formula at the cleaned utilization", () => {
    const r = runLfs({ util: 0.75, workload: "uniform", policy: "greedy" });
    expect(r.writeCost).toBeCloseTo(2 / (1 - r.meanCleanedUtil), 0);
  });
});

describe("the copy-on-write tree", () => {
  test("snapshots never change, whatever happens later, and counts stay right", () => {
    for (const seed of [1, 2, 3, 4]) {
      const rng = mulberry32(seed);
      const t = new CowTree(3, 3);
      const snaps = new Map<string, string[]>();
      const refs = new Map<string, string[]>();
      refs.set("live", t.allLeaves(t.datasets.get("live")!));
      let n = 0;
      for (let i = 0; i < 500; i++) {
        const r = rng();
        const ds = [...t.datasets.keys()];
        const d = ds[Math.floor(rng() * ds.length)]!;
        const sn = [...snaps.keys()];
        if (r < 0.7) {
          const leaf = Math.floor(rng() * t.leaves);
          const v = `u${i}`;
          t.update(d, leaf, v);
          refs.get(d)![leaf] = v;
        } else if (r < 0.82) {
          const name = `s${n++}`;
          t.snapshot(d, name);
          snaps.set(name, [...refs.get(d)!]);
        } else if (r < 0.88 && sn.length) {
          const s = sn[Math.floor(rng() * sn.length)]!;
          const name = `c${n++}`;
          t.clone(s, name);
          refs.set(name, [...snaps.get(s)!]);
        } else if (r < 0.95 && sn.length) {
          const s = sn[Math.floor(rng() * sn.length)]!;
          t.deleteSnapshot(s);
          snaps.delete(s);
        } else if (ds.length > 1 && d !== "live") {
          t.deleteDataset(d);
          refs.delete(d);
        }
        expect(t.check()).toEqual([]);
        for (const [name, want] of snaps) expect(t.allLeaves(t.snapshots.get(name)!.root)).toEqual(want);
        for (const [name, want] of refs) expect(t.allLeaves(t.datasets.get(name)!)).toEqual(want);
      }
      // Delete everything but live: only the live tree stays.
      for (const s of [...snaps.keys()]) t.deleteSnapshot(s);
      for (const d of [...t.datasets.keys()]) if (d !== "live") t.deleteDataset(d);
      expect(t.check()).toEqual([]);
      expect(t.blocks.size).toBe((Math.pow(3, 4) - 1) / 2);
    }
  });

  test("a scrub finds each flipped block once, and a mirror repairs it", () => {
    const rng = mulberry32(6);
    for (const mirrored of [false, true]) {
      const t = new CowTree(2, 4, undefined, mirrored);
      t.update("live", 3, "x");
      t.snapshot("live", "s");
      t.update("live", 9, "y");
      expect(t.scrub()).toMatchObject({ bad: [], checked: t.blocks.size });
      const ids = [...t.blocks.keys()];
      const hit = new Set<number>();
      for (let i = 0; i < 6; i++) hit.add(ids[Math.floor(rng() * ids.length)]!);
      for (const id of hit) t.corrupt(id);
      const r = t.scrub();
      expect(new Set(r.bad)).toEqual(hit);
      if (mirrored) { expect(r.repaired.length).toBe(hit.size); expect(t.scrub().bad).toEqual([]); }
      else expect(r.lost.length).toBe(hit.size);
    }
  });

  test("a commit crash never reads wrong data, for several shapes", () => {
    for (const [f, d] of [[2, 2], [2, 3], [3, 3], [2, 5]] as const) {
      const c = commitCrashStates(f, d);
      expect(c.wrong).toBe(0);
      expect(c.oldReads + c.newReads).toBe(c.total);
      expect(c.newReads).toBe(1);
      const n = commitCrashStates(f, d, false);
      expect(n.detected).toBe(Math.pow(2, d + 1) - 1);
    }
  });
});

describe("the page cache", () => {
  test("dirty pages stay until writeback, reads see writes, a crash keeps only the disk", () => {
    const rng = mulberry32(17);
    const pc = new PageCache();
    const view = new Map<string, string>(), disk = new Map<string, string>();
    for (let i = 0; i < 3000; i++) {
      const f = rng() < 0.5 ? "a" : "b";
      const n = Math.floor(rng() * 16);
      const k = `${f}#${n}`;
      const r = rng();
      if (r < 0.45) { pc.write(f, n, `v${i}`); view.set(k, `v${i}`); }
      else if (r < 0.75) expect(pc.read(f, n)).toBe(view.get(k));
      else if (r < 0.85) { pc.fsync(f); for (const [x, v] of view) if (x.startsWith(`${f}#`)) disk.set(x, v); }
      else if (r < 0.95) {
        const dirty = pc.dirtyCount;
        pc.dropCaches();
        expect(pc.dirtyCount).toBe(dirty);
      } else if (r < 0.97) {
        pc.crash();
        view.clear();
        for (const [x, v] of disk) view.set(x, v);
      } else { pc.writeback(); for (const [x, v] of view) disk.set(x, v); }
      expect(Object.fromEntries(pc.disk)).toEqual(Object.fromEntries(disk));
    }
  });

  test("drop_caches keeps mapped pages", () => {
    const pc = new PageCache();
    pc.write("f", 0, "x");
    pc.write("f", 1, "y");
    pc.writeback();
    pc.map("f", 0);
    expect(pc.dropCaches()).toBe(1);
    expect(pc.pages.size).toBe(1);
  });

  test("the writeback run: conservation, limits and monotonic counters", () => {
    const rng = mulberry32(2);
    for (let t = 0; t < 40; t++) {
      const dirtyRatio = 1 + Math.floor(rng() * 60), bg = 1 + Math.floor(rng() * 50);
      const r = burstRun({ dirtyRatio, dirtyBackgroundRatio: bg, diskMiBps: 20 + rng() * 2000, burstMiB: 256 + rng() * 16000, writerMiBps: 100 + rng() * 4000 });
      let prev = r.samples[0]!;
      for (const s of r.samples) {
        expect(Math.abs(s.accepted - s.written - s.dirty)).toBeLessThan(1e-6);
        expect(s.written).toBeGreaterThanOrEqual(prev.written - 1e-9);
        expect(s.accepted).toBeGreaterThanOrEqual(prev.accepted - 1e-9);
        prev = s;
      }
      // Dirty memory passes the limit by at most one step of the writer.
      expect(r.peakDirty).toBeLessThanOrEqual(Math.max(r.limits.limit, r.limits.freerun) + 5000 * (r.samples[1]!.t - r.samples[0]!.t) + 1);
    }
  });

  test("the position ratio falls monotonically from free run to the limit", () => {
    const l = dirtyLimits(16384, 20, 10);
    let prev = Infinity;
    for (let d = l.freerun; d <= l.limit; d += 10) {
      const r = posRatio(d, l);
      expect(r).toBeLessThanOrEqual(prev);
      prev = r;
    }
  });

  test("below the background threshold, only expiry starts the flusher", () => {
    const r = writebackRun({ ...BURST_DEFAULTS, burstMiB: 500 });
    expect(r.bgAt).toBeNull();
    expect(r.firstFlushAt).toBeGreaterThanOrEqual(30);
  });

  test("read-ahead: no page is read twice, and a read always leaves its page cached", () => {
    const rng = mulberry32(31);
    const ra = new Readahead(32);
    let total = 0;
    let idx = 0;
    for (let i = 0; i < 2000; i++) {
      idx = rng() < 0.8 ? idx + 1 : Math.floor(rng() * 4000);
      const r = ra.read(idx);
      total += r.read.length;
      expect(ra.cached.has(idx)).toBe(true);
      expect(ra.size).toBeLessThanOrEqual(32);
    }
    expect(total).toBe(ra.pagesRead);
    expect(ra.cached.size).toBe(ra.pagesRead);
  });
});
