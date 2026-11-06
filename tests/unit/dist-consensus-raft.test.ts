/**
 * Raft: the five safety properties under random crashes, partitions, drops, duplicates and recoveries; liveness in
 * a stable network; membership changes; snapshots; pre-vote, check-quorum and leadership transfer; and the
 * scripted scenarios that the lessons step through.
 */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  RaftCluster, RaftClient, entryKey, figure8, membership, sessionRun, type KvCmd, type KvMachine, type RaftOptions,
} from "@/sims/dist/consensus/raft";

type Cluster = RaftCluster<KvCmd>;
const kv = (c: Cluster, i: number) => c.node(i).machine as unknown as KvMachine;
const smState = (c: Cluster, i: number) => JSON.stringify(kv(c, i).snapshot().data);

/** Leader Append-Only, checked from outside: a leader's log only grows while it leads one term. */
class AppendOnlyCheck {
  private seen = new Map<number, { term: number; keys: Map<number, string> }>();
  problems: string[] = [];
  check(c: Cluster) {
    for (const n of c.nodes) {
      if (!c.isUp(n.id) || n.role !== "leader") {
        this.seen.delete(n.id);
        continue;
      }
      const prev = this.seen.get(n.id);
      if (prev && prev.term === n.currentTerm) {
        for (const [i, key] of prev.keys) {
          if (i <= n.base) continue;
          const e = n.entry(i);
          if (!e || entryKey(e) !== key) this.problems.push(`t=${c.now} S${n.id + 1} changed index ${i}`);
        }
      }
      const keys = new Map<number, string>();
      for (const e of n.log) keys.set(e.index, entryKey(e));
      this.seen.set(n.id, { term: n.currentTerm, keys });
    }
  }
}

/** Runs a random fault schedule on one cluster, checking safety after every slice, then heals and checks liveness. */
function chaos(seed: number, opts: { steps?: number; membership?: boolean } = {}) {
  const rng = mulberry32(seed * 7919 + 13);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)]!;
  const servers = opts.membership ? 7 : 5;
  const raft: Partial<RaftOptions> = {
    preVote: rng() < 0.5,
    checkQuorum: rng() < 0.5,
    fastBackup: rng() < 0.5,
    maxInflight: pick([1, 4]),
    maxBatch: pick([1, 3, 64]),
    snapshotThreshold: pick([0, 0, 4, 15]),
    snapshotChunk: pick([40, 1 << 16]),
    diskMs: pick([0, 0, 3]),
    noopOnElection: rng() < 0.8,
    electionTimeout: { min: 80, max: 160 },
    heartbeat: 25,
    retransmit: 60,
  };
  const c: Cluster = new RaftCluster<KvCmd>({
    servers,
    voters: opts.membership ? [0, 1, 2] : undefined,
    net: { seed, latency: { min: 2, max: 20 }, dropRate: pick([0, 0.05, 0.15]), dupRate: pick([0, 0.05]) },
    raft,
  });
  const ao = new AppendOnlyCheck();
  const all = [...Array(servers).keys()];
  const steps = opts.steps ?? 160;
  let proposed = 0;
  for (let s = 0; s < steps; s++) {
    const r = rng();
    const up = all.filter((i) => c.isUp(i)), down = all.filter((i) => !c.isUp(i));
    if (r < 0.45) {
      const L = c.leader();
      if (L !== null && c.propose(L, { op: "add", key: `k${s % 3}`, delta: 1 }).ok) proposed++;
    } else if (r < 0.55 && up.length) c.crash(pick(up));
    else if (r < 0.67 && down.length) c.recover(pick(down));
    else if (r < 0.75) {
      const cut = all.filter(() => rng() < 0.4);
      c.partition([cut, all.filter((x) => !cut.includes(x))]);
    } else if (r < 0.83) c.heal();
    else if (r < 0.88) {
      const L = c.leader();
      if (L !== null) c.transferLeadership(L, pick(all));
    } else if (r < 0.95 && opts.membership) {
      const L = c.leader();
      if (L !== null) {
        const cur = c.node(L).config.voters;
        if (rng() < 0.5) {
          const voters = all.filter(() => rng() < 0.6);
          if (voters.length) c.changeConfig(L, { voters, learners: all.filter((x) => !voters.includes(x) && rng() < 0.5) }, "joint");
        } else {
          const x = pick(all);
          const voters = cur.includes(x) ? cur.filter((y) => y !== x) : [...cur, x];
          if (voters.length) c.changeConfig(L, { voters }, "single");
        }
      }
    } else if (r < 0.97) {
      const i = pick(up.length ? up : all);
      if (c.isUp(i)) c.snapshotNow(i);
    }
    c.run(25);
    c.checkLogMatching();
    ao.check(c);
  }
  return { c, ao, proposed, all };
}

