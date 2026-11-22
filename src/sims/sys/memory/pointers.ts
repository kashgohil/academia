/**
 * Pointers, references and fat pointers.
 *
 * - arith: C pointer arithmetic on an array, run on the shared machine: `p + i` moves by i * sizeof(T); one past the
 *   end may be formed but not dereferenced (C11 6.5.6p8); further out is undefined even to form.
 * - FAT_POINTERS: the words of pointer-like types in Rust, Go, Zig and C++ on a 64-bit target, with sizes checked
 *   with rustc 1.96 (size_of), go1.25.6 (unsafe.Sizeof), zig 0.17.1 (@sizeOf) and Apple clang 21 with libc++
 *   (sizeof).
 * - Growth policies: Go's append (runtime/slice.go nextslicecap and growslice, runtime/msize.go roundupsize and the
 *   size classes of internal/runtime/gc/sizeclasses.go, go1.25.6; element types without pointers only), Rust's
 *   Vec (library/alloc/src/raw_vec/mod.rs grow_amortized and min_non_zero_cap, rustc 1.96) and libc++'s vector
 *   (doubling: max(2 * capacity, new size); checked: capacity 3 becomes 6).
 * - HOLD: one program in three languages that keeps a pointer into a growable array and then appends to it.
 */
import { array, layoutC, Machine, NULL, offset, ptr, struct, T, type Ptr, type Type, type UbReport } from "../mem";
import type { StepFn } from "./script";

// ---------------------------------------------------------------- pointer arithmetic

export interface ElemChoice { id: string; label: string; type: Type }

export const ELEMS: ElemChoice[] = [
  { id: "char", label: "char", type: T.char },
  { id: "short", label: "short", type: T.short },
  { id: "int", label: "int", type: T.int },
  { id: "double", label: "double", type: T.double },
  { id: "point", label: "struct point (12 B)", type: struct("point", [["x", T.int], ["y", T.int], ["z", T.int]]) },
];

export type ArithStatus = "in-bounds" | "one-past" | "out-of-bounds" | "negative";

export interface ArithResult {
  size: number;
  base: number;
  addr: number;
  status: ArithStatus;
  /** The UB report of the machine for `*(p + i)`, if any. */
  ub: UbReport | null;
}

/** `int *p = malloc(count * sizeof(T)); ... *(p + i)` on the machine. */
export function arith(elem: Type, count: number, i: number): ArithResult {
  const size = layoutC(elem).size;
  const m = new Machine();
  m.call("main", [{ name: "p", type: ptr(elem) }]);
  const p = m.malloc(count * size);
  m.memset(p, 0, count * size);
  const q = offset(p, i * size);
  const before = m.ub.length;
  if (elem.k === "struct") m.load(m.field(q, elem, elem.fields[0]!.name), elem.fields[0]!.type);
  else m.load(q, elem);
  const ub = m.ub[before] ?? null;
  const status: ArithStatus = i < 0 ? "negative" : i < count ? "in-bounds" : i === count ? "one-past" : "out-of-bounds";
  return { size, base: p.addr, addr: q.addr, status, ub };
}

// ---------------------------------------------------------------- fat pointers

export interface Word { name: string; bytes: number; to?: "data" | "vtable" | "none" }

export interface FatPointer {
  id: string;
  lang: "C" | "C++" | "Rust" | "Go" | "Zig";
  type: string;
  words: Word[];
  /** Checked size in bytes on a 64-bit target. */
  size: number;
  /** Does the pointer know the length? Can it be null? */
  len: boolean;
  nullable: string;
  note: string;
  /** For the slicing view: "slice" (ptr, len), "goslice" (ptr, len, cap), "vec" (ptr, cap, len), "thin", "dyn". */
  shape: "thin" | "slice" | "goslice" | "vec" | "dyn";
}

