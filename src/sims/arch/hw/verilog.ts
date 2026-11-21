/**
 * A parser and elaborator for a small, documented subset of Verilog (IEEE 1364-2005), for the hw-design module.
 *
 * The subset (one module per source):
 * - `module name (input ..., output ...);` with ANSI ports. A port is `input` or `output`, then optional `wire` or
 *   `reg`, optional `signed`, an optional range `[msb:lsb]`, and a name. A name with no direction repeats the previous
 *   port's direction, type and range, as in Verilog.
 * - `wire` and `reg` declarations with optional `signed` and range; `reg [31:0] mem [0:255];` declares a memory.
 *   `wire [3:0] y = a + b;` is a declaration with a continuous assignment. `localparam` and `parameter` (no override).
 * - `assign lvalue = expr;`
 * - `always @(posedge clk) stmt` (one clock for the whole module) and `always @*` or `always @(*) stmt`.
 * - Statements: `begin ... end`, `if (e) s else s`, `case (e) item, item: s ... default: s endcase`, `lv = e;`
 *   (blocking) and `lv <= e;` (nonblocking).
 * - Lvalues: a name, a bit select `x[i]`, a part select `x[7:4]` (constant bounds), a memory word `m[i]`, and a
 *   concatenation of these.
 * - Expressions: sized literals (`8'hFF`, `4'b1010`, `3'd5`, `8'sh80`), unsized decimals, names, `x[i]`, `x[m:l]`,
 *   `m[i]`, `m[i][b]`, `{a, b}`, `{n{a}}`, `$signed(e)`, `$unsigned(e)`, unary `~ - ! & | ^` (the last three are
 *   reductions), binary `+ - & | ^ << >> >>> == != < <= > >= && ||`, and `c ? a : b`.
 *
 * Widths and signedness follow the rules of IEEE 1364-2005 (5.4 and 5.5): an operator such as + takes the largest width
 * of its operands and of its context (the left side of the assignment); a comparison sizes its two operands to each
 * other and gives 1 bit; a shift amount, a concatenation part and a condition are self-determined. An expression is
 * signed only if all its operands are signed. An unsized decimal is signed and 32 bits here (the standard says at least
 * 32 bits). Selects and concatenations are unsigned. Exception: a parameter or localparam is always a signed 32-bit
 * value here; IEEE 1364-2005 (12.2) gives an untyped, unranged parameter the width and sign of its final value. The elaborator writes these rules into the IR as explicit `resize` nodes, so the simulator and the
 * gate-level synthesizer read one meaning.
 *
 * Left out, each with a clear error: values wider than 32 bits, x and z, `initial`, delays (`#`), `*` `/` `%`,
 * `casez`/`casex`, `for`, functions, tasks, generate, module instances, several clocks, asynchronous resets
 * (`or` in a sensitivity list), `negedge`, and indexed part selects (`+:`).
 */

export interface VError { line: number; message: string }
export class VerilogError extends Error {
  constructor(public line: number, message: string) { super(message); }
}

// ---------------------------------------------------------------- lexer

type TokKind = "id" | "num" | "sys" | "op" | "eof";
interface Tok { k: TokKind; v: string; line: number; size?: number; base?: string; digits?: string; signed?: boolean }

const OPS3 = [">>>", "<<<", "===", "!=="];
const OPS2 = ["<=", ">=", "==", "!=", "&&", "||", "<<", ">>", "~&", "~|", "~^", "^~", "+:", "-:", "**"];
const OPS1 = "()[]{};,:?@=<>+-*/%&|^~!.#";

export function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const start = line;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; }
      if (i >= n) throw new VerilogError(start, "a /* comment is not closed");
      i += 2; continue;
    }
    if (c === "`") throw new VerilogError(line, "compiler directives (`define, `timescale) are left out of this subset");
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      out.push({ k: "id", v: src.slice(i, j), line }); i = j; continue;
    }
    if (c === "$") {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      out.push({ k: "sys", v: src.slice(i, j), line }); i = j; continue;
    }
    if (/[0-9']/.test(c)) {
      // [size] ' [s] base digits, or a plain decimal
      let j = i, size: number | undefined;
      if (c !== "'") {
        while (j < n && /[0-9_]/.test(src[j]!)) j++;
        const dec = src.slice(i, j).replace(/_/g, "");
        let k = j;
        while (k < n && (src[k] === " " || src[k] === "\t")) k++;
        if (src[k] !== "'") { out.push({ k: "num", v: dec, line, digits: dec, base: "d" }); i = j; continue; }
        size = Number(dec); j = k;
      }
      j++; // the '
      let signed = false;
      if (src[j] === "s" || src[j] === "S") { signed = true; j++; }
      const base = (src[j] ?? "").toLowerCase();
      if (!"bodh".includes(base) || !base) throw new VerilogError(line, "a based literal needs b, o, d or h after the '");
      j++;
      while (j < n && (src[j] === " " || src[j] === "\t")) j++;
      const s0 = j;
      while (j < n && /[0-9a-zA-Z_?]/.test(src[j]!)) j++;
      const digits = src.slice(s0, j).replace(/_/g, "");
      if (!digits) throw new VerilogError(line, "a based literal has no digits");
      if (/[xXzZ?]/.test(digits)) throw new VerilogError(line, "x and z values are left out: this simulator has two states, 0 and 1");
      out.push({ k: "num", v: src.slice(i, j), line, size, base, digits, signed }); i = j; continue;
    }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    if (OPS3.includes(three)) { out.push({ k: "op", v: three, line }); i += 3; continue; }
    if (OPS2.includes(two)) { out.push({ k: "op", v: two, line }); i += 2; continue; }
    if (OPS1.includes(c)) { out.push({ k: "op", v: c, line }); i++; continue; }
    if (c === '"') throw new VerilogError(line, "strings are left out of this subset");
    throw new VerilogError(line, `unexpected character '${c}'`);
  }
  out.push({ k: "eof", v: "end of file", line });
  return out;
}

// ---------------------------------------------------------------- AST

