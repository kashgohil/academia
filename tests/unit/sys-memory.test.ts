import { describe, expect, test } from "vitest";
import { layoutC, layoutRust, optimalOrder, struct, T, TARGET_IDS, wasted, type TargetId } from "../../src/sims/sys/mem";
import {
  allocTimeShare, arith, budgets, bufferFileCost, counterLayout, cppGrow, distinctCaps, ELEMS, ESCAPE_CASES, FAT_POINTERS, fileAndMemory,
  finalValue, GALLERY, GLOBALS, globalsOf, goGrow, goLargestStack, goNextSliceCap, goRoundupsize, goSizedMake, goStackGrowth, HOLD, initOrder,
  lifetimeScript, maxDepth, MiB, packedAccess, pushAll, RETURN_LOCAL, runScript, rustGrow, sliceOf, STACK_KINDS,
} from "../../src/sims/sys/memory";

describe("stack and heap", () => {
  test("return a pointer to a local: C and Zig dangle, Rust's fix and Go are clean", () => {
    const kinds = Object.fromEntries(RETURN_LOCAL.map((p) => [p.lang, runScript(p.script).machine.ub.map((u) => u.kind)]));
    expect(kinds.c).toEqual(["stack-use-after-return", "stack-use-after-return"]);
    expect(kinds.zig).toEqual(["stack-use-after-return"]);
    expect(kinds.rust).toEqual([]);
    expect(kinds.go).toEqual([]);
  });
  test("C: the second read through the dangling pointer sees other's 7", () => {
    const { machine } = runScript(RETURN_LOCAL.find((p) => p.lang === "c")!.script);
    const reads = machine.trace.filter((e) => e.op === "load" && e.ub).map((e) => e.detail);
    expect(reads.length).toBe(2);
    expect(reads[0]).toContain("42");
    expect(reads[1]).toContain("7");
  });
  test("every step's line exists in the program it runs", () => {
    for (const p of RETURN_LOCAL) {
      const src = p.runs === "fix" ? p.fixSource! : p.source;
      for (const s of runScript(p.script).steps.slice(1)) expect(s.line, p.lang).toBeLessThanOrEqual(src.length);
    }
  });
  test("escape cases: verdicts match the -m output", () => {
    for (const c of ESCAPE_CASES) {
      const heap = c.output.some((o) => o.includes("moved to heap") || / escapes to heap/.test(o));
      if (c.where === "heap") expect(heap, c.id).toBe(true);
      else expect(heap, c.id).toBe(false);
    }
    expect(ESCAPE_CASES.length).toBe(11);
  });
  test("Go 1.25 variable make: a 32-byte stack buffer", () => {
    expect(goSizedMake(32)).toBe("stack");
    expect(goSizedMake(33)).toBe("heap");
    expect(goSizedMake(4, 8)).toBe("stack");
    expect(goSizedMake(5, 8)).toBe("heap");
  });
  test("allocation cost model: 10 million allocations per second at 20 ns is 0.2 s per second", () => {
    expect(allocTimeShare(10e6)).toBeCloseTo(0.2, 10);
  });
  test("stack depth: 1 KiB frames", () => {
    expect(maxDepth(8 * MiB, 1024)).toBe(8192);
    expect(maxDepth(2 * MiB, 1024)).toBe(2048);
    const b = budgets(1024, 10000);
    expect(b.map((x) => x.fits)).toEqual([false, false, false, true]);
    expect(STACK_KINDS.map((k) => k.limit)).toEqual([8 * MiB, 2 * MiB, 2 * MiB, 1_000_000_000]);
  });
  test("Go stacks double from 2 KiB; the largest is 512 MiB", () => {
    expect(goLargestStack()).toBe(512 * MiB);
    const g = goStackGrowth(10_000 * 1024);
    expect(g.size).toBe(16 * MiB);
    expect(g.sizes.length - 1).toBe(13);
    expect(g.copied).toBe(16 * MiB - 2048);
    expect(goStackGrowth(512 * MiB).overflow).toBe(false);
    expect(goStackGrowth(512 * MiB + 1).overflow).toBe(true);
    // 18 doublings from 2 KiB reach 512 MiB
    expect(goStackGrowth(512 * MiB).sizes.length - 1).toBe(18);
  });
});

