/**
 * The shared program-memory toolkit of the Systems Programming track: C and Rust type layout on six target ABIs, and
 * an abstract machine of a running program (segments, stack frames, a heap allocator, pointers with provenance, UB
 * detection and a step trace). Every demo that shows what a program does with memory uses it, so the track reads one
 * way. Views for it are in src/demos/sys/SysViews.tsx.
 *
 * What it models: psABI sizes, alignments and offsets (checked against `zig cc` for every target, and `rustc` for the
 * Rust layouts on x86-64); `#pragma pack`, `alignas`, `repr(C)`, `repr(packed)`, `repr(align)`, a documented model of
 * `repr(Rust)` field reordering and the Option niche; a process address space with model base addresses; x86-64-style
 * stack frames; a first-fit heap allocator with 16-byte headers; little-endian typed loads and stores; pointer
 * provenance; init bits per byte; and UB checks in the spirit of Miri and the sanitizers (ASan, MSan, UBSan, LSan).
 *
 * What it does not model: a real CPU (no registers, no instructions, no caches, no timing), threads, signals, the
 * dynamic loader, ASLR, compiler optimizations (a real compiler may delete or reorder the accesses that this machine
 * checks), glibc's real allocator (tcache, bins, arenas), and the redzones and quarantine of ASan. The base
 * addresses, the frame layout and the allocator are MODEL CHOICES, close to Linux x86-64 but not identical to it.
 * Real hardware checks none of the UB kinds: on a real machine a use-after-free just reads whatever bytes are there.
 * `rawLoad` and `rawStore` show that view.
 *
 * ```ts
 * import { Machine, T, ptr, array, struct, layoutC, layoutRust, offset } from "../../sims/sys/mem";
 * const S = struct("S", [["c", T.char], ["i", T.int], ["s", T.short]]);
 * layoutC(S).size;                        // 12: c at 0, 3 padding bytes, i at 4, s at 8, 2 tail bytes
 * layoutRust(S).size;                    // 8: repr(Rust) under the sort-by-alignment model (repr: "C" gives 12)
 * layoutC(S, "i386-linux").holes;         // [{ offset: 1, size: 3, reason: "align", before: "i" }, { offset: 10, ... "tail" }]
 *
 * const m = new Machine();                // { target: "x86_64-linux", onUB: "record" | "throw", stackLimit }
 * m.line = 3;                             // later events record source line 3 (for steppers)
 * m.call("main", [{ name: "p", type: ptr(T.int) }]);
 * const a = m.malloc(16);                 // Ptr { addr: 0x405010, alloc: <id> }
 * m.store(a, T.int, 1); m.free(a);
 * m.load(a, T.int);                       // records a heap-use-after-free UbReport and returns the stale 1
 * m.set("p", a); m.get("p");              // locals by name
 * m.exit();                               // pops all frames, then a LeakSanitizer-style leak check
 * m.trace; m.ub; m.snapshot();            // events, UB reports, state for the views
 * ```
 *
 * - layout.ts: the type language (`T`, `ptr`, `ref`, `box`, `array`, `struct`, `union`, `option`, `nonzero`),
 *   `TARGETS` (x86_64-linux, aarch64-linux, x86_64-windows, i386-linux, riscv64-linux, riscv32-linux) with sources,
 *   `layoutC`, `layoutRust`, `sizeOf`, `alignOf`, `optimalOrder`, `wasted`, `byteOwners`, `typeName`, `scalarInfo`.
 * - machine.ts: `Machine` (call, ret, addrOf, typeOf, set, get, global, literal, fnAddr, malloc, calloc, realloc,
 *   free, allocNamed, mmap, munmap, store, load, rawLoad, rawStore, memcpy, memset, field, layout, sizeOf, peek, note,
 *   exit, snapshot, heapBlocks, alloc, allAllocs, trace, ub, line), `Ptr`, `NULL`, `offset`, `hex`, `ADDR`,
 *   `UB_KINDS` (with the exact detection rule of each kind), `UB_TOOL`, `UbReport`, `UbError`, `Snapshot` and its
 *   parts (SegmentSnap, FrameSnap, SlotSnap, BlockSnap, PtrEdge).
 */
export * from "./layout";
export * from "./machine";
