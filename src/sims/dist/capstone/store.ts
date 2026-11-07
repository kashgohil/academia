/**
 * A replicated key-value store on the committed Raft sim (src/sims/dist/consensus/raft): the capstone of the track.
 *
 * Layers, top to bottom:
 * - KvClient: a client on its own network node. One operation at a time, retries with a timeout, follows leader hints.
 *   Writes carry a session tag (client id, seq), so that a retried write applies once.
 * - Read paths (this file, on top of the Raft API): "log" (a get through the log), "readindex" (Raft dissertation
 *   section 6.4: commit index + a heartbeat round to a majority), "lease" (section 6.4.1: no round while a lease from
 *   acknowledged heartbeats is valid, with a bound on clock drift), and "local" (a deliberate bug: any server answers).
 * - RaftCluster: the log, elections, snapshots and membership changes, unchanged.
 * - StoreMachine: put, get, delete and compare-and-set on a map, with a revision counter as in etcd.
 *
 * What this file adds to Raft, without editing raft.ts: it wraps the network handlers of the cluster. That gives it
 * four extra messages (Read, ReadReply, RiPing, RiAck), process pauses (a paused server buffers its messages and timers
 * and runs them when it resumes), per-server clocks with a settable rate (for lease reads), and four deliberate bugs.
 *
 * Lease bookkeeping: each AppendEntries is stamped with the leader's clock when it leaves. The follower's reply
 * echoes the stamp (as etcd's heartbeat context does). A leader holds a lease from the newest stamp that a quorum has
 * echoed, for electionTimeout.min × (1 − drift bound) on its own clock. Followers honor it through Raft's check-quorum
 * rule (no vote within the minimum election timeout after hearing from a leader). A restarted server forgets when it
 * last heard from a leader, so in lease mode it ignores RequestVote for one minimum election timeout after a restart.
 */
import type { Message, NodeId } from "../net";
import type { Net } from "../net";
import { RaftCluster, hasQuorum, votersOf } from "../consensus/raft/raft";
import type { RaftMsg, RaftOptions, StateMachine } from "../consensus/raft/types";
import { mulberry32, type Rng } from "../../rng";
import type { HOp } from "../consistency/history";
import { checkRegister, type LinResult } from "../consistency/linearizability";

// ---------------------------------------------------------------- the state machine

/** Commands in the log. `get` appears only with the "log" read path. A value of 0 means "absent". */
export type StoreCmd =
  | { op: "put"; key: string; value: number }
  | { op: "del"; key: string }
  | { op: "cas"; key: string; expect: number; value: number }
  | { op: "get"; key: string };

/** What apply returns: for cas, ok is false if the current value was not `expect`. value: the value after the command. */
export interface StoreResult { ok: boolean; value: number; rev: number }

export class StoreMachine implements StateMachine<StoreCmd> {
  data = new Map<string, number>();
  /** Bumps on every change, like etcd's revision. */
  rev = 0;
  applied = 0;

  apply(cmd: StoreCmd): StoreResult {
    this.applied++;
    const cur = this.data.get(cmd.key) ?? 0;
    if (cmd.op === "get") return { ok: true, value: cur, rev: this.rev };
    if (cmd.op === "cas" && cur !== cmd.expect) return { ok: false, value: cur, rev: this.rev };
    const next = cmd.op === "del" ? 0 : cmd.value;
    if (next === 0) this.data.delete(cmd.key);
    else this.data.set(cmd.key, next);
    this.rev++;
    return { ok: true, value: next, rev: this.rev };
  }
  get(key: string) {
    return this.data.get(key) ?? 0;
  }
  snapshot() {
    return { data: [...this.data].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), rev: this.rev, applied: this.applied };
  }
  restore(s: unknown) {
    const x = s as { data: [string, number][]; rev: number; applied: number } | null;
    this.data = new Map(x?.data ?? []);
    this.rev = x?.rev ?? 0;
    this.applied = x?.applied ?? 0;
  }
}

/** "x=5", "del x", "cas x 0→7", "get x". */
export function cmdText(c: StoreCmd): string {
  if (c.op === "put") return `${c.key}=${c.value}`;
  if (c.op === "del") return `del ${c.key}`;
  if (c.op === "cas") return `cas ${c.key} ${c.expect}→${c.value}`;
  return `get ${c.key}`;
}

// ---------------------------------------------------------------- messages the store adds

export type ExtMsg =
  | { type: "Read"; client: number; seq: number; key: string }
  | { type: "ReadReply"; client: number; seq: number; ok: boolean; value?: number; leaderHint: NodeId | null; via?: ReadVia; readIndex?: number }
  | { type: "RiPing"; term: number; ctx: number }
  | { type: "RiAck"; term: number; ctx: number };
