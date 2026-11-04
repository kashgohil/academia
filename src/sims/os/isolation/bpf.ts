/**
 * Classic BPF for seccomp: the real instruction encoding, the kernel's validity checks, an interpreter with a
 * step-by-step trace, an assembler-style disassembler and a small rule compiler.
 * A filter sees only struct seccomp_data: nr, arch, instruction_pointer and six 64-bit arguments.
 * It cannot follow a pointer. Jumps go only forward, so every filter ends.
 */
export interface Insn { code: number; jt: number; jf: number; k: number }

export const BPF = {
  LD_W_ABS: 0x20, LD_W_MEM: 0x60, LD_IMM: 0x00, LDX_IMM: 0x01, LDX_MEM: 0x61, ST: 0x02, STX: 0x03,
  ALU_ADD_K: 0x04, ALU_SUB_K: 0x14, ALU_AND_K: 0x54, ALU_OR_K: 0x44, ALU_LSH_K: 0x64, ALU_RSH_K: 0x74,
  JA: 0x05, JEQ_K: 0x15, JGT_K: 0x25, JGE_K: 0x35, JSET_K: 0x45,
  RET_K: 0x06, RET_A: 0x16, TAX: 0x07, TXA: 0x87,
} as const;

/** BPF_MAXINSNS for one program. */
export const BPF_MAXINSNS = 4096;
/** MAX_INSNS_PER_PATH: the limit over all stacked filters of a task (each filter also counts 4). */
export const MAX_INSNS_PER_PATH = 32768;
export const SECCOMP_DATA_SIZE = 64;
export const BPF_MEMWORDS = 16;

export const SECCOMP_RET = {
  KILL_PROCESS: 0x80000000, KILL_THREAD: 0x00000000, TRAP: 0x00030000, ERRNO: 0x00050000,
  USER_NOTIF: 0x7fc00000, TRACE: 0x7ff00000, LOG: 0x7ffc0000, ALLOW: 0x7fff0000,
} as const;
export const SECCOMP_RET_ACTION_FULL = 0xffff0000;
export const SECCOMP_RET_DATA = 0x0000ffff;
export const AUDIT_ARCH = { X86_64: 0xc000003e, AARCH64: 0xc00000b7 } as const;
/** x32 system calls on x86-64 have this bit set in nr. A filter must reject it or it can miss a call. */
export const X32_SYSCALL_BIT = 0x40000000;
export const ERRNO = { EPERM: 1, EACCES: 13, ENOSYS: 38 } as const;

/** Offsets in struct seccomp_data. On a little-endian CPU, the low word of args[i] is at 16 + 8i. */
export const OFF = { nr: 0, arch: 4, ipLo: 8, ipHi: 12, argLo: (i: number) => 16 + 8 * i, argHi: (i: number) => 20 + 8 * i } as const;

export interface SeccompData { nr: number; arch: number; ip?: bigint; args?: readonly bigint[] }

/** The bytes of struct seccomp_data, as 32-bit words, by byte offset. */
function loadWord(d: SeccompData, off: number): number {
  if (off === 0) return d.nr >>> 0;
  if (off === 4) return d.arch >>> 0;
  const part = (v: bigint, hi: boolean) => Number((hi ? v >> 32n : v) & 0xffffffffn);
  if (off === 8 || off === 12) return part(d.ip ?? 0n, off === 12);
  const i = Math.floor((off - 16) / 8);
  return part(d.args?.[i] ?? 0n, off % 8 === 4);
}

const KNOWN = new Set<number>(Object.values(BPF));
const isJump = (c: number) => c === BPF.JA || c === BPF.JEQ_K || c === BPF.JGT_K || c === BPF.JGE_K || c === BPF.JSET_K;

