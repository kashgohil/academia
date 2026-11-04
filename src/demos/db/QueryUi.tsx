/** Shared pieces for the query-processing demos: colors, a frame stepper, captions, an operator tree and a row table. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Param, range, usePlot } from "../../kit";

export const MONO = "ui-monospace, Menlo, monospace";
export const GOOD = "var(--c3)";
export const BAD = "var(--c4)";
export const ACC = "var(--c1)";
export const WARM = "var(--c2)";
export const ALT = "var(--c5)";

/** Index into a list of frames, with play, back, step and a slider. */
export function useStepper(n: number, fps = 2) {
  const [i, setI] = useState(0);
  const [running, setRunning] = useState(false);
  const last = Math.max(0, n - 1);
  const cur = Math.min(i, last);
  const ref = useRef(cur);
  ref.current = cur;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      if (ref.current >= last) { setRunning(false); return; }
      setI(ref.current + 1);
    }, 1000 / fps);
    return () => window.clearInterval(id);
  }, [running, last, fps]);
  return {
    i: cur, n, atEnd: cur >= last, running,
    go: (j: number) => { setRunning(false); setI(Math.max(0, Math.min(last, j))); },
    toggle: () => { if (cur >= last && !running) setI(0); setRunning((r) => !r); },
    reset: () => { setRunning(false); setI(0); },
  };
}
export type Stepper = ReturnType<typeof useStepper>;

export function StepButtons({ s }: { s: Stepper }) {
  return (
    <>
      <button className="btn primary" onClick={s.toggle}>{s.running ? "Pause" : s.atEnd ? "Replay" : "Play"}</button>
      <button className="btn" onClick={() => s.go(s.i - 1)} disabled={s.i === 0}>Back</button>
      <button className="btn" onClick={() => s.go(s.i + 1)} disabled={s.atEnd}>Step</button>
    </>
  );
}

export function StepSlider({ s, label = "Step" }: { s: Stepper; label?: string }) {
  return <Param spec={range({ label, min: 0, max: Math.max(1, s.n - 1), step: 1, default: 0, format: (v) => `${v} of ${s.n - 1}` })} value={s.i} onChange={(v) => s.go(v as number)} />;
}

export function Caption({ children, tone, label }: { children: ReactNode; tone?: "good" | "bad" | null; label?: ReactNode }) {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.45, minHeight: 42, padding: "8px 10px 8px 13px", marginTop: 10, background: "var(--subtle)", borderRadius: 6, border: "1px solid var(--border)", boxShadow: `inset 3px 0 0 ${tone === "bad" ? BAD : tone === "good" ? GOOD : "var(--border)"}` }}>
      {label !== undefined && <span className="muted" style={{ fontSize: 11.5, marginRight: 8, fontVariantNumeric: "tabular-nums" }}>{label}</span>}
      {children}
    </div>
  );
}

export function Chip({ children, color = "var(--fg)", filled, dashed, faint, bold, title, onClick }: { children: ReactNode; color?: string; filled?: boolean; dashed?: boolean; faint?: boolean; bold?: boolean; title?: string; onClick?: () => void }) {
  return (
    <span
      title={title}
      onClick={onClick}
      style={{
        display: "inline-block", fontFamily: MONO, fontSize: 11.5, lineHeight: "17px", padding: "0 5px", borderRadius: 4,
        border: `1.5px ${dashed ? "dashed" : "solid"} ${color}`, background: filled ? color : "var(--bg)", color: filled ? "var(--bg)" : color,
        opacity: faint ? 0.35 : 1, cursor: onClick ? "pointer" : undefined, whiteSpace: "nowrap", fontWeight: bold ? 700 : 400,
        transition: "background 0.2s, color 0.2s, opacity 0.2s",
      }}
    >
      {children}
    </span>
  );
}

export const Note = ({ children }: { children: ReactNode }) => <p className="muted" style={{ fontSize: 12, margin: "10px 0 0", lineHeight: 1.45 }}>{children}</p>;

// ------------------------------------------------------------------ operator tree

