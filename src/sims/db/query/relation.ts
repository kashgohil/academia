/**
 * Relations for the query-processing sims: values, rows, schemas, sample tables and bag helpers.
 *
 * - A `Value` is a number, a string or NULL (`null`).
 * - A `Relation` is a schema (qualified columns) plus a bag of rows (duplicates allowed, order irrelevant).
 * - Column references are "name" or "rel.name". `resolve` finds the index and throws on unknown or
 *   ambiguous names, like a SQL binder.
 *
 * Sample data: `SAMPLE_DB` (8 employees, 4 departments, 5 projects) with NULLs placed to show three-valued
 * logic; `scaledDb(nEmp)` generates bigger deterministic tables with the same schemas.
 */
import { mulberry32 } from "../../rng";

export type Value = number | string | null;
export type Row = Value[];
export interface Col { rel: string; name: string }
export interface Relation { cols: Col[]; rows: Row[] }
export type Db = Record<string, Relation>;

export const colName = (c: Col) => `${c.rel}.${c.name}`;

/** Index of a column reference ("name" or "rel.name"). Throws if unknown or ambiguous. */
export function resolve(cols: Col[], ref: string): number {
  const dot = ref.indexOf(".");
  const rel = dot >= 0 ? ref.slice(0, dot) : null;
  const name = dot >= 0 ? ref.slice(dot + 1) : ref;
  const hits: number[] = [];
  cols.forEach((c, i) => { if (c.name === name && (rel === null || c.rel === rel)) hits.push(i); });
  if (hits.length === 0) throw new Error(`unknown column ${ref}`);
  if (hits.length > 1) throw new Error(`ambiguous column ${ref}`);
  return hits[0]!;
}

/** True if `ref` resolves to exactly one column. */
export function hasCol(cols: Col[], ref: string): boolean {
  try { resolve(cols, ref); return true; } catch { return false; }
}

/** Short display names: "name" if unique in the schema, else "rel.name". */
export function displayNames(cols: Col[]): string[] {
  return cols.map((c) => (cols.filter((d) => d.name === c.name).length > 1 ? colName(c) : c.name));
}

export function table(rel: string, names: string[], rows: Row[]): Relation {
  return { cols: names.map((name) => ({ rel, name })), rows };
}

/** SQL-style comparison key: NULLs are equal to each other here (used for DISTINCT, GROUP BY and set operations). */
export const rowKey = (r: Row) => JSON.stringify(r);

/** Bag equality: same rows with the same multiplicities, in any order. */
export function sameBag(a: Row[], b: Row[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map<string, number>();
  for (const r of a) m.set(rowKey(r), (m.get(rowKey(r)) ?? 0) + 1);
  for (const r of b) {
    const k = rowKey(r), n = m.get(k) ?? 0;
    if (n === 0) return false;
    m.set(k, n - 1);
  }
  return true;
}

export const fmtValue = (v: Value) => (v === null ? "NULL" : typeof v === "string" ? v : String(v));

// ------------------------------------------------------------------ sample tables

/**
 * emp(eid, name, did, salary, city), dept(did, dname, city), proj(pid, pname, did, budget).
 * Flo has no department (did NULL) and Gus has no salary (NULL). Dept 40 has no employees.
 * emp and dept share two column names (did, city), so a natural join matches on both.
 */
export const SAMPLE_DB: Db = {
  emp: table("emp", ["eid", "name", "did", "salary", "city"], [
    [1, "Ada", 10, 85, "Berlin"],
    [2, "Bo", 10, 52, "Paris"],
    [3, "Cy", 20, 61, "Berlin"],
    [4, "Di", 20, 47, "Rome"],
    [5, "Ed", 30, 70, "Paris"],
    [6, "Flo", null, 58, "Berlin"],
    [7, "Gus", 30, null, "Rome"],
    [8, "Hal", 10, 52, "Rome"],
  ]),
  dept: table("dept", ["did", "dname", "city"], [
    [10, "Storage", "Berlin"],
    [20, "Query", "Paris"],
    [30, "Txn", "Rome"],
    [40, "Ops", "Oslo"],
  ]),
  proj: table("proj", ["pid", "pname", "did", "budget"], [
    [100, "Btree", 10, 120],
    [101, "LSM", 10, 80],
    [102, "Planner", 20, 150],
    [103, "WAL", 30, 60],
    [104, "Audit", null, 40],
  ]),
};

export const CITIES = ["Berlin", "Paris", "Rome", "Oslo"] as const;

/**
 * Bigger deterministic tables with the same schemas: `nEmp` employees, `nDept` departments (cities cycle
 * through CITIES), `nProj` projects with budgets 10..200. Used by the rewrite demo to make sizes visible.
 */
export function scaledDb(nEmp: number, nDept = 8, nProj = 30, seed = 7): Db {
  const rnd = mulberry32(seed);
  const pick = (n: number) => Math.floor(rnd() * n);
  const dids = Array.from({ length: nDept }, (_, i) => 10 * (i + 1));
  const dept = table("dept", ["did", "dname", "city"], dids.map((d, i) => [d, `d${d}`, CITIES[i % CITIES.length]!]));
  // Projects first, so that changing nEmp does not change the projects.
  const proj = table("proj", ["pid", "pname", "did", "budget"], Array.from({ length: nProj }, (_, i) => [
    100 + i, `p${100 + i}`, dids[pick(nDept)]!, 10 * (1 + pick(20)),
  ]));
  const emp = table("emp", ["eid", "name", "did", "salary", "city"], Array.from({ length: nEmp }, (_, i) => [
    i + 1, `e${i + 1}`, dids[pick(nDept)]!, 40 + pick(60), CITIES[pick(CITIES.length)]!,
  ]));
  return { emp, dept, proj };
}