describe("static data", () => {
  test("a 1 MiB buffer: no file bytes in .bss, 1,048,576 with a nonzero initializer", () => {
    expect(bufferFileCost(false)).toBe(0);
    expect(bufferFileCost(true)).toBe(1_048_576);
    // measured: 1,049,912 - 1,336 bytes (zig cc 0.17.1 -O0 -g0 -c)
    expect(1_049_912 - 1_336).toBe(bufferFileCost(true));
  });
  test("C globals at N = 1024: file and memory", () => {
    const fm = fileAndMemory(globalsOf("c"), 1024);
    expect(fm.sections.bss).toBe(4096 * 2 + 4);
    expect(fm.sections.data).toBe(4096 + 8);
    expect(fm.sections.rodata).toBe(4096 + 6);
    expect(fm.sections.tdata).toBe(4);
    expect(fm.file).toBe(4096 + 8 + 4096 + 6 + 4);
    expect(fm.memory).toBe(fm.file + 8196);
  });
  test("every language has entries, and the section families are consistent with the exact names", () => {
    for (const l of ["c", "rust", "zig", "go"] as const) expect(globalsOf(l).length).toBeGreaterThanOrEqual(4);
    for (const g of GLOBALS) {
      const fam = g.exact.includes("bss") ? (g.exact.includes("tbss") ? "tbss" : "bss") : g.exact.includes("tdata") ? "tdata" : g.exact.includes("rodata") || g.exact.includes("rel.ro") ? "rodata" : "data";
      expect(g.section, g.id).toBe(fam);
    }
  });
  test("C++ init order depends on link order and declaration order; Go, Rust and Zig do not", () => {
    const all = [true, false].flatMap((a) => [true, false].map((b) => ({ linkLoggerFirst: a, configBeforeCache: b })));
    const cpp = all.map((o) => finalValue(initOrder("cpp", o), "cache"));
    expect(cpp).toEqual([6144, 0, 0, 0]);
    expect(all.map((o) => finalValue(initOrder("cpp", o), "config"))).toEqual([6, 6, 0, 0]);
    for (const lang of ["go", "rust", "zig"] as const) for (const o of all) expect(finalValue(initOrder(lang, o), "cache")).toBe(6144);
    // Go picks logger first even though app.go comes first in file order
    expect(initOrder("go", all[0]!).filter((e) => e.kind === "init").map((e) => e.name)).toEqual(["logger", "config", "cache"]);
    // Rust: main first, then lazily
    expect(initOrder("rust", all[0]!).map((e) => e.name)).toEqual(["main", "logger", "config", "cache"]);
  });
  test("lifetime script: calls keeps its value, the literal write is a segv", () => {
    const { machine } = runScript(lifetimeScript);
    expect(machine.ub.map((u) => u.kind)).toEqual(["segv"]);
    const snap = runScript(lifetimeScript).steps.at(-2)!.snap;
    const g = Object.fromEntries(snap.globals.map((s) => [s.name, s.text]));
    expect(g["count.calls"]).toBe("2");
    expect(g.total).toBe("2");
  });
});

