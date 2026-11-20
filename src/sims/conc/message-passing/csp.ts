/**
 * Sims for "CSP and channels".
 *
 * - runProducerConsumer: a producer and a consumer joined by one channel of capacity C, on the shared Runtime. It shows
 *   what a buffer does and does not buy: it absorbs jitter between two stages of equal mean speed, but it cannot make
 *   a slow consumer faster.
 * - ChanHb: a step-level model of one channel for a learner who picks which side acts next. It records each send and
 *   receive (when it started, when it completed) and the happens-before edges of the Go memory model:
 *   send k → completion of receive k; for capacity 0, receive k → completion of send k; for capacity C > 0,
 *   receive k → completion of send k + C.
 */
import { Runtime, type RunResult } from "../runtime";

// ---------------------------------------------------------------- producer and consumer on the Runtime

export interface PcConfig {
  /** Channel capacity. 0 is a rendezvous. */
  capacity: number;
  items: number;
  /** Mean work per item in ns. */
  produceNs: number;
  consumeNs: number;
  /** 0..1: each work time is uniform in [mean × (1 − jitter), mean × (1 + jitter)]. */
  jitter: number;
  cores: number;
  seed: number;
  /** Model inputs, as in the Runtime. Defaults: the Runtime's DEFAULT_COSTS. */
  wakeNs?: number;
  switchNs?: number;
  record?: boolean;
}

export const PC_DEFAULTS: PcConfig = { capacity: 0, items: 24, produceNs: 20_000, consumeNs: 30_000, jitter: 0, cores: 2, seed: 7 };

export interface PcResult {
  result: RunResult;
  makespan: number;
  /** Times the producer or the consumer parked on the channel. */
  producerBlocks: number;
  consumerBlocks: number;
  producerBlockedNs: number;
  consumerBlockedNs: number;
  /** The most values the buffer held at once. */
  maxLen: number;
}

/** A uniform draw in [m(1 − j), m(1 + j)] from the seeded source of the run. */
const jittered = (mean: number, j: number, u: number) => mean * (1 - j + 2 * j * u);

export function runProducerConsumer(cfg: Partial<PcConfig> = {}): PcResult {
  const c = { ...PC_DEFAULTS, ...cfg };
  const rt = new Runtime({
    cores: c.cores, seed: c.seed, record: c.record ?? true,
    ...(c.wakeNs !== undefined ? { wakeNs: c.wakeNs } : {}), ...(c.switchNs !== undefined ? { switchNs: c.switchNs } : {}),
  });
  const ch = rt.channel<number>("items", c.capacity);
  // Draw all work times first, so that every capacity sees the same work: only the channel changes.
  const draw = new Runtime({ seed: c.seed });
  const pw = Array.from({ length: c.items }, () => jittered(c.produceNs, c.jitter, draw.random()));
  const cw = Array.from({ length: c.items }, () => jittered(c.consumeNs, c.jitter, draw.random()));
  rt.spawn("producer", function* (t) {
    for (let i = 0; i < c.items; i++) {
      yield* t.work(pw[i]!, `make ${i}`);
      yield* t.send(ch, i);
    }
    t.close(ch);
  });
  rt.spawn("consumer", function* (t) {
    for (let i = 0; ; i++) {
      const r = yield* t.recv(ch);
      if (!r.ok) break;
      yield* t.work(cw[r.value]!, `use ${r.value}`);
    }
  });
  const result = rt.run();
  const blocks = (tid: number) => result.events.filter((e) => e.tid === tid && e.kind === "block").length;
  return {
    result,
    makespan: result.makespan,
    producerBlocks: blocks(0),
    consumerBlocks: blocks(1),
    producerBlockedNs: result.threads[0]!.blockedNs,
    consumerBlockedNs: result.threads[1]!.blockedNs,
    maxLen: result.channels[0]!.maxLen,
  };
}

// ---------------------------------------------------------------- happens-before on one channel, step by step

