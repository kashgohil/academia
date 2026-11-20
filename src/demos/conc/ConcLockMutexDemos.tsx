/** Demos for "mutexes": handoff against barging on the Runtime, and Go's sync.Mutex with its starvation mode. */
import { useMemo } from "react";
import { Bar, Demo, Param, Stats, range, seg, toggle, useParams, pct, fixed, int, Note, SmallLabel } from "../../kit";
import { lockLoop, goMutexLoop, stateAt, LOCKED, WOKEN, STARVING, waiters, STARVATION_NS, SPIN_ROUND_NS } from "../../sims/conc/locks/mutex";
import { DEFAULT_COSTS } from "../../sims/conc";
import { ThreadTimeline, threadColor } from "./ConcViews";
import { dur, Field, FieldRow, OwnerStrip } from "./ConcLockUi";

const H = {
  threads: range({ label: "Threads", min: 1, max: 8, step: 1, default: 4 }),
  policy: seg("Unlock policy", [["barging", "free it (barging)"], ["handoff", "give to oldest waiter"]], "barging"),
  cs: range({ label: "Critical section", min: 200, max: 5_000, step: 100, default: 1_000, format: (v) => dur(v) }),
  outside: range({ label: "Work outside the lock", min: 0, max: 10_000, step: 500, default: 2_000, format: (v) => dur(v) }),
};

const WINDOW = 60_000;

export function ConcLockHandoffDemo() {
  const P = useParams("conc-lock-handoff", H);
  const { threads, policy, cs, outside } = P.values;
  const handoff = policy === "handoff";
  const spec = { threads, handoff, csNs: cs, outsideNs: outside };
  const view = useMemo(() => lockLoop({ ...spec, durationNs: WINDOW, record: true }), [threads, handoff, cs, outside]); // eslint-disable-line react-hooks/exhaustive-deps
  const long = useMemo(() => lockLoop({ ...spec, durationNs: 1_000_000, record: false }), [threads, handoff, cs, outside]); // eslint-disable-line react-hooks/exhaustive-deps
  const bound = 1e6 / (cs + DEFAULT_COSTS.lockNs + DEFAULT_COSTS.transferNs + DEFAULT_COSTS.wakeNs);
  const max = Math.max(...long.perThread, 1);
  return (
    <Demo
      title="Who gets the lock at unlock?"
      controls={
        <>
          <Param spec={H.threads} value={threads} onChange={(v) => P.set("threads", v as number)} />
          <Param spec={H.policy} value={policy} onChange={(v) => P.set("policy", v as never)} />
          <Param spec={H.cs} value={cs} onChange={(v) => P.set("cs", v as number)} />
          <Param spec={H.outside} value={outside} onChange={(v) => P.set("outside", v as number)} />
        </>
      }
    >
      <SmallLabel>The first {dur(WINDOW)} of the run, one row per thread. Labels: cs is the critical section, out is the work outside.</SmallLabel>
      <ThreadTimeline result={view.result} by="thread" end={WINDOW} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "acquisitions per ms (1 ms run)", value: int(long.perMs) },
          { label: "mean wait for the lock", value: dur(long.meanWaitNs) },
          { label: "longest wait", value: dur(long.maxWaitNs) },
          { label: "fewest / most acquisitions", value: fixed(long.evenness) },
          { label: "lock held or reserved", value: pct(long.heldFrac, 0) },
        ]} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "4px 12px", marginTop: 10 }}>
        {long.perThread.map((n, i) => (
          <div key={i} style={{ fontSize: 12 }}>
            <span className="muted">T{i}: {int(n)}</span>
            <Bar frac={n / max} color={threadColor(i)} />
          </div>
        ))}
      </div>
      <Note>
        {handoff
          ? `With handoff, each new owner must wake up first (${dur(DEFAULT_COSTS.wakeNs)}, a model input). The lock is reserved but idle for that time. Limit: 1 / (critical section + wake-up) ≈ ${int(bound)} per ms.`
          : "With barging, a running thread takes a free lock at once. A woken waiter often finds it taken again, so waits are less even."}
      </Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- Go's sync.Mutex

