/**
 * External sorting and aggregation with page I/O accounting.
 *
 * - `externalSort(pages, B, key)`: two-phase external merge sort. Pass 0 reads B pages at a time, sorts them
 *   and writes a run of B pages. Each merge pass merges B − 1 runs with one input page per run and one
 *   output page. Every pass reads and writes all N pages, so the cost is 2N · passes.
 *   With `trace`, it records a frame per step (memory frames, runs on disk, I/O) for the stepper demo.
 * - `sortPasses(N, B)` = 1 + ceil(log_{B−1}(ceil(N / B))), and `sortIO(N, B)` = 2N · passes.
 * - `replacementSelection(keys, M)`: run generation with a heap of M records. On random input the runs
 *   are about 2M long (Knuth's snowplow argument), so later merge passes have half as many runs.
 * - Aggregation: `hashAggregate` (in memory, spilling new groups to partitions when memory is full, as
 *   PostgreSQL 13 and later do), `sortAggregate`, and closed-form I/O costs `hashAggIO` and `sortAggIO`.
 * - `topN(keys, k)`: a bounded heap; it keeps only k rows and needs about n comparisons, not n log n.
 */
import { mulberry32 } from "../../rng";

// ------------------------------------------------------------------ formulas

/** Number of passes: run generation plus merge passes, computed by counting runs (exact integer math). */
export function sortPasses(n: number, b: number): number {
  if (n <= 0) return 0;
  let runs = Math.ceil(n / b), passes = 1;
  while (runs > 1) { runs = Math.ceil(runs / (b - 1)); passes++; }
  return passes;
}
/** Passes when run generation makes runs of `runPages` pages (B for load-sort-store, about 2B for replacement selection). */
export function sortPassesWithRuns(n: number, b: number, runPages: number): number {
  if (n <= 0) return 0;
  let runs = Math.ceil(n / runPages), passes = 1;
  while (runs > 1) { runs = Math.ceil(runs / (b - 1)); passes++; }
  return passes;
}
/** The textbook formula 1 + ceil(log_{B-1}(ceil(N/B))), evaluated with logarithms. */
export function sortPassesFormula(n: number, b: number): number {
  const r = Math.ceil(n / b);
  return r <= 1 ? 1 : 1 + Math.ceil(Math.log(r) / Math.log(b - 1) - 1e-12);
}
/** Page I/Os of external merge sort: each pass reads and writes every page. */
export const sortIO = (n: number, b: number) => 2 * n * sortPasses(n, b);

/** Smallest buffer B that sorts N pages in two passes: B(B − 1) ≥ N, so B ≈ √N. */
export function twoPassBuffer(n: number): number {
  let b = 3;
  while (b * (b - 1) < n) b++;
  return b;
}

// ------------------------------------------------------------------ external merge sort

export interface SortFrame<T> {
  /** B memory frames: the page they hold and their role. */
  mem: { items: T[]; role: "free" | "load" | "input" | "output"; run?: number }[];
  /** Runs on disk, each a list of pages. `done` = pages already read back by the current pass. */
  runs: { pages: T[][]; pass: number; read: number }[];
  /** Pages of the input not read yet (pass 0). */
  inputLeft: number;
  pass: number;
  reads: number;
  writes: number;
  text: string;
  /** Item that just moved, for highlighting. */
  moved?: T;
}

export interface SortResult<T> {
  pages: T[][];
  passes: number;
  reads: number;
  writes: number;
  comparisons: number;
  runsAfterPass0: number;
  frames: SortFrame<T>[];
}

/**
 * External merge sort of `input` pages with `b` buffer frames (b ≥ 3). Returns sorted pages of the same size.
 * `trace` records frames; keep inputs small then (tens of pages).
 */
