/**
 * A Linux pipe, following fs/pipe.c: a ring of page-sized slots with head and tail counters, where one
 * mutex protects each read and write, and a task drops the mutex only when it must sleep.
 *
 * The rules that this file reproduces:
 * - pipe_write first tries to merge `total & (PAGE_SIZE - 1)` bytes into the last slot. It merges only if all of
 *   those bytes fit. The rest goes into new slots, one page per slot.
 * - A full ring makes a writer sleep with the mutex dropped. This is the only point where another writer can get in.
 *   So a write that needs at most one page can never be split, and a larger write can.
 * - pipe_read copies from the tail. It returns what it has as soon as the ring is empty. It returns 0 (EOF) only
 *   when the ring is empty and no write end stays open.
 *
 * Bytes carry their source, so a test or a view can check order and find splits.
 */
import { explore, type Explored, type Model, type Step } from "../sync/machine";
import { MMAP_COSTS } from "../memory/mmap";
import { SWITCH_INPUTS } from "../processes/ctx";

export const PIPE_FACTS = {
  /** x86-64 page size. Linux on arm64 can also use 16 KiB or 64 KiB pages. */
  pageSize: 4096,
  /** PIPE_DEF_BUFFERS: slots in a new pipe. */
  defBuffers: 16,
  defaultCapacity: 16 * 4096,
  /** PIPE_BUF on Linux: the atomic write limit. It does not change with the page size. */
  pipeBuf: 4096,
  /** The POSIX minimum for PIPE_BUF, and the value on macOS. */
  posixPipeBuf: 512,
  macosPipeBuf: 512,
  /** /proc/sys/fs/pipe-max-size: the limit for F_SETPIPE_SZ without CAP_SYS_RESOURCE. */
  pipeMaxSize: 1 << 20,
  /** /proc/sys/fs/pipe-user-pages-soft, in pages. */
  userPagesSoft: 16384,
  /** Default-size pipes that a user can make before the soft limit. */
  pipesAtSoftLimit: 16384 / 16,
  /** PIPE_MIN_DEF_BUFFERS: slots in a new pipe after the user passes the soft limit. */
  slotsOverSoftLimit: 2,
  /** A default pipe on a kernel with 16 KiB pages. */
  capacityOn16kPages: 16 * 16384,
} as const;

export interface Run {
  /** The writer's name. */
  src: string;
  /** The index of this write among all writes of `src`. */
  write: number;
  /** Offset of the first byte of this run in that write. */
  at: number;
  len: number;
}

export interface PipeBuf {
  offset: number;
  len: number;
  /** PIPE_BUF_FLAG_CAN_MERGE. Pages from splice do not have it. */
  canMerge: boolean;
  /** The slot holds a borrowed page (from splice or vmsplice), not a page that the pipe owns. */
  spliced: boolean;
  runs: Run[];
}

export interface WriteResult {
  status: "ok" | "blocked" | "EAGAIN" | "EPIPE";
  /** Bytes of this write that are in the pipe so far. */
  written: number;
  total: number;
  /** The kernel sent SIGPIPE to the writer. */
  sigpipe: boolean;
}

export interface ReadResult {
  status: "ok" | "blocked" | "EAGAIN" | "EOF";
  n: number;
  runs: Run[];
}

export interface PipeStats {
  writes: number;
  reads: number;
  /** Times that a writer or a reader went to sleep. */
  writerSleeps: number;
  readerSleeps: number;
  slotsUsed: number;
  merges: number;
  bytesIn: number;
  bytesOut: number;
  bytesCopied: number;
}

interface WriteReq { src: string; id: number; total: number; done: number; nonblock: boolean }
interface ReadReq { want: number; got: number; runs: Run[]; nonblock: boolean }

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

export function roundPipeSize(bytes: number, pageSize: number = PIPE_FACTS.pageSize): { slots: number; bytes: number } {
  let slots = 1;
  while (slots * pageSize < bytes) slots *= 2;
  return { slots, bytes: slots * pageSize };
}

export class Pipe {
  readonly pageSize: number;
  ringSize: number;
  head = 0;
  tail = 0;
  bufs: (PipeBuf | null)[];
  writers = 1;
  readers = 1;
  private writesBy: Record<string, number> = {};
  private blockedW: Record<string, WriteReq> = {};
  private blockedR: Record<string, ReadReq> = {};
  stats: PipeStats = { writes: 0, reads: 0, writerSleeps: 0, readerSleeps: 0, slotsUsed: 0, merges: 0, bytesIn: 0, bytesOut: 0, bytesCopied: 0 };

