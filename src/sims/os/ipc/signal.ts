/**
 * Linux signal delivery as a state machine, following kernel/signal.c and arch/x86/kernel/signal.c.
 *
 * - A sender sets a pending entry. A standard signal has one bit, so a second send merges with the first.
 *   A real-time signal has one queue entry for each send.
 * - The kernel delivers only on the way back to user mode (exit_to_user_mode_loop, then get_signal).
 * - For a handler, setup_rt_frame pushes a frame on the user stack and changes the saved registers.
 *   The handler then runs in user mode. It returns to __restore_rt, which calls rt_sigreturn.
 * - A sleeping syscall returns -ERESTARTSYS when a signal wakes it. The handler's SA_RESTART flag then decides
 *   between rewinding rip to the syscall instruction and returning -EINTR.
 */
import { BLOCK, type Ins, type Prog } from "../sync/machine";

export const SIG = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10,
  SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20,
  SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31,
} as const;

export const SIGNAL_FACTS = {
  standardCount: 31,
  /** The first real-time number in the kernel. glibc keeps 32 and 33 for its threads library. */
  kernelSigRtMin: 32,
  glibcSigRtMin: 34,
  sigRtMax: 64,
  glibcRtCount: 64 - 34 + 1,
  /** Bytes below rsp that a leaf function may use on x86-64. setup_rt_frame skips them. */
  redZoneBytes: 128,
  /** The rt_sigreturn syscall number. */
  rtSigreturnX86: 15,
  rtSigreturnArm64: 139,
  /** The size of the x86-64 syscall instruction. The restart rewinds rip by this much. */
  syscallInsnBytes: 2,
  /** Shells report death by signal n as exit status 128 + n. */
  shellBase: 128,
  /** Go preempts a goroutine after it runs this long. */
  goPreemptMs: 10,
  /** Go's preemption signal. */
  goPreemptSignal: SIG.SIGURG,
  /** macOS has only standard signals, with no real-time range. */
  macosSignals: 31,
} as const;

/** Different numbers on macOS, for a reader who tries this on a Mac. */
export const MACOS_SIGNAL_NUMBERS = { SIGBUS: 10, SIGSYS: 12, SIGURG: 16, SIGSTOP: 17, SIGTSTP: 18, SIGCONT: 19, SIGCHLD: 20, SIGUSR1: 30, SIGUSR2: 31 } as const;

export type DefaultAction = "term" | "core" | "ign" | "stop" | "cont";

const D: Record<DefaultAction, number[]> = {
  term: [SIG.SIGHUP, SIG.SIGINT, SIG.SIGKILL, SIG.SIGUSR1, SIG.SIGUSR2, SIG.SIGPIPE, SIG.SIGALRM, SIG.SIGTERM, SIG.SIGSTKFLT, SIG.SIGVTALRM, SIG.SIGPROF, SIG.SIGIO, SIG.SIGPWR],
  core: [SIG.SIGQUIT, SIG.SIGILL, SIG.SIGTRAP, SIG.SIGABRT, SIG.SIGBUS, SIG.SIGFPE, SIG.SIGSEGV, SIG.SIGXCPU, SIG.SIGXFSZ, SIG.SIGSYS],
  ign: [SIG.SIGCHLD, SIG.SIGURG, SIG.SIGWINCH],
  stop: [SIG.SIGSTOP, SIG.SIGTSTP, SIG.SIGTTIN, SIG.SIGTTOU],
  cont: [SIG.SIGCONT],
};

export function defaultAction(sig: number): DefaultAction {
  if (sig >= SIGNAL_FACTS.kernelSigRtMin) return "term";
  for (const k of Object.keys(D) as DefaultAction[]) if (D[k].includes(sig)) return k;
  throw new Error(`no signal ${sig}`);
}

export const sigName = (sig: number): string => {
  const hit = Object.entries(SIG).find(([, v]) => v === sig);
  return hit ? hit[0] : `SIGRTMIN+${sig - SIGNAL_FACTS.glibcSigRtMin}`;
};
export const isRealtime = (sig: number) => sig >= SIGNAL_FACTS.kernelSigRtMin;
export const canCatch = (sig: number) => sig !== SIG.SIGKILL && sig !== SIG.SIGSTOP;

