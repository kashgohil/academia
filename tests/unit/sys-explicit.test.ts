/** Tests for src/sims/sys/explicit: the models match Zig 0.17.1, and every number the lessons quote is pinned. */
import { describe, expect, test } from "vitest";
import {
  arenaChildTrace, arenaCost, BAD_EMAIL, breakEven, CALL_GRAPH, checkAll, compactTrace, growCapacity, loopFds, mallocCost, PAGE_BYTES, PARTS_BYTES, ripple,
  runContext, runDefer, runLoad, runScratch, runWork, TAGS_BYTES, TEMP_BLOCK,
} from "../../src/sims/sys/explicit";

/**
 * Traces printed by a logging wrapper around the real allocators (zig 0.17.1, aarch64-macos: page size 16 KiB,
 * cache_line 128). Each is [allocator, n, two lists, trace]; "c" marks calls of the arena's child allocator.
 */
const GOLDEN: [string, number, boolean, string][] = [
  ["fba", 1, false, "a136 a100 f100 f136 "],
  ["arena", 1, false, "ca276 a136 a100 f100 f136 cf276 "],
  ["fba", 1, true, "a136 a136 a100 f100 f136 f136 "],
  ["arena", 1, true, "ca276 a136 cr276>432 a136 cr432>632 a100 f100 f136 f136 cf632 "],
  ["fba", 17, false, "a136 a100 f100 f136 "],
  ["arena", 17, false, "ca276 a136 a100 f100 f136 cf276 "],
  ["fba", 17, true, "a136 a136 a100 f100 f136 f136 "],
  ["arena", 17, true, "ca276 a136 cr276>432 a136 cr432>632 a100 f100 f136 f136 cf632 "],
  ["fba", 18, false, "a136 m136>344 a100 f100 f344 "],
  ["arena", 18, false, "ca276 a136 m136>344! cr276>848 a344 f136 cr848>1048 a100 f100 f344 cf1048 "],
  ["fba", 18, true, "a136 a136 m136>344! a344 f136 m136>344! a344 f136 a100 f100 f344 f344 "],
  ["arena", 18, true, "ca276 a136 cr276>432 a136 m136>344! cr432>1120 a344 f136 m136>344! cr1120>1808 a344 f136 cr1808>2008 a100 f100 f344 f344 cf2008 "],
  ["fba", 40, false, "a136 m136>344 a100 f100 f344 "],
  ["arena", 40, false, "ca276 a136 m136>344! cr276>848 a344 f136 cr848>1048 a100 f100 f344 cf1048 "],
  ["fba", 40, true, "a136 a136 m136>344! a344 f136 m136>344! a344 f136 a100 f100 f344 f344 "],
  ["arena", 40, true, "ca276 a136 cr276>432 a136 m136>344! cr432>1120 a344 f136 m136>344! cr1120>1808 a344 f136 cr1808>2008 a100 f100 f344 f344 cf2008 "],
  ["fba", 100, false, "a136 m136>344 m344>656 m656>1120 a100 f100 f1120 "],
  ["arena", 100, false, "ca276 a136 m136>344! cr276>848 a344 f136 m344>656! cr848>2160 a656 f344 m656>1120! cr2160>4400 a1120 f656 cr4400>4600 a100 f100 f1120 cf4600 "],
  ["fba", 100, true, "a136 a136 m136>344! a344 f136 m136>344! a344 f136 m344>656! a656 f344 m344>656! a656 f344 m656>1120! a1120 f656 m656>1120! a1120! f656 f1120 OOM"],
  ["arena", 100, true, "ca276 a136 cr276>432 a136 m136>344! cr432>1120 a344 f136 m136>344! cr1120>1808 a344 f136 m344>656! cr1808>3120 a656 f344 m344>656! cr3120>4432 a656 f344 m656>1120! cr4432>6672 a1120 f656 m656>1120! cr6672>8912 a1120 f656 cr8912>9112 a100 f100 f1120 f1120 cf9112 "],
  ["fba", 200, false, "a136 m136>344 m344>656 m656>1120 m1120>1816 a100 f100 f1816 "],
  ["arena", 200, false, "ca276 a136 m136>344! cr276>848 a344 f136 m344>656! cr848>2160 a656 f344 m656>1120! cr2160>4400 a1120 f656 m1120>1816! cr4400>8032 a1816 f1120 cr8032>8232 a100 f100 f1816 cf8232 "],
  ["fba", 200, true, "a136 a136 m136>344! a344 f136 m136>344! a344 f136 m344>656! a656 f344 m344>656! a656 f344 m656>1120! a1120 f656 m656>1120! a1120! f656 f1120 OOM"],
  ["arena", 200, true, "ca276 a136 cr276>432 a136 m136>344! cr432>1120 a344 f136 m136>344! cr1120>1808 a344 f136 m344>656! cr1808>3120 a656 f344 m344>656! cr3120>4432 a656 f344 m656>1120! cr4432>6672 a1120 f656 m656>1120! cr6672>8912 a1120 f656 m1120>1816! cr8912>12544 a1816 f1120 m1120>1816! cr12544>16176 a1816 f1120 cr16176>16376 a100 f100 f1816 f1816 cf16376 "],
  ["fba", 300, false, "a136 m136>344 m344>656 m656>1120 m1120>1816 m1816>2864 a100 f100 f2864 "],
  ["arena", 300, false, "ca276 a136 m136>344! cr276>848 a344 f136 m344>656! cr848>2160 a656 f344 m656>1120! cr2160>4400 a1120 f656 m1120>1816! cr4400>8032 a1816 f1120 m1816>2864! cr8032>13760 a2864 f1816 cr13760>13960 a100 f100 f2864 cf13960 "],
  ["fba", 300, true, "a136 a136 m136>344! a344 f136 m136>344! a344 f136 m344>656! a656 f344 m344>656! a656 f344 m656>1120! a1120 f656 m656>1120! a1120! f656 f1120 OOM"],
  ["arena", 300, true, "ca276 a136 cr276>432 a136 m136>344! cr432>1120 a344 f136 m136>344! cr1120>1808 a344 f136 m344>656! cr1808>3120 a656 f344 m344>656! cr3120>4432 a656 f344 m656>1120! cr4432>6672 a1120 f656 m656>1120! cr6672>8912 a1120 f656 m1120>1816! cr8912>12544 a1816 f1120 m1120>1816! cr12544>16176 a1816 f1120 m1816>2864! cr16176>21904! ca28596 a2864 f1816 m1816>2864! a2864 f1816 a100 f100 f2864 f2864 cf28596 cf16176 "],
];

