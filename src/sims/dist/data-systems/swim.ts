/**
 * SWIM membership (Das, Gupta and Motivala, DSN 2002) on the shared Net.
 *
 * Every protocol period each member probes one other member, in a shuffled round-robin order:
 *   1. ping the target and wait `ackTimeout` for an ack;
 *   2. if no ack came, send ping-req to `k` other members; each pings the target and relays the ack;
 *   3. if still no ack at the end of the period, the target failed this probe.
 * A failed probe makes the target `suspect` (with the suspicion mechanism) or `dead` at once (without it).
 * A suspect that is not refuted within the suspicion timeout becomes dead. A member that hears that it is suspected
 * (or declared dead) increments its own incarnation number and spreads `alive`, which overrides the older rumor.
 *
 * Updates (alive, suspect, dead) are not sent on their own: they ride on pings, acks and ping-reqs (piggybacking),
 * and each member sends each update a bounded number of times. This is the infection-style dissemination.
 *
 * A member that pings a suspect also puts the suspicion in that ping, so that the suspect can refute it soon.
 * `syncEvery` adds a periodic full-state exchange with one random live member (like memberlist's push-pull sync),
 * which repairs views that piggybacking missed.
 *
 * Faults on one member: `slow` delays every message it sends by an extra exponential time (a member starved of CPU
 * or stuck in pauses); `isolate` cuts it off from all others between `at` and `until`; `crash` stops it at `at`.
 * All timings are MODEL INPUTS. The period, the ack timeout and the sync interval match memberlist's LAN defaults
 * (1 s, 500 ms, 30 s), and the suspicion timeout uses memberlist's rule: SuspicionMult × max(1, log10 n) × period.
 */
import { Net, type NodeId } from "../net";

export type SwimState = "alive" | "suspect" | "dead";
export type SwimFault = "none" | "slow" | "isolate" | "crash";

export interface SwimConfig {
  n: number;
  seed: number;
  period: number;
  ackTimeout: number;
  /** Indirect probes per failed direct probe. 0 = direct ping only. */
  k: number;
  suspicion: boolean;
  suspicionMult: number;
  latency: { min: number; max: number };
  dropRate: number;
  horizon: number;
  fault: { node: number; kind: SwimFault; at: number; until: number; slowMean: number };
  /** Updates carried per message, and how many times each member sends an update (× ⌈log10(n + 1)⌉). */
  maxPiggy: number;
  retransmitMult: number;
  /** Full-state sync with one random member every this many ms. 0: off. */
  syncEvery: number;
}

export const SWIM_DEFAULTS: SwimConfig = {
  n: 8, seed: 1, period: 1000, ackTimeout: 500, k: 3, suspicion: true, suspicionMult: 4,
  latency: { min: 2, max: 10 }, dropRate: 0, horizon: 20_000,
  fault: { node: 3, kind: "slow", at: 2000, until: Infinity, slowMean: 300 },
  maxPiggy: 6, retransmitMult: 4, syncEvery: 30_000,
};

export interface Update { k: SwimState; node: number; inc: number }
export type SwimMsg =
  | { k: "ping"; seq: number; ups: Update[] }
  | { k: "ack"; seq: number; ups: Update[] }
  | { k: "ping-req"; seq: number; target: number; ups: Update[] }
  | { k: "sync" | "sync-reply"; ups: Update[] };

export interface ViewChange { t: number; at: number; about: number; s: SwimState; inc: number }
export interface Origin {
  t: number;
  by: number;
  target: number;
  kind: "suspect" | "dead";
  /** The target could not be reached during the probe: it crashed, or one side was cut off. */
  real: boolean;
}

export interface SwimRun {
  cfg: SwimConfig;
  net: Net<SwimMsg>;
  /** Every change of a member's view of another member. */
  changes: ViewChange[];
  /** Failed probes that started a suspicion or a death. */
  origins: Origin[];
  refutes: { t: number; node: number; inc: number }[];
  /** Probes: answered by a direct ack before the timeout, answered later (via ping-req), failed. */
  probes: { direct: number; indirect: number; failed: number };
  suspicionTimeout: number;
  /** Each member's final view, view[i][j]. */
  view: { s: SwimState; inc: number }[][];
}

