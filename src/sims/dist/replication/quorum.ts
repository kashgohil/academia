/**
 * A Dynamo-style leaderless store for one key, on the shared Net.
 *
 * Nodes 0..N-1 are the home replicas of the key, in preference-list order. Nodes N..N+spares-1 are the next
 * nodes on the ring, which stand in for a home replica in a sloppy quorum. The nodes after them are clients,
 * which also act as coordinators. A write goes to N replicas and succeeds after W acks. A read goes to N replicas
 * (or to a chosen list) and returns the newest of the first R answers. Versions are timestamps: last write wins.
 *
 * The coordinator knows which nodes are down (a perfect failure detector), which keeps the model small.
 */
import { Net } from "../net";
import { mulberry32 } from "../../rng";

export type QMsg =
  | { k: "put"; op: number; value: number; ts: number; hint?: number }
  | { k: "putOk"; op: number }
  | { k: "get"; op: number }
  | { k: "getOk"; op: number; value: number; ts: number };

/** Time a replica takes to answer (model input): usually fast, sometimes slow (a GC pause, a busy disk). */
export interface ServiceModel {
  fast: [number, number];
  slowProb: number;
  slow: [number, number];
}

export const SERVICE_DEFAULT: ServiceModel = { fast: [0.5, 3], slowProb: 0.05, slow: [20, 100] };
export const SERVICE_NONE: ServiceModel = { fast: [0, 0], slowProb: 0, slow: [0, 0] };

export interface QuorumConfig {
  seed: number;
  n: number;
  w: number;
  r: number;
  spares: number;
  clients: number;
  sloppy: boolean;
  /** none; async: repair stale replicas after the read returns; blocking: repair them before it returns. */
  readRepair: "none" | "async" | "blocking";
  latency: { min: number; max: number };
  service: ServiceModel;
  timeoutMs: number;
  /** How often a node with hints checks whether their owners are back. */
  handoffMs: number;
}

export const QUORUM_DEFAULTS: QuorumConfig = {
  seed: 1,
  n: 3,
  w: 2,
  r: 2,
  spares: 2,
  clients: 1,
  sloppy: false,
  readRepair: "none",
  latency: { min: 2, max: 8 },
  service: SERVICE_NONE,
  timeoutMs: 60,
  handoffMs: 40,
};

export interface QOp {
  id: number;
  kind: "write" | "read";
  client: number;
  start: number;
  end?: number;
  ok?: boolean;
  targets: number[];
  need: number;
  /** Nodes that answered, in order. */
  from: number[];
  value?: number;
  ts?: number;
  /** read: the answers seen. */
  answers: { node: number; value: number; ts: number }[];
  /** Blocking read repair: replicas still to confirm. */
  repairing?: Set<number>;
  /** Write: the value and its timestamp. */
  wValue?: number;
  wTs?: number;
}

export class QuorumSim {
  readonly net: Net<QMsg>;
  readonly cfg: QuorumConfig;
  readonly store: { value: number; ts: number }[];
  readonly hints: { owner: number; value: number; ts: number }[][];
  readonly ops: QOp[] = [];
  /** A repair put has an op id above this. */
  private repairOps = new Map<number, { read: number; node: number }>();
  private nextRepair = 1e6;
  private held = new Map<number, { to: number; p: QMsg }>();
  private clock = 0;

  constructor(cfg: QuorumConfig) {
    this.cfg = cfg;
    const M = cfg.n + cfg.spares;
    this.store = Array.from({ length: M }, () => ({ value: 0, ts: 0 }));
    this.hints = Array.from({ length: M }, () => []);
    this.net = new Net<QMsg>(M + cfg.clients, { seed: cfg.seed, latency: cfg.latency, fifo: false }, {
      onMessage: (node, msg, n) => this.onMessage(node, msg.from, msg.payload, n),
      onTimer: (node, tag, n) => this.onTimer(node, tag, n),
      // Timers do not fire on a crashed node, so a recovered node restarts its handoff loop.
      onRecover: (node, n) => node < M && n.setTimer(node, cfg.handoffMs, "handoff"),
    });
    for (let i = 0; i < M; i++) this.net.setTimer(i, cfg.handoffMs, "handoff");
  }

