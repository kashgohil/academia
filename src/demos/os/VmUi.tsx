/** A plain table for the vm lessons. Cell strings may use `code` and **bold**. It wraps on a phone and scrolls if it must. */
import type { ReactNode } from "react";

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean).map((part, i) => {
    if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    return part;
  });
}

export function VmTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div style={{ overflowX: "auto", margin: "16px 0" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5, lineHeight: 1.45 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--muted)" }}>
            {head.map((h, i) => <th key={i} style={{ padding: "4px 8px", fontWeight: 550, verticalAlign: "bottom" }}>{inline(h)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
              {r.map((c, j) => <td key={j} style={{ padding: "4px 8px", verticalAlign: "top" }}>{inline(c)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
