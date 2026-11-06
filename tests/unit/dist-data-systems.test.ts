/** Distributed Systems, Data systems: the numbers that the four lessons quote, from the sims in src/sims/dist/data-systems. */
import { describe, expect, test } from "vitest";
import {
  meanField, pushPullRounds, pushRounds, spreadStats, runSpread,
  probeFailP, runSwim, swimSummary, suspicionTimeout, SWIM_DEFAULTS,
  assign, runGroup,
  runRepLog,
  runStream,
  runCheckpoint,
  runPipeline, runIdemProducer, GUARANTEES, amountOf, type CrashPoint, type IdemAction,
} from "@/sims/dist/data-systems";
import { mulberry32 } from "@/sims/rng";

describe("gossip-and-swim: epidemics", () => {
  test("classic round estimates at n = 1024", () => {
    expect(pushRounds(1024)).toBeCloseTo(16.93, 2);
    expect(pushPullRounds(1024)).toBeCloseTo(6.31, 2);
    expect(Math.E / (Math.E - 1)).toBeCloseTo(1.58, 2); // SWIM's expected detection time, in periods
  });
  test("pull squares the susceptible fraction: 1% → 0.01% → 1e-8", () => {
    const s = meanField("pull", 1e12, 1, 0, 1);
    expect(s[1]).toBeCloseTo(s[0]! ** 2, 12);
    expect(0.01 ** 2).toBeCloseTo(1e-4, 12);
    expect(0.0001 ** 2).toBeCloseTo(1e-8, 15);
  });
  test("push and push-pull at 1024 nodes over 1000 seeds", () => {
    const push = spreadStats({ n: 1024, mode: "push" }, 1000);
    expect(push.mean).toBeCloseTo(18.1, 1);
    expect(push.max).toBe(26);
    const pp = spreadStats({ n: 1024, mode: "push-pull" }, 1000);
    expect(pp.mean).toBeCloseTo(8.2, 1);
    expect(pp.max).toBe(10);
    expect(spreadStats({ n: 16, mode: "push-pull" }, 1000).mean).toBeCloseTo(3.7, 1);
  }, 300_000);
  test("push-pull with 20% loss at 1024 nodes", () => {
    expect(spreadStats({ n: 1024, mode: "push-pull", dropRate: 0.2 }, 100).mean).toBeCloseTo(12.0, 1);
  }, 300_000);
  test("rumor mongering: residue and messages for k = 1..4 at 1024 nodes", () => {
    const rows = [1, 2, 3, 4].map((k) => spreadStats({ n: 1024, mode: "push", stopAfter: k }, 50));
    expect(rows.map((r) => +(r.residue * 100).toFixed(2))).toEqual([20.47, 5.96, 2, 0.79]);
    expect(rows.map((r) => +r.msgsPerNode.toFixed(1))).toEqual([3.2, 5.6, 7.8, 9.9]);
    for (const r of rows) expect(r.done).toBe(0); // the rumor always dies out before everyone knows
  }, 300_000);
  test("the demo's default run", () => {
    expect(runSpread({ n: 64, mode: "push", seed: 7 }).roundsToAll).toBe(11);
  });
});

describe("gossip-and-swim: SWIM", () => {
  const LONG = 300_000;
  test("suspicion timeout for 8 members is 4 s", () => {
    expect(suspicionTimeout(SWIM_DEFAULTS)).toBe(4000);
  });
  test("a slow member: false suspicions with direct pings only, none with k = 3", () => {
    expect(swimSummary(runSwim({ k: 0, horizon: LONG })).falseSusp).toBe(103);
    const k3 = runSwim({ k: 3, horizon: LONG });
    expect(swimSummary(k3).falseSusp).toBe(0);
    expect(swimSummary(k3).msgsPerMemberPerPeriod).toBeCloseTo(2.64, 2);
    expect(k3.probes.indirect).toBe(116);
    expect(swimSummary(runSwim({ k: 0, suspicion: false, horizon: LONG })).deadAboutLive).toBe(608);
  });
  test("healthy members with 5% loss: failed probes against the formula", () => {
    const none = { kind: "none" as const };
    const k0 = runSwim({ k: 0, dropRate: 0.05, horizon: LONG, fault: none });
    const k3 = runSwim({ k: 3, dropRate: 0.05, horizon: LONG, fault: none });
    const probes = (r: typeof k0) => r.probes.direct + r.probes.indirect + r.probes.failed;
    expect(k0.probes.failed).toBe(244);
    expect(probeFailP(0.05, 0) * probes(k0)).toBeCloseTo(234, 0);
    expect(k3.probes.failed).toBe(2);
    expect(probeFailP(0.05, 3) * probes(k3)).toBeCloseTo(1.5, 1);
    expect(swimSummary(runSwim({ horizon: LONG, fault: none })).msgsPerMemberPerPeriod).toBeCloseTo(2.06, 2);
  });
  test("a crash at 2 s: first suspicion and all-dead times", () => {
    const s = swimSummary(runSwim({ fault: { ...SWIM_DEFAULTS.fault, kind: "crash", at: 2000 } }));
    expect((s.firstSuspectAt! - 2000) / 1000).toBeCloseTo(1.9, 1);
    expect((s.allDeadAt! - 2000) / 1000).toBeCloseTo(6.8, 1);
  });
});

