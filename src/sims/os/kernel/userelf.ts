/**
 * Small user programs as real x86-64 machine code inside real static ELF64 files. The bytes are built here. The
 * loader reads them with parseElf from the processes module, and the TinyOS CPU decodes them. Nothing here is a stand-in.
 *
 * Syscall numbers: write and exit use the Linux numbers. Number 35 is sleep in ticks. On Linux, 35 is nanosleep.
 */
import { EHDR_SIZE, EM_X86_64, PF as PHF, PHDR_SIZE, PT, SHDR_SIZE } from "../processes/elf";

export const ET_EXEC = 2;
export const USER_BASE = 0x400000;
export const DATA_VADDR = 0x402000;
export const SYS = { WRITE: 1, SLEEP: 35, GETPID: 39, EXIT: 60 } as const;

/** Register numbers in x86 encoding. */
export const R = { RAX: 0, RCX: 1, RDX: 2, RBX: 3, RSP: 4, RBP: 5, RSI: 6, RDI: 7 } as const;

class Asm {
  bytes: number[] = [];
  private labels = new Map<string, number>();
  private fix: { at: number; size: 1 | 4; label: string; end: number }[] = [];
  constructor(readonly base: number) {}
  get here() { return this.base + this.bytes.length; }
  label(n: string) { this.labels.set(n, this.here); return this; }
  private u32(v: number) { for (let i = 0; i < 4; i++) this.bytes.push((v >>> (8 * i)) & 0xff); }
  movImm32(r: number, v: number) { this.bytes.push(0xb8 + r); this.u32(v); return this; }
  movImm64(r: number, v: bigint) { this.bytes.push(0x48, 0xb8 + r); for (let i = 0n; i < 8n; i++) this.bytes.push(Number((v >> (8n * i)) & 0xffn)); return this; }
  leaRsi(abs: number) { this.bytes.push(0x48, 0x8d, 0x35); this.u32((abs - (this.here + 4)) >>> 0); return this; }
  syscall() { this.bytes.push(0x0f, 0x05); return this; }
  pushRax() { this.bytes.push(0x50); return this; }
  xorEdi() { this.bytes.push(0x31, 0xff); return this; }
  decEbx() { this.bytes.push(0xff, 0xcb); return this; }
  incEbx() { this.bytes.push(0xff, 0xc3); return this; }
  incRcx() { this.bytes.push(0x48, 0xff, 0xc1); return this; }
  loadRcx() { this.bytes.push(0x48, 0x8b, 0x08); return this; }
  storeRcx() { this.bytes.push(0x48, 0x89, 0x08); return this; }
  private rel8(op: number, l: string) { this.bytes.push(op, 0); this.fix.push({ at: this.bytes.length - 1, size: 1, label: l, end: this.bytes.length }); return this; }
  jmp(l: string) { return this.rel8(0xeb, l); }
  jnz(l: string) { return this.rel8(0x75, l); }
  finish(): Uint8Array {
    for (const f of this.fix) {
      const d = this.labels.get(f.label)! - (this.base + f.end);
      if (d < -128 || d > 127) throw new Error("jump too far");
      this.bytes[f.at] = d & 0xff;
    }
    return Uint8Array.from(this.bytes);
  }
}

export interface UserProgram { name: string; about: string; elf: Uint8Array; text: Uint8Array; message: string; entry: number }

const TEXT_OFF = EHDR_SIZE + 2 * PHDR_SIZE;

