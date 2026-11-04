/** RCU: no version is freed while a reader holds it, and the read scaling numbers. */
import { describe, expect, test } from "vitest";
import { GHZ as PERF_GHZ } from "../../src/sims/perf/contention";
import { GHZ, LAT, RCU_SETUP_SCRIPT, explore, rcuActions, rcuApply, rcuInit, rcuModel, readScale, readSweep } from "../../src/sims/os/sync";

describe("RCU model", () => {
  test("RCU never frees a version that a reader holds: 3 CPUs, every order of actions", () => {
    const r = explore(rcuModel({ cpus: 3 }));
    expect(r.states).toBe(14314);
    expect(r.truncated).toBe(false);
    expect(r.violation).toBeNull();
  });
  test("more versions and more read sections with 2 CPUs", () => {
    const r = explore(rcuModel({ cpus: 2, maxVersions: 4, maxSections: 3 }));
    expect(r.truncated).toBe(false);
    expect(r.violation).toBeNull();
  });
  test("with no grace period, a use after free takes 3 steps", () => {
    const r = explore(rcuModel({ cpus: 3, broken: true }));
    expect(r.violation?.schedule.length).toBe(3);
    expect(r.violation?.message).toContain("Use after free");
  });
  test("the setup script is legal, and leaves CPU 0 holding up the grace period", () => {
    let s = rcuInit(3);
    for (const a of RCU_SETUP_SCRIPT) {
      expect(rcuActions(s, { cpus: 3 }).map((x) => JSON.stringify(x))).toContain(JSON.stringify(a));
      s = rcuApply(s, a);
    }
    expect(s.pending).toEqual([0]);
    expect(s.cpus[1]!.holds).toBe(2);
  });
  test("a reader holds its version across a publish", () => {
    let s = rcuInit(2);
    s = rcuApply(s, { kind: "enter", cpu: 0 });
    s = rcuApply(s, { kind: "publish" });
    expect(s.ptr).toBe(2);
    expect(s.cpus[0]!.holds).toBe(1);
    s = rcuApply(s, { kind: "enter", cpu: 1 });
    expect(s.cpus[1]!.holds).toBe(2);
  });
  test("a CPU in a read section cannot report a quiescent state, so the grace period waits", () => {
    let s = rcuInit(2);
    const o = { cpus: 2 };
    s = rcuApply(s, { kind: "enter", cpu: 0 });
    s = rcuApply(s, { kind: "publish" });
    s = rcuApply(s, { kind: "startGp" });
    expect(rcuActions(s, o).some((a) => a.kind === "qs" && a.cpu === 0)).toBe(false);
    s = rcuApply(s, { kind: "qs", cpu: 1 });
    expect(s.completed).toBe(0);
    expect(rcuActions(s, o).some((a) => a.kind === "free")).toBe(false);
    s = rcuApply(s, { kind: "exit", cpu: 0 });
    s = rcuApply(s, { kind: "qs", cpu: 0 });
    expect(s.completed).toBe(1);
    expect(rcuActions(s, o).some((a) => a.kind === "free" && a.id === 1)).toBe(true);
  });
  test("a version retired during a grace period needs the next one", () => {
    let s = rcuInit(1);
    s = rcuApply(s, { kind: "publish" });
    s = rcuApply(s, { kind: "startGp" });
    s = rcuApply(s, { kind: "publish" });
    s = rcuApply(s, { kind: "qs", cpu: 0 });
    const acts = rcuActions(s, { cpus: 1 });
    expect(acts.some((a) => a.kind === "free" && a.id === 1)).toBe(true);
    expect(acts.some((a) => a.kind === "free" && a.id === 2)).toBe(false);
    expect(acts.some((a) => a.kind === "startGp")).toBe(true);
  });
});

describe("read scaling: quoted numbers", () => {
  const m = (r: { mReadsPerSec: number }) => r.mReadsPerSec.toFixed(1);
  test("64 cores with a 100-cycle read section", () => {
    const rcu = readScale("rcu", 64);
    const rw = readScale("rwlock", 64);
    expect(Math.round(rcu.mReadsPerSec)).toBe(1548);
    expect(m(rw)).toBe("37.7");
    expect(Math.round(rcu.mReadsPerSec / rw.mReadsPerSec)).toBe(41);
    expect(rw.busPerRead.toFixed(2)).toBe("1.99");
    expect(rcu.busPerRead.toFixed(2)).toBe("0.00");
  });
  test("the clock model input matches the performance track", () => {
    expect(GHZ).toBe(PERF_GHZ);
  });
  test("the reader-writer limit is 2 transfers per read", () => {
    expect((GHZ * 1000) / (2 * LAT.c2c)).toBeCloseTo(37.5, 6);
    expect(readScale("rwlock", 16).mReadsPerSec).toBeCloseTo(37.5, 0);
  });
  test("a long read section hides the cost until about 32 cores", () => {
    const rw = readSweep("rwlock", { readCycles: 2000 });
    const rcu = readSweep("rcu", { readCycles: 2000 });
    const at = (l: typeof rw, c: number) => l.find((x) => x.cores === c)!;
    expect(m(at(rw, 16))).toBe("22.7");
    expect(m(at(rcu, 16))).toBe("24.0");
    expect(at(rw, 64).mReadsPerSec).toBeLessThan(0.5 * at(rcu, 64).mReadsPerSec);
  });
  test("the mutex is lower than the reader-writer lock at many cores", () => {
    expect(readScale("mutex", 16).mReadsPerSec).toBeLessThan(readScale("rwlock", 16).mReadsPerSec);
  });
});
