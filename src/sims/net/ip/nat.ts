/**
 * Network address and port translation (NAPT, RFC 3022), with the behaviours that RFC 4787 names:
 *
 * - mapping: which outbound packets share one external port. Endpoint-independent (EIM) reuses the mapping for every
 *   remote; address-dependent (ADM) makes a new one per remote address; address-and-port-dependent (APDM, the old
 *   "symmetric NAT") makes a new one per remote address and port.
 * - filtering: which inbound packets a mapping lets in. Endpoint-independent (EIF) lets in anyone; address-dependent
 *   (ADF) only addresses the inside host has sent to; address-and-port-dependent (APDF) only those exact endpoints.
 * - hairpinning: an inside host reaches another inside host through the NAT's public address.
 *
 * `NatWorld` puts NATs, hosts and servers on a PacketNet, so translation happens to real packets. `holePunch` runs
 * the rendezvous procedure that STUN and ICE use, and reports if two hosts behind NATs can talk directly.
 */
import { formatIpv4 } from "../bytes";
import { PacketNet, type NodeId, type Packet } from "../packet";

export type MappingBehavior = "eim" | "adm" | "apdm";
export type FilteringBehavior = "eif" | "adf" | "apdf";

export interface Endpoint {
  ip: number;
  port: number;
}

export const ep = (e: Endpoint) => `${formatIpv4(e.ip)}:${e.port}`;

export interface NatConfig {
  publicIp: number;
  mapping: MappingBehavior;
  filtering: FilteringBehavior;
  hairpin: boolean;
  /** Idle time after which a mapping is removed, in ms. RFC 4787 asks for at least 2 minutes for UDP. */
  timeoutMs: number;
  /** Keep the inside port as the external port when it is free. */
  preservePort: boolean;
  /** The first external port to hand out when the port is not preserved. */
  portBase: number;
}

export const NAT_DEFAULTS: Omit<NatConfig, "publicIp"> = { mapping: "eim", filtering: "apdf", hairpin: true, timeoutMs: 120_000, preservePort: false, portBase: 40000 };

export interface NatEntry {
  inside: Endpoint;
  ext: number;
  /** The remote that created the entry (it matters for ADM and APDM). */
  remote: Endpoint;
  /** Remotes the inside host has sent to through this entry: "ip" and "ip:port" keys. */
  permits: Set<string>;
  created: number;
  lastUsed: number;
}

export type InboundResult = { ok: true; inside: Endpoint; entry: NatEntry } | { ok: false; reason: "no mapping" | "filtered" };

export class Nat {
  entries: NatEntry[] = [];
  private next: number;
  constructor(readonly cfg: NatConfig) {
    this.next = cfg.portBase;
  }

  private mapKey(inside: Endpoint, remote: Endpoint) {
    const m = this.cfg.mapping;
    return `${ep(inside)}${m === "adm" ? `>${formatIpv4(remote.ip)}` : m === "apdm" ? `>${ep(remote)}` : ""}`;
  }

  private entryKey(e: NatEntry) {
    return this.mapKey(e.inside, e.remote);
  }

  expire(now: number) {
    this.entries = this.entries.filter((e) => now - e.lastUsed < this.cfg.timeoutMs);
  }

  private allocate(want: number) {
    const used = new Set(this.entries.map((e) => e.ext));
    if (this.cfg.preservePort && !used.has(want)) return want;
    while (used.has(this.next)) this.next++;
    return this.next++;
  }

  /** An outbound packet: find or create the mapping, record the permit, return the external port. */
  outbound(now: number, inside: Endpoint, remote: Endpoint): { ext: number; created: boolean; entry: NatEntry } {
    this.expire(now);
    const k = this.mapKey(inside, remote);
    let entry = this.entries.find((e) => this.entryKey(e) === k);
    const created = !entry;
    if (!entry) {
      entry = { inside, ext: this.allocate(inside.port), remote, permits: new Set(), created: now, lastUsed: now };
      this.entries.push(entry);
    }
    entry.lastUsed = now;
    entry.permits.add(formatIpv4(remote.ip));
    entry.permits.add(ep(remote));
    return { ext: entry.ext, created, entry };
  }

