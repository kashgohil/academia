/** Pins every number that the parallel-hardware lessons quote, and checks the sims against reference results. */
import { describe, expect, test } from "vitest";
import {
  A100, BODY, FORMATS, GPUS, H100, KERNELS, MODEL_CPU, PROGRAMS, TPU1_PEAK_TOPS, TPU1_TILE_LOAD,
  bankConflicts, bankWords, batchToRidge, coalesce, divergenceCost, dotAccumulate, elementPlace, fmaReuse, gemmPoint, gpuRidge,
  intensity, ipdoms, issueSim, issueUtilization, matmul, occupancy, peakGflops, peakTflops, program, regGroups, reuse, ridge,
  roofline, roundTo, runSystolic, runWarp, stripMine, strideDegree, sysCycles, tileGemm, tpuLayer, ulpAt, vlmax, vsetvl,
  warpAddresses, warpsNeeded,
} from "@/sims/arch/parallel";

const close = (a: number, b: number, eps = 0.005) => expect(Math.abs(a - b)).toBeLessThan(eps);
const lanes32 = (f: (i: number) => boolean) => Array.from({ length: 32 }, (_, i) => f(i));

describe("simd-and-vector-units", () => {
  test("strip mining: one SVE binary on 128-bit and 512-bit vectors, n = 100", () => {
    expect(stripMine(100, 4, "sve").trips.length).toBe(25);
    const wide = stripMine(100, 16, "sve");
    expect(wide.trips.length).toBe(7);
    expect(wide.trips.at(-1)!.active).toBe(4);
    close(wide.utilization, 0.893);
  });

  test("n = 1,000 floats on 16 lanes: scalar tail, masked tail, RVV", () => {
    const s = stripMine(1000, 16, "scalar-tail");
    expect([s.vectorTrips, s.scalarTrips, s.trips.length]).toEqual([62, 8, 70]);
    expect(s.instructions).toBe(420);
    close(s.utilization, 0.893);
    const m = stripMine(1000, 16, "masked-tail");
    expect(m.trips.length).toBe(63);
    expect(m.instructions).toBe(62 * BODY.fixedVector + BODY.maskedTail);
    close(m.utilization, 0.992);
    const r = stripMine(1000, 16, "rvv");
    expect(r.trips.length).toBe(63);
    expect(r.instructions).toBe(693);
    // n = 15 on 16 lanes: no vector trip at all, 15 scalar trips.
    expect(stripMine(15, 16, "scalar-tail").scalarTrips).toBe(15);
    expect(stripMine(15, 16, "scalar-tail").vectorTrips).toBe(0);
  });

  test("vsetvl obeys the RVV 1.0 rule", () => {
    for (const vm of [4, 8, 16, 64]) for (let avl = 1; avl < 5 * vm; avl++) for (const pol of ["max", "even"] as const) {
      const vl = vsetvl(avl, vm, pol);
      if (avl <= vm) expect(vl).toBe(avl);
      else if (avl < 2 * vm) { expect(vl).toBeGreaterThanOrEqual(Math.ceil(avl / 2)); expect(vl).toBeLessThanOrEqual(vm); }
      else expect(vl).toBe(vm);
    }
    expect(vsetvl(20, 16, "max")).toBe(16);
    expect(vsetvl(20, 16, "even")).toBe(10);
    // Every element is processed exactly once.
    for (const pol of ["max", "even"] as const) {
      const r = stripMine(1000, 16, "rvv", pol);
      expect(r.trips.reduce((a, t) => a + t.active, 0)).toBe(1000);
    }
  });

  test("RVV register groups", () => {
    expect(vlmax(128, 32, 1)).toBe(4);
    expect(vlmax(256, 32, 8)).toBe(64);
    expect(vlmax(128, 8, 8)).toBe(128);
    expect(vlmax(512, 64, 0.5)).toBe(4);
    expect(regGroups(8).map((g) => g.base)).toEqual([0, 8, 16, 24]);
    expect(regGroups(4).length).toBe(8);
    expect(regGroups(0.5).length).toBe(32);
    expect(elementPlace(9, 8, 256, 32)).toEqual({ reg: 9, slot: 1 });
  });

  test("roofline of the model CPU", () => {
    expect(peakGflops({ ...MODEL_CPU, lanes: 4 })).toBe(384);
    expect(peakGflops(MODEL_CPU)).toBe(768);
    expect(peakGflops({ ...MODEL_CPU, lanes: 16 })).toBe(1536);
    close(ridge(MODEL_CPU), 15.36);
    close(ridge({ ...MODEL_CPU, lanes: 16 }), 30.72);
    const add = KERNELS.find((k) => k.id === "add")!;
    close(roofline(MODEL_CPU, intensity(add)), 4.17, 0.01);
    expect(roofline({ ...MODEL_CPU, lanes: 16 }, intensity(add))).toBe(roofline(MODEL_CPU, intensity(add)));
    close(roofline(MODEL_CPU, intensity(add)) / peakGflops(MODEL_CPU), 0.0054, 0.0002);
    const gemm = KERNELS.find((k) => k.id === "gemm")!;
    expect(intensity(gemm)).toBe(32);
    expect(roofline(MODEL_CPU, 32)).toBe(768);
    expect(roofline({ ...MODEL_CPU, lanes: 16 }, 32)).toBe(1536);
    expect(roofline(MODEL_CPU, intensity(KERNELS.find((k) => k.id === "stencil")!))).toBe(50);
  });
});

