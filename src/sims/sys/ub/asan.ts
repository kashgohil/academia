/**
 * A model of AddressSanitizer's heap checking: shadow memory, redzones, quarantine and the inline check.
 *
 * Shadow memory: one shadow byte describes 8 application bytes (a granule). The shadow byte of address a is at
 * (a >> 3) + SHADOW_OFFSET. 0 means all 8 bytes are addressable; k in 1..7 means the first k bytes are addressable;
 * a negative byte (0xfa, 0xfd, ...) means none is, and its value says why. These encodings and the x86-64 Linux offset
 * 0x7fff8000 are ASan's (google/sanitizers wiki "AddressSanitizerAlgorithm"; the legend that ASan prints). The check
 * before an access of `size` bytes (1, 2, 4 or 8) at a is ASan's:
 *     k = *shadow(a); if (k != 0 && ((a & 7) + size - 1 >= k)) report
 * so an 8-byte access needs a 0 shadow byte.
 *
 * MODEL CHOICES (not ASan's exact allocator): a chunk is a 16-byte left redzone (it holds the chunk header in real
 * ASan), the user bytes, and a right redzone that rounds the chunk up to a multiple of 16. With 40 user bytes this
 * gives 64-byte chunks: exactly what a real run of clang -fsanitize=address showed on macOS (two malloc(40) calls were
 * 64 bytes apart, shadow "fa fa 00 00 00 00 00 fa"). Real ASan uses size classes and larger redzones for larger
 * blocks. Freed chunks go into a FIFO quarantine with a byte budget (real default: quarantine_size_mb, 256 MB on
 * 64-bit Linux); the budget here is a few hundred bytes so that eviction is visible. Bytes past the last chunk are
 * shadowed 0xfa, as in the real dump. The heap base is a model address.
 */

export const SHADOW_SCALE = 3;
/** Shadow offset of ASan on x86-64 Linux. */
export const SHADOW_OFFSET = 0x7fff8000;
export const GRANULE = 8;
export const LEFT_REDZONE = 16;
/** Model heap base. */
export const ASAN_HEAP = 0x602000000000;

export const SHADOW = {
  heapLeftRedzone: 0xfa,
  freed: 0xfd,
  stackLeftRedzone: 0xf1,
  stackMidRedzone: 0xf2,
  stackRightRedzone: 0xf3,
  stackAfterReturn: 0xf5,
  stackUseAfterScope: 0xf8,
  globalRedzone: 0xf9,
} as const;

/** The legend as ASan prints it (the values this model uses come first). */
export const SHADOW_LEGEND: [string, string][] = [
  ["00", "Addressable"],
  ["01 … 07", "Partially addressable"],
  ["fa", "Heap left redzone"],
  ["fd", "Freed heap region"],
  ["f1 f2 f3", "Stack left, mid, right redzone"],
  ["f5", "Stack after return"],
  ["f8", "Stack use after scope"],
  ["f9", "Global redzone"],
];

export const shadowAddr = (a: number) => Math.floor(a / 2 ** SHADOW_SCALE) + SHADOW_OFFSET;
const roundUp = (x: number, a: number) => Math.ceil(x / a) * a;

/** Chunk size for a user size (model). */
export const chunkSize = (size: number) => roundUp(LEFT_REDZONE + roundUp(Math.max(size, 1), GRANULE), 16);

export interface Chunk {
  id: number;
  /** Chunk start (the left redzone). */
  start: number;
  /** First user byte. */
  user: number;
  size: number;
  chunk: number;
  state: "live" | "quarantined" | "available";
  label: string;
}

export interface AsanReport {
  kind: "heap-buffer-overflow" | "heap-use-after-free" | "double-free" | "bad-free";
  /** "READ of size 4 at 0x..." */
  access: string;
  /** "0x... is located 0 bytes after 40-byte region [0x...,0x...)" */
  where: string;
  shadowByte: number;
  shadowAt: number;
}

export interface AccessResult {
  report: AsanReport | null;
  /** The shadow byte the check loaded, and its address. */
  shadowByte: number;
  shadowAt: number;
  /** The chunk whose bytes the address is in (any state), if any. */
  inChunk?: number;
}

const hex = (a: number) => "0x" + a.toString(16);

export class AsanHeap {
  chunks: Chunk[] = [];
  quarantine: number[] = [];
  top = ASAN_HEAP;
  private nextId = 1;
  constructor(public quarantineBytes = 192) {}

  /** The shadow byte of the granule that holds address a. */
  shadow(a: number): number {
    const g = a - (a % GRANULE);
    const c = this.chunks.find((x) => g >= x.start && g < x.start + x.chunk);
    if (!c) return SHADOW.heapLeftRedzone;
    if (g < c.user) return SHADOW.heapLeftRedzone;
    const end = c.user + c.size;
    if (c.state !== "live") return c.state === "quarantined" && g < end ? SHADOW.freed : SHADOW.heapLeftRedzone;
    if (g + GRANULE <= end) return 0;
    if (g < end) return end - g;
    return SHADOW.heapLeftRedzone;
  }

