/**
 * Type layout: the size, the alignment and the field offsets of C and Rust types on six target ABIs.
 *
 * The type language is small: scalars (C names such as `long` and fixed-width names such as `u32`), pointers,
 * fixed arrays, structs, unions, `NonZero` integers and Rust's `Option<T>`. A struct can carry `#pragma pack(n)` or
 * Rust's `repr(packed(n))` (`pack: n`), GCC's `__attribute__((packed))` (`packed: true`), `alignas(n)` /
 * `__attribute__((aligned(n)))` on the struct (`align`) and on a field (`FieldDecl.align`), and a Rust
 * representation (`repr: "C"` or `"Rust"`).
 *
 * C rules (`layoutC`, and `repr(C)` in `layoutRust`), as in the psABIs:
 * - Each field goes at the next offset that is a multiple of its alignment, in declaration order.
 * - The alignment of a field is the alignment of its type, raised by `alignas(n)` on the field, then capped by
 *   `pack`. On the MSVC target an explicit alignment (alignas on the field, or anywhere inside the field's type) is
 *   not capped by pack: it wins (Target.alignasBeatsPack; checked with clang's MSVC mode).
 * - `packed: true` (GCC and clang): a field's alignment is 1, unless the field itself has an aligned attribute, which
 *   it keeps. An alignment inside the field's type does not count. On MSVC it acts as `pack: 1`.
 * - The struct alignment is the largest field alignment, raised by `alignas(n)` on the struct.
 * - The size is rounded up to a multiple of the struct alignment. The bytes that this adds are the tail padding.
 * - A union puts every field at offset 0. Its size is the largest field size, rounded up to its alignment.
 *
 * Rust rules (`layoutRust`):
 * - `repr(C)` uses the C rules. `repr(packed(n))` and `repr(align(n))` map to `pack` and `align`.
 * - The default `repr(Rust)` has NO specified field order (Rust Reference, "Type layout", "The Rust
 *   Representation": "There are no guarantees of data layout made by this representation"). This file MODELS what
 *   rustc does today: it sorts the fields by decreasing alignment (a stable sort, so equal alignments keep their
 *   order). That always gives the smallest size. It is a model of current behaviour, not a guarantee: rustc 1.96 also
 *   moves fields with a niche and groups small arrays, so its offsets can differ from the model (sizes do not).
 * - `Option<T>` uses a niche when T has one: `Option<&T>`, `Option<Box<T>>`, `Option<NonZeroU32>`, `Option<bool>` and
 *   `Option<char>` have the size of T (None is a bit pattern that T can never hold, such as the null pointer).
 *   Without a niche, Option adds a 1-byte tag at offset 0 and puts the value at the next multiple of its alignment.
 *   The tag's unused values are a niche of their own, so `Option<Option<u32>>` is still 8 bytes.
 *
 * Every size and alignment in TARGETS was checked with `zig cc -target <triple>` (zig 0.17.1, clang) and matches the
 * psABI tables named in Target.source. tests/unit/sys-mem-layout.test.ts pins a table of them.
 *
 * Not modelled: bit-fields, flexible array members, zero-sized types, `_BitInt`, `__int128`, C++ empty bases and
 * `[[no_unique_address]]`, vtable pointers, Rust enums other than Option, and Rust's `repr(u8)` enums.
 */

// ---------------------------------------------------------------- the type language

/** C names (with spaces, as written in C) and fixed-width names. `char32` is Rust's 4-byte `char`. */
export type ScalarName =
  | "bool" | "char" | "signed char" | "unsigned char" | "short" | "unsigned short" | "int" | "unsigned"
  | "long" | "unsigned long" | "long long" | "unsigned long long" | "size_t" | "ptrdiff_t" | "intptr_t" | "uintptr_t"
  | "float" | "double" | "long double"
  | "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "i64" | "u64" | "isize" | "usize" | "f32" | "f64" | "char32";

export interface FieldDecl {
  name: string;
  type: Type;
  /** `alignas(n)` / `__attribute__((aligned(n)))` on this field. It can only raise the alignment. */
  align?: number;
}

