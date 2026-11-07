/** The transport module's reference TCP and UDP: protocol behavior, checked on PacketNet runs. */
import { describe, expect, test } from "vitest";
import { PacketNet, internetChecksum, parseIpv4, utf8 } from "../../src/sims/net";
import {
  ACK, FIN, RST, SYN, M32, RtoEstimator, TcpStack, checkCookie, checksumBytes, checksumForNewAddress, cookieFields, fixedSegments, fixedWindow,
  handshakeRun, makeCookie, optionBytes, segmentSize, slowReaderRun, synFloodRun, tcpPair, timeWaitRun, udpChecksum, udpChecksumSteps, udpVerify,
  unwrap, windowShift, wrap, type CongestionControl, type TcpConfig, type TcpSegment,
} from "../../src/sims/net/transport";

const sends = (net: PacketNet<TcpSegment>) => net.trace.flatMap((e) => (e.kind === "send" ? [e] : []));

/** A transfer of `n` bytes from node 0 to node 1; returns both ends after the run. */
function transfer(n: number, link: Parameters<typeof tcpPair>[0], tcp: Partial<TcpConfig> = {}, seed = 1) {
  const { net, stack } = tcpPair(link, { seed, tcp: { timeWait: 0, ...tcp } });
  let srv: ReturnType<TcpStack["connect"]> | undefined;
  stack.listen(1, 80, { conn: tcp, onAccept: (c) => { srv = c; c.onEof = () => c.close(); } });
  const c = stack.connect(0, 1, 80, tcp);
  c.onEstablished = () => { c.write(n); c.close(); };
  net.runUntil(600_000);
  return { net, stack, c, srv: srv! };
}

describe("sequence numbers", () => {
  test("wrap and unwrap across 2³²", () => {
    const iss = M32 - 10;
    expect(wrap(iss, 0)).toBe(M32 - 10);
    expect(wrap(iss, 15)).toBe(5);
    expect(unwrap(5, iss, 12)).toBe(15);
    expect(unwrap(M32 - 1, iss, 12)).toBe(9);
  });

  test("a transfer whose sequence numbers wrap delivers every byte", () => {
    const r = transfer(200_000, { rate: 10e6, delay: 5 }, { isn: M32 - 50_000 });
    expect(r.srv.stats.delivered).toBe(200_000);
    expect(r.c.state).toBe("CLOSED");
    expect(r.srv.reason).toBe("normal");
  });

  test("segment sizes: 40 header bytes, options padded to 4", () => {
    expect(optionBytes({ mss: 1460, wscale: 7, sackOk: true })).toBe(12);
    expect(optionBytes({ sack: [[1, 2], [3, 4]] })).toBe(20);
    const s = { proto: "tcp", sport: 1, dport: 2, seq: 0, ack: 0, flags: ACK, wnd: 0, len: 1460, opts: {}, info: { rseq: 0, rack: 0, retx: 0, why: "data", conn: 1 } } as TcpSegment;
    expect(segmentSize(s)).toBe(1500);
  });
});

describe("RFC 6298 estimator", () => {
  test("first sample, later samples, clamp and backoff", () => {
    const e = new RtoEstimator({ initialRto: 1000, minRto: 0, maxRto: 60_000, granularity: 0 });
    expect(e.rto).toBe(1000);
    e.sample(100);
    expect([e.srtt, e.rttvar, e.rto]).toEqual([100, 50, 300]);
    e.sample(200);
    expect(e.rttvar).toBeCloseTo(0.75 * 50 + 0.25 * 100);
    expect(e.srtt).toBeCloseTo(0.875 * 100 + 0.125 * 200);
    e.backoff();
    e.backoff();
    expect(e.rto).toBeCloseTo(4 * (e.srtt! + 4 * e.rttvar!));
    e.sample(100);
    expect(e.backoffs).toBe(0);
    const linux = new RtoEstimator();
    linux.sample(10);
    expect(linux.rto).toBe(200);
  });

  test("Karn: no RTT sample from a retransmitted segment", () => {
    const { net, stack } = tcpPair({ rate: 10e6, delay: 10 }, { tcp: { timeWait: 0, delayedAck: 0 } });
    stack.listen(1, 80);
    let dropped = false;
    net.dropIf = (p) => !dropped && p.src === 0 && p.payload.len > 0 && (dropped = true);
    const c = stack.connect(0, 1, 80);
    c.onEstablished = () => c.write(1000);
    net.runAll();
    expect(c.stats.timeouts).toBe(1);
    // Only the handshake gave a sample; the retransmitted segment's ACK did not.
    expect(c.rtt.samples).toBe(1);
  });
});

