/**
 * A reference TCP on PacketNet. It is small and readable, and it follows RFC 9293 and the RFCs around it:
 *
 * - The state machine with the real state names, the three-way handshake, simultaneous open, FIN teardown with
 *   half-close, TIME_WAIT for a configurable time, and RST for a closed port or an abort.
 * - SYN and SYN-ACK retries with a doubling timeout (Linux tcp_syn_retries, tcp_synack_retries), a SYN backlog,
 *   and SYN cookies (cookies.ts) when the backlog is full.
 * - Cumulative ACKs, the RFC 6298 RTO estimator with backoff and Karn's rule, fast retransmit on three duplicate
 *   ACKs with NewReno partial ACKs (RFC 6582), and SACK (RFC 2018) with loss marking as in RFC 6675.
 * - The receive window: a receive buffer that the application drains, window scaling (RFC 7323), silly window
 *   avoidance on both sides, zero-window probes on a persist timer, window updates, and a model of Linux
 *   receive-buffer autotuning.
 * - Nagle's algorithm (RFC 896) and delayed ACKs, so their bad interaction shows up.
 * - A pluggable congestion controller (cc.ts). The default never limits the sender.
 *
 * Simplifications, on purpose: the stream is a byte count (no contents), segment boundaries are fixed at the first
 * send, there are no TCP timestamps, no urgent data and no keepalives, and the stack sends a separate FIN segment.
 */
import { PacketNet, type NodeId, type Packet, type PacketHandlers } from "../packet";
import { fixedWindow, type CongestionControl } from "./cc";
import { checkCookie, makeCookie } from "./cookies";
import { RtoEstimator } from "./rto";
import { ACK, FIN, PSH, RST, SYN, isTcp, segmentSize, unwrap, wrap, type SegWhy, type TcpOptions, type TcpSegment } from "./segment";

export type TcpState =
  | "CLOSED" | "LISTEN" | "SYN_SENT" | "SYN_RECEIVED" | "ESTABLISHED"
  | "FIN_WAIT_1" | "FIN_WAIT_2" | "CLOSE_WAIT" | "CLOSING" | "LAST_ACK" | "TIME_WAIT";

export interface TcpConfig {
  /** Largest payload per segment we accept (sent in the MSS option). 1460 = 1500-byte MTU − 40. */
  mss: number;
  /** Receive buffer in bytes (a model input). The advertised window is its free part. */
  rcvBuf: number;
  /** Largest receive buffer for autotuning. It also sets the window scale offered in the SYN. */
  rcvBufMax: number;
  /** Grow rcvBuf to twice the bytes the application reads per RTT (a model of Linux tcp_moderate_rcvbuf). */
  autotune: boolean;
  /** Offer window scaling (RFC 7323). Without it the window field caps the window at 65 535 bytes. */
  windowScaling: boolean;
  /** Offer SACK (RFC 2018). */
  sack: boolean;
  /** Nagle's algorithm (RFC 896). False is TCP_NODELAY. */
  nagle: boolean;
  /** Delayed-ACK timeout in ms; 0 acknowledges every segment at once. Linux uses 40 to 200 ms. */
  delayedAck: number;
  /** Silly window syndrome avoidance on both sides (RFC 9293, section 3.8.6.2). */
  swsAvoid: boolean;
  initialRto: number;
  minRto: number;
  maxRto: number;
  /** Duplicate ACKs that trigger fast retransmit. */
  dupThresh: number;
  /** SYN retransmissions before connect fails (Linux tcp_syn_retries = 6). */
  synRetries: number;
  /** SYN-ACK retransmissions before a half-open entry is dropped (Linux tcp_synack_retries = 5). */
  synAckRetries: number;
  /** Data retransmissions before the connection is aborted (Linux tcp_retries2 = 15). */
  retries: number;
  /** Time in TIME_WAIT in ms (RFC 9293: 2 × MSL = 4 min; Linux: 60 s). A model input; 0 skips TIME_WAIT. */
  timeWait: number;
  /** The congestion controller, made fresh for each connection. */
  cc: () => CongestionControl;
  /** A fixed initial sequence number. Default: random from the run's seed. */
  isn?: number;
  /** The application reads every byte as soon as it arrives. False: call `read()`. */
  autoRead: boolean;
  /** Keep per-connection logs (windows, RTT samples). Default: the net's `record` setting. */
  log?: boolean;
}

export const TCP_DEFAULTS: TcpConfig = {
  mss: 1460, rcvBuf: 65535, rcvBufMax: 65535, autotune: false, windowScaling: true, sack: true, nagle: true,
  delayedAck: 40, swsAvoid: true, initialRto: 1000, minRto: 200, maxRto: 120_000, dupThresh: 3,
  synRetries: 6, synAckRetries: 5, retries: 15, timeWait: 60_000, cc: () => fixedWindow(), autoRead: true,
};

/** Default MSS when the peer sends no MSS option (RFC 9293). */
export const DEFAULT_MSS = 536;

/** The smallest shift that fits `buf` in the 16-bit window field, at most 14 (RFC 7323). */
export function windowShift(buf: number): number {
  let s = 0;
  while (s < 14 && Math.floor(buf / 2 ** s) > 65535) s++;
  return s;
}

export type TcpEventKind = "state" | "rto" | "fast" | "partial" | "probe" | "update" | "giveup" | "reset" | "synDrop" | "cookie" | "autotune" | "corrupt";
export interface TcpEvent { t: number; conn: number; node: NodeId; kind: TcpEventKind; text: string; state?: TcpState }

/** One segment in the retransmission queue. Relative sequence numbers [s, e) include SYN and FIN. */
export interface TxSeg {
  s: number;
  e: number;
  len: number;
  syn: boolean;
  fin: boolean;
  sentAt: number;
  firstAt: number;
  retx: number;
  sacked: boolean;
  lost: boolean;
  inFlight: boolean;
  /** The recovery episode in which it was last retransmitted (a lost retransmission is found only by the RTO). */
  epoch: number;
}

interface Range { s: number; e: number; foreign: boolean }
type TimerKind = "rto" | "delack" | "persist" | "timewait";

export interface ConnStats {
  segsOut: number;
  dataSegsOut: number;
  /** Payload bytes sent, retransmissions included. */
  bytesOut: number;
  retxSegs: number;
  retxBytes: number;
  timeouts: number;
  fastRetx: number;
  probes: number;
  windowUpdates: number;
  acksOut: number;
  dupAcksIn: number;
  /** In-order payload bytes received. */
  delivered: number;
  /** Bytes the application has read. */
  readTotal: number;
  /** Bytes delivered to the application that came from another connection (an old duplicate). */
  corrupted: number;
  /** Bytes the peer acknowledged. */
  acked: number;
  establishedAt?: number;
  closedAt?: number;
}