/** Every type can carry a display `label`, for example "char" for `char32` in a Rust demo. */
export type Type =
  | { k: "scalar"; name: ScalarName; label?: string }
  /** `own`: "raw" is a C pointer or `*const T`; "ref" (`&T`) and "box" (`Box<T>`) are never null (a niche). */
  | { k: "ptr"; to?: Type; own?: "raw" | "ref" | "box"; label?: string }
  | { k: "nonzero"; of: ScalarName; label?: string }
  | { k: "array"; of: Type; n: number; label?: string }
  | { k: "struct"; name?: string; fields: FieldDecl[]; pack?: number; packed?: boolean; align?: number; repr?: "C" | "Rust"; label?: string }
  | { k: "union"; name?: string; fields: FieldDecl[]; pack?: number; packed?: boolean; align?: number; label?: string }
  | { k: "option"; of: Type; label?: string };

const sc = (name: ScalarName): Type => ({ k: "scalar", name });

/** Scalar types by name: `T.int`, `T["unsigned long"]`, `T.u8`. */
export const T = Object.fromEntries(
  ([
    "bool", "char", "signed char", "unsigned char", "short", "unsigned short", "int", "unsigned", "long", "unsigned long",
    "long long", "unsigned long long", "size_t", "ptrdiff_t", "intptr_t", "uintptr_t", "float", "double", "long double",
    "i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "isize", "usize", "f32", "f64", "char32",
  ] as ScalarName[]).map((n) => [n, sc(n)]),
) as Record<ScalarName, Type>;

/** A C pointer (`T *`) or a Rust raw pointer. */
export const ptr = (to?: Type): Type => ({ k: "ptr", to, own: "raw" });
/** A Rust reference `&T`: a pointer that is never null. */
export const ref = (to?: Type): Type => ({ k: "ptr", to, own: "ref" });
/** A Rust `Box<T>`: an owning pointer that is never null. */
export const box = (to?: Type): Type => ({ k: "ptr", to, own: "box" });
export const nonzero = (of: ScalarName): Type => ({ k: "nonzero", of });
export const array = (of: Type, n: number): Type => ({ k: "array", of, n });
export const option = (of: Type): Type => ({ k: "option", of });

type FieldInput = FieldDecl | [string, Type] | [string, Type, number];
const toField = (f: FieldInput): FieldDecl => (Array.isArray(f) ? { name: f[0], type: f[1], align: f[2] } : f);

/** A struct. Fields are `{ name, type, align? }` or `[name, type]` or `[name, type, alignas]`. */
export const struct = (name: string, fields: FieldInput[], opts: { pack?: number; packed?: boolean; align?: number; repr?: "C" | "Rust" } = {}): Type =>
  ({ k: "struct", name, fields: fields.map(toField), ...opts });
export const union = (name: string, fields: FieldInput[], opts: { pack?: number; packed?: boolean; align?: number } = {}): Type =>
  ({ k: "union", name, fields: fields.map(toField), ...opts });

// ---------------------------------------------------------------- targets

export type TargetId = "x86_64-linux" | "aarch64-linux" | "x86_64-windows" | "i386-linux" | "riscv64-linux" | "riscv32-linux";

export interface Target {
  id: TargetId;
  name: string;
  /** The triple used to check it with `zig cc -target`. */
  triple: string;
  /** The C data model: sizes of int, long and pointers. */
  model: "LP64" | "LLP64" | "ILP32";
  ptrBytes: number;
  longBytes: number;
  /** Alignment of `long long`, `int64_t`, `u64` and `i64` as struct members (4 on i386 System V). */
  i64Align: number;
  /** Alignment of `double` and `f64` as struct members (4 on i386 System V). */
  f64Align: number;
  longDouble: { size: number; align: number };
  /** `alignof(max_align_t)`: the alignment that malloc must give. */
  maxAlign: number;
  /** Plain `char` is signed (x86) or unsigned (Arm and RISC-V). */
  charSigned: boolean;
  /** MSVC rule: `alignas` on a field is applied after the `#pragma pack` cap, so it wins. */
  alignasBeatsPack: boolean;
  /** Where the numbers come from. */
  source: string;
}

