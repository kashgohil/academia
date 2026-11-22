/**
 * Type layout. Sources of the pinned numbers:
 * - "zig cc": `zig cc -target <triple> -S` (zig 0.17.1, clang) on probe files with sizeof, _Alignof and offsetof.
 *   A generator also emitted about 7,000 `_Static_assert`s per target from this model, for 1,000 random structs per
 *   seed and three seeds (#pragma pack, __attribute__((packed)), aligned fields and structs, unions, nested structs,
 *   arrays); all passed on all six targets.
 * - rustc: 1,194 random size/align checks (repr(Rust), repr(C), packed, align, Option) all passed; repr(Rust) offsets
 *   differ from the model in 83 of about 300 structs (niche and small-array placement), as layout.ts says.
 * - "rustc": rustc 1.96.1 `--target x86_64-unknown-none` with `const _: () = assert!(size_of / offset_of ...)`.
 * - The psABI tables named in TARGETS[...].source agree with every scalar row.
 */
import { describe, expect, test } from "vitest";
import {
  array, box, byteOwners, layoutC, layoutRust, nonzero, optimalOrder, option, ptr, ref, struct, T, TARGET_IDS, TARGETS, union, wasted,
  type FieldDecl, type ScalarName, type TargetId, type Type,
} from "../../src/sims/sys/mem";
import { mulberry32 } from "../../src/sims/rng";

const lay = (t: Type, target: TargetId = "x86_64-linux") => layoutC(t, target);
const offsets = (t: Type, target: TargetId = "x86_64-linux") => Object.fromEntries(lay(t, target).fields.map((f) => [f.name, f.offset]));

describe("scalars on six targets (zig cc; psABI tables)", () => {
  // [size, align] of: char short int long "long long" void* size_t float double "long double"
  const table: Record<TargetId, number[][]> = {
    "x86_64-linux": [[1, 1], [2, 2], [4, 4], [8, 8], [8, 8], [8, 8], [8, 8], [4, 4], [8, 8], [16, 16]],
    "aarch64-linux": [[1, 1], [2, 2], [4, 4], [8, 8], [8, 8], [8, 8], [8, 8], [4, 4], [8, 8], [16, 16]],
    "x86_64-windows": [[1, 1], [2, 2], [4, 4], [4, 4], [8, 8], [8, 8], [8, 8], [4, 4], [8, 8], [8, 8]],
    "i386-linux": [[1, 1], [2, 2], [4, 4], [4, 4], [8, 4], [4, 4], [4, 4], [4, 4], [8, 4], [12, 4]],
    "riscv64-linux": [[1, 1], [2, 2], [4, 4], [8, 8], [8, 8], [8, 8], [8, 8], [4, 4], [8, 8], [16, 16]],
    "riscv32-linux": [[1, 1], [2, 2], [4, 4], [4, 4], [8, 8], [4, 4], [4, 4], [4, 4], [8, 8], [16, 16]],
  };
  const names: (ScalarName | "void*")[] = ["char", "short", "int", "long", "long long", "void*", "size_t", "float", "double", "long double"];
  for (const id of TARGET_IDS) {
    test(id, () => {
      const got = names.map((n) => {
        const l = lay(n === "void*" ? ptr() : T[n], id);
        return [l.size, l.align];
      });
      expect(got).toEqual(table[id]);
    });
  }

  test("char signedness and alignof(max_align_t) (zig cc)", () => {
    expect(TARGET_IDS.map((id) => TARGETS[id].charSigned)).toEqual([true, false, true, true, false, false]);
    // i386: clang says 8; GCC 7+ says 16 (it adds __float128). The model follows clang, which zig cc runs.
    expect(TARGET_IDS.map((id) => TARGETS[id].maxAlign)).toEqual([16, 16, 8, 8, 16, 16]);
  });
});

