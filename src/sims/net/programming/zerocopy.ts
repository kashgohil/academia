/**
 * Zero copy, counted.
 *
 * - `COPY_PATHS` and `pathCost`: how each way of sending moves the bytes (CPU copy, DMA, page reference, encryption),
 *   how many system calls it makes, and the CPU time per request and per second at line rate.
 * - `zcSendCost` and `zcCrossover`: send() that copies vs MSG_ZEROCOPY that pins pages and posts a notification.
 *   The kernel documentation says MSG_ZEROCOPY "is generally only effective at writes over around 10 KB"; the model
 *   inputs below put the crossover there, and the learner can move them.
 * - `zcHeldBytes`: with TCP, a zero-copy buffer comes back only after the peer acknowledges the data.
 * - `rxCores`: CPU cores to receive at line rate with and without offloads (checksum, GRO) and with kernel bypass.
 *
 * ZC_MODEL and RX_MODEL hold MODEL INPUTS. The packet rates come from Ethernet framing facts (foundations).
 */
import { ALL_MITIGATIONS, syscallNs } from "../../os/processes";
import { ETH_FCS, ETH_HEADER, ETH_MIN_FRAME, maxPacketRate } from "../foundations";

export const PAGE = 4096;

/** MODEL INPUTS. */
export const ZC_MODEL = {
  /** One system call, from the system calls lesson. */
  syscallNs: syscallNs(ALL_MITIGATIONS),
  /** One CPU core copying data that is not in its cache (copy_to_user, copy_from_user), GB/s. */
  copyGBps: 8,
  /** One core running AES-GCM with AES instructions, GB/s. */
  cryptoGBps: 4,
  /** Taking a reference to one page cache page (sendfile, splice). */
  pageRefNs: 20,
  /** Pinning and later unpinning one user page for MSG_ZEROCOPY, with the locked-memory accounting. */
  pinNs: 60,
  /** Per zero-copy send: the notification state (ubuf_info) and its completion. */
  zcFixedNs: 900,
  /** One recvmsg(MSG_ERRQUEUE) that reads a range of notifications. */
  notifyNs: 600,
  /** Sends per notification read (the kernel merges completions into ranges). */
  sendsPerNotify: 4,
  /** Chunk of a read/write loop. */
  chunk: 64 * 1024,
  /** Pipe size for splice (the default pipe holds 16 pages). */
  pipeBytes: 16 * PAGE,
} as const;

export type Mover = "cpu" | "dma" | "ref" | "crypto" | "nic-crypto";
export interface Move { from: Lane; to: Lane; by: Mover }
export type Lane = "page cache" | "user buffer" | "socket buffer" | "NIC";
export const LANES: Lane[] = ["page cache", "user buffer", "socket buffer", "NIC"];

export type PathId = "readwrite" | "mmap" | "sendfile" | "sendfileSg" | "splice" | "userTls" | "ktls" | "ktlsHw" | "send" | "zerocopy" | "sendZc";
export interface CopyPath {
  id: PathId;
  label: string;
  /** "file": serve a file in the page cache. "memory": send bytes that the program made. */
  source: "file" | "memory";
  moves: Move[];
  /** System calls for a request of `bytes`. */
  calls: (bytes: number) => number;
  /** Pages pinned (zerocopy) or referenced (sendfile, splice). */
  pageOp: "none" | "ref" | "pin";
  /** Notifications to read per send. */
  notify: "none" | "errqueue" | "cqe";
  note: string;
}

const chunks = (b: number, c: number) => Math.max(1, Math.ceil(b / c));

