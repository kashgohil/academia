import { describe, expect, test } from "vitest";
import { assemble, BRANCHY_THRESHOLD, BRANCHY_VALUES, Hart, PROGRAMS, programById } from "../../src/sims/arch/rv";

describe("sample programs", () => {
  test("there are 6 to 10 with unique ids", () => {
    expect(PROGRAMS.length).toBeGreaterThanOrEqual(6);
    expect(PROGRAMS.length).toBeLessThanOrEqual(10);
    expect(new Set(PROGRAMS.map((p) => p.id)).size).toBe(PROGRAMS.length);
  });

  test.each(PROGRAMS.map((p) => [p.id, p] as const))("%s runs to its expected result", (_, p) => {
    const a = assemble(p.source);
    expect(a.errors).toEqual([]);
    expect(p.source.trim().split("\n").length).toBeLessThanOrEqual(42);
    const h = new Hart(a.program);
    expect(h.run({ maxSteps: 1_000_000 })).toBe("exited");
    expect(h.error).toBeNull();
    expect(h.exitCode).toBe(p.expect.exit);
    expect(h.output).toBe(p.expect.output ?? "");
    const m = p.expect.mem;
    if (m) {
      const at = a.program.labels[m.label]!;
      if (m.words) expect(m.words.map((_, i) => h.peek(at + 4 * i, 4, true))).toEqual(m.words);
      if (m.bytes) expect(m.bytes.map((_, i) => h.peek(at + i, 1))).toEqual(m.bytes);
    }
    expect(h.regs[2]).toBe(65536); // every program leaves sp where it found it
  });

  test("the expected values, pinned", () => {
    const exit = Object.fromEntries(PROGRAMS.map((p) => [p.id, p.expect.exit]));
    expect(exit).toEqual({ sum: 31, fib: 6765, fact: 3628800, strlen: 13, memcpy: 0, dot: 120, bubble: 0, list: 396, branchy: 17, hello: 0 });
    expect(BRANCHY_VALUES).toHaveLength(32);
    expect(BRANCHY_VALUES.every((v) => Number.isInteger(v) && v >= 0 && v < 100)).toBe(true);
    expect(BRANCHY_VALUES.filter((v) => v > BRANCHY_THRESHOLD).length).toBe(17);
  });

  test("fact uses a real stack frame: 10 nested frames of 16 bytes", () => {
    const h = new Hart(assemble(programById("fact").source).program);
    let minSp = Infinity;
    while (h.step()) minSp = Math.min(minSp, h.regs[2]!);
    expect(65536 - minSp).toBe(160);
  });

  test("dynamic instruction counts (pinned for demos)", () => {
    const n = Object.fromEntries(PROGRAMS.map((p) => {
      const h = new Hart(assemble(p.source).program);
      h.run();
      return [p.id, h.instret];
    }));
    // sum: la (2) + 2 li, 8 iterations of 5, exit (2) = 46. hello: li, la (2), li, li, ecall, li, li, ecall = 9.
    expect(n).toEqual({ sum: 46, fib: 127, fact: 151, strlen: 60, memcpy: 114, dot: 72, bubble: 240, list: 37, branchy: 184, hello: 9 });
  });
});