export const suspicionTimeout = (cfg: Pick<SwimConfig, "n" | "suspicionMult" | "period">) =>
  cfg.suspicionMult * Math.max(1, Math.log10(Math.max(1, cfg.n))) * cfg.period;

export function runSwim(partial: Partial<Omit<SwimConfig, "fault">> & { fault?: Partial<SwimConfig["fault"]> } = {}): SwimRun {
  const cfg: SwimConfig = { ...SWIM_DEFAULTS, ...partial, fault: { ...SWIM_DEFAULTS.fault, ...partial.fault }, latency: { ...SWIM_DEFAULTS.latency, ...partial.latency } };
  const { n, period: T, ackTimeout, fault } = cfg;
  const suspT = suspicionTimeout(cfg);
  const limit = cfg.retransmitMult * Math.ceil(Math.log10(n + 1));

  const view = Array.from({ length: n }, () => Array.from({ length: n }, () => ({ s: "alive" as SwimState, inc: 0 })));
  const inc = new Array<number>(n).fill(0);
  const buf: { u: Update; sent: number }[][] = Array.from({ length: n }, () => []);
  const order: number[][] = Array.from({ length: n }, () => []);
  const changes: ViewChange[] = [];
  const origins: Origin[] = [];
  const refutes: SwimRun["refutes"] = [];
  const probes = { direct: 0, indirect: 0, failed: 0 };
  let nextSeq = 1;
  /** Probes started by a member: seq -> state. */
  const probe = new Map<number, { by: number; target: number; t0: number; acked: boolean; indirect: boolean }>();
  /** Relays at a helper: the seq it sent -> (requester, requester's seq). */
  const relay = new Map<number, { to: number; seq: number }>();

  const isolated = (i: number, t: number) => fault.kind === "isolate" && fault.node === i && t >= fault.at && t < fault.until;
  const crashed = (i: number, t: number) => fault.kind === "crash" && fault.node === i && t >= fault.at;
  const slow = (i: number, t: number) => fault.kind === "slow" && fault.node === i && t >= fault.at && t < fault.until;

  const enqueue = (i: number, u: Update) => {
    const b = buf[i]!;
    const old = b.findIndex((x) => x.u.node === u.node);
    if (old >= 0) b.splice(old, 1); // a newer update about the same member replaces the old one
    b.push({ u, sent: 0 });
  };
  const piggy = (i: number): Update[] => {
    const b = buf[i]!;
    b.sort((x, y) => x.sent - y.sent);
    const out = b.slice(0, cfg.maxPiggy);
    for (const x of out) x.sent++;
    buf[i] = b.filter((x) => x.sent < limit);
    return out.map((x) => x.u);
  };
  const fullState = (i: number): Update[] => [
    { k: "alive", node: i, inc: inc[i]! },
    ...view[i]!.flatMap((v, j) => (j === i ? [] : [{ k: v.s, node: j, inc: v.inc }])),
  ];

  let net!: Net<SwimMsg>;
  const out = (from: number, to: number, p: SwimMsg) => {
    if (!slow(from, net.now)) return void net.send(from, to, p);
    const lat = cfg.latency.min + net.random() * (cfg.latency.max - cfg.latency.min);
    const pause = -fault.slowMean * Math.log(1 - net.random());
    net.send(from, to, p, { delay: lat + pause });
  };

  /** Applies an update at member i. Returns true if it changed i's view (then i passes it on). */
  const apply = (i: number, u: Update): boolean => {
    if (u.node === i) {
      if (u.k !== "alive" && u.inc >= inc[i]!) {
        inc[i] = u.inc + 1;
        refutes.push({ t: net.now, node: i, inc: inc[i]! });
        enqueue(i, { k: "alive", node: i, inc: inc[i]! });
      }
      return false;
    }
    const cur = view[i]![u.node]!;
    let ok: boolean;
    if (u.k === "alive") ok = u.inc > cur.inc;
    else if (u.k === "suspect") ok = cur.s === "alive" ? u.inc >= cur.inc : cur.s === "suspect" && u.inc > cur.inc;
    else ok = cur.s !== "dead" && u.inc >= cur.inc;
    if (!ok) return false;
    view[i]![u.node] = { s: u.k, inc: u.inc };
    changes.push({ t: net.now, at: i, about: u.node, s: u.k, inc: u.inc });
    enqueue(i, u);
    if (u.k === "suspect") net.setTimer(i, suspT, `susp:${u.node}:${u.inc}`);
    return true;
  };

  const nextTarget = (i: number): number | null => {
    for (let tries = 0; tries < 2 * n; tries++) {
      if (!order[i]!.length) {
        const o = Array.from({ length: n }, (_, j) => j).filter((j) => j !== i);
        for (let a = o.length - 1; a > 0; a--) {
          const b = Math.floor(net.random() * (a + 1));
          [o[a], o[b]] = [o[b]!, o[a]!];
        }
        order[i] = o;
      }
      const j = order[i]!.shift()!;
      if (view[i]![j]!.s !== "dead") return j;
    }
    return null;
  };

  /** The end of a probe: if no ack came, the target failed it. */
  const finish = (i: number, s: number) => {
    const pr = probe.get(s);
    probe.delete(s);
    if (!pr || pr.acked) return;
    probes.failed++;
    const j = pr.target;
    if (view[i]![j]!.s !== "alive") return;
    const real = crashed(j, net.now) || isolated(j, pr.t0) || isolated(j, net.now) || isolated(i, pr.t0) || isolated(i, net.now);
    origins.push({ t: net.now, by: i, target: j, kind: cfg.suspicion ? "suspect" : "dead", real });
    apply(i, { k: cfg.suspicion ? "suspect" : "dead", node: j, inc: view[i]![j]!.inc });
  };

  net = new Net<SwimMsg>(n, { seed: cfg.seed, latency: cfg.latency, dropRate: cfg.dropRate }, {
    onMessage(i, m) {
      const p = m.payload;
      for (const u of p.ups) apply(i, u);
      if (p.k === "ping") out(i, m.from, { k: "ack", seq: p.seq, ups: piggy(i) });
      else if (p.k === "sync") out(i, m.from, { k: "sync-reply", ups: fullState(i) });
      else if (p.k === "ping-req") {
        const s = nextSeq++;
        relay.set(s, { to: m.from, seq: p.seq });
        out(i, p.target, { k: "ping", seq: s, ups: piggy(i) });
      } else if (p.k === "ack") {
        const r = relay.get(p.seq);
        if (r) {
          relay.delete(p.seq);
          out(i, r.to, { k: "ack", seq: r.seq, ups: piggy(i) });
          return;
        }
        const pr = probe.get(p.seq);
        if (pr && !pr.acked && pr.by === i) {
          pr.acked = true;
          if (pr.indirect) probes.indirect++;
          else probes.direct++;
        }
      }
    },
    onTimer(i, tag, nt) {
      const [kind, a, b] = tag.split(":");
      if (kind === "tick") {
        nt.setTimer(i, T, "tick");
        const j = nextTarget(i);
        if (j === null) return;
        const s = nextSeq++;
        probe.set(s, { by: i, target: j, t0: nt.now, acked: false, indirect: false });
        const ups = piggy(i);
        const v = view[i]![j]!;
        if (v.s === "suspect" && !ups.some((u) => u.node === j)) ups.push({ k: "suspect", node: j, inc: v.inc });
        out(i, j, { k: "ping", seq: s, ups });
        nt.setTimer(i, ackTimeout, `ackto:${s}`);
        nt.setTimer(i, T - 1, `end:${s}`);
      } else if (kind === "ackto") {
        const pr = probe.get(Number(a));
        if (!pr || pr.acked) return;
        if (cfg.k === 0) return finish(i, Number(a)); // direct ping only: the timeout is the verdict
        pr.indirect = true;
        const helpers = Array.from({ length: n }, (_, j) => j).filter((j) => j !== i && j !== pr.target && view[i]![j]!.s !== "dead");
        for (let c = 0; c < cfg.k && helpers.length; c++) {
          const h = helpers.splice(Math.floor(nt.random() * helpers.length), 1)[0]!;
          out(i, h, { k: "ping-req", seq: Number(a), target: pr.target, ups: piggy(i) });
        }
      } else if (kind === "end") {
        finish(i, Number(a));
      } else if (kind === "susp") {
        const j = Number(a), v = Number(b);
        const cur = view[i]![j]!;
        if (cur.s === "suspect" && cur.inc === v) apply(i, { k: "dead", node: j, inc: v });
      } else if (kind === "sync") {
        nt.setTimer(i, cfg.syncEvery, "sync");
        const live = Array.from({ length: n }, (_, j) => j).filter((j) => j !== i && view[i]![j]!.s === "alive");
        if (live.length) out(i, live[Math.floor(nt.random() * live.length)]!, { k: "sync", ups: fullState(i) });
      }
    },
  });

  for (let i = 0; i < n; i++) {
    net.setTimer(i, (i * T) / n + 1, "tick");
    if (cfg.syncEvery > 0) net.setTimer(i, cfg.syncEvery * (0.5 + i / n), "sync");
  }
  if (fault.kind === "crash") {
    net.runUntil(fault.at);
    net.crash(fault.node);
  } else if (fault.kind === "isolate") {
    net.runUntil(fault.at);
    net.partition([[fault.node], Array.from({ length: n }, (_, j) => j).filter((j) => j !== fault.node)]);
    net.runUntil(Math.min(fault.until, cfg.horizon));
    net.heal();
  }
  net.runUntil(cfg.horizon);
  return { cfg, net, changes, origins, refutes, probes, suspicionTimeout: suspT, view };
}

