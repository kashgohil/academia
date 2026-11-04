/**
 * A kernel scheduler at stack level. Kernel threads have real stacks with real addresses. A context switch pushes the
 * callee-saved registers, swaps rsp and pops them from the other stack, as the assembly does.
 * A new thread starts from a fabricated frame. Everything else follows from those rules.
 */

export const CALLEE = ["rbp", "rbx", "r12", "r13", "r14", "r15"] as const;
export type CalleeReg = (typeof CALLEE)[number];
export type Regs = Record<CalleeReg, string>;

/** The fabricated frame: six registers and one return address. */
export const FAKE_FRAME_BYTES = (CALLEE.length + 1) * 8;
export const KSTACK_BYTES = 16 * 1024;
const STACK_AREA = 0xffffc90000000000n;
export const stackTop = (i: number) => STACK_AREA + BigInt((i + 1) * 2 * KSTACK_BYTES);

export type RowKind = "fake" | "callee" | "ret" | "cpu" | "stub";
export interface KRow { addr: bigint; label: string; value: string; bytes: number; kind: RowKind; saved?: Regs }

export type TState = "running" | "ready" | "sleeping";
export type TProgram = "hog" | "yielder" | "sleeper" | "idle";
type Resume = "fresh" | "irq" | "call" | "idle";

export interface KThread {
  id: number;
  name: string;
  prog: TProgram;
  top: bigint;
  stack: KRow[];
  savedRsp: bigint | null;
  state: TState;
  wakeAt: number;
  resume: Resume;
  work: number;
  /** Times this thread got the CPU. */
  runs: number;
}

export type SchedMode = "cooperative" | "preemptive";

export interface SchedOpts {
  mode: SchedMode;
  /** The trampoline runs sti. Turn it off to see the classic bug. */
  sti: boolean;
  threads?: { name: string; prog: TProgram }[];
  /** Work steps between timer ticks. Model input. */
  period?: number;
  /** Ticks that the sleeper sleeps. Model input. */
  sleepTicks?: number;
  maxSnaps?: number;
}

export interface SchedSnap {
  title: string;
  text: string;
  phase: "boot" | "run" | "irq" | "handler" | "sched" | "save" | "switch" | "restore" | "start" | "return";
  cur: string;
  rip: string;
  rsp: bigint;
  regs: Regs;
  ifFlag: boolean;
  tick: number;
  needResched: boolean;
  runq: string[];
  sleepers: { name: string; wakeAt: number }[];
  threads: { name: string; state: TState; savedRsp: bigint | null; stack: KRow[]; work: number; runs: number; top: bigint }[];
  console: string;
}

const DEFAULT_THREADS: { name: string; prog: TProgram }[] = [
  { name: "A", prog: "hog" },
  { name: "B", prog: "yielder" },
  { name: "C", prog: "sleeper" },
];

export class KernelSim {
  threads: KThread[] = [];
  idle!: KThread;
  cur!: KThread;
  runq: KThread[] = [];
  sleepers: KThread[] = [];
  rsp = 0n;
  rip = "kmain";
  ifFlag = false;
  regs: Regs = { rbp: "0", rbx: "0", r12: "0", r13: "0", r14: "0", r15: "0" };
  tick = 0;
  needResched = false;
  console = "";
  snaps: SchedSnap[] = [];
  /** Who got the CPU, in order. */
  dispatches: string[] = [];
  private workSinceTick = 0;
  private kn = 0;
  private period: number;
  private sleepTicks: number;
  /** Register values that a thread must see again when it resumes, checked by tests. */
  regCheck: { name: string; ok: boolean }[] = [];
  private held = new Map<KThread, Regs>();

  constructor(readonly opts: SchedOpts) {
    this.period = opts.period ?? 3;
    this.sleepTicks = opts.sleepTicks ?? 3;
  }

