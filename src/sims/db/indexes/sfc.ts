/**
 * Space-filling curves: map a 2^k × 2^k grid to one dimension so a B-tree can index 2D data.
 *
 * - Z-order (Morton): interleave the bits of x and y.
 * - Hilbert: a curve where consecutive cells are always neighbors (classic d2xy / xy2d).
 * - Geohash: Z-order over longitude/latitude bits, written in base 32.
 * - `boxRanges`: the 1D key ranges that cover a query box exactly, and what happens when an engine
 *   allows only a few ranges (it scans the gaps and filters false positives).
 */

/** Spreads the low 16 bits of v to the even bit positions. */
function part1by1(v: number): number {
  v &= 0xffff;
  v = (v | (v << 8)) & 0x00ff00ff;
  v = (v | (v << 4)) & 0x0f0f0f0f;
  v = (v | (v << 2)) & 0x33333333;
  v = (v | (v << 1)) & 0x55555555;
  return v >>> 0;
}
function compact1by1(v: number): number {
  v &= 0x55555555;
  v = (v | (v >>> 1)) & 0x33333333;
  v = (v | (v >>> 2)) & 0x0f0f0f0f;
  v = (v | (v >>> 4)) & 0x00ff00ff;
  v = (v | (v >>> 8)) & 0x0000ffff;
  return v;
}
/** Morton code: bit i of x goes to bit 2i, bit i of y to bit 2i + 1. */
export const zEncode = (x: number, y: number) => (part1by1(x) | (part1by1(y) << 1)) >>> 0;
export const zDecode = (d: number): [number, number] => [compact1by1(d), compact1by1(d >>> 1)];

/** Hilbert index of (x, y) on an n × n grid (n a power of two). */
export function hilbertEncode(n: number, x: number, y: number): number {
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    [x, y] = rot(n, x, y, rx, ry);
  }
  return d;
}
export function hilbertDecode(n: number, d: number): [number, number] {
  let x = 0, y = 0, t = d;
  for (let s = 1; s < n; s <<= 1) {
    const rx = 1 & (t >> 1), ry = 1 & (t ^ rx);
    [x, y] = rot(s, x, y, rx, ry);
    x += s * rx; y += s * ry;
    t >>= 2;
  }
  return [x, y];
}
function rot(n: number, x: number, y: number, rx: number, ry: number): [number, number] {
  if (ry === 0) {
    if (rx === 1) { x = n - 1 - x; y = n - 1 - y; }
    return [y, x];
  }
  return [x, y];
}

export type Curve = "z" | "hilbert";
export const encode = (c: Curve, n: number, x: number, y: number) => (c === "z" ? zEncode(x, y) : hilbertEncode(n, x, y));
export const decode = (c: Curve, n: number, d: number): [number, number] => (c === "z" ? zDecode(d) : hilbertDecode(n, d));

export interface Box { x0: number; y0: number; x1: number; y1: number } // inclusive cell coordinates

export interface RangeCover {
  /** Exact cover: maximal runs of consecutive codes inside the box. */
  ranges: [number, number][];
  /** Cover after merging down to at most `maxRanges` ranges (smallest gaps merged first). */
  merged: [number, number][];
  /** Cells scanned by the merged ranges that are outside the box. */
  falsePositives: number;
  cells: number;
}

/** The 1D ranges of curve codes that cover a box of cells. */
export function boxRanges(c: Curve, n: number, b: Box, maxRanges = Infinity): RangeCover {
  const codes: number[] = [];
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) codes.push(encode(c, n, x, y));
  codes.sort((p, q) => p - q);
  const ranges: [number, number][] = [];
  for (const d of codes) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === d - 1) last[1] = d; else ranges.push([d, d]);
  }
  const merged = mergeRanges(ranges, maxRanges);
  const scanned = merged.reduce((s, [a, z]) => s + z - a + 1, 0);
  return { ranges, merged, falsePositives: scanned - codes.length, cells: codes.length };
}

/** Merges the ranges separated by the smallest gaps until at most `max` remain. */
export function mergeRanges(rs: [number, number][], max: number): [number, number][] {
  const out = rs.map((r) => [r[0], r[1]] as [number, number]);
  while (out.length > Math.max(1, max)) {
    let bi = 0, bg = Infinity;
    for (let i = 0; i + 1 < out.length; i++) { const g = out[i + 1]![0] - out[i]![1]; if (g < bg) { bg = g; bi = i; } }
    out[bi]![1] = out[bi + 1]![1];
    out.splice(bi + 1, 1);
  }
  return out;
}

/** Mean exact ranges per query over random boxes of size w × h on an n × n grid. */
export function meanRanges(c: Curve, n: number, w: number, h: number, queries = 400, seed = 13): number {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let s = 0;
  for (let i = 0; i < queries; i++) {
    const x0 = Math.floor(r() * (n - w + 1)), y0 = Math.floor(r() * (n - h + 1));
    s += boxRanges(c, n, { x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 }).ranges.length;
  }
  return s / queries;
}

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
/** Geohash: alternate longitude and latitude bisection bits (longitude first), 5 bits per character. */
export function geohash(lat: number, lon: number, chars = 6): string {
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180, out = "", bits = 0, ch = 0, even = true;
  while (out.length < chars) {
    if (even) { const m = (lonLo + lonHi) / 2; if (lon >= m) { ch = ch * 2 + 1; lonLo = m; } else { ch *= 2; lonHi = m; } }
    else { const m = (latLo + latHi) / 2; if (lat >= m) { ch = ch * 2 + 1; latLo = m; } else { ch *= 2; latHi = m; } }
    even = !even;
    if (++bits === 5) { out += BASE32[ch]; bits = 0; ch = 0; }
  }
  return out;
}

// Demo scenarios (shared by the demos and the tests).
export const CURVE_BOX = { x0: 3, y0: 5, w: 6, h: 5 };
