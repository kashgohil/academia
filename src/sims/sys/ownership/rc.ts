/**
 * Smart pointer models for the smart-pointers lesson.
 *
 * - rcCycle: two `Rc<Node>` objects on the shared memory machine. Each node can point to the other with a strong
 *   `Rc` or a `Weak`. The rules are the ones in the Rust standard library (library/alloc/src/rcs/rc.rs, `RcInner` is `repr(C)` with strong, weak, value): an Rc
 *   allocation holds a strong count, a weak count and the value. Dropping an Rc decrements the strong count; at zero
 *   the value is dropped, and then the implicit weak reference that all strong references share is released. The
 *   allocation is freed when the weak count reaches zero. `Rc::weak_count` does not show the implicit one.
 *   A strong cycle keeps both counts above zero after both handles are gone: a leak, which LeakSanitizer reports.
 * - refCell: the borrow flag of a `RefCell<T>`: 0 is unused, a positive value counts the live `Ref`s, and -1 means
 *   one `RefMut` is live. A conflicting `borrow` or `borrow_mut` panics at run time. The panic texts are the ones
 *   that rustc 1.96.1's standard library prints.
 * - SIZES: the size of each handle and of each allocation, measured with clang++ 21 + libc++ and with rustc 1.96.1
 *   on a 64-bit target (aarch64-apple-darwin; the same on x86-64 Linux for these types).
 */
import { Machine, T, ptr, struct, type Ptr, type Type } from "../mem";
import type { MemStep } from "./memory";

// ---------------------------------------------------------------- Rc and Weak

export type Link = "none" | "strong" | "weak";

export interface RcState {
  strong: number;
  /** As Rc::weak_count reports it: the Weak handles only. */
  weak: number;
  value: "live" | "dropped";
  freed: boolean;
}

export interface RcStep extends MemStep {
  a: RcState;
  b: RcState;
  /** What the Drop impl of Node printed so far. */
  printed: string[];
}

/** The Rc allocation of a node, as the model lays it out: two counts, the RefCell borrow flag, and the link. */
export const RC_NODE: Type = struct("RcBox<Node>", [["strong", T.usize], ["weak", T.usize], ["borrow", T.isize], ["next", ptr()]]);

export function rcSource(ab: Link, ba: Link): string[] {
  // Node has `next: RefCell<Option<Rc<Node>>>` and `back: RefCell<Option<Weak<Node>>>`
  const link = (from: string, to: string, l: Link) =>
    l === "none" ? `    // ${from} does not point to ${to}` : l === "strong" ? `    *${from}.next.borrow_mut() = Some(Rc::clone(&${to}));` : `    *${from}.back.borrow_mut() = Some(Rc::downgrade(&${to}));`;
  return [
    "fn main() {",
    '    let a = mk("a");     // Rc::new(Node { .. })',
    '    let b = mk("b");',
    link("a", "b", ab),
    link("b", "a", ba),
    "    drop(a);",
    "    drop(b);",
    "}",
  ];
}

