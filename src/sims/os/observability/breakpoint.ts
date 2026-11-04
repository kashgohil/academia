/**
 * Software breakpoints over real x86-64 bytes. A very small CPU runs real machine code, so the mistakes are real too:
 * if a debugger does not rewind RIP, the CPU decodes from the middle of an instruction.
 *
 * The bytes follow the output of `clang -target x86_64-linux-gnu` and `objdump -d`:
 *   start: mov edi,41; call f; mov edi,eax; call f; mov edi,eax; mov eax,60; syscall
 *   f:     push rbp; mov rbp,rsp; mov [rbp-4],edi; mov eax,[rbp-4]; add eax,1; pop rbp; ret
 * The program calls f twice, and it exits with status 43.
 */
export const TEXT_BASE = 0x401000;
export const STACK_TOP = 0x7ffc_0000_2000;
const STACK_SIZE = 0x2000;

export const PROGRAM_BYTES: readonly number[] = [
  0xbf, 0x29, 0x00, 0x00, 0x00, // mov edi, 41
  0xe8, 0x10, 0x00, 0x00, 0x00, // call f
  0x89, 0xc7, //                   mov edi, eax
  0xe8, 0x09, 0x00, 0x00, 0x00, // call f
  0x89, 0xc7, //                   mov edi, eax
  0xb8, 0x3c, 0x00, 0x00, 0x00, // mov eax, 60
  0x0f, 0x05, //                   syscall
  0x55, //                         f: push rbp
  0x48, 0x89, 0xe5, //             mov rbp, rsp
  0x89, 0x7d, 0xfc, //             mov [rbp-4], edi
  0x8b, 0x45, 0xfc, //             mov eax, [rbp-4]
  0x83, 0xc0, 0x01, //             add eax, 1
  0x5d, //                         pop rbp
  0xc3, //                         ret
];
export const FN_ADDR = TEXT_BASE + 26;
export const INT3 = 0xcc;
export const TF_BIT = 0x100;
export const RFLAGS_BASE = 0x202;
/** Exit status of the program, with or without a debugger. */
export const PROGRAM_EXIT = 43;

export interface Decoded { addr: number; len: number; text: string; bytes: number[] }

const hex = (n: number) => `0x${n.toString(16)}`;
const signed8 = (b: number) => (b >= 128 ? b - 256 : b);

/** Decode one instruction of the small subset. Null for bytes outside it. */
export function decodeAt(read: (a: number) => number | null, addr: number): Decoded | null {
  const b0 = read(addr);
  if (b0 === null) return null;
  const at = (i: number) => read(addr + i) ?? 0;
  const imm32 = () => (at(1) | (at(2) << 8) | (at(3) << 16) | (at(4) << 24)) >>> 0;
  const mk = (len: number, text: string): Decoded => ({ addr, len, text, bytes: Array.from({ length: len }, (_, i) => at(i)) });
  switch (b0) {
    case 0xcc: return mk(1, "int3");
    case 0x55: return mk(1, "push rbp");
    case 0x5d: return mk(1, "pop rbp");
    case 0xc3: return mk(1, "ret");
    case 0xbf: return mk(5, `mov edi, ${imm32()}`);
    case 0xb8: return mk(5, `mov eax, ${imm32()}`);
    case 0xe8: return mk(5, `call ${hex((addr + 5 + (imm32() | 0)) >>> 0)}`);
    case 0x48: return at(1) === 0x89 && at(2) === 0xe5 ? mk(3, "mov rbp, rsp") : null;
    case 0x0f: return at(1) === 0x05 ? mk(2, "syscall") : null;
    case 0x83: return at(1) === 0xc0 ? mk(3, `add eax, ${signed8(at(2))}`) : null;
    case 0x8b: return at(1) === 0x45 ? mk(3, `mov eax, [rbp${signed8(at(2))}]`) : null;
    case 0x89:
      if (at(1) === 0xc7) return mk(2, "mov edi, eax");
      if (at(1) === 0xe5) return mk(2, "mov ebp, esp");
      if (at(1) === 0x7d) return mk(3, `mov [rbp${signed8(at(2))}], edi`);
      return null;
    default: return null;
  }
}

