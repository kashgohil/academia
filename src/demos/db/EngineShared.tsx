/** Shared pieces for the engine (capstone) demos. */
import { mono } from "../../kit";
import type { Layer, PageImage, Version } from "../../sims/db/engine/kv";




export const LAYER_COLOR: Record<Layer, string> = {
  api: "var(--fg)", txn: "var(--c5)", tree: "var(--c1)", pool: "var(--c2)", file: "var(--c3)", wal: "var(--c4)", os: "var(--muted)",
};


/** A version chain as text: newest first, "T3:v1 T1:a5", with ✕ for a delete. */
export const chainText = (c: Version[]) => c.map((v) => `T${v.t}:${v.v ?? "✕"}`).join(" ");

/** A compact view of one B+ tree page. */
export function PageChip({ p, hot, dirty, showVersions }: { p: PageImage; hot?: boolean; dirty?: boolean; showVersions?: boolean }) {
  return (
    <div title={`page ${p.no}, pageLSN ${p.lsn}`} style={{ border: `1.5px solid ${hot ? "var(--c1)" : "var(--border)"}`, borderRadius: 5, padding: "2px 5px", fontSize: 11, background: dirty ? "var(--subtle)" : "var(--bg)", minWidth: 0, ...mono }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, color: "var(--muted)", fontSize: 10 }}>
        <span>p{p.no}</span>
        <span>{dirty ? <span style={{ color: "var(--c2)" }}>dirty </span> : null}lsn {p.lsn}</span>
      </div>
      {p.kind === "inner" ? (
        <div>{p.keys.join(" ") || "–"}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: showVersions ? "column" : "row", gap: showVersions ? 0 : 5, flexWrap: "wrap" }}>
          {p.keys.length === 0 && <span className="muted">empty</span>}
          {p.keys.map((k, i) => (
            <span key={k} style={{ whiteSpace: "nowrap" }}>{k}{showVersions && <span className="muted"> {chainText(p.cells[i]!)}</span>}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export const fmt = (v: number, d = 1) => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(d)) : "–");
