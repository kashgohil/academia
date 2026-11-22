/**
 * A small Itanium C++ ABI demangler that records each step, for a demo that reads a mangled name one piece at a time.
 *
 * It reads a useful subset of section 5.1 of the Itanium C++ ABI (itanium-cxx-abi.github.io/cxx-abi/abi.html#mangling):
 * nested names (N ... E) with a K for const member functions, source names, constructors (C1, C2, C3), destructors
 * (D0, D1, D2), the common operator names, template arguments (I ... E) and template parameters (T_, T0_), builtin
 * types, P, R, O, K and V, function types (F ... E), array types (A n _), substitutions (S_, S0_, ..., and the
 * abbreviations St, Sa, Sb, Ss, Si, So, Sd), data names, and the special names _ZTV, _ZTI and _ZTS.
 * For a function template, the first type is the return type.
 *
 * The output uses the format of LLVM's c++filt (east const: "char const*", "std::vector<int>" with no space between
 * closing brackets). tests/unit/sys-abi-mangle.test.ts checks it against c++filt (Apple LLVM 21) on symbols compiled
 * with clang. The substitution rules are those of 5.1.10 "Compression": every prefix except the last component of a
 * nested name, every template prefix, and every type that is not a builtin and not itself a substitution.
 *
 * Not read: local names (Z ... E), lambdas and unnamed types, ABI tags (B), expressions in template arguments, pointers
 * to members, vendor qualifiers, and clone suffixes such as ".cold". demangle() returns ok: false for them.
 */

type Node =
  | { k: "name"; s: string }
  | { k: "nested"; parts: Node[] }
  | { k: "tmpl"; of: Node; args: Node[] }
  | { k: "qual"; q: "const" | "volatile"; of: Node }
  | { k: "ptr" | "ref" | "rref"; to: Node }
  | { k: "fn"; ret: Node; params: Node[] }
  | { k: "array"; n: string; of: Node }
  | { k: "ctor"; s: string }
  | { k: "dtor"; s: string };

export interface DemangleStep {
  /** The span of the mangled name that this step read. */
  from: number;
  to: number;
  /** What it means: "source name: geo", "builtin type: int", "substitution S_ = geo". */
  text: string;
  /** Substitution table after this step. */
  subs: string[];
  /** A new entry that this step added. */
  added?: string;
}

export interface Demangled { ok: boolean; out: string; steps: DemangleStep[]; subs: string[]; error?: string }

const BUILTIN: Record<string, string> = {
  v: "void", w: "wchar_t", b: "bool", c: "char", a: "signed char", h: "unsigned char", s: "short", t: "unsigned short",
  i: "int", j: "unsigned int", l: "long", m: "unsigned long", x: "long long", y: "unsigned long long", n: "__int128",
  o: "unsigned __int128", f: "float", d: "double", e: "long double", g: "__float128", z: "...",
};
const BUILTIN2: Record<string, string> = { Dn: "std::nullptr_t", Di: "char32_t", Ds: "char16_t", Du: "char8_t", Da: "auto" };

const OPS: Record<string, string> = {
  nw: "new", na: "new[]", dl: "delete", da: "delete[]", ps: "+", ng: "-", ad: "&", de: "*", co: "~", pl: "+", mi: "-",
  ml: "*", dv: "/", rm: "%", an: "&", or: "|", eo: "^", aS: "=", pL: "+=", mI: "-=", mL: "*=", dV: "/=", rM: "%=",
  aN: "&=", oR: "|=", eO: "^=", ls: "<<", rs: ">>", lS: "<<=", rS: ">>=", eq: "==", ne: "!=", lt: "<", gt: ">",
  le: "<=", ge: ">=", ss: "<=>", nt: "!", aa: "&&", oo: "||", pp: "++", mm: "--", cm: ",", pm: "->*", pt: "->",
  cl: "()", ix: "[]",
};
const STD_ABBR: Record<string, string> = {
  St: "std", Sa: "std::allocator", Sb: "std::basic_string", Ss: "std::string", Si: "std::istream", So: "std::ostream", Sd: "std::iostream",
};

// ---------------------------------------------------------------- printing (LLVM style)

