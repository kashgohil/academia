/** Small shared pieces for the locks module demos (prefix ConcLock). */
import type { ReactNode } from "react";
import { Canvas2D, cssVar, MONO } from "../../kit";
import { threadColor } from "./ConcViews";

/** A duration in ns as a short string: 820 ns, 5.4 µs, 1.03 ms. */
export function dur(ns: number): string {
  if (!Number.isFinite(ns)) return "∞";
  if (ns < 1_000) return `${Math.round(ns)} ns`;
  if (ns < 1_000_000) return `${Number((ns / 1_000).toPrecision(3))} µs`;
  return `${Number((ns / 1_000_000).toPrecision(3))} ms`;
}

/** A labelled box that holds one value of shared state. */
export function Field({ name, value, on, note }: { name: string; value: ReactNode; on?: boolean; note?: ReactNode }) {
  return (
    <div style={{ minWidth: 64, textAlign: "center" }}>
      <div className="muted" style={{ fontSize: 11, fontFamily: MONO, marginBottom: 2 }}>{name}</div>
      <div style={{ border: `1.5px solid ${on ? "var(--c2)" : "var(--border)"}`, background: on ? "var(--subtle)" : "var(--bg)", borderRadius: 5, padding: "3px 8px", fontFamily: MONO, fontSize: 14, fontWeight: 600 }}>{value}</div>
      {note && <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>{children}</div>;
}

/**
 * Who owned a lock over time: one row per thread, a mark where the thread held the lock. An optional band on top
 * shades intervals (for example "starvation mode"). Drawn on a canvas, because a long run has thousands of marks.
 */
export function OwnerStrip({ owners, threads, end, band, bandLabel, cursor, names }: {
  owners: readonly [number, number][];
  threads: number;
  end: number;
  band?: readonly [number, number][];
  bandLabel?: string;
  cursor?: number;
  names?: string[];
}) {
  const rowH = 14, gap = 3, top = band ? 16 : 0, labelW = 34;
  const height = top + threads * (rowH + gap) + 16;
  return (
    <Canvas2D
      height={height}
      deps={[owners, threads, end, band, cursor]}
      draw={(ctx, w) => {
        const iw = w - labelW - 4;
        const x = (t: number) => labelW + (t / end) * iw;
        const muted = cssVar("--muted"), subtle = cssVar("--subtle"), fg = cssVar("--fg");
        ctx.font = "11px system-ui, sans-serif";
        if (band) {
          ctx.fillStyle = subtle;
          ctx.fillRect(labelW, 2, iw, 10);
          ctx.fillStyle = cssVar("--c4");
          for (const [a, b] of band) ctx.fillRect(x(a), 2, Math.max(1, x(b) - x(a)), 10);
          ctx.fillStyle = muted;
          ctx.textAlign = "right";
          ctx.fillText(bandLabel ?? "", labelW - 4, 11);
        }
        for (let i = 0; i < threads; i++) {
          const y = top + i * (rowH + gap);
          ctx.fillStyle = subtle;
          ctx.fillRect(labelW, y, iw, rowH);
          ctx.fillStyle = muted;
          ctx.textAlign = "right";
          ctx.fillText(names?.[i] ?? `T${i}`, labelW - 4, y + rowH - 3);
        }
        for (let k = 0; k < owners.length; k++) {
          const [t, tid] = owners[k]!;
          if (tid < 0) continue;
          const t2 = owners[k + 1]?.[0] ?? end;
          const y = top + tid * (rowH + gap);
          ctx.fillStyle = resolve(threadColor(tid));
          ctx.fillRect(x(t), y, Math.max(1, x(t2) - x(t)), rowH);
        }
        const ty = top + threads * (rowH + gap) + 11;
        ctx.fillStyle = muted;
        ctx.textAlign = "left";
        ctx.fillText("0", labelW, ty);
        ctx.textAlign = "right";
        ctx.fillText(`${dur(end)}`, labelW + iw, ty);
        if (cursor !== undefined) {
          ctx.strokeStyle = fg;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x(cursor), 0);
          ctx.lineTo(x(cursor), top + threads * (rowH + gap));
          ctx.stroke();
        }
      }}
    />
  );
}

/** "var(--c1)" to its current value, for canvas. */
function resolve(c: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(c);
  return m ? cssVar(m[1]!) : c;
}