export const FAT_POINTERS: FatPointer[] = [
  { id: "c-ptr", lang: "C", type: "int *", words: [{ name: "ptr", bytes: 8, to: "data" }], size: 8, len: false, nullable: "yes", shape: "thin",
    note: "An address and nothing else. The length travels in a separate variable, or as a terminator such as the 0 byte of a C string." },
  { id: "cpp-span", lang: "C++", type: "std::span<int>", words: [{ name: "ptr", bytes: 8, to: "data" }, { name: "size", bytes: 8 }], size: 16, len: true, nullable: "empty span", shape: "slice",
    note: "C++20. A dynamic-extent span is (pointer, size). std::string_view has the same shape." },
  { id: "rs-ref", lang: "Rust", type: "&u32", words: [{ name: "ptr", bytes: 8, to: "data" }], size: 8, len: false, nullable: "never: Option<&u32> is still 8 bytes", shape: "thin",
    note: "A thin reference: the type gives the size, so one word is enough." },
  { id: "rs-slice", lang: "Rust", type: "&[u32]", words: [{ name: "ptr", bytes: 8, to: "data" }, { name: "len", bytes: 8 }], size: 16, len: true, nullable: "never", shape: "slice",
    note: "A fat pointer: address and element count. &str is the same, with a length in bytes of UTF-8." },
  { id: "rs-dyn", lang: "Rust", type: "&dyn Shape", words: [{ name: "data", bytes: 8, to: "data" }, { name: "vtable", bytes: 8, to: "vtable" }], size: 16, len: false, nullable: "never", shape: "dyn",
    note: "The second word points to a vtable: drop, size, align, then the trait's methods. Box<dyn Shape> has the same two words. The word order is what rustc does today, not a guarantee." },
  { id: "rs-vec", lang: "Rust", type: "Vec<u32>", words: [{ name: "ptr", bytes: 8, to: "data" }, { name: "cap", bytes: 8 }, { name: "len", bytes: 8 }], size: 24, len: true, nullable: "never", shape: "vec",
    note: "Not a pointer but an owner: three words on the stack, the elements on the heap. The field order is not specified." },
  { id: "go-slice", lang: "Go", type: "[]int32", words: [{ name: "ptr", bytes: 8, to: "data" }, { name: "len", bytes: 8 }, { name: "cap", bytes: 8 }], size: 24, len: true, nullable: "nil slice: ptr 0, len 0", shape: "goslice",
    note: "A slice is a view with a capacity. Two slices can share one backing array, and append writes into it while len < cap." },
  { id: "go-string", lang: "Go", type: "string", words: [{ name: "ptr", bytes: 8, to: "data" }, { name: "len", bytes: 8 }], size: 16, len: true, nullable: "no (\"\" has len 0)", shape: "slice",
    note: "Immutable bytes, so substrings share the data with no copy." },
  { id: "go-iface", lang: "Go", type: "interface (any, error)", words: [{ name: "type/itab", bytes: 8, to: "vtable" }, { name: "data", bytes: 8, to: "data" }], size: 16, len: false, nullable: "nil: both words 0", shape: "dyn",
    note: "Type information first, then a pointer to the value. An interface that holds a nil pointer is not a nil interface." },
  { id: "zig-ptr", lang: "Zig", type: "*u32", words: [{ name: "ptr", bytes: 8, to: "data" }], size: 8, len: false, nullable: "never: use ?*u32 (still 8 bytes)", shape: "thin",
    note: "A single-item pointer: no arithmetic. [*]u32 is the many-item pointer that allows it." },
  { id: "zig-slice", lang: "Zig", type: "[]u32", words: [{ name: "ptr", bytes: 8, to: "data" }, { name: "len", bytes: 8 }], size: 16, len: true, nullable: "never: use ?[]u32 (16 bytes)", shape: "slice",
    note: "A pointer and a length. Indexing checks the length in Debug and ReleaseSafe." },
];

export interface SliceView {
  /** Index in the backing array where the view starts. */
  from: number;
  len: number;
  /** Go slices only: elements from `from` to the end of the backing array. */
  cap?: number;
  /** Address of the first element, for a backing array at `base` with elements of `elem` bytes. */
  ptr: number;
}

