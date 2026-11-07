/**
 * UDP (RFC 768): the 8-byte header, the checksum over a pseudo-header, and three small runs on PacketNet:
 *
 * - `udpChecksumSteps`: the checksum word by word, so a demo can show where each 16-bit word comes from.
 * - `sprayRun`: datagrams over two paths of different delay. UDP keeps no order, so they arrive out of order.
 * - `holRun`: a stream of game-state updates over UDP and over TCP with loss. TCP delivers every update in order,
 *   so one loss holds back the updates behind it (head-of-line blocking). UDP loses an update, and the next one replaces it.
 */
import { PacketNet } from "../packet";
import { internetChecksum, packFields, type Field } from "../bytes";
import { fixedWindow } from "./cc";
import { TcpStack, type TcpConn } from "./tcp";
import type { TcpSegment } from "./segment";

export const UDP_HEADER = 8;
export const PROTO_UDP = 17;
export const PROTO_TCP = 6;
/** The largest UDP payload over IPv4: 65 535 − 20 (IPv4 header) − 8 (UDP header). */
export const UDP_MAX_PAYLOAD_V4 = 65535 - 20 - UDP_HEADER;

export interface UdpDatagram {
  srcIp: number;
  dstIp: number;
  sport: number;
  dport: number;
  data: Uint8Array;
}

/** The UDP header fields, for HeaderDiagram. The length counts header + data. */
export function udpFields(d: UdpDatagram, checksum?: number): Field[] {
  return [
    { name: "Source port", bits: 16, value: d.sport, note: "the sender's port; 0 if no reply is wanted" },
    { name: "Destination port", bits: 16, value: d.dport, note: "picks the receiving socket" },
    { name: "Length", bits: 16, value: UDP_HEADER + d.data.length, note: "header plus data, in bytes (at least 8)" },
    { name: "Checksum", bits: 16, value: checksum ?? udpChecksum(d), note: "covers a pseudo-header, the header and the data" },
  ];
}

/** The IPv4 pseudo-header (RFC 768): it is not sent, but it is part of the checksum. */
export function pseudoFieldsV4(srcIp: number, dstIp: number, proto: number, length: number): Field[] {
  return [
    { name: "Source address", bits: 32, value: srcIp },
    { name: "Destination address", bits: 32, value: dstIp },
    { name: "Zero", bits: 8, value: 0 },
    { name: "Protocol", bits: 8, value: proto },
    { name: "UDP length", bits: 16, value: length },
  ];
}

/** The bytes the checksum covers: pseudo-header, header (with `csum` in the checksum field) and data. */
export function checksumBytes(d: UdpDatagram, csum = 0): Uint8Array {
  const len = UDP_HEADER + d.data.length;
  const pseudo = packFields(pseudoFieldsV4(d.srcIp, d.dstIp, PROTO_UDP, len));
  const header = packFields(udpFields(d, csum));
  const all = new Uint8Array(pseudo.length + header.length + d.data.length);
  all.set(pseudo, 0);
  all.set(header, pseudo.length);
  all.set(d.data, pseudo.length + header.length);
  return all;
}

/** The checksum a sender puts in the header. A result of 0 is sent as 0xffff, because 0 means "no checksum". */
export function udpChecksum(d: UdpDatagram): number {
  const c = internetChecksum(checksumBytes(d, 0));
  return c === 0 ? 0xffff : c;
}

/**
 * The receiver's check: the ones' complement sum over everything, checksum included, must be 0xffff.
 * A checksum field of 0 means the sender computed none (allowed in IPv4, not in IPv6).
 */
export function udpVerify(d: UdpDatagram, csum: number): "ok" | "bad" | "none" {
  if (csum === 0) return "none";
  return internetChecksum(checksumBytes(d, csum)) === 0 ? "ok" : "bad";
}

/**
 * RFC 1624 incremental update: the new checksum after one 16-bit word changes from `m` to `m2`,
 * HC' = ~(~HC + ~m + m'). A NAT uses this for the address words, so an error elsewhere stays detectable.
 */
