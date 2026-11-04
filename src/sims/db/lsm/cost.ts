/**
 * Closed-form cost models for an LSM tree and a B+ tree, used by the tuning lessons.
 * They are simple on purpose, and every assumption is written next to its formula.
 * The LSM write-amplification formulas stay within 30 % of the measured LsmTree for T = 2..16 (see tests).
 */
import { fprAtOptimalK } from "./bloom";
import type { Strategy } from "./engine";

const MiB = 1 << 20;

export interface LsmConfig {
  strategy: Strategy;
  /** write_buffer_size (bytes). */
  writeBufferBytes: number;
  /** max_write_buffer_number: memtables that can exist at the same time. */
  maxWriteBuffers: number;
  /** level0_file_num_compaction_trigger. */
  l0Trigger: number;
  /** max_bytes_for_level_base (bytes). */
  baseLevelBytes: number;
  /** max_bytes_for_level_multiplier (leveled) or runs per level (tiered). */
  sizeRatio: number;
  /** block_size (bytes). */
  blockBytes: number;
  /** Bloom bits per key (0 = no filter). */
  bloomBitsPerKey: number;
  /** Block cache capacity (bytes). */
  blockCacheBytes: number;
  /** Stored size / raw size of the last level (1 = no compression). Upper levels are not compressed. */
  lastLevelCompression: number;
}

export interface Data {
  /** Live keys. */
  keys: number;
  keyBytes: number;
  valueBytes: number;
}

export interface Workload {
  /** Fractions of operations; they are normalized. */
  writes: number;
  pointReads: number;
  rangeScans: number;
  /** Fraction of point reads that look for a key that does not exist. */
  missFraction: number;
  /** Entries returned by one range scan. */
  scanLength: number;
  /** Fraction of writes that overwrite or delete an existing key (drives space amplification). */
  updateFraction: number;
}

/** Device assumptions for the throughput score (an NVMe-class SSD). */
export interface Device {
  /** Random 4 KiB reads per second. */
  readIops: number;
  /** Sequential bandwidth for flush and compaction, bytes/s (shared by reads and writes). */
  seqBytesPerSec: number;
  /** Random page writes per second (for in-place B+ tree page writes). */
  writeIops: number;
  /** CPU time per operation (seconds), plus per sorted run probed. */
  cpuPerOp: number;
  cpuPerRun: number;
}

export const NVME: Device = { readIops: 400_000, seqBytesPerSec: 2000 * MiB, writeIops: 200_000, cpuPerOp: 2e-6, cpuPerRun: 0.2e-6 };

/** LevelDB/RocksDB entry: key + value + 8-byte sequence/type trailer. */
export const entrySize = (d: Data) => d.keyBytes + d.valueBytes + 8;
export const dataBytes = (d: Data) => d.keys * entrySize(d);

export interface LsmCosts {
  /** Levels below L0 (leveled) or tiers including the flush tier (tiered). */
  levels: number;
  /** Sorted runs a lookup may probe on average (memtable + L0 files + runs). */
  runs: number;
  writeAmp: number;
  /** Data-block reads per lookup of an existing key, before the cache. */
  pointIos: number;
  /** Data-block reads per lookup of a missing key, before the cache. */
  missIos: number;
  /** Block reads per range scan, before the cache. */
  rangeIos: number;
  spaceAmp: number;
  /** Fraction of data-block reads that hit the block cache (uniform access). */
  cacheHit: number;
  memory: { memtables: number; filters: number; index: number; cache: number; total: number };
  fpr: number;
}

/**
 * Write amplification (bytes written by flush + compaction per user byte):
 * - leveled: 1 (flush) + (1 + base / (F0 · W)) (L0 → L1 rewrites L1 for each batch of F0 files)
 *            + log_T(D / base) · T / 2 (each deeper level: a byte that moves down rewrites about T
 *            bytes when the next level is full, and about T / 2 on average while that level fills).
 * - tiered:  log_T(D / W): one write per tier (the flush is the write into tier 0).
 */
