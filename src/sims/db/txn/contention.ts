/**
 * A closed-loop workload simulator for concurrency control under contention.
 *
 * `mpl` transactions run at the same time (multiprogramming level). When one commits, a new one starts.
 * Each transaction touches `ops` distinct items, chosen uniformly or with Zipf skew `theta`, and writes each item
 * with probability `writeFrac`. One access takes one tick; the commit takes one more tick.
 *
 * Protocols:
 * - detect, wait-die, wound-wait, no-wait: strict two-phase locking with that deadlock policy (see locks.ts).
 *   A read takes S, a write takes X directly (like SELECT ... FOR UPDATE), so there are no upgrades.
 * - occ: Kung-Robinson optimistic concurrency control with serial backward validation. Reads record the item
 *   version; at commit, the transaction aborts if any version changed, else it installs its writes.
 *
 * With a finite `cores`, at most that many transactions work in one tick, so work that an abort throws away
 * costs throughput. Waiting for a lock costs no core.
 *
 * An aborted transaction waits a random back-off of 1..ops ticks and then restarts the same accesses. It keeps
 * its first timestamp, so wait-die and wound-wait cannot starve it.
 */
import { mulberry32, type Rng } from "../../rng";
import { LockManager, type Policy } from "./locks";

export type Protocol = Policy | "occ";
export const PROTOCOLS: { id: Protocol; label: string }[] = [
  { id: "detect", label: "2PL + detection" },
  { id: "wait-die", label: "2PL + wait-die" },
  { id: "wound-wait", label: "2PL + wound-wait" },
  { id: "no-wait", label: "2PL + no-wait" },
  { id: "occ", label: "OCC" },
];

export interface WorkCfg {
  protocol: Protocol;
  mpl: number;
  items: number;
  ops: number;
  writeFrac: number;
  /** Zipf exponent; 0 means uniform. */
  theta: number;
  /** At most this many transactions do work (an access or a commit) in one tick: the CPU limit. */
  cores: number;
  ticks: number;
  /** Ticks at the start that are not measured. */
  warmup: number;
  seed: number;
}

export const DEFAULT_WORK: WorkCfg = { protocol: "detect", mpl: 8, items: 200, ops: 8, writeFrac: 0.5, theta: 0, cores: Infinity, ticks: 2000, warmup: 200, seed: 7 };

export interface WorkResult {
  commits: number;
  aborts: number;
  /** Commits per tick. */
  throughput: number;
  /** Aborts / (commits + aborts). */
  abortRate: number;
  /** Fraction of access ticks spent in attempts that later aborted. */
  wasted: number;
  /** Mean ticks from first start to commit. */
  latency: number;
}

/** Cumulative Zipf distribution over n ranks: P(rank i) ∝ 1 / (i + 1)^theta. */
export function zipfCdf(n: number, theta: number): Float64Array {
  const cdf = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) { s += 1 / Math.pow(i + 1, theta); cdf[i] = s; }
  for (let i = 0; i < n; i++) cdf[i]! /= s;
  return cdf;
}

export function sampleCdf(cdf: Float64Array, u: number): number {
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid]! >= u) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Probability that one access hits the hottest item. */
export const hottestShare = (n: number, theta: number) => zipfCdf(n, theta)[0]!;

interface Access { item: number; write: boolean }
interface Slot {
  id: number;
  ts: number;
  born: number;
  acc: Access[];
  pc: number;
  backoff: number;
  /** OCC: version seen by each read. */
  seen: number[];
  work: number;
}

function makeAccesses(rng: Rng, cdf: Float64Array, cfg: WorkCfg): Access[] {
  const picked = new Set<number>();
  const out: Access[] = [];
  while (out.length < Math.min(cfg.ops, cfg.items)) {
    const it = sampleCdf(cdf, rng());
    if (picked.has(it)) continue;
    picked.add(it);
    out.push({ item: it, write: rng() < cfg.writeFrac });
  }
  return out;
}

export function simulate(cfgIn: Partial<WorkCfg>): WorkResult {
  const cfg = { ...DEFAULT_WORK, ...cfgIn };
  const rng = mulberry32(cfg.seed);
  const cdf = zipfCdf(cfg.items, cfg.theta);
  const tsOf = new Map<number, number>();
  const lm = cfg.protocol === "occ" ? null : new LockManager(cfg.protocol, (t) => tsOf.get(t) ?? t);
  const version = new Int32Array(cfg.items);
  let nextId = 0, nextTs = 0;
  const fresh = (now: number): Slot => {
    const id = nextId++;
    const ts = nextTs++;
    tsOf.set(id, ts);
    return { id, ts, born: now, acc: makeAccesses(rng, cdf, cfg), pc: 0, backoff: 0, seen: [], work: 0 };
  };
  const slots: Slot[] = Array.from({ length: cfg.mpl }, () => fresh(0));
  let commits = 0, aborts = 0, wastedWork = 0, totalWork = 0, latencySum = 0;

  const restart = (s: Slot, now: number) => {
    if (now >= cfg.warmup) { aborts++; wastedWork += s.work; }
    s.backoff = 1 + Math.floor(rng() * cfg.ops);
    const id = nextId++;
    tsOf.set(id, s.ts);
    s.id = id;
    s.pc = 0;
    s.seen = [];
    s.work = 0;
  };

  for (let tick = 0; tick < cfg.ticks; tick++) {
    const measure = tick >= cfg.warmup;
    if (lm && cfg.protocol === "detect") lm.resolveDeadlocks();
    let busy = 0;
    for (let k = 0; k < slots.length; k++) {
      const si = (k + tick) % slots.length;
      const s = slots[si]!;
      if (s.backoff > 0) { s.backoff--; continue; }
      if (lm && lm.aborted.has(s.id)) { restart(s, tick); continue; }
      if (lm && lm.waitingOn(s.id) !== null) continue;
      if (busy >= cfg.cores) continue;
      busy++;
      if (lm) {
        if (s.pc < s.acc.length) {
          const a = s.acc[s.pc]!;
          const r = lm.request(s.id, `i${a.item}`, a.write ? "X" : "S");
          if (r.status === "granted") { s.pc++; s.work++; if (measure) totalWork++; }
          else if (r.status === "aborted") restart(s, tick);
        } else {
          lm.commit(s.id);
          if (measure) { commits++; latencySum += tick + 1 - s.born; }
          slots[si] = fresh(tick + 1);
        }
      } else {
        if (s.pc < s.acc.length) {
          s.seen[s.pc] = version[s.acc[s.pc]!.item]!;
          s.pc++;
          s.work++;
          if (measure) totalWork++;
        } else {
          const ok = s.acc.every((a, i) => version[a.item] === s.seen[i]);
          if (!ok) { restart(s, tick); continue; }
          for (const a of s.acc) if (a.write) version[a.item]!++;
          if (measure) { commits++; latencySum += tick + 1 - s.born; }
          slots[si] = fresh(tick + 1);
        }
      }
    }
  }
  const span = cfg.ticks - cfg.warmup;
  return {
    commits,
    aborts,
    throughput: commits / span,
    abortRate: commits + aborts ? aborts / (commits + aborts) : 0,
    wasted: totalWork ? wastedWork / totalWork : 0,
    latency: commits ? latencySum / commits : 0,
  };
}

/** MPL values used by the sweep plots. */
export const MPL_SWEEP = [1, 2, 4, 6, 8, 12, 16, 24, 32];
/** Zipf exponents used by the skew plots. */
export const THETA_SWEEP = [0, 0.2, 0.4, 0.6, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4];
