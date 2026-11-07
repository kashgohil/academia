/**
 * IPv4 and IPv6 headers as bytes: build, parse, check, and change them the way a router does.
 *
 * - IPv4 (RFC 791): a 20-byte fixed header plus options, a header checksum (RFC 1071), and fragmentation in
 *   8-byte units. `decrementTtl` updates the checksum incrementally (RFC 1624), as a router's fast path does.
 * - IPv6 (RFC 8200): a 40-byte fixed header, no checksum, a chain of extension headers linked by Next Header,
 *   and addresses written in the canonical text form of RFC 5952.
 */
import { internetChecksum, packFields, unpackFields, type Field } from "../bytes";

// ---------------------------------------------------------------- IPv4

export interface Ipv4Header {
  version: number;
  /** Header length in 32-bit words. 5 = 20 bytes, no options. */
  ihl: number;
  dscp: number;
  ecn: number;
  /** Header + data, in bytes. */
  totalLength: number;
  id: number;
  df: boolean;
  mf: boolean;
  /** In units of 8 bytes. */
  fragOffset: number;
  ttl: number;
  protocol: number;
  /** Undefined: compute it. */
  checksum?: number;
  src: number;
  dst: number;
}

export const IPV4_HEADER_BYTES = 20;
export const IPV6_HEADER_BYTES = 40;
export const PROTOCOLS: Record<number, string> = { 1: "ICMP", 6: "TCP", 17: "UDP", 41: "IPv6 in IPv4", 47: "GRE", 50: "ESP", 58: "ICMPv6" };

export const defaultIpv4 = (o: Partial<Ipv4Header> = {}): Ipv4Header => ({
  version: 4, ihl: 5, dscp: 0, ecn: 0, totalLength: 84, id: 0x1c46, df: true, mf: false, fragOffset: 0, ttl: 64, protocol: 1,
  src: 0xc0a8010a, dst: 0x5db8d822, ...o,
});

/** The fields of an IPv4 header in wire order, for packFields and HeaderDiagram. */
export function ipv4Fields(h: Ipv4Header): Field[] {
  return [
    { name: "Version", short: "Ver", bits: 4, value: h.version, note: "4 for IPv4" },
    { name: "IHL", bits: 4, value: h.ihl, note: "header length in 32-bit words; 5 means 20 bytes" },
    { name: "DSCP", bits: 6, value: h.dscp, note: "Differentiated Services code point (RFC 2474)" },
    { name: "ECN", bits: 2, value: h.ecn, note: "Explicit Congestion Notification (RFC 3168)" },
    { name: "Total Length", short: "Len", bits: 16, value: h.totalLength, note: "header + data in bytes" },
    { name: "Identification", short: "ID", bits: 16, value: h.id, note: "groups the fragments of one datagram" },
    { name: "Reserved", short: "0", bits: 1, value: 0, note: "must be zero" },
    { name: "DF", bits: 1, value: h.df ? 1 : 0, note: "Do not Fragment" },
    { name: "MF", bits: 1, value: h.mf ? 1 : 0, note: "More Fragments follow" },
    { name: "Fragment Offset", short: "Offset", bits: 13, value: h.fragOffset, note: "position of this fragment, in 8-byte units" },
    { name: "TTL", bits: 8, value: h.ttl, note: "hops left; each router subtracts 1" },
    { name: "Protocol", short: "Proto", bits: 8, value: h.protocol, note: "the next header: 1 ICMP, 6 TCP, 17 UDP" },
    { name: "Header Checksum", short: "Checksum", bits: 16, value: h.checksum ?? 0, note: "covers the header only" },
    { name: "Source Address", short: "Source", bits: 32, value: h.src },
    { name: "Destination Address", short: "Destination", bits: 32, value: h.dst },
  ];
}

/** The checksum that the header should carry: the checksum of the header with the field set to 0. */
export function ipv4Checksum(h: Ipv4Header): number {
  return internetChecksum(packFields(ipv4Fields({ ...h, checksum: 0 })));
}

/** The 20 header bytes. With `fix`, the checksum field is computed; otherwise `h.checksum` is used as it is. */
export function ipv4Bytes(h: Ipv4Header, fix = true): Uint8Array {
  return packFields(ipv4Fields({ ...h, checksum: fix ? ipv4Checksum(h) : (h.checksum ?? 0) }));
}

