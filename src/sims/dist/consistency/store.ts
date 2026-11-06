/**
 * A replicated register on the shared Net, with a configurable read path. It records a history for the checkers.
 *
 * Node 0 is a fixed leader. Writes go to the leader. The leader appends the write to its log, sends it to the
 * followers, and replies when a majority (the leader too) holds it: the write is then committed. Followers learn the
 * commit index from the next append or heartbeat, so their committed value lags behind the leader.
 *
 * Read paths:
 * - "readindex": the leader notes its commit index, confirms with a heartbeat round to a majority, then answers.
 *   This is the ReadIndex read of the Raft thesis (Ongaro 2014), which etcd uses. Linearizable; costs one round trip.
 * - "leader": the leader answers from its state at once. Linearizable here only because the leader never changes;
 *   a deposed leader that does not know it would serve stale data.
 * - "follower": any replica answers from its own committed state. Fast, and stale: not linearizable.
 *
 * Clients are nodes after the replicas. Each runs one operation at a time, like a Jepsen process. A write that times
 * out is "pending": it may still take effect. Then the client continues as a new process, so that every process stays
 * sequential.
 */
import { Net, type NetConfig } from "../net";
import { INITIAL, type HOp } from "./history";

export type ReadPath = "readindex" | "leader" | "follower";

export interface StoreFault {
  /** isolate: cut the node off from the other replicas (clients can still reach it). crash: stop the node. */
  kind: "isolate" | "crash";
  node: number;
  at: number;
  until: number;
}

export interface StoreConfig {
  seed: number;
  replicas: number;
  clients: number;
  readPath: ReadPath;
  /** Clients start no new operation after this time (ms). */
  duration: number;
  readFrac: number;
  /** Pause between operations of one client: uniform in [0, think] ms. */
  think: number;
  timeout: number;
  /** Leader heartbeat interval (ms). Followers learn the commit index with it. */
  heartbeat: number;
  latency: NetConfig["latency"];
  dropRate: number;
  faults: StoreFault[];
}

export const DEFAULT_STORE: StoreConfig = {
  seed: 1, replicas: 3, clients: 3, readPath: "readindex", duration: 400, readFrac: 0.6, think: 30, timeout: 120,
  heartbeat: 50, latency: { min: 4, max: 16 }, dropRate: 0, faults: [],
};

export type StoreMsg =
  | { k: "write"; op: number; v: number }
  | { k: "read"; op: number }
  | { k: "append"; from: number; vals: number[]; commit: number; rid?: number }
  | { k: "ack"; last: number; rid?: number }
  | { k: "ok"; op: number; v?: number };

export interface StoreRun {
  cfg: StoreConfig;
  net: Net<StoreMsg>;
  history: HOp[];
  /** Which replica answered each read. */
  servedBy: Map<number, number>;
  /** The time each write committed at the leader. */
  committedAt: Map<number, number>;
  nodes: string[];
}

export const replicaName = (i: number) => (i === 0 ? "leader" : `f${i}`);