export type Expr =
  | { t: "num"; line: number; value: number; size: number | null; signed: boolean }
  | { t: "id"; line: number; name: string }
  | { t: "index"; line: number; base: Expr; idx: Expr }
  | { t: "part"; line: number; base: Expr; msb: Expr; lsb: Expr }
  | { t: "concat"; line: number; parts: Expr[] }
  | { t: "repl"; line: number; count: Expr; parts: Expr[] }
  | { t: "unary"; line: number; op: string; a: Expr }
  | { t: "binary"; line: number; op: string; a: Expr; b: Expr }
  | { t: "cond"; line: number; c: Expr; a: Expr; b: Expr }
  | { t: "call"; line: number; fn: "$signed" | "$unsigned"; a: Expr };

export type Stmt =
  | { t: "block"; line: number; body: Stmt[] }
  | { t: "if"; line: number; cond: Expr; then: Stmt; else: Stmt | null }
  | { t: "case"; line: number; sel: Expr; items: { labels: Expr[] | null; body: Stmt; line: number }[] }
  | { t: "assign"; line: number; lhs: Expr; rhs: Expr; nb: boolean }
  | { t: "empty"; line: number };

export interface Decl { name: string; line: number; dir: "input" | "output" | null; kind: "wire" | "reg"; signed: boolean; range: [Expr, Expr] | null; array: [Expr, Expr] | null }
export interface ModuleAst {
  name: string;
  decls: Decl[];
  params: { name: string; value: Expr; line: number }[];
  assigns: { lhs: Expr; rhs: Expr; line: number }[];
  always: { line: number; clock: string | null; body: Stmt }[];
}

// ---------------------------------------------------------------- parser

