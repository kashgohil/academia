/**
 * A deterministic packet-level network for the networking track. Every module uses it, so all lessons share one model:
 *
 * - Time is a number of milliseconds (a float). Nothing happens unless an event is due, so runs are fast and repeatable.
 * - Nodes (hosts, switches, routers) are joined by links. Each direction of a link is a "port" with its own transmitter:
 *   a rate in bits per second, a propagation delay in ms, a FIFO queue with a limit, and a random loss rate.
 * - A packet's time on one hop is: wait in the queue + serialization (size × 8 / rate) + propagation delay.
 *   The queue limit counts only the packets that wait, not the one on the wire.
 * - A full queue drops the new packet (drop-tail). Above `ecnBytes` of queue, a packet that is ECN-capable gets the
 *   CE (congestion experienced) mark instead of nothing, as in DCTCP or L4S. Random loss happens on the wire.
 * - The same seed gives the same run, so a demo can replay a scenario and a test can pin its numbers.
 *
 * A protocol is a set of handlers. For each arrival the network calls `onReceive` first (a switch or a protocol that
 * reads every frame returns true to take the packet). If no handler takes it, a packet for this node goes to
 * `onDeliver`, and any other packet is forwarded with the node's routing table (`setRoute` or `computeRoutes`),
 * and its TTL goes down by one.
 *
 * To let a learner be the network, set `dropIf(pkt, port)`: it runs when a packet enters a queue, and true drops it.
 * Set `record: false` for long runs (congestion control): the trace, hops and queue logs then stay empty.
 */
import { mulberry32, type Rng } from "../rng";

export type NodeId = number;

export interface LinkSpec {
  /** Bits per second, for example 10e6 for 10 Mbit/s. */
  rate: number;
  /** One-way propagation delay in ms. */
  delay: number;
  /** Queue limit in bytes (the packets that wait). Default: no limit. */
  queueBytes?: number;
  /** Queue limit in packets. Default: no limit. */
  queuePackets?: number;
  /** Probability that a packet is lost on the wire. */
  loss?: number;
  /** Mark ECN-capable packets with CE when the queue holds more than this many bytes. */
  ecnBytes?: number;
}

export interface Packet<P> {
  id: number;
  src: NodeId;
  dst: NodeId;
  /** Bytes on the wire, headers included. */
  size: number;
  payload: P;
  /** Hops left. A router drops the packet when it reaches 0. */
  ttl: number;
  /** A label to group packets, such as one TCP connection. */
  flow: number;
  /** ECN-capable transport: the sender accepts a CE mark instead of a drop. */
  ect: boolean;
  /** Congestion Experienced: a queue on the path marked this packet. */
  ce: boolean;
  createdAt: number;
  hops: number;
}

export interface Port {
  id: number;
  node: NodeId;
  peer: NodeId;
  /** The port at the other end, for the reverse direction. */
  peerPort: number;
  link: number;
  spec: LinkSpec;
  up: boolean;
  queue: Packet<unknown>[];
  qBytes: number;
  /** The packet on the wire now, if any. */
  busy: boolean;
  stats: { txPackets: number; txBytes: number; drops: number; marks: number; busyMs: number; maxQBytes: number };
  /** [time, queued bytes] after each change, when recording. */
  qlog: [number, number][];
}

export type DropReason = "queue" | "loss" | "filter" | "ttl" | "noroute" | "down";

/** One packet crossing one link, for space-time diagrams. */
export interface Hop {
  pkt: number;
  from: NodeId;
  to: NodeId;
  port: number;
  txStart: number;
  txEnd: number;
  /** Undefined when the packet was lost on the wire. */
  arriveAt?: number;
  lost?: DropReason;
}

export type PacketEvent<P> =
  | { kind: "send"; t: number; node: NodeId; pkt: Packet<P> }
  | { kind: "enqueue"; t: number; port: number; pkt: Packet<P>; qBytes: number }
  | { kind: "tx"; t: number; port: number; pkt: Packet<P>; end: number }
  | { kind: "arrive"; t: number; node: NodeId; port: number; pkt: Packet<P> }
  | { kind: "deliver"; t: number; node: NodeId; pkt: Packet<P> }
  | { kind: "drop"; t: number; node: NodeId; port?: number; pkt: Packet<P>; reason: DropReason }
  | { kind: "mark"; t: number; port: number; pkt: Packet<P> }
  | { kind: "timer"; t: number; node: NodeId; tag: string }
  | { kind: "note"; t: number; node: NodeId; text: string };