/** Wraps code and data into an ELF64 executable with two PT_LOAD segments and four sections. */
function elfFile(text: Uint8Array, data: Uint8Array, bss: number): { elf: Uint8Array; entry: number } {
  const dataOff = 0x1000;
  const shstr = "\0.text\0.data\0.shstrtab\0";
  const shstrOff = dataOff + data.length;
  const shoff = (shstrOff + shstr.length + 7) & ~7;
  const shnum = 4;
  const size = shoff + shnum * SHDR_SIZE;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  const u16 = (o: number, x: number) => v.setUint16(o, x, true);
  const u32 = (o: number, x: number) => v.setUint32(o, x, true);
  const u64 = (o: number, x: number) => v.setBigUint64(o, BigInt(x), true);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  const entry = USER_BASE + TEXT_OFF;
  u16(0x10, ET_EXEC); u16(0x12, EM_X86_64); u32(0x14, 1); u64(0x18, entry); u64(0x20, EHDR_SIZE); u64(0x28, shoff);
  u16(0x34, EHDR_SIZE); u16(0x36, PHDR_SIZE); u16(0x38, 2); u16(0x3a, SHDR_SIZE); u16(0x3c, shnum); u16(0x3e, 3);
  const ph = (i: number, flags: number, off: number, va: number, fsz: number, msz: number) => {
    const o = EHDR_SIZE + i * PHDR_SIZE;
    u32(o, PT.LOAD); u32(o + 4, flags); u64(o + 8, off); u64(o + 0x10, va); u64(o + 0x18, va); u64(o + 0x20, fsz); u64(o + 0x28, msz); u64(o + 0x30, 0x1000);
  };
  ph(0, PHF.R | PHF.X, 0, USER_BASE, TEXT_OFF + text.length, TEXT_OFF + text.length);
  ph(1, PHF.R | PHF.W, dataOff, DATA_VADDR, data.length, data.length + bss);
  b.set(text, TEXT_OFF);
  b.set(data, dataOff);
  for (let i = 0; i < shstr.length; i++) b[shstrOff + i] = shstr.charCodeAt(i);
  const sh = (i: number, name: number, type: number, flags: number, addr: number, off: number, sz: number) => {
    const o = shoff + i * SHDR_SIZE;
    u32(o, name); u32(o + 4, type); u64(o + 8, flags); u64(o + 0x10, addr); u64(o + 0x18, off); u64(o + 0x20, sz); u64(o + 0x30, 1);
  };
  sh(1, 1, 1, 6, entry, TEXT_OFF, text.length);
  sh(2, 7, 1, 3, DATA_VADDR, dataOff, data.length);
  sh(3, 13, 3, 0, 0, shstrOff, shstr.length);
  return { elf: b, entry };
}

const enc = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

function program(name: string, about: string, message: string, build: (a: Asm, msgLen: number) => void): UserProgram {
  const a = new Asm(USER_BASE + TEXT_OFF);
  build(a, message.length);
  const text = a.finish();
  const { elf, entry } = elfFile(text, enc(message), 16);
  return { name, about, elf, text, message, entry };
}

const writeAndSleep = (a: Asm, len: number, ticks: number) => {
  a.movImm32(R.RAX, SYS.WRITE).movImm32(R.RDI, 1).leaRsi(DATA_VADDR).movImm32(R.RDX, len).syscall();
  a.movImm32(R.RAX, SYS.SLEEP).movImm32(R.RDI, ticks).syscall();
};

/** The kernel text address that a wild program reads. */
export const WILD_ADDR = 0xffffffff80000000n;

export const PROGRAMS: UserProgram[] = [
  program("ping", "Writes ping, sleeps for 2 ticks, forever.", "ping ", (a, n) => {
    a.pushRax(); // The first touch of the stack: a page fault that the kernel handles.
    a.label("loop");
    writeAndSleep(a, n, 2);
    a.jmp("loop");
  }),
  program("pong", "Writes pong six times, sleeps for 3 ticks each time, then calls exit(0).", "pong ", (a, n) => {
    a.pushRax();
    a.movImm32(R.RBX, 6);
    a.label("loop");
    writeAndSleep(a, n, 3);
    a.decEbx();
    a.jnz("loop");
    a.movImm32(R.RAX, SYS.EXIT).xorEdi().syscall();
  }),
  program("spin", "A loop with no system calls. Only the timer can take the CPU away.", "", (a) => {
    a.label("loop");
    a.incEbx();
    a.jmp("loop");
  }),
  program("count", "Adds 1 to a counter in .data, in a loop, and writes a dot now and then.", ". ", (a, n) => {
    a.movImm64(R.RAX, BigInt(DATA_VADDR + 8));
    a.movImm32(R.RBX, 4);
    a.label("loop");
    a.loadRcx().incRcx().storeRcx();
    a.decEbx();
    a.jnz("loop");
    a.movImm32(R.RAX, SYS.WRITE).movImm32(R.RDI, 1).leaRsi(DATA_VADDR).movImm32(R.RDX, n).syscall();
    a.movImm64(R.RAX, BigInt(DATA_VADDR + 8));
    a.movImm32(R.RBX, 4);
    a.jmp("loop");
  }),
  program("wild", "Reads kernel memory at once. The kernel kills it and nothing else.", "", (a) => {
    a.movImm64(R.RAX, WILD_ADDR);
    a.loadRcx();
    a.label("loop");
    a.jmp("loop");
  }),
];

export const programNamed = (n: string) => PROGRAMS.find((p) => p.name === n)!;
