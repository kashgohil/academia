/**
 * Small views shared by the demos of the Systems "memory" module: a source listing with a current line, and a box
 * for compiler output. Memory itself is drawn with the shared views in SysViews.tsx.
 */
import type { ReactNode } from "react";
import { MONO, tint } from "../../kit";

/** A source listing. `current` is highlighted; lines in `bad` get a red number. Scrolls inside its own box. */
export function CodeLines({ lines, current = 0, bad, dim, maxHeight }: { lines: string[]; current?: number; bad?: Set<number>; dim?: boolean; maxHeight?: number }) {
  return (
    <div style={{ overflow: "auto", maxHeight, border: "1px solid var(--border)", borderRadius: 6, fontFamily: MONO, fontSize: 12, lineHeight: 1.55, padding: "4px 0", opacity: dim ? 0.6 : 1 }}>
      <div style={{ minWidth: "max-content" }}>
        {lines.map((l, i) => {
          const n = i + 1;
          const on = n === current;
          const isBad = bad?.has(n);
          return (
            <div key={i} style={{ display: "flex", gap: 10, padding: "0 10px 0 6px", background: on ? tint("var(--c1)", 20) : undefined, boxShadow: on ? "inset 3px 0 0 var(--c1)" : undefined }}>
              <span style={{ width: 18, flex: "none", textAlign: "right", color: isBad ? "var(--c4)" : "var(--faint)", fontWeight: isBad ? 700 : 400 }}>{n}</span>
              <span style={{ whiteSpace: "pre" }}>{l || " "}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Compiler output: an error (red edge), a warning (amber edge) or a note. */
export function CompilerBox({ tool, lines, tone, children }: { tool: string; lines: string[]; tone: "error" | "warning" | "note" | "silent"; children?: ReactNode }) {
  const col = tone === "error" ? "var(--c4)" : tone === "warning" ? "var(--c2)" : "var(--c3)";
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, boxShadow: `inset 3px 0 0 ${col}`, padding: "6px 10px 6px 12px", marginTop: 8 }}>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>{tool}</div>
      <div style={{ overflowX: "auto" }}>
        <pre style={{ margin: 0, fontFamily: MONO, fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "none", border: "none", padding: 0 }}>{lines.join("\n")}</pre>
      </div>
      {children}
    </div>
  );
}
