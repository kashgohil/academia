/** Small shared pieces for the isolation demos. */
import type { CSSProperties, ReactNode } from "react";
import { toneColor, type Tone } from "../../kit";

export const card: CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, padding: 10, minWidth: 0 };
export const cardTitle: CSSProperties = { fontSize: 11.5, color: "var(--muted)", marginBottom: 6 };
export const twoCol: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 };

export const Badge = ({ tone = "none", children }: { tone?: Tone; children: ReactNode }) => (
  <span style={{ display: "inline-block", fontSize: 11.5, fontWeight: 550, padding: "1px 7px", borderRadius: 4, color: "var(--bg)", background: toneColor(tone), whiteSpace: "nowrap" }}>{children}</span>
);

export const smallTable: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12.5 };
export const th: CSSProperties = { padding: "2px 6px", textAlign: "left", fontWeight: 550, color: "var(--muted)", whiteSpace: "nowrap" };
export const td: CSSProperties = { padding: "3px 6px", borderTop: "1px solid var(--border)", verticalAlign: "top" };

/** Wraps a table so that a wide one scrolls inside the demo, not the page. */
export const Scroll = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => <div style={{ overflowX: "auto", ...style }}>{children}</div>;
