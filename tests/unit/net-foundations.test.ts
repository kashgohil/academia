/** Networking, Foundations: the models behind the three lessons, and every number that the lessons quote. */
import { describe, expect, test } from "vitest";
import { bdpBytes, crc32, internetChecksum, serializationMs } from "@/sims/net";
import {
  BDP_EXAMPLES, DEFAULT_FRAME, ETH_MIN_FRAME, HOL_LIMIT, TCP_WINDOW_MAX_SCALED, TCP_WINDOW_UNSCALED, TUNNELS,
  bestPktData, buildFrame, chainHops, city, corruptionRun, crossPath, crossoverBytes, cutThroughMs, examplePath, fcsOk, fiberKmPerMs,
  fiberRttMs, fiberUsPerKm, flipBit, fragmentIpv4, fragmentIpv6, geoAltitudeKm, geoRttMs, goodput, greatCircleKm, holBlocked, holInit,
  holStep, holThroughput, optimalPktData, maxPacketRate, maxUsers, md1WaitMs, mm1WaitMs, mss, oneBigPacketMs, overflowProb, packetCount, pathBreakdown,
  pathRun, pipelineRun, queueRun, receive, shareRun, slowStartRounds, storeForwardMs, swapWords, totalMs, transferMs, tunnelMtu,
  vacuumRttMs, windowLimitBps, windowRun, wireCost,
} from "@/sims/net/foundations";
import { mulberry32 } from "@/sims/rng";

// ============================================================================ layers and encapsulation

describe("encapsulation on real bytes", () => {
  const b = buildFrame();

  test("sizes of each layer for the example GET /index.html", () => {
    expect(b.app.length).toBe(60);
    expect(b.segment.length).toBe(80);
    expect(b.packet.length).toBe(100);
    expect(b.frame.length).toBe(118);
    expect(b.padding).toBe(0);
    // On the wire: + 8 preamble/SFD + 12 interframe gap = 138; the HTTP share is 43.5%.
    expect(b.frame.length + 20).toBe(138);
    expect(b.app.length / 138).toBeCloseTo(0.435, 3);
    expect(buildFrame({ timestamps: true }).frame.length).toBe(130);
    // The short path "/": still more than half of the frame is headers.
    const short = buildFrame({ path: "/" });
    expect(short.app.length).toBe(50);
    expect(short.frame.length - short.app.length).toBeGreaterThan(short.app.length);
  });

  test("the header bytes are where the standards put them", () => {
    const f = b.frame;
    expect([f[12], f[13]]).toEqual([0x08, 0x00]); // EtherType IPv4
    expect(f[14]).toBe(0x45); // version 4, IHL 5
    expect(f[22]).toBe(64); // TTL
    expect(f[23]).toBe(6); // protocol TCP
    expect((f[36]! << 8) | f[37]!).toBe(80); // destination port
    expect(f[46]! >> 4).toBe(5); // data offset: 20 bytes
    expect(String.fromCharCode(...f.subarray(54, 57))).toBe("GET");
  });

  test("checksums: the IPv4 header sums to zero, the FCS has the CRC-32 residue", () => {
    expect(internetChecksum(b.packet.subarray(0, 20))).toBe(0);
    expect(fcsOk(b.frame)).toBe(true);
    expect(crc32(b.frame)).toBe(0x2144df1c); // CRC over frame + FCS is a constant
    expect(receive(b.frame).droppedAt).toBeUndefined();
    expect(receive(b.frame).app).toEqual(b.app);
  });

  test("a small payload is padded to the 64-byte minimum frame", () => {
    expect(wireCost(1).frame).toBe(ETH_MIN_FRAME);
    expect(wireCost(1).pad).toBe(5);
    expect(wireCost(1).wire).toBe(84);
    expect(wireCost(1).efficiency).toBeCloseTo(0.0119, 4);
  });

  test("full-size frames: 1460-byte MSS, 1518-byte frame, 94.9% (94.1% with timestamps)", () => {
    expect(mss()).toBe(1460);
    expect(wireCost(1460).frame).toBe(1518);
    expect(wireCost(1460).wire).toBe(1538);
    expect(wireCost(1460).efficiency).toBeCloseTo(0.9493, 4);
    expect(wireCost(1448, { tcpOptions: 12 }).efficiency).toBeCloseTo(0.9415, 4);
    expect(goodput(10e9, 1460) / 1e9).toBeCloseTo(9.49, 2);
  });

  test("14.88 million minimum frames per second at 10 Gbit/s; 813 thousand full frames", () => {
    expect(maxPacketRate(10e9, 64) / 1e6).toBeCloseTo(14.88, 2);
    expect(maxPacketRate(10e9, 1518) / 1e3).toBeCloseTo(812.7, 1);
    expect(1e9 / maxPacketRate(10e9, 64)).toBeCloseTo(67.2, 1); // ns per packet
  });

  test("tunnels: PPPoE 1492 (MSS 1452), VXLAN 1450", () => {
    const t = (id: string) => tunnelMtu(TUNNELS.find((x) => x.id === id)!);
    expect(t("pppoe")).toBe(1492);
    expect(mss(1492)).toBe(1452);
    expect(t("vxlan")).toBe(1450);
  });
});