/**
 * The six targets. All are little-endian. Each number was checked with `zig cc -target <triple> -S` on a probe file
 * (sizeof, _Alignof, offsetof), zig 0.17.1. Fact sources:
 * - x86-64 System V psABI, section 3.1.2 "Data Representation", Figure 3.1 "Scalar Types".
 * - AAPCS64 ("Procedure Call Standard for the Arm 64-bit Architecture"), "Fundamental Data Types" and the "Arm C and
 *   C++ Language Mappings" (plain char is unsigned; long double is a 128-bit IEEE quad).
 * - Microsoft Learn, "x64 ABI conventions" ("Types and storage") and "Data Type Ranges": long is 4 bytes; long double is
 *   the same as double. The MinGW target (x86_64-windows-gnu) differs: its long double is 16 bytes.
 * - System V ABI Intel386 Architecture Processor Supplement, "Fundamental Types": double and long long have 4-byte
 *   alignment; long double is 12 bytes with 4-byte alignment.
 * - RISC-V ELF psABI, "C/C++ type details" ("C/C++ type sizes and alignments"): LP64D and ILP32D; char is unsigned;
 *   long double is 16 bytes, 16-byte aligned on both.
 */
export const TARGETS: Record<TargetId, Target> = {
  "x86_64-linux": {
    id: "x86_64-linux", name: "x86-64 Linux (System V, LP64)", triple: "x86_64-linux-gnu", model: "LP64", ptrBytes: 8, longBytes: 8,
    i64Align: 8, f64Align: 8, longDouble: { size: 16, align: 16 }, maxAlign: 16, charSigned: true, alignasBeatsPack: false,
    source: "x86-64 psABI Figure 3.1; zig cc -target x86_64-linux-gnu",
  },
  "aarch64-linux": {
    id: "aarch64-linux", name: "AArch64 Linux (AAPCS64, LP64)", triple: "aarch64-linux-gnu", model: "LP64", ptrBytes: 8, longBytes: 8,
    i64Align: 8, f64Align: 8, longDouble: { size: 16, align: 16 }, maxAlign: 16, charSigned: false, alignasBeatsPack: false,
    source: "AAPCS64 Fundamental Data Types; zig cc -target aarch64-linux-gnu",
  },
  "x86_64-windows": {
    id: "x86_64-windows", name: "x86-64 Windows (MSVC, LLP64)", triple: "x86_64-windows-msvc", model: "LLP64", ptrBytes: 8, longBytes: 4,
    i64Align: 8, f64Align: 8, longDouble: { size: 8, align: 8 }, maxAlign: 8, charSigned: true, alignasBeatsPack: true,
    source: "Microsoft x64 ABI conventions; zig cc -target x86_64-windows-msvc",
  },
  "i386-linux": {
    id: "i386-linux", name: "i386 Linux (System V, ILP32)", triple: "x86-linux-gnu", model: "ILP32", ptrBytes: 4, longBytes: 4,
    // maxAlign: clang says 8 here (zig cc); GCC 7 and later say 16, because GCC adds __float128 to max_align_t.
    i64Align: 4, f64Align: 4, longDouble: { size: 12, align: 4 }, maxAlign: 8, charSigned: true, alignasBeatsPack: false,
    source: "i386 psABI Fundamental Types; zig cc -target x86-linux-gnu",
  },
  "riscv64-linux": {
    id: "riscv64-linux", name: "RV64 Linux (LP64D)", triple: "riscv64-linux-gnu", model: "LP64", ptrBytes: 8, longBytes: 8,
    i64Align: 8, f64Align: 8, longDouble: { size: 16, align: 16 }, maxAlign: 16, charSigned: false, alignasBeatsPack: false,
    source: "RISC-V psABI C/C++ type details; zig cc -target riscv64-linux-gnu",
  },
  "riscv32-linux": {
    id: "riscv32-linux", name: "RV32 Linux (ILP32D)", triple: "riscv32-linux-musl", model: "ILP32", ptrBytes: 4, longBytes: 4,
    i64Align: 8, f64Align: 8, longDouble: { size: 16, align: 16 }, maxAlign: 16, charSigned: false, alignasBeatsPack: false,
    source: "RISC-V psABI C/C++ type details; zig cc -target riscv32-linux-musl",
  },
};
export const TARGET_IDS = Object.keys(TARGETS) as TargetId[];

