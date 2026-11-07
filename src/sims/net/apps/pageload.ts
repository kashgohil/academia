/**
 * Page loads on the reference TCP (../transport): HTTP/1.1 with one or more connections, with or without
 * persistent connections and pipelining, and HTTP/2 with all requests multiplexed on one connection.
 *
 * - Every connection does a TCP handshake, then (by default) a TLS 1.3 handshake modelled as bytes on the stream:
 *   a ClientHello, a server flight with the certificate (`TLS_SERVER_FLIGHT`), and the client's Finished, which
 *   goes with the first request. So a new connection costs 2 RTTs before its first request, as in real life.
 * - Each connection starts in slow start with an initial window of 10 segments (RFC 6928) and Reno's rules
 *   (`RenoBytes`). Six connections start with six initial windows; one HTTP/2 connection starts with one.
 * - The page: the HTML first; when it has arrived, the browser asks for every resource it names (a model input:
 *   `DEMO_PAGE`). The server needs `thinkMs` per request, and one resource can be made slow on purpose.
 * - HTTP/1.1 answers requests on a connection in order. With pipelining a slow response blocks the ones behind it
 *   (head-of-line blocking at the HTTP layer).
 * - HTTP/2 sends DATA frames of at most 16,384 bytes, round-robin over the streams that have data, and keeps only
 *   a little data unsent in the TCP buffer, as servers do (TCP_NOTSENT_LOWAT), so that frames really interleave.
 *   One lost segment still stalls every stream: TCP delivers one ordered byte stream.
 * Request sizes are real: HTTP/1.1 text from `browserRequest`, HTTP/2 HEADERS compressed by the HPACK encoder.
 */
import { PacketNet } from "../packet";
import { TcpStack, type CongestionControl, type AckSample, type LossSignal, type TcpConn } from "../transport";
import { browserRequest, byteLength, response, serialize } from "./http1";
import type { Header } from "./hpack";
import { HpackEncoder } from "./hpack";

/** RFC 6928 and Linux: an initial window of 10 segments. */
export const INIT_WINDOW_SEGMENTS = 10;

/** Reno in bytes for the reference TCP: slow start, congestion avoidance, halve on loss, one segment after a timeout. */
export class RenoBytes implements CongestionControl {
  readonly name = "Reno";
  cwnd = INIT_WINDOW_SEGMENTS * 1460;
  ssthresh = Infinity;
  private mss = 1460;
  init(mss: number) {
    this.mss = mss;
    this.cwnd = INIT_WINDOW_SEGMENTS * mss;
  }
  onAck(a: AckSample) {
    if (a.inRecovery) return;
    if (this.cwnd < this.ssthresh) this.cwnd += a.ackedBytes;
    else this.cwnd += (this.mss * a.ackedBytes) / this.cwnd;
  }
  onLoss(l: LossSignal) {
    this.ssthresh = Math.max(l.inflight / 2, 2 * this.mss);
    this.cwnd = l.kind === "rto" ? this.mss : this.ssthresh;
  }
}

export interface Resource { name: string; bytes: number }

/** The demo page (a model input): sizes of the HTML, a style sheet, two scripts and nine images. */
export const DEMO_PAGE: { html: Resource; resources: Resource[] } = {
  html: { name: "index.html", bytes: 30_000 },
  resources: [
    { name: "style.css", bytes: 25_000 },
    { name: "app.js", bytes: 80_000 },
    { name: "vendor.js", bytes: 40_000 },
    ...[15, 22, 35, 48, 12, 60, 28, 18, 40].map((k, i) => ({ name: `img${i + 1}.jpg`, bytes: k * 1000 })),
  ],
};

/** TLS 1.3 bytes (model inputs): ClientHello, the server's flight with a certificate chain, the client Finished. */
export const TLS_CLIENT_HELLO = 300;
export const TLS_SERVER_FLIGHT = 4000;
export const TLS_FINISHED = 64;

