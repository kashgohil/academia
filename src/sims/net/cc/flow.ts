/**
 * An ACK-clocked bulk sender and its receiver, on any PacketNet, with a pluggable controller.
 *
 * Model inputs (labelled as such in the lessons): data packets are 1500 bytes on the wire, ACKs are 40 bytes, the
 * receiver ACKs every packet (no delayed ACKs), and the minimum RTO is 200 ms (the Linux value; RFC 6298 asks for 1 s).
 *
 * - The receiver keeps out-of-order packets. Each ACK carries the cumulative ACK (the next packet it needs), the
 *   packet that caused it (one SACK block), its transmission number and send time (like a TCP timestamp echo, so
 *   every RTT sample is exact), and the CE mark of that packet.
 * - Loss detection with SACK: a transmission is lost when a transmission sent 3 or more places later is delivered
 *   (the duplicate-ACK threshold of RFC 5681 and RFC 6675). Lost packets are sent again before new ones.
 * - One congestion event per window: the sender enters recovery and ignores further losses until the cumulative
 *   ACK passes the highest packet sent when recovery started.
 * - RTO as in RFC 6298 (SRTT, RTTVAR, RTO = SRTT + 4·RTTVAR, doubled on each timeout). On a timeout every packet
 *   not yet SACKed is lost.
 * - Delivery-rate samples as in the IETF draft on delivery rate estimation, for BBR.
 * - Pacing: if the controller sets `pacingPpms`, packets leave at most at that rate.
 *
 * `legacy: true` gives a 1986-style sender: no SACK and no fast retransmit (only the cumulative ACK counts), an RTO of
 * 2 × SRTT (RFC 793 suggests a factor between 1.3 and 2) with no backoff and no variance term, and go-back-N: on a
 * timeout it sends the whole window again.
 */
import type { NodeId, PacketNet } from "..";
import type { Controller, RateSample } from "./controllers";

export const DATA_BYTES = 1500;
export const ACK_BYTES = 40;
export const MIN_RTO_MS = 200;
export const INITIAL_RTO_MS = 1000;
export const MAX_RTO_MS = 60_000;
export const DUP_THRESH = 3;

export type CcMsg =
  | { k: "data"; flow: number; seq: number; tx: number; sentAt: number }
  | { k: "ack"; flow: number; cum: number; seq: number; tx: number; sentAt: number; ece: boolean };

export interface FlowOpts {
  id: number;
  src: NodeId;
  dst: NodeId;
  cc: Controller;
  /** Packets to send. Default: no end. */
  packets?: number;
  ecn?: boolean;
  minRto?: number;
  legacy?: boolean;
  /** Legacy only: a fixed retransmission timer in ms instead of 2 × SRTT. */
  fixedRtoMs?: number;
  /** Model input: the receiver holds each ACK for a random 0..jitter ms (ACKs keep their order). It breaks the
   *  phase effects that a perfectly regular simulation shows with drop-tail queues (Floyd and Jacobson, 1992). */
  ackJitterMs?: number;
}

const OUT = 1, LOST = 2, DONE = 3;

export class Flow {
  readonly id: number;
  src: NodeId;
  dst: NodeId;
  cc: Controller;
  readonly limit: number;
  readonly legacy: boolean;
  // ---- sender
  nextSeq = 0;
  una = 0;
  inflight = 0;
  private st: number[] = [];
  private lastTx: number[] = [];
  private sentAt: number[] = [];
  private pDelivered: number[] = [];
  private pDeliveredTime: number[] = [];
  private pFirstSent: number[] = [];
  private txq: { seq: number; tx: number }[] = [];
  private txHead = 0;
  private retx: number[] = [];
  private highTx = -1;
  private txCount = 0;
  delivered = 0;
  private deliveredTime = 0;
  private firstSentTime = 0;
  inRecovery = false;
  private recoverSeq = -1;
  srtt = 0;
  rttvar = 0;
  rto = INITIAL_RTO_MS;
  minRtt = Infinity;
  latestRtt = 0;
  private backoff = 1;
  private rtoAt = Infinity;
  private rtoArmed = false;
  private nextSendAt = 0;
  private paceArmed = false;
  started = false;
  // ---- stats
  sent = 0;
  retrans = 0;
  congestionEvents = 0;
  timeouts = 0;
  rttSum = 0;
  rttCount = 0;
  // ---- receiver
  private rcvd: Uint8Array = new Uint8Array(1024);
  rcvCum = 0;
  rcvUnique = 0;
  rcvDup = 0;
  /** Time the receiver got packet seq for the first time. */
  onFirstArrival?: (seq: number, t: number) => void;

