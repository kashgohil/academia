import { describe, expect, test } from "vitest";
import { parse, runTso, runCxx, ParseError, type Result } from "@/sims/memmodel";
import { PRESETS } from "@/sims/memmodel/presets";

const run = (id: string) => {
  const p = parse(PRESETS[id]!.src);
  return { sc: runTso(p, false), tso: runTso(p, true), cxx: runCxx(p) };
};
/** Is there an outcome whose key contains every fragment? */
const has = (r: Result, ...frags: string[]) => r.outcomes.some((o) => frags.every((f) => o.key.includes(f)));
const racy = (r: Result) => r.outcomes.some((o) => o.racy);

describe("parser", () => {
  test("reports line numbers", () => {
    expect(() => parse("T0:\n  x.store(1, acquire)")).toThrow(ParseError);
    expect(() => parse("T0:\n  r0 = x.load(release)")).toThrow(/line 2/);
    expect(() => parse("T0:\n  r0 = x.load()\nT1:\n  r0 = y.load()")).toThrow(/assigned twice/);
  });
  test("defaults to seq_cst", () => {
    const p = parse("T0:\n  r0 = x.load()");
    expect(p.threads[0]![0]).toMatchObject({ op: "load", ord: "sc" });
  });
});

describe("classic litmus tests", () => {
  test("MP: relaxed allows stale data in C++ only; release/acquire forbids it", () => {
    const r = run("mp-relaxed");
    expect(has(r.cxx, "r0=1 r1=0")).toBe(true);
    expect(has(r.tso, "r0=1 r1=0")).toBe(false);
    expect(has(r.sc, "r0=1 r1=0")).toBe(false);
    expect(has(run("mp-relacq").cxx, "r0=1 r1=0")).toBe(false);
  });
  test("SB: both-zero allowed on TSO and C++ unless seq_cst", () => {
    for (const id of ["sb-relaxed", "sb-relacq"]) {
      const r = run(id);
      expect(has(r.tso, "r0=0 r1=0"), id).toBe(true);
      expect(has(r.cxx, "r0=0 r1=0"), id).toBe(true);
      expect(has(r.sc, "r0=0 r1=0"), id).toBe(false);
    }
    const sc = run("sb-sc");
    expect(has(sc.tso, "r0=0 r1=0") || has(sc.cxx, "r0=0 r1=0")).toBe(false);
  });
  test("IRIW: acquire readers may disagree in C++; seq_cst forbids it; TSO never allows it", () => {
    const w = ["r0=1 r1=0 r2=1 r3=0"];
    expect(has(run("iriw-acq").cxx, ...w)).toBe(true);
    expect(has(run("iriw-acq").tso, ...w)).toBe(false);
    expect(has(run("iriw-sc").cxx, ...w)).toBe(false);
  });
  test("CoRR: coherence holds for relaxed atomics", () => {
    const r = run("corr");
    for (const m of [r.sc, r.tso, r.cxx]) expect(has(m, "r0=2 r1=1")).toBe(false);
    expect(has(r.cxx, "r0=1 r1=2")).toBe(true);
  });
});

describe("atomicity and CAS", () => {
  test("lost updates", () => {
    expect(has(run("lost-update-plain").cxx, "count=1")).toBe(true);
    expect(racy(run("lost-update-plain").cxx)).toBe(true);
    expect(has(run("lost-update-atomic").cxx, "count=1")).toBe(true);
    expect(racy(run("lost-update-atomic").cxx)).toBe(false);
    const fa = run("fetch-add");
    for (const m of [fa.sc, fa.tso, fa.cxx]) expect(m.outcomes.every((o) => o.key.includes("count=2"))).toBe(true);
  });
  test("exactly one CAS wins", () => {
    for (const o of run("cas-race").cxx.outcomes) expect(o.regs.r0! + o.regs.r1!).toBe(1);
  });
  test("spinlock: acquire/release is race-free; relaxed is not", () => {
    const ok = run("spinlock").cxx;
    expect(racy(ok)).toBe(false);
    expect(ok.outcomes.every((o) => o.key.includes("count=2") && !o.hang)).toBe(true);
    expect(racy(run("spinlock-relaxed").cxx)).toBe(true);
  });
});

describe("fences and happens-before", () => {
  test("fences", () => {
    expect(has(run("mp-fences").cxx, "r0=1 r1=0")).toBe(false);
    expect(has(run("mp-one-fence").cxx, "r0=1 r1=0")).toBe(true);
    expect(has(run("sb-fence-sc").cxx, "r0=0 r1=0")).toBe(false);
    expect(has(run("sb-fence-sc").tso, "r0=0 r1=0")).toBe(false);
    expect(has(run("sb-fence-acqrel").cxx, "r0=0 r1=0")).toBe(true);
  });
  test("data races", () => {
    expect(racy(run("hb-race").cxx)).toBe(true);
    for (const id of ["hb-ok", "hb-chain", "hb-release-seq"]) {
      const r = run(id).cxx;
      expect(racy(r), id).toBe(false);
      expect(r.outcomes.filter((o) => !o.hang).every((o) => Object.values(o.regs).includes(42)), id).toBe(true);
    }
  });
  test("every preset explores fully", () => {
    for (const id of Object.keys(PRESETS)) {
      const r = run(id);
      expect(r.cxx.truncated || r.tso.truncated, id).toBe(false);
    }
  });
});

describe("CAS contention simulation", () => {
  test("one thread never fails; contention grows retries; backoff reduces them", async () => {
    const { simulateCas } = await import("@/sims/cas");
    expect(simulateCas(1, 200, false)).toBe(1);
    expect(simulateCas(8, 200, false)).toBeGreaterThan(1.5);
    expect(simulateCas(8, 200, true)).toBeLessThan(simulateCas(8, 200, false));
  });
});
