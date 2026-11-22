/** Tests for src/sims/sys/ownership: the toy borrow checker against rustc 1.96.1, elision, and the memory scripts. */
import { describe, expect, test } from "vitest";
import {
  ALL_PROGRAMS, BORROWS, DROPS, ELISION_EXAMPLES, LIFETIMES, OWNERSHIP, check, elide, errorTriples, parseSig,
  moveCompare, rcCycle, refCellStep, stringAssign, unwindMemory, vectorInvalidation, type CellState,
} from "../../src/sims/sys/ownership";

const byId = (id: string) => ALL_PROGRAMS.find((p) => p.id === id)!;

describe("toy borrow checker agrees with rustc 1.96.1", () => {
  for (const p of ALL_PROGRAMS) {
    test(`${p.id}: ${p.title}`, () => {
      const r = check(p.src);
      expect(r.parseError).toBeUndefined();
      expect(errorTriples(r)).toEqual(p.rustc.errors);
      // stdout is known only when the program calls no signature-only function
      if (r.ok && p.rustc.stdout && !/^fn /m.test(p.src)) expect(r.stdout).toEqual(p.rustc.stdout);
    });
  }
  test("the sets used by the lessons", () => {
    expect(OWNERSHIP.length + DROPS.length + BORROWS.length + LIFETIMES.length).toBe(ALL_PROGRAMS.length);
    expect(ALL_PROGRAMS.length).toBe(31);
  });
});

describe("more programs, checked with rustc 1.96.1", () => {
  const cases: [string, [string, number][]][] = [
    // two uses after one move: rustc reports the first only; a second move is a new move site
    ['let s = String::from("a");\nlet t = s;\nprintln!("{}", s);\nprintln!("{}", s);', [["E0382", 3]]],
    ['let s = String::from("a");\nlet t = s;\nlet u = s;\nlet w = s;', [["E0382", 3], ["E0382", 4]]],
    ["let x;\nprintln!(\"{}\", x);", [["E0282", 1]]],
    ["let x = 5;\nx = 6;", [["E0384", 2]]],
    ["let mut x = 5;\nlet m = &mut x;\nx += 1;\n*m += 1;", [["E0503", 3]]],
    ["let mut v = vec![1, 2];\nlet a = &v;\nlet b = &mut v;\nprintln!(\"{}\", a.len());\nb.push(3);", [["E0502", 3]]],
    ['let s = String::from("hi");\nlet r = &s;\nlet r2 = r;\ndrop(s);\nprintln!("{}", r2);', [["E0505", 4]]],
    ["let mut v = vec![1, 2, 3];\nlet f = v.first();\nv.clear();\nprintln!(\"{:?}\", f);", [["E0502", 3]]],
    ['let r;\n{\n    let s = String::from("x");\n    r = s.as_str();\n}\nprintln!("{}", r);', [["E0597", 4]]],
    ["let mut v = vec![1];\nlet m = &mut v;\nm.push(v.len());", [["E0502", 3]]],
    ["let mut r = &5;\n{\n    let x = 6;\n    r = &x;\n    println!(\"{}\", r);\n}", []],
    ["fn first<'a, 'b>(x: &'a str, y: &'b str) -> &'a str;\nlet a = String::from(\"abc\");\nlet b = String::from(\"x\");\nlet r = first(&a, &b);\ndrop(a);\nprintln!(\"{}\", r);", [["E0505", 5]]],
    ["fn first<'a, 'b>(x: &'a str, y: &'b str) -> &'a str;\nlet a = String::from(\"abc\");\nlet b = String::from(\"x\");\nlet r = first(&a, &b);\ndrop(b);\nprintln!(\"{}\", r);", []],
    ["fn get(v: &mut Vec<i32>) -> &mut Vec<i32>;\nlet mut v = vec![1];\nlet m = get(&mut v);\nprintln!(\"{}\", v.len());\nm.push(2);", [["E0502", 4]]],
    ["fn bad<'a>(x: &'a str) -> &'b str;", [["E0261", 1]]],
    ["fn pick(x: &str, y: &str) -> &str;\nfn ok(x: &str) -> &str;", [["E0106", 1]]],
    ['let s = String::from("hi");\nlet r = &mut s;', [["E0596", 2]]],
    ['let mut s = String::from("hi");\nlet r = &s;\nr.push_str("x");', [["E0596", 3]]],
    ["let mut x = 5;\nlet r = &x;\n*r = 6;", [["E0594", 3]]],
  ];
  cases.forEach(([src, want], i) => test(`case ${i}`, () => {
    expect(check(src).errors.map((e) => [e.code, e.line])).toEqual(want);
  }));
  test("drop output of programs that rustc ran", () => {
    expect(check('let a = Noisy("a");\nlet v = vec![a];\ndrop(v);\nprintln!("after");').stdout).toEqual(["drop a", "after"]);
    expect(check('let mut a = Noisy("a1");\nlet b = a;\na = Noisy("a2");\nprintln!("end");').stdout).toEqual(["end", "drop a1", "drop a2"]);
    expect(check('let mut v = vec![Noisy("x"), Noisy("y")];\nv.pop();\nprintln!("popped");').stdout).toEqual(["drop y", "popped", "drop x"]);
    expect(check('Noisy("stmt");\nprintln!("after");').stdout).toEqual(["drop stmt", "after"]);
  });
});