export type StoreMsg = RaftMsg<StoreCmd> | ExtMsg;
export type ReadVia = "lease" | "readindex" | "local";

/** The read path. "local" is the bug "read from any server". */
export type ReadMode = "log" | "readindex" | "lease" | "local";

export interface Bugs {
  /** Reads go to a random server, which answers from its own state machine. */
  followerRead?: boolean;
  /** votedFor is not persisted: a restarted server forgets its vote in the current term. */
  forgetVote?: boolean;
  /** A leader commits entries of older terms by counting replicas (Raft paper, Figure 8). The no-op at election is
   *  also off, because a new leader's first AppendEntries would carry its no-op and so hide the bug. */
  oldTermCommit?: boolean;
  /** Writes carry no session tag, so a retried write can apply twice. */
  noDedup?: boolean;
}

export type BugId = keyof Bugs;

export interface StoreConfig {
  servers: number;
  clients: number;
  seed: number;
  /** Model input: one-way network delay in ms, uniform in [min, max]. */
  latency: { min: number; max: number };
  readMode: ReadMode;
  raft: Partial<RaftOptions>;
  bugs: Bugs;
  /** A client retries an operation after this many ms with no answer. */
  clientTimeout: number;
  /** Model input: the largest clock rate error that lease reads assume, e.g. 0.05 for 5%. */
  driftBound: number;
  /** Keep the Raft event list (the UI needs it; the fuzzer does not). */
  record: boolean;
  /** The initial voters (default: every server). Other servers can join by a membership change. */
  voters?: NodeId[];
  /** Lease mode: a restarted server ignores RequestVote for one minimum election timeout (default true). */
  restartGuard?: boolean;
}

export const STORE_DEFAULT: StoreConfig = {
  servers: 3,
  clients: 2,
  seed: 1,
  latency: { min: 5, max: 15 },
  readMode: "readindex",
  raft: {},
  bugs: {},
  clientTimeout: 120,
  driftBound: 0.05,
  record: true,
};

// ---------------------------------------------------------------- operations and history

export type OpKind = "put" | "get" | "del" | "cas";
export interface StoreOp { kind: OpKind; key: string; value?: number; expect?: number }

export interface OpRecord {
  id: number;
  /** Client index (0-based), not the network node. */
  client: number;
  op: StoreOp;
  call: number;
  /** Infinity while the operation has no answer. */
  ret: number;
  tries: number;
  /** The result: the value read or written; for cas, ok and the current value. */
  ok?: boolean;
  value?: number;
  /** The server that answered, and how a read was served. */
  servedBy?: NodeId;
  via?: ReadVia | "log" | "write";
  readIndex?: number;
}

export function opText(o: StoreOp): string {
  if (o.kind === "put") return `put ${o.key}=${o.value}`;
  if (o.kind === "del") return `del ${o.key}`;
  if (o.kind === "cas") return `cas ${o.key} ${o.expect}→${o.value}`;
  return `get ${o.key}`;
}

/** The record as a history operation for the linearizability checker. Unanswered reads are left out. */
export function toHOp(r: OpRecord): HOp | null {
  const done = Number.isFinite(r.ret);
  const base = { id: r.id, client: r.client, key: r.op.key, call: r.call, ret: r.ret };
  if (r.op.kind === "get") return done ? { ...base, f: "r", value: r.value } : null;
  if (r.op.kind === "cas") return { ...base, f: "cas", expect: r.op.expect ?? 0, value: r.op.value!, ok: done ? r.ok : undefined };
  return { ...base, f: "w", value: r.op.kind === "del" ? 0 : r.op.value! };
}

// ---------------------------------------------------------------- the client

export class KvClient {
  seq = 0;
  leaderGuess: NodeId = 0;
  cur: { rec: OpRecord; seq: number } | null = null;
  private queue: StoreOp[] = [];
  readonly rng: Rng;
  /** Called when an operation completes. */
  onDone: ((r: OpRecord) => void) | null = null;
  /** Called for timers that the client does not own (the workload's think time). */
  onTag: ((tag: string) => void) | null = null;

