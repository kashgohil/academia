/**
 * Stack and heap: where a value lives, and why lifetime decides it.
 *
 * - RETURN_LOCAL: one program in four languages. A function returns the address of its local variable. C compiles it
 *   and the pointer dangles; Rust refuses it; Zig refuses the direct form but not a pointer that goes through a
 *   variable; Go moves the variable to the heap. Each runnable version is a script for the shared machine.
 * - ESCAPE_CASES: small Go functions with the verdict of the escape analysis, as `go build -gcflags=-m` printed it.
 * - Stack budgets: the stack sizes of the main thread, of a thread and of a goroutine, the depth that a recursion
 *   reaches, and the growth of a goroutine stack by copying.
 *
 * Facts (checked): Linux's default stack limit `_STK_LIM` is 8 MiB (include/uapi/linux/resource.h), so `ulimit -s`
 * shows 8192. glibc's NPTL takes the default thread stack size from RLIMIT_STACK at program start, or 2 MB on most
 * architectures when the limit is "unlimited" (man 3 pthread_create, NOTES). Rust's std gives a spawned thread 2 MiB
 * (`DEFAULT_MIN_STACK_SIZE` in library/std/src/sys/thread/unix.rs, rustc 1.96; `RUST_MIN_STACK` overrides it). Go 1.25:
 * a goroutine starts with `fixedStack` = stackMin (2048) + stackSystem, rounded up to a power of two (runtime/stack.go):
 * 2 KiB on Linux and macOS, 4 KiB on iOS, 8 KiB on Windows; the stack doubles in `newstack` (`newsize := oldsize * 2`), and
 * `maxstacksize = 1000000000` on 64-bit (runtime/proc.go). Since the size is a power of two, the largest stack that
 * fits under the limit is 2²⁹ bytes (512 MiB); the next doubling fails with "goroutine stack exceeds
 * 1000000000-byte limit" (go1.25.6, checked: the failing stack was [0x140201e0000, 0x140401e0000), 512 MiB).
 * Go 1.19 and later can start a goroutine with a larger stack (`adaptivestackstart`, on by default in 1.25): the
 * average scanned stack size at the last GC. This model starts at 2 KiB.
 *
 * Model inputs (not measurements): HEAP_ALLOC_NS, the cost of one small heap allocation.
 */
import { NULL, T, box, ptr, type Machine, type Ptr } from "../mem";
import type { StepFn } from "./script";

// ---------------------------------------------------------------- returning the address of a local

export type Lang = "c" | "rust" | "zig" | "go";

export interface LangProgram {
  lang: Lang;
  label: string;
  /** The program that the learner asks about. */
  source: string[];
  /** What the toolchain said about `source`, verbatim, and which toolchain. */
  compiler: { tool: string; text: string[]; verdict: "error" | "warning" | "silent" | "note" };
  /** The program that runs on the machine: `source` itself, or a fixed version when `source` does not compile. */
  runs: "source" | "fix";
  fixSource?: string[];
  /** A one-line summary of the result. */
  outcome: string;
  script: (m: Machine, step: StepFn) => void;
}

const int = T.int;

/** C: the frame of `make` dies, and `p` dangles. The read after `other()` sees other's bytes. */
const cScript = (m: Machine, step: StepFn) => {
  let px: Ptr = NULL;
  step(9, "main starts. Its frame holds p, a and b, all uninitialized.", () => m.call("main", [{ name: "p", type: ptr(int) }, { name: "a", type: int }, { name: "b", type: int }]));
  step(1, "make gets a frame below main's frame.", () => m.call("make", [{ name: "x", type: int }]));
  step(2, "x = 42 writes 4 bytes in make's frame.", () => m.set("x", 42));
  step(3, "make returns &x. Its frame is free stack now, so p points at a dead object.", () => { px = m.addrOf("x"); m.ret(); m.set("p", px); });
  step(11, "*p reads the dead x. A sanitizer reports it. With clang the hardware reads the old 42 (GCC would have returned a null pointer, and this read would crash).", () => m.set("a", m.load(m.get("p") as Ptr, int)));
  step(5, "other gets a frame at the same addresses that make had.", () => m.call("other", [{ name: "z", type: int }]));
  step(6, "z = 7 writes over the bytes of the dead x.", () => m.set("z", 7));
  step(7, "other returns.", () => m.ret());
  step(13, "*p reads the same address again and gets 7. The value depends on which function ran last.", () => m.set("b", m.load(m.get("p") as Ptr, int)));
  step(14, "main returns.", () => m.exit(0));
};

