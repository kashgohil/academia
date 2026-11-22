/** Tests for src/sims/sys/ownership/cpp.ts and the size table: every C++ number the lessons quote. */
import { describe, expect, test } from "vitest";
import { layoutC } from "../../src/sims/sys/mem";
import { ELISION, RULE5_CLANG, SIZES, STRING, UNWIND_CLANG, membersOf, specialMembers, unwind, vectorGrowth, VECTOR_CLANG } from "../../src/sims/sys/ownership";

describe("implicit special members", () => {
  test("all 32 combinations match clang++ 21 -std=c++20", () => {
    for (let mask = 0; mask < 32; mask++) {
      const s = specialMembers(membersOf(mask));
      const [mc, ma, cc, ca] = RULE5_CLANG[mask]!;
      expect([s.constructFromRvalue, s.assignFromRvalue, s.copyable, s.copyAssignable], `mask ${mask}`).toEqual([mc, ma, cc, ca]);
    }
  });
  test("a user destructor removes the implicit moves: rvalues copy", () => {
    const s = specialMembers(membersOf(1));
    expect(s.state.moveCtor).toBe("none");
    expect(s.state.copyCtor).toBe("deprecated");
    expect(s.constructFromRvalue).toBe("copy");
  });
  test("a user move constructor deletes the copies", () => {
    const s = specialMembers(membersOf(8));
    expect([s.state.copyCtor, s.state.copyAssign, s.state.moveAssign]).toEqual(["deleted", "deleted", "none"]);
  });
});

describe("vector growth (libc++)", () => {
  test("matches the counts of the real program", () => {
    for (const [key, want] of Object.entries(VECTOR_CLANG)) {
      const [n, nx, em, rs] = key.split(",").map(Number);
      const r = vectorGrowth(n!, { noexceptMove: nx === 1, emplace: em === 1, reserve: rs === 1 });
      expect([r.ctor, r.copy, r.move, r.dtor, r.capacity], key).toEqual(want);
    }
  });
  test("numbers the lesson quotes: 17 and 100 push_backs", () => {
    expect(vectorGrowth(17, { noexceptMove: false, emplace: false, reserve: false }).copy).toBe(31);
    const r = vectorGrowth(100, { noexceptMove: true, emplace: false, reserve: false });
    expect([r.reallocations, r.capacity, r.relocated]).toEqual([8, 128, 127]);
  });
  test("numbers the lesson quotes: 1000 push_backs", () => {
    const nx = vectorGrowth(1000, { noexceptMove: true, emplace: false, reserve: false });
    expect([nx.reallocations, nx.relocated, nx.move, nx.capacity]).toEqual([11, 1023, 2023, 1024]);
    const cp = vectorGrowth(1000, { noexceptMove: false, emplace: false, reserve: false });
    expect([cp.copy, cp.move]).toEqual([1023, 1000]);
    const rs = vectorGrowth(1000, { noexceptMove: false, emplace: true, reserve: true });
    expect([rs.copy, rs.move, rs.reallocations]).toEqual([0, 0, 0]);
  });
});

describe("copy elision", () => {
  test("six cases, as clang ran them", () => {
    expect(ELISION.map((e) => [e.id, e.clang, e.noElide])).toEqual([
      ["prvalue", [1, 0, 0, 1], [1, 0, 0, 1]], ["named", [1, 0, 0, 1], [1, 0, 1, 2]], ["stdmove", [1, 0, 1, 2], [1, 0, 1, 2]],
      ["either", [2, 0, 1, 3], [2, 0, 1, 3]], ["param", [1, 0, 1, 2], [1, 0, 1, 2]], ["ternary", [2, 1, 0, 3], [2, 1, 0, 3]],
    ]);
  });
});

describe("unwinding", () => {
  test("RAII releases in reverse order on the exception path", () => {
    const r = unwind("raii", "fill");
    expect(r.events.filter((e) => e.kind === "release").map((e) => e.text)).toEqual(["unwinding: ~ofstream closes the file", "unwinding: ~unique_ptr frees the buffer", "unwinding: ~lock_guard unlocks mu"]);
    expect(r.held).toEqual([]);
  });
  test("manual cleanup holds everything that was acquired before the throw", () => {
    expect(unwind("manual", "fill").held).toEqual(["lock", "buffer", "file"]);
    expect(unwind("manual", "new").held).toEqual(["lock"]);
    expect(unwind("manual", "none").held).toEqual([]);
  });
  test("the real order of destruction in a constructor that throws (16 lines)", () => {
    expect(UNWIND_CLANG).toHaveLength(16);
    expect(UNWIND_CLANG).not.toContain("~Bad body");
  });
});

describe("sizes", () => {
  test("a String or std::string header is three words: 24 bytes (size_of::<String>() and libc++ sizeof)", () => {
    expect(layoutC(STRING).size).toBe(24);
  });
  const row = (t: string) => SIZES.find((s) => s.type === t)!;
  test("handles", () => {
    expect(row("std::unique_ptr<Widget>").handle).toBe(8);
    expect(row("unique_ptr<Widget, void(*)(Widget*)>").handle).toBe(16);
    expect(row("std::shared_ptr<Widget> via make_shared").handle).toBe(16);
    expect(row("Box<Widget>").handle).toBe(8);
    expect(row("Box<dyn Shape>").handle).toBe(16);
    expect(row("Rc<Widget>").handle).toBe(8);
  });
  test("allocations for a 16-byte Widget", () => {
    expect(row("std::shared_ptr<Widget> via make_shared").allocs).toEqual([40]);
    expect(row("shared_ptr<Widget>(new Widget)").allocs).toEqual([16, 32]);
    expect(row("Rc<Widget>").allocs).toEqual([32]);
    expect(row("Rc<RefCell<Widget>>").allocs).toEqual([40]);
  });
});
