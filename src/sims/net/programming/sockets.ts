/**
 * The Berkeley socket API on top of the reference TCP (../transport). TcpStack models the protocol. This file adds
 * what the kernel keeps between the protocol and the program:
 *
 * - `ListenSocket`: the accept queue of a listening socket, next to the SYN queue that TcpListener already has.
 *   When the accept queue is full, Linux drops new SYNs and ignores the final ACK of a handshake (the request stays
 *   in SYN_RECEIVED and the SYN-ACK is sent again). `acceptQueueRun` shows a burst of clients against a slow server.
 * - `lifecycleRun`: one client and one server that call socket, bind, listen, connect, accept, read, write, shutdown
 *   and close, with the return value of each call on a timeline. Scenarios: a late accept(), a write after the peer
 *   closed (EPIPE), and close() with unread data (RST).
 * - `streamRun`: short writes into a small send buffer and reads that ignore message boundaries.
 *
 * SOCK_FACTS holds real values; everything else that is a number of the model is an input of the run.
 */
import { PacketNet, type NodeId, type Packet } from "../packet";
import { ACK, RST, SYN, TcpStack, isTcp, timeWaitConnRate, type TcpConfig, type TcpConn, type TcpListener, type TcpSegment } from "../transport";

export const SOCK_FACTS = {
  /** net.ipv4.ip_local_port_range default. */
  ephemeralLo: 32768,
  ephemeralHi: 60999,
  /** Linux TCP_TIMEWAIT_LEN. */
  timeWaitMs: 60_000,
  /** net.core.somaxconn default since Linux 5.4. */
  somaxconn: 4096,
  /**
   * Linux: sk_acceptq_is_full() is `sk_ack_backlog > sk_max_ack_backlog`, so one more connection than the backlog
   * can wait to be accepted.
   */
  acceptQueueExtra: 1,
  /** Initial retransmission timeout for a SYN or SYN-ACK (RFC 6298, Linux TCP_TIMEOUT_INIT). */
  synRtoMs: 1000,
} as const;

/** Ephemeral ports in the default range. */
export const ephemeralPorts = (lo: number = SOCK_FACTS.ephemeralLo, hi: number = SOCK_FACTS.ephemeralHi) => hi - lo + 1;

/** New connections per second to one (address, port) before TIME_WAIT uses up the ports: one source address. */
export const portLimitedRate = (destinations = 1, sources = 1) => timeWaitConnRate() * destinations * sources;

// ============================================================================ a world of sockets

/** A net of named hosts with one TcpStack, and receive hooks that can drop a segment before TCP sees it. */
export class SocketWorld {
  readonly net: PacketNet<TcpSegment>;
  readonly stack: TcpStack;
  private hooks: ((node: NodeId, pkt: Packet<TcpSegment>) => boolean)[] = [];

  constructor(names: string[], opts: { seed?: number; record?: boolean; tcp?: Partial<TcpConfig> } = {}) {
    this.net = new PacketNet<TcpSegment>(names, { seed: opts.seed ?? 1, record: opts.record ?? true });
    this.stack = new TcpStack(this.net, opts.tcp).install({
      onReceive: (node, pkt) => {
        if (pkt.dst !== node || !isTcp(pkt.payload)) return false;
        for (const h of this.hooks) if (h(node, pkt)) return true;
        return false;
      },
    });
  }

  /** `hook` returns true to drop the segment (TCP never sees it). */
  addHook(hook: (node: NodeId, pkt: Packet<TcpSegment>) => boolean) {
    this.hooks.push(hook);
  }

  listen(node: NodeId, port: number, backlog: number, opts: { synCookies?: boolean; conn?: Partial<TcpConfig> } = {}) {
    return new ListenSocket(this, node, port, backlog, opts);
  }
}

export interface ListenStats {
  /** SYNs dropped because the accept queue was full (Linux counts them in ListenOverflows and ListenDrops). */
  synDrops: number;
  /** Final handshake ACKs (or first data) ignored because the accept queue was full. */
  ackDrops: number;
  accepted: number;
  maxAcceptQueue: number;
}

