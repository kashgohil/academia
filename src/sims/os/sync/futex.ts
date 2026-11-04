/**
 * Futexes: a kernel model (hash table of wait queues, FUTEX_WAIT, FUTEX_WAKE, FUTEX_CMP_REQUEUE) and
 * two mutexes built on it, as programs for the interleaving machine.
 *
 * - "two-state": 0 free, 1 held. Unlock cannot know about waiters, so it always calls FUTEX_WAKE.
 * - "three-state": mutex2 from Drepper's "Futexes Are Tricky". 0 free, 1 held, 2 held and maybe waiters.
 *
 * `check: false` removes the kernel's value check in FUTEX_WAIT. This makes the lost wakeup reachable.
 */
import { mulberry32 } from "../../rng";
import { BLOCK, delay, explore, machineModel, mutualExclusion, runParallel, type Ctx, type Ins, type Prog } from "./machine";

// ---------------------------------------------------------------- the kernel side

export interface Waiter { addr: number; thread: number }

/**
 * The futex hash table. Each bucket holds a chain of waiters, and addresses that hash to the same
 * bucket share a chain. Real kernels key by (mm, address) or by (inode, page offset) for shared
 * mappings, and take a per-bucket spinlock around each operation.
 */
export class FutexTable {
  buckets: Waiter[][];
  /** Waiter entries visited during wake and requeue scans. */
  scanned = 0;
  constructor(public size = 8, public read: (addr: number) => number = () => 0) {
    this.buckets = Array.from({ length: size }, () => []);
  }

  /** A small mixing hash. The kernel uses jhash2; only the spread matters here. */
  bucketOf(addr: number): number {
    let h = Math.imul((addr ^ (addr >>> 16)) >>> 0, 0x9e3779b1);
    h ^= h >>> 15;
    return (h >>> 0) % this.size;
  }

  /** FUTEX_WAIT: under the bucket lock, compare the word with `expected`, then sleep. */
  wait(addr: number, expected: number, thread: number): "sleeping" | "EAGAIN" {
    if (this.read(addr) !== expected) return "EAGAIN";
    this.buckets[this.bucketOf(addr)]!.push({ addr, thread });
    return "sleeping";
  }

  /** FUTEX_WAKE: wakes up to n waiters on addr, oldest first. Returns the threads woken. */
  wake(addr: number, n: number): number[] {
    const b = this.buckets[this.bucketOf(addr)]!;
    const woken: number[] = [];
    // The walk stops as soon as it has woken n waiters, as the kernel does.
    for (let i = 0; i < b.length && woken.length < n;) {
      this.scanned++;
      if (b[i]!.addr === addr) woken.push(b.splice(i, 1)[0]!.thread);
      else i++;
    }
    return woken;
  }

  /** FUTEX_CMP_REQUEUE: wakes nWake waiters on `from`, and moves up to nMove others to `to`. */
  cmpRequeue(from: number, to: number, nWake: number, nMove: number, expected: number): { woken: number[]; moved: number } | "EAGAIN" {
    if (this.read(from) !== expected) return "EAGAIN";
    const woken = this.wake(from, nWake);
    const src = this.bucketOf(from);
    const moved: Waiter[] = [];
    this.buckets[src] = this.buckets[src]!.filter((w) => {
      this.scanned++;
      if (w.addr === from && moved.length < nMove) { moved.push({ addr: to, thread: w.thread }); return false; }
      return true;
    });
    this.buckets[this.bucketOf(to)]!.push(...moved);
    return { woken, moved: moved.length };
  }

  waiters(addr: number): number[] {
    return this.buckets[this.bucketOf(addr)]!.filter((w) => w.addr === addr).map((w) => w.thread);
  }
}

// ---------------------------------------------------------------- user-space mutexes on the machine

export type MutexVariant = "two-state" | "three-state";

export interface MutexOpts {
  variant: MutexVariant;
  /** The kernel compares the word with the expected value before it sleeps. */
  check: boolean;
  threads?: number;
  rounds?: number;
  /** Ticks for load simulation. All are 0 in exhaustive checks and in steppers. */
  cs?: number;
  work?: number;
  syscall?: number;
  wakeLatency?: number;
  /** Random source for exponential work times. */
  rand?: () => number;
}

