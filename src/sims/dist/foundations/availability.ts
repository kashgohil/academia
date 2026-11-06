/**
 * Why distribute: what N replicas buy in availability and in throughput, and what one machine can do.
 *
 * A node is down with probability p, independently of the others. A service that needs
 * - any 1 of N nodes (a read from any replica) is up when at least one node is up,
 * - all N nodes (a write that waits for every replica, or a request that touches every shard) needs all of them,
 * - a majority of N (a quorum system such as Raft or Paxos) needs more than half.
 * Independence is the optimistic part of this model: a shared switch or a bad deploy takes nodes down together.
 */
import { atLeast } from "./math";

export type Rule = "any" | "all" | "majority";
export const RULES: Rule[] = ["any", "majority", "all"];

/** The number of up nodes that each rule needs. */
export const needed = (rule: Rule, n: number) => (rule === "any" ? 1 : rule === "all" ? n : Math.floor(n / 2) + 1);

/** Probability that the service is up, for n nodes that are each down with probability p. */
export function availability(rule: Rule, n: number, p: number): number {
  return atLeast(n, needed(rule, n), 1 - p);
}

/** The number of nines: 0.999 is 3 nines. */
export const nines = (a: number) => (a >= 1 ? Infinity : -Math.log10(1 - a));

/** Expected minutes down per year (365.25 days). */
export const downtimeMinutesPerYear = (a: number) => (1 - a) * 365.25 * 24 * 60;

/**
 * Amdahl's law: a fraction s of the work is serial, so n workers give a speedup of 1 / (s + (1 - s) / n).
 * The limit for large n is 1 / s.
 */
export const amdahl = (s: number, n: number) => 1 / (s + (1 - s) / n);

/**
 * The Universal Scalability Law (Gunther): contention sigma and coherence (crosstalk) kappa.
 * Throughput relative to one node is n / (1 + sigma (n - 1) + kappa n (n - 1)). With kappa > 0 it has a peak and then falls.
 */
export const usl = (n: number, sigma: number, kappa: number) => n / (1 + sigma * (n - 1) + kappa * n * (n - 1));

/** The n where the USL curve peaks: sqrt((1 - sigma) / kappa). */
export const uslPeak = (sigma: number, kappa: number) => (kappa > 0 ? Math.sqrt((1 - sigma) / kappa) : Infinity);

/**
 * One large server. These are MODEL INPUTS, not measurements: round numbers for a large two-socket machine that
 * a cloud provider rents today. Change them and the conclusion moves.
 */
export const BIG_MACHINE = {
  cores: 192,
  ramGiB: 2048,
  nvmeTB: 30,
  nicGbps: 100,
  /** Simple in-memory key-value operations per core per second (model input). */
  kvOpsPerCore: 100_000,
};

/** Requests per second that one big machine can serve for a simple in-memory key-value workload (model). */
export const machineKvOps = (m = BIG_MACHINE) => m.cores * m.kvOpsPerCore;

/** Bytes per second that the NIC of one big machine can move (model). */
export const machineNicBytes = (m = BIG_MACHINE) => (m.nicGbps * 1e9) / 8;
