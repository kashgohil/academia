/**
 * Raft (Ongaro and Ousterhout, "In Search of an Understandable Consensus Algorithm", 2014, and Ongaro's
 * dissertation "Consensus: Bridging Theory and Practice", 2014) on the shared deterministic network (net.ts).
 *
 * What it has:
 * - terms, RequestVote and AppendEntries with every field of Figure 2, randomized election timeouts;
 * - the election restriction (vote only for an up-to-date log) and the log matching check;
 * - the commit rule: a leader commits only entries of its current term by counting replicas (it can be turned off,
 *   to show the Figure 8 problem);
 * - persistence: currentTerm, votedFor, the log and the snapshot survive a crash; everything else is rebuilt;
 * - optional pre-vote, check-quorum, leadership transfer (TimeoutNow), a no-op entry at the start of a term;
 * - membership changes: joint consensus, single-server changes (with the 2015 rule that a leader first commits an
 *   entry of its term), and an unsafe direct switch for the lesson; learners (non-voting members);
 * - snapshots, log compaction and InstallSnapshot in chunks (offset, data, done);
 * - batching (maxBatch) and pipelining (maxInflight), a disk model input, and client sessions for duplicate detection;
 * - a safety monitor that records any break of the five properties of Figure 3.
 *
 * Persistence model: a handler runs to completion before the next event, and a crash happens between events.
 * So the persistent state is always written before a reply leaves the node. With `diskMs` > 0, a node replies to
 * an append only after a modelled disk write; if it crashes first, it keeps the entries but never sends the reply.
 */
import { Net, type NetConfig, type Message } from "../../net";
import { KvMachine, type KvCmd } from "./machine";
import {
  DEFAULT_RAFT, type Config, type Entry, type NodeId, type RaftEvent, type RaftMsg, type RaftOptions, type Role,
  type Snapshot, type StateMachine, type Violation, type SessionTag,
} from "./types";

// ---------------------------------------------------------------- configurations and quorums

const uniq = (xs: NodeId[]) => [...new Set(xs)].sort((a, b) => a - b);

/** True if more than half of `ids` satisfy `has`. An empty set has no majority. */
export function majority(ids: NodeId[], has: (id: NodeId) => boolean): boolean {
  let k = 0;
  for (const id of ids) if (has(id)) k++;
  return ids.length > 0 && 2 * k > ids.length;
}

/** The smallest majority of n voters: floor(n / 2) + 1. */
export const quorumSize = (n: number) => Math.floor(n / 2) + 1;

/** A quorum of a configuration: a majority of the voters, and in a joint configuration also a majority of the old voters. */
export function hasQuorum(cfg: Config, has: (id: NodeId) => boolean): boolean {
  return majority(cfg.voters, has) && (!cfg.old || majority(cfg.old, has));
}

/** Every node that votes in the configuration (both sets during joint consensus). */
export const votersOf = (cfg: Config) => uniq([...cfg.voters, ...(cfg.old ?? [])]);
/** Every node that receives the log: voters, old voters and learners. */
export const membersOf = (cfg: Config) => uniq([...cfg.voters, ...(cfg.old ?? []), ...cfg.learners]);
export const isVoter = (cfg: Config, id: NodeId) => cfg.voters.includes(id) || (cfg.old?.includes(id) ?? false);

/** A text form of a configuration: "{0,1,2}" or "{0,1,2} + {0,1,2,3,4}" (joint), with learners after a slash. */
export function fmtConfig(cfg: Config): string {
  const s = (xs: NodeId[]) => `{${xs.map((x) => `S${x + 1}`).join(",")}}`;
  const v = cfg.old ? `${s(cfg.old)}+${s(cfg.voters)}` : s(cfg.voters);
  return cfg.learners.length ? `${v} / learners ${s(cfg.learners)}` : v;
}

/** An identity for an entry, to compare entries on different nodes. */
export function entryKey<C>(e: Entry<C>): string {
  if (e.kind === "cmd") return `${e.term}|cmd|${JSON.stringify(e.cmd)}|${e.session ? `${e.session.client}.${e.session.seq}` : ""}`;
  if (e.kind === "config") return `${e.term}|config|${JSON.stringify(e.config)}`;
  return `${e.term}|noop`;
}

// ---------------------------------------------------------------- one server

/** What a leader knows about one follower. */
export interface Progress {
  /** Index of the next entry to send. */
  next: number;
  /** Highest index known to be on the follower. */
  match: number;
  /** AppendEntries with entries that have no reply yet: the last index each one carries, and when it left. */
  inflight: { last: number; at: number }[];
  /** True until the leader knows where the logs agree. Then it sends one message at a time. */
  probing: boolean;
  /** An InstallSnapshot transfer in progress. */
  snap: { data: string; index: number; term: number; offset: number; at: number } | null;
  /** The follower replied since the last check-quorum round. */
  active: boolean;
  lastSend: number;
}

export class RaftNode<C> {
  // ----- persistent state (kept across a crash)
  currentTerm = 0;
  votedFor: NodeId | null = null;
  /** Entries after the snapshot. log[0] has index base + 1. */
  log: Entry<C>[] = [];
  snapshot: Snapshot | null = null;

  // ----- volatile state (rebuilt after a crash)
  role: Role = "follower";
  leaderId: NodeId | null = null;
  commitIndex = 0;
  lastApplied = 0;
  /** Votes (or pre-votes) granted to this node in its current election. */
  votes = new Set<NodeId>();
  electionDeadline = Infinity;
  electionTimer = 0;
  lastLeaderContact = -Infinity;
  machine: StateMachine<C>;
  sessions = new Map<number, { seq: number; result: unknown }>();
  incarnation = 0;
  /** A snapshot that arrives in chunks. */
  incoming: { index: number; term: number; buf: string } | null = null;
  /** Disk model: when the disk is free, and (on a leader) how far its own log is on disk. */
  diskBusyUntil = 0;
  diskWriting = false;
  persistedIndex = 0;
  /** Replies that wait for the next disk write on a follower. */
  diskWaiters: (() => void)[] = [];

  // ----- leader state
  progress = new Map<NodeId, Progress>();
  transfer: { to: NodeId; deadline: number } | null = null;
  /** Client requests that wait for their entry to apply: index → client. */
  pending = new Map<number, { client: number; seq: number; from: NodeId }>();

