/**
 * The life of one request in a range-partitioned replicated store, layer by layer, measured on the real sims.
 *
 * The keyspace has three ranges. Each range is its own KvStore (store.ts): three replicas in a Raft group. A meta
 * range maps keys to ranges, as CockroachDB's meta ranges do. The gateway is the client node of each store, so the
 * forward hop, the Raft round and the reply are all real messages on the deterministic network. Two hops are a model:
 * the application to the gateway and back, each one the mean one-way delay of the delay model.
 *
 * A transaction across two ranges follows the shape of CockroachDB's parallel commits: the coordinator writes an
 * intent in each range and a STAGING transaction record at the same time (one consensus round, in parallel), answers
 * the client, and then resolves the intents in the background.
 */
import type { NodeId } from "../net";
import { KvStore, type ReadMode, type StoreOp } from "./store";

export interface Range { id: string; lo: string; hi: string; replicas: string[] }

/** Three ranges over five machines. Each range has three replicas. Keys are lower-case words. */
export const RANGES: Range[] = [
  { id: "r1", lo: "a", hi: "h", replicas: ["n1", "n2", "n3"] },
  { id: "r2", lo: "h", hi: "p", replicas: ["n2", "n4", "n5"] },
  { id: "r3", lo: "p", hi: "~", replicas: ["n1", "n3", "n5"] },
];
export const META = { id: "meta", replicas: ["n3", "n4", "n5"] };

export function rangeOf(key: string): Range {
  return RANGES.find((r) => key >= r.lo && key < r.hi) ?? RANGES[RANGES.length - 1]!;
}

export type ArchOp = "put" | "get" | "cas" | "txn";

export interface ArchOptions {
  op: ArchOp;
  key: string;
  /** txn only: the second key, in another range. */
  key2: string;
  readMode: Exclude<ReadMode, "local">;
  /** The gateway already knows which range holds the key. */
  cached: boolean;
  seed: number;
}

export const ARCH_DEFAULT: ArchOptions = { op: "put", key: "cat", key2: "mouse", readMode: "readindex", cached: true, seed: 3 };

/** Model input: one-way delay in ms (the same delay model as every store in this module). */
export const ARCH_LATENCY = { min: 5, max: 15 };
const MEAN_HOP = (ARCH_LATENCY.min + ARCH_LATENCY.max) / 2;

export type LayerId = "api" | "route" | "txn" | "lead" | "raft" | "sm";

export interface LayerWork {
  id: LayerId;
  name: string;
  /** What this layer did, one short line each. */
  did: string[];
  msgs: number;
  /** ms spent in this layer on the critical path. */
  ms: number;
  active: boolean;
}

export interface ArchTrace {
  layers: LayerWork[];
  msgs: number;
  ms: number;
  /** Messages sent after the client got its answer (intent resolution). */
  background: number;
  result: string;
}

interface Measured {
  ms: number;
  /** Request and reply between gateway and leader, including redirects. */
  fwd: number;
  fwdMs: number;
  /** AppendEntries carrying the entry, and their replies. */
  repl: number;
  /** ReadIndex pings and acks. */
  ri: number;
  value?: number;
  ok?: boolean;
  index: number;
  via?: string;
  leader: NodeId;
  applied: number;
}

/** A settled store for one range, with a fixed seed, so that every trace starts from the same state. */
function freshStore(seed: number, readMode: Exclude<ReadMode, "local">, preload: string[] = []): KvStore {
  const s = new KvStore({ servers: 3, clients: 3, seed, latency: ARCH_LATENCY, readMode });
  s.settle();
  // Every key that the trace touches already holds the value 3.
  for (const k of preload) s.propose({ op: "put", key: k, value: 3 });
  // Wait for the lease (if any) and an idle moment.
  s.run(120);
  for (const c of s.clients) c.leaderGuess = s.leader()!;
  return s;
}

/** Runs ops (one per client) at the same time on a settled store and measures the slowest. */
function measure(seed: number, readMode: Exclude<ReadMode, "local">, ops: StoreOp[]): Measured {
  const s = freshStore(seed, readMode, ops.map((o) => o.key));
  const t0 = s.now, m0 = s.net.messages.length, idx0 = s.node(s.leader()!).lastIndex;
  ops.forEach((op, i) => s.clients[i]!.submit(op));
  s.runUntilTrue(() => s.clients.every((c) => !c.busy), 2000, 0.25);
  const recs = s.ops.slice(-ops.length);
  const end = Math.max(...recs.map((r) => r.ret));
  const L = s.leader()!;
  let fwd = 0, repl = 0, ri = 0;
  for (let k = m0; k < s.net.messages.length; k++) {
    const m = s.net.messages[k]!;
    if (m.sentAt > end) break;
    const p = m.payload as { type: string; entries?: unknown[] };
    if (p.type === "ClientRequest" || p.type === "ClientReply" || p.type === "Read" || p.type === "ReadReply") fwd++;
    else if (p.type === "RiPing" || p.type === "RiAck") ri++;
    else if (p.type === "AppendEntries" && p.entries!.length) repl += m.deliveredAt !== undefined ? 2 : 1; // the entries and their reply
  }
  const r = recs[recs.length - 1]!;
  const reqs = s.net.messages.slice(m0).filter((m) => m.payload.type === "ClientRequest" || (m.payload as { type: string }).type === "Read");
  const replies = s.net.messages.slice(m0).filter((m) => m.payload.type === "ClientReply" || (m.payload as { type: string }).type === "ReadReply");
  const fwdMs = reqs.length && replies.length ? (reqs[0]!.deliveredAt! - reqs[0]!.sentAt) + (replies.at(-1)!.deliveredAt! - replies.at(-1)!.sentAt) : 0;
  return {
    ms: end - t0, fwd, fwdMs, repl, ri, value: r.value, ok: r.ok, index: s.node(L).lastIndex, via: r.via, leader: L,
    applied: s.cluster.nodes.filter((n) => n.lastApplied > idx0).length,
  };
}

