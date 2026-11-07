/**
 * IpNet: an IP data plane on top of PacketNet. Routers forward hop by hop with their own forwarding tables
 * (with equal-cost multipath), take one from the TTL, check the link MTU, fragment or drop, and answer with ICMP
 * errors, as RFC 791, RFC 792 and RFC 1812 describe. Hosts answer echo requests and send "port unreachable"
 * for a UDP port with no listener.
 *
 * Routing protocols (this module's distance-vector and link-state sims) send "ctl" packets to a neighbour with
 * `toNeighbour` and write the forwarding tables with `setRoute` and `clearRoute`. Traceroute and path MTU
 * discovery use the ICMP behaviour. Each node can be made silent (sends no ICMP errors), rate-limited, or a
 * firewall that drops ICMP passing through.
 */
import { PacketNet, type LinkSpec, type NodeId, type Packet, type Port } from "../packet";

export interface IcmpMsg {
  type: number;
  code: number;
  /** Next-hop MTU, for type 3 code 4 (RFC 1191). */
  mtu?: number;
  /** Echo identifier and sequence number. */
  seq?: number;
  /** The quoted start of the packet that caused the error: its header and the first 8 data bytes. */
  orig?: { id: number; src: NodeId; dst: NodeId; flow: number; size: number; dport?: number; tag?: unknown };
}

export interface IpData<A> {
  proto: "icmp" | "udp" | "tcp" | "ctl";
  df: boolean;
  dport?: number;
  icmp?: IcmpMsg;
  app?: A;
  /** Set on a fragment: which datagram, where its data starts, and if more follow. */
  frag?: { of: number; offset: number; more: boolean; data: number };
}

export type IpPacket<A> = Packet<IpData<A>>;
export type IpFate = "delivered" | "ttl" | "noroute" | "mtu" | "filtered" | "down" | "queue" | "loss";

export interface IpLogEntry {
  t: number;
  node: NodeId;
  pkt: number;
  what: IpFate | "icmp" | "fragmented";
  detail?: string;
}

export const IP_HEADER = 20;
export const ICMP_ERROR_BYTES = 20 + 8 + 28;
/** Unreachable codes and time exceeded, by RFC 792 type and code. */
export const ICMP_NAMES: Record<string, string> = {
  "0/0": "echo reply",
  "3/0": "net unreachable",
  "3/1": "host unreachable",
  "3/3": "port unreachable",
  "3/4": "fragmentation needed",
  "8/0": "echo request",
  "11/0": "time exceeded",
};
export const icmpName = (m: IcmpMsg) => ICMP_NAMES[`${m.type}/${m.code}`] ?? `type ${m.type} code ${m.code}`;

