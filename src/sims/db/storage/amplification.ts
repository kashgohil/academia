/**
 * Read, write and space amplification of storage designs (the RUM trade-off).
 *
 * Definitions used here:
 * - RA (read amplification): storage I/Os for one point lookup. `raRange`: I/Os for a range of `rangeRecords`.
 * - WA (write amplification): bytes written to storage per byte the user updates (WAL included).
 * - SA (space amplification): bytes kept (on disk and in memory indexes) per byte of live data.
 *
 * The models are first-order and state their assumptions: an update-heavy workload over a fixed key set,
 * records of `recordBytes`, uniform random keys, internal index nodes and Bloom filters in memory.
 */
import { steadyWa, type FtlWorkload } from "./disk";

export interface AmpEnv {
  recordBytes: number;
  pageBytes: number;
  datasetBytes: number;
  memtableBytes: number;
  bloomBits: number;
  rangeRecords: number;
}

export const AMP_ENV: AmpEnv = {
  recordBytes: 100,
  pageBytes: 4096,
  datasetBytes: 100e9,
  memtableBytes: 64 * 2 ** 20,
  bloomBits: 10,
  rangeRecords: 100,
};

export interface Amp { ra: number; raRange: number; wa: number; sa: number }

/** Bloom filter false-positive rate with the best number of hash functions: 0.6185^(bits per key). */
export const bloomFpr = (bits: number) => Math.pow(0.5, bits * Math.LN2);

/** Levels below the memtable for size ratio T: ceil(log_T(dataset / memtable)), at least 1. */
export const lsmLevels = (T: number, e: AmpEnv = AMP_ENV) => Math.max(1, Math.ceil(Math.log(e.datasetBytes / e.memtableBytes) / Math.log(T) - 1e-9));

/** Average leaf fill of a B-tree built by random inserts (Yao 1978): ln 2 ≈ 69%. */
export const BTREE_RANDOM_FILL = Math.LN2;

const pagesFor = (records: number, e: AmpEnv, fill = 1) => Math.ceil((records * e.recordBytes) / (fill * e.pageBytes));

/**
 * B+ tree with in-place page updates and a WAL.
 * - `fill`: average leaf fill. - `absorbed`: updates that one page write carries (1 = every update dirties a
 *   page that is written back alone; higher = the buffer pool combines updates to the same page).
 * WA = 1 (WAL record) + page / (record × absorbed).
 */
export function btreeAmp(e: AmpEnv = AMP_ENV, o: { fill?: number; absorbed?: number } = {}): Amp {
  const fill = o.fill ?? BTREE_RANDOM_FILL, absorbed = o.absorbed ?? 1;
  return {
    ra: 1,
    raRange: pagesFor(e.rangeRecords, e, fill),
    wa: 1 + e.pageBytes / (e.recordBytes * absorbed),
    sa: 1 / fill + 24 / e.pageBytes, // inner nodes: about one 24-byte entry per leaf
  };
}

/**
 * Leveled LSM tree with size ratio T: one sorted run per level.
 * WA = 1 (WAL) + 1 (flush) + L × (T + 1) / 2: on average a byte is rewritten (T + 1) / 2 times per level.
 * SA = 1 + 1 / (T − 1): in the worst case all upper levels hold obsolete versions. Plus Bloom filter bits.
 */
export function leveledAmp(T: number, e: AmpEnv = AMP_ENV): Amp {
  const L = lsmLevels(T, e), fpr = bloomFpr(e.bloomBits);
  return {
    ra: 1 + L * fpr,
    raRange: L + pagesFor(e.rangeRecords, e),
    wa: 2 + (L * (T + 1)) / 2,
    sa: 1 + 1 / (T - 1) + e.bloomBits / 8 / e.recordBytes,
  };
}

/**
 * Tiered LSM tree with size ratio T: up to T − 1 runs per level, merged together into the next level.
 * WA = 2 + L: each byte is written once per level.
 * SA ≈ T / 2: with updates over a fixed key set, the largest level holds about T / 2 runs that all cover the keys.
 */
export function tieredAmp(T: number, e: AmpEnv = AMP_ENV): Amp {
  const L = lsmLevels(T, e), fpr = bloomFpr(e.bloomBits);
  return {
    ra: 1 + L * (T - 1) * fpr,
    raRange: L * (T - 1) + pagesFor(e.rangeRecords, e),
    wa: 2 + L,
    sa: Math.max(1, T / 2) + e.bloomBits / 8 / e.recordBytes,
  };
}

/**
 * Log-structured hash table (Bitcask): append every write to a log, keep key → offset in a memory hash table.
 * A segment is cleaned when its live fraction drops to u: WA = 1 / (1 − u). Segments go from 100% to u live,
 * so on average SA = 2 / (1 + u). The hash table costs about 32 bytes per key in memory.
 * There is no key order, so a range of k records costs k random reads.
 */
export function logHashAmp(u: number, e: AmpEnv = AMP_ENV): Amp {
  return { ra: 1, raRange: e.rangeRecords, wa: 1 / (1 - u), sa: 2 / (1 + u) + 32 / e.recordBytes };
}

/** A sorted file updated in place, no index: binary search to read, shift half the file to insert. */
export function sortedFileAmp(e: AmpEnv = AMP_ENV): Amp {
  const pages = e.datasetBytes / e.pageBytes;
  return { ra: Math.ceil(Math.log2(pages)), raRange: Math.ceil(Math.log2(pages)) + pagesFor(e.rangeRecords, e), wa: e.datasetBytes / 2 / e.recordBytes, sa: 1 };
}

