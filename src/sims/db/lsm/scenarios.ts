/** Fixed scenarios shared by the LSM demos and the tests that pin the numbers in the lessons. */
import { mulberry32, type Rng } from "../../rng";
import { LsmTree, type LsmOptions, type Strategy } from "./engine";
import { seekBlock, type KV } from "./block";

/** The starting state of the write/read-path stepper: two L0 files, and a memtable with a tombstone. */
export function stepperSeedTree(): LsmTree {
  const t = new LsmTree({ memtableBytes: 1e9, autoFlush: false, autoCompact: false, maxImmutable: 2, blockBytes: 32, bloomBitsPerKey: 10, targetFileBytes: 48, baseLevelBytes: 1e9, maxLevels: 2 });
  t.put("apple", "red"); t.put("fig", "purple"); t.put("lemon", "yellow"); t.flush();
  t.put("banana", "yellow"); t.put("apple", "green"); t.put("date", "brown"); t.flush();
  t.put("cherry", "red"); t.del("fig");
  return t;
}

export type KeySet = "user" | "url" | "hex";
/** Sorted keys for the block-format demo, with 8-byte values. */
export function blockKeys(set: KeySet, n = 64): KV[] {
  const rng = mulberry32(11);
  const keys = new Set<string>();
  const fields = ["email", "name", "plan"];
  const cats = ["books", "garden", "kitchen", "toys"];
  while (keys.size < n) {
    if (set === "user") keys.add(`user:${String(10000 + Math.floor(rng() * 400)).padStart(6, "0")}:${fields[Math.floor(rng() * 3)]}`);
    else if (set === "url") keys.add(`https://shop.example/${cats[Math.floor(rng() * 4)]}/item/${Math.floor(rng() * 90000) + 10000}`);
    else keys.add(Array.from({ length: 16 }, () => "0123456789abcdef"[Math.floor(rng() * 16)]).join(""));
  }
  return [...keys].sort().map((key, i) => ({ key, value: `v${String(i).padStart(7, "0")}` }));
}

/** Average restart-point probes and scanned entries for a seek to each key of the block. */
export function avgSeekCost(block: Uint8Array, kvs: KV[]) {
  let probes = 0, scanned = 0;
  for (const kv of kvs) { const s = seekBlock(block, kv.key); probes += s.restartProbes; scanned += s.scanned; }
  return { probes: probes / kvs.length, scanned: scanned / kvs.length };
}

/** Small trees so that the shape shows after a few thousand writes: 2 KiB memtables, 40-byte entries. */
export const RACE_MEMTABLE = 2048;
export const raceOptions = (strategy: Strategy, T: number): Partial<LsmOptions> => ({
  strategy, sizeRatio: T, memtableBytes: RACE_MEMTABLE, baseLevelBytes: 4 * RACE_MEMTABLE, targetFileBytes: RACE_MEMTABLE,
  l0Trigger: 4, bloomBitsPerKey: 0, blockBytes: 512, maxLevels: 12,
});

export type Stream = "insert" | "update";
/** Key stream: inserts spread over 10 million keys, or updates to 2,000 hot keys. Entries are 40 bytes. */
export function nextWrite(rng: Rng, stream: Stream): [string, string] {
  const k = Math.floor(rng() * (stream === "insert" ? 1e7 : 2000));
  return [`k${String(k).padStart(7, "0")}`, "v".repeat(24)];
}

export const SWEEP_T = [2, 3, 4, 5, 6, 8, 10, 12, 16];
export const SWEEP_WRITES = 20000;
export interface SweepPoint { strategy: Strategy; T: number; wa: number; runs: number; sa: number }

/** Feeds `writes` writes into a fresh tree; samples sorted runs and space amp every 250 writes. Yields every `slice` writes. */
export function* sweepRun(strategy: Strategy, T: number, stream: Stream, writes = SWEEP_WRITES, slice = 1000): Generator<undefined, SweepPoint> {
  const t = new LsmTree(raceOptions(strategy, T));
  const rng = mulberry32(7);
  let runs = 0, sa = 0, samples = 0;
  for (let i = 1; i <= writes; i++) {
    const [k, v] = nextWrite(rng, stream);
    t.put(k, v);
    if (i % 250 === 0) { runs += t.sortedRuns(); sa += t.spaceAmp(); samples++; }
    if (i % slice === 0) yield;
  }
  return { strategy, T, wa: t.writeAmp(), runs: runs / samples, sa: sa / samples };
}

/** Runs a generator to the end. */
export function finish<R>(g: Generator<unknown, R>): R { for (;;) { const r = g.next(); if (r.done) return r.value; } }
