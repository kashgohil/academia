import { describe, expect, test } from "vitest";
import {
  ADDR, array, HEAP_HEADER, hex, Machine, NULL, offset, ptr, struct, T, UB_KINDS, UbError, type Local, type Ptr, type UbKind,
} from "../../src/sims/sys/mem";
import { mulberry32 } from "../../src/sims/rng";

const kinds = (m: Machine) => m.ub.map((u) => u.kind);
const main = (m: Machine, locals: Local[] = []) => m.call("main", locals);

describe("UB detection: one program per kind", () => {
  const programs: Record<UbKind, (m: Machine) => void> = {
    "null-dereference": (m) => { main(m); m.load(NULL, T.int); m.store({ addr: 8 }, T.int, 1); },
    "heap-use-after-free": (m) => { main(m); const p = m.malloc(16); m.free(p); m.load(p, T.int); },
    "stack-use-after-return": (m) => { main(m); m.call("f", [{ name: "x", type: T.int, value: 1 }]); const p = m.addrOf("x"); m.ret(); m.load(p, T.int); },
    "heap-buffer-overflow": (m) => { main(m); const p = m.malloc(16); m.store(offset(p, 16), T.int, 1); },
    "stack-buffer-overflow": (m) => { main(m, [{ name: "a", type: array(T.int, 4) }, { name: "s", type: T.int }]); m.store(offset(m.addrOf("a"), 16), T.int, 1); },
    "global-buffer-overflow": (m) => { const g = m.global("g", array(T.int, 2)); main(m); m.load(offset(g, 8), T.int); },
    segv: (m) => { main(m); const s = m.literal("hi"); m.store(s, T.char, 72); m.load({ addr: 0x500000 }, T.int); },
    "misaligned-access": (m) => { main(m); const p = m.malloc(16); m.store(offset(p, 2), T.int, 1); },
    "use-of-uninitialized-value": (m) => { main(m, [{ name: "x", type: T.int }]); m.get("x"); },
    "double-free": (m) => { main(m); const p = m.malloc(8); m.free(p); m.free(p); },
    "invalid-free": (m) => { main(m, [{ name: "x", type: T.int }]); m.free(m.addrOf("x")); const p = m.malloc(32); m.free(offset(p, 8)); },
    "memory-leak": (m) => { main(m); m.malloc(24); m.exit(0); },
    "stack-overflow": (m) => { for (let i = 0; i < 20; i++) m.call("f", [{ name: "buf", type: array(T.char, 1000) }]); },
  };

  for (const kind of UB_KINDS) {
    test(kind, () => {
      const m = new Machine({ stackLimit: 16 * 1024 });
      programs[kind](m);
      expect(new Set(kinds(m))).toEqual(new Set([kind]));
      const r = m.ub[0]!;
      expect(r.message.length).toBeGreaterThan(0);
      expect(m.trace.find((e) => e.ub === r)).toBeDefined();
    });
  }

  test("a clean program reports nothing, including at exit", () => {
    const m = new Machine();
    const S = struct("S", [["c", T.char], ["i", T.int], ["s", T.short]]);
    const head = m.global("head", ptr(T.int));
    main(m, [{ name: "s", type: S }, { name: "p", type: ptr(T.int) }, { name: "n", type: T.int, value: 3 }]);
    m.set("s", { c: 65, i: 7, s: 3 });
    const p = m.malloc(4 * m.sizeOf(T.int));
    for (let i = 0; i < 4; i++) m.store(offset(p, 4 * i), T.int, i * i);
    m.set("p", p);
    const q = m.realloc(m.get("p") as Ptr, 64);
    m.set("p", q);
    expect(m.load(offset(q, 12), T.int)).toBe(9);
    m.store(head, ptr(T.int), m.malloc(8));
    m.free(q);
    m.free(NULL);
    m.exit(0);
    expect(m.ub).toEqual([]);
  });

  test("the reports read like the sanitizers", () => {
    const m = new Machine();
    main(m);
    const p = m.malloc(16);
    m.free(p);
    m.load(p, T.int);
    expect(m.ub[0]).toMatchObject({
      tool: "AddressSanitizer", message: "heap-use-after-free on address 0x405010", access: "READ of size 4 at 0x405010",
      note: "0x405010 is located 0 bytes inside of 16-byte region [0x405010,0x405020), freed at step 2.",
    });
  });

  test("onUB: throw stops at the first report", () => {
    const m = new Machine({ onUB: "throw" });
    main(m);
    const p = m.malloc(4);
    m.free(p);
    expect(() => m.load(p, T.int)).toThrow(UbError);
    expect(kinds(m)).toEqual(["heap-use-after-free"]);
  });

  test("provenance: an overflow into a neighbour is caught, and the hardware view shows the write", () => {
    const m = new Machine();
    main(m, [{ name: "arr", type: array(T.int, 4) }, { name: "sum", type: T.int, value: 0 }, { name: "i", type: T.int }]);
    const arr = m.addrOf("arr"), sum = m.addrOf("sum");
    expect(sum.addr - arr.addr).toBe(16);
    for (let i = 0; i <= 4; i++) m.store(offset(arr, 4 * i), T.int, i);
    expect(kinds(m)).toEqual(["stack-buffer-overflow"]);
    expect(m.get("sum")).toBe(4); // the off-by-one store landed in sum
  });

  test("a pointer to freed memory reads the new owner's data after reuse (rawLoad and load)", () => {
    const m = new Machine();
    main(m);
    const a = m.malloc(16);
    m.store(a, T.int, 1);
    m.free(a);
    expect(m.rawLoad(a, T.int)).toBe(1); // free leaves the bytes
    const b = m.malloc(16);
    expect(b.addr).toBe(a.addr);
    m.store(b, T.int, 99);
    expect(m.load(a, T.int)).toBe(99);
    expect(kinds(m)).toEqual(["heap-use-after-free"]);
  });

  test("uninitialized padding: field stores leave it uninitialized, memcpy copies the init bits", () => {
    const m = new Machine();
    const S = struct("S", [["c", T.char], ["i", T.int], ["s", T.short]]);
    main(m, [{ name: "s", type: S }, { name: "t", type: S }]);
    const s = m.addrOf("s");
    m.store(m.field(s, S, "c"), T.char, 65);
    m.store(m.field(s, S, "i"), T.int, 7);
    m.store(m.field(s, S, "s"), T.short, 3);
    expect(m.peek(s.addr, 12).init).toEqual([true, false, false, false, true, true, true, true, true, true, false, false]);
    m.memcpy(m.addrOf("t"), s, 12);
    expect(m.peek(m.addrOf("t").addr, 12).init).toEqual(m.peek(s.addr, 12).init);
    expect(m.get("t")).toEqual({ c: 65, i: 7, s: 3 }); // padding is not a value byte: no report
    expect(m.ub).toEqual([]);
    m.load(offset(s, 1), T.char); // but reading a padding byte as a char is
    expect(kinds(m)).toEqual(["use-of-uninitialized-value"]);
  });
});

