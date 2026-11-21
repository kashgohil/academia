/** Demos for the lesson on speculative execution. */
import { useMemo, useState } from "react";
import { Area, Demo, IndexButtons, IndexSlider, Legend, MiniTable, Note, Param, Plot, SectionLabel, Stats, StepCaption, fixed, range, seg, useChunked } from "../../kit";
import { probeLines, spectreRun, windowRun, WINDOW_SWEEP, type BranchMode, type Mitigation } from "../../sims/arch/ooo";
import { OooTimeline, ProbeLines } from "./ArchOooUi";

const PRED: [BranchMode, string][] = [["perfect", "Perfect"], ["gshare", "gshare"], ["two-bit", "2-bit"], ["not-taken", "Not taken"]];

/** The instruction window over time: correct-path and wrong-path entries in the ROB. */
export function OooWindowDemo() {
  const [rob, setRob] = useState(64);
  const [pred, setPred] = useState<BranchMode>("two-bit");
  const r = useMemo(() => windowRun(pred, rob), [pred, rob]);
  const occ = r.occupancy;
  const total = occ.map((o, i) => [i, o.rob] as [number, number]);
  const wrong = occ.map((o, i) => [i, o.wrong] as [number, number]);
  const sweep = useChunked("window-sweep", useMemo(() => PRED.flatMap(([p]) => WINDOW_SWEEP.map((s) => () => windowRun(p, s).ipc)), []));
  return (
    <Demo
      title="The window fills, a mispredict empties it"
      controls={<>
        <Param spec={range({ label: "ROB entries", min: 16, max: 256, step: 16, default: 64 })} value={rob} onChange={(v) => setRob(v as number)} />
        <Param spec={seg("Branch predictor", PRED, "two-bit")} value={pred} onChange={(v) => setPred(v as BranchMode)} />
      </>}
    >
      <Plot x={[0, Math.max(10, occ.length)]} y={[0, rob]} height={200} xLabel="cycle" yLabel="ROB entries in use">
        <Area points={total} color="var(--c1)" opacity={0.35} />
        <Area points={wrong} color="var(--c4)" opacity={0.6} />
      </Plot>
      <Legend items={[{ label: "correct path", color: "var(--c1)" }, { label: "wrong path (will be squashed)", color: "var(--c4)" }]} />
      <Stats items={[
        { label: "Cycles", value: r.cycles },
        { label: "Instructions per cycle", value: fixed(r.ipc) },
        { label: "Mispredicts", value: `${r.stats.mispredicts} of ${r.stats.branches}` },
        { label: "Wrong-path instructions fetched", value: r.stats.wrongPath },
        { label: "Average entries in use", value: fixed(r.stats.robAvg, 1) },
      ]} />
      <SectionLabel>Instructions per cycle by window size</SectionLabel>
      <MiniTable
        head={["Predictor", ...WINDOW_SWEEP.map(String)]}
        highlight={PRED.findIndex(([p]) => p === pred)}
        rows={PRED.map(([, l], i) => [l, ...WINDOW_SWEEP.map((_, j) => { const v = sweep[i * WINDOW_SWEEP.length + j]; return v === undefined ? "…" : fixed(v); })])}
      />
      <Note>The program counts which of 32 random values are above 50. Each value is on its own cache line, so each load misses (100 cycles), and the branch on it waits for the miss. Width 4, a front end of 3 cycles (model inputs).</Note>
    </Demo>
  );
}

const MIT: [Mitigation, string][] = [["none", "None"], ["fence", "Barrier after the check"], ["mask", "Mask the index"]];

/** Spectre variant 1 as a concept: the squashed path leaves one probe line in the cache. */
export function OooSpectreDemo() {
  const [secret, setSecret] = useState(11);
  const [mit, setMit] = useState<Mitigation>("none");
  const [k, setK] = useState(10_000);
  const r = useMemo(() => spectreRun(secret, mit), [secret, mit]);
  const start = r.uops.find((u) => u.text === "li a0, 40" && !u.wrong)!;
  const frames = r.frames.slice(start.fetch);
  const n = frames.length;
  const c = Math.min(k, n - 1);
  const f = frames[c]!;
  const calls = r.uops.filter((u) => u.id >= start.id);
  const probe = probeLines(f.lines);
  const leaked = probe.filter((x) => x !== 0);
  const wrongNow = f.rob.filter((u) => u.wrong).length;
  const squashedYet = calls.some((u) => u.wrong && u.squash >= 0 && u.squash <= f.cycle);
  const text = wrongNow > 0
    ? `The bounds check waits for size (a miss). The predictor said "in bounds", so ${wrongNow} wrong-path instructions run now, with x = 40.`
    : squashedYet
      ? leaked.length
        ? `The branch resolved and the wrong path is gone: no register changed. But probe line ${leaked.join(", ")} is now in the cache, and its number is the secret byte.`
        : `The branch resolved and the wrong path is gone. No probe line other than 0 (from the training calls) is in the cache.`
      : "The third call starts. Its x = 40 is out of bounds and points at the secret byte.";
  return (
    <Demo
      title="What a squashed load leaves behind"
      actions={<IndexButtons k={c} n={n} set={setK} />}
      controls={<>
        <IndexSlider k={c} n={n} set={setK} label="Cycle of the third call" />
        <Param spec={range({ label: "Secret byte", min: 1, max: 15, step: 1, default: 11 })} value={secret} onChange={(v) => setSecret(v as number)} />
        <Param spec={seg("Mitigation", MIT, "none")} value={mit} onChange={(v) => setMit(v as Mitigation)} />
      </>}
    >
      <StepCaption tone={leaked.length ? "bad" : wrongNow ? "warn" : "info"} label={`cycle ${f.cycle}`}>{text}</StepCaption>
      <SectionLabel>Probe array: 16 cache lines, and a load time for each (cycles)</SectionLabel>
      <ProbeLines present={probe} mark={secret} hit={r.config.lat.hit} miss={r.config.lat.miss} />
      <SectionLabel>Timeline of the third call (red text: wrong path)</SectionLabel>
      <OooTimeline uops={calls} cursor={f.cycle} maxRows={36} />
      <Note>A miss takes 100 cycles and a hit 4 (model inputs). An attacker who can time a load of each probe line finds the one fast line. This page shows the cache state directly and has no timing code.</Note>
    </Demo>
  );
}
