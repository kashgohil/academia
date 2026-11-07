/**
 * The scenarios behind the demos, in one place, so that the lessons, the demos and the tests use the same numbers.
 * Every rate, RTT, buffer and duration here is a model input.
 */
import type { CcKind, FlowSpec, Scenario } from "./run";
import { bdpPackets } from "./run";

// ---------------------------------------------------------------- Reno and CUBIC

/** One flow, the cwnd sawtooth and the queue. */
export const SAW = { mbps: 10, rttMs: 40, durationMs: 30_000, warmupMs: 5_000, sampleMs: 20 } as const;
export const sawScenario = (cc: CcKind, bufferBdp: number): Scenario => ({
  ...SAW, queue: Math.max(1, Math.round(bufferBdp * bdpPackets(SAW.mbps, SAW.rttMs))), flows: [{ cc }],
});

/** Buffer sizing: n Reno flows with RTTs spread over 30–90 ms (mean 60 ms). One flow has the mean RTT. */
export const BUF = { mbps: 100, rttLo: 30, rttHi: 90, rttMean: 60, durationMs: 20_000, warmupMs: 5_000, sampleMs: 50 } as const;
export const BUF_FLOWS = [1, 4, 32];
export const bufferScenario = (n: number, bufferBdp: number): Scenario => {
  const bdp = bdpPackets(BUF.mbps, BUF.rttMean);
  const flows: FlowSpec[] = Array.from({ length: n }, (_, i) => ({
    cc: "reno", rttMs: n === 1 ? BUF.rttMean : BUF.rttLo + (i * (BUF.rttHi - BUF.rttLo)) / (n - 1), start: i * 97,
  }));
  return { mbps: BUF.mbps, rttMs: n === 1 ? BUF.rttMean : BUF.rttLo, queue: Math.max(1, Math.round(bufferBdp * bdp)), flows, durationMs: BUF.durationMs, warmupMs: BUF.warmupMs, sampleMs: BUF.sampleMs, jitterMs: 2 };
};

/** Two flows; the second has `ratio` times the RTT and starts 2 s later. The buffer is one BDP of the short flow. */
export const FAIR = { mbps: 10, rttMs: 20, durationMs: 40_000, warmupMs: 10_000, sampleMs: 100, start2: 2_000 } as const;
export const fairScenario = (cc: CcKind, ratio: number): Scenario => ({
  mbps: FAIR.mbps, rttMs: FAIR.rttMs, queue: Math.round(bdpPackets(FAIR.mbps, FAIR.rttMs)),
  flows: [{ cc }, { cc, rttMs: FAIR.rttMs * ratio, start: FAIR.start2 }],
  durationMs: FAIR.durationMs, warmupMs: FAIR.warmupMs, sampleMs: FAIR.sampleMs, jitterMs: 1,
});

/** Throughput against random loss: a fast link, so that loss and not the link limits the flow. */
export const LOSS = { mbps: 100, queue: 1000, durationMs: 30_000, warmupMs: 5_000 } as const;
export const LOSS_RATES = [1e-4, 3e-4, 1e-3, 3e-3, 1e-2, 3e-2];
export const lossScenario = (cc: CcKind, p: number, rttMs: number): Scenario => ({
  mbps: LOSS.mbps, rttMs, queue: LOSS.queue, flows: [{ cc }], durationMs: LOSS.durationMs, warmupMs: LOSS.warmupMs, loss: p, seed: 3, sampleMs: 1000,
});

// ---------------------------------------------------------------- BBR

/** Fixed windows on one path: the operating points of the BBR paper's figure. */
export const OP = { mbps: 10, rttMs: 40 } as const;

export type BbrEvent = "none" | "rate-down" | "rate-up" | "rtt-up";
export const BBR_EVENT_AT = 8_000;
export const BBR_LINE = { mbps: 10, rttMs: 40, durationMs: 25_000, sampleMs: 20 } as const;
export const bbrTimelineScenario = (ev: BbrEvent): Scenario => ({
  ...BBR_LINE, queue: Math.round(2 * bdpPackets(BBR_LINE.mbps, BBR_LINE.rttMs)), flows: [{ cc: "bbr" }],
  rateChanges: ev === "rate-down" ? [[BBR_EVENT_AT, 5]] : ev === "rate-up" ? [[BBR_EVENT_AT, 20]] : undefined,
  rttChanges: ev === "rtt-up" ? [[BBR_EVENT_AT, 120]] : undefined,
});

/** One BBR flow and one CUBIC flow, the same RTT, a buffer of `bufferBdp` BDPs. */
export const VS = { mbps: 10, rttMs: 40, durationMs: 40_000, warmupMs: 10_000, sampleMs: 100 } as const;
export const vsScenario = (bufferBdp: number, a: CcKind = "bbr", b: CcKind = "cubic"): Scenario => ({
  mbps: VS.mbps, rttMs: VS.rttMs, queue: Math.max(2, Math.round(bufferBdp * bdpPackets(VS.mbps, VS.rttMs))),
  flows: [{ cc: a }, { cc: b, start: 500 }], durationMs: VS.durationMs, warmupMs: VS.warmupMs, sampleMs: VS.sampleMs, jitterMs: 1,
});

/** Random loss with a one-BDP buffer: BBR against CUBIC. */
export const BBR_LOSS = { mbps: 20, rttMs: 40, durationMs: 20_000, warmupMs: 5_000 } as const;
export const BBR_LOSS_RATES = [0, 1e-3, 1e-2, 2e-2, 5e-2, 0.1, 0.2];
export const bbrLossScenario = (cc: CcKind, p: number): Scenario => ({
  mbps: BBR_LOSS.mbps, rttMs: BBR_LOSS.rttMs, queue: Math.round(bdpPackets(BBR_LOSS.mbps, BBR_LOSS.rttMs)), flows: [{ cc }],
  durationMs: BBR_LOSS.durationMs, warmupMs: BBR_LOSS.warmupMs, loss: p, seed: 5, sampleMs: 1000,
});
