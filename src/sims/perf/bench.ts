/**
 * A noisy micro-benchmark, with the classic pitfalls as switches.
 * One "sample" times a batch of iterations with a coarse clock and reports time per iteration.
 */
import { mulberry32, normal } from "../rng";

export interface BenchConfig {
  trueNs: number;
  /** Clock tick (e.g. 1000 ns for a 1 µs timer). */
  timerResNs: number;
  /** Iterations timed together per sample. */
  batch: number;
  samples: number;
  /** Extra time on early iterations: cold caches, page faults, JIT/tiering. */
  coldNs: number;
  /** Discard the first 20% of samples. */
  warmup: boolean;
  /** The compiler can see the result is unused and deletes the work. */
  deadCode: boolean;
  /** Result passed through black_box / DoNotOptimize. */
  blackBox: boolean;
  /** Per-iteration jitter, as a fraction of trueNs. */
  jitter: number;
  /** Probability that a sample is hit by an interrupt / context switch. */
  outlierProb: number;
  outlierNs: number;
  /** Turbo then thermal throttling: later samples run up to 25% slower. */
  throttle: boolean;
}

export const BENCH_DEFAULTS: BenchConfig = {
  trueNs: 40, timerResNs: 1000, batch: 1, samples: 200, coldNs: 40, warmup: false,
  deadCode: true, blackBox: false, jitter: 0.05, outlierProb: 0.03, outlierNs: 20000, throttle: false,
};

export function runBench(cfg: BenchConfig, seed = 1): number[] {
  const r = mulberry32(seed);
  const perIter = cfg.deadCode && !cfg.blackBox ? 0.3 : cfg.trueNs; // 0.3 ns: loop overhead only
  const out: number[] = [];
  for (let s = 0; s < cfg.samples; s++) {
    const slow = cfg.throttle ? 1 + 0.25 * Math.min(1, Math.max(0, (s / cfg.samples - 0.3) / 0.4)) : 1;
    let total = 0;
    for (let b = 0; b < cfg.batch; b++) {
      // Warm-up decays with wall time (samples), like JIT tiering and caches filling.
      total += Math.max(0, perIter * slow * (1 + cfg.jitter * normal(r))) + cfg.coldNs * Math.exp(-s / 12);
    }
    if (r() < cfg.outlierProb) total += cfg.outlierNs * (0.5 + r());
    // The clock only advances in whole ticks: the reading is the number of tick edges crossed.
    const phase = r() * cfg.timerResNs;
    const measured = Math.floor((phase + total) / cfg.timerResNs) * cfg.timerResNs;
    out.push(measured / cfg.batch);
  }
  return cfg.warmup ? out.slice(Math.floor(cfg.samples * 0.2)) : out;
}

export function summarize(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { mean, median: q(0.5), min: s[0]!, p10: q(0.1), p90: q(0.9), max: s[s.length - 1]! };
}

// ---------------- comparing two versions ----------------

/** Right-skewed timing noise: lognormal body plus rare large outliers. */
export function timings(trueNs: number, n: number, r: () => number, sigma = 0.08, outlierProb = 0.04): number[] {
  return Array.from({ length: n }, () => trueNs * Math.exp(sigma * normal(r)) * (r() < outlierProb ? 1.5 + 2 * r() : 1));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
export { median };

/** Bootstrap 95% CI of median(B) / median(A). */
export function bootstrapRatio(a: number[], b: number[], r: () => number, reps = 400): [number, number, number] {
  const pick = (xs: number[]) => Array.from({ length: xs.length }, () => xs[Math.floor(r() * xs.length)]!);
  const ratios = Array.from({ length: reps }, () => median(pick(b)) / median(pick(a))).sort((x, y) => x - y);
  return [ratios[Math.floor(reps * 0.025)]!, median(b) / median(a), ratios[Math.floor(reps * 0.975)]!];
}

/** Over many repeated experiments: how often the CI says "B is faster" (CI entirely below 1). */
export function detectionRate(speedup: number, n: number, experiments: number, seed = 1, sigma = 0.08): number {
  const r = mulberry32(seed);
  let hits = 0;
  for (let e = 0; e < experiments; e++) {
    const a = timings(100, n, r, sigma), b = timings(100 * (1 - speedup), n, r, sigma);
    if (bootstrapRatio(a, b, r, 200)[2] < 1) hits++;
  }
  return hits / experiments;
}
