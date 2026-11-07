import { describe, expect, test } from "vitest";
import {
  PacketNet, bdpBytes, crc32, dumbbell, fieldBytes, formatIpv4, hex, inPrefix, internetChecksum, packFields,
  parseIpv4, serializationMs, unpackFields, type Field,
} from "../../src/sims/net";

describe("PacketNet timing", () => {
  test("one hop = serialization + propagation; back-to-back packets queue", () => {
    const got: [number, number][] = [];
    const net = new PacketNet<null>(2, {}, { onDeliver: (_n, p, nt) => got.push([p.id, nt.now]) });
    net.connect(0, 1, { rate: 10e6, delay: 5 });
    expect(serializationMs(1500, 10e6)).toBeCloseTo(1.2);
    net.send(0, 1, 1500, null);
    net.send(0, 1, 1500, null);
    net.runAll();
    expect(got[0]![1]).toBeCloseTo(6.2);
    expect(got[1]![1]).toBeCloseTo(7.4);
  });

  test("store and forward: each router adds its own serialization", () => {
    let at = 0;
    const net = new PacketNet<null>(3, {}, { onDeliver: (_n, _p, nt) => (at = nt.now) });
    net.connect(0, 1, { rate: 8e6, delay: 1 });
    net.connect(1, 2, { rate: 8e6, delay: 1 });
    net.computeRoutes();
    net.send(0, 2, 1000, null); // 1 ms on each link
    net.runAll();
    expect(at).toBeCloseTo(4);
  });

  test("bdp", () => {
    expect(bdpBytes(100e6, 40)).toBe(500_000);
  });
});

describe("PacketNet queues", () => {
  test("drop-tail: one on the wire, queuePackets wait, the rest drop", () => {
    const drops: string[] = [];
    const net = new PacketNet<null>(2, {}, { onDrop: (_p, r) => drops.push(r) });
    net.connect(0, 1, { rate: 1e6, delay: 1, queuePackets: 2 });
    for (let i = 0; i < 5; i++) net.send(0, 1, 1000, null);
    net.runAll();
    expect(drops).toEqual(["queue", "queue"]);
    expect(net.portTo(0, 1).stats.txPackets).toBe(3);
    expect(net.portTo(0, 1).stats.maxQBytes).toBe(2000);
  });

  test("ECN marks capable packets above the threshold instead of dropping", () => {
    const ce: boolean[] = [];
    const net = new PacketNet<null>(2, {}, { onDeliver: (_n, p) => ce.push(p.ce) });
    net.connect(0, 1, { rate: 1e6, delay: 1, ecnBytes: 1500 });
    for (let i = 0; i < 4; i++) net.send(0, 1, 1000, null, { ect: true });
    net.runAll();
    // Queue bytes seen on arrival: 0 (goes on the wire), 0, 1000, 2000 → only the last is marked.
    expect(ce).toEqual([false, false, false, true]);
  });

  test("dropIf lets the learner be the network", () => {
    const got: number[] = [];
    const net = new PacketNet<number>(2, {}, { onDeliver: (_n, p) => got.push(p.payload) });
    net.connect(0, 1, { rate: 1e9, delay: 1 });
    net.dropIf = (p) => p.payload === 2;
    for (let i = 1; i <= 3; i++) net.send(0, 1, 100, i);
    net.runAll();
    expect(got).toEqual([1, 3]);
    expect(net.hops.filter((h) => h.lost === "filter")).toHaveLength(1);
  });

  test("random loss repeats with the seed", () => {
    const run = (seed: number) => {
      const got: number[] = [];
      const net = new PacketNet<number>(2, { seed }, { onDeliver: (_n, p) => got.push(p.payload) });
      net.connect(0, 1, { rate: 1e9, delay: 1, loss: 0.3 });
      for (let i = 0; i < 50; i++) net.send(0, 1, 100, i);
      net.runAll();
      return got;
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7).length).toBeLessThan(50);
  });
});

