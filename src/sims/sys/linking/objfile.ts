/**
 * A reader for ELF64 relocatable objects (ET_REL), the files that a compiler writes and a linker reads.
 *
 * It decodes the parts that a linker uses: the ELF header, the section headers, the symbol table, the string
 * tables and the RELA relocation sections. It also labels every byte with the field that holds it, so that a view
 * can explain a real .o file byte by byte. The OS track has a reader for executables (src/sims/os/processes/elf.ts);
 * this one is for the linker's input, which has no program headers.
 *
 * Constants and layouts: System V gABI, chapter 4 (ELF header, sections, symbol table, relocation), and the
 * x86-64 psABI, section 4.4 (relocation types).
 */

export const SHT: Record<number, string> = { 0: "NULL", 1: "PROGBITS", 2: "SYMTAB", 3: "STRTAB", 4: "RELA", 8: "NOBITS", 17: "GROUP" };
export const SHF = { WRITE: 1, ALLOC: 2, EXECINSTR: 4, MERGE: 0x10, STRINGS: 0x20, INFO_LINK: 0x40, GROUP: 0x200 } as const;
export const STB = ["LOCAL", "GLOBAL", "WEAK"] as const;
export const STT = ["NOTYPE", "OBJECT", "FUNC", "SECTION", "FILE"] as const;
export const STV = ["DEFAULT", "INTERNAL", "HIDDEN", "PROTECTED"] as const;
export const SHN_UNDEF = 0;
export const SHN_ABS = 0xfff1;
export const SHN_COMMON = 0xfff2;

/** x86-64 relocation types (psABI table 4.10). Only the ones that the lessons use. */
export const R_X86_64 = {
  NONE: 0, "64": 1, PC32: 2, GOT32: 3, PLT32: 4, COPY: 5, GLOB_DAT: 6, JUMP_SLOT: 7, RELATIVE: 8, GOTPCREL: 9,
  "32": 10, "32S": 11, GOTPCRELX: 41, REX_GOTPCRELX: 42,
} as const;
export type RelocName = keyof typeof R_X86_64;
export const relocName = (t: number): string => {
  const e = Object.entries(R_X86_64).find(([, v]) => v === t);
  return e ? `R_X86_64_${e[0]}` : `type ${t}`;
};

export type Bind = (typeof STB)[number];
export type SymType = (typeof STT)[number];
export type Visibility = (typeof STV)[number];

export interface ObjSection {
  index: number;
  name: string;
  type: number;
  flags: number;
  offset: number;
  size: number;
  link: number;
  info: number;
  align: number;
  entsize: number;
  /** The section's bytes in the file. Empty for NOBITS (.bss). */
  data: Uint8Array;
}

export interface ObjSymbol {
  index: number;
  name: string;
  value: number;
  size: number;
  bind: Bind;
  type: SymType;
  vis: Visibility;
  /** Section index, or SHN_UNDEF, SHN_ABS, SHN_COMMON. */
  shndx: number;
}

export interface ObjReloc {
  /** The section that the relocation patches (sh_info of its RELA section). */
  target: number;
  offset: number;
  type: number;
  sym: number;
  addend: number;
}

export type FieldGroup = "ehdr" | "shdr" | "code" | "data" | "rela" | "symtab" | "strtab" | "pad";

export interface ByteField {
  offset: number;
  size: number;
  group: FieldGroup;
  name: string;
  value: string;
  explain: string;
  /** Index of the section, symbol or relocation that the field belongs to, for cross-highlighting. */
  section?: number;
  symbol?: number;
  reloc?: number;
}

export interface ObjFile {
  name: string;
  bytes: Uint8Array;
  sections: ObjSection[];
  symbols: ObjSymbol[];
  relocs: ObjReloc[];
  /** e_shstrndx: the section that holds the section names. */
  shstrndx: number;
  fields: ByteField[];
}

export const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};

const hx = (n: number | bigint) => `0x${n.toString(16)}`;