  constructor(opts: { slots?: number; pageSize?: number } = {}) {
    this.ringSize = opts.slots ?? PIPE_FACTS.defBuffers;
    this.pageSize = opts.pageSize ?? PIPE_FACTS.pageSize;
    if (!isPow2(this.ringSize)) throw new Error("ring size must be a power of two");
    this.bufs = new Array<PipeBuf | null>(this.ringSize).fill(null);
  }

  get capacity() { return this.ringSize * this.pageSize; }
  get used() { return this.head - this.tail; }
  get empty() { return this.head === this.tail; }
  get full() { return this.used >= this.ringSize; }
  get buffered() { let n = 0; for (let i = this.tail; i !== this.head; i++) n += this.slot(i).len; return n; }
  /** Slots from tail to head, oldest first, with their position in the ring. */
  get slots(): { index: number; buf: PipeBuf }[] {
    const out: { index: number; buf: PipeBuf }[] = [];
    for (let i = this.tail; i !== this.head; i++) out.push({ index: i & (this.ringSize - 1), buf: this.slot(i) });
    return out;
  }
  private slot(i: number) { return this.bufs[i & (this.ringSize - 1)]!; }

  writeBlocked(src: string) { return src in this.blockedW; }
  readBlocked(who: string) { return who in this.blockedR; }
  canResumeWrite(src: string) { return src in this.blockedW && (!this.full || this.readers === 0); }
  canResumeRead(who: string) { return who in this.blockedR && (!this.empty || this.writers === 0); }
  pendingWrite(src: string) { const r = this.blockedW[src]; return r ? { written: r.done, total: r.total } : null; }

  /** write(2). A sleeping writer must call resumeWrite once canResumeWrite is true. */
  write(src: string, total: number, opts: { nonblock?: boolean } = {}): WriteResult {
    if (src in this.blockedW) throw new Error(`${src} already sleeps in write`);
    this.stats.writes++;
    const id = this.writesBy[src] ?? 0;
    this.writesBy[src] = id + 1;
    const req: WriteReq = { src, id, total, done: 0, nonblock: !!opts.nonblock };
    if (total === 0) return { status: "ok", written: 0, total, sigpipe: false };
    if (this.readers === 0) return { status: "EPIPE", written: 0, total, sigpipe: true };
    // Merge only the part below one page, and only if all of it fits in the last slot.
    const chars = total & (this.pageSize - 1);
    if (chars !== 0 && !this.empty) {
      const last = this.slot(this.head - 1);
      if (last.canMerge && last.offset + last.len + chars <= this.pageSize) {
        this.copyInto(last, req, chars);
        this.stats.merges++;
        if (req.done === total) return { status: "ok", written: total, total, sigpipe: false };
      }
    }
    return this.runWrite(req);
  }

  resumeWrite(src: string): WriteResult {
    const req = this.blockedW[src];
    if (!req) throw new Error(`${src} does not sleep in write`);
    delete this.blockedW[src];
    return this.runWrite(req);
  }

  private copyInto(buf: PipeBuf, req: WriteReq, n: number) {
    const lastRun = buf.runs[buf.runs.length - 1];
    if (lastRun && lastRun.src === req.src && lastRun.write === req.id && lastRun.at + lastRun.len === req.done) lastRun.len += n;
    else buf.runs.push({ src: req.src, write: req.id, at: req.done, len: n });
    buf.len += n;
    req.done += n;
    this.stats.bytesIn += n;
    this.stats.bytesCopied += n;
  }

  private runWrite(req: WriteReq): WriteResult {
    for (;;) {
      if (this.readers === 0) return req.done ? { status: "ok", written: req.done, total: req.total, sigpipe: true } : { status: "EPIPE", written: 0, total: req.total, sigpipe: true };
      if (!this.full) {
        const buf: PipeBuf = { offset: 0, len: 0, canMerge: true, spliced: false, runs: [] };
        this.bufs[this.head & (this.ringSize - 1)] = buf;
        this.head++;
        this.stats.slotsUsed++;
        this.copyInto(buf, req, Math.min(this.pageSize, req.total - req.done));
        if (req.done === req.total) return { status: "ok", written: req.total, total: req.total, sigpipe: false };
        continue;
      }
      if (req.nonblock) return req.done ? { status: "ok", written: req.done, total: req.total, sigpipe: false } : { status: "EAGAIN", written: 0, total: req.total, sigpipe: false };
      this.blockedW[req.src] = req;
      this.stats.writerSleeps++;
      return { status: "blocked", written: req.done, total: req.total, sigpipe: false };
    }
  }

