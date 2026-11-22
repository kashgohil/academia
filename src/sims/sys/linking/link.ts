/**
 * A small static linker for x86-64 ELF relocatable objects. It does the four jobs of a real linker:
 *
 * 1. Symbol resolution: one definition for each global name, with the rules for strong, weak and COMMON symbols.
 * 2. Garbage collection (optional, like --gc-sections): keep only the sections that the entry point can reach
 *    through relocations.
 * 3. Layout: merge input sections into output sections (.rodata, .text, .got, .data, .bss), align them, and give
 *    them addresses. The address rules copy what ld.lld does for a static, non-PIE link with no linker script,
 *    so the tests can compare each address with ld.lld 22.1.8.
 * 4. Relocation: compute each value with the x86-64 psABI formula (S + A - P and so on), check that it fits,
 *    and write it into the output bytes. GOTPCRELX loads can be relaxed into lea, as ld.lld and GNU ld do.
 *
 * Simplified: static linking only (no dynamic sections, no PLT), no TLS, no mergeable-string deduplication, and
 * only the relocation types in R_X86_64 below. Error texts follow ld.lld's first line.
 */
import { R_X86_64, SHF, SHN_ABS, SHN_COMMON, SHN_UNDEF, relocName, type ObjFile, type ObjReloc, type ObjSymbol } from "./objfile";

export type OutName = ".rodata" | ".text" | ".got" | ".data" | ".bss";
export const OUT_ORDER: OutName[] = [".rodata", ".text", ".got", ".data", ".bss"];
/** ld.lld's default image base for x86-64 (lld/ELF/Arch/X86_64.cpp: defaultImageBase = 0x200000). */
export const IMAGE_BASE = 0x200000;
export const PAGE = 0x1000;
const EHDR = 64, PHDR = 56;

/** Where a global name resolved to. */
export interface Definition {
  file: number;
  sym: number;
  kind: "strong" | "weak" | "common";
}

export interface LinkError { text: string; detail: string[] }

export interface Resolution {
  defs: Map<string, Definition>;
  /** Names that are used but have no definition. Weak references to them resolve to 0. */
  undefinedWeak: Set<string>;
  errors: LinkError[];
}

const rank = (s: ObjSymbol): Definition["kind"] | null =>
  s.shndx === SHN_UNDEF ? null : s.shndx === SHN_COMMON ? "common" : s.bind === "WEAK" ? "weak" : "strong";

/** Symbol resolution over the files in command-line order. */
export function resolveSymbols(objs: ObjFile[]): Resolution {
  const defs = new Map<string, Definition>();
  const errors: LinkError[] = [];
  const dup = new Set<string>();
  objs.forEach((o, fi) => {
    for (const s of o.symbols) {
      if (s.bind === "LOCAL" || s.index === 0) continue;
      const k = rank(s);
      if (!k) continue;
      const old = defs.get(s.name);
      if (!old) { defs.set(s.name, { file: fi, sym: s.index, kind: k }); continue; }
      const take = () => defs.set(s.name, { file: fi, sym: s.index, kind: k });
      if (old.kind === "strong" && k === "strong") {
        if (!dup.has(s.name)) {
          dup.add(s.name);
          errors.push({ text: `duplicate symbol: ${s.name}`, detail: [`defined in ${objs[old.file]!.name}`, `defined in ${o.name}`] });
        }
      } else if (k === "strong") take();
      else if (k === "common" && old.kind === "weak") take();
      else if (k === "common" && old.kind === "common") {
        // Two tentative definitions merge into one. The larger size wins.
        const prev = objs[old.file]!.symbols[old.sym]!;
        if (s.size > prev.size) take();
      }
      // weak after strong, weak after weak, weak after common, common after strong: keep the old one.
    }
  });
  const undefinedWeak = new Set<string>();
  const seen = new Set<string>();
  objs.forEach((o) => {
    for (const s of o.symbols) {
      if (s.index === 0 || s.bind === "LOCAL" || s.shndx !== SHN_UNDEF || defs.has(s.name) || seen.has(s.name)) continue;
      const strongRef = objs.some((x) => x.symbols.some((y) => y.name === s.name && y.shndx === SHN_UNDEF && y.bind === "GLOBAL" && usedByReloc(x, y.index)));
      const refs = objs.filter((x) => x.symbols.some((y) => y.name === s.name && y.shndx === SHN_UNDEF && usedByReloc(x, y.index))).map((x) => x.name);
      if (strongRef) {
        seen.add(s.name);
        errors.push({ text: `undefined symbol: ${s.name}`, detail: refs.map((r) => `referenced by ${r}`) });
      } else undefinedWeak.add(s.name);
    }
  });
  return { defs, undefinedWeak, errors };
}

