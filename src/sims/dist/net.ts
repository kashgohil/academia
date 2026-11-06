/**
 * A deterministic network for distributed-systems demos. Every module uses it, so that all lessons share one model:
 *
 * - Time is a number of milliseconds. Nothing happens unless an event is due, so runs are fast and repeatable.
 * - A message waits a random latency in [min, max], so messages can arrive out of order. `fifo` keeps per-link order.
 * - Messages can be lost (`dropRate`) or duplicated (`dupRate`). A partition drops every message between groups.
 * - A crashed node receives nothing, and its timers do not fire. On recovery it keeps only what the protocol stored.
 * - Each node has a local clock that drifts and has an offset, for the time and order lessons.
 * - The same seed gives the same run, so a demo can replay a scenario and a test can pin its numbers.
 *
 * A protocol is a set of handlers. The network calls them for each delivery and timer, in time order.
 */
import { mulberry32, type Rng } from "../rng";

export type NodeId = number;

export interface NetConfig {
  seed: number;
  /** One-way latency in ms, uniform in [min, max]. */
  latency: { min: number; max: number };
  /** Probability that a message is lost. */
  dropRate: number;
  /** Probability that a delivered message arrives twice. */
  dupRate: number;
  /** Keep the send order on each link (as TCP does). */
  fifo: boolean;
}

export const DEFAULT_NET: NetConfig = { seed: 1, latency: { min: 5, max: 15 }, dropRate: 0, dupRate: 0, fifo: false };

export interface Message<P> {
  id: number;
  from: NodeId;
  to: NodeId;
  sentAt: number;
  /** Undefined until it is delivered. */
  deliveredAt?: number;
  /** Why it was not delivered. "dropped" happens in the network; the others happen at the receiver. */
  lost?: "dropped" | "partition" | "crashed";
  /** When it was lost: the send time for "dropped", the arrival time for the others. */
  lostAt?: number;
  payload: P;
  /** A second copy of an earlier message. */
  dupOf?: number;
}

export type NetEvent<P> =
  | { kind: "send"; t: number; msg: Message<P> }
  | { kind: "deliver"; t: number; msg: Message<P> }
  | { kind: "lose"; t: number; msg: Message<P> }
  | { kind: "timer"; t: number; node: NodeId; tag: string }
  | { kind: "crash" | "recover"; t: number; node: NodeId }
  | { kind: "partition"; t: number; groups: NodeId[][] }
  | { kind: "heal"; t: number }
  | { kind: "note"; t: number; node: NodeId; text: string };

export interface Handlers<P> {
  onMessage?(node: NodeId, msg: Message<P>, net: Net<P>): void;
  onTimer?(node: NodeId, tag: string, net: Net<P>): void;
  onRecover?(node: NodeId, net: Net<P>): void;
}

interface Pending<P> {
  t: number;
  seq: number;
  run: () => void;
  kind: "deliver" | "timer";
  node: NodeId;
  msg?: Message<P>;
  tag?: string;
  timerId?: number;
}

/** A binary heap ordered by time, then by insertion order, so that ties are deterministic. */
class Queue<T extends { t: number; seq: number }> {
  private a: T[] = [];
  get size() {
    return this.a.length;
  }
  peek() {
    return this.a[0];
  }
  push(x: T) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (Queue.less(a[p]!, a[i]!)) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && Queue.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && Queue.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
  private static less(x: { t: number; seq: number }, y: { t: number; seq: number }) {
    return x.t < y.t || (x.t === y.t && x.seq < y.seq);
  }
}

export class Net<P> {
  readonly cfg: NetConfig;
  readonly n: number;
  now = 0;
  readonly trace: NetEvent<P>[] = [];
  readonly messages: Message<P>[] = [];
  private rng: Rng;
  private q = new Queue<Pending<P>>();
  private seq = 0;
  private nextMsg = 1;
  private nextTimer = 1;
  private cancelled = new Set<number>();
  private down = new Set<NodeId>();
  private groups: NodeId[][] | null = null;
  /** Last delivery time on each link, for FIFO. */
  private linkLast = new Map<string, number>();
  /** Clock rate error (for example 50e-6 = 50 ppm fast) and offset in ms, per node. */
  readonly drift: number[];
  readonly offset: number[];

  constructor(n: number, cfg: Partial<NetConfig> = {}, private handlers: Handlers<P> = {}) {
    this.n = n;
    this.cfg = { ...DEFAULT_NET, ...cfg, latency: { ...DEFAULT_NET.latency, ...cfg.latency } };
    this.rng = mulberry32(this.cfg.seed);
    this.drift = new Array<number>(n).fill(0);
    this.offset = new Array<number>(n).fill(0);
  }

  setHandlers(h: Handlers<P>) {
    this.handlers = h;
  }

  /** A random number in [0, 1) from the run's seed. Protocols must use this, not Math.random, to stay repeatable. */
  random(): number {
    return this.rng();
  }

