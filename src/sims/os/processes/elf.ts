/**
 * A real ELF64 image, built byte by byte, with every field recorded at its true offset.
 *
 * The program is a small x86-64 PIE that calls puts twice and exit once through the PLT:
 *
 *   _start:
 *     lea  rdi, [rip + msg]
 *     call puts@plt
 *     lea  rdi, [rip + msg]
 *     call puts@plt
 *     xor  edi, edi
 *     call exit@plt
 *
 * Simplifications against the output of a normal linker: no symbol versions, no .eh_frame, no crt files,
 * and no PT_GNU_RELRO. The file is compact: offsets and addresses agree modulo the page size, but several
 * segments share file pages, as with the linker flag -z noseparate-code.
 */

export type ElfGroup = "ehdr" | "phdr" | "interp" | "hash" | "dynsym" | "dynstr" | "rela" | "rodata" | "plt" | "text" | "dynamic" | "got" | "data" | "shstrtab" | "shdr";

export interface ElfField {
  offset: number;
  size: number;
  name: string;
  group: ElfGroup;
  /** The decoded value, for display. */
  value: string;
  explain: string;
}

export const PT = { NULL: 0, LOAD: 1, DYNAMIC: 2, INTERP: 3, PHDR: 6, GNU_STACK: 0x6474e551 } as const;
export const PF = { X: 1, W: 2, R: 4 } as const;
export const DT = { NULL: 0, NEEDED: 1, PLTRELSZ: 2, PLTGOT: 3, HASH: 4, STRTAB: 5, SYMTAB: 6, STRSZ: 10, SYMENT: 11, PLTREL: 20, JMPREL: 23 } as const;
export const R_X86_64_JUMP_SLOT = 7;
export const ET_DYN = 3;
export const EM_X86_64 = 62;
export const INTERP_PATH = "/lib64/ld-linux-x86-64.so.2";
export const EHDR_SIZE = 64;
export const PHDR_SIZE = 56;
export const SHDR_SIZE = 64;
export const PAGE = 0x1000;
const RX_DELTA = 0x1000;
const RW_DELTA = 0x2000;
/** Bytes of .bss: a real program's zero-initialized globals. */
export const BSS_SIZE = 0x2000;
export const MESSAGE = "hi from lab";

export interface ProgramHeader { type: number; flags: number; offset: number; vaddr: number; filesz: number; memsz: number; align: number }
export interface SectionHeader { name: string; type: number; flags: number; addr: number; offset: number; size: number; link: number; info: number; addralign: number; entsize: number }

export interface ElfImage {
  bytes: Uint8Array;
  fields: ElfField[];
  entry: number;
  phdrs: ProgramHeader[];
  sections: SectionHeader[];
  /** Virtual addresses, relative to the load base. */
  sym: { plt0: number; pltPuts: number; pltExit: number; start: number; msg: number; gotPlt: number; dynamic: number; relaPlt: number; dynsym: number; dynstr: number };
  /** Field lookup: the field that holds each byte. */
  fieldAt: (offset: number) => ElfField | undefined;
}

const hex = (n: number | bigint) => `0x${n.toString(16)}`;

function typeName(t: number): string {
  return Object.entries(PT).find(([, v]) => v === t)?.[0] ?? hex(t);
}
function flagName(f: number): string {
  return `${f & PF.R ? "R" : "-"}${f & PF.W ? "W" : "-"}${f & PF.X ? "X" : "-"}`;
}

