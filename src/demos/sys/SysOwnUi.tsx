/**
 * Views that the ownership demos share: a code view with line marks, an editor that swaps in for it, rustc-style
 * diagnostics, a loan timeline (which lines each borrow is live on), and a stepper for programs on the memory machine.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { Banner, Btn, ButtonRow, Chip, MONO, SectionLabel, StepCaption, tint, type Stepper } from "../../kit";
import type { CheckResult, Diag, MemStep } from "../../sims/sys/ownership";
import { HeapBlocks, StackView, UbBanner } from "./SysViews";

const scroll: CSSProperties = { overflowX: "auto", maxWidth: "100%" };
const codeBox: CSSProperties = { ...scroll, border: "1px solid var(--border)", borderRadius: 6, fontFamily: MONO, fontSize: 12, lineHeight: "20px", padding: "4px 0" };

export type Mark = "bad" | "good" | "warn" | "info";
const MARK: Record<Mark, string> = { bad: "var(--c4)", good: "var(--c3)", warn: "var(--c2)", info: "var(--c1)" };

/** Source lines with numbers. `current` is highlighted; `marks` color a line number; `right` adds text after a line. */
export function CodeView({ lines, current, marks, right, style }: {
  lines: string[];
  current?: number;
  marks?: Map<number, Mark>;
  right?: Map<number, ReactNode>;
  style?: CSSProperties;
}) {
  return (
    <div style={{ ...codeBox, ...style }}>
      <div style={{ minWidth: "max-content" }}>
        {lines.map((l, i) => {
          const n = i + 1;
          const on = n === current;
          const mk = marks?.get(n);
          return (
            <div key={i} style={{ display: "flex", gap: 10, padding: "0 10px 0 6px", background: on ? tint("var(--c1)", 20) : mk === "bad" ? tint("var(--c4)", 10) : undefined, boxShadow: on ? "inset 3px 0 0 var(--c1)" : mk ? `inset 3px 0 0 ${MARK[mk]}` : undefined }}>
              <span style={{ width: 18, flex: "none", textAlign: "right", color: mk ? MARK[mk] : "var(--faint)", fontWeight: mk ? 700 : 400 }}>{n}</span>
              <span style={{ whiteSpace: "pre" }}>{l || " "}</span>
              {right?.get(n) && <span className="muted" style={{ whiteSpace: "pre", marginLeft: 6 }}>{right.get(n)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A code view that turns into a textarea. `children` renders the annotated view. */
export function EditableCode({ value, onChange, children, onReset }: { value: string; onChange: (v: string) => void; children: ReactNode; onReset?: () => void }) {
  const [editing, setEditing] = useState(false);
  const rows = Math.max(4, value.split("\n").length + 1);
  return (
    <div style={{ minWidth: 0 }}>
      {editing ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          rows={rows}
          aria-label="program source"
          style={{ width: "100%", boxSizing: "border-box", fontFamily: MONO, fontSize: 12, lineHeight: "20px", padding: "4px 8px", border: "1px solid var(--c1)", borderRadius: 6, background: "var(--bg)", color: "var(--fg)", resize: "vertical", whiteSpace: "pre", overflowX: "auto" }}
        />
      ) : children}
      <ButtonRow style={{ marginTop: 6 }}>
        <Btn ghost onClick={() => setEditing(!editing)}>{editing ? "Done" : "Edit the code"}</Btn>
        {onReset && <Btn ghost onClick={() => { onReset(); setEditing(false); }}>Reset</Btn>}
      </ButtonRow>
    </div>
  );
}

/** One error as rustc prints it: the code and message, then each labelled line with ^^^ (primary) or --- marks. */
export function Diagnostic({ d, lines }: { d: Diag; lines: string[] }) {
  const byLine = [...d.labels].filter((l) => !l.text.startsWith("help:")).sort((a, b) => a.line - b.line);
  const help = d.labels.find((l) => l.text.startsWith("help:"));
  const shown = [...new Set(byLine.map((l) => l.line))];
  return (
    <div style={{ ...codeBox, padding: "6px 10px", lineHeight: "18px", marginTop: 6 }}>
      <div style={{ minWidth: "max-content" }}>
        <div><b style={{ color: "var(--c4)" }}>error[{d.code}]</b><b>: {d.message}</b></div>
        {shown.map((n) => {
          const labs = byLine.filter((l) => l.line === n);
          const text = (lines[n - 1] ?? "").replace(/\s*\/\/.*$/, "");
          return (
            <div key={n}>
              <div><span className="muted">{String(n).padStart(2)} | </span><span style={{ whiteSpace: "pre" }}>{text}</span></div>
              {labs.map((l, k) => (
                <div key={k} style={{ color: l.primary ? "var(--c4)" : "var(--c1)", whiteSpace: "pre" }}>
                  <span className="muted">{"   | "}</span>{l.primary ? "^^^ " : "--- "}{l.text}
                </div>
              ))}
            </div>
          );
        })}
        {help && <div className="muted" style={{ whiteSpace: "pre" }}>{"   = "}{help.text}</div>}
      </div>
    </div>
  );
}

/** The checker's verdict: a parse problem, the errors, or "compiles" with what the program prints. */
export function Verdict({ r, lines, output = true }: { r: CheckResult; lines: string[]; output?: boolean }) {
  if (r.parseError) return <Banner tone="warn">The toy parser stops at line {r.parseError.line}: {r.parseError.message}.</Banner>;
  if (r.errors.length) {
    return (
      <div>
        <Banner tone="bad">{r.errors.length === 1 ? "1 error" : `${r.errors.length} errors`}: the program does not compile.</Banner>
        {r.errors.map((d, i) => <Diagnostic key={i} d={d} lines={lines} />)}
      </div>
    );
  }
  return (
    <div>
      <Banner tone="good">It compiles.{output && r.stdout.length === 0 ? " It prints nothing." : ""}</Banner>
      {output && r.stdout.length > 0 && (
        <div style={{ ...codeBox, padding: "4px 10px", marginTop: 6 }}>
          <div style={{ minWidth: "max-content" }}>
            {r.stdout.map((l, i) => <div key={i} style={{ whiteSpace: "pre", color: l.startsWith("drop ") ? "var(--c5)" : "var(--fg)" }}>{l}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Lines with an error, for CodeView marks. */
export const errorMarks = (r: CheckResult) => {
  const m = new Map<number, Mark>();
  if (r.parseError) m.set(r.parseError.line, "warn");
  for (const d of r.errors) m.set(d.line, "bad");
  return m;
};

const COL = 26;

/**
 * Code lines with, between the line number and the code, one column per binding (its scope, solid while it owns a
 * value) and one per loan (the lines on which the loan is live). The bars sit left of the code so that they stay
 * visible on a phone while long lines scroll.
 */
export function LoanTimeline({ r, lines, scopes = false, current }: { r: CheckResult; lines: string[]; scopes?: boolean; current?: number }) {
  const errLines = new Set(r.errors.map((e) => e.line));
  const binds = scopes ? r.bindings : [];
  const loanBad = (id: number) => r.errors.some((e) => e.message.includes(`\`${r.loans[id]!.place}\``) && e.labels.some((l) => l.line === r.loans[id]!.line));
  const cols = binds.length + r.loans.length;
  const lead = 28 + cols * COL;
  return (
    <div style={{ ...codeBox, padding: "4px 0 6px" }}>
      <div style={{ minWidth: "max-content" }}>
        <div style={{ display: "flex", padding: "0 8px 2px 6px", fontSize: 10.5, color: "var(--muted)", height: 16 }}>
          <span style={{ width: 28, flex: "none" }} />
          {binds.map((b, i) => <span key={`b${i}`} title={`${b.name}: ${b.type}`} style={{ width: COL, textAlign: "center", flex: "none", overflow: "hidden", color: "var(--c3)", fontWeight: 600 }}>{b.name.slice(0, 3)}</span>)}
          {r.loans.map((l) => <span key={`l${l.id}`} title={`loan L${l.id}: ${l.mut ? "&mut" : "&"} ${l.place}`} style={{ width: COL, textAlign: "center", flex: "none", color: l.mut ? "var(--c2)" : "var(--c1)", fontWeight: 600 }}>L{l.id}</span>)}
        </div>
        {lines.map((text, i) => {
          const n = i + 1;
          const bad = errLines.has(n);
          return (
            <div key={i} style={{ display: "flex", alignItems: "stretch", padding: "0 10px 0 6px", height: 20, background: n === current ? tint("var(--c1)", 20) : bad ? tint("var(--c4)", 10) : undefined }}>
              <span style={{ width: 22, marginRight: 6, flex: "none", textAlign: "right", color: bad ? "var(--c4)" : "var(--faint)", fontWeight: bad ? 700 : 400 }}>{n}</span>
              {binds.map((b, k) => {
                const inScope = n >= b.line && n <= b.end;
                const owns = inScope && (b.movedAt === undefined || n < b.movedAt);
                return (
                  <span key={`b${k}`} style={{ width: COL, flex: "none", display: "flex", justifyContent: "center" }}>
                    {inScope && <span style={{ width: 8, boxSizing: "border-box", background: owns ? tint("var(--c3)", 55) : "transparent", border: owns ? undefined : "1px dashed var(--c3)", borderRadius: n === b.line ? "4px 4px 0 0" : n === b.end ? "0 0 4px 4px" : 0 }} />}
                  </span>
                );
              })}
              {r.loans.map((l) => {
                const on = n >= l.line && n <= l.until;
                const col = loanBad(l.id) && (n === l.line || errLines.has(n)) ? "var(--c4)" : l.mut ? "var(--c2)" : "var(--c1)";
                return (
                  <span key={`l${l.id}`} style={{ width: COL, flex: "none", display: "flex", justifyContent: "center" }}>
                    {on && <span style={{ width: 8, boxSizing: "border-box", background: l.twoPhase ? "transparent" : tint(col, 70), border: l.twoPhase ? `1.5px dashed ${col}` : undefined, borderRadius: l.line === l.until ? 4 : n === l.line ? "4px 4px 0 0" : n === l.until ? "0 0 4px 4px" : 0 }} />}
                  </span>
                );
              })}
              <span style={{ whiteSpace: "pre", flex: "none", marginLeft: cols ? 8 : 0 }}>{text}</span>
            </div>
          );
        })}
        {cols === 0 && <div className="muted" style={{ padding: "2px 10px", fontSize: 11.5 }}>No borrows in this program.</div>}
        <div style={{ width: lead }} />
      </div>
    </div>
  );
}

/** Moved-from variables as chips. */
export function MovedChips({ names, label = "moved from" }: { names: string[]; label?: string }) {
  if (!names.length) return null;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6, fontSize: 12 }}>
      <span className="muted">{label}:</span>
      {names.map((n) => <Chip key={n} dashed color="var(--c2)">{n}</Chip>)}
    </div>
  );
}

/** A program on the memory machine, one step at a time: source, stack, heap, caption and UB reports. */
export function MemStepper({ steps, source, s, movedLabel, below }: { steps: MemStep[]; source: string[]; s: Stepper; movedLabel?: string; below?: ReactNode }) {
  const cur = steps[Math.min(s.i, steps.length - 1)]!;
  const bad = new Map<number, Mark>();
  for (const x of steps.slice(1, s.i + 1)) if (x.ub.length && x.line) bad.set(x.line, "bad");
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Source</SectionLabel>
          <CodeView lines={source} current={cur.line} marks={bad} />
          <MovedChips names={cur.moved} label={movedLabel} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Stack, high addresses on top</SectionLabel>
          <div style={{ overflowX: "auto" }}><div style={{ minWidth: 300 }}><StackView frames={cur.snap.frames.filter((f) => f.live)} empty="No frames: the program has ended." /></div></div>
        </div>
      </div>
      <SectionLabel>Heap blocks and the pointers to them</SectionLabel>
      <HeapBlocks blocks={cur.snap.heap} edges={cur.snap.edges} empty="No heap blocks yet." />
      {below}
      <StepCaption label={cur.line ? `line ${cur.line}` : "start"} tone={cur.ub.length ? "bad" : null}>{cur.caption}</StepCaption>
      {cur.ub.map((u, i) => <UbBanner key={i} event={u} />)}
    </div>
  );
}
