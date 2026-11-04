/**
 * TinyOS: a small kernel model that composes the wave 1 sims.
 *
 * - Memory: PhysMem (frames) and PageTable (real 4-level tables), one table per task, with PML4[511] shared.
 * - Programs: real ELF64 files with real x86-64 bytes (userelf.ts), read with parseElf and mapSegments.
 * - CPU: fetches and decodes those bytes through PageTable.walk, so each access has the rights the hardware gives.
 * - Faults: VmaTree finds the area. A valid touch gets a page and retries. Anything else kills the task, and only it.
 * - Scheduler: round-robin with a timer, sleep and wake, and an idle state.
 * - Syscalls: the syscall and sysretq register rules, with SYSCALL_NR and ERRNO from the processes module.
 *
 * One `step()` is one instruction in user mode, or one short kernel action. Kernel code runs with IF = 0.
 */
import { ERRNO, SYSCALL_NR } from "../processes/syscall";
import { mapSegments, parseElf, PT, STACK_TOP } from "../processes/elf";
import { hexShort, PAGE_SIZE, splitVa } from "../vm/addr";
import { PF as FAULT, PageTable, entryPfn, describeErrorCode } from "../vm/pagetable";
import { FREE, PhysMem, UNMOVABLE } from "../vm/physmem";
import { VmaTree } from "../vm/vma";
import type { Job, Slice, Trace, TraceEvent } from "../scheduling/types";
import { FrameTableMem } from "./heap";
import { SYS, programNamed, type UserProgram } from "./userelf";
import { IDT_ENTRIES, SEL, TINY_SFMASK, TINY_STAR, VEC, hexN } from "./x86";

export const KERNEL_TEXT = 0xffffffff80000000n;
const KERNEL_DATA = 0xffffffff80100000n;
const LSTAR = KERNEL_TEXT + 0x1000n;
const TIMER_ISR = KERNEL_TEXT + 0x1100n;
const PF_ISR = KERNEL_TEXT + 0x1200n;
const GP_ISR = KERNEL_TEXT + 0x1300n;
const IDLE = KERNEL_TEXT + 0x1400n;
export const KSTACK_AREA = 0xffffffffc0000000n;
/** One kernel stack page per task, with an unmapped guard page below it. */
export const kstackVa = (pid: number) => KSTACK_AREA + BigInt(pid) * 0x2000n + 0x1000n;
export const kstackTop = (pid: number) => kstackVa(pid) + 0x1000n;
/** Pages of user stack that a task may touch. */
export const USER_STACK_PAGES = 4;
const USER_STACK_TOP = BigInt(STACK_TOP);

/** MODEL INPUTS. */
export const TINY = {
  /** 2 MiB: one PhysMem block. */
  blocks: 1,
  /** Frames for the kernel image and boot data. */
  kernelFrames: 32,
  textPages: 8,
  dataPages: 4,
  /** Steps between timer interrupts. */
  timerPeriod: 12,
  maxTasks: 16,
} as const;

export type RegName = "rax" | "rbx" | "rcx" | "rdx" | "rsi" | "rdi" | "rsp" | "rip" | "r11" | "rflags";
export type URegs = Record<RegName, bigint>;
export const REG_ORDER: RegName[] = ["rip", "rsp", "rax", "rbx", "rcx", "rdx", "rsi", "rdi", "r11", "rflags"];

export type TaskState = "ready" | "running" | "sleeping" | "dead";
export type FrameKind = "kernel" | "ktable" | "table" | "text" | "data" | "stack" | "kstack";

export interface UserPage { va: bigint; pfn: number; kind: FrameKind; rights: string }

export interface Task {
  pid: number;
  name: string;
  state: TaskState;
  pt: PageTable;
  vmas: VmaTree;
  pages: Map<bigint, UserPage>;
  regs: URegs;
  via: "iretq" | "sysretq";
  wakeAt: number;
  killPending: boolean;
  retired: number;
  bytesWritten: number;
  faultsHandled: number;
  exit: string | null;
  inject: Inject | null;
}

export type Inject = "read-kernel" | "write-kernel" | "write-own-text" | "read-unmapped" | "non-canonical" | "write-kernel-ptr" | "read-own-data";

export const INJECT_LABEL: Record<Inject, string> = {
  "read-kernel": "reads kernel memory",
  "write-kernel": "writes kernel memory",
  "write-own-text": "writes its own code",
  "read-unmapped": "reads an unmapped address",
  "non-canonical": "uses a non-canonical address",
  "write-kernel-ptr": "calls write(1, kernel address, 8)",
  "read-own-data": "reads 0x402000",
};

export interface LogLine { cycle: number; pid: number | null; kind: "boot" | "syscall" | "fault" | "sched" | "irq" | "kill" | "load"; text: string }
export interface SyscallLine { cycle: number; pid: number; name: string; args: string; ret: string }
export interface ConsoleChunk { pid: number | null; text: string }
export interface Seg { pid: number; start: number; end: number; kernel: boolean }

const U64 = (1n << 64n) - 1n;
const asU = (v: bigint) => v & U64;
const hx = (v: bigint) => `0x${hexShort(v)}`;
const ZF = 1n << 6n;
const USER_FLAGS = 0x202n;