  constructor(private store: KvStore, readonly index: number, readonly node: NodeId) {
    this.rng = mulberry32((store.cfg.seed * 7919 + index * 104729 + 17) >>> 0);
  }
  get busy() {
    return this.cur !== null || this.queue.length > 0;
  }
  submit(op: StoreOp) {
    this.queue.push(op);
    if (!this.cur) this.next();
  }
  private next() {
    const op = this.queue.shift();
    if (!op) return;
    const rec = this.store.newRecord(this.index, op);
    this.cur = { rec, seq: ++this.seq };
    this.send();
  }
  private target(): NodeId {
    const s = this.store;
    if (this.cur!.rec.op.kind === "get" && s.readMode === "local") return Math.floor(this.rng() * s.n);
    return this.leaderGuess;
  }
  private send() {
    const c = this.cur!;
    const s = this.store;
    c.rec.tries++;
    const to = this.target();
    const op = c.rec.op;
    if (op.kind === "get" && s.readMode !== "log") {
      s.sendExt(this.node, to, { type: "Read", client: this.node, seq: c.seq, key: op.key });
    } else {
      const cmd: StoreCmd =
        op.kind === "put" ? { op: "put", key: op.key, value: op.value! }
        : op.kind === "del" ? { op: "del", key: op.key }
        : op.kind === "cas" ? { op: "cas", key: op.key, expect: op.expect ?? 0, value: op.value! }
        : { op: "get", key: op.key };
      s.net.send(this.node, to, { type: "ClientRequest", client: this.node, seq: c.seq, cmd, session: !s.bugs.noDedup });
    }
    s.net.setTimer(this.node, s.cfg.clientTimeout, `kv:${c.seq}:${c.rec.tries}`);
  }
  private finish(from: NodeId, ok: boolean, value: number, via: OpRecord["via"], readIndex?: number) {
    const r = this.cur!.rec;
    r.ret = this.store.now;
    r.ok = ok;
    r.value = value;
    r.servedBy = from;
    r.via = via;
    r.readIndex = readIndex;
    this.cur = null;
    this.onDone?.(r);
    this.next();
  }
  onMessage(msg: Message<RaftMsg<StoreCmd>>) {
    const m = msg.payload as StoreMsg;
    const c = this.cur;
    if (!c) return;
    if (m.type === "ClientReply" && m.seq === c.seq) {
      if (m.ok) {
        const res = m.result as StoreResult | undefined;
        const kind = c.rec.op.kind;
        this.leaderGuess = msg.from;
        return this.finish(msg.from, kind === "cas" ? (res?.ok ?? false) : true, res?.value ?? 0, kind === "get" ? "log" : "write");
      }
      return this.redirect(m.leaderHint, msg.from);
    }
    if (m.type === "ReadReply" && m.seq === c.seq) {
      if (m.ok) {
        if (this.store.readMode !== "local") this.leaderGuess = msg.from;
        return this.finish(msg.from, true, m.value ?? 0, m.via, m.readIndex);
      }
      return this.redirect(m.leaderHint, msg.from);
    }
  }
  /** Not the leader: follow the hint at once, or try the next server after a pause. */
  private redirect(hint: NodeId | null, from: NodeId) {
    const c = this.cur!;
    if (hint !== null && hint !== from && hint < this.store.n) {
      this.leaderGuess = hint;
      this.send();
    } else {
      this.leaderGuess = (this.leaderGuess + 1) % this.store.n;
      this.store.net.setTimer(this.node, 20, `kv:${c.seq}:${c.rec.tries}:retry`);
    }
  }
  onTimer(tag: string) {
    if (!tag.startsWith("kv:")) return void this.onTag?.(tag);
    const [, seq, tries, retry] = tag.split(":");
    const c = this.cur;
    if (!c || Number(seq) !== c.seq || Number(tries) !== c.rec.tries) return;
    if (!retry) this.leaderGuess = (this.leaderGuess + 1) % this.store.n; // no answer: maybe the leader is gone
    this.send();
  }
}

// ---------------------------------------------------------------- the store

interface PendingRead {
  client: NodeId;
  seq: number;
  key: string;
  term: number;
  /** Undefined until the leader has committed an entry of its term. */
  readIndex?: number;
  ctx: number;
  acks: Set<NodeId>;
  confirmed: boolean;
  at: number;
}

/** A clock that runs at `rate` real ms per ms since `t0`, when it read `c0`. */
interface LocalClock { t0: number; c0: number; rate: number }

/** Counters of rare events, for the fuzzer's coverage view. */
export interface StoreCounters {
  readsByLease: number;
  readsByReadIndex: number;
  readsLocal: number;
  readIndexRounds: number;
  leaseFallbacks: number;
  dupSuppressed: number;
  votesDroppedAfterRestart: number;
  pausedEvents: number;
  restarts: number;
  targetedCuts: number;
}

