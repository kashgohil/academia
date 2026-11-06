/**
 * Reliable causal broadcast on the shared Net: the delivery layer that operation-based CRDTs need.
 *
 * Each op gets an id (origin, seq) and the vector clock V of its origin at the time it was made, so V[origin] = seq.
 * A replica j with delivered vector D delivers an op from `origin` only when
 *   V[origin] = D[origin] + 1   (it is the next op from that origin), and
 *   V[k] ≤ D[k] for every other k   (every op that the origin had delivered before, j has delivered too).
 * Otherwise the op waits in a buffer. An op with V[origin] ≤ D[origin] was delivered before: it is a duplicate, and
 * it is dropped. So the layer gives exactly-once delivery in causal order, if the network eventually delivers.
 *
 * The network may lose messages. Anti-entropy repairs that: every `antiEntropy` ms a replica sends D to a random
 * peer, and the peer resends the ops that D lacks.
 *
 * Two weaker modes show what breaks: `causal: false` delivers each op when it arrives, and `dedupe: false`
 * then also applies a duplicate a second time.
 *
 * Causal stability (Baquero, Almeida, Shoker 2017): an op is stable at replica i when i knows that every replica has
 * delivered it. Then no op that is concurrent with it can still arrive, so metadata for it can be thrown away.
 * Replica i learns D of replica j from the vector clocks on j's messages.
 */
import { Net, type Message, type NetConfig } from "../net";
import { vcZero, type VC } from "../time/vector";

export interface OpMeta { origin: number; seq: number; vc: VC }
export type CbMsg<Op> = ({ k: "op"; op: Op } & OpMeta) | { k: "sync"; vc: VC };

export interface CbConfig {
  /** Buffer ops until their causal past is delivered. Implies exactly-once. */
  causal: boolean;
  /** Without causal: drop an op whose id was seen before. */
  dedupe: boolean;
  /** Anti-entropy period in ms; 0 is off. */
  antiEntropy: number;
}

export const CB_DEFAULT: CbConfig = { causal: true, dedupe: true, antiEntropy: 0 };

export interface DeliveredOp<Op> extends OpMeta { op: Op; at: number; local: boolean }

export class CausalNet<Op> {
  readonly net: Net<CbMsg<Op>>;
  readonly n: number;
  readonly cfg: CbConfig;
  /** Per replica: ops delivered from each origin. */
  readonly D: VC[];
  /** Per replica: ops that arrived but wait for their causal past. */
  readonly buffer: (({ k: "op"; op: Op } & OpMeta) & { msgId: number })[][];
  /** Per replica: every op in the order it was applied. */
  readonly log: DeliveredOp<Op>[][];
  /** Per replica: the latest delivered vector known for each other replica (for causal stability). */
  readonly known: VC[][];
  /** Ops applied a second time (only possible with dedupe off). */
  duplicatesApplied = 0;
  /** Duplicates that the layer recognised and dropped. */
  duplicatesDropped = 0;
  /** The largest buffer seen at any replica. */
  maxBuffered = 0;
  private seen: Set<string>[];
  /** Timers of the protocol on top (any tag but "ae"). */
  onTimer?: (node: number, tag: string) => void;

  constructor(n: number, netCfg: Partial<NetConfig>, cfg: Partial<CbConfig>, private apply: (node: number, op: Op, meta: OpMeta & { at: number; local: boolean }) => void) {
    this.n = n;
    this.cfg = { ...CB_DEFAULT, ...cfg };
    this.D = Array.from({ length: n }, () => vcZero(n));
    this.buffer = Array.from({ length: n }, () => []);
    this.log = Array.from({ length: n }, () => []);
    this.known = Array.from({ length: n }, () => Array.from({ length: n }, () => vcZero(n)));
    this.seen = Array.from({ length: n }, () => new Set<string>());
    this.net = new Net<CbMsg<Op>>(n, netCfg, {
      onMessage: (i, m) => this.receive(i, m),
      onTimer: (i, tag, net) => {
        if (tag !== "ae") return void this.onTimer?.(i, tag);
        let j = Math.floor(net.random() * (n - 1));
        if (j >= i) j++;
        net.send(i, j, { k: "sync", vc: [...this.D[i]!] });
        net.setTimer(i, this.cfg.antiEntropy, "ae");
      },
    });
    if (this.cfg.antiEntropy > 0) for (let i = 0; i < n; i++) this.net.setTimer(i, (this.cfg.antiEntropy * (i + 1)) / n, "ae");
  }

