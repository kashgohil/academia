/** Lesson: object files and ELF. A real .o file byte by byte, and --gc-sections on three real objects. */
import { useMemo, useState } from "react";
import { Banner, Demo, IndexButtons, IndexSlider, Legend, Note, Param, SectionLabel, SmallLabel, Stats, StackBar, mono, seg, tint, toggle } from "../../kit";
import { SRC_APP, SRC_EXTRA, SRC_MAIN, SRC_UTIL, golden, gcInputs, link, relocName, sectionLabel, secKey, shndxName, type ByteField, type FieldGroup, type ObjFile } from "../../sims/sys/linking";
import { CodeBox, HexView, PickRow, hx } from "./SysLinkUi";

const GROUP_COLOR: Record<FieldGroup, string> = {
  ehdr: "var(--c1)", shdr: "var(--c5)", code: "var(--c4)", data: "var(--c3)", rela: "var(--c2)", symtab: "var(--c1)", strtab: "var(--c5)", pad: "var(--faint)",
};
const LEGEND = [
  { label: "ELF header, symbols", color: "var(--c1)" }, { label: ".text", color: "var(--c4)" }, { label: ".data", color: "var(--c3)" },
  { label: "relocations", color: "var(--c2)" }, { label: "section headers, names", color: "var(--c5)" },
];

type Pick = { kind: "field"; f: ByteField } | { kind: "section" | "symbol" | "reloc"; i: number } | null;
type Tab = "sections" | "symbols" | "relocs" | "source";

