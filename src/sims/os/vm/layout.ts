/**
 * The layout of a Linux x86-64 process: the address map, a /proc/pid/maps model with ASLR,
 * and two processes that share frames through real page tables.
 * The file sizes in procMaps are examples. The bases and random ranges follow the kernel's constants.
 */
import { GiB, KiB, MiB, PAGE_SIZE, TiB, holeBytes } from "./addr";
import { PageTable, TableMem } from "./pagetable";
import { mulberry32 } from "../../rng";

/** Top of user space: 2^47 minus one page (TASK_SIZE_MAX). */
export const TASK_SIZE = (1n << 47n) - 4096n;
/** Where a PIE loads with ASLR off: two thirds of the user range, page aligned (ELF_ET_DYN_BASE). */
export const PIE_BASE = ((TASK_SIZE / 3n) * 2n) & ~0xfffn;
/** The mmap base that a debugger shows with ASLR off, a little below the stack. Typical value, not a kernel constant. */
export const MMAP_BASE_NO_ASLR = 0x7ffff7fff000n;
export const STACK_TOP = TASK_SIZE;
/** Random bits for the mmap base and a PIE: the default of /proc/sys/vm/mmap_rnd_bits on x86-64. */
export const MMAP_RND_BITS = 28;
/** Random bits for the stack top, in pages. */
export const STACK_RND_BITS = 22;
/** The brk start moves by up to 32 MiB after the end of the program. */
export const BRK_RND_BYTES = 32 * MiB;

export const aslrRange = { mmapBytes: 2 ** MMAP_RND_BITS * PAGE_SIZE, stackBytes: 2 ** STACK_RND_BITS * PAGE_SIZE, brkBytes: BRK_RND_BYTES };

export interface ProcessBases { pie: bigint; brk: bigint; mmapBase: bigint; stackEnd: bigint }

export function processBases(seed: number, aslr: boolean): ProcessBases {
  const r = mulberry32(seed);
  const pick = (bits: number) => (aslr ? BigInt(Math.floor(r() * 2 ** bits)) : 0n);
  const pie = PIE_BASE + (pick(MMAP_RND_BITS) << 12n);
  const brkGap = aslr ? BigInt(Math.floor(r() * (BRK_RND_BYTES / PAGE_SIZE))) << 12n : 0n;
  const mmapBase = MMAP_BASE_NO_ASLR - (pick(MMAP_RND_BITS) << 12n);
  const stackEnd = STACK_TOP - (pick(STACK_RND_BITS) << 12n);
  return { pie, brk: pie + 0xc000n + brkGap, mmapBase, stackEnd };
}

export interface MapsLine {
  start: bigint;
  end: bigint;
  perms: string;
  offset: number;
  dev: string;
  inode: number;
  path: string;
  /** What this line is, in one short sentence. */
  explain: string;
  group: "program" | "heap" | "library" | "anon" | "stack" | "kernel-provided";
}

const hex = (v: bigint) => v.toString(16);

