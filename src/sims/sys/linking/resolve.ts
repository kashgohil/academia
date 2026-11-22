/**
 * Symbol resolution for two C files that each may declare a global `int x`. Each file also has a function
 * get_a or get_b that returns x (or 0 if the file does not mention x), and main returns get_a() * 10 + get_b().
 *
 * Each declaration becomes the symbol that clang 22 writes (checked with llvm-readelf), and the generic
 * resolveSymbols() in link.ts decides the outcome. tests/unit/sys-linking-resolve.test.ts compares all 72 cases
 * with ld.lld 22.1.8.
 */
import { resolveSymbols, type LinkError } from "./link";
import { SHF, SHN_COMMON, SHN_UNDEF, type Bind, type ObjFile, type ObjSymbol, type SymType } from "./objfile";

export type Decl = "none" | "extern" | "tentative" | "init" | "weak" | "static";
export const DECLS: Decl[] = ["none", "extern", "tentative", "init", "weak", "static"];

export function declSource(d: Decl, value: number): string {
  switch (d) {
    case "none": return "";
    case "extern": return "extern int x;";
    case "tentative": return "int x;";
    case "init": return `int x = ${value};`;
    case "weak": return `__attribute__((weak)) int x = ${value};`;
    case "static": return `static int x = ${value};`;
  }
}

/** The symbol table entry that the compiler writes for each declaration. */
export function declSymbol(d: Decl, fcommon: boolean): { bind: Bind; where: "UND" | "COMMON" | ".data" | ".bss" } | null {
  switch (d) {
    case "none": return null;
    case "extern": return { bind: "GLOBAL", where: "UND" };
    case "tentative": return fcommon ? { bind: "GLOBAL", where: "COMMON" } : { bind: "GLOBAL", where: ".bss" };
    case "init": return { bind: "GLOBAL", where: ".data" };
    case "weak": return { bind: "WEAK", where: ".data" };
    case "static": return { bind: "LOCAL", where: ".data" };
  }
}

const SECS = ["", ".text", ".data", ".bss"];

/** A synthetic object file: just the symbols and relocations that resolution needs. */
export function makeObject(name: string, syms: { name: string; bind: Bind; type: SymType; where: string; size?: number; value?: number }[], refs: string[]): ObjFile {
  const sections = SECS.map((n, index) => ({ index, name: n, type: n === ".bss" ? 8 : 1, flags: index === 0 ? 0 : SHF.ALLOC | (n === ".text" ? SHF.EXECINSTR : SHF.WRITE), offset: 0, size: 4, link: 0, info: 0, align: 4, entsize: 0, data: new Uint8Array(n === ".bss" ? 0 : 4) }));
  const symbols: ObjSymbol[] = [{ index: 0, name: "", value: 0, size: 0, bind: "LOCAL", type: "NOTYPE", vis: "DEFAULT", shndx: 0 }];
  for (const s of syms) {
    const shndx = s.where === "UND" ? SHN_UNDEF : s.where === "COMMON" ? SHN_COMMON : SECS.indexOf(s.where);
    symbols.push({ index: symbols.length, name: s.name, value: s.value ?? (s.where === "COMMON" ? 4 : 0), size: s.size ?? 4, bind: s.bind, type: s.type, vis: "DEFAULT", shndx });
  }
  const relocs = refs.map((r, i) => ({ target: 1, offset: i * 4, type: 2, sym: symbols.findIndex((s) => s.name === r), addend: -4 }));
  return { name, bytes: new Uint8Array(0), sections, symbols, relocs, shstrndx: 0, fields: [] };
}

export interface FileOutcome {
  /** Which storage the file's get function reads. */
  reads: "nothing" | "own static" | string;
  value: number;
}

export interface TwoFileOutcome {
  error: LinkError | null;
  a: FileOutcome;
  b: FileOutcome;
  /** main's return value: get_a() * 10 + get_b(). */
  ret: number | null;
  /** The symbol entries, for display. */
  symA: string;
  symB: string;
}

const VALUES = { a: 1, b: 2 } as const;

export function resolveTwo(da: Decl, db: Decl, fcommon: boolean): TwoFileOutcome {
  const decl = { a: da, b: db };
  const build = (f: "a" | "b") => {
    const d = decl[f];
    const s = declSymbol(d, fcommon);
    const syms: Parameters<typeof makeObject>[1] = [{ name: `get_${f}`, bind: "GLOBAL", type: "FUNC", where: ".text" }];
    if (s) syms.push({ name: "x", bind: s.bind, type: s.where === "UND" ? "NOTYPE" : "OBJECT", where: s.where });
    return makeObject(`${f}.o`, syms, s ? ["x"] : []);
  };
  const main = makeObject("main.o", [{ name: "main", bind: "GLOBAL", type: "FUNC", where: ".text" }, { name: "get_a", bind: "GLOBAL", type: "NOTYPE", where: "UND" }, { name: "get_b", bind: "GLOBAL", type: "NOTYPE", where: "UND" }], ["get_a", "get_b"]);
  const objs = [main, build("a"), build("b")];
  const res = resolveSymbols(objs);
  const symText = (f: "a" | "b") => {
    const s = declSymbol(decl[f], fcommon);
    return s ? `x ${s.bind} ${s.where}` : "no x";
  };
  const def = res.defs.get("x");
  const owner = def ? objs[def.file]! : null;
  const ownerDecl = owner ? decl[owner.name[0] as "a" | "b"] : null;
  const ownerWhere = def ? (def.kind === "common" ? "(COMMON)" : ownerDecl === "tentative" ? "(.bss)" : "(.data)") : "";
  const ownerValue = owner && ownerDecl !== "tentative" ? VALUES[owner.name[0] as "a" | "b"] : 0;
  const outcome = (f: "a" | "b"): FileOutcome => {
    const d = decl[f];
    if (d === "none") return { reads: "nothing", value: 0 };
    if (d === "static") return { reads: "own static", value: VALUES[f] };
    return { reads: `${owner!.name}:${ownerWhere}`, value: ownerValue };
  };
  if (res.errors.length) return { error: res.errors[0]!, a: { reads: "nothing", value: 0 }, b: { reads: "nothing", value: 0 }, ret: null, symA: symText("a"), symB: symText("b") };
  const a = outcome("a"), b = outcome("b");
  return { error: null, a, b, ret: a.value * 10 + b.value, symA: symText("a"), symB: symText("b") };
}
