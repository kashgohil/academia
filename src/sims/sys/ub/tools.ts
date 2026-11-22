/**
 * Which tool catches which bug, for the sanitizers lesson. The memory bugs run on the shared abstract machine
 * (src/sims/sys/mem), which gives the report text; the matrix says which real tool reports that kind of bug and why.
 *
 * The verdicts come from each tool's documentation (clang.llvm.org/docs: AddressSanitizer, MemorySanitizer,
 * ThreadSanitizer, UndefinedBehaviorSanitizer, LeakSanitizer, HardwareAssistedAddressSanitizerDesign; the Valgrind
 * Memcheck manual; the Miri README). "partial" means the tool catches the bug only in some cases; the reason says which.
 * The "skip" bug (an index that jumps over the redzone into the next block) is the case where shadow memory and
 * provenance disagree; asan.ts shows it byte by byte.
 */
import { array, Machine, offset, T, type UbReport } from "../mem";
import { AsanHeap } from "./asan";

export type ToolId = "asan" | "hwasan" | "msan" | "ubsan" | "tsan" | "lsan" | "valgrind" | "miri";
export type BugId = "overflow" | "skip" | "uaf" | "uninit" | "leak" | "signed" | "misaligned" | "race";
export type Verdict = "yes" | "partial" | "no";

export const TOOLS: { id: ToolId; label: string; how: string }[] = [
  { id: "asan", label: "ASan", how: "compiler instrumentation + shadow memory (1 byte per 8), redzones, quarantine" },
  { id: "hwasan", label: "HWASan", how: "AArch64 top-byte tags in pointers, 16-byte granules with memory tags" },
  { id: "msan", label: "MSan", how: "1 shadow bit per bit: is this bit initialized?" },
  { id: "ubsan", label: "UBSan", how: "a check at each operation the standard leaves undefined" },
  { id: "tsan", label: "TSan", how: "vector clocks and shadow cells per 8 bytes" },
  { id: "lsan", label: "LSan", how: "at exit, scans memory for pointers to live blocks" },
  { id: "valgrind", label: "Memcheck", how: "runs the unmodified binary on a synthetic CPU" },
  { id: "miri", label: "Miri", how: "interprets Rust MIR with provenance and borrow tracking" },
];

export const BUGS: { id: BugId; label: string; code: string[] }[] = [
  { id: "overflow", label: "Off-by-one heap read", code: ["int *a = malloc(10 * sizeof(int));", "int v = a[10];"] },
  { id: "skip", label: "Index lands in the next block", code: ["int *a = malloc(40), *b = malloc(40);", "int v = a[16];   // inside b"] },
  { id: "uaf", label: "Use after free", code: ["int *a = malloc(40);", "free(a);", "int v = a[3];"] },
  { id: "uninit", label: "Branch on an uninitialized value", code: ["int x;", "if (x > 0) puts(\"yes\");"] },
  { id: "leak", label: "Leak", code: ["void *p = malloc(7);", "p = NULL;   // last pointer gone"] },
  { id: "signed", label: "Signed overflow", code: ["int x = INT_MAX;", "x = x + 1;"] },
  { id: "misaligned", label: "Misaligned load", code: ["char buf[8];", "int v = *(int *)(buf + 1);"] },
  { id: "race", label: "Data race", code: ["// thread 1      // thread 2", "counter++;       counter++;"] },
];

