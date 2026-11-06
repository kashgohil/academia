/** The consistency checkers: exactness against brute force, the litmus verdicts, and the register store on Net. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  bruteForceLinearizable, checkLinearizable, checkRegister, registerModel, kvModel, linearizationPoints, provablyStaleReads,
  randomHistory, mk, checkSequential, checkCausal, checkEventual, checkModel, LITMUS, MODEL_NAMES, runStore, maxConcurrency,
  type HOp, type StoreFault,
} from "@/sims/dist/consistency";

describe("linearizability checker", () => {
  test("agrees with brute force over all permutations on random small histories", () => {
    const rng = mulberry32(42);
    let yes = 0, no = 0;
    for (let i = 0; i < 400; i++) {
      const h = randomHistory(rng, { clients: 1 + Math.floor(rng() * 3), ops: 1 + Math.floor(rng() * 3), corrupt: 0.6, pendingFrac: 0.3, len: 12, gap: 3 });
      if (h.length > 8) continue;
      const fast = checkLinearizable(h, registerModel()).ok;
      const slow = bruteForceLinearizable(h, registerModel());
      expect(fast, JSON.stringify(h)).toBe(slow);
      for (const memo of [false]) expect(checkLinearizable(h, registerModel(), { memo }).ok).toBe(slow);
      slow ? yes++ : no++;
    }
    // Both outcomes are well represented, so the agreement means something.
    expect(yes).toBeGreaterThan(50);
    expect(no).toBeGreaterThan(50);
  });

  test("histories from a real atomic register always pass, with or without partitioning", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const h = randomHistory(rng, { clients: 4, ops: 6, keys: 2, pendingFrac: 0.3 });
      expect(checkRegister(h).ok).toBe(true);
      expect(checkRegister(h, { partition: false }).ok).toBe(true);
    }
  });

  test("a valid order respects real time and the register, and its points lie inside the intervals", () => {
    const h = mk([[0, "w", "x", 1, 0, 40], [1, "r", "x", 0, 5, 15], [2, "r", "x", 1, 20, 35]]);
    const r = checkLinearizable(h, registerModel());
    expect(r.ok).toBe(true);
    expect(r.order).toEqual([1, 0, 2]);
    const pts = linearizationPoints(h, r.order, 50);
    for (const o of h) expect(pts.get(o.id)!).toBeGreaterThanOrEqual(o.call), expect(pts.get(o.id)!).toBeLessThanOrEqual(o.ret);
    const seq = r.order.map((id) => pts.get(id)!);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
  });

  test("a failure reports the longest valid prefix and the blocked candidates", () => {
    const h = mk([[0, "w", "x", 1, 0, 10], [1, "r", "x", 0, 20, 30]]);
    const r = checkLinearizable(h, registerModel());
    expect(r.ok).toBe(false);
    expect(r.best).toEqual([0]);
    expect(r.blocked).toEqual([1]);
  });

  test("the cache never changes the answer and never costs more states", () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 60; i++) {
      const h = randomHistory(rng, { clients: 4, ops: 4, corrupt: 0.3 });
      const a = checkLinearizable(h, registerModel(), { memo: true });
      const b = checkLinearizable(h, registerModel(), { memo: false });
      expect(a.ok).toBe(b.ok);
      expect(a.explored).toBeLessThanOrEqual(b.explored);
    }
  });

  test("kv model and partitioning agree", () => {
    const rng = mulberry32(9);
    for (let i = 0; i < 80; i++) {
      const h = randomHistory(rng, { clients: 3, ops: 4, keys: 2, corrupt: 0.3 });
      expect(checkLinearizable(h, kvModel()).ok).toBe(checkRegister(h).ok);
    }
  });

  test("a provably stale read always makes the checker fail", () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 200; i++) {
      const h = randomHistory(rng, { clients: 3, ops: 4, corrupt: 0.3 });
      if (provablyStaleReads(h).length) expect(checkRegister(h).ok).toBe(false);
    }
  });
});

describe("weaker models", () => {
  test("every litmus history gets its expected verdict under every model", () => {
    for (const l of LITMUS) for (const m of MODEL_NAMES) expect(checkModel(m, l.history).ok, `${l.id} ${m}`).toBe(l.expect[m]);
  });

  test("the models nest: linearizable ⇒ sequential ⇒ causal ⇒ eventual, on random histories", () => {
    const rng = mulberry32(3);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 300; i++) {
      const h = randomHistory(rng, { clients: 3, ops: 3, keys: 2, corrupt: 0.5 });
      const v = [checkRegister(h).ok, checkSequential(h).ok, checkCausal(h).ok, checkEventual(h).ok];
      for (let k = 0; k < 3; k++) if (v[k]) expect(v[k + 1], JSON.stringify(h)).toBe(true);
      v.forEach((x, k) => x && counts[k]!++);
    }
    // Each step of the ladder is strict on this sample.
    expect(counts[0]).toBeLessThan(counts[1]!);
    expect(counts[1]).toBeLessThan(counts[2]!);
    expect(counts[2]).toBeLessThan(counts[3]!);
  });
});

describe("register store on Net", () => {
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1);

  test("every history from the ReadIndex and leader read paths is linearizable, even with faults", () => {
    for (const readPath of ["readindex", "leader"] as const)
      for (const seed of seeds) {
        const run = runStore({ seed, readPath, faults: [{ kind: "isolate", node: 2, at: 100, until: 300 }] });
        expect(run.history.length).toBeGreaterThan(10);
        expect(checkRegister(run.history).ok, `${readPath} seed ${seed}`).toBe(true);
      }
  });

  test("a crashed follower or lost messages do not break the ReadIndex path", () => {
    for (const seed of seeds.slice(0, 20)) {
      const run = runStore({ seed, dropRate: 0.1, faults: [{ kind: "crash", node: 1, at: 80, until: 250 }] });
      expect(checkRegister(run.history).ok, `seed ${seed}`).toBe(true);
    }
  });

  test("follower reads fail, and fail more often when a follower is cut off", () => {
    const rate = (faults: StoreFault[]) =>
      seeds.filter((seed) => checkRegister(runStore({ seed, readPath: "follower", faults }).history).ok === false).length;
    const lagOnly = rate([]);
    const cut = rate([{ kind: "isolate", node: 2, at: 100, until: 300 }]);
    expect(lagOnly).toBeGreaterThan(0);
    expect(cut).toBeGreaterThan(lagOnly);
    expect({ lagOnly, cut }).toMatchInlineSnapshot(`
      {
        "cut": 40,
        "lagOnly": 39,
      }
    `);
  });

  test("on follower reads, the checker fails at least wherever a provably stale read exists", () => {
    for (const seed of seeds) {
      const h = runStore({ seed, readPath: "follower" }).history;
      if (provablyStaleReads(h).length) expect(checkRegister(h).ok).toBe(false);
    }
  });

  test("the same seed gives the same history", () => {
    const a = runStore({ seed: 5, readPath: "follower" }).history;
    const b = runStore({ seed: 5, readPath: "follower" }).history;
    expect(a).toEqual(b);
    expect(maxConcurrency(a.filter((o) => Number.isFinite(o.ret)))).toBeLessThanOrEqual(3);
  });
});

export type { HOp };

// ---------------------------------------------------------------- numbers quoted in the lessons

import { storeStats, convergenceStats, pbsCurve, staleClosedForm, checkerCost, runSession, runTokens, tokenStats, runCap, runCausal, quorumLatency } from "@/sims/dist/consistency";

const chk = (h: HOp[]) => ({ failed: checkRegister(h).ok === false, stale: provablyStaleReads(h).length });
const r1 = (x: number) => Math.round(x * 10) / 10;

describe("numbers quoted in the lessons", () => {
  test("linearizability: read paths of the store (40 runs, one-way latency 4–16 ms)", () => {
    const s = (cfg: Parameters<typeof storeStats>[0]) => { const x = storeStats(cfg, 40, chk); return [x.failed, x.stale, x.reads, r1(x.meanRead)]; };
    expect(s({ readPath: "readindex" })).toEqual([0, 0, 596, 36.7]);
    expect(s({ readPath: "leader" })).toEqual([0, 0, 710, 20.2]);
    expect(s({ readPath: "follower" })).toEqual([39, 51, 699, 20.1]);
  });

  test("checking histories: stale follower reads grow with replication lag (heartbeat interval)", () => {
    const s = (heartbeat: number, faults: StoreFault[] = []) => { const x = storeStats({ readPath: "follower", heartbeat, faults }, 40, chk); return [x.failed, x.stale, x.reads]; };
    expect(s(10)).toEqual([4, 4, 717]);
    expect(s(25)).toEqual([22, 25, 704]);
    expect(s(100)).toEqual([40, 133, 730]);
    expect(s(50, [{ kind: "isolate", node: 2, at: 100, until: 300 }])).toEqual([40, 152, 710]);
  });

  test("eventual: gossip convergence after one write grows slowly with N (interval 50 ms, 40 runs)", () => {
    const row = (replicas: number) => (["push", "pull", "push-pull"] as const).map((mode) => Math.round(convergenceStats({ mode, interval: 50, replicas, dropRate: 0, direct: false, writes: 1, writeWindow: 0, tEnd: 5000 }, 40).mean));
    expect([4, 16, 64].map(row)).toEqual([[121, 118, 66], [335, 242, 159], [473, 368, 226]]);
    expect(Math.round((226 / 66) * 10) / 10).toBe(3.4);
  });

  test("eventual: PBS for N = 3, R = W = 1, mean one-way delay 5 ms", () => {
    expect(staleClosedForm(3, 1, 1)).toBeCloseTo(2 / 3, 10);
    expect(staleClosedForm(3, 2, 2)).toBe(0);
    expect(pbsCurve({ n: 3, r: 1, w: 1, mean: 5, trials: 3000, seed: 1 }, [0, 10, 27])).toEqual([0.743, 0.961, 0.999]);
    // 27 ms is the first whole millisecond at which 99.9% of reads are fresh (the demo's readout).
    expect(pbsCurve({ n: 3, r: 1, w: 1, mean: 5, trials: 3000, seed: 1 }, [26])[0]).toBeLessThan(0.999);
    // More replicas with R = W = 1: fewer fresh reads at t = 0; R = 2 with W = 1: few stale reads.
    expect(pbsCurve({ n: 5, r: 1, w: 1, mean: 5, trials: 3000, seed: 1 }, [0])[0]).toBeLessThan(0.743);
    expect(pbsCurve({ n: 3, r: 2, w: 1, mean: 5, trials: 3000, seed: 1 }, [0])[0]).toBeGreaterThan(0.95);
  });

  test("checking histories: checker cost on hard histories (5 histories, budget 50,000)", () => {
    const c = (k: number, o: number) => { const x = checkerCost(k, o, 5, 4, 5e4); return [x.ops, r1(x.memo), x.plain === null ? null : r1(x.plain), r1(x.partitioned)]; };
    expect(c(2, 8)).toEqual([17, 27.8, 107.2, 9.6]);
    expect(c(4, 4)).toEqual([17, 104, null, 17]);
    expect(c(6, 8)).toEqual([49, 1088.2, null, 51]);
  });

  test("session guarantees: the default run breaks all four; with all four on, none break", () => {
    const off = runSession({});
    expect(new Set(off.anomalies.map((a) => a.kind))).toEqual(new Set(["ryw", "mr", "wfr", "mw"]));
    const on = runSession({ on: { ryw: true, mr: true, wfr: true, mw: true } });
    expect(on.anomalies).toEqual([]);
    for (let seed = 1; seed <= 30; seed++) for (const interval of [20, 80, 150]) {
      const r = runSession({ seed, interval, on: { ryw: true, mr: true, wfr: true, mw: true } });
      expect(r.anomalies, `seed ${seed}`).toEqual([]);
    }
  });

  test("tokens: wait and redirect never return a stale read", () => {
    for (let seed = 1; seed <= 30; seed++) {
      expect(tokenStats(runTokens({ seed, mode: "wait" })).stale).toBe(0);
      expect(tokenStats(runTokens({ seed, mode: "redirect" })).stale).toBe(0);
    }
    expect(tokenStats(runTokens({ seed: 3, mode: "none", rounds: 4 })).stale).toBe(3);
  });

  test("CAP: of the four choices during a partition that never heals, none is both consistent and available", () => {
    const out = (["answer", "wait"] as const).flatMap((write) => (["answer", "wait"] as const).map((read) => { const r = runCap({ write, read }); return [write, read, r.linearizable, r.available]; }));
    expect(out).toEqual([["answer", "answer", false, true], ["answer", "wait", true, false], ["wait", "answer", true, false], ["wait", "wait", true, false]]);
    const healed = runCap({ write: "wait", read: "wait", healAt: 120 });
    expect(healed.linearizable).toBe(true);
    expect(healed.history.every((o) => Number.isFinite(o.ret))).toBe(true);
  });

  test("causal: dependency metadata removes the reply-before-question window", () => {
    for (const qDelay of [0, 30, 60, 120]) expect(runCausal({ qDelay, causal: true }).anomaly).toBeNull();
    expect(runCausal({ qDelay: 60 }).anomaly).not.toBeNull();
  });

  test("PACELC demo: the read waits for the remote replicas to meet the write quorum", () => {
    const base = [0.25, 30, 30];
    expect(r1(quorumLatency(3, 1, 1, base, 4000, 7).p50)).toBe(2.1);
    expect(r1(quorumLatency(3, 3, 1, base, 4000, 7).p50)).toBe(62.4);
  });
});
