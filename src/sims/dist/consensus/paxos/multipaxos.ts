/**
 * Multi-Paxos on the shared network: one Paxos instance per log slot, and a leader that runs phase 1 once for all
 * slots. Every node is a proposer, an acceptor and a learner.
 *
 *   p1a(b)                  new leader → all: prepare ballot b for every slot
 *   p1b(b, entries)         acceptor → leader: a promise, with every (slot, ballot, value) it has accepted
 *   p2a(b, slot, v)         leader → acceptors: accept v in slot
 *   p2b(b, slot)            acceptor → leader: accepted
 *
 * A new leader takes, for each slot, the value with the highest ballot among the promises, and re-proposes it with
 * its own ballot. A slot below the highest one that no promise mentions is a gap: the leader fills it with a no-op,
 * so that the log can be applied in order. A stable leader then needs only phase 2: one round trip per command.
 *
 * `q2` sets the phase-2 quorum (Flexible Paxos). Phase 1 then needs q1 = n − q2 + 1, so that every phase-1 quorum
 * meets every phase-2 quorum. With `thrifty`, the leader sends p2a only to q2 − 1 other nodes.
 */
import { Net, type Message } from "../../net";
import { flexibleQ1, majority } from "./quorum";
import { ballot, ballotName } from "./paxos";

export type MpMsg =
  | { t: "p1a"; b: number }
  | { t: "p1b"; b: number; entries: [number, number, string][] }
  | { t: "nack"; b: number; promised: number }
  | { t: "p2a"; b: number; slot: number; v: string }
  | { t: "p2b"; b: number; slot: number };

export const NOOP = "no-op";

export interface MpNode {
  promised: number;
  /** Accepted entries by slot. */
  log: Map<number, { b: number; v: string }>;
  // Leader state
  leading: boolean;
  ballot: number;
  round: number;
  phase1Done: boolean;
  promises: Map<number, [number, number, string][]>;
  acks: Map<number, Set<number>>;
  nextSlot: number;
  /** Slots this node knows are chosen, from its acks as leader. */
  chosen: Map<number, string>;
  queue: string[];
}

export interface MpOptions {
  n: number;
  seed: number;
  /** Phase-2 quorum. The default is a majority. */
  q2?: number;
  thrifty?: boolean;
  latency?: { min: number; max: number };
}

export class MultiPaxos {
  readonly net: Net<MpMsg>;
  readonly nodes: MpNode[];
  readonly q2: number;
  readonly q1: number;
  /** Every acceptance: node, slot, ballot, value. */
  readonly hist: { node: number; slot: number; b: number; v: string }[] = [];

  constructor(readonly opt: MpOptions) {
    const { n } = opt;
    this.q2 = opt.q2 ?? majority(n);
    this.q1 = opt.q2 === undefined ? majority(n) : flexibleQ1(n, this.q2);
    this.nodes = Array.from({ length: n }, () => ({
      promised: 0, log: new Map(), leading: false, ballot: 0, round: 0, phase1Done: false,
      promises: new Map(), acks: new Map(), nextSlot: 1, chosen: new Map(), queue: [],
    }));
    this.net = new Net<MpMsg>(n, { seed: opt.seed, latency: opt.latency ?? { min: 6, max: 14 } }, {
      onMessage: (to, m) => this.receive(to, m.from, m.payload),
    });
  }

  private accept(i: number, b: number, slot: number, v: string): boolean {
    const s = this.nodes[i]!;
    if (b < s.promised) return false;
    s.promised = b;
    s.log.set(slot, { b, v });
    this.hist.push({ node: i, slot, b, v });
    return true;
  }

  private entries(i: number): [number, number, string][] {
    return [...this.nodes[i]!.log.entries()].map(([slot, e]) => [slot, e.b, e.v]);
  }

  /** Node i starts phase 1 with a ballot above every ballot it knows. */
  elect(i: number) {
    const s = this.nodes[i]!;
    s.round = Math.max(s.round, Math.floor(s.promised / 8)) + 1;
    s.ballot = ballot(s.round, i);
    s.leading = true;
    s.phase1Done = false;
    s.promises = new Map();
    s.acks = new Map();
    s.promised = s.ballot;
    s.promises.set(i, this.entries(i));
    for (let to = 0; to < this.opt.n; to++) if (to !== i) this.net.send(i, to, { t: "p1a", b: s.ballot });
    this.maybeFinishPhase1(i);
  }

