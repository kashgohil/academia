/**
 * Single-decree Paxos, after Lamport's "Paxos Made Simple" (2001).
 *
 * Nodes 0..np-1 are proposers, and nodes np..np+na-1 are acceptors. A ballot number is unique to its proposer:
 * ballot = round × 8 + proposer, shown as "round.proposer" with proposers counted from 1.
 *
 *   Phase 1a  proposer → acceptors   prepare(b)
 *   Phase 1b  acceptor → proposer    promise(b, highest accepted (b', v')), if b ≥ every ballot it promised; else nack
 *   Phase 2a  proposer → acceptors   accept(b, v): v is the value of the highest b' among a majority of promises,
 *                                    or the proposer's own value if none of them accepted anything
 *   Phase 2b  acceptor → proposer    accepted(b, v), if b ≥ its promise; else nack
 *
 * A value is chosen when a majority of acceptors accepted the same ballot. The core keeps every acceptance in
 * `hist`, so a checker can see a choice that no node knows about. Two switches add the classic bugs:
 * `forget` (an acceptor loses its state on restart, as with no fsync) and `ignoreAccepted` (the proposer always
 * proposes its own value). Each one lets two different values be chosen.
 *
 * Three drivers share the core: a hand scheduler for the stepper (the learner picks each delivery), the shared Net
 * (random latency, loss, duplicates, crashes, retry timers), and an exhaustive search over every schedule.
 */
import { Net, type Message } from "../../net";
import { majority } from "./quorum";

export type PMsg =
  | { t: "prepare"; b: number }
  | { t: "promise"; b: number; acc: Acc | null }
  | { t: "nack"; b: number; promised: number }
  | { t: "accept"; b: number; v: string }
  | { t: "accepted"; b: number; v: string };

export interface Acc {
  b: number;
  v: string;
}

export interface AccState {
  promised: number;
  accepted: Acc | null;
}

export interface PropState {
  round: number;
  b: number;
  phase: "idle" | "p1" | "p2" | "done";
  /** Promises for the current ballot, by acceptor index. */
  promises: Record<number, Acc | null>;
  /** Acceptors that accepted the current ballot. */
  acks: number[];
  /** The value in the current phase-2 request. */
  v: string | null;
  /** The highest ballot this proposer has heard of. */
  maxSeen: number;
  /** Ballots started so far. */
  started: number;
  /** As a learner: acceptors that accepted each of this proposer's ballots, and the value it learned. */
  learned: Record<number, number[]>;
  chosen: string | null;
}

export interface PaxosBugs {
  forget?: boolean;
  ignoreAccepted?: boolean;
}

export interface Out {
  from: number;
  to: number;
  m: PMsg;
}

export const ballot = (round: number, proposer: number) => round * 8 + proposer;
/** "round.proposer", with proposers counted from 1 as in the demos: ballot(2, 0) is "2.1". */
export const ballotName = (b: number) => (b <= 0 ? "–" : `${Math.floor(b / 8)}.${(b % 8) + 1}`);

export class PaxosCore {
  acc: AccState[];
  prop: PropState[];
  /** Every acceptance ever made: acceptor index, ballot, value, time. */
  hist: { a: number; b: number; v: string; t: number }[] = [];
  readonly maj: number;

  constructor(readonly np: number, readonly na: number, readonly values: string[], readonly bugs: PaxosBugs = {}) {
    this.acc = Array.from({ length: na }, () => ({ promised: 0, accepted: null }));
    this.prop = Array.from({ length: np }, () => ({ round: 0, b: 0, phase: "idle" as const, promises: {}, acks: [], v: null, maxSeen: 0, started: 0, learned: {}, chosen: null }));
    this.maj = majority(na);
  }

  isAcceptor = (node: number) => node >= this.np;
  acceptorNode = (a: number) => this.np + a;

  clone(): PaxosCore {
    const c = new PaxosCore(this.np, this.na, this.values, this.bugs);
    c.acc = this.acc.map((a) => ({ promised: a.promised, accepted: a.accepted && { ...a.accepted } }));
    c.prop = this.prop.map((p) => ({ ...p, promises: { ...p.promises }, acks: [...p.acks], learned: Object.fromEntries(Object.entries(p.learned).map(([k, v]) => [k, [...v]])) }));
    c.hist = [...this.hist];
    return c;
  }