/**
 * A listening socket: the SYN queue (TcpListener.halfOpen, limited by the backlog) and the accept queue (connections
 * that finished the handshake and wait for accept()). This is the default Linux behaviour, tcp_abort_on_overflow = 0.
 */
export class ListenSocket {
  readonly listener: TcpListener;
  readonly acceptQueue: TcpConn[] = [];
  readonly stats: ListenStats = { synDrops: 0, ackDrops: 0, accepted: 0, maxAcceptQueue: 0 };
  /** [t, SYN queue length, accept queue length] after each change. */
  readonly qlog: [number, number, number][] = [[0, 0, 0]];
  /** When each connection entered the accept queue (the server side reached ESTABLISHED). */
  readonly queuedAt = new Map<TcpConn, number>();
  /** A connection joined the accept queue: the socket became readable (sk_data_ready). */
  onReady?: (ls: ListenSocket) => void;

  constructor(readonly world: SocketWorld, readonly node: NodeId, readonly port: number, readonly backlog: number, opts: { synCookies?: boolean; conn?: Partial<TcpConfig> } = {}) {
    this.listener = world.stack.listen(node, port, {
      backlog,
      synCookies: opts.synCookies ?? false,
      conn: opts.conn ?? {},
      onAccept: (c) => {
        this.acceptQueue.push(c);
        this.queuedAt.set(c, world.net.now);
        this.stats.maxAcceptQueue = Math.max(this.stats.maxAcceptQueue, this.acceptQueue.length);
        this.log();
        this.onReady?.(this);
      },
    });
    world.addHook((n, pkt) => n === node && this.filter(pkt));
  }

  /** Linux: full when more than `backlog` connections wait. */
  get full() {
    return this.acceptQueue.length >= this.backlog + SOCK_FACTS.acceptQueueExtra;
  }

  get synQueue() {
    return this.listener.halfOpen.size;
  }

  /** accept(): the oldest connection in the queue, or undefined (EAGAIN). */
  accept(): TcpConn | undefined {
    const c = this.acceptQueue.shift();
    if (c) {
      this.stats.accepted++;
      this.log();
    }
    return c;
  }

  private filter(pkt: Packet<TcpSegment>): boolean {
    const seg = pkt.payload;
    if (seg.dport !== this.port || seg.flags & RST) return false;
    const c = this.world.stack.find(this.node, this.port, pkt.src, seg.sport);
    if (!c && seg.flags & SYN && !(seg.flags & ACK)) {
      if (this.full) {
        this.stats.synDrops++;
        this.world.net.note(this.node, "SYN dropped: accept queue full");
        return true;
      }
      queueMicrotaskLog(this);
      return false;
    }
    // The final ACK: for a request in SYN_RECEIVED, or a SYN cookie (no request stored). Both need room in the queue.
    const finalAck = seg.flags & ACK && !(seg.flags & SYN) && (c ? c.state === "SYN_RECEIVED" : true);
    if (finalAck && this.full) {
      this.stats.ackDrops++;
      this.world.net.note(this.node, "ACK ignored: accept queue full");
      return true;
    }
    return false;
  }

  /** Records the queue lengths now. */
  log() {
    this.qlog.push([this.world.net.now, this.synQueue, this.acceptQueue.length]);
  }
}

/** The SYN queue grows inside TCP after the hook returns, so its length is logged one event later. */
function queueMicrotaskLog(ls: ListenSocket) {
  ls.world.net.at(ls.world.net.now, () => ls.log());
}

// ============================================================================ accept queue overflow

export interface AcceptRunOpts {
  /** Clients that connect in a burst. */
  clients: number;
  /** Time between two connects in the burst, ms. */
  spacing: number;
  /** listen() backlog. */
  backlog: number;
  /** Server work per connection after the request arrived, ms (a model input). */
  serviceMs: number;
  /** Server threads that call accept(). */
  workers: number;
  /** tcp_syncookies = 1 (the Linux default): cookies when the SYN queue is full. */
  synCookies: boolean;
  /** One-way delay, ms. */
  delay: number;
  reqBytes: number;
  respBytes: number;
  seed: number;
  /** Stop the run here, ms. */
  until: number;
}

