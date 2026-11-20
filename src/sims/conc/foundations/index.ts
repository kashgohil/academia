/**
 * Sims for the concurrency "foundations" module. Every timing number comes from the shared Runtime (../runtime.ts),
 * and every interleaving count from the step-level machine (../../os/sync/machine.ts).
 *
 * - parallel.ts (concurrency vs parallelism): `runMix` and `summarizeMix` run tasks that compute and wait for I/O,
 *   one after another or as threads on P cores. `runPool` and `poolKnee` size a thread pool for jobs that compute C
 *   and wait W.
 * - races.ts (race conditions): `ctaProg`, `ctaCounts`, `ctaBugSchedule` for check-then-act programs (withdraw, lazy
 *   init, TOCTOU) and their fixes; `windowRun`, `windowEstimate`, `chanceToSee`, `opsToSee` for the race window;
 *   `hbProg`, `hbCounts`, `hbRead`, `hbWrite`, `hbAcquire`, `hbRelease` for a vector-clock race detector.
 * - atomicity.ts (atomicity): `transferProg`, `transferCounts`, `transferViolation` for a transfer and an audit over
 *   two accounts with six schemes; `tornProg`, `tornCounts`, `tornOutcome` for torn Go interfaces and slice headers;
 *   `runSnapshot` for the cost of a mutex, a reader-writer lock, a seqlock and copy-on-write under load.
 * - scaling.ts (Amdahl and Gustafson): the formulas `amdahl`, `gustafson`, `karpFlatt`, `usl`, `uslPeak`, `fitUsl`;
 *   `runScale` and `measuredSpeedup` measure speedup of a serial phase or a lock-protected serial part; `runUsl` is a
 *   throughput benchmark whose critical section grows with the thread count.
 */
export * from "./parallel";
export * from "./races";
export * from "./atomicity";
export * from "./scaling";
