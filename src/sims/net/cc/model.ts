/**
 * Closed-form models that the lessons compare with the packet runs.
 *
 * - Mathis et al. (1997): a Reno flow with random loss p gets (MSS/RTT) · C/√p, with C = √(3/2) when every
 *   packet is ACKed.
 * - Reno's sawtooth with one flow and a drop-tail queue of B packets: the window peaks at W = BDP + B, falls to W/2,
 *   and the link stays busy only if W/2 ≥ BDP, so B ≥ BDP (the rule of thumb B = RTT × C).
 * - Appenzeller, Keslassy and McKeown (2004): with n desynchronized flows, B = RTT × C / √n is enough.
 * - The BBR picture: with a fixed amount in flight, the delivery rate is min(inflight / RTprop, BtlBw), and the RTT
 *   is max(RTprop, inflight / BtlBw) until the queue is full.
 */
import { runScenario, bdpPackets, type RunResult } from "./run";
import { DATA_BYTES } from "./flow";

export const MATHIS_C = Math.sqrt(3 / 2);

/** Mbit/s that the Mathis formula gives for packets of `bytes`, an RTT in ms and a loss rate p. */
export const mathisMbps = (p: number, rttMs: number, bytes = DATA_BYTES) => ((bytes * 8) / (rttMs / 1000)) * (MATHIS_C / Math.sqrt(p)) / 1e6;

/** The loss rate at which the Mathis formula gives `mbps`: p = (C · MSS / (RTT · rate))². */
export const mathisLossFor = (mbps: number, rttMs: number, bytes = DATA_BYTES) => ((MATHIS_C * bytes * 8) / ((rttMs / 1000) * mbps * 1e6)) ** 2;

/** The window (packets) that the Mathis formula implies: C/√p. */
export const mathisWindow = (p: number) => MATHIS_C / Math.sqrt(p);

/**
 * Utilisation of one Reno flow in the fluid model: the window climbs linearly from W/2 to W = BDP + B (both in
 * packets). While it is below the BDP, the link runs at window/BDP; above it, the link is full.
 */
export function renoFluidUtilisation(bdp: number, buffer: number): number {
  const w = bdp + buffer, lo = w / 2;
  if (lo >= bdp) return 1;
  // Time is proportional to the window climbed (one packet per RTT; the RTT grows above the BDP, but the
  // link is then full, so a longer RTT only adds full-link time). Average over the climb from lo to w.
  const n = 2000;
  let busy = 0, time = 0;
  for (let i = 0; i < n; i++) {
    const x = lo + ((i + 0.5) / n) * (w - lo);
    const rtt = Math.max(1, x / bdp); // the RTT, in units of the base RTT
    busy += Math.min(1, x / bdp) * rtt;
    time += rtt;
  }
  return busy / time;
}

/** The buffer (packets) that Appenzeller et al. give for n flows: BDP/√n. */
export const appenzellerBuffer = (bdp: number, n: number) => bdp / Math.sqrt(n);

export interface OperatingPoint {
  /** Packets in flight (the fixed window). */
  inflight: number;
  /** Mbit/s delivered. */
  mbps: number;
  /** Mean RTT in ms. */
  rttMs: number;
  /** Fraction of packets sent again. */
  retrans: number;
}

/** One packet run with a fixed window: where a sender that keeps `window` packets in flight ends up. */
export function operatingPoint(mbps: number, rttMs: number, queue: number, window: number, durationMs = 3000): OperatingPoint {
  const r: RunResult = runScenario({ mbps, rttMs, queue, flows: [{ cc: { fixed: window } }], durationMs, warmupMs: durationMs / 3 });
  const f = r.flows[0]!;
  return { inflight: window, mbps: f.goodputMbps, rttMs: f.meanRttMs, retrans: f.retransFrac };
}

/** The ideal curves of the BBR paper for a path: delivery rate and RTT as functions of the amount in flight. */
export function idealPoint(mbps: number, rttMs: number, queue: number, inflight: number) {
  const bdp = bdpPackets(mbps, rttMs);
  const full = inflight > bdp + queue;
  return {
    mbps: Math.min(mbps, (inflight / bdp) * mbps),
    rttMs: rttMs * Math.max(1, Math.min(inflight, bdp + queue) / bdp),
    loss: full,
  };
}
