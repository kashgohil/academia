/**
 * The same workload on TinyKv (B+ tree mode) and on LsmKv (LSM mode): measured I/O counters per
 * operation, and a device-time model that turns them into operations per second.
 *
 * Both engines keep their index in memory (inner B+ tree pages in a small pool; LSM fence pointers
 * and Bloom filters), and both read data pages or blocks from the device. The model:
 *   time per op = CPU + random reads / read IOPS + random page writes / write IOPS
 *               + sequential bytes (written and read) / bandwidth + fsyncs × fsync latency.
 */
import { mulberry32 } from "../../rng";
import { NVME, type Device } from "../lsm/cost";
import { DEVICES } from "../recovery/groupcommit";
import { TinyKv, ConflictError, reopen } from "./kv";
import { LsmKv } from "./lsmkv";

export interface WorkloadSpec {
  keys: number;
  ops: number;
  /** Fraction of operations that update an existing key (the rest are point reads). */
  writeFrac: number;
  valueBytes: number;
  opsPerTxn: number;
  groupCommit: number;
  frames: number;
  /** B+ tree mode: a checkpoint after this many operations (writes back dirty pages). */
  checkpointEvery: number;
  pageBytes: number;
  seed: number;
}

export const WL_DEFAULTS: WorkloadSpec = { keys: 3000, ops: 2000, writeFrac: 0.5, valueBytes: 100, opsPerTxn: 4, groupCommit: 1, frames: 16, checkpointEvery: 500, pageBytes: 4096, seed: 7 };

export type EngineMode = "btree" | "lsm";

/** Per operation. */
export interface IoProfile {
  /** Page or block reads from the device. */
  randomReads: number;
  /** In-place page writes (B+ tree). */
  randomWrites: number;
  /** Log bytes written. */
  logBytes: number;
  /** Of them, bytes of full-page images (B+ tree). */
  fpiBytes: number;
  /** Page bytes (B+ tree) or SSTable bytes from flush and compaction (LSM) written. */
  dataBytes: number;
  /** Bytes that compaction reads back. */
  seqReadBytes: number;
  fsyncs: number;
  /** All bytes written per byte that the user wrote. */
  writeAmp: number;
}

export interface WorkloadResult { mode: EngineMode; profile: IoProfile; opsPerSec: number; usPerOp: { cpu: number; reads: number; writes: number; bandwidth: number; fsync: number } }

export const keyOf = (i: number) => `user${String(i).padStart(6, "0")}`;
const valueOf = (n: number, bytes: number) => (`v${n}-`).padEnd(bytes, "x");

/** Leaf capacity for a page size and value size: entry = key + value + 8-byte version header. */
export const leafCapFor = (pageBytes: number, valueBytes: number) => Math.max(4, Math.floor(pageBytes / (10 + valueBytes + 8)));