/** A real linker reports an undefined symbol only if a relocation uses it. Synthetic objects list no relocations for declarations alone. */
const usedByReloc = (o: ObjFile, sym: number) => o.relocs.some((r) => r.sym === sym);

// ---------------------------------------------------------------- garbage collection

export interface SectionRef { file: number; section: number }
export const secKey = (r: SectionRef) => `${r.file}:${r.section}`;

export interface GcStep {
  section: SectionRef;
  /** Why it is live: the entry point, or a relocation from a live section. */
  reason: string;
}

/** The section (in some file) that a relocation reaches, after symbol resolution. */
function relocTarget(objs: ObjFile[], res: Resolution, fi: number, r: ObjReloc): SectionRef | null {
  const s = objs[fi]!.symbols[r.sym]!;
  if (s.bind === "LOCAL") return s.shndx > 0 && s.shndx < 0xff00 ? { file: fi, section: s.shndx } : null;
  const d = res.defs.get(s.name);
  if (!d) return null;
  const ds = objs[d.file]!.symbols[d.sym]!;
  if (ds.shndx === SHN_COMMON) return { file: d.file, section: -1 - d.sym };
  return ds.shndx > 0 && ds.shndx < 0xff00 ? { file: d.file, section: ds.shndx } : null;
}

const isAlloc = (o: ObjFile, i: number) => !!(o.sections[i]!.flags & SHF.ALLOC);

/** Mark phase of --gc-sections: a breadth-first walk from the section that holds the entry symbol. */
export function gcSections(objs: ObjFile[], res: Resolution, entry = "main"): GcStep[] {
  const d = res.defs.get(entry);
  if (!d) return [];
  const start = { file: d.file, section: objs[d.file]!.symbols[d.sym]!.shndx };
  const steps: GcStep[] = [{ section: start, reason: `the entry symbol ${entry} is here` }];
  const seen = new Set([secKey(start)]);
  for (let q = 0; q < steps.length; q++) {
    const cur = steps[q]!.section;
    if (cur.section < 0) continue;
    const o = objs[cur.file]!;
    for (const r of o.relocs) {
      if (r.target !== cur.section) continue;
      const t = relocTarget(objs, res, cur.file, r);
      if (!t || seen.has(secKey(t))) continue;
      seen.add(secKey(t));
      steps.push({ section: t, reason: `${sectionLabel(objs, cur)} refers to ${o.symbols[r.sym]!.name}` });
    }
  }
  return steps;
}

export function sectionLabel(objs: ObjFile[], r: SectionRef): string {
  const o = objs[r.file]!;
  if (r.section < 0) return `${o.name}(COMMON ${o.symbols[-1 - r.section]!.name})`;
  return `${o.name}(${o.sections[r.section]!.name})`;
}

// ---------------------------------------------------------------- layout

export function outputOf(name: string): OutName | null {
  for (const p of [".text", ".rodata", ".data", ".bss"] as const) if (name === p || name.startsWith(p + ".")) return p;
  return null;
}

export interface Placed {
  ref: SectionRef;
  name: string;
  out: OutName;
  addr: number;
  size: number;
  align: number;
}

