/**
 * Two-phase commit (2PC) on the shared network, with durable logs, crashes and recovery.
 *
 * Node 0 is the coordinator. Nodes 1..n are participants. One transaction runs. Each participant has done its
 * writes and holds its locks when the run starts.
 *
 * - Phase 1: the coordinator sends PREPARE. A participant that can commit forces a `prepared` record to its log,
 *   and only then votes YES. From that moment it is **in doubt**: it may not commit or abort on its own, and it keeps
 *   its locks. A participant that cannot commit votes NO and aborts.
 * - Phase 2: if every vote is YES, the coordinator forces a `commit` record (this is the commit point) and sends
 *   COMMIT. Otherwise it decides abort. Participants log the outcome, release their locks and send ACK.
 * - Recovery: a node keeps only its log. A recovered participant with `prepared` and no outcome is in doubt again.
 *   A recovered coordinator resends the outcome in its log. With no record it answers ABORT (the presumption).
 * - An in-doubt participant asks the coordinator again every `retry` ms (QUERY). With `cooperative`, it also asks
 *   the other participants (the cooperative termination protocol); one that knows the outcome, or that has not yet
 *   voted and so can still abort, answers.
 *
 * Two logging modes, after Mohan, Lindsay and Obermarck (R*, ACM TODS 1986):
 * - "basic": every outcome record is forced, and participants ACK both outcomes.
 * - "pa" (presumed abort): an abort is not forced and not acknowledged, because "no record" already means abort.
 *   A participant with no writes votes READ-ONLY, writes nothing and leaves phase 2.
 *
 * A forced record is durable at once. An unforced record waits in a buffer, which a later forced write flushes; a
 * crash loses the buffer. Timers of a node die with it: a timer set before a crash never fires after recovery.
 */
import { Net, type Message, type NetConfig, type NodeId } from "../net";

export type TpcMode = "basic" | "pa";
export type Outcome = "commit" | "abort";
/** What a participant answers in phase 1. "ro" (read-only) exists only under presumed abort. */
export type Vote = "yes" | "no" | "ro";
export type PState = "working" | "prepared" | "committed" | "aborted" | "readonly";
export type CState = "idle" | "collecting" | "committed" | "aborted" | "done";

export type RecKind = "prepared" | "commit" | "abort" | "end";
export interface LogRec {
  rec: RecKind;
  forced: boolean;
  t: number;
  /** In the coordinator's commit or abort record: the participants that must hear the outcome. */
  who?: number[];
}

export type TpcMsg =
  | { k: "prepare" }
  | { k: "vote"; vote: Vote }
  | { k: "commit" }
  | { k: "abort" }
  | { k: "ack" }
  | { k: "query" };

export const tpcLabel = (p: TpcMsg) => (p.k === "vote" ? (p.vote === "ro" ? "READ-ONLY" : p.vote.toUpperCase()) : p.k.toUpperCase());

export interface TpcCfg {
  participants: number;
  mode: TpcMode;
  /** One vote per participant. Default: all YES. */
  votes?: Vote[];
  cooperative: boolean;
  /** The coordinator aborts if a vote is missing after this many ms. */
  voteTimeout: number;
  /** A participant that is still working after this many ms (no PREPARE came) aborts on its own. */
  workTimeout: number;
  /** An in-doubt participant asks for the outcome this often (ms). */
  retry: number;
  net: Partial<NetConfig>;
}

export const DEFAULT_TPC: TpcCfg = {
  participants: 2, mode: "pa", cooperative: false, voteTimeout: 150, workTimeout: 400, retry: 100,
  net: { seed: 1, latency: { min: 5, max: 15 } },
};

interface NodeLog {
  /** Durable records. */
  log: LogRec[];
  /** Unforced records that a crash would lose. */
  buffer: LogRec[];
  forcedWrites: number;
}

export interface Participant extends NodeLog {
  id: NodeId;
  state: PState;
  locks: boolean;
  /** When it first entered the in-doubt state, and when it first learned the outcome. */
  preparedAt?: number;
  decidedAt?: number;
  /** Each in-doubt interval [from, to): a crash and recovery can make several. */
  doubt: { from: number; to?: number }[];
}

