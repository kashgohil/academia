/**
 * C++ models for the RAII and move-semantics lessons. Each model is small and its results are pinned against real
 * runs with Apple clang 21 and libc++ (LLVM's standard library; `_LIBCPP_VERSION` 210106) in
 * tests/unit/sys-ownership-cpp.test.ts.
 *
 * - specialMembers: which special member functions a class gets implicitly, from the rules in the C++ standard
 *   ([class.copy.ctor], [class.copy.assign], [class.dtor]), and what `T b = std::move(a)` and `b = std::move(a)`
 *   call. RULE5_CLANG is the result of all 32 combinations compiled with clang++ -std=c++20.
 * - vectorGrowth: the constructor, copy, move and destructor calls of n push_back or emplace_back calls on a
 *   std::vector, with libc++'s growth rule (new capacity = max(2 × capacity, size + 1)) and std::move_if_noexcept
 *   during reallocation. VECTOR_CLANG holds counts from a real run.
 * - ELISION: six ways to return an object, with the calls that clang makes at -O0 and with -fno-elide-constructors.
 * - unwind: a function that takes a lock, a heap buffer and a file, written with manual cleanup or with RAII, and the
 *   events when an exception leaves it at a chosen line.
 */

// ---------------------------------------------------------------- the rule of zero, three and five

export type Member = "dtor" | "copyCtor" | "copyAssign" | "moveCtor" | "moveAssign";
export const MEMBERS: Member[] = ["dtor", "copyCtor", "copyAssign", "moveCtor", "moveAssign"];
export const MEMBER_TEXT: Record<Member, string> = {
  dtor: "~T()",
  copyCtor: "T(const T&)",
  copyAssign: "T& operator=(const T&)",
  moveCtor: "T(T&&)",
  moveAssign: "T& operator=(T&&)",
};

/** user: the class declares it. defaulted: the compiler declares and defines it. deleted: declared as deleted. none: not declared at all. */
export type MemberState = "user" | "defaulted" | "deprecated" | "deleted" | "none";

export interface SpecialMembers {
  state: Record<Member, MemberState>;
  /** What `T b = std::move(a);` calls: the move constructor, the copy constructor, or nothing (an error). */
  constructFromRvalue: "move" | "copy" | "error";
  /** What `b = std::move(a);` calls. */
  assignFromRvalue: "move" | "copy" | "error";
  copyable: boolean;
  copyAssignable: boolean;
}

/**
 * The implicit special members for a class whose user-declared members are `user` (C++11 and later):
 * - The destructor is implicitly declared (defaulted) if not user-declared.
 * - The copy constructor is implicitly declared if not user-declared. It is deleted if the class declares a move
 *   constructor or a move assignment operator. Otherwise it is defaulted, and deprecated if the class declares a copy
 *   assignment operator or a destructor ([depr.impldec]). The copy assignment operator follows the same rules.
 * - The move constructor is implicitly declared (defaulted) only if the class declares no copy constructor, copy
 *   assignment operator, move assignment operator or destructor. Otherwise it is NOT declared, so an rvalue
 *   uses the copy constructor. The move assignment operator: the same, with move constructor in the list.
 */
export function specialMembers(user: Set<Member>): SpecialMembers {
  const has = (m: Member) => user.has(m);
  const anyMove = has("moveCtor") || has("moveAssign");
  const copy = (m: "copyCtor" | "copyAssign", other: "copyCtor" | "copyAssign"): MemberState =>
    has(m) ? "user" : anyMove ? "deleted" : has(other) || has("dtor") ? "deprecated" : "defaulted";
  const move = (m: "moveCtor" | "moveAssign", other: "moveCtor" | "moveAssign"): MemberState =>
    has(m) ? "user" : has("copyCtor") || has("copyAssign") || has(other) || has("dtor") ? "none" : "defaulted";
  const state: Record<Member, MemberState> = {
    dtor: has("dtor") ? "user" : "defaulted",
    copyCtor: copy("copyCtor", "copyAssign"),
    copyAssign: copy("copyAssign", "copyCtor"),
    moveCtor: move("moveCtor", "moveAssign"),
    moveAssign: move("moveAssign", "moveCtor"),
  };
  const usable = (s: MemberState) => s !== "deleted" && s !== "none";
  // an rvalue binds to T&& first; if no move member is declared, overload resolution picks the copy member
  const pick = (mv: MemberState, cp: MemberState) => (usable(mv) ? "move" : mv === "none" && usable(cp) ? "copy" : "error");
  return {
    state,
    constructFromRvalue: pick(state.moveCtor, state.copyCtor),
    assignFromRvalue: pick(state.moveAssign, state.copyAssign),
    copyable: usable(state.copyCtor),
    copyAssignable: usable(state.copyAssign),
  };
}

