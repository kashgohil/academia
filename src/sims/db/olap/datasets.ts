/**
 * Fixed, seeded data sets for the compression lessons, and operations on compressed data.
 */
import { mulberry32 } from "../../rng";
import { runsOf, type ColType, type Run, type Value } from "./encodings";

export type DatasetName = "ids" | "timestamps" | "days" | "countries" | "prices";
export interface Dataset { name: DatasetName; label: string; type: ColType; values: Value[] }
export const LAB_ROWS = 4096;
export const COUNTRIES = ["DE", "US", "FR", "GB", "JP", "IN", "BR", "NL"] as const;
const COUNTRY_WEIGHTS = [30, 25, 12, 10, 8, 7, 5, 3];

function pickWeighted(rng: () => number, weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rng() * total;
  for (let i = 0; i < weights.length; i++) { x -= weights[i]!; if (x < 0) return i; }
  return weights.length - 1;
}

/** The five columns of the compression lab, n values each. */
export function dataset(name: DatasetName, n = LAB_ROWS, seed = 7): Dataset {
  const rng = mulberry32(seed);
  switch (name) {
    case "ids": {
      // Sorted order IDs: start at 1,000,000 and grow by 1 to 4 (some IDs are gaps).
      let x = 1_000_000;
      const values = Array.from({ length: n }, () => (x += 1 + Math.floor(rng() * 4)));
      return { name, label: "sorted IDs (int32)", type: "int32", values };
    }
    case "timestamps": {
      // One event per second, ±50 ms of jitter, as int64 milliseconds since 1970.
      const t0 = 1_767_225_600_000; // 2026-01-01T00:00:00Z
      const values = Array.from({ length: n }, (_, i) => t0 + i * 1000 + Math.floor(rng() * 101) - 50);
      return { name, label: "timestamps (int64 ms)", type: "int64", values };
    }
    case "days": {
      // A date column of a table sorted by date: 30 days, about 137 rows per day.
      const values = Array.from({ length: n }, (_, i) => 20_454 + Math.floor((i * 30) / n)); // 20,454 = 2026-01-01 in days since 1970
      return { name, label: "dates, sorted (int32 days)", type: "int32", values };
    }
    case "countries": {
      const values = Array.from({ length: n }, () => COUNTRIES[pickWeighted(rng, COUNTRY_WEIGHTS)]!);
      return { name, label: "country codes (8 distinct strings)", type: "string", values };
    }
    case "prices": {
      const values = Array.from({ length: n }, () => rng() * 1000);
      return { name, label: "random floats (float64)", type: "float64", values };
    }
  }
}
export const DATASETS: DatasetName[] = ["ids", "timestamps", "days", "countries", "prices"];

// ---------------- operating on compressed data ----------------

/** A column of n ints made of runs whose lengths are 1 + geometric, with the given mean. */
export function runColumn(n: number, meanRun: number, seed = 3): number[] {
  const rng = mulberry32(seed);
  const out: number[] = [];
  let v = 10 + Math.floor(rng() * 90);
  const p = 1 / Math.max(1, meanRun);
  while (out.length < n) {
    let len = 1;
    while (rng() > p) len++;
    for (let i = 0; i < len && out.length < n; i++) out.push(v);
    let next = v;
    while (next === v) next = 10 + Math.floor(rng() * 90);
    v = next;
  }
  return out;
}

export interface OpCount { result: number; ops: number }

/** SUM over plain values: one addition per value. */
export function sumPlain(values: readonly number[]): OpCount {
  let s = 0;
  for (const v of values) s += v;
  return { result: s, ops: values.length };
}
/** SUM after decoding RLE: n writes to expand the runs, then n additions. */
export function sumDecodeThenAdd(runs: readonly Run[]): OpCount {
  const vals: number[] = [];
  for (const r of runs) for (let i = 0; i < r.length; i++) vals.push(r.value as number);
  const s = sumPlain(vals);
  return { result: s.result, ops: vals.length + s.ops };
}
/** SUM directly on RLE: one multiplication and one addition per run. */
export function sumOnRuns(runs: readonly Run[]): OpCount {
  let s = 0;
  for (const r of runs) s += (r.value as number) * r.length;
  return { result: s, ops: 2 * runs.length };
}
export { runsOf };

