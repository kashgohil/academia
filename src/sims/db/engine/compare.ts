/**
 * SQLite, LMDB and RocksDB side by side: what one put() writes, where, in which order and with
 * which fsyncs; and a workload-fit model built on the wave-1 cost models (lsm/cost for the B+ tree
 * and LSM read and space costs, btree-cow for copy-on-write writes, recovery/groupcommit for fsync).
 *
 * Defaults are the engines' own: SQLite synchronous = FULL with 4 KiB pages; LMDB with no
 * MDB_NOSYNC or MDB_NOMETASYNC; RocksDB WriteOptions.sync = false (the default) or true.
 */
import { btreeCosts, lsmCosts, withMemoryBudget, entrySize, ROCKSDB_DEFAULTS, NVME, type Data, type Workload } from "../lsm/cost";
import { cowBytesPerUpdate } from "../btree-cow";
import { DEVICES } from "../recovery/groupcommit";

export type RealId = "sqlite" | "lmdb" | "rocksdb";
export const REAL_LABEL: Record<RealId, string> = { sqlite: "SQLite", lmdb: "LMDB", rocksdb: "RocksDB" };

export type StepAction = "read" | "mem" | "write" | "fsync" | "unlink" | "later";
export interface PutStep { action: StepAction; file: string; bytes: number; text: string; /** After this step the commit is durable. */ commitPoint?: boolean }

export interface PutOpts {
  /** B+ tree height (root to leaf). */
  height: number;
  pageBytes: number;
  keyBytes: number;
  valueBytes: number;
  sqliteMode: "wal" | "rollback";
  rocksSync: boolean;
}
export const PUT_DEFAULTS: PutOpts = { height: 3, pageBytes: 4096, keyBytes: 16, valueBytes: 100, sqliteMode: "wal", rocksSync: false };

/** Bytes of a LEB128 varint. */
export const varintBytes = (n: number) => { let b = 1; while (n >= 128) { n = Math.floor(n / 128); b++; } return b; };

/** RocksDB / LevelDB WAL bytes of a one-put write batch: 7-byte record header, 12-byte batch header, type, varint lengths. */
export const rocksWalBytes = (keyBytes: number, valueBytes: number) => 7 + 12 + 1 + varintBytes(keyBytes) + keyBytes + varintBytes(valueBytes) + valueBytes;

export const SQLITE_WAL_FRAME_HEADER = 24;
export const SQLITE_WAL_HEADER = 32;
export const SQLITE_JOURNAL_SECTOR = 512;