export const ACCEPT_DEFAULTS: AcceptRunOpts = { clients: 24, spacing: 1, backlog: 8, serviceMs: 20, workers: 1, synCookies: true, delay: 5, reqBytes: 200, respBytes: 1000, seed: 1, until: 20_000 };

export interface ClientRecord {
  id: number;
  /** connect() called. */
  start: number;
  /** connect() returned: the client reached ESTABLISHED. */
  connected?: number;
  /** The server side reached ESTABLISHED: the connection entered the accept queue. */
  queued?: number;
  /** accept() returned it. */
  accepted?: number;
  /** The whole response arrived. */
  done?: number;
  /** SYN retransmissions. */
  synRetx: number;
  /** Timeouts after the handshake (the request was ignored and sent again). */
  dataRetx: number;
  failed?: string;
}

export interface AcceptRun {
  opts: AcceptRunOpts;
  world: SocketWorld;
  ls: ListenSocket;
  clients: ClientRecord[];
  /** SYN-ACKs that the server sent again. */
  synAckRetx: number;
  /** The last response, ms. */
  lastDone?: number;
}

/** A burst of clients against a server whose workers accept, read a request, work, answer and close. */
export function acceptQueueRun(o: Partial<AcceptRunOpts> = {}): AcceptRun {
  const opts = { ...ACCEPT_DEFAULTS, ...o };
  const world = new SocketWorld(["client", "server"], { seed: opts.seed, tcp: { nagle: false, delayedAck: 0 } });
  world.net.connect(0, 1, { rate: 100e6, delay: opts.delay });
  const ls = world.listen(1, 80, opts.backlog, { synCookies: opts.synCookies });
  const clients: ClientRecord[] = [];
  const conns: TcpConn[] = [];
  const idle: number[] = Array.from({ length: opts.workers }, (_, i) => i);

  const serve = (w: number) => {
    const c = ls.accept();
    if (!c) {
      idle.push(w);
      return;
    }
    const rec = clients[conns.findIndex((x) => x.lport === c.rport)];
    if (rec) rec.accepted = world.net.now;
    const finish = () => {
      world.net.at(world.net.now + opts.serviceMs, () => {
        c.write(opts.respBytes);
        c.close();
        serve(w);
      });
    };
    if (c.stats.delivered >= opts.reqBytes) finish();
    else c.onData = () => {
      if (c.stats.delivered >= opts.reqBytes && c.onData) {
        c.onData = undefined;
        finish();
      }
    };
  };
  ls.onReady = () => {
    const w = idle.shift();
    if (w !== undefined) serve(w);
  };

  for (let i = 0; i < opts.clients; i++) {
    const start = i * opts.spacing;
    const rec: ClientRecord = { id: i, start, synRetx: 0, dataRetx: 0 };
    clients.push(rec);
    world.net.at(start, () => {
      const c = world.stack.connect(0, 1, 80, { port: 40000 + i });
      conns[i] = c;
      c.onEstablished = () => {
        rec.connected = world.net.now;
        rec.synRetx = c.stats.timeouts;
        c.write(opts.reqBytes);
      };
      c.onData = () => {
        if (rec.done === undefined && c.stats.delivered >= opts.respBytes) {
          rec.done = world.net.now;
          rec.dataRetx = c.stats.timeouts - rec.synRetx;
        }
      };
      c.onEof = () => c.close();
      c.onClose = (_c, reason) => {
        if (reason !== "normal") rec.failed = reason;
      };
    });
  }
  world.net.runUntil(opts.until);
  for (const r of clients) {
    const c = conns[r.id];
    if (!c) continue;
    const s = world.stack.conns.find((x) => x.node === 1 && x.rport === c.lport && x.stats.establishedAt !== undefined);
    r.queued = s?.stats.establishedAt;
    if (r.connected === undefined) r.synRetx = c.stats.timeouts;
  }
  const synAckRetx = world.stack.conns.filter((x) => x.node === 1).reduce((a, x) => a + x.stats.retxSegs, 0);
  const dones = clients.map((r) => r.done).filter((x): x is number => x !== undefined);
  return { opts, world, ls, clients, synAckRetx, lastDone: dones.length === clients.length ? Math.max(...dones) : undefined };
}

