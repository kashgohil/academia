/**
 * ICMP at work, on IpNet: messages as bytes, traceroute (classic and Paris) through a load-balanced path, and path
 * MTU discovery with its failure mode, the black hole.
 */
import { internetChecksum, packFields, type Field } from "../bytes";
import type { NodeId, Port } from "../packet";
import { defaultIpv4, ipv4Fields } from "./headers";
import { IpNet, type IpPacket } from "./ipnet";

// ---------------------------------------------------------------- messages as bytes

export type IcmpKind = "echo" | "echoReply" | "timeExceeded" | "portUnreachable" | "fragNeeded";

export const ICMP_KINDS: Record<IcmpKind, { type: number; code: number; name: string; error: boolean }> = {
  echo: { type: 8, code: 0, name: "Echo request", error: false },
  echoReply: { type: 0, code: 0, name: "Echo reply", error: false },
  timeExceeded: { type: 11, code: 0, name: "Time exceeded (TTL)", error: true },
  portUnreachable: { type: 3, code: 3, name: "Destination unreachable: port", error: true },
  fragNeeded: { type: 3, code: 4, name: "Destination unreachable: fragmentation needed", error: true },
};

/** The ICMP header and body as fields. An error quotes the original IP header and its first 8 data bytes (RFC 792). */
export function icmpFields(kind: IcmpKind, o: { id?: number; seq?: number; mtu?: number; checksum?: number } = {}): Field[] {
  const k = ICMP_KINDS[kind];
  const head: Field[] = [
    { name: "Type", bits: 8, value: k.type },
    { name: "Code", bits: 8, value: k.code },
    { name: "Checksum", bits: 16, value: o.checksum ?? 0, note: "covers the whole ICMP message" },
  ];
  if (!k.error) {
    return [...head,
      { name: "Identifier", short: "ID", bits: 16, value: o.id ?? 0x2a, note: "matches replies to one ping process" },
      { name: "Sequence Number", short: "Seq", bits: 16, value: o.seq ?? 1 },
      { name: "Data (timestamp)", short: "Data", bits: 64, value: 0x0000000065a1b2c3n, note: "echoed back unchanged" }];
  }
  const rest: Field[] = kind === "fragNeeded"
    ? [{ name: "Unused", bits: 16, value: 0 }, { name: "Next-Hop MTU", short: "MTU", bits: 16, value: o.mtu ?? 1400, note: "RFC 1191" }]
    : [{ name: "Unused", bits: 32, value: 0 }];
  const orig = ipv4Fields(defaultIpv4({ protocol: 17, ttl: 1, totalLength: 60 })).map((f) => ({ ...f, name: `Original ${f.name}`, short: f.short ?? f.name, note: "quoted from the packet that caused the error" }));
  const udp: Field[] = [
    { name: "Original Source Port", short: "Src port", bits: 16, value: 54321 },
    { name: "Original Destination Port", short: "Dst port", bits: 16, value: 33435 },
    { name: "Original UDP Length", short: "Length", bits: 16, value: 40 },
    { name: "Original UDP Checksum", short: "Checksum", bits: 16, value: 0 },
  ];
  return [...head, ...rest, ...orig, ...udp];
}

/** The message bytes with a correct checksum. */
export function icmpBytes(kind: IcmpKind, o: { id?: number; seq?: number; mtu?: number } = {}): { fields: Field[]; bytes: Uint8Array; checksum: number } {
  const zero = icmpFields(kind, { ...o, checksum: 0 });
  const checksum = internetChecksum(packFields(zero));
  const fields = icmpFields(kind, { ...o, checksum });
  return { fields, bytes: packFields(fields), checksum };
}

// ---------------------------------------------------------------- traceroute

/**
 * S – R1, then two equal-cost branches, R1–A1–A2–R3 (three hops) and R1–B1–R3 (two hops, but the R1–B1 link
 * costs 2), then R3–R4–D. R1 balances flows over both branches by a hash of the flow id, as ECMP routers do.
 */