export type CloseReason = "normal" | "reset" | "refused" | "timeout" | "aborted" | "synack-timeout";

export class TcpConn {
  readonly cfg: TcpConfig;
  state: TcpState = "CLOSED";
  /** How it ended, once CLOSED. */
  reason?: CloseReason;
  readonly stats: ConnStats = { segsOut: 0, dataSegsOut: 0, bytesOut: 0, retxSegs: 0, retxBytes: 0, timeouts: 0, fastRetx: 0, probes: 0, windowUpdates: 0, acksOut: 0, dupAcksIn: 0, delivered: 0, readTotal: 0, corrupted: 0, acked: 0 };
  /** [t, state] after each change. */
  readonly states: [number, TcpState][] = [];

  // ---- send side, relative to iss (SYN = 0, first data byte = 1)
  iss = 0;
  una = 0;
  nxt = 0;
  /** Bytes the application wrote. Data occupies relative 1..written. */
  written = 0;
  finQueued = false;
  finSent = false;
  /** The peer's window in bytes (after scaling). */
  sndWnd = 0;
  maxSndWnd = 0;
  private wl1 = 0;
  private wl2 = 0;
  /** Effective MSS: min(ours, the peer's option). */
  mss: number;
  peerMss = DEFAULT_MSS;
  /** Shift we apply to our window field; shift the peer applies to its own. */
  rcvShift = 0;
  sndShift = 0;
  wsOk = false;
  sackOk = false;
  readonly rtxq: TxSeg[] = [];
  dupAcks = 0;
  private renoSacked = 0;
  inRecovery = false;
  recoveryKind: "fast" | "rto" | null = null;
  private recoverPoint = 0;
  private epoch = 0;
  private probesOut = 0;
  readonly rtt: RtoEstimator;
  readonly cc: CongestionControl;

  // ---- receive side, relative to irs
  irs = 0;
  rcvNxt = 0;
  /** The right edge of the window we advertised (relative). */
  rcvRight = 0;
  rcvBuf: number;
  /** In-order bytes waiting for the application. */
  unread = 0;
  /** Out-of-order data, sorted and not overlapping. */
  readonly ooo: Range[] = [];
  private lastOoo = -1;
  private finAt?: number;
  /** The peer sent FIN and every byte before it arrived: read returns EOF after the data. */
  eof = false;
  private pendingAck = 0;
  /** The id of the connection at the other end (learned from its segments; not on the wire). */
  peerConn = 0;
  private hsSent = 0;
  /** Handshake RTT in ms, measured once (used by autotuning). */
  hsRtt?: number;
  private atStart = 0;
  private atRead = 0;

  private timers: Partial<Record<TimerKind, number>> = {};
  readonly logging: boolean;
  /** [t, the peer's window as this sender sees it]. */
  readonly wndLog: [number, number][] = [];
  /** [t, unread bytes, advertised window] at this receiver. */
  readonly rcvLog: [number, number, number][] = [];
  /** RTT samples: [t, sample, srtt, rto]. */
  readonly rttLog: [number, number, number, number][] = [];

  /** New in-order bytes arrived (before an automatic read). */
  onData?: (c: TcpConn, n: number) => void;
  onEstablished?: (c: TcpConn) => void;
  /** The peer closed its side (FIN received in order). */
  onEof?: (c: TcpConn) => void;
  onClose?: (c: TcpConn, reason: CloseReason) => void;

  constructor(
    readonly stack: TcpStack,
    readonly id: number,
    readonly node: NodeId,
    readonly lport: number,
    readonly rnode: NodeId,
    readonly rport: number,
    readonly passive: boolean,
    cfg: TcpConfig,
    readonly listener?: TcpListener,
  ) {
    this.cfg = cfg;
    this.mss = cfg.mss;
    this.rcvBuf = cfg.rcvBuf;
    this.rtt = new RtoEstimator({ initialRto: cfg.initialRto, minRto: cfg.minRto, maxRto: cfg.maxRto, granularity: 1 });
    this.cc = cfg.cc();
    this.logging = cfg.log ?? stack.net.cfg.record;
    this.iss = cfg.isn ?? Math.floor(stack.net.random() * 4294967296);
  }

  get net() {
    return this.stack.net;
  }
  get now() {
    return this.stack.net.now;
  }
  /** True once the handshake is done and until CLOSED. */
  get synchronized() {
    return this.state !== "CLOSED" && this.state !== "LISTEN" && this.state !== "SYN_SENT" && this.state !== "SYN_RECEIVED";
  }
  /** Bytes sent and not yet acknowledged (sequence space). */
  get outstanding() {
    return this.nxt - this.una;
  }
  /** Bytes written by the application and not yet sent. */
  get unsent() {
    return Math.max(0, 1 + this.written - this.nxt);
  }
  /** The window we advertise now, in bytes. */
  get rcvWnd() {
    return Math.max(0, this.rcvRight - this.rcvNxt);
  }
  /** Out-of-order bytes held. */
  get oooBytes() {
    return this.ooo.reduce((a, r) => a + r.e - r.s, 0);
  }

  /** RFC 6675 "pipe": bytes believed to be in the network. Without SACK, each duplicate ACK counts one MSS out (as Linux does). */
  pipe(): number {
    let p = 0;
    for (const g of this.rtxq) if (g.inFlight) p += g.e - g.s;
    return Math.max(0, p - this.renoSacked * this.mss);
  }

  // ------------------------------------------------------------------ application calls

  /** Queues `n` bytes to send. */
  write(n: number) {
    if (this.finQueued) throw new Error("write after close");
    this.written += n;
    this.trySend();
    return n;
  }

  /** Reads up to `max` bytes from the receive buffer. Returns the count; 0 with `eof` true means the peer closed. */
  read(max = Infinity): number {
    const n = Math.min(this.unread, max);
    if (n <= 0) return 0;
    const oldWnd = this.rcvWnd, oldRight = this.rcvRight;
    this.unread -= n;
    this.stats.readTotal += n;
    this.autotune(n);
    this.updateRight();
    const newWnd = this.rcvWnd;
    if (this.synchronized && this.rcvRight > oldRight && (oldWnd < this.mss || !this.cfg.swsAvoid || newWnd >= 2 * oldWnd)) {
      this.stats.windowUpdates++;
      this.event("update", `window update: ${oldWnd} → ${newWnd} B`);
      this.sendAck("update");
    }
    this.logRcv();
    return n;
  }

  /** shutdown(SHUT_WR): send FIN after the queued data. The other direction stays open (half-close). */
  close() {
    if (this.state === "SYN_SENT" || this.state === "CLOSED") return this.toClosed("normal");
    if (this.finQueued) return;
    this.finQueued = true;
    this.trySend();
  }

