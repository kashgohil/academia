/**
 * Deterministic simulation testing of the store (store.ts), in the style of FoundationDB's simulator.
 *
 * A run is a pure function of (seed, fault schedule, config). The seed fixes the network (delays, losses), the
 * election timers and the workload. The schedule lists faults with a start time and a length. After the run, two
 * checkers decide: the committed linearizability checker on the client history, and Raft's safety monitor.
 *
 * - genSchedule(seed, cfg): random faults from the seed.
 * - runSim(seed, schedule, cfg): one run; returns the store and a RunResult with a fingerprint of the whole trace.
 * - shrink(seed, schedule, cfg): a generator that removes faults and halves their lengths while the run still fails
 *   in the same way. The result is 1-minimal: removing any one remaining fault makes the failure go away.
 * - Campaign: many seeds in a row, with coverage counters, for a UI that runs in time slices.
 */
import { mulberry32 } from "../../rng";
import type { NodeId } from "../net";
import { KvStore, type Bugs, type OpRecord, type ReadMode, type StoreConfig, type StoreOp } from "./store";

export type FaultKind = "restart" | "restartVoter" | "crashAfterCommit" | "isolateNewLeader" | "crash" | "crashLeader" | "isolate" | "isolateLeader" | "split" | "drop" | "delay" | "pause" | "pauseLeader" | "skew";

export const FAULT_KINDS: { id: FaultKind; label: string }[] = [
  { id: "restart", label: "restart a server" },
  { id: "restartVoter", label: "restart the next voter" },
  { id: "crashAfterCommit", label: "crash after the next commit" },
  { id: "crash", label: "crash a server" },
  { id: "crashLeader", label: "crash the leader" },
  { id: "isolate", label: "cut off a server" },
  { id: "isolateLeader", label: "cut off the leader" },
  { id: "isolateNewLeader", label: "cut off the next new leader" },
  { id: "split", label: "split the cluster" },
  { id: "drop", label: "lose messages" },
  { id: "delay", label: "slow network" },
  { id: "pause", label: "pause a server" },
  { id: "pauseLeader", label: "pause the leader" },
  { id: "skew", label: "slow clock" },
];

export interface Fault {
  kind: FaultKind;
  at: number;
  dur: number;
  /** crash, isolate, pause, skew: the server. The *Leader kinds pick the leader when the fault starts. */
  node?: NodeId;
  /** split: the servers on the smaller side. */
  side?: NodeId[];
  /** drop: the loss rate; delay: the largest one-way delay in ms; skew: the clock rate. */
  x?: number;
}

export interface FuzzConfig {
  servers: number;
  clients: number;
  keys: string[];
  readMode: ReadMode;
  bugs: Bugs;
  /** Faults start in [50, faultEnd]; at faultEnd every fault is over. */
  faultEnd: number;
  /** Clients start new operations until faultEnd + work; the run ends at faultEnd + work + drain. */
  work: number;
  drain: number;
  faults: { min: number; max: number; kinds: FaultKind[] };
  /** Model input: one-way delay in ms. */
  latency: { min: number; max: number };
  /** Client think time between operations, ms. */
  think: { min: number; max: number };
  /** Swarm testing (Groce et al., ISSTA 2012): each seed uses a random subset of the fault kinds and a random load. */
  swarm: boolean;
  /** Lease mode only: false removes the rule that a restarted server waits before it votes. */
  restartGuard?: boolean;
}

export const FUZZ_DEFAULT: FuzzConfig = {
  servers: 3,
  clients: 3,
  keys: ["x", "y"],
  readMode: "readindex",
  bugs: {},
  faultEnd: 1500,
  work: 300,
  drain: 900,
  faults: { min: 2, max: 7, kinds: ["restart", "restartVoter", "crashAfterCommit", "crash", "crashLeader", "isolate", "isolateLeader", "isolateNewLeader", "split", "drop", "delay", "pause", "pauseLeader"] },
  latency: { min: 5, max: 15 },
  think: { min: 5, max: 30 },
  swarm: true,
};

/** The seed's swarm: which fault kinds it may use, and how much slower than `think` its clients are. */
export function swarmOf(seed: number, cfg: FuzzConfig): { kinds: FaultKind[]; slow: number } {
  if (!cfg.swarm) return { kinds: cfg.faults.kinds, slow: 1 };
  const r = mulberry32((seed * 40503) >>> 0 ^ 0x2545f491);
  let kinds = cfg.faults.kinds.filter(() => r() < 0.5);
  if (!kinds.length) kinds = [cfg.faults.kinds[Math.floor(r() * cfg.faults.kinds.length)]!];
  const slow = [1, 3, 10][Math.floor(r() * 3)]!;
  return { kinds, slow };
}

