/** Pins for every number that the file system lessons quote. */
import { describe, expect, test } from "vitest";
import { EXT4_DEFAULTS, FAST_SYMLINK_LIMIT, MAX_SYMLINKS, MemFs, ROOT_INO, TABLE_SCENARIOS, ext4Layout, scenarioWrites } from "../../src/sims/os/fs/inodefs";
import { Dcache, NAME_MAX, PATH_MAX, STAT_COST_INPUTS, USER_CRED, ROOT_CRED, deviceReadNs, demoNamespace, statCost, statsPerSecond, walkPath } from "../../src/sims/os/fs/vfs";
import { ALLOC_DEFAULTS, AllocSim, EXT2_SPEC, FLEX_BG_GROUPS, EXT4_EXTENT, I_BLOCKS_CAP_BYTES, IndirectMap, ext2Limit, ext4Limits, fragReadCost, indirectMeta, mappingCompare, maxFileSize, type AllocPolicy } from "../../src/sims/os/fs/alloc";
import { COST_DEVICES, COST_INPUTS, EXT4_COMMIT_SECONDS, FSCK_INPUTS, exploreCrashes, fsckVsReplay, journalCost, outcomeCounts, writePlan } from "../../src/sims/os/fs/journal";
import { F2FS, FFS_WRITE_COST, HOT_COLD, breakEvenUtil, f2fsSegmentBytes, runLfs, writeAmpFormula, writeCostFormula } from "../../src/sims/os/fs/lfs";
import { CowTree, ZFS_TXG_SECONDS, absorbCost, commitCrashStates, pathBlocks } from "../../src/sims/os/fs/cowtree";
import { BURST_DEFAULTS, MEMINFO_EXAMPLE, READ_AHEAD_DEFAULT_KB, Readahead, VM_DEFAULTS, burstRun, dirtyLimits, freeOutput, memAvailable, posRatio, raPages, sequentialWindows } from "../../src/sims/os/fs/pagecache";

const KiB = 1024, MiB = 1024 * KiB, GiB = 1024 * MiB, TiB = 1024 * GiB;

