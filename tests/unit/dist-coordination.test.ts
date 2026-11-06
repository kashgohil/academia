/** Numbers that the Coordination lessons quote, pinned to the sims in src/sims/dist/coordination. */
import { describe, expect, test } from "vitest";
import {
  ELECTION, MvccStore, WatchTable, ZkTree, expiryNotifications, fencingSweepPoint, leaseTimeline, liveLeaders, marginNeeded,
  raftLeaseEnd, redlockDrift, redlockRun, watchRun, zkElection,
} from "../../src/sims/dist/coordination";

describe("leases and fencing tokens", () => {
  test("the default timeline: A pauses 900 ms after its check, B takes over, A's stale write lands", () => {
    const r = leaseTimeline();
    const [l1, l2] = r.svc.leases;
    expect(Math.round(l1!.until)).toBe(831); // lease 1 expires by the service's clock
    expect(Math.round(l2!.from)).toBe(913); // B gets token 2
    expect(r.staleAccepted).toHaveLength(1);
    expect(Math.round(r.staleAccepted[0]!.t)).toBe(1238);
    expect(r.staleAccepted[0]!.token).toBe(1);
    expect(Math.round(r.overlap!.to - r.overlap!.from)).toBe(184);
    expect(r.final).toBe(103); // A's value replaced B's 202
  });

  test("with fencing tokens the storage rejects the stale write", () => {
    const r = leaseTimeline({ fence: "all" });
    expect(r.rejected).toHaveLength(1);
    expect(r.staleAccepted).toHaveLength(0);
    expect(r.final).toBe(202);
  });

  test("short pauses are harmless; the stale write needs a pause past the lease", () => {
    expect(leaseTimeline({ pause: 450 }).svc.leases[0]!.until).toBeGreaterThan(1500); // renewed after the pause
    expect(leaseTimeline({ pause: 450 }).staleAccepted).toHaveLength(0);
    expect(leaseTimeline({ pause: 550 }).staleAccepted).toHaveLength(0); // the lease expired, but A wrote before B got it
    expect(leaseTimeline({ pause: 600 }).staleAccepted).toHaveLength(0); // B got the lease, but A's write still came before B's first write
    expect(leaseTimeline({ pause: 650 }).staleAccepted).toHaveLength(1);
  });

  test("a pause before the check is caught, unless the clock stops during the pause", () => {
    const r = leaseTimeline({ pauseWhere: "beforeCheck" });
    expect(r.staleAccepted).toHaveLength(0);
    expect(r.beliefs[0]!.why).toBe("check");
    const s = leaseTimeline({ pauseWhere: "beforeCheck", clockStops: true });
    expect(s.staleAccepted).toHaveLength(1);
    expect(Math.round(s.staleAccepted[0]!.t)).toBe(1245);
  });

  test("the safety margin", () => {
    expect(marginNeeded(10_000, 100e-6, 10)).toBeCloseTo(12.0, 1);
    expect(marginNeeded(10_000, 100e-6, 0)).toBeCloseTo(2.0, 1);
    expect(marginNeeded(10_000, 100e-6, 10, 2000)).toBeCloseTo(2011.8, 1);
    expect(marginNeeded(60_000, 100e-6, 0)).toBeCloseTo(12.0, 1);
    expect(marginNeeded(10_000, 0.01, 10)).toBeCloseTo(207.9, 1);
    expect(raftLeaseEnd(0, 1000, 1.1)).toBeCloseTo(909.1, 1);
  });
});

describe("distributed locks", () => {
  test("Redlock's validity: TTL − elapsed − (⌊0.01 TTL⌋ + 2 ms)", () => {
    expect(redlockDrift(1000)).toBe(12);
    expect(redlockDrift(10_000)).toBe(102);
    expect(Math.round(redlockRun({ cut1: false, cut2: false }).attempts[0]!.validity)).toBe(967);
    expect(Math.round(redlockRun().attempts[0]!.validity)).toBe(938); // two nodes never answer: it waits the 50 ms timeout
  });

  test("Redlock scenarios", () => {
    expect(redlockRun().overlap).toBeNull(); // C still holds client 1's key, so client 2 gets 2 of 5
    expect(redlockRun().attempts[1]!.got).toBe(2);
    expect(redlockRun({ jumpC: 1000 }).overlap).toEqual({ from: 200, to: 500 });
    expect(redlockRun({ crashC: "restart" }).overlap).toEqual({ from: 200, to: 500 });
    expect(redlockRun({ crashC: "delayed" }).overlap).toBeNull();
    const p = redlockRun({ cut1: false, cut2: false, pause1: 1500 });
    expect([Math.round(p.overlap!.from), Math.round(p.overlap!.to)]).toEqual([1180, 1480]);
    expect(redlockRun({ cut1: false, cut2: false, pause1: 800 }).overlap).toBeNull();
  });

  test("lock only versus lock + fencing over 40 seeds", () => {
    const at = (x: number, mode: "none" | "writes" | "all") => fencingSweepPoint({ mode, maxPause: x }, 40);
    for (const mode of ["none", "writes", "all"] as const) expect(at(200, mode).lost).toBe(0);
    expect(at(600, "none")).toMatchObject({ acked: 1440, lost: 224, badRuns: 40 });
    expect(at(600, "writes")).toMatchObject({ acked: 1319, lost: 40, rejected: 121, badRuns: 27 });
    expect(at(600, "all")).toMatchObject({ acked: 1260, lost: 0, rejected: 180 });
  });
});

