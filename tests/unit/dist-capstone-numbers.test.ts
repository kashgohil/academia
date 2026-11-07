/** Pins every number that the four capstone lessons quote. Each one comes from src/sims/dist/capstone. */
import { describe, expect, test } from "vitest";
import {
  traceOp, ARCH_DEFAULT, readCost, writeCost, consequences, DESIGN_INPUTS, STORE_DEFAULT, leaseRestart,
  FUZZ_DEFAULT, Campaign, bugConfig, firstFailingSeed, shrinkAll, runSim, genSchedule, flow, fit, WORKLOADS,
  FLOW_INPUTS, FIT_INPUTS, type FuzzConfig,
} from "@/sims/dist/capstone";

const r1 = (x: number) => Number(x.toFixed(1));

describe("architecture-of-a-replicated-store", () => {
  const base = { ...ARCH_DEFAULT, key: "cat", readMode: "readindex" as const, cached: true };
  test("a put: 8 messages in 55.7 ms (2 + 2 + 4)", () => {
    const t = traceOp({ ...base, op: "put" });
    expect(t.msgs).toBe(8);
    expect(r1(t.ms)).toBe(55.7);
    const m = Object.fromEntries(t.layers.map((l) => [l.id, l.msgs]));
    expect([m.api, m.lead, m.raft]).toEqual([2, 2, 4]);
  });
  test("a get: 8 messages with ReadIndex; 4 messages and 40.9 ms with a lease; the Prediction's answer is none", () => {
    expect(traceOp({ ...base, op: "get" }).msgs).toBe(8);
    const lease = traceOp({ ...base, op: "get", readMode: "lease" });
    expect(lease.msgs).toBe(4);
    expect(r1(lease.ms)).toBe(40.9);
    expect(lease.layers.find((l) => l.id === "raft")!.msgs).toBe(0);
  });
  test("a cache miss adds 6 messages and 33.3 ms", () => {
    const miss = traceOp({ ...base, op: "put", cached: false }), hit = traceOp({ ...base, op: "put" });
    expect(miss.msgs - hit.msgs).toBe(6);
    expect(r1(miss.ms - hit.ms)).toBe(33.3);
  });
  test("a two-range transaction: 24 messages in 62.6 ms, then 12 to resolve intents", () => {
    const t = traceOp({ ...base, op: "txn" });
    expect(t.msgs).toBe(24);
    expect(r1(t.ms)).toBe(62.6);
    expect(t.background).toBe(12);
  });
  test("read paths and writes, 3 servers", () => {
    expect(r1(writeCost(3).meanMs)).toBe(37.7);
    const log = readCost("log"), ri = readCost("readindex"), lease = readCost("lease");
    expect([log.msgsPerRead, ri.msgsPerRead, lease.msgsPerRead]).toEqual([6, 6, 2]);
    expect([r1(log.meanMs), r1(ri.meanMs), r1(lease.meanMs)]).toEqual([37.7, 38.7, 20.3]);
  });
  test("the design explorer", () => {
    const single = consequences({ grouping: "single", reads: "readindex", splits: "auto", replicas: 3 });
    const multi = consequences({ grouping: "multi", reads: "readindex", splits: "auto", replicas: 3 });
    const lease = consequences({ grouping: "multi", reads: "lease", splits: "auto", replicas: 3 });
    const five = consequences({ grouping: "multi", reads: "lease", splits: "auto", replicas: 5 });
    expect(single.writeCeiling).toBe(20000);
    expect(multi.writeCeiling).toBe(60000);
    expect(five.writeCeiling).toBe(36000);
    expect(Math.round(multi.blast * 100)).toBe(11);
    expect(multi.ranges).toBe(8000);
    expect(multi.heartbeats).toBe(640000);
    expect(multi.heartbeatsCoalesced).toBe(1440);
    expect([r1(multi.readMs), r1(lease.readMs)]).toEqual([38.7, 20.3]);
    expect(single.matches[0]).toMatch(/^etcd/);
    expect(lease.matches.map((m) => m.split(" ")[0])).toEqual(["CockroachDB", "DynamoDB"]);
    expect(DESIGN_INPUTS).toMatchObject({ nodes: 9, nodeOpsPerSec: 20000, splitMiB: 512, heartbeatMs: 50 });
  });
});