const KEYWORDS = new Set(["module", "endmodule", "input", "output", "inout", "wire", "reg", "signed", "assign", "always", "posedge", "negedge", "begin", "end", "if", "else", "case", "endcase", "default", "localparam", "parameter", "initial", "integer", "casez", "casex", "for", "function", "task", "generate", "or"]);

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  get cur() { return this.toks[this.i]!; }
  peek(o = 1) { return this.toks[Math.min(this.i + o, this.toks.length - 1)]!; }
  is(v: string) { const t = this.cur; return (t.k === "op" || t.k === "id") && t.v === v; }
  eat(v: string) { if (this.is(v)) { this.i++; return true; } return false; }
  expect(v: string, what?: string): Tok {
    if (!this.is(v)) throw new VerilogError(this.cur.line, `expected '${v}'${what ? ` ${what}` : ""} but found '${this.cur.v}'`);
    return this.toks[this.i++]!;
  }
  ident(what = "a name"): Tok {
    const t = this.cur;
    if (t.k !== "id" || KEYWORDS.has(t.v)) throw new VerilogError(t.line, `expected ${what} but found '${t.v}'`);
    this.i++;
    return t;
  }

  module(): ModuleAst {
    while (this.cur.k !== "eof" && !this.is("module")) throw new VerilogError(this.cur.line, `expected 'module' but found '${this.cur.v}'`);
    this.expect("module");
    const name = this.ident("the module name").v;
    const m: ModuleAst = { name, decls: [], params: [], assigns: [], always: [] };
    if (this.is("#")) throw new VerilogError(this.cur.line, "module parameters with #( ) are left out: use localparam");
    this.expect("(", "after the module name");
    let prev: Omit<Decl, "name" | "line"> | null = null;
    if (!this.is(")")) {
      do {
        const line = this.cur.line;
        if (this.is("input") || this.is("output")) {
          const dir = this.cur.v as "input" | "output"; this.i++;
          let kind: "wire" | "reg" = "wire";
          if (this.eat("reg")) kind = "reg"; else this.eat("wire");
          if (dir === "input" && kind === "reg") throw new VerilogError(line, "an input cannot be a reg");
          const signed = this.eat("signed");
          const range = this.optRange();
          prev = { dir, kind, signed, range, array: null };
        } else if (this.is("inout")) {
          throw new VerilogError(line, "inout ports are left out of this subset");
        } else if (!prev) {
          throw new VerilogError(line, "the first port needs a direction: input or output (old-style port lists are left out)");
        }
        const id = this.ident("a port name");
        m.decls.push({ ...prev!, name: id.v, line: id.line });
      } while (this.eat(","));
    }
    this.expect(")", "to close the port list");
    this.expect(";", "after the port list");
    while (!this.is("endmodule")) {
      if (this.cur.k === "eof") throw new VerilogError(this.cur.line, "missing 'endmodule'");
      this.item(m);
    }
    this.expect("endmodule");
    if (this.cur.k !== "eof") throw new VerilogError(this.cur.line, "only one module per source is supported here");
    return m;
  }

  optRange(): [Expr, Expr] | null {
    if (!this.eat("[")) return null;
    const msb = this.expr();
    this.expect(":", "in a range [msb:lsb]");
    const lsb = this.expr();
    this.expect("]");
    return [msb, lsb];
  }

  item(m: ModuleAst) {
    const t = this.cur, line = t.line;
    if (t.k !== "id") throw new VerilogError(line, `unexpected '${t.v}' in the module body`);
    switch (t.v) {
      case "input": case "output": case "inout":
        throw new VerilogError(line, "declare ports in the module header (ANSI style)");
      case "wire": case "reg": {
        this.i++;
        const kind = t.v as "wire" | "reg";
        const signed = this.eat("signed");
        const range = this.optRange();
        do {
          const id = this.ident("a signal name");
          const array = this.optRange();
          if (array && kind === "wire") throw new VerilogError(id.line, "a memory must be a reg");
          m.decls.push({ name: id.v, line: id.line, dir: null, kind, signed, range, array });
          if (this.eat("=")) {
            if (kind === "reg") throw new VerilogError(id.line, "a reg with an initial value is left out: use a reset");
            m.assigns.push({ lhs: { t: "id", line: id.line, name: id.v }, rhs: this.expr(), line: id.line });
          }
        } while (this.eat(","));
        this.expect(";", "after the declaration");
        return;
      }
      case "localparam": case "parameter": {
        this.i++;
        if (this.is("[")) this.optRange();
        do {
          const id = this.ident("a parameter name");
          this.expect("=", "in a parameter");
          m.params.push({ name: id.v, value: this.expr(), line: id.line });
        } while (this.eat(","));
        this.expect(";");
        return;
      }
      case "assign": {
        this.i++;
        do {
          const lhs = this.lvalue();
          this.expect("=", "in an assign");
          m.assigns.push({ lhs, rhs: this.expr(), line });
        } while (this.eat(","));
        this.expect(";", "after the assign");
        return;
      }
      case "always": {
        this.i++;
        this.expect("@", "after always (plain always loops and delays are left out)");
        let clock: string | null = null;
        if (this.eat("*")) { /* always @* */ }
        else {
          this.expect("(");
          if (this.eat("*")) { /* always @(*) */ }
          else if (this.eat("posedge")) {
            clock = this.ident("a clock name").v;
            if (this.is("or") || this.is(",")) throw new VerilogError(this.cur.line, "asynchronous resets (posedge clk or posedge rst) are left out: use a synchronous reset");
          } else if (this.is("negedge")) {
            throw new VerilogError(line, "negedge is left out: the simulator has one rising clock edge per cycle");
          } else {
            throw new VerilogError(line, "write always @* for combinational logic; explicit sensitivity lists are left out");
          }
          this.expect(")");
        }
        m.always.push({ line, clock, body: this.stmt() });
        return;
      }
      case "initial":
        throw new VerilogError(line, "initial blocks are left out: they run once in simulation, and most synthesis tools ignore them or use them only for FPGA power-up values. Use a reset");
      case "integer": case "genvar":
        throw new VerilogError(line, `${t.v} is left out of this subset`);
      case "function": case "task": case "generate": case "for":
        throw new VerilogError(line, `${t.v} is left out of this subset`);
      default:
        if (this.peek().k === "id" || this.peek().v === "#") throw new VerilogError(line, "module instances are left out: this subset has one module");
        throw new VerilogError(line, `unexpected '${t.v}' in the module body`);
    }
  }

  stmt(): Stmt {
    const t = this.cur, line = t.line;
    if (t.k === "op" && t.v === "#") throw new VerilogError(line, "delays (#) are left out: synthesis ignores them, and real gates do not obey them");
    if (t.k === "op" && t.v === ";") { this.i++; return { t: "empty", line }; }
    if (t.k === "id") {
      switch (t.v) {
        case "begin": {
          this.i++;
          if (this.eat(":")) this.ident("a block name");
          const body: Stmt[] = [];
          while (!this.is("end")) {
            if (this.cur.k === "eof") throw new VerilogError(line, "'begin' has no matching 'end'");
            body.push(this.stmt());
          }
          this.i++;
          return { t: "block", line, body };
        }
        case "if": {
          this.i++;
          this.expect("(", "after if");
          const cond = this.expr();
          this.expect(")", "after the if condition");
          const then = this.stmt();
          const els = this.eat("else") ? this.stmt() : null;
          return { t: "if", line, cond, then, else: els };
        }
        case "case": {
          this.i++;
          this.expect("(", "after case");
          const sel = this.expr();
          this.expect(")");
          const items: { labels: Expr[] | null; body: Stmt; line: number }[] = [];
          while (!this.is("endcase")) {
            if (this.cur.k === "eof") throw new VerilogError(line, "'case' has no matching 'endcase'");
            const il = this.cur.line;
            if (this.eat("default")) { this.eat(":"); items.push({ labels: null, body: this.stmt(), line: il }); continue; }
            const labels = [this.expr()];
            while (this.eat(",")) labels.push(this.expr());
            this.expect(":", "after a case label");
            items.push({ labels, body: this.stmt(), line: il });
          }
          this.i++;
          return { t: "case", line, sel, items };
        }
        case "casez": case "casex":
          throw new VerilogError(line, `${t.v} is left out: write a plain case`);
        case "for": case "while": case "repeat": case "forever":
          throw new VerilogError(line, `${t.v} loops are left out of this subset`);
        case "assign":
          throw new VerilogError(line, "assign inside an always block (procedural continuous assignment) is left out");
      }
    }
    if (t.k === "sys") throw new VerilogError(line, `system tasks such as ${t.v} are left out: the demo shows the waveform instead`);
    const lhs = this.lvalue();
    let nb: boolean;
    if (this.eat("=")) nb = false;
    else if (this.eat("<=")) nb = true;
    else throw new VerilogError(this.cur.line, `expected = or <= but found '${this.cur.v}'`);
    if (this.is("#")) throw new VerilogError(this.cur.line, "delays (#) are left out");
    const rhs = this.expr();
    this.expect(";", "after the assignment");
    return { t: "assign", line, lhs, rhs, nb };
  }

  lvalue(): Expr {
    const line = this.cur.line;
    if (this.eat("{")) {
      const parts = [this.lvalue()];
      while (this.eat(",")) parts.push(this.lvalue());
      this.expect("}");
      return { t: "concat", line, parts };
    }
    const id = this.ident("a signal to assign");
    let e: Expr = { t: "id", line, name: id.v };
    while (this.is("[")) e = this.select(e);
    return e;
  }

  select(base: Expr): Expr {
    const line = this.cur.line;
    this.expect("[");
    const a = this.expr();
    if (this.is("+:") || this.is("-:")) throw new VerilogError(line, "indexed part selects (+: and -:) are left out");
    if (this.eat(":")) {
      const b = this.expr();
      this.expect("]");
      return { t: "part", line, base, msb: a, lsb: b };
    }
    this.expect("]");
    return { t: "index", line, base, idx: a };
  }

  // precedence climbing, lowest first
  expr(): Expr {
    const c = this.binary(0);
    if (this.is("?")) {
      const line = this.cur.line; this.i++;
      const a = this.expr();
      this.expect(":", "in a ?: expression");
      const b = this.expr();
      return { t: "cond", line, c, a, b };
    }
    return c;
  }

  static LEVELS: string[][] = [["||"], ["&&"], ["|"], ["^", "~^", "^~"], ["&"], ["==", "!="], ["<", "<=", ">", ">="], ["<<", ">>", ">>>"], ["+", "-"]];

  binary(level: number): Expr {
    if (level >= Parser.LEVELS.length) return this.unary();
    let a = this.binary(level + 1);
    for (;;) {
      const t = this.cur;
      if (t.k === "op" && ["*", "/", "%", "**"].includes(t.v)) throw new VerilogError(t.line, `the operator ${t.v} is left out of this subset`);
      if (t.k === "op" && (t.v === "===" || t.v === "!==" || t.v === "<<<")) throw new VerilogError(t.line, `the operator ${t.v} is left out of this subset`);
      if (t.k !== "op" || !Parser.LEVELS[level]!.includes(t.v)) return a;
      if (t.v === "~^" || t.v === "^~") throw new VerilogError(t.line, "~^ is left out: write ~(a ^ b)");
      this.i++;
      const b = this.binary(level + 1);
      a = { t: "binary", line: t.line, op: t.v, a, b };
    }
  }

  unary(): Expr {
    const t = this.cur;
    if (t.k === "op" && ["~", "-", "+", "!", "&", "|", "^", "~&", "~|"].includes(t.v)) {
      if (t.v === "~&" || t.v === "~|") throw new VerilogError(t.line, `${t.v} is left out: write ~(&x) or ~(|x)`);
      this.i++;
      const a = this.unary();
      if (t.v === "+") return a;
      return { t: "unary", line: t.line, op: t.v, a };
    }
    return this.postfix();
  }

  postfix(): Expr {
    let e = this.primary();
    while (this.is("[")) e = this.select(e);
    return e;
  }

  primary(): Expr {
    const t = this.cur, line = t.line;
    if (t.k === "num") {
      this.i++;
      return parseNumber(t);
    }
    if (t.k === "sys") {
      if (t.v !== "$signed" && t.v !== "$unsigned") throw new VerilogError(line, `${t.v} is left out of this subset`);
      this.i++;
      this.expect("(");
      const a = this.expr();
      this.expect(")");
      return { t: "call", line, fn: t.v, a };
    }
    if (this.eat("(")) {
      const e = this.expr();
      this.expect(")", "to close the parenthesis");
      return e;
    }
    if (this.eat("{")) {
      const first = this.expr();
      if (this.eat("{")) {
        const parts = [this.expr()];
        while (this.eat(",")) parts.push(this.expr());
        this.expect("}");
        this.expect("}", "to close the replication");
        return { t: "repl", line, count: first, parts };
      }
      const parts = [first];
      while (this.eat(",")) parts.push(this.expr());
      this.expect("}", "to close the concatenation");
      return { t: "concat", line, parts };
    }
    if (t.k === "id" && !KEYWORDS.has(t.v)) { this.i++; return { t: "id", line, name: t.v }; }
    throw new VerilogError(line, `expected an expression but found '${t.v}'`);
  }
}