  /** Proposer p starts a new ballot, higher than any it has seen. */
  start(p: number): Out[] {
    const s = this.prop[p]!;
    s.round = Math.max(s.round, Math.floor(s.maxSeen / 8)) + 1;
    s.b = ballot(s.round, p);
    s.maxSeen = Math.max(s.maxSeen, s.b);
    s.phase = "p1";
    s.promises = {};
    s.acks = [];
    s.v = null;
    s.started++;
    return Array.from({ length: this.na }, (_, a) => ({ from: p, to: this.acceptorNode(a), m: { t: "prepare", b: s.b } }));
  }

  /** An acceptor comes back after a crash. With the `forget` bug, its promise and its accepted value are gone. */
  recover(node: number) {
    if (this.bugs.forget && this.isAcceptor(node)) this.acc[node - this.np] = { promised: 0, accepted: null };
  }

  receive(to: number, from: number, m: PMsg, t = 0): Out[] {
    if (this.isAcceptor(to)) {
      const a = to - this.np;
      const s = this.acc[a]!;
      if (m.t === "prepare") {
        if (m.b >= s.promised) {
          s.promised = m.b;
          return [{ from: to, to: from, m: { t: "promise", b: m.b, acc: s.accepted && { ...s.accepted } } }];
        }
        return [{ from: to, to: from, m: { t: "nack", b: m.b, promised: s.promised } }];
      }
      if (m.t === "accept") {
        if (m.b >= s.promised) {
          s.promised = m.b;
          s.accepted = { b: m.b, v: m.v };
          this.hist.push({ a, b: m.b, v: m.v, t });
          return [{ from: to, to: from, m: { t: "accepted", b: m.b, v: m.v } }];
        }
        return [{ from: to, to: from, m: { t: "nack", b: m.b, promised: s.promised } }];
      }
      return [];
    }
    const s = this.prop[to]!;
    const a = from - this.np;
    if (m.t === "nack") {
      s.maxSeen = Math.max(s.maxSeen, m.promised);
      return [];
    }
    if (m.t === "promise") {
      if (m.b !== s.b || s.phase !== "p1") return [];
      s.promises[a] = m.acc;
      if (Object.keys(s.promises).length < this.maj) return [];
      let best: Acc | null = null;
      for (const acc of Object.values(s.promises)) if (acc && (!best || acc.b > best.b)) best = acc;
      s.v = best && !this.bugs.ignoreAccepted ? best.v : this.values[to]!;
      s.phase = "p2";
      return Array.from({ length: this.na }, (_, i) => ({ from: to, to: this.acceptorNode(i), m: { t: "accept", b: s.b, v: s.v! } }));
    }
    if (m.t === "accepted") {
      // The proposer is also a learner: a majority for any of its ballots means that value is chosen.
      const who = (s.learned[m.b] ??= []);
      if (!who.includes(a)) who.push(a);
      if (m.b === s.b && !s.acks.includes(a)) s.acks.push(a);
      if (who.length >= this.maj && s.chosen === null) {
        s.chosen = m.v;
        s.phase = "done";
      }
    }
    return [];
  }

  /** Every (ballot, value) that a majority of acceptors accepted, from the full history. */
  chosen(): { b: number; v: string; t: number }[] {
    const by = new Map<number, { v: string; who: Set<number>; t: number }>();
    const out: { b: number; v: string; t: number }[] = [];
    for (const h of this.hist) {
      const e = by.get(h.b) ?? { v: h.v, who: new Set<number>(), t: 0 };
      e.who.add(h.a);
      by.set(h.b, e);
      if (e.who.size === this.maj) out.push({ b: h.b, v: h.v, t: h.t });
    }
    return out;
  }

  chosenValues(): Set<string> {
    return new Set(this.chosen().map((c) => c.v));
  }

  /** Acceptors that accepted ballot b, from the history. */
  acceptedBy(b: number): number[] {
    return [...new Set(this.hist.filter((h) => h.b === b).map((h) => h.a))];
  }
}

// ============================================================================ the hand scheduler

/** A network where the learner picks each step. Each action takes one tick. It keeps Net's message records. */
export class HandNet<P> {
  now = 0;
  readonly messages: Message<P>[] = [];
  readonly crashes: { node: number; t: number; until?: number }[] = [];
  private nextId = 1;
  readonly down = new Set<number>();