  /** read(2). A sleeping reader must call resumeRead once canResumeRead is true. */
  read(who: string, want: number, opts: { nonblock?: boolean } = {}): ReadResult {
    if (who in this.blockedR) throw new Error(`${who} already sleeps in read`);
    this.stats.reads++;
    if (want === 0) return { status: "ok", n: 0, runs: [] };
    return this.runRead(who, { want, got: 0, runs: [], nonblock: !!opts.nonblock });
  }

  resumeRead(who: string): ReadResult {
    const req = this.blockedR[who];
    if (!req) throw new Error(`${who} does not sleep in read`);
    delete this.blockedR[who];
    return this.runRead(who, req);
  }

  private runRead(who: string, req: ReadReq): ReadResult {
    while (req.got < req.want && !this.empty) {
      const buf = this.slot(this.tail);
      const n = Math.min(buf.len, req.want - req.got);
      takeRuns(buf, n, req.runs);
      buf.offset += n;
      buf.len -= n;
      req.got += n;
      this.stats.bytesOut += n;
      if (!buf.spliced) this.stats.bytesCopied += n;
      if (buf.len === 0) {
        this.bufs[this.tail & (this.ringSize - 1)] = null;
        this.tail++;
      }
    }
    if (req.got > 0) return { status: "ok", n: req.got, runs: req.runs };
    if (this.writers === 0) return { status: "EOF", n: 0, runs: [] };
    if (req.nonblock) return { status: "EAGAIN", n: 0, runs: [] };
    this.blockedR[who] = req;
    this.stats.readerSleeps++;
    return { status: "blocked", n: 0, runs: [] };
  }

  closeWrite() { if (this.writers > 0) this.writers--; }
  closeRead() { if (this.readers > 0) this.readers--; }
  /** fork or dup of an end. */
  dupWrite() { this.writers++; }
  dupRead() { this.readers++; }

  /** fcntl(F_SETPIPE_SZ). Rounds up to a power of two of pages. Returns the new capacity, or an errno name. */
  setSize(bytes: number, opts: { privileged?: boolean; maxSize?: number } = {}): number | "EPERM" | "EBUSY" | "EINVAL" {
    if (bytes <= 0) return "EINVAL";
    const { slots, bytes: rounded } = roundPipeSize(bytes, this.pageSize);
    if (rounded > (opts.maxSize ?? PIPE_FACTS.pipeMaxSize) && !opts.privileged) return "EPERM";
    if (this.used > slots) return "EBUSY";
    const live = this.slots.map((s) => s.buf);
    this.ringSize = slots;
    this.bufs = new Array<PipeBuf | null>(slots).fill(null);
    this.tail = 0;
    this.head = live.length;
    live.forEach((b, i) => { this.bufs[i] = b; });
    return rounded;
  }

  /** splice(2) from a file: the slot points at a page cache page, with no copy and no merge flag. */
  spliceIn(src: string, bytes: number): number {
    let moved = 0;
    const id = this.writesBy[src] ?? 0;
    this.writesBy[src] = id + 1;
    while (moved < bytes && !this.full) {
      const n = Math.min(this.pageSize, bytes - moved);
      this.bufs[this.head & (this.ringSize - 1)] = { offset: 0, len: n, canMerge: false, spliced: true, runs: [{ src, write: id, at: moved, len: n }] };
      this.head++;
      this.stats.bytesIn += n;
      moved += n;
    }
    return moved;
  }

  clone(): Pipe {
    const p = new Pipe({ slots: this.ringSize, pageSize: this.pageSize });
    p.head = this.head;
    p.tail = this.tail;
    p.bufs = this.bufs.map((b) => (b ? { ...b, runs: b.runs.map((r) => ({ ...r })) } : null));
    p.writers = this.writers;
    p.readers = this.readers;
    p.writesBy = { ...this.writesBy };
    p.blockedW = Object.fromEntries(Object.entries(this.blockedW).map(([k, v]) => [k, { ...v }]));
    p.blockedR = Object.fromEntries(Object.entries(this.blockedR).map(([k, v]) => [k, { ...v, runs: v.runs.map((r) => ({ ...r })) }]));
    p.stats = { ...this.stats };
    return p;
  }

  /** The identity of this state, without the statistics. */
  key(): string {
    return JSON.stringify([this.head, this.tail, this.slots.map((s) => [s.buf.offset, s.buf.len, s.buf.runs]), this.writers, this.readers, this.blockedW, this.blockedR]);
  }
}

