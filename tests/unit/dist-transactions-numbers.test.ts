/** Distributed transactions: every number that the five lessons quote, and the behaviour their "things to try" describe. */
import { describe, expect, test } from "vitest";
import { DEFAULT_TPC, inDoubtRun, replayTpc, tpcCost, TwoPc, type TpcAction, type TpcCfg } from "@/sims/dist/transactions/twopc";
import { inDoubtReplicated } from "@/sims/dist/transactions/replicated";
import { threePcScenario } from "@/sims/dist/transactions/threepc";
import { runSaga, DEFAULT_SAGA } from "@/sims/dist/transactions/saga";
import { externalRun, externalTrials, hotKeyRun, commitLatency, DEFAULT_EXT, DEFAULT_HOT } from "@/sims/dist/transactions/truetime";
import { calvinRun, DEFAULT_CALVIN, CALVIN_OPS, mp2pc, mpCalvin } from "@/sims/dist/transactions/calvin";
import { replayPercolator, writeSkew } from "@/sims/dist/transactions/percolator";
import { DEFAULT_RAFT } from "@/sims/dist/consensus/raft";
import { findCycle } from "@/sims/db/txn/schedule";

/** Plays a plan of the 2PC stepper: "d:<node>:<kind>" delivers, "x:..." drops, "c0" crashes, "r0" recovers, "w" waits. */
function plan(cfg: Partial<TpcCfg>, steps: string[]): TwoPc {
  const acts: TpcAction[] = [];
  for (const step of steps) {
    const x = replayTpc(cfg, acts);
    if (step[0] === "d" || step[0] === "x") {
      const [, node, kind] = step.split(":");
      const m = x.net.held().find((m) => m.payload.k === kind && (m.to === Number(node) || m.from === Number(node)));
      if (!m) throw new Error(`no held ${step}`);
      acts.push({ a: step[0] === "d" ? "deliver" : "drop", id: m.id });
    } else if (step[0] === "c") acts.push({ a: "crash", node: Number(step.slice(1)) });
    else if (step[0] === "r") acts.push({ a: "recover", node: Number(step.slice(1)) });
    else acts.push({ a: "wait", ms: 100 });
  }
  return replayTpc(cfg, acts);
}
const forced = (x: TwoPc) => x.coord.forcedWrites + x.parts.reduce((a, p) => a + p.forcedWrites, 0);

