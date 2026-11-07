/**
 * What the headers cost, and what happens when a packet does not fit.
 *
 * - `wireCost`: the bytes and the time one message takes on an Ethernet wire: headers, padding to the 64-byte
 *   minimum frame, preamble and interframe gap. `efficiency` is payload / wire bytes.
 * - `fragmentIpv4` / `fragmentIpv6`: how an IPv4 router (or an IPv6 source) cuts a datagram for a smaller MTU.
 *   IPv4 offsets count 8-byte units, so every fragment except the last carries a multiple of 8 data bytes.
 * - `TUNNELS`: encapsulations that eat into a 1500-byte MTU. Their sizes are header sizes from the RFCs.
 */
import { serializationMs } from "../packet";
import {
  ETH_FCS, ETH_HEADER, ETH_IFG, ETH_MIN_FRAME, ETH_MTU, ETH_PREAMBLE, IPV4_HEADER, IPV6_FRAG_HEADER, IPV6_HEADER, TCP_HEADER, UDP_HEADER,
} from "./encap";

export interface WireCost {
  payload: number;
  /** Transport + IP header bytes. */
  l34: number;
  /** Ethernet header + FCS. */
  l2: number;
  /** Zero bytes added to reach the 64-byte minimum frame. */
  pad: number;
  /** Preamble, SFD and interframe gap. */
  l1: number;
  frame: number;
  wire: number;
  efficiency: number;
}

/** One packet with `payload` transport-payload bytes, in one Ethernet frame (no fragmentation). */
export function wireCost(payload: number, o: { ip?: 4 | 6; transport?: "tcp" | "udp"; tcpOptions?: number } = {}): WireCost {
  const ip = (o.ip ?? 4) === 4 ? IPV4_HEADER : IPV6_HEADER;
  const tr = (o.transport ?? "tcp") === "tcp" ? TCP_HEADER + (o.tcpOptions ?? 0) : UDP_HEADER;
  const l34 = ip + tr;
  const unpadded = ETH_HEADER + l34 + payload + ETH_FCS;
  const frame = Math.max(ETH_MIN_FRAME, unpadded);
  const wire = frame + ETH_PREAMBLE + ETH_IFG;
  return { payload, l34, l2: ETH_HEADER + ETH_FCS, pad: frame - unpadded, l1: ETH_PREAMBLE + ETH_IFG, frame, wire, efficiency: payload / wire };
}

/** The largest TCP payload in one frame: MTU − IP header − TCP header − options. */
export const mss = (mtu = ETH_MTU, o: { ip?: 4 | 6; tcpOptions?: number } = {}) =>
  mtu - ((o.ip ?? 4) === 4 ? IPV4_HEADER : IPV6_HEADER) - TCP_HEADER - (o.tcpOptions ?? 0);

/** Packets per second that a link of `rate` bit/s carries when every frame has `frame` bytes (wire overhead included). */
export const maxPacketRate = (rate: number, frame: number) => rate / ((frame + ETH_PREAMBLE + ETH_IFG) * 8);

/** Goodput in bit/s of a link full of frames that each carry `payload` bytes of TCP/IPv4 data. */
export const goodput = (rate: number, payload: number, tcpOptions = 0) => rate * wireCost(payload, { tcpOptions }).efficiency;

export interface Fragment {
  /** Byte offset of this fragment's data in the original payload. */
  offset: number;
  /** The Fragment Offset field (IPv4: offset / 8). */
  offsetField: number;
  /** Data bytes in this fragment (the transport header counts as data). */
  len: number;
  /** IP Total Length (IPv4) or header + payload (IPv6). */
  packetLen: number;
  mf: boolean;
}

/** Cuts an IPv4 payload of `payload` bytes for a link with this MTU (RFC 791). */
export function fragmentIpv4(payload: number, mtu: number, header = IPV4_HEADER): Fragment[] {
  const per = Math.floor((mtu - header) / 8) * 8;
  if (per <= 0) throw new Error(`MTU ${mtu} is too small`);
  return cut(payload, per, header);
}

/** IPv6 source fragmentation (RFC 8200): each fragment also carries the 8-byte Fragment header. */
export function fragmentIpv6(payload: number, mtu: number): Fragment[] {
  const per = Math.floor((mtu - IPV6_HEADER - IPV6_FRAG_HEADER) / 8) * 8;
  if (per <= 0) throw new Error(`MTU ${mtu} is too small`);
  return cut(payload, per, IPV6_HEADER + IPV6_FRAG_HEADER);
}

