/**
 * Foreign function interfaces: strings that cross a language boundary, the cost of a crossing, and a panic that meets
 * C frames. The memory parts run on the shared machine (src/sims/sys/mem), so a missing zero byte, a freed buffer or a
 * leak shows up as the report a sanitizer would print.
 */
import { array, Machine, T, type Ptr, type Snapshot, type UbReport } from "../mem";

// ---------------------------------------------------------------- strings

export type StrCase = "asptr" | "cstring" | "temp" | "go-leak" | "go-free";

export const STR_CASES: { id: StrCase; label: string; lang: "rust" | "go"; source: string[] }[] = [
  { id: "asptr", label: "Rust: s.as_ptr()", lang: "rust", source: [
    'let s: &str = "hello";        // 5 bytes, no zero byte',
    "let n = unsafe { strlen(s.as_ptr().cast()) };",
  ] },
  { id: "cstring", label: "Rust: CString", lang: "rust", source: [
    'let c = CString::new("hello")?;   // copies, adds a zero byte',
    "let n = unsafe { strlen(c.as_ptr()) };",
    "drop(c);                          // frees the copy",
  ] },
  { id: "temp", label: "Rust: temporary CString", lang: "rust", source: [
    'let p = CString::new("hello")?.as_ptr();  // the CString dies here',
    "let n = unsafe { strlen(p) };",
  ] },
  { id: "go-leak", label: "Go: C.CString, no free", lang: "go", source: [
    'cs := C.CString("hello")   // malloc + copy + zero byte',
    "n := C.strlen(cs)",
    "return                     // nobody calls C.free",
  ] },
  { id: "go-free", label: "Go: C.CString + C.free", lang: "go", source: [
    'cs := C.CString("hello")',
    "defer C.free(unsafe.Pointer(cs))",
    "n := C.strlen(cs)",
    "return                     // the deferred C.free runs",
  ] },
];

export interface StrStep { line: number; text: string; snap: Snapshot; ub?: UbReport; /** Bytes strlen has read so far, as [addr, value]. */ scanned: number[]; scanFrom?: number; result?: number }

/** strlen as C runs it: one byte at a time until a zero byte. Every load is checked; record mode keeps going. */
function strlen(m: Machine, p: Ptr, max = 64): { n: number; ub?: UbReport; scanned: number[] } {
  const before = m.ub.length;
  const scanned: number[] = [];
  for (let i = 0; i < max; i++) {
    const v = m.load({ addr: p.addr + i, alloc: p.alloc }, T.u8) as number;
    scanned.push(v ?? 0);
    if (!v) return { n: i, ub: m.ub[before], scanned };
  }
  return { n: max, ub: m.ub[before], scanned };
}

const enc = (s: string) => [...new TextEncoder().encode(s)];