/** Bottleneck queue in packets (a model input): about 1.7 BDPs at 10 Mbit/s and 80 ms. */
export const QUEUE_PACKETS = 128;

export interface PageOpts {
  rttMs: number;
  mbps: number;
  /** Random loss on the link, both directions. */
  loss: number;
  seed?: number;
  /** Queue limit at the bottleneck in packets. */
  queuePackets?: number;
  tls?: boolean;
  thinkMs?: number;
  /** One resource (index into resources) that the server takes `ms` longer to make. */
  slow?: { index: number; ms: number };
  record?: boolean;
  page?: typeof DEMO_PAGE;
}

export interface H1Opts extends PageOpts {
  /** Most connections at once to the host (browsers: 6). */
  conns: number;
  /** Keep-alive: more than one request per connection. */
  persistent: boolean;
  /** Send all requests of a connection at once, without waiting for responses. */
  pipelining: boolean;
}

export interface ResTiming {
  name: string;
  bytes: number;
  /** Connection index (H1) or stream id (H2). */
  conn: number;
  requestAt: number;
  firstByteAt: number;
  doneAt: number;
}

export interface ConnTiming { index: number; openedAt: number; readyAt: number; closedAt?: number; requests: number }

export interface PageRun {
  net: PacketNet<any>;
  stack: TcpStack;
  resources: ResTiming[];
  conns: ConnTiming[];
  /** Page load time: the last byte of the last resource. */
  plt: number;
  retx: number;
  timeouts: number;
}

export const CLIENT_NODE = 0, SERVER_NODE = 1;

function setup(o: PageOpts) {
  const net = new PacketNet<any>(["browser", "server"], { seed: o.seed ?? 1, record: o.record ?? true });
  net.connect(CLIENT_NODE, SERVER_NODE, { rate: o.mbps * 1e6, delay: o.rttMs / 2, queuePackets: o.queuePackets ?? QUEUE_PACKETS, loss: o.loss });
  net.computeRoutes();
  const stack = new TcpStack(net, {
    nagle: false, rcvBuf: 4 << 20, rcvBufMax: 4 << 20, timeWait: 0, cc: () => new RenoBytes(), log: false,
  }).install();
  return { net, stack };
}

const RESPONSE_HEADERS = (bytes: number): Header[] => [
  ["Date", "Sat, 07 Nov 2026 12:00:00 GMT"], ["Server", "nginx"], ["Content-Type", "image/jpeg"],
  ["Content-Length", String(bytes)], ["Cache-Control", "max-age=86400"], ["ETag", `"5d8c72a1-${bytes}"`],
];
export const h1RequestBytes = (path: string) => byteLength(serialize(browserRequest(`/${path}`)));
export const h1ResponseHead = (bytes: number) => byteLength(serialize(response(200, "OK", RESPONSE_HEADERS(bytes))));

// ================================================================================================ HTTP/1.1