  private snap(title: string, text: string, phase: SchedSnap["phase"]) {
    this.snaps.push({
      title, text, phase, cur: this.cur.name, rip: this.rip, rsp: this.rsp, regs: { ...this.regs }, ifFlag: this.ifFlag, tick: this.tick, needResched: this.needResched,
      runq: this.runq.map((t) => t.name),
      sleepers: this.sleepers.map((t) => ({ name: t.name, wakeAt: t.wakeAt })),
      threads: [...this.threads, this.idle].map((t) => ({ name: t.name, state: t.state, savedRsp: t.savedRsp, stack: t.stack.map((r) => ({ ...r })), work: t.work, runs: t.runs, top: t.top })),
      console: this.console,
    });
  }

  /** Builds a stack that looks as if the thread had called switch_to. The first switch "returns" into the trampoline. */
  fabricate(t: KThread) {
    const fn = `${t.name.toLowerCase()}_main`;
    const vals: [string, string][] = [["ret", "thread_trampoline"], ["rbp", "0"], ["rbx", `arg of ${t.name}`], ["r12", fn], ["r13", "0"], ["r14", "0"], ["r15", "0"]];
    let a = t.top;
    for (const [label, value] of vals) {
      a -= 8n;
      t.stack.push({ addr: a, label, value, bytes: 8, kind: "fake" });
    }
    t.savedRsp = a;
  }

  private push(label: string, value: string, bytes: number, kind: RowKind, saved?: Regs) {
    this.rsp -= BigInt(bytes);
    this.cur.stack.push({ addr: this.rsp, label, value, bytes, kind, saved });
  }
  private pop(): KRow {
    const r = this.cur.stack.pop();
    if (!r) throw new Error(`stack underflow on ${this.cur.name}`);
    this.rsp = r.addr + BigInt(r.bytes);
    return r;
  }

  private setKernelRegs() {
    const n = ++this.kn;
    this.regs = { rbp: `k${n}.frame`, rbx: `k${n}.rq`, r12: `k${n}.prev`, r13: `k${n}.next`, r14: "k.flags", r15: "k.cpu" };
  }

  boot() {
    const list = this.opts.threads ?? DEFAULT_THREADS;
    this.threads = list.map((d, i) => ({ id: i, name: d.name, prog: d.prog, top: stackTop(i), stack: [], savedRsp: null, state: "ready", wakeAt: 0, resume: "fresh", work: 0, runs: 0 }));
    this.idle = { id: 99, name: "idle", prog: "idle", top: stackTop(list.length), stack: [], savedRsp: null, state: "running", wakeAt: 0, resume: "idle", work: 0, runs: 0 };
    this.cur = this.idle;
    this.rsp = this.idle.top;
    this.snap("Boot code becomes the idle thread", "The boot code runs on its own stack. It will become the idle thread. No other thread has run, and interrupts are off.", "boot");
    for (const t of this.threads) {
      this.fabricate(t);
      this.runq.push(t);
    }
    this.snap("Fabricate the first stacks", `thread_spawn builds a frame on each new stack, ${FAKE_FRAME_BYTES} bytes: the six registers that switch_to pops, and a return address. saved rsp points to r15. Look at r12: it holds the thread's function.`, "boot");
    this.schedule("boot");
    return this;
  }

  private wakeSleepers() {
    const woke: string[] = [];
    this.sleepers = this.sleepers.filter((t) => {
      if (t.wakeAt <= this.tick) {
        t.state = "ready";
        this.runq.push(t);
        woke.push(t.name);
        return false;
      }
      return true;
    });
    return woke;
  }

