/** Demos for "event loops": be the loop (pick the next callback), and one slow callback on a server loop. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Chip, Demo, Dots, IndexButtons, IndexSlider, Legend, MONO, Panel, Param, Plot, RuleY, SmallLabel, Stats,
  StepCaption, ms, range, select, seg, useParams,
} from "../../kit";
import { LOOP_PROGRAMS, candidates, isNext, loopServer, runLoop, type QItem, type QueueName } from "../../sims/conc/async";
import { ThreadTimeline } from "./ConcViews";

// ---------------------------------------------------------------- be the loop

const PROG = select({ label: "Program", options: LOOP_PROGRAMS.map((p) => ({ value: p.id, label: p.title })), default: "order" });

const Q_LABEL: Record<QueueName, string> = { script: "script", tick: "nextTick", micro: "microtask", timer: "timer", io: "I/O", immediate: "setImmediate", wait: "wait" };

function Queue({ title, items, pick, due, accent }: { title: string; items: QItem[]; pick?: () => void; due?: boolean; accent: string }) {
  return (
    <Panel title={title} accent={accent}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, minHeight: 20 }}>
        {items.length === 0 && <span className="muted" style={{ fontSize: 12 }}>empty</span>}
        {items.map((it, i) => (
          <Chip key={it.id} color={accent} filled={i === 0 && !!pick} onClick={i === 0 ? pick : undefined} title={i === 0 && pick ? "Run this next" : undefined}>
            {it.cb.name}{due ? ` @${it.due}` : ""}
          </Chip>
        ))}
      </div>
    </Panel>
  );
}

export function ConcAsyncLoopStepper() {
  const P = useParams("conc-async-loop", { prog: PROG });
  const prog = LOOP_PROGRAMS.find((p) => p.id === P.values.prog) ?? LOOP_PROGRAMS[0]!;
  const frames = useMemo(() => runLoop(prog), [prog]);
  const [pos, setPos] = useState({ id: prog.id, k: 0, wrong: "" });
  const k = pos.id === prog.id ? Math.min(pos.k, frames.length - 1) : 0;
  const wrong = pos.id === prog.id ? pos.wrong : "";
  const set = (j: number, w = "") => setPos({ id: prog.id, k: j, wrong: w });
  const f = frames[k]!;
  const s = f.state;
  const node = prog.mode === "node";
  const cands = candidates(s, prog.mode);
  const choose = (q: QueueName, id: number) => {
    if (k >= frames.length - 1) return;
    if (isNext(frames, k, q, id)) set(frames[k + 1]!.pick?.q === "wait" ? k + 2 : k + 1);
    else {
      const n = frames[k + 1]!.pick?.q === "wait" ? frames[k + 2]! : frames[k + 1]!;
      set(k, `Not ${Q_LABEL[q]} yet. ${n.rule}`);
    }
  };
  const pickOf = (q: QueueName, a: QItem[]) => (a[0] && cands.some((c) => c.q === q) ? () => choose(q, a[0]!.id) : undefined);
  const phases = node ? ["script", "microtasks", "timers", "poll", "check"] : ["script", "microtasks", "task"];
  const done = k >= frames.length - 1;
  return (
    <Demo
      title="Be the event loop"
      controls={
        <>
          <Param spec={PROG} value={prog.id} onChange={(v) => { P.set("prog", v as string); setPos({ id: v as string, k: 0, wrong: "" }); }} />
          <IndexSlider k={k} n={frames.length} set={(j) => set(j)} label="Frame" />
        </>
      }
      actions={<IndexButtons k={k} n={frames.length} set={(j) => set(j)} />}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <SmallLabel>{node ? "Node.js, CommonJS main script" : "Browser"}</SmallLabel>
          <pre style={{ fontFamily: MONO, fontSize: 12, lineHeight: 1.5, margin: 0, padding: 8, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 6, overflowX: "auto" }}>
            {prog.code.join("\n")}
          </pre>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8, alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 12 }}>Loop:</span>
            {phases.map((ph) => <Chip key={ph} color={s.phase === ph ? "var(--c1)" : "var(--muted)"} filled={s.phase === ph} faint={s.phase !== ph}>{ph}</Chip>)}
            <span className="muted" style={{ fontSize: 12, marginLeft: "auto", fontFamily: MONO }}>t = {s.t} ms</span>
          </div>
        </div>
        <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
          <Panel title="Call stack (just ran)" accent="var(--fg)">
            <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{k === 0 ? "empty" : f.pick?.q === "wait" ? "empty: the loop waits" : frames[k]!.state.running ?? "empty"}</span>
          </Panel>
          {node && <Queue title="nextTick queue" items={s.tick} accent="var(--c5)" pick={pickOf("tick", s.tick)} />}
          <Queue title="Microtask queue (promise jobs)" items={s.micro} accent="var(--c3)" pick={pickOf("micro", s.micro)} />
          <Queue title="Timers (due at ms)" items={s.timers} due accent="var(--c2)" pick={pickOf("timer", s.timers)} />
          {(node || s.io.length > 0) && <Queue title="I/O in flight (done at ms)" items={s.io} due accent="var(--c4)" pick={pickOf("io", s.io)} />}
          {node && <Queue title="Check queue (setImmediate)" items={s.immediate} accent="var(--c1)" pick={pickOf("immediate", s.immediate)} />}
        </div>
      </div>
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>Output:</span>
        {s.out.length === 0 && <span className="muted" style={{ fontSize: 12 }}>nothing yet</span>}
        {s.out.map((o, i) => <Chip key={i} bold>{o}</Chip>)}
      </div>
      {!done && (
        <ButtonRow style={{ marginTop: 8 }}>
          <span style={{ fontSize: 12.5 }}>Your turn. Run next:</span>
          {cands.map((c) => <Btn key={`${c.q}${c.id}`} onClick={() => choose(c.q, c.id)}>{Q_LABEL[c.q]}: {c.name}</Btn>)}
          {cands.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>press Next to run the main script</span>}
        </ButtonRow>
      )}
      {wrong ? <Banner tone="bad">{wrong}</Banner> : <StepCaption label={`${k + 1}/${frames.length}`}>{f.action} {f.rule && k > 0 ? <span className="muted">{f.rule}</span> : null}</StepCaption>}
    </Demo>
  );
}

// ---------------------------------------------------------------- one slow callback

const SERVER = {
  strategy: seg("Slow work", [["inline", "inline"], ["chunked", "in 1 ms slices"], ["offload", "worker pool"]], "inline"),
  slowMs: range({ label: "Slow callback", min: 0, max: 50, step: 1, default: 20, format: (v) => `${v} ms` }),
  slowEvery: range({ label: "One slow request in", min: 10, max: 100, step: 10, default: 40, format: (v) => `${v}` }),
};

export function ConcAsyncBlockingDemo() {
  const P = useParams("conc-async-block", SERVER);
  const { strategy, slowMs, slowEvery } = P.values;
  const r = useMemo(() => loopServer({ strategy, slowMs, slowEvery }), [strategy, slowMs, slowEvery]);
  const toMs = (ns: number) => ns / 1e6;
  const fast = r.reqs.filter((q) => !q.slow).map((q) => [toMs(q.arrive), Math.max(0.05, toMs(q.done - q.arrive))] as [number, number]);
  const slow = r.reqs.filter((q) => q.slow).map((q) => [toMs(q.arrive), Math.max(0.05, toMs(q.done - q.arrive))] as [number, number]);
  const end = Math.max(...r.reqs.map((q) => toMs(q.arrive)), 1);
  return (
    <Demo title="One slow callback on a server loop" controls={<><Param spec={SERVER.strategy} value={strategy} onChange={(v) => P.set("strategy", v as never)} /><Param spec={SERVER.slowMs} value={slowMs} onChange={(v) => P.set("slowMs", v as number)} /><Param spec={SERVER.slowEvery} value={slowEvery} onChange={(v) => P.set("slowEvery", v as number)} /></>}>
      <Plot x={[0, end * 1.03]} y={[0.05, 100]} logY height={220} xLabel="arrival time (ms)" yLabel="latency (ms, log)" yTicks={[0.1, 1, 10, 100]} yFormat={(v) => `${v}`}>
        <RuleY at={0.1} label="handler alone" />
        <Dots points={fast} color="var(--c1)" r={2.5} />
        <Dots points={slow} color="var(--c4)" r={4} />
      </Plot>
      <Legend items={[{ label: "normal request (100 µs of CPU)", color: "var(--c1)" }, { label: "slow request", color: "var(--c4)" }]} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "normal, p50", value: ms(toMs(r.fast.p50)) },
          { label: "normal, p99", value: ms(toMs(r.fast.p99)) },
          { label: "normal, max", value: ms(toMs(r.fast.max)) },
          { label: "slow, mean", value: slowMs ? ms(toMs(r.slowMean)) : "–" },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 10 }}>What ran when (200 requests at about 1 per ms)</SmallLabel>
      <ThreadTimeline result={r.run} by="thread" labels={false} />
    </Demo>
  );
}