export function h1PageLoad(o: H1Opts): PageRun {
  const { net, stack } = setup(o);
  const page = o.page ?? DEMO_PAGE;
  const all = [page.html, ...page.resources];
  const tls = o.tls ?? true;
  const think = (i: number) => (o.thinkMs ?? 10) + (o.slow && o.slow.index + 1 === i ? o.slow.ms : 0);
  const timings: ResTiming[] = all.map((r) => ({ name: r.name, bytes: r.bytes, conn: -1, requestAt: NaN, firstByteAt: NaN, doneAt: NaN }));
  const conns: ConnTiming[] = [];
  const queue: number[] = [];

  interface C {
    index: number;
    tcp: TcpConn;
    ready: boolean;
    /** Resources assigned, in request order. */
    reqs: number[];
    sent: number;
    /** Pipelining: the requests given to this connection, not sent yet. */
    mine: number[];
    /** Client side: bytes received, and the response windows [start, end) in the server→client stream. */
    got: number;
    windows: { res: number; start: number; end: number }[];
    nextRespStart: number;
    done: number;
  }
  const byTcp = new Map<number, C>();
  const live: C[] = [];

  const open = () => {
    const tcp = stack.connect(CLIENT_NODE, SERVER_NODE, 443);
    const c: C = { index: conns.length, tcp, ready: false, reqs: [], mine: [], sent: 0, got: 0, windows: [], nextRespStart: tls ? TLS_SERVER_FLIGHT : 0, done: 0 };
    conns.push({ index: c.index, openedAt: net.now, readyAt: NaN, requests: 0 });
    byTcp.set(tcp.id, c);
    live.push(c);
    tcp.onEstablished = () => {
      if (tls) tcp.write(TLS_CLIENT_HELLO);
      else markReady(c);
    };
    tcp.onData = (_t, n) => {
      c.got += n;
      if (!c.ready && tls && c.got >= TLS_SERVER_FLIGHT) markReady(c);
      for (const w of c.windows) {
        const t = timings[w.res]!;
        if (Number.isNaN(t.firstByteAt) && c.got > w.start) t.firstByteAt = net.now;
        if (Number.isNaN(t.doneAt) && c.got >= w.end) {
          t.doneAt = net.now;
          c.done++;
          onDone(c, w.res);
        }
      }
    };
    return c;
  };
  const markReady = (c: C) => {
    c.ready = true;
    conns[c.index]!.readyAt = net.now;
    pump(c);
  };
  /** Sends what this connection may send now. */
  const pump = (c: C) => {
    if (!c.ready) return;
    if (o.pipelining) {
      while (c.mine.length) send(c, c.mine.shift()!);
      if (queue.length && c.sent === c.done) send(c, queue.shift()!);
      return;
    }
    if (queue.length && c.sent === c.done && (o.persistent || c.reqs.length === 0)) send(c, queue.shift()!);
  };
  const send = (c: C, res: number) => {
    const bytes = h1RequestBytes(all[res]!.name) + (tls && c.sent === 0 ? TLS_FINISHED : 0);
    c.reqs.push(res);
    c.sent++;
    conns[c.index]!.requests++;
    const head = h1ResponseHead(all[res]!.bytes);
    c.windows.push({ res, start: c.nextRespStart, end: c.nextRespStart + head + all[res]!.bytes });
    c.nextRespStart += head + all[res]!.bytes;
    const t = timings[res]!;
    t.conn = c.index;
    t.requestAt = net.now;
    serverExpect.set(c.tcp.id, [...(serverExpect.get(c.tcp.id) ?? []), { res, bytes }]);
    c.tcp.write(bytes);
  };
  const onDone = (c: C, res: number) => {
    if (res === 0) {
      // The HTML is in: the browser finds the resources and asks for them.
      const found = page.resources.map((_, i) => i + 1);
      if (o.pipelining && o.persistent) {
        while (live.length < Math.min(o.conns, found.length)) open();
        found.forEach((r, i) => live[i % live.length]!.mine.push(r));
        for (const x of live) pump(x);
        return;
      }
      queue.push(...found);
    }
    if (!o.persistent) {
      c.tcp.close();
      conns[c.index]!.closedAt = net.now;
      live.splice(live.indexOf(c), 1);
      schedule();
      return;
    }
    pump(c);
    schedule();
  };
  /** Opens connections up to the limit while requests wait; gives requests to idle connections. */
  const schedule = () => {
    for (const c of live) pump(c);
    const idle = live.filter((c) => c.reqs.length === 0 || (o.persistent && c.sent === c.done)).length;
    let want = Math.min(queue.length - idle, o.conns - live.length);
    while (want-- > 0) open();
  };

  // ---- server: one handler per accepted connection
  const serverExpect = new Map<number, { res: number; bytes: number }[]>();
  stack.listen(SERVER_NODE, 443, {
    onAccept: (s) => {
      let got = 0, k = 0, nextWrite = 0;
      let helloDone = !tls;
      const ready: boolean[] = [];
      s.onData = (_t, n) => {
        got += n;
        if (!helloDone && got >= TLS_CLIENT_HELLO) {
          helloDone = true;
          got -= TLS_CLIENT_HELLO;
          s.write(TLS_SERVER_FLIGHT);
        }
        const exp = serverExpect.get(s.peerConn) ?? [];
        while (helloDone && k < exp.length && got >= exp[k]!.bytes) {
          got -= exp[k]!.bytes;
          const idx = k++;
          net.at(net.now + think(exp[idx]!.res), () => {
            ready[idx] = true;
            while (ready[nextWrite]) {
              const r = exp[nextWrite++]!;
              s.write(h1ResponseHead(all[r.res]!.bytes) + all[r.res]!.bytes);
            }
          });
        }
      };
      s.onEof = () => s.close();
    },
  });

  queue.push(0);
  open();
  net.runAll(5_000_000);
  return finish(net, stack, timings, conns);
}