export interface PacketHandlers<P> {
  /** Sees every arrival first. Return true to take the packet (a switch, a NAT, a sniffer). */
  onReceive?(node: NodeId, pkt: Packet<P>, port: Port, net: PacketNet<P>): boolean | void;
  /** A packet reached its destination node. */
  onDeliver?(node: NodeId, pkt: Packet<P>, net: PacketNet<P>): void;
  onTimer?(node: NodeId, tag: string, net: PacketNet<P>): void;
  /** A packet was dropped anywhere. */
  onDrop?(pkt: Packet<P>, reason: DropReason, node: NodeId, net: PacketNet<P>): void;
}

export interface PacketNetConfig {
  seed: number;
  /** Keep the trace, the hops and the queue logs. Turn off for long runs. */
  record: boolean;
  /** TTL of a new packet. */
  ttl: number;
}

interface Ev {
  t: number;
  seq: number;
  run: () => void;
}

/** A binary heap ordered by time, then by insertion order, so that ties are deterministic. */
class Heap {
  private a: Ev[] = [];
  get size() {
    return this.a.length;
  }
  peek() {
    return this.a[0];
  }
  push(x: Ev) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (Heap.less(a[p]!, a[i]!)) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): Ev | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && Heap.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && Heap.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
  private static less(x: Ev, y: Ev) {
    return x.t < y.t || (x.t === y.t && x.seq < y.seq);
  }
}

/** Serialization time in ms of `bytes` at `rate` bits per second. */
export const serializationMs = (bytes: number, rate: number) => (bytes * 8 * 1000) / rate;

/** Bandwidth-delay product in bytes: what a path holds in flight at `rate` bits/s and round-trip time `rttMs`. */
export const bdpBytes = (rate: number, rttMs: number) => (rate * rttMs) / 8000;

export class PacketNet<P> {
  readonly cfg: PacketNetConfig;
  readonly names: string[];
  now = 0;
  readonly ports: Port[] = [];
  readonly trace: PacketEvent<P>[] = [];
  readonly hops: Hop[] = [];
  /** Runs when a packet enters a queue. True drops it with reason "filter". */
  dropIf?: (pkt: Packet<P>, port: Port) => boolean;
  private rng: Rng;
  private q = new Heap();
  private seq = 0;
  private nextPkt = 1;
  private nextTimer = 1;
  private cancelled = new Set<number>();
  private links = 0;
  private portsOf: number[][];
  /** routes[node].get(dst) = port id. */
  private routes: Map<NodeId, number>[];

  /** `nodes` is a count or a list of names. */
  constructor(nodes: number | string[], cfg: Partial<PacketNetConfig> = {}, private handlers: PacketHandlers<P> = {}) {
    this.names = typeof nodes === "number" ? Array.from({ length: nodes }, (_, i) => `n${i}`) : [...nodes];
    this.cfg = { seed: 1, record: true, ttl: 64, ...cfg };
    this.rng = mulberry32(this.cfg.seed);
    this.portsOf = this.names.map(() => []);
    this.routes = this.names.map(() => new Map());
  }

  get n() {
    return this.names.length;
  }

  setHandlers(h: PacketHandlers<P>) {
    this.handlers = h;
  }

  /** A random number in [0, 1) from the run's seed. Protocols must use this, not Math.random. */
  random(): number {
    return this.rng();
  }

