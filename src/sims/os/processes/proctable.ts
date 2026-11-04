/**
 * A small process table: states, a parent tree, one CPU, and the rules of exit and wait.
 *
 * It follows Linux where the rule matters:
 * - Only the running process can block, exit or call wait. A process does these things to itself.
 * - exit makes a zombie. The zombie keeps its PID and exit status until its parent reaps it.
 * - When a parent exits, its children go to the nearest subreaper ancestor, else to PID 1
 *   (find_new_reaper in kernel/exit.c, without the "another thread of the same process" case).
 * - PID 1 reaps at once. In this model it is always blocked in wait and takes no CPU time.
 * - If the parent ignores SIGCHLD, a child that exits is reaped with no zombie stage.
 */

export type ProcState = "ready" | "running" | "blocked" | "zombie";
export type BlockReason = "io" | "wait";

export interface Proc {
  pid: number;
  ppid: number;
  name: string;
  state: ProcState;
  reason?: BlockReason;
  exitCode?: number;
  /** prctl(PR_SET_CHILD_SUBREAPER, 1). */
  subreaper: boolean;
  /** signal(SIGCHLD, SIG_IGN). */
  ignoresSigchld: boolean;
}

export interface EventResult {
  ok: boolean;
  text: string;
  /** Edges of the state diagram that this event used, as "from>to". */
  edges: string[];
  /** PIDs that this event changed. */
  pids: number[];
}

/** The kernel's PID_MAX_DEFAULT. Read the live limit from /proc/sys/kernel/pid_max. */
export const PID_MAX_DEFAULT = 32768;

/** Hours until a zombie leak uses all PIDs. */
export const pidExhaustionHours = (zombiesPerSecond: number, pidMax = PID_MAX_DEFAULT) => pidMax / zombiesPerSecond / 3600;

/** The letter that ps prints in its STAT column. Linux has one TASK_RUNNING state for running and ready. */
export const statLetter = (p: Proc): string => (p.state === "zombie" ? "Z" : p.state === "blocked" ? "S" : "R");

export class ProcTable {
  procs = new Map<number, Proc>();
  runq: number[] = [];
  running: number | null = null;
  stats = { switches: 0, forks: 0, exits: 0, reaped: 0, reapedByInit: 0, reparented: 0 };

  constructor() {
    this.procs.set(1, { pid: 1, ppid: 0, name: "init", state: "blocked", reason: "wait", subreaper: false, ignoresSigchld: false });
  }

  get(pid: number): Proc | undefined { return this.procs.get(pid); }
  list(): Proc[] { return [...this.procs.values()].sort((a, b) => a.pid - b.pid); }
  children(pid: number): Proc[] { return this.list().filter((p) => p.ppid === pid); }
  zombies(): Proc[] { return this.list().filter((p) => p.state === "zombie"); }

  /** Adds a ready process. A real kernel does this in fork. */
  spawn(pid: number, name: string, ppid: number): Proc {
    if (this.procs.has(pid)) throw new Error(`PID ${pid} is in use`);
    if (!this.procs.has(ppid)) throw new Error(`no parent ${ppid}`);
    const p: Proc = { pid, ppid, name, state: "ready", subreaper: false, ignoresSigchld: false };
    this.procs.set(pid, p);
    this.runq.push(pid);
    this.stats.forks++;
    return p;
  }

  /** Timer tick or yield: the running process goes to the tail of the queue, the head runs. */
  schedule(): EventResult {
    const prev = this.running;
    if (this.runq.length === 0) {
      return prev === null
        ? { ok: false, text: "The run queue is empty. The CPU stays idle until a process is ready.", edges: [], pids: [] }
        : { ok: true, text: `No other process is ready, so ${this.name(prev)} keeps the CPU.`, edges: [], pids: [prev] };
    }
    const edges: string[] = [];
    const pids: number[] = [];
    if (prev !== null) {
      this.procs.get(prev)!.state = "ready";
      this.runq.push(prev);
      this.running = null;
      edges.push("running>ready");
      pids.push(prev);
    }
    const next = this.runq.shift()!;
    const n = this.procs.get(next)!;
    n.state = "running";
    this.running = next;
    this.stats.switches++;
    edges.push("ready>running");
    pids.push(next);
    let text = prev !== null ? `The scheduler preempts ${this.name(prev)} and runs ${this.name(next)}.` : `The scheduler runs ${this.name(next)}.`;
    // A parent that woke from wait finishes its wait as soon as it runs.
    if (n.reason === "wait") {
      n.reason = undefined;
      const z = this.children(next).find((c) => c.state === "zombie");
      if (z) {
        this.reap(z);
        edges.push("zombie>gone");
        pids.push(z.pid);
        text += ` Its wait returns and reaps ${z.name} (PID ${z.pid}).`;
      }
    }
    return { ok: true, text, edges, pids };
  }

