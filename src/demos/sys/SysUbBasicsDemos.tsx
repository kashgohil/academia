/**
 * Demos for "What UB really means": be the optimizer (UB-based rewrites, step by step, with real clang output), and
 * one bug under many contracts (C, Rust, Zig and Go build modes on the same edge operations).
 */
import { useState } from "react";
import { Demo, mono, Param, range, SectionLabel, select, tint } from "../../kit";
import { MODES, OPS, outcome, type OpId, type Tone } from "../../sims/sys/ub";
import { CodeView, OptimizerView } from "./SysUbUi";

export function UbOptimizerDemo() {
  return <OptimizerView id="ub-opt" title="Be the optimizer" cases={["null", "gt", "fermat"]} />;
}

const TONE: Record<Tone, { c: string; label: string }> = {
  defined: { c: "var(--c3)", label: "defined" },
  panic: { c: "var(--c1)", label: "stops with a message" },
  ub: { c: "var(--c4)", label: "UB or unchecked" },
  compile: { c: "var(--c5)", label: "the type system rules it out" },
};

const opSpec = select({ label: "Operation", options: OPS.map((o) => ({ value: o.id, label: o.label })), default: "add" as string });

export function UbContractsDemo() {
  const [op, setOp] = useState<OpId>("add");
  const spec = OPS.find((o) => o.id === op)!;
  const [vals, setVals] = useState<Record<string, number>>(() => Object.fromEntries(OPS.map((o) => [o.id, o.input?.default ?? 0])));
  const v = vals[op] ?? 0;
  const langs = [...new Set(MODES.map((m) => m.lang))];
  const counts = Object.fromEntries((Object.keys(TONE) as Tone[]).map((t) => [t, MODES.filter((m) => outcome(op, m.id, v).tone === t).length]));
  return (
    <Demo
      title="One bug, four contracts"
      controls={<>
        <Param spec={opSpec} value={op} onChange={(x) => setOp(x as OpId)} />
        {spec.input && <Param spec={range({ label: spec.input.label, min: spec.input.min, max: spec.input.max, step: 1, default: spec.input.default, format: spec.input.format })} value={v} onChange={(x) => setVals({ ...vals, [op]: x as number })} />}
      </>}
    >
      <CodeView lines={[spec.code]} label="The operation" />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 12, margin: "8px 0 2px" }}>
        {(Object.keys(TONE) as Tone[]).map((t) => (
          <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: TONE[t].c }} />
            {TONE[t].label} ({counts[t]})
          </span>
        ))}
      </div>
      {langs.map((lang) => (
        <div key={lang}>
          <SectionLabel>{lang}</SectionLabel>
          <div style={{ display: "grid", gap: 6 }}>
            {MODES.filter((m) => m.lang === lang).map((m) => {
              const cell = outcome(op, m.id, v);
              const c = TONE[cell.tone].c;
              return (
                <div key={m.id} style={{ display: "grid", gridTemplateColumns: "minmax(86px, 30%) 1fr", gap: 8, alignItems: "baseline", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px 4px 11px", boxShadow: `inset 3px 0 0 ${c}`, background: cell.tone === "ub" ? tint(c, 8) : undefined }}>
                  <span style={{ fontSize: 12, minWidth: 0, overflowWrap: "anywhere", ...mono }}>{m.label}</span>
                  <span style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{cell.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Demo>
  );
}