// ============================================================================ the API on a timeline

export type LifeScenario = "normal" | "lateAccept" | "peerClosed" | "unreadClose";

export interface ApiCall {
  t: number;
  /** 0 = client, 1 = server. */
  node: NodeId;
  call: string;
  result: string;
  tone?: "good" | "bad" | "warn";
}

export interface LifeOpts {
  scenario: LifeScenario;
  /** One-way delay, ms. */
  delay: number;
  /** When the server calls accept(), ms (lateAccept). */
  acceptAt: number;
  /** The server does a lingering close: shutdown, read to EOF, then close (unreadClose). */
  linger: boolean;
}

export interface LifeRun {
  opts: LifeOpts;
  world: SocketWorld;
  calls: ApiCall[];
  client: TcpConn;
  server?: TcpConn;
  /** Response bytes the client application read. */
  clientGot: number;
  respBytes: number;
  /** The client process got SIGPIPE. */
  sigpipe: boolean;
  /** How the client's last call ended. */
  clientEnd: string;
}

export const LIFE_DEFAULTS: LifeOpts = { scenario: "normal", delay: 20, acceptAt: 150, linger: false };

/**
 * One client and one server. All ISNs are 0 so the numbers stay readable. Byte counts: a 300-byte request and a
 * 2000-byte response, except in unreadClose: a 3000-byte request of which the server reads only the first 1000
 * (the headers), and a 20,000-byte response into an 8 KiB client receive buffer.
 */