/** `s[a:b]` (Go), `&s[a..b]` (Rust) or `s[a..b]` (Zig) of a backing array of `total` elements. */
export function sliceOf(shape: FatPointer["shape"], total: number, a: number, b: number, base: number, elem: number): SliceView {
  const lo = Math.max(0, Math.min(a, total));
  const hi = Math.max(lo, Math.min(b, total));
  return { from: lo, len: hi - lo, cap: shape === "goslice" ? total - lo : undefined, ptr: base + lo * elem };
}

// ---------------------------------------------------------------- growth policies

/** Go size classes in bytes (internal/runtime/gc/sizeclasses.go, go1.25.6). Class 0 is unused. */
export const GO_SIZE_CLASSES = [
  0, 8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 288, 320, 352, 384, 416, 448, 480,
  512, 576, 640, 704, 768, 896, 1024, 1152, 1280, 1408, 1536, 1792, 2048, 2304, 2688, 3072, 3200, 3456, 4096, 4864, 5376,
  6144, 6528, 6784, 6912, 8192, 9472, 9728, 10240, 10880, 12288, 13568, 14336, 16384, 18432, 19072, 20480, 21760, 24576,
  27264, 28672, 32768,
];
export const GO_MAX_SMALL = 32768;
export const GO_MALLOC_HEADER = 8;
export const GO_PAGE = 8192;

/** runtime.roundupsize for an object with no pointers (noscan): the size class, or whole 8 KiB pages if large. */
export function goRoundupsize(size: number): number {
  if (size <= GO_MAX_SMALL - GO_MALLOC_HEADER) return GO_SIZE_CLASSES.find((c) => c >= size)!;
  return Math.ceil(size / GO_PAGE) * GO_PAGE;
}

/** runtime.nextslicecap: double below 256 elements, then grow by (newcap + 768) / 4 until it fits. */
export function goNextSliceCap(newLen: number, oldCap: number): number {
  let newcap = oldCap;
  const doublecap = newcap + newcap;
  if (newLen > doublecap) return newLen;
  const threshold = 256;
  if (oldCap < threshold) return doublecap;
  for (;;) {
    newcap += (newcap + 3 * threshold) >> 2;
    if (newcap >= newLen) break;
  }
  return newcap;
}

/** The capacity after `append` grows a slice of capacity oldCap to newLen elements of `elem` bytes (no pointers). */
export const goGrow = (newLen: number, oldCap: number, elem: number) => Math.floor(goRoundupsize(goNextSliceCap(newLen, oldCap) * elem) / elem);

/** Rust RawVec::grow_amortized: max(2 * cap, needed, min_non_zero_cap(elem size)). */
export const rustMinNonZeroCap = (elem: number) => (elem === 1 ? 8 : elem <= 1024 ? 4 : 1);
export const rustGrow = (needed: number, cap: number, elem: number) => Math.max(cap * 2, needed, rustMinNonZeroCap(elem));

/** libc++ vector::__recommend: max(2 * capacity, new size). */
export const cppGrow = (needed: number, cap: number) => Math.max(cap * 2, needed);

export type Policy = "go" | "rust" | "cpp";

export interface GrowthRun {
  /** Capacity after each push, for pushes 1..n. */
  caps: number[];
  /** Number of reallocations. */
  reallocs: number;
  /** Elements copied by all reallocations. */
  copied: number;
}

/**
 * Push n elements one at a time onto an empty array. `goStackBuf`: Go 1.25 gives a slice that does not escape a
 * 32-byte stack buffer for its first backing array (cmd/compile VariableMakeThreshold; checked: a local []int starts
 * at cap 4 and a local []byte at cap 32). Pass 0 for a slice that escapes (heap only).
 */
export function pushAll(policy: Policy, n: number, elem: number, goStackBuf = 0): GrowthRun {
  let cap = 0;
  let reallocs = 0;
  let copied = 0;
  const caps: number[] = [];
  for (let len = 1; len <= n; len++) {
    if (len > cap) {
      copied += len - 1;
      const buf = cap === 0 && policy === "go" ? Math.floor(goStackBuf / elem) : 0;
      cap = buf >= len ? buf : policy === "go" ? goGrow(len, cap, elem) : policy === "rust" ? rustGrow(len, cap, elem) : cppGrow(len, cap);
      reallocs++;
    }
    caps.push(cap);
  }
  return { caps, reallocs, copied };
}