function finish(net: PacketNet<any>, stack: TcpStack, resources: ResTiming[], conns: ConnTiming[]): PageRun {
  const plt = Math.max(...resources.map((r) => r.doneAt));
  let retx = 0, timeouts = 0;
  for (const c of stack.conns) {
    retx += c.stats.retxSegs;
    timeouts += c.stats.timeouts;
  }
  return { net, stack, resources, conns, plt, retx, timeouts };
}

// ================================================================================================ HTTP/2

/** HTTP/2 frame header (RFC 9113 section 4.1). */
export const H2_FRAME_HEADER = 9;
/** SETTINGS_MAX_FRAME_SIZE default (RFC 9113 section 6.5.2). */
export const H2_MAX_FRAME = 16384;
/** The client connection preface (RFC 9113 section 3.4): 24 bytes, then a SETTINGS frame. */
export const H2_PREFACE = 24;
/** Bytes the server keeps unsent in TCP at most before it picks the next frame (a model of TCP_NOTSENT_LOWAT). */
export const H2_LOWAT = 16384;

/** The pseudo-header form of the browser request, for HPACK. */
export function h2RequestHeaders(path: string): Header[] {
  const r = browserRequest(path);
  return [[":method", "GET"], [":scheme", "https"], [":authority", "www.example.com"], [":path", path], ...r.headers.filter(([n]) => n !== "Host").map(([n, v]) => [n.toLowerCase(), v] as Header)];
}

export interface H2Opts extends PageOpts {
  /** "rr": round-robin over streams with data; "fifo": finish one response before the next (no interleaving). */
  order?: "rr" | "fifo";
}

