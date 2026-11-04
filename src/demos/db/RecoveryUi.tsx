/** Shared views for the recovery demos: log list with transaction lanes, pages, small tables. */
import type { CSSProperties, ReactNode } from "react";
import type { LogRecord, Lsn, Page, Frame, AttEntry } from "../../sims/db/recovery/core";
import { pageName } from "../../sims/db/recovery/aries";

export const mono: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontVariantNumeric: "tabular-nums" };

const TXN_COLORS = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--c3)"];
export const txnColor = (t: number) => TXN_COLORS[(t - 1) % TXN_COLORS.length]!;

export const Note = ({ children }: { children: ReactNode }) => <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{children}</p>;

export const Label = ({ children }: { children: ReactNode }) => <div className="muted" style={{ fontSize: 12, margin: "0 0 4px" }}>{children}</div>;

export const Tag = ({ t }: { t: number }) => (
  <span style={{ display: "inline-block", minWidth: 22, textAlign: "center", padding: "0 3px", borderRadius: 3, fontSize: 10.5, fontWeight: 600, color: "#fff", background: txnColor(t) }}>T{t}</span>
);

/** One-line description of a log record. `before` shows the undo information. */
export function recText(r: LogRecord, { before = true }: { before?: boolean } = {}): ReactNode {
  switch (r.kind) {
    case "update":
      return <><Tag t={r.txn} /> {pageName(r.page)}{before ? <>: {r.before} → </> : " = "}{r.after}</>;
    case "clr":
      return <><Tag t={r.txn} /> CLR {pageName(r.page)} = {r.after} <span className="muted">(undoes {r.undoes}, undoNext {r.undoNextLSN})</span></>;
    case "commit":
    case "abort":
    case "end":
      return <><Tag t={r.txn} /> {r.kind}</>;
    case "begin_ckpt":
      return <b style={{ fontWeight: 600 }}>begin_checkpoint</b>;
    case "end_ckpt":
      return <><b style={{ fontWeight: 600 }}>end_checkpoint</b> <span className="muted">ATT {"{"}{r.att.map((a) => `T${a.txn}`).join(" ") || "–"}{"}"} DPT {"{"}{r.dpt.map((d) => `${pageName(d.page)}:${d.recLSN}`).join(" ") || "–"}{"}"}</span></>;
  }
}

const ROW = 24;

/**
 * The log as a vertical list. Records with lsn <= flushedLSN are durable. With `lanes`, a gutter
 * draws each transaction's prevLSN chain (solid) and each CLR's undoNextLSN jump (dashed).
 */