// ---------------------------------------------------------------- pending signals

export interface Queued { sig: number; value: number }

/** One struct sigpending: a set for standard signals, and a FIFO queue for real-time signals. */
export class SigPending {
  std: Queued[] = [];
  rt: Queued[] = [];
  merged = 0;
  /** Returns "merged" if a standard signal of this number is already pending. Otherwise "queued". */
  add(sig: number, value = 0): "queued" | "merged" {
    if (isRealtime(sig)) { this.rt.push({ sig, value }); return "queued"; }
    if (this.std.some((q) => q.sig === sig)) { this.merged++; return "merged"; }
    this.std.push({ sig, value });
    return "queued";
  }
  /** The lowest-numbered signal that is not blocked. Inside one real-time number, the oldest first. */
  peek(blocked: readonly number[]): Queued | null {
    let best: Queued | null = null;
    for (const q of [...this.std, ...this.rt]) {
      if (blocked.includes(q.sig) && canCatch(q.sig)) continue;
      if (!best || q.sig < best.sig) best = q;
    }
    return best;
  }
  take(q: Queued) {
    const list = isRealtime(q.sig) ? this.rt : this.std;
    list.splice(list.indexOf(q), 1);
  }
  has(sig: number) { return [...this.std, ...this.rt].some((q) => q.sig === sig); }
  count(sig: number) { return [...this.std, ...this.rt].filter((q) => q.sig === sig).length; }
  get size() { return this.std.length + this.rt.length; }
  clone() { const p = new SigPending(); p.std = this.std.map((q) => ({ ...q })); p.rt = this.rt.map((q) => ({ ...q })); p.merged = this.merged; return p; }
}

// ---------------------------------------------------------------- one task

export type Disposition = "SIG_DFL" | "SIG_IGN" | "handler";

export interface SigAction {
  handler: Disposition;
  /** sa_mask: more signals to block while the handler runs. */
  mask: number[];
  /** SA_RESTART. */
  restart: boolean;
  /** SA_NODEFER: do not block the signal itself in its handler. */
  nodefer: boolean;
}

export const DFL: SigAction = { handler: "SIG_DFL", mask: [], restart: false, nodefer: false };
export const handlerAction = (o: Partial<SigAction> = {}): SigAction => ({ handler: "handler", mask: [], restart: false, nodefer: false, ...o });

export type Phase =
  | "user" // running the main program
  | "sleeping" // blocked inside read
  | "kick" // entered the kernel because of a signal IPI or an interrupt
  | "syscall-exit" // read has finished or was interrupted, and the kernel is on the way out
  | "handler"
  | "restorer"
  | "sigreturn"
  | "dead"
  | "stopped"
  | "finished";

export interface SigFrame {
  sig: number;
  value: number;
  /** Saved in uc_mcontext. */
  savedRip: string;
  savedRsp: number;
  savedRax: string;
  /** uc_sigmask. */
  savedBlocked: number[];
  /** Where this frame returns to, and the line there. */
  savedPhase: "user" | "handler";
  savedPc: number;
  /** The rsp of this frame. */
  frameRsp: number;
}

export interface LineSpec { text: string; rip: string }

export const MAIN_LINES: LineSpec[] = [
  { text: "setup();", rip: "main+0x10" },
  { text: "n = read(fd, buf, 64);", rip: "main+0x20" },
  { text: "if (n < 0) report(errno);", rip: "main+0x22" },
  { text: "process(buf, n);", rip: "main+0x30" },
];
export const READ_LINE = 1;
export const AFTER_READ = 2;

export const HANDLER_LINES: LineSpec[] = [
  { text: "int saved = errno;", rip: "on_sig+0x0" },
  { text: "write(pipefd, \"x\", 1);", rip: "on_sig+0x8" },
  { text: "errno = saved;", rip: "on_sig+0x18" },
  { text: "return;", rip: "on_sig+0x20" },
];
export const RESTORER_TEXT = "__restore_rt: mov $15, %eax; syscall";

