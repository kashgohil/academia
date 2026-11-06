/**
 * Scripted runs and sweeps for the Raft lessons. Each one runs the real RaftCluster; nothing here is drawn by hand.
 * The lesson text quotes numbers from these functions, and tests/unit/dist-consensus-raft*.test.ts pins them.
 */
import type { Message } from "../../net";
import { fmtKv, type KvCmd } from "./machine";
import { RaftCluster, fmtConfig, type ConfigMode } from "./raft";
import { RaftClient } from "./client";
import type { Entry, NodeId, RaftMsg, RaftOptions, Role, Violation } from "./types";

// ---------------------------------------------------------------- snapshots of state for drawing

export interface EntryView {
  index: number;
  term: number;
  kind: Entry<KvCmd>["kind"];
  label: string;
}

export interface NodeView {
  id: NodeId;
  up: boolean;
  role: Role;
  term: number;
  votedFor: NodeId | null;
  leaderId: NodeId | null;
  commitIndex: number;
  lastApplied: number;
  base: number;
  baseTerm: number;
  log: EntryView[];
  config: string;
  voter: boolean;
  electionDeadline: number;
}

export interface MsgView {
  from: number;
  to: number;
  sentAt: number;
  deliveredAt?: number;
  /** Set for a message lost at a dead or cut-off receiver. */
  lostAt?: number;
  /** Why the message was lost. Undefined with no deliveredAt: still in flight. */
  lost?: "dropped" | "partition" | "crashed";
  type: RaftMsg<KvCmd>["type"];
  label: string;
}

export function entryLabel(e: Entry<KvCmd>): string {
  if (e.kind === "cmd") return fmtKv(e.cmd);
  if (e.kind === "noop") return "no-op";
  return fmtConfig(e.config);
}

export function viewNode(c: RaftCluster<KvCmd>, i: NodeId): NodeView {
  const n = c.node(i);
  return {
    id: i, up: c.isUp(i), role: n.role, term: n.currentTerm, votedFor: n.votedFor, leaderId: n.leaderId,
    commitIndex: n.commitIndex, lastApplied: n.lastApplied, base: n.base, baseTerm: n.baseTerm,
    log: n.log.map((e) => ({ index: e.index, term: e.term, kind: e.kind, label: entryLabel(e) })),
    config: fmtConfig(n.config), voter: n.config.voters.includes(i) || (n.config.old?.includes(i) ?? false),
    electionDeadline: n.electionDeadline,
  };
}

/** A short label for a message on a space-time diagram. Heartbeats and their replies get none. */
export function msgLabel(p: RaftMsg<KvCmd>): string {
  switch (p.type) {
    case "RequestVote": return `${p.preVote ? "pre" : "RV"} t${p.term}`;
    case "RequestVoteReply": return p.voteGranted ? "" : "no";
    case "AppendEntries": return p.entries.length ? `AE ${p.entries.length === 1 ? p.entries[0]!.index : `${p.entries[0]!.index}–${p.entries[p.entries.length - 1]!.index}`}` : "";
    case "AppendEntriesReply": return p.success ? "" : "reject";
    case "InstallSnapshot": return `snap ${p.offset}`;
    case "InstallSnapshotReply": return "";
    case "TimeoutNow": return "TimeoutNow";
    case "ClientRequest": return `req ${p.seq}`;
    case "ClientReply": return p.ok ? `ok ${p.seq}` : "retry";
  }
}

export function viewMsg(m: Message<RaftMsg<KvCmd>>): MsgView {
  return { from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost === "dropped" ? undefined : m.lostAt, lost: m.lost, type: m.payload.type, label: msgLabel(m.payload) };
}

/** Messages sent in [t0, t1]. Net keeps messages in send order, so this searches from the end. */
export function messagesBetween(c: RaftCluster<KvCmd>, t0: number, t1: number): MsgView[] {
  const ms = c.net.messages;
  let lo = ms.length;
  while (lo > 0 && ms[lo - 1]!.sentAt >= t0) lo--;
  const out: MsgView[] = [];
  for (let i = lo; i < ms.length && ms[i]!.sentAt <= t1; i++) out.push(viewMsg(ms[i]!));
  return out;
}

// ---------------------------------------------------------------- scripted steppers

