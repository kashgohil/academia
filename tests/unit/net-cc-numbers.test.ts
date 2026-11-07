/**
 * Pins every number that the lessons congestion-control-reno-and-cubic, bbr and quic quote. Each comes from
 * src/sims/net/cc with the scenarios of scenarios.ts (model inputs).
 */
import { describe, expect, test } from "vitest";
import {
  BBR_LOSS_RATES, CUBIC_ALPHA, CcRun, Cubic, appenzellerBuffer, bbrLossScenario, bbrTimelineScenario, bdpPackets, bufferScenario, collapseRun,
  cubicK, fairScenario, holSummary, lossScenario, mathisLossFor, mathisMbps, migrationRun, operatingPoint, quicTransfer, renoFluidUtilisation,
  runScenario, sawScenario, setupRun, vsScenario, type BbrEvent,
} from "@/sims/net/cc";
import { serializationMs } from "@/sims/net";

const r1 = (x: number) => Number(x.toFixed(1));
const r2 = (x: number) => Number(x.toFixed(2));
const pc = (x: number, d = 1) => Number((x * 100).toFixed(d));

describe("congestion-control-reno-and-cubic", () => {
  test("collapse: 12 senders of 1986 keep the link 100% busy with 29% goodput and 6.1 copies; 1988 senders get 98%", () => {
    const old = collapseRun(12, "1986"), neu = collapseRun(12, "1988");
    expect(pc(old.busy, 0)).toBe(100);
    expect(pc(old.goodput, 0)).toBe(29);
    expect(r1(old.copies)).toBe(6.1);
    expect(old.meanQueueMs).toBeGreaterThan(1000);
    expect(pc(neu.goodput, 0)).toBe(98);
    expect(neu.meanQueueMs).toBeGreaterThan(850);
    expect(neu.meanQueueMs).toBeLessThan(950);
    // 96 packets in flight make an RTT of about 575 ms: (96 − BDP) × 6 ms + 100 ms.
    const rtt = (96 - bdpPackets(2, 100)) * serializationMs(1500, 2e6) + 100;
    expect(Math.abs(rtt - 575)).toBeLessThan(5);
  }, 20_000);

  test("collapse: 6 senders are fine, 8 fall to 29%", () => {
    expect(pc(collapseRun(6, "1986").goodput, 0)).toBe(100);
    expect(pc(collapseRun(8, "1986").goodput, 0)).toBe(29);
  });

  test("sawtooth: BDP 33 packets; Reno at 0.25, 1 and 4 BDP; CUBIC at 0.25 BDP; the fluid model", () => {
    const bdp = bdpPackets(10, 40);
    expect(Math.round(bdp)).toBe(33);
    const q = sawScenario("reno", 0.25).queue;
    expect(q).toBe(8);
    expect(Math.round(bdp + q)).toBe(41);
    expect(Math.round((bdp + q) / 2)).toBe(21);
    expect(pc(runScenario(sawScenario("reno", 0.25)).utilisation)).toBe(86.3);
    expect(pc(renoFluidUtilisation(bdp, q))).toBe(88.9);
    expect(pc(runScenario(sawScenario("reno", 1)).utilisation)).toBe(99.8);
    const deep = runScenario(sawScenario("reno", 4));
    expect(pc(deep.utilisation)).toBe(99.3);
    expect(r1(deep.meanQueueMs)).toBe(108.5);
    expect(pc(runScenario(sawScenario("cubic", 0.25)).utilisation)).toBe(97.3);
  });

  test("buffer sizing: 1 flow and 32 flows at 0.25 BDP, 1 flow at 0.1 BDP; Appenzeller", () => {
    expect(pc(runScenario(bufferScenario(1, 0.25)).utilisation)).toBe(90.8);
    expect(pc(runScenario(bufferScenario(32, 0.25)).utilisation)).toBe(98.5);
    expect(pc(runScenario(bufferScenario(1, 0.1)).utilisation)).toBe(50.1);
    expect(Math.round(appenzellerBuffer(500, 32))).toBe(88);
  }, 30_000);

  test("Mathis at 100 ms: 14.7 Mbit/s formula, Reno 14.0, CUBIC 28.3 at 0.01%; equal at 1%; 1 loss in 4.6 billion", () => {
    expect(r1(mathisMbps(1e-4, 100))).toBe(14.7);
    expect(r1(runScenario(lossScenario("reno", 1e-4, 100)).flows[0]!.goodputMbps)).toBe(14.0);
    expect(r1(runScenario(lossScenario("cubic", 1e-4, 100)).flows[0]!.goodputMbps)).toBe(28.3);
    const a = runScenario(lossScenario("reno", 1e-2, 100)).flows[0]!.goodputMbps, b = runScenario(lossScenario("cubic", 1e-2, 100)).flows[0]!.goodputMbps;
    expect(r1(a)).toBe(r1(b));
    expect(r1(a)).toBe(1.3);
    expect(r1(1 / mathisLossFor(10_000, 100) / 1e9)).toBe(4.6);
    expect(r2(Math.sqrt(3 / 4))).toBe(0.87);
    expect(r1(Math.sqrt(10))).toBe(3.2);
  }, 20_000);

  test("CUBIC: K = 4.22 s at W_max = 100; Reno needs 2.5 s at 50 ms and 10 s at 200 ms; α ≈ 0.53", () => {
    expect(r2(cubicK(100, 70))).toBe(4.22);
    expect((100 / 2) * 0.05).toBe(2.5);
    expect((100 / 2) * 0.2).toBe(10);
    expect(r2(CUBIC_ALPHA)).toBe(0.53);
    expect(new Cubic().fastConvergence).toBe(true);
  });

  test("RTT fairness: Reno 4.95 and CUBIC 3.42 at 4×; 2.31 and 1.75 at 2×; Jain 0.999 at equal RTTs", () => {
    const ratio = (cc: "reno" | "cubic", k: number) => {
      const r = runScenario(fairScenario(cc, k));
      return { ratio: r.flows[0]!.goodputMbps / r.flows[1]!.goodputMbps, r };
    };
    const reno4 = ratio("reno", 4);
    expect(r2(reno4.r.flows[0]!.goodputMbps)).toBe(8.21);
    expect(r2(reno4.r.flows[1]!.goodputMbps)).toBe(1.66);
    expect(r2(reno4.ratio)).toBe(4.95);
    expect(r2(ratio("cubic", 4).ratio)).toBe(3.42);
    expect(r2(ratio("reno", 2).ratio)).toBe(2.31);
    expect(r2(ratio("cubic", 2).ratio)).toBe(1.75);
    expect(Number(ratio("reno", 1).r.jain.toFixed(3))).toBe(0.999);
  }, 20_000);
});