export const COPY_PATHS: CopyPath[] = [
  {
    id: "readwrite", label: "read + write", source: "file", pageOp: "none", notify: "none",
    moves: [{ from: "page cache", to: "user buffer", by: "cpu" }, { from: "user buffer", to: "socket buffer", by: "cpu" }, { from: "socket buffer", to: "NIC", by: "dma" }],
    calls: (b) => 2 * chunks(b, ZC_MODEL.chunk),
    note: "Each byte crosses the CPU twice: into your buffer, and back into the kernel.",
  },
  {
    id: "mmap", label: "mmap + write", source: "file", pageOp: "none", notify: "none",
    moves: [{ from: "page cache", to: "socket buffer", by: "cpu" }, { from: "socket buffer", to: "NIC", by: "dma" }],
    calls: (b) => 2 + chunks(b, ZC_MODEL.chunk),
    note: "The file is mapped, so the read copy goes. write still copies, and a file that another process truncates gives SIGBUS.",
  },
  {
    id: "sendfile", label: "sendfile, NIC without gather", source: "file", pageOp: "none", notify: "none",
    moves: [{ from: "page cache", to: "socket buffer", by: "cpu" }, { from: "socket buffer", to: "NIC", by: "dma" }],
    calls: () => 1,
    note: "One call, no user buffer. The NIC cannot gather pages, so the kernel copies into the socket buffer.",
  },
  {
    id: "sendfileSg", label: "sendfile, gather + checksum offload", source: "file", pageOp: "ref", notify: "none",
    moves: [{ from: "page cache", to: "socket buffer", by: "ref" }, { from: "page cache", to: "NIC", by: "dma" }],
    calls: () => 1,
    note: "The socket buffer holds page references. The NIC reads the page cache by DMA and computes the checksum.",
  },
  {
    id: "splice", label: "splice: file → pipe → socket", source: "file", pageOp: "ref", notify: "none",
    moves: [{ from: "page cache", to: "socket buffer", by: "ref" }, { from: "page cache", to: "NIC", by: "dma" }],
    calls: (b) => 2 * chunks(b, ZC_MODEL.pipeBytes),
    note: "Pages move by reference through a pipe. Two calls per pipe-full. Proxies use it socket to socket.",
  },
  {
    id: "userTls", label: "read + TLS library + write", source: "file", pageOp: "none", notify: "none",
    moves: [{ from: "page cache", to: "user buffer", by: "cpu" }, { from: "user buffer", to: "user buffer", by: "crypto" }, { from: "user buffer", to: "socket buffer", by: "cpu" }, { from: "socket buffer", to: "NIC", by: "dma" }],
    calls: (b) => 2 * chunks(b, ZC_MODEL.chunk),
    note: "HTTPS the usual way: two copies and one encryption pass, all on the CPU.",
  },
  {
    id: "ktls", label: "kTLS + sendfile (software)", source: "file", pageOp: "ref", notify: "none",
    moves: [{ from: "page cache", to: "socket buffer", by: "crypto" }, { from: "socket buffer", to: "NIC", by: "dma" }],
    calls: () => 1,
    note: "The kernel encrypts from the page cache into new buffers. The encryption pass is the only copy.",
  },
  {
    id: "ktlsHw", label: "kTLS + sendfile, NIC encrypts", source: "file", pageOp: "ref", notify: "none",
    moves: [{ from: "page cache", to: "socket buffer", by: "ref" }, { from: "page cache", to: "NIC", by: "nic-crypto" }],
    calls: () => 1,
    note: "TLS_HW: the NIC encrypts as it sends. No CPU touches the payload.",
  },
  {
    id: "send", label: "send from memory", source: "memory", pageOp: "none", notify: "none",
    moves: [{ from: "user buffer", to: "socket buffer", by: "cpu" }, { from: "socket buffer", to: "NIC", by: "dma" }],
    calls: (b) => chunks(b, ZC_MODEL.chunk),
    note: "One copy into the kernel. You may reuse your buffer as soon as the call returns.",
  },
  {
    id: "zerocopy", label: "send with MSG_ZEROCOPY", source: "memory", pageOp: "pin", notify: "errqueue",
    moves: [{ from: "user buffer", to: "socket buffer", by: "ref" }, { from: "user buffer", to: "NIC", by: "dma" }],
    calls: (b) => chunks(b, ZC_MODEL.chunk) * (1 + 1 / ZC_MODEL.sendsPerNotify),
    note: "Pages are pinned and the NIC reads them. Do not touch the buffer until the error queue says it is free.",
  },
  {
    id: "sendZc", label: "io_uring SEND_ZC", source: "memory", pageOp: "pin", notify: "cqe",
    moves: [{ from: "user buffer", to: "socket buffer", by: "ref" }, { from: "user buffer", to: "NIC", by: "dma" }],
    calls: (b) => chunks(b, ZC_MODEL.chunk) / 8,
    note: "The same pinning. The notification is a second CQE (IORING_CQE_F_NOTIF), so no extra system call. Batches of 8 here.",
  },
];

