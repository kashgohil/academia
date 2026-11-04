/** Numbers quoted in the lock-free lessons, produced by src/sims/lockfreeextras.ts. */
import { describe, expect, test } from "vitest";
import {
  casRace, meanRaceAttempts, abaOrder, abaBadPositions, tagWrap, tagLooksSame, hpBound, hpSim, ebrSim, ebrSummary,
  msqFrames, msqLagStats, msqLagRun,
} from "@/sims/lockfreeextras";
import { makeWorld, stallExperiment } from "@/sims/lockfree/scenario";
import { EBR } from "@/demos/lockfreeConfigs";

describe("lock-free stack: CAS race", () => {
  test("lock step: n threads need n(n+1)/2 CAS attempts; the last one fails n-1 times", () => {
    for (let n = 1; n <= 6; n++) {
      const r = casRace(n, "lockstep");
      expect(r.attempts, `n=${n}`).toBe((n * (n + 1)) / 2);
      expect(r.maxFails).toBe(n - 1);
      expect(r.frames.at(-1)!.stack.map((s) => s.value).sort((a, b) => a - b)).toEqual([1, 2, ...Array.from({ length: n }, (_, i) => 10 * (i + 1))]);
    }
    expect(casRace(4, "lockstep").attempts).toBe(10);
    expect(casRace(6, "lockstep").attempts).toBe(21);
  });
  test("random order: 4 threads need about 6 attempts on average", () => {
    const m = meanRaceAttempts(4);
    expect(m).toBeCloseTo(5.975, 3);
    expect(Math.round(m)).toBe(6);
  });
  test("every round of lock step lets exactly one CAS succeed", () => {
    const f = casRace(4, "lockstep").frames.filter((x) => x.kind.startsWith("cas")).map((x) => x.kind === "cas-ok");
    expect(f).toEqual([true, false, false, false, true, false, false, true, false, true]);
  });
});

describe("ABA: position of T0's CAS", () => {
  test("only position 4 breaks the stack, and only with LIFO reuse and no tags", () => {
    expect(abaBadPositions(false, "lifo")).toEqual([4]);
    expect(abaBadPositions(false, "fresh")).toEqual([]);
    expect(abaBadPositions(true, "lifo")).toEqual([]);
    expect(abaBadPositions(true, "fresh")).toEqual([]);
  });
  test("position 4 without tags: head is B, C, B, A after T1's operations; T0 returns 1 and 8 is lost", () => {
    const r = abaOrder(4, false, "lifo");
    expect(r.frames.slice(2, 6).map((f) => f.head.ptr)).toEqual([2, 3, 2, 1]);
    expect(r.casOk).toBe(true);
    expect(r.t0Result).toBe(1);
    expect(r.final).toEqual([7, 3]);
    expect(r.frames[5]!.stack.map((s) => s.value)).toEqual([8, 7, 3]); // A now holds 8
  });
  test("with the oldest-free allocator, 8 goes into the new node E and the CAS fails", () => {
    const r = abaOrder(4, false, "fresh");
    expect(r.frames[5]!.label).toContain("node E");
    expect(r.casOk).toBe(false);
    expect(r.t0Result).toBe(8);
  });
  test("with tags, T0 saw A·v0 and head is A·v4 at the CAS", () => {
    const r = abaOrder(4, true, "lifo");
    expect(r.seen.tag).toBe(0);
    expect(r.frames[r.casFrame - 1]!.head).toEqual({ ptr: 1, tag: 4 });
    expect(r.t0Result).toBe(8);
  });
  test("tag widths: 4 bits repeat after 16 changes, 16 bits after 65,536", () => {
    expect(tagWrap(4)).toBe(16);
    expect(tagWrap(16)).toBe(65536);
    expect(tagLooksSame(4, 16)).toBe(true);
    expect(tagLooksSame(4, 10)).toBe(false);
    expect(tagLooksSame(16, 65536)).toBe(true);
  });
});

describe("hazard pointers: scan", () => {
  test("4 threads x 2 slots: R = 12 frees at least 4, R = 16 frees at least 8 with 1 read per freed node, R = 8 may free none", () => {
    expect(hpBound(4, 2, 12).freedMin).toBe(4);
    expect(hpBound(4, 2, 16)).toMatchObject({ readsPerScan: 8, keptMax: 8, freedMin: 8, readsPerFreed: 1 });
    expect(hpBound(4, 2, 8).freedMin).toBe(0);
  });
  test("the retired list never grows past max(R, H*T + 1), with working or stalled readers", () => {
    for (const mode of ["working", "stalled"] as const)
      for (let T = 2; T <= 6; T++)
        for (const R of [2, 4, 8, 12, 16, 24])
          for (const seed of [1, 2, 3]) {
            const f = hpSim({ threads: T, R, mode, ticks: 80, seed });
            expect(f.at(-1)!.maxRetired, `${mode} T=${T} R=${R}`).toBeLessThanOrEqual(hpBound(T, 2, R).maxRetired);
          }
    expect(hpSim({ threads: 4, R: 12, mode: "stalled", ticks: 48 }).at(-1)!.maxRetired).toBe(12);
  });
  test("stalled readers keep only the nodes they announced", () => {
    const f = hpSim({ threads: 4, R: 12, mode: "stalled", ticks: 80 });
    const last = f.filter((x) => x.phase === "free").at(-1)!;
    expect(last.retired.filter((x) => x.mark === "kept").length).toBeLessThanOrEqual(6);
  });
  test("stall experiment (shared machine): hazard pointers hold at most 8 nodes", () => {
    const hp = stallExperiment({ scheme: "hazard", tags: true, threshold: 4, pool: 600 });
    expect(Math.max(...hp.map((p) => p[1]))).toBeLessThanOrEqual(8);
  });
});

