/**
 * A deterministic runtime for the concurrency track: threads on P cores, locks, condition variables, semaphores and
 * Go-style channels. Every module uses it, so all lessons share one model:
 *
 * - Time is a number of nanoseconds (a float). Nothing happens unless an event is due, so runs are fast and repeatable.
 * - A thread is a generator function. A blocking operation is a sub-generator that the thread runs with `yield*`, so
 *   its result is typed: `const r = yield* t.recv(ch)`. An operation that never blocks (unlock, signal, close,
 *   tryLock, trySend, spawn) is a plain call and takes no time.
 * - `work(ns)` holds a core for ns. Only `work`, lock acquisition (`lockNs`, `transferNs`) and context switches
 *   (`switchNs`) use core time. Channel operations take no core time; a blocked thread pays `wakeNs` when it wakes.
 * - Scheduling: one global run queue (FIFO, or a seeded random pick) feeds P cores. A thread that becomes runnable goes
 *   back to the core it last ran on if that core is free. With `quantumNs` > 0, a long `work` (or a spin) gives up its
 *   core at the end of a quantum when other threads wait.
 * - A context switch costs `switchNs` of core time when a core changes thread. A parked thread becomes runnable
 *   `wakeNs` after the event that wakes it. An uncontended acquire costs `lockNs`, plus `transferNs` when the lock was
 *   last taken on another core (its cache line moves). These costs are MODEL INPUTS of the right order of magnitude
 *   (see DEFAULT_COSTS), not measurements of any machine.
 * - Mutexes block, spin, or spin then park (`wait: "adaptive"`). `handoff: true` gives the lock to the oldest waiter at
 *   unlock (FIFO, a convoy risk). `handoff: false` frees it and wakes one parked waiter, which must compete again:
 *   a running thread can take the lock first (barging). Spinning waiters take a freed lock before parked ones.
 * - Channels follow Go: capacity 0 is a rendezvous, `recv` gives `ok: false` once closed and drained, a send on a
 *   closed channel or a second close is a panic, and `select` picks among ready cases with the seeded random source.
 * - A panic (or any exception a thread throws) stops the run and fills `error`. When no thread can run and no event is
 *   pending, but some thread has not finished, the run stops and fills `deadlock` ("all goroutines are asleep").
 * - The same seed and the same program give the same run, so a demo can replay a scenario and a test can pin its
 *   numbers. Use `t.rand()`, never Math.random.
 *
 * `run()` returns a RunResult: core spans and thread state intervals for timelines, an event log for steppers, and
 * statistics per thread, core, mutex, rwlock, semaphore, condition variable and channel. Set `record: false` for long
 * sweeps: spans, states, events and the logs over time stay empty, and the statistics stay exact.
 *
 * For step-level interleavings of single instructions and exhaustive exploration, use src/sims/os/sync/machine.ts.
 */
import { mulberry32, type Rng } from "../rng";

// ---------------------------------------------------------------- configuration and cost model

/**
 * Default costs in ns. They are order-of-magnitude MODEL INPUTS for a current x86 server, not measurements:
 * - switchNs: a context switch on one core (save and restore registers, scheduler work, cold caches after it).
 * - wakeNs: from the unpark call (futex wake) until the woken thread is runnable.
 * - lockNs: one uncontended atomic acquire (a locked compare-and-swap on a cache line the core already owns).
 * - transferNs: the lock's cache line moves to another core (a cross-core cache miss).
 */
export const DEFAULT_COSTS = { switchNs: 2_000, wakeNs: 5_000, lockNs: 20, transferNs: 100 } as const;

/** Default spin budget of an adaptive mutex: about one context switch, the classic choice for spin-then-park. */
export const DEFAULT_SPIN_NS = 2_000;

export interface RuntimeConfig {
  cores: number;
  seed: number;
  /** How a free core picks from the run queue: the oldest thread, or a seeded random one. */
  sched: "fifo" | "random";
  /** Preemption quantum in ns. 0 turns preemption off: a thread keeps its core until it blocks, yields or ends. */
  quantumNs: number;
  /** Model input: core time of a context switch. */
  switchNs: number;
  /** Model input: delay from unpark to runnable. */
  wakeNs: number;
  /** Model input: core time of an uncontended lock acquire. */
  lockNs: number;
  /** Model input: extra acquire time when the last acquire of the same lock ran on another core. */
  transferNs: number;
  /** Keep spans, states, events and logs over time. Turn off for long sweeps; statistics stay. */
  record: boolean;
}

export interface MutexOptions {
  /** "block" parks at once, "spin" holds the core until the lock is free, "adaptive" spins `spinNs` and then parks. */
  wait: "block" | "spin" | "adaptive";
  /** true: unlock gives the lock to the oldest waiter (FIFO). false: unlock frees it, and waiters compete (barging). */
  handoff: boolean;
  /** Spin budget of an adaptive mutex, per attempt. */
  spinNs: number;
}

// ---------------------------------------------------------------- results

export type ThreadState = "running" | "runnable" | "blocked" | "sleeping" | "spinning";

/** Time on one core. "switch" spans carry the tid of the thread that the core switches to. */
export interface Span { core: number; tid: number; start: number; end: number; kind: "run" | "spin" | "switch"; label?: string }

/** One thread in one state. `on` names what it waits for: "mutex m", "chan jobs (send)". */
export interface StateSpan { tid: number; start: number; end: number; state: ThreadState; on?: string }

export type EventKind =
  | "spawn" | "exit" | "join" | "lock" | "unlock" | "handoff" | "block" | "spin" | "park" | "wake" | "preempt"
  | "acquire" | "release" | "wait" | "signal" | "broadcast" | "spurious" | "send" | "recv" | "close" | "select"
  | "error" | "deadlock";

export interface RtEvent { t: number; tid: number; kind: EventKind; obj?: string; detail?: string }

export interface ThreadStats {
  tid: number;
  name: string;
  state: ThreadState | "done";
  /** What the thread waits for now, if it waits. */
  on?: string;
  start: number;
  /** Exit time. Undefined while the thread has not finished. */
  end?: number;
  /** The value the thread returned. */
  value?: unknown;
  runNs: number;
  runnableNs: number;
  blockedNs: number;
  sleepNs: number;
  spinNs: number;
}

export interface CoreStats { core: number; busyNs: number; spinNs: number; switchNs: number }

