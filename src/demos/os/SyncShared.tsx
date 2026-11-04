/** Shared parts of the synchronization demos: the thread stepper, status banners and chunked sweeps. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Demo } from "../../kit";
import {
  allDone, canRun, clone, currentIns, drain, exec, initial, threadDone,
  type Ins, type MState, type Prog,
} from "../../sims/os/sync/machine";

export const MONO = "ui-monospace, Menlo, monospace";
export const TC = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--c3)", "var(--fg)", "var(--muted)"];

export type Tone = "good" | "bad" | "plain";

export function Banner({ tone = "plain", children }: { tone?: Tone; children: ReactNode }) {
  const c = tone === "bad" ? "var(--c4)" : tone === "good" ? "var(--c3)" : "var(--border)";
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.45, minHeight: 22, padding: "7px 10px 7px 13px", marginTop: 10, background: "var(--subtle)", borderRadius: 6, border: "1px solid var(--border)", boxShadow: `inset 3px 0 0 ${c}` }}>
      {children}
    </div>
  );
}

/** A labelled memory cell. */
export function Cell({ name, value, hot, note, width }: { name: string; value: ReactNode; hot?: boolean; note?: string; width?: number }) {
  return (
    <div style={{ minWidth: width ?? 58, textAlign: "center" }}>
      <div className="muted" style={{ fontSize: 11, fontFamily: MONO, marginBottom: 2 }}>{name}</div>
      <div style={{ border: `1.5px solid ${hot ? "var(--c2)" : "var(--border)"}`, borderRadius: 5, padding: "4px 6px", fontFamily: MONO, fontSize: 15, fontWeight: 600, background: "var(--bg)", transition: "border-color .2s" }}>{value}</div>
      {note && <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

export function CellRow({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>{children}</div>;
}

/** Runs tasks one at a time with setTimeout, so a sweep never blocks a render. */
export function useChunked<T>(tasks: (() => T)[], key: string): { results: (T | undefined)[]; done: boolean } {
  const [state, setState] = useState<{ key: string; results: (T | undefined)[] }>({ key: "", results: [] });
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  useEffect(() => {
    let i = 0;
    let timer = 0;
    const list = tasksRef.current;
    const results = new Array<T | undefined>(list.length).fill(undefined);
    const run = () => {
      const t0 = performance.now();
      // Several cheap tasks can share one frame. A heavy task gets its own frame.
      do {
        results[i] = list[i]!();
        i++;
      } while (i < list.length && performance.now() - t0 < 12);
      setState({ key, results: results.slice() });
      if (i < list.length) timer = window.setTimeout(run, 0);
    };
    timer = window.setTimeout(run, 0);
    return () => clearTimeout(timer);
  }, [key]);
  const results = state.key === key ? state.results : new Array<T | undefined>(tasks.length).fill(undefined);
  return { results, done: results.every((r) => r !== undefined) };
}

// ---------------------------------------------------------------- the stepper

export interface LogLine { thread: number; text: string; say: string; kind: "exec" | "drain" }

export interface Scripted { label: string; schedule: readonly string[]; primary?: boolean }

export interface StepperView {
  s: MState;
  prog: Prog;
  log: LogLine[];
  stuck: boolean;
  finished: boolean;
}

export interface StepperProps {
  title: string;
  prog: Prog;
  controls?: ReactNode;
  /** A view of shared state. */
  panel?: (v: StepperView) => ReactNode;
  /** A line under the panel. */
  verdict?: (v: StepperView) => { tone: Tone; text: ReactNode } | null;
  /** Ready-made schedules that the learner can watch. */
  scripts?: Scripted[];
  /** Hide the register line for these names. */
  hideRegs?: string[];
  /** Extra content under the threads. */
  footer?: ReactNode;
}

function threadStatus(p: Prog, s: MState, t: number, ins: Ins | undefined, can: boolean): { text: string; color: string } {
  if (threadDone(p, s, t)) return { text: "done", color: "var(--c3)" };
  if (!ins) return { text: "store buffer not empty", color: "var(--muted)" };
  if (can) return { text: ins.kind === "cs" ? "in critical section" : ins.kind === "sleep" ? "awake" : "ready", color: ins.kind === "cs" ? "var(--c2)" : "var(--muted)" };
  if (ins.kind === "sleep") return { text: "asleep", color: "var(--c4)" };
  return { text: "blocked", color: "var(--c4)" };
}

const lineStyle = (active: boolean, kind: Ins["kind"], color: string, blocked: boolean) => ({
  fontFamily: MONO,
  fontSize: 11.5,
  lineHeight: 1.35,
  padding: "2px 6px",
  borderRadius: 3,
  borderLeft: `2px solid ${kind === "kernel" || kind === "sleep" ? "var(--c5)" : kind === "cs" ? "var(--c2)" : "transparent"}`,
  background: active ? (blocked ? "var(--subtle)" : "var(--accent-soft, var(--subtle))") : kind === "kernel" || kind === "sleep" ? "var(--subtle)" : "transparent",
  outline: active ? `1.5px solid ${color}` : "none",
  outlineOffset: -1,
  color: active ? "var(--fg)" : "var(--muted)",
  fontWeight: active ? 600 : 400,
});

export function SyncStepper({ title, prog, controls, panel, verdict, scripts, hideRegs, footer }: StepperProps) {
  const [hist, setHist] = useState<{ s: MState; line: LogLine | null }[]>(() => [{ s: initial(prog), line: null }]);
  const [playing, setPlaying] = useState<{ schedule: readonly string[]; i: number } | null>(null);
  const progRef = useRef(prog);
  useEffect(() => {
    if (progRef.current !== prog) {
      progRef.current = prog;
      setHist([{ s: initial(prog), line: null }]);
      setPlaying(null);
    }
  }, [prog]);
  // During the render right after a program change, the history belongs to the old program.
  const safeHist = progRef.current === prog ? hist : [{ s: initial(prog), line: null }];
  const s = safeHist[safeHist.length - 1]!.s;
  const n = s.th.length;
  const can = useMemo(() => prog.threads.map((_, t) => !s.err && canRun(prog, s, t)), [prog, s]);
  const log = useMemo(() => safeHist.map((h) => h.line).filter((l): l is LogLine => !!l), [safeHist]);
  const anyDrain = s.th.some((t) => t.buf.length > 0);
  const stuck = !s.err && !can.some(Boolean) && !anyDrain && !allDone(prog, s);
  const finished = allDone(prog, s);

  const run = (t: number) => {
    const ins = currentIns(prog, s, t);
    const next = clone(s);
    if (!exec(prog, next, t)) return false;
    setHist([...safeHist, { s: next, line: { thread: t, text: ins?.text ?? "", say: next.say, kind: "exec" } }]);
    return true;
  };
  const drainT = (t: number) => {
    const next = clone(s);
    drain(next, t);
    setHist([...safeHist, { s: next, line: { thread: t, text: "store buffer drain", say: next.say, kind: "drain" } }]);
  };

  useEffect(() => {
    if (!playing) return;
    if (playing.i >= playing.schedule.length) { setPlaying(null); return; }
    const timer = window.setTimeout(() => {
      const id = playing.schedule[playing.i]!;
      const t = Number(id.slice(1));
      if (id[0] === "D") drainT(t);
      else run(t);
      setPlaying({ ...playing, i: playing.i + 1 });
    }, playing.i === 0 ? 150 : 650);
    return () => clearTimeout(timer);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => { setPlaying(null); setHist([{ s: initial(prog), line: null }]); };
  const back = () => { setPlaying(null); if (safeHist.length > 1) setHist(safeHist.slice(0, -1)); };
  const name = (t: number) => prog.names?.[t] ?? `T${t}`;
  const view: StepperView = { s, prog, log, stuck, finished };
  const v = verdict?.(view);
  const banner = s.err ? { tone: "bad" as Tone, text: s.err } : stuck ? { tone: "bad" as Tone, text: "Stuck. No thread can run, and some threads have not finished. Nothing will ever wake them." } : v;

  return (
    <Demo
      title={title}
      actions={
        <>
          <button className="btn" onClick={back} disabled={safeHist.length <= 1}>Back</button>
          <button className="btn ghost" onClick={reset}>Reset</button>
        </>
      }
      controls={controls}
    >
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${n > 2 ? 150 : 145}px, 1fr))`, gap: 8 }}>
        {prog.threads.map((code, t) => {
          const ins = currentIns(prog, s, t);
          const st = threadStatus(prog, s, t, ins, can[t]!);
          const regs = Object.entries(s.th[t]!.r).filter(([k]) => !(hideRegs ?? []).includes(k));
          return (
            <div key={t} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 6, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                <button className="btn primary" style={{ padding: "2px 10px", fontSize: 12.5, whiteSpace: "nowrap", flex: "none", background: can[t] ? TC[t % TC.length] : undefined, borderColor: can[t] ? TC[t % TC.length] : undefined, color: can[t] ? "var(--bg)" : undefined }} disabled={!can[t] || !!playing} onClick={() => run(t)}>
                  Run {name(t)}
                </button>
                <span style={{ fontSize: 11, color: st.color, lineHeight: 1.1 }}>{st.text}</span>
              </div>
              <div style={{ display: "grid", gap: 1 }}>
                {code.map((c, i) => (
                  <div key={i} style={lineStyle(s.th[t]!.pc === i, c.kind, TC[t % TC.length]!, !can[t])}>{c.text}</div>
                ))}
              </div>
              {regs.length > 0 && <div className="muted" style={{ fontFamily: MONO, fontSize: 10.5, marginTop: 4 }}>{regs.map(([k, x]) => `${k}=${x}`).join(" ")}</div>}
              {prog.tso && (
                <div style={{ marginTop: 5, fontSize: 11 }}>
                  <div className="muted" style={{ marginBottom: 2 }}>store buffer</div>
                  <div style={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "center", minHeight: 22 }}>
                    {s.th[t]!.buf.length === 0 && <span className="muted" style={{ fontFamily: MONO }}>empty</span>}
                    {s.th[t]!.buf.map((b, i) => <span key={i} style={{ fontFamily: MONO, fontSize: 10.5, border: "1px solid var(--c2)", borderRadius: 3, padding: "1px 4px" }}>{b[0]}={b[1]}</span>)}
                    {s.th[t]!.buf.length > 0 && <button className="btn" style={{ padding: "1px 6px", fontSize: 11 }} disabled={!!playing || !!s.err} onClick={() => drainT(t)}>Drain</button>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {panel && <div style={{ marginTop: 10 }}>{panel(view)}</div>}
      {banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : <Banner>{log.length ? `${name(log[log.length - 1]!.thread)}: ${log[log.length - 1]!.say || log[log.length - 1]!.text}` : "Click a Run button. You are the scheduler."}</Banner>}
      {banner && log.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Last step: {name(log[log.length - 1]!.thread)}: {log[log.length - 1]!.say || log[log.length - 1]!.text}</div>}
      {scripts && scripts.length > 0 && (
        <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 6 }}>
          {scripts.map((x) => (
            <button key={x.label} className="btn" onClick={() => { setHist([{ s: initial(prog), line: null }]); setPlaying({ schedule: x.schedule, i: 0 }); }}>{x.label}</button>
          ))}
        </div>
      )}
      <ScheduleStrip log={log} names={prog.names} />
      {footer}
    </Demo>
  );
}

function ScheduleStrip({ log, names }: { log: LogLine[]; names?: string[] }) {
  if (!log.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 8, alignItems: "center" }} aria-label="schedule so far">
      <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>Schedule</span>
      {log.map((l, i) => (
        <span key={i} title={l.say || l.text} style={{ fontSize: 10.5, fontFamily: MONO, color: "var(--bg)", background: l.kind === "drain" ? "var(--muted)" : TC[l.thread % TC.length], borderRadius: 3, padding: "0 4px" }}>
          {l.kind === "drain" ? "D" : ""}{names?.[l.thread] ?? l.thread}
        </span>
      ))}
    </div>
  );
}

/** A small table with monospaced numbers that fits a phone. */
export function MiniTable({ head, rows, highlight }: { head: ReactNode[]; rows: ReactNode[][]; highlight?: (i: number) => boolean }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
        <thead>
          <tr>{head.map((h, i) => <th key={i} style={{ textAlign: i ? "right" : "left", fontWeight: 500, padding: "3px 6px", borderBottom: "1px solid var(--border)", verticalAlign: "bottom" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ background: highlight?.(i) ? "var(--accent-soft, var(--subtle))" : undefined }}>
              {r.map((c, j) => <td key={j} style={{ textAlign: j ? "right" : "left", padding: "3px 6px", fontVariantNumeric: "tabular-nums", borderBottom: "1px solid var(--border)" }}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