describe("pointers", () => {
  test("p + i moves by i * sizeof(T)", () => {
    const int = ELEMS.find((e) => e.id === "int")!.type;
    const pt = ELEMS.find((e) => e.id === "point")!.type;
    expect(arith(int, 8, 3).addr - arith(int, 8, 3).base).toBe(12);
    expect(arith(pt, 8, 3).addr - arith(pt, 8, 3).base).toBe(36);
    expect(arith(int, 8, 7).ub).toBeNull();
    expect(arith(int, 8, 8).status).toBe("one-past");
    expect(arith(int, 8, 8).ub?.kind).toBe("heap-buffer-overflow");
    expect(arith(int, 8, 9).ub?.kind).toBe("heap-buffer-overflow");
  });
  test("fat pointer sizes are the sum of their words (checked with the compilers)", () => {
    for (const f of FAT_POINTERS) expect(f.words.reduce((s, w) => s + w.bytes, 0), f.id).toBe(f.size);
    const size = Object.fromEntries(FAT_POINTERS.map((f) => [f.type, f.size]));
    expect(size).toMatchObject({ "&[u32]": 16, "&dyn Shape": 16, "Vec<u32>": 24, "[]int32": 24, string: 16, "[]u32": 16, "std::span<int>": 16 });
  });
  test("slicing keeps the data; Go keeps the capacity to the end", () => {
    expect(sliceOf("goslice", 8, 2, 5, 0x1000, 4)).toEqual({ from: 2, len: 3, cap: 6, ptr: 0x1008 });
    expect(sliceOf("slice", 8, 2, 5, 0x1000, 4).cap).toBeUndefined();
  });
  test("Go append growth matches go1.25.6 for []int, []byte and []int32", () => {
    // go run: append one element at a time to a slice that escapes (heap only)
    expect(distinctCaps(pushAll("go", 20000, 8).caps)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 848, 1280, 1792, 2560, 3408, 5120, 7168, 9216, 12288, 16384, 21504]);
    expect(distinctCaps(pushAll("go", 20000, 1).caps)).toEqual([8, 16, 32, 64, 128, 256, 512, 896, 1408, 2048, 3072, 4096, 5376, 6912, 9472, 12288, 16384, 21760]);
    expect(distinctCaps(pushAll("go", 5000, 4).caps)).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 512, 864, 1344, 2048, 3072, 4096, 5440]);
    expect(goGrow(8, 3, 8)).toBe(8); // append([]int{1,2,3}, 4,5,6,7,8): len 8, cap 8
    expect(goGrow(4, 3, 8)).toBe(6);
    expect(goNextSliceCap(513, 512)).toBe(832);
    expect(goRoundupsize(832 * 8)).toBe(6784);
  });
  test("Rust and libc++ growth: 3 becomes 6", () => {
    expect(rustGrow(4, 3, 4)).toBe(6);
    expect(cppGrow(4, 3)).toBe(6);
    expect(distinctCaps(pushAll("rust", 100, 4).caps)).toEqual([4, 8, 16, 32, 64, 128]);
    expect(distinctCaps(pushAll("cpp", 100, 4).caps)).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
    expect(pushAll("cpp", 1000, 4).reallocs).toBe(11);
    expect(pushAll("cpp", 1000, 4).copied).toBe(1023);
  });
  test("hold a pointer, then grow: only C++ is UB", () => {
    const kinds = Object.fromEntries(HOLD.map((h) => [h.lang, runScript(h.script).machine.ub.map((u) => u.kind)]));
    expect(kinds).toEqual({ go: [], cpp: ["heap-use-after-free"], rust: [] });
  });
});

describe("struct layout", () => {
  const S = struct("S", [["c", T.char], ["i", T.int], ["s", T.short]]);
  test("char, int, short: 12 in C, 8 sorted, rustc offsets i0 s4 c6", () => {
    expect(layoutC(S).size).toBe(12);
    expect(wasted(layoutC(S))).toBe(5);
    expect(layoutC(struct("S2", optimalOrder((S as Extract<typeof S, { k: "struct" }>).fields))).size).toBe(8);
    const r = layoutRust({ ...S, repr: "Rust" } as never);
    expect(r.size).toBe(8);
    expect(Object.fromEntries(r.fields.map((f) => [f.name, f.offset]))).toEqual({ i: 0, s: 4, c: 6 });
  });
  test("gallery sizes match zig cc and rustc", () => {
    for (const g of GALLERY) for (const [t, size] of Object.entries(g.checked)) expect(layoutC(g.type(t as TargetId), t as TargetId).size, `${g.id} ${t}`).toBe(size);
    const ep = GALLERY.find((g) => g.id === "epoll")!;
    expect(layoutC(ep.type("x86_64-linux"), "x86_64-linux").fields[1]!.offset).toBe(4);
    expect(layoutC(ep.type("aarch64-linux"), "aarch64-linux").fields[1]!.offset).toBe(8);
    const worst = GALLERY.find((g) => g.id === "worst")!.type("x86_64-linux");
    expect(layoutRust({ ...worst, repr: "Rust" } as never).size).toBe(16);
    for (const t of TARGET_IDS) expect(layoutC(GALLERY.find((g) => g.id === "elfsym")!.type(t), t).size).toBe(24);
  });
  test("packed field: through the struct and memcpy are fine; a uint32_t * is misaligned except at i = 3", () => {
    const addrs = Array.from({ length: 8 }, (_, i) => packedAccess(i, "pointer"));
    expect(addrs.map((a) => a.ub?.kind ?? "ok")).toEqual(["misaligned-access", "misaligned-access", "misaligned-access", "ok", "misaligned-access", "misaligned-access", "misaligned-access", "ok"]);
    for (let i = 0; i < 8; i++) {
      expect(packedAccess(i, "field").ub).toBeNull();
      expect(packedAccess(i, "memcpy").ub).toBeNull();
    }
  });
  test("counters: 8 share one line; alignas(64) gives each its own", () => {
    expect(counterLayout(8, 8)).toMatchObject({ stride: 8, total: 64, maxShare: 8 });
    expect(counterLayout(8, 64)).toMatchObject({ stride: 64, total: 512, maxShare: 1 });
    expect(counterLayout(8, 128)).toMatchObject({ stride: 128, total: 1024, maxShare: 1 });
  });
});