export interface Ipv4Parse {
  header: Ipv4Header;
  /** True if the 16-bit ones' complement sum of the header is 0xffff. */
  checksumOk: boolean;
  /** Why a receiver drops this header, in the order it checks. Empty: it accepts it. */
  problems: string[];
}

/** Reads a 20-byte header and runs the checks that RFC 1122 and RFC 1812 ask a receiver to make. */
export function parseIpv4Header(b: Uint8Array): Ipv4Parse {
  const v = unpackFields(ipv4Fields(defaultIpv4()), b).map(Number);
  const header: Ipv4Header = {
    version: v[0]!, ihl: v[1]!, dscp: v[2]!, ecn: v[3]!, totalLength: v[4]!, id: v[5]!, df: v[7] === 1, mf: v[8] === 1,
    fragOffset: v[9]!, ttl: v[10]!, protocol: v[11]!, checksum: v[12]!, src: v[13]!, dst: v[14]!,
  };
  const checksumOk = internetChecksum(b.subarray(0, IPV4_HEADER_BYTES)) === 0;
  const problems: string[] = [];
  if (header.version !== 4) problems.push(`version is ${header.version}, not 4`);
  if (header.ihl < 5) problems.push(`IHL ${header.ihl} is below 5 (20 bytes)`);
  if (header.totalLength < header.ihl * 4) problems.push(`Total Length ${header.totalLength} is shorter than the header`);
  if (!checksumOk) problems.push("the header checksum does not match");
  if (v[6] !== 0) problems.push("the reserved flag is set");
  return { header, checksumOk, problems };
}

/** Ones' complement addition of 16-bit words. */
export const onesAdd = (a: number, b: number) => {
  const s = a + b;
  return ((s & 0xffff) + (s >>> 16)) & 0xffff;
};

/**
 * What a router does to every IPv4 packet: TTL minus one, and a new checksum. RFC 1624 (eqn. 3) updates the
 * checksum from the old one, the old 16-bit word m and the new word m': HC' = ~(~HC + ~m + m'). The word is
 * TTL (high byte) and Protocol (low byte). `full` recomputes the checksum from scratch, for comparison.
 */
export function decrementTtl(h: Ipv4Header): { header: Ipv4Header; incremental: number; full: number } {
  const hc = h.checksum ?? ipv4Checksum(h);
  const m = ((h.ttl << 8) | h.protocol) & 0xffff;
  const next = { ...h, ttl: h.ttl - 1 };
  const m2 = ((next.ttl << 8) | next.protocol) & 0xffff;
  const incremental = ~onesAdd(onesAdd(~hc & 0xffff, ~m & 0xffff), m2) & 0xffff;
  const full = ipv4Checksum(next);
  return { header: { ...next, checksum: incremental }, incremental, full };
}

// ---------------------------------------------------------------- IPv4 fragmentation

export interface Fragment {
  /** Byte offset of this fragment's data in the original payload. */
  offset: number;
  /** The value of the Fragment Offset field: offset / 8. */
  offsetField: number;
  dataBytes: number;
  /** Header + data. */
  totalLength: number;
  mf: boolean;
}

/**
 * Splits `payload` bytes (the data after the IPv4 header) for a link with this MTU. Every fragment but the last
 * carries a multiple of 8 data bytes, because the offset field counts 8-byte units. Each fragment copies the header.
 */
export function fragmentIpv4(payload: number, mtu: number, header = IPV4_HEADER_BYTES): Fragment[] {
  if (payload + header <= mtu) return [{ offset: 0, offsetField: 0, dataBytes: payload, totalLength: payload + header, mf: false }];
  const per = Math.floor((mtu - header) / 8) * 8;
  if (per <= 0) throw new Error(`MTU ${mtu} cannot carry data`);
  const out: Fragment[] = [];
  for (let off = 0; off < payload; off += per) {
    const n = Math.min(per, payload - off);
    out.push({ offset: off, offsetField: off / 8, dataBytes: n, totalLength: n + header, mf: off + n < payload });
  }
  return out;
}

export type ForwardResult =
  | { kind: "fits"; fragments: Fragment[] }
  | { kind: "fragmented"; fragments: Fragment[] }
  /** DF is set: the router drops the packet and sends ICMP type 3 code 4 with the next-hop MTU (RFC 1191). */
  | { kind: "dropped"; nextHopMtu: number };

