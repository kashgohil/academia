/**
 * Views for the network programming demos:
 * - Timeline: one row per connection (or thread), with colored spans for its phases and a time axis.
 * - ByteStrip: a stream of bytes as one row of chunks (messages, write() results, segments, read() results).
 * - CallLog: system calls with their return values, in time order.
 */
import type { ReactNode } from "react";
import { MONO, mono, tint, useWidth } from "../../kit";

export interface Span { t0: number; t1: number; color: string; dashed?: boolean; title?: string }
export interface TimelineRow { label: string; spans: Span[]; marks?: { t: number; color: string }[] }

/** Rows of spans on a shared time axis. Labels sit on the left; the axis ticks at round values. */
export function Timeline({ rows, tEnd, tStart = 0, rowH = 12, label = "time (ms)", labelW = 64, fmt = (v: number) => `${Math.round(v)}` }: { rows: TimelineRow[]; tEnd: number; tStart?: number; rowH?: number; label?: string; labelW?: number; fmt?: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.max(240, width);
  const right = 10;
  const x = (t: number) => labelW + ((Math.min(Math.max(t, tStart), tEnd) - tStart) / Math.max(1e-9, tEnd - tStart)) * (w - labelW - right);
  const h = rows.length * rowH + 26;
  const ticks = niceTicks(tStart, tEnd, Math.max(3, Math.floor((w - labelW) / 90)));
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg width={w} height={h} style={{ display: "block" }} role="img" aria-label="timeline">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={0} y2={rows.length * rowH} stroke="var(--border)" strokeWidth={1} />
            <text x={x(t)} y={rows.length * rowH + 13} textAnchor="middle" fontSize={10.5} fill="var(--muted)">{fmt(t)}</text>
          </g>
        ))}
        <text x={w - right} y={h - 1} textAnchor="end" fontSize={10.5} fill="var(--muted)">{label}</text>
        {rows.map((r, i) => (
          <g key={i} transform={`translate(0,${i * rowH})`}>
            <text x={labelW - 6} y={rowH / 2 + 3.5} textAnchor="end" fontSize={rowH >= 14 ? 11 : 9.5} fill="var(--muted)" fontFamily={MONO}>{r.label}</text>
            {r.spans.map((s, j) => (
              <rect key={j} x={x(s.t0)} y={1.5} width={Math.max(1.5, x(s.t1) - x(s.t0))} height={rowH - 3} rx={2} fill={s.dashed ? tint(s.color, 30) : s.color} stroke={s.dashed ? s.color : "none"} strokeDasharray={s.dashed ? "3 2" : undefined}>
                {s.title && <title>{s.title}</title>}
              </rect>
            ))}
            {r.marks?.map((m, j) => <circle key={`m${j}`} cx={x(m.t)} cy={rowH / 2} r={2.6} fill={m.color} />)}
          </g>
        ))}
      </svg>
    </div>
  );
}

function niceTicks(a: number, b: number, n: number): number[] {
  const span = b - a;
  if (span <= 0) return [a];
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let t = Math.ceil(a / step) * step; t <= b + 1e-9; t += step) out.push(Number(t.toFixed(6)));
  return out;
}

export interface Chunk { start: number; n: number; color: string; text?: string; dashed?: boolean }

/** One row of a byte stream from 0 to `total`: each chunk is a box with an optional label inside. */
export function ByteStrip({ label, chunks, total, h = 22 }: { label: ReactNode; chunks: Chunk[]; total: number; h?: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "88px 1fr", alignItems: "center", gap: 6, margin: "3px 0" }}>
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.2 }}>{label}</div>
      <div style={{ position: "relative", height: h, background: "var(--subtle)", borderRadius: 3, overflow: "hidden" }}>
        {chunks.map((c, i) => (
          <div key={i} title={c.text} style={{
            position: "absolute", left: `${(c.start / total) * 100}%`, width: `${(c.n / total) * 100}%`, top: 0, bottom: 0,
            background: c.dashed ? tint(c.color, 25) : tint(c.color, 55), borderLeft: "1.5px solid var(--bg)", borderRight: "1.5px solid var(--bg)",
            outline: c.dashed ? `1px dashed ${c.color}` : undefined, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 10.5, ...mono, color: "var(--fg)", overflow: "hidden", whiteSpace: "nowrap",
          }}>{c.text}</div>
        ))}
      </div>
    </div>
  );
}

export interface CallRow { t: number; who: string; call: string; result: string; tone?: "good" | "bad" | "warn" }
const TONE = { good: "var(--c3)", bad: "var(--c4)", warn: "var(--c5)" } as const;

/** System calls with their results, one per row, in a box that scrolls. The result sits under the call. */
export function CallLog({ rows, maxHeight = 230, timeLabel = "ms", digits = 1 }: { rows: CallRow[]; maxHeight?: number; timeLabel?: string; digits?: number }) {
  const cell = { padding: "3px 6px", verticalAlign: "top" as const };
  return (
    <div style={{ maxHeight, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12, ...mono }}>
        <thead style={{ position: "sticky", top: 0, background: "var(--bg)" }}>
          <tr style={{ color: "var(--muted)", textAlign: "left" }}>
            {[timeLabel, "who", "call and result"].map((h) => <th key={h} style={{ ...cell, fontWeight: 600, borderBottom: "1px solid var(--border)" }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ ...cell, color: "var(--muted)", whiteSpace: "nowrap" }}>{r.t.toFixed(digits)}</td>
              <td style={{ ...cell, whiteSpace: "nowrap" }}>{r.who}</td>
              <td style={{ ...cell, overflowWrap: "anywhere" }}>
                <div>{r.call}</div>
                <div style={{ color: r.tone ? TONE[r.tone] : "var(--muted)" }}>→ {r.result}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