export interface Coordinator extends NodeLog {
  state: CState;
  votes: Map<NodeId, Vote>;
  acks: Set<NodeId>;
  decidedAt?: number;
}

export class TwoPc {
  readonly cfg: TpcCfg;
  readonly net: Net<TpcMsg>;
  readonly coord: Coordinator;
  readonly parts: Participant[];
  /** Breaks of atomicity: two participants learned different outcomes, or one learned both. */
  readonly violations: string[] = [];
  /** Called when the coordinator logs its decision (a test or a sweep can crash it there). */
  onDecision?: (o: Outcome) => void;
  private epoch: number[];

  constructor(cfg: Partial<TpcCfg> = {}) {
    this.cfg = { ...DEFAULT_TPC, ...cfg, net: { ...DEFAULT_TPC.net, ...cfg.net } };
    const n = this.cfg.participants;
    this.net = new Net<TpcMsg>(n + 1, this.cfg.net, {
      onMessage: (to, m) => (to === 0 ? this.coordMsg(m) : this.partMsg(to, m)),
      onTimer: (node, tag) => this.timer(node, tag),
      onRecover: (node) => (node === 0 ? this.coordRecover() : this.partRecover(node)),
    });
    this.epoch = new Array<number>(n + 1).fill(0);
    this.coord = { state: "idle", votes: new Map(), acks: new Set(), log: [], buffer: [], forcedWrites: 0 };
    this.parts = Array.from({ length: n }, (_, i) => ({ id: i + 1, state: "working" as PState, locks: true, doubt: [], log: [], buffer: [], forcedWrites: 0 }));
    for (const p of this.parts) this.setTimer(p.id, this.cfg.workTimeout, "work");
  }

  vote(i: NodeId): Vote {
    const v = this.cfg.votes?.[i - 1] ?? "yes";
    return v === "ro" && this.cfg.mode !== "pa" ? "yes" : v;
  }
  part(i: NodeId) {
    return this.parts[i - 1]!;
  }

  /** The coordinator starts phase 1. */
  start() {
    if (!this.net.isUp(0) || this.coord.state !== "idle") return;
    this.coord.state = "collecting";
    for (const p of this.parts) this.net.send(0, p.id, { k: "prepare" });
    this.setTimer(0, this.cfg.voteTimeout, "votes");
  }

  crash(i: NodeId) {
    if (!this.net.isUp(i)) return;
    const nd = i === 0 ? this.coord : this.part(i);
    nd.buffer = [];
    this.epoch[i]!++;
    if (i !== 0) {
      const p = this.part(i);
      const d = p.doubt[p.doubt.length - 1];
      if (d && d.to === undefined) d.to = this.net.now;
    }
    this.net.crash(i);
  }

  recover(i: NodeId) {
    if (!this.net.isUp(i)) this.net.recover(i);
  }

  // ---------------------------------------------------------------- logs and timers

  private write(nd: NodeLog, rec: Omit<LogRec, "t" | "forced">, forced: boolean) {
    const r: LogRec = { ...rec, forced, t: this.net.now };
    if (forced) {
      nd.log.push(...nd.buffer, r);
      nd.buffer = [];
      nd.forcedWrites++;
    } else nd.buffer.push(r);
  }

  private setTimer(node: NodeId, delay: number, tag: string) {
    this.net.setTimer(node, delay, `${tag}#${this.epoch[node]}`);
  }

  private timer(node: NodeId, tagged: string) {
    const [tag, ep] = tagged.split("#");
    if (Number(ep) !== this.epoch[node]) return; // set before a crash: it died with the node
    if (node === 0) {
      if (tag === "votes" && this.coord.state === "collecting") this.decide("abort");
      return;
    }
    const p = this.part(node);
    if (tag === "work" && p.state === "working") this.partAbort(p, false);
    if (tag === "query" && p.state === "prepared") {
      this.net.send(node, 0, { k: "query" });
      if (this.cfg.cooperative) for (const q of this.parts) if (q.id !== node) this.net.send(node, q.id, { k: "query" });
      this.setTimer(node, this.cfg.retry, "query");
    }
  }

