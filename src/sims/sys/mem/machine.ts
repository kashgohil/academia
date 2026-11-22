/**
 * An abstract machine of a running program: a deterministic model of a process's memory that demos drive with
 * explicit operations (call, ret, malloc, free, store, load, ...). It is not a C interpreter: a demo script says what
 * each line of C does to memory, and the machine keeps the bytes, checks every access and records a trace.
 *
 * Address space (model choices, like a Linux x86-64 non-PIE executable with ASLR off):
 *   text   0x401000   functions, 0x40 bytes each, read and execute
 *   rodata 0x402000   string literals, read only
 *   data   0x403000   globals with an initializer
 *   bss    0x404000   globals without an initializer (zero-filled)
 *   heap   0x405000   grows up (brk); the allocator below
 *   mmap   0x7ffff7fff000 and down (MMAP_BASE_NO_ASLR in src/sims/os/vm/layout.ts)
 *   stack  top 0x7ffffffff000 (STACK_TOP), first rsp 0x7fffffffe000; grows down. The 4 KiB above the first rsp
 *          stand for argv, envp and the auxiliary vector, which are not modelled.
 * text, rodata, data and bss hold 4 KiB each in this model. Addresses below 4 KiB are the null page.
 *
 * Stack frames (x86-64 System V with a frame pointer): rsp is 16-byte aligned before each call. `call` pushes the
 * return address (8 bytes) and the caller's frame pointer (8 bytes); the new frame pointer is the address of that
 * saved value, so it is 16-byte aligned too. The locals are laid out with `layoutC` as if they were the fields of one
 * struct, in declaration order from the LOWEST address, and the area is rounded to 16 bytes. Real compilers choose
 * their own order, add canaries and keep values in registers; this model does not. No red zone, no callee-saved
 * registers, no arguments in registers: a parameter is a local with an initial value.
 *
 * Heap allocator: first fit over an address-ordered list of blocks. Each block has a 16-byte header (like a glibc
 * chunk header: a prev_size word and a size word with an in-use bit) and a payload that is 16-byte aligned with a
 * size rounded up to 16 (minimum 16). A fit is split when the rest can hold a header and 16 bytes. free coalesces
 * with free neighbours. When nothing fits, the heap grows at the top (brk). free does not change the payload bytes
 * (glibc writes free-list pointers into the first 16 bytes; this model does not), so `rawLoad` after free shows the
 * stale value. realloc always makes a NEW allocation (the C standard says the old pointer is invalid even when the
 * address is the same); it stays in place when the new size fits the old block's capacity. realloc(p, 0) frees p and
 * returns null, as glibc does. The header bytes are written into memory for display; the allocator keeps its real
 * metadata outside memory, so an overflow that overwrites a header does not corrupt the allocator.
 *
 * Pointers have PROVENANCE: a pointer value is `{ addr, alloc? }`, where alloc is the id of the allocation it was
 * derived from (a heap block, a local, a global). Pointer arithmetic (`offset`) keeps it. A pointer stored in memory
 * keeps its provenance in a shadow map, as in Miri; overwriting any of its bytes removes it.
 *
 * Every checked access (store, load, free, memcpy, memset) is checked in this order, and a violation is a UB event
 * with a kind named as a sanitizer names it (UB_KINDS has the exact rule of each one). Real hardware checks NONE of
 * these: the model behaves like Miri or AddressSanitizer, not like a CPU. With `onUB: "record"` (the default) the
 * machine records the event and then does what the hardware would do where it can: an out-of-bounds store writes
 * the neighbour's bytes, a load after free returns the stale bytes. Null, unmapped and read-only accesses are skipped
 * (on a real machine they raise SIGSEGV). With `onUB: "throw"` it throws a `UbError` after recording. `rawLoad` and
 * `rawStore` skip all checks: they show the bytes that a real program would see.
 *
 * Determinism: no randomness and no clock. The same operations give the same addresses, events and snapshots.
 *
 * Not modelled: registers, the red zone, stack canaries, threads and TLS, signals, the dynamic loader, ASLR, glibc's
 * tcache, fastbins and arenas, ASan's quarantine and redzones (provenance finds the same bugs without them), compiler
 * optimizations, and pointer sizes other than 8 bytes (the target must be an LP64 or LLP64 target).
 */
import { layoutC, byteOwners, scalarInfo, struct as structType, typeName, TARGETS, type Layout, type Target, type TargetId, type Type, type ByteOwner } from "./layout";
import { MMAP_BASE_NO_ASLR, STACK_TOP as VM_STACK_TOP } from "../../os/vm/layout";

// ---------------------------------------------------------------- constants

/** Segment bases. Model choices; see the header. */
export const ADDR = {
  text: 0x401000,
  rodata: 0x402000,
  data: 0x403000,
  bss: 0x404000,
  heap: 0x405000,
  /** The mmap area grows down from here. */
  mmapTop: Number(MMAP_BASE_NO_ASLR),
  /** The top of the stack mapping: 2⁴⁷ minus one page. */
  stackTop: Number(VM_STACK_TOP),
  /** rsp before the first call. */
  stackStart: Number(VM_STACK_TOP) - 0x1000,
} as const;
/** Bytes that text, rodata, data and bss can hold in this model. */
export const STATIC_SEGMENT_BYTES = 0x1000;
/** Size of a heap block header. */
export const HEAP_HEADER = 16;
/** Payload alignment and size granule of the allocator. */
export const HEAP_ALIGN = 16;
/** Bytes per function in the text segment. */
export const FN_BYTES = 0x40;
/** Addresses below this are the null page: an access there is a null dereference. */
export const NULL_PAGE = 4096;
export const PAGE = 4096;
/** Default stack limit: 8 MiB, the usual `ulimit -s` default on Linux. */
export const STACK_LIMIT = 8 << 20;

// ---------------------------------------------------------------- public types

/** A pointer value. `alloc` is its provenance: the id of the allocation it points into, or undefined (none). */
export interface Ptr { addr: number; alloc?: number }
export const NULL: Ptr = { addr: 0 };
/** Pointer arithmetic: the address moves, the provenance stays. */
export const offset = (p: Ptr, bytes: number): Ptr => ({ addr: p.addr + bytes, alloc: p.alloc });
export const hex = (a: number) => "0x" + a.toString(16);

/** A value in memory. Integers wider than 53 bits load as bigint; pointers load as Ptr; arrays and structs nest. */
export type Value = number | bigint | boolean | Ptr | null | Value[] | { [field: string]: Value } | undefined;

export type AllocKind = "heap" | "stack" | "frame" | "global" | "rodata" | "text" | "mmap";

/** One allocation: a heap block, a local, a saved register slot, a global, a literal, a function. */
export interface Alloc {
  id: number;
  kind: AllocKind;
  addr: number;
  size: number;
  /** A variable name, a heap label ("malloc(16)" or an allocNamed label), or a function name. */
  name: string;
  /** For allocNamed: the kind of object ("Node", "Box<T>", "String"). */
  objKind?: string;
  type?: Type;
  live: boolean;
  /** Seq of the event that made it, and of the event that freed it or popped its frame. */
  born: number;
  died?: number;
  /** The source lines (`machine.line`) at those events, if a script set them. */
  bornLine?: number;
  diedLine?: number;
  /** The frame of a local. */
  frame?: number;
  /** A later allocation reused some of its bytes. */
  reused?: boolean;
  leaked?: "direct" | "indirect";
}

/**
 * The UB kinds and the exact rule that detects each one (checked in this order on every access):
 * 1. null-dereference: the address is below NULL_PAGE (4096) and the pointer has no provenance.
 * 2. heap-use-after-free / stack-use-after-return: the pointer's allocation is dead (freed, or its frame returned).
 * 3. heap-buffer-overflow / stack-buffer-overflow / global-buffer-overflow: the accessed bytes are not all inside the
 *    pointer's allocation (by provenance, so landing inside a neighbour still counts). A pointer with no provenance is
 *    checked against the allocation that contains its address; outside every allocation it is a segv.
 * 4. segv: no allocation and no mapped memory at the address, a write to text or rodata, or an access to pages that
 *    munmap removed.
 * 5. misaligned-access: the address is not a multiple of the type's alignment.
 * 6. use-of-uninitialized-value: a load reads a value byte (not padding) that was never written (Miri-style: the
 *    load is the use; MemorySanitizer would wait for a branch or a call).
 * free: double-free (the allocation is already freed), invalid-free (not the start of a live heap block: a stack,
 * global or interior pointer). memory-leak: at exit, a live heap block that no global reaches (LeakSanitizer).
 * stack-overflow: a call puts rsp more than the stack limit below the first rsp.
 */