export class KvStore {
  readonly cfg: StoreConfig;
  readonly cluster: RaftCluster<StoreCmd>;
  readonly net: Net<RaftMsg<StoreCmd>>;
  readonly n: number;
  readonly clients: KvClient[] = [];
  readonly ops: OpRecord[] = [];
  readonly readMode: ReadMode;
  readonly bugs: Bugs;
  readonly counters: StoreCounters = { readsByLease: 0, readsByReadIndex: 0, readsLocal: 0, readIndexRounds: 0, leaseFallbacks: 0, dupSuppressed: 0, votesDroppedAfterRestart: 0, pausedEvents: 0, restarts: 0, targetedCuts: 0 };
  /** Faults that the network trace does not show: pauses, loss and delay changes, clock rates. */
  readonly faultLog: { t: number; kind: "pause" | "resume" | "drop" | "delay" | "clock"; node?: NodeId; x?: number }[] = [];
  /** Paused servers and the events that wait for them. */
  readonly paused = new Map<NodeId, (() => void)[]>();
  private reads = new Map<NodeId, PendingRead[]>();
  private restartVoter: number | null = null;
  private isolateNewLeader: { dur: number; term: number } | null = null;
  private crashAfterCommit: { dur: number; base: Map<string, number> } | null = null;
  private cuts = new Map<number, NodeId[]>();
  private nextCut = 1;
  private nextCtx = 1;
  private clocks: LocalClock[];
  private stamps = new Map<number, number>();
  private echoes = new Map<number, { stamp: number; term: number }>();
  private leaseAcks = new Map<NodeId, { term: number; acks: Map<NodeId, number> }>();
  private recoveredAt: number[];
  private scanned = 0;
  private raftMessage: (to: NodeId, m: Message<RaftMsg<StoreCmd>>) => void;
  private raftTimer: (node: NodeId, tag: string) => void;
  private raftRecover: (node: NodeId) => void;

  constructor(cfg: Partial<StoreConfig> = {}) {
    this.cfg = { ...STORE_DEFAULT, ...cfg, latency: { ...STORE_DEFAULT.latency, ...cfg.latency }, bugs: { ...cfg.bugs } };
    this.bugs = this.cfg.bugs;
    this.readMode = this.bugs.followerRead ? "local" : this.cfg.readMode;
    const raft: Partial<RaftOptions> = { ...this.cfg.raft };
    if (this.readMode === "lease") raft.checkQuorum = true;
    if (this.bugs.oldTermCommit) {
      raft.commitCurrentTermOnly = false;
      raft.noopOnElection = false;
    }
    this.cluster = new RaftCluster<StoreCmd>({
      servers: this.cfg.servers,
      voters: this.cfg.voters,
      clients: this.cfg.clients,
      net: { seed: this.cfg.seed, latency: this.cfg.latency },
      raft,
      machine: () => new StoreMachine(),
      record: this.cfg.record,
    });
    this.net = this.cluster.net;
    this.n = this.cfg.servers;
    this.clocks = Array.from({ length: this.n }, () => ({ t0: 0, c0: 0, rate: 1 }));
    this.recoveredAt = new Array<number>(this.n).fill(-Infinity);
    // The cluster's own handlers are private; element access is TypeScript's escape hatch for that.
    const c = this.cluster;
    this.raftMessage = (to, m) => c["onMessage"](to, m);
    this.raftTimer = (node, tag) => c["onTimer"](node, tag);
    this.raftRecover = (node) => c["onRecover"](node);
    this.net.setHandlers({
      onMessage: (to, m) => this.onMessage(to, m),
      onTimer: (node, tag) => this.onTimer(node, tag),
      onRecover: (node) => this.onRecover(node),
    });
    c.onApply((node, e, _r, dup) => {
      if (dup && e.kind === "cmd" && this.cluster.node(node).role === "leader") this.counters.dupSuppressed++;
    });
    for (let k = 0; k < this.cfg.clients; k++) {
      const cl = new KvClient(this, k, this.n + k);
      this.clients.push(cl);
      c.clients.set(this.n + k, cl);
    }
  }

  get now() {
    return this.net.now;
  }
  node(i: NodeId) {
    return this.cluster.node(i);
  }
  machine(i: NodeId) {
    return this.cluster.node(i).machine as StoreMachine;
  }
  leader() {
    return this.cluster.leader();
  }
  isUp(i: NodeId) {
    return this.net.isUp(i);
  }

  // ------------------------------------------------------------ running