describe("gpu-architecture", () => {
  test("occupancy on an A100 SM", () => {
    const a = occupancy(A100, 256, 32, 0);
    expect([a.blocks, a.warps, a.occupancy]).toEqual([8, 64, 1]);
    const b = occupancy(A100, 256, 64, 0);
    expect([b.blocks, b.warps, b.occupancy, b.limiter]).toEqual([4, 32, 0.5, "registers"]);
    const c = occupancy(A100, 256, 128, 0);
    expect([c.warps, c.occupancy]).toEqual([16, 0.25]);
    const d = occupancy(A100, 256, 40, 0);
    expect([d.blocks, d.warps, d.occupancy]).toEqual([6, 48, 0.75]);
    const e = occupancy(A100, 128, 32, 48 * 1024);
    expect([e.blocks, e.warps, e.limiter]).toEqual([3, 12, "shared memory"]);
    expect(occupancy(H100, 128, 32, 48 * 1024).blocks).toBe(4);
    expect(occupancy(A100, 32, 32, 0).limiter).toBe("blocks");
    expect(occupancy(A100, 32, 32, 0).occupancy).toBe(0.5);
    expect(occupancy(A100, 2048, 32, 0).ok).toBe(false);
    // The register file holds 64K 32-bit registers: 256 KB.
    expect(A100.regsPerSm * 4).toBe(256 * 1024);
  });

  test("latency hiding: the issue model matches Little's law", () => {
    close(issueUtilization(4, 4, 200), 0.098, 0.001);
    close(issueSim(4, 4, 200, 1, 20000).utilization, issueUtilization(4, 4, 200), 0.01);
    close(issueUtilization(16, 4, 200), 0.392, 0.001);
    close(issueSim(16, 4, 200, 1, 20000).utilization, issueUtilization(16, 4, 200), 0.01);
    expect(warpsNeeded(4, 200)).toBe(41);
    close(issueUtilization(16, 4, 200, 4), 0.618, 0.001);
    close(issueSim(16, 4, 200, 4, 20000).utilization, issueUtilization(16, 4, 200, 4), 0.01);
    expect(warpsNeeded(4, 200, 4)).toBe(26);
    expect(issueUtilization(41, 4, 200)).toBe(1);
    close(issueSim(41, 4, 200, 1, 20000).utilization, 1, 0.01);
    // An A100 SM has 64 warp slots and 4 schedulers: at most 16 warps per scheduler.
    expect(A100.maxWarps / 4).toBe(16);
  });

  test("coalescing into 32-byte sectors", () => {
    const sec = (p: Parameters<typeof warpAddresses>[0], q: number, size = 4) => coalesce(warpAddresses(p, q, size), size);
    expect(sec("unit", 0).sectors.length).toBe(4);
    expect(sec("unit", 0).efficiency).toBe(1);
    expect(sec("offset", 4).sectors.length).toBe(5);
    close(sec("offset", 4).efficiency, 0.8);
    expect(sec("stride", 2).sectors.length).toBe(8);
    expect(sec("stride", 8).sectors.length).toBe(32);
    expect(sec("stride", 32).sectors.length).toBe(32);
    close(sec("stride", 32).efficiency, 0.125);
    expect(sec("aos", 12).sectors.length).toBe(12);
    close(sec("aos", 12).efficiency, 1 / 3);
    expect(sec("random", 0).sectors.length).toBe(32);
    expect(sec("same", 0).sectors.length).toBe(1);
    expect(sec("unit", 0, 16).sectors.length).toBe(16);
    expect(sec("unit", 0, 16).efficiency).toBe(1);
  });

  test("shared-memory bank conflicts", () => {
    for (const s of [1, 2, 3, 4, 8, 16, 32, 33]) expect(bankConflicts(bankWords("stride", s)).degree).toBe(strideDegree(s));
    expect(bankConflicts(bankWords("column", 32)).degree).toBe(32);
    expect(bankConflicts(bankWords("column", 33)).degree).toBe(1);
    expect(bankConflicts(bankWords("same", 0)).degree).toBe(1);
    expect(strideDegree(2)).toBe(2);
  });
});

