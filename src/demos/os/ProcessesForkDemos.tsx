/** Lesson: fork and exec. A stepper for the shell pipeline, and a plot of fork time against memory. */
import { useMemo, useState } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, bytes, range, si, toggle, useParams, IndexButtons, IndexSlider, Note, SmallLabel, mono, tint } from "../../kit";
import { FORK_INPUTS, PAGE_2M, PAGE_4K, cowUs, forkExecUs, forkUs, pageTables, pipeline, spawnUs, type FrameInfo, type Task } from "../../sims/os/processes";
import { Msg, bigBytes } from "./ProcessesUi";

const ACTOR_PID = { shell: 100, left: 101, right: 102 } as const;
const fmtUs = (us: number) => (us >= 1000 ? `${(us / 1000).toPrecision(3)} ms` : `${us.toPrecision(3)} µs`);

function TaskCard({ t, active, frames, ofdName }: { t: Task; active: boolean; frames: Map<number, FrameInfo>; ofdName: (id: number) => string }) {
  return (
    <div style={{ flex: "1 1 170px", minWidth: 0, border: `1px solid ${active ? "var(--fg)" : "var(--border)"}`, borderRadius: 6, padding: "6px 8px", opacity: t.state === "exited" ? 0.55 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 12.5 }}>
        <b style={{ fontWeight: 600 }}>PID {t.pid}: {t.image}</b>
        <span className="muted" style={{ fontSize: 11.5 }}>{t.state === "exited" ? "zombie" : t.state}</span>
      </div>
      <div style={{ fontSize: 11.5, margin: "2px 0 6px" }}>
        <span className="muted">last return: </span><b style={{ ...mono, fontWeight: 600 }}>{t.ret || "–"}</b>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>fd table</div>
      <div style={{ ...mono, fontSize: 11.5, minHeight: 20 }}>
        {t.fds.length === 0 && <span className="muted">(closed)</span>}
        {t.fds.map(([n, e]) => {
          const name = ofdName(e.ofd);
          const pipe = name.startsWith("pipe");
          return <div key={n} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: pipe ? "var(--c2)" : name === "secrets.db" ? "var(--c5)" : undefined }}>{n} → {name}</div>;
        })}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>pages</div>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", minHeight: 22 }}>
        {t.pages.length === 0 && <span className="muted" style={{ fontSize: 11.5 }}>(freed)</span>}
        {t.pages.map((p) => {
          const refs = frames.get(p.frame)?.refs ?? 1;
          return (
            <span key={p.name} title={`frame ${p.frame}, ${refs} sharers, ${p.writable ? "writable" : "read-only"}`} style={{ ...mono, fontSize: 10.5, padding: "1px 4px", borderRadius: 3, border: `1px solid ${refs > 1 ? "var(--c1)" : "var(--border)"}`, background: refs > 1 ? tint("var(--c1)", 16) : "var(--bg)" }}>
              {p.name} f{p.frame}{p.writable ? "" : " ro"}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function ForkStepperDemo() {
  const p = useParams("fork-step", {
    closeInParent: toggle({ label: "The shell closes its pipe ends", default: true }),
    cloexec: toggle({ label: "secrets.db has O_CLOEXEC", default: true }),
  });
  const [k, setK] = useState(0);
  const steps = useMemo(() => pipeline({ closeInParent: p.values.closeInParent, cloexec: p.values.cloexec }), [p.values.closeInParent, p.values.cloexec]);
  const kk = Math.min(k, steps.length - 1);
  const s = steps[kk]!;
  const frames = new Map(s.snap.frames.map((f) => [f.id, f]));
  const ofds = new Map(s.snap.ofds.map((o) => [o.id, o]));
  const ofdName = (id: number) => { const o = ofds.get(id); return o ? `${o.name}${o.refs > 1 ? ` ×${o.refs}` : ""}` : "?"; };
  const writers = s.snap.ofds.find((o) => o.kind === "pipe-w")?.refs ?? 0;
  const hang = kk === steps.length - 1 && !p.values.closeInParent;
  return (
    <Demo
      title="The shell runs: ls | wc"
      actions={<IndexButtons k={kk} n={steps.length} set={setK} />}
      controls={<>
        <IndexSlider k={kk} n={steps.length} set={setK} />
        <Param spec={p.schema.closeInParent} value={p.values.closeInParent} onChange={(v) => p.set("closeInParent", v as boolean)} />
        <Param spec={p.schema.cloexec} value={p.values.cloexec} onChange={(v) => p.set("cloexec", v as boolean)} />
      </>}
    >
      <div style={{ ...mono, fontSize: 13, padding: "4px 8px", background: "var(--subtle)", borderRadius: 4, marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <span className="muted">PID {ACTOR_PID[s.actor]}: </span>{s.code}
      </div>
      <Msg warn={hang} min={56}>{s.text}</Msg>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "stretch" }}>
        {s.snap.tasks.map((t) => <TaskCard key={t.pid} t={t} active={ACTOR_PID[s.actor] === t.pid} frames={frames} ofdName={ofdName} />)}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "bytes in the pipe", value: s.snap.pipe.length },
          { label: "open write ends", value: writers },
          { label: "physical frames in use", value: s.snap.frames.length },
          { label: "copy-on-write faults", value: s.snap.cowFaults },
          { label: "terminal", value: <span style={{ ...mono, fontSize: 13 }}>{s.snap.tty.trim() || "(empty)"}</span> },
        ]} />
      </div>
      <Note>×3 after a name means that three fds share one open file description, with one offset. A blue page is shared, with a reference count above 1. "ro" marks a page that the CPU treats as read-only.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- cost

export function ForkCostDemo() {
  const p = useParams("fork-cost", {
    rss: range({ label: "Resident memory", min: 16, max: 1048576, default: 8192, log: true, format: (v) => bigBytes(Math.round(v) * 1024 * 1024) }),
    share: range({ label: "Pages that the parent writes after fork", min: 0, max: 100, step: 5, default: 10, format: (v) => `${v}%` }),
  });
  const rss = Math.round(p.values.rss) * 1024 * 1024;
  const xs = useMemo(() => Array.from({ length: 60 }, (_, i) => 16 * Math.pow(65536, i / 59)), []);
  const line = (f: (b: number) => number) => xs.map((x) => [x, f(x * 1024 * 1024)] as [number, number]);
  const f4 = pageTables(rss, PAGE_4K), f2 = pageTables(rss, PAGE_2M);
  return (
    <Demo title="Time for fork against resident memory" controls={<>
      <Param spec={p.schema.rss} value={p.values.rss} onChange={(v) => p.set("rss", v as number)} />
      <Param spec={p.schema.share} value={p.values.share} onChange={(v) => p.set("share", v as number)} />
    </>}>
      <SmallLabel>All costs here are model inputs. The counts of page table entries are exact for a dense mapping.</SmallLabel>
      <Plot x={[16, 1048576]} y={[10, 2e7]} logX logY height={260} xLabel="resident memory" yLabel="time (µs)" xTicks={[16, 256, 4096, 65536, 1048576]} yTicks={[10, 100, 1000, 1e4, 1e5, 1e6, 1e7]} xFormat={(t) => bigBytes(t * 1024 * 1024)} yFormat={(t) => si(t)}>
        <Line points={line((b) => forkUs(b))} color="var(--c1)" />
        <Line points={line((b) => forkExecUs(b))} color="var(--c1)" dash="4 3" />
        <Line points={line((b) => forkUs(b, true))} color="var(--c2)" />
        <Line points={line((b) => spawnUs(b))} color="var(--c3)" />
        <RuleX at={p.values.rss} color="var(--fg)" />
      </Plot>
      <Legend items={[
        { label: "fork, 4 KiB pages", color: "var(--c1)" },
        { label: "fork + exec, 4 KiB (dashed)", color: "var(--c1)" },
        { label: "fork, 2 MiB pages", color: "var(--c2)" },
        { label: "posix_spawn (includes exec)", color: "var(--c3)" },
      ]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "fork, 4 KiB pages", value: fmtUs(forkUs(rss)) },
          { label: "fork, 2 MiB pages", value: fmtUs(forkUs(rss, true)) },
          { label: "posix_spawn", value: fmtUs(spawnUs(rss)) },
          { label: "PTEs to copy", value: si(f4.entries) },
          { label: "page tables, 4 KiB / 2 MiB", value: `${bytes(f4.bytes)} / ${bytes(f2.bytes)}` },
          { label: "later copy-on-write faults", value: fmtUs(cowUs(rss, p.values.share / 100)) },
        ]} />
      </div>
      <Note>Model inputs: {FORK_INPUTS.pteNs} ns per PTE, {FORK_INPUTS.pmdNs} ns per huge entry, {FORK_INPUTS.ptPageNs} ns per page table page, {FORK_INPUTS.baseUs} µs base, {FORK_INPUTS.spawnUs} µs for the spawn clone, {FORK_INPUTS.execUs} µs for exec, {FORK_INPUTS.cowFaultNs} ns per copy-on-write fault.</Note>
    </Demo>
  );
}
