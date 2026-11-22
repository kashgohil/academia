/** Golden checks of the linker sim against real objects from clang 22.1.8 and real output from ld.lld 22.1.8. */
import { describe, expect, test } from "vitest";
import { golden, gcInputs, link, toHex, fieldAt, relocName, IMAGE_BASE } from "../../src/sims/sys/linking";

describe("object file reader", () => {
  const m = golden("main.o");
  test("main.o matches llvm-readelf", () => {
    expect(m.bytes.length).toBe(1120);
    expect(m.sections.map((s) => s.name)).toEqual(["", ".strtab", ".text", ".rela.text", ".data", ".rela.data", ".bss", ".note.GNU-stack", ".symtab"]);
    expect(m.shstrndx).toBe(1);
    const text = m.sections[2]!;
    expect([text.offset, text.size, text.align]).toEqual([0x40, 0x24, 16]);
    expect(m.symbols.map((s) => `${s.name}/${s.bind}/${s.type}/${s.shndx}`)).toEqual([
      "/LOCAL/NOTYPE/0", "main.c/LOCAL/FILE/65521", "calls/LOCAL/OBJECT/6", ".bss/LOCAL/SECTION/6",
      "main/GLOBAL/FUNC/2", "counter/GLOBAL/NOTYPE/0", "add/GLOBAL/NOTYPE/0", "where/GLOBAL/OBJECT/4",
    ]);
    expect(m.relocs.map((r) => `${r.target}+${r.offset.toString(16)} ${relocName(r.type)} ${m.symbols[r.sym]!.name}${r.addend}`)).toEqual([
      "2+2 R_X86_64_PC32 .bss-4", "2+a R_X86_64_PC32 .bss-4", "2+10 R_X86_64_PC32 counter-4", "2+16 R_X86_64_PC32 counter-4",
      "2+20 R_X86_64_PLT32 add-4", "4+0 R_X86_64_64 counter0",
    ]);
  });
  test("every byte has exactly one field, and holes are zero", () => {
    let at = 0;
    for (const f of m.fields) { expect(f.offset).toBe(at); at += f.size; }
    expect(at).toBe(m.bytes.length);
    const hole = fieldAt(m, 0x40 + 0x20)!;
    expect(hole.reloc).toBe(4);
    expect(hole.value).toBe("00 00 00 00");
  });
});

describe("static link of main.o + lib.o matches ld.lld", () => {
  test("non-PIC objects: addresses and bytes", () => {
    const r = link([golden("main.o"), golden("lib.o")]);
    expect(r.ok).toBe(true);
    const sec = Object.fromEntries(r.sections.map((s) => [s.name, s]));
    expect(sec[".text"]!.addr).toBe(0x201160);
    expect(sec[".data"]!.addr).toBe(0x202198);
    expect(sec[".bss"]!.addr).toBe(0x2021a4);
    expect(toHex(sec[".text"]!.bytes)).toBe("8b3d3e100000ffc7893d36100000033d2c100000893d26100000be02000000e90c000000cccccccccccccccccccccccc8d0437c3");
    expect(toHex(sec[".data"]!.bytes)).toBe("a02120000000000028000000");
    expect(r.symbols.get("add")).toBe(0x201190);
    expect(r.symbols.get("counter")).toBe(0x2021a0);
    // The first relocation, step by step: S = .bss, A = -4, P = .text + 2.
    const first = r.relocs[0]!;
    expect([first.S, first.A, first.P, first.value]).toEqual([0x2021a4, -4, 0x201162, 0x103e]);
  });
  test("-fPIE objects: GOTPCRELX relaxed to lea, and the empty .got moves .data a page", () => {
    const r = link([golden("main-pie.o"), golden("lib-pie.o")]);
    const sec = Object.fromEntries(r.sections.map((s) => [s.name, s]));
    expect(r.phnum).toBe(7);
    expect(sec[".text"]!.addr).toBe(0x2011d0);
    expect(sec[".data"]!.addr).toBe(0x203208);
    expect(toHex(sec[".text"]!.bytes)).toBe("8b3d3e200000ffc7893d36200000488d052b20000003388938be02000000e90d000000cccccccccccccccccccccccccc8d0437c3");
    expect(toHex(sec[".data"]!.bytes)).toBe("103220000000000028000000");
    expect(r.relocs.filter((x) => x.relaxed).length).toBe(1);
  });
  test("--no-relax keeps a GOT slot", () => {
    const r = link([golden("main-pie.o"), golden("lib-pie.o")], { relax: false });
    const sec = Object.fromEntries(r.sections.map((s) => [s.name, s]));
    expect(sec[".got"]!.addr).toBe(0x202208);
    expect(toHex(sec[".got"]!.bytes)).toBe("1832200000000000");
    expect(sec[".data"]!.addr).toBe(0x203210);
    expect(toHex(sec[".text"]!.bytes).slice(28, 42)).toBe("488b0523100000");
  });
  test("PC32 out of range: the same message as ld.lld", () => {
    const r = link([golden("main.o"), golden("lib.o")], { sectionStart: { ".text": 0x201160, ".data": 0x80201158, ".bss": 0x80201168 } });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.text).toBe("main.o:(function main: .text+0x2): relocation R_X86_64_PC32 out of range: 2147483650 is not in [-2147483648, 2147483647]; references section '.bss'");
    const far = link([golden("main.o"), golden("lib.o")], { sectionStart: { ".text": 0x201160, ".data": 0x100000000, ".bss": 0x100000010 } });
    expect(far.errors.map((e) => e.text.match(/range: (\d+)/)![1])).toEqual(["4292865706", "4292865698", "4292865684", "4292865678"]);
    expect(far.errors[2]!.text.endsWith("references 'counter'")).toBe(true);
  });
});

