/**
 * The capstone engine module: the wave-1 sims composed into one embedded key-value engine.
 *
 *   import { TinyKv, LsmKv, replay, randomTrace, shrink, Campaign } from "@/sims/db/engine";
 *
 * - kv.ts        TinyKv: B+ tree pages over storage/BufferPool, CRC-32C pages, an ARIES WAL with
 *                full-page images and CLRs, snapshot isolation with version chains, group commit,
 *                checkpoints, crash() and recover(); deliberate bugs and fault injection.
 * - lsmkv.ts     LsmKv: lsm/LsmTree behind the same transactional interface (KvLike).
 * - fuzz.ts      crash fuzzer: random traces, crash points at every write and fsync (also inside
 *                recovery), the oracle, a campaign runner and a delta-debugging shrinker.
 * - workload.ts  the same workload on both engines: measured I/O per operation and a device-time model.
 * - design.ts    the layers, a per-layer trace of one operation, the design space and real engines.
 * - compare.ts   SQLite, LMDB and RocksDB: the steps of one put(), and a workload-fit model.
 */
export * from "./kv";
export * from "./lsmkv";
export * from "./fuzz";
export * from "./workload";
export * from "./design";
export * from "./compare";