export function rcCycle(ab: Link, ba: Link): RcStep[] {
  const m = new Machine();
  const steps: RcStep[] = [];
  const st = { a: { strong: 0, weakInt: 0, value: "live" as RcState["value"], freed: false, link: "none" as Link }, b: { strong: 0, weakInt: 0, value: "live" as RcState["value"], freed: false, link: "none" as Link } };
  const blocks: Record<"a" | "b", Ptr> = { a: { addr: 0 }, b: { addr: 0 } };
  const printed: string[] = [];
  const view = (n: "a" | "b"): RcState => {
    const s = st[n];
    return { strong: s.strong, weak: Math.max(0, s.weakInt - (s.strong > 0 ? 1 : 0)), value: s.value, freed: s.freed };
  };
  const sync = (n: "a" | "b") => {
    const s = st[n];
    if (s.freed || !blocks[n].addr) return;
    m.store(blocks[n], T.usize, s.strong);
    m.store({ addr: blocks[n].addr + 8, alloc: blocks[n].alloc }, T.usize, s.weakInt);
  };
  const other = (n: "a" | "b") => (n === "a" ? "b" : "a");
  const dropWeak = (n: "a" | "b") => {
    const s = st[n];
    s.weakInt--;
    sync(n);
    if (s.weakInt === 0) { s.freed = true; m.free(blocks[n]); }
  };
  const dropStrong = (n: "a" | "b") => {
    const s = st[n];
    s.strong--;
    sync(n);
    if (s.strong > 0) return;
    // the value drops: Node's Drop prints, then its field `next` drops
    s.value = "dropped";
    printed.push(`drop ${n}`);
    const l = s.link;
    s.link = "none";
    if (l !== "none") {
      m.store({ addr: blocks[n].addr + 24, alloc: blocks[n].alloc }, ptr(), null);
      if (l === "strong") dropStrong(other(n));
      else dropWeak(other(n));
    }
    dropWeak(n); // the implicit weak reference of the strong ones
  };
  const step = (line: number, caption: string, run?: () => void) => {
    const before = m.ub.length;
    m.line = line;
    run?.();
    steps.push({ line, caption, snap: m.snapshot(), ub: m.ub.slice(before), moved: [], a: view("a"), b: view("b"), printed: [...printed] });
  };
  step(0, "Before main. Press Step.");
  step(2, "Rc::new allocates one block: a strong count of 1, a weak count of 1 (the implicit one, which Rc::weak_count does not show) and the node.", () => {
    m.call("main", [{ name: "a", type: ptr(RC_NODE) }, { name: "b", type: ptr(RC_NODE) }]);
    blocks.a = m.allocNamed("Rc", "a", { type: RC_NODE });
    st.a.strong = 1; st.a.weakInt = 1; sync("a");
    m.set("a", blocks.a);
  });
  step(3, "The same for b.", () => {
    blocks.b = m.allocNamed("Rc", "b", { type: RC_NODE });
    st.b.strong = 1; st.b.weakInt = 1; sync("b");
    m.set("b", blocks.b);
  });
  const link = (from: "a" | "b", l: Link, line: number) => {
    const to = other(from);
    step(line, l === "none" ? `No link from ${from} to ${to}.` : l === "strong" ? `Rc::clone(&${to}) adds 1 to ${to}'s strong count. ${from} now keeps ${to} alive.` : `Rc::downgrade(&${to}) adds 1 to ${to}'s weak count. A Weak does not keep the value alive.`, () => {
      if (l === "none") { m.note("no link"); return; }
      st[from].link = l;
      if (l === "strong") st[to].strong++;
      else st[to].weakInt++;
      sync(to);
      m.store({ addr: blocks[from].addr + 24, alloc: blocks[from].alloc }, ptr(), blocks[to]);
    });
  };
  link("a", ab, 4);
  link("b", ba, 5);
  const dropLocal = (n: "a" | "b", line: number) => {
    let cap = "";
    step(line, "", () => {
      const before = { ...st[n] };
      dropStrong(n);
      m.set(n, null);
      const s = st[n];
      cap = s.value === "dropped"
        ? `The strong count of ${n} reaches 0: Node ${n} is dropped${before.link !== "none" ? `, and so is its ${before.link} link` : ""}. ${s.freed ? "The weak count reaches 0 too, so the block is freed." : "A Weak still points here, so the block stays allocated with no value in it."}`
        : `drop(${n}) takes the strong count of ${n} from ${before.strong} to ${s.strong}. Not zero: the other node still holds ${n}, so nothing is freed.`;
    });
    steps[steps.length - 1]!.caption = cap;
  };
  dropLocal("a", 6);
  dropLocal("b", 7);
  step(8, "", () => m.exit(0));
  const leaked = !st.a.freed || !st.b.freed;
  steps[steps.length - 1]!.caption = leaked
    ? "main ends. No variable points to the nodes, but their counts are not zero, so no drop runs: a memory leak. Safe Rust allows this. LeakSanitizer finds it."
    : "main ends. Every node was dropped and every block was freed.";
  return steps;
}

// ---------------------------------------------------------------- RefCell

export type CellOp = "borrow" | "borrow_mut" | "drop";
export interface CellState { flag: number; guards: { name: string; kind: "Ref" | "RefMut" }[]; panic?: string }

/**
 * Applies one operation to a RefCell's borrow flag. `drop` drops the newest guard. A conflicting borrow panics with
 * the standard library's message, as `RefCell::borrow` and `RefCell::borrow_mut` do; `try_borrow` and
 * `try_borrow_mut` return BorrowError and BorrowMutError instead.
 */
