/** Distributed Systems, Data systems: properties that hold over many seeds, as the lessons state them. */
import { describe, expect, test } from "vitest";
import {
  runSpread, runRepLog, runPipeline, runStream, streamEvents, runCheckpoint, GUARANTEES, type WindowKind, type CrashPhase,
} from "@/sims/dist/data-systems";
import { mulberry32 } from "@/sims/rng";

describe("gossip", () => {
  test("push-pull reaches every node within ⌈log₃ n⌉ + 3 rounds in 1000 of 1000 seeds", () => {
    for (const n of [16, 64, 256, 1024]) {
      const bound = Math.ceil(Math.log(n) / Math.log(3)) + 3;
      for (let seed = 1; seed <= 1000; seed++) {
        const r = runSpread({ n, mode: "push-pull", seed });
        expect(r.roundsToAll, `n=${n} seed=${seed}`).not.toBeNull();
        expect(r.roundsToAll!, `n=${n} seed=${seed}`).toBeLessThanOrEqual(bound);
      }
    }
  }, 300_000);
});

describe("replicated log", () => {
  /** A single crash of a random broker at a random time, random follower stalls, and maybe a restart. */
  const scenario = (seed: number) => {
    const rng = mulberry32(seed * 7919);
    const node = 1 + Math.floor(rng() * 3);
    const t = 60 + Math.floor(rng() * 360);
    const stalls = [2, 3].filter(() => rng() < 0.5).map((n) => {
      const from = Math.floor(rng() * 400);
      return { node: n, from, until: from + 20 + Math.floor(rng() * 150) };
    });
    const recovers = rng() < 0.6 ? [{ t: t + 50 + Math.floor(rng() * 200), node }] : [];
    return { seed, crashes: [{ t, node }], recovers, stalls };
  };
  test("acks=all, min.insync.replicas = 2, no unclean election: no acknowledged record is lost under a single crash", () => {
    let acked = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = runRepLog({ ...scenario(seed), acks: "all", minIsr: 2, unclean: false });
      expect(r.lost, `seed ${seed}`).toEqual([]);
      acked += r.acked.length;
    }
    expect(acked).toBeGreaterThan(400 * 5); // the runs did confirm records
  }, 300_000);
  test("the same scenarios lose acknowledged records with acks=1", () => {
    let lost = 0;
    for (let seed = 1; seed <= 400; seed++) lost += runRepLog({ ...scenario(seed), acks: "1", minIsr: 2, unclean: false }).lost.length;
    expect(lost).toBeGreaterThan(0);
  }, 300_000);
});

describe("exactly-once pipeline", () => {
  test("exactly-once mode applies each effect exactly once under random crash points and loss", () => {
    const phases: CrashPhase[] = ["read", "first", "second"];
    for (let seed = 1; seed <= 500; seed++) {
      const rng = mulberry32(seed * 31);
      const crashes = Array.from({ length: Math.floor(rng() * 5) }, () => ({ rec: Math.floor(rng() * 8), phase: phases[Math.floor(rng() * 3)]! }));
      const r = runPipeline({ mode: "exactly-once", seed, records: 8, crashes, dropRate: rng() * 0.3 });
      expect(r.done, `seed ${seed}`).toBe(true);
      expect(r.effects, `seed ${seed}`).toEqual(new Array(8).fill(1));
    }
  }, 300_000);
  test("the other modes break under the same kind of runs", () => {
    const sum = (mode: (typeof GUARANTEES)[number]) => {
      let lost = 0, dup = 0;
      for (let seed = 1; seed <= 100; seed++) {
        const r = runPipeline({ mode, seed, crashes: [{ rec: seed % 6, phase: "first" }] });
        lost += r.lost;
        dup += r.duplicated;
      }
      return { lost, dup };
    };
    expect(sum("at-most-once").lost).toBeGreaterThan(0);
    expect(sum("at-least-once").dup).toBeGreaterThan(0);
    expect(sum("at-least-once").lost).toBe(0);
  });
});

describe("stream windows", () => {
  test("with a watermark delay at least the largest disorder, every window equals the batch result", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const events = streamEvents({ seed });
      const disorder = runStream({ seed, delay: 0 }, events).maxDisorder;
      for (const kind of ["tumbling", "sliding", "session"] as WindowKind[]) {
        const r = runStream({ seed, kind, delay: disorder }, events);
        expect(r.dropped, `seed ${seed} ${kind}`).toEqual([]);
        expect(r.wrong, `seed ${seed} ${kind}`).toEqual([]);
        expect([...r.stream.keys()].sort()).toEqual([...r.batch.keys()].sort());
      }
    }
  });
  test("a short delay with enough allowed lateness also ends with the batch result", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const events = streamEvents({ seed });
      const disorder = runStream({ seed, delay: 0 }, events).maxDisorder;
      const r = runStream({ seed, delay: 100, allowedLateness: disorder }, events);
      expect(r.wrong, `seed ${seed}`).toEqual([]);
    }
  });
});

describe("checkpoints", () => {
  test("aligned barriers restore exact counts for any crash time", () => {
    for (let t = 20; t <= 300; t += 5) {
      const r = runCheckpoint({ aligned: true, crashAt: t });
      expect(r.final, `crash at ${t}`).toMatchObject({ cA: 16, cB: 6 });
    }
  });
});
