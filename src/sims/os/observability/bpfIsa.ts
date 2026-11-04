/**
 * A real subset of the eBPF instruction set: the 8-byte encoding of include/uapi/linux/bpf.h and bpf_common.h,
 * a formatter, and a small assembler. Text follows the syntax of the kernel verifier log and of llvm-objdump.
 *
 * Index of an instruction = its slot. A 64-bit load uses two slots, as in the kernel, and jumps count slots.
 */

export const BPF = {
  LD: 0x00, LDX: 0x01, ST: 0x02, STX: 0x03, ALU: 0x04, JMP: 0x05, JMP32: 0x06, ALU64: 0x07,
  W: 0x00, H: 0x08, B: 0x10, DW: 0x18,
  IMM: 0x00, MEM: 0x60, ATOMIC: 0xc0,
  K: 0x00, X: 0x08,
  ADD: 0x00, SUB: 0x10, MUL: 0x20, DIV: 0x30, OR: 0x40, AND: 0x50, LSH: 0x60, RSH: 0x70, NEG: 0x80, MOD: 0x90, XOR: 0xa0, MOV: 0xb0, ARSH: 0xc0, END: 0xd0,
  JA: 0x00, JEQ: 0x10, JGT: 0x20, JGE: 0x30, JSET: 0x40, JNE: 0x50, JSGT: 0x60, JSGE: 0x70, CALL: 0x80, EXIT: 0x90, JLT: 0xa0, JLE: 0xb0, JSLT: 0xc0, JSLE: 0xd0,
  PSEUDO_MAP_FD: 1,
} as const;

/** One slot. For the first slot of a 64-bit load, `imm64` holds the whole value. The second slot has `filler`. */
export interface Insn { op: number; dst: number; src: number; off: number; imm: number; imm64?: bigint; filler?: boolean }

export type ProgType = "kprobe" | "xdp";
export interface MapDef { name: string; kind: "array" | "hash"; keySize: number; valueSize: number; maxEntries: number }
export interface BpfProgram { type: ProgType; maps: MapDef[]; insns: Insn[]; comments: (string | undefined)[]; lines: number[] }

export const STACK_SIZE = 512;
/** Real helper numbers from enum bpf_func_id. */
export const HELPERS = {
  1: "map_lookup_elem", 2: "map_update_elem", 3: "map_delete_elem", 5: "ktime_get_ns", 7: "get_prandom_u32", 8: "get_smp_processor_id", 14: "get_current_pid_tgid",
} as const;
export type HelperId = keyof typeof HELPERS;
export const HELPER_ID: Record<string, HelperId> = Object.fromEntries(Object.entries(HELPERS).map(([k, v]) => [v, Number(k) as HelperId]));

/** struct pt_regs on x86-64: the bytes that a kprobe program sees. */
export const PT_REGS = {
  size: 168,
  r15: 0, r14: 8, r13: 16, r12: 24, rbp: 32, rbx: 40, r11: 48, r10: 56, r9: 64, r8: 72, rax: 80, rcx: 88, rdx: 96, rsi: 104, rdi: 112, orig_rax: 120, rip: 128, cs: 136, eflags: 144, rsp: 152, ss: 160,
} as const;
/** struct xdp_md. The verifier rewrites the first two fields into real pointers. */
export const XDP_MD = { size: 24, data: 0, data_end: 4, data_meta: 8, ingress_ifindex: 12, rx_queue_index: 16, egress_ifindex: 20 } as const;
export const XDP_ACTION = { ABORTED: 0, DROP: 1, PASS: 2, TX: 3, REDIRECT: 4 } as const;

// ---------------------------------------------------------------------------- encoding

/** The 8 bytes of each slot, little-endian. The second slot of a 64-bit load carries the high 32 bits. */
export function encodeInsns(insns: Insn[]): Uint8Array {
  const out = new Uint8Array(insns.length * 8);
  const dv = new DataView(out.buffer);
  insns.forEach((i, k) => {
    out[k * 8] = i.op & 0xff;
    out[k * 8 + 1] = ((i.src & 0xf) << 4) | (i.dst & 0xf);
    dv.setInt16(k * 8 + 2, i.off, true);
    dv.setInt32(k * 8 + 4, i.imm, true);
  });
  return out;
}

