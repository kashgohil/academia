/** Shared pieces for the transaction demos: colors, a frame stepper with a slider, captions, a small digraph. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Param, range } from "../../kit";

/** Transaction colors: T1 blue, T2 orange, T3 purple, T4 grey. Green and red mean good and bad. */
export const TC = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--muted)"];
export const tcol = (t: number) => TC[t % TC.length]!;
export const GOOD = "var(--c3)";
export const BAD = "var(--c4)";
export const MONO = "ui-monospace, Menlo, monospace";

/** Index into a list of frames, with play, back, step and a slider. */
export function useStepper(n: number, fps = 1.5) {
  const [i, setI] = useState(0);
  const [running, setRunning] = useState(false);
  const last = Math.max(0, n - 1);
  const cur = Math.min(i, last);
  const ref = useRef(cur);
  ref.current = cur;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      if (ref.current >= last) { setRunning(false); return; }
      setI(ref.current + 1);
    }, 1000 / fps);
    return () => window.clearInterval(id);
  }, [running, last, fps]);
  return {
    i: cur,
    n,
    atEnd: cur >= last,
    running,
    go: (j: number) => { setRunning(false); setI(Math.max(0, Math.min(last, j))); },
    toggle: () => { if (cur >= last && !running) setI(0); setRunning((r) => !r); },
  };
}
export type Stepper = ReturnType<typeof useStepper>;

export function StepButtons({ s }: { s: Stepper }) {
  return (
    <>
      <button className="btn" onClick={s.toggle}>{s.running ? "Pause" : s.atEnd ? "Replay" : "Play"}</button>
      <button className="btn" onClick={() => s.go(s.i - 1)} disabled={s.i === 0}>Back</button>
      <button className="btn" onClick={() => s.go(s.i + 1)} disabled={s.atEnd}>Step</button>
    </>
  );
}

/** A range slider over the frames (also the control that the smoke test moves). */
export function StepSlider({ s, label = "Step" }: { s: Stepper; label?: string }) {
  return <Param spec={range({ label, min: 0, max: Math.max(1, s.n - 1), step: 1, default: 0, format: (v) => `${v} of ${s.n - 1}` })} value={s.i} onChange={(v) => s.go(v as number)} />;
}

export function Caption({ children, tone, label }: { children: ReactNode; tone?: "good" | "bad" | null; label?: ReactNode }) {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.45, minHeight: 42, padding: "8px 10px 8px 13px", marginTop: 10, background: "var(--subtle)", borderRadius: 6, border: "1px solid var(--border)", boxShadow: `inset 3px 0 0 ${tone === "bad" ? BAD : tone === "good" ? GOOD : "var(--border)"}` }}>
      {label !== undefined && <span className="muted" style={{ fontSize: 11.5, marginRight: 8, fontVariantNumeric: "tabular-nums" }}>{label}</span>}
      {children}
    </div>
  );
}

export function Chip({ children, color = "var(--fg)", filled, dashed, strike, title, onClick, bold }: { children: ReactNode; color?: string; filled?: boolean; dashed?: boolean; strike?: boolean; title?: string; onClick?: () => void; bold?: boolean }) {
  return (
    <span
      title={title}
      onClick={onClick}
      style={{
        display: "inline-block", fontFamily: MONO, fontSize: 12, lineHeight: "18px", padding: "1px 6px", borderRadius: 4,
        border: `1.5px ${dashed ? "dashed" : "solid"} ${color}`, background: filled ? color : "var(--bg)", color: filled ? "var(--bg)" : color,
        textDecoration: strike ? "line-through" : undefined, cursor: onClick ? "pointer" : undefined, whiteSpace: "nowrap", fontWeight: bold ? 700 : 400,
        transition: "background 0.2s, color 0.2s",
      }}
    >
      {children}
    </span>
  );
}

export function Panel({ title, children, accent }: { title: ReactNode; children: ReactNode; accent?: string }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", boxShadow: accent ? `inset 0 3px 0 ${accent}` : undefined, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

export const Arrow = ({ id, color = "var(--muted)" }: { id: string; color?: string }) => (
  <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M0 0L10 5L0 10z" fill={color} />
  </marker>
);

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

/** Runs `work(i)` for i = 0..n-1 in small time slices, so a heavy sweep never blocks a render. */
export function useChunked<T>(n: number, work: (i: number) => T, deps: unknown[]): (T | undefined)[] {
  const [out, setOut] = useState<(T | undefined)[]>(() => Array(n).fill(undefined));
  useEffect(() => {
    let cancelled = false;
    const acc: (T | undefined)[] = Array(n).fill(undefined);
    setOut([...acc]);
    let i = 0;
    const tick = () => {
      if (cancelled) return;
      const t0 = performance.now();
      while (i < n && performance.now() - t0 < 30) { acc[i] = work(i); i++; }
      setOut([...acc]);
      if (i < n) window.setTimeout(tick, 0);
    };
    const id = window.setTimeout(tick, 0);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return out;
}