describe("warps-and-divergence", () => {
  test("immediate post-dominators of the stepper programs", () => {
    expect(ipdoms(program("ifelse").code)[0]).toBe(5);
    expect(ipdoms(program("nested").code).slice(0, 2)).toEqual([8, 6]);
    expect(ipdoms(program("loop").code)[1]).toBe(5);
    expect(ipdoms(program("spin").code)[1]).toBe(2);
  });

  test("if/else cost for 32 lanes", () => {
    const none = divergenceCost(lanes32(() => true), 20, 20);
    expect(none.issued).toBe(22);
    expect(none.utilization).toBe(1);
    const one = divergenceCost(lanes32((i) => i !== 31), 20, 20);
    expect(one.issued).toBe(42);
    close(one.utilization, 0.523, 0.001);
    close(one.issued / none.issued, 1.91, 0.01);
    const half = divergenceCost(lanes32((i) => i < 16), 20, 20);
    expect(half.issued).toBe(42);
    close(half.utilization, 0.512, 0.001);
    // Short bodies: with 4 + 4 instructions, divergence costs 10 issue slots instead of 6.
    expect(divergenceCost(lanes32(() => true), 4, 4).issued).toBe(6);
    expect(divergenceCost(lanes32((i) => i % 2 === 0), 4, 4).issued).toBe(10);
  });

  test("the stack and the ITS model compute the same results", () => {
    const x = [0, 1, 2, 3, 4, 5, 6, 7];
    for (const id of ["ifelse", "nested", "loop", "loopsync"]) {
      const a = runWarp(program(id), x, "stack"), b = runWarp(program(id), x, "its");
      expect(a.finished && b.finished).toBe(true);
      expect(a.frames.at(-1)!.regs.map((r) => r.y)).toEqual(b.frames.at(-1)!.regs.map((r) => r.y));
    }
    expect(runWarp(program("loop"), x, "stack").frames.at(-1)!.regs.map((r) => r.y)).toEqual([0, 0, 2, 6, 12, 20, 30, 42]);
  });

  test("stepper numbers with x = lane", () => {
    const x = [0, 1, 2, 3, 4, 5, 6, 7];
    const r = (id: string, s: "stack" | "its") => runWarp(program(id), x, s);
    expect(r("ifelse", "stack").issued).toBe(7);
    close(r("ifelse", "stack").utilization, 0.714, 0.001);
    expect(r("nested", "stack").issued).toBe(10);
    expect(r("loop", "stack").issued).toBe(33);
    close(r("loop", "stack").utilization, 0.576, 0.001);
    expect(r("loop", "its").issued).toBe(54);
    close(r("loop", "its").utilization, 0.352, 0.001);
    expect(r("loopsync", "its").issued).toBe(41);
  });

  test("a spin lock inside one warp: the stack never finishes, the ITS model does", () => {
    const x = [0, 1, 2, 3, 4, 5, 6, 7];
    const s = runWarp(program("spin"), x, "stack", 400);
    expect(s.finished).toBe(false);
    expect(s.frames.at(-1)!.shared.count).toBe(0);
    const i = runWarp(program("spin"), x, "its");
    expect(i.finished).toBe(true);
    expect(i.frames.at(-1)!.shared.count).toBe(8);
    expect(i.frames.at(-1)!.shared.lock).toBe(0);
  });

  test("program list", () => expect(PROGRAMS.map((p) => p.id)).toEqual(["ifelse", "nested", "loop", "loopsync", "spin"]));
});