describe("a-raft-key-value-store-end-to-end", () => {
  test("model inputs: 5–15 ms delays, a 5% drift bound", () => {
    expect(STORE_DEFAULT.latency).toEqual({ min: 5, max: 15 });
    expect(STORE_DEFAULT.driftBound).toBe(0.05);
  });
  test("without the restart rule, the old leader serves x=0 after x=1 committed; with it, the vote is ignored", () => {
    const bad = leaseRestart(false), good = leaseRestart(true);
    expect(bad.committed).toBe(1);
    expect(bad.read).toBe(0);
    expect(bad.linearizable).toBe(false);
    expect(good.newLeader).toBeNull();
    expect(good.votesDropped).toBeGreaterThan(0);
    expect(good.linearizable).toBe(true);
  });
  test("the random fuzzer does not find it in 1,000 seeds", () => {
    const cfg: FuzzConfig = { ...FUZZ_DEFAULT, readMode: "lease", restartGuard: false };
    let fails = 0;
    for (let s = 1; s <= 1000; s++) if (!runSim(s, genSchedule(s, cfg), cfg).result.ok) fails++;
    expect(fails).toBe(0);
  });
});

describe("deterministic-simulation-testing", () => {
  test("the run: 3 servers, 3 clients, 2 to 7 faults in the first 1,500 ms, then 1,200 ms more", () => {
    expect(FUZZ_DEFAULT).toMatchObject({ servers: 3, clients: 3, faultEnd: 1500, faults: { min: 2, max: 7 } });
    expect(FUZZ_DEFAULT.work + FUZZ_DEFAULT.drain).toBe(1200);
  });
  // 3,000 full fuzz runs: about 2 s alone, but over 5 s when the whole suite shares the CPU.
  test("1,000 seeds pass with each read path; the ReadIndex counters", { timeout: 60_000 }, () => {
    for (const mode of ["readindex", "lease", "log"] as const) {
      const c = new Campaign({ ...FUZZ_DEFAULT, readMode: mode });
      c.run(1000);
      expect(c.s.passed, mode).toBe(1000);
      if (mode === "readindex") {
        expect(c.s.ops).toBe(39700);
        expect(c.s.totals.elections).toBe(2173);
        expect(c.s.totals.truncations).toBe(237);
        expect(c.s.totals.dupSuppressed).toBe(290);
      }
    }
  });
  test("the four bugs: first failing seeds and minimal schedules", () => {
    const hunt = (bug: Parameters<typeof bugConfig>[0]) => {
      const cfg = bugConfig(bug);
      const f = firstFailingSeed(cfg, 2000)!;
      return { f, m: shrinkAll(f.seed, f.schedule, cfg) };
    };
    const fr = hunt("followerRead");
    expect([fr.f.seed, fr.f.schedule.length, fr.m.schedule.length]).toEqual([1, 5, 0]);
    const nd = hunt("noDedup");
    expect([nd.f.seed, nd.f.schedule.length, nd.m.schedule.length]).toEqual([5, 6, 1]);
    expect(nd.m.schedule[0]!.kind).toBe("crashAfterCommit");
    const fv = hunt("forgetVote");
    expect(fv.f.seed).toBe(5);
    expect(fv.m.result.failure!.text).toMatch(/^Election Safety: .* both leaders of term 2$/);
    expect(fv.m.schedule.some((x) => x.kind === "restartVoter")).toBe(true);
    const ot = hunt("oldTermCommit");
    expect(ot.f.seed).toBe(590);
  });
  test("the Figure 8 bug does not fail in 1,000 seeds of the default mix", () => {
    const cfg: FuzzConfig = { ...FUZZ_DEFAULT, bugs: { oldTermCommit: true } };
    let fails = 0;
    for (let s = 1; s <= 1000; s++) if (!runSim(s, genSchedule(s, cfg), cfg).result.ok) fails++;
    expect(fails).toBe(0);
  });
  test("the old monitor's false alarm: seed 103, a pause of S3 at 180 ms for 262 ms", () => {
    const { store, result } = runSim(103, [{ kind: "pause", at: 180, dur: 262, node: 2 }], { ...FUZZ_DEFAULT, swarm: false });
    // S3 leads term 1 after entry 1 was committed in term 2: legal Raft, and the fixed monitor does not flag it.
    expect(store.cluster.events.some((e) => e.kind === "role" && e.role === "leader" && e.node === 2 && e.term === 1)).toBe(true);
    expect(store.cluster.violations).toEqual([]);
    expect(store.raftViolations()).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("etcd-cockroachdb-and-dynamodb-compared", () => {
  test("model inputs", () => expect(FLOW_INPUTS).toEqual({ hop: 0.5, fsync: 1 }));
  test("one write: 6 hops and 4.0 ms each; 9, 8 and 8 messages", () => {
    const w = (["etcd", "crdb", "dynamo"] as const).map((s) => flow(s, "write"));
    expect(w.map((f) => f.hops)).toEqual([6, 6, 6]);
    expect(w.map((f) => f.end)).toEqual([4, 4, 4]);
    expect(w.map((f) => f.messages)).toEqual([9, 8, 8]);
  });
  test("one read: 8 messages and 3.0 ms in etcd, 4 and 2.0 ms in the lease designs", () => {
    const r = (["etcd", "crdb", "dynamo"] as const).map((s) => flow(s, "read"));
    expect(r.map((f) => f.messages)).toEqual([8, 4, 4]);
    expect(r.map((f) => f.end)).toEqual([3, 2, 2]);
  });
  test("direct: etcd read 6 messages and 2.0 ms; a CockroachDB gateway with the lease, 2 and 1.0 ms; stale etcd read 2", () => {
    expect([flow("etcd", "read", true).messages, flow("etcd", "read", true).end]).toEqual([6, 2]);
    expect([flow("crdb", "read", true).messages, flow("crdb", "read", true).end]).toEqual([2, 1]);
    expect(flow("etcd", "read", false, true).messages).toBe(2);
  });
  test("workload fit", () => {
    const f = (w: string, s: "etcd" | "crdb" | "dynamo") => fit(s, WORKLOADS.find((x) => x.id === w)!);
    expect(["etcd", "crdb", "dynamo"].every((s) => f("config", s as "etcd").fits)).toBe(true);
    expect(f("cart", "etcd").why.length).toBe(2);
    expect(f("cart", "crdb").throughput).toBe(1.5);
    expect(f("cart", "dynamo").fits).toBe(true);
    expect(f("ledger", "etcd").fits).toBe(false);
    expect(f("ledger", "etcd").size).toBeLessThan(1);
    expect(f("ledger", "crdb").fits && f("ledger", "dynamo").fits).toBe(true);
    expect(f("counter", "dynamo").fits).toBe(false);
    expect(f("counter", "etcd").fits && f("counter", "crdb").fits).toBe(true);
    expect(WORKLOADS.find((x) => x.id === "cart")).toMatchObject({ dataGiB: 800, writesPerSec: 40000 });
    expect(WORKLOADS.find((x) => x.id === "ledger")).toMatchObject({ dataGiB: 300, txnKeys: 4 });
    expect(WORKLOADS.find((x) => x.id === "counter")).toMatchObject({ hotKeyWrites: 5000 });
    expect(FIT_INPUTS).toMatchObject({ leaderWrites: 20000, crdbNodes: 9, etcdMaxGiB: 8, dynamoPartitionWrites: 1000, dynamoTxnItems: 100 });
  });
});
