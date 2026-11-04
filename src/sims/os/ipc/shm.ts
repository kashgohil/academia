/**
 * Shared memory on top of the vm and memory reference code. Two AddressSpaces map one shmem file at different addresses.
 * A page fault in each one maps the same frame, so a store by one process is a load for the other.
 * The file also holds a linked list, so a view can show why stored pointers break and offsets work.
 *
 * The second part is a latency and throughput model for shared memory, pipes and Unix sockets. Every cost is a MODEL INPUT.
 */
import { AddressSpace, VmKernel } from "../vm/fault";
import { PageTable } from "../vm/pagetable";
import { PAGE_SIZE } from "../vm/addr";
import { MMAP_COSTS, MappedFile } from "../memory/mmap";
import { PIPE_COST } from "./pipe";

export const SHM_FILE = "/dev/shm/ring";

export const SHM_FACTS = {
  /** Three references to one frame with two mappings: the page cache and each PTE. */
  refsWithTwoMappers: 3,
  /** The usual cache line, and what `sysctl hw.cachelinesize` reports on M-series Macs. */
  cacheLineBytes: 64,
  appleCacheLineBytes: 128,
} as const;

export interface ShmProcess { name: string; as: AddressSpace; base: number }

export interface ShmLoad {
  va: number;
  ok: boolean;
  value: number;
  /** The frame that the address reached. */
  pfn: number | null;
  /** Inside the shared mapping of this process. */
  inShared: boolean;
  outcome: string;
}

export class ShmWorld {
  readonly kernel = new VmKernel();
  readonly pages: number;
  readonly procs: Record<string, ShmProcess> = {};
  /** Words in shared frames, by frame and page offset. */
  private words = new Map<number, Map<number, number>>();
  private tables: PageTable | null = null;

  constructor(pages = 2) {
    this.pages = pages;
    this.kernel.warmFile(SHM_FILE, pages);
  }

  /** shm_open and mmap(MAP_SHARED). `heapAt` adds a private mapping, to show a pointer that lands on the wrong data. */
  addProcess(name: string, base: number, opts: { heapAt?: number } = {}): ShmProcess {
    const pt = this.tables ? new PageTable({ mem: this.tables.mem }) : new PageTable();
    this.tables ??= pt;
    const as = new AddressSpace(this.kernel, pt);
    as.mmap(base, this.pages * PAGE_SIZE, { read: true, write: true, shared: true, file: { name: SHM_FILE } });
    if (opts.heapAt !== undefined) as.mmap(opts.heapAt, this.pages * PAGE_SIZE, { read: true, write: true, name: "[heap]" });
    const p: ShmProcess = { name, as, base };
    this.procs[name] = p;
    return p;
  }

  store(name: string, va: number, value: number): ShmLoad {
    const p = this.procs[name]!;
    const r = p.as.access(va, "w");
    if (r.pfn === undefined) return { va, ok: false, value: 0, pfn: null, inShared: false, outcome: r.outcome };
    const page = this.words.get(r.pfn) ?? new Map<number, number>();
    page.set(va % PAGE_SIZE, value);
    this.words.set(r.pfn, page);
    return { va, ok: true, value, pfn: r.pfn, inShared: this.inShared(p, va), outcome: r.outcome };
  }

  load(name: string, va: number): ShmLoad {
    const p = this.procs[name]!;
    const r = p.as.access(va, "r");
    if (r.pfn === undefined) return { va, ok: false, value: 0, pfn: null, inShared: false, outcome: r.outcome };
    return { va, ok: true, value: this.words.get(r.pfn)?.get(va % PAGE_SIZE) ?? 0, pfn: r.pfn, inShared: this.inShared(p, va), outcome: r.outcome };
  }

  private inShared(p: ShmProcess, va: number) { return va >= p.base && va < p.base + this.pages * PAGE_SIZE; }

  frameOf(name: string, offset: number): number | null {
    const p = this.procs[name]!;
    return p.as.access(p.base + offset, "r").pfn ?? null;
  }
}

// ---------------------------------------------------------------- a linked list inside the region

export type RefMode = "pointer" | "offset";

/** Node offsets inside the region. Each node holds a value, and then a reference to the next node. */
export const LIST_NODES = [{ offset: 0x100, value: 11 }, { offset: 0x840, value: 22 }, { offset: 0x1200, value: 33 }] as const;
const HEAD_OFFSET = 0x0;
const NULL_OFFSET = -1;

/** Process `name` builds the list. In pointer mode, it stores its own virtual addresses. */
export function buildList(w: ShmWorld, name: string, mode: RefMode) {
  const base = w.procs[name]!.base;
  const ref = (off: number) => (mode === "pointer" ? base + off : off);
  w.store(name, base + HEAD_OFFSET, ref(LIST_NODES[0].offset));
  LIST_NODES.forEach((n, i) => {
    w.store(name, base + n.offset, n.value);
    const next = LIST_NODES[i + 1];
    w.store(name, base + n.offset + 8, next ? ref(next.offset) : mode === "pointer" ? 0 : NULL_OFFSET);
  });
}

export interface WalkHop { stored: number; va: number; ok: boolean; value: number; inShared: boolean; outcome: string; offset: number | null }
export interface WalkResult { hops: WalkHop[]; values: number[]; verdict: "ok" | "segv" | "garbage" }

