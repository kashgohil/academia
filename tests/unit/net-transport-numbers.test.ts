/** Every number that the transport lessons (udp, handshake, reliability, flow control) quote, computed by the sims. */
import { describe, expect, test } from "vitest";
import { bdpBytes } from "../../src/sims/net";
import {
  UDP_MAX_PAYLOAD_V4, arqRun, arqSweepPoint, backoffSchedule, checkCookie, firstResponseMs, handshakeRun, headerOverhead, holTcp, holUdp,
  jitterySamples, makeCookie, nagleRun, rtoSeries, slowReaderRun, sprayRun, synAckSchedule, synFloodRun, throughputRun, timeWaitConnRate,
  timeWaitRun, windowLimitedRate, windowShift,
} from "../../src/sims/net/transport";
import { mulberry32 } from "../../src/sims/rng";

describe("udp lesson", () => {
  test("largest UDP payload over IPv4", () => expect(UDP_MAX_PAYLOAD_V4).toBe(65_507));

  test("one query: 1 round trip over UDP, 2 over TCP (20 ms one-way)", () => {
    expect(Math.round(firstResponseMs("udp", 20).at)).toBe(40);
    expect(Math.round(firstResponseMs("tcp", 20).at)).toBe(80);
  });

  test("two paths: 7 in order, 4 late, 1 lost (the demo's defaults)", () => {
    const r = sprayRun({ count: 12, gap: 4, delayA: 5, delayB: 17, loss: 0.05, seed: 2 });
    expect([r.inOrder, r.late, r.lost]).toEqual([7, 4, 1]);
    expect(sprayRun({ count: 12, gap: 4, delayA: 5, delayB: 5, loss: 0, seed: 2 }).late).toBe(0);
    expect(sprayRun({ count: 12, gap: 20, delayA: 5, delayB: 17, loss: 0, seed: 2 }).late).toBe(0);
  });

  test("head-of-line blocking: 2% loss, 30 Hz, 30 ms", () => {
    const o = { hz: 30, size: 200, duration: 6000, delay: 30, loss: 0.02, seed: 1 };
    const u = holUdp(o), t = holTcp(o);
    expect(Math.round(u.p50)).toBe(30);
    expect(Math.round(u.max)).toBe(30);
    expect(u.lost).toBe(3);
    expect(t.lost).toBe(0);
    expect(Math.round(t.p99)).toBe(190);
    expect(Math.round(t.maxStale)).toBe(224);
    const none = holTcp({ ...o, loss: 0 });
    expect(Math.round(none.max)).toBe(30);
  });
});

describe("handshake lesson", () => {
  test("a lost SYN costs 1 s, a second one 2 s more (20 ms one-way)", () => {
    expect(Math.round(handshakeRun({ lostSyns: 1 }).connectedAt!)).toBe(1040);
    expect(Math.round(handshakeRun({ lostSyns: 2 }).connectedAt!)).toBe(3040);
  });

  test("simultaneous open uses four SYN segments", () => {
    const r = handshakeRun({ scenario: "simultaneous" });
    expect(r.net.trace.filter((e) => e.kind === "send" && e.pkt.payload.flags & 0x02).length).toBe(4);
  });

  test("tcp_synack_retries = 5: last SYN-ACK at 31 s, entry dropped at 63 s; tcp_retries2 = 15: 924.6 s", () => {
    const s = synAckSchedule();
    expect(s.sends).toEqual([0, 1000, 3000, 7000, 15000, 31000]);
    expect(s.giveUpAt).toBe(63_000);
    expect(backoffSchedule(200, 15, 120_000).giveUpAt).toBeCloseTo(924_600, 6);
  });

  test("SYN flood, 200 SYN/s against 128 entries: full in 0.64 s; 1 of 10 real connects without cookies, 10 of 10 with", () => {
    expect(128 / 200).toBe(0.64);
    const off = synFloodRun();
    expect(off.attempts.filter((a) => a.done !== undefined).length).toBe(1);
    expect(off.attempts.length).toBe(10);
    expect(off.halfOpen.find(([, n]) => n >= 128)![0]).toBe(700);
    const on = synFloodRun({ cookies: true });
    expect(on.attempts.filter((a) => a.done !== undefined).length).toBe(10);
    // A backlog of 1024 fills in about 5 s.
    const big = synFloodRun({ backlog: 1024 });
    expect(big.halfOpen.find(([, n]) => n >= 1024)![0]).toBe(5200);
  });

  test("the demo's cookie is rejected from 92 s on", () => {
    const c = makeCookie(100_000, 0x5eed, 7, 32800, 3, 80, 1460);
    expect(checkCookie(c.isn, 100_000 + 91_000, 0x5eed, 7, 32800, 3, 80)).toBe(1460);
    expect(checkCookie(c.isn, 100_000 + 92_000, 0x5eed, 7, 32800, 3, 80)).toBeUndefined();
  });

  test("TIME_WAIT: the old segment corrupts 1460 bytes without it; ~470 connections/s per client address with Linux defaults", () => {
    expect(timeWaitRun("oldDup", false).corrupted).toBe(1460);
    expect(Math.round(timeWaitConnRate())).toBe(471);
    expect(Math.floor(timeWaitConnRate())).toBe(470);
  });
});

