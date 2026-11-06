/**
 * Coordination: leases, fencing tokens, distributed locks and coordination services, all on the shared Net.
 *
 * - lease.ts     LeaseService (grant, renew, expire by the service's clock, a token per grant), FencedStore (checks
 *                tokens: never, on writes, or on every access), Pausable (a process that stops for a GC pause),
 *                leaseTimeline (A pauses, B takes over, A's stale write lands), marginNeeded (the safety margin for
 *                a drift bound, a network delay and a pause), raftLeaseEnd (Raft's lease read bound).
 * - fencing.ts   fencingTrial: clients increment a counter under a lease with random pauses and drift. Counts lost
 *                updates for "lock only", "fence writes only" and "fence every access".
 * - redlock.ts   redlockRun: five Redis-like nodes with SET NX PX and per-node clocks, two Redlock clients, and an
 *                adversary script (cut links, jump a clock, restart a node without persistence, pause a client).
 * - zk.ts        ZkTree (znodes, zxid, ephemeral and sequential nodes; a StateMachine that also runs on Raft),
 *                WatchTable (one-time watches), zkElection (the leader-election recipe with sessions, watching the
 *                parent or the predecessor).
 * - etcd.ts      MvccStore (revisions, create/mod revision, compaction, leases), watchRun (a watch that resumes from a
 *                revision after a cut).
 */
export * from "./lease";
export * from "./fencing";
export * from "./redlock";
export * from "./zk";
export * from "./etcd";
