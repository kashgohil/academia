/**
 * Views that the gc demos share: an object graph with roots and colored nodes (GcGraph), a code listing with a
 * current line (GcCode), and a short event log (GcLog). Colors: white objects are outlined, gray ones are --c2,
 * black ones are filled with --fg, freed ones are dashed, leaked or lost ones are --c4.
 */
import type { CSSProperties, ReactNode } from "react";
import { Arrow, Legend, MONO, mono, tint, useWidth } from "../../kit";
import type { Graph, Pos } from "../../sims/sys/gc";

export type NodeTone = "white" | "gray" | "black" | "freed" | "leaked" | "live" | "purple" | "plain";

export const TONE_LABEL: Record<NodeTone, string> = {
  white: "white: not reached", gray: "gray: reached, fields not read", black: "black: done", freed: "freed", leaked: "leaked or lost",
  live: "live", purple: "purple: candidate", plain: "object",
};
export const TONE_COLOR: Record<NodeTone, string> = {
  white: "var(--muted)", gray: "var(--c2)", black: "var(--fg)", freed: "var(--faint)", leaked: "var(--c4)", live: "var(--c3)", purple: "var(--c5)", plain: "var(--c1)",
};

function nodeStyle(t: NodeTone): { fill: string; stroke: string; text: string; dash?: string } {
  switch (t) {
    case "white": return { fill: "var(--bg)", stroke: "var(--fg)", text: "var(--fg)" };
    case "gray": return { fill: tint("var(--c2)", 40), stroke: "var(--c2)", text: "var(--fg)" };
    case "black": return { fill: "var(--fg)", stroke: "var(--fg)", text: "var(--bg)" };
    case "freed": return { fill: "var(--bg)", stroke: "var(--faint)", text: "var(--muted)", dash: "4 3" };
    case "leaked": return { fill: tint("var(--c4)", 20), stroke: "var(--c4)", text: "var(--fg)" };
    case "live": return { fill: tint("var(--c3)", 18), stroke: "var(--c3)", text: "var(--fg)" };
    case "purple": return { fill: tint("var(--c5)", 30), stroke: "var(--c5)", text: "var(--fg)" };
    default: return { fill: tint("var(--c1)", 14), stroke: "var(--c1)", text: "var(--fg)" };
  }
}

const NW = 50, NH = 30, RW = 44, RH = 22;

