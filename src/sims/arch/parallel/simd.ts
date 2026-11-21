/**
 * SIMD and vector units: how a loop of n elements maps onto lanes, how RISC-V V groups its registers, and the
 * roofline model that decides whether wider lanes help at all.
 *
 * Instruction counts come from the loop listings in LISTINGS (the same text the demo shows). They count
 * instructions in those listings; they are not timings of a real core.
 */

// ---------------------------------------------------------------- strip mining

/** How a loop handles the elements that do not fill a whole vector. */
export type LoopStyle = "scalar-tail" | "masked-tail" | "sve" | "rvv";

/** One trip through a loop body. `active` lanes do useful work; `lanes` is the width of the unit it used. */
export interface Trip { kind: "vector" | "scalar" | "masked"; start: number; active: number; lanes: number }

export interface LoopRun {
  trips: Trip[];
  vectorTrips: number;
  scalarTrips: number;
  instructions: number;
  /** Lane slots the loop occupied: every trip occupies the full vector width, also a scalar trip. */
  laneSlots: number;
  /** n / laneSlots. */
  utilization: number;
}

/** Instructions per trip in the listings below (model: count of listed instructions). */
export const BODY = {
  fixedVector: 6, // vmovups, vaddps, vmovups, add, cmp, jb
  fixedScalar: 6, // vmovss, vaddss, vmovss, inc, cmp, jb
  maskedTail: 6, // mov, bzhi, kmovw, then 3 masked instructions
  sveSetup: 2, // mov, whilelo
  sve: 7, // ld1w, ld1w, fadd, st1w, incw, whilelo, b.first
  rvv: 11, // vsetvli, vle32, vle32, vfadd, vse32, sub, slli, add, add, add, bnez
} as const;

/** How vsetvli picks vl. "max" takes min(AVL, VLMAX). "even" splits the last two trips evenly, as RVV 1.0 allows. */
export type VlPolicy = "max" | "even";

/**
 * vl for one vsetvli. RVV 1.0 requires vl = AVL when AVL ≤ VLMAX, ceil(AVL/2) ≤ vl ≤ VLMAX when AVL < 2·VLMAX,
 * and vl = VLMAX when AVL ≥ 2·VLMAX. Both policies obey these rules.
 */
export function vsetvl(avl: number, vlmax: number, policy: VlPolicy = "max"): number {
  if (avl <= vlmax) return avl;
  if (avl >= 2 * vlmax) return vlmax;
  return policy === "max" ? vlmax : Math.ceil(avl / 2);
}

/** Runs `c[i] = a[i] + b[i]` for n elements on a unit of `lanes` lanes, with the given tail style. */
export function stripMine(n: number, lanes: number, style: LoopStyle, policy: VlPolicy = "max"): LoopRun {
  const trips: Trip[] = [];
  let i = 0;
  if (style === "scalar-tail" || style === "masked-tail") {
    for (; i + lanes <= n; i += lanes) trips.push({ kind: "vector", start: i, active: lanes, lanes });
    if (style === "scalar-tail") for (; i < n; i++) trips.push({ kind: "scalar", start: i, active: 1, lanes });
    else if (i < n) { trips.push({ kind: "masked", start: i, active: n - i, lanes }); i = n; }
  } else if (style === "sve") {
    // whilelo makes a predicate for the first min(n - i, lanes) lanes; every trip is predicated.
    for (; i < n; i += lanes) { const a = Math.min(lanes, n - i); trips.push({ kind: a === lanes ? "vector" : "masked", start: i, active: a, lanes }); }
  } else {
    while (i < n) {
      const vl = vsetvl(n - i, lanes, policy);
      trips.push({ kind: vl === lanes ? "vector" : "masked", start: i, active: vl, lanes });
      i += vl;
    }
  }
  const vectorTrips = trips.filter((t) => t.kind !== "scalar").length;
  const scalarTrips = trips.length - vectorTrips;
  let instructions: number;
  if (style === "scalar-tail") instructions = vectorTrips * BODY.fixedVector + scalarTrips * BODY.fixedScalar;
  else if (style === "masked-tail") instructions = trips.filter((t) => t.kind === "vector").length * BODY.fixedVector + (trips.some((t) => t.kind === "masked") ? BODY.maskedTail : 0);
  else if (style === "sve") instructions = BODY.sveSetup + trips.length * BODY.sve;
  else instructions = trips.length * BODY.rvv;
  const laneSlots = trips.length * lanes;
  return { trips, vectorTrips, scalarTrips, instructions, laneSlots, utilization: laneSlots ? n / laneSlots : 1 };
}

