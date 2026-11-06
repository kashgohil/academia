/**
 * Raft on the shared deterministic network. The capstone builds its key-value store on this module.
 *
 * Create a cluster, run it, submit commands, read the state:
 *
 *   const c = new RaftCluster({ servers: 5, net: { seed: 1, latency: { min: 5, max: 15 } } });
 *   c.runUntilTrue(() => c.leader() !== null, 2000);
 *   c.propose(c.leader()!, { op: "set", key: "x", value: 1 });
 *   c.run(200);
 *   (c.node(2).machine as KvMachine).data.get("x"); // 1 on every server that has applied it
 *
 * - `RaftCluster` (raft.ts): servers 0 .. n-1 on `c.net`. Options in `RaftOptions` (types.ts): timeouts, pre-vote,
 *   check-quorum, the current-term commit rule, batching and pipelining, snapshots, a disk model.
 *   Faults: `crash`, `recover`, `partition`, `heal`, and `c.net.cfg.dropRate` style options at creation.
 *   Control: `propose`, `timeout` (force an election), `transferLeadership`, `changeConfig` (joint, single, direct),
 *   `snapshotNow`. Inspect: `c.node(i)` (term, role, log, commitIndex, snapshot, config), `c.events`, `c.violations`.
 * - `RaftClient` (client.ts): a client on its own network node, with retries and optional sessions.
 * - `SafetyMonitor` (raft.ts): records breaks of Election Safety, Leader Append-Only, Log Matching, Leader
 *   Completeness and State Machine Safety.
 * - `KvMachine` (machine.ts): the default state machine.
 * - scenarios.ts: the scripted runs and sweeps that the lessons draw.
 */
export * from "./types";
export * from "./machine";
export * from "./raft";
export * from "./client";
export * from "./scenarios";
