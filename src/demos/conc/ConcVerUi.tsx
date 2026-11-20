/** Views shared by the verification demos: a history of operations as bars, with optional draggable points. */
import { useRef, type PointerEvent as RPointerEvent } from "react";
import { MONO, useWidth } from "../../kit";
import { opLabel, type HistOp } from "../../sims/conc/verification";
import { threadColor } from "./ConcViews";

export interface HistoryViewProps {
  ops: HistOp[];
  threads: number;
  names?: string[];
  /** Time range of the axis. */
  t0: number;
  t1: number;
  /** One point per op id (a linearization point). */
  points?: Record<number, number>;
  /** Called while a point is dragged. Without it, points are fixed. */
  onDrag?: (id: number, t: number) => void;
  /** A color for the edge of each bar, by op id (for example red for the op that broke the order). */
  mark?: Record<number, string>;
  /** Small ticks on bars: [op id, time, label]. */
  ticks?: [number, number, string][];
  withObj?: boolean;
  /** Draw ops whose return is Infinity up to this time, with an open end. */
  now?: number;
  axisLabel?: string;
}

const ROW = 46;
const LEFT = 30;

/** Bars for operations, one row per thread. Drag a dot along its bar to move a linearization point. */
export function HistoryView({ ops, threads, names, t0, t1, points, onDrag, mark, ticks, withObj, now, axisLabel }: HistoryViewProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const w = Math.max(200, width);
  const x = (t: number) => LEFT + ((t - t0) / (t1 - t0)) * (w - LEFT - 10);
  const h = threads * ROW + 22;
  const toT = (e: RPointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return t0 + ((e.clientX - r.left - LEFT) / (w - LEFT - 10)) * (t1 - t0);
  };
  const move = (e: RPointerEvent) => {
    if (drag.current === null || !onDrag) return;
    const op = ops.find((o) => o.id === drag.current)!;
    const span = op.ret - op.call;
    onDrag(op.id, Math.max(op.call + span * 0.02, Math.min(op.ret - span * 0.02, toT(e))));
  };
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg ref={svgRef} width={w} height={h} style={{ display: "block", touchAction: onDrag ? "none" : undefined }} onPointerMove={move} onPointerUp={() => (drag.current = null)} onPointerLeave={() => (drag.current = null)}>
        {Array.from({ length: threads }, (_, t) => (
          <g key={t}>
            <text x={2} y={t * ROW + 33} fontSize={11} fontFamily={MONO} fill="var(--muted)">{names?.[t] ?? `T${t}`}</text>
            <line x1={LEFT} x2={w - 10} y1={t * ROW + 29} y2={t * ROW + 29} stroke="var(--border)" strokeDasharray="2 3" />
          </g>
        ))}
        {ops.map((o) => {
          const y = o.thread * ROW + 22;
          const open = o.ret === Infinity;
          const xa = x(o.call), xb = x(open ? (now ?? t1) : o.ret);
          const c = threadColor(o.thread);
          const edge = mark?.[o.id];
          return (
            <g key={o.id}>
              <rect x={xa} y={y} width={Math.max(3, xb - xa)} height={14} rx={3} fill={`color-mix(in srgb, ${c} 28%, var(--bg))`} stroke={edge ?? c} strokeWidth={edge ? 2.2 : 1.2} strokeDasharray={open ? "4 2" : undefined} />
              <text x={xa + 1} y={y - 4} fontSize={11} fontFamily={MONO} fill="var(--fg)">{opLabel(o, withObj)}{open ? " …" : ""}</text>
            </g>
          );
        })}
        {ticks?.map(([id, t, label], i) => {
          const o = ops.find((p) => p.id === id);
          if (!o) return null;
          const y = o.thread * ROW + 22;
          return (
            <g key={`k${i}`}>
              <line x1={x(t)} x2={x(t)} y1={y - 1} y2={y + 15} stroke="var(--fg)" strokeWidth={1.6} />
              <text x={x(t)} y={y + 25} fontSize={9.5} textAnchor="middle" fill="var(--muted)">{label}</text>
            </g>
          );
        })}
        {points && ops.map((o) => {
          const p = points[o.id];
          if (p === undefined) return null;
          const y = o.thread * ROW + 29;
          return (
            <g key={`p${o.id}`} style={{ cursor: onDrag ? "ew-resize" : undefined }} onPointerDown={(e) => { if (!onDrag) return; drag.current = o.id; (e.target as Element).setPointerCapture?.(e.pointerId); }}>
              {onDrag && <circle cx={x(p)} cy={y} r={14} fill="transparent" />}
              <circle cx={x(p)} cy={y} r={6} fill={mark?.[o.id] ?? "var(--fg)"} stroke="var(--bg)" strokeWidth={1.5} />
            </g>
          );
        })}
        {axisLabel && <text x={w - 10} y={h - 2} fontSize={10.5} textAnchor="end" fill="var(--muted)">{axisLabel}</text>}
      </svg>
    </div>
  );
}