export interface MutexStats {
  name: string;
  acquisitions: number;
  /** Acquisitions where the first attempt failed. */
  contended: number;
  /** Time from the lock call until the thread owns the lock (summed, and the maximum). */
  waitNs: number;
  maxWaitNs: number;
  /** Time from ownership to unlock. With handoff it includes the wake-up of the new owner (a convoy). */
  holdNs: number;
  /** Unlocks that gave the lock directly to a waiter. */
  handoffs: number;
  /** [time, owner tid or -1], at each change. Recorded only with `record: true`. */
  owners: [number, number][];
}

export interface RwLockStats { name: string; reads: number; writes: number; readWaitNs: number; writeWaitNs: number; maxReadWaitNs: number; maxWriteWaitNs: number }

export interface SemaphoreStats { name: string; acquires: number; contended: number; waitNs: number; maxWaitNs: number }

export interface CondStats { name: string; waits: number; signals: number; broadcasts: number; wakeups: number; spurious: number; lostSignals: number }

export interface ChannelStats {
  name: string;
  capacity: number;
  sends: number;
  recvs: number;
  maxLen: number;
  /** Time that senders and receivers spent blocked on this channel. */
  sendBlockedNs: number;
  recvBlockedNs: number;
  /** [time, buffered values], at each change. Recorded only with `record: true`. */
  lens: [number, number][];
}

export interface RunResult {
  /** The simulated time when the run stopped. */
  now: number;
  /** The time the last finished thread finished. */
  makespan: number;
  /** All threads finished. */
  done: boolean;
  error?: { message: string; tid: number; name: string; t: number };
  deadlock?: { t: number; blocked: { tid: number; name: string; on: string }[]; detail: string };
  spans: Span[];
  states: StateSpan[];
  events: RtEvent[];
  threads: ThreadStats[];
  cores: CoreStats[];
  mutexes: MutexStats[];
  rwlocks: RwLockStats[];
  semaphores: SemaphoreStats[];
  conds: CondStats[];
  channels: ChannelStats[];
}

// ---------------------------------------------------------------- operations and the thread API

/** What a thread yields to the runtime. Internal: threads build these through the `Thread` methods. */
export type Op =
  | { k: "work"; ns: number; label?: string }
  | { k: "sleep"; ns: number }
  | { k: "yield" }
  | { k: "lock"; m: Mutex }
  | { k: "rlock"; rw: RwLock }
  | { k: "wlock"; rw: RwLock }
  | { k: "wait"; cv: Cond; m: Mutex }
  | { k: "acquire"; s: Semaphore }
  | { k: "send"; ch: Channel<unknown>; v: unknown }
  | { k: "recv"; ch: Channel<unknown> }
  | { k: "select"; cases: readonly SelectCase[]; dflt: boolean }
  | { k: "join"; id: number }
  | { k: "panic"; msg: string };

/** A blocking operation. Run it with `yield*`; its return value is the operation's result. */
export type Gen<R> = Generator<Op, R, unknown>;

/** The body of a thread. It can return a value, which `join` returns. */
export type ThreadFn<R = unknown> = (t: Thread) => Generator<Op, R, unknown>;

/** A thread id that remembers the return type of the thread, so `join` is typed. It is a plain number at runtime. */
export type ThreadId<R = unknown> = number & { readonly __returns?: R };

export type RecvResult<T> = { ok: true; value: T } | { ok: false; value: undefined };

export type SelectCase = { recv: Channel<unknown> } | { send: Channel<unknown>; value: unknown };
type RecvValue<C> = C extends { recv: Channel<infer T> } ? T : never;
/** `index` is the case that ran, or -1 for the default case. Receive cases fill `value` and `ok`. */
export interface SelectResult<V> { index: number; value?: V; ok?: boolean }

/** The handle a thread body gets. Blocking methods return sub-generators: call them with `yield*`. */
export interface Thread {
  readonly id: number;
  readonly name: string;
  /** The simulated time in ns. */
  now(): number;
  /** A number in [0, 1) from the run's seed. */
  rand(): number;
  /** Uses a core for ns. With a quantum, the thread can be preempted between quanta. */
  work(ns: number, label?: string): Gen<void>;
  /** Leaves the core for ns (a timer). */
  sleep(ns: number): Gen<void>;
  /** Goes to the back of the run queue. */
  yieldNow(): Gen<void>;
  lock(m: Mutex): Gen<void>;
  /** Unlock by a thread that does not own the mutex is a panic. */
  unlock(m: Mutex): void;
  /** Takes the mutex if it is free now, with no cost and no wait. */
  tryLock(m: Mutex): boolean;
  rlock(rw: RwLock): Gen<void>;
  runlock(rw: RwLock): void;
  wlock(rw: RwLock): Gen<void>;
  wunlock(rw: RwLock): void;
  /** Atomically unlocks m and parks on cv. After a wake-up it locks m again (which can block). Needs m held. */
  wait(cv: Cond, m: Mutex): Gen<void>;
  /** Wakes the oldest waiter. With no waiter the signal is lost. */
  signal(cv: Cond): void;
  broadcast(cv: Cond): void;
  acquire(s: Semaphore): Gen<void>;
  release(s: Semaphore): void;
  send<T>(ch: Channel<T>, value: T): Gen<void>;
  recv<T>(ch: Channel<T>): Gen<RecvResult<T>>;
  /** Sends if a receiver waits or the buffer has room. A closed channel panics. */
  trySend<T>(ch: Channel<T>, value: T): boolean;
  /** Receives if a value is ready or the channel is closed; null if it would block. */
  tryRecv<T>(ch: Channel<T>): RecvResult<T> | null;
  /** Closes the channel: receivers drain it and then get ok: false; blocked senders panic. A second close panics. */
  close<T>(ch: Channel<T>): void;
  /** Waits for the first ready case; several ready cases are picked at random (seeded), as in Go. */
  select<C extends readonly SelectCase[]>(cases: C, opts?: { default?: boolean }): Gen<SelectResult<RecvValue<C[number]>>>;
  spawn<R>(name: string, fn: ThreadFn<R>): ThreadId<R>;
  /** Waits until the thread ends and returns its value. */
  join<R>(id: ThreadId<R>): Gen<R>;
}

// ---------------------------------------------------------------- synchronization objects

