/**
 * Block allocation and file mapping.
 *
 * - `BlockBitmap`: the free-space bitmap, with goal-directed search for one block or a run.
 * - `IndirectMap`: the ext2 tree of 12 direct pointers and single, double and triple indirect blocks.
 * - `ExtentMap`: sorted (logical, physical, length) runs, as ext4 stores them, with the size of the tree they need.
 * - `AllocSim`: files grow and get deleted on a shared block grid, under immediate, delayed or preallocated allocation.
 * - `maxFileSize`, `ext4Limits`, `fragReadCost`: the arithmetic that the lesson quotes.
 */
import { mulberry32, type Rng } from "../../rng";
import { HDDS, SSD_NVME, hddAccess, ssdReadUs } from "../../db/storage/disk";

/** Groups in one flex_bg by default: their metadata sits together, so long extents can cross group boundaries. */
export const FLEX_BG_GROUPS = 16;

export class BlockBitmap {
  readonly bits: Uint8Array;
  private used = 0;
  constructor(readonly size: number) { this.bits = new Uint8Array(size); }
  get free() { return this.size - this.used; }
  isFree(b: number) { return this.bits[b] === 0; }
  set(b: number) { if (this.bits[b]) throw new Error(`block ${b} is in use`); this.bits[b] = 1; this.used++; }
  clear(b: number) { if (!this.bits[b]) throw new Error(`block ${b} is free`); this.bits[b] = 0; this.used--; }

  /** One block: the goal if it is free, or else the next free block after it, wrapping round. */
  allocNear(goal: number): number {
    for (let i = 0; i < this.size; i++) {
      const b = (goal + i) % this.size;
      if (!this.bits[b]) { this.set(b); return b; }
    }
    return -1;
  }

  /** All maximal free runs, in disk order. */
  freeRuns(): { start: number; len: number }[] {
    const out: { start: number; len: number }[] = [];
    for (let i = 0; i < this.size; i++) {
      if (this.bits[i]) continue;
      let j = i;
      while (j < this.size && !this.bits[j]) j++;
      out.push({ start: i, len: j - i });
      i = j;
    }
    return out;
  }