/** The maps file of `cat /proc/self/maps` on a typical glibc system, as a model. */
export function procMaps(seed: number, aslr = true): MapsLine[] {
  const b = processBases(seed, aslr);
  const out: MapsLine[] = [];
  const add = (start: bigint, size: number, perms: string, offset: number, dev: string, inode: number, path: string, group: MapsLine["group"], explain: string) => {
    out.push({ start, end: start + BigInt(size), perms, offset, dev, inode, path, group, explain });
    return start + BigInt(size);
  };
  const disk = "08:01";
  const none = "00:00";
  // the program image, in file order
  let p = b.pie;
  p = add(p, 8 * KiB, "r--p", 0, disk, 1835, "/usr/bin/cat", "program", "ELF headers and read-only data before the code. It is mapped from the file and shared while it stays unchanged.");
  p = add(p, 20 * KiB, "r-xp", 0x2000, disk, 1835, "/usr/bin/cat", "program", "The machine code: read and execute, not write. Offset 0x2000 says where it starts in the file.");
  p = add(p, 12 * KiB, "r--p", 0x7000, disk, 1835, "/usr/bin/cat", "program", "Constants such as strings. A write here raises SIGSEGV.");
  p = add(p, 4 * KiB, "r--p", 0xa000, disk, 1835, "/usr/bin/cat", "program", "Relocated data that the loader made read-only after it finished (RELRO).");
  add(p, 4 * KiB, "rw-p", 0xb000, disk, 1835, "/usr/bin/cat", "program", "Initialized globals. The p means private: a write copies the page, and the file does not change.");
  add(b.brk, 132 * KiB, "rw-p", 0, none, 0, "[heap]", "heap", "The brk heap. Inode 0 means anonymous memory: no file backs it. A random gap separates it from the program.");
  // the mmap area grows down from mmapBase
  const lib = [
    { size: 3 * MiB, perms: "r--p", off: 0, path: "/usr/lib/locale/locale-archive", inode: 2201, group: "library" as const, explain: "A file that cat mapped for locale data. mmap put it below the libraries, because this area grows down." },
    { size: 12 * KiB, perms: "rw-p", off: 0, path: "", inode: 0, group: "anon" as const, explain: "An anonymous mapping with no name: for example thread-local storage or a large malloc." },
    { size: 160 * KiB, perms: "r--p", off: 0, path: "/usr/lib/x86_64-linux-gnu/libc.so.6", inode: 3120, group: "library" as const, explain: "The start of the C library: ELF headers and tables. Every process that uses libc shares these frames." },
    { size: 1576 * KiB, perms: "r-xp", off: 0x28000, path: "/usr/lib/x86_64-linux-gnu/libc.so.6", inode: 3120, group: "library" as const, explain: "The code of libc. This is the classic example of frames that many processes share." },
    { size: 344 * KiB, perms: "r--p", off: 0x1b2000, path: "/usr/lib/x86_64-linux-gnu/libc.so.6", inode: 3120, group: "library" as const, explain: "Read-only data of libc." },
    { size: 16 * KiB, perms: "r--p", off: 0x207000, path: "/usr/lib/x86_64-linux-gnu/libc.so.6", inode: 3120, group: "library" as const, explain: "RELRO for libc: private data that the loader changed, then protected." },
    { size: 8 * KiB, perms: "rw-p", off: 0x20b000, path: "/usr/lib/x86_64-linux-gnu/libc.so.6", inode: 3120, group: "library" as const, explain: "Writable globals of libc. A write makes a private copy for this process." },
    { size: 52 * KiB, perms: "rw-p", off: 0, path: "", inode: 0, group: "anon" as const, explain: "Anonymous memory next to libc: its zero-initialized data (.bss), which has no bytes in the file." },
    { size: 4 * KiB, perms: "r--p", off: 0, path: "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", inode: 3099, group: "library" as const, explain: "The dynamic linker, which the kernel mapped before the program started." },
    { size: 148 * KiB, perms: "r-xp", off: 0x1000, path: "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", inode: 3099, group: "library" as const, explain: "The code of the dynamic linker. It ran first, and it mapped libc." },
  ];
  const total = lib.reduce((a, l) => a + l.size, 0);
  let q = b.mmapBase - BigInt(total);
  for (const l of lib) q = add(q, l.size, l.perms, l.off, l.path ? disk : none, l.inode, l.path, l.group, l.explain);
  // near the top
  let s = b.stackEnd - BigInt(132 * KiB);
  const stackEnd = add(s, 132 * KiB, "rw-p", 0, none, 0, "[stack]", "stack", "The main thread's stack. It grows down on page faults, up to the limit in ulimit -s.");
  // vvar and vdso go above the stack if there is room, and otherwise at the top of the mmap area.
  s = (stackEnd + BigInt(20 * MiB)) & ~0xfffn;
  if (s + BigInt(32 * KiB) >= TASK_SIZE) s = b.mmapBase;
  const v = add(s, 16 * KiB, "r--p", 0, none, 0, "[vvar]", "kernel-provided", "Data pages that the kernel shares with user code, such as clock parameters.");
  add(v, 8 * KiB, "r-xp", 0, none, 0, "[vdso]", "kernel-provided", "Code that the kernel maps into each process, so that clock_gettime does not need a syscall.");
  out.sort((x, y) => (x.start < y.start ? -1 : 1));
  out.push({ start: 0xffffffffff600000n, end: 0xffffffffff601000n, perms: "--xp", offset: 0, dev: none, inode: 0, path: "[vsyscall]", group: "kernel-provided", explain: "An old fixed-address page for fast syscalls, kept for old binaries. It is the only line in the kernel half." });
  return out;
}

