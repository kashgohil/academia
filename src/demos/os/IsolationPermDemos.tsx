/** Demos for "users, permissions and capabilities": the check stepper, the setuid walk and the capability calculator. */
import { useMemo, useState } from "react";
import { Demo } from "../../kit";
import {
  S_ISGID, S_ISUID, S_ISVTX, caps, capable, checkPermission, classBits, execCred, execveCaps, makeCred, mayDelete, modeString, newFileGid, permClass, seteuid, setuid,
  ALL_CAPS, NO_CAPS, type Cap, type CapSet, type Cred, type ExecFile, type Inode, type PermClass, type ProcCaps, type Want,
} from "../../sims/os/isolation";
import { Badge, Card, Note, Scroll, Verdict, mono, smallTable, td, th, twoCol } from "./IsolationUi";

// ---------------- the permission check ----------------

const USERS: [number, string][] = [[0, "root"], [1000, "alice"], [1001, "bob"]];
const GROUPS: [number, string][] = [[0, "root"], [100, "devs"], [200, "staff"]];
const nameOf = (l: [number, string][], id: number) => l.find(([i]) => i === id)?.[1] ?? String(id);

interface PermState { uid: number; gid: number; mode: number; isDir: boolean; pUid: number; pGid: number; groups: number[]; dacCap: boolean; want: Want }
const PRESETS: { id: string; label: string; s: PermState }[] = [
  { id: "plain", label: "Group read", s: { uid: 1001, gid: 100, mode: 0o640, isDir: false, pUid: 1000, pGid: 1000, groups: [100], dacCap: false, want: "r" } },
  { id: "owner", label: "Owner locked out", s: { uid: 1000, gid: 100, mode: 0o077, isDir: false, pUid: 1000, pGid: 1000, groups: [100], dacCap: false, want: "r" } },
  { id: "negative", label: "Group blocks, other allows", s: { uid: 1001, gid: 100, mode: 0o604, isDir: false, pUid: 1000, pGid: 1000, groups: [100], dacCap: false, want: "r" } },
  { id: "root", label: "Root, mode 000", s: { uid: 1001, gid: 100, mode: 0o000, isDir: false, pUid: 0, pGid: 0, groups: [], dacCap: true, want: "r" } },
  { id: "rootx", label: "Root runs a file with no x", s: { uid: 1001, gid: 100, mode: 0o644, isDir: false, pUid: 0, pGid: 0, groups: [], dacCap: true, want: "x" } },
  { id: "passwd", label: "Setuid program", s: { uid: 0, gid: 0, mode: 0o4755, isDir: false, pUid: 1000, pGid: 1000, groups: [100], dacCap: false, want: "x" } },
  { id: "tmp", label: "/tmp", s: { uid: 0, gid: 0, mode: 0o1777, isDir: true, pUid: 1000, pGid: 1000, groups: [100], dacCap: false, want: "w" } },
];

const CLASSES: PermClass[] = ["owner", "group", "other"];
const BITS: [Want, number][] = [["r", 4], ["w", 2], ["x", 1]];
const SHIFT: Record<PermClass, number> = { owner: 6, group: 3, other: 0 };

const sel: React.CSSProperties = { fontSize: 12.5, maxWidth: "100%" };

function Picker({ label, value, options, onChange }: { label: string; value: number; options: [number, string][]; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, marginBottom: 4 }}>
      <span className="muted">{label}</span>
      <select style={sel} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map(([v, n]) => <option key={v} value={v}>{n} ({v})</option>)}
      </select>
    </label>
  );
}

