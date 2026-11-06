/** CRDTs: strong eventual consistency on random runs, the join laws on random states, and every number the lessons quote. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  PRESET_ACTIONS, SET_PRESETS, CausalNet, Rga, RgaNet, agree, brokenShare, checkLaws, chainLattice, counterStateBytes, gCounter, gCounterLattice,
  gSet, gossipBytes, hasseEdges, idKey, interleave, logootSplitShare, lwwCounter, lwwRegister, lwwSet, maxRegister, orMap, orSet, orswot, playSet,
  pnCounter, powersetLattice, presetSteps, replaySteps, runOpBased, runStateCluster, runTombstones, twoPSet, upperBounds, allocBetween, posCompare,
  type ClusterAction, type RgaOp, type SetAction, type SetCrdt, type StateCrdt,
} from "@/sims/dist/crdts";

/** A random state: random updates at random replicas, merged in a random pattern. */
function randomState<S>(c: StateCrdt<S, number, unknown>, rng: () => number, n = 3): S {
  const reps: S[] = Array.from({ length: n }, () => c.init(n));
  for (let k = 0; k < 8; k++) {
    const r = Math.floor(rng() * n);
    if (rng() < 0.7) reps[r] = c.update(reps[r]!, r, c === (gCounter as unknown) || c === (maxRegister as unknown) ? Math.floor(rng() * 4) : Math.floor(rng() * 7) - 3, Math.floor(rng() * 20));
    else reps[r] = c.merge(reps[r]!, reps[Math.floor(rng() * n)]!);
  }
  return reps[Math.floor(rng() * n)]!;
}

describe("state-based CRDTs: the join laws on random states", () => {
  const types: [string, StateCrdt<any, number, unknown>][] = [["G-Counter", gCounter], ["PN-Counter", pnCounter], ["max-register", maxRegister], ["LWW-register", lwwRegister], ["LWW counter", lwwCounter]];
  for (const [name, c] of types)
    test(name, () => {
      const rng = mulberry32(7);
      for (let k = 0; k < 300; k++) {
        const law = checkLaws(c, randomState(c, rng), randomState(c, rng), randomState(c, rng), { r: 1, op: c === gCounter || c === maxRegister ? 2 : 1, time: 100 });
        expect(law).toEqual({ commutative: true, associative: true, idempotent: true, upperBound: true, inflation: true });
      }
    });

  test("set types: merge is commutative, associative and idempotent", () => {
    const rng = mulberry32(11);
    const sets: SetCrdt<any>[] = [twoPSet, lwwSet, orSet, orswot];
    for (const c of sets)
      for (let k = 0; k < 200; k++) {
        const st = () => {
          const reps = [c.init(3), c.init(3), c.init(3)];
          for (let j = 0; j < 10; j++) {
            const r = Math.floor(rng() * 3), e = "xyz"[Math.floor(rng() * 3)]!, x = rng();
            reps[r] = x < 0.45 ? c.add(reps[r], r, e, j * 10) : x < 0.8 ? c.rmv(reps[r], r, e, j * 10) : c.merge(reps[r], reps[Math.floor(rng() * 3)]);
          }
          return reps;
        };
        // States of one system (shared tags), so that the merge laws are meaningful for OR-Sets.
        const [a, b, d] = st();
        expect(c.key(c.merge(a, b))).toBe(c.key(c.merge(b, a)));
        expect(c.key(c.merge(c.merge(a, b), d))).toBe(c.key(c.merge(a, c.merge(b, d))));
        expect(c.key(c.merge(a, a))).toBe(c.key(a));
      }
  });

  test("lattice views: the join is the least upper bound", () => {
    for (const L of [gCounterLattice(3), powersetLattice(), chainLattice(5)] as const) {
      const nodes = L.nodes as unknown[];
      for (const a of nodes) for (const b of nodes) {
        const { least, bounds } = upperBounds(L as never, a as never, b as never);
        expect(L.key(least as never)).toBe(L.key(L.join(a as never, b as never) as never));
        expect(bounds.length).toBeGreaterThan(0);
      }
    }
    expect(hasseEdges(gCounterLattice(3)).length).toBe(24);
    expect(hasseEdges(powersetLattice()).length).toBe(12);
  });
});

