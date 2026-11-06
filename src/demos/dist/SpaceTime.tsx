/**
 * A space-time diagram: one horizontal line per node, time to the right, an arrow per message.
 * Every distributed-systems demo draws its runs with this, so that all lessons read the same way.
 * Pass the messages and marks of a run from src/sims/dist/net.ts, or build them by hand.
 */
import type { ReactNode } from "react";
import { useWidth } from "../../kit";
import type { Message, Net } from "../../sims/dist/net";

export interface StMessage {
  from: number;
  to: number;
  sentAt: number;
  /** Undefined: lost. */
  deliveredAt?: number;
  /** For a lost message: the time it reached a dead or cut-off receiver. The arrow reaches that node and ends in a
   *  cross. Without it, the message was dropped in the network: the arrow stops short. */
  lostAt?: number;
  label?: string;
  color?: string;
  dashed?: boolean;
}

export interface StMark {
  node: number;
  t: number;
  label?: string;
  color?: string;
  /** dot: an event; bar: a span of time from t to `until`, such as a lease or a crash. */
  shape?: "dot" | "bar" | "cross";
  until?: number;
}

export function SpaceTime({
  nodes,
  tEnd,
  messages = [],
  marks = [],
  cursor,
  tStart = 0,
  rowHeight = 46,
  timeLabel = "time (ms)",
  children,
}: {
  nodes: string[];
  tEnd: number;
  tStart?: number;
  messages?: StMessage[];
  marks?: StMark[];
  /** Events after this time are drawn faint, so a stepper can reveal a run. */
  cursor?: number;
  rowHeight?: number;
  timeLabel?: string;
  children?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const left = 54, right = 14, top = 4;
  const w = Math.max(240, width);
  const h = top + nodes.length * rowHeight + 22;
  const x = (t: number) => left + ((t - tStart) / Math.max(1e-9, tEnd - tStart)) * (w - left - right);
  const y = (i: number) => top + i * rowHeight + rowHeight / 2;
  const faint = (t: number) => (cursor !== undefined && t > cursor ? 0.18 : 1);
  const ticks = Array.from({ length: 6 }, (_, i) => tStart + ((tEnd - tStart) * i) / 5);

  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="space-time diagram" style={{ display: "block", overflow: "visible" }}>
        <defs>
          <marker id="st-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="context-stroke" />
          </marker>
        </defs>
        {nodes.map((name, i) => (
          <g key={i}>
            <text x={left - 10} y={y(i) + 4} textAnchor="end" fontSize="12" fill="var(--muted)">{name}</text>
            <line x1={left} x2={w - right} y1={y(i)} y2={y(i)} stroke="var(--border)" strokeWidth="1.5" />
          </g>
        ))}
        {marks.filter((m) => m.shape === "bar").map((m, i) => (
          <g key={`b${i}`} opacity={faint(m.t)}>
            <rect x={x(m.t)} y={y(m.node) - 6} width={Math.max(1, x(m.until ?? m.t) - x(m.t))} height={12} rx={3} fill={m.color ?? "var(--c2)"} opacity={0.25} />
            {m.label && <text x={x(m.t) + 4} y={y(m.node) - 10} fontSize="10.5" fill={m.color ?? "var(--c2)"}>{m.label}</text>}
          </g>
        ))}
        {messages.map((m, i) => {
          const x1 = x(m.sentAt), y1 = y(m.from);
          const lost = m.deliveredAt === undefined;
          const atReceiver = lost && m.lostAt !== undefined && m.lostAt > m.sentAt;
          const tEndArrow = !lost ? m.deliveredAt! : atReceiver ? m.lostAt! : m.sentAt + (tEnd - tStart) * 0.04;
          const x2 = x(tEndArrow), y2 = !lost || atReceiver ? y(m.to) : y1 + (y(m.to) - y1) * 0.35;
          const c = m.color ?? (lost ? "var(--c4)" : "var(--fg)");
          return (
            <g key={`m${i}`} opacity={faint(m.sentAt)}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth="1.4" strokeDasharray={m.dashed || lost ? "4 3" : undefined} markerEnd={lost ? undefined : "url(#st-arrow)"} />
              {lost && <path d={`M${x2 - 4} ${y2 - 4}l8 8m0 -8l-8 8`} stroke={c} strokeWidth="1.6" />}
              {m.label && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} textAnchor="middle" fontSize="10.5" fill={c} style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}>{m.label}</text>
              )}
            </g>
          );
        })}
        {marks.filter((m) => m.shape !== "bar").map((m, i) => (
          <g key={`k${i}`} opacity={faint(m.t)}>
            {m.shape === "cross" ? (
              <path d={`M${x(m.t) - 5} ${y(m.node) - 5}l10 10m0 -10l-10 10`} stroke={m.color ?? "var(--c4)"} strokeWidth="2" />
            ) : (
              <circle cx={x(m.t)} cy={y(m.node)} r={4} fill={m.color ?? "var(--c1)"} />
            )}
            {m.label && <text x={x(m.t)} y={y(m.node) + 17} textAnchor="middle" fontSize="10.5" fill={m.color ?? "var(--muted)"}>{m.label}</text>}
          </g>
        ))}
        {cursor !== undefined && <line x1={x(cursor)} x2={x(cursor)} y1={top - 4} y2={h - 18} stroke="var(--c1)" strokeWidth="1" strokeDasharray="2 3" />}
        {ticks.map((t, i) => (
          <text key={`t${i}`} x={x(t)} y={h - 4} textAnchor="middle" fontSize="10" fill="var(--faint)">{Math.round(t)}</text>
        ))}
        <text x={w - right} y={h - 4} textAnchor="end" fontSize="10" fill="var(--faint)" dy={-12}>{timeLabel}</text>
      </svg>
      {children}
    </div>
  );
}

/** Turns a Net run into SpaceTime props: every message, and crashes as crosses. */
export function fromTrace<P>(net: Net<P>, label?: (m: Message<P>) => string | undefined): { messages: StMessage[]; marks: StMark[] } {
  return {
    messages: net.messages.map((m) => ({ from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost === "dropped" ? undefined : m.lostAt, label: label?.(m) })),
    marks: net.trace.flatMap((e) => (e.kind === "crash" ? [{ node: e.node, t: e.t, shape: "cross" as const }] : [])),
  };
}
