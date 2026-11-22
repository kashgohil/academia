/** Demos for "Calling conventions" (Systems / ABI): pass a struct by value under five conventions, and follow a big struct through a call. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, MiniTable, Param, Panel, SectionLabel, Stats, StepButtons, StepCaption, StepSlider, mono, range, seg, select, useStepper } from "../../kit";
import {
  BIG_CONVS, CONVS, CONV_IDS, FIELD_KINDS, PRESETS, argText, bigSource, bigTrace, classify, classifyAll, fieldDecl, goType, retText,
  structSource, type BigConv, type BigField, type ConvId, type FieldKind,
} from "../../sims/sys/abi";
import { StackView, StructBytes, fieldColor } from "./SysViews";
import { AbiSource, RegList, isFpReg } from "./SysAbiUi";

const convSpec = seg<ConvId>("Convention", CONV_IDS.map((c) => [c, CONVS[c].short]), "sysv");
const presetSpec = select({ label: "Start from", options: PRESETS.map((p) => ({ value: p.id, label: p.label })), default: "v3" });
const MAX_FIELDS = 6;

export function AbiStructPassDemo() {
  const [kinds, setKinds] = useState<FieldKind[]>(["double", "double", "double"]);
  const [preset, setPreset] = useState("v3");
  const [conv, setConv] = useState<ConvId>("sysv");
  const [ib, setIb] = useState(0);
  const [fb, setFb] = useState(0);
  const site = { intBefore: ib, fpBefore: fb };
  const r = useMemo(() => classify(conv, kinds, site), [conv, kinds, ib, fb]);
  const all = useMemo(() => classifyAll(kinds, site), [kinds, ib, fb]);
  const isGo = conv === "go";
  const tone = (h: string) => (h === "regs" ? "good" : h === "empty" ? "plain" : "warn");
  return (
    <Demo
      title="Which registers carry this struct?"
      controls={<>
        <Param spec={range({ label: "Integer arguments before it", min: 0, max: 8, step: 1, default: 0 })} value={ib} onChange={(v) => setIb(v as number)} />
        <Param spec={range({ label: "Double arguments before it", min: 0, max: 8, step: 1, default: 0 })} value={fb} onChange={(v) => setFb(v as number)} />
        <Param spec={convSpec} value={conv} onChange={(v) => setConv(v as ConvId)} />
        <Param spec={presetSpec} value={preset} onChange={(v) => { setPreset(v as string); setKinds(PRESETS.find((p) => p.id === v)!.kinds.slice()); }} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>Fields (click a field to remove it)</SectionLabel>
      <ButtonRow>
        {kinds.map((k, i) => (
          <button key={i} className="btn" title="Remove" onClick={() => setKinds(kinds.filter((_, j) => j !== i))} disabled={kinds.length === 1}
            style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, boxShadow: `inset 0 -3px 0 ${fieldColor(i)}` }}>
            {fieldDecl(k, "abcdefgh"[i]!)} ×
          </button>
        ))}
      </ButtonRow>
      <SectionLabel>Add a field</SectionLabel>
      <ButtonRow>
        {FIELD_KINDS.map((k) => <Btn key={k} ghost onClick={() => setKinds([...kinds, k])} disabled={kinds.length >= MAX_FIELDS}>+ {k}</Btn>)}
      </ButtonRow>
      <div style={{ ...mono, fontSize: 12.5, margin: "10px 0 4px", overflowX: "auto", whiteSpace: "nowrap" }}>
        {isGo ? `type S struct { ${kinds.map((k, i) => `${"ABCDEFGH"[i]} ${goType(k) ?? "?"}`).join("; ")} }` : structSource(kinds)}
      </div>
      <StructBytes layout={r.layout} table={false} caption={<>{CONVS[conv].name}: {r.layout.size} bytes, align {r.layout.align}</>} />
      <SectionLabel>{isGo ? "Each field, and its register" : conv === "sysv" ? "Eightbytes and their classes" : conv === "aapcs64" ? "How AAPCS64 sees it" : conv === "rv64" ? "How the RISC-V psABI sees it" : "How Windows x64 sees it"}</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
        {r.arg.chunks.map((c, i) => (
          <Panel key={i} title={`bytes ${c.offset}–${c.offset + c.size - 1} · ${c.fields.join(", ") || "padding"}`} accent={c.reg ? (isFpReg(c.reg) ? "var(--c2)" : "var(--c1)") : "var(--faint)"}>
            <div style={{ ...mono, fontSize: 12 }}>{c.cls}</div>
            <div style={{ ...mono, fontSize: 12.5, fontWeight: 600 }}>{c.reg ? `→ ${c.reg}` : r.arg.how === "ref" ? "→ copy in memory" : r.arg.how === "split" ? "→ stack" : "→ stack"}</div>
          </Panel>
        ))}
      </div>
      <Banner tone={tone(r.arg.how)} label="argument">
        <b style={mono}>{argText(r.arg)}</b>. {r.arg.why}
      </Banner>
      <Banner tone={r.ret.how === "regs" || r.ret.how === "x87" ? "good" : "warn"} label="return">
        <b style={mono}>{retText(r.ret)}</b>. {r.ret.why}
      </Banner>
      <SectionLabel>The same struct under all five conventions</SectionLabel>
      <MiniTable
        head={["convention", "argument", "return value"]}
        highlight={CONV_IDS.indexOf(conv)}
        rows={all.map((x) => [CONVS[x.conv].short, <span key="a" style={mono}>{argText(x.arg)}</span>, <span key="r" style={mono}>{retText(x.ret)}</span>])}
      />
    </Demo>
  );
}

const bigConvSpec = seg<BigConv>("Convention", BIG_CONVS.map((c) => [c, CONVS[c].short]), "sysv");
const shapeSpec = seg("Struct", [["d3", "3 doubles"], ["l3", "3 long longs"], ["d2", "2 doubles"]], "d3");
const SHAPES = { d3: { field: "double" as BigField, n: 3 as const }, l3: { field: "long long" as BigField, n: 3 as const }, d2: { field: "double" as BigField, n: 2 as const } };

export function AbiBigStructDemo() {
  const [conv, setConv] = useState<BigConv>("sysv");
  const [shape, setShape] = useState<keyof typeof SHAPES>("d3");
  const sh = SHAPES[shape];
  const steps = useMemo(() => bigTrace(conv, sh), [conv, shape]);
  const s = useStepper(steps.length, 1);
  const cur = steps[s.i]!;
  const src = bigSource(sh);
  return (
    <Demo
      title="Follow a struct through a call"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={bigConvSpec} value={conv} onChange={(v) => { setConv(v as BigConv); s.reset(); }} />
        <Param spec={shapeSpec} value={shape} onChange={(v) => { setShape(v as keyof typeof SHAPES); s.reset(); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Source</SectionLabel>
          <AbiSource lines={src} current={cur.line} />
          <SectionLabel>Argument and result registers now</SectionLabel>
          <RegList regs={cur.regs} empty="No register holds a value for this call yet." />
          <Stats items={[
            { label: "Bytes copied to memory", value: cur.copied },
            { label: "Struct size", value: `${sh.n * 8} B` },
            { label: "Step", value: `${s.i + 1} of ${steps.length}` },
          ]} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Stack, high addresses on top (unoptimized code)</SectionLabel>
          <StackView frames={cur.snap.frames} />
        </div>
      </div>
      <StepCaption label={`step ${s.i + 1}`} tone={s.atEnd ? (cur.copied ? "warn" : "good") : null}>{cur.text}</StepCaption>
    </Demo>
  );
}
