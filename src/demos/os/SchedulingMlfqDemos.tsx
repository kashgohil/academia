/** Demos for "Multilevel feedback queues". */
import { useEffect, useMemo, useState } from "react";
import { Demo, Stats, Controls, Plot, Line, Legend, RuleX, range, useParams, useSim, useWidth, pct, Note, SmallLabel, mono, seg } from "../../kit";
import {
  MLFQ_MIX, MLFQ_STARVE, cpuShare, gamingRun, logSpace, simulateMlfq, snapshotAt, starveShare, summarize,
  type Accounting, type MlfqConfig, type MlfqSnapshot, type Job,
} from "../../sims/os/scheduling";
import { Gantt, cpuRow, jobColor, jobRows, f1 } from "./SchedulingGantt";

const ACCOUNTING: [Accounting, string][] = [["allotment", "Rule 4: count all use"], ["slice", "Old 4a/4b: a yield clears the count"]];

// ------------------------------------------------------------------------------------------------
// Queue animation
// ------------------------------------------------------------------------------------------------

const ROW = 36;
const LABEL = 86;
const CHIP = 54;
const HEAD = 15;

function QueueBoard({ snap, jobs, cfg }: { snap: MlfqSnapshot; jobs: readonly Job[]; cfg: MlfqConfig }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const levels = cfg.quantum.length;
  const cpuW = CHIP + 16;
  const cpuX = Math.max(LABEL + 40, w - cpuW);
  const trackW = cpuX - LABEL - 6;
  const pos = new Map<number, { x: number; y: number; dim: boolean; run: boolean }>();
  snap.queues.forEach((q, l) => q.forEach((id, i) => {
    const step = Math.min(CHIP + 4, trackW / Math.max(1, q.length));
    pos.set(id, { x: LABEL + 4 + i * step, y: HEAD + l * ROW + 5, dim: false, run: false });
  }));
  if (snap.running !== null) {
    const l = snap.level.get(snap.running) ?? 0;
    pos.set(snap.running, { x: cpuX + 8, y: HEAD + l * ROW + 5, dim: false, run: true });
  }
  const below = (ids: number[], row: number, dim: boolean) => ids.forEach((id, i) => pos.set(id, { x: LABEL + 4 + i * (CHIP + 4), y: HEAD + row * ROW + 5, dim, run: false }));
  below(snap.blocked, levels, true);
  below(snap.done, levels + 1, true);
  const h = HEAD + (levels + 2) * ROW;
  const rowLabels = [...cfg.quantum.map((q, l) => `Q${l} · ${q} ms`), "I/O wait", "Done"];
  return (
    <div ref={ref} style={{ position: "relative", height: h, width: "100%" }}>
      {rowLabels.map((label, i) => (
        <div key={label} style={{ position: "absolute", left: 0, right: 0, top: HEAD + i * ROW, height: ROW - 1, borderBottom: "1px solid var(--border)", background: i < levels ? "var(--subtle)" : "transparent", display: "flex", alignItems: "center", fontSize: 12, color: "var(--muted)", paddingLeft: 4, ...mono }}>{label}</div>
      ))}
      <span style={{ position: "absolute", top: 0, left: cpuX + 8, width: CHIP, textAlign: "center", fontSize: 11, color: "var(--muted)" }}>CPU</span>
      <span style={{ position: "absolute", top: 0, left: LABEL + 4, fontSize: 11, color: "var(--muted)" }}>Ready queue</span>
      <div style={{ position: "absolute", left: cpuX, top: HEAD, width: cpuW, height: levels * ROW, borderLeft: "1px dashed var(--muted)" }} />
      {jobs.map((j) => {
        const p = pos.get(j.id);
        if (!p) return null;
        return (
          <div key={j.id} style={{
            position: "absolute", left: 0, top: 0, transform: `translate(${p.x}px, ${p.y}px)`, transition: "transform 0.28s ease", width: CHIP, height: ROW - 10, borderRadius: 4,
            background: jobColor(j.id), opacity: p.dim ? 0.5 : 1, color: "var(--bg)", fontSize: 11.5, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center",
            outline: p.run ? "2px solid var(--fg)" : "none", outlineOffset: 1,
          }}>{j.name}</div>
        );
      })}
    </div>
  );
}

