/**
 * Static data: which section a global goes to, what that costs in the file and in memory, and in which order
 * initializers run.
 *
 * - GLOBALS: declarations in C, Rust, Zig and Go with the section that the compiler chose. Every entry was checked
 *   with the named toolchain and `objdump -t` on an x86-64 Linux ELF object (zig 0.17.1 for C and Zig, rustc 1.96
 *   with --target x86_64-unknown-none for Rust, go1.25.6 with GOOS=linux GOARCH=amd64 for Go).
 * - fileAndMemory: section contents in the file and in memory for a set of globals. NOBITS sections (.bss, .tbss,
 *   Go's .noptrbss) take memory but no file bytes. Alignment padding between objects is not modelled: the compiler
 *   chooses the order (clang emits tentative definitions after the others), so only the contents are exact.
 * - initOrder: the order of dynamic initialization in C++ (link order, then declaration order in each file), Go
 *   (dependency order, Go spec "Package initialization"), Rust LazyLock (on first use) and Zig (compile time).
 * - lifetimeScript: a C program on the shared machine with a function-static counter, a global and a string literal.
 *
 * Measured, for the record (zig cc -target x86_64-linux-gnu -O0 -g0 -c, one-line file plus a getter):
 *   static char buf[1 << 20];         -> 1,336-byte object, .bss of 0x100000
 *   static char buf[1 << 20] = {1};   -> 1,049,912-byte object, .data of 0x100000 (1,048,576 bytes more)
 */
import { array, ptr, T, type Machine, type Ptr } from "../mem";
import type { StepFn } from "./script";

export type SectionId = "text" | "rodata" | "data" | "bss" | "tdata" | "tbss";
/** NOBITS sections: no bytes in the file. */
export const NOBITS: SectionId[] = ["bss", "tbss"];
export const SECTION_TEXT: Record<SectionId, string> = { text: ".text", rodata: ".rodata", data: ".data", bss: ".bss", tdata: ".tdata", tbss: ".tbss" };

export type GLang = "c" | "rust" | "zig" | "go";

export interface GlobalDecl {
  id: string;
  lang: GLang;
  /** The declaration; `N` is replaced with the array length. */
  code: (n: number) => string;
  /** The family that the answer buttons use. */
  section: SectionId;
  /** The exact section name in the object file. */
  exact: string;
  /** Bytes of the object for array length n. */
  bytes: (n: number) => number;
  /** Extra file bytes elsewhere (a string literal in .rodata.str1.1). */
  extra?: { section: SectionId; exact: string; bytes: number };
  note: string;
  tool: string;
}

const ZIGCC = "zig cc 0.17.1 -O0";
const RUSTC = "rustc 1.96 -C opt-level=1";
const ZIG = "zig 0.17.1";
const GO = "go1.25.6 linux/amd64";