/** Size and alignment of a scalar on a target. */
export function scalarInfo(name: ScalarName, t: Target): { size: number; align: number; signed: boolean; float: boolean } {
  const p = t.ptrBytes;
  const int = (size: number, signed: boolean, align = size) => ({ size, align, signed, float: false });
  switch (name) {
    case "bool": return int(1, false);
    case "char": return int(1, t.charSigned);
    case "signed char": case "i8": return int(1, true);
    case "unsigned char": case "u8": return int(1, false);
    case "short": case "i16": return int(2, true);
    case "unsigned short": case "u16": return int(2, false);
    case "int": case "i32": return int(4, true);
    case "unsigned": case "u32": case "char32": return int(4, false);
    case "long": return int(t.longBytes, true, t.longBytes === 8 ? t.i64Align : t.longBytes);
    case "unsigned long": return int(t.longBytes, false, t.longBytes === 8 ? t.i64Align : t.longBytes);
    case "long long": case "i64": return int(8, true, t.i64Align);
    case "unsigned long long": case "u64": return int(8, false, t.i64Align);
    case "ptrdiff_t": case "intptr_t": case "isize": return int(p, true);
    case "size_t": case "uintptr_t": case "usize": return int(p, false);
    case "float": case "f32": return { size: 4, align: 4, signed: true, float: true };
    case "double": case "f64": return { size: 8, align: t.f64Align, signed: true, float: true };
    case "long double": return { ...t.longDouble, signed: true, float: true };
  }
}

// ---------------------------------------------------------------- results

export interface FieldLayout {
  name: string;
  type: Type;
  /** The type as text, for example "int", "char *", "double[3]", "struct Point". */
  typeName: string;
  offset: number;
  size: number;
  /** The alignment that placed the field (after alignas and pack). */
  align: number;
  /** Position in the declaration. Memory order and declaration order differ under repr(Rust). */
  decl: number;
  /** The layout of a nested struct, union, array or Option. */
  inner?: Layout;
}

/** Bytes that no field uses. "align": a gap before a field. "tail": the bytes at the end that round up the size. */
export interface Hole { offset: number; size: number; reason: "align" | "tail"; before?: string }

export interface Layout {
  typeName: string;
  size: number;
  align: number;
  /** Fields in memory order. A scalar or pointer has no fields. */
  fields: FieldLayout[];
  holes: Hole[];
  /** The rules used: "C", "C packed(1)", "Rust (model)", "Rust niche", "union", "scalar", ... */
  rules: string;
  /** Number of invalid bit patterns that Option can use (Rust). 0 means no niche. */
  niche: number;
  target: TargetId;
  /** The largest alignas/aligned value inside the type (1 if none). MSVC keeps it under `#pragma pack`. */
  reqAlign: number;
  /** Arrays: the layout of one element and the element count. `fields` lists the elements only when count <= 64. */
  elem?: Layout;
  count?: number;
}

// ---------------------------------------------------------------- names

/** The type as C or Rust text. */
export function typeName(t: Type): string {
  if (t.label) return t.label;
  switch (t.k) {
    case "scalar": return t.name;
    case "ptr": {
      const to = t.to ? typeName(t.to) : t.own === "raw" ? "void" : "T";
      return t.own === "ref" ? `&${to}` : t.own === "box" ? `Box<${to}>` : `${to} *`;
    }
    case "nonzero": return `NonZero<${t.of}>`;
    case "array": return `${typeName(t.of)}[${t.n}]`;
    case "struct": return t.name ? (t.repr ? t.name : `struct ${t.name}`) : "struct";
    case "union": return t.name ? `union ${t.name}` : "union";
    case "option": return `Option<${typeName(t.of)}>`;
  }
}

