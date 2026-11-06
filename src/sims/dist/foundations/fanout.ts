/**
 * Tail latency at fan-out. One request goes to n backends and waits for k of them. Each backend answers after a
 * random latency from the same distribution, independently. The request takes as long as the k-th fastest answer,
 * so P(request <= t) = P(at least k of n backends answer by t).
 *
 * The backend distribution is a MODEL INPUT: a lognormal body (median and sigma) plus a rare stall, as from a garbage
 * collection pause or a queue behind a slow disk: with probability `stallP` the answer takes `stall` ms more.
 */
import { atLeast, bisect, lognormCdf } from "./math";

export interface Backend {
  median: number;
  sigma: number;
  stallP: number;
  stall: number;
}

export const DEFAULT_BACKEND: Backend = { median: 10, sigma: 0.3, stallP: 0.01, stall: 1000 };

/** P(one backend answers within t ms). */
export function backendCdf(t: number, b: Backend): number {
  return (1 - b.stallP) * lognormCdf(t, b.median, b.sigma) + b.stallP * lognormCdf(t - b.stall, b.median, b.sigma);
}

/** P(a request that waits for k of n backends finishes within t ms). */
export const requestCdf = (t: number, n: number, k: number, b: Backend) => atLeast(n, k, backendCdf(t, b));

const HI = 1e6;

/** The q-quantile of one backend. */
export const backendQuantile = (q: number, b: Backend) => bisect((t) => backendCdf(t, b), q, 0, HI);

/** The q-quantile of a request that waits for k of n. */
export const requestQuantile = (q: number, n: number, k: number, b: Backend) => bisect((t) => requestCdf(t, n, k, b), q, 0, HI);

/** The share of requests that wait for at least one stalled backend, when they wait for all n: 1 - (1 - p)^n. */
export const hitsSlow = (n: number, p: number) => 1 - (1 - p) ** n;
