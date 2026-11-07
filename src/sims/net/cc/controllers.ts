/**
 * Congestion controllers for the ACK-clocked sender in flow.ts. A controller owns `cwnd` (in packets) and, if it
 * paces, `pacingPpms` (packets per ms). The sender calls it on every ACK, once per congestion event (a loss, or an
 * ECN echo for a controller that does not handle ECN itself), and on a retransmission timeout.
 *
 * - Reno: RFC 5681. Slow start (+1 packet per packet ACKed), congestion avoidance (+1 packet per RTT), and a
 *   window cut to half of the flight on a loss.
 * - CUBIC: RFC 9438. W(t) = C·(t − K)³ + W_max with C = 0.4 and β = 0.7, the Reno-friendly estimate and fast
 *   convergence. The model uses plain slow start (Linux CUBIC adds HyStart, which this model leaves out).
 * - DCTCP: RFC 8257. Reno growth, plus a cut of α/2 per window, where α is a moving average (g = 1/16) of the
 *   fraction of packets that came back with an ECN echo.
 * - Fixed: a constant window, for sweeps (the BBR model demo) and for the 1986 sender of the collapse demo.
 * BBR v1 is in bbr.ts.
 */

/** What the sender knows when an ACK arrives. */
export interface AckInfo {
  now: number;
  /** Packets that this ACK newly delivered (cumulatively or selectively). */
  acked: number;
  /** Packets this ACK made the sender declare lost. */
  losses: number;
  /** The RTT sample of this ACK, in ms. */
  rtt: number;
  srtt: number;
  minRtt: number;
  /** Packets in flight after this ACK. */
  inflight: number;
  /** Packets delivered so far by this flow. */
  delivered: number;
  inRecovery: boolean;
  /** The ACK echoed a CE mark. */
  ece: boolean;
  /** A delivery-rate sample (packets per ms), as in the IETF draft on delivery rate estimation. */
  rate?: RateSample;
}

export interface RateSample {
  /** Packets per ms. */
  deliveryRate: number;
  /** `delivered` when the newest packet in this sample was sent: BBR uses it to count round trips. */
  priorDelivered: number;
  interval: number;
}

export interface Controller {
  readonly name: string;
  cwnd: number;
  ssthresh: number;
  /** Packets per ms. Undefined: no pacing, send as fast as the window allows. */
  pacingPpms?: number;
  /** A word for the current mode, for plots: "slow start", "avoidance", "recovery", BBR's states. */
  state: string;
  onAck(a: AckInfo): void;
  /** Once per window with a loss. `inflight` is the flight before the lost packets were taken out. */
  onCongestion(now: number, inflight: number): void;
  /** The sender left loss recovery. */
  onRecoveryExit?(now: number): void;
  onRto(now: number, inflight: number): void;
  /** True if the controller reads ECN echoes itself (DCTCP). Otherwise an echo counts as a congestion event. */
  readonly handlesEcn?: boolean;
}

/** RFC 6928 and the Linux default (TCP_INIT_CWND). */
export const INITIAL_WINDOW = 10;

export class Reno implements Controller {
  readonly name: string = "Reno";
  cwnd = INITIAL_WINDOW;
  ssthresh = Infinity;
  state = "slow start";
  onAck(a: AckInfo) {
    if (a.inRecovery) {
      this.state = "recovery";
      return;
    }
    if (this.cwnd < this.ssthresh) {
      this.cwnd += a.acked;
      this.state = "slow start";
    } else {
      this.cwnd += a.acked / this.cwnd;
      this.state = "avoidance";
    }
  }
  onCongestion(_now: number, inflight: number) {
    this.ssthresh = Math.max(inflight / 2, 2);
    this.cwnd = this.ssthresh;
    this.state = "recovery";
  }
  onRto(_now: number, inflight: number) {
    this.ssthresh = Math.max(inflight / 2, 2);
    this.cwnd = 1;
    this.state = "slow start";
  }
}

/** RFC 9438 constants. */
export const CUBIC_C = 0.4;
export const CUBIC_BETA = 0.7;
/** The Reno-friendly additive increase: 3(1 − β)/(1 + β) ≈ 0.53 packets per RTT. */
export const CUBIC_ALPHA = (3 * (1 - CUBIC_BETA)) / (1 + CUBIC_BETA);

