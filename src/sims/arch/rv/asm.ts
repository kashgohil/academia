/**
 * A two-pass assembler for RV32IM with the syntax of GNU as for RISC-V (and the LLVM integrated assembler).
 *
 * - Pass 1 splits each line into labels and one statement, gives every statement its section and offset, and records
 *   the labels. Every size is known in pass 1: `li` needs a constant, so its size (1 or 2 words) is fixed.
 * - Pass 2 evaluates operands, expands pseudo-instructions and encodes. All errors are collected with their line.
 *
 * Syntax:
 * - Comments start with `#` or `//`. Labels are `name:`; several may precede a statement on one line.
 * - Sections: `.text` and `.data` (`.section .text|.data|.rodata|.bss` also work; rodata and bss go to data).
 * - Data: `.word .half .byte` (comma lists of expressions; `.word` may name a label), `.ascii`, `.asciz`/`.string`,
 *   `.space`/`.zero n`. `.align n` aligns to 2^n bytes (as GNU as does on RISC-V), `.p2align n` too, `.balign n` to n
 *   bytes; in .text the padding is nops. `.word` and `.half` do not align by themselves (as in GNU as): a word after
 *   a 3-byte string is misaligned, and `lw` on it traps. `.equ`/`.set name, value` define constants. `.globl` and
 *   `.global` are ignored. In .text, only instructions (and `.word` of a legal instruction) are allowed.
 * - Literals: decimal, negative, 0x hex, 0b binary, characters ('a', '\n'). Expressions: + and - of literals, labels
 *   and `.` (the current address), with `%hi(x)`, `%lo(x)`, `%pcrel_hi(sym)` and `%pcrel_lo(label)` where label marks
 *   the auipc that holds the matching %pcrel_hi.
 * - Branch and jump targets: an expression that names a label or `.` is an address; a plain number is the byte offset
 *   from the instruction, as in LLVM (`beq a0, a1, 8` skips one instruction). The offset must fit and be a multiple of 4
 *   (no C extension, so a target that is not 4-byte aligned would trap).
 * - Pseudo-instructions, expanded as in the RISC-V Assembly Programmer's Manual: nop, li, la, mv, not, neg, seqz,
 *   snez, sltz, sgtz, beqz, bnez, blez, bgez, bltz, bgtz, bgt, ble, bgtu, bleu, j, jal label (rd = ra), jr, jalr rs,
 *   ret, call (auipc ra + jalr ra), tail (auipc t1 + jalr x0). `li` is one addi when the value fits in 12 bits, else
 *   lui + addi, where lui takes (v + 0x800) >> 12 so that the sign-extended addi lands on v (no addi when the low
 *   12 bits are 0). GNU as does the same; LLVM may pick another two-instruction sequence (2048 becomes addi + slli).
 *   `la` is always auipc + addi (position independent).
 *
 * Memory layout (the hart loads it so): text at `textBase` (default 0x0000_0000), data at `dataBase` (default 0x1000,
 * moved up to the next 4 KiB boundary after the text if the text is larger). `entry` is the label `_start` if there is
 * one, else textBase.
 */
import { decode, encode, formatOf, immFits, immRange, OPS, parseReg, signExtend, type Inst, type Mnemonic, MNEMONICS } from "./isa";

export interface AsmError { line: number; message: string }

export interface Program {
  textBase: number;
  /** The machine words of .text, in order. words[i] is at textBase + 4i. */
  words: number[];
  insts: Inst[];
  /** The 1-based source line of each word. A pseudo-instruction gives several words with the same line. */
  src: number[];
  /** All labels (text and data) with their addresses. */
  labels: Record<string, number>;
  data: Uint8Array;
  dataBase: number;
  entry: number;
  /** The source, split into lines (lines[0] is line 1). */
  lines: string[];
}

export interface AsmResult { ok: boolean; program: Program; errors: AsmError[] }
export interface AsmOptions { textBase?: number; dataBase?: number }

type Section = "text" | "data";
interface Stmt { line: number; section: Section; offset: number; name: string; args: string[]; size: number; addr: number }

export const DEFAULT_TEXT_BASE = 0x0;
export const DEFAULT_DATA_BASE = 0x1000;