export const GLOBALS: GlobalDecl[] = [
  // C
  { id: "c-zeros", lang: "c", code: (n) => `int zeros[${n}];`, section: "bss", exact: ".bss", bytes: (n) => 4 * n, tool: ZIGCC,
    note: "No initializer: the program loader gives zero pages. The file stores only the size." },
  { id: "c-zero-init", lang: "c", code: (n) => `int cleared[${n}] = {0};`, section: "bss", exact: ".bss", bytes: (n) => 4 * n, tool: ZIGCC,
    note: "An explicit zero is still all zero bits, so it goes to .bss too (unless -fno-zero-initialized-in-bss)." },
  { id: "c-table", lang: "c", code: (n) => `int table[${n}] = {1};`, section: "data", exact: ".data", bytes: (n) => 4 * n, tool: ZIGCC,
    note: "One nonzero element puts the whole array in .data. Every byte, the zeros too, is stored in the file." },
  { id: "c-const", lang: "c", code: (n) => `const int limits[${n}] = {1};`, section: "rodata", exact: ".rodata", bytes: (n) => 4 * n, tool: ZIGCC,
    note: "const and initialized: read-only data. A write through a cast pointer faults." },
  { id: "c-static-local", lang: "c", code: () => "int count(void) { static int calls; return ++calls; }", section: "bss", exact: ".bss", bytes: () => 4, tool: ZIGCC,
    note: "A static local has static storage duration. Its symbol is count.calls, a local symbol in .bss." },
  { id: "c-name", lang: "c", code: () => "const char *name = \"hello\";", section: "data", exact: ".data", bytes: () => 8, tool: ZIGCC,
    extra: { section: "rodata", exact: ".rodata.str1.1", bytes: 6 },
    note: "The pointer is a writable variable in .data, with a relocation. The 6 bytes of \"hello\" go to .rodata.str1.1, where the linker can merge equal strings." },
  { id: "c-tls", lang: "c", code: () => "_Thread_local int hits = 5;", section: "tdata", exact: ".tdata", bytes: () => 4, tool: ZIGCC,
    note: "Each thread gets its own copy. .tdata is the template that is copied for each new thread." },
  // Rust
  { id: "rs-zeros", lang: "rust", code: (n) => `static ZEROS: [u32; ${n}] = [0; ${n}];`, section: "rodata", exact: ".rodata.ZEROS", bytes: (n) => 4 * n, tool: RUSTC,
    note: "A surprise: an immutable static can never change, so rustc puts it in .rodata, and the zeros take file space." },
  { id: "rs-hits", lang: "rust", code: (n) => `static mut HITS: [u32; ${n}] = [0; ${n}];`, section: "bss", exact: ".bss.HITS", bytes: (n) => 4 * n, tool: RUSTC,
    note: "Writable and all zero: .bss. Each static gets its own section (.bss.HITS), so the linker can drop unused ones." },
  { id: "rs-counts", lang: "rust", code: () => "static mut COUNTS: [u32; 4] = [1, 2, 3, 4];", section: "data", exact: ".data.COUNTS", bytes: () => 16, tool: RUSTC,
    note: "Writable with nonzero bytes: .data." },
  { id: "rs-atom", lang: "rust", code: () => "static ATOM: AtomicU32 = AtomicU32::new(0);", section: "bss", exact: ".bss.<mangled ATOM>", bytes: () => 4, tool: RUSTC,
    note: "No mut, but AtomicU32 has interior mutability (UnsafeCell), so the bytes can change: .bss." },
  { id: "rs-name", lang: "rust", code: () => "static NAME: &str = \"hello\";", section: "rodata", exact: ".data.rel.ro.NAME", bytes: () => 16, tool: RUSTC,
    note: "A (pointer, length) pair that holds an address. It goes to .data.rel.ro: written once by relocation, then read-only (RELRO)." },
  // Zig
  { id: "zig-undef-debug", lang: "zig", code: (n) => `var buf: [${n}]u32 = undefined; // Debug`, section: "data", exact: ".data", bytes: (n) => 4 * n, tool: `${ZIG} -O Debug`,
    note: "In Debug mode Zig fills undefined memory with 0xAA bytes to expose bugs, so the array is stored in the file." },
  { id: "zig-undef-release", lang: "zig", code: (n) => `var buf: [${n}]u32 = undefined; // ReleaseSmall`, section: "bss", exact: ".bss", bytes: (n) => 4 * n, tool: `${ZIG} -O ReleaseSmall`,
    note: "In the release modes that we tried, undefined becomes .bss: no file bytes." },
  { id: "zig-splat", lang: "zig", code: (n) => `var counts: [${n}]u32 = @splat(0);`, section: "bss", exact: ".bss", bytes: (n) => 4 * n, tool: ZIG,
    note: "All zero: .bss in every mode." },
  { id: "zig-table", lang: "zig", code: () => "var table: [4]u32 = .{ 1, 2, 3, 4 };", section: "data", exact: ".data", bytes: () => 16, tool: ZIG,
    note: "Nonzero and mutable: .data. The initializer must be comptime-known." },
  { id: "zig-tls", lang: "zig", code: () => "threadlocal var hits: u32 = 0;", section: "tbss", exact: ".tbss", bytes: () => 4, tool: ZIG,
    note: "A zero thread-local: .tbss, the NOBITS part of the TLS template." },
  // Go
  { id: "go-zeros", lang: "go", code: (n) => `var zeros [${n}]int32`, section: "bss", exact: ".noptrbss", bytes: (n) => 4 * n, tool: GO,
    note: "Zero and holds no pointers: .noptrbss. The garbage collector does not scan the noptr sections." },
  { id: "go-table", lang: "go", code: () => "var table = [4]int32{1, 2, 3, 4}", section: "data", exact: ".noptrdata", bytes: () => 16, tool: GO,
    note: "Initialized, no pointers: .noptrdata. The linker stores the values; no init code runs." },
  { id: "go-ptrs", lang: "go", code: () => "var ptrs [16]*int32", section: "bss", exact: ".bss", bytes: () => 128, tool: GO,
    note: "Zero, but it holds pointers: .bss, which the GC scans as roots." },
  { id: "go-greeting", lang: "go", code: () => "var greeting = \"hello\"", section: "data", exact: ".data", bytes: () => 16, tool: GO,
    note: "A string header is (pointer, length). It holds a pointer, so it goes to .data, not .noptrdata." },
];