export type Trap = "BP" | "DB" | "SEGV" | "ILL" | "EXIT";
export interface CpuRegs { rip: number; rsp: number; rbp: number; rax: number; rdi: number; rflags: number }

export class X86Cpu {
  text: Uint8Array;
  stack = new Uint8Array(STACK_SIZE);
  regs: CpuRegs = { rip: TEXT_BASE, rsp: STACK_TOP - 64, rbp: 0, rax: 0, rdi: 0, rflags: RFLAGS_BASE };
  exitStatus: number | null = null;
  /** Instructions that have completed. */
  retired = 0;
  faultAddr: number | null = null;

  constructor(bytes: readonly number[] = PROGRAM_BYTES) {
    this.text = Uint8Array.from(bytes);
  }

  readText = (a: number): number | null => (a >= TEXT_BASE && a < TEXT_BASE + this.text.length ? this.text[a - TEXT_BASE]! : null);

  private stackIndex(a: number, n: number): number | null {
    const base = STACK_TOP - STACK_SIZE;
    return a >= base && a + n <= STACK_TOP ? a - base : null;
  }
  private load(a: number, n: number): number | null {
    const i = this.stackIndex(a, n);
    if (i === null) {
      this.faultAddr = a;
      return null;
    }
    let v = 0;
    for (let k = n - 1; k >= 0; k--) v = v * 256 + this.stack[i + k]!;
    return v;
  }
  private store(a: number, n: number, value: number): boolean {
    const i = this.stackIndex(a, n);
    if (i === null) {
      this.faultAddr = a;
      return false;
    }
    let v = value;
    for (let k = 0; k < n; k++) {
      this.stack[i + k] = v % 256;
      v = Math.floor(v / 256);
    }
    return true;
  }

  /** Run one instruction. It returns a trap, or null. With TF set, the CPU raises #DB after the instruction. */
  step(): Trap | null {
    const r = this.regs;
    const d = decodeAt(this.readText, r.rip);
    if (!d) return r.rip >= TEXT_BASE && r.rip < TEXT_BASE + this.text.length ? "ILL" : "SEGV";
    const b = d.bytes;
    const tf = (r.rflags & TF_BIT) !== 0;
    const next = r.rip + d.len;
    const imm = (b[1]! | (b[2]! << 8) | (b[3]! << 16) | (b[4]! << 24)) >>> 0;
    switch (b[0]) {
      case 0xcc:
        // The saved RIP points after the int3, because int3 is a trap and not a fault.
        r.rip = next;
        this.retired++;
        return "BP";
      case 0x55:
        if (!this.store(r.rsp - 8, 8, r.rbp)) return "SEGV";
        r.rsp -= 8;
        break;
      case 0x5d: {
        const v = this.load(r.rsp, 8);
        if (v === null) return "SEGV";
        r.rbp = v;
        r.rsp += 8;
        break;
      }
      case 0xc3: {
        const v = this.load(r.rsp, 8);
        if (v === null) return "SEGV";
        r.rsp += 8;
        r.rip = v;
        this.retired++;
        return tf ? "DB" : null;
      }
      case 0xbf: r.rdi = imm; break;
      case 0xb8: r.rax = imm; break;
      case 0xe8:
        if (!this.store(r.rsp - 8, 8, next)) return "SEGV";
        r.rsp -= 8;
        r.rip = next + (imm | 0);
        this.retired++;
        return tf ? "DB" : null;
      case 0x48: r.rbp = r.rsp; break;
      case 0x0f:
        if (r.rax === 60) {
          this.exitStatus = r.rdi & 0xff;
          this.retired++;
          return "EXIT";
        }
        r.rax = 0xffffffda; // -ENOSYS in eax: this small machine knows only exit
        break;
      case 0x83: r.rax = (r.rax + signed8(b[2]!)) >>> 0; break;
      case 0x8b: {
        const v = this.load(r.rbp + signed8(b[2]!), 4);
        if (v === null) return "SEGV";
        r.rax = v;
        break;
      }
      case 0x89:
        if (b[1] === 0xc7) r.rdi = r.rax >>> 0;
        else if (b[1] === 0xe5) r.rbp = r.rsp % 2 ** 32; // A 32-bit write clears the upper half of rbp.
        else if (!this.store(r.rbp + signed8(b[2]!), 4, r.rdi % 2 ** 32)) return "SEGV";
        break;
    }
    r.rip = next;
    this.retired++;
    return tf ? "DB" : null;
  }

