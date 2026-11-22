/**
 * Example programs in the toy Rust subset of borrowck.ts, used by the ownership lessons' demos and pinned by tests.
 *
 * Each program is valid Rust inside `fn main() { ... }` once a short prelude defines `Noisy` (a type whose Drop
 * prints "drop <name>") and `consume` (a function that takes ownership), and once each `fn ...;` signature gets a
 * body. `rustc` holds what rustc 1.96.1 really reported for that file: the error codes with their lines (toy line
 * numbers), the first line of each message, and, for programs that compile, the lines that the program printed.
 * tests/unit/sys-ownership.test.ts checks that the toy checker gives the same result for every program.
 *
 * The real files were made by mapping toy line n to Rust line n + 1 (the prelude and `fn main() {` are line 1).
 */

export interface RustcResult {
  /** [code, toy line, message] for each error, in rustc's order. Empty: the program compiles. */
  errors: [string, number, string][];
  /** stdout of the program, when it compiles. */
  stdout?: string[];
}

export interface Program {
  id: string;
  title: string;
  src: string;
  rustc: RustcResult;
}

const p = (id: string, title: string, lines: string[], rustc: RustcResult): Program => ({ id, title, src: lines.join("\n"), rustc });

// ---------------------------------------------------------------- ownership

export const OWNERSHIP: Program[] = [
  p("move", "Move a String, then use it", [
    'let s = String::from("hello");',
    "let t = s;            // the String moves to t",
    'println!("{}", s);    // s no longer owns it',
  ], { errors: [["E0382", 3, "borrow of moved value: `s`"]] }),
  p("copy", "Copy an integer", [
    "let x = 5;",
    "let y = x;            // i32 is Copy",
    'println!("{} {}", x, y);',
  ], { errors: [], stdout: ["5 5"] }),
  p("clone", "Clone a String", [
    'let s = String::from("hello");',
    "let t = s.clone();    // a second heap buffer",
    'println!("{} {}", s, t);',
  ], { errors: [], stdout: ["hello hello"] }),
  p("call", "Pass a String to a function", [
    'let s = String::from("hello");',
    "consume(s);           // moves into the callee",
    'println!("{}", s);',
  ], { errors: [["E0382", 3, "borrow of moved value: `s`"]] }),
  p("moveloop", "Move the same value twice", [
    'let s = String::from("hello");',
    "let a = s;",
    "let b = s;",
  ], { errors: [["E0382", 3, "use of moved value: `s`"]] }),
];

// ---------------------------------------------------------------- drop order

export const DROPS: Program[] = [
  p("scopes", "Scopes, a temporary and drop()", [
    'let a = Noisy("a");',
    'let b = Noisy("b");',
    "{",
    '    let c = Noisy("c");',
    '    println!("inner block ends");',
    "}",
    'let _ = Noisy("temp");   // no binding: dropped now',
    'let _d = Noisy("d");     // a binding: lives on',
    "drop(a);",
    'println!("main ends");',
  ], { errors: [], stdout: ["inner block ends", "drop c", "drop temp", "drop a", "main ends", "drop d", "drop b"] }),
  p("shadow", "Shadowing does not drop", [
    'let x = Noisy("first");',
    'let x = Noisy("second");   // shadows, does not drop',
    'println!("main ends");',
  ], { errors: [], stdout: ["main ends", "drop second", "drop first"] }),
  p("assign", "Assignment drops the old value", [
    'let mut s = Noisy("old");',
    's = Noisy("new");          // the old value drops here',
    'println!("main ends");',
  ], { errors: [], stdout: ["drop old", "main ends", "drop new"] }),
  p("forget", "mem::forget leaks without UB", [
    'let a = Noisy("a");',
    'let b = Noisy("b");',
    "std::mem::forget(a);      // never dropped",
    'println!("main ends");',
  ], { errors: [], stdout: ["main ends", "drop b"] }),
  p("vec", "A Vec and a Box own their contents", [
    'let v = vec![Noisy("v0"), Noisy("v1"), Noisy("v2")];',
    'let b = Box::new(Noisy("boxed"));',
    'println!("main ends");',
  ], { errors: [], stdout: ["main ends", "drop boxed", "drop v0", "drop v1", "drop v2"] }),
  p("underscore", "let _ = x does not move x", [
    'let a = Noisy("a");',
    "let _ = a;                // a place: nothing moves",
    'println!("main ends");',
  ], { errors: [], stdout: ["main ends", "drop a"] }),
  p("moved", "A moved value drops in its new owner", [
    'let a = Noisy("a");',
    'let b = Noisy("b");',
    "{",
    "    let inner = a;        // a moves into the block",
    '    println!("inner block ends");',
    "}",
    'println!("main ends");',
  ], { errors: [], stdout: ["inner block ends", "drop a", "main ends", "drop b"] }),
];

// ---------------------------------------------------------------- borrowing