/** Zig: the indirect form compiles, and it runs like the C program. */
const zigScript = (m: Machine, step: StepFn) => {
  let px: Ptr = NULL;
  step(12, "main starts. p and v are uninitialized.", () => m.call("main", [{ name: "p", type: ptr(T.i32) }, { name: "v", type: T.i32 }]));
  step(3, "make gets a frame. x = 42.", () => { m.call("make", [{ name: "x", type: T.i32 }, { name: "q", type: ptr(T.i32) }]); m.set("x", 42); });
  step(4, "q = &x. The compiler does not follow the address through q.", () => m.set("q", m.addrOf("x")));
  step(5, "make returns q. The frame dies, and p points into it.", () => { px = m.get("q") as Ptr; m.ret(); m.set("p", px); });
  step(8, "other gets a frame at the same addresses as make.", () => { m.call("other", [{ name: "z", type: T.i32 }]); m.set("z", 6); });
  step(9, "z += 1 writes 7 over the bytes of the dead x.", () => m.set("z", 7));
  step(10, "other returns.", () => m.ret());
  step(15, "p.* reads the dead x. Zig has no run-time check for this. This model reads 7; the real program printed 1 (Debug) and 0 (ReleaseFast).", () => m.set("v", m.load(m.get("p") as Ptr, T.i32)));
  step(17, "main returns.", () => m.exit(0));
};

/** Rust: the fix returns a Box. The heap block lives until the Box is dropped. */
const rustFixScript = (m: Machine, step: StepFn) => {
  let b: Ptr = NULL;
  step(5, "main starts. p will hold a Box<i32>: one pointer on the stack.", () => m.call("main", [{ name: "p", type: box(T.i32) }]));
  step(1, "make gets a frame for x.", () => m.call("make", [{ name: "x", type: box(T.i32) }]));
  step(2, "Box::new(42) allocates 4 bytes on the heap and stores 42 there.", () => { b = m.allocNamed("i32", "Box::new(42)", { type: T.i32 }); m.store(b, T.i32, 42); m.set("x", b); });
  step(3, "make returns x. The Box moves into p: the pointer is copied, the heap block stays.", () => { m.ret(); m.set("p", b); });
  step(7, "*p reads 42 from a live heap block.", () => { m.load(m.get("p") as Ptr, T.i32); });
  step(8, "p goes out of scope. Drop for Box frees the block, and the frame goes.", () => { m.free(b); m.ret(); });
  step(8, "The program exits. Nothing leaks and nothing dangles.", () => m.exit(0));
};

/** Go: escape analysis moves x to the heap. The garbage collector frees it later. */
const goScript = (m: Machine, step: StepFn) => {
  let x: Ptr = NULL;
  step(13, "main starts. p is one pointer on the stack.", () => m.call("main", [{ name: "p", type: ptr(int) }]));
  step(5, "newInt gets a frame, but x is not in it: the compiler moved x to the heap.", () => m.call("newInt", []));
  step(6, "x := 42 allocates x on the heap (runtime.newobject) and stores 42.", () => { x = m.allocNamed("int", "x (moved to heap)", { type: int }); m.store(x, int, 42); });
  step(7, "newInt returns &x. Its frame dies, but x does not live in the frame.", () => { m.ret(); m.set("p", x); });
  step(15, "other runs and reuses the stack. The heap is not touched.", () => { m.call("other", [{ name: "z", type: int }]); m.set("z", 7); m.ret(); });
  step(16, "*p reads 42. The program is correct.", () => { m.load(m.get("p") as Ptr, int); });
  step(17, "main returns. No pointer reaches x now, so a later GC cycle frees it.", () => { m.ret(); m.free(x); });
  step(17, "The program exits.", () => m.exit(0));
};

