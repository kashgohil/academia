/**
 * A small x86-64 state model with the exact bit layouts of the architecture: control registers, MSRs,
 * GDT and IDT descriptors, the TSS, the syscall MSR encoding, the exception table and the double fault rules.
 * Sources: Intel SDM Vol. 3A chapters 2, 3, 6 and 7 (now 2, 3, 7 and 9 in some editions), AMD APM Vol. 2.
 * 64-bit values are bigint, because the top bits matter.
 */

// ---------------------------------------------------------------- control registers and MSRs

/** Bit positions in CR0. */
export const CR0 = { PE: 0, MP: 1, EM: 2, TS: 3, ET: 4, NE: 5, WP: 16, AM: 18, NW: 29, CD: 30, PG: 31 } as const;
/** Bit positions in CR4. */
export const CR4 = { PSE: 4, PAE: 5, MCE: 6, PGE: 7, OSFXSR: 9, OSXMMEXCPT: 10, UMIP: 11, LA57: 12, FSGSBASE: 16, PCIDE: 17, OSXSAVE: 18, SMEP: 20, SMAP: 21 } as const;
/** Bit positions in the EFER MSR. */
export const EFER = { SCE: 0, LME: 8, LMA: 10, NXE: 11 } as const;
/** Bit positions in RFLAGS that this module uses. */
export const RFLAGS = { CF: 0, FIXED: 1, TF: 8, IF: 9, DF: 10, NT: 14, RF: 16, AC: 18 } as const;

/** MSR numbers, as rdmsr and wrmsr take them in ecx. */
export const MSR = {
  EFER: 0xc0000080,
  STAR: 0xc0000081,
  LSTAR: 0xc0000082,
  CSTAR: 0xc0000083,
  SFMASK: 0xc0000084,
  FS_BASE: 0xc0000100,
  GS_BASE: 0xc0000101,
  KERNEL_GS_BASE: 0xc0000102,
} as const;

/** The architectural value of CR0 after a hardware reset: CD, NW and ET. */
export const RESET_CR0 = ((1 << CR0.CD) | (1 << CR0.NW) | (1 << CR0.ET)) >>> 0;
/** After reset, the CPU fetches from CS.base + IP = 0xFFFF0000 + 0xFFF0. */
export const RESET_CS_BASE = 0xffff0000;
export const RESET_IP = 0xfff0;
export const RESET_VECTOR = RESET_CS_BASE + RESET_IP;

export const setBit = (v: number, b: number) => (v | (1 << b)) >>> 0;
export const clearBit = (v: number, b: number) => (v & ~(1 << b)) >>> 0;
export const testBit = (v: number, b: number) => ((v >>> b) & 1) === 1;

/** Real-mode address: segment times 16 plus offset. Without the A20 gate, bit 20 wraps to 0. */
export function realAddr(seg: number, off: number, a20 = true): number {
  const a = (seg << 4) + off;
  return a20 ? a : a & 0xfffff;
}

// ---------------------------------------------------------------- GDT descriptors

/** Access byte bits. */
export const ACCESS = { A: 0, RW: 1, DC: 2, E: 3, S: 4, DPL0: 5, DPL1: 6, P: 7 } as const;
/** The flags nibble, as bits 0 to 3 of `flags` (descriptor bits 52 to 55). */
export const DFLAG = { AVL: 0, L: 1, DB: 2, G: 3 } as const;

export interface SegDesc {
  /** 32 bits. */
  base: number;
  /** 20 bits. */
  limit: number;
  /** Bits 40 to 47. */
  access: number;
  /** Bits 52 to 55. */
  flags: number;
}

/** Encodes a code or data descriptor to its 64-bit value. */
export function encodeDesc(d: SegDesc): bigint {
  const b = BigInt(d.base >>> 0), l = BigInt(d.limit & 0xfffff);
  return (l & 0xffffn)
    | ((b & 0xffffn) << 16n)
    | (((b >> 16n) & 0xffn) << 32n)
    | (BigInt(d.access & 0xff) << 40n)
    | (((l >> 16n) & 0xfn) << 48n)
    | (BigInt(d.flags & 0xf) << 52n)
    | (((b >> 24n) & 0xffn) << 56n);
}

