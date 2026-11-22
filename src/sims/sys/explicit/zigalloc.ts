/**
 * Zig's `std.mem.Allocator` interface and five of its implementations, as in the Zig 0.17.1 standard library, with
 * one workload that runs on each of them. The demo "Same code, other allocator" draws this.
 *
 * The interface (lib/std/mem/Allocator.zig): an Allocator is two words, `ptr: *anyopaque` and
 * `vtable: *const VTable`, and the VTable has four functions: alloc, resize, remap and free. Every helper (create,
 * destroy, alloc, free, realloc, dupe) calls these four.
 *
 * Implementations, each a transcription of the 0.17.1 source:
 * - page: `std.heap.page_allocator` (heap/PageAllocator.zig) on Linux. alloc is one mmap, rounded up to whole pages.
 *   remap inside the same page count returns the same address; a larger page count uses mremap with MREMAP_MAYMOVE.
 *   resize never moves, so it only succeeds inside the same page count (or to shrink).
 * - c: `std.heap.c_allocator` (heap.zig): malloc, realloc and free. remap first tries in place (the new length fits
 *   the usable size of the block), then calls realloc. The C heap is the shared memory machine's allocator
 *   (src/sims/sys/mem), so the block sizes and addresses are those of that model, not glibc's.
 * - fba: `std.heap.FixedBufferAllocator` (heap/FixedBufferAllocator.zig): a bump pointer (`end_index`) in a buffer.
 *   Only the newest allocation can grow, shrink or be freed; a free of any other allocation does nothing.
 * - arena: `std.heap.ArenaAllocator` (heap/ArenaAllocator.zig) over page_allocator, single-threaded path. Nodes have
 *   a 24-byte header (size, end_index, next). alloc first bumps `end_index` (even when the request does not fit, as
 *   the lock-free code does), then tries to grow the node in place with the child's resize, then makes a new node of
 *   size 1.5 x (previous buffer + 24 + alignment + n + 16). free and resize work only on the newest allocation.
 *   deinit frees every node.
 * - testing: `std.testing.allocator`. In 0.17.1 this is a `std.heap.SafeAllocator`. MODEL: the placement uses the
 *   C heap of the memory machine (the real SafeAllocator has its own buckets), plus a table of live allocations that
 *   deinit reports as leaks, as the real one does.
 * - failing: `std.testing.FailingAllocator` over the testing allocator: allocation number `failIndex` (from 0) and
 *   every later one return null, so the caller sees error.OutOfMemory.
 *
 * The workload is the same Zig function for every allocator (WORK_SOURCE). `std.ArrayList(u64)` grows with
 * growCapacity(n) = n + n/2 + cache_line/8, where `std.atomic.cache_line` is 128 on x86-64 and AArch64, so the
 * first append asks for 17 items (136 bytes). When the list must grow, ensureTotalCapacityPrecise calls remap; if
 * that returns null it calls alloc, copies, and frees the old buffer.
 *
 * Checked against the real thing: tests/unit/sys-explicit.test.ts compares the call sequence of fba and arena with
 * traces printed by a logging wrapper around the real allocators (zig 0.17.1, aarch64-macos, page size 16 KiB). The
 * demo uses the Linux x86-64 page size, 4 KiB.
 */
import { Machine, array, T, hex, type Ptr, type Snapshot } from "../mem";

export const NODE_HEADER = 24;
export const CACHE_LINE = 128;
export const ITEM = 8;
/** growCapacity of std.ArrayList(T) in Zig 0.17.1 (lib/std/array_list.zig). */
export const growCapacity = (minimum: number, size = ITEM) => minimum + Math.floor(minimum / 2) + Math.max(1, Math.floor(CACHE_LINE / size));

const alignUp = (x: number, a: number) => Math.ceil(x / a) * a;

export type Owner = "a" | "b" | "report" | "node" | "buf";

/** A piece of a backing region: one allocation, live or dead. */
export interface Piece { addr: number; len: number; who: Owner; live: boolean }
/** One region of backing memory: an mmap, a malloc block, the FBA's buffer. */
export interface Region { addr: number; size: number; label: string; live: boolean; pieces: Piece[] }

