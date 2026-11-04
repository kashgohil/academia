/**
 * How estimation errors grow through joins.
 *
 * A query with j joins has j + 1 base-table estimates and j join-selectivity estimates. If each
 * estimate is off by a random factor e_i (log-normal: ln e_i ~ N(bias, sigma²)), the estimate of
 * the final result is off by the product of all 2j + 1 factors, so ln(error) ~ N((2j+1)·bias,
 * (2j+1)·sigma²). The demo draws samples; the closed form gives the median.
 */
import { mulberry32, normal } from "../../rng";

export interface ErrSetup { sigma: number; bias: number; samples?: number; seed?: number }

/** Signed ln(est/true) samples for a query with `joins` joins. */
export function errorSamples(joins: number, s: ErrSetup): Float64Array {
  const rng = mulberry32((s.seed ?? 1) * 1000 + joins);
  const n = s.samples ?? 2000, k = 2 * joins + 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (let j = 0; j < k; j++) x += s.bias + s.sigma * normal(rng);
    out[i] = x;
  }
  return out;
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

/** q-error quantiles and the share of under-estimates for 0..maxJoins joins. */
export function qErrorCurve(maxJoins: number, s: ErrSetup) {
  const rows = [];
  for (let j = 0; j <= maxJoins; j++) {
    const x = errorSamples(j, s);
    const q = Array.from(x, (v) => Math.exp(Math.abs(v))).sort((a, b) => a - b);
    let under = 0;
    for (const v of x) if (v < 0) under++;
    rows.push({ joins: j, median: quantile(q, 0.5), p90: quantile(q, 0.9), p99: quantile(q, 0.99), under: under / x.length });
  }
  return rows;
}

/** Deterministic worst case: every one of the 2j + 1 estimates is off by the factor q in the same direction. */
export const worstCaseQ = (q: number, joins: number) => Math.pow(q, 2 * joins + 1);