describe("two-phase-commit", () => {
  test("stepper: the five things to try", () => {
    const all = plan({}, ["d:1:prepare", "d:2:prepare", "d:1:vote", "d:2:vote", "d:1:commit", "d:2:commit", "d:1:ack", "d:2:ack"]);
    expect(all.parts.map((p) => p.state)).toEqual(["committed", "committed"]);
    expect(all.net.messages.length).toBe(8);
    expect(forced(all)).toBe(5);
    expect(all.coord.forcedWrites).toBe(1);

    const blocked = plan({}, ["d:1:prepare", "d:2:prepare", "d:1:vote", "d:2:vote", "x:1:commit", "x:2:commit", "c0", "w", "w"]);
    expect(blocked.parts.map((p) => p.state)).toEqual(["prepared", "prepared"]);
    expect(blocked.parts.every((p) => p.locks)).toBe(true);
    expect(blocked.net.held().filter((m) => m.payload.k === "query").length).toBeGreaterThan(0);
    const healed = plan({}, ["d:1:prepare", "d:2:prepare", "d:1:vote", "d:2:vote", "x:1:commit", "x:2:commit", "c0", "w", "w", "r0", "d:1:commit", "d:2:commit"]);
    expect(healed.parts.map((p) => p.state)).toEqual(["committed", "committed"]);

    const no = plan({ votes: ["yes", "no"] }, ["d:1:prepare", "d:2:prepare", "d:2:vote"]);
    expect(no.coord.forcedWrites).toBe(0);
    expect(no.net.held().filter((m) => m.payload.k === "abort").map((m) => m.to)).toEqual([1]);

    const coop = plan({ cooperative: true }, ["d:1:prepare", "c0", "w", "d:2:query", "d:1:abort"]);
    expect(coop.parts.map((p) => p.state)).toEqual(["aborted", "aborted"]);
    expect(coop.violations).toEqual([]);
    // The timers that the caption quotes.
    expect(DEFAULT_TPC.retry).toBe(100);
    expect(DEFAULT_TPC.workTimeout).toBe(400);
  });

  test("log forces and messages, basic and presumed abort (the table)", () => {
    const row = (mode: "basic" | "pa", votes: ("yes" | "no" | "ro")[]) => { const c = tpcCost(mode, votes); return [c.coordForced, c.partForced, c.messages]; };
    expect(row("basic", ["yes", "yes"])).toEqual([1, 4, 8]);
    expect(row("pa", ["yes", "yes"])).toEqual([1, 4, 8]);
    expect(row("basic", ["yes", "no"])).toEqual([1, 2, 6]);
    expect(row("pa", ["yes", "no"])).toEqual([0, 1, 5]);
    expect(row("pa", ["yes", "ro"])).toEqual([1, 2, 6]);
    expect(row("pa", ["ro", "ro"])).toEqual([0, 0, 4]);
  });

  test("in-doubt time against coordinator repair time", () => {
    const d = inDoubtRun({ recoverAfter: 2000, retry: 100, cooperative: true, seed: 1 });
    expect(Math.round(d.inDoubt)).toBe(2017);
    expect(Math.round((d.inDoubt / 1000) * 50)).toBe(101);
    expect(Math.round((d.inDoubt / 1000) * 1000 / 100) * 100).toBe(2000);
    const long = inDoubtRun({ recoverAfter: 30000, retry: 100, cooperative: true, seed: 1 });
    expect(long.inDoubt).toBeGreaterThan(30000);
    // Raft group as coordinator: 8 runs, as the demo draws them.
    const r = Array.from({ length: 8 }, (_, s) => inDoubtReplicated(s + 1, 100).inDoubt);
    expect(Math.round(r.reduce((a, b) => a + b, 0) / 8)).toBe(315);
    expect(Math.round(Math.min(...r))).toBe(212);
    expect(Math.round(Math.max(...r))).toBe(516);
    expect(DEFAULT_RAFT.electionTimeout).toEqual({ min: 150, max: 300 });
  });

  test("3PC: nonblocking under a crash, split under a partition; 2PC blocks", () => {
    expect(threePcScenario("crash").outcomes()).toEqual(["committed", "committed", "committed"]);
    const part = threePcScenario("partition");
    expect(part.outcomes()).toEqual(["committed", "aborted", "aborted"]);
    expect(part.split()).toBe(true);
    const x = new TwoPc({ participants: 3, mode: "pa", workTimeout: 1e9, net: { seed: 1, latency: { min: 10, max: 10 } } });
    x.onDecision = () => x.crash(0);
    x.start();
    x.net.runUntil(250);
    expect(x.parts.map((p) => p.state)).toEqual(["prepared", "prepared", "prepared"]);
  });
});

