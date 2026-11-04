/**
 * Hardware privilege: what each instruction does in each mode, and a timeline of one CPU's mode.
 * The instruction table covers x86-64 (rings 3 and 0) and arm64 (EL0 and EL1), with Linux's response to each fault.
 */

export type Arch = "x86" | "arm";
export type Mode = "user" | "kernel";

export interface CpuBits {
  mode: Mode;
  /** RFLAGS.IF, or the inverse of the arm64 DAIF.I mask: interrupts are on. */
  interrupts: boolean;
  /** RFLAGS.AC on x86-64, or PAN clear on arm64: the kernel may touch user pages. */
  userAccess: boolean;
}

export interface Outcome {
  fault: boolean;
  /** The exception that the CPU raises, for example "#GP(0)". */
  exception?: string;
  /** What Linux does about it. */
  signal?: "SIGSEGV" | "SIGILL" | "SIGTRAP" | "oops";
  text: string;
  next: CpuBits;
}

export interface Instruction {
  id: string;
  arch: Arch;
  asm: string;
  kind: "normal" | "privileged" | "gate" | "sensitive" | "always";
  run: (c: CpuBits) => Outcome;
}

const ok = (c: CpuBits, text: string, patch: Partial<CpuBits> = {}): Outcome => ({ fault: false, text, next: { ...c, ...patch } });
const fault = (c: CpuBits, exception: string, signal: Outcome["signal"], text: string): Outcome => ({ fault: true, exception, signal, text, next: c });

/** Privileged on x86-64: ring 0 runs it, and ring 3 gets a general protection fault. */
function gp(id: string, asm: string, kernel: string, patch: Partial<CpuBits> = {}): Instruction {
  return {
    id, arch: "x86", asm, kind: "privileged",
    run: (c) => c.mode === "kernel" ? ok(c, kernel, patch) : fault(c, "#GP(0)", "SIGSEGV", "The CPU raises a general protection fault. exc_general_protection sends SIGSEGV."),
  };
}

/** Privileged on arm64: EL0 gets an undefined instruction exception, and Linux sends SIGILL. */
function und(id: string, asm: string, kernel: string, patch: Partial<CpuBits> = {}): Instruction {
  return {
    id, arch: "arm", asm, kind: "privileged",
    run: (c) => c.mode === "kernel" ? ok(c, kernel, patch) : fault(c, "Undefined", "SIGILL", "EL0 may not run this, so the CPU traps to EL1. do_undefinstr sends SIGILL."),
  };
}

