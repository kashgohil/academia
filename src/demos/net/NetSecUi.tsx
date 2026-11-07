/**
 * Views for the security module's demos:
 * - HexRuns: bytes as hex in colored runs (a record header, a ciphertext, a tag), wrapping at any width.
 * - CheckList: the steps of a validation, each passed, failed, or not reached.
 * - shortHex: the first bytes of a value, for labels.
 */
import type { ReactNode } from "react";
import { mono, tint } from "../../kit";

export interface HexRun {
  label: string;
  bytes: Uint8Array;
  color: string;
  /** Byte indexes (within this run) to mark. */
  mark?: number[];
}

/** The bytes of several runs, one after the other. Each run has its own color; a legend names them. */
export function HexRuns({ runs, perRow }: { runs: HexRun[]; perRow?: number }) {
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 0", ...mono, fontSize: 12, lineHeight: 1.5, maxWidth: perRow ? `${perRow * 2.6}em` : undefined }}>
        {runs.flatMap((r, ri) =>
          Array.from(r.bytes, (b, i) => (
            <span key={`${ri}-${i}`} title={`${r.label}, byte ${i}`} style={{
              padding: "0 2px", marginRight: 1, borderRadius: 2,
              background: r.mark?.includes(i) ? r.color : tint(r.color, 22),
              color: r.mark?.includes(i) ? "var(--bg)" : "var(--fg)",
            }}>{b.toString(16).padStart(2, "0")}</span>
          )),
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginTop: 6, fontSize: 12, color: "var(--muted)" }}>
        {runs.map((r) => (
          <span key={r.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: tint(r.color, 60), border: `1px solid ${r.color}` }} />
            {r.label} ({r.bytes.length} B)
          </span>
        ))}
      </div>
    </div>
  );
}

export interface CheckItem {
  label: ReactNode;
  detail?: ReactNode;
  /** true passed, false failed, undefined not reached. */
  ok?: boolean;
}

/** A vertical list of checks. The first failure is bold; the steps after it are faint. */
export function CheckList({ items }: { items: CheckItem[] }) {
  return (
    <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 4 }}>
      {items.map((c, i) => {
        const color = c.ok === undefined ? "var(--faint)" : c.ok ? "var(--c3)" : "var(--c4)";
        return (
          <li key={i} style={{ display: "grid", gridTemplateColumns: "20px 1fr", gap: 6, alignItems: "start", opacity: c.ok === undefined ? 0.55 : 1 }}>
            <span style={{ color, fontWeight: 700, ...mono, textAlign: "center" }}>{c.ok === undefined ? "·" : c.ok ? "✓" : "✗"}</span>
            <span style={{ fontSize: 13, minWidth: 0, overflowWrap: "anywhere" }}>
              <b style={{ fontWeight: c.ok === false ? 650 : 550 }}>{c.label}</b>
              {c.detail && <span style={{ color: "var(--muted)" }}> {c.detail}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** "3f ce 51 60…" : the first `n` bytes. */
export const shortHex = (b: Uint8Array, n = 6) => Array.from(b.slice(0, n), (x) => x.toString(16).padStart(2, "0")).join(" ") + (b.length > n ? " …" : "");
