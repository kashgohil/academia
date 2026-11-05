/** Demos for "namespaces": nested PID namespaces, the uid_map translator, and a veth and bridge packet trace. */
import { useMemo, useRef, useState } from "react";
import { Demo, Param, range, useParams, useWidth, Banner, Note, Panel, mono, seg, type Tone } from "../../kit";
import {
  MAP_PRESETS, NetSim, OVERFLOW_UID, PidWorld, displayedInside, formatMap, parseMap, toOutside, validateMap, type Hop, type HopKind, type NsId, type PidNs, type Proc, type TraceResult,
} from "../../sims/os/isolation";
import { Badge, Scroll, smallTable, td, th, twoCol } from "./IsolationUi";

// ---------------- PID namespaces ----------------

function initialWorld() {
  const w = new PidWorld();
  const root = [...w.procs.keys()][0]!;
  w.clone(root, "sshd");
  const shim = w.clone(root, "containerd-shim");
  const app = w.clone(shim, "app", { newPid: true });
  w.clone(app, "worker-a");
  w.clone(app, "worker-b");
  w.log.length = 0;
  return w;
}

const LEVEL_COLOR = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--c3)"];
const levelColor = (l: number) => LEVEL_COLOR[l % LEVEL_COLOR.length]!;

export function IsolationPidNsDemo() {
  const worldRef = useRef<PidWorld>(null as unknown as PidWorld);
  if (!worldRef.current) worldRef.current = initialWorld();
  const w = worldRef.current;
  const [, force] = useState(0);
  const [view, setView] = useState<number>(w.rootNs);
  const [sel, setSel] = useState<number>(4); // the app process
  const [msg, setMsg] = useState("");
  const counter = useRef(0);
  const rerender = () => force((x) => x + 1);
  const selected = w.procs.get(sel);
  const alive = selected?.alive ?? false;

  const act = (f: () => string) => { try { setMsg(f()); } catch (e) { setMsg(`The call fails with ${(e as Error).message}.`); } rerender(); };
  const spawn = (newPid: boolean) => act(() => {
    const name = newPid ? `init-${++counter.current}` : `task-${++counter.current}`;
    const id = w.clone(sel, name, { newPid });
    const p = w.procs.get(id)!;
    setSel(id);
    return newPid ? `${name} is PID 1 in its new namespace, and PID ${p.pids[p.pids.length - 2]} in the parent namespace.` : `${name} has PID ${p.pids[p.pids.length - 1]} in its own namespace.`;
  });
  const kill = () => act(() => {
    const p = w.procs.get(sel)!;
    if (p.id === [...w.procs.keys()][0]) return "This is the host's PID 1. The kernel panics if it exits, so this demo refuses.";
    const isInit = w.spaces.get(p.ns)!.init === sel;
    const died = w.exit(sel);
    if (isInit) { if (view === p.ns || w.spaces.get(view)!.dead) setView(w.spaces.get(p.ns)!.parent!); }
    setSel(p.parent ?? [...w.procs.keys()][0]!);
    return isInit ? `PID 1 of that namespace exited. The kernel killed all ${died.length - 1} other process(es) in it and in the namespaces below it.` : `${p.name} exited. Its children move to PID 1 of its namespace.`;
  });

  const childSpaces = (id: number) => [...w.spaces.values()].filter((s) => s.parent === id && [...w.procs.values()].some((p) => p.alive && w.chain(p.ns).some((c) => c.id === s.id)));
  const procsOf = (id: number) => [...w.procs.values()].filter((p) => p.alive && p.ns === id);

  const nsBox = (ns: PidNs) => {
    const col = levelColor(ns.level);
    const inView = w.chain(ns.id).some((c) => c.id === view);
    return (
      <div key={ns.id} onClick={(e) => { e.stopPropagation(); setView(ns.id); }} style={{ border: `1.5px solid ${col}`, borderRadius: 6, padding: "6px 8px", marginTop: 6, cursor: "pointer", opacity: inView ? 1 : 0.42, background: view === ns.id ? "var(--subtle)" : "transparent" }}>
        <div className="row" style={{ justifyContent: "space-between", fontSize: 11.5 }}>
          <span style={{ color: col, fontWeight: 600 }}>level {ns.level}{ns.level === 0 ? " (host)" : ""}</span>
          <span className="muted" style={{ ...mono, fontSize: 10.5 }}>pid:[{ns.ino}]</span>
        </div>
        <div className="row" style={{ gap: 4, marginTop: 4 }}>
          {procsOf(ns.id).map((p) => {
            const pid = p.pids[ns.level]!;
            const isSel = p.id === sel;
            return (
              <button key={p.id} onClick={(e) => { e.stopPropagation(); setSel(p.id); }} style={{ ...mono, fontSize: 11.5, padding: "2px 6px", borderRadius: 4, border: `1px solid ${isSel ? "var(--fg)" : "var(--border)"}`, background: isSel ? "var(--fg)" : "var(--bg)", color: isSel ? "var(--bg)" : "var(--fg)", cursor: "pointer" }}>
                {pid} {p.name}
              </button>
            );
          })}
        </div>
        {childSpaces(ns.id).map((c) => nsBox(c))}
      </div>
    );
  };

  const visible = w.visibleFrom(view);
  const hiddenCount = [...w.procs.values()].filter((p) => p.alive).length - visible.length;
  const viewNs = w.spaces.get(view)!;
  return (
    <Demo title="One process, one PID in each namespace" actions={<button className="btn ghost" onClick={() => { worldRef.current = initialWorld(); setView(worldRef.current.rootNs); setSel(4); setMsg(""); counter.current = 0; rerender(); }}>Reset</button>}>
      <div className="row" style={{ marginBottom: 6 }}>
        <button className="btn" disabled={!alive} onClick={() => spawn(false)}>fork</button>
        <button className="btn primary" disabled={!alive} onClick={() => spawn(true)}>clone(CLONE_NEWPID)</button>
        <button className="btn" disabled={!alive} onClick={kill}>exit</button>
        <span className="muted" style={{ fontSize: 12 }}>acts on {selected?.name ?? "nothing"}</span>
      </div>
      <div style={twoCol}>
        <div style={{ minWidth: 0 }}>
          {nsBox(w.spaces.get(w.rootNs)!)}
          <Note>Click a process to select it. Click a box to look from that namespace. Dim boxes cannot be seen from there.</Note>
        </div>
        <div style={{ minWidth: 0, display: "grid", gap: 8, alignContent: "start", marginTop: 6 }}>
          <Panel title={<>ps from level {viewNs.level}: {visible.length} visible, {hiddenCount} hidden</>}>
            <Scroll style={{ maxHeight: 230, overflowY: "auto" }}>
              <table style={smallTable}>
                <thead><tr><th style={th}>PID</th><th style={th}>name</th></tr></thead>
                <tbody>{visible.map((p: Proc) => <tr key={p.id} style={{ fontWeight: p.id === sel ? 600 : 400 }}><td style={{ ...td, ...mono }}>{w.pidIn(p.id, view)}</td><td style={td}>{p.name}</td></tr>)}</tbody>
              </table>
            </Scroll>
          </Panel>
          {selected && alive && (
            <Panel title={<>struct pid of {selected.name}: one number per level</>}>
              <table style={smallTable}><tbody>
                {w.chain(selected.ns).map((s) => <tr key={s.id}><td style={{ ...td, color: levelColor(s.level) }}>level {s.level}</td><td style={{ ...td, ...mono, fontWeight: 600 }}>{selected.pids[s.level]}</td></tr>)}
                <tr><td style={td}>getppid()</td><td style={{ ...td, ...mono }}>{w.getppid(sel)}{w.getppid(sel) === 0 ? " (parent is outside)" : ""}</td></tr>
              </tbody></table>
            </Panel>
          )}
        </div>
      </div>
      {msg && <Banner tone="info">{msg}</Banner>}
    </Demo>
  );
}

