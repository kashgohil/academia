/**
 * The link-layer module (src/sims/net/link): Ethernet frames and the FCS, ARP and the neighbour cache, learning
 * switches, STP, VLANs and Wi-Fi. Every number that the four lessons quote is pinned here.
 */
import { describe, expect, test } from "vitest";
import { crc32, formatMac, internetChecksum, serializationMs, utf8 } from "../../src/sims/net";
import {
  CRC32_RESIDUE, ETH, ETHERTYPE, LINUX_NEIGH, PHYS, STP_TIMERS, airtime, applyError, arpRun, bestRate, bodyBytes, checkFcs, collisionWindow, cyclesPerFrame,
  dcfRun, deadNeighbourBoundMs, decodeFrame, detectionTrial, domainAtRate, encodeFrame, ethHeaderFields, flipBit, formatIpv6, frameBytes, framesPerSecond,
  hiddenRun, ipv4MulticastMac, lanReach, learnRun, macInfo, maxAggregate, nudRun, padBytes, parseIpv6, parseMac, phyById, ppduUs, rateTable,
  reachableRangeMs, shareAirtime, snrAt, solicitedNode, solicitedNodeMac, spoofRun, stormRun, stpCost, stpRun, typeOrLength, vlanRun, wireCost,
} from "../../src/sims/net/link";
import { packFields } from "../../src/sims/net";
import { mulberry32 } from "../../src/sims/rng";

// ============================================================================ Ethernet

describe("Ethernet frames", () => {
  const frame = (len: number, tag = false) => ({
    dst: parseMac("ff:ff:ff:ff:ff:ff"), src: parseMac("02:00:00:00:00:01"), vlan: tag ? { pcp: 5, dei: 0, vid: 10 } : undefined, etherType: ETHERTYPE.ipv4, payload: utf8("x".repeat(len)),
  });

  test("padding keeps every frame at 64 bytes or more", () => {
    expect(encodeFrame(frame(0)).bytes.length).toBe(64);
    expect(encodeFrame(frame(0)).pad).toBe(46);
    expect(encodeFrame(frame(46)).pad).toBe(0);
    expect(encodeFrame(frame(0, true)).pad).toBe(42);
    expect(encodeFrame(frame(1500)).bytes.length).toBe(1518);
    expect(encodeFrame(frame(1500, true)).bytes.length).toBe(1522);
    expect(padBytes(20)).toBe(26);
  });

  test("the header field list packs to the same bytes as the frame", () => {
    const f = frame(10, true);
    expect([...packFields(ethHeaderFields(f))]).toEqual([...encodeFrame(f).bytes.slice(0, 18)]);
    const d = decodeFrame(encodeFrame(f).bytes);
    expect(d.vlan).toEqual({ pcp: 5, dei: 0, vid: 10 });
    expect(d.etherType).toBe(0x0800);
  });

  test("the FCS is CRC-32, and a good frame always leaves the residue 0x2144DF1C", () => {
    const e = encodeFrame(frame(20));
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926); // the CRC-32 check value
    const c = checkFcs(e.bytes);
    expect(c.ok).toBe(true);
    expect(c.residue).toBe(CRC32_RESIDUE);
    expect(CRC32_RESIDUE).toBe(0x2144df1c);
    for (let bit = 0; bit < e.bytes.length * 8; bit += 37) expect(checkFcs(flipBit(e.bytes, bit)).ok).toBe(false);
  });

  test("Type/Length: 0x0600 and up is an EtherType, 1500 and down a length", () => {
    expect(typeOrLength(0x0800)).toBe("type");
    expect(typeOrLength(1500)).toBe("length");
    expect(typeOrLength(1530)).toBe("invalid");
  });

  test("MAC address bits", () => {
    expect(macInfo(parseMac("ff:ff:ff:ff:ff:ff"))).toMatchObject({ group: true, broadcast: true, kind: "broadcast" });
    expect(macInfo(parseMac("01:00:5e:00:00:fb"))).toMatchObject({ group: true, local: false, kind: "IPv4 multicast" });
    expect(macInfo(parseMac("02:42:ac:11:00:02"))).toMatchObject({ group: false, local: true, kind: "unicast" });
    expect(macInfo(parseMac("00:1b:21:3a:4f:10")).oui).toBe("00:1b:21");
    // RFC 1112: 224.0.0.251 and 239.128.0.251 share one MAC (only the low 23 bits are kept).
    expect(formatMac(ipv4MulticastMac(0xe00000fb))).toBe("01:00:5e:00:00:fb");
    expect(formatMac(ipv4MulticastMac(0xef8000fb))).toBe("01:00:5e:00:00:fb");
  });

  test("CRC-32 against the Internet checksum on 10,000 random frames per error kind", () => {
    const res = Object.fromEntries((["one bit", "two bits", "burst ≤ 32", "swap two 16-bit words", "random bytes"] as const).map((k) => [k, detectionTrial(k, 10_000, 1)]));
    for (const r of Object.values(res)) expect(r.crcMissed).toBe(0);
    expect(res["one bit"]!.sumMissed).toBe(0);
    expect(res["two bits"]!.sumMissed).toBe(289);
    expect(res["burst ≤ 32"]!.sumMissed).toBe(0);
    expect(res["swap two 16-bit words"]!.sumMissed).toBe(10_000);
  });

  test("a word swap never changes the Internet checksum", () => {
    const rnd = mulberry32(3);
    const b = new Uint8Array(60).map(() => Math.floor(rnd() * 256));
    const sum = internetChecksum(b);
    applyError(b, "swap two 16-bit words", rnd);
    expect(internetChecksum(b)).toBe(sum);
  });

  test("bytes on the wire, frame rates and jumbo frames", () => {
    expect(wireCost(1500).total).toBe(1538);
    expect(wireCost(1500).efficiency).toBeCloseTo(0.975, 3);
    expect(wireCost(0).total).toBe(84);
    expect(wireCost(1500).total - 1500).toBe(38);
    expect(framesPerSecond(10e9, 46) / 1e6).toBeCloseTo(14.88, 2);
    expect(1e9 / framesPerSecond(10e9, 46)).toBeCloseTo(67.2, 1);
    expect(Math.round(cyclesPerFrame(10e9, 46, 3))).toBe(202);
    expect(wireCost(9000).efficiency).toBeCloseTo(0.996, 3);
    expect(framesPerSecond(1e9, 1500) / framesPerSecond(1e9, 9000)).toBeCloseTo(5.88, 2);
    expect(wireCost(1500, true).total - wireCost(1500).total).toBe(4);
  });

  test("the collision window", () => {
    const w = collisionWindow(10e6, 2500, 64);
    expect(Math.round(w.roundTripBits)).toBe(217);
    expect(w.frameBits).toBe(ETH.slotBits);
    expect(w.detected).toBe(true);
    const g = collisionWindow(1e9, 2500, 64);
    expect(g.detected).toBe(false);
    expect(Math.round(g.maxLengthM)).toBe(59);
    expect(collisionWindow(1e9, 200, 512).detected).toBe(true);
    expect(ETH.gigSlotBits / ETH.slotBits).toBe(8);
    expect(domainAtRate(1e9)).toBe(25);
  });
});