export const UB_KINDS = [
  "null-dereference", "heap-use-after-free", "stack-use-after-return", "heap-buffer-overflow", "stack-buffer-overflow",
  "global-buffer-overflow", "segv", "misaligned-access", "use-of-uninitialized-value", "double-free", "invalid-free",
  "memory-leak", "stack-overflow",
] as const;
export type UbKind = (typeof UB_KINDS)[number];

/** The tool that reports each kind in a real build. */
export const UB_TOOL: Record<UbKind, string> = {
  "null-dereference": "UndefinedBehaviorSanitizer", "heap-use-after-free": "AddressSanitizer", "stack-use-after-return": "AddressSanitizer",
  "heap-buffer-overflow": "AddressSanitizer", "stack-buffer-overflow": "AddressSanitizer", "global-buffer-overflow": "AddressSanitizer",
  segv: "AddressSanitizer", "misaligned-access": "UndefinedBehaviorSanitizer", "use-of-uninitialized-value": "MemorySanitizer",
  "double-free": "AddressSanitizer", "invalid-free": "AddressSanitizer", "memory-leak": "LeakSanitizer", "stack-overflow": "AddressSanitizer",
};

export interface UbReport {
  kind: UbKind;
  tool: string;
  /** The first line, as the sanitizer prints it: "heap-use-after-free on address 0x405010". */
  message: string;
  /** "READ of size 4 at 0x405010", "WRITE of size 4 ...", or "" for free and leaks. */
  access: string;
  /** Where the address is: "0x405010 is located 0 bytes inside of 16-byte region [0x405010,0x405020)". */
  note: string;
  addr: number;
  size: number;
  /** The allocation involved, if any. */
  alloc?: number;
}

export interface TraceEvent {
  seq: number;
  op: string;
  detail: string;
  ptr?: Ptr;
  ub?: UbReport;
  /** The source line set with `machine.line`, for steppers. */
  line?: number;
}

export class UbError extends Error {
  report: UbReport;
  constructor(report: UbReport) {
    super(`${report.tool}: ${report.message}`);
    this.report = report;
  }
}

export interface MachineOptions {
  /** Default x86_64-linux. The pointer size must be 8. */
  target?: Target | TargetId;
  onUB?: "record" | "throw";
  /** Default STACK_LIMIT (8 MiB). */
  stackLimit?: number;
}

export interface Local { name: string; type: Type; value?: Value }

// snapshot types

export interface SegmentSnap { name: "text" | "rodata" | "data" | "bss" | "heap" | "mmap" | "stack"; lo: number; hi: number; perms: string; used: number }

export interface SlotSnap {
  id: number;
  name: string;
  typeName: string;
  type?: Type;
  kind: "local" | "ret" | "fp" | "global";
  addr: number;
  size: number;
  /** The value as short text: "42", "0x405010", "?" (uninitialized), "{1, 2, 3}". */
  text: string;
  value: Value;
  init: "yes" | "no" | "partial";
  /** For a pointer: the allocation it points into, and whether that allocation is dead. */
  pointsTo?: number;
  dangling?: boolean;
}

export interface FrameSnap {
  id: number;
  fn: string;
  /** False for a popped frame whose bytes no newer frame has reused yet. */
  live: boolean;
  fp: number;
  lo: number;
  hi: number;
  retAddr: number;
  savedFp: number;
  /** Return address, saved frame pointer, then the locals from high to low address. */
  slots: SlotSnap[];
}

export interface BlockSnap {
  id: number;
  addr: number;
  size: number;
  /** Payload bytes the block can hold (size rounded up to 16). */
  cap: number;
  state: "live" | "freed" | "leaked";
  label: string;
  objKind?: string;
  typeName?: string;
  kind: "heap" | "mmap";
}

/** A pointer stored in memory: from the allocation that holds it to the allocation it points into. */
export interface PtrEdge {
  from: number;
  fromAddr: number;
  /** "p" for a local, "node#3+8" for a field of a heap block. */
  fromName: string;
  fromKind: AllocKind;
  to?: number;
  toAddr: number;
  dangling: boolean;
}

export interface Snapshot {
  seq: number;
  line?: number;
  rsp: number;
  brk: number;
  segments: SegmentSnap[];
  /** Outermost frame first. Popped frames that are not yet overwritten come after the live ones, with live false. */
  frames: FrameSnap[];
  globals: SlotSnap[];
  /** Heap and mmap blocks in address order: live ones, and freed ones whose bytes are not reused yet. */
  heap: BlockSnap[];
  edges: PtrEdge[];
  ub: UbReport[];
  exited: boolean;
}

// ---------------------------------------------------------------- byte storage

/** Backing bytes for [lo, lo + bytes.length). It grows in both directions. */
class Space {
  bytes = new Uint8Array(0);
  init = new Uint8Array(0);
  lo: number;
  constructor(lo: number) { this.lo = lo; }
  get hi() { return this.lo + this.bytes.length; }
  ensure(a: number, b: number) {
    if (a >= this.lo && b <= this.hi) return;
    const lo = Math.min(a, this.lo);
    const want = Math.max(b, this.hi) - lo;
    const grow = this.bytes.length ? Math.max(want, this.bytes.length * 2) : want;
    // grow toward the side that needs it
    const newLo = a < this.lo ? Math.max(lo - (grow - want), 0) : lo;
    const len = Math.max(want, grow);
    const nb = new Uint8Array(len), ni = new Uint8Array(len);
    nb.set(this.bytes, this.lo - newLo);
    ni.set(this.init, this.lo - newLo);
    this.bytes = nb;
    this.init = ni;
    this.lo = newLo;
  }
  has(a: number, n: number) { return a >= this.lo && a + n <= this.hi; }
}

interface HeapBlock { start: number; size: number; free: boolean; alloc?: number }

interface Frame {
  id: number;
  fn: string;
  fp: number;
  lo: number;
  hi: number;
  retAddr: number;
  savedFp: number;
  retSlot: number;
  fpSlot: number;
  locals: number[];
  live: boolean;
  calls: number;
}

interface Segment { name: SegmentSnap["name"]; lo: number; hi: number; perms: string; space: Space }

const alignUp = (x: number, a: number) => Math.ceil(x / a) * a;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "int *" → "int **"; "char" → "char *". */
const ptrText = (tn: string) => (tn.endsWith("*") ? `${tn}*` : `${tn} *`);
const alignDown = (x: number, a: number) => Math.floor(x / a) * a;

// ---------------------------------------------------------------- the machine

export class Machine {
  readonly target: Target;
  readonly onUB: "record" | "throw";
  readonly stackLimit: number;
  /** Every event in order. */
  readonly trace: TraceEvent[] = [];
  /** Every UB report in order. */
  readonly ub: UbReport[] = [];
  /** The source line that later events record. Set it before each line of a script. */
  line: number | undefined;
  exited = false;

  private seq = 0;
  private nextId = 1;
  private allocs = new Map<number, Alloc>();
  /** Ids of live allocations, and of dead ones whose bytes no newer allocation has reused. */
  private liveIds = new Set<number>();
  private deadIds = new Set<number>();
  private prov = new Map<number, number>();
  private blocks: HeapBlock[] = [];
  private frames: Frame[] = [];
  private popped: Frame[] = [];
  /** Every popped frame by id, for UB notes. */
  private deadFrames = new Map<number, Frame>();
  private nextFrame = 1;
  private fns = new Map<string, number>();
  private globalsByName = new Map<string, number>();
  private globalIds: number[] = [];
  private mmaps: number[] = [];
  private layouts = new WeakMap<Type, Layout>();
  private owners = new WeakMap<Layout, ByteOwner[]>();
  private seg: Record<SegmentSnap["name"], Segment>;
  private top: Record<"text" | "rodata" | "data" | "bss", number> = { text: ADDR.text, rodata: ADDR.rodata, data: ADDR.data, bss: ADDR.bss };
  private brk: number = ADDR.heap;
  private mmapLo: number = ADDR.mmapTop;
  private rsp: number = ADDR.stackStart;
  private minRsp: number = ADDR.stackStart;