export interface VCall {
  op: "alloc" | "resize" | "remap" | "free";
  who: Owner;
  len: number;
  newLen?: number;
  /** alloc and remap: an address or null. resize: true or false. free: true. */
  ok: boolean;
  moved?: boolean;
  /** The calls this one made to the layer under it: "mmap 4096", "child.resize 276→848", "malloc 136". */
  backing: string[];
}

export interface ZAllocator {
  readonly id: AllocId;
  alloc(len: number, align: number, who: Owner): number | null;
  resize(addr: number, len: number, newLen: number): boolean;
  remap(addr: number, len: number, newLen: number): number | null;
  free(addr: number, len: number): void;
  /** Calls to the layer under it since the last take. */
  takeBacking(): string[];
  regions(): Region[];
  /** Bytes this allocator holds from the layer under it now (fba: the bytes of its buffer that it has used). */
  held(): number;
  /** Runs at the end, like `defer arena.deinit()`. Returns report lines. */
  deinit(): string[];
}

// ---------------------------------------------------------------- page_allocator (Linux)

export class PageZ implements ZAllocator {
  readonly id: AllocId = "page";
  private log: string[] = [];
  private maps = new Map<number, { p: Ptr; len: number; who: Owner; label: string }>();
  readonly gone: Region[] = [];
  constructor(readonly m: Machine, readonly pageSize = 4096, readonly label = "mmap") {}
  private pages = (n: number) => alignUp(n, this.pageSize);
  alloc(len: number, _align: number, who: Owner): number | null {
    const p = this.m.mmap(this.pages(len), `${this.label} ${this.pages(len)}`);
    this.maps.set(p.addr, { p, len, who, label: this.label });
    this.log.push(`mmap ${this.pages(len)}`);
    return p.addr;
  }
  resize(addr: number, len: number, newLen: number): boolean {
    const ok = newLen <= len || this.pages(newLen) === this.pages(len);
    this.log.push(ok ? (this.pages(newLen) === this.pages(len) ? "same pages" : `munmap tail`) : "needs more pages: no");
    if (ok) this.maps.get(addr)!.len = newLen;
    return ok;
  }
  remap(addr: number, len: number, newLen: number): number | null {
    if (this.pages(newLen) === this.pages(len) || newLen < len) return this.resize(addr, len, newLen) ? addr : null;
    // mremap(MREMAP_MAYMOVE): the model moves the pages to a new place
    const e = this.maps.get(addr)!;
    const q = this.m.mmap(this.pages(newLen), `${this.label} ${this.pages(newLen)}`);
    this.m.munmap(e.p);
    this.maps.delete(addr);
    this.maps.set(q.addr, { p: q, len: newLen, who: e.who, label: e.label });
    this.log.push(`mremap ${this.pages(len)}→${this.pages(newLen)} (moved)`);
    return q.addr;
  }
  free(addr: number, len: number): void {
    const e = this.maps.get(addr)!;
    this.m.munmap(e.p);
    this.maps.delete(addr);
    this.log.push(`munmap ${this.pages(len)}`);
  }
  takeBacking() { const l = this.log; this.log = []; return l; }
  regions(): Region[] {
    return [...this.maps.values()].map((e) => ({ addr: e.p.addr, size: this.pages(e.len), label: `${e.label}`, live: true, pieces: [{ addr: e.p.addr, len: e.len, who: e.who, live: true }] }));
  }
  /** Bytes mapped now. */
  held() { return [...this.maps.values()].reduce((s, e) => s + this.pages(e.len), 0); }
  /** For the arena: the child's view of node sizes. */
  setLen(addr: number, len: number) { this.maps.get(addr)!.len = len; }
  deinit(): string[] { return []; }
}

// ---------------------------------------------------------------- c_allocator (the memory machine's C heap)