export interface OutSection {
  name: OutName;
  addr: number;
  size: number;
  align: number;
  /** File bytes (empty for .bss). */
  bytes: Uint8Array;
  inputs: Placed[];
}

export interface RelocStep {
  file: string;
  section: string;
  offset: number;
  type: string;
  symbol: string;
  S: number;
  A: number;
  P: number;
  /** The GOT entry address, for GOT-relative types. */
  G?: number;
  formula: string;
  value: number;
  width: number;
  before: number[];
  after: number[];
  /** The linker rewrote the instruction (mov → lea). */
  relaxed?: string;
  error?: string;
}

export interface LinkOptions {
  entry?: string;
  gcSections?: boolean;
  /** GOTPCRELX relaxation (default on; --no-relax turns it off). */
  relax?: boolean;
  /** Fixed output section addresses, like --section-start. */
  sectionStart?: Partial<Record<OutName, number>>;
}

export interface LinkResult {
  ok: boolean;
  errors: LinkError[];
  resolution: Resolution;
  gc: GcStep[] | null;
  kept: Set<string>;
  sections: OutSection[];
  /** Final address of each global and local symbol, by "file:name" for locals and by name for globals. */
  symbols: Map<string, number>;
  relocs: RelocStep[];
  got: { symbol: string; addr: number }[];
  /** Number of program headers, which sets where the first section starts. */
  phnum: number;
}

const alignTo = (x: number, a: number) => (a > 1 ? Math.ceil(x / a) * a : x);

const GOT_TYPES = new Set<number>([R_X86_64.GOTPCREL, R_X86_64.GOTPCRELX, R_X86_64.REX_GOTPCRELX]);

