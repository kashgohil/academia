/**
 * Event loops on sockets.
 *
 * - `herdRun`: W workers serve one port. Who wakes up when a connection arrives, and which worker gets it?
 *   Four designs: all workers block in accept() (one exclusive wait queue, FIFO), each worker has its own epoll set
 *   with the shared listening socket (every idle worker wakes), the same with EPOLLEXCLUSIVE (one idle worker
 *   wakes), and SO_REUSEPORT (one listening socket and one accept queue per worker; the kernel hashes the 4-tuple).
 *   The winner of a shared queue follows what Cloudflare measured in 2017: blocking accept() is FIFO (the worker that
 *   waited longest), epoll is LIFO (the worker that went idle last).
 * - `etAcceptRun`: one event loop, a listening socket in level- or edge-triggered mode, and a burst of real TCP
 *   connects (SocketWorld). An edge-triggered loop that accepts one connection per event leaves connections in the
 *   accept queue until the next connection makes a new edge.
 * - `TimerHeap`: the binary min-heap that a reactor uses for its timers, with a count of the swaps it does.
 *
 * HERD_MODEL holds MODEL INPUTS.
 */
import { mulberry32 } from "../../rng";
import { SWITCH_INPUTS, ALL_MITIGATIONS, syscallNs } from "../../os/processes";
import { SocketWorld, type ListenSocket } from "./sockets";
import type { TcpConn } from "../transport";

// ============================================================================ who wakes up

export type WakeMode = "accept" | "epoll" | "exclusive" | "reuseport";
export const WAKE_LABEL: Record<WakeMode, string> = {
  accept: "Blocking accept()",
  epoll: "epoll, shared socket",
  exclusive: "EPOLLEXCLUSIVE",
  reuseport: "SO_REUSEPORT",
};

/** MODEL INPUTS, in nanoseconds. */
export const HERD_MODEL = {
  /** A thread wakes up and runs: one switch, from the context switching lesson. */
  wakeNs: SWITCH_INPUTS.directNs,
  /** One system call (epoll_wait returning, or accept failing with EAGAIN), from the system calls lesson. */
  syscallNs: syscallNs(ALL_MITIGATIONS),
} as const;

export interface HerdOpts {
  mode: WakeMode;
  workers: number;
  /** New connections per second. */
  rate: number;
  /** Mean service time per connection, ms (exponential). */
  serviceMs: number;
  /** Connections in the run. */
  n: number;
  seed: number;
}

export const HERD_DEFAULTS: HerdOpts = { mode: "epoll", workers: 8, rate: 2000, serviceMs: 1, n: 20_000, seed: 7 };

export interface HerdResult {
  opts: HerdOpts;
  /** Threads woken per connection. */
  wakeups: number;
  /** accept() calls that failed with EAGAIN, per connection. */
  eagain: number;
  /** CPU spent on wakeups that found nothing, per connection, ns. */
  wastedNs: number;
  /** Share of connections per worker. */
  share: number[];
  /** Wait in the accept queue, ms. */
  waitMean: number;
  waitP99: number;
  /** Share of connections that waited although some worker was idle when it arrived. */
  waitedWhileIdle: number;
  /** Offered load per worker. */
  load: number;
}

