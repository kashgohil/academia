/**
 * Leases and fencing tokens on the shared Net.
 *
 * A lease is a lock with a timeout. The lock service (node 0) grants it with a time to live (TTL) and a token: a number
 * that grows by one with each grant. The holder renews it. If the holder stops renewing, the lease expires by the
 * service's clock, and the service may grant it to another client.
 *
 * The holder decides that it still holds the lease by its own clock. A pause (garbage collection, a VM stall) or a
 * clock that runs slow can make it act after the lease expired. A storage service that checks the token rejects such
 * a stale request. These are the pieces:
 *
 * - LeaseService: grants, renews and expires leases, and records each lease for the diagram.
 * - FencedStore: a register (or a counter) that checks tokens: never, on writes only, or on every access.
 * - leaseTimeline: the scenario of the first demo. A holds the lease, pauses, wakes and writes. B takes over.
 * - marginNeeded: how much of a lease the holder must give up to stay safe, for a drift bound, a delay and a pause.
 */
import { Net, type Message, type NodeId } from "../net";

// ---------------------------------------------------------------- messages

export type LeaseMsg =
  | { k: "acquire" }
  | { k: "grant"; token: number; ttl: number }
  | { k: "busy" }
  | { k: "renew"; token: number }
  | { k: "renewed"; token: number }
  | { k: "lost"; token: number }
  | { k: "release"; token: number }
  /** A storage access. `token` is 0 when the client sends none. */
  | { k: "read"; op: number; token: number }
  | { k: "write"; op: number; token: number; value: number }
  | { k: "reply"; op: number; ok: boolean; value: number };

// ---------------------------------------------------------------- the lock service

export interface LeaseRecord {
  token: number;
  client: NodeId;
  /** Real time of the grant. */
  from: number;
  /** Real time when the lease ended: it expired by the service clock, or the holder released it. */
  until: number;
  released: boolean;
}

/**
 * The lock service's state. It runs on one node and uses that node's clock for expiry. It is a single server here;
 * a real one (Chubby, ZooKeeper, etcd) replicates this state with consensus, so that the token survives a crash.
 */
/** The part of Net that clock reasoning needs. */
export interface Clocks {
  now: number;
  readonly drift: number[];
  readonly offset: number[];
  clock(i: NodeId): number;
}

/** The real time at which node `i`'s clock reads `local`. */
export const realTimeOf = (net: Clocks, i: NodeId, local: number) => (local - net.offset[i]!) / (1 + net.drift[i]!);

export class LeaseService {
  holder: { client: NodeId; token: number; expires: number } | null = null;
  nextToken = 1;
  readonly leases: LeaseRecord[] = [];

  constructor(readonly node: NodeId, readonly ttl: number) {}

  private real(net: Clocks, local: number) {
    return realTimeOf(net, this.node, local);
  }

  private expire(net: Clocks) {
    const h = this.holder;
    if (h && net.clock(this.node) >= h.expires) {
      const rec = this.leases.find((r) => r.token === h.token)!;
      rec.until = this.real(net, h.expires);
      this.holder = null;
    }
  }

  /** The real time when the current lease will expire, if nothing renews it. */
  currentEnd(net: Clocks) {
    return this.holder ? this.real(net, this.holder.expires) : net.now;
  }

  onMessage(net: Net<LeaseMsg>, m: Message<LeaseMsg>) {
    const p = m.payload;
    this.expire(net);
    const now = net.clock(this.node);
    if (p.k === "acquire") {
      if (this.holder && this.holder.client !== m.from) return void net.send(this.node, m.from, { k: "busy" });
      if (!this.holder) {
        const token = this.nextToken++;
        this.holder = { client: m.from, token, expires: now + this.ttl };
        this.leases.push({ token, client: m.from, from: net.now, until: Infinity, released: false });
      } else this.holder.expires = now + this.ttl;
      net.send(this.node, m.from, { k: "grant", token: this.holder.token, ttl: this.ttl });
    } else if (p.k === "renew") {
      if (this.holder && this.holder.token === p.token) {
        this.holder.expires = now + this.ttl;
        net.send(this.node, m.from, { k: "renewed", token: p.token });
      } else net.send(this.node, m.from, { k: "lost", token: p.token });
    } else if (p.k === "release") {
      if (this.holder && this.holder.token === p.token) {
        const rec = this.leases.find((r) => r.token === p.token)!;
        rec.until = net.now;
        rec.released = true;
        this.holder = null;
      }
    }
  }