export function decodeDesc(v: bigint): SegDesc {
  const n = (shift: bigint, mask: bigint) => Number((v >> shift) & mask);
  return {
    limit: n(0n, 0xffffn) | (n(48n, 0xfn) << 16),
    base: (n(16n, 0xffffn) | (n(32n, 0xffn) << 16) | (n(56n, 0xffn) << 24)) >>> 0,
    access: n(40n, 0xffn),
    flags: n(52n, 0xfn),
  };
}

const access = (o: { present?: boolean; dpl: number; system?: boolean; exec: boolean; rw: boolean; dc?: boolean; accessed?: boolean }) =>
  ((o.present === false ? 0 : 1) << ACCESS.P) | ((o.dpl & 3) << ACCESS.DPL0) | ((o.system ? 0 : 1) << ACCESS.S) | ((o.exec ? 1 : 0) << ACCESS.E) | ((o.dc ? 1 : 0) << ACCESS.DC) | ((o.rw ? 1 : 0) << ACCESS.RW) | ((o.accessed ? 1 : 0) << ACCESS.A);

/** A flat 64-bit code segment: L = 1, D = 0, G = 1. The CPU ignores base and limit in 64-bit mode. */
export const code64 = (dpl: number): SegDesc => ({ base: 0, limit: 0xfffff, access: access({ dpl, exec: true, rw: true }), flags: (1 << DFLAG.G) | (1 << DFLAG.L) });
/** A flat 32-bit code segment: L = 0, D = 1, G = 1. */
export const code32 = (dpl: number): SegDesc => ({ base: 0, limit: 0xfffff, access: access({ dpl, exec: true, rw: true }), flags: (1 << DFLAG.G) | (1 << DFLAG.DB) });
/** A flat data segment. */
export const data32 = (dpl: number): SegDesc => ({ base: 0, limit: 0xfffff, access: access({ dpl, exec: false, rw: true }), flags: (1 << DFLAG.G) | (1 << DFLAG.DB) });

/** The bits of a descriptor, grouped for views. */
export type DescField = "limit" | "base" | "A" | "RW" | "DC" | "E" | "S" | "DPL" | "P" | "AVL" | "L" | "DB" | "G";
export function descFieldOfBit(bit: number): DescField {
  if (bit < 16 || (bit >= 48 && bit < 52)) return "limit";
  if ((bit >= 16 && bit < 40) || bit >= 56) return "base";
  const names: DescField[] = ["A", "RW", "DC", "E", "S", "DPL", "DPL", "P"];
  if (bit >= 40 && bit < 48) return names[bit - 40]!;
  return (["AVL", "L", "DB", "G"] as DescField[])[bit - 52]!;
}

export const DESC_FIELD_INFO: Record<DescField, string> = {
  limit: "Segment size. Bits 0 to 15 and 48 to 51. Ignored for code and data in 64-bit mode.",
  base: "Segment start. Bits 16 to 39 and 56 to 63. Ignored for code, data and stack in 64-bit mode, except FS and GS through their MSRs.",
  A: "Accessed. The CPU sets it when it loads the segment. If the GDT is in read-only memory, this write faults, so preset the bit.",
  RW: "For code: reads are allowed. For data: writes are allowed.",
  DC: "For code: conforming. For data: grows down. Keep it 0 here.",
  E: "Executable. 1 is code and 0 is data.",
  S: "1 is a code or data segment. 0 is a system segment, such as a TSS.",
  DPL: "Descriptor privilege level, 0 to 3. A user code segment has 3.",
  P: "Present. If it is 0, a load raises #NP.",
  AVL: "Free for software. The CPU ignores it.",
  L: "64-bit code. With L = 1, D must be 0.",
  DB: "Default size. For code, 1 means 32-bit operands in 32-bit mode.",
  G: "Granularity. 1 means that the limit counts 4 KiB units.",
};

