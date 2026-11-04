/**
 * Group commit, as a discrete-event simulation.
 *
 * N clients loop forever: run a transaction on a CPU core (cpuMs), then commit.
 * - "per-commit": each commit does its own log flush; flushes run one at a time.
 * - "group": a commit that finds the log device idle becomes the leader. It (optionally) waits
 *   commitDelayMs, then flushes the records of every commit that is waiting (the followers).
 *   Commits that arrive during a flush wait for the next one.
 * - "async": commit returns at once (PostgreSQL synchronous_commit = off). A WAL writer flushes
 *   every walWriterMs. A crash loses the commits that were acknowledged but not flushed.
 *
 * Times are in milliseconds.
 */

import { mulberry32, type Rng } from "../../rng";

export type CommitMode = "per-commit" | "group" | "async";

export interface GcParams {
  clients: number;
  fsyncMs: number;
  mode: CommitMode;
  /** CPU time per transaction. */
  cpuMs?: number;
  cores?: number;
  /** Leader waits this long before the flush (PostgreSQL commit_delay). */
  commitDelayMs?: number;
  /** Wait only when at least this many other clients are busy (PostgreSQL commit_siblings). */
  commitSiblings?: number;
  /** Flush interval of the WAL writer in async mode (PostgreSQL wal_writer_delay). */
  walWriterMs?: number;
  /** CPU time varies uniformly in cpuMs × [1 − jitter, 1 + jitter], so clients do not run in lock step. */
  jitter?: number;
  seed?: number;
}

export const GC_DEFAULTS = { cpuMs: 0.2, cores: 8, commitDelayMs: 0, commitSiblings: 5, walWriterMs: 200, jitter: 0.5, seed: 1 };

type ClientState = "cpu" | "ready" | "queued" | "flushing";

/** One log flush: the clients it carries (batch) and the number of commits it makes durable (count). */
export interface Flush { start: number; end: number; batch: number[]; count: number }

export class GroupCommitSim {
  readonly p: Required<GcParams>;
  t = 0;
  clients: { state: ClientState; until: number; since: number }[];
  ready: number[] = [];
  queue: number[] = [];
  flush: Flush | null = null;
  leaderWaitUntil: number | null = null;
  /** Async mode: acknowledgement times of commits that are not durable yet. */
  unflushed: number[] = [];
  /** Async mode: how many of `unflushed` the current flush covers (a prefix). */
  private inFlush = 0;
  private nextWriter: number;
  coresFree: number;
  commits = 0;
  latencySum = 0;
  latencies: number[] = [];
  flushes = 0;
  batchSum = 0;
  /** Async mode: the largest number of acknowledged commits that a crash would lose, and their oldest age. */
  maxAtRisk = 0;
  maxRiskAgeMs = 0;
  /** The most recent flushes (for drawing). */
  recent: Flush[] = [];
  private rng: Rng;

  constructor(p: GcParams) {
    this.p = { ...GC_DEFAULTS, ...p } as Required<GcParams>;
    this.rng = mulberry32(this.p.seed);
    this.coresFree = this.p.cores;
    this.clients = Array.from({ length: p.clients }, () => ({ state: "ready" as ClientState, until: 0, since: 0 }));
    this.ready = this.clients.map((_, i) => i);
    this.nextWriter = this.p.walWriterMs;
    this.schedule();
  }

  /** Time of the next event, or Infinity. */
  private nextEvent(): number {
    let n = Infinity;
    for (const c of this.clients) if (c.state === "cpu" && c.until < n) n = c.until;
    if (this.flush && this.flush.end < n) n = this.flush.end;
    if (this.leaderWaitUntil !== null && this.leaderWaitUntil < n) n = this.leaderWaitUntil;
    if (this.p.mode === "async" && this.nextWriter < n) n = this.nextWriter;
    return n;
  }

  /** Advances simulated time to `to`, handling every event on the way. */
  advanceTo(to: number): void {
    for (let guard = 0; guard < 1_000_000; guard++) {
      const e = this.nextEvent();
      if (e > to) break;
      this.t = e;
      this.handle();
    }
    this.t = to;
    this.trackRisk();
  }

  /** Runs until `n` more commits have completed. */
  runCommits(n: number): void {
    const goal = this.commits + n;
    while (this.commits < goal) {
      const e = this.nextEvent();
      if (!Number.isFinite(e)) break;
      this.t = e;
      this.handle();
    }
  }

