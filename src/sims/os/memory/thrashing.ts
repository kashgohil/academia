/**
 * Thrashing: CPU utilization against the degree of multiprogramming.
 *
 * A closed queueing model, solved exactly with mean value analysis (MVA; Reiser and Lavenberg 1980).
 * N processes share `totalFrames`, so each one has totalFrames / N frames. Each process cycles between three
 * places: the CPU (one queue), the paging device (one queue) and file I/O (a delay, with no queue).
 *
 * The fault rate is not assumed. It comes from an exact LRU run on a locality reference string, so this model
 * and the fault curves in the lesson use the same data.
 *
 * Model inputs (not measurements): the CPU time per reference, the fault service time, the file I/O wait.
 */
import { lruFaultCurve, phaseString } from "./replacement";

export interface MvaResult { throughput: number; cpu: number; paging: number; response: number }

/** Exact MVA for a CPU queue, a paging queue and a delay. Demands are seconds per unit of work. */
export function mva(cpuDemand: number, pagingDemand: number, delay: number, n: number): MvaResult {
  let qc = 0, qp = 0, x = 0, rc = cpuDemand, rp = pagingDemand;
  for (let k = 1; k <= n; k++) {
    rc = cpuDemand * (1 + qc);
    rp = pagingDemand * (1 + qp);
    x = k / (rc + rp + delay);
    qc = x * rc;
    qp = x * rp;
  }
  return { throughput: x, cpu: x * cpuDemand, paging: x * pagingDemand, response: rc + rp };
}

export interface ThrashInput {
  totalFrames: number;
  /** Model input: CPU time per reference in the string, in µs. One reference stands for many instructions. */
  refUs: number;
  /** Model input: time to service one page fault, in µs. */
  faultUs: number;
  /** Model input: file I/O wait per unit of CPU time (2 = the process waits twice as long as it runs). */
  ioRatio: number;
  maxProcs: number;
}

export const THRASH_DEFAULTS: ThrashInput = { totalFrames: 256, refUs: 50, faultUs: 2000, ioRatio: 3, maxProcs: 40 };

/** Locality of the model's processes (pages). */
export const THRASH_LOCALITY = 24;
const THRASH_PHASE = 4000;

let cachedRate: number[] | null = null;
/** Fault rate per reference for m = 0..256 frames, from an exact LRU run. */
export function lruRateByFrames(): number[] {
  if (cachedRate) return cachedRate;
  const refs = phaseString(24000, THRASH_LOCALITY, THRASH_PHASE, 13);
  cachedRate = lruFaultCurve(refs, 256).map((f) => f / refs.length);
  return cachedRate;
}

export interface ThrashPoint { n: number; framesEach: number; faultRate: number; cpu: number; paging: number; loadControlled: number }

export function thrashCurve(o: ThrashInput = THRASH_DEFAULTS): ThrashPoint[] {
  const rate = lruRateByFrames();
  const at = (n: number) => {
    const m = Math.min(rate.length - 1, Math.floor(o.totalFrames / n));
    const f = rate[m]!;
    // Per unit of work (1 second of CPU): 1/refUs references per µs, so f/refUs faults per µs of CPU.
    return { m, f, r: mva(1, (f / o.refUs) * o.faultUs, o.ioRatio, n) };
  };
  // Load control: admit processes only while each one keeps its locality in memory.
  const limit = Math.max(1, Math.floor(o.totalFrames / THRASH_LOCALITY));
  const out: ThrashPoint[] = [];
  for (let n = 1; n <= o.maxProcs; n++) {
    const a = at(n);
    const admitted = at(Math.min(n, limit));
    out.push({ n, framesEach: a.m, faultRate: a.f, cpu: a.r.cpu, paging: a.r.paging, loadControlled: admitted.r.cpu });
  }
  return out;
}

export const thrashPeak = (pts: readonly ThrashPoint[]) => pts.reduce((b, p) => (p.cpu > b.cpu ? p : b), pts[0]!);
