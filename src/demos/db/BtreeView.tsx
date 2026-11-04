/** Shared SVG renderer for small B+ trees (used by all B-tree lesson demos). */
import type { ReactNode } from "react";
import { useWidth } from "../../kit";

export interface ViewNode {
  id: number | string;
  leaf: boolean;
  keys: (number | string)[];
  kids?: ViewNode[];
  /** Extra text under the node (e.g. a page number or a high key). */
  note?: string;
}

export interface TreeViewProps {
  root: ViewNode | null;
  /** Stroke/accent color per node id. */
  color?: Map<number | string, string>;
  /** Filled background per node id (drawn with low opacity). */
  fill?: Map<number | string, string>;
  /** Highlight for single key cells: `${nodeId}:${key}` or key → color. */
  keyColor?: (nodeId: number | string, key: number | string) => string | undefined;
  /** Nodes drawn faint (not built yet, or not part of this version). */
  faint?: Set<number | string>;
  /** Draw the leaf chain. */
  chain?: boolean;
  /** Leaf chain links to emphasize: id of the left leaf → color. */
  chainColor?: Map<number | string, string>;
  /** Label above each node. */
  label?: (n: ViewNode) => string | undefined;
  /** Extra marks drawn on top, with access to node boxes. */
  overlay?: (box: (id: number | string) => Box | undefined) => ReactNode;
  cell?: number;
  levelGap?: number;
  maxScale?: number;
  /** Below this scale the view scrolls sideways instead of shrinking further. */
  minScale?: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 4;
const H = 24;

/** Lays out the tree; returns boxes by id and the natural size. */
function layout(root: ViewNode, cell: number, levelGap: number, gap: number, labelSpace: number) {
  const boxes = new Map<number | string, Box>();
  const nodeW = (n: ViewNode) => Math.max(1, n.keys.length) * cell + 2 * PAD;
  const subW = new Map<ViewNode, number>();
  const measure = (n: ViewNode): number => {
    const own = nodeW(n);
    const kids = n.kids ?? [];
    const sum = kids.reduce((a, k) => a + measure(k), 0) + Math.max(0, kids.length - 1) * gap;
    const w = Math.max(own, sum);
    subW.set(n, w);
    return w;
  };
  const total = measure(root);
  let depth = 0;
  const place = (n: ViewNode, x0: number, d: number) => {
    depth = Math.max(depth, d);
    const w = subW.get(n)!;
    const own = nodeW(n);
    const kids = n.kids ?? [];
    const sum = kids.reduce((a, k) => a + subW.get(k)!, 0) + Math.max(0, kids.length - 1) * gap;
    let x = x0 + (w - sum) / 2;
    for (const k of kids) {
      place(k, x, d + 1);
      x += subW.get(k)! + gap;
    }
    // Center over the children (or over own subtree span).
    let cx = x0 + w / 2;
    if (kids.length) {
      const a = boxes.get(kids[0]!.id)!, b = boxes.get(kids[kids.length - 1]!.id)!;
      cx = (a.x + b.x + b.w) / 2;
    }
    boxes.set(n.id, { x: cx - own / 2, y: labelSpace + d * (H + levelGap), w: own, h: H });
  };
  place(root, 0, 0);
  return { boxes, width: total, height: labelSpace + depth * (H + levelGap) + H + 14 };
}

export function TreeView({ root, color, fill, keyColor, faint, chain = true, chainColor, label, overlay, cell = 22, levelGap = 30, maxScale = 1.25, minScale = 0.62 }: TreeViewProps) {
  const [ref, w] = useWidth<HTMLDivElement>();
  if (!root) return <div ref={ref} className="muted" style={{ fontSize: 13, padding: "12px 0" }}>The tree is empty.</div>;
  const labelSpace = 0;
  const gap = label ? 30 : 10;
  const lay = layout(root, cell, levelGap, gap, labelSpace);
  const { boxes, height } = lay;
  // Side labels need room on the left of the leftmost nodes.
  const padL = label ? 22 : 0;
  const width = lay.width + padL;
  const scale = Math.max(Math.min(minScale, maxScale), Math.min(maxScale, (w - 2) / width));
  const all: ViewNode[] = [];
  const leaves: ViewNode[] = [];
  const walk = (n: ViewNode) => {
    all.push(n);
    if (n.leaf) leaves.push(n);
    n.kids?.forEach(walk);
  };
  walk(root);
  const box = (id: number | string) => boxes.get(id);
  return (
    <div ref={ref} style={{ width: "100%", overflowX: "auto" }}>
      <svg width={Math.max(10, width * scale)} height={height * scale} viewBox={`${-1 - padL} -1 ${width + 2} ${height + 2}`} style={{ display: "block", margin: "0 auto", overflow: "visible" }}>
        <defs>
          <marker id="bt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0 0L10 5L0 10z" fill="var(--muted)" />
          </marker>
        </defs>
        {/* edges */}
        {all.map((n) =>
          (n.kids ?? []).map((k, i) => {
            const a = boxes.get(n.id)!, b = boxes.get(k.id)!;
            const x1 = a.x + PAD + i * cell;
            const f = faint?.has(k.id) || faint?.has(n.id);
            const c = color?.get(k.id) && color?.get(n.id) ? color.get(k.id)! : "var(--faint)";
            return <line key={`${n.id}-${k.id}`} x1={x1} y1={a.y + a.h} x2={b.x + b.w / 2} y2={b.y} stroke={c} strokeWidth={c === "var(--faint)" ? 1 : 1.8} opacity={f ? 0.15 : 1} />;
          }),
        )}
        {/* leaf chain */}
        {chain &&
          leaves.slice(0, -1).map((l, i) => {
            const a = boxes.get(l.id)!, b = boxes.get(leaves[i + 1]!.id)!;
            const c = chainColor?.get(l.id);
            const f = faint?.has(l.id) || faint?.has(leaves[i + 1]!.id);
            if (b.x - (a.x + a.w) < 4) return null;
            return <line key={`c${l.id}`} x1={a.x + a.w + 1} y1={a.y + a.h / 2} x2={b.x - 1} y2={b.y + b.h / 2} stroke={c ?? "var(--faint)"} strokeWidth={c ? 2 : 1} markerEnd="url(#bt-arrow)" opacity={f ? 0.15 : 1} />;
          })}
        {/* nodes */}
        {all.map((n) => {
          const b = boxes.get(n.id)!;
          const c = color?.get(n.id);
          const bg = fill?.get(n.id);
          const f = faint?.has(n.id);
          const lab = label?.(n);
          return (
            <g key={n.id} opacity={f ? 0.18 : 1}>
              {lab && <text x={b.x - 3} y={b.y + b.h / 2} dy="0.34em" textAnchor="end" fontSize={9.5} style={{ fill: c ?? "var(--muted)" }}>{lab}</text>}
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={4} fill="var(--bg)" stroke={c ?? (n.leaf ? "var(--border)" : "var(--muted)")} strokeWidth={c ? 2.2 : 1} strokeDasharray={f ? "3 2" : undefined} />
              {bg && <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={4} fill={bg} opacity={0.16} />}
              {n.keys.map((k, i) => {
                const kc = keyColor?.(n.id, k);
                const x = b.x + PAD + i * cell;
                return (
                  <g key={i}>
                    {i > 0 && <line x1={x} x2={x} y1={b.y + 4} y2={b.y + b.h - 4} stroke="var(--border)" />}
                    {kc && <rect x={x + 1} y={b.y + 3} width={cell - 2} height={b.h - 6} rx={3} fill={kc} opacity={0.28} />}
                    <text x={x + cell / 2} y={b.y + b.h / 2} dy="0.34em" textAnchor="middle" fontSize={cell >= 20 ? 11 : 9.5} style={{ fill: kc ?? "var(--fg)", fontVariantNumeric: "tabular-nums" }} fontWeight={kc ? 650 : n.leaf ? 400 : 550}>
                      {k}
                    </text>
                  </g>
                );
              })}
              {n.note && <text x={b.x + b.w / 2} y={b.y + b.h + 10} textAnchor="middle" fontSize={9} style={{ fill: "var(--muted)" }}>{n.note}</text>}
            </g>
          );
        })}
        {overlay?.(box)}
      </svg>
    </div>
  );
}

export const mono = { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 } as const;

/** Small colored badge. */
export function Badge({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span style={{ display: "inline-block", padding: "0 6px", borderRadius: 4, border: `1px solid ${color}`, color, fontSize: 11.5, lineHeight: "18px", whiteSpace: "nowrap" }}>{children}</span>
  );
}
