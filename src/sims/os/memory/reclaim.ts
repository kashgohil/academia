/**
 * Reclaim under memory pressure: watermarks, kswapd, direct reclaim, swap, zswap, OOM.
 *
 * One zone, in MiB, stepped in ticks of 0.1 s. A workload grows its anonymous memory. It also re-reads the pages of
 * its hot file set and touches its own anonymous pages, so that evicted hot pages come back as refaults.
 *
 * Real rules that the model keeps:
 * - Watermark formulas from mm/page_alloc.c (min_free_kbytes, watermark_scale_factor).
 * - kswapd wakes when free < low and sleeps when free >= high. An allocation that would take free below min enters
 *   direct reclaim: the allocating task reclaims and is stalled.
 * - Cold page cache goes first (the "cache trim" rule in get_scan_count). After that the split between anon
 *   and file follows swappiness / 200.
 * - Anonymous pages need a swap slot. Zswap also takes a swap slot, and stores the page compressed in RAM.
 *
 * Simplifications (model rules, not kernel rules):
 * - One zone, and the throughputs in PRESSURE_DEFAULTS are model inputs.
 * - OOM fires when the workload gets no new memory for `oomAfterS`. A real kernel can stay stuck longer, because
 *   reclaim of pages that refault counts as progress.
 */

/** Real defaults of the Linux VM sysctls. */
export const VM_DEFAULTS = {
  swappiness: 60,
  swappinessMax: 200,
  watermarkScaleFactor: 10,
  overcommitMemory: 0,
  overcommitRatio: 50,
  zswapMaxPoolPercent: 20,
} as const;

/** The boot-time value of vm.min_free_kbytes: int_sqrt(lowmem_kbytes * 16), clamped to 128..262144. */
export function minFreeKbytes(lowmemKb: number): number {
  return Math.max(128, Math.min(262144, Math.floor(Math.sqrt(lowmemKb * 16))));
}

/** Zone watermarks in the same unit as `managed`: low = min + gap, high = min + 2 * gap, gap = max(min/4, managed*scale/10000). */
export function watermarks(managed: number, min: number, scaleFactor: number = VM_DEFAULTS.watermarkScaleFactor) {
  const gap = Math.max(min / 4, (managed * scaleFactor) / 10000);
  return { min, low: min + gap, high: min + 2 * gap, gap };
}

export interface PressureInput {
  ramMiB: number;
  swapMiB: number;
  swappiness: number;
  /** MiB/s of new anonymous memory that the workload asks for. */
  growthMiBps: number;
  zswap: boolean;
  /** Model input: compression ratio of zswap (real ratios depend on the data). */
  zswapRatio: number;
  /** Starting state. */
  fileColdMiB: number;
  fileHotMiB: number;
  anonIdleMiB: number;
  workloadMiB: number;
  /** vm.min_free_kbytes in MiB and vm.watermark_scale_factor. */
  minMiB: number;
  scaleFactor: number;
  /** Model inputs: throughputs in MiB/s. */
  dropFileMiBps: number;
  swapOutMiBps: number;
  swapInMiBps: number;
  fileReadMiBps: number;
  zswapOutMiBps: number;
  zswapInMiBps: number;
  /** Model inputs: fraction of the evicted file pages and of the swapped workload pages that it touches again per second. */
  refaultPerS: number;
  swapTouchPerS: number;
  oomAfterS: number;
  durationS: number;
}

export const PRESSURE_DEFAULTS: PressureInput = {
  ramMiB: 8192,
  swapMiB: 2048,
  swappiness: VM_DEFAULTS.swappiness,
  growthMiBps: 400,
  zswap: false,
  zswapRatio: 3,
  fileColdMiB: 2000,
  fileHotMiB: 1000,
  anonIdleMiB: 800,
  workloadMiB: 1000,
  minMiB: 128,
  scaleFactor: 200,
  dropFileMiBps: 2000,
  swapOutMiBps: 300,
  swapInMiBps: 500,
  fileReadMiBps: 800,
  zswapOutMiBps: 1000,
  zswapInMiBps: 2500,
  refaultPerS: 0.5,
  swapTouchPerS: 0.1,
  oomAfterS: 2,
  durationS: 40,
};

export type PressurePhase = "ok" | "kswapd" | "direct" | "oom" | "recovered";

export const PHASE_LABEL: Record<PressurePhase, string> = {
  ok: "Free is above the watermarks",
  kswapd: "kswapd reclaims in the background",
  direct: "Direct reclaim: the workload stalls",
  oom: "OOM kill",
  recovered: "The workload is dead. Memory is free again",
};