  /** Closes the record of a lease that is still open at the end of a run. */
  finish(net: Clocks) {
    this.expire(net);
    if (this.holder) {
      const rec = this.leases.find((r) => r.token === this.holder!.token)!;
      rec.until = this.real(net, this.holder.expires);
    }
  }

  /** The highest token granted at real time `t`. */
  latestTokenAt(t: number) {
    let best = 0;
    for (const r of this.leases) if (r.from <= t) best = Math.max(best, r.token);
    return best;
  }
}

// ---------------------------------------------------------------- the storage service

/** none: the store ignores tokens. writes: it rejects a write with a token below the highest write token. all: it
 *  rejects any read or write with a token below the highest token it has seen on any access. */
export type FenceMode = "none" | "writes" | "all";

export interface StoreOp {
  t: number;
  from: NodeId;
  kind: "read" | "write";
  token: number;
  value: number;
  ok: boolean;
  /** Accepted, but the storage had already accepted a request with a newer token: an old holder acted after a new one. */
  stale: boolean;
}

export class FencedStore {
  value = 0;
  /** The highest token seen: on writes only in "writes" mode, on every access in "all" mode. */
  maxToken = 0;
  readonly ops: StoreOp[] = [];
  /** The highest token of any accepted request, in every mode. Used only to label stale requests. */
  private newest = 0;

  constructor(readonly node: NodeId, readonly mode: FenceMode) {}

  onMessage(net: Net<LeaseMsg>, m: Message<LeaseMsg>) {
    const p = m.payload;
    if (p.k !== "read" && p.k !== "write") return;
    const checks = this.mode === "all" || (this.mode === "writes" && p.k === "write");
    const ok = !checks || p.token >= this.maxToken;
    if (ok && this.mode !== "none" && (p.k === "write" || this.mode === "all")) this.maxToken = Math.max(this.maxToken, p.token);
    if (ok && p.k === "write") this.value = p.value;
    const stale = ok && p.token < this.newest;
    if (ok) this.newest = Math.max(this.newest, p.token);
    this.ops.push({ t: net.now, from: m.from, kind: p.k, token: p.token, value: p.k === "write" ? p.value : this.value, ok, stale });
    net.send(this.node, m.from, { k: "reply", op: p.op, ok, value: this.value });
  }

  /** Accepted writes in arrival order. */
  accepted() {
    return this.ops.filter((o) => o.kind === "write" && o.ok);
  }
}

// ---------------------------------------------------------------- a process that can pause

/**
 * Wraps a client's handlers so that the process can stop for a while, as in a stop-the-world GC pause or a VM stall.
 * While it is paused, timers and messages wait. At the end of the pause they run in their original order.
 */
export class Pausable {
  pauses: { from: number; to: number }[] = [];
  private queue: (() => void)[] = [];
  private wakeArmed = new Set<number>();

  constructor(readonly node: NodeId) {}

  pausedAt(t: number) {
    return this.pauses.find((p) => t >= p.from && t < p.to);
  }

  /** Runs `f` now, or at the end of the current pause. */
  run(net: Net<LeaseMsg>, f: () => void) {
    const p = this.pausedAt(net.now);
    if (!p) return f();
    this.queue.push(f);
    if (!this.wakeArmed.has(p.to)) {
      this.wakeArmed.add(p.to);
      net.setTimer(this.node, p.to - net.now, "wake");
    }
  }

  /** Call from onTimer for the "wake" tag. */
  wake() {
    const q = this.queue;
    this.queue = [];
    for (const f of q) f();
  }
}

// ---------------------------------------------------------------- the lease timeline (first demo)

export interface LeaseTimelineCfg {
  seed: number;
  /** Lease time to live, ms. */
  ttl: number;
  /** The holder gives up this much of the lease, by its own clock, as a safety margin. */
  margin: number;
  /** Pause of client A, ms. 0: no pause. */
  pause: number;
  /** Where the pause starts: just after A checked its lease for its 3rd write, or just before that check. */
  pauseWhere: "afterCheck" | "beforeCheck";
  /** Rate error of A's clock: -0.2 runs 20% slow. */
  driftA: number;
  /** A's clock does not advance while A is paused, as when a paused VM resumes before its clock is corrected. */
  clockStops: boolean;
  /** How the storage checks tokens. */
  fence: FenceMode;
}

export const LEASE_TIMELINE: LeaseTimelineCfg = { seed: 3, ttl: 600, margin: 0, pause: 900, pauseWhere: "afterCheck", driftA: 0, clockStops: false, fence: "none" };

