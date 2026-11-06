/**
 * Rebalancing a cluster that grows from 3 to 6 nodes while its data grows, under four strategies:
 * - modulo: a key goes to node hash(key) mod N (the baseline that moves almost everything);
 * - fixed: P partitions made at the start, moved whole to new nodes (Riak, Elasticsearch, Couchbase);
 * - dynamic: key ranges split when they pass a size limit and move one by one (HBase, CockroachDB);
 * - proportional: each node owns a fixed number of random tokens, so partitions per node stay fixed (Cassandra).
 *
 * The data is spread evenly over a hash space [0, 1), so a piece [a, b) holds (b − a) · D(t) bytes.
 * Every node has a transfer budget per second for inbound and outbound copies together (model input). A piece
 * stays on its old node until its copy completes. Splits only change metadata, so they move no bytes.
 */
import { mulberry32 } from "../../rng";
import { murmur3 } from "../../db/lsm/hash";

export type Strategy = "modulo" | "fixed" | "dynamic" | "proportional";
export const STRATEGIES: Strategy[] = ["modulo", "fixed", "dynamic", "proportional"];

export interface RebalanceCfg {
  strategy: Strategy;
  startNodes: number;
  endNodes: number;
  /** Minutes at which nodes join, one each. */
  joinAt: number[];
  minutes: number;
  /** Data at the start and at the end, in GB (model inputs). It grows linearly. */
  dataStartGB: number;
  dataEndGB: number;
  /** Copy budget of each node, inbound and outbound together, in MB/s (model input). */
  rateMBs: number;
  /** fixed: the number of partitions. */
  partitions: number;
  /** dynamic: the split size in GB. */
  maxRangeGB: number;
  /** proportional: tokens per node. */
  tokens: number;
  seed: number;
}

export const REBALANCE_DEFAULTS: RebalanceCfg = {
  strategy: "fixed", startNodes: 3, endNodes: 6, joinAt: [30, 90, 150], minutes: 240,
  dataStartGB: 300, dataEndGB: 450, rateMBs: 40, partitions: 64, maxRangeGB: 4, tokens: 16, seed: 3,
};

interface Piece {
  a: number;
  b: number;
  owner: number;
  /** Where it is going, if a move is planned. */
  to?: number;
  /** GB copied so far. */
  done?: number;
  /** Size in GB when the copy started: the cost of the move. */
  cost?: number;
  /** modulo: the cell number, for the hash. */
  cell?: number;
}

export interface Frame {
  t: number;
  nodes: number;
  /** GB per node. */
  perNode: number[];
  maxOverMean: number;
  /** GB copied so far, all moves together. */
  movedGB: number;
  /** GB still to copy for moves already planned. */
  pendingGB: number;
  pieces: number;
}

export interface RebalanceRun {
  cfg: RebalanceCfg;
  frames: Frame[];
  movedGB: number;
  /** Minutes with max/mean above 1.1. */
  unbalancedMin: number;
  finalMaxOverMean: number;
  pieces: number;
  /** The largest piece at the end, in GB. */
  largestGB: number;
}

const MODULO_CELLS = 1024;