describe("C structs", () => {
  const S = struct("S", [["c", T.char], ["i", T.int], ["s", T.short]]);

  test("struct S { char c; int i; short s; }: 12 bytes on every target, 5 of them padding", () => {
    for (const id of TARGET_IDS) {
      expect(lay(S, id).size).toBe(12);
      expect(offsets(S, id)).toEqual({ c: 0, i: 4, s: 8 });
    }
    expect(lay(S).holes).toEqual([{ offset: 1, size: 3, reason: "align", before: "i" }, { offset: 10, size: 2, reason: "tail" }]);
    expect(wasted(lay(S))).toBe(5);
  });

  test("double, long long and long double after a char differ by target (zig cc)", () => {
    const D = struct("D", [["c", T.char], ["x", T.double]]);
    const LL = struct("LL", [["c", T.char], ["x", T["long long"]]]);
    const LD = struct("LD", [["c", T.char], ["x", T["long double"]]]);
    const L = struct("L", [["c", T.char], ["x", T.long]]);
    const row = (t: Type) => TARGET_IDS.map((id) => [offsets(t, id).x, lay(t, id).size]);
    //                x86_64-linux aarch64   windows  i386     rv64     rv32
    expect(row(D)).toEqual([[8, 16], [8, 16], [8, 16], [4, 12], [8, 16], [8, 16]]);
    expect(row(LL)).toEqual([[8, 16], [8, 16], [8, 16], [4, 12], [8, 16], [8, 16]]);
    expect(row(LD)).toEqual([[16, 32], [16, 32], [8, 16], [4, 16], [16, 32], [16, 32]]);
    expect(row(L)).toEqual([[8, 16], [8, 16], [4, 8], [4, 8], [8, 16], [4, 8]]);
  });

  test("nested structs, arrays and deep padding", () => {
    const P = struct("P", [["x", T.char], ["y", T.int]]);
    const N = struct("N", [["a", T.char], ["p", P], ["z", array(T.short, 2)]]);
    const l = lay(N);
    expect([l.size, l.align, offsets(N).p, offsets(N).z]).toEqual([16, 4, 4, 12]);
    expect(wasted(l)).toBe(3);
    expect(wasted(l, true)).toBe(6);
    const owners = byteOwners(l).map((o) => (o.pad ? "_" : o.path));
    expect(owners).toEqual(["a", "_", "_", "_", "p.x", "_", "_", "_", "p.y", "p.y", "p.y", "p.y", "z[0]", "z[0]", "z[1]", "z[1]"]);
    // a long array is one value region
    expect(byteOwners(lay(array(T.char, 100))).every((o) => !o.pad)).toBe(true);
  });

  test("unions put every field at 0 and round the size up", () => {
    const U = union("U", [["c", array(T.char, 5)], ["i", T.int]]);
    const l = lay(U);
    expect([l.size, l.align]).toEqual([8, 4]);
    expect(l.fields.map((f) => f.offset)).toEqual([0, 0]);
    expect(l.holes).toEqual([{ offset: 5, size: 3, reason: "tail" }]);
  });

  test("#pragma pack and __attribute__((packed)) (zig cc)", () => {
    const P1 = struct("P1", [["c", T.char], ["i", T.int], ["s", T.short]], { pack: 1 });
    expect([lay(P1).size, lay(P1).align, offsets(P1).i, offsets(P1).s]).toEqual([7, 1, 1, 5]);
    const P2 = struct("P2", [["c", T.char], ["d", T.double]], { pack: 2 });
    for (const id of TARGET_IDS) expect([offsets(P2, id).d, lay(P2, id).size, lay(P2, id).align]).toEqual([2, 10, 2]);
  });

  test("alignas inside a packed struct: GCC/clang cap it with #pragma pack, MSVC does not (zig cc)", () => {
    const PP = struct("PP", [["c", T.char], ["x", T.int, 8]], { pack: 2 });
    expect([offsets(PP).x, lay(PP).size, lay(PP).align]).toEqual([2, 6, 2]);
    expect([offsets(PP, "x86_64-windows").x, lay(PP, "x86_64-windows").size, lay(PP, "x86_64-windows").align]).toEqual([8, 16, 8]);
  });

  test("__attribute__((packed)): alignment 1, but a member's own aligned attribute survives (zig cc)", () => {
    const A16 = struct("A16", [["c", T.char]], { align: 16 });
    const I = struct("I", [["c", T.char], ["x", T.int, 16]]);
    const cases = [
      struct("Q1", [["c", T.char], ["a", A16]], { packed: true }),
      struct("Q2", [["c", T.char], ["i", I]], { packed: true }),
      struct("Q3", [["c", T.char], ["x", T.int, 8]], { packed: true }),
      struct("Q4", [["c", T.char], ["d", T.double], ["x", T.int, 4]], { packed: true }),
    ];
    const row = (id: TargetId) => cases.map((t) => [lay(t, id).fields.at(-1)!.offset, lay(t, id).size, lay(t, id).align]);
    expect(row("x86_64-linux")).toEqual([[1, 17, 1], [1, 33, 1], [8, 16, 8], [12, 16, 4]]);
    expect(row("i386-linux")).toEqual([[1, 17, 1], [1, 33, 1], [8, 16, 8], [12, 16, 4]]);
    expect(row("x86_64-windows")).toEqual([[16, 32, 16], [16, 48, 16], [8, 16, 8], [12, 16, 4]]);
  });

  test("alignas on a struct and on a field", () => {
    const AL = struct("AL", [["c", T.char]], { align: 16 });
    expect([lay(AL).size, lay(AL).align]).toEqual([16, 16]);
    const F = struct("F", [["c", T.char], ["v", T.float, 16]]);
    expect([offsets(F).v, lay(F).size, lay(F).align]).toEqual([16, 32, 16]);
    expect(() => lay(struct("X", [["c", T.char]], { align: 3 }))).toThrow();
  });
});

