/**
 * The LevelDB / RocksDB data block format, byte for byte (without compression and checksum).
 *
 *   entry   := shared:varint32 non_shared:varint32 value_len:varint32 key_delta[non_shared] value[value_len]
 *   trailer := restarts:uint32[num_restarts] num_restarts:uint32     (little endian)
 *
 * `shared` is the length of the prefix that the key shares with the previous key.
 * Every `restartInterval` entries (block_restart_interval, default 16) the key is stored in full
 * (shared = 0) and its offset goes into the restart array. A seek binary-searches the restart
 * points, then scans forward at most restartInterval entries.
 * In a file, each block is followed by a 5-byte trailer: 1 byte compression type + 4 bytes CRC32C.
 */

export const DEFAULT_RESTART_INTERVAL = 16;
/** Compression type byte + masked CRC32C after each block in the file. */
export const BLOCK_TRAILER_BYTES = 5;
/** LevelDB/RocksDB table footer: two block handles padded to 40 bytes + 8-byte magic number. */
export const FOOTER_BYTES = 48;

export interface KV { key: string; value: string }

export interface EntryLayout {
  key: string;
  offset: number;
  shared: number;
  nonShared: number;
  valueLen: number;
  /** Bytes of the three varints. */
  headerBytes: number;
  /** Total bytes of this entry. */
  bytes: number;
  restart: boolean;
}

export interface EncodedBlock {
  bytes: Uint8Array;
  layout: EntryLayout[];
  restarts: number[];
  /** Bytes of all entries (without the restart array). */
  entryBytes: number;
  /** Bytes of the restart array and its count. */
  trailerBytes: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const varintLen = (v: number) => { let n = 1; while (v >= 128) { v = Math.floor(v / 128); n++; } return n; };

function putVarint(out: number[], v: number) {
  while (v >= 128) { out.push((v & 127) | 128); v = Math.floor(v / 128); }
  out.push(v);
}
function getVarint(b: Uint8Array, at: number): [number, number] {
  let v = 0, shift = 0, i = at;
  for (;;) {
    const x = b[i++]!;
    v += (x & 127) * 2 ** shift;
    if (x < 128) return [v, i];
    shift += 7;
  }
}
const putU32 = (out: number[], v: number) => out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
const getU32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

const sharedPrefix = (a: Uint8Array, b: Uint8Array) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

/** Encodes sorted entries into one block. With prefixCompression = false, every key is stored in full. */
export function encodeBlock(entries: KV[], restartInterval = DEFAULT_RESTART_INTERVAL, prefixCompression = true): EncodedBlock {
  const out: number[] = [];
  const layout: EntryLayout[] = [];
  const restarts: number[] = [];
  let prev = new Uint8Array(0);
  entries.forEach((e, i) => {
    const key = enc.encode(e.key), val = enc.encode(e.value);
    const restart = i % restartInterval === 0;
    if (restart) restarts.push(out.length);
    const shared = restart || !prefixCompression ? 0 : sharedPrefix(prev, key);
    const nonShared = key.length - shared;
    const offset = out.length;
    putVarint(out, shared); putVarint(out, nonShared); putVarint(out, val.length);
    const headerBytes = out.length - offset;
    for (let j = shared; j < key.length; j++) out.push(key[j]!);
    for (const x of val) out.push(x);
    layout.push({ key: e.key, offset, shared, nonShared, valueLen: val.length, headerBytes, bytes: out.length - offset, restart });
    prev = key;
  });
  const entryBytes = out.length;
  if (!restarts.length) restarts.push(0);
  for (const r of restarts) putU32(out, r);
  putU32(out, restarts.length);
  return { bytes: Uint8Array.from(out), layout, restarts, entryBytes, trailerBytes: out.length - entryBytes };
}

/** Decodes all entries of a block, with the byte offset of each entry. */
export function decodeBlockWithOffsets(b: Uint8Array): (KV & { offset: number })[] {
  const n = getU32(b, b.length - 4);
  const end = b.length - 4 - 4 * n;
  const out: (KV & { offset: number })[] = [];
  let at = 0, key = new Uint8Array(0);
  while (at < end) {
    const [shared, a1] = getVarint(b, at);
    const [nonShared, a2] = getVarint(b, a1);
    const [vlen, a3] = getVarint(b, a2);
    const k = new Uint8Array(shared + nonShared);
    k.set(key.subarray(0, shared));
    k.set(b.subarray(a3, a3 + nonShared), shared);
    key = k;
    out.push({ key: dec.decode(k), value: dec.decode(b.subarray(a3 + nonShared, a3 + nonShared + vlen)), offset: at });
    at = a3 + nonShared + vlen;
  }
  return out;
}

/** Decodes all entries of a block. */
export const decodeBlock = (b: Uint8Array): KV[] => decodeBlockWithOffsets(b).map(({ key, value }) => ({ key, value }));

/**
 * Seek: find the first key >= target. Binary search over the restart points (each holds a full key),
 * then a linear scan. Returns the index of the found entry (or -1) and the work done.
 */
export function seekBlock(b: Uint8Array, target: string): { index: number; key: string | null; restartProbes: number; scanned: number } {
  const n = getU32(b, b.length - 4);
  const end = b.length - 4 - 4 * n;
  const restart = (i: number) => getU32(b, end + 4 * i);
  const fullKeyAt = (off: number) => {
    const [, a1] = getVarint(b, off);
    const [nonShared, a2] = getVarint(b, a1);
    const [, a3] = getVarint(b, a2);
    return dec.decode(b.subarray(a3, a3 + nonShared));
  };
  // Last restart point whose key < target.
  let lo = 0, hi = n - 1, probes = 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    probes++;
    if (fullKeyAt(restart(mid)) < target) lo = mid; else hi = mid - 1;
  }
  // Scan forward from that restart point.
  const all = decodeBlockWithOffsets(b);
  const idx = Math.max(0, all.findIndex((e) => e.offset === restart(lo)));
  let scanned = 0;
  for (let i = idx; i < all.length; i++) {
    scanned++;
    if (all[i]!.key >= target) return { index: i, key: all[i]!.key, restartProbes: probes, scanned };
  }
  return { index: -1, key: null, restartProbes: probes, scanned };
}

