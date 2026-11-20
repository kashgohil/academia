/** Demos for "work-stealing": per-worker deques step by step, and static blocks against a central queue against stealing. */
import { useMemo, useState } from "react";
import { Banner, Chip, Demo, IndexButtons, IndexSlider, Legend, Line, Param, Plot, Stats, StepCaption, fixed, int, range, seg, tint, useChunked, useParams } from "../../kit";
import type { RunResult } from "../../sims/conc";
import { runSharing, type DequeEvent, type Range, type ShareMode, type StealResult } from "../../sims/conc/patterns";
import { threadColor, timelineRows, timeUnit } from "./ConcViews";
import { Gantt } from "../os/SchedulingGantt";

const rangeText = (r: Range) => `${r.lo}–${r.hi}`;

/** Worker rows of a Runtime result: steal attempts and queue time get their own colors. */
function WorkerTimeline({ result, cursor, mode }: { result: RunResult; cursor?: number; mode: ShareMode }) {
  const endNs = Math.max(result.makespan, 1);
  const { div, unit } = timeUnit(endNs);
  const rows = timelineRows(result, "thread", { div, labels: true }).map((r) => ({
    ...r,
    segs: r.segs.map((s) => (s.label === "steal" ? { ...s, color: "var(--faint)", label: undefined } : s.label === "queue" ? { ...s, color: "var(--fg)", label: undefined } : s.label === "split" ? { ...s, color: tint(s.color, 55), label: undefined } : { ...s, label: undefined })),
  }));
  return (
    <>
      <Gantt rows={rows} end={endNs / div} cursor={cursor === undefined ? undefined : cursor / div} labelW={34} unit={unit} />
      <Legend items={[
        { label: "work (worker color)", color: threadColor(0) },
        ...(mode === "steal" ? [{ label: "split", color: tint(threadColor(0), 55) }, { label: "steal attempt", color: "var(--faint)" }] : []),
        ...(mode === "central" ? [{ label: "inside the queue lock", color: "var(--fg)" }, { label: "spinning (hatched) or blocked on the lock", color: "var(--muted)" }] : []),
      ]} />
    </>
  );
}

// ---------------------------------------------------------------- the deque stepper

const STEP = {
  workers: range({ label: "Workers", min: 2, max: 4, step: 1, default: 3 }),
  owner: seg("The owner pops at the", [["lifo", "bottom (LIFO)"], ["fifo", "top (FIFO)"]], "lifo"),
};

function caption(e: DequeEvent | undefined, owner: string): string {
  if (!e) return "W0 starts with the whole loop, 0–128, in its deque. The other workers have nothing.";
  const w = `W${e.worker}`;
  switch (e.kind) {
    case "pop": return `${w} pops ${rangeText(e.task!)} from the ${owner === "lifo" ? "bottom" : "top"} of its own deque. No other worker touches that end, so this is cheap.`;
    case "push": return `${w} splits its range: it pushes the right half ${rangeText(e.task!)} at the bottom and keeps the left half.`;
    case "steal": return `${w} has no work. It steals ${rangeText(e.task!)} from the top of W${e.victim}'s deque: the oldest task, so the largest one.`;
    case "fail": return `${w} tries to steal from W${e.victim}, but that deque is empty. It picks another random victim.`;
    case "run": return `${w} runs the leaf ${rangeText(e.task!)} (at most 8 items, the grain).`;
    case "done": return `${w} finishes ${rangeText(e.task!)}.`;
  }
}