export function buildElf(): ElfImage {
  // ----- Layout. First compute all offsets, then write the bytes.
  const interpBytes = INTERP_PATH.length + 1;
  const dynstr = "\0libc.so.6\0puts\0exit\0";
  const strOff = { libc: 1, puts: 11, exit: 16 };
  const phnum = 7;
  const offInterp = EHDR_SIZE + phnum * PHDR_SIZE;
  const align = (x: number, a: number) => Math.ceil(x / a) * a;
  const offHash = align(offInterp + interpBytes, 8);
  const hashSize = 4 * (2 + 1 + 3);
  const offDynsym = offHash + hashSize;
  const dynsymSize = 3 * 24;
  const offDynstr = offDynsym + dynsymSize;
  const offRela = align(offDynstr + dynstr.length, 8);
  const relaSize = 2 * 24;
  const offRodata = offRela + relaSize;
  const rodataSize = MESSAGE.length + 1;
  const roEnd = offRodata + rodataSize;
  const offPlt = align(roEnd, 16);
  const pltSize = 3 * 16;
  const offText = offPlt + pltSize;
  const textSize = 7 + 5 + 7 + 5 + 2 + 5;
  const rxEnd = offText + textSize;
  const offDynamic = align(rxEnd, 8);
  const dynamicCount = 11;
  const dynamicSize = dynamicCount * 16;
  const offGot = offDynamic + dynamicSize;
  const gotSize = 5 * 8;
  const offData = offGot + gotSize;
  const dataSize = 8;
  const rwEnd = offData + dataSize;
  const shstr = "\0.interp\0.hash\0.dynsym\0.dynstr\0.rela.plt\0.rodata\0.plt\0.text\0.dynamic\0.got.plt\0.data\0.bss\0.shstrtab\0";
  const offShstr = rwEnd;
  const offShdr = align(offShstr + shstr.length, 8);
  const shnum = 14;
  const fileSize = offShdr + shnum * SHDR_SIZE;

  // Virtual addresses: base + value.
  const vPlt = offPlt + RX_DELTA;
  const vText = offText + RX_DELTA;
  const vDynamic = offDynamic + RW_DELTA;
  const vGot = offGot + RW_DELTA;
  const vData = offData + RW_DELTA;
  const vBss = rwEnd + RW_DELTA;
  const vMsg = offRodata;

  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);
  const fields: ElfField[] = [];
  let at = 0;
  const seek = (o: number) => { at = o; };
  const put = (size: number, v: number | bigint, name: string, group: ElfGroup, explain: string, value?: string) => {
    const offset = at;
    if (size === 1) view.setUint8(at, Number(v));
    else if (size === 2) view.setUint16(at, Number(v), true);
    else if (size === 4) view.setUint32(at, Number(v), true);
    else view.setBigUint64(at, BigInt(v), true);
    fields.push({ offset, size, name, group, value: value ?? hex(v), explain });
    at += size;
  };
  const raw = (data: ArrayLike<number>, name: string, group: ElfGroup, explain: string, value: string) => {
    const offset = at;
    bytes.set(data as ArrayLike<number>, at);
    fields.push({ offset, size: data.length, name, group, value, explain });
    at += data.length;
  };
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  /** Bytes of an instruction with a 32-bit displacement relative to its end. */
  const rel = (prefix: number[], from: number, target: number) => {
    const len = prefix.length + 4;
    return [...prefix, ...le32((target - (from + len)) | 0)];
  };

  // ----- ELF header
  const E = "ehdr";
  raw([0x7f, 0x45, 0x4c, 0x46], "e_ident: magic", E, "The four magic bytes: 0x7f, then E, L, F. The kernel checks these first, in load_elf_binary.", '0x7f "ELF"');
  put(1, 2, "e_ident[EI_CLASS]", E, "2 means a 64-bit file.", "2 = ELFCLASS64");
  put(1, 1, "e_ident[EI_DATA]", E, "1 means little-endian. All later fields use this byte order.", "1 = little-endian");
  put(1, 1, "e_ident[EI_VERSION]", E, "The ELF version. It is always 1.", "1");
  put(1, 0, "e_ident[EI_OSABI]", E, "0 means System V, the normal value on Linux.", "0 = System V");
  raw(new Array(8).fill(0), "e_ident: padding", E, "Unused bytes that fill e_ident to 16 bytes.", "zeros");
  put(2, ET_DYN, "e_type", E, "ET_DYN: the file can load at any base address. Shared libraries and position-independent executables both use this type. A fixed-address executable uses ET_EXEC.", "3 = ET_DYN");
  put(2, EM_X86_64, "e_machine", E, "The CPU type. 62 is x86-64, and arm64 is 183.", "62 = x86-64");
  put(4, 1, "e_version", E, "The ELF version again. It is always 1.", "1");
  put(8, vText, "e_entry", E, "The first instruction of the program, relative to the load base. ld.so jumps here when it finishes. The kernel passes this value to ld.so in AT_ENTRY.");
  put(8, EHDR_SIZE, "e_phoff", E, "The file offset of the program header table. The loader reads this table.");
  put(8, offShdr, "e_shoff", E, "The file offset of the section header table. The loader does not use it. Linkers and debuggers do.");
  put(4, 0, "e_flags", E, "CPU-specific flags. x86-64 has none.");
  put(2, EHDR_SIZE, "e_ehsize", E, "The size of this header: 64 bytes.", "64");
  put(2, PHDR_SIZE, "e_phentsize", E, "The size of one program header: 56 bytes.", "56");
  put(2, phnum, "e_phnum", E, "The number of program headers.", String(phnum));
  put(2, SHDR_SIZE, "e_shentsize", E, "The size of one section header: 64 bytes.", "64");
  put(2, shnum, "e_shnum", E, "The number of section headers.", String(shnum));
  put(2, shnum - 1, "e_shstrndx", E, "The index of the section that holds the section names.", String(shnum - 1));

  // ----- Program headers
  const phdrs: ProgramHeader[] = [
    { type: PT.PHDR, flags: PF.R, offset: EHDR_SIZE, vaddr: EHDR_SIZE, filesz: phnum * PHDR_SIZE, memsz: phnum * PHDR_SIZE, align: 8 },
    { type: PT.INTERP, flags: PF.R, offset: offInterp, vaddr: offInterp, filesz: interpBytes, memsz: interpBytes, align: 1 },
    { type: PT.LOAD, flags: PF.R, offset: 0, vaddr: 0, filesz: roEnd, memsz: roEnd, align: PAGE },
    { type: PT.LOAD, flags: PF.R | PF.X, offset: offPlt, vaddr: vPlt, filesz: rxEnd - offPlt, memsz: rxEnd - offPlt, align: PAGE },
    { type: PT.LOAD, flags: PF.R | PF.W, offset: offDynamic, vaddr: vDynamic, filesz: rwEnd - offDynamic, memsz: rwEnd - offDynamic + BSS_SIZE, align: PAGE },
    { type: PT.DYNAMIC, flags: PF.R | PF.W, offset: offDynamic, vaddr: vDynamic, filesz: dynamicSize, memsz: dynamicSize, align: 8 },
    { type: PT.GNU_STACK, flags: PF.R | PF.W, offset: 0, vaddr: 0, filesz: 0, memsz: 0, align: 16 },
  ];
  const phExplain = (p: ProgramHeader): string => {
    switch (p.type) {
      case PT.PHDR: return "Says where the program headers are in memory, so that ld.so can find them after the load.";
      case PT.INTERP: return "Names the dynamic linker. The kernel maps that file too and starts it first.";
      case PT.DYNAMIC: return "Points at the .dynamic table, which ld.so reads to find the needed libraries, the symbols and the relocations.";
      case PT.GNU_STACK: return "Its flags choose the stack permissions. RW with no X means a stack that the CPU cannot execute.";
      default: return p.flags & PF.X ? "A loadable segment with code. The kernel maps it read and execute." : p.flags & PF.W ? "A loadable segment with data. The kernel maps it read and write. p_memsz is larger than p_filesz, and the extra bytes are .bss." : "A loadable segment with headers and read-only data. The kernel maps it read-only.";
    }
  };
  phdrs.forEach((p, i) => {
    const P = `phdr[${i}] ${typeName(p.type)} `;
    const G = "phdr";
    const ex = phExplain(p);
    put(4, p.type, `${P}p_type`, G, ex, typeName(p.type));
    put(4, p.flags, `${P}p_flags`, G, "Permissions for the mapping: R, W and X. They become the PROT flags of mmap.", flagName(p.flags));
    put(8, p.offset, `${P}p_offset`, G, "Where the bytes of this segment start in the file.");
    put(8, p.vaddr, `${P}p_vaddr`, G, "Where this segment goes in memory, relative to the load base. It must equal p_offset modulo p_align.");
    put(8, p.vaddr, `${P}p_paddr`, G, "The physical address. User programs ignore it. Linkers copy p_vaddr here.");
    put(8, p.filesz, `${P}p_filesz`, G, "How many bytes come from the file.");
    put(8, p.memsz, `${P}p_memsz`, G, "How many bytes this segment fills in memory. If this is larger than p_filesz, the kernel fills the rest with zeros.");
    put(8, p.align, `${P}p_align`, G, "The alignment. For PT_LOAD this is the page size that the linker assumed.");
  });

  // ----- .interp
  seek(offInterp);
  raw([...ascii(INTERP_PATH), 0], ".interp", "interp", "The path of the dynamic linker, with a zero byte at the end. PT_INTERP points here.", `"${INTERP_PATH}"`);

  // ----- .hash (SysV): one bucket that chains all symbols.
  seek(offHash);
  put(4, 1, ".hash nbucket", "hash", "The hash table has 1 bucket in this small file. ld.so can search this table for symbols that this file defines.", "1");
  put(4, 3, ".hash nchain", "hash", "The number of chain entries. It equals the number of symbols.", "3");
  put(4, 1, ".hash bucket[0]", "hash", "The first symbol in bucket 0.", "1");
  put(4, 0, ".hash chain[0]", "hash", "Symbol 0 is the reserved null symbol.", "0");
  put(4, 2, ".hash chain[1]", "hash", "After symbol 1 comes symbol 2.", "2");
  put(4, 0, ".hash chain[2]", "hash", "0 ends the chain.", "0");

  // ----- .dynsym
  seek(offDynsym);
  const syms: [string, number, number][] = [["(null)", 0, 0], ["puts", strOff.puts, 0x12], ["exit", strOff.exit, 0x12]];
  syms.forEach(([n, name, info], i) => {
    const P = `.dynsym[${i}] ${n} `;
    put(4, name, `${P}st_name`, "dynsym", "The offset of the symbol's name in .dynstr.");
    put(1, info, `${P}st_info`, "dynsym", i === 0 ? "Symbol 0 is always empty." : "0x12: a global function (binding 1, type 2).");
    put(1, 0, `${P}st_other`, "dynsym", "The visibility. 0 is the default.");
    put(2, 0, `${P}st_shndx`, "dynsym", i === 0 ? "Symbol 0 is always empty." : "0 means undefined in this file. Another library must supply this symbol.");
    put(8, 0, `${P}st_value`, "dynsym", "The address. It is 0 because this file does not define the symbol.");
    put(8, 0, `${P}st_size`, "dynsym", "The size of the object. It is 0 here.");
  });

  // ----- .dynstr
  seek(offDynstr);
  raw(ascii(dynstr), ".dynstr", "dynstr", "The names that the dynamic symbols and DT_NEEDED use, separated by zero bytes.", '"libc.so.6", "puts", "exit"');

  // ----- .rela.plt
  seek(offRela);
  [["puts", 1, 3], ["exit", 2, 4]].forEach(([n, sym, slot]) => {
    const P = `.rela.plt ${n} `;
    put(8, vGot + 8 * (slot as number), `${P}r_offset`, "rela", `The address of the GOT slot to fill: GOT[${slot}].`);
    put(8, (BigInt(sym as number) << 32n) | BigInt(R_X86_64_JUMP_SLOT), `${P}r_info`, "rela", `The high half is symbol ${sym} (${n}). The low half is ${R_X86_64_JUMP_SLOT}, R_X86_64_JUMP_SLOT: write the symbol's address into the slot.`);
    put(8, 0, `${P}r_addend`, "rela", "A constant to add. Jump slots use 0.");
  });

  // ----- .rodata
  seek(offRodata);
  raw([...ascii(MESSAGE), 0], ".rodata msg", "rodata", "The string for puts. Code finds it with a rip-relative address, so it works at any load base.", `"${MESSAGE}"`);

  // ----- .plt
  seek(offPlt);
  const gotSlot = (i: number) => vGot + 8 * i;
  raw(rel([0xff, 0x35], vPlt, gotSlot(1)), "PLT0: push [GOT+8]", "plt", "The shared PLT stub. It pushes GOT[1], the link map that names this file for the resolver.", "ff 35");
  raw(rel([0xff, 0x25], vPlt + 6, gotSlot(2)), "PLT0: jmp [GOT+16]", "plt", "It jumps through GOT[2], which ld.so filled with the address of _dl_runtime_resolve.", "ff 25");
  raw([0x0f, 0x1f, 0x40, 0x00], "PLT0: nop", "plt", "Padding to 16 bytes.", "nop");
  [["puts", 3, 0], ["exit", 4, 1]].forEach(([n, slot, idx], i) => {
    const v = vPlt + 16 * (i + 1);
    raw(rel([0xff, 0x25], v, gotSlot(slot as number)), `puts@plt: jmp [GOT+${8 * (slot as number)}]`.replace("puts", n as string), "plt", `A call to ${n} lands here. It jumps through GOT[${slot}]. Before the first call, the slot points at the next instruction.`, "ff 25");
    raw([0x68, ...le32(idx as number)], `${n}@plt: push ${idx}`, "plt", `It pushes the index of this function's relocation in .rela.plt.`, `push ${idx}`);
    raw(rel([0xe9], v + 11, vPlt), `${n}@plt: jmp PLT0`, "plt", "It jumps to the shared stub, which calls the resolver.", "e9");
  });

  // ----- .text
  seek(offText);
  let pc = vText;
  const code = (b: number[], name: string, explain: string, value: string) => { raw(b, name, "text", explain, value); pc += b.length; };
  code(rel([0x48, 0x8d, 0x3d], pc, vMsg), "_start: lea rdi, [rip+msg]", "The first argument. rip-relative addressing works at any load base, so this code is position-independent. This is the entry point.", "48 8d 3d");
  code(rel([0xe8], pc, vPlt + 16), "call puts@plt", "The first call. It goes to the PLT stub, not to puts.", "e8");
  code(rel([0x48, 0x8d, 0x3d], pc, vMsg), "lea rdi, [rip+msg]", "The first argument again.", "48 8d 3d");
  code(rel([0xe8], pc, vPlt + 16), "call puts@plt", "The second call. The GOT slot now holds the real address.", "e8");
  code([0x31, 0xff], "xor edi, edi", "The exit status is 0.", "31 ff");
  code(rel([0xe8], pc, vPlt + 32), "call exit@plt", "exit flushes stdout and calls exit_group. It does not return.", "e8");

  // ----- .dynamic
  seek(offDynamic);
  const dyn: [string, number, number, string][] = [
    ["DT_NEEDED", DT.NEEDED, strOff.libc, "A library to load: offset 1 in .dynstr is libc.so.6."],
    ["DT_HASH", DT.HASH, offHash, "The address of the symbol hash table."],
    ["DT_STRTAB", DT.STRTAB, offDynstr, "The address of .dynstr."],
    ["DT_SYMTAB", DT.SYMTAB, offDynsym, "The address of .dynsym."],
    ["DT_STRSZ", DT.STRSZ, dynstr.length, "The size of .dynstr."],
    ["DT_SYMENT", DT.SYMENT, 24, "The size of one symbol: 24 bytes."],
    ["DT_PLTGOT", DT.PLTGOT, vGot, "The address of .got.plt. ld.so fills GOT[1] and GOT[2] through it."],
    ["DT_PLTRELSZ", DT.PLTRELSZ, relaSize, "The size of .rela.plt."],
    ["DT_PLTREL", DT.PLTREL, 7, "The relocation format. 7 means DT_RELA."],
    ["DT_JMPREL", DT.JMPREL, offRela, "The address of .rela.plt. Lazy binding reads this table."],
    ["DT_NULL", DT.NULL, 0, "The end of the table."],
  ];
  for (const [n, tag, v, ex] of dyn) {
    put(8, tag, `${n} d_tag`, "dynamic", ex, n);
    put(8, v, `${n} d_val`, "dynamic", ex);
  }

  // ----- .got.plt
  seek(offGot);
  put(8, vDynamic, "GOT[0]", "got", "The address of .dynamic, by convention.");
  put(8, 0, "GOT[1]", "got", "Zero in the file. ld.so writes the link map here.");
  put(8, 0, "GOT[2]", "got", "Zero in the file. ld.so writes the address of _dl_runtime_resolve here.");
  put(8, vPlt + 16 + 6, "GOT[3] puts", "got", "Before the first call it points back into puts@plt, at the push. ld.so adds the load base to this value at startup.");
  put(8, vPlt + 32 + 6, "GOT[4] exit", "got", "Before the first call it points back into exit@plt, at the push.");

  // ----- .data
  seek(offData);
  put(8, 42, ".data counter", "data", "An initialized global. Its bytes are in the file, and writes go to a private copy of the page.", "42");

  // ----- .shstrtab
  seek(offShstr);
  raw(ascii(shstr), ".shstrtab", "shstrtab", "The names of the sections. The loader never reads them.", "section names");

  // ----- Section headers
  const nameOff = (n: string) => shstr.indexOf(`\0${n}\0`) + 1;
  const SHT = { NULL: 0, PROGBITS: 1, STRTAB: 3, RELA: 4, HASH: 5, DYNAMIC: 6, NOBITS: 8, DYNSYM: 11 };
  const A = 2, W = 1, X = 4, I = 0x40;
  const sections: SectionHeader[] = [
    { name: "", type: SHT.NULL, flags: 0, addr: 0, offset: 0, size: 0, link: 0, info: 0, addralign: 0, entsize: 0 },
    { name: ".interp", type: SHT.PROGBITS, flags: A, addr: offInterp, offset: offInterp, size: interpBytes, link: 0, info: 0, addralign: 1, entsize: 0 },
    { name: ".hash", type: SHT.HASH, flags: A, addr: offHash, offset: offHash, size: hashSize, link: 3, info: 0, addralign: 8, entsize: 4 },
    { name: ".dynsym", type: SHT.DYNSYM, flags: A, addr: offDynsym, offset: offDynsym, size: dynsymSize, link: 4, info: 1, addralign: 8, entsize: 24 },
    { name: ".dynstr", type: SHT.STRTAB, flags: A, addr: offDynstr, offset: offDynstr, size: dynstr.length, link: 0, info: 0, addralign: 1, entsize: 0 },
    { name: ".rela.plt", type: SHT.RELA, flags: A | I, addr: offRela, offset: offRela, size: relaSize, link: 3, info: 10, addralign: 8, entsize: 24 },
    { name: ".rodata", type: SHT.PROGBITS, flags: A, addr: offRodata, offset: offRodata, size: rodataSize, link: 0, info: 0, addralign: 1, entsize: 0 },
    { name: ".plt", type: SHT.PROGBITS, flags: A | X, addr: vPlt, offset: offPlt, size: pltSize, link: 0, info: 0, addralign: 16, entsize: 16 },
    { name: ".text", type: SHT.PROGBITS, flags: A | X, addr: vText, offset: offText, size: textSize, link: 0, info: 0, addralign: 16, entsize: 0 },
    { name: ".dynamic", type: SHT.DYNAMIC, flags: A | W, addr: vDynamic, offset: offDynamic, size: dynamicSize, link: 4, info: 0, addralign: 8, entsize: 16 },
    { name: ".got.plt", type: SHT.PROGBITS, flags: A | W, addr: vGot, offset: offGot, size: gotSize, link: 0, info: 0, addralign: 8, entsize: 8 },
    { name: ".data", type: SHT.PROGBITS, flags: A | W, addr: vData, offset: offData, size: dataSize, link: 0, info: 0, addralign: 8, entsize: 0 },
    { name: ".bss", type: SHT.NOBITS, flags: A | W, addr: vBss, offset: rwEnd, size: BSS_SIZE, link: 0, info: 0, addralign: 8, entsize: 0 },
    { name: ".shstrtab", type: SHT.STRTAB, flags: 0, addr: 0, offset: offShstr, size: shstr.length, link: 0, info: 0, addralign: 1, entsize: 0 },
  ];
  seek(offShdr);
  sections.forEach((s, i) => {
    const P = `shdr[${i}] ${s.name || "(null)"} `;
    const ex = i === 0 ? "Section 0 is always empty." : `Describes ${s.name} for linkers and debuggers. The loader ignores it.`;
    put(4, s.name ? nameOff(s.name) : 0, `${P}sh_name`, "shdr", ex);
    put(4, s.type, `${P}sh_type`, "shdr", ex);
    put(8, s.flags, `${P}sh_flags`, "shdr", ex);
    put(8, s.addr, `${P}sh_addr`, "shdr", ex);
    put(8, s.offset, `${P}sh_offset`, "shdr", ex);
    put(8, s.size, `${P}sh_size`, "shdr", ex);
    put(4, s.link, `${P}sh_link`, "shdr", ex);
    put(4, s.info, `${P}sh_info`, "shdr", ex);
    put(8, s.addralign, `${P}sh_addralign`, "shdr", ex);
    put(8, s.entsize, `${P}sh_entsize`, "shdr", ex);
  });

  const byOffset = [...fields].sort((a, b) => a.offset - b.offset);
  return {
    bytes, fields, entry: vText, phdrs, sections,
    sym: { plt0: vPlt, pltPuts: vPlt + 16, pltExit: vPlt + 32, start: vText, msg: vMsg, gotPlt: vGot, dynamic: vDynamic, relaPlt: offRela, dynsym: offDynsym, dynstr: offDynstr },
    fieldAt: (o) => {
      let lo = 0, hi = byOffset.length - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1, f = byOffset[m]!;
        if (o < f.offset) hi = m - 1;
        else if (o >= f.offset + f.size) lo = m + 1;
        else return f;
      }
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------- parser

export interface ParsedElf {
  magicOk: boolean; class64: boolean; littleEndian: boolean;
  type: number; machine: number; entry: number; phoff: number; shoff: number;
  ehsize: number; phentsize: number; phnum: number; shentsize: number; shnum: number; shstrndx: number;
  phdrs: ProgramHeader[];
  sections: { name: string; type: number; addr: number; offset: number; size: number }[];
}

/** Reads the file with the offsets in the ELF64 specification. It uses nothing from the builder. */
export function parseElf(b: Uint8Array): ParsedElf {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => v.getUint16(o, true), u32 = (o: number) => v.getUint32(o, true), u64 = (o: number) => Number(v.getBigUint64(o, true));
  const phoff = u64(0x20), shoff = u64(0x28), phentsize = u16(0x36), phnum = u16(0x38), shentsize = u16(0x3a), shnum = u16(0x3c), shstrndx = u16(0x3e);
  const phdrs: ProgramHeader[] = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    phdrs.push({ type: u32(o), flags: u32(o + 4), offset: u64(o + 8), vaddr: u64(o + 0x10), filesz: u64(o + 0x20), memsz: u64(o + 0x28), align: u64(o + 0x30) });
  }
  const strOff = u64(shoff + shstrndx * shentsize + 0x18);
  const cstr = (o: number) => { let s = ""; while (b[o]) s += String.fromCharCode(b[o++]!); return s; };
  const sections = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    sections.push({ name: cstr(strOff + u32(o)), type: u32(o + 4), addr: u64(o + 0x10), offset: u64(o + 0x18), size: u64(o + 0x20) });
  }
  return {
    magicOk: b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46,
    class64: b[4] === 2, littleEndian: b[5] === 1,
    type: u16(0x10), machine: u16(0x12), entry: u64(0x18), phoff, shoff,
    ehsize: u16(0x34), phentsize, phnum, shentsize, shnum, shstrndx, phdrs, sections,
  };
}

