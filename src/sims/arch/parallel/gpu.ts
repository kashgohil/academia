/**
 * GPU architecture: occupancy from the per-SM limits of one named GPU, latency hiding by warp switching, memory
 * coalescing into 32-byte sectors, and shared-memory bank conflicts.
 */

// ---------------------------------------------------------------- occupancy

/** Per-SM limits. Values from the CUDA C++ Programming Guide, "Technical Specifications per Compute Capability". */
export interface SmLimits {
  name: string;
  cc: string;
  maxWarps: number;
  maxBlocks: number;
  maxThreadsPerBlock: number;
  regsPerSm: number;
  maxRegsPerThread: number;
  /** Bytes. The largest shared-memory carve-out of the unified L1/shared memory. */
  smemPerSm: number;
  smemPerBlock: number;
  /** Bytes the CUDA driver reserves in shared memory for each block. */
  smemReservedPerBlock: number;
  /** MODEL DETAIL from NVIDIA's occupancy calculator: registers are given to a warp in units of 256. */
  regAllocUnit: number;
  /** MODEL DETAIL: shared memory is given to a block in units of 128 bytes. */
  smemAllocUnit: number;
}

const KB = 1024;
export const A100: SmLimits = {
  name: "A100", cc: "8.0", maxWarps: 64, maxBlocks: 32, maxThreadsPerBlock: 1024, regsPerSm: 65536, maxRegsPerThread: 255,
  smemPerSm: 164 * KB, smemPerBlock: 163 * KB, smemReservedPerBlock: 1 * KB, regAllocUnit: 256, smemAllocUnit: 128,
};
export const H100: SmLimits = { ...A100, name: "H100", cc: "9.0", smemPerSm: 228 * KB, smemPerBlock: 227 * KB };

export type Limiter = "warps" | "blocks" | "registers" | "shared memory";

export interface Occupancy {
  ok: boolean;
  error?: string;
  warpsPerBlock: number;
  /** Registers that one warp really receives, after rounding up to the allocation unit. */
  regsPerWarp: number;
  smemPerBlockAlloc: number;
  limits: Record<Limiter, number>;
  blocks: number;
  warps: number;
  occupancy: number;
  limiter: Limiter;
  regsUsed: number;
  smemUsed: number;
}

const ceilTo = (x: number, unit: number) => Math.ceil(x / unit) * unit;

/** Resident blocks and warps per SM for one kernel launch configuration. */
export function occupancy(L: SmLimits, threadsPerBlock: number, regsPerThread: number, smemPerBlock: number): Occupancy {
  const warpsPerBlock = Math.ceil(threadsPerBlock / 32);
  const regsPerWarp = ceilTo(regsPerThread * 32, L.regAllocUnit);
  const smemPerBlockAlloc = ceilTo(smemPerBlock + L.smemReservedPerBlock, L.smemAllocUnit);
  const base = { warpsPerBlock, regsPerWarp, smemPerBlockAlloc };
  const fail = (error: string): Occupancy => ({ ok: false, error, ...base, limits: { warps: 0, blocks: 0, registers: 0, "shared memory": 0 }, blocks: 0, warps: 0, occupancy: 0, limiter: "warps", regsUsed: 0, smemUsed: 0 });
  if (threadsPerBlock > L.maxThreadsPerBlock) return fail(`more than ${L.maxThreadsPerBlock} threads per block`);
  if (regsPerThread > L.maxRegsPerThread) return fail(`more than ${L.maxRegsPerThread} registers per thread`);
  if (smemPerBlock > L.smemPerBlock) return fail(`more than ${L.smemPerBlock / KB} KB of shared memory per block`);
  const limits: Record<Limiter, number> = {
    warps: Math.floor(L.maxWarps / warpsPerBlock),
    blocks: L.maxBlocks,
    registers: Math.floor(Math.floor(L.regsPerSm / regsPerWarp) / warpsPerBlock),
    "shared memory": Math.floor(L.smemPerSm / smemPerBlockAlloc),
  };
  const order: Limiter[] = ["warps", "blocks", "registers", "shared memory"];
  const blocks = Math.min(...order.map((k) => limits[k]));
  const limiter = order.reduce((a, k) => (limits[k] < limits[a] ? k : a), order[0]!);
  if (blocks === 0) return { ...fail(`one block does not fit: ${limiter}`), limits, limiter };
  const warps = blocks * warpsPerBlock;
  return { ok: true, ...base, limits, blocks, warps, occupancy: warps / L.maxWarps, limiter, regsUsed: blocks * warpsPerBlock * regsPerWarp, smemUsed: blocks * smemPerBlockAlloc };
}

// ---------------------------------------------------------------- latency hiding

export type WarpState = "issue" | "memory" | "ready" | "done";

export interface IssueRun {
  /** Fraction of cycles in which the scheduler issued an instruction (after the warm-up). */
  utilization: number;
  /** grid[w][t]: what warp w did in cycle t, for the first `keep` cycles. */
  grid: WarpState[][];
  issued: number;
}

/**
 * One warp scheduler that issues at most one instruction per cycle. Each warp repeats: `loads` independent loads
 * (one per cycle), then `compute` instructions that need all the loads. A load result arrives `latency` cycles
 * after the load issues. MODEL: the scheduler is greedy-then-oldest (GTO). It keeps issuing from one warp until that
 * warp stalls, then it takes the ready warp with the lowest number.
 */
