/** Demos for "Rust generics and traits": a call through a vtable against an inlined call, and the orphan rule. */
import { useMemo, useState, type ReactNode } from "react";
import { Banner, ButtonRow, Chip, Demo, IndexButtons, IndexSlider, Param, SectionLabel, StepCaption, Stats, mono, seg, tint } from "../../kit";
import {
  ADDR, CIRCLE_AREA, DYN_LOOP, DYN_SLICE, SQUARE_AREA, STATIC_LOOP, STATIC_SLICE, TRAITS, TYPES, checkImpl, frames, perElement, rustcMessage,
  type Frame, type Spot,
} from "../../sims/sys/comptime";
import { CodeLines, Cols, CompilerMessage } from "./SysCtUi";

const hex = (n: number) => `0x${n.toString(16)}`;
const same = (a: Spot, b: Spot) => JSON.stringify(a) === JSON.stringify(b);

function Cell({ addr, children, hot, color = "var(--fg)", w = 92 }: { addr?: string; children: ReactNode; hot?: boolean; color?: string; w?: number }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {addr !== undefined && <span style={{ color: "var(--faint)", width: 44, textAlign: "right", flex: "none" }}>{addr}</span>}
      <span style={{ display: "inline-block", minWidth: w, padding: "1px 6px", border: `1px solid ${hot ? "var(--c4)" : "var(--border)"}`, borderRadius: 4, background: hot ? tint("var(--c4)", 20) : "var(--bg)", color, whiteSpace: "nowrap", transition: "background 0.2s" }}>{children}</span>
    </div>
  );
}