export class TinyOS {
  phys = new PhysMem(TINY.blocks);
  frameKind = new Map<number, FrameKind>();
  frameMem = new Map<number, Uint8Array>();
  private tableOwner: number = UNMOVABLE;
  mem: FrameTableMem = new FrameTableMem({
    alloc: () => {
      const f = this.phys.allocSmall(this.tableOwner);
      if (f < 0) throw new OutOfFrames();
      this.frameKind.set(f, this.tableOwner === UNMOVABLE ? "ktable" : "table");
      return f;
    },
    free: (pfn) => this.freeFrame(pfn),
  });
  kpt: PageTable | null = null;

  booted = false;
  ring: 0 | 3 = 0;
  modeLabel = "off";
  ifFlag = false;
  regs: URegs = { rax: 0n, rbx: 0n, rcx: 0n, rdx: 0n, rsi: 0n, rdi: 0n, rsp: 0n, rip: 0n, r11: 0n, rflags: 2n };
  cr3 = 0;
  cr2 = 0n;
  tssRsp0 = 0n;
  gsKsp = 0n;
  cs: number = SEL.KCODE;
  msr = { star: 0n, lstar: 0n, sfmask: 0 };
  idtGates = 0;
  gdtEntries = 0;

  tasks = new Map<number, Task>();
  current: Task | null = null;
  runq: number[] = [];
  sleepers: number[] = [];
  ticks = 0;
  cycle = 0;
  irqPending = false;
  private nextPid = 1;

  log: LogLine[] = [];
  syscalls: SyscallLine[] = [];
  console: ConsoleChunk[] = [];
  segs: Seg[] = [];

  private kq: (() => void)[] = [];
  /** Text of the last step, for the banner. */
  last = "The machine is off. Press Boot.";

  // ------------------------------------------------------------------ small helpers

  private note(kind: LogLine["kind"], text: string, pid: number | null = this.current?.pid ?? null) {
    this.last = text;
    this.log.push({ cycle: this.cycle, pid, kind, text });
    if (this.log.length > 400) this.log.shift();
  }

  private allocFrame(owner: number, kind: FrameKind): number | null {
    const f = this.phys.allocSmall(owner);
    if (f < 0) return null;
    this.frameKind.set(f, kind);
    return f;
  }

  private freeFrame(pfn: number) {
    this.phys.freeSmall(pfn);
    this.frameKind.delete(pfn);
    this.frameMem.delete(pfn);
  }

  /** A frame's bytes. A frame reads as zero until someone writes it, so a new owner never sees old data. */
  private bytesOf(pfn: number): Uint8Array {
    let b = this.frameMem.get(pfn);
    if (!b) { b = new Uint8Array(PAGE_SIZE); this.frameMem.set(pfn, b); }
    return b;
  }

  get freeFrames() { return this.phys.freeFrames; }
  get totalFrames() { return this.phys.frameCount; }
  get busy() { return this.kq.length > 0; }

  // ------------------------------------------------------------------ boot

  /** Queues the boot steps. Each runs in one `step`. */
  boot() {
    if (this.booted || this.kq.length) return;
    const K = () => this.kpt!;
    const q = this.kq;
    this.modeLabel = "long mode, ring 0";
    this.regs.rip = KERNEL_TEXT;
    this.last = "The loader jumped to the kernel. CPU: long mode, ring 0, IF = 0. Press Step.";
    q.push(() => {
      this.gdtEntries = 5;
      this.cs = SEL.KCODE;
      this.note("boot", `lgdt: null, kernel code 0x08, kernel data 0x10, user data 0x18, user code 0x20. ltr 0x28 loads the TSS.`);
    });
    q.push(() => {
      this.idtGates = IDT_ENTRIES;
      this.note("boot", `lidt: ${IDT_ENTRIES} gates. #DF uses IST1, so a stack overflow still has a stack.`);
    });
    q.push(() => {
      // Mark all frames used, then release the usable ones: PhysMem has only allocSmall and freeSmall.
      for (;;) { const f = this.phys.allocSmall(UNMOVABLE); if (f < 0) break; this.frameKind.set(f, "kernel"); }
      for (let f = TINY.kernelFrames; f < this.phys.frameCount; f++) this.freeFrame(f);
      this.note("boot", `Memory map: ${this.phys.frameCount} frames. The kernel keeps ${TINY.kernelFrames}, and ${this.freeFrames} go to the frame allocator.`);
    });
    q.push(() => {
      this.tableOwner = UNMOVABLE;
      this.kpt = new PageTable({ mem: this.mem });
      for (let i = 0; i < TINY.textPages; i++) K().map(KERNEL_TEXT + BigInt(i * PAGE_SIZE), i, { user: false, global: true });
      for (let i = 0; i < TINY.dataPages; i++) K().map(KERNEL_DATA + BigInt(i * PAGE_SIZE), TINY.textPages + i, { user: false, writable: true, nx: true, global: true });
      this.cr3 = K().root;
      this.note("boot", `The kernel builds its own tables. Text is R-X and data is RW-, both with U = 0, at ${hx(KERNEL_TEXT)}. CR3 = frame ${this.cr3}.`);
    });
    q.push(() => {
      this.msr = { star: TINY_STAR, lstar: LSTAR, sfmask: TINY_SFMASK };
      this.note("boot", `wrmsr: EFER.SCE = 1, STAR = ${hexN(TINY_STAR, 16)}, LSTAR = ${hx(LSTAR)}, SFMASK = ${hexN(TINY_SFMASK)}.`);
    });
    q.push(() => {
      this.ifFlag = true;
      this.regs.rip = IDLE;
      this.booted = true;
      this.note("boot", `The local APIC timer runs with a period of ${TINY.timerPeriod} steps. sti. The boot code becomes the idle loop: hlt.`);
    });
  }

