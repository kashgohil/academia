/**
 * One address space: VMAs, a page table, frames, and the kernel's page fault path.
 * `access` runs the hardware walk, and on a fault it runs the same decisions as the kernel:
 * exc_page_fault, do_user_addr_fault, VMA lookup, handle_mm_fault, then do_anonymous_page, do_fault,
 * do_swap_page or do_wp_page. Each decision is logged, so a view can show the path that was taken.
 */
import { KiB, MiB, PAGE_SIZE, hexVa } from "./addr";
import { PF, PTE, PageTable, describeErrorCode, entryPfn, has, makeEntry, type AccessKind } from "./pagetable";
import { VmaTree, vmaLabel, vmaPerms, type Vma } from "./vma";

export type FaultOutcome =
  | "hit" // no fault: the walk succeeded
  | "minor-zero" // read of untouched anonymous memory: the shared zero page
  | "minor-anon" // write of untouched anonymous memory: a new zeroed frame
  | "minor-file" // file page already in the page cache
  | "minor-cow" // write to a read-only PTE in a writable VMA: copy, or reuse if sole owner
  | "major-file" // file page not in the page cache: disk read
  | "major-swap" // PTE holds a swap entry: disk read
  | "segv-maperr" // no VMA covers the address: SEGV_MAPERR
  | "segv-accerr"; // a VMA covers it but forbids this access: SEGV_ACCERR

export const OUTCOME_LABEL: Record<FaultOutcome, string> = {
  hit: "No fault",
  "minor-zero": "Minor fault: map the zero page",
  "minor-anon": "Minor fault: new zeroed frame",
  "minor-file": "Minor fault: page cache hit",
  "minor-cow": "Minor fault: copy on write",
  "major-file": "Major fault: read the file from disk",
  "major-swap": "Major fault: read from swap",
  "segv-maperr": "SIGSEGV (SEGV_MAPERR)",
  "segv-accerr": "SIGSEGV (SEGV_ACCERR)",
};

export const isMinor = (o: FaultOutcome) => o.startsWith("minor");
export const isMajor = (o: FaultOutcome) => o.startsWith("major");
export const isSegv = (o: FaultOutcome) => o.startsWith("segv");

/**
 * Cost of each outcome in ns. These are MODEL INPUTS, not measurements: the order of magnitude on a
 * current machine. A minor fault costs about a microsecond. A major fault is dominated by the device.
 */
export const FAULT_COST_NS: Record<FaultOutcome, number> = {
  hit: 0,
  "minor-zero": 500,
  "minor-anon": 1_000,
  "minor-file": 800,
  "minor-cow": 1_500,
  "major-file": 100_000,
  "major-swap": 100_000,
  "segv-maperr": 2_000,
  "segv-accerr": 2_000,
};

export type DecisionId = "walk" | "fault" | "vma" | "stack" | "rights" | "pte" | "anon" | "file" | "swap" | "wp" | "done";
export interface FaultStep { id: DecisionId; title: string; detail: string }

export type PteState = "none" | "swap" | "present-ro" | "present-rw" | "zero-page";

export interface AccessResult {
  va: number;
  kind: AccessKind;
  outcome: FaultOutcome;
  steps: FaultStep[];
  vma?: Vma;
  errorCode?: number;
  pteBefore: bigint;
  pteAfter: bigint;
  pteStateBefore: PteState;
  pteStateAfter: PteState;
  pfn?: number;
  /** Model cost, see FAULT_COST_NS. */
  costNs: number;
  /** Bytes of tables that this fault added. */
  tableBytesAdded: number;
}

export interface Frame { refs: number; kind: "zero" | "anon" | "file"; key?: string }

/** The system-wide part: frames, the page cache and swap. Several address spaces can share one. */
export class VmKernel {
  frames = new Map<number, Frame>();
  /** "file:pageIndex" to frame. */
  pageCache = new Map<string, number>();
  private nextPfn = 0x10000;
  private freeFrames: number[] = [];
  readonly zeroPfn: number;
  private nextSwap = 1;
  swapUsed = new Set<number>();
  /** Bytes read from disk since boot, in pages. */
  diskReads = 0;

