/**
 * The architectural state that the single-cycle and the multi-cycle machine share: the PC, 32 registers, a
 * byte-addressed little-endian memory, the emulated kernel for ecall, and the traps. It loads a program exactly as
 * the hart in src/sims/arch/rv does (text at textBase, data at dataBase, sp at the top of memory rounded down to
 * 16 bytes), so that a test can compare the two machines with the hart, step by step.
 *
 * The instruction memory and the data memory of the datapath drawings are two ports on this one memory.
 */
import { decode, ENOSYS, SYS_EXIT, SYS_WRITE, DEFAULT_MEM_BYTES, type HartError, type HartStatus, type Program, type TrapKind } from "../rv";

export interface StoreRecord { addr: number; size: number; value: number }

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

export class MachineState {
  readonly program: Program;
  readonly mem: Uint8Array;
  readonly regs = new Int32Array(32);
  pc: number;
  status: HartStatus = "running";
  error: HartError | null = null;
  exitCode: number | null = null;
  output = "";
  /** Instructions completed. */
  instret = 0;
  /** The last store, for step-by-step comparison. */
  lastStore: StoreRecord | null = null;

  constructor(program: Program, memBytes = DEFAULT_MEM_BYTES) {
    this.program = program;
    this.mem = new Uint8Array(memBytes);
    const dv = new DataView(this.mem.buffer);
    program.words.forEach((w, i) => dv.setUint32(program.textBase + i * 4, w, true));
    if (program.data.length > 0) this.mem.set(program.data, program.dataBase);
    this.pc = program.entry >>> 0;
    this.regs[2] = memBytes & ~15;
  }

  get memBytes() { return this.mem.length; }

  /** Read without side effects. Out-of-range bytes read as 0. */
  peek(addr: number, size: 1 | 2 | 4 = 4, signed = false): number {
    let v = 0;
    for (let k = size - 1; k >= 0; k--) v = (v << 8) | (this.mem[addr + k] ?? 0);
    return signed ? (v << (32 - 8 * size)) >> (32 - 8 * size) : size === 4 ? v >>> 0 : v;
  }

  protected trap(kind: TrapKind, pc: number, message: string): false {
    this.status = "error";
    this.error = { kind, pc, message: `${KIND_NAME[kind]}: ${message}` };
    return false;
  }

  /** Fetch: the word at pc, or null after a trap (outside memory, misaligned, or not an RV32IM instruction). */
  protected fetch(pc: number): number | null {
    if (pc + 4 > this.mem.length) { this.trap("instruction-access-fault", pc, `fetch from 0x${hex(pc)} is outside memory`); return null; }
    if (pc & 3) { this.trap("instruction-address-misaligned", pc, `pc 0x${hex(pc)} is not 4-byte aligned`); return null; }
    const w = this.peek(pc);
    if (!decode(w)) { this.trap("illegal-instruction", pc, `0x${hex(w)} at 0x${hex(pc)} is not an RV32IM instruction`); return null; }
    return w;
  }

  /** A load of `size` bytes, sign- or zero-extended. Null after a trap. */
  protected load(pc: number, addr: number, size: number, signed: boolean): number | null {
    addr >>>= 0;
    if (addr + size > this.mem.length) { this.trap("load-access-fault", pc, `load of ${size} byte${size > 1 ? "s" : ""} at 0x${hex(addr)} is outside memory`); return null; }
    if (addr % size !== 0) { this.trap("load-address-misaligned", pc, `load of ${size} bytes at 0x${hex(addr)}`); return null; }
    return this.peek(addr, size as 1 | 2 | 4, signed) | 0;
  }

  protected store(pc: number, addr: number, size: number, v: number): boolean {
    addr >>>= 0;
    if (addr + size > this.mem.length) return this.trap("store-access-fault", pc, `store of ${size} byte${size > 1 ? "s" : ""} at 0x${hex(addr)} is outside memory`);
    if (addr % size !== 0) return this.trap("store-address-misaligned", pc, `store of ${size} bytes at 0x${hex(addr)}`);
    for (let k = 0; k < size; k++) this.mem[addr + k] = (v >>> (8 * k)) & 0xff;
    this.lastStore = { addr, size, value: size === 4 ? v | 0 : v & (size === 2 ? 0xffff : 0xff) };
    return true;
  }

  /** ecall (Linux numbers in a7: 93 exit, 64 write) or ebreak, as the hart does it. Returns the register it wrote. */
  protected system(pc: number, word: number): number {
    if (word >>> 20 === 1) { this.status = "ebreak"; return 0; }
    const r = this.regs, n = r[17]!;
    if (n === SYS_EXIT) { this.status = "exited"; this.exitCode = r[10]!; return 0; }
    if (n === SYS_WRITE) {
      const fd = r[10]!, buf = r[11]! >>> 0, len = r[12]! >>> 0;
      if (buf + len > this.mem.length) { this.trap("load-access-fault", pc, `write(${fd}, 0x${hex(buf)}, ${len}) reads outside memory`); return 0; }
      if (fd === 1 || fd === 2) this.output += new TextDecoder().decode(this.mem.subarray(buf, buf + len));
      r[10] = len;
      return 10;
    }
    r[10] = -ENOSYS;
    return 10;
  }
}
