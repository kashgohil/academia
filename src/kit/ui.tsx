/**
 * Small building blocks that demos share. Use these before you write your own.
 * Module-specific views (an ARIES log, a register grid) stay in src/demos/<track>/<Module>Ui.tsx.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Param } from "./Controls";
import { range, select } from "./useParams";

// ---------------------------------------------------------------- style values

export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
export const mono: CSSProperties = { fontVariantNumeric: "tabular-nums", fontFamily: MONO };
export const GOOD = "var(--c3)";
export const BAD = "var(--c4)";

/** A light tint of a theme color. It works in both themes. */
export const tint = (color: string, percent = 16) => `color-mix(in srgb, ${color} ${percent}%, var(--bg))`;

export type Tone = "good" | "bad" | "warn" | "info" | "plain" | "none";
const TONE: Record<Tone, string> = { good: GOOD, bad: BAD, warn: "var(--c2)", info: "var(--c1)", plain: "var(--border)", none: "var(--faint)" };
export const toneColor = (tone: Tone) => TONE[tone];

// ---------------------------------------------------------------- controls

/** A segmented select from [value, label] pairs. */
export const seg = <T extends string>(label: string, options: [T, string][], def: T) =>
  select<T>({ label, options: options.map(([value, l]) => ({ value, label: l })), default: def, segmented: true });

export const Btn = ({ children, onClick, disabled, ghost, on }: { children: ReactNode; onClick: () => void; disabled?: boolean; ghost?: boolean; on?: boolean }) => (
  <button className={`btn${ghost ? " ghost" : ""}`} onClick={onClick} disabled={disabled} style={on ? { outline: "2px solid var(--c1)", outlineOffset: -2 } : undefined}>{children}</button>
);

export const ButtonRow = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", ...style }}>{children}</div>
);

// ---------------------------------------------------------------- text

/** A muted remark below a view. */
export const Note = ({ children }: { children: ReactNode }) => <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0", lineHeight: 1.45 }}>{children}</p>;

/** A short muted label above a view. */
export const SmallLabel = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => <div className="muted" style={{ fontSize: 12, margin: "0 0 4px", ...style }}>{children}</div>;

/** An upper-case heading for a section inside a demo. */
export const SectionLabel = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div className="muted" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase", margin: "10px 0 4px", ...style }}>{children}</div>
);

/** A strip with a colored edge for a result. Give `tone`, or `ok` as a shorthand: true is good, false is bad, null is warn. */
export function Banner({ tone, ok, label, min, style, children }: { tone?: Tone | null; ok?: boolean | null; label?: ReactNode; min?: number; style?: CSSProperties; children: ReactNode }) {
  const t: Tone = tone ?? (ok === undefined ? "plain" : ok === null ? "warn" : ok ? "good" : "bad");
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.45, minHeight: min, padding: "7px 10px 7px 13px", marginTop: 10, background: "var(--subtle)", borderRadius: 6, border: "1px solid var(--border)", boxShadow: `inset 3px 0 0 ${TONE[t]}`, ...style }}>
      {label !== undefined && <span className="muted" style={{ fontSize: 11.5, marginRight: 8, fontVariantNumeric: "tabular-nums" }}>{label}</span>}
      {children}
    </div>
  );
}

/** The text for the current step. It reserves height so that the demo does not jump. */
export const StepCaption = ({ children, tone, label }: { children: ReactNode; tone?: Tone | null; label?: ReactNode }) => <Banner tone={tone} label={label} min={42}>{children}</Banner>;

// ---------------------------------------------------------------- boxes and bars

/** A small labelled box. */
export function Panel({ title, active, accent, children, style }: { title?: ReactNode; active?: boolean; accent?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ border: `1px solid ${active ? "var(--fg)" : "var(--border)"}`, borderRadius: 6, padding: "6px 8px", minWidth: 0, boxShadow: accent ? `inset 0 3px 0 ${accent}` : undefined, ...style }}>
      {title && <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>{title}</div>}
      {children}
    </div>
  );
}

export function Chip({ children, color = "var(--fg)", filled, dashed, faint, strike, bold, title, onClick }: { children: ReactNode; color?: string; filled?: boolean; dashed?: boolean; faint?: boolean; strike?: boolean; bold?: boolean; title?: string; onClick?: () => void }) {
  return (
    <span
      title={title}
      onClick={onClick}
      style={{
        display: "inline-block", fontFamily: MONO, fontSize: 11.5, lineHeight: "17px", padding: "0 5px", borderRadius: 4,
        border: `1.5px ${dashed ? "dashed" : "solid"} ${color}`, background: filled ? color : "var(--bg)", color: filled ? "var(--bg)" : color,
        opacity: faint ? 0.35 : 1, textDecoration: strike ? "line-through" : undefined, cursor: onClick ? "pointer" : undefined, whiteSpace: "nowrap", fontWeight: bold ? 700 : 400,
        transition: "background 0.2s, color 0.2s, opacity 0.2s",
      }}
    >
      {children}
    </span>
  );
}

