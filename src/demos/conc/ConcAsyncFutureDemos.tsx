/** Demos for "futures and promises": be the executor and the waker, and combinators with and without cancellation. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, Legend, MONO, Panel, Param, SmallLabel, Stats, range, seg, tint, toggle, useParams } from "../../kit";
import {
  COMBINATOR_NAMES, DEFAULT_CHILDREN, GAME_TASKS, combine, gameReplay, gameStuck, type CancelMode, type Combinator, type GameAction,
} from "../../sims/conc/async";
import { Gantt, type GanttMark, type GanttRow } from "../os/SchedulingGantt";

// ---------------------------------------------------------------- the executor game

const GAME = { buggy: toggle({ label: "Buggy leaf future: return Pending without storing the waker", default: false }) };
const TASK_COLOR = ["var(--c1)", "var(--c2)"];

export function ConcAsyncPollGame() {
  const P = useParams("conc-async-poll", GAME);
  const [actions, setActions] = useState<GameAction[]>([]);
  const states = useMemo(() => gameReplay(actions, P.values.buggy), [actions, P.values.buggy]);
  const s = states[states.length - 1]!;
  const stuck = gameStuck(s);
  const act = (a: GameAction) => setActions((x) => [...x, a]);
  const done = s.tasks.every((t) => t.done);
  const wakerName = (w: number) => (w < 0 ? "none" : s.tasks[w]!.name);
  return (
    <Demo
      title="You are the executor"
      controls={<Param spec={GAME.buggy} value={P.values.buggy} onChange={(v) => { P.set("buggy", v as boolean); setActions([]); }} />}
      actions={<><Btn onClick={() => setActions((x) => x.slice(0, -1))} disabled={!actions.length}>Undo</Btn><Btn onClick={() => setActions([])} disabled={!actions.length}>Reset</Btn></>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
        {GAME_TASKS.map((d, i) => {
          const t = s.tasks[i]!;
          return (
            <Panel key={d.name} title={`task ${d.name}: ${t.done ? "done" : !t.polled ? "created, never polled" : "suspended"}`} accent={TASK_COLOR[i]} active={s.ready.includes(i)}>
              <pre style={{ fontFamily: MONO, fontSize: 12, margin: 0, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                {d.code.map((l, j) => (
                  <div key={j} style={{ background: !t.done && t.polled && j === t.pc ? tint(TASK_COLOR[i]!, 30) : undefined, opacity: t.done || j >= t.pc ? 1 : 0.5 }}>{l}</div>
                ))}
              </pre>
            </Panel>
          );
        })}
        <Panel title={`Reactor and timers, clock ${s.now} ms`} accent="var(--c4)">
          <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
            <div>socket a: {s.sockets.a.data ? <b>data buffered</b> : "empty"}, waker: <b>{wakerName(s.sockets.a.waker)}</b></div>
            <div>socket b: {s.sockets.b.data ? <b>data buffered</b> : "empty"}, waker: <b>{wakerName(s.sockets.b.waker)}</b></div>
            <div>timers: {s.timers.length ? s.timers.map((t) => `${t.deadline} ms → ${wakerName(t.waker)}`).join(", ") : "none"}</div>
          </div>
        </Panel>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Ready queue:</span>
        {s.ready.length === 0 && <span className="muted" style={{ fontSize: 12 }}>empty</span>}
        {s.ready.map((i) => <Chip key={i} color={TASK_COLOR[i]} filled>{s.tasks[i]!.name}</Chip>)}
      </div>
      <ButtonRow style={{ marginTop: 8 }}>
        <span style={{ fontSize: 12.5, minWidth: 64 }}>Executor:</span>
        {s.tasks.map((t, i) => <Btn key={i} on={s.ready.includes(i)} disabled={t.done} onClick={() => act({ k: "poll", task: i })}>poll({t.name})</Btn>)}
      </ButtonRow>
      <ButtonRow style={{ marginTop: 6 }}>
        <span style={{ fontSize: 12.5, minWidth: 64 }}>World:</span>
        <Btn disabled={s.sockets.a.data} onClick={() => act({ k: "data", res: "a" })}>data on a</Btn>
        <Btn disabled={s.sockets.b.data} onClick={() => act({ k: "data", res: "b" })}>data on b</Btn>
        <Btn onClick={() => act({ k: "time", ms: 10 })}>+10 ms</Btn>
      </ButtonRow>
      <div style={{ marginTop: 8, fontFamily: MONO, fontSize: 12, lineHeight: 1.5, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", maxHeight: 150, overflowY: "auto" }}>
        {s.log.slice(-6).map((l, i, a) => <div key={s.log.length - a.length + i} style={{ opacity: i === a.length - 1 ? 1 : 0.6 }}>{l}</div>)}
      </div>
      <div style={{ marginTop: 8 }}>
        <Stats items={[{ label: "polls", value: s.polls }, { label: "wasted polls (not woken, no progress)", value: s.wasted }, { label: "tasks done", value: `${s.tasks.filter((t) => t.done).length} of 2` }]} />
      </div>
      {done ? <Banner tone="good">Both tasks are done after {s.polls} polls, {s.wasted} of them wasted.</Banner>
        : stuck.length ? <Banner tone="bad">Task {stuck.map((i) => s.tasks[i]!.name).join(", ")} returned Pending, and no waker for it is stored anywhere. No event can wake it: it hangs unless the executor polls it blindly.</Banner>
          : <Banner tone="plain">Poll only tasks in the ready queue (outlined). Deliver events to see who wakes.</Banner>}
    </Demo>
  );
}

// ---------------------------------------------------------------- combinators and cancellation

const COMB = {
  comb: seg<Combinator>("Combinator", [["all", "all"], ["race", "race"], ["any", "any"], ["allSettled", "allSettled"]], "all"),
  cancel: seg<CancelMode>("Losers", [["none", "JS: keep running"], ["drop", "Rust: dropped"]], "none"),
  ms3: range({ label: "Latency of replica 3", min: 10, max: 150, step: 5, default: 50, format: (v) => `${v} ms` }),
};

export function ConcAsyncCombinatorDemo() {
  const P = useParams("conc-async-comb", COMB);
  const { comb, cancel, ms3 } = P.values;
  const [fails, setFails] = useState<boolean[]>(DEFAULT_CHILDREN.map((c) => c.fails));
  const children = DEFAULT_CHILDREN.map((c, i) => ({ ...c, ms: i === 2 ? ms3 : c.ms, fails: fails[i]! }));
  const r = combine(children, comb, cancel);
  const end = 130;
  const rows: GanttRow[] = r.children.map((c) => ({
    label: c.name.replace("replica ", "r"),
    segs: [
      { start: 0, end: Math.min(c.end, r.at), color: c.fails ? "var(--c4)" : "var(--c1)" },
      ...(c.end > r.at ? [{ start: r.at, end: c.end, color: tint(c.fails ? "var(--c4)" : "var(--c1)", 35) }] : []),
    ],
  }));
  const marks: GanttMark[] = r.children.flatMap((c, i): GanttMark[] => (c.outcome === "error" ? [{ t: c.end, row: i, kind: "miss" }] : c.dropped ? [{ t: c.end, row: i, kind: "deadline" }] : []));
  const names = COMBINATOR_NAMES[comb];
  return (
    <Demo
      title="Combinators and the losers"
      controls={<><Param spec={COMB.comb} value={comb} onChange={(v) => P.set("comb", v as Combinator)} /><Param spec={COMB.cancel} value={cancel} onChange={(v) => P.set("cancel", v as CancelMode)} /><Param spec={COMB.ms3} value={ms3} onChange={(v) => P.set("ms3", v as number)} /></>}
    >
      <ButtonRow>
        <span className="muted" style={{ fontSize: 12 }}>Click to make a replica fail:</span>
        {children.map((c, i) => <Chip key={i} color={c.fails ? "var(--c4)" : "var(--c1)"} filled={c.fails} onClick={() => setFails((f) => f.map((x, j) => (j === i ? !x : x)))}>{c.name}: {c.fails ? "fails" : "ok"}</Chip>)}
      </ButtonRow>
      <div style={{ marginTop: 8 }}>
        <Gantt rows={rows} end={end} marks={marks} rules={[{ t: r.at, color: "var(--fg)" }]} unit="ms" labelW={30} />
      </div>
      <Legend items={[{ label: "running, result used", color: "var(--c1)" }, { label: "will fail", color: "var(--c4)" }, { label: "after the result: work nobody uses", color: tint("var(--c1)", 35) }]} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "settles at", value: `${r.at} ms` },
          { label: "result", value: r.outcome === "ok" ? "fulfilled" : "rejected" },
          { label: "why", value: r.why },
          { label: "work after it settles", value: `${r.wastedMs} ms` },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 8 }}>
        JavaScript: <code>{names.js}</code>. Rust (futures crate): <code>{names.rust}</code>. The vertical line is the moment the combinator settles.
      </SmallLabel>
    </Demo>
  );
}
