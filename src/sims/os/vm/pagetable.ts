/**
 * A real x86-64 style radix page table. Each table is 512 64-bit entries in a page of table memory;
 * entries use the architectural bit positions; the walker follows them exactly as the hardware does and
 * records one event for each memory read.
 */
import { LEVEL_BITS, LEVEL_NAMES, PAGE_SHIFT, PAGE_SIZE, ENTRIES_PER_TABLE, PTE_BYTES, SIZE_1G, SIZE_2M, entrySpan, isCanonical, splitVa, toU64, type Levels } from "./addr";

/** Architectural PTE bits. */
export const PTE = {
  P: 1n, RW: 1n << 1n, US: 1n << 2n, PWT: 1n << 3n, PCD: 1n << 4n, A: 1n << 5n, D: 1n << 6n, PS: 1n << 7n, G: 1n << 8n, NX: 1n << 63n,
} as const;
const ADDR_MASK = 0x000f_ffff_ffff_f000n;

export const PTE_BIT_INFO: { bit: keyof typeof PTE; pos: number; name: string; meaning: string }[] = [
  { bit: "P", pos: 0, name: "Present", meaning: "The entry is valid. If it is clear, the CPU raises a page fault." },
  { bit: "RW", pos: 1, name: "Writable", meaning: "Writes are allowed. All levels on the path must allow it." },
  { bit: "US", pos: 2, name: "User", meaning: "User mode can use this page. All levels on the path must allow it." },
  { bit: "A", pos: 5, name: "Accessed", meaning: "The CPU sets it on use. Page replacement reads and clears it." },
  { bit: "D", pos: 6, name: "Dirty", meaning: "The CPU sets it on a write. The page must go to disk before reuse." },
  { bit: "PS", pos: 7, name: "Page size", meaning: "In a PD or PDPT entry: this entry is a 2 MiB or 1 GiB leaf." },
  { bit: "G", pos: 8, name: "Global", meaning: "The TLB keeps this entry across a CR3 load." },
  { bit: "NX", pos: 63, name: "No execute", meaning: "Instruction fetch from this page raises a fault." },
];

export const makeEntry = (pfn: number, flags: bigint) => (BigInt(pfn) << 12n) | flags;
export const entryPfn = (e: bigint) => Number((e & ADDR_MASK) >> 12n);
export const has = (e: bigint, f: bigint) => (e & f) !== 0n;

/** Page fault error code bits, as the CPU pushes them. */
export const PF = { P: 1, W: 2, U: 4, RSVD: 8, I: 16 } as const;
export function describeErrorCode(code: number): string {
  return [code & PF.P ? "protection violation" : "page not present", code & PF.W ? "write" : "read", code & PF.U ? "user mode" : "kernel mode", ...(code & PF.I ? ["instruction fetch"] : [])].join(", ");
}

/** Physical memory that holds page tables. Several address spaces can share one. */
export class TableMem {
  private pages = new Map<number, BigUint64Array>();
  private freeList: number[] = [];
  private next: number;
  constructor(firstPfn = 0x1000) { this.next = firstPfn; }
  alloc(): number {
    const pfn = this.freeList.pop() ?? this.next++;
    this.pages.set(pfn, new BigUint64Array(ENTRIES_PER_TABLE));
    return pfn;
  }
  free(pfn: number) {
    if (!this.pages.delete(pfn)) throw new Error(`free of a table page that is not allocated: ${pfn}`);
    this.freeList.push(pfn);
  }
  read(pfn: number, i: number): bigint { return this.pages.get(pfn)![i]!; }
  write(pfn: number, i: number, v: bigint) { this.pages.get(pfn)![i] = v; }
  /** Table pages allocated now. */
  get count() { return this.pages.size; }
  get bytes() { return this.pages.size * PAGE_SIZE; }
}

export type AccessKind = "r" | "w" | "x";
export interface Access { kind?: AccessKind; user?: boolean }

export interface MapOpts {
  writable?: boolean;
  user?: boolean;
  nx?: boolean;
  global?: boolean;
  /** Leaf size: 4 KiB (default), 2 MiB or 1 GiB. */
  size?: number;
}

