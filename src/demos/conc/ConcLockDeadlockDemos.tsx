/** Demos for "deadlock, livelock and starvation": try-lock strategies and deadlock detection. */
import { useMemo } from "react";
import { Demo, Param, Stats, range, seg, toggle, useParams, Banner, SmallLabel } from "../../kit";
import { transfers, abba, type Strategy } from "../../sims/conc/locks/deadlock";
import { ThreadTimeline } from "./ConcViews";
import { dur } from "./ConcLockUi";

const L = {
  jitter: range({ label: "Back-off jitter", min: 0, max: 1, step: 0.05, default: 0, format: (v) => `±${Math.round(v * 100)}%` }),
  strategy: seg<Strategy>("Strategy", [["backoff", "try-lock, back off"], ["stdlock", "std::lock style"], ["order", "lock order"]], "backoff"),
};

export function ConcLockLivelockDemo() {
  const P = useParams("conc-lock-live", L);
  const { jitter, strategy } = P.values;
  const r = useMemo(() => transfers({ strategy, jitter }), [strategy, jitter]);
  const end = r.finishNs ?? r.result.now;
  return (
    <Demo
      title="Two transfers in opposite directions"
      controls={
        <>
          <Param spec={L.jitter} value={jitter} onChange={(v) => P.set("jitter", v as number)} />
          <Param spec={L.strategy} value={strategy} onChange={(v) => P.set("strategy", v as never)} />
        </>
      }
    >
      <SmallLabel>Thread A→B needs lock A, then B. Thread B→A needs B, then A. Each must do 10 transfers on 2 cores. Solid: running; thin line: sleeping in back-off or blocked.</SmallLabel>
      <ThreadTimeline result={r.result} by="thread" end={end} labels={false} />
      {r.finishNs === undefined ? (
        <Banner tone="bad">Livelock. Both threads ran for {dur(r.result.now)} and finished {r.done[0]! + r.done[1]!} of 20 transfers. They keep failing in step.</Banner>
      ) : (
        <Banner tone="good">Both threads finished their 10 transfers at {dur(r.finishNs)}.</Banner>
      )}
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "transfers done", value: `${r.done[0]} + ${r.done[1]}` },
          { label: "failed try-locks", value: r.failures },
          { label: "finished at", value: r.finishNs === undefined ? "not finished" : dur(r.finishNs) },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- detection

const D = {
  offset: range({ label: "T2 starts after", min: 0, max: 10_000, step: 500, default: 1_000, format: (v) => dur(v) }),
  background: toggle({ label: "A background goroutine (a ticker) also runs", default: false }),
};

export function ConcLockAbbaDemo() {
  const P = useParams("conc-lock-abba", D);
  const { offset, background } = P.values;
  const r = useMemo(() => abba({ offsetNs: offset, background, limitNs: 300_000 }), [offset, background]);
  return (
    <Demo
      title="When does the runtime notice?"
      controls={
        <>
          <Param spec={D.offset} value={offset} onChange={(v) => P.set("offset", v as number)} />
          <Param spec={D.background} value={background} onChange={(v) => P.set("background", v as boolean)} />
        </>
      }
    >
      <SmallLabel>T1 locks A, works 5 µs, locks B. T2 locks B, works 5 µs, locks A.</SmallLabel>
      <ThreadTimeline result={r.result} by="thread" end={r.result.deadlock ? Math.max(30_000, r.result.deadlock.t * 2) : r.result.now} labels={false} />
      {r.reported ? (
        <Banner tone="bad">fatal error: all goroutines are asleep - deadlock! The runtime saw it, because no thread at all could run.</Banner>
      ) : r.stuck ? (
        <Banner tone="bad">T1 and T2 are stuck forever, but the ticker still runs. The runtime reports nothing. The run stopped at {dur(r.result.now)}.</Banner>
      ) : (
        <Banner tone="good">No deadlock: T1 had both locks before T2 took B.</Banner>
      )}
    </Demo>
  );
}