/** Process `name` follows the list with its own base address. */
export function walkList(w: ShmWorld, name: string, mode: RefMode): WalkResult {
  const base = w.procs[name]!.base;
  const hops: WalkHop[] = [];
  const values: number[] = [];
  let ref = w.load(name, base + HEAD_OFFSET).value;
  const isNull = (x: number) => (mode === "pointer" ? x === 0 : x === NULL_OFFSET);
  while (!isNull(ref) && hops.length < 8) {
    const va = mode === "pointer" ? ref : base + ref;
    const r = w.load(name, va);
    const offset = r.inShared ? va - base : null;
    hops.push({ stored: ref, va, ok: r.ok, value: r.value, inShared: r.inShared, outcome: r.outcome, offset });
    if (!r.ok) return { hops, values, verdict: "segv" };
    if (!r.inShared) return { hops, values, verdict: "garbage" };
    values.push(r.value);
    ref = w.load(name, va + 8).value;
  }
  const right = values.length === LIST_NODES.length && values.every((v, i) => v === LIST_NODES[i]!.value);
  return { hops, values, verdict: right ? "ok" : "garbage" };
}

/** MAP_PRIVATE breaks sharing at the first store: the writer gets its own page, and the others do not see the store. */
export function privateBreaksSharing(): { sharedSees: string; privateSees: string } {
  const f = new MappedFile(["old"]);
  const a = f.map("A", "shared");
  const b = f.map("B", "private");
  f.store(b, 0, "from B");
  const sharedSees1 = f.load(a, 0);
  f.store(a, 0, "from A");
  const privateSees = f.load(b, 0);
  return { sharedSees: sharedSees1.ok ? sharedSees1.value : "", privateSees: privateSees.ok ? privateSees.value : "" };
}

// ---------------------------------------------------------------- latency and throughput model

/** MODEL INPUTS in ns. They are round figures of the right size, and the first ones come from earlier lessons. */
export const IPC_COST = {
  syscallNs: MMAP_COSTS.syscallNs,
  /** Copy 4 KiB when the source is in this core's cache. */
  copy4kNs: MMAP_COSTS.copy4kNs,
  /** Copy 4 KiB when the source was just written by another core. */
  coldCopy4kNs: 800,
  /** One cache line moves to another core. */
  lineNs: 40,
  /** Wake a task that sleeps on another core: the IPI, the idle exit and the schedule. */
  wakeNs: 5000,
  pipePageNs: PIPE_COST.pageNs,
  /** Allocate and free one skb, and the af_unix work around it. */
  skbNs: 300,
  /** Default pipe capacity: a larger message must wait for the reader. */
  pipeCapacity: 65536,
  /** A stream socket also splits a large send into skbs of about this size. */
  skbBytes: 32768,
};

export type IpcKind = "shm" | "pipe" | "unix";
export const IPC_KINDS: IpcKind[] = ["shm", "pipe", "unix"];
export const IPC_LABEL: Record<IpcKind, string> = { shm: "Shared memory ring", pipe: "Pipe", unix: "Unix stream socket" };

export interface IpcResult { latencyNs: number; bytesPerSec: number; msgsPerSec: number; kernelEntries: number; copies: number }

const copyNs = (n: number, per4k: number) => (n / 4096) * per4k;

/**
 * One message of n bytes. `spin`: the reader polls and never sleeps. Otherwise it sleeps and the writer must wake it.
 * Latency is one way, from the start of the send until the reader holds the data. Throughput assumes two cores in a
 * pipeline, so the slower side sets the rate.
 */
export function ipcCost(kind: IpcKind, n: number, spin: boolean, c = IPC_COST): IpcResult {
  const inCopy = copyNs(n, c.copy4kNs);
  const outCopy = copyNs(n, c.coldCopy4kNs);
  if (kind === "shm") {
    const wake = spin ? 0 : c.syscallNs + c.wakeNs;
    const send = inCopy + c.lineNs;
    const recv = outCopy + c.lineNs;
    return finish(send + c.lineNs + outCopy + wake, send, recv, n, spin ? 0 : 1, 2);
  }
  const pages = Math.ceil(n / 4096);
  if (kind === "pipe") {
    const send = c.syscallNs + inCopy + pages * c.pipePageNs;
    const recv = c.syscallNs + outCopy;
    // A message larger than the pipe needs the reader to run: it fills, sleeps and wakes.
    const refills = Math.ceil(n / c.pipeCapacity) - 1;
    const wake = (spin ? c.lineNs : c.wakeNs) + refills * c.wakeNs;
    return finish(send + wake + recv, send + refills * c.wakeNs, recv, n, 2 + refills * 2, 2);
  }
  const skbs = Math.ceil(n / c.skbBytes);
  const send = c.syscallNs + inCopy + skbs * c.skbNs;
  const recv = c.syscallNs + outCopy;
  const wake = spin ? c.lineNs : c.wakeNs;
  return finish(send + wake + recv, send, recv, n, 2, 2);
}

function finish(latencyNs: number, send: number, recv: number, n: number, kernelEntries: number, copies: number): IpcResult {
  const per = Math.max(send, recv);
  return { latencyNs, msgsPerSec: 1e9 / per, bytesPerSec: (n / per) * 1e9, kernelEntries, copies };
}