/** A deterministic discrete-event run. Arrivals are Poisson; service times are exponential. */
export function herdRun(o: Partial<HerdOpts> = {}): HerdResult {
  const opts = { ...HERD_DEFAULTS, ...o };
  const W = opts.workers;
  const rng = mulberry32(opts.seed);
  const exp = (mean: number) => -Math.log(1 - rng()) * mean;
  const busyUntil = new Array<number>(W).fill(0);
  const idleSince = new Array<number>(W).fill(0).map((_, i) => -W + i); // worker 0 went to sleep first
  const served = new Array<number>(W).fill(0);
  const shared = opts.mode !== "reuseport";
  // Queues hold arrival times. Shared modes use queue 0.
  const queues: number[][] = Array.from({ length: shared ? 1 : W }, () => []);
  const waits: number[] = [];
  let wakeups = 0, eagain = 0, waitedIdle = 0;

  // Advance every worker to time t: a worker that finishes takes the next connection from its queue without sleeping.
  const advance = (t: number) => {
    for (;;) {
      let w = -1;
      for (let i = 0; i < W; i++) if (busyUntil[i]! > 0 && busyUntil[i]! <= t && (w < 0 || busyUntil[i]! < busyUntil[w]!)) w = i;
      if (w < 0) return;
      const now = busyUntil[w]!;
      const q = queues[shared ? 0 : w]!;
      const a = q.shift();
      if (a !== undefined) {
        waits.push(now - a);
        served[w]!++;
        busyUntil[w] = now + exp(opts.serviceMs);
      } else {
        busyUntil[w] = 0;
        idleSince[w] = now;
      }
    }
  };
  const start = (w: number, t: number, arrived: number) => {
    waits.push(t - arrived);
    served[w]!++;
    busyUntil[w] = t + exp(opts.serviceMs);
  };

  let t = 0;
  for (let k = 0; k < opts.n; k++) {
    t += exp(1000 / opts.rate);
    advance(t);
    const idle = [...Array(W).keys()].filter((i) => busyUntil[i] === 0);
    if (opts.mode === "reuseport") {
      const w = Math.floor(rng() * W); // the hash of the 4-tuple picks the socket
      if (busyUntil[w] === 0 && queues[w]!.length === 0) {
        wakeups++;
        start(w, t, t);
      } else {
        if (idle.length) waitedIdle++;
        queues[w]!.push(t);
      }
      continue;
    }
    if (!idle.length) {
      queues[0]!.push(t);
      continue;
    }
    let w: number;
    if (opts.mode === "accept") w = idle.reduce((a, b) => (idleSince[b]! < idleSince[a]! ? b : a)); // FIFO
    else w = idle.reduce((a, b) => (idleSince[b]! > idleSince[a]! ? b : a)); // LIFO
    if (opts.mode === "epoll") {
      wakeups += idle.length;
      eagain += idle.length - 1;
    } else wakeups++;
    start(w, t, t);
  }
  advance(Infinity);
  const sorted = [...waits].sort((a, b) => a - b);
  const total = served.reduce((a, b) => a + b, 0);
  return {
    opts,
    wakeups: wakeups / opts.n,
    eagain: eagain / opts.n,
    wastedNs: (eagain * (HERD_MODEL.wakeNs + 2 * HERD_MODEL.syscallNs)) / opts.n,
    share: served.map((s) => s / total),
    waitMean: waits.reduce((a, b) => a + b, 0) / waits.length,
    waitP99: sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))]!,
    waitedWhileIdle: waitedIdle / opts.n,
    load: (opts.rate * opts.serviceMs) / 1000 / W,
  };
}

// ============================================================================ an edge-triggered accept loop

export type Trigger = "level" | "edge";

export interface EtOpts {
  trigger: Trigger;
  /** Accept until EAGAIN (true), or accept one connection per event (false). */
  drain: boolean;
  /** Clients that connect in the burst, 0.2 ms apart. */
  burst: number;
  /** One more client connects at this time, ms. 0: none. */
  lateAt: number;
  /** Loop time to accept and set up one connection, ms (a model input). */
  handleMs: number;
  delay: number;
}

export const ET_DEFAULTS: EtOpts = { trigger: "edge", drain: false, burst: 4, lateAt: 300, handleMs: 2, delay: 5 };

export interface LoopEvent { t: number; call: string; result: string; tone?: "good" | "bad" | "warn" }
export interface EtConn {
  id: number;
  /** Entered the accept queue (server side ESTABLISHED). */
  queued: number;
  accepted?: number;
  late: boolean;
}

export interface EtRun {
  opts: EtOpts;
  log: LoopEvent[];
  conns: EtConn[];
  /** [start, end) when the loop works; elsewhere it sleeps in epoll_wait. */
  busy: [number, number][];
  /** Connections still in the queue at the end of the run. */
  stuck: number;
  /** Events that epoll_wait returned. */
  wakeups: number;
  eagains: number;
  tEnd: number;
}

/**
 * One loop thread. Linux semantics: each new connection in the accept queue calls the socket's wakeup callback, which
 * puts the epoll item on the ready list if it is not there yet. epoll_wait takes the ready list. In level mode the
 * item goes back on the list while the socket is still readable. In edge mode it does not.
 */