export interface DescCheck { ok: boolean; kind: string; problems: string[] }

/** What the CPU would make of this descriptor, for the encoder demo. */
export function describeDesc(d: SegDesc): DescCheck {
  const a = d.access, f = d.flags;
  const P = (a >> ACCESS.P) & 1, S = (a >> ACCESS.S) & 1, E = (a >> ACCESS.E) & 1, dpl = (a >> ACCESS.DPL0) & 3;
  const L = (f >> DFLAG.L) & 1, DB = (f >> DFLAG.DB) & 1;
  const problems: string[] = [];
  if (!P) problems.push("P = 0: loading this selector raises #NP.");
  if (!S) return { ok: false, kind: "system descriptor (S = 0)", problems: [...problems, "A system descriptor is not a code or data segment. In long mode a TSS descriptor takes 16 bytes."] };
  if (E && L && DB) problems.push("L = 1 and D = 1 together are reserved. Loading this into CS raises #GP.");
  const ring = `ring ${dpl}`;
  let kind: string;
  if (E) kind = L ? `64-bit code, ${ring}` : DB ? `32-bit code, ${ring}` : `16-bit code, ${ring}`;
  else kind = `data, ${ring}`;
  return { ok: problems.length === 0, kind, problems };
}

/** The 16-byte long-mode TSS descriptor: type 9 (available 64-bit TSS). `lo` goes first in the GDT. */
export function encodeTssDesc(base: bigint, limit = TSS_SIZE - 1): { lo: bigint; hi: bigint } {
  const b = base & ((1n << 64n) - 1n);
  const l = BigInt(limit);
  const lo = (l & 0xffffn)
    | ((b & 0xffffn) << 16n)
    | (((b >> 16n) & 0xffn) << 32n)
    | (0x89n << 40n)
    | (((l >> 16n) & 0xfn) << 48n)
    | (((b >> 24n) & 0xffn) << 56n);
  return { lo, hi: (b >> 32n) & 0xffffffffn };
}

export function decodeTssDesc(lo: bigint, hi: bigint): { base: bigint; limit: number; type: number; present: boolean } {
  const n = (shift: bigint, mask: bigint) => (lo >> shift) & mask;
  return {
    limit: Number(n(0n, 0xffffn) | (n(48n, 0xfn) << 16n)),
    base: n(16n, 0xffffn) | (n(32n, 0xffn) << 16n) | (n(56n, 0xffn) << 24n) | ((hi & 0xffffffffn) << 32n),
    type: Number(n(40n, 0xfn)),
    present: n(47n, 1n) === 1n,
  };
}

/** Byte offsets in the 64-bit TSS. */
export const TSS_OFF = { RSP0: 4, RSP1: 12, RSP2: 20, IST1: 36, IST7: 84, IOPB: 102 } as const;
export const TSS_SIZE = 104;

/** A GDT layout that fits syscall and sysret. A TinyOS selector is the index times 8, plus the RPL. */
export const TINY_GDT = [
  { name: "null", sel: 0x00, desc: null as SegDesc | null },
  { name: "kernel code", sel: 0x08, desc: code64(0) },
  { name: "kernel data", sel: 0x10, desc: data32(0) },
  { name: "user data", sel: 0x18, desc: data32(3) },
  { name: "user code", sel: 0x20, desc: code64(3) },
] as const;
export const SEL = { KCODE: 0x08, KDATA: 0x10, UDATA: 0x18 | 3, UCODE: 0x20 | 3, TSS: 0x28 } as const;

// ---------------------------------------------------------------- IDT gates

export const GATE_INTERRUPT = 0xe;
export const GATE_TRAP = 0xf;
export const IDT_ENTRIES = 256;
export const GATE_BYTES = 16;