/** MODEL INPUT: the real frame size depends on the CPU's XSAVE area. */
export const FRAME_BYTES_MODEL = 0x400;
const START_RSP = 0x7ffd1000;

export interface LogEntry { text: string; tone?: "kernel" | "user" | "bad" | "good" }

export class SignalTask {
  blocked: number[] = [];
  pending = new SigPending();
  actions: Record<number, SigAction> = {};
  phase: Phase = "user";
  pc = 0;
  /** Which line of the handler. */
  hpc = 0;
  rax = "0";
  origRax = "-1";
  rip = MAIN_LINES[0]!.rip;
  rsp = START_RSP;
  frames: SigFrame[] = [];
  /** TIF_SIGPENDING. */
  sigpendingFlag = false;
  dataReady = false;
  /** The read has returned this to the kernel exit path: "-ERESTARTSYS" or a byte count. */
  sysResult: string | null = null;
  handled: Queued[] = [];
  log: LogEntry[] = [];
  exitSignal: number | null = null;
  /** read returned this to the program. */
  readReturned: string | null = null;

  action(sig: number): SigAction { return this.actions[sig] ?? DFL; }
  sigaction(sig: number, a: SigAction) {
    if (!canCatch(sig)) throw new Error(`${sigName(sig)} cannot be caught`);
    this.actions[sig] = a;
    this.recalc();
  }
  sigprocmask(how: "block" | "unblock", sigs: number[]) {
    const list = sigs.filter(canCatch);
    this.blocked = how === "block" ? [...new Set([...this.blocked, ...list])].sort((a, b) => a - b) : this.blocked.filter((s) => !list.includes(s));
    this.recalc();
    this.wakeIfNeeded();
  }

  private say(text: string, tone?: LogEntry["tone"]) { this.log.push({ text, tone }); }
  get last(): LogEntry | undefined { return this.log[this.log.length - 1]; }

  /** recalc_sigpending: the flag says that some pending signal is not blocked. */
  private recalc() { this.sigpendingFlag = this.pending.peek(this.blocked) !== null; }
  get deliverable() { return this.pending.peek(this.blocked); }

  private ignoredNow(sig: number) {
    const a = this.action(sig);
    return a.handler === "SIG_IGN" || (a.handler === "SIG_DFL" && defaultAction(sig) === "ign");
  }

  private wakeIfNeeded() {
    if (this.phase === "sleeping" && this.sigpendingFlag) {
      this.phase = "syscall-exit";
      this.sysResult = "-ERESTARTSYS";
      this.rax = "-ERESTARTSYS";
      this.say("The signal wakes the sleeping task. The read has no data, so it returns -ERESTARTSYS inside the kernel.", "kernel");
    }
  }

  /** kill(2), from another process. */
  send(sig: number, value = 0): "queued" | "merged" | "ignored" {
    if (this.phase === "dead" || this.phase === "finished") return "ignored";
    if (sig === SIG.SIGCONT && this.phase === "stopped") {
      this.phase = "user";
      this.say("SIGCONT moves the stopped task back to the run queue.", "kernel");
    }
    // sig_ignored: an unblocked signal with an ignore action is dropped at once.
    if (this.ignoredNow(sig) && !this.blocked.includes(sig)) {
      this.say(`${sigName(sig)} is ignored, so the kernel drops it at the send.`, "kernel");
      return "ignored";
    }
    const r = this.pending.add(sig, value);
    this.recalc();
    if (r === "merged") this.say(`${sigName(sig)} is already pending. A standard signal has one bit, so this send merges and adds nothing.`, "bad");
    else if (this.blocked.includes(sig)) this.say(`${sigName(sig)} is pending and blocked. The kernel sets its bit and does not wake the task.`, "kernel");
    else this.say(`${sigName(sig)} is pending. The kernel sets TIF_SIGPENDING on the task.`, "kernel");
    this.wakeIfNeeded();
    return r;
  }

  /** New data for the read. */
  dataArrives() {
    this.dataReady = true;
    if (this.phase === "sleeping") {
      this.phase = "syscall-exit";
      this.sysResult = "64";
      this.rax = "64";
      this.say("Data arrives. The read copies 64 bytes and starts its return.", "kernel");
    }
  }

