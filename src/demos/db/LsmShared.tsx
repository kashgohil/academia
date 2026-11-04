/** Small shared pieces for the LSM demos. */
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

/** A row of buttons for the controls strip. */
export const ButtonRow = ({ children }: { children: ReactNode }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>{children}</div>
);

/** Fixed-precision number with no trailing noise. */
export const fx = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "–");

/** Horizontal stacked bar made of segments (fractions of the full width). */
export function StackBar({ parts, height = 18 }: { parts: { value: number; color: string; label?: string }[]; height?: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div style={{ display: "flex", width: "100%", height, borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)" }}>
      {parts.map((p, i) => (
        <div key={i} title={p.label} style={{ width: `${(100 * p.value) / total}%`, background: p.color, minWidth: p.value > 0 ? 1 : 0, transition: "width 0.25s" }} />
      ))}
    </div>
  );
}
