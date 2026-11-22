/**
 * Scripted programs on the shared memory machine (src/sims/sys/mem) for the ownership lessons. Each function returns
 * the steps of one program: the source line, a caption, a snapshot of memory and the UB reports of that step. The
 * machine is a model (see its header): addresses, frame layout and the allocator are model choices.
 *
 * - stringAssign: `let t = s;` for a String as a Rust move, as a C++ deep copy, and as a C shallow copy. The shallow
 *   copy frees the same block twice, and the machine reports a double free as AddressSanitizer would.
 * - vectorInvalidation: a C++ reference into a std::vector, then push_back. When the vector must grow, the elements
 *   move to a new block and the reference dangles: a heap-use-after-free. Rust rejects the same program with E0502.
 * - moveCompare: C++ `std::string b = std::move(a);` (steal the buffer, leave `a` empty, run two destructors) and
 *   Rust `let b = a;` (copy three words, forget `a`, run one drop).
 * - unwindMemory: the `save` function of cpp.ts on the machine: with manual cleanup an exception leaks the buffer
 *   and the FILE, and LeakSanitizer reports them at exit.
 *
 * Layout simplifications, said in the demos too: a String or std::string is shown as three words (ptr, cap, len);
 * Rust does not specify the order of String's fields, and libc++ packs its fields differently and keeps strings of
 * up to 22 bytes inside the object (the short string optimization).
 */
import { Machine, T, array, ptr, struct, type Ptr, type Snapshot, type UbReport } from "../mem";
import { unwind, type CleanupStyle, type ThrowAt } from "./cpp";

export interface MemStep {
  line: number;
  caption: string;
  snap: Snapshot;
  ub: UbReport[];
  /** Locals that the language now treats as moved from (Rust) or as moved-from but alive (C++). */
  moved: string[];
}

function recorder(m: Machine) {
  const steps: MemStep[] = [{ line: 0, caption: "Before the program starts. Press Step.", snap: m.snapshot(), ub: [], moved: [] }];
  let moved: string[] = [];
  const step = (line: number, caption: string, run?: () => void, mv?: string[]) => {
    const before = m.ub.length;
    m.line = line;
    run?.();
    if (mv) moved = mv;
    steps.push({ line, caption, snap: m.snapshot(), ub: m.ub.slice(before), moved: [...moved] });
  };
  return { steps, step };
}

/** A string object as three words. */
export const STRING = struct("String", [["ptr", ptr(T.u8)], ["cap", T.usize], ["len", T.usize]]);
const bytesOf = (s: string) => [...s].map((c) => c.charCodeAt(0));

// ---------------------------------------------------------------- let t = s;

export type AssignMode = "rust" | "copy" | "shallow";

export const ASSIGN_SOURCE: Record<AssignMode, string[]> = {
  rust: [
    "fn main() {",
    '    let s = String::from("hello");',
    "    let t = s;          // move: copy 3 words",
    '    println!("{}", t);',
    "}                       // drop(t) only",
  ],
  copy: [
    "int main() {",
    '    std::string s = "hello";',
    "    std::string t = s;  // copy constructor",
    "    std::cout << t;",
    "}                       // ~t(), then ~s()",
  ],
  shallow: [
    "int main(void) {",
    '    struct str s = str_from("hello");',
    "    struct str t = s;   // copies the pointer",
    '    printf("%s", t.ptr);',
    "    str_free(&t);",
    "    str_free(&s);       // the same block again",
    "}",
  ],
};