export const TR_NAMES = ["S", "R1", "A1", "A2", "B1", "R3", "R4", "D"];
export const TR_LINKS: { a: number; b: number; cost: number; delay: number }[] = [
  { a: 0, b: 1, cost: 1, delay: 1 },
  { a: 1, b: 2, cost: 1, delay: 2 }, { a: 2, b: 3, cost: 1, delay: 2 }, { a: 3, b: 5, cost: 1, delay: 2 },
  { a: 1, b: 4, cost: 2, delay: 4 }, { a: 4, b: 5, cost: 1, delay: 2 },
  { a: 5, b: 6, cost: 1, delay: 5 }, { a: 6, b: 7, cost: 1, delay: 1 },
];
export const TR_SRC = 0;
export const TR_DST = 7;
export const TRACEROUTE_PORT = 33434;

export interface TraceOptions {
  /** Paris traceroute keeps the flow id fixed; classic traceroute changes the destination port, so the flow id changes. */
  paris: boolean;
  probesPerHop: number;
  maxTtl: number;
  /** Routers that send no ICMP errors. */
  silent: NodeId[];
  /** Routers that send at most one ICMP error per this many ms (0: no limit). */
  rateLimit: { node: NodeId; gapMs: number }[];
  /** Wait for a reply before the next probe, in ms (a model input). */
  timeoutMs: number;
  /** Time a router takes to build an ICMP error (slow path), in ms (a model input). */
  icmpDelayMs: number;
}

export const TRACE_DEFAULTS: TraceOptions = { paris: false, probesPerHop: 3, maxTtl: 10, silent: [], rateLimit: [], timeoutMs: 60, icmpDelayMs: 0.5 };

export interface Probe {
  ttl: number;
  flow: number;
  dport: number;
  sentAt: number;
  pkt: number;
  from: NodeId | null;
  rtt: number | null;
  /** The ICMP type of the answer: 11 time exceeded, 3 port unreachable. */
  type: number | null;
}

export interface TraceResult {
  ip: IpNet<{ probe: number }>;
  probes: Probe[];
  hops: { ttl: number; probes: Probe[] }[];
  reached: boolean;
  /** Router pairs that the output shows as consecutive hops but that have no link between them. */
  falseLinks: [NodeId, NodeId][];
  /** Every pair of consecutive hops that the output implies. */
  inferredLinks: [NodeId, NodeId][];
}

