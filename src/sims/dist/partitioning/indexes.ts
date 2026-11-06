/**
 * Secondary indexes across partitions.
 * - Local (document-partitioned): each partition indexes only its own rows. A write touches one partition; a
 *   query by the indexed column must ask every partition (scatter/gather).
 * - Global (term-partitioned): the index is partitioned by the indexed value. A query asks one index partition;
 *   a write may touch the row's partition and one or two index partitions.
 * Also: a race on the deterministic network between a write and a read of an asynchronous global index, and the
 * tail latency of scatter/gather.
 */
import { murmur3 } from "../../db/lsm/hash";
import { mulberry32 } from "../../rng";
import { Net } from "../net";

export const COLORS = ["red", "blue", "green", "black", "white", "silver", "yellow", "orange"] as const;
export type Color = (typeof COLORS)[number];

export interface Car { id: number; color: Color }

export const basePartition = (id: number, P: number) => murmur3(`car:${id}`) % P;
export const termPartition = (color: string, P: number) => murmur3(`color:${color}`) % P;

/** A small table of cars with seeded colors. */
export function makeCars(n: number, seed = 5): Car[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, id) => ({ id, color: COLORS[Math.floor(rng() * COLORS.length)]! }));
}

export type Design = "local" | "global";
export type Op = { kind: "query"; color: Color } | { kind: "insert"; color: Color } | { kind: "update"; id: number; to: Color };

export interface Touch {
  partition: number;
  role: "row read" | "index read" | "row write" | "index write";
}

export interface Route {
  touches: Touch[];
  /** Distinct partitions that the read visits. */
  readFanOut: number;
  /** Distinct partitions that the write changes. */
  writeFanOut: number;
  /** Rows that a query returns. */
  matches: number[];
}

/**
 * The partitions that an operation visits. With `covering`, a global index entry holds the row's columns, so a
 * query does not fetch the rows from their partitions.
 */
export function route(design: Design, op: Op, cars: readonly Car[], P: number, covering = false): Route {
  const touches: Touch[] = [];
  let matches: number[] = [];
  if (op.kind === "query") {
    matches = cars.filter((c) => c.color === op.color).map((c) => c.id);
    if (design === "local") for (let p = 0; p < P; p++) touches.push({ partition: p, role: "index read" });
    else {
      touches.push({ partition: termPartition(op.color, P), role: "index read" });
      if (!covering) for (const p of new Set(matches.map((id) => basePartition(id, P)))) touches.push({ partition: p, role: "row read" });
    }
  } else if (op.kind === "insert") {
    const p = basePartition(cars.length, P);
    touches.push({ partition: p, role: "row write" });
    touches.push({ partition: design === "local" ? p : termPartition(op.color, P), role: "index write" });
  } else {
    const car = cars[op.id]!;
    const p = basePartition(op.id, P);
    touches.push({ partition: p, role: "row write" });
    if (car.color !== op.to) {
      if (design === "local") touches.push({ partition: p, role: "index write" });
      else {
        touches.push({ partition: termPartition(car.color, P), role: "index write" });
        touches.push({ partition: termPartition(op.to, P), role: "index write" });
      }
    }
  }
  const distinct = (roles: Touch["role"][]) => new Set(touches.filter((t) => roles.includes(t.role)).map((t) => t.partition)).size;
  return { touches, matches, readFanOut: distinct(["row read", "index read"]), writeFanOut: distinct(["row write", "index write"]) };
}

// ---------------------------------------------------------------- the stale read race

export type IndexMode = "async" | "sync";

type RaceMsg =
  | { k: "write"; id: number; color: string }
  | { k: "ack" }
  | { k: "index-put"; id: number; color: string }
  | { k: "index-ok" }
  | { k: "query"; color: string }
  | { k: "result"; ids: number[] };

export interface RaceRun {
  net: Net<RaceMsg>;
  /** Time the client got the write acknowledgement. */
  ackAt: number;
  /** Time the index partition applied the entry. */
  indexAt: number;
  /** Time the read reached the index partition. */
  readServedAt: number;
  /** True if the read saw car 7 under "red". */
  sawWrite: boolean;
  /** The read started after the write was acknowledged and still missed it. */
  stale: boolean;
}

/**
 * Nodes: 0 client, 1 the row's partition, 2 the index partition for "red". The client repaints car 7 red at t = 0
 * and asks the index for red cars at `readAt`. In async mode the row partition acknowledges at once and sends the
 * index entry after `lagMs` (a queue, model input). In sync mode it updates the index first and acknowledges after.
 * Latency is fixed so that the learner's choice of `readAt` decides the order.
 */
