/**
 * A tiny optimizer model: small C and C++ functions, the UB-based rewrites that clang applies to them step by step, and
 * the behaviour of each build on chosen inputs.
 *
 * This is a MODEL of the reasoning, not a compiler. Each case lists the steps by hand (a fact the compiler may assume,
 * the rewrite it allows, the dead code it removes). Two things keep it honest:
 * 1. The end result of every case is the real output of clang (Apple clang 21, `-O2`, x86-64 Linux target) in
 *    golden.ts. The tests check the key fact in that text (the check is gone, the constant is 1, the load is hoisted).
 *    `zig cc` 0.17.1 (its clang 22) gave the same instructions for every case here.
 * 2. `run` executes each build by hand-written semantics that follow the instructions of that build. The tests check
 *    the as-if rule: on every input with no UB, all builds give the same result. On an input with UB they may differ,
 *    and the demo shows how.
 */
import { GOLDEN } from "./golden";

export type GoldenKey = keyof typeof GOLDEN;

/** A line of code in a step. `mark` says what the step does to it. */
export interface CodeLine {
  text: string;
  mark?: "fact" | "fold" | "dead" | "new";
  note?: string;
}

export interface OptStep {
  title: string;
  /** What the compiler knows or does in this step. */
  text: string;
  /** The rule from the standard that allows it, if any. */
  rule?: string;
  code: CodeLine[];
}

/** One way to build the function. */
export interface Build {
  id: string;
  label: string;
  /** The golden assembly of this build, if it has one. */
  asm?: GoldenKey;
}

export type Outcome =
  | { kind: "value"; value: number }
  | { kind: "crash"; signal: string }
  | { kind: "hang" };

export const outcomeText = (o: Outcome): string =>
  o.kind === "value" ? String(o.value) : o.kind === "crash" ? `crash (${o.signal})` : "runs forever";

export const sameOutcome = (a: Outcome, b: Outcome) =>
  a.kind === b.kind && (a.kind !== "value" || a.value === (b as { value: number }).value);

export interface OptInput { id: string; label: string }

export interface OptCase {
  id: string;
  title: string;
  lang: "C" | "C++";
  steps: OptStep[];
  builds: Build[];
  inputs: OptInput[];
  /** Why this input has UB in the source program, or null if it has none. */
  ub: (input: string) => string | null;
  run: (input: string, build: string) => Outcome;
}

const INT_MAX = 2147483647;
const INT_MIN = -2147483648;
/** 32-bit two's complement wrap, as the hardware add does. */
export const wrap32 = (x: number) => x | 0;
export const wrapU32 = (x: number) => x >>> 0;

// ---------------------------------------------------------------- null check after a dereference

/** The value at address 0 when a program has mapped page 0 (model input; any value works). */
export const PAGE0_VALUE = 0x1337;

const nullCase: OptCase = {
  id: "null",
  title: "Null check after a dereference",
  lang: "C",
  steps: [
    {
      title: "Source",
      text: "The function reads *p first and tests p for NULL after the read.",
      code: [
        { text: "int get(int *p) {" },
        { text: "    int x = *p;" },
        { text: "    if (p == NULL)" },
        { text: "        return -1;" },
        { text: "    return x;" },
        { text: "}" },
      ],
    },
    {
      title: "Derive a fact",
      text: "Line 2 dereferences p. A dereference of a null pointer is UB. So on every execution with defined behaviour, p is not NULL after line 2.",
      rule: "C11 6.5.3.2p4: the behavior of unary * on an invalid pointer value (such as a null pointer) is undefined.",
      code: [
        { text: "int get(int *p) {" },
        { text: "    int x = *p;", mark: "fact", note: "so p != NULL" },
        { text: "    if (p == NULL)" },
        { text: "        return -1;" },
        { text: "    return x;" },
        { text: "}" },
      ],
    },
    {
      title: "Fold the condition",
      text: "The compiler uses the fact. The condition p == NULL is always false, so it becomes the constant 0.",
      code: [
        { text: "int get(int *p) {" },
        { text: "    int x = *p;" },
        { text: "    if (0)", mark: "fold", note: "was p == NULL" },
        { text: "        return -1;" },
        { text: "    return x;" },
        { text: "}" },
      ],
    },
    {
      title: "Remove dead code",
      text: "A branch under if (0) never runs. Dead-code elimination deletes it.",
      code: [
        { text: "int get(int *p) {" },
        { text: "    int x = *p;" },
        { text: "    if (0)", mark: "dead" },
        { text: "        return -1;", mark: "dead" },
        { text: "    return x;" },
        { text: "}" },
      ],
    },
    {
      title: "Result",
      text: "What is left is one load and a return. The real clang output below has no compare and no branch.",
      code: [
        { text: "int get(int *p) {" },
        { text: "    return *p;", mark: "new" },
        { text: "}" },
      ],
    },
  ],
  builds: [
    { id: "O0", label: "-O0" },
    { id: "O2", label: "-O2", asm: "null.O2" },
    { id: "nodel", label: "-O2 -fno-delete-null-pointer-checks", asm: "null.O2.nodelete" },
  ],
  inputs: [
    { id: "valid", label: "p = &v, v = 5" },
    { id: "null", label: "p = NULL, page 0 not mapped" },
    { id: "mapped", label: "p = NULL, page 0 mapped" },
  ],
  ub: (i) => (i === "valid" ? null : "*p reads through a null pointer."),
  run: (i, b) => {
    const load = (): Outcome => (i === "valid" ? { kind: "value", value: 5 } : i === "mapped" ? { kind: "value", value: PAGE0_VALUE } : { kind: "crash", signal: "SIGSEGV" });
    if (b === "O0") {
      // load first, then the check
      const x = load();
      if (x.kind !== "value") return x;
      return i === "valid" ? x : { kind: "value", value: -1 };
    }
    if (b === "O2") return load(); // mov eax, [rdi]; ret
    // -fno-delete-null-pointer-checks: test rdi, rdi; je -> -1; else load
    return i === "valid" ? load() : { kind: "value", value: -1 };
  },
};

