/**
 * Sample programs for the track. Each one is short, commented, ends with exit (ecall 93) and has its expected result,
 * and tests/unit/arch-rv-programs.test.ts runs every one of them end to end on the hart. Demos load them by id.
 *
 * Exit codes here are the whole 32-bit a0 (a real Linux exit status keeps only the low 8 bits).
 */
import { mulberry32 } from "../../rng";

export interface SampleProgram {
  id: string;
  title: string;
  /** One sentence: what it does and what it is good for in a demo. */
  about: string;
  source: string;
  expect: {
    exit: number;
    output?: string;
    /** Memory after the run, from a label: words (signed int32) or bytes. */
    mem?: { label: string; words?: number[]; bytes?: number[] };
  };
}

/** The data of the branchy program: 32 values in 0..99 from a seeded PRNG, so the branch outcome looks random. */
export const BRANCHY_VALUES: number[] = (() => {
  const r = mulberry32(2024);
  return Array.from({ length: 32 }, () => Math.floor(r() * 100));
})();
export const BRANCHY_THRESHOLD = 50;

const wordLines = (v: number[], per = 8) =>
  Array.from({ length: Math.ceil(v.length / per) }, (_, i) => `        .word ${v.slice(i * per, i * per + per).join(", ")}`).join("\n");

const LIST_VALUES = [11, 22, 33, 44, 55, 66, 77, 88];