describe("files, inodes and directories", () => {
  test("stat fields", () => {
    const fs = new MemFs({ blocks: 48, inodes: 16 });
    fs.create("/notes.txt");
    fs.write("/notes.txt", 0, 6000);
    expect(fs.stat("/notes.txt")).toMatchObject({ size: 6000, blocks512: 16, nlink: 1, blksize: 4096 });
    fs.create("/one");
    fs.write("/one", 0, 1);
    expect(fs.stat("/one")).toMatchObject({ blocks512: 8 });
  });

  test("the first demo's starting state and its steps", () => {
    const fs = new MemFs({ blocks: 48, inodes: 16 });
    fs.create("/notes.txt");
    fs.write("/notes.txt", 0, 6000);
    fs.mkdir("/docs");
    fs.create("/docs/plan.txt");
    fs.write("/docs/plan.txt", 0, 100);
    expect(fs.resolve("/notes.txt")).toBe(3);
    expect(fs.freeBlocks).toBe(43);
    fs.link("/notes.txt", "/n2");
    expect(fs.freeBlocks).toBe(43);
    expect(fs.statIno(3).nlink).toBe(2);
    fs.unlink("/n2");
    expect(fs.freeBlocks).toBe(43);
    const ino = fs.open("/notes.txt") as number;
    fs.unlink("/notes.txt");
    expect(fs.statIno(ino)).toMatchObject({ nlink: 0 });
    expect(fs.inodes.get(ino)!.openCount).toBe(1);
    expect(fs.orphans.size).toBe(1);
    expect(fs.freeBlocks).toBe(43);
    fs.close(ino);
    expect(fs.freeBlocks).toBe(45);
    // Write past the end: 40 blocks later, one block more.
    fs.create("/s");
    fs.write("/s", 0, 6000);
    const before = fs.statIno(fs.resolve("/s") as number).blocks512 / 8;
    fs.write("/s", 6000 + 40 * 4096, 1);
    expect(fs.statIno(fs.resolve("/s") as number).blocks512 / 8).toBe(before + 1);
  });

  test("directory link counts", () => {
    const fs = new MemFs({ blocks: 48, inodes: 16 });
    const rootLinks = fs.statIno(ROOT_INO).nlink;
    fs.mkdir("/d");
    expect(fs.stat("/d")).toMatchObject({ nlink: 2 });
    expect(fs.statIno(ROOT_INO).nlink).toBe(rootLinks + 1);
    fs.mkdir("/d/e");
    expect(fs.stat("/d")).toMatchObject({ nlink: 3 });
    expect(ROOT_INO).toBe(2);
  });

  test("symlink storage", () => {
    expect(FAST_SYMLINK_LIMIT).toBe(60);
    const fs = new MemFs({ blocks: 48, inodes: 16 });
    fs.symlink("x".repeat(59), "/short");
    expect(fs.stat("/short", false)).toMatchObject({ blocks512: 0 });
    fs.symlink("x".repeat(60), "/long");
    expect(fs.stat("/long", false)).toMatchObject({ blocks512: 8 });
  });

  test("a sparse file of 1 TiB has 0 blocks", () => {
    const fs = new MemFs({ blocks: 48, inodes: 16 });
    fs.create("/sparse.img");
    fs.truncate("/sparse.img", TiB);
    expect(fs.stat("/sparse.img")).toMatchObject({ size: TiB, blocks512: 0 });
  });

  test("ext4 layout", () => {
    const l = ext4Layout();
    expect(EXT4_DEFAULTS.inodeSize).toBe(256);
    expect(l.blocksPerGroup).toBe(32768);
    expect(l.groupBytes).toBe(128 * MiB);
    expect(l.inodesPerGroup).toBe(8192);
    expect(l.bytesPerInode).toBe(16 * KiB);
    expect(l.inodeTableBlocks).toBe(512);
    expect(l.inodeTableBytes).toBe(2 * MiB);
    expect(l.inodeTableFraction).toBe(0.015625);
  });

  test("where the writes land in each scenario", () => {
    const at = Object.fromEntries(TABLE_SCENARIOS.map((s) => [s.id, scenarioWrites(s)]));
    expect(at["two-opens"]).toEqual([0, 0]);
    expect(at.dup).toEqual([0, 100]);
    expect(at.fork).toEqual([0, 100, 200]);
    expect(at["fork-open"]).toEqual([0, 0]);
    expect(at.append).toEqual([0, 100]);
    expect(TABLE_SCENARIOS.find((s) => s.id === "two-opens")!.ops.length).toBe(4);
  });
});