/**
 * The configuration that the bug hunt uses for each deliberate bug. Three bugs fall to the default mix. The Figure 8
 * bug needs a precise order of three events, so its hunt uses a narrow mix of the three targeted faults that build
 * that order, without swarm testing.
 */
export const OLD_TERM_KINDS: FaultKind[] = ["isolateLeader", "isolateNewLeader", "crashAfterCommit"];
export function bugConfig(bug: keyof Bugs | null, base: FuzzConfig = FUZZ_DEFAULT): FuzzConfig {
  if (!bug) return base;
  const cfg = { ...base, bugs: { [bug]: true } };
  if (bug === "oldTermCommit") return { ...cfg, swarm: false, faults: { min: 2, max: 6, kinds: OLD_TERM_KINDS } };
  return cfg;
}

// ---------------------------------------------------------------- schedules

const rnd = (r: () => number, a: number, b: number) => a + r() * (b - a);
const round = (x: number) => Math.round(x);
/** Log-uniform in [a, b]: short and long faults are both common. */
const logRnd = (r: () => number, a: number, b: number) => Math.round(Math.exp(rnd(r, Math.log(a), Math.log(b))));

export function genSchedule(seed: number, cfg: FuzzConfig): Fault[] {
  const r = mulberry32((seed * 2654435761) >>> 0 ^ 0x5bd1e995);
  const k = cfg.faults.min + Math.floor(r() * (cfg.faults.max - cfg.faults.min + 1));
  const out: Fault[] = [];
  for (let i = 0; i < k; i++) {
    const kinds = swarmOf(seed, cfg).kinds;
    const kind = kinds[Math.floor(r() * kinds.length)]!;
    const at = round(rnd(r, 50, cfg.faultEnd - 60));
    const node = Math.floor(r() * cfg.servers);
    let f: Fault;
    switch (kind) {
      case "restart": f = { kind, at, dur: logRnd(r, 1, 30), node }; break;
      case "restartVoter": f = { kind, at, dur: logRnd(r, 1, 30) }; break;
      case "isolateNewLeader": f = { kind, at, dur: logRnd(r, 20, 500) }; break;
      case "crashAfterCommit": f = { kind, at, dur: logRnd(r, 5, 500) }; break;
      case "crash": case "crashLeader": f = { kind, at, dur: logRnd(r, 5, 500), node }; break;
      case "isolate": case "isolateLeader": f = { kind, at, dur: logRnd(r, 20, 500), node }; break;
      case "split": {
        const m = Math.floor((cfg.servers - 1) / 2) || 1;
        const ids = [...Array(cfg.servers).keys()].map((x) => ({ x, k: r() })).sort((a, b) => a.k - b.k).map((o) => o.x);
        f = { kind, at, dur: logRnd(r, 20, 500), side: ids.slice(0, m).sort((a, b) => a - b) };
        break;
      }
      case "drop": f = { kind, at, dur: logRnd(r, 20, 400), x: Math.round(rnd(r, 0.1, 0.5) * 100) / 100 }; break;
      case "delay": f = { kind, at, dur: logRnd(r, 20, 400), x: round(rnd(r, 40, 150)) }; break;
      case "pause": case "pauseLeader": f = { kind, at, dur: logRnd(r, 10, 400), node }; break;
      case "skew": f = { kind, at, dur: round(rnd(r, 300, 900)), node, x: Math.round(rnd(r, 0.3, 0.6) * 100) / 100 }; break;
    }
    out.push(f);
  }
  return out.sort((a, b) => a.at - b.at);
}

export function faultText(f: Fault): string {
  const s = (i: number | undefined) => `S${(i ?? 0) + 1}`;
  const span = `at ${f.at} ms for ${f.dur} ms`;
  switch (f.kind) {
    case "restart": return `restart ${s(f.node)} ${span}`;
    case "isolateNewLeader": return `from ${f.at} ms, cut off the next new leader after its first append, for ${f.dur} ms`;
    case "crashAfterCommit": return `from ${f.at} ms, crash the next leader that commits, for ${f.dur} ms`;
    case "restartVoter": return `from ${f.at} ms, restart the next server that grants a vote, for ${f.dur} ms`;
    case "crash": return `crash ${s(f.node)} ${span}`;
    case "crashLeader": return `crash the leader ${span}`;
    case "isolate": return `cut off ${s(f.node)} ${span}`;
    case "isolateLeader": return `cut off the leader ${span}`;
    case "split": return `split {${f.side!.map(s).join(",")}} from the rest ${span}`;
    case "drop": return `lose ${Math.round(f.x! * 100)}% of messages ${span}`;
    case "delay": return `delays up to ${f.x} ms ${span}`;
    case "pause": return `pause ${s(f.node)} ${span}`;
    case "pauseLeader": return `pause the leader ${span}`;
    case "skew": return `${s(f.node)} clock runs at ${f.x}× ${span}`;
  }
}