  /**
   * Finds space for n blocks, as few runs as it can. It takes the first run at or after the goal that fits, and when no
   * run fits, it takes the largest runs. This is the spirit of mballoc, without its buddy data.
   */
  allocRuns(goal: number, n: number): { start: number; len: number }[] {
    const out: { start: number; len: number }[] = [];
    let left = Math.min(n, this.free);
    while (left > 0) {
      const runs = this.freeRuns();
      const fit = runs.find((r) => r.start >= goal && r.len >= left) ?? runs.find((r) => r.len >= left);
      const r = fit ?? runs.reduce((a, b) => (b.len > a.len ? b : a));
      const take = Math.min(r.len, left);
      for (let i = 0; i < take; i++) this.set(r.start + i);
      out.push({ start: r.start, len: take });
      left -= take;
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------- the indirect tree

export interface IndirectSpec { blockSize: number; ptrBytes: number; direct: number; levels: number }
export const EXT2_SPEC: IndirectSpec = { blockSize: 4096, ptrBytes: 4, direct: 12, levels: 3 };

export const ptrsPerBlock = (s: IndirectSpec) => Math.floor(s.blockSize / s.ptrBytes);

/** How many data blocks each part of the tree reaches, and the total. */
export function maxFileSize(s: IndirectSpec) {
  const p = ptrsPerBlock(s);
  const perLevel = [s.direct];
  for (let l = 1; l <= s.levels; l++) perLevel.push(Math.pow(p, l));
  const maxBlocks = perLevel.reduce((a, b) => a + b, 0);
  return { ptrs: p, perLevel, maxBlocks, maxBytes: maxBlocks * s.blockSize };
}

/** ext2 counts a file's space in i_blocks, 32 bits in units of 512 bytes. This caps a file, whatever the tree reaches. */
export const I_BLOCKS_CAP_BYTES = Math.pow(2, 32) * 512;

/** ext2 limits for a block size: the tree alone, and the tree with the i_blocks cap. */
export function ext2Limit(blockSize: number) {
  const tree = maxFileSize({ ...EXT2_SPEC, blockSize }).maxBytes;
  return { tree, limit: Math.min(tree, I_BLOCKS_CAP_BYTES) };
}

/** Indirect blocks that a file of n data blocks needs, by level, when no part of it is a hole. */
export function indirectMeta(n: number, s: IndirectSpec = EXT2_SPEC) {
  const p = ptrsPerBlock(s);
  let left = Math.max(0, n - s.direct);
  let meta = 0;
  const byTree: number[] = [];
  for (let l = 1; l <= s.levels && left > 0; l++) {
    const reach = Math.pow(p, l);
    const here = Math.min(left, reach);
    // Blocks at each height of this subtree: ceil(here / p^h) for h = 1..l.
    let count = 0;
    for (let h = 1; h <= l; h++) count += Math.ceil(here / Math.pow(p, h));
    byTree.push(count);
    meta += count;
    left -= here;
  }
  return { metaBlocks: meta, byTree, fits: left === 0, metaBytes: meta * s.blockSize, overhead: n > 0 ? meta / n : 0 };
}

/** A real pointer tree. It maps a logical block to a physical one and allocates indirect blocks as it needs them. */
export class IndirectMap {
  readonly direct: (number | undefined)[] = [];
  private roots: (Map<number, unknown> | undefined)[] = [];
  metaBlocks = 0;
  readonly p: number;
  constructor(readonly spec: IndirectSpec = EXT2_SPEC) { this.p = ptrsPerBlock(spec); }

  /** The path of slots to a logical block: [level, slot at each height]. Level 0 is a direct pointer. */
  pathOf(logical: number): number[] | null {
    if (logical < this.spec.direct) return [0, logical];
    let left = logical - this.spec.direct;
    for (let l = 1; l <= this.spec.levels; l++) {
      const reach = Math.pow(this.p, l);
      if (left < reach) {
        const path = [l];
        for (let h = l - 1; h >= 0; h--) path.push(Math.floor(left / Math.pow(this.p, h)) % this.p);
        return path;
      }
      left -= reach;
    }
    return null;
  }

  set(logical: number, physical: number): boolean {
    const path = this.pathOf(logical);
    if (!path) return false;
    if (path[0] === 0) { this.direct[path[1]!] = physical; return true; }
    const l = path[0]!;
    let node = this.roots[l];
    if (!node) { node = new Map(); this.roots[l] = node; this.metaBlocks++; }
    for (let i = 1; i < path.length - 1; i++) {
      let next = node.get(path[i]!) as Map<number, unknown> | undefined;
      if (!next) { next = new Map(); node.set(path[i]!, next); this.metaBlocks++; }
      node = next;
    }
    node.set(path[path.length - 1]!, physical);
    return true;
  }

  /** Returns the physical block, undefined for a hole, and the number of indirect blocks that the read touched. */
  get(logical: number): { physical: number | undefined; reads: number } {
    const path = this.pathOf(logical);
    if (!path) return { physical: undefined, reads: 0 };
    if (path[0] === 0) return { physical: this.direct[path[1]!], reads: 0 };
    let node = this.roots[path[0]!];
    let reads = 0;
    for (let i = 1; node && i < path.length; i++) {
      reads++;
      const v = node.get(path[i]!);
      if (i === path.length - 1) return { physical: v as number | undefined, reads };
      node = v as Map<number, unknown> | undefined;
    }
    return { physical: undefined, reads };
  }
}

// ------------------------------------------------------------------------------------------- extents

export interface Extent { logical: number; physical: number; len: number; unwritten?: boolean }

/** ext4 on-disk sizes (fs/ext4/ext4_extents.h). */
export const EXT4_EXTENT = {
  headerBytes: 12,
  entryBytes: 12,
  iBlockBytes: 60,
  /** Blocks in one initialized extent: the top bit of the 16-bit length marks an unwritten extent. */
  maxInitLen: 32768,
  maxUnwrittenLen: 32767,
  tailBytes: 4,
  maxDepth: 5,
};

export function extentFanout(blockSize: number) {
  const inInode = Math.floor((EXT4_EXTENT.iBlockBytes - EXT4_EXTENT.headerBytes) / EXT4_EXTENT.entryBytes);
  const inBlock = Math.floor((blockSize - EXT4_EXTENT.headerBytes - EXT4_EXTENT.tailBytes) / EXT4_EXTENT.entryBytes);
  return { inInode, inBlock };
}

/** Depth and tree blocks for n extents. Depth 0 means that all extents fit in the inode. */
export function extentTreeMeta(n: number, blockSize = 4096) {
  const { inInode, inBlock } = extentFanout(blockSize);
  if (n <= inInode) return { depth: 0, metaBlocks: 0, metaBytes: 0 };
  let level = Math.ceil(n / inBlock);
  let meta = level;
  let depth = 1;
  while (level > inInode) {
    level = Math.ceil(level / inBlock);
    meta += level;
    depth++;
  }
  return { depth, metaBlocks: meta, metaBytes: meta * blockSize };
}

export function ext4Limits(blockSize = 4096) {
  const { inInode, inBlock } = extentFanout(blockSize);
  return {
    inInode, inBlock,
    /** Logical block numbers are 32 bits. */
    maxFileBytes: Math.pow(2, 32) * blockSize,
    /** Physical block numbers are 48 bits. */
    maxVolumeBytes: Math.pow(2, 48) * blockSize,
    maxExtentBytes: EXT4_EXTENT.maxInitLen * blockSize,
    /** One extent per block is the worst case. This is the tree that the worst case needs for a file of that many blocks. */
    extentsAtDepth1: inInode * inBlock,
  };
}

/** Extent-mapped file: sorted runs, merged when they touch. Lookup is a binary search. */
export class ExtentMap {
  readonly extents: Extent[] = [];
  constructor(readonly maxLen = EXT4_EXTENT.maxInitLen) {}
  private find(logical: number): number {
    let lo = 0, hi = this.extents.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.extents[mid]!.logical <= logical) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  get(logical: number): number | undefined {
    const i = this.find(logical);
    if (i < 0) return undefined;
    const e = this.extents[i]!;
    return logical < e.logical + e.len ? e.physical + (logical - e.logical) : undefined;
  }
  /** Adds one mapping for a logical block with no mapping yet. */
  set(logical: number, physical: number) {
    const i = this.find(logical);
    const prev = this.extents[i];
    if (prev && logical < prev.logical + prev.len) throw new Error(`logical ${logical} is already mapped`);
    const next = this.extents[i + 1];
    const joinPrev = prev && prev.logical + prev.len === logical && prev.physical + prev.len === physical && prev.len < this.maxLen;
    const joinNext = next && logical + 1 === next.logical && physical + 1 === next.physical && next.len < this.maxLen;
    if (joinPrev && joinNext && prev.len + next.len + 1 <= this.maxLen) {
      prev.len += next.len + 1;
      this.extents.splice(i + 1, 1);
    } else if (joinPrev) prev.len++;
    else if (joinNext) { next.logical--; next.physical--; next.len++; }
    else this.extents.splice(i + 1, 0, { logical, physical, len: 1 });
  }
}

/** The extents of a block list. A run longer than the extent limit needs several extents. */
export function extentsOf(blocks: readonly number[], maxLen = EXT4_EXTENT.maxInitLen): number {
  let n = 0, run = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0 && blocks[i] === blocks[i - 1]! + 1 && run < maxLen) run++;
    else { n++; run = 1; }
  }
  return n;
}

/** Mapping metadata in bytes for one file of n contiguous blocks: the best case for extents. */
export function mappingCompare(fileBytes: number, fragments: number, s: IndirectSpec = EXT2_SPEC) {
  const n = Math.ceil(fileBytes / s.blockSize);
  const ind = indirectMeta(n, s);
  const extents = Math.max(fragments, Math.ceil(n / EXT4_EXTENT.maxInitLen));
  const ext = extentTreeMeta(extents, s.blockSize);
  return { blocks: n, indirectBytes: ind.metaBytes, indirectOverhead: n ? ind.metaBytes / fileBytes : 0, extents, extentBytes: ext.metaBytes, extentDepth: ext.depth, extentOverhead: n ? ext.metaBytes / fileBytes : 0 };
}

// ------------------------------------------------------------------------------------------- the allocation simulator

export type AllocPolicy = "immediate" | "delayed" | "prealloc";
export const POLICY_LABEL: Record<AllocPolicy, string> = { immediate: "Allocate at write", delayed: "Delayed allocation", prealloc: "fallocate first" };

export interface AllocSimOpts {
  blocks: number;
  policy: AllocPolicy;
  /** Files that grow at the same time. */
  writers: number;
  /** Blocks each writer appends per round. */
  chunk: number;
  /** A file stops growing at a size in this range. */
  minFile: number;
  maxFile: number;
  /** Delayed allocation: rounds between flushes. */
  flushEvery: number;
  /** Delete old files when the disk is this full. */
  targetFill: number;
  seed: number;
}

export const ALLOC_DEFAULTS: AllocSimOpts = { blocks: 640, policy: "immediate", writers: 3, chunk: 2, minFile: 12, maxFile: 48, flushEvery: 8, targetFill: 0.7, seed: 7 };

export interface SimFile { id: number; blocks: number[]; target: number; pending: number; reserved: number[]; done: boolean; color: number }

export interface AllocMetrics {
  files: number;
  usedBlocks: number;
  freeBlocks: number;
  /** Mean number of contiguous pieces per file. */
  meanFragments: number;
  /** Blocks that indirect pointers need across all files. */
  indirectMeta: number;
  /** Pointer bytes if each file used a flat list of pointers. */
  pointerBytes: number;
  extents: number;
  extentMetaBytes: number;
  freeRuns: number;
  largestFree: number;
  /** One minus largest free run over free blocks. */
  freeFragmentation: number;
}

/** Files grow in rounds, and when the disk gets full the oldest finished file goes away. */
export class AllocSim {
  readonly bitmap: BlockBitmap;
  readonly files: SimFile[] = [];
  readonly owner: Int32Array;
  private rng: Rng;
  private nextId = 1;
  rounds = 0;
  deleted = 0;
  private cursor = 0;
  constructor(readonly o: AllocSimOpts) {
    this.bitmap = new BlockBitmap(o.blocks);
    this.owner = new Int32Array(o.blocks);
    this.rng = mulberry32(o.seed);
  }