describe("handshake and teardown", () => {
  test("the normal sequence of states on both sides", () => {
    const r = handshakeRun();
    expect(r.conns[0]!.states.map(([, s]) => s)).toEqual(["SYN_SENT", "ESTABLISHED", "FIN_WAIT_1", "FIN_WAIT_2", "TIME_WAIT", "CLOSED"]);
    expect(r.conns[1]!.states.map(([, s]) => s)).toEqual(["SYN_RECEIVED", "ESTABLISHED", "CLOSE_WAIT", "LAST_ACK", "CLOSED"]);
    const first3 = sends(r.net).slice(0, 3).map((e) => e.pkt.payload.flags);
    expect(first3).toEqual([SYN, SYN | ACK, ACK]);
    // The SYN carries MSS, window scale and SACK permitted; the SYN-ACK answers with the same set.
    expect(Object.keys(sends(r.net)[0]!.pkt.payload.opts).sort()).toEqual(["mss", "sackOk", "wscale"]);
  });

  test("simultaneous open: two SYNs, two SYN-ACKs, and a simultaneous close through CLOSING", () => {
    const r = handshakeRun({ scenario: "simultaneous" });
    const syn = sends(r.net).filter((e) => e.pkt.payload.flags & SYN);
    expect(syn.map((e) => e.pkt.payload.flags)).toEqual([SYN, SYN, SYN | ACK, SYN | ACK]);
    for (const c of r.conns) expect(c.states.map(([, s]) => s)).toEqual(["SYN_SENT", "SYN_RECEIVED", "ESTABLISHED", "FIN_WAIT_1", "CLOSING", "TIME_WAIT", "CLOSED"]);
  });

  test("a closed port answers with RST and connect fails", () => {
    const r = handshakeRun({ scenario: "refused" });
    expect(sends(r.net)[1]!.pkt.payload.flags).toBe(RST | ACK);
    expect(r.conns[0]!.reason).toBe("refused");
  });

  test("half-close: the client receives the whole answer in FIN_WAIT_2", () => {
    const r = handshakeRun({ scenario: "halfclose" });
    const c = r.conns[0]!;
    expect(c.stats.delivered).toBe(2 * 1460);
    const fw2 = c.states.find(([, s]) => s === "FIN_WAIT_2")![0];
    const lastData = Math.max(...r.net.trace.filter((e) => e.kind === "deliver" && e.node === 0 && e.pkt.payload.len > 0).map((e) => e.t));
    expect(fw2).toBeLessThan(lastData);
  });

  test("a lost third ACK: the first data segment completes the handshake", () => {
    const r = handshakeRun({ lostAck: true });
    const srv = r.conns[1]!;
    expect(srv.stats.establishedAt).toBeGreaterThan(r.conns[0]!.stats.establishedAt! + 60);
    expect(srv.stats.delivered).toBe(1460);
  });

  test("SYN retries double: 1 s, then 2 s more", () => {
    const r = handshakeRun({ lostSyns: 2 });
    const synTimes = sends(r.net).filter((e) => e.pkt.payload.flags === SYN).map((e) => e.t);
    expect(synTimes).toEqual([0, 1000, 3000]);
  });

  test("connect gives up after tcp_syn_retries", () => {
    const net = new PacketNet<TcpSegment>(2);
    net.connect(0, 1, { rate: 1e6, delay: 1 });
    const stack = new TcpStack(net, { synRetries: 3 }).install();
    net.dropIf = () => true;
    const c = stack.connect(0, 1, 80);
    net.runAll();
    expect(c.reason).toBe("timeout");
    expect(c.stats.closedAt).toBe(1000 + 2000 + 4000 + 8000);
  });

  test("a port in TIME_WAIT cannot be reused; TIME_WAIT re-acknowledges a repeated FIN", () => {
    const r = timeWaitRun("lastAck", true);
    expect(r.serverEnd).toBe("normal");
    expect(timeWaitRun("lastAck", false).serverEnd).toBe("reset");
    const d = timeWaitRun("oldDup", true);
    expect(d.port2).toBe(40001);
    expect(d.corrupted).toBe(0);
    const n = timeWaitRun("oldDup", false);
    expect(n.port2).toBe(40000);
    expect(n.corrupted).toBe(1460);
  });
});