/** bpf_check_classic and seccomp_check_filter. It returns null, or the reason for EINVAL. */
export function validate(prog: readonly Insn[]): string | null {
  if (prog.length === 0 || prog.length > BPF_MAXINSNS) return `A program must have 1 to ${BPF_MAXINSNS} instructions.`;
  for (let pc = 0; pc < prog.length; pc++) {
    const { code, jt, jf, k } = prog[pc]!;
    if (!KNOWN.has(code)) return `pc ${pc}: seccomp does not allow opcode 0x${code.toString(16)}.`;
    if (code === BPF.LD_W_ABS && (k >= SECCOMP_DATA_SIZE || k % 4 !== 0 || k < 0)) return `pc ${pc}: a load must be aligned and inside seccomp_data.`;
    if ((code === BPF.LD_W_MEM || code === BPF.LDX_MEM || code === BPF.ST || code === BPF.STX) && (k < 0 || k >= BPF_MEMWORDS)) return `pc ${pc}: scratch index out of range.`;
    if (code === BPF.JA) {
      if (k < 0 || pc + 1 + k >= prog.length) return `pc ${pc}: the jump goes past the end.`;
    } else if (isJump(code)) {
      if (jt < 0 || jf < 0 || jt > 255 || jf > 255) return `pc ${pc}: a conditional jump offset must fit in 8 bits.`;
      if (pc + 1 + jt >= prog.length || pc + 1 + jf >= prog.length) return `pc ${pc}: the jump goes past the end.`;
    }
  }
  // check_load_and_stores: a scratch word must be written on every path before a read.
  const masks = new Array<number>(prog.length).fill(0xffff);
  let valid = 0;
  for (let pc = 0; pc < prog.length; pc++) {
    valid &= masks[pc]!;
    const { code, jt, jf, k } = prog[pc]!;
    if (code === BPF.ST || code === BPF.STX) valid |= 1 << k;
    else if ((code === BPF.LD_W_MEM || code === BPF.LDX_MEM) && !(valid & (1 << k))) return `pc ${pc}: reads scratch word ${k} before a write.`;
    else if (code === BPF.JA) { masks[pc + 1 + k] = masks[pc + 1 + k]! & valid; valid = 0xffff; }
    else if (isJump(code)) { masks[pc + 1 + jt] = masks[pc + 1 + jt]! & valid; masks[pc + 1 + jf] = masks[pc + 1 + jf]! & valid; valid = 0xffff; }
  }
  const last = prog[prog.length - 1]!.code;
  if (last !== BPF.RET_K && last !== BPF.RET_A) return "The last instruction must be a return.";
  return null;
}

export interface TraceStep { pc: number; insn: Insn; text: string; a: number; x: number; note: string; nextPc: number | null }
export interface RunResult { ret: number; action: ActionName; data: number; steps: TraceStep[] }

export type ActionName = "kill_process" | "kill_thread" | "trap" | "errno" | "user_notif" | "trace" | "log" | "allow";
/** Decodes a return value, as the kernel does in __seccomp_filter. An unknown value counts as kill_process. */
export function actionOf(ret: number): ActionName {
  switch ((ret & SECCOMP_RET_ACTION_FULL) >>> 0) {
    case SECCOMP_RET.KILL_THREAD: return "kill_thread";
    case SECCOMP_RET.TRAP: return "trap";
    case SECCOMP_RET.ERRNO: return "errno";
    case SECCOMP_RET.USER_NOTIF: return "user_notif";
    case SECCOMP_RET.TRACE: return "trace";
    case SECCOMP_RET.LOG: return "log";
    case SECCOMP_RET.ALLOW: return "allow";
    default: return "kill_process";
  }
}

/** Precedence over stacked filters: the lowest action wins. KILL_PROCESS is the strongest. */
export const ACTION_RANK: ActionName[] = ["kill_process", "kill_thread", "trap", "errno", "user_notif", "trace", "log", "allow"];
export const strongest = (a: ActionName, b: ActionName): ActionName => (ACTION_RANK.indexOf(a) <= ACTION_RANK.indexOf(b) ? a : b);

const u32 = (v: number) => v >>> 0;