export function writeAmp(c: Pick<LsmConfig, "strategy" | "writeBufferBytes" | "l0Trigger" | "baseLevelBytes" | "sizeRatio">, D: number): number {
  const T = c.sizeRatio, W = c.writeBufferBytes;
  if (c.strategy === "tiered") return Math.max(1, Math.log(D / W) / Math.log(T));
  const deep = Math.max(0, Math.log(D / c.baseLevelBytes) / Math.log(T));
  return 1 + (1 + c.baseLevelBytes / (c.l0Trigger * W)) + (deep * T) / 2;
}

/** Leveled write amplification below L1: log_T(D / base) · T / 2. */
export const deepWriteAmp = (D: number, base: number, T: number) => (Math.max(0, Math.log(D / base) / Math.log(T)) * T) / 2;

/** Levels: leveled = 1 + ceil(log_T(D / base)) levels below L0; tiered = ceil(log_T(D / W)) tiers. */
export function levelCount(c: Pick<LsmConfig, "strategy" | "writeBufferBytes" | "baseLevelBytes" | "sizeRatio">, D: number): number {
  const T = c.sizeRatio;
  if (c.strategy === "tiered") return Math.max(1, Math.ceil(Math.log(D / c.writeBufferBytes) / Math.log(T) - 1e-9));
  return 1 + Math.max(0, Math.ceil(Math.log(D / c.baseLevelBytes) / Math.log(T) - 1e-9));
}

export function lsmCosts(c: LsmConfig, d: Data, w: Workload): LsmCosts {
  const E = entrySize(d), D = dataBytes(d), T = c.sizeRatio;
  const levels = levelCount(c, D);
  // Average runs: memtable, half of the L0 trigger, one per level (leveled);
  // memtable plus on average (T − 1) / 2 runs per tier (tiered).
  const runs = c.strategy === "leveled" ? 1 + c.l0Trigger / 2 + levels : 1 + (levels * (T - 1)) / 2;
  const diskRuns = runs - 1;
  const fpr = c.bloomBitsPerKey > 0 ? fprAtOptimalK(c.bloomBitsPerKey) : 1;
  // Existing key: assume it sits in the last run; every earlier run costs a false-positive read.
  const pointIos = 1 + Math.max(0, diskRuns - 1) * fpr;
  const missIos = diskRuns * fpr;
  // Range scan: one seek per run, then the blocks that hold the result.
  const rangeIos = diskRuns + (w.scanLength * E) / c.blockBytes;
  // Space: leveled ≤ T / (T − 1) (all upper levels obsolete); tiered ≤ T (T copies in the last tier).
  // Scale the excess by the share of writes that overwrite or delete.
  const worst = c.strategy === "leveled" ? T / (T - 1) : T;
  const spaceAmp = 1 + w.updateFraction * (worst - 1);
  const stored = D * spaceAmp * (c.lastLevelCompression * (T - 1) / T + 1 / T);
  const cacheHit = Math.min(1, c.blockCacheBytes / stored);
  const filters = c.bloomBitsPerKey > 0 ? (d.keys * spaceAmp * c.bloomBitsPerKey) / 8 : 0;
  // Index: one entry per data block (a shortened key of about keyBytes plus a 4-byte handle).
  const index = (stored / c.blockBytes) * (d.keyBytes + 4);
  const memtables = c.maxWriteBuffers * c.writeBufferBytes;
  return {
    levels, runs, writeAmp: writeAmp(c, D), pointIos, missIos, rangeIos, spaceAmp, cacheHit, fpr,
    memory: { memtables, filters, index, cache: c.blockCacheBytes, total: memtables + filters + index + c.blockCacheBytes },
  };
}

export interface Throughput {
  /** Device seconds per operation of each kind. */
  perOp: { write: number; point: number; range: number };
  /** Operations per second for the workload mix. */
  opsPerSec: number;
  /** Share of time spent in each kind of operation. */
  share: { write: number; point: number; range: number };
}

