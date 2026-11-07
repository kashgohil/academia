/**
 * TCP over TCP: a VPN that carries its tunnel in a TCP connection (OpenVPN with proto tcp, SSH tunnels, some
 * "stealth" VPNs) against one that carries it in UDP (WireGuard, IPsec with NAT-T, OpenVPN over UDP).
 *
 * Topology: hostA — gwA ═ lossy WAN ═ gwB — hostB. An inner TCP connection runs from hostA to hostB. The gateways
 * wrap each inner packet: in a UDP datagram (a lost datagram is simply lost; the inner TCP repairs it), or in the byte
 * stream of one outer TCP connection between the gateways (the outer TCP repairs every loss, in order, before any
 * later inner packet comes out). Both TCPs are the reference TCP of ../transport with a Reno controller.
 *
 * A tunnel gateway has a bounded queue (`tunBuf`, a model input like a tun device's txqueuelen): an inner packet that
 * finds it full is dropped. The point to see: with an outer TCP, a loss on the WAN stalls every inner packet behind
 * it for at least one outer retransmission, the inner RTT jumps, the inner retransmission timer can fire for data
 * that was never lost, and both TCPs back off at once.
 */
import { PacketNet, type Packet } from "../packet";
// Note: inner packets are TCP segments of the bulk flow or voice packets; both cross the tunnel the same way.
import { TcpStack, type AckSample, type CongestionControl, type LossSignal, type TcpConn, type TcpSegment } from "../transport";

/** NewReno-style congestion control for the reference TCP (RFC 5681): slow start, +1 MSS per RTT, halve on loss, 1 MSS after a timeout. */
export class RenoCc implements CongestionControl {
  readonly name = "Reno";
  cwnd: number;
  ssthresh = Infinity;
  private mss = 1460;
  constructor(iw = 10) {
    this.cwnd = iw * 1460;
  }
  init(mss: number) {
    this.cwnd = (this.cwnd / 1460) * mss;
    this.mss = mss;
  }
  onAck(a: AckSample) {
    if (a.inRecovery) return;
    if (this.cwnd < this.ssthresh) this.cwnd += a.ackedBytes;
    else this.cwnd += (this.mss * a.ackedBytes) / this.cwnd;
  }
  onLoss(l: LossSignal) {
    this.ssthresh = Math.max(l.inflight / 2, 2 * this.mss);
    this.cwnd = l.kind === "rto" ? this.mss : this.ssthresh;
  }
}

export type TunnelTransport = "udp" | "tcp";

export interface MeltdownOpts {
  tunnel: TunnelTransport;
  /** Random loss on the WAN link, per packet. */
  loss: number;
  /** WAN rate in Mbit/s and one-way delay in ms (model inputs). */
  mbps?: number;
  delay?: number;
  /** Run length in ms. */
  durationMs?: number;
  /** Bytes the tunnel may hold per direction before it drops inner packets (a model input). */
  tunBuf?: number;
  /** Run a bulk TCP transfer through the tunnel. */
  bulk?: boolean;
  /** Send a voice stream through the tunnel too. */
  voice?: boolean;
  /** A voice packet later than this is useless to the player (a model input: the player's delay budget). */
  voiceLateMs?: number;
  seed?: number;
}

export const MELTDOWN_DEFAULTS = { mbps: 10, delay: 20, durationMs: 20_000, tunBuf: 64_000, seed: 11, bulk: true, voice: false, voiceLateMs: 150 };

/** Bytes a gateway adds to each inner packet: outer IPv4 + UDP + a 16-byte tunnel header and tag (model input), or a 2-byte length in the TCP stream. */
export const UDP_TUNNEL_OVERHEAD = 20 + 8 + 32;
export const TCP_TUNNEL_FRAMING = 2;

/** A voice packet: 160 bytes of audio every 20 ms (G.711 at 64 kbit/s), plus RTP, UDP and IP headers. */
export interface Voice { proto: "rtp"; seq: number; sentAt: number }
type Inner = TcpSegment | Voice;
type Wrapped = { proto: "tun"; inner: Packet<Inner> };
type Msg = Inner | Wrapped;
export const VOICE_BYTES = 160 + 12 + 8 + 20, VOICE_INTERVAL = 20;

