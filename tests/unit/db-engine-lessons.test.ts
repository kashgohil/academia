/** Every number that the engine lessons quote, computed by src/sims/db/engine. */
import { describe, expect, test } from "vitest";
import {
  TinyKv, reopen, archEngine, archKey, traceOp, consequences, designAmp, cowWa,
  measure, deviceTime, WL_DEFAULTS, Campaign, FUZZ_CFG, BUGS, findAndShrink, replay, shrink, finish, IO_KINDS, cellKey,
  putSummary, PUT_DEFAULTS, rocksWalBytes, fitAll, MIX_DEFAULTS, type Choice, type Mix, type RealId,
} from "@/sims/db/engine";
import { mulberry32 } from "@/sims/rng";

// ---------------------------------------------------------------------------- lesson 1
describe("architecture-of-an-embedded-engine", () => {
  // The demo writes v1, v2, v3, ... (one number per put).
  let n = 0;
  const put = (k: string) => (e: TinyKv) => { const t = e.begin(); e.put(t, k, `v${++n}`); e.commit(t); };
  test("put + commit on k005: 3 hits, 4 records, 4,244 B, 1 write, 1 fsync, no page write", () => {
    const e = archEngine(24);
    const a = traceOp(e, "", put("k005")).delta;
    expect(a).toMatchObject({ treeVisits: 3, poolHits: 3, poolMisses: 0, logRecords: 4, logBytes: 4244, logWrites: 1, logFsyncs: 1, pageWrites: 0, fpis: 1 });
    const b = traceOp(e, "", put("k005")).delta;
    expect(b).toMatchObject({ logRecords: 3, logBytes: 130, logFsyncs: 1, pageWrites: 0, fpis: 0 });
    const g = traceOp(e, "", (x) => { x.get(null, "k019"); }).delta;
    expect(g).toMatchObject({ treeVisits: 3, logRecords: 0, logWrites: 0, logFsyncs: 0, pageReads: 0, pageWrites: 0 });
    const s = traceOp(e, "", put("k030")).delta;
    expect(s).toMatchObject({ splits: 1, logBytes: 16524 });
    const smo = e.log.find((r) => r.kind === "smo");
    expect(smo && smo.kind === "smo" && smo.pages.length).toBe(4);
    const c = traceOp(e, "", (x) => { x.checkpoint(); }).delta;
    expect(c).toMatchObject({ pageWrites: 5, dataFsyncs: 1, logFsyncs: 1 });
  });
  test("60 keys, 8 frames: the 4th uncommitted put writes a page and fsyncs the log", () => {
    const e = archEngine(60);
    let t: number | null = null;
    let m = 0;
    const ds = [5, 25, 45, 15].map((k) => traceOp(e, "", (x) => { if (t === null) t = x.begin(); x.put(t, archKey(k), `v${++m}`); }).delta);
    expect(ds.slice(0, 3).every((d) => d.pageWrites === 0 && d.logFsyncs === 0)).toBe(true);
    expect(ds[3]).toMatchObject({ pageWrites: 1, logFsyncs: 1 });
  });
  test("design explorer: WA 42 (in place), 246 (copy-on-write), 24 (LSM), 5 (hash); reads 1.03, ranges 7 vs 4 vs 100", () => {
    const base: Choice = { access: "btree", update: "inplace", recovery: "undoredo", writers: "many", cache: "pool" };
    expect(designAmp(base)!.wa).toBeCloseTo(41.96, 2);
    expect(consequences(base).matches[0]!.engine.name).toBe("InnoDB (MySQL)");
    const cow = consequences({ ...base, update: "cow", recovery: "shadow" });
    expect(cow.valid).toBe(true);
    expect(Math.round(cow.amp!.wa)).toBe(246);
    expect(Math.round(cowWa())).toBe(246);
    const lsm = consequences({ ...base, access: "lsm", update: "logstruct", recovery: "redo" });
    expect(lsm.amp!.wa).toBe(24);
    expect(lsm.amp!.ra.toFixed(2)).toBe("1.03");
    expect(lsm.amp!.raRange).toBe(7);
    expect(designAmp(base)!.raRange).toBe(4);
    const hash = consequences({ ...base, access: "hash", update: "logstruct", recovery: "redo" });
    expect(Math.round(hash.amp!.wa)).toBe(5);
    expect(hash.amp!.raRange).toBe(100);
    expect(consequences({ ...base, cache: "os" }).valid).toBe(false);
    // Picking LSM alone (with in-place updates) is refused until the update style is log-structured.
    expect(consequences({ ...base, access: "lsm" }).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------- lesson 2
describe("a-tiny-key-value-store-end-to-end", () => {
  const pk = (i: number) => `k${String(i).padStart(2, "0")}`;
  const seed = (group = 1) => {
    const e = new TinyKv({ leafCap: 4, innerCap: 4, frames: 8, groupCommit: group }, undefined, mulberry32(5));
    const t = e.begin();
    for (const i of [6, 14, 2, 10, 18, 4, 12, 0, 16, 8]) e.put(t, pk(i), `a${i}`);
    e.commit(t);
    e.checkpoint();
    return e;
  };
  test("playground step 1: a full image and a cell record, in memory until commit", () => {
    const e = seed();
    const t = e.begin();
    e.put(t, "k05", "v1");
    expect(e.log.slice(-2).map((r) => r.kind)).toEqual(["fpi", "cell"]);
    expect(e.syncedLSN).toBe(e.lastLSN - 2);
    e.commit(t);
    expect(e.syncedLSN).toBe(e.lastLSN);
  });
  test("playground step 2: a read-only snapshot keeps seeing the old version", () => {
    const e = seed();
    const t1 = e.begin(); e.put(t1, "k05", "v1"); e.commit(t1);
    const r = e.begin(true);
    const t2 = e.begin(); e.put(t2, "k05", "v2"); e.commit(t2);
    const leaf = e.levels().at(-1)!.find((p) => p.keys.includes("k05"))!;
    expect(leaf.cells[leaf.keys.indexOf("k05")]!.length).toBe(2);
    expect(e.get(r, "k05")).toBe("v1");
    expect(e.get(null, "k05")).toBe("v2");
  });
  test("playground step 3 (and the Predict): a stolen uncommitted page is undone with a CLR", () => {
    const e = seed();
    const t = e.begin(); e.put(t, "k07", "v1");
    e.checkpoint();
    expect([...e.synced.values()].some((s) => s.img.keys.includes("k07"))).toBe(true);
    const n = reopen(e.crash(mulberry32(9)), mulberry32(9));
    const rep = n.recover();
    expect(rep.losers).toEqual([t]);
    expect(rep.clrs).toBe(1);
    expect(n.get(null, "k07")).toBeUndefined();
  });
  test("playground step 4: with 3 commits per fsync, a single commit is not acknowledged and a crash may drop it", () => {
    const e = seed(3);
    const acked = e.oracle.acked;
    const t = e.begin(); e.put(t, "k05", "v1");
    expect(e.commit(t).durable).toBe(false);
    expect(e.oracle.acked).toBe(acked);
    const n = reopen(e.crash(mulberry32(1)), mulberry32(1));
    n.recover();
    expect(n.get(null, "k05")).toBeUndefined();
  });
  test("playground step 5: new keys k21..k29 split leaves and grow the root", () => {
    const e = seed();
    const h0 = e.levels().length;
    const t = e.begin();
    for (let i = 21; i <= 29; i++) e.put(t, pk(i), "n");
    e.commit(t);
    expect(e.stats.splits).toBeGreaterThan(0);
    expect(e.levels().length).toBeGreaterThan(h0);
    expect(e.checkTree()).toEqual([]);
  });

  const at = (writeFrac: number, o: Partial<typeof WL_DEFAULTS> = {}) => ({ ...WL_DEFAULTS, writeFrac, ...o });
  test("workload at 50% writes: B+ tree WA 54 (1,084 log B, 1,901 page B per op, 81% images); LSM WA 4.6", () => {
    const b = measure("btree", at(0.5)), l = measure("lsm", at(0.5));
    expect(Math.round(b.writeAmp)).toBe(54);
    expect(Math.round(b.logBytes)).toBe(1084);
    expect(Math.round(b.dataBytes)).toBe(1901);
    expect(Math.round((b.fpiBytes / b.logBytes) * 100)).toBe(81);
    expect(l.writeAmp.toFixed(1)).toBe("4.6");
    // SSD with 1 ms fsync: about 4,100 for both.
    expect(Math.round(deviceTime("btree", b, "ssd").opsPerSec)).toBe(4140);
    expect(Math.round(deviceTime("lsm", l, "ssd").opsPerSec)).toBe(4239);
  });
  test("workload at 0% writes: 225,476 vs 219,238 ops/s; about one read per lookup", () => {
    const b = measure("btree", at(0)), l = measure("lsm", at(0));
    expect(Math.round(deviceTime("btree", b).opsPerSec)).toBe(225476);
    expect(Math.round(deviceTime("lsm", l).opsPerSec)).toBe(219238);
    expect(b.randomReads).toBeCloseTo(0.874, 3);
    expect(l.randomReads).toBeGreaterThan(0.9);
    expect(l.randomReads).toBeLessThan(1.1);
  });
  test("128 frames: 0.063 page reads per op in place of 0.874, and fewer page writes", () => {
    const b16 = measure("btree", at(0.5)), b128 = measure("btree", at(0.5, { frames: 128 }));
    expect(b128.randomReads).toBeCloseTo(0.063, 3);
    expect(b16.randomReads).toBeCloseTo(0.874, 3);
    expect(b128.randomWrites).toBeLessThan(b16.randomWrites);
  });
  test("8 commits per fsync: the LSM tree jumps, the B+ tree gets 0.442 fsyncs per op in place of 0.235", () => {
    const b1 = measure("btree", at(0.5)), b8 = measure("btree", at(0.5, { groupCommit: 8 }));
    const l1 = measure("lsm", at(0.5)), l8 = measure("lsm", at(0.5, { groupCommit: 8 }));
    expect(b8.fsyncs.toFixed(3)).toBe("0.442");
    expect(b1.fsyncs.toFixed(3)).toBe("0.235");
    expect(deviceTime("btree", b8).opsPerSec).toBeLessThan(deviceTime("btree", b1).opsPerSec);
    expect(deviceTime("lsm", l8).opsPerSec).toBeGreaterThan(2.5 * deviceTime("lsm", l1).opsPerSec);
  }, 20000);
});

// ---------------------------------------------------------------------------- lesson 3
describe("crash-testing-the-engine", () => {
  test("2,000 guided runs with 2 crash points: 7,417 power cuts, 1,136 in recovery, no violation", () => {
    const c = new Campaign(FUZZ_CFG, { crashes: 2 }, 1, true);
    c.run(2000);
    const rec = ["redo", "undo", "restart"].reduce((a, x) => a + IO_KINDS.reduce((b, k) => b + (c.s.cells.get(cellKey(k, x as never)) ?? 0), 0), 0);
    expect(c.s.crashes).toBe(7417);
    expect(rec).toBe(1136);
    expect(c.s.violations).toBe(0);
    expect(c.s.detected).toBe(0);
    // Data fsyncs and master writes happen only in checkpoints and at the end of recovery; redo never writes the log.
    for (const k of c.s.cells.keys()) {
      if (k.startsWith("data.fsync") || k.startsWith("master.write")) expect(k).toMatch(/\|(checkpoint|restart)$/);
      expect(k).not.toBe("log.write|redo");
    }
  }, 30000);
  const run = (cfg: object) => { const c = new Campaign({ ...FUZZ_CFG, ...cfg }, {}, 1, false); c.run(1000); return c.s; };
  test("fault table: torn writes 0 violations; bit flips 239 fail-stops; without checksums 385 silent; lying fsync 227 + 58", () => {
    expect(run({}).violations).toBe(0);
    const f = run({ faults: { torn: true, bitflip: 0.3 } });
    expect([f.violations, f.detected]).toEqual([0, 239]);
    const n = run({ bugs: { noChecksums: true }, faults: { torn: true, bitflip: 0.3 } });
    expect([n.violations, n.detected]).toEqual([385, 0]);
    const l = run({ faults: { torn: true, lostFsync: 0.2 } });
    expect([l.violations, l.detected]).toEqual([227, 58]);
  }, 30000);
  test("bug replay: WAL rule bug found in run 3 and shrunk from 54 to 8 operations, ending in a checkpoint", () => {
    const cfg = { ...FUZZ_CFG, bugs: { pageBeforeLog: true } };
    const r = findAndShrink(cfg, 400, ["state", "lost-ack"])!;
    expect([r.run, r.found.ops.length, r.minimal.ops.length]).toEqual([3, 54, 8]);
    expect(r.minimal.ops.at(-1)!.k).toBe("ckpt");
    const lines = replay(r.minimal, cfg, true).lines.map((l) => l.text).join("\n");
    expect(lines).toContain("log.write (checkpoint)");
  });
  test("bug replay: skip fsync in 4 ops; drop CLRs without a crash point; skip images is fail-stop; no checksums: 13 ops, 2 crash points", () => {
    const get = (id: string) => findAndShrink({ ...FUZZ_CFG, bugs: { [id]: true } }, 400)!;
    const s = get("skipLogFsync");
    expect(s.minimal.ops.map((o) => o.k)).toEqual(["crash", "begin", "put", "commit"]);
    expect(replay(s.minimal, { ...FUZZ_CFG, bugs: { skipLogFsync: true } }).violations[0]!.kind).toBe("lost-ack");
    const d = get("dropClrs");
    expect(d.minimal.crashes).toEqual([]);
    expect(replay(d.minimal, { ...FUZZ_CFG, bugs: { dropClrs: true } }, true).lines.some((l) => l.text.startsWith("Write conflict"))).toBe(true);
    const f = get("noFpi");
    const fr = replay(f.minimal, { ...FUZZ_CFG, bugs: { noFpi: true } });
    expect(fr.violations).toEqual([]);
    expect(fr.detected).toContain("page 1");
    const c = get("noChecksums");
    expect(c.minimal.ops.length).toBe(13);
    expect(c.minimal.crashes.length).toBe(2);
    expect(replay(c.minimal, { ...FUZZ_CFG, bugs: { noChecksums: true } }, true).lines.some((l) => l.text.includes("during recovery"))).toBe(true);
  });
  test("fuzzer demo: skip fsync fails in run 1; drop CLRs shrinks to a trace with a write conflict and no crash point", () => {
    const camp = (id: string) => { const cfg = { ...FUZZ_CFG, bugs: { [id]: true }, faults: { torn: true, bitflip: 0, lostFsync: 0 } }; const c = new Campaign(cfg, { crashes: 1 }, 1, true); while (!c.s.firstFail) c.run(1); return { c, cfg }; };
    expect(camp("skipLogFsync").c.s.firstFail!.run).toBe(1);
    const { c, cfg } = camp("dropClrs");
    const m = finish(shrink(c.s.firstFail!.trace, cfg));
    expect(m.crashes).toEqual([]);
    expect(replay(m, cfg, true).lines.some((l) => l.text.startsWith("Write conflict"))).toBe(true);
    const nc = camp("noChecksums").c.s.firstFail!.run;
    expect(nc).toBeGreaterThan(camp("skipLogFsync").c.s.firstFail!.run);
    expect(BUGS.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------- lesson 4
describe("sqlite-lmdb-and-rocksdb-compared", () => {
  test("one put(): SQLite WAL 4,120 B + 1 fsync; LMDB 20,480 B + 2; RocksDB 138 B + 0 (1 with sync)", () => {
    expect(putSummary("sqlite")).toMatchObject({ commitBytes: 4120, commitFsyncs: 1, laterBytes: 4096 });
    expect(putSummary("lmdb")).toMatchObject({ commitBytes: 20480, commitFsyncs: 2 });
    expect(putSummary("rocksdb")).toMatchObject({ commitBytes: 138, commitFsyncs: 0, durableAtCommit: false });
    expect(rocksWalBytes(16, 100)).toBe(138);
    expect(putSummary("rocksdb", { ...PUT_DEFAULTS, rocksSync: true })).toMatchObject({ commitFsyncs: 1, durableAtCommit: true });
    expect(putSummary("sqlite", { ...PUT_DEFAULTS, sqliteMode: "rollback" })).toMatchObject({ commitBytes: 8712, commitFsyncs: 3 });
    expect(Math.round(putSummary("rocksdb").laterBytes)).toBe(1404);
    const h5 = putSummary("lmdb", { ...PUT_DEFAULTS, height: 5 }).commitBytes;
    expect(h5 - 20480).toBe(2 * 4096);
    expect(putSummary("sqlite", { ...PUT_DEFAULTS, height: 5 }).commitBytes).toBe(4120);
  });
  const ops = (m: Partial<Mix>) => Object.fromEntries(fitAll({ ...MIX_DEFAULTS, ...m }).map((f) => [f.id, Math.round(f.opsPerSec)])) as Record<RealId, number>;
  test("fit defaults: RocksDB 33,656, SQLite 4,846, LMDB 2,433; one client: RocksDB 4,885", () => {
    expect(ops({})).toEqual({ sqlite: 4846, lmdb: 2433, rocksdb: 33656 });
    expect(ops({ clients: 1 }).rocksdb).toBe(4885);
  });
  test("range scans only: SQLite and LMDB 63,634 vs RocksDB 47,375", () => {
    expect(ops({ writeFrac: 0, rangeFrac: 1 })).toEqual({ sqlite: 63634, lmdb: 63634, rocksdb: 47375 });
  });
  test("90% writes without fsync: 89,197 / 31,306 / 280,710; WA 66.3 / 198.2 / 12.3", () => {
    expect(ops({ writeFrac: 0.9, durable: false })).toEqual({ sqlite: 89197, lmdb: 31306, rocksdb: 280710 });
    const wa = fitAll(MIX_DEFAULTS).map((f) => f.writeAmp.toFixed(1));
    expect(wa).toEqual(["66.3", "198.2", "12.3"]);
  });
  test("100 updates per transaction: LMDB WA 198.2 -> 93.1", () => {
    expect(fitAll({ ...MIX_DEFAULTS, batch: 100 })[1]!.writeAmp.toFixed(1)).toBe("93.1");
  });
});