export function refCellStep(s: CellState, op: CellOp): CellState {
  const guards = [...s.guards];
  if (op === "drop") {
    const g = guards.pop();
    if (!g) return { ...s, guards, panic: undefined };
    return { flag: g.kind === "RefMut" ? 0 : s.flag - 1, guards, panic: undefined };
  }
  if (op === "borrow") {
    if (s.flag < 0) return { ...s, panic: "RefCell already mutably borrowed" };
    guards.push({ name: `r${guards.length + 1}`, kind: "Ref" });
    return { flag: s.flag + 1, guards };
  }
  if (s.flag !== 0) return { ...s, panic: "RefCell already borrowed" };
  guards.push({ name: `w${guards.length + 1}`, kind: "RefMut" });
  return { flag: -1, guards };
}

// ---------------------------------------------------------------- sizes

export interface SizeRow {
  lang: "C++" | "Rust";
  type: string;
  /** Bytes of the handle on the stack. */
  handle: number;
  /** What the handle words hold. */
  words: string[];
  /** Heap allocations made to create one, for a 16-byte value: their sizes in bytes. */
  allocs: number[];
  /** What the heap block holds, in order. */
  block?: string[];
  note: string;
}

/** Measured: sizeof / size_of, and the sizes passed to operator new or the global allocator, for a 16-byte Widget. */
export const SIZES: SizeRow[] = [
  { lang: "C++", type: "std::unique_ptr<Widget>", handle: 8, words: ["pointer"], allocs: [16], block: ["Widget (16)"], note: "The default deleter is an empty class, so it takes no space: the same size as a raw pointer." },
  { lang: "C++", type: "unique_ptr<Widget, void(*)(Widget*)>", handle: 16, words: ["pointer", "deleter function pointer"], allocs: [16], block: ["Widget (16)"], note: "A function-pointer deleter is stored in the handle. A captureless lambda as the deleter type keeps it at 8 bytes." },
  { lang: "C++", type: "std::shared_ptr<Widget> via make_shared", handle: 16, words: ["pointer to the Widget", "pointer to the control block"], allocs: [40], block: ["vtable pointer (8)", "shared count (8)", "weak count (8)", "Widget (16)"], note: "One allocation holds the control block and the object." },
  { lang: "C++", type: "shared_ptr<Widget>(new Widget)", handle: 16, words: ["pointer to the Widget", "pointer to the control block"], allocs: [16, 32], block: ["vtable pointer (8)", "shared count (8)", "weak count (8)", "pointer to the Widget (8)"], note: "Two allocations: the object, then a separate control block that points to it." },
  { lang: "C++", type: "std::weak_ptr<Widget>", handle: 16, words: ["pointer to the Widget", "pointer to the control block"], allocs: [], note: "Shares the control block of the shared_ptr it came from." },
  { lang: "Rust", type: "Box<Widget>", handle: 8, words: ["pointer"], allocs: [16], block: ["Widget (16)"], note: "Option<Box<Widget>> is also 8 bytes: None is the null pointer, which a Box never holds." },
  { lang: "Rust", type: "Box<dyn Shape>", handle: 16, words: ["data pointer", "vtable pointer"], allocs: [16], block: ["the value"], note: "A fat pointer. Box<[u8]> is also 16 bytes: a pointer and a length." },
  { lang: "Rust", type: "Rc<Widget>", handle: 8, words: ["pointer"], allocs: [32], block: ["strong count (8)", "weak count (8)", "Widget (16)"], note: "Non-atomic counts. Rc is not Send, so the compiler stops you from sharing it between threads." },
  { lang: "Rust", type: "Arc<Widget>", handle: 8, words: ["pointer"], allocs: [32], block: ["strong count, atomic (8)", "weak count, atomic (8)", "Widget (16)"], note: "The same layout as Rc, with atomic counts." },
  { lang: "Rust", type: "Weak<Widget>", handle: 8, words: ["pointer"], allocs: [], note: "Points at the same allocation as the Rc. upgrade() returns None after the value is dropped." },
  { lang: "Rust", type: "Rc<RefCell<Widget>>", handle: 8, words: ["pointer"], allocs: [40], block: ["strong count (8)", "weak count (8)", "borrow flag (8)", "Widget (16)"], note: "RefCell adds its borrow flag (an isize) to the value." },
];
