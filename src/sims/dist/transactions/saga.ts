/**
 * A saga engine on the shared network: a trip booking (flight, hotel, car) as a chain of local transactions, each
 * with a compensating transaction (Garcia-Molina and Salem, "Sagas", SIGMOD 1987).
 *
 * Nodes: 0 is the orchestrator (or, in choreography, the trip app that starts the saga and hears the result);
 * 1..steps are the services; the last node is traveller B, who books a flight seat with a plain local transaction.
 *
 * - Orchestration: the orchestrator sends BOOK to each service in turn and waits for the reply. On FAILED it sends
 *   CANCEL to the booked services in reverse order. It re-sends a command that got no reply after `retry` ms.
 * - Choreography: no one is in charge. Each service reacts to the event of the one before (BOOKED → book; FAILED or
 *   CANCELLED from the next one → compensate) and emits its own event.
 * - Semantic lock: a booking stays PENDING until the saga completes; then a CONFIRM round marks it CONFIRMED.
 * - Compensation "inverse" adds the seat back (free += 1). "restore" writes back the value read before the booking,
 *   which loses any update made in between (a lost update).
 * - Fault: the hotel can crash right after its local commit, before it sends its reply or event. With an outbox, the
 *   message was stored in the same local transaction, and a relay sends it after restart. With `idempotent`, a
 *   service remembers the saga's request id and answers a repeat without doing the work again.
 */
import { Net, type NodeId } from "../net";

export type SagaMode = "orchestration" | "choreography";
export type Status = "PENDING" | "CONFIRMED" | "CANCELLED";
export type SagaKind = "book" | "cancel" | "confirm" | "booked" | "failed" | "cancelled" | "confirmed" | "done";

export interface SagaMsg {
  k: SagaKind;
  /** The step (service) the message is about. */
  step: number;
  saga: "A" | "B";
}

export const SERVICE_NAMES = ["flight", "hotel", "car"];
export const sagaLabel = (p: SagaMsg) => `${p.k.toUpperCase()}${p.saga === "B" ? " B" : ""}`;

export interface SagaCfg {
  mode: SagaMode;
  steps: number;
  /** 0: every step succeeds. k: step k refuses (for example, no room). */
  fail: number;
  semanticLock: boolean;
  compensation: "inverse" | "restore";
  /** Traveller B books a flight seat at this time (ms), or never. */
  bAt: number | null;
  /** Step 2 (the hotel) crashes after its local commit and before it sends. */
  crashHotel: boolean;
  outbox: boolean;
  idempotent: boolean;
  /** Model inputs: one-way message latency, the orchestrator's re-send time, and the hotel's restart time (ms). */
  latency: number;
  retry: number;
  restartAfter: number;
  /** Units of stock at each service. */
  capacity: number;
}

export const DEFAULT_SAGA: SagaCfg = {
  mode: "orchestration", steps: 3, fail: 3, semanticLock: false, compensation: "inverse", bAt: null,
  crashHotel: false, outbox: false, idempotent: true, latency: 10, retry: 60, restartAfter: 40, capacity: 2,
};

export interface Booking { saga: "A" | "B"; status: Status }
export interface ServiceSnap { t: number; free: number; bookings: Booking[]; what: string }

interface Service {
  free: number;
  bookings: Booking[];
  /** Idempotency table: request id → the reply already given. */
  seen: Map<string, SagaMsg>;
  /** For "restore": the value of `free` read before A's booking. */
  before: number;
  outbox: { to: NodeId; msg: SagaMsg }[];
  history: ServiceSnap[];
  crashed: boolean;
}

export type SagaResult = "completed" | "compensated" | "stuck";

export class Saga {
  readonly cfg: SagaCfg;
  readonly net: Net<SagaMsg>;
  readonly svc: Service[];
  readonly B: NodeId;
  result: SagaResult | null = null;
  resultAt?: number;
  bResult: "booked" | "refused" | null = null;
  private await: { k: SagaKind; step: number } | null = null;
  private confirms = new Set<number>();
  private retryTimer = 0;

  constructor(cfg: Partial<SagaCfg> = {}) {
    this.cfg = { ...DEFAULT_SAGA, ...cfg };
    const n = this.cfg.steps;
    this.B = n + 1;
    this.net = new Net<SagaMsg>(n + 2, { seed: 1, latency: { min: this.cfg.latency, max: this.cfg.latency }, fifo: true }, {
      onMessage: (to, m) => (to === 0 ? this.app(m.from, m.payload) : to === this.B ? this.traveller(m.payload) : this.service(to, m.from, m.payload)),
      onTimer: (node, tag) => this.timer(node, tag),
      onRecover: (node) => this.relay(node),
    });
    this.svc = Array.from({ length: n + 1 }, () => ({
      free: this.cfg.capacity, bookings: [], seen: new Map(), before: this.cfg.capacity, outbox: [], history: [], crashed: false,
    }));
    for (let i = 1; i <= n; i++) this.snap(i, "start");
  }