  canStep() { return !(this.phase === "dead" || this.phase === "finished" || this.phase === "stopped" || this.phase === "sleeping"); }

  /** Runs one small step. Returns false if the task cannot run now. */
  step(): boolean {
    switch (this.phase) {
      case "user": return this.stepUser();
      case "kick":
      case "syscall-exit": return this.stepKernelExit();
      case "handler": return this.stepHandler();
      case "restorer":
        this.phase = "sigreturn";
        this.rip = "__restore_rt";
        this.say("The handler returned to __restore_rt, the address in pretcode. It calls rt_sigreturn.", "user");
        return true;
      case "sigreturn": return this.stepSigreturn();
      default: return false;
    }
  }

  private stepUser(): boolean {
    if (this.deliverable) {
      this.phase = "kick";
      this.say("The sender's CPU sends an interrupt to this CPU. The task enters the kernel, and its next step is the return path.", "kernel");
      return true;
    }
    if (this.pc >= MAIN_LINES.length) { this.phase = "finished"; this.say("The program ends.", "good"); return false; }
    const line = MAIN_LINES[this.pc]!;
    this.rip = line.rip;
    if (this.pc === READ_LINE) {
      this.origRax = "0 (read)";
      if (this.dataReady) {
        this.phase = "syscall-exit";
        this.sysResult = "64";
        this.rax = "64";
        this.dataReady = false;
        this.say("read finds data and copies 64 bytes.", "kernel");
      } else {
        this.phase = "sleeping";
        this.say("read enters the kernel and finds no data. The task sleeps in TASK_INTERRUPTIBLE.", "kernel");
      }
      return true;
    }
    if (this.pc === AFTER_READ) this.say(this.readReturned === "-1" ? "read returned -1 with errno = EINTR. The program must decide what to do." : `read returned ${this.readReturned}.`, this.readReturned === "-1" ? "bad" : "good");
    else this.say(`The program runs: ${line.text}`, "user");
    this.pc++;
    if (this.pc >= MAIN_LINES.length) { this.phase = "finished"; this.say("The program ends.", "good"); }
    return true;
  }

  private stepKernelExit(): boolean {
    const q = this.deliverable;
    if (!q) {
      // No signal to deliver. A -ERESTARTSYS restarts with no user-visible effect.
      if (this.sysResult === "-ERESTARTSYS") {
        this.sysResult = null;
        this.phase = "user";
        this.pc = READ_LINE;
        this.rax = this.origRax;
        this.rip = MAIN_LINES[READ_LINE]!.rip;
        this.say("No handler will run, so the kernel rewinds rip and repeats the read. The program sees nothing.", "kernel");
        return true;
      }
      if (this.sysResult !== null) { this.readReturned = this.sysResult; this.sysResult = null; this.pc = AFTER_READ; }
      this.phase = this.frames.length && this.resumeInHandler ? "handler" : "user";
      this.rip = this.phase === "handler" ? HANDLER_LINES[this.hpc]!.rip : MAIN_LINES[Math.min(this.pc, MAIN_LINES.length - 1)]!.rip;
      this.say(this.phase === "handler" ? "No more signals. The task returns to user mode, in the handler." : "No signal to deliver. The task returns to user mode.", "kernel");
      return true;
    }
    this.pending.take(q);
    this.recalc();
    const a = this.action(q.sig);
    if (a.handler === "SIG_IGN" || (a.handler === "SIG_DFL" && defaultAction(q.sig) === "ign")) {
      this.say(`get_signal dequeues ${sigName(q.sig)}. Its action is to ignore it.`, "kernel");
      return true;
    }
    if (a.handler === "SIG_DFL") {
      const d = defaultAction(q.sig);
      if (d === "stop") { this.phase = "stopped"; this.say(`get_signal dequeues ${sigName(q.sig)}. The default action stops the task.`, "kernel"); return true; }
      if (d === "cont") { this.say("SIGCONT has no more work to do.", "kernel"); return true; }
      this.phase = "dead";
      this.exitSignal = q.sig;
      this.say(`get_signal dequeues ${sigName(q.sig)}. The default action kills the process${d === "core" ? " with a core dump" : ""}. A shell would report status ${SIGNAL_FACTS.shellBase + q.sig}.`, "bad");
      return true;
    }
    this.pushFrame(q, a);
    return true;
  }