/** The steps of one autocommit put() of a new value for an existing key. */
export function putSteps(id: RealId, o: PutOpts = PUT_DEFAULTS): PutStep[] {
  const P = o.pageBytes;
  const path = `${o.height} page${o.height > 1 ? "s" : ""}, root to leaf`;
  if (id === "sqlite") {
    const read: PutStep = { action: "read", file: "page cache", bytes: 0, text: `Find the leaf: read ${path} (hits in the page cache)` };
    if (o.sqliteMode === "rollback") return [
      read,
      { action: "write", file: "db-journal", bytes: SQLITE_JOURNAL_SECTOR + 4 + P + 4, text: "Write the journal header (one sector) and the original leaf page with its page number and checksum" },
      { action: "fsync", file: "db-journal", bytes: 0, text: "fsync the journal" },
      { action: "fsync", file: "directory", bytes: 0, text: "fsync the directory, so that the new journal file survives a crash" },
      { action: "write", file: "db-journal", bytes: 0, text: "Write the page count into the journal header" },
      { action: "fsync", file: "db-journal", bytes: 0, text: "fsync the journal again" },
      { action: "write", file: "db", bytes: P, text: "Overwrite the leaf page in the database file" },
      { action: "fsync", file: "db", bytes: 0, text: "fsync the database file" },
      { action: "unlink", file: "db-journal", bytes: 0, text: "Delete the journal: this is the commit", commitPoint: true },
    ];
    return [
      read,
      { action: "mem", file: "page cache", bytes: 0, text: "Change the leaf page in memory" },
      { action: "write", file: "db-wal", bytes: SQLITE_WAL_FRAME_HEADER + P, text: "Append one frame (24-byte header + the whole new leaf page). Its header marks the commit" },
      { action: "fsync", file: "db-wal", bytes: 0, text: "fsync the WAL (synchronous = FULL)", commitPoint: true },
      { action: "mem", file: "db-shm", bytes: 0, text: "Add the frame to the wal-index in shared memory, so readers find it" },
      { action: "later", file: "db", bytes: P, text: "Later, a checkpoint copies the page into the database file and fsyncs it (by default when the WAL reaches 1,000 pages)" },
    ];
  }
  if (id === "lmdb") {
    return [
      { action: "read", file: "data.mdb (mmap)", bytes: 0, text: `Find the leaf: read ${path} through the memory map` },
      { action: "mem", file: "memory", bytes: 0, text: `Copy the ${o.height} pages on the path to new page numbers and change the copies` },
      { action: "mem", file: "memory", bytes: 0, text: "Record the replaced pages in the free-page tree (about one more page)" },
      { action: "write", file: "data.mdb", bytes: (o.height + 1) * P, text: `Write the ${o.height + 1} new pages with pwrite()` },
      { action: "fsync", file: "data.mdb", bytes: 0, text: "fdatasync the data file" },
      { action: "write", file: "data.mdb", bytes: P, text: "Write the new root and transaction id into the older of the two meta pages" },
      { action: "fsync", file: "data.mdb", bytes: 0, text: "fdatasync again: the new meta page is the commit", commitPoint: true },
    ];
  }
  const wal = rocksWalBytes(o.keyBytes, o.valueBytes);
  const steps: PutStep[] = [
    { action: "write", file: "WAL (*.log)", bytes: wal, text: `Append the write batch to the WAL: ${wal} bytes`, commitPoint: !o.rocksSync },
  ];
  if (o.rocksSync) steps.push({ action: "fsync", file: "WAL (*.log)", bytes: 0, text: "fsync the WAL (WriteOptions.sync = true)", commitPoint: true });
  steps.push(
    { action: "mem", file: "memtable", bytes: 0, text: "Insert the entry into the memtable (a skip list)" },
    { action: "later", file: "*.sst", bytes: 0, text: "Later, a full memtable becomes an L0 SSTable; compaction rewrites the entry into deeper levels" },
  );
  return steps;
}

export interface PutSummary { commitBytes: number; commitFsyncs: number; laterBytes: number; durableAtCommit: boolean }

/** Bytes and fsyncs on the commit path, and the bytes that background work writes later. */
export function putSummary(id: RealId, o: PutOpts = PUT_DEFAULTS, d: Data = { keys: 100e6, keyBytes: o.keyBytes, valueBytes: o.valueBytes }): PutSummary {
  const steps = putSteps(id, o);
  const cp = steps.findIndex((s) => s.commitPoint);
  const before = steps.slice(0, cp + 1);
  const commitBytes = before.reduce((s, x) => s + x.bytes, 0);
  const commitFsyncs = before.filter((x) => x.action === "fsync").length;
  let laterBytes = steps.slice(cp + 1).reduce((s, x) => s + x.bytes, 0);
  if (id === "rocksdb") laterBytes = lsmCosts(ROCKSDB_DEFAULTS, d, { writes: 1, pointReads: 0, rangeScans: 0, missFraction: 0, scanLength: 100, updateFraction: 1 }).writeAmp * entrySize(d);
  return { commitBytes, commitFsyncs, laterBytes, durableAtCommit: id !== "rocksdb" || o.rocksSync };
}

// ---------------------------------------------------------------- workload fit

export interface Mix {
  writeFrac: number;
  /** Fraction of the reads that are range scans of 100 entries. */
  rangeFrac: number;
  /** Concurrent client threads. */
  clients: number;
  /** Updates per transaction. */
  batch: number;
  /** Memory for caches, in bytes. */
  memory: number;
  fsync: keyof typeof DEVICES;
  /** Every commit must survive a power cut. Off: SQLite synchronous = NORMAL, LMDB MDB_NOSYNC, RocksDB sync = false. */
  durable: boolean;
}
export const MIX_DEFAULTS: Mix = { writeFrac: 0.2, rangeFrac: 0, clients: 8, batch: 1, memory: 4 * 2 ** 30, fsync: "ssd", durable: true };

/** 100 million keys of 16 bytes with 100-byte values (lsm/cost EXAMPLE_DATA). */
export const FIT_DATA: Data = { keys: 100e6, keyBytes: 16, valueBytes: 100 };

