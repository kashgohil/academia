/**
 * The ptrace API as a state machine. A tracer process and one tracee on one CPU.
 *
 * The request numbers are from include/uapi/linux/ptrace.h. The rules are from ptrace(2):
 * a request needs a tracee in a ptrace-stop, or it fails with ESRCH. The stops follow the kernel:
 * syscall entry and exit call ptrace_report_syscall_entry and ptrace_report_syscall_exit, and
 * ptrace_stop() puts the task in TASK_TRACED and wakes the tracer.
 */

export const PTRACE = {
  TRACEME: 0, PEEKTEXT: 1, PEEKDATA: 2, PEEKUSER: 3, POKETEXT: 4, POKEDATA: 5, POKEUSER: 6, CONT: 7, KILL: 8, SINGLESTEP: 9,
  GETREGS: 12, SETREGS: 13, ATTACH: 16, DETACH: 17, SYSCALL: 24, SETOPTIONS: 0x4200, SEIZE: 0x4206, GET_SYSCALL_INFO: 0x420e,
} as const;
export const PTRACE_O = { TRACESYSGOOD: 1, TRACESECCOMP: 1 << 7 } as const;
/** The event number in the upper status bits for a stop that the seccomp filter asked for. */
export const PTRACE_EVENT_SECCOMP = 7;
export const SIG = { TRAP: 5, STOP: 19 } as const;
export const ERR = { EPERM: 1, ESRCH: 3, EIO: 5, ENOSYS: 38 } as const;
/** At a syscall-enter-stop on x86-64, rax holds -ENOSYS and the number is in orig_rax. */
export const ENTRY_RAX = -ERR.ENOSYS;
/** PTRACE_PEEKDATA moves one word at a time. */
export const WORD_BYTES = 8;

export interface UserRegs { orig_rax: number; rax: number; rdi: number; rsi: number; rdx: number; rip: number }

export type TraceeOp =
  | { kind: "user"; label: string }
  | { kind: "sys"; name: string; nr: number; args: number[]; ret: number; rip: number; text?: { addr: number; bytes: string } };

export type StopKind = "attach" | "syscall-enter" | "syscall-exit" | "seccomp";
export type TraceeState = "running" | "stopped" | "exited";

export interface PtraceCounters {
  /** ptrace-stops that the tracer saw. */
  stops: number;
  /** One CPU: each stop and each resume of the tracee is one context switch. */
  switches: number;
  /** System calls that the tracer made: waitpid, ptrace and write. */
  tracerSyscalls: number;
  regReads: number;
  peeks: number;
  /** System calls that the tracee made. */
  traceeSyscalls: number;
}

/** One tracee. The methods have the meaning of ptrace(2) requests, and the return value is the same: a negative errno on failure. */
export class PtraceMachine {
  state: TraceeState = "running";
  stop: StopKind | null = null;
  tracer: number | null = null;
  options = 0;
  regs: UserRegs = { orig_rax: -1, rax: 0, rdi: 0, rsi: 0, rdx: 0, rip: 0x401000 };
  counters: PtraceCounters = { stops: 0, switches: 0, tracerSyscalls: 0, regReads: 0, peeks: 0, traceeSyscalls: 0 };
  /** A stop waits for waitpid. */
  stopPending = false;
  exitCode: number | null = null;
  /** The filter of `--seccomp-bpf`. Calls in this set stop the tracee. Null means that no filter is loaded. */
  seccompTraced: Set<string> | null = null;
  /** What the tracee did since it last ran, for display. */
  ran: string[] = [];
  /** How the tracee was last resumed. */
  private resumed: "syscall" | "cont" | "none" = "none";
  private pc = 0;
  private enteredOp: Extract<TraceeOp, { kind: "sys" }> | null = null;
  private memory = new Map<number, Uint8Array>();

  constructor(readonly program: TraceeOp[]) {
    for (const op of program) {
      if (op.kind === "sys" && op.text) {
        const b = new Uint8Array(op.text.bytes.length);
        for (let i = 0; i < b.length; i++) b[i] = op.text.bytes.charCodeAt(i);
        this.memory.set(op.text.addr, b);
      }
    }
  }