function parts(n: Node): [string, string] {
  switch (n.k) {
    case "name": case "ctor": return [n.s, ""];
    case "dtor": return [`~${n.s}`, ""];
    case "nested": return [n.parts.map((p) => print(p)).join("::"), ""];
    case "tmpl": return [`${print(n.of)}<${n.args.map(print).join(", ")}>`, ""];
    case "qual": { const [l, r] = parts(n.of); return [`${l} ${n.q}`, r]; }
    case "array": { const [l, r] = parts(n.of); return [l, ` [${n.n}]${r}`]; }
    case "fn": return [print(n.ret), `(${n.params.map(print).join(", ")})`];
    case "ptr": case "ref": case "rref": {
      const sym = n.k === "ptr" ? "*" : n.k === "ref" ? "&" : "&&";
      const [l, r] = parts(n.to);
      if (n.to.k === "fn" || n.to.k === "array") return [`${l} (${sym}`, `)${r}`];
      return [`${l}${sym}`, r];
    }
  }
}
const print = (n: Node) => { const [l, r] = parts(n); return l + r; };
/** The last simple name of a name node, for constructors and destructors. */
function lastName(n: Node | undefined): string {
  if (!n) return "";
  if (n.k === "name") return n.s.split("::").pop()!;
  if (n.k === "tmpl") return lastName(n.of);
  if (n.k === "nested") return lastName(n.parts[n.parts.length - 1]);
  return "";
}

class Fail extends Error {}