/** The set of user-declared members for a bit mask: bit 0 dtor, 1 copy ctor, 2 copy assign, 3 move ctor, 4 move assign. */
export const membersOf = (mask: number) => new Set(MEMBERS.filter((_, i) => (mask >> i) & 1));

/**
 * clang++ 21 -std=c++20 on all 32 classes: [move-construct, move-assign, copy-constructible, copy-assignable], where
 * the first two say which constructor or operator of a member ran ("move" or "copy") or "error" when
 * std::is_move_constructible / std::is_move_assignable is false.
 */
export const RULE5_CLANG: [string, string, boolean, boolean][] = [
  ["move", "move", true, true], ["copy", "copy", true, true], ["copy", "copy", true, true], ["copy", "copy", true, true],
  ["copy", "copy", true, true], ["copy", "copy", true, true], ["copy", "copy", true, true], ["copy", "copy", true, true],
  ["move", "error", false, false], ["move", "error", false, false], ["move", "error", true, false], ["move", "error", true, false],
  ["move", "copy", false, true], ["move", "copy", false, true], ["move", "copy", true, true], ["move", "copy", true, true],
  ["error", "move", false, false], ["error", "move", false, false], ["copy", "move", true, false], ["copy", "move", true, false],
  ["error", "move", false, true], ["error", "move", false, true], ["copy", "move", true, true], ["copy", "move", true, true],
  ["move", "move", false, false], ["move", "move", false, false], ["move", "move", true, false], ["move", "move", true, false],
  ["move", "move", false, true], ["move", "move", false, true], ["move", "move", true, true], ["move", "move", true, true],
];

// ---------------------------------------------------------------- std::vector growth

export interface VectorRun {
  ctor: number;
  copy: number;
  move: number;
  /** Destructor calls before the vector itself is destroyed. */
  dtor: number;
  capacity: number;
  reallocations: number;
  /** Elements copied or moved during reallocations. */
  relocated: number;
  /** One entry per reallocation: the size before it and the new capacity. */
  growth: { size: number; cap: number }[];
}

/**
 * n calls of `v.push_back(T(i))` (or `v.emplace_back(i)`) on an empty std::vector<T>, with libc++'s growth rule.
 * push_back of a temporary: 1 constructor (the temporary), 1 move into the buffer, 1 destructor (the temporary).
 * emplace_back: 1 constructor in place. A reallocation relocates every element with std::move_if_noexcept: a move
 * if T's move constructor is noexcept, else a copy. Then it destroys the old elements.
 */
export function vectorGrowth(n: number, opts: { noexceptMove: boolean; emplace: boolean; reserve: boolean }): VectorRun {
  const r: VectorRun = { ctor: 0, copy: 0, move: 0, dtor: 0, capacity: 0, reallocations: 0, relocated: 0, growth: [] };
  let size = 0;
  if (opts.reserve) r.capacity = n;
  for (let i = 0; i < n; i++) {
    r.ctor++;
    if (!opts.emplace) { r.move++; r.dtor++; }
    if (size === r.capacity) {
      const cap = Math.max(2 * r.capacity, size + 1);
      r.growth.push({ size, cap });
      if (opts.noexceptMove) r.move += size;
      else r.copy += size;
      r.dtor += size;
      r.relocated += size;
      r.reallocations++;
      r.capacity = cap;
    }
    size++;
  }
  return r;
}