describe("tensor-cores", () => {
  test("operand reuse", () => {
    expect(fmaReuse(8)).toMatchObject({ macs: 8, reads: 24, readsPerMac: 3 });
    const t = reuse({ m: 16, n: 8, k: 16 });
    expect([t.macs, t.reads, t.readsPerMac, t.macsPerRead]).toEqual([2048, 512, 0.25, 4]);
    expect(reuse({ m: 16, n: 8, k: 16 }).readsPerMac * 12).toBe(3);
    const w = reuse({ m: 64, n: 256, k: 16 });
    expect([w.macs, w.reads]).toEqual([262144, 21504]);
    close(w.macsPerRead, 12.19, 0.01);
  });

  test("number formats", () => {
    expect(FORMATS.fp16!.max).toBe(65504);
    expect(FORMATS.e4m3!.max).toBe(448);
    expect(FORMATS.e5m2!.max).toBe(57344);
    expect(roundTo(2049, FORMATS.fp16!)).toBe(2048);
    expect(roundTo(1 / 3, FORMATS.bf16!)).toBe(0.333984375);
    expect(roundTo(1 / 3, FORMATS.fp16!)).toBe(roundTo(1 / 3, FORMATS.tf32!));
    expect(roundTo(1e6, FORMATS.fp16!)).toBe(Infinity);
    expect(roundTo(1e6, FORMATS.e4m3!)).toBe(448);
    expect(ulpAt(1024, FORMATS.fp16!)).toBe(1);
    expect(ulpAt(1024, FORMATS.bf16!)).toBe(8);
    expect(ulpAt(512, FORMATS.fp16!)).toBe(0.5);
    // FP16 agrees with a reference conversion on a sweep (ties to even, subnormals).
    for (const v of [1, 1.0009765625, 1.00048828125, 6.103515625e-5, 5.960464477539063e-8, 3e-8, 65519, 65520]) {
      const f = new Float32Array([v])[0]!;
      expect(Number.isFinite(roundTo(f, FORMATS.fp16!)) || f >= 65520).toBe(true);
    }
    expect(roundTo(1.00048828125, FORMATS.fp16!)).toBe(1); // a tie rounds to even
    expect(roundTo(5.960464477539063e-8, FORMATS.fp16!)).toBe(5.960464477539063e-8); // smallest subnormal
    expect(roundTo(65519, FORMATS.fp16!)).toBe(65504);
    expect(roundTo(65520, FORMATS.fp16!)).toBe(Infinity);
  });

  test("accumulation error of a dot product with FP16 inputs", () => {
    const at = (K: number, id: string) => dotAccumulate(K, FORMATS[id]!);
    close(at(4096, "fp32").exact, 1000.6, 0.1);
    expect(at(4096, "fp16").got).toBe(937.5);
    close(at(4096, "fp16").relErr, 0.063, 0.001);
    expect(at(4096, "bf16").got).toBe(256);
    close(at(4096, "bf16").relErr, 0.744, 0.001);
    expect(at(4096, "fp32").relErr).toBeLessThan(2e-6);
    close(at(16384, "fp16").relErr, 0.495, 0.001);
    for (const K of [64, 1024, 16384]) expect(at(K, "fp32").relErr).toBeLessThan(at(K, "fp16").relErr);
  });

  test("peak tensor throughput from unit counts", () => {
    close(peakTflops(GPUS[0]!), 125.3, 0.05);
    close(peakTflops(GPUS[1]!), 311.9, 0.05);
    close(gpuRidge(GPUS[1]!), 200.6, 0.05);
  });

  test("a GEMM with a 4096 × 4096 FP16 weight matrix on the A100 roofline", () => {
    const g = GPUS[1]!;
    const one = gemmPoint(g, 4096, 1, 4096);
    close(one.ai, 1.0, 0.001);
    close(one.tflops, 1.55, 0.01);
    close(one.frac, 0.005, 0.0005);
    close(gemmPoint(g, 4096, 64, 4096).frac, 0.31, 0.005);
    close(gemmPoint(g, 4096, 128, 4096).frac, 0.60, 0.005);
    expect(gemmPoint(g, 4096, 256, 4096).bound).toBe("compute");
    expect(batchToRidge(g, 4096, 4096)).toBe(223);
    // Time is almost flat while memory bound: N = 1 and N = 128 both take about 22 µs.
    close(one.seconds * 1e6, 21.6, 0.1);
    close(gemmPoint(g, 4096, 128, 4096).seconds * 1e6, 22.9, 0.1);
  });

  test("tiling a GEMM into m16n8k16 tiles", () => {
    expect(tileGemm(128, 128, 128, { m: 16, n: 8, k: 16 })).toMatchObject({ tiles: 1024, utilization: 1 });
    close(tileGemm(100, 100, 100, { m: 16, n: 8, k: 16 }).utilization, 0.767, 0.001);
    expect(tileGemm(4096, 1, 4096, { m: 16, n: 8, k: 16 }).utilization).toBe(0.125);
  });
});