// ---------------------------------------------------------------- one run

export type FailureKind = "linearizability" | "raft";

export interface RunResult {
  seed: number;
  schedule: Fault[];
  ok: boolean;
  failure: { kind: FailureKind; text: string; t: number; ops: number[] } | null;
  /** The checker gave up (budget): neither pass nor fail. */
  unknown: boolean;
  ops: number;
  completed: number;
  /** FNV-1a hash of every network event and every operation: two runs with equal fingerprints did the same thing. */
  fingerprint: string;
  /** What the faults hit, and what rare events the run reached. */
  coverage: Coverage;
}

export interface Coverage {
  faults: Partial<Record<FaultKind, number>>;
  /** Faults whose target led at the time. */
  leaderHits: number;
  elections: number;
  truncations: number;
  snapshots: number;
  retries: number;
  dupSuppressed: number;
  readIndexRounds: number;
  leaseReads: number;
}

interface Active { drops: number[]; delays: number[] }

/**
 * The fuzzer's workload: each client loops get (40%), put (30%), cas (20%) and del (10%) on `keys`, with think time
 * in [think.min, think.max] ms, until `stopAt`. Each client has its own generator, so its sequence of operations does
 * not depend on timing. Write values are unique; a cas expects the value that the client last saw.
 */
export function attachWorkload(s: KvStore, seed: number, keys: string[], think: { min: number; max: number }, stopAt = Infinity) {
  const lastSeen = new Map<string, number>();
  for (const cl of s.clients) {
    const r = mulberry32((seed * 31 + cl.index * 1009 + 5) >>> 0);
    let k = 0;
    const nextOp = (): StoreOp => {
      const key = keys[Math.floor(r() * keys.length)]!;
      const u = r();
      const value = (cl.index + 1) * 10000 + ++k;
      if (u < 0.4) return { kind: "get", key };
      if (u < 0.7) return { kind: "put", key, value };
      if (u < 0.9) return { kind: "cas", key, expect: lastSeen.get(`${cl.index}:${key}`) ?? 0, value };
      return { kind: "del", key };
    };
    const wait = () => s.net.setTimer(cl.node, rnd(r, think.min, think.max), "think");
    cl.onTag = (tag) => {
      if (tag === "think" && s.now < stopAt) cl.submit(nextOp());
    };
    cl.onDone = (rec: OpRecord) => {
      if (rec.value !== undefined) lastSeen.set(`${cl.index}:${rec.op.key}`, rec.op.kind === "cas" && rec.ok ? rec.op.value! : rec.value);
      wait();
    };
    wait();
  }
}

export interface SimRun { store: KvStore; result: RunResult; resolved: (NodeId | null)[] }