export interface Frame {
  t0: number;
  t1: number;
  caption: string;
  nodes: NodeView[];
  msgs: MsgView[];
  violations: Violation[];
  /** What each node has applied, by index (the newest apply wins), across crashes. */
  applied: Record<number, string>[];
  /** The partition at the end of the step, or null if every server can reach every other. */
  groups: NodeId[][] | null;
}

/** Runs a script of steps on a cluster and records one frame per step. */
class Script {
  frames: Frame[] = [];
  applied: Record<number, string>[];
  constructor(readonly c: RaftCluster<KvCmd>) {
    this.applied = c.nodes.map(() => ({}));
    c.onApply((node, e) => (this.applied[node]![e.index] = `${entryLabel(e)} (t${e.term})`));
  }
  groups: NodeId[][] | null = null;
  cut(groups: NodeId[][]) {
    this.groups = groups;
    this.c.partition(groups);
  }
  heal() {
    this.groups = null;
    this.c.heal();
  }
  step(caption: string | (() => string), act: () => void, ms = 120) {
    const t0 = this.c.now;
    act();
    this.c.run(ms);
    this.frames.push({
      t0, t1: this.c.now, caption: typeof caption === "string" ? caption : caption(),
      nodes: this.c.nodes.map((_, i) => viewNode(this.c, i)),
      msgs: messagesBetween(this.c, t0, this.c.now), violations: [...this.c.violations],
      applied: this.applied.map((a) => ({ ...a })),
      groups: this.groups,
    });
  }
  /** Fires i's election timeout, and again (at most `tries` times) until it leads. */
  elect(i: NodeId, tries = 3) {
    for (let k = 0; k < tries; k++) {
      this.c.timeout(i);
      if (this.c.runUntilTrue(() => this.c.node(i).role === "leader", 40, 0.25)) return true;
    }
    return false;
  }
}

/** Options for scripted runs: no spontaneous elections, so that only the script starts them. */
const SCRIPTED: Partial<RaftOptions> = { electionTimeout: { min: 1e7, max: 1e7 }, heartbeat: 30, retransmit: 60 };
const set = (key: string, value: number): KvCmd => ({ op: "set", key, value });

/**
 * Figure 8 of the Raft paper. `currentTermRule` false removes the rule that only entries of the current term
 * commit by counting replicas. `ending` "d": S1 crashes before its term 4 entry spreads; "e": it spreads first.
 */