function parseNumber(t: Tok): Expr {
  const radix = { b: 2, o: 8, d: 10, h: 16 }[t.base ?? "d"]!;
  const digits = t.digits!;
  const valid = { 2: /^[01]+$/, 8: /^[0-7]+$/, 10: /^[0-9]+$/, 16: /^[0-9a-fA-F]+$/ }[radix as 2 | 8 | 10 | 16]!;
  if (!valid.test(digits)) throw new VerilogError(t.line, `'${t.v}' has a digit that base ${radix} does not allow`);
  const prefix = { 2: "0b", 8: "0o", 10: "", 16: "0x" }[radix as 2 | 8 | 10 | 16];
  const big = BigInt(prefix + digits);
  if (t.size === undefined) {
    if (big > 0xffffffffn) throw new VerilogError(t.line, `${digits} does not fit in 32 bits`);
    return { t: "num", line: t.line, value: Number(big), size: null, signed: true };
  }
  if (t.size < 1 || t.size > 32) throw new VerilogError(t.line, `a literal of ${t.size} bits: this subset allows 1 to 32`);
  // Verilog truncates a literal that is too wide for its size (from the left).
  const value = Number(big & ((1n << BigInt(t.size)) - 1n));
  return { t: "num", line: t.line, value, size: t.size, signed: !!t.signed };
}

export function parse(src: string): ModuleAst {
  return new Parser(lex(src)).module();
}

// ---------------------------------------------------------------- elaborated IR

/** A signal after elaboration. Memories have `depth` > 0 and are not in the waveform. */
export interface Signal {
  id: number;
  name: string;
  width: number;
  signed: boolean;
  /** The index of the least significant bit in the source, as in `[7:4]` (lsb 4). */
  lsb: number;
  kind: "input" | "output" | "wire" | "reg";
  isReg: boolean;
  line: number;
  depth: number;
  /** The first memory index (`[0:255]` gives 0). */
  base: number;
}

/** Every expression node has its final width `w` (1..32) and signedness `s`. Values are unsigned numbers below 2^w. */
export type IR = { w: number; s: boolean } & (
  | { k: "const"; v: number }
  | { k: "sig"; id: number }
  | { k: "resize"; a: IR; sx: boolean } // zero- or sign-extend, or truncate, a to w bits
  | { k: "bin"; op: "+" | "-" | "&" | "|" | "^"; a: IR; b: IR }
  | { k: "not"; a: IR }
  | { k: "neg"; a: IR }
  | { k: "cmp"; op: "==" | "!=" | "<" | "<=" | ">" | ">="; a: IR; b: IR; signed: boolean }
  | { k: "logic"; op: "&&" | "||"; a: IR; b: IR }
  | { k: "lnot"; a: IR }
  | { k: "red"; op: "&" | "|" | "^"; a: IR }
  | { k: "shift"; op: "<<" | ">>" | ">>>"; a: IR; b: IR }
  | { k: "cond"; c: IR; a: IR; b: IR }
  | { k: "bit"; a: IR; idx: IR; off: number } // bit (idx - off) of a
  | { k: "slice"; a: IR; lo: number } // bits lo .. lo + w - 1 of a
  | { k: "mem"; mem: number; idx: IR }
  | { k: "concat"; parts: IR[] } // parts[0] is the most significant
);

export type LV =
  | { k: "sig"; id: number; w: number }
  | { k: "bit"; id: number; idx: IR; off: number; w: 1 }
  | { k: "slice"; id: number; lo: number; w: number }
  | { k: "mem"; mem: number; idx: IR; w: number }
  | { k: "concat"; parts: LV[]; w: number };

export type IStmt =
  | { k: "block"; body: IStmt[] }
  | { k: "if"; cond: IR; then: IStmt; else: IStmt | null }
  | { k: "case"; sel: IR; items: { labels: IR[] | null; body: IStmt }[] }
  | { k: "assign"; lhs: LV; rhs: IR; nb: boolean; line: number };

export interface Process {
  kind: "assign" | "comb" | "seq";
  line: number;
  body: IStmt;
  /** Signals and memories read (memories as -1 - memId... kept apart below). */
  reads: number[];
  readsMem: number[];
  writes: number[];
  writesMem: number[];
}

export interface Design {
  name: string;
  signals: Signal[];
  byName: Map<string, Signal>;
  params: Map<string, number>;
  clock: Signal | null;
  procs: Process[];
  /** Warnings that do not stop simulation (inferred latches, unused clock edges, ...). */
  warnings: VError[];
}

