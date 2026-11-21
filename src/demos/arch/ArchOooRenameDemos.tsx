/** Demos for the lesson on register renaming. */
import { useMemo, useState } from "react";
import { Demo, IndexButtons, IndexSlider, MiniTable, Note, Param, SectionLabel, Stats, StepCaption, fixed, mono, range, seg, tint, useChunked } from "../../kit";
import { PHYS_SWEEP, squaresRun, type Frame } from "../../sims/arch/ooo";
import { OooTimeline, RenameTables, physText, reg, tag } from "./ArchOooUi";

const REGS = [5, 6, 10, 28, 29]; // t0 t1 a0 t3 t4

function caption(f: Frame): string {
  const parts: string[] = [];
  for (const id of f.renamed) {
    const u = f.rob.find((x) => x.id === id);
    if (!u) continue;
    parts.push(u.rd ? `Renamed ${u.text}: ${reg(u.rd)} now names ${tag(u.pd)} (it took ${tag(u.pd)} from the free list; ${tag(u.old)} is freed when it commits).` : `Renamed ${u.text}: it writes no register.`);
  }
  if (f.committed.length) parts.push(`Committed ${f.committed.length}.`);
  if (f.stall) parts.push(`Rename stalls: ${f.stall}.`);
  if (f.squashed) parts.push(`Squashed ${f.squashed.count} wrong-path instructions; the map is restored.`);
  return parts.join(" ") || "Nothing renamed in this cycle.";
}

/** Step the rename stage: one instruction per cycle, the map, the free list and the instructions in physical names. */
export function OooRenameStepDemo() {
  const [phys, setPhys] = useState(40);
  const [k, setK] = useState(0);
  const run = useMemo(() => squaresRun(phys, { width: 1, record: true, maxFrames: 400 }), [phys]);
  const n = run.frames.length;
  const f = run.frames[Math.min(k, n - 1)]!;
  const tone = f.stall ? "warn" : f.renamed.length ? "info" : "plain";
  return (
    <Demo
      title="Rename one instruction per cycle"
      actions={<IndexButtons k={Math.min(k, n - 1)} n={n} set={setK} />}
      controls={<>
        <IndexSlider k={Math.min(k, n - 1)} n={n} set={setK} label="Cycle" />
        <Param spec={range({ label: "Physical registers", min: 33, max: 64, step: 1, default: 40 })} value={phys} onChange={(v) => { setPhys(v as number); }} />
      </>}
    >
      <StepCaption tone={tone} label={`cycle ${f.cycle}`}>{caption(f)}</StepCaption>
      <SectionLabel>Rename table and free list</SectionLabel>
      <RenameTables frame={f} regs={REGS} />
      <SectionLabel>In flight, in physical names (oldest first)</SectionLabel>
      <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", fontSize: 12, ...mono }}>
        {f.rob.length === 0 && <span className="muted">empty</span>}
        {f.rob.map((u) => (
          <div key={u.id} style={{ display: "flex", gap: 10, whiteSpace: "nowrap", background: f.renamed.includes(u.id) ? tint("var(--c2)", 30) : undefined, color: u.wrong ? "var(--c4)" : undefined }}>
            <span style={{ minWidth: 150 }}>{u.text}</span><span className="muted">→</span><span>{physText(u)}</span>
          </div>
        ))}
      </div>
      <Stats items={[
        { label: "Free registers now", value: f.free.length },
        { label: "Run: cycles", value: run.cycles },
        { label: "Run: instructions per cycle", value: fixed(run.ipc) },
        { label: "Cycles rename waited for a register", value: run.stats.renameStalls.regs },
      ]} />
      <Note>The core here renames, issues and commits one instruction per cycle. 32 registers hold the committed values, so only the rest can name new results.</Note>
    </Demo>
  );
}

const CHOICES = ["none", "33", "36", "40", "48", "64", "128"];
const label = (c: string) => (c === "none" ? "No renaming" : `${c} physical`);

/** The same loop with no renaming and with more and more physical registers. */
export function OooRenameSweepDemo() {
  const [phys, setPhys] = useState(64);
  const [mode, setMode] = useState<"on" | "off">("off");
  const pick = mode === "off" ? "none" : String(phys);
  const jobs = useMemo(() => CHOICES.map((c) => () => {
    const r = squaresRun(c === "none" ? "none" : Number(c));
    return { cycles: r.cycles, ipc: r.ipc, regs: r.stats.renameStalls.regs };
  }), []);
  const res = useChunked("rename-sweep", jobs);
  const sel = useMemo(() => squaresRun(mode === "off" ? "none" : phys), [mode, phys]);
  const sweep = useChunked("rename-sweep-plot", useMemo(() => PHYS_SWEEP.map((p) => () => squaresRun(p).ipc), []));
  const max = Math.max(1, ...res.map((r) => r?.cycles ?? 0));
  return (
    <Demo
      title="False dependences cost cycles"
      controls={<>
        <Param spec={range({ label: "Physical registers", min: 33, max: 128, step: 1, default: 64 })} value={phys} onChange={(v) => { setPhys(v as number); setMode("on"); }} />
        <Param spec={seg("Renaming", [["off", "Off"], ["on", "On"]], "off")} value={mode} onChange={(v) => setMode(v as "on" | "off")} />
      </>}
    >
      <MiniTable
        head={["Core", "Cycles", "Instructions per cycle", "Cycles, as a bar"]}
        highlight={CHOICES.indexOf(pick)}
        rows={CHOICES.map((c, i) => {
          const r = res[i];
          return [label(c), r ? r.cycles : "…", r ? fixed(r.ipc) : "…",
            <div key="b" style={{ width: 120, height: 8, background: "var(--subtle)", borderRadius: 3 }}><div style={{ width: `${((r?.cycles ?? 0) / max) * 100}%`, height: "100%", background: c === "none" ? "var(--c4)" : "var(--c1)", borderRadius: 3 }} /></div>];
        })}
      />
      <SectionLabel>Instructions per cycle as the register file grows</SectionLabel>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 90, overflowX: "auto" }}>
        {PHYS_SWEEP.map((p, i) => {
          const v = sweep[i];
          return (
            <div key={p} style={{ flex: "1 0 22px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <span style={{ fontSize: 9.5, ...mono }}>{v === undefined ? "" : fixed(v, 1)}</span>
              <div style={{ width: "70%", height: `${((v ?? 0) / 2.5) * 60}px`, background: "var(--c1)", borderRadius: 2 }} />
              <span className="muted" style={{ fontSize: 9.5, ...mono }}>{p}</span>
            </div>
          );
        })}
      </div>
      <Stats items={[
        { label: "This core", value: mode === "off" ? "no renaming" : `${phys} physical registers` },
        { label: "Cycles", value: sel.cycles },
        { label: "Instructions per cycle", value: fixed(sel.ipc) },
      ]} />
      <SectionLabel>Timeline: {mode === "off" ? "no renaming" : `${phys} physical registers`}</SectionLabel>
      <OooTimeline uops={sel.uops} maxRows={40} />
      <Note>Width 4, a 64-entry ROB, loads 4 cycles, multiplies 3 cycles (model inputs). The loop reuses t3 and t4 for every element.</Note>
    </Demo>
  );
}