  run(until = 2000) {
    if (this.cfg.mode === "orchestration") this.command(1, "book");
    else this.net.send(0, 1, { k: "book", step: 1, saga: "A" });
    if (this.cfg.bAt !== null) this.net.setTimer(0, this.cfg.bAt, "B");
    this.net.runUntil(until);
    return this;
  }

  // ---------------------------------------------------------------- orchestrator / trip app (node 0)

  private command(step: number, k: "book" | "cancel") {
    this.await = { k: k === "book" ? "booked" : "cancelled", step };
    this.net.send(0, step, { k, step, saga: "A" });
    this.armRetry();
  }

  private armRetry() {
    this.net.cancelTimer(this.retryTimer);
    if (this.cfg.mode === "orchestration") this.retryTimer = this.net.setTimer(0, this.cfg.retry, "retry");
  }

  private finish(r: SagaResult) {
    if (this.result) return;
    this.result = r;
    this.resultAt = this.net.now;
    this.await = null;
    this.net.cancelTimer(this.retryTimer);
  }

  private app(from: NodeId, p: SagaMsg) {
    const n = this.cfg.steps;
    if (this.cfg.mode === "choreography") {
      // The trip app only hears the end of the chain.
      if (p.k === "done") this.finish("completed");
      if ((p.k === "failed" || p.k === "cancelled") && from === 1) this.finish("compensated");
      return;
    }
    if (this.result) return;
    const a = this.await;
    if (p.k === "confirmed" && a?.k === "confirmed") {
      this.confirms.add(p.step);
      if (this.confirms.size === n) this.finish("completed");
      return;
    }
    if (!a || a.step !== p.step) return; // a late duplicate
    if (p.k === "booked" && a.k === "booked") {
      if (p.step < n) this.command(p.step + 1, "book");
      else if (this.cfg.semanticLock) {
        this.await = { k: "confirmed", step: 0 };
        for (let i = 1; i <= n; i++) this.net.send(0, i, { k: "confirm", step: i, saga: "A" });
        this.armRetry();
      } else this.finish("completed");
    } else if ((p.k === "failed" && a.k === "booked") || (p.k === "cancelled" && a.k === "cancelled")) {
      if (p.step > 1) this.command(p.step - 1, "cancel");
      else this.finish("compensated");
    }
  }

  private timer(node: NodeId, tag: string) {
    if (tag === "B") return void this.net.send(this.B, 1, { k: "book", step: 1, saga: "B" });
    if (tag === "restart") return void this.restart(2);
    if (tag !== "retry" || node !== 0 || this.result || !this.await) return;
    const a = this.await;
    if (a.k === "confirmed") {
      for (let i = 1; i <= this.cfg.steps; i++) if (!this.confirms.has(i)) this.net.send(0, i, { k: "confirm", step: i, saga: "A" });
    } else this.net.send(0, a.step, { k: a.k === "booked" ? "book" : "cancel", step: a.step, saga: "A" });
    this.armRetry();
  }

  private traveller(p: SagaMsg) {
    this.bResult = p.k === "booked" ? "booked" : "refused";
  }

  // ---------------------------------------------------------------- services (nodes 1..steps)

  private snap(i: number, what: string) {
    const s = this.svc[i]!;
    s.history.push({ t: this.net.now, free: s.free, bookings: s.bookings.map((b) => ({ ...b })), what });
  }

  /** Sends from service i: through the outbox (stored, then relayed) or directly. */
  private emit(i: number, to: NodeId, msg: SagaMsg, crashNow: boolean) {
    const s = this.svc[i]!;
    if (this.cfg.outbox) s.outbox.push({ to, msg });
    if (crashNow) {
      s.crashed = true;
      this.net.crash(i);
      this.net.setTimer(0, this.cfg.restartAfter, "restart");
      return;
    }
    if (this.cfg.outbox) this.relay(i);
    else this.net.send(i, to, msg);
  }

  /** The outbox relay: sends what is stored, then marks it sent. It runs after each commit and after a restart. */
  private relay(i: NodeId) {
    const s = this.svc[i];
    if (!s) return;
    for (const o of s.outbox) this.net.send(i, o.to, o.msg);
    s.outbox = [];
  }

  private restart(i: number) {
    this.net.recover(i);
  }