  /** Joins `a` and `b` with a full-duplex link. `back` overrides the spec of the b→a direction. Returns the link id. */
  connect(a: NodeId, b: NodeId, spec: LinkSpec, back?: Partial<LinkSpec>): number {
    const link = this.links++;
    const pa = this.ports.length, pb = pa + 1;
    const mk = (id: number, node: NodeId, peer: NodeId, peerPort: number, s: LinkSpec): Port => ({
      id, node, peer, peerPort, link, spec: s, up: true, queue: [], qBytes: 0, busy: false,
      stats: { txPackets: 0, txBytes: 0, drops: 0, marks: 0, busyMs: 0, maxQBytes: 0 }, qlog: [],
    });
    this.ports.push(mk(pa, a, b, pb, { ...spec }), mk(pb, b, a, pa, { ...spec, ...back }));
    this.portsOf[a]!.push(pa);
    this.portsOf[b]!.push(pb);
    return link;
  }

  /** The ports of a node, in the order its links were connected. */
  portsAt(node: NodeId): Port[] {
    return this.portsOf[node]!.map((p) => this.ports[p]!);
  }

  /** The port from `a` toward its neighbour `b`. */
  portTo(a: NodeId, b: NodeId): Port {
    const p = this.portsAt(a).find((x) => x.peer === b);
    if (!p) throw new Error(`no link ${this.names[a]}→${this.names[b]}`);
    return p;
  }

  /** Takes a link down or up (both directions). Packets on the wire and in its queues are lost. */
  setLinkUp(link: number, up: boolean) {
    for (const p of this.ports.filter((x) => x.link === link)) {
      p.up = up;
      if (!up) {
        for (const pkt of p.queue.splice(0) as Packet<P>[]) this.drop(pkt, "down", p.node, p.id);
        p.qBytes = 0;
        this.logQ(p);
      }
    }
  }

  setRoute(node: NodeId, dst: NodeId, port: number) {
    this.routes[node]!.set(dst, port);
  }

  routeOf(node: NodeId, dst: NodeId): number | undefined {
    return this.routes[node]!.get(dst);
  }

  /**
   * Fills every routing table with shortest paths over the links that are up. The cost of a link is its delay plus
   * one microsecond per hop, so equal delays prefer fewer hops. Ties go to the lower port id, so runs repeat.
   */
  computeRoutes(cost: (p: Port) => number = (p) => p.spec.delay + 1e-3) {
    for (let src = 0; src < this.n; src++) {
      const dist = new Array<number>(this.n).fill(Infinity);
      const first = new Array<number>(this.n).fill(-1);
      const done = new Array<boolean>(this.n).fill(false);
      dist[src] = 0;
      for (;;) {
        let u = -1;
        for (let i = 0; i < this.n; i++) if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
        if (u < 0) break;
        done[u] = true;
        for (const p of this.portsAt(u)) {
          if (!p.up) continue;
          const d = dist[u]! + cost(p);
          if (d < dist[p.peer]! - 1e-12) {
            dist[p.peer] = d;
            first[p.peer] = u === src ? p.id : first[u]!;
          }
        }
      }
      const r = this.routes[src]!;
      r.clear();
      for (let d = 0; d < this.n; d++) if (d !== src && first[d]! >= 0) r.set(d, first[d]!);
    }
  }

  /** Creates a packet at `src` and routes it toward `dst`. */
  send(src: NodeId, dst: NodeId, size: number, payload: P, opts: { flow?: number; ect?: boolean; ttl?: number } = {}): Packet<P> {
    const pkt = this.packet(src, dst, size, payload, opts);
    if (this.cfg.record) this.trace.push({ kind: "send", t: this.now, node: src, pkt });
    if (dst === src) {
      this.deliver(src, pkt);
      return pkt;
    }
    this.forward(src, pkt, false);
    return pkt;
  }

  /** Creates a packet without sending it, for `transmit`. */
  packet(src: NodeId, dst: NodeId, size: number, payload: P, opts: { flow?: number; ect?: boolean; ttl?: number } = {}): Packet<P> {
    return { id: this.nextPkt++, src, dst, size, payload, ttl: opts.ttl ?? this.cfg.ttl, flow: opts.flow ?? 0, ect: opts.ect ?? false, ce: false, createdAt: this.now, hops: 0 };
  }