export interface TreeNode {
  id: string;
  sym: string;
  sub?: string;
  kids: TreeNode[];
  /** Badge text (row count, calls, ...). */
  badge?: string;
  color?: string;
  /** Filled background (active). */
  active?: boolean;
  faint?: boolean;
  /** Text on the edge from this node up to its parent. */
  edge?: string;
  edgeColor?: string;
  edgeWidth?: number;
}

const CH = 6.8; // approximate width of one monospace character at 11 px
const SLOT = 128;

function wrap(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts = text.split(/(?<= ∧| ∨|,) /);
  const lines: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + " " + p).length > maxChars) { lines.push(cur); cur = p; } else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) lines.push(cur);
  return lines.flatMap((l) => (l.length > maxChars ? [l.slice(0, maxChars - 1) + "…"] : [l]));
}

interface Placed { n: TreeNode; x: number; depth: number; w: number; lines: string[]; span: number }

/** Draws an operator tree, root at the top. Scales to the container width. */
export function OpTree({ root, onPick, picked, slot = SLOT, maxWidth }: { root: TreeNode; onPick?: (id: string) => void; picked?: string; slot?: number; maxWidth?: number }) {
  const placed: Placed[] = [];
  let leaf = 0;
  const lay = (n: TreeNode, depth: number): { x: number; span: number } => {
    let x: number, span: number;
    if (!n.kids.length) { x = (leaf + 0.5) * slot; leaf++; span = slot; }
    else { const k = n.kids.map((c) => lay(c, depth + 1)); x = k.reduce((a, b) => a + b.x, 0) / k.length; span = k.reduce((a, b) => a + b.span, 0); }
    const maxChars = Math.max(8, Math.floor((span - 14) / CH));
    const lines = n.sub ? wrap(n.sub, maxChars) : [];
    const w = Math.min(span - 8, Math.max(n.sym.length * 9 + 26, ...lines.map((l) => l.length * CH + 16)));
    placed.push({ n, x, depth, w, lines, span });
    return { x, span };
  };
  lay(root, 0);
  const W = Math.max(leaf * slot, 200);
  const depthMax = Math.max(...placed.map((p) => p.depth));
  const rowH = Array.from({ length: depthMax + 1 }, (_, d) => Math.max(...placed.filter((p) => p.depth === d).map((p) => 24 + p.lines.length * 13)));
  const GAP = 26;
  const yTop = rowH.map((_, d) => 14 + rowH.slice(0, d).reduce((a, b) => a + b + GAP, 0));
  const H = yTop[depthMax]! + rowH[depthMax]! + 6;
  const byId = new Map(placed.map((p) => [p.n.id, p]));
  const hOf = (p: Placed) => 24 + p.lines.length * 13;
  return (
    <svg viewBox={`-34 0 ${W + 68} ${H}`} style={{ width: "100%", maxWidth: maxWidth ?? (W + 68) * 1.1, display: "block", margin: "0 auto", fontFamily: MONO }}>
      {placed.map((p) => p.n.kids.map((k) => {
        const c = byId.get(k.id)!;
        const y1 = yTop[p.depth]! + hOf(p), y2 = yTop[c.depth]!;
        return (
          <g key={`${p.n.id}-${k.id}`}>
            <line x1={p.x} y1={y1} x2={c.x} y2={y2} stroke={k.edgeColor ?? "var(--faint)"} strokeWidth={k.edgeWidth ?? 1.3} style={{ transition: "stroke 0.2s" }} />
            {k.edge && (
              <text x={(p.x + c.x) / 2 + 6} y={(y1 + y2) / 2 + 4} fontSize={10.5} fill={k.edgeColor ?? "var(--muted)"} fontWeight={600}>{k.edge}</text>
            )}
          </g>
        );
      }))}
      {placed.map((p) => {
        const y = yTop[p.depth]!, h = hOf(p);
        const col = p.n.color ?? "var(--fg)";
        const sel = picked === p.n.id;
        return (
          <g key={p.n.id} onClick={onPick ? () => onPick(p.n.id) : undefined} style={{ cursor: onPick ? "pointer" : undefined, opacity: p.n.faint ? 0.35 : 1, transition: "opacity 0.2s" }}>
            <rect x={p.x - p.w / 2} y={y} width={p.w} height={h} rx={5} fill={p.n.active ? col : "var(--bg)"} stroke={col} strokeWidth={sel ? 2.6 : 1.3} style={{ transition: "fill 0.2s" }} />
            <text x={p.x} y={y + 16} fontSize={13} textAnchor="middle" fontWeight={700} fill={p.n.active ? "var(--bg)" : col}>{p.n.sym}</text>
            {p.lines.map((l, i) => (
              <text key={i} x={p.x} y={y + 29 + i * 13} fontSize={11} textAnchor="middle" fill={p.n.active ? "var(--bg)" : "var(--muted)"}>{l}</text>
            ))}
            {p.n.badge !== undefined && (
              <g>
                <rect x={p.x + p.w / 2 - 6} y={y - 9} width={p.n.badge.length * 6.6 + 10} height={16} rx={8} fill="var(--bg)" stroke={col} />
                <text x={p.x + p.w / 2 - 1} y={y + 3} fontSize={10.5} fill={col} fontWeight={600}>{p.n.badge}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ------------------------------------------------------------------ row table

export function RowTable({ head, rows, max = 12, highlight, dim }: { head: string[]; rows: (string | number | null)[][]; max?: number; highlight?: (i: number) => string | undefined; dim?: (i: number) => boolean }) {
  const shown = rows.slice(0, max);
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
        <thead>
          <tr style={{ color: "var(--muted)" }}>{head.map((h, i) => <th key={i} style={{ textAlign: "left", padding: "2px 12px 2px 0", fontWeight: 500, whiteSpace: "nowrap" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid var(--border)", color: highlight?.(i), opacity: dim?.(i) ? 0.35 : 1 }}>
              {r.map((v, j) => <td key={j} style={{ padding: "2px 12px 2px 0", whiteSpace: "nowrap", color: v === null ? "var(--c2)" : undefined }}>{v === null ? "NULL" : String(v)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>… and {rows.length - max} more rows</div>}
      {rows.length === 0 && <div className="muted" style={{ fontSize: 12 }}>(no rows)</div>}
    </div>
  );
}

/** Small arrowhead marker; give each a unique id. */
export function Arrow({ id, color = "var(--muted)" }: { id: string; color?: string }) {
  return (
    <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0L10 5L0 10z" fill={color} />
    </marker>
  );
}

/**
 * Runs `f` in a timeout after render, so heavy work does not block a frame. Returns the last finished value
 * (the previous one while a new one is computing), or null before the first result.
 */
export function useLater<T>(f: () => T, deps: readonly unknown[]): T | null {
  const [v, setV] = useState<{ val: T } | null>(null);
  const fr = useRef(f);
  fr.current = f;
  useEffect(() => {
    const id = window.setTimeout(() => setV({ val: fr.current() }), 0);
    return () => window.clearTimeout(id);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return v ? v.val : null;
}

/** Formats an integer with thousands separators. */
export const int = (n: number) => Math.round(n).toLocaleString("en-US");

/** Bars that start at `base` (needed on a log y axis, where 0 has no position). Must be inside <Plot>. */
export function BaseBars({ bins, base, color = "var(--c1)", opacity = 0.8 }: { bins: { x0: number; x1: number; y: number; color?: string }[]; base: number; color?: string; opacity?: number }) {
  const { x, y } = usePlot();
  return (
    <g opacity={opacity}>
      {bins.map((b, i) => {
        const x0 = x(b.x0), x1 = x(b.x1), yb = y(base), yt = y(Math.max(base, b.y));
        return <rect key={i} x={x0} width={Math.max(0, x1 - x0)} y={yt} height={Math.max(0, yb - yt)} fill={b.color ?? color} />;
      })}
    </g>
  );
}