describe("corruption: link checks against end-to-end checks", () => {
  const b = buildFrame();
  const app = b.spans.find((s) => s.layer === "app")!.start;

  test("any flip on the wire fails the FCS at the next NIC", () => {
    for (const i of [2, 22, app + 5, b.frame.length - 2]) expect(corruptionRun(b, flipBit(i), "wire").rx.droppedAt).toBe("fcs");
  });

  test("in the router: header errors fail the IP checksum, payload errors fail the TCP checksum", () => {
    expect(corruptionRun(b, flipBit(22), "router").rx.droppedAt).toBe("ipChecksum");
    expect(corruptionRun(b, flipBit(app + 5), "router").rx.droppedAt).toBe("tcpChecksum");
  });

  test("the router rewrites the Ethernet header and FCS, so changes there vanish", () => {
    const r = corruptionRun(b, flipBit(2), "router");
    expect(r.overwritten).toBe(true);
    expect(r.rx.droppedAt).toBeUndefined();
    expect(r.silent).toBe(false);
  });

  test("swapping two 16-bit words passes every check: silent corruption", () => {
    const r = corruptionRun(b, swapWords(app + 4), "router");
    expect(r.rx.droppedAt).toBeUndefined();
    expect(r.silent).toBe(true);
    expect(r.rx.ttl).toBe(DEFAULT_FRAME.ttl - 1);
  });
});

describe("fragmentation", () => {
  test("a 3980-byte IPv4 payload at MTU 1500: 1480 + 1480 + 1020, offsets 0, 185, 370", () => {
    const f = fragmentIpv4(3980, 1500);
    expect(f.map((x) => x.len)).toEqual([1480, 1480, 1020]);
    expect(f.map((x) => x.offsetField)).toEqual([0, 185, 370]);
    expect(f.map((x) => x.mf)).toEqual([true, true, false]);
  });

  test("4000 bytes of UDP through a 1450 VXLAN link: the sender makes 3, the router makes 5", () => {
    expect(fragmentIpv4(4008, 1500).map((x) => x.offsetField)).toEqual([0, 185, 370]);
    const r = crossPath(4000, 1450, { ip: 4, df: false });
    expect(r.outcome).toBe("fragmented");
    expect(r.fragments.map((x) => x.len)).toEqual([1424, 56, 1424, 56, 1048]);
    expect(r.fragments.map((x) => x.offsetField)).toEqual([0, 178, 185, 363, 370]);
    expect(r.wireBytes).toBe(4298);
    expect(r.efficiency).toBeCloseTo(0.931, 3);
    expect(r.fragments.reduce((s, x) => s + x.len, 0)).toBe(4008);
  });

  test("DF set: the router drops and reports the next-hop MTU; IPv6 routers never fragment", () => {
    expect(crossPath(1440, 1450, { ip: 4, df: true })).toMatchObject({ outcome: "dropped-df", reportMtu: 1450 });
    expect(crossPath(1400, 1450, { ip: 4, df: true }).outcome).toBe("fits");
    expect(crossPath(4000, 1450, { ip: 6, df: false })).toMatchObject({ outcome: "too-big-v6", reportMtu: 1450 });
  });

  test("1,400 bytes of UDP on plain Ethernet: one packet, 95.5% payload share; the second fragment starts above 1,472", () => {
    expect(crossPath(1400, 1500, { ip: 4, df: false })).toMatchObject({ outcome: "fits" });
    expect(crossPath(1400, 1500, { ip: 4, df: false }).efficiency).toBeCloseTo(0.955, 3);
    expect(crossPath(1472, 1500, { ip: 4, df: false }).fragments.length).toBe(1);
    expect(crossPath(1473, 1500, { ip: 4, df: false }).fragments.length).toBe(2);
  });

  test("IPv6 at the 1280 minimum MTU: 1232 data bytes per fragment", () => {
    expect(fragmentIpv6(5000, 1280).map((x) => x.len)).toEqual([1232, 1232, 1232, 1232, 72]);
  });
});

