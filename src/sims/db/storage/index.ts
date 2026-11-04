/**
 * Storage sims (Databases track, module "storage"). Pure TypeScript, deterministic, no React.
 *
 * - disk:          HDD seek/rotation/transfer model with a request queue; SSD latency and parallelism;
 *                  a page-mapped FTL with garbage collection (`Ftl`, `steadyWa`).
 * - page:          `SlottedPage` over real bytes (PostgreSQL layout), PostgreSQL tuple layout and TOAST limits.
 * - heap:          `HeapFile` with append / first-fit / free-space-map insert strategies; `FreeSpaceMap`;
 *                  sequential scan sizes and PostgreSQL scan cost.
 * - bufferpool:    `BufferPool` with pins, dirty bits and pluggable `ReplacementPolicy`
 *                  (LRU, Clock, LRU-2, 2Q, InnoDB midpoint, PostgreSQL clock sweep + ring); trace helpers.
 * - durability:    `crc32c`; `WriteStack` (page cache → device cache → media, fsync semantics);
 *                  torn-page crash/recovery model; checkpoint cost of full-page writes and doublewrite.
 * - amplification: RA/WA/SA models of B+ tree, LSM (leveled, tiered), log + hash; WA chain and SSD lifetime.
 */
export * from "./disk";
export * from "./page";
export * from "./heap";
export * from "./bufferpool";
export * from "./durability";
export * from "./amplification";