/** A mutex. The fields after `stats` are live runtime state for steppers; do not change them. */
export class Mutex {
  readonly stats: MutexStats;
  owner: number = -1;
  /** @internal */ since = 0;
  /** @internal */ lastCore = -1;
  /** @internal */ readonly waiters: Th[] = [];
  constructor(readonly name: string, readonly opts: MutexOptions) {
    this.stats = { name, acquisitions: 0, contended: 0, waitNs: 0, maxWaitNs: 0, holdNs: 0, handoffs: 0, owners: [] };
  }
  /** Thread ids that wait, oldest first. */
  get waiting(): number[] {
    return this.waiters.map((w) => w.id);
  }
}

export class RwLock {
  readonly stats: RwLockStats;
  /** Tids that hold the read lock. */
  readonly readers = new Set<number>();
  writer = -1;
  /** @internal */ lastCore = -1;
  /** @internal */ readonly q: { th: Th; write: boolean }[] = [];
  constructor(readonly name: string, readonly prefer: "reader" | "writer" | "fair") {
    this.stats = { name, reads: 0, writes: 0, readWaitNs: 0, writeWaitNs: 0, maxReadWaitNs: 0, maxWriteWaitNs: 0 };
  }
}

export class Semaphore {
  readonly stats: SemaphoreStats;
  /** @internal */ lastCore = -1;
  /** @internal */ readonly q: Th[] = [];
  constructor(readonly name: string, public permits: number) {
    this.stats = { name, acquires: 0, contended: 0, waitNs: 0, maxWaitNs: 0 };
  }
}

export class Cond {
  readonly stats: CondStats;
  /** @internal */ readonly q: Th[] = [];
  constructor(readonly name: string, readonly spuriousRate: number) {
    this.stats = { name, waits: 0, signals: 0, broadcasts: 0, wakeups: 0, spurious: 0, lostSignals: 0 };
  }
}

/** A thread blocked on a channel, alone or as one case of a select. */
interface ChanWaiter { th: Th; v?: unknown; since: number; sel?: SelWait; index: number }
interface SelWait { done: boolean; entries: { ch: Channel<unknown>; w: ChanWaiter; send: boolean }[] }

export class Channel<T> {
  readonly stats: ChannelStats;
  /** Buffered values, oldest first. */
  readonly buf: T[] = [];
  closed = false;
  /** @internal */ readonly sendq: ChanWaiter[] = [];
  /** @internal */ readonly recvq: ChanWaiter[] = [];
  constructor(readonly name: string, readonly capacity: number) {
    this.stats = { name, capacity, sends: 0, recvs: 0, maxLen: 0, sendBlockedNs: 0, recvBlockedNs: 0, lens: [] };
  }
}

// ---------------------------------------------------------------- internals

/** The runtime's record of one thread. */
interface Th {
  id: number;
  name: string;
  gen: Generator<Op, unknown, unknown>;
  state: ThreadState | "done";
  on?: string;
  /** Start of the current state. */
  since: number;
  /** The core it runs on (or is being switched onto), or -1. */
  core: number;
  /** The operation in progress. null: the next step is gen.next(ret). */
  op: Op | null;
  ret: unknown;
  /** Bumped when a wait ends, so that stale timers do nothing. */
  tok: number;
  /** A lock was given to this thread while it was not running; its lock op only pays the acquire cost. */
  granted: boolean;
  /** When the current acquire first failed, or -1. */
  waitFrom: number;
  /** A spin that has used its quantum: the dispatcher may preempt it. */
  spinExpired: boolean;
  start: number;
  end?: number;
  value?: unknown;
  joiners: Th[];
  st: { runNs: number; runnableNs: number; blockedNs: number; sleepNs: number; spinNs: number };
}

interface Core {
  id: number;
  cur: Th | null;
  /** The last thread that ran here (for switch costs), or -1. */
  last: number;
  /** The current span. It stays here after it ends (spanEnd >= 0), so that an identical span can extend it. */
  span: { kind: Span["kind"]; tid: number; label?: string; start: number } | null;
  spanEnd: number;
  /** Start of the part of the open span not yet added to the statistics. */
  acc: number;
  st: CoreStats;
}

interface Ev { t: number; seq: number; run: () => void }