describe("path lookup and the VFS", () => {
  test("limits", () => {
    expect(NAME_MAX).toBe(255);
    expect(PATH_MAX).toBe(4096);
    expect(MAX_SYMLINKS).toBe(40);
  });

  test("the walks that the steps describe", () => {
    const ns = demoNamespace();
    const dc = new Dcache();
    expect(walkPath(ns, "/home/kash/notes.txt", { dcache: dc })).toMatchObject({ checks: 3, misses: 3, hits: 0, endMode: "ref", error: null });
    expect(walkPath(ns, "/home/kash/notes.txt", { dcache: dc })).toMatchObject({ checks: 3, misses: 0, hits: 3, endMode: "rcu", error: null });
    expect(walkPath(ns, "/home/kash/missing", { dcache: dc })).toMatchObject({ error: "ENOENT", negative: 0, misses: 1 });
    expect(walkPath(ns, "/home/kash/missing", { dcache: dc })).toMatchObject({ error: "ENOENT", negative: 1, misses: 0, endMode: "rcu" });
    const denied = walkPath(ns, "/root/secret", { dcache: dc, cred: USER_CRED });
    expect(denied.error).toBe("EACCES");
    expect(denied.steps.at(-2)!.say).toContain("other bit");
    expect(walkPath(ns, "/root/secret", { cred: ROOT_CRED }).error).toBeNull();
    const far = walkPath(ns, "/home/kash/data/etc/passwd", { dcache: dc });
    expect(far).toMatchObject({ error: null, links: 2 });
    expect(far.mounts).toBeGreaterThanOrEqual(2);
    expect(far.node!.fs).toBe("ext4");
    expect(walkPath(ns, "/loop/a", { dcache: dc })).toMatchObject({ error: "ELOOP", links: 40 });
  });

  test("the cost model", () => {
    expect(STAT_COST_INPUTS).toEqual({ syscallNs: 200, hitNs: 40, searchNs: 2000, blockMissRate: 0.01 });
    const r = statCost({ depth: 5, hitRate: 0.99 });
    expect(Math.round(r.withDcache)).toBe(539);
    expect(Math.round(r.without)).toBe(14264);
    expect(r.ratio).toBeCloseTo(26.5, 1);
    expect(statsPerSecond(r.withDcache) / 1e6).toBeCloseTo(1.86, 2);
    const h = statCost({ depth: 5, hitRate: 0.99, device: "hdd" });
    expect(h.without / 1e3).toBeCloseTo(658, 0);
    expect(h.ratio).toBeCloseTo(94.3, 1);
    expect(statCost({ depth: 5, hitRate: 0.5 }).ratio).toBeCloseTo(1.9, 1);
    expect(deviceReadNs("nvme")).toBeCloseTo(81280, 0);
  });

  test("the cost is linear in depth", () => {
    const a = statCost({ depth: 2, hitRate: 0.9 }), b = statCost({ depth: 4, hitRate: 0.9 }), c = statCost({ depth: 6, hitRate: 0.9 });
    expect(c.withDcache - b.withDcache).toBeCloseTo(b.withDcache - a.withDcache, 6);
  });
});

describe("block allocation and extents", () => {
  const at = (policy: AllocPolicy, rounds = 120, writers = 3, chunk = 2) => {
    const s = new AllocSim({ ...ALLOC_DEFAULTS, policy, writers, chunk }).run(rounds);
    return s.metrics();
  };

  test("the grid at the defaults", () => {
    const i = at("immediate");
    expect(i.meanFragments).toBeCloseTo(11.33, 2);
    expect(i.extents).toBe(204);
    expect(i.extentMetaBytes).toBe(68 * KiB);
    expect(i.indirectMeta * 4096).toBe(60 * KiB);
    const d = at("delayed");
    expect(d.meanFragments).toBeCloseTo(2.28, 2);
    expect(d.extents).toBe(41);
    expect(d.extentMetaBytes).toBe(0);
    expect(at("prealloc").meanFragments).toBe(1);
    expect(at("immediate", 120, 1).meanFragments).toBe(1);
  });

  test("the slowdown columns at the defaults", () => {
    const i = at("immediate");
    const avg = (i.usedBlocks / i.files) * 4096;
    const one = fragReadCost(avg, 1), many = fragReadCost(avg, i.meanFragments);
    expect(many.hddMs / one.hddMs).toBeCloseTo(11, 0);
    expect(many.ssdMs / one.ssdMs).toBeCloseTo(8.6, 1);
  });

  test("the ext2 tree", () => {
    const m = maxFileSize(EXT2_SPEC);
    expect(m.ptrs).toBe(1024);
    expect(m.perLevel).toEqual([12, 1024, 1024 ** 2, 1024 ** 3]);
    expect(m.maxBlocks).toBe(1074791436);
    expect(m.maxBytes / TiB).toBeCloseTo(4, 1);
    expect(I_BLOCKS_CAP_BYTES).toBe(2 * TiB);
    expect(ext2Limit(4096).limit).toBe(2 * TiB);
    expect(ext2Limit(1024).tree / GiB).toBeCloseTo(16, 0);
    expect(ext2Limit(1024).limit).toBe(ext2Limit(1024).tree);
    expect(maxFileSize({ ...EXT2_SPEC, ptrBytes: 8 }).ptrs).toBe(512);
  });

  test("a 1 GiB file", () => {
    const n = GiB / 4096;
    const m = indirectMeta(n);
    expect(m.metaBlocks).toBe(257);
    expect(m.metaBytes / MiB).toBeCloseTo(1, 1);
    expect(m.overhead * 100).toBeCloseTo(0.098, 3);
    const c = mappingCompare(GiB, 1);
    expect(c.extents).toBe(8);
    expect(c.extentBytes).toBe(4 * KiB);
    expect(c.indirectBytes / c.extentBytes).toBe(257);
    const f = mappingCompare(GiB, 1000);
    expect(f.extents).toBe(1000);
    expect(f.extentBytes).toBe(12 * KiB);
    // Overhead settles near 4 bytes per 4 KiB.
    expect(indirectMeta(2 ** 30).overhead * 100).toBeCloseTo(0.1, 1);
  });

  test("a deep block needs 3 metadata reads", () => {
    const m = new IndirectMap();
    const deep = 12 + 1024 + 1024 ** 2 + 5;
    m.set(deep, 77);
    expect(m.get(deep)).toEqual({ physical: 77, reads: 3 });
    m.set(3, 8);
    expect(m.get(3).reads).toBe(0);
  });

  test("ext4 extent limits", () => {
    const l = ext4Limits();
    expect(l.inInode).toBe(4);
    expect(l.inBlock).toBe(340);
    expect(EXT4_EXTENT.maxInitLen).toBe(32768);
    expect(EXT4_EXTENT.maxUnwrittenLen).toBe(32767);
    expect(l.maxExtentBytes).toBe(128 * MiB);
    expect(l.maxFileBytes).toBe(16 * TiB);
    expect(l.maxVolumeBytes).toBe(1024 * 1024 * TiB);
    expect(l.extentsAtDepth1).toBe(1360);
    expect(EXT4_EXTENT.entryBytes / EXT2_SPEC.ptrBytes).toBe(3);
    expect(FLEX_BG_GROUPS).toBe(16);
  });

  test("fragmented reads", () => {
    const one = fragReadCost(GiB, 1), many = fragReadCost(GiB, 1000);
    expect(one.hddMs / 1e3).toBeCloseTo(5.38, 2);
    expect(many.hddMs / 1e3).toBeCloseTo(18.3, 1);
    expect(many.hddMs / one.hddMs).toBeCloseTo(3.4, 1);
    expect(one.ssdMs).toBeCloseTo(336, 0);
    expect(many.ssdMs).toBeCloseTo(417, 0);
    expect(many.ssdMs / one.ssdMs).toBeCloseTo(1.24, 2);
    expect(one.positionMs).toBeCloseTo(12.9, 1);
    expect(one.ssdRequestUs).toBeCloseTo(81, 0);
  });
});

