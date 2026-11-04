/**
 * A real verifier for the eBPF subset. It follows the design of kernel/bpf/verifier.c:
 *
 * 1. Load checks and a control-flow pass (`check_cfg`): jumps stay in range, no unreachable code, the last instruction
 *    is an exit or a jump.
 * 2. A walk of every path (`do_check`) with abstract register state. A conditional jump can fork the walk.
 *    At each jump target, the walk compares its state with saved states (`is_state_visited`):
 *    - the same state as a state still on this path means a loop that makes no progress: reject;
 *    - a state contained in a finished safe state is safe too: stop this path (pruning).
 *
 * Why accepted programs stop: a pruned path joins a state that finished earlier, so the states form a graph with no
 * cycle. A real run follows one path in this graph, so it takes at most `processed` steps. The tests check this.
 *
 * Most messages follow the kernel's text, which changes a little between versions. The differences from Linux are in `SUBSET_LIMITS`.
 */
import { BPF, HELPERS, PT_REGS, SIZE_BYTES, STACK_SIZE, XDP_MD, formatInsn, type BpfProgram, type HelperId, type Insn } from "./bpfIsa";
import {
  CMP_NEGATE, branchKnown, fmtScalar, refine, scalarAlu, scalarBits, scalarConst, scalarEq, scalarIn, scalarIsConst, scalarUnknown, syncBounds, trunc32, u64,
  type CmpName, type Scalar,
} from "./bpfScalar";
import { ALU_NAME, CMP_NAME } from "./bpfVm";

/** BPF_MAX_VAR_OFF: a larger variable offset is refused. */
export const BPF_MAX_VAR_OFF = 1n << 29n;
/** MAX_PACKET_OFF in the kernel. */
export const MAX_PACKET_OFF = 0xffffn;
/** The Linux limit on instructions processed in one load, since Linux 5.2. */
export const LINUX_COMPLEXITY_LIMIT = 1_000_000;
/** The limit of this browser sim, so that a bad program answers at once. It is much lower than the Linux limit. */
export const SIM_COMPLEXITY_LIMIT = 20_000;
/** BPF_COMPLEXITY_LIMIT_JMP_SEQ in the kernel: paths that wait for the walk. */
export const JMP_SEQ_LIMIT = 8192;

export const SUBSET_LIMITS = [
  "No BPF-to-BPF calls, tail calls, spin locks, kfuncs or BTF types.",
  "A stack pointer must have a constant offset. Linux allows some variable offsets.",
  "The leak rules always apply. Linux relaxes them for a loader with CAP_PERFMON.",
  "32-bit bounds are not separate from 64-bit bounds, so a 32-bit compare narrows less than in Linux.",
  "There is no liveness or precision tracking, so pruning happens less often than in Linux.",
  "The walk limit is 20,000 instructions. Linux uses 1,000,000.",
] as const;

export type Reg =
  | { k: "none" }
  | { k: "scalar"; s: Scalar; id: number }
  | { k: "ctx"; off: number }
  | { k: "stack"; off: number }
  | { k: "map_ptr"; map: number }
  | { k: "map_value"; map: number; off: number; v: Scalar }
  | { k: "map_value_or_null"; map: number; id: number }
  | { k: "pkt"; off: number; v: Scalar; id: number; range: number }
  | { k: "pkt_end" };

/** One 8-byte stack slot. `mask` has a bit for each byte with a value. `spill` is a saved whole register. */
export interface Slot { mask: number; spill?: Reg }
export interface VState { regs: Reg[]; stack: (Slot | null)[] }

const NONE: Reg = { k: "none" };
const ZERO = (): Reg => ({ k: "scalar", s: scalarConst(0n), id: 0 });
const unknownReg = (): Reg => ({ k: "scalar", s: scalarUnknown(), id: 0 });

export function fmtReg(r: Reg, maps: { name: string }[] = []): string {
  const name = (m: number) => maps[m]?.name ?? String(m);
  const varPart = (v: Scalar) => (scalarIsConst(v) && v.umin === 0n ? "" : ` +${fmtScalar(v)}`);
  switch (r.k) {
    case "none": return "no value";
    case "scalar": return `scalar ${fmtScalar(r.s)}`;
    case "ctx": return r.off ? `ctx + ${r.off}` : "ctx";
    case "stack": return r.off === 0 ? "fp" : `fp${r.off < 0 ? "" : "+"}${r.off}`;
    case "map_ptr": return `map ${name(r.map)}`;
    case "map_value": return `map_value(${name(r.map)}) off=${r.off}${varPart(r.v)}`;
    case "map_value_or_null": return `map_value_or_null(${name(r.map)})`;
    case "pkt": return `pkt off=${r.off}${varPart(r.v)} r=${r.range}`;
    case "pkt_end": return "pkt_end";
  }
}
/** The type name that the kernel prints in messages. */
const typeName = (r: Reg) => (r.k === "none" ? "!read_ok" : r.k === "map_ptr" ? "map_ptr" : r.k === "stack" ? "fp" : r.k === "pkt" ? "pkt" : r.k === "pkt_end" ? "pkt_end" : r.k);

export type LogKind = "insn" | "fork" | "dead" | "prune" | "exit" | "pop" | "error" | "accept";
export interface LogEntry {
  kind: LogKind;
  pc: number;
  note: string;
  regs: Reg[];
  stack: (Slot | null)[];
  /** Registers that this step changed. */
  changed: number[];
  /** Paths that wait in the stack. */
  pending: number;
}

export interface VerifyOptions {
  /** Instructions that the walk may process. */
  limit?: number;
  /** Refuse any back-edge, as Linux did before 5.3. */
  noLoops?: boolean;
  /** Keep the state at each instruction, for tests. */
  record?: boolean;
  /** The most log entries to keep. */
  maxLog?: number;
}

export interface VerifyResult {
  ok: boolean;
  /** The kernel-style message, when rejected. */
  error?: string;
  /** The instruction that caused the rejection. */
  errorPc?: number;
  /** "load" for a pass before the walk. "walk" for the walk. */
  stage?: "load" | "walk";
  processed: number;
  pruned: number;
  forks: number;
  log: LogEntry[];
  /** Log entries that did not fit. */
  logDropped: number;
  statesAt?: Map<number, VState[]>;
}

