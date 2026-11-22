/**
 * A small borrow checker for a toy subset of Rust: the body of `fn main` with `let`, assignment, blocks, moves,
 * shared and mutable borrows, a few String and Vec methods, `println!`, `drop`, and calls to functions that are
 * declared by their signature only (with lifetime parameters). It reports errors in the style of rustc, with the same
 * error codes, and it runs the program: it prints what `println!` prints and what each `Drop` prints, in order.
 *
 * How it works (the same idea as rustc's MIR borrow checker, much smaller):
 * 1. Parse, then LOWER each statement to a list of actions in evaluation order: borrow (make a loan), read, move,
 *    write, use (a use of a reference), def (a reference variable gets loans), activate (a two-phase borrow starts),
 *    dead (a variable goes out of scope) and drop.
 * 2. LIVENESS: a variable or temporary that holds a reference is live at an action if a later action uses it before
 *    a new value is written to it. A loan is live if a live holder has it. This is non-lexical lifetimes (NLL, RFC
 *    2094): a borrow lasts until the last use of the reference, not until the end of the block. With `lexical: true`
 *    a holder stays live until the end of its block instead: a model of the checker before NLL (Rust 2015).
 * 3. CHECK each action against the live loans, in order:
 *    E0382 use or borrow of a moved value, E0381 use of an uninitialized binding, E0499 two mutable borrows, E0502 a
 *    shared and a mutable borrow, E0503 a use while mutably borrowed, E0505 a move while borrowed, E0506 an
 *    assignment while borrowed, E0596 a mutable borrow of a binding without `mut` or through `&`, E0384 a second
 *    assignment to a binding without `mut`, E0597 a borrowed value that goes out of scope while the loan is live,
 *    and E0106 a function signature whose output lifetime cannot be elided.
 *
 * Two-phase borrows (RFC 2025): `v.push(v.len())` first RESERVES the mutable borrow of v (checked like a shared
 * borrow), evaluates the arguments, and then ACTIVATES it (checked as a mutable borrow). So the shared borrow in
 * `v.len()` ends before the mutable one starts.
 *
 * Function calls use the signature only, as rustc does at a call site: the result of
 * `fn longest<'a>(x: &'a str, y: &'a str) -> &'a str` holds the loans of every argument whose parameter has 'a.
 * Elided lifetimes follow the elision rules (lifetimes.ts).
 *
 * The toy language leaves out: branches and loops (rustc checks a control-flow graph), structs and fields (rustc
 * tracks disjoint fields separately), closures, traits, generics other than lifetimes, reborrows such as `&*r`,
 * temporary lifetime extension, and two-phase borrows through a `&mut` variable. A borrow of `v[0]` borrows all of v,
 * as indexing a Vec does in Rust. Every example program in programs.ts was checked against rustc 1.96.1.
 */
import { elide, parseSig, SigError, tyText, type FnSig } from "./lifetimes";

// ---------------------------------------------------------------- tokens and syntax

type TokKind = "id" | "num" | "str" | "lt" | "sym";
interface Tok { k: TokKind; t: string; line: number }

const SYMS = ["->", "+=", "-=", "::", "(", ")", "{", "}", "[", "]", "<", ">", ",", ";", ":", "=", "&", "*", ".", "!", "+", "-", "?"];

export class ParseError extends Error {
  line: number;
  constructor(line: number, msg: string) { super(msg); this.line = line; }
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  src.split("\n").forEach((raw, i) => {
    const line = i + 1;
    let s = raw;
    let j = 0;
    while (j < s.length) {
      const c = s[j]!;
      if (c === " " || c === "\t" || c === "\r") { j++; continue; }
      if (s.startsWith("//", j)) break;
      if (c === '"') {
        let k = j + 1, text = "";
        while (k < s.length && s[k] !== '"') { if (s[k] === "\\" && k + 1 < s.length) { text += s[k + 1]; k += 2; } else text += s[k++]; }
        if (k >= s.length) throw new ParseError(line, "unterminated string");
        out.push({ k: "str", t: text, line });
        j = k + 1;
        continue;
      }
      if (c === "'") {
        const m = /^'[a-z_][a-z0-9_]*/.exec(s.slice(j));
        if (!m) throw new ParseError(line, "a lifetime name such as 'a");
        out.push({ k: "lt", t: m[0], line });
        j += m[0].length;
        continue;
      }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(j));
      if (id) { out.push({ k: "id", t: id[0], line }); j += id[0].length; continue; }
      const num = /^[0-9]+/.exec(s.slice(j));
      if (num) { out.push({ k: "num", t: num[0], line }); j += num[0].length; continue; }
      const sym = SYMS.find((x) => s.startsWith(x, j));
      if (!sym) throw new ParseError(line, `unexpected character ${c}`);
      out.push({ k: "sym", t: sym, line });
      j += sym.length;
    }
    s = "";
  });
  return out;
}

/** A type as written: `&'a mut Vec<i32>` is { ref: { mut: true, lt: "'a" }, name: "Vec<i32>" }. */
export interface Ty { ref?: { mut: boolean; lt?: string }; name: string }

export type Expr =
  | { k: "int"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "var"; name: string }
  | { k: "borrow"; mut: boolean; name: string; index?: Expr }
  /** `&5`: a reference to a constant, promoted to a static, so it holds no loan. */
  | { k: "constref"; v: number }
  | { k: "deref"; name: string }
  | { k: "index"; name: string; index: Expr }
  | { k: "new"; what: "String" | "Vec" | "Box" | "Noisy"; args: Expr[]; text?: string }
  | { k: "method"; recv: string; method: string; args: Expr[] }
  | { k: "call"; fn: string; args: Expr[] }
  | { k: "println"; fmt: string; args: Expr[] };

/** A function declared by its signature only (one line): `fn longest<'a>(x: &'a str, y: &'a str) -> &'a str;`. */
export interface FnDecl extends FnSig { line: number }

export type Stmt =
  | { k: "let"; name: string; mut: boolean; ty?: Ty; init?: Expr; line: number }
  | { k: "assign"; name: string; deref: boolean; op: "=" | "+=" | "-="; value: Expr; line: number }
  | { k: "expr"; e: Expr; line: number }
  | { k: "block"; body: Stmt[]; line: number; end: number }
  | { k: "fn"; fn: FnDecl; line: number };