const G = {
  goroutines: range({ label: "Goroutines", min: 2, max: 8, step: 1, default: 4 }),
  outside: range({ label: "Work between Unlock and the next Lock", min: 0, max: 2_000, step: 100, default: 0, format: (v) => dur(v) }),
  starvation: toggle({ label: "Starvation mode (Go 1.9 and later)", default: true }),
  at: range({ label: "Look at time", min: 0, max: 8_000, step: 10, default: 1_200, format: (v) => `${(v / 1000).toFixed(2)} ms` }),
};

export function ConcLockGoMutexDemo() {
  const P = useParams("conc-lock-go", G);
  const { goroutines, outside, starvation, at } = P.values;
  const r = useMemo(() => goMutexLoop({ threads: goroutines, outsideNs: outside, starvation, record: false }), [goroutines, outside, starvation]);
  const end = 8_000_000;
  const cursor = at * 1_000;
  const band = useMemo(() => {
    const out: [number, number][] = [];
    let from = -1;
    for (const [t, s] of r.mutex.log) {
      if (s & STARVING && from < 0) from = t;
      if (!(s & STARVING) && from >= 0) {
        out.push([from, t]);
        from = -1;
      }
    }
    if (from >= 0) out.push([from, end]);
    return out;
  }, [r]);
  const state = stateAt(r.mutex.log, cursor);
  let queue: number[] = [];
  for (const [t, q] of r.mutex.qlog) {
    if (t > cursor) break;
    queue = q;
  }
  const owner = stateAt(r.mutex.ownerLog, cursor);
  const max = Math.max(...r.perThread, 1);
  const names = Array.from({ length: goroutines }, (_, i) => `G${i}`);
  return (
    <Demo
      title="Inside Go's sync.Mutex"
      controls={
        <>
          <Param spec={G.goroutines} value={goroutines} onChange={(v) => P.set("goroutines", v as number)} />
          <Param spec={G.outside} value={outside} onChange={(v) => P.set("outside", v as number)} />
          <Param spec={G.starvation} value={starvation} onChange={(v) => P.set("starvation", v as boolean)} />
          <Param spec={G.at} value={at} onChange={(v) => P.set("at", v as number)} />
        </>
      }
    >
      <SmallLabel>Who holds the lock during 8 ms. Each goroutine loops: Lock, 2 µs of work, Unlock. 4 cores. The red band is starvation mode.</SmallLabel>
      <OwnerStrip owners={r.mutex.ownerLog} threads={goroutines} end={end} band={band} bandLabel="starv." cursor={cursor} names={names} />
      <div style={{ marginTop: 8 }}>
        <SmallLabel>The state word at {(cursor / 1e6).toFixed(2)} ms</SmallLabel>
        <FieldRow>
          <Field name="mutexLocked" value={state & LOCKED ? 1 : 0} on={!!(state & LOCKED)} note={owner >= 0 ? `owner G${owner}` : "free"} />
          <Field name="mutexWoken" value={state & WOKEN ? 1 : 0} on={!!(state & WOKEN)} note="a waiter is awake" />
          <Field name="mutexStarving" value={state & STARVING ? 1 : 0} on={!!(state & STARVING)} note={state & STARVING ? "handoff mode" : "normal mode"} />
          <Field name="waiters" value={waiters(state)} on={waiters(state) > 0} note="state >> 3" />
          <Field name="sema queue" value={queue.length ? queue.map((q) => `G${q}`).join(" ") : "empty"} note="front first" />
        </FieldRow>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "4px 12px", marginTop: 10 }}>
        {r.perThread.map((n, i) => (
          <div key={i} style={{ fontSize: 12 }}>
            <span className="muted">G{i}: {int(n)} locks</span>
            <Bar frac={n / max} color={threadColor(i)} />
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "locks per ms", value: int(r.perMs) },
          { label: "longest wait", value: dur(r.maxWaitNs) },
          { label: `waits over ${dur(STARVATION_NS)}`, value: r.longWaits },
          { label: "time in starvation mode", value: pct(r.starvingFrac) },
        ]} />
      </div>
      <Note>Model inputs: wake-up {dur(DEFAULT_COSTS.wakeNs)}, one spin round (30 PAUSE instructions) {dur(SPIN_ROUND_NS)}. The 1 ms threshold, the 4 spin rounds and the state bits come from the Go source.</Note>
    </Demo>
  );
}