  // ------------------------------------------------------------------ loading

  /** Loads a static ELF into a new address space and puts the task on the run queue. */
  spawn(progName: string | UserProgram): number | null {
    if (!this.booted) return null;
    const prog = typeof progName === "string" ? programNamed(progName) : progName;
    if ([...this.tasks.values()].filter((t) => t.state !== "dead").length >= TINY.maxTasks) { this.note("load", "The task table is full."); return null; }
    const parsed = parseElf(prog.elf);
    if (!parsed.magicOk || parsed.machine !== 62) throw new Error("not an x86-64 ELF");
    const segs = mapSegments(parsed, 0, prog.name);
    const pagesNeeded = segs.reduce((a, v) => a + (v.end - v.start) / PAGE_SIZE, 0);
    // A safe upper limit: the top table, tables for code and data, and a kernel stack.
    if (this.freeFrames < pagesNeeded + 8) { this.note("load", `Out of frames: ${prog.name} is not loaded.`, null); return null; }
    const pid = this.nextPid++;
    this.tableOwner = pid;
    const pt = new PageTable({ mem: this.mem });
    // The kernel half is the same in all address spaces: one shared PML4 entry.
    const kroot = this.kpt!.root;
    this.mem.write(pt.root, 511, this.mem.read(kroot, 511));
    const task: Task = {
      pid, name: prog.name, state: "ready", pt, vmas: new VmaTree(), pages: new Map(),
      regs: { rax: 0n, rbx: 0n, rcx: 0n, rdx: 0n, rsi: 0n, rdi: 0n, rsp: USER_STACK_TOP, rip: BigInt(parsed.entry), r11: 0n, rflags: USER_FLAGS },
      via: "iretq", wakeAt: 0, killPending: false, retired: 0, bytesWritten: 0, faultsHandled: 0, exit: null, inject: null,
    };
    // PT_LOAD: map each page, then copy the file bytes.
    for (const p of parsed.phdrs) {
      if (p.type !== PT.LOAD) continue;
      const start = Math.floor(p.vaddr / PAGE_SIZE) * PAGE_SIZE;
      const end = Math.ceil((p.vaddr + p.memsz) / PAGE_SIZE) * PAGE_SIZE;
      const exec = (p.flags & 1) !== 0, write = (p.flags & 2) !== 0;
      task.vmas.insert({ start, end, read: true, write, exec, shared: false, name: exec ? ".text" : ".data" });
      for (let va = start; va < end; va += PAGE_SIZE) {
        const kind: FrameKind = exec ? "text" : "data";
        const pfn = this.allocFrame(pid, kind)!;
        pt.map(va, pfn, { user: true, writable: write, nx: !exec });
        task.pages.set(BigInt(va), { va: BigInt(va), pfn, kind, rights: `r${write ? "w" : "-"}${exec ? "x" : "-"}` });
        const page = this.bytesOf(pfn);
        for (let o = 0; o < PAGE_SIZE; o++) {
          const fileOff = va + o - p.vaddr;
          if (fileOff >= 0 && fileOff < p.filesz) page[o] = prog.elf[p.offset + fileOff]!;
        }
      }
    }
    const stackStart = STACK_TOP - USER_STACK_PAGES * PAGE_SIZE;
    task.vmas.insert({ start: stackStart, end: STACK_TOP, read: true, write: true, exec: false, shared: false, name: "[stack]" });
    // The kernel stack is in the shared kernel half. Its tables belong to the kernel.
    const ks = this.allocFrame(pid, "kstack")!;
    this.tableOwner = UNMOVABLE;
    this.kpt!.map(kstackVa(pid), ks, { user: false, writable: true, nx: true, global: true });
    this.tasks.set(pid, task);
    this.runq.push(pid);
    this.note("load", `Load ${prog.name}: pid ${pid}, entry ${hx(BigInt(parsed.entry))}, ${segs.length} segments, ${task.pages.size} pages. The first iretq frame is ready. The run queue is ${this.runq.join(", ")}.`, pid);
    return pid;
  }

  // ------------------------------------------------------------------ user memory

  private access(t: Task, va: bigint, kind: "r" | "w" | "x"): { pa: bigint; pfn: number } | { fault: "pf" | "gp"; code: number } {
    const w = t.pt.walk(va, { kind, user: true });
    if (w.ok) return { pa: w.pa!, pfn: w.pfn! };
    if (w.fault!.reason === "non-canonical") return { fault: "gp", code: 0 };
    return { fault: "pf", code: w.fault!.code };
  }

  private readByte(t: Task, va: bigint, kind: "r" | "x"): number | { fault: "pf" | "gp"; code: number } {
    const a = this.access(t, va, kind);
    if ("fault" in a) return a;
    return this.bytesOf(a.pfn)[Number(a.pa & 0xfffn)]!;
  }

  private read64(t: Task, va: bigint): bigint | { fault: "pf" | "gp"; code: number } {
    let v = 0n;
    for (let i = 0n; i < 8n; i++) {
      const b = this.readByte(t, va + i, "r");
      if (typeof b !== "number") return b;
      v |= BigInt(b) << (8n * i);
    }
    return v;
  }

  private write64(t: Task, va: bigint, v: bigint): null | { fault: "pf" | "gp"; code: number } {
    // Check all pages first, so that a fault leaves memory unchanged.
    for (const off of [0n, 7n]) { const a = this.access(t, va + off, "w"); if ("fault" in a) return a; }
    for (let i = 0n; i < 8n; i++) {
      const a = this.access(t, va + i, "w") as { pa: bigint; pfn: number };
      this.bytesOf(a.pfn)[Number(a.pa & 0xfffn)] = Number((v >> (8n * i)) & 0xffn);
    }
    return null;
  }

