/**
 * Failure detectors on Net. Node 1 sends a heartbeat to node 0 every `interval` ms. The network adds a latency in
 * [min, max], and the sender sometimes stalls (a garbage-collection pause or a slow disk): before a heartbeat, with
 * probability `pauseP`, it waits an extra time drawn from an exponential distribution with mean `pause`. At `crashAt`
 * it crashes. The pauses and the latency range are MODEL INPUTS.
 *
 * Two detectors watch the heartbeats at node 0:
 *  - a fixed timeout: suspect when no heartbeat came for `timeout` ms; trust again when one comes;
 *  - the phi accrual detector (Hayashibara, Défago, Yared and Katayama, 2004): from a window of recent inter-arrival
 *    times, phi = -log10 P(the next heartbeat comes later than now). Suspect when phi exceeds a threshold.
 */
import { Net } from "../net";
import { log10NormTail, mean, std } from "./math";

export interface HbConfig {
  seed: number;
  interval: number;
  latency: { min: number; max: number };
  pauseP: number;
  pause: number;
  crashAt: number;
  horizon: number;
}

export const HB_DEFAULTS: HbConfig = { seed: 3, interval: 100, latency: { min: 5, max: 40 }, pauseP: 0.05, pause: 150, crashAt: Infinity, horizon: 3000 };

export interface HbRun {
  net: Net<{ n: number }>;
  /** Send and arrival times of every heartbeat that arrived. */
  arrivals: { sent: number; at: number }[];
  /** Times the sender stalled, as [from, to]. */
  pauses: [number, number][];
}

/** Runs the heartbeats on Net. The detectors below read the arrival times. */
export function heartbeatRun(cfgIn: Partial<HbConfig> = {}): HbRun {
  const cfg = { ...HB_DEFAULTS, ...cfgIn, latency: { ...HB_DEFAULTS.latency, ...cfgIn.latency } };
  const arrivals: { sent: number; at: number }[] = [];
  const pauses: [number, number][] = [];
  let n = 0;
  const net = new Net<{ n: number }>(2, { seed: cfg.seed, latency: cfg.latency }, {
    onMessage(node, msg, nt) {
      if (node === 0) arrivals.push({ sent: msg.sentAt, at: nt.now });
    },
    onTimer(node, tag, nt) {
      if (node !== 1) return;
      if (tag === "beat") {
        nt.send(1, 0, { n: n++ });
        let next = cfg.interval;
        if (nt.random() < cfg.pauseP) {
          const p = -cfg.pause * Math.log(1 - nt.random());
          pauses.push([nt.now + cfg.interval, nt.now + cfg.interval + p]);
          next += p;
        }
        nt.setTimer(1, next, "beat");
      }
    },
  });
  net.setTimer(1, 0, "beat");
  if (Number.isFinite(cfg.crashAt)) {
    net.runUntil(cfg.crashAt);
    net.crash(1);
  }
  net.runUntil(cfg.horizon);
  return { net, arrivals, pauses };
}

export interface Suspicion {
  from: number;
  /** When the next heartbeat arrived and the node was trusted again; undefined if never. */
  to?: number;
}

/** The suspicions of a fixed-timeout detector over the arrival times, up to `horizon`. */
export function timeoutSuspicions(arrivals: readonly { at: number }[], timeout: number, horizon: number): Suspicion[] {
  const out: Suspicion[] = [];
  const times = arrivals.map((a) => a.at).sort((a, b) => a - b);
  for (let i = 0; i < times.length; i++) {
    const deadline = times[i]! + timeout;
    const next = times[i + 1];
    if (next === undefined) {
      if (deadline < horizon) out.push({ from: deadline });
    } else if (next > deadline) out.push({ from: deadline, to: next });
  }
  return out;
}

export interface Tradeoff {
  timeout: number;
  /** Suspicions of a live node per minute. */
  falsePerMin: number;
  /** Mean and worst time from a crash to the suspicion, over crash times spread across the run. */
  detectMean: number;
  detectMax: number;
}

/**
 * The trade-off for one timeout, from one long run with no crash. A crash at time c stops the heartbeats sent after c;
 * the last one sent before c still arrives at time a, so the detector suspects at a + timeout. We average over many c.
 */
