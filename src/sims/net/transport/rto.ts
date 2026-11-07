/**
 * The retransmission timeout (RTO) estimator of RFC 6298, as a small pure class.
 *
 * First sample R:   SRTT = R, RTTVAR = R/2.
 * Later samples R': RTTVAR = (1 − β)·RTTVAR + β·|SRTT − R'|, then SRTT = (1 − α)·SRTT + α·R', with α = 1/8, β = 1/4.
 * RTO = SRTT + max(G, K·RTTVAR) with K = 4, clamped to [minRto, maxRto]. Before any sample, RTO = initialRto.
 * When the timer expires, the sender doubles the RTO ("backoff", section 5.5). A new valid sample recomputes it.
 *
 * RFC 6298 says the minimum SHOULD be 1 s. Linux uses 200 ms (TCP_RTO_MIN) and a maximum of 120 s (TCP_RTO_MAX).
 */
export interface RtoConfig {
  /** ms. RFC 6298: 1000. */
  initialRto: number;
  /** ms. RFC 6298: 1000; Linux: 200. */
  minRto: number;
  /** ms. RFC 6298: at least 60 000; Linux: 120 000. */
  maxRto: number;
  /** Clock granularity G in ms (a model input). */
  granularity: number;
}

export const RFC6298: RtoConfig = { initialRto: 1000, minRto: 1000, maxRto: 60_000, granularity: 1 };
export const LINUX_RTO: RtoConfig = { initialRto: 1000, minRto: 200, maxRto: 120_000, granularity: 1 };

export const ALPHA = 1 / 8, BETA = 1 / 4, K = 4;

export class RtoEstimator {
  srtt?: number;
  rttvar?: number;
  /** The timeout without backoff. */
  base: number;
  /** How many times the timer expired since the last valid sample. */
  backoffs = 0;
  samples = 0;
  constructor(readonly cfg: RtoConfig = LINUX_RTO) {
    this.base = cfg.initialRto;
  }

  /** The timeout to arm now: base × 2^backoffs, capped at maxRto. */
  get rto(): number {
    return Math.min(this.cfg.maxRto, this.base * 2 ** this.backoffs);
  }

  /** Feeds one RTT measurement in ms (Karn: never from a retransmitted segment). */
  sample(r: number) {
    if (this.srtt === undefined || this.rttvar === undefined) {
      this.srtt = r;
      this.rttvar = r / 2;
    } else {
      this.rttvar = (1 - BETA) * this.rttvar + BETA * Math.abs(this.srtt - r);
      this.srtt = (1 - ALPHA) * this.srtt + ALPHA * r;
    }
    this.samples++;
    this.backoffs = 0;
    this.base = Math.min(this.cfg.maxRto, Math.max(this.cfg.minRto, this.srtt + Math.max(this.cfg.granularity, K * this.rttvar)));
  }

  /** The timer expired: double the timeout. */
  backoff() {
    this.backoffs++;
  }

  /** RFC 6298 section 5.7: the SYN was retransmitted and no sample exists, so data starts with RTO = 3 s. */
  fallback(ms = 3000) {
    if (this.samples === 0) {
      this.base = Math.max(this.base, ms);
      this.backoffs = 0;
    }
  }
}

/** One row per sample, for a plot: the sample, SRTT, RTTVAR and the RTO after it. */
export function rtoSeries(samples: number[], cfg: RtoConfig = LINUX_RTO) {
  const e = new RtoEstimator(cfg);
  return samples.map((r, i) => {
    const before = e.rto;
    e.sample(r);
    return { i, r, srtt: e.srtt!, rttvar: e.rttvar!, rto: e.rto, rtoBefore: before, spurious: r > before };
  });
}

/**
 * The times at which the sender transmits and gives up, when every copy is lost and the timer doubles each time.
 * `retries` is the number of retransmissions (Linux tcp_syn_retries = 6 plus tcp_syn_linear_timeouts = 4 since 6.5, tcp_synack_retries = 5, tcp_retries2 = 15).
 * Returns the send times in ms and the time of giving up (one more timeout after the last retransmission).
 */
export function backoffSchedule(first: number, retries: number, maxRto = Infinity) {
  const sends = [0];
  let t = 0, rto = first;
  for (let i = 0; i < retries; i++) {
    t += rto;
    sends.push(t);
    rto = Math.min(maxRto, rto * 2);
  }
  return { sends, giveUpAt: t + rto };
}

/** RTT samples with jitter and rare spikes, for the estimator demo. `rng` gives numbers in [0, 1). */
export function jitterySamples(n: number, base: number, jitter: number, spikeEvery: number, spike: number, rng: () => number) {
  return Array.from({ length: n }, (_, i) => {
    const j = (rng() - 0.5) * 2 * jitter;
    const s = spikeEvery > 0 && i > 0 && i % spikeEvery === 0 ? spike : 0;
    return Math.max(0.1, base + j + s);
  });
}