export function ConcPatDequeDemo() {
  const P = useParams("conc-ws-deque", STEP);
  const { workers, owner } = P.values;
  const res = useMemo(() => runSharing({ mode: "steal", workers, owner: owner as "lifo" | "fifo", n: 128, grain: 8, itemNs: 100, spawnNs: 50, stealNs: 300, trace: true, seed: 3 }), [workers, owner]);
  const evs = res.events.filter((e) => e.kind !== "done");
  const [kRaw, setK] = useState(0);
  const k = Math.min(kRaw, evs.length);
  const e = k > 0 ? evs[k - 1] : undefined;
  const deques = e ? e.deques : [[{ lo: 0, hi: 128 }], ...Array.from({ length: workers - 1 }, () => [])];
  const running = e ? e.running : Array.from({ length: workers }, () => null);
  return (
    <Demo
      title="Per-worker deques, one event at a time"
      controls={
        <>
          <Param spec={STEP.workers} value={workers} onChange={(v) => { P.set("workers", v as number); setK(0); }} />
          <Param spec={STEP.owner} value={owner} onChange={(v) => { P.set("owner", v as "lifo"); setK(0); }} />
          <IndexSlider k={k} n={evs.length + 1} set={setK} label="Event" />
        </>
      }
      actions={<IndexButtons k={k} n={evs.length + 1} set={setK} />}
    >
      <div style={{ display: "grid", gap: 6 }}>
        {deques.map((d, w) => {
          const active = e?.worker === w;
          const victim = e?.victim === w;
          return (
            <div key={w} style={{ display: "grid", gridTemplateColumns: "34px 1fr", gap: 6, alignItems: "center", border: `1px solid ${active ? "var(--fg)" : victim ? "var(--c4)" : "var(--border)"}`, borderRadius: 6, padding: "5px 6px", boxShadow: `inset 3px 0 0 ${threadColor(w)}` }}>
              <b style={{ fontSize: 12.5 }}>W{w}</b>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", minHeight: 22 }}>
                  <span className="muted" style={{ fontSize: 11 }}>top</span>
                  {d.length === 0 && <span className="muted" style={{ fontSize: 11 }}>empty</span>}
                  {d.map((r, i) => <Chip key={i} color={threadColor(w)} bold={!!e?.task && e.task.lo === r.lo && e.task.hi === r.hi}>{rangeText(r)}</Chip>)}
                  <span className="muted" style={{ fontSize: 11 }}>bottom</span>
                </div>
                <div style={{ fontSize: 11.5, marginTop: 3 }} className="muted">
                  runs: {running[w] ? <Chip color={threadColor(w)} filled>{rangeText(running[w]!)}</Chip> : "nothing"}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <StepCaption tone={e?.kind === "steal" ? "warn" : e?.kind === "fail" ? "bad" : "info"} label={e ? `t = ${int(e.t)} ns` : "start"}>{caption(e, owner)}</StepCaption>
      <div style={{ marginTop: 8 }}>
        <WorkerTimeline result={res.run} cursor={e?.t ?? 0} mode="steal" />
      </div>
      <Stats items={[
        { label: "leaf tasks", value: res.leaves },
        { label: "steals", value: res.steals },
        { label: "failed steals", value: res.failedSteals },
        { label: "longest deque", value: res.maxDeque },
        { label: "speedup", value: fixed(res.speedup, 2) },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- three ways to share a loop

const MODES: { mode: ShareMode; label: string; color: string }[] = [
  { mode: "static", label: "static blocks", color: "var(--c2)" },
  { mode: "central", label: "one central queue", color: "var(--c4)" },
  { mode: "steal", label: "work stealing", color: "var(--c3)" },
];
const SHARE = {
  grain: range({ label: "Grain (items per task)", min: 4, max: 13, step: 1, default: 8, format: (v) => int(2 ** v) }),
  workers: range({ label: "Workers (cores)", min: 1, max: 16, step: 1, default: 8 }),
  skew: seg("Cost per item", [["uniform", "uniform"], ["triangular", "grows with i"]], "triangular"),
  show: seg("Timeline", [["static", "static"], ["central", "central queue"], ["steal", "stealing"]], "steal"),
};
const PS = [1, 2, 4, 6, 8, 12, 16];

export function ConcPatShareDemo() {
  const P = useParams("conc-ws-share", SHARE);
  const { grain: gExp, workers, skew, show } = P.values;
  const grain = 2 ** gExp;
  const sk = skew as "uniform" | "triangular";
  const jobs = useMemo(() => MODES.flatMap((m) => PS.map((p) => () => runSharing({ mode: m.mode, workers: p, grain, skew: sk, record: false }).speedup)), [grain, sk]);
  const sweep = useChunked<number>(`${grain}/${sk}`, jobs, { keep: true });
  const one = useMemo(() => Object.fromEntries(MODES.map((m) => [m.mode, runSharing({ mode: m.mode, workers, grain, skew: sk, record: m.mode === show })])) as Record<ShareMode, StealResult>, [workers, grain, sk, show]);
  const sel = one[show as ShareMode];
  return (
    <Demo
      title="Static blocks, a central queue, or work stealing"
      controls={
        <>
          <Param spec={SHARE.grain} value={gExp} onChange={(v) => P.set("grain", v as number)} />
          <Param spec={SHARE.workers} value={workers} onChange={(v) => P.set("workers", v as number)} />
          <Param spec={SHARE.skew} value={skew} onChange={(v) => P.set("skew", v as "uniform")} />
          <Param spec={SHARE.show} value={show} onChange={(v) => P.set("show", v as "steal")} />
        </>
      }
    >
      <Plot x={[1, 16]} y={[0, 16]} height={210} xLabel="workers" yLabel="speedup" xTicks={PS}>
        <Line points={[[1, 1], [16, 16]]} color="var(--faint)" dash="4 3" width={1} />
        {MODES.map((m, i) => (
          <Line key={m.mode} color={m.color} points={PS.flatMap((p, j) => { const v = sweep[i * PS.length + j]; return v === undefined ? [] : [[p, v] as [number, number]]; })} />
        ))}
      </Plot>
      <Legend items={MODES.map((m) => ({ label: m.label, color: m.color }))} />
      <Stats items={MODES.map((m) => ({ label: `${m.label}, ${workers} workers`, value: `${fixed(one[m.mode].speedup, 2)}×` }))} />
      <div style={{ marginTop: 10 }}>
        <WorkerTimeline result={sel.run} mode={show as ShareMode} />
      </div>
      <Banner tone={show === "central" && sel.lockWaitNs > sel.makespan * 0.2 ? "bad" : "info"}>
        {show === "static" && `Each worker gets ${int(65_536 / workers)} items. ${sk === "triangular" ? "The last block costs the most, so the first workers finish early and idle." : "With equal costs, static blocks are perfect and cost nothing."}`}
        {show === "central" && `${int(sel.leaves)} chunks pass through one lock. The workers waited ${int(sel.lockWaitNs / 1_000)} µs in total for it.`}
        {show === "steal" && `${int(sel.steals)} steals moved work for ${int(sel.leaves)} leaf tasks. ${int(sel.failedSteals)} attempts found an empty deque.`}
      </Banner>
    </Demo>
  );
}
