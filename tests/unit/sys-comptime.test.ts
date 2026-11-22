/** Tests for src/sims/sys/comptime: every number that the comptime lessons quote is pinned here. */
import { describe, expect, test } from "vitest";
import {
  CALL_SITES, CLANG_DEPTH, CLANG_STEPS, DEFAULT_QUOTA, DYN_LOOP, MEASURED_MAX, RUSTC_TABLE, SORT_RUNS, SPEC_TABLE, STATIC_LOOP, SYMS, TRAITS, TYPES,
  ZIG_QUOTA, checkFormat, checkImpl, cost, crossover, emittedCalls, expectedSum, fibCalls, fibTree, frames, instancesFor, instantiate,
  largestBudgetN, largestN, monoModel, perElement, rustcMessage, sortLineError, sortSlopes, sortSource, specialize, zigFn,
} from "../../src/sims/sys/comptime";

// ---------------------------------------------------------------- Zig comptime

describe("zig partial evaluator", () => {
  test("the default quota is 1000", () => expect(DEFAULT_QUOTA).toBe(1000));
  test("power: inline for (0..1000) compiles, 0..1001 does not (zig 0.17.1)", () => {
    expect(specialize(zigFn("power"), 1000).ok).toBe(true);
    const r = specialize(zigFn("power"), 1001);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("evaluation exceeded 1000 backwards branches");
    expect(r.errorNote).toBe("use @setEvalBranchQuota() to raise the branch limit from 1000");
    expect(largestN(zigFn("power"))).toBe(1000);
    expect(largestN(zigFn("power"), 2000)).toBe(2000);
  });
  test("sumTo at comptime: 999 compiles, 1000 does not (1 call + n iterations)", () => {
    expect(largestN(zigFn("sumto"))).toBe(999);
    const r = specialize(zigFn("sumto"), 999);
    expect(r.value).toBe(498501);
    expect(r.branches).toBe(1000);
    expect(r.residual.map((l) => l.text)).toEqual(["498501;"]);
  });
  test("power(x, 3): two multiplies, the first copy is folded away", () => {
    const r = specialize(zigFn("power"), 3);
    expect(r.residual.map((l) => l.text)).toEqual(["const r1 = x * x;", "const r2 = r1 * x;", "return r2;"]);
    expect(r.liveMuls).toBe(2);
    expect(r.branches).toBe(3);
  });
  test("power(x, n) needs n - 1 multiplies; powSq(x, 13) needs 5 and leaves one dead line", () => {
    expect(specialize(zigFn("power"), 13).liveMuls).toBe(12);
    const r = specialize(zigFn("powsq"), 13);
    expect(r.liveMuls).toBe(5);
    expect(r.residual.filter((l) => l.dead).map((l) => l.text)).toEqual(["const base4 = base3 * base3;"]);
    expect(r.branches).toBe(4);
    expect(specialize(zigFn("powsq"), 1000).liveMuls).toBe(14);
  });
  test("power with n = 0 returns the constant 1", () => {
    expect(specialize(zigFn("power"), 0).residual.map((l) => l.text)).toEqual(["return 1;"]);
  });
  test("a runtime n is a compile error", () => {
    const r = specialize(zigFn("power"), 3, { nKnown: false });
    expect(r.error).toBe("unable to resolve comptime value");
  });
  test("calls with the same comptime value share one instance", () => {
    expect(instancesFor([3, 5, 3])).toEqual([{ n: 3, calls: 2 }, { n: 5, calls: 1 }]);
  });
  test("the trace ends with the return and counts every branch", () => {
    const r = specialize(zigFn("powsq"), 13);
    expect(r.trace.at(-1)!.branches).toBe(4);
    expect(r.trace.at(-1)!.emitted).toBe(r.residual.length);
  });
});

describe("zig format check", () => {
  test("a good format string: literal and value pieces, and the output", () => {
    const r = checkFormat("{d} items for {s}", 2);
    expect(r.error).toBeUndefined();
    expect(r.output).toBe("42 items for zig");
    expect(emittedCalls(r)).toHaveLength(3);
    expect(r.quota).toBe(17000);
  });
  test("the errors that std.Io.Writer.print raises", () => {
    expect(checkFormat("{d} and {s}", 1).error).toBe("too few arguments");
    expect(checkFormat("{d} {s}", 3).error).toBe("unused argument in '{d} {s}'");
    expect(checkFormat("{d}", 3).error).toBe("2 unused arguments in '{d}'");
    expect(checkFormat("{d", 1).error).toBe("missing closing }");
    expect(checkFormat("a } b", 0).error).toBe("missing opening {");
    expect(checkFormat("{s}", 1).error).toBe("invalid format string 's' for type 'u32'");
    expect(checkFormat("{d} {}", 2).error).toBe("cannot format slice without a specifier (i.e. {s}, {x}, {b64}, or {any})");
  });
  test("escapes and positions", () => {
    expect(checkFormat("{{{d}}}", 1).output).toBe("{42}");
    expect(checkFormat("{[1]s} {[0]d}", 2).output).toBe("zig 42");
    expect(checkFormat("{x} {s} {e}", 3).output).toBe("2a zig 2.5e0");
  });
  test("the table: {any} prints every type, {s} only strings", () => {
    expect(Object.values(SPEC_TABLE.any!).every((c) => "out" in c)).toBe(true);
    expect(Object.entries(SPEC_TABLE.s!).filter(([, c]) => "out" in c).map(([t]) => t)).toEqual(["[]const u8"]);
  });
});

