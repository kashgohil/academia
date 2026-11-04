/** The shared Gantt chart for every scheduling demo, plus small helpers that the demo files share. */
import type { CSSProperties, ReactNode } from "react";
import { useWidth } from "../../kit";
import type { Trace } from "../../sims/os/scheduling";

export const JOB_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c4)"];
export const jobColor = (i: number) => JOB_COLORS[((i % 5) + 5) % 5]!;

export interface GanttSeg { start: number; end: number; color: string; label?: string; faint?: boolean }
export interface GanttRow { label: string; segs: GanttSeg[]; sub?: string }
export interface GanttMark { t: number; row: number; kind: "miss" | "release" | "deadline"; }

const tickStep = (span: number, px: number) => {
  const want = span / Math.max(2, px / 64);
  const pow = 10 ** Math.floor(Math.log10(want));
  for (const m of [1, 2, 5, 10]) if (m * pow >= want) return m * pow;
  return 10 * pow;
};

export interface GanttProps {
  rows: GanttRow[];
  end: number;
  start?: number;
  cursor?: number;
  marks?: GanttMark[];
  /** Vertical lines over all rows, such as priority boosts. */
  rules?: { t: number; color?: string }[];
  rowH?: number;
  labelW?: number;
  unit?: string;
}

/** Rows of time segments on one shared axis. It fills its container, so it fits any width. */
export function Gantt({ rows, end, start = 0, cursor, marks, rules, rowH = 22, labelW = 44, unit = "ms" }: GanttProps) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const iw = Math.max(20, w - labelW - 9);
  const span = Math.max(1e-9, end - start);
  const x = (t: number) => labelW + ((t - start) / span) * iw;
  const gap = 3;
  const h = rows.length * (rowH + gap);
  const step = tickStep(span, iw);
  const ticks: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end + 1e-9; t += step) ticks.push(t);
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg width={w} height={h + 20} style={{ display: "block" }} role="img" aria-label="Gantt chart">
        {ticks.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={h} stroke="var(--border)" strokeWidth={1} />)}
        {rows.map((r, i) => {
          const y = i * (rowH + gap);
          return (
            <g key={i}>
              <rect x={labelW} y={y} width={iw} height={rowH} fill="var(--subtle)" />
              <text x={labelW - 6} y={y + rowH / 2} dy="0.32em" textAnchor="end" style={{ fontSize: 11.5, fill: "var(--muted)" }}>{r.label}</text>
              {r.segs.map((s, k) => {
                const a = Math.max(start, s.start), b = Math.min(end, s.end);
                if (b <= a) return null;
                const sx = x(a), sw = Math.max(0.75, x(b) - sx);
                return (
                  <g key={k}>
                    <rect x={sx} y={s.faint ? y + rowH / 2 - 2 : y} width={sw} height={s.faint ? 4 : rowH} fill={s.color} opacity={s.faint ? 0.45 : 1} />
                    {!s.faint && s.label && sw > s.label.length * 7 + 3 && (
                      <text x={sx + sw / 2} y={y + rowH / 2} dy="0.32em" textAnchor="middle" style={{ fontSize: 11, fill: "var(--bg)", fontWeight: 600 }}>{s.label}</text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
        {rules?.map((r, i) => <line key={i} x1={x(r.t)} x2={x(r.t)} y1={0} y2={h} stroke={r.color ?? "var(--fg)"} strokeDasharray="3 3" />)}
        {marks?.map((m, i) => {
          const y = m.row * (rowH + gap);
          const mx = x(m.t);
          if (m.kind === "release") return <path key={i} d={`M${mx},${y + rowH} l-3,5 h6 z`} fill="var(--muted)" />;
          if (m.kind === "deadline") return <line key={i} x1={mx} x2={mx} y1={y} y2={y + rowH} stroke="var(--fg)" strokeWidth={1} opacity={0.55} />;
          return (
            <g key={i} stroke="var(--c4)" strokeWidth={2.5} data-miss="1">
              <circle cx={mx} cy={y + rowH / 2} r={7} fill="var(--bg)" strokeWidth={1.5} />
              <line x1={mx - 3} x2={mx + 3} y1={y + rowH / 2 - 3} y2={y + rowH / 2 + 3} strokeWidth={1.8} />
              <line x1={mx - 3} x2={mx + 3} y1={y + rowH / 2 + 3} y2={y + rowH / 2 - 3} strokeWidth={1.8} />
            </g>
          );
        })}
        {cursor !== undefined && cursor >= start && cursor <= end && <line x1={x(cursor)} x2={x(cursor)} y1={-2} y2={h + 2} stroke="var(--fg)" strokeWidth={1.5} />}
        {ticks.map((t) => <text key={t} x={x(t)} y={h + 13} textAnchor="middle" style={{ fontSize: 10.5, fill: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{Number(t.toPrecision(6))}</text>)}
        <text x={labelW - 6} y={h + 13} textAnchor="end" style={{ fontSize: 10.5, fill: "var(--muted)" }}>{unit}</text>
      </svg>
    </div>
  );
}

const nameOf = (tr: Trace, id: number) => tr.jobs.find((j) => j.id === id)?.name ?? String(id);

/** One row: everything that ran on a CPU, in job colors. Switch time is grey. */
export function cpuRow(tr: Trace, label: string, cpu = 0, color: (id: number) => string = jobColor): GanttRow {
  return {
    label,
    segs: tr.slices.filter((s) => s.cpu === cpu).map((s) => s.kind === "switch"
      ? { start: s.start, end: s.end, color: "var(--faint)" }
      : { start: s.start, end: s.end, color: color(s.job), label: nameOf(tr, s.job) }),
  };
}

/** One row per job: dark for CPU, a thin line for I/O. */
export function jobRows(tr: Trace, color: (id: number) => string = jobColor): GanttRow[] {
  return tr.jobs.map((j) => ({
    label: j.name,
    segs: tr.slices.filter((s) => s.job === j.id && s.kind !== "switch").map((s) => ({ start: s.start, end: s.end, color: color(j.id), faint: s.kind === "io" })),
  }));
}

export const num: CSSProperties = { fontVariantNumeric: "tabular-nums" };

/** A small number input for job and task editors. */
export function NumCell({ value, min, max, onChange, label, width = 46 }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string; width?: number }) {
  return (
    <input
      type="number"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, Math.round(v))));
      }}
      style={{ width, font: "inherit", fontSize: 12.5, padding: "2px 4px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--fg)", ...num }}
    />
  );
}

export function SmallTable({ head, rows, right }: { head: ReactNode[]; rows: ReactNode[][]; right?: boolean }) {
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12.5, width: "100%" }}>
        <thead>
          <tr>{head.map((h, i) => <th key={i} style={{ textAlign: right && i > 0 ? "right" : "left", color: "var(--muted)", fontWeight: 500, padding: "2px 6px 2px 0", borderBottom: "1px solid var(--border)" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, k) => <td key={k} style={{ textAlign: right && k > 0 ? "right" : "left", padding: "2px 6px 2px 0", borderBottom: "1px solid var(--border)", ...num }}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const f1 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(1)).toString() : "–");
export const f2 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(2)).toString() : "–");