export const pathById = (id: PathId) => COPY_PATHS.find((p) => p.id === id)!;

export interface PathCost {
  path: CopyPath;
  cpuCopies: number;
  dmas: number;
  cryptoPasses: number;
  calls: number;
  /** User-kernel crossings: two per system call. */
  crossings: number;
  /** CPU ns per request by part. */
  parts: { copy: number; crypto: number; calls: number; pages: number; notify: number };
  ns: number;
  /** Cores needed to send `lineGbps` of such requests. */
  coresAt: (lineGbps: number) => number;
}

export function pathCost(id: PathId, bytes: number, m: { copyGBps?: number; cryptoGBps?: number } = {}): PathCost {
  const p = pathById(id);
  const copyGBps = m.copyGBps ?? ZC_MODEL.copyGBps, cryptoGBps = m.cryptoGBps ?? ZC_MODEL.cryptoGBps;
  const cpuCopies = p.moves.filter((x) => x.by === "cpu").length;
  const cryptoPasses = p.moves.filter((x) => x.by === "crypto").length;
  const dmas = p.moves.filter((x) => x.by === "dma" || x.by === "nic-crypto").length;
  const calls = p.calls(bytes);
  const pages = Math.ceil(bytes / PAGE);
  const parts = {
    copy: (cpuCopies * bytes) / copyGBps,
    crypto: (cryptoPasses * bytes) / cryptoGBps,
    calls: calls * ZC_MODEL.syscallNs,
    pages: p.pageOp === "ref" ? pages * ZC_MODEL.pageRefNs : p.pageOp === "pin" ? pages * ZC_MODEL.pinNs + chunks(bytes, ZC_MODEL.chunk) * ZC_MODEL.zcFixedNs : 0,
    notify: p.notify === "errqueue" ? (chunks(bytes, ZC_MODEL.chunk) / ZC_MODEL.sendsPerNotify) * (ZC_MODEL.notifyNs - ZC_MODEL.syscallNs) : 0,
  };
  const ns = parts.copy + parts.crypto + parts.calls + parts.pages + parts.notify;
  return { path: p, cpuCopies, dmas, cryptoPasses, calls, crossings: 2 * calls, parts, ns, coresAt: (g) => ((g * 1e9) / 8 / bytes) * ns * 1e-9 };
}

// ============================================================================ MSG_ZEROCOPY: when does it pay?

export interface ZcInputs { copyGBps: number; pinNs: number; zcFixedNs: number; notifyNs: number; sendsPerNotify: number }
export const ZC_DEFAULT_INPUTS: ZcInputs = { copyGBps: ZC_MODEL.copyGBps, pinNs: ZC_MODEL.pinNs, zcFixedNs: ZC_MODEL.zcFixedNs, notifyNs: ZC_MODEL.notifyNs, sendsPerNotify: ZC_MODEL.sendsPerNotify };