  /** Abort: send RST and forget the connection. */
  abort() {
    if (this.state === "CLOSED") return;
    if (this.state !== "SYN_SENT") this.out(RST | ACK, this.nxt, 0, "rst");
    this.toClosed("aborted");
  }

  // ------------------------------------------------------------------ opening

  /** Active open: send SYN. */
  open() {
    this.setState("SYN_SENT");
    this.rcvRight = this.rcvNxt + Math.min(this.rcvBuf, 65535);
    this.rtxq.push(this.txSeg(0, 1, 0, true, false));
    this.nxt = 1;
    this.hsSent = this.now;
    this.out(SYN, 0, 0, "syn");
    this.armRto();
  }

  /** Passive open from a SYN that a listener accepted. */
  acceptSyn(seg: TcpSegment) {
    this.peerConn = seg.info.conn;
    this.irs = seg.seq;
    this.rcvNxt = 1;
    this.peerOptions(seg.opts);
    this.setState("SYN_RECEIVED");
    this.rcvRight = this.rcvNxt + Math.min(this.rcvBuf, 65535);
    this.rtxq.push(this.txSeg(0, 1, 0, true, false));
    this.nxt = 1;
    this.hsSent = this.now;
    this.out(SYN | ACK, 0, 0, "synack");
    this.armRto();
  }

  /** A connection rebuilt from a valid SYN cookie: established at once, with only the MSS from the cookie. */
  fromCookie(seg: TcpSegment, iss: number, mss: number) {
    this.peerConn = seg.info.conn;
    this.iss = iss;
    this.una = this.nxt = 1;
    this.irs = (seg.seq - 1 + 4294967296) % 4294967296;
    this.rcvNxt = 1;
    this.peerMss = mss;
    this.mss = Math.min(this.cfg.mss, mss);
    this.sndWnd = seg.wnd;
    this.wl1 = 1;
    this.wl2 = 1;
    this.rcvRight = this.rcvNxt + Math.min(this.rcvBuf, 65535);
    this.established();
  }

  private peerOptions(o: TcpOptions) {
    this.peerMss = o.mss ?? DEFAULT_MSS;
    this.mss = Math.min(this.cfg.mss, this.peerMss);
    if (o.wscale !== undefined && this.cfg.windowScaling) {
      this.wsOk = true;
      this.sndShift = Math.min(14, o.wscale);
      this.rcvShift = windowShift(Math.max(this.cfg.rcvBufMax, this.cfg.rcvBuf));
    }
    this.sackOk = !!o.sackOk && this.cfg.sack;
  }

  /** Enters ESTABLISHED. `ack` sends the third segment of the handshake before the application runs. */
  private established(ack = false) {
    this.setState("ESTABLISHED");
    this.stats.establishedAt = this.now;
    this.cc.init?.(this.mss, this.now);
    this.atStart = this.now;
    this.updateRight();
    if (ack) this.sendAck("ack");
    this.listener?.onEstablished(this);
    this.onEstablished?.(this);
  }

  // ------------------------------------------------------------------ segment arrival

  /** Handles one segment for this connection (RFC 9293, section 3.10.7). */
  receive(seg: TcpSegment) {
    if (this.state === "CLOSED") return;
    if (this.state === "SYN_SENT") return this.inSynSent(seg);

    const s = unwrap(seg.seq, this.irs, this.rcvNxt);
    const sl = seg.len + (seg.flags & SYN ? 1 : 0) + (seg.flags & FIN ? 1 : 0);

    if (this.state === "TIME_WAIT") {
      if (seg.flags & RST) return;
      if (seg.flags & FIN) {
        // The peer did not get our last ACK: acknowledge again and restart the 2 MSL timer.
        this.sendAck("ack");
        this.cancel("timewait");
        if (this.cfg.timeWait > 0) this.arm("timewait", this.cfg.timeWait);
      }
      return;
    }

    // Sequence check. A pure ACK must not lie before RCV.NXT (a window probe does, on purpose); nothing may start
    // beyond the right edge. An unacceptable segment gets an ACK with the current window.
    if (s > this.rcvRight || (sl === 0 && s < this.rcvNxt) || (sl > 0 && s + sl < this.rcvNxt)) {
      if (!(seg.flags & RST)) this.sendAck(seg.info.why === "probe" ? "ack" : "dupack");
      return;
    }

    if (seg.flags & RST) {
      if (this.state === "SYN_RECEIVED" && this.passive) return this.toClosed("refused", true);
      this.event("reset", "connection reset by peer");
      return this.toClosed(this.state === "SYN_RECEIVED" ? "refused" : "reset");
    }

    if (seg.flags & SYN && !(this.state === "SYN_RECEIVED" && seg.flags & ACK)) {
      if (this.state === "SYN_RECEIVED" && s === 0) {
        // The peer's SYN again: our SYN-ACK was lost. Send it again.
        const g = this.rtxq[0];
        if (g?.syn) this.retransmit(g, "synack");
        return;
      }
      // A SYN on a synchronized connection: answer with a challenge ACK (RFC 5961) and drop it.
      this.sendAck("ack");
      return;
    }

    if (!(seg.flags & ACK)) return;

    if (this.state === "SYN_RECEIVED") {
      const a = unwrap(seg.ack, this.iss, this.una);
      if (a !== 1) {
        this.sendRst(seg);
        return;
      }
      this.peerConn ||= seg.info.conn;
      const first = this.rtxq[0];
      if (first && first.retx === 0) this.hsRtt = this.now - this.hsSent;
      this.sndWnd = seg.wnd << (this.wsOk ? this.sndShift : 0);
      this.maxSndWnd = Math.max(this.maxSndWnd, this.sndWnd);
      this.wl1 = s;
      this.wl2 = a;
      this.processAck(seg, s);
      if (this.rtt.samples === 0 && first && first.retx > 0) this.rtt.fallback();
      this.established();
    } else {
      this.processAck(seg, s);
    }
    // processAck can close the connection (the ACK of our FIN in LAST_ACK).
    if ((this.state as TcpState) === "CLOSED") return;

    this.processData(seg, s);
    this.trySend();
  }

