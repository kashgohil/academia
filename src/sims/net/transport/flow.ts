/**
 * Scenarios for the flow-control lesson, built on tcp.ts:
 *
 * - slowReaderRun: a fast sender and an application that reads slowly. The receive buffer fills, the window goes
 *   to zero, the sender waits and probes, and window updates restart it. Silly window avoidance can be turned off.
 * - throughputRun: one long transfer on a path with a given rate and RTT. Without window scaling, a 64 KiB window
 *   caps the rate at window / RTT. With autotuning, the receive buffer grows toward the bandwidth-delay product.
 * - nagleRun: request-response with two small writes per request. Nagle's algorithm and delayed ACKs wait for each other.
 */
import { PacketNet } from "../packet";
import { fixedWindow } from "./cc";
import type { TcpSegment } from "./segment";
import { TcpStack, type TcpConn } from "./tcp";

/** The rate a window allows: at most `window` bytes per round trip, and never more than the link. Bits per second. */
export const windowLimitedRate = (window: number, rttMs: number, linkBps: number) => Math.min(linkBps, (window * 8 * 1000) / rttMs);

// ==================================================================== slow reader

export interface SlowReaderOptions {
  /** Receive buffer in bytes. */
  rcvBuf: number;
  /** Application read rate in bytes per ms (1 byte/ms = 1 KB/s). */
  readRate: number;
  /** Bytes per read() call. */
  chunk: number;
  /** Bytes the sender wants to send. */
  total: number;
  /** Link rate in bit/s and one-way delay in ms. */
  rate: number;
  delay: number;
  swsAvoid: boolean;
  nagle: boolean;
  /** Lose every window update the receiver sends (only probes can then reopen the window). */
  loseUpdate: boolean;
  /** The application stops reading in [pauseFrom, pauseTo) ms (a garbage-collection pause, a slow disk). */
  pauseFrom: number;
  pauseTo: number;
  /** Stop after this many ms. */
  duration: number;
}

export const SLOW_DEFAULTS: SlowReaderOptions = { rcvBuf: 16384, readRate: 200, chunk: 2000, total: 120_000, rate: 10e6, delay: 10, swsAvoid: true, nagle: true, loseUpdate: false, pauseFrom: 100, pauseTo: 1200, duration: 3000 };

export interface SlowSample {
  t: number;
  /** Bytes waiting in the receive buffer. */
  buffered: number;
  /** The window the receiver advertises now. */
  wnd: number;
  /** Bytes in flight at the sender. */
  inflight: number;
  /** Bytes the application has read. */
  read: number;
  /** The sender's view, in relative sequence numbers: oldest unacknowledged byte, next byte to send, the peer's window, bytes written. */
  una: number;
  nxt: number;
  sndWnd: number;
  written: number;
}

export interface SlowReaderRun {
  net: PacketNet<TcpSegment>;
  sender: TcpConn;
  receiver: TcpConn;
  samples: SlowSample[];
  /** Payload size of each data segment the sender sent, in order. */
  segSizes: number[];
  probes: number;
  updates: number;
  /** When the application had read every byte (NaN: not within the run). */
  doneAt: number;
  /** Time the sender spent with a zero window, in ms. */
  zeroMs: number;
  /** Times of zero-window probes and of window updates sent by the receiver. */
  probeTimes: number[];
  updateTimes: number[];
}