describe("--gc-sections matches ld.lld", () => {
  const sizes = (split: boolean, gc: boolean) => {
    const r = link(gcInputs(split), { gcSections: gc });
    return Object.fromEntries(r.sections.map((s) => [s.name, [s.addr, s.size]]));
  };
  test("four builds", () => {
    expect(sizes(false, false)).toEqual({ ".rodata": [0x200160, 0x50], ".text": [0x2011b0, 0x91], ".bss": [0x202250, 0x120] });
    expect(sizes(false, true)).toEqual({ ".rodata": [0x200160, 0x50], ".text": [0x2011b0, 0x79], ".bss": [0x20222c, 0x4] });
    expect(sizes(true, false)).toEqual({ ".rodata": [0x200160, 0x50], ".text": [0x2011b0, 0x91], ".bss": [0x202250, 0x110] });
    expect(sizes(true, true)).toEqual({ ".rodata": [0x200120, 0x3], ".text": [0x201130, 0x4b] });
  });
  test("symbol addresses after GC", () => {
    const r = link(gcInputs(true), { gcSections: true });
    expect(r.symbols.get("main")).toBe(0x201130);
    expect(r.symbols.get("parse")).toBe(0x201140);
    expect(r.symbols.has("report")).toBe(false);
    const all = link(gcInputs(false));
    expect(all.symbols.get("csv_buf")).toBe(0x202270);
    expect(all.symbols.get("util.o:table")).toBe(0x200170);
    expect(IMAGE_BASE).toBe(0x200000);
  });
});

describe("numbers quoted in the lessons", () => {
  test("object-files-and-elf", () => {
    const m = golden("main.o");
    const text = m.sections.find((s) => s.name === ".text")!;
    expect(m.relocs.filter((r) => r.target === text.index).length * 4).toBe(20);
    expect(text.size).toBe(36);
    expect(golden("extra.o").sections.find((s) => s.name === ".bss")!.size).toBe(272);
    const util = golden("util-fs.o");
    expect(util.symbols.find((s) => s.name === "parse")!.size).toBe(59);
    expect(golden("app-fs.o").symbols.find((s) => s.name === "main")!.size).toBe(10);
    const sizes = [link(gcInputs(false)), link(gcInputs(false), { gcSections: true }), link(gcInputs(true), { gcSections: true })].map((r) => r.sections.find((s) => s.name === ".text")!.size);
    expect(sizes).toEqual([145, 121, 75]);
  });
  test("symbols-and-relocation: 2 GiB distance breaks only the first calls relocation", () => {
    const r = link([golden("main.o"), golden("lib.o")], { sectionStart: { ".text": 0x201160, ".data": 0x201160 + 2 ** 31 } });
    expect(r.relocs.filter((x) => x.error).map((x) => [x.symbol, x.value - 2 ** 31])).toEqual([[".bss", 6]]);
    expect(link([golden("main.o"), golden("lib.o")]).relocs[5]!.value).toBe(0x2021a0);
  });
});
