/**
 * What clone shares, flag by flag, and the memory cost of threads and goroutines.
 * Flag values are the real ones from include/uapi/linux/sched.h.
 */

export const CLONE = {
  VM: 0x100, FS: 0x200, FILES: 0x400, SIGHAND: 0x800, VFORK: 0x4000, THREAD: 0x10000,
  SYSVSEM: 0x40000, SETTLS: 0x80000, PARENT_SETTID: 0x100000, CHILD_CLEARTID: 0x200000,
} as const;
export const SIGCHLD = 17;

/** The flags that glibc's pthread_create passes to clone (strace shows them). */
export const PTHREAD_FLAGS = CLONE.VM | CLONE.FS | CLONE.FILES | CLONE.SIGHAND | CLONE.THREAD | CLONE.SYSVSEM | CLONE.SETTLS | CLONE.PARENT_SETTID | CLONE.CHILD_CLEARTID;
export const FORK_FLAGS = SIGCHLD;

/** The kernel's rules in copy_process. It returns null, or the reason for EINVAL. */
export function cloneError(flags: number): string | null {
  if (flags & CLONE.THREAD && !(flags & CLONE.SIGHAND)) return "CLONE_THREAD needs CLONE_SIGHAND: all threads of one process share signal handlers.";
  if (flags & CLONE.SIGHAND && !(flags & CLONE.VM)) return "CLONE_SIGHAND needs CLONE_VM: a handler is an address, and it must mean the same thing in both tasks.";
  return null;
}

export type ResourceId = "memory" | "files" | "fs" | "sighand" | "group";

export interface Resource { id: ResourceId; flag: number; flagName: string; name: string; kernel: string }

/** Resources that a clone flag can share, with the task_struct field that points at each. */
export const RESOURCES: Resource[] = [
  { id: "memory", flag: CLONE.VM, flagName: "CLONE_VM", name: "Address space", kernel: "mm" },
  { id: "files", flag: CLONE.FILES, flagName: "CLONE_FILES", name: "Fd table", kernel: "files" },
  { id: "fs", flag: CLONE.FS, flagName: "CLONE_FS", name: "Working directory", kernel: "fs" },
  { id: "sighand", flag: CLONE.SIGHAND, flagName: "CLONE_SIGHAND", name: "Signal handlers", kernel: "sighand" },
  { id: "group", flag: CLONE.THREAD, flagName: "CLONE_THREAD", name: "Thread group (PID)", kernel: "signal, tgid" },
];

/** Always private to each task, whatever the flags. */
export const ALWAYS_PRIVATE = ["registers", "kernel stack", "TID", "signal mask", "scheduling state", "TLS block"];

export interface TaskPair {
  flags: number;
  /** The value of x as each task sees it. */
  x: [number, number];
  /** Open fds beyond 0, 1, 2. */
  fds: [number[], number[]];
  cwd: [string, string];
  handler: [string, string];
  /** What getpid and gettid return. */
  pid: [number, number];
  tid: [number, number];
  alive: [boolean, boolean];
  /** Does the parent need wait for this child? */
  needsWait: boolean;
  log: string;
}

/** Two tasks after clone(flags). Task 0 is the caller. */
export function newPair(flags: number): TaskPair {
  const thread = (flags & CLONE.THREAD) !== 0;
  return {
    flags, x: [7, 7], fds: [[], []], cwd: ["/home", "/home"], handler: ["default", "default"],
    pid: [1000, thread ? 1000 : 1001], tid: [1000, 1001], alive: [true, true], needsWait: !thread,
    log: "clone returned. Task A is the caller, and task B is the new task.",
  };
}

const shares = (p: TaskPair, f: number) => (p.flags & f) !== 0;

export function writeX(p: TaskPair, who: 0 | 1, v: number): TaskPair {
  const n = { ...p, x: [...p.x] as [number, number] };
  n.x[who] = v;
  if (shares(p, CLONE.VM)) n.x[1 - who as 0 | 1] = v;
  n.log = shares(p, CLONE.VM)
    ? `${"AB"[who]} writes x = ${v}. They share one mm, so ${"AB"[1 - who]} reads ${v} with no system call.`
    : `${"AB"[who]} writes x = ${v}. The page is copy-on-write, so ${"AB"[1 - who]} keeps its old value.`;
  return n;
}

export function openFd(p: TaskPair, who: 0 | 1): TaskPair {
  const n = { ...p, fds: [[...p.fds[0]], [...p.fds[1]]] as [number[], number[]] };
  const fd = 3 + n.fds[who].length;
  n.fds[who].push(fd);
  if (shares(p, CLONE.FILES)) n.fds[1 - who as 0 | 1].push(fd);
  n.log = shares(p, CLONE.FILES)
    ? `${"AB"[who]} opens fd ${fd}. They share one fd table, so ${"AB"[1 - who]} can use fd ${fd} at once.`
    : `${"AB"[who]} opens fd ${fd}. Each task has its own table, so fd ${fd} does not exist in ${"AB"[1 - who]}.`;
  return n;
}

