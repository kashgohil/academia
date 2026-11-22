/**
 * Struct layout: field order, padding, packing and cache-line alignment, on top of the shared layout code in
 * src/sims/sys/mem (layoutC, layoutRust, optimalOrder). This file adds:
 *
 * - GALLERY: real and teaching structs. Each one was checked with `zig cc -target <triple>` (zig 0.17.1) and
 *   offsetof/sizeof, and the Rust ones with rustc 1.96 (size_of, offset_of!). `struct epoll_event` is packed on x86
 *   (glibc bits/epoll.h for x86 defines __EPOLL_PACKED as __attribute__((__packed__)); the kernel's uapi eventpoll.h
 *   packs it under #ifdef __x86_64__: "On x86-64 make the 64bit structure have the same alignment as the 32bit
 *   structure. This makes 32bit emulation easier."), so it is 12
 *   bytes there and 16 bytes on AArch64 and RISC-V.
 * - packedAccess: a packed array of `struct { uint8_t tag; uint32_t len; }` on the shared machine, read three ways:
 *   through the struct (the compiler knows the field is unaligned), through a `uint32_t *` (UB when misaligned), and
 *   with memcpy.
 * - cacheLines: per-thread counters in an array, with and without alignas(64).
 */
import { array, layoutC, Machine, offset, struct, T, union, ptr, type Layout, type TargetId, type Type, type UbReport } from "../mem";

export interface GalleryEntry {
  id: string;
  label: string;
  /** The struct for a target (epoll_event is packed only on x86). */
  type: (target: TargetId) => Type;
  /** C source shown with the layout. */
  code: string[];
  note: string;
  /** Checked sizes per target (zig cc / rustc), for the tests. */
  checked: Partial<Record<TargetId, number>>;
}

const u8 = T.u8, u16 = T.u16, u32 = T.u32, u64 = T.u64;

export const GALLERY: GalleryEntry[] = [
  {
    id: "s1", label: "char, int, short",
    type: () => struct("S", [["c", T.char], ["i", T.int], ["s", T.short]]),
    code: ["struct S {", "    char c;", "    int i;", "    short s;", "};"],
    note: "3 bytes of padding before i and 2 at the end: 12 bytes for 7 bytes of data. Sorted by alignment it is 8.",
    checked: { "x86_64-linux": 12, "i386-linux": 12 },
  },
  {
    id: "worst", label: "u8, u64, u8, u32, u16",
    type: () => struct("M", [["a", u8], ["b", u64], ["c", u8], ["d", u32], ["e", u16]]),
    code: ["struct M {", "    uint8_t a;", "    uint64_t b;", "    uint8_t c;", "    uint32_t d;", "    uint16_t e;", "};"],
    note: "In C order this is 32 bytes. rustc 1.96 makes the same fields 16 bytes by reordering them: b, d, e, a, c.",
    checked: { "x86_64-linux": 32 },
  },
  {
    id: "longint", label: "long, int (data models)",
    type: () => struct("rec", [["id", T.long], ["n", T.int]]),
    code: ["struct rec {", "    long id;", "    int n;", "};"],
    note: "long is 8 bytes on LP64 (Linux, macOS) but 4 on LLP64 (Windows) and ILP32. The same source gives 16 or 8 bytes.",
    checked: { "x86_64-linux": 16, "x86_64-windows": 8, "i386-linux": 8 },
  },
  {
    id: "iovec", label: "struct iovec",
    type: () => struct("iovec", [["iov_base", ptr()], ["iov_len", T.size_t]]),
    code: ["struct iovec {", "    void *iov_base;", "    size_t iov_len;", "};"],
    note: "Two machine words, no padding on any target: 16 bytes on 64-bit, 8 on 32-bit.",
    checked: { "x86_64-linux": 16, "i386-linux": 8, "aarch64-linux": 16 },
  },
  {
    id: "sockaddr", label: "struct sockaddr_in",
    type: () => struct("sockaddr_in", [["sin_family", u16], ["sin_port", u16], ["sin_addr", struct("in_addr", [["s_addr", u32]])], ["sin_zero", array(T["unsigned char"], 8)]]),
    code: ["struct sockaddr_in {", "    sa_family_t sin_family;  // uint16_t", "    in_port_t sin_port;      // uint16_t", "    struct in_addr sin_addr; // uint32_t", "    unsigned char sin_zero[8];", "};"],
    note: "Designed with no padding: 16 bytes everywhere, so it has the size of the generic struct sockaddr.",
    checked: { "x86_64-linux": 16, "i386-linux": 16, "aarch64-linux": 16 },
  },
  {
    id: "elfsym", label: "Elf64_Sym",
    type: () => struct("Elf64_Sym", [["st_name", u32], ["st_info", u8], ["st_other", u8], ["st_shndx", u16], ["st_value", u64], ["st_size", u64]]),
    code: ["typedef struct {", "    Elf64_Word st_name;      // uint32_t", "    unsigned char st_info;", "    unsigned char st_other;", "    Elf64_Section st_shndx;  // uint16_t", "    Elf64_Addr st_value;     // uint64_t", "    Elf64_Xword st_size;     // uint64_t", "} Elf64_Sym;"],
    note: "The small fields fill the first 8 bytes exactly. 24 bytes, no padding, the same on every target: the file format needs that.",
    checked: { "x86_64-linux": 24, "i386-linux": 24, "aarch64-linux": 24 },
  },
  {
    id: "epoll", label: "struct epoll_event",
    type: (t) => struct("epoll_event", [["events", u32], ["data", union("epoll_data", [["ptr", ptr()], ["fd", T.int], ["u32", u32], ["u64", u64]])]], { packed: t === "x86_64-linux" || t === "i386-linux" }),
    code: ["typedef union epoll_data {", "    void *ptr; int fd; uint32_t u32; uint64_t u64;", "} epoll_data_t;", "struct epoll_event {", "    uint32_t events;", "    epoll_data_t data;", "} __EPOLL_PACKED;  // packed on x86 only"],
    note: "Packed on x86, so that one layout serves 32-bit and 64-bit programs: 12 bytes, data at offset 4. AArch64 and RISC-V do not pack it: 16 bytes, data at 8.",
    checked: { "x86_64-linux": 12, "i386-linux": 12, "aarch64-linux": 16, "riscv64-linux": 16 },
  },
];