  private cfgCache: Config | null = null;
  private snapJson: string | null = null;

  constructor(readonly id: NodeId, readonly boot: Config, machine: StateMachine<C>) {
    this.machine = machine;
  }

  get base() {
    return this.snapshot?.lastIncludedIndex ?? 0;
  }
  get baseTerm() {
    return this.snapshot?.lastIncludedTerm ?? 0;
  }
  get lastIndex() {
    return this.base + this.log.length;
  }
  get lastTerm() {
    return this.log.length ? this.log[this.log.length - 1]!.term : this.baseTerm;
  }
  /** The term of the entry at index i, or undefined if the node does not have it (or it is inside the snapshot). */
  termAt(i: number): number | undefined {
    if (i === this.base) return this.baseTerm;
    if (i < this.base || i > this.lastIndex) return undefined;
    return this.log[i - this.base - 1]!.term;
  }
  entry(i: number): Entry<C> | undefined {
    return i > this.base && i <= this.lastIndex ? this.log[i - this.base - 1] : undefined;
  }
  /** The latest configuration in the log, committed or not. Raft uses it at once. */
  get config(): Config {
    return (this.cfgCache ??= this.configAt(this.lastIndex));
  }
  /** The latest configuration at or before index i. */
  configAt(i: number): Config {
    for (let k = Math.min(i, this.lastIndex); k > this.base; k--) {
      const e = this.log[k - this.base - 1]!;
      if (e.kind === "config") return e.config;
    }
    return this.snapshot?.config ?? this.boot;
  }
  /** Index of the latest configuration entry (the snapshot index if the log has none). */
  configIndex(): number {
    for (let k = this.lastIndex; k > this.base; k--) if (this.log[k - this.base - 1]!.kind === "config") return k;
    return this.base;
  }
  /** The snapshot as the bytes that InstallSnapshot sends. */
  snapshotData(): string {
    return (this.snapJson ??= JSON.stringify(this.snapshot));
  }
  /** Call after any change to the log or the snapshot. */
  touch() {
    this.cfgCache = null;
  }
  setSnapshot(s: Snapshot | null) {
    this.snapshot = s;
    this.snapJson = null;
    this.cfgCache = null;
  }
}

// ---------------------------------------------------------------- the safety monitor

/**
 * Records the five safety properties of Raft (Figure 3 of the paper) as the cluster runs. Election Safety,
 * Leader Append-Only, Leader Completeness and State Machine Safety are checked at the events that could break them.
 * Log Matching needs all logs at once, so `checkLogMatching` checks it on demand.
 */
export class SafetyMonitor {
  readonly leaders = new Map<number, NodeId>();
  /** Committed entries: index → identity. */
  readonly committed = new Map<number, string>();
  /** First entry applied at each index, by any node. */
  readonly applied = new Map<number, { key: string; node: NodeId }>();
  readonly violations: Violation[] = [];
  private seen = new Set<string>();

  constructor(private now: () => number) {}

  private flag(property: Violation["property"], detail: string, once: string) {
    if (this.seen.has(once)) return;
    this.seen.add(once);
    this.violations.push({ t: this.now(), property, detail });
  }

  onLeader<C>(n: RaftNode<C>) {
    const other = this.leaders.get(n.currentTerm);
    if (other !== undefined && other !== n.id) this.flag("Election Safety", `S${other + 1} and S${n.id + 1} are both leaders of term ${n.currentTerm}`, `es${n.currentTerm}`);
    else this.leaders.set(n.currentTerm, n.id);
    for (const [i, key] of this.committed) {
      if (i <= n.base) continue;
      const e = n.entry(i);
      if (!e || entryKey(e) !== key) this.flag("Leader Completeness", `S${n.id + 1} leads term ${n.currentTerm} without committed entry ${i}`, `lc${n.currentTerm}:${i}`);
    }
  }

  onCommit<C>(n: RaftNode<C>, from: number, to: number) {
    for (let i = from; i <= to; i++) {
      const e = n.entry(i);
      if (!e) continue;
      const key = entryKey(e);
      const prev = this.committed.get(i);
      if (prev === undefined) this.committed.set(i, key);
      else if (prev !== key) this.flag("State Machine Safety", `two different entries committed at index ${i}`, `cc${i}`);
    }
  }

  onApply<C>(n: RaftNode<C>, e: Entry<C>) {
    const key = entryKey(e);
    const prev = this.applied.get(e.index);
    if (!prev) this.applied.set(e.index, { key, node: n.id });
    else if (prev.key !== key) this.flag("State Machine Safety", `S${prev.node + 1} and S${n.id + 1} applied different entries at index ${e.index}`, `sm${e.index}`);
  }

  onTruncate<C>(n: RaftNode<C>, from: number) {
    if (n.role === "leader") this.flag("Leader Append-Only", `leader S${n.id + 1} deleted entries from index ${from}`, `la${n.id}:${n.currentTerm}`);
  }