export function link(objs: ObjFile[], opts: LinkOptions = {}): LinkResult {
  const entry = opts.entry ?? "main";
  const relax = opts.relax ?? true;
  const res = resolveSymbols(objs);
  const errors = [...res.errors];

  // Which sections stay.
  let gc: GcStep[] | null = null;
  const kept = new Set<string>();
  if (opts.gcSections) {
    gc = gcSections(objs, res, entry);
    for (const s of gc) kept.add(secKey(s.section));
  } else {
    objs.forEach((o, fi) => o.sections.forEach((_, i) => { if (i > 0 && isAlloc(o, i)) kept.add(secKey({ file: fi, section: i })); }));
    res.defs.forEach((d) => { if (d.kind === "common") kept.add(secKey({ file: d.file, section: -1 - d.sym })); });
  }

  // GOT entries: one for each symbol that a GOT relocation uses and that relaxation cannot remove.
  const gotSyms: string[] = [];
  let anyGotReloc = false;
  objs.forEach((o, fi) => {
    for (const r of o.relocs) {
      if (!kept.has(secKey({ file: fi, section: r.target })) || !GOT_TYPES.has(r.type)) continue;
      anyGotReloc = true;
      const op = o.sections[r.target]!.data[r.offset - 2];
      const relaxable = relax && r.type !== R_X86_64.GOTPCREL && op === 0x8b;
      const name = o.symbols[r.sym]!.name;
      if (!relaxable && !gotSyms.includes(name)) gotSyms.push(name);
    }
  });

  // Input sections in command-line order, grouped by output section. COMMON symbols go at the end of .bss.
  const groups = new Map<OutName, Placed[]>(OUT_ORDER.map((n) => [n, []]));
  objs.forEach((o, fi) => o.sections.forEach((s, i) => {
    if (!kept.has(secKey({ file: fi, section: i }))) return;
    const out = outputOf(s.name);
    if (out) groups.get(out)!.push({ ref: { file: fi, section: i }, name: s.name, out, addr: 0, size: s.size, align: Math.max(1, s.align) });
  }));
  res.defs.forEach((d) => {
    if (d.kind !== "common" || !kept.has(secKey({ file: d.file, section: -1 - d.sym }))) return;
    const s = objs[d.file]!.symbols[d.sym]!;
    groups.get(".bss")!.push({ ref: { file: d.file, section: -1 - d.sym }, name: `COMMON ${s.name}`, out: ".bss", addr: 0, size: s.size, align: Math.max(1, s.value) });
  });

  const present = OUT_ORDER.filter((n) => (n === ".got" ? anyGotReloc : groups.get(n)!.length > 0));
  // Segments: R (headers, .rodata), RX (.text), RW RELRO (.got), RW (.data, .bss).
  const seg = (n: OutName) => (n === ".rodata" ? 0 : n === ".text" ? 1 : n === ".got" ? 2 : 3);
  const segs = new Set(present.map(seg));
  segs.add(0);
  const relro = segs.has(2);
  const phnum = 2 + segs.size + (relro ? 1 : 0); // PT_PHDR, PT_GNU_STACK, the PT_LOADs, PT_GNU_RELRO
  let va = IMAGE_BASE + EHDR + phnum * PHDR;
  let off = EHDR + phnum * PHDR;
  let curSeg = 0;
  const sections: OutSection[] = [];
  for (const n of present) {
    const list = groups.get(n)!;
    const align = n === ".got" ? 8 : Math.max(1, ...list.map((p) => p.align));
    if (seg(n) !== curSeg) {
      va = alignTo(va, PAGE) + (off % PAGE);
      curSeg = seg(n);
    }
    const fixed = opts.sectionStart?.[n];
    if (fixed !== undefined) va = fixed;
    va = alignTo(va, align);
    off = alignTo(off, align);
    const start = va;
    let size = 0;
    if (n === ".got") size = gotSyms.length * 8;
    for (const p of list) {
      size = alignTo(size, p.align);
      p.addr = start + size;
      size += p.size;
    }
    const nobits = n === ".bss";
    const bytes = new Uint8Array(nobits ? 0 : size);
    if (n === ".text") bytes.fill(0xcc); // ld.lld fills gaps in x86 code with int3
    for (const p of list) if (p.ref.section >= 0 && !nobits) bytes.set(objs[p.ref.file]!.sections[p.ref.section]!.data, p.addr - start);
    sections.push({ name: n, addr: start, size, align, bytes, inputs: list });
    va = start + size;
    if (!nobits) off += size;
    if (n === ".got") va = alignTo(va, PAGE); // .relro_padding: the RELRO region ends on a page boundary
  }

  // Symbol addresses.
  const secAddr = new Map<string, number>();
  for (const s of sections) for (const p of s.inputs) secAddr.set(secKey(p.ref), p.addr);
  const symAddr = (fi: number, s: ObjSymbol): number | null => {
    if (s.shndx === SHN_ABS) return s.value;
    if (s.shndx === SHN_COMMON) return secAddr.get(secKey({ file: fi, section: -1 - s.index })) ?? null;
    if (s.shndx === SHN_UNDEF) return null;
    const a = secAddr.get(secKey({ file: fi, section: s.shndx }));
    return a === undefined ? null : a + s.value;
  };
  const symbols = new Map<string, number>();
  objs.forEach((o, fi) => {
    for (const s of o.symbols) {
      if (s.index === 0 || s.type === "FILE" || s.type === "SECTION") continue;
      const a = symAddr(fi, s);
      if (a === null) continue;
      if (s.bind === "LOCAL") symbols.set(`${o.name}:${s.name}`, a);
      else {
        const d = res.defs.get(s.name);
        if (d && d.file === fi && d.sym === s.index) symbols.set(s.name, a);
      }
    }
  });
  const resolveS = (fi: number, s: ObjSymbol): number | null => {
    if (s.bind === "LOCAL") return symAddr(fi, s);
    const d = res.defs.get(s.name);
    if (!d) return res.undefinedWeak.has(s.name) ? 0 : null;
    return symAddr(d.file, objs[d.file]!.symbols[d.sym]!);
  };

  const got = sections.find((s) => s.name === ".got");
  const gotList = gotSyms.map((name, i) => ({ symbol: name, addr: (got?.addr ?? 0) + 8 * i }));

  // Relocation.
  const relocs: RelocStep[] = [];
  const outOf = (ref: SectionRef) => sections.find((s) => s.inputs.some((p) => secKey(p.ref) === secKey(ref)));
  objs.forEach((o, fi) => {
    for (const r of o.relocs) {
      const ref = { file: fi, section: r.target };
      if (!kept.has(secKey(ref)) || !isAlloc(o, r.target)) continue;
      const os = outOf(ref);
      if (!os) continue;
      const base = secAddr.get(secKey(ref))!;
      const sym = o.symbols[r.sym]!;
      const S = resolveS(fi, sym);
      if (S === null) continue; // already reported as undefined
      const P = base + r.offset;
      const A = r.addend;
      const width = r.type === R_X86_64["64"] ? 8 : 4;
      const at = P - os.addr;
      const before = os.name === ".bss" ? [] : Array.from(os.bytes.subarray(at, at + width));
      let value: number, formula: string, G: number | undefined, relaxed: string | undefined;
      switch (r.type) {
        case R_X86_64["64"]: value = S + A; formula = "S + A"; break;
        case R_X86_64["32"]: case R_X86_64["32S"]: value = S + A; formula = "S + A"; break;
        case R_X86_64.PC32: value = S + A - P; formula = "S + A - P"; break;
        case R_X86_64.PLT32: value = S + A - P; formula = "L + A - P, and L = S in a static link"; break;
        default: {
          const op = os.bytes[at - 2];
          if (relax && r.type !== R_X86_64.GOTPCREL && op === 0x8b) {
            os.bytes[at - 2] = 0x8d;
            relaxed = "mov reg, [rip + GOT slot] → lea reg, [rip + symbol]";
            value = S + A - P;
            formula = "S + A - P (relaxed: no GOT slot)";
          } else {
            G = gotList.find((g) => g.symbol === sym.name)!.addr;
            value = G + A - P;
            formula = "G + GOT + A - P, with G + GOT the slot address";
            const gi = G - got!.addr;
            new DataView(got!.bytes.buffer).setBigUint64(gi, BigInt(S), true);
          }
        }
      }
      const step: RelocStep = { file: o.name, section: o.sections[r.target]!.name, offset: r.offset, type: relocName(r.type), symbol: sym.name, S, A, P, G, formula, value, width, before, after: [], relaxed };
      const range = r.type === R_X86_64["32"] ? [0, 2 ** 32 - 1] : r.type === R_X86_64["64"] ? null : [-(2 ** 31), 2 ** 31 - 1];
      if (range && (value < range[0]! || value > range[1]!)) {
        const fn = o.symbols.find((x) => x.type === "FUNC" && x.shndx === r.target && r.offset >= x.value && r.offset < x.value + x.size);
        const where = `${o.name}:(${fn ? `function ${fn.name}: ` : ""}${o.sections[r.target]!.name}+0x${r.offset.toString(16)})`;
        const what = sym.type === "SECTION" ? `section '${sym.name}'` : `'${sym.name}'`;
        step.error = `${where}: relocation ${step.type} out of range: ${value} is not in [${range[0]}, ${range[1]}]; references ${what}`;
        errors.push({ text: step.error, detail: [] });
      } else if (os.name !== ".bss") {
        const dv = new DataView(os.bytes.buffer);
        if (width === 8) dv.setBigUint64(at, BigInt.asUintN(64, BigInt(value)), true);
        else dv.setUint32(at, value >>> 0, true);
      }
      step.after = os.name === ".bss" ? [] : Array.from(os.bytes.subarray(at, at + width));
      relocs.push(step);
    }
  });

  return { ok: errors.length === 0, errors, resolution: res, gc, kept, sections, symbols, relocs, got: gotList, phnum };
}

export const le = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
