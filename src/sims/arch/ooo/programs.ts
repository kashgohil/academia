/**
 * The RISC-V programs of the ooo lessons, as source generators. Each one ends with exit (ecall 93) and runs on the
 * shared assembler and hart; tests/unit/arch-ooo-lessons.test.ts runs them on the out-of-order core.
 */

const exit = `        li   a7, 93
        ecall`;

/** Sum of squares with only two temporaries, reused (as a register allocator under pressure does). n is even. */
export function squaresSource(n = 16): string {
  const vals = Array.from({ length: n }, (_, i) => (i % 7) + 1);
  return `# Sum of squares of ${n} words, two elements per iteration.
# t3 and t4 are reused: the code has false dependences.
        .data
arr:    .word ${vals.join(", ")}
        .text
_start:
        la   t0, arr
        li   t1, ${n / 2}          # iterations
        li   a0, 0
loop:
        lw   t3, 0(t0)
        mul  t4, t3, t3
        add  a0, a0, t4
        lw   t3, 4(t0)      # t3 again: WAW with the first lw, WAR with the mul
        mul  t4, t3, t3     # t4 again
        add  a0, a0, t4
        addi t0, t0, 8
        addi t1, t1, -1
        bnez t1, loop
${exit}
`;
}
export const squaresExpect = (n = 16) => Array.from({ length: n }, (_, i) => ((i % 7) + 1) ** 2).reduce((a, b) => a + b, 0);

/**
 * The classic Tomasulo example (Hennessy and Patterson's FP sequence), in integer registers:
 * L.D F6 / L.D F2 / MUL.D F0,F2,F4 / SUB.D F8,F6,F2 / DIV.D F10,F0,F6 / ADD.D F6,F8,F2.
 */
export const TOMASULO_SOURCE = `# Tomasulo's sequence with integer registers.
        .data
x:      .word 0, 0, 0, 0, 0, 0, 0, 0, 42, 0, 0, 6
        .text
_start:
        la   a0, x
        li   a4, 3
        lw   a6, 32(a0)     # F6 = 42
        lw   a2, 44(a0)     # F2 = 6
        mul  t0, a2, a4     # F0 = F2 * F4 = 18
        sub  t3, a6, a2     # F8 = F6 - F2 = 36
        div  t5, t0, a6     # F10 = F0 / F6 = 0
        add  a6, t3, a2     # F6 = F8 + F2 = 42: WAR with the div
        mv   a0, a6
${exit}
`;

/** n independent one-cycle adds, for the result-bus (CDB) bandwidth. */
export function independentSource(n = 64): string {
  const regs = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
  const body = Array.from({ length: n }, (_, i) => `        addi ${regs[i % regs.length]}, zero, ${i}`).join("\n");
  return `# ${n} independent adds: each one only needs an ALU and a result bus slot.
        .text
_start:
${body}
        li   a0, 0
${exit}
`;
}

/**
 * One load per cache line (a new line each iteration, so each one misses) plus `work` independent ALU instructions.
 * With `chase`, the lines form a linked list: each load's address comes from the previous load.
 */
export function missSource(lines = 24, work = 6, chase = false): string {
  const stride = 64;
  const nodes = Array.from({ length: lines }, (_, i) => (i + 1 < lines ? `node${i + 1}` : "0"));
  const data = chase
    ? nodes.map((next, i) => `node${i}:  .word ${next}, ${i + 1}\n        .space ${stride - 8}`).join("\n")
    : `arr:    .space ${lines * stride}`;
  const extra = Array.from({ length: work }, (_, i) => `        addi s${1 + (i % 6)}, s${1 + (i % 6)}, ${i + 1}`).join("\n");
  const loop = chase
    ? `loop:
        lw   t2, 4(t0)      # node->value
        add  a0, a0, t2
${extra}
        lw   t0, 0(t0)      # node = node->next: the next address needs this load
        bnez t0, loop`
    : `loop:
        lw   t2, 0(t0)      # a new line: a miss
        add  a0, a0, t2
${extra}
        addi t0, t0, ${stride}
        addi t1, t1, -1
        bnez t1, loop`;
  return `# ${chase ? "Walk a linked list, one node per cache line" : "Read one word from each of " + lines + " cache lines"}, with ${work} other instructions per step.
        .data
${data}
        .text
_start:
        la   t0, ${chase ? "node0" : "arr"}
        li   t1, ${lines}
        li   a0, 0
${loop}
${exit}
`;
}

/**
 * The branchy count, but each value sits on its own cache line, so each load misses, and each branch depends on a
 * load that misses. `work` independent instructions per element give the window something to overlap.
 */
export function branchMissSource(values: number[], threshold: number, work = 4): string {
  const data = values.map((v) => `        .word ${v}\n        .space 60`).join("\n");
  const extra = Array.from({ length: work }, (_, i) => `        addi s${1 + (i % 6)}, s${1 + (i % 6)}, ${i + 1}`).join("\n");
  return `# Count the values greater than ${threshold}. Each value is on its own cache line.
        .data
vals:
${data}
        .text
_start:
        la   t0, vals
        li   t1, ${values.length}         # values left
        li   t2, ${threshold}         # threshold
        li   a0, 0          # count
loop:
        lw   t3, 0(t0)      # a miss
        ble  t3, t2, skip   # depends on the miss
        addi a0, a0, 1
skip:
${extra}
        addi t0, t0, 64
        addi t1, t1, -1
        bnez t1, loop
${exit}
`;
}