  private resumeInHandler = false;

  private pushFrame(q: Queued, a: SigAction) {
    let savedRip = this.rip;
    let savedRax = this.rax;
    let savedPc = this.pc;
    const interrupted = this.sysResult;
    if (interrupted === "-ERESTARTSYS") {
      if (a.restart) {
        savedRip = MAIN_LINES[READ_LINE]!.rip;
        savedRax = this.origRax;
        savedPc = READ_LINE;
      } else {
        savedRax = "-EINTR";
        savedPc = AFTER_READ;
      }
    } else if (interrupted !== null) {
      savedRax = interrupted;
      savedPc = AFTER_READ;
    }
    const inHandler = this.resumeInHandler;
    const frameRsp = this.rsp - SIGNAL_FACTS.redZoneBytes - FRAME_BYTES_MODEL;
    this.frames.push({
      sig: q.sig, value: q.value, savedRip, savedRsp: this.rsp, savedRax, savedBlocked: [...this.blocked],
      savedPhase: inHandler ? "handler" : "user", savedPc: inHandler ? this.hpc : savedPc, frameRsp,
    });
    this.sysResult = null;
    this.rsp = frameRsp;
    this.blocked = [...new Set([...this.blocked, ...a.mask, ...(a.nodefer ? [] : [q.sig])])].filter(canCatch).sort((x, y) => x - y);
    this.recalc();
    this.rip = HANDLER_LINES[0]!.rip;
    // The kernel sets the argument registers and clears rax for the handler.
    this.rax = "0";
    this.hpc = 0;
    this.resumeInHandler = true;
    this.phase = "syscall-exit";
    this.handled.push(q);
    const restartNote = interrupted === "-ERESTARTSYS" ? (a.restart ? " SA_RESTART is set, so the saved rip goes back 2 bytes, to the syscall instruction." : " SA_RESTART is not set, so the saved rax becomes -EINTR.") : "";
    this.say(`setup_rt_frame pushes a frame for ${sigName(q.sig)} and sets rip to the handler.${restartNote}`, "kernel");
  }

  private stepHandler(): boolean {
    if (this.deliverable) {
      this.phase = "kick";
      this.say("A signal that is not blocked is pending. An interrupt brings the task into the kernel, in the middle of the handler.", "kernel");
      return true;
    }
    const line = HANDLER_LINES[this.hpc]!;
    this.rip = line.rip;
    this.say(`The handler runs: ${line.text}`, "user");
    this.hpc++;
    if (this.hpc >= HANDLER_LINES.length) this.phase = "restorer";
    return true;
  }

  private stepSigreturn(): boolean {
    const f = this.frames.pop();
    if (!f) throw new Error("sigreturn with no frame");
    this.blocked = f.savedBlocked;
    this.rsp = f.savedRsp;
    this.rip = f.savedRip;
    this.rax = f.savedRax;
    this.recalc();
    if (f.savedPhase === "handler") {
      this.hpc = f.savedPc;
      this.resumeInHandler = true;
    } else {
      this.pc = f.savedPc;
      this.resumeInHandler = false;
      if (f.savedPc === AFTER_READ) this.readReturned = f.savedRax === "-EINTR" ? "-1" : f.savedRax;
      else if (f.savedPc === READ_LINE) this.rax = this.origRax;
    }
    this.sysResult = null;
    this.phase = "syscall-exit";
    this.say(`rt_sigreturn restores all registers and the mask from the frame, and pops it. The saved rip is ${f.savedRip}${f.savedRax === "-EINTR" ? ", and rax is -EINTR" : ""}.`, "kernel");
    return true;
  }

