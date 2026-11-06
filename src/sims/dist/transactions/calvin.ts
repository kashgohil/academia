/**
 * Calvin (Thomson et al., "Calvin: Fast Distributed Transactions for Partitioned Database Systems", SIGMOD 2012):
 * agree on the order of transactions first, then execute them deterministically everywhere.
 *
 * Part 1, replicas: node 0 is the client, node 1 the sequencer, nodes 2.. the replicas. The sequencer collects the
 * requests of each epoch into a batch and sends the batch to every replica. A replica executes batches in sequence
 * order and, inside a batch, in batch order. Every replica starts from the same state and applies the same
 * deterministic operations in the same order, so all replicas end in the same state, with no commit protocol.
 * The "race" mode breaks determinism on purpose: each replica runs a batch's transactions in the order its own
 * threads happen to finish, so replicas can diverge.
 *
 * Part 2, one transaction across partitions: 2PC (Spanner style, each partition a 3-replica Paxos group) against
 * Calvin, on the same network, counting messages, the critical path and how long the locks are held.
 */
import { Net } from "../net";
import { mulberry32 } from "../../rng";

// ============================================================================ part 1: sequencer and replicas

export type Op = { id: string; text: string; reads: string[]; writes: string[]; apply: (s: Record<string, number>) => void };

/** Transactions on x and y that do not commute, so their order matters. Each declares its read and write sets. */
export const CALVIN_OPS: Op[] = [
  { id: "T1", text: "x := x × 2", reads: ["x"], writes: ["x"], apply: (s) => void (s.x = s.x! * 2) },
  { id: "T2", text: "x := x + 10", reads: ["x"], writes: ["x"], apply: (s) => void (s.x = s.x! + 10) },
  { id: "T3", text: "y := x", reads: ["x"], writes: ["y"], apply: (s) => void (s.y = s.x!) },
  { id: "T4", text: "y := y − 3", reads: ["y"], writes: ["y"], apply: (s) => void (s.y = s.y! - 3) },
  { id: "T5", text: "x := y + 1", reads: ["y"], writes: ["x"], apply: (s) => void (s.x = s.y! + 1) },
  { id: "T6", text: "y := y × 3", reads: ["y"], writes: ["y"], apply: (s) => void (s.y = s.y! * 3) },
];

export const CALVIN_INIT = { x: 1, y: 2 };
/** Arrival times of T1..T6 at the sequencer's client (ms). */
export const CALVIN_ARRIVALS = [2, 6, 13, 17, 24, 29];

export type CMsg = { k: "req"; op: number } | { k: "batch"; seq: number; ops: number[] };

export interface CalvinCfg {
  /** Epoch length (ms). Calvin uses 10 ms. */
  epoch: number;
  replicas: number;
  /** Execute each batch in a replica-local thread order instead of the batch order. */
  race: boolean;
  /** Extra delay of the batches to the last replica (ms). */
  lagLast: number;
  seed: number;
  latency: number;
}

export const DEFAULT_CALVIN: CalvinCfg = { epoch: 10, replicas: 3, race: false, lagLast: 0, seed: 1, latency: 3 };

export interface ReplicaView {
  state: Record<string, number>;
  /** The order in which this replica executed the transactions. */
  order: number[];
  /** Execution times of each transaction. */
  at: number[];
}

export interface CalvinRun {
  net: Net<CMsg>;
  batches: { seq: number; t: number; ops: number[] }[];
  replicas: ReplicaView[];
  identical: boolean;
}

