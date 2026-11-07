/**
 * Anycast and TCP: a route change in the middle of a connection, on PacketNet with the reference TCP.
 *
 * Two sites, A and B, own the same address (the anycast address, a node with no links). The client's router sends
 * packets for that address to the site that its current BGP route points to. Both sites run the same server. At
 * `flipAt` the route moves to site B (a link failure, a withdrawal, a policy change upstream); with `flipBack`, it
 * moves back later. Site B has no socket for the connection, so it answers the client's next segment with RST
 * (RFC 9293: a segment for no connection gets a reset), and the client's connection dies. Site A keeps sending into
 * a connection that no longer exists until its retransmissions give up.
 *
 * Model inputs: delays, sizes and the flip times. `breakChance` gives the closed form for random route changes.
 */
import { PacketNet } from "../packet";
import type { TcpConn, TcpSegment } from "../transport";
import { AliasStack } from "./lbpath";

export const ATCP = { client: 0, router: 1, siteA: 2, siteB: 3, addr: 4 } as const;

export interface AnycastTcpOpts {
  /** Response bytes. */
  respBytes?: number;
  /** When the route moves to site B, ms; null: never. */
  flipAt?: number | null;
  /** When it moves back to A, ms; null: never. */
  flipBack?: number | null;
  /** One-way delays, ms (model inputs). */
  clientDelay?: number;
  delayA?: number;
  delayB?: number;
  record?: boolean;
}

export interface AnycastTcpRun {
  net: PacketNet<TcpSegment>;
  client: TcpConn;
  /** Bytes the client received. */
  received: number;
  /** Completion time, or NaN. */
  doneMs: number;
  /** Why the client's connection ended, if it did. */
  clientEnd?: string;
  resetAt: number;
  /** Segments that site B answered with RST. */
  rstFromB: number;
  /** Segments site A sent after the client's connection died. */
  orphanSegs: number;
}

export function anycastTcpRun(o: AnycastTcpOpts = {}): AnycastTcpRun {
  const resp = o.respBytes ?? 100_000;
  const { client: C, router: R, siteA: A, siteB: B, addr: X } = ATCP;
  const net = new PacketNet<TcpSegment>(["client", "router", "site A", "site B", "anycast"], { seed: 1, record: o.record ?? true });
  net.connect(C, R, { rate: 50e6, delay: o.clientDelay ?? 5 });
  net.connect(R, A, { rate: 1e9, delay: o.delayA ?? 10 });
  net.connect(R, B, { rate: 1e9, delay: o.delayB ?? 20 });
  net.computeRoutes();
  let toward: number = A;
  // A 16 KB receive buffer keeps about 11 segments in flight, so that a diagram stays readable.
  const stack = new AliasStack(net, { nagle: false, rcvBuf: 16_384, rcvBufMax: 16_384 });
  stack.alias = (from) => (from === A || from === B ? X : undefined);
  let rstFromB = 0;
  stack.install({
    onReceive: (node, pkt) => {
      if (node === R && pkt.dst === X) {
        net.transmit(net.portTo(R, toward).id, pkt);
        return true;
      }
      if ((node === A || node === B) && pkt.dst === X) {
        stack.deliver(node, pkt);
        return true;
      }
      return false;
    },
  });
  for (const site of [A, B]) {
    stack.listen(site, 80, {
      synCookies: false,
      onAccept: (s) => {
        s.onData = (_c, n) => { if (n > 0 && s.written === 0) s.write(resp); };
      },
    });
  }
  if (o.flipAt != null) net.at(o.flipAt, () => { toward = B; net.note(R, "route → site B"); });
  if (o.flipBack != null) net.at(o.flipBack, () => { toward = A; net.note(R, "route → site A"); });

  const client = stack.connect(C, X, 80);
  let received = 0, done = NaN, resetAt = NaN;
  client.onEstablished = (c) => c.write(200);
  client.onData = (_c, n) => {
    received += n;
    if (received >= resp && Number.isNaN(done)) done = net.now;
  };
  client.onClose = (_c, reason) => { if (reason !== "normal") resetAt = net.now; };
  net.runUntil(30_000);
  // RSTs from site B: count segments B answered with a reset.
  for (const e of net.trace) if (e.kind === "tx" && e.pkt.payload.info.why === "rst" && net.ports[e.port]!.node === B) rstFromB++;
  let orphanSegs = 0;
  if (!Number.isNaN(resetAt)) for (const e of net.trace) if (e.kind === "tx" && e.t > resetAt && net.ports[e.port]!.node === A && e.pkt.payload.len > 0) orphanSegs++;
  return { net, client, received, doneMs: done, clientEnd: client.state === "CLOSED" ? client.reason : undefined, resetAt, rstFromB, orphanSegs };
}

/**
 * The chance that a connection of `durationS` sees at least one route change, when changes come as a Poisson
 * process with a mean time between changes of `mtbfS`: 1 − e^(−d/m).
 */
export const breakChance = (durationS: number, mtbfS: number) => 1 - Math.exp(-durationS / mtbfS);