export function h2PageLoad(o: H2Opts): PageRun {
  const { net, stack } = setup(o);
  const page = o.page ?? DEMO_PAGE;
  const all = [page.html, ...page.resources];
  const tls = o.tls ?? true;
  const think = (i: number) => (o.thinkMs ?? 10) + (o.slow && o.slow.index + 1 === i ? o.slow.ms : 0);
  const timings: ResTiming[] = all.map((r, i) => ({ name: r.name, bytes: r.bytes, conn: 1 + 2 * i, requestAt: NaN, firstByteAt: NaN, doneAt: NaN }));
  const conns: ConnTiming[] = [{ index: 0, openedAt: 0, readyAt: NaN, requests: 0 }];
  const reqEnc = new HpackEncoder(4096, { huffman: "auto" });
  const rspEnc = new HpackEncoder(4096, { huffman: "auto" });
  const SETTINGS = H2_FRAME_HEADER + 6 * 3;

  // The server→client byte stream, frame by frame: which stream each byte range belongs to.
  const frames: { stream: number; res: number; end: number; last: boolean; first: boolean }[] = [];
  let srvWritten = tls ? TLS_SERVER_FLIGHT : 0;
  // Requests the client sent: their HEADERS frame sizes in order.
  const reqFrames: { res: number; bytes: number }[] = [];

  const c = stack.connect(CLIENT_NODE, SERVER_NODE, 443);
  let ready = false, got = 0, fi = 0;
  const sendReq = (res: number, extra = 0) => {
    const block = reqEnc.encode(h2RequestHeaders(`/${all[res]!.name}`)).bytes.length;
    const bytes = H2_FRAME_HEADER + block + extra;
    reqFrames.push({ res, bytes });
    timings[res]!.requestAt = net.now;
    conns[0]!.requests++;
    c.write(bytes);
  };
  const markReady = () => {
    ready = true;
    conns[0]!.readyAt = net.now;
    sendReq(0, H2_PREFACE + SETTINGS + (tls ? TLS_FINISHED : 0));
  };
  c.onEstablished = () => (tls ? c.write(TLS_CLIENT_HELLO) : markReady());
  c.onData = (_t, n) => {
    got += n;
    if (!ready && tls && got >= TLS_SERVER_FLIGHT) markReady();
    while (fi < frames.length && frames[fi]!.end <= got) {
      const f = frames[fi++]!;
      const t = timings[f.res]!;
      if (Number.isNaN(t.firstByteAt)) t.firstByteAt = net.now;
      if (f.last) {
        t.doneAt = net.now;
        if (f.res === 0) for (let i = 1; i < all.length; i++) sendReq(i);
      }
    }
  };

  // ---- server
  interface S { res: number; left: number; started: boolean }
  const active: S[] = [];
  let rr = 0;
  stack.listen(SERVER_NODE, 443, {
    onAccept: (s) => {
      let rcv = 0, k = 0, helloDone = !tls, settingsSent = false;
      const pumpFrames = () => {
        while (s.unsent < H2_LOWAT && active.length) {
          let pick: S;
          if ((o.order ?? "rr") === "fifo") pick = active[0]!;
          else pick = active[rr++ % active.length]!;
          let bytes = 0;
          const first = !pick.started;
          if (first) {
            if (!settingsSent) {
              bytes += SETTINGS;
              settingsSent = true;
            }
            bytes += H2_FRAME_HEADER + rspEnc.encode([[":status", "200"], ...RESPONSE_HEADERS(all[pick.res]!.bytes).map(([n, v]) => [n.toLowerCase(), v] as Header)]).bytes.length;
            pick.started = true;
          }
          const data = Math.min(H2_MAX_FRAME, pick.left);
          pick.left -= data;
          bytes += H2_FRAME_HEADER + data;
          srvWritten += bytes;
          frames.push({ stream: 1 + 2 * pick.res, res: pick.res, end: srvWritten, last: pick.left === 0, first });
          if (pick.left === 0) active.splice(active.indexOf(pick), 1);
          s.write(bytes);
        }
        if (active.length && !timerSet) {
          timerSet = true;
          net.setTimer(SERVER_NODE, 1, "h2:pump");
        }
      };
      pumpRef = pumpFrames;
      s.onData = (_t, n) => {
        rcv += n;
        if (!helloDone && rcv >= TLS_CLIENT_HELLO) {
          helloDone = true;
          rcv -= TLS_CLIENT_HELLO;
          s.write(TLS_SERVER_FLIGHT);
        }
        while (helloDone && k < reqFrames.length && rcv >= reqFrames[k]!.bytes) {
          rcv -= reqFrames[k]!.bytes;
          const res = reqFrames[k++]!.res;
          net.at(net.now + think(res), () => {
            active.push({ res, left: all[res]!.bytes, started: false });
            pumpFrames();
          });
        }
      };
    },
  });
  let pumpRef: (() => void) | undefined;
  let timerSet = false;
  net.setHandlers({
    onDeliver: (n, p) => void stack.deliver(n, p),
    onTimer: (n, tag) => {
      if (stack.timer(n, tag)) return;
      if (tag === "h2:pump") {
        timerSet = false;
        pumpRef?.();
      }
    },
  });
  net.runAll(5_000_000);
  return finish(net, stack, timings, conns);
}
