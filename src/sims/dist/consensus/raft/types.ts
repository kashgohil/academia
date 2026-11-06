/**
 * Types for the Raft simulation: log entries, configurations, messages, options and the state machine interface.
 * Field names follow Figure 2 of the Raft paper (Ongaro and Ousterhout, 2014) where the paper has a name.
 */
import type { NodeId } from "../../net";

export type { NodeId };

/**
 * A cluster configuration. A decision (an election or a commit) needs a majority of `voters`, and during joint
 * consensus also a majority of `old`. Learners receive the log, but they do not vote and do not count for commit.
 */
export interface Config {
  voters: NodeId[];
  /** Set only in the joint configuration C(old,new): the voters of the old configuration. */
  old?: NodeId[];
  learners: NodeId[];
}

/** A client session tag. The state machine applies (client, seq) at most once. */
export interface SessionTag {
  client: number;
  seq: number;
}

export type Entry<C> =
  | { term: number; index: number; kind: "noop" }
  | { term: number; index: number; kind: "cmd"; cmd: C; session?: SessionTag }
  | { term: number; index: number; kind: "config"; config: Config };

/** A snapshot replaces the log prefix up to and including `lastIncludedIndex`. */
export interface Snapshot {
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  /** The latest configuration at or before lastIncludedIndex. */
  config: Config;
  /** The state machine state, as returned by StateMachine.snapshot(). */
  state: unknown;
  /** The session table: the last applied seq and its result, per client. */
  sessions: [number, { seq: number; result: unknown }][];
}

export type RaftMsg<C> =
  | {
      type: "RequestVote";
      term: number;
      candidateId: NodeId;
      lastLogIndex: number;
      lastLogTerm: number;
      /** Pre-vote (dissertation section 9.6): ask "would you vote for me in `term`?" without changing any state. */
      preVote: boolean;
      /** Sent after TimeoutNow (leadership transfer). It may disturb a live leader on purpose. */
      transfer: boolean;
    }
  | { type: "RequestVoteReply"; term: number; voteGranted: boolean; preVote: boolean; /** The term that was asked about. */ reqTerm: number }
  | { type: "AppendEntries"; term: number; leaderId: NodeId; prevLogIndex: number; prevLogTerm: number; entries: Entry<C>[]; leaderCommit: number }
  | {
      type: "AppendEntriesReply";
      term: number;
      success: boolean;
      /** Echo of the request, so that the leader can match a reply to its request. */
      prevLogIndex: number;
      /** On success: the index of the last entry that the follower now holds from this request. */
      matchIndex: number;
      /** On failure (fast backup): the term of the conflicting entry (0 if the log is too short), and the first index the leader should try. */
      conflictTerm: number;
      conflictIndex: number;
    }
  | { type: "InstallSnapshot"; term: number; leaderId: NodeId; lastIncludedIndex: number; lastIncludedTerm: number; offset: number; data: string; done: boolean }
  | {
      type: "InstallSnapshotReply";
      term: number;
      /** Echo of the request. */
      lastIncludedIndex: number;
      /** Bytes of this snapshot that the follower holds: the offset of the next chunk it needs. */
      offset: number;
      done: boolean;
    }
  | { type: "TimeoutNow"; term: number }
  | ClientMsg<C>;

export type ClientMsg<C> =
  | { type: "ClientRequest"; client: number; seq: number; cmd: C; session: boolean }
  | { type: "ClientReply"; client: number; seq: number; ok: boolean; result?: unknown; leaderHint: NodeId | null };

export interface RaftOptions {
  /** Each election wait draws a timeout uniformly from [min, max] ms. */
  electionTimeout: { min: number; max: number };
  /** The leader sends AppendEntries at least this often (ms). */
  heartbeat: number;
  /** Pre-vote: a candidate first checks that a majority would vote for it, and only then increments its term. */
  preVote: boolean;
  /**
   * Check-quorum: a leader steps down if it has not heard from a majority within an election timeout, and a
   * follower that heard from a leader within the minimum election timeout ignores a RequestVote with a higher term.
   */
  checkQuorum: boolean;
  /** Raft's rule: a leader commits only entries of its own term by counting replicas. False is the unsafe variant (Figure 8). */
  commitCurrentTermOnly: boolean;
  /** A new leader appends a no-op entry of its term at once. */
  noopOnElection: boolean;
  /** At most this many entries in one AppendEntries. */
  maxBatch: number;
  /** At most this many AppendEntries with entries in flight to one follower. 1 is stop-and-wait. */
  maxInflight: number;
  /** A rejected AppendEntries carries the conflicting term, so that the leader skips a whole term at a time. */
  fastBackup: boolean;
  /** Take a snapshot when this many applied entries sit in the log. 0: never. */
  snapshotThreshold: number;
  /** InstallSnapshot sends the snapshot in chunks of this many bytes (characters of its JSON). */
  snapshotChunk: number;
  /** Model input: ms to write one append to disk. A node replies only after the write. 0: instant. */
  diskMs: number;
  /** Retransmit unacknowledged AppendEntries after this many ms. */
  retransmit: number;
  /** The 2015 fix: a leader appends a configuration change only after it has committed an entry of its own term. */
  configNeedsCurrentTermCommit: boolean;
}

export const DEFAULT_RAFT: RaftOptions = {
  electionTimeout: { min: 150, max: 300 },
  heartbeat: 50,
  preVote: false,
  checkQuorum: false,
  commitCurrentTermOnly: true,
  noopOnElection: true,
  maxBatch: 64,
  maxInflight: 4,
  fastBackup: true,
  snapshotThreshold: 0,
  snapshotChunk: 1 << 16,
  diskMs: 0,
  retransmit: 100,
  configNeedsCurrentTermCommit: true,
};

/**
 * A replicated state machine. Every node has its own copy, and applies the same commands in the same order.
 * apply must be deterministic. snapshot returns a copy that JSON can store; restore replaces the state with it.
 */
export interface StateMachine<C> {
  apply(cmd: C): unknown;
  snapshot(): unknown;
  restore(data: unknown): void;
}

export type Role = "follower" | "precandidate" | "candidate" | "leader";

/** What the cluster records as it runs, for views and tests. */
export type RaftEvent =
  | { t: number; node: NodeId; kind: "role"; role: Role; term: number }
  | { t: number; node: NodeId; kind: "vote"; term: number; for: NodeId }
  | { t: number; node: NodeId; kind: "commit"; index: number; term: number }
  | { t: number; node: NodeId; kind: "truncate"; from: number; removed: number }
  | { t: number; node: NodeId; kind: "snapshot"; index: number; term: number; bytes: number }
  | { t: number; node: NodeId; kind: "install"; index: number; term: number; bytes: number }
  | { t: number; node: NodeId; kind: "config"; index: number; config: Config }
  | { t: number; node: NodeId; kind: "crash" | "recover" }
  | { t: number; node: NodeId; kind: "transfer"; to: NodeId };

export interface Violation {
  t: number;
  property: "Election Safety" | "Leader Append-Only" | "Log Matching" | "Leader Completeness" | "State Machine Safety";
  detail: string;
}