describe("rustc-style labels", () => {
  test("E0596 and E0594 through a & reference use rustc 1.96's label text", () => {
    expect(check('let mut s = String::from("hi");\nlet r = &s;\nr.push_str("x");').errors[0]!.labels[0]!.text).toBe("`r` is a `&` reference, so it cannot be borrowed as mutable");
    expect(check("let mut x = 5;\nlet r = &x;\n*r = 6;").errors[0]!.labels[0]!.text).toBe("`r` is a `&` reference, so it cannot be written to");
  });
  test("E0502 has the three labels that rustc prints", () => {
    const e = check(byId("push").src).errors[0]!;
    expect(e.labels.map((l) => [l.line, l.text])).toEqual([[2, "immutable borrow occurs here"], [3, "mutable borrow occurs here"], [4, "immutable borrow later used here"]]);
  });
  test("E0597 names the declaration, the borrow, the drop and the later use", () => {
    const e = check(byId("longestbad").src).errors[0]!;
    expect(e.labels.map((l) => l.line)).toEqual([5, 6, 7, 8]);
    expect(e.labels[2]!.text).toBe("`s2` dropped here while still borrowed");
  });
});

describe("NLL against the lexical model", () => {
  test("the RFC 2094 example compiles with NLL and fails with lexical scopes", () => {
    expect(check(byId("nll").src).ok).toBe(true);
    const lex = check(byId("nll").src, { lexical: true });
    expect(errorTriples(lex)).toEqual([["E0502", 4, "cannot borrow `v` as mutable because it is also borrowed as immutable"]]);
  });
  test("loan bars: the loan of v in 'nll' ends at line 3 with NLL", () => {
    const r = check(byId("nll").src);
    expect(r.loans.map((l) => [l.place, l.line, l.until])).toEqual([["v", 2, 3], ["v", 4, 4]]);
  });
  test("two-phase: reserve, then read, then activate", () => {
    const ops = check(byId("twophase").src).actions.filter((a) => a.line === 2).map((a) => a.op);
    expect(ops).toEqual(["reserve", "read", "activate", "use"]);
  });
});

describe("lifetime elision", () => {
  for (const e of ELISION_EXAMPLES) {
    test(e.src, () => {
      const r = elide(parseSig(e.src));
      expect(r.ok).toBe(e.rustc.ok);
      if (r.ok && e.rustc.ok) expect(r.text).toBe(e.rustc.text);
      if (!r.ok && !e.rustc.ok) { expect(r.code).toBe(e.rustc.code); expect(r.message).toBe(e.rustc.message); }
    });
  }
  test("rule numbers", () => {
    expect(elide(parseSig("fn f(s: &str) -> &str")).steps.map((s) => s.rule)).toEqual([1, 2]);
    expect(elide(parseSig("fn get(&self, key: &str) -> &str")).steps.map((s) => s.rule)).toEqual([1, 3]);
  });
});