// ============================================================================ packets and switching

describe("statistical multiplexing", () => {
  test("35 users active 10% of the time overflow 10 circuits with probability about 0.0004", () => {
    expect(overflowProb(35, 0.1, 10)).toBeCloseTo(0.000424, 6);
    expect(maxUsers(0.1, 10, 0.0005)).toBe(35);
  });

  test("10 users, 30% load, 15 kB files on 10 Mbit/s: packets are 8.2× faster on average", () => {
    const base = { users: 10, rate: 10e6, fileBytes: 15000, load: 0.3, durationMs: 2000, seed: 1 };
    const c = shareRun({ ...base, mode: "circuit" }), p = shareRun({ ...base, mode: "packet" });
    expect(c.transfers.length).toBe(p.transfers.length);
    expect(c.meanMs).toBeCloseTo(146.7, 1);
    expect(p.meanMs).toBeCloseTo(17.99, 1);
    expect(c.meanMs / p.meanMs).toBeCloseTo(8.2, 1);
    expect(p.aloneMs).toBeCloseTo(12, 6);
    expect((15000 * 8 * 1000) / (10e6 / 10)).toBeCloseTo(120, 6);
    expect(Math.abs(c.utilization - p.utilization)).toBeLessThan(0.02);
  });
});

describe("store-and-forward and cut-through", () => {
  const o = { hops: 3, msgBytes: 15000, pktData: 1460, header: 40, rate: 10e6, delay: 0.5 };

  test("the closed form matches the PacketNet run exactly", () => {
    for (const q of [o, { ...o, pktData: 500 }, { ...o, hops: 1 }, { ...o, pktData: 15000 }, { ...o, msgBytes: 4321, hops: 5 }])
      expect(storeForwardMs(q)).toBeCloseTo(pipelineRun(q).doneMs, 9);
  });

  test("15 kB over 3 links: 11 packets, 16.25 ms; cut-through 13.87 ms; one packet 37.60 ms", () => {
    expect(packetCount(o)).toBe(11);
    expect(storeForwardMs(o)).toBeCloseTo(16.25, 2);
    expect(cutThroughMs(o)).toBeCloseTo(13.87, 2);
    expect(oneBigPacketMs(o)).toBeCloseTo(37.6, 2);
    expect(serializationMs(15040, 10e6)).toBeCloseTo(12.03, 2);
    expect((11 * 40) / (15000 + 11 * 40)).toBeCloseTo(0.0285, 4); // "2.8% more bytes"
  });

  test("one packet over h links costs h serializations; the best packet size is in between", () => {
    const one = { ...o, pktData: 15000 };
    expect(storeForwardMs(one)).toBeCloseTo(3 * (serializationMs(15040, 10e6) + 0.5), 9);
    const best = bestPktData({ hops: 3, msgBytes: 15000, header: 40, rate: 10e6, delay: 0.5 });
    expect(best.pktData).toBe(536);
    expect(optimalPktData({ hops: 3, msgBytes: 15000, header: 40 })).toBeCloseTo(548, 0);
    expect(best.ms).toBeCloseTo(15.32, 2);
  });

  test("cut-through hops start after the lookahead, never before the port is free", () => {
    const h = chainHops(o, true);
    for (const x of h) expect(x.txEnd - x.txStart).toBeGreaterThan(0);
    expect(cutThroughMs({ ...o, hops: 1 })).toBeCloseTo(storeForwardMs({ ...o, hops: 1 }), 9);
  });
});

