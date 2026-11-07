/**
 * Scenarios for the handshake-and-teardown lesson, built on tcp.ts. Each returns the net (for a space-time
 * diagram), the connections and their state timelines.
 */
import { PacketNet } from "../packet";
import { fixedWindow } from "./cc";
import { backoffSchedule } from "./rto";
import { ACK, SYN, type TcpSegment } from "./segment";
import { TcpStack, type TcpConfig, type TcpConn } from "./tcp";

export type HsScenario = "normal" | "refused" | "simultaneous" | "halfclose";

export interface HsOptions {
  scenario: HsScenario;
  /** One-way delay in ms. */
  delay: number;
  /** Lose the first k copies of the SYN. */
  lostSyns: number;
  /** Lose the first k copies of the SYN-ACK. */
  lostSynAcks: number;
  /** Lose the third segment of the handshake (the client's first pure ACK). */
  lostAck: boolean;
  /** Time in TIME_WAIT (a model input; real stacks use 60 s or more). */
  timeWait: number;
  /** Link rate in bit/s. A slow link spreads the segments out in a diagram. */
  rate: number;
}

export const HS_DEFAULTS: HsOptions = { scenario: "normal", delay: 20, lostSyns: 0, lostSynAcks: 0, lostAck: false, timeWait: 400, rate: 2e6 };

export interface HsRun {
  net: PacketNet<TcpSegment>;
  stack: TcpStack;
  /** The connections to draw: the client first. */
  conns: TcpConn[];
  /** When the client reached ESTABLISHED (undefined: never). */
  connectedAt?: number;
  tEnd: number;
  /** The time the last packet arrived (TIME_WAIT may last longer). */
  lastPacket: number;
}

/** Runs one connection from start to end. The client sends a 1-segment request; the server answers with 2 segments. */
export function handshakeRun(opt: Partial<HsOptions> = {}): HsRun {
  const o = { ...HS_DEFAULTS, ...opt };
  const net = new PacketNet<TcpSegment>(["client", "server"], { seed: 3 });
  net.connect(0, 1, { rate: o.rate, delay: o.delay });
  const cfg: Partial<TcpConfig> = { timeWait: o.timeWait, delayedAck: 0, nagle: false, cc: () => fixedWindow(), isn: 0 };
  const stack = new TcpStack(net, cfg).install();
  let syns = 0, synacks = 0, acks = 0;
  net.dropIf = (pkt) => {
    const s = pkt.payload;
    if (s.flags & SYN && !(s.flags & ACK)) return pkt.src === 0 && syns++ < o.lostSyns;
    if (s.flags & SYN && s.flags & ACK) return pkt.src === 1 && synacks++ < o.lostSynAcks;
    if (o.lostAck && pkt.src === 0 && s.flags === ACK && s.len === 0 && s.info.rack === 1 && acks++ === 0) return true;
    return false;
  };
  const conns: TcpConn[] = [];
  const REQ = 1460, RESP = 2 * 1460;

  if (o.scenario === "simultaneous") {
    const a = stack.connect(0, 1, 6000, { port: 5000 });
    const b = stack.connect(1, 0, 5000, { port: 6000, isn: 100_000 });
    conns.push(a, b);
    // Both sides also close at the same moment: the FINs cross, and both pass through CLOSING.
    a.onEstablished = () => {
      a.write(1460);
      net.at(net.now + 3 * o.delay, () => {
        a.close();
        b.close();
      });
    };
  } else if (o.scenario === "refused") {
    conns.push(stack.connect(0, 1, 81));
  } else {
    let server: TcpConn | undefined;
    stack.listen(1, 80, {
      onAccept: (s) => {
        server = s;
        conns.push(s);
        if (o.scenario === "halfclose") {
          s.onEof = () => {
            s.write(RESP);
            s.close();
          };
        } else {
          s.onData = () => {
            if (s.stats.delivered === REQ) s.write(RESP);
          };
          s.onEof = () => s.close();
        }
      },
    });
    const c = stack.connect(0, 1, 80);
    conns.unshift(c);
    if (o.scenario === "halfclose") {
      c.onEstablished = () => {
        c.write(1460);
        c.close(); // shutdown(SHUT_WR): "that is the whole request"
      };
    } else {
      // In the lost-ACK case the client waits a little before it writes, so that the lost ACK is visible.
      c.onEstablished = () => net.at(net.now + (o.lostAck ? 3 * o.delay : 0), () => c.write(REQ));
      c.onData = () => {
        if (c.stats.delivered === RESP) c.close();
      };
    }
    void server;
  }
  net.runUntil(200_000);
  const last = net.trace.length ? net.trace[net.trace.length - 1]!.t : 0;
  const connectedAt = conns[0]?.stats.establishedAt;
  const lastPacket = Math.max(0, ...net.hops.map((h) => h.arriveAt ?? h.txEnd));
  return { net, stack, conns, connectedAt, tEnd: last, lastPacket };
}

