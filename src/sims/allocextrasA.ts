/**
 * Small, pure models for the first four allocator lessons (bump, arena, pool, free list).
 * The demos in src/demos/AllocExtrasA.tsx draw these; tests/unit/allocextrasA.test.ts pins
 * every number that the lesson text quotes.
 */
import { mulberry32 } from "./rng";

// ---------------------------------------------------------------- bump + alignment

/** Smallest multiple of `a` (a power of two) that is >= x. */
export const alignUp = (x: number, a: number) => (x + a - 1) & ~(a - 1);

export interface BumpReq { size: number; align: number; label?: string }
export interface BumpBlock extends BumpReq { /** top before the request */ start: number; addr: number; pad: number }

export interface BumpRun {
  blocks: BumpBlock[];
  top: number;
  /** Bytes requested. */
  data: number;
  /** Bytes lost to alignment. */
  pad: number;
}

/** Runs a sequence of requests through a bump pointer that starts at `start`. */
export function bumpRun(reqs: readonly BumpReq[], start = 0): BumpRun {
  let top = start, data = 0, pad = 0;
  const blocks: BumpBlock[] = [];
  for (const r of reqs) {
    const addr = alignUp(top, r.align);
    blocks.push({ ...r, start: top, addr, pad: addr - top });
    pad += addr - top;
    data += r.size;
    top = addr + r.size;
  }
  return { blocks, top, data, pad };
}

export interface StructLayout extends BumpRun {
  /** Alignment of the struct: the largest field alignment. */
  align: number;
  /** Padding after the last field, so that arrays of the struct stay aligned. */
  tail: number;
  /** sizeof(struct). */
  size: number;
}

/**
 * Lays out struct fields like a C compiler (declaration order), or like Rust / Zig may
 * when they reorder (stable sort by decreasing alignment).
 */
export function structLayout(fields: readonly BumpReq[], reorder = false): StructLayout {
  const order = reorder ? [...fields].sort((a, b) => b.align - a.align) : [...fields];
  const run = bumpRun(order, 0);
  const align = fields.reduce((m, f) => Math.max(m, f.align), 1);
  const size = alignUp(run.top, align);
  return { ...run, align, tail: size - run.top, size };
}

export const C_TYPES = {
  char: { size: 1, align: 1 },
  short: { size: 2, align: 2 },
  int: { size: 4, align: 4 },
  double: { size: 8, align: 8 },
  ptr: { size: 8, align: 8 },
} as const;
export type CType = keyof typeof C_TYPES;
export const fieldsOf = (types: readonly CType[]): BumpReq[] =>
  types.map((t, i) => ({ ...C_TYPES[t], label: `${String.fromCharCode(97 + i)}: ${t}` }));

// ---------------------------------------------------------------- arena

export const ARENA_HEADER = 16;

export interface ArenaChunk { len: number; used: number }

/**
 * Chunked arena with the same rules as crates/heapsim (arena.rs): each chunk starts with a
 * 16-byte header; a request that does not fit abandons the tail of the current chunk; an
 * oversized request gets a chunk that is a whole multiple of the chunk size.
 * `reset(keep)` either keeps the chunks for reuse or gives them back to the backing allocator.
 */
export class ArenaSim {
  chunks: ArenaChunk[] = [];
  /** Index of the chunk that receives new allocations. */
  cur = -1;
  /** Calls to the backing allocator (one per new chunk). */
  backingCalls = 0;
  live = 0;
  pad = 0;
  constructor(readonly chunk: number, readonly header = ARENA_HEADER) {}

  private tryIn(i: number, size: number, align: number): number | null {
    const c = this.chunks[i];
    if (!c) return null;
    const addr = alignUp(c.used, align);
    if (addr + size > c.len) return null;
    this.pad += addr - c.used;
    c.used = addr + size;
    this.live += size;
    return addr;
  }

  /** Returns the chunk index of the new block. */
  alloc(size: number, align = 1): number {
    if (this.tryIn(this.cur, size, align) !== null) return this.cur;
    // Kept chunks after a reset are reused in order before new ones are opened.
    for (let i = this.cur + 1; i < this.chunks.length; i++) {
      this.cur = i;
      if (this.tryIn(i, size, align) !== null) return i;
    }
    const len = Math.ceil((this.header + size + align) / this.chunk) * this.chunk;
    this.chunks.push({ len, used: this.header });
    this.backingCalls++;
    this.cur = this.chunks.length - 1;
    this.tryIn(this.cur, size, align);
    return this.cur;
  }