  /** copy_from_user: only addresses in the lower half, and only pages with U = 1. It never faults. */
  private copyFromUser(t: Task, va: bigint, len: number): Uint8Array | null {
    if (asU(va) >= 1n << 47n || asU(va) + BigInt(len) > 1n << 47n) return null;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const b = this.readByte(t, va + BigInt(i), "r");
      if (typeof b !== "number") return null;
      out[i] = b;
    }
    return out;
  }

  // ------------------------------------------------------------------ the CPU

  /** Runs one step. */
  step() {
    this.cycle++;
    if (this.booted && this.cycle % TINY.timerPeriod === 0) this.irqPending = true;
    const t = this.current;
    const seg = (pid: number, kernel: boolean) => {
      const last = this.segs[this.segs.length - 1];
      if (last && last.pid === pid && last.kernel === kernel && last.end === this.cycle - 1) last.end = this.cycle;
      else this.segs.push({ pid, start: this.cycle - 1, end: this.cycle, kernel });
      if (this.segs.length > 4000) this.segs.shift();
    };
    if (this.kq.length) {
      if (t) seg(t.pid, true);
      this.kq.shift()!();
      return;
    }
    if (!this.booted) return;
    if (this.ring === 3 && t) {
      if (this.irqPending) { seg(t.pid, true); this.timerEntry(); return; }
      seg(t.pid, false);
      this.execUser(t);
      return;
    }
    // Idle.
    if (this.irqPending) { this.timerEntry(); return; }
    if (this.runq.length) { this.scheduleNow(); return; }
    this.last = "Idle: hlt. The CPU waits for the next interrupt.";
  }

  run(n: number) { for (let i = 0; i < n; i++) this.step(); }

  private enterKernel(t: Task | null, rip: bigint, how: string) {
    if (t) t.regs = { ...this.regs };
    this.ring = 0;
    this.cs = SEL.KCODE;
    this.ifFlag = false;
    this.regs.rip = rip;
    if (t) this.regs.rsp = kstackTop(t.pid);
    this.regs.rflags = 2n;
    this.modeLabel = `ring 0: ${how}`;
  }

  private timerEntry() {
    const t = this.ring === 3 ? this.current : null;
    this.irqPending = false;
    this.enterKernel(t, TIMER_ISR, "timer IRQ");
    this.note("irq", t ? `Timer IRQ in user mode. The CPU loads rsp from TSS.RSP0 = ${hx(this.tssRsp0)} and pushes ss, rsp, rflags, cs, rip.` : "Timer IRQ wakes the CPU from hlt.");
    if (t) t.via = "iretq";
    this.kq.push(() => this.timerHandler(t));
  }

  private timerHandler(t: Task | null) {
    this.ticks++;
    const woke: number[] = [];
    this.sleepers = this.sleepers.filter((pid) => {
      const s = this.tasks.get(pid)!;
      if (s.wakeAt <= this.ticks) { s.state = "ready"; this.runq.push(pid); woke.push(pid); return false; }
      return true;
    });
    const wokeText = woke.length ? ` Wake pid ${woke.join(", ")}.` : "";
    if (t?.killPending) {
      this.note("irq", `Tick ${this.ticks}. EOI.${wokeText}`);
      this.kq.push(() => this.finish(t, t.exit ?? "killed"));
      return;
    }
    if (t && this.runq.length) {
      t.state = "ready";
      this.runq.push(t.pid);
      this.current = null;
      this.note("irq", `Tick ${this.ticks}. EOI.${wokeText} The slice of pid ${t.pid} is over: it goes to the back of the queue.`, t.pid);
      this.kq.push(() => this.scheduleNow());
      return;
    }
    if (t) {
      this.note("irq", `Tick ${this.ticks}. EOI.${wokeText} No other task is ready: pid ${t.pid} continues.`);
      this.kq.push(() => this.returnToUser(t));
      return;
    }
    this.note("irq", `Tick ${this.ticks}. EOI.${wokeText}`);
    if (this.runq.length) this.kq.push(() => this.scheduleNow());
    else this.goIdle();
  }

  private goIdle() {
    this.current = null;
    this.ring = 0;
    this.ifFlag = true;
    this.regs.rip = IDLE;
    this.modeLabel = "ring 0: idle";
  }

  private scheduleNow() {
    const next = this.runq.shift();
    if (next === undefined) {
      this.goIdle();
      this.note("sched", "The run queue is empty, so the idle loop runs: sti and hlt.", null);
      return;
    }
    const t = this.tasks.get(next)!;
    this.current = t;
    t.state = "running";
    this.ifFlag = false;
    this.ring = 0;
    this.cr3 = t.pt.root;
    this.tssRsp0 = kstackTop(t.pid);
    this.gsKsp = this.tssRsp0;
    this.regs.rsp = this.tssRsp0;
    this.regs.rip = KERNEL_TEXT + 0x1500n;
    this.modeLabel = "ring 0: context switch";
    this.note("sched", `Switch to pid ${t.pid}: load its kernel rsp, CR3 = frame ${this.cr3}, TSS.RSP0 and the per-CPU kernel rsp = ${hx(this.tssRsp0)}.`, t.pid);
    this.kq.push(() => this.returnToUser(t));
  }

  private returnToUser(t: Task) {
    if (t.killPending) { this.finish(t, t.exit ?? "killed"); return; }
    this.regs = { ...t.regs };
    this.ring = 3;
    this.cs = SEL.UCODE;
    this.ifFlag = true;
    this.modeLabel = "ring 3";
    if (t.via === "sysretq") {
      this.regs.rflags = t.regs.r11;
      this.regs.rip = t.regs.rcx;
      this.note("syscall", `sysretq: rip = rcx = ${hx(this.regs.rip)}, rflags = r11. swapgs ran first. Back in ring 3.`, t.pid);
    } else {
      this.note("sched", `iretq: pops rip = ${hx(this.regs.rip)}, cs = ${hexN(SEL.UCODE)}, rflags, rsp, ss. Back in ring 3.`, t.pid);
    }
    t.via = "iretq";
  }

  private execUser(t: Task) {
    if (t.inject) { const i = t.inject; t.inject = null; if (this.execInject(t, i)) return; }
    const r = this.regs;
    const at = r.rip;
    const fetch = (off: number): number | null => {
      const b = this.readByte(t, at + BigInt(off), "x");
      if (typeof b === "number") return b;
      this.fault(t, at + BigInt(off), b, "x");
      return null;
    };
    const imm = (off: number, n: number): bigint | null => {
      let v = 0n;
      for (let i = 0; i < n; i++) { const b = fetch(off + i); if (b === null) return null; v |= BigInt(b) << BigInt(8 * i); }
      return v;
    };
    const REG: RegName[] = ["rax", "rcx", "rdx", "rbx", "rsp", "rax", "rsi", "rdi"];
    const op = fetch(0);
    if (op === null) return;
    const done = (len: number, text: string) => { r.rip = at + BigInt(len); t.retired++; this.last = `pid ${t.pid}: ${text}`; };
    if (op >= 0xb8 && op <= 0xbf) {
      const v = imm(1, 4); if (v === null) return;
      r[REG[op - 0xb8]!] = v;
      return done(5, `mov ${REG[op - 0xb8]!.replace("r", "e")}, ${v}`);
    }
    if (op === 0x50) {
      const nv = asU(r.rsp - 8n);
      const f = this.write64(t, nv, r.rax);
      if (f) return this.fault(t, nv, f, "w");
      r.rsp = nv;
      return done(1, "push rax");
    }
    if (op === 0x31) { r.rdi = 0n; return done(2, "xor edi, edi"); }
    if (op === 0xeb || op === 0x75) {
      const d = fetch(1); if (d === null) return;
      const taken = op === 0xeb || (r.rflags & ZF) === 0n;
      const rel = d >= 128 ? d - 256 : d;
      if (taken) { r.rip = at + 2n + BigInt(rel); t.retired++; this.last = `pid ${t.pid}: ${op === 0xeb ? "jmp" : "jnz"} taken`; return; }
      return done(2, "jnz not taken");
    }
    if (op === 0xff) {
      const m = fetch(1); if (m === null) return;
      if (m === 0xcb || m === 0xc3) {
        const nv = (r.rbx + (m === 0xcb ? -1n : 1n)) & 0xffffffffn;
        r.rbx = nv;
        r.rflags = nv === 0n ? r.rflags | ZF : r.rflags & ~ZF;
        return done(2, `${m === 0xcb ? "dec" : "inc"} ebx: ebx = ${nv}`);
      }
    }
    if (op === 0x0f) {
      const b = fetch(1); if (b === null) return;
      if (b === 0x05) return this.syscallEntry(t, at + 2n);
    }
    if (op === 0x48) {
      const b1 = fetch(1); if (b1 === null) return;
      if (b1 >= 0xb8 && b1 <= 0xbf) {
        const v = imm(2, 8); if (v === null) return;
        r[REG[b1 - 0xb8]!] = v;
        return done(10, `mov ${REG[b1 - 0xb8]!}, ${hx(v)}`);
      }
      const b2 = fetch(2); if (b2 === null) return;
      if (b1 === 0x8d && b2 === 0x35) {
        const v = imm(3, 4); if (v === null) return;
        const rel = v >= 0x80000000n ? v - 0x100000000n : v;
        r.rsi = asU(at + 7n + rel);
        return done(7, `lea rsi, [rip${rel >= 0n ? "+" : ""}${rel}]`);
      }
      if (b1 === 0x8b && b2 === 0x08) {
        const v = this.read64(t, r.rax);
        if (typeof v !== "bigint") return this.fault(t, r.rax, v, "r");
        r.rcx = v;
        return done(3, `mov rcx, [${hx(r.rax)}]`);
      }
      if (b1 === 0x89 && b2 === 0x08) {
        const f = this.write64(t, r.rax, r.rcx);
        if (f) return this.fault(t, r.rax, f, "w");
        return done(3, `mov [${hx(r.rax)}], rcx`);
      }
      if (b1 === 0xff && b2 === 0xc1) { r.rcx = asU(r.rcx + 1n); return done(3, `inc rcx: ${r.rcx}`); }
    }
    // Vector 6, #UD: the same end as any other bad user instruction.
    this.enterKernel(t, PF_ISR, "#UD");
    this.note("fault", `#UD: pid ${t.pid} has a bad opcode at ${hx(at)}.`);
    this.kq.push(() => this.finish(t, "killed: invalid opcode"));
  }

  /** The action of a bug button: one extra instruction of this task. Returns true when it took the place of the next instruction. */
  private execInject(t: Task, i: Inject): boolean {
    const r = this.regs;
    switch (i) {
      case "read-kernel": { const v = this.read64(t, KERNEL_TEXT); if (typeof v !== "bigint") { this.fault(t, KERNEL_TEXT, v, "r"); return true; } r.rcx = v; return false; }
      case "write-kernel": { const f = this.write64(t, KERNEL_DATA, 0x41n); if (f) { this.fault(t, KERNEL_DATA, f, "w"); return true; } return false; }
      case "write-own-text": { const va = BigInt(0x400000); const f = this.write64(t, va, 0x90n); if (f) { this.fault(t, va, f, "w"); return true; } return false; }
      case "read-unmapped": { const va = 0x1000n; const v = this.read64(t, va); if (typeof v !== "bigint") { this.fault(t, va, v, "r"); return true; } return false; }
      case "non-canonical": { const va = 0x0000800000000000n; const v = this.read64(t, va); if (typeof v !== "bigint") { this.fault(t, va, v, "r"); return true; } return false; }
      case "write-kernel-ptr": {
        r.rax = BigInt(SYS.WRITE); r.rdi = 1n; r.rsi = KERNEL_TEXT; r.rdx = 8n;
        this.syscallEntry(t, r.rip);
        return true;
      }
      case "read-own-data": {
        const va = 0x402000n;
        const v = this.read64(t, va);
        if (typeof v !== "bigint") { this.fault(t, va, v, "r"); return true; }
        r.rcx = v;
        const a = t.pt.leaf(va)!;
        const txt = [...Array(8).keys()].map((k) => Number((v >> BigInt(8 * k)) & 0xffn)).filter((c) => c >= 32 && c < 127).map((c) => String.fromCharCode(c)).join("");
        this.note("fault", `pid ${t.pid} reads 0x402000 and gets "${txt}" from frame ${entryPfn(a.entry)}. The same address in another task names another frame.`);
        return true;
      }
    }
  }

  private fault(t: Task, va: bigint, f: { fault: "pf" | "gp"; code: number }, kind: "r" | "w" | "x") {
    const rip = this.regs.rip;
    if (f.fault === "gp") {
      this.enterKernel(t, GP_ISR, "#GP");
      this.note("fault", `#GP: pid ${t.pid} used the non-canonical address ${hx(va)} at rip ${hx(rip)}. The CPU pushes a frame on the kernel stack.`);
      this.kq.push(() => this.finish(t, `killed: general protection, address ${hx(va)}`));
      return;
    }
    this.cr2 = va;
    this.enterKernel(t, PF_ISR, "#PF");
    this.note("fault", `#PF vector ${VEC.PF}: CR2 = ${hx(va)}, error ${f.code} (${describeErrorCode(f.code)}). The CPU pushes a frame on the kernel stack.`);
    this.kq.push(() => this.pageFaultHandler(t, va, f.code, kind, rip));
  }

  private pageFaultHandler(t: Task, va: bigint, code: number, kind: "r" | "w" | "x", rip: bigint) {
    const low = asU(va) < 1n << 47n;
    const vma = low ? t.vmas.find(Number(va)) : undefined;
    const allowed = !!vma && (kind === "r" || (kind === "w" && vma.write) || (kind === "x" && vma.exec));
    if (allowed && (code & FAULT.P) === 0) {
      const pfn = this.allocFrame(t.pid, "stack");
      if (pfn === null || this.freeFrames < 3) {
        if (pfn !== null) this.freeFrame(pfn);
        this.finish(t, "killed: out of memory");
        return;
      }
      const page = asU(va) & ~0xfffn;
      this.tableOwner = t.pid;
      t.pt.map(page, pfn, { user: true, writable: vma!.write, nx: !vma!.exec });
      t.pages.set(page, { va: page, pfn, kind: "stack", rights: `r${vma!.write ? "w" : "-"}${vma!.exec ? "x" : "-"}` });
      t.faultsHandled++;
      this.note("fault", `The address is inside ${vma!.name}, so this touch is valid. Take frame ${pfn}, map ${hx(page)}, and iretq. The same instruction runs again.`);
      t.via = "iretq";
      this.kq.push(() => this.returnToUser(t));
      return;
    }
    const why = !low ? "the address is in the kernel half" : !vma ? "no area covers the address" : "the area does not allow this access";
    this.note("fault", `Segfault: pid ${t.pid} at ${hx(va)}, rip ${hx(rip)}, error ${code}: ${why}. The kernel kills this task only.`);
    this.kq.push(() => this.finish(t, `killed: page fault at ${hx(va)}, error ${code}`));
  }

  private syscallEntry(t: Task, next: bigint) {
    const r = this.regs;
    r.rcx = next;
    r.r11 = r.rflags;
    this.enterKernel(t, LSTAR, "syscall");
    this.note("syscall", `syscall: rcx = ${hx(next)}, r11 = rflags, rip = LSTAR. CS = ${hexN(SEL.KCODE)}. SFMASK clears IF. rsp is still the user stack.`);
    t.via = "sysretq";
    this.kq.push(() => {
      this.note("syscall", `swapgs, then mov gs:[user_rsp], rsp and mov rsp, gs:[kernel_rsp]. Now rsp = ${hx(this.gsKsp)}.`);
      this.kq.push(() => this.dispatch(t));
    });
  }

  private dispatch(t: Task) {
    const u = t.regs;
    const nr = Number(u.rax);
    const line = (name: string, args: string, ret: bigint | number) => {
      const v = BigInt(ret);
      this.syscalls.push({ cycle: this.cycle, pid: t.pid, name, args, ret: v < 0n ? `${v}` : `${v}` });
      if (this.syscalls.length > 200) this.syscalls.shift();
      this.note("syscall", `pid ${t.pid}: ${name}(${args}) = ${v}`);
    };
    const back = () => this.kq.push(() => this.returnToUser(t));
    if (nr === SYSCALL_NR.x86.write) {
      const len = Number(u.rdx);
      if (u.rdi !== 1n && u.rdi !== 2n) { t.regs.rax = asU(BigInt(-ERRNO.EBADF)); line("write", `${u.rdi}, ${hx(u.rsi)}, ${len}`, -ERRNO.EBADF); return back(); }
      const data = this.copyFromUser(t, u.rsi, len);
      if (!data) { t.regs.rax = asU(BigInt(-ERRNO.EFAULT)); line("write", `${u.rdi}, ${hx(u.rsi)}, ${len}`, -ERRNO.EFAULT); return back(); }
      const text = String.fromCharCode(...data);
      this.console.push({ pid: t.pid, text });
      if (this.console.length > 200) this.console.shift();
      t.bytesWritten += len;
      t.regs.rax = BigInt(len);
      line("write", `${u.rdi}, "${text.trim()}", ${len}`, len);
      return back();
    }
    if (nr === SYS.SLEEP) {
      t.regs.rax = 0n;
      t.state = "sleeping";
      t.wakeAt = this.ticks + Number(u.rdi);
      this.sleepers.push(t.pid);
      this.current = null;
      line("sleep", `${u.rdi}`, 0);
      this.kq.push(() => this.scheduleNow());
      return;
    }
    if (nr === SYSCALL_NR.x86.exit) {
      line("exit", `${u.rdi}`, 0);
      this.kq.push(() => this.finish(t, `exit(${u.rdi})`));
      return;
    }
    if (nr === SYS.GETPID) { t.regs.rax = BigInt(t.pid); line("getpid", "", t.pid); return back(); }
    t.regs.rax = asU(BigInt(-ERRNO.ENOSYS));
    line(`syscall ${nr}`, "", -ERRNO.ENOSYS);
    back();
  }

  // ------------------------------------------------------------------ the end of a task

  /** Asks for a task to die. A task that is not on the CPU dies now. The running task dies at its next kernel path. */
  kill(pid: number, reason = "killed from the console") {
    const t = this.tasks.get(pid);
    if (!t || t.state === "dead") return;
    t.exit = reason;
    if (t !== this.current) {
      this.runq = this.runq.filter((p) => p !== pid);
      this.sleepers = this.sleepers.filter((p) => p !== pid);
      this.reap(t, reason);
      return;
    }
    t.killPending = true;
    if (this.ring === 3 && !this.kq.length) {
      this.enterKernel(t, TIMER_ISR, "kill");
      this.note("kill", `A kill for the running task pid ${pid}: an interrupt takes it into the kernel.`);
      this.kq.push(() => this.finish(t, reason));
    } else {
      this.note("kill", `pid ${pid} is in the kernel. It dies before it returns to user mode.`);
    }
  }

  /** Asks the task to run a buggy instruction at its next user step. */
  injectBug(pid: number, what: Inject) {
    const t = this.tasks.get(pid);
    if (t && t.state !== "dead") t.inject = what;
  }

  private finish(t: Task, reason: string) {
    this.reap(t, reason);
    this.current = null;
    this.kq = [];
    this.kq.push(() => this.scheduleNow());
  }

  /** Frees everything that a task owns. The kernel half stays. */
  private reap(t: Task, reason: string) {
    if (this.cr3 === t.pt.root) this.cr3 = this.kpt!.root; // Never free the tables that CR3 points to.
    for (const [va, p] of t.pages) {
      t.pt.unmap(va);
      this.freeFrame(p.pfn);
    }
    t.pages.clear();
    // Clear the shared entry first, so that the root frame owns nothing of the kernel.
    this.mem.write(t.pt.root, 511, 0n);
    this.mem.free(t.pt.root);
    const ks = this.kpt!.leaf(kstackVa(t.pid));
    if (ks) { this.kpt!.unmap(kstackVa(t.pid)); this.freeFrame(entryPfn(ks.entry)); }
    t.state = "dead";
    t.exit = reason;
    t.killPending = false;
    this.note("kill", `pid ${t.pid} (${t.name}) is gone: ${reason}. Its frames return to the allocator. ${this.freeFrames} are free.`, t.pid);
  }

  // ------------------------------------------------------------------ views and checks

  live() { return [...this.tasks.values()].filter((t) => t.state !== "dead"); }

  /** All frames that a task owns, from the frame owner table. */
  framesOf(pid: number): number[] {
    const out: number[] = [];
    for (let f = 0; f < this.phys.frameCount; f++) if (this.phys.owner[f] === pid) out.push(f);
    return out;
  }

  /** Table frames in the task's own part of the tree (not the shared kernel part). */
  ownTables(t: Task): number[] {
    return t.pt.nodes().filter((n) => n.level === 0 || n.path[0] !== 511).map((n) => n.pfn);
  }

  /** Reads through a task's page table as user code would. Returns the frame, or null on any fault. */
  userFrameAt(t: Task, va: bigint): number | null {
    const w = t.pt.walk(va, { kind: "r", user: true }, { readOnly: true });
    return w.ok ? w.pfn! : null;
  }

  /** The invariants of the module. An empty list means that all hold. */
  invariants(): string[] {
    const bad: string[] = [];
    if (!this.booted) return bad;
    const live = this.live();
    const liveIds = new Set(live.map((t) => t.pid));
    // Run queue: only ready tasks, each once.
    const seen = new Set<number>();
    for (const pid of this.runq) {
      const t = this.tasks.get(pid);
      if (!t) bad.push(`run queue holds unknown pid ${pid}`);
      else if (t.state === "dead") bad.push(`run queue holds dead pid ${pid}`);
      else if (t.state !== "ready") bad.push(`run queue holds pid ${pid} in state ${t.state}`);
      if (seen.has(pid)) bad.push(`pid ${pid} is twice in the run queue`);
      seen.add(pid);
    }
    for (const pid of this.sleepers) {
      if (this.tasks.get(pid)?.state !== "sleeping") bad.push(`sleep list holds pid ${pid} in state ${this.tasks.get(pid)?.state}`);
      if (seen.has(pid)) bad.push(`pid ${pid} is on two lists`);
      seen.add(pid);
    }
    if (this.current) {
      if (this.current.state !== "running") bad.push(`current pid ${this.current.pid} is ${this.current.state}`);
      if (seen.has(this.current.pid)) bad.push(`current pid ${this.current.pid} is also on a list`);
      seen.add(this.current.pid);
    }
    for (const t of live) if (!seen.has(t.pid)) bad.push(`pid ${t.pid} (${t.state}) is on no list and not current`);
    // Frame ownership: each owned frame is known, and every mapping agrees.
    const accounted = new Map<number, number>();
    for (const t of live) {
      for (const p of t.pages.values()) {
        if (this.phys.owner[p.pfn] !== t.pid) bad.push(`pid ${t.pid} maps frame ${p.pfn}, owned by ${this.phys.owner[p.pfn]}`);
        if (accounted.has(p.pfn)) bad.push(`frame ${p.pfn} is in two tasks`);
        accounted.set(p.pfn, t.pid);
      }
      for (const n of this.ownTables(t)) {
        if (this.phys.owner[n] !== t.pid) bad.push(`pid ${t.pid} table frame ${n} is owned by ${this.phys.owner[n]}`);
        if (accounted.has(n)) bad.push(`table frame ${n} is in two tasks`);
        accounted.set(n, t.pid);
      }
      const k = this.kpt!.leaf(kstackVa(t.pid));
      if (!k) bad.push(`pid ${t.pid} has no kernel stack`);
      else accounted.set(entryPfn(k.entry), t.pid);
      // The kernel half is one shared subtree.
      const e = this.mem.read(t.pt.root, 511), ke = this.mem.read(this.kpt!.root, 511);
      if (entryPfn(e) !== entryPfn(ke)) bad.push(`pid ${t.pid} has its own kernel half`);
      if (t.pt.walk(KERNEL_TEXT, { kind: "r", user: true }, { readOnly: true }).ok) bad.push(`pid ${t.pid} can read kernel text`);
    }
    for (let f = 0; f < this.phys.frameCount; f++) {
      const o = this.phys.owner[f]!;
      if (o === FREE) { if (this.frameKind.has(f)) bad.push(`free frame ${f} still has a kind`); continue; }
      if (o === UNMOVABLE) continue;
      if (!liveIds.has(o)) bad.push(`frame ${f} belongs to dead pid ${o}`);
      else if (accounted.get(f) !== o) bad.push(`frame ${f} of pid ${o} is not reachable from it`);
    }
    // CPU state.
    if (this.ring === 3) {
      if (!this.current) bad.push("ring 3 with no current task");
      else {
        if (this.cr3 !== this.current.pt.root) bad.push("CR3 is not the current task's");
        if (this.tssRsp0 !== kstackTop(this.current.pid)) bad.push("TSS.RSP0 is not the current task's");
        if (!this.ifFlag) bad.push("ring 3 with IF = 0");
      }
    }
    if (![...live.map((t) => t.pt.root), this.kpt!.root, 0].includes(this.cr3)) bad.push(`CR3 frame ${this.cr3} belongs to a dead task`);
    return bad;
  }

  /** The history as a Trace of the scheduling module, so its checks and views apply. */
  trace(): Trace {
    const slices: Slice[] = this.segs.map((g) => ({ start: g.start, end: g.end, job: g.pid, cpu: 0, kind: "run" }));
    const jobs: Job[] = [...this.tasks.values()].filter((t) => this.segs.some((g) => g.pid === t.pid)).map((t) => ({
      id: t.pid, name: `${t.name} ${t.pid}`, arrival: 0, burst: this.segs.filter((g) => g.pid === t.pid).reduce((a, g) => a + g.end - g.start, 0),
    }));
    const events: TraceEvent[] = [];
    for (const j of jobs) {
      const own = this.segs.filter((g) => g.pid === j.id);
      events.push({ t: 0, job: j.id, kind: "arrive" }, { t: own[own.length - 1]!.end, job: j.id, kind: "finish" });
    }
    return { jobs, slices, events: events.sort((a, b) => a.t - b.t), end: this.cycle, cpus: 1 };
  }

  /** One row of the page table view for a task. */
  mappings(t: Task) {
    return [...t.pages.values()].sort((a, b) => (a.va < b.va ? -1 : 1)).map((p) => ({ ...p, indices: splitVa(p.va).indices, name: t.vmas.find(Number(p.va))?.name ?? "" }));
  }
}

class OutOfFrames extends Error {}

/** A short boot and two loaded programs, for the demo and tests. */
export function bootedTinyOs(): TinyOS {
  const os = new TinyOS();
  os.boot();
  while (!os.booted) os.step();
  return os;
}
