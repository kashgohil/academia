/** Property tests for the Coordination sims: random pauses, drifts, kills and cuts. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "../../src/sims/rng";
import { RaftCluster } from "../../src/sims/dist/consensus/raft";
import { ELECTION, ZkTree, exactlyOnceInOrder, fencingTrial, leaseTimeline, liveLeaders, watchRun, zkElection, type ZkAction, type ZkTxn } from "../../src/sims/dist/coordination";

describe("fencing tokens", () => {
  test("with tokens on every access, the storage never accepts an older token, and no update is lost", () => {
    const rnd = mulberry32(11);
    for (let k = 0; k < 120; k++) {
      const cfg = { seed: k + 1, mode: "all" as const, ttl: 100 + Math.floor(rnd() * 500), clients: 2 + Math.floor(rnd() * 4), rounds: 8, pauseProb: rnd() * 0.6, maxPause: rnd() * 1500, drift: rnd() * 0.2 };
      const r = fencingTrial(cfg);
      for (let i = 1; i < r.acceptedTokens.length; i++) expect(r.acceptedTokens[i]!, JSON.stringify(cfg)).toBeGreaterThanOrEqual(Math.max(...r.acceptedTokens.slice(0, i)));
      expect(r.lostUpdates, JSON.stringify(cfg)).toBe(0);
      expect(r.final).toBe(r.acked);
    }
  });

  test("tokens on writes only still keep accepted write tokens in order", () => {
    for (let s = 1; s <= 60; s++) {
      const r = fencingTrial({ seed: s, mode: "writes", maxPause: 900, pauseProb: 0.4, drift: 0.05 });
      for (let i = 1; i < r.acceptedTokens.length; i++) expect(r.acceptedTokens[i]!).toBeGreaterThanOrEqual(r.acceptedTokens[i - 1]!);
    }
  });

  test("the lease timeline with a fencing store never accepts a stale write", () => {
    const rnd = mulberry32(5);
    for (let k = 0; k < 80; k++) {
      const cfg = { seed: k + 1, pause: Math.floor(rnd() * 1600), pauseWhere: rnd() < 0.5 ? "afterCheck" as const : "beforeCheck" as const, clockStops: rnd() < 0.5, driftA: (rnd() - 0.5) * 0.6, fence: "all" as const };
      expect(leaseTimeline(cfg).staleAccepted, JSON.stringify(cfg)).toEqual([]);
    }
  });
});

describe("election on the ZooKeeper-like service", () => {
  test("after the session timeout there is exactly one leader, and the predecessor watch sends at most one notification per change", () => {
    const rnd = mulberry32(3);
    for (let k = 0; k < 40; k++) {
      const clients = 3 + Math.floor(rnd() * 5);
      const actions: ZkAction[] = [];
      let t = 300;
      const alive = new Set(Array.from({ length: clients }, (_, i) => i + 1));
      for (let j = 0; j < clients - 1; j++) {
        t += Math.floor(rnd() * 3000);
        const ids = [...alive];
        const victim = ids[Math.floor(rnd() * ids.length)]!;
        alive.delete(victim);
        actions.push({ t, kind: "kill", client: victim });
      }
      for (const mode of ["pred", "herd"] as const) {
        const r = zkElection({ seed: k + 1, mode, clients, maxClients: clients, actions, sessionTimeout: 1500 });
        expect(liveLeaders(r), `${mode} ${JSON.stringify(actions)}`).toEqual([...alive]);
        // The leader is the live client with the smallest sequence number.
        const kids = r.tree.children(ELECTION);
        expect(kids).toHaveLength(1);
        if (mode === "pred") for (const ch of r.changes) if (ch.what === "expire") expect(ch.notified).toBeLessThanOrEqual(1);
        // Never two live leaders at once: each leadership starts after the previous leader's znode is gone.
        for (let i = 1; i < r.leaders.length; i++) {
          const prev = r.leaders[i - 1]!.client;
          const gone = r.changes.find((c) => c.what === "expire" && c.session === prev);
          expect(gone && gone.t <= r.leaders[i]!.t).toBeTruthy();
        }
      }
    }
  });

  test("ZkTree is a deterministic state machine: on Raft, every replica ends with the same tree", () => {
    const c = new RaftCluster<ZkTxn>({ servers: 3, net: { seed: 4 }, machine: () => new ZkTree() });
    c.runUntilTrue(() => c.leader() !== null, 2000);
    const ops: ZkTxn[] = [
      { op: "create", path: ELECTION, data: "", ephemeral: false, sequential: false, session: 0 },
      ...[1, 2, 3].map((s): ZkTxn => ({ op: "create", path: `${ELECTION}/n_`, data: "", ephemeral: true, sequential: true, session: s })),
      { op: "closeSession", session: 2 },
    ];
    for (const op of ops) { c.propose(c.leader()!, op); c.run(60); }
    c.run(500);
    const trees = c.nodes.map((n) => (n.machine as ZkTree).children(ELECTION));
    expect(trees[0]).toEqual(["n_0000000000", "n_0000000002"]);
    expect(trees[1]).toEqual(trees[0]);
    expect(trees[2]).toEqual(trees[0]);
  });
});

describe("etcd watch", () => {
  test("a watch resumed from the last revision + 1 delivers every later event exactly once, in order", () => {
    const rnd = mulberry32(9);
    for (let k = 0; k < 80; k++) {
      const cuts: { from: number; to: number }[] = [];
      let t = 50;
      const n = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < n; j++) {
        const from = t + Math.floor(rnd() * 300);
        const to = from + 20 + Math.floor(rnd() * 500);
        cuts.push({ from, to });
        t = to + 10;
      }
      const r = watchRun({ seed: k + 1, cuts, writes: 20 + Math.floor(rnd() * 30), writeEvery: 10 + Math.floor(rnd() * 50), resume: "next" });
      expect(exactlyOnceInOrder(r), JSON.stringify(cuts)).toBe(true);
      expect(r.stateMatches).toBe(true);
    }
  });

  test("with compaction the watcher may skip events, but a re-read keeps its copy correct", () => {
    for (let s = 1; s <= 30; s++) {
      const r = watchRun({ seed: s, keep: 3, cuts: [{ from: 200, to: 300 + 20 * s }] });
      expect(r.stateMatches).toBe(true);
      expect(r.duplicates).toEqual([]);
    }
  });
});
