/**
 * The capstone of the Distributed Systems track: a replicated key-value store built on the committed sims, and the
 * tools to test it. Nothing in src/sims/dist/consensus or src/sims/dist/consistency is changed.
 *
 * store.ts   KvStore: a RaftCluster (consensus/raft) as the log, StoreMachine (put, get, del, cas, a revision),
 *            KvClient with sessions (exactly-once writes), read paths "log", "readindex", "lease" and the buggy
 *            "local", faults (crash, recover, cuts, pause, drop rate, delay, clock rate, targeted faults), four
 *            deliberate bugs, snapshots and membership changes. history() and check() feed the linearizability
 *            checker of consistency/. raftViolations() filters one false positive of the Raft SafetyMonitor.
 *            Added on top of the Raft API: ReadIndex (RiPing and RiAck messages), lease reads (AppendEntries stamped
 *            with the leader's clock and echoed in replies), process pauses, per-server clock rates.
 * fuzz.ts    Deterministic simulation testing: genSchedule (with swarm testing), runSim (a pure function of seed,
 *            schedule and config, with a trace fingerprint), shrink (1-minimal fault schedules), Campaign (coverage).
 * arch.ts    traceOp: one put, get, cas or two-range transaction through the layers of a range-partitioned store,
 *            measured on real store runs; readCost and writeCost for each read path.
 * design.ts  The design explorer: single group or multi-Raft, read path, splits, replicas; what follows.
 * compare.ts etcd, CockroachDB and DynamoDB: message flows of one write and one read, and workload fit.
 */
export * from "./store";
export * from "./fuzz";
export * from "./arch";
export * from "./design";
export * from "./compare";
export * from "./scenarios";