export function simulateRebalance(partial: Partial<RebalanceCfg> = {}): RebalanceRun {
  const cfg: RebalanceCfg = { ...REBALANCE_DEFAULTS, ...partial };
  const rng = mulberry32(cfg.seed);
  const data = (t: number) => cfg.dataStartGB + ((cfg.dataEndGB - cfg.dataStartGB) * t) / cfg.minutes;
  let N = cfg.startNodes;
  let pieces: Piece[] = [];
  /** proportional: the tokens, as [position, node], sorted. */
  let tokens: [number, number][] = [];

  // ---- initial layout
  if (cfg.strategy === "modulo") {
    for (let c = 0; c < MODULO_CELLS; c++) pieces.push({ a: c / MODULO_CELLS, b: (c + 1) / MODULO_CELLS, owner: murmur3(`cell${c}`) % N, cell: c });
  } else if (cfg.strategy === "fixed") {
    for (let p = 0; p < cfg.partitions; p++) pieces.push({ a: p / cfg.partitions, b: (p + 1) / cfg.partitions, owner: p % N });
  } else if (cfg.strategy === "dynamic") {
    pieces = [{ a: 0, b: 1, owner: 0 }];
    splitBig(pieces, data(0), cfg.maxRangeGB);
    pieces.forEach((p, i) => (p.owner = i % N));
  } else {
    for (let n = 0; n < N; n++) for (let i = 0; i < cfg.tokens; i++) tokens.push([rng(), n]);
    tokens.sort((x, y) => x[0] - y[0]);
    pieces = arcs(tokens);
  }

  const frames: Frame[] = [];
  let moved = 0;
  for (let t = 0; t <= cfg.minutes; t++) {
    const D = data(t);
    // ---- a node joins
    if (cfg.joinAt.includes(t) && N < cfg.endNodes) {
      N++;
      if (cfg.strategy === "modulo") {
        for (const p of pieces) {
          const want = murmur3(`cell${p.cell}`) % N;
          if (want === p.to || (want === p.owner && p.to === undefined)) continue;
          p.to = want === p.owner ? undefined : want;
          p.cost = undefined;
          p.done = undefined;
        }
      } else if (cfg.strategy === "proportional") {
        const fresh: [number, number][] = [];
        for (let i = 0; i < cfg.tokens; i++) fresh.push([rng(), N - 1]);
        // Split every piece at the new tokens; the part that now ends at a new token goes to the new node.
        tokens = [...tokens, ...fresh].sort((x, y) => x[0] - y[0]);
        const next: Piece[] = [];
        for (const arc of arcs(tokens)) {
          // the old owner of this arc is the owner of the old piece that contains its midpoint
          const mid = arc.a < arc.b ? (arc.a + arc.b) / 2 : ((arc.a + arc.b + 1) / 2) % 1;
          const old = pieces.find((p) => (p.a <= p.b ? mid >= p.a && mid < p.b : mid >= p.a || mid < p.b))!;
          next.push({ a: arc.a, b: arc.b, owner: old.owner, to: arc.owner !== old.owner ? arc.owner : old.to });
        }
        pieces = next;
      }
    }
    // ---- dynamic: split ranges that passed the limit (metadata only)
    if (cfg.strategy === "dynamic") splitBig(pieces, D, cfg.maxRangeGB);
    // ---- fixed and dynamic: the balancer plans moves from the fullest to the emptiest node
    if (cfg.strategy === "fixed" || cfg.strategy === "dynamic") planGreedy(pieces, N, D);
    // ---- copy, with a per-node budget for inbound and outbound together
    const budget = new Array<number>(N).fill((cfg.rateMBs * 60) / 1000); // GB per minute
    for (const p of pieces) {
      if (p.to === undefined) continue;
      if (p.cost === undefined) { p.cost = size(p, D); p.done = 0; }
      const step = Math.min(budget[p.owner]!, budget[p.to]!, p.cost - p.done!);
      if (step <= 0) continue;
      budget[p.owner]! -= step;
      budget[p.to]! -= step;
      p.done! += step;
      moved += step;
      if (p.done! >= p.cost - 1e-9) { p.owner = p.to; p.to = undefined; p.cost = undefined; p.done = undefined; }
    }
    // ---- record
    const perNode = new Array<number>(N).fill(0);
    let pending = 0;
    for (const p of pieces) {
      perNode[p.owner]! += size(p, D);
      if (p.to !== undefined) pending += (p.cost ?? size(p, D)) - (p.done ?? 0);
    }
    const mean = D / N;
    frames.push({ t, nodes: N, perNode, maxOverMean: Math.max(...perNode) / mean, movedGB: moved, pendingGB: pending, pieces: pieces.length });
  }
  const last = frames[frames.length - 1]!;
  return {
    cfg, frames, movedGB: moved,
    unbalancedMin: frames.filter((f) => f.maxOverMean > 1.1).length,
    finalMaxOverMean: last.maxOverMean,
    pieces: pieces.length,
    largestGB: Math.max(...pieces.map((p) => size(p, data(cfg.minutes)))),
  };
}

/** The length of a piece of the hash space; a piece with b < a wraps around 1. */
const span = (p: { a: number; b: number }) => (p.b > p.a ? p.b - p.a : 1 - p.a + p.b);
const size = (p: Piece, D: number) => span(p) * D;

/** The arcs of a token ring: each arc (previous token, token] belongs to the token's node. */
function arcs(tokens: [number, number][]): Piece[] {
  return tokens.map(([pos, node], i) => ({ a: i === 0 ? tokens[tokens.length - 1]![0] : tokens[i - 1]![0], b: pos, owner: node }));
}

/** Splits, in place, every piece that is not moving and is larger than the limit, into halves. */
function splitBig(pieces: Piece[], D: number, maxGB: number) {
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (p.to === undefined && size(p, D) > maxGB) {
      const m = (p.a + p.b) / 2;
      pieces.splice(i, 1, { a: p.a, b: m, owner: p.owner }, { a: m, b: p.b, owner: p.owner });
      i--;
    }
  }
}

/**
 * Plans moves until no single move makes the fullest and the emptiest node closer. It counts planned moves as
 * done, so it never plans the same correction twice. Each move strictly lowers the sum of squared loads, so it ends.
 */
