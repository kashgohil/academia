/**
 * Sims for the verification module of the concurrency track.
 *
 * - lin.ts: histories of concurrent queues and stacks, the Wing and Gong order search (real time for
 *   linearizability, program order for sequential consistency), replay of chosen linearization points, and three
 *   queue implementations on the step machine (a spinlock queue, an SPSC array queue, the Herlihy-Wing queue), with
 *   a seeded random scheduler that records histories.
 * - mc.ts: model checking: schedule counts, explicit-state search with hashing, sleep-set search (partial order
 *   reduction), Mazurkiewicz traces of a two-thread program, and bug hunts by preemption bounding, random walks and
 *   PCT on a racy counter.
 * - tla.ts: a tiny explicit-state checker in the style of TLC (breadth-first, shortest counterexample, deadlock
 *   check), with the DieHard jugs spec and a blocking queue spec with wait and notify.
 */
export * from "./lin";
export * from "./mc";
export * from "./tla";
