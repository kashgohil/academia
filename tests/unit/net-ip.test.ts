/** The network-layer sims (src/sims/net/ip) and every number the "ip" lessons quote. */
import { describe, expect, test } from "vitest";
import { formatIpv4, internetChecksum, parseIpv4 } from "../../src/sims/net";
import {
  CONV_DEFAULTS, RIP_INFINITY, DV_LINE, DV_LINE_SCHEDULE, DV_TRIANGLE, DV_TRIANGLE_SCHEDULE, ICMP_ERROR_BYTES, IPV6_HEADER_BYTES, LESSON_GRAPH, MAX_UDP_PAYLOAD_V4, NAT_PORTS,
  Nat, NAT_DEFAULTS, PrefixTrie, RFC1918_ADDRESSES, aggregate, bgpDecision, classicName, convergenceRun, datagramSurvival, decrementTtl, defaultIpv4, dijkstraSteps,
  dvRun, expandIpv6, extensionChain, formatCidr, formatIpv6, forwardIpv4, fragmentIpv4, holePunch, icmpBytes, ipv4Bytes, ipv4Checksum, ipv6Kind, linearLpm,
  ospfCost, parseCidr, parseIpv4Header, parseIpv6, pathOf, pmtuRun, prefixSize, propagate, rov, runScenario, specialRange, subnetInfo, subscribersPerIp, tcpMss,
  traceroute, valleyFree, vlsm, CONV_TOPO, type Candidate, type FilteringBehavior, type MappingBehavior,
} from "../../src/sims/net/ip";
import { mulberry32 } from "../../src/sims/rng";

describe("IPv4 header", () => {
  test("checksum: a header with a correct checksum sums to zero; the lesson's example is 0x26d6", () => {
    const h = defaultIpv4();
    const b = ipv4Bytes(h);
    expect(b.length).toBe(20);
    expect(internetChecksum(b)).toBe(0);
    expect(ipv4Checksum(h)).toBe(0x26d6);
    expect(parseIpv4Header(b).problems).toEqual([]);
  });

  test("RFC 1624 incremental update equals a full recompute, for every TTL and many headers", () => {
    const rnd = mulberry32(7);
    for (let k = 0; k < 2000; k++) {
      const h = defaultIpv4({ ttl: 1 + Math.floor(rnd() * 255), id: Math.floor(rnd() * 65536), protocol: Math.floor(rnd() * 256), src: Math.floor(rnd() * 2 ** 32) >>> 0, dst: Math.floor(rnd() * 2 ** 32) >>> 0, totalLength: 20 + Math.floor(rnd() * 1480) });
      const d = decrementTtl({ ...h, checksum: ipv4Checksum(h) });
      expect(d.incremental).toBe(d.full);
    }
    const d = decrementTtl({ ...defaultIpv4(), checksum: 0x26d6 });
    expect(d.header.ttl).toBe(63);
    expect(d.incremental).toBe(0x27d6);
  });

  test("a receiver rejects a bad checksum, a bad version and a short IHL", () => {
    const b = ipv4Bytes(defaultIpv4());
    b[8] = 63; // TTL changed without a new checksum
    expect(parseIpv4Header(b).problems).toContain("the header checksum does not match");
    expect(parseIpv4Header(ipv4Bytes(defaultIpv4({ version: 6 }))).problems[0]).toMatch(/version/);
    expect(parseIpv4Header(ipv4Bytes(defaultIpv4({ ihl: 4 }))).problems[0]).toMatch(/IHL/);
  });
});