// ---------------------------------------------------------------- RISC-V V register groups

/** LMUL as a number: 1/8 .. 8. */
export const LMULS = [0.125, 0.25, 0.5, 1, 2, 4, 8] as const;

/** VLMAX = LMUL × VLEN / SEW (RVV 1.0). */
export const vlmax = (vlen: number, sew: number, lmul: number) => Math.floor((lmul * vlen) / sew);

export interface RegGroup { base: number; regs: number[] }

/** The register groups that an instruction can name with this LMUL. With LMUL = 8: v0, v8, v16, v24. */
export function regGroups(lmul: number): RegGroup[] {
  const span = Math.max(1, lmul);
  const out: RegGroup[] = [];
  for (let b = 0; b < 32; b += span) out.push({ base: b, regs: Array.from({ length: span }, (_, k) => b + k) });
  return out;
}

/** Where element `e` of a group with base `base` lives: register and slot inside it. */
export function elementPlace(e: number, base: number, vlen: number, sew: number) {
  const perReg = vlen / sew;
  return { reg: base + Math.floor(e / perReg), slot: e % perReg };
}

// ---------------------------------------------------------------- roofline

export interface Machine {
  cores: number;
  /** GHz. */
  clock: number;
  /** FMA units per core. */
  fmaUnits: number;
  /** fp32 lanes per FMA unit. */
  lanes: number;
  /** DRAM bandwidth in GB/s. */
  bandwidth: number;
}

/** MODEL INPUT: an 8-core desktop-class x86 core at 3 GHz, 2 FMA units, 50 GB/s of DRAM bandwidth. */
export const MODEL_CPU: Machine = { cores: 8, clock: 3, fmaUnits: 2, lanes: 8, bandwidth: 50 };

/** Peak fp32 GFLOP/s: cores × clock × FMA units × lanes × 2 (an FMA is 2 FLOPs). */
export const peakGflops = (m: Machine) => m.cores * m.clock * m.fmaUnits * m.lanes * 2;

/** Attainable GFLOP/s at an arithmetic intensity (FLOP per byte of DRAM traffic): min(peak, AI × bandwidth). */
export const roofline = (m: Machine, ai: number) => Math.min(peakGflops(m), ai * m.bandwidth);

/** The intensity where the two roofs meet. Below it, the kernel waits for memory. */
export const ridge = (m: Machine) => peakGflops(m) / m.bandwidth;

export interface Kernel { id: string; label: string; flops: number; bytes: number; note: string }

/** fp32 kernels, counted per element (or per block for the GEMM), with ideal caching. */
export const KERNELS: Kernel[] = [
  { id: "add", label: "c = a + b", flops: 1, bytes: 12, note: "1 add; read a, b; write c" },
  { id: "triad", label: "a = b + s·c", flops: 2, bytes: 12, note: "1 FMA; read b, c; write a" },
  { id: "dot", label: "dot product", flops: 2, bytes: 8, note: "1 FMA; read x, y" },
  { id: "stencil", label: "7-point stencil", flops: 8, bytes: 8, note: "7 multiplies + adds; read 1 point, write 1 (neighbours in cache)" },
  { id: "gemm", label: "GEMM, 128×128 blocks", flops: 2 * 128 ** 3, bytes: 2 * 128 * 128 * 4, note: "2b³ FLOPs for 2b² inputs of 4 bytes: b/4 FLOP per byte" },
];

export const intensity = (k: Kernel) => k.flops / k.bytes;
