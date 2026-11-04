/**
 * Extra simulations for the flagship lessons: gradient descent (3D loss surface),
 * RC transients (bucket rule, square-wave input) and the CLT (dice sums, Galton board).
 * Every number that those lessons quote is computed here and pinned in
 * tests/unit/flagshipextras.test.ts.
 */
import { charge, type RcParams } from "./rc";
import { run, type OptimizerConfig, type OptimizerId, type Surface, type Vec2 } from "./optim";
import type { Rng } from "./rng";

// =====================================================================
// Gradient descent
// =====================================================================

/** Largest stable learning rate for gradient descent on a quadratic: η < 2/λ_max. */
export const maxStableLr = (lambdaMax: number) => 2 / lambdaMax;

/** Per-step error factor for one eigen-direction with curvature λ: 1 − ηλ. */
export const gdFactor = (lr: number, lambda: number) => 1 - lr * lambda;

/** Best per-step contraction on a quadratic with condition number κ. */
export function contraction(kappa: number) {
  const r = Math.sqrt(kappa);
  return {
    /** Gradient descent at η = 2/(λmax + λmin). */
    gd: (kappa - 1) / (kappa + 1),
    /** Heavy-ball momentum with tuned η and β. */
    momentum: (r - 1) / (r + 1),
  };
}

/** Steps needed to shrink the error by a factor of 10 at a fixed per-step factor. */
export const stepsPerDecade = (rate: number) => Math.log(10) / -Math.log(Math.abs(rate));

/** Tuned heavy-ball momentum for curvatures in [λmin, λmax]: η = 4/(√λmax + √λmin)², β = ((√κ − 1)/(√κ + 1))². */
export function tunedMomentum(lambdaMin: number, lambdaMax: number) {
  const a = Math.sqrt(lambdaMax), b = Math.sqrt(lambdaMin);
  return { lr: 4 / (a + b) ** 2, beta: ((a - b) / (a + b)) ** 2 };
}

/** First index where |coordinate| exceeds `threshold` (−1 if never). */
export const firstBeyond = (path: readonly Vec2[], coord: 0 | 1, threshold: number) => path.findIndex((p) => Math.abs(p[coord]) > threshold);

/**
 * Mean loss gap that SGD keeps with gradient noise of SD σ per coordinate, on a quadratic
 * with curvatures λ_i: Σ ησ² / (2(2 − ηλ_i)). The "noise floor" grows with η.
 */
export const noiseFloor = (lr: number, lambdas: readonly number[], sigma: number) =>
  lambdas.reduce((s, l) => s + (lr * sigma * sigma) / (2 * (2 - lr * l)), 0);

/** Lowest loss value of a surface (over its known minima). */
export const surfaceMin = (s: Surface) => Math.min(...s.minima.map(([x, y]) => s.f(x, y)));

export interface RunSummary {
  path: Vec2[];
  /** f(θ) − f* at the last point. */
  finalGap: number;
  finalLoss: number;
  /** First step after which the gap stays below `tol`; null if it never does. */
  stepsToConverge: number | null;
  /** True when the run stopped early because the parameters blew up. */
  diverged: boolean;
  /** The minimum closest to the last point. */
  nearest: Vec2;
}

/** Run one optimizer and summarize the result. */
export function summarize(
  s: Surface,
  id: OptimizerId,
  cfg: OptimizerConfig,
  steps: number,
  start: Vec2 = s.start,
  tol = 1e-6,
): RunSummary {
  const path = run(s, id, cfg, steps, start);
  const fmin = surfaceMin(s);
  const diverged = path.length < steps + 1;
  const last = path[path.length - 1]!;
  const finalLoss = s.f(last[0], last[1]);
  let stepsToConverge: number | null = null;
  if (!diverged) {
    for (let k = path.length - 1; k >= 0; k--) {
      const p = path[k]!;
      if (s.f(p[0], p[1]) - fmin >= tol) break;
      stepsToConverge = k;
    }
  }
  let nearest = s.minima[0]!;
  for (const m of s.minima) if (Math.hypot(m[0] - last[0], m[1] - last[1]) < Math.hypot(nearest[0] - last[0], nearest[1] - last[1])) nearest = m;
  return { path, finalGap: finalLoss - fmin, finalLoss, stepsToConverge, diverged, nearest };
}

