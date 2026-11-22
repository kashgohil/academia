/**
 * Views that the UB demos share: a code listing whose lines an optimizer step marks, a box of real compiler output,
 * two columns that stack on a phone, an outcome chip, and the optimizer stepper used by two lessons.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { Banner, ButtonRow, Demo, IndexButtons, IndexSlider, mono, Param, SectionLabel, select, StepCaption, tint } from "../../kit";
import { asmOf, cmdOf, optCase, outcomeText, type CodeLine, type GoldenKey, type Outcome } from "../../sims/sys/ub";

const MARK: Record<NonNullable<CodeLine["mark"]>, string> = { fact: "var(--c1)", fold: "var(--c2)", dead: "var(--faint)", new: "var(--c3)" };

/** A code listing. Marked lines are tinted; dead lines are struck through. It scrolls inside its own box. */
export function CodeView({ lines, style, label }: { lines: (CodeLine | string)[]; style?: CSSProperties; label?: ReactNode }) {
  return (
    <div style={{ minWidth: 0, ...style }}>
      {label && <SectionLabel style={{ marginTop: 0 }}>{label}</SectionLabel>}
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, lineHeight: "19px", padding: "4px 0", ...mono }}>
        <div style={{ minWidth: "max-content" }}>
          {lines.map((raw, i) => {
            const l = typeof raw === "string" ? { text: raw } : raw;
            const c = l.mark ? MARK[l.mark] : undefined;
            return (
              <div key={i} style={{ display: "flex", gap: 10, padding: "0 10px 0 6px", background: c && l.mark !== "dead" ? tint(c, 18) : undefined, boxShadow: c ? `inset 3px 0 0 ${c}` : undefined }}>
                <span style={{ width: 16, textAlign: "right", color: "var(--faint)", userSelect: "none" }}>{i + 1}</span>
                <span style={{ whiteSpace: "pre", color: l.mark === "dead" ? "var(--faint)" : "var(--fg)", textDecoration: l.mark === "dead" ? "line-through" : undefined }}>{l.text}</span>
                {l.note && <span style={{ color: "var(--muted)", fontStyle: "italic", whiteSpace: "pre" }}>{"// " + l.note}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Real compiler output from golden.ts, with the command that made it. `hot` tints lines that match. */
export function AsmView({ k, hot, label }: { k: GoldenKey; hot?: RegExp; label?: ReactNode }) {
  const lines = asmOf(k);
  return (
    <div style={{ minWidth: 0 }}>
      <SectionLabel style={{ marginTop: 0 }}>{label ?? "Real clang -O2 output (x86-64)"}</SectionLabel>
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, lineHeight: "18px", padding: "4px 0", background: "var(--subtle)", ...mono }}>
        <div style={{ minWidth: "max-content", padding: "0 10px" }}>
          {lines.map((l, i) => (
            <div key={i} style={{ whiteSpace: "pre", color: /^\S/.test(l) ? "var(--muted)" : "var(--fg)", background: hot?.test(l) ? tint("var(--c2)", 26) : undefined }}>{l}</div>
          ))}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 3, overflowWrap: "anywhere", ...mono }}>{cmdOf(k)}</div>
    </div>
  );
}

/** Two or more columns that stack on a phone. */
export const Cols = ({ children, min = 260, style }: { children: ReactNode; min?: number; style?: CSSProperties }) => (
  <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`, gap: 12, marginTop: 8, ...style }}>{children}</div>
);

export type OutTone = "good" | "bad" | "warn" | "plain";
const OUT: Record<OutTone, string> = { good: "var(--c3)", bad: "var(--c4)", warn: "var(--c2)", plain: "var(--border)" };

/** A result in a small box with a colored edge. */
export function OutBox({ title, tone = "plain", children }: { title: ReactNode; tone?: OutTone; children: ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "5px 9px 6px 12px", boxShadow: `inset 3px 0 0 ${OUT[tone]}`, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{title}</div>
      <div style={{ fontSize: 13, ...mono, overflowWrap: "anywhere" }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- the optimizer stepper

/**
 * Be the optimizer: pick a case, step through the facts and rewrites, then run each build on an input. With one case
 * id, the case picker is hidden.
 */
export function OptimizerView({ cases, title, id }: { cases: string[]; title: string; id: string }) {
  const [caseId, setCaseId] = useState(cases[0]!);
  const c = optCase(caseId);
  const [k, setK] = useState(0);
  const [input, setInput] = useState(c.inputs[c.inputs.length > 1 ? c.inputs.length - 1 : 0]!.id);
  const step = c.steps[Math.min(k, c.steps.length - 1)]!;
  const last = k >= c.steps.length - 1;
  const ub = c.ub(input);
  const outs = c.builds.map((b) => ({ b, o: c.run(input, b.id) }));
  const tone = (o: Outcome): OutTone => (o.kind !== "value" ? "bad" : ub ? "warn" : "good");
  const asmBuild = c.builds.find((b) => b.asm)!;
  const pick = (v: string) => {
    const n = optCase(v);
    setCaseId(v);
    setK(0);
    setInput(n.inputs[n.inputs.length > 1 ? n.inputs.length - 1 : 0]!.id);
  };
  const caseSpec = select({ label: "Function", options: cases.map((x) => ({ value: x, label: optCase(x).title })), default: cases[0]! });
  const inputSpec = select({ label: "Input", options: c.inputs.map((x) => ({ value: x.id, label: x.label })), default: c.inputs[0]!.id });
  return (
    <Demo
      title={title}
      actions={<ButtonRow><IndexButtons k={k} n={c.steps.length} set={setK} /></ButtonRow>}
      controls={<>
        <IndexSlider k={k} n={c.steps.length} set={setK} label="Optimizer step" />
        {cases.length > 1 && <Param spec={caseSpec} value={caseId} onChange={(v) => pick(v as string)} />}
        {c.inputs.length > 1 && <Param spec={inputSpec} value={input} onChange={(v) => setInput(v as string)} />}
      </>}
    >
      <div data-demo={id}>
        <Cols min={280} style={{ marginTop: 0 }}>
          <CodeView lines={step.code} label={`${c.lang} source, step ${k + 1}: ${step.title}`} />
          {last ? <AsmView k={asmBuild.asm!} /> : (
            <div style={{ minWidth: 0 }}>
              <SectionLabel style={{ marginTop: 0 }}>What the compiler may assume</SectionLabel>
              <div style={{ fontSize: 13, lineHeight: 1.45 }}>{step.rule ?? "Nothing yet. The compiler reads the function as it is written."}</div>
            </div>
          )}
        </Cols>
        <StepCaption label={`${k + 1} of ${c.steps.length}`} tone={step.code.some((l) => l.mark === "dead") ? "warn" : null}>{step.text}</StepCaption>
        <SectionLabel>Run each build: {c.inputs.find((x) => x.id === input)!.label}</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))", gap: 8 }}>
          {outs.map(({ b, o }) => <OutBox key={b.id} title={b.label} tone={tone(o)}>{outcomeText(o)}</OutBox>)}
        </div>
        <Banner tone={ub ? "bad" : "good"}>{ub ? <>UB: {ub} The standard sets no rule for this run, so each build may do something different.</> : "No UB on this input. Every build gives the same result: the as-if rule."}</Banner>
      </div>
    </Demo>
  );
}
