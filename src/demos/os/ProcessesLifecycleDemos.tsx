/** Lesson: what a process is. A state machine with one CPU, and a tree with exit, wait and re-parenting. */
import { useRef, useState } from "react";
import { Demo, Stats, useWidth } from "../../kit";
import { ProcTable, stateMachineTable, treeTable, statLetter, type EventResult, type Proc } from "../../sims/os/processes";
import { Cap, Msg, Note, mono, tint } from "./ProcessesUi";

const PROC_COLOR: Record<number, string> = { 100: "var(--c5)", 101: "var(--c1)", 102: "var(--c2)", 103: "var(--c3)" };
const SHORT: Record<number, string> = { 100: "shell", 101: "A", 102: "B", 103: "C" };

type Box = { x: number; y: number; w: number; h: number };
type NodeId = "ready" | "running" | "blocked" | "zombie" | "gone";

const NODE_LABEL: Record<NodeId, string> = { ready: "Ready", running: "Running (the CPU)", blocked: "Blocked", zombie: "Zombie", gone: "Reaped" };

function layout(w: number): { boxes: Record<NodeId, Box>; h: number } {
  if (w < 520) {
    const bw = Math.min(150, (w - 72) / 2), bh = 74, l = 0, r = w - bw;
    return {
      h: 330,
      boxes: {
        ready: { x: l, y: 6, w: bw, h: bh }, running: { x: r, y: 6, w: bw, h: bh },
        blocked: { x: l, y: 128, w: bw, h: bh }, zombie: { x: r, y: 128, w: bw, h: bh },
        gone: { x: r, y: 250, w: bw, h: bh },
      },
    };
  }
  const bw = Math.min(150, w * 0.24), bh = 74, gap = (w - 3 * bw) / 2;
  return {
    h: 214,
    boxes: {
      ready: { x: 0, y: 6, w: bw, h: bh }, running: { x: bw + gap, y: 6, w: bw, h: bh }, zombie: { x: 2 * bw + 2 * gap, y: 6, w: bw, h: bh },
      blocked: { x: (bw + gap) / 2, y: 134, w: bw, h: bh }, gone: { x: 2 * bw + 2 * gap, y: 134, w: bw, h: bh },
    },
  };
}

/** The point where the line from the center of a to the center of b leaves box a. */
function edgePoint(a: Box, b: Box, off = 0) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  const nx = (-dy / len) * off, ny = (dx / len) * off;
  const t = Math.min(dx !== 0 ? a.w / 2 / Math.abs(dx) : 1e9, dy !== 0 ? a.h / 2 / Math.abs(dy) : 1e9);
  return { x: ax + dx * t + nx, y: ay + dy * t + ny };
}