  malloc(size: number, label: string): Chunk {
    const need = chunkSize(size);
    // reuse an available chunk (first fit, exact class), else grow at the top
    let c = this.chunks.find((x) => x.state === "available" && x.chunk === need);
    if (c) {
      Object.assign(c, { size, state: "live", label, id: this.nextId++ });
    } else {
      c = { id: this.nextId++, start: this.top, user: this.top + LEFT_REDZONE, size, chunk: need, state: "live", label };
      this.chunks.push(c);
      this.top += need;
    }
    return c;
  }

  /** free(p). Returns a report for a double free or a free of a non-chunk pointer. */
  free(p: number): AsanReport | null {
    const c = this.chunks.find((x) => x.user === p);
    if (!c) return { kind: "bad-free", access: "", where: `attempting free on address which was not malloc()-ed: ${hex(p)}`, shadowByte: this.shadow(p), shadowAt: shadowAddr(p) };
    if (c.state !== "live") return { kind: "double-free", access: "", where: `${hex(p)} is located 0 bytes inside of ${c.size}-byte region ${this.range(c)}`, shadowByte: this.shadow(p), shadowAt: shadowAddr(p) };
    c.state = "quarantined";
    this.quarantine.push(c.id);
    this.evict();
    return null;
  }

  /** Bytes held in quarantine now. */
  get held() {
    return this.quarantine.reduce((s, id) => s + this.chunks.find((c) => c.id === id)!.chunk, 0);
  }

  private evict() {
    while (this.held > this.quarantineBytes && this.quarantine.length) {
      const id = this.quarantine.shift()!;
      this.chunks.find((c) => c.id === id)!.state = "available";
    }
  }

  private range(c: Chunk) {
    return `[${hex(c.user)},${hex(c.user + c.size)})`;
  }

  /** The inline check for an access of `size` bytes at a (size 1, 2, 4 or 8). */
  access(a: number, size: number, write = false): AccessResult {
    const k = this.shadow(a);
    const at = shadowAddr(a);
    const signed = k >= 128 ? k - 256 : k;
    const bad = k !== 0 && ((a & 7) + size - 1 >= signed || signed < 0);
    const inChunk = this.chunks.find((c) => a >= c.start && a < c.start + c.chunk)?.id;
    if (!bad) return { report: null, shadowByte: k, shadowAt: at, inChunk };
    const kind = k === SHADOW.freed ? "heap-use-after-free" : "heap-buffer-overflow";
    return { report: { kind, access: `${write ? "WRITE" : "READ"} of size ${size} at ${hex(a)}`, where: this.describe(a), shadowByte: k, shadowAt: at }, shadowByte: k, shadowAt: at, inChunk };
  }

  /** Where an address is, relative to the nearest chunk with user bytes, in ASan's words. */
  describe(a: number): string {
    let best: Chunk | undefined;
    let dist = Infinity;
    for (const c of this.chunks) {
      if (c.state === "available") continue;
      const d = a < c.user ? c.user - a : a >= c.user + c.size ? a - (c.user + c.size) + 1 : 0;
      if (d < dist) { dist = d; best = c; }
    }
    if (!best) return `${hex(a)} is not near any heap region`;
    const c = best;
    if (a >= c.user && a < c.user + c.size) return `${hex(a)} is located ${a - c.user} bytes inside of ${c.size}-byte region ${this.range(c)}`;
    if (a >= c.user + c.size) return `${hex(a)} is located ${a - c.user - c.size} bytes after ${c.size}-byte region ${this.range(c)}`;
    return `${hex(a)} is located ${c.user - a} bytes before ${c.size}-byte region ${this.range(c)}`;
  }

  /** Granules from `from` for `n` granules, with their shadow bytes, for display. */
  granules(from: number, n: number): { addr: number; shadow: number; chunk?: number; user: boolean }[] {
    return Array.from({ length: n }, (_, i) => {
      const addr = from + i * GRANULE;
      const c = this.chunks.find((x) => addr >= x.start && addr < x.start + x.chunk);
      return { addr, shadow: this.shadow(addr), chunk: c?.id, user: !!c && addr >= c.user && addr < c.user + c.size };
    });
  }
}

/** The shadow byte as two hex digits. */
export const shadowHex = (k: number) => k.toString(16).padStart(2, "0");

// ---------------------------------------------------------------- HWASan, for comparison

/** HWASan: 16-byte granules, an 8-bit tag in the pointer's top byte (AArch64 top-byte ignore). */
export const HWASAN_GRANULE = 16;
export const HWASAN_TAG_BITS = 8;
/** Probability that a stale or wild pointer's tag matches the memory tag by chance: 1 / 2⁸. */
export const hwasanMissProbability = () => 1 / 2 ** HWASAN_TAG_BITS;
/** Shadow memory relative to the application: 1 byte per 16 (HWASan) vs 1 byte per 8 (ASan). */
export const shadowRatio = { asan: 1 / GRANULE, hwasan: 1 / HWASAN_GRANULE };
