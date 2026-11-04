/**
 * An interpreter for the eBPF subset. It has its own memory checks, separate from the verifier.
 * A program that the verifier accepts must never trigger them: this is the property that the tests check.
 *
 * Memory is a set of regions at fake addresses. An access must lie fully inside one region.
 */
import { BPF, HELPERS, PT_REGS, SIZE_BYTES, STACK_SIZE, XDP_MD, type BpfProgram, type HelperId, type Insn, type MapDef } from "./bpfIsa";
import { U32_MAX, aluEval, cmpEval, u64, type AluName, type CmpName } from "./bpfScalar";

export const ALU_NAME: Record<number, AluName> = {
  [BPF.ADD]: "add", [BPF.SUB]: "sub", [BPF.MUL]: "mul", [BPF.DIV]: "div", [BPF.OR]: "or", [BPF.AND]: "and", [BPF.LSH]: "lsh", [BPF.RSH]: "rsh", [BPF.NEG]: "neg", [BPF.MOD]: "mod", [BPF.XOR]: "xor", [BPF.ARSH]: "arsh",
};
export const CMP_NAME: Record<number, CmpName> = {
  [BPF.JEQ]: "eq", [BPF.JGT]: "gt", [BPF.JGE]: "ge", [BPF.JSET]: "set", [BPF.JNE]: "ne", [BPF.JSGT]: "sgt", [BPF.JSGE]: "sge", [BPF.JLT]: "lt", [BPF.JLE]: "le", [BPF.JSLT]: "slt", [BPF.JSLE]: "sle",
};

const CTX_BASE = 0x1000_0000n;
const STACK_BASE = 0x2000_0000n;
const PKT_BASE = 0x3000_0000n;
const MAP_BASE = 0x4000_0000n;
const MAP_STEP = 0x0100_0000n;
const ENTRY_GAP = 64n;

interface Region { name: string; base: bigint; bytes: Uint8Array; writable: boolean; init?: Uint8Array }

/** Real semantics of array and hash maps: an array has all its entries; a hash has only what was inserted. */
export class BpfMaps {
  readonly regions: Region[][] = [];
  private readonly hash: Map<string, number>[] = [];

  constructor(readonly defs: MapDef[]) {
    defs.forEach((d, i) => {
      this.regions.push(d.kind === "array" ? Array.from({ length: d.maxEntries }, (_, k) => this.region(i, k)) : []);
      this.hash.push(new Map());
    });
  }
  private region(map: number, k: number): Region {
    const d = this.defs[map]!;
    const stride = BigInt(d.valueSize) + ENTRY_GAP;
    return { name: `${d.name} value`, base: MAP_BASE + MAP_STEP * BigInt(map) + stride * BigInt(k), bytes: new Uint8Array(d.valueSize), writable: true };
  }
  /** The region of the value, or null. */
  lookup(map: number, key: Uint8Array): Region | null {
    const d = this.defs[map]!;
    if (d.kind === "array") {
      const k = new DataView(key.buffer, key.byteOffset, key.byteLength).getUint32(0, true);
      return this.regions[map]![k] ?? null;
    }
    const k = this.hash[map]!.get(key.join());
    return k === undefined ? null : this.regions[map]![k]!;
  }
  /** Returns 0, or a negative errno. */
  update(map: number, key: Uint8Array, value: Uint8Array): number {
    const d = this.defs[map]!;
    if (d.kind === "array") {
      const r = this.lookup(map, key);
      if (!r) return -7; // E2BIG
      r.bytes.set(value);
      return 0;
    }
    const id = key.join();
    let k = this.hash[map]!.get(id);
    if (k === undefined) {
      if (this.hash[map]!.size >= d.maxEntries) return -7;
      k = this.regions[map]!.length;
      this.regions[map]!.push(this.region(map, k));
      this.hash[map]!.set(id, k);
    }
    this.regions[map]![k]!.bytes.set(value);
    return 0;
  }
  remove(map: number, key: Uint8Array): number {
    if (this.defs[map]!.kind === "array") return -22; // EINVAL: an array entry cannot be removed
    return this.hash[map]!.delete(key.join()) ? 0 : -2; // ENOENT
  }
  /** What a bpf_map_lookup_elem syscall from user space would give: each array entry read as a u64. */
  readU64s(map: number): bigint[] {
    return this.regions[map]!.map((r) => {
      let v = 0n;
      for (let b = Math.min(8, r.bytes.length) - 1; b >= 0; b--) v = (v << 8n) | BigInt(r.bytes[b]!);
      return v;
    });
  }
  /** The number of bytes that this map holds in the kernel. */
  bytesInKernel(map: number): number {
    const d = this.defs[map]!;
    return d.maxEntries * d.valueSize;
  }
}

