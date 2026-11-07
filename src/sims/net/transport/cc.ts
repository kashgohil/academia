/**
 * The hook for congestion control. The TCP sender in tcp.ts never decides how much to send by itself: it keeps
 * the bytes in flight at or below min(cc.cwnd, the peer's receive window), and it tells the controller what
 * happened. A controller (Reno, CUBIC, BBR in the congestion-control module) implements this interface.
 *
 * The default, `fixedWindow`, keeps a constant window. With `Infinity`, only the receive window limits the
 * sender, which is what the flow-control lesson needs.
 */
export interface AckSample {
  now: number;
  /** Bytes newly acknowledged by this ACK (cumulative and SACK). */
  ackedBytes: number;
  /** An RTT sample in ms, if this ACK gave a valid one (Karn's rule). */
  rtt?: number;
  /** Smoothed RTT in ms, if known. */
  srtt?: number;
  /** Bytes in flight after this ACK. */
  inflight: number;
  mss: number;
  /** True while the sender repairs a loss (fast recovery or after a timeout). */
  inRecovery: boolean;
  /** The ACK carried ECE (the receiver saw a CE mark). */
  ece: boolean;
  /** Total bytes acknowledged so far on the connection. */
  delivered: number;
}

export interface LossSignal {
  now: number;
  /** dupack: three duplicate ACKs or SACK showed a hole (fast retransmit). rto: the retransmission timer expired. */
  kind: "dupack" | "rto";
  inflight: number;
  mss: number;
}

export interface CongestionControl {
  readonly name: string;
  /** The congestion window in bytes. */
  readonly cwnd: number;
  /** Optional pacing rate in bytes per ms. Undefined: send as fast as the window allows. */
  readonly pacingRate?: number;
  /** Called once when the connection is established. */
  init?(mss: number, now: number): void;
  onAck(a: AckSample): void;
  onLoss(l: LossSignal): void;
  /** Called after each data segment goes out. */
  onSend?(s: { now: number; bytes: number; inflight: number }): void;
  /** Recovery ended: every byte outstanding at the loss is acknowledged. */
  onRecoveryEnd?(now: number): void;
}

/** A constant window of `bytes` (Infinity: no limit). It ignores every signal. */
export function fixedWindow(bytes = Infinity): CongestionControl {
  return { name: Number.isFinite(bytes) ? `fixed ${bytes} B` : "none", cwnd: bytes, onAck() {}, onLoss() {} };
}

/** A constant window of `n` segments of `mss` bytes. */
export const fixedSegments = (n: number, mss = 1460) => fixedWindow(n * mss);
