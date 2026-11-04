/**
 * A context switch at register level, following the x86-64 path in Linux:
 * interrupt entry, schedule, switch_mm, __switch_to_asm, __switch_to, and the return.
 * Also: a cost model of direct cost plus cache refill.
 *
 * The machine is real in one sense: it only moves values through registers and kernel stacks.
 * A task's user registers come back because they are on its stack, and for no other reason.
 */

export const USER_REGS = ["rip", "rsp", "rbx", "rbp", "r12", "r13", "r14", "r15", "rax"] as const;
export const CALLEE_SAVED = ["rbp", "rbx", "r12", "r13", "r14", "r15"] as const;
export type RegName = (typeof USER_REGS)[number];

export interface CpuState {
  regs: Record<RegName, string>;
  cr3: string;
  mode: "user" | "kernel";
  /** this_cpu current_task. */
  current: string;
  /** The stack that the CPU loads on entry from user mode (TSS.sp0). */
  tssSp0: string;
  fsbase: string;
  /** FPU registers hold this task's state. */
  fpuOwner: string;
}

export interface TaskCtx {
  name: string;
  /** Kernel stack, oldest entry first. */
  kstack: { label: string; value: string }[];
  /** thread.sp: the saved kernel stack pointer. */
  savedSp: string;
  mm: string;
  fsbase: string;
  /** XSAVE area in the task_struct holds valid state. */
  fpuSaved: string;
}

export type SwitchPhase = "user" | "entry" | "sched" | "mm" | "save" | "switch" | "restore" | "tail" | "return";

export interface SwitchSnap {
  title: string;
  text: string;
  phase: SwitchPhase;
  cpu: CpuState;
  tasks: Record<string, TaskCtx>;
  /** The kernel stack that rsp points into, or null in user mode. */
  onStack: string | null;
  changed: string[];
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;


export const kspValue = (t: string, depth: number) => `k${t}+${depth}`;


export class SwitchMachine {
  cpu: CpuState;
  tasks: Record<string, TaskCtx> = {};
  snaps: SwitchSnap[] = [];
  private onStack: string | null = null;
  private last: CpuState;

  constructor(first: TaskCtx, firstRegs: Record<RegName, string>, others: TaskCtx[]) {
    this.tasks[first.name] = first;
    for (const o of others) this.tasks[o.name] = o;
    this.cpu = { regs: firstRegs, cr3: first.mm, mode: "user", current: first.name, tssSp0: kspValue(first.name, 0), fsbase: first.fsbase, fpuOwner: first.name };
    this.last = clone(this.cpu);
  }

  snap(title: string, text: string, phase: SwitchPhase) {
    const changed: string[] = [];
    for (const r of USER_REGS) if (this.cpu.regs[r] !== this.last.regs[r]) changed.push(r);
    for (const k of ["cr3", "mode", "current", "tssSp0", "fsbase", "fpuOwner"] as const) if (this.cpu[k] !== this.last[k]) changed.push(k);
    this.snaps.push({ title, text, phase, cpu: clone(this.cpu), tasks: clone(this.tasks), onStack: this.onStack, changed });
    this.last = clone(this.cpu);
  }

  private stack(): TaskCtx { return this.tasks[this.onStack!]!; }
  private push(label: string, value: string) {
    const s = this.stack();
    s.kstack.push({ label, value });
    this.cpu.regs.rsp = kspValue(s.name, s.kstack.length);
  }
  private pop(): string {
    const s = this.stack();
    const v = s.kstack.pop();
    if (!v) throw new Error("kernel stack underflow");
    this.cpu.regs.rsp = kspValue(s.name, s.kstack.length);
    return v.value;
  }

