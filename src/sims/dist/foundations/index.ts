/**
 * Distributed Systems, module 1: Foundations. Small reference models, all on the shared Net (src/sims/dist/net.ts).
 *
 * - availability: any / all / majority of N nodes up; Amdahl and the USL; one big machine (model inputs).
 * - script: scripted adversary runs on Net (timed partitions that lose one chosen message).
 * - partial: a client calls three services; lost request, lost reply, slow reply and a crash look the same to it.
 * - generals: the two generals, as a messenger chain on Net, and the exhaustive check that no threshold rule works.
 * - playground: a free run with latency, loss, duplication, FIFO and a partition, and counts of what happened.
 * - failmodels: one quorum write under crash-stop, crash-recovery, omission, timing and Byzantine faults.
 * - quorum: nodes needed (f + 1, 2f + 1, 3f + 1), quorum sizes and the smallest intersection.
 * - fanout: the latency of a request that waits for k of n backends, from a backend distribution.
 * - bdp: the bandwidth-delay product and window-limited throughput.
 * - retry: an overloaded server with a bounded queue; no backoff, exponential, full jitter, a retry budget.
 * - idempotency: "charge $10" with retries, with and without an idempotency key.
 * - detectors: heartbeats with jitter and pauses; a fixed-timeout detector and the phi accrual detector.
 */
export * from "./math";
export * from "./availability";
export * from "./script";
export * from "./partial";
export * from "./generals";
export * from "./playground";
export * from "./failmodels";
export * from "./quorum";
export * from "./fanout";
export * from "./bdp";
export * from "./retry";
export * from "./idempotency";
export * from "./detectors";
