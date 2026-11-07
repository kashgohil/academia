/**
 * etcd, CockroachDB and DynamoDB side by side, from a stated model.
 *
 * Flows: the messages of one write and one read in each design, with times from two model inputs (a one-way delay
 * between machines and an fsync). The message names follow each system: etcd's raft messages (MsgProp, MsgApp,
 * MsgReadIndex), CockroachDB's BatchRequest to the leaseholder, DynamoDB's request router and storage replicas.
 *
 * Workload fit: each design against a workload's needs, with the capacity model of design.ts and the published limits
 * (etcd's suggested 8 GiB maximum, DynamoDB's 1,000 write units per second per partition, its 100-item transactions).
 */

export type SystemId = "etcd" | "crdb" | "dynamo";
export const SYSTEMS: { id: SystemId; name: string }[] = [
  { id: "etcd", name: "etcd" },
  { id: "crdb", name: "CockroachDB" },
  { id: "dynamo", name: "DynamoDB" },
];

/** Model inputs, ms. */
export const FLOW_INPUTS = { hop: 0.5, fsync: 1 };

export interface FlowMsg { from: number; to: number; sentAt: number; deliveredAt: number; label: string; critical: boolean }
export interface FlowMark { node: number; t: number; until?: number; label: string }
export interface Flow {
  nodes: string[];
  msgs: FlowMsg[];
  marks: FlowMark[];
  /** When the client has its answer. */
  end: number;
  /** One-way hops on the critical path (fsyncs not counted). */
  hops: number;
  messages: number;
}

class Builder {
  msgs: FlowMsg[] = [];
  marks: FlowMark[] = [];
  constructor(readonly nodes: string[]) {}
  send(from: number, to: number, t: number, label: string, critical = true) {
    const at = t + FLOW_INPUTS.hop;
    this.msgs.push({ from, to, sentAt: t, deliveredAt: at, label, critical });
    return at;
  }
  disk(node: number, t: number) {
    this.marks.push({ node, t, until: t + FLOW_INPUTS.fsync, label: "fsync" });
    return t + FLOW_INPUTS.fsync;
  }
  mark(node: number, t: number, label: string) {
    this.marks.push({ node, t, label });
  }
  done(end: number): Flow {
    return { nodes: this.nodes, msgs: this.msgs, marks: this.marks, end, hops: this.msgs.filter((m) => m.critical).length, messages: this.msgs.length };
  }
}

/**
 * A round from `leader` to its followers and back. With `fsync`, the leader and each follower write to disk first.
 * The leader goes on after `need` replies (and its own write). The messages that decide the time are critical.
 */
function round(b: Builder, leader: number, followers: number[], t: number, need: number, out: string, back: string, fsync: boolean): number {
  const own = fsync ? b.disk(leader, t) : t;
  const legs = followers.map((f) => {
    const go = b.send(leader, f, t, out, false);
    const ready = fsync ? b.disk(f, go) : go;
    const ret = b.send(f, leader, ready, back, false);
    return { go: b.msgs.length - 2, ret: b.msgs.length - 1, at: ret };
  }).sort((x, y) => x.at - y.at);
  for (let i = 0; i < need; i++) {
    b.msgs[legs[i]!.go]!.critical = true;
    b.msgs[legs[i]!.ret]!.critical = true;
  }
  return Math.max(own, legs[need - 1]!.at);
}

/**
 * One write and one read. `direct`: the client reaches the leader (etcd), or the gateway is the leaseholder
 * (CockroachDB); DynamoDB always goes through a request router. `eventual`: a read that may be stale (etcd's
 * serializable read, DynamoDB's eventually consistent read).
 */
export function flow(sys: SystemId, op: "write" | "read", direct = false, eventual = false): Flow {
  if (sys === "etcd") {
    // L is the leader; A and C are followers. The client talks to its endpoint: A, or L when direct.
    const b = new Builder(["client", "L lead", "A", "C"]);
    const ep = direct ? 1 : 2;
    let t = b.send(0, ep, 0, op === "write" ? "Put" : "Range");
    if (op === "write") {
      if (!direct) t = b.send(ep, 1, t, "MsgProp");
      const commit = round(b, 1, [2, 3], t, 1, "MsgApp", "MsgAppResp", true);
      b.mark(1, commit, "commit");
      // The next MsgApp carries the new commit index. The endpoint answers once it has applied the entry.
      const at = b.send(1, 2, commit, "MsgApp (commit)", !direct);
      b.send(1, 3, commit, "MsgApp (commit)", false);
      const applied = direct ? commit : at;
      b.mark(ep, applied, "apply");
      return b.done(b.send(ep, 0, applied, "PutResponse"));
    }
    if (eventual) {
      b.mark(ep, t, "local read");
      return b.done(b.send(ep, 0, t, "RangeResponse"));
    }
    if (!direct) t = b.send(ep, 1, t, "MsgReadIndex");
    t = round(b, 1, [2, 3], t, 1, "MsgHeartbeat", "MsgHeartbeatResp", false);
    b.mark(1, t, "leader confirmed");
    if (!direct) t = b.send(1, ep, t, "MsgReadIndexResp");
    b.mark(ep, t, "read");
    return b.done(b.send(ep, 0, t, "RangeResponse"));
  }
  if (sys === "crdb") {
    // The gateway routes to the leaseholder, which is also the Raft leader of the range.
    const b = new Builder(direct ? ["client", "gw+lh", "rep 2", "rep 3"] : ["client", "gateway", "lh", "rep 2", "rep 3"]);
    const lh = direct ? 1 : 2;
    let t = b.send(0, 1, 0, op === "write" ? "UPSERT" : "SELECT");
    if (!direct) t = b.send(1, lh, t, "BatchRequest");
    if (op === "write") {
      t = round(b, lh, direct ? [2, 3] : [3, 4], t, 1, "MsgApp", "MsgAppResp", true);
      b.mark(lh, t, "commit, apply");
    } else b.mark(lh, t, "lease read");
    if (!direct) t = b.send(lh, 1, t, "BatchResponse");
    return b.done(b.send(1, 0, t, "result"));
  }
  // DynamoDB: a request router, the leader replica and two peers, in three Availability Zones.
  const b = new Builder(["client", "router", "AZ1 L", "AZ 2", "AZ 3"]);
  let t = b.send(0, 1, 0, op === "write" ? "PutItem" : "GetItem");
  if (op === "write") {
    t = b.send(1, 2, t, "write");
    t = round(b, 2, [3, 4], t, 1, "log record", "ack", true);
    b.mark(2, t, "quorum: 2 of 3");
    t = b.send(2, 1, t, "ok");
  } else {
    const at = eventual ? 3 : 2;
    t = b.send(1, at, t, "read");
    b.mark(at, t, eventual ? "any replica" : "lease read");
    t = b.send(at, 1, t, "item");
  }
  return b.done(b.send(1, 0, t, "response"));
}