export function runSim(seed: number, schedule: Fault[], cfg: FuzzConfig): SimRun {
  const storeCfg: Partial<StoreConfig> = {
    servers: cfg.servers, clients: cfg.clients, seed, latency: cfg.latency, readMode: cfg.readMode, bugs: cfg.bugs, record: true, restartGuard: cfg.restartGuard,
  };
  const s = new KvStore(storeCfg);
  const baseMax = cfg.latency.max;
  const active: Active = { drops: [], delays: [] };
  const resolved: (NodeId | null)[] = schedule.map(() => null);
  const cov: Coverage = { faults: {}, leaderHits: 0, elections: 0, truncations: 0, snapshots: 0, retries: 0, dupSuppressed: 0, readIndexRounds: 0, leaseReads: 0 };

  attachWorkload(s, seed, cfg.keys, { min: cfg.think.min * swarmOf(seed, cfg).slow, max: cfg.think.max * swarmOf(seed, cfg).slow }, cfg.faultEnd + cfg.work);

  // Fault events in time order: each fault starts and ends.
  type Ev = { t: number; i: number; start: boolean };
  const evs: Ev[] = [];
  schedule.forEach((f, i) => {
    evs.push({ t: f.at, i, start: true });
    evs.push({ t: Math.min(f.at + f.dur, cfg.faultEnd), i, start: false });
  });
  evs.sort((a, b) => a.t - b.t || Number(a.start) - Number(b.start) || a.i - b.i);

  const target = (f: Fault, i: number, start: boolean): NodeId => {
    if (!start) return resolved[i] ?? 0;
    const lead = s.leader();
    const t = f.kind === "crashLeader" || f.kind === "isolateLeader" || f.kind === "pauseLeader" ? (lead ?? f.node ?? 0) : (f.node ?? 0);
    resolved[i] = t;
    if (t === lead) cov.leaderHits++;
    return t;
  };
  const applyNet = () => {
    s.setDropRate(active.drops.length ? Math.max(...active.drops) : 0);
    s.setMaxLatency(active.delays.length ? Math.max(baseMax, ...active.delays) : baseMax);
  };
  const remove = <T>(xs: T[], x: T) => { const k = xs.indexOf(x); if (k >= 0) xs.splice(k, 1); };
  const cutOf = new Map<number, number>();

  for (const e of evs) {
    s.runUntil(e.t);
    const f = schedule[e.i]!;
    if (e.start) cov.faults[f.kind] = (cov.faults[f.kind] ?? 0) + 1;
    switch (f.kind) {
      case "restartVoter": if (e.start) s.armRestartVoter(f.dur); break;
      case "isolateNewLeader": if (e.start) s.armIsolateNewLeader(f.dur); break;
      case "crashAfterCommit": if (e.start) s.armCrashAfterCommit(f.dur); break;
      case "restart": case "crash": case "crashLeader": {
        const t = target(f, e.i, e.start);
        if (e.start) s.crash(t);
        else s.recover(t);
        break;
      }
      case "isolate": case "isolateLeader": case "split": {
        if (e.start) cutOf.set(e.i, s.addCut(f.kind === "split" ? f.side! : [target(f, e.i, true)]));
        else s.removeCut(cutOf.get(e.i)!);
        break;
      }
      case "drop": if (e.start) active.drops.push(f.x!); else remove(active.drops, f.x!); applyNet(); break;
      case "delay": if (e.start) active.delays.push(f.x!); else remove(active.delays, f.x!); applyNet(); break;
      case "pause": case "pauseLeader": {
        const t = target(f, e.i, e.start);
        if (e.start) s.pause(t);
        else s.resume(t);
        break;
      }
      case "skew": {
        const t = target(f, e.i, e.start);
        s.setClockRate(t, e.start ? f.x! : 1);
        break;
      }
    }
  }
  // Every fault is over: heal, recover and resume everything, then let the clients finish.
  s.runUntil(cfg.faultEnd);
  s.armRestartVoter(null);
  s.armIsolateNewLeader(null);
  s.armCrashAfterCommit(null);
  s.heal();
  s.setDropRate(0);
  s.setMaxLatency(baseMax);
  for (let i = 0; i < cfg.servers; i++) {
    s.resume(i);
    s.recover(i);
    s.setClockRate(i, 1);
  }
  s.runUntil(cfg.faultEnd + cfg.work + cfg.drain);

  // Checks.
  const raft = s.raftViolations();
  let failure: RunResult["failure"] = null;
  let unknown = false;
  if (raft.length) failure = { kind: "raft", text: `${raft[0]!.property}: ${raft[0]!.detail}`, t: raft[0]!.t, ops: [] };
  const lin = s.check();
  if (lin.ok === null) unknown = true;
  else if (!lin.ok && !failure) {
    const bad = lin.blocked.length ? lin.blocked : [];
    const recs = bad.map((id) => s.ops[id]!).filter(Boolean);
    const t = recs.length ? Math.min(...recs.map((o) => o.call)) : 0;
    failure = { kind: "linearizability", text: `no valid order for ${recs.length} operation${recs.length === 1 ? "" : "s"} after the first ${lin.best.length}`, t, ops: bad };
  }

  for (const e of s.cluster.events) {
    if (e.kind === "role" && e.role === "leader") cov.elections++;
    else if (e.kind === "truncate") cov.truncations++;
    else if (e.kind === "snapshot" || e.kind === "install") cov.snapshots++;
  }
  cov.retries = s.ops.reduce((a, o) => a + Math.max(0, o.tries - 1), 0);
  cov.dupSuppressed = s.counters.dupSuppressed;
  cov.readIndexRounds = s.counters.readIndexRounds;
  cov.leaseReads = s.counters.readsByLease;

  const result: RunResult = {
    seed, schedule, ok: failure === null, failure, unknown,
    ops: s.ops.length, completed: s.ops.filter((o) => Number.isFinite(o.ret)).length,
    fingerprint: fingerprint(s), coverage: cov,
  };
  return { store: s, result, resolved };
}