/** Node ids in the timeline. */
export const LT = { svc: 0, A: 1, B: 2, store: 3 } as const;
/** A writes this often, B tries to acquire this often, and A renews this often (ms). */
const WORK_EVERY = 150, RETRY_EVERY = 100, B_START = 300, PREPARE = 5, A_WRITES = 8, B_WRITES = 2;

export interface Belief {
  client: NodeId;
  token: number;
  from: number;
  to: number;
  /** Why it ended. */
  why: "check" | "lost" | "done" | "end";
}

export interface LeaseTimeline {
  net: Net<LeaseMsg>;
  svc: LeaseService;
  store: FencedStore;
  pauseA: { from: number; to: number } | null;
  beliefs: Belief[];
  /** Accepted writes with a token older than one the storage had already accepted: the lock failed to protect the data. */
  staleAccepted: StoreOp[];
  /** Writes that the storage rejected. */
  rejected: StoreOp[];
  /** Real time when both clients believed they held the lease, if they did. */
  overlap: { from: number; to: number } | null;
  /** The storage's final value: A writes 100 + i, B writes 200 + i. */
  final: number;
  tEnd: number;
}

/**
 * A holds the lease and does 8 writes, 150 ms apart. Before each write it checks its lease by its own clock, then
 * prepares the write for 30 ms and sends it. It renews every TTL/3. B starts asking for the lease at 300 ms and
 * retries every 100 ms; when it gets the lease, it writes twice. A pause stops A just after (or just before) the
 * check for its 3rd write.
 */
export function leaseTimeline(cfg: Partial<LeaseTimelineCfg> = {}): LeaseTimeline {
  const c = { ...LEASE_TIMELINE, ...cfg };
  const svc = new LeaseService(LT.svc, c.ttl);
  const store = new FencedStore(LT.store, c.fence);
  const pa = new Pausable(LT.A);
  const beliefs: Belief[] = [];
  let op = 0;

  // Client state. `deadline` is in the client's own clock.
  const st = new Map<NodeId, { token: number; deadline: number; asked: number; writes: number; belief: Belief | null; done: boolean; finalOp: number }>();
  for (const id of [LT.A, LT.B]) st.set(id, { token: 0, deadline: -Infinity, asked: 0, writes: 0, belief: null, done: false, finalOp: -1 });
  const end = (id: NodeId, why: Belief["why"]) => {
    const s = st.get(id)!;
    if (s.belief) { s.belief.to = net.now; s.belief.why = why; s.belief = null; }
  };
  const valid = (id: NodeId) => {
    const s = st.get(id)!;
    return s.token > 0 && net.clock(id) < s.deadline - c.margin;
  };
  let checks = 0;
  const pause = (from: number) => {
    pa.pauses.push({ from, to: from + c.pause });
    if (c.clockStops) net.offset[LT.A] = net.offset[LT.A]! - c.pause * (1 + c.driftA); // the time it would have counted
  };

  const clientTimer = (id: NodeId, tag: string) => {
    const s = st.get(id)!;
    if (tag === "acquire") {
      if (s.token || s.done) return;
      s.asked = net.clock(id);
      net.send(id, LT.svc, { k: "acquire" });
      net.setTimer(id, RETRY_EVERY, "acquire");
    } else if (tag === "renew") {
      if (!s.token || s.done) return;
      s.asked = net.clock(id);
      net.send(id, LT.svc, { k: "renew", token: s.token });
      net.setTimer(id, c.ttl / 3, "renew");
    } else if (tag === "work") {
      if (!s.token || s.done) return;
      if (id === LT.A) checks++;
      if (id === LT.A && checks === 3 && c.pause > 0 && c.pauseWhere === "beforeCheck" && !pa.pauses.length) {
        // The process stops just before this check, and runs it when it wakes.
        pause(net.now);
        return void pa.run(net, () => clientTimer(id, tag));
      }
      if (!valid(id)) {
        end(id, "check");
        s.token = 0;
        s.done = true;
        return;
      }
      if (id === LT.A && checks === 3 && c.pause > 0 && c.pauseWhere === "afterCheck" && !pa.pauses.length)
        pause(net.now + 1);
      net.setTimer(id, PREPARE, "send");
    } else if (tag === "send") {
      if (s.done || !s.token) return;
      s.writes++;
      const value = (id === LT.A ? 100 : 200) + s.writes;
      net.send(id, LT.store, { k: "write", op: ++op, token: s.token, value });
      const limit = id === LT.A ? A_WRITES : B_WRITES;
      if (s.writes >= limit) s.finalOp = op; // release when the storage confirms the last write
      else net.setTimer(id, WORK_EVERY - PREPARE, "work");
    } else if (tag === "wake") pa.wake();
  };

  const clientMsg = (id: NodeId, m: Message<LeaseMsg>) => {
    const s = st.get(id)!;
    const p = m.payload;
    if (s.done) return;
    if (p.k === "grant" && !s.token) {
      s.token = p.token;
      s.deadline = s.asked + p.ttl; // measured from the request, by the client's clock
      s.belief = { client: id, token: p.token, from: net.now, to: Infinity, why: "end" };
      beliefs.push(s.belief);
      net.setTimer(id, c.ttl / 3, "renew");
      net.setTimer(id, 5, "work");
    } else if (p.k === "renewed" && p.token === s.token) {
      s.deadline = s.asked + c.ttl;
    } else if (p.k === "reply" && p.op === s.finalOp) {
      end(id, "done");
      net.send(id, LT.svc, { k: "release", token: s.token });
      s.token = 0;
      s.done = true;
    } else if (p.k === "lost" && p.token === s.token) {
      end(id, "lost");
      s.token = 0;
      s.done = true;
    }
  };

  const net: Net<LeaseMsg> = new Net<LeaseMsg>(4, { seed: c.seed, latency: { min: 5, max: 15 }, fifo: true }, {
    onMessage(node, m) {
      if (node === LT.svc) svc.onMessage(net, m);
      else if (node === LT.store) store.onMessage(net, m);
      else if (node === LT.A) pa.run(net, () => clientMsg(node, m));
      else clientMsg(node, m);
    },
    onTimer(node, tag) {
      if (node === LT.A && tag !== "wake") pa.run(net, () => clientTimer(node, tag));
      else clientTimer(node, tag);
    },
  });
  net.drift[LT.A] = c.driftA;
  net.setTimer(LT.A, 1, "acquire");
  net.setTimer(LT.B, B_START, "acquire");
  net.runUntil(6000);
  svc.finish(net);
  for (const b of beliefs) if (b.to === Infinity) b.to = net.now;

  const a = beliefs.filter((b) => b.client === LT.A), bb = beliefs.filter((b) => b.client === LT.B);
  let overlap: LeaseTimeline["overlap"] = null;
  for (const x of a) for (const y of bb) {
    const from = Math.max(x.from, y.from), to = Math.min(x.to, y.to);
    if (to > from && (!overlap || from < overlap.from)) overlap = { from, to };
  }
  const writes = store.ops.filter((o) => o.kind === "write");
  const lastT = Math.max(...net.messages.map((m) => m.deliveredAt ?? m.sentAt), ...svc.leases.map((l) => Math.min(l.until, 4000)));
  return {
    net, svc, store, beliefs, overlap,
    pauseA: pa.pauses[0] ?? null,
    staleAccepted: writes.filter((o) => o.stale),
    rejected: writes.filter((o) => !o.ok),
    final: store.value,
    tEnd: Math.ceil((lastT + 60) / 100) * 100,
  };
}

