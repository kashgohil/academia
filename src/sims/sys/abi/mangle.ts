/**
 * C++ name mangling: a small declaration model, an Itanium C++ ABI mangler and an MSVC mangler for it, and the C++
 * source text of a declaration.
 *
 * Itanium C++ ABI, section 5.1 "External Names" (itanium-cxx-abi.github.io/cxx-abi/abi.html#mangling):
 *   <mangled-name> ::= _Z <encoding>;  <encoding> ::= <name> <bare-function-type>
 *   <nested-name>  ::= N [<CV-qualifiers>] <prefix> <unqualified-name> E      (K = a const member function)
 *   <source-name>  ::= <length> <identifier>                                  ("3geo")
 *   builtin types are one letter (i int, d double, c char, m unsigned long, v void as an empty parameter list);
 *   P pointer, R lvalue reference, O rvalue reference, K const; template args I ... E; template params T_, T0_.
 *   Substitutions (5.1.10 "Compression"): each prefix, template prefix and non-builtin type gets the next seq-id when
 *   it first appears; a later use writes S_ (the first), S0_, S1_, ... S9_, SA_ ... (base 36) instead.
 *   For a function template, the return type is encoded first (5.1.5 "Type encodings", "bare-function-type").
 *
 * MSVC (no public specification; the rules here follow what clang -target x86_64-windows-msvc emits, and LLVM's
 * MicrosoftMangle.cpp): ?name@scope@...@@ then Y (free function) or QE + A/B (public member, this not const or
 * const), A (__cdecl), the return type, the parameter types, then @Z (or XZ for no parameters). Name fragments are
 * remembered: a repeated name is one digit. Parameter types longer than one letter are remembered too.
 * Builtins: X void, _N bool, D char, H int, I unsigned, J long, K unsigned long, _J long long, M float, N double.
 * Pointers: PEA (PEB for a pointer to const), references AEA / AEB, rvalue references $$QEA / $$QEB, U<name>@ a
 * struct.
 *
 * Golden check: tests/unit/sys-abi-mangle.test.ts compares both manglers with the names that clang 21 (zig c++ 0.17.1)
 * emits for random declarations, on x86_64-linux-gnu and x86_64-windows-msvc.
 *
 * Not modelled: std:: abbreviations in the mangler (the demangler reads St, Sa, Ss ...), ABI tags, local names,
 * lambdas, operators, constructors and destructors (the demangler reads them), function and array types (the demangler
 * reads them), templates in the MSVC mangler.
 */

export type Builtin = "void" | "bool" | "char" | "int" | "unsigned" | "long" | "unsigned long" | "long long" | "float" | "double";

export type CType =
  | { k: "b"; name: Builtin }
  | { k: "class"; path: string[] }
  | { k: "ptr" | "ref" | "rref"; to: CType }
  | { k: "const"; of: CType }
  | { k: "tparam"; i: number };

export interface FnDecl {
  /** Namespaces, outermost first. */
  ns: string[];
  /** The class, for a member function. */
  cls?: string;
  name: string;
  params: CType[];
  /** A const member function. */
  constMethod?: boolean;
  /** Template arguments: the function is a template on T (and U), instantiated with these. */
  targs?: CType[];
  /** The return type (encoded only for templates). */
  ret?: CType;
  /** extern "C": no mangling at all. */
  externC?: boolean;
}

export const b = (name: Builtin): CType => ({ k: "b", name });
export const cls = (...path: string[]): CType => ({ k: "class", path });
export const ptrT = (to: CType): CType => ({ k: "ptr", to });
export const refT = (to: CType): CType => ({ k: "ref", to });
export const rrefT = (to: CType): CType => ({ k: "rref", to });
export const constT = (of: CType): CType => ({ k: "const", of });
export const tp = (i: number): CType => ({ k: "tparam", i });

const TP_NAMES = ["T", "U"];

/** C++ source text of a type, west const: "const char *", "geo::Point &". */
export function cppType(t: CType): string {
  switch (t.k) {
    case "b": return t.name;
    case "class": return t.path.join("::");
    case "tparam": return TP_NAMES[t.i]!;
    case "const": return `const ${cppType(t.of)}`;
    case "ptr": return `${cppType(t.to)} *`.replace("* *", "**");
    case "ref": return `${cppType(t.to)} &`;
    case "rref": return `${cppType(t.to)} &&`;
  }
}

/** The declaration as C++ source, one line. */
export function cppDecl(d: FnDecl): string {
  const ps = d.params.map(cppType).join(", ");
  const tmpl = d.targs ? `template <${d.targs.map((_, i) => `class ${TP_NAMES[i]}`).join(", ")}> ` : "";
  const ret = cppType(d.ret ?? b("void"));
  const scope = [...d.ns, ...(d.cls ? [d.cls] : [])];
  const name = [...scope, d.name].join("::");
  return `${d.externC ? 'extern "C" ' : ""}${tmpl}${ret} ${name}(${ps})${d.constMethod ? " const" : ""}`;
}

// ---------------------------------------------------------------- Itanium

