/**
 * io_uring for sockets.
 *
 * - `bufRingRun`: multishot receive with a provided buffer ring. Messages from many connections cross one link
 *   (PacketNet) to a server. For each arrival the kernel takes a buffer from the ring and posts a CQE with the buffer
 *   id and IORING_CQE_F_MORE. With no free buffer the multishot request ends with -ENOBUFS (a CQE without F_MORE),
 *   the data stays in the socket, and the program must arm the request again after it gives buffers back.
 * - `recvBufferMemory`: the buffer memory that each design pins for N connections.
 * - `requestCost`: system calls and CPU per request for an echo-style server: epoll + recv + send, io_uring with
 *   single-shot requests, multishot recv with a buffer ring, registered files, and SQPOLL.
 *
 * NET_URING_MODEL holds MODEL INPUTS; most come from the io_uring lesson of the OS track (URING_MODEL).
 */
import { PacketNet } from "../packet";
import { URING_MODEL, ALL_MITIGATIONS, NO_MITIGATIONS } from "../../os/io";
import { syscallNs } from "../../os/processes";

export const ENOBUFS = 105;

// ============================================================================ a provided buffer ring

export interface BufRingOpts {
  /** Connections with a multishot recv armed. */
  conns: number;
  /** Messages each connection sends, all at once at t = 0. */
  msgsPerConn: number;
  msgBytes: number;
  /** Buffers in the ring. */
  buffers: number;
  bufBytes: number;
  /** Time the program needs per CQE, µs (a model input). */
  procUs: number;
  /** Link rate into the server, bit/s. */
  rate: number;
}

export const BUF_DEFAULTS: BufRingOpts = { conns: 16, msgsPerConn: 2, msgBytes: 1000, buffers: 8, bufBytes: 4096, procUs: 5, rate: 10e9 };

export interface RingCqe {
  /** µs. */
  t: number;
  conn: number;
  /** Bytes, or -ENOBUFS. */
  res: number;
  /** Buffer id (IORING_CQE_F_BUFFER), when res > 0. */
  bid?: number;
  /** IORING_CQE_F_MORE: the request stays armed. */
  more: boolean;
}

export interface RingAction { t: number; text: string }

export interface BufRingRun {
  opts: BufRingOpts;
  cqes: RingCqe[];
  actions: RingAction[];
  /** [t µs, buffers in use] after each change. */
  inUse: [number, number][];
  enobufs: number;
  rearms: number;
  maxInUse: number;
  /** µs when the last message was processed. */
  doneAt: number;
  /** Longest time from arrival to the end of processing, µs. */
  maxLatency: number;
  delivered: number;
}

/**
 * A run in µs. The network part is a PacketNet in ms (one link from a "clients" node). The CPU part is one thread that
 * takes CQEs in order. Each data CQE takes procUs; then the program gives the buffer back (it joins the ring tail).
 */
export function bufRingRun(o: Partial<BufRingOpts> = {}): BufRingRun {
  const opts = { ...BUF_DEFAULTS, ...o };
  const net = new PacketNet<{ conn: number; arrived?: number }>(["clients", "server"], { record: false });
  net.connect(0, 1, { rate: opts.rate, delay: 0.005 });
  const us = () => net.now * 1000;
  const free: number[] = Array.from({ length: opts.buffers }, (_, i) => i);
  const armed = new Array<boolean>(opts.conns).fill(true);
  const pending: number[][] = Array.from({ length: opts.conns }, () => []); // arrival times of data in the socket
  const needRearm: number[] = [];
  const cqes: RingCqe[] = [], actions: RingAction[] = [], inUse: [number, number][] = [[0, 0]];
  const cq: { cqe: RingCqe; arrived: number }[] = [];
  let enobufs = 0, rearms = 0, maxInUse = 0, doneAt = 0, maxLatency = 0, delivered = 0, cpuBusy = false;
  const logUse = () => {
    const n = opts.buffers - free.length;
    maxInUse = Math.max(maxInUse, n);
    inUse.push([us(), n]);
  };
  const post = (cqe: RingCqe, arrived: number) => {
    cqes.push(cqe);
    cq.push({ cqe, arrived });
    if (!cpuBusy) net.at(net.now, runCpu);
  };
  // The kernel side: data for a connection.
  const kernelRecv = (conn: number) => {
    while (armed[conn] && pending[conn]!.length) {
      const bid = free.shift();
      if (bid === undefined) {
        armed[conn] = false;
        enobufs++;
        post({ t: us(), conn, res: -ENOBUFS, more: false }, us());
        return;
      }
      const arrived = pending[conn]!.shift()!;
      logUse();
      post({ t: us(), conn, res: opts.msgBytes, bid, more: true }, arrived);
    }
  };
  const runCpu = () => {
    const item = cq.shift();
    if (!item) {
      cpuBusy = false;
      return;
    }
    cpuBusy = true;
    const { cqe, arrived } = item;
    if (cqe.res < 0) {
      needRearm.push(cqe.conn);
      actions.push({ t: us(), text: `conn ${cqe.conn}: -ENOBUFS, no F_MORE. It must be armed again.` });
      tryRearm();
      net.at(net.now, runCpu);
      return;
    }
    net.at(net.now + opts.procUs / 1000, () => {
      delivered++;
      doneAt = us();
      maxLatency = Math.max(maxLatency, us() - arrived);
      free.push(cqe.bid!);
      logUse();
      tryRearm();
      runCpu();
    });
  };
  const tryRearm = () => {
    while (needRearm.length && free.length) {
      const conn = needRearm.shift()!;
      armed[conn] = true;
      rearms++;
      actions.push({ t: us(), text: `conn ${conn}: a new multishot recv SQE (${free.length} free)` });
      kernelRecv(conn);
    }
  };
  net.setHandlers({
    onDeliver: (_n, pkt) => {
      const c = pkt.payload.conn;
      pending[c]!.push(us());
      kernelRecv(c);
    },
  });
  for (let m = 0; m < opts.msgsPerConn; m++) for (let c = 0; c < opts.conns; c++) net.send(0, 1, opts.msgBytes + 40, { conn: c });
  net.runAll();
  return { opts, cqes, actions, inUse, enobufs, rearms, maxInUse, doneAt, maxLatency, delivered };
}