  constructor() {
    this.zeroPfn = this.allocFrame("zero");
    this.frames.get(this.zeroPfn)!.refs = 1;
  }
  allocFrame(kind: Frame["kind"], key?: string): number {
    const pfn = this.freeFrames.pop() ?? this.nextPfn++;
    this.frames.set(pfn, { refs: 1, kind, key });
    return pfn;
  }
  ref(pfn: number) { this.frames.get(pfn)!.refs++; }
  /** Drops one reference. The page cache holds its own reference. */
  unref(pfn: number) {
    if (pfn === this.zeroPfn) return;
    const f = this.frames.get(pfn);
    if (!f) throw new Error("unref of a free frame");
    if (--f.refs === 0) { this.frames.delete(pfn); this.freeFrames.push(pfn); }
  }
  /** Frames in use, not counting the zero page. */
  get usedFrames() { return this.frames.size - 1; }
  /** Returns [pfn, wasCached]. */
  filePage(file: string, pageIndex: number): [number, boolean] {
    const key = `${file}:${pageIndex}`;
    const hit = this.pageCache.get(key);
    if (hit !== undefined) return [hit, true];
    const pfn = this.allocFrame("file", key); // the cache's own reference
    this.pageCache.set(key, pfn);
    this.diskReads++;
    return [pfn, false];
  }
  /** Loads pages into the page cache as if another process had read them. */
  warmFile(file: string, pages: number, from = 0) {
    for (let i = from; i < from + pages; i++) {
      const before = this.diskReads;
      this.filePage(file, i);
      this.diskReads = before;
    }
  }
  /** Removes a clean page from the cache if nobody maps it (like eviction under memory pressure). */
  dropCache(file: string, pageIndex: number): boolean {
    const key = `${file}:${pageIndex}`;
    const pfn = this.pageCache.get(key);
    if (pfn === undefined || this.frames.get(pfn)!.refs > 1) return false;
    this.pageCache.delete(key);
    this.unref(pfn);
    return true;
  }
  allocSwap(): number { const s = this.nextSwap++; this.swapUsed.add(s); return s; }
  freeSwap(s: number) { this.swapUsed.delete(s); }
}

const SWAP_TAG = 0x2n; // a not-present entry with bit 1 set holds a swap slot in the frame field

export const isSwapEntry = (e: bigint) => e !== 0n && !has(e, PTE.P);
const swapEntry = (slot: number) => makeEntry(slot, SWAP_TAG);

export class AddressSpace {
  readonly vmas = new VmaTree();
  readonly pt: PageTable;
  readonly kernel: VmKernel;
  /** Present PTEs that count as resident: every present page except the zero page. */
  rssPages = 0;
  minorFaults = 0;
  majorFaults = 0;
  /** Stack limit (RLIMIT_STACK). */
  stackLimit = 8 * MiB;

  constructor(kernel = new VmKernel(), pt = new PageTable()) { this.kernel = kernel; this.pt = pt; }

  /** Adds a VMA (mmap with MAP_FIXED semantics, no replace). No page is touched: this is why mmap is cheap. */
  mmap(start: number, length: number, perms: { read?: boolean; write?: boolean; exec?: boolean; shared?: boolean; file?: { name: string; offset?: number }; growsDown?: boolean; name?: string }): Vma {
    const v: Vma = {
      start, end: start + length, read: perms.read ?? true, write: perms.write ?? false, exec: perms.exec ?? false, shared: perms.shared ?? false,
      file: perms.file && { name: perms.file.name, offset: perms.file.offset ?? 0 }, growsDown: perms.growsDown, name: perms.name,
    };
    return this.vmas.insert(v);
  }