export function traceroute(o: Partial<TraceOptions> = {}): TraceResult {
  const opt = { ...TRACE_DEFAULTS, ...o };
  const ip = new IpNet<{ probe: number }>(TR_NAMES, { icmpDelayMs: opt.icmpDelayMs });
  for (const l of TR_LINKS) ip.connect(l.a, l.b, { rate: 1e9, delay: l.delay });
  const cost = new Map<number, number>(TR_LINKS.map((l, i) => [i, l.cost]));
  ip.computeRoutes((p: Port) => cost.get(p.link)!);
  for (const s of opt.silent) ip.silent.add(s);
  for (const r of opt.rateLimit) if (r.gapMs > 0) ip.icmpGap.set(r.node, r.gapMs);
  const probes: Probe[] = [];
  let reached = false;
  let current = -1;
  let timer = 0;
  const net = ip.net;
  const next = () => {
    const k = probes.length;
    const ttl = Math.floor(k / opt.probesPerHop) + 1;
    if (ttl > opt.maxTtl || (reached && k % opt.probesPerHop === 0)) return;
    const dport = opt.paris ? TRACEROUTE_PORT + 1 : TRACEROUTE_PORT + 1 + k;
    const flow = opt.paris ? 7 : dport;
    const pkt = ip.send(TR_SRC, TR_DST, 60, { proto: "udp", df: false, dport, app: { probe: k } }, { ttl, flow });
    probes.push({ ttl, flow, dport, sentAt: net.now, pkt: pkt.id, from: null, rtt: null, type: null });
    current = k;
    const my = ++timer;
    net.at(net.now + opt.timeoutMs, () => { if (my === timer && current === k) { current = -1; next(); } });
  };
  ip.onHost = (node, pkt: IpPacket<{ probe: number }>) => {
    if (node !== TR_SRC || pkt.payload.proto !== "icmp" || !pkt.payload.icmp?.orig) return;
    const k = (pkt.payload.icmp.orig.tag as { probe: number } | undefined)?.probe;
    if (k === undefined || k !== current) return;
    const p = probes[k]!;
    p.from = pkt.src;
    p.rtt = net.now - p.sentAt;
    p.type = pkt.payload.icmp.type;
    if (pkt.payload.icmp.type === 3) reached = true;
    current = -1;
    timer++;
    next();
  };
  next();
  net.runAll(100_000);
  const hops: TraceResult["hops"] = [];
  for (const p of probes) {
    if (!hops[p.ttl - 1]) hops[p.ttl - 1] = { ttl: p.ttl, probes: [] };
    hops[p.ttl - 1]!.probes.push(p);
  }
  const real = new Set(TR_LINKS.flatMap((l) => [`${l.a}-${l.b}`, `${l.b}-${l.a}`]));
  const inferred = new Map<string, [NodeId, NodeId]>();
  for (let i = 0; i + 1 < hops.length; i++) {
    const a = new Set(hops[i]!.probes.flatMap((p) => (p.from === null ? [] : [p.from])));
    const b = new Set(hops[i + 1]!.probes.flatMap((p) => (p.from === null ? [] : [p.from])));
    for (const x of a) for (const y of b) inferred.set(`${x}-${y}`, [x, y]);
  }
  const inferredLinks = [...inferred.values()];
  const falseLinks = inferredLinks.filter(([x, y]) => !real.has(`${x}-${y}`));
  return { ip, probes, hops, reached, falseLinks, inferredLinks };
}

// ---------------------------------------------------------------- path MTU discovery

/** Client C – R1 =tunnel= R2 – R3 – FW – server S. The tunnel link R1–R2 has a smaller MTU. */
export const PM_NAMES = ["C", "R1", "R2", "R3", "FW", "S"];
export const PM_C = 0;
export const PM_S = 5;
export const PM_FW = 4;
export const PM_TUNNEL_ROUTER = 2;
export const TCPIP_HEADERS = 40;
/** Linux's tcp_base_mss default: where MTU probing starts after a black hole (a fact about Linux, used as an input). */
export const BASE_MSS = 1024;

export interface PmtuOptions {
  tunnelMtu: number;
  /** The firewall in front of the server drops all ICMP (a common mistake). */
  blockIcmp: boolean;
  /** Packetization-layer probing: after a timeout, fall back to a small MSS (like net.ipv4.tcp_mtu_probing=1). */
  probing: boolean;
  /** The tunnel router rewrites the MSS option in the handshake to fit its MTU (MSS clamping). */
  clamp: boolean;
  /** DF off: routers fragment instead of dropping. */
  noDf: boolean;
  bytes: number;
  /** Segments in flight at most. */
  window: number;
  /** First retransmission timeout, in ms (a model input; it doubles after each timeout). */
  rtoMs: number;
  maxRetries: number;
  linkDelayMs: number;
  record?: boolean;
}

export const PMTU_DEFAULTS: PmtuOptions = { tunnelMtu: 1400, blockIcmp: false, probing: false, clamp: false, noDf: false, bytes: 14600, window: 4, rtoMs: 200, maxRetries: 6, linkDelayMs: 5 };

type Tcp = { seq?: number; len?: number; ack?: number };