  /** Picks the next thread and switches. `why` says how the current thread got here. */
  private schedule(why: "boot" | "irq" | "yield" | "sleep"): boolean {
    const prev = this.cur;
    this.rip = "schedule";
    this.needResched = false;
    if (why !== "boot" && prev.state === "running" && prev !== this.idle) {
      prev.state = "ready";
      this.runq.push(prev);
    }
    const next = this.runq.shift() ?? this.idle;
    this.snap("schedule() picks a thread", `${why === "sleep" ? `${prev.name} is asleep, so it stays out of the run queue. ` : prev === this.idle ? "" : `${prev.name} goes to the back of the run queue. `}The next thread is the head of the queue: ${next.name}.${next === this.idle ? " The queue is empty, so the idle thread runs." : ""}`, "sched");
    if (next === prev) {
      prev.state = "running";
      this.snap("No switch needed", `${prev.name} is the only choice, so schedule() returns.`, "sched");
      return false;
    }
    if (prev.state === "running") prev.state = "ready";
    prev.resume = why === "irq" ? "irq" : prev === this.idle ? "idle" : "call";
    this.held.set(prev, { ...this.regs });
    // call switch_to: the return address, then six pushes.
    this.rip = "switch_to";
    this.push("ret", "into schedule()", 8, "ret");
    for (const r of CALLEE) this.push(r, this.regs[r], 8, "callee");
    this.snap("switch_to pushes six registers", `The call pushed a return address. Then the code pushes rbp, rbx and r12 to r15 on ${prev.name}'s stack. The compiler expects a callee to keep these. It already saved all others.`, "save");
    prev.savedRsp = this.rsp;
    this.snap("Save rsp", `mov [rdi + RSP], rsp stores the stack pointer in ${prev.name}'s thread struct. This one value now finds all of ${prev.name}'s state.`, "save");
    this.rsp = next.savedRsp!;
    this.cur = next;
    next.savedRsp = null;
    next.state = "running";
    next.runs++;
    this.dispatches.push(next.name);
    this.snap("Load rsp: this is the switch", `mov rsp, [rsi + RSP]. The same code continues, but every later pop and ret uses ${next.name}'s stack.`, "switch");
    for (const r of [...CALLEE].reverse()) this.regs[r] = this.pop().value;
    this.snap("Pop six registers", next.resume === "fresh" ? `The pops read the fabricated values. Nobody ever pushed them. r12 now holds ${next.name}'s function, and rbx holds its argument.` : `The pops bring back the values that ${next.name} pushed when it last stopped.`, "restore");
    const ret = this.pop();
    this.rip = ret.value;
    if (next.resume === "fresh") {
      this.snap("ret into the trampoline", `ret takes the fabricated address, so the CPU "returns" to a place that never called switch_to. Now rsp is at the top of ${next.name}'s stack and is aligned to 16 bytes.`, "start");
      if (this.opts.sti) this.ifFlag = true;
      this.rip = this.regs.r12;
      next.resume = "call";
      this.regs.rbx = "0";
      this.snap("The trampoline starts the thread", `${this.opts.sti ? "It runs sti, because the switch happened with interrupts off. " : "This trampoline forgets sti, so IF stays 0. No timer interrupt can arrive now. "}Then it runs mov rdi, rbx and call r12. The thread's function starts with an empty stack.`, "start");
      return true;
    }
    const saved = this.held.get(next);
    if (saved) this.regCheck.push({ name: next.name, ok: CALLEE.every((r) => saved[r] === this.regs[r]) });
    this.resume(next);
    return true;
  }

  private resume(t: KThread) {
    if (t.resume === "irq") {
      this.rip = "timer_handler";
      this.snap("Return into the old handler", `${t.name} continues inside the handler where it stopped. schedule() returns, and the handler returns to the stub.`, "return");
      this.irqReturn();
    } else if (t.resume === "idle") {
      this.ifFlag = true;
      this.rip = "idle_loop";
      this.snap("Back to the idle loop", "The idle thread continues. It runs sti and hlt, and it waits for an interrupt.", "return");
    } else {
      this.ifFlag = true;
      this.rip = `${t.name.toLowerCase()}_main`;
      this.regs.rbx = `${t.name}.${t.work}`;
      this.regs.r12 = `${t.name}.fn`;
      this.snap("Return from the blocking call", `${t.name} continues after its call. schedule() restored interrupts on the way out.`, "return");
    }
  }

  private irqReturn() {
    const stubRow = this.pop();
    this.regs = { ...stubRow.saved! };
    this.pop();
    this.rip = "isr_stub";
    this.snap("The stub restores registers", `The stub pops the 15 saved registers and removes the vector and error code.`, "return");
    const frame = [this.pop(), this.pop(), this.pop(), this.pop(), this.pop()];
    this.rip = frame[0]!.value;
    this.ifFlag = true;
    this.snap("iretq", `iretq pops rip, cs, rflags, rsp and ss. IF comes back from the saved rflags. ${this.cur.name} continues at the next instruction, and it cannot see the gap.`, "return");
  }

