/**
 * CFS bandwidth control, two ways.
 * simulateBandwidth: a tick model of busy threads with a global pool and per-CPU slices, for the timeline.
 * simulateLatency: an event model of a request queue on a fork-join thread pool, for the latency curves.
 * Each period the pool gets `quota` more runtime, up to quota + burst. A CPU takes `slice` from the pool at one go.
 * When a CPU has no local runtime and the pool is empty, the group is throttled on that CPU until the next refill.
 */
import { mulberry32 } from "../../rng";
import { DEFAULT_SLICE_MS } from "./cgroup";

export interface BandwidthSpec { quotaMs: number; periodMs: number; threads: number; horizonMs: number; sliceMs?: number; burstMs?: number; dtMs?: number }
export type ThreadState = "run" | "throttled";
export interface ThreadSeg { start: number; end: number; state: ThreadState }
export interface BandwidthResult {
  rows: ThreadSeg[][];
  /** cpu.stat */
  nrPeriods: number;
  nrThrottled: number;
  throttledMs: number;
  usedMs: number;
  /** CPU time used in each period. */
  perPeriod: number[];
  periodsAt: number[];
}

export function simulateBandwidth(s: BandwidthSpec): BandwidthResult {
  const dt = s.dtMs ?? 0.1;
  const slice = s.sliceMs ?? DEFAULT_SLICE_MS;
  const burst = s.burstMs ?? 0;
  const steps = Math.round(s.horizonMs / dt);
  const stepsPerPeriod = Math.max(1, Math.round(s.periodMs / dt));
  let pool = s.quotaMs;
  const local = new Array<number>(s.threads).fill(0);
  const throttled = new Array<boolean>(s.threads).fill(false);
  const rows: ThreadSeg[][] = Array.from({ length: s.threads }, () => []);
  let nrPeriods = 0, nrThrottled = 0, throttledMs = 0, usedMs = 0;
  const perPeriod: number[] = [0];
  const periodsAt: number[] = [0];
  let throttledThisPeriod = false;

  const extend = (i: number, t: number, st: ThreadState) => {
    const r = rows[i]!;
    const last = r[r.length - 1];
    if (last && last.state === st && Math.abs(last.end - t) < dt / 2) last.end = t + dt;
    else r.push({ start: t, end: t + dt, state: st });
  };

  for (let k = 0; k < steps; k++) {
    const t = k * dt;
    if (k > 0 && k % stepsPerPeriod === 0) {
      nrPeriods++;
      if (throttledThisPeriod) nrThrottled++;
      throttledThisPeriod = false;
      pool = Math.min(pool + s.quotaMs, s.quotaMs + burst);
      throttled.fill(false);
      perPeriod.push(0);
      periodsAt.push(t);
    }
    for (let i = 0; i < s.threads; i++) {
      if (!throttled[i] && local[i]! < dt - 1e-9) {
        const take = Math.min(slice, pool);
        pool -= take;
        local[i] = local[i]! + take;
        if (local[i]! < dt - 1e-9) throttled[i] = true;
      }
      if (throttled[i]) {
        throttledThisPeriod = true;
        throttledMs += dt;
        extend(i, t, "throttled");
      } else {
        local[i] = local[i]! - dt;
        usedMs += dt;
        perPeriod[perPeriod.length - 1] = perPeriod[perPeriod.length - 1]! + dt;
        extend(i, t, "run");
      }
    }
  }
  nrPeriods++;
  if (throttledThisPeriod) nrThrottled++;
  return { rows, nrPeriods, nrThrottled, throttledMs, usedMs, perPeriod, periodsAt };
}

export interface LatencySpec {
  /** null = no limit. */
  quotaMs: number | null;
  periodMs: number;
  /** Threads in the pool. One request runs on all of them at once. */
  threads: number;
  /** CPU time that one request needs, summed over its threads. */
  requestCpuMs: number;
  rps: number;
  burstMs?: number;
  requests?: number;
  seed?: number;
}
export interface LatencyResult {
  p50: number; p99: number; mean: number; max: number;
  /** Mean CPUs used. */
  meanCpus: number;
  /** The fraction of periods in which the pool ran dry while work waited. */
  throttledPeriods: number;
  /** Requests finished. */
  n: number;
}

export const percentile = (sorted: readonly number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;

/**
 * FIFO queue, one request at a time, with a burn rate of `threads` CPU-ms per ms. Poisson arrivals with a seed.
 * This model ignores per-CPU slices, so a stall starts exactly when the pool is empty.
 */
export function simulateLatency(s: LatencySpec): LatencyResult {
  const rng = mulberry32(s.seed ?? 7);
  const n = s.requests ?? 3000;
  const arrivals: number[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) { at += (-Math.log(1 - rng()) * 1000) / s.rps; arrivals.push(at); }
  const lat: number[] = [];
  const burst = s.burstMs ?? 0;
  const q = s.quotaMs;
  let pool = q ?? Infinity;
  let nextRefill = s.periodMs;
  let t = 0;
  let head = 0, remaining = s.requestCpuMs;
  let throttled = 0, used = 0;
  const refill = () => {
    if (q !== null) pool = Math.min(pool + q, q + burst);
    nextRefill += s.periodMs;
  };
  while (head < n) {
    const start = arrivals[head]!;
    if (t < start) {
      // Idle: skip to the next arrival, and refill for every period that passes.
      while (nextRefill <= start) refill();
      t = start;
    }
    if (pool <= 1e-9) {
      // Work waits and the pool is dry: throttled until the next refill.
      throttled++;
      t = nextRefill;
      refill();
      continue;
    }
    const burn = Math.min(remaining, pool, (nextRefill - t) * s.threads);
    t += burn / s.threads;
    remaining -= burn;
    used += burn;
    if (q !== null) pool -= burn;
    if (remaining <= 1e-9) {
      lat.push(t - arrivals[head]!);
      head++;
      remaining = s.requestCpuMs;
    }
    if (t >= nextRefill - 1e-9) refill();
  }
  const sorted = [...lat].sort((a, b) => a - b);
  const totalPeriods = Math.max(1, Math.floor(t / s.periodMs));
  return {
    p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99), max: sorted[sorted.length - 1] ?? 0,
    mean: lat.reduce((a, b) => a + b, 0) / lat.length,
    meanCpus: used / t,
    throttledPeriods: throttled / totalPeriods,
    n: lat.length,
  };
}

/** p99 latency for a list of quotas given in CPUs. */
export function latencySweep(base: Omit<LatencySpec, "quotaMs">, cpus: readonly number[]) {
  return cpus.map((c) => ({ cpus: c, ...simulateLatency({ ...base, quotaMs: c * base.periodMs }) }));
}

/** The workload of the lesson: 25 requests per second, 16 ms of CPU each, so 0.4 CPUs on average. */
export const LATENCY_WORKLOAD = { rps: 25, requestCpuMs: 16, periodMs: 100, requests: 3000, seed: 7 } as const;
