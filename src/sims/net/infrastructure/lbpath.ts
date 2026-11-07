/**
 * How a packet reaches a backend through a load balancer, on PacketNet with the reference TCP.
 *
 * The client opens one TCP connection to a virtual IP address (the VIP) and downloads a response. The VIP is a
 * node with no links: no host owns it. The edge router sends packets for the VIP to the balancer, and the balancer
 * passes them to the backend in one of four ways:
 *
 * - "nat": the balancer rewrites the destination address to the backend (DNAT, as LVS-NAT does). The backend's
 *   replies must come back through the balancer, which rewrites the source back to the VIP.
 * - "dsr": direct server return. The balancer only changes the link-layer destination (here: it puts the packet on
 *   the backend's port with the destination VIP unchanged). The backend owns the VIP on a loopback interface and
 *   answers the client directly, from the VIP, through the router.
 * - "tunnel": the balancer wraps the packet in an outer IPv4 header to the backend (IP-in-IP, RFC 2003, 20 bytes).
 *   The backend unwraps it and answers directly, as in DSR.
 * - "proxy": a full proxy (an L7 balancer, or an L4 proxy). The balancer ends the client's TCP connection and uses
 *   a second connection to the backend, either pooled (opened before the request) or opened per request.
 *
 * Model inputs: link rates and delays (`wanDelay`, `dcDelay`; the data-center delay is larger than real so that
 * a diagram can show it), request and response sizes, TCP defaults from the transport module.
 */
import { PacketNet, type NodeId, type Packet } from "../packet";
import { TcpStack, segmentSize, type TcpConn, type TcpSegment } from "../transport";

export type LbMode = "nat" | "dsr" | "tunnel" | "proxy";

export const LB_MODES: LbMode[] = ["nat", "dsr", "tunnel", "proxy"];

export const LB_MODE_LABEL: Record<LbMode, string> = {
  nat: "NAT",
  dsr: "direct server return",
  tunnel: "IP-in-IP tunnel",
  proxy: "full proxy (L7)",
};

/** Node ids. The VIP has no links. */
export const LBN = { client: 0, router: 1, lb: 2, backend: 3, vip: 4 } as const;

/** The outer IPv4 header of IP-in-IP (RFC 2003). */
export const IPIP_BYTES = 20;

export interface LbPathOpts {
  mode: LbMode;
  /** Request bytes (an HTTP request). */
  reqBytes?: number;
  /** Response bytes. */
  respBytes?: number;
  /** One-way delay between client and edge router, ms (model input). */
  wanDelay?: number;
  /** One-way delay of each data-center link, ms (model input). */
  dcDelay?: number;
  /** Proxy only: the balancer keeps an open connection to the backend. */
  pooled?: boolean;
  record?: boolean;
}

export interface LbPathRun {
  net: PacketNet<TcpSegment>;
  stack: TcpStack;
  client: TcpConn;
  /** When the client calls connect(). */
  startAt: number;
  /** Time from connect() to the first response byte at the client. */
  ttfbMs: number;
  /** Time from connect() to the last response byte. */
  doneMs: number;
  /** Bytes the balancer transmits, both directions. */
  lbBytes: number;
  lbPackets: number;
  /** Bytes on the client's access link, both directions. */
  wanBytes: number;
  /** Bytes the balancer transmits toward the client. */
  lbToClientBytes: number;
  /** Bytes the balancer transmits toward the backend. */
  lbToBackendBytes: number;
}

/** A TCP stack where some nodes send from another address: a backend that owns the VIP, a proxy, an anycast site. */
export class AliasStack extends TcpStack {
  alias: (from: NodeId, to: NodeId) => NodeId | undefined = () => undefined;
  emit(from: NodeId, to: NodeId, seg: TcpSegment) {
    const a = this.alias(from, to);
    if (a === undefined) return super.emit(from, to, seg);
    const pkt = this.net.packet(a, to, segmentSize(seg), seg, { flow: seg.info.conn });
    const port = this.net.routeOf(from, to) ?? this.net.portsAt(from)[0]!.id;
    this.net.transmit(port, pkt);
  }
}

