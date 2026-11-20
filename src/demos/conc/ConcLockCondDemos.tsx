/** Demos for "condition-variables": a reusable barrier with and without a generation, and timed waits. */
import { useMemo } from "react";
import { Demo, Param, Stats, range, seg, useParams, Banner, SmallLabel, Note } from "../../kit";
import { barrierRun, timedWaitRun, type BarrierDesign, type TimedDesign } from "../../sims/conc/locks/condvar";
import { DEFAULT_COSTS } from "../../sims/conc";
import { ThreadTimeline } from "./ConcViews";
import { dur } from "./ConcLockUi";

const B = {
  threads: range({ label: "Threads", min: 2, max: 8, step: 1, default: 4 }),
  design: seg<BarrierDesign>("Wait condition", [["count", "while (arrived != 0)"], ["generation", "while (gen == my_gen)"]], "count"),
  work: range({ label: "Mean work per round", min: 5_000, max: 100_000, step: 5_000, default: 10_000, format: (v) => dur(v) }),
};

export function ConcLockBarrierDemo() {
  const P = useParams("conc-lock-barrier", B);
  const { threads, design, work } = P.values;
  const r = useMemo(() => barrierRun({ threads, design, workNs: work, spread: 0.5 }), [threads, design, work]);
  return (
    <Demo
      title="A reusable barrier from a mutex and a condition variable"
      controls={
        <>
          <Param spec={B.threads} value={threads} onChange={(v) => P.set("threads", v as number)} />
          <Param spec={B.design} value={design} onChange={(v) => P.set("design", v as never)} />
          <Param spec={B.work} value={work} onChange={(v) => P.set("work", v as number)} />
        </>
      }
    >
      <SmallLabel>Each thread does 8 rounds: work (labels r1, r2, …), then the barrier. Work per round varies by ±50%.</SmallLabel>
      <ThreadTimeline result={r.result} by="thread" />
      {r.hung ? (
        <Banner tone="bad">Hang at {dur(r.hangNs!)}. Every thread sleeps on the condition variable, and no thread will ever broadcast again.</Banner>
      ) : (
        <Banner tone="good">All {threads} threads finished 8 rounds at {dur(r.result.makespan)}.</Banner>
      )}
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "rounds that all threads finished", value: r.rounds },
          { label: "wake-ups that went back to sleep", value: r.resleeps },
          { label: "wake-up cost (model input)", value: dur(DEFAULT_COSTS.wakeNs) },
        ]} />
      </div>
    </Demo>
  );
}

const T = {
  noise: range({ label: "Unrelated broadcasts, every", min: 1_000_000, max: 15_000_000, step: 1_000_000, default: 4_000_000, format: (v) => dur(v) }),
  design: seg<TimedDesign>("Timed wait", [["relative", "loop of wait_for(10 ms)"], ["deadline", "wait_until(start + 10 ms)"]], "relative"),
};

const LIMIT = 60_000_000;

export function ConcLockTimedWaitDemo() {
  const P = useParams("conc-lock-timed", T);
  const { noise, design } = P.values;
  const r = useMemo(() => timedWaitRun({ noiseNs: noise, design, limitNs: LIMIT }), [noise, design]);
  return (
    <Demo
      title="A 10 ms timeout that never fires"
      controls={
        <>
          <Param spec={T.noise} value={noise} onChange={(v) => P.set("noise", v as number)} />
          <Param spec={T.design} value={design} onChange={(v) => P.set("design", v as never)} />
        </>
      }
    >
      <SmallLabel>The waiter waits for "ready", which never comes, with a 10 ms timeout. The notifier broadcasts for other reasons. The timer thread stands in for the kernel timer.</SmallLabel>
      <ThreadTimeline result={r.result} by="thread" end={LIMIT} labels={false} />
      {r.outcome === "timeout" ? (
        <Banner tone="good">The wait timed out at {dur(r.returnedNs!)}.</Banner>
      ) : (
        <Banner tone="bad">Still waiting after {dur(LIMIT)}. Each wake-up started a new 10 ms timeout.</Banner>
      )}
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "wake-ups of the waiter", value: r.wakeups },
          { label: "returned at", value: r.returnedNs === undefined ? "never" : dur(r.returnedNs) },
        ]} />
      </div>
      <Note>The timer thread checks the armed timeout every 100 µs, so a timeout fires up to 0.1 ms late in this model.</Note>
    </Demo>
  );
}