/** Counts printed by the real program (clang++ -std=c++20, libc++), keyed "n,noexcept,emplace,reserve". */
export const VECTOR_CLANG: Record<string, [ctor: number, copy: number, move: number, dtor: number, cap: number]> = {
  "1,1,0,0": [1, 0, 1, 1, 1], "2,1,0,0": [2, 0, 3, 3, 2], "2,0,0,0": [2, 1, 2, 3, 2], "3,1,0,0": [3, 0, 6, 6, 4],
  "3,0,0,0": [3, 3, 3, 6, 4], "5,1,0,0": [5, 0, 12, 12, 8], "5,0,0,0": [5, 7, 5, 12, 8], "5,1,1,0": [5, 0, 7, 7, 8],
  "5,0,1,0": [5, 7, 0, 7, 8], "5,1,0,1": [5, 0, 5, 5, 5], "17,1,0,0": [17, 0, 48, 48, 32], "17,0,1,0": [17, 31, 0, 31, 32],
  "100,1,0,0": [100, 0, 227, 227, 128], "100,0,0,0": [100, 127, 100, 227, 128], "100,1,1,0": [100, 0, 127, 127, 128],
  "100,1,0,1": [100, 0, 100, 100, 100], "1000,1,0,0": [1000, 0, 2023, 2023, 1024], "1000,0,0,0": [1000, 1023, 1000, 2023, 1024],
  "1000,0,1,0": [1000, 1023, 0, 1023, 1024],
};

// ---------------------------------------------------------------- copy elision

export interface ElisionCase {
  id: string;
  label: string;
  code: string[];
  /** ctor, copy, move, dtor for `T r = f();` with clang++ -std=c++20 -O0 (the same at -O2). */
  clang: [number, number, number, number];
  /** The same with -fno-elide-constructors (which cannot turn off the elision that C++17 guarantees). */
  noElide: [number, number, number, number];
  why: string;
}

export const ELISION: ElisionCase[] = [
  { id: "prvalue", label: "return T()", code: ["T make() {", "    return T();", "}"], clang: [1, 0, 0, 1], noElide: [1, 0, 0, 1],
    why: "A prvalue initializes the result object directly. C++17 guarantees this: there is no temporary to move from, so even -fno-elide-constructors makes no move." },
  { id: "named", label: "return local", code: ["T make() {", "    T t;", "    return t;", "}"], clang: [1, 0, 0, 1], noElide: [1, 0, 1, 2],
    why: "Named return value optimization (NRVO): the compiler builds t in the caller's result slot. The standard allows it but does not require it. Without it, the return is an implicit move." },
  { id: "stdmove", label: "return std::move(local)", code: ["T make() {", "    T t;", "    return std::move(t);", "}"], clang: [1, 0, 1, 2], noElide: [1, 0, 1, 2],
    why: "std::move(t) is not a name, so NRVO cannot apply. The cast costs one move and one more destructor. Clang warns with -Wpessimizing-move." },
  { id: "either", label: "return a or b", code: ["T make(bool c) {", "    T a, b;", "    if (c) return a;", "    return b;", "}"], clang: [2, 0, 1, 3], noElide: [2, 0, 1, 3],
    why: "Two different objects can be returned, so neither can live in the result slot. The returned name is treated as an rvalue: an implicit move." },
  { id: "param", label: "return parameter", code: ["T make(T p) {", "    return p;", "}"], clang: [1, 0, 1, 2], noElide: [1, 0, 1, 2],
    why: "The caller owns a parameter's storage, so NRVO cannot use it. The return is an implicit move." },
  { id: "ternary", label: "return c ? a : b", code: ["T make(bool c) {", "    T a, b;", "    return c ? a : b;", "}"], clang: [2, 1, 0, 3], noElide: [2, 1, 0, 3],
    why: "The conditional expression is an lvalue, not a name. The implicit move applies only to a plain name, so this is a COPY." },
];

// ---------------------------------------------------------------- exceptions and unwinding

export type CleanupStyle = "manual" | "raii";
/** Where the exception starts: nowhere, in `new`, in `fill`, or in the write. */
export type ThrowAt = "none" | "new" | "fill" | "write";
export const THROW_POINTS: ThrowAt[] = ["none", "new", "fill", "write"];