export interface VmInput {
  /** The registers that a kprobe sees, by name in struct pt_regs. */
  regs?: Partial<Record<keyof typeof PT_REGS, bigint>>;
  /** The bytes of the packet of an XDP program. */
  packet?: Uint8Array;
  /** Source of helper return values. */
  rng?: () => number;
  timeNs?: bigint;
  maps?: BpfMaps;
}

export type VmStatus = "running" | "exit" | "violation" | "budget";
export interface StepInfo { pc: number; insn: Insn; changed: number[] }

export class BpfVm {
  regs: (bigint | undefined)[] = new Array(11).fill(undefined);
  pc = 0;
  steps = 0;
  status: VmStatus = "running";
  violation: { pc: number; what: string } | null = null;
  readonly maps: BpfMaps;
  private readonly stack: Region;
  private readonly ctx: Region;
  private readonly pkt: Region | null;
  private readonly rng: () => number;
  private timeNs: bigint;

  constructor(readonly prog: BpfProgram, input: VmInput = {}) {
    this.maps = input.maps ?? new BpfMaps(prog.maps);
    this.rng = input.rng ?? Math.random;
    this.timeNs = input.timeNs ?? 1_000_000n;
    this.stack = { name: "stack", base: STACK_BASE, bytes: new Uint8Array(STACK_SIZE), writable: true, init: new Uint8Array(STACK_SIZE) };
    const size = prog.type === "xdp" ? XDP_MD.size : PT_REGS.size;
    this.ctx = { name: "ctx", base: CTX_BASE, bytes: new Uint8Array(size), writable: false };
    this.pkt = prog.type === "xdp" ? { name: "packet", base: PKT_BASE, bytes: input.packet ?? new Uint8Array(64), writable: true } : null;
    if (prog.type === "kprobe" && input.regs) {
      const dv = new DataView(this.ctx.bytes.buffer);
      for (const [k, v] of Object.entries(input.regs)) dv.setBigUint64(PT_REGS[k as keyof typeof PT_REGS], u64(v as bigint), true);
    }
    this.regs[1] = CTX_BASE;
    this.regs[10] = STACK_BASE + BigInt(STACK_SIZE);
  }

