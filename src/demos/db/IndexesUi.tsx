/** Small shared pieces for the "More indexes" demos. */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { select } from "../../kit";

export const seg = <T extends string>(label: string, options: [T, string][], def: T) =>
  select<T>({ label, options: options.map(([value, l]) => ({ value, label: l })), default: def, segmented: true });

export const mono: CSSProperties = { fontVariantNumeric: "tabular-nums", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

export const Note = ({ children }: { children: ReactNode }) => <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{children}</p>;

export const Caption = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div className="muted" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase", margin: "10px 0 4px", ...style }}>{children}</div>
);

/** Fixed decimals, or "–" for non-finite values. */
export const fx = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "–");
/** Thousands separators. */
export const int = (v: number) => Math.round(v).toLocaleString("en-US");

/** A caption box for the current step of an animation. */
export const StepText = ({ children }: { children: ReactNode }) => (
  <div style={{ ...mono, fontSize: 12.5, minHeight: 40, marginTop: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--subtle)", lineHeight: 1.45 }}>{children}</div>
);

/** Frames of an operation, with back / next / end and auto-play. */
export function useFrames<F>(delay = 850) {
  const [frames, setFramesRaw] = useState<F[]>([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    if (idx >= frames.length - 1) { setPlaying(false); return; }
    const id = window.setTimeout(() => setIdx((i) => i + 1), delay);
    return () => window.clearTimeout(id);
  }, [playing, idx, frames.length, delay]);
  const start = (fs: F[], play = true) => { setFramesRaw(fs); setIdx(0); setPlaying(play && fs.length > 1); };
  const cur: F | undefined = frames[idx];
  return { frames, idx, setIdx, playing, setPlaying, start, cur };
}

export function StepButtons({ st }: { st: { frames: unknown[]; idx: number; setIdx: (i: number) => void; setPlaying: (p: boolean) => void } }) {
  const n = st.frames.length;
  return (
    <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
      <button className="btn" disabled={!n || st.idx === 0} onClick={() => { st.setPlaying(false); st.setIdx(st.idx - 1); }}>Back</button>
      <button className="btn" disabled={!n || st.idx >= n - 1} onClick={() => { st.setPlaying(false); st.setIdx(st.idx + 1); }}>Next</button>
      <button className="btn ghost" disabled={!n || st.idx >= n - 1} onClick={() => { st.setPlaying(false); st.setIdx(n - 1); }}>End</button>
      {n > 1 && <span className="muted" style={{ fontSize: 12.5 }}>step {st.idx + 1} of {n}</span>}
    </div>
  );
}

/**
 * Runs `jobs` in small time slices (so a render never blocks) and returns the results so far.
 * Restarts when `key` changes.
 */
export function useChunked<T>(key: string, jobs: (() => T)[]): (T | undefined)[] {
  const [out, setOut] = useState<(T | undefined)[]>(() => jobs.map(() => undefined));
  const ref = useRef(jobs);
  ref.current = jobs;
  useEffect(() => {
    let alive = true, i = 0, t = 0;
    const acc: (T | undefined)[] = ref.current.map(() => undefined);
    setOut([...acc]);
    const tick = () => {
      if (!alive) return;
      const s = performance.now();
      while (i < ref.current.length && performance.now() - s < 20) { acc[i] = ref.current[i]!(); i++; }
      setOut([...acc]);
      if (i < ref.current.length) t = window.setTimeout(tick, 0);
    };
    t = window.setTimeout(tick, 0);
    return () => { alive = false; window.clearTimeout(t); };
  }, [key]);
  return out;
}

/** A labelled horizontal bar (value in 0..max). */
export function Bar({ label, value, max, color, text, log }: { label: ReactNode; value: number; max: number; color: string; text: ReactNode; log?: boolean }) {
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

/** A small rounded chip. */
export const Chip = ({ children, color, fill, title, style }: { children: ReactNode; color?: string; fill?: boolean; title?: string; style?: CSSProperties }) => (
  <span title={title} style={{ ...mono, display: "inline-block", fontSize: 11.5, padding: "1px 6px", borderRadius: 4, border: `1px solid ${color ?? "var(--border)"}`, background: fill ? color : "var(--subtle)", color: fill ? "#fff" : "var(--fg)", lineHeight: 1.5, transition: "background 0.2s, border-color 0.2s", ...style }}>{children}</span>
);