/** What a router does with a datagram of `payload` data bytes at a link of this MTU. */
export function forwardIpv4(payload: number, mtu: number, df: boolean): ForwardResult {
  if (payload + IPV4_HEADER_BYTES <= mtu) return { kind: "fits", fragments: fragmentIpv4(payload, mtu) };
  if (df) return { kind: "dropped", nextHopMtu: mtu };
  return { kind: "fragmented", fragments: fragmentIpv4(payload, mtu) };
}

/** A datagram arrives only if every one of its k fragments arrives: (1 − p)^k, with independent loss p. */
export const datagramSurvival = (fragments: number, loss: number) => Math.pow(1 - loss, fragments);

/** The largest UDP payload in one IPv4 datagram: 65535 − 20 (IP) − 8 (UDP). */
export const MAX_UDP_PAYLOAD_V4 = 65535 - IPV4_HEADER_BYTES - 8;

// ---------------------------------------------------------------- IPv6 addresses

/** Parses IPv6 text (with "::" and an optional dotted IPv4 tail) to 16 bytes. Throws on bad text. */
export function parseIpv6(text: string): Uint8Array {
  let s = text.trim().toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  let tail: number[] = [];
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[2]!.split(".").map(Number);
    if (p.some((x) => x > 255)) throw new Error(`bad IPv6 address: ${text}`);
    tail = [(p[0]! << 8) | p[1]!, (p[2]! << 8) | p[3]!];
    s = v4[1]!.endsWith("::") ? v4[1]! : v4[1]!.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) throw new Error(`bad IPv6 address: ${text} (more than one ::)`);
  const groups = (x: string) => (x === "" ? [] : x.split(":"));
  const head = groups(halves[0]!), rest = halves.length === 2 ? groups(halves[1]!) : [];
  for (const g of [...head, ...rest]) if (!/^[0-9a-f]{1,4}$/.test(g)) throw new Error(`bad IPv6 address: ${text}`);
  const words = [...head, ...rest].map((g) => parseInt(g, 16));
  const have = words.length + tail.length;
  if (halves.length === 1 && have !== 8) throw new Error(`bad IPv6 address: ${text} (needs 8 groups)`);
  if (halves.length === 2 && have > 7) throw new Error(`bad IPv6 address: ${text} (:: must stand for at least one group)`);
  const all = halves.length === 2
    ? [...head.map((g) => parseInt(g, 16)), ...new Array<number>(8 - have).fill(0), ...rest.map((g) => parseInt(g, 16)), ...tail]
    : [...words, ...tail];
  const out = new Uint8Array(16);
  all.forEach((w, i) => {
    out[2 * i] = w >> 8;
    out[2 * i + 1] = w & 0xff;
  });
  return out;
}

const words16 = (b: Uint8Array) => Array.from({ length: 8 }, (_, i) => (b[2 * i]! << 8) | b[2 * i + 1]!);

/** All eight groups, four hex digits each: 2001:0db8:0000:…. */
export const expandIpv6 = (b: Uint8Array) => words16(b).map((w) => w.toString(16).padStart(4, "0")).join(":");

/**
 * RFC 5952 text: lower case, no leading zeros, and "::" for the longest run of two or more zero groups
 * (the first run if two are equally long). A single zero group stays "0".
 */
