/**
 * CIDR (RFC 4632): prefixes, subnet facts, special ranges, route aggregation, and longest-prefix match with a
 * binary trie, the structure that Linux's FIB trie and router hardware refine.
 */
import { formatIpv4, inPrefix, parseIpv4, prefixMask } from "../bytes";

export interface Prefix {
  net: number;
  len: number;
}

/** "10.1.0.0/16" → { net, len }. The host bits are cleared. A bare address is a /32. */
export function parseCidr(s: string): Prefix {
  const [a, l] = s.trim().split("/");
  const len = l === undefined ? 32 : Number(l);
  if (!Number.isInteger(len) || len < 0 || len > 32) throw new Error(`bad prefix length: ${s}`);
  return { net: (parseIpv4(a!) & prefixMask(len)) >>> 0, len };
}

export const formatCidr = (p: Prefix) => `${formatIpv4(p.net)}/${p.len}`;
export const prefixSize = (len: number) => 2 ** (32 - len);
export const contains = (outer: Prefix, inner: Prefix) => outer.len <= inner.len && inPrefix(inner.net, outer.net, outer.len);

export interface SubnetInfo {
  network: number;
  broadcast: number;
  mask: number;
  /** The inverted mask, as ACLs write it. */
  wildcard: number;
  addresses: number;
  /** Usable host addresses: 2^(32−len) − 2, but 2 for a /31 (RFC 3021) and 1 for a /32. */
  hosts: number;
  firstHost: number;
  lastHost: number;
}

export function subnetInfo(addr: number, len: number): SubnetInfo {
  const mask = prefixMask(len);
  const network = (addr & mask) >>> 0;
  const addresses = prefixSize(len);
  const broadcast = (network + addresses - 1) >>> 0;
  const hosts = len === 32 ? 1 : len === 31 ? 2 : addresses - 2;
  const firstHost = len >= 31 ? network : network + 1;
  const lastHost = len >= 31 ? broadcast : broadcast - 1;
  return { network, broadcast, mask, wildcard: ~mask >>> 0, addresses, hosts, firstHost, lastHost };
}

/** The old classful view (before 1993): the class follows from the first bits of the address. */
export function addressClass(addr: number): { cls: string; len: number | null } {
  const top = addr >>> 28;
  if (top < 8) return { cls: "A", len: 8 };
  if (top < 12) return { cls: "B", len: 16 };
  if (top < 14) return { cls: "C", len: 24 };
  if (top === 14) return { cls: "D (multicast)", len: null };
  return { cls: "E (reserved)", len: null };
}

/** Special-purpose IPv4 ranges (the IANA registry of RFC 6890, and the RFCs that define each one). */
export const SPECIAL_V4: { cidr: string; name: string; rfc: string }[] = [
  { cidr: "0.0.0.0/8", name: "this host on this network", rfc: "RFC 1122" },
  { cidr: "10.0.0.0/8", name: "private", rfc: "RFC 1918" },
  { cidr: "100.64.0.0/10", name: "shared address space (carrier-grade NAT)", rfc: "RFC 6598" },
  { cidr: "127.0.0.0/8", name: "loopback", rfc: "RFC 1122" },
  { cidr: "169.254.0.0/16", name: "link-local", rfc: "RFC 3927" },
  { cidr: "172.16.0.0/12", name: "private", rfc: "RFC 1918" },
  { cidr: "192.0.2.0/24", name: "documentation (TEST-NET-1)", rfc: "RFC 5737" },
  { cidr: "192.168.0.0/16", name: "private", rfc: "RFC 1918" },
  { cidr: "198.18.0.0/15", name: "benchmarking", rfc: "RFC 2544, RFC 6890" },
  { cidr: "198.51.100.0/24", name: "documentation (TEST-NET-2)", rfc: "RFC 5737" },
  { cidr: "203.0.113.0/24", name: "documentation (TEST-NET-3)", rfc: "RFC 5737" },
  { cidr: "224.0.0.0/4", name: "multicast", rfc: "RFC 5771" },
  { cidr: "240.0.0.0/4", name: "reserved", rfc: "RFC 1112" },
  { cidr: "255.255.255.255/32", name: "limited broadcast", rfc: "RFC 919" },
];

/** The most specific special range that holds `addr`, or undefined for an ordinary public address. */
export function specialRange(addr: number) {
  let best: (typeof SPECIAL_V4)[number] | undefined, bestLen = -1;
  for (const r of SPECIAL_V4) {
    const p = parseCidr(r.cidr);
    if (inPrefix(addr, p.net, p.len) && p.len > bestLen) {
      best = r;
      bestLen = p.len;
    }
  }
  return best;
}

/** All RFC 1918 space: 2^24 + 2^20 + 2^16 addresses. */
export const RFC1918_ADDRESSES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map((c) => prefixSize(parseCidr(c).len)).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------- aggregation

/**
 * The smallest list of prefixes that covers exactly the same addresses. Two steps, repeated: drop a prefix that
 * another one covers, and merge two sibling prefixes (same parent, both present) into the parent.
 */