/** A slow divide, a load that faults (its address is outside the 64 KiB memory), and younger independent work. */
export const FAULT_SOURCE = `# A load faults while an older divide is still running.
        .text
_start:
        li   t0, 100
        li   t1, 7
        div  t2, t0, t1     # older and slow: 20 cycles
        addi s0, zero, 1    # older and fast
        li   a1, 0x20000    # outside memory
        lw   a2, 0(a1)      # load access fault
        addi s1, zero, 2    # younger, independent
        addi s2, zero, 3
        addi s3, zero, 4
        addi s4, zero, 5
        li   a7, 93
        ecall
`;

/**
 * A slow divide, a store to word slot `storeSlot` of buf, then a load from word slot `loadSlot`. With `slowAddr`, the
 * store address comes out of the divide; otherwise it is known at once, but the store still cannot commit before the
 * older divide does. The exit code is the loaded value plus 1.
 */
export function aliasSource(storeSlot: number, loadSlot: number, slowAddr: boolean): string {
  const store = slowAddr
    ? `        slli t2, t6, 2      # slot * 4, after the divide
        add  t2, a0, t2     # store address
        sw   t3, 0(t2)      # buf[${storeSlot}] = 99`
    : `        sw   t3, ${storeSlot * 4}(a0)     # buf[${storeSlot}] = 99, address known at once`;
  return `# A store to buf[${storeSlot}], then a load from buf[${loadSlot}].
        .data
buf:    .word 10, 11, 12, 13, 14, 15, 16, 17
        .text
_start:
        la   a0, buf
        li   t0, ${storeSlot * 7}
        li   t1, 7
        div  t6, t0, t1     # slot = ${storeSlot * 7} / 7: slow (20 cycles)
        li   t3, 99
${store}
        lw   t4, ${loadSlot * 4}(a0)     # load buf[${loadSlot}]
        addi a0, t4, 1      # uses the loaded value
${exit}
`;
}

/**
 * C: for (i = 0; i < n; i++) { *out[i] = i; sum += *g; }. The store's address comes from a load (out[i]), so it is
 * late; the load *g has a fixed address. out[i] points at g every `every` iterations (0: never).
 */
export function aliasLoopSource(n = 24, every = 0): string {
  const ptrs = Array.from({ length: n }, (_, i) => (every > 0 && i % every === every - 1 ? "g" : `buf + ${4 * (i % 8)}`));
  return `# for (i = 0; i < ${n}; i++) { *out[i] = i; sum += *g; }
        .data
g:      .word 5
buf:    .space 32
out:    .word ${ptrs.join(", ")}
        .text
_start:
        la   t0, out
        la   a2, g
        li   t1, 0          # i
        li   t5, ${n}
        li   a0, 0          # sum
loop:
        lw   t2, 0(t0)      # p = out[i]
        sw   t1, 0(t2)      # *p = i: its address is known late
        lw   t3, 0(a2)      # *g: its address is known at once
        add  a0, a0, t3
        addi t0, t0, 4
        addi t1, t1, 1
        bne  t1, t5, loop
${exit}
`;
}

/** The expected sum of aliasLoopSource. */
export function aliasLoopExpect(n = 24, every = 0): number {
  let g = 5, sum = 0;
  for (let i = 0; i < n; i++) { if (every > 0 && i % every === every - 1) g = i; sum += g; }
  return sum;
}

export type Mitigation = "none" | "fence" | "mask";

export const PROBE_LINES = 16;
export const LINE = 64;

/**
 * The Spectre variant 1 pattern (Kocher et al. 2019), as a concept, not an attack: victim(x) checks x against
 * size, then reads array1[x] and touches probe[array1[x] * 64]. Two calls with x in bounds train the branch; the
 * third call has x out of bounds, pointing at a secret byte. The size variable is flushed before every call, so the
 * bounds check waits for a miss. The program reads no timing: the lesson looks at the cache state directly.
 */
export function spectreSource(secret: number, mitigation: Mitigation = "none", train = 2): string {
  const xs = [...Array.from({ length: train }, (_, i) => i % 8), 40];
  const check = mitigation === "mask"
    ? `        sltu t6, a0, t1      # 1 if x < size
        neg  t6, t6          # all ones, or 0
        and  a0, a0, t6      # x, or 0 when out of bounds
        bgeu a0, t1, out`
    : `        bgeu a0, t1, out     # if (x >= size) return`;
  return `# victim(x): if (x < size) touch probe[array1[x] * 64]
        .data
size:   .word 16
        .space 60
array1: .byte 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        .space 24
secret: .byte ${secret}           # array1[40]
        .space 23
probe:  .space ${PROBE_LINES * LINE}
        .text
_start:
${xs.map((x) => `        li   a0, ${x}\n        call victim`).join("\n")}
        li   a0, 0
${exit}

victim:
        la   t0, size
        lw   t1, 0(t0)       # size: flushed, so this misses
${check}
${mitigation === "fence" ? "        fence                # a barrier: nothing younger runs early\n" : ""}        la   t2, array1
        add  t2, t2, a0
        lbu  t3, 0(t2)       # array1[x]
        slli t3, t3, 6       # * 64: one line per value
        la   t4, probe
        add  t4, t4, t3
        lbu  t5, 0(t4)       # touch probe[array1[x] * 64]
out:
        ret
`;
}