export function figure8(currentTermRule: boolean, ending: "d" | "e"): Frame[] {
  const c = new RaftCluster<KvCmd>({ servers: 5, net: { seed: 8, latency: { min: 4, max: 8 } }, raft: { ...SCRIPTED, noopOnElection: false, commitCurrentTermOnly: currentTermRule } });
  const s = new Script(c);
  const [S1, S2, S3, S4, S5] = [0, 1, 2, 3, 4];
  s.step("Start. S5 wins term 1 and replicates x=1 at index 1 to every server. It is committed.", () => {
    s.elect(S5);
    c.propose(S5, set("x", 1));
  }, 150);
  s.step("(a) S1 wins term 2. The network then cuts S1 and S2 off. S1 appends x=2 at index 2, and only S2 receives it.", () => {
    s.elect(S1);
    s.cut([[S1, S2], [S3], [S4], [S5]]);
    c.propose(S1, set("x", 2));
  });
  s.step("(b) S1 crashes. S5 asks for votes in term 3. S2 refuses, because its log ends in term 2. S3 and S4 vote, so S5 wins.", () => {
    c.crash(S1);
    s.cut([[S2, S3, S4, S5]]);
    s.elect(S5);
  });
  s.step("S5 is cut off and appends x=3 at index 2 in term 3. Only S5 has it.", () => {
    s.cut([[S2, S3, S4], [S5]]);
    c.propose(S5, set("x", 3));
  });
  s.step(() => {
    const n = c.node(S1);
    return currentTermRule
      ? `(c) S5 crashes and S1 restarts. S1 wins term 4 with S2 and S3, and copies x=2 to S3. Index 2 is now on 3 of 5 servers, but S1 does not commit it: its term is 2, not 4.`
      : `(c) S5 crashes and S1 restarts. S1 wins term 4 with S2 and S3, and copies x=2 to S3. Without the rule, S1 counts 3 of 5 copies and commits index 2 (commit index ${n.commitIndex}). S1 applies x=2.`;
  }, () => {
    c.crash(S5);
    c.recover(S1);
    s.cut([[S1, S2, S3], [S4], [S5]]);
    s.elect(S1);
  }, 150);
  s.step("S1 appends x=4 at index 3 in term 4. The network cuts S1 off at once, so only S1 has it.", () => {
    s.cut([[S1], [S2, S3], [S4], [S5]]);
    c.propose(S1, set("x", 4));
  });
  if (ending === "d") {
    s.step(() => {
      const t = c.node(S5).currentTerm;
      return currentTermRule
        ? `(d) S1 crashes and S5 restarts. Its last log term is 3, which beats term 2 on S2 and S3. After one failed round, it wins term ${t} with S2, S3 and S4.`
        : `(d) S1 crashes and S5 restarts. It wins term ${t} with S2, S3 and S4. But S5 does not hold x=2, which S1 committed: Leader Completeness is broken.`;
    }, () => {
      c.crash(S1);
      c.recover(S5);
      s.cut([[S2, S3, S4, S5]]);
      s.elect(S5);
    }, 0);
    s.step(() => currentTermRule
      ? "S5 copies x=3 over index 2 on S2, S3 and S4. That is safe: x=2 was never committed. S5 does not commit index 2 by counting either, because its term is 3."
      : "S5 copies x=3 over index 2 on S2, S3 and S4, and commits it by counting. But S1 already applied x=2 at index 2. Two servers applied different commands at one index.", () => {}, 150);
    s.step("A client writes x=5 through S5. It commits at index 3 in term 5, and that commits index 2 with it.", () => {
      c.propose(S5, set("x", 5));
    }, 150);
  } else {
    s.step("(e) The network heals before S1 crashes. S1 copies x=4 to S2 and S3. Index 3 is from term 4, so S1 commits it by counting, and index 2 with it.", () => {
      s.cut([[S1, S2, S3], [S4], [S5]]);
    }, 150);
    s.step(() => `Now S1 crashes and S5 restarts. S5 asks for votes in two rounds, up to term ${c.node(S5).currentTerm}. S2 and S3 refuse: their logs end in term 4, which beats S5's term 3.`, () => {
      c.crash(S1);
      c.recover(S5);
      s.cut([[S2, S3, S4, S5]]);
      s.elect(S5, 2);
    }, 100);
  }
  return s.frames;
}

export type MembershipMode = "direct" | "joint" | "single" | "bug2015";

/**
 * The membership stepper. Servers S1–S3 form the cluster; S4 and S5 join. For "bug2015", S1–S4 form the cluster
 * and S5 joins, and `rule2015` turns on the fix (commit an entry of your term before a configuration change).
 */