const ITANIUM_BUILTIN: Record<Builtin, string> = {
  void: "v", bool: "b", char: "c", int: "i", unsigned: "j", long: "l", "unsigned long": "m", "long long": "x", float: "f", double: "d",
};

/** A piece of a mangled name and what it encodes. `part` ties it to the source: "name", "scope", "param 2", ... */
export interface Piece { text: string; what: string; part: string; sub?: boolean }

export interface Mangled { name: string; pieces: Piece[]; subs: { id: string; meaning: string }[] }

/** The seq-id text of substitution n: S_, S0_, ..., S9_, SA_, ... */
export const seqId = (n: number) => (n === 0 ? "S_" : `S${(n - 1).toString(36).toUpperCase()}_`);
const sourceName = (s: string) => `${s.length}${s}`;

/** Canonical key of a type for the substitution table. */
function key(t: CType): string {
  switch (t.k) {
    case "b": return t.name;
    case "class": return t.path.join("::");
    case "tparam": return `T${t.i}`;
    case "const": return `K(${key(t.of)})`;
    case "ptr": return `P(${key(t.to)})`;
    case "ref": return `R(${key(t.to)})`;
    case "rref": return `O(${key(t.to)})`;
  }
}

export function mangleItanium(d: FnDecl): Mangled {
  const pieces: Piece[] = [];
  if (d.externC) return { name: d.name, pieces: [{ text: d.name, what: 'extern "C": the plain name', part: "name" }], subs: [] };
  const subs: { id: string; key: string; meaning: string }[] = [];
  const add = (k: string, meaning: string) => { subs.push({ id: seqId(subs.length), key: k, meaning }); };
  const find = (k: string) => subs.findIndex((s) => s.key === k);
  const emit = (text: string, what: string, part: string, sub = false) => pieces.push({ text, what, part, sub });
  const tpText = (i: number) => (d.targs ? `${TP_NAMES[i]} = ${cppType(d.targs[i]!)}` : TP_NAMES[i]!);

  /** Emits the components of a scope path, using the longest prefix that is already a substitution. */
  const prefix = (path: string[], part: string, pushLast: boolean) => {
    let start = 0;
    for (let k = path.length; k > 0; k--) {
      const i = find(path.slice(0, k).join("::"));
      if (i >= 0) { emit(seqId(i), `substitution: ${path.slice(0, k).join("::")}`, part, true); start = k; break; }
    }
    for (let k = start; k < path.length; k++) {
      emit(sourceName(path[k]!), `name "${path[k]}"`, part);
      if (k < path.length - 1 || pushLast) add(path.slice(0, k + 1).join("::"), path.slice(0, k + 1).join("::"));
    }
  };

  const type = (t: CType, part: string) => {
    if (t.k === "b") { emit(ITANIUM_BUILTIN[t.name], t.name, part); return; }
    const i = find(key(t));
    if (i >= 0) { emit(seqId(i), `substitution: ${t.k === "tparam" ? tpText(t.i) : cppType(t)}`, part, true); return; }
    switch (t.k) {
      case "class":
        if (t.path.length === 1) { emit(sourceName(t.path[0]!), `class ${t.path[0]}`, part); add(key(t), cppType(t)); }
        else { emit("N", "nested name", part); prefix(t.path, part, true); emit("E", "end of nested name", part); }
        return;
      case "tparam": emit(t.i === 0 ? "T_" : `T${t.i - 1}_`, `template parameter ${tpText(t.i)}`, part); break;
      case "const": emit("K", "const", part); type(t.of, part); break;
      case "ptr": emit("P", "pointer to", part); type(t.to, part); break;
      case "ref": emit("R", "reference to", part); type(t.to, part); break;
      case "rref": emit("O", "rvalue reference to", part); type(t.to, part); break;
    }
    add(key(t), t.k === "tparam" ? tpText(t.i) : cppType(t));
  };

  emit("_Z", "mangled-name prefix", "start");
  const scope = [...d.ns, ...(d.cls ? [d.cls] : [])];
  const targs = () => {
    emit("I", "template arguments", "targs");
    d.targs!.forEach((a) => type(a, "targs"));
    emit("E", "end of template arguments", "targs");
  };
  if (!scope.length) {
    emit(sourceName(d.name), `name "${d.name}"`, "name");
    if (d.targs) { add(d.name, `${d.name} (template)`); targs(); }
  } else {
    emit("N", "nested name", "scope");
    if (d.constMethod) emit("K", "const member function", "const");
    prefix(scope, "scope", true);
    emit(sourceName(d.name), `name "${d.name}"`, "name");
    if (d.targs) { add([...scope, d.name].join("::"), `${[...scope, d.name].join("::")} (template)`); targs(); }
    emit("E", "end of nested name", "scope");
  }
  if (d.targs) type(d.ret ?? b("void"), "ret");
  if (!d.params.length) emit("v", "no parameters", "params");
  d.params.forEach((p, i) => type(p, `param ${i}`));
  return { name: pieces.map((p) => p.text).join(""), pieces, subs: subs.map(({ id, meaning }) => ({ id, meaning })) };
}

// ---------------------------------------------------------------- MSVC

