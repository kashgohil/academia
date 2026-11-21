/**
 * Instructions that touch two pages, and what the machine state looks like when the second page faults.
 *
 * - x86 REP MOVSB: the SDM says that a fault suspends the repeated string operation with the registers
 *   preserved: RSI and RDI point to the next elements, RCX holds the count after the last completed
 *   iteration, and RIP still points to the instruction. After the handler, the instruction resumes.
 * - RISC-V misaligned store across a page boundary: an implementation may split it into parts. The privileged
 *   spec allows a part that passed its check to become visible even though another part faults. stval
 *   holds the address of the part that faulted; sepc holds the address of the instruction.
 *
 * The byte-at-a-time copy and the split into two 4-byte parts are models of one possible implementation.
 */

export interface MemByte { addr: number; value: number | null }

export interface MpState {
  step: number;
  text: string;
  regs: Record<string, string>;
  /** Destination bytes, in order: null = not written yet. */
  dst: MemByte[];
  fault: boolean;
  handler: boolean;
}

const hex = (v: number) => `0x${v.toString(16)}`;

/** REP MOVSB that copies `count` bytes from src to dst. The page of dst + 8 starts out unmapped. */
export function repMovsb(src = 0x1ff8, dst = 0x5ff8, count = 16): MpState[] {
  const pageOf = (a: number) => a >> 12;
  const mapped = new Set([pageOf(src), pageOf(src + count - 1), pageOf(dst)]);
  const data = Array.from({ length: count }, (_, i) => 0x41 + i); // "ABCD..."
  const out: MpState[] = [];
  const bytes: MemByte[] = Array.from({ length: count }, (_, i) => ({ addr: dst + i, value: null }));
  let rsi = src, rdi = dst, rcx = count, step = 0;
  const regs = (extra: Record<string, string> = {}) => ({ RIP: "rep movsb", RSI: hex(rsi), RDI: hex(rdi), RCX: String(rcx), ...extra });
  out.push({ step: step++, text: `Start: copy ${count} bytes from ${hex(src)} to ${hex(dst)}.`, regs: regs(), dst: bytes.map((b) => ({ ...b })), fault: false, handler: false });
  let faults = 0;
  while (rcx > 0) {
    if (!mapped.has(pageOf(rdi))) {
      faults++;
      out.push({ step: step++, text: `The store to ${hex(rdi)} has no translation: page fault. CR2 = ${hex(rdi)}. RIP still points to rep movsb, and RCX = ${rcx} bytes remain.`, regs: regs({ CR2: hex(rdi) }), dst: bytes.map((b) => ({ ...b })), fault: true, handler: false });
      mapped.add(pageOf(rdi));
      out.push({ step: step++, text: `The kernel maps page ${hex(rdi & ~0xfff)} and returns with IRET to the same instruction.`, regs: regs({ CR2: hex(rdi) }), dst: bytes.map((b) => ({ ...b })), fault: false, handler: true });
      continue;
    }
    bytes[rdi - dst]!.value = data[rsi - src]!;
    rsi++; rdi++; rcx--;
    const crossed = (rdi & 0xfff) === 0;
    if (crossed || rcx === 0 || rcx % 4 === 0) {
      out.push({ step: step++, text: rcx === 0 ? `Done: RCX = 0. The copy took ${faults} page fault${faults === 1 ? "" : "s"} and no byte was copied twice.` : `Copied up to ${hex(rdi - 1)}. RCX = ${rcx}.`, regs: regs(), dst: bytes.map((b) => ({ ...b })), fault: false, handler: false });
    }
  }
  return out;
}

/** sd of 8 bytes at a misaligned address that crosses into an unmapped page, split into two 4-byte parts. */
export function misalignedStore(addr = 0x1ffc): MpState[] {
  const value = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
  const bytes: MemByte[] = value.map((_, i) => ({ addr: addr + i, value: null }));
  const second = (addr + 4) & ~0xfff;
  const s = (step: number, text: string, extra: Record<string, string>, fault = false, handler = false): MpState =>
    ({ step, text, regs: { pc: "sd a0, 0(a1)", a1: hex(addr), ...extra }, dst: bytes.map((b) => ({ ...b })), fault, handler });
  const out: MpState[] = [s(0, `Store 8 bytes at ${hex(addr)}: 4 bytes in this page and 4 in the next. This core splits the store in two parts.`, {})];
  for (let i = 0; i < 4; i++) bytes[i]!.value = value[i]!;
  out.push(s(1, `Part 1 (${hex(addr)} to ${hex(addr + 3)}) passes its check and is written. Another hart can see it now.`, {}));
  out.push(s(2, `Part 2 at ${hex(second)} has no translation: store/AMO page fault. scause = 15, stval = ${hex(second)}, sepc = the sd.`, { scause: "15", stval: hex(second) }, true));
  out.push(s(3, `The kernel maps page ${hex(second)}, executes sfence.vma, and returns with sret to the same sd.`, { scause: "15", stval: hex(second) }, false, true));
  for (let i = 0; i < 8; i++) bytes[i]!.value = value[i]!;
  out.push(s(4, "The sd runs again from the start and writes all 8 bytes. Part 1 is written twice with the same value, so the result is correct.", {}));
  return out;
}