export interface Fit {
  id: RealId;
  opsPerSec: number;
  /** Microseconds per operation of each kind. */
  writeUs: number;
  pointUs: number;
  rangeUs: number;
  writeAmp: number;
  pointIos: number;
  rangeIos: number;
  spaceAmp: number;
  /** fsyncs per update. */
  fsyncsPerUpdate: number;
  /** Writers that can work at the same time. */
  writers: number;
}

/**
 * Device-time model of each engine for a mix. Reads and writes cost random reads (IOPS),
 * bytes (bandwidth) and CPU; fsync time is shared by the commits of one group. SQLite and LMDB
 * allow one writer, so a group is one transaction; RocksDB groups the commits of all clients.
 */
export function fit(id: RealId, m: Mix = MIX_DEFAULTS, d: Data = FIT_DATA): Fit {
  const dev = NVME, E = entrySize(d), P = 4096;
  const w: Workload = { writes: m.writeFrac, pointReads: (1 - m.writeFrac) * (1 - m.rangeFrac), rangeScans: (1 - m.writeFrac) * m.rangeFrac, missFraction: 0, scanLength: 100, updateFraction: 1 };
  const fsyncUs = DEVICES[m.fsync].fsyncMs * 1000;
  const cpu = dev.cpuPerOp * 1e6;
  const rd = (ios: number) => (ios / dev.readIops) * 1e6;
  const bw = (bytes: number) => (bytes / dev.seqBytesPerSec) * 1e6;
  let r: Omit<Fit, "id" | "opsPerSec">;
  if (id === "rocksdb") {
    const cfg = withMemoryBudget(ROCKSDB_DEFAULTS, d, w, m.memory);
    const k = lsmCosts(cfg, d, w);
    const miss = 1 - k.cacheHit;
    const fsyncs = m.durable ? 1 / m.batch : 0;
    const group = Math.max(1, m.clients);
    r = {
      writeUs: cpu + bw(E * (1 + 2 * k.writeAmp)) + (fsyncs * fsyncUs) / group,
      pointUs: cpu + k.runs * dev.cpuPerRun * 1e6 + rd(k.pointIos * miss),
      rangeUs: cpu + k.runs * dev.cpuPerRun * 4e6 + rd(k.rangeIos * miss),
      writeAmp: 1 + k.writeAmp, pointIos: k.pointIos * miss, rangeIos: k.rangeIos * miss, spaceAmp: k.spaceAmp, fsyncsPerUpdate: fsyncs / group, writers: m.clients,
    };
  } else {
    const k = btreeCosts({ pageBytes: P, fill: 0.69, cacheBytes: m.memory }, d, w);
    const read = cpu + k.height * dev.cpuPerRun * 1e6 + rd(k.pointIos);
    const range = cpu + k.height * dev.cpuPerRun * 4e6 + rd(k.rangeIos);
    if (id === "sqlite") {
      // WAL mode: the leaf page goes to the WAL (frame) and later to the database file (checkpoint).
      // Not durable: synchronous = NORMAL, no fsync at commit.
      const fsyncs = m.durable ? 1 / m.batch : 0;
      r = {
        writeUs: read + bw(SQLITE_WAL_FRAME_HEADER + P) + (1e6 / dev.writeIops) + fsyncs * fsyncUs,
        pointUs: read, rangeUs: range, writeAmp: (SQLITE_WAL_FRAME_HEADER + 2 * P) / E, pointIos: k.pointIos, rangeIos: k.rangeIos, spaceAmp: k.spaceAmp, fsyncsPerUpdate: fsyncs, writers: 1,
      };
    } else {
      const cow = cowBytesPerUpdate({ n: d.keys, pageBytes: P, recordBytes: E, batch: m.batch });
      const fsyncs = m.durable ? 2 / m.batch : 0; // not durable: MDB_NOSYNC
      const pages = cow.bytesPerUpdate / P;
      r = {
        writeUs: read + pages * (1e6 / dev.writeIops) + fsyncs * fsyncUs,
        pointUs: read, rangeUs: range, writeAmp: cow.amplification, pointIos: k.pointIos, rangeIos: k.rangeIos, spaceAmp: k.spaceAmp, fsyncsPerUpdate: fsyncs, writers: 1,
      };
    }
  }
  const avg = w.writes * r.writeUs + w.pointReads * r.pointUs + w.rangeScans * r.rangeUs;
  return { id, opsPerSec: 1e6 / avg, ...r };
}

export const fitAll = (m: Mix = MIX_DEFAULTS) => (["sqlite", "lmdb", "rocksdb"] as RealId[]).map((id) => fit(id, m));