describe("epoch-based reclamation: ring", () => {
  test("no stall: 2, 4 and 6 threads keep at most 5, 9 and 16 nodes waiting", () => {
    expect([2, 4, 6].map((n) => ebrSummary(ebrSim({ threads: n, stalled: false, steps: 300 })).maxWaiting)).toEqual([5, 9, 16]);
  });
  test("T0 stalled: the epoch stops at 1, nothing is freed, 99 nodes wait after 300 steps (4 threads)", () => {
    const f = ebrSim({ threads: 4, stalled: true, steps: 300 });
    expect(ebrSummary(f)).toMatchObject({ global: 1, freed: 0, finalWaiting: 99 });
    for (let i = 1; i < f.length; i++) expect(f[i]!.waiting).toBeGreaterThanOrEqual(f[i - 1]!.waiting);
  });
  test("a node is freed exactly when the global epoch is two past the epoch of its list", () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const f = ebrSim({ threads: n, stalled: false, steps: 400, seed: n });
      let retired = 0;
      for (let i = 1; i < f.length; i++) {
        const a = f[i - 1]!, b = f[i]!;
        if (b.waiting > a.waiting) retired++;
        expect(b.waiting + b.freed).toBe(retired);
        if (b.freed > a.freed) {
          expect(b.global).toBe(a.global + 1);
          const list = a.limbo.find((l) => l.epoch === b.global - 2)!;
          expect(b.freed - a.freed).toBe(list.count);
        }
        // Lists in use only hold the current and previous epochs.
        for (const l of b.limbo) if (l.count) expect([b.global - 1, b.global]).toContain(l.epoch);
      }
    }
  });
  test("stepper script: with nobody pinned in an old epoch, T1's pops move the epoch to 2", () => {
    const w = makeWorld(EBR, { scheme: "epoch", tags: false, threshold: 2, pool: 16 });
    while (w.threads[0]!.next) w.step(0);
    while (w.threads[1]!.next) w.step(1);
    expect(w.epoch).toBe(2);
    expect(w.unreclaimed()).toBeGreaterThan(0);
  });
});

describe("Michael-Scott queue: tail lag and helping", () => {
  test("stalled enqueuer: T1 helps, T0's tail CAS fails, T2 dequeues 1 then 10", () => {
    const f = msqFrames("stall");
    const kinds = f.map((x) => `${x.actor}:${x.kind}`);
    expect(kinds).toContain("1:help");
    expect(kinds.indexOf("0:link")).toBeLessThan(kinds.indexOf("1:help"));
    expect(kinds).toContain("0:fail");
    expect(f.at(-1)!.results[2]).toEqual([1, 10]);
    expect(Math.max(...f.map((x) => x.lag))).toBe(1);
  });
  test("dequeuer helps: on an empty queue with a half-done enqueue, T1 moves tail before it takes 10", () => {
    const f = msqFrames("deqhelp");
    const k = f.map((x) => `${x.actor}:${x.kind}`);
    expect(k.indexOf("1:help")).toBeGreaterThan(-1);
    expect(k.indexOf("1:help")).toBeLessThan(k.indexOf("1:deq"));
    expect(f.at(-1)!.results[1]).toEqual([10]);
  });
  test("no stall: nobody helps", () => {
    expect(msqFrames("plain").some((x) => x.kind === "help")).toBe(false);
  });
  test("random schedules: tail lags by at most 1; 1 thread never helps; 4 threads help in 69% of 300 runs", () => {
    for (let n = 1; n <= 6; n++) {
      const s = msqLagStats(n, 300, 1);
      expect(s.maxLag, `n=${n}`).toBe(1);
      expect(s.bad).toBe(0);
    }
    expect(msqLagStats(1, 300, 1).helps).toBe(0);
    const s4 = msqLagStats(4, 300, 1);
    expect(s4.runsWithHelp).toBe(207);
    expect(Math.round((100 * s4.runsWithHelp) / s4.runs)).toBe(69);
    expect(msqLagRun(4, 0, 1)).toEqual(msqLagRun(4, 0, 1));
  });
});

describe("claims about the shared stress and stepper demos", { timeout: 60000 }, () => {
  test("ABA stress (400 runs, seed 1): immediate free fails in most runs; with tags, only use-after-free remains", async () => {
    const { stress } = await import("@/sims/lockfree/scenario");
    const { STRESS_ABA } = await import("@/demos/lockfreeConfigs");
    const run = (i: number) => { const c = STRESS_ABA[i]!; return stress(c.scenario, { scheme: c.scheme, tags: c.tags, threshold: 2, pool: 16 }, 400, 1); };
    const raw = run(0), tagged = run(1);
    expect(raw.anyViolation).toBeGreaterThan(200);
    expect(raw.byKind["use-after-free"]).toBeGreaterThan(raw.anyViolation / 2);
    for (const k of ["lost-or-duplicated", "corruption", "double-free"] as const) expect(raw.byKind[k] ?? 0, k).toBeGreaterThan(0);
    expect(Object.keys(tagged.byKind)).toEqual(["use-after-free"]);
  });
  test("EBR stepper script: the first advance succeeds, then T0 in epoch 0 holds the epoch at 1", () => {
    const w = makeWorld(EBR, { scheme: "epoch", tags: false, threshold: 2, pool: 16 });
    while (!w.threads[0]!.next!.startsWith("read A.next")) w.step(0);
    while (w.threads[1]!.next) w.step(1);
    const labels = w.log.map((l) => l.label);
    expect(labels.filter((l) => l.startsWith("advance"))).toEqual(["advance global epoch 0 → 1"]);
    expect(labels.at(-2)).toBe("check T0's epoch");
    expect(w.epoch).toBe(1);
    expect(w.unreclaimed()).toBe(3);
  });
});