  /** An inbound packet from `remote` to external port `ext`. */
  inbound(now: number, remote: Endpoint, ext: number): InboundResult {
    this.expire(now);
    const entry = this.entries.find((e) => e.ext === ext);
    if (!entry) return { ok: false, reason: "no mapping" };
    const f = this.cfg.filtering;
    const pass = f === "eif" || (f === "adf" ? entry.permits.has(formatIpv4(remote.ip)) : entry.permits.has(ep(remote)));
    if (!pass) return { ok: false, reason: "filtered" };
    entry.lastUsed = now;
    return { ok: true, inside: entry.inside, entry };
  }
}

/** The ports a NAT can hand out on one public address: 1024 to 65535. */
export const NAT_PORTS = 65536 - 1024;
/** Subscribers that can share one public IPv4 address if each gets a fixed block of ports (carrier-grade NAT). */
export const subscribersPerIp = (portsEach: number) => Math.floor(NAT_PORTS / portsEach);

// ---------------------------------------------------------------- NATs on packets

export interface Seg {
  sip: number;
  sport: number;
  dip: number;
  dport: number;
  kind: string;
  /** An endpoint carried in the body, as a STUN response carries the mapped address. */
  info?: Endpoint;
}

export interface WorldSpec {
  nats: { name: string; publicIp: number; cfg: Partial<Omit<NatConfig, "publicIp">>; hosts: { name: string; ip: number }[] }[];
  servers: { name: string; ip: number }[];
  /** One-way delay of a LAN link and of an Internet link, in ms (model inputs). */
  lanMs?: number;
  wanMs?: number;
}

export interface WorldLog {
  t: number;
  node: NodeId;
  text: string;
  tone: "ok" | "drop" | "info";
  pkt?: number;
}

export class NatWorld {
  readonly net: PacketNet<Seg>;
  readonly nats = new Map<NodeId, Nat>();
  readonly log: WorldLog[] = [];
  /** Original addresses of each packet, before translation, by packet id. */
  readonly origin = new Map<number, Seg>();
  onApp?: (node: NodeId, seg: Seg, pkt: Packet<Seg>, w: NatWorld) => void;
  private ipNode = new Map<number, NodeId>();
  private insideOf = new Map<NodeId, NodeId>(); // host → its NAT
  private hostByIp = new Map<string, NodeId>(); // `${natNode}/${ip}` → host
  readonly node = new Map<string, NodeId>();

  constructor(spec: WorldSpec) {
    const names: string[] = ["Internet"];
    for (const n of spec.nats) names.push(n.name, ...n.hosts.map((h) => h.name));
    for (const s of spec.servers) names.push(s.name);
    names.forEach((x, i) => this.node.set(x, i));
    this.net = new PacketNet<Seg>(names, { seed: 1 }, {
      onReceive: (node, pkt, port) => (this.nats.has(node) ? (this.atNat(node, pkt, port.peer), true) : false),
      onDeliver: (node, pkt) => this.onApp?.(node, pkt.payload, pkt, this),
    });
    const lan = spec.lanMs ?? 1, wan = spec.wanMs ?? 10;
    for (const n of spec.nats) {
      const nn = this.node.get(n.name)!;
      this.nats.set(nn, new Nat({ ...NAT_DEFAULTS, ...n.cfg, publicIp: n.publicIp }));
      this.ipNode.set(n.publicIp, nn);
      this.net.connect(nn, 0, { rate: 100e6, delay: wan });
      for (const h of n.hosts) {
        const hn = this.node.get(h.name)!;
        this.net.connect(hn, nn, { rate: 100e6, delay: lan });
        this.insideOf.set(hn, nn);
        this.hostByIp.set(`${nn}/${h.ip}`, hn);
      }
    }
    for (const s of spec.servers) {
      const sn = this.node.get(s.name)!;
      this.ipNode.set(s.ip, sn);
      this.net.connect(sn, 0, { rate: 100e6, delay: wan });
    }
    this.net.computeRoutes();
  }

