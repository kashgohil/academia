/**
 * Four ways to make a lossy link reliable, on the same PacketNet path, for the reliability lesson:
 *
 * - gbn: go-back-N. Cumulative ACKs, one timer for the oldest segment; on a timeout, resend the whole window.
 *   The receiver keeps only in-order data.
 * - sr: selective repeat. One ACK and one timer per segment; the receiver buffers out-of-order data.
 * - tcp: tcp.ts without SACK: cumulative ACKs, fast retransmit after 3 duplicate ACKs, NewReno, RTO.
 * - sack: tcp.ts with SACK: the ACKs also list the blocks that arrived, so the sender repairs every hole at once.
 *
 * The learner drops chosen segments (their first copy) and chosen ACKs (the ACK that the first copy of a segment
 * triggers). Segment numbers start at 1. All four use a fixed window of W segments, so only recovery differs.
 */
import { PacketNet, type Packet } from "../packet";
import { fixedSegments } from "./cc";
import { isTcp, type TcpSegment } from "./segment";
import { TcpStack } from "./tcp";

export type ArqProto = "gbn" | "sr" | "tcp" | "sack";

/** A data segment or an ACK of the textbook protocols. ACK `i`: next expected (gbn) or this one arrived (sr). */
export interface ArqMsg { k: "d" | "a"; i: number; retx: number }
export type ArqPayload = ArqMsg | TcpSegment;

export interface ArqOptions {
  proto: ArqProto;
  /** Segments to send. */
  n: number;
  /** Window in segments. */
  window: number;
  /** One-way delay in ms. */
  delay: number;
  /** Retransmission timeout in ms (gbn, sr). For TCP it is the minimum RTO. */
  timeout: number;
  dropData: number[];
  dropAcks: number[];
  /** Random loss on both directions (for sweeps). */
  loss: number;
  /** Link rate in bit/s: 1 Mbit/s puts 12 ms between full segments, so a diagram can show each one. */
  rate: number;
  seed: number;
  record: boolean;
}

export const ARQ_DEFAULTS: ArqOptions = { proto: "gbn", n: 12, window: 5, delay: 20, timeout: 200, dropData: [], dropAcks: [], loss: 0, rate: 1e6, seed: 1, record: true };

export interface ArqResult {
  net: PacketNet<ArqPayload>;
  /** When the sender knows that every segment arrived, in ms from the first data segment. */
  doneAt: number;
  /** Data segments sent, first copies included. */
  sends: number;
  retx: number;
  timeouts: number;
  fastRetx: number;
  acks: number;
  /** Time of the first data segment (TCP needs a handshake first). */
  t0: number;
  /** A short label for each packet. */
  label: (p: Packet<ArqPayload>) => string;
  isData: (p: Packet<ArqPayload>) => boolean;
  isRetx: (p: Packet<ArqPayload>) => boolean;
}

const MSS = 1460;
const segIndex = (s: TcpSegment) => Math.round((s.info.rseq - 1) / MSS) + 1;

export function arqRun(opt: Partial<ArqOptions> = {}): ArqResult {
  const o = { ...ARQ_DEFAULTS, ...opt };
  return o.proto === "gbn" || o.proto === "sr" ? textbook(o) : tcpArq(o);
}

/** The drop filter: first copies of chosen segments, and the ACK that a chosen segment's first copy triggers. */
function chooser(o: ArqOptions, dataOf: (p: Packet<ArqPayload>) => { i: number; first: boolean } | undefined, trigger: () => { i: number; first: boolean } | undefined) {
  return (pkt: Packet<ArqPayload>) => {
    if (pkt.src === 0) {
      const d = dataOf(pkt);
      return !!d && d.first && o.dropData.includes(d.i);
    }
    const t = trigger();
    return !!t && t.first && o.dropAcks.includes(t.i);
  };
}