// ============================================================================ ARP

describe("ARP and the neighbour cache", () => {
  test("an ARP message is 28 bytes and rides in a 64-byte frame", () => {
    const body = { kind: "arp" as const, arp: { op: 1 as const, sha: "02:00:00:00:00:01", spa: 1, tha: "00:00:00:00:00:00", tpa: 2 } };
    expect(bodyBytes(body)).toBe(28);
    expect(frameBytes({ dst: "ff:ff:ff:ff:ff:ff", src: "02:00:00:00:00:01", body })).toBe(64);
  });

  test("first ping: one broadcast reaches every other host; the target learns the asker", () => {
    const lan = arpRun([{ kind: "ping", from: 0, to: 2 }]);
    const reqArrivals = lan.net.trace.flatMap((e) => (e.kind === "arrive" && e.node < 4 && e.pkt.payload.body.kind === "arp" && e.pkt.payload.body.arp.op === 1 ? [e.node] : []));
    expect(reqArrivals.sort()).toEqual([1, 2, 3]);
    expect(lan.host(0).inbox.some((m) => m.ip.data === "pong")).toBe(true);
    expect(lan.host(2).stats.arpSent).toBe(1); // only the reply
    expect(lan.host(2).neigh.get(0x0a000001)?.mac).toBe(lan.host(0).mac);
  });

  test("a second ping needs no ARP; a new NIC breaks the cache until a gratuitous ARP", () => {
    const lan = arpRun([{ kind: "ping", from: 0, to: 2 }, { kind: "ping", from: 0, to: 2 }, { kind: "newnic", host: 2 }, { kind: "ping", from: 0, to: 2 }, { kind: "garp", host: 2 }, { kind: "ping", from: 0, to: 2 }]);
    expect(lan.host(0).stats.arpSent).toBe(1);
    const pongs = lan.host(0).inbox.filter((m) => m.ip.data === "pong").map((m) => Math.floor(m.t / 2));
    expect(pongs).toEqual([0, 1, 5]);
    expect(lan.host(2).stats.nicDropped).toBe(1);
  });

  test("Linux defaults and the bounds the lesson derives from them", () => {
    expect(LINUX_NEIGH).toMatchObject({ baseReachableMs: 30_000, delayFirstProbeMs: 5_000, retransMs: 1_000, ucastSolicit: 3, mcastSolicit: 3 });
    expect(reachableRangeMs()).toEqual([15_000, 45_000]);
    expect(deadNeighbourBoundMs()).toBe(53_000);
  });

  test("the neighbour cache demo: probes without confirmations, none with them", () => {
    const plain = nudRun({ intervalMs: 2000, untilMs: 180_000, baseReachableMs: 30_000, confirm: false });
    expect(plain.reachableMs / 1000).toBeCloseTo(44.1, 1);
    expect(plain.history.slice(0, 6).map((h) => h.state)).toEqual(["INCOMPLETE", "REACHABLE", "STALE", "DELAY", "PROBE", "REACHABLE"]);
    expect(plain.history[4]!.t - plain.history[3]!.t).toBe(5000);
    expect(plain.pongs).toBe(plain.pings);
    const conf = nudRun({ intervalMs: 2000, untilMs: 180_000, baseReachableMs: 30_000, confirm: true });
    expect(conf.history.map((h) => h.state)).toEqual(["INCOMPLETE", "REACHABLE"]);
    expect(conf.arp.length).toBe(1);
  });

  test("a dead neighbour: REACHABLE until 142 s, FAILED at 152 s, 52 s after the cut", () => {
    const r = nudRun({ intervalMs: 2000, untilMs: 180_000, baseReachableMs: 30_000, confirm: true, dieAtMs: 100_000 });
    const stale = r.history.find((h) => h.state === "STALE")!;
    const failed = r.history.find((h) => h.state === "FAILED")!;
    expect(Math.floor(stale.t / 1000)).toBe(142);
    expect(failed.t).toBeCloseTo(152_000, -2);
    expect(failed.t - 100_000).toBeLessThanOrEqual(deadNeighbourBoundMs());
  });

  test("an entry that is STALE whenever a packet leaves: every packet starts a probe", () => {
    const r = nudRun({ intervalMs: 60_000, untilMs: 180_000, baseReachableMs: 30_000, confirm: false });
    expect(r.history.filter((h) => h.state === "PROBE").length).toBe(2);
  });

  test("ARP spoofing: 23 of 32 packets through the attacker; static entries and inspection stop it", () => {
    const mitm = spoofRun({ attack: true, forward: true, staticArp: false, inspect: false });
    expect(mitm.path.length).toBe(32);
    expect(mitm.count("via attacker")).toBe(23);
    expect(mitm.count("direct")).toBe(9);
    const dos = spoofRun({ attack: true, forward: false, staticArp: false, inspect: false });
    expect(dos.count("lost")).toBe(23);
    for (const o of [{ staticArp: true, inspect: false }, { staticArp: false, inspect: true }]) {
      const r = spoofRun({ attack: true, forward: true, ...o });
      expect(r.count("direct")).toBe(32);
    }
  });

  test("IPv6 solicited-node multicast", () => {
    const a = parseIpv6("fe80::3c22:fbff:fe12:3456");
    expect(formatIpv6(solicitedNode(a))).toBe("ff02::1:ff12:3456");
    expect(formatMac(solicitedNodeMac(a))).toBe("33:33:ff:12:34:56");
    expect(formatIpv6(parseIpv6("2001:db8:0:0:1:0:0:1"))).toBe("2001:db8::1:0:0:1");
    expect(lanReach(500, 7)).toEqual({ arp: 499, ndp: 0 });
  });
});

