/** Numbers quoted in the consensus lessons (the-consensus-problem, flp-impossibility, paxos, multi-paxos, byzantine-fault-tolerance). */
import { describe, expect, test } from "vitest";
import { crashTolerance, disjointPairs, flexibleQ1, majority, minOverlap, quorumTable } from "@/sims/dist/consensus/paxos/quorum";
import { runNaive } from "@/sims/dist/consensus/paxos/naive";
import { adversaryRun, initialValences, valenceName } from "@/sims/dist/consensus/paxos/valence";
import { benOrSweep, runBenOr } from "@/sims/dist/consensus/paxos/benor";
import { PAXOS_PRESETS, ballotName, replayHand, runDuel, scriptToActions } from "@/sims/dist/consensus/paxos/paxos";
import { NOOP, leaderChangeScenario, messagesBasic, messagesMulti } from "@/sims/dist/consensus/paxos/multipaxos";
import { linearMessages, pbftMessages, runPbft, type Behavior } from "@/sims/dist/consensus/paxos/pbft";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe("the consensus problem", () => {
  test("quorum table and overlaps", () => {
    expect(quorumTable([3, 4, 5, 7]).map((r) => [r.n, r.majority, r.crash])).toEqual([[3, 2, 1], [4, 3, 1], [5, 3, 2], [7, 4, 3]]);
    expect(disjointPairs(5, 2)).toMatchObject({ disjoint: 30, pairs: 100 });
    expect(disjointPairs(5, 3).disjoint).toBe(0);
    expect(disjointPairs(6, 3).disjoint).toBeGreaterThan(0);
    expect(majority(6)).toBe(4);
    for (let n = 3; n <= 9; n++) {
      expect(disjointPairs(n, majority(n)).minShared).toBe(minOverlap(majority(n), majority(n), n));
      expect(minOverlap(majority(n), majority(n), n)).toBeGreaterThanOrEqual(1);
      expect(n).toBeGreaterThanOrEqual(2 * crashTolerance(n) + 1);
    }
  });

  test("the leader protocol breaks under each adversary", () => {
    const part = runNaive({ fault: "partition", failover: true });
    expect(part.decided).toEqual(["A", "B", "B"]);
    expect(part.agreement).toBe(false);
    const partOff = runNaive({ fault: "partition", failover: false });
    expect([partOff.agreement, partOff.termination]).toEqual([true, false]);
    const crash = runNaive({ fault: "crash", failover: true });
    expect([crash.decided, crash.agreement]).toEqual([["A", "B", "B"], false]);
    expect(runNaive({ fault: "crash", failover: false }).termination).toBe(false);
    // One slow message: N3 takes over at 2 × 40 = 80 ms, and the message arrives at about 130 ms.
    const slow = runNaive({ fault: "slow", failover: true });
    expect(slow.decided).toEqual(["A", "A", "C"]);
    expect(slow.at[2]).toBe(80);
    const late = slow.net.messages.find((m) => m.from === 0 && m.to === 2)!;
    expect(late.deliveredAt!).toBeGreaterThan(128);
    expect(late.deliveredAt!).toBeLessThan(134);
    expect(runNaive({ fault: "slow", timeout: 65 }).agreement).toBe(false);
    expect(runNaive({ fault: "slow", timeout: 70 }).agreement).toBe(true);
    const none = runNaive({ fault: "none" });
    expect([none.agreement, none.termination]).toEqual([true, true]);
  });
});