export function lifecycleRun(o: Partial<LifeOpts> = {}): LifeRun {
  const opts = { ...LIFE_DEFAULTS, ...o };
  const sc = opts.scenario;
  const unread = sc === "unreadClose";
  const req = unread ? 3000 : 300, resp = unread ? 20_000 : 2000;
  const world = new SocketWorld(["client", "server"], { tcp: { isn: 0, nagle: false, delayedAck: 0, autoRead: false } });
  const { net } = world;
  net.connect(0, 1, { rate: 10e6, delay: opts.delay });
  const calls: ApiCall[] = [];
  const say = (node: NodeId, call: string, result: string, tone?: ApiCall["tone"]) => calls.push({ t: net.now, node, call, result, tone });

  say(1, "socket(AF_INET, SOCK_STREAM, 0)", "3");
  say(1, "bind(3, 0.0.0.0:80)", "0");
  say(1, "listen(3, 128)", "0: state LISTEN");
  const ls = world.listen(1, 80, 128);
  const run: LifeRun = { opts, world, calls, client: undefined as unknown as TcpConn, clientGot: 0, respBytes: resp, sigpipe: false, clientEnd: "" };

  // A fully closed socket (close(), not shutdown) answers new data with RST, as Linux does after close().
  let serverClosed = false;
  world.addHook((node, pkt) => {
    const s = run.server;
    if (node !== 1 || !s || !serverClosed || pkt.payload.len === 0 || s.state === "CLOSED") return false;
    s.abort();
    say(1, "(kernel: data for a closed socket)", "sends RST", "bad");
    return true;
  });

  // ---- server application
  const serverApp = () => {
    const c = ls.accept()!;
    run.server = c;
    say(1, "accept(3)", `4: a connection from client:${c.rport}${ls.queuedAt.get(c)! < net.now - 0.01 ? `, queued since ${fmt(ls.queuedAt.get(c)!)} ms` : ""}`, "good");
    const want = unread ? 1000 : req;
    let got = 0;
    const onData = () => {
      if (got >= want) return;
      if (c.unread === 0) return;
      const n = c.read(want - got);
      got += n;
      say(1, `read(4, buf, ${want - got + n})`, `${n}`);
      if (got < want) return;
      c.write(resp);
      say(1, `write(4, buf, ${resp})`, `${resp}: copied to the send buffer`);
      if (sc === "unreadClose") {
        if (opts.linger) {
          c.close();
          say(1, "shutdown(4, SHUT_WR)", "0: FIN after the data");
          const discard = () => {
            const k = c.read();
            if (k) say(1, "read(4) and discard", `${k}`);
          };
          c.onData = discard;
          c.onEof = () => {
            say(1, "read(4)", "0: EOF. Now close(4)", "good");
          };
          discard();
          return;
        }
        if (c.unread > 0) {
          say(1, "close(4)", `0, but ${c.unread} request bytes are unread: RST, and the unsent response is discarded`, "bad");
          c.abort();
          return;
        }
      }
      c.close();
      serverClosed = true;
      say(1, "close(4)", "0: FIN after the data");
    };
    c.onData = onData;
    onData();
    c.onEof = () => {
      if (sc === "normal" || sc === "lateAccept") say(1, "(kernel) FIN from the client", "LAST ACK sent; the server socket is in TIME_WAIT");
    };
  };
  if (sc === "lateAccept") {
    net.at(opts.acceptAt, () => {
      say(1, "accept(3)", "called");
      if (ls.acceptQueue.length) serverApp();
      else ls.onReady = serverApp;
    });
  } else {
    say(1, "accept(3)", "blocks: the accept queue is empty");
    ls.onReady = serverApp;
  }

  // ---- client application
  say(0, "socket(AF_INET, SOCK_STREAM, 0)", "3");
  const c = world.stack.connect(0, 1, 80, { port: 40000, ...(unread ? { rcvBuf: 8192, rcvBufMax: 8192 } : {}) });
  run.client = c;
  say(0, "connect(3, server:80)", "blocks: SYN sent");
  let wroteSecond = false;
  c.onEstablished = () => {
    say(0, "connect(3, server:80)", "0: returns after one round trip", "good");
    c.write(req);
    say(0, `write(3, buf, ${req})`, `${req}`);
  };
  c.onData = () => {
    const n = c.read(4096);
    if (n) {
      run.clientGot += n;
      say(0, "read(3, buf, 4096)", `${n}`);
    }
  };
  c.onEof = () => {
    say(0, "read(3, buf, 4096)", "0: EOF, the server closed", "good");
    if (sc === "peerClosed" && !wroteSecond) {
      wroteSecond = true;
      // A bug: the client does not check for EOF and sends a second request on the same connection.
      net.at(net.now + 5, () => {
        c.write(req);
        say(0, `write(3, buf, ${req})`, `${req}: it succeeds, the bytes go out`, "warn");
      });
    } else if (sc === "normal" || sc === "lateAccept") {
      c.close();
      say(0, "close(3)", "0: FIN. The server closed first, so the server waits in TIME_WAIT");
    }
  };
  c.onClose = (_c, reason) => {
    if (reason === "reset") {
      if (sc === "peerClosed") {
        say(0, "(kernel) RST from the server", "the socket is now closed");
        net.at(net.now + 5, () => {
          run.sigpipe = true;
          run.clientEnd = "EPIPE";
          say(0, `write(3, buf, ${req})`, "-1, EPIPE, and the kernel sends SIGPIPE: the default action ends the process", "bad");
        });
      } else {
        run.clientEnd = "ECONNRESET";
        say(0, "read(3, buf, 4096)", `-1, ECONNRESET after ${run.clientGot} of ${resp} response bytes`, "bad");
      }
    }
  };
  if (sc === "unreadClose") {
    c.onEof = () => {
      say(0, "read(3, buf, 4096)", `0: EOF after ${run.clientGot} of ${resp} bytes`, run.clientGot === resp ? "good" : "bad");
      say(0, "close(3)", "0");
      c.close();
      run.clientEnd = run.clientGot === resp ? "complete" : "short";
    };
  }
  net.runUntil(4000);
  if (!run.clientEnd) run.clientEnd = c.reason ?? c.state;
  calls.sort((a, b) => a.t - b.t);
  return run;
}