const MAXW = 32;
const mask = (w: number) => (w >= 32 ? 0xffffffff : (1 << w) - 1) >>> 0;

/** Parse and elaborate. Throws VerilogError with a line number. */
export function elaborate(src: string): Design {
  const ast = parse(src);
  const signals: Signal[] = [];
  const byName = new Map<string, Signal>();
  const params = new Map<string, number>();
  const warnings: VError[] = [];

  const constEval = (e: Expr, what: string): number => {
    const ir = typeExpr(e, ctx);
    const v = evalConst(ir);
    if (v === null) throw new VerilogError(e.line, `${what} must be a constant`);
    return ir.s ? signExt(v, ir.w) : v;
  };
  const ctx: ElabCtx = { byName, params, isConst: false };
  for (const p of ast.params) {
    if (params.has(p.name) || byName.has(p.name)) throw new VerilogError(p.line, `${p.name} is declared twice`);
    params.set(p.name, constEval(p.value, `the value of ${p.name}`));
  }
  for (const d of ast.decls) {
    if (byName.has(d.name) || params.has(d.name)) throw new VerilogError(d.line, `${d.name} is declared twice`);
    let width = 1, lsb = 0;
    if (d.range) {
      const msb = constEval(d.range[0], "a range bound"), l = constEval(d.range[1], "a range bound");
      if (msb < l) throw new VerilogError(d.line, `write the range of ${d.name} as [msb:lsb] with msb >= lsb`);
      width = msb - l + 1; lsb = l;
      if (width > MAXW) throw new VerilogError(d.line, `${d.name} has ${width} bits: this subset allows at most 32`);
    }
    let depth = 0, base = 0;
    if (d.array) {
      const a = constEval(d.array[0], "a memory bound"), b = constEval(d.array[1], "a memory bound");
      depth = Math.abs(a - b) + 1; base = Math.min(a, b);
      if (depth > 1 << 20) throw new VerilogError(d.line, `${d.name} has ${depth} words: at most 2^20 here`);
    }
    const kind = d.dir ?? d.kind;
    const s: Signal = { id: signals.length, name: d.name, width, signed: d.signed, lsb, kind, isReg: d.kind === "reg", line: d.line, depth, base };
    signals.push(s); byName.set(d.name, s);
  }

  const procs: Process[] = [];
  const driver = new Map<number, { kind: Process["kind"]; line: number; proc: number }>();
  const memDriver = new Map<number, number>();
  let clock: Signal | null = null;

  const claim = (lv: LV, kind: Process["kind"], line: number, procIdx: number, procWrites: Set<number>, procMem: Set<number>) => {
    if (lv.k === "concat") { for (const p of lv.parts) claim(p, kind, line, procIdx, procWrites, procMem); return; }
    if (lv.k === "mem") {
      const prev = memDriver.get(lv.mem);
      if (kind !== "seq") throw new VerilogError(line, `the memory ${signals[lv.mem]!.name} can only be written in an always @(posedge) block`);
      if (prev !== undefined && prev !== procIdx) throw new VerilogError(line, `the memory ${signals[lv.mem]!.name} is written in two always blocks`);
      memDriver.set(lv.mem, procIdx); procMem.add(lv.mem); return;
    }
    const s = signals[lv.id]!;
    if (s.kind === "input") throw new VerilogError(line, `${s.name} is an input: the module cannot drive it`);
    if (kind === "assign" && s.isReg) throw new VerilogError(line, `${s.name} is a reg: drive it from an always block, or declare it as a wire`);
    if (kind !== "assign" && !s.isReg) throw new VerilogError(line, `${s.name} is a wire: an always block can only assign a reg`);
    const prev = driver.get(s.id);
    if (prev && prev.proc !== procIdx) {
      const partial = kind === "assign" && prev.kind === "assign" && lv.k !== "sig";
      if (!partial) throw new VerilogError(line, `${s.name} has two drivers (the other one is on line ${prev.line})`);
    }
    if (!prev) driver.set(s.id, { kind, line, proc: procIdx });
    procWrites.add(s.id);
  };

  for (const a of ast.assigns) {
    const lhs = typeLv(a.lhs, ctx, signals);
    const rhs = typeAssignRhs(a.rhs, lhs.w, ctx);
    const w = new Set<number>(), wm = new Set<number>();
    claim(lhs, "assign", a.line, procs.length, w, wm);
    const p: Process = { kind: "assign", line: a.line, body: { k: "assign", lhs, rhs, nb: false, line: a.line }, reads: [], readsMem: [], writes: [...w], writesMem: [] };
    collectReads(p);
    procs.push(p);
  }
  for (const al of ast.always) {
    const kind: Process["kind"] = al.clock ? "seq" : "comb";
    if (al.clock) {
      const c = byName.get(al.clock);
      if (!c) throw new VerilogError(al.line, `the clock ${al.clock} is not declared`);
      if (c.kind !== "input" || c.width !== 1) throw new VerilogError(al.line, `the clock ${al.clock} must be a 1-bit input`);
      if (clock && clock !== c) throw new VerilogError(al.line, "this subset has one clock: every always @(posedge) block must use the same one");
      clock = c;
    }
    const idx = procs.length;
    const w = new Set<number>(), wm = new Set<number>();
    const body = typeStmt(al.body, ctx, signals, (lv, line, nb) => {
      if (kind === "comb" && nb) warnings.push({ line, message: "a nonblocking <= in a combinational block: use = (Cummings, guideline 3)" });
      if (kind === "seq" && !nb && lv.k !== "mem") warnings.push({ line, message: "a blocking = in a clocked block: the order of statements and blocks now matters" });
      claim(lv, kind, line, idx, w, wm);
    });
    const p: Process = { kind, line: al.line, body, reads: [], readsMem: [], writes: [...w], writesMem: [...wm] };
    collectReads(p);
    procs.push(p);
    if (kind === "comb") for (const id of latchSignals(body, w)) {
      warnings.push({ line: al.line, message: `latch inferred for ${signals[id]!.name}: some path through the block does not assign it, so it must hold its old value` });
    }
  }
  if (clock) for (const p of procs) if (p.reads.includes(clock.id) && p.kind !== "seq") warnings.push({ line: p.line, message: `the clock ${clock.name} is used as data` });
  return { name: ast.name, signals, byName, params, clock, procs, warnings };
}

