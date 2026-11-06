/** Views that the Consistency demos share: a history timeline (editable or not) and verdict chips. */
import { useRef, type ReactNode } from "react";
import { BAD, Chip, GOOD, MONO, useWidth } from "../../kit";
import { opLabel, type HOp } from "../../sims/dist/consistency";

export const CLIENT_COLORS = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--muted)"];
export const clientColor = (lane: number) => CLIENT_COLORS[lane % CLIENT_COLORS.length]!;

export type OpMark = "bad" | "current" | "rejected" | "placed" | "faint";

export interface HistoryViewProps {
  ops: HOp[];
  tEnd: number;
  tStart?: number;
  /** Client ids in display order. Default: all clients, sorted. */
  lanes?: number[];
  laneName?: (client: number, lane: number) => string;
  /** Linearization points to draw, and the order to number them by. */
  points?: Map<number, number>;
  order?: number[];
  marks?: Map<number, OpMark>;
  /** Show the key in labels (for multi-key histories). */
  keys?: boolean;
  selected?: number | null;
  onSelect?: (id: number) => void;
  /** Called while an operation is dragged; "move" keeps its length, "call"/"ret" moves one end. */
  onDrag?: (id: number, call: number, ret: number) => void;
  rowHeight?: number;
  timeLabel?: string;
  children?: ReactNode;
}

const MARK_COLOR: Record<OpMark, string> = { bad: BAD, current: "var(--fg)", rejected: BAD, placed: GOOD, faint: "var(--faint)" };

