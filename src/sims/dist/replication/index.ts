/**
 * Replication on the shared deterministic network (src/sims/dist/net.ts). Small reference implementations that
 * the Replication lessons draw and that later modules can reuse.
 *
 * - leader.ts: leader-follower log shipping with sync or async followers (`runLeaderFollower`), promotion after a
 *   leader crash with the count of lost confirmed writes (`failover`), and split brain under a partition with
 *   optional leases (`runSplitBrain`, `sbLostAcked`).
 * - lag.ts: followers that replay with a delay; client sessions that read from replicas with a chosen fix
 *   (`runLag`); a checker for read-your-writes, monotonic-read and consistent-prefix anomalies
 *   (`checkAnomalies`, `summarize`); lag over time under a write burst (`runBurst`, `burstModel`).
 * - multileader.ts: two leaders that write during a partition and reconcile with arrival order, last-write-wins,
 *   a type-aware merge or siblings (`runMultiLeader`); four leaders in all-to-all, ring and star topologies, with
 *   optional causal delivery (`runTopology`).
 * - quorum.ts: a Dynamo-style store for one key with N, W, R, sloppy quorums, hinted handoff and read repair
 *   (`QuorumSim`); one write then one read under chosen failures (`runScenario`); many such runs
 *   (`quorumStats`); the latency of waiting for k of n answers (`quorumLatency`); a quorum read history that is
 *   not linearizable (`runLinScenario`).
 * - merkle.ts: a Merkle tree over key ranges (`buildTree`), the comparison that walks only into differing
 *   subtrees (`diffTrees`), and bytes sent against the number of differing keys (`sweepPoint`).
 */
export * from "./leader";
export * from "./lag";
export * from "./multileader";
export * from "./quorum";
export * from "./merkle";