const norm = (w: Workload) => {
  const s = w.writes + w.pointReads + w.rangeScans || 1;
  return { wr: w.writes / s, pr: w.pointReads / s, rs: w.rangeScans / s };
};

/**
 * Throughput score: 1 / (average device + CPU seconds per operation). Writes cost WAL bytes plus
 * WA × entry bytes written and about the same read by compaction, at sequential bandwidth.
 * Reads cost (1 − cache hit) random block reads plus CPU per run probed.
 */
export function lsmThroughput(c: LsmConfig, d: Data, w: Workload, dev: Device = NVME): Throughput {
  const k = lsmCosts(c, d, w), E = entrySize(d), { wr, pr, rs } = norm(w);
  const miss = 1 - k.cacheHit;
  const write = dev.cpuPerOp + (E * (1 + 2 * k.writeAmp)) / dev.seqBytesPerSec;
  const pointIos = (1 - w.missFraction) * k.pointIos + w.missFraction * k.missIos;
  const point = dev.cpuPerOp + k.runs * dev.cpuPerRun + (pointIos * miss) / dev.readIops;
  const range = dev.cpuPerOp + k.runs * dev.cpuPerRun * 4 + (k.rangeIos * miss) / dev.readIops;
  const avg = wr * write + pr * point + rs * range;
  return { perOp: { write, point, range }, opsPerSec: 1 / avg, share: { write: (wr * write) / avg, point: (pr * point) / avg, range: (rs * range) / avg } };
}

// ---------------- B+ tree ----------------

export interface BtreeConfig {
  /** Page size: 4 KiB (SQLite default), 8 KiB (PostgreSQL), 16 KiB (InnoDB). */
  pageBytes: number;
  /** Average leaf fill after random inserts: about ln 2 ≈ 0.69 (Yao, 1978). */
  fill: number;
  /** Buffer pool capacity (bytes). */
  cacheBytes: number;
}

export interface BtreeCosts {
  height: number;
  leaves: number;
  fanout: number;
  innerBytes: number;
  /** Fraction of leaf reads served by the buffer pool. */
  leafHit: number;
  pointIos: number;
  rangeIos: number;
  /** Page bytes written per user byte: one page write per update (no write combining). */
  writeAmp: number;
  spaceAmp: number;
}

/**
 * A simple B+ tree model. Inner nodes hold (key, 6-byte child pointer) pairs; leaves hold entries.
 * The buffer pool keeps all inner nodes first (they are small and hot), then a uniform share of
 * leaves. A point read costs one leaf read on a miss. An update reads the leaf (point read) and
 * later writes the whole page back once: WA = page / entry. A range scan reads its leaves.
 */
export function btreeCosts(b: BtreeConfig, d: Data, w: Pick<Workload, "scanLength">): BtreeCosts {
  const E = entrySize(d);
  const leafCap = Math.max(1, Math.floor((b.pageBytes * b.fill) / E));
  const fanout = Math.max(2, Math.floor((b.pageBytes * b.fill) / (d.keyBytes + 6)));
  const leaves = Math.ceil(d.keys / leafCap);
  let height = 1, nodes = leaves, inner = 0;
  while (nodes > 1) { nodes = Math.ceil(nodes / fanout); inner += nodes; height++; }
  const innerBytes = inner * b.pageBytes;
  const leafBytes = leaves * b.pageBytes;
  const innerCached = Math.min(1, b.cacheBytes / Math.max(1, innerBytes));
  const leafHit = Math.max(0, Math.min(1, (b.cacheBytes - innerBytes) / leafBytes));
  // Inner levels not in the pool cost one read each (top levels are cached first).
  const innerIos = innerCached >= 1 ? 0 : (height - 1) * (1 - innerCached);
  const pointIos = innerIos + (1 - leafHit);
  const scanLeaves = Math.ceil((w.scanLength * E) / (b.pageBytes * b.fill));
  return {
    height, leaves, fanout, innerBytes, leafHit, pointIos,
    rangeIos: innerIos + scanLeaves * (1 - leafHit),
    writeAmp: b.pageBytes / E,
    spaceAmp: (leafBytes + innerBytes) / dataBytes(d),
  };
}

