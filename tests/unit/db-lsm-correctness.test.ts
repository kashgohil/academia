/** Correctness of the LSM reference implementation: property tests against simple references. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  SkipList, BloomFilter, BlockedBloomFilter, encodeBlock, decodeBlock, seekBlock, shortestSeparator, shortSuccessor,
  LsmTree, SSTable, hashPair as hp, collectGarbage, compareEntries, mergeSorted, type Entry, type LsmOptions,
} from "@/sims/db/lsm";

const key = (i: number) => `k${String(i).padStart(4, "0")}`;

describe("skip list", () => {
  test("random inserts stay sorted, get finds every key, replace keeps size", () => {
    const rng = mulberry32(3);
    const s = new SkipList<number, number>((a, b) => a - b, { p: 0.5, seed: 9 });
    const ref = new Map<number, number>();
    for (let i = 0; i < 2000; i++) {
      const k = Math.floor(rng() * 500), v = i;
      s.insert(k, v); ref.set(k, v);
    }
    const sorted = [...ref.keys()].sort((a, b) => a - b);
    expect([...s.entries()].map(([k]) => k)).toEqual(sorted);
    expect(s.size).toBe(ref.size);
    for (const [k, v] of ref) expect(s.get(k)).toBe(v);
    expect(s.get(-1)).toBeUndefined();
    expect([...s.seek(250)][0]![0]).toBe(sorted.find((k) => k >= 250));
    for (const n of s.nodes()) expect(n.height).toBeLessThanOrEqual(12);
  });
  test("a search path ends at the target and only moves right or down", () => {
    const s = new SkipList<number, null>((a, b) => a - b, { p: 0.5, seed: 4 });
    for (let i = 0; i < 64; i++) s.insert(i * 2, null);
    const r = s.search(40);
    expect(r.found).toBe(true);
    expect(r.path.at(-1)!.key).toBe(40);
    for (let i = 1; i < r.path.length; i++) expect(r.path[i]!.level).toBeLessThanOrEqual(r.path[i - 1]!.level);
    expect(s.search(41).found).toBe(false);
  });
});

describe("Bloom filters", () => {
  test("no false negatives, for the plain and the blocked filter", () => {
    const keys = Array.from({ length: 3000 }, (_, i) => `user:${i}`);
    const f = BloomFilter.forKeys(keys, 10);
    const b = new BlockedBloomFilter(30000, 7);
    for (const k of keys) b.addHash(hp(k));
    for (const k of keys) { expect(f.mayContain(k)).toBe(true); expect(b.mayContainHash(hp(k))).toBe(true); }
  });
});

describe("data blocks", () => {
  const rng = mulberry32(5);
  const keys = [...new Set(Array.from({ length: 300 }, () => `user:${Math.floor(rng() * 5000)}:${["name", "mail", "age"][Math.floor(rng() * 3)]}`))].sort();
  const kvs = keys.map((k, i) => ({ key: k, value: `v${i}` }));
  test.each([1, 4, 16, 64])("round trip and seek, restart interval %i", (ri) => {
    const b = encodeBlock(kvs, ri);
    expect(decodeBlock(b.bytes)).toEqual(kvs);
    expect(b.restarts.length).toBe(Math.ceil(kvs.length / ri));
    for (const t of ["a", "user:1", "user:2500:mail", keys[17]!, keys.at(-1)!, "zzz"]) {
      const s = seekBlock(b.bytes, t);
      const want = keys.findIndex((k) => k >= t);
      expect(s.index).toBe(want);
      expect(s.scanned).toBeLessThanOrEqual(ri + 1);
    }
  });
  test("separators sit between two keys", () => {
    for (let i = 1; i < keys.length; i++) {
      const s = shortestSeparator(keys[i - 1]!, keys[i]!);
      expect(s >= keys[i - 1]! && s < keys[i]!).toBe(true);
    }
    expect(shortestSeparator("the quick brown fox", "the who")).toBe("the r");
    expect(shortSuccessor("abc") >= "abc").toBe(true);
  });
});

describe("SSTable and merge helpers", () => {
  test("merge keeps internal-key order and GC keeps the newest visible version", () => {
    const e = (k: string, seq: number, kind: Entry["kind"] = "put"): Entry => ({ key: k, seq, kind, value: kind === "put" ? `v${seq}` : "" });
    const m = mergeSorted([[e("a", 5), e("b", 2)], [e("a", 7, "del"), e("c", 1)], [e("a", 1)]]);
    expect(m.map((x) => `${x.key}${x.seq}`)).toEqual(["a7", "a5", "a1", "b2", "c1"]);
    for (let i = 1; i < m.length; i++) expect(compareEntries(m[i - 1]!, m[i]!)).toBeLessThan(0);
    // No snapshots: only the tombstone a7 is visible for a; it can go only at the bottom.
    expect(collectGarbage(m, 10, () => false).out.map((x) => `${x.key}${x.seq}`)).toEqual(["a7", "b2", "c1"]);
    expect(collectGarbage(m, 10, () => true).out.map((x) => `${x.key}${x.seq}`)).toEqual(["b2", "c1"]);
    // A snapshot at seq 6 still sees a5.
    expect(collectGarbage(m, 6, () => true).out.map((x) => `${x.key}${x.seq}`)).toEqual(["a7", "a5", "b2", "c1"]);
  });
  test("SSTable get follows versions across a block boundary", () => {
    const es: Entry[] = Array.from({ length: 40 }, (_, i) => ({ key: "same", seq: 100 - i, kind: "put", value: `v${100 - i}` }));
    const t = new SSTable(es, { blockBytes: 64, bloomBitsPerKey: 10 });
    expect(t.blocks.length).toBeGreaterThan(3);
    const g = t.get("same", 65);
    expect(g.entry?.seq).toBe(65);
    expect(g.blocksRead).toBeGreaterThan(1);
    expect(t.get("same", 10).result).toBe("miss");
  });
});

function randomOps(opts: Partial<LsmOptions>, seed: number, n: number, keySpace: number) {
  const rng = mulberry32(seed);
  const t = new LsmTree(opts);
  const ref = new Map<string, string>();
  const snaps: { seq: number; view: Map<string, string> }[] = [];
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(rng() * keySpace));
    const r = rng();
    if (r < 0.55) { const v = `v${i}-${"x".repeat(Math.floor(rng() * 20))}`; t.put(k, v); ref.set(k, v); }
    else if (r < 0.75) { t.del(k); ref.delete(k); }
    else if (r < 0.995) expect(t.get(k).value, `op ${i} get ${k}`).toBe(ref.get(k));
    else if (snaps.length < 4) snaps.push({ seq: t.snapshot(), view: new Map(ref) });
    if (i % 997 === 0 && !opts.autoFlush) t.flush();
    if (i % 1499 === 0 && !opts.autoCompact) t.compactAll();
  }
  return { t, ref, snaps };
}

describe("LsmTree against a Map", () => {
  const cases: [string, Partial<LsmOptions>][] = [
    ["leveled", { strategy: "leveled", memtableBytes: 600, baseLevelBytes: 2400, targetFileBytes: 600, sizeRatio: 3, blockBytes: 128 }],
    ["leveled, no filters", { strategy: "leveled", memtableBytes: 900, baseLevelBytes: 2000, targetFileBytes: 400, sizeRatio: 4, bloomBitsPerKey: 0 }],
    ["tiered", { strategy: "tiered", memtableBytes: 600, sizeRatio: 3, targetFileBytes: 800, blockBytes: 128, maxLevels: 8 }],
    ["tiered, T = 2", { strategy: "tiered", memtableBytes: 500, sizeRatio: 2, targetFileBytes: 1000, maxLevels: 6 }],
    ["manual flush and compaction", { strategy: "leveled", memtableBytes: 500, baseLevelBytes: 1500, sizeRatio: 3, autoFlush: false, autoCompact: false, maxImmutable: 2 }],
  ];
  test.each(cases)("%s: random put / delete / get, snapshots, scans", (_, opts) => {
    for (const seed of [1, 2, 3]) {
      const { t, ref, snaps } = randomOps(opts, seed, 6000, 300);
      expect(t.stats.flushes).toBeGreaterThan(20);
      expect(t.stats.compactions + t.stats.trivialMoves).toBeGreaterThan(5);
      expect(t.checkInvariants()).toEqual([]);
      for (let i = 0; i < 300; i++) expect(t.get(key(i)).value).toBe(ref.get(key(i)));
      for (const s of snaps) for (let i = 0; i < 300; i++) expect(t.get(key(i), s.seq).value, `snapshot ${s.seq} ${key(i)}`).toBe(s.view.get(key(i)));
      const want = [...ref.entries()].filter(([k]) => k >= key(50) && k <= key(120)).sort(([a], [b]) => (a < b ? -1 : 1));
      expect(t.scan(key(50), key(120)).rows).toEqual(want);
      expect(t.liveKeys()).toBe(ref.size);
    }
  });

  test("tombstones disappear once they reach the bottom", () => {
    const t = new LsmTree({ strategy: "leveled", memtableBytes: 400, baseLevelBytes: 800, sizeRatio: 2, targetFileBytes: 400, maxLevels: 4 });
    for (let i = 0; i < 400; i++) t.put(key(i), "value");
    for (let i = 0; i < 400; i++) t.del(key(i));
    for (let i = 0; i < 400; i++) t.put(key(1000 + i), "value"); // more writes push data down
    t.flush();
    expect(t.stats.droppedTombstones).toBeGreaterThan(0);
    for (let i = 0; i < 400; i++) expect(t.get(key(i)).value).toBeUndefined();
  });

  test("crash recovery: SSTs plus a WAL replay give the same answers", () => {
    const { t, ref } = randomOps({ strategy: "leveled", memtableBytes: 700, baseLevelBytes: 2000, sizeRatio: 3 }, 7, 3000, 200);
    expect(t.wal.length).toBeGreaterThan(0);
    const r = new LsmTree(t.opts);
    r.levels = t.levels; // the SST files survive the crash
    r.replay(t.walAfterCrash());
    for (let i = 0; i < 200; i++) expect(r.get(key(i)).value).toBe(ref.get(key(i)));
    expect(r.seq).toBe(t.seq);
  });

  test("a get reports where it found the answer", () => {
    const t = new LsmTree({ memtableBytes: 1e9, autoFlush: false });
    t.put("a", "1"); t.flush(); t.put("b", "2");
    const g = t.get("a");
    expect(g.value).toBe("1");
    expect(g.probes.map((p) => p.result)).toEqual(["miss", "found"]);
    expect(g.probes[1]!.level).toBe(0);
    t.del("a");
    expect(t.get("a").probes.map((p) => p.result)).toEqual(["deleted"]);
  });
});