// ---------------------------------------------------------------- x + 1 > x

/** Inputs for the x + 1 > x case. */
export const GT_INPUTS = [INT_MIN, -1, 0, 41, INT_MAX - 1, INT_MAX];

const gtCase: OptCase = {
  id: "gt",
  title: "x + 1 > x",
  lang: "C",
  steps: [
    {
      title: "Source",
      text: "The function asks if x + 1 is greater than x. With wrapping arithmetic, the answer is no for INT_MAX.",
      code: [{ text: "int gt(int x) {" }, { text: "    return x + 1 > x;" }, { text: "}" }],
    },
    {
      title: "Derive a fact",
      text: "x + 1 on an int is UB if the true sum does not fit in an int. So in every defined execution, x + 1 is the true sum.",
      rule: "C11 6.5p5: if the result is not mathematically defined or not in the range of its type, the behavior is undefined.",
      code: [{ text: "int gt(int x) {" }, { text: "    return x + 1 > x;", mark: "fact", note: "x + 1 is exact" }, { text: "}" }],
    },
    {
      title: "Fold with algebra",
      text: "For exact integers, x + 1 > x is the same as 1 > 0. That is always true.",
      code: [{ text: "int gt(int x) {" }, { text: "    return 1;", mark: "fold", note: "was x + 1 > x" }, { text: "}" }],
    },
    {
      title: "Result",
      text: "clang emits mov eax, 1. With -fwrapv, overflow wraps by definition, so clang must compare x with INT_MAX.",
      code: [{ text: "int gt(int x) {" }, { text: "    return 1;", mark: "new" }, { text: "}" }],
    },
  ],
  builds: [
    { id: "O0", label: "-O0" },
    { id: "O2", label: "-O2", asm: "gt.O2" },
    { id: "wrapv", label: "-O2 -fwrapv", asm: "gt.O2.fwrapv" },
  ],
  inputs: GT_INPUTS.map((x) => ({ id: String(x), label: x === INT_MAX ? "INT_MAX" : x === INT_MIN ? "INT_MIN" : x === INT_MAX - 1 ? "INT_MAX − 1" : String(x) })),
  ub: (i) => (Number(i) === INT_MAX ? "x + 1 overflows int." : null),
  run: (i, b) => {
    const x = Number(i);
    if (b === "O2") return { kind: "value", value: 1 };
    if (b === "wrapv") return { kind: "value", value: x !== INT_MAX ? 1 : 0 }; // cmp edi, INT_MAX; setne al
    return { kind: "value", value: wrap32(x + 1) > x ? 1 : 0 }; // -O0: add wraps, then compare
  },
};

// ---------------------------------------------------------------- a loop with no side effects (C++ forward progress)