const MSVC_BUILTIN: Record<Builtin, string> = {
  void: "X", bool: "_N", char: "D", int: "H", unsigned: "I", long: "J", "unsigned long": "K", "long long": "_J", float: "M", double: "N",
};

export function mangleMsvc(d: FnDecl): Mangled | undefined {
  if (d.externC) return { name: d.name, pieces: [{ text: d.name, what: 'extern "C": the plain name', part: "name" }], subs: [] };
  if (d.targs || d.params.some(hasTparam)) return undefined;
  const pieces: Piece[] = [];
  const names: string[] = [];
  const argTypes: string[] = [];
  const emit = (text: string, what: string, part: string, sub = false) => pieces.push({ text, what, part, sub });
  /** A name fragment, or its back-reference digit. */
  const frag = (s: string, part: string) => {
    const i = names.indexOf(s);
    if (i >= 0) { emit(String(i), `back-reference: ${s}`, part, true); return; }
    if (names.length < 10) names.push(s);
    emit(`${s}@`, `name "${s}"`, part);
  };
  /** A qualified class name: the class, then its scopes innermost first, then @. */
  const qname = (path: string[], part: string) => {
    for (let k = path.length - 1; k >= 0; k--) frag(path[k]!, part);
    emit("@", "end of the qualified name", part);
  };
  const typeText = (t: CType, part: string, top: boolean): void => {
    switch (t.k) {
      case "b": emit(MSVC_BUILTIN[t.name], t.name, part); return;
      case "class": emit("U", "struct", part); qname(t.path, part); return;
      case "const": typeText(t.of, part, top); return; // top-level const on a by-value parameter is dropped
      case "ptr": case "ref": case "rref": {
        const c = t.to.k === "const";
        emit(t.k === "ptr" ? "PE" : t.k === "ref" ? "AE" : "$$QE", `${t.k === "ptr" ? "pointer" : t.k === "ref" ? "reference" : "rvalue reference"} (64-bit)`, part);
        emit(c ? "B" : "A", c ? "to const" : "to non-const", part);
        typeText(c ? (t.to as { of: CType }).of : t.to, part, false);
        return;
      }
      case "tparam": return;
    }
  };
  /** A parameter type, with the back-reference rule for types longer than one letter. */
  const param = (t: CType, part: string) => {
    const k = cppType(t.k === "const" ? t.of : t);
    const i = argTypes.indexOf(k);
    if (i >= 0) { emit(String(i), `back-reference: parameter type ${k}`, part, true); return; }
    const mark = pieces.length;
    typeText(t, part, true);
    const text = pieces.slice(mark).map((p) => p.text).join("");
    if (text.length > 1 && argTypes.length < 10) argTypes.push(k);
  };
  emit("?", "C++ name", "start");
  frag(d.name, "name");
  const scope = [...d.ns, ...(d.cls ? [d.cls] : [])];
  for (let k = scope.length - 1; k >= 0; k--) frag(scope[k]!, "scope");
  emit("@", "end of the qualified name", "scope");
  if (d.cls) { emit("Q", "public member function", "kind"); emit("E", "this is a 64-bit pointer", "kind"); emit(d.constMethod ? "B" : "A", d.constMethod ? "this is const" : "this is not const", "const"); }
  else emit("Y", "free function", "kind");
  emit("A", "__cdecl", "kind");
  emit("X", "returns void", "ret");
  if (!d.params.length) emit("X", "no parameters", "params");
  d.params.forEach((p, i) => param(p, `param ${i}`));
  if (d.params.length) emit("@", "end of parameters", "params");
  emit("Z", "no exception specification", "end");
  return { name: pieces.map((p) => p.text).join(""), pieces, subs: names.map((n, i) => ({ id: String(i), meaning: n })) };
}

function hasTparam(t: CType): boolean {
  return t.k === "tparam" || ((t.k === "ptr" || t.k === "ref" || t.k === "rref") && hasTparam(t.to)) || (t.k === "const" && hasTparam(t.of));
}

// ---------------------------------------------------------------- presets for the demos

export const MANGLE_PRESETS: { id: string; label: string; decl: FnDecl }[] = [
  { id: "print-int", label: "print(int)", decl: { ns: [], name: "print", params: [b("int")] } },
  { id: "print-dbl", label: "print(double)", decl: { ns: [], name: "print", params: [b("double")] } },
  { id: "move", label: "geo::move", decl: { ns: ["geo"], name: "move", params: [refT(cls("geo", "Point")), refT(constT(cls("geo", "Point")))] } },
  { id: "norm", label: "Point::norm() const", decl: { ns: ["geo"], cls: "Point", name: "norm", params: [], constMethod: true } },
  { id: "area", label: "geo::detail::area", decl: { ns: ["geo", "detail"], name: "area", params: [ptrT(constT(cls("geo", "Point"))), ptrT(constT(cls("geo", "Point"))), b("unsigned long")] } },
  { id: "max", label: "max_of<int>", decl: { ns: [], name: "max_of", params: [tp(0), tp(0)], targs: [b("int")], ret: tp(0) } },
  { id: "c", label: 'extern "C" print', decl: { ns: [], name: "c_print", params: [b("int")], externC: true } },
];