export function IsolationPermCheckDemo() {
  const [s, setS] = useState<PermState>(PRESETS[0]!.s);
  const [preset, setPreset] = useState("plain");
  const [stepAt, setStepAt] = useState<number | null>(null);
  const up = (p: Partial<PermState>) => { setS((x) => ({ ...x, ...p })); setPreset(""); setStepAt(null); };
  const inode: Inode = { uid: s.uid, gid: s.gid, mode: s.mode, isDir: s.isDir };
  const cred: Cred = { ...makeCred(s.pUid, s.pGid, s.groups, s.dacCap ? ["CAP_DAC_OVERRIDE", "CAP_DAC_READ_SEARCH", "CAP_FOWNER", "CAP_SETUID"] : []) };
  const res = checkPermission(inode, cred, s.want);
  const shown = stepAt ?? res.steps.length;
  const done = shown >= res.steps.length;
  const cls = permClass(inode, cred);
  const after = execCred(cred, inode);
  const userList = [...USERS];
  const groupList: [number, string][] = [...GROUPS, [1000, "alice"]];
  const bobFile: Inode = { uid: 1001, gid: 1001, mode: 0o600 };
  return (
    <Demo title="One class of bits decides">
      <div className="seg" style={{ marginBottom: 10 }}>
        {PRESETS.map((p) => <button key={p.id} className={preset === p.id ? "on" : ""} onClick={() => { setS(p.s); setPreset(p.id); setStepAt(null); }}>{p.label}</button>)}
      </div>
      <div style={twoCol}>
        <Card title="The file">
          <div style={{ ...mono, fontSize: 13, marginBottom: 8, overflowWrap: "anywhere" }}>{modeString(s.mode, s.isDir)} {nameOf(userList, s.uid)} {nameOf(groupList, s.gid)} <span className="muted">{(s.mode).toString(8).padStart(4, "0")}</span></div>
          <Picker label="Owner" value={s.uid} options={userList} onChange={(v) => up({ uid: v })} />
          <Picker label="Group" value={s.gid} options={GROUPS} onChange={(v) => up({ gid: v })} />
          <table style={{ ...smallTable, marginTop: 6, width: "auto" }}>
            <thead><tr><th style={th} />{BITS.map(([b]) => <th key={b} style={{ ...th, textAlign: "center" }}>{b}</th>)}<th style={th} /></tr></thead>
            <tbody>
              {CLASSES.map((c) => {
                const active = c === cls;
                return (
                  <tr key={c} style={{ opacity: active ? 1 : 0.38, background: active ? "var(--subtle)" : undefined }}>
                    <td style={{ ...td, fontWeight: active ? 600 : 400 }}>{c}</td>
                    {BITS.map(([b, bit]) => (
                      <td key={b} style={{ ...td, textAlign: "center" }}>
                        <input type="checkbox" aria-label={`${c} ${b}`} checked={(s.mode >> SHIFT[c] & bit) !== 0} onChange={() => up({ mode: s.mode ^ (bit << SHIFT[c]) })} />
                      </td>
                    ))}
                    <td style={{ ...td, fontSize: 11 }} className="muted">{active ? "applies" : "not read"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 6, fontSize: 12.5, gap: 10 }}>
            {([[S_ISUID, "setuid"], [S_ISGID, "setgid"], [S_ISVTX, "sticky"]] as const).map(([bit, n]) => (
              <label key={n} className="row" style={{ gap: 4 }}><input type="checkbox" checked={(s.mode & bit) !== 0} onChange={() => up({ mode: s.mode ^ bit })} />{n}</label>
            ))}
            <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={s.isDir} onChange={() => up({ isDir: !s.isDir })} />directory</label>
          </div>
        </Card>
        <Card title="The process">
          <Picker label="fsuid" value={s.pUid} options={userList} onChange={(v) => up({ pUid: v, dacCap: v === 0 ? true : s.dacCap })} />
          <Picker label="fsgid" value={s.pGid} options={groupList} onChange={(v) => up({ pGid: v })} />
          <div className="row" style={{ fontSize: 12.5, gap: 10, margin: "4px 0 8px" }}>
            <span className="muted">Groups</span>
            {GROUPS.filter(([g]) => g !== 0).map(([g, n]) => (
              <label key={g} className="row" style={{ gap: 4 }}><input type="checkbox" checked={s.groups.includes(g)} onChange={() => up({ groups: s.groups.includes(g) ? s.groups.filter((x) => x !== g) : [...s.groups, g] })} />{n}</label>
            ))}
          </div>
          <label style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12.5, marginBottom: 8 }}><input type="checkbox" style={{ marginTop: 2, flex: "none" }} checked={s.dacCap} onChange={() => up({ dacCap: !s.dacCap })} />Has CAP_DAC_OVERRIDE and CAP_DAC_READ_SEARCH</label>
          <div className="param"><span className="param-label">The access it wants</span>
            <div className="seg">{BITS.map(([b]) => <button key={b} className={s.want === b ? "on" : ""} onClick={() => up({ want: b })}>{b === "r" ? "read" : b === "w" ? "write" : "execute"}</button>)}</div>
          </div>
        </Card>
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span style={{ fontSize: 12.5 }} className="muted">The kernel's check, in order</span>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn" onClick={() => setStepAt((x) => { const cur = x ?? res.steps.length; return cur >= res.steps.length ? 1 : cur + 1; })}>Step</button>
          </span>
        </div>
        <ol style={{ margin: "6px 0 0", padding: 0, listStyle: "none" }}>
          {res.steps.map((st, i) => (
            <li key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "4px 0", borderTop: "1px solid var(--border)", opacity: i < shown ? 1 : 0.25, fontSize: 13 }}>
              <span style={{ ...mono, minWidth: 16 }} className="muted">{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0 }}><span style={mono}>{st.question}</span> <b>{st.answer ? "yes" : "no"}</b>. <span className="muted">{st.note}</span></span>
            </li>
          ))}
        </ol>
        {done && (
          <Verdict tone={res.allowed ? "good" : "bad"}>
            <b>{res.allowed ? "Allowed" : "EACCES"}</b>: the {res.cls} bits are <span style={mono}>{modeString(classBits(s.mode, res.cls)).slice(7)}</span>{res.override ? `, and ${res.override} overrides the denial` : ""}.
          </Verdict>
        )}
        <Note>
          {!s.isDir && (s.mode & S_ISUID || (s.mode & S_ISGID && s.mode & 0o010))
            ? <>If this process runs the file, its effective UID becomes {after.euid} and its effective GID becomes {after.egid}.</>
            : s.isDir
              ? <>A new file here gets group {newFileGid(inode, cred)}{s.mode & S_ISGID ? " (setgid directory)" : ""}. This process {mayDelete(inode, bobFile, cred) ? "can" : "cannot"} delete a file that bob owns here{s.mode & S_ISVTX ? " (sticky directory)" : ""}.</>
              : "With no setuid or setgid bit, running this file does not change the process IDs."}
        </Note>
      </div>
    </Demo>
  );
}

