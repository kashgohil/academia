/**
 * The path of one system call on Linux x86-64, as register snapshots, and a cost model.
 * The stepper runs write(1, "hi", 2) through entry, table lookup, the copy from user memory, and the return.
 */

/** Real syscall numbers (arch/x86/entry/syscalls/syscall_64.tbl and asm-generic/unistd.h). arm64 has no fork or open. */
export const SYSCALL_NR = {
  x86: { read: 0, write: 1, open: 2, close: 3, mmap: 9, getpid: 39, clone: 56, fork: 57, vfork: 58, execve: 59, exit: 60, wait4: 61, exit_group: 231 },
  arm: { read: 63, write: 64, close: 57, mmap: 222, getpid: 172, clone: 220, execve: 221, exit: 93, wait4: 260, exit_group: 94, openat: 56 },
} as const;

/** A part of the table, for display. */
export const TABLE_EXCERPT: { nr: number; name: string }[] = [
  { nr: 0, name: "sys_read" }, { nr: 1, name: "sys_write" }, { nr: 2, name: "sys_open" }, { nr: 3, name: "sys_close" },
];

export const ERRNO = { EBADF: 9, EFAULT: 14, ENOSYS: 38 } as const;
/** The kernel returns -1 to -4095 for errors. The C library turns these into -1 and errno. */
export const MAX_ERRNO = 4095;

export const isErrorReturn = (rax: number) => rax < 0 && rax >= -MAX_ERRNO;

/** What the C library wrapper gives to the caller. */
export function libcView(rax: number): { ret: number; errno: number } {
  return isErrorReturn(rax) ? { ret: -1, errno: -rax } : { ret: rax, errno: 0 };
}

export type WriteVariant = "ok" | "badfd" | "kernelptr" | "unmapped" | "badnr";

export const VARIANT_LABEL: Record<WriteVariant, string> = {
  ok: "write(1, msg, 2)",
  badfd: "write(99, msg, 2)",
  kernelptr: "write(1, kernel address, 2)",
  unmapped: "write(1, unmapped address, 2)",
  badnr: "syscall number 1000",
};

export type Regs = Record<"rax" | "rdi" | "rsi" | "rdx" | "r10" | "r8" | "r9" | "rcx" | "r11" | "rip" | "rsp", string>;
export const REG_ORDER: (keyof Regs)[] = ["rax", "rdi", "rsi", "rdx", "r10", "r8", "r9", "rcx", "r11", "rip", "rsp"];

export type Pane = "user" | "entry" | "table" | "copy" | "return";

export interface SysSnap {
  title: string;
  text: string;
  mode: "user" | "kernel";
  pane: Pane;
  regs: Regs;
  changed: string[];
  /** Page table in CR3 when KPTI is on. */
  cr3: "user" | "kernel";
  /** The table row in use. */
  tableNr?: number;
  /** Bytes copied into the kernel so far. */
  kernelBuf: string;
  /** Bytes shown on the terminal so far. */
  output: string;
  /** SMAP window open. */
  ac: boolean;
  /** Final value of rax, as a signed number, once the kernel has it. */
  ret?: number;
}

export const MSG_ADDR = 0x402010;
const USER_RIP = 0x401000;
const SYSCALL_RIP = USER_RIP + 22;
const USER_RSP = "0x7ffd0000";
const KERNEL_RSP = "0xffffc90000f0ff58";
const ENTRY = "entry_SYSCALL_64";
const hex = (n: number) => `0x${n.toString(16)}`;
const signed = (n: number) => (n < 0 ? `${n}` : hex(n));

/**
 * Builds the snapshots. `kpti` adds the page table switches.
 * rcx and r11 hold garbage before the call. The CPU overwrites them.
 */
