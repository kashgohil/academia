/**
 * Inverted indexes: tokenization, posting lists with term frequencies and positions, AND / OR /
 * phrase queries with traced intersection (linear merge and galloping), posting-list compression
 * (delta + varint, frame of reference, PForDelta) and BM25 scoring.
 */

// =====================================================================================
// Tokenizing and building
// =====================================================================================

export const STOPWORDS = new Set(["a", "an", "and", "the", "of", "in", "to", "is", "it", "on", "for", "with", "by", "as", "at", "or"]);

/** Lowercase, split on anything that is not a letter or digit. Positions count every token, stop words included. */
export function tokenize(text: string, dropStop = true): { term: string; pos: number }[] {
  const toks = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return toks.map((term, pos) => ({ term, pos })).filter((t) => !dropStop || !STOPWORDS.has(t.term));
}

export interface Posting { doc: number; tf: number; pos: number[] }

export interface InvertedIndex {
  terms: Map<string, Posting[]>;
  /** Tokens per document (after stop words are dropped). */
  docLen: number[];
  avgdl: number;
  docs: string[];
}

export function buildIndex(docs: string[], dropStop = true): InvertedIndex {
  const terms = new Map<string, Posting[]>();
  const docLen: number[] = [];
  docs.forEach((text, doc) => {
    const toks = tokenize(text, dropStop);
    docLen.push(toks.length);
    for (const { term, pos } of toks) {
      let list = terms.get(term);
      if (!list) terms.set(term, (list = []));
      const last = list[list.length - 1];
      if (last && last.doc === doc) { last.tf++; last.pos.push(pos); } else list.push({ doc, tf: 1, pos: [pos] });
    }
  });
  const avgdl = docLen.reduce((a, b) => a + b, 0) / Math.max(1, docs.length);
  return { terms, docLen, avgdl, docs };
}

export const postings = (ix: InvertedIndex, term: string): Posting[] => ix.terms.get(term.toLowerCase()) ?? [];

// =====================================================================================
// Intersection and union, with a trace for the demo
// =====================================================================================

export interface WalkStep { i: number; j: number; cmp: "<" | ">" | "=" | "jump"; out: number[]; note: string }

/** Two-pointer merge intersection of sorted doc-id lists. Every step is one comparison. */
export function intersectMerge(a: number[], b: number[], trace?: WalkStep[]): { out: number[]; comparisons: number } {
  const out: number[] = [];
  let i = 0, j = 0, comparisons = 0;
  while (i < a.length && j < b.length) {
    comparisons++;
    const x = a[i]!, y = b[j]!;
    if (x === y) {
      out.push(x);
      trace?.push({ i, j, cmp: "=", out: [...out], note: `${x} = ${y}: both lists have doc ${x}. Output it and move both pointers.` });
      i++; j++;
    } else if (x < y) {
      trace?.push({ i, j, cmp: "<", out: [...out], note: `${x} < ${y}: doc ${x} cannot be in the second list. Move the first pointer.` });
      i++;
    } else {
      trace?.push({ i, j, cmp: ">", out: [...out], note: `${x} > ${y}: doc ${y} cannot be in the first list. Move the second pointer.` });
      j++;
    }
  }
  return { out, comparisons };
}

/** First index ≥ lo in `b` with b[index] ≥ x: gallop 1, 2, 4, … then binary search. Counts comparisons. */
export function gallop(b: number[], lo: number, x: number, count: { c: number }): number {
  let step = 1, hi = lo;
  while (hi < b.length) {
    count.c++;
    if (b[hi]! >= x) break;
    lo = hi + 1;
    hi += step;
    step *= 2;
  }
  hi = Math.min(hi, b.length);
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    count.c++;
    if (b[m]! < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Galloping intersection: for each id of the short list, gallop forward in the long list. */
export function intersectGallop(a: number[], b: number[], trace?: WalkStep[]): { out: number[]; comparisons: number } {
  if (a.length > b.length) [a, b] = [b, a];
  const out: number[] = [];
  const count = { c: 0 };
  let j = 0;
  for (let i = 0; i < a.length && j < b.length; i++) {
    const x = a[i]!;
    const from = j;
    j = gallop(b, j, x, count);
    if (j < b.length && b[j] === x) {
      out.push(x);
      trace?.push({ i, j, cmp: "=", out: [...out], note: `Gallop from position ${from} to ${j} for ${x}: found. Output it.` });
      j++;
    } else {
      trace?.push({ i, j, cmp: "jump", out: [...out], note: `Gallop from position ${from} for ${x}: the next id is ${b[j] ?? "past the end"}, so ${x} is not there.` });
    }
  }
  return { out, comparisons: count.c };
}

export function union(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i] ?? Infinity, y = b[j] ?? Infinity;
    if (x === y) { out.push(x); i++; j++; } else if (x < y) { out.push(x); i++; } else { out.push(y); j++; }
  }
  return out;
}