  private service(i: number, from: NodeId, p: SagaMsg) {
    const n = this.cfg.steps, s = this.svc[i]!, chor = this.cfg.mode === "choreography";
    if (p.saga === "B") {
      // Traveller B: one plain local transaction on the flight.
      if (s.free > 0) {
        s.free -= 1;
        s.bookings.push({ saga: "B", status: "CONFIRMED" });
        this.snap(i, "B books a seat");
        this.net.send(i, from, { k: "booked", step: i, saga: "B" });
      } else this.net.send(i, from, { k: "failed", step: i, saga: "B" });
      return;
    }
    // Which local action does this message ask for?
    let act: "book" | "cancel" | "confirm" | null = null;
    if (p.k === "book" || (chor && p.k === "booked" && from === i - 1)) act = "book";
    else if (p.k === "cancel" || (chor && (p.k === "failed" || p.k === "cancelled") && from === i + 1)) act = "cancel";
    else if (p.k === "confirm" || (chor && p.k === "done" && from === n)) act = "confirm";
    if (!act) return;
    const reqId = `A:${act}`;
    const replyTo = (k: SagaKind): NodeId => {
      if (!chor) return 0;
      if (k === "booked") return i === n ? 0 : i + 1;
      if (k === "failed" || k === "cancelled") return i === 1 ? 0 : i - 1;
      return 0;
    };
    if (this.cfg.idempotent && s.seen.has(reqId)) {
      // A repeat: answer again, do not book again.
      const prev = s.seen.get(reqId)!;
      if (!chor || act !== "confirm") this.net.send(i, chor ? replyTo(prev.k) : 0, prev);
      return;
    }
    let reply: SagaMsg;
    if (act === "book") {
      if (i === this.cfg.fail || s.free === 0) {
        reply = { k: "failed", step: i, saga: "A" };
        this.snap(i, "refuses: no stock");
      } else {
        s.before = s.free;
        s.free -= 1;
        s.bookings.push({ saga: "A", status: this.cfg.semanticLock ? "PENDING" : "CONFIRMED" });
        reply = { k: "booked", step: i, saga: "A" };
        this.snap(i, `books for A (${this.cfg.semanticLock ? "PENDING" : "CONFIRMED"})`);
      }
    } else if (act === "cancel") {
      const b = s.bookings.find((x) => x.saga === "A" && x.status !== "CANCELLED");
      if (b) {
        b.status = "CANCELLED";
        s.free = this.cfg.compensation === "inverse" ? s.free + 1 : s.before;
        this.snap(i, `cancels A (${this.cfg.compensation === "inverse" ? "free + 1" : `free := ${s.before}`})`);
      }
      reply = { k: "cancelled", step: i, saga: "A" };
    } else {
      for (const b of s.bookings) if (b.saga === "A" && b.status === "PENDING") b.status = "CONFIRMED";
      this.snap(i, "confirms A");
      reply = { k: "confirmed", step: i, saga: "A" };
    }
    if (this.cfg.idempotent) s.seen.set(reqId, reply);
    const crashNow = this.cfg.crashHotel && i === 2 && act === "book" && !s.crashed;
    if (chor && act === "confirm") return; // in choreography the final event needs no answer
    if (chor && reply.k === "booked" && i === n) {
      // The last service ends the saga: it tells the app and, with a semantic lock, the services to confirm.
      this.emit(i, 0, { k: "done", step: i, saga: "A" }, crashNow);
      if (this.cfg.semanticLock) {
        for (let j = 1; j <= n; j++) if (j !== i) this.emit(i, j, { k: "done", step: i, saga: "A" }, false);
        for (const b of s.bookings) if (b.saga === "A" && b.status === "PENDING") b.status = "CONFIRMED";
        this.snap(i, "confirms A");
      }
      return;
    }
    this.emit(i, replyTo(reply.k), reply, crashNow);
  }

  // ---------------------------------------------------------------- read-outs

  /** What a reader sees at service i at time t: the last committed state at or before t. */
  stateAt(i: number, t: number): ServiceSnap {
    const h = this.svc[i]!.history;
    let r = h[0]!;
    for (const x of h) if (x.t <= t) r = x;
    return r;
  }

  /** Messages of the saga itself (not traveller B's). */
  sagaMessages() {
    return this.net.messages.filter((m) => m.from !== this.B && m.to !== this.B && m.payload.saga === "A").length;
  }

  /** For each service: free + active bookings must equal the capacity. */
  invariantBroken(): number[] {
    const bad: number[] = [];
    for (let i = 1; i <= this.cfg.steps; i++) {
      const s = this.svc[i]!;
      const active = s.bookings.filter((b) => b.status !== "CANCELLED").length;
      if (s.free + active !== this.cfg.capacity) bad.push(i);
    }
    return bad;
  }

  /** Services where saga A holds more than one active booking. */
  doubleBooked(): number[] {
    const bad: number[] = [];
    for (let i = 1; i <= this.cfg.steps; i++) if (this.svc[i]!.bookings.filter((b) => b.saga === "A" && b.status !== "CANCELLED").length > 1) bad.push(i);
    return bad;
  }

  /** Times at which a reader saw A's booking as CONFIRMED at a service where A later cancelled (a dirty read). */
  dirtyWindow(i: number): { from: number; to: number } | null {
    const h = this.svc[i]!.history;
    const from = h.find((x) => x.bookings.some((b) => b.saga === "A" && b.status === "CONFIRMED"));
    const to = h.find((x) => x.bookings.some((b) => b.saga === "A" && b.status === "CANCELLED"));
    return from && to ? { from: from.t, to: to.t } : null;
  }

  /** The final consistent state: all of A's bookings active (completed) or none (compensated). */
  atomicEnd(): boolean {
    const active = Array.from({ length: this.cfg.steps }, (_, k) => this.svc[k + 1]!.bookings.some((b) => b.saga === "A" && b.status !== "CANCELLED"));
    if (this.result === "completed") return active.every(Boolean);
    if (this.result === "compensated") return active.every((x) => !x);
    return false;
  }
}

export const runSaga = (cfg: Partial<SagaCfg>, until = 2000) => new Saga(cfg).run(until);