  /** Removes the range: PTEs, frames and VMAs. Returns the number of present PTEs that were cleared (each needs a TLB flush). */
  munmap(start: number, length: number): number {
    let cleared = 0;
    for (let va = start; va < start + length; va += PAGE_SIZE) {
      const e = this.pt.unmap(va);
      if (e === null) continue;
      if (has(e, PTE.P)) {
        cleared++;
        const pfn = entryPfn(e);
        if (pfn !== this.kernel.zeroPfn) this.rssPages--;
        this.kernel.unref(pfn);
      } else if (isSwapEntry(e)) this.kernel.freeSwap(entryPfn(e));
    }
    this.vmas.remove(start, start + length);
    return cleared;
  }

  /**
   * mprotect for read-keeping changes: updates the VMAs and the PTEs in the range. Removing write clears RW,
   * so the next write faults and the VMA check refuses it. Adding write leaves PTEs read-only, so the next
   * write takes the fault path and do_wp_page sets the bit. The caller must invalidate the TLB.
   */
  mprotect(start: number, length: number, perms: { write: boolean; exec: boolean }) {
    this.vmas.protect(start, start + length, { read: true, ...perms });
    for (let va = start; va < start + length; va += PAGE_SIZE) {
      const l = this.pt.leaf(va);
      if (!l || !has(l.entry, PTE.P)) continue;
      this.pt.updateLeaf(va, (e) => {
        const w = perms.write ? e : e & ~PTE.RW;
        return perms.exec ? w & ~PTE.NX : w | PTE.NX;
      });
    }
  }

  pteState(va: number): PteState {
    const l = this.pt.leaf(va);
    if (!l) return "none";
    if (!has(l.entry, PTE.P)) return "swap";
    if (entryPfn(l.entry) === this.kernel.zeroPfn) return "zero-page";
    return has(l.entry, PTE.RW) ? "present-rw" : "present-ro";
  }

  private install(va: number, pfn: number, writable: boolean, nx: boolean) {
    const page = va - (va % PAGE_SIZE);
    const before = this.pt.leaf(page);
    if (before) this.pt.unmap(page);
    this.pt.map(page, pfn, { writable, nx, user: true });
    if (pfn !== this.kernel.zeroPfn) this.rssPages++;
  }

  /** Pushes a resident private page out to swap. The PTE becomes a swap entry. */
  swapOut(va: number): boolean {
    const page = va - (va % PAGE_SIZE);
    const l = this.pt.leaf(page);
    if (!l || !has(l.entry, PTE.P)) return false;
    const pfn = entryPfn(l.entry);
    if (pfn === this.kernel.zeroPfn || this.kernel.frames.get(pfn)!.kind !== "anon") return false;
    this.pt.unmap(page);
    this.rssPages--;
    this.kernel.unref(pfn);
    this.pt.setLeaf(page, swapEntry(this.kernel.allocSwap()));
    return true;
  }

