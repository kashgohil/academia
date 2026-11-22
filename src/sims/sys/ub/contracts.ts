/**
 * One bug, many contracts: what C, Rust, Zig and Go promise for the same four operations at the edge, in each build
 * mode. For the what-ub-really-means lesson.
 *
 * Every panic and sanitizer message here is real output that was produced locally (AArch64 macOS): rustc 1.96.1,
 * zig 0.17.1, go 1.25.6 and Apple clang 21 with -fsanitize=undefined or address. Where a language leaves the result
 * undefined or unchecked, the cell says so and shows what the hardware does in this model: a 32-bit add wraps, a
 * 32-bit shift on x86-64 and AArch64 uses the count modulo 32, and an index past an array reads the next bytes of the
 * frame of the shared abstract machine (src/sims/sys/mem). That value is a MODEL; a real program reads whatever its
 * compiler put there.
 */
import { array, Machine, offset, T } from "../mem";

export type OpId = "add" | "index" | "shift" | "null";
export type ModeId = "c0" | "c2" | "csan" | "rdbg" | "rrel" | "zsafe" | "zfast" | "go";

export const MODES: { id: ModeId; lang: string; label: string }[] = [
  { id: "c0", lang: "C", label: "-O0" },
  { id: "c2", lang: "C", label: "-O2" },
  { id: "csan", lang: "C", label: "-fsanitize=undefined" },
  { id: "rdbg", lang: "Rust", label: "debug" },
  { id: "rrel", lang: "Rust", label: "release" },
  { id: "zsafe", lang: "Zig", label: "-O debug, -O safe" },
  { id: "zfast", lang: "Zig", label: "-O fast" },
  { id: "go", lang: "Go", label: "any" },
];

export type Tone = "defined" | "panic" | "ub" | "compile";

export interface Cell { tone: Tone; text: string }

export interface OpSpec {
  id: OpId;
  label: string;
  /** The operation in each language. */
  code: string;
  input: { label: string; min: number; max: number; default: number; format: (v: number) => string } | null;
}

const INT_MAX = 2147483647;

export const OPS: OpSpec[] = [
  { id: "add", label: "x + 1", code: "int x; … x + 1", input: { label: "x", min: 0, max: 4, default: 0, format: (d) => (d === 0 ? "INT_MAX" : `INT_MAX − ${d}`) } },
  { id: "index", label: "a[i] on a 4-element array", code: "int a[4]; … a[i]", input: { label: "i", min: 0, max: 6, default: 4, format: (v) => String(v) } },
  { id: "shift", label: "1 << s on a 32-bit int", code: "int one = 1; … one << s", input: { label: "s", min: 28, max: 36, default: 32, format: (v) => String(v) } },
  { id: "null", label: "read through a null pointer", code: "int *p = NULL; … *p", input: null },
];

/** The neighbour value in the model frame: a local declared after a. */
export const FRAME_NEIGHBOUR = 1234;

/** a[i] for i past the end: the bytes the model frame holds there (a[4] is the next local, n). */
export function frameRead(i: number): number {
  const m = new Machine();
  m.call("main", [{ name: "a", type: array(T.int, 4), value: [1, 2, 3, 4] }, { name: "n", type: T.int, value: FRAME_NEIGHBOUR }]);
  return m.rawLoad(offset(m.addrOf("a"), 4 * i), T.int) as number;
}

/** The outcome of one operation in one mode. `v` is the input (d for add, i for index, s for shift). */
export function outcome(op: OpId, mode: ModeId, v: number): Cell {
  switch (op) {
    case "add": {
      const x = INT_MAX - v;
      const ok = v > 0;
      const sum = String((x + 1) | 0);
      if (ok) return { tone: "defined", text: sum };
      switch (mode) {
        case "c0": return { tone: "ub", text: `UB; the add instruction wraps: ${sum}` };
        case "c2": return { tone: "ub", text: `UB; this printf showed ${sum}, but the compiler may assume it never happens` };
        case "csan": return { tone: "panic", text: "runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'" };
        case "rdbg": return { tone: "panic", text: "panicked: attempt to add with overflow" };
        case "rrel": return { tone: "defined", text: `wraps (overflow checks are off): ${sum}` };
        case "zsafe": return { tone: "panic", text: "panic: integer overflow" };
        case "zfast": return { tone: "ub", text: `unchecked illegal behavior; this run printed ${sum}` };
        case "go": return { tone: "defined", text: `wraps by the spec: ${sum}` };
      }
      break;
    }
    case "index": {
      if (v < 4) return { tone: "defined", text: String(v + 1) };
      const raw = String(frameRead(v));
      switch (mode) {
        case "c0":
        case "c2": return { tone: "ub", text: `UB; reads the next bytes of the frame (model: ${raw})` };
        case "csan": return { tone: "panic", text: `runtime error: index ${v} out of bounds for type 'int[4]'` };
        case "rdbg":
        case "rrel": return { tone: "panic", text: `panicked: index out of bounds: the len is 4 but the index is ${v}` };
        case "zsafe": return { tone: "panic", text: `panic: index out of bounds: index ${v}, len 4` };
        case "zfast": return { tone: "ub", text: `unchecked illegal behavior; reads past the array (model: ${raw})` };
        case "go": return { tone: "panic", text: `panic: runtime error: index out of range [${v}] with length 4` };
      }
      break;
    }
    case "shift": {
      const hw = String(1 << (v & 31)); // JS << uses the count mod 32 and gives a 32-bit signed result, like shl and lsl
      if (v < 31) return { tone: "defined", text: String(1 << v) };
      if (v === 31) {
        switch (mode) {
          case "c0":
          case "c2": return { tone: "ub", text: `UB in C: 2³¹ does not fit in int; the bits give ${hw}` };
          case "csan": return { tone: "panic", text: "runtime error: left shift of 1 by 31 places cannot be represented in type 'int'" };
          default: return { tone: "defined", text: hw };
        }
      }
      switch (mode) {
        case "c0":
        case "c2": return { tone: "ub", text: `UB; shl and lsl use s mod 32, so this run gives ${hw}` };
        case "csan": return { tone: "panic", text: `runtime error: shift exponent ${v} is too large for 32-bit type 'int'` };
        case "rdbg": return { tone: "panic", text: "panicked: attempt to shift left with overflow" };
        case "rrel": return { tone: "defined", text: `masks the count to s mod 32: ${hw}` };
        case "zsafe": return { tone: "panic", text: "panic: integer does not fit in destination type (the @intCast to u5)" };
        case "zfast": return { tone: "ub", text: "unchecked illegal behavior; this run printed nothing at all" };
        case "go": return { tone: "defined", text: "0 by the spec: a shift past the width gives 0" };
      }
      break;
    }
    case "null":
      switch (mode) {
        case "c0": return { tone: "ub", text: "UB; the load faults: SIGSEGV" };
        case "c2": return { tone: "ub", text: "UB; usually SIGSEGV, but the compiler may delete checks around it" };
        case "csan": return { tone: "panic", text: "runtime error: load of null pointer of type 'int'" };
        case "rdbg":
        case "rrel": return { tone: "compile", text: "a reference cannot be null; Option::unwrap on None panics: called `Option::unwrap()` on a `None` value" };
        case "zsafe": return { tone: "panic", text: "panic: attempt to use null value (p.? on a null optional)" };
        case "zfast": return { tone: "ub", text: "unchecked illegal behavior; this run printed 0 and did not crash" };
        case "go": return { tone: "panic", text: "panic: runtime error: invalid memory address or nil pointer dereference" };
      }
  }
  throw new Error(`no outcome for ${op} ${mode}`);
}