export function membership(mode: MembershipMode, rule2015 = true): Frame[] {
  if (mode === "bug2015") return bug2015(rule2015);
  const c = new RaftCluster<KvCmd>({ servers: 5, voters: [0, 1, 2], net: { seed: 3, latency: { min: 4, max: 8 } }, raft: { ...SCRIPTED } });
  const s = new Script(c);
  const [S1, S2, S3, S4, S5] = [0, 1, 2, 3, 4];
  const all = [S1, S2, S3, S4, S5];
  s.step("Start. The cluster is {S1,S2,S3}, and S3 leads term 1. S4 and S5 are new, empty servers.", () => {
    s.elect(S3);
    c.run(60);
    c.propose(S3, set("x", 1));
  }, 150);
  const change = mode === "direct" ? "S3 switches straight to {S1,…,S5}" : mode === "joint" ? "S3 appends the joint configuration C(old,new)" : "S3 appends {S1,S2,S3,S4}: one server added";
  s.step(() => {
    const commit = c.node(S3).commitIndex >= c.node(S3).configIndex();
    return `The network splits {S1,S2} | {S3,S4,S5}. ${change}. Only ${mode === "single" ? "S4 receives" : "S4 and S5 receive"} it. ${commit ? "S3, S4 and S5 are a majority of the new configuration, so it commits." : "It cannot commit: S3 has no majority of the old configuration on its side."}`;
  }, () => {
    s.cut([[S1, S2], [S3, S4, S5]]);
    c.changeConfig(S3, { voters: mode === "single" ? [S1, S2, S3, S4] : all }, mode as ConfigMode);
  });
  s.step(() => `S1 times out. Its configuration is still {S1,S2,S3}. S2 votes for it: 2 of 3, so S1 leads term 2.${c.violations.length ? " But S1 lacks the configuration entry that the other side committed." : ""}`, () => {
    s.elect(S1, 1);
  });
  s.step(() => {
    const won = c.node(S4).role === "leader";
    if (won) return "S4 times out. It uses the new configuration {S1,…,S5}. S3 and S5 vote for it: 3 of 5. S4 also leads term 2. Two leaders in one term.";
    return mode === "joint"
      ? "S4 times out in term 2. S3 and S5 vote for it, a majority of the new voters. But joint consensus also needs a majority of {S1,S2,S3}, and S4 has only S3. It loses."
      : "S4 times out in term 2. It uses {S1,S2,S3,S4}, so it needs 3 of 4 votes. It has S3 and itself. It loses.";
  }, () => {
    s.elect(S4, 1);
  });
  s.step(() => {
    const two = c.node(S4).role === "leader";
    return two
      ? "Both leaders accept a write. S1 commits x=2 with S2. S4 commits x=3 with S3 and S5. The two halves now disagree about committed entries."
      : "Both sides get a write. S1 commits x=2 with S2. The majority side has no leader, so its write is refused.";
  }, () => {
    c.propose(S1, set("x", 2));
    c.propose(S4, set("x", 3));
  }, 150);
  s.step(() => (c.violations.length ? "The network heals. Nothing can repair the damage: two different entries were committed at the same index." : "The network heals. S1 leads, and its log replaces the configuration entry that never committed. The change must start again."), () => {
    s.heal();
  }, 200);
  if (mode === "joint") {
    s.step("S1 starts the change again. C(old,new) commits with majorities of both sets, then S1 appends C(new) = {S1,…,S5}, and it commits too.", () => {
      c.changeConfig(S1, { voters: all }, "joint");
    }, 200);
  } else if (mode === "single") {
    s.step("S1 adds S4 alone. {S1,S2,S3,S4} commits with 3 of 4.", () => {
      c.changeConfig(S1, { voters: [S1, S2, S3, S4] }, "single");
    }, 150);
    s.step("Then S1 adds S5. {S1,…,S5} commits with 3 of 5. Any two majorities in these steps overlap.", () => {
      c.changeConfig(S1, { voters: all }, "single");
    }, 150);
  }
  return s.frames;
}

/** The single-server bug that Ongaro reported on raft-dev in July 2015, and its fix. */
function bug2015(rule: boolean): Frame[] {
  const c = new RaftCluster<KvCmd>({ servers: 5, voters: [0, 1, 2, 3], net: { seed: 5, latency: { min: 4, max: 8 } }, raft: { ...SCRIPTED, configNeedsCurrentTermCommit: rule } });
  const s = new Script(c);
  const [S1, S2, S3, S4, S5] = [0, 1, 2, 3, 4];
  s.step("Start. The cluster is {S1,S2,S3,S4}, and S1 leads term 1. x=1 commits everywhere.", () => {
    s.elect(S1);
    c.run(60);
    c.propose(S1, set("x", 1));
  }, 150);
  s.step("S1 starts to add S5: it appends {S1,…,S5}. The network cuts S1 and S5 off, so only S5 receives it. Then S1 crashes.", () => {
    s.cut([[S1, S5], [S2, S3, S4]]);
    c.changeConfig(S1, { voters: [S1, S2, S3, S4, S5] }, "single");
    c.run(40);
    c.crash(S1);
  });
  s.step("S2 wins term 2 with S3 and S4: 3 of 4. It appends its no-op, but the network cuts S4 off before the no-op arrives.", () => {
    c.timeout(S2);
    c.runUntilTrue(() => c.node(S2).role === "leader", 100, 0.5);
    s.cut([[S1, S5, S4], [S2, S3]]);
  });
  s.step(() => {
    const ok = c.node(S2).configIndex() > c.node(S2).base && c.node(S2).config.voters.length === 3;
    return ok
      ? "Without the rule, S2 removes S1 at once: {S2,S3,S4}. S2 and S3 are 2 of 3, so the no-op and the change commit."
      : "With the rule, S2 must first commit an entry of term 2. Its no-op is on S2 and S3 only, 2 of 4, so the change has to wait.";
  }, () => {
    c.changeConfig(S2, { voters: [S2, S3, S4] }, "single");
  }, 150);
  s.step(() => {
    const won = c.node(S1).role === "leader";
    return won
      ? `S1 restarts and asks for votes under {S1,…,S5}. Its log ends in term 1 at a higher index than S4's, so S4 and S5 vote: 3 of 5. S1 leads term ${c.node(S1).currentTerm}.${c.violations.length ? " It lacks the entries that S2 committed." : ""}`
      : "S1 restarts, but it cannot win.";
  }, () => {
    c.recover(S1);
    s.elect(S1, 3);
  });
  s.step(() => (c.violations.length
    ? "The network heals. S1 overwrites the entries that S2 committed. The configurations {S2,S3,S4} and {S1,…,S5} had majorities that do not overlap."
    : "The network heals. S1 overwrites S2's entries, but none of them were committed. The rule kept every quorum overlapping."), () => {
    s.heal();
    c.propose(S1, set("x", 9));
  }, 200);
  return s.frames;
}

