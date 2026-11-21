/** Every number that the ooo lessons quote, computed by the out-of-order core. All latencies are model inputs. */
import { describe, expect, test } from "vitest";
import { assemble, Hart, BRANCHY_THRESHOLD, BRANCHY_VALUES } from "../../src/sims/arch/rv";
import {
  aliasLoopExpect, aliasLoopRun, aliasLoopSource, aliasRun, asmOf, branchMissSource, cdbRun, DEFAULT_CONFIG, faultRun, MEM_DEPS,
  missRingRun, missRun, probeLines, windowNeeded, windowAllRight, spectreRun, squaresExpect, squaresRun, squaresSource, tomasuloRun, windowRun,
} from "../../src/sims/arch/ooo";

describe("lesson programs are correct on the hart", () => {
  test("squares", () => { const h = new Hart(asmOf(squaresSource())); h.run(); expect(h.exitCode).toBe(squaresExpect()); expect(squaresExpect()).toBe(285); });
  test("alias loop", () => {
    for (const e of [0, 8, 1]) { const h = new Hart(asmOf(aliasLoopSource(24, e))); h.run(); expect(h.exitCode).toBe(aliasLoopExpect(24, e)); }
  });
  test("branch-miss count", () => {
    const h = new Hart(asmOf(branchMissSource(BRANCHY_VALUES, BRANCHY_THRESHOLD))); h.run();
    expect(h.exitCode).toBe(BRANCHY_VALUES.filter((v) => v > BRANCHY_THRESHOLD).length);
  });
  test("every lesson run commits without errors", () => {
    for (const r of [squaresRun("none"), squaresRun(33), tomasuloRun(), cdbRun(1), missRun(16), missRun(64, 100, true), aliasLoopRun(1, "speculative"), spectreRun(11, "none"), windowRun("two-bit", 64)]) {
      expect(r.errors).toEqual([]);
      expect(r.status).toBe("exited");
    }
  });
});

describe("model inputs", () => {
  test("defaults the lessons name", () => {
    expect(DEFAULT_CONFIG.width).toBe(4);
    expect(DEFAULT_CONFIG.robSize).toBe(64);
    expect(DEFAULT_CONFIG.frontDepth).toBe(3);
    expect(DEFAULT_CONFIG.lat).toMatchObject({ alu: 1, mul: 3, div: 20, hit: 4, miss: 100 });
  });
});

describe("register renaming", () => {
  test("no renaming vs renaming, and the register-file sweep", () => {
    const cyc = (p: number | "none") => squaresRun(p).cycles;
    expect(squaresRun(128).stats.committed).toBe(78);
    expect(cyc("none")).toBe(77);
    expect(cyc(33)).toBe(227);
    expect(cyc(36)).toBe(94);
    expect(cyc(40)).toBe(64);
    expect(cyc(48)).toBe(45);
    expect(cyc(64)).toBe(38);
    expect(cyc(128)).toBe(38);
    expect(squaresRun("none").ipc.toFixed(2)).toBe("1.01");
    expect(squaresRun(64).ipc.toFixed(2)).toBe("2.05");
    expect(squaresRun(33).ipc.toFixed(2)).toBe("0.34");
  });
  test("one-wide stepper: the two loads of t3 get p36 and p39", () => {
    const r = squaresRun(40, { width: 1, record: true });
    const at = (c: number) => r.frames[c]!.renamed.map((id) => r.uops.find((u) => u.id === id)!);
    expect(at(7).map((u) => [u.text, u.pd])).toEqual([["lw t3, 0(t0)", 36]]);
    expect(at(10).map((u) => [u.text, u.pd])).toEqual([["lw t3, 4(t0)", 39]]);
  });
  test("one-wide stepper", () => {
    expect(squaresRun(33, { width: 1 }).stats.renameStalls.regs).toBe(140);
    expect(squaresRun(36, { width: 1 }).stats.renameStalls.regs).toBe(24);
    expect(squaresRun(40, { width: 1 }).stats.renameStalls.regs).toBe(0);
  });
});

describe("Tomasulo", () => {
  test("the classic sequence", () => {
    const r = tomasuloRun();
    const u = (t: string) => r.uops.find((x) => x.text === t && x.squash < 0)!;
    expect(u("mul t0, a2, a4")).toMatchObject({ issue: 8, ready: 14 });
    expect(u("div t5, t0, a6")).toMatchObject({ rename: 8, issue: 14, ready: 26 });
    expect(u("add a6, t3, a2")).toMatchObject({ issue: 10, ready: 11 });
    expect(u("add a6, t3, a2").pd).not.toBe(u("lw a6, 32(a0)").pd);
  });
  test("result buses", () => {
    expect([1, 2, 4].map((b) => cdbRun(b).cycles)).toEqual([72, 39, 23]);
    expect(cdbRun(1).stats.committed).toBe(67);
  });
});