export interface MeltdownRun {
  /** Inner bytes delivered to hostB's application. */
  delivered: number;
  goodputMbps: number;
  /** [t in s, Mbit/s over the last 250 ms]. */
  series: [number, number][];
  /** [t in s, inner smoothed RTT in ms]. */
  rttSeries: [number, number][];
  /** spurious: inner data segments that reached hostB a second time (retransmissions of data that was not lost). */
  inner: { retxSegs: number; timeouts: number; fastRetx: number; spurious: number };
  outer: { retxSegs: number; timeouts: number };
  /** Inner packets the tunnel dropped because its queue was full. */
  tunDrops: number;
  /** Packets the WAN lost. */
  wanLosses: number;
  maxInnerRttMs: number;
  /** [send time in s, one-way delay in ms] of each voice packet that arrived. */
  voiceDelay: [number, number][];
  voice: { sent: number; arrived: number; late: number; lost: number };
}

const HA = 0, GA = 1, GB = 2, HB = 3;

export function meltdownRun(opts: MeltdownOpts): MeltdownRun {
  const o = { ...MELTDOWN_DEFAULTS, ...opts };
  const net = new PacketNet<Msg>(["hostA", "gwA", "gwB", "hostB"], { seed: o.seed, record: false });
  net.connect(HA, GA, { rate: 100e6, delay: 0.5 });
  net.connect(GA, GB, { rate: o.mbps * 1e6, delay: o.delay, loss: o.loss, queueBytes: 100_000 });
  net.connect(GB, HB, { rate: 100e6, delay: 0.5 });
  net.computeRoutes();
  // The inner MSS leaves room for the tunnel headers in a 1500-byte WAN MTU.
  const innerMss = 1500 - 40 - Math.max(UDP_TUNNEL_OVERHEAD, 40 + TCP_TUNNEL_FRAMING);
  const inner = new TcpStack(net, { mss: innerMss, nagle: false, delayedAck: 0, rcvBuf: 1 << 22, rcvBufMax: 1 << 22, timeWait: 0, isn: 0, cc: () => new RenoCc() });
  const outer = new TcpStack(net, { nagle: false, delayedAck: 0, rcvBuf: 1 << 22, rcvBufMax: 1 << 22, timeWait: 0, isn: 0, cc: () => new RenoCc() });
  let wanLosses = 0, tunDrops = 0, dupArrivals = 0, voiceGot = 0, voiceLate = 0, voiceSent = 0;
  const voiceDelay: [number, number][] = [];
  // Outer TCP tunnel state, per direction: the stream offsets where each inner packet ends.
  const q: Record<number, { end: number; pkt: Packet<Inner> }[]> = { [GA]: [], [GB]: [] };
  const wrote: Record<number, number> = { [GA]: 0, [GB]: 0 };
  let outerA: TcpConn | undefined, outerB: TcpConn | undefined;
  const isInner = (p: Packet<Msg>) => (p.src === HA || p.src === HB) && (p.payload as Wrapped).proto !== "tun";
  const peerGw = (g: number) => (g === GA ? GB : GA);
  const hostOf = (g: number) => (g === GA ? HA : HB);
  const forwardOut = (g: number, pkt: Packet<Inner>) => {
    // Re-inject the inner packet on the far side, with its original source.
    const p = net.packet(pkt.src, pkt.dst, pkt.size, pkt.payload as Msg);
    net.transmit(net.portTo(g, hostOf(g)).id, p);
  };
  const encap = (g: number, pkt: Packet<Inner>) => {
    if (o.tunnel === "udp") {
      const port = net.portTo(g, peerGw(g));
      if (port.qBytes + pkt.size > o.tunBuf) {
        tunDrops++;
        return;
      }
      net.send(g, peerGw(g), pkt.size + UDP_TUNNEL_OVERHEAD, { proto: "tun", inner: pkt });
      return;
    }
    const c = g === GA ? outerA : outerB;
    if (!c || !c.synchronized || c.unsent + c.outstanding + pkt.size > o.tunBuf) {
      tunDrops++;
      return;
    }
    wrote[g]! += pkt.size + TCP_TUNNEL_FRAMING;
    q[g]!.push({ end: wrote[g]!, pkt });
    c.write(pkt.size + TCP_TUNNEL_FRAMING);
  };
  const onOuterData = (g: number) => (c: TcpConn) => {
    // Bytes that arrive in order at gateway g came from the other gateway's queue.
    const src = peerGw(g);
    const got = c.stats.delivered;
    const list = q[src]!;
    while (list.length && list[0]!.end <= got) forwardOut(g, list.shift()!.pkt);
  };
  net.setHandlers({
    onReceive(node, pkt) {
      if ((node === GA || node === GB) && isInner(pkt) && pkt.dst !== node) {
        encap(node, pkt as Packet<Inner>);
        return true;
      }
      return false;
    },
    onDeliver(node, pkt) {
      const pl = pkt.payload as Wrapped;
      if (pl.proto === "tun") return forwardOut(node, pl.inner);
      if (node === GA || node === GB) return void outer.deliver(node, pkt);
      if ((pkt.payload as Voice).proto === "rtp") {
        const v = pkt.payload as Voice;
        const d = net.now - v.sentAt;
        voiceDelay.push([v.sentAt / 1000, d]);
        voiceGot++;
        if (d > o.voiceLateMs) voiceLate++;
        return;
      }
      const seg = pkt.payload as TcpSegment;
      // A data segment that brings nothing new: a retransmission of data that had already arrived.
      if (node === HB && rx && seg.len > 0 && seg.info.rseq + seg.len <= rx.rcvNxt) dupArrivals++;
      inner.deliver(node, pkt);
    },
    onTimer(node, tag) {
      if (node === GA || node === GB) outer.timer(node, tag);
      else inner.timer(node, tag);
    },
    onDrop(_pkt, reason) {
      if (reason === "loss") wanLosses++;
    },
  });
  if (o.tunnel === "tcp") {
    outer.listen(GB, 1194, { onAccept: (c) => { outerB = c; c.onData = onOuterData(GB); } });
    outerA = outer.connect(GA, GB, 1194);
    outerA.onData = onOuterData(GA);
  }
  let rx: TcpConn | undefined;
  inner.listen(HB, 80, { onAccept: (c) => (rx = c) });
  const start = o.tunnel === "tcp" ? 200 : 0;
  let tx: TcpConn | undefined;
  if (o.bulk)
    net.at(start, () => {
      tx = inner.connect(HA, HB, 80);
      tx.onEstablished = (c) => c.write(1e10);
    });
  if (o.voice)
    for (let t = start + 1000; t < o.durationMs - 1000; t += VOICE_INTERVAL) {
      const seq = voiceSent++;
      net.at(t, () => net.send(HA, HB, VOICE_BYTES, { proto: "rtp", seq, sentAt: net.now }));
    }
  const series: [number, number][] = [], rttSeries: [number, number][] = [];
  let last = 0, maxRtt = 0;
  const STEP = 250;
  for (let t = STEP; t <= o.durationMs; t += STEP) {
    net.at(t, () => {
      const d = rx?.stats.delivered ?? 0;
      series.push([t / 1000, ((d - last) * 8) / (STEP * 1000)]);
      last = d;
      const srtt = tx?.rtt.srtt;
      if (srtt !== undefined) {
        rttSeries.push([t / 1000, srtt]);
        maxRtt = Math.max(maxRtt, srtt);
      }
    });
  }
  net.runUntil(o.durationMs);
  const delivered = rx?.stats.delivered ?? 0;
  const s = tx?.stats;
  return {
    delivered,
    goodputMbps: (delivered * 8) / ((o.durationMs - start) * 1000),
    series, rttSeries,
    inner: { retxSegs: s?.retxSegs ?? 0, timeouts: s?.timeouts ?? 0, fastRetx: s?.fastRetx ?? 0, spurious: dupArrivals },
    outer: { retxSegs: (outerA?.stats.retxSegs ?? 0) + (outerB?.stats.retxSegs ?? 0), timeouts: (outerA?.stats.timeouts ?? 0) + (outerB?.stats.timeouts ?? 0) },
    tunDrops, wanLosses, maxInnerRttMs: maxRtt,
    voiceDelay, voice: { sent: voiceSent, arrived: voiceGot, late: voiceLate, lost: voiceSent - voiceGot },
  };
}
