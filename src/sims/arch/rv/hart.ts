/**
 * The functional executor of the toolkit: one RV32IM hart (hardware thread), the golden model that every timing model
 * and demo in the track checks against. It follows the RISC-V Unprivileged ISA manual, RV32I 2.1 and M 2.0.
 *
 * - 32 registers of 32 bits. x0 reads 0 and ignores writes. Arithmetic wraps around mod 2^32. A register holds a
 *   signed int32 (`| 0`); unsigned views use `>>> 0`.
 * - Memory is `memBytes` bytes (default 64 KiB) at address 0, little-endian and byte-addressed. The program's text and
 *   data are copied into it, so code can read (and overwrite) its own instructions. sp starts at `stackTop` (default:
 *   the top of memory, rounded down to 16 bytes, as the psABI wants a 16-byte-aligned sp).
 * - Shifts use the low 5 bits of the amount. Division by zero and overflow do not trap, as the M extension says:
 *   x / 0 = -1 (all ones; 2^32 - 1 for divu), x % 0 = x, and INT_MIN / -1 = INT_MIN with remainder 0.
 * - Misaligned loads and stores trap by default (load/store address misaligned). The spec lets an implementation
 *   either support them in hardware or trap; `allowMisaligned: true` makes them work, byte by byte.
 * - A jump or taken branch to an address that is not 4-byte aligned raises instruction-address-misaligned on the jump
 *   itself (no C extension). jalr clears bit 0 of its target first, as the spec says.
 * - Traps stop the hart with `error = { kind, pc, message }`, named as the privileged spec names the exceptions:
 *   illegal instruction, instruction/load/store address misaligned, instruction/load/store access fault (an address
 *   outside memory). There is no trap handler: no CSRs, no privilege modes, no interrupts.
 * - `ecall` uses Linux numbers in a7: 93 = exit(a0) stops the hart with `exitCode`; 64 = write(fd = a0, buf = a1,
 *   len = a2) appends the bytes (as UTF-8) to `output` when fd is 1 or 2 and returns len in a0. Any other number
 *   returns -38 (-ENOSYS) in a0, as Linux does. `ebreak` stops the hart (status "ebreak").
 * - Every executed (retired) instruction makes a DynInst: it goes into `trace` (default), and to `onInst` if given.
 *   With `trace: false` and no `onInst`, no objects are made, for long runs. A trapping instruction does not retire.
 *   ecall and ebreak count as retired here, because the emulated kernel returns to pc + 4 (or stops). On real
 *   hardware they raise an exception and do not retire.
 * - Deterministic: no clocks, no randomness. The same program and options give the same run.
 */
import type { Program } from "./asm";
import { CLASSES, classOf, decode, dstReg, OPS, type Inst, type InstClass } from "./isa";

export interface DynInst {
  /** 0, 1, 2, ... in execution order. */
  seq: number;
  pc: number;
  word: number;
  inst: Inst;
  cls: InstClass;
  /** The register written (0 = none), and the registers read (0 = not read; reading x0 also shows 0). */
  rd: number;
  rs1: number;
  rs2: number;
  /** Values read from rs1 and rs2, as signed int32. */
  rs1Val: number;
  rs2Val: number;
  /** The value written to rd; for a store, the value stored (masked to its size); otherwise 0. */
  result: number;
  memAddr?: number;
  memSize?: number;
  /** Branches: the outcome. Jumps: true. */
  taken?: boolean;
  nextPc: number;
}

export type TrapKind =
  | "illegal-instruction" | "instruction-address-misaligned" | "instruction-access-fault"
  | "load-address-misaligned" | "load-access-fault" | "store-address-misaligned" | "store-access-fault";

export interface HartError { kind: TrapKind; pc: number; message: string }
export type HartStatus = "running" | "exited" | "ebreak" | "error";

export interface HartOptions {
  memBytes?: number;
  stackTop?: number;
  /** Initial register values, by register number (sp is set from stackTop first; this overrides it). */
  regs?: Partial<Record<number, number>>;
  /** Keep a DynInst for every instruction in `trace` (default true). */
  trace?: boolean;
  /** Called with each retired instruction. */
  onInst?: (d: DynInst) => void;
  /** Let misaligned loads and stores work instead of trapping (default false). */
  allowMisaligned?: boolean;
}

export interface MemAccess { addr: number; size: number; value: number }

/** The state after the last step, for steppers. */
export interface Snapshot {
  pc: number;
  regs: number[];
  /** Registers the last instruction wrote (empty for none or x0). */
  changed: number[];
  reads: MemAccess[];
  writes: MemAccess[];
  instret: number;
  status: HartStatus;
  error: HartError | null;
  /** The instruction that the last step executed. Null before the first step, and when `trace` is false with no `onInst`. */
  last: DynInst | null;
}