describe("systolic-arrays", () => {
  test("both dataflows compute the matrix product", () => {
    for (const flow of ["ws", "os"] as const) for (const [r, c, s] of [[1, 1, 1], [2, 3, 4], [4, 4, 4], [3, 5, 2], [6, 6, 12]] as const) {
      const run = runSystolic(flow, r, c, s);
      expect(run.correct).toBe(true);
      expect(run.result).toEqual(matmul(run.left, run.top));
      expect(run.cycles).toBe(sysCycles(s, r, c));
      expect(run.macs).toBe(r * c * s);
    }
  });

  test("fill and drain", () => {
    const a = runSystolic("ws", 4, 4, 4);
    expect(a.cycles).toBe(10);
    close(a.utilization, 0.4);
    expect(runSystolic("os", 4, 4, 4).cycles).toBe(10);
    close(runSystolic("ws", 4, 4, 12).utilization, 12 / 18);
    expect(sysCycles(256, 256, 256)).toBe(766);
    close(256 / sysCycles(256, 256, 256), 0.334, 0.001);
    // The first output of a 4×4 weight-stationary array leaves the bottom row in cycle R − 1 = 3 (counting from 0).
    expect(a.frames[3]!.outputs[0]![0]).not.toBeNull();
    expect(a.frames[2]!.outputs[0]![0]).toBeNull();
  });

  test("TPU v1 model", () => {
    close(TPU1_PEAK_TOPS, 91.75, 0.01);
    close(TPU1_TILE_LOAD, 1349.3, 0.1);
    const at = (M: number, K: number, N: number) => tpuLayer(M, K, N);
    expect(at(1, 2048, 2048).tiles).toBe(64);
    close(at(1, 2048, 2048).utilization, 0.0007, 0.0001);
    close(at(16, 2048, 2048).utilization, 0.0116, 0.0005);
    close(at(200, 2048, 2048).utilization, 0.145, 0.001);
    close(at(1350, 2048, 2048).utilization, 0.979, 0.001);
    expect(at(1350, 2048, 2048).bound).toBe("compute");
    close(at(4096, 27, 64).spatial, 0.026, 0.001);
    close(at(4096, 27, 64).utilization, 0.018, 0.001);
    close(at(4096, 300, 300).spatial, 0.343, 0.001);
  });
});