/** Runs a valid program. It throws if the program is not valid. */
export function run(prog: readonly Insn[], d: SeccompData): RunResult {
  const err = validate(prog);
  if (err) throw new Error(err);
  let a = 0, x = 0, pc = 0;
  const mem = new Array<number>(BPF_MEMWORDS).fill(0);
  const steps: TraceStep[] = [];
  for (;;) {
    const insn = prog[pc]!;
    const { code, jt, jf, k } = insn;
    const text = disasm(insn, pc);
    let next = pc + 1;
    let note = "";
    switch (code) {
      case BPF.LD_W_ABS: a = loadWord(d, k); note = `A = ${hex(a)}`; break;
      case BPF.LD_W_MEM: a = mem[k]!; note = `A = ${hex(a)}`; break;
      case BPF.LD_IMM: a = u32(k); note = `A = ${hex(a)}`; break;
      case BPF.LDX_IMM: x = u32(k); note = `X = ${hex(x)}`; break;
      case BPF.LDX_MEM: x = mem[k]!; note = `X = ${hex(x)}`; break;
      case BPF.ST: mem[k] = a; note = `M[${k}] = ${hex(a)}`; break;
      case BPF.STX: mem[k] = x; note = `M[${k}] = ${hex(x)}`; break;
      case BPF.ALU_ADD_K: a = u32(a + k); note = `A = ${hex(a)}`; break;
      case BPF.ALU_SUB_K: a = u32(a - k); note = `A = ${hex(a)}`; break;
      case BPF.ALU_AND_K: a = u32(a & k); note = `A = ${hex(a)}`; break;
      case BPF.ALU_OR_K: a = u32(a | k); note = `A = ${hex(a)}`; break;
      case BPF.ALU_LSH_K: a = u32(k >= 32 ? 0 : a << k); note = `A = ${hex(a)}`; break;
      case BPF.ALU_RSH_K: a = u32(k >= 32 ? 0 : a >>> k); note = `A = ${hex(a)}`; break;
      case BPF.TAX: x = a; note = `X = ${hex(x)}`; break;
      case BPF.TXA: a = x; note = `A = ${hex(a)}`; break;
      case BPF.JA: next = pc + 1 + k; note = `jump to ${next}`; break;
      case BPF.JEQ_K: case BPF.JGT_K: case BPF.JGE_K: case BPF.JSET_K: {
        const ku = u32(k);
        const hit = code === BPF.JEQ_K ? a === ku : code === BPF.JGT_K ? a > ku : code === BPF.JGE_K ? a >= ku : u32(a & ku) !== 0;
        next = pc + 1 + (hit ? jt : jf);
        note = `${hit ? "true" : "false"}: go to ${next}`;
        break;
      }
      case BPF.RET_K: case BPF.RET_A: {
        const ret = u32(code === BPF.RET_K ? k : a);
        const action = actionOf(ret);
        steps.push({ pc, insn, text, a, x, note: `verdict: ${action}${action === "errno" ? ` (${ret & SECCOMP_RET_DATA})` : ""}`, nextPc: null });
        return { ret, action, data: ret & SECCOMP_RET_DATA, steps };
      }
    }
    steps.push({ pc, insn, text, a, x, note, nextPc: next });
    pc = next;
  }
}

/** Runs stacked filters, as the kernel does: every filter runs, and the strongest action wins. */
export function runStack(filters: readonly (readonly Insn[])[], d: SeccompData): ActionName {
  return filters.map((f) => run(f, d).action).reduce(strongest, "allow" as ActionName);
}

export const hex = (v: number) => `0x${u32(v).toString(16)}`;

const OFF_NAME = (k: number) => k === 0 ? "nr" : k === 4 ? "arch" : k === 8 ? "ip" : k === 12 ? "ip_hi" : `args[${Math.floor((k - 16) / 8)}]${k % 8 === 4 ? "_hi" : ""}`;

const RET_TEXT = (k: number) => {
  const a = actionOf(u32(k));
  const name = a.toUpperCase();
  return a === "errno" ? `ERRNO(${u32(k) & SECCOMP_RET_DATA})` : name;
};

/** One line of bpf_asm-style text. */
export function disasm(i: Insn, pc: number): string {
  const { code, jt, jf, k } = i;
  const t = pc + 1 + jt, f = pc + 1 + jf;
  switch (code) {
    case BPF.LD_W_ABS: return `ld  [${k}]  ; ${OFF_NAME(k)}`;
    case BPF.LD_W_MEM: return `ld  M[${k}]`;
    case BPF.LD_IMM: return `ld  #${hex(k)}`;
    case BPF.LDX_IMM: return `ldx #${hex(k)}`;
    case BPF.LDX_MEM: return `ldx M[${k}]`;
    case BPF.ST: return `st  M[${k}]`;
    case BPF.STX: return `stx M[${k}]`;
    case BPF.ALU_ADD_K: return `add #${hex(k)}`;
    case BPF.ALU_SUB_K: return `sub #${hex(k)}`;
    case BPF.ALU_AND_K: return `and #${hex(k)}`;
    case BPF.ALU_OR_K: return `or  #${hex(k)}`;
    case BPF.ALU_LSH_K: return `lsh #${k}`;
    case BPF.ALU_RSH_K: return `rsh #${k}`;
    case BPF.TAX: return "tax";
    case BPF.TXA: return "txa";
    case BPF.JA: return `ja  ${pc + 1 + k}`;
    case BPF.JEQ_K: return `jeq #${k > 9999 ? hex(k) : k}, ${t}, ${f}`;
    case BPF.JGT_K: return `jgt #${k > 9999 ? hex(k) : k}, ${t}, ${f}`;
    case BPF.JGE_K: return `jge #${k > 9999 ? hex(k) : k}, ${t}, ${f}`;
    case BPF.JSET_K: return `jset #${hex(k)}, ${t}, ${f}`;
    case BPF.RET_K: return `ret ${RET_TEXT(k)}`;
    case BPF.RET_A: return "ret a";
    default: return `.word ${hex(code)}`;
  }
}

