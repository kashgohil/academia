/**
 * BBR v1, after Cardwell et al., "BBR: Congestion-Based Congestion Control" (ACM Queue, 2016) and Linux
 * net/ipv4/tcp_bbr.c. BBR builds a model of the path from two numbers and paces at the first one:
 *
 * - BtlBw: the bottleneck bandwidth, the max of the delivery-rate samples over the last 10 round trips.
 * - RTprop: the round-trip propagation time, the min RTT seen in the last 10 seconds.
 *
 * pacing rate = pacing_gain × BtlBw, cwnd = cwnd_gain × BtlBw × RTprop (+ a small allowance). The states:
 * Startup (gain 2/ln 2 ≈ 2.89, until BtlBw grows by less than 25% for 3 rounds), Drain (gain 1/2.89, until the
 * flight is down to one BDP), ProbeBW (a cycle of 8 phases with gains 5/4, 3/4, 1, 1, 1, 1, 1, 1, each about one
 * RTprop long, starting at a random phase other than 3/4) and ProbeRTT (cwnd 4 for at least 200 ms and one round,
 * when RTprop has not been refreshed for 10 s).
 *
 * Losses do not change the model. In loss recovery the window follows packet conservation for one round
 * (cwnd = flight + newly ACKed), as tcp_bbr.c does, and is restored when recovery ends.
 */
import type { AckInfo, Controller } from "./controllers";
import { INITIAL_WINDOW } from "./controllers";

export const BBR_HIGH_GAIN = 2885 / 1000; // 2/ln 2, rounded as in tcp_bbr.c
export const BBR_DRAIN_GAIN = 1000 / 2885;
export const BBR_CWND_GAIN = 2;
export const BBR_PACING_GAINS = [5 / 4, 3 / 4, 1, 1, 1, 1, 1, 1] as const;
export const BBR_BW_ROUNDS = 10;
export const BBR_MIN_RTT_WIN_MS = 10_000;
export const BBR_PROBE_RTT_MS = 200;
export const BBR_MIN_CWND = 4;
export const BBR_FULL_BW_THRESH = 5 / 4;
export const BBR_FULL_BW_COUNT = 3;
/** Model input: the allowance for segmentation offload, 3 × 2 segments at low rates in tcp_bbr.c. */
export const BBR_QUANTA = 6;

export type BbrMode = "Startup" | "Drain" | "ProbeBW" | "ProbeRTT";

export class Bbr implements Controller {
  readonly name = "BBR";
  cwnd = INITIAL_WINDOW;
  ssthresh = Infinity;
  pacingPpms?: number;
  mode: BbrMode = "Startup";
  pacingGain = BBR_HIGH_GAIN;
  cwndGain = BBR_HIGH_GAIN;
  /** Packets per ms. */
  btlBw = 0;
  rtProp = Infinity;
  private rtStamp = 0;
  /** Max delivery rate per round, for the last BBR_BW_ROUNDS rounds: [round, rate]. */
  private bwWin: [number, number][] = [];
  round = 0;
  private nextRoundDelivered = 0;
  private roundStart = false;
  private fullBw = 0;
  private fullBwCount = 0;
  fullPipe = false;
  cycleIdx = 0;
  private cycleStamp = 0;
  private probeRttDone = -1;
  private probeRttRoundDone = false;
  private priorCwnd = 0;
  private conservation = false;
  private wasInRecovery = false;
  /** `rand` must be the network's seeded `random`, so that runs repeat. */
  constructor(private rand: () => number) {}

  get state() {
    return this.mode;
  }

  /** Packets: gain × BtlBw × RTprop, plus the allowance. */
  inflightTarget(gain: number) {
    if (!Number.isFinite(this.rtProp) || this.btlBw <= 0) return INITIAL_WINDOW;
    return gain * this.btlBw * this.rtProp + BBR_QUANTA;
  }

  bdp() {
    return Number.isFinite(this.rtProp) ? this.btlBw * this.rtProp : 0;
  }

  onAck(a: AckInfo) {
    // Round counting.
    this.roundStart = false;
    if (a.rate && a.rate.priorDelivered >= this.nextRoundDelivered) {
      this.nextRoundDelivered = a.delivered;
      this.round++;
      this.roundStart = true;
    }
    // BtlBw: windowed max of delivery-rate samples.
    if (a.rate && a.rate.deliveryRate > 0) {
      const last = this.bwWin[this.bwWin.length - 1];
      if (last && last[0] === this.round) last[1] = Math.max(last[1], a.rate.deliveryRate);
      else this.bwWin.push([this.round, a.rate.deliveryRate]);
      while (this.bwWin.length && this.bwWin[0]![0] <= this.round - BBR_BW_ROUNDS) this.bwWin.shift();
      this.btlBw = Math.max(...this.bwWin.map((x) => x[1]));
    }
    // RTprop: windowed min.
    const expired = a.now - this.rtStamp > BBR_MIN_RTT_WIN_MS;
    if (a.rtt > 0 && (a.rtt <= this.rtProp || expired)) {
      this.rtProp = a.rtt;
      this.rtStamp = a.now;
    }
    this.updateMode(a, expired);
    this.pacingPpms = this.btlBw > 0 ? this.pacingGain * this.btlBw : undefined;
    this.setCwnd(a);
  }