export function issueSim(warps: number, compute: number, latency: number, loads = 1, cycles = 4000, keep = 64): IssueRun {
  // pos: index in the warp's loop body (0..loads-1 are loads, then compute); readyAt: cycle the next instruction may issue.
  const pos = new Array<number>(warps).fill(0);
  const readyAt = new Array<number>(warps).fill(0);
  const lastLoad = new Array<number>(warps).fill(-1e9);
  const grid: WarpState[][] = Array.from({ length: warps }, () => []);
  const body = loads + compute;
  let last = -1, issued = 0, issuedSteady = 0;
  const warm = Math.min(cycles / 2, 4 * (latency + body));
  for (let t = 0; t < cycles; t++) {
    // Greedy then oldest: keep the last warp while it is ready, else take the ready warp with the lowest number.
    let pick = last >= 0 && readyAt[last]! <= t ? last : -1;
    for (let w = 0; pick < 0 && w < warps; w++) if (readyAt[w]! <= t) pick = w;
    if (t < keep) for (let w = 0; w < warps; w++) grid[w]!.push(w === pick ? "issue" : readyAt[w]! <= t ? "ready" : "memory");
    if (pick < 0) continue;
    issued++;
    if (t >= warm) issuedSteady++;
    const p = pos[pick]!;
    if (p < loads) lastLoad[pick] = t;
    const np = (p + 1) % body;
    pos[pick] = np;
    // The first compute instruction waits for the last load of this group.
    readyAt[pick] = np === loads ? Math.max(t + 1, lastLoad[pick]! + latency) : t + 1;
    last = pick;
  }
  return { utilization: issuedSteady / (cycles - warm), grid, issued };
}

/** The steady-state formula: min(1, W × (loads + compute) / (compute + loads − 1 + latency)). */
export const issueUtilization = (warps: number, compute: number, latency: number, loads = 1) =>
  Math.min(1, (warps * (loads + compute)) / (compute + loads - 1 + latency));

/** Little's law: warps needed to keep the issue slot busy. */
export const warpsNeeded = (compute: number, latency: number, loads = 1) => Math.ceil((compute + loads - 1 + latency) / (loads + compute));

// ---------------------------------------------------------------- coalescing

export type AccessPattern = "unit" | "offset" | "stride" | "aos" | "random" | "same";

/** Byte addresses of the 32 threads of a warp. `param` is the offset in bytes, the stride in elements, or the struct size. */
export function warpAddresses(pattern: AccessPattern, param: number, size = 4, base = 0): number[] {
  return Array.from({ length: 32 }, (_, i) => {
    switch (pattern) {
      case "unit": return base + size * i;
      case "offset": return base + size * i + param;
      case "stride": return base + size * param * i;
      case "aos": return base + param * i;
      case "same": return base;
      case "random": {
        // A fixed hash, so that the picture is stable: 32 elements spread over 64 KiB.
        let h = Math.imul(i + 1, 0x9e3779b1) >>> 0;
        h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13;
        return base + ((h % 16384) * size) % 65536;
      }
    }
  });
}

export interface Coalesce { sectors: number[]; lines: number[]; requested: number; moved: number; efficiency: number }

/** Distinct 32-byte sectors and 128-byte lines that one warp-wide access touches. */
export function coalesce(addrs: number[], size = 4): Coalesce {
  const sec = new Set<number>(), lin = new Set<number>(), bytes = new Set<number>();
  for (const a of addrs) {
    for (let b = a; b < a + size; b++) bytes.add(b);
    for (let s = Math.floor(a / 32); s <= Math.floor((a + size - 1) / 32); s++) sec.add(s);
    for (let l = Math.floor(a / 128); l <= Math.floor((a + size - 1) / 128); l++) lin.add(l);
  }
  const sectors = [...sec].sort((x, y) => x - y), lines = [...lin].sort((x, y) => x - y);
  const moved = sectors.length * 32;
  // Requested counts the distinct bytes the warp needs; a broadcast of one word needs `size` bytes.
  return { sectors, lines, requested: bytes.size, moved, efficiency: bytes.size / moved };
}

// ---------------------------------------------------------------- shared memory banks

export const BANKS = 32;

/** 32-bit word index that each thread reads. Pattern "column" reads tile[i][col] of a tile with `width` words per row. */
export function bankWords(pattern: "stride" | "column" | "same", param: number): number[] {
  return Array.from({ length: 32 }, (_, i) => (pattern === "stride" ? i * param : pattern === "column" ? i * param : 0));
}

export interface BankResult { bank: number[]; perBank: number[][]; degree: number }

/** Bank of each thread and the conflict degree: the most distinct words that one bank must deliver. */
export function bankConflicts(words: number[]): BankResult {
  const bank = words.map((w) => w % BANKS);
  const perBank: number[][] = Array.from({ length: BANKS }, () => []);
  words.forEach((w, i) => perBank[bank[i]!]!.push(w));
  const degree = Math.max(...perBank.map((ws) => new Set(ws).size));
  return { bank, perBank, degree };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
/** For a stride of s words, the conflict degree is gcd(s, 32). */
export const strideDegree = (s: number) => gcd(s, BANKS);