describe("reliability lesson", () => {
  test("segment 3 of 12 lost, window 5", () => {
    const row = (p: "gbn" | "sr" | "tcp" | "sack") => {
      const r = arqRun({ proto: p, dropData: [3] });
      return [Math.round(r.doneAt), r.sends];
    };
    expect(row("gbn")).toEqual([425, 17]);
    expect(row("sr")).toEqual([353, 13]);
    expect(row("tcp")).toEqual([193, 13]);
    expect(row("sack")).toEqual([193, 13]);
  });

  test("losing one of the duplicate ACKs still leaves three", () => {
    const r = arqRun({ proto: "tcp", dropData: [3], dropAcks: [5] });
    expect(r.fastRetx).toBe(1);
    expect(r.timeouts).toBe(0);
  });

  test("segments 3, 5 and 7 lost: 286 ms without SACK, 246 ms with", () => {
    expect(Math.round(arqRun({ proto: "tcp", dropData: [3, 5, 7] }).doneAt)).toBe(286);
    expect(Math.round(arqRun({ proto: "sack", dropData: [3, 5, 7] }).doneAt)).toBe(246);
  });

  test("tail loss: segment 12 waits for the timer, 425 ms", () => {
    for (const p of ["tcp", "sack"] as const) {
      const r = arqRun({ proto: p, dropData: [12] });
      expect([Math.round(r.doneAt), r.timeouts]).toEqual([425, 1]);
    }
  });

  test("random loss at 10%: copies per segment and time for 60 segments", () => {
    const at = (p: "gbn" | "sr" | "tcp" | "sack") => arqSweepPoint(p, 0.1, 6, 60, 8);
    const g = at("gbn"), s = at("sr"), t = at("tcp"), k = at("sack");
    expect(g.sendsPerSeg.toFixed(2)).toBe("2.01");
    expect(s.sendsPerSeg.toFixed(2)).toBe("1.26");
    expect(t.sendsPerSeg.toFixed(2)).toBe("1.44");
    expect(k.sendsPerSeg.toFixed(2)).toBe("1.17");
    expect((g.ms / 1000).toFixed(1)).toBe("2.6");
    expect((k.ms / 1000).toFixed(1)).toBe("1.3");
  });

  test("RTO demo: 2 spurious timeouts with a 200 ms floor, none with 1 s; RTO sits on the floor", () => {
    const run = (min: number, jitter = 10, spike = 40, size = 250, base = 50) =>
      rtoSeries(jitterySamples(120, base, jitter, spike, size, mulberry32(7)), { initialRto: 1000, minRto: min, maxRto: 120_000, granularity: 1 });
    const spurious = (s: ReturnType<typeof run>) => s.filter((x) => x.spurious && x.i > 0).length;
    expect(spurious(run(200))).toBe(2);
    expect(spurious(run(1000))).toBe(0);
    const calm = run(200, 10, 0, 0);
    const last = calm[calm.length - 1]!;
    expect(last.srtt + 4 * last.rttvar).toBeLessThan(80);
    expect(last.srtt + 4 * last.rttvar).toBeGreaterThan(60);
    expect(last.rto).toBe(200);
    const wide = run(200, 40, 0, 0);
    expect(Math.round(wide[wide.length - 1]!.rttvar)).toBe(20);
    const far = run(200, 10, 0, 0, 300);
    expect(far[far.length - 1]!.rto).toBeGreaterThan(300);
  });
});

