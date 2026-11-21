/**
 * Tensor cores: operand reuse of a matrix multiply-accumulate (MMA), number formats and accumulation error, peak
 * throughput from published unit counts, and the roofline of a GEMM against batch size.
 */
import { mulberry32 } from "../../rng";

// ---------------------------------------------------------------- operand reuse

export interface Shape { m: number; n: number; k: number }

export interface Reuse {
  macs: number;
  /** Values read from registers: A (m×k), B (k×n) and the accumulator C (m×n). */
  reads: number;
  /** Values written: D (m×n). */
  writes: number;
  readsPerMac: number;
  macsPerRead: number;
}

/** D = A×B + C on one m×n×k tile. Each input value is read once from registers. */
export function reuse({ m, n, k }: Shape): Reuse {
  const macs = m * n * k;
  const reads = m * k + k * n + m * n;
  return { macs, reads, writes: m * n, readsPerMac: reads / macs, macsPerRead: macs / reads };
}

/** A vector FMA of L lanes reads three full vectors (a, b and c) for L multiply-adds. */
export function fmaReuse(lanes: number): Reuse {
  const macs = lanes, reads = 3 * lanes;
  return { macs, reads, writes: lanes, readsPerMac: 3, macsPerRead: 1 / 3 };
}

// ---------------------------------------------------------------- number formats

export interface Format { id: string; label: string; exp: number; man: number; /** Largest finite value. */ max: number; inf: boolean }

const ieeeMax = (exp: number, man: number) => (2 - 2 ** -man) * 2 ** (2 ** (exp - 1) - 1);

export const FORMATS: Record<string, Format> = {
  fp32: { id: "fp32", label: "FP32", exp: 8, man: 23, max: ieeeMax(8, 23), inf: true },
  tf32: { id: "tf32", label: "TF32", exp: 8, man: 10, max: ieeeMax(8, 10), inf: true },
  fp16: { id: "fp16", label: "FP16", exp: 5, man: 10, max: ieeeMax(5, 10), inf: true },
  bf16: { id: "bf16", label: "BF16", exp: 8, man: 7, max: ieeeMax(8, 7), inf: true },
  // FP8 E4M3 has no infinity; its largest value is 448 (1.75 × 2⁸). E5M2 follows IEEE rules: 57344.
  e4m3: { id: "e4m3", label: "FP8 E4M3", exp: 4, man: 3, max: 448, inf: false },
  e5m2: { id: "e5m2", label: "FP8 E5M2", exp: 5, man: 2, max: ieeeMax(5, 2), inf: true },
};

/** Rounds x to the nearest value of the format (ties to even), with subnormals. Overflow gives ±Infinity, or ±max for E4M3 (saturating). */
export function roundTo(x: number, f: Format): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const bias = 2 ** (f.exp - 1) - 1;
  const emin = 1 - bias;
  let e = Math.floor(Math.log2(a));
  if (2 ** e > a) e--;
  if (2 ** (e + 1) <= a) e++;
  e = Math.max(e, emin);
  const ulp = 2 ** (e - f.man);
  const q = a / ulp;
  const fl = Math.floor(q);
  const d = q - fl;
  const r = (d > 0.5 || (d === 0.5 && fl % 2 === 1) ? fl + 1 : fl) * ulp;
  if (r > f.max) return f.inf ? sign * Infinity : sign * f.max;
  return sign * r;
}

/** Spacing between neighbouring values at x (one unit in the last place). */
export function ulpAt(x: number, f: Format): number {
  const bias = 2 ** (f.exp - 1) - 1;
  const e = Math.max(Math.floor(Math.log2(Math.abs(x))), 1 - bias);
  return 2 ** (e - f.man);
}

export interface DotRun { exact: number; got: number; relErr: number }

/**
 * A dot product of K pairs, as a tensor core does it: inputs rounded to FP16, products exact (an FP16 × FP16
 * product fits in FP32), and a running sum rounded to the accumulator format after every add.
 * Inputs are uniform in [0, 1), from a fixed seed.
 */
export function dotAccumulate(K: number, acc: Format, seed = 7): DotRun {
  const rng = mulberry32(seed);
  const f16 = FORMATS.fp16!;
  let exact = 0, s = 0;
  for (let i = 0; i < K; i++) {
    const p = roundTo(rng(), f16) * roundTo(rng(), f16);
    exact += p;
    s = acc.id === "fp32" ? Math.fround(s + p) : roundTo(s + p, acc);
  }
  return { exact, got: s, relErr: Math.abs(s - exact) / exact };
}

