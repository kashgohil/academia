/**
 * How five calling conventions pass a C struct by value, and how they return it. This is the language-level view:
 * which bytes of the struct go to which register, or why the struct goes to memory. The machine-level view (register
 * roles, frames, callee-saved splits) is in src/sims/arch/isa/callconv.ts.
 *
 * The model function is `void f(long i0, ..., double d0, ..., struct S s)` for passing, and `struct S g(void)` for
 * returning. `intBefore` and `fpBefore` say how many integer and double arguments come before the struct.
 *
 * Conventions and their sources:
 * - "sysv": System V AMD64 psABI, section 3.2.3 "Parameter Passing" (classification into eightbytes of class
 *   INTEGER, SSE, X87, X87UP or MEMORY; merge; post-merger cleanup; "If there are no registers available for any
 *   eightbyte of an argument, the whole argument is passed on the stack"; "Returning of Values": MEMORY means a
 *   hidden pointer in rdi, returned again in rax; X87 returns in st0).
 * - "aapcs64": AAPCS64, "Parameter Passing" stages B and C (B.3 an HFA is used unmodified; B.4 a composite larger
 *   than 16 bytes is copied to memory allocated by the caller and replaced by a pointer; C.2/C.3 an HFA takes
 *   one v register per member or goes to the stack; C.12/C.13 a composite takes consecutive x registers or goes to
 *   the stack, never split) and "Result Return" (x8 holds the address of the result memory).
 * - "win64": Microsoft Learn, "x64 calling convention": one register per argument by position (rcx, rdx, r8, r9 or
 *   xmm0-xmm3); "Structs and unions of size 8, 16, 32, or 64 bits ... are passed as if they were integers of the same
 *   size. Structs or unions of other sizes are passed as a pointer to memory allocated by the caller"; a struct of
 *   1, 2, 4 or 8 bytes is returned in rax, otherwise the caller passes a pointer to the result memory as the first
 *   argument, and the callee returns it in rax.
 * - "rv64": RISC-V ELF psABI, "Integer Calling Convention" and "Hardware Floating-Point Calling Convention" (LP64D:
 *   XLEN = FLEN = 64). A struct is flattened. One float or double, two of them, or one of them and one integer go in
 *   fa/a registers if enough are free. Otherwise: up to 8 bytes in one register, up to 16 bytes in a pair (the only
 *   convention here that may split a struct between a register and the stack), larger by reference.
 * - "go": Go's register ABI, ABIInternal on amd64 (go/src/cmd/compile/abi-internal.md): every field is assigned on its
 *   own to RAX, RBX, RCX, RDI, RSI, R8, R9, R10, R11 or X0-X14. An array of length > 1 fails, and a failed value goes
 *   to the stack whole. Results use the same algorithm with the counters reset, and a failed result is on the stack:
 *   there is no hidden pointer.
 *
 * Golden check: tests/unit/sys-abi.test.ts compares the registers that this file picks with the LLVM IR signatures
 * that clang (zig cc 0.17.1) emits for random structs on x86_64-linux-gnu, aarch64-linux-gnu, x86_64-windows-msvc and
 * riscv64-linux-gnu, and pins Go cases read from `go build -gcflags=-S` (go 1.25.6, GOARCH=amd64).
 *
 * Not modelled: unions, packed structs, bit-fields, `__int128`, vector types, C++ classes that are non-trivial for
 * calls (always passed by invisible reference), variadic calls, and Apple's arm64 variant.
 */
import { array, layoutC, ptr, struct, T, type Layout, type ScalarName, type TargetId, type Type } from "../mem";

export type ConvId = "sysv" | "aapcs64" | "win64" | "rv64" | "go";

export interface ConvInfo { id: ConvId; name: string; short: string; target: TargetId; intRegs: string[]; fpRegs: string[] }

