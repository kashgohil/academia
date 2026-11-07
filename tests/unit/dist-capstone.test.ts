/** Properties of the capstone store and its simulation tester (src/sims/dist/capstone). */
import { describe, expect, test } from "vitest";
import {
  KvStore, StoreMachine, toHOp, runSim, genSchedule, shrinkAll, bugConfig, firstFailingSeed, FUZZ_DEFAULT, OLD_TERM_KINDS,
  groupsFromCuts, type FuzzConfig, type BugId,
} from "@/sims/dist/capstone";
import { checkRegister } from "@/sims/dist/consistency";

describe("the state machine", () => {
  test("put, get, del and cas, with a revision that counts changes", () => {
    const m = new StoreMachine();
    expect(m.apply({ op: "put", key: "x", value: 5 })).toEqual({ ok: true, value: 5, rev: 1 });
    expect(m.apply({ op: "cas", key: "x", expect: 4, value: 9 })).toEqual({ ok: false, value: 5, rev: 1 });
    expect(m.apply({ op: "cas", key: "x", expect: 5, value: 9 })).toEqual({ ok: true, value: 9, rev: 2 });
    expect(m.apply({ op: "get", key: "x" })).toEqual({ ok: true, value: 9, rev: 2 });
    expect(m.apply({ op: "del", key: "x" })).toEqual({ ok: true, value: 0, rev: 3 });
    expect(m.apply({ op: "cas", key: "x", expect: 0, value: 1 }).ok).toBe(true); // 0 means absent: create if absent
    const copy = new StoreMachine();
    copy.restore(JSON.parse(JSON.stringify(m.snapshot())));
    expect(copy.get("x")).toBe(1);
    expect(copy.rev).toBe(m.rev);
  });

  test("records become checker operations: del writes 0, an unanswered cas has an unknown outcome", () => {
    expect(toHOp({ id: 1, client: 0, op: { kind: "del", key: "x" }, call: 1, ret: 2, tries: 1 })).toMatchObject({ f: "w", value: 0 });
    expect(toHOp({ id: 2, client: 0, op: { kind: "cas", key: "x", expect: 1, value: 2 }, call: 1, ret: Infinity, tries: 1 })).toMatchObject({ f: "cas", ok: undefined });
    expect(toHOp({ id: 3, client: 0, op: { kind: "get", key: "x" }, call: 1, ret: Infinity, tries: 1 })).toBeNull();
  });

  test("cuts combine into groups", () => {
    expect(groupsFromCuts(5, [[0], [1, 2]])).toEqual([[0], [1, 2], [3, 4]]);
    expect(groupsFromCuts(3, [])).toEqual([[0, 1, 2]]);
  });
});

describe("the store", () => {
  for (const mode of ["readindex", "lease", "log"] as const) {
    test(`a healthy cluster answers every operation (${mode} reads), and the history is linearizable`, () => {
      const s = new KvStore({ seed: 4, readMode: mode, clients: 2 });
      expect(s.settle()).toBe(true);
      const ops = [
        { kind: "put", key: "x", value: 5 }, { kind: "get", key: "x" }, { kind: "cas", key: "x", expect: 5, value: 7 },
        { kind: "get", key: "x" }, { kind: "del", key: "x" }, { kind: "get", key: "x" },
      ] as const;
      for (const o of ops) s.clients[0]!.submit({ ...o });
      for (const o of ops) s.clients[1]!.submit({ ...o, value: "value" in o ? o.value + 100 : undefined, expect: "expect" in o ? o.expect + 100 : undefined });
      s.runUntilTrue(() => s.clients.every((c) => !c.busy), 3000);
      expect(s.ops.every((o) => Number.isFinite(o.ret))).toBe(true);
      expect(s.ops.filter((o) => o.client === 0).map((o) => o.value)).toEqual([5, 5, 7, 7, 0, 0]);
      expect(s.check().ok).toBe(true);
      if (mode !== "log") expect(s.ops.filter((o) => o.op.kind === "get").every((o) => o.via === mode)).toBe(true);
    });
  }

  for (const noDedup of [false, true]) {
    test(`a cas whose reply is lost: ${noDedup ? "without sessions the retry applies again and reports failure" : "with sessions it applies once"}`, () => {
      const s = new KvStore({ seed: 2, bugs: { noDedup } });
      s.settle();
      const L = s.leader()!;
      s.clients[0]!.leaderGuess = L;
      let lost = false;
      // The reply leaves right after the leader applies the entry: lose it.
      s.cluster.onApply((node, e) => {
        if (node === L && e.kind === "cmd" && !lost) { lost = true; s.setDropRate(1); }
      });
      s.clients[0]!.submit({ kind: "cas", key: "x", expect: 0, value: 1 });
      s.runUntilTrue(() => lost, 500, 0.25);
      s.setDropRate(0);
      s.runUntilTrue(() => !s.clients[0]!.busy, 1000);
      expect(s.ops[0]!.tries).toBeGreaterThanOrEqual(2);
      expect(s.machine(L).get("x")).toBe(1);
      expect(s.ops[0]!.ok).toBe(!noDedup);
      expect(s.check().ok).toBe(!noDedup);
    });
  }

  test("ReadIndex and lease reads need no log entry; a log read appends one", () => {
    for (const [mode, grows] of [["readindex", false], ["lease", false], ["log", true]] as const) {
      const s = new KvStore({ seed: 5, readMode: mode, clients: 1 });
      s.settle();
      s.run(120);
      const L = s.leader()!;
      const before = s.node(L).lastIndex;
      s.clients[0]!.leaderGuess = L;
      s.clients[0]!.submit({ kind: "get", key: "x" });
      s.runUntilTrue(() => !s.clients[0]!.busy, 500);
      expect(s.node(L).lastIndex > before, mode).toBe(grows);
    }
  });

  test("a paused server runs nothing until it resumes, then catches up", () => {
    const s = new KvStore({ seed: 6 });
    s.settle();
    const f = [0, 1, 2].find((i) => i !== s.leader())!;
    s.pause(f);
    s.propose({ op: "put", key: "x", value: 3 });
    s.run(200);
    expect(s.machine(f).get("x")).toBe(0);
    s.resume(f);
    s.run(200);
    expect(s.machine(f).get("x")).toBe(3);
  });

  test("membership change: a server joins as a learner, then votes", () => {
    const s = new KvStore({ servers: 4, voters: [0, 1, 2], seed: 8 });
    s.settle();
    expect(s.changeConfig([0, 1, 2], [3]).ok).toBe(true);
    s.run(200);
    expect(s.changeConfig([0, 1, 2, 3]).ok).toBe(true);
    s.run(200);
    expect(s.node(s.leader()!).config.voters).toEqual([0, 1, 2, 3]);
    s.propose({ op: "put", key: "x", value: 9 });
    s.run(200);
    expect(s.machine(3).get("x")).toBe(9);
  });
});

