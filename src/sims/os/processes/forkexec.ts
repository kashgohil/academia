/**
 * fork, exec, dup2 and pipes on a small machine with real sharing rules:
 * - fork copies the fd table, so both tasks point at the same open file descriptions (shared offset).
 * - fork maps every page twice, read-only, with a reference count. The first write copies one page.
 * - exec keeps the fd table (except close-on-exec fds) and replaces every page.
 * - A pipe reader sees EOF only when no write end stays open anywhere.
 * Also: a cost model of fork against resident memory, from a page table count.
 */

export interface FdEntry { ofd: number; cloexec: boolean }
export interface Ofd { id: number; name: string; refs: number; offset: number; kind: "tty" | "pipe-r" | "pipe-w" | "file" }
export interface Page { name: string; frame: number; writable: boolean }
export interface Task {
  pid: number;
  ppid: number;
  image: string;
  fds: [number, FdEntry][];
  pages: Page[];
  /** The value of rax after the last syscall that this task made. */
  ret: string;
  state: "running" | "blocked" | "exited";
  exitCode?: number;
}

export interface FrameInfo { id: number; content: string; refs: number }

export interface MachineSnap {
  tasks: Task[];
  ofds: Ofd[];
  frames: FrameInfo[];
  pipe: string;
  tty: string;
  cowFaults: number;
  framesCopied: number;
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export class Machine {
  tasks = new Map<number, Task>();
  ofds = new Map<number, Ofd>();
  frames = new Map<number, FrameInfo>();
  pipeBuf = "";
  tty = "";
  cowFaults = 0;
  framesCopied = 0;
  private nextPid = 100;
  private nextOfd = 1;
  private nextFrame = 1;

  constructor(image = "sh") {
    const tty = this.newOfd("tty", "tty");
    const t: Task = { pid: this.nextPid++, ppid: 1, image, fds: [], pages: this.newImage(image), ret: "", state: "running" };
    for (const fd of [0, 1, 2]) { t.fds.push([fd, { ofd: tty.id, cloexec: false }]); tty.refs++; }
    this.tasks.set(t.pid, t);
  }

  private newOfd(name: string, kind: Ofd["kind"]): Ofd {
    const o: Ofd = { id: this.nextOfd++, name, refs: 0, offset: 0, kind };
    this.ofds.set(o.id, o);
    return o;
  }

  private newFrame(content: string): number {
    const id = this.nextFrame++;
    this.frames.set(id, { id, content, refs: 1 });
    return id;
  }

  private newImage(image: string): Page[] {
    return [
      { name: "code", frame: this.newFrame(`${image} code`), writable: false },
      { name: "data", frame: this.newFrame(`${image} data`), writable: true },
      { name: "stack", frame: this.newFrame(`${image} stack`), writable: true },
    ];
  }

  private task(pid: number): Task {
    const t = this.tasks.get(pid);
    if (!t) throw new Error(`no task ${pid}`);
    return t;
  }

  private fd(t: Task, fd: number): FdEntry | undefined { return t.fds.find(([n]) => n === fd)?.[1]; }

  private lowestFd(t: Task): number {
    let n = 0;
    while (this.fd(t, n)) n++;
    return n;
  }

  private dropOfd(id: number) {
    const o = this.ofds.get(id)!;
    o.refs--;
    if (o.refs === 0) this.ofds.delete(id);
  }

  private dropFrame(id: number) {
    const f = this.frames.get(id)!;
    f.refs--;
    if (f.refs === 0) this.frames.delete(id);
  }

  open(pid: number, name: string, cloexec: boolean): number {
    const t = this.task(pid);
    const o = this.newOfd(name, "file");
    const fd = this.lowestFd(t);
    t.fds.push([fd, { ofd: o.id, cloexec }]);
    o.refs++;
    t.fds.sort((a, b) => a[0] - b[0]);
    t.ret = String(fd);
    return fd;
  }

  pipe(pid: number): [number, number] {
    const t = this.task(pid);
    const r = this.newOfd("pipe read", "pipe-r");
    const w = this.newOfd("pipe write", "pipe-w");
    const rfd = this.lowestFd(t);
    t.fds.push([rfd, { ofd: r.id, cloexec: false }]);
    const wfd = this.lowestFd(t);
    t.fds.push([wfd, { ofd: w.id, cloexec: false }]);
    r.refs++;
    w.refs++;
    t.fds.sort((a, b) => a[0] - b[0]);
    t.ret = "0";
    return [rfd, wfd];
  }

  /** Returns the child's PID. The parent gets it in rax, and the child gets 0. */
  fork(pid: number): number {
    const p = this.task(pid);
    const child: Task = clone(p);
    child.pid = this.nextPid++;
    child.ppid = pid;
    for (const [, e] of child.fds) this.ofds.get(e.ofd)!.refs++;
    for (const pg of p.pages) { pg.writable = false; this.frames.get(pg.frame)!.refs++; }
    child.pages = clone(p.pages);
    p.ret = String(child.pid);
    child.ret = "0";
    child.state = "running";
    this.tasks.set(child.pid, child);
    return child.pid;
  }

  /** A write to one page. If the page is shared, the fault copies it first. */
  touch(pid: number, name: string, content: string): boolean {
    const t = this.task(pid);
    const pg = t.pages.find((x) => x.name === name)!;
    const f = this.frames.get(pg.frame)!;
    let copied = false;
    if (f.refs > 1) {
      this.dropFrame(pg.frame);
      pg.frame = this.newFrame(f.content);
      this.cowFaults++;
      this.framesCopied++;
      copied = true;
    }
    // After the last sharer leaves, the page can be writable again with no copy (reuse in do_wp_page).
    pg.writable = true;
    this.frames.get(pg.frame)!.content = content;
    return copied;
  }

  dup2(pid: number, oldfd: number, newfd: number) {
    const t = this.task(pid);
    const e = this.fd(t, oldfd);
    if (!e) throw new Error(`bad fd ${oldfd}`);
    if (oldfd !== newfd) {
      const cur = this.fd(t, newfd);
      if (cur) { this.dropOfd(cur.ofd); t.fds = t.fds.filter(([n]) => n !== newfd); }
      t.fds.push([newfd, { ofd: e.ofd, cloexec: false }]); // dup2 clears close-on-exec on the new fd.
      this.ofds.get(e.ofd)!.refs++;
      t.fds.sort((a, b) => a[0] - b[0]);
    }
    t.ret = String(newfd);
  }

  close(pid: number, fd: number) {
    const t = this.task(pid);
    const e = this.fd(t, fd);
    if (!e) throw new Error(`bad fd ${fd}`);
    this.dropOfd(e.ofd);
    t.fds = t.fds.filter(([n]) => n !== fd);
    t.ret = "0";
  }

  /** Replaces the image. PID and fds stay, except close-on-exec fds. */
  exec(pid: number, image: string) {
    const t = this.task(pid);
    for (const pg of t.pages) this.dropFrame(pg.frame);
    t.pages = this.newImage(image);
    t.image = image;
    for (const [n, e] of [...t.fds]) {
      if (e.cloexec) { this.dropOfd(e.ofd); t.fds = t.fds.filter(([m]) => m !== n); }
    }
    t.ret = "does not return";
  }

  /** Writes to fd, either the pipe or the terminal. */
  write(pid: number, fd: number, text: string) {
    const t = this.task(pid);
    const e = this.fd(t, fd);
    if (!e) throw new Error(`bad fd ${fd}`);
    const o = this.ofds.get(e.ofd)!;
    if (o.kind === "pipe-w") this.pipeBuf += text;
    else if (o.kind === "tty") this.tty += text;
    o.offset += text.length;
    t.ret = String(text.length);
  }

  /** The number of write ends of the pipe that remain open, in all tasks. */
  pipeWriters(): number {
    for (const o of this.ofds.values()) if (o.kind === "pipe-w") return o.refs;
    return 0;
  }

  /** Reads all data. Returns null if the read must block: no data, and a write end is still open. */
  read(pid: number): string | null {
    const t = this.task(pid);
    if (this.pipeBuf.length > 0) {
      const d = this.pipeBuf;
      this.pipeBuf = "";
      t.ret = String(d.length);
      return d;
    }
    if (this.pipeWriters() > 0) { t.state = "blocked"; t.ret = "(blocked)"; return null; }
    t.ret = "0";
    t.state = "running";
    return "";
  }

  exit(pid: number, code = 0) {
    const t = this.task(pid);
    for (const [, e] of t.fds) this.dropOfd(e.ofd);
    t.fds = [];
    for (const pg of t.pages) this.dropFrame(pg.frame);
    t.pages = [];
    t.state = "exited";
    t.exitCode = code;
  }

  wait(pid: number, child: number): boolean {
    const c = this.tasks.get(child);
    if (!c || c.state !== "exited") return false;
    this.tasks.delete(child);
    this.task(pid).ret = String(child);
    return true;
  }

  snap(): MachineSnap {
    return clone({
      tasks: [...this.tasks.values()], ofds: [...this.ofds.values()], frames: [...this.frames.values()],
      pipe: this.pipeBuf, tty: this.tty, cowFaults: this.cowFaults, framesCopied: this.framesCopied,
    });
  }

  /** Returns every broken rule. */
  check(): string[] {
    const bad: string[] = [];
    const ofdRefs = new Map<number, number>();
    const frameRefs = new Map<number, number>();
    for (const t of this.tasks.values()) {
      for (const [, e] of t.fds) ofdRefs.set(e.ofd, (ofdRefs.get(e.ofd) ?? 0) + 1);
      for (const p of t.pages) frameRefs.set(p.frame, (frameRefs.get(p.frame) ?? 0) + 1);
      const nums = t.fds.map(([n]) => n);
      if (new Set(nums).size !== nums.length) bad.push(`${t.pid} has a duplicate fd`);
    }
    for (const o of this.ofds.values()) if (ofdRefs.get(o.id) !== o.refs) bad.push(`ofd ${o.id}: refs ${o.refs}, found ${ofdRefs.get(o.id) ?? 0}`);
    for (const id of ofdRefs.keys()) if (!this.ofds.has(id)) bad.push(`a fd points at a freed ofd ${id}`);
    for (const f of this.frames.values()) if (frameRefs.get(f.id) !== f.refs) bad.push(`frame ${f.id}: refs ${f.refs}, found ${frameRefs.get(f.id) ?? 0}`);
    for (const id of frameRefs.keys()) if (!this.frames.has(id)) bad.push(`a page points at a freed frame ${id}`);
    for (const t of this.tasks.values()) for (const p of t.pages) {
      if (p.writable && this.frames.get(p.frame)!.refs > 1) bad.push(`${t.pid} can write the shared frame ${p.frame}`);
    }
    return bad;
  }
}

// ---------------------------------------------------------------------------- the shell pipeline

export interface PipelineOpts {
  /** The shell closes both pipe ends in the parent. */
  closeInParent: boolean;
  /** The shell's open database file has O_CLOEXEC. */
  cloexec: boolean;
}

export interface PipelineStep {
  /** Which task runs this line. */
  actor: "shell" | "left" | "right";
  code: string;
  text: string;
  snap: MachineSnap;
  bad: string[];
}

export const LS_OUTPUT = "a.txt\nb.txt\n";
export const wcCounts = (s: string) => ({ lines: (s.match(/\n/g) ?? []).length, words: s.split(/\s+/).filter(Boolean).length, bytes: s.length });

/** Runs the shell's work for `ls | wc`, one system call per step. */
export function pipeline(opts: PipelineOpts): PipelineStep[] {
  const m = new Machine("sh");
  const steps: PipelineStep[] = [];
  const add = (actor: PipelineStep["actor"], code: string, text: string) => steps.push({ actor, code, text, snap: m.snap(), bad: m.check() });
  const sh = 100;

  m.open(sh, "secrets.db", opts.cloexec);
  add("shell", "// shell starts", `The shell has fds 0, 1 and 2 on the terminal. It also has secrets.db on fd 3${opts.cloexec ? ", with O_CLOEXEC" : ", with no O_CLOEXEC"}. Press Next.`);
  const [r, w] = m.pipe(sh);
  add("shell", `pipe(fds) → ${r}, ${w}`, `The kernel makes a pipe. fd ${r} is the read end and fd ${w} is the write end. Both ends are in one process, so the pipe is not useful yet.`);

  const left = m.fork(sh);
  add("shell", `fork() → ${left}`, `One call returns twice. The shell gets ${left}, and the child gets 0. The fd table is copied, and each page is now shared and read-only.`);

  const leftCopied = m.touch(left, "stack", "child stack");
  add("left", `child writes its stack`, `The child writes to its stack. The page is read-only, so a fault runs${leftCopied ? " and copies that one page" : ""}. The other pages stay shared.`);

  m.dup2(left, w, 1);
  add("left", `dup2(${w}, 1)`, `Now fd 1 of the child points at the pipe's write end. Only the child changes. The shell keeps its stdout.`);
  m.close(left, r);
  m.close(left, w);
  add("left", `close(${r}); close(${w})`, "The child closes the fds that it no longer needs. Fd 1 still holds the write end.");
  m.exec(left, "ls");
  add("left", `execve("/bin/ls")`, `The image is replaced, and the pages are new. The PID and the fd table stay, so ls writes to the pipe and does not know it.${opts.cloexec ? " fd 3 had O_CLOEXEC, so it closes." : " fd 3 had no O_CLOEXEC, so ls inherits secrets.db."}`);

  const right = m.fork(sh);
  add("shell", `fork() → ${right}`, `The shell forks again for the right side. This child also starts as a copy of the shell, with both pipe ends.`);
  m.dup2(right, r, 0);
  add("right", `dup2(${r}, 0)`, "Now fd 0 of this child points at the pipe's read end.");
  m.close(right, r);
  m.close(right, w);
  add("right", `close(${r}); close(${w})`, "If this child kept the write end, wc would hold its own pipe open and never see EOF.");
  m.exec(right, "wc");
  add("right", `execve("/usr/bin/wc")`, `The image is replaced again. wc reads fd 0 and does not know that it is a pipe.${opts.cloexec ? "" : " wc also inherits secrets.db."}`);

  if (opts.closeInParent) {
    m.close(sh, r);
    m.close(sh, w);
    add("shell", `close(${r}); close(${w})`, "The shell closes its copies of both ends. Now ls holds the only write end.");
  } else {
    add("shell", "// shell forgets to close", `The shell keeps fd ${w}, a write end of the pipe. Nothing fails yet.`);
  }

  m.write(left, 1, LS_OUTPUT);
  add("left", `write(1, "a.txt\\nb.txt\\n", ${LS_OUTPUT.length})`, `ls writes ${LS_OUTPUT.length} bytes into the pipe buffer.`);
  m.exit(left);
  add("left", "exit(0)", `ls exits. The kernel closes its fds. The pipe now has ${m.pipeWriters()} open write ${m.pipeWriters() === 1 ? "end" : "ends"}.`);

  const data = m.read(right)!;
  add("right", `read(0, buf, 4096) → ${data.length}`, `wc gets the ${data.length} bytes.`);
  const eof = m.read(right);
  if (eof === null) {
    add("right", "read(0, buf, 4096) → (blocks)", "The pipe is empty, but the shell still holds a write end. The kernel must assume that more data can come, so wc sleeps. The pipeline hangs.");
    const reaped = m.wait(sh, left);
    if (reaped) add("shell", `wait() → ${left}`, `The shell reaps ls. It then waits for wc, which never exits. This is a deadlock with no lock in it.`);
    return steps;
  }
  add("right", "read(0, buf, 4096) → 0", "The pipe is empty and no write end stays open, so read returns 0. That is EOF.");
  const c = wcCounts(data);
  m.write(right, 1, `${c.lines} ${c.words} ${c.bytes}\n`);
  add("right", `write(1, "${c.lines} ${c.words} ${c.bytes}\\n", ...)`, `wc prints its counts on the terminal, which fd 1 still points at.`);
  m.exit(right);
  add("right", "exit(0)", "wc exits. Both children are now zombies until the shell reaps them.");
  m.wait(sh, left);
  m.wait(sh, right);
  add("shell", `wait() → ${left}; wait() → ${right}`, "The shell reaps both children and prints the next prompt.");
  return steps;
}

// ---------------------------------------------------------------------------- fork cost

export const PAGE_4K = 4096;
export const PAGE_2M = 2 * 1024 * 1024;
export const GIB = 1024 ** 3;
/** Entries in one page table page on x86-64. */
export const PT_FANOUT = 512;
export const PTE_BYTES = 8;

/** MODEL INPUTS: round figures of the right size, not measurements of one CPU. */
export const FORK_INPUTS = {
  /** task_struct, kernel stack, VMA list and so on: the part that does not grow with memory. */
  baseUs: 50,
  /** Copy one PTE: read, mark read-only in both, and raise the page's map count. */
  pteNs: 40,
  /** Copy one huge page entry. */
  pmdNs: 200,
  /** Allocate and clear one page table page. */
  ptPageNs: 300,
  /** Free one copied PTE in exec, when the child drops the copy. */
  pteFreeNs: 10,
  /** Create the task with a shared address space (the clone inside posix_spawn). */
  spawnUs: 40,
  /** execve itself, up to the new program's first instruction. */
  execUs: 150,
  /** One copy-on-write fault with a 4 KiB copy. */
  cowFaultNs: 1500,
} as const;

/** The number of page table pages at the lowest level for a dense mapping of `n` entries. */
export const ptPages = (entries: number) => Math.ceil(entries / PT_FANOUT);

/** Page tables for a dense mapping of rss bytes with the given page size. Includes the level above, once. */
export function pageTables(rss: number, pageSize: number) {
  const entries = Math.ceil(rss / pageSize);
  const leaf = ptPages(entries);
  const upper = ptPages(leaf);
  return { entries, leafPages: leaf, upperPages: upper, bytes: (leaf + upper) * PAGE_4K };
}

/** Time for fork in microseconds, on a dense private anonymous mapping. */
export function forkUs(rss: number, huge = false): number {
  const f = FORK_INPUTS;
  const t = pageTables(rss, huge ? PAGE_2M : PAGE_4K);
  return f.baseUs + (t.entries * (huge ? f.pmdNs : f.pteNs) + (t.leafPages + t.upperPages) * f.ptPageNs) / 1000;
}

/** fork followed by exec: the child frees all the entries that fork just copied. */
export function forkExecUs(rss: number, huge = false): number {
  const f = FORK_INPUTS;
  const t = pageTables(rss, huge ? PAGE_2M : PAGE_4K);
  return forkUs(rss, huge) + (t.entries * f.pteFreeNs) / 1000 + f.execUs;
}

/** posix_spawn on Linux: the child shares the address space until exec, so no page table copy runs. */
export const spawnUs = (_rss: number) => FORK_INPUTS.spawnUs + FORK_INPUTS.execUs;

/** The later cost in the parent when it writes `share` of its 4 KiB pages after fork. */
export const cowUs = (rss: number, share: number) => (Math.ceil(rss / PAGE_4K) * share * FORK_INPUTS.cowFaultNs) / 1000;