// ---------------------------------------------------------------- layout

const alignUp = (x: number, a: number) => Math.ceil(x / a) * a;
const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
const CHAR_NICHE = 2 ** 32 - 0x110000;
const MAX_ELEMS = 64;

type Mode = "C" | "Rust";

function scalarLayout(t: Type, size: number, align: number, niche: number, target: Target, rules = "scalar"): Layout {
  return { typeName: typeName(t), size, align, fields: [], holes: [], rules, niche, target: target.id, reqAlign: 1 };
}

function layoutOf(t: Type, target: Target, mode: Mode): Layout {
  switch (t.k) {
    case "scalar": {
      const s = scalarInfo(t.name, target);
      const niche = t.name === "bool" ? 254 : t.name === "char32" ? CHAR_NICHE : 0;
      return scalarLayout(t, s.size, s.align, mode === "Rust" ? niche : 0, target);
    }
    case "nonzero": {
      const s = scalarInfo(t.of, target);
      return scalarLayout(t, s.size, s.align, 1, target);
    }
    case "ptr":
      return scalarLayout(t, target.ptrBytes, target.ptrBytes, t.own === "raw" || t.own === undefined ? 0 : 1, target, "pointer");
    case "array": {
      const e = layoutOf(t.of, target, mode);
      // Element fields only for short arrays, so `char buf[4096]` stays cheap. `elem` always describes one element.
      const fields: FieldLayout[] = [];
      if (t.n <= MAX_ELEMS) for (let i = 0; i < t.n; i++) fields.push({ name: `[${i}]`, type: t.of, typeName: e.typeName, offset: i * e.size, size: e.size, align: e.align, decl: i, inner: e.fields.length ? e : undefined });
      return { typeName: typeName(t), size: e.size * t.n, align: e.align, fields, holes: [], rules: "array", niche: t.n > 0 ? e.niche : 0, target: target.id, reqAlign: e.reqAlign, elem: e, count: t.n };
    }
    case "struct":
      return structLayout(t, target, mode === "Rust" && t.repr !== "C" ? "Rust" : "C", mode);
    case "union":
      return unionLayout(t, target, mode);
    case "option":
      return optionLayout(t, target);
  }
}

/**
 * The alignment that places a field: its type's, raised by alignas, capped by pack. On MSVC an explicit alignment
 * (alignas on the field, or `reqAlign` from inside its type) is not capped by pack.
 */
function fieldAlign(natural: number, alignas: number | undefined, pack: number | undefined, target: Target, req = 1, packed = false): number {
  if (alignas !== undefined && !isPow2(alignas)) throw new Error(`alignas(${alignas}) is not a power of two`);
  if (pack !== undefined && !isPow2(pack)) throw new Error(`pack(${pack}) is not a power of two`);
  if (packed) {
    if (target.alignasBeatsPack) pack = Math.min(pack ?? 1, 1);
    else return alignas ?? 1;
  }
  const raised = Math.max(natural, alignas ?? 1);
  if (pack === undefined) return raised;
  return target.alignasBeatsPack ? Math.max(Math.min(natural, pack), alignas ?? 1, req) : Math.min(raised, pack);
}