class Parser {
  i = 0;
  readonly toks: Tok[];
  readonly lastLine: number;
  readonly src: string[];
  constructor(toks: Tok[], lastLine: number, src: string[]) { this.toks = toks; this.lastLine = lastLine; this.src = src; }
  peek(o = 0) { return this.toks[this.i + o]; }
  line() { return this.peek()?.line ?? this.lastLine; }
  is(t: string, o = 0) { const x = this.peek(o); return !!x && (x.k === "sym" || x.k === "id") && x.t === t; }
  eat(t: string) { if (this.is(t)) { this.i++; return true; } return false; }
  want(t: string) { if (!this.eat(t)) throw new ParseError(this.line(), `expected \`${t}\`${this.peek() ? ` before \`${this.peek()!.t}\`` : " at the end"}`); }
  ident(what = "a name"): string {
    const x = this.peek();
    if (!x || x.k !== "id") throw new ParseError(this.line(), `expected ${what}`);
    this.i++;
    return x.t;
  }
  /** a::b::c */
  path(): string {
    let n = this.ident();
    while (this.is("::")) { this.i++; n += "::" + this.ident(); }
    return n;
  }

  block(end: string | null): Stmt[] {
    const out: Stmt[] = [];
    while (this.peek() && !(end && this.is(end))) out.push(this.stmt());
    return out;
  }

  stmt(): Stmt {
    const line = this.line();
    if (this.eat("{")) {
      const body = this.block("}");
      const end = this.line();
      this.want("}");
      return { k: "block", body, line, end };
    }
    if (this.is("fn")) {
      // a signature fits on one line; lifetimes.ts parses it
      while (this.peek() && this.peek()!.line === line) this.i++;
      try {
        return { k: "fn", fn: { ...parseSig(this.src[line - 1]!.replace(/\/\/.*$/, "").trim()), line }, line };
      } catch (e) {
        if (e instanceof SigError) throw new ParseError(line, e.message);
        throw e;
      }
    }
    if (this.eat("let")) {
      const mut = this.eat("mut");
      const name = this.ident("a variable name");
      const ty = this.eat(":") ? this.type() : undefined;
      const init = this.eat("=") ? this.expr() : undefined;
      this.want(";");
      return { k: "let", name, mut, ty, init, line };
    }
    // assignment: x = e;  *x = e;  x += e;
    const deref = this.is("*") && this.peek(1)?.k === "id" && ["=", "+=", "-="].includes(this.peek(2)?.t ?? "");
    if (deref || (this.peek()?.k === "id" && ["=", "+=", "-="].includes(this.peek(1)?.t ?? "") && this.peek(1)?.k === "sym")) {
      if (deref) this.i++;
      const name = this.ident();
      const op = this.peek()!.t as "=" | "+=" | "-=";
      this.i++;
      const value = this.expr();
      this.want(";");
      return { k: "assign", name, deref, op, value, line };
    }
    const e = this.expr();
    this.want(";");
    return { k: "expr", e, line };
  }

  type(): Ty {
    if (this.eat("&")) {
      const x = this.peek();
      let lt: string | undefined;
      if (x?.k === "lt") { lt = x.t; this.i++; }
      const mut = this.eat("mut");
      return { ref: { mut, lt }, name: this.type().name };
    }
    let name = this.path();
    if (this.eat("<")) { name += "<" + this.type().name + ">"; this.want(">"); }
    return { name };
  }

  args(close: string): Expr[] {
    const out: Expr[] = [];
    if (!this.is(close)) do out.push(this.expr()); while (this.eat(","));
    this.want(close);
    return out;
  }

  expr(): Expr {
    const x = this.peek();
    if (!x) throw new ParseError(this.lastLine, "expected an expression");
    if (x.k === "num") { this.i++; return { k: "int", v: Number(x.t) }; }
    if (x.k === "str") { this.i++; return { k: "str", v: x.t }; }
    if (this.eat("&")) {
      const mut = this.eat("mut");
      const lit = this.peek();
      if (!mut && lit?.k === "num") { this.i++; return { k: "constref", v: Number(lit.t) }; }
      const name = this.ident("a variable to borrow");
      const index = this.eat("[") ? this.indexExpr() : undefined;
      return { k: "borrow", mut, name, index };
    }
    if (this.eat("*")) return { k: "deref", name: this.ident("a reference to dereference") };
    if (x.k !== "id") throw new ParseError(x.line, `unexpected \`${x.t}\``);
    if (x.t === "true" || x.t === "false") { this.i++; return { k: "bool", v: x.t === "true" }; }
    const name = this.path();
    if (this.eat("!")) {
      if (name === "vec") { this.want("["); return { k: "new", what: "Vec", args: this.args("]") }; }
      if (name === "println") {
        this.want("(");
        const f = this.peek();
        if (!f || f.k !== "str") throw new ParseError(this.line(), "println! needs a format string");
        this.i++;
        const args: Expr[] = [];
        while (this.eat(",")) args.push(this.expr());
        this.want(")");
        return { k: "println", fmt: f.t, args };
      }
      throw new ParseError(x.line, `the toy language has no macro ${name}!`);
    }
    if (name === "String::from") {
      this.want("(");
      const s = this.peek();
      if (!s || s.k !== "str") throw new ParseError(this.line(), 'String::from needs a string literal, such as "hi"');
      this.i++;
      this.want(")");
      return { k: "new", what: "String", args: [], text: s.t };
    }
    if (name === "String::new" || name === "Vec::new") { this.want("("); this.want(")"); return { k: "new", what: name === "Vec::new" ? "Vec" : "String", args: [], text: "" }; }
    if (name === "Box::new") { this.want("("); return { k: "new", what: "Box", args: this.args(")") }; }
    if (name === "Noisy") {
      this.want("(");
      const s = this.peek();
      if (!s || s.k !== "str") throw new ParseError(this.line(), 'Noisy needs a name, such as Noisy("a")');
      this.i++;
      this.want(")");
      return { k: "new", what: "Noisy", args: [], text: s.t };
    }
    if (this.eat("(")) return { k: "call", fn: name, args: this.args(")") };
    if (this.eat(".")) {
      const method = this.ident("a method name");
      this.want("(");
      return { k: "method", recv: name, method, args: this.args(")") };
    }
    if (this.eat("[")) return { k: "index", name, index: this.indexExpr() };
    if (name.includes("::")) throw new ParseError(x.line, `unknown path ${name}`);
    return { k: "var", name };
  }

  indexExpr(): Expr {
    const e = this.expr();
    this.want("]");
    return e;
  }
}

