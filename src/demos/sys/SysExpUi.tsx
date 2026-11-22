/**
 * Views for the "explicit allocation and cleanup" module: a code listing with a current line, backing-memory regions
 * with the allocations inside them, an arena's bytes with its position and marks, and a stack of pending cleanups.
 * Wide views scroll inside their own box. Colors are theme variables only.
 */
import type { CSSProperties, ReactNode } from "react";
import { MONO, mono, tint, bytes as fmtBytes } from "../../kit";
import { PAD_BG } from "./SysViews";
import type { Pending, Region } from "../../sims/sys/explicit";

const scroll: CSSProperties = { overflowX: "auto", maxWidth: "100%" };

/** A code listing. `current` is 1-based. `dim` lines are shown faint (switched off), `bad` lines get a red number. */
export function Code({ lines, current, dim, bad, mark }: { lines: string[]; current?: number; dim?: Set<number>; bad?: Set<number>; mark?: Map<number, string> }) {
  return (
    <div style={{ ...scroll, border: "1px solid var(--border)", borderRadius: 6, fontFamily: MONO, fontSize: 12, lineHeight: 1.55, padding: "4px 0" }}>
      <div style={{ minWidth: "max-content" }}>
        {lines.map((l, i) => {
          const n = i + 1;
          const on = n === current;
          const off = dim?.has(n);
          return (
            <div key={i} style={{ display: "flex", gap: 10, padding: "0 10px 0 6px", background: on ? tint("var(--c1)", 20) : undefined, boxShadow: on ? "inset 3px 0 0 var(--c1)" : undefined, opacity: off ? 0.35 : 1 }}>
              <span style={{ width: 18, textAlign: "right", flex: "none", color: bad?.has(n) ? "var(--c4)" : "var(--faint)", fontWeight: bad?.has(n) ? 700 : 400 }}>{n}</span>
              <span style={{ whiteSpace: "pre", textDecoration: off ? "line-through" : undefined }}>{l}</span>
              {mark?.get(n) && <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{mark.get(n)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const OWNER_COLOR: Record<string, string> = { a: "var(--c1)", b: "var(--c5)", report: "var(--c2)", node: "var(--faint)", buf: "var(--border)" };

/**
 * Regions of backing memory (mmaps, malloc blocks, a fixed buffer, arena nodes), each a bar to scale with the
 * allocations inside it: live ones colored by owner, freed ones that still take space hatched.
 */
export function Regions({ regions, scale, empty = "Nothing is allocated." }: { regions: Region[]; scale?: number; empty?: ReactNode }) {
  if (!regions.length) return <div className="muted" style={{ fontSize: 12.5 }}>{empty}</div>;
  const max = scale ?? Math.max(...regions.map((r) => r.size));
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {regions.map((r) => (
        <div key={r.addr} style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 11.5, ...mono, display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{r.label} · 0x{r.addr.toString(16)}</span><span>{fmtBytes(r.size)}</span>
          </div>
          <div style={{ position: "relative", height: 18, width: `${Math.max(2, (100 * r.size) / max)}%`, border: "1px solid var(--border)", borderRadius: 3, background: "var(--subtle)", overflow: "hidden" }}>
            {r.pieces.map((p, i) => {
              const left = (100 * (p.addr - r.addr)) / r.size, w = (100 * p.len) / r.size;
              return (
                <div key={i} title={`${p.who}: ${p.len} B${p.live ? "" : " (freed, still taking space)"}`} style={{
                  position: "absolute", top: 0, bottom: 0, left: `${left}%`, width: `${Math.max(0.4, w)}%`,
                  background: p.live ? tint(OWNER_COLOR[p.who] ?? "var(--fg)", 70) : PAD_BG, borderRight: "1px solid var(--bg)",
                }} />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The pending cleanups as a stack: the newest on top. */
export function CleanupStack({ pending, ran }: { pending: Pending[]; ran?: string[] }) {
  return (
    <div style={{ display: "grid", gap: 4, fontFamily: MONO, fontSize: 12 }}>
      {pending.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No cleanup is pending.</div>}
      {[...pending].reverse().map((p, i) => {
        const col = p.kind === "errdefer" ? "var(--c2)" : p.kind === "defer" ? "var(--c1)" : "var(--c5)";
        return (
          <div key={p.label + i} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "2px 8px", borderRadius: 4, border: `1px ${p.kind === "errdefer" ? "dashed" : "solid"} ${col}`, background: tint(col, 10) }}>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.label}</span>
            <span className="muted" style={{ whiteSpace: "nowrap" }}>{p.kind} · line {p.line}</span>
          </div>
        );
      })}
      {ran && ran.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 2 }}>
          <span className="muted">ran now: </span>{ran.join(" → ")}
        </div>
      )}
    </div>
  );
}