describe("PacketNet routing", () => {
  test("computeRoutes picks the lower-delay path and reroutes when a link goes down", () => {
    const path: number[] = [];
    const net = new PacketNet<null>(["A", "B", "C"], {}, { onReceive: (n) => void path.push(n) });
    net.connect(0, 2, { rate: 1e9, delay: 10 }); // link 0: direct but slow
    net.connect(0, 1, { rate: 1e9, delay: 2 }); // link 1
    net.connect(1, 2, { rate: 1e9, delay: 2 }); // link 2
    net.computeRoutes();
    net.send(0, 2, 100, null);
    net.runAll();
    expect(path).toEqual([1, 2]);
    path.length = 0;
    net.setLinkUp(1, false);
    net.computeRoutes();
    net.send(0, 2, 100, null);
    net.runAll();
    expect(path).toEqual([2]);
  });

  test("a routing loop ends when the TTL runs out", () => {
    const drops: string[] = [];
    const net = new PacketNet<null>(3, { ttl: 8 }, { onDrop: (_p, r) => drops.push(r) });
    net.connect(0, 1, { rate: 1e9, delay: 1 });
    net.connect(1, 2, { rate: 1e9, delay: 1 });
    net.setRoute(0, 2, net.portTo(0, 1).id);
    net.setRoute(1, 2, net.portTo(1, 0).id); // B sends it back to A
    net.setRoute(0, 2, net.portTo(0, 1).id);
    net.send(0, 2, 100, null);
    net.runAll();
    expect(drops).toEqual(["ttl"]);
    expect(net.portTo(0, 1).stats.txPackets + net.portTo(1, 0).stats.txPackets).toBe(8);
  });

  test("dumbbell: a saturated bottleneck runs at its rate", () => {
    const d = dumbbell<null>({ pairs: 2, rate: 8e6, delay: 5, queuePackets: 1000, record: false });
    for (let i = 0; i < 200; i++) for (const s of d.senders) d.net.send(s, d.receivers[s]!, 1000, null);
    d.net.runAll();
    const p = d.bottleneckPort;
    expect(p.stats.txPackets).toBe(400);
    expect(p.stats.busyMs).toBeCloseTo(400); // 400 packets × 1 ms
  });
});

describe("bytes", () => {
  test("Internet checksum: RFC 1071 example and a real IPv4 header", () => {
    expect(internetChecksum(new Uint8Array([0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7]))).toBe(0x220d);
    const h = new Uint8Array([0x45, 0x00, 0x00, 0x73, 0x00, 0x00, 0x40, 0x00, 0x40, 0x11, 0x00, 0x00, 0xc0, 0xa8, 0x00, 0x01, 0xc0, 0xa8, 0x00, 0xc7]);
    const c = internetChecksum(h);
    expect(c).toBe(0xb861);
    h[10] = c >> 8;
    h[11] = c & 0xff;
    expect(internetChecksum(h)).toBe(0);
  });

  test("CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("fields pack in network byte order and unpack back", () => {
    const f: Field[] = [
      { name: "Version", bits: 4, value: 4 }, { name: "IHL", bits: 4, value: 5 }, { name: "DSCP", bits: 6 }, { name: "ECN", bits: 2 },
      { name: "Total length", bits: 16, value: 0x73 }, { name: "Address", bits: 48, value: 0x0200_0000_0001n },
    ];
    expect(fieldBytes(f)).toBe(10);
    const b = packFields(f);
    expect(hex(b)).toBe("45 00 00 73 02 00 00 00 00 01");
    expect(unpackFields(f, b)).toEqual([4n, 5n, 0n, 0n, 0x73n, 0x0200_0000_0001n]);
  });

  test("IPv4 text and prefixes", () => {
    const a = parseIpv4("192.168.1.10");
    expect(a).toBe(0xc0a8010a);
    expect(formatIpv4(a)).toBe("192.168.1.10");
    expect(inPrefix(a, parseIpv4("192.168.0.0"), 16)).toBe(true);
    expect(inPrefix(a, parseIpv4("192.168.2.0"), 24)).toBe(false);
    expect(inPrefix(a, 0, 0)).toBe(true);
    expect(() => parseIpv4("256.1.1.1")).toThrow();
  });
});
