/**
 * A real Merkle tree over key ranges, and the comparison that walks only into subtrees whose hashes differ.
 *
 * The key space is the 32-bit hash of a key, cut into 2^depth equal ranges. A leaf hashes the sorted
 * (key, hash of value) pairs in its range. An inner node hashes the hashes of its two children. Two replicas with
 * the same data in a range have the same hash for it, so a matching hash lets the comparison skip the range.
 *
 * The sim uses a 64-bit hash built from two MurmurHash3 runs. That is fine for a demo; a real system wants a
 * stronger hash, because a collision would hide a difference.
 */
import { murmur3 } from "../../db/lsm/hash";
import { mulberry32 } from "../../rng";

export type Data = Map<string, string>;

const hex8 = (x: number) => x.toString(16).padStart(8, "0");
export const h64 = (s: string) => hex8(murmur3(s, 0x9747b28c)) + hex8(murmur3(s, 0x5bd1e995));

/** Leaf index of a key: the top `depth` bits of its 32-bit hash. */
export const leafOf = (key: string, depth: number) => (depth === 0 ? 0 : murmur3(key) >>> (32 - depth));

export interface MerkleTree {
  depth: number;
  /** hashes[level][i]: level 0 is the root, level `depth` holds the 2^depth leaves. */
  hashes: string[][];
  /** The sorted keys of each leaf range. */
  leaves: string[][];
  data: Data;
}

export function buildTree(data: Data, depth: number): MerkleTree {
  const L = 1 << depth;
  const leaves: string[][] = Array.from({ length: L }, () => []);
  for (const k of data.keys()) leaves[leafOf(k, depth)]!.push(k);
  for (const l of leaves) l.sort();
  const hashes: string[][] = new Array(depth + 1);
  hashes[depth] = leaves.map((keys) => h64(keys.map((k) => `${k}=${h64(data.get(k)!)}`).join(";")));
  for (let lv = depth - 1; lv >= 0; lv--) {
    const below = hashes[lv + 1]!;
    hashes[lv] = Array.from({ length: 1 << lv }, (_, i) => h64(below[2 * i]! + below[2 * i + 1]!));
  }
  return { depth, hashes, leaves, data };
}

/** Sizes on the wire (model inputs), bytes. */
export interface WireCost {
  hash: number;
  key: number;
  value: number;
}
export const WIRE_DEFAULT: WireCost = { hash: 8, key: 16, value: 200 };

export interface Visit {
  level: number;
  index: number;
  equal: boolean;
}

export interface MerkleDiff {
  /** Keys whose value differs, or that only one side has, sorted. */
  keys: string[];
  /** The nodes compared, in the order of the walk (level by level). */
  visits: Visit[];
  /** Leaves whose key lists were exchanged. */
  leafLists: number[];
  bytes: { hashes: number; lists: number; values: number; total: number };
}

/**
 * Compares two trees of the same depth, breadth first. A node whose hashes match is skipped with all its
 * subtree. At a leaf that differs, B sends its (key, value hash) list for the range, A finds the differing keys,
 * and the newer values cross the network.
 */
export function diffTrees(a: MerkleTree, b: MerkleTree, wire: WireCost = WIRE_DEFAULT): MerkleDiff {
  if (a.depth !== b.depth) throw new Error("trees must have the same depth");
  const visits: Visit[] = [];
  const leafLists: number[] = [];
  const keys: string[] = [];
  let frontier = [0];
  for (let lv = 0; lv <= a.depth && frontier.length; lv++) {
    const next: number[] = [];
    for (const i of frontier) {
      const equal = a.hashes[lv]![i] === b.hashes[lv]![i];
      visits.push({ level: lv, index: i, equal });
      if (equal) continue;
      if (lv < a.depth) next.push(2 * i, 2 * i + 1);
      else leafLists.push(i);
    }
    frontier = next;
  }
  let listEntries = 0;
  for (const i of leafLists) {
    const ka = a.leaves[i]!, kb = b.leaves[i]!;
    listEntries += kb.length;
    for (const k of new Set([...ka, ...kb])) if (a.data.get(k) !== b.data.get(k)) keys.push(k);
  }
  keys.sort();
  const hashes = visits.length * wire.hash;
  const lists = listEntries * (wire.key + wire.hash);
  const values = keys.length * wire.value;
  return { keys, visits, leafLists, bytes: { hashes, lists, values, total: hashes + lists + values } };
}

/** The keys that differ, by brute force: the answer that diffTrees must give. */
export function bruteDiff(a: Data, b: Data): string[] {
  const out: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) out.push(k);
  return out.sort();
}

export const keyName = (i: number) => `user:${String(i).padStart(5, "0")}`;

/** `n` keys with values, and a copy in which `d` random keys have a new value. */
export function makePair(n: number, d: number, seed: number): { a: Data; b: Data; changed: string[] } {
  const rng = mulberry32(seed);
  const a: Data = new Map();
  for (let i = 0; i < n; i++) a.set(keyName(i), `v${Math.floor(rng() * 1e9)}`);
  const b: Data = new Map(a);
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < Math.min(d, n); i++) {
    const j = i + Math.floor(rng() * (n - i));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const changed = idx.slice(0, Math.min(d, n)).map(keyName);
  for (const k of changed) b.set(k, `${b.get(k)}*`);
  return { a, b, changed: changed.sort() };
}

export interface SweepPoint {
  d: number;
  merkle: number;
  /** Send every key with its value hash, and then the differing values. */
  allHashes: number;
  /** Send every key with its value. */
  allValues: number;
  hashesCompared: number;
}

/** Bytes to repair `d` differing keys among `n`, averaged over `trials` random placements. */
export function sweepPoint(n: number, depth: number, d: number, trials = 3, wire: WireCost = WIRE_DEFAULT, seed = 1): SweepPoint {
  let merkle = 0, compared = 0;
  for (let t = 0; t < trials; t++) {
    const { a, b } = makePair(n, d, seed * 1000 + t);
    const r = diffTrees(buildTree(a, depth), buildTree(b, depth), wire);
    merkle += r.bytes.total;
    compared += r.visits.length;
  }
  return {
    d,
    merkle: merkle / trials,
    allHashes: n * (wire.key + wire.hash) + d * wire.value,
    allValues: n * (wire.key + wire.value),
    hashesCompared: compared / trials,
  };
}

export const SWEEP_DS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