export function btreeThroughput(b: BtreeConfig, d: Data, w: Workload, dev: Device = NVME): Throughput & { costs: BtreeCosts } {
  const k = btreeCosts(b, d, w), E = entrySize(d), { wr, pr, rs } = norm(w);
  const pageWrite = Math.max(b.pageBytes / dev.seqBytesPerSec, 1 / dev.writeIops);
  // Update: WAL append, read the leaf, write the page back once.
  const write = dev.cpuPerOp + E / dev.seqBytesPerSec + k.pointIos / dev.readIops + pageWrite;
  const point = dev.cpuPerOp + k.height * dev.cpuPerRun + k.pointIos / dev.readIops;
  const range = dev.cpuPerOp + k.height * dev.cpuPerRun * 4 + k.rangeIos / dev.readIops;
  const avg = wr * write + pr * point + rs * range;
  return { costs: k, perOp: { write, point, range }, opsPerSec: 1 / avg, share: { write: (wr * write) / avg, point: (pr * point) / avg, range: (rs * range) / avg } };
}

// ---------------- write stalls ----------------

export interface StallConfig {
  /** Rate at which the application wants to write (MiB/s). */
  writeMiBps: number;
  /** Disk bandwidth that compaction can use (MiB/s, reads + writes). */
  compactionMiBps: number;
  writeBufferMiB: number;
  l0Trigger: number;
  baseLevelMiB: number;
  /** Write amplification below L1 (bytes rewritten per byte that leaves L1). */
  deepWriteAmp: number;
  /** level0_slowdown_writes_trigger (RocksDB default 20). */
  slowdownTrigger: number;
  /** level0_stop_writes_trigger (RocksDB default 36). */
  stopTrigger: number;
  /** delayed_write_rate during a slowdown (MiB/s; RocksDB uses 16 MiB/s when unset). */
  delayedMiBps: number;
  seconds: number;
}

export const STALL_DEFAULTS: StallConfig = {
  writeMiBps: 60, compactionMiBps: 400, writeBufferMiB: 64, l0Trigger: 4, baseLevelMiB: 256,
  deepWriteAmp: 13, slowdownTrigger: 20, stopTrigger: 36, delayedMiBps: 16, seconds: 600,
};

export interface StallPoint { t: number; l0: number; ingestMiBps: number; state: "ok" | "slow" | "stop" }

/**
 * A 1-second-step model of L0 under a steady write load.
 * Deeper levels take writeRate × deepWriteAmp × 2 (read + write) of the compaction bandwidth.
 * The rest drives one L0 → L1 job at a time; a job takes all current L0 files and rewrites them
 * together with L1 (read + write: 2 × (files · W + base)).
 */
export function stallTimeline(c: StallConfig): { points: StallPoint[]; avgIngest: number; stallShare: number; stopShare: number } {
  const points: StallPoint[] = [];
  let l0 = 0, mem = 0, job: { files: number; left: number } | null = null, written = 0, slow = 0, stop = 0;
  for (let t = 0; t < c.seconds; t++) {
    const state: StallPoint["state"] = l0 >= c.stopTrigger ? "stop" : l0 >= c.slowdownTrigger ? "slow" : "ok";
    const ingest = state === "stop" ? 0 : state === "slow" ? Math.min(c.writeMiBps, c.delayedMiBps) : c.writeMiBps;
    if (state === "slow") slow++;
    if (state === "stop") stop++;
    written += ingest;
    mem += ingest;
    while (mem >= c.writeBufferMiB) { mem -= c.writeBufferMiB; l0++; }
    let budget = Math.max(0, c.compactionMiBps - ingest * c.deepWriteAmp * 2);
    if (!job && l0 >= c.l0Trigger) job = { files: l0, left: 2 * (l0 * c.writeBufferMiB + c.baseLevelMiB) };
    while (job && budget > 0) {
      const use = Math.min(budget, job.left);
      job.left -= use; budget -= use;
      if (job.left <= 0) { l0 -= job.files; job = l0 >= c.l0Trigger ? { files: l0, left: 2 * (l0 * c.writeBufferMiB + c.baseLevelMiB) } : null; }
    }
    points.push({ t, l0, ingestMiBps: ingest, state });
  }
  return { points, avgIngest: written / c.seconds, stallShare: slow / c.seconds, stopShare: stop / c.seconds };
}