  constructor(private net: PacketNet<CcMsg>, o: FlowOpts) {
    this.id = o.id;
    this.src = o.src;
    this.dst = o.dst;
    this.cc = o.cc;
    this.limit = o.packets ?? Infinity;
    this.legacy = o.legacy ?? false;
    this.minRto = o.minRto ?? MIN_RTO_MS;
    this.ecn = o.ecn ?? false;
    this.jitter = o.ackJitterMs ?? 0;
    this.fixedRto = o.fixedRtoMs;
    if (this.fixedRto !== undefined) this.rto = this.fixedRto;
  }
  private fixedRto?: number;
  private jitter: number;
  private lastAckAt = 0;
  private minRto: number;
  private ecn: boolean;

  get done() {
    return this.una >= this.limit;
  }

  start() {
    this.started = true;
    this.trySend();
  }

  /** Stops the flow: nothing more is sent, and its timers do nothing. */
  stopped = false;
  stop() {
    this.stopped = true;
  }

  /**
   * Moves the flow to a new path (QUIC connection migration). The sender learns what the receiver has, everything
   * else in flight is lost, the RTT estimate and the controller start again, and sending resumes.
   */
  restartPath(cc: Controller) {
    // The client's first packet on the new path carries an ACK frame for everything it has.
    while (this.una < this.rcvCum) this.st[this.una++] = DONE;
    for (let s = this.una; s < this.nextSeq; s++) {
      if (this.rcvd[s]) {
        if (this.st[s] !== DONE) this.delivered++;
        this.st[s] = DONE;
        continue;
      }
      if (this.st[s] === OUT) {
        this.st[s] = LOST;
        this.insertRetx(s);
      }
    }
    this.inflight = 0;
    this.txq = [];
    this.txHead = 0;
    this.highTx = this.txCount - 1;
    this.cc = cc;
    this.srtt = this.rttvar = 0;
    this.rto = INITIAL_RTO_MS;
    this.minRtt = Infinity;
    this.backoff = 1;
    this.inRecovery = false;
    this.stopped = false;
    this.trySend();
  }

  private nextToSend(): number | undefined {
    while (this.retx.length) {
      const s = this.retx[0]!;
      if (this.st[s] === LOST) return s;
      this.retx.shift();
    }
    return this.nextSeq < this.limit ? this.nextSeq : undefined;
  }

  trySend() {
    if (this.stopped || !this.started) return;
    const net = this.net;
    for (;;) {
      if (this.inflight >= Math.max(1, Math.floor(this.cc.cwnd + 1e-9))) break;
      const seq = this.nextToSend();
      if (seq === undefined) break;
      const pace = this.cc.pacingPpms;
      if (pace !== undefined && pace > 0 && net.now < this.nextSendAt - 1e-9) {
        if (!this.paceArmed) {
          this.paceArmed = true;
          net.at(this.nextSendAt, () => {
            this.paceArmed = false;
            this.trySend();
          });
        }
        break;
      }
      this.transmit(seq);
      if (pace !== undefined && pace > 0) this.nextSendAt = Math.max(this.nextSendAt, net.now) + 1 / pace;
    }
  }