export class CZ implements ZAllocator {
  readonly id: AllocId = "c";
  protected log: string[] = [];
  protected blocks = new Map<number, { p: Ptr; len: number; who: Owner }>();
  constructor(readonly m: Machine) {}
  /** malloc_usable_size in the model: the block payload, rounded up to 16. */
  usable(addr: number) { const b = this.blocks.get(addr)!; return Math.max(16, alignUp(Math.max(b.len, 16), 16)); }
  alloc(len: number, _align: number, who: Owner): number | null {
    const p = this.m.malloc(Math.max(len, 16), 16, `${who}`);
    this.blocks.set(p.addr, { p, len, who });
    this.log.push(`malloc ${Math.max(len, 16)}`);
    return p.addr;
  }
  resize(addr: number, len: number, newLen: number): boolean {
    if (newLen <= len) return true;
    const ok = newLen <= this.usable(addr);
    if (ok) this.blocks.get(addr)!.len = newLen;
    this.log.push(`malloc_usable_size ${this.usable(addr)}`);
    return ok;
  }
  remap(addr: number, len: number, newLen: number): number | null {
    if (this.resize(addr, len, newLen)) return addr;
    const b = this.blocks.get(addr)!;
    const q = this.m.realloc(b.p, Math.max(newLen, 16));
    this.blocks.delete(addr);
    this.blocks.set(q.addr, { p: q, len: newLen, who: b.who });
    this.log.push(`realloc ${Math.max(newLen, 16)}${q.addr === addr ? "" : " (moved)"}`);
    return q.addr;
  }
  free(addr: number, len: number): void {
    const b = this.blocks.get(addr);
    if (!b) { this.m.free({ addr }); return; }
    this.m.free(b.p);
    this.blocks.delete(addr);
    this.log.push(`free ${Math.max(len, 16)}`);
  }
  takeBacking() { const l = this.log; this.log = []; return l; }
  regions(): Region[] {
    return [...this.blocks.values()].map((b) => ({ addr: b.p.addr, size: alignUp(Math.max(b.len, 16), 16), label: `malloc`, live: true, pieces: [{ addr: b.p.addr, len: b.len, who: b.who, live: true }] }));
  }
  held() { return [...this.blocks.values()].reduce((s, b) => s + alignUp(Math.max(b.len, 16), 16), 0); }
  deinit(): string[] { return []; }
}

// ---------------------------------------------------------------- std.testing.allocator (model)

export class TestingZ extends CZ {
  readonly id: AllocId = "testing";
  deinit(): string[] {
    // SafeAllocator.deinit logs one line per leaked allocation; the test runner then fails the test
    const leaks = [...this.blocks.values()];
    return leaks.map((b) => `[SafeAllocator] (err): leaked [addr: ${hex(b.p.addr)}, len: ${b.len} (0x${b.len.toString(16)})]`);
  }
}

// ---------------------------------------------------------------- FixedBufferAllocator

export class FbaZ implements ZAllocator {
  readonly id: AllocId = "fba";
  private log: string[] = [];
  end = 0;
  peakEnd = 0;
  readonly base: number;
  private pieces: Piece[] = [];
  constructor(readonly m: Machine, readonly size: number) {
    // `var buf: [size]u8 align(16) = undefined;` at file scope: .bss
    this.base = alignUp(m.global("buf", array(T.u8, size)).addr, 16);
  }
  private isLast(addr: number, len: number) { return addr + len === this.base + this.end; }
  alloc(len: number, align: number, who: Owner): number | null {
    const at = alignUp(this.base + this.end, align) - this.base;
    if (at + len > this.size) { this.log.push(`end_index ${this.end} + ${len} > ${this.size}: null`); return null; }
    this.end = at + len;
    this.peakEnd = Math.max(this.peakEnd, this.end);
    this.pieces.push({ addr: this.base + at, len, who, live: true });
    this.log.push(`end_index ${at} → ${this.end}`);
    return this.base + at;
  }
  resize(addr: number, len: number, newLen: number): boolean {
    if (!this.isLast(addr, len)) { this.log.push("not the newest allocation"); return newLen <= len; }
    if (newLen <= len) { this.end -= len - newLen; this.setLen(addr, newLen); return true; }
    if (newLen - len + this.end > this.size) { this.log.push("no room after it"); return false; }
    this.end += newLen - len;
    this.peakEnd = Math.max(this.peakEnd, this.end);
    this.setLen(addr, newLen);
    this.log.push(`end_index → ${this.end}`);
    return true;
  }
  private setLen(addr: number, len: number) { const p = this.pieces.find((x) => x.addr === addr && x.live); if (p) p.len = len; }
  remap(addr: number, len: number, newLen: number): number | null { return this.resize(addr, len, newLen) ? addr : null; }
  free(addr: number, len: number): void {
    const p = this.pieces.find((x) => x.addr === addr && x.live);
    if (p) p.live = false;
    if (this.isLast(addr, len)) { this.end -= len; this.log.push(`end_index → ${this.end}`); this.pieces = this.pieces.filter((x) => x.live || x.addr < this.base + this.end); }
    else this.log.push("not the newest: nothing happens");
  }
  takeBacking() { const l = this.log; this.log = []; return l; }
  regions(): Region[] {
    return [{ addr: this.base, size: this.size, label: "buf (.bss)", live: true, pieces: this.pieces.map((p) => ({ ...p })) }];
  }
  held() { return this.peakEnd; }
  deinit(): string[] { return []; }
}