/** CPU ns for one send() of `bytes`, with a copy or with MSG_ZEROCOPY. The system call itself is the same in both. */
export function zcSendCost(bytes: number, i: ZcInputs = ZC_DEFAULT_INPUTS) {
  const copy = ZC_MODEL.syscallNs + bytes / i.copyGBps;
  const zc = ZC_MODEL.syscallNs + i.zcFixedNs + Math.ceil(bytes / PAGE) * i.pinNs + i.notifyNs / i.sendsPerNotify;
  return { copy, zc };
}

/** The smallest send size (in bytes, a multiple of 256) where MSG_ZEROCOPY costs less than a copy. */
export function zcCrossover(i: ZcInputs = ZC_DEFAULT_INPUTS, max = 4 * 1024 * 1024): number | null {
  for (let b = 256; b <= max; b += 256) {
    const c = zcSendCost(b, i);
    if (c.zc < c.copy) return b;
  }
  return null;
}

/** Bytes of user buffers that wait for notifications: TCP frees a zero-copy page only when the peer acknowledges it. */
export const zcHeldBytes = (rateGbps: number, rttMs: number) => ((rateGbps * 1e9) / 8) * (rttMs / 1000);

// ============================================================================ receive at line rate

/** MODEL INPUTS, in nanoseconds or GB/s. */
export const RX_MODEL = {
  /** Driver work per wire packet: descriptor, DMA unmap, buffer refill, skb setup. */
  driverNs: 100,
  /** One pass of a packet (or a GRO super-packet) through IP, TCP and the socket queue. */
  stackNs: 1000,
  /** Checksum computed by the CPU, GB/s. */
  csumGBps: 10,
  /** Copy to the application (recv), GB/s. */
  copyGBps: ZC_MODEL.copyGBps,
  /** Kernel bypass (DPDK, AF_XDP zero-copy): per packet, poll-mode driver and a minimal handler. No TCP stack. */
  bypassNs: 60,
  /** Largest GRO super-packet. */
  groBytes: 65536,
} as const;

export type RxDesign = "plain" | "csum" | "gro" | "bypass";
export const RX_LABEL: Record<RxDesign, string> = { plain: "Kernel, no offloads", csum: "+ checksum offload", gro: "+ GRO", bypass: "Kernel bypass" };
export const RX_DESIGNS: RxDesign[] = ["plain", "csum", "gro", "bypass"];

export interface RxCost { design: RxDesign; pps: number; budgetNs: number; stackPasses: number; cores: number; parts: { driver: number; stack: number; csum: number; copy: number } }

/**
 * Cores to receive `rateGbps` of TCP payload in `frameBytes` frames. "bulk": one long flow, GRO merges up to 64 KiB.
 * "small": request-sized messages, each packet its own message, so GRO merges nothing. Bypass needs a busy core even when idle.
 */
export function rxCores(design: RxDesign, rateGbps: number, frameBytes: number, traffic: "bulk" | "small"): RxCost {
  const m = RX_MODEL;
  const pps = maxPacketRate(rateGbps * 1e9, frameBytes);
  const payload = Math.max(0, frameBytes - ETH_HEADER - ETH_FCS - 40);
  const bytesPerSec = pps * payload;
  const perGro = traffic === "bulk" ? Math.max(1, Math.floor(m.groBytes / Math.max(1, payload))) : 1;
  const stackPasses = design === "gro" ? pps / perGro : design === "bypass" ? 0 : pps;
  const parts = {
    driver: design === "bypass" ? pps * m.bypassNs * 1e-9 : pps * m.driverNs * 1e-9,
    stack: stackPasses * m.stackNs * 1e-9,
    csum: design === "plain" ? bytesPerSec / (m.csumGBps * 1e9) : 0,
    copy: design === "bypass" ? 0 : bytesPerSec / (m.copyGBps * 1e9),
  };
  const sum = parts.driver + parts.stack + parts.csum + parts.copy;
  return { design, pps, budgetNs: 1e9 / pps, stackPasses, cores: design === "bypass" ? Math.max(1, sum) : sum, parts };
}

export const MIN_FRAME = ETH_MIN_FRAME;
