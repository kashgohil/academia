import { describe, expect, test } from "vitest";
import {
  ADD_INPUTS, AsanHeap, asmOf, BUGS, catchers, CHECK_FORMS, chunkSize, fermatSearch, fillWrites, floatBits, FRAME_NEIGHBOUR,
  frameRead, GOLDEN, hwasanMissProbability, machineReport, MODES, mayHoist, OPS, OPT_CASES, outcome, PAGE0_VALUE, planAlloc,
  runAllocFill, runCheck, runScale, runTbaa, sameOutcome, SHADOW_OFFSET, shadowAddr, skipShadow, TOOLS, verdict, addOverflows,
} from "../../src/sims/sys/ub";

const has = (k: keyof typeof GOLDEN, re: RegExp) => asmOf(k).some((l) => re.test(l));

describe("golden compiler output (Apple clang 21, -O2, x86-64 Linux)", () => {
  test("the null check after the dereference is gone, and stays with -fno-delete-null-pointer-checks", () => {
    expect(asmOf("null.O2").slice(1)).toEqual(["  mov      eax, dword ptr [rdi]", "  ret"]);
    expect(has("null.O2", /test|cmp|je|jne/)).toBe(false);
    expect(has("null.O2.nodelete", /test\s+rdi, rdi/)).toBe(true);
  });
  test("x + 1 > x folds to 1; -fwrapv and unsigned compare with the maximum", () => {
    expect(asmOf("gt.O2").slice(1)).toEqual(["  mov      eax, 1", "  ret"]);
    expect(has("gt.O2.fwrapv", /cmp\s+edi, 2147483647/)).toBe(true);
    expect(has("gtu.O2", /cmp\s+edi, -1/)).toBe(true);
  });
  test("C++ removes the side-effect-free search loop; C keeps it; a trivial while(1) stays", () => {
    expect(asmOf("fermat.cpp17").slice(1)).toEqual(["  mov      eax, 1", "  ret"]);
    expect(has("fermat.c11", /jne\s+\.LBB0_1/)).toBe(true);
    expect(has("spin.cpp17", /jmp\s+\.LBB1_1/)).toBe(true);
    expect(asmOf("spin_n.cpp17").slice(1)).toEqual(["  ret"]);
  });
  test("strict aliasing: the int is not reloaded after a float store, unless -fno-strict-aliasing", () => {
    expect(has("tbaa.O2", /mov\s+eax, 1$/)).toBe(true);
    expect(has("tbaa.O2", /mov\s+eax, dword ptr/)).toBe(false);
    expect(has("tbaa.O2.nostrict", /mov\s+eax, dword ptr \[rdi\]/)).toBe(true);
    expect(has("tbaa.O2", /1073741824/)).toBe(true); // the bits of 2.0f
    expect(floatBits(2)).toBe(1073741824);
    expect(has("same.O2", /mov\s+eax, dword ptr \[rdi\]/)).toBe(true);
    expect(has("restrict.O2", /mov\s+eax, 1$/)).toBe(true);
  });
  test("restrict and TBAA hoist the load of *k out of the loop", () => {
    const inLoop = (k: keyof typeof GOLDEN) => {
      const a = asmOf(k);
      const start = a.findIndex((l) => /^\.LBB\d_2:/.test(l));
      return a.slice(start).some((l) => /\[rsi\]/.test(l));
    };
    expect(inLoop("scale.O2")).toBe(true);
    expect(inLoop("scale_r.O2")).toBe(false);
    expect(inLoop("scale_f.O2")).toBe(false);
    expect(inLoop("scale_f.O2.nostrict")).toBe(true);
  });
  test("int i + k becomes one memset; unsigned keeps a loop with a 32-bit index", () => {
    expect(has("fill.O2", /memset/)).toBe(true);
    expect(has("fillu.O2", /memset/)).toBe(false);
    expect(has("fillu.O2", /mov\s+ecx, edx/)).toBe(true);
  });
  test("overflow checks: after-the-fact check deleted; the others stay", () => {
    expect(asmOf("add_bad.O2").slice(1)).toEqual(["  lea      eax, [rdi + rsi]", "  ret"]);
    expect(has("add_bad.O2.fwrapv", /cmp/)).toBe(true);
    expect(has("add_builtin.O2", /cmovno/)).toBe(true);
    expect(has("add_pre.O2", /cmp/)).toBe(true);
    expect(has("add_unsigned.O2", /cmp/)).toBe(true);
    expect(CHECK_FORMS.filter((f) => !f.kept).map((f) => f.id)).toEqual(["after"]);
    expect(has("alloc_array.O2", /imul\s+edi, esi/)).toBe(true);
    expect(has("alloc_array_ok.O2", /jno/)).toBe(true);
  });
  test("every punning method compiles to one movd", () => {
    for (const k of ["bits_memcpy.O2", "bits_union.O2", "bits_cast.O2"] as const) expect(asmOf(k).slice(1)).toEqual(["  movd     eax, xmm0", "  ret"]);
  });
});

