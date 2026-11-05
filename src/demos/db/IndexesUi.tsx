/** Small shared pieces for the "More indexes" demos. */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { mono } from "../../kit";






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

export function FrameButtons({ st }: { st: { frames: unknown[]; idx: number; setIdx: (i: number) => void; setPlaying: (p: boolean) => void } }) {
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



/** A small rounded chip. */
export const Chip = ({ children, color, fill, title, style }: { children: ReactNode; color?: string; fill?: boolean; title?: string; style?: CSSProperties }) => (
  <span title={title} style={{ ...mono, display: "inline-block", fontSize: 11.5, padding: "1px 6px", borderRadius: 4, border: `1px solid ${color ?? "var(--border)"}`, background: fill ? color : "var(--subtle)", color: fill ? "#fff" : "var(--fg)", lineHeight: 1.5, transition: "background 0.2s, border-color 0.2s", ...style }}>{children}</span>
);
