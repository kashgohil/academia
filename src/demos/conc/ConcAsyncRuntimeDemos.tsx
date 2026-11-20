/** Demos for "Rust async runtimes": Tokio's work-stealing scheduler, and a task that hogs its worker thread. */
import { useMemo } from "react";
import { Demo, Dots, Param, Plot, SmallLabel, Stats, ms, range, seg, toggle, useParams } from "../../kit";
import { TOKIO, hogRun, quantile, tokioSched, type HogMode, type Workload } from "../../sims/conc/async";
import { ThreadTimeline } from "./ConcViews";

// ---------------------------------------------------------------- the scheduler

const SCHED = {
  workers: range({ label: "Worker threads", min: 1, max: 8, step: 1, default: 4 }),
  workload: seg<Workload>("Workload", [["fanout", "one task spawns 64"], ["pingpong", "ping-pong under load"]], "fanout"),
  steal: toggle({ label: "Work stealing", default: true }),
  lifo: toggle({ label: "LIFO slot", default: true }),
  cap: seg<"256" | "16">("Local queue capacity", [["256", "256 (Tokio)"], ["16", "16"]], "256"),
};

export function ConcAsyncStealDemo() {
  const P = useParams("conc-async-steal", SCHED);
  const { workers, workload, steal, lifo, cap } = P.values;
  const r = useMemo(() => tokioSched({ workers, workload, steal, lifo, capacity: Number(cap), tasks: workload === "fanout" ? 64 : 8 }), [workers, workload, steal, lifo, cap]);
  const us = (ns: number) => ms(ns / 1e6);
  const rttMean = r.rtt.length ? r.rtt.reduce((a, b) => a + b, 0) / r.rtt.length : 0;
  return (
    <Demo
      title="Tokio's scheduler, one poll at a time"
      controls={<>
        <Param spec={SCHED.workers} value={workers} onChange={(v) => P.set("workers", v as number)} />
        <Param spec={SCHED.workload} value={workload} onChange={(v) => P.set("workload", v as Workload)} />
        <Param spec={SCHED.steal} value={steal} onChange={(v) => P.set("steal", v as boolean)} />
        <Param spec={SCHED.lifo} value={lifo} onChange={(v) => P.set("lifo", v as boolean)} />
        <Param spec={SCHED.cap} value={cap} onChange={(v) => P.set("cap", v as "256" | "16")} />
      </>}
    >
      <ThreadTimeline result={r.run} by="thread" labels={false} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "all done at", value: us(r.makespan) },
          { label: "polls per worker", value: r.polls.join(" / ") },
          { label: "steals (tasks stolen)", value: `${r.steals} (${r.stolen})` },
          { label: "polls from the LIFO slot", value: r.lifoPolls },
          { label: "local queue overflows", value: r.overflows },
          ...(workload === "pingpong"
            ? [{ label: "ping-pong round trip, median", value: us(quantile(r.rtt, 0.5)) }, { label: "round trip, mean", value: us(rttMean) }]
            : [{ label: "parks", value: r.parks }]),
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 6 }}>
        Each child polls for 50 µs; background tasks poll 50 µs and yield. At most {TOKIO.maxLifoPollsPerTick} LIFO polls run in a row. Model inputs: a steal costs 200 ns, a spawn 300 ns, an unpark 5 µs.
      </SmallLabel>
    </Demo>
  );
}

// ---------------------------------------------------------------- hogging the worker

const HOG = {
  mode: seg<HogMode>("The busy task", [["nobudget", "ready channel, no budget"], ["budget", "with a budget"], ["blocking", "blocking call"], ["spawn_blocking", "spawn_blocking"]], "nobudget"),
  budget: range({ label: "Budget (operations per poll)", min: 4, max: 10, step: 1, default: 7, format: (v) => String(2 ** v) }),
  perMsg: range({ label: "CPU per message", min: 1, max: 10, step: 1, default: 2, format: (v) => `${v} µs` }),
};

export function ConcAsyncHogDemo() {
  const P = useParams("conc-async-hog", HOG);
  const { mode, budget, perMsg } = P.values;
  const r = useMemo(() => hogRun({ mode, budget: 2 ** budget, perMsgUs: perMsg, blockMs: (5_000 * perMsg) / 1_000 }), [mode, budget, perMsg]);
  const pts = r.lateness.map(([t, l]) => [t / 1e6, Math.max(0.001, l / 1e6)] as [number, number]);
  return (
    <Demo
      title="One task hogs a current_thread runtime"
      controls={<>
        <Param spec={HOG.mode} value={mode} onChange={(v) => P.set("mode", v as HogMode)} />
        <Param spec={HOG.budget} value={budget} onChange={(v) => P.set("budget", v as number)} />
        <Param spec={HOG.perMsg} value={perMsg} onChange={(v) => P.set("perMsg", v as number)} />
      </>}
    >
      <Plot x={[0, 21]} y={[0.001, 100]} logY height={180} xLabel="time (ms)" yLabel="heartbeat lateness (ms, log)" yTicks={[0.001, 0.01, 0.1, 1, 10, 100]} yFormat={(v) => `${v}`}>
        <Dots points={pts} color="var(--c2)" r={3.5} />
      </Plot>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "worst heartbeat lateness", value: ms(r.maxLate / 1e6) },
          { label: "median lateness", value: ms(r.p50Late / 1e6) },
          { label: "busy task finished at", value: ms(r.busyDone / 1e6) },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 10 }}>What ran when. The busy task does 5,000 messages of work ({ms((5 * perMsg))} in all) from 3.5 ms on.</SmallLabel>
      <ThreadTimeline result={r.run} by="thread" labels={false} />
    </Demo>
  );
}