/** Parses a toy program. Throws ParseError with a line number. */
export function parse(src: string): Stmt[] {
  const p = new Parser(lex(src), src.split("\n").length, src.split("\n"));
  return p.block(null);
}

// ---------------------------------------------------------------- values

/** A runtime value. Owned values are objects that move between bindings; a reference points at one. */
export type Val =
  | { t: "int"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "str"; v: string }
  | { t: "unit" }
  | { t: "unknown"; ty: string }
  | { t: "ref"; mut: boolean; to?: Val; opt?: boolean }
  | { t: "own"; what: "String" | "Vec" | "Box" | "Noisy"; text?: string; items?: Val[] };

const isCopy = (v: Val) => v.t === "int" || v.t === "bool" || v.t === "str" || v.t === "unit" || (v.t === "ref" && !v.mut) || (v.t === "unknown" && /^(i32|i64|u32|u64|usize|isize|bool|u8|char)$/.test(v.ty));
const typeText = (v: Val | undefined): string => {
  if (!v) return "?";
  switch (v.t) {
    case "int": return "i32";
    case "bool": return "bool";
    case "str": return "&str";
    case "unit": return "()";
    case "unknown": return v.ty;
    case "ref": return v.opt ? "Option<&i32>" : `&${v.mut ? "mut " : ""}${typeText(v.to)}`;
    case "own":
      if (v.what === "Vec") return `Vec<${v.items?.[0]?.t === "own" ? typeText(v.items[0]) : "i32"}>`;
      if (v.what === "Box") return `Box<${typeText(v.items?.[0])}>`;
      return v.what;
  }
};

function show(v: Val | undefined, debug: boolean): string {
  if (!v) return "?";
  switch (v.t) {
    case "int": return String(v.v);
    case "bool": return String(v.v);
    case "str": return debug ? JSON.stringify(v.v) : v.v;
    case "unit": return "()";
    case "unknown": return "?";
    case "ref": return v.opt ? (v.to ? `Some(${show(v.to, debug)})` : "None") : show(v.to, debug);
    case "own":
      if (v.what === "String") return debug ? JSON.stringify(v.text ?? "") : v.text ?? "";
      if (v.what === "Vec") return `[${(v.items ?? []).map((x) => show(x, true)).join(", ")}]`;
      if (v.what === "Box") return show(v.items?.[0], debug);
      return `Noisy(${JSON.stringify(v.text)})`;
  }
}

// ---------------------------------------------------------------- results

export interface Label { line: number; text: string; primary?: boolean }
export interface Diag { code: string; line: number; message: string; labels: Label[] }

/** One step of the lowered program, for the stepper views. */
export interface ActionView {
  line: number;
  /** What the step does, in words. */
  text: string;
  op: "borrow" | "reserve" | "activate" | "read" | "move" | "write" | "use" | "def" | "dead" | "drop" | "print" | "call";
  /** The loan that this step makes or activates. */
  loan?: number;
  /** Loans live at this step (the ones that can conflict with it). */
  live: number[];
  /** The error that this step causes. */
  error?: Diag;
}

export interface LoanView {
  id: number;
  /** The borrowed variable. */
  place: string;
  mut: boolean;
  twoPhase: boolean;
  line: number;
  /** The variables that hold the loan at some point (empty for a loan that only a temporary holds). */
  holders: string[];
  /** The last line at which the loan is live, or its own line if it dies in its statement. */
  until: number;
}

export interface BindingView { name: string; line: number; end: number; mut: boolean; type: string; movedAt?: number; droppedAt?: number }

export interface CheckResult {
  ok: boolean;
  parseError?: { line: number; message: string };
  errors: Diag[];
  /** What the program prints when run (only meaningful when ok). */
  stdout: string[];
  /** Run-time events in order: prints, drops and heap frees. */
  events: { line: number; text: string; kind: "print" | "drop" | "free" | "forget" }[];
  actions: ActionView[];
  loans: LoanView[];
  bindings: BindingView[];
  /** Number of source lines. */
  lines: number;
}

// ---------------------------------------------------------------- lowering

interface Binding {
  id: number;
  name: string;
  mut: boolean;
  line: number;
  scope: number;
  end: number;
  val?: Val;
  init: boolean;
  /** Line of the move that left it empty. */
  moved?: number;
  /** Was this binding ever assigned after its `let`? (for E0384) */
  assigned: boolean;
}

/** A holder of loans: a binding id (>= 0) or a temporary (< 0). */
type H = number;

type Act =
  | { op: "borrow"; line: number; place: number; mut: boolean; loan: number; holder: H; twoPhase: boolean }
  | { op: "activate"; line: number; loan: number }
  | { op: "read"; line: number; place: number; how: "copy" | "borrow" }
  | { op: "move"; line: number; place: number }
  | { op: "write"; line: number; place: number }
  | { op: "use"; line: number; holder: H; deref?: boolean }
  | { op: "def"; line: number; holder: H; from: H[]; clear: boolean }
  | { op: "dead"; line: number; place: number }
  | { op: "event"; line: number; text: string; kind: "print" | "drop" | "free" | "forget" }
  | { op: "error"; line: number; diag: Diag }
  | { op: "note"; line: number; text: string };

interface Loan { id: number; place: number; mut: boolean; twoPhase: boolean; line: number; active: boolean }

const METHODS: Record<string, { self: "ref" | "mut"; ret: "int" | "own" | "ref" | "opt" | "unit" | "bool" }> = {
  len: { self: "ref", ret: "int" },
  is_empty: { self: "ref", ret: "bool" },
  clone: { self: "ref", ret: "own" },
  first: { self: "ref", ret: "opt" },
  last: { self: "ref", ret: "opt" },
  as_str: { self: "ref", ret: "ref" },
  push: { self: "mut", ret: "unit" },
  push_str: { self: "mut", ret: "unit" },
  clear: { self: "mut", ret: "unit" },
  pop: { self: "mut", ret: "unit" },
};

const dropName = (v: Val): string => (v.t === "own" ? (v.what === "Noisy" ? `Noisy("${v.text}")` : typeText(v)) : typeText(v));

class Lowerer {
  acts: Act[] = [];
  binds: Binding[] = [];
  scopes: number[][] = [[]];
  loans: Loan[] = [];
  fns = new Map<string, FnDecl>();
  fnErrors: Diag[] = [];
  nextTemp = -1;
  /** The holders that each loan was given to, by name. */
  loanHolders = new Map<number, Set<number>>();

  readonly lines: number;
  constructor(lines: number) { this.lines = lines; }