export const DEFAULT_MEM_BYTES = 64 * 1024;
export const SYS_EXIT = 93, SYS_WRITE = 64, ENOSYS = 38;

const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];

export class Hart {
  readonly program: Program;
  readonly mem: Uint8Array;
  readonly regs = new Int32Array(32);
  pc: number;
  status: HartStatus = "running";
  error: HartError | null = null;
  exitCode: number | null = null;
  output = "";
  instret = 0;
  readonly counts: Record<InstClass, number> = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<InstClass, number>;
  readonly trace: DynInst[] = [];

  private readonly dv: DataView;
  private readonly keepTrace: boolean;
  private readonly onInst?: (d: DynInst) => void;
  private readonly allowMisaligned: boolean;
  /** Decoded instructions by word index; undefined = not decoded yet, null = illegal. A store clears its entry. */
  private readonly icache: (Inst | null | undefined)[];
  private lastRd = 0;
  private lastRead: MemAccess | null = null;
  private lastWrite: MemAccess | null = null;
  private lastDyn: DynInst | null = null;

  constructor(program: Program, opts: HartOptions = {}) {
    const memBytes = opts.memBytes ?? DEFAULT_MEM_BYTES;
    this.program = program;
    this.mem = new Uint8Array(memBytes);
    this.dv = new DataView(this.mem.buffer);
    this.icache = new Array(Math.ceil(memBytes / 4));
    this.keepTrace = opts.trace ?? true;
    this.onInst = opts.onInst;
    this.allowMisaligned = opts.allowMisaligned ?? false;
    const textEnd = program.textBase + program.words.length * 4;
    if (textEnd > memBytes || (program.data.length > 0 && program.dataBase + program.data.length > memBytes)) throw new RangeError(`the program does not fit in ${memBytes} bytes of memory`);
    program.words.forEach((w, i) => this.dv.setUint32(program.textBase + i * 4, w, true));
    if (program.data.length > 0) this.mem.set(program.data, program.dataBase);
    this.pc = program.entry >>> 0;
    this.regs[2] = (opts.stackTop ?? memBytes) & ~15;
    for (const [k, v] of Object.entries(opts.regs ?? {})) if (Number(k) > 0 && Number(k) < 32 && v !== undefined) this.regs[Number(k)] = v;
  }

  get memBytes() { return this.mem.length; }

  /** Read memory without side effects (for views and tests). Out-of-range bytes read as 0. */
  peek(addr: number, size: 1 | 2 | 4 = 4, signed = false): number {
    let v = 0;
    for (let k = size - 1; k >= 0; k--) v = (v << 8) | (this.mem[addr + k] ?? 0);
    return signed ? (v << (32 - 8 * size)) >> (32 - 8 * size) : size === 4 ? v >>> 0 : v;
  }

