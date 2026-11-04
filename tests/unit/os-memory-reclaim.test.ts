/** Reclaim, OOM and overcommit: model invariants and every number in the lesson. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  minFreeKbytes, watermarks, runPressure, PRESSURE_DEFAULTS, VM_DEFAULTS, oomBadness, oomScore, pickVictim, globalTotalPages, k8sOomScoreAdj,
  commitLimit, overcommitCheck, touchOutcome, type OomProc,
} from "@/sims/os/memory";

const lesson = readFileSync(new URL("../../src/content/lessons/os/memory/swapping-and-the-oom-killer.mdx", import.meta.url), "utf8");

describe("watermarks", () => {
  test("16 GiB: min 16,384 kB, low 33,161 kB, high 49,938 kB, about 0.3% of memory", () => {
    const kb = 16 * 1024 * 1024;
    const min = minFreeKbytes(kb);
    expect(min).toBe(16384);
    const m = watermarks(kb, min);
    expect(Math.floor(m.low)).toBe(33161);
    expect(Math.floor(m.high)).toBe(49938);
    expect((m.high / kb) * 100).toBeCloseTo(0.3, 1);
    expect(lesson).toContain("33,161");
    expect(lesson).toContain("49,938");
  });
  test("clamps and the min/4 rule", () => {
    expect(minFreeKbytes(100)).toBe(128);
    expect(minFreeKbytes(2 ** 40)).toBe(262144);
    expect(watermarks(1000, 1000, 10).gap).toBe(250);
  });
  test("defaults", () => {
    expect(VM_DEFAULTS).toMatchObject({ swappiness: 60, swappinessMax: 200, watermarkScaleFactor: 10, overcommitRatio: 50, zswapMaxPoolPercent: 20 });
  });
});

describe("pressure model", () => {
  const cases = [{}, { swappiness: 0 }, { swappiness: 200 }, { swapMiB: 0 }, { zswap: true }, { zswap: true, swapMiB: 8192 }, { growthMiBps: 1600 }];
  test("RAM is conserved in every frame, and free never goes below zero", () => {
    for (const c of cases) {
      for (const f of runPressure(c).frames) {
        expect(f.free + f.fileCold + f.fileHot + f.anon + f.zpool).toBeCloseTo(PRESSURE_DEFAULTS.ramMiB, 6);
        expect(f.free).toBeGreaterThanOrEqual(0);
        expect(f.swapUsed).toBeLessThanOrEqual((c as { swapMiB?: number }).swapMiB ?? PRESSURE_DEFAULTS.swapMiB);
      }
    }
  });
  test("the order is kswapd, then direct reclaim, then OOM", () => {
    for (const c of cases) {
      const r = runPressure(c);
      expect(r.firstKswapd).not.toBeNull();
      if (r.firstDirect !== null) expect(r.firstDirect).toBeGreaterThan(r.firstKswapd!);
      if (r.oomAt !== null) { expect(r.firstDirect).not.toBeNull(); expect(r.oomAt).toBeGreaterThan(r.firstDirect!); }
    }
  });
  test("no swap: nothing is swapped out", () => {
    expect(runPressure({ swapMiB: 0 }).totals.swapOutMiB).toBe(0);
  });
  const s1 = (x: number | null) => x?.toFixed(1);
  test("default run: kswapd 7.8 s, direct 31.8 s, OOM 33.8 s, refaults 7,982 MiB, peak stall 66%", () => {
    const r = runPressure();
    expect(s1(r.firstKswapd)).toBe("7.8");
    expect(s1(r.firstDirect)).toBe("31.8");
    expect(s1(r.oomAt)).toBe("33.8");
    expect(Math.round(r.totals.refaultMiB)).toBe(7982);
    expect(Math.round(r.peakPsi * 100)).toBe(66);
    // The cold cache is gone by 14 s.
    expect(r.frames[140]!.fileCold).toBe(0);
    expect(r.frames[120]!.fileCold).toBeGreaterThan(0);
    // Before kswapd wakes, the cold cache has not moved.
    expect(r.frames[70]!.fileCold).toBe(PRESSURE_DEFAULTS.fileColdMiB);
    // Swap is almost full at the first direct reclaim.
    expect(r.frames[318]!.swapUsed).toBeGreaterThan(0.99 * PRESSURE_DEFAULTS.swapMiB);
    // Free memory comes back after the kill.
    expect(r.frames[340]!.free).toBeGreaterThan(8000);
  });
  test("swappiness 200: direct at 14.2 s, refaults 3,975 MiB. Swappiness 0: refaults 9,537 MiB", () => {
    const hi = runPressure({ swappiness: 200 });
    expect(s1(hi.firstDirect)).toBe("14.2");
    expect(Math.round(hi.totals.refaultMiB)).toBe(3975);
    expect(Math.round(runPressure({ swappiness: 0 }).totals.refaultMiB)).toBe(9537);
    expect(lesson).toContain("3,975 MiB");
    expect(lesson).toContain("9,537 MiB");
  });
  test("no swap: OOM at 19.8 s", () => {
    expect(s1(runPressure({ swapMiB: 0 }).oomAt)).toBe("19.8");
  });
  test("zswap with 2 GiB: peak stall 51%, no disk writes, OOM at 27.1 s. With 8 GiB: no direct reclaim", () => {
    const z = runPressure({ zswap: true });
    expect(Math.round(z.peakPsi * 100)).toBe(51);
    expect(z.totals.diskWriteMiB).toBe(0);
    expect(s1(z.oomAt)).toBe("27.1");
    const big = runPressure({ zswap: true, swapMiB: 8192 });
    expect(big.firstDirect).toBeNull();
    expect(big.oomAt).toBeNull();
  });
  test("the demo's watermarks are widened and labelled", () => {
    expect(PRESSURE_DEFAULTS.scaleFactor).toBe(200);
    const r = runPressure();
    expect(r.marks.min).toBe(128);
    expect(Math.round(r.marks.low)).toBe(292);
    expect(Math.round(r.marks.high)).toBe(456);
  });
});

describe("OOM arithmetic", () => {
  const G = 262144;
  const P = (name: string, gib: number, pgt: number, adj: number): OomProc => ({ name, rssPages: gib * G, swapPages: 0, pgtablePages: pgt, adj });
  const procs = [P("postgres", 8, 8192, -900), P("java", 3.5, 3000, 0), P("sidecar", 0.25, 200, 0), P("batch", 2, 1000, 500), P("sshd", 0.01, 20, -1000)];
  const total = globalTotalPages(16 * G, 0);

  test("the worked example", () => {
    expect(Math.trunc(total / 1000)).toBe(4194);
    expect(oomBadness(procs[3]!, total)).toBe(2622288);
    expect(oomScore(procs[3]!, total)).toBe(1625);
    expect(oomScore(procs[0]!, total)).toBe(603);
    expect(oomScore(procs[1]!, total)).toBe(1219);
    expect(procs[pickVictim(procs, total)]!.name).toBe("batch");
    expect(lesson).toContain("2,622,288");
  });
  test("-1000 is never chosen, and its score is 0", () => {
    expect(oomBadness(procs[4]!, total)).toBeNull();
    expect(oomScore(procs[4]!, total)).toBe(0);
    expect(pickVictim([procs[4]!], total)).toBe(-1);
  });
  test("changing adj moves the victim, as the things to try say", () => {
    const b0 = procs.map((p) => (p.name === "batch" ? { ...p, adj: 0 } : p));
    expect(b0[pickVictim(b0, total)]!.name).toBe("java");
    const p0 = b0.map((p) => (p.name === "postgres" ? { ...p, adj: 0 } : p));
    expect(p0[pickVictim(p0, total)]!.name).toBe("postgres");
  });
  test("cgroup OOM: only tasks in the group, scored against the limit", () => {
    const pod = [procs[1]!, procs[2]!];
    expect(pod[pickVictim(pod, 4 * G)]!.name).toBe("java");
    expect(oomScore(procs[1]!, 4 * G)).toBe(1877);
  });
  test("oom_score is 1000 + badness * 1000 / totalpages", () => {
    for (const adj of [-999, -500, 0, 500, 1000]) for (const rss of [0, G, 16 * G]) {
      const p = { name: "x", rssPages: rss, swapPages: 0, pgtablePages: 0, adj };
      const s = oomScore(p, 16 * G);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBe(1000 + Math.trunc((oomBadness(p, 16 * G)! * 1000) / (16 * G)));
    }
  });
  test("kubelet values", () => {
    expect(k8sOomScoreAdj("guaranteed")).toBe(-997);
    expect(k8sOomScoreAdj("besteffort")).toBe(1000);
    expect(k8sOomScoreAdj("burstable", 2 ** 30, 16 * 2 ** 30)).toBe(938);
    expect(k8sOomScoreAdj("burstable", 16 * 2 ** 30, 16 * 2 ** 30)).toBe(2);
    expect(k8sOomScoreAdj("burstable", 1, 16 * 2 ** 30)).toBe(999);
  });
});

describe("overcommit", () => {
  test("mode 0 refuses only one request larger than RAM + swap", () => {
    expect(overcommitCheck(0, 20, 0, 16, 4).ok).toBe(true);
    expect(overcommitCheck(0, 21, 0, 16, 4).ok).toBe(false);
    expect(overcommitCheck(0, 20, 500, 16, 4).ok).toBe(true);
  });
  test("mode 1 never refuses; a full touch then runs out of memory", () => {
    expect(overcommitCheck(1, 40, 0, 16, 4).ok).toBe(true);
    expect(touchOutcome(40, 16, 4)).toBe("oom");
    expect(touchOutcome(18, 16, 4)).toBe("swap");
    expect(touchOutcome(10, 16, 4)).toBe("ok");
  });
  test("mode 2: CommitLimit = 12 GiB at ratio 50", () => {
    expect(commitLimit(16, 4, 50)).toBe(12);
    expect(overcommitCheck(2, 12, 0, 16, 4).ok).toBe(true);
    expect(overcommitCheck(2, 13, 0, 16, 4).ok).toBe(false);
    expect(overcommitCheck(2, 11, 2, 16, 4).ok).toBe(false);
  });
});
