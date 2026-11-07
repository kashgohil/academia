/**
 * Just enough IPv6 for Neighbor Discovery (RFC 4861): address text, the solicited-node multicast address
 * (RFC 4291 section 2.7.1: ff02::1:ff00:0/104 + the low 24 bits) and its MAC (RFC 2464: 33:33 + the low 32 bits).
 */
import { ipv6MulticastMac } from "./ethernet";
import { mulberry32 } from "../../rng";

/** "fe80::1" → 16 bytes. Throws on bad text. Embedded IPv4 is not supported. */
export function parseIpv6(s: string): Uint8Array {
  const t = s.trim().toLowerCase();
  const halves = t.split("::");
  if (halves.length > 2 || !/^[0-9a-f:]+$/.test(t)) throw new Error(`bad IPv6 address: ${s}`);
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]!), tail = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 1 && fill !== 0) || fill < 0 || (halves.length === 2 && fill < 1)) throw new Error(`bad IPv6 address: ${s}`);
  const all = [...head, ...new Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const out = new Uint8Array(16);
  all.forEach((g, i) => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) throw new Error(`bad IPv6 address: ${s}`);
    const v = parseInt(g, 16);
    out[2 * i] = v >> 8;
    out[2 * i + 1] = v & 0xff;
  });
  return out;
}

/** 16 bytes → the RFC 5952 text form (lower case, longest run of two or more zero groups as ::). */
export function formatIpv6(a: Uint8Array): string {
  const g = Array.from({ length: 8 }, (_, i) => (a[2 * i]! << 8) | a[2 * i + 1]!);
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hexs = g.map((x) => x.toString(16));
  if (best < 0) return hexs.join(":");
  return `${hexs.slice(0, best).join(":")}::${hexs.slice(best + bestLen).join(":")}`;
}

/** The solicited-node multicast address of a unicast address: ff02::1:ff + its low 24 bits. */
export function solicitedNode(addr: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  out[0] = 0xff;
  out[1] = 0x02;
  out[11] = 0x01;
  out[12] = 0xff;
  out[13] = addr[13]!;
  out[14] = addr[14]!;
  out[15] = addr[15]!;
  return out;
}

/** The MAC that a Neighbor Solicitation for `target` goes to: 33:33:ff + the low 24 bits of the target. */
export const solicitedNodeMac = (target: Uint8Array) => ipv6MulticastMac(solicitedNode(target));

/**
 * On a LAN of `hosts` hosts, how many must process an address-resolution query: ARP broadcasts reach every other
 * host's CPU; an NS reaches only the hosts whose NIC listens on the same solicited-node MAC (here: those that share
 * the target's low 24 bits, which `lows` lists, one per host).
 */
export function queryReach(lows: number[], target: number): { arp: number; ndp: number } {
  return { arp: lows.length - 1, ndp: lows.filter((l, i) => i !== target && (l & 0xffffff) === (lows[target]! & 0xffffff)).length };
}

/** `hosts` hosts with random interface identifiers: how many others an ARP request and an NS for host 0 reach. */
export function lanReach(hosts: number, seed = 1) {
  const r = mulberry32(seed);
  return queryReach(Array.from({ length: hosts }, () => Math.floor(r() * 2 ** 24)), 0);
}