/** Where the segment from the center of a w × h box toward `to` leaves the box. */
function exit(c: { x: number; y: number }, to: { x: number; y: number }, w: number, h: number) {
  const dx = to.x - c.x, dy = to.y - c.y;
  if (!dx && !dy) return c;
  const s = Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

export interface GraphEdgeKey { from: number | string; field: number }

/**
 * An object graph. `pos` places objects by name in unit coordinates. Roots sit in a column on the left. `tone` and
 * `badge` style each object; `edgeTone` can color a pointer (for example "var(--c4)" for a dangling one). With
 * `onEdge`, clicking a pointer calls it (the hit area is wider than the line). `missing` objects are drawn as freed
 * at their old place, so pointers to them still show.
 */
export function GcGraph({ g, pos, tone, badge, focus, onEdge, edgeTone, height = 190, minWidth = 300, legend, extra }: {
  g: Graph;
  pos: Record<string, Pos>;
  tone?: (id: number) => NodeTone;
  badge?: (id: number) => string | undefined;
  focus?: number | null;
  onEdge?: (e: GraphEdgeKey) => void;
  edgeTone?: (e: GraphEdgeKey & { to: number }) => string | undefined;
  height?: number;
  minWidth?: number;
  legend?: NodeTone[];
  extra?: ReactNode;
}) {
  const [ref, w0] = useWidth<HTMLDivElement>(520);
  const W = Math.max(w0, minWidth);
  const roots = g.roots;
  const left = roots.length ? RW + 30 : 6;
  const at = new Map<number, { x: number; y: number }>();
  for (const o of g.objs) {
    const p = pos[o.name] ?? { x: 0.5, y: 0.5 };
    at.set(o.id, { x: left + NW / 2 + p.x * (W - left - NW - 10), y: NH / 2 + 12 + p.y * (height - NH - 24) });
  }
  const rootAt = new Map(roots.map((r, i) => [r.name, { x: 4 + RW / 2, y: 14 + RH / 2 + i * (RH + 10) }] as const));
  const lines: { key: string; e: GraphEdgeKey; to: number; d: string; color: string; hit: string }[] = [];
  roots.forEach((r) => {
    if (r.to === null || !at.has(r.to)) return;
    const a = rootAt.get(r.name)!, b = at.get(r.to)!;
    const p = exit(a, b, RW, RH), q = exit(b, a, NW + 6, NH + 6);
    const e = { from: r.name, field: 0 };
    lines.push({ key: `r${r.name}`, e, to: r.to, d: `M${p.x} ${p.y} L${q.x} ${q.y}`, color: edgeTone?.({ ...e, to: r.to }) ?? "var(--fg)", hit: `M${p.x} ${p.y} L${q.x} ${q.y}` });
  });
  for (const o of g.objs) {
    o.fields.forEach((t, i) => {
      if (t === null || !at.has(t)) return;
      const a = at.get(o.id)!, b = at.get(t)!;
      const e = { from: o.id, field: i };
      const color = edgeTone?.({ ...e, to: t }) ?? "var(--fg)";
      if (t === o.id) {
        const x = a.x + NW / 2, y = a.y;
        const d = `M${x} ${y - 6} C${x + 24} ${y - 26}, ${x + 24} ${y + 26}, ${x} ${y + 6}`;
        lines.push({ key: `${o.id}.${i}`, e, to: t, d, color, hit: d });
        return;
      }
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      const bend = Math.min(20 + 6 * i, len / 4);
      const mx = (a.x + b.x) / 2 + nx * bend, my = (a.y + b.y) / 2 + ny * bend;
      const p = exit(a, { x: mx, y: my }, NW, NH), q = exit(b, { x: mx, y: my }, NW + 6, NH + 6);
      const d = `M${p.x} ${p.y} Q${mx} ${my} ${q.x} ${q.y}`;
      lines.push({ key: `${o.id}.${i}`, e, to: t, d, color, hit: d });
    });
  }
  const colors = [...new Set(lines.map((l) => l.color))];
  const markerId = (c: string) => `gc-arrow-${colors.indexOf(c)}`;
  return (
    <div ref={ref} style={{ minWidth: 0 }}>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <svg width={W} height={height} style={{ display: "block", fontFamily: MONO, fontSize: 11.5 }}>
          <defs>{colors.map((c) => <Arrow key={c} id={markerId(c)} color={c} />)}</defs>
          {lines.map((l) => (
            <g key={l.key} onClick={onEdge ? () => onEdge(l.e) : undefined} style={{ cursor: onEdge ? "pointer" : undefined }}>
              <path d={l.d} fill="none" stroke={l.color} strokeWidth={1.4} strokeDasharray={l.color === "var(--c4)" ? "4 3" : undefined} markerEnd={`url(#${markerId(l.color)})`} />
              {onEdge && <path d={l.hit} fill="none" stroke="transparent" strokeWidth={14}><title>Click to cut this pointer</title></path>}
            </g>
          ))}
          {roots.map((r) => {
            const p = rootAt.get(r.name)!;
            return (
              <g key={r.name} transform={`translate(${p.x - RW / 2},${p.y - RH / 2})`}>
                <rect width={RW} height={RH} rx={4} fill="var(--subtle)" stroke="var(--border)" />
                <text x={RW / 2} y={RH / 2} dy="0.35em" textAnchor="middle" style={{ fill: r.to === null ? "var(--muted)" : "var(--fg)" }}>{r.name}</text>
              </g>
            );
          })}
          {g.objs.map((o) => {
            const p = at.get(o.id)!;
            const st = nodeStyle(tone?.(o.id) ?? "plain");
            const b = badge?.(o.id);
            return (
              <g key={o.id} transform={`translate(${p.x - NW / 2},${p.y - NH / 2})`}>
                {focus === o.id && <rect x={-4} y={-4} width={NW + 8} height={NH + 8} rx={8} fill="none" stroke="var(--c1)" strokeWidth={2} />}
                <rect width={NW} height={NH} rx={6} fill={st.fill} stroke={st.stroke} strokeWidth={1.5} strokeDasharray={st.dash} />
                <text x={NW / 2} y={NH / 2} dy="0.35em" textAnchor="middle" style={{ fill: st.text, fontWeight: 600 }}>{o.name}</text>
                {b !== undefined && (
                  <g transform={`translate(${NW - 8},-8)`}>
                    <rect x={-2} y={0} width={Math.max(18, 7 * b.length + 6)} height={16} rx={8} fill="var(--bg)" stroke="var(--border)" />
                    <text x={Math.max(18, 7 * b.length + 6) / 2 - 2} y={8} dy="0.35em" textAnchor="middle" style={{ fill: "var(--fg)", fontSize: 10.5 }}>{b}</text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {(legend || extra) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          {legend && <Legend items={legend.map((t) => ({ label: TONE_LABEL[t], color: TONE_COLOR[t] }))} />}
          {extra}
        </div>
      )}
    </div>
  );
}

/** A code listing; `at` marks the current line. Scrolls inside its box. */
export function GcCode({ lines, at, style, maxHeight }: { lines: string[]; at?: number | null; style?: CSSProperties; maxHeight?: number }) {
  return (
    <div style={{ ...mono, fontSize: 12, lineHeight: 1.5, border: "1px solid var(--border)", borderRadius: 6, background: "var(--subtle)", overflow: "auto", maxHeight, padding: "4px 0", ...style }}>
      {lines.map((l, i) => (
        <div key={i} style={{ whiteSpace: "pre", padding: "0 8px", background: at === i ? tint("var(--c1)", 22) : undefined, boxShadow: at === i ? "inset 3px 0 0 var(--c1)" : undefined }}>{l || " "}</div>
      ))}
    </div>
  );
}

/** A short log, newest last. `color` gives each entry a left edge. */
export function GcLog({ items, height = 120 }: { items: { text: ReactNode; color?: string }[]; height?: number }) {
  return (
    <div style={{ ...mono, fontSize: 11.5, lineHeight: 1.5, border: "1px solid var(--border)", borderRadius: 6, height, overflowY: "auto", padding: "3px 0" }}>
      {items.length === 0 && <div className="muted" style={{ padding: "0 8px" }}>Nothing yet.</div>}
      {items.map((it, i) => (
        <div key={i} style={{ padding: "0 8px", borderLeft: `3px solid ${it.color ?? "transparent"}`, overflowWrap: "anywhere" }}>{it.text}</div>
      ))}
    </div>
  );
}