// ---------------- setuid walk ----------------

const SHADOW: Inode = { uid: 0, gid: 42, mode: 0o640 };
const PASSWD: Inode = { uid: 0, gid: 0, mode: 0o4755 };
const start = (): Cred => makeCred(1000, 1000);

export function IsolationSetuidDemo() {
  const [c, setC] = useState<Cred>(start);
  const [log, setLog] = useState<string[]>(["alice starts with all three UIDs at 1000."]);
  const act = (f: (c: Cred) => Cred | "EPERM", label: string) => {
    const r = f(c);
    if (r === "EPERM") setLog((l) => [...l, `${label}: EPERM. The new ID is not the real or the saved ID.`]);
    else { setC(r); setLog((l) => [...l, `${label}: real ${r.ruid}, effective ${r.euid}, saved ${r.suid}.`]); }
  };
  const canRead = checkPermission(SHADOW, c, "r").allowed;
  const rows: [string, number, string][] = [["real", c.ruid, "Who started this. Signals and accounting use it."], ["effective", c.euid, "What the permission checks use (through fsuid)."], ["saved", c.suid, "Lets a program come back to this ID later."]];
  return (
    <Demo title="The three UIDs of a setuid program" actions={<button className="btn ghost" onClick={() => { setC(start()); setLog(["alice starts with all three UIDs at 1000."]); }}>Reset</button>}>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn primary" onClick={() => act((x) => execCred(x, PASSWD), "execve of a setuid-root file")}>execve setuid-root file</button>
        <button className="btn" onClick={() => act((x) => seteuid(x, 1000), "seteuid(1000)")}>seteuid(1000)</button>
        <button className="btn" onClick={() => act((x) => seteuid(x, 0), "seteuid(0)")}>seteuid(0)</button>
        <button className="btn" onClick={() => act((x) => setuid(x, 1000), "setuid(1000)")}>setuid(1000)</button>
      </div>
      <div style={twoCol}>
        <Card title="Process credentials">
          <table style={smallTable}><tbody>
            {rows.map(([n, v, d]) => <tr key={n}><td style={td}>{n}</td><td style={{ ...td, ...mono, fontWeight: 600, color: v === 0 ? "var(--c4)" : "var(--fg)" }}>{v}</td><td style={{ ...td, fontSize: 11.5 }} className="muted">{d}</td></tr>)}
          </tbody></table>
          <Verdict tone={canRead ? "warn" : "none"}>Read <span style={mono}>/etc/shadow</span> ({modeString(SHADOW.mode)} root shadow): <b>{canRead ? "allowed" : "EACCES"}</b></Verdict>
        </Card>
        <Card title="What happened">
          <div style={{ ...mono, fontSize: 12, lineHeight: 1.5, maxHeight: 170, overflowY: "auto" }}>
            {log.slice(-7).map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </Card>
      </div>
    </Demo>
  );
}

// ---------------- capability calculator ----------------

const SHOW: Cap[] = ["NET_BIND_SERVICE", "NET_ADMIN", "SYS_ADMIN", "DAC_OVERRIDE", "SYS_PTRACE", "SETUID"];
const allShown: CapSet = new Set(SHOW);
const onlyShown = (s: CapSet): CapSet => new Set([...s].filter((c) => allShown.has(c)));

interface CapState { uid: number; P: CapSet; E: CapSet; I: CapSet; B: CapSet; A: CapSet; nnp: boolean; fP: CapSet; fI: CapSet; fE: boolean; hasCaps: boolean; setuidRoot: boolean }
const base = (over: Partial<CapState>): CapState => ({ uid: 1000, P: NO_CAPS, E: NO_CAPS, I: NO_CAPS, B: ALL_CAPS, A: NO_CAPS, nnp: false, fP: NO_CAPS, fI: NO_CAPS, fE: false, hasCaps: false, setuidRoot: false, ...over });
const NB = caps("NET_BIND_SERVICE");
const CAP_PRESETS: { id: string; label: string; s: CapState }[] = [
  { id: "plain", label: "Plain user", s: base({}) },
  { id: "setcap", label: "setcap +ep", s: base({ hasCaps: true, fP: NB, fE: true }) },
  { id: "ambient", label: "Ambient", s: base({ P: NB, I: NB, A: NB, E: NB }) },
  { id: "ambientfile", label: "Ambient, then a capability file", s: base({ P: NB, I: NB, A: NB, E: NB, hasCaps: true, fP: caps("SYS_PTRACE"), fE: true }) },
  { id: "root", label: "Root runs a program", s: base({ uid: 0, P: ALL_CAPS, E: ALL_CAPS }) },
  { id: "suid", label: "Setuid root", s: base({ setuidRoot: true }) },
  { id: "bounded", label: "Root with a cut bounding set", s: base({ uid: 0, P: ALL_CAPS, E: ALL_CAPS, B: caps("NET_BIND_SERVICE", "SETUID") }) },
  { id: "nnp", label: "no_new_privs", s: base({ nnp: true, hasCaps: true, fP: NB, fE: true }) },
];

type SetKey = "P" | "E" | "I" | "B" | "A";
const SET_NAMES: Record<SetKey, string> = { P: "permitted", E: "effective", I: "inheritable", B: "bounding", A: "ambient" };
const KEYS: SetKey[] = ["P", "E", "I", "B", "A"];
const toggleIn = (s: CapSet, c: Cap, on: boolean): CapSet => { const n = new Set(s); if (on) n.add(c); else n.delete(c); return n; };
const Dot = ({ on, changed }: { on: boolean; changed: boolean }) => <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: on ? "var(--c3)" : "var(--subtle)", border: `1px solid ${on ? "var(--c3)" : "var(--border)"}`, outline: changed ? "2px solid var(--c2)" : "none", outlineOffset: 1 }} />;

