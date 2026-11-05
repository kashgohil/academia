/** Shared pieces for the kernel demos: bit grids, register cells, and small lists. */
import type { CSSProperties, ReactNode } from "react";
import { tint, mono } from "../../kit";

export { Msg, ModeBar } from "./ProcessesUi";

/** One register or value in a small box. A changed value has a red frame. */
export function RegCell({ name, value, hot, color, style }: { name: string; value: ReactNode; hot?: boolean; color?: string; style?: CSSProperties }) {
  return (
    <div style={{ border: `1px solid ${hot ? "var(--c4)" : "var(--border)"}`, background: hot ? tint("var(--c4)", 12) : "var(--bg)", borderRadius: 4, padding: "1px 5px", minWidth: 0, transition: "background 0.2s", ...style }}>
      <div style={{ fontSize: 10, color: "var(--muted)", ...mono }}>{name}</div>
      <div style={{ ...mono, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color }}>{value}</div>
    </div>
  );
}

export const RegGrid = ({ children, min = 112 }: { children: ReactNode; min?: number }) => (
  <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 3 }}>{children}</div>
);


export function Chip({ children, color, faint }: { children: ReactNode; color?: string; faint?: boolean }) {
  return (
    <span style={{ ...mono, fontSize: 11.5, padding: "1px 7px", borderRadius: 10, border: `1px solid ${color ?? "var(--border)"}`, background: color ? tint(color, 16) : "var(--bg)", color: faint ? "var(--muted)" : "var(--fg)", whiteSpace: "nowrap" }}>{children}</span>
  );
}

/**
 * A row-wrapped grid of clickable bits, high bit first in each row. `perRow` must divide the width.
 * Each field has one color, so the eye groups split fields such as base and limit.
 */
export function BitGrid({ value, bits, perRow = 16, colorOf, labelOf, onToggle, selected, onHover }: {
  value: bigint;
  bits: number;
  perRow?: number;
  colorOf: (bit: number) => string;
  labelOf?: (bit: number) => string;
  onToggle?: (bit: number) => void;
  selected?: (bit: number) => boolean;
  onHover?: (bit: number) => void;
}) {
  const rows: number[][] = [];
  for (let hi = bits - 1; hi >= 0; hi -= perRow) rows.push(Array.from({ length: perRow }, (_, i) => hi - i).filter((b) => b >= 0));
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {rows.map((r) => (
        <div key={r[0]} style={{ display: "grid", gridTemplateColumns: `34px repeat(${perRow}, minmax(0, 1fr))`, gap: 2, alignItems: "stretch" }}>
          <span style={{ ...mono, fontSize: 10, color: "var(--muted)", alignSelf: "center" }}>{r[0]}</span>
          {r.map((b) => {
            const on = ((value >> BigInt(b)) & 1n) === 1n;
            const c = colorOf(b);
            return (
              <button
                key={b}
                type="button"
                aria-label={`bit ${b}${labelOf ? `, ${labelOf(b)}` : ""}: ${on ? 1 : 0}`}
                title={`bit ${b}${labelOf ? ` ${labelOf(b)}` : ""}`}
                onClick={onToggle && (() => onToggle(b))}
                onPointerEnter={onHover && (() => onHover(b))}
                onFocus={onHover && (() => onHover(b))}
                style={{
                  ...mono, fontSize: 11, height: 26, padding: 0, minWidth: 0, cursor: onToggle ? "pointer" : "default",
                  border: `1px solid ${selected?.(b) ? "var(--fg)" : c}`, borderRadius: 3,
                  background: on ? c : tint(c, 10), color: on ? "var(--bg)" : "var(--muted)",
                }}
              >{on ? 1 : 0}</button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** A named bit of a control register. */
export function FlagCell({ name, bit, on, hot }: { name: string; bit: number; on: boolean; hot?: boolean }) {
  return (
    <div style={{ textAlign: "center", border: `1px solid ${hot ? "var(--c4)" : on ? "var(--c1)" : "var(--border)"}`, background: on ? tint("var(--c1)", 18) : "var(--bg)", borderRadius: 4, padding: "1px 4px", minWidth: 34, transition: "background .2s" }}>
      <div style={{ ...mono, fontSize: 10.5, fontWeight: on ? 600 : 400, color: on ? "var(--fg)" : "var(--muted)" }}>{name}</div>
      <div className="muted" style={{ ...mono, fontSize: 9.5 }}>bit {bit}: {on ? 1 : 0}</div>
    </div>
  );
}

/** A plain scroll box with a fixed height, for logs. */
export function LogBox({ height = 120, children }: { height?: number; children: ReactNode }) {
  return <div style={{ ...mono, fontSize: 11, lineHeight: 1.45, border: "1px solid var(--border)", borderRadius: 6, padding: "4px 7px", height, overflowY: "auto", background: "var(--subtle)", overflowWrap: "anywhere" }}>{children}</div>;
}