export function lbPathRun(o: LbPathOpts): LbPathRun {
  const { mode } = o;
  const reqBytes = o.reqBytes ?? 300, respBytes = o.respBytes ?? 20_000;
  const wan = o.wanDelay ?? 10, dc = o.dcDelay ?? 1;
  const { client: C, router: R, lb: L, backend: B, vip: V } = LBN;
  const net = new PacketNet<TcpSegment>(["client", "router", "balancer", "backend", "VIP"], { seed: 1, record: o.record ?? true });
  net.connect(C, R, { rate: 100e6, delay: wan });
  net.connect(R, L, { rate: 10e9, delay: dc });
  net.connect(B, R, { rate: 10e9, delay: dc });
  net.connect(L, B, { rate: 10e9, delay: dc });
  net.computeRoutes();
  net.setRoute(R, V, net.portTo(R, L).id);
  if (mode === "nat") net.setRoute(B, C, net.portTo(B, L).id);

  const stack = new AliasStack(net, { nagle: false });
  stack.alias = (from, to) => {
    if ((mode === "dsr" || mode === "tunnel") && from === B) return V;
    if (mode === "proxy" && from === L && to === C) return V;
    return undefined;
  };
  const encapsulated = new WeakSet<Packet<TcpSegment>>();
  stack.install({
    onReceive: (node, pkt) => {
      if (node === L && pkt.dst === V) {
        if (mode === "proxy") {
          stack.deliver(L, pkt);
          return true;
        }
        if (mode === "nat") pkt.dst = B;
        if (mode === "tunnel") {
          pkt.size += IPIP_BYTES;
          encapsulated.add(pkt);
        }
        net.transmit(net.portTo(L, B).id, pkt);
        return true;
      }
      if (node === L && mode === "nat" && pkt.src === B && pkt.dst === C) {
        pkt.src = V;
        net.transmit(net.portTo(L, R).id, pkt);
        return true;
      }
      if (node === B && pkt.dst === V) {
        if (encapsulated.has(pkt)) {
          pkt.size -= IPIP_BYTES;
          encapsulated.delete(pkt);
        }
        stack.deliver(B, pkt);
        return true;
      }
      return false;
    },
  });

  // The backend: read the request, write the response.
  stack.listen(B, 80, {
    synCookies: false,
    onAccept: (s) => {
      let got = 0;
      s.onData = (_c, n) => {
        got += n;
        if (got >= reqBytes && got - n < reqBytes) s.write(respBytes);
      };
    },
  });

  // The proxy: accept the client, forward the request on a backend connection, stream the response back.
  const startAt = mode === "proxy" && o.pooled !== false ? 20 : 0;
  let pool: TcpConn | undefined;
  if (mode === "proxy") {
    if (o.pooled !== false) pool = stack.connect(L, B, 80);
    stack.listen(L, 80, {
      synCookies: false,
      onAccept: (cs) => {
        let got = 0;
        cs.onData = (_c, n) => {
          got += n;
          if (got < reqBytes || got - n >= reqBytes) return;
          const bc = pool ?? stack.connect(L, B, 80);
          bc.onData = (_b, m) => cs.write(m);
          if (bc.state === "ESTABLISHED") bc.write(reqBytes);
          else bc.onEstablished = () => bc.write(reqBytes);
        };
      },
    });
  }

  let client!: TcpConn;
  let first = NaN, done = NaN, rcv = 0;
  net.at(startAt, () => {
    client = stack.connect(C, V, 80);
    client.onEstablished = (c) => c.write(reqBytes);
    client.onData = (_c, n) => {
      if (rcv === 0) first = net.now;
      rcv += n;
      if (rcv >= respBytes && Number.isNaN(done)) done = net.now;
    };
  });
  net.runUntil(startAt + 60_000);

  const lbPorts = net.portsAt(L);
  const lbBytes = lbPorts.reduce((s, p) => s + p.stats.txBytes, 0);
  const lbPackets = lbPorts.reduce((s, p) => s + p.stats.txPackets, 0);
  const wanBytes = net.portTo(C, R).stats.txBytes + net.portTo(R, C).stats.txBytes;
  return {
    net, stack, client, startAt,
    ttfbMs: first - startAt, doneMs: done - startAt,
    lbBytes, lbPackets, wanBytes,
    lbToClientBytes: net.portTo(L, R).stats.txBytes,
    lbToBackendBytes: net.portTo(L, B).stats.txBytes,
  };
}

/** One row of the address table: what the IP header (and the outer header, if any) says on one hop. */
export interface HeaderRow {
  hop: string;
  src: string;
  dst: string;
  outer?: string;
}

/** The addresses of a request packet and a response packet on each hop, for each mode. */
export function lbHeaderRows(mode: LbMode): { request: HeaderRow[]; response: HeaderRow[] } {
  const c = "client", v = "VIP", b = "backend", l = "balancer";
  switch (mode) {
    case "nat":
      return {
        request: [{ hop: "client → balancer", src: c, dst: v }, { hop: "balancer → backend", src: c, dst: b }],
        response: [{ hop: "backend → balancer", src: b, dst: c }, { hop: "balancer → client", src: v, dst: c }],
      };
    case "dsr":
      return {
        request: [{ hop: "client → balancer", src: c, dst: v }, { hop: "balancer → backend", src: c, dst: v, outer: "new destination MAC only" }],
        response: [{ hop: "backend → client", src: v, dst: c }],
      };
    case "tunnel":
      return {
        request: [{ hop: "client → balancer", src: c, dst: v }, { hop: "balancer → backend", src: c, dst: v, outer: `outer IP ${l} → ${b}, +${IPIP_BYTES} B` }],
        response: [{ hop: "backend → client", src: v, dst: c }],
      };
    case "proxy":
      return {
        request: [{ hop: "client → balancer", src: c, dst: v }, { hop: "balancer → backend", src: l, dst: b, outer: "a second TCP connection" }],
        response: [{ hop: "backend → balancer", src: b, dst: l }, { hop: "balancer → client", src: v, dst: c }],
      };
  }
}

/** The largest TCP payload that fits a 1500-byte MTU after a tunnel header: 1500 − outer − IPv4 − TCP. */
export const tunnelMss = (mtu = 1500, outer = IPIP_BYTES) => mtu - outer - 20 - 20;