/** Documents where the terms appear next to each other in order. Intersect first, then check positions. */
export function phrase(ix: InvertedIndex, terms: string[]): { docs: number[]; candidates: number[] } {
  const lists = terms.map((t) => postings(ix, t));
  if (lists.some((l) => !l.length)) return { docs: [], candidates: [] };
  let cand = lists[0]!.map((p) => p.doc);
  for (const l of lists.slice(1)) cand = intersectMerge(cand, l.map((p) => p.doc)).out;
  const docs = cand.filter((d) => {
    const ps = lists.map((l) => l.find((p) => p.doc === d)!.pos);
    return ps[0]!.some((p0) => ps.every((pl, k) => pl.includes(p0 + k)));
  });
  return { docs, candidates: cand };
}

/** A sorted list of `n` distinct doc ids drawn from 0..universe−1 (deterministic). */
export function randomPostings(n: number, universe: number, seed = 5): number[] {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const s = new Set<number>();
  while (s.size < Math.min(n, universe)) s.add(Math.floor(r() * universe));
  return [...s].sort((x, y) => x - y);
}

// =====================================================================================
// Compression
// =====================================================================================

/** Gaps between sorted ids; the first gap is the first id. */
export const deltas = (ids: number[]) => ids.map((x, i) => (i ? x - ids[i - 1]! : x));
export const undelta = (gs: number[]) => { let s = 0; return gs.map((g) => (s += g)); };

/** LEB128 varint: 7 bits per byte, high bit set on every byte except the last. */
export function varintEncode(vs: number[]): Uint8Array {
  const out: number[] = [];
  for (let v of vs) {
    while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(v);
  }
  return Uint8Array.from(out);
}
export function varintDecode(b: Uint8Array): number[] {
  const out: number[] = [];
  let v = 0, mul = 1;
  for (const x of b) {
    v += (x & 0x7f) * mul;
    if (x & 0x80) mul *= 128;
    else { out.push(v); v = 0; mul = 1; }
  }
  return out;
}
export const varintLen = (v: number) => { let n = 1; while (v >= 0x80) { v = Math.floor(v / 128); n++; } return n; };
export const bitsFor = (v: number) => (v <= 0 ? 0 : Math.floor(Math.log2(v)) + 1);

/** Bit writer / reader (LSB first) for packed blocks. */
class Bits {
  bytes: number[] = [];
  private acc = 0; private n = 0;
  put(v: number, w: number) {
    for (let i = 0; i < w; i++) {
      this.acc |= (Math.floor(v / 2 ** i) & 1) << this.n;
      if (++this.n === 8) { this.bytes.push(this.acc); this.acc = 0; this.n = 0; }
    }
  }
  flush() { if (this.n) { this.bytes.push(this.acc); this.acc = 0; this.n = 0; } }
}
function readBits(b: Uint8Array, bitPos: number, w: number): number {
  let v = 0;
  for (let i = 0; i < w; i++) {
    const p = bitPos + i;
    if ((b[p >> 3]! >> (p & 7)) & 1) v += 2 ** i;
  }
  return v;
}

export const BLOCK = 128;

/**
 * Frame of reference (FOR) on gaps: each block of 128 gaps uses the bit width of its largest gap.
 * Block layout: 1 byte of width, then 128 packed values. A last partial block uses varints.
 */
export function forEncode(gaps: number[]): Uint8Array {
  const out: number[] = [];
  const full = Math.floor(gaps.length / BLOCK) * BLOCK;
  for (let s = 0; s < full; s += BLOCK) {
    const blk = gaps.slice(s, s + BLOCK);
    const w = Math.max(...blk.map(bitsFor));
    const bw = new Bits();
    for (const g of blk) bw.put(g, w);
    bw.flush();
    out.push(w, ...bw.bytes);
  }
  out.push(...varintEncode(gaps.slice(full)));
  return Uint8Array.from(out);
}
export function forDecode(b: Uint8Array, count: number): number[] {
  const out: number[] = [];
  let o = 0;
  while (count - out.length >= BLOCK) {
    const w = b[o++]!;
    for (let i = 0; i < BLOCK; i++) out.push(readBits(b, o * 8 + i * w, w));
    o += Math.ceil((BLOCK * w) / 8);
  }
  return out.concat(varintDecode(b.slice(o)));
}

/**
 * PForDelta (patched frame of reference): the width b covers about 90% of the gaps in a block.
 * Larger gaps are exceptions: their low b bits stay in the block, and the high bits are stored
 * after it as (index, high bits) varint pairs. Layout: width, exception count, packed block, exceptions.
 */