  private inSynSent(seg: TcpSegment) {
    const hasAck = !!(seg.flags & ACK);
    const a = hasAck ? unwrap(seg.ack, this.iss, 0) : 0;
    if (hasAck && a !== 1) {
      if (!(seg.flags & RST)) this.sendRst(seg);
      return;
    }
    if (seg.flags & RST) {
      if (hasAck) {
        this.event("reset", "connection refused");
        this.toClosed("refused");
      }
      return;
    }
    if (!(seg.flags & SYN)) return;
    this.peerConn = seg.info.conn;
    this.irs = seg.seq;
    this.rcvNxt = 1;
    this.peerOptions(seg.opts);
    this.rcvRight = this.rcvNxt + Math.min(this.rcvBuf, 65535);
    if (hasAck) {
      const g = this.rtxq.shift()!;
      this.una = 1;
      if (g.retx === 0) {
        this.hsRtt = this.now - g.sentAt;
        this.sample(this.hsRtt);
      } else this.rtt.fallback();
      this.cancel("rto");
      this.sndWnd = seg.wnd; // a SYN's window is never scaled
      this.maxSndWnd = this.sndWnd;
      this.wl1 = 0;
      this.wl2 = 1;
      this.established(true);
      this.trySend();
    } else {
      // Simultaneous open: both sides sent SYN. Answer with SYN-ACK, reusing our ISN.
      this.setState("SYN_RECEIVED");
      this.sndWnd = seg.wnd;
      const g = this.rtxq[0]!;
      this.retransmit(g, "synack", false);
    }
  }

  private processAck(seg: TcpSegment, segRel: number) {
    const a = unwrap(seg.ack, this.iss, this.una);
    if (a > this.nxt) {
      this.sendAck("ack");
      return;
    }
    let sackedNew = 0;
    if (this.sackOk && seg.opts.sack) {
      for (const [lw, rw] of seg.opts.sack) {
        const l = unwrap(lw, this.iss, this.una), r = unwrap(rw, this.iss, this.una);
        for (const g of this.rtxq) {
          if (!g.sacked && g.s >= l && g.e <= r) {
            g.sacked = true;
            g.inFlight = false;
            g.lost = false;
            sackedNew += g.len;
          }
        }
      }
    }
    const newWnd = seg.wnd << (this.wsOk ? this.sndShift : 0);
    const isDup = a === this.una && seg.len === 0 && !(seg.flags & (SYN | FIN)) && newWnd === this.sndWnd && this.outstanding > 0;

    if (a > this.una) {
      let acked = 0, ackedSegs = 0;
      let sample: number | undefined;
      while (this.rtxq.length && this.rtxq[0]!.e <= a) {
        const g = this.rtxq.shift()!;
        if (!g.sacked) acked += g.len;
        ackedSegs++;
        if (g.retx === 0) sample = this.now - g.sentAt;
      }
      const head = this.rtxq[0];
      if (head && head.s < a) {
        // A part of a segment was acknowledged (a receiver that trimmed it to its window).
        acked += a - head.s;
        head.len -= a - head.s;
        head.s = a;
      }
      this.stats.acked += a - this.una;
      this.una = a;
      this.dupAcks = 0;
      if (sample !== undefined) this.sample(sample);
      if (this.inRecovery) {
        if (this.una >= this.recoverPoint) {
          this.inRecovery = false;
          this.recoveryKind = null;
          this.renoSacked = 0;
          this.cc.onRecoveryEnd?.(this.now);
        } else if (!this.sackOk && this.recoveryKind === "fast") {
          // NewReno (RFC 6582): a partial ACK means the next hole is lost too. Retransmit it now.
          this.renoSacked = Math.max(0, this.renoSacked - Math.max(0, ackedSegs - 1));
          const f = this.rtxq[0];
          if (f && !f.lost && f.epoch !== this.epoch) {
            this.markLost(f);
            this.event("partial", `partial ACK ${a}: retransmit ${f.s}`);
          }
        }
      }
      if (this.outstanding > 0) this.armRto(true);
      else this.cancel("rto");
      this.cc.onAck({ now: this.now, ackedBytes: acked + sackedNew, rtt: sample, srtt: this.rtt.srtt, inflight: this.pipe(), mss: this.mss, inRecovery: this.inRecovery, ece: false, delivered: this.stats.acked });
      this.ackedFin();
    } else if (isDup) {
      this.dupAcks++;
      this.stats.dupAcksIn++;
      if (!this.sackOk) this.renoSacked = Math.min(this.renoSacked + 1, Math.max(0, this.rtxq.length - 1));
      if (this.dupAcks === this.cfg.dupThresh && !this.inRecovery) this.enterFast();
      else if (sackedNew > 0) this.cc.onAck({ now: this.now, ackedBytes: sackedNew, srtt: this.rtt.srtt, inflight: this.pipe(), mss: this.mss, inRecovery: this.inRecovery, ece: false, delivered: this.stats.acked });
    }
    if (this.sackOk) {
      this.markLostBySack();
      if (!this.inRecovery && this.rtxq.some((g) => g.lost)) this.enterFast();
    }
    // RFC 9293: take the window only from a segment that is not older than the last one used.
    if (this.wl1 < segRel || (this.wl1 === segRel && this.wl2 <= a)) {
      this.sndWnd = newWnd;
      this.wl1 = segRel;
      this.wl2 = a;
      this.maxSndWnd = Math.max(this.maxSndWnd, newWnd);
      if (this.logging) this.wndLog.push([this.now, this.sndWnd]);
    }
    if (this.sndWnd > 0 && this.timers.persist) {
      this.cancel("persist");
      this.probesOut = 0;
    }
  }

  private ackedFin() {
    if (!this.finSent || this.una < this.nxt) return;
    if (this.state === "FIN_WAIT_1") this.setState("FIN_WAIT_2");
    else if (this.state === "CLOSING") this.toTimeWait();
    else if (this.state === "LAST_ACK") this.toClosed("normal");
  }

  private enterFast() {
    this.epoch++;
    this.inRecovery = true;
    this.recoveryKind = "fast";
    this.recoverPoint = this.nxt;
    const f = this.rtxq[0];
    if (f && !f.sacked && !f.lost) this.markLost(f);
    this.stats.fastRetx++;
    this.event("fast", this.sackOk ? `SACK shows a hole at ${f?.s}: fast retransmit` : `3 duplicate ACKs: fast retransmit ${f?.s}`);
    this.cc.onLoss({ now: this.now, kind: "dupack", inflight: this.pipe(), mss: this.mss });
  }

  /** RFC 6675 IsLost: a segment with at least DupThresh SACKed segments above it is lost. */
  private markLostBySack() {
    let above = 0;
    for (let i = this.rtxq.length - 1; i >= 0; i--) {
      const g = this.rtxq[i]!;
      if (g.sacked) above++;
      else if (above >= this.cfg.dupThresh && !g.lost && g.inFlight && g.epoch !== this.epoch) this.markLost(g);
    }
  }

  private markLost(g: TxSeg) {
    g.lost = true;
    g.inFlight = false;
  }