function takeRuns(buf: PipeBuf, n: number, out: Run[]) {
  let left = n;
  while (left > 0) {
    const r = buf.runs[0]!;
    const k = Math.min(r.len, left);
    pushRun(out, { src: r.src, write: r.write, at: r.at, len: k });
    r.at += k;
    r.len -= k;
    left -= k;
    if (r.len === 0) buf.runs.shift();
  }
}

/** Appends a run and joins it with the last run if they are contiguous. */
export function pushRun(out: Run[], r: Run) {
  const last = out[out.length - 1];
  if (last && last.src === r.src && last.write === r.write && last.at + last.len === r.at) last.len += r.len;
  else out.push({ ...r });
}

/** A write that appears in the stream as two or more pieces, with other bytes between them. Limit by its size if `sizes` is given. */
export function findSplit(stream: readonly Run[], maxSize = Infinity, sizes?: (src: string, write: number) => number): { src: string; write: number } | null {
  const seen = new Set<string>();
  let prev = "";
  for (const r of stream) {
    const k = `${r.src}#${r.write}`;
    if (k !== prev) {
      if (seen.has(k) && (!sizes || sizes(r.src, r.write) <= maxSize)) return { src: r.src, write: r.write };
      seen.add(k);
      prev = k;
    }
  }
  return null;
}

/** Checks that each source appears in order with no byte lost or doubled. */
export function checkStream(stream: readonly Run[], sizes: Record<string, readonly number[]>): string | null {
  const pos: Record<string, { w: number; at: number }> = {};
  for (const r of stream) {
    const p = (pos[r.src] ??= { w: 0, at: 0 });
    while (p.w < (sizes[r.src]?.length ?? 0) && sizes[r.src]![p.w] === p.at) { p.w++; p.at = 0; }
    if (r.write !== p.w || r.at !== p.at) return `${r.src}: expected write ${p.w} at ${p.at}, got write ${r.write} at ${r.at}`;
    p.at += r.len;
  }
  for (const [src, list] of Object.entries(sizes)) {
    const p = pos[src] ?? { w: 0, at: 0 };
    while (p.w < list.length && list[p.w] === p.at) { p.w++; p.at = 0; }
    if (p.w !== list.length) return `${src}: lost bytes: stopped at write ${p.w}, offset ${p.at}`;
  }
  return null;
}

// ---------------------------------------------------------------- all schedules of writers and a reader

export interface InterleaveSpec {
  slots: number;
  /** Write sizes, by writer name. */
  writers: Record<string, readonly number[]>;
  readSize: number;
  pageSize?: number;
  /** Report a split only for writes of at most this size. */
  splitLimit?: number;
}

export interface InterleaveState {
  pipe: Pipe;
  next: Record<string, number>;
  stream: Run[];
  eof: boolean;
  last: string;
}

export const READER = "reader";

/** A generic Model for the sync explorer. One step is one syscall, or the rest of one after a sleep. */
export function pipeInterleaveModel(spec: InterleaveSpec): Model<InterleaveState> {
  const names = Object.keys(spec.writers);
  const init: InterleaveState = {
    pipe: (() => { const p = new Pipe({ slots: spec.slots, pageSize: spec.pageSize }); p.writers = names.length; return p; })(),
    next: Object.fromEntries(names.map((n) => [n, 0])),
    stream: [],
    eof: false,
    last: "",
  };
  const cloneS = (s: InterleaveState): InterleaveState => ({ pipe: s.pipe.clone(), next: { ...s.next }, stream: s.stream.map((r) => ({ ...r })), eof: s.eof, last: s.last });
  const size = (src: string, write: number) => spec.writers[src]?.[write] ?? 0;
  return {
    init,
    key: (s) => JSON.stringify([s.pipe.key(), s.next, s.stream, s.eof]),
    steps(s) {
      const out: Step<InterleaveState>[] = [];
      names.forEach((n, actor) => {
        const list = spec.writers[n]!;
        const blocked = s.pipe.writeBlocked(n);
        if (blocked ? !s.pipe.canResumeWrite(n) : s.next[n]! >= list.length) return;
        const st = cloneS(s);
        const r = blocked ? st.pipe.resumeWrite(n) : st.pipe.write(n, list[st.next[n]!]!);
        if (!blocked) st.next[n]!++;
        const finished = r.status !== "blocked" && st.next[n]! >= list.length;
        if (finished) st.pipe.closeWrite();
        const label = blocked ? `${n} wakes` : `${n}: write(${list[s.next[n]!]})`;
        st.last = `${label} = ${r.status === "blocked" ? `${r.written} so far, then it sleeps` : r.written}${finished ? ". It closes its write end" : ""}`;
        out.push({ actor, id: n, text: label, next: st });
      });
      const rb = s.pipe.readBlocked(READER);
      if (!s.eof && (!rb || s.pipe.canResumeRead(READER))) {
        const st = cloneS(s);
        const r = rb ? st.pipe.resumeRead(READER) : st.pipe.read(READER, spec.readSize);
        for (const x of r.runs) pushRun(st.stream, x);
        if (r.status === "EOF") st.eof = true;
        st.last = r.status === "EOF" ? "reader: read = 0, EOF" : r.status === "blocked" ? "reader: the pipe is empty, so it sleeps" : `reader: read = ${r.n}`;
        out.push({ actor: names.length, id: READER, text: `read(${spec.readSize})`, next: st });
      }
      return out;
    },
    done: (s) => s.eof,
    check(s) {
      const split = findSplit(s.stream, spec.splitLimit ?? Infinity, size);
      return split ? `Write ${split.write + 1} of ${split.src} (${size(split.src, split.write)} bytes) is split in the stream.` : null;
    },
    outcome: (s) => (checkStream(s.stream, spec.writers) ?? "ok"),
  };
}

