/**
 * Delivery guarantees on the shared Net.
 *
 * 1. A pipeline: an input log (node 0, a Kafka-like broker that also stores the consumer's committed offset), a
 *    processor (node 1) and a sink database (node 2). For each record the processor reads it, applies its effect
 *    to the sink ("add amount to the account") and commits its position. Three modes:
 *    - at-most-once: commit the offset first, then send the effect once, with no retry;
 *    - at-least-once: apply the effect (retry until acknowledged), then commit the offset;
 *    - exactly-once: one sink transaction applies the effect and stores the next offset. The processor reads its
 *      position from the sink, and the sink skips a record whose offset is below the stored one.
 *    Every request that waits for an answer is retried after `retryAfter` ms. The learner (or a test) picks crash
 *    points: the processor crashes there and restarts `downtime` ms later from its stored position.
 *
 * 2. A Kafka-style idempotent producer (KIP-98) in hold mode: the learner is the network. Each batch carries the
 *    producer id and a sequence number per partition. The broker appends seq = last + 1, answers a repeat of a
 *    recent batch with its first offset (no second append), and rejects a gap (OutOfOrderSequence). Without
 *    idempotence the broker appends every copy that arrives.
 */
import { Net, type Message } from "../net";

// ============================================================================ 1. The pipeline

export type Guarantee = "at-most-once" | "at-least-once" | "exactly-once";
export const GUARANTEES: Guarantee[] = ["at-most-once", "at-least-once", "exactly-once"];

/** Where the processor crashes while it handles record `rec` (0-based):
 *  read: it has the record and has sent nothing;
 *  first: its first write is done (at-most-once: offset committed; at-least-once and exactly-once: effect applied);
 *  second: its second write was sent, before the answer (exactly-once has no second write: same as first). */
export type CrashPhase = "read" | "first" | "second";
export interface CrashPoint { rec: number; phase: CrashPhase }

export interface PipeConfig {
  seed: number;
  mode: Guarantee;
  records: number;
  crashes: CrashPoint[];
  dropRate: number;
  latency: { min: number; max: number };
  retryAfter: number;
  downtime: number;
  horizon: number;
}

export const PIPE_DEFAULTS: PipeConfig = {
  seed: 1, mode: "at-least-once", records: 6, crashes: [{ rec: 2, phase: "first" }], dropRate: 0,
  latency: { min: 4, max: 8 }, retryAfter: 30, downtime: 25, horizon: 5000,
};

export const BROKER = 0, PROC = 1, SINK = 2;

export type PMsg =
  | { k: "get-pos"; req: number }
  | { k: "pos"; req: number; offset: number }
  | { k: "fetch"; req: number; offset: number }
  | { k: "record"; req: number; offset: number; amount: number }
  | { k: "commit"; req: number; offset: number }
  | { k: "apply"; req: number; offset: number; amount: number; txn: boolean }
  | { k: "ok"; req: number };

export interface PipeRun {
  cfg: PipeConfig;
  net: Net<PMsg>;
  /** How many times the sink applied each record's effect. */
  effects: number[];
  lost: number;
  duplicated: number;
  balance: number;
  expected: number;
  crashesHit: { t: number; point: CrashPoint }[];
  done: boolean;
  doneAt: number | null;
}

export const amountOf = (offset: number) => 10 * (offset + 1);