// ---------------------------------------------------------------------------- load checks and control flow

const isLd64 = (i: Insn) => i.op === (BPF.LD | BPF.DW | BPF.IMM);

/** Field and opcode checks for one instruction. It returns a message, or null. */
function checkFields(i: Insn, pc: number, prog: BpfProgram): string | null {
  const cls = i.op & 7;
  const code = i.op & 0xf0;
  const isReg = (i.op & 8) !== 0;
  if (i.dst > 10) return `R${i.dst} is invalid`;
  if (i.src > 10 && !(isLd64(i))) return `R${i.src} is invalid`;
  if (cls === BPF.ALU || cls === BPF.ALU64) {
    if (code === BPF.MOV || code === BPF.NEG || ALU_NAME[code]) {
      if (code === BPF.NEG && (i.src !== 0 || i.off !== 0 || i.imm !== 0 || isReg)) return "BPF_NEG uses reserved fields";
      if (code !== BPF.NEG && isReg && (i.imm !== 0 || i.off !== 0)) return "BPF_ALU uses reserved fields";
      if (code !== BPF.NEG && !isReg && (i.src !== 0 || i.off !== 0)) return "BPF_ALU uses reserved fields";
      return null;
    }
    if (code === BPF.END && cls === BPF.ALU) {
      if (i.src !== 0 || i.off !== 0 || (i.imm !== 16 && i.imm !== 32 && i.imm !== 64)) return "BPF_END uses reserved fields";
      return null;
    }
    return `unknown opcode ${i.op.toString(16).padStart(2, "0")}`;
  }
  if (isLd64(i)) {
    if (i.off !== 0 || (i.src !== 0 && i.src !== BPF.PSEUDO_MAP_FD)) return "invalid bpf_ld_imm64 insn";
    const hi = prog.insns[pc + 1];
    if (!hi || !hi.filler || hi.op !== 0 || hi.dst !== 0 || hi.src !== 0 || hi.off !== 0) return "invalid bpf_ld_imm64 insn";
    if (i.src === BPF.PSEUDO_MAP_FD && !prog.maps[i.imm]) return `fd ${i.imm} is not pointing to valid bpf_map`;
    return null;
  }
  if (cls === BPF.LDX) {
    if ((i.op & 0xe0) !== BPF.MEM || i.imm !== 0) return i.imm !== 0 ? "BPF_LDX uses reserved fields" : `unknown opcode ${i.op.toString(16).padStart(2, "0")}`;
    return null;
  }
  if (cls === BPF.ST) {
    if ((i.op & 0xe0) !== BPF.MEM) return `unknown opcode ${i.op.toString(16).padStart(2, "0")}`;
    if (i.src !== 0) return "BPF_ST uses reserved fields";
    return null;
  }
  if (cls === BPF.STX) {
    const mode = i.op & 0xe0;
    if (mode === BPF.MEM) return i.imm !== 0 ? "BPF_STX uses reserved fields" : null;
    if (mode === BPF.ATOMIC) {
      if (i.imm !== BPF.ADD) return `BPF_ATOMIC uses invalid atomic opcode ${i.imm.toString(16).padStart(2, "0")}`;
      const sz = i.op & 0x18;
      if (sz !== BPF.W && sz !== BPF.DW) return "invalid atomic operand size";
      return null;
    }
    return `unknown opcode ${i.op.toString(16).padStart(2, "0")}`;
  }
  if (cls === BPF.JMP || cls === BPF.JMP32) {
    if (cls === BPF.JMP && code === BPF.EXIT) return i.imm !== 0 || i.off !== 0 || i.src !== 0 || i.dst !== 0 || isReg ? "BPF_EXIT uses reserved fields" : null;
    if (cls === BPF.JMP && code === BPF.CALL) {
      if (i.off !== 0 || i.src !== 0 || i.dst !== 0 || isReg) return "BPF_CALL uses reserved fields";
      return null;
    }
    if (cls === BPF.JMP && code === BPF.JA) return i.imm !== 0 || i.src !== 0 || i.dst !== 0 || isReg ? "BPF_JA uses reserved fields" : null;
    if (!CMP_NAME[code]) return `unknown opcode ${i.op.toString(16).padStart(2, "0")}`;
    if (isReg && i.imm !== 0) return "BPF_JMP/JMP32 uses reserved fields";
    if (!isReg && i.src !== 0) return "BPF_JMP/JMP32 uses reserved fields";
    return null;
  }
  return `unknown opcode ${i.op.toString(16).padStart(2, "0")}`;
}

const isJump = (i: Insn) => {
  const cls = i.op & 7, code = i.op & 0xf0;
  return (cls === BPF.JMP || cls === BPF.JMP32) && !(cls === BPF.JMP && (code === BPF.EXIT || code === BPF.CALL));
};
const isCond = (i: Insn) => isJump(i) && !((i.op & 7) === BPF.JMP && (i.op & 0xf0) === BPF.JA);
const isExit = (i: Insn) => (i.op & 7) === BPF.JMP && (i.op & 0xf0) === BPF.EXIT;