export const RETURN_LOCAL: LangProgram[] = [
  {
    lang: "c", label: "C",
    source: [
      "int *make(void) {",
      "    int x = 42;",
      "    return &x;",
      "}",
      "int other(void) {",
      "    int z = 7;",
      "    return z;",
      "}",
      "int main(void) {",
      "    int *p = make();",
      "    int a = *p;",
      "    other();",
      "    int b = *p;",
      "}",
    ],
    compiler: { tool: "Apple clang 21, -Wall", verdict: "warning", text: ["warning: address of stack memory associated with local variable 'x' returned [-Wreturn-stack-address]"] },
    runs: "source",
    outcome: "It compiles with a warning. p dangles, and each read is undefined behavior.",
    script: cScript,
  },
  {
    lang: "rust", label: "Rust",
    source: [
      "fn make<'a>() -> &'a i32 {",
      "    let x = 42;",
      "    &x",
      "}",
      "fn main() {",
      "    let p = make();",
      "    println!(\"{p}\");",
      "}",
    ],
    compiler: { tool: "rustc 1.96", verdict: "error", text: ["error[E0515]: cannot return reference to local variable `x`", "3 |     &x", "  |     ^^ returns a reference to data owned by the current function"] },
    runs: "fix",
    fixSource: [
      "fn make() -> Box<i32> {",
      "    let x = Box::new(42);",
      "    x",
      "}",
      "fn main() {",
      "    let p = make();",
      "    println!(\"{p}\");",
      "}",
    ],
    outcome: "It does not compile. The fix asks for the heap in the type: Box<i32>.",
    script: rustFixScript,
  },
  {
    lang: "zig", label: "Zig",
    source: [
      "const std = @import(\"std\");",
      "fn make() *i32 {",
      "    var x: i32 = 42;",
      "    const q = &x;",
      "    return q;",
      "}",
      "fn other() i32 {",
      "    var z: i32 = 6;",
      "    z += 1;",
      "    return z;",
      "}",
      "pub fn main() void {",
      "    const p = make();",
      "    _ = other();",
      "    const v = p.*;",
      "    std.debug.print(\"{}\\n\", .{v});",
      "}",
    ],
    compiler: { tool: "zig 0.17.1", verdict: "silent", text: ["(no error for this form)", "`return &x;` directly gives:", "error: returning address of expired local variable 'x'"] },
    runs: "source",
    outcome: "The direct `return &x` is a compile error. Through q it compiles, and p dangles.",
    script: zigScript,
  },
  {
    lang: "go", label: "Go",
    source: [
      "package main",
      "",
      "import \"fmt\"",
      "",
      "func newInt() *int {",
      "    x := 42",
      "    return &x",
      "}",
      "func other() int {",
      "    z := 7",
      "    return z",
      "}",
      "func main() {",
      "    p := newInt()",
      "    other()",
      "    fmt.Println(*p) // 42",
      "}",
    ],
    compiler: { tool: "go 1.25, go build -gcflags='-m -l'", verdict: "note", text: ["./main.go:6:2: moved to heap: x", "./main.go:16:13: ... argument does not escape", "./main.go:16:14: *p escapes to heap"] },
    runs: "source",
    outcome: "It compiles and is correct. The compiler moved x to the heap, and the GC frees it.",
    script: goScript,
  },
];

// ---------------------------------------------------------------- Go escape analysis

export interface EscapeCase {
  id: string;
  title: string;
  code: string[];
  /** Where the value lives. "both": a stack buffer when small, the heap when large (decided at run time). */
  where: "stack" | "heap" | "both";
  /** The lines that `go build -gcflags=-m` printed for this function (go1.25.6, darwin/arm64), file:line removed. */
  output: string[];
  why: string;
}

/**
 * Escape analysis verdicts, from one file compiled with `go build -gcflags=-m` (go1.25.6). "can inline" lines are
 * left out. A case with no output line keeps its variables on the stack.
 */
