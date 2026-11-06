/** Views that the Partitioning demos share: node colors and a bar chart of load per shard with a mean line. */
import type { ReactNode } from "react";
import { mono } from "../../kit";

const BASE = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c4)"];

/** A color per node. After five, the colors repeat mixed with the text color, so neighbours still differ. */
export const nodeColor = (i: number) => (i < BASE.length ? BASE[i]! : `color-mix(in srgb, ${BASE[i % BASE.length]} 55%, var(--fg))`);

/**
 * Vertical bars, one per shard or node, with a dashed line at the mean. The busiest bar is outlined.
 * `max` fixes the scale, so that two charts side by side compare.
 */
export function LoadBars({ values, labels, height = 120, max, format = (v) => String(Math.round(v)), colors, caption }: {
  values: number[];
  labels?: string[];
  height?: number;
  max?: number;
  format?: (v: number) => string;
  colors?: string[];
  caption?: ReactNode;
}) {
  const top = Math.max(1e-9, max ?? Math.max(...values));
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  const hi = values.indexOf(Math.max(...values));
  const many = values.length > 12;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ position: "relative", height, display: "flex", alignItems: "flex-end", gap: many ? 1 : 4, borderBottom: "1px solid var(--border)", paddingTop: 16 }}>
        {values.map((v, i) => (
          <div key={i} style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center" }}>
            {!many && <span style={{ ...mono, fontSize: 10, color: i === hi ? "var(--fg)" : "var(--muted)", whiteSpace: "nowrap", lineHeight: "14px" }}>{format(v)}</span>}
            <div style={{ width: "100%", height: `${Math.min(100, (v / top) * 100)}%`, minHeight: v > 0 ? 1 : 0, background: colors?.[i] ?? "var(--c1)", opacity: i === hi ? 1 : 0.75, outline: i === hi ? "1.5px solid var(--fg)" : undefined, borderRadius: "2px 2px 0 0", transition: "height 0.25s" }} />
          </div>
        ))}
        <div title="mean" style={{ position: "absolute", left: 0, right: 0, bottom: `${(mean / top) * (height - 16)}px`, borderTop: "1.5px dashed var(--fg)", opacity: 0.6, pointerEvents: "none" }} />
      </div>
      {labels && !many && (
        <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
          {labels.map((l, i) => <span key={i} className="muted" style={{ flex: 1, minWidth: 0, fontSize: 10, textAlign: "center", overflow: "hidden", whiteSpace: "nowrap" }}>{l}</span>)}
        </div>
      )}
      {caption && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{caption}</div>}
    </div>
  );
}