function structLayout(t: Extract<Type, { k: "struct" }>, target: Target, order: Mode, mode: Mode): Layout {
  const decl = t.fields.map((f, i) => {
    const inner = layoutOf(f.type, target, mode);
    return { f, i, inner, align: fieldAlign(inner.align, f.align, t.pack, target, inner.reqAlign, t.packed) };
  });
  // repr(Rust) model: stable sort by decreasing alignment.
  const placed = order === "Rust" ? [...decl].sort((a, b) => b.align - a.align || a.i - b.i) : decl;
  const fields: FieldLayout[] = [];
  const holes: Hole[] = [];
  let off = 0;
  let align = 1;
  for (const d of placed) {
    const at = alignUp(off, d.align);
    if (at > off) holes.push({ offset: off, size: at - off, reason: "align", before: d.f.name });
    fields.push({ name: d.f.name, type: d.f.type, typeName: d.inner.typeName, offset: at, size: d.inner.size, align: d.align, decl: d.i, inner: d.inner.fields.length || d.inner.elem ? d.inner : undefined });
    off = at + d.inner.size;
    align = Math.max(align, d.align);
  }
  if (t.align !== undefined) {
    if (!isPow2(t.align)) throw new Error(`align(${t.align}) is not a power of two`);
    align = Math.max(align, t.align);
  }
  const size = alignUp(off, align);
  if (size > off) holes.push({ offset: off, size: size - off, reason: "tail" });
  const rules = (order === "Rust" ? "Rust (model)" : mode === "Rust" ? "repr(C)" : "C") + (t.pack ? ` pack(${t.pack})` : "") + (t.packed ? " packed" : "") + (t.align ? ` align(${t.align})` : "");
  const niche = mode === "Rust" ? Math.max(0, ...decl.map((d) => d.inner.niche)) : 0;
  const reqAlign = Math.max(t.align ?? 1, ...decl.map((d) => Math.max(d.f.align ?? 1, d.inner.reqAlign)));
  return { typeName: typeName(t), size, align, fields, holes, rules, niche, target: target.id, reqAlign };
}

function unionLayout(t: Extract<Type, { k: "union" }>, target: Target, mode: Mode): Layout {
  let size = 0;
  let align = 1;
  let reqAlign = t.align ?? 1;
  const fields = t.fields.map((f, i): FieldLayout => {
    const inner = layoutOf(f.type, target, mode);
    const a = fieldAlign(inner.align, f.align, t.pack, target, inner.reqAlign, t.packed);
    reqAlign = Math.max(reqAlign, f.align ?? 1, inner.reqAlign);
    size = Math.max(size, inner.size);
    align = Math.max(align, a);
    return { name: f.name, type: f.type, typeName: inner.typeName, offset: 0, size: inner.size, align: a, decl: i, inner: inner.fields.length || inner.elem ? inner : undefined };
  });
  if (t.align !== undefined) align = Math.max(align, t.align);
  const full = alignUp(size, align);
  const holes: Hole[] = full > size ? [{ offset: size, size: full - size, reason: "tail" }] : [];
  return { typeName: typeName(t), size: full, align, fields, holes, rules: "union", niche: 0, target: target.id, reqAlign };
}

function optionLayout(t: Extract<Type, { k: "option" }>, target: Target): Layout {
  const inner = layoutOf(t.of, target, "Rust");
  const some: Omit<FieldLayout, "offset"> = { name: "Some", type: t.of, typeName: inner.typeName, size: inner.size, align: inner.align, decl: 1, inner: inner.fields.length ? inner : undefined };
  if (inner.niche > 0) {
    // None is one of the bit patterns that T cannot hold. No tag, no extra bytes.
    return { typeName: typeName(t), size: inner.size, align: inner.align, fields: [{ ...some, offset: 0 }], holes: [], rules: "Rust niche", niche: inner.niche - 1, target: target.id, reqAlign: inner.reqAlign };
  }
  const align = inner.align;
  const at = alignUp(1, align);
  const size = alignUp(at + inner.size, align);
  const holes: Hole[] = [];
  if (at > 1) holes.push({ offset: 1, size: at - 1, reason: "align", before: "Some" });
  if (size > at + inner.size) holes.push({ offset: at + inner.size, size: size - at - inner.size, reason: "tail" });
  const tag: FieldLayout = { name: "tag", type: T.u8, typeName: "u8", offset: 0, size: 1, align: 1, decl: 0 };
  // The tag holds 0 or 1, so 254 tag values are free: a niche for an outer Option.
  return { typeName: typeName(t), size, align, fields: [tag, { ...some, offset: at }], holes, rules: "Rust tag", niche: 254, target: target.id, reqAlign: inner.reqAlign };
}