describe("a router queue", () => {
  test("Poisson arrivals into PacketNet match the M/D/1 mean wait", () => {
    for (const load of [0.5, 0.8, 0.9]) {
      const r = queueRun({ load, rate: 10e6, pktBytes: 1500, bufferPkts: 100000, inputs: 4, durationMs: 60000, seed: 1, record: false });
      expect(r.meanWaitMs / md1WaitMs(load, r.serviceMs)).toBeGreaterThan(0.93);
      expect(r.meanWaitMs / md1WaitMs(load, r.serviceMs)).toBeLessThan(1.07);
    }
  });

  test("at 80% load a 1.2 ms packet waits 2.4 ms on average (M/D/1), 4.8 ms if sizes vary (M/M/1); 5.4 ms at 90%", () => {
    expect(serializationMs(1500, 10e6)).toBeCloseTo(1.2, 9);
    expect(md1WaitMs(0.8, 1.2)).toBeCloseTo(2.4, 9);
    expect(mm1WaitMs(0.8, 1.2)).toBeCloseTo(4.8, 9);
    expect(md1WaitMs(0.9, 1.2)).toBeCloseTo(5.4, 9);
    expect(md1WaitMs(0.9, 1)).toBeCloseTo(4.5, 9);
    expect(mm1WaitMs(0.9, 1)).toBeCloseTo(9, 9);
    expect(40 * serializationMs(1500, 10e6)).toBeCloseTo(48, 9); // a 40-packet buffer is 48 ms
  });

  test("a synchronized burst overflows a small buffer", () => {
    const r = queueRun({ load: 0, rate: 10e6, pktBytes: 1500, bufferPkts: 20, inputs: 4, durationMs: 100, seed: 1, bursts: [{ t: 10, n: 10 }] });
    // 40 packets arrive almost at once: 1 on the wire, 20 wait, the rest drop.
    expect(r.drops.length).toBe(19);
    expect(Math.max(...r.qlog.map((q) => q[1]))).toBe(20);
  });
});

describe("head-of-line blocking", () => {
  test("saturation throughput: 75% at N = 2, 65.5% at 4, 61.8% at 8, toward 58.6%", () => {
    expect(holThroughput(2, 200000)).toBeCloseTo(0.75, 2);
    expect(holThroughput(4, 200000)).toBeCloseTo(0.655, 2);
    expect(holThroughput(8, 100000)).toBeCloseTo(0.618, 2);
    expect(HOL_LIMIT).toBeCloseTo(0.586, 3);
    expect(holThroughput(32, 20000)).toBeLessThan(0.6);
  });

  test("a blocked input is one that lost although a later packet wanted an idle output", () => {
    const rng = mulberry32(3);
    const s = holInit(4, rng, 3);
    s.queues = [[0, 1, 1], [0, 2, 2], [3, 3, 3], [3, 0, 0]];
    const before = s.queues.map((q) => [...q]);
    const w = holStep(s, () => 0);
    expect(w).toEqual([0, -1, -1, 2]);
    expect(holBlocked(before, w)).toEqual([1]);
  });
});

// ============================================================================ latency, bandwidth and BDP