  /** Run until a trap. */
  run(max = 10_000): Trap {
    for (let i = 0; i < max; i++) {
      const t = this.step();
      if (t) return t;
    }
    return "ILL";
  }
}

/** An instruction list from clean bytes, with the addresses that can take a breakpoint. */
export function instructionList(bytes: readonly number[] = PROGRAM_BYTES): Decoded[] {
  const cpu = new X86Cpu(bytes);
  const out: Decoded[] = [];
  let a = TEXT_BASE;
  while (a < TEXT_BASE + bytes.length) {
    const d = decodeAt(cpu.readText, a);
    if (!d) break;
    out.push(d);
    a += d.len;
  }
  return out;
}

// ---------------------------------------------------------------------------- the debugger

export type Mistake = "none" | "no-rewind" | "no-restore" | "no-reinsert";

/** A debugger that works only through word-sized peeks and pokes, register reads and single steps. */
export class Debugger {
  /** Address to original byte. */
  readonly table = new Map<number, number>();
  hits: number[] = [];
  counters = { peeks: 0, pokes: 0, regReads: 0, regWrites: 0, singleSteps: 0, conts: 0 };

  constructor(readonly cpu: X86Cpu) {}

  /** PTRACE_PEEKTEXT: read one word. */
  peek(addr: number): number[] {
    this.counters.peeks++;
    return Array.from({ length: 8 }, (_, i) => this.cpu.readText(addr + i) ?? 0);
  }
  /** PTRACE_POKETEXT: write one word. Bytes past the end of the small text are ignored. */
  poke(addr: number, word: number[]): void {
    this.counters.pokes++;
    word.forEach((b, i) => {
      if (addr + i < TEXT_BASE + this.cpu.text.length) this.cpu.text[addr + i - TEXT_BASE] = b;
    });
  }
  /** Replace one byte with a read-modify-write of a word. Bytes around it stay the same. */
  private patchByte(addr: number, byte: number): void {
    const w = this.peek(addr);
    w[0] = byte;
    this.poke(addr, w);
  }

  setBreakpoint(addr: number): void {
    if (this.table.has(addr)) return;
    const w = this.peek(addr);
    this.table.set(addr, w[0]!);
    w[0] = INT3;
    this.poke(addr, w);
  }
  removeBreakpoint(addr: number): void {
    const orig = this.table.get(addr);
    if (orig === undefined) return;
    this.patchByte(addr, orig);
    this.table.delete(addr);
  }
  /** What a debugger shows the user: memory with the int3 bytes hidden. */
  shadowedBytes(): number[] {
    const out = [...this.cpu.text];
    for (const [a, b] of this.table) out[a - TEXT_BASE] = b;
    return out;
  }

  /** The handling of one breakpoint trap: restore, rewind, single step, re-insert. */
  stepOverBreakpoint(addr: number): Trap {
    this.patchByte(addr, this.table.get(addr)!);
    this.counters.regWrites++;
    this.cpu.regs.rip = addr;
    this.counters.singleSteps++;
    this.cpu.regs.rflags |= TF_BIT;
    const t = this.cpu.step();
    this.cpu.regs.rflags &= ~TF_BIT;
    this.patchByte(addr, INT3);
    return t ?? "DB";
  }