export function slowReaderRun(opt: Partial<SlowReaderOptions> = {}): SlowReaderRun {
  const o = { ...SLOW_DEFAULTS, ...opt };
  const net = new PacketNet<TcpSegment>(["sender", "receiver"], { seed: 1 });
  net.connect(0, 1, { rate: o.rate, delay: o.delay });
  const stack = new TcpStack(net, { timeWait: 0, cc: () => fixedWindow(), swsAvoid: o.swsAvoid, nagle: o.nagle, isn: 0 }).install();
  let receiver: TcpConn | undefined;
  stack.listen(1, 80, { conn: { autoRead: false, rcvBuf: o.rcvBuf, rcvBufMax: o.rcvBuf, swsAvoid: o.swsAvoid }, onAccept: (c) => (receiver = c) });
  const sender = stack.connect(0, 1, 80, { rcvBuf: o.rcvBuf });
  sender.onEstablished = () => sender.write(o.total);
  net.dropIf = (pkt) => o.loseUpdate && pkt.src === 1 && pkt.payload.info.why === "update";
  const samples: SlowSample[] = [];
  let doneAt = NaN, zeroMs = 0, lastT = 0;
  const every = Math.max(1, o.chunk / o.readRate);
  const reader = () => {
    const paused = net.now >= o.pauseFrom && net.now < o.pauseTo;
    if (receiver && !paused) {
      receiver.read(o.chunk);
      if (receiver.stats.readTotal >= o.total && Number.isNaN(doneAt)) doneAt = net.now;
    }
    if (net.now < o.duration && Number.isNaN(doneAt)) net.at(net.now + every, reader);
  };
  net.at(every, reader);
  const step = 2;
  for (let t = 0; t <= o.duration; t += step) {
    net.at(t, () => {
      if (sender.state === "ESTABLISHED" && sender.sndWnd === 0) zeroMs += net.now - lastT;
      lastT = net.now;
      samples.push({
        t, buffered: receiver?.unread ?? 0, wnd: receiver?.rcvWnd ?? o.rcvBuf, inflight: sender.outstanding, read: receiver?.stats.readTotal ?? 0,
        una: sender.una, nxt: sender.nxt, sndWnd: sender.sndWnd, written: sender.written,
      });
    });
  }
  net.runUntil(o.duration);
  const segSizes = net.trace.filter((e) => e.kind === "send" && e.node === 0 && e.pkt.payload.len > 0 && e.pkt.payload.info.retx === 0).map((e) => (e as { pkt: { payload: TcpSegment } }).pkt.payload.len);
  const probeTimes = stack.events.filter((e) => e.kind === "probe").map((e) => e.t);
  const updateTimes = stack.events.filter((e) => e.kind === "update").map((e) => e.t);
  return { net, sender, receiver: receiver!, samples, segSizes, probes: sender.stats.probes, updates: receiver?.stats.windowUpdates ?? 0, doneAt, zeroMs, probeTimes, updateTimes };
}

/** Header bytes per payload byte for a list of segment sizes (40 bytes of IPv4 + TCP header each). */
export const headerOverhead = (sizes: number[]) => {
  const pay = sizes.reduce((a, b) => a + b, 0);
  return pay ? (40 * sizes.length) / (pay + 40 * sizes.length) : 0;
};

// ==================================================================== window scaling and autotuning

export interface ThroughputOptions {
  /** Link rate in bit/s. */
  rate: number;
  /** Round-trip propagation time in ms. */
  rtt: number;
  /** Receive buffer at the start, in bytes. */
  rcvBuf: number;
  windowScaling: boolean;
  autotune: boolean;
  /** Largest buffer for autotuning (Linux 6.12: tcp_rmem max, up to 6 MiB). */
  rcvBufMax: number;
  /** ms of transfer to simulate after the handshake. */
  duration: number;
}

export const TPUT_DEFAULTS: ThroughputOptions = { rate: 100e6, rtt: 100, rcvBuf: 65535, windowScaling: false, autotune: false, rcvBufMax: 6 * 1024 * 1024, duration: 2000 };

export interface ThroughputRun {
  /** Goodput in bit/s over the whole run after the handshake. */
  goodput: number;
  /** Goodput over the last quarter of the run (after any ramp). */
  steady: number;
  /** [t, Mbit/s] in bins of one RTT; [t, receive buffer bytes]. */
  rateSeries: [number, number][];
  bufSeries: [number, number][];
  /** The largest window the receiver advertised, in bytes. */
  maxWindow: number;
  wscale: number;
}