describe("deterministic simulation", () => {
  const sweep = (cfg: FuzzConfig, seeds: number) => {
    const bad: number[] = [];
    let ops = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const r = runSim(seed, genSchedule(seed, cfg), cfg).result;
      ops += r.ops;
      if (!r.ok || r.unknown) bad.push(seed);
    }
    return { bad, ops };
  };

  test("property: random fault schedules give linearizable histories and no Raft violation (ReadIndex)", () => {
    const { bad, ops } = sweep(FUZZ_DEFAULT, 300);
    expect(bad).toEqual([]);
    expect(ops).toBeGreaterThan(10000);
  });

  test("property: the same holds with lease reads, log reads, five servers, and the narrow targeted mix", () => {
    expect(sweep({ ...FUZZ_DEFAULT, readMode: "lease" }, 150).bad).toEqual([]);
    expect(sweep({ ...FUZZ_DEFAULT, readMode: "log" }, 100).bad).toEqual([]);
    expect(sweep({ ...FUZZ_DEFAULT, servers: 5 }, 100).bad).toEqual([]);
    expect(sweep({ ...FUZZ_DEFAULT, swarm: false, faults: { min: 2, max: 6, kinds: OLD_TERM_KINDS } }, 300).bad).toEqual([]);
  });

  test("a seed replays bit for bit", () => {
    for (const seed of [3, 17, 99]) {
      const sch = genSchedule(seed, FUZZ_DEFAULT);
      const a = runSim(seed, sch, FUZZ_DEFAULT).result, b = runSim(seed, sch, FUZZ_DEFAULT).result;
      expect(a.fingerprint).toBe(b.fingerprint);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
    expect(runSim(3, genSchedule(3, FUZZ_DEFAULT), FUZZ_DEFAULT).result.fingerprint).not.toBe(runSim(4, genSchedule(4, FUZZ_DEFAULT), FUZZ_DEFAULT).result.fingerprint);
  });

  const budgets: Record<BugId, number> = { followerRead: 10, noDedup: 100, forgetVote: 100, oldTermCommit: 1000 };
  for (const bug of Object.keys(budgets) as BugId[]) {
    test(`the fuzzer finds the bug "${bug}" and shrinks it to a schedule that still fails`, () => {
      const cfg = bugConfig(bug);
      const f = firstFailingSeed(cfg, budgets[bug]);
      expect(f).not.toBeNull();
      const m = shrinkAll(f!.seed, f!.schedule, cfg);
      expect(m.schedule.length).toBeLessThanOrEqual(f!.schedule.length);
      const again = runSim(f!.seed, m.schedule, cfg).result;
      expect(again.ok).toBe(false);
      expect(again.failure!.kind).toBe(f!.failure!.kind);
      expect(again.fingerprint).toBe(m.result.fingerprint);
      // 1-minimal: dropping any one remaining fault makes the failure go away (or change kind).
      for (let i = 0; i < m.schedule.length; i++) {
        const r = runSim(f!.seed, m.schedule.filter((_, j) => j !== i), cfg).result;
        expect(r.failure?.kind === f!.failure!.kind).toBe(false);
      }
      // The same seed and schedule pass without the bug.
      expect(runSim(f!.seed, m.schedule, { ...cfg, bugs: {} }).result.ok).toBe(true);
    });
  }

  test("the history check is the committed checker", () => {
    const { store } = runSim(5, genSchedule(5, FUZZ_DEFAULT), FUZZ_DEFAULT);
    expect(checkRegister(store.history()).ok).toBe(store.check().ok);
  });
});