export interface Gate {
  offset: bigint;
  selector: number;
  /** 0 to 7. 0 means no IST switch. */
  ist: number;
  /** 0xE clears IF on entry. 0xF does not. */
  type: number;
  dpl: number;
  present: boolean;
}

/** Encodes a 16-byte long-mode gate into two 64-bit words. */
export function encodeGate(g: Gate): { lo: bigint; hi: bigint } {
  const o = g.offset & ((1n << 64n) - 1n);
  const lo = (o & 0xffffn)
    | (BigInt(g.selector & 0xffff) << 16n)
    | (BigInt(g.ist & 7) << 32n)
    | (BigInt(g.type & 0xf) << 40n)
    | (BigInt(g.dpl & 3) << 45n)
    | ((g.present ? 1n : 0n) << 47n)
    | (((o >> 16n) & 0xffffn) << 48n);
  return { lo, hi: (o >> 32n) & 0xffffffffn };
}

export function decodeGate(lo: bigint, hi: bigint): Gate {
  const n = (shift: bigint, mask: bigint) => (lo >> shift) & mask;
  return {
    offset: n(0n, 0xffffn) | (n(48n, 0xffffn) << 16n) | ((hi & 0xffffffffn) << 32n),
    selector: Number(n(16n, 0xffffn)),
    ist: Number(n(32n, 7n)),
    type: Number(n(40n, 0xfn)),
    dpl: Number(n(45n, 3n)),
    present: n(47n, 1n) === 1n,
  };
}

/** The little-endian bytes of a 64-bit word. */
export function bytesLE(v: bigint, n = 8): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  return out;
}

export const hex64 = (v: bigint) => `0x${(v & ((1n << 64n) - 1n)).toString(16).toUpperCase().padStart(16, "0")}`;
export const hexN = (v: number | bigint, digits = 0) => `0x${v.toString(16).toUpperCase().padStart(digits, "0")}`;

// ---------------------------------------------------------------- exceptions

export type FaultClass = "benign" | "contributory" | "page";

export interface ExcInfo { vector: number; mnemonic: string; name: string; errorCode: boolean; cls: FaultClass }

/** The architectural exceptions that a small kernel meets. Vectors 0 to 31 are reserved for them. */
export const EXCEPTIONS: ExcInfo[] = [
  { vector: 0, mnemonic: "#DE", name: "Divide error", errorCode: false, cls: "contributory" },
  { vector: 1, mnemonic: "#DB", name: "Debug", errorCode: false, cls: "benign" },
  { vector: 2, mnemonic: "NMI", name: "Non-maskable interrupt", errorCode: false, cls: "benign" },
  { vector: 3, mnemonic: "#BP", name: "Breakpoint", errorCode: false, cls: "benign" },
  { vector: 4, mnemonic: "#OF", name: "Overflow", errorCode: false, cls: "benign" },
  { vector: 5, mnemonic: "#BR", name: "Bound range", errorCode: false, cls: "benign" },
  { vector: 6, mnemonic: "#UD", name: "Invalid opcode", errorCode: false, cls: "benign" },
  { vector: 7, mnemonic: "#NM", name: "Device not available", errorCode: false, cls: "benign" },
  { vector: 8, mnemonic: "#DF", name: "Double fault", errorCode: true, cls: "benign" },
  { vector: 10, mnemonic: "#TS", name: "Invalid TSS", errorCode: true, cls: "contributory" },
  { vector: 11, mnemonic: "#NP", name: "Segment not present", errorCode: true, cls: "contributory" },
  { vector: 12, mnemonic: "#SS", name: "Stack fault", errorCode: true, cls: "contributory" },
  { vector: 13, mnemonic: "#GP", name: "General protection", errorCode: true, cls: "contributory" },
  { vector: 14, mnemonic: "#PF", name: "Page fault", errorCode: true, cls: "page" },
  { vector: 16, mnemonic: "#MF", name: "x87 floating point", errorCode: false, cls: "benign" },
  { vector: 17, mnemonic: "#AC", name: "Alignment check", errorCode: true, cls: "benign" },
  { vector: 18, mnemonic: "#MC", name: "Machine check", errorCode: false, cls: "benign" },
  { vector: 19, mnemonic: "#XM", name: "SIMD floating point", errorCode: false, cls: "benign" },
  { vector: 21, mnemonic: "#CP", name: "Control protection", errorCode: true, cls: "benign" },
];