describe("bbr", () => {
  test("operating points: 1, 2 and 4 BDP in flight with a 2 BDP buffer", () => {
    const bdp = bdpPackets(10, 40), q = Math.round(2 * bdp);
    const one = operatingPoint(10, 40, q, Math.round(bdp)), two = operatingPoint(10, 40, q, Math.round(2 * bdp)), four = operatingPoint(10, 40, q, Math.round(4 * bdp));
    expect([r2(one.mbps), r1(one.rttMs)]).toEqual([9.55, 41.7]);
    expect([r2(two.mbps), r1(two.rttMs)]).toEqual([10, 80.4]);
    expect(pc(four.retrans)).toBe(23.2);
  });

  const timeline = (ev: BbrEvent) => {
    const run = new CcRun(bbrTimelineScenario(ev));
    run.runTo(25_000);
    const changes: [number, string][] = [];
    let last = "";
    for (const s of run.samples) if (s.flows[0]!.state !== last) changes.push([s.t, (last = s.flows[0]!.state)]);
    return { run, changes };
  };

  test("timeline: Startup to 0.72 s, Drain to 0.82 s, ProbeRTT at 10.18 s (for 0.24 s) and 20.52 s, 10 drops in Startup", () => {
    const { run, changes } = timeline("none");
    expect(changes.slice(0, 5)).toEqual([[0, "Startup"], [720, "Drain"], [820, "ProbeBW"], [10180, "ProbeRTT"], [10420, "ProbeBW"]]);
    expect(changes[5]).toEqual([20520, "ProbeRTT"]);
    expect(run.result().drops).toBe(10);
    const early = new CcRun(bbrTimelineScenario("none")).runTo(1000).result();
    expect(early.drops).toBe(10);
  });

  test("timeline: after the RTT rises to 120 ms, RTprop stays 41.5 ms until ProbeRTT and the flow gets 6.5 Mbit/s", () => {
    const { run, changes } = timeline("rtt-up");
    expect(changes.find((c) => c[1] === "ProbeRTT")![0]).toBe(10180);
    const at = (t: number) => run.samples.find((s) => s.t >= t)!.flows[0]!;
    expect(r1(at(10_100).rtPropMs!)).toBe(41.5);
    const mid = run.samples.filter((s) => s.t >= 8500 && s.t < 10_000);
    expect(r1(mid.reduce((a, s) => a + s.flows[0]!.mbps, 0) / mid.length)).toBe(6.5);
  });

  test("timeline: after the rate rises to 20 Mbit/s, BtlBw reaches it within 0.6 s", () => {
    const { run } = timeline("rate-up");
    const t = run.samples.find((s) => s.t >= 8000 && (s.flows[0]!.btlBwMbps ?? 0) >= 19.99)!.t;
    expect(t - 8000).toBeLessThanOrEqual(600);
  });

  test("deep buffer (4 BDP): Reno 108.5 ms, CUBIC 92.1 ms, BBR 9.8 ms with no drops and 98.2%", () => {
    expect(r1(runScenario(sawScenario("reno", 4)).meanQueueMs)).toBe(108.5);
    expect(r1(runScenario(sawScenario("cubic", 4)).meanQueueMs)).toBe(92.1);
    const b = runScenario(sawScenario("bbr", 4));
    expect(r1(b.meanQueueMs)).toBe(9.8);
    expect(b.drops).toBe(0);
    expect(pc(b.utilisation)).toBe(98.2);
  });

  test("random loss: 1%, 10% and 20%", () => {
    const g = (cc: "bbr" | "cubic", p: number) => runScenario(bbrLossScenario(cc, p)).flows[0]!;
    expect(BBR_LOSS_RATES).toContain(0.01);
    expect(r1(g("cubic", 0.01).goodputMbps)).toBe(3.9);
    expect(r1(mathisMbps(0.01, 40))).toBe(3.7);
    expect(g("bbr", 0.01).goodputMbps).toBeGreaterThan(19);
    expect(r1(g("bbr", 0.1).goodputMbps)).toBe(10.2);
    expect(r2(g("cubic", 0.1).goodputMbps)).toBe(0.63);
    const b20 = g("bbr", 0.2);
    expect(r2(b20.goodputMbps)).toBe(1.45);
    expect(pc(b20.retransFrac, 0)).toBe(30);
  }, 20_000);

  test("BBR against CUBIC at 0.5, 2 and 8 BDP", () => {
    const half = runScenario(vsScenario(0.5));
    expect([r2(half.flows[0]!.goodputMbps), r2(half.flows[1]!.goodputMbps), pc(half.flows[1]!.retransFrac)]).toEqual([9.02, 0.76, 14.8]);
    const two = runScenario(vsScenario(2));
    expect([r2(two.flows[0]!.goodputMbps), r2(two.flows[1]!.goodputMbps)]).toEqual([5.36, 4.59]);
    const eight = runScenario(vsScenario(8));
    expect([r2(eight.flows[0]!.goodputMbps), r2(eight.flows[1]!.goodputMbps), Math.round(eight.meanQueueMs)]).toEqual([2.28, 7.56, 173]);
  }, 20_000);

  test("the BBR controller uses the tcp_bbr.c constants", async () => {
    const m = await import("@/sims/net/cc");
    expect(m.BBR_HIGH_GAIN).toBeCloseTo(2 / Math.LN2, 2);
    expect(m.BBR_PACING_GAINS).toEqual([1.25, 0.75, 1, 1, 1, 1, 1, 1]);
    expect([m.BBR_BW_ROUNDS, m.BBR_MIN_RTT_WIN_MS, m.BBR_PROBE_RTT_MS, m.BBR_MIN_CWND, m.BBR_FULL_BW_COUNT]).toEqual([10, 10_000, 200, 4, 3]);
  });
});