// ---------------------------------------------------------------- ArenaAllocator over page_allocator

interface Node { addr: number; size: number; end: number; pieces: Piece[] }

export class ArenaZ implements ZAllocator {
  readonly id: AllocId = "arena";
  private log: string[] = [];
  /** used_list, newest first. */
  nodes: Node[] = [];
  readonly child: PageZ;
  constructor(m: Machine, pageSize = 4096) { this.child = new PageZ(m, pageSize, "arena node"); }
  private buf(n: Node) { return n.addr + NODE_HEADER; }
  private idx(n: Node, end: number, align: number) { return alignUp(this.buf(n) + end, align) - this.buf(n); }
  private childLog() { this.log.push(...this.child.takeBacking().map((s) => `child ${s}`)); }
  alloc(len: number, align: number, who: Owner): number | null {
    const first = this.nodes[0];
    let prev = 0;
    if (first) {
      const bufLen = first.size - NODE_HEADER;
      const ai = this.idx(first, first.end, align);
      first.end = ai + len; // the lock-free bump happens before the bounds check
      if (ai + len <= bufLen) { first.pieces.push({ addr: this.buf(first) + ai, len, who, live: true }); this.log.push(`bump in node: end_index ${first.end}`); return this.buf(first) + ai; }
      prev = bufLen;
      const ai2 = this.idx(first, first.end, align);
      const newSize = alignUp(NODE_HEADER + ai2 + len, 2);
      this.log.push(`child.resize ${first.size}→${newSize}`);
      if (this.child.resize(first.addr, first.size, newSize)) {
        this.childLog();
        first.size = newSize;
        first.end = ai2 + len;
        first.pieces.push({ addr: this.buf(first) + ai2, len, who, live: true });
        return this.buf(first) + ai2;
      }
      this.childLog();
      this.log.push("child.resize failed");
    }
    const min = NODE_HEADER + align + len;
    const big = prev + min + 16;
    const size = alignUp(big + Math.floor(big / 2), 2);
    this.log.push(`child.alloc ${size}`);
    const addr = this.child.alloc(size, 8, "node");
    this.childLog();
    if (addr === null) return null;
    const n: Node = { addr, size, end: 0, pieces: [] };
    const ai = this.idx(n, 0, align);
    n.end = ai + len;
    n.pieces.push({ addr: this.buf(n) + ai, len, who, live: true });
    this.nodes.unshift(n);
    return this.buf(n) + ai;
  }
  private isLast(addr: number, len: number) { const n = this.nodes[0]!; return this.buf(n) + n.end === addr + len; }
  resize(addr: number, len: number, newLen: number): boolean {
    const n = this.nodes[0]!;
    if (!this.isLast(addr, len)) { this.log.push("not the newest allocation"); return newLen <= len; }
    if (newLen <= len) { n.end -= len - newLen; this.setLen(addr, newLen); return true; }
    if (n.size - NODE_HEADER - n.end >= newLen - len) { n.end += newLen - len; this.setLen(addr, newLen); this.log.push(`end_index ${n.end}`); return true; }
    this.log.push("no room left in the node");
    return false;
  }
  private setLen(addr: number, len: number) { for (const n of this.nodes) for (const p of n.pieces) if (p.addr === addr && p.live) p.len = len; }
  remap(addr: number, len: number, newLen: number): number | null { return this.resize(addr, len, newLen) ? addr : null; }
  free(addr: number, len: number): void {
    for (const n of this.nodes) for (const p of n.pieces) if (p.addr === addr && p.live) p.live = false;
    if (this.isLast(addr, len)) { this.nodes[0]!.end -= len; this.log.push(`end_index ${this.nodes[0]!.end}`); }
    else this.log.push("not the newest: nothing happens");
  }
  takeBacking() { const l = this.log; this.log = []; return l; }
  regions(): Region[] {
    return [...this.nodes].reverse().map((n) => ({
      addr: n.addr, size: n.size, label: "arena node", live: true,
      pieces: [{ addr: n.addr, len: NODE_HEADER, who: "node" as Owner, live: true }, ...n.pieces.map((p) => ({ ...p }))],
    }));
  }
  held() { return this.nodes.reduce((s, n) => s + alignUp(n.size, this.child.pageSize), 0); }
  deinit(): string[] {
    for (const n of this.nodes) { this.child.free(n.addr, n.size); }
    const lines = this.nodes.map((n) => `child.free ${n.size}`);
    this.nodes = [];
    this.childLog();
    return lines;
  }
}