const fermatCase: OptCase = {
  id: "fermat",
  title: "A search loop that never ends",
  lang: "C++",
  steps: [
    {
      title: "Source",
      text: "The loop searches for a³ = b³ + c³ with values up to 1000. No such numbers exist (Euler proved it for cubes), so the search never ends.",
      code: [
        { text: "int fermat() {" },
        { text: "    int a = 1, b = 1, c = 1;" },
        { text: "    while (1) {" },
        { text: "        if (a*a*a == b*b*b + c*c*c) return 1;" },
        { text: "        a++;" },
        { text: "        if (a > 1000) { a = 1; b++; }" },
        { text: "        if (b > 1000) { b = 1; c++; }" },
        { text: "        if (c > 1000) { c = 1; }" },
        { text: "    }" },
        { text: "}" },
      ],
    },
    {
      title: "Derive a fact",
      text: "The loop does no I/O, no volatile access and no atomic or synchronization operation. C++ lets the compiler assume that such a loop ends.",
      rule: "C++ [intro.progress]p1: the implementation may assume that any thread will eventually terminate, call an I/O function, use a volatile glvalue, or do a synchronization or atomic operation.",
      code: [
        { text: "int fermat() {" },
        { text: "    int a = 1, b = 1, c = 1;" },
        { text: "    while (1) {", mark: "fact", note: "assumed to end" },
        { text: "        if (a*a*a == b*b*b + c*c*c) return 1;" },
        { text: "        a++;" },
        { text: "        if (a > 1000) { a = 1; b++; }" },
        { text: "        if (b > 1000) { b = 1; c++; }" },
        { text: "        if (c > 1000) { c = 1; }" },
        { text: "    }" },
        { text: "}" },
      ],
    },
    {
      title: "Find the exits",
      text: "The only way out of the loop is return 1. If the loop ends, the function returns 1. The loop computes nothing else that is visible.",
      code: [
        { text: "int fermat() {" },
        { text: "    int a = 1, b = 1, c = 1;", mark: "dead" },
        { text: "    while (1) {", mark: "dead" },
        { text: "        if (a*a*a == b*b*b + c*c*c) return 1;", mark: "fact", note: "the only exit" },
        { text: "        a++;", mark: "dead" },
        { text: "        if (a > 1000) { a = 1; b++; }", mark: "dead" },
        { text: "        if (b > 1000) { b = 1; c++; }", mark: "dead" },
        { text: "        if (c > 1000) { c = 1; }", mark: "dead" },
        { text: "    }", mark: "dead" },
        { text: "}" },
      ],
    },
    {
      title: "Result",
      text: "clang compiles the C++ function to mov eax, 1. The same code compiled as C keeps the loop: the condition 1 is a constant, so C11 6.8.5p6 does not apply.",
      code: [{ text: "int fermat() {" }, { text: "    return 1;", mark: "new", note: "a 'counterexample'" }, { text: "}" }],
    },
  ],
  builds: [
    { id: "O0", label: "-O0" },
    { id: "cpp", label: "C++17 -O2", asm: "fermat.cpp17" },
    { id: "c", label: "C11 -O2", asm: "fermat.c11" },
  ],
  inputs: [{ id: "none", label: "no input" }],
  ub: () => "In C++, a loop with no observable effect that never ends has undefined behavior.",
  run: (_i, b) => (b === "cpp" ? { kind: "value", value: 1 } : { kind: "hang" }),
};

/** One step of the Fermat search, for a test that the search finds nothing in a small range. */
export function fermatSearch(max: number): number {
  let found = 0;
  for (let c = 1; c <= max; c++) for (let b = 1; b <= max; b++) for (let a = 1; a <= max; a++) if (a * a * a === b * b * b + c * c * c) found++;
  return found;
}

// ---------------------------------------------------------------- an overflow check written after the overflow

/** Inputs (a, b) for the overflow-check case. */
export const ADD_INPUTS: [number, number][] = [[2, 3], [-7, -9], [INT_MAX - 5, 5], [INT_MAX, INT_MAX], [INT_MAX - 5, 6]];

export type CheckForm = "after" | "before" | "builtin" | "unsigned";

/** The four ways to write the check, with the real -O2 output of each. */
export const CHECK_FORMS: { id: CheckForm; label: string; code: string[]; asm: GoldenKey; kept: boolean }[] = [
  { id: "after", label: "a + b < a", asm: "add_bad.O2", kept: false, code: ["if (b > 0 && a + b < a)", "    return -1;", "return a + b;"] },
  { id: "before", label: "a > INT_MAX - b", asm: "add_pre.O2", kept: true, code: ["if (b > 0 && a > INT_MAX - b)", "    return -1;", "return a + b;"] },
  { id: "builtin", label: "__builtin_add_overflow", asm: "add_builtin.O2", kept: true, code: ["int r;", "if (__builtin_add_overflow(a, b, &r))", "    return -1;", "return r;"] },
  { id: "unsigned", label: "unsigned add", asm: "add_unsigned.O2", kept: true, code: ["int r = (int)((unsigned)a + (unsigned)b);", "if (b > 0 && r < a)", "    return -1;", "return r;"] },
];