const QUEUE = "val";

function futexWait(expected: number, check: boolean, retry: string): Ins {
  return {
    text: `FUTEX_WAIT(val, ${expected})`,
    kind: "kernel",
    run(c) {
      c.count("syscalls");
      c.count("waitCalls");
      if (check && c.mem.val !== expected) {
        c.count("eagain");
        c.say(`syscall: val = ${c.mem.val}, not ${expected}, so EAGAIN. Back to user space.`);
        return retry;
      }
      c.q(QUEUE).push(c.t);
      c.say(check ? `syscall: val = ${expected}, so the thread joins the wait queue` : `syscall: no check, so the thread joins the wait queue with val = ${c.mem.val}`);
      return undefined;
    },
  };
}

const asleep: Ins = {
  text: "(asleep in the kernel)",
  kind: "sleep",
  run(c) {
    if (c.q(QUEUE).includes(c.t)) return BLOCK;
    c.say("wakes up and returns to user space");
    return undefined;
  },
};

function futexWake(): Ins {
  return {
    text: "FUTEX_WAKE(val, 1)",
    kind: "kernel",
    run(c: Ctx) {
      c.count("syscalls");
      c.count("wakeCalls");
      const q = c.q(QUEUE);
      const w = q.shift();
      if (w !== undefined) c.count("wakeups");
      else c.count("emptyWakes");
      c.say(w === undefined ? "syscall: the queue is empty, so nobody wakes" : `syscall: wakes thread ${w}`);
    },
  };
}

function mutexThread(o: MutexOpts): Ins[] {
  const rounds = o.rounds ?? 1;
  const sys = (t: string): Ins[] => delay(o.syscall ?? 0, t, "kernel", "sysLeft");
  const lat = delay(o.wakeLatency ?? 0, "(wake latency)", "sleep", "wakeLeft");
  const next: Ins = { text: "next round", kind: "user", run(c) {
    c.r.i = (c.r.i ?? 0) + 1;
    c.count("pairs");
    if (c.r.i < rounds) return "lock";
    return undefined;
  } };
  const tail: Ins[] = rounds > 1 || (o.work ?? 0) > 0 ? [...delay(o.work ?? 0, "(work outside the lock)", "user", "workLeft", o.rand), next] : [];
  if (tail[0]) tail[0] = { ...tail[0], label: "after" };
  const noteHeld = (c: Ctx) => { if ((c.r.counted ?? -1) !== (c.r.i ?? 0)) { c.count("contended"); c.r.counted = c.r.i ?? 0; } };
  const cs = (): Ins[] => (o.cs ?? 0) > 0
    ? delay(o.cs!, "critical section", "cs", "hold").map((x) => ({ ...x, label: "cs" }))
    : [{ label: "cs", text: "critical section", kind: "cs", run(c) { c.say("leaves the critical section"); } }];

  if (o.variant === "two-state") {
    return [
      { label: "lock", text: "CAS(val, 0 → 1)", sync: true, run(c) {
        if (c.mem.val === 0) { c.mem.val = 1; c.say("CAS succeeds: no syscall"); return "cs"; }
        c.say(`CAS fails: val = ${c.mem.val}`);
        noteHeld(c);
        return undefined;
      } },
      ...sys("(enter the kernel)"),
      futexWait(1, o.check, "lock"),
      asleep,
      ...lat,
      { text: "goto lock", run() { return "lock"; } },
      ...cs(),
      { text: "val = 0", sync: true, run(c) { c.mem.val = 0; c.say("val = 0. The lock is free."); } },
      futexWake(),
      ...tail,
    ];
  }
  return [
    { label: "lock", text: "c = CAS(val, 0 → 1)", sync: true, run(c) {
      const old = c.mem.val!;
      c.r.c = old;
      if (old === 0) { c.mem.val = 1; c.say("CAS succeeds: no syscall"); return "cs"; }
      c.say(`CAS fails: c = ${old}`);
      noteHeld(c);
      return undefined;
    } },
    { label: "check", text: "if c == 2 or CAS(val, 1 → 2) != 0", sync: true, run(c) {
      if (c.r.c === 2) { c.say("c = 2: waiters are marked already"); return undefined; }
      const old = c.mem.val!;
      if (old === 1) { c.mem.val = 2; c.say("val = 2: marks the lock as contended"); return undefined; }
      c.say(`val = ${old}: skips the wait`);
      return old === 0 ? "retry" : undefined;
    } },
    ...sys("(enter the kernel)"),
    futexWait(2, o.check, "retry"),
    asleep,
    ...lat,
    { label: "retry", text: "c = CAS(val, 0 → 2); if c != 0 goto check", sync: true, run(c) {
      const old = c.mem.val!;
      c.r.c = old;
      if (old === 0) { c.mem.val = 2; c.say("gets the lock with val = 2, because other waiters may exist"); return "cs"; }
      c.say(`CAS fails: c = ${old}`);
      return "check";
    } },
    ...cs(),
    { text: "old = fetch_sub(val, 1)", sync: true, run(c) {
      const old = c.mem.val!;
      c.mem.val = old - 1;
      c.say(old === 1 ? "old = 1: no waiters, no syscall" : `old = ${old}: there may be waiters`);
      return old === 1 ? (tail.length ? "after" : "end") : undefined;
    } },
    { text: "val = 0", sync: true, run(c) { c.mem.val = 0; c.say("val = 0. The lock is free."); } },
    futexWake(),
    ...tail,
  ];
}