  private processData(seg: TcpSegment, segRel: number) {
    const canData = this.state === "ESTABLISHED" || this.state === "FIN_WAIT_1" || this.state === "FIN_WAIT_2";
    if (!canData) return;
    const s = segRel + (seg.flags & SYN ? 1 : 0);
    const e = s + seg.len;
    const foreign = seg.info.conn !== this.peerConn;
    let fresh = 0, outOfOrder = false;
    const hadHole = this.ooo.length > 0;
    const s2 = Math.max(s, this.rcvNxt), e2 = Math.min(e, Math.max(this.rcvRight, this.rcvNxt));
    if (e2 > s2) {
      if (s2 === this.rcvNxt) {
        fresh += this.take(e2 - s2, foreign);
        this.rcvNxt = e2;
        while (this.ooo.length && this.ooo[0]!.s <= this.rcvNxt) {
          const r = this.ooo.shift()!;
          if (r.e > this.rcvNxt) {
            const n = r.e - this.rcvNxt;
            fresh += this.take(n, r.foreign);
            this.rcvNxt = r.e;
          }
        }
      } else {
        this.insertOoo(s2, e2, foreign);
        outOfOrder = true;
      }
    } else if (seg.len > 0 && s >= this.rcvNxt) {
      outOfOrder = true; // beyond a zero or full window: nothing taken
    }
    if (seg.flags & FIN && e2 === e) this.finAt = e;
    let gotFin = false;
    if (this.finAt !== undefined && this.rcvNxt === this.finAt && !this.eof) {
      this.rcvNxt++;
      this.eof = true;
      gotFin = true;
    }
    if (fresh > 0) {
      this.stats.delivered += fresh;
      this.onData?.(this, fresh);
      if (this.cfg.autoRead) this.read();
    }
    this.updateRight();
    this.logRcv();

    if (gotFin) {
      this.sendAck("ack");
      if (this.state === "ESTABLISHED") this.setState("CLOSE_WAIT");
      else if (this.state === "FIN_WAIT_1") this.setState("CLOSING");
      else if (this.state === "FIN_WAIT_2") this.toTimeWait();
      this.onEof?.(this);
      return;
    }
    if (seg.len === 0) return;
    if (outOfOrder || fresh === 0) return this.sendAck("dupack");
    if (hadHole) return this.sendAck("ack");
    this.pendingAck += fresh;
    if (this.cfg.delayedAck <= 0 || this.pendingAck >= 2 * this.mss) this.sendAck("ack");
    else if (!this.timers.delack) this.arm("delack", this.cfg.delayedAck);
  }

  /** Moves `n` in-order bytes into the receive buffer; counts bytes from another connection. */
  private take(n: number, foreign: boolean) {
    this.unread += n;
    if (foreign) {
      this.stats.corrupted += n;
      this.event("corrupt", `${n} bytes from an old connection accepted as data`);
    }
    return n;
  }

  private insertOoo(s: number, e: number, foreign: boolean) {
    this.lastOoo = s;
    // Keep what is already there; add only the uncovered parts.
    const parts: Range[] = [];
    let cur = s;
    for (const r of this.ooo) {
      if (r.e <= cur) continue;
      if (r.s >= e) break;
      if (r.s > cur) parts.push({ s: cur, e: r.s, foreign });
      cur = Math.max(cur, r.e);
    }
    if (cur < e) parts.push({ s: cur, e, foreign });
    this.ooo.push(...parts);
    this.ooo.sort((x, y) => x.s - y.s);
  }

  /** SACK blocks for an ACK: merged out-of-order ranges, the one with the latest arrival first, at most 4. */
  private sackBlocks(): [number, number][] | undefined {
    if (!this.sackOk || !this.ooo.length) return undefined;
    const merged: [number, number][] = [];
    for (const r of this.ooo) {
      const last = merged[merged.length - 1];
      if (last && r.s <= last[1]) last[1] = Math.max(last[1], r.e);
      else merged.push([r.s, r.e]);
    }
    const i = merged.findIndex(([l, r]) => this.lastOoo >= l && this.lastOoo < r);
    if (i > 0) merged.unshift(...merged.splice(i, 1));
    return merged.slice(0, 4).map(([l, r]) => [wrap(this.irs, l), wrap(this.irs, r)]);
  }

  // ------------------------------------------------------------------ window

  /**
   * Moves the right edge of the advertised window. With SWS avoidance (RFC 9293, 3.8.6.2.2), the edge moves only
   * when the free space beyond the current window reaches min(rcvBuf / 2, MSS). It never moves left.
   */
  private updateRight() {
    const free = Math.max(0, this.rcvBuf - this.unread - this.oooBytes);
    const cap = this.synchronized ? 65535 * 2 ** this.rcvShift : 65535;
    const target = this.rcvNxt + Math.min(free, cap);
    if (target <= this.rcvRight) return;
    if (!this.cfg.swsAvoid || free - this.rcvWnd >= Math.min(this.rcvBuf / 2, this.mss) || target - this.rcvNxt >= Math.min(this.rcvBuf / 2, this.mss) && this.rcvWnd === 0) {
      this.rcvRight = target;
    }
  }

  private windowField(syn: boolean) {
    if (syn) return Math.min(65535, this.rcvWnd);
    return Math.min(65535, Math.floor(this.rcvWnd / 2 ** this.rcvShift));
  }

  private autotune(n: number) {
    if (!this.cfg.autotune || this.hsRtt === undefined) return;
    this.atRead += n;
    const rtt = Math.max(1, this.rtt.srtt ?? this.hsRtt);
    if (this.now - this.atStart < rtt) return;
    const target = 2 * this.atRead;
    if (target > this.rcvBuf && this.rcvBuf < this.cfg.rcvBufMax) {
      const from = this.rcvBuf;
      this.rcvBuf = Math.min(this.cfg.rcvBufMax, target);
      this.event("autotune", `receive buffer ${from} → ${this.rcvBuf} B`);
    }
    this.atStart = this.now;
    this.atRead = 0;
  }

  // ------------------------------------------------------------------ sending