export type Side = "producer" | "consumer";

export interface HbOp {
  side: Side;
  /** Send k or receive k, from 1. */
  k: number;
  /** The step at which the side called the operation, and the step at which it completed (undefined: still blocked). */
  start: number;
  end?: number;
  /** How it completed: through the buffer, or directly with a waiting partner. */
  how?: "buffer" | "direct";
}

export interface HbEdge {
  /** The op whose event comes first: a send (its start) or a receive (its completion). */
  from: HbOp;
  /** The op whose completion comes after it. */
  to: HbOp;
  /** "send→recv": a send is synchronized before the completion of its receive. "recv→send": the capacity rule. */
  rule: "send→recv" | "recv→send";
}

/**
 * One channel of capacity C between a producer that sends 1, 2, 3, ... and a consumer that receives them. The learner
 * calls `act(side)`: that side starts its next operation. It completes at once if it can, or it blocks until the
 * other side unblocks it. A blocked side cannot act.
 */
export class ChanHb {
  readonly ops: HbOp[] = [];
  step = 0;
  buf: number[] = [];
  /** The blocked operation of each side, if any. */
  pending: Partial<Record<Side, HbOp>> = {};
  private sent = 0;
  private received = 0;
  constructor(readonly capacity: number, readonly items = 8) {}

  canAct(side: Side) {
    if (this.pending[side]) return false;
    return side === "producer" ? this.nextK("producer") <= this.items : this.nextK("consumer") <= this.items;
  }

  private nextK(side: Side) {
    return this.ops.filter((o) => o.side === side).length + 1;
  }

  /** Sends completed minus receives completed: the values in the buffer. */
  get lead() {
    return this.sent - this.received;
  }

  get done() {
    return this.received >= this.items;
  }

  act(side: Side): HbOp | null {
    if (!this.canAct(side)) return null;
    this.step++;
    const op: HbOp = { side, k: this.nextK(side), start: this.step };
    this.ops.push(op);
    const other = side === "producer" ? this.pending.consumer : this.pending.producer;
    if (side === "producer") {
      if (other) {
        // A receiver waits: the value goes straight to it (Go: send → sendDirect).
        this.complete(op, "direct");
        this.complete(other, "direct");
        delete this.pending.consumer;
      } else if (this.buf.length < this.capacity) {
        this.buf.push(op.k);
        this.complete(op, "buffer");
      } else this.pending.producer = op;
    } else {
      if (this.buf.length) {
        this.buf.shift();
        this.complete(op, "buffer");
        if (other) {
          // A blocked sender's value moves into the freed slot, and its send completes.
          this.buf.push(other.k);
          this.complete(other, "buffer");
          delete this.pending.producer;
        }
      } else if (other) {
        this.complete(op, "direct");
        this.complete(other, "direct");
        delete this.pending.producer;
      } else this.pending.consumer = op;
    }
    return op;
  }

  private complete(op: HbOp, how: "buffer" | "direct") {
    op.end = this.step;
    op.how = how;
    if (op.side === "producer") this.sent++;
    else this.received++;
  }

  /** The happens-before edges among the operations so far that have completed. */
  edges(): HbEdge[] {
    const send = (k: number) => this.ops.find((o) => o.side === "producer" && o.k === k);
    const out: HbEdge[] = [];
    for (const r of this.ops) {
      if (r.side !== "consumer" || r.end === undefined) continue;
      const s = send(r.k);
      if (s) out.push({ from: s, to: r, rule: "send→recv" });
      const later = send(r.k + this.capacity);
      if (later?.end !== undefined) out.push({ from: r, to: later, rule: "recv→send" });
    }
    return out;
  }
}

/** Runs a schedule of sides (skipping a side that cannot act) and returns the model. */
export function runHb(capacity: number, schedule: Side[], items = 8): ChanHb {
  const m = new ChanHb(capacity, items);
  for (const s of schedule) m.act(s);
  return m;
}