  /** The full path from the running task to `next`, because of a timer interrupt in user mode. */
  switchTo(nextName: string) {
    const prev = this.cpu.current;
    const next = this.tasks[nextName]!;
    const p = this.tasks[prev]!;
    const r = this.cpu.regs;
    this.snap(`${prev} runs in user mode`, `Task ${prev} runs. Its user values are in the CPU registers.`, "user");

    // 1. Hardware entry. rsp comes from TSS.sp0. The CPU pushes the interrupted state.
    this.onStack = prev;
    const userRsp = r.rsp, userRip = r.rip;
    this.cpu.mode = "kernel";
    r.rsp = this.cpu.tssSp0;
    this.push("ss", "user data");
    this.push("rsp (user)", userRsp);
    this.push("rflags", "0x202");
    this.push("cs", "user code");
    this.push("rip (user)", userRip);
    r.rip = "asm_sysvec_apic_timer_interrupt";
    this.snap("Timer interrupt", `The CPU enters ring 0. It loads rsp from TSS.sp0, the top of ${prev}'s kernel stack. It pushes ss, rsp, rflags, cs and rip.`, "entry");

    // 2. Entry code saves all other registers as pt_regs.
    for (const name of ["rax", "rbx", "rbp", "r12", "r13", "r14", "r15"] as const) this.push(name, r[name]);
    this.snap("Build pt_regs", `The entry code pushes the other user registers. Now ${prev}'s user state is complete on its kernel stack. The real code also saves rcx, rdx, rsi, rdi and r8 to r11.`, "entry");

    // 3. Handler runs kernel code, so the registers now hold kernel values.
    r.rax = "k:0"; r.rbx = `k:${prev}.rq`; r.rbp = `k:${prev}.frame`; r.r12 = `k:${prev}.prev`; r.r13 = `k:${nextName}.next`; r.r14 = "k:rf"; r.r15 = "k:rq";
    this.push("return into irq exit path", "preempt_schedule_irq");
    r.rip = "__schedule";
    this.snap("The scheduler runs", `The tick handler finds that ${prev} used its slice, and it sets need_resched. The exit path calls __schedule, which picks ${nextName}. Kernel code now uses the registers.`, "sched");

    // 4. switch_mm.
    if (next.mm !== p.mm) {
      this.cpu.cr3 = next.mm;
      r.rip = "switch_mm_irqs_off";
      this.snap("Switch the address space", `context_switch calls switch_mm_irqs_off, which writes ${nextName}'s page table to CR3. Kernel addresses stay valid, because all page tables map the kernel the same way.`, "mm");
    } else {
      r.rip = "context_switch";
      this.snap("Keep the address space", `${nextName} has the same mm as ${prev}, so the kernel skips the CR3 write. The TLB stays warm. This is the saving of a thread switch.`, "mm");
    }

    // 5. __switch_to_asm saves callee-saved registers on the old stack.
    r.rip = "__switch_to_asm";
    for (const name of CALLEE_SAVED) this.push(name, r[name]);
    this.snap("Save the kernel registers", `__switch_to_asm pushes the registers that a C caller expects to keep: rbp, rbx and r12 to r15. It needs no others, because this is an ordinary function call to the compiler.`, "save");

    p.savedSp = r.rsp;
    this.snap("Save the stack pointer", `The code stores rsp in ${prev}'s task_struct, in thread.sp. This one value is enough to find everything else of ${prev}.`, "save");

    // 6. The switch.
    r.rsp = next.savedSp;
    this.onStack = nextName;
    this.snap("Load the new stack pointer", `The code loads rsp from ${nextName}'s thread.sp. This is the context switch. The same code keeps running, but all later pushes and pops use ${nextName}'s stack.`, "switch");

    // 7. Restore callee-saved registers from the new stack.
    for (const name of [...CALLEE_SAVED].reverse()) r[name] = this.pop();
    this.snap("Pop the kernel registers", `The pops take the values that ${nextName} pushed when it last stopped here.`, "restore");

    // 8. __switch_to: the C part.
    r.rip = "__switch_to";
    p.fsbase = this.cpu.fsbase;
    p.fpuSaved = prev;
    this.cpu.fsbase = next.fsbase;
    this.cpu.current = nextName;
    this.cpu.tssSp0 = kspValue(nextName, 0);
    this.snap("Finish in __switch_to", `The C code sets current_task to ${nextName} and TSS.sp0 to the top of its stack. It loads ${nextName}'s FS base for thread-local storage. It saves ${prev}'s FPU state and marks the FPU for a later reload.`, "tail");

    // 9. Return along the new stack.
    r.rip = this.pop();
    r.rip = "finish_task_switch";
    this.snap("Return on the new stack", `The ret takes its address from ${nextName}'s stack, so ${nextName} continues from its own old call of __schedule. finish_task_switch cleans up after ${prev}.`, "tail");

    // 10. pt_regs back into the registers, and FPU reload.
    for (const name of ["r15", "r14", "r13", "r12", "rbp", "rbx", "rax"] as const) r[name] = this.pop();
    this.cpu.fpuOwner = nextName;
    this.snap("Restore pt_regs", `The exit path sees the FPU flag and loads ${nextName}'s FPU state with XRSTOR. It then pops the user registers of ${nextName}.`, "return");

    // 11. iretq.
    const rip = this.pop();
    this.pop(); // cs
    this.pop(); // rflags
    const rsp = this.pop();
    this.pop(); // ss
    r.rip = rip;
    r.rsp = rsp;
    this.cpu.mode = "user";
    this.onStack = null;
    this.snap(`${nextName} runs in user mode`, `iretq pops rip, cs, rflags, rsp and ss. ${nextName} continues at the instruction where it stopped, and it cannot see the gap.`, "return");
  }
}

const userRegs = (t: string, seed: number): Record<RegName, string> => ({
  rip: `0x40${(0x1000 + seed).toString(16)}`, rsp: `0x7ffd${(0x1000 + seed * 16).toString(16)}`,
  rbx: `${t}.rbx`, rbp: `${t}.rbp`, r12: `${t}.r12`, r13: `${t}.r13`, r14: `${t}.r14`, r15: `${t}.r15`, rax: `${t}.rax`,
});

export const USER_A = userRegs("A", 0xa2c);
export const USER_B = userRegs("B", 0xb30);

export interface SwitchOpts {
  /** Both tasks are threads of one process. */
  sameMm: boolean;
}

/**
 * Builds the machine in the state "A runs, B sleeps in the kernel".
 * B got there by the same path: the machine really switches B to A first.
 */
export function machineAfterPriorSwitch(opts: SwitchOpts = { sameMm: false }): SwitchMachine {
  const a: TaskCtx = { name: "A", kstack: [], savedSp: "", mm: "pgd(A)", fsbase: "fs(A)", fpuSaved: "A" };
  const b: TaskCtx = { name: "B", kstack: [], savedSp: "", mm: opts.sameMm ? "pgd(A)" : "pgd(B)", fsbase: "fs(B)", fpuSaved: "" };
  // Start A's kernel stack as if A had stopped earlier in the scheduler, with user registers saved.
  const u = USER_A;
  a.kstack = [
    { label: "ss", value: "user data" }, { label: "rsp (user)", value: u.rsp }, { label: "rflags", value: "0x202" }, { label: "cs", value: "user code" }, { label: "rip (user)", value: u.rip },
    { label: "rax", value: u.rax }, { label: "rbx", value: u.rbx }, { label: "rbp", value: u.rbp }, { label: "r12", value: u.r12 }, { label: "r13", value: u.r13 }, { label: "r14", value: u.r14 }, { label: "r15", value: u.r15 },
    { label: "return into irq exit path", value: "preempt_schedule_irq" },
    { label: "rbp", value: "k:A.frame" }, { label: "rbx", value: "k:A.rq" }, { label: "r12", value: "k:A.prev" }, { label: "r13", value: "k:B.next" }, { label: "r14", value: "k:rf" }, { label: "r15", value: "k:rq" },
  ];
  a.savedSp = kspValue("A", a.kstack.length);
  const m = new SwitchMachine(b, { ...USER_B }, [a]);
  m.cpu.fpuOwner = "B";
  m.switchTo("A");
  m.snaps = [];
  return m;
}

export function switchSnaps(opts: SwitchOpts = { sameMm: false }): SwitchSnap[] {
  const m = machineAfterPriorSwitch(opts);
  m.switchTo("B");
  return m.snaps;
}

// ---------------------------------------------------------------------------- XSAVE sizes

/** Bytes of the XSAVE area in standard format, up to and including each feature. AMX tile data adds 8 KiB more. */
export const XSAVE_BYTES = { sse: 576, avx: 832, avx512: 2688, amxTileData: 8192 } as const;

// ---------------------------------------------------------------------------- cost model

/** MODEL INPUTS: round figures of the right size, not measurements of one CPU. */
export const SWITCH_INPUTS = {
  /** The scheduler path, register save and restore, with no address space change. */
  directNs: 1500,
  /** CR3 write and mitigations when the address space changes. */
  mmSwitchNs: 500,
  /** Cache that the tasks compete for. */
  cacheBytes: 2 * 1024 * 1024,
  lineBytes: 64,
  /** Average time to refill one line from the next level. Prefetch makes this lower than a full miss. */
  lineRefillNs: 25,
  /** TLB entries that matter for the refill. */
  tlbEntries: 1536,
  pageBytes: 4096,
  /** One page walk. */
  walkNs: 30,
  /** Time between touches of new lines when the lines are in the cache. It limits refill in a short slice. */
  touchNs: 5,
} as const;

export interface SwitchCostInput {
  workingSetBytes: number;
  switchesPerSec: number;
  /** The other task evicts this share of the cache between two runs of this task. */
  evictedShare: number;
  /** A thread switch: no CR3 write and no TLB loss. */
  sameMm: boolean;
  /** PCID keeps TLB entries over a CR3 write. */
  pcid: boolean;
}

export interface SwitchCost { directNs: number; cacheNs: number; tlbNs: number; totalNs: number; cpuLost: number; directShare: number }

export function switchCost(i: SwitchCostInput): SwitchCost {
  const s = SWITCH_INPUTS;
  const directNs = s.directNs + (i.sameMm ? 0 : s.mmSwitchNs);
  // A task can only lose lines that it had: at most the cache size.
  const lines = Math.min(i.workingSetBytes, s.cacheBytes) / s.lineBytes;
  const cacheNs = lines * i.evictedShare * s.lineRefillNs;
  // Without PCID a CR3 write drops the whole non-global TLB. With PCID, only eviction by the other task matters.
  const pages = Math.min(i.workingSetBytes / s.pageBytes, s.tlbEntries);
  const tlbShare = i.sameMm ? 0 : i.pcid ? i.evictedShare : 1;
  const tlbNs = pages * tlbShare * s.walkNs;
  // A task only refills what it touches, and a short slice limits that. At the limit it does nothing but walk its data.
  const sliceNs = 1e9 / i.switchesPerSec;
  const budgetNs = Math.max(0, sliceNs - directNs) * (s.lineRefillNs / (s.touchNs + s.lineRefillNs));
  const wantNs = cacheNs + tlbNs;
  const scale = wantNs > budgetNs ? budgetNs / wantNs : 1;
  const c = cacheNs * scale, t = tlbNs * scale;
  const totalNs = directNs + c + t;
  return { directNs, cacheNs: c, tlbNs: t, totalNs, cpuLost: Math.min(1, totalNs / sliceNs), directShare: directNs / totalNs };
}
