import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Demo, Stats, Param, Controls, useParams, select, range, toggle, useSim, pct, MONO } from "../kit";
import { parse } from "../sims/memmodel";
import { PRESETS } from "../sims/memmodel/presets";
import { avgHops } from "../sims/interconnect";
import { simulateNuma } from "../sims/numa";
import {
  replayEvents, transitionEdges, protocolStates, lineState, COH_EVENTS, COH_EVENT_LABEL,
  falseSharing, falseSharingFrames, LINE_BYTES,
  route, hops, gridDims, networkSummary,
  directoryRun, sbTimeline, countSchedules, pageMap,
  NUMA_DEFAULTS, PLACEMENT_LABEL,
  type CohEvent, type St, type Protocol, type NetTopology, type Party, type DirKind, type Mode, type Placement,
} from "../sims/multicoreextras";

// ---------------- shared helpers ----------------

const ST_COLOR: Record<St, string> = { M: "var(--c4)", O: "var(--c5)", E: "var(--c3)", S: "var(--c1)", I: "var(--faint)" };
const ST_NAME: Record<St, string> = { M: "Modified", O: "Owned", E: "Exclusive", S: "Shared", I: "Invalid" };
const NODE_COLOR = ["var(--c1)", "var(--c3)", "var(--c2)", "var(--c5)"];

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** 0 → 1 over `ms` each time `key` changes (1 at once when the user prefers reduced motion). */
function useTween(key: unknown, ms: number) {
  const [t, setT] = useState(1);
  useEffect(() => {
    if (reducedMotion()) { setT(1); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      setT(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    setT(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [key, ms]);
  return t;
}

type P2 = [number, number];

/** A quadratic arc from a to b, bent sideways by `bend`, trimmed by r1 and r2 at the ends. */
function arc(a: P2, b: P2, bend: number, r1: number, r2: number) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const c: P2 = [mx - (dy / len) * bend, my + (dx / len) * bend];
  const trim = (p: P2, q: P2, r: number): P2 => {
    const ex = q[0] - p[0], ey = q[1] - p[1], l = Math.hypot(ex, ey) || 1;
    return [p[0] + (ex / l) * r, p[1] + (ey / l) * r];
  };
  const s = trim(a, c, r1), e = trim(b, c, r2);
  const at = (t: number): P2 => [
    (1 - t) ** 2 * s[0] + 2 * (1 - t) * t * c[0] + t * t * e[0],
    (1 - t) ** 2 * s[1] + 2 * (1 - t) * t * c[1] + t * t * e[1],
  ];
  return { d: `M${s[0]} ${s[1]} Q${c[0]} ${c[1]} ${e[0]} ${e[1]}`, at, mid: at(0.5) };
}

function Arrowhead({ id, color }: { id: string; color: string }) {
  return (
    <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0L10 5L0 10z" fill={color} />
    </marker>
  );
}

const Chip = ({ color, children, filled }: { color: string; children: ReactNode; filled?: boolean }) => (
  <span style={{ display: "inline-block", border: `1.5px solid ${color}`, background: filled ? color : "transparent", color: filled ? "var(--bg)" : color, borderRadius: 4, padding: "1px 7px", fontWeight: 600, fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>{children}</span>
);

// =====================================================================================
// Coherence lesson: the state machine of one cache line
// =====================================================================================

const SM_POS: Record<St, P2> = { M: [112, 62], E: [288, 62], S: [350, 186], I: [200, 238], O: [50, 186] };
const SM_LABEL_ABOVE: Record<St, boolean> = { M: true, E: true, S: false, I: false, O: false };

export function MesiStateMachineDemo() {
  const uid = useId().replace(/:/g, "");
  const [protocol, setProtocol] = useState<Protocol>("MESI");
  const [events, setEvents] = useState<CohEvent[]>([]);
  const edges = useMemo(() => {
    const seen = new Set<string>();
    return transitionEdges(protocol).filter((e) => {
      const mine = e.ev === "myRead" || e.ev === "myWrite";
      const k = `${e.from}${e.to}${mine}`;
      if (e.from === e.to || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [protocol]);
  const { coh, steps } = useMemo(() => replayEvents(protocol, events), [protocol, events]);
  const last = steps.at(-1);
  const t = useTween(events.length, 900);
  const states = protocolStates(protocol);
  const cur = lineState(coh, 0, 0), other = lineState(coh, 1, 0);
  const R = 24;
  return (
    <Demo
      title={`${protocol}: one cache line, seen from one core`}
      actions={
        <>
          <button className="btn" onClick={() => setEvents((x) => x.slice(0, -1))} disabled={!events.length}>Undo</button>
          <button className="btn ghost" onClick={() => setEvents([])}>Reset</button>
        </>
      }
      controls={<Param spec={select({ label: "Protocol", options: (["MSI", "MESI", "MOESI"] as const).map((p) => ({ value: p, label: p })), default: "MESI", segmented: true })} value={protocol} onChange={(v) => { setProtocol(v as Protocol); setEvents([]); }} />}
    >
      <div className="row" style={{ marginBottom: 10 }}>
        {COH_EVENTS.map((ev) => (
          <button key={ev} className="btn" style={{ borderColor: ev.startsWith("my") ? "var(--fg)" : "var(--c2)" }} onClick={() => setEvents((x) => [...x, ev])}>{COH_EVENT_LABEL[ev]}</button>
        ))}
      </div>
      <svg viewBox="0 0 400 290" style={{ width: "100%", maxWidth: 480, display: "block", margin: "0 auto" }}>
        <defs>
          <Arrowhead id={`${uid}-m`} color="var(--muted)" />
          <Arrowhead id={`${uid}-o`} color="var(--c2)" />
          <Arrowhead id={`${uid}-h`} color="var(--fg)" />
        </defs>
        {edges.map((e) => {
          const mine = e.ev === "myRead" || e.ev === "myWrite";
          const a = arc(SM_POS[e.from], SM_POS[e.to], 16, R + 2, R + 4);
          const hl = !!last && last.from === e.from && last.to === e.to && (last.ev.startsWith("my") === mine);
          const color = hl ? "var(--fg)" : mine ? "var(--muted)" : "var(--c2)";
          return (
            <g key={`${e.from}${e.to}${mine}`} opacity={last && !hl ? 0.45 : 1}>
              <path d={a.d} fill="none" stroke={color} strokeWidth={hl ? 2.6 : 1.4} strokeDasharray={mine ? undefined : "5 4"} markerEnd={`url(#${uid}-${hl ? "h" : mine ? "m" : "o"})`} />
              {hl && t < 1 && <circle cx={a.at(t)[0]} cy={a.at(t)[1]} r={5} fill="var(--fg)" />}
            </g>
          );
        })}
        {states.map((s) => {
          const [x, y] = SM_POS[s];
          const here = s === cur;
          const selfLoop = !!last && last.from === last.to && last.to === s;
          return (
            <g key={s}>
              {here && selfLoop && t < 1 && <circle cx={x} cy={y} r={R + 4 + 14 * t} fill="none" stroke="var(--fg)" strokeWidth={2} opacity={1 - t} />}
              <circle cx={x} cy={y} r={R} fill={here ? ST_COLOR[s] : "var(--bg)"} stroke={ST_COLOR[s]} strokeWidth={2} />
              <text x={x} y={y + 6} textAnchor="middle" fontSize={18} fontWeight={700} fill={here ? "var(--bg)" : ST_COLOR[s]}>{s}</text>
              <text x={x} y={SM_LABEL_ABOVE[s] ? y - R - 7 : y + R + 14} textAnchor="middle" fontSize={11} fill="var(--muted)">{ST_NAME[s]}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, margin: "6px 0 10px" }}>
        <span><svg width={26} height={8}><line x1={0} y1={4} x2={26} y2={4} stroke="var(--muted)" strokeWidth={1.6} /></svg> <span className="muted">this core reads or writes</span></span>
        <span><svg width={26} height={8}><line x1={0} y1={4} x2={26} y2={4} stroke="var(--c2)" strokeWidth={1.6} strokeDasharray="5 4" /></svg> <span className="muted">the other core reads or writes</span></span>
      </div>
      <div style={{ fontSize: 13, minHeight: 40 }}>
        {last ? (
          <>
            <b>{COH_EVENT_LABEL[last.ev]}</b>: this core {last.from} → {last.to}, other core {last.otherFrom} → {last.otherTo}.{" "}
            {last.bus ? <span style={{ color: "var(--c4)" }}>Bus: {last.bus}.</span> : <span style={{ color: "var(--c3)" }}>No bus transaction.</span>}
            <div className="muted" style={{ fontFamily: MONO, fontSize: 11.5, marginTop: 2 }}>C{last.ev.startsWith("my") ? 0 : 1} {last.text}</div>
          </>
        ) : (
          <span className="muted">Both caches start without the line (I). Click an action. The circle that is filled is the state of the line in this core.</span>
        )}
      </div>
      <Stats items={[
        { label: "this core", value: <Chip color={ST_COLOR[cur]} filled>{cur}</Chip> },
        { label: "other core", value: <Chip color={ST_COLOR[other]}>{other}</Chip> },
        { label: "bus transactions", value: coh.busTransactions },
        { label: "memory up to date", value: cur === "M" || cur === "O" || other === "M" || other === "O" ? "no" : "yes" },
      ]} />
    </Demo>
  );
}

// =====================================================================================
// Coherence lesson: false sharing by byte distance
// =====================================================================================

const fsSchema = {
  distance: range({ label: "Distance from counter A to counter B", min: 8, max: 128, step: 8, default: 8, format: (v) => `${v} bytes` }),
};

export function FalseSharingDemo() {
  const params = useParams("fs", fsSchema);
  const d = params.values.distance;
  const inc = 8;
  const frames = useMemo(() => falseSharingFrames(d, inc), [d]);
  const res = useMemo(() => falseSharing(d, inc), [d]);
  const apart = useMemo(() => falseSharing(LINE_BYTES, inc), []);
  const step = useRef(0);
  const [, force] = useState(0);
  const sim = useSim({ dt: 1 / 3, autoplay: true, step: () => { step.current = (step.current + 1) % frames.length; force((x) => x + 1); }, reset: () => { step.current = 0; } });
  useEffect(() => { step.current = 0; force((x) => x + 1); }, [d]);
  const k = Math.min(step.current, frames.length - 1);
  const f = frames[k]!;
  const lineB = Math.floor(d / LINE_BYTES);
  const slots = 24, sw = 340 / slots;
  const curLine = f.access.addr;
  const lines = lineB === 0 ? [0] : [0, lineB];
  return (
    <Demo
      title="Two counters, two cores: same cache line or not?"
      actions={<><button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn" onClick={sim.step} disabled={sim.running}>Step</button><button className="btn ghost" onClick={sim.reset}>Reset</button></>}
      controls={<Controls params={params} />}
    >
      <svg viewBox="0 0 360 74" style={{ width: "100%", maxWidth: 560, display: "block", margin: "0 auto" }}>
        {[0, 1, 2].map((l) => (
          <g key={l}>
            <rect x={10 + l * 8 * sw} y={14} width={8 * sw} height={30} rx={3} fill={lines.includes(l) && l === curLine ? "var(--subtle)" : "var(--bg)"} stroke={lines.includes(l) ? "var(--fg)" : "var(--border)"} strokeWidth={lines.includes(l) ? 1.6 : 1} />
            <text x={10 + (l + 0.5) * 8 * sw} y={10} textAnchor="middle" fontSize={10.5} fill={lines.includes(l) ? "var(--fg)" : "var(--muted)"}>line {l} ({l * 64}–{l * 64 + 63})</text>
          </g>
        ))}
        {Array.from({ length: slots }, (_, i) => <line key={i} x1={10 + i * sw} x2={10 + i * sw} y1={14} y2={44} stroke="var(--border)" strokeWidth={0.6} />)}
        <rect x={10 + 1} y={16} width={sw - 2} height={26} rx={2} fill="var(--c1)" />
        <text x={10 + sw / 2} y={33} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--bg)">A</text>
        <rect x={10 + (d / 8) * sw + 1} y={16} width={sw - 2} height={26} rx={2} fill="var(--c2)" />
        <text x={10 + (d / 8 + 0.5) * sw} y={33} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--bg)">B</text>
        <text x={10} y={62} fontSize={10.5} fill="var(--muted)">Each box is 8 bytes. Core 0 increments A. Core 1 increments B.</text>
      </svg>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, margin: "8px 0" }}>
        {[0, 1].map((core) => {
          const active = f.access.core === core;
          return (
            <div key={core} style={{ border: `${active ? 2 : 1}px solid ${active ? (core ? "var(--c2)" : "var(--c1)") : "var(--border)"}`, borderRadius: 6, padding: "8px 10px", fontSize: 12.5, minWidth: 0 }}>
              <b>Core {core}</b> <span className="muted">· counter {core ? "B" : "A"}</span>
              <div className="row" style={{ gap: 6, margin: "6px 0" }}>
                {lines.map((l) => {
                  const s = l === 0 ? f.a[core]! : f.b[core]!;
                  return <span key={l} title={ST_NAME[s]}><span className="muted" style={{ fontSize: 11 }}>line {l} </span><Chip color={ST_COLOR[s]} filled={s !== "I"}>{s}</Chip></span>;
                })}
              </div>
              <div className="muted" style={{ fontSize: 11.5, minHeight: 30 }}>
                {active ? <>{f.access.op === "R" ? "reads" : "writes"} {core ? "B" : "A"}: {f.hit ? <span style={{ color: "var(--c3)" }}>hit</span> : <span style={{ color: "var(--c4)" }}>{f.bus}</span>}</> : "waits"}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${frames.length / 2}, minmax(0, 1fr))`, gap: 2, margin: "8px 0 12px" }}>
        {frames.map((x, i) => (
          <div key={i} title={x.hit ? "hit" : `miss: ${x.bus}`} style={{ height: 16, borderRadius: 2, background: i > k ? "var(--subtle)" : x.hit ? "var(--c3)" : "var(--c4)", outline: i === k ? "2px solid var(--fg)" : undefined, opacity: i > k ? 1 : 0.85 }} />
        ))}
      </div>
      <Stats items={[
        { label: `bus transactions (${inc} increments each)`, value: res.bus },
        { label: "invalidations", value: res.invalidations },
        { label: "cycles", value: res.cycles.toLocaleString() },
        { label: "time vs separate lines", value: `${(res.cycles / apart.cycles).toFixed(1)}×` },
      ]} />
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>Green: cache hit. Red: a bus transaction. MESI, cycles from hit 4, cache-to-cache 40, upgrade 30, memory 100.</p>
    </Demo>
  );
}

// =====================================================================================
// Interconnects lesson: hop map
// =====================================================================================

const hopSchema = {
  side: range({ label: "Cores", min: 2, max: 8, step: 1, default: 4, format: (v) => `${v * v} (${v} × ${v})` }),
  topo: select<NetTopology>({ label: "Network", options: [{ value: "ring", label: "Ring" }, { value: "mesh", label: "2D mesh" }, { value: "torus", label: "2D torus" }], default: "mesh", segmented: true }),
};

export function HopMapDemo() {
  const params = useParams("hops", hopSchema);
  const k = params.values.side, n = k * k, topo = params.values.topo;
  const [sel, setSel] = useState<{ src: number; dst: number; next: "src" | "dst" }>({ src: 0, dst: 15, next: "src" });
  const src = Math.min(sel.src, n - 1), dst = Math.min(sel.dst, n - 1);
  const summary = useMemo(() => networkSummary(topo, n), [topo, n]);
  const dist = useMemo(() => Array.from({ length: n }, (_, v) => hops(topo, n, src, v)), [topo, n, src]);
  const path = useMemo(() => route(topo, n, src, dst), [topo, n, src, dst]);
  const W = 340, H = 340;
  const [rows, cols] = gridDims(n);
  const cell = (W - 60) / Math.max(rows, cols);
  const pos = (v: number): P2 => {
    if (topo === "ring") {
      const a = -Math.PI / 2 + (2 * Math.PI * v) / n;
      return [W / 2 + 138 * Math.cos(a), H / 2 + 138 * Math.sin(a)];
    }
    const r = Math.floor(v / cols), c = v % cols;
    return [30 + cell * (c + 0.5) + ((Math.max(rows, cols) - cols) * cell) / 2, 30 + cell * (r + 0.5) + ((Math.max(rows, cols) - rows) * cell) / 2];
  };
  const rad = topo === "ring" ? Math.min(15, ((Math.PI * 138) / n) * 0.62) : Math.min(16, cell * 0.3);
  const edges: [number, number][] = [];
  if (topo === "ring") for (let v = 0; v < n; v++) edges.push([v, (v + 1) % n]);
  else
    for (let v = 0; v < n; v++) {
      const c = v % cols;
      if (c < cols - 1) edges.push([v, v + 1]);
      if (v + cols < n) edges.push([v, v + cols]);
    }
  const onPath = new Set(path.slice(1).map((v, i) => `${Math.min(v, path[i]!)}-${Math.max(v, path[i]!)}`));
  const wraps: { v: number; side: "l" | "r" | "t" | "b" }[] = [];
  if (topo === "torus") {
    for (let r = 0; r < rows; r++) wraps.push({ v: r * cols, side: "l" }, { v: r * cols + cols - 1, side: "r" });
    for (let c = 0; c < cols; c++) wraps.push({ v: c, side: "t" }, { v: (rows - 1) * cols + c, side: "b" });
  }
  const wrapUsed = (v: number, side: string) =>
    path.slice(1).some((u, i) => {
      const p = path[i]!;
      const pair = (a: number, b: number) => (p === a && u === b) || (p === b && u === a);
      if (side === "l" || side === "r") { const r = Math.floor(v / cols); return cols > 2 && pair(r * cols, r * cols + cols - 1); }
      const c = v % cols;
      return rows > 2 && pair(c, (rows - 1) * cols + c);
    });
  const diam = Math.max(1, summary.diameter);
  const click = (v: number) => setSel((s) => (s.next === "src" ? { src: v, dst: s.dst === v ? src : Math.min(s.dst, n - 1), next: "dst" } : { src, dst: v, next: "src" }));
  return (
    <Demo title={`Hops on a ${topo === "ring" ? "ring" : topo === "mesh" ? "2D mesh" : "2D torus"} of ${n} cores`} controls={<Controls params={params} />}>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        Click a core to set the <b style={{ color: sel.next === "src" ? "var(--c4)" : "var(--fg)" }}>{sel.next === "src" ? "start" : "end"}</b>. The number in each core is its distance in hops from the start.
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 420, display: "block", margin: "0 auto", touchAction: "manipulation" }}>
        {edges.map(([a, b]) => {
          const hl = onPath.has(`${Math.min(a, b)}-${Math.max(a, b)}`);
          const [x1, y1] = pos(a), [x2, y2] = pos(b);
          return <line key={`${a}-${b}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={hl ? "var(--c4)" : "var(--border)"} strokeWidth={hl ? 3 : 1.4} />;
        })}
        {wraps.map(({ v, side }) => {
          const [x, y] = pos(v);
          const L = Math.min(22, cell * 0.42);
          const [dx, dy] = side === "l" ? [-L, 0] : side === "r" ? [L, 0] : side === "t" ? [0, -L] : [0, L];
          const hl = wrapUsed(v, side);
          return <line key={`${v}${side}`} x1={x} y1={y} x2={x + dx} y2={y + dy} stroke={hl ? "var(--c4)" : "var(--faint)"} strokeWidth={hl ? 3 : 1.2} strokeDasharray="3 3" />;
        })}
        {Array.from({ length: n }, (_, v) => {
          const [x, y] = pos(v);
          const isSrc = v === src, isDst = v === dst;
          return (
            <g key={v} onClick={() => click(v)} style={{ cursor: "pointer" }}>
              <circle cx={x} cy={y} r={Math.max(rad, 9)} fill="transparent" />
              <circle cx={x} cy={y} r={rad} fill="var(--bg)" />
              <circle cx={x} cy={y} r={rad} fill={isSrc ? "var(--c4)" : "var(--c1)"} fillOpacity={isSrc ? 1 : 0.78 - 0.66 * (dist[v]! / diam)} stroke={isDst ? "var(--c4)" : path.includes(v) ? "var(--c4)" : "var(--bg)"} strokeWidth={isDst ? 3 : 1.5} />
              {rad >= 8 && <text x={x} y={y + 3.5} textAnchor="middle" fontSize={Math.min(11, rad * 0.9)} fontWeight={600} fill={isSrc ? "var(--bg)" : "var(--fg)"} style={{ pointerEvents: "none" }}>{dist[v]}</text>}
            </g>
          );
        })}
      </svg>
      <div className="muted" style={{ fontSize: 12, fontFamily: MONO, margin: "6px 0 10px", overflowWrap: "anywhere" }}>route: {path.join(" → ")}</div>
      <Stats items={[
        { label: "hops, start to end", value: path.length - 1 },
        { label: "average hops", value: avgHops(topo, n).toFixed(2) },
        { label: "farthest pair", value: summary.diameter },
        { label: "links", value: summary.links },
      ]} />
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>The mesh and the torus route along the row first, then along the column. Dashed stubs on the torus are the wrap-around links to the opposite edge.</p>
    </Demo>
  );
}

// =====================================================================================
// Interconnects lesson: directory vs snooping, message by message
// =====================================================================================

const DIR_CORES = 8;
const KIND_COLOR: Record<DirKind, string> = { request: "var(--fg)", forward: "var(--c5)", data: "var(--c3)", writeback: "var(--c2)", grant: "var(--c1)", invalidate: "var(--c4)", ack: "var(--muted)" };
const DIR_SCRIPTS: { label: string; acts: { core: number; op: "R" | "W" }[] }[] = [
  { label: "All read, then C0 writes", acts: [...Array.from({ length: DIR_CORES }, (_, k) => ({ core: k, op: "R" as const })), { core: 0, op: "W" }] },
  { label: "C2 and C5 take turns to write", acts: [2, 5, 2, 5].map((core) => ({ core, op: "W" as const })) },
  { label: "C3 writes, C6 reads", acts: [{ core: 3, op: "W" }, { core: 6, op: "R" }] },
];

export function DirectoryDemo() {
  const uid = useId().replace(/:/g, "");
  const [acts, setActs] = useState<{ core: number; op: "R" | "W" }[]>([]);
  const [core, setCore] = useState(3);
  const [view, setView] = useState<"dir" | "snoop">("dir");
  const run = useMemo(() => directoryRun(DIR_CORES, "MESI", acts), [acts]);
  const last = run.steps.at(-1);
  const t = useTween(`${acts.length}-${view}`, 1500);
  const C: P2 = [180, 150];
  const corePos = (k: number): P2 => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / DIR_CORES;
    return [C[0] + 150 * Math.cos(a), C[1] + 118 * Math.sin(a)];
  };
  const at = (p: Party): P2 => (p === "home" ? C : corePos(p));
  const states = Array.from({ length: DIR_CORES }, (_, k) => lineState(run.coh, k, 0));
  const sharers = states.map((s) => (s === "I" ? 0 : 1));
  const owner = states.findIndex((s) => s === "M" || s === "E");
  const dirState = owner >= 0 ? `${states[owner]} at C${owner}` : sharers.some(Boolean) ? "S" : "I (uncached)";
  const msgs = last && view === "dir" ? last.msgs : [];
  const nm = msgs.length;
  const label = (p: Party) => (p === "home" ? "home" : `C${p}`);
  return (
    <Demo
      title="One access: messages with a directory vs a snooping bus"
      actions={<><button className="btn" onClick={() => setActs((x) => x.slice(0, -1))} disabled={!acts.length}>Undo</button><button className="btn ghost" onClick={() => setActs([])}>Reset</button></>}
      controls={
        <>
          <Param spec={select({ label: "Show", options: [{ value: "dir", label: "Directory messages" }, { value: "snoop", label: "Snooping broadcast" }], default: "dir", segmented: true })} value={view} onChange={(v) => setView(v as "dir" | "snoop")} />
          <Param spec={select({ label: "Core", options: Array.from({ length: DIR_CORES }, (_, k) => ({ value: String(k), label: `C${k}` })), default: "3", segmented: true })} value={String(core)} onChange={(v) => setCore(Number(v))} />
        </>
      }
    >
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn primary" onClick={() => setActs((x) => [...x, { core, op: "R" }])}>C{core} reads</button>
        <button className="btn primary" onClick={() => setActs((x) => [...x, { core, op: "W" }])}>C{core} writes</button>
        {DIR_SCRIPTS.map((s) => <button key={s.label} className="btn" onClick={() => setActs(s.acts)}>{s.label}</button>)}
      </div>
      <svg viewBox="0 0 360 300" style={{ width: "100%", maxWidth: 460, display: "block", margin: "0 auto" }}>
        <defs>{(Object.keys(KIND_COLOR) as DirKind[]).map((kd) => <Arrowhead key={kd} id={`${uid}-${kd}`} color={KIND_COLOR[kd]} />)}<Arrowhead id={`${uid}-b`} color="var(--c4)" /></defs>
        {view === "snoop" && last?.busTransaction && Array.from({ length: DIR_CORES }, (_, k) => k).filter((k) => k !== last.core).map((k) => {
          const a = arc(corePos(last.core), corePos(k), 0, 22, 22);
          const p = Math.min(1, t * 1.6);
          return (
            <g key={k}>
              <path d={a.d} fill="none" stroke="var(--c4)" strokeWidth={1.3} opacity={0.25 + 0.6 * p} markerEnd={`url(#${uid}-b)`} />
              {p < 1 && <circle cx={a.at(p)[0]} cy={a.at(p)[1]} r={3.5} fill="var(--c4)" />}
            </g>
          );
        })}
        {msgs.map((m, i) => {
          const a = arc(at(m.from), at(m.to), 14, m.from === "home" ? 34 : 22, m.to === "home" ? 34 : 24);
          const t0 = i / nm, t1 = (i + 1) / nm;
          if (t < t0) return null;
          const p = Math.min(1, (t - t0) / (t1 - t0));
          return (
            <g key={i}>
              <path d={a.d} fill="none" stroke={KIND_COLOR[m.kind]} strokeWidth={1.8} markerEnd={`url(#${uid}-${m.kind})`} />
              {p < 1 && <circle cx={a.at(p)[0]} cy={a.at(p)[1]} r={4} fill={KIND_COLOR[m.kind]} />}
              {nm <= 6 && <circle cx={a.mid[0]} cy={a.mid[1]} r={7} fill="var(--bg)" stroke={KIND_COLOR[m.kind]} />}
              {nm <= 6 && <text x={a.mid[0]} y={a.mid[1] + 3.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="var(--fg)">{i + 1}</text>}
            </g>
          );
        })}
        <rect x={C[0] - 66} y={C[1] - 30} width={132} height={60} rx={8} fill="var(--subtle)" stroke="var(--fg)" strokeWidth={1.4} />
        <text x={C[0]} y={C[1] - 14} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--fg)">{view === "dir" ? "home node: directory" : "shared bus"}</text>
        {view === "dir" ? (
          <>
            <text x={C[0]} y={C[1] + 3} textAnchor="middle" fontSize={11} fontFamily={MONO} fill="var(--fg)">sharers {sharers.join("")}</text>
            <text x={C[0]} y={C[1] + 19} textAnchor="middle" fontSize={10.5} fill="var(--muted)">state {dirState}</text>
          </>
        ) : (
          <text x={C[0]} y={C[1] + 8} textAnchor="middle" fontSize={10.5} fill="var(--muted)">every cache watches it</text>
        )}
        {states.map((s, k) => {
          const [x, y] = corePos(k);
          const isLast = last?.core === k;
          return (
            <g key={k} onClick={() => setCore(k)} style={{ cursor: "pointer" }}>
              <circle cx={x} cy={y} r={20} fill={s === "I" ? "var(--bg)" : ST_COLOR[s]} stroke={k === core ? "var(--fg)" : ST_COLOR[s]} strokeWidth={k === core ? 3 : 1.5} />
              <text x={x} y={y - 1} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={s === "I" ? "var(--fg)" : "var(--bg)"}>C{k}</text>
              <text x={x} y={y + 10} textAnchor="middle" fontSize={9.5} fill={s === "I" ? "var(--muted)" : "var(--bg)"}>{s}</text>
              {isLast && <circle cx={x} cy={y} r={24} fill="none" stroke="var(--fg)" strokeDasharray="2 3" />}
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: 12.5, minHeight: 54, margin: "6px 0 10px" }}>
        {!last ? (
          <span className="muted">Choose a core, then click Read or Write. The line starts uncached. Click a core in the picture to choose it.</span>
        ) : view === "dir" ? (
          nm > 6 ? (
            <span>
              {(Object.keys(KIND_COLOR) as DirKind[]).map((kd) => ({ kd, n: msgs.filter((m) => m.kind === kd).length })).filter((x) => x.n).map((x, i) => (
                <span key={x.kd}>{i ? " · " : ""}<b>{x.n}</b> <span style={{ color: KIND_COLOR[x.kd], fontWeight: 600 }}>{x.kd}</span></span>
              ))}
              <span className="muted"> ({nm} messages: one invalidation and one acknowledgement for each sharer)</span>
            </span>
          ) : nm ? (
            <ol style={{ margin: 0, paddingLeft: 20, columns: "2 150px", columnGap: 16 }}>
              {msgs.map((m, i) => <li key={i}><span style={{ color: KIND_COLOR[m.kind], fontWeight: 600 }}>{m.kind}</span> <span className="muted">{label(m.from)} → {label(m.to)}</span></li>)}
            </ol>
          ) : <span style={{ color: "var(--c3)" }}>Hit in C{last.core}: no messages at all.</span>
        ) : last.busTransaction ? (
          <span>C{last.core} puts the request on the bus. All <b>{last.snoopLookups}</b> other caches must look up the line, even the ones that do not have it.</span>
        ) : <span style={{ color: "var(--c3)" }}>Hit in C{last.core}: nothing goes on the bus.</span>}
      </div>
      <Stats items={[
        { label: "directory messages, this access", value: last ? last.msgs.length : 0 },
        { label: "snoop lookups, this access", value: last ? last.snoopLookups : 0 },
        { label: "directory messages, total", value: run.dirMsgs },
        { label: "snoop lookups, total", value: run.snoopLookups },
      ]} />
    </Demo>
  );
}

// =====================================================================================
// Consistency lesson: store-buffer timeline
// =====================================================================================

const sbtSchema = {
  drain: range({ label: "Time for a store to reach memory", min: 0, max: 30, step: 1, default: 8, format: (v) => `${v} cycles` }),
  gap: range({ label: "Core 1 starts later by", min: 0, max: 12, step: 1, default: 2, format: (v) => `${v} cycles` }),
  fence: toggle({ label: "Fence between the store and the load (MFENCE)", default: false }),
};

export function StoreBufferTimelineDemo() {
  const params = useParams("sbt", sbtSchema);
  const { drain, gap, fence } = params.values;
  const tl = sbTimeline(drain, gap, fence);
  const T = Math.max(16, tl.end + 1);
  const x0 = 54, x1 = 350;
  const X = (c: number) => x0 + (c * (x1 - x0)) / T;
  const lanes = [60, 150];
  const names = [{ st: "x = 1", ld: "r0 = y", var: "x" }, { st: "y = 1", ld: "r1 = x", var: "y" }];
  const tick = T > 30 ? 5 : 2;
  return (
    <Demo title="Store buffering on a timeline" controls={<Controls params={params} />}>
      <svg viewBox="0 0 360 214" style={{ width: "100%", maxWidth: 600, display: "block", margin: "0 auto" }}>
        {Array.from({ length: Math.floor(T / tick) + 1 }, (_, i) => i * tick).map((c) => (
          <g key={c}>
            <line x1={X(c)} x2={X(c)} y1={14} y2={190} stroke="var(--border)" strokeWidth={0.6} />
            <text x={X(c)} y={203} textAnchor="middle" fontSize={10} fill="var(--muted)">{c}</text>
          </g>
        ))}
        <text x={4} y={203} fontSize={10} fill="var(--muted)">cycle</text>
        {[0, 1].map((i) => {
          const y = lanes[i]!, o = 1 - i;
          const read = tl.r[i]!;
          const st = tl.store[i]!, vis = tl.visible[i]!, ld = tl.load[i]!;
          return (
            <g key={i}>
              <line x1={X(tl.visible[o]!)} y1={lanes[o]! - 17} x2={X(ld)} y2={y} stroke={read ? "var(--c3)" : "var(--c4)"} strokeWidth={1.2} strokeDasharray="3 3" opacity={0.75} />
              <text x={4} y={y + 4} fontSize={11.5} fontWeight={600} fill="var(--fg)">Core {i}</text>
              <line x1={x0} x2={x1} y1={y} y2={y} stroke="var(--border)" strokeWidth={1.2} />
              {/* the store waits in the buffer, then reaches memory */}
              <text x={X(st)} y={y - 28} fontSize={11} fontFamily={MONO} fill="var(--c2)">{names[i]!.st}{vis - st > 0 && X(vis) - X(st) > 120 ? " waits in the buffer" : ""}</text>
              {vis > st && <rect x={X(st)} y={y - 22} width={X(vis) - X(st)} height={9} rx={2} fill="var(--c2)" opacity={0.3} />}
              <line x1={X(vis)} x2={X(vis)} y1={y - 25} y2={y - 10} stroke="var(--c2)" strokeWidth={2.4} />
              {/* fence stall */}
              {tl.stall[i]! > 0 && <rect x={X(st + 1)} y={y - 5} width={X(ld) - X(st + 1)} height={10} fill="var(--c4)" opacity={0.22} />}
              <rect x={X(st) - 4} y={y - 7} width={8} height={14} rx={2} fill="var(--c2)" />
              <circle cx={X(ld)} cy={y} r={6.5} fill={read ? "var(--c3)" : "var(--c4)"} />
              <text x={Math.min(X(ld) - 4, x1 - 78)} y={y + 22} fontSize={11} fontFamily={MONO} fontWeight={600} fill={read ? "var(--c3)" : "var(--c4)"}>{names[i]!.ld} → {read}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, margin: "4px 0 10px" }} className="muted">
        <span><b style={{ color: "var(--c2)" }}>■</b> store runs · <b style={{ color: "var(--c2)" }}>|</b> store reaches memory{fence ? <> · <b style={{ color: "var(--c4)" }}>▬</b> fence waits</> : null}</span>
        <span><b style={{ color: "var(--c3)" }}>●</b> load sees the new value · <b style={{ color: "var(--c4)" }}>●</b> load sees the old value</span>
      </div>
      <p style={{ fontSize: 13.5, margin: "0 0 10px", color: tl.weak ? "var(--c4)" : "var(--fg)" }}>
        Result: r0 = {tl.r[0]}, r1 = {tl.r[1]}. {tl.weak ? "Both loads ran before the other store reached memory. No interleaving of the four instructions gives this result." : "Sequential consistency allows this result."}
      </p>
      <Stats items={[
        { label: "r0, r1", value: `${tl.r[0]}, ${tl.r[1]}` },
        { label: "cycles each load waits", value: fence ? `${tl.stall[0]}, ${tl.stall[1]}` : "0, 0" },
        { label: "both read 0 if the store time is more than", value: fence ? "never" : `${gap + 1} cycles` },
      ]} />
    </Demo>
  );
}

// =====================================================================================
// Consistency lesson: count every schedule
// =====================================================================================

const SCHED_PRESETS = ["sb-relaxed", "mp-relaxed", "mp-one-fence", "sb-fence-sc"];

export function ScheduleCountDemo() {
  const [preset, setPreset] = useState(SCHED_PRESETS[0]!);
  const [mode, setMode] = useState<Mode>("tso");
  const [pick, setPick] = useState<string | null>(null);
  const p = useMemo(() => parse(PRESETS[preset]!.src), [preset]);
  const res = useMemo(() => countSchedules(p, mode), [p, mode]);
  const sc = useMemo(() => new Set(countSchedules(p, "sc").outcomes.map((o) => o.key)), [p]);
  const lines = PRESETS[preset]!.src.split("\n");
  const chosen = res.outcomes.find((o) => o.key === pick) ?? res.outcomes.find((o) => !sc.has(o.key)) ?? res.outcomes[0]!;
  const short = (k: string) => k.split(" · ")[0]!;
  const max = Math.max(...res.outcomes.map((o) => o.count));
  return (
    <Demo
      title="Every possible schedule, counted"
      controls={
        <>
          <Param spec={select({ label: "Program", options: SCHED_PRESETS.map((k) => ({ value: k, label: PRESETS[k]!.label })), default: SCHED_PRESETS[0]! })} value={preset} onChange={(v) => { setPreset(v as string); setPick(null); }} />
          <Param spec={select({ label: "Store buffer", options: [{ value: "sc", label: "None (SC)" }, { value: "tso", label: "FIFO (TSO)" }, { value: "pso", label: "PSO" }], default: "tso", segmented: true })} value={mode} onChange={(v) => { setMode(v as Mode); setPick(null); }} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${p.threads.length}, minmax(0, 1fr))`, gap: 10, marginBottom: 12 }}>
        {p.threads.map((th, i) => (
          <div key={i} style={{ fontFamily: MONO, fontSize: 11.5, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", minWidth: 0, overflowWrap: "anywhere" }}>
            <b style={{ fontFamily: "inherit" }}>Core {i}</b>
            {th.map((ins, k) => <div key={k}>{lines[ins.line - 1]!.trim()}</div>)}
          </div>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>{res.schedules} different schedules. Click an outcome to see one schedule that gives it.</div>
      <div style={{ display: "grid", gap: 6 }}>
        {res.outcomes.map((o) => {
          const weak = !sc.has(o.key);
          const on = o.key === chosen.key;
          return (
            <button key={o.key} onClick={() => setPick(o.key)} style={{ all: "unset", cursor: "pointer", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 4, padding: "6px 8px", borderRadius: 6, border: `1px solid ${on ? "var(--fg)" : "var(--border)"}`, background: on ? "var(--subtle)" : "transparent" }}>
              <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{short(o.key)} {weak && <span style={{ fontFamily: "inherit", color: "var(--c4)", fontWeight: 600, fontSize: 11.5 }}>· impossible under SC</span>}</span>
              <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{o.count} of {res.schedules}</span>
              <span style={{ gridColumn: "1 / -1", height: 6, borderRadius: 3, background: "var(--subtle)", overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${(100 * o.count) / max}%`, background: weak ? "var(--c4)" : "var(--c1)" }} />
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 12, fontSize: 12.5 }}>
        <div className="muted" style={{ marginBottom: 4 }}>One schedule for <code>{short(chosen.key)}</code>:</div>
        <ol style={{ margin: 0, paddingLeft: 22 }}>
          {chosen.witness.map((s, i) => {
            if (s.kind === "drain") return <li key={i} style={{ color: "var(--c2)" }}>Core {s.core}: the store buffer writes <code>{s.loc} = {s.val}</code> to memory</li>;
            const ins = p.threads[s.core]![s.pc]!;
            const buffered = mode !== "sc" && ins.op === "store" && ins.ord !== "sc";
            return <li key={i}>Core {s.core} runs <code>{lines[ins.line - 1]!.trim()}</code>{buffered ? <span className="muted"> (into its store buffer)</span> : null}</li>;
          })}
        </ol>
      </div>
    </Demo>
  );
}

// =====================================================================================
// NUMA lesson: where the pages go
// =====================================================================================

const pmSchema = {
  threads: range({ label: "Threads", min: 2, max: 16, step: 2, default: 8 }),
  sockets: select({ label: "Sockets", options: ["2", "4"].map((v) => ({ value: v, label: v })), default: "2", segmented: true }),
  placement: select<Placement>({ label: "Placement", options: (Object.keys(PLACEMENT_LABEL) as Placement[]).map((p) => ({ value: p, label: PLACEMENT_LABEL[p] })), default: "serial-first-touch", segmented: true }),
};

export function PageMapDemo() {
  const params = useParams("pages", pmSchema);
  const { threads, placement } = params.values;
  const sockets = Number(params.values.sockets);
  const per = 8;
  const map = useMemo(() => pageMap(sockets, threads, placement, per), [sockets, threads, placement]);
  const res = simulateNuma({ ...NUMA_DEFAULTS, sockets, threads, placement });
  const [replay, setReplay] = useState(0);
  const t = useTween(`${sockets}-${threads}-${placement}-${replay}`, 1800);
  const total = map.pages.length;
  const touchAt = (p: number) => (placement === "parallel-first-touch" ? (p % per) / per : p / total);
  const perNode = Array.from({ length: sockets }, (_, j) => map.pages.filter((x) => x === j).length);
  return (
    <Demo
      title="First touch, page by page"
      actions={<button className="btn" onClick={() => setReplay((x) => x + 1)}>Replay</button>}
      controls={<Controls params={params} />}
    >
      <div className="row" style={{ gap: 12, fontSize: 12, marginBottom: 8 }}>
        {Array.from({ length: sockets }, (_, j) => <span key={j}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: NODE_COLOR[j], marginRight: 4 }} />node {j}: {perNode[j]} pages</span>)}
        <span className="muted">filled: local · hollow: remote</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `auto repeat(${per}, minmax(0, 1fr))`, gap: 3, alignItems: "center", maxWidth: 520 }}>
        {Array.from({ length: threads }, (_, th) => {
          const sock = th % sockets;
          return [
            <div key={`l${th}`} style={{ fontSize: 11, paddingRight: 6, whiteSpace: "nowrap" }}>
              <b style={{ color: NODE_COLOR[sock] }}>T{th}</b> <span className="muted">socket {sock}</span>
            </div>,
            ...Array.from({ length: per }, (_, j) => {
              const p = th * per + j;
              const node = map.pages[p]!;
              const shown = t >= touchAt(p) + 0.02 || t === 1;
              const remote = map.remote[p]!;
              return (
                <div key={p} title={shown ? `page ${p}: node ${node}${remote ? ", remote for T" + th : ", local"}` : "not touched yet"} style={{ height: 16, borderRadius: 3, display: "grid", placeItems: "center", fontSize: 9.5, fontWeight: 600, transition: "background 0.2s", background: !shown ? "var(--subtle)" : remote ? "transparent" : NODE_COLOR[node], border: `1.5px solid ${!shown ? "var(--border)" : NODE_COLOR[node]}`, color: remote ? NODE_COLOR[node] : "var(--bg)" }}>
                  {shown ? node : ""}
                </div>
              );
            }),
          ];
        })}
      </div>
      <div className="muted" style={{ fontSize: 12, margin: "8px 0 10px" }}>
        Each row is the part of the array that one thread uses later. The number in a page is the node that holds it. {placement === "serial-first-touch" ? "Thread 0 writes every page first, so every page goes to node 0." : placement === "parallel-first-touch" ? "Each thread writes its own pages first, so each page goes to the node of the thread that uses it." : "The kernel deals pages to the nodes in turn, so each thread uses every node."}
      </div>
      <Stats items={[
        { label: "pages that are remote for their thread", value: pct(map.remoteFraction, 0) },
        { label: "streaming bandwidth", value: `${Math.round(res.gbps)} GB/s` },
        { label: "average latency", value: `${Math.round(res.latency)} ns` },
        { label: "limited by", value: res.bottleneck },
      ]} />
    </Demo>
  );
}

// =====================================================================================
// NUMA lesson: the 3D machine (three.js loads only when this demo is on screen)
// =====================================================================================

const Topology = lazy(() => import("./Topology3D").then((m) => ({ default: m.Topology3DDemo })));

const Loading3D = ({ h }: { h: number }) => <div className="demo" style={{ height: h, display: "grid", placeItems: "center" }}><span className="muted" style={{ fontSize: 13 }}>Loading 3D view…</span></div>;

export function NumaTopology3DDemo() {
  return <Suspense fallback={<Loading3D h={560} />}><Topology /></Suspense>;
}