// ---------------- presets and comparisons ----------------

const GiB = 1 << 30;

/** RocksDB defaults (leveled, 64 MiB memtables, T = 10, L1 = 256 MiB, 4 KiB blocks) plus a 10-bit Bloom filter and a 1 GiB cache. */
export const ROCKSDB_DEFAULTS: LsmConfig = {
  strategy: "leveled", writeBufferBytes: 64 * MiB, maxWriteBuffers: 2, l0Trigger: 4, baseLevelBytes: 256 * MiB,
  sizeRatio: 10, blockBytes: 4096, bloomBitsPerKey: 10, blockCacheBytes: 1 * GiB, lastLevelCompression: 1,
};

/** 100 million keys of 16 bytes with 100-byte values. */
export const EXAMPLE_DATA: Data = { keys: 100e6, keyBytes: 16, valueBytes: 100 };

export const WORKLOADS = {
  log: { writes: 0.9, pointReads: 0.1, rangeScans: 0, missFraction: 0.5, scanLength: 100, updateFraction: 0.1 },
  point: { writes: 0.1, pointReads: 0.9, rangeScans: 0, missFraction: 0.5, scanLength: 100, updateFraction: 0.5 },
  range: { writes: 0.2, pointReads: 0, rangeScans: 0.8, missFraction: 0, scanLength: 100, updateFraction: 0.5 },
  mixed: { writes: 0.5, pointReads: 0.4, rangeScans: 0.1, missFraction: 0.2, scanLength: 50, updateFraction: 0.5 },
} satisfies Record<string, Workload>;
export type WorkloadName = keyof typeof WORKLOADS;

/** The LSM config with the block cache set so that memtables + filters + index + cache = budget. */
export function withMemoryBudget(c: LsmConfig, d: Data, w: Workload, budget: number): LsmConfig {
  const m = lsmCosts({ ...c, blockCacheBytes: 0 }, d, w).memory;
  return { ...c, blockCacheBytes: Math.max(0, budget - m.total) };
}

/** Point reads of existing keys mixed with random updates. */
export const readWriteMix = (writeFraction: number): Workload => ({
  writes: writeFraction, pointReads: 1 - writeFraction, rangeScans: 0, missFraction: 0, scanLength: 100, updateFraction: 1,
});

/** B+ tree vs LSM (RocksDB defaults) for the same data, workload and memory budget. */
export function compareEngines(budget: number, pageBytes: number, writeFraction: number, d: Data = EXAMPLE_DATA) {
  const w = readWriteMix(writeFraction);
  const lsmCfg = withMemoryBudget(ROCKSDB_DEFAULTS, d, w, budget);
  const bt: BtreeConfig = { pageBytes, fill: 0.69, cacheBytes: budget };
  return { lsm: { cfg: lsmCfg, costs: lsmCosts(lsmCfg, d, w), tput: lsmThroughput(lsmCfg, d, w) }, btree: btreeThroughput(bt, d, w) };
}

/** The write fraction above which the LSM tree has the higher throughput score (bisection). */
export function crossover(budget: number, pageBytes: number, d: Data = EXAMPLE_DATA): number {
  const diff = (f: number) => { const r = compareEngines(budget, pageBytes, f, d); return r.lsm.tput.opsPerSec - r.btree.opsPerSec; };
  if (diff(0) >= 0) return 0;
  if (diff(1) <= 0) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (diff(m) < 0) lo = m; else hi = m; }
  return hi;
}
