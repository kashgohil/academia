/**
 * A LAN on PacketNet: hosts with ARP and a Linux-style neighbour cache, and learning switches with VLANs, the
 * spanning tree protocol (802.1D) and optional ARP inspection. Everything runs on `onReceive` + `transmit`: a frame
 * never uses PacketNet's IP routing, because a switch decides per frame which ports get a copy.
 *
 * Model choices (simplifications, stated here so that lessons do not overclaim):
 * - A frame's PacketNet size is its bytes on the wire: preamble and SFD (8), frame (64..1522) and gap (12).
 * - Hosts sit on access ports and never see tags. A host takes a frame for its own MAC or a group MAC, and its NIC
 *   drops the rest (unless `promiscuous`).
 * - The neighbour cache follows Linux: INCOMPLETE, REACHABLE, STALE, DELAY, PROBE, FAILED, PERMANENT, with the
 *   defaults of net.ipv4.neigh.default.* (LINUX_NEIGH). The `locktime` rule and garbage collection are left out.
 * - STP follows 802.1D as Linux implements it (net/bridge/br_stp.c): the lowest bridge id is root, each bridge picks the port with the best path to the root, each
 *   segment gets one designated port, and the rest block. Ports pass listening and learning (forward delay each)
 *   before forwarding. A port ignores worse information until its stored information reaches max age. Only the root sends hellos; other bridges relay what arrives on their root port, with the
 *   message age one second higher. Stored information expires at max age. Ports toward hosts are edge ports
 *   (PortFast): they forward at once. After a topology change every switch flushes its MAC table (RSTP-like);
 *   802.1D instead shortens the ageing time to the forward delay for a while.
 * - `rapid` skips listening and learning, as RSTP does on point-to-point links after its proposal/agreement
 *   handshake. It does not model that handshake.
 */
import { PacketNet, type LinkSpec, type Packet, type Port } from "../packet";
import { formatIpv4 } from "../bytes";
import { ETH } from "./ethernet";

export type Mac = string;
export const BROADCAST: Mac = "ff:ff:ff:ff:ff:ff";
/** The bridge group address: switches consume BPDUs sent here and never forward them. */
export const STP_MAC: Mac = "01:80:c2:00:00:00";
export const isGroupMac = (m: Mac) => (parseInt(m.slice(0, 2), 16) & 1) === 1;
/** A MAC from a small number: mac(10) = "02:00:00:00:00:0a" (locally administered, unicast). */
export const mac = (n: number) => `02:00:00:00:${((n >> 8) & 0xff).toString(16).padStart(2, "0")}:${(n & 0xff).toString(16).padStart(2, "0")}`;

export interface ArpPacket {
  /** 1 = request, 2 = reply. */
  op: 1 | 2;
  sha: Mac;
  spa: number;
  tha: Mac;
  tpa: number;
}
export interface IpPacket {
  src: number;
  dst: number;
  data: string;
  /** IP packet size in bytes (the Ethernet payload). */
  size: number;
}
/** A configuration BPDU: the sender's view of the root. Ages are in seconds, as in 802.1D. */
export interface Bpdu {
  root: number;
  cost: number;
  bridge: number;
  port: number;
  age: number;
}

export type Body =
  | { kind: "arp"; arp: ArpPacket }
  | { kind: "ip"; ip: IpPacket }
  | { kind: "bpdu"; bpdu: Bpdu }
  | { kind: "data"; text: string; size: number };

export interface Frame {
  dst: Mac;
  src: Mac;
  /** The 802.1Q VLAN id in the tag on this link. Undefined: an untagged frame. */
  vid?: number;
  body: Body;
}

/** ARP payload: 28 bytes. A configuration BPDU: 35 bytes plus a 3-byte LLC header. */
export const bodyBytes = (b: Body) => (b.kind === "arp" ? 28 : b.kind === "bpdu" ? 38 : b.kind === "ip" ? b.ip.size : b.size);

/** Frame bytes from destination MAC to FCS: 64 at least, 1518 untagged at most for a 1500-byte payload. */
export const frameBytes = (f: Frame) => ETH.header + (f.vid !== undefined ? ETH.tag : 0) + Math.max(bodyBytes(f.body), ETH.minFrame - ETH.fcs - ETH.header - (f.vid !== undefined ? ETH.tag : 0)) + ETH.fcs;

/** Bytes on the wire: preamble + SFD + frame + inter-frame gap. */
export const wireBytes = (f: Frame) => ETH.preamble + ETH.sfd + frameBytes(f) + ETH.ifg;

