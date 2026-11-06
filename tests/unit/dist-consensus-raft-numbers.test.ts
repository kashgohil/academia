/** Pins every number that the three Raft lessons quote. Each comes from the simulation in src/sims/dist/consensus/raft. */
import { describe, expect, test } from "vitest";
import { LOAD_MODES, electionPoint, expectedFirstGap, loadRun, quorumSize, snapshotRun } from "@/sims/dist/consensus/raft";

describe("raft-leader-election", () => {
  test("the gap between the first two timers: S/(n+1)", () => {
    expect(expectedFirstGap(150, 4)).toBe(30);
    expect(expectedFirstGap(5, 4)).toBe(1);
  });

  test("failover time against timeout spread (150 ms minimum, 40 failovers each)", () => {
    const p = (s: number) => electionPoint(s, 40, 150);
    const at150 = p(150), at50 = p(50), at25 = p(25), at5 = p(5), at0 = p(0);
    expect(Math.round(at150.mean)).toBe(203);
    expect(at150.rounds).toBeCloseTo(1.05, 2);
    expect(Math.round(at50.mean)).toBe(233);
    expect(at50.rounds).toBeCloseTo(1.38, 2);
    expect(Math.round(at25.mean)).toBe(351);
    expect((at5.mean / 1000).toFixed(1)).toBe("3.1");
    expect((at0.mean / 1000).toFixed(1)).toBe("9.0");
    expect(at0.rounds.toFixed(1)).toBe("59.6");
    expect(at5.mean / at150.mean).toBeGreaterThan(10); // "more than tenfold"
  });
});

describe("raft-log-replication", () => {
  const run = (id: string, clients: number) => {
    const m = LOAD_MODES.find((x) => x.id === id)!;
    return loadRun({ latency: 5, diskMs: 2, maxBatch: m.maxBatch, maxInflight: m.maxInflight, clients }, 1000);
  };
  test("stop-and-wait commits one command per 12 ms round", () => {
    for (const k of [1, 8, 64]) expect(Math.round(run("stop", k).throughput)).toBe(83);
  });
  test("pipelining alone, batching alone, and both", () => {
    expect(Math.round(run("pipe", 64).throughput)).toBe(1210);
    expect(Math.round(run("pipe", 32).throughput)).toBe(1210);
    const b = run("batch", 64), both = run("both", 64);
    expect(Math.round(b.throughput)).toBe(3638);
    expect(b.latency.toFixed(1)).toBe("17.7");
    expect(Math.round(both.throughput)).toBe(4756);
    expect(both.latency.toFixed(1)).toBe("13.4");
  });
});

describe("raft-membership-changes-and-snapshots", () => {
  test("majority sizes in the single-server table", () => {
    expect([3, 4, 5].map(quorumSize)).toEqual([2, 3, 3]);
    for (let n = 1; n < 50; n++) expect(quorumSize(n) + quorumSize(n + 1)).toBe(n + 2);
  });

  test("a lagging follower: snapshots against log replay", () => {
    const snap = snapshotRun({ threshold: 20, chunk: 100, rejoinAt: 900 });
    expect(snap.lag).toBe(4); // S5
    expect(snap.installs).toBe(2);
    expect(snap.chunks).toBe(6);
    expect(snap.catchupBytes).toBe(476);
    expect(Math.max(...snap.series.map((p) => Math.max(...p.len)))).toBeLessThanOrEqual(22);
    expect(snap.converged).toBe(true);
    expect(snap.violations).toEqual([]);

    const replay = snapshotRun({ threshold: 0, chunk: 100, rejoinAt: 900 });
    expect(Math.max(...replay.series.map((p) => Math.max(...p.len)))).toBe(199);
    expect(replay.catchupMessages).toBe(4);
    expect(replay.catchupBytes).toBe(7150);
    expect(Math.round(replay.catchupBytes / snap.catchupBytes)).toBe(15);

    const big = snapshotRun({ threshold: 20, chunk: 300, rejoinAt: 900 });
    expect(big.chunks).toBeLessThan(snap.chunks);
    expect(big.catchupMs).toBeLessThan(snap.catchupMs);
  });
});