/** One memory read by the walker. */
export interface WalkEvent {
  /** 0 = top level. */
  level: number;
  name: string;
  tablePfn: number;
  index: number;
  /** Physical address of the entry that the CPU read. */
  entryPa: bigint;
  entry: bigint;
  present: boolean;
  /** This entry ends the walk: a 4 KiB PTE or an entry with the PS bit. */
  leaf: boolean;
}

export interface WalkFault {
  /** "non-canonical" raises #GP, not #PF. */
  reason: "not-present" | "protection" | "non-canonical";
  /** The x86 page fault error code. */
  code: number;
  level: number;
}

export interface WalkResult {
  ok: boolean;
  va: bigint;
  /** The translated physical address when ok. */
  pa?: bigint;
  /** The first 4 KiB frame number of the leaf, plus the offset inside a huge leaf. */
  pfn?: number;
  pageShift?: number;
  writable: boolean;
  user: boolean;
  nx: boolean;
  global: boolean;
  /** One event per memory read. */
  events: WalkEvent[];
  fault?: WalkFault;
}

const LEAF_LEVEL_FOR_SIZE = (size: number, levels: Levels): number => {
  if (size === PAGE_SIZE) return levels - 1;
  if (size === SIZE_2M) return levels - 2;
  if (size === SIZE_1G) return levels - 3;
  throw new Error(`unsupported page size ${size}`);
};

export interface TableNode { pfn: number; level: number; name: string; /** Indices from the root to this table. */ path: number[]; used: number[]; /** used indices whose entry is a leaf. */ leaves: number[] }

export class PageTable {
  readonly levels: Levels;
  readonly mem: TableMem;
  /** The value that CR3 holds: the frame of the top table. */
  readonly root: number;
  /** Live entries in each table, so an empty table can be freed without a scan. */
  private used = new Map<number, number>();
  private ownPages = 1;

  constructor(opts: { levels?: Levels; mem?: TableMem } = {}) {
    this.levels = opts.levels ?? 4;
    this.mem = opts.mem ?? new TableMem();
    this.root = this.mem.alloc();
    this.used.set(this.root, 0);
  }

  /** Table pages that belong to this address space, top table included. */
  get tablePages() { return this.ownPages; }
  get tableBytes() { return this.ownPages * PAGE_SIZE; }

  private descend(va: bigint, leafLevel: number, create: boolean, user: boolean): { table: number; index: number } | null {
    const { indices } = splitVa(va, this.levels);
    let table = this.root;
    for (let l = 0; l < leafLevel; l++) {
      const i = indices[l]!;
      const e = this.mem.read(table, i);
      if (!has(e, PTE.P)) {
        if (e !== 0n) throw new Error("not-present non-leaf entry with content");
        if (!create) return null;
        const child = this.mem.alloc();
        this.ownPages++;
        this.used.set(child, 0);
        this.mem.write(table, i, makeEntry(child, PTE.P | PTE.RW | (user ? PTE.US : 0n)));
        this.used.set(table, this.used.get(table)! + 1);
        table = child;
      } else {
        if (has(e, PTE.PS)) { if (create) throw new Error("range is already mapped by a huge page"); return null; }
        if (create && user && !has(e, PTE.US)) this.mem.write(table, i, e | PTE.US);
        table = entryPfn(e);
      }
    }
    return { table, index: indices[leafLevel]! };
  }

  /** Maps one page. Throws when the slot is taken, because a real kernel must unmap first. */
  map(va: bigint | number, pfn: number, opts: MapOpts = {}) {
    const size = opts.size ?? PAGE_SIZE;
    const leafLevel = LEAF_LEVEL_FOR_SIZE(size, this.levels);
    const v = toU64(va);
    if (v & BigInt(size - 1)) throw new Error("virtual address is not aligned to the page size");
    if (size > PAGE_SIZE && pfn % (size / PAGE_SIZE) !== 0) throw new Error("frame is not aligned to the page size");
    const user = opts.user ?? true;
    const flags = PTE.P | (opts.writable ? PTE.RW : 0n) | (user ? PTE.US : 0n) | (opts.nx ? PTE.NX : 0n) | (opts.global ? PTE.G : 0n) | (size > PAGE_SIZE ? PTE.PS : 0n);
    this.setLeaf(v, makeEntry(pfn, flags), leafLevel, user);
  }

