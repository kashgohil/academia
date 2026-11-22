/** Small views that the comptime demos share: a code listing with a marked line, and a compiler message box. */
import type { CSSProperties, ReactNode } from "react";
import { mono, tint } from "../../kit";

export interface CodeLine { text: string; tone?: "dead" | "hot" | "bad" | "good" | "info"; note?: ReactNode }

const TONE: Record<NonNullable<CodeLine["tone"]>, string> = { dead: "var(--faint)", hot: "var(--c1)", bad: "var(--c4)", good: "var(--c3)", info: "var(--c5)" };

/** A listing that scrolls inside its own box. `at` marks one line. */
export function CodeLines({ lines, at, maxHeight = 300, style, numbers = true }: { lines: CodeLine[]; at?: number; maxHeight?: number; style?: CSSProperties; numbers?: boolean }) {
  return (
    <div style={{ maxHeight, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, lineHeight: "18px", padding: "4px 0", ...mono, ...style }}>
      {lines.map((l, i) => {
        const on = i === at;
        const c = l.tone ? TONE[l.tone] : undefined;
        return (
          <div key={i} style={{ display: "flex", gap: 8, padding: "0 8px", whiteSpace: "pre", background: on ? tint("var(--c1)", 22) : l.tone && l.tone !== "dead" ? tint(c!, 10) : undefined, boxShadow: on ? "inset 3px 0 0 var(--c1)" : undefined }}>
            {numbers && <span style={{ color: "var(--faint)", minWidth: 18, textAlign: "right", userSelect: "none" }}>{i + 1}</span>}
            <span style={{ color: l.tone === "dead" ? "var(--faint)" : "var(--fg)", textDecoration: l.tone === "dead" ? "line-through" : undefined }}>{l.text}</span>
            {l.note && <span style={{ color: "var(--muted)", fontStyle: "italic" }}>{l.note}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** A compiler message, in monospace, with a colored edge. */
export function CompilerMessage({ lines, ok, label }: { lines: string[]; ok?: boolean; label?: string }) {
  const c = ok ? "var(--c3)" : "var(--c4)";
  return (
    <div style={{ marginTop: 8, border: "1px solid var(--border)", borderRadius: 6, boxShadow: `inset 3px 0 0 ${c}`, background: "var(--subtle)", padding: "6px 10px 6px 13px", overflowX: "auto" }}>
      {label && <div className="muted" style={{ fontSize: 11.5, marginBottom: 2 }}>{label}</div>}
      {lines.map((l, i) => <div key={i} style={{ ...mono, fontSize: 12, whiteSpace: "pre", color: i === 0 ? c : "var(--fg)" }}>{l}</div>)}
    </div>
  );
}

/** Two columns that stack on a phone. */
export const Cols = ({ children, min = 280 }: { children: ReactNode; min?: number }) => (
  <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`, gap: 12, marginTop: 8 }}>{children}</div>
);