  /** One load, store or instruction fetch from user mode. */
  access(va: number, kind: AccessKind): AccessResult {
    const steps: FaultStep[] = [];
    const log = (id: DecisionId, title: string, detail: string) => steps.push({ id, title, detail });
    const pteBefore = this.pt.leaf(va)?.entry ?? 0n;
    const pteStateBefore = this.pteState(va);
    const tablesBefore = this.pt.tablePages;
    const verb = kind === "w" ? "write" : kind === "x" ? "instruction fetch" : "read";
    const finish = (outcome: FaultOutcome, vma: Vma | undefined, errorCode: number | undefined): AccessResult => {
      if (isMinor(outcome)) this.minorFaults++;
      if (isMajor(outcome)) this.majorFaults++;
      const leaf = this.pt.leaf(va);
      const pfn = leaf && has(leaf.entry, PTE.P) ? entryPfn(leaf.entry) : undefined;
      log("done", OUTCOME_LABEL[outcome], outcome === "hit" ? "The instruction completes." : isSegv(outcome) ? "The kernel sends the signal. Without a handler, the process dies." : "The kernel returns from the fault. The CPU runs the same instruction again, and it now succeeds.");
      return { va, kind, outcome, steps, vma, errorCode, pteBefore, pteAfter: leaf?.entry ?? 0n, pteStateBefore, pteStateAfter: this.pteState(va), pfn, costNs: FAULT_COST_NS[outcome], tableBytesAdded: (this.pt.tablePages - tablesBefore) * PAGE_SIZE };
    };

    const walk = this.pt.walk(va, { kind, user: true });
    if (walk.ok) {
      log("walk", "Hardware walk succeeds", `The entries allow a ${verb}. The kernel does not run.`);
      return finish("hit", this.vmas.find(va), undefined);
    }
    const code = walk.fault!.code;
    log("walk", "Hardware walk fails", walk.fault!.reason === "not-present" ? `The entry at level ${walk.fault!.level + 1} has P = 0.` : `The PTE is present, but it does not allow a ${verb}.`);
    log("fault", "CPU raises #PF", `CR2 = ${hexVa(va)}. Error code ${code}: ${describeErrorCode(code)}. The CPU enters exc_page_fault, which calls do_user_addr_fault.`);

    // VMA lookup
    let vma = this.vmas.find(va);
    if (!vma) {
      const next = this.vmas.findFirstAfter(va);
      if (next?.growsDown && next.end - va <= this.stackLimit) {
        const newStart = va - (va % PAGE_SIZE);
        log("stack", "Below a stack VMA", `find_vma returns the stack VMA, which starts above the address. VM_GROWSDOWN allows growth inside the limit, so the VMA now starts at ${hexVa(newStart)}.`);
        this.vmas.growDown(next, newStart);
        vma = this.vmas.find(va)!;
      } else {
        log("vma", "No VMA covers the address", next?.growsDown ? "The address is below the stack VMA but outside the stack limit." : "This address was never mapped. The kernel takes the bad_area path.");
        return finish("segv-maperr", undefined, code);
      }
    } else log("vma", `VMA found: ${vmaLabel(vma)} ${vmaPerms(vma)}`, `${hexVa(vma.start)} to ${hexVa(vma.end)}.`);

    // rights
    const allowed = kind === "w" ? vma.write : kind === "x" ? vma.exec : vma.read;
    if (!allowed) {
      log("rights", `The VMA forbids a ${verb}`, `The rights are ${vmaPerms(vma)}. The kernel takes the bad_area_access_error path.`);
      return finish("segv-accerr", vma, code);
    }
    log("rights", `The VMA allows a ${verb}`, "So the fault is the kernel's work, not a bug in the program. It calls handle_mm_fault.");

    const page = va - (va % PAGE_SIZE);
    const entry = pteBefore;
    const nx = !vma.exec;

    if (entry === 0n) {
      log("pte", "The PTE is empty", "The page was never touched. The VMA says where its contents come from.");
      if (!vma.file) {
        if (kind === "w") {
          log("anon", "do_anonymous_page: write", "Anonymous memory must read as zero. The kernel takes a free frame, clears it, and maps it writable.");
          this.install(page, this.kernel.allocFrame("anon"), true, nx);
          return finish("minor-anon", vma, code);
        }
        log("anon", "do_anonymous_page: read", "Nothing needs its own frame yet. The kernel maps the shared zero page read-only. RSS does not grow.");
        this.install(page, this.kernel.zeroPfn, false, nx);
        return finish("minor-zero", vma, code);
      }
      const pageIndex = Math.floor((vma.file.offset + (page - vma.start)) / PAGE_SIZE);
      const [cachePfn, cached] = this.kernel.filePage(vma.file.name, pageIndex);
      log("file", cached ? "do_fault: page cache hit" : "do_fault: page cache miss", cached ? `filemap_fault finds ${vma.file.name} page ${pageIndex} in the page cache. No disk I/O.` : `filemap_fault must read ${vma.file.name} page ${pageIndex} from disk. The thread blocks on the I/O.`);
      const major = cached ? "minor-file" as const : "major-file" as const;
      if (vma.shared || kind !== "w") {
        this.kernel.ref(cachePfn);
        this.install(page, cachePfn, vma.shared && vma.write && kind === "w", nx);
        return finish(major, vma, code);
      }
      log("wp", "do_cow_fault: private write", "A private file mapping must not change the file. The kernel copies the cached page into a new frame.");
      this.install(page, this.kernel.allocFrame("anon"), true, nx);
      return finish(cached ? "minor-cow" : "major-file", vma, code);
    }
    if (isSwapEntry(entry)) {
      log("swap", "do_swap_page", `The PTE is not present, but it holds swap slot ${entryPfn(entry)}. The kernel reads the page back and blocks on the disk.`);
      this.kernel.freeSwap(entryPfn(entry));
      this.pt.unmap(page);
      this.install(page, this.kernel.allocFrame("anon"), kind === "w" ? vma.write : false, nx);
      this.kernel.diskReads++;
      return finish("major-swap", vma, code);
    }
    // Present but not writable, and the VMA allows the write: copy on write.
    if (kind === "w" && has(entry, PTE.P) && !has(entry, PTE.RW)) {
      const old = entryPfn(entry);
      const frame = this.kernel.frames.get(old)!;
      const copy = old === this.kernel.zeroPfn || frame.refs > 1 || frame.kind === "file";
      log("pte", "The PTE is present but read-only", "The VMA allows the write, so the read-only PTE is on purpose: the kernel handles a write-protect fault.");
      if (vma.shared) {
        log("wp", "do_wp_page: shared mapping", "The page is shared on purpose. The kernel only makes the PTE writable and marks the page dirty.");
        this.pt.updateLeaf(page, (e) => e | PTE.RW);
        return finish("minor-file", vma, code);
      }
      log("wp", "do_wp_page", copy ? (old === this.kernel.zeroPfn ? "The PTE points at the zero page. The kernel takes a frame, zeroes it, and maps it writable." : `Frame ${old.toString(16)} has other users. The kernel copies it into a new frame.`) : "This process is the only user of the frame. The kernel reuses it and sets the writable bit, with no copy.");
      if (copy) {
        this.pt.unmap(page);
        if (old !== this.kernel.zeroPfn) { this.rssPages--; this.kernel.unref(old); }
        this.install(page, this.kernel.allocFrame("anon"), true, nx);
      } else this.pt.updateLeaf(page, (e) => e | PTE.RW);
      return finish("minor-cow", vma, code);
    }
    throw new Error(`unhandled fault at ${hexVa(va)}: code ${code & (PF.P | PF.W | PF.U | PF.I)}`);
  }