// ---------------------------------------------------------------- packed access

export const PackedHeader = struct("Header", [["tag", u8], ["len", u32]], { packed: true });

export type PackedWay = "field" | "pointer" | "memcpy";

export interface PackedResult {
  /** Address of h[i].len. */
  addr: number;
  misaligned: boolean;
  ub: UbReport | null;
}

/** h is a packed array `struct Header h[count]` at a 16-byte-aligned address; read h[i].len one of three ways. */
export function packedAccess(i: number, way: PackedWay, count = 8): PackedResult {
  const m = new Machine();
  const lay = layoutC(PackedHeader);
  m.call("main", [{ name: "n", type: u32 }, { name: "tmp", type: u32 }]);
  const h = m.malloc(lay.size * count);
  m.memset(h, 0, lay.size * count);
  const len = offset(h, i * lay.size + lay.fields.find((f) => f.name === "len")!.offset);
  const before = m.ub.length;
  if (way === "pointer") m.load(len, u32);
  // The compiler knows the field is unaligned: it reads bytes (or uses an unaligned load) and builds the value.
  else if (way === "field") m.load(len, array(u8, 4));
  else m.memcpy(m.addrOf("tmp"), len, 4);
  return { addr: len.addr, misaligned: len.addr % 4 !== 0, ub: m.ub[before] ?? null };
}

// ---------------------------------------------------------------- cache lines

export const CACHE_LINE = 64;

export interface CounterLayout {
  /** Bytes per counter slot. */
  stride: number;
  total: number;
  /** The cache line (index from the 64-byte-aligned start) of each counter. */
  lines: number[];
  /** The largest number of counters that share one line. */
  maxShare: number;
}

/** `threads` counters of 8 bytes, each in a struct with alignas(align) (align 8 = no extra alignment). */
export function counterLayout(threads: number, align: number): CounterLayout {
  const l: Layout = layoutC(struct("counter", [{ name: "n", type: T.long, align: align > 8 ? align : undefined }]));
  const lines = Array.from({ length: threads }, (_, i) => Math.floor((i * l.size) / CACHE_LINE));
  const count = new Map<number, number>();
  for (const x of lines) count.set(x, (count.get(x) ?? 0) + 1);
  return { stride: l.size, total: l.size * threads, lines, maxShare: Math.max(...count.values()) };
}