const PSEUDO_SIZE: Record<string, number> = {
  nop: 1, mv: 1, not: 1, neg: 1, seqz: 1, snez: 1, sltz: 1, sgtz: 1, beqz: 1, bnez: 1, blez: 1, bgez: 1, bltz: 1, bgtz: 1,
  bgt: 1, ble: 1, bgtu: 1, bleu: 1, j: 1, jr: 1, ret: 1, la: 2, call: 2, tail: 2,
};
const IS_OP = new Set<string>(MNEMONICS);

class AsmFail extends Error {}
const fail = (msg: string): never => { throw new AsmFail(msg); };

// ---------------------------------------------------------------- lexing

/** The line without its comment. `#` and `//` inside quotes do not start a comment. */
function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" || (c === "/" && line[i + 1] === "/")) return line.slice(0, i);
  }
  return line;
}

/** Split operands at commas that are outside quotes and parentheses. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, q: string | null = null, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) { cur += c; if (c === "\\") cur += s[++i] ?? ""; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "" || out.length) out.push(cur.trim());
  return out;
}

const ESC: Record<string, number> = { n: 10, t: 9, r: 13, "0": 0, "\\": 92, '"': 34, "'": 39, a: 7, b: 8, f: 12, v: 11 };

/** The bytes of a quoted string literal, with escapes \n \t \r \0 \\ \" \' \xNN. Non-ASCII characters become UTF-8. */
function parseString(s: string): number[] {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s.trim());
  if (!m) return fail(`expected a string in double quotes, got ${s}`);
  const body = m[1]!, out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") { out.push(...new TextEncoder().encode(c)); continue; }
    const e = body[++i]!;
    if (e === "x") { const h = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1))![0]; out.push(parseInt(h, 16)); i += h.length; }
    else if (e in ESC) out.push(ESC[e]!);
    else fail(`unknown escape \\${e}`);
  }
  return out;
}

// ---------------------------------------------------------------- expressions

interface Ctx {
  /** Label and constant values; undefined while a label is not known yet (pass 1). */
  sym: (name: string) => number | undefined;
  /** True for a .equ constant: it is a number, not an address. */
  isConst?: (name: string) => boolean;
  /** The address of the statement (for `.` and pc-relative operands). */
  pc: number;
  /** %pcrel_lo(label): the low part of the %pcrel_hi at that auipc. */
  pcrelLo: (label: number) => number;
}
interface Val { value: number; sym: boolean }

const hi20 = (v: number) => ((v + 0x800) >>> 12) & 0xfffff;
const lo12 = (v: number) => signExtend(v & 0xfff, 12);

function evalExpr(text: string, ctx: Ctx): Val {
  const s = text.trim();
  let i = 0, sym = false;
  const ws = () => { while (s[i] === " " || s[i] === "\t") i++; };
  const term = (): number => {
    ws();
    const c = s[i];
    if (c === "-") { i++; return -term(); }
    if (c === "+") { i++; return term(); }
    if (c === "(") { i++; const v = expr(); ws(); if (s[i] !== ")") fail(`missing ) in ${text}`); i++; return v; }
    if (c === "%") {
      const m = /^%(hi|lo|pcrel_hi|pcrel_lo)\(/.exec(s.slice(i));
      if (!m) return fail(`unknown operator in ${text} (use %hi, %lo, %pcrel_hi or %pcrel_lo)`);
      i += m[0].length;
      const v = expr();
      ws();
      if (s[i] !== ")") fail(`missing ) in ${text}`);
      i++;
      sym = false;
      switch (m[1]) {
        case "hi": return hi20(v);
        case "lo": return lo12(v);
        case "pcrel_hi": return hi20(v - ctx.pc);
        default: return ctx.pcrelLo(v);
      }
    }
    if (c === "'") {
      const m = /^'(\\x[0-9a-fA-F]{1,2}|\\.|[^\\'])'/.exec(s.slice(i));
      if (!m) return fail(`bad character literal in ${text}`);
      i += m[0].length;
      const b = m[1]!;
      if (b.startsWith("\\x")) return parseInt(b.slice(2), 16);
      if (b.startsWith("\\")) { const e = ESC[b[1]!]; return e === undefined ? fail(`unknown escape ${b}`) : e; }
      return b.codePointAt(0)!;
    }
    const num = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*)\b/.exec(s.slice(i));
    if (num) { i += num[0].length; return Number(num[0].replace(/_/g, "")); }
    if (c === "." && !/[\w.$]/.test(s[i + 1] ?? "")) { i++; sym = true; return ctx.pc; }
    const id = /^[A-Za-z_.$][\w.$]*/.exec(s.slice(i));
    if (id) {
      i += id[0].length;
      const v = ctx.sym(id[0]);
      if (v === undefined) return fail(parseReg(id[0]) !== null ? `expected a number or label, got register ${id[0]}` : `unknown label or constant '${id[0]}'`);
      if (!ctx.isConst?.(id[0])) sym = true;
      return v;
    }
    return fail(s === "" ? "missing operand" : `cannot read '${s.slice(i) || s}' as a number or label`);
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      ws();
      if (s[i] === "+") { i++; v += term(); }
      else if (s[i] === "-") { i++; v -= term(); }
      else return v;
    }
  };
  const value = expr();
  ws();
  if (i < s.length) fail(`unexpected '${s.slice(i)}' in ${text}`);
  return { value, sym };
}