describe("SYN backlog and cookies", () => {
  test("a cookie encodes t, the MSS index and a hash, and expires after two counter steps", () => {
    const c = makeCookie(100_000, 1, 7, 5000, 3, 80, 1460);
    expect(cookieFields(c.isn)).toEqual({ t: 1, idx: 3, hash: c.hash });
    expect(checkCookie(c.isn, 100_000, 1, 7, 5000, 3, 80)).toBe(1460);
    expect(checkCookie(c.isn, 100_000 + 91_000, 1, 7, 5000, 3, 80)).toBe(1460);
    expect(checkCookie(c.isn, 100_000 + 92_000, 1, 7, 5000, 3, 80)).toBeUndefined();
    expect(checkCookie(c.isn, 100_000, 1, 7, 5001, 3, 80)).toBeUndefined();
    expect(checkCookie(c.isn, 100_000, 2, 7, 5000, 3, 80)).toBeUndefined();
    expect(makeCookie(0, 1, 7, 5000, 3, 80, 1220).mss).toBe(536);
  });

  test("a cookie connection works but has no window scaling or SACK", () => {
    const net = new PacketNet<TcpSegment>(2);
    net.connect(0, 1, { rate: 10e6, delay: 5 });
    const stack = new TcpStack(net, { timeWait: 0 }).install();
    const l = stack.listen(1, 80, { synCookies: "always" });
    const c = stack.connect(0, 1, 80);
    c.onEstablished = () => { c.write(20_000); c.close(); };
    net.runAll();
    const s = l.accepted[0]!;
    expect(l.stats.cookiesOk).toBe(1);
    expect(s.stats.delivered).toBe(20_000);
    expect([s.wsOk, s.sackOk, c.wsOk, c.sackOk]).toEqual([false, false, false, false]);
  });

  test("a flood fills the backlog; cookies let real clients in", () => {
    const off = synFloodRun();
    expect(off.halfOpen.some(([, n]) => n === 128)).toBe(true);
    expect(Math.max(...off.halfOpen.map(([, n]) => n))).toBe(128);
    const on = synFloodRun({ cookies: true });
    expect(on.attempts.every((a) => a.done !== undefined && a.done - a.start < 25)).toBe(true);
  });
});

