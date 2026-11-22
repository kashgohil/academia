/**
 * Rust coherence for one impl: the orphan rule, then the overlap check against impls in std.
 *
 * The orphan rule follows the Rust Reference ("Implementations", "Orphan rules", from RFC 2451): given
 * `impl<P1..=Pn> Trait<T1..=Tn> for T0`, the impl is allowed if Trait is local, or if at least one of
 * T0..=Tn is a local type, and no uncovered type parameter appears before the first local type.
 * `&`, `&mut`, `Box` and `Pin` are fundamental: `Box<Local>` counts as local, and `Box<T>` does not cover T.
 *
 * `RUSTC_TABLE` is what rustc 1.96.1 says for each cell, measured by compiling each impl alone in a crate
 * that defines `struct Meters(f64)` and `trait Describe`. The test checks the model against it.
 */

export interface TyArg { text: string; local: boolean; param: boolean; fundamental?: TyArg; covered?: boolean }
export interface TraitChoice { id: string; text: string; local: boolean; /** The type argument T1, if any. */ arg?: TyArg }
export interface TypeChoice { id: string; text: string; ty: TyArg }

const meters: TyArg = { text: "Meters", local: true, param: false };
const tParam: TyArg = { text: "T", local: false, param: true };

export const TRAITS: TraitChoice[] = [
  { id: "Describe", text: "Describe", local: true },
  { id: "Display", text: "fmt::Display", local: false },
  { id: "Neg", text: "ops::Neg", local: false },
  { id: "From", text: "From<Meters>", local: false, arg: meters },
];

export const TYPES: TypeChoice[] = [
  { id: "Meters", text: "Meters", ty: meters },
  { id: "f64", text: "f64", ty: { text: "f64", local: false, param: false } },
  { id: "VecU8", text: "Vec<u8>", ty: { text: "Vec<u8>", local: false, param: false } },
  { id: "VecM", text: "Vec<Meters>", ty: { text: "Vec<Meters>", local: false, param: false } },
  { id: "BoxM", text: "Box<Meters>", ty: { text: "Box<Meters>", local: false, param: false, fundamental: meters } },
  { id: "RefM", text: "&Meters", ty: { text: "&Meters", local: false, param: false, fundamental: meters } },
  { id: "T", text: "T (any type)", ty: tParam },
];

/** Blanket impls in std that can overlap with one of the cells. */
export const STD_IMPLS = [
  { trait: "From", forType: "T", text: "impl<T> From<T> for T", matches: (ty: string) => ty === "Meters" },
  { trait: "From", forType: "Box<T>", text: "impl<T> From<T> for Box<T>", matches: (ty: string) => ty === "Box<Meters>" },
];

export type Verdict = { ok: true; rule: string } | { ok: false; code: "E0117" | "E0210" | "E0119"; rule: string };

const isLocal = (t: TyArg) => t.local || (t.fundamental?.local ?? false);
const uncovered = (t: TyArg) => t.param || (t.fundamental?.param ?? false);

export function checkImpl(traitId: string, typeId: string): Verdict {
  const tr = TRAITS.find((t) => t.id === traitId)!;
  const ty = TYPES.find((t) => t.id === typeId)!;
  const head = `impl ${tr.text} for ${ty.text}`;
  let rule: string;
  if (tr.local) {
    rule = `The trait is local, so ${head} is allowed for any type.`;
  } else {
    const ts = [ty.ty, ...(tr.arg ? [tr.arg] : [])];
    const first = ts.findIndex(isLocal);
    if (first < 0) {
      if (ts.some(uncovered)) return { ok: false, code: "E0210", rule: "The trait is foreign, and the bare type parameter T could be any type, also another crate's type." };
      return { ok: false, code: "E0117", rule: "The trait and every type in the impl are foreign. Only the crate of the trait or of the type may write this impl." };
    }
    if (ts.slice(0, first).some(uncovered)) {
      return { ok: false, code: "E0210", rule: `The first local type is ${first === 0 ? "T0" : `T${first}`} (${ts[first]!.text}), but the uncovered parameter T comes before it.` };
    }
    const which = first === 0 ? "the Self type" : `type argument T${first}`;
    rule = `The trait is foreign, but ${which} is local (${ts[first]!.text}${ts[first]!.fundamental ? ": a fundamental wrapper of a local type" : ""}).`;
  }
  const clash = STD_IMPLS.find((s) => s.trait === tr.id && s.matches(ty.ty.text));
  if (clash) return { ok: false, code: "E0119", rule: `The orphan rule allows it, but std already has ${clash.text}, which covers this type. Two impls would overlap.` };
  return { ok: true, rule };
}

/** rustc 1.96.1 (edition 2024), one impl per crate: "OK" or the error code. */
export const RUSTC_TABLE: Record<string, Record<string, string>> = {
  Describe: { Meters: "OK", f64: "OK", VecU8: "OK", VecM: "OK", BoxM: "OK", RefM: "OK", T: "OK" },
  Display: { Meters: "OK", f64: "E0117", VecU8: "E0117", VecM: "E0117", BoxM: "OK", RefM: "OK", T: "E0210" },
  Neg: { Meters: "OK", f64: "E0117", VecU8: "E0117", VecM: "E0117", BoxM: "OK", RefM: "OK", T: "E0210" },
  From: { Meters: "E0119", f64: "OK", VecU8: "OK", VecM: "OK", BoxM: "E0119", RefM: "OK", T: "E0210" },
};

/** The first line of rustc's message for each code, as rustc 1.96.1 prints it for these impls. */
export const RUSTC_MESSAGES: Record<string, string> = {
  E0117: "only traits defined in the current crate can be implemented for types defined outside of the crate",
  E0117prim: "only traits defined in the current crate can be implemented for primitive types",
  E0210: "type parameter `T` must be used as the type parameter for some local type (e.g., `MyStruct<T>`)",
  E0210covered: "type parameter `T` must be covered by another type when it appears before the first local type (`Meters`)",
  E0119: "conflicting implementations of trait",
};

export function rustcMessage(traitId: string, typeId: string): string | null {
  const code = RUSTC_TABLE[traitId]![typeId]!;
  if (code === "OK") return null;
  if (code === "E0117") return `error[E0117]: ${typeId === "f64" ? RUSTC_MESSAGES.E0117prim : RUSTC_MESSAGES.E0117}`;
  if (code === "E0210") return `error[E0210]: ${traitId === "From" ? RUSTC_MESSAGES.E0210covered : RUSTC_MESSAGES.E0210}`;
  const tr = traitId === "From" ? "From<Meters>" : traitId;
  return `error[E0119]: conflicting implementations of trait \`${tr}\` for type \`${TYPES.find((t) => t.id === typeId)!.text}\``;
}