/** A small integer hash, so that ECMP picks a port from the flow id the same way every run. */
export const flowHash = (flow: number, node: number) => {
  let h = Math.imul(flow ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(node + 1, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  return (h ^ (h >>> 16)) >>> 0;
};

export interface IpNetOptions {
  seed?: number;
  record?: boolean;
  ttl?: number;
  /** Time a router's control plane takes to build an ICMP error, in ms (a model input). */
  icmpDelayMs?: number;
}

export class IpNet<A> {
  readonly net: PacketNet<IpData<A>>;
  readonly mtu = new Map<number, number>();
  readonly log: IpLogEntry[] = [];
  readonly fate = new Map<number, IpFate>();
  /** Nodes that never send ICMP errors. */
  readonly silent = new Set<NodeId>();
  /** Nodes that drop every ICMP packet that passes through them (a firewall). */
  readonly icmpFilter = new Set<NodeId>();
  /** Per-node minimum gap between two ICMP errors, in ms (a token rate limit). */
  readonly icmpGap = new Map<NodeId, number>();
  /** UDP ports with a listener, per host. */
  readonly listening = new Map<NodeId, Set<number>>();
  onHost?: (node: NodeId, pkt: IpPacket<A>, ip: IpNet<A>) => void;
  onControl?: (node: NodeId, pkt: IpPacket<A>, port: Port, ip: IpNet<A>) => void;
  /** Called on every drop, with the reason. */
  onDropped?: (node: NodeId, pkt: IpPacket<A>, why: IpFate, ip: IpNet<A>) => void;
  private fib: Map<NodeId, number[]>[];
  private lastIcmp = new Map<NodeId, number>();
  private reasm = new Map<string, number>();
  private icmpDelay: number;

  constructor(names: string[], opts: IpNetOptions = {}) {
    this.icmpDelay = opts.icmpDelayMs ?? 0;
    this.net = new PacketNet<IpData<A>>(names, { seed: opts.seed ?? 1, record: opts.record ?? true, ttl: opts.ttl ?? 64 }, {
      onReceive: (node, pkt, port) => {
        this.receive(node, pkt, port);
        return true;
      },
      onDrop: (pkt, reason, node) => {
        if (reason === "filter") return;
        this.dropped(node, pkt, reason as IpFate, false);
      },
    });
    this.fib = names.map(() => new Map());
  }

  get now() {
    return this.net.now;
  }

  connect(a: NodeId, b: NodeId, spec: LinkSpec, mtu = 1500) {
    const l = this.net.connect(a, b, spec);
    this.mtu.set(l, mtu);
    return l;
  }

  setRoute(node: NodeId, dst: NodeId, ports: number[]) {
    if (ports.length) this.fib[node]!.set(dst, ports);
    else this.fib[node]!.delete(dst);
  }

  clearRoute(node: NodeId, dst: NodeId) {
    this.fib[node]!.delete(dst);
  }

  routes(node: NodeId, dst: NodeId): number[] {
    return this.fib[node]!.get(dst) ?? [];
  }

  /** Shortest paths by link cost (default: delay + 1 µs), keeping every equal-cost first hop (ECMP). */
  computeRoutes(cost: (p: Port) => number = (p) => p.spec.delay + 1e-3) {
    const n = this.net.n;
    for (let src = 0; src < n; src++) {
      const dist = new Array<number>(n).fill(Infinity);
      const first: Set<number>[] = Array.from({ length: n }, () => new Set());
      const done = new Array<boolean>(n).fill(false);
      dist[src] = 0;
      for (;;) {
        let u = -1;
        for (let i = 0; i < n; i++) if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
        if (u < 0) break;
        done[u] = true;
        for (const p of this.net.portsAt(u)) {
          if (!p.up) continue;
          const d = dist[u]! + cost(p);
          const via = u === src ? new Set([p.id]) : first[u]!;
          if (d < dist[p.peer]! - 1e-9) {
            dist[p.peer] = d;
            first[p.peer] = new Set(via);
          } else if (Math.abs(d - dist[p.peer]!) <= 1e-9) for (const x of via) first[p.peer]!.add(x);
        }
      }
      this.fib[src]!.clear();
      for (let d = 0; d < n; d++) if (d !== src && first[d]!.size) this.fib[src]!.set(d, [...first[d]!].sort((a, b) => a - b));
    }
  }

  /** Sends an IP packet from a host. A packet larger than the first link's MTU with DF set fails at once (EMSGSIZE). */
  send(src: NodeId, dst: NodeId, size: number, data: Omit<IpData<A>, "df"> & { df?: boolean }, opts: { ttl?: number; flow?: number } = {}): IpPacket<A> {
    const pkt = this.net.packet(src, dst, size, { df: true, ...data } as IpData<A>, opts);
    if (this.net.cfg.record) this.net.trace.push({ kind: "send", t: this.now, node: src, pkt });
    this.forward(src, pkt, false);
    return pkt;
  }

  /** Puts a control packet on the link to a neighbour (routing protocols). */
  toNeighbour(node: NodeId, port: number, size: number, app: A) {
    const p = this.net.ports[port]!;
    const pkt = this.net.packet(node, p.peer, size, { proto: "ctl", df: false, app }, { ttl: 1 });
    this.net.transmit(port, pkt);
    return pkt;
  }

  /** Sends an ICMP error about `about` from `node` back to its source, unless rules forbid it. */
  icmpError(node: NodeId, about: IpPacket<A>, type: number, code: number, mtu?: number) {
    if (about.payload.proto === "icmp" && about.payload.icmp && about.payload.icmp.type !== 8 && about.payload.icmp.type !== 0) return; // never an error about an error (RFC 1122)
    if (about.payload.frag && about.payload.frag.offset > 0) return; // only about the first fragment
    if (this.silent.has(node)) return;
    const gap = this.icmpGap.get(node);
    const last = this.lastIcmp.get(node);
    if (gap !== undefined && last !== undefined && this.now - last < gap) {
      this.log.push({ t: this.now, node, pkt: about.id, what: "icmp", detail: "rate-limited" });
      return;
    }
    this.lastIcmp.set(node, this.now);
    const orig = { id: about.id, src: about.src, dst: about.dst, flow: about.flow, size: about.size, dport: about.payload.dport, tag: about.payload.app };
    const msg: IcmpMsg = { type, code, mtu, orig };
    this.log.push({ t: this.now, node, pkt: about.id, what: "icmp", detail: icmpName(msg) });
    const go = () => this.send(node, about.src, ICMP_ERROR_BYTES, { proto: "icmp", df: false, icmp: msg }, { flow: about.flow });
    if (this.icmpDelay > 0) this.net.at(this.now + this.icmpDelay, go);
    else go();
  }

  private receive(node: NodeId, pkt: IpPacket<A>, port: Port) {
    if (pkt.payload.proto === "ctl") {
      if (pkt.dst === node) this.onControl?.(node, pkt, port, this);
      return;
    }
    if (pkt.dst === node) return this.deliver(node, pkt);
    if (pkt.payload.proto === "icmp" && this.icmpFilter.has(node)) return this.dropped(node, pkt, "filtered");
    this.forward(node, pkt, true);
  }

  private forward(node: NodeId, pkt: IpPacket<A>, transit: boolean) {
    if (transit) {
      pkt.ttl--;
      if (pkt.ttl <= 0) {
        this.dropped(node, pkt, "ttl");
        return this.icmpError(node, pkt, 11, 0);
      }
    }
    const ports = this.fib[node]!.get(pkt.dst);
    const single = this.net.portsAt(node).length === 1 ? [this.net.portsAt(node)[0]!.id] : undefined;
    const choice = ports && ports.length ? ports : single;
    if (!choice) {
      this.dropped(node, pkt, "noroute");
      if (transit) this.icmpError(node, pkt, 3, 0);
      return;
    }
    const port = choice.length === 1 ? choice[0]! : choice[flowHash(pkt.flow, node) % choice.length]!;
    const p = this.net.ports[port]!;
    const mtu = this.mtu.get(p.link) ?? 1500;
    if (pkt.size > mtu) {
      if (pkt.payload.df || !transit) {
        this.dropped(node, pkt, "mtu");
        if (transit) this.icmpError(node, pkt, 3, 4, mtu);
        return;
      }
      return this.fragment(node, pkt, port, mtu);
    }
    this.net.transmit(port, pkt);
  }

  /** Splits a DF=0 packet into fragments that fit `mtu`. Each fragment copies the 20-byte header. */
  private fragment(node: NodeId, pkt: IpPacket<A>, port: number, mtu: number) {
    const base = pkt.payload.frag ?? { of: pkt.id, offset: 0, more: false, data: pkt.size - IP_HEADER };
    const data = pkt.size - IP_HEADER;
    const per = Math.floor((mtu - IP_HEADER) / 8) * 8;
    this.log.push({ t: this.now, node, pkt: pkt.id, what: "fragmented", detail: `${Math.ceil(data / per)} fragments` });
    for (let off = 0; off < data; off += per) {
      const n = Math.min(per, data - off);
      const more = off + n < data || base.more;
      const f = this.net.packet(pkt.src, pkt.dst, n + IP_HEADER, { ...pkt.payload, frag: { of: base.of, offset: base.offset + off, more, data: n } }, { ttl: pkt.ttl, flow: pkt.flow });
      this.net.transmit(port, f);
    }
  }

  private deliver(node: NodeId, pkt: IpPacket<A>) {
    const fr = pkt.payload.frag;
    if (fr) {
      // Reassembly: count data bytes until the last fragment's end is covered (no overlap in this model).
      const key = `${pkt.src}/${fr.of}`;
      const got = (this.reasm.get(key) ?? 0) + fr.data;
      this.reasm.set(key, got);
      if (!fr.more) this.reasm.set(`${key}/end`, fr.offset + fr.data);
      const end = this.reasm.get(`${key}/end`);
      this.fate.set(pkt.id, "delivered");
      if (end === undefined || got < end) return;
      this.reasm.delete(key);
      this.log.push({ t: this.now, node, pkt: fr.of, what: "delivered", detail: "reassembled" });
      this.fate.set(fr.of, "delivered");
      pkt = { ...pkt, id: fr.of, size: end + IP_HEADER, payload: { ...pkt.payload, frag: undefined } };
    }
    this.fate.set(pkt.id, "delivered");
    if (this.net.cfg.record) this.net.trace.push({ kind: "deliver", t: this.now, node, pkt });
    const d = pkt.payload;
    if (d.proto === "icmp" && d.icmp?.type === 8) {
      this.send(node, pkt.src, pkt.size, { proto: "icmp", df: false, icmp: { type: 0, code: 0, seq: d.icmp.seq } }, { flow: pkt.flow });
    } else if (d.proto === "udp" && d.dport !== undefined && !this.listening.get(node)?.has(d.dport)) {
      this.icmpError(node, pkt, 3, 3);
    }
    this.onHost?.(node, pkt, this);
  }

  private dropped(node: NodeId, pkt: IpPacket<A>, why: IpFate, log = true) {
    if (log && this.net.cfg.record) this.net.trace.push({ kind: "drop", t: this.now, node, pkt, reason: why === "mtu" || why === "filtered" ? "filter" : (why as "ttl") });
    this.fate.set(pkt.id, why);
    this.log.push({ t: this.now, node, pkt: pkt.id, what: why });
    this.onDropped?.(node, pkt, why, this);
  }
}
