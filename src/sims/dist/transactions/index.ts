/**
 * Distributed transactions: reference implementations for the "Distributed transactions" module, on the shared Net.
 *
 * - twopc.ts       Two-phase commit with durable logs (forced and unforced records), crashes and recovery, basic and
 *                  presumed-abort logging, read-only votes, query retries and cooperative termination. `replayTpc`
 *                  replays a learner's hold-mode actions; `tpcCost` counts log forces and messages; `inDoubtRun`
 *                  measures how long participants stay in doubt when the coordinator crashes at the commit point.
 * - replicated.ts  2PC whose coordinator log is a Raft group (../consensus/raft): failover time instead of repair time.
 * - threepc.ts     Three-phase commit with a termination protocol, and the scripted crash and partition runs.
 * - saga.ts        A saga engine: orchestration or choreography, compensations, semantic locks, inverse or restore
 *                  compensation, a crash between commit and send, the transactional outbox, idempotent steps.
 * - truetime.ts    TrueTime intervals, commit wait, the external-consistency run and its random trials, and a hot-row
 *                  run for the cost of commit wait.
 * - calvin.ts      A Calvin sequencer with epochs and deterministic (or racing) replicas, and one multi-partition
 *                  transaction under Spanner-style 2PC against Calvin.
 * - percolator.ts  Percolator on a versioned key-value table (data, lock and write columns) with a timestamp oracle,
 *                  lock cleanup by readers, a snapshot isolation checker (checkSI), random concurrent transfers with
 *                  crashes, the Bob-and-Joe stepper, and write skew.
 */
export * from "./twopc";
export * from "./replicated";
export * from "./threepc";
export * from "./saga";
export * from "./truetime";
export * from "./calvin";
export * from "./percolator";
