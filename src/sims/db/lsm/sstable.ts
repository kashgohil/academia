/**
 * Entries, internal-key order, and an in-memory SSTable: a sorted array cut into blocks,
 * with fence pointers (first and last key of each block) and an optional Bloom filter.
 * Sizes follow LevelDB: an entry costs key + value + 8 bytes (the 8-byte trailer holds
 * a 56-bit sequence number and a 1-byte type).
 */
import { BloomFilter, levelDbK } from "./bloom";

export type Kind = "put" | "del";
export interface Entry { key: string; seq: number; kind: Kind; value: string }

/** Bytes of the sequence-number-and-type trailer that LevelDB appends to every user key. */
export const ENTRY_TRAILER = 8;
export const entryBytes = (e: Entry) => e.key.length + e.value.length + ENTRY_TRAILER;

/** Internal-key order: user key ascending, then sequence number descending (newest first). */
export const compareEntries = (a: Entry, b: Entry) => (a.key < b.key ? -1 : a.key > b.key ? 1 : b.seq - a.seq);

export interface BlockMeta { first: string; last: string; start: number; end: number; bytes: number }

/**
 * fence-skip: the key is outside the file's key range; bloom-skip: the filter said "not here";
 * miss: the file was read but has no visible version; found / deleted: a put / a tombstone answers.
 */
export type SstResult = "fence-skip" | "bloom-skip" | "miss" | "found" | "deleted";
/** falsePositive: the filter said "maybe", but the key is not in the file at all. */
export interface SstGet { result: SstResult; entry?: Entry; blocksRead: number; falsePositive?: boolean }

export interface TableOptions { blockBytes: number; bloomBitsPerKey: number }

let nextFileId = 1;

export class SSTable {
  readonly id: number;
  readonly entries: readonly Entry[];
  readonly blocks: BlockMeta[];
  readonly bloom: BloomFilter | null;
  readonly bytes: number;
  readonly minKey: string;
  readonly maxKey: string;
  readonly maxSeq: number;
  readonly tombstones: number;

  /** `entries` must be sorted by compareEntries and non-empty. LsmTree passes its own file numbers. */
  constructor(entries: Entry[], opts: TableOptions, id = nextFileId++) {
    this.id = id;
    this.entries = entries;
    this.blocks = [];
    let start = 0, size = 0, total = 0, maxSeq = 0, tomb = 0;
    entries.forEach((e, i) => {
      const b = entryBytes(e);
      size += b; total += b;
      if (e.seq > maxSeq) maxSeq = e.seq;
      if (e.kind === "del") tomb++;
      if (size >= opts.blockBytes || i === entries.length - 1) {
        this.blocks.push({ first: entries[start]!.key, last: e.key, start, end: i + 1, bytes: size });
        start = i + 1; size = 0;
      }
    });
    const keys = new Set(entries.map((e) => e.key));
    this.bloom = opts.bloomBitsPerKey > 0 ? BloomFilter.forKeys(keys, opts.bloomBitsPerKey, levelDbK(opts.bloomBitsPerKey)) : null;
    this.bytes = total;
    this.minKey = entries[0]!.key;
    this.maxKey = entries[entries.length - 1]!.key;
    this.maxSeq = maxSeq;
    this.tombstones = tomb;
  }

  overlaps(lo: string, hi: string) { return !(this.maxKey < lo || this.minKey > hi); }
  covers(key: string) { return key >= this.minKey && key <= this.maxKey; }

  /**
   * Point lookup: fence check on the file range, Bloom filter, then a binary search of the
   * block fence pointers and one block read. If the versions of a key continue into the next
   * block, that block is read too.
   */
  get(key: string, snapshot = Infinity): SstGet {
    if (!this.covers(key)) return { result: "fence-skip", blocksRead: 0 };
    if (this.bloom && !this.bloom.mayContain(key)) return { result: "bloom-skip", blocksRead: 0 };
    let lo = 0, hi = this.blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.blocks[mid]!.last < key) lo = mid + 1; else hi = mid;
    }
    let blocksRead = 0, seen = false;
    const miss = (): SstGet => ({ result: "miss", blocksRead, falsePositive: !!this.bloom && !seen });
    for (let b = lo; b < this.blocks.length; b++) {
      const blk = this.blocks[b]!;
      if (blk.first > key) break;
      blocksRead++;
      for (let i = blk.start; i < blk.end; i++) {
        const e = this.entries[i]!;
        if (e.key > key) return miss();
        if (e.key === key) {
          seen = true;
          if (e.seq <= snapshot) return { result: e.kind === "del" ? "deleted" : "found", entry: e, blocksRead };
        }
      }
    }
    return miss();
  }

  /** Number of blocks that a scan of [lo, hi] reads. */
  blocksFor(lo: string, hi: string) {
    return this.blocks.filter((b) => !(b.last < lo || b.first > hi)).length;
  }
}

/** k-way merge of sorted entry lists into one sorted list (internal-key order). */
export function mergeSorted(lists: readonly (readonly Entry[])[]): Entry[] {
  const idx = lists.map(() => 0);
  const out: Entry[] = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      const e = lists[i]![idx[i]!];
      if (e && (best < 0 || compareEntries(e, lists[best]![idx[best]!]!) < 0)) best = i;
    }
    if (best < 0) return out;
    out.push(lists[best]![idx[best]!++]!);
  }
}

/**
 * Drops versions that no reader can see (LevelDB's DoCompactionWork rule).
 * - An older version is dropped when a newer version of the same key is already visible at the
 *   smallest live snapshot.
 * - A tombstone is dropped when it is visible at that snapshot and no older data for the key can
 *   exist below the output (canDropTombstone(key) is true).
 */
export function collectGarbage(sorted: readonly Entry[], smallestSnapshot: number, canDropTombstone: (key: string) => boolean) {
  const out: Entry[] = [];
  let lastKey: string | null = null, lastSeq = Infinity, droppedVersions = 0, droppedTombstones = 0;
  for (const e of sorted) {
    if (e.key !== lastKey) { lastKey = e.key; lastSeq = Infinity; }
    let drop = false;
    if (lastSeq <= smallestSnapshot) { drop = true; droppedVersions++; }
    else if (e.kind === "del" && e.seq <= smallestSnapshot && canDropTombstone(e.key)) { drop = true; droppedTombstones++; }
    lastSeq = e.seq;
    if (!drop) out.push(e);
  }
  return { out, droppedVersions, droppedTombstones };
}
