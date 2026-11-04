/** Shared parts of the file system demos. */
import type { CSSProperties, ReactNode } from "react";

export { Banner, MiniTable, MONO, useChunked } from "./SyncShared";

export const FILE_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c4)"];
export const fileColor = (n: number) => FILE_COLORS[((n % FILE_COLORS.length) + FILE_COLORS.length) % FILE_COLORS.length]!;

export const smallBtn: CSSProperties = { padding: "2px 8px", fontSize: 12.5 };

export function Heading({ children }: { children: ReactNode }) {
  return <div className="muted" style={{ fontSize: 12, marginBottom: 4, fontWeight: 550 }}>{children}</div>;
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.4, marginTop: 6 }}>{children}</div>;
}

/** A horizontal bar with a label on the left and a value on the right. */
export function HBar({ label, value, frac, color, parts }: { label: ReactNode; value: ReactNode; frac?: number; color?: string; parts?: { frac: number; color: string; title?: string }[] }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}>
        <span>{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{value}</span>
      </div>
      <div style={{ display: "flex", height: 8, background: "var(--subtle)", borderRadius: 2, overflow: "hidden", marginTop: 2 }}>
        {parts
          ? parts.map((p, i) => <div key={i} title={p.title} style={{ width: `${Math.min(100, p.frac * 100)}%`, background: p.color }} />)
          : <div style={{ width: `${Math.min(100, (frac ?? 0) * 100)}%`, background: color ?? "var(--c1)" }} />}
      </div>
    </div>
  );
}