const memo = new Map<string, ArchTrace>();

export function traceOp(o: ArchOptions): ArchTrace {
  const key = JSON.stringify(o);
  const hit = memo.get(key);
  if (hit) return hit;
  const r = rangeOf(o.key);
  const seedOf = (rg: { id: string }) => o.seed * 10 + (rg.id === "meta" ? 0 : Number(rg.id.slice(1)));
  const layers: LayerWork[] = [];
  const add = (l: Omit<LayerWork, "active"> & { active?: boolean }) => layers.push({ active: true, ...l });

  add({ id: "api", name: "Client API", did: [`${o.op === "txn" ? `txn(put ${o.key}, put ${o.key2})` : o.op === "get" ? `get(${o.key})` : o.op === "cas" ? `cas(${o.key}, 3→7)` : `put(${o.key}, 7)`} reaches the gateway`, "the gateway answers when the layers below are done"], msgs: 2, ms: 2 * MEAN_HOP });

  // Routing: the range cache, or a lookup in the meta range.
  const keys = o.op === "txn" ? [o.key, o.key2] : [o.key];
  const rs = keys.map(rangeOf);
  if (o.cached) {
    add({ id: "route", name: "Routing", did: rs.map((x, i) => `${keys[i]} → ${x.id} [${x.lo}, ${x.hi === "~" ? "end" : x.hi}) from the range cache`), msgs: 0, ms: 0 });
  } else {
    const meta = measure(seedOf(META), "readindex", [{ kind: "get", key: `range:${o.key}` }]);
    add({ id: "route", name: "Routing", did: ["cache miss: read the meta range (a linearizable read)", ...rs.map((x, i) => `${keys[i]} → ${x.id}, leader on ${x.replicas[0]}`)], msgs: meta.fwd + meta.ri, ms: meta.ms });
  }

  let background = 0;
  let result = "";
  if (o.op === "txn") {
    const r2 = rangeOf(o.key2);
    const a = measure(seedOf(r), o.readMode, [{ kind: "put", key: `intent:${o.key}`, value: 7 }, { kind: "put", key: "txn-record", value: 1 }]);
    const b = measure(seedOf(r2), o.readMode, [{ kind: "put", key: `intent:${o.key2}`, value: 7 }]);
    const ms = Math.max(a.ms, b.ms);
    add({ id: "txn", name: "Transactions", did: [`write intent on ${o.key} (${r.id}) and on ${o.key2} (${r2.id})`, `write the STAGING record in ${r.id}, at the same time`, "all three replicate: commit is implicit, answer the client", "later: resolve both intents (background)"], msgs: 0, ms: 0 });
    add({ id: "lead", name: "Leader / leaseholder", did: [`${r.id} leader proposes 2 entries`, `${r2.id} leader proposes 1 entry`], msgs: a.fwd + b.fwd, ms: Math.max(a.fwdMs, b.fwdMs) });
    add({ id: "raft", name: "Raft log", did: [`${r.id}: AppendEntries to 2 followers, majority acks`, `${r2.id}: the same, in parallel`], msgs: a.repl + b.repl, ms: ms - Math.max(a.fwdMs, b.fwdMs) });
    add({ id: "sm", name: "State machine", did: ["each leader applies its entries: intents are provisional values", "a reader that meets an intent checks the transaction record"], msgs: 0, ms: 0 });
    const ra = measure(seedOf(r) + 100, o.readMode, [{ kind: "put", key: o.key, value: 7 }]);
    const rb = measure(seedOf(r2) + 100, o.readMode, [{ kind: "put", key: o.key2, value: 7 }]);
    background = ra.fwd + ra.repl + rb.fwd + rb.repl;
    result = "committed";
  } else {
    const op: StoreOp = o.op === "get" ? { kind: "get", key: o.key } : o.op === "cas" ? { kind: "cas", key: o.key, expect: 3, value: 7 } : { kind: "put", key: o.key, value: 7 };
    const m = measure(seedOf(r), o.readMode, [op]);
    add({ id: "txn", name: "Transactions", did: ["single key: no transaction record (one-phase commit)"], msgs: 0, ms: 0, active: false });
    const isRead = o.op === "get";
    add({ id: "lead", name: "Leader / leaseholder", did: [`forward to the ${r.id} leader (replica ${r.replicas[m.leader]})`, isRead ? (o.readMode === "lease" ? "lease is valid: no round needed" : o.readMode === "readindex" ? "note commit index, confirm leadership" : "append a get entry to the log") : `append entry ${m.index} to its log`], msgs: m.fwd, ms: m.fwdMs });
    const raftMs = Math.max(0, m.ms - m.fwdMs);
    if (isRead && o.readMode !== "log") {
      add({ id: "raft", name: "Raft log", did: o.readMode === "lease" ? ["nothing: the lease stands in for a heartbeat round"] : ["ReadIndex: heartbeat round to the followers", "a majority confirms the term"], msgs: m.ri, ms: raftMs, active: o.readMode !== "lease" });
    } else {
      add({ id: "raft", name: "Raft log", did: ["AppendEntries to 2 followers", "a majority stores the entry: commit"], msgs: m.repl, ms: raftMs });
    }
    add({ id: "sm", name: "State machine", did: isRead && o.readMode !== "log" ? [`read ${o.key} from the leader's map: ${m.value}`] : [m.applied === 1 ? "the leader applies it and answers; followers apply when they learn the commit" : `apply on ${m.applied} replicas`, o.op === "cas" ? `cas ${m.ok ? "succeeds" : "fails"}` : o.op === "get" ? `value ${m.value}` : "map[key] = 7, revision + 1"], msgs: 0, ms: 0 });
    result = o.op === "get" ? `value ${m.value}` : o.op === "cas" ? (m.ok ? "ok" : "failed") : "ok";
  }
  const out: ArchTrace = { layers, msgs: layers.reduce((a, l) => a + l.msgs, 0), ms: layers.reduce((a, l) => a + l.ms, 0), background, result };
  memo.set(key, out);
  return out;
}