describe("reorder buffer", () => {
  test("the ring", () => {
    const r = missRingRun(16);
    expect(r.cycles).toBe(188);
    expect(r.frames.filter((f) => f.stall === "ROB full").length).toBe(158);
    expect(missRingRun(64).cycles).toBe(96);
  });
  test("window size vs independent and dependent misses", () => {
    expect([16, 32, 64, 128, 256].map((s) => missRun(s).cycles)).toEqual([1252, 832, 435, 250, 179]);
    expect([16, 64, 256].map((s) => missRun(s, 100, true).cycles)).toEqual([2414, 2414, 2414]);
    expect(missRun(64).stats.committed).toBe(270);
  });
  test("Little's law and the speedup", () => {
    expect(windowNeeded(100, 4)).toBe(400);
    expect((missRun(16).cycles / missRun(256).cycles).toFixed(1)).toBe("7.0");
  });
  test("precise state at a fault", () => {
    const { r, found, pending, younger } = faultRun();
    expect(r.status).toBe("trap");
    expect(found).toBe(7);
    expect(pending.map((u) => u.text)).toEqual(["div t2, t0, t1"]);
    expect(younger.map((u) => u.text)).toEqual(["li s1, 2", "li s2, 3", "li s3, 4", "li s4, 5", "li a7, 93"]);
    expect(r.regs[9]).toBe(0); // s1 never written: younger work is discarded
    expect(r.regs[7]).toBe(14); // t2 = 100 / 7: older work completes
  });
});

describe("memory disambiguation", () => {
  const ld = (r: ReturnType<typeof aliasRun>) => r.uops.find((u) => u.cls === "load" && u.commit >= 0)!;
  test("one store and one load", () => {
    expect(ld(aliasRun(2, 1, true, "conservative")).ready).toBe(31);
    expect(ld(aliasRun(2, 1, true, "speculative")).ready).toBe(10);
    const v = aliasRun(2, 2, true, "speculative");
    expect(v.stats.violations).toBe(1);
    expect(v.uops.find((u) => u.cls === "load")!.value).toBe(12); // the stale value it read first
    expect(ld(v).ready).toBe(36);
    expect(ld(aliasRun(2, 2, true, "conservative")).fwd).not.toBeNull();
    const fast = aliasRun(2, 2, false, "speculative");
    expect(ld(fast).fwd).not.toBeNull();
    expect(ld(fast).ready).toBe(10);
    expect(ld(aliasRun(2, 2, false, "conservative")).ready).toBe(10);
    expect(ld(aliasRun(2, 2, true, "conservative")).ready).toBe(31);
  });
  test("the aliasing loop", () => {
    const t = (e: number) => MEM_DEPS.map((m) => { const r = aliasLoopRun(e, m); return [r.cycles, r.stats.violations]; });
    expect(t(0)).toEqual([[133, 0], [62, 0], [62, 0]]);
    expect(t(8)).toEqual([[133, 0], [88, 3], [74, 1]]);
    expect(t(1)).toEqual([[133, 0], [277, 24], [74, 1]]);
  });
});

describe("speculative execution", () => {
  test("the window and the predictor", () => {
    const ipc = (p: "perfect" | "two-bit", s: number) => windowRun(p, s).ipc.toFixed(2);
    expect([16, 64, 256].map((s) => ipc("perfect", s))).toEqual(["0.19", "0.59", "1.39"]);
    expect([16, 64, 256].map((s) => ipc("two-bit", s))).toEqual(["0.18", "0.45", "0.72"]);
    const r = windowRun("two-bit", 64);
    expect([r.stats.mispredicts, r.stats.branches, r.stats.committed]).toEqual([17, 64, 312]);
  });
  test("wrong-path work and the all-right chance", () => {
    expect(windowRun("two-bit", 64).stats.wrongPath).toBe(686);
    expect(windowAllRight(0.95, 64, 5).toFixed(2)).toBe("0.52");
    expect(windowAllRight(0.99, 64, 5).toFixed(2)).toBe("0.88");
    expect(windowAllRight(0.95, 256, 5).toFixed(2)).toBe("0.07");
  });
  test("Spectre v1: which wrong-path loads issue in the third call", () => {
    const wrongLoads = (m: "none" | "fence" | "mask") => {
      const r = spectreRun(11, m);
      const start = r.uops.find((u) => u.text === "li a0, 40" && !u.wrong)!;
      return r.uops.filter((u) => u.id > start.id && u.wrong && u.cls === "load" && u.issue >= 0).map((u) => u.addr);
    };
    expect(wrongLoads("none")).toEqual([0x1068, 0x1080 + 11 * 64]); // the secret, then probe line 11
    expect(wrongLoads("fence")).toEqual([]);
    expect(wrongLoads("mask")).toEqual([]);
    expect([spectreRun(11, "none").cycles, spectreRun(11, "fence").cycles]).toEqual([232, 434]);
  });
  test("Spectre v1 footprint", () => {
    expect(probeLines(spectreRun(11, "none").lines)).toEqual([0, 11]);
    expect(probeLines(spectreRun(5, "none").lines)).toEqual([0, 5]);
    expect(probeLines(spectreRun(11, "fence").lines)).toEqual([0]);
    expect(probeLines(spectreRun(11, "mask").lines)).toEqual([0]);
    // The committed registers do not depend on the secret: only the cache does.
    expect(spectreRun(11, "none").regs).toEqual(spectreRun(5, "none").regs);
  });
  test("the assembler accepts every lesson program", () => {
    expect(assemble(squaresSource()).ok).toBe(true);
  });
});