  /** Log Matching: if two logs have an entry with the same index and term, the logs are the same up to that index. */
  checkLogMatching<C>(nodes: RaftNode<C>[]): string | null {
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const x = nodes[a]!, y = nodes[b]!;
        const lo = Math.max(x.base, y.base) + 1, hi = Math.min(x.lastIndex, y.lastIndex);
        let top = 0;
        for (let i = hi; i >= lo; i--) if (x.termAt(i) === y.termAt(i)) { top = i; break; }
        for (let i = lo; i <= top; i++) {
          if (entryKey(x.entry(i)!) !== entryKey(y.entry(i)!)) {
            const msg = `S${a + 1} and S${b + 1} agree at index ${top} but differ at index ${i}`;
            this.flag("Log Matching", msg, `lm${a}:${b}:${i}`);
            return msg;
          }
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------- the cluster

export type ProposeResult = { ok: true; index: number; term: number } | { ok: false; reason: string; leaderHint: NodeId | null };
export type ConfigMode = "joint" | "single" | "direct";
export type ApplyListener<C> = (node: NodeId, entry: Entry<C>, result: unknown, duplicate: boolean) => void;

export interface ClientHandler<C> {
  onMessage(msg: Message<RaftMsg<C>>): void;
  onTimer(tag: string): void;
}

export interface ClusterInit<C> {
  /** Number of servers. They are nodes 0 .. servers - 1 of the network. */
  servers: number;
  /** The initial voters (default: every server). Servers outside it can join later by a configuration change. */
  voters?: NodeId[];
  /** Extra network nodes for clients, after the servers. */
  clients?: number;
  net?: Partial<NetConfig>;
  raft?: Partial<RaftOptions>;
  /** Creates an empty state machine for a node. Default: KvMachine. */
  machine?: () => StateMachine<C>;
  /** Keep the event list (default true). Sweeps turn it off. */
  record?: boolean;
}

export class RaftCluster<C = KvCmd> {
  readonly net: Net<RaftMsg<C>>;
  readonly nodes: RaftNode<C>[];
  readonly n: number;
  opts: RaftOptions;
  readonly events: RaftEvent[] = [];
  readonly monitor: SafetyMonitor;
  /** Client handlers by network node id. */
  readonly clients = new Map<NodeId, ClientHandler<C>>();
  private applyListeners: ApplyListener<C>[] = [];
  private diskCbs = new Map<number, () => void>();
  private diskSeq = 0;
  private record: boolean;
  private makeMachine: () => StateMachine<C>;

  constructor(init: ClusterInit<C>) {
    this.n = init.servers;
    this.opts = { ...DEFAULT_RAFT, ...init.raft, electionTimeout: { ...DEFAULT_RAFT.electionTimeout, ...init.raft?.electionTimeout } };
    this.record = init.record ?? true;
    this.makeMachine = init.machine ?? ((() => new KvMachine()) as unknown as () => StateMachine<C>);
    const boot: Config = { voters: uniq(init.voters ?? [...Array(this.n).keys()]), learners: [] };
    this.net = new Net<RaftMsg<C>>(this.n + (init.clients ?? 0), init.net, {
      onMessage: (to, m) => this.onMessage(to, m),
      onTimer: (node, tag) => this.onTimer(node, tag),
      onRecover: (node) => this.onRecover(node),
    });
    this.monitor = new SafetyMonitor(() => this.net.now);
    this.nodes = [...Array(this.n).keys()].map((i) => new RaftNode<C>(i, boot, this.makeMachine()));
    for (const nd of this.nodes) this.resetElectionTimer(nd);
  }

  // ================================================================ public API

  get now() {
    return this.net.now;
  }
  get violations() {
    return this.monitor.violations;
  }
  node(i: NodeId) {
    return this.nodes[i]!;
  }
  isUp(i: NodeId) {
    return this.net.isUp(i);
  }
  /** Changes options while the cluster runs. New timeouts apply from the next timer. */
  setOptions(p: Partial<RaftOptions>) {
    this.opts = { ...this.opts, ...p, electionTimeout: { ...this.opts.electionTimeout, ...p.electionTimeout } };
  }
  /** Runs the network for `ms` more milliseconds. */
  run(ms: number) {
    this.net.runUntil(this.net.now + ms);
  }
  runUntil(t: number) {
    this.net.runUntil(t);
  }
  /** Runs until `pred` is true or `limit` ms pass; returns true if `pred` became true. Checks every `every` ms. */
  runUntilTrue(pred: () => boolean, limit: number, every = 5): boolean {
    const end = this.now + limit;
    while (this.now < end) {
      if (pred()) return true;
      this.net.runUntil(Math.min(end, this.now + every));
    }
    return pred();
  }
  /** The live leader with the highest term, if any. */
  leader(): NodeId | null {
    let best: RaftNode<C> | null = null;
    for (const nd of this.nodes) if (this.isUp(nd.id) && nd.role === "leader" && (!best || nd.currentTerm > best.currentTerm)) best = nd;
    return best?.id ?? null;
  }
  /** Listens to every entry that any node applies. */
  onApply(f: ApplyListener<C>) {
    this.applyListeners.push(f);
  }

  /** Asks node i to append a command, as a client next to it would. Only a live leader accepts. */
  propose(i: NodeId, cmd: C, session?: SessionTag): ProposeResult {
    const nd = this.nodes[i]!;
    if (!this.isUp(i)) return { ok: false, reason: "down", leaderHint: null };
    if (nd.role !== "leader") return { ok: false, reason: "not leader", leaderHint: nd.leaderId };
    if (nd.transfer) return { ok: false, reason: "transferring leadership", leaderHint: null };
    const e = this.append(nd, session ? { kind: "cmd", cmd, session } : { kind: "cmd", cmd });
    this.replicateAll(nd);
    return { ok: true, index: e.index, term: e.term };
  }

  crash(i: NodeId) {
    if (!this.isUp(i)) return;
    this.net.crash(i);
    this.event({ t: this.now, node: i, kind: "crash" });
  }
  recover(i: NodeId) {
    if (this.isUp(i)) return;
    this.net.recover(i); // calls onRecover
  }
  partition(groups: NodeId[][]) {
    this.net.partition(groups);
  }
  heal() {
    this.net.heal();
  }
  /** Fires node i's election timeout now (for scripted scenarios). */
  timeout(i: NodeId) {
    const nd = this.nodes[i]!;
    if (this.isUp(i)) this.onElectionTimeout(nd);
  }

  /** Leadership transfer (dissertation section 3.10): bring `to` up to date, then send it TimeoutNow. */
  transferLeadership(from: NodeId, to: NodeId): { ok: boolean; reason?: string } {
    const nd = this.nodes[from]!;
    if (!this.isUp(from) || nd.role !== "leader") return { ok: false, reason: "not leader" };
    if (to === from || !isVoter(nd.config, to)) return { ok: false, reason: "target is not another voter" };
    nd.transfer = { to, deadline: this.now + this.opts.electionTimeout.max };
    this.event({ t: this.now, node: from, kind: "transfer", to });
    const p = nd.progress.get(to)!;
    if (p.match === nd.lastIndex) this.net.send(from, to, { type: "TimeoutNow", term: nd.currentTerm });
    else this.replicate(nd, to);
    return { ok: true };
  }

  /**
   * Changes the membership. joint: C(old,new) first, then C(new) when it commits. single: at most one voter added
   * or removed. direct: switch to the new voters in one step, which is unsafe and exists only for the lesson.
   */
  changeConfig(leader: NodeId, next: { voters: NodeId[]; learners?: NodeId[] }, mode: ConfigMode): { ok: boolean; reason?: string; index?: number } {
    const nd = this.nodes[leader]!;
    if (!this.isUp(leader) || nd.role !== "leader") return { ok: false, reason: "not leader" };
    const cur = nd.config;
    if (cur.old || nd.configIndex() > nd.commitIndex) return { ok: false, reason: "a configuration change is in progress" };
    if (this.opts.configNeedsCurrentTermCommit && nd.termAt(nd.commitIndex) !== nd.currentTerm)
      return { ok: false, reason: "the leader has not yet committed an entry of its term" };
    const voters = uniq(next.voters);
    const learners = uniq((next.learners ?? []).filter((x) => !voters.includes(x)));
    if (!voters.length) return { ok: false, reason: "no voters" };
    if (mode === "single") {
      const diff = voters.filter((x) => !cur.voters.includes(x)).length + cur.voters.filter((x) => !voters.includes(x)).length;
      if (diff > 1) return { ok: false, reason: "a single-server change adds or removes one voter" };
    }
    const config: Config = mode === "joint" ? { voters, old: cur.voters, learners } : { voters, learners };
    const e = this.append(nd, { kind: "config", config });
    this.replicateAll(nd);
    return { ok: true, index: e.index };
  }

  /** Takes a snapshot of node i at its last applied index. */
  snapshotNow(i: NodeId) {
    const nd = this.nodes[i]!;
    if (nd.lastApplied > nd.base) this.takeSnapshot(nd, nd.lastApplied);
  }

  /** Checks Log Matching across all servers now. */
  checkLogMatching() {
    return this.monitor.checkLogMatching(this.nodes);
  }

  // ================================================================ timers

  private resetElectionTimer(nd: RaftNode<C>) {
    this.net.cancelTimer(nd.electionTimer);
    const { min, max } = this.opts.electionTimeout;
    const t = min + this.net.random() * (max - min);
    nd.electionDeadline = this.now + t;
    nd.electionTimer = this.net.setTimer(nd.id, t, `elect:${nd.incarnation}`);
  }

  private stopElectionTimer(nd: RaftNode<C>) {
    this.net.cancelTimer(nd.electionTimer);
    nd.electionDeadline = Infinity;
  }

  private onTimer(node: NodeId, tag: string) {
    if (node >= this.n) return void this.clients.get(node)?.onTimer(tag);
    const nd = this.nodes[node]!;
    const [kind, inc, arg] = tag.split(":");
    if (Number(inc) !== nd.incarnation) return; // a timer from before a crash
    if (kind === "elect") this.onElectionTimeout(nd);
    else if (kind === "hb" && nd.role === "leader" && Number(arg) === nd.currentTerm) {
      this.heartbeat(nd);
      this.net.setTimer(nd.id, this.opts.heartbeat, `hb:${nd.incarnation}:${nd.currentTerm}`);
    } else if (kind === "cq" && nd.role === "leader" && Number(arg) === nd.currentTerm) {
      this.checkQuorum(nd);
    } else if (kind === "disk") {
      const cb = this.diskCbs.get(Number(arg));
      this.diskCbs.delete(Number(arg));
      cb?.();
    }
  }

  /** Runs `cb` after a modelled disk write. Writes on one node run one after another. */
  private disk(nd: RaftNode<C>, cb: () => void) {
    nd.diskBusyUntil = Math.max(this.now, nd.diskBusyUntil) + this.opts.diskMs;
    const id = ++this.diskSeq;
    this.diskCbs.set(id, cb);
    this.net.setTimer(nd.id, nd.diskBusyUntil - this.now, `disk:${nd.incarnation}:${id}`);
  }

  // ================================================================ roles and elections

  private event(e: RaftEvent) {
    if (this.record) this.events.push(e);
  }

  private setRole(nd: RaftNode<C>, role: Role) {
    if (nd.role === role) return;
    nd.role = role;
    this.event({ t: this.now, node: nd.id, kind: "role", role, term: nd.currentTerm });
  }

  private becomeFollower(nd: RaftNode<C>, term: number, leader: NodeId | null) {
    if (term > nd.currentTerm) {
      nd.currentTerm = term;
      nd.votedFor = null;
    }
    const wasLeader = nd.role === "leader";
    nd.leaderId = leader;
    nd.votes.clear();
    if (wasLeader) {
      nd.progress.clear();
      nd.pending.clear();
      nd.transfer = null;
    }
    this.setRole(nd, "follower");
    if (wasLeader) this.resetElectionTimer(nd);
  }

  private onElectionTimeout(nd: RaftNode<C>) {
    if (nd.role === "leader") return;
    if (!isVoter(nd.config, nd.id)) return void this.resetElectionTimer(nd); // learners and non-members wait
    if (this.opts.preVote) this.startPreVote(nd);
    else this.startElection(nd, false);
  }

  private startPreVote(nd: RaftNode<C>) {
    nd.leaderId = null;
    nd.votes = new Set([nd.id]);
    this.setRole(nd, "precandidate");
    this.resetElectionTimer(nd);
    if (hasQuorum(nd.config, (id) => nd.votes.has(id))) return void this.startElection(nd, false);
    for (const v of votersOf(nd.config))
      if (v !== nd.id) this.net.send(nd.id, v, { type: "RequestVote", term: nd.currentTerm + 1, candidateId: nd.id, lastLogIndex: nd.lastIndex, lastLogTerm: nd.lastTerm, preVote: true, transfer: false });
  }

  private startElection(nd: RaftNode<C>, transfer: boolean) {
    nd.currentTerm++;
    nd.votedFor = nd.id;
    nd.leaderId = null;
    nd.votes = new Set([nd.id]);
    nd.role = "follower"; // so that setRole records the new term even if it was already a candidate
    this.setRole(nd, "candidate");
    this.event({ t: this.now, node: nd.id, kind: "vote", term: nd.currentTerm, for: nd.id });
    this.resetElectionTimer(nd);
    if (hasQuorum(nd.config, (id) => nd.votes.has(id))) return void this.becomeLeader(nd);
    for (const v of votersOf(nd.config))
      if (v !== nd.id) this.net.send(nd.id, v, { type: "RequestVote", term: nd.currentTerm, candidateId: nd.id, lastLogIndex: nd.lastIndex, lastLogTerm: nd.lastTerm, preVote: false, transfer });
  }

  /**
   * True if node `nd` should ignore a vote or pre-vote request with a higher term because it has a live leader.
   * As in etcd's "inLease", this applies only with check-quorum (dissertation section 4.2.3).
   */
  private inLease(nd: RaftNode<C>): boolean {
    if (!this.opts.checkQuorum) return false;
    if (nd.role === "leader") return true;
    return nd.leaderId !== null && this.now - nd.lastLeaderContact < this.opts.electionTimeout.min;
  }

  private onRequestVote(nd: RaftNode<C>, m: Extract<RaftMsg<C>, { type: "RequestVote" }>, from: NodeId) {
    const reply = (granted: boolean, term: number) =>
      this.net.send(nd.id, from, { type: "RequestVoteReply", term, voteGranted: granted, preVote: m.preVote, reqTerm: m.term });
    const upToDate = m.lastLogTerm > nd.lastTerm || (m.lastLogTerm === nd.lastTerm && m.lastLogIndex >= nd.lastIndex);
    if (m.term > nd.currentTerm && !m.transfer && this.inLease(nd)) return void reply(false, nd.currentTerm);
    if (m.preVote) {
      const grant = m.term > nd.currentTerm && upToDate;
      return void reply(grant, grant ? m.term : nd.currentTerm);
    }
    if (m.term > nd.currentTerm) this.becomeFollower(nd, m.term, null);
    let grant = false;
    if (m.term === nd.currentTerm && (nd.votedFor === null || nd.votedFor === m.candidateId) && upToDate) {
      grant = true;
      if (nd.votedFor === null) this.event({ t: this.now, node: nd.id, kind: "vote", term: nd.currentTerm, for: m.candidateId });
      nd.votedFor = m.candidateId;
      this.resetElectionTimer(nd);
    }
    reply(grant, nd.currentTerm);
  }

  private onVoteReply(nd: RaftNode<C>, m: Extract<RaftMsg<C>, { type: "RequestVoteReply" }>, from: NodeId) {
    if (m.preVote) {
      if (m.voteGranted && nd.role === "precandidate" && m.reqTerm === nd.currentTerm + 1) {
        nd.votes.add(from);
        if (hasQuorum(nd.config, (id) => nd.votes.has(id))) this.startElection(nd, false);
      } else if (!m.voteGranted && m.term > nd.currentTerm) this.becomeFollower(nd, m.term, null);
      return;
    }
    if (m.term > nd.currentTerm) return void this.becomeFollower(nd, m.term, null);
    if (nd.role !== "candidate" || m.term !== nd.currentTerm || !m.voteGranted) return;
    nd.votes.add(from);
    if (hasQuorum(nd.config, (id) => nd.votes.has(id))) this.becomeLeader(nd);
  }

  private newProgress(nd: RaftNode<C>): Progress {
    return { next: nd.lastIndex + 1, match: 0, inflight: [], probing: true, snap: null, active: true, lastSend: -Infinity };
  }

  private becomeLeader(nd: RaftNode<C>) {
    this.stopElectionTimer(nd);
    nd.leaderId = nd.id;
    this.setRole(nd, "leader");
    this.monitor.onLeader(nd);
    nd.progress = new Map();
    for (const m of membersOf(nd.config)) if (m !== nd.id) nd.progress.set(m, this.newProgress(nd));
    nd.pending = new Map();
    nd.transfer = null;
    nd.persistedIndex = nd.lastIndex;
    nd.diskWriting = false;
    if (this.opts.noopOnElection) this.append(nd, { kind: "noop" });
    for (const f of nd.progress.keys()) this.sendAppend(nd, f);
    this.net.setTimer(nd.id, this.opts.heartbeat, `hb:${nd.incarnation}:${nd.currentTerm}`);
    if (this.opts.checkQuorum) this.net.setTimer(nd.id, this.opts.electionTimeout.min, `cq:${nd.incarnation}:${nd.currentTerm}`);
    this.maybeCommit(nd);
  }

  private checkQuorum(nd: RaftNode<C>) {
    const ok = hasQuorum(nd.config, (id) => id === nd.id || (nd.progress.get(id)?.active ?? false));
    if (!ok) return void this.becomeFollower(nd, nd.currentTerm, null);
    for (const p of nd.progress.values()) p.active = false;
    this.net.setTimer(nd.id, this.opts.electionTimeout.min, `cq:${nd.incarnation}:${nd.currentTerm}`);
  }

  // ================================================================ the leader's log

  private append(nd: RaftNode<C>, e: { kind: "noop" } | { kind: "cmd"; cmd: C; session?: SessionTag } | { kind: "config"; config: Config }): Entry<C> {
    const entry = { ...e, term: nd.currentTerm, index: nd.lastIndex + 1 } as Entry<C>;
    nd.log.push(entry);
    nd.touch();
    if (entry.kind === "config") {
      this.event({ t: this.now, node: nd.id, kind: "config", index: entry.index, config: entry.config });
      for (const m of membersOf(entry.config)) if (m !== nd.id && !nd.progress.has(m)) nd.progress.set(m, { ...this.newProgress(nd), next: entry.index });
    }
    this.persistLeader(nd);
    return entry;
  }

  /** The leader writes its own new entries to disk; one write covers every entry appended so far (group commit). */
  private persistLeader(nd: RaftNode<C>) {
    if (this.opts.diskMs <= 0) {
      nd.persistedIndex = nd.lastIndex;
      return;
    }
    if (nd.diskWriting) return;
    nd.diskWriting = true;
    const upTo = nd.lastIndex, term = nd.currentTerm;
    this.disk(nd, () => {
      nd.diskWriting = false;
      if (nd.role !== "leader" || nd.currentTerm !== term) return;
      nd.persistedIndex = Math.max(nd.persistedIndex, upTo);
      this.maybeCommit(nd);
      if (nd.lastIndex > nd.persistedIndex) this.persistLeader(nd);
    });
  }

  private replicateAll(nd: RaftNode<C>) {
    for (const f of nd.progress.keys()) this.replicate(nd, f);
  }

  /** Sends what the follower needs, within the batching and pipelining limits. */
  private replicate(nd: RaftNode<C>, f: NodeId) {
    const p = nd.progress.get(f);
    if (!p || p.snap) return;
    if (p.next <= nd.base) return void this.sendSnapshot(nd, f, p);
    if (p.probing) {
      if (!p.inflight.length) this.sendAppend(nd, f);
      return;
    }
    while (p.inflight.length < this.opts.maxInflight && p.next <= nd.lastIndex) this.sendAppend(nd, f);
  }

  private sendAppend(nd: RaftNode<C>, f: NodeId) {
    const p = nd.progress.get(f)!;
    if (p.next <= nd.base) return void this.sendSnapshot(nd, f, p);
    const prev = p.next - 1;
    const last = Math.min(nd.lastIndex, prev + this.opts.maxBatch);
    const entries = nd.log.slice(prev - nd.base, last - nd.base);
    this.net.send(nd.id, f, { type: "AppendEntries", term: nd.currentTerm, leaderId: nd.id, prevLogIndex: prev, prevLogTerm: nd.termAt(prev)!, entries, leaderCommit: nd.commitIndex });
    p.lastSend = this.now;
    if (p.probing) p.inflight = [{ last, at: this.now }];
    else if (entries.length) {
      p.inflight.push({ last, at: this.now });
      p.next = last + 1;
    }
  }

  private sendSnapshot(nd: RaftNode<C>, f: NodeId, p: Progress) {
    // Start a transfer, or restart one from the beginning with the newest snapshot.
    if (!p.snap || (p.snap.offset === 0 && p.snap.index !== nd.base)) p.snap = { data: nd.snapshotData(), index: nd.base, term: nd.baseTerm, offset: 0, at: this.now };
    const s = p.snap;
    const data = s.data.slice(s.offset, s.offset + this.opts.snapshotChunk);
    this.net.send(nd.id, f, { type: "InstallSnapshot", term: nd.currentTerm, leaderId: nd.id, lastIncludedIndex: s.index, lastIncludedTerm: s.term, offset: s.offset, data, done: s.offset + data.length >= s.data.length });
    s.at = this.now;
    p.lastSend = this.now;
    p.inflight = [];
  }

  /** Every heartbeat interval: retransmit what has no reply, and send an empty AppendEntries to idle followers. */
  private heartbeat(nd: RaftNode<C>) {
    if (nd.transfer && this.now > nd.transfer.deadline) nd.transfer = null;
    for (const [f, p] of nd.progress) {
      if (p.snap) {
        if (this.now - p.snap.at >= this.opts.retransmit) this.sendSnapshot(nd, f, p);
        continue;
      }
      const oldest = p.inflight[0];
      if (oldest && this.now - oldest.at >= this.opts.retransmit) {
        p.inflight = [];
        p.next = p.match + 1;
        p.probing = true;
        this.sendAppend(nd, f);
        continue;
      }
      if (!p.inflight.length && p.next <= nd.lastIndex) {
        this.replicate(nd, f);
        continue;
      }
      if (this.now - p.lastSend < this.opts.heartbeat) continue;
      const prev = Math.max(p.match, nd.base);
      this.net.send(nd.id, f, { type: "AppendEntries", term: nd.currentTerm, leaderId: nd.id, prevLogIndex: prev, prevLogTerm: nd.termAt(prev)!, entries: [], leaderCommit: nd.commitIndex });
      p.lastSend = this.now;
    }
  }

  private onAppendReply(nd: RaftNode<C>, m: Extract<RaftMsg<C>, { type: "AppendEntriesReply" }>, from: NodeId) {
    if (m.term > nd.currentTerm) return void this.becomeFollower(nd, m.term, null);
    if (nd.role !== "leader" || m.term !== nd.currentTerm) return;
    const p = nd.progress.get(from);
    if (!p) return;
    p.active = true;
    if (m.success) {
      if (m.matchIndex > p.match) p.match = m.matchIndex;
      p.inflight = p.inflight.filter((x) => x.last > m.matchIndex);
      if (p.probing && m.matchIndex >= p.next - 1) {
        p.probing = false;
        p.inflight = [];
      }
      if (p.next < p.match + 1) p.next = p.match + 1;
      this.maybeCommit(nd);
      if (nd.role !== "leader") return;
      if (nd.transfer?.to === from && p.match === nd.lastIndex) this.net.send(nd.id, from, { type: "TimeoutNow", term: nd.currentTerm });
      this.replicate(nd, from);
      return;
    }
    if (m.prevLogIndex < p.match) return; // a stale reply
    if (p.probing && m.prevLogIndex !== p.next - 1) return; // a reply to an older probe
    let next: number;
    if (!this.opts.fastBackup) next = m.prevLogIndex;
    else if (m.conflictTerm > 0) {
      const k = this.lastIndexOfTerm(nd, m.conflictTerm);
      next = k > 0 ? k + 1 : m.conflictIndex;
    } else next = m.conflictIndex;
    p.next = Math.max(p.match + 1, Math.min(next, m.prevLogIndex));
    p.probing = true;
    p.inflight = [];
    this.sendAppend(nd, from);
  }

  private lastIndexOfTerm(nd: RaftNode<C>, term: number): number {
    for (let i = nd.lastIndex; i > nd.base; i--) {
      const t = nd.termAt(i)!;
      if (t === term) return i;
      if (t < term) return 0;
    }
    return nd.baseTerm === term ? nd.base : 0;
  }

  /** The commit rule. With commitCurrentTermOnly, only an entry of the current term can be committed by counting. */
  private maybeCommit(nd: RaftNode<C>) {
    if (nd.role !== "leader") return;
    const cfg = nd.config;
    for (let N = nd.lastIndex; N > nd.commitIndex; N--) {
      if (this.opts.commitCurrentTermOnly && nd.termAt(N) !== nd.currentTerm) break; // terms only fall going back
      const has = (id: NodeId) => (id === nd.id ? nd.persistedIndex >= N : (nd.progress.get(id)?.match ?? 0) >= N);
      if (hasQuorum(cfg, has)) {
        this.setCommit(nd, N);
        break;
      }
    }
  }

  private setCommit(nd: RaftNode<C>, N: number) {
    if (N <= nd.commitIndex) return;
    const from = nd.commitIndex + 1;
    nd.commitIndex = N;
    if (nd.role === "leader") {
      this.monitor.onCommit(nd, from, N);
      this.event({ t: this.now, node: nd.id, kind: "commit", index: N, term: nd.termAt(N) ?? nd.baseTerm });
    }
    this.applyCommitted(nd);
    if (nd.role === "leader") this.afterCommit(nd);
  }

  /** Joint consensus moves on to C(new) once C(old,new) commits; a leader outside C(new) steps down once C(new) commits. */
  private afterCommit(nd: RaftNode<C>) {
    if (nd.configIndex() > nd.commitIndex) return;
    const cfg = nd.config;
    if (cfg.old) {
      this.append(nd, { kind: "config", config: { voters: cfg.voters, learners: cfg.learners } });
      this.replicateAll(nd);
    } else if (!cfg.voters.includes(nd.id)) this.becomeFollower(nd, nd.currentTerm, null);
  }

  // ================================================================ followers

  private onAppendEntries(nd: RaftNode<C>, m: Extract<RaftMsg<C>, { type: "AppendEntries" }>, from: NodeId) {
    const send = (success: boolean, matchIndex: number, conflictTerm = 0, conflictIndex = 0) =>
      this.net.send(nd.id, from, { type: "AppendEntriesReply", term: nd.currentTerm, success, prevLogIndex: m.prevLogIndex, matchIndex, conflictTerm, conflictIndex });
    if (m.term < nd.currentTerm) return void send(false, 0);
    if (m.term > nd.currentTerm || nd.role !== "follower") this.becomeFollower(nd, m.term, m.leaderId);
    nd.leaderId = m.leaderId;
    nd.lastLeaderContact = this.now;
    this.resetElectionTimer(nd);

    let prev = m.prevLogIndex, prevTerm = m.prevLogTerm, entries = m.entries;
    if (prev < nd.base) {
      // Entries at or below the snapshot are committed, so they equal ours. Skip them.
      const skip = nd.base - prev;
      if (entries.length <= skip) return void send(true, m.prevLogIndex + m.entries.length);
      entries = entries.slice(skip);
      prev = nd.base;
      prevTerm = nd.baseTerm;
    }
    if (prev > nd.lastIndex) return void send(false, 0, 0, nd.lastIndex + 1);
    const t = nd.termAt(prev)!;
    if (t !== prevTerm) {
      let first = prev;
      while (first - 1 > nd.base && nd.termAt(first - 1) === t) first--;
      return void send(false, 0, t, first);
    }
    let wrote = false;
    for (let k = 0; k < entries.length; k++) {
      const e = entries[k]!;
      if (e.index <= nd.lastIndex) {
        if (nd.termAt(e.index) === e.term) continue;
        this.truncate(nd, e.index); // a conflict: delete this entry and all that follow it
      }
      nd.log.push(...entries.slice(k));
      nd.touch();
      wrote = true;
      break;
    }
    const lastNew = m.prevLogIndex + m.entries.length;
    if (m.leaderCommit > nd.commitIndex) this.setCommit(nd, Math.min(m.leaderCommit, lastNew));
    if (wrote && this.opts.diskMs > 0) {
      const term = nd.currentTerm;
      this.followerWrite(nd, () => this.net.send(nd.id, from, { type: "AppendEntriesReply", term, success: true, prevLogIndex: m.prevLogIndex, matchIndex: lastNew, conflictTerm: 0, conflictIndex: 0 }));
    } else send(true, lastNew);
  }

  /** A follower's disk: one write covers every append that arrived while the previous write ran (group commit). */
  private followerWrite(nd: RaftNode<C>, reply: () => void) {
    nd.diskWaiters.push(reply);
    if (nd.diskWriting) return;
    nd.diskWriting = true;
    const batch = nd.diskWaiters;
    nd.diskWaiters = [];
    this.disk(nd, () => {
      nd.diskWriting = false;
      for (const r of batch) r();
      if (nd.diskWaiters.length) this.followerWrite(nd, nd.diskWaiters.pop()!);
    });
  }

  private truncate(nd: RaftNode<C>, from: number) {
    this.monitor.onTruncate(nd, from);
    const removed = nd.log.length - (from - nd.base - 1);
    nd.log.length = from - nd.base - 1;
    nd.touch();
    this.event({ t: this.now, node: nd.id, kind: "truncate", from, removed });
  }

  private onInstallSnapshot(nd: RaftNode<C>, m: Extract<RaftMsg<C>, { type: "InstallSnapshot" }>, from: NodeId) {
    // The reply says how many bytes of this snapshot the node holds, so that the leader resends from there.
    const reply = (offset: number, done: boolean) =>
      this.net.send(nd.id, from, { type: "InstallSnapshotReply", term: nd.currentTerm, lastIncludedIndex: m.lastIncludedIndex, offset, done });
    if (m.term < nd.currentTerm) return void reply(0, false);
    if (m.term > nd.currentTerm || nd.role !== "follower") this.becomeFollower(nd, m.term, m.leaderId);
    nd.leaderId = m.leaderId;
    nd.lastLeaderContact = this.now;
    this.resetElectionTimer(nd);
    if (m.offset === 0) nd.incoming = { index: m.lastIncludedIndex, term: m.lastIncludedTerm, buf: "" };
    const inc = nd.incoming;
    if (!inc || inc.index !== m.lastIncludedIndex) return void reply(0, false); // start again from byte 0
    if (inc.buf.length === m.offset) {
      inc.buf += m.data;
      if (m.done) {
        this.installSnapshot(nd, JSON.parse(inc.buf) as Snapshot, inc.buf.length);
        nd.incoming = null;
        return void reply(m.offset + m.data.length, true);
      }
    }
    reply(inc.buf.length, false);
  }

  private installSnapshot(nd: RaftNode<C>, snap: Snapshot, bytes: number) {
    const idx = snap.lastIncludedIndex;
    if (idx <= nd.commitIndex) return; // we already hold this prefix
    if (nd.termAt(idx) === snap.lastIncludedTerm) nd.log = nd.log.slice(idx - nd.base);
    else {
      if (nd.log.length) this.truncate(nd, nd.base + 1);
      nd.log = [];
    }
    nd.setSnapshot(snap);
    nd.commitIndex = idx;
    nd.lastApplied = idx;
    nd.machine.restore(snap.state);
    nd.sessions = new Map(snap.sessions);
    this.event({ t: this.now, node: nd.id, kind: "install", index: idx, term: snap.lastIncludedTerm, bytes });
  }

  private onSnapshotReply(nd: RaftNode<C>, m: Extract<RaftMsg<C>, { type: "InstallSnapshotReply" }>, from: NodeId) {
    if (m.term > nd.currentTerm) return void this.becomeFollower(nd, m.term, null);
    if (nd.role !== "leader" || m.term !== nd.currentTerm) return;
    const p = nd.progress.get(from);
    if (!p) return;
    p.active = true;
    const s = p.snap;
    if (!s || s.index !== m.lastIncludedIndex) return;
    if (m.done) {
      p.match = Math.max(p.match, s.index);
      p.next = p.match + 1;
      p.snap = null;
      p.probing = false;
      p.inflight = [];
      this.maybeCommit(nd);
      this.replicate(nd, from);
    } else if (m.offset !== s.offset) {
      s.offset = m.offset; // the next byte the follower needs: forward after an ack, back after a loss
      this.sendSnapshot(nd, from, p);
    }
  }

  // ================================================================ applying and snapshots

  private applyCommitted(nd: RaftNode<C>) {
    while (nd.lastApplied < nd.commitIndex) {
      const i = ++nd.lastApplied;
      const e = nd.entry(i)!;
      let result: unknown, duplicate = false;
      if (e.kind === "cmd") {
        const s = e.session, last = s ? nd.sessions.get(s.client) : undefined;
        if (s && last && s.seq <= last.seq) {
          duplicate = true; // the client retried a command that already applied: return the saved result
          result = s.seq === last.seq ? last.result : undefined;
        } else {
          result = nd.machine.apply(e.cmd);
          if (s) nd.sessions.set(s.client, { seq: s.seq, result });
        }
      }
      this.monitor.onApply(nd, e);
      for (const f of this.applyListeners) f(nd.id, e, result, duplicate);
      const w = nd.pending.get(i);
      if (w && nd.role === "leader") {
        nd.pending.delete(i);
        this.net.send(nd.id, w.from, { type: "ClientReply", client: w.client, seq: w.seq, ok: true, result, leaderHint: nd.id });
      }
    }
    if (this.opts.snapshotThreshold > 0 && nd.lastApplied - nd.base >= this.opts.snapshotThreshold) this.takeSnapshot(nd, nd.lastApplied);
  }

  private takeSnapshot(nd: RaftNode<C>, idx: number) {
    const snap: Snapshot = {
      lastIncludedIndex: idx,
      lastIncludedTerm: nd.termAt(idx)!,
      config: nd.configAt(idx),
      state: nd.machine.snapshot(),
      sessions: [...nd.sessions],
    };
    nd.log = nd.log.slice(idx - nd.base);
    nd.setSnapshot(snap);
    this.event({ t: this.now, node: nd.id, kind: "snapshot", index: idx, term: snap.lastIncludedTerm, bytes: nd.snapshotData().length });
  }

  // ================================================================ crash recovery and dispatch

  private onRecover(i: NodeId) {
    if (i >= this.n) return;
    const nd = this.nodes[i]!;
    nd.incarnation++;
    nd.role = "follower";
    nd.leaderId = null;
    nd.votes = new Set();
    nd.progress = new Map();
    nd.pending = new Map();
    nd.transfer = null;
    nd.incoming = null;
    nd.lastLeaderContact = -Infinity;
    nd.commitIndex = nd.base;
    nd.lastApplied = nd.base;
    nd.machine = this.makeMachine();
    if (nd.snapshot) nd.machine.restore(nd.snapshot.state);
    nd.sessions = new Map(nd.snapshot?.sessions ?? []);
    nd.diskBusyUntil = this.now;
    nd.diskWriting = false;
    nd.diskWaiters = [];
    nd.persistedIndex = nd.lastIndex;
    nd.touch();
    this.event({ t: this.now, node: i, kind: "recover" });
    this.resetElectionTimer(nd);
  }

  private onMessage(to: NodeId, msg: Message<RaftMsg<C>>) {
    if (to >= this.n) return void this.clients.get(to)?.onMessage(msg);
    const nd = this.nodes[to]!;
    const m = msg.payload;
    switch (m.type) {
      case "RequestVote": return this.onRequestVote(nd, m, msg.from);
      case "RequestVoteReply": return this.onVoteReply(nd, m, msg.from);
      case "AppendEntries": return this.onAppendEntries(nd, m, msg.from);
      case "AppendEntriesReply": return this.onAppendReply(nd, m, msg.from);
      case "InstallSnapshot": return this.onInstallSnapshot(nd, m, msg.from);
      case "InstallSnapshotReply": return this.onSnapshotReply(nd, m, msg.from);
      case "TimeoutNow":
        if (m.term > nd.currentTerm) this.becomeFollower(nd, m.term, msg.from);
        if (m.term === nd.currentTerm && nd.role !== "leader" && isVoter(nd.config, nd.id)) this.startElection(nd, true);
        return;
      case "ClientRequest": return this.onClientRequest(nd, m, msg.from);
      case "ClientReply": return;
    }
  }

  private onClientRequest(nd: RaftNode<C>, m: Extract<RaftMsg<C>, { type: "ClientRequest" }>, from: NodeId) {
    const no = (hint: NodeId | null) => this.net.send(nd.id, from, { type: "ClientReply", client: m.client, seq: m.seq, ok: false, leaderHint: hint });
    if (nd.role !== "leader" || nd.transfer) return void no(nd.role === "leader" ? null : nd.leaderId);
    if (m.session) {
      const s = nd.sessions.get(m.client);
      if (s && s.seq >= m.seq) {
        if (s.seq === m.seq) this.net.send(nd.id, from, { type: "ClientReply", client: m.client, seq: m.seq, ok: true, result: s.result, leaderHint: nd.id });
        return;
      }
    }
    const e = this.append(nd, m.session ? { kind: "cmd", cmd: m.cmd, session: { client: m.client, seq: m.seq } } : { kind: "cmd", cmd: m.cmd });
    nd.pending.set(e.index, { client: m.client, seq: m.seq, from });
    this.replicateAll(nd);
  }
}