  // ---------------------------------------------------------------- coordinator

  private coordMsg(m: Message<TpcMsg>) {
    const c = this.coord, p = m.payload;
    if (p.k === "vote") {
      if (c.state !== "collecting") return;
      c.votes.set(m.from, p.vote);
      if (p.vote === "no") return this.decide("abort");
      if (c.votes.size === this.parts.length) this.decide("commit");
    } else if (p.k === "ack") {
      if (c.state !== "committed" && c.state !== "aborted") return;
      c.acks.add(m.from);
      const who = this.outcomeRec()?.who ?? [];
      if (who.every((w) => c.acks.has(w))) {
        this.write(c, { rec: "end" }, false);
        c.state = "done";
      }
    } else if (p.k === "query") {
      const o = this.coordOutcome();
      if (o) this.net.send(0, m.from, { k: o });
    }
  }

  /** The outcome the coordinator gives to a QUERY: its decision, or abort if it has none (the presumption). */
  private coordOutcome(): Outcome | null {
    const c = this.coord;
    if (c.state === "collecting") return null; // still deciding: no answer yet
    const rec = this.outcomeRec();
    if (rec) return rec.rec as Outcome;
    if (c.state === "committed") return "commit";
    return "abort";
  }

  private outcomeRec(): LogRec | undefined {
    return [...this.coord.log, ...this.coord.buffer].find((r) => r.rec === "commit" || r.rec === "abort");
  }

  private decide(o: Outcome) {
    const c = this.coord;
    if (c.state !== "collecting") return;
    const yes = [...c.votes].filter(([, v]) => v === "yes").map(([id]) => id);
    if (o === "commit") {
      if (yes.length === 0) {
        // Every participant was read-only: nothing to commit, nothing to log.
        c.state = "done";
        c.decidedAt = this.net.now;
        return;
      }
      this.write(c, { rec: "commit", who: yes }, true);
      c.state = "committed";
    } else {
      // Tell everyone that did not vote NO or READ-ONLY. Under basic 2PC they must ACK, so the record names them.
      const who = this.parts.map((q) => q.id).filter((id) => c.votes.get(id) !== "no" && c.votes.get(id) !== "ro");
      this.write(c, { rec: "abort", who: this.cfg.mode === "basic" ? who : [] }, this.cfg.mode === "basic");
      c.state = "aborted";
      for (const id of who) this.net.send(0, id, { k: "abort" });
      c.decidedAt = this.net.now;
      this.onDecision?.(o);
      if (this.cfg.mode === "pa" || who.length === 0) {
        if (this.cfg.mode === "basic") this.write(c, { rec: "end" }, false);
        c.state = "done";
      }
      return;
    }
    c.decidedAt = this.net.now;
    this.onDecision?.(o);
    if (!this.net.isUp(0)) return; // crashed at the commit point, before it sent anything
    for (const id of yes) this.net.send(0, id, { k: "commit" });
  }

  private coordRecover() {
    const c = this.coord;
    c.votes = new Map();
    c.acks = new Set();
    const rec = this.outcomeRec();
    const ended = c.log.some((r) => r.rec === "end");
    if (!rec) {
      // No decision in the log: it was still collecting votes, or its abort was not forced. Presume abort.
      c.state = "done";
      return;
    }
    if (ended || !rec.who?.length) {
      c.state = "done";
      return;
    }
    c.state = rec.rec === "commit" ? "committed" : "aborted";
    for (const id of rec.who ?? []) this.net.send(0, id, { k: rec.rec as Outcome });
  }

  // ---------------------------------------------------------------- participants

