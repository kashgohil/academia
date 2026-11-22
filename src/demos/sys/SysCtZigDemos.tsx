/** Demos for "Zig comptime": a partial evaluator you can step, and the comptime check of a format string. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Controls, Demo, IndexButtons, IndexSlider, SectionLabel, StepCaption, Stats, mono, range, seg, tint, toggle, useParams } from "../../kit";
import { FMT_ARGS, checkFormat, emittedCalls, specialize, zigFn, type ZFn } from "../../sims/sys/comptime";
import { CodeLines, Cols, CompilerMessage, type CodeLine } from "./SysCtUi";

const SPEC = {
  n: range({ label: "n, the comptime argument", min: 1, max: 1200, step: 1, default: 13, log: true }),
  fn: seg<ZFn["id"]>("Function", [["power", "power: inline for"], ["powsq", "powSq: square and multiply"], ["sumto", "sumTo: whole call at comptime"]], "power"),
  quota: seg("Branch quota", [["1000", "1000 (default)"], ["2000", "2000"], ["10000", "10000"]], "1000"),
  rt: toggle({ label: "Pass a runtime n instead", default: false }),
};
const MAX_SHOWN = 160;

export function ZigSpecializeDemo() {
  const P = useParams("sys-ct-zig-spec", SPEC);
  const { n, quota, rt } = P.values;
  const fn = zigFn(P.values.fn);
  const q = Number(quota);
  const res = useMemo(() => specialize(fn, n, { quota: q, nKnown: !(rt && !fn.callAtComptime) }), [fn, n, q, rt]);
  const [k, setK] = useState(Infinity);
  const last = res.trace.length - 1;
  const step = Math.min(k, last);
  const ev = res.trace[step]!;
  const done = step === last;

  const src: CodeLine[] = [
    { text: fn.lines[0]! },
    ...(q !== 1000 ? [{ text: `    @setEvalBranchQuota(${q});`, tone: "info" as const }] : []),
    ...fn.lines.slice(1).map((t) => ({ text: t })),
    { text: "" },
    { text: rt && !fn.callAtComptime ? fn.callLine(n).replace(`, ${n})`, ", n_from_user)") : fn.callLine(n), tone: done && !res.ok ? ("bad" as const) : undefined },
  ];
  const off = q !== 1000 ? 1 : 0;
  const at = ev.line < 0 ? src.length - 1 : ev.line + (ev.line >= 1 ? off : 0);

  const shown = res.residual.slice(0, done ? res.residual.length : ev.emitted);
  const out: CodeLine[] = [
    { text: fn.callAtComptime ? "// the binary gets one constant:" : `${res.header} {   // n = ${n}` },
    ...shown.slice(0, MAX_SHOWN).map((l) => ({ text: (fn.callAtComptime ? res.header : "    ") + l.text, tone: done && l.dead ? ("dead" as const) : undefined, note: done && l.dead ? "dead: LLVM deletes it" : undefined })),
    ...(shown.length > MAX_SHOWN ? [{ text: `    // ... ${shown.length - MAX_SHOWN} more lines`, tone: "dead" as const }] : []),
    ...(fn.callAtComptime ? [] : [{ text: done && res.ok ? "}" : "" }]),
  ];

  return (
    <Demo
      title="Be the compiler: run the comptime parts, emit the rest"
      actions={<ButtonRow><IndexButtons k={step} n={last + 1} set={setK} /><Btn ghost onClick={() => setK(Infinity)}>End</Btn></ButtonRow>}
      controls={<>
        <Controls params={{ ...P, set: (key, v) => { P.set(key, v); setK(Infinity); } }} only={["n", "fn", "quota"]} />
        {!fn.callAtComptime && <Controls params={{ ...P, set: (key, v) => { P.set(key, v); setK(Infinity); } }} only={["rt"]} />}
        <IndexSlider k={step} n={last + 1} set={setK} label="Evaluation step" />
      </>}
    >
      <Stats items={[
        { label: "Branches used", value: `${ev.branches} of ${q}` },
        { label: "Multiplies left for runtime", value: done && res.ok ? res.liveMuls : "…" },
        { label: "Lines emitted", value: shown.length },
      ]} />
      <Cols>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Zig source (the compiler is here)</SectionLabel>
          <CodeLines lines={src} at={at} maxHeight={260} />
          <SectionLabel>Comptime values now</SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: 20 }}>
            {ev.known.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>none</span> : ev.known.map(([name, v]) => <Chip key={name} color="var(--c5)">{name} = {v}</Chip>)}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>{fn.callAtComptime ? "What goes into the binary" : "The instance: code left for runtime (model)"}</SectionLabel>
          <CodeLines lines={out} maxHeight={260} />
          <div style={{ marginTop: 8 }}>
            <div style={{ height: 8, borderRadius: 3, background: "var(--subtle)", border: "1px solid var(--border)", overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, (ev.branches / q) * 100)}%`, height: "100%", background: ev.branches > q ? "var(--c4)" : "var(--c5)", transition: "width 0.2s" }} />
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 3, ...mono }}>branch quota: {ev.branches} / {q}</div>
          </div>
        </div>
      </Cols>
      <StepCaption tone={done ? (res.ok ? "good" : "bad") : "info"} label={`step ${step + 1} of ${last + 1}`}>{ev.text}</StepCaption>
      {done && !res.ok && <CompilerMessage lines={[`error: ${res.error}`, `note: ${res.errorNote}`]} label="zig 0.17.1 prints" />}
    </Demo>
  );
}

const FMT_PRESETS: [string, string, number][] = [
  ["Good", "{d} items for {s}", 2],
  ["Too few", "{d} items for {s}", 1],
  ["One extra", "{d} items", 2],
  ["Wrong type", "{s} items", 1],
  ["Braces", "{{{d}}} in {s}", 2],
  ["By position", "{[1]s} has {[0]d}", 2],
  ["Hex and float", "{x} {s} {e}", 3],
];
const FSPEC = { argc: range({ label: "Arguments passed", min: 0, max: 4, step: 1, default: 2 }) };
const PIECE_COLORS = ["var(--c1)", "var(--c3)", "var(--c5)", "var(--c2)"];

export function ZigFormatDemo() {
  const P = useParams("sys-ct-zig-fmt", FSPEC);
  const argc = P.values.argc;
  const [fmt, setFmt] = useState(FMT_PRESETS[0]![1]);
  const r = useMemo(() => checkFormat(fmt, argc), [fmt, argc]);
  const calls = emittedCalls(r);
  const args = FMT_ARGS.slice(0, argc);
  // Color each character of the format string by the piece that owns it.
  const owner = new Array<number>(fmt.length).fill(-1);
  r.pieces.forEach((p, i) => { for (let c = p.from; c < p.to; c++) owner[c] = i; });
  const inErr = (c: number) => r.at !== undefined && r.error && !r.error.includes("unused") && c >= r.at[0] && c < r.at[1];
  return (
    <Demo title="The format string is checked at compile time" controls={<Controls params={P} />}>
      <ButtonRow>
        {FMT_PRESETS.map(([label, f, a]) => <Btn key={label} ghost on={fmt === f && argc === a} onClick={() => { setFmt(f); P.set("argc", a); }}>{label}</Btn>)}
      </ButtonRow>
      <SectionLabel>Format string (edit it)</SectionLabel>
      <input
        value={fmt}
        onChange={(e) => setFmt(e.target.value.slice(0, 60))}
        spellCheck={false}
        aria-label="Format string"
        style={{ width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 14, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", ...mono }}
      />
      <SectionLabel>The call</SectionLabel>
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", fontSize: 12.5, whiteSpace: "pre", ...mono }}>
        <span className="muted">std.debug.print("</span>
        {[...fmt].map((ch, c) => {
          const o = owner[c]!;
          const p = o >= 0 ? r.pieces[o]! : null;
          const col = p?.kind === "arg" ? PIECE_COLORS[p.index % 4]! : null;
          return <span key={c} style={{ background: inErr(c) ? tint("var(--c4)", 35) : col ? tint(col, 22) : undefined, color: col ?? "var(--fg)", borderBottom: p?.kind === "lit" ? "1px dotted var(--faint)" : undefined }}>{ch}</span>;
        })}
        <span className="muted">", .{"{ "}</span>
        {args.map((a, i) => <span key={a.name}><span style={{ color: PIECE_COLORS[i]!, textDecoration: r.unused.includes(i) ? "underline wavy var(--c4)" : undefined }}>{a.name}</span>{i < args.length - 1 ? ", " : ""}</span>)}
        <span className="muted">{" }"});</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {FMT_ARGS.map((a, i) => <Chip key={a.name} color={PIECE_COLORS[i]!} faint={i >= argc}>{a.name}: {a.type} = {a.value}</Chip>)}
      </div>
      <Cols>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Calls the comptime loop leaves for runtime (simplified)</SectionLabel>
          <CodeLines lines={calls.length ? calls.map((t) => ({ text: t })) : [{ text: "// none", tone: "dead" }]} maxHeight={180} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Result</SectionLabel>
          {r.error
            ? <CompilerMessage lines={[r.outside ? r.error : `error: ${r.error}`]} label={r.outside ? "outside the model" : "zig 0.17.1 stops the build"} />
            : <CompilerMessage ok lines={[r.output!]} label="it compiles; at run time it prints" />}
        </div>
      </Cols>
      <Banner tone="plain" style={{ marginTop: 10 }}>
        <span style={mono}>print</span> sets <span style={mono}>@setEvalBranchQuota(fmt.len * 1000)</span>, here {r.quota}. The walk over the string uses inline loops, and each iteration counts against the quota.
      </Banner>
    </Demo>
  );
}