describe("zig allocators match the real 0.17.1 traces", () => {
  test("growCapacity", () => {
    expect(growCapacity(1)).toBe(17);
    expect(growCapacity(18)).toBe(43);
  });
  for (const [alloc, n, two, trace] of GOLDEN) {
    test(`${alloc} n=${n} two=${two}`, () => {
      const tokens = trace.trim().split(" ").filter((t) => t !== "OOM");
      const outer = tokens.filter((t) => !t.startsWith("c")).join(" ");
      const run = runWork({ allocator: alloc as "fba" | "arena", n, two, forget: false, pageSize: 16384, fbaSize: 4096 });
      expect(compactTrace(run)).toBe(outer);
      expect(run.result === "error.OutOfMemory").toBe(trace.includes("OOM"));
      if (alloc === "arena") expect(arenaChildTrace({ n, two, forget: false, pageSize: 16384 })).toEqual(tokens.filter((t) => t.startsWith("c")));
    });
  }
});

describe("checkAllAllocationFailures matches zig 0.17.1 on loadUser", () => {
  // [a, b, c, swallow] -> the checker's output (zig test, 0.17.1)
  const LEAK1 = "fail_index: 1/3|allocated bytes: 3|freed bytes: 0|allocations: 1|deallocations: 0";
  const LEAK2 = "fail_index: 2/3|allocated bytes: 18|freed bytes: 3|allocations: 2|deallocations: 1";
  const SW = "error.SwallowedOutOfMemoryError";
  const TABLE: [number, string][] = [
    [0b0000, LEAK1], [0b0001, LEAK2], [0b0010, LEAK1], [0b0011, "pass"], [0b0100, LEAK1], [0b0101, LEAK2], [0b0110, LEAK1], [0b0111, "pass"],
    [0b1000, LEAK1], [0b1001, SW], [0b1010, LEAK1], [0b1011, SW], [0b1100, LEAK1], [0b1101, SW], [0b1110, LEAK1], [0b1111, SW],
  ];
  for (const [bits, want] of TABLE) {
    const flags = { a: !!(bits & 1), b: !!(bits & 2), c: !!(bits & 4), swallow: !!(bits & 8) };
    test(JSON.stringify(flags), () => {
      const r = checkAll(flags);
      expect(r.verdict === "pass" ? "pass" : r.message.join("|")).toBe(want);
    });
  }
  test("tags asks for 9 slices of 16 bytes at the first append", () => expect(TAGS_BYTES).toBe(144));
  test("the invalid email path leaks tags without errdefer c, and the checker never sees it", () => {
    const flags = { a: true, b: true, c: false, swallow: false };
    expect(checkAll(flags).verdict).toBe("pass");
    const r = runLoad(flags, null, BAD_EMAIL);
    expect(r.outcome).toBe("error.InvalidEmail");
    expect(r.leaked).toEqual(["tags"]);
    expect(runLoad({ ...flags, c: true }, null, BAD_EMAIL).leaked).toEqual([]);
  });
});

