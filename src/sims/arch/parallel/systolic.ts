/**
 * Systolic arrays, cycle by cycle. Each processing element (PE) does one multiply-accumulate per cycle and passes
 * its inputs to its neighbours through registers. No PE reads memory.
 *
 * - Weight stationary (the TPU v1 matrix unit): PE(r, c) holds W[r][c]. Row m of X enters row r at the left edge in
 *   cycle m + r (the skew). Values move right; partial sums move down. Y[m][c] leaves column c at the bottom.
 * - Output stationary: PE(i, j) holds the accumulator of C[i][j]. A[i][k] enters row i in cycle k + i from the left;
 *   B[k][j] enters column j in cycle k + j from the top. Both move one PE per cycle.
 */
import { mulberry32 } from "../../rng";

export type Dataflow = "ws" | "os";

export interface Pe {
  /** Value that passes left to right this cycle, and the index it belongs to (row m for WS, k for OS). */
  a: number | null;
  aTag: number;
  /** WS: partial sum leaving downward. OS: B value passing downward. */
  b: number | null;
  /** WS: the stationary weight. OS: the stationary accumulator. */
  held: number;
  mac: boolean;
}

export interface SysFrame { t: number; pes: Pe[][]; macs: number; outputs: (number | null)[][] }

export interface SysRun {
  flow: Dataflow;
  rows: number;
  cols: number;
  stream: number;
  frames: SysFrame[];
  result: number[][];
  expected: number[][];
  correct: boolean;
  cycles: number;
  macs: number;
  utilization: number;
  /** Input matrices: WS: X (stream × rows) and W (rows × cols). OS: A (rows × stream) and B (stream × cols). */
  left: number[][];
  top: number[][];
}

export const matmul = (a: number[][], b: number[][]) =>
  a.map((row) => b[0]!.map((_, j) => row.reduce((s, v, k) => s + v * b[k]![j]!, 0)));

const smallMatrix = (r: number, c: number, seed: number, lo: number, hi: number) => {
  const rng = mulberry32(seed);
  return Array.from({ length: r }, () => Array.from({ length: c }, () => lo + Math.floor(rng() * (hi - lo + 1))));
};

/** Cycles until the last MAC: stream + rows + cols − 2, for both dataflows. */
export const sysCycles = (stream: number, rows: number, cols: number) => stream + rows + cols - 2;