/** After chaos: heal, recover, stop drops, and check that the cluster converges and keeps committing. */
function settle(c: Cluster, all: number[]) {
  c.heal();
  for (const i of all) c.recover(i);
  c.net.cfg.dropRate = 0;
  c.net.cfg.dupRate = 0;
  // A stable network elects a leader soon; it may take a few rounds while old candidates settle.
  const elected = c.runUntilTrue(() => c.leader() !== null, 4000);
  c.run(300);
  c.runUntilTrue(() => c.leader() !== null, 4000);
  const L = c.leader();
  const r = L === null ? null : c.propose(L, { op: "set", key: "final", value: 1 });
  c.run(1500);
  return { elected, L, r };
}

describe("Raft safety under chaos", () => {
  const SEEDS = 400;
  test(`five properties hold on ${SEEDS} random runs, and the cluster recovers`, () => {
    let committedTotal = 0, transfers = 0, snapshots = 0, installs = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { c, ao, all } = chaos(seed);
      expect(c.violations, `seed ${seed}`).toEqual([]);
      expect(ao.problems, `seed ${seed}`).toEqual([]);
      const { elected, L, r } = settle(c, all);
      expect(elected, `seed ${seed}: leader after heal`).toBe(true);
      expect(r?.ok, `seed ${seed}`).toBe(true);
      // Every server applies the final command, and all state machines agree.
      for (const i of all) {
        expect(c.node(i).lastApplied, `seed ${seed} S${i + 1}`).toBeGreaterThanOrEqual(r!.ok ? r!.index : 0);
        expect(smState(c, i), `seed ${seed} S${i + 1}`).toBe(smState(c, L!));
      }
      expect(c.checkLogMatching()).toBeNull();
      expect(c.violations, `seed ${seed}`).toEqual([]);
      committedTotal += c.node(L!).commitIndex;
      transfers += c.events.filter((e) => e.kind === "transfer").length;
      snapshots += c.events.filter((e) => e.kind === "snapshot").length;
      installs += c.events.filter((e) => e.kind === "install").length;
    }
    // The runs really exercised the features.
    expect(committedTotal).toBeGreaterThan(SEEDS * 20);
    expect(transfers).toBeGreaterThan(50);
    expect(snapshots).toBeGreaterThan(100);
    expect(installs).toBeGreaterThan(10);
  }, 120_000);

  test("membership changes (joint and single-server, with learners) keep safety", () => {
    let changes = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { c, ao } = chaos(seed, { membership: true, steps: 200 });
      expect(c.violations, `seed ${seed}`).toEqual([]);
      expect(ao.problems, `seed ${seed}`).toEqual([]);
      changes += c.events.filter((e) => e.kind === "config").length;
    }
    expect(changes).toBeGreaterThan(80);
  }, 120_000);
});

describe("Raft liveness in a stable network", () => {
  test("a leader is elected within 1 s, and commands commit on every server", () => {
    let worst = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const c: Cluster = new RaftCluster<KvCmd>({ servers: 5, net: { seed, latency: { min: 5, max: 15 } } });
      expect(c.runUntilTrue(() => c.leader() !== null, 1000, 1), `seed ${seed}`).toBe(true);
      worst = Math.max(worst, c.now);
      const L = c.leader()!;
      for (let k = 0; k < 5; k++) c.propose(L, { op: "add", key: "x", delta: 1 });
      c.run(200);
      for (let i = 0; i < 5; i++) expect(kv(c, i).data.get("x"), `seed ${seed}`).toBe(5);
      expect(c.violations).toEqual([]);
    }
    expect(worst).toBeLessThan(1000);
  });

  test("a client with retries gets every command applied exactly once through crashes", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const c: Cluster = new RaftCluster<KvCmd>({ servers: 3, clients: 1, net: { seed, latency: { min: 2, max: 12 }, dropRate: 0.1 } });
      const cl = new RaftClient(c, 3, { timeout: 100, session: true });
      for (let k = 0; k < 20; k++) cl.submit({ op: "add", key: "x", delta: 1 });
      for (let t = 0; t < 40; t++) {
        c.run(50);
        if (t === 10) c.crash(c.leader() ?? 0);
        if (t === 20) for (const i of [0, 1, 2]) c.recover(i);
      }
      c.net.cfg.dropRate = 0;
      c.runUntilTrue(() => !cl.busy, 10000);
      c.run(300);
      expect(cl.done.length, `seed ${seed}`).toBe(20);
      for (const i of [0, 1, 2]) expect(kv(c, i).data.get("x"), `seed ${seed}`).toBe(20);
    }
  });
});