export function IsolationCapExecDemo() {
  const [s, setS] = useState<CapState>(CAP_PRESETS[1]!.s);
  const [preset, setPreset] = useState("setcap");
  const up = (p: Partial<CapState>) => { setS((x) => ({ ...x, ...p })); setPreset(""); };
  const proc: ProcCaps = { ruid: s.uid, euid: s.uid, permitted: s.P, effective: s.E, inheritable: s.I, bounding: s.B, ambient: s.A, noNewPrivs: s.nnp };
  const file: ExecFile = { setuid: s.setuidRoot, ownerUid: 0, hasCaps: s.hasCaps, fP: s.fP, fI: s.fI, fE: s.fE };
  const out = useMemo(() => execveCaps(proc, file), [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = out.next;
  const nextSets: Record<SetKey, CapSet> = { P: n.permitted, E: n.effective, I: n.inheritable, B: n.bounding, A: n.ambient };
  const beforeSets: Record<SetKey, CapSet> = { P: s.P, E: s.E, I: s.I, B: s.B, A: s.A };
  // Keep the kernel's invariants while the learner edits: E and A inside P, and A inside I.
  const toggleBefore = (k: SetKey, c: Cap) => {
    const on = !beforeSets[k].has(c);
    const next = { ...beforeSets, [k]: toggleIn(beforeSets[k], c, on) } as Record<SetKey, CapSet>;
    if (on && (k === "E" || k === "A")) next.P = toggleIn(next.P, c, true);
    if (on && k === "A") next.I = toggleIn(next.I, c, true);
    if (!on && k === "P") { next.E = toggleIn(next.E, c, false); next.A = toggleIn(next.A, c, false); }
    if (!on && k === "I") next.A = toggleIn(next.A, c, false);
    up(next);
  };
  const cell: React.CSSProperties = { ...td, textAlign: "center", padding: "3px 2px" };
  const label: React.CSSProperties = { ...td, fontSize: 11, ...mono, padding: "3px 4px", whiteSpace: "nowrap" };
  const bindOk = capable(n, "NET_BIND_SERVICE");
  return (
    <Demo title="execve applied to all five capability sets">
      <div className="seg" style={{ marginBottom: 10 }}>
        {CAP_PRESETS.map((p) => <button key={p.id} className={preset === p.id ? "on" : ""} onClick={() => { setS(p.s); setPreset(p.id); }}>{p.label}</button>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))", gap: 10 }}>
        <Card title="Process before execve">
          <Scroll><table style={smallTable}>
            <thead><tr><th style={th} />{KEYS.map((k) => <th key={k} title={SET_NAMES[k]} style={{ ...th, textAlign: "center", padding: "2px" }}>{k}</th>)}</tr></thead>
            <tbody>{SHOW.map((c) => (
              <tr key={c}><td style={label}>{c}</td>{KEYS.map((k) => <td key={k} style={cell}><input type="checkbox" aria-label={`${SET_NAMES[k]} ${c}`} checked={beforeSets[k].has(c)} onChange={() => toggleBefore(k, c)} /></td>)}</tr>
            ))}</tbody>
          </table></Scroll>
          <div className="row" style={{ marginTop: 8, fontSize: 12.5, gap: 10 }}>
            <label className="row" style={{ gap: 4 }}>UID <select style={sel} value={s.uid} onChange={(e) => up({ uid: Number(e.target.value) })}><option value={1000}>1000</option><option value={0}>0</option></select></label>
            <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={s.nnp} onChange={() => up({ nnp: !s.nnp })} />no_new_privs</label>
          </div>
        </Card>
        <Card title="The file">
          <Scroll><table style={smallTable}>
            <thead><tr><th style={th} /><th style={{ ...th, textAlign: "center" }}>F(P)</th><th style={{ ...th, textAlign: "center" }}>F(I)</th></tr></thead>
            <tbody>{SHOW.map((c) => (
              <tr key={c}><td style={label}>{c}</td>
                <td style={cell}><input type="checkbox" aria-label={`file permitted ${c}`} disabled={!s.hasCaps} checked={s.fP.has(c)} onChange={() => up({ fP: toggleIn(s.fP, c, !s.fP.has(c)) })} /></td>
                <td style={cell}><input type="checkbox" aria-label={`file inheritable ${c}`} disabled={!s.hasCaps} checked={s.fI.has(c)} onChange={() => up({ fI: toggleIn(s.fI, c, !s.fI.has(c)) })} /></td>
              </tr>
            ))}</tbody>
          </table></Scroll>
          <div className="row" style={{ marginTop: 8, fontSize: 12.5, gap: 10 }}>
            <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={s.hasCaps} onChange={() => up({ hasCaps: !s.hasCaps })} />has file caps</label>
            <label className="row" style={{ gap: 4 }}><input type="checkbox" disabled={!s.hasCaps} checked={s.fE} onChange={() => up({ fE: !s.fE })} />F(effective)</label>
            <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={s.setuidRoot} onChange={() => up({ setuidRoot: !s.setuidRoot })} />setuid root</label>
          </div>
        </Card>
        <Card title="Process after execve">
          <Scroll><table style={smallTable}>
            <thead><tr><th style={th} />{KEYS.map((k) => <th key={k} style={{ ...th, textAlign: "center", padding: "2px" }}>{k}&prime;</th>)}</tr></thead>
            <tbody>{SHOW.map((c) => (
              <tr key={c}><td style={label}>{c}</td>{KEYS.map((k) => <td key={k} style={cell}><Dot on={nextSets[k].has(c)} changed={nextSets[k].has(c) !== beforeSets[k].has(c)} /></td>)}</tr>
            ))}</tbody>
          </table></Scroll>
          <Note>An orange ring means that the bit changed. Effective UID after execve: {n.euid}.</Note>
        </Card>
      </div>
      <div style={{ marginTop: 10 }}>
        <Scroll>
          <table style={smallTable}><tbody>
            {out.trace.map((t) => (
              <tr key={t.set}><td style={{ ...td, whiteSpace: "nowrap" }}><b>P&prime;({t.set})</b></td><td style={{ ...td, fontSize: 12 }}><span style={mono}>{t.formula}</span> <span className="muted">= {t.value.size === 0 ? "empty" : t.value.size >= ALL_CAPS.size ? "all" : [...onlyShown(t.value)].join(", ") || "none shown"}</span></td></tr>
            ))}
          </tbody></table>
        </Scroll>
        <Verdict tone={bindOk ? "good" : "none"}>Can the new program bind port 80? <b>{bindOk ? "Yes" : "No"}</b>: <span style={mono}>capable(CAP_NET_BIND_SERVICE)</span> reads the effective set. {out.privilegedFile && s.A.size > 0 ? <Badge tone="warn">ambient cleared</Badge> : null} {out.rootRule ? <Badge tone="info">root rule applied</Badge> : null}</Verdict>
      </div>
    </Demo>
  );
}