describe("journaling", () => {
  const counts = (m: Parameters<typeof writePlan>[0], w: Parameters<typeof writePlan>[1], c: Parameters<typeof writePlan>[2] = "barrier") => {
    const p = writePlan(m, w, c);
    const o = outcomeCounts(p);
    return { total: exploreCrashes(p).length, ...Object.fromEntries(Object.entries(o).filter(([, n]) => n > 0)) };
  };

  test("every count that the lesson quotes", () => {
    expect(counts("none", "append")).toEqual({ total: 8, old: 2, new: 1, garbage: 1, leak: 2, dangling: 2 });
    expect(counts("ordered", "append")).toEqual({ total: 21, old: 16, new: 5 });
    expect(counts("writeback", "append")).toEqual({ total: 26, old: 16, new: 5, garbage: 5 });
    expect(counts("data", "append")).toEqual({ total: 25, old: 16, new: 9 });
    expect(counts("ordered", "overwrite")).toEqual({ total: 19, old: 4, new: 7, torn: 8 });
    expect(counts("data", "overwrite")).toEqual({ total: 25, old: 16, new: 9 });
    expect(counts("ordered", "append", "nobarrier")).toEqual({ total: 36, old: 24, new: 5, garbage: 1, corrupt: 6 });
    expect(counts("ordered", "append", "checksum")).toEqual({ total: 36, old: 30, new: 5, garbage: 1 });
  });

  test("the outcome of each subset in the no-journal table", () => {
    const by = Object.fromEntries(exploreCrashes(writePlan("none", "append")).map((c) => [[...c.durable].sort().join("+"), c.outcome]));
    expect(by).toEqual({ "": "old", D0: "old", I: "dangling", "D0+I": "dangling", B: "leak", "B+D0": "leak", "B+I": "garbage", "B+D0+I": "new" });
  });

  test("fsck and replay", () => {
    const f = fsckVsReplay(10e12);
    expect(f.inodeTableBytes / 1e9).toBeCloseTo(156.25, 2);
    expect(f.pass1Seconds / 60).toBeCloseTo(13, 0);
    expect(FSCK_INPUTS.mbps).toBe(200);
    expect(FSCK_INPUTS.journalBytes).toBe(GiB);
    expect(f.replaySeconds).toBeCloseTo(5.4, 1);
    expect(EXT4_COMMIT_SECONDS).toBe(5);
  });

  test("the cost model", () => {
    const base = { absorb: 8, entangled: 0, device: "hdd" as const };
    const ord = journalCost("ordered", { ...base, blocks: 1 }), dat = journalCost("data", { ...base, blocks: 1 }), wb = journalCost("writeback", { ...base, blocks: 1 });
    expect(ord.writeAmp).toBe(5.25);
    expect(dat.writeAmp).toBe(6.25);
    expect(ord.fsyncMs).toBeCloseTo(27.0, 1);
    expect(dat.fsyncMs).toBeCloseTo(14.0, 1);
    expect(dat.seeks).toBe(1);
    const big = { ...base, blocks: (10 * MiB) / 4096 };
    expect(big.blocks).toBe(2560);
    expect(journalCost("ordered", big).writeAmp).toBeCloseTo(1.0, 2);
    expect(journalCost("data", big).writeAmp).toBeCloseTo(2.01, 2);
    const ent = { ...base, blocks: 1, entangled: (100 * MiB) / 4096 };
    expect(journalCost("writeback", ent).fsyncMs).toBeCloseTo(27.0, 1);
    expect(wb.fsyncMs).toBeCloseTo(27.0, 1);
    expect(journalCost("ordered", ent).fsyncMs).toBeCloseTo(564, 0);
    // One commit per checkpoint pays the metadata in full.
    expect(journalCost("ordered", { ...base, absorb: 1, blocks: 1 }).checkpoint).toBe(COST_INPUTS.metaPerCommit);
    // On NVMe the two modes are close.
    const n = { absorb: 8, entangled: 0, blocks: 1, device: "nvme" as const };
    expect(journalCost("ordered", n).fsyncMs / journalCost("data", n).fsyncMs).toBeLessThan(1.1);
    expect(COST_DEVICES.hdd.mbps).toBe(200);
  });
});