// ---------------------------------------------------------------------------- the loader

/** The first PIE base with ASLR off on x86-64: two thirds of TASK_SIZE, page aligned. */
export const PIE_BASE = 0x555555554000;
/** The x86-64 default of /proc/sys/vm/mmap_rnd_bits in the kernel config. Distributions may raise it. */
export const MMAP_RND_BITS = 28;
export const aslrPositions = (bits = MMAP_RND_BITS) => 2 ** bits;
export const aslrSpanBytes = (bits = MMAP_RND_BITS) => 2 ** bits * PAGE;
/** The base for a choice of r in [0, 1). */
export const randomBase = (r: number, bits = MMAP_RND_BITS) => PIE_BASE + Math.floor(r * 2 ** bits) * PAGE;

export interface Vma { start: number; end: number; perms: string; offset: number; name: string; group: ElfGroup | "lib" | "stack" | "anon" }

const pageDown = (x: number) => Math.floor(x / PAGE) * PAGE;
const pageUp = (x: number) => Math.ceil(x / PAGE) * PAGE;

/** Maps each PT_LOAD as load_elf_binary does: file pages first, then anonymous pages for .bss. */
export function mapSegments(e: { phdrs: ProgramHeader[] }, base: number, name = "hello"): Vma[] {
  const out: Vma[] = [];
  for (const p of e.phdrs) {
    if (p.type !== PT.LOAD) continue;
    const start = pageDown(base + p.vaddr);
    const fileEnd = pageUp(base + p.vaddr + p.filesz);
    const memEnd = pageUp(base + p.vaddr + p.memsz);
    const perms = `${p.flags & PF.R ? "r" : "-"}${p.flags & PF.W ? "w" : "-"}${p.flags & PF.X ? "x" : "-"}p`;
    const group: ElfGroup = p.flags & PF.X ? "text" : p.flags & PF.W ? "data" : "rodata";
    out.push({ start, end: fileEnd, perms, offset: pageDown(p.offset), name, group });
    if (memEnd > fileEnd) out.push({ start: fileEnd, end: memEnd, perms, offset: 0, name: "[bss]", group: "anon" });
  }
  return out;
}

