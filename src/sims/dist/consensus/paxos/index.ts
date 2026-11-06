/**
 * Consensus, the Paxos family and Byzantine agreement: reference implementations for the lessons
 * the-consensus-problem, flp-impossibility, paxos, multi-paxos and byzantine-fault-tolerance.
 * The Raft lessons have their own code in ../raft.
 *
 * - quorum.ts       majority size, fault tolerance (2f + 1 and 3f + 1), overlap of quorums, Flexible Paxos q1 + q2 > n
 * - naive.ts        "the leader decides", a protocol that breaks under a crash, a partition or one slow message
 * - valence.ts      a tiny deterministic protocol (3 processes) with an exhaustive valence search and the FLP adversary
 * - benor.ts        Ben-Or's randomized consensus on Net: termination with probability 1
 * - paxos.ts        single-decree Paxos: a pure core, a hand scheduler, a Net driver (duelling proposers, chaos runs),
 *                   and an exhaustive search over every schedule for small bounds
 * - multipaxos.ts   Multi-Paxos on Net: one phase 1 for all slots, no-ops for gaps, Flexible Paxos quorums, and
 *                   message counts per command
 * - pbft.ts         the PBFT normal case on Net with traitors, and a linear collector variant for message counts
 *
 * Every protocol runs on src/sims/dist/net.ts, except the stepper of the Paxos lesson: Net has no way to let a
 * learner pick the next delivery, so HandNet (in paxos.ts) does that and keeps Net's message records for drawing.
 */
export * from "./quorum";
export * from "./naive";
export * from "./valence";
export * from "./benor";
export * from "./paxos";
export * from "./multipaxos";
export * from "./pbft";