// ---------------------------------------------------------------- election timing sweep

export interface ElectionTrial {
  /** ms from the leader crash until a new leader exists (capped at `cap`). */
  ms: number;
  /** Elections started after the crash. More than 1 means split votes or failed rounds. */
  elections: number;
}

/** Crash the leader of a stable 5-node cluster and time the next election. */
export function electionTrial(seed: number, timeout: { min: number; max: number }, cap = 10000, latency = { min: 5, max: 15 }): ElectionTrial {
  // Elect a first leader with the usual spread, then switch every server to the range under test. Each heartbeat
  // re-arms a follower's timer, so after a few heartbeats every timer uses the new range.
  const c = new RaftCluster<KvCmd>({ servers: 5, net: { seed, latency }, raft: { electionTimeout: { min: 150, max: 300 }, heartbeat: 50 }, record: false });
  c.runUntilTrue(() => c.leader() !== null, 60000, 10);
  c.setOptions({ electionTimeout: timeout });
  c.run(200 + (seed % 7) * 13); // at a varied phase of the heartbeats
  const old = c.leader()!;
  const oldTerm = c.node(old).currentTerm;
  c.crash(old);
  const t0 = c.now;
  const ok = c.runUntilTrue(() => c.leader() !== null && c.leader() !== old, cap, 1);
  const term = Math.max(...c.nodes.map((n) => n.currentTerm));
  return { ms: ok ? c.now - t0 : cap, elections: term - oldTerm };
}

/**
 * The expected gap between the first and the second of n timers drawn uniformly from a window of `spread` ms:
 * spread / (n + 1). If this gap is shorter than the time a candidate needs to collect votes, votes split often.
 */
export const expectedFirstGap = (spread: number, n: number) => spread / (n + 1);

export interface SweepPoint {
  spread: number;
  mean: number;
  p95: number;
  /** Mean elections per failover. */
  rounds: number;
}

/** The timeout spreads of the sweep in lesson 1 (ms added above the minimum of 150 ms). */
export const SPREADS = [0, 1, 2, 5, 10, 25, 50, 100, 150];

export function electionPoint(spread: number, trials = 40, min = 150): SweepPoint {
  const r = Array.from({ length: trials }, (_, k) => electionTrial(1000 + k, { min, max: min + spread }));
  const ms = r.map((x) => x.ms).sort((a, b) => a - b);
  return { spread, mean: ms.reduce((a, b) => a + b, 0) / trials, p95: ms[Math.min(trials - 1, Math.ceil(0.95 * trials) - 1)]!, rounds: r.reduce((a, x) => a + x.elections, 0) / trials };
}

// ---------------------------------------------------------------- throughput and latency

export interface LoadConfig {
  /** One-way network latency (model input). */
  latency: number;
  /** Disk write per append (model input). */
  diskMs: number;
  maxBatch: number;
  maxInflight: number;
  /** Concurrent clients, each with one request outstanding. */
  clients: number;
  servers?: number;
}

export interface LoadResult {
  /** Committed commands per second. */
  throughput: number;
  /** Mean ms from propose to apply at the leader. */
  latency: number;
}