  /** Run to the end. It stops at each breakpoint and steps over it. It returns the final trap. */
  runToEnd(maxStops = 1000): Trap {
    for (let i = 0; i < maxStops; i++) {
      this.counters.conts++;
      const t = this.cpu.run();
      if (t !== "BP") return t;
      this.counters.regReads++;
      const addr = this.cpu.regs.rip - 1;
      if (!this.table.has(addr)) return "BP";
      this.hits.push(addr);
      const s = this.stepOverBreakpoint(addr);
      if (s !== "DB") return s;
    }
    return "ILL";
  }
}

// ---------------------------------------------------------------------------- the stepper

export interface BpStep {
  title: string;
  text: string;
  bytes: number[];
  /** Offsets to highlight in the bytes. */
  hot: number[];
  regs: CpuRegs;
  /** The original byte that the debugger saved. */
  saved: number | null;
  /** The next instruction that the CPU would decode. */
  next: string;
  who: "debugger" | "tracee" | "cpu";
  /** A ptrace call, as code. */
  call?: string;
  end?: "exit" | "segv" | "ill" | "stuck" | "missed";
  hits: number;
}

/** The steps of one debugging session with a breakpoint at `bp`. `mistake` leaves out one of the steps. */
export function breakpointSteps(bp: number, mistake: Mistake = "none"): BpStep[] {
  const cpu = new X86Cpu();
  const dbg = new Debugger(cpu);
  const out: BpStep[] = [];
  let saved: number | null = null;
  let hits = 0;
  const off = bp - TEXT_BASE;
  const nextText = () => {
    const d = decodeAt(cpu.readText, cpu.regs.rip);
    return d ? d.text : `cannot decode at ${hex(cpu.regs.rip)}`;
  };
  const snap = (s: Pick<BpStep, "title" | "text" | "who"> & Partial<BpStep>) => {
    out.push({ bytes: [...cpu.text], hot: [], regs: { ...cpu.regs }, saved, next: nextText(), hits, ...s });
  };
  snap({ title: "The program in memory", text: "These are the real bytes of the program. The debugger wants to stop at the selected instruction.", who: "debugger", hot: [off] });
  const w = dbg.peek(bp);
  saved = w[0]!;
  snap({ title: "Read the word", text: `PTRACE_PEEKTEXT reads 8 bytes at ${hex(bp)}. The debugger saves the first byte, 0x${saved.toString(16)}, in its table.`, who: "debugger", hot: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => off + i), call: `ptrace(PTRACE_PEEKTEXT, pid, ${hex(bp)}, 0)` });
  dbg.setBreakpoint(bp);
  snap({ title: "Write 0xCC", text: "PTRACE_POKETEXT writes the word back, with 0xCC as the first byte. Text is read-only, so the kernel writes to a private copy of the page.", who: "debugger", hot: [off], call: `ptrace(PTRACE_POKETEXT, pid, ${hex(bp)}, word)` });

  for (let round = 0; round < 4; round++) {
    const before = cpu.retired;
    const t = cpu.run();
    const ran = cpu.retired - before;
    if (t === "EXIT") {
      const missed = mistake === "no-reinsert" && hits === 1 && bp >= FN_ADDR;
      snap({ title: "The program exits", text: `The tracee ran ${ran} more instructions and called exit with status ${cpu.exitStatus}.${missed ? " The second call of f did not stop, because the debugger did not put the 0xCC back." : ""}`, who: "tracee", end: missed ? "missed" : "exit", call: "ptrace(PTRACE_CONT, pid, 0, 0)" });
      return out;
    }
    if (t === "SEGV") {
      snap({ title: "SIGSEGV", text: `The tracee crashes at address ${hex(cpu.faultAddr ?? cpu.regs.rip)}. The CPU decoded the wrong instruction, so a register is wrong.`, who: "cpu", end: "segv" });
      return out;
    }
    if (t === "ILL") {
      snap({ title: "The bytes make no sense", text: "The CPU now decodes from the middle of an instruction. This small emulator cannot run these bytes. A real CPU would run something unplanned.", who: "cpu", end: "ill" });
      return out;
    }
    hits++;
    snap({ title: "The CPU runs 0xCC", text: `The tracee ran ${ran} instructions, and the last one is int3. It raises #BP (vector 3). The kernel saves RIP, which now points 1 byte past the 0xCC, and it sends SIGTRAP. The tracee stops.`, who: "cpu", hot: [off], call: "ptrace(PTRACE_CONT, pid, 0, 0)" });
    snap({ title: "Read the registers", text: `waitpid returns SIGTRAP. PTRACE_GETREGS gives RIP = ${hex(cpu.regs.rip)}. RIP - 1 is in the table, so this is our breakpoint, hit ${hits}. The user looks around here.`, who: "debugger", hot: [off], call: "ptrace(PTRACE_GETREGS, pid, 0, &regs)" });
    if (mistake !== "no-restore") {
      const word = dbg.peek(bp);
      word[0] = saved;
      dbg.poke(bp, word);
      snap({ title: "Restore the byte", text: `The original byte 0x${saved.toString(16)} goes back. The instruction is whole again.`, who: "debugger", hot: [off], call: `ptrace(PTRACE_POKETEXT, pid, ${hex(bp)}, word)` });
    }
    if (mistake !== "no-rewind") {
      cpu.regs.rip = bp;
      snap({ title: "Rewind RIP", text: `PTRACE_SETREGS sets RIP back by 1, to ${hex(bp)}. The CPU will now run the real instruction from its first byte.`, who: "debugger", hot: [off], call: "ptrace(PTRACE_SETREGS, pid, 0, &regs)" });
    }
    if (mistake === "no-restore") {
      if (hits >= 2) {
        snap({ title: "No progress", text: "The 0xCC is still there, so each run traps again at the same address. The program never moves past this point.", who: "cpu", end: "stuck", hot: [off] });
        return out;
      }
      snap({ title: "The byte is still 0xCC", text: "The debugger did not restore the byte, so the next instruction is int3 again.", who: "debugger", hot: [off] });
      continue;
    }
    cpu.regs.rflags |= TF_BIT;
    const beforeStep = cpu.regs.rip;
    const st = cpu.step();
    cpu.regs.rflags &= ~TF_BIT;
    if (st === "EXIT") {
      snap({ title: "The program exits", text: `The stepped instruction was the exit call. The status is ${cpu.exitStatus}.`, who: "tracee", end: "exit", call: "ptrace(PTRACE_SINGLESTEP, pid, 0, 0)" });
      return out;
    }
    if (st !== "DB") {
      snap({ title: st === "SEGV" ? "SIGSEGV" : "The bytes make no sense", text: st === "SEGV" ? `The tracee crashes at address ${hex(cpu.faultAddr ?? cpu.regs.rip)}.` : "The CPU decoded from the middle of an instruction. This small emulator cannot run these bytes. A real CPU would run something unplanned.", who: "cpu", end: st === "SEGV" ? "segv" : "ill" });
      return out;
    }
    snap({ title: "Single step", text: `PTRACE_SINGLESTEP sets the trap flag (bit 8 of RFLAGS). The CPU runs one instruction from ${hex(beforeStep)}, and it raises #DB (vector 1). RIP is now ${hex(cpu.regs.rip)}.${mistake === "no-rewind" ? " That instruction started 1 byte too late, so it was the wrong one." : ""}`, who: "cpu", hot: [off], call: "ptrace(PTRACE_SINGLESTEP, pid, 0, 0)" });
    if (mistake !== "no-reinsert") {
      const word = dbg.peek(bp);
      word[0] = INT3;
      dbg.poke(bp, word);
      snap({ title: "Put 0xCC back", text: "The breakpoint is active again, for the next time. Then PTRACE_CONT lets the program run at full speed.", who: "debugger", hot: [off], call: `ptrace(PTRACE_POKETEXT, pid, ${hex(bp)}, word)` });
    }
  }
  return out;
}