// ---------------- a small rule compiler ----------------

export type RuleAction = { kind: "allow" } | { kind: "errno"; errno: number } | { kind: "trap" } | { kind: "kill" } | { kind: "notify" } | { kind: "log" };
export const retOf = (a: RuleAction): number => {
  switch (a.kind) {
    case "allow": return SECCOMP_RET.ALLOW;
    case "errno": return (SECCOMP_RET.ERRNO | (a.errno & SECCOMP_RET_DATA)) >>> 0;
    case "trap": return SECCOMP_RET.TRAP;
    case "kill": return SECCOMP_RET.KILL_PROCESS;
    case "notify": return SECCOMP_RET.USER_NOTIF;
    case "log": return SECCOMP_RET.LOG;
  }
};

export interface ArgCheck { arg: number; op: "eq" | "ne" | "set"; value: number }
export interface Rule { nr: number; action: RuleAction; /** If it is set, the rule applies only when the 32-bit low word of the argument passes. */ when?: ArgCheck }
export interface FilterSpec { arch?: number; rules: readonly Rule[]; fallback: RuleAction }

const ins = (code: number, k: number, jt = 0, jf = 0): Insn => ({ code, jt, jf, k });

/**
 * Compiles rules to a program, in the libseccomp shape: check arch, load nr, then one block per rule.
 * The first rule that matches wins. A wrong arch kills the process.
 */
export function compile(spec: FilterSpec): Insn[] {
  const arch = spec.arch ?? AUDIT_ARCH.X86_64;
  const p: Insn[] = [
    ins(BPF.LD_W_ABS, OFF.arch),
    ins(BPF.JEQ_K, arch, 1, 0),
    ins(BPF.RET_K, SECCOMP_RET.KILL_PROCESS),
    ins(BPF.LD_W_ABS, OFF.nr),
  ];
  if (arch === AUDIT_ARCH.X86_64) {
    // nr >= X32_SYSCALL_BIT: an x32 call. Reject it, or it could slip past the numbers below.
    p.push(ins(BPF.JGE_K, X32_SYSCALL_BIT, 0, 1), ins(BPF.RET_K, SECCOMP_RET.KILL_PROCESS));
  }
  for (const r of spec.rules) {
    if (!r.when) {
      p.push(ins(BPF.JEQ_K, r.nr, 0, 1), ins(BPF.RET_K, retOf(r.action)));
      continue;
    }
    // jeq nr; ld arg; test; ret; ld nr again
    const { arg, op, value } = r.when;
    const test = op === "set" ? ins(BPF.JSET_K, value, 0, 1) : op === "eq" ? ins(BPF.JEQ_K, value, 0, 1) : ins(BPF.JEQ_K, value, 1, 0);
    p.push(
      ins(BPF.JEQ_K, r.nr, 0, 4),
      ins(BPF.LD_W_ABS, OFF.argLo(arg)),
      test,
      ins(BPF.RET_K, retOf(r.action)),
      ins(BPF.LD_W_ABS, OFF.nr),
    );
  }
  p.push(ins(BPF.RET_K, retOf(spec.fallback)));
  return p;
}

/** What the rules mean, with no BPF. It must agree with `run(compile(spec), d)`. */
export function evalSpec(spec: FilterSpec, d: SeccompData): number {
  const arch = spec.arch ?? AUDIT_ARCH.X86_64;
  if (d.arch >>> 0 !== arch) return SECCOMP_RET.KILL_PROCESS;
  if (arch === AUDIT_ARCH.X86_64 && d.nr >>> 0 >= X32_SYSCALL_BIT) return SECCOMP_RET.KILL_PROCESS;
  for (const r of spec.rules) {
    if (r.nr !== d.nr) continue;
    if (r.when) {
      const low = Number((d.args?.[r.when.arg] ?? 0n) & 0xffffffffn);
      const ok = r.when.op === "set" ? u32(low & r.when.value) !== 0 : r.when.op === "eq" ? low === u32(r.when.value) : low !== u32(r.when.value);
      if (!ok) continue;
    }
    return retOf(r.action);
  }
  return retOf(spec.fallback);
}

/** SECCOMP_MODE_STRICT: the only calls allowed, on x86-64. Any other call ends the process with SIGKILL. */
export const STRICT_MODE_NRS = { read: 0, write: 1, exit: 60, rt_sigreturn: 15 } as const;
export const strictModeAllows = (nr: number) => (Object.values(STRICT_MODE_NRS) as number[]).includes(nr);
