/** Small shared pieces for the Storage demos. */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { select } from "../../kit";

export const seg = <T extends string>(label: string, options: [T, string][], def: T) =>
  select<T>({ label, options: options.map(([value, l]) => ({ value, label: l })), default: def, segmented: true });

export const mono: CSSProperties = { fontVariantNumeric: "tabular-nums", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

export const Note = ({ children }: { children: ReactNode }) => <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{children}</p>;

export const Caption = ({ children }: { children: ReactNode }) => <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{children}</div>;

/** A labelled horizontal bar for a value in 0..max. */
export function Meter({ label, value, max, color, text }: { label: ReactNode; value: number; max: number; color: string; text: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--muted)", gap: 8 }}>
        <span>{label}</span>
        <b style={{ color: "var(--fg)", ...mono }}>{text}</b>
      </div>
      <div style={{ height: 9, borderRadius: 3, background: "var(--subtle)", border: "1px solid var(--border)", overflow: "hidden", margin: "3px 0 6px" }}>
        <div style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`, height: "100%", background: color, transition: "width 0.25s" }} />
      </div>
    </div>
  );
}

/** A stacked horizontal bar of parts. */
export function StackBar({ parts, total, height = 22 }: { parts: { label: string; value: number; color: string }[]; total?: number; height?: number }) {
  const t = total ?? parts.reduce((a, p) => a + p.value, 0);
  return (
    <div style={{ display: "flex", height, borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)", background: "var(--subtle)" }}>
      {parts.map((p) => (
        <div key={p.label} title={p.label} style={{ width: `${t > 0 ? (p.value / t) * 100 : 0}%`, background: p.color, transition: "width 0.25s" }} />
      ))}
    </div>
  );
}

/**
 * Runs `jobs` one per timer tick (so the page stays responsive) and collects the results.
 * Restarts whenever `key` changes. Returns the results so far (undefined = not computed yet).
 */
export function useChunked<T>(key: string, jobs: (() => T)[]): (T | undefined)[] {
  const [out, setOut] = useState<(T | undefined)[]>(() => jobs.map(() => undefined));
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => {
    let alive = true, i = 0;
    const acc: (T | undefined)[] = jobsRef.current.map(() => undefined);
    setOut([...acc]);
    let t = 0;
    const tick = () => {
      if (!alive) return;
      const start = performance.now();
      while (i < jobsRef.current.length && performance.now() - start < 25) { acc[i] = jobsRef.current[i]!(); i++; }
      setOut([...acc]);
      if (i < jobsRef.current.length) t = window.setTimeout(tick, 0);
    };
    t = window.setTimeout(tick, 0);
    return () => { alive = false; window.clearTimeout(t); };
  }, [key]);
  return out;
}

/** Number formatting with a fixed number of significant digits. */
export const fx = (v: number, d = 3) => (Number.isFinite(v) ? Number(v.toPrecision(d)).toLocaleString("en-US") : "–");

export const ms = (v: number) => (v >= 100 ? `${fx(v, 3)} ms` : v >= 1 ? `${v.toFixed(2)} ms` : `${(v * 1000).toFixed(0)} µs`);