describe("memory scripts", () => {
  test("move: one block, one free, no UB", () => {
    const s = stringAssign("rust");
    expect(s.flatMap((x) => x.ub)).toEqual([]);
    expect(s[s.length - 1]!.snap.heap.filter((b) => b.state === "freed")).toHaveLength(1);
  });
  test("the strings are 40 bytes: more than libc++'s 22-byte inline buffer, so the C++ copy uses the heap", () => {
    expect(stringAssign("copy")[2]!.snap.heap.map((b) => b.size)).toEqual([40]);
  });
  test("deep copy: two blocks, two frees", () => {
    const s = stringAssign("copy");
    expect(s.flatMap((x) => x.ub)).toEqual([]);
    expect(s[3]!.snap.heap.filter((b) => b.state === "live")).toHaveLength(2);
  });
  test("shallow copy: a double free on line 6", () => {
    const ub = stringAssign("shallow").flatMap((x) => x.ub.map((u) => [x.line, u.kind]));
    expect(ub).toEqual([[6, "double-free"]]);
  });
  test("vector: use after free without reserve, clean with it", () => {
    expect(vectorInvalidation(false).flatMap((x) => x.ub.map((u) => [x.line, u.kind]))).toEqual([[5, "heap-use-after-free"]]);
    expect(vectorInvalidation(true).flatMap((x) => x.ub)).toEqual([]);
  });
  test("C++ and Rust moves: no UB, one free each", () => {
    for (const l of ["cpp", "rust"] as const) {
      const s = moveCompare(l);
      expect(s.flatMap((x) => x.ub)).toEqual([]);
      expect(s[s.length - 1]!.snap.heap.filter((b) => b.state === "freed")).toHaveLength(1);
    }
  });
  test("unwinding: manual cleanup leaks the buffer (the FILE stays reachable from glibc's stream list); RAII leaks none", () => {
    const leaks = (st: "manual" | "raii", at: "none" | "new" | "fill" | "write") => unwindMemory(st, at).flatMap((x) => x.ub).filter((u) => u.kind === "memory-leak").length;
    expect(leaks("manual", "fill")).toBe(1);
    expect(leaks("manual", "write")).toBe(1);
    expect(leaks("manual", "new")).toBe(0);
    expect(leaks("manual", "none")).toBe(0);
    for (const at of ["none", "new", "fill", "write"] as const) expect(leaks("raii", at)).toBe(0);
  });
});

describe("Rc cycles and RefCell", () => {
  const last = (ab: "none" | "strong" | "weak", ba: "none" | "strong" | "weak") => rcCycle(ab, ba)[rcCycle(ab, ba).length - 1]!;
  test("a strong cycle: counts 2 and 2, then 1 and 1, no drop runs, two leaks (rustc run: nothing printed)", () => {
    const s = rcCycle("strong", "strong");
    expect([s[4]!.a.strong, s[4]!.b.strong]).toEqual([2, 2]);
    const end = s[s.length - 1]!;
    expect([end.a.strong, end.b.strong]).toEqual([1, 1]);
    expect(end.printed).toEqual([]);
    expect(end.ub.filter((u) => u.kind === "memory-leak")).toHaveLength(2);
  });
  test("a weak back edge: the counts that Rc::strong_count and Rc::weak_count print, then both drop", () => {
    const s = rcCycle("strong", "weak");
    expect([s[4]!.a.strong, s[4]!.a.weak, s[4]!.b.strong, s[4]!.b.weak]).toEqual([1, 1, 2, 0]);
    // after drop(a): a's value is gone, its block stays for b's Weak
    expect(s[5]!.a).toEqual({ strong: 0, weak: 1, value: "dropped", freed: false });
    const end = last("strong", "weak");
    expect(end.printed).toEqual(["drop a", "drop b"]);
    expect(end.ub).toEqual([]);
    expect(end.a.freed && end.b.freed).toBe(true);
  });
  test("RefCell flag and panics", () => {
    let s: CellState = { flag: 0, guards: [] };
    s = refCellStep(s, "borrow");
    s = refCellStep(s, "borrow");
    expect(s.flag).toBe(2);
    expect(refCellStep(s, "borrow_mut").panic).toBe("RefCell already borrowed");
    s = refCellStep(refCellStep(s, "drop"), "drop");
    s = refCellStep(s, "borrow_mut");
    expect(s.flag).toBe(-1);
    expect(refCellStep(s, "borrow").panic).toBe("RefCell already mutably borrowed");
  });
});
