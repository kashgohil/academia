/** Distributed transactions: the safety properties of the module's protocols, on random runs. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import { TwoPc, type Vote, type TpcMode } from "@/sims/dist/transactions/twopc";
import { externalTrials, externalRun, DEFAULT_EXT } from "@/sims/dist/transactions/truetime";
import { calvinRun, DEFAULT_CALVIN, CALVIN_OPS } from "@/sims/dist/transactions/calvin";
import { checkSI, randomPercolator, Percolator, siHistory } from "@/sims/dist/transactions/percolator";
import { runSaga } from "@/sims/dist/transactions/saga";

describe("two-phase commit is atomic under crashes, recoveries and message loss", () => {
  test("all participants commit or all abort, and a logged commit means everyone commits", () => {
    let committed = 0, aborted = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rng = mulberry32(seed);
      const n = 2 + (seed % 3);
      const votes: Vote[] = Array.from({ length: n }, () => (rng() < 0.15 ? "no" : rng() < 0.15 ? "ro" : "yes"));
      const mode: TpcMode = rng() < 0.5 ? "pa" : "basic";
      const x = new TwoPc({ participants: n, mode, votes, cooperative: rng() < 0.5, net: { seed, latency: { min: 2, max: 20 }, dropRate: rng() * 0.2, dupRate: rng() * 0.1 } });
      // Random crashes and recoveries of any node, during the first 400 ms.
      const events = Array.from({ length: 6 }, () => ({ at: rng() * 400, node: Math.floor(rng() * (n + 1)), down: 20 + rng() * 300 })).sort((a, b) => a.at - b.at);
      x.start();
      for (const e of events) {
        x.net.runUntil(e.at);
        x.crash(e.node);
        x.net.runUntil(e.at + e.down);
        x.recover(e.node);
        expect(x.violations, `seed ${seed}`).toEqual([]);
      }
      for (let i = 0; i <= n; i++) x.recover(i);
      x.net.cfg.dropRate = 0;
      x.net.runUntil(x.net.now + 3000);
      expect(x.violations, `seed ${seed}`).toEqual([]);
      expect(x.allDecided(), `seed ${seed}: every participant learns the outcome once all nodes are up`).toBe(true);
      // A read-only participant writes nothing and forgets the transaction, so only writers count.
      const states = x.parts.filter((p) => x.vote(p.id) !== "ro").map((p) => p.state);
      const c = states.filter((s) => s === "committed").length;
      expect(c === 0 || c === states.length, `seed ${seed}: ${states.join(",")}`).toBe(true);
      const loggedCommit = x.coord.log.some((r) => r.rec === "commit");
      if (loggedCommit) expect(states.every((s) => s === "committed"), `seed ${seed}`).toBe(true);
      if (votes.includes("no")) expect(c, `seed ${seed}: a NO vote forces abort`).toBe(0);
      if (c) committed++;
      else aborted++;
    }
    // The random runs exercise both outcomes.
    expect(committed).toBeGreaterThan(20);
    expect(aborted).toBeGreaterThan(20);
  });
});

describe("TrueTime commit wait", () => {
  test("external consistency always holds with commit wait, on random clocks and gaps", () => {
    for (const eps of [0.5, 1, 4, 7, 20]) expect(externalTrials(eps, true, 400, Math.round(eps * 10)).violations).toBe(0);
  });
  test("without commit wait, the scripted fast-A, slow-B case gives s2 < s1", () => {
    const r = externalRun({ ...DEFAULT_EXT, commitWait: false });
    expect(r.ack1).toBeLessThan(r.start2); // T1 finished before T2 started, in real time
    expect(r.t2.s).toBeLessThan(r.t1.s);
    expect(externalTrials(4, false, 500, 7).violations).toBeGreaterThan(0);
  });
  test("the commit becomes visible only after true time passes s", () => {
    const rng = mulberry32(11);
    for (let k = 0; k < 200; k++) {
      const eps = 0.5 + rng() * 20;
      const r = externalRun({ ...DEFAULT_EXT, eps, commitWait: true, errA: (2 * rng() - 1) * eps, errB: (2 * rng() - 1) * eps, gap: rng() * 10 });
      expect(r.t1.visible).toBeGreaterThanOrEqual(r.t1.s - 1e-9);
      expect(r.t2.visible).toBeGreaterThanOrEqual(r.t2.s - 1e-9);
    }
  });
});

describe("Calvin replicas", () => {
  test("deterministic execution: replicas always reach identical states", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = mulberry32(seed);
      const arrivals = Array.from({ length: 12 }, () => rng() * 80).sort((a, b) => a - b);
      const ops = arrivals.map(() => CALVIN_OPS[Math.floor(rng() * CALVIN_OPS.length)]!).map((o, i) => ({ ...o, id: `T${i + 1}` }));
      const r = calvinRun({ ...DEFAULT_CALVIN, epoch: 2 + Math.floor(rng() * 25), replicas: 2 + (seed % 4), lagLast: rng() * 40, seed }, arrivals, ops);
      expect(r.identical, `seed ${seed}`).toBe(true);
      for (const v of r.replicas) expect(v.order).toEqual(r.replicas[0]!.order);
      expect(r.replicas[0]!.order.length).toBe(12);
    }
  });
  test("with racing threads, some runs diverge", () => {
    let diverged = 0;
    for (let seed = 1; seed <= 30; seed++) if (!calvinRun({ ...DEFAULT_CALVIN, race: true, epoch: 20, seed }).identical) diverged++;
    expect(diverged).toBeGreaterThan(10);
  });
});

describe("Percolator provides snapshot isolation", () => {
  test("random concurrent transfers and audits with crashes pass the SI checker", () => {
    let committed = 0, crashed = 0, cleanups = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const r = randomPercolator({ seed, clients: 2 + (seed % 4), accounts: 3 + (seed % 3), perClient: 12, crashRate: 0.02 + (seed % 5) * 0.01, audits: 0.3 });
      expect(r.violations, `seed ${seed}`).toEqual([]);
      for (const s of r.auditSums) expect(s).toBe(r.total);
      committed += r.committed;
      crashed += r.crashed;
      cleanups += r.p.resolutions.length;
    }
    expect(committed).toBeGreaterThan(200);
    expect(crashed).toBeGreaterThan(20);
    expect(cleanups).toBeGreaterThan(20);
  });

  test("the checker catches a lost update and a read outside the snapshot", () => {
    const lost = checkSI([
      { name: "T1", startTs: 3, commitTs: 6, reads: [{ key: "x", from: 1 }], writes: ["x"] },
      { name: "T2", startTs: 4, commitTs: 7, reads: [{ key: "x", from: 1 }], writes: ["x"] },
    ], 1);
    expect(lost.some((v) => v.includes("lost update"))).toBe(true);
    const stale = checkSI([
      { name: "T1", startTs: 3, commitTs: 4, reads: [], writes: ["x"] },
      { name: "T2", startTs: 5, commitTs: 5, reads: [{ key: "x", from: 1 }], writes: [] },
    ], 1);
    expect(stale.length).toBe(1);
  });

  test("a lock left by a dead client never makes a half transfer visible", () => {
    const p = new Percolator();
    p.load({ a: 5, b: 5 });
    const t = p.begin();
    p.set(t, "a", 4);
    p.set(t, "b", 6);
    p.prewrite(t, "a");
    p.prewrite(t, "b");
    p.commitPrimary(t);
    p.crash(t);
    const r = p.begin();
    const dead = () => true;
    const a = p.get(r, "a", dead), b = p.get(r, "b", dead);
    expect(a.kind === "value" && b.kind === "value" && a.value! + b.value!).toBe(10);
    expect(checkSI(siHistory(p), 1)).toEqual([]);
  });
});

describe("sagas", () => {
  test("every orchestrated or choreographed saga ends all-or-nothing when no step crashes", () => {
    for (const mode of ["orchestration", "choreography"] as const)
      for (const fail of [0, 1, 2, 3])
        for (const semanticLock of [false, true]) {
          const s = runSaga({ mode, fail, semanticLock });
          expect(s.result).toBe(fail ? "compensated" : "completed");
          expect(s.atomicEnd()).toBe(true);
          expect(s.invariantBroken()).toEqual([]);
        }
  });
});