interface ElabCtx { byName: Map<string, Signal>; params: Map<string, number>; isConst: boolean }

export const signExt = (v: number, w: number) => (w >= 32 ? v | 0 : (v << (32 - w)) >> (32 - w));

/** Self-determined width and signedness of an expression, before context. */
function selfType(e: Expr, c: ElabCtx): { w: number; s: boolean } {
  switch (e.t) {
    case "num": return { w: e.size ?? 32, s: e.signed };
    case "id": {
      if (c.params.has(e.name)) return { w: 32, s: true };
      const s = c.byName.get(e.name);
      if (!s) throw new VerilogError(e.line, `${e.name} is not declared`);
      if (s.depth) throw new VerilogError(e.line, `${e.name} is a memory: read one word with ${e.name}[i]`);
      return { w: s.width, s: s.signed };
    }
    case "index": {
      if (e.base.t === "id") {
        const s = c.byName.get(e.base.name);
        if (s?.depth) return { w: s.width, s: s.signed };
      }
      return { w: 1, s: false };
    }
    case "part": {
      const msb = constOf(e.msb, c), lsb = constOf(e.lsb, c);
      if (msb < lsb) throw new VerilogError(e.line, "write a part select as [msb:lsb] with msb >= lsb");
      return { w: msb - lsb + 1, s: false };
    }
    case "concat": {
      const w = e.parts.reduce((t, p) => t + selfType(p, c).w, 0);
      if (w > MAXW) throw new VerilogError(e.line, `this concatenation has ${w} bits: this subset allows at most 32`);
      return { w, s: false };
    }
    case "repl": {
      const n = constOf(e.count, c);
      if (n < 1) throw new VerilogError(e.line, "a replication count must be at least 1");
      const w = n * e.parts.reduce((t, p) => t + selfType(p, c).w, 0);
      if (w > MAXW) throw new VerilogError(e.line, `this replication has ${w} bits: this subset allows at most 32`);
      return { w, s: false };
    }
    case "unary": {
      if (e.op === "!" || e.op === "&" || e.op === "|" || e.op === "^") { selfType(e.a, c); return { w: 1, s: false }; }
      return selfType(e.a, c);
    }
    case "binary": {
      const a = selfType(e.a, c), b = selfType(e.b, c);
      if (["==", "!=", "<", "<=", ">", ">=", "&&", "||"].includes(e.op)) return { w: 1, s: false };
      if (["<<", ">>", ">>>"].includes(e.op)) return a;
      return { w: Math.max(a.w, b.w), s: a.s && b.s };
    }
    case "cond": {
      selfType(e.c, c);
      const a = selfType(e.a, c), b = selfType(e.b, c);
      return { w: Math.max(a.w, b.w), s: a.s && b.s };
    }
    case "call": {
      const a = selfType(e.a, c);
      return { w: a.w, s: e.fn === "$signed" };
    }
  }
}

function constOf(e: Expr, c: ElabCtx): number {
  const ir = typeExpr(e, c);
  const v = evalConst(ir);
  if (v === null) throw new VerilogError(e.line, "this must be a constant");
  return ir.s ? signExt(v, ir.w) : v;
}

/** Type an expression in its own (self-determined) context. */
export function typeExpr(e: Expr, c: ElabCtx): IR {
  const t = selfType(e, c);
  return typeCtx(e, t.w, t.s, c);
}

/** Type for an assignment: the context width is the larger of the rhs and the lhs (IEEE 1364-2005 5.4.1). */
function typeAssignRhs(e: Expr, lw: number, c: ElabCtx): IR {
  const t = selfType(e, c);
  const ir = typeCtx(e, Math.max(t.w, lw), t.s, c);
  return ir.w === lw ? ir : { k: "resize", a: ir, sx: false, w: lw, s: ir.s };
}

const resize = (a: IR, w: number, s: boolean): IR => {
  if (a.w === w) return a.s === s ? a : cast(a, s);
  return { k: "resize", a, sx: a.s && s, w, s };
};
/** The same bits with another signedness. A wrapper, so that the node inside keeps its own meaning. */
const cast = (a: IR, s: boolean): IR => (a.s === s ? a : a.k === "const" || a.k === "sig" ? ({ ...a, s } as IR) : { k: "resize", a, sx: false, w: a.w, s });