  /** The running process blocks on I/O. */
  block(): EventResult {
    const pid = this.running;
    if (pid === null) return { ok: false, text: "The CPU is idle. Only the running process can start I/O and block.", edges: [], pids: [] };
    const p = this.procs.get(pid)!;
    p.state = "blocked";
    p.reason = "io";
    this.running = null;
    return { ok: true, text: `${this.name(pid)} calls read and the data is not ready. It sleeps, and the CPU is free.`, edges: ["running>blocked"], pids: [pid] };
  }

  /** The device finishes. An interrupt handler wakes the sleeper. */
  ioDone(pid: number): EventResult {
    const p = this.procs.get(pid);
    if (!p || p.state !== "blocked" || p.reason !== "io") return { ok: false, text: `PID ${pid} is not waiting for I/O.`, edges: [], pids: [] };
    p.state = "ready";
    p.reason = undefined;
    this.runq.push(pid);
    return { ok: true, text: `The device interrupts. ${this.name(pid)} is ready, but it must wait for the scheduler to choose it.`, edges: ["blocked>ready"], pids: [pid] };
  }

  /** The running process calls exit. */
  exit(code = 0): EventResult {
    const pid = this.running;
    if (pid === null) return { ok: false, text: "The CPU is idle. A process must run to call exit.", edges: [], pids: [] };
    this.running = null;
    return this.die(pid, code);
  }

  /** SIGKILL or any fatal signal: the target exits from any state. PID 1 cannot die. */
  kill(pid: number, code = 137): EventResult {
    const p = this.procs.get(pid);
    if (!p) return { ok: false, text: `No process has PID ${pid}.`, edges: [], pids: [] };
    if (pid === 1) return { ok: false, text: "PID 1 ignores the kill. If init ever exits, the kernel panics.", edges: [], pids: [] };
    if (p.state === "zombie") return { ok: false, text: `${this.name(pid)} is already a zombie. A signal cannot kill it again. Only its parent can remove it.`, edges: [], pids: [] };
    if (this.running === pid) this.running = null;
    this.runq = this.runq.filter((x) => x !== pid);
    return this.die(pid, code);
  }

  private die(pid: number, code: number): EventResult {
    const p = this.procs.get(pid)!;
    const from = p.state;
    p.exitCode = code;
    p.reason = undefined;
    p.state = "zombie";
    this.stats.exits++;
    const edges = [`${from}>zombie`];
    const pids = [pid];
    let text = `${this.name(pid)} exits with status ${code}. The kernel frees its memory and files, and keeps a small record.`;

    // Re-parent the children first (forget_original_parent), so that no process points at a dead parent.
    const kids = this.children(pid);
    if (kids.length > 0) {
      const reaper = this.findReaper(pid);
      for (const c of kids) {
        c.ppid = reaper;
        this.stats.reparented++;
        pids.push(c.pid);
      }
      text += ` ${kids.length} ${kids.length === 1 ? "child moves" : "children move"} to ${this.name(reaper)}.`;
      const rp = this.procs.get(reaper)!;
      for (const c of kids) {
        if (c.state === "zombie" && (reaper === 1 || rp.ignoresSigchld)) {
          this.reap(c);
          edges.push("zombie>gone");
          text += ` ${this.name(reaper)} reaps the zombie ${c.name} at once.`;
        } else if (c.state === "zombie" && rp.state === "blocked" && rp.reason === "wait") {
          rp.state = "ready";
          this.runq.push(rp.pid);
          edges.push("blocked>ready");
          pids.push(rp.pid);
        }
      }
    }

    // Now tell the parent (exit_notify).
    const parent = this.procs.get(p.ppid)!;
    if (p.ppid === 1) {
      this.reap(p);
      edges.push("zombie>gone");
      text += " Its parent is PID 1, which reaps it at once.";
    } else if (parent.ignoresSigchld) {
      this.reap(p);
      edges.push("zombie>gone");
      text += ` ${parent.name} ignores SIGCHLD, so the kernel reaps the child with no zombie stage.`;
    } else if (parent.state === "blocked" && parent.reason === "wait") {
      parent.state = "ready";
      this.runq.push(parent.pid);
      edges.push("blocked>ready");
      pids.push(parent.pid);
      text += ` SIGCHLD wakes ${parent.name}. The child stays a zombie until ${parent.name} runs and its wait returns.`;
    } else {
      text += ` SIGCHLD goes to ${parent.name}. The child stays a zombie until ${parent.name} calls wait.`;
    }
    return { ok: true, text, edges, pids };
  }