/** Return a message and the instruction, or null. Also returns the prune points through `prune`. */
function loadChecks(prog: BpfProgram, opts: VerifyOptions, prune: Set<number>): { pc: number; msg: string } | null {
  const n = prog.insns.length;
  if (n === 0) return { pc: 0, msg: "invalid program: no instructions" };
  for (const m of prog.maps) {
    if (m.keySize < 1 || m.valueSize < 1 || m.maxEntries < 1 || m.valueSize > 65536 || m.keySize > 512) return { pc: 0, msg: `map ${m.name}: invalid size` };
    if (m.kind === "array" && m.keySize !== 4) return { pc: 0, msg: `map ${m.name}: an array map needs a 4-byte key` };
  }
  for (let pc = 0; pc < n; pc++) {
    const i = prog.insns[pc]!;
    if (i.filler) continue;
    const msg = checkFields(i, pc, prog);
    if (msg) return { pc, msg };
  }
  // check_subprogs: each jump lands on a slot inside the program.
  for (let pc = 0; pc < n; pc++) {
    const i = prog.insns[pc]!;
    if (i.filler || !isJump(i)) continue;
    const to = pc + 1 + i.off;
    if (to < 0 || to >= n) return { pc, msg: `jump out of range from insn ${pc} to ${to}` };
  }
  const last = prog.insns[n - 1]!;
  if (!(isExit(last) || (isJump(last) && !isCond(last)))) return { pc: n - 1, msg: "last insn is not an exit or jmp" };

  // check_cfg: a depth-first search for unreachable code and back-edges.
  const state = new Uint8Array(n); // 0 unseen, 1 on the search stack, 2 done
  const succ = (pc: number): number[] => {
    const i = prog.insns[pc]!;
    if (isExit(i)) return [];
    if (isLd64(i)) return [pc + 2];
    if (!isJump(i)) return [pc + 1];
    const to = pc + 1 + i.off;
    return isCond(i) ? [pc + 1, to] : [to];
  };
  const stack: [number, number][] = [[0, 0]];
  state[0] = 1;
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    const nexts = succ(top[0]);
    if (top[1] >= nexts.length) {
      state[top[0]] = 2;
      stack.pop();
      continue;
    }
    const to = nexts[top[1]++]!;
    if (to >= n) return { pc: top[0], msg: `jump out of range from insn ${top[0]} to ${to}` };
    if (prog.insns[to]!.filler) return { pc: top[0], msg: `jump into the middle of ldimm64 insn ${to - 1}` };
    const i = prog.insns[top[0]]!;
    if (isJump(i)) {
      prune.add(to);
      if (isCond(i)) prune.add(top[0] + 1);
    }
    if (state[to] === 1) {
      if (opts.noLoops) return { pc: top[0], msg: `back-edge from insn ${top[0]} to ${to}` };
    } else if (state[to] === 0) {
      state[to] = 1;
      stack.push([to, 0]);
    }
  }
  for (let pc = 0; pc < n; pc++) {
    if (prog.insns[pc]!.filler) continue;
    if (state[pc] === 0) return { pc, msg: `unreachable insn ${pc}` };
  }
  return null;
}

// ---------------------------------------------------------------------------- state compare

function serialize(st: VState): string {
  const ids = new Map<number, number>();
  const idOf = (id: number) => {
    if (id === 0) return 0;
    let x = ids.get(id);
    if (x === undefined) { x = ids.size + 1; ids.set(id, x); }
    return x;
  };
  const sc = (s: Scalar) => `${s.umin},${s.umax},${s.smin},${s.smax},${s.t.v},${s.t.m}`;
  const reg = (r: Reg): string => {
    switch (r.k) {
      case "none": return "-";
      case "scalar": return `s${sc(r.s)}#${idOf(r.id)}`;
      case "ctx": return `c${r.off}`;
      case "stack": return `f${r.off}`;
      case "map_ptr": return `m${r.map}`;
      case "map_value": return `v${r.map},${r.off},${sc(r.v)}`;
      case "map_value_or_null": return `n${r.map}#${idOf(r.id)}`;
      case "pkt": return `p${r.off},${sc(r.v)},${r.range}#${idOf(r.id)}`;
      case "pkt_end": return "e";
    }
  };
  const parts = st.regs.map(reg);
  st.stack.forEach((sl, i) => {
    if (sl) parts.push(`${i}:${sl.mask}:${sl.spill ? reg(sl.spill) : ""}`);
  });
  return parts.join("|");
}