export function writeSteps(variant: WriteVariant = "ok", kpti = true): SysSnap[] {
  const out: SysSnap[] = [];
  const buf = variant === "kernelptr" ? "0xffff888000000000" : variant === "unmapped" ? "0x10" : hex(MSG_ADDR);
  const fd = variant === "badfd" ? 99 : 1;
  const nr = variant === "badnr" ? 1000 : SYSCALL_NR.x86.write;
  const regs: Regs = { rax: "0x7", rdi: "0x8", rsi: "0x9", rdx: "0xa", r10: "0xb", r8: "0xc", r9: "0xd", rcx: "0xe", r11: "0xf", rip: hex(USER_RIP), rsp: USER_RSP };
  let mode: SysSnap["mode"] = "user", cr3: SysSnap["cr3"] = "user", kernelBuf = "", output = "", ac = false;
  let ret: number | undefined;
  const push = (title: string, text: string, pane: Pane, patch: Partial<Regs> = {}, tableNr?: number) => {
    const changed = Object.entries(patch).filter(([k, v]) => regs[k as keyof Regs] !== v).map(([k]) => k);
    Object.assign(regs, patch);
    out.push({ title, text, mode, pane, regs: { ...regs }, changed, cr3, tableNr, kernelBuf, output, ac, ret });
  };

  push("Before the call", "The program is in user mode. The registers hold old values.", "user");
  push("Load the arguments", `The number goes in rax. The arguments go in rdi, rsi and rdx. A libc wrapper does the same work.`, "user",
    { rax: hex(nr), rdi: hex(fd), rsi: buf, rdx: hex(2), rip: hex(SYSCALL_RIP) });

  mode = "kernel";
  push("syscall", "The CPU saves the next rip in rcx and RFLAGS in r11. It sets ring 0 and jumps to the address in MSR_LSTAR. It does not change rsp.", "entry",
    { rcx: hex(SYSCALL_RIP + 2), r11: "0x246", rip: ENTRY });
  if (kpti) {
    cr3 = "kernel";
    push("Switch the page table", "swapgs finds the per-CPU data. KPTI: until now the CPU used a small user page table with only the entry code. A write to CR3 brings in the full kernel mapping.", "entry", { rip: `${ENTRY}+0x12` });
  }
  push("Switch the stack", `${kpti ? "" : "swapgs finds the per-CPU data. "}The code loads this task's kernel stack, and it pushes all user registers as struct pt_regs.`, "entry",
    { rsp: KERNEL_RSP, rip: "do_syscall_64" });

  if (variant === "badnr") {
    ret = -ERRNO.ENOSYS;
    push("Look up the number", `${nr} is not in the table, so the kernel returns -ENOSYS (-38) with no other work.`, "table", { rax: signed(ret), rip: "do_syscall_64" }, nr);
  } else {
    push("Look up the number", "rax is 1, so the kernel selects the write entry. It checks the range first, and it masks the index against speculation.", "table", { rip: "__x64_sys_write" }, 1);
    if (variant === "badfd") {
      ret = -ERRNO.EBADF;
      push("Find the file", "ksys_write looks up fd 99 in this task's fd table. The slot is empty, so the result is -EBADF (-9).", "table", { rax: signed(ret), rip: "ksys_write" }, 1);
    } else {
      push("Find the file", "ksys_write looks up fd 1 in this task's fd table, and it finds the terminal. It calls vfs_write.", "copy", { rip: "vfs_write" }, 1);
      if (variant === "kernelptr") {
        ret = -ERRNO.EFAULT;
        push("Check the pointer", "access_ok sees that the buffer is above the user half. The user may not name kernel memory, so the result is -EFAULT (-14).", "copy", { rax: signed(ret), rip: "vfs_write" }, 1);
      } else {
        push("Check the pointer", "access_ok sees that the buffer and its length stay in the user half. This check is cheap. It does not prove that the page exists.", "copy", { rip: "vfs_write" }, 1);
        ac = true;
        push("Open the SMAP window", "stac sets EFLAGS.AC, so that this code may touch user pages for a moment.", "copy", { rip: "copy_from_user" }, 1);
        if (variant === "unmapped") {
          ac = false;
          ret = -ERRNO.EFAULT;
          push("The copy faults", "No page is at this address. The page fault handler finds the fix-up entry for this instruction in the exception table, so the copy stops with -EFAULT (-14). The kernel survives.", "copy", { rax: signed(ret), rip: "vfs_write" }, 1);
        } else {
          kernelBuf = "hi";
          push("Copy from user memory", "The kernel copies 2 bytes into its own buffer. Now another user thread cannot change the data under the driver.", "copy", { rip: "copy_from_user" }, 1);
          ac = false;
          push("Close the SMAP window", "clac clears EFLAGS.AC. A stray pointer into user memory faults again.", "copy", { rip: "copy_from_user" }, 1);
          output = "hi";
          ret = 2;
          push("Do the work", "The terminal driver takes the bytes. vfs_write returns 2, the count of bytes written. It can be less than the request.", "copy", { rax: hex(2), rip: "vfs_write" }, 1);
        }
      }
    }
  }

  push("Check for other work", "syscall_exit_to_user_mode checks the thread flags. A signal or a reschedule request runs here. This run has neither.", "return", { rip: "syscall_exit_to_user_mode" });
  if (kpti) {
    cr3 = "user";
    push("Switch the page table back", "KPTI: a write to CR3 removes the kernel mapping again, just before the return.", "return", { rip: `${ENTRY}+0x130` });
  }
  mode = "user";
  push("sysretq", "The CPU loads rip from rcx and RFLAGS from r11, and it sets ring 3. The code restores rsp and the other registers. rcx and r11 keep the values that the CPU wrote.", "user",
    { rip: hex(SYSCALL_RIP + 2), rsp: USER_RSP });
  return out;
}