/** The same experiment for many K at once: the runs share one input stream, so one pass gives every prefix. */
export function dotSweep(Ks: number[], acc: Format, seed = 7): DotRun[] {
  const rng = mulberry32(seed);
  const f16 = FORMATS.fp16!;
  const want = [...Ks].sort((a, b) => a - b);
  const out = new Map<number, DotRun>();
  let exact = 0, s = 0, j = 0;
  for (let i = 1; j < want.length; i++) {
    const p = roundTo(rng(), f16) * roundTo(rng(), f16);
    exact += p;
    s = acc.id === "fp32" ? Math.fround(s + p) : roundTo(s + p, acc);
    while (j < want.length && want[j] === i) { out.set(i, { exact, got: s, relErr: Math.abs(s - exact) / exact }); j++; }
  }
  return Ks.map((k) => out.get(k)!);
}

/** K values for the accumulation sweep: 16 … 16,384 in half-octaves. */
export const DOT_KS = Array.from({ length: 21 }, (_, i) => Math.round(16 * 2 ** (i / 2)));

// ---------------------------------------------------------------- peak throughput

export interface Gpu {
  name: string;
  sms: number;
  tcPerSm: number;
  /** Dense FP16 multiply-adds per tensor core per clock. */
  fmaPerTc: number;
  /** Boost clock, GHz. */
  clock: number;
  /** DRAM bandwidth, GB/s. */
  bandwidth: number;
}

/** From the NVIDIA V100 and A100 whitepapers (see the lesson for sources). */
export const GPUS: Gpu[] = [
  { name: "V100 (SXM2)", sms: 80, tcPerSm: 8, fmaPerTc: 64, clock: 1.53, bandwidth: 900 },
  { name: "A100 (SXM4, 40 GB)", sms: 108, tcPerSm: 4, fmaPerTc: 256, clock: 1.41, bandwidth: 1555 },
];

/** Peak dense FP16 tensor TFLOP/s: SMs × tensor cores per SM × FMAs per clock × 2 × clock. */
export const peakTflops = (g: Gpu) => (g.sms * g.tcPerSm * g.fmaPerTc * 2 * g.clock) / 1000;

// ---------------------------------------------------------------- GEMM roofline

export interface GemmPoint { flops: number; bytes: number; ai: number; tflops: number; frac: number; bound: "memory" | "compute"; seconds: number }

/**
 * C (M×N) = A (M×K) × B (K×N) with `bytes` per element. Ideal reuse: each matrix crosses DRAM once.
 * Attainable = min(peak, AI × bandwidth).
 */
export function gemmPoint(g: Gpu, M: number, N: number, K: number, bytes = 2): GemmPoint {
  const flops = 2 * M * N * K;
  const traffic = bytes * (M * K + K * N + M * N);
  const ai = flops / traffic;
  const peak = peakTflops(g);
  const mem = (ai * g.bandwidth) / 1000;
  const tflops = Math.min(peak, mem);
  return { flops, bytes: traffic, ai, tflops, frac: tflops / peak, bound: mem < peak ? "memory" : "compute", seconds: flops / (tflops * 1e12) };
}

/** AI where the GEMM meets the ridge: peak / bandwidth, in FLOP per byte. */
export const gpuRidge = (g: Gpu) => (peakTflops(g) * 1000) / g.bandwidth;

/** Smallest batch N (for an M×K weight matrix) that makes the GEMM compute bound. */
export function batchToRidge(g: Gpu, M: number, K: number, bytes = 2): number {
  let n = 1;
  while (gemmPoint(g, M, n, K, bytes).bound === "memory" && n < 1 << 20) n++;
  return n;
}

// ---------------------------------------------------------------- tiling

export interface Tiling { tiles: number; tm: number; tn: number; tk: number; usefulMacs: number; doneMacs: number; utilization: number }

/** Covers an M×N×K GEMM with m×n×k MMA tiles. Partial tiles are padded with zeros: their extra MACs are waste. */
export function tileGemm(M: number, N: number, K: number, s: Shape): Tiling {
  const tm = Math.ceil(M / s.m), tn = Math.ceil(N / s.n), tk = Math.ceil(K / s.k);
  const tiles = tm * tn * tk;
  const usefulMacs = M * N * K, doneMacs = tiles * s.m * s.n * s.k;
  return { tiles, tm, tn, tk, usefulMacs, doneMacs, utilization: usefulMacs / doneMacs };
}