export function formatIpv6(b: Uint8Array): string {
  const w = words16(b);
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (w[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && w[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const hexw = (x: number[]) => x.map((v) => v.toString(16)).join(":");
  // IPv4-mapped addresses keep the dotted tail (RFC 5952, section 5).
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return `::ffff:${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  if (bestLen < 2) return hexw(w);
  return `${hexw(w.slice(0, best))}::${hexw(w.slice(best + bestLen))}`;
}

/** A few IPv6 ranges (RFC 4291, RFC 4193, RFC 3849) and what they mean. Most specific first. */
export const IPV6_RANGES: { prefix: string; len: number; name: string }[] = [
  { prefix: "::1", len: 128, name: "loopback" },
  { prefix: "::", len: 128, name: "unspecified" },
  { prefix: "::ffff:0:0", len: 96, name: "IPv4-mapped" },
  { prefix: "2001:db8::", len: 32, name: "documentation" },
  { prefix: "fe80::", len: 10, name: "link-local unicast" },
  { prefix: "fc00::", len: 7, name: "unique local (ULA)" },
  { prefix: "ff00::", len: 8, name: "multicast" },
  { prefix: "2000::", len: 3, name: "global unicast" },
];

const inPrefix6 = (a: Uint8Array, p: Uint8Array, len: number) => {
  for (let i = 0; i < len; i++) if (((a[i >> 3]! >> (7 - (i & 7))) & 1) !== ((p[i >> 3]! >> (7 - (i & 7))) & 1)) return false;
  return true;
};

export function ipv6Kind(b: Uint8Array): string {
  for (const r of IPV6_RANGES) if (inPrefix6(b, parseIpv6(r.prefix), r.len)) return r.name;
  return "reserved or unassigned";
}

// ---------------------------------------------------------------- IPv6 header and extension headers

export interface Ipv6Header {
  trafficClass: number;
  flowLabel: number;
  payloadLength: number;
  nextHeader: number;
  hopLimit: number;
  src: Uint8Array;
  dst: Uint8Array;
}

export function ipv6Fields(h: Ipv6Header): Field[] {
  return [
    { name: "Version", short: "Ver", bits: 4, value: 6, note: "6 for IPv6" },
    { name: "Traffic Class", short: "TC", bits: 8, value: h.trafficClass, note: "DSCP and ECN, as in IPv4" },
    { name: "Flow Label", short: "Flow", bits: 20, value: h.flowLabel, note: "a label for one flow, for load balancers (RFC 6437)" },
    { name: "Payload Length", short: "Len", bits: 16, value: h.payloadLength, note: "bytes after this 40-byte header, extension headers included" },
    { name: "Next Header", short: "Next", bits: 8, value: h.nextHeader, note: "the type of the header that follows" },
    { name: "Hop Limit", short: "Hops", bits: 8, value: h.hopLimit, note: "the TTL, renamed" },
    { name: "Source Address", short: "Source", bits: 128, value: h.src },
    { name: "Destination Address", short: "Destination", bits: 128, value: h.dst },
  ];
}

export type ExtKind = "hbh" | "dest1" | "routing" | "fragment" | "ah" | "esp" | "dest2";

/** Extension headers: their Next Header number and the size this model gives them (the smallest real form). */
export const EXT_HEADERS: Record<ExtKind, { nh: number; name: string; bytes: number; who: string }> = {
  hbh: { nh: 0, name: "Hop-by-Hop Options", bytes: 8, who: "every router on the path may process it" },
  dest1: { nh: 60, name: "Destination Options (for the routing header)", bytes: 8, who: "each node in the routing header" },
  routing: { nh: 43, name: "Routing (segment routing, 1 segment)", bytes: 24, who: "each node listed in it" },
  fragment: { nh: 44, name: "Fragment", bytes: 8, who: "only the destination, which reassembles" },
  ah: { nh: 51, name: "Authentication Header", bytes: 24, who: "only the destination" },
  esp: { nh: 50, name: "Encapsulating Security Payload", bytes: 8, who: "only the destination" },
  dest2: { nh: 60, name: "Destination Options", bytes: 8, who: "only the destination" },
};

/** The order RFC 8200 (section 4.1) recommends. */
export const EXT_ORDER: ExtKind[] = ["hbh", "dest1", "routing", "fragment", "ah", "esp", "dest2"];

export const UPPER: Record<number, string> = { 6: "TCP", 17: "UDP", 58: "ICMPv6", 59: "No Next Header" };

export interface ChainLink {
  name: string;
  /** The Next Header value that points to this header (in the header before it). */
  nh: number;
  offset: number;
  bytes: number;
}

/** The header chain for a set of extension headers (sorted into the recommended order) and an upper layer. */
export function extensionChain(exts: ExtKind[], upper: number, upperBytes = upper === 6 ? 20 : 8): { chain: ChainLink[]; firstNextHeader: number; headerBytes: number } {
  const sorted = EXT_ORDER.filter((k) => exts.includes(k));
  const chain: ChainLink[] = [{ name: "IPv6 header", nh: 41, offset: 0, bytes: IPV6_HEADER_BYTES }];
  let off = IPV6_HEADER_BYTES;
  for (const k of sorted) {
    const e = EXT_HEADERS[k];
    chain.push({ name: e.name, nh: e.nh, offset: off, bytes: e.bytes });
    off += e.bytes;
  }
  chain.push({ name: UPPER[upper] ?? `protocol ${upper}`, nh: upper, offset: off, bytes: upperBytes });
  return { chain, firstNextHeader: chain[1]!.nh, headerBytes: off };
}

/** TCP's MSS on a link of this MTU: MTU − IP header − 20 bytes of TCP header (no options). */
export const tcpMss = (mtu: number, v6: boolean) => mtu - (v6 ? IPV6_HEADER_BYTES : IPV4_HEADER_BYTES) - 20;