  /** Makes an op at replica i, applies it there, and sends it to every other replica. */
  broadcast(i: number, op: Op, opts: { delay?: (to: number) => number | undefined } = {}): OpMeta {
    const D = this.D[i]!;
    D[i]! += 1;
    const meta: OpMeta = { origin: i, seq: D[i]!, vc: [...D] };
    this.seen[i]!.add(`${i}:${meta.seq}`);
    this.deliverLocal(i, op, meta, true);
    for (let j = 0; j < this.n; j++) if (j !== i) this.net.send(i, j, { k: "op", op, ...meta }, { delay: opts.delay?.(j) });
    return meta;
  }

  private deliverLocal(i: number, op: Op, meta: OpMeta, local: boolean) {
    const at = this.net.now;
    this.log[i]!.push({ ...meta, op, at, local });
    this.apply(i, op, { ...meta, at, local });
  }

  private learn(i: number, from: number, vc: VC) {
    const row = this.known[i]![from]!;
    for (let k = 0; k < this.n; k++) row[k] = Math.max(row[k]!, vc[k]!);
  }

  private deliverable(i: number, m: OpMeta) {
    const D = this.D[i]!;
    return m.vc[m.origin] === D[m.origin]! + 1 && m.vc.every((x, k) => k === m.origin || x <= D[k]!);
  }

  private receive(i: number, msg: Message<CbMsg<Op>>) {
    const m = msg.payload;
    if (m.k === "sync") {
      // Resend every op that the asker has not delivered, in the order this replica applied them.
      for (const e of this.log[i]!) if (e.seq > m.vc[e.origin]!) this.net.send(i, msg.from, { k: "op", op: e.op, origin: e.origin, seq: e.seq, vc: e.vc });
      return;
    }
    this.learn(i, m.origin, m.vc);
    const D = this.D[i]!;
    if (this.cfg.causal) {
      if (m.seq <= D[m.origin]! || this.buffer[i]!.some((b) => b.origin === m.origin && b.seq === m.seq)) {
        this.duplicatesDropped++;
        return;
      }
      this.buffer[i]!.push({ ...m, msgId: msg.id });
      this.maxBuffered = Math.max(this.maxBuffered, this.buffer[i]!.length);
      this.drain(i);
      return;
    }
    const id = `${m.origin}:${m.seq}`;
    if (this.seen[i]!.has(id)) {
      if (this.cfg.dedupe) { this.duplicatesDropped++; return; }
      this.duplicatesApplied++;
    }
    this.seen[i]!.add(id);
    D[m.origin] = Math.max(D[m.origin]!, m.seq);
    this.deliverLocal(i, m.op, m, false);
  }

  /** Delivers buffered ops while one is ready. */
  private drain(i: number) {
    for (;;) {
      const buf = this.buffer[i]!;
      const k = buf.findIndex((b) => this.deliverable(i, b));
      if (k < 0) return;
      const [b] = buf.splice(k, 1);
      this.D[i]![b!.origin] = b!.seq;
      this.seen[i]!.add(`${b!.origin}:${b!.seq}`);
      this.deliverLocal(i, b!.op, b!, false);
    }
  }

  /** Why a buffered op waits at replica i: the ops it needs that i has not delivered, as [origin, seq] ranges. */
  missing(i: number, m: OpMeta): { origin: number; from: number; to: number }[] {
    const D = this.D[i]!;
    const out: { origin: number; from: number; to: number }[] = [];
    for (let k = 0; k < this.n; k++) {
      const need = k === m.origin ? m.seq - 1 : m.vc[k]!;
      if (need > D[k]!) out.push({ origin: k, from: D[k]! + 1, to: need });
    }
    return out;
  }

  /** Per origin, the largest seq that replica i knows every replica has delivered. */
  stable(i: number): VC {
    const rows = this.known[i]!.map((r, j) => (j === i ? this.D[i]! : r));
    return Array.from({ length: this.n }, (_, k) => Math.min(...rows.map((r) => r[k]!)));
  }
}