describe("lesson numbers: allocators as parameters in Zig", () => {
  test("page_allocator, one list of 40: 2 mmaps, 8 KiB mapped for 444 bytes", () => {
    const r = runWork({ allocator: "page", n: 40, two: false, forget: false });
    expect(r.counts.alloc).toBe(2);
    expect(r.steps.flatMap((s) => s.call.backing).filter((b) => b.startsWith("mmap")).length).toBe(2);
    expect(r.peakHeld).toBe(8192);
    expect(r.peakLive).toBe(444);
  });
  test("FixedBufferAllocator 4 KiB, two lists of 100: 6 null remaps, then OutOfMemory", () => {
    const r = runWork({ allocator: "fba", n: 100, two: true, forget: false, fbaSize: 4096 });
    expect(r.failedRemaps).toBe(6);
    expect(r.result).toBe("error.OutOfMemory");
    expect(r.peakDead).toBeGreaterThan(0);
  });
  test("a forgotten free: the arena frees its node, the testing allocator reports 100 bytes, page_allocator is silent", () => {
    const a = runWork({ allocator: "arena", n: 40, two: false, forget: true });
    expect(a.report).toEqual(["child.free 1048"]);
    expect(a.silentLeak).toBe(0);
    const t = runWork({ allocator: "testing", n: 40, two: false, forget: true });
    expect(t.report).toHaveLength(1);
    expect(t.report[0]).toContain("len: 100");
    const p = runWork({ allocator: "page", n: 40, two: false, forget: true });
    expect(p.report).toEqual([]);
    expect(p.silentLeak).toBe(100);
  });
  test("the default flags of the failure demo stop at fail index 2 of 3", () => {
    const r = checkAll({ a: true, b: false, c: false, swallow: false });
    expect(r.needed).toBe(3);
    expect(r.message).toEqual(["fail_index: 2/3", "allocated bytes: 18", "freed bytes: 3", "allocations: 2", "deallocations: 1"]);
  });
});

describe("lesson numbers: Odin's context allocator", () => {
  test("the temp block is 4 MiB; the model allocations are 64 and 9 bytes", () => {
    expect(TEMP_BLOCK).toBe(4 * 1024 * 1024);
    expect(PARTS_BYTES).toBe(64);
    expect(PAGE_BYTES).toBe(9);
  });
  test("with serve: temp, render uses serve's context and nothing reaches the heap but the arena block", () => {
    const steps = runContext("temp");
    const atRender = steps.find((s) => s.frames.some((f) => f.fn === "render"))!;
    expect(atRender.frames.find((f) => f.fn === "render")).toMatchObject({ uses: "serve", allocator: "temp" });
    const end = steps[steps.length - 1]!;
    expect(end.snap.heap.map((b) => b.label)).toEqual(["temp arena block"]);
    expect(end.report).toEqual([]);
  });
  test("with no override, page leaks 9 bytes; the tracking allocator lists it", () => {
    const none = runContext("none");
    expect(none[none.length - 1]!.report).toEqual(["Direct leak of 9 byte(s) in 1 object(s) allocated at line 18 (page)."]);
    const track = runContext("track");
    expect(track[track.length - 1]!.report.slice(0, 2)).toEqual(["=== 1 allocations not freed: ===", "- 9 bytes @ main.odin(18:12)"]);
    const both = runContext("both");
    expect(both[both.length - 1]!.report).toEqual(["Tracking_Allocator: no allocations left."]);
  });
  test("ripple: query changes 3 Zig signatures, all four leaves change 7, Odin and C change none", () => {
    expect([...ripple(new Set(["query"]), "zig").changed].sort()).toEqual(["handle", "query", "route"]);
    const leaves = new Set(CALL_GRAPH.filter((n) => n.leaf).map((n) => n.id));
    expect(ripple(leaves, "zig").changed.size).toBe(7);
    expect(ripple(leaves, "odin").changed.size).toBe(0);
    expect(ripple(leaves, "c").changed.size).toBe(0);
  });
});