// ---------------------------------------------------------------- the assembler

/** Assemble source text into a Program. Never throws: errors come back with their line numbers, and ok is false. */
export function assemble(source: string, opts: AsmOptions = {}): AsmResult {
  const lines = source.split(/\r?\n/);
  const errors: AsmError[] = [];
  const err = (line: number, e: unknown) => {
    if (e instanceof AsmFail || e instanceof RangeError) errors.push({ line, message: e.message });
    else throw e;
  };
  const textBase = opts.textBase ?? DEFAULT_TEXT_BASE;
  const stmts: Stmt[] = [];
  const labelAt: { name: string; section: Section; offset: number; line: number }[] = [];
  const consts: Record<string, number> = {};
  const off: Record<Section, number> = { text: 0, data: 0 };
  let section: Section = "text";

  // ---- pass 1
  const constCtx = (pc: number): Ctx => ({ sym: (n) => consts[n], isConst: () => true, pc, pcrelLo: () => fail("%pcrel_lo needs a label") });
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    let rest = stripComment(raw).trim();
    try {
      for (let m; (m = /^([A-Za-z_.$][\w.$]*)\s*:/.exec(rest)); rest = rest.slice(m[0].length).trim()) {
        const name = m[1]!;
        if (labelAt.some((l) => l.name === name) || name in consts) fail(`label '${name}' is defined twice`);
        if (parseReg(name) !== null) fail(`'${name}' is a register name and cannot be a label`);
        labelAt.push({ name, section, offset: off[section], line });
      }
      if (rest === "") return;
      const sp = /^(\S+)\s*(.*)$/.exec(rest)!;
      const name = sp[1]!.toLowerCase(), args = splitArgs(sp[2]!);
      const st: Stmt = { line, section, offset: off[section], name, args, size: 0, addr: 0 };
      if (name.startsWith(".")) {
        switch (name) {
          case ".text": section = "text"; return;
          case ".data": section = "data"; return;
          case ".section": {
            const s = args[0] ?? "";
            if (/^\.text/.test(s)) section = "text";
            else if (/^\.(data|rodata|bss|sdata|sbss)/.test(s)) section = "data";
            else fail(`unknown section ${s}`);
            return;
          }
          case ".globl": case ".global": case ".type": case ".size": case ".option": case ".file": return;
          case ".equ": case ".set": {
            if (args.length !== 2 || !/^[A-Za-z_.$][\w.$]*$/.test(args[0]!)) fail(`${name} expects: name, value`);
            consts[args[0]!] = evalExpr(args[1]!, constCtx(0)).value;
            return;
          }
          case ".align": case ".p2align": case ".balign": {
            const n = evalExpr(args[0] ?? "", constCtx(0)).value;
            const a = name === ".balign" ? n : 2 ** n;
            if (!(a >= 1 && a <= 4096 && (a & (a - 1)) === 0)) fail(`${name} needs a power of two up to 4096`);
            const pad = (a - (off[section] % a)) % a;
            if (section === "text" && pad % 4 !== 0) fail(".text is always 4-byte aligned; align to 4 or more");
            st.size = pad;
            break;
          }
          case ".word": case ".half": case ".byte": case ".2byte": case ".4byte": case ".short": case ".long": {
            const unit = name === ".byte" ? 1 : name === ".half" || name === ".2byte" || name === ".short" ? 2 : 4;
            if (args.length === 0 || args.some((a) => a === "")) fail(`${name} needs a list of values`);
            if (section === "text" && unit !== 4) fail(`${name} in .text: only instructions and .word are allowed there`);
            st.size = unit * args.length;
            break;
          }
          case ".ascii": case ".asciz": case ".string": {
            if (section === "text") fail(`${name} belongs in .data`);
            st.size = args.reduce((n, a) => n + parseString(a).length + (name === ".ascii" ? 0 : 1), 0);
            break;
          }
          case ".space": case ".zero": case ".skip": {
            if (section === "text") fail(`${name} belongs in .data`);
            const n = evalExpr(args[0] ?? "", constCtx(0)).value;
            if (!(n >= 0 && n <= 1 << 20)) fail(`${name} size must be 0..1048576`);
            st.size = n;
            break;
          }
          default: fail(`unknown directive ${name}`);
        }
      } else {
        if (section !== "text") fail(`instruction '${name}' in .data: write .text before code`);
        if (name === "li") {
          if (args.length !== 2) fail("li expects 2 operands: rd, value");
          const v = liValue(args[1]!, constCtx(0));
          st.size = 4 * ((v >= -2048 && v <= 2047) || lo12(v) === 0 ? 1 : 2);
        } else if (IS_OP.has(name) || name in PSEUDO_SIZE) st.size = 4 * (PSEUDO_SIZE[name] ?? 1);
        else fail(`unknown instruction '${name}'`);
      }
      stmts.push(st);
      off[section] += st.size;
    } catch (e) { err(line, e); }
  });

  // ---- layout
  const textEnd = textBase + off.text;
  let dataBase = opts.dataBase ?? Math.max(DEFAULT_DATA_BASE, Math.ceil(textEnd / 0x1000) * 0x1000);
  if (opts.dataBase !== undefined && off.data > 0 && dataBase < textEnd && dataBase + off.data > textBase) {
    errors.push({ line: 1, message: `data at 0x${dataBase.toString(16)} overlaps the text (0x${textBase.toString(16)}..0x${textEnd.toString(16)})` });
  }
  dataBase >>>= 0;
  const base = (s: Section) => (s === "text" ? textBase : dataBase);
  const labels: Record<string, number> = {};
  for (const l of labelAt) labels[l.name] = base(l.section) + l.offset;
  for (const st of stmts) st.addr = base(st.section) + st.offset;
  const stmtAt = new Map<number, Stmt>();
  for (const st of stmts) if (st.section === "text" && st.size > 0) stmtAt.set(st.addr, st);
  const symbol = (n: string) => (n in labels ? labels[n] : consts[n]);
  const isConst = (n: string) => !(n in labels) && n in consts;

  // ---- pass 2
  const words: number[] = [], insts: Inst[] = [], src: number[] = [];
  const data = new Uint8Array(off.data);
  const dv = new DataView(data.buffer);
  const ctxAt = (pc: number): Ctx => ({
    sym: symbol, isConst, pc,
    pcrelLo: (at) => {
      const hiSt = stmtAt.get(at);
      const m = hiSt && hiSt.name === "auipc" ? /^%pcrel_hi\((.*)\)$/.exec(hiSt.args[1]?.trim() ?? "") : null;
      if (!m) return fail(`%pcrel_lo must name the label of an auipc with %pcrel_hi`);
      return lo12(evalExpr(m[1]!, ctxAt(at)).value - at);
    },
  });
  for (const st of stmts) {
    try {
      const ctx = ctxAt(st.addr);
      if (st.section === "text") {
        const out = st.name.startsWith(".") ? textDirective(st, ctx) : expand(st.name, st.args, ctx);
        if (out.length * 4 !== st.size) fail(`internal: size of ${st.name} changed between passes`);
        for (const inst of out) { words.push(encode(inst)); insts.push(inst); src.push(st.line); }
      } else dataDirective(st, ctx, data, dv, st.offset);
    } catch (e) {
      err(st.line, e);
      if (st.section === "text") for (let k = 0; k < st.size / 4; k++) { words.push(0x13); insts.push(nopInst()); src.push(st.line); }
    }
  }
  errors.sort((a, b) => a.line - b.line);
  return {
    ok: errors.length === 0,
    errors,
    program: { textBase, words, insts, src, labels, data, dataBase, entry: labels._start ?? textBase, lines },
  };
}