  emit(a: Act) { this.acts.push(a); }
  temp(): H { return this.nextTemp--; }

  find(name: string, line: number): Binding {
    for (let s = this.scopes.length - 1; s >= 0; s--) {
      const ids = this.scopes[s]!;
      for (let k = ids.length - 1; k >= 0; k--) {
        const b = this.binds[ids[k]!]!;
        if (b.name === name) return b;
      }
    }
    throw new ParseError(line, `cannot find value \`${name}\` in this scope`);
  }

  newLoan(place: Binding, mut: boolean, line: number, twoPhase = false): Loan {
    const l: Loan = { id: this.loans.length, place: place.id, mut, twoPhase, line, active: !twoPhase };
    this.loans.push(l);
    return l;
  }

  /** Is the binding a reference variable (a holder of loans)? */
  isRef(b: Binding) { return b.val?.t === "ref"; }

  /**
   * Evaluates `e` for its value. `into` is the holder that receives any loans the value carries (a binding or a
   * temporary). Returns the value.
   */
  value(e: Expr, line: number, into: H): Val {
    switch (e.k) {
      case "int": return { t: "int", v: e.v };
      case "bool": return { t: "bool", v: e.v };
      case "str": return { t: "str", v: e.v };
      case "var": {
        const b = this.find(e.name, line);
        const v = b.val;
        if (v && v.t === "ref") {
          this.emit({ op: "use", line, holder: b.id });
          if (v.mut) this.emit({ op: "move", line, place: b.id });
          this.emit({ op: "def", line, holder: into, from: [b.id], clear: true });
          return v;
        }
        if (v && isCopy(v)) { this.emit({ op: "read", line, place: b.id, how: "copy" }); return { ...v } as Val; }
        this.emit({ op: "move", line, place: b.id });
        return v ?? { t: "unknown", ty: "?" };
      }
      case "borrow": {
        const b = this.find(e.name, line);
        if (e.index) this.value(e.index, line, this.temp());
        if (b.val?.t === "ref") {
          // &r or &r[0] through a reference: a reborrow; the new reference has r's loans
          this.emit({ op: "use", line, holder: b.id });
          this.emit({ op: "def", line, holder: into, from: [b.id], clear: true });
          const to = e.index && b.val.to?.t === "own" ? b.val.to.items?.[0] : b.val.to;
          return { t: "ref", mut: e.mut, to };
        }
        const l = this.newLoan(b, e.mut, line);
        this.emit({ op: "borrow", line, place: b.id, mut: e.mut, loan: l.id, holder: into, twoPhase: false });
        const idx = e.index?.k === "int" ? e.index.v : 0;
        const to = e.index && b.val?.t === "own" ? b.val.items?.[idx] : b.val;
        return { t: "ref", mut: e.mut, to };
      }
      case "constref":
        this.emit({ op: "def", line, holder: into, from: [], clear: true });
        return { t: "ref", mut: false, to: { t: "int", v: e.v } };
      case "deref": {
        const b = this.find(e.name, line);
        this.emit({ op: "use", line, holder: b.id, deref: true });
        const to = b.val?.t === "ref" ? b.val.to : undefined;
        if (b.val?.t !== "ref") this.emit({ op: "error", line, diag: { code: "E0614", line, message: `type \`${typeText(b.val)}\` cannot be dereferenced`, labels: [{ line, text: "can't be dereferenced", primary: true }] } });
        return to && isCopy(to) ? { ...to } as Val : { t: "unknown", ty: typeText(to) };
      }
      case "index": {
        const b = this.find(e.name, line);
        this.value(e.index, line, this.temp());
        if (b.val?.t === "ref") this.emit({ op: "use", line, holder: b.id });
        else this.emit({ op: "read", line, place: b.id, how: "borrow" });
        const vec = b.val?.t === "ref" ? b.val.to : b.val;
        const idx = e.index.k === "int" ? e.index.v : 0;
        const item = vec?.t === "own" ? vec.items?.[idx] : undefined;
        return item && isCopy(item) ? { ...item } as Val : { t: "unknown", ty: "i32" };
      }
      case "new": {
        if (e.what === "String") return { t: "own", what: "String", text: e.text ?? "" };
        if (e.what === "Noisy") return { t: "own", what: "Noisy", text: e.text };
        const items = e.args.map((a) => this.value(a, line, this.temp()));
        return { t: "own", what: e.what, items };
      }
      case "method": return this.method(e, line, into);
      case "call": return this.call(e, line, into);
      case "println": return this.println(e, line);
    }
  }

  /** Evaluates `e` as a statement or a temporary: an owned result drops at the end of the statement. */
  temporary(e: Expr, line: number) {
    const t = this.temp();
    const v = this.value(e, line, t);
    if (v.t === "own" && !(e.k === "var")) this.dropValue(v, line, "temporary");
  }

  method(e: Extract<Expr, { k: "method" }>, line: number, into: H): Val {
    const b = this.find(e.recv, line);
    const m = METHODS[e.method];
    if (!m) throw new ParseError(line, `the toy language has no method ${e.method}; try len, clone, push, push_str, clear, pop, first, as_str`);
    const recv = b.val?.t === "ref" ? b.val.to : b.val;
    if (b.val?.t === "ref") {
      // a method through a reference: a use of the reference
      if (m.self === "mut" && !b.val.mut) {
        this.emit({ op: "error", line, diag: { code: "E0596", line, message: `cannot borrow \`*${b.name}\` as mutable, as it is behind a \`&\` reference`, labels: [{ line, text: `\`${b.name}\` is a \`&\` reference, so the data it refers to cannot be borrowed as mutable`, primary: true }] } });
      }
      const args = e.args.map((a) => this.value(a, line, this.temp()));
      this.emit({ op: "use", line, holder: b.id });
      const r = this.apply(recv, e.method, args);
      if (m.ret === "ref" || m.ret === "opt") this.emit({ op: "def", line, holder: into, from: [b.id], clear: true });
      return r;
    }
    if (m.self === "ref") {
      if (m.ret === "ref" || m.ret === "opt") {
        const l = this.newLoan(b, false, line);
        this.emit({ op: "borrow", line, place: b.id, mut: false, loan: l.id, holder: into, twoPhase: false });
      } else this.emit({ op: "read", line, place: b.id, how: "borrow" });
      const args = e.args.map((a) => this.value(a, line, this.temp()));
      return this.apply(recv, e.method, args);
    }
    // &mut self: a two-phase borrow
    const t = this.temp();
    const l = this.newLoan(b, true, line, true);
    this.emit({ op: "borrow", line, place: b.id, mut: true, loan: l.id, holder: t, twoPhase: true });
    const args = e.args.map((a) => this.value(a, line, this.temp()));
    this.emit({ op: "activate", line, loan: l.id });
    this.emit({ op: "use", line, holder: t });
    return this.apply(recv, e.method, args, line);
  }