  nat(name: string) {
    return this.nats.get(this.node.get(name)!)!;
  }

  /** A host or server sends a UDP segment. */
  send(from: string, seg: Seg, size = 60) {
    const src = this.node.get(from)!;
    const nat = this.insideOf.get(src);
    const dst = this.ipNode.get(seg.dip) ?? (nat !== undefined ? this.hostByIp.get(`${nat}/${seg.dip}`) : undefined);
    if (dst === undefined) {
      this.log.push({ t: this.net.now, node: src, text: `no route to ${formatIpv4(seg.dip)}`, tone: "drop" });
      return;
    }
    const p = this.net.send(src, dst, size, seg);
    this.origin.set(p.id, seg);
    return p;
  }

  private atNat(node: NodeId, pkt: Packet<Seg>, fromNode: NodeId) {
    const nat = this.nats.get(node)!;
    const s = pkt.payload;
    const now = this.net.now;
    const inside = this.insideOf.get(fromNode) === node;
    if (inside) {
      if (s.dip === nat.cfg.publicIp) {
        // Hairpinning: inside → own public address → inside.
        if (!nat.cfg.hairpin) {
          this.log.push({ t: now, node, text: `hairpin to ${ep({ ip: s.dip, port: s.dport })} not supported: dropped`, tone: "drop", pkt: pkt.id });
          return;
        }
        const o = nat.outbound(now, { ip: s.sip, port: s.sport }, { ip: s.dip, port: s.dport });
        const src = { ip: nat.cfg.publicIp, port: o.ext };
        const r = nat.inbound(now, src, s.dport);
        if (!r.ok) {
          this.log.push({ t: now, node, text: `hairpin: ${r.reason}, dropped`, tone: "drop", pkt: pkt.id });
          return;
        }
        this.log.push({ t: now, node, text: `hairpin: ${ep({ ip: s.sip, port: s.sport })} → ${ep(r.inside)} as from ${ep(src)}`, tone: "ok", pkt: pkt.id });
        this.forwardInside(node, { ...s, sip: src.ip, sport: src.port, dip: r.inside.ip, dport: r.inside.port }, pkt);
        return;
      }
      const o = nat.outbound(now, { ip: s.sip, port: s.sport }, { ip: s.dip, port: s.dport });
      const out = { ...s, sip: nat.cfg.publicIp, sport: o.ext };
      this.log.push({ t: now, node, text: `${o.created ? "new mapping" : "mapping"} ${ep({ ip: s.sip, port: s.sport })} ⇄ ${ep({ ip: out.sip, port: out.sport })}`, tone: "info", pkt: pkt.id });
      const dst = this.ipNode.get(s.dip);
      if (dst === undefined) {
        this.log.push({ t: now, node, text: `private address ${formatIpv4(s.dip)} is not routed on the Internet: dropped`, tone: "drop", pkt: pkt.id });
        return;
      }
      const p = this.net.send(node, dst, pkt.size, out);
      this.origin.set(p.id, this.origin.get(pkt.id) ?? s);
      return;
    }
    const r = nat.inbound(now, { ip: s.sip, port: s.sport }, s.dport);
    if (!r.ok) {
      this.log.push({ t: now, node, text: `from ${ep({ ip: s.sip, port: s.sport })} to port ${s.dport}: ${r.reason}, dropped`, tone: "drop", pkt: pkt.id });
      return;
    }
    this.log.push({ t: now, node, text: `${ep({ ip: s.dip, port: s.dport })} → ${ep(r.inside)}`, tone: "ok", pkt: pkt.id });
    this.forwardInside(node, { ...s, dip: r.inside.ip, dport: r.inside.port }, pkt);
  }

  private forwardInside(node: NodeId, seg: Seg, pkt: Packet<Seg>) {
    const host = this.hostByIp.get(`${node}/${seg.dip}`);
    if (host === undefined) return;
    const p = this.net.send(node, host, pkt.size, seg);
    this.origin.set(p.id, this.origin.get(pkt.id) ?? pkt.payload);
  }
}

// ---------------------------------------------------------------- hole punching