  /** Sends what the windows allow: lost segments first, then new data, then FIN. */
  trySend() {
    if (!this.synchronized && this.state !== "SYN_RECEIVED") return;
    if (this.state === "SYN_RECEIVED") return;
    const cwnd = this.cc.cwnd;
    for (const g of this.rtxq) {
      if (!g.lost || g.sacked) continue;
      if (this.pipe() > 0 && this.pipe() + (g.e - g.s) > cwnd) break;
      this.retransmit(g, this.recoveryKind === "rto" ? "rto" : this.sackOk ? "sack" : "fast");
    }
    while (this.state === "ESTABLISHED" || this.state === "CLOSE_WAIT") {
      const unsent = this.unsent;
      if (unsent <= 0) break;
      const usable = Math.min(cwnd - this.pipe(), this.una + this.sndWnd - this.nxt);
      const len = Math.floor(Math.min(this.mss, unsent, usable));
      const idle = this.outstanding === 0;
      if (len <= 0) {
        if (idle && this.una + this.sndWnd - this.nxt <= 0 && !this.timers.persist) this.arm("persist", this.persistDelay());
        break;
      }
      if (len < this.mss) {
        if (len < unsent) {
          // Window-limited: send a small segment only if it is at least half the largest window seen (sender SWS).
          // When nothing is in flight, no ACK will come: the persist timer sends what fits later (Linux tcp_write_wakeup).
          if (this.cfg.swsAvoid && len < this.maxSndWnd / 2) {
            if (idle && !this.timers.persist) this.arm("persist", this.persistDelay());
            break;
          }
        } else if (this.cfg.nagle && !idle && !this.finQueued) {
          break; // Nagle: a small segment waits while data is unacknowledged.
        }
      }
      this.sendNew(len, len === unsent);
    }
    if (this.finQueued && !this.finSent && this.unsent === 0 && (this.state === "ESTABLISHED" || this.state === "CLOSE_WAIT")) {
      this.finSent = true;
      this.rtxq.push(this.txSeg(this.nxt, this.nxt + 1, 0, false, true));
      this.out(FIN | ACK, this.nxt, 0, "fin");
      this.nxt++;
      this.setState(this.state === "ESTABLISHED" ? "FIN_WAIT_1" : "LAST_ACK");
    }
    if (this.outstanding > 0 && !this.timers.rto) this.armRto();
  }

  private sendNew(len: number, push: boolean) {
    const g = this.txSeg(this.nxt, this.nxt + len, len, false, false);
    this.rtxq.push(g);
    this.out(ACK | (push ? PSH : 0), this.nxt, len, "data");
    this.nxt += len;
    this.stats.dataSegsOut++;
    this.cc.onSend?.({ now: this.now, bytes: len, inflight: this.pipe() });
    if (!this.timers.rto) this.armRto();
  }

  private retransmit(g: TxSeg, why: SegWhy, count = true) {
    if (count) g.retx++;
    g.sentAt = this.now;
    g.lost = false;
    g.inFlight = true;
    g.epoch = this.epoch;
    if (count) {
      this.stats.retxSegs++;
      this.stats.retxBytes += g.len;
    }
    const flags = g.syn ? (this.passive || this.state === "SYN_RECEIVED" ? SYN | ACK : SYN) : g.fin ? FIN | ACK : ACK;
    this.out(flags, g.s, g.len, g.syn ? (flags & ACK ? "synack" : "syn") : why, g.retx);
  }

  private txSeg(s: number, e: number, len: number, syn: boolean, fin: boolean): TxSeg {
    return { s, e, len, syn, fin, sentAt: this.now, firstAt: this.now, retx: 0, sacked: false, lost: false, inFlight: true, epoch: -1 };
  }

  sendAck(why: SegWhy) {
    if (this.state === "CLOSED" || this.state === "SYN_SENT") return;
    this.out(ACK, this.nxt, 0, why);
  }

  private sendRst(seg: TcpSegment) {
    const rst: TcpSegment = {
      proto: "tcp", sport: this.lport, dport: this.rport, seq: seg.flags & ACK ? seg.ack : 0, ack: 0, flags: RST, wnd: 0, len: 0, opts: {},
      info: { rseq: 0, rack: 0, retx: 0, why: "rst", conn: this.id },
    };
    this.stack.emit(this.node, this.rnode, rst);
  }

  /** Builds and sends one segment. Every segment after the SYN carries the current ACK and window. */
  private out(flags: number, rel: number, len: number, why: SegWhy, retx = 0) {
    const syn = !!(flags & SYN);
    if (flags & ACK) this.updateRight();
    const opts: TcpOptions = {};
    if (syn) {
      opts.mss = this.cfg.mss;
      const offerWs = this.cfg.windowScaling && (!this.passive && this.state === "SYN_SENT" ? true : this.wsOk);
      if (offerWs) {
        this.rcvShift = windowShift(Math.max(this.cfg.rcvBufMax, this.cfg.rcvBuf));
        opts.wscale = this.rcvShift;
      }
      if (this.cfg.sack && (this.state === "SYN_SENT" && !this.passive ? true : this.sackOk)) opts.sackOk = true;
    } else if (flags & ACK) {
      const b = this.sackBlocks();
      if (b) opts.sack = b;
    }
    const seg: TcpSegment = {
      proto: "tcp", sport: this.lport, dport: this.rport,
      seq: wrap(this.iss, rel), ack: flags & ACK ? wrap(this.irs, this.rcvNxt) : 0,
      flags, wnd: this.windowField(syn), len, opts,
      info: { rseq: rel, rack: flags & ACK ? this.rcvNxt : 0, retx, why, conn: this.id },
    };
    if (flags & ACK) {
      this.pendingAck = 0;
      this.cancel("delack");
      if (len === 0 && !(flags & (SYN | FIN))) this.stats.acksOut++;
    }
    this.stats.segsOut++;
    this.stats.bytesOut += len;
    this.stack.emit(this.node, this.rnode, seg);
  }

  private persistDelay() {
    return Math.min(this.cfg.maxRto, this.rtt.base * 2 ** this.probesOut);
  }

  // ------------------------------------------------------------------ timers

  private sample(r: number) {
    this.rtt.sample(r);
    if (this.logging) this.rttLog.push([this.now, r, this.rtt.srtt!, this.rtt.rto]);
  }

  private armRto(restart = false) {
    if (restart) this.cancel("rto");
    if (!this.timers.rto) this.arm("rto", this.rtt.rto);
  }

  private arm(kind: TimerKind, delay: number) {
    this.cancel(kind);
    this.timers[kind] = this.stack.setTimer(this, kind, delay);
  }

  private cancel(kind: TimerKind) {
    const id = this.timers[kind];
    if (id !== undefined) this.net.cancelTimer(id);
    delete this.timers[kind];
  }

  /** Called by the stack when a timer fires. */
  fire(kind: TimerKind) {
    delete this.timers[kind];
    if (this.state === "CLOSED") return;
    if (kind === "delack") {
      if (this.pendingAck > 0) this.sendAck("delack");
    } else if (kind === "timewait") {
      this.toClosed("normal");
    } else if (kind === "persist") {
      if (this.unsent === 0 || this.outstanding > 0) return this.trySend();
      const room = Math.floor(Math.min(this.una + this.sndWnd - this.nxt, this.cc.cwnd - this.pipe()));
      if (room > 0) return this.sendNew(Math.min(this.mss, this.unsent, room), true);
      // A zero window. Linux sends an old sequence number (snd.una − 1), so the peer must answer with an ACK and its window.
      this.stats.probes++;
      this.probesOut++;
      this.event("probe", "zero-window probe");
      this.out(ACK, this.una - 1, 0, "probe");
      this.arm("persist", this.persistDelay());
    } else this.onRto();
  }