export function runStore(partial: Partial<StoreConfig> = {}): StoreRun {
  const cfg: StoreConfig = { ...DEFAULT_STORE, ...partial };
  const N = cfg.replicas, C = cfg.clients, majority = Math.floor(N / 2) + 1;
  const isClient = (i: number) => i >= N;
  const stopAt = cfg.duration + cfg.timeout + 4 * cfg.heartbeat;

  // Replica state. log[0] is the initial value; log[i] is the value of write i.
  const logs: number[][] = Array.from({ length: N }, () => [INITIAL]);
  const commit = new Array<number>(N).fill(0);
  const match = new Array<number>(N).fill(0);
  const waitingWrites = new Map<number, { client: number; op: number }>(); // log index -> client
  const reads = new Map<number, { acks: Set<number>; waiting: { client: number; op: number }[] }>();
  let nextRid = 1;

  // Client state.
  const history: HOp[] = [];
  const servedBy = new Map<number, number>();
  const committedAt = new Map<number, number>();
  const proc = Array.from({ length: C }, (_, c) => c);
  const current = new Array<HOp | null>(C).fill(null);
  const timers = new Array<number>(C).fill(0);
  let nextValue = 1;

  const sendAppend = (net: Net<StoreMsg>, f: number, rid?: number) => {
    const from = match[f]! + 1;
    net.send(0, f, { k: "append", from, vals: logs[0]!.slice(from), commit: commit[0]!, rid });
  };
  const advanceCommit = (net: Net<StoreMsg>) => {
    const lasts = [logs[0]!.length - 1, ...match.slice(1)].sort((a, b) => b - a);
    const c = lasts[majority - 1]!;
    if (c <= commit[0]!) return;
    for (let i = commit[0]! + 1; i <= c; i++) {
      committedAt.set(logs[0]![i]!, net.now);
      const w = waitingWrites.get(i);
      if (w) { net.send(0, w.client, { k: "ok", op: w.op }); waitingWrites.delete(i); }
    }
    commit[0] = c;
  };
  const value = (r: number) => logs[r]![commit[r]!]!;

  const startOp = (net: Net<StoreMsg>, c: number) => {
    if (net.now > cfg.duration) return;
    const node = N + c;
    const isRead = net.random() < cfg.readFrac;
    const op: HOp = { id: history.length, client: proc[c]!, key: "x", f: isRead ? "r" : "w", call: net.now, ret: Infinity };
    if (!isRead) op.value = nextValue++;
    history.push(op);
    current[c] = op;
    if (isRead) {
      const target = cfg.readPath === "follower" ? Math.floor(net.random() * N) : 0;
      net.send(node, target, { k: "read", op: op.id });
    } else net.send(node, 0, { k: "write", op: op.id, v: op.value! });
    timers[c] = net.setTimer(node, cfg.timeout, `timeout`);
  };
  const finishOp = (net: Net<StoreMsg>, c: number) => {
    current[c] = null;
    net.setTimer(N + c, net.random() * cfg.think, "next");
  };

  const net = new Net<StoreMsg>(N + C, { seed: cfg.seed, latency: cfg.latency, dropRate: cfg.dropRate }, {
    onMessage(node, msg, net) {
      const p = msg.payload;
      if (isClient(node)) {
        const c = node - N, op = current[c];
        if (p.k !== "ok" || !op || op.id !== p.op) return; // a late reply to an operation that timed out
        op.ret = net.now;
        if (op.f === "r") { op.value = p.v; servedBy.set(op.id, msg.from); }
        net.cancelTimer(timers[c]!);
        finishOp(net, c);
        return;
      }
      if (p.k === "write" && node === 0) {
        logs[0]!.push(p.v);
        waitingWrites.set(logs[0]!.length - 1, { client: msg.from, op: p.op });
        for (let f = 1; f < N; f++) sendAppend(net, f);
        advanceCommit(net); // a one-replica store commits at once
      } else if (p.k === "read") {
        if (node === 0 && cfg.readPath === "readindex") {
          const rid = nextRid++;
          reads.set(rid, { acks: new Set([0]), waiting: [{ client: msg.from, op: p.op }] });
          if (majority === 1) { reads.delete(rid); net.send(0, msg.from, { k: "ok", op: p.op, v: value(0) }); }
          for (let f = 1; f < N; f++) sendAppend(net, f, rid);
        } else net.send(node, msg.from, { k: "ok", op: p.op, v: value(node) });
      } else if (p.k === "append") {
        const log = logs[node]!;
        if (p.from <= log.length) p.vals.forEach((v, j) => (log[p.from + j] = v));
        commit[node] = Math.max(commit[node]!, Math.min(p.commit, log.length - 1));
        net.send(node, 0, { k: "ack", last: log.length - 1, rid: p.rid });
      } else if (p.k === "ack" && node === 0) {
        match[msg.from] = Math.max(match[msg.from]!, p.last);
        advanceCommit(net);
        const r = p.rid !== undefined ? reads.get(p.rid) : undefined;
        if (r) {
          r.acks.add(msg.from);
          if (r.acks.size >= majority) {
            for (const w of r.waiting) net.send(0, w.client, { k: "ok", op: w.op, v: value(0) });
            reads.delete(p.rid!);
          }
        }
      }
    },
    onTimer(node, tag, net) {
      if (node === 0 && tag === "hb") {
        if (net.now > stopAt) return;
        for (let f = 1; f < N; f++) sendAppend(net, f);
        net.setTimer(0, cfg.heartbeat, "hb");
        return;
      }
      if (!isClient(node)) return;
      const c = node - N;
      if (tag === "next") return startOp(net, c);
      if (tag === "timeout" && current[c]) {
        // The client does not know if the operation happened. It continues as a new process.
        proc[c]! += C;
        finishOp(net, c);
      }
    },
    onRecover(node, net) {
      if (node === 0) net.setTimer(0, cfg.heartbeat, "hb");
    },
  });

  net.setTimer(0, cfg.heartbeat, "hb");
  for (let c = 0; c < C; c++) net.setTimer(N + c, net.random() * cfg.think, "next");
  const clientsOf = Array.from({ length: C }, (_, c) => N + c);
  const events = cfg.faults.flatMap((f) => [{ t: f.at, f, start: true }, { t: f.until, f, start: false }]).sort((a, b) => a.t - b.t);
  for (const e of events) {
    net.runUntil(e.t);
    if (e.f.kind === "crash") { if (e.start) net.crash(e.f.node); else net.recover(e.f.node); }
    else if (e.start) net.partition([[...Array(N).keys()].filter((i) => i !== e.f.node).concat(clientsOf), [e.f.node, ...clientsOf]]);
    else net.heal();
  }
  net.runUntil(stopAt + 100);
  return { cfg, net, history, servedBy, committedAt, nodes: [...Array.from({ length: N }, (_, i) => replicaName(i)), ...clientsOf.map((_, c) => `c${c + 1}`)] };
}

/** A label for a store message in a space-time diagram. */
export function storeMsgLabel(p: StoreMsg): string | undefined {
  if (p.k === "write") return `w${p.v}`;
  if (p.k === "read") return "r";
  if (p.k === "ok") return p.v === undefined ? "ok" : `=${p.v}`;
  return undefined;
}

/** Totals over seeds 1..seeds: runs that fail the checker, reads, provably stale reads, and the mean read latency. */
export function storeStats(cfg: Partial<StoreConfig>, seeds: number, check: (h: HOp[]) => { failed: boolean; stale: number }) {
  let failed = 0, reads = 0, stale = 0, readTime = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const run = runStore({ ...cfg, seed });
    const done = run.history.filter((o) => o.f === "r" && Number.isFinite(o.ret));
    reads += done.length;
    readTime += done.reduce((a, o) => a + o.ret - o.call, 0);
    const c = check(run.history);
    if (c.failed) failed++;
    stale += c.stale;
  }
  return { runs: seeds, failed, reads, stale, meanRead: readTime / Math.max(1, reads) };
}