describe("stack frames", () => {
  test("x86-64 frame layout: return address, saved rbp, locals, 16-byte alignment", () => {
    const m = new Machine();
    m.call("main", [{ name: "p", type: ptr(T.int) }, { name: "y", type: T.int }]);
    m.call("f", [{ name: "c", type: T.char }, { name: "d", type: T.double }]);
    const [mainF, f] = m.snapshot().frames;
    expect(mainF!.hi).toBe(ADDR.stackStart);
    expect(mainF!.fp).toBe(ADDR.stackStart - 16);
    expect(mainF!.lo).toBe(ADDR.stackStart - 32);
    expect(f!.hi).toBe(mainF!.lo);
    expect(f!.savedFp).toBe(mainF!.fp);
    expect(f!.retAddr).toBe(m.fnAddr("main") + 0x0a);
    for (const fr of [mainF!, f!]) {
      expect(fr.fp % 16).toBe(0);
      expect(fr.lo % 16).toBe(0);
      expect(fr.slots.map((s) => s.kind)).toEqual(["ret", "fp", "local", "local"]);
      expect(fr.slots[0]!.addr).toBe(fr.fp + 8);
    }
    // locals in declaration order from the lowest address, laid out like a struct
    expect(f!.slots.slice(2).map((s) => [s.name, s.addr - f!.lo])).toEqual([["d", 8], ["c", 0]]);
    expect(hex(f!.fp)).toBe("0x7fffffffdfd0");
  });

  test("ret pops; the next call reuses the bytes; popped frames show until reused", () => {
    const m = new Machine();
    m.call("main");
    m.call("a", [{ name: "x", type: T.int, value: 5 }]);
    const x = m.addrOf("x");
    m.ret();
    expect(m.snapshot().frames.map((f) => [f.fn, f.live])).toEqual([["main", true], ["a", false]]);
    m.call("b", [{ name: "y", type: T.int }]);
    expect(m.addrOf("y").addr).toBe(x.addr);
    expect(m.snapshot().frames.map((f) => [f.fn, f.live])).toEqual([["main", true], ["b", true]]);
    expect(m.rawLoad(m.addrOf("y"), T.int)).toBe(5); // the stale value is still there
    expect(m.snapshot().frames[1]!.slots[2]!.text).toBe("?"); // but it is uninitialized
  });

  test("a stack slot that points into a returned frame is marked dangling", () => {
    const m = new Machine();
    m.call("main", [{ name: "p", type: ptr(T.int) }]);
    m.call("make", [{ name: "x", type: T.int, value: 42 }]);
    const px = m.addrOf("x");
    m.ret();
    m.set("p", px);
    const slot = m.snapshot().frames[0]!.slots.find((s) => s.name === "p")!;
    expect([slot.dangling, slot.text]).toEqual([true, hex(px.addr)]);
  });
});

