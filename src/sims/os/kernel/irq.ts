/**
 * Interrupt entry at stack level, and a fault cascade model.
 *
 * `entrySnaps` shows the frame that the CPU pushes, what the stub saves, and what iretq takes back.
 * It uses real addresses, so the alignment rules are visible.
 *
 * `cascade` delivers an exception the way the CPU does: read the gate, find the stack, push the frame. Each of
 * these can raise a second exception. The rules in `secondException` decide between serial handling, #DF and shutdown.
 */
import { VEC, excInfo, secondException } from "./x86";

// ---------------------------------------------------------------- the frame

/** Bytes that the CPU pushes in 64-bit mode: ss, rsp, rflags, cs, rip. */
export const FRAME_BYTES = 5 * 8;
export const ERROR_CODE_BYTES = 8;
export const VECTOR_BYTES = 8;
/** The stub saves 15 general registers. rsp is not one of them: it is in the frame. */
export const SAVED_REGS = ["rax", "rcx", "rdx", "rbx", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"] as const;
export const SAVED_BYTES = SAVED_REGS.length * 8;
/** The whole TrapFrame: 15 registers, vector, error code, CPU frame. */
export const TRAP_FRAME_BYTES = SAVED_BYTES + VECTOR_BYTES + ERROR_CODE_BYTES + FRAME_BYTES;

export interface StackRow { addr: bigint; label: string; value: string; who: "cpu" | "stub" | "pad" }

export interface EntryOpts {
  from: "user" | "kernel";
  /** The vector has a CPU error code, such as #PF. */
  errorCode: boolean;
  gate: "interrupt" | "trap";
  /** A wrong stub: true means it treats the frame as if the error code were the opposite of what the CPU did. */
  quirkBug: boolean;
}

export interface EntrySnap {
  title: string;
  text: string;
  phase: "before" | "cpu" | "stub" | "handler" | "restore" | "after" | "fault";
  rsp: bigint;
  rip: string;
  cs: string;
  rflags: string;
  ifFlag: boolean;
  ring: number;
  stack: StackRow[];
  /** The stack that rsp is on. */
  stackName: string;
  /** A bad outcome, for the banner. */
  bad?: boolean;
}

const USER_RSP = 0x00007ffffffee008n;
const USER_RIP = 0x0000000000401042n;
const KERNEL_RSP = 0xffffc90000003f38n;
const KERNEL_RIP = 0xffffffff80012340n;
export const RSP0 = 0xffffc90000004000n;
const hex = (v: bigint) => v.toString(16);
const ISR = "isr_stub";

/** Steps through one interrupt, from the instruction before it to the instruction after iretq. */
export function entrySnaps(o: EntryOpts): EntrySnap[] {
  const out: EntrySnap[] = [];
  const user = o.from === "user";
  const oldRsp = user ? USER_RSP : KERNEL_RSP;
  const oldRip = user ? USER_RIP : KERNEL_RIP;
  const oldCs = user ? "0x23" : "0x08";
  const oldSs = user ? "0x1B" : "0x10";
  const oldFlags = "0x202";
  const stack: StackRow[] = [];
  let rsp = oldRsp, rip = `0x${hex(oldRip)}`, cs = oldCs, flags = oldFlags, ifFlag = true, ring = user ? 3 : 0;
  const name = () => (user && rsp === oldRsp ? "user stack" : "kernel stack");
  const snap = (title: string, text: string, phase: EntrySnap["phase"], bad?: boolean) => out.push({ title, text, phase, rsp, rip, cs, rflags: flags, ifFlag, ring, stack: stack.map((r) => ({ ...r })), stackName: name(), bad });
  const push = (label: string, value: string, who: StackRow["who"]) => { rsp -= 8n; stack.push({ addr: rsp, label, value, who }); };

  snap("Before the interrupt", user ? "A user program runs. It uses its own stack." : "Kernel code runs on a kernel stack. This stack pointer is not aligned to 16 bytes.", "before");

  const base = user ? RSP0 : KERNEL_RSP & ~0xfn;
  rsp = base;
  ring = 0;
  snap(user ? "Find the stack: TSS.RSP0" : "Keep the stack, and align it", user
    ? "The gate has CS with DPL 0, and the CPL was 3, so the privilege changes. The CPU loads rsp from TSS.RSP0, and it aligns rsp to 16 bytes. The user stack is not trusted, and it is not used."
    : "No privilege change, so no stack switch. In 64-bit mode the CPU still aligns rsp down to 16 bytes before it pushes.", "cpu");
  push("ss", oldSs, "cpu");
  push("rsp", `0x${hex(oldRsp)}`, "cpu");
  push("rflags", oldFlags, "cpu");
  push("cs", oldCs, "cpu");
  push("rip", `0x${hex(oldRip)}`, "cpu");
  if (o.gate === "interrupt") { ifFlag = false; flags = "0x002"; }
  snap("The CPU pushes the frame", `Five values, ${FRAME_BYTES} bytes. In 64-bit mode ss and rsp are always pushed. ${o.gate === "interrupt" ? "This is an interrupt gate, so the CPU clears IF." : "This is a trap gate, so IF stays set."} It also clears TF and NT.`, "cpu");
  if (o.errorCode) {
    push("error code", user ? "0x0006" : "0x0002", "cpu");
    snap("The CPU pushes an error code", "This vector has an error code. The handler must remove it before iretq, because iretq does not know about it.", "cpu");
  }
  rip = ISR;
  cs = "0x08";
  const stubThinksError = o.quirkBug ? !o.errorCode : o.errorCode;
  if (!stubThinksError) {
    push("dummy error code", "0", "stub");
    if (o.errorCode) snap("Wrong stub: an extra dummy", "This stub was written for a vector with no error code. It pushes a dummy, but the CPU already pushed an error code. The frame is one slot too long.", "stub", true);
    else snap("The stub pushes a dummy", "The CPU pushed no error code for this vector. The stub pushes 0, so that every frame has one shape.", "stub");
  } else if (!o.errorCode) {
    snap("Wrong stub: no dummy", "This stub was written for a vector with an error code. It pushes no dummy, so the frame is one slot short.", "stub", true);
  }
  push("vector", o.errorCode ? "14" : "32", "stub");
  for (const r of SAVED_REGS) push(r, user ? "user value" : "kernel value", "stub");
  snap("The stub saves the registers", `The stub pushes the vector and ${SAVED_REGS.length} registers (${SAVED_BYTES} bytes). Now rsp points to a complete struct TrapFrame${stack.length * 8 === TRAP_FRAME_BYTES ? `, ${TRAP_FRAME_BYTES} bytes` : ""}.`, "stub", o.quirkBug);
  rip = "handle_trap";
  snap("Rust handles it", "The stub passes rsp as the first argument: mov rdi, rsp. Then it calls handle_trap(&mut TrapFrame). The handler can read and change every saved value. For an IRQ, it must also send EOI.", "handler");
  rip = ISR;
  for (let i = 0; i < SAVED_REGS.length; i++) { rsp += 8n; stack.pop(); }
  snap("The stub restores the registers", "Pops run in reverse order. Each register gets back its value, including any change that the handler made.", "restore");
  // The stub removes vector and error code: always 16 bytes.
  rsp += 16n;
  stack.pop(); // vector
  stack.pop(); // the slot under the vector: the error code, the dummy, or (wrong stub) the saved rip
  if (stubThinksError !== o.errorCode) {
    const top = stack[stack.length - 1]!;
    rip = top.value;
    if (!o.errorCode) snap("add rsp, 16 removes too much", `The stub removes 16 bytes as always, but only 8 of them were its own. It removed the saved rip. Now rsp points to the saved cs, so iretq reads ${top.value} as rip, and rflags as cs. The CS check fails and raises #GP.`, "fault", true);
    else snap("add rsp, 16 removes too little", "The stub removes its dummy and the vector, but the CPU's error code stays. Now rsp points to that error code, so iretq reads it as rip, and the saved rip as cs. The CS check fails and raises #GP.", "fault", true);
    return out;
  }
  snap("The stack is back at the frame", "The stub runs add rsp, 16 to remove the vector and the error code. Now rsp points to the saved rip, as iretq expects.", "restore");
  for (let i = 0; i < 5; i++) { rsp += 8n; stack.pop(); }
  rsp = oldRsp;
  rip = `0x${hex(oldRip)}`;
  cs = oldCs;
  flags = oldFlags;
  ifFlag = true;
  ring = user ? 3 : 0;
  snap("iretq", user ? "iretq pops rip, cs, rflags, rsp and ss. CS has RPL 3, so the CPU returns to ring 3. rsp is the user stack again, and it is exact." : "iretq pops all five values. rsp returns to its old value, not to the aligned one. The interrupted code cannot see the visit.", "after");
  return out;
}

// ---------------------------------------------------------------- fault cascade

export interface CascadeCfg {
  /** lidt ran with a full table. Otherwise the limit is 0. */
  idtLoaded: boolean;
  gatePF: boolean;
  /** #GP and #NP gates. */
  gateGP: boolean;
  gateDF: boolean;
  /** The #DF gate has IST = 1. */
  dfIst: boolean;
  /** ltr ran with a valid TSS whose RSP0 and IST1 are set. */
  tss: boolean;
}

export const GOOD_CFG: CascadeCfg = { idtLoaded: true, gatePF: true, gateGP: true, gateDF: true, dfIst: true, tss: true };

export type Trigger = "null-deref" | "div-zero" | "stack-overflow" | "bug-in-handler" | "user-irq" | "pic-timer";

export const TRIGGER_LABEL: Record<Trigger, string> = {
  "null-deref": "Kernel reads address 0",
  "div-zero": "Kernel divides by zero",
  "stack-overflow": "Kernel stack overflows into its guard page",
  "bug-in-handler": "#PF handler itself reads address 0",
  "user-irq": "Timer IRQ while a user task runs",
  "pic-timer": "Timer IRQ with the PIC not remapped",
};

export type CascadeOutcome = "handled" | "double" | "triple" | "misdiagnosed";

export interface CascadeEvent {
  kind: "raise" | "gate" | "stack" | "push" | "handler" | "rule" | "shutdown" | "note";
  text: string;
  bad?: boolean;
}

export interface CascadeResult { events: CascadeEvent[]; outcome: CascadeOutcome; handlerRuns: number; deepest: number }

/** MODEL INPUTS. */
export const STACK_MODEL = {
  /** Linux uses 16 KiB kernel stacks on x86-64. The model uses the same size. */
  stackBytes: 16 * 1024,
  /** Stack in use when the fault occurs. */
  usedBytes: 1024,
  /** A handler's own locals and calls, above the TrapFrame. */
  handlerBytes: 256,
} as const;

const gateFor = (cfg: CascadeCfg, v: number): boolean => {
  if (v === VEC.PF) return cfg.gatePF;
  if (v === VEC.GP || v === VEC.NP) return cfg.gateGP;
  if (v === VEC.DF) return cfg.gateDF;
  return true; // other gates are always installed in this model
};

const nameOf = (v: number) => excInfo(v).mnemonic;

export function cascade(cfg: CascadeCfg, trig: Trigger): CascadeResult {
  const ev: CascadeEvent[] = [];
  const add = (kind: CascadeEvent["kind"], text: string, bad?: boolean) => ev.push({ kind, text, bad });
  const S = STACK_MODEL;
  // Free bytes on the current stack. Pushing past 0 hits the guard page.
  let free = trig === "stack-overflow" ? 0 : S.stackBytes - S.usedBytes;
  let istFree = 4096;
  let runs = 0, deepest = 0;

  type Ctx = { fromUser: boolean };
  /** One delivery attempt. Returns the exception that it raised, or null if the handler now runs. */
  const tryDeliver = (v: number, c: Ctx): number | null => {
    const m = nameOf(v);
    if (!cfg.idtLoaded) { add("gate", `IDT limit is 0, so reading the gate for ${m} raises #GP.`, true); return VEC.GP; }
    if (!gateFor(cfg, v)) { add("gate", `The gate for ${m} has P = 0, so the CPU raises #NP.`, true); return VEC.NP; }
    add("gate", `The gate for ${m} is present.`);
    const useIst = v === VEC.DF && cfg.dfIst;
    if (useIst || c.fromUser) {
      if (!cfg.tss) { add("stack", `The CPU needs ${useIst ? "TSS.IST1" : "TSS.RSP0"}, but TR holds no valid TSS. It raises #TS.`, true); return VEC.TS; }
      add("stack", useIst ? "IST = 1: the CPU loads rsp from TSS.IST1, a separate good stack." : "The privilege changes: the CPU loads rsp from TSS.RSP0.");
      if (useIst) {
        if (istFree < 48) return VEC.PF;
        istFree -= 48;
        add("push", "The push on the IST stack works.");
        return null;
      }
      c.fromUser = false;
      free = S.stackBytes - 48;
      add("push", "The push on the kernel stack works.");
      return null;
    }
    add("stack", "IST = 0 and no privilege change: the CPU keeps the current stack.");
    const need = excInfo(v).errorCode ? 48 : 40;
    if (free < need) { add("push", `The push of ${need} bytes hits the guard page. This is a #PF during delivery of ${m}.`, true); return VEC.PF; }
    free -= need;
    add("push", `The ${need}-byte frame fits on the stack.`);
    return null;
  };

  /** Follows one exception until a handler runs or the CPU shuts down. Returns the vector whose handler runs, or -1. */
  const deliver = (first: number, c: Ctx): number => {
    let v = first;
    for (let guard = 0; guard < 16; guard++) {
      const second = tryDeliver(v, c);
      if (second === null) return v;
      add("raise", `${nameOf(second)} arrives while the CPU delivers ${nameOf(v)}.`, true);
      const rule = secondException(v, second);
      if (rule === "triple") { add("shutdown", `${nameOf(v)}, then ${nameOf(second)}: triple fault. The CPU enters shutdown, and the board resets.`, true); return -1; }
      if (rule === "double") { add("rule", `${excInfo(v).cls === "page" ? "Page fault" : "Contributory"} class, then ${excInfo(second).cls === "page" ? "page fault" : "contributory"} class: the CPU raises #DF.`, true); v = VEC.DF; continue; }
      add("rule", `This pair is handled serially: the CPU forgets ${nameOf(v)} and delivers ${nameOf(second)}.`);
      v = second;
    }
    throw new Error("cascade did not end");
  };

  const finish = (v: number): CascadeOutcome => {
    if (v < 0) return "triple";
    runs++;
    if (v === VEC.DF) { add("handler", "The #DF handler runs. It prints the state and halts. The kernel dies, but it dies with a message."); return "double"; }
    add("handler", `The ${nameOf(v)} handler runs. It prints the fault and panics, or it fixes the cause.`);
    return "handled";
  };

  switch (trig) {
    case "null-deref": case "stack-overflow": {
      add("raise", trig === "null-deref" ? "A load from address 0 raises #PF. CR2 = 0." : "A call pushes its return address into the guard page. This raises #PF.", trig === "stack-overflow");
      return { events: ev, outcome: finish(deliver(VEC.PF, { fromUser: false })), handlerRuns: runs, deepest };
    }
    case "div-zero": {
      add("raise", "div with a zero divisor raises #DE.");
      return { events: ev, outcome: finish(deliver(VEC.DE, { fromUser: false })), handlerRuns: runs, deepest };
    }
    case "user-irq": {
      add("raise", "The timer IRQ arrives at ring 3. It is benign class.");
      return { events: ev, outcome: finish(deliver(32, { fromUser: true })), handlerRuns: runs, deepest };
    }
    case "pic-timer": {
      add("raise", "The BIOS left the PIC with IRQ 0 at vector 8, the same vector as #DF. A timer tick looks up gate 8.");
      // A hardware interrupt is benign class, even at vector 8. Only the gate is the same.
      const second = tryDeliver(VEC.DF, { fromUser: false });
      if (second === null) {
        runs++;
        add("handler", "The #DF handler runs, and it reports a double fault. No fault happened. The CPU pushed no error code, so the handler reads rip as the error code.", true);
        return { events: ev, outcome: "misdiagnosed", handlerRuns: runs, deepest };
      }
      add("raise", `${nameOf(second)} arrives. An external interrupt is benign class, so this is handled serially.`, true);
      return { events: ev, outcome: finish(deliver(second, { fromUser: false })), handlerRuns: runs, deepest };
    }
    case "bug-in-handler": {
      add("raise", "A load from address 0 raises #PF.");
      let v = deliver(VEC.PF, { fromUser: false });
      // Each handler run faults again. That is a new exception each time, because the handler has started.
      let reported = false;
      while (v === VEC.PF) {
        runs++;
        deepest++;
        const body = S.handlerBytes + 128; // TrapFrame registers and vector, then the handler's own stack
        if (free < body) { free = 0; } else free -= body;
        if (!reported) {
          add("handler", "The #PF handler starts, and reads address 0. The handler has started, so this is a new #PF and not a #DF.");
          reported = true;
        }
        const before = ev.length;
        v = deliver(VEC.PF, { fromUser: false });
        // Keep the log short: drop the repeats of a normal delivery.
        if (v === VEC.PF) ev.length = before;
      }
      if (reported) ev.splice(ev.findIndex((e) => e.kind === "handler") + 1, 0, { kind: "note", text: `The same thing repeats ${deepest} times, and each level uses more stack.` });
      if (v < 0) return { events: ev, outcome: "triple", handlerRuns: runs, deepest };
      return { events: ev, outcome: finish(v), handlerRuns: runs, deepest };
    }
  }
}

/** All configurations of the six switches. */
export function allCfgs(): CascadeCfg[] {
  const out: CascadeCfg[] = [];
  for (let m = 0; m < 64; m++) out.push({ idtLoaded: !!(m & 1), gatePF: !!(m & 2), gateGP: !!(m & 4), gateDF: !!(m & 8), dfIst: !!(m & 16), tss: !!(m & 32) });
  return out;
}

export const ALL_TRIGGERS: Trigger[] = ["null-deref", "div-zero", "stack-overflow", "bug-in-handler", "user-irq", "pic-timer"];
