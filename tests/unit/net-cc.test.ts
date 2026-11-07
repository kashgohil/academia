/** The congestion-control and QUIC sims of the transport module (src/sims/net/cc): behaviour, not lesson numbers. */
import { describe, expect, test } from "vitest";
import {
  Bbr, CUBIC_ALPHA, CcRun, Cubic, Fixed, Flow, Reno, bdpPackets, ccHandlers, cubicK, cubicW, delivery, holSummary, mathisMbps,
  protect, quicTransfer, runScenario, sampleOf, setupRun, shortHeaderFields, toyMask, unprotect, type AckInfo, type CcMsg,
} from "@/sims/net/cc";
import { PacketNet, packFields } from "@/sims/net";

const ack = (o: Partial<AckInfo>): AckInfo => ({ now: 0, acked: 1, losses: 0, rtt: 40, srtt: 40, minRtt: 40, inflight: 10, delivered: 0, inRecovery: false, ece: false, ...o });

describe("controllers", () => {
  test("Reno: slow start adds one packet per ACK, avoidance one per window, a loss halves the flight", () => {
    const r = new Reno();
    for (let i = 0; i < 10; i++) r.onAck(ack({}));
    expect(r.cwnd).toBe(20);
    r.onCongestion(0, 20);
    expect(r.cwnd).toBe(10);
    expect(r.ssthresh).toBe(10);
    for (let i = 0; i < 10; i++) r.onAck(ack({}));
    expect(r.cwnd).toBeGreaterThan(10.9);
    expect(r.cwnd).toBeLessThan(11);
    r.onRto(0, 12);
    expect([r.cwnd, r.ssthresh]).toEqual([1, 6]);
  });

  test("CUBIC: K, the curve through W_max, α, the 0.7 cut and fast convergence", () => {
    expect(cubicK(100, 70)).toBeCloseTo(Math.cbrt(75), 12);
    expect(cubicW(cubicK(100, 70), 100, cubicK(100, 70))).toBeCloseTo(100, 12);
    expect(cubicW(0, 100, cubicK(100, 70))).toBeCloseTo(70, 9);
    expect(CUBIC_ALPHA).toBeCloseTo(0.5294, 4);
    const c = new Cubic();
    c.cwnd = 100;
    c.onCongestion(0, 100);
    expect(c.cwnd).toBeCloseTo(70);
    expect(c.wMax).toBe(100);
    c.cwnd = 80; // a loss before it regains W_max: fast convergence lowers W_max
    c.onCongestion(0, 80);
    expect(c.wMax).toBeCloseTo(80 * 0.85);
  });

  test("CUBIC grows by the same curve whatever the RTT (in its cubic region)", () => {
    const grow = (rtt: number) => {
      const c = new Cubic();
      c.cwnd = 1000;
      c.onCongestion(0, 1000);
      let t = 0;
      while (t < 5000) {
        t += rtt;
        for (let i = 0; i < Math.round(c.cwnd); i++) c.onAck(ack({ now: t, rtt, srtt: rtt }));
      }
      return c.cwnd;
    };
    const a = grow(20), b = grow(100);
    expect(Math.abs(a - b) / a).toBeLessThan(0.05);
  });
});

describe("the sender", () => {
  const pair = (seed = 1) => {
    let flows: Flow[] = [];
    const net = new PacketNet<CcMsg>(2, { seed, record: false }, ccHandlers(() => flows));
    net.connect(0, 1, { rate: 10e6, delay: 10 });
    return { net, setFlows: (f: Flow[]) => (flows = f) };
  };

  test("a fixed window with no loss delivers everything once, at the window rate", () => {
    const { net, setFlows } = pair();
    const f = new Flow(net, { id: 0, src: 0, dst: 1, cc: new Fixed(5), packets: 200 });
    setFlows([f]);
    f.start();
    net.runAll();
    expect([f.rcvUnique, f.rcvDup, f.retrans, f.una]).toEqual([200, 0, 0, 200]);
  });

  test("a dropped packet is found by SACK and sent again; the receiver gets every packet once", () => {
    const { net, setFlows } = pair();
    const f = new Flow(net, { id: 0, src: 0, dst: 1, cc: new Reno(), packets: 300 });
    setFlows([f]);
    let dropped = false;
    net.dropIf = (p) => p.payload.k === "data" && p.payload.seq === 40 && !dropped && (dropped = true);
    f.start();
    net.runAll();
    expect([f.rcvUnique, f.rcvDup, f.retrans, f.congestionEvents, f.timeouts]).toEqual([300, 0, 1, 1, 0]);
  });

  test("a lost tail packet needs the RTO, which is at least 200 ms", () => {
    const { net, setFlows } = pair();
    const f = new Flow(net, { id: 0, src: 0, dst: 1, cc: new Reno(), packets: 10 });
    setFlows([f]);
    let doneAt = 0;
    net.dropIf = (p) => p.payload.k === "data" && p.payload.seq === 9 && p.payload.tx === 9;
    f.onFirstArrival = (s, t) => { if (s === 9) doneAt = t; };
    f.start();
    net.runAll();
    expect(f.timeouts).toBe(1);
    expect(doneAt).toBeGreaterThan(200);
  });

  test("runs are deterministic", () => {
    const sc = { mbps: 10, rttMs: 40, queue: 20, flows: [{ cc: "cubic" as const }, { cc: "reno" as const, rttMs: 60 }], durationMs: 5000, loss: 0.001, jitterMs: 1 };
    expect(runScenario(sc)).toEqual(runScenario(sc));
  });

  test("slicing a run gives the same result as running it at once", () => {
    const sc = { mbps: 10, rttMs: 40, queue: 20, flows: [{ cc: "bbr" as const }], durationMs: 4000 };
    const a = new CcRun(sc);
    for (let t = 500; t <= 4000; t += 500) a.runTo(t);
    expect(a.result()).toEqual(new CcRun(sc).runTo(4000).result());
  });
});

