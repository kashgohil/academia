/**
 * Network namespaces: each one has its own interfaces, routes and neighbor table.
 * A veth pair is a cable with one end in each namespace. A bridge is a learning switch.
 * NetSim is a small real forwarder: longest-prefix routing, ARP, a bridge FDB that learns, and source NAT.
 */
export type IpNum = number;
export const ip = (s: string): IpNum => s.split(".").reduce((a, b) => a * 256 + Number(b), 0);
export const ipStr = (n: IpNum) => [24, 16, 8, 0].map((sh) => Math.floor(n / 2 ** sh) % 256).join(".");
export const inPrefix = (addr: IpNum, net: IpNum, bits: number) => {
  const size = 2 ** (32 - bits);
  return Math.floor(addr / size) === Math.floor(net / size);
};

export type NsId = "host" | "red" | "blue";
export interface Iface { name: string; ns: NsId; mac: string; ip: IpNum | null; bits: number; peer?: string; bridgePort?: boolean }
export interface Route { net: IpNum; bits: number; dev: string; via?: IpNum }

export const BRIDGE = "docker0";
export const UPLINK = "eth0";
export const GATEWAY = "192.168.1.1";

export type HopKind = "route" | "arp" | "veth" | "bridge" | "flood" | "stack" | "nat" | "deliver" | "drop" | "wire";
export interface Hop { ns: NsId | "wire"; dev: string; kind: HopKind; text: string }
export interface TraceResult { ok: boolean; hops: Hop[]; /** The source address that the receiver sees. */ seenSrc?: string; deliveredIn?: NsId | "internet"; floods: number; arps: number }

export interface NetOptions { ipForward?: boolean; masquerade?: boolean }

export class NetSim {
  readonly ifaces = new Map<string, Iface>();
  readonly routes = new Map<NsId, Route[]>();
  /** ns -> ip -> mac */
  readonly neigh = new Map<NsId, Map<IpNum, string>>();
  /** The bridge forwarding table: mac -> port. */
  readonly fdb = new Map<string, string>();
  ipForward: boolean;
  masquerade: boolean;

  constructor(o: NetOptions = {}) {
    this.ipForward = o.ipForward ?? true;
    this.masquerade = o.masquerade ?? true;
    const add = (i: Iface) => this.ifaces.set(`${i.ns}/${i.name}`, i);
    add({ name: "lo", ns: "host", mac: "00:00", ip: ip("127.0.0.1"), bits: 8 });
    add({ name: UPLINK, ns: "host", mac: "aa:00", ip: ip("192.168.1.10"), bits: 24 });
    add({ name: BRIDGE, ns: "host", mac: "02:01", ip: ip("172.17.0.1"), bits: 16 });
    add({ name: "veth-r", ns: "host", mac: "ee:01", ip: null, bits: 0, peer: "red/eth0", bridgePort: true });
    add({ name: "veth-b", ns: "host", mac: "ee:02", ip: null, bits: 0, peer: "blue/eth0", bridgePort: true });
    for (const [ns, last, mac, port] of [["red", 2, "02:02", "veth-r"], ["blue", 3, "02:03", "veth-b"]] as const) {
      add({ name: "lo", ns, mac: "00:00", ip: ip("127.0.0.1"), bits: 8 });
      add({ name: "eth0", ns, mac, ip: ip(`172.17.0.${last}`), bits: 16, peer: `host/${port}` });
      this.routes.set(ns, [
        { net: ip("127.0.0.0"), bits: 8, dev: "lo" },
        { net: ip("172.17.0.0"), bits: 16, dev: "eth0" },
        { net: 0, bits: 0, dev: "eth0", via: ip("172.17.0.1") },
      ]);
      this.neigh.set(ns, new Map());
    }
    this.routes.set("host", [
      { net: ip("127.0.0.0"), bits: 8, dev: "lo" },
      { net: ip("172.17.0.0"), bits: 16, dev: BRIDGE },
      { net: ip("192.168.1.0"), bits: 24, dev: UPLINK },
      { net: 0, bits: 0, dev: UPLINK, via: ip(GATEWAY) },
    ]);
    this.neigh.set("host", new Map());
  }

  /** Longest prefix wins. */
  lookup(ns: NsId, dst: IpNum): Route | null {
    let best: Route | null = null;
    for (const r of this.routes.get(ns)!) if (inPrefix(dst, r.net, r.bits) && (!best || r.bits > best.bits)) best = r;
    return best;
  }

  private ownsIp(ns: NsId, a: IpNum) {
    for (const i of this.ifaces.values()) if (i.ns === ns && i.ip === a) return i;
    return null;
  }
  private portOfNs(ns: NsId) { return ns === "red" ? "veth-r" : "veth-b"; }

  /** Finds which interface on the bridge segment owns the IP. */
  private segmentOwner(a: IpNum): Iface | null {
    for (const i of this.ifaces.values()) if (i.ip === a && inPrefix(a, ip("172.17.0.0"), 16)) return i;
    return null;
  }

