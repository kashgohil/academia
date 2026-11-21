/** Demos for the lesson on warps and divergence. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Chip, Controls, Demo, MiniTable, SectionLabel, SmallLabel, StepButtons, StepCaption, StepSlider, Stats, mono, pct, range, seg, tint, useParams, useStepper,
} from "../../kit";
import { divergenceCost, program, runWarp, type Scheduler } from "../../sims/arch/parallel";

// ---------------------------------------------------------------- divergence painter

const PRESETS: [string, (i: number) => boolean][] = [
  ["All lanes", () => true],
  ["All but lane 31", (i) => i !== 31],
  ["lane < 16", (i) => i < 16],
  ["Even lanes", (i) => i % 2 === 0],
  ["Only lane 0", (i) => i === 0],
];

export function ArchParDivergenceDemo() {
  const p = useParams("pardiv", {
    a: range({ label: "Instructions in the if part", min: 1, max: 30, step: 1, default: 20 }),
    b: range({ label: "Instructions in the else part", min: 1, max: 30, step: 1, default: 20 }),
  });
  const [taken, setTaken] = useState<boolean[]>(() => Array.from({ length: 32 }, (_, i) => i !== 31));
  const { a, b } = p.values;
  const r = useMemo(() => divergenceCost(taken, a, b), [taken, a, b]);
  const base = useMemo(() => divergenceCost(taken.map(() => true), a, b), [taken, a, b]);
  // Runs of frames with the same active mask, for a compact timeline.
  const runs: { from: number; count: number; mask: number[]; what: string }[] = [];
  r.frames.forEach((f, k) => {
    const key = f.active.join(",");
    const last = runs[runs.length - 1];
    const what = k === 0 ? "branch" : f.pc <= a ? "if part" : f.pc === a + 1 ? "jump to join" : "else part";
    if (last && last.mask.join(",") === key && last.what === what) last.count++;
    else runs.push({ from: k, count: 1, mask: f.active, what });
  });
  return (
    <Demo title="Paint the branch outcome of each lane" controls={<Controls params={p} />}>
      <SmallLabel>Click a lane to change its condition. Blue lanes take the if part; orange lanes take the else part.</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(16, minmax(0, 1fr))", gap: 3, maxWidth: 520 }}>
        {taken.map((t, i) => (
          <button key={i} aria-label={`lane ${i}`} onClick={() => setTaken(taken.map((x, j) => (j === i ? !x : x)))} style={{ height: 22, padding: 0, border: "1px solid var(--border)", borderRadius: 3, cursor: "pointer", fontSize: 9, color: "var(--bg)", background: t ? "var(--c1)" : "var(--c2)", ...mono }}>{i}</button>
        ))}
      </div>
      <ButtonRow style={{ margin: "8px 0" }}>
        {PRESETS.map(([name, f]) => <Btn key={name} ghost onClick={() => setTaken(Array.from({ length: 32 }, (_, i) => f(i)))}>{name}</Btn>)}
      </ButtonRow>
      <SectionLabel>Time: one row per issued instruction</SectionLabel>
      <div style={{ display: "grid", gap: 2 }}>
        {runs.map((x, k) => (
          <div key={k} style={{ display: "grid", gridTemplateColumns: "minmax(0, 104px) minmax(0, 1fr)", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>{x.what}{x.count > 1 ? ` × ${x.count}` : ""}</span>
            <div style={{ display: "flex", gap: 1, height: Math.max(5, x.count * 3) }}>
              {Array.from({ length: 32 }, (_, l) => {
                const on = x.mask.includes(l);
                const col = x.what === "else part" ? "var(--c2)" : x.what === "if part" ? "var(--c1)" : "var(--muted)";
                return <div key={l} style={{ flex: 1, minWidth: 0, background: on ? col : tint("var(--fg)", 6), borderRadius: 1 }} />;
              })}
            </div>
          </div>
        ))}
      </div>
      <Stats items={[
        { label: "instructions issued", value: r.issued },
        { label: "without divergence", value: base.issued },
        { label: "time vs no divergence", value: `${(r.issued / base.issued).toFixed(2)}×` },
        { label: "lane utilization", value: pct(r.utilization, 0) },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- SIMT stepper

const INPUTS: Record<string, number[]> = {
  lane: [0, 1, 2, 3, 4, 5, 6, 7],
  rev: [7, 6, 5, 4, 3, 2, 1, 0],
  odd: [1, 0, 1, 0, 1, 0, 1, 0],
  same: [3, 3, 3, 3, 3, 3, 3, 3],
};

export function ArchParSimtStepperDemo() {
  const p = useParams("parsimt", {
    prog: seg<"ifelse" | "nested" | "loop" | "loopsync" | "spin">("Program", [["ifelse", "if / else"], ["nested", "nested if"], ["loop", "loop of x trips"], ["loopsync", "loop + __syncwarp"], ["spin", "spin lock"]], "ifelse"),
    sched: seg<Scheduler>("Scheduler", [["stack", "Reconvergence stack (pre-Volta)"], ["its", "Independent threads (model)"]], "stack"),
    x: seg<"lane" | "rev" | "odd" | "same">("Input x of each lane", [["lane", "x = lane"], ["rev", "x = 7 − lane"], ["odd", "x = 1, 0, 1, 0, …"], ["same", "x = 3 for all"]], "lane"),
  });
  const prog = program(p.values.prog);
  const run = useMemo(() => runWarp(prog, INPUTS[p.values.x]!, p.values.sched, 120), [prog, p.values.x, p.values.sched]);
  const s = useStepper(run.frames.length, 3);
  const f = run.frames[s.i]!;
  const done = run.frames.slice(1, s.i + 1);
  const issued = done.filter((x) => x.pc >= 0).length;
  const laneOps = done.reduce((a, x) => a + x.active.length, 0);
  const n = run.lanes;
  const mask = (lanes: number[]) => Array.from({ length: n }, (_, k) => (lanes.includes(k) ? "1" : "0")).join("");
  return (
    <Demo
      title="Step one warp of 8 lanes through a branch"
      actions={<StepButtons s={s} />}
      controls={<><StepSlider s={s} /><Controls params={p} /></>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 14 }}>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>Program</SectionLabel>
          <div style={{ fontSize: 12, ...mono }}>
            {prog.code.map((ins, pc) => {
              const here = f.pcs.map((q, l) => (q === pc ? l : -1)).filter((l) => l >= 0);
              const now = f.pc === pc;
              return (
                <div key={pc} style={{ display: "grid", gridTemplateColumns: "18px minmax(0, 1fr) auto", gap: 6, alignItems: "center", padding: "1px 4px", borderRadius: 3, background: now ? tint("var(--c1)", 22) : undefined }}>
                  <span className="muted">{pc}</span>
                  <span style={{ overflowWrap: "anywhere" }}>{ins.text}</span>
                  <span style={{ display: "flex", gap: 1 }}>{here.map((l) => <span key={l} style={{ width: 7, height: 7, borderRadius: 4, background: "var(--c3)" }} title={`lane ${l}`} />)}</span>
                </div>
              );
            })}
          </div>
          <SmallLabel style={{ marginTop: 6 }}>Green dots: the next instruction of each lane.</SmallLabel>
        </div>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>Active mask (lanes 0 … 7)</SectionLabel>
          <div style={{ display: "flex", gap: 3, marginBottom: 8 }}>
            {Array.from({ length: n }, (_, l) => (
              <div key={l} style={{ flex: 1, height: 22, borderRadius: 3, display: "grid", placeItems: "center", fontSize: 10.5, background: f.active.includes(l) ? "var(--c1)" : f.pcs[l]! < 0 ? "transparent" : "var(--subtle)", color: f.active.includes(l) ? "var(--bg)" : "var(--muted)", border: "1px solid var(--border)", ...mono }}>
                {f.pcs[l]! < 0 ? "exit" : `x=${f.regs[l]!.x}`}
              </div>
            ))}
          </div>
          {p.values.sched === "stack" ? (
            <>
              <SectionLabel>Reconvergence stack (top first)</SectionLabel>
              <MiniTable head={["next PC", "reconverge at", "mask"]} rows={[...f.stack].reverse().map((e) => [e.pc, e.rpc === prog.code.length ? "end" : e.rpc, <span style={mono}>{mask(e.mask)}</span>])} highlight={0} />
            </>
          ) : (
            <>
              <SectionLabel>Groups of lanes with the same PC</SectionLabel>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {[...new Set(f.pcs.filter((q) => q >= 0))].sort((x, y) => x - y).map((q) => <Chip key={q}>PC {q}: {mask(f.pcs.map((v, l) => (v === q ? l : -1)).filter((l) => l >= 0))}</Chip>)}
              </div>
            </>
          )}
          {p.values.prog === "spin" && <div style={{ fontSize: 12.5, marginTop: 8, ...mono }}>lock = {f.shared.lock} · count = {f.shared.count}</div>}
        </div>
      </div>
      <StepCaption label={`step ${s.i}`}>{f.note}</StepCaption>
      <Stats items={[
        { label: "instructions issued so far", value: issued },
        { label: "lane utilization so far", value: issued ? pct(laneOps / (issued * n), 0) : "–" },
        { label: "whole run", value: run.finished ? `${run.issued} issued, ${pct(run.utilization, 0)}` : "never finishes" },
      ]} />
      {!run.finished && s.atEnd && <Banner tone="bad">After {run.issued} steps the warp still spins. The lane that holds the lock waits at the reconvergence point, so it never releases the lock.</Banner>}
    </Demo>
  );
}