export function demangle(sym: string): Demangled {
  const s = sym.startsWith("__Z") ? sym.slice(1) : sym; // Mach-O adds an underscore
  const base = sym.length - s.length;
  let p = 0;
  const subs: Node[] = [];
  let targs: Node[] = [];
  const steps: DemangleStep[] = [];
  const subText = () => subs.map((n, i) => `${i === 0 ? "S_" : `S${(i - 1).toString(36).toUpperCase()}_`} = ${print(n)}`);
  const step = (from: number, text: string, added?: Node) => steps.push({ from: from + base, to: p + base, text, subs: subText(), added: added ? print(added) : undefined });
  const addSub = (n: Node) => { subs.push(n); const last = steps[steps.length - 1]; if (last) { last.subs = subText(); last.added = print(n); } };
  const peek = (n = 0) => s[p + n] ?? "";
  const eat = (t: string) => { if (s.startsWith(t, p)) { p += t.length; return true; } return false; };
  const fail = (why: string): never => { throw new Fail(why); };

  const number = () => { const m = /^\d+/.exec(s.slice(p)); if (!m) fail(`expected a number at ${p}`); p += m![0].length; return Number(m![0]); };
  const sourceName = (): Node => {
    const from = p;
    const n = number();
    if (p + n > s.length) fail("name runs past the end");
    const id = s.slice(p, p + n);
    p += n;
    step(from, `source name: length ${n}, "${id}"`);
    return { k: "name", s: id };
  };
  const seq = (): number => {
    // S_ or S <base 36> _
    const from = p;
    if (eat("_")) return 0;
    const m = /^[0-9A-Z]+/.exec(s.slice(p));
    if (!m) fail(`bad substitution at ${from}`);
    p += m![0].length;
    if (!eat("_")) fail("substitution without _");
    return parseInt(m![0], 36) + 1;
  };
  const substitution = (): Node => {
    const from = p;
    for (const [ab, meaning] of Object.entries(STD_ABBR)) if (eat(ab)) { step(from, `abbreviation ${ab} = ${meaning}`); return { k: "name", s: meaning }; }
    eat("S");
    const i = seq();
    const n = subs[i];
    if (!n) fail(`substitution ${s.slice(from, p)} does not exist yet`);
    step(from, `substitution ${s.slice(from, p)} = ${print(n!)}`);
    return n!;
  };
  const templateParam = (): Node => {
    const from = p;
    eat("T");
    const i = seq();
    const n = targs[i];
    if (!n) fail(`template parameter ${s.slice(from, p)} is not known`);
    step(from, `template parameter ${s.slice(from, p)} = ${print(n!)}`);
    return n!;
  };
  const templateArgs = (): Node[] => {
    const from = p;
    eat("I");
    step(from, "I: template arguments begin");
    const args: Node[] = [];
    while (!eat("E")) {
      if (p >= s.length) fail("unterminated template arguments");
      args.push(type());
    }
    step(p - 1, "E: template arguments end");
    return args;
  };
  const unqualified = (prev: Node | undefined): Node => {
    const from = p;
    if (/\d/.test(peek())) return sourceName();
    if (peek() === "C" && /[1-5]/.test(peek(1))) { p += 2; const nm = lastName(prev); step(from, `constructor (${s.slice(from, p)}) of ${nm}`); return { k: "ctor", s: nm }; }
    if (peek() === "D" && /[0-5]/.test(peek(1))) { p += 2; const nm = lastName(prev); step(from, `destructor (${s.slice(from, p)}) of ${nm}`); return { k: "dtor", s: nm }; }
    const op = OPS[s.slice(p, p + 2)];
    if (op) { p += 2; step(from, `operator name ${s.slice(from, p)} = operator${op}`); return { k: "name", s: `operator${op}` }; }
    if (eat("cv")) { const t = type(); return { k: "name", s: `operator ${print(t)}` }; }
    return fail(`cannot read a name at ${p}: "${s.slice(p, p + 6)}"`);
  };
  /** N [K] prefix... E. Returns the name and whether the function is const. */
  const nested = (): { name: Node; isConst: boolean } => {
    const from = p;
    eat("N");
    let isConst = false;
    let cv = "";
    while (/[rVK]/.test(peek())) { const c = s[p++]!; cv += c; if (c === "K") isConst = true; }
    step(from, cv ? `N: nested name begins; ${cv === "K" ? "K: a const member function" : `qualifiers ${cv}`}` : "N: nested name begins");
    const comps: Node[] = [];
    let cur: Node | undefined;
    while (!eat("E")) {
      if (p >= s.length) fail("unterminated nested name");
      let next: Node;
      let wasSub = false;
      if (peek() === "S" && !cur) { next = substitution(); cur = next; comps.push(next); wasSub = true; }
      else if (peek() === "I") {
        if (!cur) fail("template arguments with no name");
        const args = templateArgs();
        next = { k: "tmpl", of: comps[comps.length - 1]!, args };
        comps[comps.length - 1] = next;
        const whole: Node = { k: "nested", parts: comps.slice() };
        cur = comps.length === 1 ? next : whole;
      } else if (peek() === "T") { next = templateParam(); comps.push(next); cur = next; }
      else {
        next = unqualified(cur);
        comps.push(next);
        cur = comps.length === 1 ? next : { k: "nested", parts: comps.slice() };
      }
      // A substitution is not added again; every other prefix is, except the last component.
      if (peek() !== "E" && !wasSub) addSub(cur!);
    }
    step(p - 1, "E: nested name ends");
    return { name: comps.length === 1 ? comps[0]! : { k: "nested", parts: comps }, isConst };
  };
  /** <name>: returns the name, const-ness, and whether it ends in template arguments. */
  const name = (): { name: Node; isConst: boolean; isTemplate: boolean } => {
    if (peek() === "N") {
      const r = nested();
      const last = r.name.k === "nested" ? r.name.parts[r.name.parts.length - 1]! : r.name;
      return { ...r, isTemplate: last.k === "tmpl" };
    }
    let n: Node;
    if (peek() === "S") {
      const from = p;
      if (eat("St")) { step(from, "St = std::"); const u = unqualified(undefined); n = { k: "nested", parts: [{ k: "name", s: "std" }, u] }; }
      else n = substitution();
    } else n = unqualified(undefined);
    if (peek() === "I") {
      addSub(n);
      const args = templateArgs();
      return { name: { k: "tmpl", of: n, args }, isConst: false, isTemplate: true };
    }
    return { name: n, isConst: false, isTemplate: false };
  };
  const type = (): Node => {
    const from = p;
    const c = peek();
    if (BUILTIN[c]) { p++; step(from, `builtin type ${c} = ${BUILTIN[c]}`); return { k: "name", s: BUILTIN[c]! }; }
    const two = s.slice(p, p + 2);
    if (BUILTIN2[two]) { p += 2; step(from, `builtin type ${two} = ${BUILTIN2[two]}`); return { k: "name", s: BUILTIN2[two]! }; }
    let t: Node;
    switch (c) {
      case "P": case "R": case "O": {
        p++;
        step(from, `${c}: ${c === "P" ? "pointer" : c === "R" ? "reference" : "rvalue reference"} to the next type`);
        const inner = type();
        t = { k: c === "P" ? "ptr" : c === "R" ? "ref" : "rref", to: inner };
        break;
      }
      case "K": case "V": {
        p++;
        step(from, `${c}: ${c === "K" ? "const" : "volatile"} applies to the next type`);
        t = { k: "qual", q: c === "K" ? "const" : "volatile", of: type() };
        break;
      }
      case "F": {
        p++;
        eat("Y");
        step(from, "F: function type begins (return type first)");
        const ret = type();
        const params: Node[] = [];
        while (!eat("E")) { if (p >= s.length) fail("unterminated function type"); params.push(type()); }
        step(p - 1, "E: function type ends");
        t = { k: "fn", ret, params: params.length === 1 && print(params[0]!) === "void" ? [] : params };
        break;
      }
      case "A": {
        p++;
        const n = number();
        if (!eat("_")) fail("array without _");
        step(from, `A${n}_: array of ${n}`);
        t = { k: "array", n: String(n), of: type() };
        break;
      }
      case "T": t = templateParam(); break;
      case "S": {
        if (s.startsWith("St", p)) { const r = name(); t = r.name; break; }
        const sub = substitution();
        if (peek() === "I") { const args = templateArgs(); t = { k: "tmpl", of: sub, args }; break; }
        return sub; // a substitution is not added again
      }
      case "N": t = nested().name; break;
      default:
        if (/\d/.test(c)) {
          const n = sourceName();
          if (peek() === "I") { addSub(n); const args = templateArgs(); t = { k: "tmpl", of: n, args }; }
          else t = n;
          break;
        }
        return fail(`cannot read a type at ${p}: "${s.slice(p, p + 6)}"`);
    }
    addSub(t);
    return t;
  };

  try {
    if (!s.startsWith("_Z")) {
      return { ok: true, out: sym, steps: [{ from: 0, to: sym.length, text: "No _Z prefix: a C name, or a name from another scheme. It stays as it is.", subs: [] }], subs: [] };
    }
    p = 2;
    step(0, "_Z: an Itanium C++ mangled name");
    const special: Record<string, string> = { TV: "vtable for ", TI: "typeinfo for ", TS: "typeinfo name for " };
    for (const [code, text] of Object.entries(special)) {
      if (s.startsWith(code, p)) {
        const from = p;
        p += 2;
        step(from, `${code}: ${text.trim()}`);
        const t = type();
        if (p !== s.length) fail("extra characters at the end");
        return { ok: true, out: text + print(t), steps, subs: subText() };
      }
    }
    const r = name();
    if (r.isTemplate) {
      const n = r.name.k === "nested" ? r.name.parts[r.name.parts.length - 1]! : r.name;
      if (n.k === "tmpl") targs = n.args;
    }
    if (p === s.length) return { ok: true, out: print(r.name), steps, subs: subText() };
    let ret: Node | undefined;
    const last = r.name.k === "nested" ? r.name.parts[r.name.parts.length - 1]! : r.name;
    const isCdtor = last.k === "ctor" || last.k === "dtor" || (last.k === "tmpl" && (last.of.k === "ctor" || last.of.k === "dtor"));
    if (r.isTemplate && !isCdtor) { ret = type(); steps[steps.length - 1]!.text += " (the return type of a template)"; }
    const params: Node[] = [];
    while (p < s.length) params.push(type());
    const plist = params.length === 1 && print(params[0]!) === "void" ? "" : params.map(print).join(", ");
    const out = `${ret ? `${print(ret)} ` : ""}${print(r.name)}(${plist})${r.isConst ? " const" : ""}`;
    return { ok: true, out, steps, subs: subText() };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, out: sym, steps, subs: subText(), error: e.message };
    throw e;
  }
}
