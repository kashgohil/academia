/**
 * Static and dynamic dispatch in Rust, step by step, on the real code of one compiler.
 *
 * The listings are rustc 1.96.1 output for this source (`-C opt-level=3 --target x86_64-apple-darwin`,
 * Intel syntax; directives removed):
 *
 *   pub trait Shape { fn area(&self) -> f64; }
 *   impl Shape for Square { fn area(&self) -> f64 { self.0 * self.0 } }
 *   impl Shape for Circle { fn area(&self) -> f64 { 3.141592653589793 * self.0 * self.0 } }
 *   pub fn total_static<S: Shape>(v: &[S]) -> f64 { v.iter().map(|s| s.area()).sum() }
 *   pub fn total_dyn(v: &[&dyn Shape]) -> f64 { v.iter().map(|s| s.area()).sum() }
 *   pub fn squares(v: &[Square]) -> f64 { total_static(v) }
 *
 * `frames` replays the loops of `squares` (the instance total_static::<Square>) and `total_dyn` over a small
 * slice. It is a scripted replay of these instructions, not an x86 emulator. The addresses are made up; the
 * offsets (16-byte fat pointers, the method at vtable + 24) are the ones in the listings. The vtable layout is
 * what rustc emits today ([drop_in_place, size, align, area]); the language does not guarantee it.
 */

export interface AsmLine { text: string; note?: string }

/** The inner loops. `squares` also has a loop unrolled by 4 for long slices (`STATIC_UNROLLED`). */
export const STATIC_LOOP: AsmLine[] = [
  { text: "LBB1_8:" },
  { text: "  movsd  xmm1, qword ptr [rcx + 8*rdx]", note: "load v[i].0" },
  { text: "  mulsd  xmm1, xmm1", note: "area, inlined: r * r" },
  { text: "  addsd  xmm0, xmm1", note: "sum += area" },
  { text: "  inc    rdx" },
  { text: "  cmp    rax, rdx" },
  { text: "  jne    LBB1_8" },
];
export const STATIC_UNROLLED: AsmLine[] = [
  { text: "LBB1_5:" },
  { text: "  movsd  xmm1, qword ptr [rdi + 8*rcx]" },
  { text: "  movsd  xmm2, qword ptr [rdi + 8*rcx + 8]" },
  { text: "  mulsd  xmm1, xmm1" },
  { text: "  addsd  xmm1, xmm0" },
  { text: "  mulsd  xmm2, xmm2" },
  { text: "  addsd  xmm2, xmm1" },
  { text: "  movsd  xmm1, qword ptr [rdi + 8*rcx + 16]" },
  { text: "  mulsd  xmm1, xmm1" },
  { text: "  addsd  xmm1, xmm2" },
  { text: "  movsd  xmm0, qword ptr [rdi + 8*rcx + 24]" },
  { text: "  mulsd  xmm0, xmm0" },
  { text: "  addsd  xmm0, xmm1" },
  { text: "  add    rcx, 4" },
  { text: "  cmp    rsi, rcx" },
  { text: "  jne    LBB1_5" },
];
export const DYN_LOOP: AsmLine[] = [
  { text: "LBB2_4:" },
  { text: "  movsd  qword ptr [rbp - 32], xmm0", note: "save sum: the callee may change xmm0" },
  { text: "  mov    rdi, qword ptr [r14 + r15]", note: "word 0: data pointer" },
  { text: "  mov    rax, qword ptr [r14 + r15 + 8]", note: "word 1: vtable pointer" },
  { text: "  call   qword ptr [rax + 24]", note: "indirect call through vtable slot 3" },
  { text: "  movsd  xmm1, qword ptr [rbp - 32]", note: "reload sum" },
  { text: "  addsd  xmm1, xmm0" },
  { text: "  movsd  qword ptr [rbp - 32], xmm1" },
  { text: "  movsd  xmm0, qword ptr [rbp - 32]" },
  { text: "  add    r15, 16", note: "next fat pointer: 16 bytes" },
  { text: "  cmp    rbx, r15" },
  { text: "  jne    LBB2_4" },
];
export const SQUARE_AREA: AsmLine[] = [
  { text: "<Square as Shape>::area:" },
  { text: "  push   rbp" },
  { text: "  mov    rbp, rsp" },
  { text: "  movsd  xmm0, qword ptr [rdi]" },
  { text: "  mulsd  xmm0, xmm0" },
  { text: "  pop    rbp" },
  { text: "  ret" },
];
export const CIRCLE_AREA: AsmLine[] = [
  { text: "<Circle as Shape>::area:" },
  { text: "  push   rbp" },
  { text: "  mov    rbp, rsp" },
  { text: "  movsd  xmm1, qword ptr [rdi]" },
  { text: "  movsd  xmm0, qword ptr [rip + PI]" },
  { text: "  mulsd  xmm0, xmm1" },
  { text: "  mulsd  xmm0, xmm1" },
  { text: "  pop    rbp" },
  { text: "  ret" },
];