  constructor(opts: MachineOptions = {}) {
    const t = opts.target ?? "x86_64-linux";
    this.target = typeof t === "string" ? TARGETS[t] : t;
    if (this.target.ptrBytes !== 8) throw new Error("The machine models 8-byte pointers only (an LP64 or LLP64 target).");
    this.onUB = opts.onUB ?? "record";
    this.stackLimit = opts.stackLimit ?? STACK_LIMIT;
    const mk = (name: SegmentSnap["name"], lo: number, perms: string): Segment => ({ name, lo, hi: lo, perms, space: new Space(lo) });
    this.seg = {
      text: mk("text", ADDR.text, "r-x"), rodata: mk("rodata", ADDR.rodata, "r--"), data: mk("data", ADDR.data, "rw-"),
      bss: mk("bss", ADDR.bss, "rw-"), heap: mk("heap", ADDR.heap, "rw-"), mmap: mk("mmap", ADDR.mmapTop, "rw-"),
      stack: mk("stack", ADDR.stackTop, "rw-"),
    };
    this.seg.stack.lo = alignDown(ADDR.stackStart, PAGE);
    this.seg.stack.space.ensure(this.seg.stack.lo, ADDR.stackTop);
    this.fnAddr("_start");
  }

  // ------------------------------------------------------------ helpers

  /** The C layout of a type on the machine's target (cached). */
  layout(type: Type): Layout {
    let l = this.layouts.get(type);
    if (!l) { l = layoutC(type, this.target); this.layouts.set(type, l); }
    return l;
  }

  sizeOf(type: Type) { return this.layout(type).size; }

  /** A pointer to a field of the struct that `p` points to. Provenance stays. */
  field(p: Ptr, type: Type, name: string): Ptr {
    const f = this.layout(type).fields.find((x) => x.name === name);
    if (!f) throw new Error(`no field ${name} in ${typeName(type)}`);
    return offset(p, f.offset);
  }

  /** An allocation by id (live or dead). */
  alloc(id: number | undefined): Alloc | undefined { return id === undefined ? undefined : this.allocs.get(id); }

  /** Every allocation, in creation order. */
  allAllocs(): Alloc[] { return [...this.allocs.values()]; }

  private event(op: string, detail: string, ptr?: Ptr, ub?: UbReport): TraceEvent {
    const e: TraceEvent = { seq: this.seq++, op, detail, ptr, ub, line: this.line };
    this.trace.push(e);
    return e;
  }

  private report(r: Omit<UbReport, "tool">): UbReport {
    const full: UbReport = { ...r, tool: UB_TOOL[r.kind] };
    this.ub.push(full);
    return full;
  }

  private fail(op: string, detail: string, r: UbReport, ptr?: Ptr): void {
    this.event(op, detail, ptr, r);
    if (this.onUB === "throw") throw new UbError(r);
  }

  private newAlloc(a: Omit<Alloc, "id" | "born" | "live">): Alloc {
    const full: Alloc = { ...a, id: this.nextId++, born: this.seq, bornLine: this.line, live: true };
    this.allocs.set(full.id, full);
    this.liveIds.add(full.id);
    return full;
  }

  private kill(a: Alloc) {
    a.live = false;
    a.died = this.seq;
    a.diedLine = this.line;
    this.liveIds.delete(a.id);
    this.deadIds.add(a.id);
  }

  /** Marks dead allocations that overlap [lo, hi) as reused. */
  private reuse(lo: number, hi: number, kinds: AllocKind[]) {
    for (const id of this.deadIds) {
      const x = this.allocs.get(id)!;
      if (kinds.includes(x.kind) && x.addr < hi && x.addr + Math.max(1, x.size) > lo) { x.reused = true; this.deadIds.delete(id); }
    }
  }

  private alive() { if (this.exited) throw new Error("the program has exited"); }

  /** The segment whose mapped range holds [a, a + n), if any. */
  private segmentAt(a: number, n = 1): Segment | undefined {
    for (const s of Object.values(this.seg)) if (s.name !== "mmap" && a >= s.lo && a + n <= s.hi) return s;
    for (const id of this.mmaps) {
      const m = this.allocs.get(id)!;
      if (m.live && a >= m.addr && a + n <= m.addr + alignUp(m.size, PAGE)) return this.seg.mmap;
    }
    return undefined;
  }

  /** The allocation that holds address a: a live one, else (unless liveOnly) the newest dead one not yet reused. */
  private allocAt(a: number, liveOnly = true): Alloc | undefined {
    const hit = (x: Alloc) => x.kind !== "text" && a >= x.addr && a < x.addr + Math.max(1, x.size);
    for (const id of this.liveIds) { const x = this.allocs.get(id)!; if (hit(x)) return x; }
    if (liveOnly) return undefined;
    let best: Alloc | undefined;
    for (const id of this.deadIds) { const x = this.allocs.get(id)!; if (hit(x) && (!best || x.born > best.born)) best = x; }
    return best;
  }

  /** "line 4" when a script set source lines, else "step 7" (the trace seq). */
  private at(seq: number | undefined, line: number | undefined) { return line !== undefined ? `line ${line}` : `step ${seq}`; }

  private where(a: Alloc): string {
    if (a.kind === "stack") return `'${a.name}' in frame '${this.frameOf(a)?.fn ?? "?"}'`;
    if (a.kind === "global" || a.kind === "rodata") return `global variable '${a.name}'`;
    return `${a.size}-byte region [${hex(a.addr)},${hex(a.addr + a.size)})`;
  }

  private frameOf(a: Alloc): Frame | undefined {
    return a.frame === undefined ? undefined : this.frames.find((f) => f.id === a.frame) ?? this.deadFrames.get(a.frame);
  }

  private position(addr: number, size: number, a: Alloc): string {
    if (addr < a.addr) return `${hex(addr)} is located ${plural(a.addr - addr, "byte")} before ${this.where(a)}`;
    if (addr + size > a.addr + a.size && addr >= a.addr + a.size) return `${hex(addr)} is located ${plural(addr - a.addr - a.size, "byte")} after ${this.where(a)}`;
    if (addr + size > a.addr + a.size) return `${hex(addr)} is located ${plural(addr - a.addr, "byte")} inside of ${this.where(a)}, and the access runs ${plural(addr + size - a.addr - a.size, "byte")} past its end`;
    return `${hex(addr)} is located ${plural(addr - a.addr, "byte")} inside of ${this.where(a)}`;
  }