  run(ms: number) {
    this.net.runUntil(this.net.now + ms);
  }
  runUntil(t: number) {
    this.net.runUntil(t);
  }
  /** Runs until `pred` holds or `limit` ms pass. */
  runUntilTrue(pred: () => boolean, limit: number, every = 2): boolean {
    const end = this.now + limit;
    while (this.now < end) {
      if (pred()) return true;
      this.net.runUntil(Math.min(end, this.now + every));
    }
    return pred();
  }
  /** Runs until a leader has committed an entry of its term (or `limit` ms pass). */
  settle(limit = 2000): boolean {
    return this.runUntilTrue(() => {
      const l = this.leader();
      if (l === null) return false;
      const nd = this.node(l);
      return nd.termAt(nd.commitIndex) === nd.currentTerm || (!this.cluster.opts.noopOnElection && nd.commitIndex === nd.lastIndex);
    }, limit);
  }

  newRecord(client: number, op: StoreOp): OpRecord {
    const r: OpRecord = { id: this.ops.length, client, op, call: this.now, ret: Infinity, tries: 0 };
    this.ops.push(r);
    return r;
  }

  /** Sends a store message on the Raft network. */
  sendExt(from: NodeId, to: NodeId, m: ExtMsg) {
    return this.net.send(from, to, m as unknown as RaftMsg<StoreCmd>);
  }

  // ------------------------------------------------------------ faults

  crash(i: NodeId) {
    this.scan();
    this.paused.delete(i);
    this.reads.delete(i);
    this.leaseAcks.delete(i);
    this.cluster.crash(i);
  }
  recover(i: NodeId) {
    this.cluster.recover(i);
  }
  /** Splits the servers. Clients stay connected to every server. */
  partition(groups: NodeId[][]) {
    const cl = this.clients.map((c) => c.node);
    this.cluster.partition(groups.map((g) => [...g, ...cl]));
  }
  heal() {
    this.cuts.clear();
    this.cluster.heal();
  }
  /** Adds a cut that separates `side` from the other servers. Cuts add up. Returns an id for removeCut. */
  addCut(side: NodeId[]): number {
    const id = this.nextCut++;
    this.cuts.set(id, side);
    this.applyCuts();
    return id;
  }
  removeCut(id: number) {
    if (this.cuts.delete(id)) this.applyCuts();
  }
  activeCuts(): NodeId[][] {
    return [...this.cuts.values()];
  }
  private applyCuts() {
    if (this.cuts.size) this.partition(groupsFromCuts(this.n, [...this.cuts.values()]));
    else this.cluster.heal();
  }
  /** A targeted fault: the next time a leader advances its commit index, it crashes at once, for `dur` ms. */
  armCrashAfterCommit(dur: number | null) {
    this.crashAfterCommit = dur === null ? null : { dur, base: new Map() };
    this.after();
  }
  /** A targeted fault: the next leader that appends an entry of its own term is cut off at once, for `dur` ms. */
  armIsolateNewLeader(dur: number | null) {
    this.isolateNewLeader = dur === null ? null : { dur, term: Math.max(...this.cluster.nodes.map((x) => x.currentTerm)) };
  }
  /** A process pause (a long GC, a stopped VM): the server runs nothing until resume, then catches up. */
  pause(i: NodeId) {
    if (this.isUp(i) && !this.paused.has(i)) {
      this.paused.set(i, []);
      this.faultLog.push({ t: this.now, kind: "pause", node: i });
    }
  }
  resume(i: NodeId) {
    const q = this.paused.get(i);
    if (!q) return;
    this.paused.delete(i);
    this.faultLog.push({ t: this.now, kind: "resume", node: i });
    for (const f of q) {
      if (!this.isUp(i) || this.paused.has(i)) break;
      f();
    }
    this.after();
  }
  /** A targeted fault, as FoundationDB's BUGGIFY places faults at chosen code points: the next server that grants a
   *  vote restarts at once (its reply is already sent) and is back after `dur` ms. */
  armRestartVoter(dur: number | null) {
    this.restartVoter = dur;
  }
  /** Crash now, recover after `dur` ms (a timer on a client node, which never crashes). */
  restartAfter(i: NodeId, dur: number) {
    this.crash(i);
    this.counters.restarts++;
    this.net.setTimer(this.n, dur, `store:recover:${i}`);
  }
  setDropRate(p: number) {
    if (p !== this.net.cfg.dropRate) this.faultLog.push({ t: this.now, kind: "drop", x: p });
    this.net.cfg.dropRate = p;
  }
  setMaxLatency(ms: number) {
    if (ms !== this.net.cfg.latency.max) this.faultLog.push({ t: this.now, kind: "delay", x: ms });
    this.net.cfg.latency.max = Math.max(this.net.cfg.latency.min, ms);
  }
  /** Sets server i's clock rate: 1 is exact, 0.5 runs at half speed. */
  setClockRate(i: NodeId, rate: number) {
    this.scan();
    if (rate !== this.clocks[i]!.rate) this.faultLog.push({ t: this.now, kind: "clock", node: i, x: rate });
    this.clocks[i] = { t0: this.now, c0: this.localTime(i), rate };
  }
  clockRate(i: NodeId) {
    return this.clocks[i]!.rate;
  }
  /** Server i's local clock at real time t (t must not be before the last rate change). */
  localTime(i: NodeId, t = this.now) {
    const c = this.clocks[i]!;
    return c.c0 + (t - c.t0) * c.rate;
  }