export function strTrace(c: StrCase): StrStep[] {
  const m = new Machine();
  const steps: StrStep[] = [];
  const push = (line: number, text: string, extra: Partial<StrStep> = {}) => steps.push({ line, text, snap: m.snapshot(), scanned: [], ...extra });
  const copy = (label: string) => {
    const p = m.malloc(6, 16, label);
    enc("hello").forEach((b, i) => m.store({ addr: p.addr + i, alloc: p.alloc }, T.u8, b));
    m.store({ addr: p.addr + 5, alloc: p.alloc }, T.u8, 0);
    return p;
  };
  switch (c) {
    case "asptr": {
      const s = m.global("s (str bytes)", array(T.u8, 5), enc("hello"));
      m.global("next static", array(T.u8, 3), [42, 7, 0]);
      m.call("main", [{ name: "n", type: T.usize }]);
      push(0, "A &str is a pointer and a length: 5 bytes, with no zero byte after them. Here the next static, the bytes 42, 7, 0, follows in memory.");
      const r = strlen(m, s);
      m.set("n", r.n);
      push(1, `C's strlen does not know the length. It reads until it finds a zero byte: ${r.n} bytes, not 5. It read past the end of the string.`, { ub: r.ub, scanned: r.scanned, scanFrom: s.addr, result: r.n });
      break;
    }
    case "cstring": {
      m.call("main", [{ name: "c", type: { k: "ptr", to: T.char, own: "raw", label: "CString" } }, { name: "n", type: T.usize }]);
      const p = copy("CString \"hello\\0\"");
      m.set("c", p);
      push(0, "CString::new copies the 5 bytes to the heap and adds a zero byte. It returns an error if the text has a zero byte inside it.");
      const r = strlen(m, p);
      m.set("n", r.n);
      push(1, `strlen finds the zero byte at index 5: n = ${r.n}.`, { scanned: r.scanned, scanFrom: p.addr, result: r.n });
      m.free(p);
      push(2, "Dropping the CString frees the copy. Rust allocated it, so Rust frees it.");
      break;
    }
    case "temp": {
      m.call("main", [{ name: "p", type: { k: "ptr", to: T.char, own: "raw" } }, { name: "n", type: T.usize }]);
      const p = copy("CString (temporary)");
      m.set("p", p);
      m.free(p);
      push(0, "The CString is a temporary. It is dropped at the end of the statement, so p already points to freed memory. rustc 1.96 warns: dangling_pointers_from_temporaries.");
      const r = strlen(m, p);
      m.set("n", r.n);
      push(1, `strlen reads freed memory. Here the old bytes are still there, so it returns ${r.n} and looks correct. The next allocation can change them.`, { ub: r.ub, scanned: r.scanned, scanFrom: p.addr, result: r.n });
      break;
    }
    case "go-leak":
    case "go-free": {
      const free = c === "go-free";
      m.call("main", [{ name: "cs", type: { k: "ptr", to: T.char, own: "raw" } }, { name: "n", type: T.usize }]);
      const p = copy("C.CString(\"hello\")");
      m.set("cs", p);
      push(0, "C.CString calls C's malloc and copies the Go string into it, with a zero byte. The Go garbage collector does not see this memory.");
      if (free) push(1, "defer C.free(...) schedules the free for the end of the function.");
      const r = strlen(m, p);
      m.set("n", r.n);
      push(free ? 2 : 1, `C.strlen returns ${r.n}.`, { scanned: r.scanned, scanFrom: p.addr, result: r.n });
      if (free) m.free(p);
      m.exit();
      const leak = m.ub.find((u) => u.kind === "memory-leak");
      push(free ? 3 : 2, free ? "The deferred C.free runs. At exit, nothing is left on the C heap." : "The function returns. The only pointer to the 6 bytes is gone, and no garbage collector will ever free them.", { ub: leak });
      break;
    }
  }
  return steps;
}

// ---------------------------------------------------------------- the cost of a crossing

/**
 * MEASURED model inputs, on one machine: Apple M4 Pro, macOS, while other jobs ran (load average about 6).
 * Each is the time of one call of `int add1(int x) { return x + 1; }` in a loop, where the next call needs the result
 * of the last one. Median of 3 to 5 runs:
 * - Go: go test -bench, go 1.25.6, darwin/arm64. A //go:noinline Go function: 0.77 ns. The same function in C via cgo:
 *   22.8 ns.
 * - Rust: rustc 1.96.1 -O, the C function in a static library built with clang -O2 (no LTO, so no inlining):
 *   1.74 ns, the same as a #[inline(never)] Rust function (1.74 ns).
 * - Python 3.9.6 (the macOS system Python): a Python function 63 ns; the C function through ctypes 152 ns.
 * These are not constants of nature: they depend on the CPU, the versions and the load.
 */
export const CROSSING = {
  go: { native: 0.77, foreign: 22.8, label: "Go → C (cgo)", nativeLabel: "Go → Go" },
  rust: { native: 1.74, foreign: 1.74, label: "Rust → C (extern \"C\")", nativeLabel: "Rust → Rust" },
  python: { native: 63, foreign: 152, label: "Python → C (ctypes)", nativeLabel: "Python → Python" },
} as const;
export type Lang = keyof typeof CROSSING;
export const LANGS = Object.keys(CROSSING) as Lang[];

export interface CrossCost { total: number; crossing: number; work: number; share: number; crossings: number }

/**
 * Time to process `items` items when the foreign function does `work` ns per item and one call handles `batch` items.
 * The crossing cost is paid once per call.
 */
export function crossCost(lang: Lang, work: number, items: number, batch = 1): CrossCost {
  const crossings = Math.ceil(items / Math.max(1, batch));
  const crossing = crossings * CROSSING[lang].foreign;
  const w = items * work;
  return { total: crossing + w, crossing, work: w, share: crossing / (crossing + w), crossings };
}

/** The work per call at which the crossing is half of the time. */
export const breakEven = (lang: Lang, batch = 1) => CROSSING[lang].foreign / Math.max(1, batch);

// ---------------------------------------------------------------- panics and C frames

export type UnwindMode = "c" | "c-unwind" | "catch";