  private needStopped(): number {
    if (this.tracer === null || this.state !== "stopped" || this.stopPending) return -ERR.ESRCH;
    return 0;
  }

  /** PTRACE_ATTACH: send SIGSTOP. The tracee stops later, and the tracer must wait for it. */
  attach(tracerPid: number): number {
    this.counters.tracerSyscalls++;
    if (this.tracer !== null) return -ERR.EPERM;
    this.tracer = tracerPid;
    this.state = "stopped";
    this.stop = "attach";
    this.stopPending = true;
    return 0;
  }

  /** Start under a tracer with a filter, as strace does with `--seccomp-bpf`: the child stops itself before execve. */
  spawnTraced(tracerPid: number, filter: Set<string> | null): void {
    this.tracer = tracerPid;
    this.seccompTraced = filter;
    this.state = "stopped";
    this.stop = "attach";
    this.stopPending = true;
  }

  setOptions(opts: number): number {
    this.counters.tracerSyscalls++;
    const e = this.needStopped();
    if (e) return e;
    this.options = opts;
    return 0;
  }

  /** PTRACE_SYSCALL: run until the next syscall entry or exit. */
  ptraceSyscall(): number {
    this.counters.tracerSyscalls++;
    const e = this.needStopped();
    if (e) return e;
    this.resume("syscall");
    return 0;
  }

  /** PTRACE_CONT: run with no syscall stops. */
  ptraceCont(): number {
    this.counters.tracerSyscalls++;
    const e = this.needStopped();
    if (e) return e;
    this.resume("cont");
    return 0;
  }

  private resume(how: "syscall" | "cont"): void {
    this.resumed = how;
    this.state = "running";
    this.counters.switches++;
    const prev = this.stop;
    this.stop = null;
    this.ran = [];
    // The kernel finishes a call that was stopped at entry.
    if ((prev === "syscall-enter" || prev === "seccomp") && this.enteredOp) {
      const op = this.enteredOp;
      this.enteredOp = null;
      this.regs.rax = op.ret;
      this.ran.push(`The kernel runs ${op.name}.`);
      if (op.name === "exit_group") {
        this.state = "exited";
        this.exitCode = op.args[0] ?? 0;
        this.stopPending = true;
        return;
      }
      if (how === "syscall") {
        this.enter("syscall-exit");
        return;
      }
    }
    this.runUntilStop();
  }

  private enter(kind: StopKind): void {
    this.state = "stopped";
    this.stop = kind;
    this.stopPending = true;
  }

  private runUntilStop(): void {
    while (this.pc < this.program.length) {
      const op = this.program[this.pc++]!;
      if (op.kind === "user") {
        this.ran.push(`User code: ${op.label}.`);
        continue;
      }
      this.counters.traceeSyscalls++;
      this.regs = { orig_rax: op.nr, rax: ENTRY_RAX, rdi: op.args[0] ?? 0, rsi: op.args[1] ?? 0, rdx: op.args[2] ?? 0, rip: op.rip };
      if (this.resumed === "syscall") {
        this.enteredOp = op;
        this.ran.push(`The syscall instruction enters the kernel. orig_rax = ${op.nr}.`);
        this.enter("syscall-enter");
        return;
      }
      if (this.seccompTraced?.has(op.name)) {
        this.enteredOp = op;
        this.ran.push(`The seccomp filter returns SECCOMP_RET_TRACE for ${op.name}.`);
        this.enter("seccomp");
        return;
      }
      // No stop: the call runs at full speed.
      this.regs.rax = op.ret;
      if (op.name === "exit_group") {
        this.ran.push(`The filter returns SECCOMP_RET_ALLOW. The kernel runs ${op.name}.`);
        this.state = "exited";
        this.exitCode = op.args[0] ?? 0;
        this.stopPending = true;
        return;
      }
      this.ran.push(this.seccompTraced ? `The filter returns SECCOMP_RET_ALLOW. ${op.name} runs with no stop.` : `${op.name} runs with no stop.`);
    }
    // The program has no more operations.
    this.state = "exited";
    this.exitCode = 0;
    this.stopPending = true;
  }