export const UNWIND_SOURCE: Record<CleanupStyle, string[]> = {
  manual: [
    "void save(const char* path) {",
    "    mu.lock();",
    "    char* buf = new char[4096];",
    "    FILE* f = fopen(path, \"w\");",
    "    fill(buf, 4096);               // may throw",
    "    write_all(f, buf, 4096);       // may throw",
    "    fclose(f);",
    "    delete[] buf;",
    "    mu.unlock();",
    "}",
  ],
  raii: [
    "void save(const char* path) {",
    "    std::lock_guard<std::mutex> g(mu);",
    "    auto buf = std::make_unique<char[]>(4096);",
    "    std::ofstream f(path);",
    "    fill(buf.get(), 4096);         // may throw",
    "    f.write(buf.get(), 4096);      // may throw",
    "}   // ~ofstream, ~unique_ptr, ~lock_guard",
  ],
};

export type Res = "lock" | "buffer" | "file";
export interface UnwindEvent { line: number; text: string; kind: "acquire" | "release" | "throw" | "call" | "catch" | "return" }
export interface UnwindRun {
  events: UnwindEvent[];
  /** The resources still held when the caller gets control back. */
  held: Res[];
  thrown: boolean;
}

/**
 * Runs `save` in one style with an exception at `at`. RAII: objects are destroyed in the reverse order of their
 * construction, during normal return and during stack unwinding alike. Manual: the cleanup lines run only on the
 * normal path, so an exception skips them.
 */
export function unwind(style: CleanupStyle, at: ThrowAt): UnwindRun {
  const ev: UnwindEvent[] = [];
  const held: Res[] = [];
  const raii = style === "raii";
  const acquire: [Res, number, string][] = [
    ["lock", 2, raii ? "lock_guard locks mu" : "mu.lock()"],
    ["buffer", 3, raii ? "make_unique allocates 4096 bytes" : "new char[4096]"],
    ["file", 4, raii ? "ofstream opens the file" : "fopen opens the file"],
  ];
  const release: Record<Res, string> = raii
    ? { file: "~ofstream closes the file", buffer: "~unique_ptr frees the buffer", lock: "~lock_guard unlocks mu" }
    : { file: "fclose(f)", buffer: "delete[] buf", lock: "mu.unlock()" };
  let thrown = false;
  for (const [res, line, text] of acquire) {
    if (res === "buffer" && at === "new") { ev.push({ line, text: "operator new throws std::bad_alloc", kind: "throw" }); thrown = true; break; }
    ev.push({ line, text, kind: "acquire" });
    held.push(res);
  }
  if (!thrown) {
    for (const [what, line] of [["fill", 5], ["write", 6]] as const) {
      if (at === what) { ev.push({ line, text: `${what === "fill" ? "fill" : "the write"} throws`, kind: "throw" }); thrown = true; break; }
      ev.push({ line, text: what === "fill" ? "fill(buf) returns" : "the write returns", kind: "call" });
    }
  }
  if (raii) {
    // the destructors run in reverse order on both paths
    const end = thrown ? ev[ev.length - 1]!.line : 7;
    for (const r of [...held].reverse()) ev.push({ line: end, text: (thrown ? "unwinding: " : "") + release[r], kind: "release" });
    held.length = 0;
  } else if (!thrown) {
    const lines: Record<Res, number> = { file: 7, buffer: 8, lock: 9 };
    for (const r of [...held].reverse()) ev.push({ line: lines[r], text: release[r], kind: "release" });
    held.length = 0;
  }
  ev.push(thrown ? { line: 1, text: "the caller's catch block runs", kind: "catch" } : { line: raii ? 7 : 10, text: "save returns", kind: "return" });
  return { events: ev, held: [...held], thrown };
}

/** Output of the real unwinding test (clang++ -std=c++20): a local, a Pair with two members, a local, then a constructor that throws. */
export const UNWIND_CLANG = [
  "construct a", "construct first", "construct second", "Pair body", "construct b", "construct member a", "construct member b",
  "Bad body throws", "destroy member b", "destroy member a", "destroy b", "~Pair body", "destroy second", "destroy first", "destroy a", "caught ctor",
];