  /**
   * Checks an access. Returns the UB report (also recorded), or null. `mem` says whether the bytes exist and are
   * allowed for the hardware: false for null, unmapped and read-only targets.
   */
  private check(p: Ptr, size: number, align: number, access: "read" | "write", typeText: string): { ub: UbReport | null; mem: boolean } {
    const addr = p.addr;
    const rw = access === "read" ? "READ" : "WRITE";
    const accessText = `${rw} of size ${size} at ${hex(addr)}`;
    const a = this.alloc(p.alloc);
    if (!a && addr < NULL_PAGE) {
      return { mem: false, ub: this.report({ kind: "null-dereference", message: `${access === "read" ? "load of" : "store to"} null pointer of type '${typeText}'`, access: accessText, note: addr === 0 ? "The pointer is null." : `SEGV on unknown address ${hex(addr)}: the address points to the zero page (a null pointer plus ${addr}).`, addr, size }) };
    }
    const target = a ?? this.allocAt(addr, false);
    const mapped = this.segmentAt(addr, size);
    const kindName = (x: Alloc) => (x.kind === "heap" || x.kind === "mmap" ? "heap" : x.kind === "stack" || x.kind === "frame" ? "stack" : "global");
    if (target && !target.live && target.kind === "mmap") {
      return { mem: false, ub: this.report({ kind: "segv", message: `SEGV on unknown address ${hex(addr)}`, access: accessText, note: `The address is not mapped: munmap removed these pages at ${this.at(target.died, target.diedLine)}.`, addr, size, alloc: target.id }) };
    }
    if (target && !target.live) {
      const heap = kindName(target) === "heap";
      const when = heap ? `freed at ${this.at(target.died, target.diedLine)}` : `which returned at ${this.at(target.died, target.diedLine)}`;
      return {
        mem: !!mapped && target.kind !== "mmap",
        ub: this.report({ kind: heap ? "heap-use-after-free" : "stack-use-after-return", message: `${heap ? "heap-use-after-free" : "stack-use-after-return"} on address ${hex(addr)}`, access: accessText, note: `${this.position(addr, size, target)}, ${when}.`, addr, size, alloc: target.id }),
      };
    }
    if (!target) {
      return { mem: false, ub: this.report({ kind: "segv", message: `SEGV on unknown address ${hex(addr)}`, access: accessText, note: mapped ? "No object lives at this address." : "The address is not mapped.", addr, size }) };
    }
    if (addr < target.addr || addr + size > target.addr + target.size) {
      const k = kindName(target);
      const kind = k === "heap" ? "heap-buffer-overflow" : k === "stack" ? "stack-buffer-overflow" : "global-buffer-overflow";
      return { mem: !!mapped && !(access === "write" && mapped.perms[1] !== "w"), ub: this.report({ kind, message: `${kind} on address ${hex(addr)}`, access: accessText, note: `${this.position(addr, size, target)}.`, addr, size, alloc: target.id }) };
    }
    if (access === "write" && (target.kind === "rodata" || target.kind === "text")) {
      return { mem: false, ub: this.report({ kind: "segv", message: `SEGV on unknown address ${hex(addr)}`, access: accessText, note: `The signal is caused by a WRITE memory access: ${hex(addr)} is in .${target.kind}, which is mapped read-only.`, addr, size, alloc: target.id }) };
    }
    if (!mapped) {
      return { mem: false, ub: this.report({ kind: "segv", message: `SEGV on unknown address ${hex(addr)}`, access: accessText, note: "The address is not mapped.", addr, size, alloc: target.id }) };
    }
    if (addr % align !== 0) {
      return { mem: true, ub: this.report({ kind: "misaligned-access", message: `${access === "read" ? "load of" : "store to"} misaligned address ${hex(addr)} for type '${typeText}', which requires ${align} byte alignment`, access: accessText, note: `${hex(addr)} is ${plural(addr % align, "byte")} past a multiple of ${align}.`, addr, size, alloc: target.id }) };
    }
    return { ub: null, mem: true };
  }

  // ------------------------------------------------------------ raw bytes

  private spaceFor(a: number, n: number): Space | undefined {
    const s = this.segmentAt(a, n);
    return s && s.space.has(a, n) ? s.space : undefined;
  }