  /** Execute one instruction. Returns false once the hart has stopped (exit, ebreak or a trap). */
  step(): boolean {
    if (this.status !== "running") return false;
    const pc = this.pc;
    this.lastRd = 0; this.lastRead = null; this.lastWrite = null; this.lastDyn = null;
    if (pc + 4 > this.mem.length) return this.trap("instruction-access-fault", pc, `fetch from 0x${hex(pc)} is outside memory`);
    if (pc & 3) return this.trap("instruction-address-misaligned", pc, `pc 0x${hex(pc)} is not 4-byte aligned`);
    let inst = this.icache[pc >>> 2];
    if (inst === undefined) inst = this.icache[pc >>> 2] = decode(this.dv.getUint32(pc, true));
    if (inst === null) return this.trap("illegal-instruction", pc, `0x${hex(this.dv.getUint32(pc, true))} at 0x${hex(pc)} is not an RV32IM instruction`);

    const r = this.regs;
    const { op, rs1, rs2, imm } = inst;
    const a = r[rs1]!, b = r[rs2]!;
    let res = 0, next = (pc + 4) >>> 0, taken: boolean | undefined, memAddr: number | undefined, memSize: number | undefined, write = true;
    switch (op) {
      case "lui": res = imm << 12; break;
      case "auipc": res = (pc + (imm << 12)) | 0; break;
      case "jal": case "jalr": {
        const t = op === "jal" ? (pc + imm) >>> 0 : ((a + imm) & ~1) >>> 0;
        if (t & 3) return this.trap("instruction-address-misaligned", pc, `${op} target 0x${hex(t)} is not 4-byte aligned`);
        res = (pc + 4) | 0; next = t; taken = true;
        break;
      }
      case "beq": case "bne": case "blt": case "bge": case "bltu": case "bgeu": {
        write = false;
        taken = op === "beq" ? a === b : op === "bne" ? a !== b : op === "blt" ? a < b : op === "bge" ? a >= b : op === "bltu" ? a >>> 0 < b >>> 0 : a >>> 0 >= b >>> 0;
        if (taken) {
          const t = (pc + imm) >>> 0;
          if (t & 3) return this.trap("instruction-address-misaligned", pc, `branch target 0x${hex(t)} is not 4-byte aligned`);
          next = t;
        }
        break;
      }
      case "lb": case "lh": case "lw": case "lbu": case "lhu": {
        memSize = op === "lw" ? 4 : op === "lh" || op === "lhu" ? 2 : 1;
        memAddr = (a + imm) >>> 0;
        const v = this.load(pc, memAddr, memSize, op === "lb" || op === "lh");
        if (v === null) return false;
        res = v;
        this.lastRead = { addr: memAddr, size: memSize, value: v };
        break;
      }
      case "sb": case "sh": case "sw": {
        write = false;
        memSize = op === "sw" ? 4 : op === "sh" ? 2 : 1;
        memAddr = (a + imm) >>> 0;
        res = memSize === 4 ? b : b & MASK[memSize]!;
        if (!this.store(pc, memAddr, memSize, b)) return false;
        this.lastWrite = { addr: memAddr, size: memSize, value: res };
        break;
      }
      case "addi": res = (a + imm) | 0; break;
      case "slti": res = a < imm ? 1 : 0; break;
      case "sltiu": res = a >>> 0 < imm >>> 0 ? 1 : 0; break; // the immediate is sign-extended, then compared unsigned
      case "xori": res = a ^ imm; break;
      case "ori": res = a | imm; break;
      case "andi": res = a & imm; break;
      case "slli": res = a << imm; break;
      case "srli": res = (a >>> imm) | 0; break;
      case "srai": res = a >> imm; break;
      case "add": res = (a + b) | 0; break;
      case "sub": res = (a - b) | 0; break;
      case "sll": res = a << (b & 31); break;
      case "slt": res = a < b ? 1 : 0; break;
      case "sltu": res = a >>> 0 < b >>> 0 ? 1 : 0; break;
      case "xor": res = a ^ b; break;
      case "srl": res = (a >>> (b & 31)) | 0; break;
      case "sra": res = a >> (b & 31); break;
      case "or": res = a | b; break;
      case "and": res = a & b; break;
      case "mul": res = Math.imul(a, b); break;
      case "mulh": res = mulh(a, b); break;
      case "mulhsu": res = mulhsu(a, b); break;
      case "mulhu": res = mulhu(a, b); break;
      case "div": res = b === 0 ? -1 : a === -0x80000000 && b === -1 ? a : (a / b) | 0; break;
      case "divu": res = b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) | 0; break;
      case "rem": res = b === 0 ? a : a === -0x80000000 && b === -1 ? 0 : (a % b) | 0; break;
      case "remu": res = b === 0 ? a : ((a >>> 0) % (b >>> 0)) | 0; break;
      case "fence": write = false; break;
      case "ebreak": write = false; this.status = "ebreak"; break;
      case "ecall": {
        write = false;
        const n = r[17]!;
        if (n === SYS_EXIT) { this.status = "exited"; this.exitCode = r[10]!; }
        else if (n === SYS_WRITE) {
          const fd = r[10]!, buf = r[11]! >>> 0, len = r[12]! >>> 0;
          if (buf + len > this.mem.length) return this.trap("load-access-fault", pc, `write(${fd}, 0x${hex(buf)}, ${len}) reads outside memory`);
          if (fd === 1 || fd === 2) this.output += new TextDecoder().decode(this.mem.subarray(buf, buf + len));
          r[10] = len; this.lastRd = 10; res = len;
        } else { r[10] = -ENOSYS; this.lastRd = 10; res = -ENOSYS; }
        break;
      }
    }
    const dst = dstReg(inst);
    if (write && dst !== 0) { r[dst] = res; this.lastRd = dst; }
    this.pc = next;
    const cls = classOf(op);
    this.counts[cls]++;
    if (this.keepTrace || this.onInst) {
      const fmt = OPS[op].fmt;
      const readsRs1 = fmt !== "U" && fmt !== "J" && op !== "fence" && op !== "ecall" && op !== "ebreak";
      const readsRs2 = fmt === "R" || fmt === "S" || fmt === "B";
      const d: DynInst = {
        seq: this.instret, pc, word: this.dv.getUint32(pc, true) >>> 0, inst, cls, rd: dst,
        rs1: readsRs1 ? rs1 : 0, rs2: readsRs2 ? rs2 : 0, rs1Val: readsRs1 ? a : 0, rs2Val: readsRs2 ? b : 0,
        result: write || memSize || op === "ecall" ? res : 0, nextPc: next,
      };
      if (memAddr !== undefined) { d.memAddr = memAddr; d.memSize = memSize; }
      if (taken !== undefined) d.taken = taken;
      this.lastDyn = d;
      if (this.keepTrace) this.trace.push(d);
      this.onInst?.(d);
    }
    this.instret++;
    return this.status === "running";
  }

  /** Run until the hart stops or `maxSteps` instructions have run (default 10 million). Returns the status. */
  run({ maxSteps = 10_000_000 }: { maxSteps?: number } = {}): HartStatus {
    for (let i = 0; i < maxSteps && this.step(); i++);
    return this.status;
  }

  snapshot(): Snapshot {
    return {
      pc: this.pc, regs: Array.from(this.regs), changed: this.lastRd ? [this.lastRd] : [],
      reads: this.lastRead ? [this.lastRead] : [], writes: this.lastWrite ? [this.lastWrite] : [],
      instret: this.instret, status: this.status, error: this.error, last: this.lastDyn,
    };
  }

  private trap(kind: TrapKind, pc: number, message: string): false {
    this.status = "error";
    this.error = { kind, pc, message: `${KIND_NAME[kind]}: ${message}` };
    return false;
  }

  private load(pc: number, addr: number, size: number, signed: boolean): number | null {
    if (addr + size > this.mem.length) { this.trap("load-access-fault", pc, `load of ${size} byte${size > 1 ? "s" : ""} at 0x${hex(addr)} is outside memory`); return null; }
    if (addr % size !== 0) {
      if (!this.allowMisaligned) { this.trap("load-address-misaligned", pc, `load of ${size} bytes at 0x${hex(addr)}`); return null; }
      return this.peek(addr, size as 1 | 2 | 4, signed) | 0;
    }
    const dv = this.dv;
    if (size === 4) return dv.getInt32(addr, true);
    if (size === 2) return signed ? dv.getInt16(addr, true) : dv.getUint16(addr, true);
    return signed ? dv.getInt8(addr) : dv.getUint8(addr);
  }

  private store(pc: number, addr: number, size: number, v: number): boolean {
    if (addr + size > this.mem.length) return this.trap("store-access-fault", pc, `store of ${size} byte${size > 1 ? "s" : ""} at 0x${hex(addr)} is outside memory`);
    if (addr % size !== 0 && !this.allowMisaligned) return this.trap("store-address-misaligned", pc, `store of ${size} bytes at 0x${hex(addr)}`);
    for (let k = 0; k < size; k++) this.mem[addr + k] = (v >>> (8 * k)) & 0xff;
    this.icache[addr >>> 2] = undefined;
    this.icache[(addr + size - 1) >>> 2] = undefined;
    return true;
  }
}