export const STUN_PORT = 3478;
export const IP = {
  hostA: 0xc0a8010a, // 192.168.1.10
  hostB: 0x0a000005, // 10.0.0.5
  natA: 0xcb00710a, // 203.0.113.10
  natB: 0xc0000214, // 192.0.2.20
  server: 0xc6336401, // 198.51.100.1
};

export interface PunchResult {
  world: NatWorld;
  /** Both hosts got a packet straight from the other. */
  direct: boolean;
  aGot: boolean;
  bGot: boolean;
  /** The public endpoints the server saw (what STUN would report). */
  seenA?: Endpoint;
  seenB?: Endpoint;
}

/**
 * A and B each send a binding request to server S, which tells each one the other's public endpoint. Then both
 * send punch packets to that endpoint, a few times. A host that gets a punch answers to the endpoint it came from.
 * If no packet gets through, a real client falls back to a relay (TURN).
 */
export function holePunch(a: { mapping: MappingBehavior; filtering: FilteringBehavior }, b: { mapping: MappingBehavior; filtering: FilteringBehavior }, tries = 3): PunchResult {
  const w = new NatWorld({
    nats: [
      { name: "NAT A", publicIp: IP.natA, cfg: { ...a, portBase: 40000 }, hosts: [{ name: "A", ip: IP.hostA }] },
      { name: "NAT B", publicIp: IP.natB, cfg: { ...b, portBase: 50000 }, hosts: [{ name: "B", ip: IP.hostB }] },
    ],
    servers: [{ name: "S", ip: IP.server }],
  });
  const A = w.node.get("A")!, B = w.node.get("B")!, S = w.node.get("S")!;
  const res: PunchResult = { world: w, direct: false, aGot: false, bGot: false };
  const seen = new Map<NodeId, Endpoint>();
  const local = { [A]: { ip: IP.hostA, port: 5000 }, [B]: { ip: IP.hostB, port: 6000 } } as Record<number, Endpoint>;
  const name = (n: NodeId) => (n === A ? "A" : "B");
  w.onApp = (node, seg) => {
    if (node === S && seg.kind === "bind") {
      const who = seg.sip === IP.natA ? A : B;
      seen.set(who, { ip: seg.sip, port: seg.sport });
      if (seen.size === 2) {
        res.seenA = seen.get(A);
        res.seenB = seen.get(B);
        for (const [h, other] of [[A, B], [B, A]] as const) {
          const to = seen.get(h)!;
          w.send("S", { sip: IP.server, sport: STUN_PORT, dip: to.ip, dport: to.port, kind: "peer", info: seen.get(other) });
        }
      }
      return;
    }
    if (node === A || node === B) {
      if (seg.kind === "peer" && seg.info) {
        for (let k = 0; k < tries; k++) {
          w.net.at(w.net.now + k * 20, () => w.send(name(node), { sip: local[node]!.ip, sport: local[node]!.port, dip: seg.info!.ip, dport: seg.info!.port, kind: "punch" }));
        }
      } else if (seg.kind === "punch" || seg.kind === "reply") {
        if (node === A) res.aGot = true;
        else res.bGot = true;
        if (seg.kind === "punch") w.send(name(node), { sip: local[node]!.ip, sport: local[node]!.port, dip: seg.sip, dport: seg.sport, kind: "reply" });
      }
    }
  };
  w.send("A", { sip: IP.hostA, sport: 5000, dip: IP.server, dport: STUN_PORT, kind: "bind" });
  w.send("B", { sip: IP.hostB, sport: 6000, dip: IP.server, dport: STUN_PORT, kind: "bind" });
  w.net.runAll(10_000);
  res.direct = res.aGot && res.bGot;
  return res;
}

/** The classic STUN names (RFC 3489) for the common combinations. */
export function classicName(m: MappingBehavior, f: FilteringBehavior): string {
  if (m === "apdm") return "symmetric";
  if (m === "eim" && f === "eif") return "full cone";
  if (m === "eim" && f === "adf") return "restricted cone";
  if (m === "eim" && f === "apdf") return "port-restricted cone";
  return "mixed";
}
