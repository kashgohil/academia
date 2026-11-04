/**
 * "More indexes" sims for the Databases track. Pure TypeScript, deterministic, no React.
 *
 *   import { hash, art, rtree } from "@/sims/db/indexes";   // or import a file directly
 *
 * - hash.ts      StaticHash (overflow chains), ExtendibleHash (directory, global/local depth),
 *                LinearHash (split pointer), open addressing (linear probing, Robin Hood), cuckoo
 *                max load, page-cost experiments, Bitcask keydir size
 * - secondary.ts PostgreSQL-style cost model (seq, index, bitmap, index-only scans), crossovers,
 *                CompositeIndex with the leftmost-prefix rule, the planner toy, InnoDB vs PostgreSQL
 *                lookup traces on real B+ trees
 * - art.ts       Adaptive radix tree (Node4/16/48/256, path compression, lazy expansion, delete),
 *                binary-comparable key encodings, memory-per-key models
 * - inverted.ts  tokenizer, posting lists with positions, merge and galloping intersection,
 *                phrase queries, delta + varint / FOR / PForDelta codecs, BM25
 * - rtree.ts     Guttman R-tree with quadratic split, range search trace, best-first kNN, delete
 * - sfc.ts       Z-order and Hilbert curves, query box → 1D key ranges, geohash
 */
export * as hash from "./hash";
export * as secondary from "./secondary";
export * as art from "./art";
export * as inverted from "./inverted";
export * as rtree from "./rtree";
export * as sfc from "./sfc";