/**
 * Height used to draw a surface in 3D: log(1 + f − lo) / log(1 + hi − lo), in [0, 1].
 * The log keeps both the deep valley and the high walls visible.
 */
export function heightMap(s: Surface, nx: number, ny: number) {
  const { x: [x0, x1], y: [y0, y1] } = s.domain;
  const raw = new Float64Array(nx * ny);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const v = s.f(x0 + (i / (nx - 1)) * (x1 - x0), y0 + (j / (ny - 1)) * (y1 - y0));
      raw[j * nx + i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  lo = Math.min(lo, surfaceMin(s));
  const den = Math.log1p(hi - lo);
  const height = (f: number) => Math.log1p(Math.max(0, f - lo)) / den;
  const h = new Float64Array(nx * ny);
  for (let k = 0; k < raw.length; k++) h[k] = height(raw[k]!);
  return { h, lo, hi, height };
}

// =====================================================================
// RC transients
// =====================================================================

/** Fraction of Vs reached after `n` time constants (from rc.charge). */
export const chargedAfter = (n: number) => charge({ R: 1, C: 1, Vs: 1 }, n).v;

/**
 * "Bucket" rule with Vs = 1. Each step adds `h` times the remaining gap (h = Δt/τ),
 * or, in "fixed" mode, a fixed amount h (a current source). Returns the level after each step.
 */
export function bucketLevels(h: number, steps: number, mode: "gap" | "fixed" = "gap"): number[] {
  const out = [0];
  let v = 0;
  for (let k = 0; k < steps; k++) {
    v = mode === "gap" ? v + h * (1 - v) : Math.min(1, v + h);
    out.push(v);
  }
  return out;
}

/** Heat in the resistor during a full charge: ∫ i²R dt from 0 to 30τ (midpoint rule). */
export function resistorHeat(p: RcParams, slices = 30_000): number {
  const T = 30 * p.R * p.C;
  const dt = T / slices;
  let e = 0;
  for (let k = 0; k < slices; k++) {
    const i = charge(p, (k + 0.5) * dt).i;
    e += i * i * p.R * dt;
  }
  return e;
}

/** Energy the source delivers during a full charge: Q·Vs = C·Vs². */
export const sourceEnergy = (p: RcParams) => p.C * p.Vs * p.Vs;

/**
 * Steady state of an RC low-pass driven by a 0/1 square wave (50% duty) of period P.
 * r = τ / P. With a = e^{−P/(2τ)}: v_high = 1/(1 + a), v_low = a/(1 + a), ripple = tanh(P/(4τ)).
 */
export function squareSteady(r: number) {
  const a = Math.exp(-1 / (2 * r));
  const vHigh = 1 / (1 + a);
  const vLow = a / (1 + a);
  return { vHigh, vLow, ripple: vHigh - vLow, average: 0.5 };
}

/** Ratio of the square-wave frequency to the RC corner frequency: f / f_c = 2π τ / P. */
export const freqOverCorner = (r: number) => 2 * Math.PI * r;

/** Steady-state output over `periods` periods, `perHalf` samples per half period. Time is in units of P. */
export function squareWave(r: number, periods: number, perHalf = 60) {
  const { vLow } = squareSteady(r);
  const pts: { t: number; vin: number; vout: number }[] = [];
  let v0 = vLow;
  for (let k = 0; k < 2 * periods; k++) {
    const high = k % 2 === 0;
    const target = high ? 1 : 0;
    for (let s = 0; s <= perHalf; s++) {
      if (s === 0 && k > 0) continue;
      const dt = (s / perHalf) * 0.5; // in units of P
      pts.push({ t: k * 0.5 + dt, vin: target, vout: target + (v0 - target) * Math.exp(-dt / r) });
    }
    v0 = target + (v0 - target) * Math.exp(-0.5 / r);
  }
  return pts;
}

// =====================================================================
// Central limit theorem
// =====================================================================

/** Standard normal CDF, Φ(x) (erfc via a rational Chebyshev fit, |err| < 1.2e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? 1 - r / 2 : r / 2;
}

/** Skewness of the mean of n draws from a population with skewness γ. */
export const skewOfMean = (gamma: number, n: number) => gamma / Math.sqrt(n);

/** Skewness of a Bernoulli(p) variable. */
export const bernoulliSkew = (p: number) => (1 - 2 * p) / Math.sqrt(p * (1 - p));

/** Sample size for n·p ≥ target (rule of thumb for Bernoulli means). */
export const bernoulliN = (p: number, target = 10) => Math.ceil(target / p - 1e-9);

/** Standard error ratio when the data grow by a factor k: 1/√k. */
export const seShrink = (k: number) => 1 / Math.sqrt(k);

/** Exponent of n for the fluctuations of a mean with α-stable tails (1 < α < 2): n^{1/α − 1}. */
export const stableExponent = (alpha: number) => 1 / alpha - 1;

/** Variance of a mean of n equally correlated draws, divided by σ²/n: 1 + (n − 1)ρ. */
export const correlatedVarFactor = (n: number, rho: number) => 1 + (n - 1) * rho;

/** Best known Berry–Esseen constant for iid sums (Shevtsova, 2011). */
export const BERRY_ESSEEN_C = 0.4748;

export interface Die { id: string; label: string; probs: number[] }

export const DICE: Die[] = [
  { id: "fair", label: "Fair die", probs: [1, 1, 1, 1, 1, 1].map((x) => x / 6) },
  { id: "loaded", label: "Loaded (mostly 1)", probs: [0.6, 0.15, 0.1, 0.07, 0.05, 0.03] },
  { id: "two", label: "Only 1 or 6", probs: [0.5, 0, 0, 0, 0, 0.5] },
];

export const getDie = (id: string) => DICE.find((d) => d.id === id) ?? DICE[0]!;

/** Convolution of two probability mass functions. */
export function convolve(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j]! += a[i]! * b[j]!;
  return out;
}