export function externalSort<T>(input: T[][], b: number, key: (t: T) => number, trace = false): SortResult<T> {
  if (b < 3) throw new Error("external sort needs at least 3 buffer frames");
  const tpp = Math.max(1, ...input.map((p) => p.length));
  let reads = 0, writes = 0, comparisons = 0;
  const frames: SortFrame<T>[] = [];
  type Run = { pages: T[][]; pass: number; read: number };
  let runs: Run[] = [];
  let mem: SortFrame<T>["mem"] = Array.from({ length: b }, () => ({ items: [], role: "free" as const }));
  let inputLeft = input.length;
  let pass = 0;
  const snap = (text: string, moved?: T, extraRuns: Run[] = []) => {
    if (!trace) return;
    frames.push({
      mem: mem.map((m) => ({ ...m, items: [...m.items] })),
      runs: [...runs, ...extraRuns].map((r) => ({ pages: r.pages.map((p) => [...p]), pass: r.pass, read: r.read })),
      inputLeft, pass, reads, writes, text, moved,
    });
  };
  const cmp = (x: T, y: T) => { comparisons++; return key(x) - key(y); };
  const toPages = (items: T[]) => { const out: T[][] = []; for (let i = 0; i < items.length; i += tpp) out.push(items.slice(i, i + tpp)); return out; };

  snap(`Input: ${input.length} pages on disk, ${b} frames of memory.`);
  // Pass 0: run generation.
  for (let i = 0; i < input.length; i += b) {
    const chunk = input.slice(i, i + b);
    chunk.forEach((p, j) => { mem[j] = { items: [...p], role: "load" }; reads++; inputLeft--; snap(`Pass 0: read input page ${i + j + 1} into frame ${j + 1}.`); });
    const all = chunk.flat().sort(cmp);
    const pages = toPages(all);
    pages.forEach((p, j) => { mem[j] = { items: p, role: "load" }; });
    snap(`Pass 0: sort the ${all.length} items in memory.`);
    const run: Run = { pages: [], pass: 0, read: 0 };
    runs.push(run);
    for (const p of pages) { run.pages.push(p); writes++; }
    mem = mem.map(() => ({ items: [], role: "free" }));
    snap(`Pass 0: write them as run ${runs.length} (${pages.length} page${pages.length === 1 ? "" : "s"}).`);
  }
  const runsAfterPass0 = runs.length;
  // Merge passes.
  while (runs.length > 1) {
    pass++;
    const next: Run[] = [];
    for (let g = 0; g < runs.length; g += b - 1) {
      const group = runs.slice(g, g + b - 1);
      const out: Run = { pages: [], pass, read: 0 };
      const pageNo = group.map(() => 0);
      const outF = b - 1;
      mem = Array.from({ length: b }, (_, j) => (j < group.length ? { items: [], role: "input" as const, run: g + j + 1 } : j === outF ? { items: [], role: "output" as const } : { items: [], role: "free" as const }));
      const show = (t: string, moved?: T) => snap(t, moved, [...next, out]);
      /** Reads the next page of run j into its input frame. Returns false if the run is exhausted. */
      const load = (j: number) => {
        const r = group[j]!;
        if (pageNo[j]! >= r.pages.length) return false;
        mem[j] = { items: [...r.pages[pageNo[j]!]!], role: "input", run: g + j + 1 };
        pageNo[j]!++;
        r.read = pageNo[j]!;
        reads++;
        return true;
      };
      group.forEach((_, j) => { load(j); show(`Pass ${pass}: read the first page of run ${g + j + 1} into an input frame.`); });
      for (;;) {
        let best = -1;
        for (let j = 0; j < group.length; j++) {
          if (!mem[j]!.items.length) continue;
          if (best < 0 || cmp(mem[j]!.items[0]!, mem[best]!.items[0]!) < 0) best = j;
        }
        if (best < 0) break;
        const item = mem[best]!.items.shift()!;
        mem[outF]!.items.push(item);
        show(`Pass ${pass}: the smallest head is ${key(item)}, from run ${g + best + 1}. Move it to the output frame.`, item);
        if (mem[outF]!.items.length === tpp) {
          out.pages.push(mem[outF]!.items);
          writes++;
          mem[outF] = { items: [], role: "output" };
          show(`Pass ${pass}: the output frame is full. Write it as page ${out.pages.length} of the new run.`);
        }
        if (!mem[best]!.items.length && load(best)) show(`Pass ${pass}: the frame of run ${g + best + 1} is empty. Read the next page of that run.`);
      }
      if (mem[outF]!.items.length) { out.pages.push(mem[outF]!.items); writes++; mem[outF] = { items: [], role: "output" }; }
      next.push(out);
      show(`Pass ${pass}: runs ${g + 1} to ${g + group.length} are now one run of ${out.pages.length} pages.`);
    }
    runs = next;
    mem = mem.map(() => ({ items: [], role: "free" }));
    snap(`Pass ${pass} done: ${runs.length} run${runs.length === 1 ? "" : "s"} on disk.`);
  }
  const passes = pass + 1;
  if (input.length === 0) return { pages: [], passes: 0, reads, writes, comparisons, runsAfterPass0: 0, frames };
  snap(`Sorted in ${passes} pass${passes === 1 ? "" : "es"}: ${reads} page reads and ${writes} page writes = 2 × ${input.length} × ${passes}.`);
  return { pages: runs[0]!.pages, passes, reads, writes, comparisons, runsAfterPass0, frames };
}