/** Type `e` with the final width w and the expression signedness s, which flow down to context-determined operands. */
function typeCtx(e: Expr, w: number, s: boolean, c: ElabCtx): IR {
  switch (e.t) {
    case "num": {
      const own = e.size ?? 32;
      return resize({ k: "const", v: e.value >>> 0, w: own, s: e.signed }, w, s);
    }
    case "id": {
      const p = c.params.get(e.name);
      if (p !== undefined) return resize({ k: "const", v: p >>> 0, w: 32, s: true }, w, s);
      const sig = c.byName.get(e.name)!;
      return resize({ k: "sig", id: sig.id, w: sig.width, s: sig.signed }, w, s);
    }
    case "index": {
      if (e.base.t === "id") {
        const sig = c.byName.get(e.base.name);
        if (!sig && !c.params.has(e.base.name)) throw new VerilogError(e.line, `${e.base.name} is not declared`);
        if (sig?.depth) {
          const idx = typeExpr(e.idx, c);
          const off = sig.base;
          const i2: IR = off ? { k: "bin", op: "-", a: resize(idx, 32, false), b: { k: "const", v: off, w: 32, s: false }, w: 32, s: false } : idx;
          return resize({ k: "mem", mem: sig.id, idx: i2, w: sig.width, s: sig.signed }, w, s);
        }
      }
      const base = typeExpr(e.base, c);
      const off = e.base.t === "id" ? c.byName.get(e.base.name)?.lsb ?? 0 : 0;
      const idx = typeExpr(e.idx, c);
      const iv = evalConst(idx);
      if (iv !== null) {
        const bit = (idx.s ? signExt(iv, idx.w) : iv) - off;
        if (bit < 0 || bit >= base.w) throw new VerilogError(e.line, `bit ${bit + off} is outside the signal`);
        return resize({ k: "slice", a: base, lo: bit, w: 1, s: false }, w, s);
      }
      return resize({ k: "bit", a: base, idx, off, w: 1, s: false }, w, s);
    }
    case "part": {
      const base = typeExpr(e.base, c);
      const off = e.base.t === "id" ? c.byName.get(e.base.name)?.lsb ?? 0 : 0;
      const msb = constOf(e.msb, c) - off, lsb = constOf(e.lsb, c) - off;
      if (lsb < 0 || msb >= base.w) throw new VerilogError(e.line, `[${msb + off}:${lsb + off}] is outside the signal`);
      return resize({ k: "slice", a: base, lo: lsb, w: msb - lsb + 1, s: false }, w, s);
    }
    case "concat": {
      const parts = e.parts.map((p) => typeExpr(p, c));
      return resize({ k: "concat", parts, w: parts.reduce((t, p) => t + p.w, 0), s: false }, w, s);
    }
    case "repl": {
      const n = constOf(e.count, c);
      const one = e.parts.map((p) => typeExpr(p, c));
      const parts: IR[] = [];
      for (let i = 0; i < n; i++) parts.push(...one);
      return resize({ k: "concat", parts, w: parts.reduce((t, p) => t + p.w, 0), s: false }, w, s);
    }
    case "unary": {
      if (e.op === "!") return resize({ k: "lnot", a: typeExpr(e.a, c), w: 1, s: false }, w, s);
      if (e.op === "&" || e.op === "|" || e.op === "^") return resize({ k: "red", op: e.op, a: typeExpr(e.a, c), w: 1, s: false }, w, s);
      const a = typeCtx(e.a, w, s, c);
      return e.op === "~" ? { k: "not", a, w, s } : { k: "neg", a, w, s };
    }
    case "binary": {
      const op = e.op;
      if (op === "&&" || op === "||") return resize({ k: "logic", op, a: typeExpr(e.a, c), b: typeExpr(e.b, c), w: 1, s: false }, w, s);
      if (["==", "!=", "<", "<=", ">", ">="].includes(op)) {
        const ta = selfType(e.a, c), tb = selfType(e.b, c);
        const cw = Math.max(ta.w, tb.w), cs = ta.s && tb.s;
        const a = typeCtx(e.a, cw, cs, c), b = typeCtx(e.b, cw, cs, c);
        return resize({ k: "cmp", op: op as "==", a, b, signed: cs, w: 1, s: false }, w, s);
      }
      if (op === "<<" || op === ">>" || op === ">>>") {
        const a = typeCtx(e.a, w, s, c), b = typeExpr(e.b, c);
        return { k: "shift", op, a, b: cast(b, false), w, s };
      }
      const a = typeCtx(e.a, w, s, c), b = typeCtx(e.b, w, s, c);
      return { k: "bin", op: op as "+", a, b, w, s };
    }
    case "cond": {
      const cnd = typeExpr(e.c, c);
      return { k: "cond", c: cnd, a: typeCtx(e.a, w, s, c), b: typeCtx(e.b, w, s, c), w, s };
    }
    case "call": {
      const a = typeExpr(e.a, c);
      return resize(cast(a, e.fn === "$signed"), w, s);
    }
  }
}

function typeLv(e: Expr, c: ElabCtx, signals: Signal[]): LV {
  if (e.t === "concat") {
    const parts = e.parts.map((p) => typeLv(p, c, signals));
    const w = parts.reduce((t, p) => t + p.w, 0);
    if (w > MAXW) throw new VerilogError(e.line, `this concatenation has ${w} bits: this subset allows at most 32`);
    return { k: "concat", parts, w };
  }
  const root = e.t === "id" ? e : e.t === "index" || e.t === "part" ? e.base : null;
  if (!root || root.t !== "id") throw new VerilogError(e.line, "the left side must be a signal, a select of one, or a concatenation");
  const s = c.byName.get(root.name);
  if (!s) throw new VerilogError(e.line, c.params.has(root.name) ? `${root.name} is a parameter: it cannot be assigned` : `${root.name} is not declared`);
  if (e.t === "id") {
    if (s.depth) throw new VerilogError(e.line, `${s.name} is a memory: write one word with ${s.name}[i]`);
    return { k: "sig", id: s.id, w: s.width };
  }
  if (e.t === "index") {
    const idx = typeExpr(e.idx, c);
    if (s.depth) {
      const i2: IR = s.base ? { k: "bin", op: "-", a: resize(idx, 32, false), b: { k: "const", v: s.base, w: 32, s: false }, w: 32, s: false } : idx;
      return { k: "mem", mem: s.id, idx: i2, w: s.width };
    }
    const iv = evalConst(idx);
    if (iv !== null) {
      const bit = iv - s.lsb;
      if (bit < 0 || bit >= s.width) throw new VerilogError(e.line, `bit ${iv} is outside ${s.name}`);
      return { k: "slice", id: s.id, lo: bit, w: 1 };
    }
    return { k: "bit", id: s.id, idx, off: s.lsb, w: 1 };
  }
  if (s.depth) throw new VerilogError(e.line, "a part select of a memory word is left out");
  const msb = constOf((e as Extract<Expr, { t: "part" }>).msb, c) - s.lsb, lsb = constOf((e as Extract<Expr, { t: "part" }>).lsb, c) - s.lsb;
  if (lsb < 0 || msb >= s.width || msb < lsb) throw new VerilogError(e.line, `this part select is outside ${s.name}`);
  return { k: "slice", id: s.id, lo: lsb, w: msb - lsb + 1 };
}

function typeStmt(st: Stmt, c: ElabCtx, signals: Signal[], onAssign: (lv: LV, line: number, nb: boolean) => void): IStmt {
  switch (st.t) {
    case "empty": return { k: "block", body: [] };
    case "block": return { k: "block", body: st.body.map((s) => typeStmt(s, c, signals, onAssign)) };
    case "if": return { k: "if", cond: typeExpr(st.cond, c), then: typeStmt(st.then, c, signals, onAssign), else: st.else ? typeStmt(st.else, c, signals, onAssign) : null };
    case "case": {
      // The selector and all labels are sized to the widest of them (IEEE 1364-2005 9.5).
      const all = [st.sel, ...st.items.flatMap((i) => i.labels ?? [])];
      const types = all.map((e) => selfType(e, c));
      const w = Math.max(...types.map((t) => t.w)), s = types.every((t) => t.s);
      const defaults = st.items.filter((i) => !i.labels).length;
      if (defaults > 1) throw new VerilogError(st.line, "a case has more than one default");
      return {
        k: "case", sel: typeCtx(st.sel, w, s, c),
        items: st.items.map((i) => ({ labels: i.labels ? i.labels.map((l) => typeCtx(l, w, s, c)) : null, body: typeStmt(i.body, c, signals, onAssign) })),
      };
    }
    case "assign": {
      const lhs = typeLv(st.lhs, c, signals);
      onAssign(lhs, st.line, st.nb);
      return { k: "assign", lhs, rhs: typeAssignRhs(st.rhs, lhs.w, c), nb: st.nb, line: st.line };
    }
  }
}