/** The distinct capacities in a run, in order. */
export const distinctCaps = (caps: number[]) => caps.filter((c, i) => i === 0 || c !== caps[i - 1]);

// ---------------------------------------------------------------- hold a pointer, then grow

export type HoldLang = "go" | "cpp" | "rust";

export interface HoldProgram {
  lang: HoldLang;
  label: string;
  source: string[];
  compiler?: { tool: string; text: string[] };
  fixSource?: string[];
  output: string;
  outcome: string;
  script: (m: Machine, step: StepFn) => void;
}

const goInt: Type = { ...T.i64, label: "int" };
const i32: Type = T.i32;
const GoSlice = struct("slice", [["ptr", ptr(goInt)], ["len", goInt], ["cap", goInt]]);
const CppVec = struct("vector", [["begin", ptr(T.int)], ["end", ptr(T.int)], ["cap_end", ptr(T.int)]]);
const RsVec = struct("Vec", [["ptr", ptr(i32)], ["cap", T.usize], ["len", T.usize]]);

const goScript = (m: Machine, step: StepFn) => {
  let a: Ptr = NULL;
  let b: Ptr = NULL;
  step(5, "main starts. s is a slice header (3 words); p is a pointer.", () => m.call("main", [{ name: "s", type: GoSlice }, { name: "p", type: ptr(goInt) }]));
  step(6, "s := []int{1, 2, 3}: a backing array A of 3 ints, and s = (A, len 3, cap 3).", () => {
    a = m.allocNamed("[3]int", "A", { type: array(goInt, 3) });
    m.store(a, array(goInt, 3), [1, 2, 3]);
    m.store(m.addrOf("s"), GoSlice, { ptr: a, len: 3, cap: 3 });
  });
  step(7, "p := &s[0] points into A.", () => m.set("p", a));
  step(8, `append needs len 4 but cap is 3. growslice picks cap ${goGrow(4, 3, 8)}, copies 1, 2, 3 to a new array B, and adds 4.`, () => {
    const cap = goGrow(4, 3, 8);
    b = m.allocNamed(`[${cap}]int`, "B", { type: array(goInt, cap) });
    m.memcpy(b, a, 24);
    m.store(offset(b, 24), goInt, 4);
    m.store(m.addrOf("s"), GoSlice, { ptr: b, len: 4, cap });
  });
  step(9, "*p = 99 writes A, not B. A is still valid memory: p keeps it alive for the garbage collector.", () => m.store(m.get("p") as Ptr, goInt, 99));
  step(10, "Println(s[0], *p) prints 1 99. No crash and no UB, but the write is lost for s.", () => { m.load(b, goInt); m.load(a, goInt); });
  step(11, "main returns. Later the GC frees A and B.", () => { m.ret(); m.free(a); m.free(b); m.exit(0); });
};

const cppScript = (m: Machine, step: StepFn) => {
  let a: Ptr = NULL;
  let b: Ptr = NULL;
  step(3, "main starts. v is three pointers (libc++: begin, end, end of capacity); first is a reference.", () => m.call("main", [{ name: "v", type: CppVec }, { name: "first", type: ptr(T.int) }]));
  step(4, "v = {1, 2, 3}: a 12-byte block A with capacity 3.", () => {
    a = m.malloc(12, 16, "A");
    m.store(a, array(T.int, 3), [1, 2, 3]);
    m.store(m.addrOf("v"), CppVec, { begin: a, end: offset(a, 12), cap_end: offset(a, 12) });
  });
  step(5, "int &first = v[0]. A reference is an address in memory too.", () => m.set("first", a));
  step(6, `push_back(4) is full: it allocates B for ${cppGrow(4, 3)} ints, moves 1, 2, 3, adds 4 and frees A.`, () => {
    b = m.malloc(4 * cppGrow(4, 3), 16, "B");
    m.memcpy(b, a, 12);
    m.store(offset(b, 12), T.int, 4);
    m.free(a);
    m.store(m.addrOf("v"), CppVec, { begin: b, end: offset(b, 16), cap_end: offset(b, 24) });
  });
  step(7, "first = 99 writes freed memory. AddressSanitizer reports heap-use-after-free (checked with Apple clang 21).", () => m.store(m.get("first") as Ptr, T.int, 99));
  step(8, "printf reads v[0] from B: 1.", () => { m.load(b, T.int); });
  step(9, "The destructor of v frees B.", () => { m.free(b); m.ret(); m.exit(0); });
};

