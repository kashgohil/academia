/**
 * Scripted runs that the lessons describe step by step.
 *
 * leaseRestart(guard): why a restarted server must wait before it votes when the store serves lease reads.
 * S3 can reach S2 but not the leader S1, so it campaigns in vain: S2 has a recent heartbeat from S1 and refuses.
 * Then S2 restarts and forgets that heartbeat, and the network now also cuts S1 off. Without the guard, S2 votes for
 * S3 at once. S3 leads and commits a write, while S1 still holds a lease that counted on S2's promise, and S1 serves
 * a stale read.
 */
import { KvStore } from "./store";

export interface LeaseRestartRun {
  /** The value that the read on the old leader returned, and the value that the new leader had committed. */
  read: number | undefined;
  committed: number;
  newLeader: number | null;
  linearizable: boolean | null;
  votesDropped: number;
}

export function leaseRestart(guard: boolean): LeaseRestartRun {
  const s = new KvStore({ servers: 3, clients: 2, seed: 9, readMode: "lease", restartGuard: guard });
  s.settle();
  s.run(100);
  const L = s.leader()!;
  const [a, b] = [0, 1, 2].filter((i) => i !== L) as [number, number];
  // b cannot reach the leader, but it can reach a. Clients reach everyone.
  s.partition([[L, a], [a, b]]);
  s.run(400); // b times out and campaigns; a refuses because it heard from L recently
  // a restarts and forgets when it last heard from L. b campaigns again at once.
  s.crash(a);
  s.recover(a);
  s.partition([[L], [a, b]]);
  s.cluster.timeout(b);
  s.runUntilTrue(() => s.node(b).role === "leader", 60, 0.5);
  const newLeader = s.node(b).role === "leader" ? b : null;
  if (newLeader !== null) {
    s.clients[0]!.leaderGuess = b;
    s.clients[0]!.submit({ kind: "put", key: "x", value: 1 });
    s.runUntilTrue(() => !s.clients[0]!.busy, 60, 0.5);
  }
  // Now a read goes to the old leader, which still trusts its lease.
  s.clients[1]!.leaderGuess = L;
  s.clients[1]!.submit({ kind: "get", key: "x" });
  s.runUntilTrue(() => !s.clients[1]!.busy, 300, 0.5);
  const read = s.ops.find((o) => o.op.kind === "get")?.value;
  return { read, committed: s.machine(b).get("x"), newLeader, linearizable: s.check().ok, votesDropped: s.counters.votesDroppedAfterRestart };
}
