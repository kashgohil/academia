/** Shared pieces for the transaction demos: colors, a frame stepper with a slider, captions, a small digraph. */
import { Arrow } from "../../kit";

/** Transaction colors: T1 blue, T2 orange, T3 purple, T4 grey. Green and red mean good and bad. */
export const TC = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--muted)"];
export const tcol = (t: number) => TC[t % TC.length]!;








export interface DNode { id: number; label: string; color: string; ring?: string; sub?: string; faded?: boolean }
export interface DEdge { from: number; to: number; label?: string; color?: string; dash?: string; width?: number }

/**
 * A small directed graph with nodes on a circle. Edges in both directions between two nodes curve apart.
 * Several edges between the same ordered pair share one arrow and join their labels.
 */
export function Digraph({ nodes, edges, id, size = 220, r = 20 }: { nodes: DNode[]; edges: DEdge[]; id: string; size?: number; r?: number }) {
  const n = nodes.length;
  const H = n === 2 ? Math.round(size * 0.55) : size;
  const C = size / 2, R = n <= 1 ? 0 : n === 2 ? size * 0.32 : size * 0.33;
  const pos = new Map(nodes.map((nd, k) => {
    const a = n === 2 ? Math.PI * (1 - k) : -Math.PI / 2 + (2 * Math.PI * k) / n;
    return [nd.id, [C + R * Math.cos(a), (n === 2 ? H / 2 - 6 : C) + R * Math.sin(a) * (n === 2 ? 1 : 0.92)] as const];
  }));
  const merged = new Map<string, DEdge & { labels: string[] }>();
  for (const e of edges) {
    const k = `${e.from}>${e.to}>${e.color ?? ""}`;
    const m = merged.get(k);
    if (m) { if (e.label && !m.labels.includes(e.label)) m.labels.push(e.label); }
    else merged.set(k, { ...e, labels: e.label ? [e.label] : [] });
  }
  const list = [...merged.values()];
  const colors = [...new Set(list.map((e) => e.color ?? "var(--muted)"))];
  const mk = (c: string) => `${id}-m${colors.indexOf(c)}`;
  return (
    <svg viewBox={`0 0 ${size} ${H}`} style={{ width: "100%", maxWidth: size + 40, display: "block", margin: "0 auto" }}>
      <defs>{colors.map((c) => <Arrow key={c} id={mk(c)} color={c} />)}</defs>
      {list.map((e, k) => {
        const a = pos.get(e.from), b = pos.get(e.to);
        if (!a || !b) return null;
        const both = list.some((x) => x.from === e.to && x.to === e.from);
        const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
        const ux = dx / d, uy = dy / d, nx = -uy, ny = ux;
        const bend = both ? 22 : 0;
        const mx = (a[0] + b[0]) / 2 + nx * bend, my = (a[1] + b[1]) / 2 + ny * bend;
        const sx = a[0] + ux * r + nx * (both ? 6 : 0), sy = a[1] + uy * r + ny * (both ? 6 : 0);
        const ex = b[0] - ux * (r + 2) + nx * (both ? 6 : 0), ey = b[1] - uy * (r + 2) + ny * (both ? 6 : 0);
        const c = e.color ?? "var(--muted)";
        return (
          <g key={k}>
            <path d={`M${sx} ${sy} Q${mx} ${my} ${ex} ${ey}`} fill="none" stroke={c} strokeWidth={e.width ?? 1.6} strokeDasharray={e.dash} markerEnd={`url(#${mk(c)})`} />
            {e.labels.length > 0 && (
              <text x={mx + nx * 8} y={my + ny * 8} fontSize={10.5} textAnchor="middle" dominantBaseline="middle" fill={c} style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}>{e.labels.join(", ")}</text>
            )}
          </g>
        );
      })}
      {nodes.map((nd) => {
        const [x, y] = pos.get(nd.id)!;
        return (
          <g key={nd.id} opacity={nd.faded ? 0.4 : 1}>
            {nd.ring && <circle cx={x} cy={y} r={r + 4} fill="none" stroke={nd.ring} strokeWidth={2.5} />}
            <circle cx={x} cy={y} r={r} fill="var(--bg)" stroke={nd.color} strokeWidth={2} />
            <text x={x} y={y} fontSize={12} fontWeight={700} textAnchor="middle" dominantBaseline="central" fill={nd.color}>{nd.label}</text>
            {nd.sub && <text x={x} y={y + r + 12} fontSize={10} textAnchor="middle" fill="var(--muted)">{nd.sub}</text>}
          </g>
        );
      })}
    </svg>
  );
}