const KIND_NAME: Record<TrapKind, string> = {
  "illegal-instruction": "illegal instruction",
  "instruction-address-misaligned": "instruction address misaligned",
  "instruction-access-fault": "instruction access fault",
  "load-address-misaligned": "load address misaligned",
  "load-access-fault": "load access fault",
  "store-address-misaligned": "store/AMO address misaligned",
  "store-access-fault": "store/AMO access fault",
};

const hex = (v: number) => (v >>> 0).toString(16);

// ---------------------------------------------------------------- high halves of 64-bit products

/** High 32 bits of the unsigned 64-bit product, from 16-bit halves (every partial product fits a double exactly). */
export function mulhu(a: number, b: number): number {
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  const lh = a0 * b1, hl = a1 * b0;
  const mid = ((a0 * b0) >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  return (a1 * b1 + Math.floor(lh / 65536) + Math.floor(hl / 65536) + Math.floor(mid / 65536)) | 0;
}

/** High 32 bits of the signed × signed product: the unsigned high part, minus b if a < 0, minus a if b < 0 (mod 2^32). */
export function mulh(a: number, b: number): number {
  return (mulhu(a, b) - (a < 0 ? b : 0) - (b < 0 ? a : 0)) | 0;
}

/** High 32 bits of signed a × unsigned b. */
export function mulhsu(a: number, b: number): number {
  return (mulhu(a, b) - (a < 0 ? b : 0)) | 0;
}