  /** Puts a packet on one port's queue, with no routing. Switches and link-layer protocols use this. */
  transmit(port: number, pkt: Packet<P>) {
    const p = this.ports[port]!;
    if (!p.up) return this.drop(pkt, "down", p.node, p.id);
    if (this.dropIf?.(pkt, p)) return this.drop(pkt, "filter", p.node, p.id);
    const s = p.spec;
    if (p.busy && ((s.queueBytes !== undefined && p.qBytes + pkt.size > s.queueBytes) || (s.queuePackets !== undefined && p.queue.length >= s.queuePackets))) {
      return this.drop(pkt, "queue", p.node, p.id);
    }
    if (pkt.ect && s.ecnBytes !== undefined && p.qBytes > s.ecnBytes && !pkt.ce) {
      pkt.ce = true;
      p.stats.marks++;
      if (this.cfg.record) this.trace.push({ kind: "mark", t: this.now, port: p.id, pkt });
    }
    if (!p.busy) {
      this.startTx(p, pkt);
      return;
    }
    p.queue.push(pkt as Packet<unknown>);
    p.qBytes += pkt.size;
    p.stats.maxQBytes = Math.max(p.stats.maxQBytes, p.qBytes);
    if (this.cfg.record) this.trace.push({ kind: "enqueue", t: this.now, port: p.id, pkt, qBytes: p.qBytes });
    this.logQ(p);
  }

  /** Fires `onTimer(node, tag)` after `delay` ms. Returns an id for cancelTimer. */
  setTimer(node: NodeId, delay: number, tag: string): number {
    const id = this.nextTimer++;
    this.at(this.now + delay, () => {
      if (this.cancelled.has(id)) return;
      if (this.cfg.record) this.trace.push({ kind: "timer", t: this.now, node, tag });
      this.handlers.onTimer?.(node, tag, this);
    });
    return id;
  }

  cancelTimer(id: number) {
    this.cancelled.add(id);
  }

  /** Runs `fn` at time `t` (not before now). For scripted scenarios: "cut the link at 300 ms". */
  at(t: number, fn: () => void) {
    this.q.push({ t: Math.max(t, this.now), seq: this.seq++, run: fn });
  }

  note(node: NodeId, text: string) {
    if (this.cfg.record) this.trace.push({ kind: "note", t: this.now, node, text });
  }

  /** Runs the next event. False when nothing is left. */
  step(): boolean {
    const e = this.q.pop();
    if (!e) return false;
    this.now = e.t;
    e.run();
    return true;
  }

  /** Runs every event due at or before `t`, then sets the time to `t`. */
  runUntil(t: number) {
    while (this.q.size && this.q.peek()!.t <= t) this.step();
    this.now = Math.max(this.now, t);
  }

  /** Runs until nothing is left, or `maxEvents` (a guard against protocols that never stop). */
  runAll(maxEvents = 1_000_000): number {
    let k = 0;
    while (k < maxEvents && this.step()) k++;
    return k;
  }

  get pending() {
    return this.q.size;
  }

  private forward(node: NodeId, pkt: Packet<P>, decTtl: boolean) {
    if (decTtl) {
      pkt.ttl--;
      if (pkt.ttl <= 0) return this.drop(pkt, "ttl", node);
    }
    let port = this.routes[node]!.get(pkt.dst);
    if (port === undefined && this.portsOf[node]!.length === 1) port = this.portsOf[node]![0];
    if (port === undefined) return this.drop(pkt, "noroute", node);
    this.transmit(port, pkt);
  }

  private startTx(p: Port, pkt: Packet<P>) {
    p.busy = true;
    const ser = serializationMs(pkt.size, p.spec.rate);
    const start = this.now, end = start + ser;
    p.stats.txPackets++;
    p.stats.txBytes += pkt.size;
    p.stats.busyMs += ser;
    if (this.cfg.record) this.trace.push({ kind: "tx", t: start, port: p.id, pkt, end });
    const lost = this.rng() < (p.spec.loss ?? 0);
    const hop: Hop | undefined = this.cfg.record ? { pkt: pkt.id, from: p.node, to: p.peer, port: p.id, txStart: start, txEnd: end } : undefined;
    if (hop) this.hops.push(hop);
    this.at(end, () => {
      if (lost || !p.up) {
        if (hop) hop.lost = lost ? "loss" : "down";
        this.drop(pkt, lost ? "loss" : "down", p.node, p.id);
      } else {
        const arrive = end + p.spec.delay;
        if (hop) hop.arriveAt = arrive;
        this.at(arrive, () => {
          if (!p.up) {
            if (hop) {
              hop.arriveAt = undefined;
              hop.lost = "down";
            }
            return this.drop(pkt, "down", p.node, p.id);
          }
          this.arrive(p.peer, this.ports[p.peerPort]!, pkt);
        });
      }
      const next = p.queue.shift() as Packet<P> | undefined;
      if (next) {
        p.qBytes -= next.size;
        this.logQ(p);
        this.startTx(p, next);
      } else p.busy = false;
    });
  }