  /** The timer interrupt at the current instruction. */
  private timer() {
    const t = this.cur;
    const before = { ...this.regs };
    const oldRip = this.rip;
    const oldRsp = this.rsp;
    this.ifFlag = false;
    // The CPU aligns rsp down before the frame. Thread stacks are aligned here, so this is a no-op in the model.
    this.push("ss", "0x10", 8, "cpu");
    this.push("rsp", `0x${oldRsp.toString(16)}`, 8, "cpu");
    this.push("rflags", "0x202", 8, "cpu");
    this.push("cs", "0x08", 8, "cpu");
    this.push("rip", oldRip, 8, "cpu");
    this.rip = "isr_stub";
    this.snap("Timer IRQ", `The CPU interrupts ${t.name}, pushes five values on its stack and clears IF. No stack switch: this is ring 0 to ring 0.`, "irq");
    this.push("err, vector", "0, 32", 16, "stub");
    this.push("15 registers", `${t.name}'s values`, 120, "stub", before);
    this.setKernelRegs();
    this.rip = "timer_handler";
    this.tick++;
    const woke = this.wakeSleepers();
    const preempt = this.opts.mode === "preemptive" && (t !== this.idle || this.runq.length > 0);
    this.needResched = preempt || (t === this.idle && this.runq.length > 0);
    this.snap("The handler runs", `The stub saved all registers. The handler sends EOI and adds 1 to the tick count, now ${this.tick}. ${woke.length ? `It wakes ${woke.join(", ")}. ` : ""}${this.needResched ? "It sets need_resched." : this.opts.mode === "cooperative" ? "This kernel is cooperative, so the handler never switches. It returns to the same thread." : "Nothing else can run, so no switch is needed."}`, "handler");
    if (!this.needResched || !this.schedule("irq")) this.irqReturn();
  }

  /** One step of whatever the current thread does. */
  step() {
    if (this.ifFlag && this.workSinceTick >= this.period) {
      this.workSinceTick = 0;
      this.timer();
      return;
    }
    const t = this.cur;
    this.workSinceTick++;
    if (t === this.idle) {
      this.ifFlag = true;
      this.rip = "idle_loop";
      this.snap("Idle: hlt", "The run queue is empty. The idle thread runs hlt, and the CPU sleeps until the next interrupt.", "run");
      return;
    }
    t.work++;
    this.regs.rbx = `${t.name}.${t.work}`;
    this.regs.r12 = `${t.name}.fn`;
    this.rip = `${t.name.toLowerCase()}_main`;
    if (t.prog === "hog") {
      this.snap(`${t.name} computes`, `${t.name} runs a loop and never gives up the CPU by itself. Its registers change: rbx is now ${t.name}.${t.work}.`, "run");
      return;
    }
    if (t.prog === "yielder") {
      this.console += t.name.toLowerCase();
      this.snap(`${t.name} prints, then yields`, `${t.name} prints a letter, and then calls yield(). It gives up the CPU by itself.`, "run");
      this.ifFlag = false;
      this.setKernelRegs();
      if (!this.schedule("yield")) this.ifFlag = true;
      return;
    }
    if (t.prog === "sleeper") {
      this.console += t.name.toLowerCase();
      t.state = "sleeping";
      t.wakeAt = this.tick + this.sleepTicks;
      this.sleepers.push(t);
      this.ifFlag = false;
      this.snap(`${t.name} calls sleep(${this.sleepTicks})`, `${t.name} prints a letter and goes on the sleep list, with a wake time of tick ${t.wakeAt}. Interrupts are off: a timer tick here must not see half a list.`, "run");
      this.setKernelRegs();
      this.schedule("sleep");
    }
  }

  run() {
    const max = this.opts.maxSnaps ?? 110;
    this.boot();
    while (this.snaps.length < max) this.step();
    this.snaps.length = Math.min(this.snaps.length, max);
    return this;
  }
}

export const schedSnaps = (o: SchedOpts) => new KernelSim(o).run().snaps;