  /** The run-time effect of a method. */
  apply(recv: Val | undefined, method: string, args: Val[], line = 0): Val {
    const own = recv?.t === "own" ? recv : undefined;
    switch (method) {
      case "len": return { t: "int", v: own ? (own.what === "String" ? (own.text ?? "").length : own.items?.length ?? 0) : 0 };
      case "is_empty": return { t: "bool", v: own ? (own.what === "String" ? !own.text : !own.items?.length) : true };
      case "clone": return own ? { ...own, items: own.items?.map((x) => ({ ...x }) as Val) } : { t: "unknown", ty: "?" };
      case "first": case "last": {
        const it = own?.items;
        return { t: "ref", mut: false, opt: true, to: it?.length ? it[method === "first" ? 0 : it.length - 1] : undefined };
      }
      case "as_str": return { t: "ref", mut: false, to: { t: "str", v: own?.text ?? "" } };
      case "push": if (own) own.items = [...(own.items ?? []), args[0] ?? { t: "unknown", ty: "?" }]; return { t: "unit" };
      case "push_str": if (own) own.text = (own.text ?? "") + (args[0]?.t === "str" ? args[0].v : ""); return { t: "unit" };
      case "clear":
        if (own?.items) for (const x of own.items) if (x.t === "own") this.dropValue(x, line, "element");
        if (own) { own.text = own.what === "String" ? "" : own.text; if (own.items) own.items = []; }
        return { t: "unit" };
      case "pop": {
        const x = own?.items?.pop();
        if (x?.t === "own") this.dropValue(x, line, "popped value");
        return { t: "unit" };
      }
    }
    return { t: "unit" };
  }

  call(e: Extract<Expr, { k: "call" }>, line: number, into: H): Val {
    const name = e.fn.replace(/^std::/, "");
    if (name === "drop" || name === "consume" || name === "mem::forget") {
      if (e.args.length !== 1) throw new ParseError(line, `${e.fn} takes one argument`);
      const v = this.value(e.args[0]!, line, this.temp());
      if (v.t === "own") {
        if (name === "mem::forget") this.emit({ op: "event", line, text: `forget ${dropName(v)}: never dropped, its memory leaks`, kind: "forget" });
        else this.dropValue(v, line, `inside ${name}`);
      }
      return { t: "unit" };
    }
    const f = this.fns.get(name);
    if (!f) throw new ParseError(line, `cannot find function \`${e.fn}\`; declare it first, such as fn ${e.fn}(x: &str) -> &str;`);
    if (f.params.length !== e.args.length) throw new ParseError(line, `${f.name} takes ${f.params.length} argument${f.params.length === 1 ? "" : "s"}`);
    const sig = elide(f);
    const temps: H[] = [];
    e.args.forEach((a, i) => {
      const t = this.temp();
      temps.push(t);
      const pty = f.params[i]!.ty;
      if (pty.k === "ref" && a.k === "var") {
        const b = this.find(a.name, line);
        if (b.val?.t === "ref") {
          // a reference passed to a reference parameter: copied, or reborrowed if it is &mut
          this.emit({ op: "use", line, holder: b.id });
          this.emit({ op: "def", line, holder: t, from: [b.id], clear: true });
          return;
        }
      }
      this.value(a, line, t);
    });
    for (const t of temps) this.emit({ op: "use", line, holder: t });
    const ret = f.ret;
    if (!ret) return { t: "unit" };
    if (ret.k === "ref") {
      const outLt = sig.ok ? sig.output : undefined;
      const from = outLt && outLt !== "'static" ? temps.filter((_, i) => sig.ok && sig.inputs[i] === outLt) : [];
      this.emit({ op: "def", line, holder: into, from, clear: true });
      return { t: "ref", mut: ret.mut, to: { t: "unknown", ty: tyText(ret.to) } };
    }
    if (ret.k === "path" && ret.name === "String") return { t: "own", what: "String", text: "?" };
    return { t: "unknown", ty: tyText(ret) };
  }

  println(e: Extract<Expr, { k: "println" }>, line: number): Val {
    const vals: { v: Val; debug: boolean }[] = [];
    const specs = e.fmt.match(/\{(:\?)?\}/g) ?? [];
    e.args.forEach((a, i) => {
      // format_args! takes a reference to each argument
      let v: Val;
      if (a.k === "var") {
        const b = this.find(a.name, line);
        if (b.val?.t === "ref") { this.emit({ op: "use", line, holder: b.id }); v = b.val; }
        else { this.emit({ op: "read", line, place: b.id, how: "borrow" }); v = b.val ?? { t: "unknown", ty: "?" }; }
      } else v = this.value(a, line, this.temp());
      vals.push({ v, debug: specs[i] === "{:?}" });
    });
    let k = 0;
    const text = e.fmt.replace(/\{(:\?)?\}/g, () => { const x = vals[k++]; return x ? show(x.v, x.debug) : "{}"; });
    this.emit({ op: "event", line, text, kind: "print" });
    return { t: "unit" };
  }

  /** Drops an owned value: Noisy prints; Vec drops its elements in order; Box drops its content; then the heap frees. */
  dropValue(v: Val, line: number, why: string) {
    if (v.t !== "own") return;
    if (v.what === "Noisy") { this.emit({ op: "event", line, text: `drop ${v.text}`, kind: "drop" }); return; }
    for (const x of v.items ?? []) this.dropValue(x, line, why);
    this.emit({ op: "event", line, text: `free the heap buffer of a ${typeText(v)} (${why})`, kind: "free" });
  }

  stmts(list: Stmt[]) { for (const s of list) this.stmt(s); }