  /** One call frees every allocation. */
  reset(keepChunks = true) {
    if (keepChunks) for (const c of this.chunks) c.used = this.header;
    else this.chunks = [];
    this.cur = this.chunks.length ? 0 : -1;
    this.live = 0;
    this.pad = 0;
  }

  /** Bytes the arena holds from its backing allocator. */
  get reserved() { return this.chunks.reduce((n, c) => n + c.len, 0); }
  get headers() { return this.chunks.length * this.header; }
  /** Abandoned tails: unused space in chunks before the current one. */
  get slack() { return this.chunks.slice(0, Math.max(0, this.cur)).reduce((n, c) => n + c.len - c.used, 0); }
}

/** Sizes of the objects that one simulated frame allocates. Deterministic for a seed. */
export function frameSizes(frame: number, perFrame: number, seed = 1): number[] {
  const r = mulberry32(seed * 7919 + frame * 104729);
  return Array.from({ length: perFrame }, () => 8 * (1 + Math.floor(r() * 12)));
}

export interface FrameStep {
  frame: number;
  /** Live bytes at the end of the frame, before the reset. */
  live: number;
  reserved: number;
  backingCalls: number;
  /** free() calls that malloc/free would need for the same work, so far. */
  mallocFrees: number;
  /** Arena resets so far. */
  resets: number;
  /** Chunks at the end of the frame. */
  chunks: ArenaChunk[];
}

/**
 * A game loop: every frame allocates `perFrame` temporary objects. The arena is reset every
 * `resetEvery` frames (0 = never). Returns one point per frame.
 */
export function frameLoop(o: { frames: number; perFrame: number; chunk: number; resetEvery: number; keepChunks?: boolean; seed?: number }): FrameStep[] {
  const a = new ArenaSim(o.chunk);
  const out: FrameStep[] = [];
  let frees = 0, resets = 0;
  for (let f = 1; f <= o.frames; f++) {
    for (const s of frameSizes(f, o.perFrame, o.seed ?? 1)) a.alloc(s, 8);
    frees += o.perFrame;
    out.push({ frame: f, live: a.live, reserved: a.reserved, backingCalls: a.backingCalls, mallocFrees: frees, resets, chunks: a.chunks.map((c) => ({ ...c })) });
    if (o.resetEvery > 0 && f % o.resetEvery === 0) { a.reset(o.keepChunks ?? true); resets++; }
  }
  return out;
}

export interface ChunkWaste { chunk: number; headers: number; tails: number; live: number; reserved: number; wasteFrac: number; estimate: number }

/**
 * Fills an arena with `n` allocations of random size (uniform in 1..2s-1, mean s) and measures
 * how much of the reserved memory went to headers and abandoned tails.
 * `estimate` is the rough model (h + s/2) / C.
 */
export function chunkWaste(chunk: number, s: number, n = 4000, seed = 5): ChunkWaste {
  const a = new ArenaSim(chunk);
  const r = mulberry32(seed);
  for (let i = 0; i < n; i++) a.alloc(1 + Math.floor(r() * (2 * s - 1)), 1);
  // Count only full chunks, so the half-used last chunk does not count as waste.
  const full = a.chunks.slice(0, -1);
  const reserved = full.reduce((x, c) => x + c.len, 0);
  const tails = full.reduce((x, c) => x + c.len - c.used, 0);
  const headers = full.length * a.header;
  const live = reserved - tails - headers;
  return { chunk, headers, tails, live, reserved, wasteFrac: (headers + tails) / reserved, estimate: (a.header + s / 2) / chunk };
}

// ---------------------------------------------------------------- pool

/** Number of slots, unusable leftover, and the alignment that every slot is guaranteed. */
export function poolGeometry(cap: number, slot: number) {
  const slots = Math.floor(cap / slot);
  return { slots, leftover: cap - slots * slot, align: slot & -slot };
}

export interface Handle { index: number; gen: number; name: string }