describe("reliability", () => {
  for (const sack of [false, true]) {
    test(`random loss both ways, ${sack ? "with" : "without"} SACK: every byte arrives once and in order`, () => {
      for (const seed of [1, 2, 3]) {
        const r = transfer(150_000, { rate: 10e6, delay: 10, loss: 0.05 }, { sack, cc: () => fixedSegments(16) }, seed);
        expect(r.srv.stats.delivered).toBe(150_000);
        expect(r.srv.stats.corrupted).toBe(0);
        expect(r.c.reason).toBe("normal");
      }
    });
  }

  test("three duplicate ACKs trigger a fast retransmit, before any timeout", () => {
    const { net, stack } = tcpPair({ rate: 10e6, delay: 10 }, { tcp: { timeWait: 0, delayedAck: 0, sack: false, cc: () => fixedSegments(8) } });
    stack.listen(1, 80);
    let n = 0;
    net.dropIf = (p) => p.src === 0 && p.payload.len > 0 && ++n === 2;
    const c = stack.connect(0, 1, 80);
    c.onEstablished = () => c.write(10 * 1460);
    net.runAll();
    expect(c.stats.fastRetx).toBe(1);
    expect(c.stats.timeouts).toBe(0);
    expect(c.stats.retxSegs).toBe(1);
  });

  test("SACK blocks list the out-of-order data, newest block first, at most 4", () => {
    const { net, stack } = tcpPair({ rate: 10e6, delay: 10 }, { tcp: { timeWait: 0, delayedAck: 0, cc: () => fixedSegments(20) } });
    stack.listen(1, 80);
    net.dropIf = (p) => p.src === 0 && p.payload.len > 0 && p.payload.info.retx === 0 && [1, 3, 5, 7, 9, 11].includes(Math.round((p.payload.info.rseq - 1) / 1460) + 1);
    const c = stack.connect(0, 1, 80, { isn: 0 });
    c.onEstablished = () => c.write(14 * 1460);
    net.runAll();
    const acks = sends(net).filter((e) => e.node === 1 && e.pkt.payload.opts.sack);
    expect(Math.max(...acks.map((e) => e.pkt.payload.opts.sack!.length))).toBe(4);
    const after4 = acks.find((e) => e.pkt.payload.opts.sack!.length >= 2)!.pkt.payload.opts.sack!;
    expect(after4[0]![0]).toBeGreaterThan(after4[1]![0]);
    expect(c.stats.timeouts).toBe(0);
  });

  test("a congestion controller limits bytes in flight and hears ACKs and losses", () => {
    const seen = { acks: 0, losses: 0, maxPipe: 0 };
    const cc = (): CongestionControl => ({ name: "probe", cwnd: 3 * 1460, onAck: (a) => { seen.acks++; seen.maxPipe = Math.max(seen.maxPipe, a.inflight); }, onLoss: () => { seen.losses++; } });
    const r = transfer(30 * 1460, { rate: 10e6, delay: 10, loss: 0.03 }, { cc, delayedAck: 0 }, 4);
    expect(r.srv.stats.delivered).toBe(30 * 1460);
    expect(seen.acks).toBeGreaterThan(10);
    expect(seen.losses).toBeGreaterThan(0);
    expect(seen.maxPipe).toBeLessThanOrEqual(3 * 1460);
  });
});

describe("flow control", () => {
  test("window scaling is used only when both SYNs offer it; the shift fits the largest buffer", () => {
    expect([windowShift(65535), windowShift(65536), windowShift(6291456), windowShift(1 << 30), windowShift(2 ** 31)]).toEqual([0, 1, 7, 14, 14]);
    const a = transfer(500_000, { rate: 100e6, delay: 20 }, { rcvBuf: 1 << 20, rcvBufMax: 1 << 20 });
    expect([a.c.wsOk, a.srv.rcvShift]).toEqual([true, 5]);
    const sws = sends(a.net).filter((e) => e.node === 1 && !(e.pkt.payload.flags & SYN));
    expect(Math.max(...sws.map((e) => e.pkt.payload.wnd))).toBe(Math.floor((1 << 20) / 32));
    const net = new PacketNet<TcpSegment>(2);
    net.connect(0, 1, { rate: 100e6, delay: 20 });
    const stack = new TcpStack(net, { timeWait: 0, rcvBuf: 1 << 20, rcvBufMax: 1 << 20 }).install();
    let srv: ReturnType<TcpStack["connect"]> | undefined;
    stack.listen(1, 80, { conn: { windowScaling: false }, onAccept: (c) => (srv = c) });
    const c = stack.connect(0, 1, 80);
    c.onEstablished = () => c.write(300_000);
    net.runAll();
    expect([c.wsOk, srv!.wsOk]).toEqual([false, false]);
    expect(c.maxSndWnd).toBeLessThanOrEqual(65535);
  });

  test("the effective MSS is the smaller of the two; 536 without the option", () => {
    const r = transfer(20_000, { rate: 10e6, delay: 5 }, {});
    expect(r.c.mss).toBe(1460);
    const net = new PacketNet<TcpSegment>(2);
    net.connect(0, 1, { rate: 10e6, delay: 5 });
    const stack = new TcpStack(net, { timeWait: 0 }).install();
    stack.listen(1, 80, { conn: { mss: 1000 } });
    const c = stack.connect(0, 1, 80);
    c.onEstablished = () => c.write(20_000);
    net.runAll();
    expect(c.mss).toBe(1000);
    expect(Math.max(...sends(net).filter((e) => e.node === 0).map((e) => e.pkt.payload.len))).toBe(1000);
  });

  test("a full buffer closes the window; probes use snd.una − 1 and back off; nothing is lost", () => {
    const r = slowReaderRun();
    expect(r.zeroMs).toBeGreaterThan(500);
    const probes = sends(r.net).filter((e) => e.pkt.payload.info.why === "probe");
    expect(probes.length).toBe(r.probes);
    for (const p of probes) {
      // The probe carries an old sequence number; the answer acknowledges the byte after it and shows the window.
      expect(p.pkt.payload.len).toBe(0);
      const answer = sends(r.net).find((e) => e.node === 1 && e.t > p.t)!;
      expect(answer.pkt.payload.info.rack).toBe(p.pkt.payload.info.rseq + 1);
    }
    expect(r.probeTimes[1]! - r.probeTimes[0]!).toBeCloseTo(400, 0);
    expect(r.receiver.stats.readTotal).toBe(120_000);
    // The receiver never holds more than its buffer.
    expect(Math.max(...r.samples.map((s) => s.buffered))).toBeLessThanOrEqual(16384);
  });

  test("lost window updates: only probes reopen the window, and the transfer still completes", () => {
    const r = slowReaderRun({ loseUpdate: true });
    expect(r.probes).toBeGreaterThan(slowReaderRun().probes);
    expect(r.receiver.stats.readTotal).toBe(120_000);
  });

  test("delayed ACK: one ACK for every two full segments", () => {
    const r = transfer(40 * 1460, { rate: 10e6, delay: 10 }, { delayedAck: 40, cc: () => fixedWindow() });
    const dataAcks = sends(r.net).filter((e) => e.node === 1 && e.pkt.payload.len === 0 && !(e.pkt.payload.flags & (SYN | FIN)));
    expect(dataAcks.length).toBeLessThanOrEqual(21);
    expect(dataAcks.length).toBeGreaterThanOrEqual(19);
  });
});