// ---------------------------------------------------------------- C++ templates

describe("C++ instantiation across translation units", () => {
  const all = CALL_SITES.filter((c) => !c.error).map((c) => c.id);
  test("all good call sites: 11 instances compiled, 10 kept, one max<int> copy dropped", () => {
    const r = instantiate({ on: all, externInB: false, explicitInA: false });
    expect(r.compiled).toBe(11);
    expect(r.kept).toHaveLength(10);
    expect(r.dropped).toBe(1);
    expect(r.droppedBytes).toBe(37);
  });
  test("extern template in b.cpp: no duplicate, and the link still works because a.cpp has max<int>", () => {
    const r = instantiate({ on: all, externInB: true, explicitInA: false });
    expect(r.compiled).toBe(10);
    expect(r.dropped).toBe(0);
    expect(r.missing).toEqual([]);
  });
  test("extern template without a definition: undefined symbol", () => {
    const r = instantiate({ on: all.filter((x) => x !== "a1"), externInB: true, explicitInA: false });
    expect(r.missing).toEqual(["maxInt"]);
    expect(r.linkError![0]).toBe("ld.lld: error: undefined symbol: int max_of<int>(int, int)");
    expect(instantiate({ on: all.filter((x) => x !== "a1"), externInB: true, explicitInA: true }).missing).toEqual([]);
  });
  test("members are instantiated on use: Stack<int> has no size(), Stack<double> has no pop()", () => {
    const r = instantiate({ on: all, externInB: false, explicitInA: false });
    expect(r.kept.map((s) => SYMS[s]!.demangled).filter((d) => d.startsWith("Stack"))).toEqual([
      "Stack<int>::Stack()", "Stack<int>::push(int)", "Stack<int>::pop()", "Stack<double>::Stack()", "Stack<double>::push(double)", "Stack<double>::size() const",
    ]);
  });
  test("a deduction failure stops the file: no object, no link", () => {
    const r = instantiate({ on: ["a1", "a4", "b1"], externInB: false, explicitInA: false });
    expect(r.tus[0]!.defined).toEqual([]);
    expect(r.tus[0]!.errors[0]![1]).toContain("deduced conflicting types for parameter 'T' ('int' vs. 'double')");
    expect(r.linkError).toBeDefined();
  });
  test("mangled names", () => {
    expect(SYMS.maxInt!.name).toBe("_Z6max_ofIiET_S0_S0_");
    expect(SYMS.maxDbl!.name).toBe("_Z6max_ofIdET_S0_S0_");
  });
});

describe("constant evaluation budgets", () => {
  test("clang and zig defaults", () => {
    expect(CLANG_STEPS).toBe(1048576);
    expect(CLANG_STEPS).toBe(2 ** 20);
    expect(CLANG_DEPTH).toBe(512);
    expect(ZIG_QUOTA).toBe(1000);
  });
  test("the model gives the measured largest n for every function and evaluator", () => {
    for (const fn of ["sumTo", "fibLoop", "fib"] as const) for (const ev of ["clang", "zig"] as const) expect(largestBudgetN(fn, ev), `${fn} ${ev}`).toBe(MEASURED_MAX[fn][ev]);
  });
  test("fib calls: fib(13) makes 753 calls, fib(14) 1219, fib(26) 392835, fib(27) 635621", () => {
    expect([13, 14, 26, 27].map(fibCalls)).toEqual([753, 1219, 392835, 635621]);
  });
  test("clang: fib(27) needs 1271242 steps; the depth limit is hit at 513 nested calls", () => {
    expect(cost("fib", 27, "clang").work).toBe(1271242);
    expect(cost("fib", 27, "clang").message).toBe("constexpr evaluation hit maximum step limit; possible infinite loop?");
    expect(cost("fib", 26, "clang").work).toBe(785670);
  });
  test("each step of N multiplies the fib calls by about 1.6; the loop reaches about 10,000 times further", () => {
    expect(Math.round((fibCalls(20) / fibCalls(19)) * 10) / 10).toBe(1.6);
    expect(Math.round(MEASURED_MAX.fibLoop.clang / MEASURED_MAX.fib.clang / 1000)).toBe(10);
  });
  test("the fib tree has one node per call", () => {
    expect(fibTree(7)).toHaveLength(fibCalls(7));
    expect(fibCalls(7)).toBe(41);
  });
});