  private arrive(node: NodeId, port: Port, pkt: Packet<P>) {
    pkt.hops++;
    if (this.cfg.record) this.trace.push({ kind: "arrive", t: this.now, node, port: port.id, pkt });
    if (this.handlers.onReceive?.(node, pkt, port, this)) return;
    if (pkt.dst === node) this.deliver(node, pkt);
    else this.forward(node, pkt, true);
  }

  private deliver(node: NodeId, pkt: Packet<P>) {
    if (this.cfg.record) this.trace.push({ kind: "deliver", t: this.now, node, pkt });
    this.handlers.onDeliver?.(node, pkt, this);
  }

  private drop(pkt: Packet<P>, reason: DropReason, node: NodeId, port?: number) {
    if (port !== undefined) this.ports[port]!.stats.drops++;
    if (this.cfg.record) {
      this.trace.push({ kind: "drop", t: this.now, node, port, pkt, reason });
      if (reason !== "loss" && reason !== "down" && port !== undefined) {
        // A packet dropped before it reached the wire: show a stub hop that stops at the sender.
        this.hops.push({ pkt: pkt.id, from: node, to: this.ports[port]!.peer, port, txStart: this.now, txEnd: this.now, lost: reason });
      }
    }
    this.handlers.onDrop?.(pkt, reason, node, this);
  }

  private logQ(p: Port) {
    if (this.cfg.record) p.qlog.push([this.now, p.qBytes]);
  }
}

/**
 * A dumbbell: `pairs` senders on the left, `pairs` receivers on the right, and one bottleneck between two routers.
 * Access links are fast (10× the bottleneck rate). The queue limit sits on the bottleneck, left to right.
 * Node ids: senders 0..k-1, receivers k..2k-1, left router 2k, right router 2k+1.
 */
export function dumbbell<P>(opts: {
  pairs: number;
  rate: number;
  /** Bottleneck one-way delay in ms. */
  delay: number;
  queueBytes?: number;
  queuePackets?: number;
  ecnBytes?: number;
  loss?: number;
  /** One-way access delay per sender in ms (lets flows have different RTTs). Default 0.5. */
  accessDelay?: number[];
  seed?: number;
  record?: boolean;
  handlers?: PacketHandlers<P>;
}) {
  const k = opts.pairs;
  const names = [
    ...Array.from({ length: k }, (_, i) => `S${i + 1}`),
    ...Array.from({ length: k }, (_, i) => `R${i + 1}`),
    "left",
    "right",
  ];
  const net = new PacketNet<P>(names, { seed: opts.seed ?? 1, record: opts.record ?? true }, opts.handlers ?? {});
  const L = 2 * k, R = 2 * k + 1;
  const fast = opts.rate * 10;
  for (let i = 0; i < k; i++) {
    const d = opts.accessDelay?.[i] ?? 0.5;
    net.connect(i, L, { rate: fast, delay: d });
    net.connect(k + i, R, { rate: fast, delay: 0.5 });
  }
  const bottleneck = net.connect(L, R, { rate: opts.rate, delay: opts.delay, queueBytes: opts.queueBytes, queuePackets: opts.queuePackets, ecnBytes: opts.ecnBytes, loss: opts.loss });
  net.computeRoutes();
  return {
    net,
    senders: Array.from({ length: k }, (_, i) => i),
    receivers: Array.from({ length: k }, (_, i) => k + i),
    left: L,
    right: R,
    bottleneck,
    /** The left-to-right bottleneck port: its queue is where packets wait and drop. */
    bottleneckPort: net.portTo(L, R),
  };
}