describe("lesson numbers: temporary allocators", () => {
  test("one scratch arena: p reads RWRITEOG; two arenas: /tmp/LOG; poison: use-after-poison", () => {
    const one = runScratch({ arenas: 1, poison: false });
    expect(one.find((s) => s.line === 12)!.p!.text).toBe("RWRITEOG");
    const two = runScratch({ arenas: 2, poison: false });
    expect(two.find((s) => s.line === 12)!.p!.text).toBe("/tmp/LOG");
    const poison = runScratch({ arenas: 1, poison: true });
    expect(poison.find((s) => s.line === 12)!.report).toContain("use-after-poison");
    expect(runScratch({ arenas: 2, poison: true }).find((s) => s.line === 12)!.report).toBeUndefined();
  });
  test("cost model: 100 objects of 64 B, 10% survive", () => {
    const o = { n: 100, size: 64, survive: 0.1 };
    expect(mallocCost(o)).toBe(3500);
    expect(arenaCost(o)).toBeCloseTo(664, 6);
    expect((mallocCost(o) / arenaCost(o)).toFixed(1)).toBe("5.3");
    expect((breakEven(100, 64) * 100).toFixed(1)).toBe("78.5");
    expect(breakEven(100, 4096)).toBeLessThan(breakEven(100, 64));
    expect(breakEven(2, 64)).toBeLessThan(breakEven(100, 64));
  });
});

describe("lesson numbers: defer and errdefer", () => {
  test("Zig, validate fails: free(c), close(f), free(a), and nothing leaks", () => {
    const r = runDefer("zig", "check");
    expect(r.steps.find((s) => s.ran?.length)!.ran).toEqual(["gpa.free(c)", "f.close()", "gpa.free(a)"]);
    expect(r.leaked).toEqual([]);
    expect(r.ubKinds).toEqual([]);
  });
  test("Zig success runs only the defer", () => {
    const r = runDefer("zig", "none");
    expect(r.steps.find((s) => s.ran?.length)!.ran).toEqual(["f.close()"]);
    expect(r.ubKinds).toEqual([]);
  });
  test("the bugs: defer for c is a use after free and a double free; a wrong goto label leaks the FILE", () => {
    expect(runDefer("zig", "none", "zig-defer-c").ubKinds).toEqual(["heap-use-after-free", "double-free"]);
    expect(runDefer("goto", "c", "goto-wrong-label").leaked).toEqual(["FILE f"]);
    expect(runDefer("cleanup", "none", "cleanup-no-steal").ubKinds).toEqual(["heap-use-after-free", "double-free"]);
    for (const lang of ["zig", "goto", "cleanup"] as const) for (const f of ["none", "a", "f", "c", "check"] as const) {
      const r = runDefer(lang, f);
      expect(r.leaked, `${lang} ${f}`).toEqual([]);
      expect(r.ubKinds, `${lang} ${f}`).toEqual([]);
    }
  });
  test("Go defer in a loop: file 1022 fails at limit 1024, with 1021 deferred calls waiting", () => {
    const r = loopFds(2000, 1024, "go-loop");
    expect(r.failedAt).toBe(1022);
    expect(r.pendingAtPeak).toBe(1021);
    expect(r.peak).toBe(1024);
    expect(loopFds(2000, 1024, "zig-block").peak).toBe(4);
    expect(loopFds(2000, 1024, "go-func").peak).toBe(4);
    // Linux: Go's first os.Open adds the netpoller's epoll fd and eventfd
    expect(loopFds(2000, 1024, "go-loop", "linux").failedAt).toBe(1020);
    expect(loopFds(2000, 1024, "zig-block", "linux").peak).toBe(4);
    const big = loopFds(2000, 65536, "go-loop");
    expect(big.failedAt).toBeNull();
    expect(big.peak).toBe(2003);
  });
});