/** True when each concrete state in `cur` is also in `old`, so that the walk of `old` covers `cur`. */
function subsumes(old: VState, cur: VState): boolean {
  const idmap = new Map<number, number>();
  const ids = (a: number, b: number) => {
    if (a === 0) return true;
    if (b === 0) return false;
    const m = idmap.get(a);
    if (m === undefined) { idmap.set(a, b); return true; }
    return m === b;
  };
  const reg = (a: Reg, b: Reg): boolean => {
    if (a.k === "none") return true;
    if (a.k !== b.k) return false;
    switch (a.k) {
      case "scalar": return scalarIn(a.s, (b as typeof a).s) && ids(a.id, (b as typeof a).id);
      case "ctx": return a.off === (b as typeof a).off;
      case "stack": return a.off === (b as typeof a).off;
      case "map_ptr": return a.map === (b as typeof a).map;
      case "map_value": { const c = b as typeof a; return a.map === c.map && a.off === c.off && scalarIn(a.v, c.v); }
      case "map_value_or_null": { const c = b as typeof a; return a.map === c.map && ids(a.id, c.id); }
      case "pkt": { const c = b as typeof a; return a.off === c.off && a.range <= c.range && scalarIn(a.v, c.v) && ids(a.id, c.id); }
      case "pkt_end": return true;
    }
    return false;
  };
  for (let r = 0; r < 11; r++) if (!reg(old.regs[r]!, cur.regs[r]!)) return false;
  for (let i = 0; i < old.stack.length; i++) {
    const a = old.stack[i], b = cur.stack[i];
    if (!a) continue;
    if (!b || (a.mask & b.mask) !== a.mask) return false;
    if (a.spill) {
      if (!b.spill || !reg(a.spill, b.spill)) return false;
    } else if (b.spill && b.spill.k !== "scalar") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------- the walk

interface Checkpoint { pc: number; st: VState; parent: Checkpoint | null; branches: number }
interface Path { pc: number; st: VState; cp: Checkpoint }

class Reject extends Error {
  constructor(readonly pc: number, msg: string) { super(msg); }
}

const cloneState = (s: VState): VState => ({ regs: s.regs.slice(), stack: s.stack.slice() });

const slotIndex = (off: number) => Math.floor((-off - 1) / 8);

/** Walk every path of `prog`. See the top of this file. */
export function verify(prog: BpfProgram, opts: VerifyOptions = {}): VerifyResult {
  const limit = opts.limit ?? SIM_COMPLEXITY_LIMIT;
  const maxLog = opts.maxLog ?? 3000;
  const log: LogEntry[] = [];
  let logDropped = 0;
  let processed = 0, pruned = 0, forks = 0;
  const statesAt = opts.record ? new Map<number, VState[]>() : undefined;
  const res = (extra: Partial<VerifyResult> & { ok: boolean }): VerifyResult => ({ processed, pruned, forks, log, logDropped, statesAt, ...extra });

  const prune = new Set<number>();
  const initial: VState = { regs: new Array<Reg>(11).fill(NONE), stack: new Array<Slot | null>(STACK_SIZE / 8).fill(null) };
  initial.regs[1] = { k: "ctx", off: 0 };
  initial.regs[10] = { k: "stack", off: 0 };

  const bad = loadChecks(prog, opts, prune);
  if (bad) {
    log.push({ kind: "error", pc: bad.pc, note: bad.msg, regs: initial.regs, stack: initial.stack, changed: [], pending: 0 });
    return res({ ok: false, error: bad.msg, errorPc: bad.pc, stage: "load" });
  }

  let idGen = 0;
  const newId = () => ++idGen;
  const maps = prog.maps;
  const pending: Path[] = [];
  const keyAt = new Map<number, Map<string, Checkpoint>>();
  const doneAt = new Map<number, Checkpoint[]>();

  const emit = (e: Omit<LogEntry, "pending" | "regs" | "stack"> & { st: VState }) => {
    if (log.length >= maxLog) { logDropped++; return; }
    log.push({ kind: e.kind, pc: e.pc, note: e.note, changed: e.changed, regs: e.st.regs.slice(), stack: e.st.stack.slice(), pending: pending.length });
  };

  const root: Checkpoint = { pc: 0, st: cloneState(initial), parent: null, branches: 1 };
  let path: Path = { pc: 0, st: cloneState(initial), cp: root };

  const finishCheckpoints = (cp: Checkpoint) => {
    let c: Checkpoint | null = cp;
    while (c) {
      c.branches--;
      if (c.branches > 0) break;
      let list = doneAt.get(c.pc);
      if (!list) { list = []; doneAt.set(c.pc, list); }
      list.push(c);
      c = c.parent;
    }
  };

  // -- register helpers

  const readable = (st: VState, r: number, pc: number): Reg => {
    const v = st.regs[r]!;
    if (v.k === "none") throw new Reject(pc, `R${r} !read_ok`);
    return v;
  };
  const writeReg = (st: VState, r: number, v: Reg, pc: number) => {
    if (r === 10) throw new Reject(pc, "frame pointer is read only");
    st.regs[r] = v;
  };

  /** Apply `f` to a register and to all spilled copies. */
  const mapAllRegs = (st: VState, f: (r: Reg) => Reg) => {
    for (let r = 0; r < 11; r++) st.regs[r] = f(st.regs[r]!);
    st.stack = st.stack.map((sl) => (sl?.spill ? { ...sl, spill: f(sl.spill) } : sl));
  };

  // -- memory checks

  const checkStackBounds = (pc: number, base: number, off: number, size: number, what: string) => {
    if (off < -STACK_SIZE || off + size > 0 || off >= 0) throw new Reject(pc, `invalid ${what} stack R${base} off=${off} size=${size}`);
    if (off % size !== 0) throw new Reject(pc, `misaligned stack access off ${off} size ${size}`);
  };

  const checkMapAccess = (pc: number, base: number, r: Extract<Reg, { k: "map_value" }>, off: number, size: number) => {
    const valueSize = maps[r.map]!.valueSize;
    const start = BigInt(r.off + off);
    if (r.v.smin < 0n && r.v.smin + start < 0n) {
      throw new Reject(pc, `R${base} min value is negative, either use unsigned index or do a if (index >=0) check.`);
    }
    const lowOff = start + r.v.smin;
    if (lowOff < 0n || lowOff + BigInt(size) > BigInt(valueSize)) {
      throw new Reject(pc, `invalid access to map value, value_size=${valueSize} off=${lowOff} size=${size}`);
    }
    if (r.v.umax >= BPF_MAX_VAR_OFF) throw new Reject(pc, `R${base} unbounded memory access, make sure to bounds check any such access`);
    const highOff = start + r.v.umax;
    if (highOff + BigInt(size) > BigInt(valueSize)) {
      throw new Reject(pc, `invalid access to map value, value_size=${valueSize} off=${highOff} size=${size}`);
    }
  };

  const checkPktAccess = (pc: number, base: number, r: Extract<Reg, { k: "pkt" }>, off: number, size: number) => {
    const at = r.off + off;
    if (r.v.smin < 0n) throw new Reject(pc, `R${base} min value is negative, either use unsigned index or do a if (index >=0) check.`);
    if (at < 0 || at + size > r.range) {
      throw new Reject(pc, `invalid access to packet, off=${at} size=${size}, R${base}(id=${r.id},off=${r.off},r=${r.range})`);
    }
    if (r.v.umax > MAX_PACKET_OFF) throw new Reject(pc, `R${base} unbounded memory access, off=${off}`);
  };

  const ctxRead = (pc: number, r: Extract<Reg, { k: "ctx" }>, base: number, off: number, size: number): Reg => {
    if (r.off !== 0) throw new Reject(pc, `dereference of modified ctx ptr R${base} off=${r.off} disallowed`);
    const badAccess = () => new Reject(pc, `invalid bpf_context access off=${off} size=${size}`);
    if (prog.type === "xdp") {
      if (off < 0 || off + size > XDP_MD.size || size !== 4 || off % 4 !== 0) throw badAccess();
      if (off === XDP_MD.data) return { k: "pkt", off: 0, v: scalarConst(0n), id: 0, range: 0 };
      if (off === XDP_MD.data_end) return { k: "pkt_end" };
      return { k: "scalar", s: scalarBits(32), id: 0 };
    }
    if (off < 0 || off + size > PT_REGS.size || off % size !== 0) throw badAccess();
    return { k: "scalar", s: scalarBits(size * 8), id: 0 };
  };

  const stackRead = (st: VState, pc: number, off: number, size: number): Reg => {
    const i = slotIndex(off);
    const sl = st.stack[i];
    const first = off + (i + 1) * 8;
    const want = ((1 << size) - 1) << first;
    if (size === 8 && sl?.spill) return sl.spill;
    if (sl?.spill && sl.spill.k !== "scalar") throw new Reject(pc, "invalid size of register fill");
    if (!sl || (sl.mask & want) !== want) throw new Reject(pc, `invalid read from stack off ${off}+0 size ${size}`);
    return { k: "scalar", s: scalarBits(size * 8), id: 0 };
  };

  const stackWrite = (st: VState, pc: number, off: number, size: number, value: Reg, srcReg: number) => {
    const i = slotIndex(off);
    const old = st.stack[i];
    const first = off + (i + 1) * 8;
    if (size === 8) {
      st.stack[i] = { mask: 0xff, spill: value };
      return;
    }
    if (value.k !== "scalar") throw new Reject(pc, `R${srcReg} partial copy of pointer`);
    if (old?.spill && old.spill.k !== "scalar") throw new Reject(pc, "attempt to corrupt spilled pointer on stack");
    st.stack[i] = { mask: (old?.mask ?? 0) | (((1 << size) - 1) << first) };
  };

  // -- one instruction

  /** Pointer + or - scalar. `isSub` is for ptr - scalar. */
  const ptrAlu = (pc: number, dst: number, ptr: Reg, off: Reg & { k: "scalar" }, isSub: boolean): Reg => {
    const nm = typeName(ptr);
    if (ptr.k === "map_value_or_null") throw new Reject(pc, `R${dst} pointer arithmetic on ${nm} prohibited, null-check it first`);
    if (ptr.k === "map_ptr" || ptr.k === "pkt_end") throw new Reject(pc, `R${dst} pointer arithmetic on ${nm} prohibited`);
    const s = off.s;
    const known = scalarIsConst(s);
    const val = known ? (isSub ? -s.smin : s.smin) : 0n;
    if (known && (val >= BPF_MAX_VAR_OFF || val <= -BPF_MAX_VAR_OFF)) throw new Reject(pc, `value ${val} makes ${nm} pointer be out of bounds`);
    if (!known) {
      if (s.smin === -(1n << 63n)) throw new Reject(pc, `math between ${nm} pointer and register with unbounded min value is not allowed`);
      if (s.smin <= -BPF_MAX_VAR_OFF || s.smin >= BPF_MAX_VAR_OFF) throw new Reject(pc, `value ${s.smin} makes ${nm} pointer be out of bounds`);
    }
    switch (ptr.k) {
      case "ctx":
        if (!known) throw new Reject(pc, `variable ctx access var_off=${fmtScalar(s)} disallowed`);
        return { ...ptr, off: ptr.off + Number(val) };
      case "stack":
        if (!known) throw new Reject(pc, `R${dst} variable offset stack access is not in this subset`);
        return { ...ptr, off: ptr.off + Number(val) };
      case "map_value": {
        if (known) return { ...ptr, off: ptr.off + Number(val) };
        const v = scalarAlu(isSub ? "sub" : "add", ptr.v, s, false);
        return { ...ptr, v };
      }
      case "pkt": {
        if (known) return { ...ptr, off: ptr.off + Number(val) };
        // The kernel gives a new id and drops the checked range, because the checked range was for the old value.
        if (s.umax > MAX_PACKET_OFF) throw new Reject(pc, `value ${s.umax} makes pkt pointer be out of bounds`);
        const v = scalarAlu(isSub ? "sub" : "add", ptr.v, s, false);
        return { ...ptr, v, id: newId(), range: 0 };
      }
    }
    throw new Reject(pc, `R${dst} pointer arithmetic prohibited`);
  };

  const execAlu = (st: VState, i: Insn, pc: number): number[] => {
    const is32 = (i.op & 7) === BPF.ALU;
    const code = i.op & 0xf0;
    const isReg = (i.op & 8) !== 0;
    const opText = () => formatInsn(i).split(" ")[1] ?? "";
    if (code === BPF.END) {
      const d = readable(st, i.dst, pc);
      if (d.k !== "scalar") throw new Reject(pc, `R${i.dst} pointer arithmetic prohibited`);
      writeReg(st, i.dst, { k: "scalar", s: scalarBits(i.imm), id: 0 }, pc);
      return [i.dst];
    }
    const src: Reg = isReg ? readable(st, i.src, pc) : { k: "scalar", s: is32 ? scalarConst(BigInt(i.imm >>> 0)) : scalarConst(BigInt(i.imm)), id: 0 };
    if (code === BPF.MOV) {
      if (is32) {
        if (src.k !== "scalar") throw new Reject(pc, `R${i.src} partial copy of pointer`);
        writeReg(st, i.dst, { k: "scalar", s: trunc32(src.s), id: 0 }, pc);
      } else if (src.k === "scalar" && isReg && !scalarIsConst(src.s)) {
        // The copies share an id, so that a later check of one also narrows the other.
        const id = src.id || newId();
        st.regs[i.src] = { ...src, id };
        writeReg(st, i.dst, { ...src, id }, pc);
      } else writeReg(st, i.dst, src, pc);
      return [i.dst];
    }
    const d = readable(st, i.dst, pc);
    const name = ALU_NAME[code]!;
    if (name === "neg") {
      if (d.k !== "scalar") throw new Reject(pc, `R${i.dst} pointer arithmetic with neg operator prohibited`);
      writeReg(st, i.dst, { k: "scalar", s: scalarAlu("neg", d.s, d.s, is32), id: 0 }, pc);
      return [i.dst];
    }
    if ((name === "div" || name === "mod") && !isReg && i.imm === 0) throw new Reject(pc, "div by zero");
    if ((name === "lsh" || name === "rsh" || name === "arsh") && !isReg && (i.imm < 0 || i.imm >= (is32 ? 32 : 64))) throw new Reject(pc, `invalid shift ${i.imm}`);
    const anyPtr = d.k !== "scalar" || src.k !== "scalar";
    if (anyPtr) {
      if (is32) throw new Reject(pc, `R${i.dst} 32-bit pointer arithmetic prohibited`);
      if (d.k !== "scalar" && src.k !== "scalar") {
        if (name === "sub") { writeReg(st, i.dst, unknownReg(), pc); return [i.dst]; }
        throw new Reject(pc, `R${i.dst} pointer ${opText()} pointer prohibited`);
      }
      if (name === "and" || name === "or" || name === "xor") throw new Reject(pc, `R${i.dst} bitwise operator ${opText()} on pointer prohibited`);
      if (name !== "add" && name !== "sub") throw new Reject(pc, `R${i.dst} pointer arithmetic with ${opText()} operator prohibited`);
      if (d.k === "scalar") {
        if (name === "sub") throw new Reject(pc, `R${i.dst} tried to subtract pointer from scalar`);
        writeReg(st, i.dst, ptrAlu(pc, i.dst, src, d, false), pc);
      } else {
        writeReg(st, i.dst, ptrAlu(pc, i.dst, d, src as Reg & { k: "scalar" }, name === "sub"), pc);
      }
      return [i.dst];
    }
    const a = d as Reg & { k: "scalar" }, b = src as Reg & { k: "scalar" };
    writeReg(st, i.dst, { k: "scalar", s: scalarAlu(name, a.s, b.s, is32), id: 0 }, pc);
    return [i.dst];
  };

  const execLoad = (st: VState, i: Insn, pc: number): number[] => {
    const size = SIZE_BYTES[i.op & 0x18]!;
    const base = readable(st, i.src, pc);
    let v: Reg;
    switch (base.k) {
      case "ctx": v = ctxRead(pc, base, i.src, i.off, size); break;
      case "stack": {
        const off = base.off + i.off;
        checkStackBounds(pc, i.src, off, size, "read from");
        v = stackRead(st, pc, off, size);
        break;
      }
      case "map_value":
        checkMapAccess(pc, i.src, base, i.off, size);
        v = { k: "scalar", s: scalarBits(size * 8), id: 0 };
        break;
      case "pkt":
        checkPktAccess(pc, i.src, base, i.off, size);
        v = { k: "scalar", s: scalarBits(size * 8), id: 0 };
        break;
      default:
        throw new Reject(pc, `R${i.src} invalid mem access '${typeName(base)}'`);
    }
    writeReg(st, i.dst, v, pc);
    return [i.dst];
  };

  const execStore = (st: VState, i: Insn, pc: number) => {
    const size = SIZE_BYTES[i.op & 0x18]!;
    const base = readable(st, i.dst, pc);
    const isAtomic = (i.op & 7) === BPF.STX && (i.op & 0xe0) === BPF.ATOMIC;
    const value: Reg = (i.op & 7) === BPF.ST ? { k: "scalar", s: scalarConst(BigInt(i.imm)), id: 0 } : readable(st, i.src, pc);
    const srcReg = (i.op & 7) === BPF.ST ? 0 : i.src;
    if (isAtomic && value.k !== "scalar") throw new Reject(pc, `R${i.src} leaks addr into mem`);
    switch (base.k) {
      case "ctx":
        throw new Reject(pc, `invalid bpf_context access off=${i.off} size=${size}`);
      case "stack": {
        const off = base.off + i.off;
        checkStackBounds(pc, i.dst, off, size, "write to");
        if (isAtomic) {
          const held = stackRead(st, pc, off, size);
          if (held.k !== "scalar") throw new Reject(pc, "attempt to corrupt spilled pointer on stack");
          // The old value is gone: the slot now holds an unknown number.
          const sl = st.stack[slotIndex(off)]!;
          st.stack[slotIndex(off)] = { mask: sl.mask };
        } else if (size === 8 && value.k === "scalar" && (i.op & 7) === BPF.ST) {
          st.stack[slotIndex(off)] = { mask: 0xff, spill: value };
        } else stackWrite(st, pc, off, size, value, srcReg);
        break;
      }
      case "map_value":
        if (value.k !== "scalar") throw new Reject(pc, `R${srcReg} leaks addr into map`);
        checkMapAccess(pc, i.dst, base, i.off, size);
        break;
      case "pkt":
        if (value.k !== "scalar") throw new Reject(pc, `R${srcReg} leaks addr into packet`);
        checkPktAccess(pc, i.dst, base, i.off, size);
        break;
      default:
        throw new Reject(pc, `R${i.dst} invalid mem access '${typeName(base)}'`);
    }
  };

  const helperMemArg = (st: VState, pc: number, reg: number, size: number) => {
    const r = readable(st, reg, pc);
    if (r.k === "map_value") return checkMapAccess(pc, reg, r, 0, size);
    if (r.k !== "stack") throw new Reject(pc, `R${reg} type=${typeName(r)} expected=fp, map_value`);
    if (r.off < -STACK_SIZE || r.off + size > 0) throw new Reject(pc, `invalid indirect access to stack R${reg} off=${r.off} size=${size}`);
    for (let b = 0; b < size; b++) {
      const at = r.off + b;
      const idx = slotIndex(at);
      const sl = st.stack[idx];
      const bit = 1 << (at + (idx + 1) * 8);
      if (!sl || (sl.mask & bit) === 0) throw new Reject(pc, `invalid indirect read from stack R${reg} off ${r.off}+${b} size ${size}`);
      if (sl.spill && sl.spill.k !== "scalar") throw new Reject(pc, `R${reg} indirect read of a spilled pointer`);
    }
  };

  const execCall = (st: VState, i: Insn, pc: number): { changed: number[]; note: string } => {
    const name = HELPERS[i.imm as HelperId];
    if (!name) throw new Reject(pc, `invalid func unknown#${i.imm}`);
    let ret: Reg = unknownReg();
    let note = "";
    if (name === "map_lookup_elem" || name === "map_update_elem" || name === "map_delete_elem") {
      const a1 = readable(st, 1, pc);
      if (a1.k !== "map_ptr") throw new Reject(pc, `R1 type=${typeName(a1)} expected=map_ptr`);
      const def = maps[a1.map]!;
      helperMemArg(st, pc, 2, def.keySize);
      if (name === "map_update_elem") {
        helperMemArg(st, pc, 3, def.valueSize);
        const a4 = readable(st, 4, pc);
        if (a4.k !== "scalar") throw new Reject(pc, `R4 type=${typeName(a4)} expected=scalar`);
      }
      if (name === "map_lookup_elem") {
        ret = { k: "map_value_or_null", map: a1.map, id: newId() };
        note = `Each key lookup can fail, so r0 can be null. A null check must come before each use.`;
      }
    }
    st.regs[0] = ret;
    for (let r = 1; r <= 5; r++) st.regs[r] = NONE;
    return { changed: [0, 1, 2, 3, 4, 5], note: note || "A helper call destroys r1 to r5. The result is in r0." };
  };

  // -- conditional jumps

  const fmtR = (r: number, st: VState) => `r${r} is ${fmtReg(st.regs[r]!, maps)}`;

  /** Apply the knowledge from a condition to all copies with the same id. */
  const applyScalar = (st: VState, reg: number | null, old: Reg, s: Scalar) => {
    if (old.k !== "scalar") return;
    const fresh = syncBounds(s) ?? s;
    const id = old.id;
    if (id) {
      mapAllRegs(st, (r) => (r.k === "scalar" && r.id === id ? { ...r, s: fresh } : r));
    }
    if (reg !== null) st.regs[reg] = { ...old, s: fresh };
  };

  /** Mark all registers with this id as null or as not null. */
  const markNull = (st: VState, id: number, isNull: boolean) => {
    mapAllRegs(st, (r) => {
      if (r.k === "map_value_or_null" && r.id === id) return isNull ? ZERO() : { k: "map_value", map: r.map, off: 0, v: scalarConst(0n) };
      return r;
    });
  };

  /** Give a checked range to all packet pointers of the same id. */
  const markPktRange = (st: VState, p: Extract<Reg, { k: "pkt" }>, rightOpen: boolean) => {
    if (p.off < 0 || p.v.umax > MAX_PACKET_OFF) return;
    const range = rightOpen ? p.off + 1 : p.off;
    mapAllRegs(st, (r) => (r.k === "pkt" && r.id === p.id && r.range < range ? { ...r, range } : r));
  };

  /**
   * The states of both sides of a condition. `null` means that the path cannot happen.
   * `is32` compares the low halves. It only narrows when both sides already fit, because this subset has no 32-bit bounds.
   */
  const conditional = (st: VState, i: Insn, pc: number): { yes: VState | null; no: VState | null; note: string } => {
    const is32 = (i.op & 7) === BPF.JMP32;
    const name = CMP_NAME[i.op & 0xf0]!;
    const isReg = (i.op & 8) !== 0;
    const a = readable(st, i.dst, pc);
    const b: Reg = isReg ? readable(st, i.src, pc) : { k: "scalar", s: is32 ? scalarConst(BigInt(i.imm >>> 0)) : scalarConst(BigInt(i.imm)), id: 0 };
    const yes = cloneState(st), no = cloneState(st);

    // -- a null check
    const isZero = (r: Reg) => r.k === "scalar" && scalarIsConst(r.s) && r.s.umin === 0n;
    if (a.k === "map_value_or_null" && isZero(b) && (name === "eq" || name === "ne") && !is32) {
      markNull(yes, a.id, name === "eq");
      markNull(no, a.id, name !== "eq");
      return { yes, no, note: `Null check on r${i.dst}. Here the walk knows which side has a real pointer.` };
    }
    // -- a pointer that cannot be null, compared with zero
    const notNull = (r: Reg) => r.k === "ctx" || r.k === "stack" || r.k === "map_value" || r.k === "pkt" || r.k === "pkt_end" || r.k === "map_ptr";
    if (notNull(a) && isZero(b) && (name === "eq" || name === "ne") && !is32) {
      return name === "eq" ? { yes: null, no, note: `r${i.dst} cannot be null, so the jump never happens.` } : { yes, no: null, note: `r${i.dst} cannot be null, so the jump always happens.` };
    }
    // -- a packet bounds check
    if (!is32 && (a.k === "pkt" && b.k === "pkt_end" || a.k === "pkt_end" && b.k === "pkt")) {
      const p = (a.k === "pkt" ? a : b) as Extract<Reg, { k: "pkt" }>;
      const pktOnLeft = a.k === "pkt";
      // Which side knows that the pointer is at or below data_end?
      let good: VState | null = null, open = false;
      if (name === "gt") good = pktOnLeft ? no : yes;
      else if (name === "lt") good = pktOnLeft ? yes : no, open = pktOnLeft ? true : false;
      else if (name === "ge") good = pktOnLeft ? no : yes, open = pktOnLeft;
      else if (name === "le") good = pktOnLeft ? yes : no;
      // name "gt" with the end on the left means end > p, so p < end: one more byte is safe.
      if (name === "gt" && !pktOnLeft) open = true;
      if (good) {
        markPktRange(good, p, open);
        return { yes, no, note: `Packet check. On the safe side, the same packet pointers can read up to byte ${open ? p.off + 1 : p.off}.` };
      }
    }
    // -- pointers in other compares: both sides are possible, and nothing is learned
    if (a.k !== "scalar" || b.k !== "scalar") return { yes, no, note: "A compare with a pointer. Both paths are possible, and the walk learns nothing." };

    // -- scalars
    let sa = a.s, sb = b.s;
    if (is32) {
      const fits = name === "sgt" || name === "sge" || name === "slt" || name === "sle" ? sa.umax <= 0x7fffffffn && sb.umax <= 0x7fffffffn : sa.umax <= 0xffffffffn && sb.umax <= 0xffffffffn;
      if (!fits) {
        const bothConst = scalarIsConst(sa) && scalarIsConst(sb);
        if (!bothConst) return { yes, no, note: "A 32-bit compare of values that do not fit in 32 bits. Both paths are possible." };
        sa = trunc32(sa);
        sb = trunc32(sb);
        const lowA = BigInt.asIntN(32, sa.umin), lowB = BigInt.asIntN(32, sb.umin);
        if (name === "sgt" || name === "sge" || name === "slt" || name === "sle") {
          sa = scalarConst(lowA);
          sb = scalarConst(lowB);
        }
      }
    }
    const known = branchKnown(name, sa, sb);
    if (known === 1) return { yes, no: null, note: `The ranges prove that this condition is always true, so only the jump is walked.` };
    if (known === 0) return { yes: null, no, note: `The ranges prove that this condition is always false, so the jump is not walked.` };
    if (name === "set") {
      if (scalarIsConst(sb) && sb.umin !== 0n && (sb.umin & (sb.umin - 1n)) === 0n) {
        const bit = sb.umin;
        const on = syncBounds({ ...sa, t: { v: sa.t.v | bit, m: sa.t.m & ~bit } });
        const off = syncBounds({ ...sa, t: { v: sa.t.v & ~bit, m: sa.t.m & ~bit } });
        if (on) applyScalar(yes, i.dst, a, on);
        if (off) applyScalar(no, i.dst, a, off);
        return { yes: on ? yes : null, no: off ? no : null, note: `One bit of r${i.dst} is now known on each path.` };
      }
      return { yes, no, note: "Both paths are possible." };
    }
    const t = refine(name as Exclude<CmpName, "set">, sa, sb);
    const f = refine(CMP_NEGATE[name as Exclude<CmpName, "set">], sa, sb);
    if (t) {
      applyScalar(yes, i.dst, a, t[0]);
      if (isReg) applyScalar(yes, i.src, b, t[1]);
    }
    if (f) {
      applyScalar(no, i.dst, a, f[0]);
      if (isReg) applyScalar(no, i.src, b, f[1]);
    }
    return { yes: t ? yes : null, no: f ? no : null, note: `Both paths are possible. Each path narrows the range of r${i.dst}.` };
  };

  // -- the main loop

  const endPath = (): boolean => {
    finishCheckpoints(path.cp);
    const nx = pending.pop();
    if (!nx) return false;
    path = nx;
    emit({ kind: "pop", pc: nx.pc, note: `Go back to the path that was saved, at instruction ${nx.pc}.`, changed: [], st: nx.st });
    return true;
  };

  try {
    for (;;) {
      const pc = path.pc;
      const st = path.st;
      const insn = prog.insns[pc]!;
      if (prune.has(pc)) {
        const key = serialize(st);
        let keys = keyAt.get(pc);
        if (!keys) { keys = new Map(); keyAt.set(pc, keys); }
        const same = keys.get(key);
        if (same && same.branches > 0) throw new Reject(pc, `infinite loop detected at insn ${pc}`);
        let done = same !== undefined;
        if (!done) {
          const list = doneAt.get(pc);
          if (list) {
            for (let k = list.length - 1, tried = 0; k >= 0 && tried < 64; k--, tried++) {
              if (subsumes(list[k]!.st, st)) { done = true; break; }
            }
          }
        }
        if (done) {
          pruned++;
          emit({ kind: "prune", pc, note: `This state is inside a state that the walk already proved safe here. Stop this path.`, changed: [], st });
          if (!endPath()) break;
          continue;
        }
        const cp: Checkpoint = { pc, st: cloneState(st), parent: path.cp, branches: 1 };
        keys.set(key, cp);
        path.cp = cp;
      }
      if (statesAt) {
        let l = statesAt.get(pc);
        if (!l) { l = []; statesAt.set(pc, l); }
        l.push(cloneState(st));
      }
      processed++;
      if (processed > limit) {
        throw new Reject(pc, `BPF program is too large. Processed ${limit + 1} insn`);
      }
      const cls = insn.op & 7;
      let changed: number[] = [];
      let note = "";
      let next = pc + 1;
      if (cls === BPF.ALU || cls === BPF.ALU64) {
        changed = execAlu(st, insn, pc);
      } else if (isLd64(insn)) {
        const v: Reg = insn.src === BPF.PSEUDO_MAP_FD ? { k: "map_ptr", map: insn.imm } : { k: "scalar", s: scalarConst(insn.imm64 ?? BigInt(insn.imm)), id: 0 };
        writeReg(st, insn.dst, v, pc);
        changed = [insn.dst];
        next = pc + 2;
      } else if (cls === BPF.LDX) {
        changed = execLoad(st, insn, pc);
      } else if (cls === BPF.ST || cls === BPF.STX) {
        execStore(st, insn, pc);
      } else if (isExit(insn)) {
        const r0 = st.regs[0]!;
        if (r0.k === "none") throw new Reject(pc, "R0 !read_ok");
        if (r0.k !== "scalar") throw new Reject(pc, "R0 leaks addr as return value");
        emit({ kind: "exit", pc, note: `This path ends with ${fmtR(0, st)}. It is safe.`, changed: [], st });
        if (!endPath()) break;
        continue;
      } else if ((insn.op & 0xf0) === BPF.CALL && cls === BPF.JMP) {
        const c = execCall(st, insn, pc);
        changed = c.changed;
        note = c.note;
      } else if (isJump(insn) && !isCond(insn)) {
        next = pc + 1 + insn.off;
      } else {
        const to = pc + 1 + insn.off;
        const { yes, no, note: n } = conditional(st, insn, pc);
        if (yes && no) {
          forks++;
          if (pending.length >= JMP_SEQ_LIMIT) throw new Reject(pc, `The sequence of ${JMP_SEQ_LIMIT} jumps is too complex.`);
          path.cp.branches++;
          pending.push({ pc: to, st: yes, cp: path.cp });
          path.st = no;
          path.pc = pc + 1;
          emit({ kind: "fork", pc, note: `${n} Save the jump path, and walk the next instruction first.`, changed: changedRegs(st, no), st: no });
          continue;
        }
        const only = yes ?? no;
        if (!only) {
          // No number fits either side, so no real run reaches this point.
          emit({ kind: "dead", pc, note: "No value can reach this point, so this path ends.", changed: [], st });
          if (!endPath()) break;
          continue;
        }
        path.st = only;
        path.pc = yes ? to : pc + 1;
        emit({ kind: "dead", pc, note: n, changed: changedRegs(st, only), st: only });
        continue;
      }
      path.pc = next;
      emit({ kind: "insn", pc, note, changed, st });
    }
  } catch (e) {
    if (!(e instanceof Reject)) throw e;
    emit({ kind: "error", pc: e.pc, note: e.message, changed: [], st: path.st });
    return res({ ok: false, error: e.message, errorPc: e.pc, stage: "walk" });
  }
  log.push({ kind: "accept", pc: prog.insns.length - 1, note: `The walk ended. All paths are safe, after ${processed} instructions.`, regs: log.length ? log[log.length - 1]!.regs : initial.regs, stack: log.length ? log[log.length - 1]!.stack : initial.stack, changed: [], pending: 0 });
  return res({ ok: true });
}

const regEq = (a: Reg, b: Reg): boolean => {
  if (a === b) return true;
  if (a.k !== b.k) return false;
  if (a.k === "scalar") return scalarEq(a.s, (b as typeof a).s);
  return JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v));
};
const changedRegs = (a: VState, b: VState): number[] => {
  const out: number[] = [];
  for (let r = 0; r < 11; r++) if (!regEq(a.regs[r]!, b.regs[r]!)) out.push(r);
  return out;
};

/** True when a concrete value fits an abstract scalar. Exported for the soundness test. */
export const scalarHolds = (r: Reg, value: bigint): boolean => r.k !== "scalar" || (u64(value) >= r.s.umin && u64(value) <= r.s.umax && (u64(value) & ~r.s.t.m & ((1n << 64n) - 1n)) === r.s.t.v);