  /** fork: the child gets a copy of the VMAs and PTEs. Private writable pages become read-only in both. */
  fork(): AddressSpace {
    const child = new AddressSpace(this.kernel, new PageTable({ mem: this.pt.mem }));
    for (const v of this.vmas.all) child.vmas.insert(v);
    for (const v of this.vmas.all) {
      for (let va = v.start; va < v.end; va += PAGE_SIZE) {
        const l = this.pt.leaf(va);
        if (!l) continue;
        if (isSwapEntry(l.entry)) continue; // private swap entries stay with the parent in this model
        const pfn = entryPfn(l.entry);
        const wr = has(l.entry, PTE.RW);
        const keepWritable = wr && v.shared;
        if (wr && !v.shared) this.pt.updateLeaf(va, (e) => e & ~PTE.RW);
        child.pt.map(va, pfn, { writable: keepWritable, nx: has(l.entry, PTE.NX), user: true });
        if (pfn !== this.kernel.zeroPfn) { this.kernel.ref(pfn); child.rssPages++; }
      }
    }
    return child;
  }
}

// ---------------- cost and policy arithmetic ----------------

/** Device service time for a major fault. MODEL INPUTS. */
export const DEVICE_NS = { nvme: 100_000, sata: 200_000, hdd: 8_000_000 } as const;
/** DRAM access in ns. MODEL INPUT. */
export const DRAM_NS = 100;