export function stringAssign(mode: AssignMode): MemStep[] {
  const m = new Machine();
  const { steps, step } = recorder(m);
  const hello = bytesOf("hello");
  let block: Ptr = { addr: 0 };
  step(1, "main gets a frame with room for s and t: three words each.", () => m.call("main", [{ name: "s", type: STRING }, { name: "t", type: STRING }]));
  step(2, "The string asks the allocator for 5 bytes and writes hello there. s holds the pointer, the capacity and the length.", () => {
    block = m.malloc(5, undefined, '"hello"');
    m.store(block, array(T.u8, 5), hello);
    m.set("s", { ptr: block, cap: 5, len: 5 });
  });
  if (mode === "rust") {
    step(3, "The move copies the three words of s into t. No heap work. The compiler now treats s as uninitialized: any use of s is error E0382.", () => m.set("t", m.get("s")), ["s"]);
    step(4, "println reads the bytes through t.", () => m.load((m.get("t") as { ptr: Ptr }).ptr, array(T.u8, 5)));
    step(5, "Scope end: t is dropped and frees the block. s is not dropped, because the compiler knows it was moved. One allocation, one free.", () => { m.free((m.get("t") as { ptr: Ptr }).ptr); m.exit(0); });
  } else if (mode === "copy") {
    step(3, "The copy constructor allocates a second block and copies the 5 bytes. s and t own different blocks.", () => {
      const b2 = m.malloc(5, undefined, '"hello" copy');
      m.memcpy(b2, block, 5);
      m.set("t", { ptr: b2, cap: 5, len: 5 });
    });
    step(4, "The output reads the bytes through t.", () => m.load((m.get("t") as { ptr: Ptr }).ptr, array(T.u8, 5)));
    step(5, "Scope end: ~t() frees the copy, then ~s() frees the original, in reverse order of construction. Two allocations, two frees.", () => {
      m.free((m.get("t") as { ptr: Ptr }).ptr);
      m.free((m.get("s") as { ptr: Ptr }).ptr);
      m.exit(0);
    });
  } else {
    step(3, "Plain struct assignment copies the three words. Now two structs point at one block, and C does not know which one owns it.", () => m.set("t", m.get("s")));
    step(4, "printf reads the bytes through t.", () => m.load((m.get("t") as { ptr: Ptr }).ptr, array(T.u8, 5)));
    step(5, "str_free(&t) frees the block.", () => m.free((m.get("t") as { ptr: Ptr }).ptr));
    step(6, "str_free(&s) frees the same block a second time: a double free. With glibc this can corrupt the allocator's lists.", () => m.free((m.get("s") as { ptr: Ptr }).ptr));
    step(7, "main returns.", () => m.exit(0));
  }
  return steps;
}

// ---------------------------------------------------------------- iterator invalidation

export const INVALIDATION_SOURCE = [
  "std::vector<int> v = {1, 2, 3};",
  "v.reserve(4);               // only with the toggle",
  "int& first = v[0];",
  "v.push_back(4);",
  "std::cout << first;         // read through the reference",
];

/** The vector header as three pointers, as libc++ and libstdc++ both store it (begin, end, end of capacity). */
export const VECTOR = struct("vector<int>", [["begin", ptr(T.int)], ["end", ptr(T.int)], ["cap_end", ptr(T.int)]]);

export function vectorInvalidation(reserve: boolean): MemStep[] {
  const m = new Machine();
  const { steps, step } = recorder(m);
  let buf: Ptr = { addr: 0 };
  let cap = 3;
  const setHeader = (size: number) => m.set("v", { begin: buf, end: { addr: buf.addr + 4 * size, alloc: buf.alloc }, cap_end: { addr: buf.addr + 4 * cap, alloc: buf.alloc } });
  step(1, "v allocates room for 3 ints and stores 1, 2, 3. Its header holds three pointers: begin, end and the end of the capacity.", () => {
    m.call("main", [{ name: "v", type: VECTOR }, { name: "first", type: ptr(T.int) }]);
    buf = m.malloc(12, undefined, "ints (cap 3)");
    m.store(buf, array(T.int, 3), [1, 2, 3]);
    setHeader(3);
  });
  if (reserve) {
    step(2, "reserve(4) moves the elements to a block with room for 4. The reference does not exist yet, so nothing dangles.", () => {
      const nb = m.malloc(16, undefined, "ints (cap 4)");
      m.memcpy(nb, buf, 12);
      m.free(buf);
      buf = nb;
      cap = 4;
      setHeader(3);
    });
  } else step(2, "No reserve: the capacity stays 3.", () => m.note("no reserve"));
  step(3, "first is a reference, so the machine stores the address of v[0].", () => m.set("first", buf));
  if (reserve) {
    step(4, "push_back(4) fits in the capacity: it writes the 4th int. No element moves, so first is still valid.", () => {
      m.store({ addr: buf.addr + 12, alloc: buf.alloc }, T.int, 4);
      setHeader(4);
    });
  } else {
    step(4, "push_back(4) needs a 4th slot. libc++ allocates room for 6 (2 × 3), moves the ints there and frees the old block. first still holds the old address.", () => {
      const nb = m.malloc(24, undefined, "ints (cap 6)");
      m.memcpy(nb, buf, 12);
      m.store({ addr: nb.addr + 12, alloc: nb.alloc }, T.int, 4);
      m.free(buf);
      buf = nb;
      cap = 6;
      setHeader(4);
    });
  }
  step(5, reserve ? "The read through first gets 1. This run is correct, but only because of the capacity: the program is fragile, and Rust rejects it." : "The read through first touches freed memory. The hardware returns the old bytes, so the bug can stay hidden. AddressSanitizer reports it.", () => {
    m.load(m.get("first") as Ptr, T.int);
  });
  step(6, "main returns and v frees its block.", () => { m.free(buf); m.exit(0); });
  return steps;
}