export function decodeInsns(bytes: Uint8Array): Insn[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Insn[] = [];
  for (let k = 0; k + 8 <= bytes.length; k += 8) {
    const op = bytes[k]!, regs = bytes[k + 1]!;
    out.push({ op, dst: regs & 0xf, src: regs >> 4, off: dv.getInt16(k + 2, true), imm: dv.getInt32(k + 4, true) });
  }
  for (let k = 0; k < out.length; k++) {
    const i = out[k]!;
    if (i.op === (BPF.LD | BPF.DW | BPF.IMM) && k + 1 < out.length) {
      const hi = out[k + 1]!;
      i.imm64 = (BigInt(hi.imm >>> 0) << 32n) | BigInt(i.imm >>> 0);
      hi.filler = true;
      k++;
    }
  }
  return out;
}

export const hexOf = (i: Insn) => [...encodeInsns([i])].map((b) => b.toString(16).padStart(2, "0")).join(" ");

// ---------------------------------------------------------------------------- formatter

const ALU_TEXT: Record<number, string> = {
  [BPF.ADD]: "+=", [BPF.SUB]: "-=", [BPF.MUL]: "*=", [BPF.DIV]: "/=", [BPF.OR]: "|=", [BPF.AND]: "&=", [BPF.LSH]: "<<=", [BPF.RSH]: ">>=", [BPF.MOD]: "%=", [BPF.XOR]: "^=", [BPF.ARSH]: "s>>=",
};
const JMP_TEXT: Record<number, string> = {
  [BPF.JEQ]: "==", [BPF.JGT]: ">", [BPF.JGE]: ">=", [BPF.JSET]: "&", [BPF.JNE]: "!=", [BPF.JSGT]: "s>", [BPF.JSGE]: "s>=", [BPF.JLT]: "<", [BPF.JLE]: "<=", [BPF.JSLT]: "s<", [BPF.JSLE]: "s<=",
};
const SIZE_TEXT: Record<number, string> = { [BPF.B]: "u8", [BPF.H]: "u16", [BPF.W]: "u32", [BPF.DW]: "u64" };
export const SIZE_BYTES: Record<number, number> = { [BPF.B]: 1, [BPF.H]: 2, [BPF.W]: 4, [BPF.DW]: 8 };
const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
const mem = (base: number, off: number) => `(r${base} ${off < 0 ? "-" : "+"} ${Math.abs(off)})`;