describe("distributed-logs: consumer group", () => {
  const join = [2, 3].map((i) => ({ t: 20, op: "join" as const, id: `c${i + 1}` }));
  test("range assignment and idle consumers", () => {
    expect(assign("range", 6, ["c1", "c2"])).toEqual(["c1", "c1", "c1", "c2", "c2", "c2"]);
    const eight = assign("range", 6, Array.from({ length: 8 }, (_, i) => `c${i + 1}`));
    expect(new Set(eight).size).toBe(6); // two of eight consumers get nothing
  });
  test("eager range against cooperative sticky", () => {
    const eager = runGroup({ events: join, capacity: 250 });
    expect(eager.total[80]! - 150).toBeCloseTo(2000, 0); // 100 records/s for 20 s, plus the first pause step
    expect(Math.max(...eager.total)).toBeCloseTo(3800, 0);
    expect(eager.assignments[1]!.moved).toBe(3);
    const drained = (r: typeof eager) => r.t[r.total.findIndex((x, i) => i > 100 && x < 1)]!;
    expect(drained(eager)).toBeCloseTo(48.25, 2);
    const coop = runGroup({ events: join, capacity: 250, assignor: "sticky", protocol: "cooperative" });
    expect(coop.assignments[1]!.moved).toBe(2);
    expect(Math.max(...coop.total)).toBeCloseTo(2600, 0);
    expect(drained(coop)).toBeCloseTo(33.25, 2);
  });
  test("a crashed consumer: its partitions wait for the 45 s session timeout", () => {
    const r = runGroup({ events: [...join, { t: 60, op: "crash", id: "c4" }], capacity: 250 });
    expect(r.assignments[2]!.t).toBe(105);
    expect(Math.max(...r.total)).toBeCloseTo(6300, 0);
  });
});

describe("distributed-logs: replication", () => {
  const run = (acks: "0" | "1" | "all", minIsr: number, unclean: boolean, pause: number) =>
    runRepLog({ acks, minIsr, unclean, stalls: pause ? [2, 3].map((node) => ({ node, from: 200 - pause, until: 400 })) : [], crashes: [{ t: 200, node: 1 }], recovers: [{ t: 450, node: 1 }] });
  test("acks=1 loses records the followers had not fetched; acks=all refuses instead", () => {
    expect(run("1", 2, false, 40).lost).toEqual([8, 9]);
    const all = run("all", 2, false, 40);
    expect(all.lost).toEqual([]);
    expect(all.rejected.length).toBe(8);
  });
  test("followers out of the ISR: offline without unclean election, loss with it", () => {
    const clean = run("1", 1, false, 100);
    expect(clean.lost).toEqual([]);
    expect(clean.elections[0]!.leader).toBe(-1);
    const unclean = run("1", 1, true, 100);
    expect(unclean.lost).toEqual([5, 6, 7, 8, 9]);
    expect(unclean.seenThenLost).toEqual([5, 6, 7, 8, 9]);
    const guarded = run("all", 2, true, 100);
    expect(guarded.lost).toEqual([]);
    expect(guarded.seenThenLost).toEqual([5, 6, 7, 8]);
  });
});