describe("heap allocator", () => {
  test("first block at heap base + 16, 16-byte aligned; first fit; split and coalesce", () => {
    const m = new Machine();
    main(m);
    const a = m.malloc(10), b = m.malloc(40), c = m.malloc(1);
    expect([a.addr, b.addr, c.addr].map(hex)).toEqual(["0x405010", "0x405030", "0x405070"]);
    m.free(b);
    const d = m.malloc(20); // first fit: the hole left by b, split
    expect(d.addr).toBe(b.addr);
    m.free(a);
    m.free(d);
    // a and d coalesce with the rest of b's hole into one free block
    expect(m.heapBlocks().map((x) => [x.start - ADDR.heap, x.size, x.free])).toEqual([[0, 96, true], [96, 32, false]]);
    expect(m.malloc(32, 64).addr % 64).toBe(0);
  });

  test("invariants hold through 3,000 random operations", () => {
    const m = new Machine();
    main(m);
    const r = mulberry32(11);
    const live: Ptr[] = [];
    for (let k = 0; k < 3000; k++) {
      if (live.length === 0 || r() < 0.55) {
        const p = r() < 0.1 ? m.malloc(1 + Math.floor(r() * 200), 64) : m.malloc(Math.floor(r() * 300));
        live.push(p);
      } else if (r() < 0.2) {
        const i = Math.floor(r() * live.length);
        live[i] = m.realloc(live[i]!, 1 + Math.floor(r() * 400));
      } else {
        m.free(live.splice(Math.floor(r() * live.length), 1)[0]!);
      }
      if (k % 100 === 0 || k === 2999) {
        const blocks = m.heapBlocks();
        let at = ADDR.heap;
        for (const [i, b] of blocks.entries()) {
          expect(b.start).toBe(at); // contiguous, no gaps, no overlap
          expect(b.size % 16).toBe(0);
          if (i > 0) expect(b.free && blocks[i - 1]!.free).toBe(false); // free neighbours are merged
          if (!b.free) {
            const a = m.alloc(b.alloc)!;
            expect(a.live).toBe(true);
            expect(a.addr % 16).toBe(0);
            expect(a.addr - b.start).toBe(HEAP_HEADER);
            expect(a.size).toBeLessThanOrEqual(b.size - HEAP_HEADER);
          }
          at += b.size;
        }
        expect(blocks.filter((b) => !b.free).length).toBe(live.length);
      }
    }
    expect(m.ub).toEqual([]);
  });

  test("realloc: a new allocation every time; in place when it fits, else moved with the data", () => {
    const m = new Machine();
    main(m);
    const p = m.malloc(20); // capacity 32
    m.store(p, T.int, 7);
    const q = m.realloc(p, 30);
    expect([q.addr === p.addr, q.alloc === p.alloc]).toEqual([true, false]);
    m.load(p, T.int);
    expect(kinds(m)).toEqual(["heap-use-after-free"]);
    m.malloc(8); // a neighbour, so the block cannot grow
    const r = m.realloc(q, 100);
    expect(r.addr).not.toBe(q.addr);
    expect(m.load(r, T.int)).toBe(7);
    expect(m.realloc(r, 0)).toEqual(NULL);
  });

  test("calloc zeroes; allocNamed names objects; pointers between blocks become edges", () => {
    const m = new Machine();
    const Node = struct("Node", [["val", T.int], ["next", ptr()]]);
    const root = m.global("root", ptr());
    const a = m.allocNamed("Node", "a", { type: Node });
    const b = m.allocNamed("Node", "b", { type: Node });
    m.store(root, ptr(), a);
    m.store(m.field(a, Node, "next"), ptr(), b);
    expect(m.load(m.field(b, Node, "next"), ptr())).toEqual({ addr: 0 });
    const s = m.snapshot();
    expect(s.heap.map((h) => [h.label, h.objKind, h.state])).toEqual([["a", "Node", "live"], ["b", "Node", "live"]]);
    expect(s.edges.map((e) => [e.fromName, e.to])).toEqual([["root", a.alloc], ["a+8", b.alloc]]);
    m.free(b);
    expect(m.snapshot().edges.find((e) => e.to === b.alloc)!.dangling).toBe(true);
    const z = m.calloc(4, 4);
    expect(m.load(offset(z, 12), T.int)).toBe(0);
  });
});