export const hexAddr = (n: number) => n.toString(16).padStart(12, "0");

/** The fixed addresses of the rest of the model address space. ASLR off, as under gdb. */
export const STACK_TOP = 0x7ffffffff000;
export const LDSO_BASE = 0x7ffff7fc3000;
export const LIBC_BASE = 0x7ffff7d80000;
const STACK_VMA: Vma = { start: 0x7ffffffde000, end: STACK_TOP, perms: "rw-p", offset: 0, name: "[stack]", group: "stack" };

export interface LoaderStep { title: string; text: string; highlight: ElfGroup[]; field?: string; maps: Vma[]; rip?: string; mode: "kernel" | "ld.so" | "program" }

/** The whole start of a program, from execve to _start. */
export function loaderSteps(e: ElfImage, base = PIE_BASE): LoaderStep[] {
  const segs = mapSegments(e, base);
  const hasBss = segs.filter((s) => s.group === "anon");
  const fileSegs = segs.filter((s) => s.group !== "anon");
  const ldso: Vma[] = [
    { start: LDSO_BASE, end: LDSO_BASE + 0x2b000, perms: "r-xp", offset: 0, name: "ld-linux-x86-64.so.2", group: "lib" },
    { start: LDSO_BASE + 0x2b000, end: LDSO_BASE + 0x2d000, perms: "rw-p", offset: 0x2b000, name: "ld-linux-x86-64.so.2", group: "lib" },
  ];
  const vdso: Vma = { start: LDSO_BASE - 0x2000, end: LDSO_BASE, perms: "r-xp", offset: 0, name: "[vdso]", group: "lib" };
  const libc: Vma[] = [
    { start: LIBC_BASE, end: LIBC_BASE + 0x1b0000, perms: "r-xp", offset: 0, name: "libc.so.6", group: "lib" },
    { start: LIBC_BASE + 0x1b0000, end: LIBC_BASE + 0x1b4000, perms: "rw-p", offset: 0x1b0000, name: "libc.so.6", group: "lib" },
  ];
  const sort = (m: Vma[]) => [...m].sort((a, b) => a.start - b.start);
  const k = (n: number) => sort(fileSegs.slice(0, n));
  const all = [...fileSegs, ...hasBss];
  return [
    { title: "execve", text: "The kernel opens the file and reads its first bytes. The magic bytes select the ELF loader, load_elf_binary. The old memory map goes away.", highlight: ["ehdr"], field: "e_ident: magic", maps: [], mode: "kernel" },
    { title: "Read the program headers", text: `e_phoff and e_phnum locate ${e.phdrs.length} program headers. The kernel never reads the section headers.`, highlight: ["phdr"], field: "e_phoff", maps: [], mode: "kernel" },
    { title: "Find the interpreter", text: `PT_INTERP names ${INTERP_PATH}. The kernel opens that file too. A static binary has no PT_INTERP.`, highlight: ["interp"], field: ".interp", maps: [], mode: "kernel" },
    { title: "Choose the load base", text: `e_type is ET_DYN, so the kernel picks a base. Here it is 0x${hexAddr(base)}. A fixed ET_EXEC file skips this step.`, highlight: ["ehdr"], field: "e_type", maps: [], mode: "kernel" },
    { title: "Map the first PT_LOAD", text: "Read-only: the headers, .dynsym, .dynstr, .rela.plt and .rodata. The kernel maps the file pages, and it reads nothing yet. Page faults load the bytes later.", highlight: ["hash", "dynsym", "dynstr", "rela", "rodata"], maps: k(1), mode: "kernel" },
    { title: "Map the second PT_LOAD", text: "Read and execute: .plt and .text. Page offsets match the file because p_vaddr equals p_offset modulo the page size.", highlight: ["plt", "text"], maps: k(2), mode: "kernel" },
    { title: "Map the third PT_LOAD", text: "Read and write, private: .dynamic, .got.plt and .data. A write to these pages makes a private copy, and the file stays the same.", highlight: ["dynamic", "got", "data"], maps: k(3), mode: "kernel" },
    { title: "Add .bss", text: `p_memsz is larger than p_filesz by ${hex(BSS_SIZE)} bytes. The kernel clears the rest of the last file page and maps anonymous zero pages after it.`, highlight: ["data"], maps: sort(all), mode: "kernel" },
    { title: "Map ld.so and the vDSO", text: "The kernel maps the interpreter the same way, from its own PT_LOAD headers. It also maps the vDSO page.", highlight: [], maps: sort([...all, ...ldso, vdso]), mode: "kernel" },
    { title: "Build the stack", text: "The kernel writes the strings and then argc, argv, envp and the auxiliary vector on a new stack. AT_ENTRY holds the program's entry point, and AT_BASE holds the base of ld.so.", highlight: [], maps: sort([...all, ...ldso, vdso, STACK_VMA]), mode: "kernel" },
    { title: "Jump to ld.so", text: "The kernel returns to user mode at the entry of ld.so, not of the program. The program has not run one instruction yet.", highlight: [], maps: sort([...all, ...ldso, vdso, STACK_VMA]), rip: "ld.so _start", mode: "ld.so" },
    { title: "Load the libraries", text: "ld.so finds PT_DYNAMIC and reads DT_NEEDED. It searches the library path, opens libc.so.6 and maps it with mmap.", highlight: ["dynamic", "dynstr"], field: "DT_NEEDED d_val", maps: sort([...all, ...ldso, vdso, STACK_VMA, ...libc]), rip: "ld.so", mode: "ld.so" },
    { title: "Relocate", text: "ld.so adds the load base to GOT[3] and GOT[4], and it fills GOT[1] and GOT[2]. With lazy binding it does not look up puts or exit yet. It then runs the library init code.", highlight: ["got", "rela"], field: "GOT[3] puts", maps: sort([...all, ...ldso, vdso, STACK_VMA, ...libc]), rip: "ld.so", mode: "ld.so" },
    { title: "Jump to _start", text: `ld.so jumps to base + e_entry, 0x${hexAddr(base + e.entry)}. The program runs its first instruction.`, highlight: ["text"], field: "_start: lea rdi, [rip+msg]", maps: sort([...all, ...ldso, vdso, STACK_VMA, ...libc]), rip: "_start", mode: "program" },
  ];
}