export function futexMutexProg(o: MutexOpts): Prog {
  const n = o.threads ?? 2;
  const code = mutexThread(o);
  return { name: `futex-${o.variant}`, threads: Array.from({ length: n }, () => code), mem: { val: 0 }, queues: [QUEUE] };
}

/** The fast path of the 3-state mutex: no contention and no syscall. */
export const FUTEX_FAST_SCHEDULE = ["T0", "T0", "T0", "T1", "T1", "T1"];

/** The slow path of the 3-state mutex: T1 finds the lock held and sleeps, then T0 wakes it. */
export const FUTEX_SLOW_SCHEDULE = ["T0", "T1", "T1", "T1", "T0", "T0", "T0", "T0", "T1", "T1", "T1", "T1", "T1", "T1"];

/** Exhaustive search. A correct mutex has no violation, no stuck state and no trap. */
export function checkFutexMutex(o: MutexOpts) {
  const p = futexMutexProg(o);
  return explore(machineModel(p, { check: mutualExclusion(p) }));
}

// ---------------------------------------------------------------- syscall counts under load

export interface FutexLoad {
  pairs: number;
  syscalls: number;
  waitCalls: number;
  wakeCalls: number;
  eagain: number;
  emptyWakes: number;
  /** Syscalls per lock + unlock pair. */
  perPair: number;
  /** Share of lock attempts that found the lock held. */
  contended: number;
}

/** Model inputs, in ticks. One tick is one instruction of this machine. */
export const LOAD_DEFAULTS = { rounds: 80, cs: 12, work: 120, syscall: 3, wakeLatency: 30 };

export function futexLoad(variant: MutexVariant, threads: number, cfg: Partial<typeof LOAD_DEFAULTS> = {}, seed = 1): FutexLoad {
  const c = { ...LOAD_DEFAULTS, ...cfg };
  const rng = mulberry32(seed);
  const p = futexMutexProg({ variant, check: true, threads, ...c, rand: rng });
  const { s } = runParallel(p, rng);
  const n = (k: string) => s.n[k] ?? 0;
  const pairs = n("pairs");
  return {
    pairs,
    syscalls: n("syscalls"),
    waitCalls: n("waitCalls"),
    wakeCalls: n("wakeCalls"),
    eagain: n("eagain"),
    emptyWakes: n("emptyWakes"),
    perPair: n("syscalls") / Math.max(1, pairs),
    contended: n("contended") / Math.max(1, pairs),
  };
}

export const LOAD_THREADS = [1, 2, 3, 4, 6, 8, 12, 16];