// ---------------------------------------------------------------- FailingAllocator

export class FailingZ implements ZAllocator {
  readonly id: AllocId = "failing";
  index = 0;
  induced = false;
  allocatedBytes = 0;
  freedBytes = 0;
  allocations = 0;
  deallocations = 0;
  constructor(readonly inner: ZAllocator, readonly failIndex: number) {}
  alloc(len: number, align: number, who: Owner): number | null {
    if (this.index === this.failIndex) { this.induced = true; return null; }
    const r = this.inner.alloc(len, align, who);
    if (r === null) return null;
    this.allocatedBytes += len;
    this.allocations++;
    this.index++;
    return r;
  }
  resize(addr: number, len: number, newLen: number) {
    const ok = this.inner.resize(addr, len, newLen);
    if (ok) { if (newLen > len) this.allocatedBytes += newLen - len; else this.freedBytes += len - newLen; }
    return ok;
  }
  remap(addr: number, len: number, newLen: number) {
    const r = this.inner.remap(addr, len, newLen);
    if (r !== null) { if (newLen > len) this.allocatedBytes += newLen - len; else this.freedBytes += len - newLen; }
    return r;
  }
  free(addr: number, len: number) { this.inner.free(addr, len); this.freedBytes += len; this.deallocations++; }
  takeBacking() { return this.inner.takeBacking(); }
  regions() { return this.inner.regions(); }
  held() { return this.inner.held(); }
  deinit() { return this.inner.deinit(); }
}

// ---------------------------------------------------------------- the workload

export type AllocId = "page" | "c" | "fba" | "arena" | "testing" | "failing";

export const ALLOCATORS: { id: AllocId; label: string; zig: string }[] = [
  { id: "page", label: "page_allocator", zig: "std.heap.page_allocator" },
  { id: "c", label: "c_allocator", zig: "std.heap.c_allocator" },
  { id: "fba", label: "FixedBuffer", zig: "fba.allocator()" },
  { id: "arena", label: "Arena", zig: "arena.allocator()" },
  { id: "testing", label: "testing", zig: "std.testing.allocator" },
  { id: "failing", label: "Failing", zig: "failing.allocator()" },
];

/** The Zig function that every allocator runs. Lines tagged in WORK_LINES. */
export const WORK_SOURCE = [
  "fn work(gpa: Allocator, n: usize) !void {",
  "    var a: std.ArrayList(u64) = .empty;",
  "    defer a.deinit(gpa);",
  "    var b: std.ArrayList(u64) = .empty;",
  "    defer b.deinit(gpa);",
  "    for (0..n) |i| {",
  "        try a.append(gpa, i);",
  "        try b.append(gpa, i); // two lists",
  "    }",
  "    const report = try gpa.alloc(u8, 100);",
  "    defer gpa.free(report); // forget it?",
  "}",
];