describe("ZooKeeper and etcd", () => {
  test("ZkTree: sequential names, ephemeral cleanup and one-time watches", () => {
    const t = new ZkTree();
    t.apply({ op: "create", path: ELECTION, data: "", ephemeral: false, sequential: false, session: 0 });
    const a = t.apply({ op: "create", path: `${ELECTION}/n_`, data: "", ephemeral: true, sequential: true, session: 7 });
    const b = t.apply({ op: "create", path: `${ELECTION}/n_`, data: "", ephemeral: true, sequential: true, session: 8 });
    expect([a.path, b.path]).toEqual(["/election/n_0000000000", "/election/n_0000000001"]);
    expect(t.apply({ op: "create", path: `${a.path}/x`, data: "", ephemeral: false, sequential: false, session: 7 }).err).toBe("NoChildrenForEphemerals");
    const w = new WatchTable();
    w.add("data", a.path!, 8);
    w.add("child", ELECTION, 9);
    const c = t.apply({ op: "closeSession", session: 7 });
    expect(t.children(ELECTION)).toEqual(["n_0000000001"]);
    expect(w.trigger(c.events).map(([s, e]) => [s, e.type])).toEqual([[8, "NodeDeleted"], [9, "NodeChildrenChanged"]]);
    expect(w.trigger(c.events)).toEqual([]); // one-time
  });

  test("election: one notification per change for the predecessor watch, n − 1 for the herd", () => {
    const kills = (n: number) => Array.from({ length: n - 1 }, (_, i) => ({ t: 600 + i * 6000, kind: "kill" as const, client: i + 1 }));
    const p5 = zkElection({ mode: "pred", clients: 5, maxClients: 5, actions: kills(5) });
    const h5 = zkElection({ mode: "herd", clients: 5, maxClients: 5, actions: kills(5) });
    expect(expiryNotifications(p5)).toEqual([1, 1, 1, 1]);
    expect(expiryNotifications(h5)).toEqual([4, 3, 2, 1]);
    const p8 = zkElection({ mode: "pred", clients: 8, maxClients: 8, actions: kills(8) });
    const h8 = zkElection({ mode: "herd", clients: 8, maxClients: 8, actions: kills(8) });
    expect([p8.notifications, h8.notifications]).toEqual([7, 35]);
    expect([p8.requests, h8.requests]).toEqual([69, 133]);
    expect(liveLeaders(h8)).toEqual([8]);
    const one = zkElection({ mode: "pred", actions: [{ t: 600, kind: "kill", client: 1 }] });
    expect(one.leaders[1]!.client).toBe(2);
    expect(Math.round(one.leaders[1]!.t - 600)).toBe(3525);
  });

  test("etcd watch after a 400 ms cut", () => {
    const next = watchRun({ resume: "next" });
    expect([next.expected.length, next.missed.length, next.duplicates.length, next.stateMatches]).toEqual([30, 0, 0, true]);
    expect(watchRun({ resume: "last" }).duplicates).toEqual([8]);
    const now = watchRun({ resume: "now" });
    expect([now.missed.length, now.stateMatches]).toEqual([12, false]);
    const k5 = watchRun({ keep: 5 });
    expect([k5.missed.length, k5.relists, k5.stateMatches]).toEqual([12, 1, true]);
  });

  test("MvccStore: revisions, compaction and leases", () => {
    const s = new MvccStore();
    s.put("a", "1");
    s.put("a", "2");
    expect(s.kv.get("a")).toMatchObject({ createRev: 2, modRev: 3, version: 2 });
    s.compact(3);
    expect(s.eventsFrom("", 2).compacted).toBe(true);
    expect(s.eventsFrom("", 3).events.map((e) => e.rev)).toEqual([3]);
    const l = s.grant(1000, 0);
    s.put("svc/x", "up", l);
    expect(s.expireLeases(999)).toEqual([]);
    expect(s.keepAlive(l, 900)).toBe(true);
    expect(s.expireLeases(1899)).toEqual([]);
    expect(s.expireLeases(1900).map((e) => [e.type, e.key])).toEqual([["DELETE", "svc/x"]]);
  });
});
