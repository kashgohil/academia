/**
 * C++ template instantiation across two translation units, and what the linker keeps.
 *
 * The header max.h defines `max_of<T>` and `Stack<T>`. Each call site in a.cpp or b.cpp makes the compiler
 * instantiate some functions in that translation unit (TU). Each instance goes into its own COMDAT section as
 * a weak (W) symbol. The linker keeps one copy of each name and drops the rest. An `extern template`
 * declaration stops b.cpp from instantiating `max_of<int>`; then some other TU must provide it, or the link fails.
 *
 * The symbol names and sizes are facts about one compiler: `zig c++ -target x86_64-linux-gnu -O0
 * -fno-sanitize=all` (clang 21 inside zig 0.17.1), read with `nm -S`. At -O2 the same files keep no
 * template instance at all: every call is inlined.
 */

export interface Sym { name: string; demangled: string; bytes: number }

/** Every instance that the call sites can create. Sizes are from `nm -S` of the -O0 ELF objects. */
export const SYMS: Record<string, Sym> = {
  maxInt: { name: "_Z6max_ofIiET_S0_S0_", demangled: "int max_of<int>(int, int)", bytes: 0x25 },
  maxDbl: { name: "_Z6max_ofIdET_S0_S0_", demangled: "double max_of<double>(double, double)", bytes: 0x3b },
  maxLong: { name: "_Z6max_ofIlET_S0_S0_", demangled: "long max_of<long>(long, long)", bytes: 0x2e },
  maxChar: { name: "_Z6max_ofIcET_S0_S0_", demangled: "char max_of<char>(char, char)", bytes: 0x2f },
  stIntCtor: { name: "_ZN5StackIiEC2Ev", demangled: "Stack<int>::Stack()", bytes: 0x15 },
  stIntPush: { name: "_ZN5StackIiE4pushEi", demangled: "Stack<int>::push(int)", bytes: 0x25 },
  stIntPop: { name: "_ZN5StackIiE3popEv", demangled: "Stack<int>::pop()", bytes: 0x1d },
  stDblCtor: { name: "_ZN5StackIdEC2Ev", demangled: "Stack<double>::Stack()", bytes: 0x18 },
  stDblPush: { name: "_ZN5StackIdE4pushEd", demangled: "Stack<double>::push(double)", bytes: 0x31 },
  stDblSize: { name: "_ZNK5StackIdE4sizeEv", demangled: "Stack<double>::size() const", bytes: 0x14 },
};
export type SymId = keyof typeof SYMS;

export interface CallSite {
  id: string;
  tu: "a" | "b";
  code: string;
  /** What the compiler deduces or reads, for the caption. */
  note: string;
  creates: SymId[];
  /** A deduction failure: clang 21's message. */
  error?: string[];
}

export const CALL_SITES: CallSite[] = [
  { id: "a1", tu: "a", code: "max_of(x, y)       // int, int", note: "T is deduced as int from both arguments.", creates: ["maxInt"] },
  { id: "a2", tu: "a", code: "max_of(p, q)       // double, double", note: "T is deduced as double.", creates: ["maxDbl"] },
  { id: "a3", tu: "a", code: "max_of<long>(x, n) // int, long", note: "T is given as long. The int argument converts, so there is no deduction.", creates: ["maxLong"] },
  {
    id: "a4", tu: "a", code: "max_of(x, 2.5)     // int, double", note: "Deduction gives int from the first argument and double from the second.", creates: [],
    error: [
      "error: no matching function for call to 'max_of'",
      "note: candidate template ignored: deduced conflicting types for parameter 'T' ('int' vs. 'double')",
    ],
  },
  { id: "a5", tu: "a", code: "Stack<int> s; s.push(1); s.pop();", note: "Only the members that the code uses are instantiated: the constructor, push and pop. size() is not.", creates: ["stIntCtor", "stIntPush", "stIntPop"] },
  { id: "b1", tu: "b", code: "max_of(x, y)       // int, int", note: "The same instance as a1, compiled again in b.cpp.", creates: ["maxInt"] },
  { id: "b2", tu: "b", code: "max_of(c, d)       // char, char", note: "T is deduced as char: a new instance.", creates: ["maxChar"] },
  { id: "b3", tu: "b", code: "Stack<double> d; d.push(1.0); d.size();", note: "A new class instance. Its members are instantiated on use: the constructor, push and size, not pop.", creates: ["stDblCtor", "stDblPush", "stDblSize"] },
];

export interface TuOutput {
  tu: "a" | "b";
  /** Instances defined here (W in nm), in order. */
  defined: SymId[];
  /** References to instances that this TU does not define (U in nm). */
  undefinedRefs: SymId[];
  errors: string[][];
}
export interface LinkResult {
  tus: TuOutput[];
  /** Instances that the compiler built, over both TUs. */
  compiled: number;
  compiledBytes: number;
  /** One copy of each name: what the binary keeps. */
  kept: SymId[];
  keptBytes: number;
  /** Copies that the linker dropped, and their bytes. */
  dropped: number;
  droppedBytes: number;
  /** Undefined symbols after the link: the link fails. */
  missing: SymId[];
  /** lld's message for the first missing symbol. */
  linkError?: string[];
}

export interface InstOptions {
  on: string[];
  /** `extern template int max_of<int>(int, int);` in b.cpp. */
  externInB: boolean;
  /** `template int max_of<int>(int, int);` in a.cpp: an explicit instantiation definition. */
  explicitInA: boolean;
}

export function instantiate({ on, externInB, explicitInA }: InstOptions): LinkResult {
  const tus: TuOutput[] = (["a", "b"] as const).map((tu) => {
    const defined: SymId[] = [];
    const undefinedRefs: SymId[] = [];
    const errors: string[][] = [];
    if (tu === "a" && explicitInA) defined.push("maxInt");
    for (const c of CALL_SITES) {
      if (c.tu !== tu || !on.includes(c.id)) continue;
      if (c.error) errors.push(c.error);
      for (const s of c.creates) {
        if (tu === "b" && externInB && s === "maxInt") { if (!undefinedRefs.includes(s)) undefinedRefs.push(s); continue; }
        if (!defined.includes(s)) defined.push(s);
      }
    }
    // A file with an error produces no object file at all.
    if (errors.length) return { tu, defined: [], undefinedRefs: [], errors };
    return { tu, defined, undefinedRefs, errors };
  });
  const all = tus.flatMap((t) => t.defined);
  const kept = [...new Set(all)];
  const bytes = (ids: SymId[]) => ids.reduce((a, s) => a + SYMS[s]!.bytes, 0);
  const missing = [...new Set(tus.flatMap((t) => t.undefinedRefs))].filter((s) => !kept.includes(s));
  const res: LinkResult = {
    tus, compiled: all.length, compiledBytes: bytes(all), kept, keptBytes: bytes(kept),
    dropped: all.length - kept.length, droppedBytes: bytes(all) - bytes(kept), missing,
  };
  const broken = tus.find((t) => t.errors.length);
  if (broken) {
    res.linkError = [`${broken.tu}.cpp does not compile, so there is no ${broken.tu}.o to link`];
  } else if (missing.length) {
    const s = SYMS[missing[0]!]!;
    res.linkError = [`ld.lld: error: undefined symbol: ${s.demangled}`, ">>> referenced by b.cpp:3", ">>>               b.o:(b1(int, int))"];
  }
  return res;
}