export function checksumUpdate(hc: number, m: number, m2: number): number {
  let sum = (~hc & 0xffff) + (~m & 0xffff) + m2;
  sum = (sum & 0xffff) + (sum >>> 16);
  sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

/** A NAT changes an IPv4 address in the pseudo-header: update the checksum word by word. */
export const checksumForNewAddress = (hc: number, oldIp: number, newIp: number) =>
  checksumUpdate(checksumUpdate(hc, oldIp >>> 16, newIp >>> 16), oldIp & 0xffff, newIp & 0xffff);

export interface ChecksumStep {
  /** Where this word comes from: "pseudo", "header" or "data". */
  part: "pseudo" | "header" | "data";
  label: string;
  word: number;
  /** The running 16-bit ones' complement sum after this word (carries folded back in). */
  sum: number;
  /** True if adding this word carried out of 16 bits. */
  carry: boolean;
}

/** The checksum as a list of 16-bit additions, with the end-around carry shown. */
export function udpChecksumSteps(d: UdpDatagram): { steps: ChecksumStep[]; sum: number; checksum: number } {
  const bytes = checksumBytes(d, 0);
  const labels = ["src addr hi", "src addr lo", "dst addr hi", "dst addr lo", "zero, protocol", "UDP length", "source port", "dest port", "length", "checksum (0)"];
  const steps: ChecksumStep[] = [];
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    const w = (bytes[i]! << 8) | (bytes[i + 1] ?? 0);
    const k = i / 2;
    const raw = sum + w;
    sum = (raw & 0xffff) + (raw >>> 16);
    const part = k < 6 ? "pseudo" : k < 10 ? "header" : "data";
    steps.push({ part, label: labels[k] ?? `data ${k - 9}${i + 1 >= bytes.length ? " (padded)" : ""}`, word: w, sum, carry: raw > 0xffff });
  }
  const c = ~sum & 0xffff;
  return { steps, sum, checksum: c === 0 ? 0xffff : c };
}

// ==================================================================== no ordering: two paths

export interface SprayOptions {
  count: number;
  /** ms between datagrams. */
  gap: number;
  /** One-way delay of path A and path B in ms. */
  delayA: number;
  delayB: number;
  /** Loss on each path. */
  loss: number;
  seed: number;
}

export interface SprayArrival { n: number; sentAt: number; at: number; late: boolean }

/**
 * A sender, a router and a receiver. The router has two links to the receiver and sends datagrams on them in
 * turn (per-packet load balancing). Returns the net (for a space-time diagram) and the arrivals in order.
 */
export function sprayRun(o: SprayOptions) {
  const arrivals: SprayArrival[] = [];
  let turn = 0;
  const net = new PacketNet<{ n: number }>(["sender", "router", "receiver"], { seed: o.seed }, {
    onReceive: (node, pkt, _port, nt) => {
      if (node !== 1) return false;
      const ports = nt.portsAt(1).filter((p) => p.peer === 2);
      nt.transmit(ports[turn++ % 2]!.id, pkt);
      return true;
    },
    onDeliver: (_node, pkt, nt) => {
      const top = arrivals.reduce((m, a) => Math.max(m, a.n), -1);
      arrivals.push({ n: pkt.payload.n, sentAt: pkt.createdAt, at: nt.now, late: pkt.payload.n < top });
    },
  });
  net.connect(0, 1, { rate: 100e6, delay: 1 });
  net.connect(1, 2, { rate: 100e6, delay: o.delayA, loss: o.loss });
  net.connect(1, 2, { rate: 100e6, delay: o.delayB, loss: o.loss });
  net.setRoute(0, 2, net.portTo(0, 1).id);
  for (let i = 0; i < o.count; i++) net.at(i * o.gap, () => net.send(0, 2, 28 + 100, { n: i }));
  net.runAll();
  const late = arrivals.filter((a) => a.late).length;
  return { net, arrivals, late, lost: o.count - arrivals.length, inOrder: arrivals.length - late };
}

// ==================================================================== head-of-line blocking

export interface HolOptions {
  /** Updates per second (a game server sends 20 to 60). */
  hz: number;
  /** Bytes per update (a model input). */
  size: number;
  duration: number;
  /** One-way delay in ms. */
  delay: number;
  /** Loss rate on the server-to-client direction. */
  loss: number;
  seed: number;
}