  /** The running process calls wait. */
  wait(pid = this.running): EventResult {
    if (pid === null) return { ok: false, text: "The CPU is idle. A process must run to call wait.", edges: [], pids: [] };
    const p = this.procs.get(pid);
    if (!p) return { ok: false, text: `No process has PID ${pid}.`, edges: [], pids: [] };
    const kids = this.children(pid);
    if (kids.length === 0) return { ok: true, text: `${this.name(pid)} has no children, so wait returns -1 with errno ECHILD.`, edges: [], pids: [pid] };
    const z = kids.find((c) => c.state === "zombie");
    if (z) {
      this.reap(z);
      return { ok: true, text: `wait returns PID ${z.pid} and status ${z.exitCode}. The kernel removes ${z.name} from the table and frees the PID.`, edges: ["zombie>gone"], pids: [z.pid] };
    }
    if (this.running === pid) {
      p.state = "blocked";
      p.reason = "wait";
      this.running = null;
      return { ok: true, text: `No child has exited yet, so ${this.name(pid)} sleeps in wait.`, edges: ["running>blocked"], pids: [pid] };
    }
    return { ok: false, text: `No child of ${this.name(pid)} is a zombie.`, edges: [], pids: [] };
  }

  /** Nearest ancestor with the subreaper flag, else PID 1. */
  findReaper(pid: number): number {
    let a = this.procs.get(pid)!.ppid;
    while (a !== 1 && a !== 0) {
      const p = this.procs.get(a);
      if (!p) break;
      if (p.subreaper && p.state !== "zombie") return a;
      a = p.ppid;
    }
    return 1;
  }

  private reap(p: Proc) {
    this.procs.delete(p.pid);
    if (p.ppid === 1) this.stats.reapedByInit++;
    this.stats.reaped++;
  }

  name(pid: number): string {
    const p = this.procs.get(pid);
    return p ? `${p.name} (PID ${p.pid})` : `PID ${pid}`;
  }

  /** Returns every broken rule. An empty list means that the table is consistent. */
  check(): string[] {
    const bad: string[] = [];
    const running = this.list().filter((p) => p.state === "running");
    if (running.length > 1) bad.push("more than one process runs on one CPU");
    if ((running[0]?.pid ?? null) !== this.running) bad.push("the CPU pointer disagrees with the states");
    const ready = this.list().filter((p) => p.state === "ready").map((p) => p.pid).sort((a, b) => a - b);
    const q = [...this.runq].sort((a, b) => a - b);
    if (JSON.stringify(ready) !== JSON.stringify(q)) bad.push(`run queue ${q} does not match ready set ${ready}`);
    for (const p of this.list()) {
      if (p.pid === 1) continue;
      const parent = this.procs.get(p.ppid);
      if (!parent) bad.push(`${p.pid} points at a missing parent ${p.ppid}`);
      else if (parent.state === "zombie") bad.push(`${p.pid} has a zombie parent ${p.ppid}`);
      if (p.state === "zombie" && p.ppid === 1) bad.push(`init did not reap ${p.pid}`);
      if (p.state === "zombie" && parent?.ignoresSigchld) bad.push(`${p.pid} is a zombie, but its parent ignores SIGCHLD`);
    }
    return bad;
  }
}

/** The state machine demo: a shell with three children, all ready, and an idle CPU. */
export function stateMachineTable(): ProcTable {
  const t = new ProcTable();
  t.spawn(100, "shell", 1);
  t.spawn(101, "A", 100);
  t.spawn(102, "B", 100);
  t.spawn(103, "C", 100);
  return t;
}

/** The tree demo. All processes are ready. Only the tree matters there. */
export function treeTable(): ProcTable {
  const t = new ProcTable();
  t.spawn(210, "sshd", 1);
  t.spawn(305, "bash", 210);
  t.spawn(410, "make", 305);
  t.spawn(520, "cc1", 410);
  t.spawn(521, "as", 410);
  t.spawn(212, "nginx", 1);
  t.spawn(330, "wrk1", 212);
  t.spawn(331, "wrk2", 212);
  return t;
}