/** Average access time when a fraction p of accesses are major faults. */
export const effectiveAccessNs = (p: number, deviceNs: number, dramNs = DRAM_NS) => (1 - p) * dramNs + p * (deviceNs + dramNs);
/** The fault rate that makes the average access `slowdown` times slower than DRAM. */
export const faultRateForSlowdown = (slowdown: number, deviceNs: number, dramNs = DRAM_NS) => ((slowdown - 1) * dramNs) / deviceNs;

export type OvercommitMode = 0 | 1 | 2;
export interface OvercommitInput { mode: OvercommitMode; ramBytes: number; swapBytes: number; ratioPct?: number; committedBytes?: number; requestBytes: number }
export interface OvercommitResult { ok: boolean; limitBytes: number | null; reason: string }

/**
 * The kernel's decision in __vm_enough_memory. Mode 0 (heuristic, the default) refuses only one request
 * larger than RAM + swap. Mode 1 never refuses. Mode 2 enforces CommitLimit = swap + RAM * ratio / 100.
 */
export function overcommitCheck(i: OvercommitInput): OvercommitResult {
  const ratio = i.ratioPct ?? 50;
  const committed = i.committedBytes ?? 0;
  if (i.mode === 1) return { ok: true, limitBytes: null, reason: "Mode 1 always says yes." };
  if (i.mode === 0) {
    const limit = i.ramBytes + i.swapBytes;
    const ok = i.requestBytes <= limit;
    return { ok, limitBytes: limit, reason: ok ? "Mode 0 refuses only an obvious overcommit. One request at or below RAM + swap passes, whatever is already committed." : "Mode 0 refuses this one: the request alone is larger than RAM + swap." };
  }
  const limit = i.swapBytes + (i.ramBytes * ratio) / 100;
  const ok = committed + i.requestBytes <= limit;
  return { ok, limitBytes: limit, reason: ok ? "The total commitment stays under CommitLimit." : "The total commitment would pass CommitLimit, so mmap returns ENOMEM." };
}

/** Result of `malloc` then touching pages, for the resident set plot. */
export interface TouchSample { touched: number; rssBytes: number; tableBytes: number; minor: number; timeNs: number }

/** Runs malloc(bytes) then a loop of reads or writes over a real AddressSpace, one page at a time. */
export function touchRun(bytes: number, mode: "write" | "read", samples = 64): { samples: TouchSample[]; as: AddressSpace } {
  const as = new AddressSpace();
  const base = 0x7f0000000000;
  as.mmap(base, bytes, { read: true, write: true });
  const pages = Math.floor(bytes / PAGE_SIZE);
  const stride = Math.max(1, Math.floor(pages / samples));
  const out: TouchSample[] = [{ touched: 0, rssBytes: 0, tableBytes: as.pt.tableBytes, minor: 0, timeNs: 0 }];
  let t = 0;
  for (let i = 0; i < pages; i++) {
    t += as.access(base + i * PAGE_SIZE, mode === "write" ? "w" : "r").costNs;
    if ((i + 1) % stride === 0 || i === pages - 1) out.push({ touched: i + 1, rssBytes: as.rssPages * PAGE_SIZE, tableBytes: as.pt.tableBytes, minor: as.minorFaults, timeNs: t });
  }
  return { samples: out, as };
}

/** Linux and libc defaults that the lessons quote. */
export const FAULT_FACTS = {
  /** fault_around_bytes: a file read fault maps up to this many bytes around the address, if cached. Not modelled in AddressSpace. */
  faultAroundBytes: 64 * KiB,
  faultAroundPages: (64 * KiB) / PAGE_SIZE,
  /** glibc M_MMAP_THRESHOLD default: larger requests get their own mmap. */
  glibcMmapThreshold: 128 * KiB,
  /** Default vm.overcommit_ratio. */
  overcommitRatioPct: 50,
};
