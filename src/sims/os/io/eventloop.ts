/**
 * Serving N connections: the cost of thread per connection, select, poll and epoll; level and edge triggered
 * readiness as a state machine that matches the man page; and a starvation run.
 *
 * EVENT_MODEL holds MODEL INPUTS. EVENT_FACTS holds real values.
 */
import { ALL_MITIGATIONS, SWITCH_INPUTS, STACK, syscallNs, threadMemory, threadsAtMapLimit } from "../processes";

export const EVENT_FACTS = {
  /** FD_SETSIZE in glibc: select cannot name an fd at or above this. */
  fdSetSize: 1024,
  /** Bytes of one fd_set. */
  fdSetBytes: 128,
  /** Bytes of one struct pollfd. */
  pollfdBytes: 8,
  /** epoll(7): each registered fd costs roughly this much kernel memory on a 64-bit kernel. */
  epollWatchBytes: 160,
  /** Default of vm.max_map_count, from the threads lesson. */
  maxMapCount: STACK.maxMapCount,
  /** The problem that Dan Kegel named in 1999. */
  c10k: 10_000,
} as const;

/** MODEL INPUTS, in nanoseconds or bytes. */
export const EVENT_MODEL = {
  /** A system call with mitigations on: the entry and exit cost from the system calls lesson. */
  syscallNs: syscallNs(ALL_MITIGATIONS),
  /** Socket lookup, locks and the copy in read() for a small message. */
  readWorkNs: 800,
  /** Application work per event. */
  handlerNs: 2000,
  /** One thread switch in the same address space, from the context switching lesson. */
  switchNs: SWITCH_INPUTS.directNs,
  /** select and poll: the kernel calls the file's poll method for one fd and adds a wait entry. */
  scanPerFdNs: 40,
  /** epoll: moving one item from the ready list to user space. */
  epollPerEventNs: 50,
  /** Application state per connection, in every design. */
  connStateBytes: 1024,
} as const;

export type ServerModel = "threads" | "select" | "poll" | "epoll";
export const SERVER_LABEL: Record<ServerModel, string> = { threads: "Thread per connection", select: "select", poll: "poll", epoll: "epoll" };

export interface ServerCost {
  model: ServerModel;
  /** False when the design cannot hold N connections on default limits. */
  feasible: boolean;
  /** Why it cannot. */
  limit?: string;
  /** Resident bytes that grow with N. */
  memBytes: number;
  /** CPU cores in use: the wait mechanism, the system calls and the handlers. */
  cores: number;
  /** Events per second that the design handles. */
  eventsPerSec: number;
  /** Share of `cores` that is overhead: everything except the handler. */
  overheadShare: number;
  /** Events returned by one wait call. */
  batch: number;
  /** An event loop has one thread, so it can run out of CPU. */
  saturated: boolean;
  /** CPU cost of one event at this load, in nanoseconds. */
  nsPerEvent: number;
}

/** Cost of a wait call that is independent of how many events it returns. */
export function waitCallNs(model: ServerModel, n: number): number {
  const m = EVENT_MODEL;
  if (model === "epoll") return m.syscallNs;
  if (model === "threads") return 0;
  return m.syscallNs + n * m.scanPerFdNs;
}

/**
 * N connections, each with `eventsPerConn` events per second. An event loop runs: wait, then handle each ready event.
 * With a wait cost A and an event cost E, the loop takes one event per call while it can keep up. Past that point the
 * batch grows: the loop time T solves T = A + (N r T) E. If N r E reaches 1, the loop cannot keep up at any batch size.
 */