export interface HolResult {
  /** Per update: generated at, usable at (undefined: lost, UDP only). */
  updates: { n: number; gen: number; at?: number }[];
  /** Latency of each delivered update in ms. */
  latencies: number[];
  lost: number;
  /** Largest age of the newest state the client holds, sampled every ms after the first update. */
  maxStale: number;
  p50: number;
  p99: number;
  max: number;
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

function summarize(updates: HolResult["updates"], dur: number): HolResult {
  const latencies = updates.filter((u) => u.at !== undefined).map((u) => u.at! - u.gen);
  // Staleness: at time t, the client shows the newest update that has arrived; its age is t − gen.
  const byArrival = updates.filter((u) => u.at !== undefined).sort((a, b) => a.at! - b.at!);
  let maxStale = 0, newest = -Infinity, k = 0;
  const start = byArrival[0]?.at ?? 0;
  for (let t = start; t <= dur; t += 1) {
    while (k < byArrival.length && byArrival[k]!.at! <= t) newest = Math.max(newest, byArrival[k++]!.gen);
    maxStale = Math.max(maxStale, t - newest);
  }
  return { updates, latencies, lost: updates.length - latencies.length, maxStale, p50: quantile(latencies, 0.5), p99: quantile(latencies, 0.99), max: Math.max(0, ...latencies) };
}

/** Game-state updates over UDP: each update is one datagram. A lost update is gone; the next one replaces it. */
export function holUdp(o: HolOptions): HolResult & { net: PacketNet<{ n: number }> } {
  const updates: HolResult["updates"] = [];
  const net = new PacketNet<{ n: number }>(["server", "client"], { seed: o.seed }, {
    onDeliver: (_n, pkt, nt) => {
      updates[pkt.payload.n]!.at = nt.now;
    },
  });
  net.connect(0, 1, { rate: 10e6, delay: o.delay, loss: o.loss }, { loss: 0 });
  const period = 1000 / o.hz;
  for (let i = 0; i * period < o.duration; i++) {
    updates.push({ n: i, gen: i * period });
    net.at(i * period, () => net.send(0, 1, 28 + o.size, { n: i }));
  }
  net.runUntil(o.duration + 2000);
  return { ...summarize(updates, o.duration), net };
}

/** The same updates over one TCP connection (TCP_NODELAY, minimum RTO 200 ms). Update k is usable when all bytes up to its end arrived. */
export function holTcp(o: HolOptions): HolResult & { net: PacketNet<TcpSegment>; conn: TcpConn } {
  const updates: HolResult["updates"] = [];
  const net = new PacketNet<TcpSegment>(["server", "client"], { seed: o.seed });
  net.connect(0, 1, { rate: 10e6, delay: o.delay, loss: o.loss }, { loss: 0 });
  const stack = new TcpStack(net, { nagle: false, delayedAck: 0, timeWait: 0, cc: () => fixedWindow() }).install();
  const period = 1000 / o.hz;
  const n = Math.ceil(o.duration / period);
  for (let i = 0; i < n; i++) updates.push({ n: i, gen: i * period });
  stack.listen(1, 7000, {
    onAccept: (c) => {
      c.onData = (cc) => {
        const done = Math.floor(cc.stats.delivered / o.size);
        for (let i = 0; i < Math.min(done, n); i++) if (updates[i]!.at === undefined) updates[i]!.at = net.now;
      };
    },
  });
  const conn = stack.connect(0, 1, 7000);
  // Connect first; the game starts sending once the connection is up (we shift time so that the handshake is not counted).
  while (conn.state !== "ESTABLISHED" && net.step());
  const t0 = net.now;
  for (let i = 0; i < n; i++) {
    updates[i]!.gen = t0 + i * period;
    net.at(t0 + i * period, () => conn.write(o.size));
  }
  net.runUntil(t0 + o.duration + 2000);
  for (const u of updates) {
    u.gen -= t0;
    if (u.at !== undefined) u.at -= t0;
  }
  return { ...summarize(updates, o.duration), net, conn };
}

/** Time until the first response byte for one small request: UDP needs 1 round trip, TCP needs 2 (the handshake first). */
export function firstResponseMs(proto: "udp" | "tcp", delay: number) {
  if (proto === "udp") {
    let at = 0;
    const net = new PacketNet<string>(["client", "server"], {}, {
      onDeliver: (node, _p, nt) => {
        if (node === 1) nt.send(1, 0, 28 + 100, "answer");
        else at = nt.now;
      },
    });
    net.connect(0, 1, { rate: 100e6, delay });
    net.send(0, 1, 28 + 40, "query");
    net.runAll();
    return { at, net };
  }
  const net = new PacketNet<TcpSegment>(["client", "server"]);
  net.connect(0, 1, { rate: 100e6, delay });
  const stack = new TcpStack(net, { timeWait: 0, nagle: false }).install();
  let at = 0;
  stack.listen(1, 53, { onAccept: (c) => (c.onData = () => c.write(100)) });
  const c = stack.connect(0, 1, 53);
  c.onEstablished = () => c.write(40);
  c.onData = () => (at ||= net.now);
  net.runUntil(20 * delay + 500);
  return { at, net };
}

