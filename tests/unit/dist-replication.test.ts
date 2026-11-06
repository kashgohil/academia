/** The Replication module: properties of the sims, and every number that the lessons quote. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  runLeaderFollower, failover, meanCommitMs, LF_DEFAULTS, runSplitBrain, sbLostAcked, SB_DEFAULTS, type FollowerMode,
  runLag, summarize, checkAnomalies, LAG_DEFAULTS, READ_FIXES, runBurst, burstModel, BURST_DEFAULTS, type SessionOp,
  runMultiLeader, DEFAULT_OPS, RESOLVERS, fieldText, runTopology, TOPO_DEFAULTS, type MlConfig,
  runScenario, quorumStats, quorumLatency, mergeStats, statsChunk, STATS_CHUNKS, runLinScenario, QUORUM_DEFAULTS, FAILS, type Fail,
  buildTree, diffTrees, bruteDiff, makePair, sweepPoint, SWEEP_DS, WIRE_DEFAULT, type Data,
} from "@/sims/dist/replication";

// ============================================================================ leader-follower

describe("leader-follower", () => {
  test("property: with failover to a synchronous follower, no confirmed write is lost", () => {
    const rng = mulberry32(42);
    for (let k = 0; k < 300; k++) {
      const modes: FollowerMode[] = [rng() < 0.5 ? "sync" : "async", rng() < 0.5 ? "sync" : "async"];
      if (!modes.includes("sync")) modes[Math.floor(rng() * 2)] = "sync";
      const cfg = { ...LF_DEFAULTS, seed: k + 1, modes, latency: { min: 1, max: 1 + rng() * 30 }, shipEvery: [1 + rng() * 30, 1 + rng() * 30], flushMs: [rng() * 10, rng() * 10] };
      const run = runLeaderFollower(cfg, rng() * 150);
      modes.forEach((m, i) => m === "sync" && expect(failover(run, i + 1).lost, `run ${k}`).toEqual([]));
    }
  });

  test("an asynchronous failover can lose confirmed writes", () => {
    const run = runLeaderFollower({ ...LF_DEFAULTS, modes: ["async", "async"] }, 115);
    expect(failover(runLeaderFollower(LF_DEFAULTS, 115), 2).lost).toEqual([9, 10]);
    expect(failover(run, 2).lost.length).toBe(3);
    expect(failover(run, 2).best).toBe(1);
  });

  test("lesson numbers: a sync follower makes a write wait about 13 ms; async waits 0", () => {
    expect(meanCommitMs(runLeaderFollower(LF_DEFAULTS))).toBeGreaterThan(12);
    expect(meanCommitMs(runLeaderFollower(LF_DEFAULTS))).toBeLessThan(14);
    expect(meanCommitMs(runLeaderFollower({ ...LF_DEFAULTS, modes: ["async", "async"] }))).toBe(0);
  });

  test("lesson numbers: split brain with each replication mode and guard", () => {
    const r = (replication: "async" | "sync", guard: "none" | "lease") => runSplitBrain({ ...SB_DEFAULTS, replication, guard });
    const an = r("async", "none"), al = r("async", "lease"), sn = r("sync", "none"), sl = r("sync", "lease");
    expect(sbLostAcked(an).length).toBe(8);
    expect(Math.round(an.twoLeaderMs)).toBe(96);
    expect(sbLostAcked(al).length).toBe(2);
    expect(al.twoLeaderMs).toBe(0);
    expect(sbLostAcked(sn).length).toBe(0);
    expect(sn.writes.filter((w) => w.lost).length).toBe(8);
    expect(Math.round(sn.twoLeaderMs)).toBe(96);
    expect(sbLostAcked(sl).length).toBe(0);
    expect(sl.twoLeaderMs).toBe(0);
  });
});

// ============================================================================ lag

describe("replication lag", () => {
  const run = (fix: (typeof READ_FIXES)[number], d = 15) => summarize(runLag({ ...LAG_DEFAULTS, delayMs: [d, d * 2.5], fix }));

  test("the checker finds each anomaly in a hand-made history", () => {
    const op = (o: Partial<SessionOp>): SessionOp => ({ session: 0, kind: "read", key: "x", replica: 1, start: 0, end: 0, version: 0, applied: 0, ...o });
    const log = ["", "x", "y", "x"];
    const kinds = (h: SessionOp[]) => checkAnomalies(h, log).map((a) => a.kind);
    expect(kinds([op({ kind: "write", version: 1 }), op({ version: 0 })])).toEqual(["ryw"]);
    expect(kinds([op({ version: 3 }), op({ version: 1 })])).toEqual(["monotonic"]);
    expect(kinds([op({ key: "y", version: 2 }), op({ key: "x", version: 0 })])).toEqual(["prefix"]);
    expect(kinds([op({ key: "y", version: 2 }), op({ key: "x", version: 1 })])).toEqual([]);
  });

  test("property: reading from the leader or after the session's LSN gives no anomaly", () => {
    for (let seed = 1; seed <= 20; seed++) for (const fix of ["leader", "lsn"] as const) {
      const s = summarize(runLag({ ...LAG_DEFAULTS, seed, delayMs: [5 + seed, 10 + 3 * seed], fix }));
      expect(s.ryw + s.monotonic + s.prefix, `${fix} ${seed}`).toBe(0);
    }
  });

  test("property: sticky sessions give monotonic reads and consistent prefix, but not read-your-writes", () => {
    let ryw = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const s = summarize(runLag({ ...LAG_DEFAULTS, seed, fix: "sticky" }));
      expect(s.monotonic + s.prefix).toBe(0);
      ryw += s.ryw;
    }
    expect(ryw).toBeGreaterThan(0);
  });

  test("lesson numbers: anomalies and read latency with a 15 ms follower delay", () => {
    const none = run("none"), sticky = run("sticky"), lsn = run("lsn"), leader = run("leader");
    expect(none.reads).toBe(270);
    expect([none.ryw, none.monotonic, none.prefix]).toEqual([136, 0, 5]);
    expect(sticky.ryw).toBe(123);
    expect(leader.leaderReads).toBe(1);
    expect(none.meanReadMs.toFixed(1)).toBe("4.9");
    expect(lsn.meanReadMs.toFixed(1)).toBe("11.7");
    const far = run("none", 40);
    expect([far.ryw, far.monotonic, far.prefix]).toEqual([180, 49, 34]);
  });

  test("lesson numbers: lag under a write burst matches the queue model", () => {
    const b = runBurst();
    const m = [burstModel(BURST_DEFAULTS, 0), burstModel(BURST_DEFAULTS, 1)];
    expect(m.map((x) => x.mu)).toEqual([1250, 625]);
    expect(m.map((x) => x.backlog)).toEqual([75, 262.5]);
    expect(m.map((x) => Math.round(x.peakLagMs))).toEqual([60, 420]);
    expect(m.map((x) => Math.round(x.drainMs))).toEqual([71, 618]);
    b.peak.forEach((p, i) => expect(Math.abs(p - m[i]!.peakLagMs)).toBeLessThan(5));
    b.catchUp.forEach((c, i) => expect(Math.abs(c - m[i]!.drainMs)).toBeLessThan(15));
  });
});

// ============================================================================ multi-leader

describe("multi-leader", () => {
  const cfg = (resolver: MlConfig["resolver"], skewMs = 0): MlConfig => ({ seed: 1, resolver, skewMs, latency: { min: 5, max: 15 } });
  const lostAt = (r: ReturnType<typeof runMultiLeader>, side: 0 | 1) => r.lost.filter((l) => l.side === side).length;

  test("lesson numbers: what each resolver keeps from the default writes", () => {
    const arrival = runMultiLeader(DEFAULT_OPS, cfg("arrival"));
    expect(arrival.converged).toBe(false);
    expect(fieldText(arrival.docs[0].title)).toBe("Plan B");
    expect(fieldText(arrival.docs[1].title)).toBe("Plan A");
    const lww = runMultiLeader(DEFAULT_OPS, cfg("lww"));
    expect(lww.converged).toBe(true);
    expect(lostAt(lww, 0)).toBe(3);
    const merge = runMultiLeader(DEFAULT_OPS, cfg("merge"));
    expect(merge.converged).toBe(true);
    expect(lostAt(merge, 0)).toBe(1);
    expect(fieldText(merge.docs[0].tags)).toBe("{blue, red}");
    expect(fieldText(merge.docs[0].likes)).toBe("2");
    const sib = runMultiLeader(DEFAULT_OPS, cfg("siblings"));
    expect(sib.converged).toBe(true);
    expect(sib.lost).toEqual([]);
    expect(fieldText(sib.docs[0].title)).toBe("Plan A | Plan B");
  });

  test("lesson numbers: with side B's clock 50 ms behind, last-write-wins keeps the earlier title", () => {
    const r = runMultiLeader(DEFAULT_OPS, cfg("lww", -50));
    expect(fieldText(r.docs[0].title)).toBe("Plan A");
    expect(r.laterLost).toBe(1);
  });

  test("property: every resolver but arrival order converges on random writes", () => {
    const rng = mulberry32(9);
    for (let k = 0; k < 100; k++) {
      const ops = Array.from({ length: 1 + Math.floor(rng() * 8) }, (_, i) => ({
        side: (rng() < 0.5 ? 0 : 1) as 0 | 1, field: (["title", "tags", "likes"] as const)[Math.floor(rng() * 3)]!, value: `v${i}`, at: 5 + i * 7,
      }));
      for (const res of RESOLVERS.filter((r) => r !== "arrival")) expect(runMultiLeader(ops, { ...cfg(res, Math.round(rng() * 80 - 40)), seed: k }).converged, `${k} ${res}`).toBe(true);
    }
  });

  test("lesson numbers: an update overtakes its insert only in all-to-all, and causal delivery stops it", () => {
    expect(runTopology(TOPO_DEFAULTS).overtaken).toEqual([2]);
    expect(runTopology(TOPO_DEFAULTS).rows[2]).toBe("old");
    expect(runTopology({ ...TOPO_DEFAULTS, causal: true }).overtaken).toEqual([]);
    expect(runTopology({ ...TOPO_DEFAULTS, causal: true }).rows).toEqual(["new", "new", "new", "new"]);
    for (const topology of ["ring", "star"] as const) expect(runTopology({ ...TOPO_DEFAULTS, topology }).overtaken).toEqual([]);
  });

  test("lesson numbers: one crash stops the ring and the star, but not all-to-all", () => {
    expect(runTopology({ ...TOPO_DEFAULTS, topology: "ring", crash: 3 }).missed).toEqual([[0, "update"]]);
    expect(runTopology({ ...TOPO_DEFAULTS, topology: "star", crash: 0 }).missed.length).toBe(3);
    expect(runTopology({ ...TOPO_DEFAULTS, topology: "all", crash: 3 }).missed).toEqual([]);
  });
});

// ============================================================================ leaderless quorums

describe("leaderless quorums", () => {
  test("property: with W + R > N and a strict quorum, a read that starts after a write completes sees it", () => {
    const combos = (n: number): Fail[][] => (n === 0 ? [[]] : combos(n - 1).flatMap((c) => FAILS.map((f) => [...c, f])));
    let checked = 0;
    for (const n of [3, 4]) {
      const all = combos(n);
      for (let w = 1; w <= n; w++) for (let r = n + 1 - w; r <= n; r++) {
        for (const fails of all) for (const seed of [1, 2, 3]) for (const gap of [0, 5]) {
          const s = runScenario({ ...QUORUM_DEFAULTS, n, w, r, seed }, fails, gap);
          if (s.fresh !== undefined) {
            checked++;
            expect(s.fresh, `N=${n} W=${w} R=${r} ${fails.join(",")} seed ${seed}`).toBe(true);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  }, 60_000);

  test("with W + R ≤ N, or a sloppy quorum, some reads miss the write", () => {
    expect(runScenario({ ...QUORUM_DEFAULTS, w: 1, r: 1 }, ["write", "up", "up"], 0).fresh === false || quorumStats({ ...QUORUM_DEFAULTS, w: 1, r: 1 }, 0.2, 0, 200).freshRate < 1).toBe(true);
    // Sloppy: replicas 0 and 1 are down during the write, so it lands on 2 and the stand-ins 3 and 4.
    let stale = 0;
    for (let seed = 1; seed <= 40; seed++) if (runScenario({ ...QUORUM_DEFAULTS, seed, sloppy: true, handoffMs: 1e6 }, ["write", "write", "up"], 0).fresh === false) stale++;
    expect(stale).toBeGreaterThan(0);
  });

  test("lesson numbers: the playground's 1,000 runs, p = 0.2, read right after the write", () => {
    const st = (w: number, r: number, sloppy = false, n = 3, gap = 0) =>
      mergeStats(Array.from({ length: STATS_CHUNKS }, (_, k) => statsChunk({ ...QUORUM_DEFAULTS, n, w, r, sloppy, spares: sloppy ? 2 : 0 }, 0.2, gap, k)));
    const f = (x: number) => (x * 100).toFixed(1);
    expect(st(1, 1).runs).toBe(1000);
    expect(f(st(1, 1).freshRate)).toBe("83.1");
    expect(f(st(1, 1, false, 3, 20).freshRate)).toBe("82.7");
    expect(f(st(2, 2, true, 3, 45).freshRate)).toBe("98.2");
    expect(st(2, 2).freshRate).toBe(1);
    expect([f(st(2, 2).writeFail), f(st(2, 2).readFail)]).toEqual(["9.6", "9.2"]);
    expect(f(st(2, 2, true).freshRate)).toBe("94.2");
    expect(st(2, 2, true).writeFail).toBe(0);
    expect(st(2, 2, true).readFail).toBe(0);
    expect(f(st(3, 1).writeFail)).toBe("47.7");
    expect(f(st(1, 3).readFail)).toBe("49.4");
    expect(f(st(2, 2, false, 5).freshRate)).toBe("96.8");
    expect(st(3, 3, false, 5).freshRate).toBe(1);
    expect(f(st(3, 3, false, 5).writeFail)).toBe("5.1");
  });

  test("lesson numbers: p99 latency of waiting for k of n answers", () => {
    const p99 = (n: number, k: number) => Math.round(quorumLatency(n, k, 2000, 1).p99);
    expect([p99(3, 1), p99(3, 2), p99(3, 3)]).toEqual([5, 5, 97]);
    expect([p99(5, 3), p99(5, 4), p99(5, 5)]).toEqual([5, 55, 98]);
  });

  test("a quorum read is not linearizable without blocking read repair", () => {
    const a = runLinScenario(false), b = runLinScenario(true);
    expect(Math.round(a.readA.end!)).toBe(24);
    expect((1 - 0.95 ** 3).toFixed(3)).toBe("0.143"); // the chance that one of three replicas is slow, quoted with the p99 numbers
    expect(a.violation).toBe(true);
    expect(a.readB.start).toBeGreaterThan(a.readA.end!);
    expect(b.violation).toBe(false);
    expect(b.readB.ts).toBe(b.readA.ts);
  });
});

// ============================================================================ Merkle trees

describe("Merkle trees", () => {
  test("property: the diff returns exactly the differing keys on random data", () => {
    const rng = mulberry32(17);
    for (let k = 0; k < 200; k++) {
      const n = Math.floor(rng() * 300);
      const a: Data = new Map(), b: Data = new Map();
      for (let i = 0; i < n; i++) {
        const key = `k${Math.floor(rng() * 1000)}`, v = `v${Math.floor(rng() * 5)}`;
        const x = rng();
        if (x < 0.85) { a.set(key, v); b.set(key, v); }
        else if (x < 0.9) a.set(key, v);
        else if (x < 0.95) b.set(key, v);
        else { a.set(key, v); b.set(key, `${v}'`); }
      }
      const depth = Math.floor(rng() * 9);
      expect(diffTrees(buildTree(a, depth), buildTree(b, depth)).keys, `case ${k}`).toEqual(bruteDiff(a, b));
    }
  });

  test("equal data gives equal roots, and one comparison", () => {
    const { a } = makePair(500, 0, 3);
    const r = diffTrees(buildTree(a, 8), buildTree(new Map(a), 8));
    expect(r.visits.length).toBe(1);
    expect(r.bytes.total).toBe(8);
  });

  test("lesson numbers: 10,000 keys, depth 10", () => {
    const at = (d: number) => sweepPoint(10000, 10, d);
    expect(at(1).allValues).toBe(2_160_000);
    expect(at(1).allHashes).toBe(240_200);
    expect(Math.round(at(1).merkle)).toBe(624);
    expect(Math.round(at(1).hashesCompared)).toBe(21);
    expect(Math.round(at(100).merkle)).toBe(50312);
    expect(at(10000).merkle).toBeGreaterThan(at(10000).allValues);
    // The first point of the demo's sweep where the walk costs more than the key and hash list.
    expect(SWEEP_DS.find((d) => d > 0 && at(d).merkle > at(d).allHashes)).toBe(5000);
    expect(at(2000).merkle).toBeLessThan(at(2000).allHashes);
  });

  test("lesson numbers: the default stepper data", () => {
    const { a, b, changed } = makePair(48, 3, 5);
    const r = diffTrees(buildTree(a, 4), buildTree(b, 4));
    expect(r.keys).toEqual(changed);
    expect(r.visits.length).toBe(19);
    expect(r.bytes.total).toBe(1016);
    expect(r.leafLists.length).toBe(3);
    expect(48 * (WIRE_DEFAULT.key + WIRE_DEFAULT.value)).toBe(10368);
  });
});
