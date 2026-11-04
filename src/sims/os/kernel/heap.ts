/**
 * Kernel heap bring-up. The heap lives at a fixed virtual range, and pages arrive on demand from the frame allocator.
 * The page table is the real one from src/sims/os/vm, and its table frames come through an adapter.
 *
 * Two allocators: a bump pointer (allocextrasA.alignUp) and the free list (allocextrasA.FreeListSim).
 * Two sources for table frames: the frame allocator (correct), or the heap itself (the recursion hazard).
 */
import { FreeListSim, alignUp } from "../../allocextrasA";
import { ENTRIES_PER_TABLE, PAGE_SIZE, hexShort } from "../vm/addr";
import { PageTable, TableMem } from "../vm/pagetable";
import { PhysMem, UNMOVABLE } from "../vm/physmem";

export const HEAP_BASE = 0xffffc00000000000n;

/**
 * TableMem with its frames taken from elsewhere. PageTable uses only alloc, free, read and write, so this adapter
 * overrides all of them. It leaves the wave 1 class as it is.
 */
export class FrameTableMem extends TableMem {
  private store = new Map<number, BigUint64Array>();
  constructor(private source: { alloc(): number; free(pfn: number): void }) { super(); }
  override alloc(): number {
    const pfn = this.source.alloc();
    this.store.set(pfn, new BigUint64Array(ENTRIES_PER_TABLE));
    return pfn;
  }
  override free(pfn: number) {
    if (!this.store.delete(pfn)) throw new Error(`free of a table page that is not allocated: ${pfn}`);
    this.source.free(pfn);
  }
  override read(pfn: number, i: number): bigint { return this.store.get(pfn)![i]!; }
  override write(pfn: number, i: number, v: bigint) { this.store.get(pfn)![i] = v; }
  override get count() { return this.store.size; }
  override get bytes() { return this.store.size * PAGE_SIZE; }
}

export type HeapAlloc = "bump" | "list";
export type TableSource = "frames" | "heap";

export interface HeapOp { op: "alloc" | "free"; size?: number; tag: string; align?: number }

/** MODEL INPUT: the requests that the stepper runs. */
export const HEAP_SCRIPT: HeapOp[] = [
  { op: "alloc", size: 64, tag: "a" },
  { op: "alloc", size: 512, tag: "b" },
  { op: "alloc", size: 3600, tag: "c" },
  { op: "free", tag: "b" },
  { op: "alloc", size: 256, tag: "d" },
  { op: "alloc", size: 6000, tag: "e" },
];

export interface HeapSnap {
  title: string;
  text: string;
  /** The kernel's call stack at this step, outermost first. */
  calls: string[];
  mappedPages: number;
  dataFrames: number;
  tableFrames: number;
  top: number;
  blocks: { off: number; size: number; free: boolean; name: string }[];
  liveBytes: number;
  usedSpan: number;
  hazard: boolean;
  /** Frame numbers handed out so far, with their use. */
  frames: { pfn: number; use: "root" | "table" | "data" }[];
}

class HeapOverflow extends Error {}

/** MODEL INPUT: the depth at which the recursive path counts as a stack overflow. */
export const RECURSION_LIMIT = 8;
/** MODEL INPUT: frames that the kernel image and boot data hold before the heap starts. */
export const RESERVED_FRAMES = 16;

export class KernelHeap {
  readonly phys = new PhysMem(1);
  readonly mem: TableMem;
  readonly pt: PageTable;
  mappedPages = 0;
  top = 0;
  live = 0;
  private list: FreeListSim;
  private calls: string[] = [];
  private frameUse: { pfn: number; use: "root" | "table" | "data" }[] = [];
  private depth = 0;
  readonly snaps: HeapSnap[] = [];
  private addrOf = new Map<string, number>();
  hazard = false;
  private building = true;

  constructor(readonly alloc: HeapAlloc, readonly tables: TableSource) {
    this.list = new FreeListSim(0, "first", true);
    this.list.blocks = [];
    // The kernel image and boot data keep the first frames.
    for (let i = 0; i < RESERVED_FRAMES; i++) this.phys.allocSmall(UNMOVABLE);
    this.mem = new FrameTableMem({
      alloc: () => this.tableFrame(),
      free: (pfn) => this.phys.freeSmall(pfn),
    });
    // The top table exists before the heap: the boot code made it from a boot frame.
    this.pt = new PageTable({ mem: this.mem });
    this.building = false;
  }

  private tableFrame(): number {
    if (this.building || this.tables === "frames") {
      const f = this.phys.allocSmall(1);
      if (f < 0) throw new HeapOverflow("out of frames");
      this.frameUse.push({ pfn: f, use: this.building ? "root" : "table" });
      if (!this.building) this.say("Take a table frame", `The walk needs a new table. It takes frame ${f} straight from the frame allocator. This allocator never calls the heap, so the path ends.`, "alloc_frame()");
      return f;
    }
    // The hazard: the table comes from the heap, which may need a table.
    this.say("Table memory from kmalloc", "The walk needs a new table, and this kernel calls kmalloc(4096) for it.", "kmalloc(4096) for a table");
    const off = this.bumpOrList(PAGE_SIZE, PAGE_SIZE);
    return 0x100 + off / PAGE_SIZE;
  }