describe("FLP", () => {
  test("initial valences: 000 is 0-valent, 001 bivalent, 011 1-valent", () => {
    const v = Object.fromEntries(initialValences().map((x) => [x.inputs.join(""), valenceName(x.valence)]));
    expect(v).toMatchObject({ "000": "0-valent", "001": "bivalent", "010": "bivalent", "100": "bivalent", "011": "1-valent", "111": "1-valent" });
  });

  test("the proof's adversary: 200 deliveries reach round 34 with no decision", () => {
    const r = adversaryRun([0, 0, 1], 200);
    expect(r.decided).toBe(0);
    expect(r.delivered.length).toBe(200);
    expect(r.rounds).toBe(34);
  });

  test("Ben-Or: rounds over 400 seeds", () => {
    const five = benOrSweep({ n: 5, f: 2, ones: 2 }, 400);
    expect(mean(five).toFixed(2)).toBe("3.73");
    expect(Math.max(...five)).toBe(14);
    expect(mean(benOrSweep({ n: 3, f: 1, ones: 1 }, 400)).toFixed(2)).toBe("2.67");
    expect(mean(benOrSweep({ n: 9, f: 4, ones: 4 }, 400)).toFixed(2)).toBe("7.62");
    expect(mean(benOrSweep({ n: 11, f: 5, ones: 5 }, 400)).toFixed(2)).toBe("10.73");
    for (const ones of [0, 5]) expect(new Set(benOrSweep({ n: 5, f: 2, ones }, 50))).toEqual(new Set([1]));
  });

  test("Ben-Or: agreement in every run, also with crashes", () => {
    for (let s = 1; s <= 300; s++) {
      const r = runBenOr({ n: 5, f: 2, crashes: 2, ones: 2, seed: s });
      expect(r.agreement).toBe(true);
      expect(r.decidedIn.filter((d) => d !== null).length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("Paxos", () => {
  test("presets", () => {
    const run = (id: string) => {
      const p = PAXOS_PRESETS.find((x) => x.id === id)!;
      return replayHand(2, 3, ["X", "Y"], p.bugs, scriptToActions(2, 3, ["X", "Y"], p.bugs, p.script)).core;
    };
    expect([...run("happy").chosenValues()]).toEqual(["X"]);
    const late = run("late");
    expect(late.chosen().map((c) => [ballotName(c.b), c.v])).toEqual([["1.1", "X"], ["1.2", "X"]]);
    expect(run("ignore").chosenValues()).toEqual(new Set(["X", "Y"]));
    expect(run("forget").chosenValues()).toEqual(new Set(["X", "Y"]));
  });

  test("duelling proposers", () => {
    const fixed = runDuel({ strategy: "fixed" });
    expect(fixed.chosenAt).toBeNull();
    expect(fixed.ballots).toBe(27);
    for (const timeout of [40, 45, 50, 60]) expect(runDuel({ strategy: "fixed", timeout }).chosenAt).toBe(45);
    const back = runDuel({ strategy: "backoff" });
    expect([back.chosenAt, back.ballots]).toEqual([45, 4]);
    expect(runDuel({ strategy: "leader" }).chosenAt).toBe(30);
  });

  test("duelling proposers over 200 runs (the curves of the demo)", () => {
    const at = (s: "fixed" | "backoff" | "leader") =>
      Array.from({ length: 200 }, (_, k) => runDuel({ strategy: s, timeout: 30, offset: (k * 7919) % 31, jitter: 1, seed: k + 1, horizon: 400 }).chosenAt);
    expect(at("fixed").filter((x) => x !== null).length).toBe(154);
    const back = at("backoff");
    expect(back.every((x) => x !== null && x <= 69)).toBe(true);
    expect(at("leader").every((x) => x !== null && x <= 32)).toBe(true);
  });
});

describe("Multi-Paxos", () => {
  const final = (q: number[]) => leaderChangeScenario(q).at(-1)!.chosen;
  test("a leader change keeps chosen values and fills gaps", () => {
    expect(final([2, 3])).toEqual(["a", "b", "c", NOOP, "e", "f", "g"]);
    expect(final([1, 2])).toEqual(["a", "b", "c", "d", "e", "g", null]);
    expect(final([1, 3])).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    // e (slot 5) is chosen before the crash and survives every quorum.
    for (const q of [[1, 2], [1, 3], [2, 3], [1, 2, 3]]) expect(final(q)[4]).toBe("e");
    const frames = leaderChangeScenario([2, 3]);
    expect(frames).toHaveLength(8);
    expect(frames[3]!.chosen[3]).toBeNull(); // d is on 2 of 5 nodes
    expect(frames[4]!.chosen[4]).toBe("e");
  });

  test("messages per command: 4(n − 1), 2(n − 1), and 2(q2 − 1) for a thrifty Flexible Paxos leader", () => {
    for (const n of [3, 5, 7, 9, 11, 13, 15]) {
      expect(messagesBasic(n, 4)).toBe(4 * (n - 1));
      expect(messagesMulti(n, 4)).toBe(2 * (n - 1));
      expect(messagesMulti(n, 4, 2, true)).toBe(2);
    }
    expect([messagesBasic(5), messagesMulti(5), messagesMulti(5, 10, 2, true)]).toEqual([16, 8, 2]);
    expect(messagesMulti(15)).toBe(28);
    expect(flexibleQ1(5, 2)).toBe(4);
  });
});

describe("Byzantine fault tolerance", () => {
  test("a lying primary with 4 and with 3 replicas", () => {
    const four = runPbft({ n: 4, f: 1, behavior: ["equivocate"], seed: 1 });
    expect(four.replicas.map((r) => r.committed)).toEqual([null, "x", "x", null]);
    expect([four.agreement, four.clientResult]).toEqual([true, "x"]);
    const three = runPbft({ n: 3, f: 1, behavior: ["equivocate"], seed: 1 });
    expect(three.replicas.map((r) => r.committed)).toEqual([null, "x", "y"]);
    expect(three.agreement).toBe(false);
  });

  test("a traitor backup cannot stop the honest ones; a bad primary only stops progress", () => {
    for (const how of ["equivocate", "silent", "garbage"] as const) {
      for (const t of [1, 2, 3]) {
        const b: Behavior[] = []; b[t] = how;
        const r = runPbft({ n: 4, f: 1, behavior: b, seed: 1 });
        expect(r.honestValues).toEqual(["x"]);
        expect(r.live).toBe(true);
      }
      if (how !== "equivocate") {
        const r = runPbft({ n: 4, f: 1, behavior: [how], seed: 1 });
        expect(r.honestValues).toEqual([]);
      }
    }
  });

  test("message counts: the formulas match runs on the network", () => {
    for (let f = 1; f <= 10; f++) {
      const n = 3 * f + 1;
      expect(runPbft({ n, f }).messages).toBe(pbftMessages(n));
      expect(runPbft({ n, f, linear: true }).messages).toBe(linearMessages(n));
    }
    expect([pbftMessages(4), linearMessages(4)]).toEqual([29, 20]);
    expect([pbftMessages(100), linearMessages(100)]).toEqual([19901, 596]);
  });
});