export const mapsText = (l: MapsLine) => `${hex(l.start)}-${hex(l.end)} ${l.perms} ${l.offset.toString(16).padStart(8, "0")} ${l.dev} ${l.inode}${l.path ? ` ${l.path}` : ""}`;

// ---------------- the whole 64-bit map ----------------

export interface Band {
  name: string;
  start: bigint;
  /** exclusive */
  end: bigint;
  kind: "user" | "kernel" | "gap" | "hole";
  note: string;
}

const size = (b: Band) => b.end - b.start;
export const bandBytes = (b: Band) => Number(size(b));
/** Band height in the log view: proportional to log2 of its size. */
export const bandLog = (b: Band) => Math.log2(bandBytes(b));

export const KERNEL_BASE = 0xffff800000000000n;
const END = 1n << 64n;

/** The address space from 0 to 2^64, including every gap, for 4-level paging. */
export function addressMap(seed: number, aslr = true): Band[] {
  const m = procMaps(seed, aslr);
  const b = processBases(seed, aslr);
  const progEnd = m.filter((l) => l.group === "program").at(-1)!.end;
  const heap = m.find((l) => l.path === "[heap]")!;
  const mmapLo = m.filter((l) => l.group === "library" || l.group === "anon")[0]!.start;
  const stack = m.find((l) => l.path === "[stack]")!;
  const list: Band[] = [
    { name: "Low guard", start: 0n, end: 0x10000n, kind: "gap", note: "Never mapped by default (vm.mmap_min_addr is usually 65536). A NULL dereference faults here." },
    { name: "Empty", start: 0x10000n, end: b.pie, kind: "gap", note: "Unmapped virtual addresses. They cost nothing: no page table exists for them." },
    { name: "Program image", start: b.pie, end: progEnd, kind: "user", note: "Text, read-only data, data and bss of the executable. A PIE loads near 0x5555_5555_4000 plus a random offset." },
    { name: "Empty", start: progEnd, end: heap.start, kind: "gap", note: "A random gap of up to 32 MiB before the heap." },
    { name: "Heap", start: heap.start, end: heap.end, kind: "user", note: "The brk area. It grows up. malloc uses it for small requests." },
    { name: "Empty", start: heap.end, end: mmapLo, kind: "gap", note: "The largest gap in user space. The heap and the mmap area grow toward each other through it." },
    { name: "mmap area", start: mmapLo, end: b.mmapBase, kind: "user", note: "Shared libraries, mapped files, thread stacks and large malloc blocks. New mappings go below the old ones." },
    { name: "Empty", start: b.mmapBase, end: stack.start, kind: "gap", note: "A gap that leaves room for the stack limit, plus a random offset." },
    { name: "Stack", start: stack.start, end: stack.end, kind: "user", note: "The main thread's stack. It grows down, up to 8 MiB by default." },
    { name: "Top of user space", start: stack.end, end: 1n << 47n, kind: "gap", note: "Near the top: vvar, vdso and the end of user space at 0x7fff_ffff_f000. The last page stays unmapped." },
    { name: "Non-canonical hole", start: 1n << 47n, end: KERNEL_BASE, kind: "hole", note: "No canonical address falls here. An access raises a general protection fault, not a page fault." },
    { name: "Guard hole and LDT remap", start: KERNEL_BASE, end: 0xffff888000000000n, kind: "gap", note: "Reserved at the bottom of the kernel half." },
    { name: "Direct map", start: 0xffff888000000000n, end: 0xffffc88000000000n, kind: "kernel", note: "All physical memory mapped in one range (64 TiB), so that the kernel can reach any frame by adding a constant." },
    { name: "Empty", start: 0xffffc88000000000n, end: 0xffffc90000000000n, kind: "gap", note: "Unused." },
    { name: "vmalloc and ioremap", start: 0xffffc90000000000n, end: 0xffffe90000000000n, kind: "kernel", note: "Virtually contiguous kernel mappings (32 TiB)." },
    { name: "Empty", start: 0xffffe90000000000n, end: 0xffffea0000000000n, kind: "gap", note: "Unused." },
    { name: "vmemmap", start: 0xffffea0000000000n, end: 0xffffeb0000000000n, kind: "kernel", note: "The array of struct page, one entry for each physical frame (1 TiB)." },
    { name: "Empty", start: 0xffffeb0000000000n, end: 0xffffffff80000000n, kind: "gap", note: "KASAN shadow, cpu_entry_area, fixmap and others live here, depending on the kernel configuration." },
    { name: "Kernel text", start: 0xffffffff80000000n, end: 0xffffffffa0000000n, kind: "kernel", note: "The kernel image (512 MiB of address range) in the top 2 GiB." },
    { name: "Modules", start: 0xffffffffa0000000n, end: 0xffffffffff000000n, kind: "kernel", note: "Loadable kernel modules (1,520 MiB)." },
    { name: "Top", start: 0xffffffffff000000n, end: END, kind: "gap", note: "The vsyscall page sits here at 0xffff_ffff_ff60_0000." },
  ];
  return list.filter((band) => band.end > band.start); // with ASLR off, the heap touches the program
}

