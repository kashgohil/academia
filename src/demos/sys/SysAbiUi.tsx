/** Views shared by the demos of the ABI module: a source listing with a current line, and a register list. */
import type { ReactNode } from "react";
import { MONO, tint } from "../../kit";

/** Source lines; `current` (0-based) is highlighted, `bad` lines get a red number. */
export function AbiSource({ lines, current, bad = new Set() }: { lines: string[]; current?: number; bad?: Set<number> }) {
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, fontFamily: MONO, fontSize: 12, lineHeight: 1.55, padding: "4px 0" }}>
      <div style={{ minWidth: "max-content" }}>
        {lines.map((l, i) => {
          const on = i === current;
          return (
            <div key={i} style={{ display: "flex", gap: 10, padding: "0 10px 0 6px", background: on ? tint("var(--c1)", 20) : undefined, boxShadow: on ? "inset 3px 0 0 var(--c1)" : undefined }}>
              <span style={{ width: 16, textAlign: "right", color: bad.has(i) ? "var(--c4)" : "var(--faint)", fontWeight: bad.has(i) ? 700 : 400 }}>{i + 1}</span>
              <span style={{ whiteSpace: "pre" }}>{l}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Registers as small boxes: name on top, value below. Floating-point registers get --c2, others --c1. */
export function RegList({ regs, empty = "No argument registers." }: { regs: [string, string][]; empty?: ReactNode }) {
  if (!regs.length) return <div className="muted" style={{ fontSize: 12.5 }}>{empty}</div>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {regs.map(([r, v]) => {
        const fp = isFpReg(r);
        const col = fp ? "var(--c2)" : "var(--c1)";
        return (
          <div key={r} style={{ border: `1px solid ${col}`, borderRadius: 5, background: tint(col, 12), padding: "2px 7px", fontFamily: MONO, fontSize: 11.5, minWidth: 0 }}>
            <b style={{ color: col }}>{r}</b> <span>{v}</span>
          </div>
        );
      })}
    </div>
  );
}

export const isFpReg = (r: string) => /^(xmm|X\d|v\d|d\d|fa|st0)/.test(r);