  private onRto() {
    const first = this.rtxq[0];
    if (!first) return;
    if (this.state === "SYN_SENT" && first.retx >= this.cfg.synRetries) {
      this.event("giveup", `no answer after ${first.retx} SYN retries`);
      return this.toClosed("timeout");
    }
    if (this.state === "SYN_RECEIVED" && first.retx >= this.cfg.synAckRetries) {
      this.event("giveup", `no ACK after ${first.retx} SYN-ACK retries`);
      return this.toClosed("synack-timeout", true);
    }
    if (this.synchronized && first.retx >= this.cfg.retries) {
      this.event("giveup", `no ACK after ${first.retx} retransmissions`);
      return this.toClosed("timeout");
    }
    this.stats.timeouts++;
    this.rtt.backoff();
    this.event("rto", `RTO expired (timeout ${Math.round(this.rtt.rto / 2)} ms), now ${Math.round(this.rtt.rto)} ms`);
    if (!this.synchronized) {
      this.retransmit(first, first.syn ? (this.state === "SYN_RECEIVED" ? "synack" : "syn") : "rto");
      this.armRto(true);
      return;
    }
    this.epoch++;
    for (const g of this.rtxq) if (!g.sacked) this.markLost(g);
    this.renoSacked = 0;
    this.dupAcks = 0;
    this.inRecovery = true;
    this.recoveryKind = "rto";
    this.recoverPoint = this.nxt;
    this.cc.onLoss({ now: this.now, kind: "rto", inflight: this.pipe(), mss: this.mss });
    this.trySend();
    if (first.lost) this.retransmit(first, "rto");
    this.armRto(true);
  }

  // ------------------------------------------------------------------ state

  private setState(s: TcpState) {
    if (this.state === s) return;
    this.state = s;
    this.states.push([this.now, s]);
    this.stack.log({ t: this.now, conn: this.id, node: this.node, kind: "state", text: s, state: s });
  }

  private toTimeWait() {
    this.setState("TIME_WAIT");
    for (const k of ["rto", "persist", "delack"] as TimerKind[]) this.cancel(k);
    if (this.cfg.timeWait > 0) this.arm("timewait", this.cfg.timeWait);
    else this.toClosed("normal");
  }

  private toClosed(reason: CloseReason, silent = false) {
    for (const k of ["rto", "persist", "delack", "timewait"] as TimerKind[]) this.cancel(k);
    this.reason = reason;
    this.stats.closedAt = this.now;
    this.setState("CLOSED");
    this.stack.forget(this);
    this.listener?.onDropped(this);
    if (!silent) this.onClose?.(this, reason);
  }

  private event(kind: TcpEventKind, text: string) {
    this.stack.log({ t: this.now, conn: this.id, node: this.node, kind, text });
  }

  private logRcv() {
    if (this.logging) this.rcvLog.push([this.now, this.unread, this.rcvWnd]);
  }
}

// ==================================================================== listener

export interface ListenOptions {
  /** Most half-open (SYN_RECEIVED) entries. In Linux this is the listen() backlog, capped by somaxconn. */
  backlog: number;
  /** false: drop SYNs when the backlog is full. true: answer with a SYN cookie then (Linux tcp_syncookies = 1). "always": always (= 2). */
  synCookies: boolean | "always";
  /** Configuration for accepted connections. */
  conn: Partial<TcpConfig>;
  /** A new connection reached ESTABLISHED. */
  onAccept?: (c: TcpConn) => void;
  /** The secret of the cookie hash. */
  secret: number;
}

export class TcpListener {
  readonly opts: ListenOptions;
  readonly halfOpen = new Set<TcpConn>();
  readonly accepted: TcpConn[] = [];
  readonly stats = { syns: 0, synDropped: 0, cookiesSent: 0, cookiesOk: 0, cookiesBad: 0, maxHalfOpen: 0 };
  constructor(readonly stack: TcpStack, readonly node: NodeId, readonly port: number, opts: Partial<ListenOptions>) {
    this.opts = { backlog: 128, synCookies: true, conn: {}, secret: 0x5eed, ...opts };
  }

  /** A segment for this port with no connection. */
  receive(pkt: Packet<TcpSegment>) {
    const seg = pkt.payload;
    if (seg.flags & RST) return;
    if (seg.flags & ACK && !(seg.flags & SYN)) {
      if (this.opts.synCookies) {
        const isn = (seg.ack - 1 + 4294967296) % 4294967296;
        const mss = checkCookie(isn, this.stack.net.now, this.opts.secret, pkt.src, seg.sport, this.node, this.port);
        if (mss !== undefined) {
          this.stats.cookiesOk++;
          const c = this.stack.newConn(this.node, this.port, pkt.src, seg.sport, true, this.opts.conn, this);
          c.fromCookie(seg, isn, mss);
          c.receive(seg);
          return;
        }
        this.stats.cookiesBad++;
      }
      this.stack.resetFor(this.node, pkt);
      return;
    }
    if (!(seg.flags & SYN)) return;
    this.stats.syns++;
    const full = this.halfOpen.size >= this.opts.backlog;
    if (this.opts.synCookies === "always" || (this.opts.synCookies && full)) {
      this.stats.cookiesSent++;
      const { isn, mss } = makeCookie(this.stack.net.now, this.opts.secret, pkt.src, seg.sport, this.node, this.port, seg.opts.mss ?? DEFAULT_MSS);
      this.stack.log({ t: this.stack.net.now, conn: 0, node: this.node, kind: "cookie", text: `SYN cookie sent (MSS ${mss})` });
      const cfg = { ...TCP_DEFAULTS, ...this.stack.defaults, ...this.opts.conn };
      const synack: TcpSegment = {
        proto: "tcp", sport: this.port, dport: seg.sport, seq: isn, ack: (seg.seq + 1) % 4294967296, flags: SYN | ACK,
        wnd: Math.min(65535, cfg.rcvBuf), len: 0, opts: { mss: cfg.mss }, info: { rseq: 0, rack: 1, retx: 0, why: "cookie", conn: 0 },
      };
      this.stack.emit(this.node, pkt.src, synack);
      return;
    }
    if (full) {
      this.stats.synDropped++;
      this.stack.log({ t: this.stack.net.now, conn: 0, node: this.node, kind: "synDrop", text: "SYN dropped: backlog full" });
      return;
    }
    const c = this.stack.newConn(this.node, this.port, pkt.src, seg.sport, true, this.opts.conn, this);
    this.halfOpen.add(c);
    this.stats.maxHalfOpen = Math.max(this.stats.maxHalfOpen, this.halfOpen.size);
    c.acceptSyn(seg);
  }