  get replicas() {
    return this.cfg.n + this.cfg.spares;
  }
  client(i = 0) {
    return this.replicas + i;
  }

  private service() {
    const s = this.cfg.service, rnd = () => this.net.random();
    const base = rnd() < s.slowProb ? s.slow[0] + rnd() * (s.slow[1] - s.slow[0]) : s.fast[0] + rnd() * (s.fast[1] - s.fast[0]);
    return base;
  }

  /** The N nodes an operation goes to, and for each stand-in the home node it stands in for. */
  targets(): { node: number; hint?: number }[] {
    const { n } = this.cfg;
    const home = Array.from({ length: n }, (_, i) => i);
    if (!this.cfg.sloppy) return home.map((node) => ({ node }));
    const up = Array.from({ length: this.replicas }, (_, i) => i).filter((i) => this.net.isUp(i)).slice(0, n);
    const missing = home.filter((h) => !up.includes(h));
    return up.map((node) => (node < n ? { node } : { node, hint: missing.shift() }));
  }

  /** `delays[node]`: hold the message to that node back for this long (to script a slow path). */
  write(value: number, client = 0, delays?: number[]): QOp {
    const c = this.client(client);
    const ts = Math.max(++this.clock, this.net.now * 1000); // microsecond-like timestamps, always increasing
    const t = this.targets();
    const op: QOp = { id: this.ops.length, kind: "write", client: c, start: this.net.now, targets: t.map((x) => x.node), need: this.cfg.w, from: [], answers: [], wValue: value, wTs: ts };
    this.ops.push(op);
    for (const x of t) {
      const p: QMsg = { k: "put", op: op.id, value, ts, hint: x.hint };
      const d = delays?.[x.node] ?? 0;
      if (d > 0) {
        this.held.set(this.held.size, { to: x.node, p });
        this.net.setTimer(c, d, `send:${this.held.size - 1}`);
      } else this.net.send(c, x.node, p);
    }
    this.net.setTimer(c, this.cfg.timeoutMs, `timeout:${op.id}`);
    return op;
  }

  read(client = 0, only?: number[]): QOp {
    const c = this.client(client);
    const t = only ?? this.targets().map((x) => x.node);
    const op: QOp = { id: this.ops.length, kind: "read", client: c, start: this.net.now, targets: t, need: this.cfg.r, from: [], answers: [] };
    this.ops.push(op);
    for (const node of t) this.net.send(c, node, { k: "get", op: op.id });
    this.net.setTimer(c, this.cfg.timeoutMs, `timeout:${op.id}`);
    return op;
  }

  private finish(op: QOp, ok: boolean) {
    if (op.end !== undefined) return;
    op.end = this.net.now;
    op.ok = ok;
  }

  private onMessage(node: number, from: number, p: QMsg, n: Net<QMsg>) {
    if (p.k === "put" || p.k === "get") {
      n.setTimer(node, this.service(), `${p.k}:${from}:${JSON.stringify(p)}`);
      return;
    }
    if (p.k === "putOk") {
      const rep = this.repairOps.get(p.op);
      if (rep) {
        const read = this.ops[rep.read]!;
        read.repairing?.delete(rep.node);
        if (read.repairing && read.repairing.size === 0 && read.end === undefined) this.finish(read, true);
        return;
      }
      const op = this.ops[p.op];
      if (!op || op.kind !== "write") return;
      op.from.push(from);
      if (op.from.length === op.need) this.finish(op, true);
      return;
    }
    const op = this.ops[p.op]!;
    op.from.push(from);
    op.answers.push({ node: from, value: p.value, ts: p.ts });
    if (op.answers.length === op.need && op.end === undefined) {
      const best = op.answers.reduce((a, b) => (b.ts > a.ts ? b : a));
      op.value = best.value;
      op.ts = best.ts;
      if (this.cfg.readRepair === "blocking") {
        const stale = op.answers.filter((a) => a.ts < best.ts);
        if (stale.length) {
          op.repairing = new Set(stale.map((a) => a.node));
          for (const a of stale) this.repair(op, a.node, best, n);
          return;
        }
      }
      this.finish(op, true);
      if (this.cfg.readRepair === "async") for (const a of op.answers) if (a.ts < best.ts) this.repair(op, a.node, best, n);
    } else if (this.cfg.readRepair === "async" && op.ts !== undefined && p.ts < op.ts) {
      // A late answer: the read has returned, but the coordinator still repairs the stale replica.
      this.repair(op, from, { value: op.value!, ts: op.ts }, n);
    }
  }

