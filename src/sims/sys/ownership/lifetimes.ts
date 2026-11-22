/**
 * Lifetime elision for function signatures, as the Rust Reference states it ("Lifetime elision", "Lifetime elision in
 * functions"):
 * 1. Each elided lifetime in the parameters becomes a distinct lifetime parameter.
 * 2. If there is exactly one lifetime used in the parameters (elided or not), that lifetime is assigned to all elided
 *    output lifetimes.
 * 3. If the receiver has type &Self or &mut Self, then the lifetime of that reference to Self is assigned to all
 *    elided output lifetime parameters.
 * Otherwise it is an error to elide an output lifetime: rustc reports E0106 "missing lifetime specifier".
 *
 * `parseSig` reads a one-line signature such as `fn longest<'a>(x: &'a str, y: &'a str) -> &'a str`. Types are
 * references (`&'a mut T`), paths with generic arguments (`Vec<&str>`, `Parser<'a>`), slices (`[u8]`) and tuples.
 * `elide` applies the rules step by step and writes the signature with every lifetime named, as rustc sees it.
 * Each example in ELISION_EXAMPLES was checked with rustc 1.96.1; the recorded result is in `rustc`.
 *
 * Not modelled: `impl Trait` and `dyn Trait` (their own default rules), lifetimes hidden in a path without `<'_>`
 * (allowed, but the `elided_lifetimes_in_paths` lint can flag them), closures, and `async fn`.
 */

export type TyNode =
  | { k: "ref"; lt?: string; mut: boolean; to: TyNode }
  | { k: "path"; name: string; args: (TyNode | { k: "lt"; lt: string })[] }
  | { k: "slice"; of: TyNode }
  | { k: "tuple"; items: TyNode[] };

export interface FnSig {
  name: string;
  lifetimes: string[];
  /** `self`, `&self`, `&'a self`, `&mut self`. */
  self?: { ref: boolean; mut: boolean; lt?: string };
  params: { name: string; ty: TyNode }[];
  ret?: TyNode;
}

export class SigError extends Error {}