/** Linux defaults of net.ipv4.neigh.default.* (Documentation/networking/ip-sysctl.rst). */
export const LINUX_NEIGH = {
  baseReachableMs: 30_000,
  delayFirstProbeMs: 5_000,
  retransMs: 1_000,
  ucastSolicit: 3,
  mcastSolicit: 3,
  gcStaleMs: 60_000,
} as const;
export type NeighParams = { -readonly [K in keyof typeof LINUX_NEIGH]: number };

export type NeighState = "INCOMPLETE" | "REACHABLE" | "STALE" | "DELAY" | "PROBE" | "FAILED" | "PERMANENT";

export interface NeighEntry {
  ip: number;
  mac?: Mac;
  state: NeighState;
  /** Last time a reply or an upper layer confirmed that the neighbour is reachable. */
  confirmed: number;
  /** When the current state began. */
  since: number;
  probes: number;
  timer?: number;
  queue: IpPacket[];
  /** [time, state, mac] at each change. */
  history: { t: number; state: NeighState; mac?: Mac }[];
}

/** Linux picks each reachable time at random in [0.5, 1.5) × base_reachable_time (neigh_rand_reach_time). */
export const reachableRangeMs = (p: NeighParams = LINUX_NEIGH) => [0.5 * p.baseReachableMs, 1.5 * p.baseReachableMs] as const;

/**
 * The longest a host keeps sending to a neighbour that died right after it last confirmed it, if traffic keeps
 * flowing: the longest reachable time, then DELAY, then every unicast probe.
 */
export const deadNeighbourBoundMs = (p: NeighParams = LINUX_NEIGH) => 1.5 * p.baseReachableMs + p.delayFirstProbeMs + p.ucastSolicit * p.retransMs;

/** 802.1D defaults, in ms. */
export const STP_TIMERS = { helloMs: 2_000, maxAgeMs: 20_000, fwdDelayMs: 15_000 } as const;
/** 802.1D-1998 short path costs by link rate. */
export const stpCost = (rate: number) => (rate >= 10e9 ? 2 : rate >= 1e9 ? 4 : rate >= 100e6 ? 19 : 100);

export type PortState = "blocking" | "listening" | "learning" | "forwarding";
export type PortRole = "root" | "designated" | "alternate" | "edge";

export interface HostDef {
  kind: "host";
  name: string;
  mac: Mac;
  ip: number;
  prefix?: number;
  gateway?: number;
  /** Static neighbour entries: [ip, mac]. They never change (state PERMANENT). */
  statics?: [number, Mac][];
  /** Answer "ping" with "pong". Default true. */
  echo?: boolean;
  /** Forward IP packets that are not for this host (a router, or an attacker in the middle). */
  forward?: boolean;
  /** Treat every off-subnet destination as delivered (a gateway to the Internet). */
  internet?: boolean;
  /** An upper layer (TCP) confirms reachability when data comes back from a neighbour. */
  upperConfirm?: boolean;
  /** Take frames for every MAC. */
  promiscuous?: boolean;
  neigh?: Partial<NeighParams>;
}

export interface SwitchPortCfg {
  mode: "access" | "trunk";
  /** Access VLAN, or the native (untagged) VLAN of a trunk. Default 1. */
  vid: number;
  /** VLANs a trunk carries. Default: all. */
  allowed?: number[];
}

export interface SwitchDef {
  kind: "switch";
  name: string;
  mac: Mac;
  /** Bridge priority, a multiple of 4096. Default 32768. */
  priority?: number;
  /** MAC table ageing time in ms. Default 300 s. */
  agingMs?: number;
  stp?: boolean;
  /** Skip listening and learning (RSTP-like). */
  rapid?: boolean;
  timers?: Partial<typeof STP_TIMERS>;
  /** Port settings keyed by the neighbour node. Default: access port in VLAN 1. */
  ports?: Record<number, SwitchPortCfg>;
  /** Dynamic ARP inspection: allowed (MAC, IP) pairs, as DHCP snooping would learn them, and trusted neighbours. */
  inspect?: { bindings: [Mac, number][]; trusted: number[] };
}

export type NodeDef = HostDef | SwitchDef;

export interface LanEvent {
  t: number;
  node: number;
  text: string;
  tone?: "good" | "bad" | "warn" | "info";
}

