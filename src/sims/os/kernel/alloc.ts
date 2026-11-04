/**
 * Getting memory at boot: a memory map, carving it into frames, a bitmap allocator and a free-list stack.
 * The map imitates what QEMU's firmware reports. Its layout is a model input.
 */
import { alignUp, bumpRun } from "../../allocextrasA";
import { PAGE_SIZE, MiB, GiB } from "../vm/addr";

export type MemType = "usable" | "reserved" | "acpi" | "bootloader" | "kernel" | "framebuffer";

export interface MemEntry { base: number; len: number; type: MemType; note: string }

/** MODEL INPUT: a small machine with 16 MiB. The unaligned entry near 640 KiB is typical of PC firmware. */
export const DEMO_MAP: MemEntry[] = [
  { base: 0x0000000, len: 0x009fc00, type: "usable", note: "low memory" },
  { base: 0x009fc00, len: 0x0000400, type: "reserved", note: "EBDA" },
  { base: 0x00a0000, len: 0x0060000, type: "reserved", note: "VGA and ROM hole" },
  { base: 0x0100000, len: 0x0080000, type: "kernel", note: "kernel image" },
  { base: 0x0180000, len: 0x0040000, type: "bootloader", note: "page tables and stack" },
  { base: 0x01c0000, len: 0x0d40000, type: "usable", note: "main memory" },
  { base: 0x0f00000, len: 0x00c0000, type: "framebuffer", note: "framebuffer" },
  { base: 0x0fc0000, len: 0x0040000, type: "acpi", note: "ACPI tables" },
];
export const DEMO_RAM_BYTES = 16 * MiB;
export const DEMO_FRAMES = DEMO_RAM_BYTES / PAGE_SIZE;

export interface FrameRange { first: number; count: number }
export interface Carved {
  ranges: FrameRange[];
  usableFrames: number;
  /** Bytes the map calls usable. */
  usableBytes: number;
  /** Usable bytes lost because a frame must be whole. */
  lostToRounding: number;
}

/** Keeps only whole frames: the start rounds up and the end rounds down. */
export function carve(map: readonly MemEntry[], opts: { skipFrameZero?: boolean } = {}): Carved {
  const ranges: FrameRange[] = [];
  let usableBytes = 0, whole = 0;
  for (const e of map) {
    if (e.type !== "usable") continue;
    usableBytes += e.len;
    const start = alignUp(e.base, PAGE_SIZE);
    const end = Math.floor((e.base + e.len) / PAGE_SIZE) * PAGE_SIZE;
    if (end <= start) continue;
    whole += end - start;
    let first = start / PAGE_SIZE;
    let count = (end - start) / PAGE_SIZE;
    if (opts.skipFrameZero && first === 0) { first = 1; count--; }
    if (count > 0) ranges.push({ first, count });
  }
  return { ranges, usableFrames: ranges.reduce((a, r) => a + r.count, 0), usableBytes, lostToRounding: usableBytes - whole };
}

// ---------------------------------------------------------------- metadata sizes

/** One bit per frame, rounded up to whole 64-bit words. */
export const bitmapBytes = (frames: number) => Math.ceil(frames / 64) * 8;
/** The share of RAM that a bitmap uses: 1 bit per 4 KiB. */
export const bitmapShare = () => 1 / (8 * PAGE_SIZE);
export const bitmapBytesForRam = (ramBytes: number) => bitmapBytes(ramBytes / PAGE_SIZE);
export const EXAMPLE_RAM = { small: 16 * MiB, big: 8 * GiB, huge: 64 * GiB };