  private newFile(): SimFile {
    const { minFile, maxFile, policy } = this.o;
    const target = minFile + Math.floor(this.rng() * (maxFile - minFile + 1));
    const f: SimFile = { id: this.nextId++, blocks: [], target, pending: 0, reserved: [], done: false, color: (this.nextId - 2) % 5 };
    this.files.push(f);
    if (policy === "prealloc") {
      for (const r of this.bitmap.allocRuns(this.cursor, target)) {
        for (let i = 0; i < r.len; i++) { f.reserved.push(r.start + i); this.owner[r.start + i] = f.id; }
        this.cursor = r.start + r.len;
      }
    }
    return f;
  }

  private place(f: SimFile, n: number) {
    if (n <= 0) return;
    const { policy } = this.o;
    if (policy === "immediate") {
      for (let i = 0; i < n; i++) {
        const last = f.blocks[f.blocks.length - 1];
        const b = this.bitmap.allocNear(last !== undefined ? last + 1 : 0);
        if (b < 0) return;
        f.blocks.push(b);
        this.owner[b] = f.id;
      }
    } else if (policy === "delayed") {
      const last = f.blocks[f.blocks.length - 1];
      for (const r of this.bitmap.allocRuns(last !== undefined ? last + 1 : this.cursor, n)) {
        for (let i = 0; i < r.len; i++) { f.blocks.push(r.start + i); this.owner[r.start + i] = f.id; }
        this.cursor = r.start + r.len;
      }
    } else {
      for (let i = 0; i < n && f.reserved.length; i++) f.blocks.push(f.reserved.shift()!);
    }
  }