  stmt(s: Stmt) {
    switch (s.k) {
      case "fn": {
        this.fns.set(s.fn.name, s.fn);
        const sig = elide(s.fn);
        if (!sig.ok) this.fnErrors.push({ code: sig.code, line: s.line, message: sig.message, labels: [{ line: s.line, text: sig.label, primary: true }, ...(sig.help ? [{ line: s.line, text: `help: ${sig.help}` }] : [])] });
        return;
      }
      case "let": {
        if (s.name === "_") {
          if (!s.init) throw new ParseError(s.line, "let _ needs a value");
          if (s.init.k === "var") { this.find(s.init.name, s.line); this.emit({ op: "note", line: s.line, text: `let _ = ${s.init.name}: a place expression, so nothing moves` }); return; }
          this.temporary(s.init, s.line);
          return;
        }
        const id = this.binds.length;
        const b: Binding = { id, name: s.name, mut: s.mut, line: s.line, scope: this.scopes.length - 1, end: this.lines, init: false, assigned: false };
        // evaluate before the new binding is in scope (shadowing: `let x = x;` reads the old x)
        if (s.init) {
          b.val = this.value(s.init, s.line, id);
          b.init = true;
          if (b.val.t === "ref") this.emit({ op: "def", line: s.line, holder: id, from: [], clear: false });
          this.emit({ op: "write", line: s.line, place: id });
        } else if (s.ty) b.val = s.ty.ref ? { t: "ref", mut: s.ty.ref.mut } : { t: "unknown", ty: s.ty.name };
        this.binds.push(b);
        this.scopes[this.scopes.length - 1]!.push(id);
        return;
      }
      case "assign": {
        const b = this.find(s.name, s.line);
        if (s.deref) {
          this.value(s.value, s.line, this.temp());
          this.emit({ op: "use", line: s.line, holder: b.id, deref: true });
          if (b.val?.t === "ref" && !b.val.mut) {
            this.emit({ op: "error", line: s.line, diag: { code: "E0594", line: s.line, message: `cannot assign to \`*${b.name}\`, which is behind a \`&\` reference`, labels: [{ line: s.line, text: `\`${b.name}\` is a \`&\` reference, so the data it refers to cannot be written`, primary: true }] } });
          }
          const to = b.val?.t === "ref" ? b.val.to : undefined;
          if (to?.t === "int") this.arith(to, s);
          return;
        }
        if (s.op !== "=") {
          this.value(s.value, s.line, this.temp());
          this.emit({ op: "read", line: s.line, place: b.id, how: "copy" });
          this.emit({ op: "write", line: s.line, place: b.id });
          if (b.val?.t === "int") this.arith(b.val, s);
          return;
        }
        const v = this.value(s.value, s.line, b.id);
        const old = b.val;
        this.emit({ op: "write", line: s.line, place: b.id });
        if (v.t === "ref") this.emit({ op: "def", line: s.line, holder: b.id, from: [], clear: false });
        this.assigns.push({ act: this.acts.length - 1, b, old, v });
        b.val = v;
        return;
      }
      case "expr":
        this.temporary(s.e, s.line);
        return;
      case "block": {
        this.scopes.push([]);
        this.stmts(s.body);
        this.closeScope(s.end);
        return;
      }
    }
  }
  assigns: { act: number; b: Binding; old?: Val; v: Val }[] = [];

  arith(target: Extract<Val, { t: "int" }>, s: Extract<Stmt, { k: "assign" }>) {
    const rhs = s.value.k === "int" ? s.value.v : 0;
    if (s.op === "=") target.v = rhs;
    else target.v += s.op === "+=" ? rhs : -rhs;
  }

  closeScope(end: number) {
    const ids = this.scopes.pop()!;
    for (let k = ids.length - 1; k >= 0; k--) {
      const b = this.binds[ids[k]!]!;
      b.end = end;
      this.emit({ op: "dead", line: end, place: b.id });
    }
  }
}

// ---------------------------------------------------------------- liveness and checking

export interface CheckOptions {
  /** Model the pre-NLL checker: a reference stays live to the end of its variable's block. */
  lexical?: boolean;
}

