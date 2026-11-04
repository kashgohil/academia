import { describe, expect, test } from "vitest";
import { avgHops, links, coherenceMessages } from "@/sims/interconnect";
import { simulateNuma, NUMA_DEFAULTS, type Placement } from "@/sims/numa";

describe("interconnects", () => {
  test("average hops", () => {
    expect(avgHops("bus", 16)).toBe(1);
    expect(avgHops("ring", 16)).toBeCloseTo(4.27, 2); // ≈ n/4
    expect(avgHops("mesh", 16)).toBeCloseTo(2.67, 2); // 4×4: 2·(k²−1)/(3k) … ≈ 2k/3
    expect(avgHops("torus", 16)).toBeCloseTo(2.13, 2);
    expect(avgHops("mesh", 64)).toBeCloseTo(5.33, 2);
    expect(links("crossbar", 16)).toBe(256);
    expect(links("mesh", 16)).toBe(24);
  });
  test("snooping grows with cores; directory tracks actual sharers", () => {
    for (const n of [4, 16, 64]) {
      const priv = coherenceMessages("private", n);
      expect(priv.snoopLookups).toBe(n - 1);
      expect(priv.directory).toBeLessThan(3);
    }
    expect(coherenceMessages("broadcast", 64).directory).toBeLessThan(coherenceMessages("broadcast", 64).snoopLookups / 10);
  });
});

describe("numa", () => {
  const run = (placement: Placement, sockets: number, threads: number) => simulateNuma({ ...NUMA_DEFAULTS, sockets, threads, placement });
  test("serial first touch caps bandwidth at one node", () => {
    expect(run("serial-first-touch", 2, 16).gbps).toBe(60);
    expect(run("serial-first-touch", 4, 32).gbps).toBe(60);
    expect(run("parallel-first-touch", 2, 16).gbps).toBe(120);
    expect(run("parallel-first-touch", 4, 32).gbps).toBe(240);
  });
  test("interleave matches bandwidth when links suffice, but pays in latency", () => {
    const il = run("interleave", 4, 32);
    expect(il.gbps).toBe(240);
    expect(run("serial-first-touch", 2, 16).bottleneck).toBe("memory controller");
    expect(il.latency).toBeCloseTo(135, 0);
    expect(run("parallel-first-touch", 4, 32).latency).toBe(90);
  });
});
