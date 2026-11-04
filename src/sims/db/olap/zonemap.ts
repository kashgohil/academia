/**
 * Zone maps (min/max per block), Z-order clustering and Bloom-filter skip indexes.
 *
 * A table of rows (a, b), both in 0..DOMAIN−1, is stored in blocks of BLOCK_ROWS rows. For each block
 * the zone map keeps min and max of each column. A query with a range predicate scans only the
 * blocks whose [min, max] overlaps the predicate. Pruning never drops a matching row: if a block
 * holds a value inside the range, its [min, max] must overlap the range.
 */
import { mulberry32 } from "../../rng";
import { BloomFilter } from "../lsm/bloom";

export const DOMAIN = 1024;
export const ZONE_ROWS = 4096;
export const BLOCK_ROWS = 64;
export const BLOOM_BITS_PER_KEY = 10;

export interface Row { a: number; b: number }
export type ZLayout = "unsorted" | "a" | "z";
export const ZLAYOUTS: ZLayout[] = ["unsorted", "a", "z"];

export function zoneTable(n = ZONE_ROWS, seed = 21): Row[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => ({ a: Math.floor(rng() * DOMAIN), b: Math.floor(rng() * DOMAIN) }));
}

/** Morton code: interleave the bits of a and b (a takes the odd bits, b the even bits). */
export function morton(a: number, b: number, bits = 10): number {
  let z = 0;
  for (let i = bits - 1; i >= 0; i--) z = z * 4 + ((a >>> i) & 1) * 2 + ((b >>> i) & 1);
  return z;
}

export function orderRows(rows: readonly Row[], layout: ZLayout): Row[] {
  const out = rows.slice();
  if (layout === "a") out.sort((x, y) => x.a - y.a || x.b - y.b);
  if (layout === "z") out.sort((x, y) => morton(x.a, x.b) - morton(y.a, y.b));
  return out;
}

export interface Zone { minA: number; maxA: number; minB: number; maxB: number; first: number; count: number; bloom?: BloomFilter }

export function zoneMaps(rows: readonly Row[], blockRows = BLOCK_ROWS, withBloom = false): Zone[] {
  const out: Zone[] = [];
  for (let i = 0; i < rows.length; i += blockRows) {
    const blk = rows.slice(i, i + blockRows);
    const z: Zone = { minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity, first: i, count: blk.length };
    for (const r of blk) {
      z.minA = Math.min(z.minA, r.a); z.maxA = Math.max(z.maxA, r.a);
      z.minB = Math.min(z.minB, r.b); z.maxB = Math.max(z.maxB, r.b);
    }
    if (withBloom) z.bloom = BloomFilter.forKeys(blk.map((r) => String(r.b)), BLOOM_BITS_PER_KEY);
    out.push(z);
  }
  return out;
}

/** Inclusive ranges; a missing column has no predicate. */
export interface Pred { a?: [number, number]; b?: [number, number] }
const overlaps = (lo: number, hi: number, r?: [number, number]) => !r || (hi >= r[0] && lo <= r[1]);
export const rowMatches = (r: Row, p: Pred) => (!p.a || (r.a >= p.a[0] && r.a <= p.a[1])) && (!p.b || (r.b >= p.b[0] && r.b <= p.b[1]));

/** Must the block be scanned? Min/max first; for an equality on b, the Bloom filter too. */
export function mustScan(z: Zone, p: Pred, useBloom = false): boolean {
  if (!overlaps(z.minA, z.maxA, p.a) || !overlaps(z.minB, z.maxB, p.b)) return false;
  if (useBloom && z.bloom && p.b && p.b[0] === p.b[1]) return z.bloom.mayContain(String(p.b[0]));
  return true;
}

export interface PruneResult {
  scan: boolean[];
  scanned: number;
  blocks: number;
  /** Blocks that hold at least one matching row. */
  needed: number;
  matches: number;
  /** Matching rows inside pruned blocks: must always be 0. */
  lost: number;
  rowsScanned: number;
}

export function prune(rows: readonly Row[], zones: readonly Zone[], p: Pred, useBloom = false): PruneResult {
  let scanned = 0, needed = 0, matches = 0, lost = 0, rowsScanned = 0;
  const scan = zones.map((z) => {
    const s = mustScan(z, p, useBloom);
    let m = 0;
    for (let i = z.first; i < z.first + z.count; i++) if (rowMatches(rows[i]!, p)) m++;
    matches += m;
    if (m > 0) needed++;
    if (s) { scanned++; rowsScanned += z.count; } else lost += m;
    return s;
  });
  return { scan, scanned, blocks: zones.length, needed, matches, lost, rowsScanned };
}

export type PredOn = "a" | "b" | "ab";
/** A range of width w (fraction of the domain) starting at lo, on column a, b or both. */
export function rangePred(on: PredOn, lo: number, width: number): Pred {
  const w = Math.max(1, Math.round(width * DOMAIN));
  const r: [number, number] = [lo, Math.min(DOMAIN - 1, lo + w - 1)];
  return on === "a" ? { a: r } : on === "b" ? { b: r } : { a: r, b: r };
}

/** Average blocks scanned for a predicate of width w, over `positions` evenly spaced start points. */
export function avgScanned(zones: readonly Zone[], on: PredOn, width: number, positions = 32): number {
  const w = Math.max(1, Math.round(width * DOMAIN));
  let s = 0;
  for (let i = 0; i < positions; i++) {
    const lo = Math.round((i * (DOMAIN - w)) / Math.max(1, positions - 1));
    const p = rangePred(on, lo, width);
    for (const z of zones) if (mustScan(z, p)) s++;
  }
  return s / positions;
}

export interface LayoutData { layout: ZLayout; rows: Row[]; zones: Zone[] }
export function buildLayouts(seed = 21, withBloom = false): Record<ZLayout, LayoutData> {
  const base = zoneTable(ZONE_ROWS, seed);
  const out = {} as Record<ZLayout, LayoutData>;
  for (const l of ZLAYOUTS) { const rows = orderRows(base, l); out[l] = { layout: l, rows, zones: zoneMaps(rows, BLOCK_ROWS, withBloom) }; }
  return out;
}

export const SWEEP_WIDTHS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1];

/**
 * For uniform random data, the chance that a block of n rows can be skipped for a range [lo, hi]
 * (as fractions of the domain) is lo^n + (1 − hi)^n: all n values must fall on one side.
 */
export const unsortedSkipChance = (lo: number, hi: number, n = BLOCK_ROWS) => Math.pow(lo, n) + Math.pow(1 - hi, n);

/** PostgreSQL BRIN: one summary per range of pages_per_range pages (default 128) of 8 KiB. */
export const BRIN_PAGES_PER_RANGE = 128;
export const brinRanges = (tableBytes: number, pagesPerRange = BRIN_PAGES_PER_RANGE, pageBytes = 8192) => Math.ceil(tableBytes / pageBytes / pagesPerRange);
