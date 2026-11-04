/**
 * Join algorithms over paged relations, with page I/O accounting, plus the textbook cost formulas.
 *
 * Model (the usual one in textbooks and in CMU 15-445): R has M pages and m tuples, S has N pages and
 * n tuples, and the join has B buffer frames. A page read or a page write is one I/O. Writing the join
 * output is not counted, because every algorithm writes the same output.
 *
 * Executed algorithms (each returns the matching pairs, the I/O counts and, with `trace`, a step log):
 *   nestedLoopJoin  for each R tuple, scan S                               M + m·N
 *   blockNlj        for each block of B − 2 R pages, scan S                 M + ceil(M / (B − 2))·N
 *   indexNlj        for each R tuple, probe an index on S, fetch matches    M + m·(C_probe + matches)
 *   sortMergeJoin   sort R and S externally, then merge                     sort(M) + sort(N) + M + N
 *   hashJoin        build a table on R in memory, probe with S              M + N           (if M ≤ B − 2)
 *   graceHashJoin   partition R and S into B − 1 partitions, then join each about 3(M + N)
 *   hybridHashJoin  like Grace, but keep partition 0 of R in memory         between M + N and 3(M + N)
 *
 * Grace and hybrid hash join repartition a partition that does not fit, with a new hash seed. A partition
 * where every tuple has the same key cannot be split, so it falls back to a block nested-loop join.
 */
import { mulberry32 } from "../../rng";
import { externalSort, sortIO } from "./extsort";

export interface JTuple { k: number; id: string }
export interface PagedRel { name: string; tpp: number; pages: JTuple[][] }
export type Pair = [string, string];

export const tuplesOf = (r: PagedRel) => r.pages.flat();
export const pageCount = (r: PagedRel) => r.pages.length;

/** Packs keys into pages of `tpp` tuples. Tuple ids are `${name}${i + 1}` (lowercase name). */
export function paged(name: string, keys: number[], tpp: number): PagedRel {
  const ts = keys.map((k, i) => ({ k, id: `${name.toLowerCase()}${i + 1}` }));
  return fromTuples(name, ts, tpp);
}
export function fromTuples(name: string, ts: JTuple[], tpp: number): PagedRel {
  const pages: JTuple[][] = [];
  for (let i = 0; i < ts.length; i += tpp) pages.push(ts.slice(i, i + tpp));
  return { name, tpp, pages };
}

