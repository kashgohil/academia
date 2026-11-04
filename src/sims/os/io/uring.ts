/**
 * An io_uring ring pair with the real arithmetic: head and tail are free-running u32 values, a slot is `index & mask`,
 * and the fill level is `(tail - head) mod 2^32`. So the indices stay correct across wraparound.
 *
 * URING_FACTS holds real values. URING_MODEL holds MODEL INPUTS.
 */
import { ALL_MITIGATIONS, NO_MITIGATIONS, SWITCH_INPUTS, syscallNs, type Mitigations } from "../processes";

export const URING_FACTS = {
  /** sizeof(struct io_uring_sqe). */
  sqeBytes: 64,
  /** sizeof(struct io_uring_cqe). */
  cqeBytes: 16,
  /** With IORING_SETUP_SQE128 and IORING_SETUP_CQE32. */
  sqe128Bytes: 128,
  cqe32Bytes: 32,
  /** The default CQ size is twice the SQ size. */
  cqPerSq: 2,
  /** IORING_MAX_ENTRIES. */
  maxEntries: 32768,
  /** The kernel version that first had io_uring. */
  firstKernel: "5.1",
  /** The kernel version that added the kernel.io_uring_disabled sysctl. */
  disabledSysctlKernel: "6.6",
  /** Google's kCTF report of 2023: share of kernel exploit submissions in 2022 that used io_uring. */
  kctfShare: 0.6,
  /** -ECANCELED. */
  ECANCELED: 125,
} as const;

export const u32 = (x: number) => x >>> 0;

export interface Sqe { userData: number; op: string; link?: boolean; multishot?: boolean; drain?: boolean }
export interface Cqe { userData: number; res: number; more: boolean }

export interface RingOpts {
  entries: number;
  cqEntries?: number;
  /** The first value of all four indices. A test sets this close to 2^32. */
  start?: number;
  sqpoll?: boolean;
}

/** Rounds up to a power of two, as io_uring_setup does. */
export const roundUpPow2 = (n: number) => { let p = 1; while (p < n) p *= 2; return p; };

export class IoRing {
  readonly entries: number;
  readonly cqEntries: number;
  readonly sqMask: number;
  readonly cqMask: number;
  readonly sqpoll: boolean;
  sqHead: number;
  sqTail: number;
  cqHead: number;
  cqTail: number;
  readonly sqes: (Sqe | null)[];
  readonly cqes: (Cqe | null)[];
  /** Operations that the kernel has taken and not finished. A link waits for its parent. */
  readonly inflight: { sqe: Sqe; blockedBy: number | null }[] = [];
  /** CQEs that did not fit. The kernel keeps them (IORING_FEAT_NODROP) and flushes them when the ring has room. */
  readonly overflow: Cqe[] = [];
  enterCalls = 0;
  wakeups = 0;
  pushed = 0;
  consumed = 0;
  completed = 0;
  reaped = 0;
  /** SQPOLL: the thread sleeps. The next submit must call io_uring_enter with IORING_ENTER_SQ_WAKEUP. */
  needWakeup = false;
  private lastOfChain: number | null = null;

  constructor(o: RingOpts) {
    this.entries = roundUpPow2(o.entries);
    this.cqEntries = roundUpPow2(o.cqEntries ?? this.entries * URING_FACTS.cqPerSq);
    this.sqMask = this.entries - 1;
    this.cqMask = this.cqEntries - 1;
    this.sqpoll = !!o.sqpoll;
    const s = u32(o.start ?? 0);
    this.sqHead = this.sqTail = this.cqHead = this.cqTail = s;
    this.sqes = new Array(this.entries).fill(null);
    this.cqes = new Array(this.cqEntries).fill(null);
  }

  get sqReady() { return u32(this.sqTail - this.sqHead); }
  get sqSpace() { return this.entries - this.sqReady; }
  get cqReady() { return u32(this.cqTail - this.cqHead); }
  get cqSpace() { return this.cqEntries - this.cqReady; }

  /** The application writes an SQE at tail & mask, then a store-release of the tail publishes it. */
  push(sqe: Sqe): boolean {
    if (this.sqSpace === 0) return false;
    this.sqes[this.sqTail & this.sqMask] = sqe;
    this.sqTail = u32(this.sqTail + 1);
    this.pushed++;
    return true;
  }