describe("optimizer model: the as-if rule", () => {
  test("every build agrees on every input without UB", () => {
    for (const c of OPT_CASES)
      for (const inp of c.inputs) {
        if (c.ub(inp.id)) continue;
        const outs = c.builds.map((b) => c.run(inp.id, b.id));
        for (const o of outs) expect(sameOutcome(o, outs[0]!), `${c.id} ${inp.id}`).toBe(true);
      }
  });
  test("builds differ on the UB inputs that the lessons quote", () => {
    const n = OPT_CASES.find((c) => c.id === "null")!;
    expect(n.run("mapped", "O0")).toEqual({ kind: "value", value: -1 });
    expect(n.run("mapped", "O2")).toEqual({ kind: "value", value: PAGE0_VALUE });
    expect(n.run("null", "nodel")).toEqual({ kind: "value", value: -1 });
    const g = OPT_CASES.find((c) => c.id === "gt")!;
    expect(g.run("2147483647", "O0")).toEqual({ kind: "value", value: 0 });
    expect(g.run("2147483647", "O2")).toEqual({ kind: "value", value: 1 });
    expect(g.run("2147483647", "wrapv")).toEqual({ kind: "value", value: 0 });
    const f = OPT_CASES.find((c) => c.id === "fermat")!;
    expect(f.run("none", "cpp")).toEqual({ kind: "value", value: 1 });
    expect(f.run("none", "c").kind).toBe("hang");
  });
  test("no a³ = b³ + c³ in a small range, and the cubes up to 1000 fit in an int", () => {
    expect(fermatSearch(60)).toBe(0);
    expect(2 * 1000 ** 3).toBeLessThan(2 ** 31);
  });
  test("overflow-check forms", () => {
    for (const [a, b] of ADD_INPUTS) {
      for (const f of ["before", "builtin", "unsigned"] as const) if (b > 0) expect(runCheck(f, a, b)).toBe(addOverflows(a, b) ? -1 : a + b);
      if (!addOverflows(a, b)) expect(runCheck("after", a, b)).toBe(a + b);
    }
    expect(runCheck("after", 2147483647, 1)).toBe(-2147483648);
    expect(runCheck("after", 2147483647, 1, true)).toBe(-1);
  });
});

describe("contracts", () => {
  test("every op and mode has an outcome; defined inputs agree", () => {
    for (const op of OPS) for (const m of MODES) for (let v = op.input?.min ?? 0; v <= (op.input?.max ?? 0); v++) expect(outcome(op.id, m.id, v).text.length).toBeGreaterThan(0);
    expect(outcome("add", "go", 0).text).toContain("-2147483648");
    expect(outcome("shift", "rrel", 32).text).toContain(": 1");
    expect(outcome("shift", "go", 33).text).toContain("0");
  });
  test("a[4] reads the next local in the model frame", () => {
    expect(frameRead(4)).toBe(FRAME_NEIGHBOUR);
    expect(outcome("index", "c0", 4).text).toContain(String(FRAME_NEIGHBOUR));
  });
});

describe("aliasing", () => {
  test("scale: restrict hoisting changes the result only when k points into a", () => {
    expect(runScale(-1, false).final).toEqual(runScale(-1, true).final);
    expect(runScale(1, false).final).toEqual([2, 4, 12, 16]); // the real -O0 and plain -O2 output
    expect(runScale(1, true).final).toEqual([2, 4, 6, 8]); // the real restrict -O2 output
    expect(runScale(3, false).final).toEqual(runScale(3, true).final); // UB that does not show
    expect(runScale(-1, false).final).toEqual([3, 6, 9, 12]);
    expect(runScale(0, false).final).toEqual([1, 2, 3, 4]);
    expect(runScale(0, true).final).toEqual([1, 2, 3, 4]);
    expect(mayHoist(true).ok && !mayHoist(false).ok).toBe(true);
  });
  test("tbaa: memory holds 2.0f; -O2 returns 1", () => {
    const r = runTbaa();
    expect(r.memory).toBe(1073741824);
    expect(r.returns).toEqual({ O0: 1073741824, O2: 1, nostrict: 1073741824 });
    expect(r.steps[1]!.bytes).toEqual([1, 0, 0, 0]);
    expect(r.steps[2]!.bytes).toEqual([0, 0, 0, 0x40]);
    expect(floatBits(1)).toBe(0x3f800000);
  });
});