/**
 * Pool with an intrusive LIFO free list and generational handles.
 * `next[i]` is what a free slot i stores in its own bytes (-1 = null).
 */
export class PoolSim {
  next: number[];
  head: number;
  gen: number[];
  owner: (string | null)[];
  private names = 0;
  constructor(readonly n: number) {
    this.next = Array.from({ length: n }, (_, i) => (i + 1 < n ? i + 1 : -1));
    this.head = n > 0 ? 0 : -1;
    this.gen = Array(n).fill(0);
    this.owner = Array(n).fill(null);
  }
  alloc(): Handle | null {
    const i = this.head;
    if (i < 0) return null;
    this.head = this.next[i]!; // p = head; head = *p
    this.next[i] = -1;
    const name = String.fromCharCode(65 + (this.names++ % 26));
    this.owner[i] = name;
    return { index: i, gen: this.gen[i]!, name };
  }
  free(i: number): boolean {
    if (this.owner[i] == null) return false;
    this.owner[i] = null;
    this.gen[i]!++;
    this.next[i] = this.head; // *p = head; head = p
    this.head = i;
    return true;
  }
  /** A handle is valid only while the slot still has the same generation. */
  valid(h: Handle) { return this.gen[h.index] === h.gen && this.owner[h.index] != null; }
  /** Free slots in list order, starting at head. */
  freeOrder(): number[] {
    const out: number[] = [];
    for (let i = this.head; i >= 0 && out.length <= this.n; i = this.next[i]!) out.push(i);
    return out;
  }
}

/** glibc safe-linking (2.32+): the stored pointer is next XOR (address of the slot >> 12). */
export const protectPtr = (pos: bigint, ptr: bigint) => (pos >> 12n) ^ ptr;
export const revealPtr = (pos: bigint, stored: bigint) => (pos >> 12n) ^ stored;
/** glibc rejects a decoded tcache pointer that is not 16-byte aligned. */
export const passesAlignCheck = (p: bigint) => (p & 15n) === 0n;

/**
 * Fraction of random slot addresses (ASLR moves bits 12 and up) for which a raw, 16-aligned
 * forged pointer still decodes to a 16-aligned value and passes the check.
 */
export function forgedPassRate(target: bigint, samples = 4096, seed = 9): number {
  const r = mulberry32(seed);
  let ok = 0;
  for (let i = 0; i < samples; i++) {
    const pos = 0x550000000000n + (BigInt(Math.floor(r() * 2 ** 28)) << 12n) + 0x2c0n;
    if (passesAlignCheck(revealPtr(pos, target))) ok++;
  }
  return ok / samples;
}

// ---------------------------------------------------------------- free list

export const FL_HEADER = 8;
export const FL_MIN_BLOCK = 16;
export type Fit = "first" | "next" | "best" | "worst";
export const FITS: Fit[] = ["first", "next", "best", "worst"];

export interface FBlock { off: number; size: number; free: boolean; req: number; name: string }
export type Verdict = "used" | "small" | "fits" | "best" | "chosen";
export interface SearchStep { block: number; verdict: Verdict }
export interface SearchTrace { steps: SearchStep[]; chosen: number; examined: number; freeExamined: number }

/** Total block size (header + payload, 8-byte multiple, at least 16) for a request. */
export const blockNeed = (size: number) => Math.max(FL_MIN_BLOCK, alignUp(FL_HEADER + size, 8));

/** Header word: the size (a multiple of 8) with the "allocated" flag in bit 0. */
export const headerWord = (size: number, allocated: boolean) => size | (allocated ? 1 : 0);
export const headerSize = (w: number) => w & ~7;
export const headerAllocated = (w: number) => (w & 1) === 1;

/**
 * Implicit free list with 8-byte headers and 8-byte alignment, the same rules as
 * crates/heapsim (freelist.rs). `search` returns the walk that a policy makes, block by block.
 */
export class FreeListSim {
  blocks: FBlock[];
  rover = 0;
  private names = 0;
  constructor(readonly cap: number, public fit: Fit = "first", public coalesce = true) {
    this.blocks = [{ off: 0, size: cap & ~7, free: true, req: 0, name: "" }];
  }
  clone(): FreeListSim {
    const c = new FreeListSim(this.cap, this.fit, this.coalesce);
    c.blocks = this.blocks.map((b) => ({ ...b }));
    c.rover = this.rover;
    c.names = this.names;
    return c;
  }