describe("stream-processing", () => {
  test("watermark delay against dropped events, wrong windows and wait", () => {
    const at = (delay: number, allowedLateness = 0) => runStream({ delay, allowedLateness });
    const d200 = at(200);
    expect([d200.dropped.length, d200.wrong.length, d200.batch.size]).toEqual([4, 3, 8]);
    expect(d200.meanLatency).toBeCloseTo(321, 0);
    expect(d200.maxDisorder).toBe(2019);
    const d1000 = at(1000);
    expect(d1000.dropped.length).toBe(2);
    expect(d1000.meanLatency).toBeCloseTo(1092, 0);
    const d2000 = at(2000);
    expect(d2000.wrong.length).toBe(0);
    expect(d2000.meanLatency).toBeCloseTo(2094, 0);
    const late = at(200, 1000);
    expect([late.wrong.length, late.updatedLate.length]).toEqual([0, 4]);
  });
  test("checkpoints: aligned recovery is exact, the sink sees duplicates; no alignment double counts", () => {
    const a = runCheckpoint({ aligned: true, crashAt: 100 });
    expect(a.final).toMatchObject({ cA: 16, cB: 6, sinkDup: 6 });
    expect(a.restoredFrom).toMatchObject({ id: 1, offA: 6, offB: 2, cA: 6, cB: 2 });
    expect(runCheckpoint({ aligned: false, crashAt: 100 }).final.cB).toBe(7);
    const late = runCheckpoint({ aligned: true, crashAt: 250 });
    expect(late.final.sinkDup).toBe(0);
    expect(late.restoredFrom!.id).toBe(3);
  });
});

describe("exactly-once-semantics", () => {
  test("the default crash point: lost, duplicated, exact", () => {
    const [amo, alo, eos] = GUARANTEES.map((mode) => runPipeline({ mode }));
    expect([amo!.lost, amo!.balance]).toEqual([1, 180]);
    expect([alo!.duplicated, alo!.balance]).toEqual([1, 240]);
    expect([eos!.lost, eos!.duplicated, eos!.balance]).toEqual([0, 0, 210]);
    expect(Array.from({ length: 6 }, (_, i) => amountOf(i)).reduce((a, b) => a + b)).toBe(210);
  });
  test("20% loss and no crash", () => {
    const [amo, alo, eos] = GUARANTEES.map((mode) => runPipeline({ mode, crashes: [], dropRate: 0.2 }));
    expect(amo!.lost).toBe(1);
    expect(alo!.duplicated).toBe(7);
    expect(eos!.duplicated + eos!.lost).toBe(0);
  });
  test("300 runs with 1 to 3 random crash points and 10% loss", () => {
    const totals = GUARANTEES.map((mode) => {
      let lost = 0, dup = 0;
      for (let s = 1; s <= 300; s++) {
        const r = runPipeline({ mode, seed: s, crashes: randomCrashes(s), dropRate: 0.1 });
        lost += r.lost;
        dup += r.duplicated;
      }
      return [lost, dup];
    });
    expect(totals).toEqual([[338, 0], [0, 411], [0, 0]]);
  });
  test("idempotent producer: a lost ack and a retry", () => {
    const lostAck = (idempotent: boolean) => drive(idempotent, "ack");
    expect(lostAck(true).log.map((x) => x.seq)).toEqual([0, 1, 2]);
    expect(lostAck(false).log.map((x) => x.seq)).toEqual([0, 1, 2, 0]);
    expect(drive(true, "batch").log.map((x) => x.seq)).toEqual([0, 1, 2]);
    expect(drive(false, "batch").log.map((x) => x.seq)).toEqual([1, 2, 0]);
  });
});

export function randomCrashes(seed: number): CrashPoint[] {
  const rng = mulberry32(seed);
  return Array.from({ length: 1 + Math.floor(rng() * 3) }, () => ({ rec: Math.floor(rng() * 6), phase: (["read", "first", "second"] as const)[Math.floor(rng() * 3)]! }));
}

/** Loses batch 0's first ack (or the first copy of batch 0), then delivers everything in order, waiting when idle. */
function drive(idempotent: boolean, lose: "ack" | "batch") {
  const actions: IdemAction[] = [];
  let lost = false;
  for (let i = 0; i < 40; i++) {
    const r = runIdemProducer({ idempotent, maxInFlight: 2 }, actions);
    const target = r.held.find((m) => (lose === "ack" ? m.payload.k === "ack" : m.payload.k === "produce") && m.payload.seq === 0);
    if (target && !lost) { lost = true; actions.push({ k: "drop", id: target.id }); continue; }
    if (r.held.length) actions.push({ k: "deliver", id: r.held[0]!.id });
    else if (r.acked.some((x) => x === null)) actions.push({ k: "wait" });
    else return r;
  }
  return runIdemProducer({ idempotent, maxInFlight: 2 }, actions);
}