describe("fragmentation", () => {
  test("4,000 data bytes at MTU 1500: three fragments, offsets 0, 185, 370, 4,060 bytes on the wire", () => {
    const f = fragmentIpv4(4000, 1500);
    expect(f.map((x) => x.dataBytes)).toEqual([1480, 1480, 1040]);
    expect(f.map((x) => x.offsetField)).toEqual([0, 185, 370]);
    expect(f.map((x) => x.mf)).toEqual([true, true, false]);
    expect(f.reduce((s, x) => s + x.totalLength, 0)).toBe(4060);
  });

  test("every fragment but the last is a multiple of 8; data is conserved", () => {
    for (const mtu of [68, 576, 1280, 1400, 1500, 9000]) for (const n of [1, 7, 100, 1479, 1481, 4000, 65515]) {
      const f = fragmentIpv4(n, mtu);
      expect(f.reduce((s, x) => s + x.dataBytes, 0)).toBe(n);
      for (const x of f.slice(0, -1)) expect(x.dataBytes % 8).toBe(0);
      for (const x of f) expect(x.totalLength).toBeLessThanOrEqual(Math.max(mtu, n + 20 <= mtu ? mtu : 0) || mtu);
    }
  });

  test("the demo's other cases: 8 fragments at MTU 576, none for 1,480 bytes at MTU 1500", () => {
    expect(fragmentIpv4(4000, 576).length).toBe(8);
    expect(fragmentIpv4(1480, 1500)).toEqual([{ offset: 0, offsetField: 0, dataBytes: 1480, totalLength: 1500, mf: false }]);
    expect(2 ** 16).toBe(65_536); // Identification values
  });

  test("DF set and too big: dropped with the next-hop MTU", () => {
    expect(forwardIpv4(4000, 1400, true)).toEqual({ kind: "dropped", nextHopMtu: 1400 });
  });

  test("loss compounds: 3 fragments at 1% loss arrive 97.0%; a 65,507-byte UDP datagram needs 45 fragments and arrives 63.6%", () => {
    expect(datagramSurvival(3, 0.01)).toBeCloseTo(0.9703, 4);
    expect(MAX_UDP_PAYLOAD_V4).toBe(65507);
    const k = fragmentIpv4(MAX_UDP_PAYLOAD_V4 + 8, 1500).length;
    expect(k).toBe(45);
    expect(datagramSurvival(k, 0.01)).toBeCloseTo(0.636, 3);
  });

  test("TCP MSS on a 1,500-byte link: 1,460 over IPv4, 1,440 over IPv6", () => {
    expect(tcpMss(1500, false)).toBe(1460);
    expect(tcpMss(1500, true)).toBe(1440);
  });
});

describe("IPv6", () => {
  test("RFC 5952 canonical text", () => {
    const f = (s: string) => formatIpv6(parseIpv6(s));
    expect(f("2001:0db8:0000:0000:0000:ff00:0042:8329")).toBe("2001:db8::ff00:42:8329");
    expect(f("2001:db8:0:1:0:0:0:1")).toBe("2001:db8:0:1::1");
    expect(f("2001:db8:0:0:1:0:0:1")).toBe("2001:db8::1:0:0:1"); // tie: the first run
    expect(f("2001:db8:0:1:1:1:1:1")).toBe("2001:db8:0:1:1:1:1:1"); // one zero group stays
    expect(f("::ffff:192.0.2.1")).toBe("::ffff:192.0.2.1");
    expect(f("::1")).toBe("::1");
    expect(expandIpv6(parseIpv6("::1"))).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    expect(() => parseIpv6("1::2::3")).toThrow();
    expect(() => parseIpv6("1:2:3:4:5:6:7")).toThrow();
  });

  test("kinds of address", () => {
    expect(ipv6Kind(parseIpv6("fe80::1"))).toBe("link-local unicast");
    expect(ipv6Kind(parseIpv6("fd12::1"))).toBe("unique local (ULA)");
    expect(ipv6Kind(parseIpv6("2001:db8::1"))).toBe("documentation");
    expect(ipv6Kind(parseIpv6("2606:4700::1"))).toBe("global unicast");
    expect(ipv6Kind(parseIpv6("ff02::1"))).toBe("multicast");
  });

  test("header chains: a Fragment header makes 48 bytes of IP headers", () => {
    expect(IPV6_HEADER_BYTES).toBe(40);
    const c = extensionChain(["fragment"], 6);
    expect(c.headerBytes).toBe(48);
    expect(c.firstNextHeader).toBe(44);
    const all = extensionChain(["dest2", "hbh", "routing"], 17);
    expect(all.chain.map((x) => x.nh)).toEqual([41, 0, 43, 60, 17]); // sorted into RFC 8200 order
  });
});