  onEstablished(c: TcpConn) {
    this.halfOpen.delete(c);
    this.accepted.push(c);
    this.opts.onAccept?.(c);
  }

  onDropped(c: TcpConn) {
    this.halfOpen.delete(c);
  }
}

// ==================================================================== stack

/**
 * All TCP endpoints on one PacketNet. Use `install()` when the net carries only TCP; otherwise call
 * `deliver` and `timer` from your own handlers (each returns true when it handled the event).
 */
export class TcpStack {
  readonly conns: TcpConn[] = [];
  readonly events: TcpEvent[] = [];
  private byKey = new Map<string, TcpConn>();
  private byId = new Map<number, TcpConn>();
  private listeners = new Map<string, TcpListener>();
  private nextPort = new Map<NodeId, number>();
  private nextId = 1;
  /** Segments that arrived for no connection and no listener. */
  rstsSent = 0;

  /** `net` may carry other payloads too; this stack only looks at TCP segments. */
  constructor(readonly net: PacketNet<any>, readonly defaults: Partial<TcpConfig> = {}) {}

  /** Sets the net's handlers to this stack. */
  install(extra: PacketHandlers<TcpSegment> = {}) {
    this.net.setHandlers({ ...extra, onDeliver: (n, p) => this.deliver(n, p), onTimer: (n, tag) => this.timer(n, tag) });
    return this;
  }

  listen(node: NodeId, port: number, opts: Partial<ListenOptions> = {}): TcpListener {
    const l = new TcpListener(this, node, port, opts);
    this.listeners.set(`${node}:${port}`, l);
    return l;
  }

  /** Active open from `node` to `rnode:rport`. `port` picks the local port (default: the next ephemeral port, from 32768). */
  connect(node: NodeId, rnode: NodeId, rport: number, cfg: Partial<TcpConfig> & { port?: number } = {}): TcpConn {
    const { port, ...rest } = cfg;
    let lport = port;
    if (lport === undefined) {
      lport = this.nextPort.get(node) ?? 32768;
      this.nextPort.set(node, lport + 1);
    }
    if (this.byKey.has(`${node}:${lport}:${rnode}:${rport}`)) throw new Error(`address in use: ${lport} → ${rnode}:${rport} (TIME_WAIT?)`);
    const c = this.newConn(node, lport, rnode, rport, false, rest);
    c.open();
    return c;
  }

  /** The connection that owns a 4-tuple, if any (also one in TIME_WAIT). */
  find(node: NodeId, lport: number, rnode: NodeId, rport: number) {
    return this.byKey.get(`${node}:${lport}:${rnode}:${rport}`);
  }

  newConn(node: NodeId, lport: number, rnode: NodeId, rport: number, passive: boolean, cfg: Partial<TcpConfig>, listener?: TcpListener) {
    const c = new TcpConn(this, this.nextId++, node, lport, rnode, rport, passive, { ...TCP_DEFAULTS, ...this.defaults, ...cfg }, listener);
    this.conns.push(c);
    this.byKey.set(`${node}:${lport}:${rnode}:${rport}`, c);
    this.byId.set(c.id, c);
    return c;
  }

  forget(c: TcpConn) {
    const k = `${c.node}:${c.lport}:${c.rnode}:${c.rport}`;
    if (this.byKey.get(k) === c) this.byKey.delete(k);
  }

  /** Sends a segment from `from` to `to`. */
  emit(from: NodeId, to: NodeId, seg: TcpSegment) {
    this.net.send(from, to, segmentSize(seg), seg, { flow: seg.info.conn });
  }

  /** Sends a segment that claims to come from `fakeSrc` (an attacker that spoofs its address). */
  spoof(from: NodeId, fakeSrc: NodeId, to: NodeId, seg: TcpSegment) {
    const pkt = this.net.packet(fakeSrc, to, segmentSize(seg), seg);
    this.net.transmit(this.net.portsAt(from)[0]!.id, pkt);
  }

  /** RST for a segment that reached no connection (RFC 9293: the CLOSED state). */
  resetFor(node: NodeId, pkt: Packet<TcpSegment>) {
    const seg = pkt.payload;
    if (seg.flags & RST) return;
    const sl = seg.len + (seg.flags & SYN ? 1 : 0) + (seg.flags & FIN ? 1 : 0);
    const rst: TcpSegment = seg.flags & ACK
      ? { proto: "tcp", sport: seg.dport, dport: seg.sport, seq: seg.ack, ack: 0, flags: RST, wnd: 0, len: 0, opts: {}, info: { rseq: 0, rack: 0, retx: 0, why: "rst", conn: 0 } }
      : { proto: "tcp", sport: seg.dport, dport: seg.sport, seq: 0, ack: (seg.seq + sl) % 4294967296, flags: RST | ACK, wnd: 0, len: 0, opts: {}, info: { rseq: 0, rack: 0, retx: 0, why: "rst", conn: 0 } };
    this.rstsSent++;
    this.emit(node, pkt.src, rst);
  }

  /** Handles a delivered packet. Returns false if it is not TCP. */
  deliver(node: NodeId, pkt: Packet<unknown>): boolean {
    if (!isTcp(pkt.payload)) return false;
    const p = pkt as Packet<TcpSegment>;
    const seg = p.payload;
    const c = this.byKey.get(`${node}:${seg.dport}:${pkt.src}:${seg.sport}`);
    if (c) c.receive(seg);
    else {
      const l = this.listeners.get(`${node}:${seg.dport}`);
      if (l) l.receive(p);
      else this.resetFor(node, p);
    }
    return true;
  }

  setTimer(c: TcpConn, kind: string, delay: number) {
    return this.net.setTimer(c.node, delay, `tcp:${c.id}:${kind}`);
  }

  /** Handles a timer. Returns false if the tag is not a TCP timer. */
  timer(_node: NodeId, tag: string): boolean {
    if (!tag.startsWith("tcp:")) return false;
    const [, id, kind] = tag.split(":");
    this.byId.get(Number(id))?.fire(kind as TimerKind);
    return true;
  }

  log(e: TcpEvent) {
    if (this.net.cfg.record) this.events.push(e);
  }
}

/** A point-to-point net of two hosts with a TCP stack installed: the usual setup for one connection. */
export function tcpPair(link: { rate: number; delay: number; queuePackets?: number; queueBytes?: number; loss?: number }, opts: { seed?: number; record?: boolean; names?: [string, string]; tcp?: Partial<TcpConfig> } = {}) {
  const net = new PacketNet<TcpSegment>(opts.names ?? ["client", "server"], { seed: opts.seed ?? 1, record: opts.record ?? true });
  net.connect(0, 1, link);
  const stack = new TcpStack(net, opts.tcp).install();
  return { net, stack };
}
