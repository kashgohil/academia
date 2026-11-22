/** Demos for "Name mangling": build a declaration and watch both manglers, then demangle a real symbol step by step. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, MiniTable, Param, SectionLabel, StepButtons, StepCaption, StepSlider, mono, seg, select, tint, toggle, useStepper } from "../../kit";
import {
  MANGLE_PRESETS, b, cls, constT, cppDecl, cppType, demangle, mangleItanium, mangleMsvc, ptrT, refT, tp, type CType, type FnDecl, type Mangled,
} from "../../sims/sys/abi";

const POINT = cls("geo", "Point");
const PALETTE: { label: string; t: CType; tmpl?: boolean }[] = [
  { label: "int", t: b("int") },
  { label: "double", t: b("double") },
  { label: "char", t: b("char") },
  { label: "unsigned long", t: b("unsigned long") },
  { label: "const char *", t: ptrT(constT(b("char"))) },
  { label: "geo::Point &", t: refT(POINT) },
  { label: "const geo::Point &", t: refT(constT(POINT)) },
  { label: "const geo::Point *", t: ptrT(constT(POINT)) },
  { label: "T", t: tp(0), tmpl: true },
  { label: "const T &", t: refT(constT(tp(0))), tmpl: true },
  { label: "T *", t: ptrT(tp(0)), tmpl: true },
];

const PART_COLOR = (part: string) => {
  if (part.startsWith("param")) return ["var(--c1)", "var(--c3)", "var(--c5)", "var(--c2)"][Number(part.split(" ")[1]) % 4]!;
  return ({ scope: "var(--muted)", name: "var(--fg)", const: "var(--c4)", targs: "var(--c2)", ret: "var(--c5)", kind: "var(--muted)", start: "var(--faint)", params: "var(--faint)", end: "var(--faint)" } as Record<string, string>)[part] ?? "var(--muted)";
};

/** A mangled name as colored pieces; substitutions and back-references are underlined. */
function Pieces({ m }: { m: Mangled }) {
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px" }}>
      <div style={{ ...mono, fontSize: 15, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
        {m.pieces.map((p, i) => {
          const col = PART_COLOR(p.part);
          return <span key={i} title={p.what} style={{ color: col === "var(--fg)" ? "var(--fg)" : col, fontWeight: p.part === "name" ? 700 : 500, textDecoration: p.sub ? "underline" : undefined, textUnderlineOffset: 3, background: p.sub ? tint("var(--c2)", 18) : undefined, borderRadius: 2 }}>{p.text}</span>;
        })}
      </div>
    </div>
  );
}

const nsSpec = seg("Namespace", [["none", "global"], ["geo", "geo"], ["detail", "geo::detail"]], "geo");
const presetSpec = select({ label: "Start from", options: MANGLE_PRESETS.map((p) => ({ value: p.id, label: p.label })), default: "move" });
const nameSpec = seg("Name", [["move", "move"], ["print", "print"], ["area", "area"]], "move");
const memberSpec = toggle({ label: "Member of geo::Point", default: false });
const constSpec = toggle({ label: "const member function", default: false });
const tmplSpec = seg("Template", [["none", "no"], ["int", "T = int"], ["double", "T = double"], ["point", "T = geo::Point"]], "none");
const externSpec = toggle({ label: 'extern "C"', default: false });

export function AbiManglerDemo() {
  const [d, setD] = useState<FnDecl>(MANGLE_PRESETS.find((p) => p.id === "move")!.decl);
  const [preset, setPreset] = useState("move");
  const tmpl = d.targs ? (d.targs[0]!.k === "class" ? "point" : (d.targs[0] as { name: string }).name) : "none";
  const set = (patch: Partial<FnDecl>) => setD({ ...d, ...patch });
  const it = useMemo(() => mangleItanium(d), [d]);
  const ms = useMemo(() => mangleMsvc(d), [d]);
  const back = useMemo(() => demangle(it.name), [it]);
  const nsVal = d.cls ? (d.ns.length === 1 ? "geo" : "none") : d.ns.length === 0 ? "none" : d.ns.length === 1 ? "geo" : "detail";
  const setNs = (v: string) => set({ ns: v === "none" ? [] : v === "geo" ? ["geo"] : ["geo", "detail"], cls: undefined, constMethod: false });
  const setTmpl = (v: string) => {
    if (v === "none") set({ targs: undefined, ret: undefined, params: d.params.filter((p) => !hasT(p)) });
    else set({ targs: [v === "point" ? POINT : b(v as "int" | "double")], ret: d.ret ?? tp(0), cls: undefined, constMethod: false, externC: false });
  };
  return (
    <Demo
      title="Be the C++ compiler: mangle a declaration"
      controls={<>
        <Param spec={presetSpec} value={preset} onChange={(v) => { setPreset(v as string); setD(MANGLE_PRESETS.find((p) => p.id === v)!.decl); }} />
        <Param spec={nameSpec} value={["move", "print", "area"].includes(d.name) ? d.name : "move"} onChange={(v) => set({ name: v as string })} />
        <Param spec={nsSpec} value={nsVal} onChange={(v) => setNs(v as string)} />
        <Param spec={memberSpec} value={!!d.cls} onChange={(v) => set(v ? { cls: "Point", ns: ["geo"], targs: undefined, ret: undefined, params: d.params.filter((p) => !hasT(p)), externC: false } : { cls: undefined, constMethod: false })} />
        {d.cls && <Param spec={constSpec} value={!!d.constMethod} onChange={(v) => set({ constMethod: v as boolean })} />}
        <Param spec={tmplSpec} value={tmpl} onChange={(v) => setTmpl(v as string)} />
        <Param spec={externSpec} value={!!d.externC} onChange={(v) => set({ externC: v as boolean, ...(v ? { targs: undefined, ret: undefined, cls: undefined, constMethod: false, params: d.params.filter((p) => !hasT(p)) } : {}) })} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>Parameters (click one to remove it)</SectionLabel>
      <ButtonRow>
        {d.params.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>none</span>}
        {d.params.map((p, i) => (
          <button key={i} className="btn" onClick={() => set({ params: d.params.filter((_, j) => j !== i) })} style={{ ...mono, fontSize: 12, boxShadow: `inset 0 -3px 0 ${PART_COLOR(`param ${i}`)}` }}>
            {cppType(p)} ×
          </button>
        ))}
      </ButtonRow>
      <ButtonRow style={{ marginTop: 6 }}>
        {PALETTE.filter((p) => !p.tmpl || d.targs).map((p) => <Btn key={p.label} ghost disabled={d.params.length >= 5} onClick={() => set({ params: [...d.params, p.t] })}>+ {p.label}</Btn>)}
      </ButtonRow>
      <div style={{ ...mono, fontSize: 12.5, margin: "10px 0", overflowX: "auto", whiteSpace: "nowrap" }}>{cppDecl(d)}{d.targs ? `   // used as T = ${cppType(d.targs[0]!)}` : ""}</div>
      <SectionLabel>Itanium C++ ABI (Linux, macOS, BSD; GCC and Clang)</SectionLabel>
      <Pieces m={it} />
      <SectionLabel>MSVC (Windows)</SectionLabel>
      {ms ? <Pieces m={ms} /> : <div className="muted" style={{ fontSize: 12.5 }}>This demo does not mangle templates in the MSVC scheme.</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 8 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>Itanium pieces</SectionLabel>
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            <MiniTable head={["text", "means"]} rows={it.pieces.map((p) => [<span key="t" style={{ ...mono, color: PART_COLOR(p.part) }}>{p.text}</span>, <span key="w" style={{ textAlign: "left", display: "inline-block" }}>{p.what}</span>])} />
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>Itanium substitution table</SectionLabel>
          {it.subs.length ? <MiniTable head={["id", "stands for"]} rows={it.subs.map((x) => [<span key="i" style={mono}>{x.id}</span>, <span key="m" style={mono}>{x.meaning}</span>])} /> : <div className="muted" style={{ fontSize: 12.5 }}>Empty: nothing can be reused.</div>}
        </div>
      </div>
      <Banner tone={d.externC ? "warn" : "good"} label="c++filt">
        {d.externC
          ? <>No mangling: the symbol is <b style={mono}>{d.name}</b>. Two extern "C" functions with this name, in any namespace or with any parameters, collide at link time.</>
          : <><span style={mono}>{back.out}</span>. The parameter types are in the name, so the overloads <span style={mono}>print(int)</span> and <span style={mono}>print(double)</span> get different symbols. The return type is in it only for a template.</>}
      </Banner>
    </Demo>
  );
}

function hasT(t: CType): boolean {
  return t.k === "tparam" || ((t.k === "ptr" || t.k === "ref" || t.k === "rref") && hasT(t.to)) || (t.k === "const" && hasT(t.of));
}

/** Real symbols: clang 21 (zig c++ 0.17.1, x86_64-linux-gnu, libc++) compiled them; c++filt agrees with each output. */
export const REAL_SYMBOLS = [
  "_ZN3geo4moveERNS_5PointERKS0_",
  "_ZN3geo6detail4areaEPKNS_5PointES3_m",
  "_ZNK3geo5PointeqERKS0_",
  "_Z6max_ofIiET_S0_S0_",
  "_Z7pair_upIcN3geo5PointEEvPT_RT0_RKS2_",
  "_ZN3geo5PointC1Edd",
  "_Z5printPPcPPKcRiOi",
  "_Z2cbPFviPvES_",
  "_Z3arrPA4_i",
  "_Z3sumRNSt3__16vectorIiNS_9allocatorIiEEEE",
  "_Z3lenRKNSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEE",
];
const symSpec = select({ label: "Symbol", options: REAL_SYMBOLS.map((s) => ({ value: s, label: s.length > 34 ? s.slice(0, 32) + "…" : s })), default: REAL_SYMBOLS[0]! });

export function AbiDemangleDemo() {
  const [sym, setSym] = useState(REAL_SYMBOLS[0]!);
  const r = useMemo(() => demangle(sym), [sym]);
  const s = useStepper(r.steps.length, 1.5);
  const cur = r.steps[s.i];
  const done = s.atEnd;
  return (
    <Demo
      title="Demangle a real symbol, one piece at a time"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={symSpec} value={sym} onChange={(v) => { setSym(v as string); s.reset(); }} />
      </>}
    >
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px" }}>
        <div style={{ ...mono, fontSize: 15, whiteSpace: "nowrap" }}>
          {cur && <>
            <span className="muted">{sym.slice(0, cur.from)}</span>
            <b style={{ background: tint("var(--c1)", 30), color: "var(--fg)", borderRadius: 3, padding: "0 1px" }}>{sym.slice(cur.from, cur.to)}</b>
            <span>{sym.slice(cur.to)}</span>
          </>}
        </div>
      </div>
      <StepCaption label={`step ${s.i + 1} of ${r.steps.length}`} tone={cur?.added ? "info" : null}>
        {cur?.text}{cur?.added ? <> New substitution: <b style={mono}>{cur.added}</b>.</> : null}
      </StepCaption>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 6 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>Substitution table so far</SectionLabel>
          {cur && cur.subs.length ? (
            <div style={{ ...mono, fontSize: 12, lineHeight: 1.6, maxHeight: 200, overflowY: "auto" }}>
              {cur.subs.map((x, i) => <div key={i} style={{ whiteSpace: "nowrap", fontWeight: i === cur.subs.length - 1 && cur.added ? 700 : 400 }}>{x}</div>)}
            </div>
          ) : <div className="muted" style={{ fontSize: 12.5 }}>Empty.</div>}
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>Result</SectionLabel>
          <div style={{ ...mono, fontSize: 12.5, overflowWrap: "anywhere", color: done ? "var(--fg)" : "var(--faint)" }}>{done ? r.out : "Step to the end to see the whole name."}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{sym.length} characters mangled; {r.out.length} characters as C++.</div>
        </div>
      </div>
    </Demo>
  );
}