/** Exact distribution of the sum of n dice. Index k is the sum n + k (faces are 1..6). */
export function diceSum(probs: readonly number[], n: number): { pmf: number[]; offset: number } {
  let pmf = [...probs];
  for (let k = 1; k < n; k++) pmf = convolve(pmf, probs);
  return { pmf, offset: n };
}

/** Mean, variance, skewness and excess kurtosis of a pmf on the integers offset, offset + 1, … */
export function pmfMoments(pmf: readonly number[], offset = 0) {
  let mu = 0;
  pmf.forEach((p, k) => (mu += p * (k + offset)));
  let m2 = 0, m3 = 0, m4 = 0, abs3 = 0;
  pmf.forEach((p, k) => {
    const d = k + offset - mu;
    m2 += p * d * d;
    m3 += p * d * d * d;
    m4 += p * d ** 4;
    abs3 += p * Math.abs(d) ** 3;
  });
  const sd = Math.sqrt(m2);
  return { mean: mu, variance: m2, sd, skew: m3 / sd ** 3, exKurt: m4 / (m2 * m2) - 3, abs3 };
}

/** sup_x |F(x) − Φ((x − μ)/σ)| for a lattice pmf against the normal with the same mean and SD. */
export function kolmogorovToNormal(pmf: readonly number[], offset = 0): number {
  const { mean, sd } = pmfMoments(pmf, offset);
  let F = 0, worst = 0;
  pmf.forEach((p, k) => {
    const phi = normalCdf((k + offset - mean) / sd);
    worst = Math.max(worst, Math.abs(F - phi)); // just before the jump
    F += p;
    worst = Math.max(worst, Math.abs(F - phi)); // at the jump
  });
  return worst;
}

/** Berry–Esseen bound C·E|X − μ|³ / (σ³ √n) for the sum of n draws of one die. */
export function berryEsseen(probs: readonly number[], n: number): number {
  const m = pmfMoments(probs, 1);
  return (BERRY_ESSEEN_C * m.abs3) / (m.sd ** 3 * Math.sqrt(n));
}

/** Galton board: bin k (0..rows) has probability C(rows, k) p^k (1 − p)^(rows − k). */
export function galtonPmf(rows: number, p: number): number[] {
  return diceSum([1 - p, p], rows).pmf;
}

export const galtonMean = (rows: number, p: number) => rows * p;
export const galtonSd = (rows: number, p: number) => Math.sqrt(rows * p * (1 - p));

/** One ball: a list of `rows` bounces, true = right. Its bin is the count of right bounces. */
export function galtonBall(rows: number, p: number, rng: Rng): boolean[] {
  return Array.from({ length: rows }, () => rng() < p);
}