/** K: the seconds the cubic curve takes to climb from `wEpoch` back to `wMax`. */
export const cubicK = (wMax: number, wEpoch: number, c = CUBIC_C) => Math.cbrt(Math.max(0, wMax - wEpoch) / c);

/** W_cubic(t) = C·(t − K)³ + W_max, with t in seconds since the start of congestion avoidance. */
export const cubicW = (t: number, wMax: number, k: number, c = CUBIC_C) => c * (t - k) ** 3 + wMax;

export class Cubic implements Controller {
  readonly name = "CUBIC";
  cwnd = INITIAL_WINDOW;
  ssthresh = Infinity;
  state = "slow start";
  wMax = 0;
  k = 0;
  /** Start of the current congestion-avoidance stage, in ms; NaN until it starts. */
  tEpoch = NaN;
  wEst = 0;
  cwndPrior = 0;
  constructor(readonly fastConvergence = true) {}

  onAck(a: AckInfo) {
    if (a.inRecovery) {
      this.state = "recovery";
      return;
    }
    if (this.cwnd < this.ssthresh) {
      this.cwnd += a.acked;
      this.state = "slow start";
      return;
    }
    if (Number.isNaN(this.tEpoch)) {
      this.tEpoch = a.now;
      if (this.wMax <= 0 || this.wMax < this.cwnd) {
        // No loss yet (we left slow start through ssthresh): the curve starts at its plateau.
        this.wMax = this.cwnd;
        this.k = 0;
      } else this.k = cubicK(this.wMax, this.cwnd);
      this.wEst = this.cwnd;
    }
    const t = (a.now - this.tEpoch) / 1000;
    const rtt = (a.srtt || a.rtt) / 1000;
    const alpha = this.wEst >= this.cwndPrior ? 1 : CUBIC_ALPHA;
    this.wEst += (alpha * a.acked) / this.cwnd;
    const wc = cubicW(t, this.wMax, this.k);
    if (wc < this.wEst) {
      this.cwnd = Math.max(this.cwnd, this.wEst);
      this.state = "Reno-friendly";
      return;
    }
    const target = Math.min(1.5 * this.cwnd, Math.max(this.cwnd, cubicW(t + rtt, this.wMax, this.k)));
    this.cwnd += ((target - this.cwnd) / this.cwnd) * a.acked;
    this.state = wc < this.wMax ? "concave" : "convex";
  }
  private cut(inflight: number) {
    const w = Math.max(this.cwnd, inflight);
    this.wMax = this.fastConvergence && w < this.wMax ? (w * (1 + CUBIC_BETA)) / 2 : w;
    this.cwndPrior = w;
    this.ssthresh = Math.max(w * CUBIC_BETA, 2);
    this.tEpoch = NaN;
  }
  onCongestion(_now: number, inflight: number) {
    this.cut(inflight);
    this.cwnd = this.ssthresh;
    this.state = "recovery";
  }
  onRto(_now: number, inflight: number) {
    this.cut(inflight);
    this.cwnd = 1;
    this.state = "slow start";
  }
}

/** RFC 8257: the gain of the moving average. */
export const DCTCP_G = 1 / 16;

export class Dctcp extends Reno {
  override readonly name = "DCTCP";
  readonly handlesEcn = true;
  alpha = 1;
  private winEnd = 0;
  private acked = 0;
  private marked = 0;
  private cutUntil = -1;
  override onAck(a: AckInfo) {
    this.acked += a.acked;
    if (a.ece) this.marked += a.acked;
    if (a.delivered >= this.winEnd) {
      // One observation window (about one RTT of packets) ended: update α.
      const f = this.acked > 0 ? this.marked / this.acked : 0;
      this.alpha = (1 - DCTCP_G) * this.alpha + DCTCP_G * f;
      this.acked = this.marked = 0;
      this.winEnd = a.delivered + Math.max(1, a.inflight);
    }
    if (a.ece && a.delivered > this.cutUntil && !a.inRecovery) {
      this.cwnd = Math.max(2, this.cwnd * (1 - this.alpha / 2));
      this.ssthresh = this.cwnd;
      this.cutUntil = a.delivered + Math.max(1, a.inflight);
      this.state = "ECN cut";
      return;
    }
    super.onAck(a);
  }
}

/** A constant window: no reaction to loss or delay. */
export class Fixed implements Controller {
  readonly name = "fixed window";
  ssthresh = Infinity;
  state = "fixed";
  constructor(public cwnd: number) {}
  onAck() {}
  onCongestion() {}
  onRto() {}
}