  private transmit(seq: number) {
    const net = this.net, now = net.now;
    const tx = this.txCount++;
    if (this.inflight === 0) this.firstSentTime = this.deliveredTime = now;
    const isRetx = seq < this.nextSeq;
    if (isRetx) {
      this.retrans++;
      if (this.retx[0] === seq) this.retx.shift();
    } else this.nextSeq = seq + 1;
    this.st[seq] = OUT;
    this.lastTx[seq] = tx;
    this.sentAt[seq] = now;
    this.pDelivered[seq] = this.delivered;
    this.pDeliveredTime[seq] = this.deliveredTime;
    this.pFirstSent[seq] = this.firstSentTime;
    this.inflight++;
    this.sent++;
    if (!this.legacy) this.txq.push({ seq, tx });
    net.send(this.src, this.dst, DATA_BYTES, { k: "data", flow: this.id, seq, tx, sentAt: now }, { flow: this.id, ect: this.ecn });
    if (!this.rtoArmed) this.armRto();
  }

  // ------------------------------------------------------------------ receiver

  onData(m: Extract<CcMsg, { k: "data" }>, ce: boolean) {
    if (this.stopped) return;
    const s = m.seq;
    if (s >= this.rcvd.length) {
      const b = new Uint8Array(Math.max(this.rcvd.length * 2, s + 1));
      b.set(this.rcvd);
      this.rcvd = b;
    }
    if (!this.rcvd[s]) {
      this.rcvd[s] = 1;
      this.rcvUnique++;
      this.onFirstArrival?.(s, this.net.now);
      while (this.rcvCum < this.rcvd.length && this.rcvd[this.rcvCum]) this.rcvCum++;
    } else this.rcvDup++;
    const ack: CcMsg = { k: "ack", flow: this.id, cum: this.rcvCum, seq: s, tx: m.tx, sentAt: m.sentAt, ece: ce };
    if (this.jitter <= 0) {
      this.net.send(this.dst, this.src, ACK_BYTES, ack, { flow: this.id });
      return;
    }
    const at = Math.max(this.lastAckAt, this.net.now + this.net.random() * this.jitter);
    this.lastAckAt = at;
    this.net.at(at, () => this.net.send(this.dst, this.src, ACK_BYTES, ack, { flow: this.id }));
  }

  // ------------------------------------------------------------------ sender: ACKs