export function formatInsn(i: Insn, maps: MapDef[] = []): string {
  if (i.filler) return "(second half of the 64-bit load)";
  const cls = i.op & 7;
  if (cls === BPF.ALU || cls === BPF.ALU64) {
    const r = cls === BPF.ALU64 ? "r" : "w";
    const code = i.op & 0xf0, x = (i.op & 8) !== 0;
    const src = x ? `${r}${i.src}` : `${i.imm}`;
    if (code === BPF.MOV) return `${r}${i.dst} = ${src}`;
    if (code === BPF.NEG) return `${r}${i.dst} = -${r}${i.dst}`;
    if (code === BPF.END) return `r${i.dst} = ${x ? "be" : "le"}${i.imm} r${i.dst}`;
    return `${r}${i.dst} ${ALU_TEXT[code] ?? "?="} ${src}`;
  }
  if (i.op === (BPF.LD | BPF.DW | BPF.IMM)) {
    if (i.src === BPF.PSEUDO_MAP_FD) return `r${i.dst} = map[${maps[i.imm]?.name ?? i.imm}] ll`;
    return `r${i.dst} = ${i.imm64 ?? BigInt(i.imm)} ll`;
  }
  const size = SIZE_TEXT[i.op & 0x18] ?? "?";
  if (cls === BPF.LDX) return `r${i.dst} = *(${size} *)${mem(i.src, i.off)}`;
  if (cls === BPF.ST) return `*(${size} *)${mem(i.dst, i.off)} = ${i.imm}`;
  if (cls === BPF.STX) {
    if ((i.op & 0xe0) === BPF.ATOMIC) return `lock *(${size} *)${mem(i.dst, i.off)} += r${i.src}`;
    return `*(${size} *)${mem(i.dst, i.off)} = r${i.src}`;
  }
  if (cls === BPF.JMP || cls === BPF.JMP32) {
    const code = i.op & 0xf0;
    if (cls === BPF.JMP && code === BPF.EXIT) return "exit";
    if (cls === BPF.JMP && code === BPF.CALL) return `call ${HELPERS[i.imm as HelperId] ?? i.imm}`;
    if (cls === BPF.JMP && code === BPF.JA) return `goto ${signed(i.off)}`;
    const r = cls === BPF.JMP ? "r" : "w";
    const rhs = (i.op & 8) !== 0 ? `${r}${i.src}` : `${i.imm}`;
    return `if ${r}${i.dst} ${JMP_TEXT[code] ?? "?"} ${rhs} goto ${signed(i.off)}`;
  }
  return `unknown opcode 0x${i.op.toString(16).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------- assembler

export type AsmResult = { ok: true; prog: BpfProgram } | { ok: false; line: number; error: string };

const ALU_OPS: Record<string, number> = Object.fromEntries(Object.entries(ALU_TEXT).map(([k, v]) => [v, Number(k)]));
const JMP_OPS: Record<string, number> = Object.fromEntries(Object.entries(JMP_TEXT).map(([k, v]) => [v, Number(k)]));
const SIZES: Record<string, number> = { u8: BPF.B, u16: BPF.H, u32: BPF.W, u64: BPF.DW };

const parseImm = (s: string): number | null => {
  if (!/^-?(0x[0-9a-f]+|\d+)$/i.test(s)) return null;
  const neg = s.startsWith("-");
  const n = Number(neg ? s.slice(1) : s);
  return neg ? -n : n;
};
const fitsImm = (n: number) => n >= -2147483648 && n <= 0xffffffff;
const toImm32 = (n: number) => (n > 0x7fffffff ? n - 0x100000000 : n);

const R = "([rw])(\\d+)";
const MEM = "\\*\\(\\s*(u8|u16|u32|u64)\\s*\\*\\s*\\)\\s*\\(\\s*r(\\d+)\\s*(?:([+-])\\s*(\\d+))?\\s*\\)";
const RE = {
  map: new RegExp(`^r(\\d+)\\s*=\\s*map\\[(\\w+)\\](?:\\s+ll)?$`, "i"),
  imm64: /^r(\d+)\s*=\s*(-?(?:0x[0-9a-f]+|\d+))\s+ll$/i,
  neg: new RegExp(`^${R}\\s*=\\s*-\\s*[rw](\\d+)$`, "i"),
  end: /^r(\d+)\s*=\s*(be|le)(16|32|64)\s+r(\d+)$/i,
  load: new RegExp(`^r(\\d+)\\s*=\\s*${MEM}$`, "i"),
  store: new RegExp(`^${MEM}\\s*=\\s*(r\\d+|-?(?:0x[0-9a-f]+|\\d+))$`, "i"),
  atomic: new RegExp(`^lock\\s+${MEM}\\s*\\+=\\s*r(\\d+)$`, "i"),
  mov: new RegExp(`^${R}\\s*=\\s*([rw]\\d+|-?(?:0x[0-9a-f]+|\\d+))$`, "i"),
  alu: new RegExp(`^${R}\\s*(\\+=|-=|\\*=|/=|%=|&=|\\|=|\\^=|<<=|>>=|s>>=)\\s*([rw]\\d+|-?(?:0x[0-9a-f]+|\\d+))$`, "i"),
  cond: new RegExp(`^if\\s+${R}\\s*(==|!=|>=|<=|>|<|s>=|s<=|s>|s<|&)\\s*([rw]\\d+|-?(?:0x[0-9a-f]+|\\d+))\\s+goto\\s+(\\S+)$`, "i"),
  ja: /^goto\s+(\S+)$/i,
  call: /^call\s+(\w+)$/i,
};

/**
 * Text to bytes and back to instructions, so that the verifier and the interpreter only see real encodings.
 * Directives: `.type kprobe|xdp` and `.map NAME array|hash key=K value=V entries=N`. Comments start with `;` or `//`.
 * Jump targets are labels, or +N and -N as a slot offset from the next instruction.
 */
export function assemble(src: string): AsmResult {
  const maps: MapDef[] = [];
  let type: ProgType = "kprobe";
  const pre: { text: string; line: number; comment?: string; slot: number }[] = [];
  const labels = new Map<string, number>();
  let slot = 0;
  const lines = src.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const rawLine = lines[n]!;
    const cut = rawLine.search(/;|\/\//);
    const comment = cut >= 0 ? rawLine.slice(cut).replace(/^(;|\/\/)\s*/, "").trim() : undefined;
    let text = (cut >= 0 ? rawLine.slice(0, cut) : rawLine).trim();
    if (!text) continue;
    if (text.startsWith(".type")) {
      const m = /^\.type\s+(kprobe|xdp)$/.exec(text);
      if (!m) return { ok: false, line: n + 1, error: "Write .type kprobe or .type xdp." };
      type = m[1] as ProgType;
      continue;
    }
    if (text.startsWith(".map")) {
      const m = /^\.map\s+(\w+)\s+(array|hash)\s+key=(\d+)\s+value=(\d+)\s+entries=(\d+)$/.exec(text);
      if (!m) return { ok: false, line: n + 1, error: "Write .map NAME array key=4 value=8 entries=1." };
      maps.push({ name: m[1]!, kind: m[2] as MapDef["kind"], keySize: Number(m[3]), valueSize: Number(m[4]), maxEntries: Math.min(4096, Number(m[5])) });
      continue;
    }
    const lab = /^([A-Za-z_]\w*):\s*(.*)$/.exec(text);
    if (lab) {
      labels.set(lab[1]!, slot);
      text = lab[2]!.trim();
      if (!text) continue;
    }
    pre.push({ text, line: n + 1, comment, slot });
    slot += /^r\d+\s*=\s*map\[/i.test(text) || /\sll$/i.test(text) ? 2 : 1;
  }
  const insns: Insn[] = [];
  const comments: (string | undefined)[] = [];
  const outLines: number[] = [];
  const fail = (line: number, error: string): AsmResult => ({ ok: false, line, error });
  for (const p of pre) {
    const t = p.text;
    const here = insns.length;
    const push = (i: Insn) => { insns.push(i); comments.push(p.comment); outLines.push(p.line); };
    const reg = (s: string) => Number(s);
    const target = (s: string): number | null => {
      if (/^[+-]\d+$/.test(s)) return Number(s);
      const l = labels.get(s);
      return l === undefined ? null : l - (here + 1);
    };
    let m: RegExpExecArray | null;
    if ((m = RE.map.exec(t))) {
      const k = maps.findIndex((x) => x.name === m![2]);
      if (k < 0) return fail(p.line, `There is no map named ${m[2]}. Add a .map line.`);
      push({ op: BPF.LD | BPF.DW | BPF.IMM, dst: reg(m[1]!), src: BPF.PSEUDO_MAP_FD, off: 0, imm: k });
      push({ op: 0, dst: 0, src: 0, off: 0, imm: 0 });
    } else if ((m = RE.imm64.exec(t))) {
      const neg = m[2]!.startsWith("-");
      const raw = BigInt(neg ? m[2]!.slice(1) : m[2]!);
      const v = BigInt.asUintN(64, neg ? -raw : raw);
      push({ op: BPF.LD | BPF.DW | BPF.IMM, dst: reg(m[1]!), src: 0, off: 0, imm: Number(BigInt.asIntN(32, v)) });
      push({ op: 0, dst: 0, src: 0, off: 0, imm: Number(BigInt.asIntN(32, v >> 32n)) });
    } else if ((m = RE.neg.exec(t))) {
      push({ op: (m[1]!.toLowerCase() === "r" ? BPF.ALU64 : BPF.ALU) | BPF.NEG, dst: reg(m[2]!), src: 0, off: 0, imm: 0 });
    } else if ((m = RE.end.exec(t))) {
      if (m[1] !== m[4]) return fail(p.line, "A byte swap works on one register.");
      push({ op: BPF.ALU | BPF.END | (m[2]!.toLowerCase() === "be" ? BPF.X : BPF.K), dst: reg(m[1]!), src: 0, off: 0, imm: Number(m[3]) });
    } else if ((m = RE.load.exec(t))) {
      const off = (m[4] === "-" ? -1 : 1) * Number(m[5] ?? 0);
      push({ op: BPF.LDX | BPF.MEM | SIZES[m[2]!]!, dst: reg(m[1]!), src: reg(m[3]!), off, imm: 0 });
    } else if ((m = RE.atomic.exec(t))) {
      const off = (m[3] === "-" ? -1 : 1) * Number(m[4] ?? 0);
      if (m[1] !== "u32" && m[1] !== "u64") return fail(p.line, "An atomic add must be u32 or u64.");
      push({ op: BPF.STX | BPF.ATOMIC | SIZES[m[1]!]!, dst: reg(m[2]!), src: reg(m[5]!), off, imm: BPF.ADD });
    } else if ((m = RE.store.exec(t))) {
      const off = (m[3] === "-" ? -1 : 1) * Number(m[4] ?? 0);
      const rhs = m[5]!;
      if (/^r/i.test(rhs)) {
        push({ op: BPF.STX | BPF.MEM | SIZES[m[1]!]!, dst: reg(m[2]!), src: reg(rhs.slice(1)), off, imm: 0 });
      } else {
        const v = parseImm(rhs)!;
        if (!fitsImm(v)) return fail(p.line, "This number does not fit in 32 bits.");
        push({ op: BPF.ST | BPF.MEM | SIZES[m[1]!]!, dst: reg(m[2]!), src: 0, off, imm: toImm32(v) });
      }
    } else if ((m = RE.mov.exec(t))) {
      const cls = m[1]!.toLowerCase() === "r" ? BPF.ALU64 : BPF.ALU;
      const rhs = m[3]!;
      if (/^[rw]/i.test(rhs)) push({ op: cls | BPF.MOV | BPF.X, dst: reg(m[2]!), src: reg(rhs.slice(1)), off: 0, imm: 0 });
      else {
        const v = parseImm(rhs)!;
        if (!fitsImm(v)) return fail(p.line, "This number does not fit in 32 bits. Add ll for a 64-bit load.");
        push({ op: cls | BPF.MOV | BPF.K, dst: reg(m[2]!), src: 0, off: 0, imm: toImm32(v) });
      }
    } else if ((m = RE.alu.exec(t))) {
      const cls = m[1]!.toLowerCase() === "r" ? BPF.ALU64 : BPF.ALU;
      const code = ALU_OPS[m[3]!]!;
      const rhs = m[4]!;
      if (/^[rw]/i.test(rhs)) push({ op: cls | code | BPF.X, dst: reg(m[2]!), src: reg(rhs.slice(1)), off: 0, imm: 0 });
      else {
        const v = parseImm(rhs)!;
        if (!fitsImm(v)) return fail(p.line, "This number does not fit in 32 bits.");
        push({ op: cls | code | BPF.K, dst: reg(m[2]!), src: 0, off: 0, imm: toImm32(v) });
      }
    } else if ((m = RE.cond.exec(t))) {
      const cls = m[1]!.toLowerCase() === "r" ? BPF.JMP : BPF.JMP32;
      const code = JMP_OPS[m[3]!]!;
      const rhs = m[4]!;
      const off = target(m[5]!);
      if (off === null) return fail(p.line, `There is no label named ${m[5]}.`);
      if (/^[rw]/i.test(rhs)) push({ op: cls | code | BPF.X, dst: reg(m[2]!), src: reg(rhs.slice(1)), off, imm: 0 });
      else {
        const v = parseImm(rhs)!;
        if (!fitsImm(v)) return fail(p.line, "This number does not fit in 32 bits.");
        push({ op: cls | code | BPF.K, dst: reg(m[2]!), src: 0, off, imm: toImm32(v) });
      }
    } else if ((m = RE.ja.exec(t))) {
      const off = target(m[1]!);
      if (off === null) return fail(p.line, `There is no label named ${m[1]}.`);
      push({ op: BPF.JMP | BPF.JA, dst: 0, src: 0, off, imm: 0 });
    } else if ((m = RE.call.exec(t))) {
      const id = /^\d+$/.test(m[1]!) ? Number(m[1]) : HELPER_ID[m[1]!];
      if (id === undefined) return fail(p.line, `There is no helper named ${m[1]}.`);
      push({ op: BPF.JMP | BPF.CALL, dst: 0, src: 0, off: 0, imm: id });
    } else if (/^exit$/i.test(t)) {
      push({ op: BPF.JMP | BPF.EXIT, dst: 0, src: 0, off: 0, imm: 0 });
    } else {
      return fail(p.line, `This line is not an instruction: ${t}`);
    }
  }
  // Round trip through the real bytes.
  const decoded = decodeInsns(encodeInsns(insns));
  return { ok: true, prog: { type, maps, insns: decoded, comments, lines: outLines } };
}

/** A program from raw instructions, for tests that fuzz the bytes. */
export function fromBytes(bytes: Uint8Array, type: ProgType, maps: MapDef[]): BpfProgram {
  const insns = decodeInsns(bytes);
  return { type, maps, insns, comments: insns.map(() => undefined), lines: insns.map((_, i) => i) };
}