function planGreedy(pieces: Piece[], N: number, D: number) {
  const proj = new Array<number>(N).fill(0);
  for (const p of pieces) proj[p.to ?? p.owner]! += size(p, D);
  for (let guard = 0; guard < 10000; guard++) {
    let src = 0, dst = 0;
    for (let n = 1; n < N; n++) { if (proj[n]! > proj[src]!) src = n; if (proj[n]! < proj[dst]!) dst = n; }
    const gap = proj[src]! - proj[dst]!;
    let best: Piece | undefined;
    for (const p of pieces) {
      if (p.owner !== src || p.to !== undefined) continue;
      const s = size(p, D);
      if (s >= gap - 1e-9) continue; // would not help
      if (!best || Math.abs(gap / 2 - s) < Math.abs(gap / 2 - size(best, D))) best = p;
    }
    if (!best) return;
    best.to = dst;
    const s = size(best, D);
    proj[src]! -= s;
    proj[dst]! += s;
  }
}

// ---------------------------------------------------------------- the split and merge stepper

export type Burst = "sequential" | "hot-range" | "uniform";

export interface SplitCfg {
  burst: Burst;
  /** Split a range when it holds more than this (MB, a scaled-down model input). */
  maxMB: number;
  /** Merge two neighbours when together they hold less than this (MB). */
  minMB: number;
  /** Split a range when it serves more than this many writes per second (0: off). */
  loadSplitQps: number;
  ticks: number;
  /** The burst runs from tick 0 to this tick; then a TTL job deletes the burst data. */
  burstEnd: number;
  nodes: number;
}

export const SPLIT_DEFAULTS: SplitCfg = { burst: "hot-range", maxMB: 64, minMB: 24, loadSplitQps: 0, ticks: 40, burstEnd: 22, nodes: 3 };

/** The key space of the stepper: keys 0..999. */
export const SPLIT_KEYS = 1000;

export interface SplitRange { lo: number; hi: number; node: number; mb: number; qps: number }
export interface SplitFrame { tick: number; ranges: SplitRange[]; nodeQps: number[]; event: string; kind: "write" | "split" | "move" | "merge" | "delete" | "idle" }

/** Writes per tick of the burst (each write is 64 KB, so 160 writes per second add 10 MB per tick). */
const BURST_QPS = 1600, WRITE_KB = 64, TICK_S = 0.1;

/**
 * A range-partitioned table under a write burst. Each tick writes, then does at most one split, one move and
 * one merge, as CockroachDB's split, replicate and merge queues each do one thing at a time.
 * The table starts as one range on node 0, as a new HBase or CockroachDB table does.
 */