  // ------------------------------------------------------------ inspection

  /** The lease of a leader: its end on the leader's clock, or null. */
  leaseEnd(i: NodeId): number | null {
    const nd = this.node(i);
    const st = this.leaseAcks.get(i);
    if (nd.role !== "leader" || !st || st.term !== nd.currentTerm) return null;
    const stamps = [...st.acks.values()].sort((a, b) => b - a);
    for (const s of stamps) if (hasQuorum(nd.config, (id) => id === i || (st.acks.get(id) ?? -Infinity) >= s)) return s + this.leaseMs;
    return null;
  }
  get leaseMs() {
    return this.cluster.opts.electionTimeout.min * (1 - this.cfg.driftBound);
  }
  leaseValid(i: NodeId) {
    const e = this.leaseEnd(i);
    return e !== null && this.localTime(i) < e;
  }
  /** Reads that wait on server i. */
  pendingReads(i: NodeId): readonly PendingRead[] {
    return this.reads.get(i) ?? [];
  }
  /** The history for the checker. */
  history(): HOp[] {
    return this.ops.map(toHOp).filter((h): h is HOp => h !== null);
  }
  /** The committed checker, key by key. `maxStates` bounds the search (null result: budget hit). */
  check(maxStates?: number): LinResult & { parts: number } {
    return checkRegister(this.history(), { maxStates });
  }
  /** Raft safety violations, including Log Matching checked now. */
  raftViolations() {
    this.cluster.checkLogMatching();
    // The monitor checks Leader Completeness only for leaders of later terms than the commit (see SafetyMonitor).
    return this.cluster.violations;
  }

  // ------------------------------------------------------------ the wrapped handlers

  private onMessage(to: NodeId, m: Message<RaftMsg<StoreCmd>>) {
    if (to < this.n && this.paused.has(to)) {
      this.counters.pausedEvents++;
      this.paused.get(to)!.push(() => this.dispatch(to, m));
      return;
    }
    this.dispatch(to, m);
    this.after();
  }

  private onTimer(node: NodeId, tag: string) {
    if (tag.startsWith("store:uncut:")) {
      this.removeCut(Number(tag.slice(12)));
      return void this.after();
    }
    if (tag.startsWith("store:recover:")) {
      this.recover(Number(tag.slice(14)));
      return void this.after();
    }
    if (node < this.n && this.paused.has(node)) {
      this.counters.pausedEvents++;
      const inc = this.node(node).incarnation;
      this.paused.get(node)!.push(() => {
        if (this.node(node).incarnation === inc) this.raftTimer(node, tag);
      });
      return;
    }
    this.raftTimer(node, tag);
    this.after();
  }

  private onRecover(node: NodeId) {
    this.raftRecover(node);
    if (node >= this.n) return;
    this.recoveredAt[node] = this.now;
    this.reads.delete(node);
    this.leaseAcks.delete(node);
    if (this.bugs.forgetVote) this.node(node).votedFor = null; // the bug: votedFor was never written to disk
  }