export function serverCost(model: ServerModel, n: number, eventsPerConn: number): ServerCost {
  const m = EVENT_MODEL;
  const rate = n * eventsPerConn;
  if (model === "threads") {
    const nsPerEvent = 2 * m.switchNs + m.syscallNs + m.readWorkNs + m.handlerNs;
    const lim = threadsAtMapLimit();
    return {
      model, feasible: n <= lim, limit: n > lim ? "vm.max_map_count" : undefined,
      memBytes: threadMemory(n).residentBytes + n * m.connStateBytes,
      cores: (rate * nsPerEvent) / 1e9, eventsPerSec: rate, overheadShare: 1 - m.handlerNs / nsPerEvent, batch: 1, saturated: false, nsPerEvent,
    };
  }
  const A = waitCallNs(model, n);
  const E = m.syscallNs + m.readWorkNs + m.handlerNs + (model === "epoll" ? m.epollPerEventNs : 0);
  const perFdBytes = model === "epoll" ? EVENT_FACTS.epollWatchBytes : model === "poll" ? EVENT_FACTS.pollfdBytes : EVENT_FACTS.fdSetBytes * 3 / EVENT_FACTS.fdSetSize;
  const feasible = model !== "select" || n <= EVENT_FACTS.fdSetSize;
  const memBytes = n * (m.connStateBytes + perFdBytes);
  const base = { model, feasible, limit: feasible ? undefined : "FD_SETSIZE", memBytes };
  const rho = (rate * E) / 1e9;
  if (rho >= 1) {
    return { ...base, cores: 1, eventsPerSec: 1e9 / E, overheadShare: 1 - m.handlerNs / E, batch: Infinity, saturated: true, nsPerEvent: E };
  }
  const oneByOne = (rate * (A + E)) / 1e9;
  if (oneByOne <= 1) {
    return { ...base, cores: oneByOne, eventsPerSec: rate, overheadShare: 1 - (rate * m.handlerNs) / 1e9 / Math.max(oneByOne, 1e-12), batch: 1, saturated: false, nsPerEvent: A + E };
  }
  // The loop never sleeps: one core, and each call returns a batch.
  const T = A / (1 - rho);
  const batch = (rate * T) / 1e9;
  return { ...base, cores: 1, eventsPerSec: rate, overheadShare: 1 - (rate * m.handlerNs) / 1e9, batch, saturated: false, nsPerEvent: (A + batch * E) / batch };
}

/** The most connections that a design can hold at this event rate on one core (threads: on `cores` cores). */
export function maxConnections(model: ServerModel, eventsPerConn: number, cores = 1): number {
  const m = EVENT_MODEL;
  if (model === "threads") return Math.min(threadsAtMapLimit(), Math.floor((cores * 1e9) / ((2 * m.switchNs + m.syscallNs + m.readWorkNs + m.handlerNs) * eventsPerConn)));
  const E = m.syscallNs + m.readWorkNs + m.handlerNs + (model === "epoll" ? m.epollPerEventNs : 0);
  const byCpu = Math.floor(1e9 / (E * eventsPerConn));
  return model === "select" ? Math.min(byCpu, EVENT_FACTS.fdSetSize) : byCpu;
}

// ------------------------------------------------------------------- readiness

export type TriggerMode = "level" | "edge";

export interface WaitResult { event: boolean; bytes: number; wouldBlock: boolean }

/**
 * One socket watched by epoll. `onReadyList` is the rdllist entry. A data arrival always puts the item on the list,
 * even if the buffer already holds data: this is what epoll(7) says about several chunks. epoll_wait then checks the
 * socket. With level triggering the item goes back on the list after each report. With edge triggering it does not.
 */
export class EpollSocket {
  readonly mode: TriggerMode;
  buffered = 0;
  onReadyList = false;
  /** Bytes that the program has read. */
  consumed = 0;
  arrived = 0;
  waits = 0;
  events = 0;
  reads = 0;
  eagains = 0;

  constructor(mode: TriggerMode) { this.mode = mode; }

  /** The peer sends bytes: ep_poll_callback runs. */
  arrive(bytes: number) {
    this.buffered += bytes;
    this.arrived += bytes;
    this.onReadyList = true;
  }

  /** epoll_wait with no timeout, or a timeout that ends. wouldBlock means the call sleeps. */
  wait(): WaitResult {
    this.waits++;
    if (!this.onReadyList) return { event: false, bytes: this.buffered, wouldBlock: true };
    this.onReadyList = false;
    if (this.buffered === 0) return { event: false, bytes: 0, wouldBlock: true };
    if (this.mode === "level") this.onReadyList = true;
    this.events++;
    return { event: true, bytes: this.buffered, wouldBlock: false };
  }

