/**
 * Probabilistically bounded staleness (PBS, Bailis et al., VLDB 2012) for partial quorums, by Monte Carlo.
 *
 * The WARS model: a write is sent to all N replicas (W: the delay to each replica), and each replica acknowledges
 * (A). The write returns after W acknowledgements. A read starts t ms later, is sent to all N replicas (R), and each
 * replica responds (S). The read returns after the first R responses. It is consistent if one of those replicas had
 * the write when the read request arrived.
 *
 * The delays are model inputs, not measurements: each one-way delay is base + an exponential with the given mean.
 */
import { mulberry32, type Rng } from "../../rng";

export interface PbsConfig {
  n: number;
  r: number;
  w: number;
  /** Mean of the exponential part of each one-way delay (ms). */
  mean: number;
  /** Extra fixed one-way delay per replica (ms), e.g. [0.5, 20, 20] for one local and two remote replicas. */
  base?: number[];
  /** The same for the writer, if it sits elsewhere (default: `base`). */
  writeBase?: number[];
  /** Extra mean delay before a replica applies a write (ms), for slow disks. */
  writeExtra?: number;
  trials: number;
  seed: number;
}

const exp = (rng: Rng, mean: number) => -Math.log(1 - rng()) * mean;

/** P(consistent read) at each t in `ts` (ms after the write returns). */
export function pbsCurve(c: PbsConfig, ts: number[]): number[] {
  const rng = mulberry32(c.seed);
  const base = c.base ?? new Array<number>(c.n).fill(0);
  const wbase = c.writeBase ?? base;
  const ok = new Array<number>(ts.length).fill(0);
  const arrive = new Array<number>(c.n), ack = new Array<number>(c.n), req = new Array<number>(c.n), resp = new Array<number>(c.n);
  const idx = [...Array(c.n).keys()];
  for (let k = 0; k < c.trials; k++) {
    for (let i = 0; i < c.n; i++) {
      arrive[i] = wbase[i]! + exp(rng, c.mean) + (c.writeExtra ? exp(rng, c.writeExtra) : 0);
      ack[i] = arrive[i]! + wbase[i]! + exp(rng, c.mean);
      req[i] = base[i]! + exp(rng, c.mean);
      resp[i] = req[i]! + base[i]! + exp(rng, c.mean);
    }
    const commit = [...ack].sort((a, b) => a - b)[c.w - 1]!;
    const first = idx.slice().sort((a, b) => resp[a]! - resp[b]!).slice(0, c.r);
    ts.forEach((t, j) => {
      const start = commit + t;
      if (first.some((i) => arrive[i]! <= start + req[i]!)) ok[j]!++;
    });
  }
  return ok.map((x) => x / c.trials);
}

/** Binomial coefficient. */
export const choose = (n: number, k: number) => {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

/**
 * The PBS closed form for a read that starts at once, if only the W replicas that acknowledged hold the write and
 * the read quorum is a uniform random set of R replicas: P(stale) = C(N−W, R) / C(N, R). Zero when R + W > N.
 */
export const staleClosedForm = (n: number, r: number, w: number) => choose(n - w, r) / choose(n, r);

/** Quantiles of the time to hear from the fastest k of n replicas (a round trip each), by Monte Carlo. */
export function quorumLatency(n: number, k: number, mean: number, base: number[] | undefined, trials: number, seed: number): { p50: number; p99: number } {
  const rng = mulberry32(seed);
  const b = base ?? new Array<number>(n).fill(0);
  const xs: number[] = [];
  for (let t = 0; t < trials; t++) {
    const rtt = b.map((x) => 2 * x + exp(rng, mean) + exp(rng, mean)).sort((p, q) => p - q);
    xs.push(rtt[k - 1]!);
  }
  xs.sort((p, q) => p - q);
  return { p50: xs[Math.floor(0.5 * (trials - 1))]!, p99: xs[Math.floor(0.99 * (trials - 1))]! };
}