  /** The kernel takes up to n SQEs: a load-acquire of the tail, then reads, then a store-release of the head. */
  private consume(n: number): number {
    let c = 0;
    while (c < n && this.sqReady > 0) {
      const slot = this.sqHead & this.sqMask;
      const sqe = this.sqes[slot]!;
      this.sqes[slot] = null;
      this.sqHead = u32(this.sqHead + 1);
      this.inflight.push({ sqe, blockedBy: this.lastOfChain });
      this.lastOfChain = sqe.link ? sqe.userData : null;
      this.consumed++;
      c++;
    }
    return c;
  }

  /** io_uring_enter(fd, toSubmit, minComplete, flags). One system call. Without SQPOLL, this is how the kernel learns of new SQEs. */
  enter(toSubmit: number = this.sqReady): number {
    this.enterCalls++;
    this.flushOverflow();
    if (this.sqpoll) {
      if (this.needWakeup) { this.needWakeup = false; this.wakeups++; }
      return 0;
    }
    return this.consume(toSubmit);
  }

  /** One pass of the SQPOLL kernel thread. It costs no system call, but it uses a core while it spins. */
  sqpollTick(): number {
    if (!this.sqpoll || this.needWakeup) return 0;
    return this.consume(this.sqReady);
  }

  /** The SQPOLL thread reaches sq_thread_idle and sleeps. It sets IORING_SQ_NEED_WAKEUP in the shared flags. */
  sqpollSleep() { if (this.sqpoll) this.needWakeup = true; }

  /** True when this in-flight operation can finish now. A linked operation must wait for its parent. */
  canComplete(userData: number) {
    const f = this.inflight.find((x) => x.sqe.userData === userData);
    return !!f && f.blockedBy === null;
  }

  private write(c: Cqe) {
    if (this.cqSpace === 0) { this.overflow.push(c); return; }
    this.cqes[this.cqTail & this.cqMask] = c;
    this.cqTail = u32(this.cqTail + 1);
  }

  /** Moves stored CQEs into the ring, oldest first. */
  flushOverflow() {
    while (this.overflow.length && this.cqSpace > 0) this.write(this.overflow.shift()!);
  }

  /**
   * The kernel finishes an operation in any order. A failed link cancels the rest of its chain with -ECANCELED. A
   * multishot operation with more=true posts a CQE and stays in flight.
   */
  complete(userData: number, res = 0, opts: { more?: boolean } = {}): boolean {
    const i = this.inflight.findIndex((x) => x.sqe.userData === userData);
    if (i < 0 || this.inflight[i]!.blockedBy !== null) return false;
    const more = !!opts.more && !!this.inflight[i]!.sqe.multishot;
    this.completed++;
    this.flushOverflow();
    this.write({ userData, res, more });
    if (more) return true;
    this.inflight.splice(i, 1);
    // Release or cancel the next link in the chain.
    let parent: number | null = userData;
    let failed = res < 0;
    for (;;) {
      const child = this.inflight.find((x) => x.blockedBy === parent);
      if (!child) break;
      child.blockedBy = null;
      if (!failed) break;
      this.completed++;
      this.write({ userData: child.sqe.userData, res: -URING_FACTS.ECANCELED, more: false });
      this.inflight.splice(this.inflight.indexOf(child), 1);
      parent = child.sqe.userData;
      failed = true;
    }
    return true;
  }

  /** The application reads one CQE at head & mask, and a store-release of the head frees the slot. */
  reap(): Cqe | null {
    if (this.cqReady === 0) return null;
    const slot = this.cqHead & this.cqMask;
    const c = this.cqes[slot]!;
    this.cqes[slot] = null;
    this.cqHead = u32(this.cqHead + 1);
    this.reaped++;
    this.flushOverflow();
    return c;
  }
}

export type UringAction = { a: "push"; op?: string; link?: boolean } | { a: "enter" } | { a: "complete"; id: number; res?: number } | { a: "reap" } | { a: "poll" } | { a: "sleep" };