// ---------------- uid_map translator ----------------

const SCALE_IN = 70000, SCALE_OUT = 170000;

export function IsolationUidMapDemo() {
  const P = useParams("iso-uidmap", {
    inside: range({ label: "UID inside the container", min: 0, max: 65535, step: 1, default: 33 }),
  });
  const [text, setText] = useState(formatMap(MAP_PRESETS[1]!.lines));
  const [preset, setPreset] = useState<string>("rootless");
  const lines = useMemo(() => { try { return parseMap(text); } catch { return []; } }, [text]);
  const err = validateMap(lines.map((l) => ({ ...l }))) ?? (lines.some((l) => [l.inside, l.outside, l.length].some((v) => !Number.isFinite(v))) ? "Each line needs three numbers." : null);
  const good = err === null;
  const id = P.values.inside;
  const host = good ? toOutside(lines, id) : null;
  const [svgRef, measured] = useWidth<HTMLDivElement>();
  const W = Math.max(280, measured), H = 150;
  const xIn = (v: number) => 10 + (Math.min(v, SCALE_IN) / SCALE_IN) * (W - 20);
  const xOut = (v: number) => 10 + (Math.min(v, SCALE_OUT) / SCALE_OUT) * (W - 20);
  const samples = [0, 33, 1000, 65534];
  const hostFiles: [number, string][] = [[0, "/etc/shadow on the host"], [1000, "alice's home"], [100033, "a file the container made"], [200000, "another tenant's file"]];
  const note = MAP_PRESETS.find((p) => p.id === preset)?.note;
  return (
    <Demo title="Translating IDs through uid_map" controls={<Param spec={P.schema.inside} value={id} onChange={(v) => P.set("inside", v as number)} />}>
      <div className="seg" style={{ marginBottom: 8 }}>
        {MAP_PRESETS.map((p) => <button key={p.id} className={preset === p.id ? "on" : ""} onClick={() => { setPreset(p.id); setText(formatMap(p.lines)); }}>{p.label}</button>)}
      </div>
      <div style={twoCol}>
        <label style={{ minWidth: 0, display: "block" }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>/proc/&lt;pid&gt;/uid_map: inside outside length</div>
          <textarea value={text} spellCheck={false} rows={3} onChange={(e) => { setText(e.target.value); setPreset(""); }} style={{ ...mono, width: "100%", boxSizing: "border-box", fontSize: 13, border: "1px solid var(--border)", borderRadius: 4, padding: 6, background: "var(--bg)", color: "var(--fg)" }} />
          {err ? <Banner tone="bad">write() fails with EINVAL. {err}</Banner> : note && <Note>{note}</Note>}
        </label>
        <Panel title="The chosen ID">
          <div style={{ ...mono, fontSize: 14 }}>inside {id} <span className="muted">→</span> <b style={{ color: host === null ? "var(--c4)" : "var(--c3)" }}>{host === null ? "no mapping" : `host ${host}`}</b></div>
          <Note>{host === null ? "A process cannot switch to this UID, and a file cannot be chowned to it." : host === 0 ? "This is real root on the host." : "On the host, this process is an ordinary user."}</Note>
        </Panel>
      </div>
      <div ref={svgRef} style={{ marginTop: 8 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: "block", maxWidth: "100%" }} role="img" aria-label="Map from container IDs to host IDs">
        <text x={10} y={14} style={{ fontSize: 12, fill: "var(--muted)" }}>Container IDs, 0 to {SCALE_IN.toLocaleString("en-US")}</text>
        <rect x={10} y={20} width={W - 20} height={14} fill="var(--subtle)" stroke="var(--border)" />
        <text x={10} y={H - 2} style={{ fontSize: 12, fill: "var(--muted)" }}>Host IDs, 0 to {SCALE_OUT.toLocaleString("en-US")}</text>
        <rect x={10} y={110} width={W - 20} height={14} fill="var(--subtle)" stroke="var(--border)" />
        {good && lines.map((l, i) => {
          const a0 = xIn(l.inside), a1 = Math.max(a0 + 2, xIn(l.inside + l.length));
          const b0 = xOut(l.outside), b1 = Math.max(b0 + 2, xOut(l.outside + l.length));
          const col = i === 0 ? "var(--c1)" : "var(--c5)";
          return (
            <g key={i}>
              <polygon points={`${a0},34 ${a1},34 ${b1},110 ${b0},110`} fill={col} opacity={0.18} />
              <rect x={a0} y={20} width={a1 - a0} height={14} fill={col} opacity={0.75} />
              <rect x={b0} y={110} width={b1 - b0} height={14} fill={col} opacity={0.75} />
            </g>
          );
        })}
        <line x1={xIn(id)} x2={host === null ? xIn(id) : xOut(host)} y1={27} y2={host === null ? 60 : 117} stroke={host === null ? "var(--c4)" : "var(--fg)"} strokeWidth={2} />
        <circle cx={xIn(id)} cy={27} r={4} fill="var(--fg)" />
        {host !== null && <circle cx={xOut(host)} cy={117} r={4} fill="var(--fg)" />}
      </svg>
      </div>
      <div style={{ ...twoCol, marginTop: 8 }}>
        <Scroll><table style={smallTable}>
          <thead><tr><th style={th}>inside</th><th style={th}>on the host</th></tr></thead>
          <tbody>{samples.map((s) => { const h = good ? toOutside(lines, s) : null; return <tr key={s}><td style={{ ...td, ...mono }}>{s}</td><td style={{ ...td, ...mono }}>{h ?? "no mapping"}</td></tr>; })}</tbody>
        </table></Scroll>
        <Scroll><table style={smallTable}>
          <thead><tr><th style={th}>host owner</th><th style={th}>ls -l inside shows</th></tr></thead>
          <tbody>{hostFiles.map(([u, d]) => { const v = good ? displayedInside(lines, u) : OVERFLOW_UID; return <tr key={u}><td style={{ ...td }}><span style={mono}>{u}</span> <span className="muted" style={{ fontSize: 11 }}>{d}</span></td><td style={{ ...td, ...mono }}>{v === OVERFLOW_UID ? `${v} (nobody)` : v}</td></tr>; })}</tbody>
        </table></Scroll>
      </div>
    </Demo>
  );
}

// ---------------- network namespaces ----------------

const NODES: Record<string, { x: number; y: number; label: string; sub?: string }> = {
  "red/lo": { x: 40, y: 62, label: "lo" },
  "red/eth0": { x: 130, y: 62, label: "eth0", sub: "172.17.0.2" },
  "blue/eth0": { x: 330, y: 62, label: "eth0", sub: "172.17.0.3" },
  "blue/lo": { x: 420, y: 62, label: "lo" },
  "host/veth-r": { x: 130, y: 158, label: "veth-r" },
  "host/veth-b": { x: 330, y: 158, label: "veth-b" },
  "host/docker0": { x: 230, y: 208, label: "docker0", sub: "172.17.0.1" },
  "host/eth0": { x: 330, y: 268, label: "eth0", sub: "192.168.1.10" },
  "host/lo": { x: 110, y: 268, label: "lo" },
  "wire/eth0": { x: 330, y: 338, label: "network" },
};
const EDGES: [string, string, "veth" | "port" | "route"][] = [
  ["red/eth0", "host/veth-r", "veth"], ["blue/eth0", "host/veth-b", "veth"],
  ["host/veth-r", "host/docker0", "port"], ["host/veth-b", "host/docker0", "port"],
  ["host/docker0", "host/eth0", "route"], ["host/eth0", "wire/eth0", "route"],
];
const HOP_TONE: Record<HopKind, Tone> = { route: "info", arp: "warn", veth: "info", bridge: "info", flood: "warn", stack: "info", nat: "warn", deliver: "good", drop: "bad", wire: "good" };
const keyOf = (h: Hop) => `${h.ns}/${h.dev}`;
const nodeW = (n: { sub?: string; label: string }) => (n.sub ? 92 : n.label === "lo" ? 40 : 76);
const NODE_NS: { id: NsId; label: string; x: number; y: number; w: number; h: number; color: string }[] = [
  { id: "red", label: "namespace red", x: 12, y: 14, w: 200, h: 84, color: "var(--c4)" },
  { id: "blue", label: "namespace blue", x: 248, y: 14, w: 200, h: 84, color: "var(--c1)" },
  { id: "host", label: "host namespace", x: 12, y: 124, w: 436, h: 180, color: "var(--muted)" },
];

const SRC = seg<NsId>("From", [["red", "red"], ["blue", "blue"], ["host", "host"]], "red");

export function IsolationNetNsDemo() {
  const P = useParams("iso-netns", {
    from: SRC,
    to: seg<string>("To", [["172.17.0.3", "172.17.0.3 (blue)"], ["172.17.0.2", "172.17.0.2 (red)"], ["172.17.0.1", "172.17.0.1 (bridge)"], ["127.0.0.1", "127.0.0.1"], ["8.8.8.8", "8.8.8.8"]], "172.17.0.3"),
  });
  const simRef = useRef<NetSim>(null as unknown as NetSim);
  if (!simRef.current) simRef.current = new NetSim();
  const sim = simRef.current;
  const [forward, setForward] = useState(true);
  const [masq, setMasq] = useState(true);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [at, setAt] = useState(0);
  const send = () => { sim.ipForward = forward; sim.masquerade = masq; setTrace(sim.send(P.values.from, P.values.to)); setAt(0); };
  const reset = () => { simRef.current = new NetSim(); setTrace(null); setAt(0); };
  const hops = trace?.hops ?? [];
  const cur = hops[at];
  const curKey = cur ? keyOf(cur) : null;
  const pos = curKey && NODES[curKey] ? NODES[curKey]! : null;
  const visited = new Set(hops.slice(0, at + 1).map(keyOf));
  const fdb = [...sim.fdb.entries()];
  return (
    <Demo title="A packet through veth pairs and a bridge" actions={<button className="btn ghost" onClick={reset}>Clear tables</button>} controls={<>
      <Param spec={P.schema.from} value={P.values.from} onChange={(v) => { P.set("from", v as NsId); setTrace(null); }} />
      <Param spec={P.schema.to} value={P.values.to} onChange={(v) => { P.set("to", v as string); setTrace(null); }} />
      <label className="param" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><input type="checkbox" checked={forward} onChange={() => setForward(!forward)} /><span>net.ipv4.ip_forward = 1</span></label>
      <label className="param" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><input type="checkbox" checked={masq} onChange={() => setMasq(!masq)} /><span>MASQUERADE rule on eth0</span></label>
    </>}>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn primary" onClick={send}>Send packet</button>
        <button className="btn" disabled={!trace || at >= hops.length - 1} onClick={() => setAt((a) => a + 1)}>Next hop</button>
        {trace && <span className="muted" style={{ fontSize: 12 }}>hop {Math.min(at + 1, hops.length)} of {hops.length}</span>}
      </div>
      <svg viewBox="0 0 460 362" style={{ width: "100%", maxWidth: 560, display: "block", margin: "0 auto" }} role="img" aria-label="Two network namespaces joined to a bridge in the host namespace">
        {NODE_NS.map((n) => (
          <g key={n.id}>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={6} fill="none" stroke={n.color} strokeWidth={1.3} />
            <text x={n.x + 8} y={n.y + 15} style={{ fontSize: 13, fill: n.color, fontWeight: 600 }}>{n.label}</text>
          </g>
        ))}
        {EDGES.map(([a, b, k]) => {
          const A = NODES[a]!, B = NODES[b]!;
          return <line key={a + b} x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={visited.has(a) && visited.has(b) ? "var(--c2)" : "var(--faint)"} strokeWidth={k === "veth" ? 3 : 1.6} strokeDasharray={k === "route" ? "4 3" : undefined} />;
        })}
        {Object.entries(NODES).map(([k, n]) => {
          const active = k === curKey;
          return (
            <g key={k}>
              <rect x={n.x - nodeW(n) / 2} y={n.y - 17} width={nodeW(n)} height={n.sub ? 36 : 26} rx={4} fill={active ? "var(--fg)" : "var(--bg)"} stroke={visited.has(k) ? "var(--c2)" : "var(--border)"} />
              <text x={n.x} y={n.y + (n.sub ? -3 : 1)} textAnchor="middle" style={{ fontSize: 13, fontWeight: 550, fill: active ? "var(--bg)" : "var(--fg)" }}>{n.label}</text>
              {n.sub && <text x={n.x} y={n.y + 12} textAnchor="middle" style={{ fontSize: 11.5, fill: active ? "var(--bg)" : "var(--muted)" }}>{n.sub}</text>}
            </g>
          );
        })}
        {pos && <circle cx={pos.x + nodeW(pos) / 2} cy={pos.y - 14} r={7} fill="var(--c2)" style={{ transition: "cx .25s, cy .25s" }} />}
      </svg>
      {cur ? <Banner tone={HOP_TONE[cur.kind]}><Badge tone={HOP_TONE[cur.kind]}>{cur.kind}</Badge> {cur.text}</Banner> : <Banner tone="none">Press <b>Send packet</b>, then step through the hops.</Banner>}
      {trace && at === hops.length - 1 && <Note>{trace.ok ? `Delivered in ${trace.deliveredIn}. The receiver sees source ${trace.seenSrc}.` : "The packet did not arrive."} ARP requests: {trace.arps}. Floods: {trace.floods}.</Note>}
      <div style={{ ...twoCol, marginTop: 8 }}>
        <Panel title="Bridge forwarding table (learned)">
          {fdb.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>empty: the first frame floods</span> : <table style={smallTable}><tbody>{fdb.map(([m, p]) => <tr key={m}><td style={{ ...td, ...mono }}>{m}</td><td style={{ ...td, ...mono }}>{p}</td></tr>)}</tbody></table>}
        </Panel>
        <Panel title="Neighbor table in the source namespace">
          {(() => { const t = [...sim.neigh.get(P.values.from)!.entries()]; return t.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>empty: the first packet needs ARP</span> : <table style={smallTable}><tbody>{t.map(([i, m]) => <tr key={i}><td style={{ ...td, ...mono }}>{[24, 16, 8, 0].map((sh) => Math.floor(i / 2 ** sh) % 256).join(".")}</td><td style={{ ...td, ...mono }}>{m}</td></tr>)}</tbody></table>; })()}
        </Panel>
      </div>
    </Demo>
  );
}