export const INSTRUCTIONS: Instruction[] = [
  // ---------------------------------------- x86-64
  { id: "add", arch: "x86", asm: "add rax, rbx", kind: "normal", run: (c) => ok(c, "Runs. Arithmetic needs no privilege.") },
  { id: "rdtsc", arch: "x86", asm: "rdtsc", kind: "normal", run: (c) => ok(c, "Runs. It reads the time stamp counter. The kernel can forbid it in ring 3 with CR4.TSD, but Linux normally allows it.") },
  {
    id: "load-user", arch: "x86", asm: "mov rax, [user]", kind: "normal",
    run: (c) => c.mode === "user" ? ok(c, "Runs. The page has the user bit set.")
      : c.userAccess ? ok(c, "Runs, because stac set EFLAGS.AC. copy_from_user works in this window.")
        : fault(c, "#PF", "oops", "SMAP blocks the kernel from user pages when AC is clear. The fault has no fixup, so the kernel reports an oops."),
  },
  {
    id: "load-kernel", arch: "x86", asm: "mov rax, [kernel]", kind: "privileged",
    run: (c) => c.mode === "kernel" ? ok(c, "Runs. Ring 0 can read pages with the user bit clear.")
      : fault(c, "#PF", "SIGSEGV", "The page has the user bit clear, so the access faults. exc_page_fault sends SIGSEGV."),
  },
  {
    id: "syscall", arch: "x86", asm: "syscall", kind: "gate",
    run: (c) => c.mode === "user" ? ok(c, "The gate. The CPU enters ring 0 at the address in MSR_LSTAR (entry_SYSCALL_64). User code cannot choose the target.", { mode: "kernel" })
      : ok(c, "The CPU allows it in ring 0, but Linux never does this. The entry code assumes that it came from ring 3."),
  },
  {
    id: "sysret", arch: "x86", asm: "sysretq", kind: "privileged",
    run: (c) => c.mode === "kernel" ? ok(c, "The CPU returns to ring 3 at the address in rcx, and restores RFLAGS from r11.", { mode: "user" })
      : fault(c, "#GP(0)", "SIGSEGV", "Only ring 0 may run sysretq. The CPU raises a general protection fault."),
  },
  gp("cli", "cli", "Interrupts are off on this CPU.", { interrupts: false }),
  gp("sti", "sti", "Interrupts are on again.", { interrupts: true }),
  {
    id: "popf", arch: "x86", asm: "popfq (IF = 0)", kind: "sensitive",
    run: (c) => c.mode === "kernel" ? ok(c, "Interrupts are off on this CPU.", { interrupts: false })
      : ok(c, "It runs with no fault, and IF does not change. The CPU ignores the bit in ring 3. Virtual machine monitors once had to work around this silent case."),
  },
  gp("hlt", "hlt", "The CPU sleeps until the next interrupt."),
  gp("cr3", "mov cr3, rax", "The CPU now uses another page table. This is the address space switch."),
  gp("wrmsr", "wrmsr", "The model-specific register changes. MSR_LSTAR is one of these registers."),
  gp("in", "in al, 0x60", "The CPU reads the I/O port. Linux leaves IOPL at 0, so ring 3 faults unless ioperm allows the port."),
  gp("invlpg", "invlpg [rax]", "The CPU removes one TLB entry."),
  {
    id: "stac", arch: "x86", asm: "stac", kind: "privileged",
    run: (c) => c.mode === "kernel" ? ok(c, "EFLAGS.AC is set. SMAP now allows the kernel to touch user pages.", { userAccess: true })
      : fault(c, "#UD", "SIGILL", "stac is undefined outside ring 0. The CPU raises an invalid opcode fault, and Linux sends SIGILL."),
  },
  {
    id: "clac", arch: "x86", asm: "clac", kind: "privileged",
    run: (c) => c.mode === "kernel" ? ok(c, "EFLAGS.AC is clear. User pages are off limits to the kernel again.", { userAccess: false })
      : fault(c, "#UD", "SIGILL", "clac is undefined outside ring 0. The CPU raises an invalid opcode fault, and Linux sends SIGILL."),
  },
  {
    id: "ud2", arch: "x86", asm: "ud2", kind: "always",
    run: (c) => fault(c, "#UD", c.mode === "user" ? "SIGILL" : "oops", c.mode === "user" ? "This instruction always faults. Compilers emit it for unreachable code. Linux sends SIGILL." : "This instruction always faults. BUG() in the kernel uses it, and the result is an oops."),
  },
  // ---------------------------------------- arm64
  { id: "a-add", arch: "arm", asm: "add x0, x1, x2", kind: "normal", run: (c) => ok(c, "Runs. Arithmetic needs no privilege.") },
  { id: "a-cnt", arch: "arm", asm: "mrs x0, cntvct_el0", kind: "normal", run: (c) => ok(c, "Runs. Linux allows EL0 to read the virtual counter. The vDSO clock uses this.") },
  {
    id: "a-load-user", arch: "arm", asm: "ldr x0, [user]", kind: "normal",
    run: (c) => c.mode === "user" ? ok(c, "Runs. The page allows EL0 access.")
      : c.userAccess ? ok(c, "Runs, because PAN is clear. copy_from_user works in this window.")
        : fault(c, "Data abort", "oops", "PAN blocks the kernel from user pages. do_mem_abort finds no fixup, so the kernel reports an oops."),
  },
  {
    id: "a-load-kernel", arch: "arm", asm: "ldr x0, [kernel]", kind: "privileged",
    run: (c) => c.mode === "kernel" ? ok(c, "Runs. EL1 can read the pages that TTBR1_EL1 maps.")
      : fault(c, "Data abort", "SIGSEGV", "EL0 has no access to this page. do_mem_abort sends SIGSEGV."),
  },
  {
    id: "a-svc", arch: "arm", asm: "svc #0", kind: "gate",
    run: (c) => c.mode === "user" ? ok(c, "The gate. The CPU enters EL1 at a fixed offset from VBAR_EL1, and ESR_EL1 tells the kernel that this was svc.", { mode: "kernel" })
      : fault(c, "SVC at EL1", "oops", "Linux has no path for svc from EL1. It treats this as a bad exception and reports an oops."),
  },
  und("a-eret", "eret", "The CPU returns to EL0 at ELR_EL1, and restores PSTATE from SPSR_EL1.", { mode: "user" }),
  und("a-daif", "msr daifset, #2", "IRQs are masked on this CPU.", { interrupts: false }),
  und("a-ttbr", "msr ttbr0_el1, x0", "The CPU now uses another user page table. This is the address space switch."),
  und("a-tlbi", "tlbi vmalle1", "The CPU removes the TLB entries for EL0 and EL1."),
  und("a-pan", "msr pan, #0", "PAN is clear. The kernel may now touch user pages.", { userAccess: true }),
  {
    id: "a-brk", arch: "arm", asm: "brk #0", kind: "always",
    run: (c) => fault(c, "Breakpoint", c.mode === "user" ? "SIGTRAP" : "oops", c.mode === "user" ? "This instruction always traps. Debuggers use it. Linux sends SIGTRAP." : "This instruction always traps. BUG() in the kernel uses it on arm64, and the result is an oops."),
  },
];