/**
 * LevelDB's FindShortestSeparator: a short key s with a <= s < b, used as the index-block entry
 * between two data blocks (the index stores s in place of the full last key of the block).
 */
export function shortestSeparator(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i >= n) return a; // one is a prefix of the other
  const c = a.charCodeAt(i);
  if (c < 0xff && c + 1 < b.charCodeAt(i)) return a.slice(0, i) + String.fromCharCode(c + 1);
  return a;
}

/** LevelDB's FindShortSuccessor: a short key >= a (for the index entry after the last block). */
export function shortSuccessor(a: string): string {
  for (let i = 0; i < a.length; i++) {
    const c = a.charCodeAt(i);
    if (c !== 0xff) return a.slice(0, i) + String.fromCharCode(c + 1);
  }
  return a;
}

export interface TableLayout {
  dataBlocks: { first: string; last: string; entries: number; bytes: number }[];
  dataBytes: number;
  filterBytes: number;
  indexBytes: number;
  metaindexBytes: number;
  footerBytes: number;
  totalBytes: number;
  indexKeys: string[];
}

/**
 * Lays out a whole SSTable file: data blocks (cut when they reach blockBytes), one filter block,
 * a metaindex block, an index block (separator key → block handle), and the 48-byte footer.
 * Block handle = varint64 offset + varint64 size. Filter: bitsPerKey per key + 1 byte, as in LevelDB
 * (LevelDB keeps one filter per 2 KiB of data; one filter per table here, as in RocksDB full filters).
 */
export function layoutTable(entries: KV[], blockBytes = 4096, restartInterval = DEFAULT_RESTART_INTERVAL, bitsPerKey = 10): TableLayout {
  const blocks: KV[][] = [];
  let cur: KV[] = [], size = 0;
  for (const e of entries) {
    cur.push(e);
    size += e.key.length + e.value.length + 3;
    if (size >= blockBytes) { blocks.push(cur); cur = []; size = 0; }
  }
  if (cur.length) blocks.push(cur);
  const dataBlocks = blocks.map((b) => ({ first: b[0]!.key, last: b[b.length - 1]!.key, entries: b.length, bytes: encodeBlock(b, restartInterval).bytes.length + BLOCK_TRAILER_BYTES }));
  const dataBytes = dataBlocks.reduce((s, b) => s + b.bytes, 0);
  const filterBytes = bitsPerKey > 0 ? Math.ceil((entries.length * bitsPerKey) / 8) + 1 + BLOCK_TRAILER_BYTES : 0;
  let off = 0;
  const indexKeys: string[] = [];
  const index: KV[] = dataBlocks.map((b, i) => {
    const next = dataBlocks[i + 1];
    const key = next ? shortestSeparator(b.last, next.first) : shortSuccessor(b.last);
    indexKeys.push(key);
    const handle = String.fromCharCode(...new Array(varintLen(off) + varintLen(b.bytes - BLOCK_TRAILER_BYTES)).fill(0));
    off += b.bytes;
    return { key, value: handle };
  });
  const indexBytes = encodeBlock(index, 1).bytes.length + BLOCK_TRAILER_BYTES;
  const metaindexBytes = bitsPerKey > 0 ? encodeBlock([{ key: "filter.leveldb.BuiltinBloomFilter2", value: "\0\0\0\0" }], 1).bytes.length + BLOCK_TRAILER_BYTES : 8 + BLOCK_TRAILER_BYTES;
  return { dataBlocks, dataBytes, filterBytes, indexBytes, metaindexBytes, footerBytes: FOOTER_BYTES, totalBytes: dataBytes + filterBytes + indexBytes + metaindexBytes + FOOTER_BYTES, indexKeys };
}