const instrs = (l: AsmLine[]) => l.filter((x) => x.text.startsWith("  ")).length;

/** Instructions per element in each inner loop, counted from the listings. */
export function perElement() {
  return {
    staticUnrolled: instrs(STATIC_UNROLLED) / 4,
    staticRemainder: instrs(STATIC_LOOP),
    dynSquare: instrs(DYN_LOOP) + instrs(SQUARE_AREA),
    dynCircle: instrs(DYN_LOOP) + instrs(CIRCLE_AREA),
  };
}

export type ShapeKind = "Square" | "Circle";
export interface Elem { kind: ShapeKind; r: number }
export const DYN_SLICE: Elem[] = [{ kind: "Square", r: 3 }, { kind: "Circle", r: 1 }, { kind: "Square", r: 2 }];
export const STATIC_SLICE: Elem[] = [{ kind: "Square", r: 3 }, { kind: "Square", r: 1 }, { kind: "Square", r: 2 }];

/** Made-up addresses for the memory view. */
export const ADDR = { slice: 0x1000, objects: 0x2000, vtSquare: 0x3000, vtCircle: 0x3040, fnSquare: 0x4000, fnCircle: 0x4040 };

export type Spot =
  | { at: "slice"; i: number; word: 0 | 1 }
  | { at: "object"; i: number }
  | { at: "vtable"; kind: ShapeKind; slot: number }
  | { at: "spill" }
  | { at: "none" };

export interface Frame {
  /** Which listing and which line is running. */
  listing: "static" | "dyn" | "Square" | "Circle";
  line: number;
  /** The element being processed. */
  i: number;
  regs: Record<string, string>;
  /** What this instruction reads or writes. */
  spot: Spot;
  caption: string;
  /** Instructions run so far. */
  count: number;
  indirect: number;
}

const hex = (n: number) => `0x${n.toString(16)}`;
const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : x.toFixed(4));