export const instructionsFor = (arch: Arch) => INSTRUCTIONS.filter((i) => i.arch === arch);
export const initialBits = (mode: Mode = "user"): CpuBits => ({ mode, interrupts: true, userAccess: false });

/** Instructions that run in the kernel and fault in user mode, from a clean CPU state. */
export function faultsOnlyInUser(arch: Arch): Instruction[] {
  return instructionsFor(arch).filter((i) => i.run(initialBits("user")).fault && !i.run(initialBits("kernel")).fault);
}

// ---------------------------------------------------------------------------- address space split

/** The user half with 4-level paging: bit 47 and above are clear. */
export const USER_BITS_4LEVEL = 47;
/** The user half with 5-level paging. */
export const USER_BITS_5LEVEL = 56;
export const userHalfBytes = (bits: number) => 2 ** bits;

// ---------------------------------------------------------------------------- mode timeline

export type EntryKind = "getpid" | "read" | "fault" | "disk";

/** MODEL INPUTS, in microseconds of kernel work. They are round figures, not measurements. */
export const ENTRY_US = { getpid: 0.2, read: 2000, fault: 1.5, disk: 10, timer: 5 } as const;

export const ENTRY_INFO: Record<EntryKind | "timer", { label: string; entry: string; sync: boolean }> = {
  getpid: { label: "short syscall", entry: "syscall", sync: true },
  read: { label: "long syscall", entry: "syscall", sync: true },
  fault: { label: "page fault", entry: "exception", sync: true },
  disk: { label: "disk interrupt", entry: "interrupt", sync: false },
  timer: { label: "timer interrupt", entry: "interrupt", sync: false },
};

export interface Segment {
  mode: Mode;
  /** Why the CPU is in the kernel. Absent for user segments. */
  kind?: EntryKind | "timer";
  startUs: number;
  durUs: number;
  /** A timer tick inside this kernel slice: no mode change. */
  nested?: boolean;
}

export interface Timeline {
  segments: Segment[];
  userUs: number;
  kernelUs: number;
  /** User to kernel transitions. */
  entries: number;
  /** Timer ticks that hit while the CPU was already in the kernel. */
  nestedTicks: number;
  ticks: number;
}

/** Runs the user program for gapUs before each event, with timer ticks at hz. */
export function timeline(events: EntryKind[], hz: number, gapUs: number): Timeline {
  const period = 1e6 / hz;
  const segs: Segment[] = [];
  let t = 0, nextTick = period, entries = 0, nestedTicks = 0, ticks = 0, userUs = 0, kernelUs = 0;
  const addK = (kind: EntryKind | "timer", d: number, nested: boolean) => { segs.push({ mode: "kernel", kind, startUs: t, durUs: d, nested: nested || undefined }); t += d; kernelUs += d; };
  const runUser = (d: number) => {
    let left = d;
    while (left > 0) {
      const slice = Math.min(left, nextTick - t);
      if (slice > 0) { segs.push({ mode: "user", startUs: t, durUs: slice }); t += slice; userUs += slice; left -= slice; }
      if (t >= nextTick) {
        nextTick += period;
        ticks++;
        entries++;
        addK("timer", ENTRY_US.timer, false);
      }
    }
  };
  const runKernel = (kind: EntryKind, d: number) => {
    entries++;
    let left = d;
    while (left > 0) {
      const slice = Math.min(left, Math.max(0, nextTick - t));
      if (slice > 0) { addK(kind, slice, false); left -= slice; }
      if (t >= nextTick && left > 0) {
        nextTick += period;
        ticks++;
        nestedTicks++;
        addK("timer", ENTRY_US.timer, true);
      }
    }
  };
  for (const e of events) { runUser(gapUs); runKernel(e, ENTRY_US[e]); }
  runUser(gapUs);
  return { segments: segs, userUs, kernelUs, entries, nestedTicks, ticks };
}