/** Runs an array of rows × cols PEs on a stream of `stream` vectors. Small integer inputs, so results are easy to check. */
export function runSystolic(flow: Dataflow, rows: number, cols: number, stream: number, seed = 3): SysRun {
  const frames: SysFrame[] = [];
  let macs = 0;
  if (flow === "ws") {
    const X = smallMatrix(stream, rows, seed, 1, 3); // stream × K
    const W = smallMatrix(rows, cols, seed + 1, 0, 2); // K × N
    let aPrev: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
    let pPrev: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
    const Y: (number | null)[][] = Array.from({ length: stream }, () => new Array(cols).fill(null));
    const T = sysCycles(stream, rows, cols);
    for (let t = 0; t < T; t++) {
      const aNow: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
      const pNow: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
      const pes: Pe[][] = [];
      for (let r = 0; r < rows; r++) {
        const row: Pe[] = [];
        for (let c = 0; c < cols; c++) {
          const m = t - r - c;
          const aIn = c === 0 ? (m >= 0 && m < stream ? X[m]![r]! : null) : aPrev[r]![c - 1]!;
          const pIn = r === 0 ? 0 : pPrev[r - 1]![c]!;
          let pOut: number | null = null;
          if (aIn !== null) { pOut = (pIn ?? 0) + aIn * W[r]![c]!; macs++; }
          aNow[r]![c] = aIn; pNow[r]![c] = pOut;
          row.push({ a: aIn, aTag: m, b: pOut, held: W[r]![c]!, mac: aIn !== null });
        }
        pes.push(row);
      }
      for (let c = 0; c < cols; c++) {
        const v = pNow[rows - 1]![c];
        const m = t - (rows - 1) - c;
        if (v !== null && v !== undefined && m >= 0 && m < stream) Y[m]![c] = v;
      }
      aPrev = aNow; pPrev = pNow;
      frames.push({ t, pes, macs, outputs: Y.map((r) => [...r]) });
    }
    const result = Y.map((r) => r.map((v) => v ?? NaN));
    const expected = matmul(X, W);
    const correct = result.every((r, i) => r.every((v, j) => v === expected[i]![j]));
    return { flow, rows, cols, stream, frames, result, expected, correct, cycles: T, macs, utilization: macs / (T * rows * cols), left: X, top: W };
  }
  // output stationary
  const A = smallMatrix(rows, stream, seed, 1, 3); // M × K
  const B = smallMatrix(stream, cols, seed + 1, 0, 2); // K × N
  let aPrev: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
  let bPrev: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
  const acc = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const T = sysCycles(stream, rows, cols);
  for (let t = 0; t < T; t++) {
    const aNow: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
    const bNow: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
    const pes: Pe[][] = [];
    for (let i = 0; i < rows; i++) {
      const row: Pe[] = [];
      for (let j = 0; j < cols; j++) {
        const k = t - i - j;
        const aIn = j === 0 ? (k >= 0 && k < stream ? A[i]![k]! : null) : aPrev[i]![j - 1]!;
        const bIn = i === 0 ? (k >= 0 && k < stream ? B[k]![j]! : null) : bPrev[i - 1]![j]!;
        const mac = aIn !== null && bIn !== null;
        if (mac) { acc[i]![j]! += aIn * bIn; macs++; }
        aNow[i]![j] = aIn; bNow[i]![j] = bIn;
        row.push({ a: aIn, aTag: k, b: bIn, held: acc[i]![j]!, mac });
      }
      pes.push(row);
    }
    aPrev = aNow; bPrev = bNow;
    frames.push({ t, pes, macs, outputs: acc.map((r) => [...r]) });
  }
  const expected = matmul(A, B);
  const correct = acc.every((r, i) => r.every((v, j) => v === expected[i]![j]));
  return { flow, rows, cols, stream, frames, result: acc, expected, correct, cycles: T, macs, utilization: macs / (T * rows * cols), left: A, top: B };
}

// ---------------------------------------------------------------- TPU v1 utilization

/** Facts from Jouppi et al., ISCA 2017: a 256×256 array of 8-bit MACs at 700 MHz; weights come from DRAM at 34 GB/s. */
export const TPU1 = { size: 256, clockHz: 700e6, weightBw: 34e9 } as const;

export const TPU1_PEAK_TOPS = (TPU1.size * TPU1.size * 2 * TPU1.clockHz) / 1e12;

/** Cycles to load one 256×256 tile of 8-bit weights from DRAM. */
export const TPU1_TILE_LOAD = (TPU1.size * TPU1.size) / (TPU1.weightBw / TPU1.clockHz);

export interface TpuLayer {
  tiles: number;
  tk: number;
  tn: number;
  /** Fraction of the PEs that hold a real weight (partial tiles are padded). */
  spatial: number;
  /** Cycles per tile: the larger of the batch (one row per cycle) and the weight load (double buffered). */
  perTile: number;
  cycles: number;
  utilization: number;
  /** Useful TOPS at 700 MHz. */
  tops: number;
  bound: "weights" | "compute";
}

/**
 * MODEL of one layer Y (M×N) = X (M×K) × W (K×N) on the TPU v1 matrix unit. Every tile's weights are loaded once;
 * the next tile loads while the current one computes; fill and drain (2·256 − 2 cycles) are paid once.
 */
export function tpuLayer(M: number, K: number, N: number): TpuLayer {
  const S = TPU1.size;
  const tk = Math.ceil(K / S), tn = Math.ceil(N / S);
  const tiles = tk * tn;
  const spatial = (K * N) / (tiles * S * S);
  const perTile = Math.max(M, TPU1_TILE_LOAD);
  const cycles = TPU1_TILE_LOAD + tiles * perTile + 2 * S - 2;
  const utilization = (M * K * N) / (cycles * S * S);
  return { tiles, tk, tn, spatial, perTile, cycles, utilization, tops: utilization * TPU1_PEAK_TOPS, bound: M < TPU1_TILE_LOAD ? "weights" : "compute" };
}
