/**
 * Analytical (OLAP) storage reference code for the Databases track.
 *
 *   import { Layout, footprint, encode, decode, lz4Compress, runPlan, zoneMaps, prune } from "@/sims/db/olap";
 *
 * - layout.ts    NSM / DSM / PAX page layouts with exact page and cache-line accounting
 * - bytes.ts     byte and bit streams: varints, zigzag, bit-packing
 * - lz4.ts       a real LZ4 block compressor and decompressor
 * - encodings.ts plain, RLE, dictionary, frame of reference, delta, bit-packing, LZ4; chooser
 * - datasets.ts  seeded columns for the compression lab, operations on compressed data, sort order vs runs
 * - exec.ts      a tiny columnar executor: position lists, bitmaps, selection vectors, early vs late plans, cost model
 * - zonemap.ts   zone maps, Z-order (Morton) clustering, Bloom skip indexes, pruning sweeps, BRIN sizes
 */
export * from "./layout";
export * from "./bytes";
export * from "./lz4";
export * from "./encodings";
export * from "./datasets";
export * from "./exec";
export * from "./zonemap";