// ---------------------------------------------------------------------------- the initial stack

/** The auxv tags (elf.h). */
export const AT = { NULL: 0, PHDR: 3, PHENT: 4, PHNUM: 5, PAGESZ: 6, BASE: 7, ENTRY: 9, RANDOM: 25, EXECFN: 31, SYSINFO_EHDR: 33 } as const;

export interface StackRow { addr: number; label: string; value: string; kind: "argc" | "argv" | "envp" | "auxv" | "null" | "data" }

/** The stack that the kernel builds at execve. rsp is 16-byte aligned, and argc is at rsp. */
export function initialStack(argv: string[], envp: string[], e: ElfImage, base = PIE_BASE): { rsp: number; rows: StackRow[] } {
  let sp = STACK_TOP - 8; // A null word at the very top.
  const strs: { addr: number; s: string; len: number }[] = [];
  const pushStr = (s: string) => { sp -= s.length + 1; strs.push({ addr: sp, s, len: s.length + 1 }); return sp; };
  const execfn = pushStr(argv[0] ?? "");
  const envAddrs = [...envp].reverse().map(pushStr).reverse();
  const argAddrs = [...argv].reverse().map(pushStr).reverse();
  sp -= 16;
  const random = sp;
  sp = Math.floor(sp / 16) * 16; // Not &=: addresses are wider than 32 bits.
  const auxv: [string, number, string][] = [
    ["AT_SYSINFO_EHDR", AT.SYSINFO_EHDR, `0x${hexAddr(LDSO_BASE - 0x2000)}`],
    ["AT_PAGESZ", AT.PAGESZ, "4096"],
    ["AT_PHDR", AT.PHDR, `0x${hexAddr(base + 64)}`],
    ["AT_PHENT", AT.PHENT, "56"],
    ["AT_PHNUM", AT.PHNUM, String(e.phdrs.length)],
    ["AT_BASE", AT.BASE, `0x${hexAddr(LDSO_BASE)}`],
    ["AT_ENTRY", AT.ENTRY, `0x${hexAddr(base + e.entry)}`],
    ["AT_RANDOM", AT.RANDOM, `0x${hexAddr(random)}`],
    ["AT_EXECFN", AT.EXECFN, `0x${hexAddr(execfn)}`],
    ["AT_NULL", AT.NULL, "0"],
  ];
  const words = 1 + argv.length + 1 + envp.length + 1 + auxv.length * 2;
  const rsp = Math.floor((sp - words * 8) / 16) * 16;
  const rows: StackRow[] = [];
  let a = rsp;
  const add = (label: string, value: string, kind: StackRow["kind"]) => { rows.push({ addr: a, label, value, kind }); a += 8; };
  add("argc", String(argv.length), "argc");
  argAddrs.forEach((x, i) => add(`argv[${i}]`, `0x${hexAddr(x)} "${argv[i]}"`, "argv"));
  add("argv end", "NULL", "null");
  envAddrs.forEach((x, i) => add(`envp[${i}]`, `0x${hexAddr(x)} "${envp[i]}"`, "envp"));
  add("envp end", "NULL", "null");
  for (const [n, tag, v] of auxv) {
    rows.push({ addr: a, label: n, value: `tag ${tag}, value ${v}`, kind: "auxv" });
    a += 16;
  }
  rows.push({ addr: a, label: "strings and AT_RANDOM bytes", value: `up to 0x${hexAddr(STACK_TOP)}`, kind: "data" });
  return { rsp, rows };
}