describe("strong eventual consistency on Net", () => {
  test("PN-Counter: any delivery order, duplicates, loss and partitions converge to the true sum", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed);
      const actions: ClusterAction[] = [];
      for (let k = 0; k < 30; k++) {
        const x = rng();
        if (x < 0.5) actions.push({ k: "op", r: Math.floor(rng() * 3), d: rng() < 0.7 ? 1 : -1 });
        else if (x < 0.85) actions.push({ k: "run", ms: rng() * 60 });
        else if (x < 0.93) actions.push({ k: "cut", r: Math.floor(rng() * 3) });
        else actions.push({ k: "heal" });
      }
      actions.push({ k: "heal" }, { k: "run", ms: 2000 });
      const run = runStateCluster(pnCounter, actions, { seed, dupRate: 0.3, dropRate: 0.2, latency: { min: 1, max: 80 } });
      expect(agree(run)).toBe(true);
      expect(run.values[0]).toBe(run.truth);
      // The naive counter also converges (its merge is a join), but not always to the true sum.
      const naive = runStateCluster(lwwCounter, actions, { seed, dupRate: 0.3, dropRate: 0.2, latency: { min: 1, max: 80 } });
      expect(agree(naive)).toBe(true);
    }
  });

  test("delta mode converges to the same value as full-state gossip", () => {
    for (const n of [3, 10]) {
      expect(gossipBytes(gCounter, n, true).converged).toBe(true);
      expect(gossipBytes(gCounter, n, false).converged).toBe(true);
    }
  });

  test("set types converge under random merge orders, with any number of repeats", () => {
    for (const c of [twoPSet, lwwSet, orSet, orswot] as SetCrdt<any>[])
      for (let seed = 1; seed <= 40; seed++) {
        const rng = mulberry32(seed);
        let reps = [c.init(3), c.init(3), c.init(3)];
        for (let j = 0; j < 25; j++) {
          const r = Math.floor(rng() * 3), e = "xyzw"[Math.floor(rng() * 4)]!, x = rng();
          reps[r] = x < 0.4 ? c.add(reps[r], r, e, j * 10 + r) : x < 0.7 ? c.rmv(reps[r], r, e, j * 10 + r) : c.merge(reps[r], reps[Math.floor(rng() * 3)]);
        }
        // Gossip in a random order, with repeats, until every pair has met in both directions.
        for (let j = 0; j < 30; j++) { const a = Math.floor(rng() * 3), b = Math.floor(rng() * 3); reps[a] = c.merge(reps[a], reps[b]); }
        const all = c.merge(c.merge(reps[0], reps[1]), reps[2]);
        const other = c.merge(reps[2], c.merge(reps[1], c.merge(reps[0], reps[0])));
        expect(c.key(all)).toBe(c.key(other));
        reps = reps.map((s) => c.merge(s, all));
        expect(new Set(reps.map((s) => JSON.stringify(c.elements(s)))).size).toBe(1);
      }
  });

  test("OR-Set: add wins over a concurrent remove, in both OR-Sets and op-based", () => {
    for (const c of [orSet, orswot] as SetCrdt<any>[]) {
      const res = playSet(c, SET_PRESETS[0]!.actions);
      expect(c.elements(res.merged)).toEqual(["x"]);
      const late = playSet(c, SET_PRESETS[2]!.actions);
      expect(c.elements(late.merged)).toEqual(["x"]);
    }
    // A remove that saw every add removes the element everywhere.
    const seen = playSet(orSet, [{ k: "add", r: 0, e: "x" }, { k: "add", r: 1, e: "x" }, { k: "sync" }, { k: "rmv", r: 1, e: "x" }]);
    expect(orSet.elements(seen.merged)).toEqual([]);
  });

  test("OR-Map: an update concurrent with a remove keeps the key", () => {
    let a = orMap.update(orMap.init(2), 0, "milk", 2, 2);
    let b = orMap.merge(orMap.init(2), a);
    a = orMap.remove(a, 0, "milk");
    b = orMap.update(b, 1, "milk", 1, 2);
    expect(orMap.value(orMap.merge(a, b))).toEqual({ milk: 3 });
    expect(orMap.key(orMap.merge(a, b))).toBe(orMap.key(orMap.merge(b, a)));
  });
});

