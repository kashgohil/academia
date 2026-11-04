/** GDT, TSS and IDT encoders against hand-checked values, the double fault table, boot constants, the mode machine and the linker model. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import { hexVa, isCanonical, splitVa } from "@/sims/os/vm/addr";
import * as K from "@/sims/os/kernel";

describe("GDT descriptors", () => {
  test("known values", () => {
    expect(K.encodeDesc(K.code64(0))).toBe(0x00af9a000000ffffn);
    expect(K.encodeDesc(K.code64(3))).toBe(0x00affa000000ffffn);
    expect(K.encodeDesc(K.code32(0))).toBe(0x00cf9a000000ffffn);
    expect(K.encodeDesc(K.data32(0))).toBe(0x00cf92000000ffffn);
    expect(K.encodeDesc(K.data32(3))).toBe(0x00cff2000000ffffn);
    // Linux GDT_ENTRY_INIT(0xa09b, 0, 0xfffff): the same as code64(0), with the accessed bit set.
    expect(K.encodeDesc({ base: 0, limit: 0xfffff, access: 0x9b, flags: 0xa })).toBe(0x00af9b000000ffffn);
  });
  test("each field lands in its bits", () => {
    const v = K.encodeDesc({ base: 0x12345678, limit: 0xabcde, access: 0x9a, flags: 0xc });
    // limit 15:0 = bcde, base 23:0 = 345678, access = 9a, limit 19:16 = a, flags = c, base 31:24 = 12
    expect(v).toBe(0x12ca9a345678bcden);
    expect(K.bytesLE(v)).toEqual([0xde, 0xbc, 0x78, 0x56, 0x34, 0x9a, 0xca, 0x12]);
  });
  test("round trip on random values", () => {
    const r = mulberry32(11);
    for (let i = 0; i < 2000; i++) {
      const v = (BigInt(Math.floor(r() * 2 ** 32)) << 32n) | BigInt(Math.floor(r() * 2 ** 32));
      expect(K.encodeDesc(K.decodeDesc(v))).toBe(v);
    }
  });
  test("every bit belongs to one field", () => {
    const n = (f: K.DescField) => [...Array(64).keys()].filter((b) => K.descFieldOfBit(b) === f).length;
    expect(n("limit")).toBe(20);
    expect(n("base")).toBe(32);
    expect(n("DPL")).toBe(2);
    expect(K.descFieldOfBit(53)).toBe("L");
    expect(K.descFieldOfBit(47)).toBe("P");
  });
  test("describeDesc", () => {
    expect(K.describeDesc(K.code64(0)).kind).toBe("64-bit code, ring 0");
    expect(K.describeDesc(K.code64(3)).kind).toBe("64-bit code, ring 3");
    expect(K.describeDesc(K.code32(0)).kind).toBe("32-bit code, ring 0");
    expect(K.describeDesc(K.data32(3)).kind).toBe("data, ring 3");
    expect(K.describeDesc({ ...K.code64(0), flags: 0xe }).ok).toBe(false);
  });
});

describe("TSS and gates", () => {
  test("TSS descriptor, hand-checked", () => {
    const { lo, hi } = K.encodeTssDesc(0xffffffff80123456n);
    expect(lo).toBe(0x8000891234560067n);
    expect(hi).toBe(0x00000000ffffffffn);
    expect(K.decodeTssDesc(lo, hi)).toEqual({ base: 0xffffffff80123456n, limit: 103, type: 9, present: true });
  });
  test("TSS layout", () => {
    expect(K.TSS_SIZE).toBe(104);
    expect(K.TSS_OFF.RSP0).toBe(4);
    expect(K.TSS_OFF.IST1).toBe(36);
    expect(K.TSS_OFF.IOPB).toBe(102);
  });
  test("gate, hand-checked", () => {
    const g: K.Gate = { offset: 0xffffffff80123456n, selector: 8, ist: 1, type: K.GATE_INTERRUPT, dpl: 0, present: true };
    const { lo, hi } = K.encodeGate(g);
    expect(lo).toBe(0x80128e0100083456n);
    expect(hi).toBe(0xffffffffn);
    expect(K.bytesLE(lo)[5]).toBe(0x8e);
    expect(K.decodeGate(lo, hi)).toEqual(g);
  });
  test("flags byte: 0x8E, 0x8F, 0xEE", () => {
    const flags = (type: number, dpl: number) => K.bytesLE(K.encodeGate({ offset: 0n, selector: 8, ist: 0, type, dpl, present: true }).lo)[5];
    expect(flags(K.GATE_INTERRUPT, 0)).toBe(0x8e);
    expect(flags(K.GATE_TRAP, 0)).toBe(0x8f);
    expect(flags(K.GATE_INTERRUPT, 3)).toBe(0xee);
  });
  test("gate round trip on random values", () => {
    const r = mulberry32(5);
    for (let i = 0; i < 2000; i++) {
      const g: K.Gate = {
        offset: (BigInt(Math.floor(r() * 2 ** 32)) << 32n) | BigInt(Math.floor(r() * 2 ** 32)),
        selector: Math.floor(r() * 65536), ist: Math.floor(r() * 8), type: Math.floor(r() * 16), dpl: Math.floor(r() * 4), present: r() < 0.5,
      };
      const e = K.encodeGate(g);
      expect(K.decodeGate(e.lo, e.hi)).toEqual(g);
    }
  });
  test("the table is 256 gates of 16 bytes", () => {
    expect(K.IDT_ENTRIES * K.GATE_BYTES).toBe(4096);
  });
});

describe("exceptions and the double fault table", () => {
  test("vectors with a CPU error code", () => {
    expect(K.vectorsWithErrorCode()).toEqual([8, 10, 11, 12, 13, 14, 17, 21]);
  });
  test("the SDM table", () => {
    expect(K.secondException(K.VEC.BP, K.VEC.GP)).toBe("serial");
    expect(K.secondException(K.VEC.GP, K.VEC.GP)).toBe("double");
    expect(K.secondException(K.VEC.DE, K.VEC.NP)).toBe("double");
    expect(K.secondException(K.VEC.GP, K.VEC.PF)).toBe("serial");
    expect(K.secondException(K.VEC.PF, K.VEC.PF)).toBe("double");
    expect(K.secondException(K.VEC.PF, K.VEC.GP)).toBe("double");
    expect(K.secondException(K.VEC.DF, K.VEC.PF)).toBe("triple");
    expect(K.secondException(K.VEC.DF, K.VEC.GP)).toBe("triple");
    expect(K.secondException(K.VEC.DF, K.VEC.BP)).toBe("serial");
  });
  test("PIC vectors collide with #DF unless remapped", () => {
    expect(K.picVector(0)).toBe(K.VEC.DF);
    expect(K.picVector(0, K.PIC.REMAP_OFFSET)).toBe(32);
    expect(K.LAPIC.BASE).toBe(0xfee00000);
    expect(K.LAPIC.EOI).toBe(0xb0);
  });
});

describe("syscall MSRs", () => {
  test("TinyOS STAR", () => {
    expect(K.TINY_STAR).toBe(0x0010000800000000n);
    expect(K.syscallSelectors(K.TINY_STAR)).toEqual({ cs: 0x08, ss: 0x10 });
    expect(K.sysretSelectors(K.TINY_STAR)).toEqual({ cs: 0x23, ss: 0x1b });
    expect(K.SEL.UCODE).toBe(0x23);
    expect(K.SEL.UDATA).toBe(0x1b);
  });
  test("the Linux STAR gives its selectors", () => {
    const s = K.starValue(0x10, 0x23);
    expect(s).toBe(0x0023001000000000n);
    expect(K.syscallSelectors(s)).toEqual({ cs: 0x10, ss: 0x18 });
    expect(K.sysretSelectors(s)).toEqual({ cs: 0x33, ss: 0x2b });
  });
  test("MSR numbers and SFMASK", () => {
    expect(K.MSR.EFER).toBe(0xc0000080);
    expect(K.MSR.STAR).toBe(0xc0000081);
    expect(K.MSR.LSTAR).toBe(0xc0000082);
    expect(K.MSR.SFMASK).toBe(0xc0000084);
    expect(K.MSR.KERNEL_GS_BASE).toBe(0xc0000102);
    expect(K.TINY_SFMASK).toBe(0x40700);
  });
  test("the syscall stepper: swapgs and IF", () => {
    const good = K.sysEntrySnaps({ swapgs: true, maskIf: true });
    expect(good.every((s) => !s.bad)).toBe(true);
    expect(good[1]!.regs.rflags).toBe("0x0002");
    expect(good[1]!.regs.rsp).toBe(good[0]!.regs.rsp);
    expect(good[good.length - 1]!.ring).toBe(3);
    expect(good[good.length - 1]!.regs.rip).toBe(good[1]!.regs.rcx);
    expect(good[good.length - 1]!.regs.gsBase).toBe(good[0]!.regs.gsBase);
    expect(K.sysEntrySnaps({ swapgs: false, maskIf: true }).some((s) => s.bad)).toBe(true);
    expect(K.sysEntrySnaps({ swapgs: true, maskIf: false }).some((s) => s.bad)).toBe(true);
  });
});

describe("boot", () => {
  test("reset state", () => {
    expect(K.RESET_VECTOR).toBe(0xfffffff0);
    expect(2 ** 32 - K.RESET_VECTOR).toBe(16);
    expect(K.RESET_CR0).toBe(0x60000010);
  });
  test("real mode addresses", () => {
    expect(K.realAddr(0xf000, 0xfff0)).toBe(0xffff0);
    expect(K.realAddr(0xffff, 0x10)).toBe(0x100000);
    expect(K.realAddr(0xffff, 0x10, false)).toBe(0);
    expect(K.realAddr(0, 0x7c00)).toBe(0x7c00);
  });
  test("Multiboot2 header sums to 0", () => {
    const h = K.mb2Header();
    expect(h.length).toBe(24);
    expect(h.checksum).toBe(0x17adaf12);
    expect((h.magic + h.arch + h.length + h.checksum) % 2 ** 32).toBe(0);
    expect(K.MB2.BOOT_MAGIC).toBe(0x36d76289);
    expect(K.MB2.SEARCH_BYTES).toBe(32768);
  });
  test("MBR, VGA, serial", () => {
    expect(K.MBR.LOAD_ADDR).toBe(0x7c00);
    expect(K.MBR.SIG_OFFSET).toBe(510);
    expect(K.vgaCell("H")).toBe(0x0f48);
    expect(K.VGA_TEXT).toBe(0xb8000);
    expect(K.COM1).toBe(0x3f8);
  });
  test("stages: both paths end with one character, in long mode", () => {
    for (const p of ["uefi", "bios"] as const) {
      const s = K.bootStages(p);
      expect(s.length).toBe(8);
      expect(s[0]!.mode).toBe("real");
      const end = s[s.length - 1]!;
      expect(end.mode).toBe("long");
      expect(end.console).toBe("H");
      expect(s.slice(0, -1).every((x) => x.console === "")).toBe(true);
    }
    expect(K.bootStages("uefi").find((s) => s.id === "entry")!.mode).toBe("long");
    expect(K.bootStages("bios").find((s) => s.id === "entry")!.mode).toBe("protected");
  });
});

describe("mode machine", () => {
  test("the good order reaches 64-bit mode with these registers", () => {
    const s = K.runModes(K.GOOD_ORDER);
    expect(s.mode).toBe("long");
    expect(s.cr0).toBe(0x80000011);
    expect(s.cr4).toBe(0x20);
    expect(s.efer).toBe(0x500);
    expect(s.csBits).toBe(64);
  });
  test("single mistakes", () => {
    const die = (a: K.ModeAction[]) => K.runModes(a).mode;
    expect(die(["pg"])).toBe("shutdown");
    expect(die(["pe", "lme", "pg"])).toBe("shutdown");
    expect(die(["pe", "ljmp32"])).toBe("shutdown");
    expect(die(["ljmp32"])).toBe("shutdown");
    expect(die(["pe", "pae", "cr3", "lme", "pg", "lme"])).toBe("shutdown");
    expect(die(["lgdt", "pe", "ljmp32", "pae", "lme", "pg"])).toBe("shutdown");
    expect(die(["lgdt", "pe", "ljmp64"])).toBe("shutdown");
  });
  test("LMA turns on with PG, not with LME", () => {
    const s = K.runModes(["lgdt", "pe", "ljmp32", "pae", "cr3", "lme"]);
    expect(K.testBit(s.efer, K.EFER.LME)).toBe(true);
    expect(K.testBit(s.efer, K.EFER.LMA)).toBe(false);
    const c = K.runModes(["lgdt", "pe", "ljmp32", "pae", "cr3", "lme", "pg"]);
    expect(K.testBit(c.efer, K.EFER.LMA)).toBe(true);
    expect(c.mode).toBe("compat");
  });
  test("of 40,320 orders, 384 reach 64-bit mode", () => {
    const r = K.countGoodOrders();
    expect(r).toEqual({ total: 40320, good: 384, shutdown: 39792, other: 144 });
  });
  test("with no identity map, every order fails", () => {
    expect(K.countGoodOrders({ identity: false }).good).toBe(0);
    expect(K.runModes(K.GOOD_ORDER, { identity: false }).mode).toBe("shutdown");
  });
  test("the boot GDT values", () => {
    expect(K.modeGdtValues()).toEqual([0x00cf9a000000ffffn, 0x00cf92000000ffffn, 0x00af9a000000ffffn]);
  });
});

describe("higher-half tables", () => {
  const base: K.BootMapOpts = { identity: true, higherHalf: true, kernelPage: "2m", directMap: false };
  test("indices of the kernel address", () => {
    expect(splitVa(K.KERNEL_VMA).indices).toEqual([511, 510, 0, 0]);
    expect(splitVa(K.DIRECT_MAP).indices).toEqual([256, 0, 0, 0]);
    expect(hexVa(K.KERNEL_VMA)).toBe("0xffff_ffff_8000_0000");
    expect(isCanonical(K.KERNEL_VMA)).toBe(true);
    expect(isCanonical(0x0000800000000000n)).toBe(false);
    expect(isCanonical(0xffff7fffffffffffn)).toBe(false);
    expect(isCanonical(0x00007fffffffffffn)).toBe(true);
  });
  test("table frames", () => {
    expect(K.buildBootTables(base).tablePages).toBe(5);
    expect(K.buildBootTables({ ...base, kernelPage: "4k" }).tablePages).toBe(6);
    expect(K.buildBootTables({ ...base, directMap: true }).tablePages).toBe(6);
    expect(K.buildBootTables({ ...base, identity: false }).tablePages).toBe(3);
  });
  test("walks", () => {
    const pt = K.buildBootTables(base);
    const hi = pt.walk(K.KERNEL_VMA + 0x1234n, { user: false, kind: "x" });
    expect(hi.ok).toBe(true);
    expect(hi.pa).toBe(BigInt(K.KERNEL_PHYS) + 0x1234n);
    expect(hi.events.length).toBe(3);
    const low = pt.walk(BigInt(K.KERNEL_PHYS) + 0x1234n, { user: false, kind: "x" });
    expect(low.pa).toBe(hi.pa);
    const noId = K.buildBootTables({ ...base, identity: false });
    expect(noId.walk(BigInt(K.KERNEL_PHYS), { user: false, kind: "x" }).ok).toBe(false);
  });
});

describe("linker model", () => {
  const HI = 0xffffffff80000000n;
  test("the default image", () => {
    const d = K.layout(K.DEFAULT_ORDER, HI, true);
    expect(d.problems).toEqual([]);
    expect(d.wxPages).toBe(0);
    expect(d.segments.map((s) => s.perms)).toEqual(["r-x", "r--", "rw-"]);
    expect(d.fileBytes).toBe(25600);
    expect(d.memBytes).toBe(46080);
    expect(d.symbols.find((s) => s.name === "__bss_end")!.addr).toBe(0xffffffff8000b400n);
    const rw = d.segments[2]!;
    expect(rw.memsz - rw.filesz).toBe(0x6000);
  });
  test("no page alignment: one RWX segment", () => {
    const n = K.layout(K.DEFAULT_ORDER, HI, false);
    expect(n.segments.length).toBe(1);
    expect(n.segments[0]!.perms).toBe("rwx");
    expect(n.wxPages).toBe(1);
    expect(n.problems.some((p) => p.text.includes("RWX"))).toBe(true);
  });
  test(".bss in the middle: the file must store zeros", () => {
    const b = K.layout([".text", ".bss", ".rodata", ".data"], HI, false);
    expect(b.fileBytes).toBe(44544);
    expect(b.fileBytes - K.layout(K.DEFAULT_ORDER, HI, false).fileBytes).toBe(24576);
  });
  test("bases", () => {
    expect(K.fitsAbs32S(HI)).toBe(true);
    expect(K.fitsAbs32S(0x100000n)).toBe(true);
    expect(K.fitsAbs32S(0xffff800000100000n)).toBe(false);
    expect(K.layout(K.DEFAULT_ORDER, 0xffff800000100000n, true).problems[0]!.text).toContain("R_X86_64_32S");
    expect(K.layout(K.DEFAULT_ORDER, 0x0000800000000000n, true).problems[0]!.level).toBe("error");
  });
  test("ENTRY follows .text wherever it goes", () => {
    const o = K.layout([".rodata", ".text", ".data", ".bss"], HI, true);
    expect(o.symbols.find((s) => s.name === "_start (ENTRY)")!.addr).toBe(o.placed.find((p) => p.name === ".text")!.vma);
    expect(o.placed[0]!.vma).toBe(HI);
  });
  test("every order and alignment keeps sections apart and aligned", () => {
    const orders = [...Array(24).keys()].map((n) => {
      const a = [...K.DEFAULT_ORDER]; const out: K.SectionName[] = []; let m = n;
      for (let i = 4; i > 0; i--) { out.push(a.splice(m % i, 1)[0]!); m = Math.floor(m / i); }
      return out;
    });
    for (const o of orders) for (const pa of [true, false]) {
      const l = K.layout(o, HI, pa);
      for (let i = 1; i < l.placed.length; i++) expect(l.placed[i]!.vma >= l.placed[i - 1]!.end).toBe(true);
      if (pa) expect(l.wxPages).toBe(0);
    }
  });
});