export interface LanOpts {
  seed?: number;
  record?: boolean;
  /** Called for every frame that reaches a node, before the node handles it. */
  onFrame?: (node: number, pkt: Packet<Frame>, port: Port) => void;
}

/** A switched Ethernet segment (or several, joined by switches) on PacketNet. */
export class Lan {
  readonly net: PacketNet<Frame>;
  readonly nodes: (Host | Switch)[];
  readonly events: LanEvent[] = [];
  private opts: LanOpts;

  constructor(defs: NodeDef[], opts: LanOpts = {}) {
    this.opts = opts;
    this.net = new PacketNet<Frame>(defs.map((d) => d.name), { seed: opts.seed ?? 1, record: opts.record ?? true }, {
      onReceive: (node, pkt, port) => {
        this.opts.onFrame?.(node, pkt, port);
        this.nodes[node]!.receive(this, pkt, port);
        return true;
      },
      onTimer: (node, tag) => this.nodes[node]!.timer(this, tag),
    });
    this.nodes = defs.map((d, i) => (d.kind === "host" ? new Host(i, d) : new Switch(i, d)));
  }

  get now() {
    return this.net.now;
  }

  /** Joins two nodes. Default: 1 Gb/s, 1 µs of cable. */
  link(a: number, b: number, spec: Partial<LinkSpec> = {}) {
    return this.net.connect(a, b, { rate: 1e9, delay: 0.001, ...spec });
  }

  /** Call after all links exist: starts STP on the switches that run it. */
  start() {
    for (const n of this.nodes) if (n instanceof Switch) n.start(this);
  }

  host(i: number): Host {
    const n = this.nodes[i];
    if (!(n instanceof Host)) throw new Error(`${i} is not a host`);
    return n;
  }

  sw(i: number): Switch {
    const n = this.nodes[i];
    if (!(n instanceof Switch)) throw new Error(`${i} is not a switch`);
    return n;
  }

  /** Puts a frame on one port. */
  emit(node: number, port: Port, frame: Frame) {
    const pkt = this.net.packet(node, port.peer, wireBytes(frame), frame);
    this.net.transmit(port.id, pkt);
  }

  log(node: number, text: string, tone?: LanEvent["tone"]) {
    if (this.net.cfg.record) this.events.push({ t: this.now, node, text, tone });
  }

  /** Every switch forgets what it learned (after a spanning tree change). */
  flushTables() {
    for (const n of this.nodes) if (n instanceof Switch) n.table.clear();
  }

  /** Runs `fn` at time t. */
  at(t: number, fn: (lan: Lan) => void) {
    this.net.at(t, () => fn(this));
  }

  /** A host sends a ping (an IP packet with data "ping") to an IP address. */
  ping(from: number, dst: number, size = 84) {
    this.host(from).sendIp(this, dst, "ping", size);
  }
}

const sameSubnet = (a: number, b: number, prefix: number) => {
  const m = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((a & m) >>> 0) === ((b & m) >>> 0);
};

/** A host with one interface: ARP, a neighbour cache, and a tiny IP layer. */
export class Host {
  readonly def: HostDef;
  readonly neigh = new Map<number, NeighEntry>();
  readonly params: NeighParams;
  /** This host's reachable time: base × a random factor in [0.5, 1.5), drawn on first use. */
  reachableMs = 0;
  readonly inbox: { t: number; ip: IpPacket }[] = [];
  readonly stats = { sent: 0, delivered: 0, unresolved: 0, forwarded: 0, toInternet: 0, nicDropped: 0, arpSent: 0 };
  mac: Mac;

  constructor(readonly id: number, def: HostDef) {
    this.def = def;
    this.mac = def.mac;
    this.params = { ...LINUX_NEIGH, ...def.neigh };
    for (const [ip, m] of def.statics ?? []) {
      this.neigh.set(ip, { ip, mac: m, state: "PERMANENT", confirmed: 0, since: 0, probes: 0, queue: [], history: [{ t: 0, state: "PERMANENT", mac: m }] });
    }
  }

  get ip() {
    return this.def.ip;
  }

  private port(lan: Lan): Port {
    return lan.net.portsAt(this.id)[0]!;
  }

  private send(lan: Lan, frame: Frame) {
    const p = this.port(lan);
    lan.emit(this.id, p, frame);
  }

  sendArp(lan: Lan, arp: ArpPacket, dst: Mac) {
    this.stats.arpSent++;
    this.send(lan, { dst, src: this.mac, body: { kind: "arp", arp } });
  }

