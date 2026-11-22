/**
 * Demos for "Ownership in Rust": `let t = s;` as a move, a deep copy and a shallow copy on the memory machine, and a
 * drop-order playground on the toy checker (programs.ts, checked against rustc 1.96.1).
 */
import { useMemo, useState } from "react";
import { ButtonRow, Demo, Param, SectionLabel, Stats, StepButtons, StepSlider, seg, select, useStepper } from "../../kit";
import { ASSIGN_SOURCE, DROPS, OWNERSHIP, check, stringAssign, type AssignMode } from "../../sims/sys/ownership";
import { CodeView, EditableCode, MemStepper, Verdict, errorMarks } from "./SysOwnUi";

const modeSpec = seg<AssignMode>("Semantics of t = s", [["rust", "Rust move"], ["copy", "C++ copy"], ["shallow", "C struct copy"]], "rust");

export function OwnAssignDemo() {
  const [mode, setMode] = useState<AssignMode>("rust");
  const steps = useMemo(() => stringAssign(mode), [mode]);
  const s = useStepper(steps.length, 1.2);
  const cur = steps[Math.min(s.i, steps.length - 1)]!;
  const blocks = cur.snap.heap;
  const allocs = steps[steps.length - 1]!.snap.heap.length;
  const frees = blocks.filter((b) => b.state === "freed").length;
  return (
    <Demo
      title="Who owns the heap buffer after t = s?"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={modeSpec} value={mode} onChange={(v) => { setMode(v as AssignMode); s.reset(); }} />
      </>}
    >
      <MemStepper steps={steps} source={ASSIGN_SOURCE[mode]} s={s} movedLabel="moved: the compiler forgets" />
      <Stats items={[
        { label: "heap blocks in the whole run", value: allocs },
        { label: "blocks freed so far", value: frees },
        { label: "UB reports so far", value: cur.snap.ub.length },
      ]} />
    </Demo>
  );
}

const PRESETS = [...DROPS, ...OWNERSHIP];
const presetSpec = select({ label: "Program", options: PRESETS.map((p) => ({ value: p.id, label: p.title })), default: "scopes" });

export function OwnDropDemo() {
  const [id, setId] = useState("scopes");
  const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
  const [src, setSrc] = useState(preset.src);
  const r = useMemo(() => check(src), [src]);
  const lines = src.split("\n");
  // what happens on each line at run time: prints and drops
  const right = new Map<number, string>();
  if (r.ok) {
    for (const e of r.events) {
      if (e.kind === "free") continue;
      const t = e.kind === "print" ? `prints "${e.text}"` : e.kind === "forget" ? "forget: no drop" : e.text;
      const at = Math.min(e.line, lines.length + 1);
      right.set(at, right.has(at) ? `${right.get(at)}, ${t}` : `→ ${t}`);
    }
  }
  const drops = r.events.filter((e) => e.kind === "drop").length;
  const frees = r.events.filter((e) => e.kind === "free").length;
  return (
    <Demo
      title="Drop order: when does each value die?"
      controls={<Param spec={presetSpec} value={id} onChange={(v) => { const p = PRESETS.find((x) => x.id === v)!; setId(p.id); setSrc(p.src); }} />}
    >
      <SectionLabel style={{ marginTop: 0 }}>Program (the body of main; Noisy prints "drop name" in its Drop)</SectionLabel>
      <EditableCode value={src} onChange={setSrc} onReset={() => setSrc(preset.src)}>
        <CodeView lines={right.has(lines.length + 1) ? [...lines, "// end of main"] : lines} marks={errorMarks(r)} right={right} />
      </EditableCode>
      <SectionLabel>What the checker says, and what the program prints</SectionLabel>
      <Verdict r={r} lines={lines} />
      {r.ok && <Stats items={[
        { label: "Drop calls that print", value: drops },
        { label: "heap buffers freed", value: frees },
        { label: "values forgotten", value: r.events.filter((e) => e.kind === "forget").length },
      ]} />}
    </Demo>
  );
}
