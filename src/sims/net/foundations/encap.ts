/**
 * Encapsulation on real bytes: an HTTP request inside a TCP segment, inside an IPv4 packet, inside an Ethernet frame.
 *
 * - `buildFrame` packs every header with `packFields` (network byte order), fills the IPv4 header checksum and the
 *   TCP checksum (with its pseudo-header), and appends the Ethernet FCS (CRC-32). The header field lists are the same
 *   lists that HeaderDiagram draws.
 * - `receive` is the receiver's side: it checks the frame in the order a Linux host does (FCS in the NIC, then the
 *   EtherType, then the IPv4 version, length and header checksum, then the TCP checksum) and says which check failed.
 * - `routerForward` is one IPv4 router hop: it checks the frame, lowers the TTL with an incremental checksum update
 *   (RFC 1624), writes new MAC addresses and a new FCS. Bytes changed "in the router's memory" before the new FCS is
 *   computed are invisible to the link check: only the end-to-end checks can catch them.
 *
 * Header sizes are facts from the standards: Ethernet II header 14 bytes and FCS 4 (IEEE 802.3, RFC 894), IPv4
 * header 20 bytes without options (RFC 791), TCP header 20 bytes without options (RFC 9293), the TCP timestamps
 * option 10 bytes plus 2 NOPs (RFC 7323).
 */
import { crc32, fieldBytes, formatIpv4, internetChecksum, packFields, parseIpv4, unpackFields, utf8, type Field } from "../bytes";

export const ETH_HEADER = 14;
export const ETH_FCS = 4;
/** Preamble (7) + start frame delimiter (1), sent before every frame. */
export const ETH_PREAMBLE = 8;
/** The minimum interframe gap: 96 bit times = 12 byte times of silence after every frame. */
export const ETH_IFG = 12;
/** The smallest frame, from the destination MAC to the FCS. Shorter frames are padded. */
export const ETH_MIN_FRAME = 64;
/** The Ethernet payload (the IP packet) limit: the classic MTU. */
export const ETH_MTU = 1500;
export const IPV4_HEADER = 20;
export const IPV6_HEADER = 40;
export const TCP_HEADER = 20;
export const UDP_HEADER = 8;
/** NOP, NOP, then the timestamps option (kind 8, length 10): how Linux pads it to 12 bytes. */
export const TCP_TS_OPTION = 12;
/** The IPv6 fragment extension header (RFC 8200). */
export const IPV6_FRAG_HEADER = 8;
export const IPV6_MIN_MTU = 1280;
export const IPV4_MIN_MTU = 68;

export const ETHERTYPE_IPV4 = 0x0800;
export const PROTO_TCP = 6;
export const PROTO_UDP = 17;

export type LayerName = "preamble" | "eth" | "ip" | "tcp" | "app" | "pad" | "fcs" | "ifg";

/** A byte range of the frame that one layer wrote. */
export interface Span {
  layer: LayerName;
  start: number;
  len: number;
}

export interface FrameSpec {
  path: string;
  host: string;
  srcMac: number[];
  dstMac: number[];
  srcIp: string;
  dstIp: string;
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  ttl: number;
  ipId: number;
  window: number;
  /** Add the TCP timestamps option (12 bytes with padding), as Linux does by default. */
  timestamps: boolean;
}

/**
 * The example request. Addresses come from the documentation ranges (RFC 5737), the MACs are locally administered,
 * and the host name is reserved for examples (RFC 2606). TTL 64 is the Linux default (net.ipv4.ip_default_ttl).
 */
export const DEFAULT_FRAME: FrameSpec = {
  path: "/index.html",
  host: "example.com",
  srcMac: [0x02, 0, 0, 0, 0, 0x01],
  dstMac: [0x02, 0, 0, 0, 0, 0xfe],
  srcIp: "192.0.2.10",
  dstIp: "203.0.113.80",
  srcPort: 49152,
  dstPort: 80,
  seq: 1000,
  ack: 5001,
  ttl: 64,
  ipId: 0x1c46,
  window: 64240,
  timestamps: false,
};