  /** Sends an ARP announcement (gratuitous ARP): "my IP is at my MAC", to everyone. */
  announce(lan: Lan) {
    lan.log(this.id, `gratuitous ARP: ${formatIpv4(this.ip)} is at ${this.mac}`, "info");
    this.sendArp(lan, { op: 1, sha: this.mac, spa: this.ip, tha: "00:00:00:00:00:00", tpa: this.ip }, BROADCAST);
  }

  /** A new network card: the IP stays, the MAC changes. */
  setMac(m: Mac) {
    this.mac = m;
  }

  /** Forgets every dynamic neighbour entry (`ip neigh flush`). */
  flush() {
    for (const [ip, e] of this.neigh) if (e.state !== "PERMANENT") this.neigh.delete(ip);
  }

  sendIp(lan: Lan, dst: number, data: string, size = 84) {
    this.stats.sent++;
    this.route(lan, { src: this.ip, dst, data, size });
  }

  private route(lan: Lan, ip: IpPacket) {
    const prefix = this.def.prefix ?? 24;
    if (!sameSubnet(ip.dst, this.ip, prefix)) {
      if (this.def.internet) {
        this.stats.toInternet++;
        lan.log(this.id, `${ip.data} to ${formatIpv4(ip.dst)} leaves for the Internet`, "good");
        return;
      }
      if (this.def.gateway === undefined) return;
      return this.output(lan, this.def.gateway, ip);
    }
    this.output(lan, ip.dst, ip);
  }

  private set(lan: Lan, e: NeighEntry, state: NeighState) {
    if (e.state === state && e.history.length) {
      const last = e.history[e.history.length - 1]!;
      if (last.mac === e.mac) return;
    }
    e.state = state;
    e.since = lan.now;
    e.history.push({ t: lan.now, state, mac: e.mac });
  }

  private arm(lan: Lan, e: NeighEntry, delay: number) {
    if (e.timer !== undefined) lan.net.cancelTimer(e.timer);
    e.timer = lan.net.setTimer(this.id, delay, `neigh:${e.ip}`);
  }

  private reach(lan: Lan) {
    if (!this.reachableMs) this.reachableMs = this.params.baseReachableMs * (0.5 + lan.net.random());
    return this.reachableMs;
  }

  private toReachable(lan: Lan, e: NeighEntry) {
    e.confirmed = lan.now;
    this.set(lan, e, "REACHABLE");
    this.arm(lan, e, this.reach(lan));
  }

  /** Sends an IP packet to a neighbour on the link, resolving its MAC first if needed. */
  private output(lan: Lan, next: number, ip: IpPacket) {
    let e = this.neigh.get(next);
    if (!e || e.state === "FAILED") {
      e = { ip: next, state: "FAILED", confirmed: -Infinity, since: lan.now, probes: 0, queue: [], history: e?.history ?? [] };
      this.neigh.set(next, e);
      this.set(lan, e, "INCOMPLETE");
      e.queue.push(ip);
      this.solicit(lan, e, true);
      return;
    }
    if (e.state === "INCOMPLETE") {
      e.queue.push(ip);
      return;
    }
    if (e.state === "STALE") {
      this.set(lan, e, "DELAY");
      this.arm(lan, e, this.params.delayFirstProbeMs);
    }
    this.send(lan, { dst: e.mac!, src: this.mac, body: { kind: "ip", ip } });
  }

  private solicit(lan: Lan, e: NeighEntry, broadcast: boolean) {
    e.probes++;
    const arp: ArpPacket = { op: 1, sha: this.mac, spa: this.ip, tha: broadcast ? "00:00:00:00:00:00" : e.mac!, tpa: e.ip };
    this.sendArp(lan, arp, broadcast ? BROADCAST : e.mac!);
    this.arm(lan, e, this.params.retransMs);
  }

  timer(lan: Lan, tag: string) {
    const ipn = Number(tag.split(":")[1]);
    const e = this.neigh.get(ipn);
    if (!e) return;
    e.timer = undefined;
    switch (e.state) {
      case "INCOMPLETE":
      case "PROBE": {
        const limit = e.state === "INCOMPLETE" ? this.params.mcastSolicit : this.params.ucastSolicit;
        if (e.probes < limit) return this.solicit(lan, e, e.state === "INCOMPLETE");
        this.set(lan, e, "FAILED");
        this.stats.unresolved += e.queue.length;
        if (e.queue.length) lan.log(this.id, `no answer for ${formatIpv4(e.ip)}: ${e.queue.length} packet(s) dropped`, "bad");
        e.queue = [];
        return;
      }
      case "REACHABLE": {
        const due = e.confirmed + this.reach(lan);
        if (lan.now >= due - 1e-9) this.set(lan, e, "STALE");
        else this.arm(lan, e, due - lan.now);
        return;
      }
      case "DELAY": {
        if (e.confirmed >= e.since) return this.toReachable(lan, e);
        this.set(lan, e, "PROBE");
        e.probes = 0;
        return this.solicit(lan, e, false);
      }
      default:
        return;
    }
  }

