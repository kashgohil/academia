/** Demos for the lesson on the reorder buffer. */
import { useMemo, useState } from "react";
import { Demo, IndexButtons, IndexSlider, Legend, Line, MiniTable, Note, Param, Plot, SectionLabel, Stats, StepCaption, mono, range, seg, tint, useChunked } from "../../kit";
import { faultRun, missRingRun, missRun, ROB_SWEEP, type Frame } from "../../sims/arch/ooo";
import { OooTimeline, RobRing, reg } from "./ArchOooUi";

function ringCaption(f: Frame): string {
  const head = f.rob[0];
  const parts: string[] = [];
  if (f.committed.length) parts.push(`Committed ${f.committed.length} from the head.`);
  if (head && head.state === "executing" && head.missed) parts.push(`The head is ${head.text}, a cache miss: nothing behind it can commit.`);
  else if (head && head.state !== "done") parts.push(`The head (${head.text}) is not done, so commit waits.`);
  if (f.stall === "ROB full") parts.push("The ROB is full: rename stops, and the front end backs up.");
  if (f.squashed) parts.push(`Squashed ${f.squashed.count} younger entries after a mispredict; the tail moves back.`);
  return parts.join(" ") || `${f.rob.length} entries in flight.`;
}

/** The ROB as a ring: head, tail, entry states, and what blocks commit. */
export function OooRobRingDemo() {
  const [size, setSize] = useState(16);
  const [k, setK] = useState<number | null>(null);
  const r = useMemo(() => missRingRun(size), [size]);
  const n = r.frames.length;
  const firstFull = r.frames.findIndex((x) => x.stall === "ROB full");
  const c = Math.min(k ?? Math.max(0, firstFull), n - 1);
  const f = r.frames[c]!;
  const full = r.frames.filter((x) => x.stall === "ROB full").length;
  return (
    <Demo
      title="The reorder buffer as a ring"
      actions={<IndexButtons k={c} n={n} set={setK} />}
      controls={<>
        <IndexSlider k={c} n={n} set={setK} label="Cycle" />
        <Param spec={seg("ROB entries", [["8", "8"], ["16", "16"], ["32", "32"], ["64", "64"]], "16")} value={String(size)} onChange={(v) => { setSize(Number(v)); setK(null); }} />
      </>}
    >
      <StepCaption tone={f.stall === "ROB full" ? "warn" : f.committed.length ? "good" : "info"} label={`cycle ${f.cycle}`}>{ringCaption(f)}</StepCaption>
      <div style={{ marginTop: 8 }}><RobRing frame={f} size={size} /></div>
      <Stats items={[
        { label: "Entries in use", value: `${f.rob.length} of ${size}` },
        { label: "Run: cycles", value: r.cycles },
        { label: "Cycles with a full ROB", value: full },
        { label: "Misses", value: r.stats.misses },
      ]} />
      <Note>Each iteration loads from a new cache line (a 40-cycle miss, a model input) and does 6 other instructions. The ROB holds instructions from issue to commit, so its size bounds how far the core can look past a miss.</Note>
    </Demo>
  );
}