/** Linux defaults: SYN-ACK retries (tcp_synack_retries = 5) with a 1 s initial timeout that doubles each time. */
export const synAckSchedule = (retries = 5, initial = 1000) => backoffSchedule(initial, retries);

// ==================================================================== SYN flood

export interface FloodOptions {
  /** Spoofed SYNs per second. */
  rate: number;
  /** Half-open entries the listener keeps (a model input). */
  backlog: number;
  cookies: boolean;
  /** ms. */
  duration: number;
  /** A real client tries to connect every this many ms. */
  every: number;
  /** One-way delay from each client to the server in ms. */
  delay: number;
  seed: number;
}

export const FLOOD_DEFAULTS: FloodOptions = { rate: 200, backlog: 128, cookies: false, duration: 10_000, every: 1000, delay: 10, seed: 1 };

export interface FloodRun {
  /** [t, half-open entries] every 100 ms. */
  halfOpen: [number, number][];
  /** Each real connect: when it started and when it reached ESTABLISHED. */
  attempts: { start: number; done?: number }[];
  synsDropped: number;
  cookiesSent: number;
  cookiesOk: number;
}

/**
 * An attacker sends SYNs with spoofed source addresses. The SYN-ACKs go to an address that does not answer, so
 * each entry stays half-open until its SYN-ACK retries run out (63 s with Linux defaults). A real client
 * connects now and then. Without cookies, its SYNs meet a full backlog and are dropped.
 */
export function synFloodRun(opt: Partial<FloodOptions> = {}): FloodRun {
  const o = { ...FLOOD_DEFAULTS, ...opt };
  // 0 attacker, 1 client, 2 router, 3 server, 4 the spoofed address (not connected: no route).
  const net = new PacketNet<TcpSegment>(["attacker", "client", "router", "server", "spoofed"], { seed: o.seed, record: false });
  net.connect(0, 2, { rate: 100e6, delay: 1 });
  net.connect(1, 2, { rate: 100e6, delay: o.delay - 1 });
  net.connect(2, 3, { rate: 100e6, delay: 1 });
  net.computeRoutes();
  const stack = new TcpStack(net, { timeWait: 0 }).install();
  const l = stack.listen(3, 80, { backlog: o.backlog, synCookies: o.cookies });
  const attempts: FloodRun["attempts"] = [];
  const halfOpen: [number, number][] = [];
  const gap = 1000 / o.rate;
  for (let i = 0; i * gap < o.duration; i++) {
    net.at(i * gap, () => {
      const seg: TcpSegment = {
        proto: "tcp", sport: 1024 + Math.floor(net.random() * 60000), dport: 80, seq: Math.floor(net.random() * 4294967296), ack: 0, flags: SYN,
        wnd: 65535, len: 0, opts: { mss: 1460 }, info: { rseq: 0, rack: 0, retx: 0, why: "syn", conn: -1 },
      };
      stack.spoof(0, 4, 3, seg);
    });
  }
  for (let t = 500; t < o.duration; t += o.every) {
    net.at(t, () => {
      const a: FloodRun["attempts"][number] = { start: net.now };
      attempts.push(a);
      const c = stack.connect(1, 3, 80);
      c.onEstablished = () => {
        a.done = net.now;
        c.abort();
      };
    });
  }
  for (let t = 0; t <= o.duration; t += 100) net.at(t, () => halfOpen.push([t, l.halfOpen.size]));
  net.runUntil(o.duration);
  return { halfOpen, attempts, synsDropped: l.stats.synDropped, cookiesSent: l.stats.cookiesSent, cookiesOk: l.stats.cookiesOk };
}

// ==================================================================== TIME_WAIT

export type TwScenario = "lastAck" | "oldDup";

export interface TwRun {
  net: PacketNet<TcpSegment>;
  stack: TcpStack;
  conns: TcpConn[];
  /** How the server's (first) connection ended. */
  serverEnd?: string;
  /** Bytes of an old connection that the new one accepted as its own data. */
  corrupted: number;
  /** The port of the second connection (oldDup only). */
  port2?: number;
  tEnd: number;
}