export function runPipeline(partial: Partial<PipeConfig> = {}): PipeRun {
  const cfg: PipeConfig = { ...PIPE_DEFAULTS, ...partial, latency: { ...PIPE_DEFAULTS.latency, ...partial.latency } };
  const N = cfg.records;
  // Durable state of the broker and the sink.
  let committed = 0;
  let sinkOffset = 0;
  let balance = 0;
  const effects = new Array<number>(N).fill(0);
  // The processor's memory (lost in a crash).
  let pos = 0;
  let waiting: { req: number; msg: PMsg; to: number; then: (m: PMsg) => void } | null = null;
  let nextReq = 1;
  let gen = 0;
  let done = false, doneAt: number | null = null;
  const crashesLeft = cfg.crashes.map((c) => ({ ...c }));
  const crashesHit: PipeRun["crashesHit"] = [];

  let net!: Net<PMsg>;

  /** Sends a request and calls `then` with the answer; retries after retryAfter until an answer comes. */
  const call = (to: number, make: (req: number) => PMsg, then: (m: PMsg) => void) => {
    const req = nextReq++;
    const msg = make(req);
    waiting = { req, msg, to, then };
    net.send(PROC, to, msg);
    net.setTimer(PROC, cfg.retryAfter, `retry:${req}:${gen}`);
  };
  /** True if the processor crashes here. */
  const crashHere = (rec: number, phase: CrashPhase) => {
    const i = crashesLeft.findIndex((c) => c.rec === rec && c.phase === phase);
    if (i < 0) return false;
    const [c] = crashesLeft.splice(i, 1);
    crashesHit.push({ t: net.now, point: c! });
    net.crash(PROC);
    waiting = null;
    net.setTimer(BROKER, cfg.downtime, "restart");
    return true;
  };

  const start = () => {
    gen++;
    waiting = null;
    // Where to start: the broker's committed offset, or the offset stored in the sink (exactly-once).
    call(cfg.mode === "exactly-once" ? SINK : BROKER, (req) => ({ k: "get-pos", req }), (m) => {
      pos = (m as Extract<PMsg, { k: "pos" }>).offset;
      next();
    });
  };
  const next = () => {
    if (pos >= N) { if (!done) { done = true; doneAt = net.now; } return; }
    call(BROKER, (req) => ({ k: "fetch", req, offset: pos }), (m) => {
      const r = m as Extract<PMsg, { k: "record" }>;
      handle(r.offset, r.amount);
    });
  };
  const handle = (offset: number, amount: number) => {
    if (crashHere(offset, "read")) return;
    const after = () => { pos = offset + 1; next(); };
    if (cfg.mode === "at-most-once") {
      call(BROKER, (req) => ({ k: "commit", req, offset: offset + 1 }), () => {
        if (crashHere(offset, "first")) return;
        net.send(PROC, SINK, { k: "apply", req: 0, offset, amount, txn: false }); // fire and forget
        if (crashHere(offset, "second")) return;
        after();
      });
    } else if (cfg.mode === "at-least-once") {
      call(SINK, (req) => ({ k: "apply", req, offset, amount, txn: false }), () => {
        if (crashHere(offset, "first")) return;
        call(BROKER, (req) => ({ k: "commit", req, offset: offset + 1 }), () => after());
        if (crashHere(offset, "second")) return;
      });
    } else {
      call(SINK, (req) => ({ k: "apply", req, offset, amount, txn: true }), () => {
        if (crashHere(offset, "first") || crashHere(offset, "second")) return;
        after();
      });
    }
  };

  net = new Net<PMsg>(3, { seed: cfg.seed, latency: cfg.latency, dropRate: cfg.dropRate }, {
    onMessage(node, msg, nt) {
      const m = msg.payload;
      if (node === BROKER) {
        if (m.k === "get-pos") nt.send(BROKER, PROC, { k: "pos", req: m.req, offset: committed });
        else if (m.k === "fetch") nt.send(BROKER, PROC, { k: "record", req: m.req, offset: m.offset, amount: amountOf(m.offset) });
        else if (m.k === "commit") { committed = Math.max(committed, m.offset); nt.send(BROKER, PROC, { k: "ok", req: m.req }); }
      } else if (node === SINK) {
        if (m.k === "get-pos") nt.send(SINK, PROC, { k: "pos", req: m.req, offset: sinkOffset });
        else if (m.k === "apply") {
          if (m.txn) {
            // One transaction: apply the effect and store the next offset, unless this record is already done.
            if (m.offset >= sinkOffset) { balance += m.amount; effects[m.offset]!++; sinkOffset = m.offset + 1; }
          } else { balance += m.amount; effects[m.offset]!++; }
          if (m.req) nt.send(SINK, PROC, { k: "ok", req: m.req });
        }
      } else if (node === PROC) {
        if (!("req" in m) || !waiting || m.req !== waiting.req) return; // a late answer to an old request
        const w = waiting;
        waiting = null;
        w.then(m);
      }
    },
    onTimer(node, tag, nt) {
      if (node === BROKER && tag === "restart") { nt.recover(PROC); start(); return; }
      const [kind, req, g] = tag.split(":");
      if (kind === "retry" && waiting && waiting.req === Number(req) && Number(g) === gen) {
        nt.send(PROC, waiting.to, waiting.msg);
        nt.setTimer(PROC, cfg.retryAfter, `retry:${req}:${gen}`);
      }
    },
  });
  start();
  net.runUntil(cfg.horizon);
  const expected = Array.from({ length: N }, (_, i) => amountOf(i)).reduce((a, b) => a + b, 0);
  return {
    cfg, net, effects, balance, expected, crashesHit, done, doneAt,
    lost: effects.filter((e) => e === 0).length,
    duplicated: effects.reduce((a, e) => a + Math.max(0, e - 1), 0),
  };
}

/** A short label for a pipeline message, for the space-time diagram ("" for fetches and plain acks). */
export function pipeLabel(m: Message<PMsg>): string {
  const p = m.payload;
  switch (p.k) {
    case "get-pos": return "where?";
    case "pos": return `@${p.offset}`;
    case "fetch": return "";
    case "record": return `r${p.offset}`;
    case "commit": return `commit ${p.offset}`;
    case "apply": return p.txn ? `txn r${p.offset}` : `+${p.amount}`;
    case "ok": return "";
  }
}

// ============================================================================ 2. The idempotent producer

export interface IdemProdConfig {
  idempotent: boolean;
  batches: number;
  /** max.in.flight.requests.per.connection */
  maxInFlight: number;
  retryAfter: number;
}

export const IDEMP_DEFAULTS: IdemProdConfig = { idempotent: true, batches: 3, maxInFlight: 2, retryAfter: 40 };
/** The broker remembers this many recent batches per producer (Kafka keeps 5). */
export const DEDUP_WINDOW = 5;
export const PID = 4000;