// ============================================================================ switches

describe("learning switches, loops, STP and VLANs", () => {
  test("learning: flood unknown, forward known, forget after ageing", () => {
    const s = learnRun([{ kind: "send", from: 0, to: 1 }, { kind: "send", from: 1, to: 0 }, { kind: "send", from: 0, to: 1 }, { kind: "send", from: 2, to: "all" }, { kind: "wait", ms: 120_000 }, { kind: "send", from: 0, to: 1 }], 60_000);
    expect(s[0]!.flooded).toBe(true);
    expect(s[0]!.reached).toEqual([1, 2, 3]);
    expect(s[1]!.reached).toEqual([0]);
    expect(s[2]!.reached).toEqual([1]);
    expect(s[3]!.reached).toEqual([0, 1, 3]);
    expect(s[4]!.table).toEqual([]);
    expect(s[5]!.flooded).toBe(true);
  });

  test("store and forward waits 1.21 µs for a 1518-byte frame at 10 Gb/s", () => {
    expect(serializationMs(1518, 10e9) * 1000).toBeCloseTo(1.21, 2);
  });

  test("a broadcast in a triangle: 198 copies at H2 and 594 MAC moves in 0.5 ms", () => {
    const r = stormRun({ topo: "triangle", stp: false, watchMs: 0.5 });
    expect(r.copiesAtH2).toBe(198);
    expect(r.moves).toBe(594);
  });

  test("a full mesh saturates its links", () => {
    const r = stormRun({ topo: "mesh", stp: false, watchMs: 0.5 });
    expect(Math.round(r.utilization * 100)).toBe(99);
    expect(r.queueDrops).toBe(13_602);
  });

  test("with STP, every topology delivers the broadcast exactly once", () => {
    for (const topo of ["line", "triangle", "mesh"] as const) {
      const r = stormRun({ topo, stp: true, watchMs: 0.5 });
      expect(r.copiesAtH2).toBe(1);
      expect(r.blockedLinks.length).toBe(topo === "line" ? 0 : topo === "triangle" ? 1 : 3);
    }
    expect(stormRun({ topo: "line", stp: false, watchMs: 0.5 }).copiesAtH2).toBe(1);
  });

  test("STP defaults and costs", () => {
    expect(STP_TIMERS).toEqual({ helloMs: 2000, maxAgeMs: 20_000, fwdDelayMs: 15_000 });
    expect([stpCost(10e6), stpCost(100e6), stpCost(1e9), stpCost(10e9)]).toEqual([100, 19, 4, 2]);
  });

  test("STP election: S1 is root, S2–S3 and S3–S4 each have a blocked end", () => {
    const r = stpRun({ priorities: [32768, 32768, 32768, 32768], cut: -1, rapid: false });
    expect(r.root).toBe(0);
    expect(r.rootCost).toEqual([0, 4, 4, 8]);
    const blocked = r.ports.filter((p) => p.role === "alternate").map((p) => `${p.sw}-${p.peer}`).sort();
    expect(blocked).toEqual(["2-1", "3-2"]);
    expect(r.firstForwardMs).toBeCloseTo(30_100, -2);
  });

  test("STP failover: 47 s after an indirect failure, 30 s after a direct one, nothing for a blocked link", () => {
    const P = [32768, 32768, 32768, 32768];
    expect(stpRun({ priorities: P, cut: 0, rapid: false }).outageMs).toBe(47_000);
    expect(stpRun({ priorities: P, cut: 2, rapid: false }).outageMs).toBe(30_000);
    expect(stpRun({ priorities: P, cut: 4, rapid: false }).outageMs).toBe(0);
    expect(stpRun({ priorities: P, cut: 0, rapid: true }).outageMs).toBe(500);
  });

  test("a lower priority moves the root", () => {
    expect(stpRun({ priorities: [32768, 32768, 32768, 4096], cut: -1, rapid: false }).root).toBe(3);
  });

  test("VLANs: isolation, tags on the trunk, and the native VLAN leak", () => {
    const a = vlanRun({ from: 0, uplink: "trunk", nativeMismatch: false });
    expect(a.heard).toEqual([2]);
    expect(a.uplink).toMatchObject({ vid: 10, bytes: 68 });
    expect(vlanRun({ from: 1, uplink: "trunk", nativeMismatch: false }).heard).toEqual([3]);
    expect(vlanRun({ from: 1, uplink: "only10", nativeMismatch: false }).heard).toEqual([]);
    expect(vlanRun({ from: 1, uplink: "access", nativeMismatch: false }).heard).toEqual([]);
    const leak = vlanRun({ from: 0, uplink: "trunk", nativeMismatch: true });
    expect(leak.heard).toEqual([3]);
    expect(leak.uplink).toMatchObject({ vid: undefined, bytes: 64 });
  });
});