describe("numbers quoted in the lesson text", () => {
  test("simd lesson", () => {
    const r = stripMine(200, 16, "scalar-tail");
    expect([r.vectorTrips, r.scalarTrips]).toEqual([12, 8]);
    const hbm = { ...MODEL_CPU, bandwidth: 400 };
    expect(roofline(hbm, intensity(KERNELS.find((k) => k.id === "add")!)) / peakGflops(hbm)).toBeLessThan(0.05);
    close(roofline(hbm, intensity(KERNELS.find((k) => k.id === "add")!)) / peakGflops(hbm), 0.043, 0.001);
    expect(roofline(hbm, 1)).toBeGreaterThan(roofline(MODEL_CPU, 1));
    expect(vsetvl(20, 16, "max")).toBe(16);
    expect(vlmax(128, 32, 4)).toBe(16);
  });

  test("gpu lesson", () => {
    expect(warpsNeeded(40, 200)).toBe(6);
    close(19.5e12 / (GPUS[1]!.bandwidth * 1e9), 12.5, 0.1);
    expect(occupancy(A100, 256, 40, 0).regsPerWarp).toBe(1280);
    expect(Math.floor(A100.regsPerSm / 1280)).toBe(51);
    expect(occupancy(A100, 256, 64, 0).regsPerWarp * 8).toBe(16384);
  });

  test("warps lesson", () => {
    expect(divergenceCost(lanes32((i) => i !== 31), 20, 1).issued).toBe(23);
    expect(divergenceCost(lanes32(() => true), 20, 1).issued).toBe(22);
  });

  test("tensor lesson", () => {
    close(gpuRidge(GPUS[0]!), 139.3, 0.1);
    close(peakTflops(GPUS[1]!) / peakTflops(GPUS[0]!), 2.5, 0.05);
    close(GPUS[1]!.bandwidth / GPUS[0]!.bandwidth, 1.7, 0.03);
    expect(reuse({ m: 8, n: 8, k: 4 })).toMatchObject({ macs: 256, reads: 128 });
    expect(reuse({ m: 1, n: 1, k: 1 }).reads).toBe(3);
    expect(16 * 16 + 16 * 8).toBe(384);
    expect(reuse({ m: 8, n: 8, k: 4 }).macs).toBe(256);
    expect(8 * 4 + 4 * 8).toBe(64);
    close(dotAccumulate(4096, FORMATS.fp16!).relErr, 0.063, 0.001);
  });

  test("systolic lesson", () => {
    const a = runSystolic("ws", 4, 4, 4);
    expect(a.macs).toBe(64);
    expect(a.frames[0]!.pes.flat().filter((p) => p.mac).length).toBe(1);
    expect(a.frames[1]!.pes.flat().filter((p) => p.mac).length).toBe(3);
    expect(runSystolic("ws", 4, 4, 12).cycles).toBe(18);
    close(34e9 / 700e6, 48.6, 0.05);
    expect(tpuLayer(16, 300, 300).tiles).toBe(4);
    close(tpuLayer(4096, 27, 64).utilization, 0.018, 0.0005);
    close(tpuLayer(1350, 2048, 2048).utilization, 0.98, 0.002);
  });
});