export function indexRace(mode: IndexMode, readAt: number, lagMs: number): RaceRun {
  const index = new Set<number>();
  let ackAt = NaN, indexAt = NaN, readServedAt = NaN, sawWrite = false;
  let pendingAck = false;
  const net = new Net<RaceMsg>(3, { seed: 1, latency: { min: 10, max: 10 }, fifo: true }, {
    onMessage(node, msg, n) {
      const p = msg.payload;
      if (node === 1 && p.k === "write") {
        if (mode === "async") { n.send(1, 0, { k: "ack" }); n.setTimer(1, lagMs, "flush"); }
        else { pendingAck = true; n.send(1, 2, { k: "index-put", id: p.id, color: p.color }); }
      } else if (node === 2 && p.k === "index-put") {
        index.add(p.id); indexAt = n.now; n.note(2, "indexed");
        if (mode === "sync") n.send(2, 1, { k: "index-ok" });
      } else if (node === 1 && p.k === "index-ok" && pendingAck) {
        pendingAck = false; n.send(1, 0, { k: "ack" });
      } else if (node === 0 && p.k === "ack") ackAt = n.now;
      else if (node === 2 && p.k === "query") {
        readServedAt = n.now; sawWrite = index.has(7);
        n.send(2, 0, { k: "result", ids: [...index] });
      }
    },
    onTimer(node, tag, n) {
      if (node === 1 && tag === "flush") n.send(1, 2, { k: "index-put", id: 7, color: "red" });
    },
  });
  net.send(0, 1, { k: "write", id: 7, color: "red" });
  net.runUntil(readAt);
  net.send(0, 2, { k: "query", color: "red" });
  net.runAll();
  return { net, ackAt, indexAt, readServedAt, sawWrite, stale: !sawWrite && readAt >= ackAt };
}

// ---------------------------------------------------------------- scatter/gather tail latency

export interface ServiceModel {
  /** Mean of the usual, exponential service time (ms, model input). */
  fastMs: number;
  /** Probability of a slow response (a GC pause, a compaction: model input). */
  slowProb: number;
  /** The slow response time (ms, model input). */
  slowMs: number;
}

export const SERVICE_DEFAULTS: ServiceModel = { fastMs: 5, slowProb: 0.01, slowMs: 1000 };

/** P(one partition answers within t) under the model. */
export const serviceCdf = (t: number, m: ServiceModel) => (1 - m.slowProb) * (1 - Math.exp(-t / m.fastMs)) + (t >= m.slowMs ? m.slowProb : 0);

/** The probability that a query to P partitions waits for at least one slow one: 1 − (1 − q)^P. */
export const pAnySlow = (P: number, q: number) => 1 - Math.pow(1 - q, P);

/**
 * The p-quantile of the time to hear from all P partitions (network time excluded). The slowest of P has
 * CDF F(t)^P, so the quantile is the t with F(t) = p^(1/P).
 */
export function gatherQuantile(P: number, p: number, m: ServiceModel): number {
  const f = Math.pow(p, 1 / P);
  // below the slow time, only fast answers count; at the slow time the CDF jumps by slowProb
  const fastAtSlow = (1 - m.slowProb) * (1 - Math.exp(-m.slowMs / m.fastMs));
  if (f < fastAtSlow) {
    const t = -m.fastMs * Math.log(1 - f / (1 - m.slowProb));
    if (Number.isFinite(t) && t < m.slowMs) return t;
  }
  if (f <= fastAtSlow + m.slowProb + 1e-12) return m.slowMs;
  return -m.fastMs * Math.log(1 - (f - m.slowProb) / (1 - m.slowProb));
}

/**
 * Runs scatter/gather queries on the deterministic network: node 0 is the coordinator and nodes 1..P the
 * partitions. Each partition waits a service time drawn from the model (a timer), then answers. Returns the
 * latency of each query, in ms.
 */
export function scatterGather(P: number, queries: number, m: ServiceModel, seed = 1, latency = { min: 0.2, max: 0.6 }): number[] {
  type Msg = { k: "q" | "r"; q: number };
  const waiting = new Map<number, { start: number; left: number }>();
  const out: number[] = [];
  const net = new Net<Msg>(P + 1, { seed, latency }, {
    onMessage(node, msg, n) {
      if (msg.payload.k === "q") {
        const slow = n.random() < m.slowProb;
        const t = slow ? m.slowMs : -m.fastMs * Math.log(1 - n.random());
        n.setTimer(node, t, `${msg.payload.q}`);
      } else {
        const w = waiting.get(msg.payload.q)!;
        if (--w.left === 0) { out.push(n.now - w.start); waiting.delete(msg.payload.q); }
      }
    },
    onTimer(node, tag, n) {
      n.send(node, 0, { k: "r", q: Number(tag) });
    },
  });
  for (let q = 0; q < queries; q++) {
    net.runUntil(q * 2000);
    waiting.set(q, { start: net.now, left: P });
    for (let p = 1; p <= P; p++) net.send(0, p, { k: "q", q });
  }
  net.runAll(1e8);
  return out;
}

/** The p-quantile of a sample (nearest rank). */
export function quantile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}