  /** The tracer blocks until a stop is pending. Returns null if there is none to report yet. */
  waitpid(): { exited: boolean; stop: StopKind | null; status: number } | null {
    this.counters.tracerSyscalls++;
    if (!this.stopPending) return null;
    this.stopPending = false;
    this.counters.switches++;
    if (this.state === "exited") return { exited: true, stop: null, status: (this.exitCode ?? 0) << 8 };
    this.counters.stops++;
    const sigTrapGood = SIG.TRAP | ((this.options & PTRACE_O.TRACESYSGOOD) !== 0 ? 0x80 : 0);
    const status =
      this.stop === "attach" ? (SIG.STOP << 8) | 0x7f :
      this.stop === "seccomp" ? ((SIG.TRAP | (PTRACE_EVENT_SECCOMP << 8)) << 8) | 0x7f :
      (sigTrapGood << 8) | 0x7f;
    return { exited: false, stop: this.stop, status };
  }

  getRegs(): UserRegs | number {
    this.counters.tracerSyscalls++;
    const e = this.needStopped();
    if (e) return e;
    this.counters.regReads++;
    return { ...this.regs };
  }

  /** One 8-byte word of the tracee's memory, as bytes. A real call returns it as a long. */
  peekData(addr: number): Uint8Array | number {
    this.counters.tracerSyscalls++;
    const e = this.needStopped();
    if (e) return e;
    this.counters.peeks++;
    for (const [base, bytes] of this.memory) {
      if (addr >= base && addr < base + bytes.length) {
        const out = new Uint8Array(WORD_BYTES);
        for (let i = 0; i < WORD_BYTES; i++) out[i] = bytes[addr - base + i] ?? 0;
        return out;
      }
    }
    return -ERR.EIO;
  }

  /** PTRACE_DETACH: the tracee runs free. */
  detach(): number {
    this.counters.tracerSyscalls++;
    const e = this.needStopped();
    if (e) return e;
    this.tracer = null;
    this.state = "running";
    this.stop = null;
    return 0;
  }
}

// ---------------------------------------------------------------------------- the strace loop

export const TEXT_ADDR = 0x4000a0;
export const HELLO = "hello, ptrace\n";
export const USER_SYSCALL_RIP = 0x401234;

/** A program for the demo. Real x86-64 syscall numbers. */
export const DEMO_PROGRAM: TraceeOp[] = [
  { kind: "user", label: "compute" },
  { kind: "sys", name: "getpid", nr: 39, args: [], ret: 4242, rip: USER_SYSCALL_RIP },
  { kind: "user", label: "format the text" },
  { kind: "sys", name: "write", nr: 1, args: [1, TEXT_ADDR, HELLO.length], ret: HELLO.length, rip: USER_SYSCALL_RIP + 0x20, text: { addr: TEXT_ADDR, bytes: HELLO } },
  { kind: "user", label: "clean up" },
  { kind: "sys", name: "exit_group", nr: 231, args: [0], ret: 0, rip: USER_SYSCALL_RIP + 0x40 },
];

export type Actor = "tracer" | "tracee" | "kernel";
export interface StraceStep {
  title: string;
  text: string;
  /** Who is on the CPU after this step. */
  onCpu: "tracer" | "tracee" | "none";
  state: TraceeState;
  stop: StopKind | null;
  actor: Actor;
  regs: UserRegs;
  /** Registers that the tracer just read. */
  read?: (keyof UserRegs)[];
  /** The word of memory that the tracer just read. */
  word?: { addr: number; bytes: number[] };
  counters: PtraceCounters;
  /** The strace output so far. */
  output: string[];
  /** The ptrace call, as code. */
  call?: string;
}

const escapeC = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