const nopInst = (): Inst => ({ op: "addi", rd: 0, rs1: 0, rs2: 0, imm: 0 });

/** The value of li's operand as a 32-bit number. It must be a constant. Values up to 0xFFFFFFFF are taken mod 2^32. */
function liValue(arg: string, ctx: Ctx): number {
  const sym = (n: string) => ctx.sym(n) ?? fail(`li needs a constant, and '${n}' is not a .equ constant (use la for the address of a label)`);
  const v = evalExpr(arg, { ...ctx, sym, pcrelLo: () => fail("li needs a constant") });
  if (v.sym) fail("li needs a constant; use la for the address of a label");
  if (!(v.value >= -0x80000000 && v.value <= 0xffffffff)) fail(`li value ${v.value} does not fit in 32 bits`);
  return v.value | 0;
}

function textDirective(st: Stmt, ctx: Ctx): Inst[] {
  if (st.name === ".word" || st.name === ".4byte" || st.name === ".long") {
    return st.args.map((a) => {
      const w = evalExpr(a, ctx).value >>> 0;
      return decode(w) ?? fail(`.word 0x${w.toString(16)} in .text is not an RV32IM instruction`);
    });
  }
  return Array.from({ length: st.size / 4 }, nopInst); // .align padding
}

function dataDirective(st: Stmt, ctx: Ctx, data: Uint8Array, dv: DataView, at: number) {
  switch (st.name) {
    case ".align": case ".p2align": case ".balign": case ".space": case ".zero": case ".skip": {
      const fill = st.name.startsWith(".s") || st.name === ".zero" ? (st.args[1] ? evalExpr(st.args[1], ctx).value & 0xff : 0) : 0;
      data.fill(fill, at, at + st.size);
      return;
    }
    case ".ascii": case ".asciz": case ".string":
      for (const a of st.args) {
        const b = parseString(a);
        data.set(b, at);
        at += b.length;
        if (st.name !== ".ascii") data[at++] = 0;
      }
      return;
    default: {
      const unit = st.size / st.args.length;
      st.args.forEach((a, k) => {
        const v = evalExpr(a, { ...ctx, pc: ctx.pc + k * unit }).value;
        const lim = unit === 4 ? 2 ** 32 : 2 ** (8 * unit);
        if (!(v >= -lim / 2 && v < lim)) fail(`${v} does not fit in ${unit} byte${unit > 1 ? "s" : ""}`);
        if (unit === 1) dv.setUint8(at + k, v & 0xff);
        else if (unit === 2) dv.setUint16(at + k * 2, v & 0xffff, true);
        else dv.setUint32(at + k * 4, v >>> 0, true);
      });
    }
  }
}