  private snap(title: string, text: string): void {
    const blocks = this.alloc === "list"
      ? this.list.blocks.map((b) => ({ off: b.off, size: b.size, free: b.free, name: b.name }))
      : [...this.bumpBlocks];
    this.snaps.push({
      title, text, calls: [...this.calls], mappedPages: this.mappedPages,
      dataFrames: this.frameUse.filter((f) => f.use === "data").length,
      tableFrames: this.frameUse.filter((f) => f.use !== "data").length,
      top: this.top, blocks, liveBytes: this.live, usedSpan: this.alloc === "bump" ? this.top : this.list.blocks.filter((b) => !b.free).reduce((m, b) => Math.max(m, b.off + b.size), 0),
      hazard: this.hazard, frames: [...this.frameUse],
    });
  }
  private say(title: string, text: string, call?: string) {
    if (call) this.calls.push(call);
    this.snap(title, text);
    if (call) this.calls.pop();
  }

  private bumpBlocks: { off: number; size: number; free: boolean; name: string }[] = [];

  /** Maps pages until the heap covers `bytes` from its base. */
  private grow(bytes: number) {
    const want = Math.ceil(bytes / PAGE_SIZE);
    while (this.mappedPages < want) {
      this.depth++;
      if (this.depth > RECURSION_LIMIT) {
        this.hazard = true;
        throw new HeapOverflow("recursion");
      }
      const va = HEAP_BASE + BigInt(this.mappedPages * PAGE_SIZE);
      this.calls.push(`grow: map 0x${hexShort(va)}`);
      const pfn = this.phys.allocSmall(1);
      if (pfn < 0) throw new HeapOverflow("out of frames");
      this.frameUse.push({ pfn, use: "data" });
      this.say("The heap needs a page", `The request passes the end of the mapped heap. The heap takes data frame ${pfn} and calls map_page for 0x${hexShort(va)}.`);
      this.pt.map(va, pfn, { writable: true, user: false, nx: true, global: true });
      this.mappedPages++;
      if (this.alloc === "list") this.extendList();
      this.say("Page mapped", `The PTE for 0x${hexShort(va)} now points to frame ${pfn}. The heap has ${this.mappedPages} page(s).`);
      this.calls.pop();
      this.depth--;
    }
  }

  /** The free list learns about the new page: a new free block, merged with a free tail. */
  private extendList() {
    const b = this.list.blocks;
    const end = (this.mappedPages - 1) * PAGE_SIZE;
    const last = b[b.length - 1];
    if (last?.free) last.size += PAGE_SIZE;
    else b.push({ off: end, size: PAGE_SIZE, free: true, req: 0, name: "" });
  }

  private bumpOrList(size: number, align: number): number {
    if (this.alloc === "bump") {
      const addr = alignUp(this.top, align);
      this.grow(addr + size);
      this.bumpBlocks.push({ off: addr, size, free: false, name: "" });
      this.top = addr + size;
      return addr;
    }
    for (;;) {
      const a = this.list.alloc(size);
      if (a !== null) return a;
      this.grow((this.mappedPages + 1) * PAGE_SIZE);
    }
  }

  /** Runs a script. Each step of interest adds a snapshot. Stops with a hazard snapshot on runaway recursion. */
  run(script: readonly HeapOp[]) {
    this.snap("Before the first kmalloc", "The heap range has no pages. The top table exists, because boot made it. The tables under it do not exist yet.");
    for (const op of script) {
      if (op.op === "alloc") {
        this.calls = [`kmalloc(${op.size}) for ${op.tag}`];
        try {
          const addr = this.bumpOrList(op.size!, op.align ?? 16);
          this.addrOf.set(op.tag, addr);
          this.live += op.size!;
          if (this.alloc === "bump") this.bumpBlocks[this.bumpBlocks.length - 1]!.name = op.tag;
          else { const bl = this.list.blocks.find((b) => !b.free && b.name && b.off + 8 === addr); if (bl) bl.name = op.tag; }
          this.calls = [];
          this.snap(`kmalloc(${op.size}) returns`, `The caller gets 0x${hexShort(HEAP_BASE + BigInt(addr))}. ${this.alloc === "bump" ? `The top moves to ${this.top} bytes.` : "The free list splits a block."}`);
        } catch (e) {
          if (!(e instanceof HeapOverflow)) throw e;
          this.snap("The recursion has no end", `kmalloc needs a page, the page needs a table, and the table needs kmalloc. No call finishes, so no table ever appears. After ${RECURSION_LIMIT} levels the model stops. A real kernel overflows its stack.`);
          return this;
        }
      } else {
        const addr = this.addrOf.get(op.tag)!;
        const size = script.find((x) => x.tag === op.tag && x.op === "alloc")!.size!;
        this.live -= size;
        if (this.alloc === "bump") {
          const b = this.bumpBlocks.find((x) => x.off === addr);
          if (b) b.free = true;
          this.calls = [];
          this.snap(`kfree(${op.tag})`, `A bump allocator cannot reuse this block. It only counts live blocks, and it resets when the count reaches 0. So ${size} bytes stay lost for now.`);
        } else {
          this.list.freeAddr(addr);
          this.calls = [];
          this.snap(`kfree(${op.tag})`, `The block joins the free list, and merges with free neighbors. A later request can reuse these ${size} bytes.`);
        }
      }
    }
    return this;
  }
}

export const heapSnaps = (alloc: HeapAlloc, tables: TableSource) => new KernelHeap(alloc, tables).run(HEAP_SCRIPT).snaps;
