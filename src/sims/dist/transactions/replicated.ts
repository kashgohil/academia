/**
 * 2PC over consensus groups, as in Spanner: the coordinator's log is a Raft log on three replicas, so a crash of
 * the coordinator's leader does not lose the decision. A new leader takes over after an election.
 *
 * raftFailover runs the real Raft of ../consensus/raft: it commits a decision entry, crashes the leader, and measures
 * the time until a new leader has the entry committed and can answer QUERY. In 2PC terms, that is how long the
 * participants stay in doubt when the coordinator crashes at the commit point. Then inDoubtReplicated plugs that
 * failover time into the 2PC run of ./twopc.ts in place of the time to repair one machine.
 */
import { RaftCluster } from "../consensus/raft";
import { inDoubtRun } from "./twopc";

export interface Failover {
  /** ms from the leader's crash to a new leader that has the decision committed. */
  ms: number;
  /** The decision survived on the new leader (Leader Completeness). */
  kept: boolean;
}

/** Raft with its defaults: election timeout 150–300 ms, heartbeat 50 ms, latency 5–15 ms (model inputs). */
export function raftFailover(seed: number): Failover {
  const c = new RaftCluster({ servers: 3, net: { seed, latency: { min: 5, max: 15 } }, record: false });
  c.runUntilTrue(() => c.leader() !== null, 5000);
  const old = c.leader()!;
  const r = c.propose(old, { op: "set", key: "txn42", value: 1 });
  if (!r.ok) return { ms: NaN, kept: false };
  c.runUntilTrue(() => c.node(old).commitIndex >= r.index, 1000, 1);
  c.crash(old);
  const t0 = c.now;
  const ok = c.runUntilTrue(() => {
    const l = c.leader();
    return l !== null && l !== old && c.node(l).commitIndex >= r.index;
  }, 5000, 1);
  const l = c.leader();
  const kept = ok && l !== null && c.node(l).log.some((e) => e.index === r.index && e.term === r.term);
  return { ms: c.now - t0, kept };
}

/** Mean and maximum failover time over `seeds` runs. */
export function failoverStats(seeds = 40): { mean: number; max: number; min: number; kept: number } {
  const xs = Array.from({ length: seeds }, (_, s) => raftFailover(s + 1));
  const ms = xs.map((x) => x.ms);
  return { mean: ms.reduce((a, b) => a + b, 0) / ms.length, max: Math.max(...ms), min: Math.min(...ms), kept: xs.filter((x) => x.kept).length };
}

/** In-doubt time when the coordinator is a Raft group: the participants wait for a failover, not for a repair. */
export function inDoubtReplicated(seed: number, retry: number) {
  const f = raftFailover(seed);
  return { failover: f.ms, ...inDoubtRun({ recoverAfter: f.ms, retry, cooperative: false, seed }) };
}