describe("op-based CRDTs and causal broadcast", () => {
  test("with causal delivery, counters and sets converge despite duplicates and reordering", () => {
    for (let seed = 1; seed <= 60; seed++) {
      expect(runOpBased({ seed, object: "counter", dupRate: 0.3, causal: true }).wrong).toEqual([]);
      expect(runOpBased({ seed, object: "set", dupRate: 0.3, causal: true }).wrong).toEqual([]);
    }
  });

  test("causal broadcast with anti-entropy repairs loss, and delivers each op once in causal order", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const order: string[][] = [[], [], []];
      const cb = new CausalNet<number>(3, { seed, latency: { min: 1, max: 60 }, dropRate: 0.3, dupRate: 0.3 }, { causal: true, antiEntropy: 50 }, (i, _op, m) => order[i]!.push(`${m.origin}:${m.seq}`));
      const rng = mulberry32(seed);
      for (let k = 0; k < 20; k++) { cb.net.runUntil(cb.net.now + rng() * 20); cb.broadcast(Math.floor(rng() * 3), k); }
      cb.net.runUntil(cb.net.now + 3000);
      for (const o of order) {
        expect(o.length).toBe(20);
        expect(new Set(o).size).toBe(20);
        // Ops of one origin arrive in their own order.
        for (const r of [0, 1, 2]) { const s = o.filter((x) => x.startsWith(`${r}:`)).map((x) => Number(x.split(":")[1])); expect(s).toEqual([...s].sort((a, b) => a - b)); }
      }
      // Stability never runs ahead of what replica 0 itself has delivered.
      cb.stable(0).forEach((x, k) => expect(x).toBeLessThanOrEqual(cb.D[0]![k]!));
    }
  });

  test("the stepper: the causal buffer holds the early remove; without it, R3 keeps x", () => {
    const withBuf = replaySteps([...presetSteps(), { k: "deliver", id: 2 }], true);
    expect(withBuf.log[3]).toBe("R3 buffers op 2.1: it first needs op 1.1.");
    expect([...withBuf.sets[2]!.keys()]).toEqual([]);
    const noBuf = replaySteps([...presetSteps(), { k: "deliver", id: 2 }], false);
    expect([...noBuf.sets[2]!.keys()]).toEqual(["x"]);
  });
});

