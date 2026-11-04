import { useMemo, useState } from "react";
import { Demo, Param, select, toggle } from "../kit";
import { makeWorld, replay, type Scenario } from "../sims/lockfree/scenario";
import { nodeName, type Options, type Ptr, type Scheme, type World } from "../sims/lockfree/machine";

const TC = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)"];

/** A scripted schedule: [thread, steps] where steps is a count, "done", or a label prefix to stop before. */
export type ScriptStep = [number, number | "done" | { before: string }];
export interface Script { label: string; steps: ScriptStep[] }

function expand(sc: Scenario, opts: Options, script: Script): number[] {
  const w = makeWorld(sc, opts);
  const out: number[] = [];
  for (const [t, n] of script.steps) {
    const th = w.threads[t]!;
    const go = () => { out.push(t); w.step(t); };
    if (n === "done") while (th.next !== null) go();
    else if (typeof n === "number") for (let i = 0; i < n && th.next !== null; i++) go();
    else while (th.next !== null && !th.next.startsWith(n.before)) go();
  }
  return out;
}

const SCHEMES: { value: Scheme; label: string }[] = [
  { value: "leak", label: "Never free (leak)" },
  { value: "immediate", label: "Free immediately" },
  { value: "hazard", label: "Hazard pointers" },
  { value: "epoch", label: "Epoch-based" },
];