export const globalsOf = (lang: GLang) => GLOBALS.filter((g) => g.lang === lang);

export interface FileMemory {
  /** Bytes per section family (contents only). */
  sections: Record<SectionId, number>;
  file: number;
  memory: number;
}

/** File and memory bytes of a set of globals with array length n. Contents only: no padding, headers or symbols. */
export function fileAndMemory(decls: GlobalDecl[], n: number): FileMemory {
  const sections: Record<SectionId, number> = { text: 0, rodata: 0, data: 0, bss: 0, tdata: 0, tbss: 0 };
  for (const d of decls) {
    sections[d.section] += d.bytes(n);
    if (d.extra) sections[d.extra.section] += d.extra.bytes;
  }
  let file = 0;
  let memory = 0;
  for (const [k, v] of Object.entries(sections) as [SectionId, number][]) {
    memory += v;
    if (!NOBITS.includes(k)) file += v;
  }
  return { sections, file, memory };
}

/** The file bytes that one 1 MiB char buffer costs: 0 without an initializer, 1 MiB with `= {1}`. */
export const bufferFileCost = (initialized: boolean, bytes = 1 << 20) => (initialized ? bytes : 0);

// ---------------------------------------------------------------- initialization order

export type InitLang = "cpp" | "go" | "rust" | "zig";

export interface InitVar {
  name: string;
  file: string;
  /** The variables that the initializer reads. */
  deps: string[];
  /** The value from the values of the deps (0 for a dep that is not initialized yet). */
  compute: (dep: (n: string) => number) => number;
  /** How the value is shown. */
  show: string;
}

/**
 * The example: `logger` holds a prefix of 6 characters; `config` reads its length; `cache` sizes itself from config.
 * In C++ the values are the sizes that each object reads (0 for an object that is not constructed yet: its storage
 * is zero-initialized before any dynamic initializer runs, and the read is undefined behavior).
 */
export const INIT_VARS: InitVar[] = [
  { name: "logger", file: "logger", deps: [], compute: () => 6, show: "prefix of 6 chars" },
  { name: "config", file: "app", deps: ["logger"], compute: (d) => d("logger"), show: "n = logger.prefix.size()" },
  { name: "cache", file: "app", deps: ["config"], compute: (d) => d("config") * 1024, show: "bytes = config.n * 1024" },
];

export interface InitEvent {
  /** "init" runs an initializer; "main" is the start of main; "use" is the first use of a lazy value. */
  kind: "init" | "main" | "use" | "compile";
  name: string;
  value?: number;
  /** Deps that were read before they were initialized. */
  early: string[];
  text: string;
}

export interface InitOptions {
  /** C++: the order of the object files on the link line. */
  linkLoggerFirst: boolean;
  /** C++ and Go: in app's file, config is declared before cache. */
  configBeforeCache: boolean;
}