  private repair(op: QOp, node: number, best: { value: number; ts: number }, n: Net<QMsg>) {
    const id = this.nextRepair++;
    this.repairOps.set(id, { read: op.id, node });
    n.send(op.client, node, { k: "put", op: id, value: best.value, ts: best.ts });
  }

  private onTimer(node: number, tag: string, n: Net<QMsg>) {
    if (tag === "handoff") {
      const keep: typeof this.hints[number] = [];
      for (const h of this.hints[node]!) {
        if (n.isUp(h.owner)) n.send(node, h.owner, { k: "put", op: -1, value: h.value, ts: h.ts });
        else keep.push(h);
      }
      this.hints[node] = keep;
      n.setTimer(node, this.cfg.handoffMs, "handoff");
      return;
    }
    if (tag.startsWith("send:")) {
      const h = this.held.get(Number(tag.slice(5)))!;
      n.send(node, h.to, h.p);
      return;
    }
    if (tag.startsWith("timeout:")) {
      const op = this.ops[Number(tag.slice(8))]!;
      if (op.end === undefined) this.finish(op, false);
      return;
    }
    const i1 = tag.indexOf(":"), i2 = tag.indexOf(":", i1 + 1);
    const kind = tag.slice(0, i1), from = Number(tag.slice(i1 + 1, i2));
    const p = JSON.parse(tag.slice(i2 + 1)) as QMsg;
    if (kind === "put" && p.k === "put") {
      const s = this.store[node]!;
      if (p.ts > s.ts) this.store[node] = { value: p.value, ts: p.ts };
      if (p.hint !== undefined) this.hints[node]!.push({ owner: p.hint, value: p.value, ts: p.ts });
      if (p.op >= 0) n.send(node, from, { k: "putOk", op: p.op });
    } else if (kind === "get") {
      const s = this.store[node]!;
      n.send(node, from, { k: "getOk", op: (p as { op: number }).op, value: s.value, ts: s.ts });
    }
  }
}

// ============================================================================ one write, then one read

/** What happens to one home replica: up all the time, down during the write (back for the read), down during the read, or both. */
export type Fail = "up" | "write" | "read" | "both";
export const FAILS: Fail[] = ["up", "write", "read", "both"];

export interface Scenario {
  sim: QuorumSim;
  write: QOp;
  read: QOp;
  readAt: number;
  /** Read and write both succeeded, and the read returned the write. */
  fresh: boolean | undefined;
}

/**
 * Crashes the "write" and "both" replicas, writes 1, and waits for the write to finish (or fail). Then it brings the
 * "write" replicas back, waits `gapMs`, crashes the "read" replicas, and reads.
 */
export function runScenario(cfg: QuorumConfig, fails: Fail[], gapMs: number, tail = 120): Scenario {
  const sim = new QuorumSim(cfg);
  const net = sim.net;
  fails.forEach((f, i) => (f === "write" || f === "both") && net.crash(i));
  const write = sim.write(1);
  while (write.end === undefined && net.step());
  fails.forEach((f, i) => f === "write" && net.recover(i));
  const readAt = Math.max(net.now, write.end ?? net.now) + gapMs;
  net.runUntil(readAt);
  fails.forEach((f, i) => f === "read" && net.crash(i));
  const read = sim.read();
  net.runUntil(readAt + tail);
  const fresh = write.ok && read.ok ? read.ts! >= write.wTs! : undefined;
  return { sim, write, read, readAt, fresh };
}

export interface QuorumStats {
  runs: number;
  /** Among runs where the write and the read both succeeded. */
  freshRate: number;
  writeFail: number;
  readFail: number;
  both: number;
}