  /** ARP on the bridge segment: a broadcast the bridge floods, then a unicast reply. Both ends learn. */
  private arp(ns: NsId, target: IpNum, hops: Hop[], r: { floods: number; arps: number }): string | null {
    const table = this.neigh.get(ns)!;
    const known = table.get(target);
    if (known) return known;
    r.arps++;
    const owner = this.segmentOwner(target);
    const sender = this.ifaces.get(`${ns}/${ns === "host" ? BRIDGE : "eth0"}`)!;
    const srcPort = ns === "host" ? BRIDGE : this.portOfNs(ns);
    this.fdb.set(sender.mac, srcPort);
    const others = ["veth-r", "veth-b", BRIDGE].filter((p) => p !== srcPort);
    r.floods++;
    hops.push({ ns, dev: sender.name, kind: "arp", text: `No neighbor entry for ${ipStr(target)}. Send an ARP broadcast.` });
    hops.push({ ns: "host", dev: BRIDGE, kind: "flood", text: `The bridge learns ${sender.mac} on ${srcPort}, then floods the broadcast to ${others.join(" and ")}.` });
    if (!owner) { hops.push({ ns: "host", dev: BRIDGE, kind: "drop", text: "No device answers the ARP request." }); return null; }
    table.set(target, owner.mac);
    const ownerPort = owner.ns === "host" ? BRIDGE : this.portOfNs(owner.ns);
    this.fdb.set(owner.mac, ownerPort);
    this.neigh.get(owner.ns)!.set(sender.ip!, sender.mac);
    hops.push({ ns: owner.ns, dev: owner.name, kind: "arp", text: `${ipStr(target)} answers with MAC ${owner.mac}. The bridge learns that MAC on ${ownerPort}.` });
    return owner.mac;
  }

  /** Sends one packet from a namespace to an address. It changes the ARP tables and the FDB. */
  send(from: NsId, dstStr: string): TraceResult {
    const dst = ip(dstStr);
    const hops: Hop[] = [];
    const r = { floods: 0, arps: 0 };
    const fail = (): TraceResult => ({ ok: false, hops, ...r });

    const local = this.ownsIp(from, dst);
    if (local || inPrefix(dst, ip("127.0.0.0"), 8)) {
      hops.push({ ns: from, dev: "lo", kind: "route", text: `${dstStr} is local to the ${from} namespace. Use its own loopback.` });
      hops.push({ ns: from, dev: "lo", kind: "deliver", text: `Delivered inside ${from}. No other namespace sees the packet.` });
      return { ok: true, hops, seenSrc: dstStr, deliveredIn: from, ...r };
    }
    const route = this.lookup(from, dst);
    if (!route) { hops.push({ ns: from, dev: "-", kind: "drop", text: "No route: ENETUNREACH." }); return fail(); }
    const srcIf = this.ifaces.get(`${from}/${route.dev}`)!;
    const nextHop = route.via ?? dst;
    hops.push({ ns: from, dev: route.dev, kind: "route", text: `Route lookup in ${from}: ${ipStr(route.net)}/${route.bits} ${route.via ? `via ${ipStr(route.via)} ` : ""}dev ${route.dev}.` });

    let src = srcIf.ip!;
    if (from === "host" && route.dev === UPLINK) {
      hops.push({ ns: "wire", dev: UPLINK, kind: "wire", text: `Leaves the machine on ${UPLINK}.` });
      return { ok: true, hops, seenSrc: ipStr(src), deliveredIn: "internet", ...r };
    }

    const mac = this.arp(from, nextHop, hops, r);
    if (!mac) return fail();

    if (from !== "host") {
      const port = this.portOfNs(from);
      hops.push({ ns: from, dev: "eth0", kind: "veth", text: `eth0 and ${port} are the two ends of one veth pair. The frame crosses into the host namespace.` });
      this.fdb.set(srcIf.mac, port);
    }
    const out = this.fdb.get(mac);
    if (out === undefined) {
      hops.push({ ns: "host", dev: BRIDGE, kind: "drop", text: "Unknown destination MAC." });
      return fail();
    }
    hops.push({ ns: "host", dev: BRIDGE, kind: "bridge", text: `FDB lookup: MAC ${mac} is on ${out}. The bridge sends the frame to that port only.` });

    if (out !== BRIDGE) {
      const toNs: NsId = out === "veth-r" ? "red" : "blue";
      hops.push({ ns: toNs, dev: "eth0", kind: "veth", text: `${out} to eth0 of ${toNs}: the frame crosses the second veth pair.` });
      hops.push({ ns: toNs, dev: "eth0", kind: "deliver", text: `Delivered in ${toNs}. It sees source ${ipStr(src)}.` });
      return { ok: true, hops, seenSrc: ipStr(src), deliveredIn: toNs, ...r };
    }

    // The frame is addressed to the bridge itself, so it goes up to the host stack.
    if (this.ownsIp("host", dst)) {
      hops.push({ ns: "host", dev: BRIDGE, kind: "deliver", text: `${dstStr} belongs to the host. Delivered in the host namespace.` });
      return { ok: true, hops, seenSrc: ipStr(src), deliveredIn: "host", ...r };
    }
    hops.push({ ns: "host", dev: BRIDGE, kind: "stack", text: "The frame goes up to the host IP stack, which must forward it." });
    if (!this.ipForward) {
      hops.push({ ns: "host", dev: BRIDGE, kind: "drop", text: "net.ipv4.ip_forward = 0: the host drops the packet." });
      return fail();
    }
    const hr = this.lookup("host", dst)!;
    hops.push({ ns: "host", dev: hr.dev, kind: "route", text: `Route lookup in host: ${ipStr(hr.net)}/${hr.bits} dev ${hr.dev}.` });
    if (this.masquerade) {
      const up = this.ifaces.get(`host/${UPLINK}`)!;
      hops.push({ ns: "host", dev: UPLINK, kind: "nat", text: `MASQUERADE: source ${ipStr(src)} becomes ${ipStr(up.ip!)}. conntrack remembers the pair.` });
      src = up.ip!;
    } else {
      hops.push({ ns: "host", dev: UPLINK, kind: "nat", text: `No NAT rule: the private source ${ipStr(src)} goes out, and replies cannot return.` });
    }
    hops.push({ ns: "wire", dev: UPLINK, kind: "wire", text: `Leaves the machine on ${UPLINK} with source ${ipStr(src)}.` });
    return { ok: true, hops, seenSrc: ipStr(src), deliveredIn: "internet", ...r };
  }
}