export interface WorkOptions { n: number; two: boolean; forget: boolean }
export interface ZigRunOptions extends WorkOptions { allocator: AllocId; fbaSize?: number; failIndex?: number; pageSize?: number }

export interface WorkStep {
  call: VCall;
  /** Workload line (1-based) that made the call. */
  line: number;
  regions: Region[];
  /** Bytes the backing layer holds after the call. */
  held: number;
  /** Bytes of live allocations that the program uses after the call. */
  live: number;
  /** Bytes of freed allocations that still take space (fba and arena: only the newest allocation is given back). */
  dead: number;
}

export interface ZigRun {
  steps: WorkStep[];
  result: "ok" | "error.OutOfMemory";
  /** Lines from deinit: arena frees, testing leak reports. */
  report: string[];
  /** Live allocations at the end that nobody will free (the allocator does not report them). */
  silentLeak: number;
  /** Calls by kind. */
  counts: Record<VCall["op"], number>;
  failedRemaps: number;
  /** Calls to the layer under the allocator: mmap, malloc, child.alloc, ... (one per backing string). */
  backingCalls: number;
  peakHeld: number;
  peakLive: number;
  /** The largest `dead` of any step. */
  peakDead: number;
  snapshot: Snapshot;
  machine: Machine;
}

interface List { addr: number; cap: number; len: number; who: Owner }

export function makeAllocator(m: Machine, o: ZigRunOptions): ZAllocator {
  const page = o.pageSize ?? 4096;
  switch (o.allocator) {
    case "page": return new PageZ(m, page);
    case "c": return new CZ(m);
    case "fba": return new FbaZ(m, o.fbaSize ?? 4096);
    case "arena": return new ArenaZ(m, page);
    case "testing": return new TestingZ(m);
    case "failing": return new FailingZ(new TestingZ(m), o.failIndex ?? 0);
  }
}

/** Runs WORK_SOURCE on one allocator and records every vtable call. */
export function runWork(o: ZigRunOptions): ZigRun {
  const m = new Machine();
  m.call("main", []);
  const z = makeAllocator(m, o);
  const steps: WorkStep[] = [];
  const counts = { alloc: 0, resize: 0, remap: 0, free: 0 };
  let failedRemaps = 0, backingCalls = 0, peakHeld = 0, peakLive = 0, peakDead = 0;
  const live = new Map<number, number>();
  const rec = (call: Omit<VCall, "backing">, line: number) => {
    const backing = z.takeBacking();
    backingCalls += backing.filter((b) => /^(child\.alloc|mmap|malloc|realloc|mremap|munmap|free|child\.free)/.test(b)).length;
    counts[call.op]++;
    const h = z.held();
    const l = [...live.values()].reduce((s, x) => s + x, 0);
    const regions = z.regions();
    const dead = regions.reduce((s, r) => s + r.pieces.filter((p) => !p.live).reduce((t, p) => t + p.len, 0), 0);
    peakHeld = Math.max(peakHeld, h);
    peakLive = Math.max(peakLive, l);
    peakDead = Math.max(peakDead, dead);
    steps.push({ call: { ...call, backing }, line, regions, held: h, live: l, dead });
  };
  const doAlloc = (len: number, align: number, who: Owner, line: number): number | null => {
    const r = z.alloc(len, align, who);
    if (r !== null) live.set(r, len);
    rec({ op: "alloc", who, len, ok: r !== null }, line);
    return r;
  };
  const doFree = (addr: number, len: number, who: Owner, line: number) => {
    z.free(addr, len);
    live.delete(addr);
    rec({ op: "free", who, len, ok: true }, line);
  };
  const lists: List[] = [{ addr: 0, cap: 0, len: 0, who: "a" }, { addr: 0, cap: 0, len: 0, who: "b" }];
  const append = (L: List, line: number): boolean => {
    if (L.len + 1 > L.cap) {
      const want = growCapacity(L.len + 1);
      let done = false;
      if (L.cap > 0) {
        const r = z.remap(L.addr, L.cap * ITEM, want * ITEM);
        rec({ op: "remap", who: L.who, len: L.cap * ITEM, newLen: want * ITEM, ok: r !== null, moved: r !== null && r !== L.addr }, line);
        if (r !== null) { live.delete(L.addr); live.set(r, want * ITEM); L.addr = r; L.cap = want; done = true; }
        else failedRemaps++;
      }
      if (!done) {
        const r = doAlloc(want * ITEM, ITEM, L.who, line);
        if (r === null) return false;
        if (L.cap > 0) doFree(L.addr, L.cap * ITEM, L.who, line);
        L.addr = r;
        L.cap = want;
      }
    }
    L.len++;
    return true;
  };
  let result: ZigRun["result"] = "ok";
  let report: { addr: number } | null = null;
  outer: {
    for (let i = 0; i < o.n; i++) {
      if (!append(lists[0]!, 7)) { result = "error.OutOfMemory"; break outer; }
      if (o.two && !append(lists[1]!, 8)) { result = "error.OutOfMemory"; break outer; }
    }
    const r = doAlloc(100, 1, "report", 10);
    if (r === null) { result = "error.OutOfMemory"; break outer; }
    report = { addr: r };
  }
  // the defers, last registered first: free(report), b.deinit, a.deinit
  if (report && !o.forget) doFree(report.addr, 100, "report", 11);
  for (const [L, line] of [[lists[1]!, 5], [lists[0]!, 3]] as const) if (L.cap > 0) doFree(L.addr, L.cap * ITEM, L.who, line);
  const silentLeak = report && o.forget ? 100 : 0;
  const lines = z.deinit();
  const snapshot = m.snapshot();
  return { steps, result, report: lines, silentLeak: o.allocator === "arena" || o.allocator === "testing" || o.allocator === "failing" ? 0 : silentLeak, counts, failedRemaps, backingCalls, peakHeld, peakLive, peakDead, snapshot, machine: m };
}