  /** Called by an upper layer (TCP saw new data acknowledged): the neighbour is alive. */
  confirm(lan: Lan, ip: number) {
    const e = this.neigh.get(ip);
    if (e && e.state !== "PERMANENT" && e.state !== "INCOMPLETE" && e.state !== "FAILED") e.confirmed = lan.now;
  }

  receive(lan: Lan, pkt: Packet<Frame>, _port: Port) {
    const f = pkt.payload;
    if (f.dst !== this.mac && !isGroupMac(f.dst) && !this.def.promiscuous) {
      this.stats.nicDropped++;
      return;
    }
    if (f.body.kind === "arp") return this.onArp(lan, f.body.arp);
    if (f.body.kind === "ip") {
      if (f.dst !== this.mac) return;
      return this.onIp(lan, f.body.ip);
    }
  }

  private onArp(lan: Lan, a: ArpPacket) {
    const forMe = a.tpa === this.ip;
    const e = this.neigh.get(a.spa);
    if (a.spa === this.ip && a.sha !== this.mac) lan.log(this.id, `address conflict: ${a.sha} also claims ${formatIpv4(a.spa)}`, "warn");
    // RFC 826: if the sender is already in the table, update it first (the "merge" step).
    if (e && e.state !== "PERMANENT" && a.spa !== this.ip) {
      const changed = e.mac !== a.sha;
      const wasIncomplete = e.state === "INCOMPLETE";
      e.mac = a.sha;
      if (a.op === 2 && forMe) {
        this.toReachable(lan, e);
      } else if (changed || wasIncomplete) {
        if (e.timer !== undefined) lan.net.cancelTimer(e.timer);
        e.timer = undefined;
        this.set(lan, e, "STALE");
      }
      if (changed && !wasIncomplete) lan.log(this.id, `${formatIpv4(a.spa)} now maps to ${a.sha}`, "warn");
      if (e.queue.length) {
        const q = e.queue;
        e.queue = [];
        for (const ip of q) this.send(lan, { dst: e.mac, src: this.mac, body: { kind: "ip", ip } });
      }
    } else if (!e && forMe && a.op === 1) {
      // A request for us: add the asker, so that the reply and its answer need no ARP of their own.
      const n: NeighEntry = { ip: a.spa, mac: a.sha, state: "STALE", confirmed: -Infinity, since: lan.now, probes: 0, queue: [], history: [] };
      n.history.push({ t: lan.now, state: "STALE", mac: a.sha });
      this.neigh.set(a.spa, n);
    }
    if (forMe && a.op === 1 && a.spa !== a.tpa) {
      this.sendArp(lan, { op: 2, sha: this.mac, spa: this.ip, tha: a.sha, tpa: a.spa }, a.sha);
    }
  }

  private onIp(lan: Lan, ip: IpPacket) {
    if (ip.dst !== this.ip) {
      if (!this.def.forward) return;
      this.stats.forwarded++;
      return this.route(lan, ip);
    }
    this.stats.delivered++;
    if (lan.net.cfg.record) this.inbox.push({ t: lan.now, ip });
    if (this.def.upperConfirm) {
      const prefix = this.def.prefix ?? 24;
      this.confirm(lan, sameSubnet(ip.src, this.ip, prefix) ? ip.src : this.def.gateway ?? ip.src);
    }
    if (ip.data.startsWith("ping") && this.def.echo !== false) this.sendIp(lan, ip.src, `pong${ip.data.slice(4)}`, ip.size);
  }
}

interface StpPort {
  role: PortRole;
  state: PortState;
  info: (Bpdu & { expires: number }) | null;
  timer?: number;
  edge: boolean;
}

const better = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
};