const V: Record<BugId, Record<ToolId, [Verdict, string]>> = {
  overflow: {
    asan: ["yes", "a[10] is in the right redzone, so its shadow byte is fa."],
    hwasan: ["yes", "The granule after the block has a different tag (short granules cover sizes that are not multiples of 16)."],
    msan: ["no", "MSan tracks only initialization."],
    ubsan: ["no", "-fsanitize=bounds checks arrays with a size known at compile time, not a malloc block."],
    tsan: ["no", "TSan tracks only races."],
    lsan: ["no", "LSan looks only for leaks."],
    valgrind: ["yes", "Memcheck's malloc adds redzones and marks them not addressable."],
    miri: ["yes", "The pointer's provenance is the block, and the access is out of bounds (in Rust: a raw pointer read)."],
  },
  skip: {
    asan: ["no", "a[16] has a 00 shadow byte: it is a valid byte of b. ASan checks the address, not the pointer it came from."],
    hwasan: ["partial", "The pointer has a's tag and the memory has b's tag. They differ, except with a chance of 1 in 256."],
    msan: ["no", "MSan tracks only initialization."],
    ubsan: ["no", "No UBSan check covers pointer arithmetic across blocks of the heap."],
    tsan: ["no", "TSan tracks only races."],
    lsan: ["no", "LSan looks only for leaks."],
    valgrind: ["no", "The address is inside a live block, so Memcheck sees a valid read."],
    miri: ["yes", "Provenance: a pointer derived from a may not access b."],
  },
  uaf: {
    asan: ["partial", "Yes while the block is in quarantine (shadow fd). After eviction and reuse, the bytes are valid again."],
    hwasan: ["partial", "free gives the memory a different tag, with no quarantine. The old pointer's tag can still match a later tag by chance."],
    msan: ["no", "MSan tracks only initialization."],
    ubsan: ["no", "UBSan has no heap state."],
    tsan: ["no", "TSan tracks only races."],
    lsan: ["no", "LSan looks only for leaks."],
    valgrind: ["partial", "Usually: Memcheck delays the reuse of freed blocks, so a read soon after free is caught. After reuse it is not."],
    miri: ["yes", "The allocation is dead; Miri never reuses its identity."],
  },
  uninit: {
    asan: ["no", "ASan does not track initialization."],
    hwasan: ["no", "HWASan does not track initialization."],
    msan: ["yes", "The shadow bits of x are poisoned, and MSan reports at the branch."],
    ubsan: ["no", "UBSan has no initialization state."],
    tsan: ["no", "TSan tracks only races."],
    lsan: ["no", "LSan looks only for leaks."],
    valgrind: ["yes", "Memcheck tracks definedness bits and reports a conditional jump on an undefined value."],
    miri: ["yes", "Miri reports the read of uninitialized memory itself."],
  },
  leak: {
    asan: ["yes", "LSan runs at exit as part of ASan, by default on Linux. Apple clang on macOS said: detect_leaks is not supported on this platform."],
    hwasan: ["no", "HWASan does not scan for leaks by default."],
    msan: ["no", "MSan tracks only initialization."],
    ubsan: ["no", "UBSan has no heap state."],
    tsan: ["no", "TSan tracks only races."],
    lsan: ["yes", "No root reaches the block at exit."],
    valgrind: ["yes", "Memcheck reports 'definitely lost' blocks at exit (--leak-check=full)."],
    miri: ["yes", "Miri reports memory that is still allocated when main returns."],
  },
  signed: {
    asan: ["no", "ASan checks memory only."],
    hwasan: ["no", "HWASan checks memory only."],
    msan: ["no", "MSan tracks only initialization."],
    ubsan: ["yes", "-fsanitize=signed-integer-overflow checks each signed add, subtract and multiply."],
    tsan: ["no", "TSan tracks only races."],
    lsan: ["no", "LSan looks only for leaks."],
    valgrind: ["no", "The binary contains a plain add; the UB is in the source, not in the machine code."],
    miri: ["no", "Not UB in Rust: a debug build panics, and Miri reports that panic like any other."],
  },
  misaligned: {
    asan: ["no", "ASan checks addressability, not alignment."],
    hwasan: ["no", "HWASan checks tags, not alignment."],
    msan: ["no", "MSan tracks only initialization."],
    ubsan: ["yes", "-fsanitize=alignment checks the address against the type's alignment."],
    tsan: ["no", "TSan tracks only races."],
    lsan: ["no", "LSan looks only for leaks."],
    valgrind: ["no", "x86-64 and AArch64 allow the unaligned load, so the machine code is fine."],
    miri: ["yes", "Miri checks the alignment of every typed access."],
  },
  race: {
    asan: ["no", "ASan does not track threads."],
    hwasan: ["no", "HWASan does not track threads."],
    msan: ["no", "MSan tracks only initialization."],
    ubsan: ["no", "UBSan does not track threads."],
    tsan: ["yes", "The two accesses are not ordered by happens-before."],
    lsan: ["no", "LSan looks only for leaks."],
    valgrind: ["no", "Not Memcheck: Valgrind's Helgrind and DRD tools find races."],
    miri: ["yes", "Miri detects data races in the interleavings it runs."],
  },
};

export const verdict = (bug: BugId, tool: ToolId) => V[bug][tool];

/** The number of tools in TOOLS that catch a bug ("yes" only). */
export const catchers = (bug: BugId) => TOOLS.filter((t) => V[bug][t.id][0] === "yes").length;

/** The report that the shared machine (provenance-based, like Miri and ASan together) gives for a memory bug. */
export function machineReport(bug: BugId): UbReport | null {
  const m = new Machine();
  switch (bug) {
    case "overflow": {
      m.call("main", []);
      const a = m.malloc(40);
      m.load(offset(a, 40), T.int);
      break;
    }
    case "skip": {
      m.call("main", []);
      const a = m.malloc(40);
      m.malloc(40);
      m.load(offset(a, 64), T.int);
      break;
    }
    case "uaf": {
      m.call("main", []);
      const a = m.malloc(40);
      m.free(a);
      m.load(offset(a, 12), T.int);
      break;
    }
    case "uninit": {
      m.call("main", [{ name: "x", type: T.int }]);
      m.get("x");
      break;
    }
    case "leak": {
      m.call("main", [{ name: "p", type: T.long }]);
      m.malloc(7);
      m.exit();
      break;
    }
    case "misaligned": {
      m.call("main", [{ name: "buf", type: array(T.char, 8), value: [0, 0, 0, 0, 0, 0, 0, 0] }]);
      m.load(offset(m.addrOf("buf"), 1), T.int);
      break;
    }
    default:
      return null;
  }
  return m.ub[0] ?? null;
}

/** For the skip bug: the shadow byte that ASan checks for a[16] when two 40-byte blocks are next to each other. */
export function skipShadow(): { distance: number; shadow: number } {
  const h = new AsanHeap();
  const a = h.malloc(40, "a");
  const b = h.malloc(40, "b");
  const at = a.user + 64;
  return { distance: b.user - a.user, shadow: h.access(at, 4).shadowByte };
}

/** Typical costs, as each tool's documentation states them. Facts, not model output. */
export const COSTS: { tool: string; slowdown: string; source: string }[] = [
  { tool: "ASan", slowdown: "about 2x", source: "clang AddressSanitizer docs" },
  { tool: "MSan", slowdown: "about 3x", source: "clang MemorySanitizer docs" },
  { tool: "TSan", slowdown: "5x to 15x; memory 5x to 10x", source: "clang ThreadSanitizer docs" },
  { tool: "Memcheck", slowdown: "10x to 50x", source: "Valgrind user manual, section 2.2" },
];