const rustScript = (m: Machine, step: StepFn) => {
  let a: Ptr = NULL;
  step(1, "main starts. v is a Vec: pointer, capacity and length.", () => m.call("main", [{ name: "v", type: RsVec }, { name: "first", type: T.usize }]));
  step(2, "vec![1, 2, 3]: a 12-byte heap block with capacity 3.", () => {
    a = m.malloc(12, 16, "buf");
    m.store(a, array(i32, 3), [1, 2, 3]);
    m.store(m.addrOf("v"), RsVec, { ptr: a, cap: 3, len: 3 });
  });
  step(3, "first = 0: an index, not a reference. It stays valid when the buffer moves.", () => m.set("first", 0));
  step(4, `push(4) is full: grow_amortized picks max(2 × 3, 4) = ${rustGrow(4, 3, 4)}, and realloc moves the buffer.`, () => {
    const cap = rustGrow(4, 3, 4);
    const b = m.realloc(a, cap * 4);
    a = b;
    m.store(offset(b, 12), i32, 4);
    m.store(m.addrOf("v"), RsVec, { ptr: b, cap, len: 4 });
  });
  step(5, "v[first] = 99 goes through v, so it uses the new buffer. The index is checked against len.", () => m.store(a, i32, 99));
  step(6, "println! prints 99 6.", () => { m.load(a, i32); });
  step(7, "v is dropped: Drop frees the buffer.", () => { m.free(a); m.ret(); m.exit(0); });
};

export const HOLD: HoldProgram[] = [
  {
    lang: "go", label: "Go",
    source: ["package main", "", "import \"fmt\"", "", "func main() {", "    s := []int{1, 2, 3}", "    p := &s[0]", "    s = append(s, 4)", "    *p = 99", "    fmt.Println(s[0], *p)", "}"],
    output: "1 99",
    outcome: "Memory-safe, but p and s now see different arrays. The write through p is lost for s.",
    script: goScript,
  },
  {
    lang: "cpp", label: "C++",
    source: ["#include <vector>", "#include <cstdio>", "int main() {", "    std::vector<int> v = {1, 2, 3};", "    int &first = v[0];", "    v.push_back(4);", "    first = 99;", "    std::printf(\"%d\\n\", v[0]);", "}"],
    output: "1 (without ASan); with -fsanitize=address: heap-use-after-free",
    outcome: "first dangles after the reallocation. The write is undefined behavior.",
    script: cppScript,
  },
  {
    lang: "rust", label: "Rust",
    source: ["fn main() {", "    let mut v = vec![1, 2, 3];", "    let first = &mut v[0];", "    v.push(4);", "    *first = 99;", "    println!(\"{} {}\", v[0], v.capacity());", "}"],
    compiler: { tool: "rustc 1.96", text: ["error[E0499]: cannot borrow `v` as mutable more than once at a time", "3 |     let first = &mut v[0];", "  |                      - first mutable borrow occurs here", "4 |     v.push(4);", "  |     ^ second mutable borrow occurs here", "5 |     *first = 99;", "  |     ----------- first borrow later used here"] },
    fixSource: ["fn main() {", "    let mut v = vec![1, 2, 3];", "    let first = 0; // an index, not a reference", "    v.push(4);", "    v[first] = 99;", "    println!(\"{} {}\", v[0], v.capacity());", "}"],
    output: "99 6 (the fixed program)",
    outcome: "The borrow checker rejects it: push needs &mut v while first still borrows v.",
    script: rustScript,
  },
];