/** A learning switch (a bridge): MAC table, flooding, VLANs, and optionally STP and ARP inspection. */
export class Switch {
  readonly def: SwitchDef;
  /** `${vid}|${mac}` → port id and last time seen. */
  readonly table = new Map<string, { port: number; seen: number; vid: number; mac: Mac }>();
  readonly stats = { flooded: 0, forwarded: 0, filtered: 0, moves: 0, dropped: 0, inspected: 0, bpdus: 0, changes: 0 };
  readonly bridgeId: number;
  readonly stp = new Map<number, StpPort>();
  rootId: number;
  rootCost = 0;
  rootPort: number | null = null;
  private timers: typeof STP_TIMERS;

  constructor(readonly id: number, def: SwitchDef) {
    this.def = def;
    const low = parseInt(def.mac.replace(/:/g, "").slice(6), 16);
    this.bridgeId = (def.priority ?? 32768) * 2 ** 24 + low;
    this.rootId = this.bridgeId;
    this.timers = { ...STP_TIMERS, ...def.timers };
  }

  get agingMs() {
    return this.def.agingMs ?? 300_000;
  }

  cfg(_lan: Lan, port: Port): SwitchPortCfg {
    return this.def.ports?.[port.peer] ?? { mode: "access", vid: 1 };
  }

  private member(lan: Lan, port: Port, vid: number) {
    const c = this.cfg(lan, port);
    return c.mode === "access" ? c.vid === vid : !c.allowed || c.allowed.includes(vid);
  }

  portState(port: Port): PortState {
    if (!this.def.stp) return "forwarding";
    return this.stp.get(port.id)?.state ?? "forwarding";
  }

  portRole(port: Port): PortRole | undefined {
    return this.def.stp ? this.stp.get(port.id)?.role : undefined;
  }

  /** The valid MAC table entries now, sorted by VLAN and MAC. */
  entries(now: number) {
    return [...this.table.values()].filter((e) => now - e.seen < this.agingMs).sort((a, b) => a.vid - b.vid || a.mac.localeCompare(b.mac));
  }

  receive(lan: Lan, pkt: Packet<Frame>, inPort: Port) {
    const f = pkt.payload;
    if (f.dst === STP_MAC) {
      if (this.def.stp && f.body.kind === "bpdu") this.onBpdu(lan, inPort, f.body.bpdu);
      return;
    }
    const c = this.cfg(lan, inPort);
    let vid: number;
    if (c.mode === "access") {
      if (f.vid !== undefined && f.vid !== c.vid) {
        this.stats.dropped++;
        return;
      }
      vid = c.vid;
    } else {
      vid = f.vid ?? c.vid;
      if (c.allowed && !c.allowed.includes(vid)) {
        this.stats.dropped++;
        return;
      }
    }
    const st = this.portState(inPort);
    if (st === "blocking" || st === "listening") {
      this.stats.dropped++;
      return;
    }
    if (this.def.inspect && f.body.kind === "arp" && !this.def.inspect.trusted.includes(inPort.peer)) {
      const a = f.body.arp;
      const ok = this.def.inspect.bindings.some(([m, ip]) => m === a.sha && ip === a.spa);
      if (!ok) {
        this.stats.inspected++;
        lan.log(this.id, `ARP inspection drops a forged ARP: ${formatIpv4(a.spa)} is not at ${a.sha}`, "good");
        return;
      }
    }
    // Learn: the source MAC lives behind the port it came in on.
    const key = `${vid}|${f.src}`;
    const old = this.table.get(key);
    if (old && old.port !== inPort.id && lan.now - old.seen < this.agingMs) this.stats.moves++;
    this.table.set(key, { port: inPort.id, seen: lan.now, vid, mac: f.src });
    if (st === "learning") return;
    let out: Port[];
    const hit = isGroupMac(f.dst) ? undefined : this.table.get(`${vid}|${f.dst}`);
    if (hit && lan.now - hit.seen < this.agingMs) {
      if (hit.port === inPort.id) {
        this.stats.filtered++;
        return;
      }
      out = [lan.net.ports[hit.port]!];
      this.stats.forwarded++;
    } else {
      out = lan.net.portsAt(this.id).filter((p) => p.id !== inPort.id && p.up && this.portState(p) === "forwarding" && this.member(lan, p, vid));
      this.stats.flooded++;
    }
    for (const p of out) {
      const pc = this.cfg(lan, p);
      const tag = pc.mode === "access" || vid === pc.vid ? undefined : vid;
      lan.emit(this.id, p, { ...f, vid: tag });
    }
  }

  // ------------------------------------------------------------ spanning tree