describe("integer overflow", () => {
  test("loop widening: int writes one contiguous run; unsigned may wrap to index 0", () => {
    const s = fillWrites(4, 2147483646, true);
    expect(s.ub).toBe(true);
    expect(s.optimized).toEqual([{ from: 2147483646, to: 2147483650 }]);
    expect(s.written).toEqual([{ from: 2147483646, to: 2147483648 }, { from: -2147483648, to: -2147483646 }]);
    const u = fillWrites(4, 4294967294, false);
    expect(u.written).toEqual([{ from: 4294967294, to: 4294967296 }, { from: 0, to: 2 }]);
    expect(u.optimized).toEqual(u.written);
    expect(fillWrites(4, 10, true).ub).toBe(false);
  });
  test("malloc(n * size) with a 32-bit product", () => {
    const n = 2 ** 28 + 1;
    expect(planAlloc(n, 16, "u32")).toEqual({ exact: 2 ** 32 + 16, requested: 16, wrapped: true });
    expect(planAlloc(n, 16, "checked").requested).toBe(null);
    const r = runAllocFill(n, 16, "u32");
    expect(r.cap).toBe(16);
    expect(r.ub?.kind).toBe("heap-buffer-overflow");
    expect(r.neighbour).toBe("4141414141414141");
    expect(runAllocFill(4, 16, "u32").ub).toBe(null);
    expect(planAlloc(2 ** 28, 16, "u32").requested).toBe(0);
    // the second element (bytes 16..31) is the first write past the 16-byte block
    const blk = r.snap.heap.find((b) => b.label === "malloc(16)")!;
    expect(r.ub!.addr).toBe(blk.addr + 16);
  });
});

describe("ASan model", () => {
  test("shadow address formula and the x86-64 Linux offset", () => {
    expect(SHADOW_OFFSET).toBe(0x7fff8000);
    expect(shadowAddr(0x602000000010)).toBe(0x602000000010 / 8 + 0x7fff8000);
  });
  test("40-byte blocks: 64-byte chunks, shadow fa fa 00 00 00 00 00 fa, like the real run", () => {
    const h = new AsanHeap();
    const a = h.malloc(40, "a");
    expect(chunkSize(40)).toBe(64);
    expect(h.granules(a.start, 8).map((g) => g.shadow)).toEqual([0xfa, 0xfa, 0, 0, 0, 0, 0, 0xfa]);
    expect(h.access(a.user + 40, 4).report?.where).toMatch(/0 bytes after 40-byte region/);
    expect(h.access(a.user + 36, 4).report).toBe(null);
    const b = h.malloc(36, "b");
    expect(h.granules(b.user, 5).map((g) => g.shadow)).toEqual([0, 0, 0, 0, 4]);
    expect(h.access(b.user + 35, 1).report).toBe(null);
    expect(h.access(b.user + 36, 1).report?.kind).toBe("heap-buffer-overflow");
  });
  test("free poisons with fd; quarantine eviction hides a use after free", () => {
    const h = new AsanHeap(64);
    const a = h.malloc(40, "a");
    h.free(a.user);
    expect(h.granules(a.start, 8).map((g) => g.shadow)).toEqual([0xfa, 0xfa, 0xfd, 0xfd, 0xfd, 0xfd, 0xfd, 0xfa]);
    expect(h.access(a.user + 12, 4).report?.kind).toBe("heap-use-after-free");
    expect(h.free(a.user)?.kind).toBe("double-free");
    const b = h.malloc(40, "b");
    h.free(b.user); // a is evicted: 128 bytes > 64
    const c = h.malloc(40, "c"); // reuses a's chunk
    expect(c.user).toBe(a.user);
    expect(h.access(a.user + 12, 4).report).toBe(null);
  });
  test("the skip bug: ASan sees a 00 shadow byte; the provenance machine reports it", () => {
    expect(skipShadow()).toEqual({ distance: 64, shadow: 0 });
    expect(machineReport("skip")?.kind).toBe("heap-buffer-overflow");
    expect(verdict("skip", "asan")[0]).toBe("no");
    expect(hwasanMissProbability()).toBe(1 / 256);
  });
  test("each memory bug gets the expected machine report", () => {
    expect(machineReport("overflow")?.kind).toBe("heap-buffer-overflow");
    expect(machineReport("uaf")?.kind).toBe("heap-use-after-free");
    expect(machineReport("uninit")?.kind).toBe("use-of-uninitialized-value");
    expect(machineReport("leak")?.kind).toBe("memory-leak");
    expect(machineReport("misaligned")?.kind).toBe("misaligned-access");
    for (const b of BUGS) expect(catchers(b.id)).toBeGreaterThan(0);
    expect(TOOLS.length).toBe(8);
  });
});