  isUp(node: NodeId) {
    return !this.down.has(node);
  }

  /** True if a message from `a` can reach `b` now. */
  connected(a: NodeId, b: NodeId) {
    if (!this.groups) return true;
    return this.groups.some((g) => g.includes(a) && g.includes(b));
  }

  /** The time that node `i` reads from its own clock. */
  clock(i: NodeId) {
    return this.now * (1 + this.drift[i]!) + this.offset[i]!;
  }

  /** Sends a message. `delay` fixes this message's latency instead of drawing it from cfg.latency. */
  send(from: NodeId, to: NodeId, payload: P, opts: { delay?: number } = {}): Message<P> {
    const msg: Message<P> = { id: this.nextMsg++, from, to, sentAt: this.now, payload };
    this.messages.push(msg);
    this.trace.push({ kind: "send", t: this.now, msg });
    if (this.rng() < this.cfg.dropRate) return this.lose(msg, "dropped", this.now);
    const copies = this.rng() < this.cfg.dupRate ? 2 : 1;
    for (let c = 0; c < copies; c++) {
      const m = c === 0 ? msg : { ...msg, id: this.nextMsg++, dupOf: msg.id };
      if (c > 0) this.messages.push(m);
      const drawn = this.cfg.latency.min + this.rng() * (this.cfg.latency.max - this.cfg.latency.min);
      let at = this.now + (opts.delay ?? drawn);
      if (this.cfg.fifo) {
        const key = `${from}>${to}`;
        at = Math.max(at, (this.linkLast.get(key) ?? -Infinity) + 1e-6);
        this.linkLast.set(key, at);
      }
      this.q.push({ t: at, seq: this.seq++, kind: "deliver", node: to, msg: m, run: () => this.deliver(m) });
    }
    return msg;
  }

  broadcast(from: NodeId, payload: P, includeSelf = false) {
    for (let to = 0; to < this.n; to++) if (to !== from || includeSelf) this.send(from, to, payload);
  }

  /** Fires `onTimer(node, tag)` after `delay` ms, unless the node is down then. Returns an id for cancelTimer. */
  setTimer(node: NodeId, delay: number, tag: string): number {
    const id = this.nextTimer++;
    this.q.push({ t: this.now + delay, seq: this.seq++, kind: "timer", node, tag, timerId: id, run: () => this.fire(node, tag, id) });
    return id;
  }

  cancelTimer(id: number) {
    this.cancelled.add(id);
  }

  crash(node: NodeId) {
    this.down.add(node);
    this.trace.push({ kind: "crash", t: this.now, node });
  }

  recover(node: NodeId) {
    this.down.delete(node);
    this.trace.push({ kind: "recover", t: this.now, node });
    this.handlers.onRecover?.(node, this);
  }

  /** Only nodes in the same group can talk. Nodes not listed are alone. */
  partition(groups: NodeId[][]) {
    this.groups = groups;
    this.trace.push({ kind: "partition", t: this.now, groups });
  }

  heal() {
    this.groups = null;
    this.trace.push({ kind: "heal", t: this.now });
  }

  note(node: NodeId, text: string) {
    this.trace.push({ kind: "note", t: this.now, node, text });
  }

  /** Runs the next due event. Returns false when nothing is left to run. */
  step(): boolean {
    const e = this.q.pop();
    if (!e) return false;
    this.now = Math.max(this.now, e.t);
    e.run();
    return true;
  }

  /** Runs events up to time `until` (inclusive), or until `maxEvents` have run. */
  runUntil(until: number, maxEvents = 1e6) {
    let k = 0;
    while (k < maxEvents) {
      const e = this.q.peek();
      if (!e || e.t > until) break;
      this.step();
      k++;
    }
    this.now = Math.max(this.now, until);
  }

  /** Runs until no event is left, with a safety limit. */
  runAll(maxEvents = 1e6) {
    let k = 0;
    while (k++ < maxEvents && this.step());
  }

  private deliver(msg: Message<P>) {
    if (!this.isUp(msg.to)) return void this.lose(msg, "crashed", this.now);
    if (!this.connected(msg.from, msg.to)) return void this.lose(msg, "partition", this.now);
    msg.deliveredAt = this.now;
    this.trace.push({ kind: "deliver", t: this.now, msg });
    this.handlers.onMessage?.(msg.to, msg, this);
  }

  private lose(msg: Message<P>, why: NonNullable<Message<P>["lost"]>, t: number) {
    msg.lost = why;
    msg.lostAt = t;
    this.trace.push({ kind: "lose", t, msg });
    return msg;
  }

  private fire(node: NodeId, tag: string, id: number) {
    if (this.cancelled.delete(id) || !this.isUp(node)) return;
    this.trace.push({ kind: "timer", t: this.now, node, tag });
    this.handlers.onTimer?.(node, tag, this);
  }
}