// ---------------------------------------------------------------------------- cost model

export interface Mitigations {
  /** KPTI: two CR3 writes per call. */
  kpti: boolean;
  /** PCID: CR3 writes keep TLB entries. Only matters with KPTI. */
  pcid: boolean;
  /** Indirect branch mitigations on entry. */
  spectre: boolean;
  /** MDS: clear CPU buffers with verw on the way out. */
  mds: boolean;
}

/** MODEL INPUTS in nanoseconds: round figures of the right size, not measurements of one CPU. */
export const COST_INPUTS = {
  /** syscall, sysret and the C entry and exit code, for an empty call such as getpid. */
  baseNs: 60,
  /** Two CR3 writes with PCID. */
  kptiCr3Ns: 70,
  /** Extra TLB refills per call when KPTI has no PCID. */
  kptiNoPcidNs: 200,
  /** Indirect branch mitigations. */
  spectreNs: 40,
  /** verw buffer clear. */
  mdsNs: 30,
  /** vDSO clock_gettime: a user-mode function call, a seqlock read and rdtsc. */
  vdsoNs: 20,
} as const;

export const NO_MITIGATIONS: Mitigations = { kpti: false, pcid: true, spectre: false, mds: false };
export const ALL_MITIGATIONS: Mitigations = { kpti: true, pcid: true, spectre: true, mds: true };

/** The direct cost of an empty syscall. */
export function syscallNs(m: Mitigations): number {
  const c = COST_INPUTS;
  return c.baseNs + (m.kpti ? c.kptiCr3Ns + (m.pcid ? 0 : c.kptiNoPcidNs) : 0) + (m.spectre ? c.spectreNs : 0) + (m.mds ? c.mdsNs : 0);
}

/** Mitigations do not touch the vDSO path: it has no mode change. */
export const vdsoNs = () => COST_INPUTS.vdsoNs;

/** Calls per second in a loop with `workNs` of user work between calls. `refillNs` is the later cost of cold caches and TLBs. */
export const syscallRate = (workNs: number, m: Mitigations, refillNs = 0) => 1e9 / (workNs + syscallNs(m) + refillNs);
export const vdsoRate = (workNs: number) => 1e9 / (workNs + vdsoNs());

/** The share of one CPU that goes to `rate` empty syscalls per second. */
export const cpuShare = (rate: number, m: Mitigations, refillNs = 0) => Math.min(1, (rate * (syscallNs(m) + refillNs)) / 1e9);