/**
 * Receive buffer memory in bytes. Readiness (epoll): the program reads into a buffer only when data is there, so one
 * buffer per thread is enough. Completion with a buffer per request: each armed recv holds one buffer. A provided
 * ring: only the ring.
 */
export function recvBufferMemory(conns: number, bufBytes: number, o: { threads?: number; ringBuffers?: number } = {}) {
  return {
    epoll: (o.threads ?? 1) * bufBytes,
    perRequest: conns * bufBytes,
    ring: (o.ringBuffers ?? 256) * bufBytes,
  };
}

// ============================================================================ cost per request

/** MODEL INPUTS, in nanoseconds. */
export const NET_URING_MODEL = {
  /** Kernel work of one small recv or send on a socket (lookup, locks, copy, the TCP send path). */
  opWorkNs: URING_MODEL.opWorkNs,
  /** epoll_wait: moving one ready item to user space. */
  epollPerEventNs: URING_MODEL.epollPerEventNs,
  /** Writing one SQE and reading its CQE. */
  ringOpNs: URING_MODEL.ringOpNs,
  /** fget and fput for one operation; registered files remove it. */
  fileRefNs: URING_MODEL.fileRefNs,
  /** A recv submitted before its data arrives: the kernel tries it, arms an internal poll, and runs it again later. */
  pollArmNs: 300,
  /** Taking a buffer from a provided ring. */
  bufSelectNs: 20,
  /** Cache traffic per operation when the SQPOLL thread runs on another core. */
  sqpollCrossCoreNs: URING_MODEL.sqpollCrossCoreNs,
} as const;

export type ReqDesign = "epoll" | "uring" | "multishot" | "fixed" | "sqpoll";
export const REQ_LABEL: Record<ReqDesign, string> = {
  epoll: "epoll + recv + send",
  uring: "io_uring, one recv and one send SQE",
  multishot: "+ multishot recv, buffer ring",
  fixed: "+ registered files",
  sqpoll: "+ SQPOLL",
};
export const REQ_DESIGNS: ReqDesign[] = ["epoll", "uring", "multishot", "fixed", "sqpoll"];

export interface ReqCost {
  design: ReqDesign;
  syscalls: number;
  /** SQEs the program writes per request. */
  sqes: number;
  /** ns per request by part. */
  parts: { syscall: number; work: number; ring: number; file: number; poll: number };
  ns: number;
  /** Requests per second on one core. */
  perCore: number;
  /** A core that spins (SQPOLL). */
  extraCores: number;
}

/** One request = one recv and one send. `batch` = requests handled per wait or submit call. */
export function requestCost(design: ReqDesign, batch: number, o: { mitigations?: boolean } = {}): ReqCost {
  const m = NET_URING_MODEL;
  const sc = syscallNs(o.mitigations === false ? NO_MITIGATIONS : ALL_MITIGATIONS);
  const work = 2 * m.opWorkNs;
  let syscalls: number, sqes: number, ring: number, file: number, poll: number;
  switch (design) {
    case "epoll":
      syscalls = 2 + 1 / batch;
      sqes = 0;
      ring = m.epollPerEventNs;
      file = 2 * m.fileRefNs;
      poll = 0;
      break;
    case "uring":
      syscalls = 1 / batch;
      sqes = 2;
      ring = 2 * m.ringOpNs;
      file = 2 * m.fileRefNs;
      poll = m.pollArmNs;
      break;
    default: {
      // Multishot: the recv stays armed, so only its CQE is read, and the kernel picks a buffer.
      syscalls = design === "sqpoll" ? 0 : 1 / batch;
      sqes = 1;
      ring = m.ringOpNs + m.ringOpNs / 2 + m.bufSelectNs + (design === "sqpoll" ? 2 * m.sqpollCrossCoreNs : 0);
      file = design === "multishot" ? 2 * m.fileRefNs : 0;
      poll = 0;
    }
  }
  const parts = { syscall: syscalls * sc, work, ring, file, poll };
  const ns = parts.syscall + parts.work + parts.ring + parts.file + parts.poll;
  return { design, syscalls, sqes, parts, ns, perCore: 1e9 / ns, extraCores: design === "sqpoll" ? 1 : 0 };
}