export const ESCAPE_CASES: EscapeCase[] = [
  { id: "value", title: "Return a value", where: "stack", output: [],
    code: ["func Value() int {", "    x := 42", "    return x", "}"],
    why: "The caller gets a copy of x. Nothing refers to x after the return." },
  { id: "addr", title: "Return a pointer to a local", where: "heap", output: ["moved to heap: x"],
    code: ["func Addr() *int {", "    x := 42", "    return &x", "}"],
    why: "The pointer outlives the frame, so x must live longer than the call." },
  { id: "global", title: "Store a pointer in a global", where: "heap", output: ["moved to heap: x"],
    code: ["var global *int", "", "func Store() {", "    x := 42", "    global = &x", "}"],
    why: "A global lives for the whole program, so x must too." },
  { id: "callee", title: "Pass a pointer down", where: "stack", output: ["p does not escape"],
    code: ["func Sum(p *Point) int { return p.X + p.Y }", "", "func CallSum() int {", "    p := Point{1, 2}", "    return Sum(&p)", "}"],
    why: "Sum only reads through p and keeps no copy. The analysis records this for Sum, so callers can keep p on the stack." },
  { id: "composite", title: "Return &Point{...}", where: "heap", output: ["&Point{...} escapes to heap"],
    code: ["func NewPoint() *Point {", "    return &Point{1, 2}", "}"],
    why: "The same rule as a named local: the address leaves the function." },
  { id: "closure", title: "Return a closure", where: "heap", output: ["moved to heap: n", "func literal escapes to heap"],
    code: ["func Counter() func() int {", "    n := 0", "    return func() int { n++; return n }", "}"],
    why: "The closure keeps n alive after Counter returns, so both go to the heap." },
  { id: "small", title: "make([]byte, 64)", where: "stack", output: ["make([]byte, 64) does not escape"],
    code: ["func Small() int {", "    buf := make([]byte, 64)", "    return len(buf)", "}"],
    why: "The size is a constant, and it is below the 64 KiB limit for implicit stack variables." },
  { id: "big", title: "make([]byte, 65537)", where: "heap", output: ["make([]byte, 65537) escapes to heap"],
    code: ["func Big() int {", "    buf := make([]byte, 65537)", "    return len(buf)", "}"],
    why: "Nothing escapes, but the array is larger than MaxImplicitStackVarSize (64 KiB)." },
  { id: "sized", title: "make([]byte, n)", where: "both", output: ["make([]byte, n) does not escape"],
    code: ["func Sized(n int) int {", "    buf := make([]byte, n)", "    return len(buf)", "}"],
    why: "Since Go 1.25 the compiler reserves a 32-byte stack buffer and uses it when n fits. A larger n still calls the heap allocator at run time." },
  { id: "array", title: "var a [200000]byte", where: "heap", output: ["moved to heap: a"],
    code: ["func Array() int {", "    var a [200000]byte", "    a[1] = 1", "    return int(a[1])", "}"],
    why: "An explicit variable can use the stack up to MaxStackVarSize (128 KiB). This one is larger." },
  { id: "iface", title: "fmt.Println(n)", where: "heap", output: ["... argument does not escape", "n escapes to heap"],
    code: ["func Print(n int) {", "    fmt.Println(n)", "}"],
    why: "Println takes ...any. Converting n to an interface stores it behind a pointer, and the analysis cannot prove that Println keeps no copy." },
];

/** cmd/compile/internal/ir/cfg.go (go1.25): limits for stack variables. */
export const GO_MAX_STACK_VAR = 128 * 1024;
export const GO_MAX_IMPLICIT_STACK_VAR = 64 * 1024;
/** cmd/compile/internal/base/flag.go (go1.25): `VariableMakeThreshold`, the stack buffer for make([]T, n). */
export const GO_VARIABLE_MAKE_BYTES = 32;

/** Where Go puts the backing array of `make([]T, n)` with a variable n: a stack buffer if it fits, else the heap. */
export const goSizedMake = (n: number, elemBytes = 1): "stack" | "heap" =>
  n <= Math.floor(GO_VARIABLE_MAKE_BYTES / elemBytes) ? "stack" : "heap";

// ---------------------------------------------------------------- allocation cost (model)

/** MODEL INPUT: one small heap allocation costs about 20 ns (allocator fast path plus later freeing or GC work). */
export const HEAP_ALLOC_NS = 20;

/** Seconds per second spent on heap allocation for `callsPerSec` calls that each allocate `allocsPerCall` times. */
export const allocTimeShare = (callsPerSec: number, allocsPerCall = 1, ns = HEAP_ALLOC_NS) => (callsPerSec * allocsPerCall * ns) / 1e9;

// ---------------------------------------------------------------- stack budgets

export const KiB = 1024;
export const MiB = 1024 * 1024;