describe("UDP", () => {
  const d = { srcIp: parseIpv4("192.168.1.10"), dstIp: parseIpv4("9.9.9.9"), sport: 51000, dport: 53, data: utf8("hello, dns") };

  test("the checksum covers the pseudo-header; the receiver's sum is 0xffff", () => {
    const c = udpChecksum(d);
    expect(udpVerify(d, c)).toBe("ok");
    expect(internetChecksum(checksumBytes(d, c))).toBe(0);
    expect(udpChecksumSteps(d).checksum).toBe(c);
    expect(udpChecksumSteps(d).steps.length).toBe(10 + 5);
    expect(udpVerify({ ...d, srcIp: parseIpv4("203.0.113.7") }, c)).toBe("bad");
    expect(udpVerify(d, 0)).toBe("none");
  });

  test("every single flipped bit fails; swapped words do not", () => {
    const c = udpChecksum(d);
    for (let i = 0; i < d.data.length * 8; i++) {
      const x = d.data.slice();
      x[i >> 3]! ^= 0x80 >> (i & 7);
      expect(udpVerify({ ...d, data: x }, c)).toBe("bad");
    }
    const swapped = utf8("hello, dns");
    [swapped[0], swapped[1], swapped[2], swapped[3]] = [swapped[2]!, swapped[3]!, swapped[0]!, swapped[1]!];
    expect(udpVerify({ ...d, data: swapped }, c)).toBe("ok");
  });

  test("RFC 1624 incremental update equals a full recomputation", () => {
    const c = udpChecksum(d);
    const nat = { ...d, srcIp: parseIpv4("203.0.113.7") };
    expect(checksumForNewAddress(c, d.srcIp, nat.srcIp)).toBe(udpChecksum(nat));
  });

  test("a computed checksum of 0 is sent as 0xffff", () => {
    // Search a payload whose checksum would be 0.
    let hit: Uint8Array | undefined;
    for (let v = 0; v < 65536 && !hit; v++) {
      const data = new Uint8Array([v >> 8, v & 0xff]);
      if (internetChecksum(checksumBytes({ ...d, data }, 0)) === 0) hit = data;
    }
    expect(hit).toBeDefined();
    expect(udpChecksum({ ...d, data: hit! })).toBe(0xffff);
    expect(udpVerify({ ...d, data: hit! }, 0xffff)).toBe("ok");
  });
});
