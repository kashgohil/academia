/** Small shared pieces for the analytical-systems (OLAP) demos. */
import type { CSSProperties, ReactNode } from "react";
import { select } from "../../kit";

export const seg = <T extends string>(label: string, options: [T, string][], def: T) =>
  select<T>({ label, options: options.map(([value, l]) => ({ value, label: l })), default: def, segmented: true });

export const mono: CSSProperties = { fontVariantNumeric: "tabular-nums", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

export const Note = ({ children }: { children: ReactNode }) => <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{children}</p>;

export const Caption = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div className="muted" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase", margin: "10px 0 4px", ...style }}>{children}</div>
);

export const Btn = ({ children, onClick, disabled, ghost }: { children: ReactNode; onClick: () => void; disabled?: boolean; ghost?: boolean }) => (
  <button className={`btn${ghost ? " ghost" : ""}`} onClick={onClick} disabled={disabled}>{children}</button>
);

export const ButtonRow = ({ children }: { children: ReactNode }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>{children}</div>
);

export const fx = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "–");
export const int = (v: number) => Math.round(v).toLocaleString("en-US");

/** A compact table that scrolls inside itself on narrow screens. */
export function MiniTable({ head, rows, highlight }: { head: ReactNode[]; rows: ReactNode[][]; highlight?: number }) {
  const cell: CSSProperties = { padding: "3px 8px", borderBottom: "1px solid var(--border)", textAlign: "right", whiteSpace: "nowrap" };
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12.5, ...mono, minWidth: "100%" }}>
        <thead>
          <tr>{head.map((h, i) => <th key={i} style={{ ...cell, textAlign: i === 0 ? "left" : "right", color: "var(--muted)", fontWeight: 600 }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ background: i === highlight ? "var(--subtle)" : undefined, fontWeight: i === highlight ? 700 : 400 }}>
              {r.map((c, j) => <td key={j} style={{ ...cell, textAlign: j === 0 ? "left" : "right" }}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A horizontal bar for a value as a fraction of a maximum. */
export const Bar = ({ frac, color = "var(--c1)", height = 10 }: { frac: number; color?: string; height?: number }) => (
  <div style={{ width: "100%", height, background: "var(--subtle)", borderRadius: 3, overflow: "hidden" }}>
    <div style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%`, minWidth: frac > 0 ? 1 : 0, height: "100%", background: color, transition: "width 0.25s" }} />
  </div>
);