describe("light in fiber", () => {
  test("204 km per ms, 4.9 µs per km at group index 1.468", () => {
    expect(fiberKmPerMs()).toBeCloseTo(204.2, 1);
    expect(fiberUsPerKm()).toBeCloseTo(4.9, 1);
  });

  test("great-circle RTT bounds between cities", () => {
    expect(greatCircleKm(city("nyc"), city("lon"))).toBeCloseTo(5570, -1);
    expect(fiberRttMs("nyc", "lon")).toBeCloseTo(54.6, 1);
    expect(vacuumRttMs("nyc", "lon")).toBeCloseTo(37.2, 1);
    expect(fiberRttMs("nyc", "tyo")).toBeCloseTo(106.3, 1);
    expect(fiberRttMs("sfo", "syd")).toBeCloseTo(117.0, 1);
    expect(fiberRttMs("fra", "lon")).toBeCloseTo(6.2, 1);
    // The table: great-circle km and the vacuum bound.
    const km = (a: string, b: string) => greatCircleKm(city(a), city(b));
    expect(Math.round(km("fra", "lon") / 10) * 10).toBe(640);
    expect(km("fra", "lon")).toBeCloseTo(637.8, 0);
    expect(vacuumRttMs("fra", "lon")).toBeCloseTo(4.25, 1);
    expect(Math.round(km("nyc", "tyo") / 50) * 50).toBe(10850);
    expect(vacuumRttMs("nyc", "tyo")).toBeCloseTo(72.4, 1);
    expect(Math.round(km("sfo", "syd") / 50) * 50).toBe(11950);
    expect(vacuumRttMs("sfo", "syd")).toBeCloseTo(79.7, 1);
  });

  test("geostationary orbit: 35,786 km up, at least 477 ms for a request and its answer", () => {
    expect(geoAltitudeKm()).toBeCloseTo(35786, 0);
    expect(geoRttMs()).toBeCloseTo(477.5, 1);
  });

  test("serialization of 1500 bytes: 1.2 ms at 10 Mbit/s, 12 µs at 1 Gbit/s, 120 ns at 100 Gbit/s", () => {
    expect(serializationMs(1500, 10e6)).toBeCloseTo(1.2, 9);
    expect(serializationMs(1500, 1e9) * 1000).toBeCloseTo(12, 9);
    expect(serializationMs(1500, 100e9) * 1e6).toBeCloseTo(120, 6);
  });
});

describe("one packet, many hops", () => {
  test("New York to London: 27.9 ms one way, 99% of it propagation", () => {
    const path = examplePath(100e6, greatCircleKm(city("nyc"), city("lon")));
    const run = pathRun(path, 1500, 0.5, { probes: 150, spacingMs: 40 * 0.12, seed: 2 });
    const hops = pathBreakdown(path, 1500, run.meanQueueMs);
    const total = totalMs(hops);
    expect(total).toBeCloseTo(27.9, 1);
    expect(hops[3]!.propMs).toBeCloseTo(27.3, 1); // 5,570 km of fiber
    expect(hops[1]!.serMs).toBeCloseTo(0.12, 6);
    expect(run.meanQueueMs[1]).toBeLessThan(0.1);
    const fra = pathBreakdown(examplePath(100e6, greatCircleKm(city("fra"), city("lon"))), 1500);
    expect(fra.reduce((s, h) => s + h.propMs, 0)).toBeCloseTo(3.5, 1);
    expect(pathBreakdown(examplePath(1e6, 50), 1500)[1]!.serMs).toBeCloseTo(12, 6);
    expect(hops.reduce((s, h) => s + h.propMs, 0) / total).toBeGreaterThan(0.99);
    // Only the loaded access link queues.
    expect(run.meanQueueMs[1]).toBeGreaterThan(0.02);
    for (const i of [0, 2, 3, 4, 5]) expect(run.meanQueueMs[i]).toBeLessThan(1e-9);
  });

  test("probe waits at the loaded access link follow M/D/1", () => {
    const path = examplePath(100e6, 50);
    // Probes every 12 ms add 1% of load: the queue they see is the queue at 81% load.
    const run = pathRun(path, 1500, 0.8, { probes: 1500, spacingMs: 12, seed: 4 });
    const s = serializationMs(1500, 100e6);
    expect(run.meanQueueMs[1]! / md1WaitMs(0.81, s)).toBeGreaterThan(0.85);
    expect(run.meanQueueMs[1]! / md1WaitMs(0.81, s)).toBeLessThan(1.15);
  });
});