export interface PressureFrame {
  t: number;
  free: number;
  fileCold: number;
  fileHot: number;
  /** Resident anonymous memory: idle programs + the workload. */
  anon: number;
  zpool: number;
  swapUsed: number;
  workloadTotal: number;
  phase: PressurePhase;
  kswapd: boolean;
  /** Fraction of this tick that the workload stalled. */
  stall: number;
  /** Exponential average of stall with a 10 s time constant, the shape of PSI "some avg10". */
  psi: number;
  refaultMiBps: number;
  swapInMiBps: number;
  swapOutMiB: number;
  directMiB: number;
  kswapdMiB: number;
}

export interface PressureRun {
  frames: PressureFrame[];
  marks: { min: number; low: number; high: number };
  firstKswapd: number | null;
  firstDirect: number | null;
  oomAt: number | null;
  peakPsi: number;
  totals: { swapOutMiB: number; refaultMiB: number; swapInMiB: number; directMiB: number; kswapdMiB: number; zswapStoredMiB: number; diskWriteMiB: number };
}

const DT = 0.1;
const CHUNK = 2;
const HOLD = 1;

export function runPressure(input: Partial<PressureInput> = {}): PressureRun {
  const o = { ...PRESSURE_DEFAULTS, ...input };
  const marks = watermarks(o.ramMiB, o.minMiB, o.scaleFactor);
  let fileCold = o.fileColdMiB, fileHot = o.fileHotMiB, anonCold = o.anonIdleMiB, anonHot = o.workloadMiB;
  let free = o.ramMiB - fileCold - fileHot - anonCold - anonHot;
  let swapCold = 0, swapHot = 0, zStored = 0, zpool = 0, fileHotWanted = o.fileHotMiB;
  let alive = true, kswapdOn = false, psi = 0, stuck = 0, lastK = -Infinity, lastD = -Infinity;
  const poolMax = (o.ramMiB * VM_DEFAULTS.zswapMaxPoolPercent) / 100;
  const totals = { swapOutMiB: 0, refaultMiB: 0, swapInMiB: 0, directMiB: 0, kswapdMiB: 0, zswapStoredMiB: 0, diskWriteMiB: 0 };
  const frames: PressureFrame[] = [];
  let firstKswapd: number | null = null, firstDirect: number | null = null, oomAt: number | null = null, peakPsi = 0;
  const swapUsed = () => swapCold + swapHot;

  /** Reclaims until `target` free or the time budget ends. Stops early if nothing can go. */
  const reclaim = (budget0: number, target: number) => {
    let budget = budget0, freed = 0, fileShare = 0, anonShare = 0;
    while (budget > 0 && free < target) {
      const swapOk = swapUsed() < o.swapMiB;
      const anonAvail = swapOk ? anonCold + anonHot : 0;
      const fileAvail = fileCold + fileHot;
      if (anonAvail <= 0 && fileAvail <= 0) break;
      let takeAnon: boolean;
      if (fileCold > 0) takeAnon = false;             // cold cache first
      else if (anonAvail <= 0) takeAnon = false;
      else if (fileAvail <= 0) takeAnon = true;
      else if (fileAvail + free < marks.high) takeAnon = true; // file is tiny: swap regardless of swappiness
      else if (o.swappiness === 0) takeAnon = false;
      else {
        // Deficit round robin: the shares follow swappiness : (200 - swappiness).
        takeAnon = anonShare * (200 - o.swappiness) <= fileShare * o.swappiness;
      }
      if (!takeAnon) {
        const c = Math.min(CHUNK, fileAvail);
        const cold = Math.min(c, fileCold), hot = c - cold;
        fileCold -= cold; fileHot -= hot;
        fileShare += c;
        free += c; freed += c;
        budget -= c / o.dropFileMiBps;
      } else {
        const c = Math.min(CHUNK, anonAvail, o.swapMiB - swapUsed());
        const cold = Math.min(c, anonCold), hot = c - cold;
        anonCold -= cold; anonHot -= hot;
        swapCold += cold; swapHot += hot;
        anonShare += c;
        totals.swapOutMiB += c;
        if (o.zswap && zpool + c / o.zswapRatio <= poolMax) {
          zStored += c; zpool += c / o.zswapRatio;
          totals.zswapStoredMiB += c;
          free += c * (1 - 1 / o.zswapRatio); freed += c * (1 - 1 / o.zswapRatio);
          budget -= c / o.zswapOutMiBps;
        } else {
          free += c; freed += c;
          totals.diskWriteMiB += c;
          budget -= c / o.swapOutMiBps;
        }
      }
    }
    return { freed, used: budget0 - Math.max(0, budget) };
  };

  const steps = Math.round(o.durationS / DT);
  for (let i = 0; i <= steps; i++) {
    const t = i * DT;
    let phase: PressurePhase = alive ? "ok" : "recovered";
    let kMiB = 0, dMiB = 0, swapOutBefore = totals.swapOutMiB;

    // kswapd runs beside the workload, on its own CPU.
    if (free < marks.low) { if (!kswapdOn && firstKswapd === null) firstKswapd = t; kswapdOn = true; }
    if (kswapdOn) {
      kMiB = reclaim(DT, marks.high).freed;
      totals.kswapdMiB += kMiB;
      if (free >= marks.high) kswapdOn = false;
    }

    // Hot pages that are out of memory come back. The workload waits for each one.
    const missingFile = Math.max(0, fileHotWanted - fileHot);
    let refault = alive ? missingFile * o.refaultPerS * DT : 0;
    let swapIn = alive ? swapHot * o.swapTouchPerS * DT : 0;
    const zShare = swapUsed() > 0 ? Math.min(1, zStored / swapUsed()) : 0;
    const swapInRate = 1 / (zShare / o.zswapInMiBps + (1 - zShare) / o.swapInMiBps);
    let stallS = refault / o.fileReadMiBps + swapIn / swapInRate;
    if (stallS > DT * 0.8) { const k = (DT * 0.8) / stallS; refault *= k; swapIn *= k; stallS = DT * 0.8; }
    const runFrac = 1 - stallS / DT;
    const want = alive ? o.growthMiBps * DT * runFrac : 0;
    const need = refault + swapIn + want;

    // An allocation that would pass the min watermark enters direct reclaim.
    if (free - need < marks.min && alive) {
      const r = reclaim(DT - stallS, marks.min + need);
      dMiB = r.freed;
      totals.directMiB += r.freed;
      stallS += r.used;
      // Nothing to reclaim, or not enough: the task keeps waiting for the whole tick.
      if (free < marks.min + need) stallS = DT;
      if (firstDirect === null) firstDirect = t;
    }

    // Grant what fits above min. Refaults first, then new memory.
    let room = Math.max(0, free - marks.min);
    const gotRefault = Math.min(room, refault); room -= gotRefault;
    const gotSwapIn = Math.min(room, swapIn); room -= gotSwapIn;
    const got = Math.min(room, want);
    free -= gotRefault + gotSwapIn + got;
    fileHot += gotRefault;
    totals.refaultMiB += gotRefault;
    if (gotSwapIn > 0) {
      swapHot -= gotSwapIn;
      anonHot += gotSwapIn;
      const zOut = gotSwapIn * zShare;
      zStored = Math.max(0, zStored - zOut);
      zpool = Math.max(0, zpool - zOut / o.zswapRatio);
      free += zOut / o.zswapRatio;
      totals.swapInMiB += gotSwapIn;
    }
    anonHot += got;

    if (alive && want > 0 && got < want * 0.05) stuck += DT; else stuck = 0;
    if (alive && stuck >= o.oomAfterS) {
      alive = false;
      oomAt = t;
      phase = "oom";
      free += anonHot;
      anonHot = 0;
      const victimSwap = swapHot;
      const zOut = swapUsed() > 0 ? (zStored * victimSwap) / swapUsed() : 0;
      zStored -= zOut; zpool -= zOut / o.zswapRatio; free += zOut / o.zswapRatio;
      swapHot = 0;
      fileHotWanted = 0;
    } else if (alive) {
      // Hold each phase for a moment, so that one quiet tick does not read as "no pressure".
      if (kMiB > 0 || kswapdOn) lastK = t;
      if (dMiB > 0 || stallS >= DT) lastD = t;
      phase = t - lastD < HOLD ? "direct" : t - lastK < HOLD ? "kswapd" : "ok";
    }

    const stall = alive || phase === "oom" ? Math.min(1, stallS / DT) : 0;
    psi += (stall - psi) * (DT / 10);
    peakPsi = Math.max(peakPsi, psi);
    frames.push({
      t, free, fileCold, fileHot, anon: anonCold + anonHot, zpool, swapUsed: swapUsed(),
      workloadTotal: anonHot + swapHot, phase, kswapd: kswapdOn, stall, psi,
      refaultMiBps: gotRefault / DT, swapInMiBps: gotSwapIn / DT, swapOutMiB: totals.swapOutMiB - swapOutBefore,
      directMiB: dMiB, kswapdMiB: kMiB,
    });
  }
  return { frames, marks, firstKswapd, firstDirect, oomAt, peakPsi, totals };
}