  send(from: number, to: number, payload: P): Message<P> {
    const m: Message<P> = { id: this.nextId++, from, to, sentAt: this.now, payload };
    this.messages.push(m);
    return m;
  }
  pending(): Message<P>[] {
    return this.messages.filter((m) => m.deliveredAt === undefined && m.lost === undefined);
  }
  take(id: number): Message<P> | undefined {
    const m = this.messages.find((x) => x.id === id && x.deliveredAt === undefined && x.lost === undefined);
    if (!m || this.down.has(m.to)) return undefined;
    this.now++;
    m.deliveredAt = this.now;
    return m;
  }
  drop(id: number) {
    const m = this.messages.find((x) => x.id === id);
    if (!m || m.lost || m.deliveredAt !== undefined) return;
    this.now++;
    m.lost = "dropped";
    m.lostAt = this.now;
  }
  crash(node: number) {
    this.now++;
    this.down.add(node);
    this.crashes.push({ node, t: this.now });
  }
  recover(node: number) {
    this.now++;
    this.down.delete(node);
    const c = [...this.crashes].reverse().find((x) => x.node === node && x.until === undefined);
    if (c) c.until = this.now;
  }
}

export type HandAction =
  | { k: "start"; p: number }
  | { k: "deliver"; id: number }
  | { k: "drop"; id: number }
  | { k: "crash"; node: number }
  | { k: "recover"; node: number };

/** Replays a list of learner actions. The demo keeps only the list, so Back is a replay of a shorter list. */
export function replayHand(np: number, na: number, values: string[], bugs: PaxosBugs, actions: HandAction[]) {
  const core = new PaxosCore(np, na, values, bugs);
  const net = new HandNet<PMsg>();
  const emit = (outs: Out[]) => outs.forEach((o) => net.send(o.from, o.to, o.m));
  for (const a of actions) {
    if (a.k === "start") {
      if (net.down.has(a.p)) continue;
      net.now++;
      emit(core.start(a.p));
    } else if (a.k === "deliver") {
      const m = net.take(a.id);
      if (m) emit(core.receive(m.to, m.from, m.payload, net.now));
    } else if (a.k === "drop") net.drop(a.id);
    else if (a.k === "crash") net.crash(a.node);
    else {
      net.recover(a.node);
      core.recover(a.node);
    }
  }
  return { core, net };
}

/** A step of a preset, by description: the message is the oldest pending one that matches. */
export type ScriptStep =
  | { start: number }
  | { from: string; to: string; t: PMsg["t"] }
  | { crash: string }
  | { recover: string };

/** Turns a readable script ("deliver P1's prepare to A2") into hand actions with message ids. */
export function scriptToActions(np: number, na: number, values: string[], bugs: PaxosBugs, script: ScriptStep[]): HandAction[] {
  const actions: HandAction[] = [];
  const node = (name: string) => (name[0] === "P" ? Number(name.slice(1)) - 1 : np + Number(name.slice(1)) - 1);
  for (const s of script) {
    if ("start" in s) actions.push({ k: "start", p: s.start });
    else if ("crash" in s) actions.push({ k: "crash", node: node(s.crash) });
    else if ("recover" in s) actions.push({ k: "recover", node: node(s.recover) });
    else {
      const { net } = replayHand(np, na, values, bugs, actions);
      const m = net.pending().find((x) => x.from === node(s.from) && x.to === node(s.to) && x.payload.t === s.t);
      if (!m) throw new Error(`no pending ${s.t} from ${s.from} to ${s.to}`);
      actions.push({ k: "deliver", id: m.id });
    }
  }
  return actions;
}

const flow = (p: string, as: string[], t: PMsg["t"], back = false): ScriptStep[] => as.map((a) => (back ? { from: a, to: p, t } : { from: p, to: a, t }));

/** P1 runs a whole ballot with acceptors `as`: prepare, promise, accept, accepted. */
export const fullBallot = (p: string, as: string[]): ScriptStep[] => [
  ...flow(p, as, "prepare"), ...flow(p, as, "promise", true), ...flow(p, as, "accept"), ...flow(p, as, "accepted", true),
];