function textbook(o: ArqOptions): ArqResult {
  let trig: { i: number; first: boolean } | undefined;
  let sends = 0, retx = 0, timeouts = 0, acks = 0, doneAt = NaN;
  const sr = o.proto === "sr";
  // sender
  let base = 1, next = 1;
  const acked = new Set<number>();
  const timers = new Map<number, number>();
  const sentCount = new Map<number, number>();
  // receiver
  let expected = 1;
  const buf = new Set<number>();

  const net: PacketNet<ArqPayload> = new PacketNet<ArqPayload>(["sender", "receiver"], { seed: o.seed, record: o.record }, {
    onDeliver: (node, pkt, nt) => {
      const m = pkt.payload as ArqMsg;
      if (node === 1) {
        trig = { i: m.i, first: m.retx === 0 };
        if (!sr) {
          if (m.i === expected) expected++;
          ack(expected);
        } else {
          if (m.i >= expected && m.i < expected + o.window) {
            buf.add(m.i);
            while (buf.has(expected)) buf.delete(expected++);
            ack(m.i);
          } else if (m.i < expected) ack(m.i);
        }
        trig = undefined;
      } else {
        if (!sr) {
          if (m.i > base) {
            base = m.i;
            stop(0);
            if (base < next) arm(0);
          }
        } else {
          acked.add(m.i);
          stop(m.i);
          while (acked.has(base)) base++;
        }
        if (base > o.n && Number.isNaN(doneAt)) doneAt = nt.now;
        pump();
      }
    },
    onTimer: (_node, tag) => {
      const i = Number(tag.slice(1));
      timers.delete(i);
      timeouts++;
      if (!sr) {
        for (let k = base; k < next; k++) send(k);
        arm(0);
      } else if (!acked.has(i)) {
        send(i);
        arm(i);
      }
    },
  });
  net.connect(0, 1, { rate: o.rate, delay: o.delay, loss: o.loss });
  const ack = (i: number) => {
    acks++;
    net.send(1, 0, 40, { k: "a", i, retx: 0 });
  };
  const send = (i: number) => {
    const c = sentCount.get(i) ?? 0;
    sentCount.set(i, c + 1);
    sends++;
    if (c > 0) retx++;
    net.send(0, 1, 1500, { k: "d", i, retx: c });
  };
  const arm = (i: number) => timers.set(i, net.setTimer(0, o.timeout, `t${i}`));
  const stop = (i: number) => {
    const t = timers.get(i);
    if (t !== undefined) net.cancelTimer(t);
    timers.delete(i);
  };
  const pump = () => {
    while (next < base + o.window && next <= o.n) {
      if (!sr && base === next) arm(0);
      send(next);
      if (sr) arm(next);
      next++;
    }
  };
  net.dropIf = chooser(o, (p) => {
    const m = p.payload as ArqMsg;
    return m.k === "d" ? { i: m.i, first: m.retx === 0 } : undefined;
  }, () => trig);
  pump();
  net.runUntil(120_000);
  return {
    net, doneAt, sends, retx, timeouts, fastRetx: 0, acks, t0: 0,
    label: (p) => {
      const m = p.payload as ArqMsg;
      return m.k === "d" ? `${m.i}` : sr ? `✓${m.i}` : `A${m.i}`;
    },
    isData: (p) => (p.payload as ArqMsg).k === "d",
    isRetx: (p) => (p.payload as ArqMsg).k === "d" && (p.payload as ArqMsg).retx > 0,
  };
}

function tcpArq(o: ArqOptions): ArqResult {
  let trig: { i: number; first: boolean } | undefined;
  const net = new PacketNet<ArqPayload>(["sender", "receiver"], { seed: o.seed, record: o.record });
  net.connect(0, 1, { rate: o.rate, delay: o.delay, loss: o.loss });
  const stack = new TcpStack(net, {
    sack: o.proto === "sack", delayedAck: 0, nagle: false, timeWait: 0, minRto: o.timeout, cc: () => fixedSegments(o.window, MSS), isn: 0, retries: 50,
  });
  net.setHandlers({
    onDeliver: (node, pkt) => {
      const s = pkt.payload;
      if (node === 1 && isTcp(s) && s.len > 0) trig = { i: segIndex(s), first: s.info.retx === 0 };
      stack.deliver(node, pkt);
      trig = undefined;
    },
    onTimer: (node, tag) => stack.timer(node, tag),
  });
  stack.listen(1, 80, { conn: { sack: o.proto === "sack" } });
  const c = stack.connect(0, 1, 80);
  let t0 = 0, doneAt = NaN;
  c.onEstablished = () => {
    t0 = net.now;
    c.write(o.n * MSS);
  };
  net.dropIf = chooser(o, (p) => {
    const s = p.payload as TcpSegment;
    return s.len > 0 ? { i: segIndex(s), first: s.info.retx === 0 } : undefined;
  }, () => trig);
  const total = 1 + o.n * MSS;
  const check = () => {
    if (c.una >= total && Number.isNaN(doneAt)) doneAt = net.now - t0;
  };
  // Poll for completion when the sender's state changes: after each event is cheap enough here.
  while (net.step()) {
    check();
    if (!Number.isNaN(doneAt) || net.now > 120_000) break;
  }
  const isData = (p: Packet<ArqPayload>) => isTcp(p.payload) && p.payload.len > 0;
  return {
    net, doneAt, sends: c.stats.dataSegsOut + c.stats.retxSegs, retx: c.stats.retxSegs, timeouts: c.stats.timeouts, fastRetx: c.stats.fastRetx,
    acks: stack.conns.find((x) => x.node === 1)?.stats.acksOut ?? 0, t0,
    label: (p) => {
      const s = p.payload as TcpSegment;
      if (s.len > 0) return `${segIndex(s)}`;
      if (s.flags & 0x02) return s.flags & 0x10 ? "SYN-ACK" : "SYN";
      // Show the ACK as the next segment number it asks for, as for go-back-N.
      return `A${Math.round((s.info.rack - 1) / MSS) + 1}${s.opts.sack?.length ? "+S" : ""}`;
    },
    isData,
    isRetx: (p) => isData(p) && (p.payload as TcpSegment).info.retx > 0,
  };
}

/** Mean completion time over seeds for a random-loss sweep. Returns ms (NaN if a run did not finish). */
export function arqSweepPoint(proto: ArqProto, loss: number, seeds = 4, n = 60, window = 8) {
  let sum = 0, sends = 0;
  for (let s = 1; s <= seeds; s++) {
    const r = arqRun({ proto, loss, n, window, seed: s, record: false });
    sum += r.doneAt;
    sends += r.sends;
  }
  return { ms: sum / seeds, sendsPerSeg: sends / seeds / n };
}