  private partMsg(i: NodeId, m: Message<TpcMsg>) {
    const p = this.part(i), msg = m.payload;
    if (msg.k === "prepare") {
      if (p.state === "working") {
        const v = this.vote(i);
        if (v === "yes") {
          this.write(p, { rec: "prepared" }, true);
          p.state = "prepared";
          p.preparedAt ??= this.net.now;
          p.doubt.push({ from: this.net.now });
          this.setTimer(i, this.cfg.retry, "query");
        } else if (v === "ro") {
          p.state = "readonly";
          p.locks = false;
          p.decidedAt = this.net.now;
        } else this.partAbort(p, false);
        this.net.send(i, 0, { k: "vote", vote: v });
      } else if (p.state === "prepared") this.net.send(i, 0, { k: "vote", vote: "yes" });
      else if (p.state === "aborted") this.net.send(i, 0, { k: "vote", vote: "no" });
      else if (p.state === "readonly") this.net.send(i, 0, { k: "vote", vote: "ro" });
    } else if (msg.k === "commit") {
      if (p.state === "aborted") this.violations.push(`t=${this.net.now}: P${i} aborted, then got COMMIT`);
      if (p.state === "prepared") {
        this.write(p, { rec: "commit" }, true);
        this.learn(p, "commit");
      }
      if (p.state === "committed") this.net.send(i, 0, { k: "ack" });
    } else if (msg.k === "abort") {
      if (p.state === "committed") this.violations.push(`t=${this.net.now}: P${i} committed, then got ABORT`);
      if (p.state === "prepared" || p.state === "working") this.partAbort(p, this.cfg.mode === "basic");
      if (p.state === "aborted" && this.cfg.mode === "basic" && m.from === 0) this.net.send(i, 0, { k: "ack" });
    } else if (msg.k === "query" && m.from !== 0) {
      // A peer asks (cooperative termination). A participant that has not voted can still abort, and say so.
      if (p.state === "working") this.partAbort(p, false);
      if (p.state === "committed") this.net.send(i, m.from, { k: "commit" });
      if (p.state === "aborted") this.net.send(i, m.from, { k: "abort" });
    }
  }

  private partAbort(p: Participant, forced: boolean) {
    this.write(p, { rec: "abort" }, forced);
    this.learn(p, "abort");
  }

  private learn(p: Participant, o: Outcome) {
    p.state = o === "commit" ? "committed" : "aborted";
    p.locks = false;
    p.decidedAt ??= this.net.now;
    const d = p.doubt[p.doubt.length - 1];
    if (d && d.to === undefined) d.to = this.net.now;
    this.checkAtomic();
  }

  private partRecover(i: NodeId) {
    const p = this.part(i);
    const outcome = p.log.find((r) => r.rec === "commit" || r.rec === "abort");
    const prepared = p.log.some((r) => r.rec === "prepared");
    if (outcome) {
      p.state = outcome.rec === "commit" ? "committed" : "aborted";
      p.locks = false;
    } else if (prepared) {
      // In doubt again: take the locks back and ask.
      p.state = "prepared";
      p.locks = true;
      p.doubt.push({ from: this.net.now });
      this.setTimer(i, 1, "query");
    } else if (this.vote(i) === "ro") {
      // A read-only participant has nothing to lose or to finish.
      p.state = "readonly";
      p.locks = false;
    } else {
      // Its work was in memory only, so it is gone: the transaction aborts here.
      p.state = "aborted";
      p.locks = false;
      p.decidedAt ??= this.net.now;
    }
  }

  private checkAtomic() {
    const writers = this.parts.filter((q) => this.vote(q.id) !== "ro");
    const c = writers.some((q) => q.state === "committed"), a = writers.some((q) => q.state === "aborted");
    if (c && a) this.violations.push(`t=${this.net.now}: one participant committed and another aborted`);
  }

  // ---------------------------------------------------------------- read-outs