export function tradeoff(run: Pick<HbRun, "arrivals">, timeout: number, horizon: number): Tradeoff {
  const sus = timeoutSuspicions(run.arrivals, timeout, horizon);
  const falsePerMin = (sus.filter((s) => s.to !== undefined).length / horizon) * 60_000;
  const byArrival = [...run.arrivals].sort((a, b) => a.sent - b.sent);
  let sum = 0, max = 0, k = 0;
  let j = 0, last = -Infinity;
  // Crash times on a grid, away from the start and the end of the run.
  for (let c = horizon * 0.05; c < horizon * 0.95; c += 7.3) {
    // Heartbeats sent before c still arrive. The detector suspects `timeout` after the last arrival, if no earlier gap
    // already made it suspect (then the detection time is 0).
    while (j < byArrival.length && byArrival[j]!.sent <= c) last = Math.max(last, byArrival[j++]!.at);
    const d = Math.max(0, last + timeout - c);
    sum += d;
    max = Math.max(max, d);
    k++;
  }
  return { timeout, falsePerMin, detectMean: sum / k, detectMax: max };
}

// ---------------------------------------------------------------- phi accrual

export type PhiDist = "normal" | "exponential";

export interface PhiConfig {
  /** Inter-arrival times kept (Akka: max-sample-size = 1000). */
  maxSamples: number;
  /** A floor on the standard deviation, so that a very regular history does not make phi jump (Akka: 100 ms). */
  minStd: number;
  /** Added to the mean: a pause that is still acceptable (Akka: acceptable-heartbeat-pause). */
  acceptablePause: number;
  dist: PhiDist;
}

export const PHI_DEFAULTS: PhiConfig = { maxSamples: 1000, minStd: 20, acceptablePause: 0, dist: "normal" };

/** phi for a time `elapsed` since the last heartbeat, given the window of inter-arrival times. */
export function phiOf(elapsed: number, intervals: readonly number[], cfg: PhiConfig = PHI_DEFAULTS): number {
  if (!intervals.length) return 0;
  const m = mean(intervals) + cfg.acceptablePause;
  if (cfg.dist === "exponential") return Math.max(0, elapsed) / m / Math.LN10; // -log10(e^(-t/m))
  const s = Math.max(cfg.minStd, std(intervals));
  return -log10NormTail((elapsed - m) / s);
}

export class PhiDetector {
  private intervals: number[] = [];
  private last: number | null = null;
  constructor(readonly cfg: PhiConfig = PHI_DEFAULTS) {}

  heartbeat(t: number) {
    if (this.last !== null) {
      this.intervals.push(t - this.last);
      if (this.intervals.length > this.cfg.maxSamples) this.intervals.shift();
    }
    this.last = t;
  }

  phi(now: number) {
    return this.last === null ? 0 : phiOf(now - this.last, this.intervals, this.cfg);
  }

  get window() {
    return this.intervals;
  }

  get lastHeartbeat() {
    return this.last;
  }
}

/** phi over time for a run: samples every `step` ms, and the times phi crossed the threshold upward. */
export function phiTrace(arrivals: readonly { at: number }[], horizon: number, threshold: number, cfg: PhiConfig = PHI_DEFAULTS, step = 5) {
  const det = new PhiDetector(cfg);
  const times = arrivals.map((a) => a.at).sort((a, b) => a - b);
  const pts: [number, number][] = [];
  const crossings: Suspicion[] = [];
  let i = 0;
  let above = false;
  for (let t = 0; t <= horizon; t += step) {
    while (i < times.length && times[i]! <= t) {
      det.heartbeat(times[i]!);
      i++;
      if (above) {
        crossings[crossings.length - 1]!.to = times[i - 1]!;
        above = false;
      }
    }
    // A detector needs a few samples before it judges.
    const p = det.window.length >= 3 ? det.phi(t) : 0;
    pts.push([t, p]);
    if (!above && p > threshold) {
      above = true;
      crossings.push({ from: t });
    }
  }
  return { pts, crossings, detector: det };
}
