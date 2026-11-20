/** Demos for "Backpressure": full-queue policies under overload, backpressure across a pipeline, and credits. */
import { useMemo } from "react";
import {
  Chip, Demo, Dots, Legend, Line, Note, Param, Plot, RuleX, SmallLabel, Stats, fixed, int, pct, range, seg, toggle, useChunked, useParams,
} from "../../kit";
import {
  CREDIT_DEFAULTS, OVERLOAD_DEFAULTS, PIPELINE_DEFAULTS, creditBound, inFlightBound, runCredits, runOverload, runPipeline, windowNeeded, type CreditResult, type Policy,
} from "../../sims/conc/message-passing";
import { ThreadTimeline } from "./ConcViews";

const msOf = (ns: number) => `${fixed(ns / 1e6, 1)} ms`;
const usOf = (ns: number) => `${int(ns / 1_000)} µs`;

// ---------------------------------------------------------------- overload

const OV = {
  load: range({ label: "Arrival rate / service rate", min: 50, max: 200, step: 10, default: 120, format: (v) => `${v}%` }),
  policy: seg<Policy>("When the queue is full", [["unbounded", "never full"], ["block", "block the source"], ["drop-newest", "drop newest"], ["drop-oldest", "drop oldest"]], "unbounded"),
  capacity: range({ label: "Capacity", min: 10, max: 200, step: 10, default: OVERLOAD_DEFAULTS.capacity, format: (v) => `${v} items` }),
};