export const BORROWS: Program[] = [
  p("nll", "A borrow ends at its last use (NLL)", [
    "let mut v = vec![1, 2, 3];",
    "let r = &v;",
    'println!("{}", r[0]);   // last use of r',
    "v.push(4);              // fine: r is dead",
  ], { errors: [], stdout: ["1"] }),
  p("push", "Push while a reference is live", [
    "let mut v = vec![1, 2, 3];",
    "let first = &v[0];",
    "v.push(4);              // may move the buffer",
    'println!("{}", first);',
  ], { errors: [["E0502", 3, "cannot borrow `v` as mutable because it is also borrowed as immutable"]] }),
  p("twomut", "Two mutable borrows", [
    "let mut s = String::new();",
    "let a = &mut s;",
    "let b = &mut s;",
    'a.push_str("x");',
    'b.push_str("y");',
  ], { errors: [["E0499", 3, "cannot borrow `s` as mutable more than once at a time"]] }),
  p("readmut", "Read while a mutable borrow is live", [
    "let mut v = vec![1, 2, 3];",
    "let m = &mut v;",
    'println!("{}", v.len());',
    "m.push(4);",
  ], { errors: [["E0502", 3, "cannot borrow `v` as immutable because it is also borrowed as mutable"]] }),
  p("twophase", "v.push(v.len()): two-phase borrow", [
    "let mut v = vec![1, 2, 3];",
    "v.push(v.len());        // reserve, read, then activate",
    'println!("{}", v.len());',
  ], { errors: [], stdout: ["4"] }),
  p("twophasebad", "The argument needs v mutably", [
    "let mut v = vec![1, 2, 3];",
    "let mut w = vec![0];",
    "let m = &mut v;",
    "w.push(m.len());",
    "v.push(m.len());        // m is used after the reservation",
  ], { errors: [["E0499", 5, "cannot borrow `v` as mutable more than once at a time"]] }),
  p("moveborrowed", "Move out while borrowed", [
    'let s = String::from("hi");',
    "let r = &s;",
    "drop(s);",
    'println!("{}", r);',
  ], { errors: [["E0505", 3, "cannot move out of `s` because it is borrowed"]] }),
  p("assignborrowed", "Assign while borrowed", [
    "let mut x = 5;",
    "let r = &x;",
    "x = 6;",
    'println!("{}", r);',
  ], { errors: [["E0506", 3, "cannot assign to `x` because it is borrowed"]] }),
  p("notmut", "Borrow mutably without mut", [
    "let v = vec![1, 2, 3];",
    "v.push(4);",
  ], { errors: [["E0596", 2, "cannot borrow `v` as mutable, as it is not declared as mutable"]] }),
  p("usemut", "Copy out while mutably borrowed", [
    "let mut x = 5;",
    "let m = &mut x;",
    "let y = x;",
    "*m += 1;",
  ], { errors: [["E0503", 3, "cannot use `x` because it was mutably borrowed"]] }),
  p("reborrow", "Mutate through a reference, then read", [
    "let mut v = vec![1, 2, 3];",
    "let m = &mut v;",
    "m.push(4);              // last use of m",
    'println!("{}", v.len());',
  ], { errors: [], stdout: ["4"] }),
  p("shared", "Many shared borrows", [
    'let s = String::from("hi");',
    "let a = &s;",
    "let b = &s;",
    'println!("{} {} {}", s, a, b);',
  ], { errors: [], stdout: ["hi hi hi"] }),
];

// ---------------------------------------------------------------- lifetimes

export const LIFETIMES: Program[] = [
  p("dangle", "A reference outlives its value", [
    "let r;",
    "{",
    "    let x = 5;",
    "    r = &x;",
    "}                       // x dies here",
    'println!("{}", r);',
  ], { errors: [["E0597", 4, "`x` does not live long enough"]] }),
  p("longestok", "longest: use inside the block", [
    "fn longest<'a>(x: &'a str, y: &'a str) -> &'a str;",
    'let s1 = String::from("long string");',
    "let result;",
    "{",
    '    let s2 = String::from("xyz");',
    "    result = longest(&s1, &s2);",
    '    println!("{}", result);',
    "}",
  ], { errors: [], stdout: ["long string"] }),
  p("longestbad", "longest: use after the block", [
    "fn longest<'a>(x: &'a str, y: &'a str) -> &'a str;",
    'let s1 = String::from("long string");',
    "let result;",
    "{",
    '    let s2 = String::from("xyz");',
    "    result = longest(&s1, &s2);",
    "}",
    'println!("{}", result);',
  ], { errors: [["E0597", 6, "`s2` does not live long enough"]] }),
  p("first", "Two lifetimes: the result needs only x", [
    "fn first<'a, 'b>(x: &'a str, y: &'b str) -> &'a str;",
    'let s1 = String::from("long string");',
    "let result;",
    "{",
    '    let s2 = String::from("xyz");',
    "    result = first(&s1, &s2);",
    "}",
    'println!("{}", result);',
  ], { errors: [], stdout: ["long string"] }),
  p("missing", "Two inputs, no lifetime on the output", [
    "fn longest(x: &str, y: &str) -> &str;",
    'let a = String::from("a");',
    "let r = longest(&a, &a);",
  ], { errors: [["E0106", 1, "missing lifetime specifier"]] }),
  p("elided", "Elision ties the result to s", [
    "fn first_word(s: &str) -> &str;",
    'let mut s = String::from("hello world");',
    "let word = first_word(&s);",
    "s.clear();",
    'println!("{}", word);',
  ], { errors: [["E0502", 4, "cannot borrow `s` as mutable because it is also borrowed as immutable"]] }),
  p("static", "A 'static result outlives every local", [
    "fn name() -> &'static str;",
    "let n;",
    "{",
    '    let s = String::from("x");',
    "    n = name();",
    "}",
    'println!("{}", n);',
  ], { errors: [], stdout: ["static"] }),
];

export const ALL_PROGRAMS: Program[] = [...OWNERSHIP, ...DROPS, ...BORROWS, ...LIFETIMES];