function cut(payload: number, per: number, header: number): Fragment[] {
  const out: Fragment[] = [];
  for (let off = 0; off < payload || (payload === 0 && out.length === 0); off += per) {
    const len = Math.min(per, payload - off);
    out.push({ offset: off, offsetField: off / 8, len, packetLen: header + len, mf: off + len < payload });
    if (payload === 0) break;
  }
  return out;
}

export interface Tunnel {
  id: string;
  name: string;
  /** Bytes the encapsulation adds inside the 1500-byte link MTU. */
  overhead: number;
  /** What the bytes are. */
  parts: string;
  rfc: string;
}

/** Encapsulations that reduce the MTU seen by the inner IP packet on a 1500-byte link. */
export const TUNNELS: Tunnel[] = [
  { id: "none", name: "plain Ethernet", overhead: 0, parts: "nothing", rfc: "RFC 894" },
  { id: "pppoe", name: "PPPoE (DSL)", overhead: 8, parts: "PPPoE header 6 + PPP protocol 2", rfc: "RFC 2516" },
  { id: "vxlan", name: "VXLAN overlay", overhead: 50, parts: "outer IPv4 20 + UDP 8 + VXLAN 8 + inner Ethernet 14", rfc: "RFC 7348" },
];

export const tunnelMtu = (t: Tunnel, linkMtu = ETH_MTU) => linkMtu - t.overhead;

export interface PathResult {
  /** What happened at the narrow link. */
  outcome: "fits" | "fragmented" | "dropped-df" | "too-big-v6";
  /** The packets that leave the narrow link. */
  fragments: Fragment[];
  /** Total bytes on the wire after the narrow link (one Ethernet frame per fragment). */
  wireBytes: number;
  efficiency: number;
  /** The MTU that an ICMP error reports back to the sender. */
  reportMtu?: number;
}

/**
 * A UDP datagram of `data` bytes crosses a path whose narrowest link has `mtu`. The sender's own link is 1500.
 * IPv4: the sender fragments to 1500 first; a router fragments again, unless DF is set, where it drops the packet
 * and returns ICMP "fragmentation needed" (type 3, code 4) with the next-hop MTU (RFC 1191).
 * IPv6: only the source fragments (RFC 8200). If the source used a larger MTU, the router returns Packet Too Big.
 */
export function crossPath(data: number, mtu: number, o: { ip: 4 | 6; df: boolean; senderMtu?: number }): PathResult {
  const sMtu = o.senderMtu ?? ETH_MTU;
  const payload = data + UDP_HEADER;
  const frameOf = (packetLen: number) => Math.max(ETH_MIN_FRAME, ETH_HEADER + packetLen + ETH_FCS) + ETH_PREAMBLE + ETH_IFG;
  const finish = (outcome: PathResult["outcome"], fragments: Fragment[], reportMtu?: number): PathResult => {
    const wireBytes = fragments.reduce((s, f) => s + frameOf(f.packetLen), 0);
    return { outcome, fragments, wireBytes, efficiency: fragments.length ? data / wireBytes : 0, reportMtu };
  };
  if (o.ip === 4) {
    const first = payload + IPV4_HEADER <= sMtu ? [single(payload, IPV4_HEADER)] : o.df ? null : fragmentIpv4(payload, sMtu);
    if (!first) return finish("dropped-df", [], sMtu); // the sender's own stack refuses (EMSGSIZE)
    const tooBig = first.some((f) => f.packetLen > mtu);
    if (!tooBig) return finish(first.length > 1 ? "fragmented" : "fits", first);
    if (o.df) return finish("dropped-df", [], mtu);
    // The router fragments each piece again. Offsets stay relative to the original payload.
    const out: Fragment[] = [];
    for (const f of first) {
      if (f.packetLen <= mtu) { out.push(f); continue; }
      for (const g of fragmentIpv4(f.len, mtu)) out.push({ ...g, offset: f.offset + g.offset, offsetField: (f.offset + g.offset) / 8, mf: g.mf || f.mf });
    }
    return finish("fragmented", out);
  }
  const first = payload + IPV6_HEADER <= sMtu ? [single(payload, IPV6_HEADER)] : fragmentIpv6(payload, sMtu);
  if (first.some((f) => f.packetLen > mtu)) return finish("too-big-v6", [], mtu);
  return finish(first.length > 1 ? "fragmented" : "fits", first);
}

const single = (payload: number, header: number): Fragment => ({ offset: 0, offsetField: 0, len: payload, packetLen: header + payload, mf: false });

/** Serialization time of one full frame on the wire, preamble and gap included. */
export const frameWireMs = (frame: number, rate: number) => serializationMs(frame + ETH_PREAMBLE + ETH_IFG, rate);