describe("leaks at exit (LeakSanitizer rules)", () => {
  test("reachable from a global: not a leak; unreachable: direct; reachable only from a leak: indirect", () => {
    const m = new Machine();
    const keep = m.global("keep", ptr());
    main(m, [{ name: "local", type: ptr() }]);
    m.store(keep, ptr(), m.malloc(8));
    const lost = m.malloc(16);
    m.set("local", lost); // only a stack slot points to it: gone after exit pops main
    m.store(lost, ptr(), m.malloc(24));
    m.exit(0);
    expect(m.ub.map((u) => u.note)).toEqual([
      "Direct leak of 16 byte(s) in 1 object(s) allocated at step 4 (malloc(16)).",
      "Indirect leak of 24 byte(s) in 1 object(s) allocated at step 6 (malloc(24)).",
    ]);
    expect(m.snapshot().heap.map((h) => h.state)).toEqual(["live", "leaked", "leaked"]);
    expect(() => m.malloc(1)).toThrow();
  });
});

describe("other segments", () => {
  test("globals: .data with a value, .bss zeroed; literals in .rodata; functions in .text", () => {
    const m = new Machine();
    const g = m.global("g", T.int, 5);
    const z = m.global("z", array(T.long, 2));
    const s = m.literal("hello");
    expect([hex(g.addr), hex(z.addr), hex(s.addr), hex(m.fnAddr("_start")), hex(m.fnAddr("main"))]).toEqual(["0x403000", "0x404000", "0x402000", "0x401000", "0x401040"]);
    expect(m.load(z, array(T.long, 2))).toEqual([0, 0]);
    expect(m.load(offset(s, 5), T.char)).toBe(0);
    const names = m.snapshot().segments.map((x) => x.name);
    expect(names).toEqual(["text", "rodata", "data", "bss", "heap", "mmap", "stack"]);
  });

  test("mmap is page-rounded and zeroed; an access after munmap is a segv", () => {
    const m = new Machine();
    const p = m.mmap(5000);
    expect(p.addr).toBe(ADDR.mmapTop - 8192);
    expect(m.load(offset(p, 4999), T.char)).toBe(0);
    m.munmap(p);
    expect(m.rawLoad(p, T.char)).toBeUndefined();
    m.load(p, T.char);
    expect(kinds(m)).toEqual(["segv"]);
  });

  test("64-bit integers, floats and pointers round-trip in little-endian bytes", () => {
    const m = new Machine();
    main(m);
    const p = m.malloc(32);
    m.store(p, T.u64, 2n ** 63n + 5n);
    expect(m.load(p, T.u64)).toBe(2n ** 63n + 5n);
    expect(m.peek(p.addr, 8).bytes).toEqual([5, 0, 0, 0, 0, 0, 0, 0x80]);
    m.store(p, T.i64, -2);
    expect(m.load(p, T.i64)).toBe(-2);
    m.store(offset(p, 8), T.double, 1.5);
    expect(m.load(offset(p, 8), T.double)).toBe(1.5);
    m.store(offset(p, 16), T.char, -1);
    expect(m.load(offset(p, 16), T.char)).toBe(-1); // char is signed on x86-64
    expect(m.load(offset(p, 16), T["unsigned char"])).toBe(255);
  });
});

describe("determinism and speed", () => {
  const script = (m: Machine) => {
    const r = mulberry32(5);
    main(m, [{ name: "x", type: T.int }]);
    const live: Ptr[] = [];
    for (let i = 0; i < 400; i++) {
      if (r() < 0.6 || !live.length) live.push(m.malloc(Math.floor(r() * 100)));
      else m.free(live.splice(Math.floor(r() * live.length), 1)[0]!);
      if (live.length && r() < 0.3) m.load(live[0]!, T.char);
    }
    m.exit(0);
  };

  test("the same operations give the same trace and snapshot", () => {
    const a = new Machine(), b = new Machine();
    script(a);
    script(b);
    expect(JSON.stringify(a.trace)).toBe(JSON.stringify(b.trace));
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
  });

  test("100,000 operations take well under a second", () => {
    const t0 = performance.now();
    const m = new Machine();
    main(m);
    const live: Ptr[] = [];
    let ops = 0;
    for (let k = 0; ops < 100_000; k++) {
      if (live.length < 64 || k % 3) { const p = m.malloc(8 + ((k * 37) % 120)); live.push(p); m.store(p, T.int, k); ops += 2; }
      const j = (k * 7919) % live.length;
      m.load(live[j]!, T.int);
      ops++;
      if (k % 2) { m.free(live.splice(j, 1)[0]!); ops++; }
    }
    const ms = performance.now() - t0;
    expect(m.ub).toEqual([]);
    expect(ms).toBeLessThan(1000);
  });
});