describe("numbers quoted in the lessons", () => {
  test("stack-and-heap: 64 KiB frames, 2,000,000 deep", () => {
    expect(maxDepth(2 * MiB, 64 * 1024)).toBe(32);
    const b = budgets(1024, 2_000_000);
    expect(b.every((x) => !x.fits)).toBe(true);
  });
  test("pointers: growth after 1,000 pushes of 8 bytes", () => {
    expect([pushAll("go", 1000, 8), pushAll("rust", 1000, 8), pushAll("cpp", 1000, 8)].map((r) => [r.reallocs, r.copied])).toEqual([[12, 1871], [9, 1020], [11, 1023]]);
    const go = pushAll("go", 1_000_000, 8);
    expect(go.copied / 1_000_000).toBeCloseTo(4.15, 2);
    expect(pushAll("rust", 10_000, 8).copied / 10_000).toBeLessThan(2);
    expect(pushAll("cpp", 10_000, 8).copied / 10_000).toBeLessThan(2);
    expect(pushAll("go", 1, 1).caps[0]).toBe(8);
    expect(pushAll("rust", 1, 1).caps[0]).toBe(8);
    expect(goNextSliceCap(4, 3)).toBe(6);
    // Go 1.25, a slice that does not escape: 32-byte stack buffer first (checked with go run: 4 8 16 ... and 32 64 ...)
    const local = pushAll("go", 1000, 8, 32);
    expect([local.reallocs, local.copied]).toEqual([10, 1868]);
    expect(distinctCaps(pushAll("go", 20000, 8, 32).caps)).toEqual([4, 8, 16, 32, 64, 128, 256, 512, 848, 1280, 1792, 2560, 3408, 5120, 7168, 9216, 12288, 16384, 21504]);
    expect(distinctCaps(pushAll("go", 20000, 1, 32).caps)).toEqual([32, 64, 128, 256, 512, 896, 1408, 2048, 3072, 4096, 5376, 6912, 9472, 12288, 16384, 21760]);
    expect(distinctCaps(pushAll("go", 5000, 4, 32).caps)).toEqual([8, 16, 32, 64, 128, 256, 512, 864, 1344, 2048, 3072, 4096, 5440]);
  });
  test("struct layout: M on i386 and padding positions on x86-64", () => {
    const M = GALLERY.find((g) => g.id === "worst")!.type("i386-linux");
    expect(layoutC(M, "i386-linux").size).toBe(24);
    const l = layoutC(GALLERY.find((g) => g.id === "worst")!.type("x86_64-linux"));
    expect(l.holes.map((h) => [h.offset, h.size])).toEqual([[1, 7], [17, 3], [26, 6]]);
    expect(wasted(l)).toBe(16);
  });
  test("Option niches", async () => {
    const { option, box, T: TT } = await import("../../src/sims/sys/mem");
    expect([option(box(TT.u8)), option(TT.char32), option(TT.u32), option(TT.bool)].map((t) => layoutRust(t).size)).toEqual([8, 4, 8, 1]);
  });
});
