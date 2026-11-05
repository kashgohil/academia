/** Demos for "containers": assemble a container primitive by primitive, and step through overlayfs. */
import { useMemo, useRef, useState } from "react";
import { Demo, Stats, bytes, Banner, Note, Panel, mono, type Tone } from "../../kit";
import { ALL_PRIMITIVES, Overlay, PRIMITIVES, containerView, sampleImage, type ContainerView, type OverlayEvent, type PrimitiveId } from "../../sims/os/isolation";
import { Badge, Scroll, smallTable, td, th, twoCol } from "./IsolationUi";

const ROWS: { key: string; label: string; show: (v: ContainerView) => string }[] = [
  { key: "pid", label: "getpid()", show: (v) => String(v.pid) },
  { key: "ps", label: "ps lists", show: (v) => `${v.psCount} process${v.psCount === 1 ? "" : "es"}` },
  { key: "root", label: "/ is", show: (v) => v.rootfs },
  { key: "host", label: "hostname", show: (v) => v.hostname },
  { key: "net", label: "ip link", show: (v) => v.interfaces },
  { key: "uid", label: "UID 0 on the host is", show: (v) => `UID ${v.uidOnHost}` },
  { key: "caps", label: "capabilities", show: (v) => `${v.capCount}${v.hasSysAdmin ? ", with SYS_ADMIN" : ", no SYS_ADMIN"}` },
  { key: "sys", label: "system calls", show: (v) => `${v.syscalls} of ${v.syscallsTotal} in the table` },
  { key: "mem", label: "memory.max", show: (v) => v.memoryLimit },
  { key: "pids", label: "pids.max", show: (v) => v.pidsLimit },
  { key: "kernel", label: "uname -r", show: (v) => v.kernel },
];

export function IsolationAssembleDemo() {
  const [on, setOn] = useState<ReadonlySet<PrimitiveId>>(new Set());
  const [last, setLast] = useState<PrimitiveId | null>(null);
  const [prev, setPrev] = useState<ReadonlySet<PrimitiveId>>(new Set());
  const set = (n: ReadonlySet<PrimitiveId>, changed: PrimitiveId | null) => { setPrev(on); setOn(n); setLast(changed); };
  const view = useMemo(() => containerView(on), [on]);
  const before = useMemo(() => containerView(prev), [prev]);
  const nextUp = PRIMITIVES.find((p) => !on.has(p.id));
  const toggleP = (id: PrimitiveId) => { const n = new Set(on); if (n.has(id)) n.delete(id); else n.add(id); set(n, id); };
  const done = on.size === PRIMITIVES.length;
  return (
    <Demo title="Assemble a container" actions={<>
      <button className="btn ghost" onClick={() => set(new Set(), null)}>None</button>
      <button className="btn ghost" onClick={() => set(new Set(ALL_PRIMITIVES), null)}>All</button>
    </>}>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn primary" disabled={!nextUp} onClick={() => nextUp && toggleP(nextUp.id)}>{nextUp ? `Apply: ${nextUp.label}` : "All primitives applied"}</button>
      </div>
      <div style={twoCol}>
        <div style={{ minWidth: 0 }}>
          {PRIMITIVES.map((p, i) => {
            const isOn = on.has(p.id);
            return (
              <label key={p.id} style={{ display: "flex", gap: 8, padding: "5px 6px", borderTop: "1px solid var(--border)", cursor: "pointer", background: last === p.id ? "var(--subtle)" : undefined, alignItems: "flex-start" }}>
                <input type="checkbox" checked={isOn} onChange={() => toggleP(p.id)} style={{ marginTop: 3 }} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 550 }}>{i + 1}. {p.label}</span>
                  {last === p.id && <span style={{ ...mono, display: "block", fontSize: 11, color: "var(--muted)", overflowWrap: "anywhere" }}>{p.call}</span>}
                  {last === p.id && <span style={{ display: "block", fontSize: 12.5 }}>{isOn ? p.change : p.exposed}</span>}
                </span>
              </label>
            );
          })}
        </div>
        <div style={{ minWidth: 0 }}>
          <Panel title="What the process sees">
            <table style={smallTable}><tbody>
              {ROWS.map((r) => {
                const value = r.show(view);
                const changed = r.show(before) !== value;
                return (
                  <tr key={r.key} style={{ background: changed ? "var(--subtle)" : undefined }}>
                    <td style={{ ...td, fontSize: 12 }} className="muted">{r.label}</td>
                    <td style={{ ...td, ...mono, fontSize: 12, fontWeight: changed ? 700 : 400, color: changed ? "var(--c2)" : "var(--fg)", overflowWrap: "anywhere" }}>{value}</td>
                  </tr>
                );
              })}
            </tbody></table>
          </Panel>
        </div>
      </div>
      {view.exposed.length > 0
        ? <Panel title={`Exposed with this set: ${view.exposed.length} class${view.exposed.length === 1 ? "" : "es"} of risk`} style={{ marginTop: 10 }}>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.45, maxHeight: 170, overflowY: "auto" }}>
              {view.exposed.map((e) => <li key={e}>{e}</li>)}
            </ul>
          </Panel>
        : <Banner tone="good">All primitives are on. The process still shares the kernel of the host: <span style={mono}>uname -r</span> did not change.</Banner>}
      {done || <Note>Each toggle shows a class of exposure only, not a way to use it. Turn PID on with the mount namespace off: <span style={mono}>getpid()</span> is 1, yet <span style={mono}>ps</span> still reads the host's /proc.</Note>}
    </Demo>
  );
}

