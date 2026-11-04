/** Small shared pieces for the optimizer demos. */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { select } from "../../kit";

export const seg = <T extends string>(label: string, options: [T, string][], def: T) =>
  select<T>({ label, options: options.map(([value, l]) => ({ value, label: l })), default: def, segmented: true });

export const mono: CSSProperties = { fontVariantNumeric: "tabular-nums", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

export const Note = ({ children }: { children: ReactNode }) => <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{children}</p>;

export const Caption = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div className="muted" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase", margin: "12px 0 4px", ...style }}>{children}</div>
);

export const Code = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <pre style={{ ...mono, fontSize: 11.5, lineHeight: 1.45, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", margin: 0, overflowX: "auto", whiteSpace: "pre", ...style }}>{children}</pre>
);

/** Fixed decimals, or "–" for non-finite values. */
export const fx = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "–");
/** Compact number: 1234567 → "1.23 M", 0.00012 → "1.2e-4". */
export function num(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a < 0.01) return v.toExponential(1).replace("e-", "e-");
  if (a < 1000) return String(Number(v.toPrecision(digits)));
  if (a >= 1e15) return v.toExponential(digits - 1).replace("e+", "e");
  const units: [number, string][] = [[1e12, " T"], [1e9, " G"], [1e6, " M"], [1e3, " k"]];
  for (const [f, u] of units) if (a >= f) return `${Number((v / f).toPrecision(digits))}${u}`;
  return String(v);
}
export const int = (v: number) => Math.round(v).toLocaleString("en-US");

export const Btn = ({ children, onClick, disabled, ghost, on }: { children: ReactNode; onClick: () => void; disabled?: boolean; ghost?: boolean; on?: boolean }) => (
  <button className={`btn${ghost ? " ghost" : ""}`} onClick={onClick} disabled={disabled} style={on ? { outline: "2px solid var(--c1)", outlineOffset: -2 } : undefined}>{children}</button>
);

export const Row = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", ...style }}>{children}</div>
);

/** A horizontal bar on a log scale between lo and hi. */
export function LogBar({ value, lo, hi, color, height = 10 }: { value: number; lo: number; hi: number; color: string; height?: number }) {
  const f = Math.max(0, Math.min(1, (Math.log10(Math.max(lo, value)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))));
  return (
    <div style={{ height, borderRadius: 3, background: "var(--subtle)", border: "1px solid var(--border)", overflow: "hidden", minWidth: 40 }}>
      <div style={{ width: `${f * 100}%`, height: "100%", background: color, transition: "width 0.25s" }} />
    </div>
  );
}

/**
 * Runs `jobs` a few at a time on timer ticks (so a render stays short) and collects the results.
 * Restarts when `key` changes. Undefined entries are not computed yet.
 */
export function useChunked<T>(key: string, jobs: (() => T)[]): (T | undefined)[] {
  const [out, setOut] = useState<(T | undefined)[]>(() => jobs.map(() => undefined));
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => {
    let alive = true, i = 0, t = 0;
    const acc: (T | undefined)[] = jobsRef.current.map(() => undefined);
    const tick = () => {
      if (!alive) return;
      const start = performance.now();
      while (i < jobsRef.current.length && performance.now() - start < 20) { acc[i] = jobsRef.current[i]!(); i++; }
      setOut([...acc]);
      if (i < jobsRef.current.length) t = window.setTimeout(tick, 0);
    };
    t = window.setTimeout(tick, 0);
    return () => { alive = false; window.clearTimeout(t); };
  }, [key]);
  return out;
}

/** Memoizes one expensive value per key at module level (data sets shared by demos). */
const cache = new Map<string, unknown>();
export function once<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

/** Powers of ten from lo to hi, for log axes. */
export function logTicks(lo: number, hi: number, every = 1): number[] {
  const out: number[] = [];
  for (let e = Math.ceil(Math.log10(lo) - 1e-9); e <= Math.floor(Math.log10(hi) + 1e-9); e += every) out.push(10 ** e);
  return out;
}

export const PATH_COLOR = { index: "var(--c1)", bitmap: "var(--c2)", seq: "var(--c3)" } as const;