  private flush(f: SimFile) { this.place(f, f.pending); f.pending = 0; }

  deleteFile(f: SimFile) {
    this.flush(f);
    for (const b of [...f.blocks, ...f.reserved]) { this.bitmap.clear(b); this.owner[b] = 0; }
    this.files.splice(this.files.indexOf(f), 1);
    this.deleted++;
  }

  /** One round: every writer appends, full files close, and old files go when the disk is too full. */
  step() {
    const { writers, chunk, policy, flushEvery, targetFill, blocks } = this.o;
    this.rounds++;
    let active = this.files.filter((f) => !f.done);
    while (active.length < writers) active = [...active, this.newFile()];
    for (const f of active) {
      const n = Math.min(chunk, f.target - f.blocks.length - f.pending);
      if (policy === "delayed") f.pending += n;
      else this.place(f, n);
      if (f.blocks.length + f.pending >= f.target) {
        f.done = true;
        this.flush(f); // close, or the flusher, forces the allocation
      }
    }
    if (policy === "delayed" && this.rounds % flushEvery === 0) for (const f of this.files) this.flush(f);
    while (this.bitmap.size - this.bitmap.free > targetFill * blocks) {
      const old = this.files.find((f) => f.done);
      if (!old) break;
      this.deleteFile(old);
    }
  }

