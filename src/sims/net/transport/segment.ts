/**
 * The TCP segment as it travels on a PacketNet, its header as RFC 9293 draws it, and 32-bit sequence arithmetic.
 *
 * Sequence numbers on the wire are 32-bit and wrap. Inside the stack, each side counts in "relative" sequence
 * numbers instead, as Wireshark shows them: the SYN is 0, the first data byte is 1, and the numbers never wrap.
 * `wrap` turns a relative number into the wire value, and `unwrap` turns a wire value back, choosing the relative
 * number nearest to a reference (the next byte the receiver expects). This is correct while the window is below 2³¹.
 */
import type { Field } from "../bytes";

export const FIN = 0x01, SYN = 0x02, RST = 0x04, PSH = 0x08, ACK = 0x10, URG = 0x20, ECE = 0x40, CWR = 0x80;
const FLAG_NAMES: [number, string][] = [[SYN, "SYN"], [FIN, "FIN"], [RST, "RST"], [PSH, "PSH"], [ACK, "ACK"], [URG, "URG"], [ECE, "ECE"], [CWR, "CWR"]];

/** "SYN,ACK" for the flags of a segment. */
export const flagText = (flags: number) => FLAG_NAMES.filter(([b]) => flags & b).map(([, n]) => n).join(",");

export const M32 = 4294967296;

/** The wire value of relative sequence number `rel` on a side whose initial sequence number is `base`. */
export const wrap = (base: number, rel: number) => (((base + rel) % M32) + M32) % M32;

/** The relative sequence number of wire value `wire`, the one nearest to `ref`. */
export function unwrap(wire: number, base: number, ref: number): number {
  let d = (((wire - base - ref) % M32) + M32) % M32;
  if (d >= M32 / 2) d -= M32;
  return ref + d;
}

export interface TcpOptions {
  /** Maximum segment size (kind 2, 4 bytes). Only in SYN segments. */
  mss?: number;
  /** Window scale shift count (kind 3, 3 bytes). Only in SYN segments. */
  wscale?: number;
  /** SACK permitted (kind 4, 2 bytes). Only in SYN segments. */
  sackOk?: boolean;
  /** SACK blocks as wire [left, right) pairs (kind 5, 2 + 8 bytes per block, at most 4 blocks). */
  sack?: [number, number][];
}

/** Why a segment was sent. Not on the wire: diagrams use it. */
export type SegWhy = "syn" | "synack" | "data" | "ack" | "dupack" | "delack" | "fin" | "rst" | "rto" | "fast" | "sack" | "probe" | "update" | "cookie";

export interface TcpSegment {
  proto: "tcp";
  sport: number;
  dport: number;
  /** Wire sequence number (32 bits). */
  seq: number;
  /** Wire acknowledgment number (32 bits). Meaningful when ACK is set. */
  ack: number;
  flags: number;
  /** The 16-bit window field as sent (already shifted right by the window scale). */
  wnd: number;
  /** Payload bytes. The stream is a byte count: byte k of a connection is just "byte k". */
  len: number;
  opts: TcpOptions;
  /** Not on the wire. Relative seq and ack (as Wireshark shows them), the retransmission count, and the sending connection. */
  info: { rseq: number; rack: number; retx: number; why: SegWhy; conn: number };
}

/** Bytes of the options, padded to a multiple of 4 as the data offset field requires. */
export function optionBytes(o: TcpOptions): number {
  let n = 0;
  if (o.mss !== undefined) n += 4;
  if (o.wscale !== undefined) n += 3;
  if (o.sackOk) n += 2;
  if (o.sack?.length) n += 2 + 8 * o.sack.length;
  return Math.ceil(n / 4) * 4;
}

export const IP_HEADER = 20;
export const TCP_HEADER = 20;

/** Bytes on the wire for a segment: IPv4 header + TCP header + options + payload (no link-layer framing). */
export const segmentSize = (s: TcpSegment) => IP_HEADER + TCP_HEADER + optionBytes(s.opts) + s.len;

/** Sequence space a segment uses: its payload, plus one for SYN and one for FIN. */
export const seqLen = (s: TcpSegment) => s.len + (s.flags & SYN ? 1 : 0) + (s.flags & FIN ? 1 : 0);

export function isTcp(p: unknown): p is TcpSegment {
  return typeof p === "object" && p !== null && (p as { proto?: string }).proto === "tcp";
}

/** A short label for a space-time diagram: "SYN", "1:1461", "ACK 2921", "FIN". Uses relative numbers. */
export function segLabel(s: TcpSegment): string {
  if (s.flags & RST) return "RST";
  if (s.flags & SYN) return s.flags & ACK ? "SYN-ACK" : "SYN";
  if (s.info.why === "probe") return "probe";
  const parts: string[] = [];
  if (s.len > 0) parts.push(`${s.info.rseq}:${s.info.rseq + s.len}`);
  if (s.flags & FIN) parts.push("FIN");
  if (!parts.length) parts.push(`ACK ${s.info.rack}${s.opts.sack?.length ? "+S" : ""}`);
  return parts.join(" ");
}

/** The fixed 20-byte TCP header (RFC 9293, section 3.1), with values from a segment, for HeaderDiagram. */
export function tcpHeaderFields(s?: TcpSegment): Field[] {
  const f = s?.flags ?? 0;
  const bit = (b: number) => (f & b ? 1 : 0);
  const off = 5 + (s ? optionBytes(s.opts) / 4 : 0);
  return [
    { name: "Source port", bits: 16, value: s?.sport, note: "the sending application's port" },
    { name: "Destination port", bits: 16, value: s?.dport, note: "the receiving application's port" },
    { name: "Sequence number", bits: 32, value: s?.seq, short: "Seq", note: "the number of the first payload byte (or of the SYN)" },
    { name: "Acknowledgment number", bits: 32, value: s?.ack, short: "Ack", note: "the next byte the sender of this segment expects" },
    { name: "Data offset", bits: 4, value: off, short: "Off", note: "header length in 32-bit words (5 to 15)" },
    { name: "Reserved", bits: 4, value: 0, short: "Rsv", note: "must be zero" },
    { name: "CWR", bits: 1, value: bit(CWR), short: "C", note: "congestion window reduced (ECN, RFC 3168)" },
    { name: "ECE", bits: 1, value: bit(ECE), short: "E", note: "ECN echo (RFC 3168)" },
    { name: "URG", bits: 1, value: bit(URG), short: "U", note: "the urgent pointer is valid" },
    { name: "ACK", bits: 1, value: bit(ACK), short: "A", note: "the acknowledgment number is valid" },
    { name: "PSH", bits: 1, value: bit(PSH), short: "P", note: "push the data to the application" },
    { name: "RST", bits: 1, value: bit(RST), short: "R", note: "reset the connection" },
    { name: "SYN", bits: 1, value: bit(SYN), short: "S", note: "synchronize sequence numbers" },
    { name: "FIN", bits: 1, value: bit(FIN), short: "F", note: "no more data from the sender" },
    { name: "Window", bits: 16, value: s?.wnd, short: "Wnd", note: "free receive buffer, shifted right by the window scale" },
    { name: "Checksum", bits: 16, short: "Csum", note: "Internet checksum over a pseudo-header, the header and the data" },
    { name: "Urgent pointer", bits: 16, value: 0, short: "Urg", note: "rarely used" },
  ];
}