/** A binary heap ordered by time, then by insertion order, so that ties are deterministic. */
class Heap {
  private a: Ev[] = [];
  get size() {
    return this.a.length;
  }
  peek() {
    return this.a[0];
  }
  push(x: Ev) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (Heap.less(a[p]!, a[i]!)) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): Ev | undefined {
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
        if (l < a.length && Heap.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && Heap.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
  private static less(x: Ev, y: Ev) {
    return x.t < y.t || (x.t === y.t && x.seq < y.seq);
  }
}

/** A panic: a misuse that Go or pthreads would report (unlock by a non-owner, send on a closed channel). */
export class Panic extends Error {}

const STATE_KEY = { running: "runNs", runnable: "runnableNs", blocked: "blockedNs", sleeping: "sleepNs", spinning: "spinNs" } as const;
/** A thread that takes this many steps without using time is stuck in a loop of non-blocking calls. */
const MAX_STEPS_WITHOUT_TIME = 1_000_000;

const remove = <X>(a: X[], x: X) => {
  const i = a.indexOf(x);
  if (i >= 0) a.splice(i, 1);
  return i >= 0;
};

// ---------------------------------------------------------------- the runtime

export class Runtime {
  readonly cfg: RuntimeConfig;
  now = 0;
  makespan = 0;
  error?: RunResult["error"];
  deadlock?: RunResult["deadlock"];
  readonly spans: Span[] = [];
  readonly states: StateSpan[] = [];
  readonly events: RtEvent[] = [];
  private rng: Rng;
  private q = new Heap();
  private seq = 0;
  private over = false;
  private readonly ths: Th[] = [];
  private readonly cores: Core[];
  private readonly runq: Th[] = [];
  private readonly mutexes: Mutex[] = [];
  private readonly rwlocks: RwLock[] = [];
  private readonly sems: Semaphore[] = [];
  private readonly conds: Cond[] = [];
  private readonly chans: Channel<unknown>[] = [];

  constructor(cfg: Partial<RuntimeConfig> = {}) {
    this.cfg = { cores: 1, seed: 1, sched: "fifo", quantumNs: 0, ...DEFAULT_COSTS, record: true, ...cfg };
    this.rng = mulberry32(this.cfg.seed);
    this.cores = Array.from({ length: this.cfg.cores }, (_, id) => ({
      id, cur: null, last: -1, span: null, spanEnd: -1, acc: 0, st: { core: id, busyNs: 0, spinNs: 0, switchNs: 0 },
    }));
  }

  // ------------------------------------------------ objects

  mutex(name: string, opts: Partial<MutexOptions> = {}): Mutex {
    const m = new Mutex(name, { wait: "block", handoff: false, spinNs: DEFAULT_SPIN_NS, ...opts });
    this.mutexes.push(m);
    return m;
  }

  rwlock(name: string, opts: { prefer?: "reader" | "writer" | "fair" } = {}): RwLock {
    const rw = new RwLock(name, opts.prefer ?? "reader");
    this.rwlocks.push(rw);
    return rw;
  }

  /** A condition variable. `spuriousRate`: the chance that a wait returns without a signal (after one wake-up). */
  cond(name: string, opts: { spuriousRate?: number } = {}): Cond {
    const cv = new Cond(name, opts.spuriousRate ?? 0);
    this.conds.push(cv);
    return cv;
  }

  semaphore(name: string, n: number): Semaphore {
    const s = new Semaphore(name, n);
    this.sems.push(s);
    return s;
  }

  channel<T>(name: string, capacity = 0): Channel<T> {
    const ch = new Channel<T>(name, capacity);
    this.chans.push(ch as Channel<unknown>);
    return ch;
  }

  /** Starts a thread now. It is runnable at once. */
  spawn<R>(name: string, fn: ThreadFn<R>, parent = -1): ThreadId<R> {
    const id = this.ths.length;
    const th: Th = {
      id, name, gen: undefined!, state: "runnable", since: this.now, core: -1, op: null, ret: undefined, tok: 0,
      granted: false, waitFrom: -1, spinExpired: false, start: this.now, joiners: [],
      st: { runNs: 0, runnableNs: 0, blockedNs: 0, sleepNs: 0, spinNs: 0 },
    };
    this.ths.push(th);
    th.gen = fn(this.handle(th));
    this.log(parent, "spawn", undefined, name);
    this.runq.push(th);
    this.dispatch();
    return id as ThreadId<R>;
  }

  /** Runs `fn` at time t (not before now). For scripted scenarios: "a writer arrives at 5 µs". */
  at(t: number, fn: (rt: Runtime) => void) {
    this.after(Math.max(0, t - this.now), () => {
      try {
        fn(this);
      } catch (e) {
        this.fail(undefined, e);
      }
    });
  }

  /** A number in [0, 1) from the run's seed. */
  random() {
    return this.rng();
  }

  // ------------------------------------------------ running

  /** Runs the next event. False when the run is over (all done, a deadlock, or an error). */
  step(): boolean {
    if (this.over) return false;
    const e = this.q.pop();
    if (!e) {
      this.finish();
      return false;
    }
    this.now = e.t;
    e.run();
    return !this.over;
  }

  /** Runs until the run is over, or until `untilNs` (the time is then untilNs), or `maxEvents` (then an error). */
  run(opts: { untilNs?: number; maxEvents?: number } = {}): RunResult {
    const until = opts.untilNs ?? Infinity, max = opts.maxEvents ?? 50_000_000;
    let k = 0;
    while (!this.over) {
      const e = this.q.peek();
      if (!e) {
        this.finish();
        break;
      }
      if (e.t > until) {
        this.now = until;
        break;
      }
      if (k++ >= max) {
        this.fail(undefined, new Error(`stopped after ${max} events: a thread that never ends?`));
        break;
      }
      this.step();
    }
    return this.result();
  }

  get finished() {
    return this.over;
  }

  /** A snapshot of everything so far. Open spans and states end at `now`. */
  result(): RunResult {
    const rec = this.cfg.record, now = this.now;
    const spans = this.spans.slice();
    const cores = this.cores.map((c) => {
      const st = { ...c.st };
      if (c.span) {
        const end = c.spanEnd >= 0 ? c.spanEnd : now;
        if (c.spanEnd < 0) st[c.span.kind === "run" ? "busyNs" : c.span.kind === "spin" ? "spinNs" : "switchNs"] += now - c.acc;
        if (rec && end > c.span.start) spans.push({ core: c.id, tid: c.span.tid, start: c.span.start, end, kind: c.span.kind, label: c.span.label });
      }
      return st;
    });
    const states = this.states.slice();
    const threads = this.ths.map((th): ThreadStats => {
      const st = { ...th.st };
      if (th.state !== "done") {
        st[STATE_KEY[th.state]] += now - th.since;
        if (rec && now > th.since) states.push({ tid: th.id, start: th.since, end: now, state: th.state, on: th.on });
      }
      return { tid: th.id, name: th.name, state: th.state, on: th.on, start: th.start, end: th.end, value: th.value, ...st };
    });
    return {
      now, makespan: this.makespan, done: this.ths.every((t) => t.state === "done"), error: this.error, deadlock: this.deadlock,
      spans, states, events: this.events.slice(), threads, cores,
      mutexes: this.mutexes.map((m) => ({ ...m.stats, owners: m.stats.owners.slice() })),
      rwlocks: this.rwlocks.map((r) => ({ ...r.stats })),
      semaphores: this.sems.map((s) => ({ ...s.stats })),
      conds: this.conds.map((c) => ({ ...c.stats })),
      channels: this.chans.map((c) => ({ ...c.stats, lens: c.stats.lens.slice() })),
    };
  }

  // ------------------------------------------------ events, states and spans

  private after(dt: number, run: () => void) {
    this.q.push({ t: this.now + dt, seq: this.seq++, run });
  }

  private log(tid: number, kind: EventKind, obj?: string, detail?: string) {
    if (this.cfg.record) this.events.push({ t: this.now, tid, kind, obj, detail });
  }

  private setState(th: Th, s: ThreadState | "done", on?: string) {
    if (th.state === s && th.on === on) return;
    if (th.state !== "done") {
      const d = this.now - th.since;
      th.st[STATE_KEY[th.state]] += d;
      if (this.cfg.record && d > 0) this.states.push({ tid: th.id, start: th.since, end: this.now, state: th.state, on: th.on });
    }
    th.state = s;
    th.on = on;
    th.since = this.now;
  }

  /** Starts a span on a core. An identical span that ended just now is extended instead (work split into quanta). */
  private openSpan(c: Core, kind: Span["kind"], tid: number, label?: string) {
    const s = c.span;
    if (s && (c.spanEnd < 0 || c.spanEnd === this.now) && s.kind === kind && s.tid === tid && s.label === label) {
      if (c.spanEnd >= 0) {
        c.spanEnd = -1;
        c.acc = this.now;
      }
      return;
    }
    this.closeSpan(c);
    if (s && this.cfg.record && c.spanEnd > s.start) this.spans.push({ core: c.id, tid: s.tid, start: s.start, end: c.spanEnd, kind: s.kind, label: s.label });
    c.span = { kind, tid, label, start: this.now };
    c.spanEnd = -1;
    c.acc = this.now;
  }

  private closeSpan(c: Core) {
    if (!c.span || c.spanEnd >= 0) return;
    const d = this.now - c.acc;
    if (c.span.kind === "run") c.st.busyNs += d;
    else if (c.span.kind === "spin") c.st.spinNs += d;
    else c.st.switchNs += d;
    c.spanEnd = this.now;
  }

  // ------------------------------------------------ scheduling

  /** Gives free cores to runnable threads. It only schedules events; no thread code runs inside it. */
  private dispatch() {
    while (this.runq.length) {
      let core = this.freeCore(this.runq[0]!);
      if (!core) {
        // A spin that used its quantum gives way to a waiting thread.
        const spinner = this.cfg.quantumNs > 0 ? this.cores.find((c) => c.cur?.state === "spinning" && c.cur.spinExpired)?.cur : undefined;
        if (!spinner) return;
        this.preempt(spinner);
        core = this.freeCore(this.runq[0]!)!;
      }
      const i = this.cfg.sched === "random" && this.runq.length > 1 ? Math.floor(this.rng() * this.runq.length) : 0;
      const th = this.runq.splice(i, 1)[0]!;
      if (i !== 0) core = this.freeCore(th)!;
      core.cur = th;
      th.core = core.id;
      const sw = core.last >= 0 && core.last !== th.id ? this.cfg.switchNs : 0;
      if (sw > 0) this.openSpan(core, "switch", th.id);
      this.after(sw, () => this.start(th));
    }
  }

  /** A free core: the one the thread last ran on, else an unused one, else the lowest id. */
  private freeCore(th: Th): Core | undefined {
    let best: Core | undefined;
    for (const c of this.cores) {
      if (c.cur) continue;
      if (c.last === th.id) return c;
      if (!best || (best.last >= 0 && c.last < 0)) best = c;
    }
    return best;
  }

  private start(th: Th) {
    const c = this.cores[th.core]!;
    this.closeSpan(c);
    c.last = th.id;
    this.setState(th, "running");
    this.resume(th);
  }

  private leaveCore(th: Th) {
    const c = this.cores[th.core];
    if (!c) return;
    this.closeSpan(c);
    c.cur = null;
    th.core = -1;
  }

  private toRunq(th: Th) {
    this.setState(th, "runnable");
    this.runq.push(th);
  }

  /** Takes a running or spinning thread off its core and puts it at the back of the run queue. */
  private preempt(th: Th) {
    th.tok++;
    this.log(th.id, "preempt");
    this.leaveCore(th);
    this.toRunq(th);
  }

  private park(th: Th, on: string) {
    this.log(th.id, "block", on);
    this.setState(th, "blocked", on);
    this.leaveCore(th);
    this.dispatch();
  }

  /**
   * Wakes a parked thread: it is runnable `wakeNs` later. With `done`, its operation finished and `ret` is the result;
   * otherwise it runs its operation again (a barging retry, a relock after a condition wait).
   */
  private unpark(th: Th, done: boolean, ret?: unknown) {
    if (done) {
      th.op = null;
      th.ret = ret;
    }
    const tok = ++th.tok;
    this.log(th.id, "wake", th.on);
    this.after(this.cfg.wakeNs, () => {
      if (th.tok !== tok || th.state !== "blocked") return;
      this.toRunq(th);
      this.dispatch();
    });
  }

  /** Spins on the core for a lock. An adaptive wait parks after `budget` ns. */
  private spin(th: Th, on: string, budget: number) {
    this.log(th.id, "spin", on);
    this.setState(th, "spinning", on);
    this.openSpan(this.cores[th.core]!, "spin", th.id);
    const tok = ++th.tok;
    th.spinExpired = false;
    if (budget < Infinity) {
      this.after(budget, () => {
        if (th.tok !== tok || th.state !== "spinning") return;
        this.log(th.id, "park", on);
        this.setState(th, "blocked", on);
        this.leaveCore(th);
        this.dispatch();
      });
    }
    if (this.cfg.quantumNs > 0) {
      this.after(this.cfg.quantumNs, () => {
        if (th.tok !== tok || th.state !== "spinning") return;
        th.spinExpired = true;
        this.dispatch();
      });
    }
  }

  /**
   * A lock (mutex, rwlock or semaphore) became this thread's while it waited. A spinner stops spinning and runs on;
   * a parked thread wakes; a thread in the run queue finds `granted` when it runs.
   */
  private grant(th: Th) {
    th.granted = true;
    if (th.state === "spinning") {
      th.tok++;
      this.setState(th, "running");
      this.closeSpan(this.cores[th.core]!);
      this.after(0, () => this.resume(th));
    } else if (th.state === "blocked") this.unpark(th, false);
  }

  /** Pays for an acquire on the current core: lockNs, plus transferNs if the last acquire ran on another core. */
  private pay(th: Th, obj: { lastCore: number }): boolean {
    th.granted = false;
    const cost = this.cfg.lockNs + (obj.lastCore >= 0 && obj.lastCore !== th.core ? this.cfg.transferNs : 0);
    obj.lastCore = th.core;
    if (cost <= 0) return true;
    this.openSpan(this.cores[th.core]!, "run", th.id, "lock");
    this.after(cost, () => {
      th.op = null;
      this.resume(th);
    });
    return false;
  }

  /** Runs a thread on its core until it blocks, uses time, or ends. */
  private resume(th: Th) {
    if (this.over) return;
    let steps = 0;
    try {
      for (;;) {
        if (th.op) {
          if (!this.exec(th, th.op)) return;
          th.op = null;
        }
        const it = th.gen.next(th.ret);
        th.ret = undefined;
        if (this.over) return;
        if (it.done) return this.exit(th, it.value);
        th.op = it.value;
        if (++steps > MAX_STEPS_WITHOUT_TIME) throw new Error(`${th.name} took ${MAX_STEPS_WITHOUT_TIME} steps without using time`);
      }
    } catch (e) {
      this.fail(th, e);
    }
  }

  private exit(th: Th, value: unknown) {
    th.value = value;
    th.end = this.now;
    this.makespan = Math.max(this.makespan, this.now);
    this.log(th.id, "exit");
    this.setState(th, "done");
    this.leaveCore(th);
    for (const j of th.joiners.splice(0)) this.unpark(j, true, value);
    this.dispatch();
  }

  private fail(th: Th | undefined, e: unknown) {
    if (this.over) return;
    const message = e instanceof Error ? e.message : String(e);
    this.error = { message, tid: th?.id ?? -1, name: th?.name ?? "", t: this.now };
    this.log(th?.id ?? -1, "error", undefined, message);
    this.over = true;
  }

  /** The event queue is empty: everything finished, or the threads that are left can never run. */
  private finish() {
    if (this.over) return;
    this.over = true;
    const left = this.ths.filter((t) => t.state !== "done");
    if (!left.length) return;
    const spinning = left.some((t) => t.state === "spinning");
    const detail = spinning
      ? "no progress: spinning threads hold the cores and nothing can release what they wait for"
      : "fatal error: all goroutines are asleep - deadlock!";
    this.deadlock = { t: this.now, blocked: left.map((t) => ({ tid: t.id, name: t.name, on: t.on ?? t.state })), detail };
    this.log(-1, "deadlock", undefined, detail);
  }

  // ------------------------------------------------ operations

  /** Starts or continues an operation. True: it finished now and `th.ret` holds its result. False: the thread waits. */
  private exec(th: Th, op: Op): boolean {
    switch (op.k) {
      case "work":
        if (op.ns <= 0) return true;
        this.workSlice(th, op);
        return false;
      case "sleep": {
        if (op.ns <= 0) return true;
        this.setState(th, "sleeping", "sleep");
        this.leaveCore(th);
        this.dispatch();
        this.after(op.ns, () => {
          th.op = null;
          this.toRunq(th);
          this.dispatch();
        });
        return false;
      }
      case "yield":
        th.op = null;
        this.leaveCore(th);
        this.toRunq(th);
        this.dispatch();
        return false;
      case "lock":
        return this.lockOp(th, op.m);
      case "rlock":
      case "wlock":
        return this.rwOp(th, op.rw, op.k === "wlock");
      case "wait":
        return this.waitOp(th, op.cv, op.m);
      case "acquire":
        return this.acquireOp(th, op.s);
      case "send":
        return this.sendOp(th, op.ch, op.v);
      case "recv":
        return this.recvOp(th, op.ch);
      case "select":
        return this.selectOp(th, op.cases, op.dflt);
      case "join": {
        const target = this.ths[op.id];
        if (!target) throw new Panic(`join of unknown thread ${op.id}`);
        if (target.state === "done") {
          th.ret = target.value;
          this.log(th.id, "join", target.name);
          return true;
        }
        target.joiners.push(th);
        this.park(th, `join ${target.name}`);
        return false;
      }
      case "panic":
        throw new Panic(op.msg);
    }
  }

  private workSlice(th: Th, op: { ns: number; label?: string }) {
    const q = this.cfg.quantumNs > 0 ? Math.min(this.cfg.quantumNs, op.ns) : op.ns;
    this.openSpan(this.cores[th.core]!, "run", th.id, op.label);
    this.after(q, () => {
      op.ns -= q;
      if (op.ns <= 1e-9) {
        th.op = null;
        this.resume(th);
      } else if (this.runq.length) {
        this.preempt(th);
        this.dispatch();
      } else this.workSlice(th, op);
    });
  }

  // mutex

  private lockOp(th: Th, m: Mutex): boolean {
    if (th.granted) return this.pay(th, m);
    if (m.owner < 0 && (!m.opts.handoff || !m.waiters.length || m.waiters[0] === th)) {
      remove(m.waiters, th);
      this.take(m, th);
      return this.pay(th, m);
    }
    if (th.waitFrom < 0) th.waitFrom = this.now;
    if (!m.waiters.includes(th)) m.waiters.push(th);
    const on = `mutex ${m.name}`;
    if (m.opts.wait === "block") this.park(th, on);
    else this.spin(th, on, m.opts.wait === "adaptive" ? m.opts.spinNs : Infinity);
    return false;
  }

  private take(m: Mutex, th: Th) {
    m.owner = th.id;
    m.since = this.now;
    const s = m.stats;
    s.acquisitions++;
    if (th.waitFrom >= 0) {
      const w = this.now - th.waitFrom;
      s.contended++;
      s.waitNs += w;
      s.maxWaitNs = Math.max(s.maxWaitNs, w);
      th.waitFrom = -1;
    }
    if (this.cfg.record) s.owners.push([this.now, th.id]);
    this.log(th.id, "lock", `mutex ${m.name}`);
  }

  private unlockSync(th: Th, m: Mutex) {
    if (m.owner !== th.id) throw new Panic(`unlock of mutex ${m.name} by ${th.name}, which does not own it`);
    m.stats.holdNs += this.now - m.since;
    m.owner = -1;
    this.log(th.id, "unlock", `mutex ${m.name}`);
    const pick = m.opts.handoff ? m.waiters[0] : m.waiters.find((w) => w.state === "spinning");
    if (pick) {
      // Handoff: the oldest waiter. Barging: a spinner is on a core and sees the free lock first.
      remove(m.waiters, pick);
      if (m.opts.handoff) {
        m.stats.handoffs++;
        this.log(th.id, "handoff", `mutex ${m.name}`, `to ${pick.name}`);
      }
      this.take(m, pick);
      this.grant(pick);
      return;
    }
    if (this.cfg.record) m.stats.owners.push([this.now, -1]);
    // Barging: wake the oldest parked waiter. It competes again when it runs, and can lose.
    const parked = m.waiters.find((w) => w.state === "blocked");
    if (parked) {
      remove(m.waiters, parked);
      this.unpark(parked, false);
    }
  }

  private tryLockSync(th: Th, m: Mutex): boolean {
    if (m.owner >= 0 || (m.opts.handoff && m.waiters.length)) return false;
    this.take(m, th);
    m.lastCore = th.core;
    return true;
  }

  // reader-writer lock

  private rwOp(th: Th, rw: RwLock, write: boolean): boolean {
    if (th.granted) return this.pay(th, rw);
    const free = rw.writer < 0 && (write
      ? rw.readers.size === 0 && !rw.q.length
      : rw.prefer === "reader" || (rw.prefer === "writer" ? !rw.q.some((w) => w.write) : !rw.q.length));
    if (free) {
      this.takeRw(rw, th, write);
      return this.pay(th, rw);
    }
    th.waitFrom = this.now;
    rw.q.push({ th, write });
    this.park(th, `rwlock ${rw.name} (${write ? "write" : "read"})`);
    return false;
  }

  private takeRw(rw: RwLock, th: Th, write: boolean) {
    const s = rw.stats;
    const w = th.waitFrom >= 0 ? this.now - th.waitFrom : 0;
    th.waitFrom = -1;
    if (write) {
      rw.writer = th.id;
      s.writes++;
      s.writeWaitNs += w;
      s.maxWriteWaitNs = Math.max(s.maxWriteWaitNs, w);
    } else {
      rw.readers.add(th.id);
      s.reads++;
      s.readWaitNs += w;
      s.maxReadWaitNs = Math.max(s.maxReadWaitNs, w);
    }
    this.log(th.id, "lock", `rwlock ${rw.name}`, write ? "write" : "read");
  }

  private rwUnlockSync(th: Th, rw: RwLock, write: boolean) {
    if (write ? rw.writer !== th.id : !rw.readers.has(th.id)) {
      throw new Panic(`${write ? "wunlock" : "runlock"} of rwlock ${rw.name} by ${th.name}, which does not hold it`);
    }
    if (write) rw.writer = -1;
    else rw.readers.delete(th.id);
    this.log(th.id, "unlock", `rwlock ${rw.name}`, write ? "write" : "read");
    this.rwGrant(rw);
  }

  /** Hands a free rwlock to waiters, by the preference policy. */
  private rwGrant(rw: RwLock) {
    if (rw.writer >= 0 || !rw.q.length) return;
    const give = (e: { th: Th; write: boolean }) => {
      remove(rw.q, e);
      this.takeRw(rw, e.th, e.write);
      this.grant(e.th);
    };
    const readers = rw.q.filter((e) => !e.write), writer = rw.q.find((e) => e.write);
    if (rw.prefer === "reader") {
      if (readers.length) readers.forEach(give);
      else if (rw.readers.size === 0 && writer) give(writer);
    } else if (rw.prefer === "writer") {
      if (writer) {
        if (rw.readers.size === 0) give(writer);
      } else readers.forEach(give);
    } else {
      // Fair: FIFO. A writer at the head waits for the readers to leave; a run of readers at the head enters together.
      if (rw.q[0]!.write) {
        if (rw.readers.size === 0) give(rw.q[0]!);
      } else while (rw.q.length && !rw.q[0]!.write) give(rw.q[0]!);
    }
  }

  // condition variable

  private waitOp(th: Th, cv: Cond, m: Mutex): boolean {
    if (m.owner !== th.id) throw new Panic(`wait on cond ${cv.name} without holding mutex ${m.name}`);
    cv.stats.waits++;
    cv.q.push(th);
    this.log(th.id, "wait", `cond ${cv.name}`);
    this.unlockSync(th, m);
    // After the wake-up the thread locks m again.
    th.op = { k: "lock", m };
    this.park(th, `cond ${cv.name}`);
    if (cv.spuriousRate > 0 && this.rng() < cv.spuriousRate) {
      remove(cv.q, th);
      cv.stats.spurious++;
      this.log(th.id, "spurious", `cond ${cv.name}`);
      this.unpark(th, false);
    }
    return false;
  }

  private signalSync(th: Th, cv: Cond, all: boolean) {
    if (all) cv.stats.broadcasts++;
    else cv.stats.signals++;
    if (!cv.q.length) {
      if (!all) cv.stats.lostSignals++;
      this.log(th.id, all ? "broadcast" : "signal", `cond ${cv.name}`, "no waiter: lost");
      return;
    }
    const woken = all ? cv.q.splice(0) : [cv.q.shift()!];
    this.log(th.id, all ? "broadcast" : "signal", `cond ${cv.name}`, woken.map((w) => w.name).join(", "));
    for (const w of woken) {
      cv.stats.wakeups++;
      this.unpark(w, false);
    }
  }

  // semaphore

  private acquireOp(th: Th, s: Semaphore): boolean {
    if (th.granted) return this.pay(th, s);
    if (s.permits > 0 && !s.q.length) {
      s.permits--;
      this.takeSem(s, th);
      return this.pay(th, s);
    }
    th.waitFrom = this.now;
    s.q.push(th);
    this.park(th, `sem ${s.name}`);
    return false;
  }

  private takeSem(s: Semaphore, th: Th) {
    s.stats.acquires++;
    if (th.waitFrom >= 0) {
      const w = this.now - th.waitFrom;
      s.stats.contended++;
      s.stats.waitNs += w;
      s.stats.maxWaitNs = Math.max(s.stats.maxWaitNs, w);
      th.waitFrom = -1;
    }
    this.log(th.id, "acquire", `sem ${s.name}`);
  }

  private releaseSync(th: Th, s: Semaphore) {
    this.log(th.id, "release", `sem ${s.name}`);
    const w = s.q.shift();
    if (!w) {
      s.permits++;
      return;
    }
    // The permit goes straight to the oldest waiter.
    this.takeSem(s, w);
    this.grant(w);
  }

  // channels

  private logLen(ch: Channel<unknown>) {
    ch.stats.maxLen = Math.max(ch.stats.maxLen, ch.buf.length);
    if (this.cfg.record) ch.stats.lens.push([this.now, ch.buf.length]);
  }

  /** Ends a channel wait: the thread's op (or its select) finishes with `ret`. */
  private finishWait(ch: Channel<unknown>, w: ChanWaiter, send: boolean, ret: RecvResult<unknown> | undefined) {
    if (send) ch.stats.sendBlockedNs += this.now - w.since;
    else ch.stats.recvBlockedNs += this.now - w.since;
    if (w.sel) {
      w.sel.done = true;
      for (const e of w.sel.entries) remove(e.send ? e.ch.sendq : e.ch.recvq, e.w);
      this.unpark(w.th, true, { index: w.index, ...ret });
    } else this.unpark(w.th, true, ret);
  }

  /** True when a send would not block (or would panic). */
  private canSend(ch: Channel<unknown>) {
    return ch.closed || ch.recvq.length > 0 || ch.buf.length < ch.capacity;
  }

  private canRecv(ch: Channel<unknown>) {
    return ch.closed || ch.sendq.length > 0 || ch.buf.length > 0;
  }

  /** A send that can go ahead now. */
  private sendNow(th: Th, ch: Channel<unknown>, v: unknown) {
    if (ch.closed) throw new Panic(`send on closed channel ${ch.name}`);
    ch.stats.sends++;
    this.log(th.id, "send", `chan ${ch.name}`);
    const r = ch.recvq.shift();
    if (r) {
      ch.stats.recvs++;
      this.log(r.th.id, "recv", `chan ${ch.name}`, `from ${th.name}`);
      this.finishWait(ch, r, false, { ok: true, value: v });
    } else {
      ch.buf.push(v);
      this.logLen(ch);
    }
  }

  /** A receive that can go ahead now. */
  private recvNow(th: Th, ch: Channel<unknown>): RecvResult<unknown> {
    if (ch.buf.length) {
      const value = ch.buf.shift();
      const s = ch.sendq.shift();
      if (s) {
        // A blocked sender's value moves into the freed slot.
        ch.buf.push(s.v);
        ch.stats.sends++;
        this.finishWait(ch, s, true, undefined);
      }
      this.logLen(ch);
      ch.stats.recvs++;
      this.log(th.id, "recv", `chan ${ch.name}`);
      return { ok: true, value };
    }
    const s = ch.sendq.shift();
    if (s) {
      ch.stats.sends++;
      ch.stats.recvs++;
      this.log(th.id, "recv", `chan ${ch.name}`, `from ${s.th.name}`);
      this.finishWait(ch, s, true, undefined);
      return { ok: true, value: s.v };
    }
    return { ok: false, value: undefined };
  }

  private sendOp(th: Th, ch: Channel<unknown>, v: unknown): boolean {
    if (this.canSend(ch)) {
      this.sendNow(th, ch, v);
      return true;
    }
    ch.sendq.push({ th, v, since: this.now, index: 0 });
    this.park(th, `chan ${ch.name} (send)`);
    return false;
  }

  private recvOp(th: Th, ch: Channel<unknown>): boolean {
    if (this.canRecv(ch)) {
      th.ret = this.recvNow(th, ch);
      return true;
    }
    ch.recvq.push({ th, since: this.now, index: 0 });
    this.park(th, `chan ${ch.name} (recv)`);
    return false;
  }

  private selectOp(th: Th, cases: readonly SelectCase[], dflt: boolean): boolean {
    const ready: number[] = [];
    cases.forEach((c, i) => {
      if ("recv" in c ? this.canRecv(c.recv) : this.canSend(c.send)) ready.push(i);
    });
    if (ready.length) {
      const i = ready[ready.length > 1 ? Math.floor(this.rng() * ready.length) : 0]!;
      const c = cases[i]!;
      this.log(th.id, "select", undefined, `case ${i} of ${ready.length} ready`);
      if ("recv" in c) th.ret = { index: i, ...this.recvNow(th, c.recv) };
      else {
        this.sendNow(th, c.send, c.value);
        th.ret = { index: i };
      }
      return true;
    }
    if (dflt) {
      th.ret = { index: -1 };
      return true;
    }
    const sel: SelWait = { done: false, entries: [] };
    cases.forEach((c, index) => {
      const send = !("recv" in c);
      const ch = "recv" in c ? c.recv : c.send;
      const w: ChanWaiter = { th, since: this.now, sel, index, v: "recv" in c ? undefined : c.value };
      (send ? ch.sendq : ch.recvq).push(w);
      sel.entries.push({ ch, w, send });
    });
    this.park(th, `select (${cases.map((c) => ("recv" in c ? `${c.recv.name} recv` : `${c.send.name} send`)).join(", ") || "no cases"})`);
    return false;
  }

  private closeSync(th: Th, ch: Channel<unknown>) {
    if (ch.closed) throw new Panic(`close of closed channel ${ch.name}`);
    ch.closed = true;
    this.log(th.id, "close", `chan ${ch.name}`);
    // Waiting receivers get ok: false. Waiting senders panic when they run, as in Go.
    for (const r of ch.recvq.splice(0)) this.finishWait(ch, r, false, { ok: false, value: undefined });
    for (const s of ch.sendq.splice(0)) {
      if (s.sel) {
        s.sel.done = true;
        for (const e of s.sel.entries) remove(e.send ? e.ch.sendq : e.ch.recvq, e.w);
      }
      ch.stats.sendBlockedNs += this.now - s.since;
      s.th.op = { k: "panic", msg: `send on closed channel ${ch.name}` };
      this.unpark(s.th, false);
    }
  }

  // ------------------------------------------------ the thread handle

  private handle(th: Th): Thread {
    const rt = this;
    return {
      id: th.id,
      name: th.name,
      now: () => rt.now,
      rand: () => rt.rng(),
      *work(ns, label) { yield { k: "work", ns, label }; },
      *sleep(ns) { yield { k: "sleep", ns }; },
      *yieldNow() { yield { k: "yield" }; },
      *lock(m) { yield { k: "lock", m }; },
      unlock: (m) => rt.unlockSync(th, m),
      tryLock: (m) => rt.tryLockSync(th, m),
      *rlock(rw) { yield { k: "rlock", rw }; },
      runlock: (rw) => rt.rwUnlockSync(th, rw, false),
      *wlock(rw) { yield { k: "wlock", rw }; },
      wunlock: (rw) => rt.rwUnlockSync(th, rw, true),
      *wait(cv, m) { yield { k: "wait", cv, m }; },
      signal: (cv) => rt.signalSync(th, cv, false),
      broadcast: (cv) => rt.signalSync(th, cv, true),
      *acquire(s) { yield { k: "acquire", s }; },
      release: (s) => rt.releaseSync(th, s),
      *send(ch, v) { yield { k: "send", ch: ch as Channel<unknown>, v }; },
      *recv<T>(ch: Channel<T>) { return (yield { k: "recv", ch: ch as Channel<unknown> }) as RecvResult<T>; },
      trySend: (ch, v) => {
        const c = ch as Channel<unknown>;
        if (!rt.canSend(c)) return false;
        rt.sendNow(th, c, v);
        return true;
      },
      tryRecv: <T>(ch: Channel<T>) => {
        const c = ch as Channel<unknown>;
        return rt.canRecv(c) ? (rt.recvNow(th, c) as RecvResult<T>) : null;
      },
      close: (ch) => rt.closeSync(th, ch as Channel<unknown>),
      *select<C extends readonly SelectCase[]>(cases: C, opts?: { default?: boolean }) {
        return (yield { k: "select", cases, dflt: opts?.default ?? false }) as SelectResult<RecvValue<C[number]>>;
      },
      spawn: (name, fn) => rt.spawn(name, fn, th.id),
      *join<R>(id: ThreadId<R>) { return (yield { k: "join", id }) as R; },
    };
  }
}