  /** Port priority 128 in the high byte, then the 1-based port number on this switch. */
  private portId(lan: Lan, port: Port) {
    return 0x8000 + lan.net.portsAt(this.id).findIndex((p) => p.id === port.id) + 1;
  }

  private costOf(port: Port) {
    return stpCost(port.spec.rate);
  }

  start(lan: Lan) {
    if (!this.def.stp) return;
    for (const p of lan.net.portsAt(this.id)) {
      const edge = lan.nodes[p.peer] instanceof Host;
      // Every port starts blocked; recompute() then makes it designated, and it walks through listening and learning.
      this.stp.set(p.id, { role: edge ? "edge" : "alternate", state: edge ? "forwarding" : "blocking", info: null, edge });
    }
    this.recompute(lan);
    this.hello(lan);
  }

  /** The hello timer: only the root originates configuration BPDUs. */
  private hello(lan: Lan) {
    if (this.rootId === this.bridgeId) this.sendBpdus(lan, 0);
    lan.net.setTimer(this.id, this.timers.helloMs, "hello");
  }

  private sendBpdus(lan: Lan, age: number) {
    for (const p of lan.net.portsAt(this.id)) {
      const s = this.stp.get(p.id)!;
      if (s.role === "designated" && p.up) this.sendBpdu(lan, p, age);
    }
  }

  private sendBpdu(lan: Lan, p: Port, age: number) {
    const bpdu: Bpdu = { root: this.rootId, cost: this.rootCost, bridge: this.bridgeId, port: this.portId(lan, p), age };
    lan.emit(this.id, p, { dst: STP_MAC, src: this.def.mac, body: { kind: "bpdu", bpdu } });
  }

  private myAge() {
    if (this.rootPort === null) return 0;
    return (this.stp.get(this.rootPort)?.info?.age ?? 0) + 1;
  }

  private onBpdu(lan: Lan, port: Port, b: Bpdu) {
    this.stats.bpdus++;
    const s = this.stp.get(port.id);
    if (!s || s.edge) return;
    if (b.age >= this.timers.maxAgeMs / 1000) return;
    const vec = [b.root, b.cost, b.bridge, b.port];
    const cur = s.info ? [s.info.root, s.info.cost, s.info.bridge, s.info.port] : null;
    // A port keeps the best information for its segment: its own (when designated) or what it heard. 802.1D (and
    // Linux's br_supersedes_port_info) ignores worse information, even from the same sender, until it ages out.
    // RSTP accepts worse information from the segment's designated bridge at once.
    const sameSender = !!this.def.rapid && !!s.info && s.info.bridge === b.bridge && s.info.port === b.port;
    const mine = [this.rootId, this.rootCost, this.bridgeId, this.portId(lan, port)];
    const ref = s.role === "designated" || !cur ? mine : cur;
    if (!better(ref, vec) || sameSender) {
      s.info = { ...b, expires: lan.now + this.timers.maxAgeMs - b.age * 1000 };
      lan.net.setTimer(this.id, this.timers.maxAgeMs - b.age * 1000 + 1e-6, `age:${port.id}`);
      const wasRoot = this.rootPort;
      this.recompute(lan);
      if (this.rootPort === port.id || wasRoot !== this.rootPort) this.sendBpdus(lan, this.myAge());
      else if (s.role === "designated") this.sendBpdu(lan, port, this.myAge());
    } else if (s.role === "designated") {
      // An inferior BPDU on our designated port: answer with the better information at once.
      this.sendBpdu(lan, port, this.myAge());
    }
  }

  /** Picks the root, the root port and every port's role from the stored information. */
  recompute(lan: Lan) {
    let best = [this.bridgeId, 0, this.bridgeId, 0, 0];
    let rp: number | null = null;
    for (const p of lan.net.portsAt(this.id)) {
      const s = this.stp.get(p.id)!;
      if (!s.info || !p.up) continue;
      const cand = [s.info.root, s.info.cost + this.costOf(p), s.info.bridge, s.info.port, this.portId(lan, p)];
      if (better(cand, best)) {
        best = cand;
        rp = p.id;
      }
    }
    const oldRoot = this.rootId;
    this.rootId = best[0]!;
    this.rootCost = best[1]!;
    this.rootPort = rp;
    if (oldRoot !== this.rootId) lan.log(this.id, `${lan.net.names[this.id]} now sees ${fmtBridge(this.rootId)} as root`, "info");
    for (const p of lan.net.portsAt(this.id)) {
      const s = this.stp.get(p.id)!;
      if (s.edge) continue;
      let role: PortRole;
      if (p.id === rp) role = "root";
      else if (!s.info) role = "designated";
      else {
        const mine = [this.rootId, this.rootCost, this.bridgeId, this.portId(lan, p)];
        role = better(mine, [s.info.root, s.info.cost, s.info.bridge, s.info.port]) ? "designated" : "alternate";
      }
      if (!p.up) role = "alternate";
      this.setRole(lan, p, s, role);
    }
  }