export interface PaxosPreset {
  id: string;
  label: string;
  bugs: PaxosBugs;
  script: ScriptStep[];
}

/** Presets for the stepper, with 2 proposers and 3 acceptors. */
export const PAXOS_PRESETS: PaxosPreset[] = [
  { id: "happy", label: "One proposer", bugs: {}, script: [{ start: 0 }, ...fullBallot("P1", ["A1", "A2", "A3"])] },
  {
    id: "late", label: "A late proposer", bugs: {},
    script: [{ start: 0 }, ...flow("P1", ["A1", "A2"], "prepare"), ...flow("P1", ["A1", "A2"], "promise", true), ...flow("P1", ["A1", "A2"], "accept"),
      { start: 1 }, ...flow("P2", ["A2", "A3"], "prepare"), ...flow("P2", ["A2", "A3"], "promise", true), ...flow("P2", ["A2", "A3"], "accept")],
  },
  {
    id: "ignore", label: "Bug: ignore old values", bugs: { ignoreAccepted: true },
    script: [{ start: 0 }, ...flow("P1", ["A1", "A2"], "prepare"), ...flow("P1", ["A1", "A2"], "promise", true), ...flow("P1", ["A1", "A2"], "accept"),
      { start: 1 }, ...flow("P2", ["A2", "A3"], "prepare"), ...flow("P2", ["A2", "A3"], "promise", true), ...flow("P2", ["A2", "A3"], "accept")],
  },
  {
    id: "forget", label: "Bug: no fsync", bugs: { forget: true },
    script: [{ start: 0 }, ...flow("P1", ["A1", "A2"], "prepare"), ...flow("P1", ["A1", "A2"], "promise", true), ...flow("P1", ["A1", "A2"], "accept"),
      { crash: "A2" }, { recover: "A2" },
      { start: 1 }, ...flow("P2", ["A2", "A3"], "prepare"), ...flow("P2", ["A2", "A3"], "promise", true), ...flow("P2", ["A2", "A3"], "accept")],
  },
];

// ============================================================================ the Net driver

export type Strategy = "fixed" | "backoff" | "leader";

export interface DuelConfig {
  na: number;
  seed: number;
  strategy: Strategy;
  /** The retry timer of a proposer, in ms. */
  timeout: number;
  /** When the second proposer starts, in ms. */
  offset: number;
  /** Latency is 10 ± jitter ms. */
  jitter: number;
  horizon: number;
  dropRate: number;
}

export const DUEL_DEFAULTS: DuelConfig = { na: 3, seed: 1, strategy: "fixed", timeout: 30, offset: 15, jitter: 0, horizon: 400, dropRate: 0 };

export interface DuelResult {
  net: Net<PMsg>;
  core: PaxosCore;
  /** First time a majority accepted one ballot, or null. */
  chosenAt: number | null;
  ballots: number;
}

/** Two proposers with retry timers. "fixed" retries after exactly `timeout`; "backoff" waits a random extra time;
 *  "leader" lets only proposer 0 propose (a distinguished proposer). */
export function runDuel(cfg: Partial<DuelConfig> = {}): DuelResult {
  const c = { ...DUEL_DEFAULTS, ...cfg };
  const core = new PaxosCore(2, c.na, ["X", "Y"]);
  const timers: number[] = [0, 0];
  const emit = (net: Net<PMsg>, outs: Out[]) => outs.forEach((o) => net.send(o.from, o.to, o.m));
  const begin = (net: Net<PMsg>, p: number) => {
    emit(net, core.start(p));
    const extra = c.strategy === "backoff" ? net.random() * 2 * c.timeout : 0;
    timers[p] = net.setTimer(p, c.timeout + extra, "retry");
  };
  const net = new Net<PMsg>(2 + c.na, { seed: c.seed, latency: { min: 10 - c.jitter, max: 10 + c.jitter }, dropRate: c.dropRate }, {
    onMessage: (to, m, n) => {
      emit(n, core.receive(to, m.from, m.payload, n.now));
      if (!core.isAcceptor(to) && core.prop[to]!.phase === "done") n.cancelTimer(timers[to]!);
    },
    onTimer: (node, tag, n) => {
      if (tag === "start" || (tag === "retry" && core.prop[node]!.phase !== "done")) begin(n, node);
    },
  });
  net.setTimer(0, 0, "start");
  if (c.strategy !== "leader") net.setTimer(1, c.offset, "start");
  net.runUntil(c.horizon);
  const ch = core.chosen();
  return { net, core, chosenAt: ch.length ? ch[0]!.t : null, ballots: core.prop.reduce((s, p) => s + p.started, 0) };
}