// ---------------- overlayfs ----------------

const EV_TONE: Record<OverlayEvent["kind"], Tone> = { read: "info", "copy-up": "warn", write: "good", create: "good", whiteout: "warn", delete: "none", opaque: "warn", miss: "bad" };
const FILES = ["/app/server", "/app/config.yaml", "/data/seed.db", "/usr/lib/libssl.so", "/etc/passwd", "/bin/sh"];

export function IsolationOverlayDemo() {
  const ref = useRef<Overlay | null>(null);
  if (!ref.current) ref.current = new Overlay(sampleImage());
  const o = ref.current;
  const [, force] = useState(0);
  const [file, setFile] = useState("/data/seed.db");
  const [created, setCreated] = useState(false);
  const act = (f: () => void) => { f(); force((x) => x + 1); };
  const files = created ? [...FILES, "/tmp/new.log"] : FILES;
  const stack = o.stack;
  const last = o.events.slice(-2);
  const amp = o.writtenBytes > 0 ? o.copyUpBytes / o.writtenBytes : 0;
  const cell = (path: string, layerIx: number) => {
    const e = stack[layerIx]!.files.get(path);
    if (!e) return null;
    if (e.kind === "whiteout") return <span style={{ color: "var(--c4)", fontWeight: 600 }}>whiteout</span>;
    if (e.kind === "dir") return "dir";
    return <span>{e.content}<br /><span className="muted" style={{ fontSize: 10.5 }}>{bytes(e.size)}</span></span>;
  };
  return (
    <Demo title="overlayfs: lower layers, one upper layer, a merged view" actions={<button className="btn ghost" onClick={() => { ref.current = new Overlay(sampleImage()); setCreated(false); force((x) => x + 1); }}>Reset</button>}>
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="row" style={{ gap: 4, fontSize: 12.5 }}>File
          <select value={file} style={{ ...mono, fontSize: 12 }} onChange={(e) => setFile(e.target.value)}>{files.map((f) => <option key={f}>{f}</option>)}</select>
        </label>
        <button className="btn" onClick={() => act(() => o.read(file))}>Read</button>
        <button className="btn primary" onClick={() => act(() => o.write(file, 1, `${o.read(file)?.content ?? "new"} + 1 byte`))}>Write 1 byte</button>
        <button className="btn" onClick={() => act(() => o.remove(file))}>Delete</button>
        <button className="btn" onClick={() => act(() => { o.write("/tmp/new.log", 4096, "new log"); setCreated(true); setFile("/tmp/new.log"); })}>Create a new file</button>
      </div>
      <Scroll>
        <table style={{ ...smallTable, fontSize: 11.5, tableLayout: "fixed" }}>
          <thead><tr>
            <th style={{ ...th, width: "36%", color: "var(--c2)" }}>merged view</th>
            {stack.map((l) => <th key={l.name} style={{ ...th, padding: "2px 3px" }}>{l.name}</th>)}
          </tr></thead>
          <tbody>
            {files.map((p) => {
              const src = o.source(p);
              const srcIx = stack.findIndex((l) => l.name === src);
              const content = srcIx >= 0 ? (stack[srcIx]!.files.get(p) as { content: string }).content : null;
              return (
                <tr key={p} onClick={() => setFile(p)} style={{ cursor: "pointer", background: p === file ? "var(--subtle)" : undefined }}>
                  <td style={{ ...td, overflowWrap: "anywhere" }}><span style={{ ...mono, fontSize: 10.5 }}>{p}</span><br /><b>{content ?? <span style={{ color: "var(--c4)" }}>ENOENT</span>}</b></td>
                  {stack.map((l, ix) => (
                    <td key={l.name} style={{ ...td, padding: "3px", overflowWrap: "anywhere", outline: ix === srcIx ? "2px solid var(--c2)" : undefined, outlineOffset: -2, opacity: srcIx >= 0 && ix > srcIx ? 0.45 : 1 }}>{cell(p, ix)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroll>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "copy-ups", value: o.copyUps },
          { label: "bytes copied up", value: bytes(o.copyUpBytes) },
          { label: "bytes the program wrote", value: bytes(o.writtenBytes) },
          { label: "copied per byte written", value: amp ? amp.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "–" },
          { label: "whiteouts", value: o.whiteouts },
        ]} />
      </div>
      {last.length > 0
        ? last.map((e, i) => <Banner key={i} tone={EV_TONE[e.kind]}><Badge tone={EV_TONE[e.kind]}>{e.kind}</Badge> {e.text}</Banner>)
        : <Banner tone="none">The orange outline shows the layer that serves a read of each path. Write 1 byte to <span style={mono}>/data/seed.db</span>.</Banner>}
      <Note>The upper layer is writable, and the others are read-only. Layers fade below the outlined one, because a read never reaches them.</Note>
    </Demo>
  );
}