// ============================================================================ Wi-Fi

describe("Wi-Fi", () => {
  test("PPDU airtime: a 1538-byte MPDU at 54 Mb/s is 252 µs; an ACK at 24 Mb/s is 28 µs", () => {
    expect(ppduUs(1538, 54)).toBe(252);
    expect(ppduUs(14, 24)).toBe(28);
  });

  test("one station at 54 Mb/s: a 397.5 µs exchange, 30.2 Mb/s, 56%", () => {
    const a = airtime({ payload: 1500, phy: phyById("a54"), rts: false, aggregate: 1 });
    expect(a.totalUs).toBe(397.5);
    expect(a.throughput).toBeCloseTo(30.2, 1);
    expect(Math.round(a.efficiency * 100)).toBe(56);
    expect(a.payloadUs).toBeCloseTo(222.2, 1);
    expect(airtime({ payload: 1500, phy: phyById("a54"), rts: true, aggregate: 1 }).throughput).toBeCloseTo(24.7, 1);
  });

  test("867 Mb/s: one frame gets 59.6 Mb/s; 64 aggregated frames get 694.7 Mb/s", () => {
    const one = airtime({ payload: 1500, phy: phyById("ac867"), rts: false, aggregate: 1 });
    expect(one.throughput).toBeCloseTo(59.6, 1);
    expect(one.efficiency * 100).toBeCloseTo(6.9, 1);
    expect(one.payloadUs).toBeCloseTo(13.8, 1);
    expect(Math.round((one.totalUs - one.payloadUs) / 10) * 10).toBe(190);
    expect(airtime({ payload: 1500, phy: phyById("ac867"), rts: false, aggregate: 64 }).throughput).toBeCloseTo(694.7, 1);
  });

  test("an 802.11n A-MPDU holds at most 42 full frames (65,535 bytes)", () => {
    expect(maxAggregate(1500, phyById("n150"), 64)).toBe(42);
    expect(PHYS.filter((p) => p.maxAmpdu === 0).every((p) => maxAggregate(1500, p, 64) === 1)).toBe(true);
  });

  test("contention: 30.3 Mb/s alone, 21.9 Mb/s and 62% failed attempts with 50 stations", () => {
    const one = dcfRun({ n: 1, payload: 1500, rate: 54, rts: false, durationUs: 1e6 });
    expect(one.total).toBeCloseTo(30.3, 1);
    expect(one.failRate).toBe(0);
    const fifty = dcfRun({ n: 50, payload: 1500, rate: 54, rts: false, durationUs: 1e6 });
    expect(fifty.total).toBeCloseTo(21.9, 1);
    expect(Math.round(fifty.failRate * 100)).toBe(62);
  });

  test("the hidden terminal at 12 Mb/s: 3.11 Mb/s, 9.65 when they hear each other, 9.11 with RTS/CTS", () => {
    const hidden = hiddenRun({ distance: 46, rts: false, payload: 1500, rate: 12, durationUs: 2e6 });
    expect(hidden.hidden).toBe(true);
    expect(hidden.total).toBeCloseTo(3.11, 2);
    expect(Math.round(hidden.failRate * 4)).toBe(3);
    expect(hiddenRun({ distance: 10, rts: false, payload: 1500, rate: 12, durationUs: 2e6 }).total).toBeCloseTo(9.65, 2);
    expect(hiddenRun({ distance: 46, rts: true, payload: 1500, rate: 12, durationUs: 2e6 }).total).toBeCloseTo(9.11, 2);
    const fast = [false, true].map((rts) => hiddenRun({ distance: 46, rts, payload: 1500, rate: 54, durationUs: 2e6 }).total);
    expect(fast[1]! / fast[0]!).toBeLessThan(1.2);
  });

  test("the performance anomaly and airtime fairness", () => {
    const fast = shareAirtime([54, 54, 54], 1500, "frames");
    expect(fast.throughput[0]).toBeCloseTo(10.06, 2);
    const frames = shareAirtime([54, 54, 6], 1500, "frames");
    expect(frames.throughput.map((t) => +t.toFixed(2))).toEqual([3.96, 3.96, 3.96]);
    expect(Math.round(frames.airtime[2]! * 100)).toBe(74);
    expect(frames.total).toBeCloseTo(11.87, 2);
    const atf = shareAirtime([54, 54, 6], 1500, "airtime");
    expect(atf.throughput[0]).toBeCloseTo(10.06, 2);
    expect(atf.total).toBeCloseTo(21.91, 2);
  });

  test("rate adaptation at 45 m: 24 Mb/s is best with 17.3 Mb/s; 36 Mb/s loses 76% and gives 5.7", () => {
    const snr = snrAt(45);
    expect(snr).toBeCloseTo(17.1, 1);
    const best = bestRate(snr);
    expect(best.rate).toBe(24);
    expect(best.goodput).toBeCloseTo(17.3, 1);
    const r36 = rateTable(snr).find((p) => p.rate === 36)!;
    expect(Math.round(r36.fer * 100)).toBe(76);
    expect(r36.goodput).toBeCloseTo(5.7, 1);
    expect(bestRate(snrAt(3)).rate).toBe(54);
    expect(bestRate(snrAt(110)).rate).toBe(6);
  });
});