export function chdir(p: TaskPair, who: 0 | 1, path: string): TaskPair {
  const n = { ...p, cwd: [...p.cwd] as [string, string] };
  n.cwd[who] = path;
  if (shares(p, CLONE.FS)) n.cwd[1 - who as 0 | 1] = path;
  n.log = shares(p, CLONE.FS)
    ? `${"AB"[who]} calls chdir. Relative paths change in both tasks.`
    : `${"AB"[who]} calls chdir. ${"AB"[1 - who]} keeps its own working directory.`;
  return n;
}

export function sigaction(p: TaskPair, who: 0 | 1, h: string): TaskPair {
  const n = { ...p, handler: [...p.handler] as [string, string] };
  n.handler[who] = h;
  if (shares(p, CLONE.SIGHAND)) n.handler[1 - who as 0 | 1] = h;
  n.log = shares(p, CLONE.SIGHAND)
    ? `${"AB"[who]} installs a handler. It applies to both tasks.`
    : `${"AB"[who]} installs a handler. ${"AB"[1 - who]} keeps the old one.`;
  return n;
}

/** exit_group from one task. */
export function exitGroup(p: TaskPair, who: 0 | 1): TaskPair {
  const n = { ...p, alive: [...p.alive] as [boolean, boolean] };
  n.alive[who] = false;
  if (shares(p, CLONE.THREAD)) {
    n.alive[1 - who as 0 | 1] = false;
    n.log = `${"AB"[who]} calls exit_group. Both tasks are in one thread group, so both die.`;
  } else {
    n.log = `${"AB"[who]} calls exit_group. ${"AB"[1 - who]} is another process, so it keeps running.`;
  }
  return n;
}

// ---------------------------------------------------------------------------- memory for many tasks

/** Facts about real defaults. */
export const STACK = {
  /** The usual RLIMIT_STACK, which glibc uses as the default thread stack size. */
  glibcDefaultBytes: 8 * 1024 * 1024,
  /** Rust's std::thread default. */
  rustDefaultBytes: 2 * 1024 * 1024,
  /** macOS default for secondary threads. */
  macSecondaryBytes: 512 * 1024,
  /** THREAD_SIZE on x86-64 and arm64: 16 KiB of kernel stack for each task. */
  kernelStackBytes: 16 * 1024,
  /** A goroutine's minimum stack (_StackMin). */
  goMinBytes: 2 * 1024,
  /** The default limit that debug.SetMaxStack sets on 64-bit systems. */
  goMaxBytes: 1024 * 1024 * 1024,
  /** Default of /proc/sys/vm/max_map_count. */
  maxMapCount: 65530,
  /** The default size of a guard page. */
  guardBytes: 4096,
};

/** MODEL INPUTS: round figures of the right size. */
export const TASK_INPUTS = {
  /** task_struct and friends in the kernel, per thread. */
  taskStructBytes: 8 * 1024,
  /** User stack pages that a typical thread touches. */
  touchedStackBytes: 8 * 1024,
  /** The g struct and scheduler data per goroutine. */
  goStructBytes: 500,
  /** Stack actually used by a goroutine that needs only the minimum. */
  goStackBytes: 2 * 1024,
  /** One suspended async task (a Rust future on the heap, or similar). */
  asyncTaskBytes: 512,
  /** Creation and start, on one CPU, in microseconds. */
  forkUs: 60,
  threadUs: 15,
  goroutineUs: 0.3,
};

export interface TaskMemory { virtualBytes: number; residentBytes: number }

export const threadMemory = (n: number, stackBytes = STACK.glibcDefaultBytes): TaskMemory => ({
  virtualBytes: n * (stackBytes + STACK.guardBytes),
  residentBytes: n * (TASK_INPUTS.touchedStackBytes + STACK.kernelStackBytes + TASK_INPUTS.taskStructBytes),
});
export const goroutineMemory = (n: number): TaskMemory => {
  const b = n * (TASK_INPUTS.goStackBytes + TASK_INPUTS.goStructBytes);
  return { virtualBytes: b, residentBytes: b };
};
export const asyncMemory = (n: number): TaskMemory => {
  const b = n * TASK_INPUTS.asyncTaskBytes;
  return { virtualBytes: b, residentBytes: b };
};

/** Each thread stack plus its guard page is two VMAs, so this bounds thread count at the default setting. */
export const threadsAtMapLimit = (maxMapCount = STACK.maxMapCount) => Math.floor(maxMapCount / 2);