export function frames(mode: "static" | "dyn"): Frame[] {
  const out: Frame[] = [];
  const regs: Record<string, string> = {};
  let count = 0, indirect = 0;
  const push = (listing: Frame["listing"], line: number, i: number, spot: Spot, caption: string) => {
    count++;
    out.push({ listing, line, i, regs: { ...regs }, spot, caption, count, indirect });
  };
  let sum = -0;
  if (mode === "static") {
    regs.rcx = hex(ADDR.objects);
    regs.xmm0 = "-0.0";
    STATIC_SLICE.forEach((e, i) => {
      regs.rdx = String(i);
      regs.xmm1 = f(e.r);
      push("static", 1, i, { at: "object", i }, `Load v[${i}].0 = ${f(e.r)} straight from the slice of Squares. No pointer to follow.`);
      regs.xmm1 = f(e.r * e.r);
      push("static", 2, i, { at: "none" }, `The body of Square::area is inlined: one multiply, ${f(e.r)} × ${f(e.r)}.`);
      sum += e.r * e.r;
      regs.xmm0 = f(sum);
      push("static", 3, i, { at: "none" }, `Add to the sum, which stays in xmm0. Nothing goes to memory.`);
      regs.rdx = String(i + 1);
      push("static", 4, i, { at: "none" }, "Next index.");
      push("static", 5, i, { at: "none" }, "Compare with the length.");
      push("static", 6, i, { at: "none" }, i < STATIC_SLICE.length - 1 ? "Loop again." : "Done: the loop falls through.");
    });
    return out;
  }
  regs.r14 = hex(ADDR.slice);
  regs.xmm0 = "-0.0";
  DYN_SLICE.forEach((e, i) => {
    regs.r15 = String(i * 16);
    const vt = e.kind === "Square" ? ADDR.vtSquare : ADDR.vtCircle;
    push("dyn", 1, i, { at: "spill" }, "Save the sum on the stack. The call may change any xmm register.");
    regs.rdi = hex(ADDR.objects + 8 * i);
    push("dyn", 2, i, { at: "slice", i, word: 0 }, `Load word 0 of the fat pointer: the data pointer ${regs.rdi}.`);
    regs.rax = hex(vt);
    push("dyn", 3, i, { at: "slice", i, word: 1 }, `Load word 1: the vtable pointer ${regs.rax}, the vtable of ${e.kind}.`);
    indirect++;
    push("dyn", 4, i, { at: "vtable", kind: e.kind, slot: 3 }, `Read vtable + 24 (slot 3) and call that address: <${e.kind} as Shape>::area. The CPU must predict this target.`);
    const body = e.kind === "Square" ? SQUARE_AREA : CIRCLE_AREA;
    push(e.kind, 1, i, { at: "none" }, "The callee saves the frame pointer (macOS keeps frame pointers).");
    push(e.kind, 2, i, { at: "none" }, "Set up the frame.");
    regs.xmm0 = f(e.r);
    push(e.kind, 3, i, { at: "object", i }, `Load self.0 = ${f(e.r)} through rdi.`);
    const a = e.kind === "Square" ? e.r * e.r : Math.PI * e.r * e.r;
    if (e.kind === "Circle") {
      regs.xmm1 = f(e.r);
      regs.xmm0 = "3.1416";
      push(e.kind, 4, i, { at: "none" }, "Load the constant π.");
      regs.xmm0 = f(Math.PI * e.r);
      push(e.kind, 5, i, { at: "none" }, "Multiply by r.");
      regs.xmm0 = f(a);
      push(e.kind, 6, i, { at: "none" }, "Multiply by r again: the area is in xmm0.");
    } else {
      regs.xmm0 = f(a);
      push(e.kind, 4, i, { at: "none" }, "Multiply: the area is in xmm0, the return register.");
    }
    push(e.kind, body.length - 2, i, { at: "none" }, "Restore the frame pointer.");
    push(e.kind, body.length - 1, i, { at: "none" }, "Return to the loop.");
    regs.xmm1 = f(sum);
    push("dyn", 5, i, { at: "spill" }, "Reload the sum from the stack.");
    sum += a;
    regs.xmm1 = f(sum);
    push("dyn", 6, i, { at: "none" }, "Add the area.");
    push("dyn", 7, i, { at: "spill" }, "Store the sum again.");
    regs.xmm0 = f(sum);
    push("dyn", 8, i, { at: "spill" }, "And load it back into xmm0. LLVM keeps the sum in memory across the call.");
    regs.r15 = String((i + 1) * 16);
    push("dyn", 9, i, { at: "none" }, "Move to the next fat pointer, 16 bytes on.");
    push("dyn", 10, i, { at: "none" }, "Compare with the end.");
    push("dyn", 11, i, { at: "none" }, i < DYN_SLICE.length - 1 ? "Loop again." : "Done.");
  });
  return out;
}

/** The final sums, to check the replay. */
export const expectedSum = (mode: "static" | "dyn") =>
  (mode === "static" ? STATIC_SLICE : DYN_SLICE).reduce((a, e) => a + (e.kind === "Square" ? e.r * e.r : Math.PI * e.r * e.r), 0);