describe("bandwidth against latency", () => {
  test("100 kB: A (1 Gbit/s, 150 ms) takes 525 ms, B (50 Mbit/s, 10 ms) 44.8 ms", () => {
    expect(transferMs(1e5, 1e9, 150)).toBeCloseTo(525, 0);
    expect(transferMs(1e5, 50e6, 10)).toBeCloseTo(44.8, 1);
    expect(transferMs(1e5, 1e10, 150)).toBeCloseTo(525, 0);
    expect(transferMs(1e5, 1e9, 75)).toBeCloseTo(263, 0);
    expect(slowStartRounds(1e5, 1e9, 150)).toBe(3);
    expect(Math.ceil(1e5 / 1460)).toBe(69); // rounds of 10, 20 and 39 segments
    expect(serializationMs(1e5, 1e9)).toBeCloseTo(0.8, 9);
    expect(serializationMs(1e5, 50e6)).toBeCloseTo(16, 9);
    expect(crossoverBytes({ rate: 1e9, rttMs: 150 }, { rate: 50e6, rttMs: 10 }) / 1e6).toBeCloseTo(9.5, 1);
  });

  test("the closed form matches an ack-clocked slow-start sender in PacketNet", () => {
    for (const bytes of [1e4, 1e5, 1e6, 5e6]) {
      const r = windowRun({ rate: 100e6, owdMs: 25, window: { iw: 10 }, packets: Math.ceil(bytes / 1460) });
      const model = transferMs(bytes, 100e6, r.baseRttMs);
      expect(model / (r.doneMs + r.baseRttMs)).toBeGreaterThan(0.98);
      expect(model / (r.doneMs + r.baseRttMs)).toBeLessThan(1.02);
    }
  });
});

describe("the bandwidth-delay product", () => {
  test("example paths", () => {
    expect(BDP_EXAMPLES.map((e) => bdpBytes(e.rate, e.rttMs))).toEqual([625_000, 250_000, 87_500_000, 7_500_000]);
  });

  test("window limits: 64 KiB over 100 ms is 5.24 Mbit/s; 6 MB over 70 ms is 719 Mbit/s; 32 MB is 3.83 Gbit/s", () => {
    expect(windowLimitBps(TCP_WINDOW_UNSCALED, 100) / 1e6).toBeCloseTo(5.24, 2);
    expect(windowLimitBps(6 * 1024 * 1024, 70) / 1e6).toBeCloseTo(719, 0);
    expect(windowLimitBps(32 * 1024 * 1024, 70) / 1e9).toBeCloseTo(3.83, 2);
    expect(TCP_WINDOW_MAX_SCALED).toBe(1_073_725_440);
  });

  test("10 Mbit/s, 10 ms each way: BDP 17.8 packets; a window of 8 gets about 4.4 Mbit/s; 40 packets add a 27 ms queue", () => {
    const small = windowRun({ rate: 10e6, owdMs: 10, window: 8, packets: 400 });
    expect(small.baseRttMs).toBeCloseTo(21.36, 2);
    expect(small.bdpPackets).toBeCloseTo(17.8, 1);
    expect(windowLimitBps(8 * 1460, small.baseRttMs) / 1e6).toBeCloseTo(4.38, 2);
    expect(small.throughputBps / 1e6).toBeGreaterThan(4.2);
    expect(small.throughputBps / 1e6).toBeLessThan(4.6);
    const full = windowRun({ rate: 10e6, owdMs: 10, window: 18, packets: 400 });
    expect(full.throughputBps / 1e6).toBeCloseTo(9.73, 2); // 1460 of every 1500 bytes
    const big = windowRun({ rate: 10e6, owdMs: 10, window: 40, packets: 400 });
    const rtt = big.rttMs.slice(200).reduce((s, x) => s + x, 0) / 200;
    expect(rtt).toBeCloseTo(48, 0); // 40 packets × 1.2 ms: the window is the RTT now
    expect(rtt - big.baseRttMs).toBeCloseTo(26.6, 0);
    expect(big.throughputBps).toBeCloseTo(full.throughputBps, -3);
    // One-way delay 40 ms: the BDP is about 68 packets, and a window of 18 gets about a quarter of the link.
    const far = windowRun({ rate: 10e6, owdMs: 40, window: 18, packets: 400 });
    expect(far.bdpPackets).toBeCloseTo(67.8, 1);
    expect(far.throughputBps / full.throughputBps).toBeGreaterThan(0.24);
    expect(far.throughputBps / full.throughputBps).toBeLessThan(0.29);
  });
});