/** Runs the workload on one engine and returns its per-operation I/O profile. */
export function measure(mode: EngineMode, s: WorkloadSpec = WL_DEFAULTS): IoProfile {
  const g = measureSteps(mode, s);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

/** The same as `measure`, as a generator that yields after every 200 operations (for demos). */
export function* measureSteps(mode: EngineMode, s: WorkloadSpec = WL_DEFAULTS): Generator<void, IoProfile> {
  const rng = mulberry32(s.seed);
  const order = Array.from({ length: s.keys }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const keyBytes = keyOf(0).length;
  let userBytes = 0;
  const ops = Array.from({ length: s.ops }, () => ({ write: rng() < s.writeFrac, key: keyOf(Math.floor(rng() * s.keys)) }));
  if (mode === "btree") {
    // Load with a large pool, then reopen the checkpointed files with the pool of the experiment.
    const load = new TinyKv({ leafCap: leafCapFor(s.pageBytes, s.valueBytes), innerCap: 128, frames: 4096, groupCommit: s.groupCommit, pageBytes: s.pageBytes });
    for (let i = 0; i < order.length; i += 200) {
      const t = load.begin();
      for (const k of order.slice(i, i + 200)) load.put(t, keyOf(k), valueOf(0, s.valueBytes));
      load.commit(t);
      yield;
    }
    load.checkpoint();
    const e = reopen(load.crash(rng), rng, { frames: Math.max(8, s.frames) });
    e.recover();
    const c0 = e.counters();
    let t = e.begin(), n = 0;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i]!;
      if (o.write) { e.put(t, o.key, valueOf(i + 1, s.valueBytes)); userBytes += keyBytes + s.valueBytes; } else e.get(t, o.key);
      if (++n >= s.opsPerTxn) { e.commit(t); t = e.begin(); n = 0; }
      if ((i + 1) % s.checkpointEvery === 0) e.checkpoint();
      if (i % 200 === 199) yield;
    }
    e.commit(t);
    e.sync();
    e.checkpoint();
    const c = e.counters();
    const d = (k: keyof typeof c) => (c[k] - c0[k]) / s.ops;
    const written = (c.logBytes - c0.logBytes) + (c.pageWrites - c0.pageWrites) * s.pageBytes;
    return { randomReads: d("pageReads"), randomWrites: d("pageWrites"), logBytes: d("logBytes"), fpiBytes: d("fpis") * (s.pageBytes + 28), dataBytes: d("pageWrites") * s.pageBytes, seqReadBytes: 0, fsyncs: d("logFsyncs") + d("dataFsyncs"), writeAmp: userBytes ? written / userBytes : 0 };
  }
  const e = new LsmKv({ memtableBytes: 32 * 1024, baseLevelBytes: 128 * 1024, targetFileBytes: 32 * 1024, blockBytes: s.pageBytes, l0Trigger: 4, sizeRatio: 10 }, s.groupCommit);
  for (let i = 0; i < order.length; i += 200) {
    const t = e.begin();
    for (const k of order.slice(i, i + 200)) e.put(t, keyOf(k), valueOf(0, s.valueBytes));
    e.commit(t);
    yield;
  }
  e.lsm.flush();
  const st0 = { ...e.lsm.stats }, f0 = e.stats.walFsyncs;
  let t = e.begin(), n = 0;
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i]!;
    if (o.write) { e.put(t, o.key, valueOf(i + 1, s.valueBytes)); userBytes += keyBytes + s.valueBytes; } else e.get(t, o.key);
    if (++n >= s.opsPerTxn) {
      try { e.commit(t); } catch (x) { if (!(x instanceof ConflictError)) throw x; }
      t = e.begin(); n = 0;
    }
    if (i % 200 === 199) yield;
  }
  e.commit(t);
  e.lsm.flush();
  const st = e.lsm.stats;
  const files = (st.flushes - st0.flushes) + (st.compactions - st0.compactions);
  const wal = st.walBytes - st0.walBytes;
  const data = (st.flushBytes - st0.flushBytes) + (st.compactWriteBytes - st0.compactWriteBytes);
  return {
    randomReads: (st.getIos - st0.getIos) / s.ops, randomWrites: 0, logBytes: wal / s.ops, fpiBytes: 0, dataBytes: data / s.ops,
    seqReadBytes: (st.compactReadBytes - st0.compactReadBytes) / s.ops, fsyncs: (e.stats.walFsyncs - f0 + files) / s.ops,
    writeAmp: userBytes ? (wal + data) / userBytes : 0,
  };
}

export type FsyncDevice = keyof typeof DEVICES;

/** Device-time model of one operation, in microseconds. */
export function deviceTime(mode: EngineMode, p: IoProfile, fsync: FsyncDevice = "plp", dev: Device = NVME) {
  const us = {
    cpu: dev.cpuPerOp * 1e6,
    reads: (p.randomReads / dev.readIops) * 1e6,
    writes: (mode === "btree" ? p.randomWrites / dev.writeIops : 0) * 1e6,
    bandwidth: ((p.logBytes + (mode === "lsm" ? p.dataBytes : 0) + p.seqReadBytes) / dev.seqBytesPerSec) * 1e6,
    fsync: p.fsyncs * DEVICES[fsync].fsyncMs * 1e3,
  };
  const total = us.cpu + us.reads + us.writes + us.bandwidth + us.fsync;
  return { us, total, opsPerSec: 1e6 / total };
}

export function runWorkload(mode: EngineMode, s: WorkloadSpec = WL_DEFAULTS, fsync: FsyncDevice = "plp"): WorkloadResult {
  const profile = measure(mode, s);
  const t = deviceTime(mode, profile, fsync);
  return { mode, profile, opsPerSec: t.opsPerSec, usPerOp: t.us };
}

/** Write fractions of the sweep plot. */
export const SWEEP = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