  /** Bytes and init bits of [addr, addr + n), with no checks. Unmapped bytes read as 0, not initialized. */
  peek(addr: number, n: number): { bytes: number[]; init: boolean[] } {
    const whole = this.spaceFor(addr, n);
    if (whole) {
      const o = addr - whole.lo;
      return { bytes: Array.from(whole.bytes.subarray(o, o + n)), init: Array.from(whole.init.subarray(o, o + n), (x) => x === 1) };
    }
    const bytes: number[] = [], init: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const sp = this.spaceFor(addr + i, 1);
      bytes.push(sp ? sp.bytes[addr + i - sp.lo]! : 0);
      init.push(sp ? sp.init[addr + i - sp.lo] === 1 : false);
    }
    return { bytes, init };
  }

  /** Removes the provenance of every stored pointer that overlaps [a, a + n). */
  private clearProv(a: number, n: number) {
    if (!this.prov.size) return;
    if (n > 4096) {
      for (const k of [...this.prov.keys()]) if (k > a - 8 && k < a + n) this.prov.delete(k);
      return;
    }
    for (let k = a - 7; k < a + n; k++) this.prov.delete(k);
  }

  /** Writes a value of `type` at addr with no checks. Value bytes become initialized; padding is left alone. */
  private write(addr: number, type: Type, value: Value) {
    const l = this.layout(type);
    const sp = this.spaceFor(addr, l.size);
    if (!sp) return;
    this.clearProv(addr, l.size);
    this.writeIn(sp, addr, type, l, value);
  }

  private writeIn(sp: Space, addr: number, type: Type, l: Layout, value: Value) {
    const o = addr - sp.lo;
    const dv = new DataView(sp.bytes.buffer);
    const mark = () => sp.init.fill(1, o, o + l.size);
    switch (type.k) {
      case "scalar": case "nonzero": {
        const name = type.k === "scalar" ? type.name : type.of;
        const s = scalarInfo(name, this.target);
        if (s.float) {
          if (s.size === 4) dv.setFloat32(o, Number(value ?? 0), true);
          else if (s.size === 8) dv.setFloat64(o, Number(value ?? 0), true);
          else throw new Error("long double values are not modelled");
        } else {
          const v = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value ?? 0)));
          const u = BigInt.asUintN(s.size * 8, v);
          for (let i = 0; i < s.size; i++) sp.bytes[o + i] = Number((u >> BigInt(8 * i)) & 0xffn);
        }
        mark();
        return;
      }
      case "ptr": {
        const p = value === null || value === undefined ? NULL : typeof value === "number" ? { addr: value } : (value as Ptr);
        dv.setBigUint64(o, BigInt(p.addr), true);
        mark();
        if (p.alloc !== undefined) this.prov.set(addr, p.alloc);
        return;
      }
      case "array": {
        const arr = (value ?? []) as Value[];
        const el = l.elem!;
        for (let i = 0; i < type.n && i < arr.length; i++) if (arr[i] !== undefined) this.writeIn(sp, addr + i * el.size, type.of, el, arr[i]);
        return;
      }
      case "struct": case "union": {
        const obj = (value ?? {}) as Record<string, Value>;
        for (const f of l.fields) if (obj[f.name] !== undefined) this.writeIn(sp, addr + f.offset, f.type, f.inner ?? this.layout(f.type), obj[f.name]);
        return;
      }
      case "option":
        throw new Error("Option values are not modelled in the machine");
    }
  }

  /** Reads a value of `type` at addr with no checks. Returns undefined if the bytes are not mapped. */
  private read(addr: number, type: Type): Value {
    const l = this.layout(type);
    const sp = this.spaceFor(addr, l.size);
    return sp ? this.readIn(sp, addr, type, l) : undefined;
  }

  private readIn(sp: Space, addr: number, type: Type, l: Layout): Value {
    const o = addr - sp.lo;
    const dv = new DataView(sp.bytes.buffer);
    switch (type.k) {
      case "scalar": case "nonzero": {
        const name = type.k === "scalar" ? type.name : type.of;
        const s = scalarInfo(name, this.target);
        if (s.float) return s.size === 4 ? dv.getFloat32(o, true) : s.size === 8 ? dv.getFloat64(o, true) : undefined;
        if (s.size === 8) {
          const v = s.signed ? dv.getBigInt64(o, true) : dv.getBigUint64(o, true);
          return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        }
        const v = s.size === 1 ? (s.signed ? dv.getInt8(o) : dv.getUint8(o)) : s.size === 2 ? (s.signed ? dv.getInt16(o, true) : dv.getUint16(o, true)) : s.signed ? dv.getInt32(o, true) : dv.getUint32(o, true);
        return name === "bool" && (v === 0 || v === 1) ? v === 1 : v;
      }
      case "ptr": {
        const a = Number(dv.getBigUint64(o, true));
        const id = this.prov.get(addr);
        return id === undefined ? { addr: a } : { addr: a, alloc: id };
      }
      case "array": {
        const el = l.elem!;
        return Array.from({ length: type.n }, (_, i) => this.readIn(sp, addr + i * el.size, type.of, el));
      }
      case "struct": case "union": {
        const out: Record<string, Value> = {};
        for (const f of l.fields) out[f.name] = this.readIn(sp, addr + f.offset, f.type, f.inner ?? this.layout(f.type));
        return out;
      }
      case "option":
        return undefined;
    }
  }

  /** How many value bytes (not padding) of a `type` at addr are uninitialized. */
  private uninitBytes(addr: number, type: Type): number {
    const l = this.layout(type);
    const { init } = this.peek(addr, l.size);
    if (!l.fields.length && !l.elem) return init.filter((x) => !x).length;
    let own = this.owners.get(l);
    if (!own) { own = byteOwners(l); this.owners.set(l, own); }
    let n = 0;
    for (let i = 0; i < l.size; i++) if (!init[i] && !(own[i]?.pad ?? false)) n++;
    return n;
  }

  // ------------------------------------------------------------ text, globals, literals

  /** The address of a function in text. A function gets its address on first use, in order. */
  fnAddr(name: string): number {
    let id = this.fns.get(name);
    if (id === undefined) {
      const addr = this.top.text;
      if (addr + FN_BYTES > ADDR.text + STATIC_SEGMENT_BYTES) throw new Error("model limit: text holds 64 functions");
      this.top.text += FN_BYTES;
      this.seg.text.hi = this.top.text;
      this.seg.text.space.ensure(addr, addr + FN_BYTES);
      this.seg.text.space.init.fill(1, addr - this.seg.text.space.lo, addr - this.seg.text.space.lo + FN_BYTES);
      id = this.newAlloc({ kind: "text", addr, size: FN_BYTES, name }).id;
      this.fns.set(name, id);
    }
    return this.allocs.get(id)!.addr;
  }

  private place(sect: "data" | "bss" | "rodata", size: number, align: number): number {
    const addr = alignUp(this.top[sect], align);
    if (addr + size > ADDR[sect] + STATIC_SEGMENT_BYTES) throw new Error(`model limit: .${sect} holds ${STATIC_SEGMENT_BYTES} bytes`);
    this.top[sect] = addr + size;
    const s = this.seg[sect];
    s.hi = alignUp(Math.max(this.top[sect], s.lo + 1), PAGE);
    s.space.ensure(s.lo, s.hi);
    // static storage starts as zero bits, padding included (C11 6.7.9p10)
    s.space.init.fill(1, addr - s.space.lo, addr - s.space.lo + size);
    return addr;
  }

  /** A global variable: in .data with an initial value, in .bss (zero) without. Returns a pointer to it. */
  global(name: string, type: Type, value?: Value): Ptr {
    this.alive();
    const l = this.layout(type);
    const sect = value === undefined ? "bss" : "data";
    const addr = this.place(sect, l.size, l.align);
    const a = this.newAlloc({ kind: "global", addr, size: l.size, name, type });
    if (value !== undefined) this.write(addr, type, value);
    this.globalsByName.set(name, a.id);
    this.globalIds.push(a.id);
    const p = { addr, alloc: a.id };
    this.event("global", `${typeName(type)} ${name} at ${hex(addr)} (.${sect})`, p);
    return p;
  }

  /** A string literal in .rodata, with its terminating zero byte. Returns a `char *` to it. */
  literal(text: string): Ptr {
    this.alive();
    const bytes = [...new TextEncoder().encode(text), 0];
    const addr = this.place("rodata", bytes.length, 1);
    const sp = this.seg.rodata.space;
    sp.bytes.set(bytes, addr - sp.lo);
    const a = this.newAlloc({ kind: "rodata", addr, size: bytes.length, name: JSON.stringify(text) });
    const p = { addr, alloc: a.id };
    this.event("literal", `${JSON.stringify(text)} at ${hex(addr)} (.rodata, ${bytes.length} bytes)`, p);
    return p;
  }

  // ------------------------------------------------------------ stack

  /** Pushes a frame for `fn` with these locals (a parameter is a local with a value). Returns the frame id. */
  call(fn: string, locals: Local[] = []): number {
    this.alive();
    const caller = this.frames[this.frames.length - 1];
    const site = this.fnAddr(caller?.fn ?? "_start") + 0x0a + 5 * (caller ? caller.calls++ : 0);
    this.fnAddr(fn);
    const hi = this.rsp;
    const retAt = hi - 8;
    const fp = hi - 16;
    const l = this.layout(structType(fn, locals.map((x) => [x.name, x.type])));
    const lo = alignDown(fp - l.size, Math.max(16, l.align));
    const st = this.seg.stack;
    st.space.ensure(lo, hi);
    if (lo < this.minRsp) { this.minRsp = lo; st.lo = Math.min(st.lo, alignDown(lo, PAGE)); }
    // the locals start uninitialized; their old bytes stay
    st.space.init.fill(0, lo - st.space.lo, fp - st.space.lo);
    const id = this.nextFrame++;
    const retSlot = this.newAlloc({ kind: "frame", addr: retAt, size: 8, name: "return address", frame: id }).id;
    const fpSlot = this.newAlloc({ kind: "frame", addr: fp, size: 8, name: "saved rbp", frame: id }).id;
    const savedFp = caller ? caller.fp : 0;
    this.write(retAt, { k: "scalar", name: "u64" }, site);
    this.write(fp, { k: "scalar", name: "u64" }, savedFp);
    const ids = l.fields.map((f) => this.newAlloc({ kind: "stack", addr: lo + f.offset, size: f.size, name: f.name, type: f.type, frame: id }).id);
    const frame: Frame = { id, fn, fp, lo, hi, retAddr: site, savedFp, retSlot, fpSlot, locals: ids, live: true, calls: 0 };
    this.frames.push(frame);
    this.rsp = lo;
    // a popped frame that this one overwrites is gone for good
    this.popped = this.popped.filter((f) => f.lo >= hi || f.hi <= lo);
    this.reuse(lo, hi, ["stack", "frame"]);
    for (const [i, x] of locals.entries()) if (x.value !== undefined) this.write(this.allocs.get(ids[i]!)!.addr, x.type, x.value);
    const depth = ADDR.stackStart - lo;
    const detail = `${fn}(): frame [${hex(lo)}, ${hex(hi)}), return address ${hex(site)}, rbp = ${hex(fp)}`;
    if (depth > this.stackLimit) {
      this.fail("call", detail, this.report({ kind: "stack-overflow", message: `stack-overflow on address ${hex(lo)}`, access: "", note: `The stack is ${depth} bytes deep; the limit is ${this.stackLimit} bytes.`, addr: lo, size: 0 }));
    } else this.event("call", detail);
    return id;
  }

  /** Pops the top frame. Its locals die: a pointer to them now dangles. */
  ret(): void {
    this.alive();
    const f = this.frames.pop();
    if (!f) throw new Error("ret with no frame");
    f.live = false;
    for (const id of [f.retSlot, f.fpSlot, ...f.locals]) this.kill(this.allocs.get(id)!);
    this.popped.push(f);
    this.deadFrames.set(f.id, f);
    this.rsp = f.hi;
    this.event("ret", `${f.fn} returns to ${hex(f.retAddr)}; its frame [${hex(f.lo)}, ${hex(f.hi)}) is free stack`);
  }

  /** A pointer to a local of the top frame, or else to a global, by name. */
  addrOf(name: string): Ptr {
    const f = this.frames[this.frames.length - 1];
    const id = f?.locals.find((i) => this.allocs.get(i)!.name === name) ?? this.globalsByName.get(name);
    if (id === undefined) throw new Error(`no local or global named ${name}`);
    return { addr: this.allocs.get(id)!.addr, alloc: id };
  }

  /** The type of a local of the top frame or a global. */
  typeOf(name: string): Type {
    return this.alloc(this.addrOf(name).alloc)!.type!;
  }

  /** Stores to a local or global by name: `m.set("x", 42)`. */
  set(name: string, value: Value) { this.store(this.addrOf(name), this.typeOf(name), value); }
  /** Loads a local or global by name. */
  get(name: string): Value { return this.load(this.addrOf(name), this.typeOf(name)); }

  // ------------------------------------------------------------ heap

  /** Finds or makes a block whose payload can hold `cap` bytes at `align`. Returns the payload address. */
  private fit(cap: number, align: number): HeapBlock {
    const need = (start: number) => {
      let pay = alignUp(start + HEAP_HEADER, align);
      if (pay - HEAP_HEADER - start !== 0 && pay - HEAP_HEADER - start < 2 * HEAP_ALIGN) pay += align;
      return pay;
    };
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i]!;
      if (!b.free) continue;
      const pay = need(b.start);
      if (pay + cap > b.start + b.size) continue;
      return this.carve(i, pay, cap);
    }
    // grow the heap: extend a free last block, or add one
    const last = this.blocks[this.blocks.length - 1];
    const start = last && last.free ? last.start : this.brk;
    const pay = need(start);
    const end = pay + cap;
    if (last && last.free) last.size = end - last.start;
    else this.blocks.push({ start, size: end - start, free: true });
    this.brk = Math.max(this.brk, end);
    this.seg.heap.hi = alignUp(this.brk, PAGE);
    this.seg.heap.space.ensure(ADDR.heap, this.seg.heap.hi);
    return this.carve(this.blocks.length - 1, pay, cap);
  }

  /** Splits block i so that a used block has its payload at `pay` with `cap` bytes. */
  private carve(i: number, pay: number, cap: number): HeapBlock {
    const b = this.blocks[i]!;
    const start = pay - HEAP_HEADER;
    const parts: HeapBlock[] = [];
    if (start > b.start) parts.push({ start: b.start, size: start - b.start, free: true });
    const used: HeapBlock = { start, size: HEAP_HEADER + cap, free: false };
    parts.push(used);
    const rest = b.start + b.size - (start + used.size);
    if (rest >= HEAP_HEADER + HEAP_ALIGN) parts.push({ start: start + used.size, size: rest, free: true });
    else used.size += rest;
    this.blocks.splice(i, 1, ...parts);
    return used;
  }

  private writeHeader(b: HeapBlock) {
    const sp = this.seg.heap.space;
    this.clearProv(b.start, HEAP_HEADER);
    const dv = new DataView(sp.bytes.buffer);
    dv.setBigUint64(b.start - sp.lo, 0n, true);
    dv.setBigUint64(b.start + 8 - sp.lo, BigInt(b.size | (b.free ? 0 : 1)), true);
    sp.init.fill(1, b.start - sp.lo, b.start - sp.lo + HEAP_HEADER);
  }

  private newBlock(size: number, align: number, name: string, extra: Partial<Alloc> = {}): Alloc {
    if (align < HEAP_ALIGN) align = HEAP_ALIGN;
    const cap = Math.max(HEAP_ALIGN, alignUp(size, HEAP_ALIGN));
    const b = this.fit(cap, align);
    const a = this.newAlloc({ kind: "heap", addr: b.start + HEAP_HEADER, size, name, ...extra });
    b.alloc = a.id;
    this.writeHeader(b);
    const sp = this.seg.heap.space;
    sp.init.fill(0, a.addr - sp.lo, b.start + b.size - sp.lo);
    this.clearProv(a.addr, b.size - HEAP_HEADER);
    this.reuse(b.start, b.start + b.size, ["heap"]);
    return a;
  }

  /** malloc(size): a heap block, 16-byte aligned (or `align` for aligned_alloc), uninitialized. */
  malloc(size: number, align = HEAP_ALIGN, label?: string): Ptr {
    this.alive();
    const a = this.newBlock(size, align, label ?? `malloc(${size})`);
    const p = { addr: a.addr, alloc: a.id };
    this.event("malloc", `${a.name} = ${hex(a.addr)} (block #${a.id}, ${size} bytes)`, p);
    return p;
  }

  /** calloc(n, size): like malloc, but the bytes are zero and initialized. */
  calloc(n: number, size: number, label?: string): Ptr {
    this.alive();
    const a = this.newBlock(n * size, HEAP_ALIGN, label ?? `calloc(${n}, ${size})`);
    const sp = this.seg.heap.space;
    sp.bytes.fill(0, a.addr - sp.lo, a.addr - sp.lo + a.size);
    sp.init.fill(1, a.addr - sp.lo, a.addr - sp.lo + a.size);
    const p = { addr: a.addr, alloc: a.id };
    this.event("calloc", `${a.name} = ${hex(a.addr)} (block #${a.id}, zeroed)`, p);
    return p;
  }

  /**
   * A named heap object for ownership and GC demos: `allocNamed("Node", "a", { type: Node })`. The size comes from
   * `type`, or from `size` (default 16). The bytes are zeroed and initialized, like a constructor that sets all fields.
   */
  allocNamed(objKind: string, label: string, opts: { size?: number; type?: Type } = {}): Ptr {
    this.alive();
    const size = opts.type ? this.layout(opts.type).size : opts.size ?? 16;
    const a = this.newBlock(size, Math.max(HEAP_ALIGN, opts.type ? this.layout(opts.type).align : 1), label, { objKind, type: opts.type });
    const sp = this.seg.heap.space;
    sp.bytes.fill(0, a.addr - sp.lo, a.addr - sp.lo + size);
    sp.init.fill(1, a.addr - sp.lo, a.addr - sp.lo + size);
    const p = { addr: a.addr, alloc: a.id };
    this.event("alloc", `${objKind} ${label} = ${hex(a.addr)} (block #${a.id}, ${size} bytes)`, p);
    return p;
  }

  /** An anonymous private mapping in the mmap area: page-rounded, zero-filled. */
  mmap(len: number, label = `mmap(${len})`): Ptr {
    this.alive();
    const size = alignUp(Math.max(1, len), PAGE);
    this.mmapLo -= size;
    const s = this.seg.mmap;
    s.lo = Math.min(s.lo, this.mmapLo);
    s.space.ensure(this.mmapLo, ADDR.mmapTop);
    s.space.bytes.fill(0, this.mmapLo - s.space.lo, this.mmapLo - s.space.lo + size);
    s.space.init.fill(1, this.mmapLo - s.space.lo, this.mmapLo - s.space.lo + size);
    const a = this.newAlloc({ kind: "mmap", addr: this.mmapLo, size: len, name: label });
    this.mmaps.push(a.id);
    const p = { addr: a.addr, alloc: a.id };
    this.event("mmap", `${label} = ${hex(a.addr)} (${size} bytes, page-rounded)`, p);
    return p;
  }

  /** free(p). Checks: null is a no-op; double-free; invalid-free for anything that is not a live block's start. */
  free(p: Ptr | null): void {
    this.alive();
    if (!p || p.addr === 0) { this.event("free", "free(NULL) does nothing", p ?? NULL); return; }
    const detail = `free(${hex(p.addr)})`;
    const a = this.alloc(p.alloc) ?? this.allocAt(p.addr, false);
    if (a && !a.live && (a.kind === "heap" || a.kind === "mmap") && p.addr === a.addr) {
      return this.fail("free", detail, this.report({ kind: "double-free", message: `attempting double-free on ${hex(p.addr)}`, access: "", note: `${this.position(p.addr, 1, a)}, freed at ${this.at(a.died, a.diedLine)}.`, addr: p.addr, size: 0, alloc: a.id }), p);
    }
    if (!a || !a.live || (a.kind !== "heap" && a.kind !== "mmap") || p.addr !== a.addr) {
      const note = !a ? "No object lives at this address." : a.kind === "heap" || a.kind === "mmap" ? `${this.position(p.addr, 1, a)}${a.live ? "" : `, freed at ${this.at(a.died, a.diedLine)}`}: free needs the exact pointer that malloc returned.` : `${hex(p.addr)} is ${this.where(a)}: only malloc'd memory can be freed.`;
      return this.fail("free", detail, this.report({ kind: "invalid-free", message: `attempting free on address which was not malloc()-ed: ${hex(p.addr)}`, access: "", note, addr: p.addr, size: 0, alloc: a?.id }), p);
    }
    this.kill(a);
    if (a.kind === "mmap") { this.event("munmap", `munmap(${hex(p.addr)}): the pages are gone`, p); return; }
    const i = this.blocks.findIndex((b) => b.alloc === a.id);
    const b = this.blocks[i]!;
    b.free = true;
    b.alloc = undefined;
    // coalesce with the next and the previous free block
    const next = this.blocks[i + 1];
    if (next?.free) { b.size += next.size; this.blocks.splice(i + 1, 1); }
    const prev = this.blocks[i - 1];
    let merged = b;
    if (prev?.free) { prev.size += b.size; this.blocks.splice(i, 1); merged = prev; }
    this.writeHeader(merged);
    this.event("free", `${detail}: block #${a.id} (${a.size} bytes) is free`, p);
  }

  /** munmap for a pointer from mmap. Same checks as free. */
  munmap(p: Ptr) { this.free(p); }

  /**
   * realloc(p, size): a new allocation with the old bytes (up to the smaller size). In place when the new size fits
   * the old block's capacity, else a new block. The old pointer is invalid in both cases.
   */
  realloc(p: Ptr | null, size: number): Ptr {
    this.alive();
    if (!p || p.addr === 0) return this.malloc(size);
    if (size === 0) { this.free(p); this.event("realloc", `realloc(${hex(p.addr)}, 0) freed the block and returns NULL`); return NULL; }
    const old = this.alloc(p.alloc) ?? this.allocAt(p.addr, false);
    if (!old || !old.live || old.kind !== "heap" || old.addr !== p.addr) { this.free(p); return NULL; }
    const bi = this.blocks.findIndex((b) => b.alloc === old.id);
    const b = this.blocks[bi]!;
    const keep = Math.min(old.size, size);
    if (alignUp(size, HEAP_ALIGN) <= b.size - HEAP_HEADER) {
      this.kill(old);
      old.reused = true;
      this.deadIds.delete(old.id);
      const a = this.newAlloc({ kind: "heap", addr: old.addr, size, name: `malloc(${size})` });
      b.alloc = a.id;
      const sp = this.seg.heap.space;
      sp.init.fill(0, a.addr - sp.lo + keep, b.start + b.size - sp.lo);
      const np = { addr: a.addr, alloc: a.id };
      this.event("realloc", `realloc(${hex(p.addr)}, ${size}) = ${hex(a.addr)} in place (block #${a.id}); the old pointer is invalid`, np);
      return np;
    }
    const a = this.newBlock(size, HEAP_ALIGN, `malloc(${size})`);
    this.copyBytes(a.addr, old.addr, keep);
    const np = { addr: a.addr, alloc: a.id };
    this.free({ addr: old.addr, alloc: old.id });
    this.event("realloc", `realloc(${hex(p.addr)}, ${size}) moved the data to ${hex(a.addr)} (block #${a.id})`, np);
    return np;
  }

  // ------------------------------------------------------------ typed access

  /** A checked store of `value` as `type` at p. */
  store(p: Ptr, type: Type, value: Value): void {
    this.alive();
    const l = this.layout(type);
    const tn = typeName(type);
    const { ub, mem } = this.check(p, l.size, l.align, "write", tn);
    const detail = `*(${ptrText(tn)})${hex(p.addr)} = ${this.text(value, type)}`;
    if (mem) this.write(p.addr, type, value);
    if (ub) this.fail("store", detail, ub, p);
    else this.event("store", detail, p);
  }

  /** A checked load of a `type` at p. Returns undefined when the access is skipped (null, unmapped). */
  load(p: Ptr, type: Type): Value {
    this.alive();
    const l = this.layout(type);
    const tn = typeName(type);
    let { ub, mem } = this.check(p, l.size, l.align, "read", tn);
    const v = mem ? this.read(p.addr, type) : undefined;
    if (!ub && mem) {
      const n = this.uninitBytes(p.addr, type);
      if (n > 0) {
        const a = this.alloc(p.alloc) ?? this.allocAt(p.addr);
        ub = this.report({ kind: "use-of-uninitialized-value", message: "use-of-uninitialized-value", access: `READ of size ${l.size} at ${hex(p.addr)}`, note: `${plural(n, "byte")} of this ${l.size}-byte read ${n === 1 ? "was" : "were"} never written${a ? ` (in ${this.where(a)})` : ""}.`, addr: p.addr, size: l.size, alloc: a?.id });
      }
    }
    const detail = `*(${ptrText(tn)})${hex(p.addr)} → ${mem ? this.text(v, type) : "(no value)"}`;
    if (ub) this.fail("load", detail, ub, p);
    else this.event("load", detail, p);
    return v;
  }

  /** Reads the bytes at addr as `type` with NO checks: what a real program would see. Undefined if unmapped. */
  rawLoad(at: Ptr | number, type: Type): Value {
    const addr = typeof at === "number" ? at : at.addr;
    const v = this.read(addr, type);
    this.event("rawLoad", `raw *(${ptrText(typeName(type))})${hex(addr)} → ${v === undefined ? "(unmapped)" : this.text(v, type)}`);
    return v;
  }

  /** Writes `value` as `type` at addr with NO checks, even over a neighbour or a return address. */
  rawStore(at: Ptr | number, type: Type, value: Value): void {
    const addr = typeof at === "number" ? at : at.addr;
    this.write(addr, type, value);
    this.event("rawStore", `raw *(${ptrText(typeName(type))})${hex(addr)} = ${this.text(value, type)}`);
  }

  private rangeCheck(p: Ptr, n: number, access: "read" | "write", what: string): { ub: UbReport | null; mem: boolean } {
    if (n === 0) return { ub: null, mem: true };
    return this.check(p, n, 1, access, what);
  }

  private copyBytes(dst: number, src: number, n: number) {
    const s = this.spaceFor(src, n), d = this.spaceFor(dst, n);
    if (!s || !d || n === 0) return;
    const bytes = s.bytes.slice(src - s.lo, src - s.lo + n), init = s.init.slice(src - s.lo, src - s.lo + n);
    const moved: [number, number][] = [];
    for (const [k, id] of this.prov) if (k >= src && k + 8 <= src + n) moved.push([k - src + dst, id]);
    this.clearProv(dst, n);
    d.bytes.set(bytes, dst - d.lo);
    d.init.set(init, dst - d.lo);
    for (const [k, id] of moved) this.prov.set(k, id);
  }

  /** memcpy(dst, src, n): copies bytes, init bits and pointer provenance. Uninitialized bytes copy without a report. */
  memcpy(dst: Ptr, src: Ptr, n: number): void {
    this.alive();
    const detail = `memcpy(${hex(dst.addr)}, ${hex(src.addr)}, ${n})`;
    const r = this.rangeCheck(src, n, "read", "char");
    const w = this.rangeCheck(dst, n, "write", "char");
    if (r.mem && w.mem) this.copyBytes(dst.addr, src.addr, n);
    const ub = r.ub ?? w.ub;
    if (ub) this.fail("memcpy", detail, ub, dst);
    else this.event("memcpy", detail, dst);
  }

  /** memset(dst, byte, n). */
  memset(dst: Ptr, byte: number, n: number): void {
    this.alive();
    const detail = `memset(${hex(dst.addr)}, ${byte}, ${n})`;
    const { ub, mem } = this.rangeCheck(dst, n, "write", "char");
    const sp = mem ? this.spaceFor(dst.addr, n) : undefined;
    if (sp) {
      this.clearProv(dst.addr, n);
      sp.bytes.fill(byte & 0xff, dst.addr - sp.lo, dst.addr - sp.lo + n);
      sp.init.fill(1, dst.addr - sp.lo, dst.addr - sp.lo + n);
    }
    if (ub) this.fail("memset", detail, ub, dst);
    else this.event("memset", detail, dst);
  }

  /** Adds a note to the trace (for a line that does not touch memory). */
  note(text: string) { this.event("note", text); }

  // ------------------------------------------------------------ exit and leaks

  /** Blocks that the globals reach, following stored pointers (by provenance). */
  private reachable(roots: number[]): Set<number> {
    const out = new Set<number>();
    const byHolder = this.pointersByHolder();
    const todo = [...roots];
    while (todo.length) {
      const id = todo.pop()!;
      for (const t of byHolder.get(id) ?? []) {
        const a = this.allocs.get(t);
        if (a && a.live && (a.kind === "heap" || a.kind === "mmap") && !out.has(t)) { out.add(t); todo.push(t); }
      }
    }
    return out;
  }

  /** holder allocation id → ids of the allocations its stored pointers point into. */
  private pointersByHolder(): Map<number, number[]> {
    const m = new Map<number, number[]>();
    for (const [addr, to] of this.prov) {
      const h = this.allocAt(addr);
      if (!h) continue;
      const l = m.get(h.id);
      if (l) l.push(to);
      else m.set(h.id, [to]);
    }
    return m;
  }

  /**
   * exit(code): returns from every frame (like returning from main), then runs a leak check as LeakSanitizer does:
   * a live heap block that no global reaches is leaked. A leaked block that another leaked block points to is an
   * indirect leak; the others are direct leaks. One memory-leak report per leaked block.
   */
  exit(code = 0): void {
    this.alive();
    while (this.frames.length) this.ret();
    const live = [...this.allocs.values()].filter((a) => a.live && (a.kind === "heap" || a.kind === "mmap"));
    const reach = this.reachable(this.globalIds.filter((id) => this.allocs.get(id)!.live));
    const leaked = live.filter((a) => !reach.has(a.id));
    const leakedIds = new Set(leaked.map((a) => a.id));
    const byHolder = this.pointersByHolder();
    const indirect = new Set<number>();
    for (const a of leaked) for (const t of byHolder.get(a.id) ?? []) if (t !== a.id && leakedIds.has(t)) indirect.add(t);
    const bytes = leaked.reduce((s, a) => s + a.size, 0);
    this.event("exit", `exit(${code}): ${leaked.length} block${leaked.length === 1 ? "" : "s"} leaked (${bytes} bytes), ${reach.size} still reachable`);
    this.exited = true;
    for (const a of leaked) {
      a.leaked = indirect.has(a.id) ? "indirect" : "direct";
      const r = this.report({ kind: "memory-leak", message: "detected memory leaks", access: "", note: `${a.leaked === "direct" ? "Direct" : "Indirect"} leak of ${a.size} byte(s) in 1 object(s) allocated at ${this.at(a.born, a.bornLine)} (${a.name}).`, addr: a.addr, size: a.size, alloc: a.id });
      this.trace.push({ seq: this.seq++, op: "leak", detail: r.note, ptr: { addr: a.addr, alloc: a.id }, ub: r, line: this.line });
    }
    if (leaked.length && this.onUB === "throw") throw new UbError(this.ub[this.ub.length - leaked.length]!);
  }

  // ------------------------------------------------------------ display

  /** A value as short text for a type: 42, 0x405010, NULL, 'A', {1, 2}, ?. */
  text(v: Value, type?: Type): string {
    if (v === undefined) return "?";
    if (v === null) return "NULL";
    if (typeof v === "boolean") return String(v);
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") {
      if (type?.k === "scalar" && type.name === "char" && v >= 32 && v < 127) return `'${String.fromCharCode(v)}'`;
      return Number.isInteger(v) ? String(v) : String(+v.toPrecision(6));
    }
    if (Array.isArray(v)) {
      const el = type?.k === "array" ? type.of : undefined;
      return v.length > 8 ? `{${v.slice(0, 6).map((x) => this.text(x, el)).join(", ")}, …}` : `{${v.map((x) => this.text(x, el)).join(", ")}}`;
    }
    if ("addr" in v && typeof v.addr === "number" && (type === undefined || type.k === "ptr")) return v.addr === 0 ? "NULL" : hex(v.addr);
    const fields = type?.k === "struct" || type?.k === "union" ? type.fields : undefined;
    return `{${Object.entries(v).map(([k, x]) => `${k} = ${this.text(x, fields?.find((f) => f.name === k)?.type)}`).join(", ")}}`;
  }

  private slot(a: Alloc, kind: SlotSnap["kind"]): SlotSnap {
    const type: Type = a.type ?? { k: "scalar", name: "u64" };
    const value = this.read(a.addr, type);
    const { init } = this.peek(a.addr, a.size);
    const un = this.uninitBytes(a.addr, type);
    const state: SlotSnap["init"] = un === 0 ? "yes" : init.every((x) => !x) ? "no" : "partial";
    const s: SlotSnap = {
      id: a.id, name: a.name, typeName: a.type ? typeName(a.type) : "address", type: a.type, kind, addr: a.addr, size: a.size,
      text: state === "no" ? "?" : kind === "ret" || kind === "fp" ? hex(Number(value ?? 0)) : this.text(value, type), value, init: state,
    };
    if (type.k === "ptr" && value && typeof value === "object" && "addr" in value) {
      const to = this.alloc((value as Ptr).alloc);
      if (to) { s.pointsTo = to.id; s.dangling = !to.live; }
    }
    return s;
  }

  private frameSnap(f: Frame): FrameSnap {
    const locals = f.locals.map((id) => this.allocs.get(id)!).sort((x, y) => y.addr - x.addr);
    return {
      id: f.id, fn: f.fn, live: f.live, fp: f.fp, lo: f.lo, hi: f.hi, retAddr: f.retAddr, savedFp: f.savedFp,
      slots: [this.slot(this.allocs.get(f.retSlot)!, "ret"), this.slot(this.allocs.get(f.fpSlot)!, "fp"), ...locals.map((a) => this.slot(a, "local"))],
    };
  }

  /** The state of memory now, for views and steppers. */
  snapshot(): Snapshot {
    const segs: SegmentSnap[] = (["text", "rodata", "data", "bss", "heap", "mmap", "stack"] as const).map((n) => {
      const s = this.seg[n];
      const used = n === "text" ? this.top.text - ADDR.text : n === "rodata" || n === "data" || n === "bss" ? this.top[n] - ADDR[n] : n === "heap" ? this.brk - ADDR.heap : n === "mmap" ? ADDR.mmapTop - this.mmapLo : ADDR.stackStart - this.rsp;
      const lo = n === "stack" ? s.lo : n === "mmap" ? this.mmapLo : s.lo;
      const hi = n === "mmap" ? ADDR.mmapTop : n === "stack" ? ADDR.stackTop : Math.max(s.hi, alignUp(s.lo + used, PAGE));
      return { name: n, lo, hi: Math.max(hi, lo), perms: s.perms, used };
    });
    const heap: BlockSnap[] = [];
    for (const a of this.allocs.values()) {
      if (a.kind !== "heap" && a.kind !== "mmap") continue;
      if (!a.live && a.reused) continue;
      if (!a.live && a.kind === "mmap") continue;
      heap.push({
        id: a.id, addr: a.addr, size: a.size, cap: a.kind === "mmap" ? alignUp(a.size, PAGE) : Math.max(HEAP_ALIGN, alignUp(a.size, HEAP_ALIGN)),
        state: a.leaked ? "leaked" : a.live ? "live" : "freed", label: a.name, objKind: a.objKind, typeName: a.type ? typeName(a.type) : undefined, kind: a.kind,
      });
    }
    heap.sort((x, y) => x.addr - y.addr || x.id - y.id);
    const edges: PtrEdge[] = [];
    for (const [addr, to] of this.prov) {
      const h = this.allocAt(addr);
      if (!h || h.kind === "frame") continue;
      const t = this.allocs.get(to)!;
      const v = this.read(addr, { k: "ptr" }) as Ptr | undefined;
      const fromName = h.kind === "heap" || h.kind === "mmap" ? `${h.name}+${addr - h.addr}` : addr === h.addr ? h.name : `${h.name}+${addr - h.addr}`;
      edges.push({ from: h.id, fromAddr: addr, fromName, fromKind: h.kind, to, toAddr: v?.addr ?? t.addr, dangling: !t.live });
    }
    edges.sort((x, y) => x.fromAddr - y.fromAddr);
    return {
      seq: this.seq, line: this.line, rsp: this.rsp, brk: this.brk, segments: segs,
      frames: [...this.frames, ...this.popped.filter((f) => !this.frames.includes(f)).slice(-3)].map((f) => this.frameSnap(f)),
      globals: this.globalIds.map((id) => this.slot(this.allocs.get(id)!, "global")),
      heap, edges, ub: [...this.ub], exited: this.exited,
    };
  }

  /** The heap's block list (free and used), for allocator views and invariant tests. */
  heapBlocks(): { start: number; size: number; free: boolean; alloc?: number }[] {
    return this.blocks.map((b) => ({ ...b }));
  }
}