describe("flow-control lesson", () => {
  test("slow reader: 772 ms at zero window, 2 probes, read by 1730 ms; with lost updates 3 probes and 2330 ms", () => {
    const a = slowReaderRun();
    expect([Math.round(a.zeroMs), a.probes, Math.round(a.doneAt)]).toEqual([772, 2, 1730]);
    const b = slowReaderRun({ loseUpdate: true });
    expect([b.probes, Math.round(b.doneAt)]).toEqual([3, 2330]);
    expect(Math.round(b.probeTimes[2]! - b.probeTimes[1]!)).toBe(800);
    expect(slowReaderRun({ rcvBuf: 16384, readRate: 1000, pauseTo: 0 }).zeroMs).toBe(0);
  });

  test("64 KiB at 100 ms: 5.24 Mbit/s by formula, 5.14 measured; BDP 1.25 MB", () => {
    expect(windowLimitedRate(65535, 100, 100e6) / 1e6).toBeCloseTo(5.2428, 4);
    expect(bdpBytes(100e6, 100)).toBe(1_250_000);
    expect((throughputRun().steady / 1e6).toFixed(2)).toBe("5.14");
    expect(windowLimitedRate(65535, 10, 100e6) / windowLimitedRate(65535, 100, 100e6)).toBeCloseTo(10);
  }, 20_000);

  test("4 MiB with scaling reaches 97 Mbit/s; autotuning stops near 2 × BDP (2.32 MiB) with shift 7", () => {
    expect(Math.round(throughputRun({ rcvBuf: 4 << 20, rcvBufMax: 4 << 20, windowScaling: true }).steady / 1e6)).toBe(97);
    const a = throughputRun({ rcvBuf: 65536, rcvBufMax: 6 << 20, windowScaling: true, autotune: true, duration: 1500 });
    expect((a.bufSeries[a.bufSeries.length - 1]![1] / 1048576).toFixed(2)).toBe("2.32");
    expect(a.wscale).toBe(7);
  }, 20_000);

  test("window scale shifts for Linux tcp_rmem maxima: 6 MiB → 7, 32 MiB → 10", () => {
    expect(windowShift(6 * 1024 * 1024)).toBe(7);
    expect(windowShift(32 * 1024 * 1024)).toBe(10);
  });

  test("silly window syndrome with 50-byte reads: 443 segments, 68 B mean, 37.1% headers; 21 segments and 2.7% with avoidance", () => {
    const run = (sws: boolean) => slowReaderRun({ rcvBuf: 8192, readRate: 100, chunk: 50, total: 30_000, pauseTo: 0, swsAvoid: sws, nagle: false, duration: 600 });
    const off = run(false), on = run(true);
    expect(off.segSizes.length).toBe(443);
    expect(Math.round(off.segSizes.reduce((a, b) => a + b, 0) / off.segSizes.length)).toBe(68);
    expect((headerOverhead(off.segSizes) * 100).toFixed(1)).toBe("37.1");
    expect(on.segSizes.length).toBe(21);
    expect((headerOverhead(on.segSizes) * 100).toFixed(1)).toBe("2.7");
  });

  test("Nagle and delayed ACK: 60/50 ms at 40 ms, 210 ms at 200 ms, 20 ms without delayed ACK, 10 ms with TCP_NODELAY", () => {
    const lat = (nagle: boolean, delayedAck: number) => nagleRun({ nagle, delayedAck }).latencies.map((x) => Math.round(x));
    expect(lat(true, 40)).toEqual([60, 50, 50]);
    expect(lat(true, 200)).toEqual([220, 210, 210]);
    expect(lat(true, 0)).toEqual([20, 20, 20]);
    expect(lat(false, 40)).toEqual([10, 10, 10]);
  });
});