  submit(i: number, cmd: string) {
    const s = this.nodes[i]!;
    s.queue.push(cmd);
    if (s.leading && s.phase1Done) this.drain(i);
  }

  private propose(i: number, slot: number, v: string) {
    const s = this.nodes[i]!;
    this.accept(i, s.ballot, slot, v);
    s.acks.set(slot, new Set([i]));
    const others = Array.from({ length: this.opt.n }, (_, k) => k).filter((k) => k !== i);
    const targets = this.opt.thrifty ? others.slice(0, this.q2 - 1) : others;
    for (const to of targets) this.net.send(i, to, { t: "p2a", b: s.ballot, slot, v });
    this.checkChosen(i, slot);
  }

  private drain(i: number) {
    const s = this.nodes[i]!;
    while (s.queue.length) this.propose(i, s.nextSlot++, s.queue.shift()!);
  }

  private maybeFinishPhase1(i: number) {
    const s = this.nodes[i]!;
    if (s.phase1Done || s.promises.size < this.q1) return;
    s.phase1Done = true;
    const best = new Map<number, { b: number; v: string }>();
    for (const es of s.promises.values()) for (const [slot, b, v] of es) {
      const cur = best.get(slot);
      if (!cur || b > cur.b) best.set(slot, { b, v });
    }
    const top = Math.max(0, ...best.keys());
    // Re-propose every slot up to the highest one heard of. A gap becomes a no-op.
    for (let slot = 1; slot <= top; slot++) this.propose(i, slot, best.get(slot)?.v ?? NOOP);
    s.nextSlot = top + 1;
    this.drain(i);
  }

  private checkChosen(i: number, slot: number) {
    const s = this.nodes[i]!;
    if ((s.acks.get(slot)?.size ?? 0) >= this.q2 && !s.chosen.has(slot)) s.chosen.set(slot, s.log.get(slot)!.v);
  }

  private receive(to: number, from: number, m: MpMsg) {
    const s = this.nodes[to]!;
    switch (m.t) {
      case "p1a":
        if (m.b > s.promised) {
          s.promised = m.b;
          s.leading = false;
          this.net.send(to, from, { t: "p1b", b: m.b, entries: this.entries(to) });
        } else this.net.send(to, from, { t: "nack", b: m.b, promised: s.promised });
        break;
      case "p1b":
        if (s.leading && m.b === s.ballot && !s.phase1Done) {
          s.promises.set(from, m.entries);
          this.maybeFinishPhase1(to);
        }
        break;
      case "p2a":
        if (this.accept(to, m.b, m.slot, m.v)) {
          if (m.b > s.ballot) s.leading = false;
          this.net.send(to, from, { t: "p2b", b: m.b, slot: m.slot });
        } else this.net.send(to, from, { t: "nack", b: m.b, promised: s.promised });
        break;
      case "p2b":
        if (s.leading && m.b === s.ballot) {
          s.acks.get(m.slot)?.add(from);
          this.checkChosen(to, m.slot);
        }
        break;
      case "nack":
        if (m.promised > s.ballot) s.leading = false;
        break;
    }
  }

  /** Ground truth: the value chosen in each slot, from the full history (a q2 of nodes accepted one ballot). */
  chosenTruth(): Map<number, Set<string>> {
    const by = new Map<string, Set<number>>();
    const out = new Map<number, Set<string>>();
    for (const h of this.hist) {
      const k = `${h.slot}|${h.b}|${h.v}`;
      const set = by.get(k) ?? new Set<number>();
      set.add(h.node);
      by.set(k, set);
      if (set.size >= this.q2) {
        const vs = out.get(h.slot) ?? new Set<string>();
        vs.add(h.v);
        out.set(h.slot, vs);
      }
    }
    return out;
  }

  /** Runs until no message is in flight. */
  settle() {
    this.net.runAll();
  }
}

// ============================================================================ the leader-change scenario

export interface MpFrame {
  title: string;
  /** Logs of each node: slot → (ballot, value). */
  logs: { b: number; v: string }[][];
  chosen: (string | null)[];
  down: number[];
  leader: number | null;
  tStart: number;
  tEnd: number;
  messages: Message<MpMsg>[];
}

export const MP_SLOTS = 7;