// ---------------------------------------------------------------- Rust generics and traits

describe("static and dynamic dispatch", () => {
  test("instructions per element, counted from the rustc listings", () => {
    const p = perElement();
    expect(p.staticUnrolled).toBe(3.75);
    expect(p.staticRemainder).toBe(6);
    expect(p.dynSquare).toBe(17);
    expect(p.dynCircle).toBe(19);
  });
  test("the replay adds up to the right sums, with one indirect call per element", () => {
    for (const mode of ["static", "dyn"] as const) {
      const fr = frames(mode);
      expect(Number(fr.at(-1)!.regs.xmm0)).toBeCloseTo(expectedSum(mode), 3);
    }
    const d = frames("dyn");
    expect(d.at(-1)!.indirect).toBe(3);
    expect(d.at(-1)!.count).toBe(17 * 2 + 19);
    expect(frames("static").at(-1)!.count).toBe(18);
  });
  test("the listings", () => {
    expect(DYN_LOOP.some((l) => l.text.includes("call   qword ptr [rax + 24]"))).toBe(true);
    expect(STATIC_LOOP.some((l) => l.text.includes("call"))).toBe(false);
  });
});

describe("orphan rule", () => {
  test("the model agrees with rustc 1.96.1 on every cell", () => {
    for (const t of TRAITS) for (const ty of TYPES) {
      const v = checkImpl(t.id, ty.id);
      expect(v.ok ? "OK" : v.code, `${t.id} for ${ty.id}`).toBe(RUSTC_TABLE[t.id]![ty.id]);
    }
  });
  test("messages", () => {
    expect(rustcMessage("Display", "VecU8")).toMatch(/^error\[E0117\]/);
    expect(rustcMessage("From", "T")).toContain("must be covered by another type");
    expect(rustcMessage("Describe", "T")).toBeNull();
  });
});

// ---------------------------------------------------------------- monomorphization costs

describe("monomorphization model", () => {
  const p = { types: 8, depth: 4, body: 400, methods: 2 };
  test("generic: K·D copies; outlined: K·D wrappers + D bodies; dyn: D copies + K vtables", () => {
    expect(monoModel("generic", p).functions).toBe(32);
    expect(monoModel("generic", p).total).toBe(12800);
    expect(monoModel("outlined", p).total).toBe(8 * 4 * 24 + 4 * 400);
    expect(monoModel("outlined", p).total).toBe(2368);
    expect(monoModel("dyn", p).total).toBe(4 * 400 + 8 * 5 * 8);
    expect(monoModel("dyn", p).total).toBe(1920);
    expect(monoModel("dyn", p).indirectCalls).toBe(8);
  });
  test("the demo defaults: K = 4, D = 3, 400 B: 12 copies and 4,800 B; outlined 1,488 B; dyn 1,360 B; crossover at 2", () => {
    const d = { types: 4, depth: 3, body: 400, methods: 2 };
    expect(monoModel("generic", d).functions).toBe(12);
    expect(monoModel("generic", d).total).toBe(4800);
    expect(monoModel("outlined", d).total).toBe(1488);
    expect(monoModel("dyn", d).total).toBe(1360);
    expect(crossover({ depth: 3, body: 400, methods: 2 })).toBe(2);
    expect(monoModel("dyn", { ...d, types: 1 }).total).toBeGreaterThan(monoModel("generic", { ...d, types: 1 }).total);
  });
  test("dyn is smaller from 2 types on, with these inputs", () => {
    expect(crossover({ depth: 4, body: 400, methods: 2 })).toBe(2);
  });
});

describe("measured: N sort_by closures in rustc 1.96.1", () => {
  test("sizes are a straight line: 5376 B per closure for generic, 96 B for dyn", () => {
    const s = sortSlopes();
    expect(s.genericPer).toBe(5376);
    expect(s.dynPer).toBe(96);
    expect(s.genericBase).toBe(-84);
    expect(sortLineError()).toBe(0);
    expect(Math.round(s.sizeRatio32 * 10) / 10).toBe(18);
  });
  test("32 closures: 171948 B against 9536 B; 1.91 s against 0.13 s", () => {
    const r = SORT_RUNS.at(-1)!;
    expect([r.n, r.genericText, r.dynText, r.genericSec, r.dynSec]).toEqual([32, 171948, 9536, 1.91, 0.13]);
    expect(Math.round(sortSlopes().timeRatio32)).toBe(15);
  });
  test("the one-closure crate: generic is smaller than dyn", () => {
    expect(SORT_RUNS[0]!.genericText).toBeLessThan(SORT_RUNS[0]!.dynText);
    expect(SORT_RUNS[1]!.genericText).toBeGreaterThan(SORT_RUNS[1]!.dynText);
  });
  test("the source generator", () => {
    expect(sortSource(2, "generic").split("\n")).toHaveLength(4);
    expect(sortSource(2, "dyn")).toContain("&dyn Fn(&Rec, &Rec) -> Ordering");
  });
});