export function LockFreeStepper({
  title,
  scenario,
  scheme: initialScheme = "leak",
  tags: initialTags = false,
  schemes,
  showTags = false,
  scripts = [],
}: {
  title: string;
  scenario: Scenario;
  scheme?: Scheme;
  tags?: boolean;
  /** Which schemes the reader may switch between (omit to hide the control). */
  schemes?: Scheme[];
  showTags?: boolean;
  scripts?: Script[];
}) {
  const [scheme, setScheme] = useState<Scheme>(initialScheme);
  const [tags, setTags] = useState(initialTags);
  const [schedule, setSchedule] = useState<number[]>([]);
  const opts: Options = { scheme, tags, threshold: 2, pool: 16 };
  const w = useMemo(() => {
    const x = replay(scenario, opts, schedule);
    if (x.done()) x.finalize();
    return x;
  }, [scenario, scheme, tags, schedule]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = (t: number) => setSchedule((s) => [...s, t]);
  const randomStep = () => { const ids = w.runnable(); if (ids.length) step(ids[Math.floor(Math.random() * ids.length)]!); };
  const runAll = () => {
    const x = replay(scenario, opts, schedule);
    const s = [...schedule];
    while (!x.done() && s.length < 2000) { const ids = x.runnable(); const t = ids[Math.floor(Math.random() * ids.length)]!; s.push(t); x.step(t); }
    setSchedule(s);
  };

  return (
    <Demo
      title={title}
      actions={
        <>
          <button className="btn" onClick={randomStep} disabled={w.done()}>Random step</button>
          <button className="btn" onClick={runAll} disabled={w.done()}>Run to end</button>
          <button className="btn" onClick={() => setSchedule((s) => s.slice(0, -1))} disabled={!schedule.length}>Undo</button>
          <button className="btn ghost" onClick={() => setSchedule([])}>Reset</button>
        </>
      }
      controls={
        schemes || showTags ? (
          <>
            {schemes && (
              <Param
                spec={select({ label: "Memory reclamation", options: SCHEMES.filter((s) => schemes.includes(s.value)), default: initialScheme })}
                value={scheme}
                onChange={(v) => { setScheme(v as Scheme); setSchedule([]); }}
              />
            )}
            {showTags && <Param spec={toggle({ label: "Tagged pointers (version counter in head)", default: initialTags })} value={tags} onChange={(v) => { setTags(v as boolean); setSchedule([]); }} />}
          </>
        ) : undefined
      }
    >
      {scripts.length > 0 && (
        <div className="row" style={{ marginBottom: 12 }}>
          {scripts.map((s) => (
            <button key={s.label} className="btn" onClick={() => setSchedule(expand(scenario, opts, s))}>{s.label}</button>
          ))}
        </div>
      )}
      <Structure w={w} kind={scenario.kind} />
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(190px, 1fr))`, gap: 10, marginTop: 12 }}>
        {w.threads.map((t) => {
          const op = t.ops[t.opIndex];
          return (
            <div key={t.id} style={{ border: "1px solid var(--border)", borderTop: `3px solid ${TC[t.id]}`, borderRadius: 6, padding: "8px 10px", fontSize: 12.5 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <b>T{t.id}</b>
                <button className="btn" style={{ padding: "2px 10px" }} disabled={t.next === null} onClick={() => step(t.id)}>Step</button>
              </div>
              <div className="muted" style={{ marginTop: 4 }}>
                {op ? `op ${t.opIndex + 1}/${t.ops.length}: ${op.kind}${"v" in op ? `(${op.v})` : "()"}` : "finished"}
              </div>
              <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11.5, minHeight: 34, marginTop: 4 }}>
                {t.next ? <>next: {t.next}</> : <span className="muted">—</span>}
              </div>
              {Object.keys(t.ptrs).length > 0 && (
                <div className="muted" style={{ fontSize: 11.5 }}>{Object.entries(t.ptrs).map(([k, p]) => `${k}=${nodeName(p)}`).join("  ")}</div>
              )}
              {scheme === "hazard" && <div className="muted" style={{ fontSize: 11.5 }}>hazards: {t.hazards.map(nodeName).join(", ")} · retired: {t.retired.map(nodeName).join(", ") || "none"}</div>}
              {scheme === "epoch" && <div className="muted" style={{ fontSize: 11.5 }}>{t.active ? `active in epoch ${t.epoch}` : "inactive"} · bags: {t.bags.map((b) => b.map(nodeName).join("") || "∅").join(" | ")}</div>}
              {t.results.length > 0 && <div style={{ fontSize: 11.5, marginTop: 2 }}>returned: {t.results.map((r) => (r === null ? "empty" : r)).join(", ")}</div>}
            </div>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, marginTop: 12, fontSize: 12 }}>
        <div>
          <div className="muted" style={{ marginBottom: 4 }}>Last steps{scheme === "epoch" ? ` · global epoch ${w.epoch}` : ""}</div>
          <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11.5 }}>
            {w.log.slice(-6).map((l, i) => <div key={i}><span style={{ color: TC[l.t] }}>T{l.t}</span> {l.label}</div>)}
            {!w.log.length && <span className="muted">Step a thread, or run a script.</span>}
          </div>
        </div>
        <div>
          <div className="muted" style={{ marginBottom: 4 }}>Checks</div>
          {w.violations.length ? (
            w.violations.slice(0, 4).map((v, i) => <div key={i} style={{ color: "var(--c4)" }}>{v.kind}: {v.detail}</div>)
          ) : (
            <div>{w.done() ? "All operations finished. No violations." : "No violations so far."}</div>
          )}
        </div>
      </div>
    </Demo>
  );
}

// ---------------- structure drawing ----------------

const BW = 58, BH = 34, GAP = 30;

function Structure({ w, kind }: { w: World; kind: "stack" | "queue" }) {
  const chain: Ptr[] = [];
  const seen = new Set<Ptr>();
  for (let p = w.roots.head!.ptr; p && !seen.has(p) && chain.length < 12; p = w.nodes[p]!.next.ptr) { chain.push(p); seen.add(p); }
  const threadRefs = new Map<Ptr, { t: number; name: string }[]>();
  w.threads.forEach((t) => Object.entries(t.ptrs).forEach(([k, p]) => p && threadRefs.set(p, [...(threadRefs.get(p) ?? []), { t: t.id, name: k }])));
  const off: Ptr[] = [];
  w.nodes.forEach((n, p) => {
    if (!p || seen.has(p)) return;
    if (n.state === "private" || n.state === "retired" || n.state === "live" || (n.state === "free" && threadRefs.has(p))) off.push(p);
  });
  const freeList = [...w.freeList].reverse().slice(0, 8);
  const rows = [chain, off];
  const width = Math.max(rows[0]!.length, rows[1]!.length, 3) * (BW + GAP) + 70;
  const rowY = [34, 34 + BH + 62];
  const pos = new Map<Ptr, [number, number]>();
  rows.forEach((r, ri) => r.forEach((p, i) => pos.set(p, [70 + i * (BW + GAP), rowY[ri]!])));
  const height = rowY[1]! + BH + 40;
  const roots = Object.entries(w.roots);

  const color = (p: Ptr) => {
    const s = w.nodes[p]!.state;
    return s === "free" ? "var(--c4)" : s === "retired" ? "var(--c2)" : s === "private" ? "var(--accent)" : "var(--fg)";
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={width} height={height} style={{ display: "block", fontFamily: "inherit" }}>
        <defs>
          <marker id="lf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0L10 5L0 10z" fill="var(--muted)" />
          </marker>
        </defs>
        <text x={0} y={rowY[0]! + BH / 2 + 4} fontSize={11} fill="var(--muted)">{kind === "stack" ? "stack" : "queue"}</text>
        <text x={0} y={rowY[1]! + BH / 2 + 4} fontSize={11} fill="var(--muted)">off-list</text>
        {chain.length === 0 && <text x={70} y={rowY[0]! + BH / 2 + 4} fontSize={12} fill="var(--muted)">empty</text>}
        {/* next pointers */}
        {[...pos].map(([p, [x, y]]) => {
          const nx = w.nodes[p]!.next.ptr;
          const to = pos.get(nx);
          if (!nx || !to) return null;
          const sameRow = to[1] === y && to[0] > x;
          return sameRow ? (
            <line key={`e${p}`} x1={x + BW} y1={y + BH / 2} x2={to[0] - 2} y2={to[1] + BH / 2} stroke="var(--muted)" markerEnd="url(#lf-arrow)" />
          ) : (
            <path key={`e${p}`} d={`M${x + BW / 2} ${y + (to[1] < y ? 0 : BH)} C ${x + BW / 2} ${(y + to[1]) / 2 + BH / 2}, ${to[0] + BW / 2} ${(y + to[1]) / 2 + BH / 2}, ${to[0] + BW / 2} ${to[1] + (to[1] < y ? BH : 0)}`} fill="none" stroke="var(--muted)" strokeDasharray="3 3" markerEnd="url(#lf-arrow)" />
          );
        })}
        {/* nodes */}
        {[...pos].map(([p, [x, y]]) => {
          const n = w.nodes[p]!;
          const isDummy = kind === "queue" && p === w.roots.head!.ptr;
          return (
            <g key={p}>
              <rect x={x} y={y} width={BW} height={BH} rx={4} fill="var(--bg)" stroke={color(p)} strokeWidth={n.state === "live" ? 1.25 : 1.75} strokeDasharray={n.state === "private" ? "4 3" : undefined} />
              <text x={x + 8} y={y + 14} fontSize={11} fontWeight={600} fill={color(p)}>{nodeName(p)}</text>
              <text x={x + 8} y={y + 27} fontSize={11} fill="var(--fg)">{isDummy ? "dummy" : n.state === "free" ? "freed" : n.value}</text>
              {n.state !== "live" && <text x={x + BW - 4} y={y + 14} fontSize={9.5} textAnchor="end" fill={color(p)}>{n.state}</text>}
              {(threadRefs.get(p) ?? []).map((r, i) => (
                <text key={i} x={x} y={y + BH + 13 + i * 12} fontSize={10.5} fill={TC[r.t]}>T{r.t}.{r.name}</text>
              ))}
            </g>
          );
        })}
        {/* roots */}
        {roots.map(([name, word], i) => {
          const at = pos.get(word.ptr);
          if (!at) return null;
          const dx = i * 18;
          return (
            <g key={name}>
              <text x={at[0] + BW / 2 + dx} y={at[1] - 18} fontSize={11} textAnchor="middle" fill="var(--fg)" fontWeight={600}>{name}{w.opts.tags ? ` v${word.tag}` : ""}</text>
              <line x1={at[0] + BW / 2 + dx} y1={at[1] - 14} x2={at[0] + BW / 2 + dx} y2={at[1] - 2} stroke="var(--fg)" markerEnd="url(#lf-arrow)" />
            </g>
          );
        })}
        <text x={0} y={height - 8} fontSize={11} fill="var(--muted)">
          free list (next allocation first): {freeList.map(nodeName).join(" ")}{w.freeList.length > 8 ? " …" : ""}
        </text>
      </svg>
    </div>
  );
}