  private setRole(lan: Lan, p: Port, s: StpPort, role: PortRole) {
    if (s.role === role) return;
    const wasForwarding = s.state === "forwarding";
    s.role = role;
    if (role === "alternate") {
      if (s.timer !== undefined) lan.net.cancelTimer(s.timer);
      s.timer = undefined;
      s.state = "blocking";
      if (wasForwarding) this.topologyChange(lan, `${lan.net.names[this.id]} blocks its port to ${lan.net.names[p.peer]}`);
      return;
    }
    if (s.state === "blocking") {
      if (this.def.rapid) {
        s.state = "forwarding";
        this.topologyChange(lan, `${lan.net.names[this.id]} forwards on its port to ${lan.net.names[p.peer]}`);
      } else {
        s.state = "listening";
        s.timer = lan.net.setTimer(this.id, this.timers.fwdDelayMs, `fwd:${p.id}`);
      }
    }
  }

  private topologyChange(lan: Lan, why: string) {
    this.stats.changes++;
    lan.log(this.id, why, "info");
    lan.flushTables();
  }

  timer(lan: Lan, tag: string) {
    if (tag === "hello") return this.hello(lan);
    const [kind, id] = tag.split(":");
    const port = lan.net.ports[Number(id)]!;
    const s = this.stp.get(port.id);
    if (!s) return;
    if (kind === "fwd") {
      s.timer = undefined;
      if (s.state === "listening") {
        s.state = "learning";
        s.timer = lan.net.setTimer(this.id, this.timers.fwdDelayMs, `fwd:${port.id}`);
      } else if (s.state === "learning") {
        s.state = "forwarding";
        this.topologyChange(lan, `${lan.net.names[this.id]} forwards on its port to ${lan.net.names[port.peer]}`);
      }
    } else if (kind === "age") {
      if (s.info && lan.now >= s.info.expires - 1e-6) {
        s.info = null;
        lan.log(this.id, `${lan.net.names[this.id]}: BPDU information on the port to ${lan.net.names[port.peer]} reached max age`, "warn");
        const wasRoot = this.rootId === this.bridgeId;
        this.recompute(lan);
        if (!wasRoot && this.rootId === this.bridgeId) this.sendBpdus(lan, 0);
        else this.sendBpdus(lan, this.myAge());
      }
    }
  }

  /** A link of this switch went down or up: drop what it held and recompute at once. */
  linkChanged(lan: Lan, port: Port) {
    const s = this.stp.get(port.id);
    if (!s) return;
    if (!port.up) s.info = null;
    this.recompute(lan);
    this.sendBpdus(lan, this.myAge());
  }
}

/** "32768.0a": the priority, then the low byte of the MAC. */
export const fmtBridge = (id: number) => `${Math.floor(id / 2 ** 24)}.${(id % 2 ** 24 & 0xff).toString(16).padStart(2, "0")}`;

/** Takes a link down (or up) and tells the switches at both ends, as a real port sees loss of signal at once. */
export function setLinkUp(lan: Lan, link: number, up: boolean) {
  lan.net.setLinkUp(link, up);
  for (const p of lan.net.ports.filter((x) => x.link === link)) {
    const n = lan.nodes[p.node];
    if (n instanceof Switch && n.def.stp) n.linkChanged(lan, p);
  }
}

/** A short label for a frame, for space-time diagrams. */
export function frameLabel(f: Frame): string {
  const b = f.body;
  if (b.kind === "arp") {
    const last = (ip: number) => `.${ip & 0xff}`;
    if (b.arp.op === 1) return b.arp.spa === b.arp.tpa ? `GARP ${last(b.arp.spa)}` : `who has ${last(b.arp.tpa)}?`;
    return `${last(b.arp.spa)} is at …${b.arp.sha.slice(-2)}`;
  }
  if (b.kind === "ip") return b.ip.data;
  if (b.kind === "bpdu") return "BPDU";
  return b.text;
}
