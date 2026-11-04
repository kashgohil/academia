import { describe, expect, test } from "vitest";
import { Coherence, WORKLOADS, runWorkload, type Protocol } from "@/sims/coherence";
import { mulberry32 } from "@/sims/rng";

const PROTOCOLS: Protocol[] = ["MSI", "MESI", "MOESI"];
const wl = (id: string) => WORKLOADS.find((w) => w.id === id)!.gen(4);

describe("coherence invariants", () => {
  test("random accesses keep single-writer/multiple-reader and every read returns the latest write", () => {
    for (const p of PROTOCOLS) {
      const r = mulberry32(7);
      const c = new Coherence(4, 3, p);
      const latest = new Map<number, number>();
      for (let i = 0; i < 4000; i++) {
        const core = Math.floor(r() * 4), addr = Math.floor(r() * 6);
        if (r() < 0.4) { c.write(core, addr, i); latest.set(addr, i); }
        else expect(c.read(core, addr), `${p} step ${i}`).toBe(latest.get(addr) ?? 0);
        expect(c.check(), `${p} step ${i}`).toBeNull();
      }
    }
  });
});

// Numbers quoted in the multicore lessons.
describe("protocol comparisons (4 cores)", () => {
  test("MESI's E state removes upgrades for private read-then-write", () => {
    expect(runWorkload(wl("private"), 4, "MSI").busTransactions).toBe(32);
    expect(runWorkload(wl("private"), 4, "MESI").busTransactions).toBe(16);
  });
  test("MOESI avoids memory traffic for producer/consumer sharing", () => {
    const mesi = runWorkload(wl("producer-consumer"), 4, "MESI").c;
    const moesi = runWorkload(wl("producer-consumer"), 4, "MOESI").c;
    expect([mesi.memWrites, moesi.memWrites]).toEqual([8, 0]);
    expect(moesi.memReads).toBe(1);
  });
  test("false sharing vs padding", () => {
    const fs = runWorkload(wl("false-sharing"), 4, "MESI");
    const pad = runWorkload(wl("padded"), 4, "MESI");
    expect(fs.busTransactions).toBe(63);
    expect(pad.busTransactions).toBe(4);
    expect(fs.c.cycles / pad.c.cycles).toBeGreaterThan(3.5);
  });
  test("MESI walkthrough", () => {
    const c = new Coherence(2, 4, "MESI");
    c.read(0, 0);
    expect(c.state(0, 0)).toBe("E");
    c.write(0, 0, 5);
    expect(c.state(0, 0)).toBe("M");
    expect(c.busTransactions).toBe(1);
    expect(c.read(1, 0)).toBe(5);
    expect([c.state(0, 0), c.state(1, 0), c.memValue(0)]).toEqual(["S", "S", 5]);
  });
});