  /** Stores a raw leaf entry, for example a not-present swap entry. Throws if the slot is not empty. */
  setLeaf(va: bigint | number, entry: bigint, leafLevel = this.levels - 1, user = true) {
    const { table, index } = this.descend(toU64(va), leafLevel, true, user)!;
    if (this.mem.read(table, index) !== 0n) throw new Error("slot is already mapped");
    this.mem.write(table, index, entry);
    this.used.set(table, this.used.get(table)! + 1);
  }

  /** The raw leaf entry for this address (4 KiB or huge), or 0n. Reads no memory in the model and sets no bits. */
  leaf(va: bigint | number): { entry: bigint; level: number; table: number; index: number } | null {
    const { indices } = splitVa(va, this.levels);
    let table = this.root;
    for (let l = 0; l < this.levels; l++) {
      const i = indices[l]!;
      const e = this.mem.read(table, i);
      if (l === this.levels - 1 || !has(e, PTE.P) || has(e, PTE.PS)) return e === 0n ? null : { entry: e, level: l, table, index: i };
      table = entryPfn(e);
    }
    return null;
  }

  /** Replaces flags in place on an existing leaf. The caller must invalidate the TLB. */
  updateLeaf(va: bigint | number, f: (e: bigint) => bigint) {
    const l = this.leaf(va);
    if (!l) throw new Error("no entry to update");
    this.mem.write(l.table, l.index, f(l.entry));
  }

  /** Clears the leaf for this address and frees tables that become empty. Returns the old entry or null. */
  unmap(va: bigint | number): bigint | null {
    const { indices } = splitVa(va, this.levels);
    const path: { table: number; index: number }[] = [];
    let table = this.root;
    for (let l = 0; l < this.levels; l++) {
      const i = indices[l]!;
      path.push({ table, index: i });
      const e = this.mem.read(table, i);
      if (e === 0n) return null;
      if (l === this.levels - 1 || !has(e, PTE.P) || has(e, PTE.PS)) {
        this.mem.write(table, i, 0n);
        this.used.set(table, this.used.get(table)! - 1);
        for (let k = l; k > 0 && this.used.get(path[k]!.table) === 0; k--) {
          this.mem.free(path[k]!.table);
          this.used.delete(path[k]!.table);
          this.ownPages--;
          this.mem.write(path[k - 1]!.table, path[k - 1]!.index, 0n);
          this.used.set(path[k - 1]!.table, this.used.get(path[k - 1]!.table)! - 1);
        }
        return e;
      }
      table = entryPfn(e);
    }
    return null;
  }