/** An append-only log with no index, cleaned at live fraction u: every lookup scans half the log on average. */
export function logScanAmp(u: number, e: AmpEnv = AMP_ENV): Amp {
  const pages = (e.datasetBytes * (2 / (1 + u))) / e.pageBytes;
  return { ra: pages / 2, raRange: pages, wa: 1 / (1 - u), sa: 2 / (1 + u) };
}

export type FamilyId = "btree" | "leveled" | "tiered" | "loghash" | "sorted" | "logscan";

export interface DesignPoint { family: FamilyId; knob: string; amp: Amp }

export const FAMILY_LABEL: Record<FamilyId, string> = {
  btree: "B+ tree, in place",
  leveled: "LSM, leveled",
  tiered: "LSM, tiered",
  loghash: "Log + hash index",
  sorted: "Sorted file, no index",
  logscan: "Log, no index",
};

/** Every design the RUM demo offers: each family swept over its knob. */
export function designSpace(e: AmpEnv = AMP_ENV): DesignPoint[] {
  const out: DesignPoint[] = [];
  for (const a of [1, 2, 4, 8, 16, 32]) out.push({ family: "btree", knob: `${a} update${a > 1 ? "s" : ""} per page write`, amp: btreeAmp(e, { absorbed: a }) });
  for (const T of [2, 3, 4, 6, 8, 10, 16, 20]) out.push({ family: "leveled", knob: `T = ${T}`, amp: leveledAmp(T, e) });
  for (const T of [2, 3, 4, 6, 8, 10, 16, 20]) out.push({ family: "tiered", knob: `T = ${T}`, amp: tieredAmp(T, e) });
  for (const u of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) out.push({ family: "loghash", knob: `clean at ${Math.round(u * 100)}% live`, amp: logHashAmp(u, e) });
  out.push({ family: "sorted", knob: "", amp: sortedFileAmp(e) });
  for (const u of [0.5, 0.8]) out.push({ family: "logscan", knob: `clean at ${Math.round(u * 100)}% live`, amp: logScanAmp(u, e) });
  return out;
}

/** Read cost used for placement: geometric mean of point-lookup and range-scan I/Os. */
export const readCost = (a: Amp) => Math.sqrt(a.ra * a.raRange);

/** Normalization caps for placing designs in the RUM triangle (log scale from 1 to the cap). */
export const RUM_CAPS = { read: 100, write: 100, space: 4 };

/** Cost of one axis on a 0..1 log scale: 0 = ideal (1×), 1 = at or above the cap. */
export const rumScore = (v: number, cap: number) => Math.min(1, Math.max(0, Math.log(Math.max(1, v)) / Math.log(cap)));

/**
 * Position in the RUM triangle as barycentric weights toward the Read, Update and Memory corners.
 * A design that is cheap on one axis (score near 0) gets a large weight toward that corner.
 */
export function rumWeights(a: Amp): [number, number, number] {
  const w = [1.02 - rumScore(readCost(a), RUM_CAPS.read), 1.02 - rumScore(a.wa, RUM_CAPS.write), 1.02 - rumScore(a.sa, RUM_CAPS.space)];
  const t = w[0]! + w[1]! + w[2]!;
  return [w[0]! / t, w[1]! / t, w[2]! / t];
}

// =====================================================================================
// Write amplification through the stack, and SSD lifetime
// =====================================================================================

export interface ChainOpts {
  appWa: number;
  fsWa: number;
  deviceWa: number;
  /** User data written, MB/s. */
  userMBps: number;
  capacityGB: number;
  /** Program/erase cycles each NAND block survives (TLC about 3000, QLC about 1000). */
  peCycles: number;
}

const YEAR_S = 365 * 86400;

export function chain(o: ChainOpts) {
  const total = o.appWa * o.fsWa * o.deviceWa;
  const nandMBps = o.userMBps * total;
  const nandBytesLife = o.capacityGB * 1e9 * o.peCycles;
  const years = nandBytesLife / (nandMBps * 1e6) / YEAR_S;
  /** Host writes the drive accepts in its life (TBW), at this device WA. */
  const tbw = nandBytesLife / o.deviceWa / 1e12;
  return { total, nandMBps, years, tbw, nandTBPerDay: (nandMBps * 86400) / 1e6 };
}

export interface EnginePreset { id: string; label: string; appWa: number; deviceWorkload: FtlWorkload; note: string }

/** App-level WA for the chain calculator, from the models above with AMP_ENV. */
export function enginePresets(e: AmpEnv = AMP_ENV): EnginePreset[] {
  return [
    { id: "btree", label: "B+ tree, random updates", appWa: btreeAmp(e).wa, deviceWorkload: "random", note: "4 KiB pages in place, at random addresses" },
    { id: "leveled", label: "LSM, leveled, T = 10", appWa: leveledAmp(10, e).wa, deviceWorkload: "sequential", note: "large files once and deletes them whole" },
    { id: "tiered", label: "LSM, tiered, T = 10", appWa: tieredAmp(10, e).wa, deviceWorkload: "sequential", note: "large files once and deletes them whole" },
    { id: "loghash", label: "Log + hash, clean at 80% live", appWa: logHashAmp(0.8, e).wa, deviceWorkload: "sequential", note: "append-only segments and deletes cleaned ones whole" },
  ];
}

/** Device WA for the chain: the FTL simulation (cached by over-provisioning and workload). */
const waCache = new Map<string, number>();
export function deviceWa(op: number, workload: FtlWorkload): number {
  const k = `${op}:${workload}`;
  let v = waCache.get(k);
  if (v === undefined) { v = steadyWa(op, workload); waCache.set(k, v); }
  return v;
}
