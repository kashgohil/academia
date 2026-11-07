/**
 * Views shared by the network-layer demos: a clickable topology (routers, ASes, links that can be cut), and a row of
 * address bits split into network and host parts.
 */
import type { ReactNode } from "react";
import { MONO, useWidth } from "../../kit";

export interface TopoNode {
  id: number;
  label: string;
  x: number;
  y: number;
  /** Ring color. */
  color?: string;
  /** Fill tint color. */
  fill?: string;
  /** A small line under the node. */
  sub?: string;
  /** Draw as a rounded square (a host) instead of a circle (a router). */
  square?: boolean;
  bold?: boolean;
}

export interface TopoLink {
  a: number;
  b: number;
  label?: string;
  color?: string;
  dashed?: boolean;
  width?: number;
  /** Faint: down or not in use. */
  faint?: boolean;
  /** An arrow from a to b in the middle of the link. */
  arrow?: boolean;
}

export function TopoView({
  nodes, links, height = 220, r = 17, onNode, onLink, children,
}: {
  nodes: TopoNode[];
  links: TopoLink[];
  height?: number;
  r?: number;
  onNode?: (id: number) => void;
  onLink?: (i: number) => void;
  children?: ReactNode;
}) {
  const [ref, w0] = useWidth<HTMLDivElement>();
  const w = Math.max(280, w0);
  const pad = r + 6;
  const px = (x: number) => pad + x * (w - 2 * pad);
  const py = (y: number) => pad + y * (height - 2 * pad - 10);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} role="img" aria-label="network topology" style={{ display: "block" }}>
        <defs>
          <marker id="netip-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L10 5L0 10z" fill="context-stroke" />
          </marker>
        </defs>
        {links.map((l, i) => {
          const a = byId.get(l.a), b = byId.get(l.b);
          if (!a || !b) return null;
          const x1 = px(a.x), y1 = py(a.y), x2 = px(b.x), y2 = py(b.y);
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          const c = l.color ?? "var(--faint)";
          return (
            <g key={i} onClick={onLink ? () => onLink(i) : undefined} style={{ cursor: onLink ? "pointer" : undefined }} opacity={l.faint ? 0.35 : 1}>
              {onLink && <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={16} />}
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={l.width ?? 1.6} strokeDasharray={l.dashed ? "5 4" : undefined} />
              {l.arrow && <line x1={mx - (x2 - x1) * 0.02} y1={my - (y2 - y1) * 0.02} x2={mx + (x2 - x1) * 0.02} y2={my + (y2 - y1) * 0.02} stroke={c} strokeWidth={l.width ?? 1.6} markerEnd="url(#netip-arrow)" />}
              {l.label && (
                <text x={mx} y={my - 5} textAnchor="middle" fontSize="10.5" fill="var(--muted)" style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}>{l.label}</text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const x = px(n.x), y = py(n.y);
          const c = n.color ?? "var(--fg)";
          const fill = n.fill ? `color-mix(in srgb, ${n.fill} 22%, var(--bg))` : "var(--bg)";
          return (
            <g key={n.id} transform={`translate(${x},${y})`} onClick={onNode ? () => onNode(n.id) : undefined} style={{ cursor: onNode ? "pointer" : undefined }}>
              {n.square
                ? <rect x={-r} y={-r * 0.8} width={2 * r} height={1.6 * r} rx={4} fill={fill} stroke={c} strokeWidth={n.bold ? 2.2 : 1.3} />
                : <circle r={r} fill={fill} stroke={c} strokeWidth={n.bold ? 2.2 : 1.3} />}
              <text textAnchor="middle" dy="0.34em" fontSize={n.label.length > 3 ? 10.5 : 12} fill="var(--fg)" fontWeight={n.bold ? 600 : 400}>{n.label}</text>
              {n.sub && <text textAnchor="middle" y={r + 11} fontSize="10" fill="var(--muted)" style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}>{n.sub}</text>}
            </g>
          );
        })}
        {children}
      </svg>
    </div>
  );
}

/** 32 address bits in four octets; the first `len` bits are the network part. */
export function AddressBits({ addr, len, highlight }: { addr: number; len: number; highlight?: number }) {
  const bits = Array.from({ length: 32 }, (_, i) => (addr >>> (31 - i)) & 1);
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontFamily: MONO, fontSize: 12.5 }}>
      {[0, 1, 2, 3].map((o) => (
        <div key={o} style={{ display: "flex" }}>
          {bits.slice(o * 8, o * 8 + 8).map((b, j) => {
            const i = o * 8 + j;
            const net = i < len;
            return (
              <span key={j} style={{
                width: 13, textAlign: "center", lineHeight: "20px",
                background: net ? "color-mix(in srgb, var(--c1) 22%, var(--bg))" : "color-mix(in srgb, var(--c2) 14%, var(--bg))",
                borderBottom: `2px solid ${net ? "var(--c1)" : "var(--c2)"}`,
                outline: highlight === i ? "1.5px solid var(--fg)" : undefined,
                color: "var(--fg)",
              }}>{b}</span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