// ---------------------------------------------------------------- instructions and pseudo-instructions

const I = (op: Mnemonic, rd = 0, rs1 = 0, rs2 = 0, imm = 0): Inst => ({ op, rd, rs1, rs2, imm });

function regArg(a: string | undefined): number {
  const r = parseReg((a ?? "").trim());
  if (r === null) fail(a ? `unknown register '${a}'` : "missing register operand");
  return r!;
}

function count(name: string, args: string[], n: number, shape: string) {
  if (args.length !== n) fail(`${name} expects ${n} operand${n === 1 ? "" : "s"}: ${shape}`);
}

/** An immediate operand, range-checked for the instruction it goes into. */
function immArg(op: Mnemonic, a: string, ctx: Ctx): number {
  const v = evalExpr(a, ctx).value;
  if (!immFits(op, v)) {
    const r = immRange(op);
    fail(`immediate ${v} out of range for ${op} (${r.min}..${r.max})`);
  }
  return v;
}

/** off(reg): the offset (may be empty, %lo(...) or an expression) and the base register. */
function memArg(op: Mnemonic, a: string, ctx: Ctx): { off: number; base: number } {
  const m = /^(.*)\(\s*([^()]+?)\s*\)\s*$/.exec(a.trim());
  if (!m) return fail(`${op} expects an address like 8(sp), got '${a}'`);
  const offText = m[1]!.trim();
  return { off: offText === "" ? 0 : immArg(op, offText, ctx), base: regArg(m[2]) };
}