export function ObjBytesDemo() {
  const [pie, setPie] = useState(false);
  const [tab, setTab] = useState<Tab>("relocs");
  const [pick, setPick] = useState<Pick>({ kind: "reloc", i: 4 });
  const o: ObjFile = golden(pie ? "main-pie.o" : "main.o");
  const fieldOf = useMemo(() => {
    const a: (ByteField | undefined)[] = [];
    for (const f of o.fields) for (let k = 0; k < f.size; k++) a[f.offset + k] = f;
    return a;
  }, [o]);
  const inPick = (f: ByteField | undefined): boolean => {
    if (!f || !pick) return false;
    if (pick.kind === "field") return f === pick.f;
    if (pick.kind === "reloc") return f.reloc === pick.i;
    if (pick.kind === "symbol") return f.symbol === pick.i && f.group === "symtab";
    const s = o.sections[pick.i]!;
    return f.section === pick.i && (f.group === "shdr" || (f.offset >= s.offset && f.offset < s.offset + s.size));
  };
  const firstPicked = pick ? o.fields.find((f) => inPick(f) && f.group !== "shdr")?.offset ?? o.fields.find((f) => inPick(f))?.offset ?? null : null;
  const shown: ByteField | null = pick?.kind === "field" ? pick.f : pick ? (o.fields.find((f) => inPick(f) && (f.group === "code" || f.group === "data")) ?? o.fields.find((f) => inPick(f) && f.group !== "shdr") ?? null) : null;
  const text = o.sections.find((s) => s.name === ".text")!;
  const choose = (p: Pick) => setPick(p);
  return (
    <Demo title={`${o.name}: ${o.bytes.length} bytes from clang`}>
      <Stats items={[
        { label: "sections", value: o.sections.length },
        { label: "symbols", value: o.symbols.length },
        { label: "relocations", value: o.relocs.length },
        { label: ".text bytes that are holes", value: `${o.relocs.filter((r) => r.target === text.index).length * 4} of ${text.size}` },
      ]} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
        <div style={{ flex: "1 1 330px", minWidth: 0 }}>
          <SmallLabel>The file. Click a byte.</SmallLabel>
          <HexView
            bytes={o.bytes}
            color={(x) => { const f = fieldOf[x]; return f && f.group !== "pad" ? GROUP_COLOR[f.group] : null; }}
            strong={(x) => inPick(fieldOf[x])}
            onPick={(x) => { const f = fieldOf[x]; if (f) choose({ kind: "field", f }); }}
            focus={firstPicked}
            height={204}
          />
          <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "6px 8px", marginTop: 6, minHeight: 84 }}>
            {shown ? (
              <>
                <div style={{ ...mono, fontSize: 12, fontWeight: 600, overflowWrap: "anywhere" }}>{shown.name}</div>
                <div className="muted" style={{ ...mono, fontSize: 11.5 }}>offset {hx(shown.offset)}, {shown.size} B, {shown.value}</div>
                <p style={{ fontSize: 12.5, margin: "3px 0 0" }}>{shown.explain}</p>
              </>
            ) : <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Click a byte or a row.</p>}
          </div>
        </div>
        <div style={{ flex: "1 1 250px", minWidth: 0 }}>
          <div className="seg" style={{ marginBottom: 6 }}>
            {(["relocs", "symbols", "sections", "source"] as Tab[]).map((t) => (
              <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>{{ relocs: "Relocs", symbols: "Symbols", sections: "Sections", source: "Source" }[t]}</button>
            ))}
          </div>
          <div style={{ maxHeight: 290, overflow: "auto", border: "1px solid var(--border)", borderRadius: 4, padding: 3 }}>
            {tab === "source" && <CodeBox style={{ border: "none" }}>{SRC_MAIN}</CodeBox>}
            {tab === "sections" && o.sections.map((s) => s.index > 0 && (
              <PickRow key={s.index} on={pick?.kind === "section" && pick.i === s.index} onClick={() => choose({ kind: "section", i: s.index })} color="var(--c5)">
                [{s.index}] {s.name.padEnd(16)} {String(s.size).padStart(4)} B
              </PickRow>
            ))}
            {tab === "symbols" && o.symbols.map((s) => s.index > 0 && (
              <PickRow key={s.index} on={pick?.kind === "symbol" && pick.i === s.index} onClick={() => choose({ kind: "symbol", i: s.index })} color={s.shndx === 0 ? "var(--c4)" : "var(--c1)"}>
                {s.name.padEnd(8)} {s.bind.padEnd(6)} {s.type.padEnd(7)} {shndxName(o, s.shndx)}
              </PickRow>
            ))}
            {tab === "relocs" && o.relocs.map((r, i) => (
              <PickRow key={i} on={pick?.kind === "reloc" && pick.i === i} onClick={() => choose({ kind: "reloc", i })} color="var(--c2)">
                {o.sections[r.target]!.name}+{hx(r.offset)} {relocName(r.type).replace("R_X86_64_", "")} {o.symbols[r.sym]!.name}{r.addend < 0 ? r.addend : `+${r.addend}`}
              </PickRow>
            ))}
          </div>
          <Note>{tab === "symbols" ? "UND means: used here, defined in another file." : tab === "relocs" ? "Each row patches one hole: section+offset, type, symbol and addend." : tab === "sections" ? "No section has an address yet. All of them start at 0." : "The source of this object."}</Note>
        </div>
      </div>
      <Legend box items={LEGEND} />
      <div style={{ marginTop: 10 }}>
        <Param spec={seg("Compiled with", [["nopic", "-fno-pic"], ["pie", "-fPIE"]], "nopic")} value={pie ? "pie" : "nopic"} onChange={(v) => { setPie(v === "pie"); setPick(null); }} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- --gc-sections

const FILE_SRC = [SRC_APP, SRC_UTIL, SRC_EXTRA];
const OUT_COLOR: Record<string, string> = { ".text": "var(--c4)", ".rodata": "var(--c5)", ".bss": "var(--c3)", ".data": "var(--c3)" };