  private dispatch(to: NodeId, m: Message<RaftMsg<StoreCmd>>) {
    const p = m.payload as StoreMsg;
    if (to >= this.n) return void this.raftMessage(to, m); // a client
    switch (p.type) {
      case "Read": return this.onRead(to, p, m.from);
      case "RiPing": return void this.sendExt(to, m.from, { type: "RiAck", term: this.node(to).currentTerm, ctx: p.ctx });
      case "RiAck": return this.onRiAck(to, p, m.from);
      case "ReadReply": return;
    }
    if (p.type === "RequestVote" && this.readMode === "lease" && this.cfg.restartGuard !== false && this.now - this.recoveredAt[to]! < this.cluster.opts.electionTimeout.min) {
      this.counters.votesDroppedAfterRestart++;
      return; // a restarted server cannot know which lease it promised, so it waits
    }
    if (p.type === "AppendEntriesReply") this.onAeReply(to, m);
    const before = this.net.messages.length;
    this.raftMessage(to, m);
    if (p.type === "RequestVote" && !p.preVote && this.restartVoter !== null) {
      for (let k = before; k < this.net.messages.length; k++) {
        const r = this.net.messages[k]!.payload;
        if (r.type === "RequestVoteReply" && r.voteGranted && !r.preVote) {
          const dur = this.restartVoter;
          this.restartVoter = null;
          this.restartAfter(to, dur);
          break;
        }
      }
    }
    if (p.type === "AppendEntries") {
      // Echo the leader's stamp in the reply, as a heartbeat context would.
      const stamp = this.stamps.get(m.dupOf ?? m.id);
      if (stamp !== undefined) {
        for (let k = before; k < this.net.messages.length; k++) {
          const r = this.net.messages[k]!;
          if (r.from === to && r.to === m.from && r.payload.type === "AppendEntriesReply") this.echoes.set(r.id, { stamp, term: p.term });
        }
      }
    }
  }

  private onAeReply(to: NodeId, m: Message<RaftMsg<StoreCmd>>) {
    const p = m.payload as Extract<RaftMsg<StoreCmd>, { type: "AppendEntriesReply" }>;
    const e = this.echoes.get(m.dupOf ?? m.id);
    const nd = this.node(to);
    if (!e || nd.role !== "leader" || e.term !== nd.currentTerm || p.term !== e.term) return;
    let st = this.leaseAcks.get(to);
    if (!st || st.term !== nd.currentTerm) this.leaseAcks.set(to, (st = { term: nd.currentTerm, acks: new Map() }));
    st.acks.set(m.from, Math.max(st.acks.get(m.from) ?? -Infinity, e.stamp));
  }

  private onRead(at: NodeId, p: Extract<ExtMsg, { type: "Read" }>, from: NodeId) {
    const nd = this.node(at);
    const reply = (ok: boolean, extra: Partial<Extract<ExtMsg, { type: "ReadReply" }>> = {}) =>
      this.sendExt(at, from, { type: "ReadReply", client: p.client, seq: p.seq, ok, leaderHint: ok ? at : nd.leaderId, ...extra });
    if (this.readMode === "local") {
      this.counters.readsLocal++;
      return void reply(true, { value: this.machine(at).get(p.key), via: "local" });
    }
    if (nd.role !== "leader") return void reply(false);
    const termCommitted = nd.termAt(nd.commitIndex) === nd.currentTerm;
    if (this.readMode === "lease") {
      if (termCommitted && this.leaseValid(at)) {
        this.counters.readsByLease++;
        return void reply(true, { value: this.machine(at).get(p.key), via: "lease", readIndex: nd.commitIndex });
      }
      this.counters.leaseFallbacks++;
    }
    const r: PendingRead = { client: p.client, seq: p.seq, key: p.key, term: nd.currentTerm, ctx: this.nextCtx++, acks: new Set(), confirmed: false, at: this.now };
    if (!this.reads.has(at)) this.reads.set(at, []);
    this.reads.get(at)!.push(r);
    if (termCommitted) this.startRound(at, r);
  }

  /** ReadIndex step 1 and 2: note the commit index, then ask every voter to confirm the term. */
  private startRound(at: NodeId, r: PendingRead) {
    const nd = this.node(at);
    r.readIndex = nd.commitIndex;
    this.counters.readIndexRounds++;
    for (const v of votersOf(nd.config)) if (v !== at) this.sendExt(at, v, { type: "RiPing", term: r.term, ctx: r.ctx });
    r.confirmed = hasQuorum(nd.config, (id) => id === at);
  }

  private onRiAck(at: NodeId, p: Extract<ExtMsg, { type: "RiAck" }>, from: NodeId) {
    const r = this.reads.get(at)?.find((x) => x.ctx === p.ctx);
    if (!r || p.term !== r.term) return;
    r.acks.add(from);
    r.confirmed ||= hasQuorum(this.node(at).config, (id) => id === at || r.acks.has(id));
  }