/** A bar for a fraction of the full width, with no text. */
export const Bar = ({ frac, color = "var(--c1)", height = 10 }: { frac: number; color?: string; height?: number }) => (
  <div style={{ width: "100%", height, background: "var(--subtle)", borderRadius: 3, overflow: "hidden" }}>
    <div style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%`, minWidth: frac > 0 ? 1 : 0, height: "100%", background: color, transition: "width 0.25s" }} />
  </div>
);

/** A bar with a label and a value above it, for a value in 0..max. */
export function Meter({ label, value, max, color, text, log }: { label: ReactNode; value: number; max: number; color: string; text: ReactNode; log?: boolean }) {
  const f = log ? Math.log10(1 + value) / Math.log10(1 + max) : value / max;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--muted)", gap: 8 }}>
        <span>{label}</span>
        <b style={{ color: "var(--fg)", ...mono }}>{text}</b>
      </div>
      <div style={{ height: 9, borderRadius: 3, background: "var(--subtle)", border: "1px solid var(--border)", overflow: "hidden", margin: "3px 0 6px" }}>
        <div style={{ width: `${Math.max(0, Math.min(100, f * 100))}%`, height: "100%", background: color, transition: "width 0.25s" }} />
      </div>
    </div>
  );
}

/** A stacked bar of parts. The parts fill the width, unless `total` is larger than their sum. */
export function StackBar({ parts, total, height = 20 }: { parts: { value: number; color: string; label?: string }[]; total?: number; height?: number }) {
  const t = total ?? parts.reduce((a, p) => a + p.value, 0);
  return (
    <div style={{ display: "flex", width: "100%", height, borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)", background: "var(--subtle)" }}>
      {parts.map((p, i) => (
        <div key={i} title={p.label} style={{ width: `${t > 0 ? (p.value / t) * 100 : 0}%`, minWidth: p.value > 0 ? 1 : 0, background: p.color, transition: "width 0.25s" }} />
      ))}
    </div>
  );
}

/** A compact table that scrolls inside itself. The first column is left-aligned, and the others are right-aligned. */
export function MiniTable({ head, rows, highlight }: { head: ReactNode[]; rows: ReactNode[][]; highlight?: number | ((row: number) => boolean) }) {
  const cell = (i: number): CSSProperties => ({ padding: "3px 8px", borderBottom: "1px solid var(--border)", textAlign: i === 0 ? "left" : "right" });
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
        <thead>
          <tr>{head.map((h, i) => <th key={i} style={{ ...cell(i), color: "var(--muted)", fontWeight: 600, verticalAlign: "bottom" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const on = typeof highlight === "function" ? highlight(i) : highlight === i;
            return (
              <tr key={i} style={{ background: on ? "var(--subtle)" : undefined, fontWeight: on ? 600 : 400 }}>
                {r.map((c, j) => <td key={j} style={cell(j)}>{c}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** An arrow head for SVG. Use it inside `<defs>`, then `markerEnd="url(#id)"`. */
export const Arrow = ({ id, color = "var(--muted)" }: { id: string; color?: string }) => (
  <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M0 0L10 5L0 10z" fill={color} />
  </marker>
);

// ---------------------------------------------------------------- steppers

/** An index into a list of frames, with play, back and step. Use it with StepButtons and StepSlider. */
export function useStepper(n: number, fps = 2) {
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
    i: cur, n, atEnd: cur >= last, running,
    go: (j: number) => { setRunning(false); setI(Math.max(0, Math.min(last, j))); },
    toggle: () => { if (cur >= last && !running) setI(0); setRunning((r) => !r); },
    reset: () => { setRunning(false); setI(0); },
  };
}
export type Stepper = ReturnType<typeof useStepper>;

export function StepButtons({ s }: { s: Stepper }) {
  return (
    <>
      <button className="btn primary" onClick={s.toggle}>{s.running ? "Pause" : s.atEnd ? "Replay" : "Play"}</button>
      <button className="btn" onClick={() => s.go(s.i - 1)} disabled={s.i === 0}>Back</button>
      <button className="btn" onClick={() => s.go(s.i + 1)} disabled={s.atEnd}>Step</button>
    </>
  );
}

export function StepSlider({ s, label = "Step" }: { s: Stepper; label?: string }) {
  return <Param spec={range({ label, min: 0, max: Math.max(1, s.n - 1), step: 1, default: 0, format: (v) => `${v} of ${s.n - 1}` })} value={s.i} onChange={(v) => s.go(v as number)} />;
}

/** Back and Next for a position that the demo holds itself, with no auto-play. */
export function IndexButtons({ k, n, set }: { k: number; n: number; set: (v: number) => void }) {
  return (
    <>
      <button className="btn" onClick={() => set(Math.max(0, k - 1))} disabled={k === 0}>Back</button>
      <button className="btn primary" onClick={() => set(Math.min(n - 1, k + 1))} disabled={k >= n - 1}>Next</button>
    </>
  );
}

export const IndexSlider = ({ k, n, set, label = "Step" }: { k: number; n: number; set: (v: number) => void; label?: string }) => (
  <Param spec={range({ label, min: 0, max: n - 1, step: 1, default: 0, format: (v) => `${v + 1} of ${n}` })} value={Math.min(k, n - 1)} onChange={(v) => set(v as number)} />
);

// ---------------------------------------------------------------- slow work

/**
 * Runs `jobs` in short time slices, so that a render never blocks, and returns the results so far.
 * An entry is undefined until its job has run. It restarts when `key` changes. With `keep`, the old results
 * stay on screen until the first new ones arrive, so a dragged slider does not flicker.
 */
export function useChunked<T>(key: string, jobs: (() => T)[], { keep = false }: { keep?: boolean } = {}): (T | undefined)[] {
  const [state, setState] = useState<{ key: string | null; results: (T | undefined)[] }>({ key: null, results: [] });
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => {
    let alive = true, i = 0, timer = 0;
    const list = jobsRef.current;
    const results = list.map((): T | undefined => undefined);
    const tick = () => {
      if (!alive) return;
      const start = performance.now();
      while (i < list.length && performance.now() - start < 20) { results[i] = list[i]!(); i++; }
      setState({ key, results: results.slice() });
      if (i < list.length) timer = window.setTimeout(tick, 0);
    };
    timer = window.setTimeout(tick, 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [key]);
  if (state.key === key || (keep && state.results.length === jobs.length)) return state.results;
  return jobs.map(() => undefined);
}