/** A line in the format of strace. */
export function straceLine(op: Extract<TraceeOp, { kind: "sys" }>, ret: number, suffix = ""): string {
  const args = op.args.map((a, i) => (op.text && a === op.text.addr && i === 1 ? `"${escapeC(op.text.bytes)}"` : String(a))).join(", ");
  return `${op.name}(${args}) = ${ret}${suffix}`;
}

export interface StraceOptions {
  /** "all": PTRACE_SYSCALL stops at each call. "seccomp": a filter asks for stops only for the names in `traced`. */
  mode: "all" | "seccomp";
  /** Print only these calls. Undefined prints all calls. */
  traced?: string[];
}

/**
 * Runs the real tracer loop against PtraceMachine and records each step.
 * It uses only the public requests, so an illegal order would fail.
 */
export function straceSteps(program: TraceeOp[], opts: StraceOptions): StraceStep[] {
  const m = new PtraceMachine(program);
  const out: StraceStep[] = [];
  const output: string[] = [];
  const traced = opts.traced ? new Set(opts.traced) : null;
  const shouldPrint = (name: string) => !traced || traced.has(name);
  const snap = (s: Pick<StraceStep, "title" | "text" | "onCpu" | "actor"> & Partial<StraceStep>) => {
    out.push({ state: m.state, stop: m.stop, regs: { ...m.regs }, counters: { ...m.counters }, output: output.slice(), ...s });
  };
  const must = (r: number) => {
    if (r < 0) throw new Error(`ptrace failed: ${r}`);
  };
  const byNr = new Map(program.flatMap((o) => (o.kind === "sys" ? [[o.nr, o] as const] : [])));
  const filter = opts.mode === "seccomp" ? traced ?? new Set(program.flatMap((o) => (o.kind === "sys" ? [o.name] : []))) : null;

  if (opts.mode === "seccomp") {
    m.spawnTraced(1000, filter);
    snap({ title: "Start the child", text: "strace forks. The child calls PTRACE_TRACEME, stops itself, loads a seccomp filter, and then calls execve.", onCpu: "tracer", actor: "tracer", call: "fork(), PTRACE_TRACEME, seccomp(SECCOMP_SET_MODE_FILTER, ...)" });
  } else {
    must(m.attach(1000));
    snap({ title: "Attach", text: "PTRACE_ATTACH makes this process the tracer, and it sends SIGSTOP to the tracee.", onCpu: "tracer", actor: "tracer", call: "ptrace(PTRACE_ATTACH, pid, 0, 0)" });
  }
  m.waitpid();
  snap({ title: "The tracee is stopped", text: "waitpid returns. The tracee is now in TASK_TRACED, so requests can work.", onCpu: "tracer", actor: "tracer", call: "waitpid(pid, &status, 0)" });
  must(m.setOptions(PTRACE_O.TRACESYSGOOD | (opts.mode === "seccomp" ? PTRACE_O.TRACESECCOMP : 0)));
  snap({ title: "Set options", text: opts.mode === "seccomp" ? "PTRACE_O_TRACESECCOMP makes SECCOMP_RET_TRACE a stop. PTRACE_O_TRACESYSGOOD sets bit 7 in the signal of a syscall stop." : "PTRACE_O_TRACESYSGOOD sets bit 7 in the signal of a syscall stop, so that the tracer can tell it from a real SIGTRAP.", onCpu: "tracer", actor: "tracer", call: "ptrace(PTRACE_SETOPTIONS, pid, 0, opts)" });

  const resumeCall = () => (opts.mode === "seccomp" ? m.ptraceCont() : m.ptraceSyscall());
  must(resumeCall());
  const resumeName = opts.mode === "seccomp" ? "PTRACE_CONT" : "PTRACE_SYSCALL";
  const exited = () => {
    output.push(`+++ exited with ${m.exitCode} +++`);
    snap({ title: "The tracee has exited", text: "waitpid reports the exit. The tracer also exits.", onCpu: "tracer", actor: "tracer", call: "waitpid(pid, &status, 0)" });
  };

  for (let guard = 0; guard < 1000; guard++) {
    snap({ title: `${resumeName}: the tracee runs`, text: m.ran.join(" ") || "The tracee runs.", onCpu: m.state === "exited" ? "none" : "tracee", actor: "tracee", call: `ptrace(${resumeName}, pid, 0, 0)` });
    const st = m.waitpid();
    if (!st) throw new Error("no stop");
    if (st.exited) {
      exited();
      break;
    }
    // The first stop.
    snap({ title: st.stop === "seccomp" ? "Stop 1 of 2: the filter asked for it" : "Stop 1 of 2: syscall entry", text: "The kernel puts the tracee in TASK_TRACED and wakes the tracer. The CPU switches to the tracer, and the call has not run yet.", onCpu: "tracer", actor: "kernel", call: "waitpid(pid, &status, 0)" });
    const entry = m.getRegs();
    if (typeof entry === "number") throw new Error("getregs");
    snap({ title: "Read the registers", text: `orig_rax holds the number ${entry.orig_rax}. rax holds ${entry.rax}, which is -ENOSYS. The arguments are in rdi, rsi and rdx.`, onCpu: "tracer", actor: "tracer", read: ["orig_rax", "rax", "rdi", "rsi", "rdx"], call: "ptrace(PTRACE_GETREGS, pid, 0, &regs)" });
    const op = byNr.get(entry.orig_rax)!;
    if (op.text && shouldPrint(op.name)) {
      for (let a = op.text.addr; a < op.text.addr + op.text.bytes.length; a += WORD_BYTES) {
        const w = m.peekData(a);
        if (typeof w === "number") throw new Error("peek");
        snap({ title: "Read one word of the string", text: "The string is in the memory of the tracee. Each PTRACE_PEEKDATA is one system call for 8 bytes. strace prefers process_vm_readv for long data.", onCpu: "tracer", actor: "tracer", word: { addr: a, bytes: [...w] }, call: `ptrace(PTRACE_PEEKDATA, pid, 0x${a.toString(16)}, 0)` });
      }
    }
    if (op.name === "exit_group") {
      if (shouldPrint(op.name)) output.push(`${op.name}(${op.args[0] ?? 0}) = ?`);
      must(m.ptraceSyscall());
      snap({ title: "Resume the last call", text: "exit_group does not return, so there is no second stop.", onCpu: "none", actor: "tracer", call: "ptrace(PTRACE_SYSCALL, pid, 0, 0)" });
      const end = m.waitpid();
      if (!end?.exited) throw new Error("no exit");
      exited();
      break;
    }
    must(m.ptraceSyscall());
    snap({ title: "Resume: the call runs", text: `The CPU switches back. The kernel runs ${op.name}, and it stops the tracee again before the return to user mode.`, onCpu: "tracee", actor: "kernel", call: "ptrace(PTRACE_SYSCALL, pid, 0, 0)" });
    // The second stop.
    const ex = m.waitpid();
    if (!ex) throw new Error("no exit stop");
    snap({ title: "Stop 2 of 2: syscall exit", text: "The tracee stops again, and the CPU switches to the tracer again. The call has finished, and the result is in rax.", onCpu: "tracer", actor: "kernel", call: "waitpid(pid, &status, 0)" });
    const exit = m.getRegs();
    if (typeof exit === "number") throw new Error("getregs");
    if (shouldPrint(op.name)) {
      output.push(straceLine(op, exit.rax));
      m.counters.tracerSyscalls++;
    }
    snap({ title: "Read the result, and print", text: shouldPrint(op.name) ? `rax holds ${exit.rax}. strace formats a line and writes it. This is one more system call.` : `rax holds ${exit.rax}. This call is not in the -e list, so nothing is printed. The two stops still happened.`, onCpu: "tracer", actor: "tracer", read: ["rax"], call: "ptrace(PTRACE_GETREGS, pid, 0, &regs)" });
    must(resumeCall());
  }
  return out;
}