describe("CIDR", () => {
  test("subnet facts", () => {
    const a = subnetInfo(parseIpv4("192.168.1.130"), 24);
    expect(formatIpv4(a.network)).toBe("192.168.1.0");
    expect(formatIpv4(a.broadcast)).toBe("192.168.1.255");
    expect(a.hosts).toBe(254);
    expect(subnetInfo(0, 30).hosts).toBe(2);
    expect(subnetInfo(0, 31).hosts).toBe(2);
    expect(subnetInfo(0, 32).hosts).toBe(1);
    expect([24, 25, 26, 27].map((n) => subnetInfo(0, n).hosts)).toEqual([254, 126, 62, 30]);
    expect([8, 16, 24].map(prefixSize)).toEqual([16_777_216, 65_536, 256]);
    expect(RFC1918_ADDRESSES).toBe(17_891_328);
    expect(prefixSize(10)).toBe(4_194_304);
    expect(prefixSize(0)).toBe(4_294_967_296);
    expect(2 ** (64 - 48)).toBe(65_536);
    expect(specialRange(parseIpv4("100.72.5.9"))?.rfc).toBe("RFC 6598");
    expect(specialRange(parseIpv4("8.8.8.8"))).toBeUndefined();
  });

  test("aggregation: four /24s make a /22; a hole splits it", () => {
    const four = ["198.51.96.0/24", "198.51.97.0/24", "198.51.98.0/24", "198.51.99.0/24"].map(parseCidr);
    expect(aggregate(four).map(formatCidr)).toEqual(["198.51.96.0/22"]);
    const seven = [0, 1, 2, 3, 4, 5, 7].map((i) => parseCidr(`10.20.${i}.0/24`));
    expect(aggregate(seven).map(formatCidr)).toEqual(["10.20.0.0/22", "10.20.4.0/23", "10.20.7.0/24"]);
  });

  test("aggregation covers exactly the same addresses (random check)", () => {
    const rnd = mulberry32(3);
    for (let k = 0; k < 200; k++) {
      const ps = Array.from({ length: 6 }, () => ({ net: (0x0a000000 + Math.floor(rnd() * 64) * 256) >>> 0, len: 22 + Math.floor(rnd() * 3) }));
      const agg = aggregate(ps);
      for (let i = 0; i < 64; i++) {
        const addr = (0x0a000000 + i * 256 + 7) >>> 0;
        const inA = ps.some((p) => ((addr ^ p.net) >>> (32 - p.len)) === 0 || p.len === 0);
        const inB = agg.some((p) => ((addr ^ p.net) >>> (32 - p.len)) === 0 || p.len === 0);
        expect(inB).toBe(inA);
      }
    }
  });

  test("VLSM: 100, 50, 20 and 2 hosts from a /24", () => {
    const a = vlsm(parseCidr("10.20.0.0/24"), [{ name: "a", hosts: 100 }, { name: "b", hosts: 50 }, { name: "c", hosts: 20 }, { name: "d", hosts: 2 }]);
    expect(a.map((x) => formatCidr(x.prefix!))).toEqual(["10.20.0.0/25", "10.20.0.128/26", "10.20.0.192/27", "10.20.0.224/30"]);
    expect(a.map((x) => x.waste)).toEqual([26, 12, 10, 0]);
  });

  test("trie LPM equals a linear scan, and walks at most 32 bits", () => {
    const rnd = mulberry32(11);
    const routes = Array.from({ length: 300 }, (_, i) => ({ prefix: { net: (Math.floor(rnd() * 2 ** 32) >>> 0) & 0xffffff00, len: Math.floor(rnd() * 25) }, value: i }));
    routes.push({ prefix: { net: 0, len: 0 }, value: -1 });
    const t = new PrefixTrie<number>();
    const norm = routes.map((r) => ({ prefix: parseCidr(`${formatIpv4(r.prefix.net)}/${r.prefix.len}`), value: r.value }));
    const last = new Map<string, number>();
    for (const r of norm) last.set(formatCidr(r.prefix), r.value);
    for (const r of norm) t.insert(r.prefix, last.get(formatCidr(r.prefix))!);
    const uniq = [...last].map(([k, v]) => ({ prefix: parseCidr(k), value: v }));
    for (let k = 0; k < 2000; k++) {
      const a = Math.floor(rnd() * 2 ** 32) >>> 0;
      const got = t.lookup(a);
      expect(got.steps).toBeLessThanOrEqual(32);
      expect(got.match && formatCidr(got.match.prefix)).toBe(formatCidr(linearLpm(uniq, a)!.prefix));
    }
  });
});

