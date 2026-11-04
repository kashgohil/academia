/**
 * The syscall entry path, register by register: syscall, swapgs, the stack switch, the handler and sysretq.
 * Toggles remove one safety step, to show what it protects.
 */
import { SEL, TINY_SFMASK, TINY_STAR, sysretSelectors, syscallSelectors } from "./x86";

export interface SysEntryRegs {
  rip: string; rsp: string; rcx: string; r11: string; rflags: string; cs: string; ss: string; gsBase: string; kernelGsBase: string; rax: string;
}
export const SYS_ENTRY_REGS: (keyof SysEntryRegs)[] = ["rip", "rsp", "rcx", "r11", "rflags", "cs", "ss", "gsBase", "kernelGsBase", "rax"];

export interface SysEntryOpts {
  /** The entry code runs swapgs. */
  swapgs: boolean;
  /** SFMASK clears IF on syscall. */
  maskIf: boolean;
}

export interface SysEntrySnap {
  title: string;
  text: string;
  ring: 0 | 3;
  regs: SysEntryRegs;
  changed: (keyof SysEntryRegs)[];
  asm: string;
  bad?: boolean;
}

const USER_GS = "0x00007f0000001000";
const PERCPU = "0xffffffff80200000";
const USER_RSP = "0x00007fffffffe000";
const KSTACK = "0xffffffffc0003000";
const hx = (n: number, w = 4) => `0x${n.toString(16).padStart(w, "0")}`;
const USER_RFLAGS = 0x202;

export function sysEntrySnaps(o: SysEntryOpts): SysEntrySnap[] {
  const out: SysEntrySnap[] = [];
  const entry = syscallSelectors(TINY_STAR), ret = sysretSelectors(TINY_STAR);
  const r: SysEntryRegs = { rip: "0x00000000004000d2", rsp: USER_RSP, rcx: "garbage", r11: "garbage", rflags: hx(USER_RFLAGS), cs: hx(SEL.UCODE), ss: hx(SEL.UDATA), gsBase: USER_GS, kernelGsBase: PERCPU, rax: "1" };
  let ring: 0 | 3 = 3;
  const push = (title: string, text: string, asm: string, patch: Partial<SysEntryRegs> = {}, bad?: boolean) => {
    const changed = (Object.keys(patch) as (keyof SysEntryRegs)[]).filter((k) => r[k] !== patch[k]);
    Object.assign(r, patch);
    out.push({ title, text, asm, ring, regs: { ...r }, changed, bad });
  };
  push("User code loads the arguments", "rax holds the number. rdi, rsi and rdx hold the arguments. The next instruction is syscall. Ring 3, on the user stack.", "mov eax, 1");
  ring = 0;
  const masked = o.maskIf ? (USER_RFLAGS & ~TINY_SFMASK) | 2 : USER_RFLAGS;
  push("syscall", `The CPU saves rip in rcx and rflags in r11. It loads rip from LSTAR, CS = ${hx(entry.cs)} and SS = ${hx(entry.ss)} from STAR, and it clears the flags in SFMASK. It does not touch rsp or GS. It writes nothing to memory.`, "syscall", {
    rip: "syscall_entry", rcx: "0x00000000004000d4", r11: hx(USER_RFLAGS), rflags: hx(masked), cs: hx(entry.cs), ss: hx(entry.ss),
  });
  if (!o.maskIf) {
    push("A timer IRQ arrives on the user stack", "IF is still 1, and the CPU is in ring 0. No privilege change means no stack switch. The CPU pushes its frame on the user's rsp. Another user thread can read and change kernel data there, or rsp can be a wild address.", "; IRQ", { rsp: "0x00007fffffffdfd8" }, true);
    r.rsp = USER_RSP;
  }
  if (o.swapgs) {
    push("swapgs", "The CPU swaps GS base with KERNEL_GS_BASE. Now gs: points to this CPU's kernel data. The user's GS base waits in the MSR.", "swapgs", { gsBase: PERCPU, kernelGsBase: USER_GS, rip: "syscall_entry+3" });
  }
  push("Save the user stack pointer", o.swapgs ? "The kernel has no free register yet, so it stores rsp in per-CPU data." : `No swapgs ran, so gs: is still the user's value ${USER_GS}. This store writes to an address that the user chose, and the next load reads a kernel rsp that the user chose.`, "mov gs:[8], rsp", { rip: "syscall_entry+12" }, !o.swapgs);
  push("Load the kernel stack", o.swapgs ? "rsp now points to the top of this task's kernel stack. The context switch code keeps this per-CPU value correct." : "rsp now holds a value from user memory. The kernel runs on a stack that the attacker controls.", "mov rsp, gs:[0]", { rsp: o.swapgs ? KSTACK : "user-controlled", rip: "syscall_entry+21" }, !o.swapgs);
  if (!o.swapgs) return out;
  const f = (r.rsp = KSTACK, "0xffffffffc0002fb0");
  push("Save registers and call Rust", "The stub pushes the user rsp, rcx, r11 and the other registers. It calls handle_syscall with a pointer to them. Interrupts can turn on after this point, because the stack is safe.", "push ...; call handle_syscall", { rsp: f, rip: "handle_syscall" });
  push("The handler returns", "rax holds the return value. Here write returned 5. The stub pops the registers in reverse order.", "pop ...", { rax: "5", rsp: KSTACK, rip: "syscall_entry+80" });
  push("Back to the user stack", "The stub reloads rsp from its saved copy. No interrupt may arrive between this and sysretq, so IF stays 0 here.", "mov rsp, [saved rsp]", { rsp: USER_RSP, rip: "syscall_entry+88" });
  push("swapgs", "The user's GS base comes back, and KERNEL_GS_BASE holds the kernel value for the next entry.", "swapgs", { gsBase: USER_GS, kernelGsBase: PERCPU, rip: "syscall_entry+91" });
  ring = 3;
  push("sysretq", `The CPU loads rip from rcx and rflags from r11, and it sets CS = ${hx(ret.cs)} and SS = ${hx(ret.ss)}. rcx and r11 keep their values, so a program must treat them as clobbered. A non-canonical rcx raises #GP in ring 0 on Intel CPUs, so check it first.`, "sysretq", {
    rip: "0x00000000004000d4", rflags: hx(USER_RFLAGS), cs: hx(ret.cs), ss: hx(ret.ss),
  });
  return out;
}