export function throughputRun(opt: Partial<ThroughputOptions> = {}): ThroughputRun {
  const o = { ...TPUT_DEFAULTS, ...opt };
  const net = new PacketNet<TcpSegment>(["sender", "receiver"], { seed: 1, record: false });
  net.connect(0, 1, { rate: o.rate, delay: o.rtt / 2 });
  const conf = { timeWait: 0, cc: () => fixedWindow(), windowScaling: o.windowScaling, rcvBuf: o.rcvBuf, rcvBufMax: o.autotune ? o.rcvBufMax : o.rcvBuf, autotune: o.autotune, isn: 0 };
  const stack = new TcpStack(net, conf).install();
  let receiver: TcpConn | undefined;
  stack.listen(1, 80, { conn: conf, onAccept: (c) => (receiver = c) });
  const sender = stack.connect(0, 1, 80, conf);
  let t0 = 0;
  // Keep the send buffer topped up: the application always has data.
  sender.onEstablished = () => {
    t0 = net.now;
    sender.write(o.rate * (o.duration + 1000) / 8000);
  };
  while (sender.state !== "ESTABLISHED" && net.step());
  const start = t0;
  const bin = Math.max(o.rtt, o.duration / 40);
  const rateSeries: [number, number][] = [];
  const bufSeries: [number, number][] = [];
  let last = 0, maxWindow = 0;
  for (let t = start + bin; t <= start + o.duration + 1e-9; t += bin) {
    net.runUntil(t);
    const d = receiver?.stats.delivered ?? 0;
    rateSeries.push([t - start, ((d - last) * 8) / bin / 1000]);
    bufSeries.push([t - start, receiver?.rcvBuf ?? o.rcvBuf]);
    maxWindow = Math.max(maxWindow, receiver?.rcvWnd ?? 0);
    last = d;
  }
  const total = receiver?.stats.delivered ?? 0;
  const q = Math.max(1, Math.floor(rateSeries.length / 4));
  const steady = rateSeries.slice(-q).reduce((a, [, r]) => a + r, 0) / q;
  return { goodput: (total * 8 * 1000) / o.duration, steady: steady * 1e6, rateSeries, bufSeries, maxWindow, wscale: receiver?.wsOk ? receiver.rcvShift : 0 };
}

// ==================================================================== Nagle and delayed ACK

export interface NagleOptions {
  nagle: boolean;
  /** Delayed-ACK timeout in ms; 0: acknowledge at once. */
  delayedAck: number;
  /** One-way delay in ms. */
  delay: number;
  requests: number;
  /** The two writes of each request, and the response size. */
  header: number;
  body: number;
  response: number;
}

export const NAGLE_DEFAULTS: NagleOptions = { nagle: true, delayedAck: 40, delay: 5, requests: 3, header: 200, body: 300, response: 1000 };

export interface NagleRun {
  net: PacketNet<TcpSegment>;
  /** Time from the first write of a request to the last byte of its response, per request. */
  latencies: number[];
  /** [start, end] of each request. */
  spans: [number, number][];
}

export function nagleRun(opt: Partial<NagleOptions> = {}): NagleRun {
  const o = { ...NAGLE_DEFAULTS, ...opt };
  const net = new PacketNet<TcpSegment>(["client", "server"], { seed: 1 });
  net.connect(0, 1, { rate: 100e6, delay: o.delay });
  const stack = new TcpStack(net, { timeWait: 0, cc: () => fixedWindow(), nagle: o.nagle, delayedAck: o.delayedAck, isn: 0 }).install();
  const req = o.header + o.body;
  stack.listen(1, 80, {
    onAccept: (s) => {
      let served = 0;
      s.onData = () => {
        while (s.stats.delivered >= (served + 1) * req) {
          served++;
          s.write(o.response);
        }
      };
    },
  });
  const c = stack.connect(0, 1, 80);
  const spans: [number, number][] = [];
  const ask = () => {
    spans.push([net.now, NaN]);
    c.write(o.header);
    c.write(o.body);
  };
  c.onEstablished = ask;
  c.onData = () => {
    const k = spans.length;
    if (c.stats.delivered >= k * o.response && Number.isNaN(spans[k - 1]![1])) {
      spans[k - 1]![1] = net.now;
      if (k < o.requests) ask();
      else c.close();
    }
  };
  net.runUntil(10_000);
  return { net, latencies: spans.map(([a, b]) => b - a), spans };
}
