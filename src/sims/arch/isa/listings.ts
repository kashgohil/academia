/**
 * Small C functions and their machine code on three ISAs, for the addressing-mode and ISA-comparison lessons.
 *
 * - x86-64 and AArch64: the output of Apple clang 21 (LLVM) with
 *   `-O2 -fno-builtin -fno-vectorize -fno-slp-vectorize -fno-unroll-loops -fno-asynchronous-unwind-tables`
 *   (without -fno-builtin, clang turns slen into a tail call to strlen), targets x86_64-linux-gnu and
 *   aarch64-linux-gnu, read back with objdump. Bytes are copied from the object file. Alignment nops inside and
 *   between functions are left out (a 7-byte nop before the x86 sum loop, a 9-byte nop in the x86 slen). The relocations of `glob` are shown as the symbol name.
 * - RISC-V: hand-written RV32IM in the style of GCC and LLVM output, because the local compiler has no RISC-V
 *   backend. Each listing is assembled by the shared assembler and run on the shared hart by the tests, so it is
 *   correct code. Its bytes come from the assembler.
 *
 * `long` is 64 bits on x86-64 and AArch64 Linux (LP64) and 32 bits on RV32 (ILP32); the code does the same work.
 */

export interface MInst { text: string; bytes: number[] }
export type Isa = "x86" | "arm" | "rv";

export interface Listing {
  id: string;
  title: string;
  c: string;
  x86: MInst[];
  arm: MInst[];
  /** RV32IM source of the function body only (a label `fn:` first). */
  rv: string;
  /** Optional: the same with the Zba extension (sh1add, sh2add, sh3add), as text only (the hart has no Zba). */
  rvZba?: string[];
  /** For loops: instructions in one iteration of the inner loop, per ISA. */
  perIter?: Record<Isa, number>;
}

const x = (text: string, hex: string): MInst => ({ text, bytes: hex.trim().split(/\s+/).map((h) => parseInt(h, 16)) });
/** AArch64: objdump prints the 32-bit word; memory holds it little-endian. */
const a = (text: string, word: string): MInst => {
  const w = parseInt(word, 16);
  return { text, bytes: [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24] };
};