/** Many runs. Each home replica is down during the write with probability p, and during the read with probability p. */
export function quorumStats(cfg: QuorumConfig, p: number, gapMs: number, runs: number, seed = 1): QuorumStats {
  const rng = mulberry32(seed);
  let fresh = 0, both = 0, wf = 0, rf = 0;
  for (let k = 0; k < runs; k++) {
    const fails: Fail[] = Array.from({ length: cfg.n }, () => {
      const dw = rng() < p, dr = rng() < p;
      return dw && dr ? "both" : dw ? "write" : dr ? "read" : "up";
    });
    const s = runScenario({ ...cfg, seed: seed * 7919 + k }, fails, gapMs, cfg.timeoutMs + 20);
    if (!s.write.ok) wf++;
    else if (!s.read.ok) rf++;
    else {
      both++;
      if (s.fresh) fresh++;
    }
  }
  return { runs, freshRate: both ? fresh / both : NaN, writeFail: wf / runs, readFail: rf / runs, both };
}

/** Adds up runs made in chunks (a demo computes them in time slices). */
export function mergeStats(parts: QuorumStats[]): QuorumStats {
  const runs = parts.reduce((a, x) => a + x.runs, 0), both = parts.reduce((a, x) => a + x.both, 0);
  const fresh = parts.reduce((a, x) => a + (x.both ? x.freshRate * x.both : 0), 0);
  return {
    runs, both,
    freshRate: both ? fresh / both : NaN,
    writeFail: runs ? parts.reduce((a, x) => a + x.writeFail * x.runs, 0) / runs : NaN,
    readFail: runs ? parts.reduce((a, x) => a + x.readFail * x.runs, 0) / runs : NaN,
  };
}

/** The runs that the playground shows: `chunks` chunks of `per` runs, chunk k with seed k + 1. */
export const STATS_CHUNKS = 10, STATS_PER_CHUNK = 100;
export const statsChunk = (cfg: QuorumConfig, p: number, gapMs: number, k: number) => quorumStats({ ...cfg, seed: 1 }, p, gapMs, STATS_PER_CHUNK, k + 1);

// ============================================================================ latency of waiting for k of n

export interface LatencyStats {
  n: number;
  k: number;
  mean: number;
  p50: number;
  p99: number;
}

/** Sends one request to each of n replicas and waits for k answers, `samples` times. */
export function quorumLatency(n: number, k: number, samples: number, seed = 1, service = SERVICE_DEFAULT, latency = { min: 0.5, max: 1.5 }): LatencyStats {
  const sim = new QuorumSim({ ...QUORUM_DEFAULTS, seed, n, w: k, r: k, spares: 0, service, latency, timeoutMs: 1e6, handoffMs: 1e9 });
  const lat: number[] = [];
  for (let i = 0; i < samples; i++) {
    const op = sim.read();
    while (op.end === undefined && sim.net.step());
    lat.push(op.end! - op.start);
    sim.net.runUntil(sim.net.now + 500);
  }
  lat.sort((a, b) => a - b);
  const q = (x: number) => lat[Math.min(lat.length - 1, Math.floor(x * lat.length))]!;
  return { n, k, mean: lat.reduce((a, b) => a + b, 0) / lat.length, p50: q(0.5), p99: q(0.99) };
}

// ============================================================================ a quorum that is not linearizable

export interface LinScenario {
  sim: QuorumSim;
  write: QOp;
  readA: QOp;
  readB: QOp;
  /** B started after A finished and saw an older value. */
  violation: boolean;
}

/**
 * N = 3, W = 3, R = 2. The write reaches replica 0 quickly and replicas 1 and 2 slowly. Reader A asks replicas 0
 * and 1; reader B starts after A has finished and asks replicas 1 and 2.
 */
export function runLinScenario(blocking: boolean): LinScenario {
  const sim = new QuorumSim({
    ...QUORUM_DEFAULTS, seed: 2, n: 3, w: 3, r: 2, spares: 0, clients: 3,
    readRepair: blocking ? "blocking" : "none", latency: { min: 4, max: 6 }, timeoutMs: 200,
  });
  const net = sim.net;
  const write = sim.write(1, 0, [0, 70, 70]);
  net.runUntil(12);
  const readA = sim.read(1, [0, 1]);
  while (readA.end === undefined && net.step());
  net.runUntil(net.now + 3);
  const readB = sim.read(2, [1, 2]);
  net.runAll();
  const violation = readA.ok === true && readB.ok === true && readB.ts! < readA.ts!;
  return { sim, write, readA, readB, violation };
}