export function aggregate(prefixes: Prefix[]): Prefix[] {
  let list = dedupe(prefixes.map((p) => ({ net: (p.net & prefixMask(p.len)) >>> 0, len: p.len })));
  for (;;) {
    list = list.filter((p, i) => !list.some((q, j) => j !== i && contains(q, p) && (q.len < p.len || j < i)));
    list.sort((a, b) => a.net - b.net || a.len - b.len);
    let merged = false;
    const out: Prefix[] = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!, b = list[i + 1];
      if (b && a.len === b.len && a.len > 0) {
        const parent = { net: (a.net & prefixMask(a.len - 1)) >>> 0, len: a.len - 1 };
        if (parent.net === a.net && b.net === (a.net + prefixSize(a.len)) >>> 0) {
          out.push(parent);
          i++;
          merged = true;
          continue;
        }
      }
      out.push(a);
    }
    list = out;
    if (!merged) return list;
  }
}

function dedupe(ps: Prefix[]) {
  const seen = new Set<string>();
  return ps.filter((p) => {
    const k = formatCidr(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- VLSM: subnets of different sizes from one block

export interface Allocation {
  name: string;
  hostsNeeded: number;
  prefix: Prefix | null;
  /** Addresses in the subnet that no host uses. */
  waste: number;
}

/** The prefix length of the smallest subnet with `hosts` usable addresses (network and broadcast reserved). */
export const lenForHosts = (hosts: number) => 32 - Math.ceil(Math.log2(hosts + 2));

/**
 * Cuts subnets out of `block`, largest first, each at the next free address aligned to its size.
 * Largest first never leaves a hole, because every later subnet is smaller and its size divides the position.
 */
export function vlsm(block: Prefix, needs: { name: string; hosts: number }[]): Allocation[] {
  const order = needs.map((n, i) => ({ ...n, i })).sort((a, b) => b.hosts - a.hosts || a.i - b.i);
  const end = block.net + prefixSize(block.len);
  let next = block.net;
  const out: Allocation[] = new Array(needs.length);
  for (const n of order) {
    const len = lenForHosts(n.hosts);
    const size = prefixSize(len);
    const at = Math.ceil(next / size) * size;
    if (len < block.len || at + size > end) {
      out[n.i] = { name: n.name, hostsNeeded: n.hosts, prefix: null, waste: 0 };
      continue;
    }
    out[n.i] = { name: n.name, hostsNeeded: n.hosts, prefix: { net: at >>> 0, len }, waste: size - 2 - n.hosts };
    next = at + size;
  }
  return out;
}

// ---------------------------------------------------------------- longest-prefix match

interface TrieNode<T> {
  child: [TrieNode<T> | undefined, TrieNode<T> | undefined];
  /** The prefix that ends here, if a route has it. */
  route?: { prefix: Prefix; value: T };
}

const bitAt = (addr: number, i: number) => ((addr >>> (31 - i)) & 1) as 0 | 1;

export interface LookupResult<T> {
  match?: { prefix: Prefix; value: T };
  /** Every route met on the way down: the candidates, shortest first. */
  candidates: { prefix: Prefix; value: T }[];
  /** Bits examined (trie levels walked) before the walk stopped. */
  steps: number;
}

/**
 * A binary (one bit per level) trie of routes. Lookup walks down the address bits and remembers the last route
 * it passed: that is the longest matching prefix. Cost: at most 32 steps for IPv4, whatever the table size.
 */
export class PrefixTrie<T> {
  private root: TrieNode<T> = { child: [undefined, undefined] };
  size = 0;

  insert(p: Prefix, value: T) {
    let n = this.root;
    for (let i = 0; i < p.len; i++) {
      const b = bitAt(p.net, i);
      n = n.child[b] ??= { child: [undefined, undefined] };
    }
    if (!n.route) this.size++;
    n.route = { prefix: { net: (p.net & prefixMask(p.len)) >>> 0, len: p.len }, value };
  }

  lookup(addr: number): LookupResult<T> {
    const candidates: { prefix: Prefix; value: T }[] = [];
    let n: TrieNode<T> | undefined = this.root, steps = 0;
    for (let i = 0; n; i++) {
      if (n.route) candidates.push(n.route);
      if (i === 32) break;
      n = n.child[bitAt(addr, i)];
      if (n) steps++;
    }
    return { match: candidates[candidates.length - 1], candidates, steps };
  }

  /**
   * The trie with chains of one-child nodes squeezed out (a Patricia view): only the root, nodes that hold a
   * route, and nodes where the trie branches. Each node knows its parent in this view. For drawing.
   */
  compressed(): { prefix: Prefix; route: boolean; parent: number }[] {
    const out: { prefix: Prefix; route: boolean; parent: number }[] = [];
    const walk = (n: TrieNode<T>, net: number, len: number, parent: number) => {
      const keep = len === 0 || n.route !== undefined || (n.child[0] !== undefined && n.child[1] !== undefined);
      let me = parent;
      if (keep) {
        out.push({ prefix: { net, len }, route: n.route !== undefined, parent });
        me = out.length - 1;
      }
      for (const b of [0, 1] as const) {
        const c = n.child[b];
        if (c) walk(c, (net | (b << (31 - len))) >>> 0, len + 1, me);
      }
    };
    walk(this.root, 0, 0, -1);
    return out;
  }
}

/** The obvious reference: scan every route and keep the longest match. O(routes) per lookup. */
export function linearLpm<T>(routes: { prefix: Prefix; value: T }[], addr: number) {
  let best: { prefix: Prefix; value: T } | undefined;
  for (const r of routes) if (inPrefix(addr, r.prefix.net, r.prefix.len) && (!best || r.prefix.len > best.prefix.len)) best = r;
  return best;
}