/** The vtable calls in the compact form that the Zig golden traces use: "a136 m136>344! f136". */
export function compactTrace(run: ZigRun): string {
  return run.steps.map(({ call: c }) => {
    const k = { alloc: "a", resize: "r", remap: "m", free: "f" }[c.op];
    const body = c.op === "remap" || c.op === "resize" ? `${c.len}>${c.newLen}` : `${c.len}`;
    return `${k}${body}${c.ok ? "" : "!"}`;
  }).join(" ");
}

/** The child (page_allocator) calls of an arena run, compact: "ca276 cr276>848 cf1048". */
export function arenaChildTrace(o: Omit<ZigRunOptions, "allocator">): string[] {
  const m = new Machine();
  m.call("main", []);
  const arena = new ArenaZ(m, o.pageSize ?? 4096);
  const out: string[] = [];
  const child = arena.child;
  const realAlloc = child.alloc.bind(child), realResize = child.resize.bind(child), realFree = child.free.bind(child);
  child.alloc = (len, align, who) => { out.push(`ca${len}`); return realAlloc(len, align, who); };
  child.resize = (addr, len, newLen) => { const ok = realResize(addr, len, newLen); out.push(`cr${len}>${newLen}${ok ? "" : "!"}`); return ok; };
  child.free = (addr, len) => { out.push(`cf${len}`); realFree(addr, len); };
  const lists: List[] = [{ addr: 0, cap: 0, len: 0, who: "a" }, { addr: 0, cap: 0, len: 0, who: "b" }];
  const append = (L: List) => {
    if (L.len + 1 > L.cap) {
      const want = growCapacity(L.len + 1);
      const r = L.cap > 0 ? arena.remap(L.addr, L.cap * ITEM, want * ITEM) : null;
      if (r !== null) { L.addr = r; L.cap = want; }
      else { const n = arena.alloc(want * ITEM, ITEM, L.who)!; if (L.cap > 0) arena.free(L.addr, L.cap * ITEM); L.addr = n; L.cap = want; }
    }
    L.len++;
  };
  for (let i = 0; i < o.n; i++) { append(lists[0]!); if (o.two) append(lists[1]!); }
  const rep = arena.alloc(100, 1, "report")!;
  if (!o.forget) arena.free(rep, 100);
  for (const L of [lists[1]!, lists[0]!]) if (L.cap > 0) arena.free(L.addr, L.cap * ITEM);
  arena.deinit();
  return out;
}