// ------------------------------------------------------------------ replacement selection

export interface RsFrame { heap: { key: number; run: number }[]; out: number[]; run: number; next: number | null; text: string }

/**
 * Replacement selection with a heap of `m` records. Pop the smallest key of the current run and write it.
 * Read the next input key: if it is ≥ the key just written, it joins the current run; else it waits for the
 * next run. Returns the runs. With `trace`, records a frame per output key.
 */
export function replacementSelection(keys: number[], m: number, trace = false): { runs: number[][]; frames: RsFrame[] } {
  // Heap ordered by (run, key).
  const h: { key: number; run: number }[] = [];
  const less = (a: { key: number; run: number }, b: { key: number; run: number }) => (a.run !== b.run ? a.run < b.run : a.key < b.key);
  const push = (x: { key: number; run: number }) => {
    h.push(x);
    for (let i = h.length - 1; i > 0;) { const p = (i - 1) >> 1; if (!less(h[i]!, h[p]!)) break; [h[i], h[p]] = [h[p]!, h[i]!]; i = p; }
  };
  const pop = () => {
    const top = h[0]!, last = h.pop()!;
    if (h.length) {
      h[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < h.length && less(h[l]!, h[s]!)) s = l;
        if (r < h.length && less(h[r]!, h[s]!)) s = r;
        if (s === i) break;
        [h[i], h[s]] = [h[s]!, h[i]!]; i = s;
      }
    }
    return top;
  };
  let i = 0;
  for (; i < keys.length && h.length < m; i++) push({ key: keys[i]!, run: 0 });
  const runs: number[][] = [];
  const frames: RsFrame[] = [];
  while (h.length) {
    const top = pop();
    (runs[top.run] ??= []).push(top.key);
    let text = `Write ${top.key} to run ${top.run + 1}.`;
    let nextKey: number | null = null;
    if (i < keys.length) {
      nextKey = keys[i++]!;
      const joins = nextKey >= top.key;
      push({ key: nextKey, run: joins ? top.run : top.run + 1 });
      text += joins ? ` Read ${nextKey}: it is ≥ ${top.key}, so it can still go into run ${top.run + 1}.` : ` Read ${nextKey}: it is < ${top.key}, so it must wait for run ${top.run + 2}.`;
    }
    if (trace) frames.push({ heap: [...h].sort((a, b) => (less(a, b) ? -1 : 1)), out: [...(runs[top.run] ?? [])], run: top.run, next: nextKey, text });
  }
  return { runs: runs.filter(Boolean), frames };
}

/** Run generation by quicksort of memory loads: runs of exactly m records (the last may be shorter). */
export const loadSortRuns = (n: number, m: number) => Math.ceil(n / m);

