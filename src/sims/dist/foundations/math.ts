/** Small numeric helpers for the Foundations sims: binomials, the normal and lognormal distributions, and bisection. */

/** C(n, k) as a float. Exact for the small n that the demos use. */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** P(at least k successes in n independent trials with success probability p). */
export function atLeast(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // Sum the terms in log space, O(n), so that p^n does not underflow for large n.
  const lp = Math.log(p), lq = Math.log1p(-p);
  let lc = 0; // log C(n, j)
  let s = 0;
  for (let j = 0; j <= n; j++) {
    if (j > 0) lc += Math.log((n - j + 1) / j);
    if (j >= k) s += Math.exp(lc + j * lp + (n - j) * lq);
  }
  return Math.min(1, s);
}

/**
 * erfc(x) for x >= 0 from Numerical Recipes (Chebyshev fit, relative error below 1.2e-7 everywhere).
 * It stays accurate far into the tail, which the phi detector needs.
 */
function erfcPos(x: number): number {
  const t = 1 / (1 + 0.5 * x);
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return y;
}

/** ln(erfc(x)) for x >= 0. It does not underflow, because the exponent is added in log space. */
function logErfcPos(x: number): number {
  const t = 1 / (1 + 0.5 * x);
  return Math.log(t) - x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
}

export const erfc = (x: number) => (x >= 0 ? erfcPos(x) : 2 - erfcPos(-x));
export const erf = (x: number) => 1 - erfc(x);

/** Standard normal CDF. */
export const normCdf = (z: number) => 0.5 * erfc(-z / Math.SQRT2);

/** log10 of the upper tail P(Z > z) of a standard normal. Finite for every z. */
export function log10NormTail(z: number): number {
  if (z <= 0) return Math.log10(1 - normCdf(z));
  return (Math.log(0.5) + logErfcPos(z / Math.SQRT2)) / Math.LN10;
}

/** CDF of a lognormal with the given median and shape sigma (the sigma of ln X). */
export const lognormCdf = (x: number, median: number, sigma: number) => (x <= 0 ? 0 : normCdf(Math.log(x / median) / sigma));

/** The smallest x in [lo, hi] with f(x) >= target, for a nondecreasing f. */
export function bisect(f: (x: number) => number, target: number, lo: number, hi: number, iters = 80): number {
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The q-quantile of a sample (nearest rank). */
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

export const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}