describe("log-structured and copy-on-write", () => {
  test("the formula", () => {
    expect(writeCostFormula(0.5)).toBe(4);
    expect(writeCostFormula(0.8)).toBeCloseTo(10, 9);
    expect(writeCostFormula(0.75)).toBe(8);
    expect(writeAmpFormula(0.5)).toBe(2);
    expect(FFS_WRITE_COST).toEqual({ today: 10, improved: 4 });
    expect(breakEvenUtil(4)).toBe(0.5);
    expect(breakEvenUtil(10)).toBeCloseTo(0.8, 9);
    expect(HOT_COLD).toEqual({ hotFraction: 0.1, hotWrites: 0.9 });
  });

  test("the simulated values", () => {
    const u75 = runLfs({ util: 0.75, workload: "uniform", policy: "greedy" });
    expect(u75.writeCost).toBeCloseTo(5.06, 2);
    expect(u75.meanCleanedUtil).toBeCloseTo(0.61, 2);
    expect(writeCostFormula(u75.meanCleanedUtil)).toBeCloseTo(5, 0);
    expect(runLfs({ util: 0.8, workload: "uniform", policy: "greedy" }).writeCost).toBeCloseTo(6.52, 2);
    expect(runLfs({ util: 0.8, workload: "hotcold", policy: "greedy" }).writeCost).toBeCloseTo(5.72, 2);
    expect(runLfs({ util: 0.8, workload: "hotcold", policy: "cost-benefit" }).writeCost).toBeCloseTo(4.92, 2);
    expect(runLfs({ util: 0.4, workload: "hotcold", policy: "greedy" }).writeCost).toBeCloseTo(2.42, 2);
    expect(runLfs({ util: 0.4, workload: "uniform", policy: "greedy" }).writeCost).toBeCloseTo(2.27, 2);
    expect(runLfs({ util: 0.9, workload: "hotcold", policy: "cost-benefit" }).writeCost).toBeCloseTo(15.2, 1);
    expect(runLfs({ util: 0.9, workload: "hotcold", policy: "greedy" }).writeCost).toBeCloseTo(11.3, 1);
  });

  test("cost-benefit beats greedy on hot and cold data from 50% to 85%", () => {
    for (const util of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85]) {
      expect(runLfs({ util, workload: "hotcold", policy: "cost-benefit" }).writeCost).toBeLessThan(runLfs({ util, workload: "hotcold", policy: "greedy" }).writeCost);
    }
  });

  test("F2FS", () => {
    expect(f2fsSegmentBytes()).toBe(2 * MiB);
    expect(F2FS.blocksPerSegment).toBe(512);
    expect(F2FS.logs).toBe(6);
  });

  test("the tour of the COW demo", () => {
    const t = new CowTree(2, 3);
    expect(t.blocks.size).toBe(15);
    expect(t.leaves).toBe(8);
    expect(pathBlocks(3)).toBe(4);
    const go = (leaf: number, v: string) => { const u = t.update("live", leaf, v); return [u.copied.length, u.freed.length, t.blocks.size]; };
    expect(go(2, "A")).toEqual([4, 4, 15]);
    t.snapshot("live", "s1");
    expect(t.blocks.size).toBe(15);
    expect(go(2, "B")).toEqual([4, 0, 19]);
    expect(go(2, "C")).toEqual([4, 4, 19]);
    expect(go(5, "D")).toEqual([4, 1, 22]);
    expect(t.space()).toEqual({ total: 22, live: 15, pinned: 7 });
    const before = t.blocks.size;
    t.clone("s1", "c1");
    expect(t.blocks.size).toBe(before);
    expect(t.deleteDataset("c1").length).toBe(0);
    expect(t.deleteSnapshot("s1").length).toBe(7);
    expect(t.blocks.size).toBe(15);
  });

  test("commit crash states and grouping", () => {
    expect(commitCrashStates(2, 3)).toMatchObject({ total: 17, oldReads: 16, newReads: 1, wrong: 0, newBlocks: 4 });
    expect(commitCrashStates(2, 3, false)).toMatchObject({ total: 32, detected: 15, wrong: 0 });
    expect(absorbCost(3, 1000)).toEqual({ separate: 4000, together: 4 });
    expect(ZFS_TXG_SECONDS).toBe(5);
  });
});