// ---------------------------------------------------------------- workload fit

export interface Workload {
  id: string;
  name: string;
  dataGiB: number;
  writesPerSec: number;
  readsPerSec: number;
  /** Writes per second to the single hottest key. */
  hotKeyWrites: number;
  /** Keys that one transaction must change atomically (1: none). */
  txnKeys: number;
  /** Reads must be linearizable. */
  strongReads: boolean;
}

export const WORKLOADS: Workload[] = [
  { id: "config", name: "configuration and locks", dataGiB: 1, writesPerSec: 500, readsPerSec: 5000, hotKeyWrites: 50, txnKeys: 3, strongReads: true },
  { id: "cart", name: "shopping carts", dataGiB: 800, writesPerSec: 40000, readsPerSec: 120000, hotKeyWrites: 20, txnKeys: 1, strongReads: false },
  { id: "ledger", name: "bank ledger", dataGiB: 300, writesPerSec: 8000, readsPerSec: 20000, hotKeyWrites: 200, txnKeys: 4, strongReads: true },
  { id: "counter", name: "one hot counter", dataGiB: 1, writesPerSec: 5000, readsPerSec: 5000, hotKeyWrites: 5000, txnKeys: 1, strongReads: true },
];

/** Model inputs for capacity. */
export const FIT_INPUTS = {
  /** Writes per second that one Raft or Paxos leader can commit. */
  leaderWrites: 20000,
  /** CockroachDB: nodes, and replicas per range. */
  crdbNodes: 9,
  replicas: 3,
  /** Published limits. */
  etcdMaxGiB: 8,
  dynamoPartitionWrites: 1000,
  dynamoTxnItems: 100,
};

export interface Fit {
  sys: SystemId;
  /** Capacity divided by need, for each axis: above 1 fits. */
  size: number;
  throughput: number;
  hotKey: number;
  /** The design can change txnKeys keys atomically. */
  txn: boolean;
  /** Mean latency of the mix, from the flows, ms. */
  latencyMs: number;
  fits: boolean;
  why: string[];
}

export function fit(sys: SystemId, w: Workload): Fit {
  const I = FIT_INPUTS;
  const writeMs = flow(sys, "write").end;
  const readMs = flow(sys, "read", false, !w.strongReads && sys !== "crdb").end;
  const latencyMs = (writeMs * w.writesPerSec + readMs * w.readsPerSec) / (w.writesPerSec + w.readsPerSec);
  let size: number, throughput: number, hotKey: number, txn: boolean;
  if (sys === "etcd") {
    size = I.etcdMaxGiB / w.dataGiB;
    throughput = I.leaderWrites / w.writesPerSec;
    hotKey = I.leaderWrites / w.hotKeyWrites;
    txn = true; // If/Then/Else over any keys: all keys are in one Raft group
  } else if (sys === "crdb") {
    size = Infinity; // add nodes
    throughput = (I.crdbNodes * I.leaderWrites) / I.replicas / w.writesPerSec;
    hotKey = I.leaderWrites / w.hotKeyWrites; // one key lives in one range, with one leaseholder
    txn = true;
  } else {
    size = Infinity; // partitions are added as the table grows
    throughput = Infinity;
    hotKey = I.dynamoPartitionWrites / w.hotKeyWrites;
    txn = w.txnKeys <= I.dynamoTxnItems;
  }
  const why: string[] = [];
  if (size < 1) why.push(`${w.dataGiB} GiB is over the ${I.etcdMaxGiB} GiB suggested maximum`);
  if (throughput < 1) why.push(`one leader takes about ${I.leaderWrites.toLocaleString("en-US")} writes/s`);
  if (hotKey < 1) why.push(sys === "dynamo" ? `one key lives in one partition: ${I.dynamoPartitionWrites.toLocaleString("en-US")} writes/s` : `one key has one leader: ${I.leaderWrites.toLocaleString("en-US")} writes/s`);
  if (!txn) why.push("the transaction is too large");
  return { sys, size, throughput, hotKey, txn, latencyMs, fits: why.length === 0, why };
}