  /** read() on a non-blocking socket. It returns the byte count, or -1 for EAGAIN. */
  read(max: number): number {
    this.reads++;
    if (this.buffered === 0) { this.eagains++; return -1; }
    const n = Math.min(this.buffered, max);
    this.buffered -= n;
    this.consumed += n;
    return n;
  }

  /** Data waits in the buffer, and epoll_wait would sleep. */
  get stalled() { return this.buffered > 0 && !this.onReadyList; }
}

export interface ReaderSpec { mode: TriggerMode; chunk: number; drain: boolean }
export interface ReaderOutcome { consumed: number; left: number; stalled: boolean; waits: number; reads: number; eagains: number }

/**
 * A reader loop against a list of arrivals. After each arrival, the reader runs epoll_wait until it would sleep.
 * For each event it reads one chunk, or it reads until EAGAIN if `drain` is set. The peer then sends nothing more.
 */
export function runReader(arrivals: number[], spec: ReaderSpec): ReaderOutcome {
  const s = new EpollSocket(spec.mode);
  const serve = () => {
    for (let guard = 0; guard < 1e6; guard++) {
      const w = s.wait();
      if (!w.event) return;
      if (spec.drain) { while (s.read(spec.chunk) >= 0) { /* until EAGAIN */ } }
      else s.read(spec.chunk);
    }
  };
  for (const a of arrivals) { s.arrive(a); serve(); }
  return { consumed: s.consumed, left: s.buffered, stalled: s.stalled, waits: s.waits, reads: s.reads, eagains: s.eagains };
}

export interface StarvationRun { slowWaitUs: number | null; fastBytesRead: number; slowServed: boolean; reads: number }

/** MODEL INPUTS of the starvation run. */
export const STARVE_MODEL = {
  /** One read call: a system call and the read work from EVENT_MODEL, in microseconds. */
  readUs: (EVENT_MODEL.syscallNs + EVENT_MODEL.readWorkNs) / 1000,
  /** Bytes in one packet from the peer. */
  packetBytes: 1460,
  /** Bytes in one read call. */
  chunkBytes: 4096,
  /** Bytes that wait when the run starts. */
  startBytes: 256 * 1024,
  /** Reads per socket with the budget policy. */
  budget: 16,
  spanUs: 200_000,
} as const;

/**
 * One thread and two edge-triggered sockets. The fast peer sends whole packets at a fixed rate. `drain`: read the fast
 * socket until EAGAIN before looking at any other. `budget`: read at most `budget` times, then go to the next socket.
 * The slow socket has one message at time zero. The run asks when it gets served.
 */
export function starvationRun(o: { policy: "drain" | "budget"; fastMBps: number; budget?: number; spanUs?: number }): StarvationRun {
  const m = STARVE_MODEL;
  const budget = o.budget ?? m.budget, span = o.spanUs ?? m.spanUs;
  let t = 0, buffered = m.startBytes, fastRead = 0, reads = 0, sentCredit = 0, used = 0;
  while (t < span) {
    if (buffered <= 0 || (o.policy === "budget" && used >= budget)) return { slowWaitUs: t, fastBytesRead: fastRead, slowServed: true, reads };
    const n = Math.min(buffered, m.chunkBytes);
    buffered -= n; fastRead += n; reads++; used++;
    t += m.readUs;
    // 1 MB/s is 1 byte per microsecond. Only whole packets arrive.
    sentCredit += o.fastMBps * m.readUs;
    const packets = Math.floor(sentCredit / m.packetBytes);
    buffered += packets * m.packetBytes;
    sentCredit -= packets * m.packetBytes;
  }
  return { slowWaitUs: null, fastBytesRead: fastRead, slowServed: false, reads };
}

/** At this peer speed one packet arrives per read, so a read never meets EAGAIN and the drain loop does not end. */
export const drainNeverEndsMBps = () => STARVE_MODEL.packetBytes / STARVE_MODEL.readUs;

/** The default limit on threads, from the threads lesson. */
export const threadsLimit = () => threadsAtMapLimit();

/** The five classic I/O models from Stevens, as in the lesson table. */
export const IO_MODEL_NAMES = ["blocking", "non-blocking", "I/O multiplexing", "signal-driven", "asynchronous"] as const;
