/** Lesson: userspace. TinyOS, the composed capstone, and a register stepper for the syscall path. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Demo, Param, Stats, range, toggle, Banner, IndexButtons, IndexSlider, Panel, SmallLabel, mono, tint } from "../../kit";
import { hexShort, hexVa } from "../../sims/os/vm/addr";
import { INJECT_LABEL, PROGRAMS, REG_ORDER, SYS_ENTRY_REGS, TINY_SFMASK, TINY_STAR, TinyOS, hexN, sysEntrySnaps, sysretSelectors, syscallSelectors, type FrameKind, type Inject, type LogLine, type Task } from "../../sims/os/kernel";
import { UNMOVABLE, FREE } from "../../sims/os/vm/physmem";
import { Gantt, jobColor } from "./SchedulingGantt";
import { Chip, LogBox, Msg, ModeBar, RegCell, RegGrid } from "./KernelUi";

const taskColor = (pid: number) => jobColor(pid - 1);
const hx = (v: bigint) => `0x${hexShort(v)}`;

function frameStyle(os: TinyOS, f: number): { background: string; opacity?: number } {
  const o = os.phys.owner[f]!;
  if (o === FREE) return { background: "var(--subtle)" };
  if (o === UNMOVABLE) return { background: "var(--muted)", opacity: os.frameKind.get(f) === "ktable" ? 1 : 0.55 };
  const k = os.frameKind.get(f) as FrameKind | undefined;
  return { background: taskColor(o), opacity: k === "table" ? 0.45 : k === "kstack" ? 0.7 : 1 };
}

const INJECTS: Inject[] = ["read-kernel", "write-kernel", "write-own-text", "read-unmapped", "non-canonical", "write-kernel-ptr", "read-own-data"];
const STATE_COLOR: Record<string, string> = { running: "var(--c3)", ready: "var(--fg)", sleeping: "var(--muted)", dead: "var(--c4)" };
const LOG_COLOR: Record<LogLine["kind"], string | undefined> = { boot: undefined, syscall: "var(--c5)", fault: "var(--c2)", sched: "var(--c1)", irq: undefined, kill: "var(--c4)", load: "var(--c3)" };

export function TinyOsDemo() {
  const ref = useRef<TinyOS | null>(null);
  if (!ref.current) ref.current = new TinyOS();
  const os = ref.current;
  const [, force] = useState(0);
  const [running, setRunning] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [speed, setSpeed] = useState(3);
  const logEnd = useRef<HTMLDivElement>(null);
  const render = () => force((n) => n + 1);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => { os.run(speed); render(); }, 120);
    return () => clearInterval(id);
  }, [running, speed, os]);
  useEffect(() => {
    const el = logEnd.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  });
  const act = (f: () => void) => { f(); render(); };
  const reset = () => { ref.current = new TinyOS(); setRunning(false); setSel(null); render(); };
  const load = (n: string) => act(() => { const p = os.spawn(n); if (p !== null) setSel(p); });
  const tasks = [...os.tasks.values()];
  const t: Task | null = sel !== null ? os.tasks.get(sel) ?? null : null;
  const off = !os.booted && !os.busy;
  const bad = os.invariants();
  const maps = t && t.state !== "dead" ? os.mappings(t) : [];
  const windowStart = Math.max(0, os.cycle - 180);
  const rows = tasks.filter((x) => os.segs.some((g) => g.end > windowStart && g.pid === x.pid)).slice(-5).map((x) => ({
    label: `${x.pid}`,
    segs: os.segs.filter((g) => g.pid === x.pid && g.end > windowStart).map((g) => ({ start: g.start, end: g.end, color: taskColor(x.pid), faint: g.kernel })),
  }));
  const ring3 = os.ring === 3;
  const recentLog = os.log.slice(-60);
  const chunks = os.console.slice(-80);
  return (
    <Demo
      title="TinyOS"
      actions={<>
        <button className="btn" disabled={off} onClick={() => act(() => os.step())}>Step</button>
        <button className="btn" disabled={!os.booted} onClick={() => act(() => os.run(12))}>Step 12</button>
        <button className={`btn${running ? "" : " primary"}`} disabled={!os.booted} onClick={() => setRunning(!running)}>{running ? "Pause" : "Run"}</button>
        <button className="btn ghost" onClick={reset}>Reset</button>
      </>}
      controls={<>
        <Param spec={range({ label: "Run speed: steps per display update", min: 1, max: 12, step: 1, default: 3 })} value={speed} onChange={(v) => setSpeed(v as number)} />
      </>}
    >
      <div className="row" style={{ flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
        <button className={`btn${off ? " primary" : ""}`} disabled={os.booted || os.busy} onClick={() => act(() => os.boot())}>Boot</button>
        <span className="muted" style={{ fontSize: 12 }}>Load:</span>
        {PROGRAMS.map((p) => <button key={p.name} className="btn" title={p.about} disabled={!os.booted} onClick={() => load(p.name)}>{p.name}</button>)}
      </div>
      <ModeBar mode={ring3 ? "user" : "kernel"} userLabel="ring 3: user code" kernelLabel={ring3 ? "ring 0: kernel" : os.modeLabel === "off" ? "machine off" : os.modeLabel} />
      <Msg min={44}><span style={{ display: "block", marginTop: 6 }}>{os.last}</span></Msg>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Current</span>
        {os.current ? <Chip color={taskColor(os.current.pid)}>{os.current.pid} {os.current.name}</Chip> : <Chip faint>{os.booted ? "idle" : "none"}</Chip>}
        <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>Run queue</span>
        {os.runq.length === 0 && <span className="muted" style={{ fontSize: 12 }}>empty</span>}
        {os.runq.map((p) => <Chip key={p} color={taskColor(p)}>{p}</Chip>)}
        <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>Sleeping</span>
        {os.sleepers.length === 0 && <span className="muted" style={{ fontSize: 12 }}>none</span>}
        {os.sleepers.map((p) => <Chip key={p} color={taskColor(p)} faint>{p} until {os.tasks.get(p)!.wakeAt}</Chip>)}
      </div>

      <SmallLabel>Tasks. Click a row to select it.</SmallLabel>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%", ...mono }}>
          <thead><tr>{["pid", "name", "state", "instr", "bytes", "faults", "frames"].map((h) => <th key={h} style={{ textAlign: "left", fontWeight: 500, color: "var(--muted)", borderBottom: "1px solid var(--border)", padding: "1px 6px 1px 0" }}>{h}</th>)}</tr></thead>
          <tbody>
            {tasks.slice(-6).map((x) => (
              <tr key={x.pid} onClick={() => setSel(x.pid)} style={{ cursor: "pointer", background: x.pid === sel ? "var(--subtle)" : undefined }}>
                <td style={{ padding: "1px 6px 1px 0", color: taskColor(x.pid), fontWeight: 600 }}>{x.pid}</td><td>{x.name}</td><td style={{ color: STATE_COLOR[x.state] }}>{x.state}</td><td>{x.retired}</td><td>{x.bytesWritten}</td><td>{x.faultsHandled}</td><td>{os.framesOf(x.pid).length}</td>
              </tr>
            ))}
            {tasks.length === 0 && <tr><td colSpan={7} className="muted">none: boot, and then load a program</td></tr>}
          </tbody>
        </table>
      </div>
      {t && t.exit && t.state === "dead" && <div style={{ fontSize: 12, color: "var(--c4)", marginTop: 3 }}>pid {t.pid}: {t.exit}</div>}
      <div className="row" style={{ flexWrap: "wrap", gap: 4, margin: "6px 0 10px" }}>
        <button className="btn" disabled={!t || t.state === "dead"} style={{ color: "var(--c4)", borderColor: "var(--c4)" }} onClick={() => t && act(() => os.kill(t.pid))}>Kill {t && t.state !== "dead" ? `pid ${t.pid}` : "task"}</button>
        {INJECTS.map((i) => <button key={i} className="btn" style={{ fontSize: 12, padding: "1px 7px" }} disabled={!t || t.state === "dead"} onClick={() => t && act(() => os.injectBug(t.pid, i))} title={`At its next user step, the task ${INJECT_LABEL[i]}.`}>{i === "read-kernel" ? "touch kernel memory" : INJECT_LABEL[i]}</button>)}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <SmallLabel>Console (COM1)</SmallLabel>
          <LogBox height={96}>
            {chunks.length === 0 && <span className="muted">no output</span>}
            {chunks.map((c, i) => <span key={i} style={{ color: c.pid ? taskColor(c.pid) : undefined }}>{c.text}</span>)}
          </LogBox>
          <SmallLabel><span style={{ display: "block", marginTop: 8 }}>System calls</span></SmallLabel>
          <LogBox height={210}>
            {os.syscalls.length === 0 && <span className="muted">none yet</span>}
            {os.syscalls.slice(-30).reverse().map((c, i) => <div key={i}><span style={{ color: taskColor(c.pid) }}>{c.pid}</span> {c.name}({c.args}) = <span style={{ color: c.ret.startsWith("-") ? "var(--c4)" : undefined }}>{c.ret}</span></div>)}
          </LogBox>
        </div>
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <SmallLabel>Page table of {t && t.state !== "dead" ? `pid ${t.pid}` : "the selected task"}</SmallLabel>
          <div style={{ ...mono, fontSize: 11, lineHeight: 1.45, border: "1px solid var(--border)", borderRadius: 6, padding: "3px 6px", minHeight: 92 }}>
            {maps.length === 0 && <div className="muted">no task selected</div>}
            {maps.map((m) => <div key={m.va.toString()} style={{ display: "flex", justifyContent: "space-between", gap: 6, flexWrap: "wrap" }}><span>{hexVa(m.va).replace("0x0000_", "0x")}</span><span>{m.rights}</span><span>frame {m.pfn}</span><span className="muted">{m.name}</span></div>)}
            {t && t.state !== "dead" && <>
              <div className="muted" style={{ marginTop: 3 }}>PML4[511]: shared kernel half, U = 0</div>
              <div className="muted">tables: {os.ownTables(t).join(", ")}</div>
            </>}
          </div>
          <SmallLabel><span style={{ display: "block", marginTop: 8 }}>Physical frames, {os.totalFrames} in all. {os.booted ? `${os.freeFrames} are free.` : ""}</span></SmallLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(32, minmax(0, 1fr))", gap: 1 }} role="img" aria-label="Frame owners">
            {Array.from({ length: os.totalFrames }, (_, f) => <div key={f} title={`frame ${f}`} style={{ ...frameStyle(os, f), aspectRatio: "1" }} />)}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>Grey: kernel. Each task has its color, and its table frames are paler.</div>
        </div>
      </div>

      <SmallLabel><span style={{ display: "block", marginTop: 10 }}>CPU registers and kernel state</span></SmallLabel>
      <RegGrid min={136}>
        {REG_ORDER.map((r) => <RegCell key={r} name={r} value={hx(os.regs[r])} />)}
        <RegCell name="cs" value={hexN(os.cs)} />
        <RegCell name="cr3 (frame)" value={os.cr3 || "–"} />
        <RegCell name="cr2" value={hx(os.cr2)} />
        <RegCell name="TSS.RSP0" value={hx(os.tssRsp0)} />
      </RegGrid>

      {rows.length > 0 && <>
        <SmallLabel><span style={{ display: "block", marginTop: 10 }}>Who had the CPU. Tall: user code. Thin: the kernel on its behalf. Last 180 steps.</span></SmallLabel>
        <Gantt rows={rows} start={windowStart} end={Math.max(os.cycle, windowStart + 1)} unit="" rowH={14} labelW={20} />
      </>}
      <SmallLabel><span style={{ display: "block", marginTop: 8 }}>Kernel log</span></SmallLabel>
      <LogBox height={110}>
        {recentLog.length === 0 && <span className="muted">empty</span>}
        {recentLog.map((l, i) => <div key={i} style={{ color: LOG_COLOR[l.kind] }}><span className="muted">{l.cycle} </span>{l.text}</div>)}
        <div ref={logEnd} />
      </LogBox>
      <Stats items={[
        { label: "steps", value: os.cycle },
        { label: "ticks", value: os.ticks },
        { label: "live tasks", value: os.live().length },
        { label: "dead tasks", value: tasks.length - os.live().length },
      ]} />
      <Banner tone={bad.length ? "bad" : "good"}>{bad.length ? `Invariant broken: ${bad[0]}` : "Invariants hold: each frame has one owner, no task can reach another task's frame, and the run queue holds only ready tasks."}</Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- syscall stepper

export function SyscallEntryDemo() {
  const [k, setK] = useState(0);
  const [swapgs, setSwapgs] = useState(true);
  const [maskIf, setMaskIf] = useState(true);
  const snaps = useMemo(() => sysEntrySnaps({ swapgs, maskIf }), [swapgs, maskIf]);
  const kk = Math.min(k, snaps.length - 1);
  const s = snaps[kk]!;
  const entry = syscallSelectors(TINY_STAR), ret = sysretSelectors(TINY_STAR);
  return (
    <Demo
      title="syscall to sysretq, register by register"
      actions={<IndexButtons k={kk} n={snaps.length} set={setK} />}
      controls={<>
        <IndexSlider k={kk} n={snaps.length} set={setK} />
        <Param spec={toggle({ label: "Entry code runs swapgs", default: true })} value={swapgs} onChange={(v) => setSwapgs(v as boolean)} />
        <Param spec={toggle({ label: "SFMASK clears IF", default: true })} value={maskIf} onChange={(v) => setMaskIf(v as boolean)} />
      </>}
    >
      <ModeBar mode={s.ring === 3 ? "user" : "kernel"} userLabel="ring 3" kernelLabel="ring 0" />
      <div style={{ fontSize: 13.5, fontWeight: 600, margin: "8px 0 2px", color: s.bad ? "var(--c4)" : undefined }}>{s.title}</div>
      <Msg warn={s.bad} min={74}>{s.text}</Msg>
      <div style={{ ...mono, fontSize: 12.5, padding: "2px 8px", background: tint("var(--c5)", 10), border: "1px solid var(--border)", borderRadius: 4, marginBottom: 8 }}>{s.asm}</div>
      <RegGrid min={150}>
        {SYS_ENTRY_REGS.map((r) => <RegCell key={r} name={r === "gsBase" ? "GS base" : r === "kernelGsBase" ? "KERNEL_GS_BASE" : r} value={s.regs[r]} hot={s.changed.includes(r)} />)}
      </RegGrid>
      <Panel title="MSRs that the kernel set at boot" style={{ marginTop: 10 }}>
        <div style={{ ...mono, fontSize: 11, lineHeight: 1.5, overflowWrap: "anywhere" }}>
          <div>STAR = {hexN(TINY_STAR, 16)} <span className="muted">syscall: CS {hexN(entry.cs)}, SS {hexN(entry.ss)}. sysretq: CS {hexN(ret.cs)}, SS {hexN(ret.ss)}</span></div>
          <div>LSTAR = syscall_entry</div>
          <div>SFMASK = {hexN(TINY_SFMASK)} <span className="muted">clears AC, DF, IF, TF</span></div>
        </div>
      </Panel>
    </Demo>
  );
}