/** The application bytes: a minimal HTTP/1.1 GET with CRLF line ends. */
export const httpGet = (path: string, host: string) => utf8(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: */*\r\n\r\n`);

export function ethFields(dst: number[], src: number[], etherType = ETHERTYPE_IPV4): Field[] {
  return [
    { name: "Destination MAC", short: "dst", bits: 48, value: Uint8Array.from(dst), note: "the next hop's MAC address, found with ARP" },
    { name: "Source MAC", short: "src", bits: 48, value: Uint8Array.from(src), note: "this NIC's address" },
    { name: "EtherType", short: "type", bits: 16, value: etherType, note: "what is inside: 0x0800 is IPv4, 0x86DD is IPv6" },
  ];
}

export function ipv4Fields(o: { totalLength: number; id: number; df: boolean; mf?: boolean; fragOffset?: number; ttl: number; protocol: number; src: number; dst: number; checksum?: number }): Field[] {
  return [
    { name: "Version", short: "ver", bits: 4, value: 4, note: "4 for IPv4" },
    { name: "IHL", bits: 4, value: 5, note: "header length in 32-bit words: 5 means 20 bytes, no options" },
    { name: "DSCP", bits: 6, value: 0, note: "traffic class for quality of service" },
    { name: "ECN", bits: 2, value: 0, note: "explicit congestion notification bits" },
    { name: "Total Length", short: "len", bits: 16, value: o.totalLength, note: "header plus data, in bytes" },
    { name: "Identification", short: "ID", bits: 16, value: o.id, note: "the same for all fragments of one packet" },
    { name: "Reserved", short: "0", bits: 1, value: 0, note: "must be zero" },
    { name: "DF", bits: 1, value: o.df ? 1 : 0, note: "don't fragment: a router drops the packet instead" },
    { name: "MF", bits: 1, value: o.mf ? 1 : 0, note: "more fragments follow" },
    { name: "Fragment Offset", short: "offset", bits: 13, value: o.fragOffset ?? 0, note: "where this fragment's data starts, in units of 8 bytes" },
    { name: "TTL", bits: 8, value: o.ttl, note: "hops left: each router subtracts 1 and drops the packet at 0" },
    { name: "Protocol", short: "proto", bits: 8, value: o.protocol, note: "6 is TCP, 17 is UDP" },
    { name: "Header Checksum", short: "csum", bits: 16, value: o.checksum ?? 0, note: "Internet checksum of the header only" },
    { name: "Source Address", short: "src", bits: 32, value: o.src },
    { name: "Destination Address", short: "dst", bits: 32, value: o.dst },
  ];
}

export function tcpFields(o: { srcPort: number; dstPort: number; seq: number; ack: number; flags: number; window: number; checksum?: number; options?: Uint8Array }): Field[] {
  const optLen = o.options?.length ?? 0;
  const f: Field[] = [
    { name: "Source Port", short: "sport", bits: 16, value: o.srcPort },
    { name: "Destination Port", short: "dport", bits: 16, value: o.dstPort, note: "80 is HTTP" },
    { name: "Sequence Number", short: "seq", bits: 32, value: o.seq >>> 0, note: "number of the first data byte in this segment" },
    { name: "Acknowledgment Number", short: "ack", bits: 32, value: o.ack >>> 0, note: "the next byte this side expects" },
    { name: "Data Offset", short: "off", bits: 4, value: (TCP_HEADER + optLen) / 4, note: "header length in 32-bit words" },
    { name: "Reserved", short: "rsv", bits: 4, value: 0 },
    { name: "Flags", bits: 8, value: o.flags, note: "CWR ECE URG ACK PSH RST SYN FIN" },
    { name: "Window", short: "win", bits: 16, value: o.window, note: "bytes the receiver can take now (before scaling)" },
    { name: "Checksum", short: "csum", bits: 16, value: o.checksum ?? 0, note: "covers a pseudo-header, the TCP header and the data" },
    { name: "Urgent Pointer", short: "urg", bits: 16, value: 0 },
  ];
  if (optLen) f.push({ name: "Options", short: "opt", bits: optLen * 8, value: o.options, note: "NOP, NOP, timestamps (kind 8)" });
  return f;
}

/** TCP flag bits. */
export const TCP_FLAGS = { FIN: 0x01, SYN: 0x02, RST: 0x04, PSH: 0x08, ACK: 0x10, URG: 0x20, ECE: 0x40, CWR: 0x80 } as const;

export const flagNames = (flags: number) =>
  (Object.entries(TCP_FLAGS) as [string, number][]).filter(([, b]) => flags & b).map(([n]) => n).reverse().join(" ") || "none";

/** The TCP checksum: the Internet checksum over the pseudo-header (src, dst, zero, protocol, TCP length) and the segment. */
export function tcpChecksum(src: number, dst: number, segment: Uint8Array, protocol = PROTO_TCP): number {
  const pseudo = packFields([
    { name: "src", bits: 32, value: src },
    { name: "dst", bits: 32, value: dst },
    { name: "zero", bits: 8, value: 0 },
    { name: "proto", bits: 8, value: protocol },
    { name: "len", bits: 16, value: segment.length },
  ]);
  const all = new Uint8Array(pseudo.length + segment.length);
  all.set(pseudo);
  all.set(segment, pseudo.length);
  return internetChecksum(all);
}

/** Writes a 16-bit big-endian value. */
const put16 = (b: Uint8Array, at: number, v: number) => {
  b[at] = (v >> 8) & 0xff;
  b[at + 1] = v & 0xff;
};
const get16 = (b: Uint8Array, at: number) => ((b[at]! << 8) | b[at + 1]!) >>> 0;

/** Appends the FCS. The CRC goes on the wire least significant byte first, so a receiver's CRC over frame + FCS is constant. */
export function withFcs(frame: Uint8Array): Uint8Array {
  const c = crc32(frame);
  const out = new Uint8Array(frame.length + 4);
  out.set(frame);
  out[frame.length] = c & 0xff;
  out[frame.length + 1] = (c >>> 8) & 0xff;
  out[frame.length + 2] = (c >>> 16) & 0xff;
  out[frame.length + 3] = (c >>> 24) & 0xff;
  return out;
}

export const fcsOk = (frame: Uint8Array) => {
  if (frame.length < 5) return false;
  const body = frame.subarray(0, frame.length - 4);
  const c = crc32(body);
  const got = frame[frame.length - 4]! | (frame[frame.length - 3]! << 8) | (frame[frame.length - 2]! << 16) | (frame[frame.length - 1]! << 24);
  return (got >>> 0) === c;
};

export interface BuiltFrame {
  app: Uint8Array;
  segment: Uint8Array;
  packet: Uint8Array;
  /** Destination MAC through FCS. */
  frame: Uint8Array;
  eth: Field[];
  ip: Field[];
  tcp: Field[];
  /** Byte ranges of `frame` by layer. */
  spans: Span[];
  ipChecksum: number;
  tcpChecksum: number;
  padding: number;
}

/** Linux sends NOP, NOP, then timestamps. The values here are example clock ticks. */
const tsOption = () => Uint8Array.from([1, 1, 8, 10, 0x00, 0x2a, 0x6b, 0x10, 0x00, 0x2a, 0x6a, 0xf4]);

export function buildFrame(spec: Partial<FrameSpec> = {}): BuiltFrame {
  const s = { ...DEFAULT_FRAME, ...spec };
  const app = httpGet(s.path, s.host);
  const src = parseIpv4(s.srcIp), dst = parseIpv4(s.dstIp);
  const options = s.timestamps ? tsOption() : undefined;
  const flags = TCP_FLAGS.PSH | TCP_FLAGS.ACK;
  const tcpNoSum = tcpFields({ srcPort: s.srcPort, dstPort: s.dstPort, seq: s.seq, ack: s.ack, flags, window: s.window, options });
  const tcpHdr = packFields(tcpNoSum);
  const seg0 = concat(tcpHdr, app);
  const tsum = tcpChecksum(src, dst, seg0);
  const tcp = tcpFields({ srcPort: s.srcPort, dstPort: s.dstPort, seq: s.seq, ack: s.ack, flags, window: s.window, options, checksum: tsum });
  const segment = concat(packFields(tcp), app);
  const ipNoSum = ipv4Fields({ totalLength: IPV4_HEADER + segment.length, id: s.ipId, df: true, ttl: s.ttl, protocol: PROTO_TCP, src, dst });
  const isum = internetChecksum(packFields(ipNoSum));
  const ip = ipv4Fields({ totalLength: IPV4_HEADER + segment.length, id: s.ipId, df: true, ttl: s.ttl, protocol: PROTO_TCP, src, dst, checksum: isum });
  const packet = concat(packFields(ip), segment);
  const eth = ethFields(s.dstMac, s.srcMac);
  const body = concat(packFields(eth), packet);
  const padding = Math.max(0, ETH_MIN_FRAME - ETH_FCS - body.length);
  const frame = withFcs(concat(body, new Uint8Array(padding)));
  const tcpLen = fieldBytes(tcp);
  const spans: Span[] = [
    { layer: "eth", start: 0, len: ETH_HEADER },
    { layer: "ip", start: ETH_HEADER, len: IPV4_HEADER },
    { layer: "tcp", start: ETH_HEADER + IPV4_HEADER, len: tcpLen },
    { layer: "app", start: ETH_HEADER + IPV4_HEADER + tcpLen, len: app.length },
  ];
  if (padding) spans.push({ layer: "pad", start: body.length, len: padding });
  spans.push({ layer: "fcs", start: frame.length - ETH_FCS, len: ETH_FCS });
  return { app, segment, packet, frame, eth, ip, tcp, spans, ipChecksum: isum, tcpChecksum: tsum, padding };
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Which field of which header holds byte `i` of the frame, for the hex dump → diagram link. */
export function fieldAt(b: BuiltFrame, i: number): { layer: LayerName; field?: number } {
  const span = b.spans.find((s) => i >= s.start && i < s.start + s.len);
  if (!span) return { layer: "app" };
  const fields = span.layer === "eth" ? b.eth : span.layer === "ip" ? b.ip : span.layer === "tcp" ? b.tcp : undefined;
  if (!fields) return { layer: span.layer };
  const bit = (i - span.start) * 8;
  let at = 0;
  for (let k = 0; k < fields.length; k++) {
    // A byte can hold several narrow fields (Version and IHL): pick the first that overlaps it.
    if (bit < at + fields[k]!.bits) return { layer: span.layer, field: k };
    at += fields[k]!.bits;
  }
  return { layer: span.layer };
}

// ------------------------------------------------------------------------------------------- receiving

export type Check = "fcs" | "ethertype" | "version" | "ihl" | "ipChecksum" | "length" | "protocol" | "tcpChecksum" | "port";

export interface CheckResult {
  check: Check;
  /** Who runs it. */
  where: "NIC" | "kernel IP" | "kernel TCP";
  ok: boolean;
  text: string;
}

export interface Received {
  checks: CheckResult[];
  /** The first check that failed: the frame is dropped there. */
  droppedAt?: Check;
  /** The application bytes handed to the socket, if every check passed. */
  app?: Uint8Array;
  ttl?: number;
}

/** The receiving host's checks, in the order the NIC and the kernel run them. It stops at the first failure. */
export function receive(frame: Uint8Array, expectPort = DEFAULT_FRAME.dstPort): Received {
  const checks: CheckResult[] = [];
  const add = (check: Check, where: CheckResult["where"], ok: boolean, text: string) => {
    checks.push({ check, where, ok, text });
    return ok;
  };
  const done = (): Received => ({ checks, droppedAt: checks.find((c) => !c.ok)?.check });
  if (!add("fcs", "NIC", fcsOk(frame), "CRC-32 over the frame matches the FCS")) return done();
  const type = get16(frame, 12);
  if (!add("ethertype", "kernel IP", type === ETHERTYPE_IPV4, `EtherType 0x${type.toString(16).padStart(4, "0")} ${type === ETHERTYPE_IPV4 ? "is IPv4" : "is not IPv4: no handler"}`)) return done();
  const ip = frame.subarray(ETH_HEADER);
  const version = ip[0]! >> 4, ihl = ip[0]! & 15;
  if (!add("version", "kernel IP", version === 4, `version ${version}`)) return done();
  if (!add("ihl", "kernel IP", ihl >= 5, `IHL ${ihl} (${ihl * 4} bytes)`)) return done();
  const hlen = ihl * 4;
  if (!add("ipChecksum", "kernel IP", internetChecksum(ip.subarray(0, hlen)) === 0, "the 16-bit ones' complement sum of the header is 0xffff")) return done();
  const total = get16(ip, 2);
  const room = frame.length - ETH_HEADER - ETH_FCS;
  if (!add("length", "kernel IP", total >= hlen && total <= room, `Total Length ${total}, room ${room}`)) return done();
  const proto = ip[9]!;
  if (!add("protocol", "kernel IP", proto === PROTO_TCP, `protocol ${proto}${proto === PROTO_TCP ? " (TCP)" : ""}`)) return done();
  const seg = ip.subarray(hlen, total);
  const src = get32(ip, 12), dst = get32(ip, 16);
  if (!add("tcpChecksum", "kernel TCP", tcpChecksum(src, dst, seg) === 0, "pseudo-header + segment sums to 0xffff")) return done();
  const dport = get16(seg, 2);
  if (!add("port", "kernel TCP", dport === expectPort, `destination port ${dport}${dport === expectPort ? "" : ": no socket, the host answers RST"}`)) return done();
  const off = (seg[12]! >> 4) * 4;
  return { checks, app: seg.subarray(off), ttl: ip[8] };
}

const get32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/**
 * One router hop, done right. It checks the incoming frame, then:
 * 1. copies the packet into its buffer, where `corrupt` changes bytes (a bad memory cell, a bug),
 * 2. lowers the TTL and patches the header checksum incrementally (RFC 1624: HC' = ~(~HC + ~m + m')),
 * 3. writes the new Ethernet header (its own MAC → the next hop) and a new FCS over whatever is in its buffer.
 * Returns undefined if the router drops the frame.
 */
export function routerForward(frame: Uint8Array, corrupt: (b: Uint8Array) => void, macs: { src: number[]; dst: number[] }): Uint8Array | undefined {
  const r = receiveAsRouter(frame);
  if (!r) return undefined;
  const buf = frame.slice(0, frame.length - ETH_FCS);
  corrupt(buf);
  const ip = ETH_HEADER;
  const oldWord = get16(buf, ip + 8); // TTL and Protocol share one 16-bit word
  const ttl = buf[ip + 8]!;
  if (ttl <= 1) return undefined;
  buf[ip + 8] = ttl - 1;
  const newWord = get16(buf, ip + 8);
  const hc = get16(buf, ip + 10);
  let sum = (~hc & 0xffff) + (~oldWord & 0xffff) + newWord;
  sum = (sum & 0xffff) + (sum >>> 16);
  sum = (sum & 0xffff) + (sum >>> 16);
  put16(buf, ip + 10, ~sum & 0xffff);
  buf.set(macs.dst, 0);
  buf.set(macs.src, 6);
  return withFcs(buf);
}

/** A router checks the FCS, the EtherType, the version and the header checksum. It does not look at TCP. */
function receiveAsRouter(frame: Uint8Array): boolean {
  if (!fcsOk(frame) || get16(frame, 12) !== ETHERTYPE_IPV4) return false;
  const ip = frame.subarray(ETH_HEADER);
  const ihl = ip[0]! & 15;
  return ip[0]! >> 4 === 4 && ihl >= 5 && internetChecksum(ip.subarray(0, ihl * 4)) === 0;
}

/** The server's MAC in the two-hop example. */
export const SERVER_MAC = [0x02, 0, 0, 0, 0, 0x50];

export type CorruptWhere = "wire" | "router";

export interface CorruptionResult {
  /** The frame as the server's NIC sees it. */
  arrived?: Uint8Array;
  /** Dropped by the router before the corruption could matter (only for wire errors on the first link). */
  routerDropped: boolean;
  rx: Received;
  /** True when every check passed but the application got different bytes: silent corruption. */
  silent: boolean;
  /** Changes that the router wrote over (Ethernet header, FCS). */
  overwritten: boolean;
}

/**
 * Sends the example frame client → router → server and applies `edit` to the bytes either on the second wire
 * (after the router wrote its FCS) or inside the router (before it wrote the FCS). Byte positions are positions in
 * the client's frame; in the router case the Ethernet header and the FCS are rewritten anyway.
 */
export function corruptionRun(built: BuiltFrame, edit: (b: Uint8Array) => void, where: CorruptWhere): CorruptionResult {
  const macs = { src: DEFAULT_FRAME.dstMac, dst: SERVER_MAC };
  let changedEthOrFcs = false;
  let arrived: Uint8Array | undefined;
  if (where === "router") {
    arrived = routerForward(built.frame, (buf) => {
      // The buffer has no FCS: apply the edit on a full-length copy and keep only the body.
      const full = built.frame.slice();
      edit(full);
      for (let i = 0; i < full.length; i++) if (full[i] !== built.frame[i] && (i < ETH_HEADER || i >= buf.length)) changedEthOrFcs = true;
      buf.set(full.subarray(0, buf.length));
    }, macs);
    if (!arrived) return { routerDropped: true, rx: { checks: [] }, silent: false, overwritten: false };
  } else {
    const hop = routerForward(built.frame, () => {}, macs)!;
    arrived = hop.slice();
    edit(arrived);
  }
  const rx = receive(arrived);
  const silent = !rx.droppedAt && rx.app !== undefined && !sameBytes(rx.app, built.app);
  return { arrived, routerDropped: false, rx, silent, overwritten: changedEthOrFcs };
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Flips one bit. */
export const flipBit = (i: number, bit = 0) => (b: Uint8Array) => {
  b[i] = b[i]! ^ (1 << bit);
};

/** Swaps the 16-bit word that holds byte `i` (aligned to an even offset) with the next word. */
export const swapWords = (i: number) => (b: Uint8Array) => {
  const a = i & ~1;
  const x0 = b[a]!, x1 = b[a + 1]!;
  b[a] = b[a + 2]!;
  b[a + 1] = b[a + 3]!;
  b[a + 2] = x0;
  b[a + 3] = x1;
};

/** Reads the header fields back from a frame, for display. */
export function decodeIp(frame: Uint8Array) {
  const ip = frame.subarray(ETH_HEADER, ETH_HEADER + IPV4_HEADER);
  const v = unpackFields(ipv4Fields({ totalLength: 0, id: 0, df: false, ttl: 0, protocol: 0, src: 0, dst: 0 }), ip).map(Number);
  return { totalLength: v[4]!, id: v[5]!, df: v[7]!, mf: v[8]!, offset: v[9]!, ttl: v[10]!, protocol: v[11]!, checksum: v[12]!, src: formatIpv4(v[13]!), dst: formatIpv4(v[14]!) };
}