describe("RGA", () => {
  test("replicas converge and keep each replica's earlier order of characters", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const docs = [new Rga(0), new Rga(1), new Rga(2)];
      const snaps: string[][][] = [[], [], []];
      const cb = new CausalNet<RgaOp>(3, { seed, latency: { min: 1, max: 50 }, dupRate: 0.2 }, { causal: true }, (i, op, m) => {
        if (!m.local) docs[i]!.apply(op);
        snaps[i]!.push(docs[i]!.elems.map((e) => idKey(e.id)));
      });
      const rng = mulberry32(seed);
      for (let k = 0; k < 60; k++) {
        cb.net.runUntil(cb.net.now + rng() * 8);
        const r = Math.floor(rng() * 3), d = docs[r]!, len = d.visible().length;
        if (len && rng() < 0.25) cb.broadcast(r, d.deleteAt(Math.floor(rng() * len)));
        else cb.broadcast(r, d.insertAt(Math.floor(rng() * (len + 1)), "abcdefgh"[k % 8]!));
      }
      cb.net.runAll();
      const final = docs[0]!.elems.map((e) => idKey(e.id));
      for (const d of docs) {
        expect(d.text()).toBe(docs[0]!.text());
        expect(d.elems.map((e) => idKey(e.id))).toEqual(final);
      }
      const pos = new Map(final.map((k, i) => [k, i]));
      for (const s of snaps.flat()) for (let i = 1; i < s.length; i++) expect(pos.get(s[i - 1]!)!).toBeLessThan(pos.get(s[i]!)!);
    }
  });

  test("two editors on Net converge after a partition heals", () => {
    const net = new RgaNet(2, 30, 1, 100);
    net.edit(0, "hello");
    net.cb.net.runUntil(200);
    net.cb.net.partition([[0], [1]]);
    net.edit(0, "hello world");
    net.edit(1, "Hhello");
    net.cb.net.runUntil(400);
    expect(net.docs[0]!.text()).not.toBe(net.docs[1]!.text());
    net.cb.net.heal();
    net.cb.net.runUntil(1000);
    expect(net.docs[0]!.text()).toBe("Hhello world");
    expect(net.docs[1]!.text()).toBe("Hhello world");
    expect(net.pending()).toBe(0);
  });

  test("Logoot-style positions are strictly between their neighbours", () => {
    const rng = mulberry32(3);
    for (let k = 0; k < 500; k++) {
      const p: [number, number][] = [[Math.floor(rng() * 10), 0], [Math.floor(rng() * 32), 1]];
      const q: [number, number][] = rng() < 0.5 ? [[p[0]![0], p[0]![1]], [p[1]![0], 2]] : [[p[0]![0] + 1, 0]];
      const r = allocBetween(p, q, 1, rng);
      expect(posCompare(p, r)).toBeLessThan(0);
      expect(posCompare(r, q)).toBeLessThan(0);
    }
  });
});