/** Parses `fn name<'a>(x: &'a str) -> &'a str` (an optional `;` at the end). */
export function parseSig(text: string): FnSig {
  const toks = text.replace(/\/\/.*$/, "").match(/'[A-Za-z_][A-Za-z0-9_]*|->|::|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[&<>(),:;[\]*]/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const eat = (t: string) => (toks[i] === t ? (i++, true) : false);
  const want = (t: string) => { if (!eat(t)) throw new SigError(`expected \`${t}\`${peek() ? ` before \`${peek()}\`` : " at the end"}`); };
  const isLt = (t?: string) => !!t && t.startsWith("'");
  const ident = (what: string) => {
    const t = peek();
    if (!t || !/^[A-Za-z_]/.test(t)) throw new SigError(`expected ${what}`);
    i++;
    return t;
  };
  const type = (): TyNode => {
    if (eat("&")) {
      const lt = isLt(peek()) ? toks[i++] : undefined;
      const mut = eat("mut");
      return { k: "ref", lt, mut, to: type() };
    }
    if (eat("[")) { const of = type(); want("]"); return { k: "slice", of }; }
    if (eat("(")) {
      const items: TyNode[] = [];
      if (!eat(")")) { do items.push(type()); while (eat(",")); want(")"); }
      return { k: "tuple", items };
    }
    let name = ident("a type");
    while (eat("::")) name += "::" + ident("a type");
    const args: (TyNode | { k: "lt"; lt: string })[] = [];
    if (eat("<")) {
      do args.push(isLt(peek()) ? { k: "lt", lt: toks[i++]! } : type()); while (eat(","));
      want(">");
    }
    return { k: "path", name, args };
  };
  want("fn");
  const name = ident("a function name");
  const lifetimes: string[] = [];
  if (eat("<")) {
    do { const t = peek(); if (!isLt(t)) throw new SigError("expected a lifetime parameter such as 'a"); lifetimes.push(t!); i++; } while (eat(","));
    want(">");
  }
  want("(");
  const sig: FnSig = { name, lifetimes, params: [] };
  if (!eat(")")) {
    do {
      // self, &self, &'a self, &mut self
      const save = i;
      if (eat("&")) {
        const lt = isLt(peek()) ? toks[i++] : undefined;
        const mut = eat("mut");
        if (eat("self")) { if (sig.params.length) throw new SigError("self must be the first parameter"); sig.self = { ref: true, mut, lt }; continue; }
        i = save;
      } else if (eat("self")) { sig.self = { ref: false, mut: false }; continue; }
      const pn = ident("a parameter name");
      want(":");
      sig.params.push({ name: pn, ty: type() });
    } while (eat(","));
    want(")");
  }
  if (eat("->")) sig.ret = type();
  eat(";");
  if (i < toks.length) throw new SigError(`unexpected \`${toks[i]}\``);
  return sig;
}

/** Every reference and lifetime argument in a type, in order: the places where a lifetime goes. */
function slots(t: TyNode, out: { node: { lt?: string }; kind: "ref" | "arg" }[] = []) {
  switch (t.k) {
    case "ref": out.push({ node: t, kind: "ref" }); slots(t.to, out); break;
    case "path": for (const a of t.args) { if (a.k === "lt") out.push({ node: a, kind: "arg" }); else slots(a, out); } break;
    case "slice": slots(t.of, out); break;
    case "tuple": for (const x of t.items) slots(x, out); break;
  }
  return out;
}
const elided = (lt?: string) => lt === undefined || lt === "'_";

export function tyText(t: TyNode): string {
  switch (t.k) {
    case "ref": return `&${t.lt ? t.lt + " " : ""}${t.mut ? "mut " : ""}${tyText(t.to)}`;
    case "path": return t.args.length ? `${t.name}<${t.args.map((a) => (a.k === "lt" ? a.lt : tyText(a))).join(", ")}>` : t.name;
    case "slice": return `[${tyText(t.of)}]`;
    case "tuple": return `(${t.items.map(tyText).join(", ")})`;
  }
}

export function sigText(s: FnSig): string {
  const ps = [
    ...(s.self ? [s.self.ref ? `&${s.self.lt ? s.self.lt + " " : ""}${s.self.mut ? "mut " : ""}self` : "self"] : []),
    ...s.params.map((p) => `${p.name}: ${tyText(p.ty)}`),
  ];
  return `fn ${s.name}${s.lifetimes.length ? `<${s.lifetimes.join(", ")}>` : ""}(${ps.join(", ")})${s.ret ? ` -> ${tyText(s.ret)}` : ""}`;
}

export interface ElisionStep { rule: 1 | 2 | 3 | 0; text: string }

export type Elided =
  | {
    ok: true;
    /** The signature with every lifetime named. */
    sig: FnSig;
    text: string;
    steps: ElisionStep[];
    /** The lifetime of each parameter's top-level reference, or undefined if the parameter is not a reference. */
    inputs: (string | undefined)[];
    /** The lifetime of the return type's top-level reference. */
    output?: string;
  }
  | { ok: false; code: "E0106" | "E0261"; message: string; label: string; help?: string; steps: ElisionStep[] };

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Applies the elision rules to a signature. */
export function elide(input: FnSig): Elided {
  const sig = clone(input);
  const steps: ElisionStep[] = [];
  // undeclared names
  const declared = new Set(sig.lifetimes);
  const all = [...(sig.self?.lt ? [{ node: sig.self, kind: "ref" as const }] : []), ...sig.params.flatMap((p) => slots(p.ty)), ...(sig.ret ? slots(sig.ret) : [])];
  for (const s of all) {
    const lt = s.node.lt;
    if (lt && !elided(lt) && lt !== "'static" && !declared.has(lt)) {
      return { ok: false, code: "E0261", message: `use of undeclared lifetime name \`${lt}\``, label: "undeclared lifetime", steps };
    }
  }
  // rule 1: each elided input lifetime becomes a fresh parameter
  const names = ["'a", "'b", "'c", "'d", "'e", "'f", "'g", "'h"].filter((n) => !declared.has(n));
  let next = 0;
  const fresh = () => names[next++] ?? `'l${next}`;
  const added: string[] = [];
  const inputLts: string[] = [];
  if (sig.self?.ref) {
    if (elided(sig.self.lt)) { sig.self.lt = fresh(); added.push(sig.self.lt); }
    inputLts.push(sig.self.lt!);
  }
  for (const p of sig.params) {
    for (const s of slots(p.ty)) {
      if (elided(s.node.lt)) { s.node.lt = fresh(); added.push(s.node.lt); }
      inputLts.push(s.node.lt!);
    }
  }
  sig.lifetimes = [...sig.lifetimes, ...added];
  steps.push({ rule: 1, text: added.length ? `Each elided input lifetime gets its own parameter: ${added.join(", ")}.` : "No input lifetime is elided." });
  const distinct = [...new Set(inputLts)];
  // the output
  const outSlots = sig.ret ? slots(sig.ret).filter((s) => elided(s.node.lt)) : [];
  if (!outSlots.length) {
    steps.push({ rule: 0, text: sig.ret && slots(sig.ret).length ? "The output names all of its lifetimes, so rules 2 and 3 have nothing to do." : "The output has no reference, so rules 2 and 3 have nothing to do." });
  } else if (sig.self?.ref) {
    for (const s of outSlots) s.node.lt = sig.self.lt;
    steps.push({ rule: 3, text: `The receiver is &self, so the output gets the lifetime of self: ${sig.self.lt}.` });
  } else if (distinct.length === 1) {
    for (const s of outSlots) s.node.lt = distinct[0];
    steps.push({ rule: 2, text: `Exactly one input lifetime (${distinct[0]}), so the output gets it.` });
  } else {
    const withRefs = input.params.filter((p) => slots(p.ty).length);
    const refParams = withRefs.map((p) => `\`${p.name}\``);
    const pre = "this function's return type contains a borrowed value, but ";
    const help = distinct.length === 0
      ? pre + "there is no value for it to be borrowed from"
      : withRefs.length === 1 && !input.self
        ? pre + `the signature does not say which one of \`${withRefs[0]!.name}\`'s ${distinct.length} lifetimes it is borrowed from`
        : pre + `the signature does not say whether it is borrowed from ${refParams.slice(0, -1).join(", ")} or ${refParams[refParams.length - 1]}`;
    steps.push({ rule: 0, text: distinct.length === 0 ? "No input lifetime and no &self: nothing can fill the output lifetime." : `${distinct.length} input lifetimes (${distinct.join(", ")}) and no &self: rules 2 and 3 do not apply.` });
    return { ok: false, code: "E0106", message: "missing lifetime specifier", label: "expected named lifetime parameter", help, steps };
  }
  const top = (t?: TyNode) => (t?.k === "ref" ? t.lt : undefined);
  return { ok: true, sig, text: sigText(sig), steps, inputs: sig.params.map((p) => top(p.ty)), output: top(sig.ret) };
}

export interface ElisionExample { id: string; src: string; method?: boolean; rustc: { ok: true; text?: string } | { ok: false; code: string; message: string } }

/**
 * Signatures for the elision demo. `method` ones were checked inside `impl S { ... }`. For the ones that compile,
 * `text` is the fully named signature that the rules give (the Reference's own examples use the same forms).
 */
export const ELISION_EXAMPLES: ElisionExample[] = [
  { id: "one", src: "fn first_word(s: &str) -> &str", rustc: { ok: true, text: "fn first_word<'a>(s: &'a str) -> &'a str" } },
  { id: "print", src: "fn print(s: &str)", rustc: { ok: true, text: "fn print<'a>(s: &'a str)" } },
  { id: "two", src: "fn longest(x: &str, y: &str) -> &str", rustc: { ok: false, code: "E0106", message: "missing lifetime specifier" } },
  { id: "named", src: "fn longest<'a>(x: &'a str, y: &'a str) -> &'a str", rustc: { ok: true, text: "fn longest<'a>(x: &'a str, y: &'a str) -> &'a str" } },
  { id: "mixed", src: "fn pick<'a>(x: &'a str, y: &str) -> &str", rustc: { ok: false, code: "E0106", message: "missing lifetime specifier" } },
  { id: "self", src: "fn get(&self, key: &str) -> &str", method: true, rustc: { ok: true, text: "fn get<'a, 'b>(&'a self, key: &'b str) -> &'a str" } },
  { id: "none", src: "fn make() -> &str", rustc: { ok: false, code: "E0106", message: "missing lifetime specifier" } },
  { id: "static", src: "fn make() -> &'static str", rustc: { ok: true, text: "fn make() -> &'static str" } },
  { id: "tuple", src: "fn split(s: &str, at: usize) -> (&str, &str)", rustc: { ok: true, text: "fn split<'a>(s: &'a str, at: usize) -> (&'a str, &'a str)" } },
  { id: "nested", src: "fn top(v: &Vec<&str>) -> &str", rustc: { ok: false, code: "E0106", message: "missing lifetime specifier" } },
  { id: "parser", src: "fn rest(p: Parser<'_>) -> &str", rustc: { ok: true, text: "fn rest<'a>(p: Parser<'a>) -> &'a str" } },
  { id: "undeclared", src: "fn first(x: &'a str) -> &'a str", rustc: { ok: false, code: "E0261", message: "use of undeclared lifetime name `'a`" } },
];