describe("whole runs", () => {
  test("Reno against random loss follows the Mathis formula within 15%", () => {
    for (const p of [1e-3, 1e-2]) {
      const r = runScenario({ mbps: 100, rttMs: 100, queue: 1000, flows: [{ cc: "reno" }], durationMs: 30000, warmupMs: 5000, loss: p, seed: 3 });
      expect(Math.abs(r.flows[0]!.goodputMbps / mathisMbps(p, 100) - 1)).toBeLessThan(0.15);
    }
  });

  test("BBR learns the path: BtlBw = the link rate, RTprop = the base RTT, ProbeRTT about every 10 s", () => {
    const run = new CcRun({ mbps: 10, rttMs: 40, queue: 66, flows: [{ cc: "bbr" }], durationMs: 25000, sampleMs: 10 });
    run.runTo(25000);
    const bbr = run.flows[0]!.cc as Bbr;
    expect(bbr.btlBw * 1500 * 8 / 1000).toBeCloseTo(10, 1);
    expect(bbr.rtProp).toBeGreaterThan(40);
    expect(bbr.rtProp).toBeLessThan(42);
    const probes = run.samples.filter((s, i) => s.flows[0]!.state === "ProbeRTT" && run.samples[i - 1]?.flows[0]!.state !== "ProbeRTT").map((s) => s.t);
    expect(probes.length).toBe(2);
    expect(probes[1]! - probes[0]!).toBeGreaterThan(10000);
    expect(probes[1]! - probes[0]!).toBeLessThan(10600); // 10 s after the end of the last ProbeRTT
  });

  test("DCTCP with ECN keeps the queue near K and drops nothing", () => {
    const r = runScenario({ mbps: 10, rttMs: 40, queue: 100, ecnK: 10, flows: [{ cc: "dctcp" }], durationMs: 20000, warmupMs: 5000 });
    expect(r.drops).toBe(0);
    expect(r.utilisation).toBeGreaterThan(0.95);
    expect(r.meanQueueMs / 1.2).toBeLessThan(15); // queue packets = ms / 1.2 at 10 Mbit/s
  });

  test("BDP in packets", () => {
    expect(bdpPackets(10, 40)).toBeCloseTo(33.33, 2);
    expect(bdpPackets(100, 60)).toBe(500);
  });
});

describe("QUIC models", () => {
  test("delivery: one byte stream waits for every gap, streams wait only for their own", () => {
    const arrival = [1, 2, 10, 3, 4, 5];
    expect(delivery(arrival, 2, true)).toEqual([1, 2, 10, 10, 10, 10]);
    expect(delivery(arrival, 2, false)).toEqual([1, 2, 10, 3, 10, 5]);
    expect(holSummary(arrival, 2, false).blocked).toBe(1);
  });

  test("RFC 9002 loss detection: packet threshold, time threshold, PTO; each chunk is delivered", () => {
    const r = quicTransfer({ chunks: 12, rttMs: 40, mbps: 10, gapMs: 1, drop: [3, 11] });
    const lost = r.packets.filter((p) => p.lostAt !== undefined).map((p) => [p.pn, p.lostBy]);
    expect(lost).toEqual([[3, "packet threshold"], [11, "time threshold"]]);
    expect(r.arrival.every(Number.isFinite)).toBe(true);
    const tail = quicTransfer({ chunks: 12, rttMs: 40, mbps: 10, gapMs: 1, drop: [11] });
    expect(tail.events.filter((e) => e.kind === "pto").length).toBe(1);
    expect(new Set(tail.packets.map((p) => p.pn)).size).toBe(tail.packets.length); // numbers never repeat
  });

  test("handshakes: RTTs to the first byte", () => {
    const rtts = (kind: Parameters<typeof setupRun>[0]["kind"], certBytes = 3000) => Math.round(setupRun({ kind, rttMs: 50, certBytes }).rtts);
    expect([rtts("tcp-tls12"), rtts("tcp-tls13"), rtts("tcp-tls13-0rtt"), rtts("tfo-tls13-0rtt"), rtts("quic"), rtts("quic-0rtt")]).toEqual([4, 3, 2, 1, 2, 1]);
    expect(rtts("quic", 6000)).toBe(3); // the anti-amplification limit costs a round trip
  });

  test("0-RTT replay runs the request twice unless the server has anti-replay protection", () => {
    expect(setupRun({ kind: "quic-0rtt", rttMs: 50, replay: true }).executions).toBe(2);
    expect(setupRun({ kind: "quic-0rtt", rttMs: 50, replay: true, antiReplay: true }).executions).toBe(1);
    expect(setupRun({ kind: "quic", rttMs: 50, replay: true }).executions).toBe(1);
  });

  test("header protection: only the low 5 bits of byte 0 and the packet number change, and it reverses", () => {
    const h = { spin: 1 as const, keyPhase: 1 as const, pnLen: 2 as const, dcid: Uint8Array.from([1, 2, 3, 4]), pn: 0x1234 };
    const plain = packFields(shortHeaderFields(h));
    expect(plain[0]).toBe(0b0110_0101);
    const mask = toyMask(7, sampleOf(Uint8Array.from({ length: 20 }, (_, i) => i * 13)));
    const wire = protect(h, mask);
    expect(wire[0]! & 0xe0).toBe(plain[0]! & 0xe0);
    expect([...wire.slice(1, 5)]).toEqual([1, 2, 3, 4]);
    const back = unprotect(wire, 4, mask);
    expect(back.pnLen).toBe(2);
    expect([...back.header]).toEqual([...plain]);
  });
});