  onAck(m: Extract<CcMsg, { k: "ack" }>) {
    if (this.stopped) return;
    const now = this.net.now;
    const rtt = now - m.sentAt;
    this.latestRtt = rtt;
    this.minRtt = Math.min(this.minRtt, rtt);
    this.rttSum += rtt;
    this.rttCount++;
    if (this.legacy) {
      // RFC 793: SRTT = α·SRTT + (1 − α)·RTT, RTO = β·SRTT, with α = 0.875 and β = 2 here.
      this.srtt = this.srtt === 0 ? rtt : 0.875 * this.srtt + 0.125 * rtt;
      this.rto = this.fixedRto ?? 2 * this.srtt;
    } else {
      if (this.srtt === 0) {
        this.srtt = rtt;
        this.rttvar = rtt / 2;
      } else {
        this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - rtt);
        this.srtt = 0.875 * this.srtt + 0.125 * rtt;
      }
      this.rto = Math.min(MAX_RTO_MS, Math.max(this.minRto, this.srtt + 4 * this.rttvar));
    }
    let acked = 0;
    let rs: { prior: number; priorTime: number; send: number; ack: number } | undefined;
    const deliver = (s: number) => {
      const was = this.st[s];
      if (was === DONE) return;
      if (was === OUT) this.inflight--;
      this.st[s] = DONE;
      acked++;
      this.delivered++;
      this.deliveredTime = now;
      const pd = this.pDelivered[s] ?? 0;
      if (!rs || pd > rs.prior) {
        rs = { prior: pd, priorTime: this.pDeliveredTime[s] ?? 0, send: (this.sentAt[s] ?? 0) - (this.pFirstSent[s] ?? 0), ack: 0 };
        this.firstSentTime = this.sentAt[s] ?? now;
      }
    };
    if (!this.legacy && m.seq >= this.una) deliver(m.seq);
    const advanced = m.cum > this.una;
    while (this.una < m.cum) deliver(this.una++);
    if (!this.legacy) this.highTx = Math.max(this.highTx, m.tx);
    // Loss detection.
    let losses = 0;
    const flightBefore = this.inflight;
    while (this.txHead < this.txq.length) {
      const h = this.txq[this.txHead]!;
      if (this.st[h.seq] !== OUT || this.lastTx[h.seq] !== h.tx) {
        this.txHead++;
        continue;
      }
      if (h.tx <= this.highTx - DUP_THRESH) {
        this.st[h.seq] = LOST;
        this.inflight--;
        losses++;
        this.insertRetx(h.seq);
        this.txHead++;
        continue;
      }
      break;
    }
    if (this.txHead > 4096 && this.txHead * 2 > this.txq.length) {
      this.txq = this.txq.slice(this.txHead);
      this.txHead = 0;
    }
    const sample: RateSample | undefined = rs
      ? (() => {
          const r = rs!;
          const interval = Math.max(r.send, now - r.priorTime);
          const d = this.delivered - r.prior;
          return interval > 0 ? { deliveryRate: d / interval, priorDelivered: r.prior, interval } : undefined;
        })()
      : undefined;
    // Congestion events: a loss, or an ECN echo for a controller that does not read ECN itself.
    const ecnEvent = m.ece && !this.cc.handlesEcn;
    if ((losses > 0 || ecnEvent) && !this.inRecovery) {
      this.inRecovery = true;
      this.recoverSeq = this.nextSeq - 1;
      this.congestionEvents++;
      this.cc.onCongestion(now, flightBefore + losses);
    } else if (this.inRecovery && this.una > this.recoverSeq) {
      this.inRecovery = false;
      this.cc.onRecoveryExit?.(now);
    }
    if (advanced) {
      this.backoff = 1;
      this.armRto();
    }
    this.cc.onAck({
      now, acked, losses, rtt, srtt: this.srtt, minRtt: this.minRtt, inflight: this.inflight, delivered: this.delivered,
      inRecovery: this.inRecovery, ece: m.ece, rate: sample,
    });
    this.trySend();
  }

  private insertRetx(s: number) {
    const r = this.retx;
    let i = r.length;
    while (i > 0 && r[i - 1]! > s) i--;
    r.splice(i, 0, s);
  }

  // ------------------------------------------------------------------ timeouts

  private armRto() {
    this.rtoAt = this.net.now + this.rto * this.backoff;
    if (this.rtoArmed) return;
    this.rtoArmed = true;
    this.net.at(this.rtoAt, () => this.rtoFire());
  }

  private rtoFire() {
    this.rtoArmed = false;
    if (this.stopped) return;
    if (this.una >= this.nextSeq) return; // nothing outstanding
    if (this.net.now < this.rtoAt - 1e-9) {
      this.rtoArmed = true;
      this.net.at(this.rtoAt, () => this.rtoFire());
      return;
    }
    this.timeouts++;
    const flight = this.inflight;
    this.retx = [];
    for (let s = this.una; s < this.nextSeq; s++) {
      if (this.st[s] === DONE && !this.legacy) continue;
      this.st[s] = LOST;
      this.retx.push(s);
    }
    this.inflight = 0;
    this.txq = [];
    this.txHead = 0;
    this.inRecovery = true;
    this.recoverSeq = this.nextSeq - 1;
    if (!this.legacy) this.backoff = Math.min(this.backoff * 2, 64);
    this.cc.onRto(this.net.now, flight);
    this.armRto();
    this.trySend();
  }
}

/** Handlers that route data and ACKs to their flows. */
export function ccHandlers(flows: () => Flow[]) {
  return {
    onDeliver(_node: NodeId, pkt: { payload: CcMsg; ce: boolean }) {
      const m = pkt.payload;
      const f = flows()[m.flow];
      if (!f) return;
      if (m.k === "data") f.onData(m, pkt.ce);
      else f.onAck(m);
    },
  };
}