// ---------------------------------------------------------------- read paths, measured

export interface ReadCost { mode: Exclude<ReadMode, "local">; meanMs: number; msgsPerRead: number; reads: number }

/**
 * Mean read latency and messages per read for each read path: `clients` clients, each doing `reads` gets in a
 * loop on a settled healthy cluster of `servers` servers. The client sits one network hop from the leader.
 */
export function readCost(mode: Exclude<ReadMode, "local">, servers = 3, reads = 40, seed = 7): ReadCost {
  const s = new KvStore({ servers, clients: 1, seed, latency: ARCH_LATENCY, readMode: mode });
  s.settle();
  s.run(120);
  s.clients[0]!.leaderGuess = s.leader()!;
  const m0 = s.net.messages.length;
  for (let i = 0; i < reads; i++) s.clients[0]!.submit({ kind: "get", key: "x" });
  s.runUntilTrue(() => !s.clients[0]!.busy, 20000, 1);
  const done = s.ops.filter((o) => Number.isFinite(o.ret));
  let msgs = 0;
  for (let k = m0; k < s.net.messages.length; k++) {
    const t = (s.net.messages[k]!.payload as { type: string; entries?: unknown[] }).type;
    const e = (s.net.messages[k]!.payload as { entries?: unknown[] }).entries;
    if (t === "Read" || t === "ReadReply" || t === "RiPing" || t === "RiAck" || t === "ClientRequest" || t === "ClientReply") msgs++;
    else if (t === "AppendEntries" && e!.length) msgs += s.net.messages[k]!.deliveredAt !== undefined ? 2 : 1;
  }
  return { mode, meanMs: done.reduce((a, o) => a + (o.ret - o.call), 0) / done.length, msgsPerRead: msgs / done.length, reads: done.length };
}

/** Mean write latency (put) for one client in a loop, the same setup as readCost. */
export function writeCost(servers = 3, writes = 40, seed = 7): { meanMs: number; msgsPerWrite: number } {
  const s = new KvStore({ servers, clients: 1, seed, latency: ARCH_LATENCY, readMode: "readindex" });
  s.settle();
  s.run(120);
  s.clients[0]!.leaderGuess = s.leader()!;
  const m0 = s.net.messages.length;
  for (let i = 0; i < writes; i++) s.clients[0]!.submit({ kind: "put", key: "x", value: i + 1 });
  s.runUntilTrue(() => !s.clients[0]!.busy, 20000, 1);
  const done = s.ops.filter((o) => Number.isFinite(o.ret));
  let msgs = 0;
  for (let k = m0; k < s.net.messages.length; k++) {
    const m = s.net.messages[k]!;
    const p = m.payload as { type: string; entries?: unknown[] };
    if (p.type === "ClientRequest" || p.type === "ClientReply") msgs++;
    else if (p.type === "AppendEntries" && p.entries!.length) msgs += m.deliveredAt !== undefined ? 2 : 1;
  }
  return { meanMs: done.reduce((a, o) => a + (o.ret - o.call), 0) / done.length, msgsPerWrite: msgs / done.length };
}