/**
 * lastAck: the client closes first; its final ACK is lost; the server sends FIN again. With TIME_WAIT the client
 * acknowledges it; without, the client stack answers with RST and the server sees an error.
 *
 * oldDup: the network holds one data segment of a first connection for a long time (a routing loop, say). The client
 * then opens a second connection. Without TIME_WAIT it may reuse the same port; if the new ISN puts the old
 * segment inside the new window, the server takes it as data. The run picks the same ISN to show this case.
 */
export function timeWaitRun(scenario: TwScenario, timeWait: boolean, delay = 20): TwRun {
  const net = new PacketNet<TcpSegment>(["client", "server"], { seed: 5 });
  net.connect(0, 1, { rate: 10e6, delay });
  const TW = timeWait ? 2000 : 0;
  const stack = new TcpStack(net, { delayedAck: 0, nagle: false, timeWait: TW, cc: () => fixedWindow(), isn: 0 }).install();
  const conns: TcpConn[] = [];
  let serverEnd: string | undefined;
  const servers: TcpConn[] = [];
  stack.listen(1, 80, {
    synCookies: false,
    onAccept: (s) => {
      servers.push(s);
      conns.push(s);
      s.onEof = () => s.close();
      s.onClose = (_c, r) => {
        if (servers[0] === s) serverEnd = r;
      };
    },
  });
  const c1 = stack.connect(0, 1, 80, { port: 40000 });
  conns.unshift(c1);
  let port2: number | undefined;

  if (scenario === "lastAck") {
    c1.onEstablished = () => {
      c1.write(1460);
      c1.close();
    };
    let dropped = false;
    net.dropIf = (pkt) => {
      const s = pkt.payload;
      const srv = servers[0];
      // The client's ACK of the server's FIN: the last segment of the close.
      if (!dropped && srv?.finSent && pkt.src === 0 && s.flags === ACK && s.len === 0 && s.info.rack === srv.nxt) {
        dropped = true;
        return true;
      }
      return false;
    };
    net.runUntil(5000);
  } else {
    // The first connection sends 3 segments; the network holds the first copy of segment 2.
    let held: { pkt: import("../packet").Packet<TcpSegment>; port: number } | undefined;
    net.dropIf = (pkt, port) => {
      const s = pkt.payload;
      if (!held && pkt.src === 0 && s.info.conn === c1.id && s.len > 0 && s.info.rseq === 1461 && s.info.retx === 0) {
        held = { pkt: { ...pkt, payload: { ...s, opts: { ...s.opts }, info: { ...s.info } } }, port: port.id };
        return true;
      }
      return false;
    };
    c1.onEstablished = () => {
      c1.write(3 * 1460);
      c1.close();
    };
    c1.onClose = () => {
      // Open a second connection right away, from the same port if the system allows it.
      net.at(net.now + 10, () => {
        let c2: TcpConn;
        try {
          c2 = stack.connect(0, 1, 80, { port: 40000 });
          port2 = 40000;
        } catch {
          c2 = stack.connect(0, 1, 80, { port: 40001 });
          port2 = 40001;
        }
        conns.splice(1, 0, c2);
        c2.onEstablished = () => {
          // The old segment comes out of the network just after the new handshake.
          if (held) {
            const h = held;
            net.at(net.now + 1, () => net.transmit(h.port, h.pkt));
          }
          net.at(net.now + 4 * delay, () => {
            c2.write(3 * 1460);
            c2.close();
          });
        };
      });
    };
    if (timeWait) {
      // With TIME_WAIT, the first connection is still there: the client cannot wait 2 MSL here, so it opens the
      // second connection as soon as the first one enters TIME_WAIT.
      const orig = c1.onClose;
      c1.onClose = undefined;
      const watch = () => {
        if (c1.state === "TIME_WAIT") orig?.(c1, "normal");
        else if (c1.state !== "CLOSED") net.at(net.now + 1, watch);
      };
      net.at(1, watch);
    }
    net.runUntil(5000);
  }
  const corrupted = conns.reduce((a, c) => a + c.stats.corrupted, 0);
  const last = net.trace.length ? net.trace[net.trace.length - 1]!.t : 0;
  return { net, stack, conns, serverEnd, corrupted, port2, tEnd: last };
}


/**
 * New connections per second that one client address can open to one server address and port, when each closed
 * connection holds its local port in TIME_WAIT for `timeWaitMs`. Linux defaults: ports 32768–60999, 60 s.
 */
export const timeWaitConnRate = (lo = 32768, hi = 60999, timeWaitMs = 60_000) => (hi - lo + 1) / (timeWaitMs / 1000);