/** FNV-1a over every network event and every operation. */
export function fingerprint(s: KvStore): string {
  let h = 0x811c9dc5;
  const mix = (x: string) => {
    for (let i = 0; i < x.length; i++) {
      h ^= x.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const e of s.net.trace) {
    if (e.kind === "send" || e.kind === "deliver" || e.kind === "lose") mix(`${e.kind}${e.t.toFixed(6)}#${e.msg.id}${e.msg.from}>${e.msg.to}${e.msg.payload.type};`);
    else if (e.kind === "timer" || e.kind === "crash" || e.kind === "recover" || e.kind === "note") mix(`${e.kind}${e.t.toFixed(6)}@${e.node};`);
    else mix(`${e.kind}${e.t.toFixed(6)};`);
  }
  for (const o of s.ops) mix(`${o.id}:${o.client}:${o.op.kind}${o.op.key}${o.op.value ?? ""}:${o.call.toFixed(6)}-${o.ret}:${o.value ?? ""}${o.ok ?? ""};`);
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------- shrinking

export interface ShrinkStep { tries: number; faults: number }

/**
 * Greedy shrinking with the seed fixed: drop one fault at a time, then halve fault lengths, and keep each change
 * that still fails with the same kind of failure. Stops at a 1-minimal schedule.
 */
export function* shrink(seed: number, schedule: Fault[], cfg: FuzzConfig): Generator<ShrinkStep, { schedule: Fault[]; tries: number; result: RunResult }> {
  const kind = runSim(seed, schedule, cfg).result.failure?.kind;
  let cur = schedule;
  let best = runSim(seed, cur, cfg).result;
  let tries = 0;
  const fails = (cand: Fault[]) => {
    tries++;
    const r = runSim(seed, cand, cfg).result;
    if (r.failure?.kind === kind) { best = r; return true; }
    return false;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < cur.length; i++) {
      const cand = cur.filter((_, j) => j !== i);
      const ok = fails(cand);
      yield { tries, faults: ok ? cand.length : cur.length };
      if (ok) { cur = cand; changed = true; i--; }
    }
    for (let i = 0; i < cur.length; i++) {
      const f = cur[i]!;
      if (f.dur < 10) continue;
      const cand = cur.map((g, j) => (j === i ? { ...g, dur: Math.round(g.dur / 2) } : g));
      const ok = fails(cand);
      yield { tries, faults: cur.length };
      if (ok) { cur = cand; changed = true; }
    }
  }
  return { schedule: cur, tries, result: best };
}

export function shrinkAll(seed: number, schedule: Fault[], cfg: FuzzConfig) {
  const g = shrink(seed, schedule, cfg);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

// ---------------------------------------------------------------- campaigns

export interface CampaignState {
  runs: number;
  passed: number;
  unknown: number;
  ops: number;
  faults: Partial<Record<FaultKind, number>>;
  totals: Omit<Coverage, "faults">;
  firstFail: RunResult | null;
}

/** Runs seeds start, start + 1, ... and keeps totals. */
export class Campaign {
  s: CampaignState = {
    runs: 0, passed: 0, unknown: 0, ops: 0, faults: {}, firstFail: null,
    totals: { leaderHits: 0, elections: 0, truncations: 0, snapshots: 0, retries: 0, dupSuppressed: 0, readIndexRounds: 0, leaseReads: 0 },
  };
  constructor(readonly cfg: FuzzConfig, public next = 1) {}
  run(k: number) {
    for (let i = 0; i < k && !this.s.firstFail; i++) {
      const seed = this.next++;
      const r = runSim(seed, genSchedule(seed, this.cfg), this.cfg).result;
      this.add(r);
    }
  }
  add(r: RunResult) {
    const s = this.s;
    s.runs++;
    s.ops += r.ops;
    if (r.ok && !r.unknown) s.passed++;
    if (r.unknown) s.unknown++;
    for (const [k, v] of Object.entries(r.coverage.faults)) s.faults[k as FaultKind] = (s.faults[k as FaultKind] ?? 0) + v;
    for (const k of Object.keys(s.totals) as (keyof CampaignState["totals"])[]) s.totals[k] += r.coverage[k];
    if (!r.ok && !s.firstFail) s.firstFail = r;
  }
}

/** The first failing seed in [1, limit] for a configuration, or null. */
export function firstFailingSeed(cfg: FuzzConfig, limit: number, start = 1): RunResult | null {
  const c = new Campaign(cfg, start);
  while (c.s.runs < limit && !c.s.firstFail) c.run(1);
  return c.s.firstFail;
}