export function initOrder(lang: InitLang, opts: InitOptions, vars = INIT_VARS): InitEvent[] {
  const byName = new Map(vars.map((v) => [v.name, v]));
  const app = vars.filter((v) => v.file === "app");
  const appOrdered = opts.configBeforeCache ? app : [...app].reverse();
  const done = new Map<string, number>();
  const ev: InitEvent[] = [];
  const run = (v: InitVar, kind: InitEvent["kind"] = "init") => {
    const early: string[] = [];
    const value = v.compute((n) => {
      if (!done.has(n)) { early.push(n); return 0; }
      return done.get(n)!;
    });
    done.set(v.name, value);
    const text = early.length ? `${v.name} reads ${early.join(", ")} before it is constructed: it sees zero bytes` : `${v.name} = ${value}`;
    ev.push({ kind, name: v.name, value, early, text });
  };
  if (lang === "cpp") {
    // Link order of the translation units, declaration order in each ([basic.start.dynamic]: ordered in one file,
    // indeterminately sequenced across files). Link order decided it with Apple clang 21 and ld64 (checked).
    const logger = vars.filter((v) => v.file === "logger");
    const files = opts.linkLoggerFirst ? [logger, appOrdered] : [appOrdered, logger];
    for (const f of files) for (const v of f) run(v);
    ev.push({ kind: "main", name: "main", early: [], text: "main starts" });
  } else if (lang === "go") {
    // Go spec: files in the order presented to the compiler (the go command sorts by name: app.go, logger.go), then
    // repeatedly the earliest variable in declaration order that is ready (all deps initialized).
    const decl = [...appOrdered, ...vars.filter((v) => v.file === "logger")];
    const left = [...decl];
    while (left.length) {
      const i = left.findIndex((v) => v.deps.every((d) => done.has(d)));
      if (i < 0) throw new Error("initialization cycle");
      run(left.splice(i, 1)[0]!);
    }
    ev.push({ kind: "main", name: "main", early: [], text: "init() functions run, then main starts" });
  } else if (lang === "rust") {
    // LazyLock: nothing runs before main. The first deref runs the closure, which derefs its deps first.
    ev.push({ kind: "main", name: "main", early: [], text: "main starts; no static has run any code" });
    const force = (n: string) => {
      if (done.has(n)) return;
      const v = byName.get(n)!;
      for (const d of v.deps) force(d);
      run(v, "use");
    };
    force("cache");
  } else {
    // Zig: container-level initializers are comptime-known. The values are bytes in the file.
    const left = [...vars];
    while (left.length) {
      const i = left.findIndex((v) => v.deps.every((d) => done.has(d)));
      run(left.splice(i, 1)[0]!, "compile");
    }
    ev.push({ kind: "main", name: "main", early: [], text: "main starts; the values were computed at compile time" });
  }
  return ev;
}

/** The final value of a variable after the order runs. */
export const finalValue = (ev: InitEvent[], name: string) => ev.find((e) => e.name === name && e.value !== undefined)?.value;

// ---------------------------------------------------------------- lifetimes of static, automatic and literal data

export const LIFETIME_SOURCE = [
  "#include <stdio.h>",
  "const char *greet = \"hello\";",
  "int total;",
  "int count(void) {",
  "    static int calls;",
  "    int local = 0;",
  "    calls++;",
  "    local++;",
  "    return calls;",
  "}",
  "int main(void) {",
  "    count();",
  "    total = count();",
  "    char copy[] = \"hello\";",
  "    copy[0] = 'H';",
  "    ((char *)greet)[0] = 'H';",
  "}",
];

/**
 * The C program above on the shared machine. Globals exist before main and keep their values; `local` is new in
 * each call; the literal is in .rodata, and the last write to it is a segv (on Linux: SIGSEGV, the page is read-only).
 */
export function lifetimeScript(m: Machine, step: StepFn) {
  let lit: Ptr = { addr: 0 };
  const chars = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  step(2, "Before main: the loader maps the sections. \"hello\" is in .rodata, greet in .data, total and calls in .bss (zero).", () => {
    lit = m.literal("hello");
    m.global("greet", ptr(T.char), lit);
    m.global("total", T.int);
    m.global("count.calls", T.int);
  });
  step(11, "main starts. Its frame holds copy, which is not initialized yet.", () => m.call("main", [{ name: "copy", type: array(T.char, 6) }]));
  for (const k of [1, 2]) {
    step(4, `Call ${k} to count: a new frame with a new local.`, () => m.call("count", [{ name: "local", type: T.int }]));
    step(6, "local = 0.", () => m.set("local", 0));
    step(7, `calls++ in .bss: ${k - 1} becomes ${k}. It kept its value from the last call.`, () => m.set("count.calls", (m.get("count.calls") as number) + 1));
    step(8, "local++: 0 becomes 1, as in every call.", () => m.set("local", (m.get("local") as number) + 1));
    step(9, `count returns ${k}. The frame and local die; calls stays.`, () => { const v = m.get("count.calls"); m.ret(); if (k === 2) m.set("total", v); });
  }
  step(14, "char copy[] = \"hello\" copies 6 bytes from the literal into the stack array.", () => m.store(m.addrOf("copy"), array(T.char, 6), chars("hello")));
  step(15, "copy[0] = 'H' writes the stack copy. That is fine.", () => m.store(m.addrOf("copy"), T.char, 72));
  step(16, "The write through greet goes to .rodata. The page is read-only, so the process gets SIGSEGV.", () => m.store(lit, T.char, 72));
  step(17, "If the program survived, main would return here.", () => m.exit(0));
}
