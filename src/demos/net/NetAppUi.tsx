/**
 * Views shared by the application-protocol demos (DNS, HTTP/1.1, HTTP/2, HTTP/3, WebSockets):
 * - HexSpans: bytes as a hex dump, coloured by the part of the message they belong to; click to select a part.
 * - Waterfall: one row per request, as browser dev tools draw a page load.
 */
import type { CSSProperties, ReactNode } from "react";
import { mono, tint, useWidth } from "../../kit";

export const inputStyle: CSSProperties = { font: "inherit", ...mono, fontSize: 13, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--fg)", maxWidth: "100%", boxSizing: "border-box" };

export interface ByteSpan { start: number; end: number; color: string; label: string }

export function HexSpans({ bytes, spans, selected, onSelect, maxRows }: { bytes: Uint8Array; spans: ByteSpan[]; selected?: number; onSelect?: (i: number) => void; maxRows?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const per = width < 420 ? 8 : 16;
  const spanOf = (i: number) => spans.findIndex((s) => i >= s.start && i < s.end);
  const rows = Math.ceil(bytes.length / per);
  const shown = maxRows ? Math.min(rows, maxRows) : rows;
  return (
    <div ref={ref} style={{ ...mono, fontSize: 12, lineHeight: 1.65, overflowX: "auto" }}>
      {Array.from({ length: shown }, (_, r) => (
        <div key={r} style={{ display: "flex", gap: 0, whiteSpace: "nowrap" }}>
          <span style={{ color: "var(--faint)", width: 36, flex: "none" }}>{(r * per).toString(16).padStart(3, "0")}</span>
          {Array.from({ length: per }, (_, c) => {
            const i = r * per + c;
            if (i >= bytes.length) return <span key={c} style={{ width: 22, flex: "none" }} />;
            const s = spanOf(i);
            const sp = spans[s];
            const on = s >= 0 && s === selected;
            return (
              <span key={c} onClick={onSelect && s >= 0 ? () => onSelect(s) : undefined} title={sp?.label}
                style={{ width: 22, flex: "none", textAlign: "center", cursor: onSelect && s >= 0 ? "pointer" : undefined, background: sp ? tint(sp.color, on ? 45 : 16) : undefined, borderBottom: on ? `2px solid ${sp!.color}` : "2px solid transparent", color: "var(--fg)" }}>
                {bytes[i]!.toString(16).padStart(2, "0")}
              </span>
            );
          })}
        </div>
      ))}
      {shown < rows && <div className="muted">… {bytes.length - shown * per} more bytes</div>}
    </div>
  );
}

export interface WaterfallRow { label: string; start: number; firstByte: number; end: number; color: string; tag?: string }

/** A page-load waterfall. Light bar: waiting for the first byte; solid bar: bytes arriving. */
export function Waterfall({ rows, tEnd, marks = [], children }: { rows: WaterfallRow[]; tEnd: number; marks?: { t: number; label: string; color?: string }[]; children?: ReactNode }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.max(280, width);
  const left = w < 480 ? 74 : 96, right = 8, rowH = 17, top = 14;
  const h = top + rows.length * rowH + 20;
  const x = (t: number) => left + (Math.max(0, t) / tEnd) * (w - left - right);
  const nt = w < 480 ? 3 : 5;
  const ticks = Array.from({ length: nt }, (_, i) => (tEnd * i) / (nt - 1));
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="waterfall" style={{ display: "block" }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={x(t)} x2={x(t)} y1={top - 4} y2={h - 18} stroke="var(--border)" strokeDasharray="2 3" />
            <text x={x(t)} y={h - 5} fontSize="10" fill="var(--faint)" textAnchor={i === 0 ? "start" : i === nt - 1 ? "end" : "middle"}>{Math.round(t)} ms</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const y = top + i * rowH;
          const ok = Number.isFinite(r.end);
          return (
            <g key={i}>
              <text x={left - 6} y={y + 11} fontSize="10.5" fill="var(--muted)" textAnchor="end">{r.label.length > (w < 480 ? 11 : 15) ? `${r.label.slice(0, w < 480 ? 10 : 14)}…` : r.label}</text>
              {Number.isFinite(r.start) && (
                <rect x={x(r.start)} y={y + 3} width={Math.max(1, x(Number.isFinite(r.firstByte) ? r.firstByte : tEnd) - x(r.start))} height={10} rx={2} fill={tint(r.color, 30)} />
              )}
              {ok && <rect x={x(r.firstByte)} y={y + 3} width={Math.max(1.5, x(r.end) - x(r.firstByte))} height={10} rx={2} fill={r.color} />}
              {r.tag && ok && <text x={Math.min(x(r.end) + 3, w - 4)} y={y + 11} fontSize="9.5" fill="var(--faint)" textAnchor={x(r.end) + 40 > w ? "end" : "start"}>{r.tag}</text>}
            </g>
          );
        })}
        {marks.map((m, i) => (
          <g key={`m${i}`}>
            <line x1={x(m.t)} x2={x(m.t)} y1={top - 6} y2={h - 18} stroke={m.color ?? "var(--c4)"} strokeWidth={1.5} />
            <text x={Math.min(Math.max(x(m.t), left + 20), w - 30)} y={top - 4} fontSize="10" fill={m.color ?? "var(--c4)"} textAnchor="middle">{m.label}</text>
          </g>
        ))}
      </svg>
      {children}
    </div>
  );
}

/** Text with visible control characters, for raw protocol bytes: CR LF as ␍␊, other bytes below 0x20 as ·. */
export function visible(s: string) {
  return s.replace(/\r/g, "␍").replace(/\n/g, "␊\n").replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\xff]/g, "·");
}
