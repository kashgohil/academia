import { useState } from "react";
import { useWidth } from "../kit";
import type { FlameNode } from "../sims/perf/profile";

const ROW = 20;

/** Warm hues from a name hash, so the same function keeps its color. */
function hue(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return 12 + (h % 34); // 12°–46°: red-orange to amber
}

function depthOf(n: FlameNode): number {
  return 1 + Math.max(0, ...n.children.map(depthOf));
}

/** Flame graph: width = time, stacked by call depth; click a frame to zoom into it. */
export function FlameGraph({ root, unit = "ms", highlight = "" }: { root: FlameNode; unit?: string; highlight?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [zoom, setZoom] = useState<string[]>([]); // path of names from root
  const [hover, setHover] = useState<{ name: string; value: number; path: string[] } | null>(null);
  const [icicle, setIcicle] = useState(false);

  // Resolve the zoomed node.
  let focus = root;
  for (const n of zoom) focus = focus.children.find((c) => c.name === n) ?? focus;
  const depth = depthOf(root);
  const h = depth * ROW;
  const total = root.value;
  const rects: { x: number; y: number; w: number; n: FlameNode; path: string[]; d: number }[] = [];

  const layout = (n: FlameNode, x: number, d: number, path: string[], scale: number) => {
    const width = n.value * scale;
    if (width < 0.5) return;
    rects.push({ x, y: icicle ? d * ROW : h - (d + 1) * ROW, w: width, n, path, d });
    let cx = x;
    for (const c of n.children) { layout(c, cx, d + 1, [...path, c.name], scale); cx += c.value * scale; }
  };
  // Ancestors of the zoom target span full width; the target and its subtree fill the width.
  let cur = root;
  const ancestors = [root];
  for (const n of zoom) { const nx = cur.children.find((c) => c.name === n); if (!nx) break; cur = nx; ancestors.push(cur); }
  ancestors.slice(0, -1).forEach((a, d) => rects.push({ x: 0, y: icicle ? d * ROW : h - (d + 1) * ROW, w, n: a, path: zoom.slice(0, d), d }));
  layout(focus, 0, ancestors.length - 1, zoom, w / focus.value);

  return (
    <div ref={ref}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 6, fontSize: 12.5 }}>
        <span className="muted">{zoom.length ? <>Zoomed to <b>{zoom.at(-1)}</b>. Click the bottom frames to zoom out.</> : "Click a frame to zoom in."}</span>
        <span className="row">
          {zoom.length > 0 && <button className="btn" style={{ padding: "1px 8px" }} onClick={() => setZoom([])}>Reset zoom</button>}
          <button className="btn" style={{ padding: "1px 8px" }} onClick={() => setIcicle((x) => !x)}>{icicle ? "Flame (root at bottom)" : "Icicle (root at top)"}</button>
        </span>
      </div>
      <svg width={w} height={h} style={{ display: "block", fontFamily: "inherit" }}>
        {rects.map((r, i) => {
          const match = highlight && r.n.name.includes(highlight);
          return (
            <g key={i} onClick={() => setZoom(r.path)} onMouseEnter={() => setHover({ name: r.n.name, value: r.n.value, path: r.path })} onMouseLeave={() => setHover(null)} style={{ cursor: "pointer" }}>
              <rect x={r.x + 0.5} y={r.y + 0.5} width={Math.max(0, r.w - 1)} height={ROW - 1} rx={2} fill={match ? "var(--c5)" : `hsl(${hue(r.n.name)} 75% 62%)`} opacity={hover && hover.name !== r.n.name ? 0.85 : 1} />
              {r.w > 40 && (
                <text x={r.x + 5} y={r.y + 14} fontSize={11} fill="#1a1a1a" style={{ pointerEvents: "none" }}>
                  {r.n.name.length * 6.2 > r.w - 8 ? r.n.name.slice(0, Math.max(1, Math.floor((r.w - 14) / 6.2))) + "…" : r.n.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="muted" style={{ fontSize: 12, minHeight: 18, marginTop: 4 }}>
        {hover ? `${hover.name}: ${hover.value.toFixed(0)} ${unit} (${((100 * hover.value) / total).toFixed(1)}% of total)` : "Hover a frame for its time."}
      </div>
    </div>
  );
}