/** Fraction of seeds that chose a value by each time in `times`. */
export function duelCdf(cfg: Partial<DuelConfig>, seeds: number, times: number[]): number[] {
  const at: (number | null)[] = [];
  for (let s = 1; s <= seeds; s++) at.push(runDuel({ ...cfg, seed: s }).chosenAt);
  return times.map((t) => at.filter((x) => x !== null && x <= t).length / seeds);
}

export interface ChaosConfig {
  np: number;
  na: number;
  seed: number;
  dropRate: number;
  dupRate: number;
  /** Acceptor crash and recovery events to inject. */
  crashes: number;
  bugs: PaxosBugs;
  horizon: number;
}

/** Random schedules for the property test: several proposers with random backoff, loss, duplicates, crashes. */
export function runChaos(cfg: Partial<ChaosConfig> = {}) {
  const c: ChaosConfig = { np: 3, na: 5, seed: 1, dropRate: 0.1, dupRate: 0.05, crashes: 4, bugs: {}, horizon: 1500, ...cfg };
  const values = Array.from({ length: c.np }, (_, i) => String.fromCharCode(65 + i));
  const core = new PaxosCore(c.np, c.na, values, c.bugs);
  const emit = (net: Net<PMsg>, outs: Out[]) => outs.forEach((o) => net.send(o.from, o.to, o.m));
  const net = new Net<PMsg>(c.np + c.na, { seed: c.seed, latency: { min: 2, max: 40 }, dropRate: c.dropRate, dupRate: c.dupRate });
  for (let p = 0; p < c.np; p++) net.setTimer(p, net.random() * 60, "try");
  for (let k = 0; k < c.crashes; k++) {
    const node = c.np + Math.floor(net.random() * c.na);
    const t = net.random() * c.horizon * 0.6;
    net.setTimer(node, t, "crash");
    // A timer does not fire on a node that is down, so the recover timer runs on proposer 0 and acts on the acceptor.
    net.setTimer(0, t + 5 + net.random() * 100, `recover-${node}`);
  }
  net.setHandlers({
    onMessage: (to, m, n) => emit(n, core.receive(to, m.from, m.payload, n.now)),
    onTimer: (node, tag, n) => {
      if (tag === "try" && core.prop[node]!.phase !== "done" && core.prop[node]!.started < 12) {
        emit(n, core.start(node));
        n.setTimer(node, 30 + n.random() * 120, "try");
      } else if (tag === "crash") n.crash(node);
      else if (tag.startsWith("recover-")) {
        const a = Number(tag.slice(8));
        if (!n.isUp(a)) n.recover(a);
      }
    },
    onRecover: (node) => core.recover(node),
  });
  net.runUntil(c.horizon);
  return { core, net, chosen: core.chosenValues() };
}

// ============================================================================ exhaustive search

export interface SearchResult {
  states: number;
  /** A schedule that chooses two values, as readable steps, or null if none exists within the bounds. */
  violation: string[] | null;
  /** Schedules in which some value was chosen (counted once per distinct state). */
  chosenStates: number;
}

/**
 * Explores every schedule: any pending message may be delivered next, and any message may stay in flight forever
 * (which covers loss). Each proposer starts at most `ballotsPerProposer` ballots. With the `forget` bug, each acceptor
 * may crash and restart once. Replies that do not affect safety (accepted, nack) are not sent in this model.
 */
