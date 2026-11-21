/** Views that the data-module demos share: a row of bits that wraps to the width, a text field, and a byte grid. */
import type { CSSProperties, ReactNode } from "react";
import { MONO, mono, tint, useWidth } from "../../kit";

export interface BitCell {
  /** 0 or 1. */
  v: number;
  /** The bit index (0 = least significant). */
  i: number;
  color?: string;
  /** A label shown above the cell. */
  tag?: string;
  dim?: boolean;
  mark?: boolean;
}

/**
 * Bits from the most significant on the left. Click a cell to flip it. The row wraps at a multiple of 8 bits,
 * so 64 bits fit on a phone with no horizontal scroll. A gap separates each group of `group` bits.
 */
export function BitRow({ cells, onFlip, group = 4, size: fixedSize, label, below, ariaLabel }: {
  cells: BitCell[]; onFlip?: (i: number) => void; group?: number; size?: number; label?: ReactNode;
  below?: (start: number, bits: BitCell[]) => ReactNode; ariaLabel?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>(600);
  const size = fixedSize ?? (w < 420 ? 17 : 22);
  const gap = 5;
  const perByte = 8 * size + Math.floor(8 / group) * gap;
  const bytesPerRow = Math.max(1, Math.floor(w / perByte));
  const perRow = Math.min(cells.length, Math.max(8, 8 * 2 ** Math.floor(Math.log2(bytesPerRow))));
  const rows: BitCell[][] = [];
  for (let s = 0; s < cells.length; s += perRow) rows.push(cells.slice(s, s + perRow));
  return (
    <div ref={ref} style={{ minWidth: 0 }} aria-label={ariaLabel}>
      {label && <div className="muted" style={{ fontSize: 11.5, marginBottom: 2 }}>{label}</div>}
      {rows.map((row, r) => (
        <div key={r} style={{ display: "flex", flexWrap: "nowrap", gap: 0, marginBottom: 4 }}>
          {chunk(row, group).map((g, gi) => (
            <div key={gi} style={{ display: "flex", flexDirection: "column", marginRight: gap }}>
              <div style={{ display: "flex" }}>
                {g.map((c) => {
                  const color = c.color ?? "var(--c1)";
                  const style: CSSProperties = {
                    width: size, height: size + 4, padding: 0, margin: 0, border: `1px solid ${c.mark ? "var(--fg)" : "var(--border)"}`, marginLeft: -1,
                    background: c.v ? tint(color, 55) : "var(--bg)", color: c.v ? "var(--fg)" : "var(--faint)", fontFamily: MONO, fontSize: 12,
                    cursor: onFlip ? "pointer" : "default", opacity: c.dim ? 0.45 : 1, boxShadow: `inset 0 -3px 0 ${color}`, position: "relative",
                  };
                  return (
                    <button key={c.i} type="button" title={`bit ${c.i}`} style={style} onClick={onFlip ? () => onFlip(c.i) : undefined} tabIndex={onFlip ? 0 : -1}>
                      {c.v}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "var(--faint)", ...mono, padding: "0 1px" }}>
                <span>{g[0]!.i}</span>
                {g.length > 1 && <span>{g[g.length - 1]!.i}</span>}
              </div>
              {below && below(g[0]!.i, g)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Cells for a w-bit bigint, most significant first. */
export function cellsOf(x: bigint, w: number, color?: (i: number) => string | undefined, extra?: (i: number) => Partial<BitCell>): BitCell[] {
  return Array.from({ length: w }, (_, k) => {
    const i = w - 1 - k;
    return { v: Number((x >> BigInt(i)) & 1n), i, color: color?.(i), ...extra?.(i) };
  });
}

/** A monospace text field that shows a red border when the text does not parse. */
export function TextField({ value, onChange, bad, label, width = 220, placeholder }: { value: string; onChange: (s: string) => void; bad?: boolean; label: string; width?: number; placeholder?: string }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, flexWrap: "wrap", minWidth: 0 }}>
      <span className="muted">{label}</span>
      <input
        aria-label={label} value={value} spellCheck={false} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ flex: `1 1 ${Math.min(width, 160)}px`, minWidth: 0, maxWidth: width, font: "inherit", padding: "3px 6px", border: `1px solid ${bad ? "var(--c4)" : "var(--border)"}`, borderRadius: 4, background: "var(--bg)", color: "var(--fg)", ...mono }}
      />
    </label>
  );
}

/** A labelled value in a monospace font that wraps anywhere. */
export const Readout = ({ label, children, color }: { label: ReactNode; children: ReactNode; color?: string }) => (
  <div style={{ display: "grid", gridTemplateColumns: "minmax(70px, max-content) minmax(0, 1fr)", gap: 10, fontSize: 12.5, alignItems: "baseline", padding: "2px 0" }}>
    <span className="muted">{label}</span>
    <span style={{ overflowWrap: "anywhere", color, ...mono }}>{children}</span>
  </div>
);

/** One byte as a small box: hex on top, and an optional caption. */
export function ByteBox({ value, color = "var(--border)", caption, on, onClick, dim }: { value: number | null; color?: string; caption?: ReactNode; on?: boolean; onClick?: () => void; dim?: boolean }) {
  return (
    <div onClick={onClick} style={{ display: "flex", flexDirection: "column", alignItems: "center", cursor: onClick ? "pointer" : "default", opacity: dim ? 0.4 : 1, minWidth: 0 }}>
      <div style={{ width: 30, height: 26, display: "grid", placeItems: "center", fontSize: 12.5, borderRadius: 4, border: `1.5px solid ${on ? "var(--fg)" : color}`, background: value === null ? "transparent" : tint(color, 22), ...mono }}>
        {value === null ? "" : value.toString(16).padStart(2, "0").toUpperCase()}
      </div>
      {caption !== undefined && <div style={{ fontSize: 9.5, color: "var(--muted)", marginTop: 1, ...mono }}>{caption}</div>}
    </div>
  );
}