export function pforEncode(gaps: number[], coverage = 0.9): Uint8Array {
  const out: number[] = [];
  const full = Math.floor(gaps.length / BLOCK) * BLOCK;
  for (let s = 0; s < full; s += BLOCK) {
    const blk = gaps.slice(s, s + BLOCK);
    const widths = blk.map(bitsFor).sort((x, y) => x - y);
    const w = widths[Math.min(BLOCK - 1, Math.ceil(coverage * BLOCK) - 1)]!;
    const lim = 2 ** w;
    const exc: number[] = [];
    const bw = new Bits();
    blk.forEach((g, i) => { bw.put(g % lim, w); if (g >= lim) exc.push(i, Math.floor(g / lim)); });
    bw.flush();
    out.push(w, exc.length / 2, ...bw.bytes, ...varintEncode(exc));
  }
  out.push(...varintEncode(gaps.slice(full)));
  return Uint8Array.from(out);
}
export function pforDecode(b: Uint8Array, count: number): number[] {
  const out: number[] = [];
  let o = 0;
  while (count - out.length >= BLOCK) {
    const w = b[o++]!, ne = b[o++]!;
    const blk: number[] = [];
    for (let i = 0; i < BLOCK; i++) blk.push(readBits(b, o * 8 + i * w, w));
    o += Math.ceil((BLOCK * w) / 8);
    // read 2·ne varints
    const pairs: number[] = [];
    while (pairs.length < 2 * ne) {
      let v = 0, mul = 1;
      for (;;) { const x = b[o++]!; v += (x & 0x7f) * mul; if (x & 0x80) mul *= 128; else break; }
      pairs.push(v);
    }
    for (let k = 0; k < pairs.length; k += 2) blk[pairs[k]!] = blk[pairs[k]!]! + pairs[k + 1]! * 2 ** w;
    out.push(...blk);
  }
  return out.concat(varintDecode(b.slice(o)));
}

export interface CompressionSizes { raw: number; varint: number; forBytes: number; pfor: number; bitsPerId: { raw: number; varint: number; for: number; pfor: number } }

/** Bytes for one posting list of doc ids under each scheme (raw = 4-byte ids). */
export function compressionSizes(ids: number[]): CompressionSizes {
  const g = deltas(ids);
  const raw = 4 * ids.length, varint = varintEncode(g).length, forBytes = forEncode(g).length, pfor = pforEncode(g).length;
  const n = Math.max(1, ids.length);
  return { raw, varint, forBytes, pfor, bitsPerId: { raw: 32, varint: (8 * varint) / n, for: (8 * forBytes) / n, pfor: (8 * pfor) / n } };
}

/**
 * A posting list with mostly small gaps and a few large jumps: ids cluster in `bursts`, the way
 * a term appears in a run of related documents. `jumpEvery` gaps, one gap is large.
 */
export function burstyPostings(n: number, meanGap: number, jumpEvery = 20, jump = 5000, seed = 3): number[] {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out: number[] = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    const g = i > 0 && i % jumpEvery === 0 ? jump + Math.floor(r() * jump) : 1 + Math.floor(r() * (2 * meanGap - 1));
    x += g;
    out.push(x);
  }
  return out;
}

// =====================================================================================
// BM25
// =====================================================================================

export interface Bm25Params { k1: number; b: number }
export const BM25_DEFAULTS: Bm25Params = { k1: 1.2, b: 0.75 };

/** Lucene's idf: ln(1 + (N − n + 0.5) / (n + 0.5)). Always positive. */
export const idf = (N: number, n: number) => Math.log(1 + (N - n + 0.5) / (n + 0.5));

/** One term's BM25 contribution: idf · tf·(k1+1) / (tf + k1·(1 − b + b·dl/avgdl)). */
export function bm25Term(tf: number, dl: number, avgdl: number, idfv: number, p: Bm25Params = BM25_DEFAULTS): number {
  if (tf <= 0) return 0;
  const norm = p.k1 * (1 - p.b + (p.b * dl) / avgdl);
  return (idfv * (tf * (p.k1 + 1))) / (tf + norm);
}

export interface Ranked { doc: number; score: number; parts: { term: string; tf: number; idf: number; score: number }[] }

/** Scores every document that holds at least one query term (OR semantics), best first. */
export function bm25Rank(ix: InvertedIndex, query: string, p: Bm25Params = BM25_DEFAULTS): Ranked[] {
  const qterms = [...new Set(tokenize(query).map((t) => t.term))];
  const N = ix.docs.length;
  const scores = new Map<number, Ranked>();
  for (const term of qterms) {
    const list = postings(ix, term);
    const iv = idf(N, list.length);
    for (const ps of list) {
      const s = bm25Term(ps.tf, ix.docLen[ps.doc]!, ix.avgdl, iv, p);
      let r = scores.get(ps.doc);
      if (!r) scores.set(ps.doc, (r = { doc: ps.doc, score: 0, parts: [] }));
      r.score += s;
      r.parts.push({ term, tf: ps.tf, idf: iv, score: s });
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.doc - b.doc);
}

// =====================================================================================
// Demo corpus
// =====================================================================================

export const CORPUS = [
  "A B-tree keeps keys in sorted pages and splits a full page.",
  "An LSM tree writes sorted runs to disk and merges the runs later.",
  "Sorted runs make range scans fast, and merges keep the number of runs low.",
  "A hash index finds a key in one page read but cannot scan a range.",
  "The inverted index maps each term to a sorted list of documents.",
  "Search engines merge index segments the way an LSM tree merges runs, and each segment is an inverted index with its own sorted term dictionary and posting lists.",
];