/** What each form returns at -O2, following its golden assembly. */
export function runCheck(form: CheckForm, a: number, b: number, wrapv = false): number {
  const sum = wrap32(a + b);
  switch (form) {
    case "after":
      // -O2: lea eax, [rdi + rsi]: the check is gone. With -fwrapv the check stays and works.
      return wrapv ? (b > 0 && sum < a ? -1 : sum) : sum;
    case "before":
      return b > 0 && a > INT_MAX - b ? -1 : sum;
    case "builtin":
      return a + b > INT_MAX || a + b < INT_MIN ? -1 : sum;
    case "unsigned":
      // conversion of an out-of-range unsigned to int is implementation-defined; GCC and Clang wrap
      return b > 0 && sum < a ? -1 : sum;
  }
}

/** True if a + b overflows int: the source program has UB for the "after" form. */
export const addOverflows = (a: number, b: number) => a + b > INT_MAX || a + b < INT_MIN;

const checkCase: OptCase = {
  id: "check",
  title: "An overflow check after the overflow",
  lang: "C",
  steps: [
    {
      title: "Source",
      text: "The function tries to detect overflow by looking at the wrapped sum. This works only if the sum wraps.",
      code: [
        { text: "int add(int a, int b) {" },
        { text: "    if (b > 0 && a + b < a)" },
        { text: "        return -1;" },
        { text: "    return a + b;" },
        { text: "}" },
      ],
    },
    {
      title: "Derive a fact",
      text: "a + b on int is UB if it overflows. So in a defined execution, a + b is the exact sum.",
      rule: "C11 6.5p5: an exceptional condition in an expression is undefined behavior.",
      code: [
        { text: "int add(int a, int b) {" },
        { text: "    if (b > 0 && a + b < a)", mark: "fact", note: "a + b is exact" },
        { text: "        return -1;" },
        { text: "    return a + b;" },
        { text: "}" },
      ],
    },
    {
      title: "Fold with algebra",
      text: "For exact integers, a + b < a is the same as b < 0. With b > 0 also true, the condition is b > 0 && b < 0: always false.",
      code: [
        { text: "int add(int a, int b) {" },
        { text: "    if (b > 0 && b < 0)", mark: "fold", note: "was a + b < a" },
        { text: "        return -1;" },
        { text: "    return a + b;" },
        { text: "}" },
      ],
    },
    {
      title: "Remove dead code",
      text: "The branch never runs, so the compiler deletes it. The overflow check is gone.",
      code: [
        { text: "int add(int a, int b) {" },
        { text: "    if (0)", mark: "dead" },
        { text: "        return -1;", mark: "dead" },
        { text: "    return a + b;" },
        { text: "}" },
      ],
    },
    {
      title: "Result",
      text: "clang emits one lea instruction. With -fwrapv the check stays, because then a + b wraps by definition.",
      code: [{ text: "int add(int a, int b) {" }, { text: "    return a + b;", mark: "new" }, { text: "}" }],
    },
  ],
  builds: [
    { id: "O0", label: "-O0" },
    { id: "O2", label: "-O2", asm: "add_bad.O2" },
    { id: "wrapv", label: "-O2 -fwrapv", asm: "add_bad.O2.fwrapv" },
  ],
  inputs: ADD_INPUTS.map(([a, b]) => ({ id: `${a},${b}`, label: `a = ${a === INT_MAX ? "INT_MAX" : a === INT_MAX - 5 ? "INT_MAX − 5" : a}, b = ${b === INT_MAX ? "INT_MAX" : b}` })),
  ub: (i) => {
    const [a, b] = i.split(",").map(Number) as [number, number];
    return addOverflows(a, b) ? "a + b overflows int." : null;
  },
  run: (i, b) => {
    const [x, y] = i.split(",").map(Number) as [number, number];
    // -O0 computes the wrapped sum and compares, like -fwrapv
    return { kind: "value", value: runCheck("after", x, y, b !== "O2") };
  },
};

export const OPT_CASES: OptCase[] = [nullCase, gtCase, fermatCase, checkCase];
export const optCase = (id: string) => OPT_CASES.find((c) => c.id === id)!;

/** The golden assembly lines of a key. */
export const asmOf = (k: GoldenKey): readonly string[] => GOLDEN[k].asm;
export const cmdOf = (k: GoldenKey): string => GOLDEN[k].cmd;