export function etAcceptRun(o: Partial<EtOpts> = {}): EtRun {
  const opts = { ...ET_DEFAULTS, ...o };
  const world = new SocketWorld(["clients", "server"], { tcp: { isn: 0, delayedAck: 0 } });
  const { net } = world;
  net.connect(0, 1, { rate: 1e9, delay: opts.delay });
  const ls: ListenSocket = world.listen(1, 80, 128);
  const log: LoopEvent[] = [];
  const conns: EtConn[] = [];
  const busy: [number, number][] = [];
  const byConn = new Map<TcpConn, EtConn>();
  let onReady = false, sleeping = true, wakeups = 0, eagains = 0;
  const say = (call: string, result: string, tone?: LoopEvent["tone"]) => log.push({ t: net.now, call, result, tone });

  ls.onReady = () => {
    const c = ls.acceptQueue.at(-1)!;
    const e: EtConn = { id: conns.length + 1, queued: net.now, late: net.now >= opts.lateAt && opts.lateAt > 0 };
    conns.push(e);
    byConn.set(c, e);
    const was = onReady;
    onReady = true;
    say(`(kernel) connection ${e.id} joins the accept queue`, `${ls.acceptQueue.length} waiting; ${was ? "the item is already on the ready list" : "the item joins the ready list"}`);
    if (sleeping) wake();
  };

  const wake = () => {
    // epoll_wait: level mode reports a readable socket; edge mode reports only a new edge.
    const ready = opts.trigger === "level" ? ls.acceptQueue.length > 0 : onReady;
    onReady = opts.trigger === "level" ? ls.acceptQueue.length > 0 : false;
    if (!ready) {
      sleeping = true;
      const left = ls.acceptQueue.length;
      say("epoll_wait()", left ? `sleeps, with ${left} connection${left > 1 ? "s" : ""} still in the accept queue` : "sleeps", left ? "bad" : undefined);
      return;
    }
    sleeping = false;
    wakeups++;
    say("epoll_wait()", "1 event: the listening socket is readable");
    const t0 = net.now;
    let t = t0;
    const take = () => {
      const c = ls.accept();
      if (!c) {
        eagains++;
        say("accept()", "-1, EAGAIN: the queue is empty", "good");
        return false;
      }
      const e = byConn.get(c)!;
      e.accepted = net.now;
      say("accept()", `connection ${e.id}`);
      return true;
    };
    // The loop runs its accepts one after another; each takes handleMs of loop time.
    const step = () => {
      const ok = take();
      if (ok) {
        t = net.now + opts.handleMs;
        net.at(t, () => (opts.drain ? step() : finish()));
      } else finish();
    };
    const finish = () => {
      busy.push([t0, net.now]);
      wake();
    };
    step();
  };

  for (let i = 0; i < opts.burst; i++) net.at(10 + i * 0.2, () => world.stack.connect(0, 1, 80, { port: 41000 + i }));
  if (opts.lateAt > 0) net.at(opts.lateAt, () => world.stack.connect(0, 1, 80, { port: 42000 }));
  const tEnd = Math.max(400, opts.lateAt + 100);
  net.runUntil(tEnd);
  return { opts, log, conns, busy, stuck: ls.acceptQueue.length, wakeups, eagains, tEnd };
}

// ============================================================================ reactor timers

/** A binary min-heap of deadlines, as a reactor keeps for idle timeouts. `swaps` counts the moves it made. */
export class TimerHeap {
  private a: { at: number; id: number }[] = [];
  swaps = 0;
  get size() {
    return this.a.length;
  }
  peek() {
    return this.a[0];
  }
  push(at: number, id: number) {
    const a = this.a;
    a.push({ at, id });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.at <= a[i]!.at) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      this.swaps++;
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.at < a[m]!.at) m = l;
        if (r < a.length && a[r]!.at < a[m]!.at) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        this.swaps++;
        i = m;
      }
    }
    return top;
  }
  /** The epoll_wait timeout in ms: until the earliest deadline, or -1 (wait forever) when there is none. */
  timeout(now: number) {
    const t = this.peek();
    return t ? Math.max(0, Math.ceil(t.at - now)) : -1;
  }
}