export const addressMapFacts = {
  userBytes: 128 * TiB,
  kernelBytes: 128 * TiB,
  holeBytes: holeBytes(4),
  directMapBytes: 64 * TiB,
  vmallocBytes: 32 * TiB,
  kernelTextBytes: 512 * MiB,
  moduleBytes: 1520 * MiB,
  /** Fraction of 2^64 that 4-level paging can name. */
  usableFraction: 2 ** 48 / 2 ** 64,
};

// ---------------- two processes ----------------

export interface ProcPage { region: string; va: bigint; pfn: number; shared: boolean; writable: boolean; pa: bigint }

export interface TwoProcesses {
  a: ProcPage[];
  b: ProcPage[];
  tablesA: PageTable;
  tablesB: PageTable;
  frames: { pfn: number; label: string; users: ("A" | "B")[] }[];
  virtualPages: number;
  framesUsed: number;
  /** Frames needed if nothing were shared. */
  framesUnshared: number;
}

/** Same program, two processes. Library and program code use the same frames. Data, heap and stack do not. */
export function twoProcesses(opts: { aslr?: boolean; seedA?: number; seedB?: number } = {}): TwoProcesses {
  const aslr = opts.aslr ?? false;
  const mem = new TableMem();
  const tablesA = new PageTable({ mem });
  const tablesB = new PageTable({ mem });
  const baseA = processBases(opts.seedA ?? 11, aslr);
  const baseB = processBases(opts.seedB ?? 29, aslr);
  let nextPrivate = 0x300;
  const frames: TwoProcesses["frames"] = [];
  const shared = (pfn: number, label: string) => { frames.push({ pfn, label, users: ["A", "B"] }); return pfn; };
  const priv = (who: "A" | "B", label: string) => { const pfn = nextPrivate++; frames.push({ pfn, label: `${who}: ${label}`, users: [who] }); return pfn; };
  const textFrames = [shared(0x120, "program code"), shared(0x121, "program code")];
  const libFrames = [shared(0x1a0, "libc code"), shared(0x1a1, "libc code"), shared(0x1a2, "libc code")];
  const build = (who: "A" | "B", b: ProcessBases, pt: PageTable): ProcPage[] => {
    const out: ProcPage[] = [];
    const add = (region: string, va: bigint, pfn: number, isShared: boolean, writable: boolean) => {
      pt.map(va, pfn, { writable, nx: writable, user: true });
      out.push({ region, va, pfn, shared: isShared, writable, pa: BigInt(pfn) << 12n });
    };
    textFrames.forEach((f, i) => add("program code", b.pie + BigInt(i * PAGE_SIZE), f, true, false));
    add("global data", b.pie + 0xb000n, priv(who, "global data"), false, true);
    add("heap", b.brk, priv(who, "heap"), false, true);
    libFrames.forEach((f, i) => add("libc code", b.mmapBase - 0x200000n + BigInt(i * PAGE_SIZE), f, true, false));
    add("stack", b.stackEnd - 0x1000n, priv(who, "stack"), false, true);
    return out;
  };
  const a = build("A", baseA, tablesA);
  const b = build("B", baseB, tablesB);
  frames.sort((x, y) => x.pfn - y.pfn);
  return { a, b, tablesA, tablesB, frames, virtualPages: a.length + b.length, framesUsed: frames.length, framesUnshared: a.length + b.length };
}

export const LAYOUT_FACTS = {
  stackLimit: 8 * MiB,
  mmapMinAddr: 64 * KiB,
  /** The size of __PAGEZERO in a 64-bit Mach-O program. */
  machoPageZero: 4 * GiB,
  /** The first address that the Go runtime tries for its heap on linux/amd64. */
  goHeapHint: 0xc000000000n,
};