/**
 * Five nodes. N1 leads and commits a, b, c. Then d reaches only N2, e reaches N2 and N3, f reaches only N4, and N1
 * crashes. N5 runs phase 1 and hears from the nodes in `quorum` (two or three of N2, N3, N4). Indexes are 0-based.
 */
export function leaderChangeScenario(quorum: number[], seed = 2): MpFrame[] {
  const mp = new MultiPaxos({ n: 5, seed });
  const frames: MpFrame[] = [];
  let t0 = 0;
  const snap = (title: string, leader: number | null) => {
    const truth = mp.chosenTruth();
    frames.push({
      title,
      logs: mp.nodes.map((s) => Array.from({ length: MP_SLOTS }, (_, k) => s.log.get(k + 1) ?? { b: 0, v: "" })),
      chosen: Array.from({ length: MP_SLOTS }, (_, k) => (truth.get(k + 1) ? [...truth.get(k + 1)!].join("/") : null)),
      down: [0, 1, 2, 3, 4].filter((i) => !mp.net.isUp(i)),
      leader,
      tStart: t0,
      tEnd: mp.net.now,
      messages: mp.net.messages.filter((m) => m.sentAt >= t0),
    });
    t0 = mp.net.now + 1;
    mp.net.runUntil(t0);
  };
  const reach = (from: number, to: number[]) => mp.net.partition([[from, ...to], ...[0, 1, 2, 3, 4].filter((i) => i !== from && !to.includes(i)).map((i) => [i])]);
  snap("Five empty logs.", null);
  mp.elect(0);
  mp.settle();
  snap(`N1 runs phase 1 with ballot ${ballotName(mp.nodes[0]!.ballot)}. All four others promise. N1 is the leader.`, 0);
  for (const c of ["a", "b", "c"]) mp.submit(0, c);
  mp.settle();
  snap("Commands a, b and c need only phase 2: one round trip each. Slots 1 to 3 are chosen.", 0);
  reach(0, [1]);
  mp.submit(0, "d");
  mp.settle();
  mp.net.heal();
  snap("N1 proposes d in slot 4, but only N2 gets it. Two of five accepted it: d is not chosen.", 0);
  reach(0, [1, 2]);
  mp.submit(0, "e");
  mp.settle();
  mp.net.heal();
  snap("e in slot 5 reaches N2 and N3. With N1 that makes three: e is chosen, but only N1 knows.", 0);
  reach(0, [3]);
  mp.submit(0, "f");
  mp.settle();
  mp.net.heal();
  snap("f in slot 6 reaches only N4. Then N1 crashes.", 0);
  mp.net.crash(0);
  // Only the chosen nodes hear the prepare. Once N5 has its quorum, the network heals, so that every live node
  // gets the re-proposals.
  reach(4, quorum);
  mp.elect(4);
  while (!mp.nodes[4]!.phase1Done && mp.net.step());
  mp.net.heal();
  mp.settle();
  const names = quorum.map((q) => `N${q + 1}`).join(" and ");
  snap(`N5 runs phase 1 with ballot ${ballotName(mp.nodes[4]!.ballot)} and hears from ${names}. It re-proposes the highest value of each slot and fills gaps with no-ops.`, 4);
  mp.submit(4, "g");
  mp.settle();
  snap("The new leader goes on with g in slot 7, with phase 2 only.", 4);
  return frames;
}

// ============================================================================ message counts

/** Messages per committed command with a stable leader (phase 2 only), measured on the network. */
export function messagesMulti(n: number, commands = 10, q2?: number, thrifty = false): number {
  const mp = new MultiPaxos({ n, seed: 1, q2, thrifty });
  mp.elect(0);
  mp.settle();
  const before = mp.net.messages.length;
  for (let k = 0; k < commands; k++) mp.submit(0, `c${k}`);
  mp.settle();
  return (mp.net.messages.length - before) / commands;
}

/** Messages per command when every command runs both phases (basic Paxos for each slot). */
export function messagesBasic(n: number, commands = 10): number {
  let total = 0;
  for (let k = 0; k < commands; k++) {
    // Each command is its own single-decree instance: phase 1, then phase 2.
    const mp = new MultiPaxos({ n, seed: 1 + k });
    mp.elect(0);
    mp.submit(0, `c${k}`);
    mp.settle();
    total += mp.net.messages.length;
  }
  return total / commands;
}
