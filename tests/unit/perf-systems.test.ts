import { describe, expect, test } from "vitest";
import * as S from "@/sims/perf/systems";

// Numbers quoted in the systems-performance lessons.
describe("queueing", { timeout: 60000 }, () => {
  const q = (rho: number, c = 1, v: "random" | "fixed" = "random") => S.simulateQueue({ lambda: rho * c, service: 1, servers: c, variability: v, jobs: 300000 }, 5);
  test("M/M/1 mean response matches S/(1−ρ)", () => {
    for (const rho of [0.5, 0.8, 0.9]) expect(q(rho).meanResponse / S.mm1Response(1, rho)).toBeCloseTo(1, 1);
  });
  test("Little's law: L = λW", () => {
    const r = q(0.8);
    expect(r.meanInSystem / (r.throughput * r.meanResponse)).toBeCloseTo(1, 2);
  });
  test("fixed service times halve the queueing delay", () => {
    expect(q(0.9, 1, "fixed").meanResponse).toBeLessThan(q(0.9).meanResponse * 0.6);
  });
  test("pooling: one queue for 4 servers beats one server at the same load", () => {
    expect(q(0.9, 4).meanResponse).toBeLessThan(q(0.9).meanResponse / 3);
  });
});

describe("tail latency", { timeout: 60000 }, () => {
  test("fan-out to 100 backends makes most requests slow", () => {
    expect(S.fanout(100).slowShare).toBeCloseTo(1 - 0.99 ** 100, 1);
    expect(S.fanout(10).p99).toBeGreaterThan(10 * S.fanout(1).p99 / 2);
  });
  test("hedging after 30 ms cuts p99.9 for ~1% extra load", () => {
    const base = S.hedged(null), h = S.hedged(30);
    expect(base.p999).toBeGreaterThan(200);
    expect(h.p999).toBeLessThan(50);
    expect(h.extraLoad).toBeLessThan(0.02);
  });
});

describe("throughput, batching, I/O", () => {
  test("closed loop knee at (D + Z) / D users", () => {
    expect(S.closedLoop(11, 10, 100).throughput * 1000).toBeCloseTo(100, 0);
    expect(S.closedLoop(50, 10, 100).response).toBe(400);
  });
  test("batching trades latency for capacity", () => {
    expect(S.batching(1, 1, 0.05, 2).capacity).toBeLessThan(1);
    expect(S.batching(64, 1, 0.05, 2).capacity).toBeGreaterThan(15);
    expect(S.batching(64, 1, 0.05, 2).latency).toBeGreaterThan(15);
  });
  test("tiny reads are dominated by syscalls", () => {
    expect(S.bufferedRead(65536).gbps / S.bufferedRead(1).gbps).toBeGreaterThan(2000);
  });
  test("NVMe needs queue depth to reach its IOPS", () => {
    const nvme = S.DEVICES[2];
    expect(S.deviceIops(nvme, 1).iops).toBe(12500);
    expect(S.deviceIops(nvme, 128).iops).toBe(800000);
  });
});