export const PROGRAMS: SampleProgram[] = [
  {
    id: "sum",
    title: "Sum of an array",
    about: "A loop with lw, add and a counted branch: the basic shape of most loops.",
    source: `# Sum of 8 words. The sum is the exit code.
        .data
arr:    .word 3, 1, 4, 1, 5, 9, 2, 6
        .text
_start:
        la   t0, arr        # t0 = pointer into the array
        li   t1, 8          # t1 = elements left
        li   a0, 0          # a0 = sum
loop:
        lw   t2, 0(t0)      # t2 = *t0
        add  a0, a0, t2
        addi t0, t0, 4      # next word
        addi t1, t1, -1
        bnez t1, loop
        li   a7, 93         # exit(a0)
        ecall
`,
    expect: { exit: 31 },
  },
  {
    id: "fib",
    title: "Fibonacci, iterative",
    about: "Register-only work with a chain of dependent adds and an unconditional jump back.",
    source: `# fib(20) with two registers. fib(0) = 0, fib(1) = 1.
        .text
_start:
        li   a0, 20         # n
        li   t0, 0          # t0 = fib(i)
        li   t1, 1          # t1 = fib(i + 1)
loop:
        beqz a0, done
        add  t2, t0, t1     # fib(i + 2)
        mv   t0, t1
        mv   t1, t2
        addi a0, a0, -1
        j    loop
done:
        mv   a0, t0
        li   a7, 93         # exit(fib(20))
        ecall
`,
    expect: { exit: 6765 },
  },
  {
    id: "fact",
    title: "Factorial, recursive",
    about: "call and ret with a real stack frame: the callee saves ra and s0 and keeps sp 16-byte aligned.",
    source: `# fact(10) by recursion.
        .text
_start:
        li   a0, 10
        call fact
        li   a7, 93         # exit(fact(10))
        ecall

# fact(n) = n <= 1 ? 1 : n * fact(n - 1)
fact:
        addi sp, sp, -16    # frame of 16 bytes
        sw   ra, 12(sp)     # save the return address
        sw   s0, 8(sp)      # save the caller's s0
        mv   s0, a0         # s0 = n survives the call
        li   t0, 1
        ble  a0, t0, base
        addi a0, a0, -1
        call fact           # a0 = fact(n - 1)
        mul  a0, s0, a0
        j    out
base:
        li   a0, 1
out:
        lw   s0, 8(sp)
        lw   ra, 12(sp)
        addi sp, sp, 16
        ret
`,
    expect: { exit: 3628800 },
  },
  {
    id: "strlen",
    title: "strlen",
    about: "A byte loop with lbu that stops at the NUL byte.",
    source: `# Length of a C string.
        .data
msg:    .asciz "hello, risc-v"
        .text
_start:
        la   a0, msg
        mv   t0, a0         # t0 walks the string
loop:
        lbu  t1, 0(t0)
        beqz t1, done       # stop at the NUL byte
        addi t0, t0, 1
        j    loop
done:
        sub  a0, t0, a0     # length = end - start
        li   a7, 93
        ecall
`,
    expect: { exit: 13 },
  },
  {
    id: "memcpy",
    title: "memcpy, byte by byte",
    about: "A function with a load and a store per byte; it prints the copy with write.",
    source: `# Copy 16 bytes, then write the copy to stdout.
        .data
src:    .ascii "RISC-V memcpy!!\\n"
dst:    .space 16
        .text
_start:
        la   a0, dst
        la   a1, src
        li   a2, 16
        call memcpy
        mv   a1, a0         # buf = dst (memcpy returns it)
        li   a0, 1          # fd = stdout
        li   a2, 16
        li   a7, 64         # write
        ecall
        li   a0, 0
        li   a7, 93         # exit(0)
        ecall

# memcpy(a0 = dst, a1 = src, a2 = n): returns dst
memcpy:
        mv   t0, a0
        beqz a2, ret0
copy:
        lbu  t1, 0(a1)
        sb   t1, 0(t0)
        addi a1, a1, 1
        addi t0, t0, 1
        addi a2, a2, -1
        bnez a2, copy
ret0:
        ret
`,
    expect: { exit: 0, output: "RISC-V memcpy!!\n", mem: { label: "dst", bytes: [...new TextEncoder().encode("RISC-V memcpy!!\n")] } },
  },
  {
    id: "dot",
    title: "Dot product",
    about: "Two loads feed a mul, and the mul feeds an add: a chain for the multiplier latency.",
    source: `# Dot product of two vectors of 8 words.
        .data
a:      .word 1, 2, 3, 4, 5, 6, 7, 8
b:      .word 8, 7, 6, 5, 4, 3, 2, 1
        .text
_start:
        la   t0, a
        la   t1, b
        li   t2, 8          # elements left
        li   a0, 0          # sum
loop:
        lw   t3, 0(t0)
        lw   t4, 0(t1)
        mul  t5, t3, t4
        add  a0, a0, t5
        addi t0, t0, 4
        addi t1, t1, 4
        addi t2, t2, -1
        bnez t2, loop
        li   a7, 93
        ecall
`,
    expect: { exit: 120 },
  },
  {
    id: "bubble",
    title: "Bubble sort",
    about: "Nested loops, a data-dependent swap branch, and stores right after loads.",
    source: `# Sort 8 words in place, ascending.
        .data
arr:    .word 5, 2, 7, 1, 8, 3, 6, 4
        .text
_start:
        la   a0, arr
        li   a1, 8
        call sort
        li   a0, 0
        li   a7, 93
        ecall

# sort(a0 = array, a1 = n): bubble sort
sort:
        addi a1, a1, -1     # a1 = compares per pass
outer:
        blez a1, done
        mv   t0, a0         # t0 = &a[j]
        mv   t1, a1         # t1 = compares left in this pass
inner:
        lw   t2, 0(t0)
        lw   t3, 4(t0)
        ble  t2, t3, noswap
        sw   t3, 0(t0)      # swap a[j] and a[j + 1]
        sw   t2, 4(t0)
noswap:
        addi t0, t0, 4
        addi t1, t1, -1
        bnez t1, inner
        addi a1, a1, -1
        j    outer
done:
        ret
`,
    expect: { exit: 0, mem: { label: "arr", words: [1, 2, 3, 4, 5, 6, 7, 8] } },
  },
  {
    id: "list",
    title: "Linked-list walk",
    about: "Pointer chasing: each loaded value is used by the next instruction (load-use hazards).",
    source: `# Sum the values of a linked list. A node is { value, next }.
        .data
n0:     .word ${LIST_VALUES[0]}, n5
n1:     .word ${LIST_VALUES[1]}, n7
n2:     .word ${LIST_VALUES[2]}, 0      # the last node: next = 0
n3:     .word ${LIST_VALUES[3]}, n1
n4:     .word ${LIST_VALUES[4]}, n6
n5:     .word ${LIST_VALUES[5]}, n3
n6:     .word ${LIST_VALUES[6]}, n2
n7:     .word ${LIST_VALUES[7]}, n4
        .text
_start:
        la   t0, n0         # t0 = node
        li   a0, 0          # sum
loop:
        lw   t1, 0(t0)      # t1 = node->value
        add  a0, a0, t1     # uses t1 at once
        lw   t0, 4(t0)      # t0 = node->next
        bnez t0, loop       # uses t0 at once
        li   a7, 93
        ecall
`,
    expect: { exit: LIST_VALUES.reduce((s, v) => s + v, 0) },
  },
  {
    id: "branchy",
    title: "Count values above a threshold",
    about: "A branch whose outcome depends on random data: hard for any predictor.",
    source: `# Count the values greater than ${BRANCHY_THRESHOLD}.
        .data
vals:
${wordLines(BRANCHY_VALUES)}
        .text
_start:
        la   t0, vals
        li   t1, ${BRANCHY_VALUES.length}         # values left
        li   t2, ${BRANCHY_THRESHOLD}         # threshold
        li   a0, 0          # count
loop:
        lw   t3, 0(t0)
        ble  t3, t2, skip   # taken or not by the data
        addi a0, a0, 1
skip:
        addi t0, t0, 4
        addi t1, t1, -1
        bnez t1, loop
        li   a7, 93
        ecall
`,
    expect: { exit: BRANCHY_VALUES.filter((v) => v > BRANCHY_THRESHOLD).length },
  },
  {
    id: "hello",
    title: "Hello",
    about: "Two system calls: write to stdout, then exit.",
    source: `# write(1, msg, 15), then exit(0).
        .data
msg:    .ascii "Hello, RISC-V!\\n"
        .text
_start:
        li   a0, 1          # fd = stdout
        la   a1, msg        # buf
        li   a2, 15         # len
        li   a7, 64         # write
        ecall
        li   a0, 0
        li   a7, 93         # exit(0)
        ecall
`,
    expect: { exit: 0, output: "Hello, RISC-V!\n" },
  },
];

export const programById = (id: string): SampleProgram => {
  const p = PROGRAMS.find((x) => x.id === id);
  if (!p) throw new Error(`no sample program ${id}`);
  return p;
};
