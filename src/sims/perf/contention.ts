/**
 * Concurrency performance models.
 *
 * False sharing runs the coherence simulator and turns its cycle counts into wall time:
 * accesses to a line shared by several cores are serialized (one owner at a time), while
 * accesses to private lines proceed in parallel.
 *
 * Lock contention is a discrete-event model: each thread alternates private work and a
 * critical section; acquiring a lock that another core just released costs a handoff
 * (cache-line transfer plus lock-specific overhead).
 */
import { Coherence } from "../coherence";
import { simulateCas } from "../../demos/CasContentionDemo";

export const GHZ = 3; // cycles per ns, for converting coherence cycles to time

/** n threads each increment their own counter `incs` times; counters packed in one line or padded apart. */
export function falseSharing(threads: number, padded: boolean, incs = 200) {
  const c = new Coherence(threads, 8, "MESI");
  const perCore = new Array<number>(threads).fill(0);
  let shared = 0;
  for (let i = 0; i < incs; i++)
    for (let t = 0; t < threads; t++) {
      const addr = padded ? t : 0;
      const before = c.c.cycles;
      c.read(t, addr);
      c.write(t, addr, i);
      const cost = c.c.cycles - before;
      if (padded) perCore[t]! += cost;
      else shared += cost;
    }
  // Packed: one line, one owner at a time, so everything is serialized. Padded: cores run in parallel.
  const cycles = padded ? Math.max(...perCore) : shared;
  const ns = cycles / GHZ;
  return { opsPerUs: (threads * incs) / (ns / 1000), transfers: c.c.c2c + c.c.invalidations, nsPerOp: ns / (threads * incs) };
}

export type LockKind = "tas" | "ttas" | "mutex" | "atomic" | "sharded" | "lockfree-queue";

export const LOCK_LABEL: Record<LockKind, string> = {
  tas: "Spinlock (test-and-set)",
  ttas: "Spinlock (test-and-test-and-set)",
  mutex: "Mutex (spin, then sleep)",
  atomic: "Atomic fetch_add (no lock)",
  sharded: "Per-thread counters, summed later",
  "lockfree-queue": "Lock-free queue (CAS loop)",
};

export interface LockConfig {
  kind: LockKind;
  threads: number;
  cores: number;
  /** Time inside the critical section, ns. */
  critical: number;
  /** Private work between acquisitions, ns. */
  work: number;
  opsPerThread: number;
  /** Probability that the lock holder is descheduled during a critical section. */
  preempt: number;
  /** How long a descheduled holder stays off-CPU, ns. */
  quantum: number;
  /** Deterministically preempt the holder of this operation number (for demos). */
  forcePreemptAt?: number;
}

export const LOCK_DEFAULTS = { cores: 8, critical: 50, work: 200, opsPerThread: 400, preempt: 0, quantum: 50_000 };

const TRANSFER = 40; // ns to move a cache line between cores

/** Extra delay before the next waiter gets the lock, given how many are waiting. */
function handoff(kind: LockKind, waiters: number): number {
  switch (kind) {
    case "tas": return TRANSFER + 25 * waiters; // every spinner's atomic swap steals the line
    case "ttas": return TRANSFER + 6 * waiters; // spinners read a shared copy; one invalidation burst per release
    default: return TRANSFER;
  }
}

export interface Span { thread: number; from: number; to: number; kind: "work" | "wait" | "hold" | "preempted" }

