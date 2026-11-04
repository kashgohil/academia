/** TinyKv (src/sims/db/engine): correctness, crash-recovery properties, the deliberate bugs, and LsmKv. */
import { describe, expect, test } from "vitest";
import {
  TinyKv, reopen, LsmKv, ConflictError, CorruptPageError, tornPage, pageCrc, oracleState, sameMap,
  Campaign, FUZZ_CFG, BUGS, findAndShrink, replay, randomTrace, shrink, finish, keyName, type KvConfig, type KvLike,
} from "@/sims/db/engine";
import { mulberry32 } from "@/sims/rng";

const small: Partial<KvConfig> = { leafCap: 4, innerCap: 4, frames: 10 };

describe("TinyKv without crashes", () => {
  test("put, get, delete, commit and abort; the tree stays valid under many inserts", () => {
    const e = new TinyKv(small);
    const ref = new Map<string, string>();
    const rng = mulberry32(3);
    for (let round = 0; round < 60; round++) {
      const t = e.begin();
      const w = new Map<string, string | null>();
      for (let i = 0; i < 6; i++) {
        const k = keyName(Math.floor(rng() * 80));
        if (rng() < 0.2) { e.del(t, k); w.set(k, null); } else { const v = `v${round}.${i}`; e.put(t, k, v); w.set(k, v); }
      }
      if (rng() < 0.25) e.abort(t);
      else { e.commit(t); for (const [k, v] of w) { if (v === null) ref.delete(k); else ref.set(k, v); } }
    }
    expect(e.checkTree()).toEqual([]);
    expect(sameMap(e.scanAll(), ref)).toBe(true);
    for (const [k, v] of ref) expect(e.get(null, k)).toBe(v);
    expect(e.levels().length).toBeGreaterThanOrEqual(3);
  });

  test("snapshot reads, read-your-writes, and first-updater-wins conflicts", () => {
    const e = new TinyKv(small);
    const t0 = e.begin(); e.put(t0, "a", "1"); e.commit(t0);
    const r = e.begin(true);
    const t1 = e.begin(); e.put(t1, "a", "2");
    expect(e.get(t1, "a")).toBe("2");
    expect(e.get(r, "a")).toBe("1");
    const t2 = e.begin();
    expect(() => e.put(t2, "a", "3")).toThrow(ConflictError); // T1's version is uncommitted
    e.commit(t1);
    expect(e.get(r, "a")).toBe("1"); // the snapshot still sees the old version
    expect(e.get(null, "a")).toBe("2");
    const t3 = e.begin();
    const t4 = e.begin(); e.put(t4, "a", "4"); e.commit(t4);
    expect(() => e.put(t3, "a", "5")).toThrow(ConflictError); // committed after T3's snapshot
    expect(e.liveTxns().some((x) => x.id === t3)).toBe(false); // the conflict aborted T3
  });

  test("a torn page fails its checksum; the stored CRC is that of the new image", () => {
    const e = new TinyKv(small);
    const t = e.begin();
    for (const k of ["a", "b", "c", "d"]) e.put(t, k, k);
    e.commit(t);
    const leaf = e.levels()[0]![0]!;
    const neu = { ...leaf, keys: ["a", "b", "x", "y"], cells: leaf.cells.map((c) => c.map((v) => ({ ...v }))) };
    const torn = tornPage(neu, leaf);
    expect(torn.keys).toEqual(["a", "b", "c", "d"]);
    expect(pageCrc(torn)).not.toBe(pageCrc(neu));
  });
});