/** Replays learner actions, so that a demo can undo and reset with no mutable state. userData counts up from 1. */
export function replayRing(o: RingOpts, actions: UringAction[]): { ring: IoRing; nextId: number; reaped: Cqe[] } {
  const ring = new IoRing(o);
  let nextId = 1;
  const reaped: Cqe[] = [];
  for (const x of actions) {
    if (x.a === "push") { if (ring.push({ userData: nextId, op: x.op ?? "read", link: x.link })) nextId++; }
    else if (x.a === "enter") ring.enter();
    else if (x.a === "complete") ring.complete(x.id, x.res ?? 0);
    else if (x.a === "reap") { const c = ring.reap(); if (c) reaped.push(c); }
    else if (x.a === "poll") ring.sqpollTick();
    else ring.sqpollSleep();
  }
  return { ring, nextId, reaped };
}

// ------------------------------------------------------------------- cost model

/** MODEL INPUTS, in nanoseconds. */
export const URING_MODEL = {
  /** Kernel work for one small socket read: lookup, locks, copy. It is the same input as in the event-loop model. */
  opWorkNs: 800,
  /** epoll: moving one event to user space. */
  epollPerEventNs: 50,
  /** Writing one SQE and reading one CQE in shared memory. */
  ringOpNs: 40,
  /** fget and fput per operation, which fixed files remove. */
  fileRefNs: 30,
  /** Extra cache traffic per operation when another core runs the SQPOLL thread. */
  sqpollCrossCoreNs: 100,
  /** Delay until the SQPOLL thread sees a new tail. */
  sqpollSeeNs: 200,
  /** Time between operations in the batching case: 200,000 operations per second. */
  arrivalGapNs: 5000,
} as const;

export type IoPath = "read" | "epoll" | "uring" | "sqpoll";
export const IO_PATH_LABEL: Record<IoPath, string> = { read: "Blocking read", epoll: "epoll + read", uring: "io_uring", sqpoll: "io_uring, SQPOLL" };

export interface IoPathCost {
  path: IoPath;
  syscallsPerOp: number;
  /** CPU time per operation on the application side and in the kernel, excluding a spinning SQPOLL thread. */
  cpuNs: number;
  /** From the time that the application has the request to the time that it sees the result. */
  latencyNs: number;
  /** A core that spins to save the system calls. */
  extraCores: number;
}

/**
 * Cost per operation. `batch` is the number of operations per wait or submit call. Waiting for a batch to fill adds
 * latency: an operation waits on average for half of the rest of the batch. SQPOLL does not need to wait.
 */
export function ioPathCost(path: IoPath, batch: number, o: { mitigations?: Mitigations; fixedFiles?: boolean; gapNs?: number } = {}): IoPathCost {
  const m = URING_MODEL;
  const sc = syscallNs(o.mitigations ?? ALL_MITIGATIONS);
  const gap = o.gapNs ?? m.arrivalGapNs;
  const fill = ((batch - 1) / 2) * gap;
  const fileNs = o.fixedFiles ? 0 : m.fileRefNs;
  switch (path) {
    case "read": {
      // Each read sleeps until data arrives, so that it costs two switches. There is no batch.
      const cpu = sc + m.opWorkNs + m.fileRefNs + 2 * SWITCH_INPUTS.directNs;
      return { path, syscallsPerOp: 1, cpuNs: cpu, latencyNs: cpu, extraCores: 0 };
    }
    case "epoll": {
      const cpu = sc / batch + m.epollPerEventNs + sc + m.opWorkNs + m.fileRefNs;
      return { path, syscallsPerOp: 1 + 1 / batch, cpuNs: cpu, latencyNs: fill + cpu, extraCores: 0 };
    }
    case "uring": {
      const cpu = sc / batch + m.ringOpNs + m.opWorkNs + fileNs;
      return { path, syscallsPerOp: 1 / batch, cpuNs: cpu, latencyNs: fill + cpu, extraCores: 0 };
    }
    case "sqpoll": {
      const cpu = m.ringOpNs + m.sqpollCrossCoreNs + m.opWorkNs + fileNs;
      return { path, syscallsPerOp: 0, cpuNs: cpu, latencyNs: m.sqpollSeeNs + cpu, extraCores: 1 };
    }
  }
}

export { ALL_MITIGATIONS, NO_MITIGATIONS };