/** Closed-loop load at the leader: each of `clients` proposes, waits for its command to apply, and proposes again. */
export function loadRun(cfg: LoadConfig, measureMs = 2000): LoadResult {
  const c = new RaftCluster<KvCmd>({
    servers: cfg.servers ?? 3,
    net: { seed: 21, latency: { min: cfg.latency, max: cfg.latency }, fifo: true },
    raft: { electionTimeout: { min: 1000, max: 2000 }, heartbeat: 100, retransmit: 400, maxBatch: cfg.maxBatch, maxInflight: cfg.maxInflight, diskMs: cfg.diskMs },
    record: false,
  });
  c.runUntilTrue(() => c.leader() !== null, 20000, 10);
  const L = c.leader()!;
  c.run(100);
  const started = new Map<number, number>();
  let done = 0, sum = 0, measuring = false, seq = 0;
  const issue = () => {
    const r = c.propose(L, { op: "add", key: `k${seq++ % 8}`, delta: 1 });
    if (r.ok) started.set(r.index, c.now);
  };
  c.onApply((node, e) => {
    if (node !== L || e.kind !== "cmd") return;
    const t = started.get(e.index);
    if (t === undefined) return;
    started.delete(e.index);
    if (measuring) {
      done++;
      sum += c.now - t;
    }
    issue();
  });
  for (let k = 0; k < cfg.clients; k++) issue();
  c.run(300); // warm up
  measuring = true;
  c.run(measureMs);
  return { throughput: (done / measureMs) * 1000, latency: done ? sum / done : NaN };
}

export const LOAD_CLIENTS = [1, 2, 4, 8, 16, 32, 64];
export const LOAD_MODES = [
  { id: "stop", label: "1 entry, stop-and-wait", maxBatch: 1, maxInflight: 1 },
  { id: "batch", label: "batching", maxBatch: 64, maxInflight: 1 },
  { id: "pipe", label: "pipelining", maxBatch: 1, maxInflight: 16 },
  { id: "both", label: "both", maxBatch: 64, maxInflight: 16 },
] as const;

// ---------------------------------------------------------------- snapshots and a lagging follower

export interface SnapshotRunConfig {
  /** Snapshot after this many applied entries in the log; 0: never. */
  threshold: number;
  /** InstallSnapshot chunk size in bytes. */
  chunk: number;
  /** S5 is cut off from 200 ms until this time. */
  rejoinAt: number;
  /** One write per this many ms. */
  writeEvery?: number;
  end?: number;
}

export interface SnapshotRun {
  /** The server that is cut off, and the leader. */
  lag: NodeId;
  leader: NodeId;
  /** Samples every 20 ms: time, then the number of entries held in memory by each server. */
  series: { t: number; len: number[]; base: number[] }[];
  events: RaftCluster<KvCmd>["events"];
  /** Messages to and from S5 in the 120 ms after it rejoins. */
  msgs: MsgView[];
  /** Bytes sent to the lagging server from its return until it caught up: snapshot data, or entries (as their JSON). */
  catchupBytes: number;
  catchupMessages: number;
  /** ms from rejoin until S5 has applied the leader's commit index of that moment. */
  catchupMs: number;
  installs: number;
  chunks: number;
  snapshotBytes: number;
  violations: Violation[];
  /** S5's state machine matches the leader's at the end. */
  converged: boolean;
}