/** Returns throughput in operations per microsecond. Pass `trace` to collect per-thread spans. */
export function simulateLock(cfg: LockConfig, seed = 1, trace?: Span[]): number {
  const { cores } = cfg;
  const n = Math.min(cfg.threads, cores); // one thread per core: oversubscription is out of scope here
  if (cfg.kind === "sharded") {
    // No shared state: each thread runs independently; only `cores` run at a time.
    const perOp = cfg.work + cfg.critical + 2;
    const concurrency = Math.min(n, cores);
    return concurrency / perOp * 1000;
  }
  if (cfg.kind === "lockfree-queue" || cfg.kind === "atomic") {
    // One hot cache line: operations serialize on it. CAS loops also pay for failed attempts.
    const attempts = cfg.kind === "lockfree-queue" ? simulateCas(Math.min(n, cores), 100, true, seed) : 1;
    const serviceNs = n > 1 ? TRANSFER * attempts : 5;
    const perThreadNs = cfg.work + (cfg.kind === "lockfree-queue" ? cfg.critical : 0) + serviceNs;
    const concurrency = Math.min(n, cores);
    // Throughput: limited either by threads doing private work, or by the line's serialization.
    return Math.min(concurrency / perThreadNs, 1 / serviceNs) * 1000;
  }
  // Lock-based: event simulation, FIFO handoff.
  let rng = seed >>> 0;
  const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const ready = Array.from({ length: n }, (_, t) => t * 3);
  const done = new Array<number>(n).fill(0);
  let lockFree = 0, last = -1, total = 0, end = 0;
  const SLEEP_AFTER = 2_000; // ns of waiting before a mutex waiter parks in the kernel
  const WAKE = 3_000; // futex wake-up latency
  while (total < n * cfg.opsPerThread) {
    const live = Array.from({ length: n }, (_, i) => i).filter((i) => done[i]! < cfg.opsPerThread);
    const waiting = live.filter((i) => ready[i]! < lockFree);
    let t: number;
    let start: number;
    if (waiting.length === 0) {
      t = live.reduce((a, b) => (ready[b]! < ready[a]! ? b : a));
      start = ready[t]! + (last === t ? 2 : TRANSFER);
    } else if (cfg.kind === "mutex") {
      // Barging: a waiter that is still spinning (not yet asleep) takes the lock first;
      // only if every waiter is asleep do we pay a wake-up.
      const awake = waiting.filter((i) => lockFree - ready[i]! < SLEEP_AFTER);
      if (awake.length) { t = awake.reduce((a, b) => (ready[b]! < ready[a]! ? b : a)); start = lockFree + TRANSFER + 10; }
      else {
        // Everyone waiting is asleep. Waking one takes WAKE ns; a running thread that arrives
        // before then grabs the lock instead (the woken thread finds it taken and sleeps again).
        const wakeAt = lockFree + WAKE;
        const sleeper = waiting.reduce((a, b) => (ready[b]! < ready[a]! ? b : a));
        const runners = live.filter((i) => ready[i]! >= lockFree && ready[i]! < wakeAt);
        if (runners.length) {
          t = runners.reduce((a, b) => (ready[b]! < ready[a]! ? b : a));
          start = ready[t]! + TRANSFER;
          // The release still woke one sleeper; from wakeAt it competes as a running thread.
          if (trace) trace.push({ thread: sleeper, from: ready[sleeper]!, to: wakeAt, kind: "wait" });
          ready[sleeper] = wakeAt;
        } else { t = sleeper; start = wakeAt + TRANSFER; }
      }
    } else {
      t = waiting.reduce((a, b) => (ready[b]! < ready[a]! ? b : a));
      start = lockFree + handoff(cfg.kind, waiting.length - 1);
    }
    let hold = cfg.critical;
    // The holder may be descheduled mid-section; everyone waiting for the lock waits with it.
    const preempted = rand() < cfg.preempt || (cfg.forcePreemptAt !== undefined && total === cfg.forcePreemptAt);
    if (preempted) hold += cfg.quantum;
    if (trace) {
      if (start > ready[t]!) trace.push({ thread: t, from: ready[t]!, to: start, kind: "wait" });
      if (preempted) {
        trace.push({ thread: t, from: start, to: start + cfg.critical / 2, kind: "hold" });
        trace.push({ thread: t, from: start + cfg.critical / 2, to: start + cfg.critical / 2 + cfg.quantum, kind: "preempted" });
        trace.push({ thread: t, from: start + cfg.critical / 2 + cfg.quantum, to: start + hold, kind: "hold" });
      } else trace.push({ thread: t, from: start, to: start + hold, kind: "hold" });
      trace.push({ thread: t, from: start + hold, to: start + hold + cfg.work, kind: "work" });
    }
    lockFree = start + hold;
    last = t;
    done[t]!++;
    total++;
    ready[t] = lockFree + cfg.work;
    end = Math.max(end, ready[t]!);
  }
  return (total / end) * 1000;
}