describe("sagas", () => {
  test("trip demo", () => {
    const s = runSaga({ fail: 3, bAt: 25 });
    const at45 = [1, 2, 3].map((i) => s.stateAt(i, 45).bookings.find((b) => b.saga === "A")?.status ?? "none");
    expect(at45).toEqual(["CONFIRMED", "CONFIRMED", "none"]);
    expect(s.result).toBe("compensated");
    expect(s.resultAt).toBe(100);
    expect(s.sagaMessages()).toBe(10);
    expect(s.dirtyWindow(2)).toEqual({ from: 30, to: 70 });
    expect(DEFAULT_SAGA.capacity).toBe(2);
    const lost = runSaga({ fail: 3, bAt: 25, compensation: "restore" });
    expect(lost.svc[1]!.free).toBe(2);
    expect(lost.invariantBroken()).toEqual([1]);
    expect(lost.bResult).toBe("booked");
    const locked = runSaga({ fail: 3, bAt: 25, semanticLock: true });
    expect(locked.stateAt(1, 45).bookings.find((b) => b.saga === "A")?.status).toBe("PENDING");
    expect(runSaga({ fail: 0 }).sagaMessages()).toBe(6);
  });

  test("message counts, orchestration against choreography", () => {
    const n = (mode: "orchestration" | "choreography", fail: number, semanticLock = false) => runSaga({ mode, fail, semanticLock }).sagaMessages();
    expect([0, 1, 2, 3].map((f) => n("orchestration", f))).toEqual([6, 2, 6, 10]);
    expect([0, 1, 2, 3].map((f) => n("choreography", f))).toEqual([4, 2, 4, 6]);
    expect(n("orchestration", 0, true) - n("orchestration", 0)).toBe(6);
    expect(n("choreography", 0, true) - n("choreography", 0)).toBe(2);
  });

  test("a crash between commit and send", () => {
    const orch = runSaga({ mode: "orchestration", fail: 0, crashHotel: true, idempotent: true });
    expect(orch.result).toBe("completed");
    expect(orch.resultAt).toBe(120);
    expect(orch.doubleBooked()).toEqual([]);
    expect(DEFAULT_SAGA.retry).toBe(60);
    expect(runSaga({ mode: "choreography", fail: 0, crashHotel: true }).result).toBeNull();
    expect(runSaga({ mode: "orchestration", fail: 0, crashHotel: true, idempotent: false }).doubleBooked()).toEqual([2]);
    const ob = runSaga({ mode: "choreography", fail: 0, crashHotel: true, outbox: true });
    expect(ob.result).toBe("completed");
    expect(ob.resultAt).toBe(80);
  });
});

describe("spanner-and-truetime", () => {
  test("the commit-wait timeline", () => {
    const w = externalRun({ ...DEFAULT_EXT, commitWait: true });
    expect([w.t1.s, w.t2.s, w.t1.visible - w.t1.arrive, w.ok]).toEqual([9, 12, 8, true]);
    const nw = externalRun({ ...DEFAULT_EXT, commitWait: false });
    expect([nw.t1.s, nw.t2.s, nw.ok]).toEqual([9, 6, false]);
    expect(DEFAULT_EXT.paxos).toBe(2);
    expect(externalRun({ ...DEFAULT_EXT, gap: 4 }).ok).toBe(false);
    expect(externalRun({ ...DEFAULT_EXT, gap: 4.5 }).ok).toBe(true);
    expect(externalRun({ ...DEFAULT_EXT, errA: 0, errB: 0 }).ok).toBe(true);
    expect(externalRun({ ...DEFAULT_EXT, eps: 20, errA: 20, errB: -20, commitWait: true }).t1.visible - 1).toBe(40);
    expect(externalTrials(4, false, 500, 7).violations).toBe(19);
    expect(externalTrials(4, true, 500, 7).violations).toBe(0);
  });

  test("the cost of commit wait", () => {
    expect(DEFAULT_HOT.paxos).toBe(9);
    expect(Math.round(hotKeyRun({ ...DEFAULT_HOT, eps: 4.5 }).throughput)).toBe(111);
    expect(Math.round(hotKeyRun({ ...DEFAULT_HOT, eps: 4.5, commitWait: false }).throughput)).toBe(111);
    const e7 = hotKeyRun({ ...DEFAULT_HOT, eps: 7 });
    expect([e7.hold, Math.floor(e7.throughput)]).toEqual([14, 71]);
    const e250 = hotKeyRun({ ...DEFAULT_HOT, eps: 250 });
    expect(e250.hold).toBe(500);
    expect(e250.throughput).toBeLessThan(2);
    expect(hotKeyRun({ ...DEFAULT_HOT, eps: 25, paxos: 50 }).hold).toBe(50);
    expect(commitLatency(7, true)).toBeCloseTo(15, 6);
  });
});

