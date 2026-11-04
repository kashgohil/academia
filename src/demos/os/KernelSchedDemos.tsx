/** Lesson: a simple scheduler. Kernel threads at stack level, and the run queue against an interrupt. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, select, toggle } from "../../kit";
import { CALLEE, RACE_LABEL, queueOf, raceProg, raceReport, schedSnaps, type KRow, type RaceMode, type SchedMode, type SchedSnap } from "../../sims/os/kernel";
import { Chip, Cap, Msg, Note, RegCell, StepButtons, StepSlider, Verdict, mono, seg, tint } from "./KernelUi";
import { SyncStepper } from "./SyncShared";

const TC: Record<string, string> = { A: "var(--c1)", B: "var(--c2)", C: "var(--c3)", idle: "var(--muted)" };
const KIND_LABEL: Record<KRow["kind"], string> = { fake: "fabricated", callee: "saved register", ret: "return address", cpu: "pushed by the CPU", stub: "pushed by the stub" };
const KIND_COLOR: Record<KRow["kind"], string> = { fake: "var(--c4)", callee: "var(--c5)", ret: "var(--c5)", cpu: "var(--c1)", stub: "var(--c2)" };
const short = (v: string) => v.replace("thread_trampoline", "trampoline").replace("into schedule()", "schedule").replace("0xffffc9", "…").replace(/^k\d+\./, "k.");

function ThreadStack({ t, s }: { t: SchedSnap["threads"][number]; s: SchedSnap }) {
  const on = s.cur === t.name;
  const c = TC[t.name] ?? "var(--fg)";
  const rows = [...t.stack].reverse();
  return (
    <div style={{ flex: "1 1 145px", minWidth: 0, border: `1px solid ${on ? c : "var(--border)"}`, borderRadius: 6, padding: "3px 5px", background: on ? tint(c, 6) : undefined }}>
      <div style={{ fontSize: 12, display: "flex", justifyContent: "space-between", gap: 4 }}>
        <b style={{ color: c, fontWeight: 600 }}>{t.name}</b>
        <span className="muted">{on ? "on CPU" : t.state}</span>
      </div>
      <div className="muted" style={{ ...mono, fontSize: 10 }}>saved rsp {t.savedRsp === null ? "–" : `…${t.savedRsp.toString(16).slice(-5)}`}</div>
      <div style={{ ...mono, fontSize: 10, lineHeight: 1.3, marginTop: 2, height: 186, overflow: "hidden" }}>
        {rows.length === 0 && <div className="muted">(empty)</div>}
        {rows.map((r) => (
          <div key={r.addr.toString()} title={KIND_LABEL[r.kind]} style={{ display: "flex", justifyContent: "space-between", gap: 3, borderLeft: `3px solid ${KIND_COLOR[r.kind]}`, paddingLeft: 3, background: on && s.rsp === r.addr ? tint(c, 24) : undefined }}>
            <span className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label.replace("15 registers", "15 regs")}</span>
            <span style={{ whiteSpace: "nowrap" }}>{short(r.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function KernelSchedDemo() {
  const [k, setK] = useState(0);
  const [mode, setMode] = useState<SchedMode>("preemptive");
  const [sti, setSti] = useState(true);
  const [aYields, setAYields] = useState(false);
  const snaps = useMemo(() => schedSnaps({
    mode, sti,
    threads: [{ name: "A", prog: aYields ? "yielder" : "hog" }, { name: "B", prog: "yielder" }, { name: "C", prog: "sleeper" }],
  }), [mode, sti, aYields]);
  const kk = Math.min(k, snaps.length - 1);
  const s = snaps[kk]!;
  const prev = snaps[Math.max(0, kk - 1)]!;
  const jump = (title: string) => {
    for (let i = 1; i <= snaps.length; i++) {
      const j = (kk + i) % snaps.length;
      if (snaps[j]!.title.startsWith(title)) { setK(j); return; }
    }
  };
  const hl = s.phase === "switch" ? "var(--c4)" : s.phase === "start" ? "var(--c4)" : undefined;
  return (
    <Demo
      title="Kernel threads on one CPU"
      actions={<StepButtons k={kk} n={snaps.length} set={setK} />}
      controls={<>
        <StepSlider k={kk} n={snaps.length} set={setK} />
        <Param spec={seg<SchedMode>("Kernel", [["preemptive", "preemptive"], ["cooperative", "cooperative"]], "preemptive")} value={mode} onChange={(v) => setMode(v as SchedMode)} />
        <Param spec={toggle({ label: "The trampoline runs sti", default: true })} value={sti} onChange={(v) => setSti(v as boolean)} />
        <Param spec={toggle({ label: "A calls yield() in its loop", default: false })} value={aYields} onChange={(v) => setAYields(v as boolean)} />
      </>}
    >
      <div className="row" style={{ flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Jump to the next:</span>
        {[["Timer IRQ", "timer IRQ"], ["Load rsp", "switch"], ["ret into", "first run"], ["iretq", "iretq"]].map(([t, l]) => <button key={t} className="btn" style={{ padding: "0 8px", fontSize: 12 }} onClick={() => jump(t!)}>{l}</button>)}
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2, color: hl }}>{s.title}</div>
      <Msg min={58}>{s.text}</Msg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Run queue</span>
        {s.runq.length === 0 && <span className="muted" style={{ fontSize: 12 }}>empty</span>}
        {s.runq.map((n) => <Chip key={n} color={TC[n]}>{n}</Chip>)}
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>Sleeping</span>
        {s.sleepers.length === 0 && <span className="muted" style={{ fontSize: 12 }}>none</span>}
        {s.sleepers.map((z) => <Chip key={z.name} color={TC[z.name]} faint>{z.name} until tick {z.wakeAt}</Chip>)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {s.threads.map((t) => <ThreadStack key={t.name} t={t} s={s} />)}
      </div>
      <Cap><span style={{ display: "block", marginTop: 8 }}>CPU. A red frame marks a change in this step.</span></Cap>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 3 }}>
        <RegCell name="rip" value={s.rip.replace("thread_trampoline", "trampoline")} hot={s.rip !== prev.rip} style={{ gridColumn: "span 2" }} />
        <RegCell name="rsp" value={`…${s.rsp.toString(16).slice(-6)}`} hot={s.rsp !== prev.rsp} />
        <RegCell name="IF" value={s.ifFlag ? 1 : 0} hot={s.ifFlag !== prev.ifFlag} />
        {CALLEE.map((r) => <RegCell key={r} name={r} value={short(s.regs[r])} hot={s.regs[r] !== prev.regs[r]} />)}
      </div>
      <Stats items={[
        { label: "tick", value: s.tick },
        { label: "A, B, C runs", value: s.threads.slice(0, 3).map((t) => t.runs).join(", ") },
        { label: "console", value: <span style={mono}>{s.console || "–"}</span> },
      ]} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 11.5, marginTop: 6 }}>
        {(Object.keys(KIND_LABEL) as KRow["kind"][]).map((x) => <span key={x}><span style={{ display: "inline-block", width: 9, height: 9, background: KIND_COLOR[x], marginRight: 4 }} />{KIND_LABEL[x]}</span>)}
      </div>
      <Note>The light band in a stack is the slot that rsp points to. The 15 saved registers appear as one row of 120 bytes. Periods and sleep times are model inputs.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- race

const SCHEMA_MODES = (Object.keys(RACE_LABEL) as RaceMode[]);

export function IrqRaceDemo() {
  const [mode, setMode] = useState<RaceMode>("none");
  const prog = useMemo(() => raceProg(mode), [mode]);
  const rep = useMemo(() => raceReport(mode), [mode]);
  const scripts = [
    ...(rep.violation ? [{ label: "Show a corrupting schedule", schedule: rep.violation.schedule }] : []),
    ...(rep.stuck ? [{ label: "Show the deadlock", schedule: rep.stuck.schedule }] : []),
  ];
  return (
    <SyncStepper
      title="A thread and an interrupt both enqueue"
      prog={prog}
      scripts={scripts}
      hideRegs={[]}
      controls={<Param spec={select<RaceMode>({ label: "Protection", options: SCHEMA_MODES.map((m) => ({ value: m, label: RACE_LABEL[m] })), default: "none" })} value={mode} onChange={(v) => setMode(v as RaceMode)} />}
      panel={(v) => {
        const q = queueOf(v.s.mem);
        return (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>Queue from head:</span>
            {q.map((n, i) => <span key={i} style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>{i > 0 && <span className="muted">→</span>}<Chip color={n === "A" ? "var(--c1)" : n === "B" ? "var(--c2)" : undefined}>{n}</Chip></span>)}
            <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>tail = {["none", "A", "B", "R"][v.s.mem.tail ?? 0]}</span>
            {mode.includes("two") ? null : <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>One CPU: once the IRQ starts, the thread cannot run until it ends.</span>}
          </div>
        );
      }}
      verdict={(v) => {
        if (!v.finished) return null;
        const q = queueOf(v.s.mem);
        return q.length === 3 ? { tone: "good", text: `All three nodes are in the queue: ${q.join(", ")}.` } : { tone: "bad", text: `A node is lost. The queue is ${q.join(", ")}. A thread that is not in the queue never runs again.` };
      }}
      footer={
        <>
          <Stats items={[
            { label: "all schedules", value: rep.total },
            { label: "correct", value: rep.good },
            { label: "corrupt queue", value: rep.corrupt },
            { label: "deadlock", value: rep.deadlock },
            { label: "states searched", value: rep.explored.states },
          ]} />
          <Verdict tone={rep.corrupt || rep.deadlock ? "bad" : "good"}>
            {rep.corrupt ? "Exhaustive search finds a corrupt queue." : rep.deadlock ? "Exhaustive search finds a deadlock: the handler spins on a lock that the thread under it holds." : "Exhaustive search finds no bad schedule."}
          </Verdict>
        </>
      }
    />
  );
}