const targetOf = (t: Target | TargetId): Target => (typeof t === "string" ? TARGETS[t] : t);

/** The C layout of a type: declaration order, psABI sizes and alignments. */
export const layoutC = (type: Type, target: Target | TargetId = "x86_64-linux"): Layout => layoutOf(type, targetOf(target), "C");

/** The Rust layout: repr(C) structs use the C rules; repr(Rust) structs use the "sort by alignment" model. */
export const layoutRust = (type: Type, target: Target | TargetId = "x86_64-linux"): Layout => layoutOf(type, targetOf(target), "Rust");

export const sizeOf = (type: Type, target: Target | TargetId = "x86_64-linux") => layoutC(type, target).size;
export const alignOf = (type: Type, target: Target | TargetId = "x86_64-linux") => layoutC(type, target).align;

/**
 * The fields in the order that gives the smallest C size: decreasing alignment, stable. When every field's size is a
 * multiple of its alignment (true for every scalar, array, struct and union type), this leaves no gap between fields,
 * so the size is the sum of the field sizes rounded up to the struct alignment: the lower bound. A field with an
 * `alignas` larger than its size can break that guarantee.
 */
export function optimalOrder(fields: FieldDecl[], target: Target | TargetId = "x86_64-linux", pack?: number): FieldDecl[] {
  const tg = targetOf(target);
  const a = (f: FieldDecl) => {
    const l = layoutOf(f.type, tg, "C");
    return fieldAlign(l.align, f.align, pack, tg, l.reqAlign);
  };
  return fields.map((f, i) => ({ f, i, a: a(f) })).sort((x, y) => y.a - x.a || x.i - y.i).map((x) => x.f);
}

/**
 * Padding bytes in a layout. By default only the holes of this level; with `deep`, also the holes inside nested
 * structs, unions and arrays.
 */
export function wasted(l: Layout, deep = false): number {
  if (l.elem) return deep ? (l.count ?? 0) * wasted(l.elem, true) : 0;
  let n = l.holes.reduce((s, h) => s + h.size, 0);
  if (deep) for (const f of l.fields) if (f.inner) n += wasted(f.inner, true);
  return n;
}

/** Who owns one byte of a layout. */
export interface ByteOwner {
  /** Index of the top-level field in `layout.fields`, or -1 for a top-level hole. */
  field: number;
  /** The deepest field path, for example "pos.x" or "data[2]". Null for padding. */
  path: string | null;
  /** True for padding at any level, including the holes inside a nested struct. */
  pad: boolean;
}

/** One entry per byte of the layout. In a union, a byte belongs to the first field that covers it. */
export function byteOwners(l: Layout): ByteOwner[] {
  // A scalar, or an array too long to list its elements: every byte is a value byte.
  if (!l.fields.length) return Array.from({ length: l.size }, () => ({ field: -1, path: l.typeName, pad: false }));
  const out: ByteOwner[] = Array.from({ length: l.size }, () => ({ field: -1, path: null, pad: true }));
  const fill = (lay: Layout, base: number, prefix: string, top: number) => {
    for (const [i, f] of lay.fields.entries()) {
      const name = f.name.startsWith("[") ? prefix + f.name : prefix ? `${prefix}.${f.name}` : f.name;
      const t = top < 0 ? i : top;
      for (let b = 0; b < f.size; b++) {
        const o = out[base + f.offset + b]!;
        if (o.field < 0 || o.pad) { o.field = t; o.path = null; }
      }
      if (f.inner?.fields.length) fill(f.inner, base + f.offset, name, t);
      else for (let b = 0; b < f.size; b++) {
        const o = out[base + f.offset + b]!;
        if (o.path === null) { o.path = name; o.pad = false; }
      }
    }
  };
  fill(l, 0, "", -1);
  return out;
}
