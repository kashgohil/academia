/**
 * Congestion collapse in miniature. n senders share one link. Model inputs: 2 Mbit/s, a base RTT of 100 ms, a deep
 * queue of 200 packets (1.2 s), 30 s runs.
 *
 * - "1986": each sender keeps a fixed window of 8 packets in flight, uses a fixed 300 ms retransmission timer,
 *   and on a timeout sends the whole window again (go-back-N), with no backoff. The model fixes the timer to make
 *   the mechanism plain: the timer does not follow the queueing delay, so packets that are only late are sent again.
 * - "1988": the same senders with Jacobson's changes, here as Reno: slow start, AIMD, an RTO from the RTT mean and
 *   variance (RFC 6298) with exponential backoff, and fast retransmit.
 *
 * Goodput counts only new packets that reach a receiver. A link can be 100% busy and still carry little goodput.
 */
import { runScenario, type FlowSpec, type RunResult } from "./run";

export const COLLAPSE = { mbps: 2, rttMs: 100, queue: 200, window: 8, timerMs: 300, durationMs: 30_000, warmupMs: 5_000 } as const;
export const COLLAPSE_SENDERS = [1, 2, 4, 6, 8, 12, 16, 24, 32];

export type CollapseMode = "1986" | "1988";

export interface CollapsePoint {
  n: number;
  mode: CollapseMode;
  /** Fraction of time the link sends. */
  busy: number;
  /** New data delivered, as a fraction of the link rate. */
  goodput: number;
  /** Packets sent per new packet delivered. */
  copies: number;
  meanQueueMs: number;
  timeouts: number;
}

export function collapseRun(n: number, mode: CollapseMode): CollapsePoint {
  const flows: FlowSpec[] = Array.from({ length: n }, (_, i) =>
    mode === "1986" ? { cc: { fixed: COLLAPSE.window }, legacy: true, fixedRtoMs: COLLAPSE.timerMs, start: i * 37 } : { cc: "reno", start: i * 37 });
  const r: RunResult = runScenario({
    mbps: COLLAPSE.mbps, rttMs: COLLAPSE.rttMs, queue: COLLAPSE.queue, flows, durationMs: COLLAPSE.durationMs,
    warmupMs: COLLAPSE.warmupMs, jitterMs: 1, sampleMs: 100,
  });
  const sent = r.flows.reduce((a, f) => a + f.sent, 0), got = r.flows.reduce((a, f) => a + f.delivered, 0);
  return {
    n, mode, busy: r.utilisation, goodput: r.goodputFrac, copies: got ? sent / got : 0, meanQueueMs: r.meanQueueMs,
    timeouts: r.flows.reduce((a, f) => a + f.timeouts, 0),
  };
}
