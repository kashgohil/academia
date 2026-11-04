/** Spinlocks on the MESI simulator, and the spin-versus-block model. */
import { describe, expect, test } from "vitest";
import { SPIN_ALGOS, SPIN_SWEEP_ACQ, simulateSpin, spinBlockCost, spinBlockCrossover, spinSweep, type SpinAlgo } from "../../src/sims/os/sync";

const at = (algo: SpinAlgo, cores: number, cs = 300, work = 300) => simulateSpin({ algo, cores, cs, work, acquisitions: SPIN_SWEEP_ACQ });

describe("spinlock race: mutual exclusion and order", () => {
  test("the race is deterministic for a seed", () => {
    expect(at("tas", 8)).toEqual(at("tas", 8));
  });
  test("ticket and MCS take turns: a core gets the lock again within 2n handoffs", () => {
    for (const a of ["ticket", "mcs"] as SpinAlgo[]) {
      const order = at(a, 8).order;
      const last = new Map<number, number>();
      order.forEach((c, i) => {
        if (last.has(c)) expect(i - last.get(c)!).toBeLessThanOrEqual(16);
        last.set(c, i);
      });
      expect(at(a, 8).maxBypass).toBeLessThanOrEqual(16);
    }
  });
  test("every algorithm completes the acquisitions for every core count", () => {
    for (const a of SPIN_ALGOS) for (const r of spinSweep(a)) expect(r.acquisitions).toBe(SPIN_SWEEP_ACQ);
  });
});

describe("spinlock race: quoted numbers", () => {
  test("16 cores, 300-cycle section and 300-cycle work", () => {
    expect(at("tas", 16).busPerAcq).toBeCloseTo(24.5, 1);
    expect(at("ticket", 16).busPerAcq).toBeCloseTo(19.1, 1);
    expect(at("mcs", 16).busPerAcq).toBeCloseTo(6.0, 5);
    expect(Math.round(at("mcs", 16).cyclesPerAcq)).toBe(444);
    expect(Math.round(at("ticket", 16).cyclesPerAcq)).toBe(1716);
  });
  test("MCS traffic does not grow with cores", () => {
    for (const n of [4, 8, 16, 32]) expect(at("mcs", n).busPerAcq).toBeCloseTo(6, 5);
  });
  test("ticket traffic grows with cores", () => {
    expect(at("ticket", 32).busPerAcq).toBeGreaterThan(2 * at("ticket", 8).busPerAcq);
  });
  test("ticket is slower than TTAS at 32 cores: 3380 against 2904 cycles", () => {
    expect(Math.round(at("ticket", 32).cyclesPerAcq)).toBe(3380);
    expect(Math.round(at("ttas", 32).cyclesPerAcq)).toBe(2904);
  });
  test("fairness at 32 cores", () => {
    expect(at("ticket", 32).jain.toFixed(2)).toBe("1.00");
    expect(at("mcs", 32).jain.toFixed(2)).toBe("1.00");
    expect(at("tas", 32).jain).toBeLessThan(0.9);
    expect(at("ttas", 32).jain).toBeLessThan(0.9);
    expect(at("backoff", 32).jain).toBeLessThan(0.9);
    expect(at("tas", 32).maxBypass).toBeGreaterThan(at("ticket", 32).maxBypass * 3);
  });
  test("long critical section at 4 cores: TAS 79.7 and TTAS 7.2", () => {
    expect(at("tas", 4, 3000).busPerAcq).toBeCloseTo(79.7, 1);
    expect(at("ttas", 4, 3000).busPerAcq).toBeCloseTo(7.2, 1);
  });
});

describe("spin or block", () => {
  const base = { threads: 8, cores: 16, switchNs: 2000, sliceNs: 4_000_000 };
  test("8 threads and 100 ns: spin wastes 350 ns, and block wastes 4000 ns", () => {
    const r = spinBlockCost({ ...base, cs: 100 });
    expect(r.spin).toBe(350);
    expect(r.block).toBe(4000);
  });
  test("the crossover is about 1143 ns with 8 threads, and 127 ns with 64", () => {
    expect(Math.round(spinBlockCrossover(8, 2000))).toBe(1143);
    expect(Math.round(spinBlockCrossover(64, 2000))).toBe(127);
    const c = spinBlockCrossover(8, 2000);
    const r = spinBlockCost({ ...base, cs: c });
    expect(r.spin).toBeCloseTo(r.block, 6);
  });
  test("oversubscription: spin jumps above 1 ms", () => {
    expect(spinBlockCost({ ...base, threads: 32, cores: 16, cs: 100 }).spin).toBeGreaterThan(1e6);
  });
  test("adaptive is never worse than twice the better choice", () => {
    for (const threads of [2, 8, 32, 64]) for (const cores of [1, 4, 16, 64]) for (const cs of [10, 100, 1000, 1e4, 1e5]) for (const switchNs of [500, 2000, 20000]) {
      const r = spinBlockCost({ cs, threads, cores, switchNs, sliceNs: 4e6 });
      expect(r.adaptive).toBeLessThanOrEqual(2 * r.best + 1e-9);
    }
  });
});