// ---------------------------------------------------------------- the safety margin

/**
 * The margin a holder must subtract from a lease of `ttl` ms, so that its last request reaches the storage before
 * the service could grant the lease again.
 *
 * Assume each clock's rate error is at most `rho` (as a fraction). Worst case: the service clock runs fast, so the
 * lease ends after ttl/(1+rho) real ms; the holder's clock runs slow, so its local ttl − m lasts (ttl − m)/(1 − rho)
 * real ms. The holder's clock starts before it sends the request, so that start is no later than the grant. The last
 * request may then wait for a pause of `pause` ms and take `delay` ms on the network. Safety needs
 *
 *   (ttl − m)/(1 − rho) + pause + delay ≤ ttl/(1 + rho)
 *   m ≥ ttl · 2rho/(1 + rho) + (1 − rho)(pause + delay)
 */
export function marginNeeded(ttl: number, rho: number, delay: number, pause = 0): number {
  return (ttl * 2 * rho) / (1 + rho) + (1 - rho) * (pause + delay);
}

/** The part of the lease that is left to use: (ttl − margin)/ttl, or 0. */
export const usableFraction = (ttl: number, rho: number, delay: number, pause = 0) => Math.max(0, (ttl - marginNeeded(ttl, rho, delay, pause)) / ttl);

/**
 * A lease read in Raft (dissertation section 6.4.1): after a majority acknowledged a heartbeat sent at `start`, the
 * leader may answer reads alone until start + electionTimeout / bound, where `bound` limits how much faster one
 * clock can advance than another. Returns that end time.
 */
export const raftLeaseEnd = (start: number, electionTimeout: number, bound: number) => start + electionTimeout / bound;