export const LISTINGS: Listing[] = [
  {
    id: "idx", title: "a[i]: array element", c: "int idx(int *a, long i) { return a[i]; }",
    x86: [x("mov eax, dword ptr [rdi + 4*rsi]", "8b 04 b7"), x("ret", "c3")],
    arm: [a("ldr w0, [x0, x1, lsl #2]", "b8617800"), a("ret", "d65f03c0")],
    rv: `fn:
        slli a1, a1, 2      # i * 4
        add  a0, a0, a1     # &a[i]
        lw   a0, 0(a0)
        ret`,
    rvZba: ["sh2add a0, a1, a0", "lw a0, 0(a0)", "ret"],
  },
  {
    id: "fld", title: "p->c: struct field", c: "struct S { int a, f, c; };\nint fld(struct S *p) { return p->c; }",
    x86: [x("mov eax, dword ptr [rdi + 0x8]", "8b 47 08"), x("ret", "c3")],
    arm: [a("ldr w0, [x0, #0x8]", "b9400800"), a("ret", "d65f03c0")],
    rv: `fn:
        lw   a0, 8(a0)      # base + offset: the one RISC-V mode
        ret`,
  },
  {
    id: "sidx", title: "a[i].f: field of an array element", c: "int sidx(struct S *a, long i) { return a[i].f; }  // sizeof(struct S) = 12",
    x86: [x("lea rax, [rsi + 2*rsi]", "48 8d 04 76"), x("mov eax, dword ptr [rdi + 4*rax + 0x4]", "8b 44 87 04"), x("ret", "c3")],
    arm: [a("mov w8, #0xc", "52800188"), a("madd x8, x1, x8, x0", "9b080028"), a("ldr w0, [x8, #0x4]", "b9400500"), a("ret", "d65f03c0")],
    rv: `fn:
        slli a2, a1, 1      # 2i
        add  a1, a2, a1     # 3i
        slli a1, a1, 2      # 12i
        add  a0, a0, a1     # &a[i]
        lw   a0, 4(a0)      # .f is at offset 4
        ret`,
    rvZba: ["sh1add a1, a1, a1", "sh2add a0, a1, a0", "lw a0, 4(a0)", "ret"],
  },
  {
    id: "glob", title: "g: a global variable", c: "int g;\nint glob(void) { return g; }",
    x86: [x("mov eax, dword ptr [rip + g]", "8b 05 00 00 00 00"), x("ret", "c3")],
    arm: [a("adrp x8, g", "90000008"), a("ldr w0, [x8, :lo12:g]", "b9400100"), a("ret", "d65f03c0")],
    rv: `fn:
here:   auipc a0, %pcrel_hi(g)        # pc + upper 20 bits of the distance
        lw    a0, %pcrel_lo(here)(a0) # + lower 12 bits
        ret`,
  },
  {
    id: "row", title: "m[i][j]: 2D array", c: "int row(int (*m)[16], long i, long j) { return m[i][j]; }",
    x86: [x("shl rsi, 0x6", "48 c1 e6 06"), x("add rsi, rdi", "48 01 fe"), x("mov eax, dword ptr [rsi + 4*rdx]", "8b 04 96"), x("ret", "c3")],
    arm: [a("add x8, x0, x1, lsl #6", "8b011808"), a("ldr w0, [x8, x2, lsl #2]", "b8627900"), a("ret", "d65f03c0")],
    rv: `fn:
        slli a1, a1, 6      # i * 64 bytes per row
        add  a0, a0, a1
        slli a2, a2, 2      # j * 4
        add  a0, a0, a2
        lw   a0, 0(a0)
        ret`,
    rvZba: ["slli a1, a1, 6", "add a0, a0, a1", "sh2add a0, a2, a0", "lw a0, 0(a0)", "ret"],
  },
  {
    id: "bump", title: "a[i] += 1: read-modify-write", c: "void bump(int *a, long i) { a[i] += 1; }",
    x86: [x("inc dword ptr [rdi + 4*rsi]", "ff 04 b7"), x("ret", "c3")],
    arm: [a("ldr w8, [x0, x1, lsl #2]", "b8617808"), a("add w8, w8, #0x1", "11000508"), a("str w8, [x0, x1, lsl #2]", "b8217808"), a("ret", "d65f03c0")],
    rv: `fn:
        slli a1, a1, 2
        add  a0, a0, a1
        lw   a1, 0(a0)
        addi a1, a1, 1
        sw   a1, 0(a0)
        ret`,
    rvZba: ["sh2add a0, a1, a0", "lw a1, 0(a0)", "addi a1, a1, 1", "sw a1, 0(a0)", "ret"],
  },
  {
    id: "sum", title: "sum of an array: a loop", c: "int sum(const int *a, long n) {\n  int s = 0;\n  for (long i = 0; i < n; i++) s += a[i];\n  return s;\n}",
    x86: [
      x("test rsi, rsi", "48 85 f6"), x("jle .Lzero", "7e 17"), x("xor ecx, ecx", "31 c9"), x("xor eax, eax", "31 c0"),
      x(".Lloop: add eax, dword ptr [rdi + 4*rcx]", "03 04 8f"), x("inc rcx", "48 ff c1"), x("cmp rsi, rcx", "48 39 ce"), x("jne .Lloop", "75 f5"),
      x("ret", "c3"), x(".Lzero: xor eax, eax", "31 c0"), x("ret", "c3"),
    ],
    arm: [
      a("cmp x1, #0x1", "f100043f"), a("b.lt .Lzero", "5400010b"), a("mov w8, wzr", "2a1f03e8"),
      a(".Lloop: ldr w9, [x0], #0x4", "b8404409"), a("subs x1, x1, #0x1", "f1000421"), a("add w8, w9, w8", "0b080128"), a("b.ne .Lloop", "54ffffa1"),
      a("mov w0, w8", "2a0803e0"), a("ret", "d65f03c0"), a(".Lzero: mov w8, wzr", "2a1f03e8"), a("mov w0, w8", "2a0803e0"), a("ret", "d65f03c0"),
    ],
    rv: `fn:
        mv   a2, a0         # p = a
        li   a0, 0          # s = 0
        blez a1, done
        slli a1, a1, 2
        add  a1, a2, a1     # end = a + n
loop:   lw   a3, 0(a2)
        add  a0, a0, a3
        addi a2, a2, 4      # p++
        bne  a2, a1, loop
done:   ret`,
    perIter: { x86: 4, arm: 4, rv: 4 },
  },
  {
    id: "max2", title: "max(a, b): a select", c: "int max2(int a, int b) { return a > b ? a : b; }",
    x86: [x("mov eax, esi", "89 f0"), x("cmp edi, esi", "39 f7"), x("cmovg eax, edi", "0f 4f c7"), x("ret", "c3")],
    arm: [a("cmp w0, w1", "6b01001f"), a("csel w0, w0, w1, gt", "1a81c000"), a("ret", "d65f03c0")],
    rv: `fn:
        bgt  a0, a1, done   # a > b: keep a
        mv   a0, a1
done:   ret`,
  },
  {
    id: "addf", title: "p->c += v: add to memory", c: "void addf(struct S *p, int v) { p->c += v; }",
    x86: [x("add dword ptr [rdi + 0x8], esi", "01 77 08"), x("ret", "c3")],
    arm: [a("ldr w8, [x0, #0x8]", "b9400808"), a("add w8, w8, w1", "0b010108"), a("str w8, [x0, #0x8]", "b9000808"), a("ret", "d65f03c0")],
    rv: `fn:
        lw   a2, 8(a0)
        add  a2, a2, a1
        sw   a2, 8(a0)
        ret`,
  },
  {
    id: "slen", title: "strlen: a byte loop", c: "long slen(const char *s) {\n  const char *p = s;\n  while (*p) p++;\n  return p - s;\n}",
    x86: [
      x("mov rax, -0x1", "48 c7 c0 ff ff ff ff"),
      x(".Lloop: cmp byte ptr [rdi + rax + 0x1], 0x0", "80 7c 07 01 00"), x("lea rax, [rax + 0x1]", "48 8d 40 01"), x("jne .Lloop", "75 f5"),
      x("ret", "c3"),
    ],
    arm: [
      a("mov x8, xzr", "aa1f03e8"), a(".Lloop: ldrb w9, [x0, x8]", "38686809"), a("add x8, x8, #0x1", "91000508"), a("cbnz w9, .Lloop", "35ffffc9"),
      a("sub x0, x8, #0x1", "d1000500"), a("ret", "d65f03c0"),
    ],
    rv: `fn:
        mv   a1, a0         # p = s
loop:   lbu  a2, 0(a1)
        addi a1, a1, 1
        bnez a2, loop
        sub  a0, a1, a0
        addi a0, a0, -1     # p went one past the 0
        ret`,
    perIter: { x86: 3, arm: 3, rv: 3 },
  },
];

export const listingById = (id: string): Listing => {
  const l = LISTINGS.find((v) => v.id === id);
  if (!l) throw new Error(`no listing ${id}`);
  return l;
};

/** The access patterns of the addressing-mode lesson, and the functions of the comparison lesson. */
export const MODE_IDS = ["idx", "fld", "sidx", "glob", "row", "bump", "sum"];
export const COMPARE_IDS = ["sum", "max2", "addf", "slen", "idx", "sidx"];