  clone(): SignalTask {
    const t = new SignalTask();
    t.blocked = [...this.blocked];
    t.pending = this.pending.clone();
    t.actions = Object.fromEntries(Object.entries(this.actions).map(([k, a]) => [k, { ...a, mask: [...a.mask] }]));
    t.phase = this.phase; t.pc = this.pc; t.hpc = this.hpc; t.rax = this.rax; t.origRax = this.origRax; t.rip = this.rip; t.rsp = this.rsp;
    t.frames = this.frames.map((f) => ({ ...f, savedBlocked: [...f.savedBlocked] }));
    t.sigpendingFlag = this.sigpendingFlag; t.dataReady = this.dataReady; t.sysResult = this.sysResult;
    t.handled = this.handled.map((q) => ({ ...q })); t.log = [...this.log]; t.exitSignal = this.exitSignal; t.readReturned = this.readReturned;
    t.resumeInHandler = this.resumeInHandler;
    return t;
  }
}

// ---------------------------------------------------------------- threads

export interface SigThread { id: number; blocked: number[] }

/**
 * complete_signal: a signal for the process goes to the main thread if it can take it, and otherwise to any thread that does
 * not block it. A fault goes to the thread that caused it. tgkill names one thread.
 */
export function pickThread(threads: readonly SigThread[], sig: number, target: { kind: "process" } | { kind: "thread"; id: number }): number | null {
  if (target.kind === "thread") return target.id;
  for (const t of threads) if (!t.blocked.includes(sig)) return t.id;
  return null;
}

// ---------------------------------------------------------------- standard signals merge, real-time signals queue

export interface CoalesceSpec {
  sig: number;
  /** Signals sent, one every `gap` ticks, starting at tick 0. */
  sends: number;
  gap: number;
  /** The handler blocks its own signal for this many ticks. */
  handlerTicks: number;
  /** Ticks at the start when the program blocks the signal. */
  maskedTicks: number;
}

export interface CoalesceEvent { tick: number; kind: "send" | "merged" | "start" | "end"; value: number }

export interface CoalesceResult {
  events: CoalesceEvent[];
  sent: number;
  merged: number;
  handlerRuns: number;
  /** Tick of the last event. */
  ticks: number;
}

/** Runs one signal number through the real pending structure with the mask that a handler holds. */
export function coalesceRun(spec: CoalesceSpec): CoalesceResult {
  const p = new SigPending();
  const events: CoalesceEvent[] = [];
  let sent = 0;
  let merged = 0;
  let inHandler = -1;
  let runningValue = 0;
  let t = 0;
  for (; ; t++) {
    while (sent < spec.sends && t >= sent * spec.gap) {
      const value = sent + 1;
      const r = p.add(spec.sig, value);
      sent++;
      if (r === "merged") merged++;
      events.push({ tick: t, kind: r === "merged" ? "merged" : "send", value });
    }
    if (inHandler === t) { events.push({ tick: t, kind: "end", value: runningValue }); inHandler = -1; }
    const masked = inHandler >= 0 || t < spec.maskedTicks;
    if (!masked) {
      const q = p.peek([]);
      if (q) {
        p.take(q);
        runningValue = q.value;
        inHandler = t + Math.max(1, spec.handlerTicks);
        events.push({ tick: t, kind: "start", value: q.value });
      }
    }
    if (sent >= spec.sends && p.size === 0 && inHandler < 0) break;
  }
  return { events, sent, merged, handlerRuns: events.filter((e) => e.kind === "start").length, ticks: t };
}

/** Children that stay zombies. A handler with no loop reaps one child in each run. A WNOHANG loop reaps all. */
export const zombiesLeft = (children: number, handlerRuns: number, reapLoop: boolean) => (reapLoop && handlerRuns > 0 ? 0 : Math.max(0, children - handlerRuns));

// ---------------------------------------------------------------- the handler and the allocator lock

export type HandlerVariant = "malloc" | "nolock" | "masked" | "self-pipe";

export const HANDLER_VARIANTS: { value: HandlerVariant; label: string }[] = [
  { value: "malloc", label: "Handler calls malloc" },
  { value: "nolock", label: "Allocator with no lock" },
  { value: "masked", label: "Block the signal around malloc" },
  { value: "self-pipe", label: "Handler only writes to a pipe" },
];