export const UNWIND_SOURCE: Record<UnwindMode, string[]> = {
  c: [
    'extern "C" fn cmp(a: *const c_void, b: *const c_void) -> c_int {',
    '    panic!("bad data")',
    "}",
    "let r = catch_unwind(|| unsafe { qsort(base, n, 4, cmp) });",
  ],
  "c-unwind": [
    'extern "C-unwind" fn cmp(a: *const c_void, b: *const c_void) -> c_int {',
    '    panic!("bad data")',
    "}",
    "let r = catch_unwind(|| unsafe { qsort(base, n, 4, cmp) });  // qsort declared \"C-unwind\"",
  ],
  catch: [
    'extern "C" fn cmp(a: *const c_void, b: *const c_void) -> c_int {',
    '    match catch_unwind(|| compare(a, b)) { Ok(v) => v, Err(e) => { save(e); 0 } }',
    "}",
    "unsafe { qsort(base, n, 4, cmp) }; if let Some(e) = take() { resume_unwind(e) }",
  ],
};

export interface UnwindStep { line: number; text: string; snap: Snapshot; outcome?: "abort" | "caught" | "ok"; frameLang: Record<string, "Rust" | "C"> }

/**
 * main (Rust) holds a Vec, calls qsort (C, from libc), which calls cmp (Rust). cmp panics. Behaviour checked with
 * rustc 1.96.1 on macOS: with extern "C" the process prints "panic in a function that cannot unwind" and aborts
 * (SIGABRT, exit status 134), and catch_unwind never runs; with "C-unwind" on cmp and on the qsort declaration,
 * catch_unwind catches the panic.
 */
export function unwindTrace(mode: UnwindMode): UnwindStep[] {
  const m = new Machine();
  const lang: Record<string, "Rust" | "C"> = { main: "Rust", qsort: "C", cmp: "Rust", "catch_unwind closure": "Rust" };
  const steps: UnwindStep[] = [];
  const push = (line: number, text: string, outcome?: UnwindStep["outcome"]) => steps.push({ line, text, snap: m.snapshot(), outcome, frameLang: lang });
  m.call("main", [{ name: "names", type: { k: "ptr", to: T.char, own: "box", label: "Vec<String>" } }, { name: "v", type: array(T.i32, 3), value: [3, 1, 2] }]);
  const vec = m.malloc(48, 16, "Vec<String> buffer");
  m.set("names", vec);
  push(3, "main owns a Vec on the heap. Its destructor must run once, whatever happens.");
  m.call("qsort", [{ name: "base", type: { k: "ptr", to: T.i32, own: "raw" }, value: m.addrOf("v") }, { name: "i", type: T.long, value: 0 }]);
  push(3, "qsort is C code in libc. Its frame has no destructors and no cleanup code.");
  m.call("cmp", [{ name: "a", type: { k: "ptr", to: T.i32, own: "raw" } }, { name: "b", type: { k: "ptr", to: T.i32, own: "raw" } }]);
  push(0, "qsort calls back into Rust through a function pointer: cmp.");
  if (mode === "catch") {
    push(1, "compare panics inside catch_unwind, within cmp. The unwinder stops at cmp's catch_unwind, so no panic reaches the C frame.");
    m.ret();
    push(1, "cmp saves the panic payload and returns 0 to qsort, a normal return through the C ABI.");
    m.ret();
    push(3, "qsort finishes normally (with a meaningless order). main takes the saved payload and calls resume_unwind: the panic continues in Rust frames only.", "ok");
    m.free(vec);
    m.ret();
    push(3, "The panic unwinds main, and the Vec is dropped. Every frame that the panic crossed was a Rust frame.", "ok");
    return steps;
  }
  push(1, "cmp panics. The unwinder starts to walk up the stack, frame by frame, with the unwind tables.");
  if (mode === "c") {
    push(2, "cmp is extern \"C\": it promises not to unwind. Since Rust 1.81 the panic stops at this boundary: \"panic in a function that cannot unwind\", then abort.", "abort");
    return steps;
  }
  m.ret();
  push(2, "cmp is extern \"C-unwind\", so the unwind may leave it. cmp's frame is gone.");
  m.ret();
  push(3, "The unwinder passes through qsort's C frame. C has no cleanup to run, but qsort may leave the array half sorted.");
  push(3, "catch_unwind in main stops the panic. r is Err(payload).", "caught");
  m.free(vec);
  m.ret();
  push(3, "main returns, and the Vec is dropped normally.", "caught");
  return steps;
}