export function calvinRun(c: CalvinCfg, arrivals = CALVIN_ARRIVALS, ops = CALVIN_OPS): CalvinRun {
  const R = c.replicas;
  const batches: CalvinRun["batches"] = [];
  let pending: number[] = [];
  let seq = 0;
  const reps = Array.from({ length: R }, () => ({ state: { ...CALVIN_INIT } as Record<string, number>, order: [] as number[], at: [] as number[], next: 0, buf: new Map<number, number[]>() }));
  // Each replica's "thread timing": a local random source, different on each replica.
  const thread = Array.from({ length: R }, (_, r) => mulberry32(c.seed * 97 + r * 13 + 1));
  const execute = (r: number, list: number[]) => {
    const rep = reps[r]!;
    let order = list;
    if (c.race) {
      order = [...list];
      const g = thread[r]!;
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(g() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
    }
    for (const o of order) {
      ops[o]!.apply(rep.state);
      rep.order.push(o);
      rep.at.push(net.now);
    }
  };
  const net: Net<CMsg> = new Net<CMsg>(R + 2, { seed: c.seed, latency: { min: c.latency, max: c.latency } }, {
    onMessage: (to, m) => {
      const p = m.payload;
      if (p.k === "req") pending.push(p.op);
      else {
        const r = to - 2, rep = reps[r]!;
        rep.buf.set(p.seq, p.ops);
        // Execute batches strictly in sequence order, whatever order they arrive in.
        while (rep.buf.has(rep.next)) {
          execute(r, rep.buf.get(rep.next)!);
          rep.buf.delete(rep.next);
          rep.next++;
        }
      }
    },
    onTimer: (node, tag) => {
      if (tag === "epoch") {
        if (pending.length) {
          const b = { seq: seq++, t: net.now, ops: pending };
          batches.push(b);
          for (let r = 0; r < R; r++) net.send(1, r + 2, { k: "batch", seq: b.seq, ops: b.ops }, { delay: c.latency + (r === R - 1 ? c.lagLast : 0) });
          pending = [];
        }
        if (net.now < 200) net.setTimer(1, c.epoch, "epoch");
      } else net.send(0, 1, { k: "req", op: Number(tag) });
      void node;
    },
  });
  net.setTimer(1, c.epoch, "epoch");
  arrivals.forEach((t, i) => net.setTimer(0, t, String(i)));
  net.runUntil(400);
  const views = reps.map(({ state, order, at }) => ({ state, order, at }));
  const key = (s: Record<string, number>) => JSON.stringify(s);
  return { net, batches, replicas: views, identical: views.every((v) => key(v.state) === key(views[0]!.state)) };
}

// ============================================================================ part 2: one multi-partition transaction

export interface MpCfg {
  /** Partitions that the transaction touches. */
  partitions: number;
  /** One-way latency between any two machines (ms), a model input. */
  latency: number;
  /** Calvin's epoch (ms). A request waits half an epoch on average. */
  epoch: number;
}

export interface MpResult {
  /** Client-observed latency (ms). */
  latency: number;
  /** One-way message delays on the critical path. */
  hops: number;
  messages: number;
  /** How long the locks on the touched rows are held (ms), the longest over partitions. */
  lockHold: number;
  /** Network round trips made while the locks are held. */
  hopsUnderLock: number;
}

type MpMsg = { k: string; p?: number };

/**
 * 2PC as Spanner runs it. Node 0 is the client. Partition p has leader 1 + 3p and followers 2 + 3p, 3 + 3p.
 * 1. Reads: the client reads at every leader, which takes read locks. 2. Commit: the client sends the writes to
 * every leader; partition 0's leader is the coordinator. Participants replicate a prepare record (Paxos: to both
 * followers, wait for one ack) and send PREPARED. 3. The coordinator replicates the commit record, then answers
 * the client and sends COMMIT; a participant releases its locks when COMMIT arrives.
 */
export function mp2pc(c: MpCfg): MpResult {
  const P = c.partitions, d = c.latency;
  const leader = (p: number) => 1 + 3 * p;
  let reads = 0, prepared = 0, done = 0, coordReady = false;
  const lockFrom: number[] = [], lockTo: number[] = [];
  const repl = new Map<number, { acks: number; then: () => void }>();
  const replicate = (p: number, then: () => void) => {
    repl.set(p, { acks: 0, then });
    net.send(leader(p), leader(p) + 1, { k: "append", p });
    net.send(leader(p), leader(p) + 2, { k: "append", p });
  };
  const net = new Net<MpMsg>(1 + 3 * P, { seed: 1, latency: { min: d, max: d } }, {
    onMessage: (to, m) => {
      const k = m.payload.k;
      if (k === "read") {
        lockFrom[(to - 1) / 3] = net.now;
        net.send(to, 0, { k: "value" });
      } else if (k === "value" && ++reads === P) for (let p = 0; p < P; p++) net.send(0, leader(p), { k: "commit" });
      else if (k === "commit") {
        const p = (to - 1) / 3;
        if (p === 0) {
          // The coordinator skips its own prepare. It logs the commit once every other participant is prepared.
          coordReady = true;
          if (prepared === P - 1) replicate(0, finish);
        } else replicate(p, () => net.send(to, leader(0), { k: "prepared" }));
      } else if (k === "prepared") {
        prepared++;
        if (prepared === P - 1 && coordReady) replicate(0, finish);
      } else if (k === "append") net.send(to, m.from, { k: "appended", p: m.payload.p });
      else if (k === "appended") {
        const r = repl.get(m.payload.p!);
        if (r && ++r.acks === 1) r.then();
      } else if (k === "outcome") {
        lockTo[(to - 1) / 3] = net.now;
      } else if (k === "reply") done = net.now;
    },
  });
  const finish = () => {
    lockTo[0] = net.now;
    net.send(leader(0), 0, { k: "reply" });
    for (let p = 1; p < P; p++) net.send(leader(0), leader(p), { k: "outcome" });
  };
  for (let p = 0; p < P; p++) net.send(0, leader(p), { k: "read" });
  net.runAll();
  const hold = Math.max(...lockTo.map((t, p) => t - lockFrom[p]!));
  return { latency: done, hops: Math.round(done / d), messages: net.messages.length, lockHold: hold, hopsUnderLock: Math.round(hold / d) };
}

/**
 * Calvin. Node 0 is the client, node 1 the sequencer with replicas 2 and 3, and partition p's scheduler is node
 * 4 + p. The request waits for the end of its epoch (half an epoch), the sequencer replicates the batch (Paxos: wait
 * for one of two acks), then sends it to the schedulers. Each scheduler locks its rows, reads them, and sends the
 * values to the other participants. When a scheduler has every read, it executes, writes its own rows and releases
 * its locks. Partition 0 answers the client.
 */
export function mpCalvin(c: MpCfg): MpResult {
  const P = c.partitions, d = c.latency;
  const sched = (p: number) => 4 + p;
  let acks = 0, done = 0;
  const got = new Array<number>(P).fill(0), lockFrom: number[] = [], lockTo: number[] = [];
  const net = new Net<MpMsg>(4 + P, { seed: 1, latency: { min: d, max: d } }, {
    onMessage: (to, m) => {
      const k = m.payload.k;
      if (k === "req") net.setTimer(1, c.epoch / 2, "epoch");
      else if (k === "append") net.send(to, 1, { k: "appended" });
      else if (k === "appended") {
        if (++acks === 1) for (let p = 0; p < P; p++) net.send(1, sched(p), { k: "batch" });
      } else if (k === "batch") {
        const p = to - 4;
        lockFrom[p] = net.now;
        for (let q = 0; q < P; q++) if (q !== p) net.send(to, sched(q), { k: "reads" });
        if (P === 1) execute(p);
      } else if (k === "reads") {
        const p = to - 4;
        if (++got[p]! === P - 1) execute(p);
      } else if (k === "reply") done = net.now;
    },
    onTimer: () => {
      net.send(1, 2, { k: "append" });
      net.send(1, 3, { k: "append" });
    },
  });
  const execute = (p: number) => {
    lockTo[p] = net.now;
    if (p === 0) net.send(sched(0), 0, { k: "reply" });
  };
  net.send(0, 1, { k: "req" });
  net.runAll();
  const hold = Math.max(...lockTo.map((t, p) => t - lockFrom[p]!));
  return { latency: done, hops: Math.round((done - c.epoch / 2) / d), messages: net.messages.length, lockHold: hold, hopsUnderLock: Math.round(hold / d) };
}

/** The partitions axis of the comparison demo. */
export const MP_PARTITIONS = [1, 2, 3, 4, 6, 8];