describe("quic", () => {
  test("head-of-line blocking: 21 chunks wait 29.2 ms with TCP, 5 wait 6.7 ms with QUIC", () => {
    const r = quicTransfer({ chunks: 24, rttMs: 40, mbps: 10, drop: [2] });
    const tcp = holSummary(r.arrival, 4, true), quic = holSummary(r.arrival, 4, false);
    expect([tcp.blocked, r1(tcp.meanWaitMs)]).toEqual([21, 29.2]);
    expect([quic.blocked, r1(quic.meanWaitMs)]).toEqual([5, 6.7]);
    expect(tcp.streamDone.map(r1)).toEqual([65.8, 65.8, 65.8, 65.8]);
    expect(quic.streamDone.map(r1)).toEqual([39.2, 40.2, 65.8, 42.1]);
  });

  test("loss detection: packet threshold at 48 ms, time threshold at 89 ms; a tail loss needs a PTO at 82.7 ms", () => {
    const r = quicTransfer({ chunks: 12, rttMs: 40, mbps: 10, gapMs: 1, drop: [3, 11] });
    const lost = r.packets.filter((p) => p.lostAt !== undefined).map((p) => [p.pn, r1(p.lostAt!), p.lostBy]);
    expect(lost).toEqual([[3, 48, "packet threshold"], [11, 89, "time threshold"]]);
    expect(r.packets[3]!.resentIn).toBe(12);
    const t = quicTransfer({ chunks: 12, rttMs: 40, mbps: 10, gapMs: 1, drop: [11] });
    expect(r1(t.events.find((e) => e.kind === "pto")!.t)).toBe(82.7);
    expect(r1(t.packets[11]!.lostAt!)).toBe(123.7);
  });

  test("handshakes at 50 ms: QUIC 101 ms, TCP + TLS 1.3 151 ms", () => {
    expect(Math.round(setupRun({ kind: "quic", rttMs: 50 }).firstByteMs)).toBe(101);
    expect(Math.round(setupRun({ kind: "tcp-tls13", rttMs: 50 }).firstByteMs)).toBe(151);
  });

  test("migration: no new data for 160 ms (TCP) and 110 ms (QUIC); done at 1,310 and 1,260 ms", () => {
    const tcp = migrationRun("tcp"), quic = migrationRun("quic");
    expect([tcp.stallMs, quic.stallMs]).toEqual([160, 110]);
    expect([tcp.doneMs, quic.doneMs]).toEqual([1310, 1260]);
  });
});
