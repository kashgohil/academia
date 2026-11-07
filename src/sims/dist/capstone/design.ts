/**
 * The design explorer of the architecture lesson: four choices, and what follows from each.
 *
 * Latencies and message counts come from the store sim (arch.ts: readCost, writeCost). Capacity and size come from a
 * stated model with model inputs in DESIGN_INPUTS: every write costs one unit of work on each of its replicas, and a
 * node does `nodeOpsPerSec` units per second.
 */
import { readCost, writeCost } from "./arch";

export type Grouping = "single" | "multi";
export type ReadPath = "log" | "readindex" | "lease";
export type Splits = "fixed" | "auto";

export interface Design { grouping: Grouping; reads: ReadPath; splits: Splits; replicas: 3 | 5 }

/** Model inputs. */
export const DESIGN_INPUTS = {
  /** Machines in the cluster. */
  nodes: 9,
  /** Units of replica work one node can do per second (one unit per write per replica). */
  nodeOpsPerSec: 20000,
  /** Disk per node, GiB. */
  diskGiB: 1000,
  /** Data in the store, GiB. */
  dataGiB: 2000,
  /** Range size at which an automatic split happens, MiB (CockroachDB's default range_max_bytes). */
  splitMiB: 512,
  /** Heartbeat interval of the Raft sim, ms. */
  heartbeatMs: 50,
};

export interface Consequences {
  readMs: number;
  msgsPerRead: number;
  writeMs: number;
  msgsPerWrite: number;
  /** Writes per second the cluster can take. */
  writeCeiling: number;
  /** Largest store in GiB. */
  maxGiB: number;
  /** Fraction of keys that wait for an election when one node crashes. */
  blast: number;
  ranges: number;
  /** Heartbeat messages per second, one per Raft group, and with one heartbeat per pair of nodes. */
  heartbeats: number;
  heartbeatsCoalesced: number;
  needsClockBound: boolean;
  needsCrossRangeTxn: boolean;
  /** Text notes for the explorer. */
  notes: string[];
  matches: string[];
}

const costs = new Map<string, { r: ReturnType<typeof readCost>; w: ReturnType<typeof writeCost> }>();
function measured(reads: ReadPath, replicas: number) {
  const k = `${reads}:${replicas}`;
  let c = costs.get(k);
  if (!c) costs.set(k, (c = { r: readCost(reads, replicas), w: writeCost(replicas) }));
  return c;
}

export function consequences(d: Design): Consequences {
  const I = DESIGN_INPUTS;
  const { r, w } = measured(d.reads, d.replicas);
  const multi = d.grouping === "multi";
  const ranges = !multi ? 1 : d.splits === "auto" ? Math.ceil((I.dataGiB * 1024) / (I.splitMiB / 2)) : I.nodes;
  const writeCeiling = multi ? (I.nodes * I.nodeOpsPerSec) / d.replicas : I.nodeOpsPerSec;
  const maxGiB = multi ? (I.nodes * I.diskGiB) / d.replicas : I.diskGiB;
  const perGroup = 2 * (d.replicas - 1) * (1000 / I.heartbeatMs);
  const heartbeats = ranges * perGroup;
  // Coalesced: one heartbeat and one reply per pair of nodes that share a group, per interval.
  const pairs = multi ? (I.nodes * (I.nodes - 1)) / 2 : (d.replicas * (d.replicas - 1)) / 2;
  const heartbeatsCoalesced = Math.min(heartbeats, 2 * pairs * (1000 / I.heartbeatMs));
  const notes: string[] = [];
  if (!multi) notes.push("Every key lives in one log. Writes are bound by one leader, and the data must fit on one machine.");
  else notes.push(`The keyspace is cut into ${ranges.toLocaleString("en-US")} ranges, each its own Raft group. Leaders spread over ${I.nodes} nodes.`);
  if (multi) notes.push("A write that touches two ranges needs a transaction protocol on top of Raft.");
  if (multi && d.splits === "fixed") notes.push(`${I.nodes} fixed ranges of about ${Math.round(I.dataGiB / I.nodes)} GiB: a hot or growing range cannot be split, and moving one copies a lot of data.`);
  if (multi && d.splits === "auto") notes.push(`Ranges split at ${I.splitMiB} MiB, so each one is small enough to move or re-replicate in seconds.`);
  if (d.reads === "lease") notes.push("Reads skip the round trip, but a clock that runs slower than the bound can make a deposed leader serve stale data.");
  if (d.reads === "readindex") notes.push("Each read costs a heartbeat round to a majority, but no disk write and no clock assumption.");
  if (d.reads === "log") notes.push("Each read is a log entry: a round trip and a disk write on a majority, the same as a write.");
  if (d.replicas === 5) notes.push("Five replicas survive two failures, but each write does 5 units of work instead of 3.");
  const matches: string[] = [];
  if (!multi && d.reads === "readindex") matches.push("etcd (one Raft group, ReadIndex for linearizable reads)");
  if (multi && d.reads === "lease" && d.splits === "auto") matches.push("CockroachDB (ranges, leaseholders, splits at 512 MiB)", "DynamoDB (partitions, a Paxos leader with a lease)");
  return {
    readMs: r.meanMs, msgsPerRead: r.msgsPerRead, writeMs: w.meanMs, msgsPerWrite: w.msgsPerWrite,
    writeCeiling, maxGiB, blast: multi ? 1 / I.nodes : 1, ranges, heartbeats, heartbeatsCoalesced,
    needsClockBound: d.reads === "lease", needsCrossRangeTxn: multi, notes, matches,
  };
}