/** WHERE col = needle on plain strings: count byte comparisons (stop at the first different byte). */
export function countEqStrings(values: readonly string[], needle: string): { count: number; byteCompares: number } {
  let count = 0, cmp = 0;
  for (const v of values) {
    let i = 0;
    const len = Math.min(v.length, needle.length);
    while (i < len) { cmp++; if (v.charCodeAt(i) !== needle.charCodeAt(i)) break; i++; }
    if (i === len && v.length === needle.length) count++;
  }
  return { count, byteCompares: cmp };
}

/** WHERE col = needle on a dictionary column: find the code once, then compare integer codes. */
export function countEqDict(values: readonly string[], needle: string): { count: number; dictCompares: number; codeCompares: number; code: number } {
  const dict: string[] = [];
  const index = new Map<string, number>();
  const codes = values.map((v) => { let c = index.get(v); if (c === undefined) { c = dict.length; index.set(v, c); dict.push(v); } return c; });
  let dictCompares = 0, code = -1;
  for (let i = 0; i < dict.length; i++) { dictCompares++; if (dict[i] === needle) { code = i; break; } }
  let count = 0;
  if (code >= 0) for (const c of codes) if (c === code) count++;
  return { count, dictCompares, codeCompares: code >= 0 ? codes.length : 0, code };
}

// ---------------- sort order and run counts ----------------

export const REGIONS = ["EU", "NA", "APAC", "LATAM"] as const;
const REGION_COUNTRIES: Record<(typeof REGIONS)[number], string[]> = {
  EU: ["DE", "FR", "GB", "NL", "ES", "IT"],
  NA: ["US", "CA", "MX"],
  APAC: ["JP", "IN", "AU", "SG", "KR"],
  LATAM: ["BR", "AR", "CL"],
};
export const STATUSES = ["shipped", "open", "returned"] as const;

export interface SalesRow { status: string; region: string; country: string; day: number; customer: number }
export const SALES_COLUMNS = ["status", "region", "country", "day", "customer"] as const;
export type SalesColumn = (typeof SALES_COLUMNS)[number];

/** A sales table: region (4), country (17, each in one region), status (3), day (30), customer (1,000). */
export function salesTable(n = LAB_ROWS, seed = 11): SalesRow[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const region = REGIONS[pickWeighted(rng, [40, 30, 20, 10])]!;
    const cs = REGION_COUNTRIES[region];
    return {
      status: STATUSES[pickWeighted(rng, [80, 15, 5])]!,
      region,
      country: cs[Math.floor(rng() * cs.length)]!,
      day: 1 + Math.floor(rng() * 30),
      customer: Math.floor(rng() * 1000),
    };
  });
}

export type SortKey = SalesColumn[];
export const SORT_KEYS: { id: string; label: string; key: SortKey }[] = [
  { id: "none", label: "unsorted", key: [] },
  { id: "day", label: "day", key: ["day"] },
  { id: "region", label: "region, country", key: ["region", "country"] },
  { id: "low", label: "status, region, country, day", key: ["status", "region", "country", "day"] },
  { id: "customer", label: "customer, status", key: ["customer", "status"] },
];

export function sortRows(rows: readonly SalesRow[], key: SortKey): SalesRow[] {
  const out = rows.slice();
  if (key.length === 0) return out;
  out.sort((a, b) => {
    for (const k of key) { const x = a[k], y = b[k]; if (x < y) return -1; if (x > y) return 1; }
    return 0;
  });
  return out;
}

/** Number of runs in each column after sorting by `key`. */
export function runCounts(rows: readonly SalesRow[], key: SortKey): Record<SalesColumn, number> {
  const s = sortRows(rows, key);
  const out = {} as Record<SalesColumn, number>;
  for (const c of SALES_COLUMNS) out[c] = runsOf(s.map((r) => r[c])).length;
  return out;
}
