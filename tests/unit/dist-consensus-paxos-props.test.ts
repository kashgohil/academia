/** Safety properties of the consensus sims: exhaustive searches and many random runs. */
import { describe, expect, test } from "vitest";
import { Explorer, decidedMask, deliver, enabled, initial, type Bit, type VConfig } from "@/sims/dist/consensus/paxos/valence";
import { exhaustive, runChaos } from "@/sims/dist/consensus/paxos/paxos";
import { MultiPaxos } from "@/sims/dist/consensus/paxos/multipaxos";
import { runPbft, type Behavior } from "@/sims/dist/consensus/paxos/pbft";
import { mulberry32 } from "@/sims/rng";

/** Every configuration reachable from `c` while no process passes round `maxRound`. */
function reachable(c0: VConfig, maxRound: number): VConfig[] {
  const seen = new Set<string>(), out: VConfig[] = [];
  const key = (c: VConfig) => JSON.stringify([c.p, c.m.map(({ id: _id, ...m }) => m).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  const stack = [c0];
  while (stack.length) {
    const c = stack.pop()!;
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    for (const m of c.m) if (enabled(c, m)) {
      const n = deliver(c, m.id, maxRound + 3);
      if (Math.max(...n.p.map((p) => p.r)) <= maxRound) stack.push(n);
    }
  }
  return out;
}

describe("the FLP model", () => {
  const all = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((k) => reachable(initial([(k >> 2) & 1, (k >> 1) & 1, k & 1] as Bit[]), 2));

  test("safety: no reachable configuration has two decisions", () => {
    expect(all.length).toBeGreaterThan(1000);
    for (const c of all) expect(decidedMask(c)).not.toBe(3);
  });

  test("valence does not depend on the search horizon, and nothing is stuck", () => {
    const a = new Explorer(3), b = new Explorer(5);
    for (const c of all) {
      const v = a.valence(c);
      expect(v).not.toBe(0);
      expect(b.valence(c)).toBe(v);
    }
  });

  test("with one process crashed, every schedule decides within two more rounds", () => {
    const memo = new Map<string, boolean>();
    const allDecide = (c: VConfig, crashed: number, limit: number): boolean => {
      if (decidedMask(c)) return true;
      const k = JSON.stringify([c.p, c.m.map(({ id: _id, ...m }) => m), crashed, limit]);
      const hit = memo.get(k);
      if (hit !== undefined) return hit;
      const live = c.m.filter((m) => enabled(c, m, crashed));
      let ok = live.length > 0;
      for (const m of live) {
        const n = deliver(c, m.id, limit + 1);
        if (n.p.some((p, i) => i !== crashed && p.r > limit && !decidedMask(n)) || !allDecide(n, crashed, limit)) { ok = false; break; }
      }
      memo.set(k, ok);
      return ok;
    };
    for (const c of all.filter((_, i) => i % 7 === 0)) for (const crashed of [0, 1, 2]) {
      expect(allDecide(c, crashed, Math.max(...c.p.map((p) => p.r)) + 2)).toBe(true);
    }
  });
});

describe("single-decree Paxos", () => {
  test("exhaustive: 2 proposers, 3 acceptors, every schedule, never two values", () => {
    const one = exhaustive(2, 3, 1);
    expect([one.states, one.violation]).toEqual([3417, null]);
    const two = exhaustive(2, 3, 2);
    expect([two.states, two.violation]).toEqual([414605, null]);
    expect(two.chosenStates).toBeGreaterThan(0);
  }, 120_000);

  test("exhaustive: each bug lets two values be chosen", () => {
    expect(exhaustive(2, 3, 1, { ignoreAccepted: true }).violation).not.toBeNull();
    expect(exhaustive(2, 3, 1, { forget: true }).violation).not.toBeNull();
  });

  test("random schedules with loss, duplicates and crashes: 500 seeds, never two values", () => {
    let chosen = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const r = runChaos({ seed, np: 2 + (seed % 2), na: seed % 3 === 0 ? 3 : 5 });
      expect(r.chosen.size, `seed ${seed}`).toBeLessThanOrEqual(1);
      if (r.chosen.size) chosen++;
    }
    expect(chosen).toBeGreaterThan(450);
  }, 60_000);

  test("the same random runs catch both bugs", () => {
    const bad = (bugs: object, crashes = 4) => Array.from({ length: 200 }, (_, s) => runChaos({ seed: s + 1, bugs, crashes })).filter((r) => r.chosen.size > 1).length;
    expect(bad({ ignoreAccepted: true })).toBeGreaterThan(0);
    expect(bad({ forget: true }, 8)).toBeGreaterThan(0);
  }, 60_000);
});

describe("Multi-Paxos", () => {
  test("random leader changes, cuts and crashes never choose two values in a slot", () => {
    let slots = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const rng = mulberry32(seed);
      const pick = (k: number) => Math.floor(rng() * k);
      const mp = new MultiPaxos({ n: 5, seed });
      let cmd = 0;
      for (let step = 0; step < 30; step++) {
        const i = pick(5), op = pick(6);
        const others = [0, 1, 2, 3, 4].filter((x) => x !== i && rng() < 0.6);
        if (op === 0) mp.net.isUp(i) ? mp.net.crash(i) : mp.net.recover(i);
        else if (op === 1 && mp.net.isUp(i)) mp.elect(i);
        else if (mp.net.isUp(i)) mp.submit(i, `c${cmd++}`);
        if (rng() < 0.5) mp.net.partition([[i, ...others]]);
        mp.net.runUntil(mp.net.now + pick(30));
        if (rng() < 0.5) mp.net.heal();
      }
      mp.net.heal();
      mp.settle();
      for (const [slot, vs] of mp.chosenTruth()) expect(vs.size, `seed ${seed} slot ${slot}`).toBe(1);
      slots += mp.chosenTruth().size;
    }
    expect(slots).toBeGreaterThan(300);
  });
});

describe("PBFT", () => {
  test("honest replicas never commit different values with f traitors out of 3f + 1", () => {
    const kinds: Behavior[] = ["equivocate", "silent", "garbage"];
    for (const f of [1, 2]) {
      const n = 3 * f + 1;
      for (let seed = 1; seed <= 150; seed++) {
        const rng = mulberry32(seed * 31 + f);
        const behavior: Behavior[] = [];
        const traitors = new Set<number>();
        while (traitors.size < f) traitors.add(Math.floor(rng() * n));
        for (const t of traitors) behavior[t] = kinds[Math.floor(rng() * 3)]!;
        const r = runPbft({ n, f, behavior, seed, latency: { min: 1, max: 30 } });
        expect(r.agreement, `f=${f} seed=${seed}`).toBe(true);
        if (!traitors.has(0)) expect(r.live).toBe(true);
      }
    }
  });

  test("with 3 replicas and f = 1, a lying primary splits the honest ones in some runs", () => {
    const split = Array.from({ length: 50 }, (_, s) => runPbft({ n: 3, f: 1, behavior: ["equivocate"], seed: s + 1 })).filter((r) => !r.agreement).length;
    expect(split).toBeGreaterThan(0);
  });
});