export function ConcMsgOverloadDemo() {
  const P = useParams("conc-msg-overload", OV);
  const { load, policy, capacity } = P.values;
  const r = useMemo(() => runOverload({ load: load / 100, policy, capacity }), [load, policy, capacity]);
  const q = r.samples.map(([t, n]) => [t / 1e6, n] as [number, number]);
  const src = r.samples.map(([t, , s]) => [t / 1e6, s] as [number, number]);
  const maxQ = Math.max(10, ...r.samples.map((s) => Math.max(s[1], s[2])));
  const every = Math.max(1, Math.floor(r.latency.length / 400));
  const lat = r.latency.filter((_, i) => i % every === 0).map(([t, l]) => [t / 1e6, l / 1e6] as [number, number]);
  const maxL = Math.max(1, ...r.latency.map((p) => p[1] / 1e6));
  const T = OVERLOAD_DEFAULTS.durationNs / 1e6;
  return (
    <Demo
      title="A queue that receives more than it can serve"
      controls={<>
        <Param spec={OV.load} value={load} onChange={(v) => P.set("load", v as number)} />
        <Param spec={OV.policy} value={policy} onChange={(v) => P.set("policy", v as never)} />
        <Param spec={OV.capacity} value={capacity} onChange={(v) => P.set("capacity", v as number)} />
      </>}
    >
      <Plot x={[0, T]} y={[0, maxQ * 1.08]} height={170} xLabel="time (ms)" yLabel="items waiting">
        <Line points={q} color="var(--c1)" />
        {policy === "block" && <Line points={src} color="var(--c4)" dash="5 3" />}
      </Plot>
      <Legend items={[{ label: "in the queue", color: "var(--c1)" }, ...(policy === "block" ? [{ label: "arrived, but the source cannot hand them over", color: "var(--c4)" }] : [])]} />
      <SmallLabel style={{ marginTop: 8 }}>Latency of each delivered item, from its arrival to the end of its service</SmallLabel>
      <Plot x={[0, T]} y={[0, maxL * 1.08]} height={150} xLabel="time (ms)" yLabel="ms">
        <Dots points={lat} color="var(--c2)" r={1.6} />
      </Plot>
      <Stats items={[
        { label: "arrived", value: int(r.arrived) },
        { label: "served", value: int(r.delivered) },
        { label: "dropped", value: `${int(r.dropped)} (${pct(r.dropped / Math.max(1, r.arrived), 0)})` },
        { label: "most items queued", value: int(r.maxQueue) },
        { label: "latency p50 / p99", value: `${msOf(r.p50)} / ${msOf(r.p99)}` },
      ]} />
      <Note>
        One consumer needs {usOf(OVERLOAD_DEFAULTS.serviceNs)} per item, so it serves 10 items per ms. Arrivals are random (Poisson) and do not slow down when
        the queue is long: an open-loop source. A {int(T)} ms run.
      </Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- pipeline

const PIPE = {
  capacity: range({ label: "Capacity of each channel", min: 0, max: 8, step: 1, default: PIPELINE_DEFAULTS.capacity }),
  slow: seg("Slow stage (40 µs; others 10 µs)", [["0", "stage 1"], ["1", "stage 2"], ["2", "stage 3"]], "2"),
  unbounded: toggle({ label: "Unbounded channels", default: false }),
};

export function ConcMsgPipelineDemo() {
  const P = useParams("conc-msg-pipe", PIPE);
  const { capacity, slow, unbounded } = P.values;
  const stageNs = [0, 1, 2].map((k) => (String(k) === slow ? 40_000 : 10_000));
  const r = useMemo(() => runPipeline({ capacity, unbounded, stageNs }), [capacity, slow, unbounded]); // eslint-disable-line react-hooks/exhaustive-deps
  const bound = inFlightBound(3, capacity);
  return (
    <Demo
      title="Backpressure through three stages"
      controls={<>
        <Param spec={PIPE.capacity} value={capacity} onChange={(v) => P.set("capacity", v as number)} />
        <Param spec={PIPE.slow} value={slow} onChange={(v) => P.set("slow", v as never)} />
        <Param spec={PIPE.unbounded} value={unbounded} onChange={(v) => P.set("unbounded", v as boolean)} />
      </>}
    >
      <ThreadTimeline result={r.result} by="thread" labels={false} />
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>most items in each channel:</span>
        {r.maxLens.map((n, k) => <Chip key={k} color={k === Number(slow) ? "var(--c4)" : "var(--c1)"}>{`c${k} → stage ${k + 1}: ${n}`}</Chip>)}
      </div>
      <Stats items={[
        { label: "most items in flight", value: unbounded ? int(r.maxInFlight) : `${int(r.maxInFlight)} (bound ${bound})` },
        { label: "mean / max latency", value: `${usOf(r.meanLatency)} / ${usOf(r.maxLatency)}` },
        { label: "30 items take", value: usOf(r.makespan) },
      ]} />
      <Note>
        The source makes an item in 5 µs and sends it with a blocking send. Each stage runs on its own core. A thin grey line is a
        stage blocked on a channel: before the slow stage they block on send, after it they block on receive.
      </Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- credits

const CR = {
  window: range({ label: "Credits outstanding (window)", min: 1, max: 16, step: 1, default: CREDIT_DEFAULTS.window }),
  delay: range({ label: "One-way link delay", min: 10, max: 100, step: 10, default: CREDIT_DEFAULTS.delayNs / 1_000, format: (v) => `${v} µs` }),
};
const WINDOWS = Array.from({ length: 16 }, (_, i) => i + 1);

export function ConcMsgCreditDemo() {
  const P = useParams("conc-msg-credit", CR);
  const { window, delay } = P.values;
  const cfg = { ...CREDIT_DEFAULTS, delayNs: delay * 1_000 };
  const r = useMemo(() => runCredits({ ...cfg, window }), [window, delay]); // eslint-disable-line react-hooks/exhaustive-deps
  const jobs = useMemo(() => WINDOWS.map((w) => () => runCredits({ ...cfg, window: w, record: false })), [delay]); // eslint-disable-line react-hooks/exhaustive-deps
  const sweep = useChunked<CreditResult>(`${delay}`, jobs, { keep: true });
  const sim = WINDOWS.flatMap((w, i) => (sweep[i] ? [[w, sweep[i]!.steadyPerMs] as [number, number]] : []));
  const model = WINDOWS.map((w) => [w, creditBound({ ...cfg, window: w })] as [number, number]);
  const need = windowNeeded(cfg);
  return (
    <Demo
      title="Credits: request(n) over a slow link"
      controls={<>
        <Param spec={CR.window} value={window} onChange={(v) => P.set("window", v as number)} />
        <Param spec={CR.delay} value={delay} onChange={(v) => P.set("delay", v as number)} />
      </>}
    >
      <ThreadTimeline result={r.result} by="thread" labels={false} />
      <Stats items={[
        { label: "throughput (steady)", value: `${fixed(r.steadyPerMs, 1)} per ms` },
        { label: "subscriber busy", value: pct(r.steadyPerMs / (1e6 / CREDIT_DEFAULTS.serviceNs), 0) },
        { label: "most items waiting at the subscriber", value: `${r.maxBuffered} (≤ window)` },
        { label: "window that fills the pipe", value: fixed(need, 1) },
      ]} />
      <Plot x={[0, 17]} y={[0, 125]} height={180} xLabel="window (credits)" yLabel="items per ms" xTicks={[1, 4, 8, 12, 16]}>
        <RuleX at={need} label="rate × RTT" />
        <Line points={model} color="var(--faint)" dash="4 3" />
        <Line points={sim} color="var(--c1)" />
        <Dots points={[[window, r.steadyPerMs]]} color="var(--c1)" r={4} />
      </Plot>
      <Legend items={[{ label: "simulated", color: "var(--c1)" }, { label: "min(1/service, window/RTT)", color: "var(--faint)" }]} />
      <Note>
        The subscriber needs {usOf(CREDIT_DEFAULTS.serviceNs)} per item and asks for one more item each time it finishes one. The publisher needs{" "}
        {usOf(CREDIT_DEFAULTS.publishNs)} per item. The two wire rows deliver each message one link delay after it was sent. Thread costs are off in this model.
      </Note>
    </Demo>
  );
}
