/**
 * Query optimizer reference models for the Databases track (module "optimizer").
 *
 *   import { accessPaths, PG_DEFAULTS, equiDepth, dpBushy, renderExplain } from "@/sims/db/optimizer";
 *
 * - cost.ts        PostgreSQL-style cost formulas: seq, index and bitmap scans, Mackert–Lohman,
 *                  hash join, nested loop, sort, aggregate, limit; example tables (tenk1, orders)
 * - stats.ts       sampling, equi-width and equi-depth histograms, MCV lists, range estimates,
 *                  q-error, Duj1 n_distinct estimator, HyperLogLog
 * - correlated.ts  city/zip table, independence vs dependencies vs multi-column MCV estimates
 * - qerror.ts      how per-estimate errors multiply through joins
 * - joins.ts       join graphs, C_out, DP over subsets (bushy, left-deep, worst), greedy GOO,
 *                  random search, brute-force enumeration, search-space counts
 * - plan.ts        plan trees with estimates and a simple execution model, rendered as
 *                  PostgreSQL EXPLAIN (ANALYZE, BUFFERS) text and MySQL FORMAT=TREE; scenarios
 */
export * from "./cost";
export * from "./stats";
export * from "./correlated";
export * from "./qerror";
export * from "./joins";
export * from "./plan";