describe("routing", () => {
  test("count to infinity on a line: 17 advertisements without split horizon, 4 with it", () => {
    const plain = dvRun(DV_LINE, 2, { splitHorizon: false, poisonReverse: false }, 1, DV_LINE_SCHEDULE);
    expect(plain.messages).toBe(17);
    expect(plain.loopSeen).toBe(true);
    expect(plain.frames.at(-1)!.dist).toEqual([16, 16, 0]);
    const sh = dvRun(DV_LINE, 2, { splitHorizon: true, poisonReverse: false }, 1, DV_LINE_SCHEDULE);
    expect(sh.messages).toBe(4);
    expect(sh.loopSeen).toBe(false);
    expect(RIP_INFINITY - 1).toBe(15); // the longest usable RIP path
  });

  test("a three-router loop defeats split horizon and poison reverse (56 advertisements)", () => {
    for (const poisonReverse of [false, true]) {
      const r = dvRun(DV_TRIANGLE, 3, { splitHorizon: true, poisonReverse }, 3, DV_TRIANGLE_SCHEDULE);
      expect(r.loopSeen).toBe(true);
      expect(r.messages).toBe(56);
      expect(r.frames.at(-1)!.dist).toEqual([16, 16, 16, 0]);
    }
  });

  test("Dijkstra settles nodes in order of distance", () => {
    const f = dijkstraSteps(CONV_TOPO, 0);
    const last = f.at(-1)!;
    expect(last.dist).toEqual([0, 1, 2, 1, 2, 3]);
    const order = f.slice(1).map((x) => last.dist[x.settled]!);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("Dijkstra demo: with B–C at cost 10, C is reached through D, E and F at distance 5", () => {
    const f = dijkstraSteps(CONV_TOPO, 0, (i) => (i === 1 ? 10 : CONV_TOPO.links[i]!.cost));
    const last = f.at(-1)!;
    expect(last.dist[2]).toBe(5);
    expect(last.prev[2]).toBe(5);
  });

  test("OSPF cost with a 100 Mbit/s reference", () => {
    expect(ospfCost(10e6)).toBe(10);
    expect(ospfCost(100e6)).toBe(1);
    expect(ospfCost(1e9)).toBe(1);
    expect(ospfCost(10e9)).toBe(1);
    expect(ospfCost(10e9, 100e9)).toBe(10);
  });

  test("link state after a cut with 10 ms detection: 11 packets lost, tables stable 19 ms after the cut", () => {
    const r = convergenceRun({ ...CONV_DEFAULTS });
    expect(r.lost).toBe(11);
    expect(r.convergedAt - CONV_DEFAULTS.cutAt).toBeCloseTo(19, 2);
    expect(pathOf(r.ip as never, 0, 5).path).toEqual([0, 3, 4, 5]);
  });

  test("detection time dominates: every ms of detection loses about one packet (one packet per ms)", () => {
    const a = convergenceRun({ ...CONV_DEFAULTS, detectMs: 0 }).lost;
    const b = convergenceRun({ ...CONV_DEFAULTS, detectMs: 40 }).lost;
    expect(b - a).toBe(40);
  });

  test("plain distance vector, periodic updates only, F cut off: 82 packets circle until TTL 0", () => {
    const r = convergenceRun({ ...CONV_DEFAULTS, proto: "dv", dvMode: "plain", triggered: false, cut: [2, 5] });
    expect(r.looped).toBe(82);
    const s = convergenceRun({ ...CONV_DEFAULTS, proto: "dv", dvMode: "poison", triggered: false, cut: [2, 5] });
    expect(s.looped).toBe(0);
  });
});

describe("BGP", () => {
  const base: Candidate[] = [
    { name: "1", localPref: 100, asPath: [65001, 65010], origin: "IGP", med: 0, ebgp: true, igpCost: 10, routerId: 1 },
    { name: "2", localPref: 100, asPath: [65002, 65020, 65010], origin: "IGP", med: 0, ebgp: true, igpCost: 10, routerId: 2 },
    { name: "3", localPref: 100, asPath: [65001, 65010], origin: "IGP", med: 20, ebgp: false, igpCost: 5, routerId: 3 },
  ];
  test("decision: route 1 wins on MED; LOCAL_PREF beats everything; prepending moves traffic", () => {
    let d = bgpDecision(base);
    expect(d.winner).toBe(0);
    expect(d.steps.findIndex((s) => s.left.length === 1)).toBe(3);
    d = bgpDecision(base.map((c, i) => (i === 1 ? { ...c, localPref: 150 } : c)));
    expect(d.winner).toBe(1);
    expect(d.steps.findIndex((s) => s.left.length === 1)).toBe(0);
    const pre = (n: number) => base.map((c) => (c.asPath[0] === 65001 ? { ...c, asPath: [65001, ...Array(n).fill(65010), 65010] } : c));
    const d1 = bgpDecision(pre(1));
    expect(d1.winner).toBe(0); // tie on length; MED removes route 3; the BGP identifier decides (rule 7)
    expect(d1.steps.findIndex((s) => s.left.length === 1)).toBe(6);
    const d4 = bgpDecision(base.map((c, i) => (i === 0 ? { ...c, med: 50 } : c)));
    expect(d4.steps[3]!.removed).toEqual([0]);
    expect(d4.winner).toBe(2); // route 3 wins at rule 4 (route 2 already lost on path length)
    expect(d4.steps.findIndex((s) => s.left.length === 1)).toBe(3);
    expect(bgpDecision(pre(2)).winner).toBe(1);
  });

  test("ROV states", () => {
    const roas = [{ prefix: parseCidr("198.51.100.0/22"), maxLength: 22, asn: 6 }];
    expect(rov(roas, parseCidr("198.51.100.0/22"), 6)).toBe("valid");
    expect(rov(roas, parseCidr("198.51.100.0/22"), 10)).toBe("invalid");
    expect(rov(roas, parseCidr("198.51.100.0/24"), 6)).toBe("invalid");
    expect(rov(roas, parseCidr("203.0.113.0/24"), 6)).toBe("notfound");
  });

  test("Gao-Rexford: every best path in the normal case is valley-free", () => {
    const s = propagate(LESSON_GRAPH, [{ by: 6, prefix: parseCidr("198.51.100.0/22") }]);
    for (const [asn, m] of s.best) for (const r of m.values()) expect(valleyFree(LESSON_GRAPH, [asn, ...r.path])).toBe(true);
  });

  test("scenario numbers the lesson quotes", () => {
    const none = new Set<number>(), transit = new Set([1, 2, 3, 4, 5]);
    expect(runScenario("normal", none).reachVictim).toBe(9);
    expect(runScenario("hijack", none).captured).toBe(4);
    expect(runScenario("subprefix", none).captured).toBe(9);
    expect(runScenario("subprefix", transit).captured).toBe(0);
    expect(runScenario("forged", none).captured).toBe(9);
    expect(runScenario("forged", transit, 22).captured).toBe(0);
    expect(runScenario("forged", transit, 24).captured).toBe(9); // maxLength /24 makes the forged /24 valid
    expect(runScenario("subprefix", transit, 24).captured).toBe(0); // the wrong origin is still invalid
    expect(runScenario("leak", none).viaLeaker).toBe(6);
    expect(runScenario("leak", transit).viaLeaker).toBe(6); // ROV does not stop leaks
    expect(runScenario("subprefix", new Set([5])).captured).toBe(0);
    expect(runScenario("subprefix", new Set([1, 2])).captured).toBe(3); // partial ROV: AS5 and its customers are still captured
  });
});

describe("NAT", () => {
  test("mapping and filtering behaviours", () => {
    const X = { ip: 1, port: 443 }, X2 = { ip: 1, port: 8080 }, Y = { ip: 2, port: 443 };
    const inside = { ip: 10, port: 5000 };
    const mk = (mapping: MappingBehavior, filtering: FilteringBehavior) => new Nat({ ...NAT_DEFAULTS, publicIp: 99, mapping, filtering });
    const eim = mk("eim", "apdf");
    expect(eim.outbound(0, inside, X).ext).toBe(eim.outbound(1, inside, Y).ext);
    const apdm = mk("apdm", "apdf");
    expect(apdm.outbound(0, inside, X).ext).not.toBe(apdm.outbound(1, inside, X2).ext);
    const p = mk("eim", "apdf");
    const ext = p.outbound(0, inside, X).ext;
    expect(p.inbound(1, X, ext).ok).toBe(true);
    expect(p.inbound(1, X2, ext)).toEqual({ ok: false, reason: "filtered" });
    const a = mk("eim", "adf");
    a.outbound(0, inside, X);
    expect(a.inbound(1, X2, ext).ok).toBe(true);
    expect(a.inbound(1, Y, ext).ok).toBe(false);
    expect(p.inbound(200_000, X, ext)).toEqual({ ok: false, reason: "no mapping" }); // expired after 120 s idle
  });

  test("port preservation: H1 keeps 5000, H2 gets 40000 (the demo's default history)", () => {
    const n = new Nat({ ...NAT_DEFAULTS, publicIp: 99, preservePort: true });
    const X = { ip: 1, port: 443 };
    expect(n.outbound(0, { ip: 10, port: 5000 }, X).ext).toBe(5000);
    expect(n.outbound(1, { ip: 11, port: 5000 }, X).ext).toBe(40000);
  });

  test("carrier-grade NAT port budget: 64,512 ports, 63 subscribers with 1,024 each", () => {
    expect(NAT_PORTS).toBe(64_512);
    expect(subscribersPerIp(1024)).toBe(63);
    expect(subscribersPerIp(2000)).toBe(32);
  });

  test("hole punching: 13 of 16 classic pairs get a direct path", () => {
    const types: [MappingBehavior, FilteringBehavior][] = [["eim", "eif"], ["eim", "adf"], ["eim", "apdf"], ["apdm", "apdf"]];
    const m = types.map(([am, af]) => types.map(([bm, bf]) => holePunch({ mapping: am, filtering: af }, { mapping: bm, filtering: bf }).direct));
    expect(m.flat().filter(Boolean).length).toBe(13);
    expect(m[3]![3]).toBe(false); // symmetric–symmetric
    expect(m[2]![3]).toBe(false); // port-restricted–symmetric
    expect(m[1]![3]).toBe(true); // restricted–symmetric
    expect(classicName("apdm", "apdf")).toBe("symmetric");
  });
});

describe("ICMP", () => {
  test("an ICMP error is 56 bytes on the wire; message checksums verify", () => {
    expect(ICMP_ERROR_BYTES).toBe(56);
    for (const k of ["echo", "echoReply", "timeExceeded", "portUnreachable", "fragNeeded"] as const) {
      const m = icmpBytes(k);
      expect(internetChecksum(m.bytes)).toBe(0);
    }
    expect(icmpBytes("timeExceeded").bytes.length).toBe(36);
  });

  test("classic traceroute over ECMP invents 4 links and 2 loops; Paris traceroute none", () => {
    const c = traceroute({ paris: false });
    expect(c.reached).toBe(true);
    expect(c.falseLinks.filter(([a, b]) => a !== b).length).toBe(4);
    expect(c.falseLinks.filter(([a, b]) => a === b).length).toBe(2);
    const p = traceroute({ paris: true });
    expect(p.falseLinks.length).toBe(0);
    expect(p.hops.length).toBe(5);
  });

  test("a rate-limited router shows stars that are not loss", () => {
    const t = traceroute({ paris: true, rateLimit: [{ node: 5, gapMs: 100 }] });
    expect(t.hops[2]!.probes.map((p) => p.from)).toEqual([5, null, null]);
  });

  test("path MTU discovery numbers", () => {
    const ok = pmtuRun();
    expect(ok.done).toBe(true);
    expect(ok.icmpSeen).toBe(4);
    expect(ok.finalMss).toBe(1360);
    expect(Math.round(ok.endAt)).toBe(182);
    const hole = pmtuRun({ blockIcmp: true });
    expect(hole.done).toBe(false);
    expect(hole.timeouts).toBe(7);
    expect(hole.endAt / 1000).toBeCloseTo(25.4, 1);
    const probe = pmtuRun({ blockIcmp: true, probing: true });
    expect(probe.done).toBe(true);
    expect(Math.round(probe.endAt)).toBe(402);
    expect(Math.round(pmtuRun({ clamp: true }).endAt)).toBe(152);
    const frag = pmtuRun({ noDf: true });
    expect(frag.done).toBe(true);
    expect(frag.ip.log.find((l) => l.what === "fragmented")?.detail).toBe("2 fragments");
  });
});