const SPEED = 30; // simulated ms per real second

export function MlfqDemo() {
  const p = useParams("sched-mlfq", {
    boost: range({ label: "Priority boost period S (0 = off)", min: 0, max: 200, step: 10, default: 0, format: (v) => (v ? `${v} ms` : "off") }),
    scenario: seg("Workload", [["mix", "Long, Chat and Short"], ["starve", "Long and two I/O jobs"]], "mix"),
    accounting: seg("Accounting", ACCOUNTING, "allotment"),
  });
  const { boost, scenario, accounting } = p.values;
  const isStarve = scenario === "starve";
  const jobs = isStarve ? MLFQ_STARVE : MLFQ_MIX;
  const horizon = isStarve ? 300 : 260;
  const cfg: MlfqConfig = useMemo(() => (isStarve
    ? { quantum: [10, 10, 10], allotment: [10, 10, 10], boost, accounting, horizon }
    : { quantum: [10, 20, 40], allotment: [10, 20, 40], boost, accounting, horizon }), [isStarve, boost, accounting, horizon]);
  const tr = useMemo(() => simulateMlfq(jobs, cfg), [jobs, cfg]);
  const end = Math.min(horizon, tr.end);
  const [t, setT] = useState(0);
  const sim = useSim({
    step: (dt) => setT((x) => Math.min(end, x + dt * SPEED)),
    reset: () => setT(0),
    dt: 1 / 60,
  });
  const now = Math.min(t, end);
  useEffect(() => { if (sim.running && t >= end) sim.pause(); }); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = () => { if (!sim.running && t >= end) setT(0); sim.toggle(); };
  const snap = snapshotAt(tr, now);
  const stepEvent = () => {
    const next = tr.snapshots.find((s) => s.t > now + 1e-6);
    setT(next ? next.t : end);
  };
  const recent = tr.moves.filter((m) => m.t <= now + 1e-6).slice(-1)[0];
  const name = (id: number) => jobs.find((j) => j.id === id)?.name ?? "";
  const s = summarize(tr);
  return (
    <Demo
      title="MLFQ: jobs move down as they use CPU, and a boost lifts them"
      actions={<><button className="btn" onClick={toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn" onClick={stepEvent} disabled={sim.running}>Next event</button><button className="btn ghost" onClick={sim.reset}>Reset</button></>}
      controls={<Controls params={p} />}
    >
      <QueueBoard snap={snap} jobs={jobs} cfg={cfg} />
      <p style={{ fontSize: 12.5, minHeight: 18, margin: "8px 0" }}>
        <span className="muted" style={mono}>t = {f1(now)} ms. </span>
        {recent ? (recent.why === "boost" ? `Rule 5: at ${f1(recent.t)} ms the boost moved ${name(recent.job)} to Q0.` : `Rule 4: at ${f1(recent.t)} ms ${name(recent.job)} used its allotment and moved to Q${recent.level}.`) : "Rule 3: every new job starts in Q0."}
      </p>
      <Gantt rows={jobRows(tr)} end={end} cursor={now} rules={tr.boosts.filter((b) => b <= end).map((b) => ({ t: b, color: "var(--faint)" }))} rowH={18} labelW={44} />
      <Stats items={s.jobs.map((j) => ({
        label: `${j.name}: CPU share to ${Math.round(end)} ms`,
        value: pct(cpuShare(tr, j.id, 0, end)),
      }))} />
      <Note>A thick bar is CPU time. A thin line is an I/O wait. Dashed lines are priority boosts.</Note>
    </Demo>
  );
}

// ------------------------------------------------------------------------------------------------
// Gaming the scheduler
// ------------------------------------------------------------------------------------------------

export function MlfqGamingDemo() {
  const p = useParams("sched-gaming", {
    yieldAt: range({ label: "The gamer yields at this part of the quantum", min: 0.5, max: 0.99, step: 0.01, default: 0.99, format: (v) => `${Math.round(v * 100)}%` }),
    sleep: range({ label: "Time asleep per yield", min: 0.1, max: 5, step: 0.1, default: 0.1, format: (v) => `${v} ms` }),
  });
  const { yieldAt, sleep } = p.values;
  const horizon = 1000;
  const old = useMemo(() => gamingRun(yieldAt, "slice", { sleep, horizon }), [yieldAt, sleep]);
  const fix = useMemo(() => gamingRun(yieldAt, "allotment", { sleep, horizon }), [yieldAt, sleep]);
  const curve = (tr: typeof old.trace) => Array.from({ length: 41 }, (_, i) => {
    const t = Math.max(1, i * 25);
    return [t, cpuShare(tr, 1, 0, t) * 100] as [number, number];
  });
  const color = (id: number) => (id === 1 ? "var(--c4)" : "var(--c1)");
  return (
    <Demo title="A job yields just before its quantum ends" controls={<Controls params={p} />}>
      <SmallLabel>The first 90 ms. Hog is blue. Gamer is red. The quantum is 10 ms at every level.</SmallLabel>
      <Gantt rows={[cpuRow(old.trace, "4a/4b", 0, color), cpuRow(fix.trace, "Rule 4", 0, color)]} end={90} labelW={44} />
      <SmallLabel>Gamer's CPU share since time 0</SmallLabel>
      <Plot x={[0, horizon]} y={[0, 100]} height={170} xLabel="time (ms)" yFormat={(v) => `${v}%`} yTicks={[0, 25, 50, 75, 100]}>
        <Line points={curve(old.trace)} color="var(--c4)" />
        <Line points={curve(fix.trace)} color="var(--c1)" />
      </Plot>
      <Legend items={[{ label: "old rules 4a and 4b", color: "var(--c4)" }, { label: "rule 4 with allotment accounting", color: "var(--c1)" }]} />
      <Stats items={[
        { label: "gamer's share, old rules", value: pct(old.gamerShare) },
        { label: "gamer's share, rule 4", value: pct(fix.gamerShare) },
        { label: "gamer's level at the end, old rules", value: `Q${old.gamerLevel}` },
        { label: "gamer's level at the end, rule 4", value: `Q${fix.gamerLevel}` },
      ]} />
    </Demo>
  );
}

// ------------------------------------------------------------------------------------------------
// Starvation against the boost period
// ------------------------------------------------------------------------------------------------

const PERIODS = logSpace(20, 900, 14).map((x) => Math.round(x));

export function BoostSweepDemo() {
  const [S, setS] = useState(100);
  const curveOld = useMemo(() => PERIODS.map((b) => [b, starveShare("slice", b) * 100] as [number, number]), []);
  const off = useMemo(() => starveShare("slice", 0), []);
  const offNew = useMemo(() => starveShare("allotment", 0), []);
  const here = useMemo(() => starveShare("slice", S), [S]);
  return (
    <Demo
      title="How often to boost? The long job's share under the old rules"
      controls={
        <label className="param">
          <span className="param-label">Boost period S<span className="param-value">{S} ms</span></span>
          <input type="range" min={20} max={900} step={10} value={S} onChange={(e) => setS(Number(e.target.value))} />
        </label>
      }
    >
      <Plot x={[20, 900]} y={[0, 50]} logX height={190} xLabel="boost period S (ms)" yLabel="share of Long" xTicks={[20, 50, 100, 200, 500]} xFormat={(v) => String(v)} yFormat={(v) => `${v}%`}>
        <Line points={curveOld} color="var(--c1)" />
        <RuleX at={S} color="var(--c4)" dash="none" />
      </Plot>
      <Stats items={[
        { label: `share of Long at S = ${S} ms`, value: pct(here) },
        { label: "share with no boost, old rules", value: pct(off) },
        { label: "share with no boost, rule 4", value: pct(offNew) },
      ]} />
      <Note>Each boost gives Long one 10 ms quantum at the top before it falls again, so its share is about 10 / S.</Note>
    </Demo>
  );
}