// ---------------------------------------------------------------- C++ move and Rust move

export type MoveLang = "cpp" | "rust";
export const MOVE_SOURCE: Record<MoveLang, string[]> = {
  cpp: [
    "{",
    "    std::string a(40, 'x');      // 40 bytes: on the heap",
    "    std::string b = std::move(a);",
    "    a.size();                    // valid: 0 in libc++",
    "}                                // ~b() frees, ~a() frees nothing",
  ],
  rust: [
    "{",
    '    let a = "x".repeat(40);      // 40 bytes on the heap',
    "    let b = a;                   // a is moved",
    "    // a.len();                  // error[E0382]",
    "}                                // drop(b) only",
  ],
};

export function moveCompare(lang: MoveLang): MemStep[] {
  const m = new Machine();
  const { steps, step } = recorder(m);
  let blk: Ptr = { addr: 0 };
  const word = (name: string) => m.get(name) as { ptr: Ptr; cap: number; len: number };
  step(1, "A frame with room for a and b.", () => m.call("scope", [{ name: "a", type: STRING }, { name: "b", type: STRING }]));
  step(2, "a allocates 40 bytes on the heap and fills them with x.", () => {
    blk = m.malloc(40, undefined, "40 × 'x'");
    m.store(blk, array(T.u8, 40), Array(40).fill(120));
    m.set("a", { ptr: blk, cap: 40, len: 40 });
  });
  if (lang === "cpp") {
    step(3, "The move constructor runs: it copies a's three words into b, then writes an empty state into a. a is still a live object.", () => {
      m.set("b", m.get("a"));
      m.set("a", { ptr: null, cap: 0, len: 0 });
    }, ["a"]);
    step(4, "a.size() is allowed: a moved-from std::string is in a valid but unspecified state. libc++ leaves it empty.", () => { m.get("a"); });
    step(5, "Scope end: ~b() frees the block. ~a() also runs, but a owns nothing. Two destructor calls, one free.", () => {
      m.free(word("b").ptr);
      m.note("~a(): nothing to free");
      m.exit(0);
    });
  } else {
    step(3, "The move copies three words from a to b. It writes nothing into a: the compiler forgets a instead.", () => m.set("b", m.get("a")), ["a"]);
    step(4, "A use of a does not compile (E0382), so the stale words in a can never be read.", () => m.note("no code for this line"));
    step(5, "Scope end: only b is dropped, and it frees the block. No destructor call for a at all.", () => {
      m.free(word("b").ptr);
      m.exit(0);
    });
  }
  return steps;
}

// ---------------------------------------------------------------- unwinding on the machine

export function unwindMemory(style: CleanupStyle, at: ThrowAt): MemStep[] {
  const m = new Machine();
  const { steps, step } = recorder(m);
  const run = unwind(style, at);
  const raii = style === "raii";
  const locals = raii
    ? [{ name: "buf", type: ptr(T.char) }, { name: "f", type: ptr() }]
    : [{ name: "buf", type: ptr(T.char) }, { name: "f", type: ptr() }];
  step(0, "The caller calls save inside a try block.", () => { m.call("caller"); m.call("save", locals); });
  for (const e of run.events) {
    step(e.line, e.text, () => {
      if (e.kind === "acquire" && /4096|new/.test(e.text)) m.set("buf", m.malloc(4096, undefined, "char[4096]"));
      else if (e.kind === "acquire" && /open/.test(e.text)) m.set("f", m.allocNamed("FILE", "f", { size: 216 }));
      else if (e.kind === "release" && /buffer|delete/.test(e.text)) m.free(m.get("buf") as Ptr);
      else if (e.kind === "release" && /file|fclose/.test(e.text)) m.free(m.get("f") as Ptr);
      else if (e.kind === "catch" || e.kind === "return") m.ret();
      else m.note(e.text);
    });
  }
  step(0, run.held.length ? `The program exits. ${run.held.includes("lock") ? "mu is still locked, so the next call to save waits forever. " : ""}LeakSanitizer looks for heap blocks that nothing points to.` : "The program exits. Every resource was released.", () => m.exit(0));
  return steps;
}