/** Summary counts of a run. */
export function swimSummary(r: SwimRun) {
  const f = r.cfg.fault;
  const crashedNode = f.kind === "crash" ? f.node : -1;
  const wrongly = r.origins.filter((o) => !o.real);
  const firstSusp = r.origins.find((o) => o.target === f.node && o.real);
  const deadOf = (j: number) => r.changes.filter((c) => c.about === j && c.s === "dead");
  const live = Array.from({ length: r.cfg.n }, (_, i) => i).filter((i) => i !== crashedNode);
  let wrongAtEnd = 0;
  for (const i of live) for (let j = 0; j < r.cfg.n; j++) {
    if (i === j) continue;
    if (r.view[i]![j]!.s !== (j === crashedNode ? "dead" : "alive")) wrongAtEnd++;
  }
  const allDead = crashedNode >= 0 && live.every((i) => r.changes.some((c) => c.at === i && c.about === crashedNode && c.s === "dead"))
    ? Math.max(...live.map((i) => r.changes.find((c) => c.at === i && c.about === crashedNode && c.s === "dead")!.t))
    : null;
  return {
    /** Failed probes of reachable members. */
    falseSusp: wrongly.length,
    /** ... of which the faulty member accused others, or others accused the faulty member. */
    falseByFaulty: wrongly.filter((o) => o.by === f.node).length,
    falseAboutFaulty: wrongly.filter((o) => o.target === f.node).length,
    /** Times a member marked a member that had not crashed as dead. */
    deadAboutLive: r.changes.filter((c) => c.s === "dead" && c.about !== crashedNode).length,
    firstSuspectAt: firstSusp ? firstSusp.t : null,
    firstDeadAt: deadOf(f.node)[0]?.t ?? null,
    allDeadAt: allDead,
    wrongAtEnd,
    msgsPerMemberPerPeriod: r.net.messages.length / r.cfg.n / (r.cfg.horizon / r.cfg.period),
    refutes: r.refutes.length,
  };
}

/** A member's view of `about` over time, as spans [from, to, state]. */
export function viewSpans(r: SwimRun, at: NodeId, about: NodeId): [number, number, SwimState][] {
  const cs = r.changes.filter((c) => c.at === at && c.about === about);
  const out: [number, number, SwimState][] = [];
  let t = 0, s: SwimState = "alive";
  for (const c of cs) {
    if (c.t > t) out.push([t, c.t, s]);
    t = c.t;
    s = c.s;
  }
  out.push([t, r.cfg.horizon, s]);
  return out;
}

/**
 * The chance that one probe of a live member fails when each message is lost independently with probability p:
 * direct: ping and ack, 1 - (1 - p)². Each of k indirect paths needs four messages, so all fail with (1 - (1 - p)⁴)^k.
 */
export function probeFailP(p: number, k: number) {
  return (1 - (1 - p) ** 2) * (1 - (1 - p) ** 4) ** k;
}