/** Places a block with the early bump allocator: the first usable range with room, reusing bumpRun. */
export function placeEarly(c: Carved, bytes: number, minFrame = 256): { frame: number; frames: number } | null {
  const frames = Math.ceil(bytes / PAGE_SIZE);
  for (const r of c.ranges) {
    const startFrame = Math.max(r.first, minFrame);
    const room = r.first + r.count - startFrame;
    if (room < frames) continue;
    const run = bumpRun([{ size: frames * PAGE_SIZE, align: PAGE_SIZE, label: "bitmap" }], startFrame * PAGE_SIZE);
    return { frame: run.blocks[0]!.addr / PAGE_SIZE, frames };
  }
  return null;
}

// ---------------------------------------------------------------- frame allocators

export interface FrameAllocator {
  readonly kind: "bitmap" | "stack";
  alloc(): number | null;
  free(pfn: number): void;
  readonly freeCount: number;
  /** Cost counter: 64-bit words read by a bitmap scan, or frame headers touched by a stack. */
  readonly touches: number;
  /** Bytes of metadata outside the free frames. */
  readonly metaBytes: number;
  isFree(pfn: number): boolean;
}

/** One bit per frame. 1 means used, so that memory that the map does not name stays used. */
export class BitmapFrames implements FrameAllocator {
  readonly kind = "bitmap";
  readonly words: BigUint64Array;
  private hint = 0;
  freeCount = 0;
  touches = 0;
  constructor(readonly frames: number, ranges: readonly FrameRange[]) {
    this.words = new BigUint64Array(Math.ceil(frames / 64)).fill(~0n);
    for (const r of ranges) for (let f = r.first; f < r.first + r.count; f++) this.clear(f);
    this.touches = 0;
  }
  private clear(f: number) {
    this.words[f >> 6]! &= ~(1n << BigInt(f & 63));
    this.freeCount++;
  }
  /** Marks a frame used, for a carve-out that happens after setup. */
  reserve(f: number) {
    if (this.isFree(f)) { this.words[f >> 6]! |= 1n << BigInt(f & 63); this.freeCount--; }
  }
  get metaBytes() { return this.words.length * 8; }
  isFree(f: number) { return ((this.words[f >> 6]! >> BigInt(f & 63)) & 1n) === 0n; }
  alloc(): number | null {
    const n = this.words.length;
    for (let k = 0; k < n; k++) {
      const i = (this.hint + k) % n;
      this.touches++;
      const w = this.words[i]!;
      if (w === 0xffffffffffffffffn) continue;
      for (let b = 0; b < 64; b++) {
        if (((w >> BigInt(b)) & 1n) === 0n) {
          const f = i * 64 + b;
          if (f >= this.frames) break;
          this.words[i] = w | (1n << BigInt(b));
          this.freeCount--;
          this.hint = i;
          return f;
        }
      }
    }
    return null;
  }
  free(f: number) {
    if (this.isFree(f)) throw new Error(`double free of frame ${f}`);
    this.clear(f);
    if ((f >> 6) < this.hint) this.hint = f >> 6;
  }
}

/** A LIFO stack threaded through the free frames. It keeps one head word, and each free frame holds the next pointer. */
export class StackFrames implements FrameAllocator {
  readonly kind = "stack";
  /** The word stored inside each free frame. The kernel reaches it through the direct map. */
  readonly nextOf = new Map<number, number>();
  head = -1;
  freeCount = 0;
  touches = 0;
  readonly metaBytes = 8;
  constructor(ranges: readonly FrameRange[]) {
    for (const r of ranges) for (let f = r.first; f < r.first + r.count; f++) this.push(f);
  }
  private push(f: number) {
    this.nextOf.set(f, this.head);
    this.head = f;
    this.freeCount++;
    this.touches++;
  }
  isFree(f: number) { return this.nextOf.has(f); }
  alloc(): number | null {
    if (this.head < 0) return null;
    const f = this.head;
    this.head = this.nextOf.get(f)!;
    this.nextOf.delete(f);
    this.freeCount--;
    this.touches++;
    return f;
  }
  free(f: number) {
    if (this.nextOf.has(f)) throw new Error(`double free of frame ${f}`);
    this.push(f);
  }
}