/** One lane per client, one bar per operation from its invocation to its response. */
export function HistoryView({ ops, tEnd, tStart = 0, lanes, laneName, points, order, marks, keys, selected, onSelect, onDrag, rowHeight = 44, timeLabel = "time", children }: HistoryViewProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const laneIds = lanes ?? [...new Set(ops.map((o) => o.client))].sort((a, b) => a - b);
  const left = 34, right = 10, top = 6;
  const w = Math.max(260, width);
  const h = top + laneIds.length * rowHeight + 18;
  const span = Math.max(1e-9, tEnd - tStart);
  const x = (t: number) => left + ((Math.min(t, tEnd) - tStart) / span) * (w - left - right);
  const yOf = (c: number) => top + laneIds.indexOf(c) * rowHeight;
  const drag = useRef<{ id: number; mode: "move" | "call" | "ret"; x0: number; call: number; ret: number } | null>(null);
  const pxToT = span / (w - left - right);

  const down = (e: React.PointerEvent, o: HOp) => {
    onSelect?.(o.id);
    if (!onDrag) return;
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!;
    const pt = svg.getBoundingClientRect();
    const scale = w / pt.width;
    const px = (e.clientX - pt.left) * scale;
    const x1 = x(o.call), x2 = x(Number.isFinite(o.ret) ? o.ret : tEnd);
    const mode = x2 - x1 > 26 && px - x1 < 10 ? "call" : x2 - x1 > 26 && x2 - px < 10 ? "ret" : "move";
    drag.current = { id: o.id, mode, x0: e.clientX * scale, call: o.call, ret: o.ret };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !onDrag) return;
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!;
    const scale = w / svg.getBoundingClientRect().width;
    const dt = Math.round((e.clientX * scale - d.x0) * pxToT);
    if (d.mode === "move") onDrag(d.id, d.call + dt, d.ret + dt);
    else if (d.mode === "call") onDrag(d.id, Math.min(d.call + dt, d.ret - 2), d.ret);
    else onDrag(d.id, d.call, Math.max(d.ret + dt, d.call + 2));
  };
  const up = () => (drag.current = null);

  const ordered = order?.filter((id) => points?.has(id)) ?? [];
  const byId = new Map(ops.map((o) => [o.id, o]));
  const barY = (o: HOp) => yOf(o.client) + rowHeight / 2 - 3;
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="history of operations" style={{ display: "block", overflow: "visible", userSelect: "none" }}>
        {laneIds.map((c, i) => (
          <g key={c}>
            <text x={2} y={yOf(c) + rowHeight / 2 + 5} fontSize="12" fontWeight={600} fill={clientColor(i)}>{laneName ? laneName(c, i) : `C${c + 1}`}</text>
            <line x1={left} x2={w - right} y1={yOf(c) + rowHeight / 2 + 6} y2={yOf(c) + rowHeight / 2 + 6} stroke="var(--border)" strokeDasharray="2 4" />
          </g>
        ))}
        {ops.map((o) => {
          const lane = laneIds.indexOf(o.client);
          if (lane < 0) return null;
          const pending = !Number.isFinite(o.ret);
          const x1 = x(o.call), x2 = x(pending ? tEnd : o.ret);
          const mk = marks?.get(o.id);
          const col = mk && mk !== "placed" ? MARK_COLOR[mk] : clientColor(lane);
          const y = barY(o);
          const sel = selected === o.id;
          return (
            <g key={o.id} opacity={mk === "faint" ? 0.35 : 1}>
              <rect
                x={x1} y={y} width={Math.max(4, x2 - x1)} height={12} rx={3}
                fill={mk === "placed" ? tint2(col) : "var(--bg)"} stroke={col} strokeWidth={sel || mk === "current" || mk === "bad" ? 2.6 : 1.6}
                strokeDasharray={pending ? "4 3" : mk === "rejected" ? "3 2" : undefined}
                style={{ cursor: onDrag ? "grab" : onSelect ? "pointer" : undefined, touchAction: onDrag ? "none" : undefined }}
                onPointerDown={(e) => down(e, o)} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
              />
              {onDrag && !pending && x2 - x1 > 26 && (
                <>
                  <line x1={x1 + 3} x2={x1 + 3} y1={y + 3} y2={y + 9} stroke={col} strokeWidth={1.4} pointerEvents="none" />
                  <line x1={x2 - 3} x2={x2 - 3} y1={y + 3} y2={y + 9} stroke={col} strokeWidth={1.4} pointerEvents="none" />
                </>
              )}
              <text x={(x1 + x2) / 2} y={y - 4} textAnchor="middle" fontSize="11" fontFamily={MONO} fill={mk === "bad" || mk === "rejected" ? BAD : "var(--fg)"} pointerEvents="none" style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}>
                {!keys && x2 - x1 < 44 ? (o.f === "w" ? `w${o.value}` : o.f === "r" ? `r${o.value ?? "?"}` : "cas") : opLabel(o, !!keys).replace(/\(\)/, "").replace(/^w\((\d+)\)$/, "w $1").replace(/^r=/, "r → ")}
              </text>
            </g>
          );
        })}
        {ordered.length > 1 && (
          <polyline points={ordered.map((id) => `${x(points!.get(id)!)},${barY(byId.get(id)!) + 6}`).join(" ")} fill="none" stroke="var(--fg)" strokeOpacity={0.45} strokeWidth={1.2} />
        )}
        {ordered.map((id, k) => {
          const o = byId.get(id)!;
          const px = x(points!.get(id)!), py = barY(o) + 6;
          return (
            <g key={`p${id}`} pointerEvents="none">
              <circle cx={px} cy={py} r={4.5} fill="var(--fg)" />
              <text x={px} y={py + 18} textAnchor="middle" fontSize="10" fill="var(--muted)" fontFamily={MONO}>{k + 1}</text>
            </g>
          );
        })}
        <text x={w - right} y={h - 2} textAnchor="end" fontSize="10" fill="var(--faint)">{timeLabel} →</text>
      </svg>
      {children}
    </div>
  );
}

const tint2 = (c: string) => `color-mix(in srgb, ${c} 22%, var(--bg))`;

/** A small allowed or forbidden mark. */
export const Verdict = ({ ok, children }: { ok: boolean; children?: ReactNode }) => (
  <Chip color={ok ? GOOD : BAD} filled={!ok}>{children ?? (ok ? "allowed" : "forbidden")}</Chip>
);