describe("Raft features", () => {
  const stable = (raft: Partial<RaftOptions> = {}, seed = 1, servers = 5) => {
    const c: Cluster = new RaftCluster<KvCmd>({ servers, net: { seed, latency: { min: 5, max: 15 } }, raft });
    c.runUntilTrue(() => c.leader() !== null, 2000);
    c.run(100);
    return c;
  };

  test("persistence: a recovered node keeps its term, vote and log, and rebuilds its state machine", () => {
    const c = stable();
    const L = c.leader()!;
    for (let k = 0; k < 4; k++) c.propose(L, { op: "add", key: "x", delta: 2 });
    c.run(200);
    const f = (L + 1) % 5;
    const before = { term: c.node(f).currentTerm, vote: c.node(f).votedFor, log: c.node(f).log.map(entryKey) };
    c.crash(f);
    c.run(100);
    c.recover(f);
    expect(c.node(f).currentTerm).toBe(before.term);
    expect(c.node(f).votedFor).toBe(before.vote);
    expect(c.node(f).log.map(entryKey)).toEqual(before.log);
    expect(c.node(f).commitIndex).toBe(0);
    c.run(200);
    expect(kv(c, f).data.get("x")).toBe(8);
  });

  test("a vote survives a crash: a node that votes, crashes and recovers does not vote twice in one term", () => {
    const c: Cluster = new RaftCluster<KvCmd>({ servers: 3, net: { seed: 1, latency: { min: 5, max: 5 } }, raft: { electionTimeout: { min: 1e7, max: 1e7 }, noopOnElection: false } });
    c.partition([[0, 2], [1]]);
    c.timeout(0); // S1 asks for votes in term 1; S3 votes for it
    c.run(20);
    expect(c.node(0).role).toBe("leader");
    c.crash(2);
    c.recover(2);
    c.partition([[1, 2], [0]]);
    c.timeout(1); // S2 asks S3 for a vote in term 1 too
    c.run(20);
    expect(c.node(1).role).toBe("candidate");
    expect(c.violations).toEqual([]);
  });

  test("pre-vote stops an isolated node from raising its term and deposing the leader", () => {
    for (const preVote of [false, true]) {
      const c = stable({ preVote });
      const L = c.leader()!, x = (L + 1) % 5;
      const term = c.node(L).currentTerm;
      c.partition([[x], [0, 1, 2, 3, 4].filter((i) => i !== x)]);
      c.run(2000);
      const isolatedTerm = c.node(x).currentTerm;
      c.heal();
      c.run(1000);
      if (preVote) {
        expect(isolatedTerm).toBe(term);
        expect(c.leader()).toBe(L);
        expect(c.node(L).currentTerm).toBe(term);
      } else {
        expect(isolatedTerm).toBeGreaterThan(term + 5);
        expect(c.node(c.leader()!).currentTerm).toBeGreaterThan(term + 5);
      }
    }
  });

  test("check-quorum: a leader cut off in a minority steps down", () => {
    for (const checkQuorum of [false, true]) {
      const c = stable({ checkQuorum });
      const L = c.leader()!;
      c.partition([[L, (L + 1) % 5], [(L + 2) % 5, (L + 3) % 5, (L + 4) % 5]]);
      c.run(1000);
      expect(c.node(L).role === "leader").toBe(!checkQuorum);
    }
  });

  test("leadership transfer hands over within one round trip after catch-up", () => {
    const c = stable();
    const L = c.leader()!, to = (L + 2) % 5;
    c.propose(L, { op: "set", key: "a", value: 1 });
    expect(c.transferLeadership(L, to).ok).toBe(true);
    expect(c.propose(L, { op: "set", key: "a", value: 2 }).ok).toBe(false);
    c.runUntilTrue(() => c.leader() === to, 200, 1);
    expect(c.leader()).toBe(to);
  });

  test("learners receive the log but do not vote or count for commit", () => {
    const c: Cluster = new RaftCluster<KvCmd>({ servers: 4, voters: [0, 1, 2], net: { seed: 2, latency: { min: 5, max: 15 } } });
    c.runUntilTrue(() => c.leader() !== null, 2000);
    c.run(100);
    const L = c.leader()!;
    expect(c.changeConfig(L, { voters: [0, 1, 2], learners: [3] }, "single").ok).toBe(true);
    c.propose(L, { op: "set", key: "x", value: 7 });
    c.run(200);
    expect(kv(c, 3).data.get("x")).toBe(7);
    // With two voters down, the learner cannot make a majority.
    const others = [0, 1, 2].filter((i) => i !== L);
    c.crash(others[0]!);
    c.crash(others[1]!);
    const r = c.propose(L, { op: "set", key: "x", value: 8 });
    c.run(500);
    expect(r.ok).toBe(true);
    expect(c.node(L).commitIndex).toBeLessThan((r as { index: number }).index);
    c.crash(L);
    c.run(2000);
    expect(c.node(3).role).toBe("follower");
  });

  test("a single-server change refuses two voters at once, and one change at a time", () => {
    const c = stable({}, 3, 5);
    const L = c.leader()!;
    const others = [0, 1, 2, 3, 4].filter((i) => i !== L);
    expect(c.changeConfig(L, { voters: [L, others[0]!, others[1]!] }, "single").ok).toBe(false);
    expect(c.changeConfig(L, { voters: [L, ...others.slice(0, 3)] }, "single").ok).toBe(true);
    expect(c.changeConfig(L, { voters: [L, ...others.slice(0, 2)] }, "single").ok).toBe(false);
    c.run(200);
    expect(c.changeConfig(L, { voters: [L, ...others.slice(0, 2)] }, "single").ok).toBe(true);
  });

  test("a removed leader steps down after the new configuration commits", () => {
    const c = stable({}, 4);
    const L = c.leader()!;
    const rest = [0, 1, 2, 3, 4].filter((i) => i !== L);
    expect(c.changeConfig(L, { voters: rest }, "joint").ok).toBe(true);
    c.run(300);
    expect(c.node(L).role).toBe("follower");
    c.runUntilTrue(() => c.leader() !== null, 1000);
    expect(rest).toContain(c.leader());
    expect(c.violations).toEqual([]);
  });

  test("InstallSnapshot brings a far-behind follower back, in chunks", () => {
    const c = stable({ snapshotThreshold: 10, snapshotChunk: 50 });
    const L = c.leader()!, f = (L + 1) % 5;
    c.crash(f);
    for (let k = 0; k < 60; k++) {
      c.propose(L, { op: "add", key: `k${k % 4}`, delta: 1 });
      c.run(5);
    }
    c.run(200);
    expect(c.node(L).base).toBeGreaterThan(c.node(f).lastIndex);
    c.recover(f);
    c.run(500);
    const inst = c.events.filter((e) => e.kind === "install" && e.node === f);
    expect(inst.length).toBeGreaterThan(0);
    const chunks = c.net.messages.filter((m) => m.to === f && m.payload.type === "InstallSnapshot" && !m.dupOf).length;
    expect(chunks).toBeGreaterThan(1);
    expect(smState(c, f)).toBe(smState(c, L));
  });
});