const lockIns = (text: string): Ins => ({
  text,
  run(c) {
    if (c.mem.lock) { c.say("The lock is held, and the lock is not recursive."); return BLOCK; }
    c.mem.lock = 1;
    c.say("The lock was free. This flow holds it now.");
    return undefined;
  },
});
const unlockIns = (text: string): Ins => ({ text, run(c) { c.mem.lock = 0; c.say("The lock is free."); } });
const unlinkA = (who: string): Ins => ({
  text: "b = free_list;",
  kind: "cs",
  run(c) {
    if (c.mem.editing) c.fail(`The ${who} read the free list while another flow was halfway through an edit. Both flows now own one block. The heap is corrupt.`);
    c.mem.editing = (c.mem.editing ?? 0) + 1;
    c.say("This flow starts to edit the free list.");
  },
});
const unlinkB = (): Ins => ({
  text: "free_list = b->next;",
  kind: "cs",
  run(c) {
    c.mem.editing = (c.mem.editing ?? 1) - 1;
    c.say("The edit is complete.");
  },
});

/**
 * Two flows on ONE thread, for the sync interleaving machine. Thread 1 is the handler. Its first step is the arrival of the
 * signal, so the explorer tries every arrival point. Once the handler starts, the main flow cannot run until
 * sigreturn: that is the `gate`, and it is what makes a plain lock a deadlock.
 */
export function handlerProg(variant: HandlerVariant): Prog {
  const arrive: Ins = { text: "// the signal arrives", run(c) { c.say("The kernel pushes a frame and starts the handler. The main flow stops here until sigreturn."); } };
  const ret: Ins = { text: "sigreturn();", run(c) { c.say("The handler is done. The main flow continues."); } };
  const useMem: Ins = { text: "use(b);", run(c) { c.say("The main flow uses its block."); } };
  const mallocBody = (who: string, locked: boolean): Ins[] => locked
    ? [lockIns("lock(&arena);"), unlinkA(who), unlinkB(), unlockIns("unlock(&arena);")]
    : [unlinkA(who), unlinkB()];
  let main: Ins[];
  let handler: Ins[];
  if (variant === "malloc") {
    main = [...mallocBody("main flow", true), useMem];
    handler = [arrive, ...mallocBody("handler", true), ret];
  } else if (variant === "nolock") {
    main = [...mallocBody("main flow", false), useMem];
    handler = [arrive, ...mallocBody("handler", false), ret];
  } else if (variant === "masked") {
    main = [
      { text: "sigprocmask(SIG_BLOCK, ...);", run(c) { c.mem.blocked = 1; c.say("The signal stays pending if it arrives now."); } },
      ...mallocBody("main flow", true),
      { text: "sigprocmask(SIG_UNBLOCK, ...);", run(c) { c.mem.blocked = 0; c.say("A pending signal can now be delivered."); } },
      useMem,
    ];
    handler = [arrive, ...mallocBody("handler", true), ret];
  } else {
    main = [
      ...mallocBody("main flow", true),
      useMem,
      { text: "poll(pipefd); read(pipefd, ...);", run(c) { if (!c.mem.pipe) { c.say("No byte yet. The event loop waits."); return BLOCK; } c.mem.pipe = 0; c.say("The event loop sees the byte. It handles the signal in normal code."); return undefined; } },
      ...mallocBody("main flow", true),
    ];
    handler = [arrive, { text: "write(pipefd, \"x\", 1);", run(c) { c.mem.pipe = 1; c.say("write is async-signal-safe. It takes no user-space lock."); } }, ret];
  }
  const gate: NonNullable<Prog["gate"]> = (s, t) => {
    const h = s.th[1]!.pc;
    const running = h > 0 && h < handler.length;
    if (t === 0) return !running;
    return h > 0 || !s.mem.blocked;
  };
  return { name: `handler-${variant}`, threads: [main, handler], mem: { lock: 0, editing: 0, blocked: 0, pipe: 0 }, gate, names: ["main", "handler"] };
}
