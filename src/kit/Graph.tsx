import { useWidth } from "./useSize";

export interface GNode { id: string; x: number; y: number; label?: string; color?: string }
export interface GEdge { from: string; to: string; label?: string; directed?: boolean; color?: string }

/** Node–edge diagram in a unit coordinate space (x, y ∈ [0, 1]). */
export function Graph({ nodes, edges, height = 240, r = 16 }: { nodes: GNode[]; edges: GEdge[]; height?: number; r?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const pad = r + 4;
  const px = (x: number) => pad + x * (w - 2 * pad);
  const py = (y: number) => pad + y * (height - 2 * pad);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <div ref={ref}>
      <svg width={w} height={height} className="plot" style={{ display: "block" }}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--faint)" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const a = byId.get(e.from), b = byId.get(e.to);
          if (!a || !b) return null;
          const x1 = px(a.x), y1 = py(a.y), x2 = px(b.x), y2 = py(b.y);
          const d = Math.hypot(x2 - x1, y2 - y1) || 1;
          const ux = (x2 - x1) / d, uy = (y2 - y1) / d;
          return (
            <g key={i}>
              <line x1={x1 + ux * r} y1={y1 + uy * r} x2={x2 - ux * r} y2={y2 - uy * r} stroke={e.color ?? "var(--faint)"} markerEnd={e.directed ? "url(#arrow)" : undefined} />
              {e.label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} textAnchor="middle">{e.label}</text>}
            </g>
          );
        })}
        {nodes.map((n) => (
          <g key={n.id} transform={`translate(${px(n.x)},${py(n.y)})`}>
            <circle r={r} fill="var(--bg)" stroke={n.color ?? "var(--fg)"} />
            <text textAnchor="middle" dy="0.32em" style={{ fill: "var(--fg)" }}>{n.label ?? n.id}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