  private handle() {
    const t = this.t, p = this.p;
    if (this.flush && this.flush.end <= t) {
      const f = this.flush;
      this.flush = null;
      if (p.mode === "async") {
        this.unflushed.splice(0, this.inFlush);
        this.inFlush = 0;
      } else {
        for (const i of f.batch) {
          const c = this.clients[i]!;
          const lat = t - c.since;
          this.commits++;
          this.latencySum += lat;
          if (this.latencies.length < 20000) this.latencies.push(lat);
          c.state = "ready";
          this.ready.push(i);
        }
      }
    }
    for (let i = 0; i < this.clients.length; i++) {
      const c = this.clients[i]!;
      if (c.state === "cpu" && c.until <= t) {
        this.coresFree++;
        if (p.mode === "async") {
          this.commits++;
          this.unflushed.push(t);
          c.state = "ready";
          this.ready.push(i);
        } else {
          c.state = "queued";
          c.since = t;
          this.queue.push(i);
        }
      }
    }
    if (p.mode === "async" && this.nextWriter <= t) {
      this.trackRisk();
      this.nextWriter = t + p.walWriterMs;
      if (!this.flush && this.unflushed.length) {
        this.inFlush = this.unflushed.length;
        this.startFlush([], this.inFlush);
      }
    }
    this.schedule();
  }

  private startFlush(batch: number[], count = batch.length) {
    const f = { start: this.t, end: this.t + this.p.fsyncMs, batch, count };
    for (const i of batch) this.clients[i]!.state = "flushing";
    this.flush = f;
    this.flushes++;
    this.batchSum += count;
    this.recent.push(f);
    if (this.recent.length > 40) this.recent.shift();
  }

  private schedule() {
    const p = this.p;
    while (this.coresFree > 0 && this.ready.length) {
      const i = this.ready.shift()!;
      const c = this.clients[i]!;
      c.state = "cpu";
      c.until = this.t + p.cpuMs * (1 - p.jitter + 2 * p.jitter * this.rng());
      this.coresFree--;
    }
    if (p.mode === "async" || this.flush || !this.queue.length) return;
    if (p.mode === "per-commit") {
      this.startFlush([this.queue.shift()!]);
      return;
    }
    if (p.commitDelayMs > 0) {
      if (this.leaderWaitUntil === null) {
        const busy = this.clients.filter((c) => c.state === "cpu" || c.state === "ready").length;
        if (busy >= p.commitSiblings) {
          this.leaderWaitUntil = this.t + p.commitDelayMs;
          return;
        }
      } else if (this.leaderWaitUntil > this.t) return;
    }
    this.leaderWaitUntil = null;
    const batch = this.queue;
    this.queue = [];
    this.startFlush(batch);
  }

  private trackRisk() {
    if (this.p.mode !== "async" || !this.unflushed.length) return;
    this.maxAtRisk = Math.max(this.maxAtRisk, this.unflushed.length);
    this.maxRiskAgeMs = Math.max(this.maxRiskAgeMs, this.t - this.unflushed[0]!);
  }

  /** Async mode: commits covered by the flush in progress. */
  get inFlushCount(): number { return this.inFlush; }
  get throughput(): number { return this.t > 0 ? (this.commits / this.t) * 1000 : 0; }
  get meanLatency(): number { return this.p.mode === "async" ? 0 : this.commits ? this.latencySum / this.commits : 0; }
  get meanBatch(): number { return this.flushes ? this.batchSum / this.flushes : 0; }
}

export interface GcSummary { clients: number; throughput: number; meanLatencyMs: number; meanBatch: number; flushesPerSec: number; maxAtRisk: number; maxRiskAgeMs: number }

/** Steady-state numbers: warm up, then measure over `commits` commits. */
export function gcSteady(p: GcParams, commits = 1500): GcSummary {
  const s = new GroupCommitSim(p);
  s.runCommits(Math.min(300, commits));
  const t0 = s.t, c0 = s.commits, l0 = s.latencySum, f0 = s.flushes, b0 = s.batchSum;
  if (p.mode === "async") s.advanceTo(s.t + Math.max(3 * (p.walWriterMs ?? GC_DEFAULTS.walWriterMs), 1));
  else s.runCommits(commits);
  const dt = s.t - t0, dc = s.commits - c0, df = s.flushes - f0;
  return {
    clients: p.clients,
    throughput: dt > 0 ? (dc / dt) * 1000 : 0,
    meanLatencyMs: p.mode === "async" ? 0 : dc ? (s.latencySum - l0) / dc : 0,
    meanBatch: df ? (s.batchSum - b0) / df : 0,
    flushesPerSec: dt > 0 ? (df / dt) * 1000 : 0,
    maxAtRisk: s.maxAtRisk,
    maxRiskAgeMs: s.maxRiskAgeMs,
  };
}

/** One full rotation of a disk spinning at `rpm`, in ms: the classic cost of a durable write on an HDD. */
export const rotationMs = (rpm: number) => 60_000 / rpm;

/** Device presets (rough, typical flush times; inputs to the model, not measurements). */
export const DEVICES = {
  hdd: { label: "HDD 7200 rpm", fsyncMs: rotationMs(7200) },
  ssd: { label: "Consumer SSD", fsyncMs: 1 },
  plp: { label: "SSD with power-loss protection", fsyncMs: 0.05 },
} as const;

export const CLIENT_COUNTS = [1, 2, 4, 8, 16, 32, 64, 128];

/** PostgreSQL's documented worst case for synchronous_commit = off: three WAL writer periods. */
export const pgAsyncRiskWindowMs = (walWriterDelayMs = 200) => 3 * walWriterDelayMs;