function cstr(b: Uint8Array, off: number): string {
  let s = "";
  for (let i = off; i < b.length && b[i] !== 0; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** Instruction lists for the .text of the golden objects, from llvm-objdump 22.1.8 (Intel syntax). */
export interface Insn { offset: number; size: number; text: string }

export function parseObject(name: string, bytes: Uint8Array, disasm: Insn[] = []): ObjFile {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  const u64 = (o: number) => Number(dv.getBigUint64(o, true));
  const i64 = (o: number) => Number(dv.getBigInt64(o, true));
  if (u32(0) !== 0x464c457f) throw new Error(`${name}: not an ELF file`);
  if (u16(16) !== 1) throw new Error(`${name}: not a relocatable file (e_type ${u16(16)})`);

  const shoff = u64(0x28), shentsize = u16(0x3a), shnum = u16(0x3c), shstrndx = u16(0x3e);
  const raw = Array.from({ length: shnum }, (_, i) => {
    const o = shoff + i * shentsize;
    return { nameOff: u32(o), type: u32(o + 4), flags: u64(o + 8), offset: u64(o + 0x18), size: u64(o + 0x20), link: u32(o + 0x28), info: u32(o + 0x2c), align: u64(o + 0x30), entsize: u64(o + 0x38) };
  });
  const shstr = raw[shstrndx]!;
  const sections: ObjSection[] = raw.map((r, index) => ({
    index, name: cstr(bytes, shstr.offset + r.nameOff), type: r.type, flags: r.flags, offset: r.offset, size: r.size,
    link: r.link, info: r.info, align: r.align, entsize: r.entsize,
    data: r.type === 8 ? new Uint8Array(0) : bytes.subarray(r.offset, r.offset + r.size),
  }));

  const symtab = sections.find((s) => s.type === 2);
  const symbols: ObjSymbol[] = [];
  if (symtab) {
    const strtab = sections[symtab.link]!;
    for (let i = 0; i < symtab.size / 24; i++) {
      const o = symtab.offset + i * 24;
      const info = bytes[o + 4]!, other = bytes[o + 5]!, shndx = u16(o + 6);
      const type = STT[info & 0xf] ?? "NOTYPE";
      let symName = cstr(bytes, strtab.offset + u32(o));
      if (type === "SECTION") symName = sections[shndx]?.name ?? symName;
      symbols.push({ index: i, name: symName, value: u64(o + 8), size: u64(o + 16), bind: STB[info >> 4] ?? "LOCAL", type, vis: STV[other & 3]!, shndx });
    }
  }

  const relocs: ObjReloc[] = [];
  const relocOwner: number[] = [];
  for (const s of sections.filter((x) => x.type === 4)) {
    for (let i = 0; i < s.size / 24; i++) {
      const o = s.offset + i * 24;
      const info = dv.getBigUint64(o + 8, true);
      relocs.push({ target: s.info, offset: u64(o), type: Number(info & 0xffffffffn), sym: Number(info >> 32n), addend: i64(o + 16) });
      relocOwner.push(s.index);
    }
  }

  const obj: ObjFile = { name, bytes, sections, symbols, relocs, shstrndx, fields: [] };
  obj.fields = annotate(obj, dv, disasm, relocOwner);
  return obj;
}

const flagText = (f: number) => [f & SHF.WRITE ? "W" : "", f & SHF.ALLOC ? "A" : "", f & SHF.EXECINSTR ? "X" : "", f & SHF.MERGE ? "M" : "", f & SHF.STRINGS ? "S" : "", f & SHF.INFO_LINK ? "I" : "", f & SHF.GROUP ? "G" : ""].join("") || "none";

export const shndxName = (o: ObjFile, n: number) => (n === SHN_UNDEF ? "UND" : n === SHN_ABS ? "ABS" : n === SHN_COMMON ? "COM" : (o.sections[n]?.name ?? String(n)));

function annotate(o: ObjFile, dv: DataView, disasm: Insn[], relocOwner: number[]): ByteField[] {
  const f: ByteField[] = [];
  const b = o.bytes;
  const u16 = (x: number) => dv.getUint16(x, true);
  const u32 = (x: number) => dv.getUint32(x, true);
  const u64 = (x: number) => dv.getBigUint64(x, true);
  const add = (x: Omit<ByteField, "value"> & { value?: string }) => f.push({ value: "", ...x });

  // ELF header (gABI "ELF Header").
  add({ offset: 0, size: 4, group: "ehdr", name: "e_ident[EI_MAG]", value: "7f 'E' 'L' 'F'", explain: "The magic number. Every ELF file starts with these four bytes." });
  add({ offset: 4, size: 1, group: "ehdr", name: "EI_CLASS", value: "2 (ELFCLASS64)", explain: "64-bit file: addresses and offsets are 8 bytes." });
  add({ offset: 5, size: 1, group: "ehdr", name: "EI_DATA", value: "1 (little-endian)", explain: "Multi-byte numbers have their lowest byte first." });
  add({ offset: 6, size: 10, group: "ehdr", name: "EI_VERSION, EI_OSABI, padding", value: "1, 0 (System V)", explain: "Version 1 of the format, the System V ABI, then zero padding to 16 bytes." });
  add({ offset: 16, size: 2, group: "ehdr", name: "e_type", value: `${u16(16)} (ET_REL)`, explain: "A relocatable file. A linker must still combine it with others. An executable is ET_EXEC, and a PIE or a shared library is ET_DYN." });
  add({ offset: 18, size: 2, group: "ehdr", name: "e_machine", value: `${u16(18)} (EM_X86_64)`, explain: "The CPU. The linker refuses to mix objects for different machines." });
  add({ offset: 20, size: 4, group: "ehdr", name: "e_version", value: "1", explain: "Always 1." });
  add({ offset: 24, size: 8, group: "ehdr", name: "e_entry", value: "0", explain: "No entry point: only the linker chooses one, for the output file." });
  add({ offset: 32, size: 8, group: "ehdr", name: "e_phoff", value: "0", explain: "No program headers. A .o file is never loaded, so it has no segments." });
  add({ offset: 40, size: 8, group: "ehdr", name: "e_shoff", value: hx(u64(40)), explain: "File offset of the section header table, here at the end of the file." });
  add({ offset: 48, size: 4, group: "ehdr", name: "e_flags", value: "0", explain: "No processor-specific flags on x86-64." });
  add({ offset: 52, size: 2, group: "ehdr", name: "e_ehsize", value: String(u16(52)), explain: "Size of this header: 64 bytes." });
  add({ offset: 54, size: 4, group: "ehdr", name: "e_phentsize, e_phnum", value: `${u16(54)}, ${u16(56)}`, explain: "Size and count of program headers: zero for a relocatable file." });
  add({ offset: 58, size: 2, group: "ehdr", name: "e_shentsize", value: String(u16(58)), explain: "Each section header is 64 bytes." });
  add({ offset: 60, size: 2, group: "ehdr", name: "e_shnum", value: String(u16(60)), explain: "Number of section headers, including the null entry at index 0." });
  add({ offset: 62, size: 2, group: "ehdr", name: "e_shstrndx", value: String(u16(62)), explain: `Index of the section that holds the section names: ${o.sections[u16(62)]?.name}.` });

  // Section headers.
  const shoff = Number(u64(40));
  for (const s of o.sections) {
    const base = shoff + s.index * 64;
    const label = s.index === 0 ? "null section" : s.name;
    const parts: [number, number, string, string, string][] = [
      [0, 4, "sh_name", `${u32(base)} → "${s.name}"`, "Offset of the name in the section-name string table."],
      [4, 4, "sh_type", `${s.type} (SHT_${SHT[s.type] ?? s.type})`, typeExplain(s.type)],
      [8, 8, "sh_flags", flagText(s.flags), "A: takes memory at run time. W: writable. X: code. I: sh_info holds a section index."],
      [16, 8, "sh_addr", "0", "No address yet. The linker assigns addresses."],
      [24, 8, "sh_offset", hx(s.offset), "Where the section's bytes start in this file."],
      [32, 8, "sh_size", `${s.size}`, s.type === 8 ? "Size in memory. NOBITS takes no bytes in the file." : "Size in bytes."],
      [40, 4, "sh_link", String(s.link), s.type === 2 ? "The string table for symbol names." : s.type === 4 ? "The symbol table that the relocations use." : "Not used."],
      [44, 4, "sh_info", String(s.info), s.type === 4 ? `The section that these relocations patch: ${o.sections[s.info]?.name}.` : s.type === 2 ? "Index of the first non-local symbol. Locals come first." : "Not used."],
      [48, 8, "sh_addralign", String(s.align), "The linker places the section at a multiple of this."],
      [56, 8, "sh_entsize", String(s.entsize), "Size of one entry, for tables. RELA and SYMTAB entries are 24 bytes."],
    ];
    for (const [off, size, n, v, e] of parts) add({ offset: base + off, size, group: "shdr", name: `[${s.index}] ${label}: ${n}`, value: v, explain: e, section: s.index });
  }

  // Section contents.
  for (const s of o.sections) {
    if (s.index === 0 || s.size === 0 || s.type === 8) continue;
    if (s.type === 1 && s.flags & SHF.EXECINSTR) {
      const relocAt = new Map<number, number>();
      o.relocs.forEach((r, i) => { if (r.target === s.index) relocAt.set(r.offset, i); });
      const list = disasm.length ? disasm : [{ offset: 0, size: s.size, text: "machine code" }];
      for (const ins of list) {
        let p = ins.offset;
        const end = ins.offset + ins.size;
        for (let k = ins.offset; k < end; k++) {
          const ri = relocAt.get(k);
          if (ri === undefined) continue;
          const r = o.relocs[ri]!;
          const w = relocWidth(r.type);
          if (k > p) add({ offset: s.offset + p, size: k - p, group: "code", name: `${s.name}+${hx(ins.offset)}: ${ins.text}`, value: hexOf(b, s.offset + p, k - p), explain: "Instruction bytes: opcode and operands.", section: s.index });
          add({ offset: s.offset + k, size: w, group: "code", name: `${s.name}+${hx(k)}: hole for ${relocName(r.type)}`, value: hexOf(b, s.offset + k, w), explain: `The compiler does not know this value, so it writes zeros. Relocation #${ri} tells the linker to fill it with the address of ${o.symbols[r.sym]?.name}.`, section: s.index, reloc: ri });
          p = k + w;
          k = p - 1;
        }
        if (end > p) add({ offset: s.offset + p, size: end - p, group: "code", name: `${s.name}+${hx(ins.offset)}: ${ins.text}`, value: hexOf(b, s.offset + p, end - p), explain: "Instruction bytes: opcode and operands.", section: s.index });
      }
    } else if (s.type === 1) {
      const relocAt = o.relocs.map((r, i) => [r, i] as const).filter(([r]) => r.target === s.index);
      let p = 0;
      for (const [r, ri] of relocAt) {
        if (r.offset > p) add({ offset: s.offset + p, size: r.offset - p, group: "data", name: `${s.name}+${hx(p)}`, value: hexOf(b, s.offset + p, r.offset - p), explain: "Initial values of global variables.", section: s.index });
        const w = relocWidth(r.type);
        add({ offset: s.offset + r.offset, size: w, group: "data", name: `${s.name}+${hx(r.offset)}: hole for ${relocName(r.type)}`, value: hexOf(b, s.offset + r.offset, w), explain: `An initial value that is an address. Relocation #${ri} fills it with the address of ${o.symbols[r.sym]?.name}.`, section: s.index, reloc: ri });
        p = r.offset + w;
      }
      if (s.size > p) add({ offset: s.offset + p, size: s.size - p, group: "data", name: `${s.name}+${hx(p)}`, value: hexOf(b, s.offset + p, s.size - p), explain: "Initial values of global variables.", section: s.index });
    } else if (s.type === 4) {
      const first = o.relocs.findIndex((_, i) => relocOwner[i] === s.index);
      for (let i = 0; i < s.size / 24; i++) {
        const ri = first + i, r = o.relocs[ri]!, e = s.offset + i * 24;
        const sym = o.symbols[r.sym]!;
        add({ offset: e, size: 8, group: "rela", name: `${s.name} #${ri}: r_offset`, value: hx(r.offset), explain: `Patch ${o.sections[s.info]?.name} at this offset.`, section: s.index, reloc: ri });
        add({ offset: e + 8, size: 4, group: "rela", name: `${s.name} #${ri}: r_info (type)`, value: `${r.type} (${relocName(r.type)})`, explain: "The low 32 bits of r_info: the formula to use.", section: s.index, reloc: ri });
        add({ offset: e + 12, size: 4, group: "rela", name: `${s.name} #${ri}: r_info (symbol)`, value: `${r.sym} (${sym.name})`, explain: "The high 32 bits of r_info: an index into .symtab.", section: s.index, reloc: ri, symbol: r.sym });
        add({ offset: e + 16, size: 8, group: "rela", name: `${s.name} #${ri}: r_addend`, value: String(r.addend), explain: r.addend === -4 ? "A = -4. The CPU adds the address of the next instruction, which is 4 bytes after the hole." : "A, the constant to add.", section: s.index, reloc: ri });
      }
    } else if (s.type === 2) {
      for (const sym of o.symbols) {
        const e = s.offset + sym.index * 24;
        const nm = sym.index === 0 ? "null symbol" : sym.name;
        add({ offset: e, size: 4, group: "symtab", name: `sym ${sym.index} ${nm}: st_name`, value: String(u32(e)), explain: "Offset of the name in .strtab.", section: s.index, symbol: sym.index });
        add({ offset: e + 4, size: 1, group: "symtab", name: `sym ${sym.index} ${nm}: st_info`, value: `${sym.bind} ${sym.type}`, explain: "High 4 bits: binding (LOCAL, GLOBAL, WEAK). Low 4 bits: type (FUNC, OBJECT, SECTION...).", section: s.index, symbol: sym.index });
        add({ offset: e + 5, size: 1, group: "symtab", name: `sym ${sym.index} ${nm}: st_other`, value: sym.vis, explain: "Visibility: DEFAULT, HIDDEN or PROTECTED.", section: s.index, symbol: sym.index });
        add({ offset: e + 6, size: 2, group: "symtab", name: `sym ${sym.index} ${nm}: st_shndx`, value: shndxName(o, sym.shndx), explain: sym.shndx === SHN_UNDEF && sym.index > 0 ? "UND: this file uses the symbol but does not define it. The linker must find it in another file." : "The section that holds the symbol.", section: s.index, symbol: sym.index });
        add({ offset: e + 8, size: 8, group: "symtab", name: `sym ${sym.index} ${nm}: st_value`, value: hx(sym.value), explain: "Offset inside its section. The linker turns it into an address.", section: s.index, symbol: sym.index });
        add({ offset: e + 16, size: 8, group: "symtab", name: `sym ${sym.index} ${nm}: st_size`, value: String(sym.size), explain: "Size in bytes of the function or object.", section: s.index, symbol: sym.index });
      }
    } else if (s.type === 3) {
      let p = 0;
      while (p < s.size) {
        const str = cstr(b, s.offset + p);
        add({ offset: s.offset + p, size: str.length + 1, group: "strtab", name: `${s.name}+${p}`, value: str ? `"${str}"` : '""', explain: "A name, ended by a zero byte. Symbols and sections refer to it by its offset.", section: s.index });
        p += str.length + 1;
      }
    }
  }

  // Padding: bytes that no field covers.
  f.sort((x, y) => x.offset - y.offset);
  const pads: ByteField[] = [];
  let at = 0;
  for (const x of f) {
    if (x.offset > at) pads.push({ offset: at, size: x.offset - at, group: "pad", name: "padding", value: `${x.offset - at} bytes`, explain: "Zero bytes that align the next part of the file." });
    at = Math.max(at, x.offset + x.size);
  }
  if (at < b.length) pads.push({ offset: at, size: b.length - at, group: "pad", name: "padding", value: `${b.length - at} bytes`, explain: "Zero bytes." });
  return [...f, ...pads].sort((x, y) => x.offset - y.offset);
}

function typeExplain(t: number): string {
  switch (t) {
    case 0: return "The null section at index 0. Index 0 means 'no section'.";
    case 1: return "PROGBITS: bytes that the program uses, such as code or initialized data.";
    case 2: return "SYMTAB: the symbol table.";
    case 3: return "STRTAB: a list of names, each ended by a zero byte.";
    case 4: return "RELA: relocation entries with explicit addends.";
    case 8: return "NOBITS: zero-filled memory. It takes no space in the file.";
    default: return "Another section type.";
  }
}

export function relocWidth(type: number): number {
  return type === R_X86_64["64"] ? 8 : 4;
}

export const hexOf = (b: Uint8Array, off: number, n: number) => Array.from(b.subarray(off, off + n), (x) => x.toString(16).padStart(2, "0")).join(" ");

/** The field that holds byte `off`. */
export const fieldAt = (o: ObjFile, off: number) => o.fields.find((x) => off >= x.offset && off < x.offset + x.size);