  /**
   * The hardware walk. Effective rights are the AND of RW and US across all levels and the OR of NX.
   * A successful walk sets A at every level and D on the leaf for a write, unless `readOnly` is set.
   */
  walk(va: bigint | number, access: Access = {}, opts: { readOnly?: boolean } = {}): WalkResult {
    const v = toU64(va);
    const kind = access.kind ?? "r";
    const isUser = access.user ?? true;
    const names = LEVEL_NAMES[this.levels];
    const code = (present: boolean) => (present ? PF.P : 0) | (kind === "w" ? PF.W : 0) | (isUser ? PF.U : 0) | (kind === "x" ? PF.I : 0);
    const base = { va: v, writable: true, user: true, nx: false, global: false, events: [] as WalkEvent[] };
    if (!isCanonical(v, this.levels)) return { ...base, ok: false, writable: false, user: false, fault: { reason: "non-canonical", code: 0, level: 0 } };
    const { indices } = splitVa(v, this.levels);
    const events = base.events;
    let table = this.root;
    let writable = true, user = true, nx = false;
    const touched: { table: number; index: number; e: bigint }[] = [];
    for (let l = 0; l < this.levels; l++) {
      const i = indices[l]!;
      const e = this.mem.read(table, i);
      const present = has(e, PTE.P);
      const leaf = present && (l === this.levels - 1 || has(e, PTE.PS));
      events.push({ level: l, name: names[l]!, tablePfn: table, index: i, entryPa: (BigInt(table) << 12n) + BigInt(i * PTE_BYTES), entry: e, present, leaf });
      if (!present) return { ...base, ok: false, writable: false, user: false, fault: { reason: "not-present", code: code(false), level: l } };
      touched.push({ table, index: i, e });
      writable &&= has(e, PTE.RW);
      user &&= has(e, PTE.US);
      nx ||= has(e, PTE.NX);
      if (leaf) {
        const denied = (isUser && !user) || (kind === "w" && !writable) || (kind === "x" && nx);
        if (denied) return { ...base, ok: false, writable, user, nx, fault: { reason: "protection", code: code(true), level: l } };
        if (!opts.readOnly) {
          for (const t of touched) this.mem.write(t.table, t.index, t.e | PTE.A);
          if (kind === "w") this.mem.write(table, i, this.mem.read(table, i) | PTE.D);
        }
        const pageShift = PAGE_SHIFT + LEVEL_BITS * (this.levels - 1 - l);
        const pageMask = (1n << BigInt(pageShift)) - 1n;
        const frameBase = BigInt(entryPfn(e)) << 12n;
        return { ...base, ok: true, pa: frameBase + (v & pageMask), pfn: entryPfn(e), pageShift, writable, user, nx, global: has(e, PTE.G), events };
      }
      table = entryPfn(e);
    }
    throw new Error("unreachable");
  }

  /** Every table in the tree, for views and tests. Top table first. */
  nodes(): TableNode[] {
    const names = LEVEL_NAMES[this.levels];
    const out: TableNode[] = [];
    const visit = (pfn: number, level: number, path: number[]) => {
      const used: number[] = [], leaves: number[] = [];
      const children: [number, number][] = [];
      for (let i = 0; i < ENTRIES_PER_TABLE; i++) {
        const e = this.mem.read(pfn, i);
        if (e === 0n) continue;
        used.push(i);
        if (level === this.levels - 1 || !has(e, PTE.P) || has(e, PTE.PS)) leaves.push(i);
        else children.push([i, entryPfn(e)]);
      }
      out.push({ pfn, level, name: names[level]!, path, used, leaves });
      for (const [i, c] of children) visit(c, level + 1, [...path, i]);
    };
    visit(this.root, 0, []);
    return out;
  }
}

// ---------------- table memory arithmetic ----------------

export interface TableCount { perLevel: number[]; tables: number; bytes: number; /** bytes of tables / bytes mapped */ overhead: number }

/**
 * Exact table count for n pages mapped at a fixed stride starting at address 0, without building the tree.
 * A level's table count is the number of distinct ranges that the addresses fall into.
 */
export function tablesForStride(n: number, strideBytes: number, opts: { levels?: Levels; leafSize?: number } = {}): TableCount {
  const levels = opts.levels ?? 4;
  const leafSize = opts.leafSize ?? PAGE_SIZE;
  const leafLevel = LEAF_LEVEL_FOR_SIZE(leafSize, levels);
  const perLevel: number[] = [];
  for (let l = 0; l <= leafLevel; l++) {
    // A table at level l covers the span of its parent's entry.
    const span = 2 ** (PAGE_SHIFT + LEVEL_BITS * (levels - l));
    perLevel.push(n === 0 ? (l === 0 ? 1 : 0) : Math.min(n, Math.floor(((n - 1) * strideBytes) / span) + 1));
  }
  const tables = perLevel.reduce((a, b) => a + b, 0);
  return { perLevel, tables, bytes: tables * PAGE_SIZE, overhead: n > 0 ? (tables * PAGE_SIZE) / (n * leafSize) : 0 };
}

/** What each level of the tree maps, for tables and labels. */
export const levelReach = (levels: Levels = 4) => LEVEL_NAMES[levels].map((name, l) => ({ name, entryBytes: entrySpan(levels - 1 - l), tableBytes: entrySpan(levels - l) }));