describe("optimalOrder", () => {
  test("char, double, char, int: 24 bytes as declared, 16 sorted", () => {
    const fields: FieldDecl[] = [{ name: "a", type: T.char }, { name: "b", type: T.double }, { name: "c", type: T.char }, { name: "d", type: T.int }];
    expect(lay(struct("A", fields)).size).toBe(24);
    const best = optimalOrder(fields);
    expect(best.map((f) => f.name)).toEqual(["b", "d", "a", "c"]);
    expect(lay(struct("B", best)).size).toBe(16);
  });

  test("on random structs it reaches the lower bound: sum of sizes rounded up to the alignment", () => {
    const r = mulberry32(3);
    const pool: Type[] = [T.char, T.short, T.int, T.long, T.double, T.float, ptr(), array(T.char, 3), array(T.short, 3), struct("Q", [["a", T.int], ["b", T.char]])];
    for (const id of TARGET_IDS) {
      for (let k = 0; k < 200; k++) {
        const fields: FieldDecl[] = Array.from({ length: 1 + Math.floor(r() * 7) }, (_, i) => ({ name: `f${i}`, type: pool[Math.floor(r() * pool.length)]! }));
        const decl = lay(struct("D", fields), id);
        const best = lay(struct("O", optimalOrder(fields, id)), id);
        const sum = decl.fields.reduce((s, f) => s + f.size, 0);
        expect(best.size).toBe(Math.ceil(sum / decl.align) * decl.align);
        expect(best.size).toBeLessThanOrEqual(decl.size);
        expect(best.fields.slice(0, -1).every((f, i) => f.offset + f.size === best.fields[i + 1]!.offset)).toBe(true);
      }
    }
  });
});

describe("Rust layout (rustc 1.96.1, x86_64-unknown-none)", () => {
  test("repr(Rust) model: sort by decreasing alignment", () => {
    const A = struct("A", [["a", T.u8], ["b", T.u32], ["c", T.u16]], { repr: "Rust" });
    expect([layoutRust(A).size, layoutRust(A).fields.map((f) => [f.name, f.offset])]).toEqual([8, [["b", 0], ["c", 4], ["a", 6]]]);
    const E = struct("E", [["a", T.u16], ["b", T.u64], ["c", T.u8], ["d", T.u32]], { repr: "Rust" });
    expect(layoutRust(E).fields.map((f) => [f.name, f.offset])).toEqual([["b", 0], ["d", 8], ["a", 12], ["c", 14]]);
    expect(layoutRust(E).size).toBe(16);
    // repr(C) keeps the declaration order: 24 bytes.
    expect(layoutRust({ ...E, repr: "C" } as Type).size).toBe(24);
  });

  test("where the model and rustc differ: the size matches, the offsets do not", () => {
    // rustc 1.96 puts the [u8; 4] first (it treats it like a 4-aligned field): b 0, c 4, d 8, a 10.
    const D = struct("D", [["a", T.u8], ["b", array(T.u8, 4)], ["c", T.u32], ["d", T.u16]], { repr: "Rust" });
    expect(layoutRust(D).size).toBe(12);
    expect(Object.fromEntries(layoutRust(D).fields.map((f) => [f.name, f.offset]))).toEqual({ c: 0, d: 4, a: 6, b: 7 });
  });

  test("repr(packed) and repr(align)", () => {
    const P = struct("P", [["a", T.u8], ["b", T.u32], ["c", T.u16]], { repr: "C", pack: 1 });
    expect([layoutRust(P).size, layoutRust(P).align]).toEqual([7, 1]);
    const AL = struct("AL", [["a", T.u8]], { repr: "C", align: 16 });
    expect([layoutRust(AL).size, layoutRust(AL).align]).toEqual([16, 16]);
  });

  test("Option and the niche", () => {
    const size = (t: Type) => layoutRust(t).size;
    expect(size(option(ref(T.u32)))).toBe(8);
    expect(size(option(box(T.u8)))).toBe(8);
    expect(size(option(nonzero("u32")))).toBe(4);
    expect(size(option(T.u32))).toBe(8);
    expect(size(option(T.u64))).toBe(16);
    expect(size(option(T.bool))).toBe(1);
    expect(size(option(T.char32))).toBe(4);
    expect(size(option(option(T.u32)))).toBe(8);
    expect(size(option(array(T.u8, 3)))).toBe(4);
    expect(size(option(option(ref(T.u8))))).toBe(16);
    expect(size(option(option(T.bool)))).toBe(1);
    // a struct with a reference inside has a niche too
    expect(size(option(struct("W", [["a", T.u8], ["r", ref(T.u64)]], { repr: "Rust" })))).toBe(16);
    expect(layoutRust(option(T.u32)).fields.map((f) => [f.name, f.offset])).toEqual([["tag", 0], ["Some", 4]]);
    expect(layoutRust(option(ref(T.u32))).rules).toBe("Rust niche");
  });
});