  /** Runs after every event: stamps new AppendEntries and moves waiting reads forward. */
  private after() {
    this.scan();
    const cac = this.crashAfterCommit;
    if (cac) {
      for (const nd of this.cluster.nodes) {
        if (nd.role !== "leader" || !this.isUp(nd.id)) continue;
        const k = `${nd.id}:${nd.currentTerm}`;
        const b = cac.base.get(k);
        if (b === undefined) cac.base.set(k, nd.commitIndex);
        else if (nd.commitIndex > b) {
          this.crashAfterCommit = null;
          this.restartAfter(nd.id, cac.dur);
          break;
        }
      }
    }
    const iso = this.isolateNewLeader;
    if (iso) {
      const l = this.leader();
      const nd = l === null ? null : this.node(l);
      if (nd && nd.currentTerm > iso.term && nd.lastTerm === nd.currentTerm && nd.lastIndex > nd.commitIndex) {
        this.isolateNewLeader = null;
        this.counters.targetedCuts++;
        const id = this.addCut([l!]);
        this.net.setTimer(this.n, iso.dur, `store:uncut:${id}`);
      }
    }
    for (const [at, list] of this.reads) {
      if (!list.length || this.paused.has(at) || !this.isUp(at)) continue;
      const nd = this.node(at);
      const keep: PendingRead[] = [];
      for (const r of list) {
        const reply = (ok: boolean, value?: number) =>
          this.sendExt(at, r.client, { type: "ReadReply", client: r.client, seq: r.seq, ok, value, leaderHint: ok ? at : nd.leaderId, via: "readindex", readIndex: r.readIndex });
        if (nd.role !== "leader" || nd.currentTerm !== r.term) { reply(false); continue; }
        // A new leader first commits an entry of its own term (its no-op). Only then is its commit index current.
        if (r.readIndex === undefined && nd.termAt(nd.commitIndex) === nd.currentTerm) this.startRound(at, r);
        // Step 3: wait until the state machine has applied the read index. Then step 4: answer.
        if (r.readIndex !== undefined && r.confirmed && nd.lastApplied >= r.readIndex) {
          this.counters.readsByReadIndex++;
          reply(true, this.machine(at).get(r.key));
          continue;
        }
        if (this.now - r.at < 4 * this.cfg.clientTimeout) keep.push(r); // else the client has long given up
      }
      this.reads.set(at, keep);
    }
  }

  /** Stamps every AppendEntries sent since the last scan with its sender's clock at the send time. */
  private scan() {
    const ms = this.net.messages;
    for (; this.scanned < ms.length; this.scanned++) {
      const m = ms[this.scanned]!;
      if (m.from < this.n && m.payload.type === "AppendEntries" && m.dupOf === undefined) this.stamps.set(m.id, this.localTime(m.from, m.sentAt));
    }
  }

  // ------------------------------------------------------------ control for the playground

  propose(cmd: StoreCmd) {
    const l = this.leader();
    if (l === null) return null;
    const r = this.cluster.propose(l, cmd);
    this.scan();
    return r;
  }
  snapshotNow(i: NodeId) {
    this.cluster.snapshotNow(i);
  }
  changeConfig(voters: NodeId[], learners: NodeId[] = []) {
    const l = this.leader();
    if (l === null) return { ok: false, reason: "no leader" };
    const r = this.cluster.changeConfig(l, { voters, learners }, "single");
    this.scan();
    return r;
  }
}

/** Server groups from a set of cuts: two servers share a group if no cut separates them. */
export function groupsFromCuts(n: number, cuts: NodeId[][]): NodeId[][] {
  const sig = (i: NodeId) => cuts.map((c) => (c.includes(i) ? 1 : 0)).join("");
  const by = new Map<string, NodeId[]>();
  for (let i = 0; i < n; i++) {
    const k = sig(i);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(i);
  }
  return [...by.values()];
}

/** A short label for any message of the store, for space-time diagrams. Heartbeats get "". */
export function storeMsgLabel(p: StoreMsg): string {
  switch (p.type) {
    case "Read": return `read ${p.key}`;
    case "ReadReply": return p.ok ? `=${p.value}` : "retry";
    case "RiPing": return "RI?";
    case "RiAck": return "";
    case "RequestVote": return `${p.preVote ? "pre" : "RV"} t${p.term}`;
    case "RequestVoteReply": return p.voteGranted ? "" : "no";
    case "AppendEntries": return p.entries.length ? `AE ${p.entries.length === 1 ? p.entries[0]!.index : `${p.entries[0]!.index}–${p.entries.at(-1)!.index}`}` : "";
    case "AppendEntriesReply": return p.success ? "" : "reject";
    case "InstallSnapshot": return `snap ${p.offset}`;
    case "InstallSnapshotReply": return "";
    case "TimeoutNow": return "TimeoutNow";
    case "ClientRequest": return cmdText(p.cmd);
    case "ClientReply": return p.ok ? "ok" : "retry";
  }
}