describe("the page cache and writeback", () => {
  test("defaults", () => {
    expect(VM_DEFAULTS).toEqual({ dirtyRatio: 20, dirtyBackgroundRatio: 10, dirtyExpireCentisecs: 3000, dirtyWritebackCentisecs: 500 });
    expect(VM_DEFAULTS.dirtyExpireCentisecs / 100).toBe(30);
    expect(VM_DEFAULTS.dirtyWritebackCentisecs / 100).toBe(5);
    expect(BURST_DEFAULTS).toMatchObject({ dirtyableMiB: 16384, diskMiBps: 200, writerMiBps: 2000, burstMiB: 8192 });
  });

  test("the thresholds", () => {
    const l = dirtyLimits(16384, 20, 10);
    expect(Math.round(l.bg)).toBe(1638);
    expect(Math.round(l.freerun)).toBe(2458);
    expect(Math.round(l.setpoint)).toBe(2867);
    expect(Math.round(l.limit)).toBe(3277);
    expect(posRatio(l.freerun, l)).toBe(2);
    expect(posRatio(l.setpoint, l)).toBe(1);
    expect(posRatio(l.limit, l)).toBe(0);
    // A background ratio at or above the limit becomes half of the limit.
    expect(dirtyLimits(16384, 20, 30).bg).toBeCloseTo(l.limit / 2, 6);
  });

  test("the burst", () => {
    expect(BURST_DEFAULTS.burstMiB / BURST_DEFAULTS.writerMiBps).toBeCloseTo(4.1, 1);
    expect(BURST_DEFAULTS.burstMiB / BURST_DEFAULTS.diskMiBps).toBeCloseTo(41, 0);
    const r = burstRun();
    expect(r.firstFlushAt).toBeCloseTo(0.8, 1);
    expect(r.throttleAt).toBeCloseTo(1.3, 1);
    expect(r.burstDoneAt).toBeCloseTo(27.8, 1);
    expect(Math.round(r.meanWriterRate!)).toBe(295);
    expect(r.syncAtBurstEnd).toBeCloseTo(14, 0);
    expect(r.peakDirty / 1024).toBeCloseTo(2.7, 1);
    expect((r.syncAtBurstEnd! * BURST_DEFAULTS.diskMiBps) / 1024).toBeCloseTo(2.7, 1);
  });

  test("a small burst waits for expiry", () => {
    const r = burstRun({ burstMiB: 1000 });
    expect(r.bgAt).toBeNull();
    expect(r.firstFlushAt).toBeGreaterThanOrEqual(30);
    expect(r.firstFlushAt).toBeLessThan(30.2);
    expect(r.cleanAt).toBeCloseTo(35, 0);
  });

  test("small limits", () => {
    const r = burstRun({ dirtyRatio: 2, dirtyBackgroundRatio: 1 });
    expect(r.burstDoneAt).toBeCloseTo(39.6, 1);
    expect(r.syncAtBurstEnd).toBeCloseTo(1.5, 1);
  });

  test("a fast disk never slows the writer", () => {
    expect(burstRun({ diskMiBps: 3000 }).throttleAt).toBeNull();
  });

  test("read-ahead windows", () => {
    expect(READ_AHEAD_DEFAULT_KB).toBe(128);
    expect(raPages(128)).toBe(32);
    expect(sequentialWindows(128, 100)).toEqual([4, 8, 16, 32, 32, 32, 32]);
    expect(sequentialWindows(1024, 600)).toEqual([4, 16, 32, 64, 128, 256, 256, 256]);
    const r = new Readahead(32);
    const first = r.read(0);
    expect(first).toMatchObject({ event: "initial", sync: true });
    expect(r.size).toBe(4);
    expect(r.markers.has(1)).toBe(true);
    const second = r.read(1);
    expect(second).toMatchObject({ event: "marker", sync: false });
    expect(r.size).toBe(8);
    for (let i = 2; i < 100; i++) r.read(i);
    expect(r.syncMisses).toBe(1);
  });

  test("a jump starts no window, and the next read starts over at 4", () => {
    const r = new Readahead(32);
    for (let i = 0; i < 8; i++) r.read(i);
    expect(r.size).toBe(16);
    const j = r.read(100);
    expect(j).toMatchObject({ event: "random", sync: true, read: [100] });
    expect(r.size).toBe(16);
    r.read(101);
    expect(r.size).toBe(4);
  });

  test("the jump button lands on a page that the cache does not hold", () => {
    const r = new Readahead(32);
    for (let i = 0; i < 32; i++) r.read(i);
    const t = r.jumpTarget(32, 192);
    expect(r.read(t).event).toBe("random");
    expect(r.read(t + 1).event).toBe("initial");
    expect(r.size).toBe(4);
  });

  test("percentages suit large RAM badly", () => {
    const l = dirtyLimits(1024 * 1024, VM_DEFAULTS.dirtyRatio, VM_DEFAULTS.dirtyBackgroundRatio);
    expect(l.limit / BURST_DEFAULTS.diskMiBps / 60).toBeGreaterThan(10);
  });

  test("the free example", () => {
    const f = freeOutput(MEMINFO_EXAMPLE);
    expect(f).toEqual({ total: 16000, free: 600, shared: 200, buffCache: 10000, available: 10050, usedOld: 5400, usedNew: 5950 });
    expect(memAvailable(MEMINFO_EXAMPLE)).toBe(10050);
  });
});
