import { type Rng, normal } from "./rng";

export interface Dist {
  id: string;
  label: string;
  sample: (rng: Rng) => number;
  /** Population mean and variance; Infinity/NaN when they don't exist. */
  mu: number;
  sigma2: number;
  /** Range used when plotting the raw distribution. */
  view: [number, number];
}

export const DISTS: Dist[] = [
  { id: "uniform", label: "Uniform(0, 1)", sample: (r) => r(), mu: 0.5, sigma2: 1 / 12, view: [0, 1] },
  { id: "exponential", label: "Exponential(1)", sample: (r) => -Math.log(1 - r()), mu: 1, sigma2: 1, view: [0, 6] },
  { id: "bernoulli", label: "Bernoulli(0.1)", sample: (r) => (r() < 0.1 ? 1 : 0), mu: 0.1, sigma2: 0.09, view: [-0.25, 1.25] },
  {
    id: "bimodal",
    label: "Bimodal mixture",
    sample: (r) => (r() < 0.5 ? -2 : 2) + 0.5 * normal(r),
    mu: 0,
    sigma2: 4 + 0.25,
    view: [-4, 4],
  },
  {
    // Pareto with α = 1.5: finite mean, infinite variance. CLT in its classic form does not apply.
    id: "pareto",
    label: "Pareto(α = 1.5)",
    sample: (r) => Math.pow(1 - r(), -1 / 1.5),
    mu: 3,
    sigma2: Infinity,
    view: [1, 10],
  },
  {
    // Cauchy: no mean at all. The sample mean is itself Cauchy for every n.
    id: "cauchy",
    label: "Cauchy",
    sample: (r) => Math.tan(Math.PI * (r() - 0.5)),
    mu: NaN,
    sigma2: NaN,
    view: [-8, 8],
  },
];

export function getDist(id: string): Dist {
  return DISTS.find((d) => d.id === id) ?? DISTS[0]!;
}

/** Draw `count` sample means, each over `n` iid draws. */
export function sampleMeans(d: Dist, n: number, count: number, rng: Rng): Float64Array {
  const out = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d.sample(rng);
    out[k] = s / n;
  }
  return out;
}

/** Standardize: z = (x̄ - μ) / (σ/√n). Returns null when σ is undefined. */
export function standardize(means: Float64Array, d: Dist, n: number): Float64Array | null {
  if (!Number.isFinite(d.sigma2) || !Number.isFinite(d.mu)) return null;
  const se = Math.sqrt(d.sigma2 / n);
  return means.map((m) => (m - d.mu) / se);
}