/** Cycles of the miss loop as the ROB grows: independent misses overlap, a pointer chase does not. */
export function OooRobSweepDemo() {
  const [miss, setMiss] = useState(100);
  const jobs = useMemo(() => ROB_SWEEP.flatMap((s) => [() => missRun(s, miss).cycles, () => missRun(s, miss, true).cycles]), [miss]);
  const res = useChunked(`rob-${miss}`, jobs, { keep: true });
  const pts = (off: number) => ROB_SWEEP.flatMap((s, i) => (res[2 * i + off] === undefined ? [] : [[s, res[2 * i + off]!] as [number, number]]));
  const ymax = Math.max(100, ...res.map((v) => v ?? 0));
  return (
    <Demo title="A bigger window hides more misses, if they are independent" controls={<Param spec={range({ label: "Miss latency (cycles)", min: 20, max: 300, step: 10, default: 100 })} value={miss} onChange={(v) => setMiss(v as number)} />}>
      <Plot x={[0, 256]} y={[0, ymax * 1.05]} height={220} xLabel="ROB entries" yLabel="cycles" xTicks={[8, 32, 64, 128, 192, 256]}>
        <Line points={pts(0)} color="var(--c1)" />
        <Line points={pts(1)} color="var(--c4)" />
      </Plot>
      <Legend items={[{ label: "24 independent misses", color: "var(--c1)" }, { label: "24 misses in a linked list", color: "var(--c4)" }]} />
      <MiniTable
        head={["ROB entries", "Independent: cycles", "Linked list: cycles"]}
        rows={ROB_SWEEP.filter((s) => [16, 32, 64, 128, 256].includes(s)).map((s) => { const i = ROB_SWEEP.indexOf(s); return [s, res[2 * i] ?? "…", res[2 * i + 1] ?? "…"]; })}
      />
      <Note>Each iteration has 11 instructions. The issue queue and register file grow with the ROB here, so the ROB is the limit. Latencies are model inputs.</Note>
    </Demo>
  );
}

/** A fault while older work is still running: the state the program sees, with and without in-order commit. */
export function OooPreciseDemo() {
  const [mode, setMode] = useState<"rob" | "none">("rob");
  const { r, fault, found, pending, younger } = useMemo(() => faultRun(), []);
  const regs = [7, 8, 9, 18, 19, 20]; // t2 s0 s1 s2 s3 s4
  const valueAt = (x: number): { v: string; note: string } => {
    const older = r.uops.filter((u) => !u.wrong && u.id < fault.id && u.rd === x);
    const young = younger.filter((u) => u.rd === x);
    if (mode === "rob") {
      const w = older[older.length - 1];
      return w ? { v: String(w.value), note: "older: committed" } : { v: "0", note: "not written" };
    }
    if (young.length) return { v: String(young[young.length - 1]!.value), note: "younger: already written" };
    const w = older[older.length - 1];
    if (!w) return { v: "0", note: "not written" };
    return pending.includes(w) ? { v: "0", note: "older: not done yet" } : { v: String(w.value), note: "older: written" };
  };
  return (
    <Demo title="Precise and imprecise state at a fault" controls={<Param spec={seg("Results go to the registers", [["rob", "In order, at commit (ROB)"], ["none", "When done (Tomasulo 1967)"]], "rob")} value={mode} onChange={(v) => setMode(v as "rob" | "none")} />}>
      <StepCaption tone={mode === "rob" ? "good" : "bad"} label={`cycle ${found}`}>
        {mode === "rob"
          ? `${fault.text} faults in cycle ${found}. The fault waits in the ROB. The core commits everything older, squashes everything younger, then traps. The handler sees the state exactly at the faulting instruction.`
          : `${fault.text} faults in cycle ${found}. The divide is older but not done, while ${younger.length} younger instructions have already written their registers. No single point in the program matches this state.`}
      </StepCaption>
      <SectionLabel>Registers the handler would see</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 4 }}>
        {regs.map((x) => {
          const { v, note } = valueAt(x);
          const bad = note.startsWith("younger") || note.includes("not done");
          return (
            <div key={x} style={{ padding: "3px 8px", borderRadius: 4, fontSize: 12, ...mono, background: bad ? tint("var(--c4)", 22) : "var(--subtle)" }}>
              <b>{reg(x)}</b> = {v} <span className="muted" style={{ fontSize: 11 }}>{note}</span>
            </div>
          );
        })}
      </div>
      <SectionLabel>Timeline (the fault is at the ✕ near the end)</SectionLabel>
      <OooTimeline uops={r.uops} maxRows={20} />
      <Note>The divide takes 20 cycles (a model input). The instructions after the faulting load run on a path that the core will throw away.</Note>
    </Demo>
  );
}