export const VEC = { DE: 0, BP: 3, UD: 6, DF: 8, TS: 10, NP: 11, SS: 12, GP: 13, PF: 14 } as const;

export const excInfo = (v: number): ExcInfo => EXCEPTIONS.find((e) => e.vector === v) ?? { vector: v, mnemonic: `IRQ vector ${v}`, name: "External interrupt", errorCode: false, cls: "benign" };
/** Vectors in the table that push an error code. */
export const vectorsWithErrorCode = () => EXCEPTIONS.filter((e) => e.errorCode).map((e) => e.vector);

export type SecondOutcome = "serial" | "double" | "triple";

/**
 * Intel SDM table "Conditions for Generating a Double Fault". The first exception is being delivered
 * when the second one arrives. A second exception after the handler has started is a new exception, not this case.
 */
export function secondException(first: number, second: number): SecondOutcome {
  const a = excInfo(first).cls, b = excInfo(second).cls;
  if (first === VEC.DF) return b === "benign" ? "serial" : "triple";
  if (a === "contributory" && b === "contributory") return "double";
  if (a === "page" && (b === "contributory" || b === "page")) return "double";
  return "serial";
}

// ---------------------------------------------------------------- syscall MSRs

/** STAR: bits 32 to 47 hold the kernel CS. Bits 48 to 63 hold the base for sysret. */
export const starValue = (kernelCs: number, sysretBase: number) => (BigInt(sysretBase & 0xffff) << 48n) | (BigInt(kernelCs & 0xffff) << 32n);
/** What syscall loads: CS = STAR[47:32], SS = that plus 8. */
export const syscallSelectors = (star: bigint) => { const k = Number((star >> 32n) & 0xffffn); return { cs: k & 0xfffc, ss: (k + 8) & 0xfffc }; };
/** What 64-bit sysret loads: CS = STAR[63:48] + 16 with RPL 3, SS = STAR[63:48] + 8 with RPL 3. */
export const sysretSelectors = (star: bigint) => { const b = Number((star >> 48n) & 0xffffn); return { cs: (b + 16) | 3, ss: (b + 8) | 3 }; };
/** TinyOS: base 0x10 gives SS 0x1B and CS 0x23, which is the order of TINY_GDT. */
export const TINY_STAR = starValue(SEL.KCODE, 0x10);
/** Flags that syscall clears: IF, TF, DF and AC. */
export const TINY_SFMASK = ((1 << RFLAGS.IF) | (1 << RFLAGS.TF) | (1 << RFLAGS.DF) | (1 << RFLAGS.AC)) >>> 0;

// ---------------------------------------------------------------- interrupt controllers

/** The legacy PIC after the BIOS: IRQ 0 to 7 at vectors 8 to 15. Remapped kernels use 32 and up. */
export const PIC = { MASTER_CMD: 0x20, MASTER_DATA: 0x21, SLAVE_CMD: 0xa0, SLAVE_DATA: 0xa1, EOI: 0x20, BIOS_OFFSET: 8, REMAP_OFFSET: 32 } as const;
export const picVector = (irq: number, offset: number = PIC.BIOS_OFFSET) => offset + irq;
/** Local APIC MMIO registers: default base and offsets. */
export const LAPIC = { BASE: 0xfee00000, EOI: 0xb0, SVR: 0xf0, LVT_TIMER: 0x320, TIMER_INIT: 0x380, TIMER_CUR: 0x390, TIMER_DIV: 0x3e0 } as const;