describe("the scripted scenarios", () => {
  test("Figure 8: the current-term rule keeps safety; without it a committed entry is overwritten", () => {
    for (const end of ["d", "e"] as const) expect(figure8(true, end).at(-1)!.violations).toEqual([]);
    const bad = figure8(false, "d").at(-1)!.violations.map((v) => v.property);
    expect(bad).toContain("State Machine Safety");
    expect(bad).toContain("Leader Completeness");
    expect(figure8(false, "e").at(-1)!.violations).toEqual([]);
  });

  test("membership: a direct switch makes two leaders in one term; joint and single-server changes do not", () => {
    const direct = membership("direct").at(-1)!.violations.map((v) => v.property);
    expect(direct).toContain("Election Safety");
    expect(direct).toContain("State Machine Safety");
    expect(membership("joint").at(-1)!.violations).toEqual([]);
    expect(membership("single").at(-1)!.violations).toEqual([]);
    // The joint and single runs finish with all five servers in the configuration.
    for (const m of ["joint", "single"] as const) expect(membership(m).at(-1)!.nodes.every((n) => n.config === "{S1,S2,S3,S4,S5}")).toBe(true);
  });

  test("the 2015 single-server bug breaks safety without the rule and not with it", () => {
    expect(membership("bug2015", false).at(-1)!.violations.map((v) => v.property)).toContain("State Machine Safety");
    expect(membership("bug2015", true).at(-1)!.violations).toEqual([]);
  });

  test("sessions: a retried increment applies once with a session, twice without", () => {
    const a = sessionRun(true), b = sessionRun(false);
    expect([a.value, a.appliedTimes]).toEqual([1, 1]);
    expect([b.value, b.appliedTimes]).toEqual([2, 2]);
  });
});