describe("calvin-and-deterministic-databases", () => {
  test("replicas demo", () => {
    const r = calvinRun(DEFAULT_CALVIN);
    expect(r.batches.length).toBe(4);
    expect(r.replicas.map((x) => x.state)).toEqual([{ x: 10, y: 27 }, { x: 10, y: 27 }, { x: 10, y: 27 }]);
    const e20 = calvinRun({ ...DEFAULT_CALVIN, epoch: 20 });
    expect([e20.batches.length, e20.replicas[0]!.state]).toEqual([2, { x: 10, y: 27 }]);
    expect(calvinRun({ ...DEFAULT_CALVIN, race: true }).replicas.map((x) => x.state.x)).toEqual([13, 10, 13]);
    const race20 = calvinRun({ ...DEFAULT_CALVIN, race: true, epoch: 20 });
    expect(new Set(race20.replicas.map((x) => JSON.stringify(x.state))).size).toBe(3);
    expect(calvinRun({ ...DEFAULT_CALVIN, lagLast: 25 }).identical).toBe(true);
    // The prediction: T1 then T2 gives 12, T2 then T1 gives 22.
    const run = (order: number[]) => { const s = { x: 1, y: 0 }; for (const i of order) CALVIN_OPS[i]!.apply(s); return s.x; };
    expect([run([0, 1]), run([1, 0])]).toEqual([12, 22]);
  });

  test("2PC against Calvin for one multi-partition transaction", () => {
    const a = mp2pc({ partitions: 3, latency: 1, epoch: 10 }), b = mpCalvin({ partitions: 3, latency: 1, epoch: 10 });
    expect([a.latency, a.lockHold, a.hops]).toEqual([9, 8, 9]);
    expect([b.latency, b.lockHold, b.hops]).toEqual([11, 1, 6]);
    expect([mp2pc({ partitions: 3, latency: 10, epoch: 10 }).latency, mpCalvin({ partitions: 3, latency: 10, epoch: 10 }).latency]).toEqual([90, 65]);
    expect(mp2pc({ partitions: 1, latency: 1, epoch: 10 }).lockHold).toBe(4);
  });
});

describe("percolator-and-snapshot-isolation", () => {
  test("the stepper runs", () => {
    const full = replayPercolator(["w", "w", "w", "w", "w", "rbegin", "rBob", "rJoe"]);
    expect([full.writer!.startTs, full.writer!.commitTs, full.reader!.startTs]).toEqual([3, 4, 5]);
    expect(full.readerSaw).toEqual({ Bob: 3, Joe: 9 });
    const wait = replayPercolator(["w", "w", "w", "rbegin", "rBob"]);
    expect(wait.reader!.startTs).toBe(4);
    expect(wait.tone).toBe("warn");
    const back = replayPercolator(["w", "w", "w", "crash", "rbegin", "rBob", "rJoe"]);
    expect(back.readerSaw).toEqual({ Bob: 10, Joe: 2 });
    expect(back.p.resolutions[0]!.how).toBe("rolled back");
    const fwd = replayPercolator(["w", "w", "w", "w", "crash", "rbegin", "rJoe", "rBob"]);
    expect(fwd.readerSaw).toEqual({ Bob: 3, Joe: 9 });
    expect(fwd.p.resolutions[0]).toMatchObject({ how: "rolled forward", commitTs: 4, lockTs: 3 });
  });

  test("write skew", () => {
    const c = writeSkew("concurrent", false);
    expect([c.t1.status, c.t2.status, c.onCall]).toEqual(["committed", "committed", 0]);
    expect(findCycle([0, 1], c.edges)).not.toBeNull();
    const m = writeSkew("concurrent", true);
    expect([m.t2.status, m.onCall]).toEqual(["aborted", 1]);
    const s = writeSkew("serial", false);
    expect([s.t2.writes.length, s.onCall]).toEqual([0, 1]);
  });
});