function collectReads(p: Process) {
  const r = new Set<number>(), rm = new Set<number>();
  const ex = (e: IR): void => {
    switch (e.k) {
      case "const": return;
      case "sig": r.add(e.id); return;
      case "mem": rm.add(e.mem); ex(e.idx); return;
      case "resize": case "not": case "neg": case "lnot": case "red": case "slice": ex(e.a); return;
      case "bit": ex(e.a); ex(e.idx); return;
      case "bin": case "cmp": case "logic": case "shift": ex(e.a); ex(e.b); return;
      case "cond": ex(e.c); ex(e.a); ex(e.b); return;
      case "concat": e.parts.forEach(ex); return;
    }
  };
  const lv = (l: LV): void => {
    if (l.k === "bit" || l.k === "mem") ex(l.idx);
    if (l.k === "concat") l.parts.forEach(lv);
  };
  const st = (s: IStmt): void => {
    switch (s.k) {
      case "block": s.body.forEach(st); return;
      case "if": ex(s.cond); st(s.then); if (s.else) st(s.else); return;
      case "case": ex(s.sel); for (const i of s.items) { i.labels?.forEach(ex); st(i.body); } return;
      case "assign": ex(s.rhs); lv(s.lhs); return;
    }
  };
  st(p.body);
  p.reads = [...r];
  p.readsMem = [...rm];
}

/**
 * Signals that some path through a combinational block leaves unassigned. Such a signal must keep its old value, so
 * synthesis builds a latch for it. A signal counts as assigned only when the whole signal is written (a write to one
 * bit is a partial assignment).
 */
export function latchSignals(body: IStmt, writes: Set<number>): number[] {
  const full = (s: IStmt): Set<number> => {
    switch (s.k) {
      case "assign": {
        const out = new Set<number>();
        const add = (l: LV) => { if (l.k === "sig") out.add(l.id); else if (l.k === "concat") l.parts.forEach(add); };
        add(s.lhs);
        return out;
      }
      case "block": { const out = new Set<number>(); for (const b of s.body) for (const x of full(b)) out.add(x); return out; }
      case "if": {
        if (!s.else) return new Set();
        const a = full(s.then), b = full(s.else);
        return new Set([...a].filter((x) => b.has(x)));
      }
      case "case": {
        if (!s.items.some((i) => !i.labels)) return new Set(); // no default: some value may match no label
        let acc = null as Set<number> | null;
        for (const i of s.items) { const f = full(i.body); acc = acc ? new Set([...acc].filter((x: number) => f.has(x))) : f; }
        return acc ?? new Set();
      }
    }
  };
  const done = full(body);
  return [...writes].filter((id) => !done.has(id));
}

/** Evaluate an IR with no signals. Returns null if it reads a signal or a memory. */
export function evalConst(e: IR): number | null {
  try { return evalIR(e, () => { throw NOT_CONST; }, () => { throw NOT_CONST; }); } catch (x) { if (x === NOT_CONST) return null; throw x; }
}
const NOT_CONST = {};

/** A direct (uncompiled) evaluator, for constants and tests. The simulator compiles the same rules to closures. */
export function evalIR(e: IR, sig: (id: number) => number, mem: (id: number, i: number) => number): number {
  const m = mask(e.w);
  const ev = (x: IR) => evalIR(x, sig, mem);
  switch (e.k) {
    case "const": return (e.v & m) >>> 0;
    case "sig": return sig(e.id);
    case "resize": { const v = ev(e.a); return ((e.sx ? signExt(v, e.a.w) : v) & m) >>> 0; }
    case "bin": {
      const a = ev(e.a), b = ev(e.b);
      const r = e.op === "+" ? a + b : e.op === "-" ? a - b : e.op === "&" ? a & b : e.op === "|" ? a | b : a ^ b;
      return (r & m) >>> 0;
    }
    case "not": return (~ev(e.a) & m) >>> 0;
    case "neg": return (-ev(e.a) & m) >>> 0;
    case "cmp": {
      let a = ev(e.a), b = ev(e.b);
      if (e.signed) { a = signExt(a, e.a.w); b = signExt(b, e.b.w); }
      const r = e.op === "==" ? a === b : e.op === "!=" ? a !== b : e.op === "<" ? a < b : e.op === "<=" ? a <= b : e.op === ">" ? a > b : a >= b;
      return r ? 1 : 0;
    }
    case "logic": return e.op === "&&" ? (ev(e.a) && ev(e.b) ? 1 : 0) : ev(e.a) || ev(e.b) ? 1 : 0;
    case "lnot": return ev(e.a) ? 0 : 1;
    case "red": {
      const a = ev(e.a);
      if (e.op === "&") return a === mask(e.a.w) ? 1 : 0;
      if (e.op === "|") return a ? 1 : 0;
      let p = 0, x = a;
      while (x) { p ^= x & 1; x >>>= 1; }
      return p;
    }
    case "shift": {
      const a = ev(e.a), b = ev(e.b);
      if (e.op === "<<") return b >= 32 ? 0 : ((a << b) & m) >>> 0;
      if (e.op === ">>" || !e.s) return b >= 32 ? 0 : a >>> b;
      return ((signExt(a, e.w) >> Math.min(b, 31)) & m) >>> 0;
    }
    case "cond": return ev(e.c) ? ev(e.a) : ev(e.b);
    case "bit": { const i = ev(e.idx) - e.off; return i < 0 || i >= e.a.w ? 0 : (ev(e.a) >>> i) & 1; }
    case "slice": return ((ev(e.a) >>> e.lo) & m) >>> 0;
    case "mem": return mem(e.mem, ev(e.idx));
    case "concat": {
      let v = 0;
      for (const p of e.parts) v = p.w >= 32 ? ev(p) : (v * 2 ** p.w + ev(p)) % 2 ** 32;
      return v >>> 0;
    }
  }
}

export { mask as widthMask };
