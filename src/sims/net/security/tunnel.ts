/**
 * What a VPN tunnel adds to each packet, and what happens when the result no longer fits the path MTU.
 *
 * Header sizes are facts from the specifications:
 * - GRE (RFC 2784): a 4-byte header, no encryption.
 * - WireGuard data message (WireGuard paper, section 5.4.6): type 1 + reserved 3 + receiver index 4 + counter 8 = 16
 *   bytes, then the inner packet zero-padded to a multiple of 16 bytes (never past the MTU), then a 16-byte Poly1305 tag.
 *   It travels in UDP. The default interface MTU of 1420 leaves room for an IPv6 outer header: 1500 − 40 − 8 − 32.
 * - ESP (RFC 4303) with AES-GCM (RFC 4106): SPI 4 + sequence number 4 + IV 8, the payload, 0–3 bytes of padding so
 *   that the trailer ends on a 4-byte boundary, pad length 1 + next header 1, and a 16-byte ICV. Tunnel mode wraps the
 *   whole inner packet in a new IP header; transport mode keeps the original IP header. NAT traversal (RFC 3948)
 *   adds a UDP header (port 4500).
 */
import { fragmentIpv4, type Fragment } from "../foundations";

export type TunnelKind = "none" | "gre" | "wg4" | "wg6" | "esp-tunnel" | "esp-transport" | "esp-natt";

export const TUNNEL_LABEL: Record<TunnelKind, string> = {
  none: "No tunnel",
  gre: "GRE (no encryption)",
  wg4: "WireGuard over IPv4",
  wg6: "WireGuard over IPv6",
  "esp-tunnel": "IPsec ESP, tunnel mode",
  "esp-transport": "IPsec ESP, transport mode",
  "esp-natt": "IPsec ESP tunnel + NAT-T",
};

export type Part = "outer" | "tunnel" | "inner" | "pad" | "tag";

export interface Layer {
  name: string;
  bytes: number;
  part: Part;
  /** Encrypted on the wire. */
  enc: boolean;
}

export const WG_HEADER = 16, WG_TAG = 16, WG_DEFAULT_MTU = 1420;
export const ESP_HEADER = 8, ESP_GCM_IV = 8, ESP_TRAILER = 2, ESP_ICV = 16;
export const GRE_HEADER = 4, UDP = 8, IPV4 = 20, IPV6 = 40;

/** WireGuard's padding: up to a multiple of 16, but never past the interface MTU. */
export const wgPadded = (len: number, ifMtu = WG_DEFAULT_MTU) => Math.max(len, Math.min(Math.ceil(len / 16) * 16, ifMtu));
/** ESP padding so that payload + padding + 2 is a multiple of 4. */
export const espPad = (payload: number) => (4 - ((payload + ESP_TRAILER) % 4)) % 4;

/** The layers of one inner IPv4 packet of `inner` bytes inside a tunnel, outermost first. */
export function encapsulate(kind: TunnelKind, inner: number): Layer[] {
  const L = (name: string, bytes: number, part: Part, enc = false): Layer => ({ name, bytes, part, enc });
  switch (kind) {
    case "none":
      return [L("inner IP packet", inner, "inner")];
    case "gre":
      return [L("outer IPv4", IPV4, "outer"), L("GRE", GRE_HEADER, "tunnel"), L("inner IP packet", inner, "inner")];
    case "wg4":
    case "wg6": {
      const p = wgPadded(inner);
      return [L(kind === "wg4" ? "outer IPv4" : "outer IPv6", kind === "wg4" ? IPV4 : IPV6, "outer"), L("UDP", UDP, "outer"), L("WireGuard header", WG_HEADER, "tunnel"), L("inner IP packet", inner, "inner", true), L("padding", p - inner, "pad", true), L("Poly1305 tag", WG_TAG, "tag")];
    }
    case "esp-tunnel":
    case "esp-natt": {
      const pad = espPad(inner);
      return [
        L("outer IPv4", IPV4, "outer"), ...(kind === "esp-natt" ? [L("UDP (port 4500)", UDP, "outer")] : []),
        L("ESP SPI + sequence", ESP_HEADER, "tunnel"), L("IV", ESP_GCM_IV, "tunnel"), L("inner IP packet", inner, "inner", true),
        L("padding", pad, "pad", true), L("pad length + next header", ESP_TRAILER, "pad", true), L("ICV (GCM tag)", ESP_ICV, "tag"),
      ];
    }
    case "esp-transport": {
      const payload = inner - IPV4;
      const pad = espPad(payload);
      return [
        L("original IPv4 header", IPV4, "outer"), L("ESP SPI + sequence", ESP_HEADER, "tunnel"), L("IV", ESP_GCM_IV, "tunnel"),
        L("TCP/UDP + data", payload, "inner", true), L("padding", pad, "pad", true), L("pad length + next header", ESP_TRAILER, "pad", true), L("ICV (GCM tag)", ESP_ICV, "tag"),
      ];
    }
  }
}

export const outerSize = (kind: TunnelKind, inner: number) => encapsulate(kind, inner).reduce((s, l) => s + l.bytes, 0);

/** The largest inner packet whose outer packet fits in `linkMtu`. */
export function maxInner(kind: TunnelKind, linkMtu = 1500): number {
  let n = linkMtu;
  while (n > 68 && outerSize(kind, n) > linkMtu) n--;
  return n;
}

export type PathOutcome = "fits" | "fragmented" | "blackhole";

export interface TunnelPath {
  layers: Layer[];
  outer: number;
  overhead: number;
  outcome: PathOutcome;
  /** Outer IPv4 fragments when the outer packet is too big and DF is clear. */
  fragments: Fragment[];
  /** Bytes on the path for this one inner packet. */
  wireBytes: number;
  /** Inner TCP MSS that would make every packet fit (MSS clamping): tunnel MTU − 40. */
  clampMss: number;
}

/**
 * One inner packet through the tunnel on a path with MTU `pathMtu`. If the outer packet is too big: with DF clear, a
 * router fragments it (IPv4) and the far gateway reassembles; with DF set (or an IPv6 outer header), the router drops it and sends ICMP
 * "fragmentation needed" to the tunnel gateway, not to the inner sender, which hears nothing.
 */
export function tunnelPath(kind: TunnelKind, inner: number, pathMtu: number, df: boolean): TunnelPath {
  const layers = encapsulate(kind, inner);
  const outer = layers.reduce((s, l) => s + l.bytes, 0);
  const clampMss = maxInner(kind, pathMtu) - 40;
  const base = { layers, outer, overhead: outer - inner, clampMss };
  if (outer <= pathMtu) return { ...base, outcome: "fits", fragments: [], wireBytes: outer };
  // IPv6 routers never fragment (RFC 8200): an IPv6 outer packet behaves as if DF were always set.
  if (df || kind === "wg6") return { ...base, outcome: "blackhole", fragments: [], wireBytes: 0 };
  const frags = fragmentIpv4(outer - IPV4, pathMtu);
  return { ...base, outcome: "fragmented", fragments: frags, wireBytes: frags.reduce((s, f) => s + f.packetLen, 0) };
}