  search(size: number, fit: Fit = this.fit): SearchTrace {
    const need = blockNeed(size);
    const n = this.blocks.length;
    let order = [...Array(n).keys()];
    if (fit === "next") {
      const s = Math.max(0, this.blocks.findIndex((b) => b.off >= this.rover));
      order = [...order.slice(s), ...order.slice(0, s)];
    }
    const steps: SearchStep[] = [];
    let chosen = -1, freeExamined = 0;
    for (const i of order) {
      const b = this.blocks[i]!;
      if (!b.free) { steps.push({ block: i, verdict: "used" }); continue; }
      freeExamined++;
      if (b.size < need) { steps.push({ block: i, verdict: "small" }); continue; }
      if (fit === "first" || fit === "next") { chosen = i; steps.push({ block: i, verdict: "chosen" }); break; }
      const c = chosen >= 0 ? this.blocks[chosen]! : null;
      const better = !c || (fit === "best" ? b.size < c.size : b.size > c.size);
      if (better) chosen = i;
      steps.push({ block: i, verdict: better ? "best" : "fits" });
    }
    if (chosen >= 0 && (fit === "best" || fit === "worst")) steps.push({ block: chosen, verdict: "chosen" });
    const examined = steps.filter((s) => s.verdict !== "chosen" || fit === "first" || fit === "next").length;
    return { steps, chosen, examined, freeExamined };
  }

  /** Allocates in block `i` (from a search). Returns the payload address, or null. */
  place(i: number, size: number): { addr: number; split: number } | null {
    const b = this.blocks[i];
    if (!b || !b.free) return null;
    const need = blockNeed(size);
    let split = 0;
    if (b.size - need >= FL_MIN_BLOCK) {
      split = b.size - need;
      this.blocks.splice(i + 1, 0, { off: b.off + need, size: split, free: true, req: 0, name: "" });
      b.size = need;
    }
    b.free = false;
    b.req = size;
    b.name = String.fromCharCode(65 + (this.names++ % 26));
    this.rover = b.off + b.size;
    return { addr: b.off + FL_HEADER, split };
  }

  alloc(size: number): number | null {
    const t = this.search(size);
    return t.chosen < 0 ? null : this.place(t.chosen, size)!.addr;
  }

  /** Frees the block at index i. Returns how many blocks merged into one (1 = no merge). */
  freeAt(i: number): number {
    const b = this.blocks[i];
    if (!b || b.free) return 0;
    b.free = true;
    b.req = 0;
    b.name = "";
    if (!this.coalesce) return 1;
    let merged = 1, j = i;
    const next = this.blocks[j + 1];
    if (next?.free) { b.size += next.size; this.blocks.splice(j + 1, 1); merged++; }
    const prev = this.blocks[j - 1];
    if (prev?.free) { prev.size += this.blocks[j]!.size; this.blocks.splice(j, 1); merged++; j--; }
    return merged;
  }

  freeAddr(addr: number): number {
    return this.freeAt(this.blocks.findIndex((b) => !b.free && b.off + FL_HEADER === addr));
  }

  stats() {
    const free = this.blocks.filter((b) => b.free);
    const freeBytes = free.reduce((n, b) => n + b.size - FL_HEADER, 0);
    const largest = free.reduce((m, b) => Math.max(m, b.size - FL_HEADER), 0);
    return { blocks: this.blocks.length, freeBlocks: free.length, freeBytes, largest, extFrag: freeBytes ? 1 - largest / freeBytes : 0 };
  }
}

/** The fragmented 1 KiB heap that the search demo starts from. */
export const PRESET_SIZES = [64, 96, 32, 160, 40, 72, 24, 112, 48, 120];
export const PRESET_FREE = [1, 3, 5, 7, 9];
export function presetHeap(fit: Fit = "first", coalesce = true): FreeListSim {
  const h = new FreeListSim(1024, fit, coalesce);
  const addrs = PRESET_SIZES.map((s) => h.alloc(s)!);
  for (const i of PRESET_FREE) h.freeAddr(addrs[i]!);
  h.rover = 0;
  return h;
}
