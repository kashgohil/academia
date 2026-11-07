/**
 * Views shared by the link-layer demos: a small topology drawing (hosts, switches, an access point; links that can
 * be marked, cut or blocked; labels at port ends), a hex dump with colored regions and clickable bytes, and a state
 * timeline (bands of color over time).
 */
import type { ReactNode } from "react";
import { MONO, useWidth } from "../../kit";

export interface TopoNode {
  id: number;
  label: string;
  /** Position in [0, 1] × [0, 1]. */
  x: number;
  y: number;
  kind: "host" | "switch" | "ap";
  /** A second line under the label. */
  sub?: string;
  color?: string;
  /** Draw with a thick outline. */
  strong?: boolean;
  faint?: boolean;
}

export interface TopoLink {
  a: number;
  b: number;
  color?: string;
  width?: number;
  dashed?: boolean;
  /** Draw a cross in the middle. */
  cut?: boolean;
  /** Labels near each end, such as a port role. */
  aEnd?: string;
  bEnd?: string;
  label?: string;
}

export function Topo({ nodes, links, height = 220, onLink, onNode }: { nodes: TopoNode[]; links: TopoLink[]; height?: number; onLink?: (i: number) => void; onNode?: (id: number) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.max(260, width);
  const padX = 34, padY = 22;
  const px = (x: number) => padX + x * (w - 2 * padX);
  const py = (y: number) => padY + y * (height - 2 * padY);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const size = (n: TopoNode) => {
    const tw = n.label.length * 7 + 14;
    return n.kind === "switch" ? { w: Math.max(46, tw), h: 24 } : n.kind === "ap" ? { w: Math.max(34, tw), h: 24 } : { w: Math.max(30, tw), h: 22 };
  };
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} role="img" aria-label="network topology" style={{ display: "block" }}>
        {links.map((l, i) => {
          const a = byId.get(l.a), b = byId.get(l.b);
          if (!a || !b) return null;
          const x1 = px(a.x), y1 = py(a.y), x2 = px(b.x), y2 = py(b.y);
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          const d = Math.hypot(x2 - x1, y2 - y1) || 1;
          const ux = (x2 - x1) / d, uy = (y2 - y1) / d;
          const endAt = (x: number, y: number, s: number) => ({ x: x + ux * s * 44, y: y + uy * s * 44 });
          const ea = endAt(x1, y1, 1), eb = endAt(x2, y2, -1);
          return (
            <g key={i} onClick={onLink ? () => onLink(i) : undefined} style={{ cursor: onLink ? "pointer" : undefined }}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={16} />
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={l.color ?? "var(--faint)"} strokeWidth={l.width ?? 1.6} strokeDasharray={l.dashed ? "5 4" : undefined} />
              {l.cut && <path d={`M${mx - 6} ${my - 6}L${mx + 6} ${my + 6}M${mx + 6} ${my - 6}L${mx - 6} ${my + 6}`} stroke="var(--c4)" strokeWidth={2.4} />}
              {l.label && <text x={mx - uy * 12} y={my + ux * 12 + 4} textAnchor="middle" fontSize="10.5" fill="var(--muted)">{l.label}</text>}
              {[[l.aEnd, ea], [l.bEnd, eb]].map(([t, e], k) => t ? (
                <g key={k}>
                  <rect x={(e as { x: number }).x - 7} y={(e as { y: number }).y - 7} width={14} height={14} rx={3} fill="var(--bg)" stroke={l.color ?? "var(--faint)"} />
                  <text x={(e as { x: number }).x} y={(e as { y: number }).y + 4} textAnchor="middle" fontSize="10" fontWeight={600} fill="var(--fg)">{t as string}</text>
                </g>
              ) : null)}
            </g>
          );
        })}
        {nodes.map((n) => {
          const s = size(n);
          const x = px(n.x), y = py(n.y);
          const c = n.color ?? "var(--fg)";
          return (
            <g key={n.id} opacity={n.faint ? 0.4 : 1} onClick={onNode ? () => onNode(n.id) : undefined} style={{ cursor: onNode ? "pointer" : undefined }}>
              {n.kind === "ap" ? (
                <path d={`M${x - s.w / 2} ${y + s.h / 2}L${x} ${y - s.h / 2}L${x + s.w / 2} ${y + s.h / 2}Z`} fill="var(--bg)" stroke={c} strokeWidth={n.strong ? 2.4 : 1.4} />
              ) : (
                <rect x={x - s.w / 2} y={y - s.h / 2} width={s.w} height={s.h} rx={n.kind === "host" ? 11 : 4} fill={n.strong ? `color-mix(in srgb, ${c} 18%, var(--bg))` : "var(--bg)"} stroke={c} strokeWidth={n.strong ? 2.2 : 1.4} />
              )}
              <text x={x} y={y + (n.kind === "ap" ? 8 : 4)} textAnchor="middle" fontSize="11.5" fontWeight={600} fill="var(--fg)">{n.label}</text>
              {n.sub && <text x={x} y={y + s.h / 2 + 12} textAnchor="middle" fontSize="10.5" fill="var(--muted)">{n.sub}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** A hex dump. `colors[i]` tints byte i; `marked` bytes get an outline; clicking a byte calls onByte. */
export function HexDump({ bytes, colors, marked, onByte, perLine }: { bytes: Uint8Array; colors?: (string | undefined)[]; marked?: Set<number>; onByte?: (i: number) => void; perLine?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const per = perLine ?? (width < 430 ? 8 : 16);
  const rows: number[][] = [];
  for (let i = 0; i < bytes.length; i += per) rows.push(Array.from({ length: Math.min(per, bytes.length - i) }, (_, k) => i + k));
  return (
    <div ref={ref} style={{ fontFamily: MONO, fontSize: 12, lineHeight: "20px" }}>
      {rows.map((r) => (
        <div key={r[0]} style={{ display: "flex", gap: 2, alignItems: "center" }}>
          <span style={{ color: "var(--faint)", width: 32, flex: "none" }}>{r[0]!.toString(16).padStart(4, "0")}</span>
          {r.map((i) => (
            <span
              key={i}
              onClick={onByte ? () => onByte(i) : undefined}
              style={{
                width: 21, textAlign: "center", borderRadius: 3, cursor: onByte ? "pointer" : undefined,
                background: colors?.[i] ? `color-mix(in srgb, ${colors[i]} 22%, var(--bg))` : undefined,
                outline: marked?.has(i) ? "2px solid var(--c4)" : undefined, outlineOffset: -2,
                fontWeight: marked?.has(i) ? 700 : 400,
              }}
            >
              {bytes[i]!.toString(16).padStart(2, "0")}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

export interface Band {
  from: number;
  to: number;
  color: string;
  label?: string;
}

export interface Tick {
  t: number;
  color: string;
  /** Row 0 is just above the band, 1 is above that. */
  row?: number;
  title?: string;
  shape?: "line" | "dot" | "cross";
}

/** One horizontal timeline: colored bands, ticks above them, a time axis below. */
export function Timeline({ bands, ticks = [], tEnd, tStart = 0, unit = "s", scale = 1000, rows = 2, children, marks = [] }: { bands: Band[]; ticks?: Tick[]; tEnd: number; tStart?: number; unit?: string; scale?: number; rows?: number; children?: ReactNode; marks?: { t: number; label: string }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.max(260, width);
  const left = 4, right = 8, rowH = 12, bandY = 6 + rows * rowH, bandH = 22;
  const h = bandY + bandH + 30;
  const x = (t: number) => left + ((t - tStart) / (tEnd - tStart)) * (w - left - right);
  const n = w < 480 ? 4 : 6;
  const axis = Array.from({ length: n + 1 }, (_, i) => tStart + ((tEnd - tStart) * i) / n);
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="timeline" style={{ display: "block" }}>
        {bands.map((b, i) => {
          const x1 = x(Math.max(tStart, b.from)), x2 = x(Math.min(tEnd, b.to));
          if (x2 <= x1) return null;
          return (
            <g key={i}>
              <rect x={x1} y={bandY} width={x2 - x1} height={bandH} fill={`color-mix(in srgb, ${b.color} 30%, var(--bg))`} stroke={b.color} strokeWidth={1} />
              {b.label && b.label.length * 6.3 + 6 < x2 - x1 && <text x={(x1 + x2) / 2} y={bandY + 15} textAnchor="middle" fontSize="10.5" fill="var(--fg)">{b.label}</text>}
            </g>
          );
        })}
        {ticks.map((k, i) => {
          if (k.t < tStart || k.t > tEnd) return null;
          const cx = x(k.t), cy = bandY - 6 - (k.row ?? 0) * rowH;
          return (
            <g key={i}>
              {k.title && <title>{k.title}</title>}
              {k.shape === "dot" ? <circle cx={cx} cy={cy} r={3} fill={k.color} />
                : k.shape === "cross" ? <path d={`M${cx - 3} ${cy - 3}L${cx + 3} ${cy + 3}M${cx + 3} ${cy - 3}L${cx - 3} ${cy + 3}`} stroke={k.color} strokeWidth={1.6} />
                : <line x1={cx} x2={cx} y1={cy - 4} y2={cy + 4} stroke={k.color} strokeWidth={1.6} />}
            </g>
          );
        })}
        {marks.map((m, i) => (
          <g key={i}>
            <line x1={x(m.t)} x2={x(m.t)} y1={2} y2={bandY + bandH + 4} stroke="var(--c4)" strokeDasharray="3 2" />
            <text x={Math.min(x(m.t) + 3, w - 60)} y={bandY + bandH + 26} fontSize="10.5" fill="var(--c4)">{m.label}</text>
          </g>
        ))}
        <line x1={left} x2={w - right} y1={bandY + bandH + 4} y2={bandY + bandH + 4} stroke="var(--border)" />
        {axis.map((t, i) => (
          <text key={i} x={x(t)} y={bandY + bandH + 16} textAnchor={i === 0 ? "start" : i === n ? "end" : "middle"} fontSize="10" fill="var(--muted)">{`${+(t / scale).toFixed(2)} ${unit}`}</text>
        ))}
        {children}
      </svg>
    </div>
  );
}
