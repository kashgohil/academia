/**
 * Distributed Systems, module "Data systems": reference models on the shared Net (src/sims/dist/net.ts).
 *
 * - gossip.ts: one rumor spread by push, pull or push-pull in synchronous rounds, with fanout, loss and rumor
 *   mongering (stop after k useless contacts) (`runSpread`, `spreadStats`); the mean-field recurrences
 *   (`meanField`) and the classic round bounds (`pushRounds`, `pushPullRounds`).
 * - swim.ts: SWIM membership with ping, ping-req via k helpers, suspicion with incarnation numbers, piggybacked
 *   updates and an optional full-state sync; faults: a slow, isolated or crashed member (`runSwim`, `swimSummary`,
 *   `viewSpans`, `probeFailP`).
 * - replog.ts: one Kafka-style partition with three replicas, follower fetches, ISR, high watermark, acks=0/1/all,
 *   min.insync.replicas, a controller with clean or unclean election and leader epochs (`runRepLog`).
 * - groups.ts: a consumer group as a fluid model: assignors (range, round-robin, sticky), eager or cooperative
 *   rebalances, crashed consumers found after the session timeout, and lag per partition (`assign`, `runGroup`).
 * - stream.ts: event-time windows (tumbling, sliding, session) with a bounded-out-of-orderness watermark, allowed
 *   lateness and the batch answer for comparison (`streamEvents`, `runStream`, `batchResult`).
 * - checkpoint.ts: barrier checkpoints across two sources, a counting operator and a sink, aligned or not, with a
 *   crash and a restart from the last complete checkpoint (`runCheckpoint`).
 * - eos.ts: a source → processor → sink pipeline under at-most-once, at-least-once and exactly-once with chosen
 *   crash points and retries (`runPipeline`); a Kafka-style idempotent producer driven by hold mode
 *   (`runIdemProducer`).
 */
export * from "./gossip";
export * from "./swim";
export * from "./replog";
export * from "./groups";
export * from "./stream";
export * from "./checkpoint";
export * from "./eos";