export type InputOrder = "random" | "sorted" | "reverse" | "nearly";
export function sortInput(n: number, order: InputOrder, seed = 1): number[] {
  const rnd = mulberry32(seed);
  const a = Array.from({ length: n }, (_, i) => i);
  if (order === "sorted") return a;
  if (order === "reverse") return a.reverse();
  if (order === "nearly") {
    for (let k = 0; k < n / 20; k++) { const i = Math.floor(rnd() * n), j = Math.min(n - 1, i + Math.floor(rnd() * 8)); [a[i], a[j]] = [a[j]!, a[i]!]; }
    return a;
  }
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

// ------------------------------------------------------------------ aggregation

/** I/O of sort-based aggregation over N pages: the last merge pass feeds the aggregate directly. */
export function sortAggIO(n: number, b: number): number {
  if (n <= b) return n; // sort in memory
  return n + 2 * n * (sortPasses(n, b) - 1);
}

/**
 * I/O of hash aggregation over N pages with G groups, where memory holds `cap` groups.
 * If G ≤ cap, one read. Otherwise the rows of the groups that do not fit (a share 1 − cap/G for groups of
 * equal size) are written to partitions and read back once.
 */
export function hashAggIO(n: number, groups: number, cap: number): number {
  if (groups <= cap) return n;
  const spilled = Math.ceil(n * (1 - cap / groups));
  return n + 2 * spilled;
}

export interface AggResult { groups: Map<number, number>; spilledRows: number; spillWrites: number; spillReads: number; maxGroupsHeld: number; depth: number }

/**
 * Hash aggregation (COUNT per key) with a memory limit of `cap` groups, as PostgreSQL 13+ does it:
 * once the table is full, rows of groups already in it are still aggregated in place, and rows of new
 * groups are written to one of `fanout` partitions (pages of `tpp` rows). Each partition is then
 * aggregated in the same way, with a new hash seed.
 */
export function hashAggregate(keys: number[], cap: number, tpp = 4, fanout = 4): AggResult {
  const res: AggResult = { groups: new Map(), spilledRows: 0, spillWrites: 0, spillReads: 0, maxGroupsHeld: 0, depth: 0 };
  const h = (k: number, seed: number) => { let x = Math.imul(k ^ seed, 0x9e3779b1); x ^= x >>> 15; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; return x >>> 0; };
  const go = (rows: number[], depth: number) => {
    res.depth = Math.max(res.depth, depth);
    const t = new Map<number, number>();
    const parts: number[][] = Array.from({ length: fanout }, () => []);
    for (const k of rows) {
      const c = t.get(k);
      if (c !== undefined) t.set(k, c + 1);
      else if (t.size < cap) t.set(k, 1);
      else { parts[h(k, depth + 1) % fanout]!.push(k); res.spilledRows++; }
    }
    res.maxGroupsHeld = Math.max(res.maxGroupsHeld, t.size);
    for (const [k, c] of t) res.groups.set(k, (res.groups.get(k) ?? 0) + c);
    for (const p of parts) {
      if (!p.length) continue;
      const pages = Math.ceil(p.length / tpp);
      res.spillWrites += pages;
      res.spillReads += pages;
      go(p, depth + 1);
    }
  };
  go(keys, 0);
  return res;
}

/** Sort-based aggregation (COUNT per key): sort, then count equal neighbors. */
export function sortAggregate(keys: number[]): Map<number, number> {
  const s = [...keys].sort((a, b) => a - b);
  const out = new Map<number, number>();
  for (const k of s) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

// ------------------------------------------------------------------ top-N

/**
 * ORDER BY key LIMIT k with a max-heap of k entries (PostgreSQL "top-N heapsort").
 * Each new key is compared with the heap top; only keys smaller than the top enter the heap.
 */
export function topN(keys: number[], k: number): { top: number[]; comparisons: number } {
  let comparisons = 0;
  const h: number[] = [];
  const gt = (a: number, b: number) => { comparisons++; return a > b; };
  const siftDown = () => {
    for (let i = 0; ;) {
      const l = 2 * i + 1, r = l + 1;
      let s = i;
      if (l < h.length && gt(h[l]!, h[s]!)) s = l;
      if (r < h.length && gt(h[r]!, h[s]!)) s = r;
      if (s === i) break;
      [h[i], h[s]] = [h[s]!, h[i]!]; i = s;
    }
  };
  for (const x of keys) {
    if (h.length < k) {
      h.push(x);
      for (let i = h.length - 1; i > 0;) { const p = (i - 1) >> 1; if (!gt(h[i]!, h[p]!)) break; [h[i], h[p]] = [h[p]!, h[i]!]; i = p; }
    } else if (gt(h[0]!, x)) { h[0] = x; siftDown(); }
  }
  return { top: [...h].sort((a, b) => a - b), comparisons };
}

/** Comparisons of a full sort of n keys with merge sort, counted. */
export function mergeSortComparisons(keys: number[]): number {
  let c = 0;
  const a = [...keys], tmp = new Array<number>(a.length);
  const rec = (lo: number, hi: number) => {
    if (hi - lo < 2) return;
    const mid = (lo + hi) >> 1;
    rec(lo, mid); rec(mid, hi);
    let i = lo, j = mid, k = lo;
    while (i < mid && j < hi) { c++; tmp[k++] = a[i]! <= a[j]! ? a[i++]! : a[j++]!; }
    while (i < mid) tmp[k++] = a[i++]!;
    while (j < hi) tmp[k++] = a[j++]!;
    for (let x = lo; x < hi; x++) a[x] = tmp[x]!;
  };
  rec(0, a.length);
  return c;
}