export interface PmtuResult {
  ip: IpNet<Tcp>;
  done: boolean;
  /** Time when the last byte was acknowledged, or when the sender gave up. */
  endAt: number;
  retransmits: number;
  timeouts: number;
  icmpSeen: number;
  /** MSS the sender used at the end. */
  finalMss: number;
  /** [time, mss] each time the sender changed its segment size. */
  mssLog: [number, number][];
}

export function pmtuRun(o: Partial<PmtuOptions> = {}): PmtuResult {
  const opt = { ...PMTU_DEFAULTS, ...o };
  const ip = new IpNet<Tcp>(PM_NAMES, { record: opt.record ?? true });
  for (let i = 0; i + 1 < PM_NAMES.length; i++) ip.connect(i, i + 1, { rate: 100e6, delay: opt.linkDelayMs }, i === 1 ? opt.tunnelMtu : 1500);
  ip.computeRoutes();
  if (opt.blockIcmp) ip.icmpFilter.add(PM_FW);
  const net = ip.net;
  let mss = opt.clamp ? Math.min(1460, opt.tunnelMtu - TCPIP_HEADERS) : 1460;
  const mssLog: [number, number][] = [[0, mss]];
  let una = 0, nxt = 0, rto = opt.rtoMs, retries = 0, timer = 0, retransmits = 0, timeouts = 0, icmpSeen = 0;
  let done = false, failed = false, endAt = 0;
  let maxSent = 0;
  const setMss = (m: number) => {
    if (m === mss) return;
    mss = m;
    mssLog.push([net.now, m]);
  };
  const arm = () => {
    const my = ++timer;
    net.at(net.now + rto, () => {
      if (my !== timer || done || failed) return;
      timeouts++;
      retries++;
      if (retries > opt.maxRetries) {
        failed = true;
        endAt = net.now;
        return;
      }
      rto *= 2;
      if (opt.probing && mss > BASE_MSS) setMss(BASE_MSS);
      nxt = una;
      pump();
      arm();
    });
  };
  const pump = () => {
    while (nxt < opt.bytes && nxt < una + opt.window * mss) {
      const len = Math.min(mss, opt.bytes - nxt);
      if (nxt < maxSent) retransmits++;
      ip.send(PM_S, PM_C, len + TCPIP_HEADERS, { proto: "tcp", df: !opt.noDf, app: { seq: nxt, len } });
      nxt += len;
      maxSent = Math.max(maxSent, nxt);
    }
  };
  // Receiver: cumulative ACKs, keeps out-of-order data.
  let rcv = 0;
  const ooo = new Map<number, number>();
  ip.onHost = (node, pkt) => {
    const d = pkt.payload;
    if (node === PM_C && d.proto === "tcp" && d.app?.seq !== undefined) {
      ooo.set(d.app.seq, d.app.len!);
      while (ooo.has(rcv)) {
        const l = ooo.get(rcv)!;
        ooo.delete(rcv);
        rcv += l;
      }
      ip.send(PM_C, PM_S, TCPIP_HEADERS, { proto: "tcp", df: true, app: { ack: rcv } });
    } else if (node === PM_S && d.proto === "tcp" && d.app?.ack !== undefined) {
      if (d.app.ack > una) {
        una = d.app.ack;
        retries = 0;
        rto = opt.rtoMs;
        if (una >= opt.bytes) {
          done = true;
          endAt = net.now;
          timer++;
          return;
        }
        if (nxt < una) nxt = una;
        pump();
        arm();
      }
    } else if (node === PM_S && d.proto === "icmp" && d.icmp?.type === 3 && d.icmp.code === 4 && d.icmp.mtu) {
      icmpSeen++;
      const m = Math.max(68, d.icmp.mtu) - TCPIP_HEADERS;
      if (m < mss) {
        setMss(m);
        nxt = una;
        pump();
        arm();
      }
    }
  };
  pump();
  arm();
  net.runAll(200_000);
  if (!done && !failed) endAt = net.now;
  return { ip, done, endAt, retransmits, timeouts, icmpSeen, finalMss: mss, mssLog };
}