/** A branch or jump target: a label expression is an address, a plain number is an offset. */
function targetArg(op: Mnemonic, a: string, ctx: Ctx): number {
  const v = evalExpr(a, ctx);
  const offset = v.sym ? v.value - ctx.pc : v.value;
  const r = immRange(op);
  if (offset % 4 !== 0) fail(`misaligned target: offset ${offset} is not a multiple of 4`);
  if (offset < r.min || offset > r.max) fail(`target out of range for ${op}: offset ${offset} (${r.min}..${r.max})`);
  return offset;
}

/** pc-relative pair for la, call, tail: auipc rd, hi; then the low part. */
function pcrel(a: string, ctx: Ctx): { hi: number; lo: number } {
  const v = evalExpr(a, ctx);
  const d = (v.value - ctx.pc) | 0;
  return { hi: hi20(d), lo: lo12(d) };
}

const FENCE_BITS = (s: string): number => {
  if (!/^[iorw]+$/.test(s) || new Set(s).size !== s.length) return fail(`fence operand must be letters from iorw, got '${s}'`);
  return (s.includes("i") ? 8 : 0) | (s.includes("o") ? 4 : 0) | (s.includes("r") ? 2 : 0) | (s.includes("w") ? 1 : 0);
};

function expand(name: string, args: string[], ctx: Ctx): Inst[] {
  const [a, b, c] = args;
  const R = regArg;
  switch (name) {
    // ---- pseudo-instructions
    case "nop": count(name, args, 0, "none"); return [I("addi")];
    case "li": {
      const rd = R(a), v = liValue(b!, ctx);
      if (v >= -2048 && v <= 2047) return [I("addi", rd, 0, 0, v)];
      const hi = hi20(v), lo = lo12(v);
      return lo === 0 ? [I("lui", rd, 0, 0, hi)] : [I("lui", rd, 0, 0, hi), I("addi", rd, rd, 0, lo)];
    }
    case "la": { count(name, args, 2, "rd, label"); const rd = R(a), p = pcrel(b!, ctx); return [I("auipc", rd, 0, 0, p.hi), I("addi", rd, rd, 0, p.lo)]; }
    case "call": { count(name, args, 1, "label"); const p = pcrel(a!, ctx); return [I("auipc", 1, 0, 0, p.hi), I("jalr", 1, 1, 0, p.lo)]; }
    case "tail": { count(name, args, 1, "label"); const p = pcrel(a!, ctx); return [I("auipc", 6, 0, 0, p.hi), I("jalr", 0, 6, 0, p.lo)]; }
    case "mv": count(name, args, 2, "rd, rs"); return [I("addi", R(a), R(b))];
    case "not": count(name, args, 2, "rd, rs"); return [I("xori", R(a), R(b), 0, -1)];
    case "neg": count(name, args, 2, "rd, rs"); return [I("sub", R(a), 0, R(b))];
    case "seqz": count(name, args, 2, "rd, rs"); return [I("sltiu", R(a), R(b), 0, 1)];
    case "snez": count(name, args, 2, "rd, rs"); return [I("sltu", R(a), 0, R(b))];
    case "sltz": count(name, args, 2, "rd, rs"); return [I("slt", R(a), R(b), 0)];
    case "sgtz": count(name, args, 2, "rd, rs"); return [I("slt", R(a), 0, R(b))];
    case "beqz": count(name, args, 2, "rs, label"); return [I("beq", 0, R(a), 0, targetArg("beq", b!, ctx))];
    case "bnez": count(name, args, 2, "rs, label"); return [I("bne", 0, R(a), 0, targetArg("bne", b!, ctx))];
    case "blez": count(name, args, 2, "rs, label"); return [I("bge", 0, 0, R(a), targetArg("bge", b!, ctx))];
    case "bgez": count(name, args, 2, "rs, label"); return [I("bge", 0, R(a), 0, targetArg("bge", b!, ctx))];
    case "bltz": count(name, args, 2, "rs, label"); return [I("blt", 0, R(a), 0, targetArg("blt", b!, ctx))];
    case "bgtz": count(name, args, 2, "rs, label"); return [I("blt", 0, 0, R(a), targetArg("blt", b!, ctx))];
    case "bgt": count(name, args, 3, "rs, rt, label"); return [I("blt", 0, R(b), R(a), targetArg("blt", c!, ctx))];
    case "ble": count(name, args, 3, "rs, rt, label"); return [I("bge", 0, R(b), R(a), targetArg("bge", c!, ctx))];
    case "bgtu": count(name, args, 3, "rs, rt, label"); return [I("bltu", 0, R(b), R(a), targetArg("bltu", c!, ctx))];
    case "bleu": count(name, args, 3, "rs, rt, label"); return [I("bgeu", 0, R(b), R(a), targetArg("bgeu", c!, ctx))];
    case "j": count(name, args, 1, "label"); return [I("jal", 0, 0, 0, targetArg("jal", a!, ctx))];
    case "jr": count(name, args, 1, "rs"); return [I("jalr", 0, R(a))];
    case "ret": count(name, args, 0, "none"); return [I("jalr", 0, 1)];
    case "jal":
      if (args.length === 1) return [I("jal", 1, 0, 0, targetArg("jal", a!, ctx))];
      count(name, args, 2, "rd, label (or just label)");
      return [I("jal", R(a), 0, 0, targetArg("jal", b!, ctx))];
    case "jalr":
      if (args.length === 1) {
        if (parseReg(a!) !== null) return [I("jalr", 1, R(a))];
        const m = memArg("jalr", a!, ctx);
        return [I("jalr", 1, m.base, 0, m.off)];
      }
      if (args.length === 2) {
        if (parseReg(b!) !== null) return [I("jalr", R(a), R(b))];
        const m = memArg("jalr", b!, ctx);
        return [I("jalr", R(a), m.base, 0, m.off)];
      }
      count(name, args, 3, "rd, rs1, offset (or rd, offset(rs1))");
      return [I("jalr", R(a), R(b), 0, immArg("jalr", c!, ctx))];
    case "fence":
      if (args.length === 0) return [I("fence", 0, 0, 0, 0x0ff)];
      count(name, args, 2, "pred, succ (letters from iorw)");
      return [I("fence", 0, 0, 0, (FENCE_BITS(a!) << 4) | FENCE_BITS(b!))];
    case "ecall": case "ebreak": count(name, args, 0, "none"); return [I(name)];
  }
  // ---- base instructions
  const op = name as Mnemonic;
  switch (formatOf(op)) {
    case "R": count(op, args, 3, "rd, rs1, rs2"); return [I(op, R(a), R(b), R(c))];
    case "I":
      if (OPS[op].opcode === 0x03) { count(op, args, 2, "rd, offset(rs1)"); const m = memArg(op, b!, ctx); return [I(op, R(a), m.base, 0, m.off)]; }
      count(op, args, 3, op === "slli" || op === "srli" || op === "srai" ? "rd, rs1, shamt" : "rd, rs1, imm");
      return [I(op, R(a), R(b), 0, immArg(op, c!, ctx))];
    case "S": { count(op, args, 2, "rs2, offset(rs1)"); const m = memArg(op, b!, ctx); return [I(op, 0, m.base, R(a), m.off)]; }
    case "B": count(op, args, 3, "rs1, rs2, label"); return [I(op, 0, R(a), R(b), targetArg(op, c!, ctx))];
    case "U": count(op, args, 2, "rd, imm20"); return [I(op, R(a), 0, 0, immArg(op, b!, ctx))];
    case "J": return fail("unreachable");
  }
}
