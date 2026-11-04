/**
 * Correlated columns: an address table where zip determines city, and three ways to estimate
 * `city = ? AND zip = ?` and `GROUP BY city, zip`:
 *
 * - "indep": per-column statistics and the independence assumption, sel = P(city) × P(zip)
 * - "deps":  CREATE STATISTICS (dependencies): a functional dependency zip ⇒ city with degree d,
 *            sel = d × min(P(city), P(zip)) + (1 − d) × P(city) × P(zip)   (dependencies.c)
 * - "mcv":   CREATE STATISTICS (mcv): a list of the most common (city, zip) pairs with their
 *            frequencies; a pair not in the list falls back to the independence estimate
 *            (mcv_combine_selectivities)
 * - ndistinct statistics give the exact number of (city, zip) groups.
 *
 * Rows are assigned deterministically, so with noise 0 every count is exact.
 */
import { mulberry32 } from "../../rng";

export interface AddrSetup { rows: number; cities: number; zipsPerCity: number; /** fraction of rows whose city is random */ noise: number; seed?: number }
export interface AddrTable { city: Int32Array; zip: Int32Array; setup: AddrSetup }

export const cityName = (c: number) => `C${c + 1}`;
export const zipName = (z: number, zpc: number) => `${String(10000 + Math.floor(z / zpc) * 100 + (z % zpc) + 1)}`;

export function addresses(s: AddrSetup): AddrTable {
  const rng = mulberry32(s.seed ?? 9);
  const nz = s.cities * s.zipsPerCity;
  const city = new Int32Array(s.rows), zip = new Int32Array(s.rows);
  for (let i = 0; i < s.rows; i++) {
    const z = i % nz;
    zip[i] = z;
    city[i] = rng() < s.noise ? Math.floor(rng() * s.cities) : Math.floor(z / s.zipsPerCity);
  }
  return { city, zip, setup: s };
}

export interface ColStats { freqCity: Float64Array; freqZip: Float64Array; ndCity: number; ndZip: number }
export interface ExtStats {
  /** Degree of the dependency zip ⇒ city (0..1), computed like PostgreSQL's dependency_degree(). */
  degree: number;
  /** Most common (city, zip) pairs: key = city * nz + zip. */
  mcv: Map<number, number>;
  mcvTotal: number;
  /** Distinct (city, zip) pairs. */
  ndPairs: number;
}

export function colStats(t: AddrTable): ColStats {
  const { cities, zipsPerCity } = t.setup, nz = cities * zipsPerCity, n = t.city.length;
  const fc = new Float64Array(cities), fz = new Float64Array(nz);
  for (let i = 0; i < n; i++) { fc[t.city[i]!]! += 1 / n; fz[t.zip[i]!]! += 1 / n; }
  return { freqCity: fc, freqZip: fz, ndCity: fc.filter((x) => x > 0).length, ndZip: fz.filter((x) => x > 0).length };
}

/**
 * dependency_degree(zip ⇒ city): group rows by zip; a group "supports" the dependency if all its rows
 * have the same city. The degree is the fraction of rows in supporting groups.
 */
export function extStats(t: AddrTable, mcvTarget = 100): ExtStats {
  const { cities, zipsPerCity } = t.setup, nz = cities * zipsPerCity, n = t.city.length;
  const firstCity = new Int32Array(nz).fill(-1), consistent = new Uint8Array(nz).fill(1), size = new Float64Array(nz);
  const pairs = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const z = t.zip[i]!, c = t.city[i]!;
    size[z]!++;
    if (firstCity[z] === -1) firstCity[z] = c; else if (firstCity[z] !== c) consistent[z] = 0;
    const k = c * nz + z;
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  let supported = 0;
  for (let z = 0; z < nz; z++) if (consistent[z]) supported += size[z]!;
  const sorted = [...pairs.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, mcvTarget);
  const mcv = new Map(sorted.map(([k, c]) => [k, c / n]));
  return { degree: supported / n, mcv, mcvTotal: [...mcv.values()].reduce((a, b) => a + b, 0), ndPairs: pairs.size };
}

export type EstMode = "indep" | "deps" | "mcv";
export const MODE_LABEL: Record<EstMode, string> = { indep: "per-column stats", deps: "+ dependencies", mcv: "+ mcv" };

/** Estimated rows for `city = c AND zip = z`. */
export function estimatePair(t: AddrTable, cs: ColStats, es: ExtStats, c: number, z: number, mode: EstMode): number {
  const n = t.city.length, nz = t.setup.cities * t.setup.zipsPerCity;
  const pc = cs.freqCity[c] ?? 0, pz = cs.freqZip[z] ?? 0;
  const simple = pc * pz;
  if (mode === "indep") return simple * n;
  if (mode === "deps") { const d = es.degree; return (d * Math.min(pc, pz) + (1 - d) * simple) * n; }
  // mcv_combine_selectivities: MCV matches exactly, plus the non-MCV part (independence minus the
  // base selectivity of the matched items), capped by the rows the MCV list does not cover.
  const f = es.mcv.get(c * nz + z);
  const mcvSel = f ?? 0, mcvBase = f !== undefined ? simple : 0;
  let other = Math.min(1, Math.max(0, simple - mcvBase));
  other = Math.min(other, 1 - es.mcvTotal);
  return (mcvSel + other) * n;
}

export function truePair(t: AddrTable, c: number, z: number): number {
  let k = 0;
  for (let i = 0; i < t.city.length; i++) if (t.city[i] === c && t.zip[i] === z) k++;
  return k;
}

/** estimate_num_groups for GROUP BY city, zip: product of per-column n_distinct, capped at the row count; or the ndistinct statistic. */
export function estimateGroups(t: AddrTable, cs: ColStats, es: ExtStats, useNdistinct: boolean): number {
  return useNdistinct ? es.ndPairs : Math.min(t.city.length, cs.ndCity * cs.ndZip);
}

/** The three queries the demo shows: a matching pair, a pair that cannot exist, and GROUP BY. */
export function correlatedReport(s: AddrSetup, mcvTarget = 100) {
  const t = addresses(s), cs = colStats(t), es = extStats(t, mcvTarget);
  const zpc = s.zipsPerCity;
  const c = Math.min(2, s.cities - 1);
  const zMatch = c * zpc + Math.min(1, zpc - 1);
  const otherCity = (c + 1) % s.cities;
  const zOther = otherCity * zpc;
  const modes: EstMode[] = ["indep", "deps", "mcv"];
  const row = (cc: number, zz: number) => ({
    city: cityName(cc), zip: zipName(zz, zpc), truth: truePair(t, cc, zz),
    est: Object.fromEntries(modes.map((m) => [m, estimatePair(t, cs, es, cc, zz, m)])) as Record<EstMode, number>,
  });
  return {
    match: row(c, zMatch),
    mismatch: s.cities > 1 ? row(c, zOther) : null,
    groups: { truth: es.ndPairs, indep: estimateGroups(t, cs, es, false), ndistinct: estimateGroups(t, cs, es, true) },
    degree: es.degree, mcvItems: es.mcv.size, mcvTotal: es.mcvTotal, pairs: es.ndPairs,
  };
}