/** Parses, lowers, checks and runs a toy program. */
export function check(src: string, opts: CheckOptions = {}): CheckResult {
  const lines = src.split("\n").length;
  const empty: CheckResult = { ok: false, errors: [], stdout: [], events: [], actions: [], loans: [], bindings: [], lines };
  let L: Lowerer;
  try {
    const prog = parse(src);
    L = new Lowerer(lines);
    L.stmts(prog);
    L.closeScope(lines + 1);
  } catch (err) {
    if (err instanceof ParseError) return { ...empty, parseError: { line: err.line, message: err.message } };
    throw err;
  }
  const acts = L.acts;
  // a binding with no type, no value and no assignment: type inference fails
  for (const b of L.binds) if (!b.val) L.fnErrors.push({ code: "E0282", line: b.line, message: "type annotations needed", labels: [{ line: b.line, text: "consider giving this binding a type, such as `let x: i32;`", primary: true }] });
  // rustc reports a bad signature and does not borrow-check a function whose types have errors
  if (L.fnErrors.length) {
    return { ...empty, errors: L.fnErrors, bindings: L.binds.map((b) => ({ name: b.name, line: b.line, end: b.end, mut: b.mut, type: typeText(b.val) })) };
  }

  // liveness: for each holder, the indices of its uses and of its (re)definitions
  const uses = new Map<H, number[]>(), defs = new Map<H, number[]>();
  const push = (m: Map<H, number[]>, h: H, i: number) => { const l = m.get(h); if (l) l.push(i); else m.set(h, [i]); };
  acts.forEach((a, i) => {
    if (a.op === "use") push(uses, a.holder, i);
    if (a.op === "def" && a.clear) push(defs, a.holder, i);
    if (a.op === "borrow" && a.holder >= 0) push(defs, a.holder, i);
  });
  const deadAt = new Map<number, number>();
  acts.forEach((a, i) => { if (a.op === "dead") deadAt.set(a.place, i); });
  /** Is holder h live just after action i? */
  const live = (h: H, i: number): boolean => {
    if (opts.lexical && h >= 0) return i < (deadAt.get(h) ?? acts.length);
    const u = uses.get(h)?.find((j) => j > i);
    if (u === undefined) return false;
    const d = defs.get(h)?.find((j) => j > i && j < u);
    return d === undefined;
  };

  const holderLoans = new Map<H, Set<number>>();
  const loans = L.loans;
  const holdersOf = (loan: number) => [...holderLoans].filter(([, s]) => s.has(loan)).map(([h]) => h);
  const liveLoans = (i: number) => loans.filter((l) => holdersOf(l.id).some((h) => live(h, i)));
  /** The next use of a loan after i (for the "later used here" label). */
  const laterUse = (loan: number, i: number): number | undefined => {
    let best: number | undefined;
    for (const h of holdersOf(loan)) {
      const u = opts.lexical && h >= 0 ? deadAt.get(h) : uses.get(h)?.find((j) => j > i);
      if (u !== undefined && (best === undefined || u < best)) best = u;
    }
    return best === undefined ? undefined : acts[best]!.line;
  };

  const binds = L.binds;
  const state = binds.map(() => ({ init: false, moved: undefined as number | undefined, everInit: false }));
  const errors: Diag[] = [];
  const views: ActionView[] = [];
  const stdout: string[] = [];
  const events: CheckResult["events"] = [];
  const reported = new Set<string>();
  const nameOf = (id: number) => binds[id]!.name;
  const lastUse = new Map<number, number>();
  const assignAt = new Map(L.assigns.map((x) => [x.act, x] as const));
  const droppedAt = new Map<number, number>();

  const err = (d: Diag, key: string) => {
    if (reported.has(key)) return undefined;
    reported.add(key);
    errors.push(d);
    return d;
  };

  acts.forEach((a, i) => {
    const liveNow = liveLoans(i);
    for (const l of liveNow) lastUse.set(l.id, Math.max(lastUse.get(l.id) ?? 0, a.line));
    let error: Diag | undefined;
    let text = "";
    let op: ActionView["op"] = "use";
    let loanId: number | undefined;
    const others = (place: number, except?: number) => liveNow.filter((l) => l.place === place && l.id !== except);
    /** E0382 / E0381 for an access to a binding that holds no value. */
    const empty = (place: number, how: "use" | "borrow"): boolean => {
      const s = state[place]!;
      if (s.moved !== undefined) {
        const b = binds[place]!;
        error = err({
          code: "E0382", line: a.line, message: `${how} of moved value: \`${b.name}\``,
          labels: [
            { line: b.line, text: `move occurs because \`${b.name}\` has type \`${typeText(b.val)}\`, which does not implement the \`Copy\` trait` },
            { line: s.moved, text: "value moved here" },
            { line: a.line, text: `value ${how === "use" ? "used" : "borrowed"} here after move`, primary: true },
          ],
        }, `E0382:${place}:${s.moved}`);
        return true;
      }
      if (!s.init) {
        const b = binds[place]!;
        error = err({ code: "E0381", line: a.line, message: `used binding \`${b.name}\` isn't initialized`, labels: [{ line: b.line, text: "binding declared here but left uninitialized" }, { line: a.line, text: `\`${b.name}\` used here but it isn't initialized`, primary: true }] }, `E0381:${place}:${a.line}`);
        return true;
      }
      return false;
    };

    switch (a.op) {
      case "borrow": {
        op = a.twoPhase ? "reserve" : "borrow";
        loanId = a.loan;
        const b = binds[a.place]!;
        const loan = loans[a.loan]!;
        text = a.twoPhase ? `reserve a mutable borrow of ${b.name} (loan L${a.loan}); it acts as shared until it is activated` : `borrow ${b.name} ${a.mut ? "mutably" : "shared"} (loan L${a.loan})${a.holder >= 0 ? ` into ${nameOf(a.holder)}` : ""}`;
        if (empty(a.place, "borrow")) break;
        if (a.mut && !b.mut) {
          error = err({ code: "E0596", line: a.line, message: `cannot borrow \`${b.name}\` as mutable, as it is not declared as mutable`, labels: [{ line: a.line, text: "cannot borrow as mutable", primary: true }, { line: b.line, text: "consider changing this to be mutable: `mut " + b.name + "`" }] }, `E0596:${a.place}:${a.line}`);
        }
        // a two-phase reservation and a shared borrow conflict only with live mutable loans
        const conflict = (a.mut && !a.twoPhase ? others(a.place) : others(a.place).filter((l) => l.mut && l.active))[0];
        if (!error && conflict) error = conflictError(conflict, a.mut, b.name, a.line, i);
        // the holder gets a new value: this loan only
        holderLoans.set(a.holder, new Set([a.loan]));
        void loan;
        break;
      }
      case "activate": {
        op = "activate";
        loanId = a.loan;
        const loan = loans[a.loan]!;
        loan.active = true;
        const b = binds[loan.place]!;
        text = `activate loan L${a.loan}: now it is a mutable borrow of ${b.name}`;
        const conflict = others(loan.place, loan.id)[0];
        if (conflict) error = conflictError(conflict, true, b.name, a.line, i);
        break;
      }
      case "read": {
        op = "read";
        const b = binds[a.place]!;
        text = a.how === "copy" ? `copy the value of ${b.name}` : `borrow ${b.name} shared for this statement`;
        if (empty(a.place, a.how === "copy" ? "use" : "borrow")) break;
        const conflict = others(a.place).filter((l) => l.mut && l.active)[0];
        if (conflict) {
          if (a.how === "borrow") error = conflictError(conflict, false, b.name, a.line, i);
          else {
            const later = laterUse(conflict.id, i);
            error = err({ code: "E0503", line: a.line, message: `cannot use \`${b.name}\` because it was mutably borrowed`, labels: [
              { line: conflict.line, text: `\`${b.name}\` is borrowed here` }, { line: a.line, text: `use of borrowed \`${b.name}\``, primary: true },
              ...(later ? [{ line: later, text: "borrow later used here" }] : []),
            ] }, `E0503:${a.place}:${a.line}`);
          }
        }
        break;
      }
      case "move": {
        op = "move";
        const b = binds[a.place]!;
        text = `move the value out of ${b.name}; ${b.name} is now empty`;
        if (empty(a.place, "use")) { state[a.place]!.moved = a.line; break; }
        const conflict = others(a.place)[0];
        if (conflict) {
          const later = laterUse(conflict.id, i);
          error = err({ code: "E0505", line: a.line, message: `cannot move out of \`${b.name}\` because it is borrowed`, labels: [
            { line: b.line, text: `binding \`${b.name}\` declared here` }, { line: conflict.line, text: `borrow of \`${b.name}\` occurs here` },
            { line: a.line, text: `move out of \`${b.name}\` occurs here`, primary: true }, ...(later ? [{ line: later, text: "borrow later used here" }] : []),
          ] }, `E0505:${a.place}:${a.line}`);
        }
        state[a.place]!.moved = a.line;
        state[a.place]!.init = false;
        break;
      }
      case "write": {
        op = "write";
        const b = binds[a.place]!;
        const s = state[a.place]!;
        const asg = assignAt.get(i);
        text = asg ? `assign a new value to ${b.name}` : `initialize ${b.name}`;
        const already = errors.some((d) => d.line === a.line && d.message.includes(`\`${b.name}\``));
        if (!already && (asg || (s.everInit && a.line !== b.line))) {
          const conflict = others(a.place)[0];
          if (conflict) {
            const later = laterUse(conflict.id, i);
            error = err({ code: "E0506", line: a.line, message: `cannot assign to \`${b.name}\` because it is borrowed`, labels: [
              { line: conflict.line, text: `\`${b.name}\` is borrowed here` }, { line: a.line, text: `\`${b.name}\` is assigned to here but it was already borrowed`, primary: true },
              ...(later ? [{ line: later, text: "borrow later used here" }] : []),
            ] }, `E0506:${a.place}:${a.line}`);
          } else if (!b.mut && s.everInit) {
            error = err({ code: "E0384", line: a.line, message: `cannot assign twice to immutable variable \`${b.name}\``, labels: [{ line: b.line, text: "first assignment" }, { line: a.line, text: "cannot assign twice to immutable variable", primary: true }] }, `E0384:${a.place}:${a.line}`);
          }
          // the old value drops when a new one is assigned
          if (asg && s.init && asg.old) dropRun(asg.old, a.line, `the old value of ${b.name}`);
        }
        s.init = true;
        s.everInit = true;
        s.moved = undefined;
        break;
      }
      case "use": {
        op = "use";
        for (const l of holderLoans.get(a.holder) ?? []) lastUse.set(l, Math.max(lastUse.get(l) ?? 0, a.line));
        const known = a.holder >= 0;
        text = known ? `use the reference ${nameOf(a.holder)}` : "use a temporary reference";
        if (known && !binds[a.holder]!.val) break;
        if (known) empty(a.holder, a.deref ? "use" : "borrow");
        break;
      }
      case "def": {
        op = "def";
        const set = new Set<number>(a.clear ? [] : holderLoans.get(a.holder) ?? []);
        for (const f of a.from) for (const l of holderLoans.get(f) ?? []) set.add(l);
        holderLoans.set(a.holder, set);
        text = a.holder >= 0 ? `${nameOf(a.holder)} now holds ${set.size ? [...set].map((l) => `L${l}`).join(", ") : "no loans"}` : "a temporary holds the result";
        break;
      }
      case "dead": {
        op = "dead";
        const b = binds[a.place]!;
        const s = state[a.place]!;
        text = `${b.name} goes out of scope`;
        if (s.init && b.val?.t === "own") { droppedAt.set(a.place, a.line); dropRun(b.val, a.line, `${b.name} goes out of scope`); }
        const conflict = others(a.place)[0];
        if (conflict) {
          const later = laterUse(conflict.id, i);
          error = err({ code: "E0597", line: conflict.line, message: `\`${b.name}\` does not live long enough`, labels: [
            { line: b.line, text: `binding \`${b.name}\` declared here` }, { line: conflict.line, text: "borrowed value does not live long enough", primary: true },
            { line: a.line, text: `\`${b.name}\` dropped here while still borrowed` }, ...(later ? [{ line: later, text: "borrow later used here" }] : []),
          ] }, `E0597:${a.place}`);
        }
        break;
      }
      case "event": {
        op = a.kind === "print" ? "print" : "drop";
        if (a.kind === "print") {
          stdout.push(a.text);
          events.push({ line: a.line, text: a.text, kind: "print" });
          text = `print "${a.text}"`;
        } else {
          text = a.text;
          if (a.kind === "drop") stdout.push(a.text);
          events.push({ line: a.line, text: a.text, kind: a.kind });
        }
        break;
      }
      case "error":
        error = err(a.diag, `${a.diag.code}:${a.line}`);
        text = a.diag.message;
        break;
      case "note":
        op = "read";
        text = a.text;
        break;
    }
    views.push({ line: a.line, text, op, loan: loanId, live: liveNow.map((l) => l.id), error });

    function dropRun(v: Val, line: number, why: string) {
      // a dropped value's events: Noisy prints, Vec drops elements in order, then the buffer frees
      if (v.t !== "own") return;
      if (v.what === "Noisy") { stdout.push(`drop ${v.text}`); events.push({ line, text: `drop ${v.text}`, kind: "drop" }); return; }
      for (const x of v.items ?? []) dropRun(x, line, why);
      events.push({ line, text: `free the heap buffer of a ${typeText(v)} (${why})`, kind: "free" });
    }
  });

  function conflictError(c: Loan, mut: boolean, name: string, line: number, i: number): Diag | undefined {
    const later = laterUse(c.id, i);
    if (mut && c.mut) {
      return err({ code: "E0499", line, message: `cannot borrow \`${name}\` as mutable more than once at a time`, labels: [
        { line: c.line, text: "first mutable borrow occurs here" }, { line, text: "second mutable borrow occurs here", primary: true },
        ...(later ? [{ line: later, text: "first borrow later used here" }] : []),
      ] }, `E0499:${name}:${line}`);
    }
    const [now, before] = mut ? ["mutable", "immutable"] : ["immutable", "mutable"];
    return err({ code: "E0502", line, message: `cannot borrow \`${name}\` as ${now} because it is also borrowed as ${before}`, labels: [
      { line: c.line, text: `${before} borrow occurs here` }, { line, text: `${now} borrow occurs here`, primary: true },
      ...(later ? [{ line: later, text: `${before} borrow later used here` }] : []),
    ] }, `E0502:${name}:${line}`);
  }

  const nameSet = (l: number) => [...new Set(holdersOf(l).filter((h) => h >= 0).map(nameOf))];
  const loanViews: LoanView[] = loans.map((l) => ({
    id: l.id, place: nameOf(l.place), mut: l.mut, twoPhase: l.twoPhase, line: l.line, holders: nameSet(l.id), until: Math.max(l.line, lastUse.get(l.id) ?? l.line),
  }));
  const bindings: BindingView[] = binds.map((b) => ({
    name: b.name, line: b.line, end: Math.min(b.end, lines), mut: b.mut, type: typeText(b.val),
    movedAt: state[b.id]!.moved, droppedAt: droppedAt.get(b.id),
  }));
  // the order in which rustc prints: by the primary span, then by code
  errors.sort((x, y) => x.line - y.line);
  return { ok: errors.length === 0, errors, stdout, events, actions: views, loans: loanViews, bindings, lines };
}

/** The errors as [code, line, message], the same shape as programs.ts records from rustc. */
export const errorTriples = (r: CheckResult): [string, number, string][] => r.errors.map((e) => [e.code, e.line, e.message]);