  /** True when every participant knows the outcome (or left as read-only). */
  allDecided() {
    return this.parts.every((p) => p.state === "committed" || p.state === "aborted" || p.state === "readonly");
  }
  /** The longest in-doubt time of any participant, counting a still-open interval up to now. */
  maxInDoubt() {
    let m = 0;
    for (const p of this.parts) for (const d of p.doubt) m = Math.max(m, (d.to ?? this.net.now) - d.from);
    return m;
  }
  /** Total in-doubt time of a participant, over all its intervals. */
  inDoubtOf(i: NodeId) {
    return this.part(i).doubt.reduce((a, d) => a + ((d.to ?? this.net.now) - d.from), 0);
  }
}

// ============================================================================ the stepper: the learner is the network

export type TpcAction =
  | { a: "deliver"; id: number }
  | { a: "drop"; id: number }
  | { a: "crash"; node: NodeId }
  | { a: "recover"; node: NodeId }
  | { a: "wait"; ms: number };

/** Each delivery takes this long on the diagram, so that the learner's choices show in order. */
export const STEP_MS = 10;

/** Replays the learner's actions from the start. The same actions give the same state, so Back is a pop. */
export function replayTpc(cfg: Partial<TpcCfg>, actions: TpcAction[]): TwoPc {
  const x = new TwoPc(cfg);
  x.net.hold = true;
  x.start();
  for (const act of actions) {
    if (act.a === "deliver" || act.a === "drop") {
      x.net.runUntil(x.net.now + STEP_MS - 1);
      if (act.a === "deliver") x.net.deliverHeld(act.id);
      else x.net.dropHeld(act.id);
    } else if (act.a === "crash") x.crash(act.node);
    else if (act.a === "recover") x.recover(act.node);
    else x.net.runUntil(x.net.now + act.ms);
  }
  return x;
}

// ============================================================================ counting log forces and messages

export interface TpcCost {
  coordForced: number;
  partForced: number;
  /** All records written by participants, forced or not. */
  partRecords: number;
  messages: number;
  outcome: Outcome;
}

/** Runs one failure-free transaction and counts forced log writes and messages (the R* comparison). */
export function tpcCost(mode: TpcMode, votes: Vote[]): TpcCost {
  const x = new TwoPc({ mode, participants: votes.length, votes, net: { seed: 3, latency: { min: 5, max: 5 } } });
  x.start();
  x.net.runUntil(1000);
  const c = x.parts.every((p) => p.state === "committed" || p.state === "readonly");
  return {
    coordForced: x.coord.forcedWrites,
    partForced: x.parts.reduce((a, p) => a + p.forcedWrites, 0),
    partRecords: x.parts.reduce((a, p) => a + p.log.length + p.buffer.length, 0),
    messages: x.net.messages.length,
    outcome: c ? "commit" : "abort",
  };
}

// ============================================================================ in-doubt time against coordinator recovery

export interface InDoubtCfg {
  /** ms from the coordinator's crash to its recovery. */
  recoverAfter: number;
  retry: number;
  cooperative: boolean;
  seed: number;
}

/**
 * The blocking case: the coordinator crashes at the commit point, right after it forced its commit record and
 * before it sent COMMIT. Every participant is prepared, so none of them knows the outcome, and cooperative
 * termination cannot help. Returns the longest time a participant held its locks in doubt.
 */
export function inDoubtRun(c: InDoubtCfg): { inDoubt: number; decided: boolean; violations: number } {
  const x = new TwoPc({ participants: 3, mode: "pa", retry: c.retry, cooperative: c.cooperative, workTimeout: 1e9, net: { seed: c.seed, latency: { min: 5, max: 15 } } });
  let crashedAt = -1;
  x.onDecision = () => {
    x.crash(0);
    crashedAt = x.net.now;
  };
  x.start();
  while (crashedAt < 0 && x.net.now < 1000) x.net.runUntil(x.net.now + 1);
  x.net.runUntil(crashedAt + c.recoverAfter);
  x.recover(0);
  const end = x.net.now + 5 * c.retry + 200;
  while (!x.allDecided() && x.net.now < end) x.net.runUntil(x.net.now + 5);
  return { inDoubt: x.maxInDoubt(), decided: x.allDecided(), violations: x.violations.length };
}