function MemoryView({ mode, f }: { mode: "static" | "dyn"; f: Frame }) {
  const objs = mode === "dyn" ? DYN_SLICE : STATIC_SLICE;
  const box = { border: "1px solid var(--border)", borderRadius: 6, padding: 8, fontSize: 11.5, ...mono, display: "grid", gap: 3, alignContent: "start" } as const;
  return (
    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", overflowX: "auto" }}>
      {mode === "dyn" && (
        <div style={box}>
          <div className="muted">v: &[&dyn Shape], 16 B each</div>
          {objs.map((o, i) => (
            <div key={i} style={{ display: "grid", gap: 2, paddingBottom: 3, borderBottom: "1px dashed var(--border)" }}>
              <Cell addr={hex(ADDR.slice + 16 * i)} hot={same(f.spot, { at: "slice", i, word: 0 })} color="var(--c1)">data → {hex(ADDR.objects + 8 * i)}</Cell>
              <Cell addr={hex(ADDR.slice + 16 * i + 8)} hot={same(f.spot, { at: "slice", i, word: 1 })} color="var(--c5)">vtable → {hex(o.kind === "Square" ? ADDR.vtSquare : ADDR.vtCircle)}</Cell>
            </div>
          ))}
        </div>
      )}
      <div style={box}>
        <div className="muted">{mode === "dyn" ? "the objects, anywhere in memory" : "v: &[Square], 8 B each"}</div>
        {objs.map((o, i) => (
          <Cell key={i} addr={hex(ADDR.objects + 8 * i)} hot={same(f.spot, { at: "object", i })} color={i === f.i ? "var(--fg)" : "var(--muted)"}>{o.kind}({o.r.toFixed(1)})</Cell>
        ))}
        {mode === "dyn" && <Cell addr="rbp-32" hot={same(f.spot, { at: "spill" })} color="var(--c2)">saved sum</Cell>}
      </div>
      {mode === "dyn" && (
        <div style={box}>
          {(["Square", "Circle"] as const).map((k) => (
            <div key={k} style={{ display: "grid", gap: 2, marginBottom: 4 }}>
              <div className="muted">vtable for {k}</div>
              {["drop: none (null)", "size: 8", "align: 8", `area → ${k}::area`].map((t, slot) => (
                <Cell key={slot} addr={`+${slot * 8}`} hot={same(f.spot, { at: "vtable", kind: k, slot })} color={slot === 3 ? "var(--c3)" : "var(--muted)"} w={120}>{t}</Cell>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DispatchDemo() {
  const [mode, setMode] = useState<"static" | "dyn">("dyn");
  const fr = useMemo(() => frames(mode), [mode]);
  const [k, setK] = useState(0);
  const step = Math.min(k, fr.length - 1);
  const f = fr[step]!;
  const pe = perElement();
  const loop = mode === "static" ? STATIC_LOOP : DYN_LOOP;
  const inCallee = f.listing === "Square" || f.listing === "Circle";
  const callee = f.listing === "Circle" ? CIRCLE_AREA : SQUARE_AREA;
  return (
    <Demo
      title="Follow the call: inlined, or through a vtable"
      actions={<ButtonRow><IndexButtons k={step} n={fr.length} set={setK} /></ButtonRow>}
      controls={<>
        <IndexSlider k={step} n={fr.length} set={setK} label="Instruction" />
        <Param spec={seg("Code", [["static", "total_static::<Square>"], ["dyn", "total_dyn: &[&dyn Shape]"]], "dyn")} value={mode} onChange={(v) => { setMode(v as "static" | "dyn"); setK(0); }} />
      </>}
    >
      <Stats items={[
        { label: "Instructions run", value: f.count },
        { label: "Indirect calls", value: f.indirect },
        { label: "Element", value: `v[${f.i}]` },
        { label: "Per element in this loop", value: mode === "static" ? `${pe.staticRemainder} (${pe.staticUnrolled} unrolled)` : `${pe.dynSquare} or ${pe.dynCircle}` },
      ]} />
      <Cols min={300}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>rustc 1.96.1 -O, x86-64: the inner loop</SectionLabel>
          <CodeLines lines={loop.map((l) => ({ text: l.text, note: l.note }))} at={inCallee ? undefined : f.line} numbers={false} maxHeight={240} />
          {mode === "dyn" && (
            <>
              <SectionLabel>The callee, reached through the vtable</SectionLabel>
              <CodeLines lines={callee.map((l) => ({ text: l.text }))} at={inCallee ? f.line : undefined} numbers={false} maxHeight={180} />
            </>
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Memory (addresses made up, offsets real)</SectionLabel>
          <MemoryView mode={mode} f={f} />
          <SectionLabel>Registers</SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {Object.entries(f.regs).map(([r, v]) => <Chip key={r} color="var(--muted)">{r} = {v}</Chip>)}
          </div>
        </div>
      </Cols>
      <StepCaption tone={mode === "static" ? "good" : f.spot.at === "vtable" ? "warn" : "info"} label={`${step + 1} / ${fr.length}`}>{f.caption}</StepCaption>
    </Demo>
  );
}

export function OrphanDemo() {
  const [sel, setSel] = useState<[string, string]>(["Display", "VecU8"]);
  const [tr, ty] = sel;
  const v = checkImpl(tr, ty);
  const msg = rustcMessage(tr, ty);
  const trait = TRAITS.find((t) => t.id === tr)!;
  const type = TYPES.find((t) => t.id === ty)!;
  const implLine = `impl${ty === "T" ? "<T>" : ty === "RefM" ? "<'a>" : ""} ${trait.text} for ${ty === "T" ? "T" : ty === "RefM" ? "&'a Meters" : type.text} { ... }`;
  return (
    <Demo title="Can this crate write this impl? Click a cell">
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        This crate defines <span style={mono}>struct Meters(f64)</span> and <span style={mono}>trait Describe</span>. Everything else comes from std.
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, ...mono }}>
          <thead>
            <tr>
              <th style={{ padding: "3px 6px", textAlign: "left", color: "var(--muted)", fontWeight: 600 }}>for ↓ / impl →</th>
              {TRAITS.map((t) => <th key={t.id} style={{ padding: "3px 6px", color: t.local ? "var(--c3)" : "var(--muted)", fontWeight: 600, whiteSpace: "nowrap" }}>{t.text}</th>)}
            </tr>
          </thead>
          <tbody>
            {TYPES.map((y) => (
              <tr key={y.id}>
                <td style={{ padding: "3px 6px", whiteSpace: "nowrap", color: y.ty.local || y.ty.fundamental ? "var(--c3)" : "var(--fg)" }}>{y.text}</td>
                {TRAITS.map((t) => {
                  const c = checkImpl(t.id, y.id);
                  const on = tr === t.id && ty === y.id;
                  const col = c.ok ? "var(--c3)" : c.code === "E0119" ? "var(--c2)" : "var(--c4)";
                  return (
                    <td key={t.id} style={{ padding: 2 }}>
                      <button onClick={() => setSel([t.id, y.id])} aria-label={`${t.text} for ${y.text}`}
                        style={{ width: "100%", minWidth: 56, font: "inherit", fontSize: 11.5, padding: "3px 4px", borderRadius: 4, cursor: "pointer", border: `1.5px solid ${on ? "var(--fg)" : "transparent"}`, background: tint(col, 22), color: col }}>
                        {c.ok ? "ok" : c.code}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SectionLabel>The impl</SectionLabel>
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", fontSize: 12.5, whiteSpace: "pre", ...mono }}>{implLine}</div>
      <Banner tone={v.ok ? "good" : v.code === "E0119" ? "warn" : "bad"}>{v.rule}</Banner>
      {msg ? <CompilerMessage lines={[msg]} label="rustc 1.96.1 says" /> : <CompilerMessage ok lines={["compiles"]} label="rustc 1.96.1" />}
    </Demo>
  );
}