export function exhaustive(np: number, na: number, ballotsPerProposer: number, bugs: PaxosBugs = {}, limit = 2_000_000): SearchResult {
  const values = Array.from({ length: np }, (_, i) => String.fromCharCode(88 + i)); // X, Y, Z
  type S = { core: PaxosCore; pend: Out[]; restarts: number[]; path: string[] };
  const seen = new Set<string>();
  let chosenStates = 0;
  const keyOf = (s: S) => {
    const a = s.core.acc.map((x) => `${x.promised}:${x.accepted ? x.accepted.b + x.accepted.v : "-"}`).join(",");
    const p = s.core.prop.map((x) => `${x.b}:${x.phase}:${Object.entries(x.promises).map(([k, v]) => k + (v ? v.b + v.v : "-")).join("")}:${x.started}`).join(",");
    const h = [...new Set(s.core.hist.map((x) => `${x.b}${x.a}`))].sort().join("");
    const q = s.pend.map((o) => `${o.from}>${o.to}${JSON.stringify(o.m)}`).sort().join("|");
    return `${a}/${p}/${h}/${q}/${s.restarts.join("")}`;
  };
  const filt = (outs: Out[]) => outs.filter((o) => o.m.t !== "accepted" && o.m.t !== "nack");
  const name = (o: Out) => `${o.m.t}(${ballotName(o.m.b)}${o.m.t === "accept" ? ", " + o.m.v : ""}${o.m.t === "promise" && o.m.acc ? `, had ${ballotName(o.m.acc.b)} ${o.m.acc.v}` : ""}) ${nodeName(np, o.from)}→${nodeName(np, o.to)}`;
  // A message that can no longer change anything is removed at once: a promise for a proposer that has moved on,
  // or (when acceptors keep their state) a request below the acceptor's promise. This keeps the search small.
  const live = (core: PaxosCore, o: Out) => {
    if (o.m.t === "promise") return core.prop[o.to]!.b === o.m.b && core.prop[o.to]!.phase === "p1";
    if (!bugs.forget && (o.m.t === "prepare" || o.m.t === "accept")) return o.m.b >= core.acc[o.to - np]!.promised;
    return true;
  };
  const prune = (core: PaxosCore, pend: Out[]) => pend.filter((o) => live(core, o));
  let violation: string[] | null = null;
  const stack: S[] = [{ core: new PaxosCore(np, na, values, bugs), pend: [], restarts: Array(na).fill(0), path: [] }];
  while (stack.length && !violation && seen.size < limit) {
    const s = stack.pop()!;
    const k = keyOf(s);
    if (seen.has(k)) continue;
    seen.add(k);
    const ch = s.core.chosenValues();
    if (ch.size > 0) chosenStates++;
    if (ch.size > 1) {
      violation = s.path;
      break;
    }
    for (let p = 0; p < np; p++) {
      if (s.core.prop[p]!.started >= ballotsPerProposer) continue;
      const core = s.core.clone();
      const outs = filt(core.start(p));
      stack.push({ core, pend: prune(core, [...s.pend, ...outs]), restarts: s.restarts, path: [...s.path, `${nodeName(np, p)} starts ballot ${ballotName(core.prop[p]!.b)}`] });
    }
    const done = new Set<string>();
    s.pend.forEach((o, i) => {
      const id = `${o.from}>${o.to}${JSON.stringify(o.m)}`;
      if (done.has(id)) return;
      done.add(id);
      const core = s.core.clone();
      const outs = filt(core.receive(o.to, o.from, o.m));
      const pend = prune(core, s.pend.filter((_, j) => j !== i).concat(outs));
      stack.push({ core, pend, restarts: s.restarts, path: [...s.path, `deliver ${name(o)}`] });
    });
    if (bugs.forget) {
      for (let a = 0; a < na; a++) {
        if (s.restarts[a]! >= 1) continue;
        const core = s.core.clone();
        core.recover(np + a);
        const restarts = [...s.restarts];
        restarts[a]! += 1;
        stack.push({ core, pend: s.pend, restarts, path: [...s.path, `${nodeName(np, np + a)} crashes and restarts`] });
      }
    }
  }
  return { states: seen.size, violation, chosenStates };
}

export const nodeName = (np: number, node: number) => (node < np ? `P${node + 1}` : `A${node - np + 1}`);

export function msgLabel(m: PMsg): string {
  switch (m.t) {
    case "prepare": return `prepare ${ballotName(m.b)}`;
    case "promise": return `promise ${ballotName(m.b)}${m.acc ? ` (${ballotName(m.acc.b)} ${m.acc.v})` : ""}`;
    case "nack": return `nack ${ballotName(m.b)}`;
    case "accept": return `accept ${ballotName(m.b)} ${m.v}`;
    case "accepted": return `accepted ${ballotName(m.b)}`;
  }
}