export const explorePipe = (spec: InterleaveSpec): Explored => explore(pipeInterleaveModel(spec));

// ---------------------------------------------------------------- throughput model

/** MODEL INPUTS in ns: round figures of the right size. The syscall and copy costs are the ones in the mmap lesson. */
export const PIPE_COST = {
  syscallNs: MMAP_COSTS.syscallNs,
  /** One copy of 4 KiB costs this, so a byte costs copy4kNs / 4096. */
  copy4kNs: MMAP_COSTS.copy4kNs,
  /** Allocate and later free the page of one slot. */
  pageNs: 100,
  /** Take or drop a page reference, for splice. */
  pageRefNs: 30,
  /** Sleep, wake and switch between two processes on one core: the direct cost in the context switch lesson. */
  switchNs: SWITCH_INPUTS.directNs + SWITCH_INPUTS.mmSwitchNs,
};

export interface TransferSpec {
  slots: number;
  writeSize: number;
  readSize: number;
  totalBytes: number;
  pageSize?: number;
}

export interface TransferCounts { writes: number; reads: number; switches: number; slots: number; merges: number; bytes: number }

/**
 * Runs a real Pipe with one writer and one reader on one core. Each process runs until it must sleep.
 * It returns what happened. pipeThroughput turns the counts into time.
 */
export function pipeTransfer(t: TransferSpec): TransferCounts {
  const p = new Pipe({ slots: t.slots, pageSize: t.pageSize });
  let left = t.totalBytes;
  let got = 0;
  let switches = 0;
  let writerSleeping = false;
  while (got < t.totalBytes) {
    // The writer runs until it sleeps or finishes.
    while (left > 0 || writerSleeping) {
      const size = Math.min(t.writeSize, left);
      const r: WriteResult = writerSleeping ? p.resumeWrite("w") : p.write("w", size);
      if (!writerSleeping) left -= size;
      writerSleeping = r.status === "blocked";
      if (writerSleeping) break;
    }
    switches++;
    // The reader runs until the pipe is empty.
    while (!p.empty) got += p.read("r", t.readSize).n;
    switches++;
  }
  return { writes: p.stats.writes, reads: p.stats.reads, switches, slots: p.stats.slotsUsed, merges: p.stats.merges, bytes: t.totalBytes };
}

export interface ThroughputCost { syscallNs: number; copy4kNs: number; pageNs: number; pageRefNs: number; switchNs: number }

export interface Throughput {
  counts: TransferCounts;
  totalNs: number;
  bytesPerSec: number;
  /** Where the time goes. */
  parts: { syscalls: number; copies: number; pages: number; switches: number };
}

/** Time for a transfer. `splice` moves page references, so it has no copies. */
export function pipeThroughput(t: TransferSpec, opts: { splice?: boolean; cost?: Partial<ThroughputCost> } = {}): Throughput {
  const c: ThroughputCost = { ...PIPE_COST, ...opts.cost };
  const counts = pipeTransfer(t);
  const syscalls = (counts.writes + counts.reads) * c.syscallNs;
  const copies = opts.splice ? 0 : 2 * counts.bytes * (c.copy4kNs / 4096);
  const pages = counts.slots * (opts.splice ? c.pageRefNs : c.pageNs);
  const switches = counts.switches * c.switchNs;
  const totalNs = syscalls + copies + pages + switches;
  return { counts, totalNs, bytesPerSec: (counts.bytes / totalNs) * 1e9, parts: { syscalls, copies, pages, switches } };
}