  private updateMode(a: AckInfo, rtExpired: boolean) {
    // Startup ends when BtlBw stops growing by 25% for 3 rounds.
    if (!this.fullPipe && this.roundStart) {
      if (this.btlBw >= this.fullBw * BBR_FULL_BW_THRESH) {
        this.fullBw = this.btlBw;
        this.fullBwCount = 0;
      } else if (++this.fullBwCount >= BBR_FULL_BW_COUNT) this.fullPipe = true;
    }
    if (this.mode === "Startup" && this.fullPipe) this.setMode("Drain", BBR_DRAIN_GAIN, BBR_HIGH_GAIN);
    if (this.mode === "Drain" && a.inflight <= this.inflightTarget(1)) this.enterProbeBw(a.now);
    if (this.mode === "ProbeBW") {
      const gain = this.pacingGain;
      const full = a.now - this.cycleStamp > this.rtProp;
      const next =
        gain === 1 ? full
          : gain > 1 ? full && (a.losses > 0 || a.inflight >= this.inflightTarget(gain))
          : full || a.inflight <= this.inflightTarget(1);
      if (next) this.advanceCycle(a.now);
    }
    // ProbeRTT: drain the queue to measure RTprop again.
    if (rtExpired && this.mode !== "ProbeRTT") {
      this.setMode("ProbeRTT", 1, 1);
      this.priorCwnd = Math.max(this.priorCwnd, this.cwnd);
      this.probeRttDone = -1;
    }
    if (this.mode === "ProbeRTT") {
      if (this.probeRttDone < 0 && a.inflight <= BBR_MIN_CWND) {
        this.probeRttDone = a.now + BBR_PROBE_RTT_MS;
        this.probeRttRoundDone = false;
        this.nextRoundDelivered = a.delivered;
      } else if (this.probeRttDone >= 0) {
        if (this.roundStart) this.probeRttRoundDone = true;
        if (this.probeRttRoundDone && a.now > this.probeRttDone) {
          this.rtStamp = a.now;
          this.cwnd = Math.max(this.cwnd, this.priorCwnd);
          if (this.fullPipe) this.enterProbeBw(a.now);
          else this.setMode("Startup", BBR_HIGH_GAIN, BBR_HIGH_GAIN);
        }
      }
    }
  }

  private setMode(m: BbrMode, pacing: number, cwnd: number) {
    this.mode = m;
    this.pacingGain = pacing;
    this.cwndGain = cwnd;
  }

  private enterProbeBw(now: number) {
    this.setMode("ProbeBW", 1, BBR_CWND_GAIN);
    // tcp_bbr.c: a random start phase, never the 3/4 phase.
    this.cycleIdx = 8 - 1 - Math.floor(this.rand() * 7);
    this.advanceCycle(now);
  }

  private advanceCycle(now: number) {
    this.cycleIdx = (this.cycleIdx + 1) % BBR_PACING_GAINS.length;
    this.cycleStamp = now;
    this.pacingGain = BBR_PACING_GAINS[this.cycleIdx]!;
  }

  private setCwnd(a: AckInfo) {
    let cwnd = this.cwnd;
    if (a.losses > 0) cwnd = Math.max(cwnd - a.losses, 1);
    if (a.inRecovery && !this.wasInRecovery) {
      this.priorCwnd = Math.max(this.priorCwnd, this.cwnd);
      this.conservation = true;
      this.nextRoundDelivered = a.delivered;
      cwnd = a.inflight + a.acked;
    } else if (!a.inRecovery && this.wasInRecovery) {
      cwnd = Math.max(cwnd, this.priorCwnd);
      this.priorCwnd = 0;
      this.conservation = false;
    }
    this.wasInRecovery = a.inRecovery;
    if (this.conservation && this.roundStart) this.conservation = false;
    const target = this.inflightTarget(this.cwndGain) + (this.mode === "ProbeBW" && this.cycleIdx === 0 ? 2 : 0);
    if (this.conservation) cwnd = Math.max(cwnd, a.inflight + a.acked);
    else if (this.fullPipe) cwnd = Math.min(cwnd + a.acked, target);
    else if (cwnd < target || a.delivered < INITIAL_WINDOW) cwnd += a.acked;
    cwnd = Math.max(cwnd, BBR_MIN_CWND);
    if (this.mode === "ProbeRTT") cwnd = Math.min(cwnd, BBR_MIN_CWND);
    this.cwnd = cwnd;
  }

  onCongestion() {
    // Loss does not change BBR v1's model; setCwnd handles recovery on the next ACK.
  }

  onRto(now: number) {
    this.priorCwnd = Math.max(this.priorCwnd, this.cwnd);
    this.cwnd = 1;
    this.fullBw = 0;
    this.fullBwCount = 0;
    this.roundStart = true;
    this.cycleStamp = now;
  }
}