  run(rounds: number) { for (let i = 0; i < rounds; i++) this.step(); return this; }

  metrics(): AllocMetrics {
    const done = this.files.filter((f) => f.blocks.length > 0);
    let frags = 0, ind = 0, ptr = 0, ext = 0, extMeta = 0;
    for (const f of done) {
      const e = extentsOf(f.blocks);
      frags += e;
      ext += e;
      extMeta += extentTreeMeta(e).metaBytes;
      ind += indirectMeta(f.blocks.length).metaBlocks;
      ptr += f.blocks.length * EXT2_SPEC.ptrBytes;
    }
    const runs = this.bitmap.freeRuns();
    const largest = runs.reduce((a, r) => Math.max(a, r.len), 0);
    return {
      files: this.files.length,
      usedBlocks: this.bitmap.size - this.bitmap.free,
      freeBlocks: this.bitmap.free,
      meanFragments: done.length ? frags / done.length : 0,
      indirectMeta: ind,
      pointerBytes: ptr,
      extents: ext,
      extentMetaBytes: extMeta,
      freeRuns: runs.length,
      largestFree: largest,
      freeFragmentation: this.bitmap.free ? 1 - largest / this.bitmap.free : 0,
    };
  }

  /** Every block belongs to one file, or it is free. Returns each broken rule. */
  check(): string[] {
    const bad: string[] = [];
    const seen = new Map<number, number>();
    for (const f of this.files) {
      for (const b of [...f.blocks, ...f.reserved]) {
        if (seen.has(b)) bad.push(`block ${b} in files ${seen.get(b)} and ${f.id}`);
        seen.set(b, f.id);
        if (this.bitmap.isFree(b)) bad.push(`block ${b} of file ${f.id} is free in the bitmap`);
      }
    }
    if (seen.size !== this.bitmap.size - this.bitmap.free) bad.push(`files hold ${seen.size} blocks, the bitmap says ${this.bitmap.size - this.bitmap.free}`);
    return bad;
  }
}

/** The cost of a sequential read of a file in pieces, on the model drives of the databases track. */
export function fragReadCost(bytes: number, fragments: number) {
  const hdd = HDDS["7200"];
  const position = hddAccess(hdd, 0, "random").total; // seek + half a turn, in ms
  const hddMs = fragments * position + (bytes / (hdd.mbps * 1e6)) * 1e3;
  const ssdUsPerReq = ssdReadUs(SSD_NVME, 4096);
  const ssdUs = fragments * ssdUsPerReq + (bytes / (SSD_NVME.mbps * 1e6)) * 1e6;
  return { hddMs, ssdMs: ssdUs / 1e3, positionMs: position, ssdRequestUs: ssdUsPerReq };
}