const fmt = (t: number) => (Math.round(t * 10) / 10).toString();

// ============================================================================ bytes, not messages

export interface StreamOpts {
  /** Messages the sender writes, each `msgBytes` long. */
  messages: number;
  msgBytes: number;
  /** SO_SNDBUF as the model sees it: bytes written and not yet acknowledged (a model input). */
  sndBuf: number;
  /** The receiver's read buffer. */
  readBuf: number;
  /** 0: the receiver reads as soon as data arrives. Otherwise it reads every `readEvery` ms. */
  readEvery: number;
  nagle: boolean;
  delay: number;
}

export const STREAM_DEFAULTS: StreamOpts = { messages: 5, msgBytes: 1000, sndBuf: 2500, readBuf: 4096, readEvery: 0, nagle: true, delay: 5 };

export interface WriteCall { t: number; asked: number; got: number }
export interface ReadCall { t: number; start: number; n: number }
export interface StreamRun {
  opts: StreamOpts;
  writes: WriteCall[];
  reads: ReadCall[];
  /** [start, end) of each message in the byte stream. */
  messages: [number, number][];
  /** Data segment payload sizes, in order of sending. */
  segments: number[];
  /** Complete messages after each read, for a reader that frames by length. */
  framed: number[];
  doneAt: number;
}

/** A non-blocking writer with a small send buffer, and a reader. Every write and read with its return value. */
export function streamRun(o: Partial<StreamOpts> = {}): StreamRun {
  const opts = { ...STREAM_DEFAULTS, ...o };
  const world = new SocketWorld(["sender", "receiver"], { tcp: { isn: 0, nagle: opts.nagle, delayedAck: 0, autoRead: false } });
  const { net } = world;
  net.connect(0, 1, { rate: 10e6, delay: opts.delay });
  const ls = world.listen(1, 80, 16);
  const writes: WriteCall[] = [], reads: ReadCall[] = [], segments: number[] = [], framed: number[] = [];
  const total = opts.messages * opts.msgBytes;
  const messages: [number, number][] = Array.from({ length: opts.messages }, (_, i) => [i * opts.msgBytes, (i + 1) * opts.msgBytes]);
  let msg = 0, off = 0, doneAt = 0;
  const c = world.stack.connect(0, 1, 80);

  const tryWrite = () => {
    while (msg < opts.messages) {
      const free = opts.sndBuf - (c.written - c.stats.acked);
      const asked = opts.msgBytes - off;
      if (free <= 0) {
        if (writes.at(-1)?.got !== -1 || writes.at(-1)?.t !== net.now) writes.push({ t: net.now, asked, got: -1 });
        return;
      }
      const got = Math.min(free, asked);
      c.write(got);
      writes.push({ t: net.now, asked, got });
      off += got;
      if (off === opts.msgBytes) {
        msg++;
        off = 0;
      }
    }
  };
  world.addHook((node) => {
    if (node === 0 && msg < opts.messages) net.at(net.now, tryWrite);
    return false;
  });
  c.onEstablished = tryWrite;

  let pos = 0;
  const readNow = (s: TcpConn) => {
    while (s.unread > 0) {
      const n = s.read(opts.readBuf);
      reads.push({ t: net.now, start: pos, n });
      pos += n;
      framed.push(Math.floor(pos / opts.msgBytes));
      if (pos >= total) doneAt = net.now;
      if (opts.readEvery > 0) break;
    }
  };
  ls.onReady = () => {
    const s = ls.accept()!;
    if (opts.readEvery === 0) s.onData = () => readNow(s);
    else {
      const tick = () => {
        readNow(s);
        if (pos < total) net.at(net.now + opts.readEvery, tick);
      };
      net.at(net.now + opts.readEvery, tick);
    }
  };
  net.runUntil(5000);
  for (const e of net.trace) if (e.kind === "send" && e.node === 0 && e.pkt.payload.len > 0 && e.pkt.payload.info.retx === 0) segments.push(e.pkt.payload.len);
  return { opts, writes, reads, messages, segments, framed, doneAt };
}