export type ProdMsg =
  | { k: "produce"; pid: number; seq: number; attempt: number }
  | { k: "ack"; seq: number; offset: number; dup: boolean }
  | { k: "error"; seq: number; err: "OutOfOrderSequence" };

export type IdemAction = { k: "deliver" | "drop"; id: number } | { k: "wait" };

export interface IdemProdRun {
  cfg: IdemProdConfig;
  net: Net<ProdMsg>;
  /** The partition log: which batch sits at each offset. */
  log: { seq: number; attempt: number }[];
  held: Message<ProdMsg>[];
  /** Per batch: acknowledged with which offset, and attempts sent. */
  acked: (number | null)[];
  attempts: number[];
  events: string[];
  duplicates: number;
  /** True if the log holds the batches in sequence order (ignoring duplicates). */
  inOrder: boolean;
}

export function runIdemProducer(partial: Partial<IdemProdConfig>, actions: IdemAction[]): IdemProdRun {
  const cfg = { ...IDEMP_DEFAULTS, ...partial };
  const log: IdemProdRun["log"] = [];
  const acked: (number | null)[] = new Array(cfg.batches).fill(null);
  const attempts = new Array<number>(cfg.batches).fill(0);
  const events: string[] = [];
  let lastSeq = -1;
  const recent: { seq: number; offset: number }[] = [];
  let nextToSend = 0;

  let net!: Net<ProdMsg>;
  const send = (seq: number) => {
    attempts[seq]!++;
    net.send(0, 1, { k: "produce", pid: PID, seq, attempt: attempts[seq]! });
    net.setTimer(0, cfg.retryAfter, `retry:${seq}:${attempts[seq]}`);
  };
  const fill = () => {
    const inFlight = () => Array.from({ length: nextToSend }, (_, s) => s).filter((s) => acked[s] === null).length;
    while (nextToSend < cfg.batches && inFlight() < cfg.maxInFlight) send(nextToSend++);
  };

  net = new Net<ProdMsg>(2, { seed: 1, latency: { min: 5, max: 5 } }, {
    onMessage(node, msg) {
      const p = msg.payload;
      if (node === 1 && p.k === "produce") {
        if (!cfg.idempotent) {
          log.push({ seq: p.seq, attempt: p.attempt });
          events.push(`Broker appends batch ${p.seq} (try ${p.attempt}) at offset ${log.length - 1}.`);
          net.send(1, 0, { k: "ack", seq: p.seq, offset: log.length - 1, dup: false });
        } else if (p.seq === lastSeq + 1) {
          log.push({ seq: p.seq, attempt: p.attempt });
          lastSeq = p.seq;
          recent.push({ seq: p.seq, offset: log.length - 1 });
          if (recent.length > DEDUP_WINDOW) recent.shift();
          events.push(`Broker: seq ${p.seq} = last + 1. It appends at offset ${log.length - 1}.`);
          net.send(1, 0, { k: "ack", seq: p.seq, offset: log.length - 1, dup: false });
        } else if (p.seq <= lastSeq) {
          const r = recent.find((x) => x.seq === p.seq);
          events.push(`Broker: seq ${p.seq} is a duplicate. It does not append, and answers with offset ${r?.offset}.`);
          net.send(1, 0, { k: "ack", seq: p.seq, offset: r?.offset ?? -1, dup: true });
        } else {
          events.push(`Broker: seq ${p.seq} leaves a gap after ${lastSeq}. It rejects it: OutOfOrderSequence.`);
          net.send(1, 0, { k: "error", seq: p.seq, err: "OutOfOrderSequence" });
        }
      } else if (node === 0) {
        if (p.k === "ack" && acked[p.seq] === null) {
          acked[p.seq] = p.offset;
          events.push(`Producer: batch ${p.seq} acknowledged at offset ${p.offset}.`);
          fill();
        } else if (p.k === "error") events.push(`Producer: batch ${p.seq} rejected. It will send it again after the timeout.`);
      }
    },
    onTimer(_node, tag) {
      const [, s, a] = tag.split(":");
      const seq = Number(s);
      if (acked[seq] === null && attempts[seq] === Number(a)) {
        events.push(cfg.idempotent ? `Producer: no answer for batch ${seq}. It retries with the same sequence number.` : `Producer: no answer for batch ${seq}. It sends the batch again.`);
        send(seq);
      }
    },
  });
  net.hold = true;
  fill();
  for (const a of actions) {
    if (a.k === "deliver") net.deliverHeld(a.id);
    else if (a.k === "drop") { net.dropHeld(a.id); events.push(`The network loses message #${a.id}.`); }
    else net.runUntil(net.now + cfg.retryAfter);
  }
  const counts = new Map<number, number>();
  for (const r of log) counts.set(r.seq, (counts.get(r.seq) ?? 0) + 1);
  const firsts = log.filter((r, i) => log.findIndex((x) => x.seq === r.seq) === i).map((r) => r.seq);
  return {
    cfg, net, log, held: net.held(), acked, attempts, events,
    duplicates: [...counts.values()].reduce((a, c) => a + c - 1, 0),
    inOrder: firsts.every((s, i) => i === 0 || s > firsts[i - 1]!),
  };
}
