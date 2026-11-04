/** Shared pieces for the engine (capstone) demos. */
import type { CSSProperties, ReactNode } from "react";
import { select } from "../../kit";
import type { Layer, PageImage, Version } from "../../sims/db/engine/kv";

export const mono: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontVariantNumeric: "tabular-nums" };

export const seg = <T extends string>(label: string, options: [T, string][], def: T) =>
  select<T>({ label, options: options.map(([value, l]) => ({ value, label: l })), default: def, segmented: true });

export const Note = ({ children }: { children: ReactNode }) => <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{children}</p>;
export const Label = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => <div className="muted" style={{ fontSize: 12, margin: "0 0 4px", ...style }}>{children}</div>;

export const LAYER_COLOR: Record<Layer, string> = {
  api: "var(--fg)", txn: "var(--c5)", tree: "var(--c1)", pool: "var(--c2)", file: "var(--c3)", wal: "var(--c4)", os: "var(--muted)",
};

export function Verdict({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  const c = ok === null ? "var(--c2)" : ok ? "var(--c3)" : "var(--c4)";
  return <div style={{ borderLeft: `3px solid ${c}`, padding: "4px 10px", fontSize: 13, margin: "8px 0", background: "var(--subtle)", borderRadius: "0 6px 6px 0" }}>{children}</div>;
}

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