  private fail(what: string): void {
    this.status = "violation";
    this.violation = { pc: this.pc, what };
  }
  private readReg(r: number): bigint | null {
    const v = this.regs[r];
    if (v === undefined) {
      this.fail(`read of r${r}, which has no value`);
      return null;
    }
    return v;
  }
  private findRegion(addr: bigint, size: number): Region | null {
    const fits = (r: Region) => addr >= r.base && addr + BigInt(size) <= r.base + BigInt(r.bytes.length);
    if (fits(this.stack)) return this.stack;
    if (fits(this.ctx)) return this.ctx;
    if (this.pkt && fits(this.pkt)) return this.pkt;
    for (const rs of this.maps.regions) for (const r of rs) if (fits(r)) return r;
    return null;
  }
  private load(addr: bigint, size: number): bigint | null {
    const r = this.findRegion(addr, size);
    if (!r) {
      this.fail(`read of ${size} bytes at 0x${addr.toString(16)} is outside each region`);
      return null;
    }
    const at = Number(addr - r.base);
    if (r === this.ctx && this.prog.type === "xdp" && this.pkt) {
      if (at === XDP_MD.data) return this.pkt.base;
      if (at === XDP_MD.data_end) return this.pkt.base + BigInt(this.pkt.bytes.length);
    }
    let v = 0n;
    for (let i = size - 1; i >= 0; i--) {
      if (r.init && !r.init[at + i]) {
        this.fail(`read of stack byte ${at + i - STACK_SIZE}, which has no value`);
        return null;
      }
      v = (v << 8n) | BigInt(r.bytes[at + i]!);
    }
    return v;
  }
  private store(addr: bigint, size: number, value: bigint): boolean {
    const r = this.findRegion(addr, size);
    if (!r) {
      this.fail(`write of ${size} bytes at 0x${addr.toString(16)} is outside each region`);
      return false;
    }
    if (!r.writable) {
      this.fail(`write to the read-only ${r.name}`);
      return false;
    }
    const at = Number(addr - r.base);
    let v = value;
    for (let i = 0; i < size; i++) {
      r.bytes[at + i] = Number(v & 0xffn);
      if (r.init) r.init[at + i] = 1;
      v >>= 8n;
    }
    return true;
  }
  private readBytes(addr: bigint, n: number): Uint8Array | null {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const b = this.load(addr + BigInt(i), 1);
      if (b === null) return null;
      out[i] = Number(b);
    }
    return out;
  }

  private call(id: number): void {
    const name = HELPERS[id as HelperId];
    let ret = 0n;
    switch (name) {
      case "map_lookup_elem": case "map_update_elem": case "map_delete_elem": {
        const mapIdx = this.regs[1] === undefined ? -1 : Number(this.regs[1]! - MAP_PTR_BASE);
        const def = this.prog.maps[mapIdx];
        if (!def) return this.fail("helper argument r1 is not a map");
        const a2 = this.readReg(2);
        if (a2 === null) return;
        const key = this.readBytes(a2, def.keySize);
        if (!key) return;
        if (name === "map_lookup_elem") {
          ret = this.maps.lookup(mapIdx, key)?.base ?? 0n;
        } else if (name === "map_update_elem") {
          const a3 = this.readReg(3);
          if (a3 === null) return;
          const val = this.readBytes(a3, def.valueSize);
          if (!val) return;
          ret = u64(BigInt(this.maps.update(mapIdx, key, val)));
        } else {
          ret = u64(BigInt(this.maps.remove(mapIdx, key)));
        }
        break;
      }
      case "ktime_get_ns": this.timeNs += BigInt(Math.floor(this.rng() * 1000)); ret = this.timeNs; break;
      case "get_prandom_u32": ret = BigInt(Math.floor(this.rng() * 2 ** 32)); break;
      case "get_smp_processor_id": ret = BigInt(Math.floor(this.rng() * 8)); break;
      case "get_current_pid_tgid": ret = (BigInt(Math.floor(this.rng() * 32768)) << 32n) | BigInt(Math.floor(this.rng() * 32768)); break;
      default: return this.fail(`there is no helper number ${id}`);
    }
    this.regs[0] = ret;
    for (let r = 1; r <= 5; r++) this.regs[r] = undefined;
  }

  /** Run one instruction. It returns what changed, or null when the program has stopped. */
  step(): StepInfo | null {
    if (this.status !== "running") return null;
    const pc = this.pc;
    const i = this.prog.insns[pc];
    if (!i || i.filler) {
      this.fail(`pc ${pc} is not an instruction`);
      return null;
    }
    this.steps++;
    const cls = i.op & 7;
    const changed: number[] = [];
    const setReg = (r: number, v: bigint) => {
      if (r === 10) return this.fail("write to r10");
      this.regs[r] = v;
      changed.push(r);
    };
    let next = pc + 1;
    if (cls === BPF.ALU || cls === BPF.ALU64) {
      const is32 = cls === BPF.ALU;
      const code = i.op & 0xf0;
      const isReg = (i.op & 8) !== 0;
      if (code === BPF.END) {
        const d = this.readReg(i.dst);
        if (d === null) return null;
        if (isReg) {
          let v = d, out = 0n;
          const n = i.imm / 8;
          for (let b = 0; b < n; b++) {
            out = (out << 8n) | (v & 0xffn);
            v >>= 8n;
          }
          setReg(i.dst, out);
        } else setReg(i.dst, i.imm === 64 ? d : d & ((1n << BigInt(i.imm)) - 1n));
      } else {
        const srcV = isReg ? this.readReg(i.src) : code === BPF.NEG ? 0n : is32 ? BigInt(i.imm >>> 0) : u64(BigInt(i.imm));
        if (srcV === null) return null;
        if (code === BPF.MOV) setReg(i.dst, is32 ? srcV & U32_MAX : srcV);
        else {
          const d = this.readReg(i.dst);
          if (d === null) return null;
          const name = ALU_NAME[code];
          if (!name) { this.fail(`unknown opcode ${i.op}`); return null; }
          setReg(i.dst, aluEval(name, d, srcV, is32));
        }
      }
    } else if (i.op === (BPF.LD | BPF.DW | BPF.IMM)) {
      setReg(i.dst, i.src === BPF.PSEUDO_MAP_FD ? MAP_PTR_BASE + BigInt(i.imm) : i.imm64 ?? u64(BigInt(i.imm)));
      next = pc + 2;
    } else if (cls === BPF.LDX) {
      const base = this.readReg(i.src);
      if (base === null) return null;
      const v = this.load(u64(base + BigInt(i.off)), SIZE_BYTES[i.op & 0x18]!);
      if (v === null) return null;
      setReg(i.dst, v);
    } else if (cls === BPF.ST || cls === BPF.STX) {
      const base = this.readReg(i.dst);
      if (base === null) return null;
      const size = SIZE_BYTES[i.op & 0x18]!;
      const addr = u64(base + BigInt(i.off));
      if (cls === BPF.STX && (i.op & 0xe0) === BPF.ATOMIC) {
        const old = this.load(addr, size);
        const s = this.readReg(i.src);
        if (old === null || s === null) return null;
        if (!this.store(addr, size, old + s)) return null;
      } else {
        const v = cls === BPF.ST ? u64(BigInt(i.imm)) : this.readReg(i.src);
        if (v === null) return null;
        if (!this.store(addr, size, v)) return null;
      }
    } else if (cls === BPF.JMP || cls === BPF.JMP32) {
      const code = i.op & 0xf0;
      if (cls === BPF.JMP && code === BPF.EXIT) {
        if (this.readReg(0) === null) return null;
        this.status = "exit";
        return { pc, insn: i, changed };
      }
      if (cls === BPF.JMP && code === BPF.CALL) {
        this.call(i.imm);
        if (this.status !== "running") return null;
        changed.push(0, 1, 2, 3, 4, 5);
      } else if (cls === BPF.JMP && code === BPF.JA) {
        next = pc + 1 + i.off;
      } else {
        const d = this.readReg(i.dst);
        const s = (i.op & 8) !== 0 ? this.readReg(i.src) : u64(BigInt(i.imm));
        if (d === null || s === null) return null;
        const name = CMP_NAME[code];
        if (!name) { this.fail(`unknown opcode ${i.op}`); return null; }
        if (cmpEval(name, d, s, cls === BPF.JMP32)) next = pc + 1 + i.off;
      }
    } else {
      this.fail(`unknown opcode ${i.op}`);
      return null;
    }
    if (this.status === "running") this.pc = next;
    return { pc, insn: i, changed };
  }

  /** Run until the program stops, or until `maxSteps`. */
  run(maxSteps = 2_000_000): VmResult {
    while (this.status === "running") {
      if (this.steps >= maxSteps) {
        this.status = "budget";
        break;
      }
      this.step();
    }
    return { status: this.status, r0: this.regs[0], steps: this.steps, violation: this.violation };
  }
}

/** A map pointer is not memory that a program can read, so it has its own small range of values. */
export const MAP_PTR_BASE = 0x0f00_0000n;

export interface VmResult { status: VmStatus; r0: bigint | undefined; steps: number; violation: { pc: number; what: string } | null }

/** The fake addresses, for a test that compares a real value with the verifier's type. */
export const VM_BASES = { ctx: CTX_BASE, stackTop: STACK_BASE + BigInt(STACK_SIZE), packet: PKT_BASE, map: MAP_BASE, mapEnd: MAP_BASE + MAP_STEP * 256n } as const;