export function GcSectionsDemo() {
  const [split, setSplit] = useState(false);
  const [gc, setGc] = useState(true);
  const objs = useMemo(() => gcInputs(split), [split]);
  const full = useMemo(() => link(objs), [objs]);
  const run = useMemo(() => link(objs, { gcSections: gc }), [objs, gc]);
  const steps = run.gc ?? [];
  const [k, setK] = useState(99);
  const step = gc ? Math.min(k, steps.length) : 0;
  const live = new Set(steps.slice(0, step).map((s) => secKey(s.section)));
  const done = !gc || step >= steps.length;
  const size = (r: typeof run, n: string) => r.sections.find((s) => s.name === n)?.size ?? 0;
  const total = (r: typeof run) => size(r, ".text") + size(r, ".rodata") + size(r, ".bss");
  const [showSrc, setShowSrc] = useState(false);
  return (
    <Demo
      title="Be the linker's garbage collector"
      actions={gc ? <IndexButtons k={step} n={steps.length + 1} set={setK} /> : undefined}
      controls={<>
        <Param spec={toggle({ label: "-ffunction-sections -fdata-sections", default: false })} value={split} onChange={(v) => { setSplit(v as boolean); setK(99); }} />
        <Param spec={toggle({ label: "--gc-sections", default: true })} value={gc} onChange={(v) => { setGc(v as boolean); setK(99); }} />
        {gc && <IndexSlider k={step} n={steps.length + 1} set={setK} label="Mark step" />}
      </>}
    >
      <Stats items={[
        { label: ".text bytes", value: done ? `${size(run, ".text")} of ${size(full, ".text")}` : "…" },
        { label: ".rodata bytes", value: done ? `${size(run, ".rodata")} of ${size(full, ".rodata")}` : "…" },
        { label: ".bss bytes", value: done ? `${size(run, ".bss")} of ${size(full, ".bss")}` : "…" },
        { label: "Input sections kept", value: done ? `${run.kept.size}` : `${live.size} so far` },
      ]} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 8, marginTop: 6 }}>
        {objs.map((o, fi) => (
          <div key={o.name} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 6, minWidth: 0 }}>
            <div style={{ ...mono, fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{o.name}</div>
            {o.sections.map((s) => {
              const out = s.name.match(/^\.(text|rodata|data|bss)/)?.[0];
              if (!out || s.size === 0) return null;
              const key = secKey({ file: fi, section: s.index });
              const isLive = gc ? live.has(key) : true;
              const dead = done && !isLive;
              const c = OUT_COLOR[out] ?? "var(--fg)";
              const syms = o.symbols.filter((y) => y.shndx === s.index && (y.type === "FUNC" || y.type === "OBJECT")).map((y) => y.name);
              const refs = [...new Set(o.relocs.filter((r) => r.target === s.index).map((r) => o.symbols[r.sym]!.name))];
              const justNow = gc && step > 0 && secKey(steps[step - 1]!.section) === key;
              return (
                <div key={s.index} style={{ border: `1.5px ${dead ? "dashed" : "solid"} ${dead ? "var(--border)" : c}`, background: isLive && !dead ? tint(c, justNow ? 34 : 14) : undefined, opacity: dead ? 0.45 : 1, borderRadius: 4, padding: "3px 6px", marginBottom: 4, transition: "background 0.2s" }}>
                  <div style={{ ...mono, fontSize: 11.5, display: "flex", justifyContent: "space-between", gap: 6 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: dead ? "line-through" : undefined }}>{s.name}</span>
                    <span className="muted">{s.size} B</span>
                  </div>
                  {syms.length > 0 && <div style={{ fontSize: 11.5 }}>{syms.join(", ")}</div>}
                  {refs.length > 0 && <div className="muted" style={{ ...mono, fontSize: 10.5 }}>→ {refs.join(", ")}</div>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {gc && (
        <Banner tone={done ? "good" : "info"} label={`step ${step} of ${steps.length}`}>
          {step === 0 ? "Nothing is marked yet. The mark starts at the section that holds the entry symbol, main." : done
            ? `Done. ${run.kept.size} input sections are live. The linker drops every other section and its bytes.`
            : `Mark ${sectionLabel(objs, steps[step - 1]!.section)}: ${steps[step - 1]!.reason}.`}
        </Banner>
      )}
      <SectionLabel>Output size (.text + .rodata + .bss)</SectionLabel>
      <StackBar total={total(full)} parts={[
        { value: size(run, ".text"), color: "var(--c4)", label: ".text" },
        { value: size(run, ".rodata"), color: "var(--c5)", label: ".rodata" },
        { value: done ? size(run, ".bss") : 0, color: "var(--c3)", label: ".bss" },
      ]} />
      <div className="muted" style={{ fontSize: 12, marginTop: 3, ...mono }}>{done ? total(run) : "…"} of {total(full)} bytes, from ld.lld's rules</div>
      <button className="btn ghost" style={{ marginTop: 6 }} onClick={() => setShowSrc((x) => !x)}>{showSrc ? "Hide" : "Show"} the C source</button>
      {showSrc && <div style={{ display: "grid", gap: 6, marginTop: 6 }}>{FILE_SRC.map((s, i) => <CodeBox key={i}>{`// ${["app.c", "util.c", "extra.c"][i]}\n${s}`}</CodeBox>)}</div>}
    </Demo>
  );
}