describe("crash-recovery property: after recover(), the state is exactly a committed prefix", () => {
  const configs: [string, Partial<KvConfig>, object][] = [
    ["default fuzz engine, 2 crash points, crashes in recovery", FUZZ_CFG, { crashes: 2, pRecoveryCrash: 0.7 }],
    ["group commit of 3, Clock replacement", { ...FUZZ_CFG, groupCommit: 3, policy: "clock" }, { crashes: 2, maxLive: 4 }],
    ["3 keys per page, 10 frames", { ...FUZZ_CFG, leafCap: 3, innerCap: 3, frames: 10 }, { crashes: 2, keys: 30 }],
  ];
  for (const [name, cfg, gen] of configs) {
    test(name, () => {
      const c = new Campaign(cfg, gen, 4242, true);
      c.run(500);
      expect(c.s.firstFail?.result.violations ?? []).toEqual([]);
      expect(c.s.violations).toBe(0);
      expect(c.s.detected).toBe(0);
      expect(c.s.crashes).toBeGreaterThan(1200);
      const inRecovery = [...c.s.cells].filter(([k]) => /\|(redo|undo|restart)$/.test(k)).reduce((a, [, n]) => a + n, 0);
      expect(inRecovery).toBeGreaterThan(100);
    }, 30000);
  }

  test("a direct check: acknowledged commits survive, unacknowledged ones may not, and recovery can crash again", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = mulberry32(seed);
      let e = new TinyKv({ ...FUZZ_CFG, groupCommit: 2 }, undefined, rng);
      let crashAt = 1 + Math.floor(rng() * 80);
      e.crashPlan = (ev) => ev.seq === crashAt;
      try {
        for (let i = 0; i < 40; i++) {
          const t = e.begin();
          e.put(t, keyName(Math.floor(rng() * 30)), `v${i}`);
          if (rng() < 0.2) e.abort(t); else e.commit(t);
          if (i % 13 === 12) e.checkpoint();
        }
      } catch { /* power cut */ }
      for (let k = 0; ; k++) {
        const img = e.crash(rng);
        e = reopen(img, rng);
        crashAt = k < 2 ? 1 + Math.floor(rng() * 12) : -1;
        e.crashPlan = (ev) => ev.seq === crashAt;
        try { e.recover(); break; } catch (x) { if (x instanceof CorruptPageError) throw x; }
      }
      const s = e.scanAll();
      const o = e.oracle;
      const ok = Array.from({ length: o.attempts.length - o.acked + 1 }, (_, i) => o.acked + i).some((j) => sameMap(oracleState(o, j), s));
      expect(ok, `seed ${seed}`).toBe(true);
      expect(e.checkTree()).toEqual([]);
    }
  });
});

describe("the fuzzer finds every deliberate bug", () => {
  for (const b of BUGS) {
    test(b.id, () => {
      const cfg = { ...FUZZ_CFG, bugs: { [b.id]: true } };
      const r = findAndShrink(cfg, 400);
      expect(r).not.toBeNull();
      const bad = replay(r!.minimal, cfg);
      expect(bad.ok).toBe(false);
      expect(replay(r!.minimal, FUZZ_CFG).ok).toBe(true); // the same trace passes on the correct engine
      expect(r!.minimal.ops.length).toBeLessThan(r!.found.ops.length);
      expect(r!.minimal.ops.length).toBeLessThanOrEqual(15);
      // The demo's campaign (coverage-guided) finds it too.
      const c = new Campaign({ ...cfg, faults: { torn: true, bitflip: 0, lostFsync: 0 } }, { crashes: 1 }, 1, true);
      while (!c.s.firstFail && c.s.runs < 400) c.run(1);
      expect(c.s.firstFail).not.toBeNull();
    }, 30000);
  }

  test("shrinking keeps the kind of failure", () => {
    const cfg = { ...FUZZ_CFG, bugs: { pageBeforeLog: true } };
    const r = findAndShrink(cfg, 400, ["state", "lost-ack"])!;
    expect(replay(r.minimal, cfg).violations.some((v) => v.kind === "state")).toBe(true);
  });

  test("a trace replays deterministically", () => {
    const t = randomTrace(77);
    expect(replay(t).lines).toEqual(replay(t).lines);
    expect(JSON.stringify(replay(t, FUZZ_CFG, true).lines)).toBe(JSON.stringify(replay(t, FUZZ_CFG, true).lines));
    expect(finish(shrink(t))).toBeDefined();
  });
});

describe("LsmKv behind the same interface", () => {
  test("differential test: the same transactions give the same state in both engines", () => {
    const a = new TinyKv({ ...small, frames: 16 });
    const b = new LsmKv({ memtableBytes: 512, baseLevelBytes: 2048, targetFileBytes: 512, blockBytes: 128 });
    const rng = mulberry32(11);
    const run = (e: KvLike, seed: number) => {
      const r = mulberry32(seed);
      for (let round = 0; round < 120; round++) {
        const t = e.begin();
        for (let i = 0; i < 3; i++) { const k = keyName(Math.floor(r() * 50)); if (r() < 0.15) e.del(t, k); else e.put(t, k, `v${round}.${i}`); }
        if (r() < 0.2) e.abort(t); else e.commit(t);
      }
    };
    run(a, 5); run(b, 5);
    expect(sameMap(a.scanAll(), b.scanAll())).toBe(true);
    expect(b.lsm.stats.flushes).toBeGreaterThan(0);
    void rng;
  });

  test("LsmKv: snapshot reads and an optimistic conflict at commit", () => {
    const e = new LsmKv();
    const t0 = e.begin(); e.put(t0, "a", "1"); e.commit(t0);
    const t1 = e.begin(), t2 = e.begin();
    e.put(t1, "a", "2"); e.commit(t1);
    expect(e.get(t2, "a")).toBe("1");
    e.put(t2, "a", "3");
    expect(() => e.commit(t2)).toThrow(ConflictError);
    expect(e.get(null, "a")).toBe("2");
  });
});