export function snapshotRun(cfg: SnapshotRunConfig): SnapshotRun {
  const end = cfg.end ?? 1600, every = cfg.writeEvery ?? 8;
  const c = new RaftCluster<KvCmd>({ servers: 5, net: { seed: 9, latency: { min: 4, max: 10 } }, raft: { electionTimeout: { min: 300, max: 500 }, heartbeat: 40, snapshotThreshold: cfg.threshold, snapshotChunk: cfg.chunk, maxBatch: 32, preVote: true, checkQuorum: true } });
  c.runUntilTrue(() => c.leader() !== null, 5000);
  const L = c.leader()!;
  const lag = L === 4 ? 3 : 4;
  const others = [0, 1, 2, 3, 4].filter((x) => x !== lag);
  const t0 = c.now;
  const series: SnapshotRun["series"] = [];
  let k = 0, target = 0, rejoinedAt = -1, caughtAt = -1, bytes = 0, msgCount = 0, firstMsg = 0, cut = false;
  const sample = () => series.push({ t: c.now - t0, len: c.nodes.map((n) => n.log.length), base: c.nodes.map((n) => n.base) });
  while (c.now - t0 < end) {
    const t = c.now - t0;
    if (t >= 200 && t < cfg.rejoinAt && !cut) {
      cut = true;
      c.partition([others, [lag]]);
    }
    if (t >= cfg.rejoinAt && rejoinedAt < 0) {
      c.heal();
      rejoinedAt = c.now;
      target = c.node(L).commitIndex;
      firstMsg = c.net.messages.length;
    }
    if (rejoinedAt >= 0 && caughtAt < 0 && c.node(lag).lastApplied >= target) caughtAt = c.now;
    if (k % (20 / 4) === 0) sample();
    if ((k * 4) % every === 0 && c.leader() === L) c.propose(L, { op: "add", key: `k${(k / 2) % 10}`, delta: 1 });
    c.run(4);
    k++;
  }
  const until = caughtAt >= 0 ? caughtAt : Infinity;
  const after = c.net.messages.slice(firstMsg).filter((m) => m.to === lag && m.from === L && m.sentAt <= until);
  for (const m of after) {
    const p = m.payload;
    if (p.type === "InstallSnapshot") bytes += p.data.length;
    else if (p.type === "AppendEntries" && p.entries.length) bytes += JSON.stringify(p.entries).length;
    if (p.type === "InstallSnapshot" || (p.type === "AppendEntries" && p.entries.length)) msgCount++;
  }
  const snaps = c.events.filter((e) => e.kind === "snapshot" && e.node === L);
  const lastSnap = snaps[snaps.length - 1];
  const sm = (i: NodeId) => JSON.stringify((c.node(i).machine as unknown as { snapshot(): unknown }).snapshot());
  c.run(300);
  return {
    lag,
    leader: L,
    series,
    events: c.events,
    msgs: messagesBetween(c, rejoinedAt, rejoinedAt + 120).filter((m) => m.to === lag || m.from === lag),
    catchupBytes: bytes,
    catchupMessages: msgCount,
    catchupMs: caughtAt >= 0 ? caughtAt - rejoinedAt : NaN,
    installs: c.events.filter((e) => e.kind === "install" && e.node === lag).length,
    chunks: after.filter((m) => m.payload.type === "InstallSnapshot").length,
    snapshotBytes: lastSnap && lastSnap.kind === "snapshot" ? lastSnap.bytes : 0,
    violations: c.violations,
    converged: sm(lag) === sm(L),
  };
}

// ---------------------------------------------------------------- client retries and sessions

export interface SessionRun {
  frames: Frame[];
  /** The value of counter x on the leader at the end. */
  value: number;
  /** Times the command was applied (not counting duplicates that the session table skipped). */
  appliedTimes: number;
  duplicatesSkipped: number;
}

/** A client increments x; the leader applies it, and the network loses the reply. The client retries. */
export function sessionRun(session: boolean): SessionRun {
  const c = new RaftCluster<KvCmd>({ servers: 3, clients: 1, net: { seed: 4, latency: { min: 4, max: 8 } }, raft: { ...SCRIPTED } });
  const s = new Script(c);
  const client = new RaftClient(c, 3, { timeout: 80, session });
  let appliedTimes = 0, duplicatesSkipped = 0, cut = false;
  c.onApply((node, e, _r, dup) => {
    if (node !== 0 || e.kind !== "cmd") return;
    if (dup) duplicatesSkipped++;
    else appliedTimes++;
    if (!cut) {
      cut = true;
      s.cut([[0, 1, 2]]); // the reply leaves now and is lost
    }
  });
  s.step("S1 leads term 1. A client is ready on its own node.", () => {
    s.elect(0);
  }, 60);
  s.step(`The client sends x+1 (seq 1${session ? ", with its session id" : ", with no session"}) to S1. S1 commits it, applies it and replies. The network loses the reply.`, () => {
    client.submit({ op: "add", key: "x", delta: 1 });
  }, 70);
  s.step(() => (session
    ? "The client hears nothing for 80 ms, so it sends the same request again: to S2, which points it to S1. S1 finds seq 1 in its session table and returns the saved result. x stays 1."
    : "The client hears nothing for 80 ms, so it sends the same request again: to S2, which points it to S1. S1 sees a new command, appends it and applies it. x is now 2."), () => {
    s.heal();
  }, 150);
  const v = (c.node(0).machine as unknown as { data: Map<string, number> }).data.get("x") ?? 0;
  return { frames: s.frames, value: v, appliedTimes, duplicatesSkipped };
}