export function simulateSplits(partial: Partial<SplitCfg> = {}): SplitFrame[] {
  const cfg: SplitCfg = { ...SPLIT_DEFAULTS, ...partial };
  const bytes = new Float64Array(SPLIT_KEYS); // MB per key
  for (let k = 0; k < SPLIT_KEYS; k++) bytes[k] = 0.02; // 20 MB of old data in all
  const burstBytes = new Float64Array(SPLIT_KEYS);
  let ranges: { lo: number; hi: number; node: number }[] = [{ lo: 0, hi: SPLIT_KEYS, node: 0 }];
  const frames: SplitFrame[] = [];
  const rng = mulberry32(11);
  for (let tick = 0; tick <= cfg.ticks; tick++) {
    const qpsKey = new Float64Array(SPLIT_KEYS);
    const events: string[] = [];
    let kind: SplitFrame["kind"] = "idle";
    // writes
    if (tick > 0 && tick <= cfg.burstEnd) {
      const writes = Math.round(BURST_QPS * TICK_S);
      for (let w = 0; w < writes; w++) {
        const k = cfg.burst === "uniform" ? Math.floor(rng() * SPLIT_KEYS)
          : cfg.burst === "hot-range" ? 300 + Math.floor(rng() * 60)
          : Math.min(SPLIT_KEYS - 1, 400 + Math.floor(((tick - 1) * writes + w) / 8));
        bytes[k]! += WRITE_KB / 1024;
        burstBytes[k]! += WRITE_KB / 1024;
        qpsKey[k]! += 1 / TICK_S;
      }
      kind = "write";
      events.push(`${int(BURST_QPS)} writes per second.`);
    } else if (tick > cfg.burstEnd) {
      // the TTL job deletes a quarter of the remaining burst data each tick
      let freed = 0;
      for (let k = 0; k < SPLIT_KEYS; k++) { const d = burstBytes[k]! * 0.25; burstBytes[k]! -= d; bytes[k]! -= d; freed += d; }
      if (freed > 0.5) { kind = "delete"; events.push(`A TTL job deletes ${freed.toFixed(0)} MB of burst data.`); }
    }
    const mb = (r: { lo: number; hi: number }) => { let s = 0; for (let k = r.lo; k < r.hi; k++) s += bytes[k]!; return s; };
    const qps = (r: { lo: number; hi: number }) => { let s = 0; for (let k = r.lo; k < r.hi; k++) s += qpsKey[k]!; return s; };
    // one split: by size first, then by load
    const bySize = ranges.filter((r) => r.hi - r.lo > 1 && mb(r) > cfg.maxMB).sort((x, y) => mb(y) - mb(x))[0];
    const byLoad = cfg.loadSplitQps > 0 ? ranges.filter((r) => r.hi - r.lo > 1 && qps(r) > cfg.loadSplitQps).sort((x, y) => qps(y) - qps(x))[0] : undefined;
    const victim = bySize ?? byLoad;
    if (victim) {
      // split at the key that halves the size (or the load, for a load split)
      const w = bySize ? bytes : qpsKey;
      let total = 0;
      for (let k = victim.lo; k < victim.hi; k++) total += w[k]!;
      let acc = 0, at = victim.lo + 1;
      for (let k = victim.lo; k < victim.hi - 1; k++) { acc += w[k]!; if (acc >= total / 2) { at = k + 1; break; } }
      const before = bySize ? `${mb(victim).toFixed(0)} MB` : `${int(qps(victim))} writes/s`;
      ranges.splice(ranges.indexOf(victim), 1, { lo: victim.lo, hi: at, node: victim.node }, { lo: at, hi: victim.hi, node: victim.node });
      kind = "split";
      events.push(`Range [${victim.lo}, ${victim.hi}) has ${before}. It splits at key ${at}.`);
    }
    // one move: the busiest node by load (or by range count when idle) gives a range to the least busy
    const nodeQ = new Array<number>(cfg.nodes).fill(0), nodeN = new Array<number>(cfg.nodes).fill(0);
    for (const r of ranges) { nodeQ[r.node]! += qps(r); nodeN[r.node]!++; }
    const busy = tick <= cfg.burstEnd && tick > 0;
    const key = busy ? nodeQ : nodeN;
    let src = 0, dst = 0;
    for (let n = 1; n < cfg.nodes; n++) { if (key[n]! > key[src]!) src = n; if (key[n]! < key[dst]!) dst = n; }
    // Move only if it narrows the gap clearly: a range with at most 60% of the gap, and a gap of at least 10% of the
    // load (or two ranges). Without this margin, noise in the per-tick load makes a range bounce between nodes.
    const gap = key[src]! - key[dst]!;
    const total = key.reduce((a, b) => a + b, 0);
    const worth = busy ? gap > 0.1 * total : gap >= 2;
    const cand = ranges.filter((r) => r.node === src).map((r) => ({ r, w: busy ? qps(r) : 1 })).filter((c) => c.w > 0 && (busy ? c.w <= 0.6 * gap : c.w < gap)).sort((x, y) => y.w - x.w)[0];
    if (cand && src !== dst && worth) {
      cand.r.node = dst;
      if (kind !== "split") kind = "move";
      events.push(`Range [${cand.r.lo}, ${cand.r.hi}) moves from node ${src} to node ${dst} (${mb(cand.r).toFixed(0)} MB copied).`);
    }
    // one merge: two neighbours with little data, after the burst
    if (tick > cfg.burstEnd) {
      for (let i = 0; i + 1 < ranges.length; i++) {
        const l = ranges[i]!, r = ranges[i + 1]!;
        if (mb(l) + mb(r) < cfg.minMB) {
          ranges.splice(i, 2, { lo: l.lo, hi: r.hi, node: l.node });
          kind = "merge";
          events.push(`Ranges [${l.lo}, ${l.hi}) and [${r.lo}, ${r.hi}) hold ${(mb(l) + mb(r)).toFixed(0)} MB together. They merge${l.node !== r.node ? ` after the right one moves to node ${l.node}` : ""}.`);
          break;
        }
      }
    }
    const out = ranges.map((r) => ({ ...r, mb: mb(r), qps: qps(r) }));
    const nodeQps = new Array<number>(cfg.nodes).fill(0);
    for (const r of out) nodeQps[r.node]! += r.qps;
    frames.push({ tick, ranges: out, nodeQps, event: tick === 0 ? "A new table: one range on node 0." : events.join(" ") || "Nothing to do.", kind: tick === 0 ? "idle" : kind });
  }
  return frames;
}

const int = (v: number) => Math.round(v).toLocaleString("en-US");

/** The data that must move for perfect balance: at each join, the new node's fair share D(t)/N of the data. */
export function idealMovedGB(partial: Partial<RebalanceCfg> = {}): number {
  const cfg: RebalanceCfg = { ...REBALANCE_DEFAULTS, ...partial };
  let N = cfg.startNodes, total = 0;
  for (const t of cfg.joinAt) {
    if (N >= cfg.endNodes) break;
    N++;
    total += (cfg.dataStartGB + ((cfg.dataEndGB - cfg.dataStartGB) * t) / cfg.minutes) / N;
  }
  return total;
}