export function LogView({
  log, flushedLSN, lost = [], cursor, lanes = false, mark, before = true, maxHeight,
}: {
  log: LogRecord[];
  flushedLSN: Lsn;
  /** Records that a crash dropped (shown struck through). */
  lost?: LogRecord[];
  /** LSN to highlight (recovery cursor). */
  cursor?: Lsn;
  lanes?: boolean;
  /** Extra marker per LSN (for example "redo" or "skip"). */
  mark?: (lsn: Lsn) => ReactNode;
  before?: boolean;
  maxHeight?: number;
}) {
  // New records reuse the LSNs of a lost tail (as byte offsets do); show only the lost records past the new end.
  const all = [...log, ...lost.filter((r) => r.lsn > log.length)];
  const txns = [...new Set(all.flatMap((r) => ("txn" in r ? [r.txn] : [])))].sort((a, b) => a - b);
  const laneX = (t: number) => 8 + txns.indexOf(t) * 13;
  const gutter = lanes ? 10 + txns.length * 13 : 0;
  const rowOf = new Map(all.map((r, i) => [r.lsn, i]));
  const y = (lsn: Lsn) => (rowOf.get(lsn) ?? 0) * ROW + ROW / 2;
  const isLost = (lsn: Lsn) => lsn > log.length;
  return (
    <div style={{ maxHeight, overflowY: maxHeight ? "auto" : undefined, border: "1px solid var(--border)", borderRadius: 6 }}>
      <div style={{ position: "relative", paddingLeft: gutter }}>
        {lanes && (
          <svg width={gutter} height={all.length * ROW} style={{ position: "absolute", left: 0, top: 0 }} aria-hidden>
            {all.map((r) => {
              if (!("txn" in r)) return null;
              const x = laneX(r.txn), c = txnColor(r.txn), dim = isLost(r.lsn) ? 0.35 : 1;
              return (
                <g key={r.lsn} opacity={dim}>
                  {r.prevLSN > 0 && rowOf.has(r.prevLSN) && <line x1={x} x2={x} y1={y(r.prevLSN)} y2={y(r.lsn)} stroke={c} strokeWidth={1.5} />}
                  {r.kind === "clr" && r.undoNextLSN > 0 && rowOf.has(r.undoNextLSN) && (
                    <path d={`M${x},${y(r.lsn)} C${x + 11},${y(r.lsn) - 6} ${x + 11},${y(r.undoNextLSN) + 6} ${x + 2},${y(r.undoNextLSN) + 3}`} fill="none" stroke={c} strokeWidth={1.2} strokeDasharray="3 2" />
                  )}
                  <circle cx={x} cy={y(r.lsn)} r={r.kind === "clr" ? 3.5 : 3} fill={r.kind === "clr" ? "var(--bg)" : c} stroke={c} strokeWidth={1.5} />
                </g>
              );
            })}
          </svg>
        )}
        {all.map((r) => {
          const lostRow = isLost(r.lsn);
          const durable = r.lsn <= flushedLSN && !lostRow;
          return (
            <div key={r.lsn} style={{
              height: ROW, display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "0 6px", whiteSpace: "nowrap", overflow: "hidden",
              background: cursor === r.lsn ? "var(--subtle)" : undefined,
              boxShadow: cursor === r.lsn ? "inset 2px 0 0 var(--fg)" : undefined,
              opacity: lostRow ? 0.45 : 1, textDecoration: lostRow ? "line-through" : undefined,
              borderTop: r.lsn === flushedLSN + 1 && !lostRow ? "1px dashed var(--c4)" : undefined,
            }}>
              <span style={{ ...mono, width: 22, textAlign: "right", color: "var(--muted)" }}>{r.lsn}</span>
              <span title={durable ? "durable" : "in memory only"} style={{ width: 7, height: 7, borderRadius: 7, flex: "none", background: durable ? "var(--fg)" : "transparent", border: "1px solid var(--muted)" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>{recText(r, { before })}</span>
              {mark?.(r.lsn)}
            </div>
          );
        })}
        {all.length === 0 && <div className="muted" style={{ fontSize: 12, padding: 6 }}>The log is empty.</div>}
      </div>
    </div>
  );
}

/** One page: name, value(s), pageLSN, and a dirty mark. */
export function PageBox({ page, dirty, tone, note, values }: { page: Page; dirty?: boolean; tone?: "bad" | "good" | "hot"; note?: ReactNode; values?: ReactNode }) {
  const border = tone === "bad" ? "var(--c4)" : tone === "good" ? "var(--c3)" : tone === "hot" ? "var(--fg)" : "var(--border)";
  return (
    <div style={{ minWidth: 0, flex: "1 1 58px", maxWidth: 96, border: `1.5px solid ${border}`, borderRadius: 6, padding: "4px 6px", background: dirty ? "var(--subtle)" : "var(--bg)", position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)" }}>
        <span>{pageName(page.id)}</span>
        {dirty && <span style={{ color: "var(--c2)", fontWeight: 600 }}>dirty</span>}
      </div>
      <div style={{ ...mono, fontSize: 17, fontWeight: 600, lineHeight: 1.3 }}>{values ?? page.slots.join(" ")}</div>
      <div style={{ ...mono, fontSize: 10.5, color: "var(--muted)" }}>pageLSN {page.pageLSN}</div>
      {note && <div style={{ fontSize: 10.5, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

export function PageRow({ pages, frames, label, tone, note }: { pages: Page[]; frames?: Map<number, Frame>; label: ReactNode; tone?: (p: Page) => "bad" | "good" | "hot" | undefined; note?: (p: Page) => ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <Label>{label}</Label>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {pages.map((p) => <PageBox key={p.id} page={p} dirty={frames?.get(p.id)?.dirty} tone={tone?.(p)} note={note?.(p)} />)}
      </div>
    </div>
  );
}

/** Small table (ATT, DPT). */
export function MiniTable({ title, head, rows, empty = "empty", highlight }: { title: ReactNode; head: string[]; rows: ReactNode[][]; empty?: string; highlight?: number }) {
  return (
    <div style={{ minWidth: 0, flex: "1 1 140px" }}>
      <Label>{title}</Label>
      <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%", ...mono }}>
        <thead>
          <tr>{head.map((h) => <th key={h} style={{ textAlign: "left", fontWeight: 500, color: "var(--muted)", borderBottom: "1px solid var(--border)", padding: "2px 6px 2px 0" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ background: highlight === i ? "var(--subtle)" : undefined }}>
              {r.map((c, j) => <td key={j} style={{ padding: "2px 6px 2px 0", borderBottom: "1px solid var(--border)" }}>{c}</td>)}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={head.length} className="muted" style={{ padding: "2px 0" }}>{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export const attRows = (att: Iterable<AttEntry>) => [...att].sort((a, b) => a.txn - b.txn).map((a) => [<Tag key="t" t={a.txn} />, a.status, a.lastLSN]);
export const dptRows = (dpt: Iterable<{ page: number; recLSN: Lsn }>) => [...dpt].sort((a, b) => a.page - b.page).map((d) => [pageName(d.page), d.recLSN]);

export function Verdict({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div style={{ borderLeft: `3px solid ${ok ? "var(--c3)" : "var(--c4)"}`, padding: "4px 10px", fontSize: 13, margin: "8px 0", background: "var(--subtle)", borderRadius: "0 6px 6px 0" }}>
      {children}
    </div>
  );
}
