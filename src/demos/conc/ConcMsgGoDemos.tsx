/** Demos for "Go channels and select": the runtime's hchan step by step, select fairness, and goroutine leaks. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Chip, Demo, Dots, Legend, Line, MONO, Meter, Note, Panel, Param, Plot, RuleX, SectionLabel, Stats, fixed, int, range, seg, useChunked, useParams,
} from "../../kit";
import {
  GO_COSTS, PATH_TEXT, replayHchan, runLeak, runSelectFairness, type ChanAction, type FairResult, type GStatus, type LeakMode,
} from "../../sims/conc/message-passing";
import { ThreadTimeline, threadColor } from "./ConcViews";

// ---------------------------------------------------------------- hchan, step by step

const GS = 4;
const HC = { cap: seg("make(chan int, N)", [["nil", "nil"], ["0", "0"], ["1", "1"], ["2", "2"], ["3", "3"]], "2") };

const STATUS: Record<GStatus, { text: string; color: string }> = {
  ready: { text: "runnable", color: "var(--c3)" },
  "blocked-send": { text: "parked on sendq", color: "var(--c2)" },
  "blocked-recv": { text: "parked on recvq", color: "var(--c2)" },
  "blocked-forever": { text: "blocked forever", color: "var(--c4)" },
  panicked: { text: "panicked", color: "var(--c4)" },
};

const FIELD = ({ name, value }: { name: string; value: string | number }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontFamily: MONO, fontSize: 12.5 }}>
    <span className="muted">{name}</span>
    <b>{value}</b>
  </div>
);

export function ConcMsgHchanDemo() {
  const P = useParams("conc-msg-hchan", HC);
  const cap = P.values.cap === "nil" ? null : Number(P.values.cap);
  const [acts, setActs] = useState<ChanAction[]>([]);
  const c = useMemo(() => replayHchan(cap, acts, GS), [cap, acts]);
  const step = c.log[c.log.length - 1];
  const push = (a: ChanAction) => setActs([...acts, a]);
  const setup = (list: ChanAction[]) => setActs(list);
  const fill = Array.from({ length: cap ?? 0 }, () => ({ g: 0, op: "send" as const }));
  return (
    <Demo
      title="Inside a Go channel"
      actions={<>
        <Btn ghost onClick={() => setActs(acts.slice(0, -1))} disabled={!acts.length}>Back</Btn>
        <Btn ghost onClick={() => setActs([])}>Reset</Btn>
      </>}
      controls={<Param spec={HC.cap} value={P.values.cap} onChange={(v) => { P.set("cap", v as never); setActs([]); }} />}
    >
      <ButtonRow style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Set up:</span>
        <Btn ghost onClick={() => setup([...fill, { g: 1, op: "send" }])} disabled={cap === null}>full buffer, G2 waits to send</Btn>
        <Btn ghost onClick={() => setup([{ g: 2, op: "recv" }, { g: 3, op: "recv" }])} disabled={cap === null}>G3 and G4 wait to receive</Btn>
      </ButtonRow>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 8 }}>
        <Panel title={cap === null ? "var ch chan int  // nil: no hchan at all" : `hchan  (one lock guards every field)`}>
          {cap === null ? (
            <div className="muted" style={{ fontSize: 12.5 }}>A nil channel has no buffer and no queues. Send and receive park forever; close panics.</div>
          ) : (
            <>
              <FIELD name="qcount" value={c.qcount} />
              <FIELD name="dataqsiz" value={c.dataqsiz!} />
              <FIELD name="sendx / recvx" value={`${c.sendx} / ${c.recvx}`} />
              <FIELD name="closed" value={c.closed ? 1 : 0} />
              <div style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}>
                {cap === 0 && <span className="muted" style={{ fontSize: 12 }}>buf: none (unbuffered)</span>}
                {c.buf.map((v, i) => (
                  <div key={i} style={{ textAlign: "center", minWidth: 34 }}>
                    <Chip color="var(--c1)" filled={v !== null} faint={v === null}>{v ?? "·"}</Chip>
                    <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--muted)", lineHeight: 1.3, minHeight: 26 }}>
                      {i === c.recvx && <div>recvx</div>}
                      {i === c.sendx && <div>sendx</div>}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 12, marginTop: 4, display: "grid", gap: 4 }}>
                <div><span className="muted">sendq: </span>{c.sendq.length ? c.sendq.map((s) => <Chip key={s.g} color={threadColor(s.g)}>{`G${s.g + 1} elem=${s.elem}`}</Chip>) : <span className="muted">empty</span>}</div>
                <div><span className="muted">recvq: </span>{c.recvq.length ? c.recvq.map((s) => <Chip key={s.g} color={threadColor(s.g)}>{`G${s.g + 1}`}</Chip>) : <span className="muted">empty</span>}</div>
              </div>
            </>
          )}
        </Panel>
        <Panel title="Goroutines">
          <div style={{ display: "grid", gap: 6 }}>
            {c.status.map((st, g) => (
              <div key={g} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                <Chip color={threadColor(g)} filled>{`G${g + 1}`}</Chip>
                <button className="btn" style={{ padding: "1px 8px", fontSize: 12, fontFamily: MONO, fontVariantLigatures: "none" }} disabled={!c.canAct(g)} onClick={() => push({ g, op: "send" })}>{`ch <- ${c.nextValue}`}</button>
                <button className="btn" style={{ padding: "1px 8px", fontSize: 12, fontFamily: MONO, fontVariantLigatures: "none" }} disabled={!c.canAct(g)} onClick={() => push({ g, op: "recv" })}>{"<-ch"}</button>
                <button className="btn" style={{ padding: "1px 8px", fontSize: 12, fontFamily: MONO, fontVariantLigatures: "none" }} disabled={!c.canAct(g)} onClick={() => push({ g, op: "close" })}>close</button>
                <span style={{ fontSize: 11.5, color: STATUS[st].color }}>{STATUS[st].text}</span>
                {c.last[g] && <span className="muted" style={{ fontSize: 11.5, fontFamily: MONO }}>{c.last[g]}</span>}
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Banner tone={!step ? "plain" : step.path.includes("panic") || step.path === "nil-block" ? "bad" : step.path.startsWith("park") ? "warn" : "good"} label={step ? `G${step.g + 1} ${step.op === "send" ? `ch <- ${step.value}` : step.op === "recv" ? "<-ch" : "close(ch)"}` : undefined} min={62}>
        {step ? PATH_TEXT[step.path] : "Click an operation for any goroutine. Values to send count up: 1, 2, 3, and so on."}
        {step && step.woke.length > 0 && ` goready: ${step.woke.map((g) => `G${g + 1}`).join(", ")}.`}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- select fairness

const FAIR = {
  mode: seg("Consumer", [["random", "select on both (Go)"], ["priority", "priority idiom"]], "random"),
  hi: range({ label: "Load on high", min: 10, max: 150, step: 10, default: 90, format: (v) => `${v}%` }),
  lo: range({ label: "Load on low", min: 10, max: 60, step: 10, default: 30, format: (v) => `${v}%` }),
};
const HI_SWEEP = [10, 30, 50, 70, 90, 110, 130, 150];
const ms = (ns: number) => `${fixed(ns / 1e6, 1)} ms`;

export function ConcMsgSelectDemo() {
  const P = useParams("conc-msg-select", FAIR);
  const { mode, hi, lo } = P.values;
  const cur = useMemo(() => runSelectFairness({ mode, hiLoad: hi / 100, loLoad: lo / 100 }), [mode, hi, lo]);
  const jobs = useMemo(() => (["random", "priority"] as const).flatMap((m) => HI_SWEEP.map((h) => () => runSelectFairness({ mode: m, hiLoad: h / 100, loLoad: lo / 100 }))), [lo]);
  const sweep = useChunked<FairResult>(`${lo}`, jobs, { keep: true });
  const line = (k: number) => HI_SWEEP.flatMap((h, i) => { const r = sweep[k * HI_SWEEP.length + i]; return r ? [[h, r.loMaxWaitNs / 1e6] as [number, number]] : []; });
  const busy = Math.min(100, ((cur.hiServed + cur.loServed) * 10_000) / 20_000_000 * 100);
  return (
    <Demo
      title="One consumer, two channels"
      controls={<>
        <Param spec={FAIR.mode} value={mode} onChange={(v) => P.set("mode", v as never)} />
        <Param spec={FAIR.hi} value={hi} onChange={(v) => P.set("hi", v as number)} />
        <Param spec={FAIR.lo} value={lo} onChange={(v) => P.set("lo", v as number)} />
      </>}
    >
      <div style={{ fontFamily: MONO, fontSize: 12, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", whiteSpace: "pre", overflowX: "auto" }}>
        {mode === "random"
          ? "select {\ncase v := <-high: serve(v)\ncase v := <-low:  serve(v)\n}"
          : "select {\ncase v := <-high: serve(v)\ndefault:\n    select {\n    case v := <-high: serve(v)\n    case v := <-low:  serve(v)\n    }\n}"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0 16px", marginTop: 10 }}>
        <Meter label="high: served of made" value={cur.hiServed} max={Math.max(1, cur.hiMade)} color="var(--c1)" text={`${int(cur.hiServed)} of ${int(cur.hiMade)}`} />
        <Meter label="low: served of made" value={cur.loServed} max={Math.max(1, cur.loMade)} color="var(--c2)" text={`${int(cur.loServed)} of ${int(cur.loMade)}`} />
      </div>
      <Stats items={[
        { label: "oldest wait, high", value: ms(cur.hiMaxWaitNs) },
        { label: "oldest wait, low", value: ms(cur.loMaxWaitNs) },
        { label: "consumer busy", value: `${Math.round(busy)}%` },
      ]} />
      <Plot x={[0, 160]} y={[0, 21]} height={190} xLabel="load on high (%)" yLabel="oldest wait of a low item (ms)" xTicks={[0, 50, 100, 150]}>
        <RuleX at={hi} />
        <Line points={line(0)} color="var(--c1)" />
        <Line points={line(1)} color="var(--c4)" />
        <Dots points={[[hi, cur.loMaxWaitNs / 1e6]]} color={mode === "random" ? "var(--c1)" : "var(--c4)"} r={4} />
      </Plot>
      <Legend items={[{ label: "select on both (Go)", color: "var(--c1)" }, { label: "priority idiom", color: "var(--c4)" }]} />
      <Note>
        A 20 ms run. The consumer needs 10 µs per item, so 100% load is 100 items per ms. Both producers are open loop: items
        arrive on a random schedule into unbounded buffers. Goroutine wake-up ({int(GO_COSTS.wakeNs)} ns) and switch ({int(GO_COSTS.switchNs)} ns) are model inputs.
      </Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- goroutine leaks

const LEAK = {
  mode: seg<LeakMode>("Result channel", [["unbuffered", "unbuffered"], ["buffered", "buffer of 1"], ["context", "select on ctx.Done()"]], "unbuffered"),
  timeout: range({ label: "Timeout", min: 50, max: 320, step: 10, default: 150, format: (v) => `${v} µs` }),
};

const CODE: Record<LeakMode, string> = {
  unbuffered: "ch := make(chan Result)\ngo func() { ch <- backend() }()",
  buffered: "ch := make(chan Result, 1)\ngo func() { ch <- backend() }()",
  context: "ch := make(chan Result)\ngo func() {\n    r := backend()\n    select {\n    case ch <- r:\n    case <-ctx.Done():\n    }\n}()\ndefer cancel()",
};

export function ConcMsgLeakDemo() {
  const P = useParams("conc-msg-leak", LEAK);
  const { mode, timeout } = P.values;
  const r = useMemo(() => runLeak({ mode, timeoutNs: timeout * 1_000 }), [mode, timeout]);
  const timeouts = r.outcomes.filter((o) => o === "timeout").length;
  return (
    <Demo
      title="A timeout that leaks goroutines"
      controls={<>
        <Param spec={LEAK.timeout} value={timeout} onChange={(v) => P.set("timeout", v as number)} />
        <Param spec={LEAK.mode} value={mode} onChange={(v) => P.set("mode", v as never)} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 8 }}>
        <div style={{ fontFamily: MONO, fontSize: 12, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", whiteSpace: "pre", overflowX: "auto" }}>
          {`${CODE[mode]}\nselect {\ncase r := <-ch:            reply(r)\ncase <-time.After(${timeout}µs): reply504()\n}`}
        </div>
        <div style={{ fontSize: 12.5 }}>
          <SectionLabel style={{ marginTop: 0 }}>Backend latency per request</SectionLabel>
          {r.latencies.map((l, i) => (
            <div key={i} style={{ fontFamily: MONO, fontSize: 12, color: r.outcomes[i] === "timeout" ? "var(--c4)" : "var(--fg)" }}>
              {`req ${i}: ${int(l / 1_000)} µs → ${r.outcomes[i] === "timeout" ? "timeout" : "ok"}`}
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <ThreadTimeline result={r.result} by="thread" />
      </div>
      <Banner ok={r.leaked.length === 0}>
        {r.leaked.length
          ? `${r.leaked.length} goroutine${r.leaked.length > 1 ? "s" : ""} (${r.leaked.join(", ")}) block on a send that no receiver will ever take. They and everything they reference stay in memory until the process exits.`
          : timeouts
            ? `${timeouts} request${timeouts > 1 ? "s" : ""} timed out, and no goroutine leaked: every worker finished.`
            : "No request timed out, so no worker was abandoned."}
      </Banner>
      <Stats items={[
        { label: "timeouts", value: `${timeouts} of ${r.outcomes.length}` },
        { label: "goroutines leaked", value: r.leaked.length },
      ]} />
      <Note>
        The "timers" row stands in for the runtime's timers: it sleeps until each deadline and then fills that request's
        timer channel. A red mark shows a goroutine that is still blocked when everything else has finished.
      </Note>
    </Demo>
  );
}