function Edge({ a, b, label, active, off = 0, labelAt = 0.5 }: { a: Box; b: Box; label: string; active: boolean; off?: number; labelAt?: number }) {
  const p = edgePoint(a, b, off), q = edgePoint(b, a, -off);
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
  const c = active ? "var(--c4)" : "var(--faint)";
  const mx = p.x + (q.x - p.x) * labelAt, my = p.y + (q.y - p.y) * labelAt;
  const tx = q.x - ux * 3, ty = q.y - uy * 3;
  return (
    <g>
      <line x1={p.x} y1={p.y} x2={tx} y2={ty} stroke={c} strokeWidth={active ? 2 : 1.2} />
      <path d={`M${q.x},${q.y} L${q.x - ux * 8 - uy * 4},${q.y - uy * 8 + ux * 4} L${q.x - ux * 8 + uy * 4},${q.y - uy * 8 - ux * 4} Z`} fill={c} />
      <text x={mx} y={my + (off ? (off > 0 ? 13 : -6) : 4)} textAnchor="middle" style={{ fontSize: 11, fill: active ? "var(--c4)" : "var(--muted)", paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}>{label}</text>
    </g>
  );
}

export function ProcessStatesDemo() {
  const table = useRef<ProcTable>(stateMachineTable());
  const [ev, setEv] = useState<EventResult>({ ok: true, text: "All four processes are ready, and the CPU is idle. Press Schedule.", edges: [], pids: [] });
  const [reaped, setReaped] = useState<number[]>([]);
  const [ref, w] = useWidth<HTMLDivElement>();
  const t = table.current;
  const act = (f: () => EventResult) => {
    const before = new Set(t.procs.keys());
    const r = f();
    setReaped((x) => [...x, ...[...before].filter((p) => !t.procs.has(p))]);
    setEv(r);
  };
  const reset = () => { table.current = stateMachineTable(); setReaped([]); setEv({ ok: true, text: "All four processes are ready, and the CPU is idle. Press Schedule.", edges: [], pids: [] }); };

  const { boxes, h } = layout(w);
  const on = (e: string) => ev.edges.includes(e);
  const procs = t.list().filter((p) => p.pid !== 1);
  const chipW = 38, chipH = 20;
  const place = (node: NodeId, i: number) => {
    const b = boxes[node];
    const cols = Math.max(1, Math.floor((b.w - 8) / (chipW + 4)));
    return { x: b.x + 6 + (i % cols) * (chipW + 4), y: b.y + 24 + Math.floor(i / cols) * (chipH + 4) };
  };
  const counts: Record<string, number> = {};
  const nodeOf = (p: Proc): NodeId => p.state as NodeId;
  const chips = [...procs.map((p) => ({ pid: p.pid, node: nodeOf(p) })), ...reaped.map((pid) => ({ pid, node: "gone" as NodeId }))]
    .map((c) => { const i = counts[c.node] ?? 0; counts[c.node] = i + 1; return { ...c, pos: place(c.node, i) }; })
    .sort((a, b) => a.pid - b.pid);
  const blocked = procs.filter((p) => p.state === "blocked" && p.reason === "io");
  const runningName = t.running === null ? "idle" : SHORT[t.running]!;

  return (
    <Demo title="One CPU, four processes" actions={<button className="btn ghost" onClick={reset}>Reset</button>}>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn primary" onClick={() => act(() => t.schedule())}>Schedule</button>
        <button className="btn" onClick={() => act(() => t.block())}>Block on I/O</button>
        <button className="btn" onClick={() => act(() => t.exit())}>Exit</button>
        <button className="btn" onClick={() => act(() => t.wait())}>Call wait</button>
        {blocked.map((p) => <button key={p.pid} className="btn" style={{ borderColor: PROC_COLOR[p.pid] }} onClick={() => act(() => t.ioDone(p.pid))}>I/O done: {SHORT[p.pid]}</button>)}
      </div>
      <Msg warn={!ev.ok} min={38}>{ev.text}</Msg>
      <div ref={ref}>
        <svg width={w} height={h} style={{ display: "block" }}>
          <Edge a={boxes.ready} b={boxes.running} label="schedule" active={on("ready>running")} off={-9} />
          <Edge a={boxes.running} b={boxes.ready} label="preempt" active={on("running>ready")} off={-9} />
          <Edge a={boxes.running} b={boxes.blocked} label="block" active={on("running>blocked")} />
          <Edge a={boxes.blocked} b={boxes.ready} label="wake" active={on("blocked>ready")} />
          <Edge a={boxes.running} b={boxes.zombie} label="exit" active={on("running>zombie")} />
          <Edge a={boxes.zombie} b={boxes.gone} label="parent waits" active={on("zombie>gone")} />
          {(Object.keys(boxes) as NodeId[]).map((id) => {
            const b = boxes[id];
            return (
              <g key={id}>
                <rect x={b.x + 0.5} y={b.y + 0.5} width={b.w - 1} height={b.h - 1} rx={6} fill={id === "running" ? tint("var(--c3)", 10) : id === "zombie" ? tint("var(--c4)", 8) : "var(--bg)"} stroke={id === "running" ? "var(--c3)" : id === "zombie" ? "var(--c4)" : "var(--border)"} />
                <text x={b.x + 7} y={b.y + 16} style={{ fontSize: 11.5, fill: "var(--muted)" }}>{NODE_LABEL[id]}</text>
              </g>
            );
          })}
          {chips.map((c) => (
            <g key={c.pid} style={{ transform: `translate(${c.pos.x}px, ${c.pos.y}px)`, transition: "transform 0.35s ease" }} opacity={c.node === "gone" ? 0.45 : 1}>
              <rect width={chipW} height={chipH} rx={4} fill={PROC_COLOR[c.pid]} stroke={ev.pids.includes(c.pid) ? "var(--fg)" : "none"} strokeWidth={1.5} />
              <text x={chipW / 2} y={14} textAnchor="middle" style={{ fontSize: 11, fill: "var(--bg)", fontWeight: 550 }}>{SHORT[c.pid]}</text>
            </g>
          ))}
        </svg>
      </div>
      <div style={{ margin: "8px 0" }}>
        <Cap>What ps would print. R covers both running and ready, because Linux has one state for both.</Cap>
        <table style={{ ...mono, fontSize: 12, borderCollapse: "collapse", width: "100%", maxWidth: 360 }}>
          <thead><tr style={{ color: "var(--muted)", textAlign: "left" }}><th style={{ fontWeight: 400 }}>PID</th><th style={{ fontWeight: 400 }}>PPID</th><th style={{ fontWeight: 400 }}>STAT</th><th style={{ fontWeight: 400 }}>CMD</th></tr></thead>
          <tbody>
            {t.list().map((p) => (
              <tr key={p.pid} style={{ color: p.state === "zombie" ? "var(--c4)" : undefined }}>
                <td>{p.pid}</td><td>{p.ppid}</td><td>{statLetter(p)}</td><td>{p.name}{p.state === "zombie" ? " <defunct>" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Stats items={[
        { label: "on the CPU", value: runningName },
        { label: "context switches", value: t.stats.switches },
        { label: "zombies", value: t.zombies().length },
        { label: "reaped", value: t.stats.reaped },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------------------- the tree

const NODE_W = 52, NODE_H = 32, ROW = 56;

function treePositions(t: ProcTable, w: number) {
  const pos = new Map<number, { x: number; y: number }>();
  const leaves = (pid: number): number => { const c = t.children(pid); return c.length === 0 ? 1 : c.reduce((a, k) => a + leaves(k.pid), 0); };
  const total = leaves(1);
  const unit = Math.max(NODE_W + 3, (w - 2) / total);
  const walk = (pid: number, x0: number, depth: number) => {
    const span = leaves(pid) * unit;
    pos.set(pid, { x: x0 + span / 2 - NODE_W / 2, y: 2 + depth * ROW });
    let x = x0;
    for (const c of t.children(pid)) { walk(c.pid, x, depth + 1); x += leaves(c.pid) * unit; }
  };
  walk(1, 0, 0);
  return { pos, width: total * unit };
}

const INITIAL_TREE_TEXT = "Click a process to select it, then kill it or make it call wait.";

export function ProcessTreeDemo() {
  const table = useRef<ProcTable>(treeTable());
  const [sel, setSel] = useState(410);
  const [ev, setEv] = useState<EventResult>({ ok: true, text: INITIAL_TREE_TEXT, edges: [], pids: [] });
  const [, force] = useState(0);
  const [ref, w] = useWidth<HTMLDivElement>();
  const t = table.current;
  const { pos } = treePositions(t, w);
  const maxY = Math.max(...[...pos.values()].map((p) => p.y)) + NODE_H + 4;
  const s = t.get(sel);
  const reset = () => { table.current = treeTable(); setSel(410); setEv({ ok: true, text: INITIAL_TREE_TEXT, edges: [], pids: [] }); };
  const act = (f: () => EventResult) => { setEv(f()); if (!table.current.get(sel)) setSel(1); };
  return (
    <Demo title="Exit, wait and re-parenting" actions={<button className="btn ghost" onClick={reset}>Reset</button>}>
      <Msg warn={!ev.ok} min={38}>{ev.text}</Msg>
      <div ref={ref}>
        <svg width={w} height={maxY} style={{ display: "block" }}>
          {t.list().filter((p) => p.pid !== 1).map((p) => {
            const a = pos.get(p.ppid), b = pos.get(p.pid);
            if (!a || !b) return null;
            const changed = ev.pids.includes(p.pid);
            return <line key={p.pid} x1={a.x + NODE_W / 2} y1={a.y + NODE_H} x2={b.x + NODE_W / 2} y2={b.y} stroke={changed ? "var(--c2)" : "var(--faint)"} strokeWidth={changed ? 2 : 1} />;
          })}
          {t.list().map((p) => {
            const q = pos.get(p.pid)!;
            const z = p.state === "zombie";
            return (
              <g key={p.pid} onClick={() => setSel(p.pid)} style={{ cursor: "pointer", transform: `translate(${q.x}px, ${q.y}px)`, transition: "transform 0.35s ease" }}>
                <rect x={0.5} y={0.5} width={NODE_W - 1} height={NODE_H - 1} rx={5} fill={z ? tint("var(--c4)", 14) : p.pid === 1 ? tint("var(--c5)", 14) : "var(--bg)"} stroke={sel === p.pid ? "var(--fg)" : z ? "var(--c4)" : p.subreaper ? "var(--c2)" : "var(--border)"} strokeWidth={sel === p.pid ? 2 : 1} strokeDasharray={z ? "3 2" : undefined} />
                <text x={NODE_W / 2} y={13} textAnchor="middle" style={{ fontSize: 11, fill: z ? "var(--c4)" : "var(--fg)" }}>{p.name}</text>
                <text x={NODE_W / 2} y={26} textAnchor="middle" style={{ fontSize: 10.5, fill: "var(--muted)", ...mono }}>{z ? `Z ${p.pid}` : p.pid}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="row" style={{ margin: "10px 0" }}>
        <span style={{ fontSize: 12.5 }}>Selected: <b style={{ fontWeight: 600 }}>{s ? `${s.name} (${s.pid})` : "none"}</b></span>
        <button className="btn" style={{ color: "var(--c4)", borderColor: "var(--c4)" }} onClick={() => act(() => t.kill(sel))}>Kill</button>
        <button className="btn" onClick={() => act(() => t.wait(sel))}>Call wait</button>
        <label style={{ fontSize: 12.5, display: "inline-flex", gap: 5, alignItems: "center" }}>
          <input type="checkbox" disabled={!s || sel === 1} checked={!!s?.subreaper} onChange={(e) => { if (s) { s.subreaper = e.target.checked; force((x) => x + 1); } }} /> subreaper
        </label>
        <label style={{ fontSize: 12.5, display: "inline-flex", gap: 5, alignItems: "center" }}>
          <input type="checkbox" disabled={!s || sel === 1} checked={!!s?.ignoresSigchld} onChange={(e) => { if (s) { s.ignoresSigchld = e.target.checked; force((x) => x + 1); } }} /> ignores SIGCHLD
        </label>
      </div>
      <Stats items={[
        { label: "processes in the table", value: t.procs.size },
        { label: "zombies", value: t.zombies().length },
        { label: "children re-parented", value: t.stats.reparented },
        { label: "reaped by PID 1", value: t.stats.reapedByInit },
        { label: "reaped by others", value: t.stats.reaped - t.stats.reapedByInit },
      ]} />
      <Note>A dashed box is a zombie. An orange box is a subreaper. An orange line marks a process that the last event moved.</Note>
    </Demo>
  );
}