/** 32-bit integer hash (a murmur3 finalizer) with a seed, so recursive partitioning can rehash. */
export function hash32(k: number, seed = 0): number {
  let x = (k | 0) ^ Math.imul(seed + 1, 0x9e3779b1);
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

export type JoinEvent =
  | { t: "phase"; text: string }
  | { t: "read"; rel: string; page: number; why?: string }
  | { t: "write"; rel: string; page: number }
  | { t: "block"; pages: number[] }
  | { t: "cmp"; r: string; s: string; match: boolean }
  | { t: "build"; r: string; bucket: number }
  | { t: "probe"; s: string; bucket: number; hits: string[] }
  | { t: "index"; r: string; key: number; hits: string[]; ios: number }
  | { t: "sorted"; rel: string; ids: string[] }
  | { t: "part"; rel: string; id: string; part: number; mem: boolean }
  | { t: "emit"; r: string; s: string };

export interface JoinResult {
  pairs: Pair[];
  reads: number;
  writes: number;
  comparisons: number;
  probes: number;
  events: JoinEvent[];
  /** Grace / hybrid: one entry per partition join (tuples of R and S, pages of R, whether R fit in B − 2 pages). `depth` is 1 for first-level partitions, 2 after one repartitioning, and so on. */
  partitions?: { r: number; s: number; pages: number; fits: boolean; depth: number; mem?: boolean }[];
  /** Partitions that could not be split and used a nested-loop fallback. */
  fallbacks?: number;
}

class Acc {
  pairs: Pair[] = [];
  reads = 0;
  writes = 0;
  comparisons = 0;
  probes = 0;
  events: JoinEvent[] = [];
  constructor(public trace: boolean) {}
  ev(e: JoinEvent) { if (this.trace) this.events.push(e); }
  read(rel: string, page: number, why?: string) { this.reads++; this.ev({ t: "read", rel, page, why }); }
  write(rel: string, page: number) { this.writes++; this.ev({ t: "write", rel, page }); }
  emit(r: string, s: string) { this.pairs.push([r, s]); this.ev({ t: "emit", r, s }); }
  out(extra: Partial<JoinResult> = {}): JoinResult {
    return { pairs: this.pairs, reads: this.reads, writes: this.writes, comparisons: this.comparisons, probes: this.probes, events: this.events, ...extra };
  }
}

// ------------------------------------------------------------------ nested loops

/** Tuple nested-loop join: for each tuple of R, read all of S. */
export function nestedLoopJoin(R: PagedRel, S: PagedRel, trace = false): JoinResult {
  const a = new Acc(trace);
  R.pages.forEach((rp, i) => {
    a.read(R.name, i);
    for (const r of rp) S.pages.forEach((sp, j) => {
      a.read(S.name, j);
      for (const s of sp) { a.comparisons++; const m = r.k === s.k; a.ev({ t: "cmp", r: r.id, s: s.id, match: m }); if (m) a.emit(r.id, s.id); }
    });
  });
  return a.out();
}

/** Block nested-loop join: B − 2 frames hold a block of R, one frame reads S, one holds output. */
export function blockNlj(R: PagedRel, S: PagedRel, B: number, trace = false, acc?: Acc): JoinResult {
  const a = acc ?? new Acc(trace);
  const blk = Math.max(1, B - 2);
  for (let i = 0; i < R.pages.length; i += blk) {
    const ids = R.pages.slice(i, i + blk).map((_, j) => i + j);
    for (const j of ids) a.read(R.name, j, "block");
    a.ev({ t: "block", pages: ids });
    const block = ids.flatMap((j) => R.pages[j]!);
    S.pages.forEach((sp, j) => {
      a.read(S.name, j);
      for (const s of sp) for (const r of block) {
        a.comparisons++;
        const m = r.k === s.k;
        a.ev({ t: "cmp", r: r.id, s: s.id, match: m });
        if (m) a.emit(r.id, s.id);
      }
    });
  }
  return a.out();
}

/**
 * Index nested-loop join with an index on S.k. Each probe costs `probeIO` page reads (1 for a hash index,
 * or a B+ tree whose inner levels are cached). An unclustered index then reads one S page per match;
 * a clustered one reads each distinct page of the matches once per probe.
 */
export function indexNlj(R: PagedRel, S: PagedRel, opts: { probeIO?: number; clustered?: boolean } = {}, trace = false): JoinResult {
  const a = new Acc(trace);
  const probeIO = opts.probeIO ?? 1;
  const index = new Map<number, { id: string; page: number }[]>();
  S.pages.forEach((p, j) => p.forEach((s) => { const l = index.get(s.k); if (l) l.push({ id: s.id, page: j }); else index.set(s.k, [{ id: s.id, page: j }]); }));
  R.pages.forEach((rp, i) => {
    a.read(R.name, i);
    for (const r of rp) {
      a.probes++;
      const hits = index.get(r.k) ?? [];
      const fetch = opts.clustered ? new Set(hits.map((h) => h.page)).size : hits.length;
      a.reads += probeIO + fetch;
      a.ev({ t: "index", r: r.id, key: r.k, hits: hits.map((h) => h.id), ios: probeIO + fetch });
      for (const h of hits) a.emit(r.id, h.id);
    }
  });
  return a.out();
}

// ------------------------------------------------------------------ sort-merge

/** Sort-merge join: external sort of both inputs (2N per pass), then one merge pass reading M + N pages. */
export function sortMergeJoin(R: PagedRel, S: PagedRel, B: number, trace = false): JoinResult {
  const a = new Acc(trace);
  a.ev({ t: "phase", text: `Sort ${R.name} and ${S.name} with external merge sort.` });
  const sr = externalSort(R.pages, B, (t) => t.k), ss = externalSort(S.pages, B, (t) => t.k);
  a.reads += sr.reads + ss.reads;
  a.writes += sr.writes + ss.writes;
  a.comparisons += sr.comparisons + ss.comparisons;
  const rs = sr.pages.flat(), st = ss.pages.flat();
  a.ev({ t: "sorted", rel: R.name, ids: rs.map((t) => t.id) });
  a.ev({ t: "sorted", rel: S.name, ids: st.map((t) => t.id) });
  a.ev({ t: "phase", text: "Merge: advance the cursor with the smaller key; join equal-key groups." });
  a.reads += sr.pages.length + ss.pages.length;
  let i = 0, j = 0;
  while (i < rs.length && j < st.length) {
    a.comparisons++;
    const r = rs[i]!, s = st[j]!;
    a.ev({ t: "cmp", r: r.id, s: s.id, match: r.k === s.k });
    if (r.k < s.k) i++;
    else if (r.k > s.k) j++;
    else {
      // Equal keys: join the group of R with the group of S (the S group is re-read from memory).
      let j2 = j;
      while (j2 < st.length && st[j2]!.k === r.k) j2++;
      let i2 = i;
      while (i2 < rs.length && rs[i2]!.k === r.k) {
        for (let x = j; x < j2; x++) a.emit(rs[i2]!.id, st[x]!.id);
        i2++;
      }
      i = i2; j = j2;
    }
  }
  return a.out();
}

// ------------------------------------------------------------------ hash joins

/** In-memory build on R, probe with S. Requires R to fit in B − 2 frames; else use Grace or hybrid. */
export function hashJoin(R: PagedRel, S: PagedRel, B: number, trace = false, buckets = 4): JoinResult {
  if (R.pages.length > B - 2) return graceHashJoin(R, S, B, trace);
  const a = new Acc(trace);
  inMemoryJoin(R, S, a, buckets, 0);
  return a.out();
}

function inMemoryJoin(R: PagedRel, S: PagedRel, a: Acc, buckets: number, seed: number) {
  const ht = new Map<number, JTuple[]>();
  a.ev({ t: "phase", text: `Build: read ${R.name} and insert each tuple into the hash table.` });
  R.pages.forEach((p, i) => {
    a.read(R.name, i);
    for (const r of p) { const l = ht.get(r.k); if (l) l.push(r); else ht.set(r.k, [r]); a.ev({ t: "build", r: r.id, bucket: hash32(r.k, seed) % buckets }); }
  });
  a.ev({ t: "phase", text: `Probe: read ${S.name}; for each tuple, look up its key in the hash table.` });
  S.pages.forEach((p, j) => {
    a.read(S.name, j);
    for (const s of p) {
      a.probes++;
      const hits = (ht.get(s.k) ?? []);
      a.comparisons += hits.length;
      a.ev({ t: "probe", s: s.id, bucket: hash32(s.k, seed) % buckets, hits: hits.map((h) => h.id) });
      for (const r of hits) a.emit(r.id, s.id);
    }
  });
}

/** Writes tuples into `k` partitions with one output page each; returns the partitions as paged relations. */
function partition(rel: PagedRel, k: number, seed: number, a: Acc, label: string, route?: (t: JTuple) => number | null): PagedRel[] {
  const parts: JTuple[][] = Array.from({ length: k }, () => []);
  const written = parts.map(() => 0);
  const buf: JTuple[][] = parts.map(() => []);
  const flush = (p: number) => { if (!buf[p]!.length) return; parts[p]!.push(...buf[p]!); a.write(`${label}${p}`, written[p]!++); buf[p] = []; };
  rel.pages.forEach((pg, i) => {
    a.read(rel.name, i);
    for (const t of pg) {
      const p = route ? route(t) : hash32(t.k, seed) % k;
      if (p === null) continue;
      a.ev({ t: "part", rel: rel.name, id: t.id, part: p, mem: false });
      buf[p]!.push(t);
      if (buf[p]!.length === rel.tpp) flush(p);
    }
  });
  for (let p = 0; p < k; p++) flush(p);
  return parts.map((ts, p) => fromTuples(`${label}${p}`, ts, rel.tpp));
}

const allSameKey = (r: PagedRel) => { const ts = tuplesOf(r); return ts.every((t) => t.k === ts[0]?.k); };

/**
 * Grace hash join. Phase 1 partitions R, then S, into B − 1 partitions with hash h1 (one input frame,
 * B − 1 output frames). Phase 2 joins each pair R_i, S_i in memory if R_i has at most B − 2 pages;
 * otherwise it partitions that pair again with a new seed (up to `maxDepth` levels).
 */
export function graceHashJoin(R: PagedRel, S: PagedRel, B: number, trace = false, maxDepth = 3): JoinResult {
  const a = new Acc(trace);
  const partitions: NonNullable<JoinResult["partitions"]> = [];
  let fallbacks = 0;
  const rec = (r: PagedRel, s: PagedRel, depth: number, label: string) => {
    if (r.pages.length <= B - 2) {
      partitions.push({ r: tuplesOf(r).length, s: tuplesOf(s).length, pages: r.pages.length, fits: true, depth });
      if (r.pages.length) inMemoryJoin(r, s, a, 4, depth + 7);
      return;
    }
    if (depth >= maxDepth || allSameKey(r)) {
      partitions.push({ r: tuplesOf(r).length, s: tuplesOf(s).length, pages: r.pages.length, fits: false, depth });
      fallbacks++;
      a.ev({ t: "phase", text: `${r.name} has ${r.pages.length} pages and cannot be split further: use a block nested-loop join.` });
      blockNlj(r, s, B, a.trace, a);
      return;
    }
    const k = B - 1;
    a.ev({ t: "phase", text: `Partition ${r.name} and ${s.name} into ${k} partitions (seed ${depth}).` });
    const rp = partition(r, k, depth, a, `${label}R`);
    const sp = partition(s, k, depth, a, `${label}S`);
    for (let i = 0; i < k; i++) rec(rp[i]!, sp[i]!, depth + 1, `${label}${i}.`);
  };
  rec(R, S, 0, "");
  return a.out({ partitions, fallbacks });
}

/** Spilled partitions k and in-memory pages M0 = B − k − 1 for hybrid hash join (k = 0: plain in-memory hash join). */
export function hybridPlan(M: number, B: number): { k: number; memPages: number } | null {
  if (M <= B - 2) return { k: 0, memPages: M };
  for (let k = 1; k <= B - 2; k++) {
    const m0 = B - k - 1;
    if (m0 < 1) break;
    if (Math.ceil((M - m0) / k) <= B - 2) return { k, memPages: m0 };
  }
  return null;
}

/**
 * Hybrid hash join (DeWitt et al. 1984). While R is partitioned, partition 0 stays in memory as a hash
 * table (B − k − 1 frames) and only k partitions go to disk. S tuples of partition 0 probe at once, so
 * they are never written. If partition 0 grows too big, its extra tuples spill to an overflow partition.
 */
export function hybridHashJoin(R: PagedRel, S: PagedRel, B: number, trace = false): JoinResult {
  const M = R.pages.length;
  const plan = hybridPlan(M, B);
  if (!plan) return graceHashJoin(R, S, B, trace);
  if (plan.k === 0) return hashJoin(R, S, B, trace);
  const a = new Acc(trace);
  const { k, memPages } = plan;
  const f0 = memPages / M; // share of the hash space that stays in memory
  const cap = memPages * R.tpp;
  const route = (t: JTuple): number => {
    const u = hash32(t.k, 0) / 2 ** 32;
    return u < f0 ? 0 : 1 + Math.min(k - 1, Math.floor(((u - f0) / (1 - f0)) * k));
  };
  const ht = new Map<number, JTuple[]>();
  let held = 0;
  const overflowKeys = new Set<number>();
  a.ev({ t: "phase", text: `Partition ${R.name}: partition 0 (${memPages} frames) stays in memory, ${k} partitions go to disk.` });
  const rParts = partition(R, k + 2, 0, a, "R", (t) => {
    const p = route(t);
    if (p !== 0) return p;
    if (held < cap && !overflowKeys.has(t.k)) {
      held++;
      const l = ht.get(t.k); if (l) l.push(t); else ht.set(t.k, [t]);
      a.ev({ t: "part", rel: R.name, id: t.id, part: 0, mem: true });
      return null;
    }
    overflowKeys.add(t.k);
    return k + 1; // overflow partition on disk
  });
  a.ev({ t: "phase", text: `Partition ${S.name}: tuples of partition 0 probe the in-memory table at once.` });
  const sParts = partition(S, k + 2, 0, a, "S", (t) => {
    const p = route(t);
    if (p !== 0) return p;
    a.probes++;
    const hits = ht.get(t.k) ?? [];
    a.comparisons += hits.length;
    a.ev({ t: "probe", s: t.id, bucket: 0, hits: hits.map((h) => h.id) });
    for (const r of hits) a.emit(r.id, t.id);
    a.ev({ t: "part", rel: S.name, id: t.id, part: 0, mem: true });
    return overflowKeys.has(t.k) ? k + 1 : null;
  });
  const partitions: NonNullable<JoinResult["partitions"]> = [{ r: held, s: 0, pages: memPages, fits: true, depth: 0, mem: true }];
  let fallbacks = 0;
  for (let i = 1; i <= k + 1; i++) {
    const r = rParts[i]!, s = sParts[i]!;
    if (!r.pages.length) { if (i <= k) partitions.push({ r: 0, s: tuplesOf(s).length, pages: 0, fits: true, depth: 0 }); continue; }
    const sub = graceHashJoin(r, s, B, trace);
    a.reads += sub.reads; a.writes += sub.writes; a.comparisons += sub.comparisons; a.probes += sub.probes;
    a.pairs.push(...sub.pairs);
    if (trace) a.events.push(...sub.events);
    fallbacks += sub.fallbacks ?? 0;
    partitions.push({ r: tuplesOf(r).length, s: tuplesOf(s).length, pages: r.pages.length, fits: r.pages.length <= B - 2, depth: 0 });
  }
  return a.out({ partitions, fallbacks });
}

// ------------------------------------------------------------------ cost formulas

export type JoinAlgo = "nlj" | "pnlj" | "bnlj" | "inlj" | "smj" | "ghj" | "hhj";

export interface CostInput { M: number; N: number; B: number; m: number; n: number; indexCost: number }

/** Grace hash join cost with recursive partitioning: (2L + 1)(M + N), L = levels needed for R_i ≤ B − 2. */
export function graceCost(M: number, N: number, B: number): number {
  if (M <= B - 2) return M + N;
  let L = 0, size = M;
  while (size > B - 2) { size = size / (B - 1); L++; }
  return (2 * L + 1) * (M + N);
}

/** Hybrid hash join cost: M + N + 2(M − M0) + 2(N − N·M0/M). Falls back to Grace when one level is not enough. */
export function hybridCost(M: number, N: number, B: number): number {
  const p = hybridPlan(M, B);
  if (!p) return graceCost(M, N, B);
  if (p.k === 0) return M + N;
  const f = p.memPages / M;
  return M + N + 2 * (M - p.memPages) + 2 * Math.round(N * (1 - f));
}

/** I/O cost of each algorithm (R is the outer / build input). */
export function joinCost(algo: JoinAlgo, c: CostInput): number {
  const { M, N, B, m, indexCost } = c;
  switch (algo) {
    case "nlj": return M + m * N;
    case "pnlj": return M + M * N;
    case "bnlj": return M + Math.ceil(M / (B - 2)) * N;
    case "inlj": return M + m * indexCost;
    case "smj": return sortIO(M, B) + sortIO(N, B) + M + N;
    case "ghj": return graceCost(M, N, B);
    case "hhj": return hybridCost(M, N, B);
  }
}

export const JOIN_ALGOS: { id: JoinAlgo; label: string }[] = [
  { id: "nlj", label: "tuple nested loop" },
  { id: "pnlj", label: "page nested loop" },
  { id: "bnlj", label: "block nested loop" },
  { id: "inlj", label: "index nested loop" },
  { id: "smj", label: "sort-merge" },
  { id: "ghj", label: "Grace hash" },
  { id: "hhj", label: "hybrid hash" },
];

/** The CMU 15-445 example: R has 1,000 pages of 100 tuples, S has 500 pages of 80 tuples. */
export const CMU_EXAMPLE = { M: 1000, N: 500, m: 100_000, n: 40_000 };

// ------------------------------------------------------------------ data

/** Uniform random keys in [0, distinct). */
export function uniformKeys(n: number, distinct: number, seed = 1): number[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => Math.floor(rnd() * distinct));
}

/** Zipf-distributed keys in [0, distinct) with exponent s: key 0 is the most frequent. */
export function zipfKeys(n: number, distinct: number, s: number, seed = 1): number[] {
  const rnd = mulberry32(seed);
  const w = Array.from({ length: distinct }, (_, i) => 1 / Math.pow(i + 1, s));
  const tot = w.reduce((x, y) => x + y, 0);
  const cdf: number[] = [];
  let acc = 0;
  for (const x of w) { acc += x / tot; cdf.push(acc); }
  return Array.from({ length: n }, () => {
    const u = rnd();
    let lo = 0, hi = distinct - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid]! < u) lo = mid + 1; else hi = mid; }
    return lo;
  });
}

/** Sorted pair strings, for multiset comparison of join outputs. */
export const pairKey = (ps: Pair[]) => ps.map(([r, s]) => `${r}|${s}`).sort();