export const CONVS: Record<ConvId, ConvInfo> = {
  sysv: { id: "sysv", name: "System V x86-64 (Linux, macOS, BSD)", short: "SysV x86-64", target: "x86_64-linux", intRegs: ["rdi", "rsi", "rdx", "rcx", "r8", "r9"], fpRegs: ["xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7"] },
  aapcs64: { id: "aapcs64", name: "AAPCS64 (Arm64 Linux)", short: "AAPCS64", target: "aarch64-linux", intRegs: ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"], fpRegs: ["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"] },
  win64: { id: "win64", name: "Microsoft x64 (Windows)", short: "Windows x64", target: "x86_64-windows", intRegs: ["rcx", "rdx", "r8", "r9"], fpRegs: ["xmm0", "xmm1", "xmm2", "xmm3"] },
  rv64: { id: "rv64", name: "RISC-V LP64D (RV64 Linux)", short: "RISC-V LP64D", target: "riscv64-linux", intRegs: ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"], fpRegs: ["fa0", "fa1", "fa2", "fa3", "fa4", "fa5", "fa6", "fa7"] },
  go: { id: "go", name: "Go ABIInternal (amd64)", short: "Go amd64", target: "x86_64-linux", intRegs: ["RAX", "RBX", "RCX", "RDI", "RSI", "R8", "R9", "R10", "R11"], fpRegs: ["X0", "X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10", "X11", "X12", "X13", "X14"] },
};
export const CONV_IDS = Object.keys(CONVS) as ConvId[];

/** Return registers. */
const RET: Record<ConvId, { int: string[]; fp: string[] }> = {
  sysv: { int: ["rax", "rdx"], fp: ["xmm0", "xmm1"] },
  aapcs64: { int: ["x0", "x1"], fp: ["v0", "v1", "v2", "v3"] },
  win64: { int: ["rax"], fp: ["xmm0"] },
  rv64: { int: ["a0", "a1"], fp: ["fa0", "fa1"] },
  go: { int: CONVS.go.intRegs, fp: CONVS.go.fpRegs },
};

// ---------------------------------------------------------------- the field palette

/** Field kinds that the demo offers. "ptr" is `void *`; arrays are written "float[2]". */
export const FIELD_KINDS = ["char", "short", "int", "long", "long long", "float", "double", "ptr", "long double", "char[3]", "float[2]", "int[3]", "double[2]"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

const SCALAR_OF: Record<string, ScalarName> = { char: "char", short: "short", int: "int", long: "long", "long long": "long long", float: "float", double: "double", "long double": "long double" };

export function fieldType(k: FieldKind): Type {
  const m = /^(.+)\[(\d+)\]$/.exec(k);
  if (m) return array(T[SCALAR_OF[m[1]!]!], Number(m[2]));
  if (k === "ptr") return ptr();
  return T[SCALAR_OF[k]!];
}

/** The C text of a field: "double x", "char c[3]", "void *p". */
export function fieldDecl(k: FieldKind, name: string): string {
  const m = /^(.+)\[(\d+)\]$/.exec(k);
  if (m) return `${m[1]} ${name}[${m[2]}]`;
  return k === "ptr" ? `void *${name}` : `${k} ${name}`;
}

/** The Go type of a field, for the Go convention. undefined: Go has no such type (long double). */
export function goType(k: FieldKind): string | undefined {
  const base: Record<string, string> = { char: "int8", short: "int16", int: "int32", long: "int64", "long long": "int64", float: "float32", double: "float64", ptr: "unsafe.Pointer" };
  const m = /^(.+)\[(\d+)\]$/.exec(k);
  if (m) return `[${m[2]}]${base[m[1]!]}`;
  return base[k];
}

export const FIELD_NAMES = ["a", "b", "c", "d", "e", "f", "g", "h"];

export function makeStruct(kinds: FieldKind[]): Type {
  return struct("S", kinds.map((k, i) => [FIELD_NAMES[i]!, fieldType(k)]));
}

/** The C declaration of the struct. */
export const structSource = (kinds: FieldKind[]) => `struct S { ${kinds.map((k, i) => fieldDecl(k, FIELD_NAMES[i]!) + ";").join(" ")} };`;

// ---------------------------------------------------------------- flattening

type Kind = "int" | "fp" | "x87";
/** One scalar leaf of the struct, with its byte offset. */
export interface Leaf { field: number; name: string; offset: number; size: number; kind: Kind; scalar: string }

export function leaves(l: Layout): Leaf[] {
  const out: Leaf[] = [];
  const walk = (l: Layout, base: number, field: number, name: string) => {
    if (!l.fields.length) {
      const fp = /float|double/.test(l.typeName);
      out.push({ field, name, offset: base, size: l.size, kind: l.typeName === "long double" ? (l.target === "x86_64-linux" ? "x87" : "fp") : fp ? "fp" : "int", scalar: l.typeName });
      return;
    }
    l.fields.forEach((f, i) => walk(f.inner ?? scalarLayoutOf(f, l.target), base + f.offset, field < 0 ? i : field, field < 0 ? f.name : `${name}${f.name}`));
  };
  walk(l, 0, -1, "");
  return out;
}
const scalarLayoutOf = (f: Layout["fields"][number], target: TargetId): Layout => ({ typeName: f.typeName, size: f.size, align: f.align, fields: [], holes: [], rules: "scalar", niche: 0, target, reqAlign: 1 });

// ---------------------------------------------------------------- results

export type SysvClass = "INTEGER" | "SSE" | "X87" | "X87UP" | "NO_CLASS" | "MEMORY";

/** A piece of the struct and where it goes. */
export interface Chunk {
  offset: number;
  size: number;
  /** "INTEGER", "SSE", "HFA member", "float", "field" ... */
  cls: string;
  /** The register, or undefined if this piece is in memory. */
  reg?: string;
  /** The field names in this piece. */
  fields: string[];
}

export type How = "regs" | "stack" | "ref" | "split" | "empty";

export interface Passing {
  how: How;
  /** Registers used, in order. For "ref", the register that holds the pointer (if any). */
  regs: string[];
  chunks: Chunk[];
  /** For "ref": the pointer goes on the stack because no register is left. */
  refOnStack?: boolean;
  /** One or two sentences: the rule that decided. */
  why: string;
  /** Bytes the caller copies to memory for this argument (stack slot or temporary copy). */
  copied: number;
}

export interface Returning {
  how: "regs" | "sret" | "stack" | "x87";
  regs: string[];
  chunks: Chunk[];
  /** For "sret": the register that carries the hidden result pointer. */
  sretReg?: string;
  why: string;
}

export interface ConvResult { conv: ConvId; layout: Layout; arg: Passing; ret: Returning; unsupported?: string }

export interface CallSite { intBefore: number; fpBefore: number }

const fieldsIn = (ls: Leaf[], lo: number, hi: number) => [...new Set(ls.filter((x) => x.offset < hi && x.offset + x.size > lo).map((x) => x.name.replace(/\[\d+\]$/, "")))];

// ---------------------------------------------------------------- System V x86-64

/** The classes of the eightbytes, after merge and post-merger cleanup (psABI 3.2.3). */
export function sysvClassify(l: Layout): SysvClass[] {
  const n = Math.ceil(l.size / 8);
  if (n === 0) return [];
  if (l.size > 64) return Array(n).fill("MEMORY");
  const cls: SysvClass[] = Array(n).fill("NO_CLASS");
  const merge = (a: SysvClass, b: SysvClass): SysvClass => {
    if (a === b) return a;
    if (a === "NO_CLASS") return b;
    if (b === "NO_CLASS") return a;
    if (a === "MEMORY" || b === "MEMORY") return "MEMORY";
    if (a === "INTEGER" || b === "INTEGER") return "INTEGER";
    if (a === "X87" || a === "X87UP" || b === "X87" || b === "X87UP") return "MEMORY";
    return "SSE";
  };
  for (const leaf of leaves(l)) {
    if (leaf.kind === "x87") {
      cls[leaf.offset >> 3] = merge(cls[leaf.offset >> 3]!, "X87");
      cls[(leaf.offset >> 3) + 1] = merge(cls[(leaf.offset >> 3) + 1]!, "X87UP");
      continue;
    }
    cls[leaf.offset >> 3] = merge(cls[leaf.offset >> 3]!, leaf.kind === "fp" ? "SSE" : "INTEGER");
  }
  // post-merger cleanup
  if (cls.includes("MEMORY")) return cls.map(() => "MEMORY");
  if (cls.some((c, i) => c === "X87UP" && cls[i - 1] !== "X87")) return cls.map(() => "MEMORY");
  // No SSEUP class arises from these field kinds, so any aggregate over two eightbytes goes to memory.
  if (n > 2) return cls.map(() => "MEMORY");
  return cls;
}

function sysv(l: Layout, site: CallSite): ConvResult {
  const info = CONVS.sysv;
  const cls = sysvClassify(l);
  const ls = leaves(l);
  const chunk = (i: number, c: SysvClass): Chunk => ({ offset: i * 8, size: Math.min(8, l.size - i * 8), cls: c, fields: fieldsIn(ls, i * 8, i * 8 + 8) });
  const ints = info.intRegs.slice(Math.min(site.intBefore, 6));
  const fps = info.fpRegs.slice(Math.min(site.fpBefore, 8));
  let arg: Passing;
  const mem = cls[0] === "MEMORY";
  const x87 = cls.includes("X87");
  if (mem || x87) {
    arg = {
      how: "stack", regs: [], chunks: cls.map((c, i) => chunk(i, c)), copied: Math.ceil(l.size / 8) * 8,
      why: x87
        ? "A long double is class X87. Arguments of class X87 and X87UP are passed in memory, on the stack."
        : l.size > 16
          ? `The struct is ${l.size} bytes, more than two eightbytes, and it has no SSEUP parts. The post-merger cleanup makes it MEMORY: the caller copies it onto the stack.`
          : "One eightbyte is MEMORY, so the whole struct goes on the stack.",
    };
  } else {
    const needI = cls.filter((c) => c === "INTEGER").length;
    const needF = cls.filter((c) => c === "SSE").length;
    if (needI > ints.length || needF > fps.length) {
      arg = {
        how: "stack", regs: [], chunks: cls.map((c, i) => chunk(i, c)), copied: Math.ceil(l.size / 8) * 8,
        why: `It needs ${needI} integer and ${needF} vector register(s), but only ${ints.length} and ${fps.length} are free. The psABI does not split an argument: the whole struct goes on the stack.`,
      };
    } else {
      let ii = 0, ff = 0;
      const chunks = cls.map((c, i) => ({ ...chunk(i, c), reg: c === "INTEGER" ? ints[ii++] : fps[ff++] }));
      arg = { how: "regs", regs: chunks.map((c) => c.reg!), chunks, copied: 0, why: `Each eightbyte gets the register of its class: INTEGER takes the next of rdi, rsi, rdx, rcx, r8, r9, and SSE the next of xmm0 to xmm7.` };
    }
  }
  let ret: Returning;
  if (mem) ret = { how: "sret", regs: [], chunks: [], sretReg: "rdi", why: "Class MEMORY: the caller reserves the result and passes its address in rdi, as a hidden first argument. The callee returns the same address in rax." };
  else if (x87) ret = { how: "x87", regs: ["st0"], chunks: cls.map((c, i) => ({ ...chunk(i, c), reg: "st0" })), why: "Classes X87 and X87UP: the value comes back on the x87 stack, in st0." };
  else {
    let ii = 0, ff = 0;
    const chunks = cls.map((c, i) => ({ ...chunk(i, c), reg: c === "INTEGER" ? RET.sysv.int[ii++] : RET.sysv.fp[ff++] }));
    ret = { how: "regs", regs: chunks.map((c) => c.reg!), chunks, why: "INTEGER eightbytes come back in rax, then rdx; SSE eightbytes in xmm0, then xmm1." };
  }
  return { conv: "sysv", layout: l, arg, ret };
}

// ---------------------------------------------------------------- AAPCS64

/** The HFA base type and member count, or undefined. Members: float, double or long double (quad), 1 to 4 of one type. */
export function hfa(l: Layout): { base: string; n: number } | undefined {
  const ls = leaves(l);
  if (!ls.length || ls.length > 4 || ls.some((x) => x.kind === "int")) return undefined;
  if (ls.some((x) => x.scalar !== ls[0]!.scalar)) return undefined;
  return { base: ls[0]!.scalar, n: ls.length };
}

function aapcs64(l: Layout, site: CallSite): ConvResult {
  const info = CONVS.aapcs64;
  const ls = leaves(l);
  const h = hfa(l);
  const ngrn = Math.min(site.intBefore, 8), nsrn = Math.min(site.fpBefore, 8);
  const dwords = Math.ceil(l.size / 8);
  const dwChunks = (regs: string[] | undefined): Chunk[] => Array.from({ length: dwords }, (_, i) => ({ offset: i * 8, size: Math.min(8, l.size - i * 8), cls: "doubleword", reg: regs?.[i], fields: fieldsIn(ls, i * 8, i * 8 + 8) }));
  const hfaChunks = (regs: string[] | undefined): Chunk[] => ls.map((x, i) => ({ offset: x.offset, size: x.size, cls: `HFA member (${x.scalar === "long double" ? "quad" : x.scalar})`, reg: regs?.[i], fields: [x.name.replace(/\[\d+\]$/, "")] }));
  let arg: Passing;
  if (h) {
    if (nsrn + h.n <= 8) {
      const regs = info.fpRegs.slice(nsrn, nsrn + h.n);
      arg = { how: "regs", regs, chunks: hfaChunks(regs), copied: 0, why: `A homogeneous floating-point aggregate (HFA): ${h.n} member(s) of one floating-point type. Rule C.2 gives one v register to each member.` };
    } else arg = { how: "stack", regs: [], chunks: hfaChunks(undefined), copied: dwords * 8, why: `An HFA of ${h.n} members, but only ${8 - nsrn} v register(s) are free. Rule C.3 sets NSRN to 8, and the whole HFA goes on the stack.` };
  } else if (l.size > 16) {
    const reg = ngrn < 8 ? info.intRegs[ngrn] : undefined;
    arg = { how: "ref", regs: reg ? [reg] : [], refOnStack: !reg, chunks: dwChunks(undefined), copied: l.size, why: `Not an HFA, and larger than 16 bytes. Rule B.4: the caller copies it to memory and passes a pointer to the copy${reg ? ` in ${reg}` : " on the stack"}.` };
  } else if (dwords <= 8 - ngrn) {
    const regs = info.intRegs.slice(ngrn, ngrn + dwords);
    arg = { how: "regs", regs, chunks: dwChunks(regs), copied: 0, why: `Not an HFA, ${l.size} bytes. Rule C.12 loads it into ${dwords} consecutive x register(s), as if with LDR from memory. Float fields travel inside x registers here.` };
  } else arg = { how: "stack", regs: [], chunks: dwChunks(undefined), copied: dwords * 8, why: `It needs ${dwords} x registers, but only ${8 - ngrn} are free. Rule C.13 sets NGRN to 8: the struct goes on the stack, never half in registers.` };
  let ret: Returning;
  if (h) ret = { how: "regs", regs: info.fpRegs.slice(0, h.n), chunks: hfaChunks(info.fpRegs.slice(0, h.n)), why: "An HFA comes back in v0 to v3, one member in each." };
  else if (l.size > 16) ret = { how: "sret", regs: [], chunks: [], sretReg: "x8", why: "Larger than 16 bytes and not an HFA: the caller reserves memory and passes its address in x8, the indirect result register. x8 is not an argument register, so x0 stays free." };
  else ret = { how: "regs", regs: RET.aapcs64.int.slice(0, dwords), chunks: dwChunks(RET.aapcs64.int), why: "Up to 16 bytes and not an HFA: it comes back in x0, then x1, as if loaded from memory." };
  return { conv: "aapcs64", layout: l, arg, ret };
}

// ---------------------------------------------------------------- Microsoft x64

function win64(l: Layout, site: CallSite): ConvResult {
  const info = CONVS.win64;
  const slot = site.intBefore + site.fpBefore;
  const ls = leaves(l);
  const fits = [1, 2, 4, 8].includes(l.size);
  const whole: Chunk[] = [{ offset: 0, size: l.size, cls: fits ? "as an integer" : "by reference", fields: fieldsIn(ls, 0, l.size) }];
  const reg = slot < 4 ? info.intRegs[slot] : undefined;
  let arg: Passing;
  if (fits) arg = { how: reg ? "regs" : "stack", regs: reg ? [reg] : [], chunks: [{ ...whole[0]!, reg }], copied: reg ? 0 : 8, why: `${l.size} bytes is 8, 16, 32 or 64 bits, so it travels as an integer of that size${reg ? ` in ${reg}, the register of argument position ${slot + 1}` : ", on the stack, because it is argument 5 or later"}. Float fields go in an integer register too.` };
  else arg = { how: "ref", regs: reg ? [reg] : [], refOnStack: !reg, chunks: whole, copied: l.size, why: `${l.size} bytes is not 1, 2, 4 or 8. The caller copies the struct to a 16-byte-aligned temporary and passes a pointer to it${reg ? ` in ${reg}` : " on the stack"}.` };
  const ret: Returning = fits
    ? { how: "regs", regs: ["rax"], chunks: [{ ...whole[0]!, reg: "rax" }], why: "A plain C struct of 1, 2, 4 or 8 bytes comes back in rax, even when its fields are floats." }
    : { how: "sret", regs: [], chunks: [], sretReg: "rcx", why: "Any other size: the caller passes a pointer to the result memory as the first argument, in rcx. The other arguments move one position to the right, and the callee returns the pointer in rax." };
  return { conv: "win64", layout: l, arg, ret };
}

// ---------------------------------------------------------------- RISC-V LP64D

function rv64(l: Layout, site: CallSite): ConvResult {
  const info = CONVS.rv64;
  const ls = leaves(l);
  const gpr = Math.max(0, 8 - site.intBefore), fpr = Math.max(0, 8 - site.fpBefore);
  const fpOk = (x: Leaf) => x.kind === "fp" && x.size <= 8;
  const intOk = (x: Leaf) => x.kind === "int" && x.size <= 8;
  const leafChunks = (regs: (string | undefined)[]): Chunk[] => ls.map((x, i) => ({ offset: x.offset, size: x.size, cls: fpOk(x) ? "float field" : "integer field", reg: regs[i], fields: [x.name.replace(/\[\d+\]$/, "")] }));
  const xlenChunks = (regs: (string | undefined)[]): Chunk[] => Array.from({ length: Math.ceil(l.size / 8) }, (_, i) => ({ offset: i * 8, size: Math.min(8, l.size - i * 8), cls: "XLEN chunk", reg: regs[i], fields: fieldsIn(ls, i * 8, i * 8 + 8) }));
  /** The hardware floating-point rule: which registers, given free counts, or undefined. */
  const fpRule = (g: number, f: number, gRegs: string[], fRegs: string[]): { regs: string[]; why: string } | undefined => {
    if (ls.length === 1 && fpOk(ls[0]!) && f >= 1) return { regs: [fRegs[0]!], why: "A struct with just one float or double is passed like that value alone, in an fa register." };
    if (ls.length === 2 && fpOk(ls[0]!) && fpOk(ls[1]!) && f >= 2) return { regs: fRegs.slice(0, 2), why: "A struct with two floating-point fields goes in two fa registers, in memory order." };
    if (ls.length === 2 && ls.some(fpOk) && ls.some(intOk) && f >= 1 && g >= 1) {
      let fi = 0, gi = 0;
      return { regs: ls.map((x) => (fpOk(x) ? fRegs[fi++]! : gRegs[gi++]!)), why: "One floating-point field and one integer field: the float goes in an fa register and the integer in an a register." };
    }
    return undefined;
  };
  const gRegs = info.intRegs.slice(8 - gpr), fRegs = info.fpRegs.slice(8 - fpr);
  let arg: Passing;
  const hw = fpRule(gpr, fpr, gRegs, fRegs);
  if (hw) arg = { how: "regs", regs: hw.regs, chunks: leafChunks(hw.regs), copied: 0, why: hw.why };
  else {
    const note = ls.length <= 2 && ls.some(fpOk) && fpRule(8, 8, info.intRegs, info.fpRegs) ? "Not enough fa or a registers are free for the floating-point rule, so the integer convention applies. " : "";
    if (l.size > 16) {
      const reg = gRegs[0];
      arg = { how: "ref", regs: reg ? [reg] : [], refOnStack: !reg, chunks: xlenChunks([]), copied: l.size, why: `${note}Larger than 2×XLEN (16 bytes): passed by reference. The caller makes a copy and passes its address${reg ? ` in ${reg}` : " on the stack"}.` };
    } else {
      const n = Math.ceil(l.size / 8);
      if (gpr >= n) arg = { how: "regs", regs: gRegs.slice(0, n), chunks: xlenChunks(gRegs), copied: 0, why: `${note}Integer convention: ${l.size} bytes fill ${n} a register(s), laid out as in memory. Float fields travel in a registers here.` };
      else if (gpr === 1) arg = { how: "split", regs: [gRegs[0]!], chunks: xlenChunks([gRegs[0]]), copied: 8, why: `${note}Only one a register is free. The psABI puts the first 8 bytes in ${gRegs[0]} and the other 8 bytes on the stack.` };
      else arg = { how: "stack", regs: [], chunks: xlenChunks([]), copied: n * 8, why: `${note}No a register is free, so the struct goes on the stack.` };
    }
  }
  let ret: Returning;
  const rhw = fpRule(2, 2, RET.rv64.int, RET.rv64.fp);
  if (rhw) ret = { how: "regs", regs: rhw.regs, chunks: leafChunks(rhw.regs), why: `Returned like a first argument: ${rhw.why[0]!.toLowerCase()}${rhw.why.slice(1)}`.replace(/fa register/g, "fa0/fa1 register").replace("an a register", "a0") };
  else if (l.size > 16) ret = { how: "sret", regs: [], chunks: [], sretReg: "a0", why: "Larger than 16 bytes: the caller reserves the result and passes its address in a0, as an implicit first argument." };
  else ret = { how: "regs", regs: RET.rv64.int.slice(0, Math.ceil(l.size / 8)), chunks: xlenChunks(RET.rv64.int), why: "Up to 16 bytes: returned in a0, then a1, laid out as in memory." };
  return { conv: "rv64", layout: l, arg, ret };
}

// ---------------------------------------------------------------- Go ABIInternal

function go(kinds: FieldKind[], l: Layout, site: CallSite): ConvResult {
  const info = CONVS.go;
  if (kinds.some((k) => !goType(k))) {
    const none: Passing = { how: "empty", regs: [], chunks: [], copied: 0, why: "Go has no long double type." };
    return { conv: "go", layout: l, arg: none, ret: { how: "stack", regs: [], chunks: [], why: none.why }, unsupported: "Go has no long double type, so this struct has no Go twin." };
  }
  const assign = (i0: number, f0: number): { regs: (string | undefined)[]; ok: boolean; why: string } => {
    let i = i0, f = f0;
    const regs: (string | undefined)[] = [];
    for (const [n, k] of kinds.entries()) {
      const m = /\[(\d+)\]$/.exec(k);
      if (m && Number(m[1]) > 1) return { regs: [], ok: false, why: `Field ${FIELD_NAMES[n]} is an array of length ${m[1]}. Register assignment fails for any array longer than 1, so the whole value goes to the stack.` };
      const fp = /float|double/.test(k);
      if (fp) { if (f >= info.fpRegs.length) return { regs: [], ok: false, why: "The float registers X0 to X14 run out, so the whole value goes to the stack." }; regs.push(info.fpRegs[f++]); }
      else { if (i >= info.intRegs.length) return { regs: [], ok: false, why: "The nine integer registers run out, so the whole value goes to the stack." }; regs.push(info.intRegs[i++]); }
    }
    return { regs, ok: true, why: "" };
  };
  const ls = leaves(l);
  const fieldChunks = (regs: (string | undefined)[]): Chunk[] => kinds.map((k, n) => {
    const f = l.fields[n]!;
    return { offset: f.offset, size: f.size, cls: goType(k)!, reg: regs[n], fields: [f.name] };
  });
  void ls;
  const a = assign(Math.min(site.intBefore, 9), Math.min(site.fpBefore, 15));
  const arg: Passing = a.ok
    ? { how: "regs", regs: a.regs as string[], chunks: fieldChunks(a.regs), copied: 0, why: "Each field is its own register argument: integers and pointers take the next of RAX, RBX, RCX, RDI, RSI, R8 to R11; floats take the next X register. Padding does not matter." }
    : { how: "stack", regs: [], chunks: fieldChunks([]), copied: l.size, why: a.why };
  const r = assign(0, 0);
  const ret: Returning = r.ok
    ? { how: "regs", regs: r.regs as string[], chunks: fieldChunks(r.regs), why: "Results use the same algorithm, with the register counters reset to 0. Arguments and results share registers." }
    : { how: "stack", regs: [], chunks: fieldChunks([]), why: `${r.why.replace("goes to the stack", "goes to a result slot on the stack")} Go passes no hidden pointer.` };
  return { conv: "go", layout: l, arg, ret };
}

// ---------------------------------------------------------------- entry points

export function classify(conv: ConvId, kinds: FieldKind[], site: CallSite = { intBefore: 0, fpBefore: 0 }): ConvResult {
  const l = layoutC(makeStruct(kinds), CONVS[conv].target);
  switch (conv) {
    case "sysv": return sysv(l, site);
    case "aapcs64": return aapcs64(l, site);
    case "win64": return win64(l, site);
    case "rv64": return rv64(l, site);
    case "go": return go(kinds, l, site);
  }
}

export const classifyAll = (kinds: FieldKind[], site?: CallSite) => CONV_IDS.map((c) => classify(c, kinds, site));

/** Short text of where the argument goes: "xmm0, rdi", "stack", "pointer in x0", "a7 + stack". */
export function argText(r: Passing): string {
  switch (r.how) {
    case "regs": return r.regs.join(", ");
    case "stack": return "stack";
    case "ref": return r.refOnStack ? "pointer on the stack" : `pointer in ${r.regs[0]}`;
    case "split": return `${r.regs[0]} + stack`;
    case "empty": return "none";
  }
}
export function retText(r: Returning): string {
  switch (r.how) {
    case "regs": case "x87": return r.regs.join(", ");
    case "sret": return `memory, address in ${r.sretReg}`;
    case "stack": return "stack";
  }
}

/** Example structs for the demo's presets. */
export const PRESETS: { id: string; label: string; kinds: FieldKind[] }[] = [
  { id: "pt", label: "Point: two doubles", kinds: ["double", "double"] },
  { id: "v3", label: "Vec3: three doubles", kinds: ["double", "double", "double"] },
  { id: "mix", label: "double and long", kinds: ["double", "long"] },
  { id: "cfd", label: "char, float, double", kinds: ["char", "float", "double"] },
  { id: "f4", label: "four floats", kinds: ["float", "float", "float", "float"] },
  { id: "slice", label: "ptr, long, long (a slice)", kinds: ["ptr", "long", "long"] },
  { id: "ld", label: "one long double", kinds: ["long double"] },
  { id: "arr", label: "int[3]", kinds: ["int[3]"] },
];