describe("numbers quoted in the lessons", () => {
  test("state-based-crdts", () => {
    // The demo's defaults: the preset with 20% duplicated messages.
    const pn = runStateCluster(pnCounter, PRESET_ACTIONS, { dupRate: 0.2 });
    const naive = runStateCluster(lwwCounter, PRESET_ACTIONS, { dupRate: 0.2 });
    expect(pn.ops.length).toBe(6);
    expect(pn.truth).toBe(7);
    expect(pn.values).toEqual([7, 7, 7]);
    expect(naive.values).toEqual([0, 0, 0]);
    expect(counterStateBytes(100)).toBe(1600);
    const row = (n: number) => [gossipBytes(gCounter, n, false), gossipBytes(gCounter, n, true)].map((x) => [Math.round(x.perMessage), Math.round(x.total / 1000)]);
    expect(row(3)).toEqual([[48, 4], [29, 1]]);
    expect(row(10)).toEqual([[160, 39], [112, 19]]);
    expect(row(100)).toEqual([[1600, 3984], [1135, 2618]]);
    expect(gSet.merge(["x"], ["y"])).toEqual(["x", "y"]);
    // Things to try: three quick increments, and the preset with 50% duplicates.
    const quick: ClusterAction[] = [0, 1, 2].flatMap((r) => [{ k: "op", r, d: 1 }, { k: "run", ms: 5 }] as ClusterAction[]).concat([{ k: "run", ms: 100 }]);
    expect(runStateCluster(pnCounter, quick, { dupRate: 0.2 }).values).toEqual([3, 3, 3]);
    expect(runStateCluster(lwwCounter, quick, { dupRate: 0.2 }).values).toEqual([1, 1, 1]);
    expect(runStateCluster(pnCounter, PRESET_ACTIONS, { dupRate: 0.5 }).values).toEqual([7, 7, 7]);
    // The lattice demo's default pick.
    const L = gCounterLattice(3);
    const ub = upperBounds(L, [2, 0], [1, 2]);
    expect([L.nodes.length, ub.least, ub.bounds.length]).toEqual([16, [2, 2], 4]);
  });

  test("operation-based-crdts", () => {
    expect(brokenShare({ object: "counter", dupRate: 0.3, dedupe: false })).toBe(1);
    expect(brokenShare({ object: "counter", dupRate: 0.3, dedupe: true })).toBe(0);
    expect(brokenShare({ object: "counter", dupRate: 0, dedupe: true })).toBe(0);
    expect(brokenShare({ object: "set", causal: false })).toBe(0.845);
    expect(brokenShare({ object: "set", dupRate: 0.3, causal: true })).toBe(0);
    expect(brokenShare({ object: "set", dupRate: 0, causal: true })).toBe(0);
  });

  test("sets-maps-and-deletion", () => {
    const keep = runTombstones("keep"), gc = runTombstones("gc"), ow = runTombstones("orswot");
    expect([keep.adds, keep.removes, keep.finalMeta]).toEqual([77, 67, 76]);
    expect([gc.converged, gc.finalMeta, ow.finalMeta]).toEqual([true, 0, 3]);
    const cut = runTombstones("gc", { cut: [1000, 2500] });
    expect(cut.converged).toBe(true);
    expect(Math.max(...cut.samples.map((s) => s[1]))).toBe(28);
    expect(Math.max(...gc.samples.map((s) => s[1]))).toBe(13);
    for (let seed = 1; seed <= 10; seed++) expect(runTombstones("gc", { seed, cut: [500, 2000] }).converged).toBe(true);
    // The playground presets.
    const el = (c: SetCrdt<any>, i: number) => c.elements(playSet(c, SET_PRESETS[i]!.actions).merged);
    expect([el(twoPSet, 0), el(lwwSet, 0), el(orSet, 0)]).toEqual([[], ["x"], ["x"]]);
    expect([el(twoPSet, 1), el(lwwSet, 1), el(orSet, 1)]).toEqual([[], ["x"], ["x"]]);
    expect([el(twoPSet, 2), el(lwwSet, 2), el(orSet, 2)]).toEqual([[], [], ["x"]]);
    // Things to try: R2's clock 50 ms behind loses the race for LWW; a remove that saw both adds removes x everywhere.
    expect(lwwSet.elements(playSet(lwwSet, SET_PRESETS[0]!.actions, [0, -50]).merged)).toEqual([]);
    expect(orSet.elements(playSet(orSet, SET_PRESETS[0]!.actions, [0, -50]).merged)).toEqual(["x"]);
    const both: SetAction[] = [{ k: "add", r: 0, e: "x" }, { k: "add", r: 1, e: "x" }, { k: "sync" }, { k: "rmv", r: 0, e: "x" }];
    expect([twoPSet, lwwSet, orSet].map((c) => (c as SetCrdt<any>).elements(playSet(c as SetCrdt<any>, both).merged))).toEqual([[], [], []]);
  });

  test("sequence-crdts-for-collaborative-editing", () => {
    expect(interleave("rga", "cat", "dog", "forward").texts).toEqual(["Hi dogcat!", "Hi dogcat!"]);
    expect(interleave("rga", "cat", "dog", "backward").texts).toEqual(["Hi dcoagt!", "Hi dcoagt!"]);
    expect(interleave("index", "cat", "dog", "forward").texts).toEqual(["Hi dogcat!", "Hi catdog!"]);
    expect(interleave("logoot", "cat", "dog", "forward").texts[0]).toBe("Hi cdatog!");
    expect(logootSplitShare("cat", "dog", "forward")).toBe(0.705);
    expect(logootSplitShare("cat", "dog", "backward")).toBe(0.945);
  });
});