/** Linux `_STK_LIM`: the default RLIMIT_STACK, which is the main thread's stack limit. */
export const LINUX_MAIN_STACK = 8 * MiB;
/** glibc NPTL with RLIMIT_STACK "unlimited" on most architectures (man 3 pthread_create). */
export const GLIBC_THREAD_UNLIMITED = 2 * MiB;
/** Rust std::thread::spawn default (rustc 1.96, Unix). */
export const RUST_THREAD_STACK = 2 * MiB;
/** Go runtime `fixedStack` on Linux and macOS: stackMin (2048) + stackSystem (0) rounded to a power of two. It is 8 KiB on Windows (stackSystem 4096) and 4 KiB on iOS arm64 (stackSystem 1024). */
export const GO_STACK_MIN = 2048;
/** Go runtime `maxstacksize` on 64-bit platforms. */
export const GO_MAX_STACK = 1_000_000_000;
/** Linux `stack_guard_gap`: 256 pages below the main stack that no other mapping may use. */
export const LINUX_GUARD_GAP_PAGES = 256;

export interface StackKind {
  id: "main" | "pthread" | "rust" | "go";
  label: string;
  /** The fixed size, or for Go the limit. */
  limit: number;
  grows: boolean;
  source: string;
}

export const STACK_KINDS: StackKind[] = [
  { id: "main", label: "Linux main thread", limit: LINUX_MAIN_STACK, grows: false, source: "RLIMIT_STACK, default 8 MiB (_STK_LIM)" },
  { id: "pthread", label: "glibc thread when ulimit -s is unlimited", limit: GLIBC_THREAD_UNLIMITED, grows: false, source: "man 3 pthread_create (with a finite RLIMIT_STACK, threads get that limit: 8 MiB by default)" },
  { id: "rust", label: "Rust std::thread::spawn", limit: RUST_THREAD_STACK, grows: false, source: "std::thread docs, 2 MiB" },
  { id: "go", label: "Go goroutine", limit: GO_MAX_STACK, grows: true, source: "runtime/stack.go, proc.go" },
];

/** How many frames of `frameBytes` fit in a fixed stack of `limit` bytes. */
export const maxDepth = (limit: number, frameBytes: number) => Math.floor(limit / frameBytes);

export interface GoGrowth {
  /** The stack size after each growth, starting with the initial size. */
  sizes: number[];
  /** Bytes copied in all growths: each growth copies the used part of the old stack (model: the whole old stack). */
  copied: number;
  /** The final stack size, or the size at which growth failed. */
  size: number;
  overflow: boolean;
}

/**
 * A goroutine stack that must hold `need` bytes. It starts at `start` and doubles until the need fits. A doubling past
 * `GO_MAX_STACK` is a fatal "stack overflow". Model: growth happens when the frames do not fit (the runtime also keeps a
 * guard of about 1 KiB), and each growth copies the full old stack (the runtime copies the used part, which is
 * almost all of it at that moment).
 */
export function goStackGrowth(need: number, start = GO_STACK_MIN, max = GO_MAX_STACK): GoGrowth {
  const sizes = [start];
  let size = start;
  let copied = 0;
  while (size < need) {
    const next = size * 2;
    if (next > max) return { sizes, copied, size, overflow: true };
    copied += size;
    size = next;
    sizes.push(size);
  }
  return { sizes, copied, size, overflow: false };
}

/** The largest goroutine stack: the largest power-of-two multiple of GO_STACK_MIN that is not above GO_MAX_STACK. */
export const goLargestStack = () => {
  let s = GO_STACK_MIN;
  while (s * 2 <= GO_MAX_STACK) s *= 2;
  return s;
};

export interface Budget {
  kind: StackKind;
  used: number;
  /** The bytes that the stack has: the fixed size, or Go's current size. */
  size: number;
  fits: boolean;
  /** The deepest recursion that fits with this frame size. */
  depth: number;
  growths?: number;
  copied?: number;
}

/** The stack use of a recursion `depth` calls deep with `frameBytes` per frame, for each kind of stack. */
export function budgets(frameBytes: number, depth: number): Budget[] {
  const used = frameBytes * depth;
  return STACK_KINDS.map((kind) => {
    if (!kind.grows) return { kind, used, size: kind.limit, fits: used <= kind.limit, depth: maxDepth(kind.limit, frameBytes) };
    const g = goStackGrowth(used);
    return { kind, used, size: g.size, fits: !g.overflow, depth: maxDepth(goLargestStack(), frameBytes), growths: g.sizes.length - 1, copied: g.copied };
  });
}
